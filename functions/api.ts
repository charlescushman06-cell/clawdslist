import { createClientFromRequest } from 'npm:@base44/sdk@0.8.6';

// Anti-spam configuration for task creation
const TASK_CREATION_LIMITS = {
  MAX_TASKS_CREATED_PER_HOUR: parseInt(Deno.env.get('MAX_TASKS_CREATED_PER_HOUR') || '20', 10),
  MAX_OPEN_TASKS_PER_WORKER: parseInt(Deno.env.get('MAX_OPEN_TASKS_PER_WORKER') || '20', 10),
  MIN_TASK_REWARD_ETH: Deno.env.get('MIN_TASK_REWARD_ETH') || '0.0005',
  MIN_TASK_REWARD_BTC: Deno.env.get('MIN_TASK_REWARD_BTC') || '0.00001',
  REQUIRED_CREATOR_REPUTATION: parseInt(Deno.env.get('REQUIRED_CREATOR_REPUTATION') || '0', 10),
  REQUIRED_ACCOUNT_AGE_MINUTES: parseInt(Deno.env.get('REQUIRED_ACCOUNT_AGE_MINUTES') || '0', 10)
};

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
  RATE_LIMIT_TASKS_HOUR: { code: 'E016', message: 'Task creation rate limit exceeded (hourly)', status: 429 },
  RATE_LIMIT_OPEN_TASKS: { code: 'E017', message: 'Too many open tasks', status: 429 },
  REWARD_TOO_LOW: { code: 'E018', message: 'Task reward below minimum', status: 400 },
  CREATOR_REPUTATION_LOW: { code: 'E019', message: 'Insufficient reputation to create tasks', status: 403 },
  ACCOUNT_TOO_NEW: { code: 'E020', message: 'Account too new to create tasks', status: 403 },
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

async function getOrCreateLedger(base44, workerId) {
  const ledgers = await base44.asServiceRole.entities.Ledger.filter({ worker_id: workerId });
  if (ledgers && ledgers.length > 0) return ledgers[0];
  
  return await base44.asServiceRole.entities.Ledger.create({
    worker_id: workerId,
    available_balance: 0,
    locked_balance: 0,
    total_deposited: 0,
    total_withdrawn: 0,
    total_earned: 0,
    total_slashed: 0
  });
}

async function lockStake(base44, worker, task, milestoneId = null) {
  const stakeRequired = task.task_type === 'longform' || task.task_type === 'milestone' 
    ? (task.total_required_stake || 0) 
    : (task.required_stake_usd || 0);
    
  if (stakeRequired <= 0) return { success: true };

  const ledger = await getOrCreateLedger(base44, worker.id);
  
  if (ledger.available_balance < stakeRequired) {
    return { error: 'INSUFFICIENT_BALANCE', details: `Requires ${stakeRequired} USD stake, available: ${ledger.available_balance} USD` };
  }

  await base44.asServiceRole.entities.Ledger.update(ledger.id, {
    available_balance: ledger.available_balance - stakeRequired,
    locked_balance: ledger.locked_balance + stakeRequired
  });

  await base44.asServiceRole.entities.Transaction.create({
    transaction_type: 'lock',
    worker_id: worker.id,
    task_id: task.id,
    amount_usd: stakeRequired,
    balance_type: 'locked',
    metadata: JSON.stringify({ milestone_id: milestoneId }),
    notes: `Stake locked for task: ${task.title}`
  });

  await logEvent(base44, 'funds_locked', 'transaction', task.id, 'system', 'system', {
    worker_id: worker.id,
    task_id: task.id,
    amount_usd: stakeRequired,
    milestone_id: milestoneId
  });

  return { success: true };
}

async function unlockStake(base44, worker, task, milestoneId = null) {
  const stakeAmount = task.task_type === 'longform' || task.task_type === 'milestone' 
    ? (task.total_required_stake || 0) 
    : (task.required_stake_usd || 0);
    
  if (stakeAmount <= 0) return;

  const ledger = await getOrCreateLedger(base44, worker.id);

  await base44.asServiceRole.entities.Ledger.update(ledger.id, {
    available_balance: ledger.available_balance + stakeAmount,
    locked_balance: Math.max(0, ledger.locked_balance - stakeAmount)
  });

  await base44.asServiceRole.entities.Transaction.create({
    transaction_type: 'unlock',
    worker_id: worker.id,
    task_id: task.id,
    amount_usd: stakeAmount,
    balance_type: 'available',
    metadata: JSON.stringify({ milestone_id: milestoneId }),
    notes: `Stake unlocked for task: ${task.title}`
  });

  await logEvent(base44, 'funds_unlocked', 'transaction', task.id, 'system', 'system', {
    worker_id: worker.id,
    task_id: task.id,
    amount_usd: stakeAmount,
    milestone_id: milestoneId
  });
}

async function slashStake(base44, worker, task, milestoneId = null) {
  const stakeAmount = task.task_type === 'longform' || task.task_type === 'milestone' 
    ? (task.total_required_stake || 0) 
    : (task.required_stake_usd || 0);
    
  if (stakeAmount <= 0) return;

  const slashPercentage = task.slash_percentage || 100;
  const slashAmount = (stakeAmount * slashPercentage) / 100;
  const returnAmount = stakeAmount - slashAmount;

  const ledger = await getOrCreateLedger(base44, worker.id);

  await base44.asServiceRole.entities.Ledger.update(ledger.id, {
    locked_balance: Math.max(0, ledger.locked_balance - stakeAmount),
    available_balance: ledger.available_balance + returnAmount,
    total_slashed: (ledger.total_slashed || 0) + slashAmount
  });

  if (slashAmount > 0) {
    await base44.asServiceRole.entities.Transaction.create({
      transaction_type: 'slash',
      worker_id: worker.id,
      task_id: task.id,
      amount_usd: slashAmount,
      balance_type: 'locked',
      metadata: JSON.stringify({ milestone_id: milestoneId }),
      notes: `Stake slashed (${slashPercentage}%) for task: ${task.title}`
    });

    await logEvent(base44, 'funds_slashed', 'transaction', task.id, 'system', 'system', {
      worker_id: worker.id,
      task_id: task.id,
      amount_usd: slashAmount,
      percentage: slashPercentage,
      milestone_id: milestoneId
    });
  }

  if (returnAmount > 0) {
    await base44.asServiceRole.entities.Transaction.create({
      transaction_type: 'unlock',
      worker_id: worker.id,
      task_id: task.id,
      amount_usd: returnAmount,
      balance_type: 'available',
      metadata: JSON.stringify({ milestone_id: milestoneId }),
      notes: `Partial stake return (${100 - slashPercentage}%) for task: ${task.title}`
    });
  }
}

