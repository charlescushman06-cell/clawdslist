import { createClientFromRequest } from 'npm:@base44/sdk@0.8.6';
import { createHmac } from 'node:crypto';

/**
 * Webhook handler for Tatum notifications
 * Handles: deposit_detected, deposit_confirmed, withdrawal_completed, withdrawal_failed
 */

function verifyTatumSignature(payload, signature) {
  const secret = Deno.env.get('TATUM_WEBHOOK_HMAC_SECRET');
  if (!secret) {
    throw new Error('TATUM_WEBHOOK_HMAC_SECRET not configured');
  }

  const hmac = createHmac('sha256', secret);
  hmac.update(JSON.stringify(payload));
  const calculatedSignature = hmac.digest('hex');

  return calculatedSignature === signature;
}

async function handleDepositDetected(base44, payload) {
  const { address, chain, amount, txid, confirmations = 0 } = payload;

  // Define confirmation requirements
  const REQUIRED_CONFIRMATIONS = {
    'ETH': 12,
    'BTC': 3
  };

  const requiredConf = REQUIRED_CONFIRMATIONS[chain] || 12;

  // Find worker by address
  const workers = await base44.asServiceRole.entities.Worker.filter({
    [chain === 'ETH' ? 'eth_address' : 'btc_address']: address
  });

  const workerId = workers.length > 0 ? workers[0].id : null;

  // Check if PendingDeposit already exists (idempotency)
  const existingDeposits = await base44.asServiceRole.entities.PendingDeposit.filter({
    chain,
    txid,
    address
  });

  if (existingDeposits.length > 0) {
    console.log(`Deposit already tracked: ${txid}`);
    return;
  }

  // Convert crypto to USD (simplified - use real exchange rate in production)
  const exchangeRates = { 'ETH': 3000, 'BTC': 45000 };
  const amountUSD = parseFloat(amount) * exchangeRates[chain];

  // Create PendingDeposit
  await base44.asServiceRole.entities.PendingDeposit.create({
    worker_id: workerId,
    chain,
    address,
    txid,
    amount,
    amount_usd: amountUSD,
    confirmations,
    required_confirmations: requiredConf,
    status: 'detected',
    raw_provider_payload: JSON.stringify(payload)
  });

  // Log event
  await base44.asServiceRole.entities.Event.create({
    event_type: 'funds_deposited',
    entity_type: 'worker',
    entity_id: workerId || 'unknown',
    actor_type: 'system',
    actor_id: 'crypto_provider',
    details: JSON.stringify({
      stage: 'detected',
      chain,
      address,
      amount,
      amount_usd: amountUSD,
      txid,
      confirmations,
      required_confirmations: requiredConf,
      provider: 'tatum'
    })
  });

  console.log(`Deposit detected: ${amount} ${chain} (${confirmations}/${requiredConf} confirmations)`);
}

async function handleDepositConfirmed(base44, payload) {
  const { address, chain, amount, txid, confirmations } = payload;

  // Define confirmation requirements
  const REQUIRED_CONFIRMATIONS = {
    'ETH': 12,
    'BTC': 3
  };

  const requiredConf = REQUIRED_CONFIRMATIONS[chain] || 12;

  // Find pending deposit (idempotency check)
  const pendingDeposits = await base44.asServiceRole.entities.PendingDeposit.filter({
    chain,
    txid,
    address
  });

  let pendingDeposit;

  if (pendingDeposits.length === 0) {
    // Create if doesn't exist (webhook might have been missed)
    const workers = await base44.asServiceRole.entities.Worker.filter({
      [chain === 'ETH' ? 'eth_address' : 'btc_address']: address
    });

    const workerId = workers.length > 0 ? workers[0].id : null;

    const exchangeRates = { 'ETH': 3000, 'BTC': 45000 };
    const amountUSD = parseFloat(amount) * exchangeRates[chain];

    pendingDeposit = await base44.asServiceRole.entities.PendingDeposit.create({
      worker_id: workerId,
      chain,
      address,
      txid,
      amount,
      amount_usd: amountUSD,
      confirmations: confirmations || 0,
      required_confirmations: requiredConf,
      status: 'detected',
      raw_provider_payload: JSON.stringify(payload)
    });
  } else {
    pendingDeposit = pendingDeposits[0];
  }

  // Check if already credited (idempotency)
  if (pendingDeposit.status === 'credited') {
    console.log(`Deposit already credited: ${txid}`);
    return;
  }

  // Update confirmations
  const currentConf = confirmations || pendingDeposit.confirmations;
  let newStatus = pendingDeposit.status;

  if (currentConf < requiredConf) {
    newStatus = 'confirming';
  } else if (currentConf >= requiredConf) {
    newStatus = 'confirmed';
  }

  await base44.asServiceRole.entities.PendingDeposit.update(pendingDeposit.id, {
    confirmations: currentConf,
    status: newStatus,
    raw_provider_payload: JSON.stringify(payload)
  });

  // Log confirmation progress
  await base44.asServiceRole.entities.Event.create({
    event_type: 'funds_deposited',
    entity_type: 'worker',
    entity_id: pendingDeposit.worker_id || 'unknown',
    actor_type: 'system',
    actor_id: 'crypto_provider',
    details: JSON.stringify({
      stage: newStatus,
      chain,
      address,
      amount,
      txid,
      confirmations: currentConf,
      required_confirmations: requiredConf,
      provider: 'tatum'
    })
  });

  // Credit balance only when fully confirmed
  if (newStatus === 'confirmed') {
    if (!pendingDeposit.worker_id) {
      console.log(`No worker found for deposit ${txid}`);
      return;
    }

    const worker = await base44.asServiceRole.entities.Worker.get(pendingDeposit.worker_id);

    // Credit worker balance
    await base44.asServiceRole.entities.Worker.update(worker.id, {
      available_balance_usd: (worker.available_balance_usd || 0) + pendingDeposit.amount_usd,
      total_deposited_usd: (worker.total_deposited_usd || 0) + pendingDeposit.amount_usd
    });

    // Create transaction record
    await base44.asServiceRole.entities.Transaction.create({
      transaction_type: 'deposit',
      worker_id: worker.id,
      amount_usd: pendingDeposit.amount_usd,
      balance_type: 'available',
      status: 'completed',
      metadata: JSON.stringify({
        chain,
        crypto_amount: pendingDeposit.amount,
        txid,
        address,
        confirmations: currentConf,
        provider: 'tatum'
      }),
      notes: `${chain} deposit credited (${currentConf} confirmations)`
    });

    // Mark as credited
    await base44.asServiceRole.entities.PendingDeposit.update(pendingDeposit.id, {
      status: 'credited'
    });

    // Log credit event
    await base44.asServiceRole.entities.Event.create({
      event_type: 'funds_deposited',
      entity_type: 'worker',
      entity_id: worker.id,
      actor_type: 'system',
      actor_id: 'crypto_provider',
      details: JSON.stringify({
        stage: 'credited',
        chain,
        address,
        amount: pendingDeposit.amount,
        amount_usd: pendingDeposit.amount_usd,
        txid,
        confirmations: currentConf,
        provider: 'tatum'
      })
    });

    console.log(`Deposit credited to worker ${worker.id}: ${pendingDeposit.amount} ${chain} = $${pendingDeposit.amount_usd}`);
  } else {
    console.log(`Deposit confirming: ${txid} (${currentConf}/${requiredConf})`);
  }
}

