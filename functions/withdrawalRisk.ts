import { createClientFromRequest } from 'npm:@base44/sdk@0.8.6';

// Per-chain configuration defaults
const CHAIN_CONFIG = {
  ETH: {
    AUTO_WITHDRAW_MAX: Deno.env.get('AUTO_WITHDRAW_MAX_AMOUNT_ETH') || '0.02',
    DAILY_MAX: Deno.env.get('AUTO_WITHDRAW_DAILY_MAX_ETH') || '0.05',
    MIN_AMOUNT: Deno.env.get('MIN_WITHDRAW_AMOUNT_ETH') || '0.001',
    CONFIRMATIONS: parseInt(Deno.env.get('CONFIRMATIONS_ETH') || '12', 10),
    // Circuit breaker
    DISABLED: Deno.env.get('DISABLE_WITHDRAWALS_ETH') === 'true',
    // Hot wallet outflow limits
    HOT_WALLET_MAX_PER_HOUR: Deno.env.get('MAX_HOT_WALLET_OUTFLOW_PER_HOUR_ETH') || '0.5',
    HOT_WALLET_MAX_PER_DAY: Deno.env.get('MAX_HOT_WALLET_OUTFLOW_PER_DAY_ETH') || '2.0',
    // Velocity limits
    MAX_WITHDRAWALS_PER_HOUR: parseInt(Deno.env.get('MAX_WITHDRAWALS_PER_HOUR_ETH') || '5', 10),
    MAX_WITHDRAWALS_PER_DAY: parseInt(Deno.env.get('MAX_WITHDRAWALS_PER_DAY_ETH') || '20', 10),
    // Per-destination limits
    DEST_MAX_PER_DAY: Deno.env.get('DEST_MAX_PER_DAY_ETH') || '0.1'
  },
  BTC: {
    AUTO_WITHDRAW_MAX: Deno.env.get('AUTO_WITHDRAW_MAX_AMOUNT_BTC') || '0.0005',
    DAILY_MAX: Deno.env.get('AUTO_WITHDRAW_DAILY_MAX_BTC') || '0.001',
    MIN_AMOUNT: Deno.env.get('MIN_WITHDRAW_AMOUNT_BTC') || '0.0001',
    CONFIRMATIONS: parseInt(Deno.env.get('CONFIRMATIONS_BTC') || '3', 10),
    // Circuit breaker
    DISABLED: Deno.env.get('DISABLE_WITHDRAWALS_BTC') === 'true',
    // Hot wallet outflow limits
    HOT_WALLET_MAX_PER_HOUR: Deno.env.get('MAX_HOT_WALLET_OUTFLOW_PER_HOUR_BTC') || '0.01',
    HOT_WALLET_MAX_PER_DAY: Deno.env.get('MAX_HOT_WALLET_OUTFLOW_PER_DAY_BTC') || '0.05',
    // Velocity limits
    MAX_WITHDRAWALS_PER_HOUR: parseInt(Deno.env.get('MAX_WITHDRAWALS_PER_HOUR_BTC') || '5', 10),
    MAX_WITHDRAWALS_PER_DAY: parseInt(Deno.env.get('MAX_WITHDRAWALS_PER_DAY_BTC') || '20', 10),
    // Per-destination limits
    DEST_MAX_PER_DAY: Deno.env.get('DEST_MAX_PER_DAY_BTC') || '0.005'
  }
};

const REQUIRED_WORKER_REPUTATION = parseInt(Deno.env.get('REQUIRED_WORKER_REPUTATION') || '10', 10);
const REQUIRED_ACCOUNT_AGE_HOURS = parseInt(Deno.env.get('REQUIRED_ACCOUNT_AGE_HOURS') || '24', 10);

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

function compareDecimal(a, b) {
  const scaledA = toScaled(a);
  const scaledB = toScaled(b);
  if (scaledA > scaledB) return 1;
  if (scaledA < scaledB) return -1;
  return 0;
}

function addDecimal(a, b) {
  return fromScaled(toScaled(a) + toScaled(b));
}

function subtractDecimal(a, b) {
  const result = toScaled(a) - toScaled(b);
  return fromScaled(result < 0n ? 0n : result);
}

/**
 * Get hot wallet outflow stats for a chain
 */
