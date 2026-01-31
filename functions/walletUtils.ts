import { createClientFromRequest } from 'npm:@base44/sdk@0.8.6';

/**
 * WALLET UTILITIES
 * 
 * Address derivation using HD wallet xpubs via Tatum API.
 * 
 * SECURITY NOTES:
 * - xpub (extended public key) is SAFE to store - it can only derive public addresses
 * - mnemonic/seed phrase is SECRET - NEVER log or store it
 * - Private keys are derived from mnemonic, not xpub
 * 
 * ARCHITECTURE:
 * - Master xpubs stored as environment secrets
 * - Each worker gets a unique derivation index
 * - Addresses derived deterministically from xpub + index
 */

const TATUM_API_KEY = Deno.env.get('TATUM_API_KEY_MAINNET') || Deno.env.get('TATUM_API_KEY');
const TATUM_TESTNET = Deno.env.get('TATUM_TESTNET') === 'true';

const MASTER_XPUB = {
  ETH: Deno.env.get('MASTER_XPUB_ETH'),
  BTC: Deno.env.get('MASTER_XPUB_BTC')
};

// Deposit master xpubs (for worker deposit address derivation)
const DEPOSIT_MASTER_XPUB = {
  ETH: Deno.env.get('DEPOSIT_MASTER_XPUB_ETH'),
  BTC: Deno.env.get('DEPOSIT_MASTER_XPUB_BTC')
};

/**
 * Derive address from master xpub at given index
 * 
 * @param {string} chain - "ETH" or "BTC"
 * @param {number} index - Derivation index (0-based)
 * @returns {Promise<{address: string, chain: string, index: number}>}
 */
async function deriveAddress(chain, index) {
  if (!['ETH', 'BTC'].includes(chain)) {
    throw new Error(`Invalid chain: ${chain}. Must be ETH or BTC`);
  }

  const xpub = MASTER_XPUB[chain];
  if (!xpub) {
    throw new Error(`MASTER_XPUB_${chain} not configured. Set via environment secrets.`);
  }

  if (!TATUM_API_KEY) {
    throw new Error('TATUM_API_KEY_MAINNET not configured');
  }

  if (typeof index !== 'number' || index < 0) {
    throw new Error(`Invalid derivation index: ${index}`);
  }

  // Tatum API endpoint for address derivation
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
  
  return {
    address: data.address,
    chain,
    index
  };
}

/**
 * Generate a new HD wallet via Tatum (returns xpub + mnemonic)
 * 
 * WARNING: Mnemonic is returned but should NEVER be logged or stored in database.
 * Store only the xpub in environment secrets.
 * 
 * @param {string} chain - "ETH" or "BTC"
 * @returns {Promise<{xpub: string, mnemonic: string}>}
 */
