import { createClientFromRequest } from 'npm:@base44/sdk@0.8.6';

const REQUIRED_CONFIRMATIONS = {
  'ETH': 12,
  'BTC': 3
};

const EXCHANGE_RATES = {
  'ETH': 3000,
  'BTC': 45000
};

async function queryTatumTransactions(address, chain) {
  const apiKey = Deno.env.get('TATUM_API_KEY');
  if (!apiKey) {
    throw new Error('TATUM_API_KEY not configured');
  }

  const baseUrl = 'https://api.tatum.io/v3';
  const response = await fetch(
    `${baseUrl}/blockchain/transaction/address/${chain}/${address}?pageSize=50`,
    {
      headers: {
        'x-api-key': apiKey,
        'Content-Type': 'application/json'
      }
    }
  );

  if (!response.ok) {
    throw new Error(`Tatum API error: ${await response.text()}`);
  }

  return await response.json();
}

async function reconcileAddress(base44, workerId, address, chain) {
  let reconciledCount = 0;
  let creditedCount = 0;

  try {
    // Query Tatum for recent transactions
    const transactions = await queryTatumTransactions(address, chain);

    for (const tx of transactions) {
      const txid = tx.hash;
      const amount = tx.amount;
      const confirmations = tx.confirmations || 0;

      // Check if PendingDeposit exists
      const existing = await base44.asServiceRole.entities.PendingDeposit.filter({
        chain,
        txid,
        address
      });

      if (existing.length === 0) {
        // Missing transaction - create PendingDeposit
        const amountUSD = parseFloat(amount) * EXCHANGE_RATES[chain];
        const requiredConf = REQUIRED_CONFIRMATIONS[chain];
        const status = confirmations >= requiredConf ? 'confirmed' : (confirmations > 0 ? 'confirming' : 'detected');

        const newDeposit = await base44.asServiceRole.entities.PendingDeposit.create({
          worker_id: workerId,
          chain,
          address,
          txid,
          amount,
          amount_usd: amountUSD,
          confirmations,
          required_confirmations: requiredConf,
          status,
          raw_provider_payload: JSON.stringify({ source: 'reconciliation', tx })
        });

        reconciledCount++;

        // Log reconciliation event
        await base44.asServiceRole.entities.Event.create({
          event_type: 'funds_deposited',
          entity_type: 'worker',
          entity_id: workerId,
          actor_type: 'system',
          actor_id: 'reconciliation',
          details: JSON.stringify({
            stage: 'deposit_reconciled',
            chain,
            address,
            txid,
            amount,
            amount_usd: amountUSD,
            confirmations,
            status,
            provider: 'tatum'
          })
        });

        // Credit if already confirmed
        if (status === 'confirmed') {
          const worker = await base44.asServiceRole.entities.Worker.get(workerId);

          await base44.asServiceRole.entities.Worker.update(workerId, {
            available_balance_usd: (worker.available_balance_usd || 0) + amountUSD,
            total_deposited_usd: (worker.total_deposited_usd || 0) + amountUSD
          });

          await base44.asServiceRole.entities.Transaction.create({
            transaction_type: 'deposit',
            worker_id: workerId,
            amount_usd: amountUSD,
            balance_type: 'available',
            status: 'completed',
            metadata: JSON.stringify({
              chain,
              crypto_amount: amount,
              txid,
              address,
              confirmations,
              reconciled: true,
              provider: 'tatum'
            }),
            notes: `${chain} deposit credited (reconciled)`
          });

          await base44.asServiceRole.entities.PendingDeposit.update(newDeposit.id, {
            status: 'credited'
          });

          await base44.asServiceRole.entities.Event.create({
            event_type: 'funds_deposited',
            entity_type: 'worker',
            entity_id: workerId,
            actor_type: 'system',
            actor_id: 'reconciliation',
            details: JSON.stringify({
              stage: 'ledger_credited_from_reconciliation',
              chain,
              address,
              txid,
              amount,
              amount_usd: amountUSD,
              confirmations,
              provider: 'tatum'
            })
          });

          creditedCount++;
        }
      } else {
        // Existing transaction - update confirmations
        const deposit = existing[0];

        // Skip if already credited (idempotency)
        if (deposit.status === 'credited') {
          continue;
        }

        // Update confirmations if changed
        if (deposit.confirmations !== confirmations) {
          const requiredConf = REQUIRED_CONFIRMATIONS[chain];
          const newStatus = confirmations >= requiredConf ? 'confirmed' : 
                           (confirmations > 0 ? 'confirming' : 'detected');

          await base44.asServiceRole.entities.PendingDeposit.update(deposit.id, {
            confirmations,
            status: newStatus
          });

          reconciledCount++;

          // Credit if newly confirmed
          if (newStatus === 'confirmed' && deposit.status !== 'confirmed' && deposit.worker_id) {
            const worker = await base44.asServiceRole.entities.Worker.get(deposit.worker_id);

            await base44.asServiceRole.entities.Worker.update(deposit.worker_id, {
              available_balance_usd: (worker.available_balance_usd || 0) + deposit.amount_usd,
              total_deposited_usd: (worker.total_deposited_usd || 0) + deposit.amount_usd
            });

            await base44.asServiceRole.entities.Transaction.create({
              transaction_type: 'deposit',
              worker_id: deposit.worker_id,
              amount_usd: deposit.amount_usd,
              balance_type: 'available',
              status: 'completed',
              metadata: JSON.stringify({
                chain,
                crypto_amount: deposit.amount,
                txid,
                address,
                confirmations,
                reconciled: true,
                provider: 'tatum'
              }),
              notes: `${chain} deposit credited (reconciled confirmation update)`
            });

            await base44.asServiceRole.entities.PendingDeposit.update(deposit.id, {
              status: 'credited'
            });

            await base44.asServiceRole.entities.Event.create({
              event_type: 'funds_deposited',
              entity_type: 'worker',
              entity_id: deposit.worker_id,
              actor_type: 'system',
              actor_id: 'reconciliation',
              details: JSON.stringify({
                stage: 'ledger_credited_from_reconciliation',
                chain,
                address,
                txid,
                amount: deposit.amount,
                amount_usd: deposit.amount_usd,
                confirmations,
                provider: 'tatum'
              })
            });

            creditedCount++;
          }
        }
      }
    }
  } catch (error) {
    console.error(`Error reconciling ${chain} address ${address}:`, error.message);
  }

  return { reconciledCount, creditedCount };
}

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);

    let totalReconciled = 0;
    let totalCredited = 0;
    const addressesChecked = [];

    // Get all workers with crypto addresses
    const workers = await base44.asServiceRole.entities.Worker.list();

    for (const worker of workers) {
      // Reconcile ETH address
      if (worker.eth_address) {
        const result = await reconcileAddress(base44, worker.id, worker.eth_address, 'ETH');
        totalReconciled += result.reconciledCount;
        totalCredited += result.creditedCount;
        addressesChecked.push({ chain: 'ETH', address: worker.eth_address, worker_id: worker.id });
      }

      // Reconcile BTC address
      if (worker.btc_address) {
        const result = await reconcileAddress(base44, worker.id, worker.btc_address, 'BTC');
        totalReconciled += result.reconciledCount;
        totalCredited += result.creditedCount;
        addressesChecked.push({ chain: 'BTC', address: worker.btc_address, worker_id: worker.id });
      }
    }

    // Log reconciliation run
    await base44.asServiceRole.entities.Event.create({
      event_type: 'system_error',
      entity_type: 'transaction',
      entity_id: 'reconciliation',
      actor_type: 'system',
      actor_id: 'reconciliation',
      details: JSON.stringify({
        stage: 'reconciliation_completed',
        addresses_checked: addressesChecked.length,
        deposits_reconciled: totalReconciled,
        deposits_credited: totalCredited
      })
    });

    return Response.json({
      success: true,
      addresses_checked: addressesChecked.length,
      deposits_reconciled: totalReconciled,
      deposits_credited: totalCredited
    });

  } catch (error) {
    console.error('Reconciliation error:', error);
    return Response.json({ error: error.message }, { status: 500 });
  }
});