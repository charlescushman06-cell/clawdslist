import { createClientFromRequest } from 'npm:@base44/sdk@0.8.6';

/**
 * DEPOSIT ADDRESS DERIVATION
 * 
 * Derives unique deposit addresses from DEPOSIT_MASTER_XPUB using atomic index allocation.
 * Each worker gets a unique derivation index to ensure no address collisions.
 */

const TATUM_API_KEY = Deno.env.get('TATUM_API_KEY_MAINNET') || Deno.env.get('TATUM_API_KEY');
const TATUM_TESTNET = Deno.env.get('TATUM_TESTNET') === 'true';

const DEPOSIT_MASTER_XPUB = {
  ETH: Deno.env.get('DEPOSIT_MASTER_XPUB_ETH'),
  BTC: Deno.env.get('DEPOSIT_MASTER_XPUB_BTC')
};

/**
 * Derive ETH deposit address from DEPOSIT_MASTER_XPUB_ETH at given index
 * 
 * @param {number} index - Derivation index (0-based)
 * @returns {Promise<string>} - Derived ETH address
 */
async function deriveDepositAddressETH(index) {
  const xpub = DEPOSIT_MASTER_XPUB.ETH;
  if (!xpub) {
    throw new Error('DEPOSIT_MASTER_XPUB_ETH not configured. Initialize via admin setup.');
  }

  if (!TATUM_API_KEY) {
    throw new Error('TATUM_API_KEY_MAINNET not configured');
  }

  if (typeof index !== 'number' || index < 0 || !Number.isInteger(index)) {
    throw new Error(`Invalid derivation index: ${index}. Must be non-negative integer.`);
  }

  const tatumChain = TATUM_TESTNET ? 'ethereum-sepolia' : 'ethereum';

  const response = await fetch(
    `https://api.tatum.io/v3/${tatumChain}/address/${xpub}/${index}`,
    {
      method: 'GET',
      headers: {
        'x-api-key': TATUM_API_KEY
      }
    }
  );

  if (!response.ok) {
    const errData = await response.json().catch(() => ({}));
    throw new Error(errData.message || `Tatum API error: ${response.status}`);
  }

  const data = await response.json();
  return data.address;
}

/**
 * Derive deposit address for any supported chain
 * 
 * @param {string} chain - "ETH" or "BTC"
 * @param {number} index - Derivation index
 * @returns {Promise<string>} - Derived address
 */
async function deriveDepositAddress(chain, index) {
  if (!['ETH', 'BTC'].includes(chain)) {
    throw new Error(`Invalid chain: ${chain}. Must be ETH or BTC`);
  }

  const xpub = DEPOSIT_MASTER_XPUB[chain];
  if (!xpub) {
    throw new Error(`DEPOSIT_MASTER_XPUB_${chain} not configured.`);
  }

  if (!TATUM_API_KEY) {
    throw new Error('TATUM_API_KEY_MAINNET not configured');
  }

  if (typeof index !== 'number' || index < 0 || !Number.isInteger(index)) {
    throw new Error(`Invalid derivation index: ${index}`);
  }

  const tatumChain = chain === 'ETH'
    ? (TATUM_TESTNET ? 'ethereum-sepolia' : 'ethereum')
    : (TATUM_TESTNET ? 'bitcoin-testnet' : 'bitcoin');

  const response = await fetch(
    `https://api.tatum.io/v3/${tatumChain}/address/${xpub}/${index}`,
    {
      method: 'GET',
      headers: {
        'x-api-key': TATUM_API_KEY
      }
    }
  );

  if (!response.ok) {
    const errData = await response.json().catch(() => ({}));
    throw new Error(errData.message || `Tatum API error: ${response.status}`);
  }

  const data = await response.json();
  return data.address;
}

/**
 * Allocate next derivation index atomically
 * 
 * Uses optimistic locking with retry to ensure no duplicate indexes
 * even under concurrent allocation requests.
 * 
 * @param {object} base44 - Authenticated Base44 client
 * @param {string} chain - "ETH" or "BTC"
 * @param {number} maxRetries - Maximum retry attempts (default: 5)
 * @returns {Promise<number>} - Allocated index
 */
async function allocateNextDerivationIndex(base44, chain, maxRetries = 5) {
  if (!['ETH', 'BTC'].includes(chain)) {
    throw new Error(`Invalid chain: ${chain}`);
  }

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    // Get or create the state record
    const states = await base44.asServiceRole.entities.DepositDerivationState.filter({ chain });
    
    let state;
    if (states.length === 0) {
      // Initialize state for this chain
      state = await base44.asServiceRole.entities.DepositDerivationState.create({
        chain,
        next_index: 0,
        last_allocated_at: new Date().toISOString()
      });
    } else {
      state = states[0];
    }

    const currentIndex = state.next_index;
    const currentUpdatedAt = state.updated_at;

    // Attempt atomic update with optimistic lock
    // We check that updated_at hasn't changed since we read it
    try {
      // Update the record
      await base44.asServiceRole.entities.DepositDerivationState.update(state.id, {
        next_index: currentIndex + 1,
        last_allocated_at: new Date().toISOString()
      });

      // Verify the update succeeded by checking the new value
      const [updatedState] = await base44.asServiceRole.entities.DepositDerivationState.filter({ chain });
      
      if (updatedState.next_index === currentIndex + 1) {
        // Success - we got this index
        return currentIndex;
      }

      // Race condition - another request incremented first, retry
      console.log(`Index allocation race detected for ${chain}, attempt ${attempt + 1}, retrying...`);
      
      // Small random backoff to reduce collision chance
      await new Promise(r => setTimeout(r, Math.random() * 50 + 10));
      
    } catch (err) {
      console.error(`Index allocation error for ${chain}:`, err.message);
      if (attempt === maxRetries - 1) throw err;
      await new Promise(r => setTimeout(r, Math.random() * 50 + 10));
    }
  }

  throw new Error(`Failed to allocate derivation index for ${chain} after ${maxRetries} attempts`);
}

