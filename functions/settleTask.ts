import { createClientFromRequest } from 'npm:@base44/sdk@0.8.6';

// Protocol fee in basis points (200 = 2%, configurable via env)
const PROTOCOL_FEE_BPS = parseInt(Deno.env.get('PROTOCOL_FEE_BPS') || '200', 10);

// Decimal math helpers
function toScaled(amt) {
  if (!amt) return 0n;
  if (typeof amt === 'string') {
    const [whole, frac = ''] = amt.split('.');
    return BigInt(whole + frac.padEnd(18, '0').slice(0, 18));
  }
  return BigInt(Math.round(Number(amt) * 1e18));
}

function fromScaled(scaled) {
  const str = scaled.toString().padStart(19, '0');
  const whole = str.slice(0, -18) || '0';
  const frac = str.slice(-18).replace(/0+$/, '') || '0';
  return frac === '0' ? whole : `${whole}.${frac}`;
}

function addDecimal(a, b) {
  return fromScaled(toScaled(a) + toScaled(b));
}

function subtractDecimal(a, b) {
  const result = toScaled(a) - toScaled(b);
  return fromScaled(result < 0n ? 0n : result);
}

function multiplyByBps(amount, bps) {
  // amount * bps / 10000
  const scaled = toScaled(amount);
  const fee = (scaled * BigInt(bps)) / 10000n;
  return fromScaled(fee);
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

async function getOrCreateLedgerAccount(base44, ownerType, ownerId, chain) {
  const filter = { owner_type: ownerType, chain };
  if (ownerId) filter.owner_id = ownerId;
  
  const accounts = await base44.asServiceRole.entities.LedgerAccount.filter(filter);
  if (accounts.length > 0) return accounts[0];
  
  return await base44.asServiceRole.entities.LedgerAccount.create({
    owner_type: ownerType,
    owner_id: ownerId || null,
    chain,
    available_balance: '0',
    locked_balance: '0'
  });
}

// Settle a completed task: pay worker from escrow, take protocol fee
async function settleTask(base44, taskId, submissionId = null) {
  // Get task
  const tasks = await base44.asServiceRole.entities.Task.filter({ id: taskId });
  if (!tasks || tasks.length === 0) {
    return { error: 'Task not found' };
  }
  
  const task = tasks[0];
  
  // Idempotency: check if already settled
  if (task.escrow_status === 'released') {
    return { already_settled: true, task_id: taskId };
  }
  
  // Must have escrow to settle
  if (!task.escrow_amount || task.escrow_status !== 'locked') {
    return { error: 'No escrow to settle', escrow_status: task.escrow_status };
  }
  
  // Must have a solver (claimed_by)
  if (!task.claimed_by) {
    return { error: 'Task has no assigned worker' };
  }
  
  const chain = task.currency || task.settlement_chain || 'ETH';
  const escrowAmount = task.escrow_amount;
  const creatorId = task.creator_worker_id || task.payer_id;
  const solverId = task.claimed_by;
  
  // Calculate fee and payout
  const feeRate = task.protocol_fee_rate_bps || PROTOCOL_FEE_BPS;
  const feeAmount = multiplyByBps(escrowAmount, feeRate);
  const payoutAmount = subtractDecimal(escrowAmount, feeAmount);
  
  // Settlement ID for idempotency
  const settlementId = `settle_${taskId}_${Date.now()}`;
  
  // Check for existing settlement entry (double-check idempotency)
  const existingEntries = await base44.asServiceRole.entities.LedgerEntry.filter({
    related_task_id: taskId,
    entry_type: 'task_settlement'
  });
  
  if (existingEntries.length > 0) {
    return { already_settled: true, task_id: taskId, settlement_id: existingEntries[0].id };
  }
  
  // 1. Decrement creator's locked_balance (escrow consumed)
  const creatorAccount = await getOrCreateLedgerAccount(base44, 'worker', creatorId, chain);
  await base44.asServiceRole.entities.LedgerAccount.update(creatorAccount.id, {
    locked_balance: subtractDecimal(creatorAccount.locked_balance || '0', escrowAmount)
  });
  
  // 2. Increment solver's available_balance
  const solverAccount = await getOrCreateLedgerAccount(base44, 'worker', solverId, chain);
  await base44.asServiceRole.entities.LedgerAccount.update(solverAccount.id, {
    available_balance: addDecimal(solverAccount.available_balance || '0', payoutAmount)
  });
  
  // 3. Increment protocol fee balance
  if (toScaled(feeAmount) > 0n) {
    const protocolAccount = await getOrCreateLedgerAccount(base44, 'protocol', null, chain);
    await base44.asServiceRole.entities.LedgerAccount.update(protocolAccount.id, {
      available_balance: addDecimal(protocolAccount.available_balance || '0', feeAmount)
    });
  }
  
  // 4. Update task status
  await base44.asServiceRole.entities.Task.update(taskId, {
    status: 'completed',
    escrow_status: 'released',
    completed_at: new Date().toISOString()
  });
  
  // 5. Create LedgerEntries for audit trail
  
  // Escrow consumed entry
  await base44.asServiceRole.entities.LedgerEntry.create({
    chain,
    amount: escrowAmount,
    entry_type: 'task_settlement',
    from_owner_type: 'worker',
    from_owner_id: creatorId,
    to_owner_type: 'worker',
    to_owner_id: solverId,
    related_task_id: taskId,
    related_submission_id: submissionId,
    metadata: JSON.stringify({
      settlement_id: settlementId,
      escrow_amount: escrowAmount,
      fee_rate_bps: feeRate,
      fee_amount: feeAmount,
      payout_amount: payoutAmount
    })
  });
  
  // Task payout entry
  await base44.asServiceRole.entities.LedgerEntry.create({
    chain,
    amount: payoutAmount,
    entry_type: 'payout',
    from_owner_type: 'worker',
    from_owner_id: creatorId,
    to_owner_type: 'worker',
    to_owner_id: solverId,
    related_task_id: taskId,
    related_submission_id: submissionId,
    metadata: JSON.stringify({
      settlement_id: settlementId,
      gross_amount: escrowAmount,
      net_amount: payoutAmount
    })
  });
  
  // Protocol fee entry
  if (toScaled(feeAmount) > 0n) {
    await base44.asServiceRole.entities.LedgerEntry.create({
      chain,
      amount: feeAmount,
      entry_type: 'protocol_fee_accrual',
      from_owner_type: 'worker',
      from_owner_id: creatorId,
      to_owner_type: 'protocol',
      to_owner_id: null,
      related_task_id: taskId,
      related_submission_id: submissionId,
      metadata: JSON.stringify({
        settlement_id: settlementId,
        fee_rate_bps: feeRate,
        gross_amount: escrowAmount
      })
    });
  }
  
  // 6. Log events
  await logEvent(base44, 'escrow_released', 'task', taskId, 'system', 'settlement', {
    chain,
    escrow_amount: escrowAmount,
    creator_id: creatorId,
    solver_id: solverId,
    fee_amount: feeAmount,
    payout_amount: payoutAmount,
    settlement_id: settlementId
  });
  
  await logEvent(base44, 'task_payout', 'task', taskId, 'system', 'settlement', {
    chain,
    solver_id: solverId,
    amount: payoutAmount,
    submission_id: submissionId
  });
  
  if (toScaled(feeAmount) > 0n) {
    await logEvent(base44, 'protocol_fee_accrued', 'task', taskId, 'system', 'settlement', {
      chain,
      amount: feeAmount,
      fee_rate_bps: feeRate,
      task_id: taskId
    });
  }
  
  return {
    success: true,
    task_id: taskId,
    settlement_id: settlementId,
    chain,
    escrow_amount: escrowAmount,
    fee_rate_bps: feeRate,
    fee_amount: feeAmount,
    payout_amount: payoutAmount,
    creator_id: creatorId,
    solver_id: solverId
  };
}

// Refund escrow to creator (for expired/cancelled tasks)
async function refundEscrow(base44, taskId, reason = 'cancelled') {
  // Get task
  const tasks = await base44.asServiceRole.entities.Task.filter({ id: taskId });
  if (!tasks || tasks.length === 0) {
    return { error: 'Task not found' };
  }
  
  const task = tasks[0];
  
  // Idempotency: check if already refunded or released
  if (task.escrow_status === 'refunded') {
    return { already_refunded: true, task_id: taskId };
  }
  
  if (task.escrow_status === 'released') {
    return { error: 'Escrow already released (task completed)' };
  }
  
  // Must have escrow to refund
  if (!task.escrow_amount || task.escrow_status !== 'locked') {
    return { error: 'No escrow to refund', escrow_status: task.escrow_status };
  }
  
  const chain = task.currency || task.settlement_chain || 'ETH';
  const escrowAmount = task.escrow_amount;
  const creatorId = task.creator_worker_id || task.payer_id;
  
  if (!creatorId) {
    return { error: 'No creator to refund to' };
  }
  
  // Refund ID for idempotency
  const refundId = `refund_${taskId}_${Date.now()}`;
  
  // Check for existing refund entry
  const existingEntries = await base44.asServiceRole.entities.LedgerEntry.filter({
    related_task_id: taskId,
    entry_type: 'unlock'
  });
  
  const hasRefundEntry = existingEntries.some(e => {
    const meta = e.metadata ? JSON.parse(e.metadata) : {};
    return meta.action === 'escrow_refunded';
  });
  
  if (hasRefundEntry) {
    return { already_refunded: true, task_id: taskId };
  }
  
  // 1. Move funds from locked back to available for creator
  const creatorAccount = await getOrCreateLedgerAccount(base44, 'worker', creatorId, chain);
  await base44.asServiceRole.entities.LedgerAccount.update(creatorAccount.id, {
    locked_balance: subtractDecimal(creatorAccount.locked_balance || '0', escrowAmount),
    available_balance: addDecimal(creatorAccount.available_balance || '0', escrowAmount)
  });
  
  // 2. Update task status
  const newStatus = reason === 'expired' ? 'expired' : 'cancelled';
  await base44.asServiceRole.entities.Task.update(taskId, {
    status: newStatus,
    escrow_status: 'refunded'
  });
  
  // 3. Create LedgerEntry for audit trail
  await base44.asServiceRole.entities.LedgerEntry.create({
    chain,
    amount: escrowAmount,
    entry_type: 'unlock',
    from_owner_type: 'worker',
    from_owner_id: creatorId,
    to_owner_type: 'worker',
    to_owner_id: creatorId,
    related_task_id: taskId,
    metadata: JSON.stringify({
      refund_id: refundId,
      action: 'escrow_refunded',
      reason
    })
  });
  
  // 4. Log event
  await logEvent(base44, 'escrow_refunded', 'task', taskId, 'system', 'settlement', {
    chain,
    escrow_amount: escrowAmount,
    creator_id: creatorId,
    reason,
    refund_id: refundId
  });
  
  return {
    success: true,
    task_id: taskId,
    refund_id: refundId,
    chain,
    escrow_amount: escrowAmount,
    creator_id: creatorId,
    reason
  };
}

Deno.serve(async (req) => {
  if (req.method !== 'POST') {
    return Response.json({ error: 'Method not allowed' }, { status: 405 });
  }
  
  let body;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: 'Invalid JSON' }, { status: 400 });
  }
  
  const base44 = createClientFromRequest(req);
  const { action, task_id, submission_id, reason } = body;
  
  try {
    // Settle task (pay worker from escrow)
    if (action === 'settle') {
      if (!task_id) {
        return Response.json({ error: 'task_id required' }, { status: 400 });
      }
      
      const result = await settleTask(base44, task_id, submission_id);
      
      if (result.error) {
        return Response.json({ success: false, error: result.error }, { status: 400 });
      }
      
      return Response.json({ success: true, ...result });
    }
    
    // Refund escrow to creator
    if (action === 'refund') {
      if (!task_id) {
        return Response.json({ error: 'task_id required' }, { status: 400 });
      }
      
      const result = await refundEscrow(base44, task_id, reason || 'cancelled');
      
      if (result.error) {
        return Response.json({ success: false, error: result.error }, { status: 400 });
      }
      
      return Response.json({ success: true, ...result });
    }
    
    // Get fee config
    if (action === 'get_config') {
      return Response.json({
        success: true,
        protocol_fee_bps: PROTOCOL_FEE_BPS,
        protocol_fee_percent: PROTOCOL_FEE_BPS / 100
      });
    }
    
    return Response.json({ error: 'Unknown action' }, { status: 400 });
    
  } catch (error) {
    console.error('Settlement error:', error);
    return Response.json({ error: error.message }, { status: 500 });
  }
});

export { settleTask, refundEscrow };