async function getHotWalletOutflow(base44, chain) {
  const now = new Date();
  const oneHourAgo = new Date(now.getTime() - 60 * 60 * 1000);
  const oneDayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);

  // Get all withdrawals in the last 24h that were broadcasted or confirmed
  const withdrawals = await base44.asServiceRole.entities.WithdrawalRequest.filter({ chain });
  
  let hourlyOutflow = '0';
  let dailyOutflow = '0';
  let hourlyCount = 0;
  let dailyCount = 0;

  for (const w of withdrawals) {
    const createdAt = new Date(w.created_date);
    if (['approved', 'broadcasted', 'confirmed'].includes(w.status)) {
      if (createdAt >= oneDayAgo) {
        dailyOutflow = addDecimal(dailyOutflow, w.amount);
        dailyCount++;
        if (createdAt >= oneHourAgo) {
          hourlyOutflow = addDecimal(hourlyOutflow, w.amount);
          hourlyCount++;
        }
      }
    }
  }

  return { hourlyOutflow, dailyOutflow, hourlyCount, dailyCount };
}

/**
 * Get per-destination address outflow for today
 */
async function getDestinationOutflow(base44, chain, destinationAddress) {
  const now = new Date();
  const oneDayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);

  const withdrawals = await base44.asServiceRole.entities.WithdrawalRequest.filter({
    chain,
    destination_address: destinationAddress
  });

  let dailyTotal = '0';
  for (const w of withdrawals) {
    if (new Date(w.created_date) >= oneDayAgo && 
        ['requested', 'approved', 'broadcasted', 'confirmed'].includes(w.status)) {
      dailyTotal = addDecimal(dailyTotal, w.amount);
    }
  }

  return dailyTotal;
}

/**
 * Get worker velocity stats
 */
async function getWorkerVelocity(base44, workerId, chain) {
  const now = new Date();
  const oneHourAgo = new Date(now.getTime() - 60 * 60 * 1000);
  const oneDayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);

  const withdrawals = await base44.asServiceRole.entities.WithdrawalRequest.filter({
    worker_id: workerId,
    chain
  });

  let hourlyCount = 0;
  let dailyCount = 0;
  let dailyAmount = '0';

  for (const w of withdrawals) {
    const createdAt = new Date(w.created_date);
    if (['requested', 'risk_hold', 'approved', 'broadcasted', 'confirmed'].includes(w.status)) {
      if (createdAt >= oneDayAgo) {
        dailyCount++;
        dailyAmount = addDecimal(dailyAmount, w.amount);
        if (createdAt >= oneHourAgo) {
          hourlyCount++;
        }
      }
    }
  }

  return { hourlyCount, dailyCount, dailyAmount };
}

/**
 * Compute risk score and reasons for a withdrawal request
 */
