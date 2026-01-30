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
  INSUFFICIENT_BALANCE: { code: 'E012', message: 'Insufficient balance for required stake', status: 402 },
  MILESTONE_NOT_FOUND: { code: 'E013', message: 'Milestone not found', status: 404 },
  MILESTONE_NOT_ACTIVE: { code: 'E014', message: 'Milestone is not active', status: 409 },
  MAX_ATTEMPTS_REACHED: { code: 'E015', message: 'Max attempts reached for this milestone', status: 403 },
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

async function lockStake(base44, worker, task) {
  const stakeRequired = task.required_stake_usd || 0;
  if (stakeRequired <= 0) return { success: true };

  const availableBalance = worker.available_balance_usd || 0;
  if (availableBalance < stakeRequired) {
    return { error: 'INSUFFICIENT_BALANCE', details: `Requires ${stakeRequired} USD stake, available: ${availableBalance} USD` };
  }

  // Lock funds atomically
  await base44.asServiceRole.entities.Worker.update(worker.id, {
    available_balance_usd: availableBalance - stakeRequired,
    locked_balance_usd: (worker.locked_balance_usd || 0) + stakeRequired
  });

  // Log transaction
  await base44.asServiceRole.entities.Transaction.create({
    transaction_type: 'lock',
    worker_id: worker.id,
    task_id: task.id,
    amount_usd: stakeRequired,
    balance_type: 'locked',
    notes: `Stake locked for task: ${task.title}`
  });

  await logEvent(base44, 'funds_locked', 'transaction', task.id, 'system', 'system', {
    worker_id: worker.id,
    task_id: task.id,
    amount_usd: stakeRequired
  });

  return { success: true };
}

async function unlockStake(base44, worker, task) {
  const stakeAmount = task.required_stake_usd || 0;
  if (stakeAmount <= 0) return;

  await base44.asServiceRole.entities.Worker.update(worker.id, {
    available_balance_usd: (worker.available_balance_usd || 0) + stakeAmount,
    locked_balance_usd: Math.max(0, (worker.locked_balance_usd || 0) - stakeAmount)
  });

  await base44.asServiceRole.entities.Transaction.create({
    transaction_type: 'unlock',
    worker_id: worker.id,
    task_id: task.id,
    amount_usd: stakeAmount,
    balance_type: 'available',
    notes: `Stake unlocked for task: ${task.title}`
  });

  await logEvent(base44, 'funds_unlocked', 'transaction', task.id, 'system', 'system', {
    worker_id: worker.id,
    task_id: task.id,
    amount_usd: stakeAmount
  });
}

async function slashStake(base44, worker, task) {
  const stakeAmount = task.required_stake_usd || 0;
  if (stakeAmount <= 0) return;

  const slashPercentage = task.slash_percentage || 100;
  const slashAmount = (stakeAmount * slashPercentage) / 100;
  const returnAmount = stakeAmount - slashAmount;

  // Slash locked funds
  await base44.asServiceRole.entities.Worker.update(worker.id, {
    locked_balance_usd: Math.max(0, (worker.locked_balance_usd || 0) - stakeAmount),
    available_balance_usd: (worker.available_balance_usd || 0) + returnAmount,
    total_slashed_usd: (worker.total_slashed_usd || 0) + slashAmount
  });

  if (slashAmount > 0) {
    await base44.asServiceRole.entities.Transaction.create({
      transaction_type: 'slash',
      worker_id: worker.id,
      task_id: task.id,
      amount_usd: slashAmount,
      balance_type: 'locked',
      notes: `Stake slashed (${slashPercentage}%) for task: ${task.title}`
    });

    await logEvent(base44, 'funds_slashed', 'transaction', task.id, 'system', 'system', {
      worker_id: worker.id,
      task_id: task.id,
      amount_usd: slashAmount,
      percentage: slashPercentage
    });
  }

  if (returnAmount > 0) {
    await base44.asServiceRole.entities.Transaction.create({
      transaction_type: 'unlock',
      worker_id: worker.id,
      task_id: task.id,
      amount_usd: returnAmount,
      balance_type: 'available',
      notes: `Partial stake return (${100 - slashPercentage}%) for task: ${task.title}`
    });
  }
}