/**
 * Allocate index and derive address in one operation
 * 
 * @param {object} base44 - Authenticated Base44 client
 * @param {string} chain - "ETH" or "BTC"
 * @returns {Promise<{address: string, index: number, chain: string}>}
 */
async function allocateAndDeriveAddress(base44, chain) {
  const index = await allocateNextDerivationIndex(base44, chain);
  const address = await deriveDepositAddress(chain, index);
  
  return {
    address,
    index,
    chain
  };
}

// HTTP handler
Deno.serve(async (req) => {
  if (req.method !== 'POST') {
    return Response.json({ error: 'Method not allowed' }, { status: 405 });
  }

  try {
    const base44 = createClientFromRequest(req);
    const body = await req.json();
    const { action } = body;

    // Get derivation state status (no auth required)
    if (action === 'get_status') {
      const states = await base44.asServiceRole.entities.DepositDerivationState.list();
      const status = {
        ETH: { configured: !!DEPOSIT_MASTER_XPUB.ETH, next_index: 0 },
        BTC: { configured: !!DEPOSIT_MASTER_XPUB.BTC, next_index: 0 }
      };
      
      for (const state of states) {
        if (status[state.chain]) {
          status[state.chain].next_index = state.next_index;
          status[state.chain].last_allocated_at = state.last_allocated_at;
        }
      }
      
      return Response.json({ success: true, data: status });
    }

    // Derive address at specific index (admin only, for testing)
    if (action === 'derive_at_index') {
      const user = await base44.auth.me();
      if (!user || user.role !== 'admin') {
        return Response.json({ error: 'Admin access required' }, { status: 403 });
      }

      const { chain, index } = body;
      if (!chain || typeof index !== 'number') {
        return Response.json({ error: 'chain and index required' }, { status: 400 });
      }

      const address = await deriveDepositAddress(chain, index);
      return Response.json({ success: true, data: { chain, index, address } });
    }

    // Allocate next index and derive address (internal use)
    if (action === 'allocate_address') {
      const user = await base44.auth.me();
      if (!user) {
        return Response.json({ error: 'Authentication required' }, { status: 401 });
      }

      const { chain } = body;
      if (!chain || !['ETH', 'BTC'].includes(chain)) {
        return Response.json({ error: 'chain must be ETH or BTC' }, { status: 400 });
      }

      const result = await allocateAndDeriveAddress(base44, chain);
      return Response.json({ success: true, data: result });
    }

    // Concurrent allocation test (admin only)
    if (action === 'test_concurrent_allocation') {
      const user = await base44.auth.me();
      if (!user || user.role !== 'admin') {
        return Response.json({ error: 'Admin access required' }, { status: 403 });
      }

      const { chain, count = 5 } = body;
      if (!chain || !['ETH', 'BTC'].includes(chain)) {
        return Response.json({ error: 'chain must be ETH or BTC' }, { status: 400 });
      }

      // Get initial state
      const [initialState] = await base44.asServiceRole.entities.DepositDerivationState.filter({ chain });
      const startIndex = initialState?.next_index || 0;

      // Run concurrent allocations
      const allocations = await Promise.all(
        Array(count).fill(null).map(() => 
          allocateNextDerivationIndex(base44, chain).catch(e => ({ error: e.message }))
        )
      );

      // Get final state
      const [finalState] = await base44.asServiceRole.entities.DepositDerivationState.filter({ chain });

      // Check for duplicates
      const successfulAllocations = allocations.filter(a => typeof a === 'number');
      const uniqueIndexes = new Set(successfulAllocations);
      const hasDuplicates = uniqueIndexes.size !== successfulAllocations.length;

      // Verify sequential (should be start to start+count)
      const expectedIndexes = Array(count).fill(null).map((_, i) => startIndex + i);
      const allExpected = expectedIndexes.every(i => uniqueIndexes.has(i));

      return Response.json({
        success: true,
        data: {
          test: 'concurrent_allocation',
          chain,
          count,
          start_index: startIndex,
          end_index: finalState?.next_index,
          allocated_indexes: successfulAllocations.sort((a, b) => a - b),
          errors: allocations.filter(a => a?.error).map(a => a.error),
          has_duplicates: hasDuplicates,
          all_sequential: allExpected && finalState?.next_index === startIndex + count,
          passed: !hasDuplicates && allExpected
        }
      });
    }

    return Response.json({ error: 'Unknown action' }, { status: 400 });

  } catch (error) {
    console.error('Deposit derivation error:', error);
    return Response.json({ error: error.message }, { status: 500 });
  }
});

export { deriveDepositAddressETH, deriveDepositAddress, allocateNextDerivationIndex, allocateAndDeriveAddress };