async function computeRiskScore(base44, worker, withdrawal, payoutAddress) {
  const reasons = [];
  let score = 0;
  const chain = withdrawal.chain;
  const config = CHAIN_CONFIG[chain];
  const now = new Date();

  // 1. Account age check
  const accountCreated = new Date(worker.created_date);
  const accountAgeHours = (now.getTime() - accountCreated.getTime()) / (1000 * 60 * 60);
  if (accountAgeHours < REQUIRED_ACCOUNT_AGE_HOURS) {
    score += 30;
    reasons.push({
      code: 'ACCOUNT_TOO_NEW',
      message: `Account age ${Math.round(accountAgeHours)}h < required ${REQUIRED_ACCOUNT_AGE_HOURS}h`
    });
  }

  // 2. Reputation check
  const reputation = worker.reputation_score || 0;
  if (reputation < REQUIRED_WORKER_REPUTATION) {
    score += 25;
    reasons.push({
      code: 'LOW_REPUTATION',
      message: `Reputation ${reputation} < required ${REQUIRED_WORKER_REPUTATION}`
    });
  }

  // 3. Payout address is new and not verified
  if (payoutAddress) {
    const addressCreated = new Date(payoutAddress.created_date);
    const addressAgeHours = (now.getTime() - addressCreated.getTime()) / (1000 * 60 * 60);
    if (addressAgeHours < 24 && !payoutAddress.is_verified) {
      score += 20;
      reasons.push({
        code: 'NEW_UNVERIFIED_ADDRESS',
        message: `Payout address added ${Math.round(addressAgeHours)}h ago and not verified`
      });
    }
  }

  // 4. Worker velocity limits
  const velocity = await getWorkerVelocity(base44, worker.id, chain);
  
  if (velocity.hourlyCount >= config.MAX_WITHDRAWALS_PER_HOUR) {
    score += 40;
    reasons.push({
      code: 'WORKER_HOURLY_LIMIT',
      message: `Worker hourly withdrawals ${velocity.hourlyCount} >= limit ${config.MAX_WITHDRAWALS_PER_HOUR}`
    });
  }

  if (velocity.dailyCount >= config.MAX_WITHDRAWALS_PER_DAY) {
    score += 50;
    reasons.push({
      code: 'WORKER_DAILY_COUNT_LIMIT',
      message: `Worker daily withdrawals ${velocity.dailyCount} >= limit ${config.MAX_WITHDRAWALS_PER_DAY}`
    });
  }

  // 5. Worker daily amount limit
  const projectedDaily = addDecimal(velocity.dailyAmount, withdrawal.amount);
  if (compareDecimal(projectedDaily, config.DAILY_MAX) > 0) {
    score += 35;
    reasons.push({
      code: 'DAILY_LIMIT_EXCEEDED',
      message: `Daily total ${projectedDaily} exceeds limit ${config.DAILY_MAX} ${chain}`
    });
  }

  // 6. Per-destination address daily limit
  const destOutflow = await getDestinationOutflow(base44, chain, withdrawal.destination_address);
  const projectedDestDaily = addDecimal(destOutflow, withdrawal.amount);
  if (compareDecimal(projectedDestDaily, config.DEST_MAX_PER_DAY) > 0) {
    score += 30;
    reasons.push({
      code: 'DEST_DAILY_LIMIT_EXCEEDED',
      message: `Destination daily total ${projectedDestDaily} exceeds limit ${config.DEST_MAX_PER_DAY} ${chain}`
    });
  }

  // 7. Amount exceeds auto-approval max
  if (compareDecimal(withdrawal.amount, config.AUTO_WITHDRAW_MAX) > 0) {
    score += 15;
    reasons.push({
      code: 'AMOUNT_EXCEEDS_AUTO_MAX',
      message: `Amount ${withdrawal.amount} exceeds auto-approval max ${config.AUTO_WITHDRAW_MAX} ${chain}`
    });
  }

  // 8. Worker suspended/flagged
  if (worker.status === 'suspended' || worker.status === 'revoked') {
    score += 100;
    reasons.push({
      code: 'WORKER_SUSPENDED',
      message: `Worker status is ${worker.status}`
    });
  }

  // 9. Too many failed withdrawals recently
  const recentWithdrawals = await base44.asServiceRole.entities.WithdrawalRequest.filter({
    worker_id: worker.id,
    chain
  });
  const oneDayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const failedRecent = recentWithdrawals.filter(w => 
    new Date(w.created_date) >= oneDayAgo && 
    ['rejected', 'failed'].includes(w.status)
  ).length;
  
  if (failedRecent >= 3) {
    score += 25;
    reasons.push({
      code: 'RECENT_FAILURES',
      message: `${failedRecent} failed withdrawals in last 24h`
    });
  }

  return { score: Math.min(score, 100), reasons };
}

/**
 * Determine if withdrawal can be auto-approved
 */
function canAutoApprove(riskScore, reasons, chain, amount) {
  const config = CHAIN_CONFIG[chain];
  
  // Must have zero risk score for auto-approval
  if (riskScore > 0) return false;
  
  // Amount must be within auto-approval limit
  if (compareDecimal(amount, config.AUTO_WITHDRAW_MAX) > 0) return false;
  
  return true;
}

/**
 * Process withdrawal request with risk assessment
 */
