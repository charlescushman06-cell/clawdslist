import { createClientFromRequest } from 'npm:@base44/sdk@0.8.6';

// Confirmation thresholds per chain
const CONFIRMATION_THRESHOLDS = {
  ETH: 12,
  BTC: 3
};

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
  return fromScaled(toScaled(a) - toScaled(b));
}

/**
 * Convert wei to ETH (18 decimals)
 */
function weiToEth(weiValue) {
  if (!weiValue) return '0';
  const str = String(weiValue).trim();
  if (!str || str === '0') return '0';
  
  // If it already has a decimal, assume it's already in ETH
  if (str.includes('.')) return str;
  
  // If it's a small number (< 1e15), assume it's already in ETH
  // Real wei values for meaningful deposits are typically > 1e15
  if (str.length < 15) return str;
  
  // Convert wei to ETH: divide by 10^18
  const padded = str.padStart(19, '0');
  const whole = padded.slice(0, -18).replace(/^0+/, '') || '0';
  const frac = padded.slice(-18).replace(/0+$/, '');
  
  return frac ? `${whole}.${frac}` : whole;
}

// Parse Tatum webhook payload
function parseTatumPayload(payload) {
  let chain = null;
  let address = null;
  let txHash = null;
  let amount = null;
  let confirmations = 0;
  let type = 'deposit';
  let withdrawalRef = null;
  let isFailed = false;

  // Detect chain
  if (payload.chain) {
    chain = payload.chain.toUpperCase().includes('ETH') ? 'ETH' : 
            payload.chain.toUpperCase().includes('BTC') ? 'BTC' : null;
  } else if (payload.currency) {
    chain = payload.currency.toUpperCase() === 'ETH' ?'ETH' :
            payload.currency.toUpperCase() === 'BTC' ? 'BTC' : null;
  } else if (payload.asset) {
    chain = payload.asset.toUpperCase() === 'ETH' ? 'ETH' :
            payload.asset.toUpperCase() === 'BTC' ? 'BTC' : null;
  }

  address = payload.address || payload.to || payload.counterAddress;
  txHash = payload.txId || payload.txHash || payload.transactionHash || payload.hash;
  
  // Get raw amount - will convert based on chain
  let rawAmount = payload.amount?.toString() || payload.value?.toString() || '0';
  
  // For ETH, Tatum often sends amounts in wei - convert to ETH
  if (chain === 'ETH') {
    amount = weiToEth(rawAmount);
  } else {
    amount = rawAmount;
  }
  
  confirmations = parseInt(payload.confirmations || payload.blockConfirmations || '0', 10);

  // Detect withdrawal by reference fields or transaction type
  if (payload.withdrawalId) {
    type = 'withdrawal';
    withdrawalRef = payload.withdrawalId;
  } else if (payload.reference) {
    type = 'withdrawal';
    withdrawalRef = payload.reference;
  } else if (payload.transactionType === 'OUTGOING' || payload.type === 'outgoing') {
    type = 'withdrawal';
  }

  // Detect failed/dropped transaction
  if (payload.status === 'FAILED' || payload.status === 'DROPPED' || 
      payload.failed === true || payload.error) {
    isFailed = true;
  }

  return { chain, address, txHash, amount, confirmations, type, withdrawalRef, isFailed };
}

