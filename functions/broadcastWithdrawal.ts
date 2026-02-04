import { createClientFromRequest } from 'npm:@base44/sdk@0.8.6';

const TATUM_API_KEY = Deno.env.get('TATUM_API_KEY_MAINNET') || Deno.env.get('TATUM_API_KEY');
const TATUM_TESTNET = Deno.env.get('TATUM_TESTNET') === 'true';

// Hot wallet mnemonics for signing
const HOT_WALLET_MNEMONIC_ETH = Deno.env.get('HOT_WALLET_MNEMONIC_ETH');
const HOT_WALLET_MNEMONIC_BTC = Deno.env.get('HOT_WALLET_MNEMONIC_BTC');

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

function addDecimal(a, b) {
  return fromScaled(toScaled(a) + toScaled(b));
}

function subtractDecimal(a, b) {
  const result = toScaled(a) - toScaled(b);
  return fromScaled(result < 0n ? 0n : result);
}

/**
 * Refund locked funds back to available on failure
 */
async function refundLockedFunds(base44, withdrawal) {
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
      action: 'withdrawal_failed_refund'
    })
  });

  return { newAvailable, newLocked };
}

/**
 * Deduct from locked balance on successful broadcast (funds leave system)
 */
async function deductLockedFunds(base44, withdrawal) {
  const accounts = await base44.asServiceRole.entities.LedgerAccount.filter({
    owner_type: 'worker',
    owner_id: withdrawal.worker_id,
    chain: withdrawal.chain
  });

  if (accounts.length === 0) return;

  const account = accounts[0];
  const newLocked = subtractDecimal(account.locked_balance || '0', withdrawal.amount);

  await base44.asServiceRole.entities.LedgerAccount.update(account.id, {
    locked_balance: newLocked
  });

  await base44.asServiceRole.entities.LedgerEntry.create({
    chain: withdrawal.chain,
    amount: withdrawal.amount,
    entry_type: 'payout',
    from_owner_type: 'worker',
    from_owner_id: withdrawal.worker_id,
    to_owner_type: null,
    to_owner_id: null,
    metadata: JSON.stringify({
      withdrawal_id: withdrawal.id,
      destination_address: withdrawal.destination_address,
      action: 'withdrawal_broadcasted'
    })
  });
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
 * Verify transaction exists on-chain via Tatum
 * Uses longer waits and more attempts to account for propagation delay
 */
async function verifyTransactionOnChain(txHash, maxAttempts = 5) {
  const tatumChain = TATUM_TESTNET ? 'ethereum-sepolia' : 'ethereum';
  
  console.log(`[verifyTransactionOnChain] Starting verification for ${txHash}, max ${maxAttempts} attempts`);
  
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    // Wait longer on each attempt (3s, 5s, 8s, 12s, 15s)
    const waitTime = (attempt + 1) * 2000 + (attempt * 1000);
    console.log(`[verifyTransactionOnChain] Attempt ${attempt + 1}/${maxAttempts}, waiting ${waitTime}ms...`);
    await new Promise(r => setTimeout(r, waitTime));
    
    try {
      const response = await fetch(`https://api.tatum.io/v3/${tatumChain}/transaction/${txHash}`, {
        headers: { 'x-api-key': TATUM_API_KEY }
      });
      
      const responseText = await response.text();
      console.log(`[verifyTransactionOnChain] Attempt ${attempt + 1} response status=${response.status}: ${responseText.slice(0, 500)}`);
      
      if (response.ok) {
        let txData;
        try {
          txData = JSON.parse(responseText);
        } catch (e) {
          console.log(`[verifyTransactionOnChain] Non-JSON response, tx likely not found`);
          continue;
        }
        
        // Check for actual tx data - Tatum returns blockNumber when tx is mined
        // or at least the hash if it's in the mempool
        if (txData && (txData.blockNumber || txData.blockHash || txData.hash === txHash)) {
          console.log(`[verifyTransactionOnChain] TX ${txHash} VERIFIED on attempt ${attempt + 1}, blockNumber: ${txData.blockNumber}`);
          return { verified: true, txData };
        }
        
        // Tatum might return empty object or error object
        if (!txData || Object.keys(txData).length === 0) {
          console.log(`[verifyTransactionOnChain] Empty response, tx not found`);
          continue;
        }
      } else if (response.status === 404 || response.status === 403) {
        // TX definitely not found
        console.log(`[verifyTransactionOnChain] TX ${txHash} not found (${response.status})`);
      }
    } catch (err) {
      console.error(`[verifyTransactionOnChain] Error on attempt ${attempt + 1}:`, err.message);
    }
  }
  
  console.log(`[verifyTransactionOnChain] TX ${txHash} NOT VERIFIED after ${maxAttempts} attempts`);
  return { verified: false };
}

