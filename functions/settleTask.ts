import { createClientFromRequest } from 'npm:@base44/sdk@0.8.6';

// Protocol fee in basis points (500 = 5%)
const PROTOCOL_FEE_BPS = parseInt(Deno.env.get('PROTOCOL_FEE_BPS') || '500', 10);

// Withdrawal hold period in milliseconds (1 minute)
const WITHDRAWAL_HOLD_MS = 60 * 1000;

// Tatum config for on-chain treasury transfers
const TATUM_API_KEY = Deno.env.get('TATUM_API_KEY_MAINNET');
const TATUM_TESTNET = Deno.env.get('TATUM_TESTNET') === 'true';
const HOT_WALLET_MNEMONIC_ETH = Deno.env.get('HOT_WALLET_MNEMONIC_ETH');
const HOT_WALLET_MNEMONIC_BTC = Deno.env.get('HOT_WALLET_MNEMONIC_BTC');

// Decimal math helpers
function toScaled(amt) {
  if (!amt) return 0n;
  // Convert to string first
  const str = String(amt).trim();
  if (!str || str === '0') return 0n;
  
  // Check if it looks like already-scaled wei (very large number without decimal)
  // If it's > 1e15 and has no decimal, it's likely wei already
  if (!str.includes('.') && str.length > 15) {
    return BigInt(str);
  }
  
  // Normal decimal parsing
  const [whole, frac = ''] = str.split('.');
  return BigInt((whole || '0') + frac.padEnd(18, '0').slice(0, 18));
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

/**
 * Derive private key from hot wallet mnemonic
 */
async function derivePrivateKey(chain, index = 0) {
  const tatumChain = chain === 'ETH' 
    ? (TATUM_TESTNET ? 'ethereum-sepolia' : 'ethereum')
    : (TATUM_TESTNET ? 'bitcoin-testnet' : 'bitcoin');
  
  const mnemonic = chain === 'ETH' ? HOT_WALLET_MNEMONIC_ETH : HOT_WALLET_MNEMONIC_BTC;
  
  if (!mnemonic) {
    throw new Error(`HOT_WALLET_MNEMONIC_${chain} not configured`);
  }
  
  const response = await fetch(`https://api.tatum.io/v3/${tatumChain}/wallet/priv`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': TATUM_API_KEY
    },
    body: JSON.stringify({ mnemonic, index })
  });
  
  if (!response.ok) {
    const err = await response.json().catch(() => ({}));
    throw new Error(`Failed to derive private key: ${err.message || response.status}`);
  }
  
  const data = await response.json();
  return data.key;
}

/**
 * Transfer protocol fee from hot wallet to treasury address on-chain
 */
async function transferFeeToTreasury(chain, amount, treasuryAddress) {
  console.log(`[transferFeeToTreasury] Transferring ${amount} ${chain} to ${treasuryAddress}`);
  
  const tatumChain = chain === 'ETH' 
    ? (TATUM_TESTNET ? 'ethereum-sepolia' : 'ethereum')
    : (TATUM_TESTNET ? 'bitcoin-testnet' : 'bitcoin');
  
  // Derive private key from hot wallet (index 0)
  const privateKey = await derivePrivateKey(chain, 0);
  
  // Format amount properly
  const formattedAmount = parseFloat(amount).toFixed(12).replace(/\.?0+$/, '');
  
  if (chain === 'ETH') {
    const response = await fetch(`https://api.tatum.io/v3/${tatumChain}/transaction`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': TATUM_API_KEY
      },
      body: JSON.stringify({
        to: treasuryAddress,
        amount: formattedAmount,
        currency: 'ETH',
        fromPrivateKey: privateKey,
        fee: {
          gasLimit: '21000',
          gasPrice: '50000000000' // 50 Gwei in Wei
        }
      })
    });
    
    const responseText = await response.text();
    console.log(`[transferFeeToTreasury] Tatum response: ${response.status} ${responseText}`);
    
    if (!response.ok) {
      throw new Error(`Tatum ETH transfer failed: ${response.status} - ${responseText}`);
    }
    
    const data = JSON.parse(responseText);
    return { txHash: data.txId || data.txHash };
  } else {
    // BTC transfer
    const response = await fetch(`https://api.tatum.io/v3/${tatumChain}/transaction`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': TATUM_API_KEY
      },
      body: JSON.stringify({
        fromAddress: [{ privateKey }],
        to: [{ address: treasuryAddress, value: parseFloat(formattedAmount) }]
      })
    });
    
    if (!response.ok) {
      const err = await response.json().catch(() => ({}));
      throw new Error(`Tatum BTC transfer failed: ${err.message || response.status}`);
    }
    
    const data = await response.json();
    return { txHash: data.txId || data.txHash };
  }
}

