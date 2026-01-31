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
  const { address, chain, amount, txid, confirmations } = payload;

  // Find worker by address
  const workers = await base44.asServiceRole.entities.Worker.filter({
    [chain === 'ETH' ? 'eth_address' : 'btc_address']: address
  });

  if (workers.length === 0) {
    console.log(`No worker found for address ${address}`);
    return;
  }

  const worker = workers[0];

  // Log deposit detected event
  await base44.asServiceRole.entities.Event.create({
    event_type: 'funds_deposited',
    entity_type: 'worker',
    entity_id: worker.id,
    actor_type: 'system',
    actor_id: 'crypto_provider',
    details: JSON.stringify({
      stage: 'detected',
      chain,
      address,
      amount,
      txid,
      confirmations,
      provider: 'tatum'
    })
  });

  console.log(`Deposit detected for worker ${worker.id}: ${amount} ${chain}`);
}

async function handleDepositConfirmed(base44, payload) {
  const { address, chain, amount, txid } = payload;

  // Find worker by address
  const workers = await base44.asServiceRole.entities.Worker.filter({
    [chain === 'ETH' ? 'eth_address' : 'btc_address']: address
  });

  if (workers.length === 0) {
    console.log(`No worker found for address ${address}`);
    return;
  }

  const worker = workers[0];

  // Convert crypto amount to USD (simplified - would use real exchange rate API)
  const exchangeRates = {
    'ETH': 3000,
    'BTC': 45000
  };
  const amountUSD = parseFloat(amount) * exchangeRates[chain];

  // Update worker balance
  await base44.asServiceRole.entities.Worker.update(worker.id, {
    available_balance_usd: (worker.available_balance_usd || 0) + amountUSD,
    total_deposited_usd: (worker.total_deposited_usd || 0) + amountUSD
  });

  // Create transaction record
  await base44.asServiceRole.entities.Transaction.create({
    transaction_type: 'deposit',
    worker_id: worker.id,
    amount_usd: amountUSD,
    balance_type: 'available',
    status: 'completed',
    metadata: JSON.stringify({
      chain,
      crypto_amount: amount,
      txid,
      address,
      provider: 'tatum'
    }),
    notes: `${chain} deposit confirmed`
  });

  // Log event
  await base44.asServiceRole.entities.Event.create({
    event_type: 'funds_deposited',
    entity_type: 'worker',
    entity_id: worker.id,
    actor_type: 'system',
    actor_id: 'crypto_provider',
    details: JSON.stringify({
      stage: 'confirmed',
      chain,
      address,
      amount,
      amount_usd: amountUSD,
      txid,
      provider: 'tatum'
    })
  });

  console.log(`Deposit confirmed for worker ${worker.id}: ${amount} ${chain} = $${amountUSD}`);
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