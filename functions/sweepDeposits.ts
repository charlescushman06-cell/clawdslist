import { createClientFromRequest } from 'npm:@base44/sdk@0.8.6';

const TATUM_API_KEY = Deno.env.get('TATUM_API_KEY_MAINNET');
const DEPOSIT_MNEMONIC_ETH = Deno.env.get('DEPOSIT_MASTER_MNEMONIC_ETH');
const DEPOSIT_MNEMONIC_BTC = Deno.env.get('DEPOSIT_MASTER_MNEMONIC_BTC');
const HOT_WALLET_ADDRESS_ETH = Deno.env.get('HOT_WALLET_ADDRESS_ETH');
const HOT_WALLET_ADDRESS_BTC = Deno.env.get('HOT_WALLET_ADDRESS_BTC');
const MIN_SWEEP_AMOUNT_ETH = Deno.env.get('MIN_SWEEP_AMOUNT_ETH') || '0.001';
const MIN_SWEEP_AMOUNT_BTC = Deno.env.get('MIN_SWEEP_AMOUNT_BTC') || '0.0001';
const TATUM_TESTNET = Deno.env.get('TATUM_TESTNET') === 'true';

/**
 * Get balance of an address via Tatum
 */
async function getAddressBalance(chain, address) {
  const tatumChain = chain === 'ETH' 
    ? (TATUM_TESTNET ? 'ethereum-sepolia' : 'ethereum')
    : (TATUM_TESTNET ? 'bitcoin-testnet' : 'bitcoin');
  
  const endpoint = chain === 'ETH'
    ? `https://api.tatum.io/v3/${tatumChain}/account/balance/${address}`
    : `https://api.tatum.io/v3/${tatumChain}/address/balance/${address}`;
  
  const response = await fetch(endpoint, {
    headers: { 'x-api-key': TATUM_API_KEY }
  });
  
  if (!response.ok) return '0';
  
  const data = await response.json();
  if (chain === 'ETH') {
    return data.balance || '0';
  } else {
    // BTC balance calculation
    const incoming = parseFloat(data.incoming || '0');
    const outgoing = parseFloat(data.outgoing || '0');
    return (incoming - outgoing).toString();
  }
}

/**
 * Derive ETH private key from mnemonic via Tatum
 */
async function deriveEthPrivateKey(mnemonic, index) {
  const tatumChain = TATUM_TESTNET ? 'ethereum-sepolia' : 'ethereum';
  
  const response = await fetch(`https://api.tatum.io/v3/${tatumChain}/wallet/priv`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': TATUM_API_KEY
    },
    body: JSON.stringify({
      mnemonic: mnemonic,
      index: index
    })
  });
  
  if (!response.ok) {
    const err = await response.json().catch(() => ({}));
    console.error('[deriveEthPrivateKey] Tatum error:', JSON.stringify({
      status: response.status,
      error: err,
      index: index
    }));
    throw new Error(`Failed to derive private key: ${err.message || response.status}`);
  }
  
  const data = await response.json();
  return data.key;
}

/**
 * Sweep ETH from a deposit address to hot wallet
 */