async function transferPayment(base44, payerId, workerId, task) {
  const taskPrice = task.task_price_usd || 0;
  if (taskPrice <= 0) return;

  const feePercentage = task.protocol_fee_percentage || 5;
  const feeAmount = (taskPrice * feePercentage) / 100;
  const workerAmount = taskPrice - feeAmount;

  // Get payer
  const payers = await base44.asServiceRole.entities.Worker.filter({ id: payerId });
  if (!payers || payers.length === 0) return;
  const payer = payers[0];

  // Deduct from payer's available balance
  await base44.asServiceRole.entities.Worker.update(payerId, {
    available_balance_usd: Math.max(0, (payer.available_balance_usd || 0) - taskPrice)
  });

  // Credit worker
  const workers = await base44.asServiceRole.entities.Worker.filter({ id: workerId });
  if (workers && workers.length > 0) {
    const worker = workers[0];
    await base44.asServiceRole.entities.Worker.update(workerId, {
      available_balance_usd: (worker.available_balance_usd || 0) + workerAmount,
      total_earned_usd: (worker.total_earned_usd || 0) + workerAmount
    });
  }

  // Log transfer
  await base44.asServiceRole.entities.Transaction.create({
    transaction_type: 'transfer',
    worker_id: workerId,
    task_id: task.id,
    from_worker_id: payerId,
    to_worker_id: workerId,
    amount_usd: workerAmount,
    balance_type: 'available',
    notes: `Payment for task: ${task.title}`
  });

  // Log fee
  if (feeAmount > 0) {
    await base44.asServiceRole.entities.Transaction.create({
      transaction_type: 'fee',
      worker_id: payerId,
      task_id: task.id,
      amount_usd: feeAmount,
      balance_type: 'available',
      notes: `Protocol fee (${feePercentage}%) for task: ${task.title}`
    });

    await logEvent(base44, 'fee_collected', 'transaction', task.id, 'system', 'system', {
      task_id: task.id,
      amount_usd: feeAmount,
      percentage: feePercentage
    });
  }

  await logEvent(base44, 'funds_transferred', 'transaction', task.id, 'system', 'system', {
    from_worker_id: payerId,
    to_worker_id: workerId,
    task_id: task.id,
    amount_usd: workerAmount
  });
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
      
      // Lock stake if required
      const stakeLock = await lockStake(base44, worker, task);
      if (stakeLock.error) {
        return errorResponse(stakeLock.error, stakeLock.details);
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
      
      // Unlock stake
      await unlockStake(base44, worker, task);
      
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
          // Slash stake on expiration
          await slashStake(base44, worker, task);
          
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
    
    // Get active milestone for a claimed task
    if (action === 'get_active_milestone') {
      if (!body.task_id) return errorResponse('INVALID_PAYLOAD', 'task_id required');
      
      const tasks = await base44.asServiceRole.entities.Task.filter({ id: body.task_id });
      if (!tasks || tasks.length === 0) return errorResponse('TASK_NOT_FOUND');
      
      const task = tasks[0];
      if (task.claimed_by !== worker.id) return errorResponse('TASK_NOT_CLAIMED');
      
      // Find active milestone
      const milestones = await base44.asServiceRole.entities.Milestone.filter({
        task_id: task.id,
        status: 'active'
      });
      
      if (!milestones || milestones.length === 0) {
        return successResponse({ active_milestone: null, message: 'No active milestone' });
      }
      
      const milestone = milestones[0];
      
      // Check attempts
      const workerAttempts = milestone.worker_attempts ? JSON.parse(milestone.worker_attempts) : {};
      const currentAttempts = workerAttempts[worker.id] || 0;
      
      return successResponse({
        milestone_id: milestone.id,
        order_index: milestone.order_index,
        title: milestone.title,
        description: milestone.description,
        expected_duration_seconds: milestone.expected_duration_seconds,
        activated_at: milestone.activated_at,
        attempts_used: currentAttempts,
        max_attempts: milestone.max_attempts_per_worker
      });
    }
    
    // Submit milestone result
    if (action === 'submit_milestone_result') {
      if (!body.milestone_id) return errorResponse('INVALID_PAYLOAD', 'milestone_id required');
      if (!body.output_data) return errorResponse('INVALID_PAYLOAD', 'output_data required');
      
      const milestones = await base44.asServiceRole.entities.Milestone.filter({ id: body.milestone_id });
      if (!milestones || milestones.length === 0) return errorResponse('MILESTONE_NOT_FOUND');
      
      const milestone = milestones[0];
      
      // Verify task ownership
      const tasks = await base44.asServiceRole.entities.Task.filter({ id: milestone.task_id });
      if (!tasks || tasks.length === 0) return errorResponse('TASK_NOT_FOUND');
      
      const task = tasks[0];
      if (task.claimed_by !== worker.id) return errorResponse('TASK_NOT_CLAIMED');
      
      // Check milestone is active
      if (milestone.status !== 'active') return errorResponse('MILESTONE_NOT_ACTIVE');
      
      // Check attempts
      const workerAttempts = milestone.worker_attempts ? JSON.parse(milestone.worker_attempts) : {};
      const currentAttempts = workerAttempts[worker.id] || 0;
      
      if (currentAttempts >= milestone.max_attempts_per_worker) {
        return errorResponse('MAX_ATTEMPTS_REACHED');
      }
      
      // Create submission record
      const submission = await base44.asServiceRole.entities.Submission.create({
        task_id: task.id,
        milestone_id: milestone.id,
        worker_id: worker.id,
        worker_name: worker.name,
        task_title: task.title,
        output_data: typeof body.output_data === 'string' ? body.output_data : JSON.stringify(body.output_data),
        status: 'pending',
        validation_status: 'pending',
        processing_time_ms: milestone.activated_at ? Date.now() - new Date(milestone.activated_at).getTime() : 0
      });
      
      // Update milestone
      workerAttempts[worker.id] = currentAttempts + 1;
      await base44.asServiceRole.entities.Milestone.update(milestone.id, {
        status: 'submitted',
        output_data: typeof body.output_data === 'string' ? body.output_data : JSON.stringify(body.output_data),
        submitted_at: new Date().toISOString(),
        worker_attempts: JSON.stringify(workerAttempts)
      });
      
      await logEvent(base44, 'milestone_submitted', 'milestone', milestone.id, 'worker', worker.id, {
        task_id: task.id,
        milestone_title: milestone.title,
        attempt: currentAttempts + 1,
        submission_id: submission.id
      });
      
      // Auto-validate if deterministic
      if (milestone.validation_mode === 'deterministic') {
        try {
          const validateResponse = await base44.functions.invoke('validateMilestone', {
            action: 'validate_submission',
            milestone_id: milestone.id,
            submission_id: submission.id
          });
          
          return successResponse({
            milestone_id: milestone.id,
            submission_id: submission.id,
            status: 'submitted',
            validation: validateResponse.data,
            message: validateResponse.data.validation_status === 'auto_pass' 
              ? 'Milestone auto-validated and accepted' 
              : 'Milestone auto-validated and rejected'
          });
        } catch (validationError) {
          // Continue if validation fails
        }
      }
      
      return successResponse({
        milestone_id: milestone.id,
        submission_id: submission.id,
        status: 'submitted',
        message: milestone.validation_mode === 'quorum' 
          ? 'Milestone submitted for quorum review' 
          : 'Milestone submitted for review'
      });
    }
    
    // Get task progress (with milestones)
    if (action === 'get_task_progress') {
      if (!body.task_id) return errorResponse('INVALID_PAYLOAD', 'task_id required');
      
      const tasks = await base44.asServiceRole.entities.Task.filter({ id: body.task_id });
      if (!tasks || tasks.length === 0) return errorResponse('TASK_NOT_FOUND');
      
      const task = tasks[0];
      
      // Get all milestones for this task
      const milestones = await base44.asServiceRole.entities.Milestone.filter({
        task_id: task.id
      });
      
      // Sort by order_index
      milestones.sort((a, b) => a.order_index - b.order_index);
      
      const progress = milestones.map(m => ({
        milestone_id: m.id,
        order_index: m.order_index,
        title: m.title,
        status: m.status,
        activated_at: m.activated_at,
        submitted_at: m.submitted_at,
        completed_at: m.completed_at
      }));
      
      const completedCount = milestones.filter(m => m.status === 'accepted').length;
      const totalCount = milestones.length;
      
      return successResponse({
        task_id: task.id,
        task_status: task.status,
        task_type: task.task_type,
        milestones: progress,
        progress_percentage: totalCount > 0 ? Math.round((completedCount / totalCount) * 100) : 0,
        completed_milestones: completedCount,
        total_milestones: totalCount
      });
    }
    
    return errorResponse('INVALID_PAYLOAD', 'Unknown action: ' + action);
    
  } catch (error) {
    console.error('API Error:', error);
    return errorResponse('INTERNAL_ERROR', error.message);
  }
});