/**
 * Get current nonce for an address from Tatum
 */
async function getAddressNonce(address) {
  const tatumChain = TATUM_TESTNET ? 'ethereum-sepolia' : 'ethereum';
  
  try {
    const response = await fetch(`https://api.tatum.io/v3/${tatumChain}/transaction/count/${address}`, {
      headers: { 'x-api-key': TATUM_API_KEY }
    });
    
    if (response.ok) {
      const count = await response.json();
      console.log(`[getAddressNonce] Address ${address} nonce: ${count}`);
      return count;
    }
    console.error(`[getAddressNonce] Failed to get nonce: ${response.status}`);
    return null;
  } catch (err) {
    console.error(`[getAddressNonce] Error: ${err.message}`);
    return null;
  }
}

/**
 * Get hot wallet address from mnemonic
 */
async function getHotWalletAddress() {
  const tatumChain = TATUM_TESTNET ? 'ethereum-sepolia' : 'ethereum';
  
  // First derive the xpub
  const xpubResponse = await fetch(`https://api.tatum.io/v3/${tatumChain}/wallet`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': TATUM_API_KEY
    },
    body: JSON.stringify({ mnemonic: HOT_WALLET_MNEMONIC_ETH })
  });
  
  if (!xpubResponse.ok) {
    console.error('[getHotWalletAddress] Failed to get xpub');
    return null;
  }
  
  const { xpub } = await xpubResponse.json();
  
  // Then derive address at index 0
  const addrResponse = await fetch(`https://api.tatum.io/v3/${tatumChain}/address/${xpub}/0`, {
    headers: { 'x-api-key': TATUM_API_KEY }
  });
  
  if (!addrResponse.ok) {
    console.error('[getHotWalletAddress] Failed to derive address');
    return null;
  }
  
  const { address } = await addrResponse.json();
  console.log(`[getHotWalletAddress] Hot wallet address: ${address}`);
  return address;
}

/**
 * Broadcast ETH transaction via Tatum
 * 
 * IMPORTANT: Tatum's /transaction endpoint with fromPrivateKey should sign AND broadcast.
 * However, we've seen cases where it returns a hash but doesn't actually broadcast.
 * We now verify on-chain before returning success.
 */