async function handleWithdrawalCompleted(base44, payload) {
  const { withdrawal_id, txid, amount, chain, worker_id } = payload;

  // Log event
  await base44.asServiceRole.entities.Event.create({
    event_type: 'funds_withdrawn',
    entity_type: 'worker',
    entity_id: worker_id,
    actor_type: 'system',
    actor_id: 'crypto_provider',
    details: JSON.stringify({
      stage: 'completed',
      chain,
      amount,
      txid,
      withdrawal_id,
      provider: 'tatum'
    })
  });

  console.log(`Withdrawal completed for worker ${worker_id}: ${amount} ${chain}, tx: ${txid}`);
}

async function handleWithdrawalFailed(base44, payload) {
  const { withdrawal_id, reason, chain, worker_id, amount_usd } = payload;

  // Refund the worker's balance
  const worker = await base44.asServiceRole.entities.Worker.get(worker_id);
  await base44.asServiceRole.entities.Worker.update(worker_id, {
    available_balance_usd: (worker.available_balance_usd || 0) + amount_usd
  });

  // Create refund transaction
  await base44.asServiceRole.entities.Transaction.create({
    transaction_type: 'deposit',
    worker_id: worker_id,
    amount_usd: amount_usd,
    balance_type: 'available',
    status: 'completed',
    metadata: JSON.stringify({
      withdrawal_id,
      chain,
      provider: 'tatum'
    }),
    notes: `Withdrawal failed - refunded: ${reason}`
  });

  // Log event
  await base44.asServiceRole.entities.Event.create({
    event_type: 'system_error',
    entity_type: 'worker',
    entity_id: worker_id,
    actor_type: 'system',
    actor_id: 'crypto_provider',
    details: JSON.stringify({
      stage: 'failed',
      chain,
      reason,
      withdrawal_id,
      refund_amount_usd: amount_usd,
      provider: 'tatum'
    })
  });

  console.log(`Withdrawal failed for worker ${worker_id}: ${reason}`);
}

Deno.serve(async (req) => {
  try {
    const signature = req.headers.get('x-tatum-signature');
    const payload = await req.json();

    // Verify signature
    if (!verifyTatumSignature(payload, signature)) {
      console.error('Invalid webhook signature');
      return Response.json({ error: 'Invalid signature' }, { status: 401 });
    }

    const base44 = createClientFromRequest(req);

    // Route to appropriate handler
    switch (payload.type) {
      case 'deposit_detected':
        await handleDepositDetected(base44, payload.data);
        break;
      
      case 'deposit_confirmed':
        await handleDepositConfirmed(base44, payload.data);
        break;
      
      case 'withdrawal_completed':
        await handleWithdrawalCompleted(base44, payload.data);
        break;
      
      case 'withdrawal_failed':
        await handleWithdrawalFailed(base44, payload.data);
        break;
      
      default:
        console.log(`Unknown webhook type: ${payload.type}`);
    }

    return Response.json({ success: true, received: payload.type });

  } catch (error) {
    console.error('Webhook error:', error);
    return Response.json({ error: error.message }, { status: 500 });
  }
});