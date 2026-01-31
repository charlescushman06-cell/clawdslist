import { createClientFromRequest } from 'npm:@base44/sdk@0.8.6';

// Confirmation thresholds per chain
const CONFIRMATION_THRESHOLDS = {
  ETH: 12,
  BTC: 3
};

// Decimal math helpers
function addDecimal(a, b) {
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
  return fromScaled(toScaled(a) + toScaled(b));
}

// Parse Tatum webhook payload to extract deposit info
function parseDepositPayload(payload) {
  // Tatum sends different structures for different subscription types
  // Common fields: address, txId, amount, asset, blockNumber, chain
  
  let chain = null;
  let address = null;
  let txHash = null;
  let amount = null;
  let confirmations = 0;

  // Detect chain from payload
  if (payload.chain) {
    chain = payload.chain.toUpperCase().includes('ETH') ? 'ETH' : 
            payload.chain.toUpperCase().includes('BTC') ? 'BTC' : null;
  } else if (payload.currency) {
    chain = payload.currency.toUpperCase() === 'ETH' ? 'ETH' :
            payload.currency.toUpperCase() === 'BTC' ? 'BTC' : null;
  } else if (payload.asset) {
    chain = payload.asset.toUpperCase() === 'ETH' ? 'ETH' :
            payload.asset.toUpperCase() === 'BTC' ? 'BTC' : null;
  }

  // Extract address
  address = payload.address || payload.to || payload.counterAddress;

  // Extract transaction hash
  txHash = payload.txId || payload.txHash || payload.transactionHash || payload.hash;

  // Extract amount
  amount = payload.amount?.toString() || payload.value?.toString() || '0';

  // Extract confirmations
  confirmations = parseInt(payload.confirmations || payload.blockConfirmations || '0', 10);

  return { chain, address, txHash, amount, confirmations };
}

