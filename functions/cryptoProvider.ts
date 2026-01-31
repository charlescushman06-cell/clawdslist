import { createClientFromRequest } from 'npm:@base44/sdk@0.8.6';

/**
 * Provider Adapter Interface
 * 
 * All crypto providers must implement these methods:
 * - createDepositAddress(worker_id, chain)
 * - getDepositStatus(address, chain)
 * - initiateWithdrawal(worker_id, chain, amount, destination_address)
 * - getWithdrawalStatus(withdrawal_id)
 */

// ============ TATUM ADAPTER ============
class TatumAdapter {
  constructor(apiKey, testnet = true) {
    this.apiKey = apiKey;
    this.baseUrl = testnet 
      ? 'https://api.tatum.io/v3'
      : 'https://api.tatum.io/v3';
    this.testnet = testnet;
  }

  async _request(method, path, body = null) {
    const options = {
      method,
      headers: {
        'x-api-key': this.apiKey,
        'Content-Type': 'application/json'
      }
    };

    if (body) {
      options.body = JSON.stringify(body);
    }

    const response = await fetch(`${this.baseUrl}${path}`, options);
    
    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Tatum API error: ${error}`);
    }

    return await response.json();
  }

  /**
   * Create a deposit address for a worker
   * @param {string} worker_id - Worker ID
   * @param {string} chain - 'ETH' or 'BTC'
   * @returns {Promise<{address: string, chain: string}>}
   */
  async createDepositAddress(worker_id, chain) {
    const chainMap = {
      'ETH': 'ethereum',
      'BTC': 'bitcoin'
    };

    const tatumChain = chainMap[chain];
    if (!tatumChain) {
      throw new Error(`Unsupported chain: ${chain}`);
    }

    // Create managed wallet account
    const account = await this._request('POST', `/ledger/account`, {
      currency: chain,
      customer: {
        externalId: worker_id
      },
      accountingCurrency: 'USD'
    });

    // Generate deposit address
    const addressData = await this._request('POST', `/offchain/account/${account.id}/address`);

    return {
      address: addressData.address,
      chain: chain,
      account_id: account.id,
      derivation_key: addressData.derivationKey
    };
  }

  /**
   * Check deposit status
   * @param {string} address - Deposit address
   * @param {string} chain - 'ETH' or 'BTC'
   * @returns {Promise<{confirmations: number, txid: string, amount: string, confirmed: boolean}>}
   */
  async getDepositStatus(address, chain) {
    // Get transactions for address
    const txs = await this._request('GET', `/blockchain/transaction/address/${chain}/${address}?pageSize=50`);

    if (!txs || txs.length === 0) {
      return { confirmations: 0, txid: null, amount: '0', confirmed: false };
    }

    // Get most recent transaction
    const latestTx = txs[0];
    
    return {
      confirmations: latestTx.confirmations || 0,
      txid: latestTx.hash,
      amount: latestTx.amount,
      confirmed: latestTx.confirmations >= (chain === 'BTC' ? 2 : 12)
    };
  }

  /**
   * Initiate withdrawal
   * @param {string} worker_id - Worker ID
   * @param {string} chain - 'ETH' or 'BTC'
   * @param {number} amount - Amount to withdraw
   * @param {string} destination_address - Recipient address
   * @returns {Promise<{withdrawal_id: string, status: string}>}
   */
  async initiateWithdrawal(worker_id, chain, amount, destination_address) {
    // Get account for worker
    const accounts = await this._request('GET', `/ledger/account/customer/${worker_id}`);
    const account = accounts.find(acc => acc.currency === chain);

    if (!account) {
      throw new Error(`No ${chain} account found for worker ${worker_id}`);
    }

    // Initiate blockchain withdrawal
    const withdrawal = await this._request('POST', `/offchain/withdrawal`, {
      senderAccountId: account.id,
      address: destination_address,
      amount: amount.toString(),
      fee: chain === 'BTC' ? '0.0001' : '0.001' // Default fees
    });

    return {
      withdrawal_id: withdrawal.id,
      status: 'pending',
      reference: withdrawal.reference
    };
  }

  /**
   * Get withdrawal status
   * @param {string} withdrawal_id - Withdrawal ID
   * @returns {Promise<{status: string, txid: string}>}
   */
  async getWithdrawalStatus(withdrawal_id) {
    const withdrawal = await this._request('GET', `/offchain/withdrawal/${withdrawal_id}`);

    return {
      status: withdrawal.status, // 'pending', 'completed', 'failed'
      txid: withdrawal.txId,
      amount: withdrawal.amount
    };
  }

  /**
   * Get account balance
   * @param {string} worker_id - Worker ID
   * @param {string} chain - 'ETH' or 'BTC'
   * @returns {Promise<{available: string, locked: string}>}
   */
  async getBalance(worker_id, chain) {
    const accounts = await this._request('GET', `/ledger/account/customer/${worker_id}`);
    const account = accounts.find(acc => acc.currency === chain);

    if (!account) {
      return { available: '0', locked: '0' };
    }

    return {
      available: account.balance.availableBalance,
      locked: account.balance.accountBalance - account.balance.availableBalance
    };
  }
}

// ============ PROVIDER FACTORY ============
function getProvider() {
  const apiKey = Deno.env.get('TATUM_API_KEY');
  if (!apiKey) {
    throw new Error('TATUM_API_KEY not configured');
  }

  // Use testnet for development
  const testnet = Deno.env.get('TATUM_TESTNET') !== 'false';
  
  return new TatumAdapter(apiKey, testnet);
}

// ============ ADDRESS RESOLUTION ============
async function resolveUnmappedDeposits(base44, workerId, address, chain) {
  // Find pending deposits with this address and no worker assigned
  const unmappedDeposits = await base44.asServiceRole.entities.PendingDeposit.filter({
    address: address,
    chain: chain
  });

  const depositsToResolve = unmappedDeposits.filter(d => !d.worker_id);

  if (depositsToResolve.length === 0) {
    return;
  }

  for (const deposit of depositsToResolve) {
    // Skip if already credited (idempotency check)
    if (deposit.status === 'credited') {
      continue;
    }

    // Assign worker
    await base44.asServiceRole.entities.PendingDeposit.update(deposit.id, {
      worker_id: workerId
    });

    // Log resolution event
    await base44.asServiceRole.entities.Event.create({
      event_type: 'funds_deposited',
      entity_type: 'worker',
      entity_id: workerId,
      actor_type: 'system',
      actor_id: 'crypto_provider',
      details: JSON.stringify({
        stage: 'address_resolved',
        chain,
        address,
        txid: deposit.txid,
        amount: deposit.amount,
        amount_usd: deposit.amount_usd,
        confirmations: deposit.confirmations,
        provider: 'tatum'
      })
    });

    // If already confirmed, credit immediately
    if (deposit.status === 'confirmed' && deposit.confirmations >= deposit.required_confirmations) {
      const worker = await base44.asServiceRole.entities.Worker.get(workerId);

      // Credit balance
      await base44.asServiceRole.entities.Worker.update(workerId, {
        available_balance_usd: (worker.available_balance_usd || 0) + deposit.amount_usd,
        total_deposited_usd: (worker.total_deposited_usd || 0) + deposit.amount_usd
      });

      // Create transaction record
      await base44.asServiceRole.entities.Transaction.create({
        transaction_type: 'deposit',
        worker_id: workerId,
        amount_usd: deposit.amount_usd,
        balance_type: 'available',
        status: 'completed',
        metadata: JSON.stringify({
          chain,
          crypto_amount: deposit.amount,
          txid: deposit.txid,
          address,
          confirmations: deposit.confirmations,
          resolved: true,
          provider: 'tatum'
        }),
        notes: `${chain} deposit credited (resolved from unmapped address)`
      });

      // Mark as credited
      await base44.asServiceRole.entities.PendingDeposit.update(deposit.id, {
        status: 'credited'
      });

      // Log credit event
      await base44.asServiceRole.entities.Event.create({
        event_type: 'funds_deposited',
        entity_type: 'worker',
        entity_id: workerId,
        actor_type: 'system',
        actor_id: 'crypto_provider',
        details: JSON.stringify({
          stage: 'credited',
          chain,
          address,
          amount: deposit.amount,
          amount_usd: deposit.amount_usd,
          txid: deposit.txid,
          confirmations: deposit.confirmations,
          resolved: true,
          provider: 'tatum'
        })
      });

      console.log(`Resolved and credited deposit to worker ${workerId}: ${deposit.amount} ${chain} = $${deposit.amount_usd}`);
    } else {
      console.log(`Resolved deposit (awaiting confirmations): ${deposit.txid}`);
    }
  }
}

// ============ API ENDPOINT ============
Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();

    if (!user) {
      return Response.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { action, worker_id, chain, address, amount, destination_address, withdrawal_id } = await req.json();
    const provider = getProvider();

    switch (action) {
      case 'create_deposit_address': {
        const result = await provider.createDepositAddress(worker_id, chain);
        
        // Store address in worker record
        const worker = await base44.entities.Worker.get(worker_id);
        const updateData = chain === 'ETH' 
          ? { eth_address: result.address }
          : { btc_address: result.address };
        
        await base44.entities.Worker.update(worker_id, updateData);

        // Resolve any pending deposits for this address
        await resolveUnmappedDeposits(base44, worker_id, result.address, chain);

        // Log event
        await base44.entities.Event.create({
          event_type: 'funds_deposited',
          entity_type: 'worker',
          entity_id: worker_id,
          actor_type: 'system',
          actor_id: 'crypto_provider',
          details: JSON.stringify({ chain, address: result.address, provider: 'tatum' })
        });

        return Response.json({ success: true, data: result });
      }

      case 'get_deposit_status': {
        const result = await provider.getDepositStatus(address, chain);
        return Response.json({ success: true, data: result });
      }

      case 'initiate_withdrawal': {
        const result = await provider.initiateWithdrawal(worker_id, chain, amount, destination_address);
        
        // Log event
        await base44.entities.Event.create({
          event_type: 'funds_withdrawn',
          entity_type: 'worker',
          entity_id: worker_id,
          actor_type: 'worker',
          actor_id: worker_id,
          details: JSON.stringify({ 
            chain, 
            amount, 
            destination_address,
            withdrawal_id: result.withdrawal_id,
            provider: 'tatum' 
          })
        });

        return Response.json({ success: true, data: result });
      }

      case 'get_withdrawal_status': {
        const result = await provider.getWithdrawalStatus(withdrawal_id);
        return Response.json({ success: true, data: result });
      }

      case 'get_balance': {
        const result = await provider.getBalance(worker_id, chain);
        return Response.json({ success: true, data: result });
      }

      default:
        return Response.json({ error: 'Invalid action' }, { status: 400 });
    }
  } catch (error) {
    console.error('Crypto provider error:', error);
    return Response.json({ error: error.message }, { status: 500 });
  }
});