async function sweepEthAddress(address, derivationIndex, amount) {
  const tatumChain = TATUM_TESTNET ? 'ethereum-sepolia' : 'ethereum';
  
  // Leave some for gas, sweep the rest
  const gasReserve = 0.0005;
  const sweepAmount = (parseFloat(amount) - gasReserve).toFixed(18);
  
  if (parseFloat(sweepAmount) <= 0) {
    return { skipped: true, reason: 'Amount too small after gas reserve' };
  }
  
  // Derive the private key for this deposit address
  const privateKey = await deriveEthPrivateKey(DEPOSIT_MNEMONIC_ETH, derivationIndex);
  
  // Get current gas price from Tatum
  let gasPrice = '30000000000'; // Default 30 Gwei
  try {
    const gasPriceResponse = await fetch(`https://api.tatum.io/v3/${tatumChain}/gas`, {
      headers: { 'x-api-key': TATUM_API_KEY }
    });
    if (gasPriceResponse.ok) {
      const gasPriceData = await gasPriceResponse.json();
      const fastGwei = parseFloat(gasPriceData.fast || gasPriceData.standard || '30');
      gasPrice = Math.round(fastGwei * 1e9).toString();
      console.log(`[sweepEthAddress] Using gas price: ${fastGwei} Gwei`);
    }
  } catch (gasErr) {
    console.log(`[sweepEthAddress] Failed to fetch gas price, using default 30 Gwei`);
  }
  
  const response = await fetch(`https://api.tatum.io/v3/${tatumChain}/transaction`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': TATUM_API_KEY
    },
    body: JSON.stringify({
      to: HOT_WALLET_ADDRESS_ETH,
      amount: sweepAmount,
      currency: 'ETH',
      fromPrivateKey: privateKey,
      fee: {
        gasLimit: '21000',
        gasPrice: gasPrice
      }
    })
  });
  
  if (!response.ok) {
    const errData = await response.json().catch(() => ({}));
    console.error('[sweepEthAddress] Tatum error:', JSON.stringify({
      status: response.status,
      error: errData,
      request: {
        to: HOT_WALLET_ADDRESS_ETH,
        amount: sweepAmount,
        index: derivationIndex
      }
    }));
    throw new Error(errData.message || `Tatum ETH sweep failed: ${response.status}`);
  }
  
  const data = await response.json();
  return {
    txHash: data.txId || data.txHash,
    amount: sweepAmount,
    from: address,
    to: HOT_WALLET_ADDRESS_ETH
  };
}

/**
 * Sweep BTC from a deposit address to hot wallet
 */
async function sweepBtcAddress(address, derivationIndex, amount) {
  const tatumChain = TATUM_TESTNET ? 'bitcoin-testnet' : 'bitcoin';
  
  // BTC fee estimation - leave enough for fee
  const feeReserve = 0.00005;
  const sweepAmount = (parseFloat(amount) - feeReserve).toFixed(8);
  
  if (parseFloat(sweepAmount) <= 0) {
    return { skipped: true, reason: 'Amount too small after fee reserve' };
  }
  
  const response = await fetch(`https://api.tatum.io/v3/${tatumChain}/transaction`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': TATUM_API_KEY
    },
    body: JSON.stringify({
      fromAddress: [{
        address: address,
        privateKey: await derivePrivateKey('BTC', derivationIndex)
      }],
      to: [{
        address: HOT_WALLET_ADDRESS_BTC,
        value: parseFloat(sweepAmount)
      }]
    })
  });
  
  if (!response.ok) {
    const err = await response.json().catch(() => ({}));
    throw new Error(err.message || `Sweep failed: ${response.status}`);
  }
  
  const data = await response.json();
  return {
    txHash: data.txId || data.txHash,
    amount: sweepAmount,
    from: address,
    to: HOT_WALLET_ADDRESS_BTC
  };
}

/**
 * Derive private key from mnemonic for BTC
 */
async function derivePrivateKey(chain, index) {
  const tatumChain = chain === 'BTC' 
    ? (TATUM_TESTNET ? 'bitcoin-testnet' : 'bitcoin')
    : (TATUM_TESTNET ? 'ethereum-sepolia' : 'ethereum');
  
  const mnemonic = chain === 'BTC' ? DEPOSIT_MNEMONIC_BTC : DEPOSIT_MNEMONIC_ETH;
  
  const response = await fetch(`https://api.tatum.io/v3/${tatumChain}/wallet/priv`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': TATUM_API_KEY
    },
    body: JSON.stringify({
      mnemonic,
      index
    })
  });
  
  if (!response.ok) {
    throw new Error('Failed to derive private key');
  }
  
  const data = await response.json();
  return data.key;
}