// Handle withdrawal webhook
async function handleWithdrawalWebhook(base44, chain, txHash, confirmations, withdrawalRef, isFailed, rawPayload, now) {
  console.log(`Processing withdrawal webhook: txHash=${txHash}, ref=${withdrawalRef}, confirmations=${confirmations}, failed=${isFailed}`);

  let withdrawal = null;

  // Find by reference ID first (our WithdrawalRequest.id)
  if (withdrawalRef) {
    const byRef = await base44.asServiceRole.entities.WithdrawalRequest.filter({ id: withdrawalRef });
    withdrawal = byRef.length > 0 ? byRef[0] : null;
  }

  // Fallback to tx_hash lookup
  if (!withdrawal && txHash) {
    const byHash = await base44.asServiceRole.entities.WithdrawalRequest.filter({ tx_hash: txHash });
    withdrawal = byHash.length > 0 ? byHash[0] : null;
  }

  if (!withdrawal) {
    console.log(`WithdrawalRequest not found for ref=${withdrawalRef}, txHash=${txHash}`);
    await base44.asServiceRole.entities.Event.create({
      event_type: 'system_error',
      entity_type: 'withdrawal',
      entity_id: withdrawalRef || txHash || 'unknown',
      actor_type: 'system',
      actor_id: 'tatum',
      details: JSON.stringify({
        error: 'withdrawal_not_found',
        withdrawalRef,
        txHash,
        raw_payload: rawPayload,
        received_at: now
      })
    });
    return;
  }

  // Idempotency: skip if already finalized
  if (withdrawal.status === 'confirmed' || withdrawal.status === 'failed') {
    console.log(`Withdrawal ${withdrawal.id} already finalized as ${withdrawal.status}, skipping`);
    return;
  }

  // Update tx_hash if missing
  if (!withdrawal.tx_hash && txHash) {
    await base44.asServiceRole.entities.WithdrawalRequest.update(withdrawal.id, { tx_hash: txHash });
  }

  const threshold = CONFIRMATION_THRESHOLDS[chain] || 12;

  // FAILURE PATH: refund locked -> available
  if (isFailed) {
    console.log(`Withdrawal ${withdrawal.id} FAILED, refunding locked_balance`);

    await base44.asServiceRole.entities.WithdrawalRequest.update(withdrawal.id, {
      status: 'failed',
      failure_reason: rawPayload.message || rawPayload.error || 'Transaction failed/dropped'
    });

    // Refund: locked_balance -> available_balance
    const accounts = await base44.asServiceRole.entities.LedgerAccount.filter({
      owner_type: 'worker',
      owner_id: withdrawal.worker_id,
      chain
    });

    if (accounts.length > 0) {
      const account = accounts[0];
      await base44.asServiceRole.entities.LedgerAccount.update(account.id, {
        available_balance: addDecimal(account.available_balance || '0', withdrawal.amount),
        locked_balance: subtractDecimal(account.locked_balance || '0', withdrawal.amount)
      });
    }

    await base44.asServiceRole.entities.LedgerEntry.create({
      chain,
      amount: withdrawal.amount,
      entry_type: 'unlock',
      from_owner_type: 'worker',
      from_owner_id: withdrawal.worker_id,
      to_owner_type: 'worker',
      to_owner_id: withdrawal.worker_id,
      metadata: JSON.stringify({
        tx_hash: txHash,
        withdrawal_id: withdrawal.id,
        reason: 'withdrawal_failed'
      })
    });

    await base44.asServiceRole.entities.Event.create({
      event_type: 'withdrawal_failed',
      entity_type: 'withdrawal',
      entity_id: withdrawal.id,
      actor_type: 'system',
      actor_id: 'tatum',
      details: JSON.stringify({
        chain,
        tx_hash: txHash,
        amount: withdrawal.amount,
        worker_id: withdrawal.worker_id,
        reason: rawPayload.message || 'Transaction failed'
      })
    });

    return;
  }

  // CONFIRMATION PATH: permanently deduct locked_balance
  if (confirmations >= threshold && withdrawal.status === 'broadcasted') {
    console.log(`Withdrawal ${withdrawal.id} CONFIRMED with ${confirmations} confirmations`);

    await base44.asServiceRole.entities.WithdrawalRequest.update(withdrawal.id, {
      status: 'confirmed'
    });

    // Permanently deduct from locked_balance (do NOT touch available)
    const accounts = await base44.asServiceRole.entities.LedgerAccount.filter({
      owner_type: 'worker',
      owner_id: withdrawal.worker_id,
      chain
    });

    if (accounts.length > 0) {
      const account = accounts[0];
      await base44.asServiceRole.entities.LedgerAccount.update(account.id, {
        locked_balance: subtractDecimal(account.locked_balance || '0', withdrawal.amount)
      });
    }

    await base44.asServiceRole.entities.LedgerEntry.create({
      chain,
      amount: withdrawal.amount,
      entry_type: 'withdrawal_confirmed',
      from_owner_type: 'worker',
      from_owner_id: withdrawal.worker_id,
      to_owner_type: null,
      to_owner_id: null,
      metadata: JSON.stringify({
        tx_hash: txHash,
        withdrawal_id: withdrawal.id,
        confirmations,
        destination_address: withdrawal.destination_address
      })
    });

    await base44.asServiceRole.entities.Event.create({
      event_type: 'withdrawal_confirmed',
      entity_type: 'withdrawal',
      entity_id: withdrawal.id,
      actor_type: 'system',
      actor_id: 'tatum',
      details: JSON.stringify({
        chain,
        tx_hash: txHash,
        amount: withdrawal.amount,
        worker_id: withdrawal.worker_id,
        confirmations
      })
    });

    return;
  }

  // Still confirming
  console.log(`Withdrawal ${withdrawal.id} at ${confirmations}/${threshold} confirmations`);
}