async function processWithdrawalRequest(base44, withdrawalId) {
  console.log(`[withdrawalRisk] Processing withdrawal ${withdrawalId}`);
  
  const withdrawals = await base44.asServiceRole.entities.WithdrawalRequest.filter({
    id: withdrawalId
  });
  
  if (withdrawals.length === 0) {
    console.log(`[withdrawalRisk] Withdrawal not found: ${withdrawalId}`);
    throw new Error('Withdrawal not found');
  }
  
  const withdrawal = withdrawals[0];
  console.log(`[withdrawalRisk] Withdrawal found:`, JSON.stringify({
    id: withdrawal.id,
    status: withdrawal.status,
    chain: withdrawal.chain,
    amount: withdrawal.amount,
    destination: withdrawal.destination_address
  }));
  
  if (withdrawal.status !== 'requested') {
    console.log(`[withdrawalRisk] Already processed: status=${withdrawal.status}`);
    return { 
      withdrawal_id: withdrawalId, 
      status: withdrawal.status, 
      message: 'Withdrawal already processed' 
    };
  }
  
  const workers = await base44.asServiceRole.entities.Worker.filter({
    id: withdrawal.worker_id
  });
  
  if (workers.length === 0) {
    console.log(`[withdrawalRisk] Worker not found: ${withdrawal.worker_id}`);
    throw new Error('Worker not found');
  }
  
  const worker = workers[0];
  console.log(`[withdrawalRisk] Worker:`, JSON.stringify({
    id: worker.id,
    name: worker.name,
    reputation: worker.reputation_score,
    status: worker.status,
    created_date: worker.created_date
  }));
  
  const chain = withdrawal.chain;
  const config = CHAIN_CONFIG[chain];
  console.log(`[withdrawalRisk] Chain config for ${chain}:`, JSON.stringify(config));

  // ========== CIRCUIT BREAKER CHECK ==========
  if (config.DISABLED) {
    await base44.asServiceRole.entities.WithdrawalRequest.update(withdrawalId, {
      status: 'risk_hold',
      risk_score: 100,
      risk_reasons: JSON.stringify([{ code: 'CIRCUIT_BREAKER', message: `${chain} withdrawals disabled` }])
    });

    await base44.asServiceRole.entities.Event.create({
      event_type: 'withdrawal_circuit_breaker_triggered',
      entity_type: 'withdrawal',
      entity_id: withdrawalId,
      actor_type: 'system',
      actor_id: 'risk_engine',
      details: JSON.stringify({
        chain,
        worker_id: worker.id,
        amount: withdrawal.amount,
        reason: 'global_circuit_breaker'
      })
    });

    return {
      withdrawal_id: withdrawalId,
      status: 'risk_hold',
      risk_score: 100,
      risk_reasons: [{ code: 'CIRCUIT_BREAKER', message: `${chain} withdrawals disabled` }]
    };
  }

  // ========== HOT WALLET OUTFLOW LIMITS ==========
  const hotWalletStats = await getHotWalletOutflow(base44, chain);
  
  const projectedHourly = addDecimal(hotWalletStats.hourlyOutflow, withdrawal.amount);
  const projectedDaily = addDecimal(hotWalletStats.dailyOutflow, withdrawal.amount);

  const hourlyExceeded = compareDecimal(projectedHourly, config.HOT_WALLET_MAX_PER_HOUR) > 0;
  const dailyExceeded = compareDecimal(projectedDaily, config.HOT_WALLET_MAX_PER_DAY) > 0;

  if (hourlyExceeded || dailyExceeded) {
    const limitReasons = [];
    if (hourlyExceeded) {
      limitReasons.push({
        code: 'HOT_WALLET_HOURLY_LIMIT',
        message: `Hourly outflow ${projectedHourly} exceeds ${config.HOT_WALLET_MAX_PER_HOUR} ${chain}`
      });
    }
    if (dailyExceeded) {
      limitReasons.push({
        code: 'HOT_WALLET_DAILY_LIMIT',
        message: `Daily outflow ${projectedDaily} exceeds ${config.HOT_WALLET_MAX_PER_DAY} ${chain}`
      });
    }

    await base44.asServiceRole.entities.WithdrawalRequest.update(withdrawalId, {
      status: 'risk_hold',
      risk_score: 100,
      risk_reasons: JSON.stringify(limitReasons)
    });

    await base44.asServiceRole.entities.Event.create({
      event_type: 'hot_wallet_limit_reached',
      entity_type: 'withdrawal',
      entity_id: withdrawalId,
      actor_type: 'system',
      actor_id: 'risk_engine',
      details: JSON.stringify({
        chain,
        worker_id: worker.id,
        amount: withdrawal.amount,
        hourly_outflow: hotWalletStats.hourlyOutflow,
        daily_outflow: hotWalletStats.dailyOutflow,
        hourly_limit: config.HOT_WALLET_MAX_PER_HOUR,
        daily_limit: config.HOT_WALLET_MAX_PER_DAY,
        hourly_exceeded: hourlyExceeded,
        daily_exceeded: dailyExceeded
      })
    });

    return {
      withdrawal_id: withdrawalId,
      status: 'risk_hold',
      risk_score: 100,
      risk_reasons: limitReasons
    };
  }

  // ========== VALIDATE MINIMUM AMOUNT ==========
  if (compareDecimal(withdrawal.amount, config.MIN_AMOUNT) < 0) {
    const rejectionReason = `Amount ${withdrawal.amount} ${chain} below minimum ${config.MIN_AMOUNT} ${chain}`;
    console.log(`[withdrawalRisk] REJECTED - ${rejectionReason}`);
    
    await base44.asServiceRole.entities.WithdrawalRequest.update(withdrawalId, {
      status: 'rejected',
      failure_reason: rejectionReason
    });
    
    await unlockWithdrawalFunds(base44, withdrawal);
    
    await base44.asServiceRole.entities.Event.create({
      event_type: 'withdrawal_requested',
      entity_type: 'worker',
      entity_id: worker.id,
      actor_type: 'system',
      actor_id: 'risk_engine',
      details: JSON.stringify({
        withdrawal_id: withdrawalId,
        status: 'rejected',
        reason: 'below_minimum',
        amount: withdrawal.amount,
        min_amount: config.MIN_AMOUNT,
        chain
      })
    });
    
    return {
      withdrawal_id: withdrawalId,
      status: 'rejected',
      rejection_reason: rejectionReason,
      amount: withdrawal.amount,
      min_amount: config.MIN_AMOUNT,
      chain
    };
  }
  
  // Get payout address
  const payoutAddresses = await base44.asServiceRole.entities.WorkerPayoutAddress.filter({
    worker_id: worker.id,
    chain,
    address: withdrawal.destination_address
  });
  
  const payoutAddress = payoutAddresses.length > 0 ? payoutAddresses[0] : null;
  
  // Compute risk score
  const { score, reasons } = await computeRiskScore(base44, worker, withdrawal, payoutAddress);
  
  console.log(`[withdrawalRisk] Risk assessment result:`, JSON.stringify({
    withdrawal_id: withdrawalId,
    risk_score: score,
    risk_reasons: reasons,
    auto_withdraw_max: config.AUTO_WITHDRAW_MAX,
    amount: withdrawal.amount,
    can_auto_approve_check: {
      score_is_zero: score === 0,
      amount_within_limit: compareDecimal(withdrawal.amount, config.AUTO_WITHDRAW_MAX) <= 0
    }
  }));
  
  // Update withdrawal with risk info
  await base44.asServiceRole.entities.WithdrawalRequest.update(withdrawalId, {
    risk_score: score,
    risk_reasons: JSON.stringify(reasons)
  });
  
  // Check auto-approval eligibility
  if (canAutoApprove(score, reasons, chain, withdrawal.amount)) {
    await base44.asServiceRole.entities.WithdrawalRequest.update(withdrawalId, {
      status: 'approved'
    });
    
    await base44.asServiceRole.entities.Event.create({
      event_type: 'withdrawal_requested',
      entity_type: 'worker',
      entity_id: worker.id,
      actor_type: 'system',
      actor_id: 'risk_engine',
      details: JSON.stringify({
        withdrawal_id: withdrawalId,
        status: 'auto_approved',
        risk_score: score,
        chain,
        amount: withdrawal.amount,
        destination_address: withdrawal.destination_address
      })
    });
    
    try {
      await base44.asServiceRole.functions.invoke('broadcastWithdrawal', {
        withdrawal_id: withdrawalId
      });
    } catch (err) {
      console.error('Failed to enqueue broadcast:', err);
    }
    
    return {
      withdrawal_id: withdrawalId,
      status: 'approved',
      risk_score: score,
      auto_approved: true
    };
  } else {
    await base44.asServiceRole.entities.WithdrawalRequest.update(withdrawalId, {
      status: 'risk_hold'
    });
    
    await base44.asServiceRole.entities.Event.create({
      event_type: 'withdrawal_requested',
      entity_type: 'worker',
      entity_id: worker.id,
      actor_type: 'system',
      actor_id: 'risk_engine',
      details: JSON.stringify({
        withdrawal_id: withdrawalId,
        status: 'risk_hold',
        risk_score: score,
        risk_reasons: reasons,
        chain,
        amount: withdrawal.amount,
        destination_address: withdrawal.destination_address
      })
    });
    
    return {
      withdrawal_id: withdrawalId,
      status: 'risk_hold',
      risk_score: score,
      risk_reasons: reasons
    };
  }
}