async function getOrCreateLedgerAccount(base44, ownerType, ownerId, chain) {
  // Build filter - for workers, we MUST include owner_id to get the right account
  const filter = { owner_type: ownerType, chain };
  if (ownerType === 'worker' && ownerId) {
    filter.owner_id = ownerId;
  }
  // Protocol accounts: owner_type='protocol' and chain is sufficient
  
  console.log(`[getOrCreateLedgerAccount] Querying with filter:`, JSON.stringify(filter));
  const accounts = await base44.asServiceRole.entities.LedgerAccount.filter(filter);
  console.log(`[getOrCreateLedgerAccount] Found ${accounts.length} accounts`);
  
  if (accounts.length > 0) {
    console.log(`[getOrCreateLedgerAccount] Returning existing account: id=${accounts[0].id}, available=${accounts[0].available_balance}, locked=${accounts[0].locked_balance}`);
    return accounts[0];
  }
  
  // Create new account if doesn't exist
  console.log(`[settleTask] Creating new LedgerAccount: ownerType=${ownerType}, ownerId=${ownerId}, chain=${chain}`);
  const newAccount = await base44.asServiceRole.entities.LedgerAccount.create({
    owner_type: ownerType,
    owner_id: ownerId || null,
    chain,
    available_balance: '0',
    locked_balance: '0'
  });
  console.log(`[getOrCreateLedgerAccount] Created new account: id=${newAccount.id}`);
  return newAccount;
}