Deno.serve(async (req) => {
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), { 
      status: 405,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  let rawPayload;
  try {
    const bodyText = await req.text();
    rawPayload = JSON.parse(bodyText);
  } catch (err) {
    console.error('Failed to parse JSON:', err);
    return Response.json({ ok: true, error: 'Invalid JSON' }, { status: 200 });
  }

  const base44 = createClientFromRequest(req);
  const now = new Date().toISOString();

  const { chain, address, txHash, amount, confirmations, type, withdrawalRef, isFailed } = parseTatumPayload(rawPayload);

  // Validate minimum required fields
  if (!chain || !txHash) {
    console.log('Incomplete payload, missing chain or txHash');
    try {
      await base44.asServiceRole.entities.Event.create({
        event_type: 'system_error',
        entity_type: 'system',
        entity_id: txHash || 'unknown',
        actor_type: 'system',
        actor_id: 'tatum',
        details: JSON.stringify({
          error: 'incomplete_payload',
          raw_payload: rawPayload,
          received_at: now
        })
      });
    } catch (e) {
      console.error('Failed to log error:', e);
    }
    return Response.json({ ok: true }, { status: 200 });
  }

  try {
    // WITHDRAWAL HANDLING
    if (type === 'withdrawal') {
      await handleWithdrawalWebhook(base44, chain, txHash, confirmations, withdrawalRef, isFailed, rawPayload, now);
      return Response.json({ ok: true }, { status: 200 });
    }

    // DEPOSIT HANDLING (existing logic)
    if (!address) {
      console.log('Deposit webhook missing address');
      return Response.json({ ok: true }, { status: 200 });
    }

    const trackedAddresses = await base44.asServiceRole.entities.TrackedAddress.filter({ chain, address });
    const existingDeposits = await base44.asServiceRole.entities.PendingDeposit.filter({ chain, tx_hash: txHash });

    const tracked = trackedAddresses.length > 0 ? trackedAddresses[0] : null;

    if (!tracked) {
      if (existingDeposits.length === 0) {
        await base44.asServiceRole.entities.PendingDeposit.create({
          chain,
          address,
          tx_hash: txHash,
          amount,
          confirmations,
          status: 'ignored',
          owner_type: null,
          owner_id: null,
          first_seen_at: now,
          raw_payload: JSON.stringify(rawPayload)
        });
      }

      await base44.asServiceRole.entities.Event.create({
        event_type: 'deposit_ignored_untracked',
        entity_type: 'deposit',
        entity_id: txHash,
        actor_type: 'system',
        actor_id: 'tatum',
        details: JSON.stringify({ chain, address, tx_hash: txHash, amount, confirmations, reason: 'address_not_tracked' })
      });

      console.log(`Ignored deposit to untracked address: ${chain} ${address}`);
      return Response.json({ ok: true }, { status: 200 });
    }

    const ownerType = tracked.owner_type;
    const ownerId = tracked.owner_id;
    const threshold = CONFIRMATION_THRESHOLDS[chain];

    let deposit;
    let isNew = false;

    if (existingDeposits.length > 0) {
      deposit = existingDeposits[0];

      if (deposit.status === 'credited') {
        console.log(`Deposit ${txHash} already credited, skipping`);
        return Response.json({ ok: true }, { status: 200 });
      }

      const newStatus = confirmations >= threshold ? 'credited' : confirmations > 0 ? 'confirming' : 'seen';

      if (confirmations !== deposit.confirmations || newStatus !== deposit.status) {
        await base44.asServiceRole.entities.PendingDeposit.update(deposit.id, {
          confirmations,
          status: newStatus,
          raw_payload: JSON.stringify(rawPayload)
        });

        await base44.asServiceRole.entities.Event.create({
          event_type: 'deposit_confirmations_updated',
          entity_type: 'deposit',
          entity_id: txHash,
          actor_type: 'system',
          actor_id: 'tatum',
          details: JSON.stringify({
            chain, address, tx_hash: txHash, amount,
            old_confirmations: deposit.confirmations,
            new_confirmations: confirmations,
            threshold, status: newStatus,
            owner_type: ownerType, owner_id: ownerId
          })
        });
      }

      deposit.confirmations = confirmations;
      deposit.status = newStatus;
    } else {
      isNew = true;
      const initialStatus = confirmations >= threshold ? 'credited' : confirmations > 0 ? 'confirming' : 'seen';

      deposit = await base44.asServiceRole.entities.PendingDeposit.create({
        chain, address, tx_hash: txHash, amount, confirmations,
        status: initialStatus,
        owner_type: ownerType, owner_id: ownerId,
        first_seen_at: now,
        raw_payload: JSON.stringify(rawPayload)
      });

      await base44.asServiceRole.entities.Event.create({
        event_type: 'deposit_seen',
        entity_type: 'deposit',
        entity_id: txHash,
        actor_type: 'system',
        actor_id: 'tatum',
        details: JSON.stringify({
          chain, address, tx_hash: txHash, amount, confirmations, threshold,
          status: deposit.status, owner_type: ownerType, owner_id: ownerId
        })
      });
    }

    // Credit if threshold reached
    if (confirmations >= threshold && (isNew || existingDeposits[0]?.status !== 'credited')) {
      if (ownerType === 'worker' && ownerId) {
        const workerAccounts = await base44.asServiceRole.entities.LedgerAccount.filter({
          owner_type: 'worker', owner_id: ownerId, chain
        });

        if (workerAccounts.length > 0) {
          const account = workerAccounts[0];
          await base44.asServiceRole.entities.LedgerAccount.update(account.id, {
            available_balance: addDecimal(account.available_balance || '0', amount)
          });
        } else {
          await base44.asServiceRole.entities.LedgerAccount.create({
            owner_type: 'worker', owner_id: ownerId, chain,
            available_balance: amount, locked_balance: '0'
          });
        }

        await base44.asServiceRole.entities.LedgerEntry.create({
          chain, amount,
          entry_type: 'deposit_credited',
          from_owner_type: null, from_owner_id: null,
          to_owner_type: 'worker', to_owner_id: ownerId,
          metadata: JSON.stringify({ tx_hash: txHash, address, confirmations, deposit_id: deposit.id })
        });

      } else if (ownerType === 'protocol') {
        const protocolAccounts = await base44.asServiceRole.entities.LedgerAccount.filter({
          owner_type: 'protocol', chain
        });

        if (protocolAccounts.length > 0) {
          const account = protocolAccounts[0];
          await base44.asServiceRole.entities.LedgerAccount.update(account.id, {
            available_balance: addDecimal(account.available_balance || '0', amount)
          });
        } else {
          await base44.asServiceRole.entities.LedgerAccount.create({
            owner_type: 'protocol', owner_id: null, chain,
            available_balance: amount, locked_balance: '0'
          });
        }

        await base44.asServiceRole.entities.LedgerEntry.create({
          chain, amount,
          entry_type: 'deposit_credited',
          from_owner_type: null, from_owner_id: null,
          to_owner_type: 'protocol', to_owner_id: null,
          metadata: JSON.stringify({ tx_hash: txHash, address, confirmations, deposit_id: deposit.id, purpose: 'treasury_deposit' })
        });
      }

      if (!isNew) {
        await base44.asServiceRole.entities.PendingDeposit.update(deposit.id, { status: 'credited' });
      }

      await base44.asServiceRole.entities.Event.create({
        event_type: 'deposit_credited',
        entity_type: 'deposit',
        entity_id: txHash,
        actor_type: 'system',
        actor_id: 'tatum',
        details: JSON.stringify({
          chain, address, tx_hash: txHash, amount, confirmations,
          owner_type: ownerType, owner_id: ownerId, deposit_id: deposit.id
        })
      });

      console.log(`Deposit credited: ${chain} ${amount} to ${ownerType}/${ownerId || 'protocol'}`);
    }

    return Response.json({ ok: true }, { status: 200 });

  } catch (err) {
    console.error('Error processing webhook:', err);
    
    try {
      await base44.asServiceRole.entities.Event.create({
        event_type: 'system_error',
        entity_type: 'system',
        entity_id: txHash,
        actor_type: 'system',
        actor_id: 'tatum',
        details: JSON.stringify({ chain, address, tx_hash: txHash, amount, error: err.message, raw_payload: rawPayload })
      });
    } catch (e) {
      console.error('Failed to log error event:', e);
    }

    return Response.json({ ok: true, error: err.message }, { status: 200 });
  }
});