/**
 * Unlock funds when withdrawal is rejected/cancelled
 */
async function unlockWithdrawalFunds(base44, withdrawal) {
  const accounts = await base44.asServiceRole.entities.LedgerAccount.filter({
    owner_type: 'worker',
    owner_id: withdrawal.worker_id,
    chain: withdrawal.chain
  });
  
  if (accounts.length === 0) return;
  
  const account = accounts[0];
  const newAvailable = addDecimal(account.available_balance || '0', withdrawal.amount);
  const newLocked = subtractDecimal(account.locked_balance || '0', withdrawal.amount);
  
  await base44.asServiceRole.entities.LedgerAccount.update(account.id, {
    available_balance: newAvailable,
    locked_balance: newLocked
  });
  
  await base44.asServiceRole.entities.LedgerEntry.create({
    chain: withdrawal.chain,
    amount: withdrawal.amount,
    entry_type: 'unlock',
    from_owner_type: 'worker',
    from_owner_id: withdrawal.worker_id,
    to_owner_type: 'worker',
    to_owner_id: withdrawal.worker_id,
    metadata: JSON.stringify({
      withdrawal_id: withdrawal.id,
      action: 'withdrawal_rejected_unlock'
    })
  });
}

/**
 * Get outflow stats for admin dashboard
 */
