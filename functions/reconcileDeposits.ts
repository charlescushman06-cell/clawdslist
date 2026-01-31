import { createClientFromRequest } from 'npm:@base44/sdk@0.8.6';

const TATUM_API_KEY = Deno.env.get('TATUM_API_KEY_MAINNET') || Deno.env.get('TATUM_API_KEY');
const TATUM_TESTNET = Deno.env.get('TATUM_TESTNET') === 'true';

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

/**
 * Fetch transactions for an address from Tatum
 */
async function fetchAddressTransactions(chain, address, pageSize = 50) {
  const tatumChain = chain === 'ETH'
    ? (TATUM_TESTNET ? 'ethereum-sepolia' : 'ethereum')
    : (TATUM_TESTNET ? 'bitcoin-testnet' : 'bitcoin');

  let transactions = [];

  if (chain === 'ETH') {
    // ETH: Get transaction history
    const response = await fetch(
      `https://api.tatum.io/v3/${tatumChain}/account/transaction/${address}?pageSize=${pageSize}`,
      {
        headers: { 'x-api-key': TATUM_API_KEY }
      }
    );
    if (response.ok) {
      const data = await response.json();
      // Filter for incoming transactions
      transactions = (data || []).filter(tx => 
        tx.to?.toLowerCase() === address.toLowerCase() && tx.value && parseFloat(tx.value) > 0
      ).map(tx => ({
        txHash: tx.hash || tx.txId,
        amount: tx.value,
        confirmations: tx.blockNumber ? 999 : 0, // If mined, assume confirmed
        from: tx.from
      }));
    }
  } else if (chain === 'BTC') {
    // BTC: Get UTXOs/transactions
    const response = await fetch(
      `https://api.tatum.io/v3/${tatumChain}/transaction/address/${address}?pageSize=${pageSize}`,
      {
        headers: { 'x-api-key': TATUM_API_KEY }
      }
    );
    if (response.ok) {
      const data = await response.json();
      // Process BTC transactions - find outputs to our address
      for (const tx of data || []) {
        const outputs = tx.outputs || tx.vout || [];
        for (const out of outputs) {
          const outAddr = out.address || (out.scriptPubKey?.addresses?.[0]);
          if (outAddr === address && out.value) {
            transactions.push({
              txHash: tx.hash || tx.txId,
              amount: out.value.toString(),
              confirmations: tx.confirmations || 0,
              from: 'btc_sender'
            });
          }
        }
      }
    }
  }

  return transactions;
}

/**
 * Process a single deposit (shared logic with webhook)
 */
