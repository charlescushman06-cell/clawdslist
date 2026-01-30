import { createClientFromRequest } from 'npm:@base44/sdk@0.8.6';

const ERROR_CODES = {
  UNAUTHORIZED: { code: 'UNAUTHORIZED', message: 'Invalid or missing API key', status: 401 },
  WORKER_NOT_FOUND: { code: 'WORKER_NOT_FOUND', message: 'Worker not found', status: 404 },
  INSUFFICIENT_BALANCE: { code: 'INSUFFICIENT_BALANCE', message: 'Insufficient available balance', status: 400 },
  INVALID_AMOUNT: { code: 'INVALID_AMOUNT', message: 'Invalid amount', status: 400 },
  INVALID_ACTION: { code: 'INVALID_ACTION', message: 'Invalid action', status: 400 },
};

function errorResponse(errorCode, details = null) {
  return Response.json({
    success: false,
    error: errorCode.code,
    message: errorCode.message,
    details: details
  }, { status: errorCode.status });
}

function successResponse(data) {
  return Response.json({
    success: true,
    data: data,
    meta: { timestamp: new Date().toISOString() }
  });
}

async function authenticateWorker(base44, apiKey) {
  if (!apiKey) return null;
  const workers = await base44.asServiceRole.entities.Worker.filter({ api_key: apiKey });
  return workers.length > 0 ? workers[0] : null;
}

async function logTransaction(base44, txData) {
  return await base44.asServiceRole.entities.Transaction.create(txData);
}

async function logEvent(base44, eventData) {
  return await base44.asServiceRole.entities.Event.create(eventData);
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

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();

    if (!user || user.role !== 'admin') {
      return Response.json({ error: 'Admin access required' }, { status: 403 });
    }

    const payload = await req.json();
    const apiKey = payload.api_key || req.headers.get('X-API-Key');
    const action = payload.action;

    if (!action) {
      return errorResponse(ERROR_CODES.INVALID_ACTION);
    }

    // Authenticate worker
    const worker = await authenticateWorker(base44, apiKey);
    if (!worker) {
      return errorResponse(ERROR_CODES.UNAUTHORIZED);
    }

    if (worker.status !== 'active') {
      return errorResponse(ERROR_CODES.UNAUTHORIZED, 'Worker is not active');
    }

    // Handle milestone payment transfer
    if (action === 'transfer_payment') {
      const { from_worker_id, to_worker_id, task_id, milestone_id, amount, protocol_fee } = payload;
      
      const fromLedger = await getOrCreateLedger(base44, from_worker_id);
      const toLedger = await getOrCreateLedger(base44, to_worker_id);
      
      const netAmount = amount - protocol_fee;
      
      await base44.asServiceRole.entities.Ledger.update(fromLedger.id, {
        available_balance: fromLedger.available_balance - amount
      });
      
      await base44.asServiceRole.entities.Ledger.update(toLedger.id, {
        available_balance: toLedger.available_balance + netAmount,
        total_earned: (toLedger.total_earned || 0) + netAmount
      });
      
      await base44.asServiceRole.entities.Transaction.create({
        transaction_type: 'transfer',
        from_worker_id,
        to_worker_id,
        worker_id: to_worker_id,
        task_id,
        amount_usd: netAmount,
        balance_type: 'available',
        status: 'completed',
        metadata: JSON.stringify({ milestone_id, protocol_fee }),
        notes: milestone_id ? 'Milestone payment' : 'Task payment'
      });
      
      if (protocol_fee > 0) {
        await base44.asServiceRole.entities.Transaction.create({
          transaction_type: 'fee',
          worker_id: from_worker_id,
          task_id,
          amount_usd: protocol_fee,
          status: 'completed',
          metadata: JSON.stringify({ milestone_id })
        });
      }
      
      await base44.asServiceRole.entities.Event.create({
        event_type: 'funds_transferred',
        entity_type: 'transaction',
        actor_type: 'system',
        details: JSON.stringify({ from_worker_id, to_worker_id, amount: netAmount, milestone_id })
      });
      
      return successResponse({ net_amount: netAmount });
    }
    
    if (action === 'unlock_stake') {
      const { worker_id, task_id, milestone_id, amount } = payload;
      
      const ledger = await getOrCreateLedger(base44, worker_id);
      
      await base44.asServiceRole.entities.Ledger.update(ledger.id, {
        available_balance: ledger.available_balance + amount,
        locked_balance: Math.max(0, ledger.locked_balance - amount)
      });
      
      await base44.asServiceRole.entities.Transaction.create({
        transaction_type: 'unlock',
        worker_id,
        task_id,
        amount_usd: amount,
        balance_type: 'locked',
        status: 'completed',
        metadata: JSON.stringify({ milestone_id })
      });
      
      await base44.asServiceRole.entities.Event.create({
        event_type: 'funds_unlocked',
        entity_type: 'transaction',
        entity_id: task_id,
        actor_type: 'system',
        details: JSON.stringify({ worker_id, amount, milestone_id })
      });
      
      return successResponse({ success: true });
    }
    
    if (action === 'slash_stake') {
      const { worker_id, task_id, milestone_id, amount } = payload;
      
      const ledger = await getOrCreateLedger(base44, worker_id);
      
      await base44.asServiceRole.entities.Ledger.update(ledger.id, {
        locked_balance: Math.max(0, ledger.locked_balance - amount),
        total_slashed: (ledger.total_slashed || 0) + amount
      });
      
      await base44.asServiceRole.entities.Transaction.create({
        transaction_type: 'slash',
        worker_id,
        task_id,
        amount_usd: amount,
        balance_type: 'locked',
        status: 'completed',
        metadata: JSON.stringify({ milestone_id })
      });
      
      await base44.asServiceRole.entities.Event.create({
        event_type: 'funds_slashed',
        entity_type: 'transaction',
        entity_id: task_id,
        actor_type: 'system',
        details: JSON.stringify({ worker_id, amount, milestone_id })
      });
      
      return successResponse({ success: true });
    }
    
    if (action === 'deposit') {
      const { worker_id, amount } = payload;
      if (!worker_id || !amount || amount <= 0) {
        return Response.json({ error: 'worker_id and valid amount required' }, { status: 400 });
      }

      const ledger = await getOrCreateLedger(base44, worker_id);
      
      await base44.asServiceRole.entities.Ledger.update(ledger.id, {
        available_balance: (ledger.available_balance || 0) + amount,
        total_deposited: (ledger.total_deposited || 0) + amount
      });

      await base44.asServiceRole.entities.Transaction.create({
        transaction_type: 'deposit',
        worker_id,
        amount_usd: amount,
        balance_type: 'available',
        status: 'completed'
      });
      
      await base44.asServiceRole.entities.Event.create({
        event_type: 'funds_deposited',
        entity_type: 'transaction',
        actor_type: 'system',
        details: JSON.stringify({ worker_id, amount })
      });
      
      return successResponse({ success: true, new_balance: (ledger.available_balance || 0) + amount });
    }
    
    return Response.json({ error: 'Unknown action' }, { status: 400 });

  } catch (error) {
    return Response.json({
      success: false,
      error: 'INTERNAL_ERROR',
      message: error.message
    }, { status: 500 });
  }
});