/**
 * Main sweep function
 */
async function runSweep(base44, chain) {
  console.log(`[sweepDeposits] Starting ${chain} sweep`);
  
  const mnemonic = chain === 'ETH' ? DEPOSIT_MNEMONIC_ETH : DEPOSIT_MNEMONIC_BTC;
  const hotWallet = chain === 'ETH' ? HOT_WALLET_ADDRESS_ETH : HOT_WALLET_ADDRESS_BTC;
  const minAmount = chain === 'ETH' ? MIN_SWEEP_AMOUNT_ETH : MIN_SWEEP_AMOUNT_BTC;
  
  if (!mnemonic) {
    throw new Error(`DEPOSIT_MASTER_MNEMONIC_${chain} not configured`);
  }
  if (!hotWallet) {
    throw new Error(`HOT_WALLET_ADDRESS_${chain} not configured`);
  }
  
  // Get all active deposit addresses for this chain
  const depositAddresses = await base44.asServiceRole.entities.WorkerDepositAddress.filter({
    chain,
    status: 'active'
  });
  
  console.log(`[sweepDeposits] Found ${depositAddresses.length} ${chain} deposit addresses`);
  
  const results = [];
  
  for (const deposit of depositAddresses) {
    try {
      // Check balance
      const balance = await getAddressBalance(chain, deposit.address);
      console.log(`[sweepDeposits] ${deposit.address} (index ${deposit.derivation_index}): ${balance} ${chain}`);
      
      // Skip if below minimum
      if (parseFloat(balance) < parseFloat(minAmount)) {
        results.push({
          address: deposit.address,
          skipped: true,
          reason: `Balance ${balance} below minimum ${minAmount}`
        });
        continue;
      }
      
      // Sweep
      const sweepResult = chain === 'ETH'
        ? await sweepEthAddress(deposit.address, deposit.derivation_index, balance)
        : await sweepBtcAddress(deposit.address, deposit.derivation_index, balance);
      
      if (sweepResult.skipped) {
        results.push({
          address: deposit.address,
          ...sweepResult
        });
        continue;
      }
      
      results.push({
        address: deposit.address,
        derivation_index: deposit.derivation_index,
        ...sweepResult
      });
      
      // Log sweep event
      await base44.asServiceRole.entities.Event.create({
        event_type: 'deposit_swept',
        entity_type: 'deposit',
        entity_id: deposit.address,
        actor_type: 'system',
        actor_id: 'sweep_job',
        details: JSON.stringify({
          chain,
          from: deposit.address,
          to: hotWallet,
          amount: sweepResult.amount,
          tx_hash: sweepResult.txHash,
          worker_id: deposit.worker_id
        })
      });
      
      // Small delay between sweeps to avoid rate limits
      await new Promise(r => setTimeout(r, 1000));
      
    } catch (err) {
      console.error(`[sweepDeposits] Error sweeping ${deposit.address}:`, err.message);
      results.push({
        address: deposit.address,
        error: err.message
      });
    }
  }
  
  return results;
}

