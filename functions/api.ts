import { createClientFromRequest } from 'npm:@base44/sdk@0.8.6';

// API error codes - machine readable
const ERROR_CODES = {
  AUTH_MISSING: { code: 'E001', message: 'API key required', status: 401 },
  AUTH_INVALID: { code: 'E002', message: 'Invalid API key', status: 401 },
  WORKER_SUSPENDED: { code: 'E003', message: 'Worker suspended', status: 403 },
  TASK_NOT_FOUND: { code: 'E004', message: 'Task not found', status: 404 },
  TASK_NOT_OPEN: { code: 'E005', message: 'Task not available for claiming', status: 409 },
  TASK_NOT_CLAIMED: { code: 'E006', message: 'Task not claimed by this worker', status: 409 },
  TASK_ALREADY_CLAIMED: { code: 'E007', message: 'Task already claimed', status: 409 },
  CLAIM_EXPIRED: { code: 'E008', message: 'Claim has expired', status: 410 },
  INVALID_PAYLOAD: { code: 'E009', message: 'Invalid request payload', status: 400 },
  METHOD_NOT_ALLOWED: { code: 'E010', message: 'Method not allowed', status: 405 },
  RATE_LIMITED: { code: 'E011', message: 'Rate limit exceeded', status: 429 },
  INTERNAL_ERROR: { code: 'E999', message: 'Internal server error', status: 500 }
};

function errorResponse(errorKey, details = null) {
  const error = ERROR_CODES[errorKey] || ERROR_CODES.INTERNAL_ERROR;
  return Response.json({
    success: false,
    error: {
      code: error.code,
      message: error.message,
      details
    },
    timestamp: new Date().toISOString()
  }, { status: error.status });
}

function successResponse(data, meta = {}) {
  return Response.json({
    success: true,
    data,
    meta: {
      ...meta,
      timestamp: new Date().toISOString()
    }
  }, { status: 200 });
}

async function authenticateWorker(base44, apiKey) {
  if (!apiKey) return { error: 'AUTH_MISSING' };
  
  const workers = await base44.asServiceRole.entities.Worker.filter({ api_key: apiKey });
  if (!workers || workers.length === 0) return { error: 'AUTH_INVALID' };
  
  const worker = workers[0];
  if (worker.status === 'suspended' || worker.status === 'revoked') {
    return { error: 'WORKER_SUSPENDED' };
  }
  
  // Update last active
  await base44.asServiceRole.entities.Worker.update(worker.id, {
    last_active_at: new Date().toISOString()
  });
  
  return { worker };
}

async function logEvent(base44, eventType, entityType, entityId, actorType, actorId, details) {
  await base44.asServiceRole.entities.Event.create({
    event_type: eventType,
    entity_type: entityType,
    entity_id: entityId,
    actor_type: actorType,
    actor_id: actorId,
    details: JSON.stringify(details)
  });
}

