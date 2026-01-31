import { createClientFromRequest } from 'npm:@base44/sdk@0.8.6';

// Default protocol fee rate: 300 bps = 3%
const DEFAULT_PROTOCOL_FEE_RATE_BPS = 300;

// ============ DECIMAL-SAFE MATH ============
// All amounts are stored as strings and computed with BigInt (scaled by 1e18)
const SCALE = BigInt(10 ** 18);

function toScaled(amount) {
  if (typeof amount === 'string') {
    const [whole, frac = ''] = amount.split('.');
    const paddedFrac = frac.padEnd(18, '0').slice(0, 18);
    return BigInt(whole + paddedFrac);
  }
  return BigInt(Math.round(amount * 1e18));
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

function multiplyBps(amount, bps) {
  const scaled = toScaled(amount);
  const fee = (scaled * BigInt(bps)) / BigInt(10000);
  return fromScaled(fee);
}

// ============ IDEMPOTENCY ============
async function checkSettlementIdempotency(base44, settlementId) {
  const existing = await base44.asServiceRole.entities.LedgerEntry.filter({
    metadata: JSON.stringify({ settlement_id: settlementId })
  });
  
  // Also check by parsing metadata field
  const allEntries = await base44.asServiceRole.entities.LedgerEntry.list('-created_date', 100);
  for (const entry of allEntries) {
    try {
      const meta = JSON.parse(entry.metadata || '{}');
      if (meta.settlement_id === settlementId) {
        return true;
      }
    } catch {}
  }
  
  return false;
}

// ============ LEDGER OPERATIONS ============
async function getOrCreateWorkerLedgerAccount(base44, workerId, chain) {
  const accounts = await base44.asServiceRole.entities.LedgerAccount.filter({
    owner_type: 'worker',
    owner_id: workerId,
    chain
  });
  
  if (accounts.length > 0) return accounts[0];
  
  return await base44.asServiceRole.entities.LedgerAccount.create({
    owner_type: 'worker',
    owner_id: workerId,
    chain,
    available_balance: '0',
    locked_balance: '0'
  });
}

async function getProtocolLedgerAccount(base44, chain) {
  const accounts = await base44.asServiceRole.entities.LedgerAccount.filter({
    owner_type: 'protocol',
    chain
  });
  
  if (accounts.length === 0) {
    throw new Error(`Protocol ledger account not found for chain ${chain}`);
  }
  
  return accounts[0];
}

async function creditAccount(base44, account, amount) {
  const newBalance = addDecimal(account.available_balance || '0', amount);
  await base44.asServiceRole.entities.LedgerAccount.update(account.id, {
    available_balance: newBalance
  });
  return newBalance;
}

async function debitAccount(base44, account, amount) {
  const newBalance = subtractDecimal(account.available_balance || '0', amount);
  await base44.asServiceRole.entities.LedgerAccount.update(account.id, {
    available_balance: newBalance
  });
  return newBalance;
}

// ============ SETTLEMENT LOGIC ============
async function settleTaskPayment(base44, params) {
  const {
    task_id,
    submission_id,
    milestone_id,
    payer_id,
    worker_id,
    gross_amount,
    chain,
    protocol_fee_rate_bps
  } = params;
  
  // Generate settlement ID for idempotency
  const settlementId = milestone_id 
    ? `milestone_${milestone_id}_${submission_id}`
    : `task_${task_id}_${submission_id}`;
  
  // Check idempotency
  const alreadySettled = await checkSettlementIdempotency(base44, settlementId);
  if (alreadySettled) {
    return {
      success: true,
      idempotent: true,
      settlement_id: settlementId,
      message: 'Settlement already processed'
    };
  }
  
  // Calculate fees
  const feeRateBps = protocol_fee_rate_bps ?? DEFAULT_PROTOCOL_FEE_RATE_BPS;
  const feeAmount = multiplyBps(gross_amount, feeRateBps);
  const netAmount = subtractDecimal(gross_amount, feeAmount);
  
  // Get accounts
  const payerAccount = await getOrCreateWorkerLedgerAccount(base44, payer_id, chain);
  const workerAccount = await getOrCreateWorkerLedgerAccount(base44, worker_id, chain);
  const protocolAccount = await getProtocolLedgerAccount(base44, chain);
  
  // Debit payer
  await debitAccount(base44, payerAccount, gross_amount);
  
  // Credit worker (net)
  const workerNewBalance = await creditAccount(base44, workerAccount, netAmount);
  
  // Credit protocol (fee)
  const protocolNewBalance = await creditAccount(base44, protocolAccount, feeAmount);
  
  // Create payout ledger entry
  const payoutEntry = await base44.asServiceRole.entities.LedgerEntry.create({
    chain,
    amount: netAmount,
    entry_type: 'payout',
    from_owner_type: 'worker',
    from_owner_id: payer_id,
    to_owner_type: 'worker',
    to_owner_id: worker_id,
    related_task_id: task_id,
    related_submission_id: submission_id,
    metadata: JSON.stringify({
      settlement_id: settlementId,
      milestone_id,
      gross_amount,
      fee_amount: feeAmount,
      fee_rate_bps: feeRateBps
    })
  });
  
  // Create protocol fee accrual entry
  const feeEntry = await base44.asServiceRole.entities.LedgerEntry.create({
    chain,
    amount: feeAmount,
    entry_type: 'protocol_fee_accrual',
    from_owner_type: 'worker',
    from_owner_id: payer_id,
    to_owner_type: 'protocol',
    to_owner_id: null,
    related_task_id: task_id,
    related_submission_id: submission_id,
    metadata: JSON.stringify({
      settlement_id: settlementId,
      milestone_id,
      gross_amount,
      fee_rate_bps: feeRateBps
    })
  });
  
  // Emit protocol_fee_accrued event
  await base44.asServiceRole.entities.Event.create({
    event_type: 'fee_collected',
    entity_type: 'transaction',
    entity_id: feeEntry.id,
    actor_type: 'system',
    actor_id: 'settlement',
    details: JSON.stringify({
      stage: 'protocol_fee_accrued',
      task_id,
      submission_id,
      milestone_id,
      chain,
      gross: gross_amount,
      fee: feeAmount,
      net: netAmount,
      rate_bps: feeRateBps,
      settlement_id: settlementId
    })
  });
  
  // Emit ledger_entry_created events
  await base44.asServiceRole.entities.Event.create({
    event_type: 'funds_transferred',
    entity_type: 'transaction',
    entity_id: payoutEntry.id,
    actor_type: 'system',
    actor_id: 'settlement',
    details: JSON.stringify({
      stage: 'ledger_entry_created',
      entry_type: 'payout',
      settlement_id: settlementId
    })
  });
  
  await base44.asServiceRole.entities.Event.create({
    event_type: 'fee_collected',
    entity_type: 'transaction',
    entity_id: feeEntry.id,
    actor_type: 'system',
    actor_id: 'settlement',
    details: JSON.stringify({
      stage: 'ledger_entry_created',
      entry_type: 'protocol_fee_accrual',
      settlement_id: settlementId
    })
  });
  
  // Also update legacy Worker balances for backward compat
  const workers = await base44.asServiceRole.entities.Worker.filter({ id: worker_id });
  if (workers.length > 0) {
    const worker = workers[0];
    await base44.asServiceRole.entities.Worker.update(worker_id, {
      available_balance_usd: parseFloat(addDecimal(String(worker.available_balance_usd || 0), netAmount)),
      total_earned_usd: parseFloat(addDecimal(String(worker.total_earned_usd || 0), netAmount))
    });
  }
  
  return {
    success: true,
    idempotent: false,
    settlement_id: settlementId,
    gross_amount,
    fee_amount: feeAmount,
    net_amount: netAmount,
    fee_rate_bps: feeRateBps,
    worker_new_balance: workerNewBalance,
    protocol_new_balance: protocolNewBalance
  };
}

async function lockStake(base44, params) {
  const { worker_id, task_id, milestone_id, amount, chain } = params;
  
  const account = await getOrCreateWorkerLedgerAccount(base44, worker_id, chain);
  
  const newAvailable = subtractDecimal(account.available_balance || '0', amount);
  const newLocked = addDecimal(account.locked_balance || '0', amount);
  
  await base44.asServiceRole.entities.LedgerAccount.update(account.id, {
    available_balance: newAvailable,
    locked_balance: newLocked
  });
  
  await base44.asServiceRole.entities.LedgerEntry.create({
    chain,
    amount,
    entry_type: 'lock',
    from_owner_type: 'worker',
    from_owner_id: worker_id,
    to_owner_type: 'worker',
    to_owner_id: worker_id,
    related_task_id: task_id,
    metadata: JSON.stringify({ milestone_id, action: 'stake_lock' })
  });
  
  return { success: true, new_available: newAvailable, new_locked: newLocked };
}

async function unlockStake(base44, params) {
  const { worker_id, task_id, milestone_id, amount, chain } = params;
  
  const account = await getOrCreateWorkerLedgerAccount(base44, worker_id, chain);
  
  const newLocked = subtractDecimal(account.locked_balance || '0', amount);
  const newAvailable = addDecimal(account.available_balance || '0', amount);
  
  await base44.asServiceRole.entities.LedgerAccount.update(account.id, {
    available_balance: newAvailable,
    locked_balance: newLocked
  });
  
  await base44.asServiceRole.entities.LedgerEntry.create({
    chain,
    amount,
    entry_type: 'unlock',
    from_owner_type: 'worker',
    from_owner_id: worker_id,
    to_owner_type: 'worker',
    to_owner_id: worker_id,
    related_task_id: task_id,
    metadata: JSON.stringify({ milestone_id, action: 'stake_unlock' })
  });
  
  return { success: true, new_available: newAvailable, new_locked: newLocked };
}

async function slashStake(base44, params) {
  const { worker_id, task_id, milestone_id, amount, chain, slash_percentage = 100 } = params;
  
  const account = await getOrCreateWorkerLedgerAccount(base44, worker_id, chain);
  const protocolAccount = await getProtocolLedgerAccount(base44, chain);
  
  const slashAmount = multiplyBps(amount, slash_percentage * 100);
  const returnAmount = subtractDecimal(amount, slashAmount);
  
  const newLocked = subtractDecimal(account.locked_balance || '0', amount);
  const newAvailable = addDecimal(account.available_balance || '0', returnAmount);
  
  await base44.asServiceRole.entities.LedgerAccount.update(account.id, {
    available_balance: newAvailable,
    locked_balance: newLocked
  });
  
  // Slashed funds go to protocol
  await creditAccount(base44, protocolAccount, slashAmount);
  
  await base44.asServiceRole.entities.LedgerEntry.create({
    chain,
    amount: slashAmount,
    entry_type: 'slash',
    from_owner_type: 'worker',
    from_owner_id: worker_id,
    to_owner_type: 'protocol',
    to_owner_id: null,
    related_task_id: task_id,
    metadata: JSON.stringify({ milestone_id, slash_percentage, return_amount: returnAmount })
  });
  
  return { success: true, slashed: slashAmount, returned: returnAmount };
}

// ============ API HANDLER ============
Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const body = await req.json();
    const { action } = body;
    
    switch (action) {
      case 'settle_task': {
        const result = await settleTaskPayment(base44, body);
        return Response.json(result);
      }
      
      case 'lock_stake': {
        const result = await lockStake(base44, body);
        return Response.json(result);
      }
      
      case 'unlock_stake': {
        const result = await unlockStake(base44, body);
        return Response.json(result);
      }
      
      case 'slash_stake': {
        const result = await slashStake(base44, body);
        return Response.json(result);
      }
      
      // Legacy compatibility
      case 'transfer_payment': {
        const result = await settleTaskPayment(base44, {
          task_id: body.task_id,
          submission_id: body.submission_id || `legacy_${Date.now()}`,
          milestone_id: body.milestone_id,
          payer_id: body.from_worker_id,
          worker_id: body.to_worker_id,
          gross_amount: String(body.amount),
          chain: body.chain || 'ETH',
          protocol_fee_rate_bps: body.protocol_fee ? Math.round((body.protocol_fee / body.amount) * 10000) : undefined
        });
        return Response.json(result);
      }
      
      // Test endpoints for validation
      case 'test_fee_math': {
        const { amount, bps } = body;
        const fee = multiplyBps(amount, bps);
        const net = subtractDecimal(amount, fee);
        return Response.json({ amount, bps, fee, net });
      }
      
      case 'test_idempotency': {
        const { settlement_id } = body;
        const exists = await checkSettlementIdempotency(base44, settlement_id);
        return Response.json({ settlement_id, already_settled: exists });
      }
      
      default:
        return Response.json({ error: 'Unknown action' }, { status: 400 });
    }
  } catch (error) {
    console.error('Settlement error:', error);
    return Response.json({ error: error.message }, { status: 500 });
  }
});