Deno.serve(async (req) => {
  if (req.method !== 'POST') {
    return Response.json({ error: 'Method not allowed' }, { status: 405 });
  }
  
  try {
    const base44 = createClientFromRequest(req);
    const body = await req.json();
    const { action, chain } = body;
    
    // Get config status
    if (action === 'get_config') {
      return Response.json({
        eth_mnemonic_configured: !!DEPOSIT_MNEMONIC_ETH,
        btc_mnemonic_configured: !!DEPOSIT_MNEMONIC_BTC,
        eth_hot_wallet: HOT_WALLET_ADDRESS_ETH || null,
        btc_hot_wallet: HOT_WALLET_ADDRESS_BTC || null,
        min_sweep_eth: MIN_SWEEP_AMOUNT_ETH,
        min_sweep_btc: MIN_SWEEP_AMOUNT_BTC,
        testnet: TATUM_TESTNET
      });
    }
    
    // Run sweep for specific chain (admin only)
    if (action === 'sweep') {
      const user = await base44.auth.me();
      if (!user || user.role !== 'admin') {
        return Response.json({ error: 'Admin access required' }, { status: 403 });
      }
      
      if (!chain || !['ETH', 'BTC'].includes(chain)) {
        return Response.json({ error: 'chain must be ETH or BTC' }, { status: 400 });
      }
      
      const results = await runSweep(base44, chain);
      return Response.json({
        chain,
        swept_count: results.filter(r => r.txHash).length,
        skipped_count: results.filter(r => r.skipped).length,
        error_count: results.filter(r => r.error).length,
        results
      });
    }
    
    // Sweep all chains (admin only or scheduled job)
    if (action === 'sweep_all') {
      // Allow both admin users and scheduled jobs (no auth)
      const user = await base44.auth.me().catch(() => null);
      const isScheduledJob = req.headers.get('X-Base44-Scheduled') === 'true';
      
      if (!user && !isScheduledJob) {
        // For non-scheduled, non-authenticated requests, check if it's internal
        const isInternal = req.headers.get('X-Base44-Internal') === 'true';
        if (!isInternal) {
          return Response.json({ error: 'Authentication required' }, { status: 401 });
        }
      }
      
      const ethResults = DEPOSIT_MNEMONIC_ETH && HOT_WALLET_ADDRESS_ETH 
        ? await runSweep(base44, 'ETH') 
        : [];
      const btcResults = DEPOSIT_MNEMONIC_BTC && HOT_WALLET_ADDRESS_BTC 
        ? await runSweep(base44, 'BTC') 
        : [];
      
      return Response.json({
        ETH: {
          configured: !!(DEPOSIT_MNEMONIC_ETH && HOT_WALLET_ADDRESS_ETH),
          swept_count: ethResults.filter(r => r.txHash).length,
          skipped_count: ethResults.filter(r => r.skipped).length,
          error_count: ethResults.filter(r => r.error).length,
          results: ethResults
        },
        BTC: {
          configured: !!(DEPOSIT_MNEMONIC_BTC && HOT_WALLET_ADDRESS_BTC),
          swept_count: btcResults.filter(r => r.txHash).length,
          skipped_count: btcResults.filter(r => r.skipped).length,
          error_count: btcResults.filter(r => r.error).length,
          results: btcResults
        }
      });
    }
    
    // Get hot wallet balances
    if (action === 'get_hot_wallet_balances') {
      const ethBalance = HOT_WALLET_ADDRESS_ETH 
        ? await getAddressBalance('ETH', HOT_WALLET_ADDRESS_ETH)
        : '0';
      const btcBalance = HOT_WALLET_ADDRESS_BTC
        ? await getAddressBalance('BTC', HOT_WALLET_ADDRESS_BTC)
        : '0';
      
      return Response.json({
        ETH: { address: HOT_WALLET_ADDRESS_ETH || null, balance: ethBalance },
        BTC: { address: HOT_WALLET_ADDRESS_BTC || null, balance: btcBalance }
      });
    }
    
    // Get all deposit address balances (admin only)
    if (action === 'get_deposit_balances') {
      const user = await base44.auth.me();
      if (!user || user.role !== 'admin') {
        return Response.json({ error: 'Admin access required' }, { status: 403 });
      }
      
      const targetChain = chain || 'ETH';
      const depositAddresses = await base44.asServiceRole.entities.WorkerDepositAddress.filter({
        chain: targetChain,
        status: 'active'
      });
      
      const balances = [];
      for (const deposit of depositAddresses) {
        const balance = await getAddressBalance(targetChain, deposit.address);
        balances.push({
          address: deposit.address,
          worker_id: deposit.worker_id,
          derivation_index: deposit.derivation_index,
          balance
        });
      }
      
      const totalBalance = balances.reduce((sum, b) => sum + parseFloat(b.balance || '0'), 0);
      
      return Response.json({
        chain: targetChain,
        total_addresses: balances.length,
        total_balance: totalBalance.toString(),
        addresses: balances
      });
    }
    
    // Sweep specific worker's deposit address for escrow funding
    if (action === 'sweep_worker') {
      const { worker_id, amount } = body;
      
      if (!worker_id || !chain || !['ETH', 'BTC'].includes(chain)) {
        return Response.json({ error: 'worker_id and chain (ETH/BTC) required' }, { status: 400 });
      }
      
      const mnemonic = chain === 'ETH' ? DEPOSIT_MNEMONIC_ETH : DEPOSIT_MNEMONIC_BTC;
      const hotWallet = chain === 'ETH' ? HOT_WALLET_ADDRESS_ETH : HOT_WALLET_ADDRESS_BTC;
      
      if (!mnemonic || !hotWallet) {
        return Response.json({ error: `${chain} sweep not configured` }, { status: 500 });
      }
      
      // Get worker's deposit address
      const depositAddresses = await base44.asServiceRole.entities.WorkerDepositAddress.filter({
        worker_id: worker_id,
        chain: chain,
        status: 'active'
      });
      
      if (depositAddresses.length === 0) {
        return Response.json({ 
          skipped: true, 
          reason: 'No deposit address for worker' 
        });
      }
      
      const deposit = depositAddresses[0];
      
      // Check on-chain balance
      const onChainBalance = await getAddressBalance(chain, deposit.address);
      console.log(`[sweep_worker] Worker ${worker_id} deposit ${deposit.address}: on-chain balance = ${onChainBalance} ${chain}`);
      
      // If balance is too low, skip (funds may already be swept)
      const minSweep = chain === 'ETH' ? 0.0005 : 0.00005; // Lower threshold for escrow sweeps
      if (parseFloat(onChainBalance) < minSweep) {
        return Response.json({
          skipped: true,
          reason: `On-chain balance ${onChainBalance} below minimum ${minSweep}`,
          address: deposit.address,
          on_chain_balance: onChainBalance
        });
      }
      
      // Sweep to hot wallet
      try {
        let sweepResult;
        if (chain === 'ETH') {
          sweepResult = await sweepEthAddress(deposit.address, deposit.derivation_index, onChainBalance);
        } else {
          sweepResult = await sweepBtcAddress(deposit.address, deposit.derivation_index, onChainBalance);
        }
        
        if (sweepResult.skipped) {
          return Response.json({
            skipped: true,
            reason: sweepResult.reason,
            address: deposit.address
          });
        }
        
        // Log sweep event
        await base44.asServiceRole.entities.Event.create({
          event_type: 'deposit_swept',
          entity_type: 'deposit',
          entity_id: deposit.address,
          actor_type: 'system',
          actor_id: 'escrow_sweep',
          details: JSON.stringify({
            chain,
            from: deposit.address,
            to: hotWallet,
            amount: sweepResult.amount,
            tx_hash: sweepResult.txHash,
            worker_id: worker_id,
            trigger: 'task_escrow'
          })
        });
        
        return Response.json({
          success: true,
          tx_hash: sweepResult.txHash,
          amount: sweepResult.amount,
          from: deposit.address,
          to: hotWallet,
          worker_id: worker_id
        });
        
      } catch (err) {
        console.error(`[sweep_worker] Sweep failed:`, err.message);
        return Response.json({
          error: err.message,
          address: deposit.address,
          on_chain_balance: onChainBalance
        }, { status: 500 });
      }
    }
    
    return Response.json({ error: 'Unknown action' }, { status: 400 });
    
  } catch (error) {
    console.error('Sweep error:', error);
    return Response.json({ error: error.message }, { status: 500 });
  }
});