async function broadcastEthTransaction(amount, destinationAddress) {
  if (!HOT_WALLET_MNEMONIC_ETH) {
    throw new Error('HOT_WALLET_MNEMONIC_ETH not configured');
  }

  const tatumChain = TATUM_TESTNET ? 'ethereum-sepolia' : 'ethereum';

  // Derive private key from hot wallet mnemonic (index 0)
  const privateKey = await deriveEthPrivateKey(HOT_WALLET_MNEMONIC_ETH, 0);

  // Get hot wallet address and current nonce for debugging
  const hotWalletAddress = await getHotWalletAddress();
  const currentNonce = hotWalletAddress ? await getAddressNonce(hotWalletAddress) : null;

  // Format amount - Tatum expects string with max 18 decimals
  // Keep reasonable precision (up to 12 decimals) to avoid rounding issues
  const formattedAmount = parseFloat(amount).toFixed(12).replace(/\.?0+$/, '');

  console.log(`[broadcastEthTransaction] ====== STARTING ETH BROADCAST ======`);
  console.log(`[broadcastEthTransaction] Chain: ${tatumChain}`);
  console.log(`[broadcastEthTransaction] Hot Wallet: ${hotWalletAddress}`);
  console.log(`[broadcastEthTransaction] Current Nonce: ${currentNonce}`);
  console.log(`[broadcastEthTransaction] To: ${destinationAddress}`);
  console.log(`[broadcastEthTransaction] Amount: ${formattedAmount} ETH`);
  console.log(`[broadcastEthTransaction] Private key derived: ${privateKey ? 'YES' : 'NO'} (length: ${privateKey?.length || 0})`);
  
  // Add gas price buffer to ensure tx gets included
  // gasPrice is in Wei - 50 Gwei = 50,000,000,000 Wei
  const requestBody = {
    to: destinationAddress,
    amount: formattedAmount,
    currency: 'ETH',
    fromPrivateKey: privateKey,
    fee: {
      gasLimit: '21000',
      gasPrice: '50000000000' // 50 Gwei in Wei
    }
  };
  
  console.log(`[broadcastEthTransaction] Request body (without key): to=${requestBody.to}, amount=${requestBody.amount}, currency=${requestBody.currency}`);
  
  const response = await fetch(`https://api.tatum.io/v3/${tatumChain}/transaction`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': TATUM_API_KEY
    },
    body: JSON.stringify(requestBody)
  });

  // Log raw response for debugging
  const responseText = await response.text();
  console.log(`[broadcastEthTransaction] Tatum HTTP status: ${response.status} ${response.statusText}`);
  console.log(`[broadcastEthTransaction] Tatum response body: ${responseText}`);
  
  let data;
  try {
    data = JSON.parse(responseText);
  } catch (parseErr) {
    console.error(`[broadcastEthTransaction] Failed to parse response as JSON`);
    throw new Error(`Tatum returned non-JSON response: ${responseText.slice(0, 500)}`);
  }

  // Log parsed response structure
  console.log(`[broadcastEthTransaction] Parsed response keys: ${Object.keys(data).join(', ')}`);
  console.log(`[broadcastEthTransaction] txId: ${data.txId}, txHash: ${data.txHash}, signatureId: ${data.signatureId}`);

  if (!response.ok) {
    console.error('[broadcastEthTransaction] ====== TATUM ERROR ======');
    console.error(`[broadcastEthTransaction] Status: ${response.status}`);
    console.error(`[broadcastEthTransaction] Message: ${data.message || data.msg || 'N/A'}`);
    console.error(`[broadcastEthTransaction] Data: ${JSON.stringify(data.data || data)}`);
    console.error(`[broadcastEthTransaction] ErrorCode: ${data.errorCode || 'N/A'}`);
    
    // Include full error data in message
    const errorMsg = data.message || data.msg || (data.data ? JSON.stringify(data.data) : null) || `Tatum ETH broadcast failed: ${response.status}`;
    throw new Error(errorMsg);
  }
  
  const txHash = data.txId || data.txHash;
  
  // signatureId means Tatum is using KMS (custodial) which signs async - we need actual txHash
  if (data.signatureId && !txHash) {
    console.error(`[broadcastEthTransaction] Got signatureId but no txHash - Tatum using KMS mode?`);
    throw new Error(`Tatum returned signatureId (${data.signatureId}) but no txHash. KMS mode not supported.`);
  }
  
  if (!txHash) {
    console.error(`[broadcastEthTransaction] No txHash in response: ${JSON.stringify(data)}`);
    throw new Error('No transaction hash returned from Tatum');
  }
  
  console.log(`[broadcastEthTransaction] ====== GOT TX HASH: ${txHash} ======`);
  console.log(`[broadcastEthTransaction] Now verifying transaction exists on-chain...`);
  
  // CRITICAL: Verify the transaction actually exists on-chain before returning success
  const verification = await verifyTransactionOnChain(txHash);
  
  if (!verification.verified) {
    console.error(`[broadcastEthTransaction] ====== VERIFICATION FAILED ======`);
    console.error(`[broadcastEthTransaction] TX ${txHash} was NOT found on-chain after multiple attempts`);
    console.error(`[broadcastEthTransaction] This means Tatum signed but did NOT broadcast the transaction`);
    throw new Error(`Transaction ${txHash} was signed but NOT found on-chain after 5 attempts. Tatum broadcast likely failed silently.`);
  }
  
  console.log(`[broadcastEthTransaction] ====== SUCCESS ======`);
  console.log(`[broadcastEthTransaction] TX ${txHash} verified on-chain`);
  
  return {
    txHash: txHash,
    providerReference: data.signatureId || data.txId,
    verified: true,
    blockNumber: verification.txData?.blockNumber
  };
}