async function generateWallet(chain) {
  if (!['ETH', 'BTC'].includes(chain)) {
    throw new Error(`Invalid chain: ${chain}. Must be ETH or BTC`);
  }

  if (!TATUM_API_KEY) {
    throw new Error('TATUM_API_KEY_MAINNET not configured');
  }

  const tatumChain = chain === 'ETH'
    ? (TATUM_TESTNET ? 'ethereum-sepolia' : 'ethereum')
    : (TATUM_TESTNET ? 'bitcoin-testnet' : 'bitcoin');

  const response = await fetch(
    `https://api.tatum.io/v3/${tatumChain}/wallet`,
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

  // Return both but warn about security
  return {
    xpub: data.xpub,
    mnemonic: data.mnemonic // WARNING: Store securely offline, NOT in database
  };
}

/**
 * Check if master xpubs are configured
 */
function getXpubStatus() {
  const maskXpub = (xpub) => {
    if (!xpub) return null;
    return `${xpub.substring(0, 8)}...${xpub.substring(xpub.length - 8)}`;
  };

  return {
    // Hot wallet xpubs (for withdrawals)
    hot_wallet: {
      ETH: !!MASTER_XPUB.ETH,
      ETH_fingerprint: maskXpub(MASTER_XPUB.ETH),
      BTC: !!MASTER_XPUB.BTC,
      BTC_fingerprint: maskXpub(MASTER_XPUB.BTC)
    },
    // Deposit master xpubs (for worker deposit addresses)
    deposit_master: {
      ETH: !!DEPOSIT_MASTER_XPUB.ETH,
      ETH_fingerprint: maskXpub(DEPOSIT_MASTER_XPUB.ETH),
      BTC: !!DEPOSIT_MASTER_XPUB.BTC,
      BTC_fingerprint: maskXpub(DEPOSIT_MASTER_XPUB.BTC)
    },
    api_configured: !!TATUM_API_KEY,
    testnet: TATUM_TESTNET
  };
}

/**
 * Derive deposit address from deposit master xpub
 */
async function deriveDepositAddress(chain, index) {
  if (!['ETH', 'BTC'].includes(chain)) {
    throw new Error(`Invalid chain: ${chain}. Must be ETH or BTC`);
  }

  const xpub = DEPOSIT_MASTER_XPUB[chain];
  if (!xpub) {
    throw new Error(`DEPOSIT_MASTER_XPUB_${chain} not configured. Initialize via admin setup.`);
  }

  if (!TATUM_API_KEY) {
    throw new Error('TATUM_API_KEY_MAINNET not configured');
  }

  if (typeof index !== 'number' || index < 0) {
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
  
  return {
    address: data.address,
    chain,
    index,
    purpose: 'deposit'
  };
}

// HTTP handler for admin actions
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

    const body = await req.json();
    const { action } = body;

    // Check xpub configuration status
    if (action === 'get_xpub_status') {
      return Response.json(getXpubStatus());
    }

    // Derive address (for testing)
    if (action === 'derive_address') {
      const { chain, index } = body;
      const result = await deriveAddress(chain, index);
      return Response.json(result);
    }

    // Generate new wallet (returns xpub + mnemonic)
    // WARNING: Mnemonic shown ONCE - admin must store it securely offline
    if (action === 'generate_wallet') {
      const { chain } = body;
      
      if (!chain || !['ETH', 'BTC'].includes(chain)) {
        return Response.json({ error: 'chain must be ETH or BTC' }, { status: 400 });
      }

      const wallet = await generateWallet(chain);

      // Log event (without mnemonic!)
      await base44.asServiceRole.entities.Event.create({
        event_type: 'system_error', // Using as system notification
        entity_type: 'system',
        entity_id: `wallet_generated_${chain}`,
        actor_type: 'admin',
        actor_id: user.id,
        details: JSON.stringify({
          action: 'wallet_generated',
          chain,
          xpub_preview: wallet.xpub.substring(0, 20) + '...',
          timestamp: new Date().toISOString(),
          note: 'Store mnemonic securely offline. Set xpub as MASTER_XPUB_' + chain
        })
      });

      return Response.json({
        chain,
        xpub: wallet.xpub,
        mnemonic: wallet.mnemonic,
        warning: 'SECURITY: Store mnemonic securely OFFLINE. Never log or store in database. Set xpub as environment secret MASTER_XPUB_' + chain
      });
    }

    // Initialize Deposit Master wallet
    // Generates xpub + mnemonic; mnemonic shown ONCE, only xpub should be stored
    if (action === 'init_deposit_master') {
      const { chain } = body;
      
      if (!chain || !['ETH', 'BTC'].includes(chain)) {
        return Response.json({ error: 'chain must be ETH or BTC' }, { status: 400 });
      }

      // Check if already configured
      if (DEPOSIT_MASTER_XPUB[chain]) {
        return Response.json({ 
          error: `DEPOSIT_MASTER_XPUB_${chain} is already configured. Cannot reinitialize.`,
          configured: true,
          fingerprint: `${DEPOSIT_MASTER_XPUB[chain].substring(0, 8)}...${DEPOSIT_MASTER_XPUB[chain].substring(DEPOSIT_MASTER_XPUB[chain].length - 8)}`
        }, { status: 400 });
      }

      const wallet = await generateWallet(chain);

      // Log event (without mnemonic!)
      await base44.asServiceRole.entities.Event.create({
        event_type: 'deposit_master_initialized',
        entity_type: 'system',
        entity_id: `deposit_master_${chain}`,
        actor_type: 'admin',
        actor_id: user.id,
        details: JSON.stringify({
          chain,
          xpub_fingerprint: `${wallet.xpub.substring(0, 8)}...${wallet.xpub.substring(wallet.xpub.length - 8)}`,
          timestamp: new Date().toISOString(),
          note: 'Deposit master wallet initialized. xpub must be set as DEPOSIT_MASTER_XPUB_' + chain
        })
      });

      return Response.json({
        success: true,
        chain,
        xpub: wallet.xpub,
        mnemonic: wallet.mnemonic,
        secret_name: `DEPOSIT_MASTER_XPUB_${chain}`,
        warning: '⚠️ CRITICAL: Copy the mnemonic NOW and store it OFFLINE in a secure location. It will NOT be shown again. Never store the mnemonic in code, logs, or databases. Set the xpub as environment secret DEPOSIT_MASTER_XPUB_' + chain
      });
    }

    // Derive deposit address (for testing or manual use)
    if (action === 'derive_deposit_address') {
      const { chain, index } = body;
      const result = await deriveDepositAddress(chain, index);
      return Response.json(result);
    }

    return Response.json({ error: 'Unknown action' }, { status: 400 });

  } catch (error) {
    console.error('Wallet utils error:', error);
    return Response.json({ error: error.message }, { status: 500 });
  }
});

// Export for use in other functions
export { deriveAddress, deriveDepositAddress, generateWallet, getXpubStatus };