// Settle a completed task: pay worker from escrow, take protocol fee
async function settleTask(base44, taskId, submissionId = null) {
  console.log(`[settleTask] Starting settlement for task ${taskId}`);
  
  // Get task
  const tasks = await base44.asServiceRole.entities.Task.filter({ id: taskId });
  if (!tasks || tasks.length === 0) {
    console.log(`[settleTask] Task not found: ${taskId}`);
    return { error: 'Task not found' };
  }
  
  const task = tasks[0];
  console.log(`[settleTask] Task found: status=${task.status}, escrow_status=${task.escrow_status}, escrow_amount=${task.escrow_amount}, claimed_by=${task.claimed_by}`);
  
  // Idempotency: check if already settled
  if (task.escrow_status === 'released') {
    console.log(`[settleTask] Already settled: ${taskId}`);
    return { already_settled: true, task_id: taskId };
  }
  
  // Must have escrow to settle
  if (!task.escrow_amount || task.escrow_status !== 'locked') {
    console.log(`[settleTask] No escrow to settle: escrow_amount=${task.escrow_amount}, escrow_status=${task.escrow_status}`);
    return { error: 'No escrow to settle', escrow_status: task.escrow_status };
  }
  
  // Must have a solver (claimed_by)
  if (!task.claimed_by) {
    console.log(`[settleTask] No claimed_by worker for task ${taskId}`);
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
  console.log(`[settleTask] Getting/creating creator account: creatorId=${creatorId}, chain=${chain}`);
  const creatorAccount = await getOrCreateLedgerAccount(base44, 'worker', creatorId, chain);
  console.log(`[settleTask] Creator account: id=${creatorAccount.id}, locked_balance=${creatorAccount.locked_balance}`);
  
  const newCreatorLocked = subtractDecimal(creatorAccount.locked_balance || '0', escrowAmount);
  await base44.asServiceRole.entities.LedgerAccount.update(creatorAccount.id, {
    locked_balance: newCreatorLocked
  });
  console.log(`[settleTask] Updated creator locked_balance: ${creatorAccount.locked_balance} -> ${newCreatorLocked}`);
  
  // 2. Credit solver's balance - initially LOCKED with withdrawal hold until fee transfer completes
  console.log(`[settleTask] Getting/creating solver account: solverId=${solverId}, chain=${chain}`);
  const solverAccount = await getOrCreateLedgerAccount(base44, 'worker', solverId, chain);
  console.log(`[settleTask] Solver account: id=${solverAccount.id}, available_balance=${solverAccount.available_balance}, locked_balance=${solverAccount.locked_balance}`);
  
  // Initially put funds in LOCKED balance - will be released after fee transfer + hold period
  const newSolverLocked = addDecimal(solverAccount.locked_balance || '0', payoutAmount);
  await base44.asServiceRole.entities.LedgerAccount.update(solverAccount.id, {
    locked_balance: newSolverLocked
  });
  console.log(`[settleTask] Credited solver locked_balance: ${solverAccount.locked_balance} -> ${newSolverLocked} (payout: ${payoutAmount}, will release after fee transfer)`);
  
  // 3. Transfer 5% protocol fee to treasury wallet on-chain
  let feeTransferSuccess = false;
  let feeTxHash = null;
  
  if (toScaled(feeAmount) > 0n) {
    console.log(`[settleTask] Transferring 5% protocol fee to treasury: ${feeAmount} ${chain}`);
    
    // Get treasury address from ProtocolConfig
    const configs = await base44.asServiceRole.entities.ProtocolConfig.filter({
      config_key: 'treasury_addresses'
    });
    
    const treasuryAddress = configs.length > 0 
      ? (chain === 'ETH' ? configs[0].eth_treasury_address : configs[0].btc_treasury_address)
      : null;
    
    if (treasuryAddress && TATUM_API_KEY) {
      // Transfer fee directly to treasury on-chain
      try {
        const transferResult = await transferFeeToTreasury(chain, feeAmount, treasuryAddress);
        console.log(`[settleTask] Treasury transfer result:`, JSON.stringify(transferResult));
        
        if (transferResult.txHash) {
          feeTransferSuccess = true;
          feeTxHash = transferResult.txHash;
          
          // Log the on-chain transfer
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
              gross_amount: escrowAmount,
              treasury_address: treasuryAddress,
              tx_hash: transferResult.txHash,
              transferred_on_chain: true
            })
          });
          
          await logEvent(base44, 'fee_collected', 'task', taskId, 'system', 'settlement', {
            chain,
            amount: feeAmount,
            treasury_address: treasuryAddress,
            tx_hash: transferResult.txHash,
            transferred_on_chain: true
          });
        }
      } catch (transferErr) {
        console.error(`[settleTask] Treasury transfer failed:`, transferErr.message);
        // Fall back to ledger-only tracking if on-chain transfer fails
        const protocolAccount = await getOrCreateLedgerAccount(base44, 'protocol', null, chain);
        const newProtocolBalance = addDecimal(protocolAccount.available_balance || '0', feeAmount);
        await base44.asServiceRole.entities.LedgerAccount.update(protocolAccount.id, {
          available_balance: newProtocolBalance
        });
        console.log(`[settleTask] Fell back to ledger accrual: ${newProtocolBalance}`);
        feeTransferSuccess = true; // Still consider it successful for the hold period
      }
    } else {
      // No treasury configured - just track in ledger
      console.log(`[settleTask] No treasury configured, tracking in ledger only`);
      const protocolAccount = await getOrCreateLedgerAccount(base44, 'protocol', null, chain);
      const newProtocolBalance = addDecimal(protocolAccount.available_balance || '0', feeAmount);
      await base44.asServiceRole.entities.LedgerAccount.update(protocolAccount.id, {
        available_balance: newProtocolBalance
      });
      feeTransferSuccess = true;
    }
  } else {
    console.log(`[settleTask] No protocol fee to accrue (feeAmount=${feeAmount})`);
    feeTransferSuccess = true; // No fee needed, proceed with release
  }
  
  // 3.5. Wait 1 minute hold period before releasing solver's funds
  const withdrawalUnlocksAt = new Date(Date.now() + WITHDRAWAL_HOLD_MS).toISOString();
  console.log(`[settleTask] Starting 1 minute hold period. Solver funds will unlock at: ${withdrawalUnlocksAt}`);
  
  // Store the unlock time on the task for tracking
  await base44.asServiceRole.entities.Task.update(taskId, {
    status: 'completed',
    escrow_status: 'released',
    completed_at: new Date().toISOString()
  });
  
  // Wait for the hold period
  await new Promise(resolve => setTimeout(resolve, WITHDRAWAL_HOLD_MS));
  
  console.log(`[settleTask] Hold period complete. Releasing solver funds from locked to available.`);
  
  // 3.6. Release solver's funds from locked to available after hold period
  const solverAccountAfterHold = await getOrCreateLedgerAccount(base44, 'worker', solverId, chain);
  const finalSolverLocked = subtractDecimal(solverAccountAfterHold.locked_balance || '0', payoutAmount);
  const finalSolverAvailable = addDecimal(solverAccountAfterHold.available_balance || '0', payoutAmount);
  
  await base44.asServiceRole.entities.LedgerAccount.update(solverAccountAfterHold.id, {
    locked_balance: finalSolverLocked,
    available_balance: finalSolverAvailable
  });
  
  console.log(`[settleTask] Solver funds released: locked=${solverAccountAfterHold.locked_balance}->${finalSolverLocked}, available=${solverAccountAfterHold.available_balance}->${finalSolverAvailable}`);
  
  await logEvent(base44, 'funds_unlocked', 'task', taskId, 'system', 'settlement', {
    chain,
    solver_id: solverId,
    amount: payoutAmount,
    hold_period_ms: WITHDRAWAL_HOLD_MS,
    fee_tx_hash: feeTxHash
  });
  
  // 4. Task status already updated above before hold period
  
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
  
  // Protocol fee entry is now created in step 3 when transferring to treasury
  
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
    solver_id: solverId,
    fee_tx_hash: feeTxHash,
    hold_period_ms: WITHDRAWAL_HOLD_MS,
    withdrawal_enabled: true
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