/**
 * Broadcast BTC transaction via Tatum
 */
async function broadcastBtcTransaction(amount, destinationAddress) {
  if (!HOT_WALLET_MNEMONIC_BTC) {
    throw new Error('HOT_WALLET_MNEMONIC_BTC not configured');
  }

  const tatumChain = TATUM_TESTNET ? 'bitcoin-testnet' : 'bitcoin';

  // For BTC, we need to use the sendTransaction endpoint
  const response = await fetch(`https://api.tatum.io/v3/${tatumChain}/transaction`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': TATUM_API_KEY
    },
    body: JSON.stringify({
      fromAddress: [{
        mnemonic: HOT_WALLET_MNEMONIC_BTC,
        index: 0
      }],
      to: [{
        address: destinationAddress,
        value: parseFloat(amount)
      }]
    })
  });

  if (!response.ok) {
    const errData = await response.json().catch(() => ({}));
    throw new Error(errData.message || `Tatum BTC broadcast failed: ${response.status}`);
  }

  const data = await response.json();
  return {
    txHash: data.txId || data.txHash || data.signatureId,
    providerReference: data.signatureId || data.txId
  };
}

/**
 * Main broadcast function
 */
async function broadcastWithdrawal(base44, withdrawalId) {
  console.log(`[broadcastWithdrawal] Starting broadcast for withdrawal ${withdrawalId}`);
  
  // Fetch withdrawal
  const withdrawals = await base44.asServiceRole.entities.WithdrawalRequest.filter({
    id: withdrawalId
  });

  if (withdrawals.length === 0) {
    console.log(`[broadcastWithdrawal] Withdrawal not found: ${withdrawalId}`);
    throw new Error('Withdrawal not found');
  }

  const withdrawal = withdrawals[0];
  console.log(`[broadcastWithdrawal] Withdrawal found:`, JSON.stringify({
    id: withdrawal.id,
    status: withdrawal.status,
    chain: withdrawal.chain,
    amount: withdrawal.amount,
    destination: withdrawal.destination_address,
    tx_hash: withdrawal.tx_hash
  }));

  // IDEMPOTENCY CHECK: Only broadcast if status is 'approved'
  // If already broadcasted/confirmed/failed, skip
  if (withdrawal.status !== 'approved') {
    console.log(`[broadcastWithdrawal] Not in approved state, skipping. Current status: ${withdrawal.status}`);
    return {
      withdrawal_id: withdrawalId,
      status: withdrawal.status,
      message: `Withdrawal not in approved state (current: ${withdrawal.status})`,
      idempotent: true
    };
  }

  // Additional idempotency: check if tx_hash already exists
  if (withdrawal.tx_hash) {
    return {
      withdrawal_id: withdrawalId,
      status: withdrawal.status,
      tx_hash: withdrawal.tx_hash,
      message: 'Withdrawal already has tx_hash',
      idempotent: true
    };
  }

  const chain = withdrawal.chain;
  const amount = withdrawal.amount;
  const destinationAddress = withdrawal.destination_address;

  let txHash = null;
  let providerReference = null;
  let broadcastError = null;

  try {
    console.log(`[broadcastWithdrawal] Attempting ${chain} broadcast:`, JSON.stringify({
      amount,
      destinationAddress,
      eth_mnemonic_configured: !!HOT_WALLET_MNEMONIC_ETH,
      btc_mnemonic_configured: !!HOT_WALLET_MNEMONIC_BTC,
      tatum_api_key_configured: !!TATUM_API_KEY,
      testnet: TATUM_TESTNET
    }));
    
    // Broadcast based on chain
    if (chain === 'ETH') {
      const result = await broadcastEthTransaction(amount, destinationAddress);
      txHash = result.txHash;
      providerReference = result.providerReference;
      console.log(`[broadcastWithdrawal] ETH broadcast success:`, JSON.stringify(result));
    } else if (chain === 'BTC') {
      const result = await broadcastBtcTransaction(amount, destinationAddress);
      txHash = result.txHash;
      providerReference = result.providerReference;
      console.log(`[broadcastWithdrawal] BTC broadcast success:`, JSON.stringify(result));
    } else {
      throw new Error(`Unsupported chain: ${chain}`);
    }

    // SUCCESS: Update withdrawal to broadcasted
    await base44.asServiceRole.entities.WithdrawalRequest.update(withdrawalId, {
      status: 'broadcasted',
      tx_hash: txHash
    });

    // Deduct from locked balance (funds have left the system)
    await deductLockedFunds(base44, withdrawal);

    // Emit success event
    await base44.asServiceRole.entities.Event.create({
      event_type: 'funds_withdrawn',
      entity_type: 'worker',
      entity_id: withdrawal.worker_id,
      actor_type: 'system',
      actor_id: 'tatum',
      details: JSON.stringify({
        withdrawal_id: withdrawalId,
        status: 'broadcasted',
        chain,
        amount,
        destination_address: destinationAddress,
        tx_hash: txHash,
        provider_reference: providerReference
      })
    });

    return {
      withdrawal_id: withdrawalId,
      status: 'broadcasted',
      chain,
      amount,
      destination_address: destinationAddress,
      tx_hash: txHash,
      provider_reference: providerReference
    };

  } catch (err) {
    broadcastError = err.message;
    console.error(`[broadcastWithdrawal] Broadcast FAILED:`, JSON.stringify({
      withdrawal_id: withdrawalId,
      chain,
      amount,
      destination: destinationAddress,
      error: broadcastError,
      error_stack: err.stack
    }));

    // FAILURE: Update withdrawal to failed
    await base44.asServiceRole.entities.WithdrawalRequest.update(withdrawalId, {
      status: 'failed',
      failure_reason: broadcastError
    });

    // Refund locked funds back to available
    const refundResult = await refundLockedFunds(base44, withdrawal);

    // Emit failure event
    await base44.asServiceRole.entities.Event.create({
      event_type: 'system_error',
      entity_type: 'worker',
      entity_id: withdrawal.worker_id,
      actor_type: 'system',
      actor_id: 'tatum',
      details: JSON.stringify({
        withdrawal_id: withdrawalId,
        status: 'failed',
        chain,
        amount,
        destination_address: destinationAddress,
        error: broadcastError,
        refunded: true,
        new_available: refundResult?.newAvailable,
        new_locked: refundResult?.newLocked
      })
    });

    return {
      withdrawal_id: withdrawalId,
      status: 'failed',
      rejection_reason: broadcastError,
      chain,
      amount,
      destination_address: destinationAddress,
      refunded: true
    };
  }
}