async function getOutflowStats(base44) {
  const ethStats = await getHotWalletOutflow(base44, 'ETH');
  const btcStats = await getHotWalletOutflow(base44, 'BTC');

  return {
    ETH: {
      hourly_outflow: ethStats.hourlyOutflow,
      daily_outflow: ethStats.dailyOutflow,
      hourly_count: ethStats.hourlyCount,
      daily_count: ethStats.dailyCount,
      hourly_limit: CHAIN_CONFIG.ETH.HOT_WALLET_MAX_PER_HOUR,
      daily_limit: CHAIN_CONFIG.ETH.HOT_WALLET_MAX_PER_DAY,
      circuit_breaker_active: CHAIN_CONFIG.ETH.DISABLED
    },
    BTC: {
      hourly_outflow: btcStats.hourlyOutflow,
      daily_outflow: btcStats.dailyOutflow,
      hourly_count: btcStats.hourlyCount,
      daily_count: btcStats.dailyCount,
      hourly_limit: CHAIN_CONFIG.BTC.HOT_WALLET_MAX_PER_HOUR,
      daily_limit: CHAIN_CONFIG.BTC.HOT_WALLET_MAX_PER_DAY,
      circuit_breaker_active: CHAIN_CONFIG.BTC.DISABLED
    }
  };
}