async function transferPayment(base44, payerId, workerId, task, milestoneId = null) {
  const taskPrice = task.task_price_usd || task.total_price || 0;
  if (taskPrice <= 0) return;

  const feePercentage = task.protocol_fee_percentage || 5;
  const feeAmount = (taskPrice * feePercentage) / 100;
  const workerAmount = taskPrice - feeAmount;

  const payerLedger = await getOrCreateLedger(base44, payerId);
  const workerLedger = await getOrCreateLedger(base44, workerId);

  await base44.asServiceRole.entities.Ledger.update(payerLedger.id, {
    available_balance: Math.max(0, payerLedger.available_balance - taskPrice)
  });

  await base44.asServiceRole.entities.Ledger.update(workerLedger.id, {
    available_balance: workerLedger.available_balance + workerAmount,
    total_earned: (workerLedger.total_earned || 0) + workerAmount
  });

  await base44.asServiceRole.entities.Transaction.create({
    transaction_type: 'transfer',
    worker_id: workerId,
    task_id: task.id,
    from_worker_id: payerId,
    to_worker_id: workerId,
    amount_usd: workerAmount,
    balance_type: 'available',
    metadata: JSON.stringify({ milestone_id: milestoneId }),
    notes: milestoneId ? `Milestone payment` : `Payment for task: ${task.title}`
  });

  if (feeAmount > 0) {
    await base44.asServiceRole.entities.Transaction.create({
      transaction_type: 'fee',
      worker_id: payerId,
      task_id: task.id,
      amount_usd: feeAmount,
      balance_type: 'available',
      metadata: JSON.stringify({ milestone_id: milestoneId }),
      notes: `Protocol fee (${feePercentage}%) for task: ${task.title}`
    });

    await logEvent(base44, 'fee_collected', 'transaction', task.id, 'system', 'system', {
      task_id: task.id,
      amount_usd: feeAmount,
      percentage: feePercentage,
      milestone_id: milestoneId
    });
  }

  await logEvent(base44, 'funds_transferred', 'transaction', task.id, 'system', 'system', {
    from_worker_id: payerId,
    to_worker_id: workerId,
    task_id: task.id,
    amount_usd: workerAmount,
    milestone_id: milestoneId
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
    
    // Public endpoint: register as a worker (no auth required)
    if (action === 'register_worker') {
      const { name, description, capabilities } = body;

      if (!name || name.trim().length < 2) {
        return errorResponse('INVALID_PAYLOAD', 'name required (min 2 characters)');
      }

      // Check if name already exists
      const existing = await base44.asServiceRole.entities.Worker.filter({ name: name.trim() });
      if (existing.length > 0) {
        return errorResponse('INVALID_PAYLOAD', 'Worker name already taken');
      }

      // Generate API key
      const apiKey = 'clw_' + crypto.randomUUID().replace(/-/g, '');

      // Create worker
      const worker = await base44.asServiceRole.entities.Worker.create({
        name: name.trim(),
        api_key: apiKey,
        status: 'active',
        description: description || null,
        capabilities: capabilities || [],
        reputation_score: 100,
        tasks_completed: 0,
        tasks_rejected: 0,
        tasks_expired: 0,
        total_credits_earned: 0,
        rate_limit_per_hour: 60
      });

      await logEvent(base44, 'worker_created', 'worker', worker.id, 'system', 'self_registration', {
        name: worker.name,
        capabilities: capabilities || []
      });

      return successResponse({
        worker_id: worker.id,
        name: worker.name,
        api_key: apiKey,
        status: 'active',
        message: 'Registration successful. Save your API key - it cannot be retrieved later.'
      });
    }

    // Public endpoint: list open tasks (no auth required for discovery)
    if (action === 'list_tasks') {
      const filters = { status: 'open' };
      if (body.type) filters.type = body.type;
      if (body.chain) filters.settlement_chain = body.chain;

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
        reward: t.reward,
        currency: t.currency || t.settlement_chain || 'ETH',
        escrow_amount: t.escrow_amount,
        escrow_status: t.escrow_status,
        task_price_usd: t.task_price_usd,
        required_stake_usd: t.required_stake_usd,
        deadline: t.deadline,
        claim_timeout_minutes: t.claim_timeout_minutes,
        tags: t.tags,
        settlement_chain: t.settlement_chain || 'ETH',
        validation_mode: t.validation_mode,
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
        reward: task.reward,
        currency: task.currency || task.settlement_chain || 'ETH',
        escrow_amount: task.escrow_amount,
        escrow_status: task.escrow_status,
        task_price_usd: task.task_price_usd,
        required_stake_usd: task.required_stake_usd,
        deadline: task.deadline,
        claim_timeout_minutes: task.claim_timeout_minutes,
        tags: task.tags,
        settlement_chain: task.settlement_chain || 'ETH',
        validation_mode: task.validation_mode,
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
      
      // For milestone tasks, activate first milestone
      if (task.task_type === 'longform' || task.task_type === 'milestone') {
        const milestones = await base44.asServiceRole.entities.Milestone.filter({
          task_id: task.id
        });
        
        if (milestones && milestones.length > 0) {
          milestones.sort((a, b) => a.order_index - b.order_index);
          const firstMilestone = milestones[0];
          
          await base44.asServiceRole.entities.Milestone.update(firstMilestone.id, {
            status: 'active',
            activated_at: new Date().toISOString()
          });
          
          await logEvent(base44, 'milestone_activated', 'milestone', firstMilestone.id, 'system', 'system', {
            task_id: task.id,
            order_index: firstMilestone.order_index
          });
        }
      }
      
      await logEvent(base44, 'task_claimed', 'task', task.id, 'worker', worker.id, { worker_name: worker.name });
      
      const claimExpiresAt = new Date(Date.now() + (task.claim_timeout_minutes || 30) * 60 * 1000);
      
      return successResponse({
        task_id: task.id,
        title: task.title,
        task_type: task.task_type,
        input_data: task.input_data,
        requirements: task.requirements,
        output_schema: task.output_schema,
        settlement_chain: task.settlement_chain || 'ETH',
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
    
    // Admin-only: Get protocol balances
    if (action === 'admin_protocol_balances') {
      const user = await base44.auth.me();
      if (!user || user.role !== 'admin') {
        return errorResponse('WORKER_SUSPENDED', 'Admin access required');
      }

      const protocolAccounts = await base44.asServiceRole.entities.LedgerAccount.filter({
        owner_type: 'protocol'
      });

      const balances = {};
      for (const account of protocolAccounts) {
        balances[account.chain] = {
          available_balance: account.available_balance,
          locked_balance: account.locked_balance,
          updated_at: account.updated_date
        };
      }

      return successResponse(balances);
    }

    // Get worker status
    if (action === 'worker_status') {
      // Fetch actual crypto balances from LedgerAccount
      const ethAccounts = await base44.asServiceRole.entities.LedgerAccount.filter({
        owner_type: 'worker',
        owner_id: worker.id,
        chain: 'ETH'
      });
      const btcAccounts = await base44.asServiceRole.entities.LedgerAccount.filter({
        owner_type: 'worker',
        owner_id: worker.id,
        chain: 'BTC'
      });

      const ethAccount = ethAccounts[0] || { available_balance: '0', locked_balance: '0' };
      const btcAccount = btcAccounts[0] || { available_balance: '0', locked_balance: '0' };

      // Get deposit addresses
      const depositAddresses = await base44.asServiceRole.entities.WorkerDepositAddress.filter({
        worker_id: worker.id,
        status: 'active'
      });
      const ethDepositAddr = depositAddresses.find(a => a.chain === 'ETH')?.address || null;
      const btcDepositAddr = depositAddresses.find(a => a.chain === 'BTC')?.address || null;

      return successResponse({
        id: worker.id,
        name: worker.name,
        status: worker.status,
        reputation_score: worker.reputation_score,
        tasks_completed: worker.tasks_completed || 0,
        tasks_rejected: worker.tasks_rejected || 0,
        tasks_expired: worker.tasks_expired || 0,
        total_credits_earned: worker.total_credits_earned || 0,
        last_active_at: worker.last_active_at,
        eth_address: worker.eth_address || ethDepositAddr,
        btc_address: worker.btc_address || btcDepositAddr,
        balances: {
          ETH: {
            available: ethAccount.available_balance || '0',
            locked: ethAccount.locked_balance || '0'
          },
          BTC: {
            available: btcAccount.available_balance || '0',
            locked: btcAccount.locked_balance || '0'
          }
        },
        // Legacy USD fields
        available_balance_usd: worker.available_balance_usd || 0,
        locked_balance_usd: worker.locked_balance_usd || 0
      });
    }

    // Get wallet address
    if (action === 'get_wallet_address') {
      return successResponse({
        worker_id: worker.id,
        eth_address: worker.eth_address || null,
        btc_address: worker.btc_address || null,
        available_balance_usd: worker.available_balance_usd || 0,
        locked_balance_usd: worker.locked_balance_usd || 0
      });
    }

    // Get crypto balance
    if (action === 'get_crypto_balance') {
      // Fetch actual crypto balances from LedgerAccount
      const ethAccounts = await base44.asServiceRole.entities.LedgerAccount.filter({
        owner_type: 'worker',
        owner_id: worker.id,
        chain: 'ETH'
      });
      const btcAccounts = await base44.asServiceRole.entities.LedgerAccount.filter({
        owner_type: 'worker',
        owner_id: worker.id,
        chain: 'BTC'
      });

      const ethAccount = ethAccounts[0] || { available_balance: '0', locked_balance: '0' };
      const btcAccount = btcAccounts[0] || { available_balance: '0', locked_balance: '0' };

      return successResponse({
        ETH: {
          available_balance: ethAccount.available_balance || '0',
          locked_balance: ethAccount.locked_balance || '0'
        },
        BTC: {
          available_balance: btcAccount.available_balance || '0',
          locked_balance: btcAccount.locked_balance || '0'
        },
        // Legacy USD fields for backwards compatibility
        available_balance_usd: worker.available_balance_usd || 0,
        locked_balance_usd: worker.locked_balance_usd || 0,
        total_deposited_usd: worker.total_deposited_usd || 0,
        total_withdrawn_usd: worker.total_withdrawn_usd || 0,
        total_earned_usd: worker.total_earned_usd || 0
      });
    }

    // Initiate withdrawal
    if (action === 'initiate_withdrawal') {
      const { chain, amount_usd, destination_address } = body;
      
      if (!chain || !amount_usd || !destination_address) {
        return errorResponse('INVALID_PAYLOAD', 'Missing required fields: chain, amount_usd, destination_address');
      }

      // Check sufficient balance
      if ((worker.available_balance_usd || 0) < amount_usd) {
        return errorResponse('INSUFFICIENT_BALANCE');
      }

      // Deduct from available balance
      await base44.asServiceRole.entities.Worker.update(worker.id, {
        available_balance_usd: (worker.available_balance_usd || 0) - amount_usd,
        total_withdrawn_usd: (worker.total_withdrawn_usd || 0) + amount_usd
      });

      // Create withdrawal transaction
      const transaction = await base44.asServiceRole.entities.Transaction.create({
        transaction_type: 'withdrawal',
        worker_id: worker.id,
        amount_usd: amount_usd,
        balance_type: 'available',
        status: 'pending',
        metadata: JSON.stringify({ chain, destination_address }),
        notes: `Withdrawal to ${destination_address}`
      });

      await logEvent(base44, 'funds_withdrawn', 'worker', worker.id, 'worker', worker.id, { 
        chain, 
        amount_usd, 
        destination_address,
        transaction_id: transaction.id 
      });

      return successResponse({
        withdrawal_id: transaction.id,
        status: 'pending',
        amount_usd: amount_usd,
        chain: chain,
        destination_address: destination_address
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
    
    // Get worker balance
    if (action === 'get_balance') {
      // Fetch USD ledger (legacy)
      const ledgers = await base44.asServiceRole.entities.Ledger.filter({ worker_id: worker.id });
      const ledger = ledgers[0] || { available_balance: 0, locked_balance: 0 };
      
      // Fetch crypto balances from LedgerAccount
      const ethAccounts = await base44.asServiceRole.entities.LedgerAccount.filter({
        owner_type: 'worker',
        owner_id: worker.id,
        chain: 'ETH'
      });
      const btcAccounts = await base44.asServiceRole.entities.LedgerAccount.filter({
        owner_type: 'worker',
        owner_id: worker.id,
        chain: 'BTC'
      });

      const ethAccount = ethAccounts[0] || { available_balance: '0', locked_balance: '0' };
      const btcAccount = btcAccounts[0] || { available_balance: '0', locked_balance: '0' };

      return successResponse({
        // Crypto balances
        ETH: {
          available_balance: ethAccount.available_balance || '0',
          locked_balance: ethAccount.locked_balance || '0'
        },
        BTC: {
          available_balance: btcAccount.available_balance || '0',
          locked_balance: btcAccount.locked_balance || '0'
        },
        // Legacy USD balance
        available_balance: ledger.available_balance || 0,
        locked_balance: ledger.locked_balance || 0,
        total_balance: (ledger.available_balance || 0) + (ledger.locked_balance || 0)
      });
    }

    // Get worker deposit addresses
    if (action === 'get_deposit_addresses') {
      const addresses = await base44.asServiceRole.entities.WorkerDepositAddress.filter({
        worker_id: worker.id,
        status: 'active'
      });

      const result = {};
      for (const addr of addresses) {
        result[addr.chain] = addr.address;
      }

      return successResponse(result);
    }

    // Generate new deposit address (idempotent)
    if (action === 'generate_deposit_address') {
      const { chain } = body;
      if (!chain || !['ETH', 'BTC'].includes(chain)) {
        return errorResponse('INVALID_PAYLOAD', 'chain must be ETH or BTC');
      }

      // Check if address already exists for this worker+chain (idempotent)
      const existing = await base44.asServiceRole.entities.WorkerDepositAddress.filter({
        worker_id: worker.id,
        chain,
        status: 'active'
      });

      if (existing.length > 0) {
        return successResponse({
          chain,
          address: existing[0].address,
          derivation_index: existing[0].derivation_index,
          message: 'Address already exists'
        });
      }

      // Config check
      const TATUM_API_KEY = Deno.env.get('TATUM_API_KEY_MAINNET');
      const TATUM_TESTNET = Deno.env.get('TATUM_TESTNET') === 'true';
      const DEPOSIT_MASTER_XPUB = chain === 'ETH' 
        ? Deno.env.get('DEPOSIT_MASTER_XPUB_ETH') 
        : Deno.env.get('DEPOSIT_MASTER_XPUB_BTC');

      console.log(`[generate_deposit_address] chain=${chain}, TATUM_API_KEY set=${!!TATUM_API_KEY}, DEPOSIT_MASTER_XPUB set=${!!DEPOSIT_MASTER_XPUB}`);

      if (!TATUM_API_KEY) {
        console.error('[generate_deposit_address] Missing TATUM_API_KEY_MAINNET');
        return errorResponse('INTERNAL_ERROR', 'TATUM_API_KEY_MAINNET not configured');
      }

      if (!DEPOSIT_MASTER_XPUB) {
        console.error(`[generate_deposit_address] Missing DEPOSIT_MASTER_XPUB_${chain}`);
        return errorResponse('INTERNAL_ERROR', `DEPOSIT_MASTER_XPUB_${chain} not configured. Initialize via Settings > Deposit Master Setup.`);
      }

      // Atomic derivation index allocation via DepositDerivationState
      let derivationIndex;
      const MAX_RETRIES = 5;
      
      for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
        const states = await base44.asServiceRole.entities.DepositDerivationState.filter({ chain });
        
        let state;
        if (states.length === 0) {
          state = await base44.asServiceRole.entities.DepositDerivationState.create({
            chain,
            next_index: 0,
            last_allocated_at: new Date().toISOString()
          });
        } else {
          state = states[0];
        }

        const currentIndex = state.next_index;

        try {
          await base44.asServiceRole.entities.DepositDerivationState.update(state.id, {
            next_index: currentIndex + 1,
            last_allocated_at: new Date().toISOString()
          });

          // Verify update succeeded
          const [updatedState] = await base44.asServiceRole.entities.DepositDerivationState.filter({ chain });
          
          if (updatedState.next_index === currentIndex + 1) {
            derivationIndex = currentIndex;
            break;
          }

          // Race condition, retry
          await new Promise(r => setTimeout(r, Math.random() * 50 + 10));
        } catch (err) {
          if (attempt === MAX_RETRIES - 1) throw err;
          await new Promise(r => setTimeout(r, Math.random() * 50 + 10));
        }
      }

      if (derivationIndex === undefined) {
        return errorResponse('INTERNAL_ERROR', 'Failed to allocate derivation index after retries');
      }

      // Derive address from deposit master xpub
      const tatumChain = chain === 'ETH' 
        ? (TATUM_TESTNET ? 'ethereum-sepolia' : 'ethereum')
        : (TATUM_TESTNET ? 'bitcoin-testnet' : 'bitcoin');

      const tatumUrl = `https://api.tatum.io/v3/${tatumChain}/address/${DEPOSIT_MASTER_XPUB}/${derivationIndex}`;
      console.log(`[generate_deposit_address] Calling Tatum: ${tatumUrl}`);
      
      const tatumResponse = await fetch(tatumUrl, {
        method: 'GET',
        headers: {
          'x-api-key': TATUM_API_KEY
        }
      });

      if (!tatumResponse.ok) {
        const errText = await tatumResponse.text();
        console.error(`[generate_deposit_address] Tatum error ${tatumResponse.status}: ${errText}`);
        let errData = {};
        try { errData = JSON.parse(errText); } catch {}
        return errorResponse('INTERNAL_ERROR', errData.message || `Tatum API error: ${tatumResponse.status}`);
      }

      const tatumData = await tatumResponse.json();
      const generatedAddress = tatumData.address;

      // Store WorkerDepositAddress
      await base44.asServiceRole.entities.WorkerDepositAddress.create({
        worker_id: worker.id,
        chain,
        address: generatedAddress,
        derivation_index: derivationIndex,
        status: 'active'
      });

      // Register in TrackedAddress for webhook processing
      await base44.asServiceRole.entities.TrackedAddress.create({
        chain,
        address: generatedAddress,
        owner_type: 'worker',
        owner_id: worker.id,
        purpose: 'deposit'
      });

      // Emit tracked_address_registered event
      await logEvent(base44, 'tracked_address_registered', 'deposit', generatedAddress, 'worker', worker.id, {
        chain,
        address: generatedAddress,
        owner_type: 'worker',
        owner_id: worker.id,
        purpose: 'deposit',
        derivation_index: derivationIndex
      });

      // Log worker deposit address created event
      await logEvent(base44, 'worker_deposit_address_created', 'worker', worker.id, 'worker', worker.id, {
        chain,
        address: generatedAddress,
        derivation_index: derivationIndex
      });

      return successResponse({
        chain,
        address: generatedAddress,
        derivation_index: derivationIndex,
        message: 'Address generated and registered'
      });
    }
    
    // Withdraw funds
    if (action === 'withdraw_funds') {
      if (!body.amount || body.amount <= 0) return errorResponse('INVALID_PAYLOAD', 'Valid amount required');
      
      const ledgers = await base44.asServiceRole.entities.Ledger.filter({ worker_id: worker.id });
      if (!ledgers || ledgers.length === 0) return errorResponse('INSUFFICIENT_BALANCE');
      
      const ledger = ledgers[0];
      if (ledger.available_balance < body.amount) return errorResponse('INSUFFICIENT_BALANCE');
      
      await base44.asServiceRole.entities.Ledger.update(ledger.id, {
        available_balance: ledger.available_balance - body.amount,
        total_withdrawn: (ledger.total_withdrawn || 0) + body.amount
      });
      
      await base44.asServiceRole.entities.Transaction.create({
        transaction_type: 'withdrawal',
        worker_id: worker.id,
        amount_usd: body.amount,
        balance_type: 'available',
        status: 'completed',
        notes: 'Worker withdrawal request'
      });
      
      await logEvent(base44, 'funds_withdrawn', 'transaction', null, 'worker', worker.id, {
        amount: body.amount,
        new_balance: ledger.available_balance - body.amount
      });
      
      return successResponse({
        withdrawn: body.amount,
        new_available_balance: ledger.available_balance - body.amount
      });
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
    
    // Get payout addresses
    if (action === 'get_payout_addresses') {
      const addresses = await base44.asServiceRole.entities.WorkerPayoutAddress.filter({
        worker_id: worker.id
      });

      return successResponse(addresses.map(a => ({
        id: a.id,
        chain: a.chain,
        address: a.address,
        label: a.label,
        is_verified: a.is_verified || false,
        added_at: a.created_date
      })));
    }

    // Add payout address
    if (action === 'add_payout_address') {
      const { chain, address, label } = body;

      if (!chain || !['ETH', 'BTC'].includes(chain)) {
        return errorResponse('INVALID_PAYLOAD', 'chain must be ETH or BTC');
      }
      if (!address) {
        return errorResponse('INVALID_PAYLOAD', 'address required');
      }

      // Validate address format
      if (chain === 'ETH' && !/^0x[a-fA-F0-9]{40}$/.test(address)) {
        return errorResponse('INVALID_PAYLOAD', 'Invalid ETH address format');
      }
      if (chain === 'BTC') {
        const btcValid = /^(1|3)[a-km-zA-HJ-NP-Z1-9]{25,34}$/.test(address) || 
                         /^bc1[a-z0-9]{39,59}$/.test(address);
        if (!btcValid) {
          return errorResponse('INVALID_PAYLOAD', 'Invalid BTC address format');
        }
      }

      // Check if already exists
      const existing = await base44.asServiceRole.entities.WorkerPayoutAddress.filter({
        worker_id: worker.id,
        chain,
        address
      });

      if (existing.length > 0) {
        return successResponse({
          id: existing[0].id,
          chain,
          address,
          label: existing[0].label,
          is_verified: existing[0].is_verified,
          message: 'Address already exists'
        });
      }

      // Create new payout address
      const payoutAddr = await base44.asServiceRole.entities.WorkerPayoutAddress.create({
        worker_id: worker.id,
        chain,
        address,
        label: label || null,
        is_verified: false
      });

      await logEvent(base44, 'payout_address_added', 'worker', worker.id, 'worker', worker.id, {
        chain,
        address,
        label
      });

      return successResponse({
        id: payoutAddr.id,
        chain,
        address,
        label: payoutAddr.label,
        is_verified: false,
        message: 'Payout address added'
      });
    }

    // Request withdrawal
    if (action === 'request_withdrawal') {
      const { chain, amount, destination_address } = body;

      if (!chain || !['ETH', 'BTC'].includes(chain)) {
        return errorResponse('INVALID_PAYLOAD', 'chain must be ETH or BTC');
      }
      if (!amount || parseFloat(amount) <= 0) {
        return errorResponse('INVALID_PAYLOAD', 'Valid amount required');
      }
      if (!destination_address) {
        return errorResponse('INVALID_PAYLOAD', 'destination_address required');
      }

      // Get worker's ledger account for this chain
      const accounts = await base44.asServiceRole.entities.LedgerAccount.filter({
        owner_type: 'worker',
        owner_id: worker.id,
        chain
      });

      if (accounts.length === 0) {
        return errorResponse('INSUFFICIENT_BALANCE', `No ${chain} balance available`);
      }

      const account = accounts[0];
      const availableBalance = account.available_balance || '0';

      // Decimal comparison
      const toScaled = (amt) => {
        if (!amt) return 0n;
        if (typeof amt === 'string') {
          const [whole, frac = ''] = amt.split('.');
          return BigInt(whole + frac.padEnd(18, '0').slice(0, 18));
        }
        return BigInt(Math.round(Number(amt) * 1e18));
      };

      if (toScaled(amount) > toScaled(availableBalance)) {
        return errorResponse('INSUFFICIENT_BALANCE', `Available: ${availableBalance} ${chain}`);
      }

      // Check destination is in payout addresses (auto-add if not)
      const payoutAddrs = await base44.asServiceRole.entities.WorkerPayoutAddress.filter({
        worker_id: worker.id,
        chain,
        address: destination_address
      });

      if (payoutAddrs.length === 0) {
        // Auto-add the address
        await base44.asServiceRole.entities.WorkerPayoutAddress.create({
          worker_id: worker.id,
          chain,
          address: destination_address,
          label: 'Auto-added on withdrawal',
          is_verified: false
        });

        await logEvent(base44, 'payout_address_added', 'worker', worker.id, 'worker', worker.id, {
          chain,
          address: destination_address,
          auto_added: true
        });
      }

      // Lock funds: available -> locked
      const fromScaled = (scaled) => {
        const str = scaled.toString().padStart(19, '0');
        const whole = str.slice(0, -18) || '0';
        const frac = str.slice(-18).replace(/0+$/, '') || '0';
        return frac === '0' ? whole : `${whole}.${frac}`;
      };

      const newAvailable = fromScaled(toScaled(availableBalance) - toScaled(amount));
      const newLocked = fromScaled(toScaled(account.locked_balance || '0') + toScaled(amount));

      await base44.asServiceRole.entities.LedgerAccount.update(account.id, {
        available_balance: newAvailable,
        locked_balance: newLocked
      });

      // Create withdrawal request
      const withdrawal = await base44.asServiceRole.entities.WithdrawalRequest.create({
        worker_id: worker.id,
        chain,
        amount,
        destination_address,
        status: 'requested',
        risk_score: 0,
        risk_reasons: '[]'
      });

      // Create ledger entry
      await base44.asServiceRole.entities.LedgerEntry.create({
        chain,
        amount,
        entry_type: 'lock',
        from_owner_type: 'worker',
        from_owner_id: worker.id,
        to_owner_type: 'worker',
        to_owner_id: worker.id,
        metadata: JSON.stringify({
          withdrawal_id: withdrawal.id,
          destination_address,
          action: 'withdrawal_requested'
        })
      });

      await logEvent(base44, 'withdrawal_requested', 'worker', worker.id, 'worker', worker.id, {
        chain,
        amount,
        destination_address,
        withdrawal_id: withdrawal.id,
        new_available: newAvailable,
        new_locked: newLocked
      });

      // Trigger risk assessment and auto-approval check
      let riskResult = null;
      try {
        const riskResponse = await base44.asServiceRole.functions.invoke('withdrawalRisk', {
          action: 'process_withdrawal',
          withdrawal_id: withdrawal.id
        });
        riskResult = riskResponse.data || riskResponse;
      } catch (err) {
        console.error('Risk assessment failed:', err);
        // Continue with 'requested' status if risk engine fails
      }

      return successResponse({
        withdrawal_id: withdrawal.id,
        chain,
        amount,
        destination_address,
        status: riskResult?.status || 'requested',
        risk_score: riskResult?.risk_score,
        risk_reasons: riskResult?.risk_reasons,
        auto_approved: riskResult?.auto_approved || false,
        balance: {
          available: newAvailable,
          locked: newLocked
        }
      });
    }

    // Get withdrawal history
    if (action === 'get_withdrawals') {
      const withdrawals = await base44.asServiceRole.entities.WithdrawalRequest.filter({
        worker_id: worker.id
      }, '-created_date', body.limit || 50);

      return successResponse(withdrawals.map(w => ({
        id: w.id,
        chain: w.chain,
        amount: w.amount,
        destination_address: w.destination_address,
        status: w.status,
        tx_hash: w.tx_hash,
        created_at: w.created_date,
        updated_at: w.updated_date
      })));
    }

    // Create a task (bot-to-bot marketplace with escrow)
    if (action === 'create_task') {
      const { 
        title, type, description, requirements, input_data, output_schema, 
        task_price_usd, required_stake_usd, deadline, tags, settlement_chain,
        reward, currency, expires_in_minutes, validation_mode 
      } = body;

      if (!title || !type || !description) {
        return errorResponse('INVALID_PAYLOAD', 'title, type, and description required');
      }

      const validTypes = ['data_extraction', 'content_generation', 'code_review', 'classification', 'transformation', 'verification', 'other'];
      if (!validTypes.includes(type)) {
        return errorResponse('INVALID_PAYLOAD', `type must be one of: ${validTypes.join(', ')}`);
      }

      // === ANTI-SPAM CHECKS ===
      
      // 1. Check account age requirement
      if (TASK_CREATION_LIMITS.REQUIRED_ACCOUNT_AGE_MINUTES > 0) {
        const accountAge = (Date.now() - new Date(worker.created_date).getTime()) / 60000;
        if (accountAge < TASK_CREATION_LIMITS.REQUIRED_ACCOUNT_AGE_MINUTES) {
          await logEvent(base44, 'task_create_rejected_account_age', 'worker', worker.id, 'system', 'anti_spam', {
            account_age_minutes: Math.floor(accountAge),
            required_minutes: TASK_CREATION_LIMITS.REQUIRED_ACCOUNT_AGE_MINUTES
          });
          return errorResponse('ACCOUNT_TOO_NEW', `Account must be at least ${TASK_CREATION_LIMITS.REQUIRED_ACCOUNT_AGE_MINUTES} minutes old`);
        }
      }

      // 2. Check reputation requirement
      if (TASK_CREATION_LIMITS.REQUIRED_CREATOR_REPUTATION > 0) {
        if ((worker.reputation_score || 0) < TASK_CREATION_LIMITS.REQUIRED_CREATOR_REPUTATION) {
          await logEvent(base44, 'task_create_rejected_reputation', 'worker', worker.id, 'system', 'anti_spam', {
            reputation: worker.reputation_score || 0,
            required: TASK_CREATION_LIMITS.REQUIRED_CREATOR_REPUTATION
          });
          return errorResponse('CREATOR_REPUTATION_LOW', `Reputation must be at least ${TASK_CREATION_LIMITS.REQUIRED_CREATOR_REPUTATION}`);
        }
      }

      // 3. Check hourly task creation rate limit
      const oneHourAgo = new Date(Date.now() - 3600000).toISOString();
      const recentTasks = await base44.asServiceRole.entities.Task.filter({
        creator_worker_id: worker.id
      });
      const tasksCreatedLastHour = recentTasks.filter(t => t.created_date >= oneHourAgo).length;
      
      if (tasksCreatedLastHour >= TASK_CREATION_LIMITS.MAX_TASKS_CREATED_PER_HOUR) {
        await logEvent(base44, 'task_create_rejected_rate_limit', 'worker', worker.id, 'system', 'anti_spam', {
          tasks_created_last_hour: tasksCreatedLastHour,
          limit: TASK_CREATION_LIMITS.MAX_TASKS_CREATED_PER_HOUR
        });
        return errorResponse('RATE_LIMIT_TASKS_HOUR', `Max ${TASK_CREATION_LIMITS.MAX_TASKS_CREATED_PER_HOUR} tasks per hour`);
      }

      // 4. Check max open tasks per worker
      const openTasks = await base44.asServiceRole.entities.Task.filter({
        creator_worker_id: worker.id,
        status: 'open'
      });
      
      if (openTasks.length >= TASK_CREATION_LIMITS.MAX_OPEN_TASKS_PER_WORKER) {
        await logEvent(base44, 'task_create_rejected_rate_limit', 'worker', worker.id, 'system', 'anti_spam', {
          open_tasks: openTasks.length,
          limit: TASK_CREATION_LIMITS.MAX_OPEN_TASKS_PER_WORKER
        });
        return errorResponse('RATE_LIMIT_OPEN_TASKS', `Max ${TASK_CREATION_LIMITS.MAX_OPEN_TASKS_PER_WORKER} open tasks allowed`);
      }

      // 5. Check minimum reward (for crypto rewards)
      const chain = settlement_chain || currency || 'ETH';
      const rewardAmount = reward ? reward.toString() : null;
      
      if (rewardAmount) {
        const minReward = chain === 'BTC' 
          ? TASK_CREATION_LIMITS.MIN_TASK_REWARD_BTC 
          : TASK_CREATION_LIMITS.MIN_TASK_REWARD_ETH;
        
        const toScaledCheck = (amt) => {
          if (!amt) return 0n;
          const [whole, frac = ''] = amt.toString().split('.');
          return BigInt(whole + frac.padEnd(18, '0').slice(0, 18));
        };
        
        if (toScaledCheck(rewardAmount) < toScaledCheck(minReward)) {
          await logEvent(base44, 'task_create_rejected_low_reward', 'worker', worker.id, 'system', 'anti_spam', {
            reward: rewardAmount,
            currency: chain,
            minimum: minReward
          });
          return errorResponse('REWARD_TOO_LOW', `Minimum reward is ${minReward} ${chain}`);
        }
      }

      // === END ANTI-SPAM CHECKS ===

      // Support both USD pricing and crypto reward
      const taskPrice = parseFloat(task_price_usd) || 0;
      const stakeRequired = parseFloat(required_stake_usd) || 0;
      // chain already defined above in anti-spam checks
      // rewardAmount already defined above in anti-spam checks
      const taskValidationMode = validation_mode || 'none';

      // Validate validation_mode
      const validModes = ['deterministic', 'multi_worker', 'reputation', 'none'];
      if (!validModes.includes(taskValidationMode)) {
        return errorResponse('INVALID_PAYLOAD', `validation_mode must be one of: ${validModes.join(', ')}`);
      }

      // Calculate expiration
      let expiresAt = deadline || null;
      if (expires_in_minutes && !expiresAt) {
        expiresAt = new Date(Date.now() + parseInt(expires_in_minutes) * 60 * 1000).toISOString();
      }

      // Decimal math helpers for crypto amounts
      const toScaled = (amt) => {
        if (!amt) return 0n;
        if (typeof amt === 'string') {
          const [whole, frac = ''] = amt.split('.');
          return BigInt(whole + frac.padEnd(18, '0').slice(0, 18));
        }
        return BigInt(Math.round(Number(amt) * 1e18));
      };
      const fromScaled = (scaled) => {
        const str = scaled.toString().padStart(19, '0');
        const whole = str.slice(0, -18) || '0';
        const frac = str.slice(-18).replace(/0+$/, '') || '0';
        return frac === '0' ? whole : `${whole}.${frac}`;
      };

      // Handle escrow for crypto rewards
      if (rewardAmount && toScaled(rewardAmount) > 0n) {
        // Get worker's ledger account for this chain
        const accounts = await base44.asServiceRole.entities.LedgerAccount.filter({
          owner_type: 'worker',
          owner_id: worker.id,
          chain
        });

        if (accounts.length === 0) {
          return errorResponse('INSUFFICIENT_BALANCE', `No ${chain} balance available. Deposit funds first.`);
        }

        const account = accounts[0];
        const availableBalance = account.available_balance || '0';

        if (toScaled(rewardAmount) > toScaled(availableBalance)) {
          return errorResponse('INSUFFICIENT_BALANCE', `Need ${rewardAmount} ${chain} to fund task, available: ${availableBalance} ${chain}`);
        }

        // Lock escrow: available -> locked
        const newAvailable = fromScaled(toScaled(availableBalance) - toScaled(rewardAmount));
        const newLocked = fromScaled(toScaled(account.locked_balance || '0') + toScaled(rewardAmount));

        await base44.asServiceRole.entities.LedgerAccount.update(account.id, {
          available_balance: newAvailable,
          locked_balance: newLocked
        });

        // Create ledger entry for escrow lock
        await base44.asServiceRole.entities.LedgerEntry.create({
          chain,
          amount: rewardAmount,
          entry_type: 'lock',
          from_owner_type: 'worker',
          from_owner_id: worker.id,
          to_owner_type: 'worker',
          to_owner_id: worker.id,
          metadata: JSON.stringify({
            action: 'task_escrow_locked',
            task_title: title
          })
        });

        await logEvent(base44, 'escrow_locked', 'task', null, 'worker', worker.id, {
          chain,
          amount: rewardAmount,
          task_title: title,
          new_available: newAvailable,
          new_locked: newLocked
        });
      }

      // Also handle USD-based funding (legacy path)
      if (taskPrice > 0 && !rewardAmount) {
        const ledger = await getOrCreateLedger(base44, worker.id);
        if (ledger.available_balance < taskPrice) {
          return errorResponse('INSUFFICIENT_BALANCE', `Need ${taskPrice} USD to fund task, available: ${ledger.available_balance}`);
        }

        await base44.asServiceRole.entities.Ledger.update(ledger.id, {
          available_balance: ledger.available_balance - taskPrice,
          locked_balance: ledger.locked_balance + taskPrice
        });

        await base44.asServiceRole.entities.Transaction.create({
          transaction_type: 'lock',
          worker_id: worker.id,
          amount_usd: taskPrice,
          balance_type: 'locked',
          notes: `Task funding locked: ${title}`
        });
      }

      const task = await base44.asServiceRole.entities.Task.create({
        title,
        type,
        task_type: 'short',
        description,
        requirements: requirements ? (typeof requirements === 'string' ? requirements : JSON.stringify(requirements)) : null,
        input_data: input_data ? (typeof input_data === 'string' ? input_data : JSON.stringify(input_data)) : null,
        output_schema: output_schema ? (typeof output_schema === 'string' ? output_schema : JSON.stringify(output_schema)) : null,
        status: 'open',
        priority: body.priority || 0,
        reward_credits: body.reward_credits || 0,
        task_price_usd: taskPrice,
        required_stake_usd: stakeRequired,
        deadline: expiresAt,
        expires_at: expiresAt,
        tags: tags || [],
        settlement_chain: chain,
        currency: chain,
        payer_id: worker.id,
        creator_worker_id: worker.id,
        claim_timeout_minutes: body.claim_timeout_minutes || 30,
        reward: rewardAmount,
        escrow_amount: rewardAmount,
        escrow_status: rewardAmount ? 'locked' : 'none',
        validation_mode: taskValidationMode
      });

      // Log task creation event
      await logEvent(base44, 'task_created', 'task', task.id, 'worker', worker.id, {
        title,
        type,
        task_price_usd: taskPrice,
        reward: rewardAmount,
        currency: chain,
        escrow_status: rewardAmount ? 'locked' : 'none',
        validation_mode: taskValidationMode,
        creator_worker_id: worker.id
      });

      // Log escrow locked event if applicable
      if (rewardAmount) {
        await logEvent(base44, 'escrow_locked', 'task', task.id, 'worker', worker.id, {
          chain,
          amount: rewardAmount,
          task_id: task.id
        });
      }

      return successResponse({
        task_id: task.id,
        title: task.title,
        type: task.type,
        status: task.status,
        task_price_usd: taskPrice,
        required_stake_usd: stakeRequired,
        reward: rewardAmount,
        currency: chain,
        escrow_amount: rewardAmount,
        escrow_status: rewardAmount ? 'locked' : 'none',
        validation_mode: taskValidationMode,
        expires_at: expiresAt,
        settlement_chain: chain,
        created_date: task.created_date
      });
    }

    // Cancel own task (only if open, no claims) - with escrow refund
    if (action === 'cancel_task') {
      const { task_id } = body;
      if (!task_id) return errorResponse('INVALID_PAYLOAD', 'task_id required');

      const tasks = await base44.asServiceRole.entities.Task.filter({ id: task_id });
      if (!tasks || tasks.length === 0) return errorResponse('TASK_NOT_FOUND');

      const task = tasks[0];
      const creatorId = task.creator_worker_id || task.payer_id;

      // Only creator/payer can cancel
      if (creatorId !== worker.id) {
        return errorResponse('TASK_NOT_CLAIMED', 'Only task creator can cancel');
      }

      // Only open tasks can be cancelled
      if (task.status !== 'open') {
        return errorResponse('TASK_NOT_OPEN', 'Only open tasks can be cancelled');
      }

      // Refund crypto escrow if present
      if (task.escrow_amount && task.escrow_status === 'locked') {
        try {
          const refundResult = await base44.asServiceRole.functions.invoke('settleTask', {
            action: 'refund',
            task_id: task.id,
            reason: 'cancelled'
          });
          
          if (refundResult.data?.success || refundResult.data?.already_refunded) {
            return successResponse({
              task_id: task.id,
              status: 'cancelled',
              escrow_refunded: task.escrow_amount,
              currency: task.currency || task.settlement_chain || 'ETH'
            });
          }
        } catch (refundErr) {
          console.error('Escrow refund failed:', refundErr);
        }
      }

      // Refund USD locked funds (legacy path)
      if (task.task_price_usd > 0 && !task.escrow_amount) {
        const ledger = await getOrCreateLedger(base44, worker.id);
        await base44.asServiceRole.entities.Ledger.update(ledger.id, {
          available_balance: ledger.available_balance + task.task_price_usd,
          locked_balance: Math.max(0, ledger.locked_balance - task.task_price_usd)
        });

        await base44.asServiceRole.entities.Transaction.create({
          transaction_type: 'unlock',
          worker_id: worker.id,
          task_id: task.id,
          amount_usd: task.task_price_usd,
          balance_type: 'available',
          notes: `Task cancelled, funds returned: ${task.title}`
        });
      }

      await base44.asServiceRole.entities.Task.update(task.id, {
        status: 'cancelled',
        escrow_status: task.escrow_amount ? 'refunded' : task.escrow_status
      });

      await logEvent(base44, 'task_cancelled', 'task', task.id, 'worker', worker.id, {
        title: task.title,
        refunded: task.task_price_usd,
        escrow_refunded: task.escrow_amount
      });

      return successResponse({
        task_id: task.id,
        status: 'cancelled',
        refunded: task.task_price_usd,
        escrow_refunded: task.escrow_amount
      });
    }

    // List tasks created by this worker
    if (action === 'my_tasks') {
      const tasks = await base44.asServiceRole.entities.Task.filter({
        payer_id: worker.id
      }, '-created_date', body.limit || 50);

      return successResponse(tasks.map(t => ({
        id: t.id,
        title: t.title,
        type: t.type,
        status: t.status,
        task_price_usd: t.task_price_usd,
        claimed_by: t.claimed_by,
        created_date: t.created_date
      })), { count: tasks.length });
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