Deno.serve(async (req) => {
  if (req.method !== 'POST') {
    return Response.json({ error: 'Method not allowed' }, { status: 405 });
  }

  try {
    const base44 = createClientFromRequest(req);
    const body = await req.json();
    const { action, withdrawal_id } = body;

    // Check config status
    if (action === 'get_config_status') {
      return Response.json({
        tatum_configured: !!TATUM_API_KEY,
        eth_wallet_configured: !!HOT_WALLET_MNEMONIC_ETH,
        btc_wallet_configured: !!HOT_WALLET_MNEMONIC_BTC,
        testnet: TATUM_TESTNET
      });
    }

    // Broadcast single withdrawal
    if (action === 'broadcast' || !action) {
      if (!withdrawal_id) {
        return Response.json({ error: 'withdrawal_id required' }, { status: 400 });
      }

      if (!TATUM_API_KEY) {
        return Response.json({ error: 'TATUM_API_KEY not configured' }, { status: 500 });
      }

      const result = await broadcastWithdrawal(base44, withdrawal_id);
      return Response.json(result);
    }

    // Admin: Retry failed withdrawals
    if (action === 'retry_failed') {
      const user = await base44.auth.me();
      if (!user || user.role !== 'admin') {
        return Response.json({ error: 'Admin access required' }, { status: 403 });
      }

      if (!withdrawal_id) {
        return Response.json({ error: 'withdrawal_id required' }, { status: 400 });
      }

      // Reset to approved so it can be broadcast again
      const withdrawals = await base44.asServiceRole.entities.WithdrawalRequest.filter({
        id: withdrawal_id
      });

      if (withdrawals.length === 0) {
        return Response.json({ error: 'Withdrawal not found' }, { status: 404 });
      }

      const withdrawal = withdrawals[0];
      if (withdrawal.status !== 'failed') {
        return Response.json({ error: 'Only failed withdrawals can be retried' }, { status: 400 });
      }

      // Re-lock funds (they were refunded on failure)
      const accounts = await base44.asServiceRole.entities.LedgerAccount.filter({
        owner_type: 'worker',
        owner_id: withdrawal.worker_id,
        chain: withdrawal.chain
      });

      if (accounts.length > 0) {
        const account = accounts[0];
        const availableBalance = account.available_balance || '0';

        if (toScaled(withdrawal.amount) > toScaled(availableBalance)) {
          return Response.json({ 
            error: 'Insufficient balance to retry withdrawal',
            available: availableBalance,
            required: withdrawal.amount
          }, { status: 400 });
        }

        const newAvailable = subtractDecimal(availableBalance, withdrawal.amount);
        const newLocked = addDecimal(account.locked_balance || '0', withdrawal.amount);

        await base44.asServiceRole.entities.LedgerAccount.update(account.id, {
          available_balance: newAvailable,
          locked_balance: newLocked
        });
      }

      // Reset to approved
      await base44.asServiceRole.entities.WithdrawalRequest.update(withdrawal_id, {
        status: 'approved',
        failure_reason: null,
        tx_hash: null
      });

      // Attempt broadcast
      const result = await broadcastWithdrawal(base44, withdrawal_id);
      return Response.json({ ...result, retried: true });
    }

    // Admin: Process all approved withdrawals
    if (action === 'process_approved') {
      const user = await base44.auth.me();
      if (!user || user.role !== 'admin') {
        return Response.json({ error: 'Admin access required' }, { status: 403 });
      }

      const approved = await base44.asServiceRole.entities.WithdrawalRequest.filter({
        status: 'approved'
      });

      const results = [];
      for (const w of approved) {
        try {
          const result = await broadcastWithdrawal(base44, w.id);
          results.push(result);
        } catch (err) {
          results.push({
            withdrawal_id: w.id,
            status: 'error',
            error: err.message
          });
        }
      }

      return Response.json({
        processed: results.length,
        results
      });
    }

    return Response.json({ error: 'Unknown action' }, { status: 400 });
  } catch (error) {
    console.error('Broadcast error:', error);
    return Response.json({ error: error.message }, { status: 500 });
  }
});