Deno.serve(async (req) => {
  if (req.method !== 'POST') {
    return Response.json({ error: 'Method not allowed' }, { status: 405 });
  }

  try {
    const base44 = createClientFromRequest(req);
    const body = await req.json();
    const { action } = body;

    // Get config (public, no auth required)
    if (action === 'get_config') {
      return Response.json({
        ETH: {
          ...CHAIN_CONFIG.ETH,
          circuit_breaker_active: CHAIN_CONFIG.ETH.DISABLED
        },
        BTC: {
          ...CHAIN_CONFIG.BTC,
          circuit_breaker_active: CHAIN_CONFIG.BTC.DISABLED
        },
        REQUIRED_WORKER_REPUTATION,
        REQUIRED_ACCOUNT_AGE_HOURS
      });
    }

    // Get outflow stats (admin only)
    if (action === 'get_outflow_stats') {
      const user = await base44.auth.me();
      if (!user || user.role !== 'admin') {
        return Response.json({ error: 'Admin access required' }, { status: 403 });
      }

      const stats = await getOutflowStats(base44);
      return Response.json(stats);
    }

    // Process withdrawal (called internally or by admin)
    if (action === 'process_withdrawal') {
      const { withdrawal_id } = body;
      if (!withdrawal_id) {
        return Response.json({ error: 'withdrawal_id required' }, { status: 400 });
      }

      const result = await processWithdrawalRequest(base44, withdrawal_id);
      return Response.json(result);
    }

    // Admin: manually approve/reject withdrawal
    if (action === 'admin_review') {
      const user = await base44.auth.me();
      if (!user || user.role !== 'admin') {
        return Response.json({ error: 'Admin access required' }, { status: 403 });
      }

      const { withdrawal_id, decision, reason } = body;
      if (!withdrawal_id || !decision) {
        return Response.json({ error: 'withdrawal_id and decision required' }, { status: 400 });
      }

      const withdrawals = await base44.asServiceRole.entities.WithdrawalRequest.filter({
        id: withdrawal_id
      });

      if (withdrawals.length === 0) {
        return Response.json({ error: 'Withdrawal not found' }, { status: 404 });
      }

      const withdrawal = withdrawals[0];

      if (!['requested', 'risk_hold'].includes(withdrawal.status)) {
        return Response.json({ error: 'Withdrawal not in reviewable state' }, { status: 400 });
      }

      if (decision === 'approve') {
        await base44.asServiceRole.entities.WithdrawalRequest.update(withdrawal_id, {
          status: 'approved'
        });

        await base44.asServiceRole.entities.Event.create({
          event_type: 'withdrawal_requested',
          entity_type: 'worker',
          entity_id: withdrawal.worker_id,
          actor_type: 'admin',
          actor_id: user.id,
          details: JSON.stringify({
            withdrawal_id,
            status: 'admin_approved',
            reason
          })
        });

        try {
          await base44.asServiceRole.functions.invoke('broadcastWithdrawal', {
            withdrawal_id
          });
        } catch (err) {
          console.error('Failed to enqueue broadcast:', err);
        }

        return Response.json({ withdrawal_id, status: 'approved', admin_approved: true });

      } else if (decision === 'reject') {
        const rejectionReason = reason || 'Rejected by admin';
        console.log(`[withdrawalRisk] Admin REJECTED withdrawal ${withdrawal_id}: ${rejectionReason}`);
        
        await base44.asServiceRole.entities.WithdrawalRequest.update(withdrawal_id, {
          status: 'rejected',
          failure_reason: rejectionReason
        });

        await unlockWithdrawalFunds(base44, withdrawal);

        await base44.asServiceRole.entities.Event.create({
          event_type: 'withdrawal_requested',
          entity_type: 'worker',
          entity_id: withdrawal.worker_id,
          actor_type: 'admin',
          actor_id: user.id,
          details: JSON.stringify({
            withdrawal_id,
            status: 'admin_rejected',
            reason: rejectionReason
          })
        });

        return Response.json({ withdrawal_id, status: 'rejected', rejection_reason: rejectionReason });
      }

      return Response.json({ error: 'Invalid decision' }, { status: 400 });
    }

    // Admin: list withdrawals with filters
    if (action === 'list_withdrawals') {
      const user = await base44.auth.me();
      if (!user || user.role !== 'admin') {
        return Response.json({ error: 'Admin access required' }, { status: 403 });
      }

      const { status, chain, limit = 50 } = body;
      const filter = {};
      if (status) filter.status = status;
      if (chain) filter.chain = chain;

      const withdrawals = await base44.asServiceRole.entities.WithdrawalRequest.filter(
        filter,
        '-created_date',
        limit
      );

      const workerIds = [...new Set(withdrawals.map(w => w.worker_id))];
      const workers = await base44.asServiceRole.entities.Worker.filter({});
      const workerMap = {};
      for (const w of workers) {
        workerMap[w.id] = w.name;
      }

      return Response.json({
        withdrawals: withdrawals.map(w => ({
          ...w,
          worker_name: workerMap[w.worker_id] || 'Unknown',
          risk_reasons: w.risk_reasons ? JSON.parse(w.risk_reasons) : []
        }))
      });
    }

    return Response.json({ error: 'Unknown action' }, { status: 400 });
  } catch (error) {
    console.error('Withdrawal risk error:', error);
    return Response.json({ error: error.message }, { status: 500 });
  }
});