Deno.serve(async (req) => {
  // Only allow POST
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), { 
      status: 405,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  let rawPayload;
  let bodyText;
  
  try {
    bodyText = await req.text();
    rawPayload = JSON.parse(bodyText);
  } catch (err) {
    console.error('Failed to parse JSON:', err);
    return Response.json({ ok: true, error: 'Invalid JSON' }, { status: 200 });
  }

  const base44 = createClientFromRequest(req);
  const now = new Date().toISOString();

  // Parse deposit info from payload
  const { chain, address, txHash, amount, confirmations } = parseDepositPayload(rawPayload);

  // If we can't determine chain/address/txHash, just log and return
  if (!chain || !address || !txHash) {
    console.log('Incomplete deposit data, logging raw event');
    try {
      await base44.asServiceRole.entities.Event.create({
        event_type: 'system_error',
        entity_type: 'system',
        entity_id: txHash || 'unknown',
        actor_type: 'system',
        actor_id: 'tatum',
        details: JSON.stringify({
          source: 'tatum',
          error: 'incomplete_payload',
          raw_payload: rawPayload,
          received_at: now
        })
      });
    } catch (e) {
      console.error('Failed to log incomplete payload:', e);
    }
    return Response.json({ ok: true }, { status: 200 });
  }

  try {
    // Lookup address in TrackedAddress
    const trackedAddresses = await base44.asServiceRole.entities.TrackedAddress.filter({
      chain,
      address
    });

    // Check if deposit already exists (idempotency)
    const existingDeposits = await base44.asServiceRole.entities.PendingDeposit.filter({
      chain,
      tx_hash: txHash
    });

    const tracked = trackedAddresses.length > 0 ? trackedAddresses[0] : null;

    if (!tracked) {
      // Address not tracked - log as ignored
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
        details: JSON.stringify({
          chain,
          address,
          tx_hash: txHash,
          amount,
          confirmations,
          reason: 'address_not_tracked'
        })
      });

      console.log(`Ignored deposit to untracked address: ${chain} ${address}`);
      return Response.json({ ok: true }, { status: 200 });
    }

    // Address is tracked - process deposit
    const ownerType = tracked.owner_type;
    const ownerId = tracked.owner_id;
    const threshold = CONFIRMATION_THRESHOLDS[chain];

    let deposit;
    let isNew = false;

    if (existingDeposits.length > 0) {
      deposit = existingDeposits[0];

      // Already credited - idempotency check
      if (deposit.status === 'credited') {
        console.log(`Deposit ${txHash} already credited, skipping`);
        return Response.json({ ok: true }, { status: 200 });
      }

      // Update confirmations
      const newStatus = confirmations >= threshold ? 'credited' : 
                        confirmations > 0 ? 'confirming' : 'seen';

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
            chain,
            address,
            tx_hash: txHash,
            amount,
            old_confirmations: deposit.confirmations,
            new_confirmations: confirmations,
            threshold,
            status: newStatus,
            owner_type: ownerType,
            owner_id: ownerId
          })
        });
      }

      deposit.confirmations = confirmations;
      deposit.status = newStatus;
    } else {
      // New deposit
      isNew = true;
      const initialStatus = confirmations >= threshold ? 'credited' : 
                           confirmations > 0 ? 'confirming' : 'seen';

      deposit = await base44.asServiceRole.entities.PendingDeposit.create({
        chain,
        address,
        tx_hash: txHash,
        amount,
        confirmations,
        status: initialStatus,
        owner_type: ownerType,
        owner_id: ownerId,
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
          chain,
          address,
          tx_hash: txHash,
          amount,
          confirmations,
          threshold,
          status: deposit.status,
          owner_type: ownerType,
          owner_id: ownerId
        })
      });
    }

    // Credit if threshold reached and not already credited
    if (confirmations >= threshold && (isNew || existingDeposits[0]?.status !== 'credited')) {
      // Credit the appropriate ledger
      if (ownerType === 'worker' && ownerId) {
        // Credit worker's LedgerAccount
        const workerAccounts = await base44.asServiceRole.entities.LedgerAccount.filter({
          owner_type: 'worker',
          owner_id: ownerId,
          chain
        });

        if (workerAccounts.length > 0) {
          const account = workerAccounts[0];
          const newBalance = addDecimal(account.available_balance || '0', amount);
          await base44.asServiceRole.entities.LedgerAccount.update(account.id, {
            available_balance: newBalance
          });
        } else {
          // Create new ledger account for worker
          await base44.asServiceRole.entities.LedgerAccount.create({
            owner_type: 'worker',
            owner_id: ownerId,
            chain,
            available_balance: amount,
            locked_balance: '0'
          });
        }

        // Create ledger entry
        await base44.asServiceRole.entities.LedgerEntry.create({
          chain,
          amount,
          entry_type: 'deposit_credited',
          from_owner_type: null,
          from_owner_id: null,
          to_owner_type: 'worker',
          to_owner_id: ownerId,
          metadata: JSON.stringify({
            tx_hash: txHash,
            address,
            confirmations,
            deposit_id: deposit.id
          })
        });

      } else if (ownerType === 'protocol') {
        // Credit protocol's LedgerAccount (informational for treasury)
        const protocolAccounts = await base44.asServiceRole.entities.LedgerAccount.filter({
          owner_type: 'protocol',
          chain
        });

        if (protocolAccounts.length > 0) {
          const account = protocolAccounts[0];
          const newBalance = addDecimal(account.available_balance || '0', amount);
          await base44.asServiceRole.entities.LedgerAccount.update(account.id, {
            available_balance: newBalance
          });
        } else {
          await base44.asServiceRole.entities.LedgerAccount.create({
            owner_type: 'protocol',
            owner_id: null,
            chain,
            available_balance: amount,
            locked_balance: '0'
          });
        }

        await base44.asServiceRole.entities.LedgerEntry.create({
          chain,
          amount,
          entry_type: 'deposit_credited',
          from_owner_type: null,
          from_owner_id: null,
          to_owner_type: 'protocol',
          to_owner_id: null,
          metadata: JSON.stringify({
            tx_hash: txHash,
            address,
            confirmations,
            deposit_id: deposit.id,
            purpose: 'treasury_deposit'
          })
        });
      }

      // Mark deposit as credited (if not already done by status update above)
      if (!isNew) {
        await base44.asServiceRole.entities.PendingDeposit.update(deposit.id, {
          status: 'credited'
        });
      }

      // Emit credited event
      await base44.asServiceRole.entities.Event.create({
        event_type: 'deposit_credited',
        entity_type: 'deposit',
        entity_id: txHash,
        actor_type: 'system',
        actor_id: 'tatum',
        details: JSON.stringify({
          chain,
          address,
          tx_hash: txHash,
          amount,
          confirmations,
          owner_type: ownerType,
          owner_id: ownerId,
          deposit_id: deposit.id
        })
      });

      console.log(`Deposit credited: ${chain} ${amount} to ${ownerType}/${ownerId || 'protocol'}`);
    }

    return Response.json({ ok: true }, { status: 200 });

  } catch (err) {
    console.error('Error processing deposit:', err);
    
    try {
      await base44.asServiceRole.entities.Event.create({
        event_type: 'system_error',
        entity_type: 'deposit',
        entity_id: txHash,
        actor_type: 'system',
        actor_id: 'tatum',
        details: JSON.stringify({
          chain,
          address,
          tx_hash: txHash,
          amount,
          error: err.message,
          raw_payload: rawPayload
        })
      });
    } catch (e) {
      console.error('Failed to log error event:', e);
    }

    // Return 200 to prevent Tatum retries
    return Response.json({ ok: true, error: err.message }, { status: 200 });
  }
});