async function processDeposit(base44, chain, address, txHash, amount, confirmations, ownerType, ownerId) {
  const now = new Date().toISOString();
  const threshold = CONFIRMATION_THRESHOLDS[chain];

  // Check if deposit already exists
  const existing = await base44.asServiceRole.entities.PendingDeposit.filter({
    chain,
    tx_hash: txHash
  });

  let deposit;
  let isNew = false;
  let wasCredited = false;

  if (existing.length > 0) {
    deposit = existing[0];

    // Already credited - skip
    if (deposit.status === 'credited') {
      return { deposit, isNew: false, credited: false, skipped: true };
    }

    // Update confirmations if changed
    const newStatus = confirmations >= threshold ? 'credited' :
                      confirmations > 0 ? 'confirming' : 'seen';

    if (confirmations !== deposit.confirmations || newStatus !== deposit.status) {
      await base44.asServiceRole.entities.PendingDeposit.update(deposit.id, {
        confirmations,
        status: newStatus
      });
      deposit.confirmations = confirmations;
      deposit.status = newStatus;
    }
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
      raw_payload: JSON.stringify({ source: 'reconciliation', detected_at: now })
    });

    await base44.asServiceRole.entities.Event.create({
      event_type: 'deposit_seen',
      entity_type: 'deposit',
      entity_id: txHash,
      actor_type: 'system',
      actor_id: 'reconciler',
      details: JSON.stringify({
        chain,
        address,
        tx_hash: txHash,
        amount,
        confirmations,
        threshold,
        status: deposit.status,
        owner_type: ownerType,
        owner_id: ownerId,
        source: 'reconciliation'
      })
    });
  }

  // Credit if threshold reached and not yet credited
  if (confirmations >= threshold && (isNew || existing[0]?.status !== 'credited')) {
    wasCredited = true;

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
        await base44.asServiceRole.entities.LedgerAccount.create({
          owner_type: 'worker',
          owner_id: ownerId,
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
        to_owner_type: 'worker',
        to_owner_id: ownerId,
        metadata: JSON.stringify({
          tx_hash: txHash,
          address,
          confirmations,
          deposit_id: deposit.id,
          source: 'reconciliation'
        })
      });

    } else if (ownerType === 'protocol') {
      // Credit protocol account (informational)
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
          purpose: 'treasury_deposit',
          source: 'reconciliation'
        })
      });
    }

    // Update status if not already set
    if (!isNew) {
      await base44.asServiceRole.entities.PendingDeposit.update(deposit.id, {
        status: 'credited'
      });
    }

    await base44.asServiceRole.entities.Event.create({
      event_type: 'deposit_credited',
      entity_type: 'deposit',
      entity_id: txHash,
      actor_type: 'system',
      actor_id: 'reconciler',
      details: JSON.stringify({
        chain,
        address,
        tx_hash: txHash,
        amount,
        confirmations,
        owner_type: ownerType,
        owner_id: ownerId,
        deposit_id: deposit.id,
        source: 'reconciliation'
      })
    });
  }

  return { deposit, isNew, credited: wasCredited, skipped: false };
}

Deno.serve(async (req) => {
  if (req.method !== 'POST') {
    return Response.json({ error: 'Method not allowed' }, { status: 405 });
  }

  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();

    if (!user || user.role !== 'admin') {
      return Response.json({ error: 'Admin access required' }, { status: 403 });
    }

    if (!TATUM_API_KEY) {
      return Response.json({ error: 'TATUM_API_KEY not configured' }, { status: 500 });
    }

    const body = await req.json();
    const { chain: filterChain, lookback_hours = 24 } = body;

    const startTime = Date.now();
    const results = {
      addresses_checked: 0,
      deposits_found: 0,
      deposits_new: 0,
      deposits_credited: 0,
      errors: []
    };

    // Get tracked addresses
    const filter = {};
    if (filterChain && ['ETH', 'BTC'].includes(filterChain)) {
      filter.chain = filterChain;
    }

    const trackedAddresses = await base44.asServiceRole.entities.TrackedAddress.filter(filter);
    results.addresses_checked = trackedAddresses.length;

    // Process each address
    for (const tracked of trackedAddresses) {
      try {
        const transactions = await fetchAddressTransactions(tracked.chain, tracked.address);

        for (const tx of transactions) {
          results.deposits_found++;

          const result = await processDeposit(
            base44,
            tracked.chain,
            tracked.address,
            tx.txHash,
            tx.amount,
            tx.confirmations,
            tracked.owner_type,
            tracked.owner_id
          );

          if (result.isNew) results.deposits_new++;
          if (result.credited) results.deposits_credited++;
        }
      } catch (err) {
        results.errors.push({
          address: tracked.address,
          chain: tracked.chain,
          error: err.message
        });
      }
    }

    const duration_ms = Date.now() - startTime;

    // Log reconciliation run
    await base44.asServiceRole.entities.Event.create({
      event_type: 'system_error', // Using as system event
      entity_type: 'system',
      entity_id: 'reconciliation_run',
      actor_type: 'admin',
      actor_id: user.id,
      details: JSON.stringify({
        action: 'reconcile_deposits',
        filter_chain: filterChain || 'all',
        lookback_hours,
        ...results,
        duration_ms
      })
    });

    return Response.json({
      success: true,
      ...results,
      duration_ms
    });

  } catch (error) {
    console.error('Reconciliation error:', error);
    return Response.json({ error: error.message }, { status: 500 });
  }
});