function calculateReputation(completed, rejected, expired) {
  const total = completed + rejected + expired;
  if (total === 0) return 100;
  
  const successRate = completed / total;
  const penaltyRate = (rejected * 2 + expired) / total;
  
  return Math.max(0, Math.min(100, Math.round(successRate * 100 - penaltyRate * 20)));
}

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const url = new URL(req.url);
    const method = req.method;
    
    // Parse action from payload
    let body = {};
    if (method === 'POST') {
      try {
        body = await req.json();
      } catch {
        return errorResponse('INVALID_PAYLOAD', 'Invalid JSON body');
      }
    }
    
    const action = body.action;
    const apiKey = req.headers.get('X-API-Key') || body.api_key;
    
    // Public endpoint: list open tasks (no auth required for discovery)
    if (action === 'list_tasks') {
      const filters = { status: 'open' };
      if (body.type) filters.type = body.type;
      
      const tasks = await base44.asServiceRole.entities.Task.filter(filters, '-priority', body.limit || 50);
      
      // Filter out expired tasks
      const now = new Date();
      const activeTasks = tasks.filter(t => !t.deadline || new Date(t.deadline) > now);
      
      return successResponse(activeTasks.map(t => ({
        id: t.id,
        title: t.title,
        type: t.type,
        description: t.description,
        requirements: t.requirements,
        output_schema: t.output_schema,
        priority: t.priority,
        reward_credits: t.reward_credits,
        deadline: t.deadline,
        claim_timeout_minutes: t.claim_timeout_minutes,
        tags: t.tags,
        created_date: t.created_date
      })), { count: activeTasks.length });
    }
    
    // Get single task details
    if (action === 'get_task') {
      if (!body.task_id) return errorResponse('INVALID_PAYLOAD', 'task_id required');
      
      const tasks = await base44.asServiceRole.entities.Task.filter({ id: body.task_id });
      if (!tasks || tasks.length === 0) return errorResponse('TASK_NOT_FOUND');
      
      const task = tasks[0];
      return successResponse({
        id: task.id,
        title: task.title,
        type: task.type,
        description: task.description,
        requirements: task.requirements,
        input_data: task.input_data,
        output_schema: task.output_schema,
        status: task.status,
        priority: task.priority,
        reward_credits: task.reward_credits,
        deadline: task.deadline,
        claim_timeout_minutes: task.claim_timeout_minutes,
        tags: task.tags,
        created_date: task.created_date
      });
    }
    
    // All other actions require authentication
    const auth = await authenticateWorker(base44, apiKey);
    if (auth.error) return errorResponse(auth.error);
    const worker = auth.worker;
    
    // Claim a task
    if (action === 'claim_task') {
      if (!body.task_id) return errorResponse('INVALID_PAYLOAD', 'task_id required');
      
      const tasks = await base44.asServiceRole.entities.Task.filter({ id: body.task_id });
      if (!tasks || tasks.length === 0) return errorResponse('TASK_NOT_FOUND');
      
      const task = tasks[0];
      
      // Check task is open
      if (task.status !== 'open') return errorResponse('TASK_NOT_OPEN');
      
      // Check deadline hasn't passed
      if (task.deadline && new Date(task.deadline) < new Date()) {
        await base44.asServiceRole.entities.Task.update(task.id, { status: 'expired' });
        await logEvent(base44, 'task_expired', 'task', task.id, 'system', 'system', {});
        return errorResponse('TASK_NOT_OPEN', 'Task deadline has passed');
      }
      
      // Claim the task
      const claimedAt = new Date().toISOString();
      await base44.asServiceRole.entities.Task.update(task.id, {
        status: 'claimed',
        claimed_by: worker.id,
        claimed_at: claimedAt
      });
      
      await logEvent(base44, 'task_claimed', 'task', task.id, 'worker', worker.id, { worker_name: worker.name });
      
      const claimExpiresAt = new Date(Date.now() + (task.claim_timeout_minutes || 30) * 60 * 1000);
      
      return successResponse({
        task_id: task.id,
        title: task.title,
        input_data: task.input_data,
        requirements: task.requirements,
        output_schema: task.output_schema,
        claimed_at: claimedAt,
        claim_expires_at: claimExpiresAt.toISOString()
      });
    }
    
    // Release a claim
    if (action === 'release_claim') {
      if (!body.task_id) return errorResponse('INVALID_PAYLOAD', 'task_id required');
      
      const tasks = await base44.asServiceRole.entities.Task.filter({ id: body.task_id });
      if (!tasks || tasks.length === 0) return errorResponse('TASK_NOT_FOUND');
      
      const task = tasks[0];
      
      if (task.claimed_by !== worker.id) return errorResponse('TASK_NOT_CLAIMED');
      
      await base44.asServiceRole.entities.Task.update(task.id, {
        status: 'open',
        claimed_by: null,
        claimed_at: null
      });
      
      await logEvent(base44, 'task_released', 'task', task.id, 'worker', worker.id, { worker_name: worker.name });
      
      return successResponse({ task_id: task.id, released: true });
    }
    
    // Submit result
    if (action === 'submit_result') {
      if (!body.task_id) return errorResponse('INVALID_PAYLOAD', 'task_id required');
      if (!body.output_data) return errorResponse('INVALID_PAYLOAD', 'output_data required');
      
      const tasks = await base44.asServiceRole.entities.Task.filter({ id: body.task_id });
      if (!tasks || tasks.length === 0) return errorResponse('TASK_NOT_FOUND');
      
      const task = tasks[0];
      
      if (task.claimed_by !== worker.id) return errorResponse('TASK_NOT_CLAIMED');
      
      // Check claim hasn't expired
      if (task.claimed_at) {
        const claimExpiry = new Date(new Date(task.claimed_at).getTime() + (task.claim_timeout_minutes || 30) * 60 * 1000);
        if (new Date() > claimExpiry) {
          await base44.asServiceRole.entities.Task.update(task.id, {
            status: 'open',
            claimed_by: null,
            claimed_at: null
          });
          await base44.asServiceRole.entities.Worker.update(worker.id, {
            tasks_expired: (worker.tasks_expired || 0) + 1,
            reputation_score: calculateReputation(worker.tasks_completed || 0, worker.tasks_rejected || 0, (worker.tasks_expired || 0) + 1)
          });
          await logEvent(base44, 'claim_expired', 'task', task.id, 'system', 'system', { worker_id: worker.id });
          return errorResponse('CLAIM_EXPIRED');
        }
      }
      
      // Calculate processing time
      const processingTime = task.claimed_at ? Date.now() - new Date(task.claimed_at).getTime() : 0;
      
      // Create submission
      const submission = await base44.asServiceRole.entities.Submission.create({
        task_id: task.id,
        worker_id: worker.id,
        worker_name: worker.name,
        task_title: task.title,
        output_type: body.output_type || 'json',
        output_data: typeof body.output_data === 'string' ? body.output_data : JSON.stringify(body.output_data),
        status: 'pending',
        processing_time_ms: processingTime
      });
      
      // Update task status
      await base44.asServiceRole.entities.Task.update(task.id, {
        status: 'completed',
        completed_at: new Date().toISOString()
      });
      
      await logEvent(base44, 'submission_created', 'submission', submission.id, 'worker', worker.id, { task_id: task.id });
      await logEvent(base44, 'task_completed', 'task', task.id, 'worker', worker.id, { submission_id: submission.id });
      
      return successResponse({
        submission_id: submission.id,
        task_id: task.id,
        status: 'pending_review',
        processing_time_ms: processingTime
      });
    }
    
    // Get worker status
    if (action === 'worker_status') {
      return successResponse({
        id: worker.id,
        name: worker.name,
        status: worker.status,
        reputation_score: worker.reputation_score,
        tasks_completed: worker.tasks_completed || 0,
        tasks_rejected: worker.tasks_rejected || 0,
        tasks_expired: worker.tasks_expired || 0,
        total_credits_earned: worker.total_credits_earned || 0,
        last_active_at: worker.last_active_at
      });
    }
    
    // Get worker's active claims
    if (action === 'my_claims') {
      const claims = await base44.asServiceRole.entities.Task.filter({
        claimed_by: worker.id,
        status: 'claimed'
      });
      
      return successResponse(claims.map(t => ({
        task_id: t.id,
        title: t.title,
        type: t.type,
        claimed_at: t.claimed_at,
        claim_expires_at: new Date(new Date(t.claimed_at).getTime() + (t.claim_timeout_minutes || 30) * 60 * 1000).toISOString(),
        deadline: t.deadline
      })), { count: claims.length });
    }
    
    // Get worker's submission history
    if (action === 'my_submissions') {
      const submissions = await base44.asServiceRole.entities.Submission.filter({
        worker_id: worker.id
      }, '-created_date', body.limit || 20);
      
      return successResponse(submissions.map(s => ({
        id: s.id,
        task_id: s.task_id,
        task_title: s.task_title,
        status: s.status,
        review_notes: s.review_notes,
        created_date: s.created_date,
        reviewed_at: s.reviewed_at
      })), { count: submissions.length });
    }
    
    return errorResponse('INVALID_PAYLOAD', 'Unknown action: ' + action);
    
  } catch (error) {
    console.error('API Error:', error);
    return errorResponse('INTERNAL_ERROR', error.message);
  }
});