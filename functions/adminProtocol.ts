import { createClientFromRequest } from 'npm:@base44/sdk@0.8.6';

const TATUM_API_KEY = Deno.env.get('TATUM_API_KEY');
const TATUM_TESTNET = Deno.env.get('TATUM_TESTNET') === 'true';

/**
 * CENTRAL TREASURY ADDRESS RESOLVER
 * 
 * ALL protocol fee operations MUST use this function to get treasury addresses.
 * Do NOT hardcode addresses elsewhere - this ensures:
 * 1. Single source of truth for treasury destinations
 * 2. Consistent validation across all operations
 * 3. Audit trail for address changes
 * 4. Prevents accidental fund loss to wrong addresses
 * 
 * @param {object} base44 - SDK client instance
 * @param {string} chain - "ETH" or "BTC"
 * @returns {Promise<string>} - Validated treasury address
 * @throws {Error} - If address missing or invalid
 */
async function getTreasuryAddress(base44, chain) {
  if (!['ETH', 'BTC'].includes(chain)) {
    throw new Error(`Invalid chain: ${chain}. Must be ETH or BTC`);
  }

  const configs = await base44.asServiceRole.entities.ProtocolConfig.filter({
    config_key: 'treasury_addresses'
  });

  if (configs.length === 0) {
    throw new Error('TREASURY_NOT_CONFIGURED: Treasury addresses not set. Configure via set_treasury_addresses.');
  }

  const config = configs[0];
  const address = chain === 'ETH' ? config.eth_treasury_address : config.btc_treasury_address;

  if (!address) {
    throw new Error(`TREASURY_NOT_CONFIGURED: ${chain} treasury address not set.`);
  }

  // Validate format
  if (chain === 'ETH' && !/^0x[a-fA-F0-9]{40}$/.test(address)) {
    throw new Error(`TREASURY_INVALID: ${chain} treasury address has invalid format.`);
  }

  if (chain === 'BTC') {
    const btcValid = /^(1|3)[a-km-zA-HJ-NP-Z1-9]{25,34}$/.test(address) || 
                     /^bc1[a-z0-9]{39,59}$/.test(address);
    if (!btcValid) {
      throw new Error(`TREASURY_INVALID: ${chain} treasury address has invalid format.`);
    }
  }

  return address;
}

/**
 * Check if treasury is ready for a given chain (non-throwing version)
 */
async function isTreasuryReady(base44, chain) {
  try {
    await getTreasuryAddress(base44, chain);
    return true;
  } catch {
    return false;
  }
}

// Decimal-safe math
const SCALE = BigInt(10 ** 18);

function toScaled(amount) {
  if (!amount) return 0n;
  if (typeof amount === 'string') {
    const [whole, frac = ''] = amount.split('.');
    const paddedFrac = frac.padEnd(18, '0').slice(0, 18);
    return BigInt(whole + paddedFrac);
  }
  return BigInt(Math.round(Number(amount) * 1e18));
}

function fromScaled(scaled) {
  const str = scaled.toString().padStart(19, '0');
  const whole = str.slice(0, -18) || '0';
  const frac = str.slice(-18).replace(/0+$/, '') || '0';
  return frac === '0' ? whole : `${whole}.${frac}`;
}

function subtractDecimal(a, b) {
  const result = toScaled(a) - toScaled(b);
  return fromScaled(result < 0n ? 0n : result);
}

function addDecimal(a, b) {
  return fromScaled(toScaled(a) + toScaled(b));
}

function compareDecimal(a, b) {
  const scaledA = toScaled(a);
  const scaledB = toScaled(b);
  if (scaledA > scaledB) return 1;
  if (scaledA < scaledB) return -1;
  return 0;
}

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();

    if (!user || user.role !== 'admin') {
      return Response.json({ error: 'Admin access required' }, { status: 403 });
    }

    const body = await req.json();
    const { action } = body;

    // GET protocol balances by chain
    if (action === 'get_balances') {
      const accounts = await base44.asServiceRole.entities.LedgerAccount.filter({
        owner_type: 'protocol'
      });

      const balances = {};
      for (const account of accounts) {
        balances[account.chain] = {
          available_balance: account.available_balance || '0',
          locked_balance: account.locked_balance || '0',
          updated_at: account.updated_date
        };
      }

      // Ensure both chains are present
      if (!balances.ETH) balances.ETH = { available_balance: '0', locked_balance: '0' };
      if (!balances.BTC) balances.BTC = { available_balance: '0', locked_balance: '0' };

      return Response.json(balances);
    }

    // GET protocol ledger entries with optional chain filter
    if (action === 'get_ledger_entries') {
      const { chain, limit = 50 } = body;

      const filter = {
        to_owner_type: 'protocol',
        entry_type: 'protocol_fee_accrual'
      };
      
      if (chain) {
        filter.chain = chain;
      }

      const entries = await base44.asServiceRole.entities.LedgerEntry.filter(
        filter,
        '-created_date',
        limit
      );

      // Link to events if available
      const entriesWithEvents = await Promise.all(entries.map(async (entry) => {
        let eventId = null;
        try {
          const meta = JSON.parse(entry.metadata || '{}');
          if (meta.settlement_id) {
            // Find related event by settlement_id in details
            const events = await base44.asServiceRole.entities.Event.filter({
              entity_id: entry.id
            }, '-created_date', 1);
            
            if (events.length > 0) {
              eventId = events[0].id;
            }
          }
        } catch {}
        
        return {
          ...entry,
          event_id: eventId
        };
      }));

      return Response.json({ entries: entriesWithEvents });
    }

    // GET aggregated stats (24h, 7d)
    if (action === 'get_stats') {
      const now = new Date();
      const oneDayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);
      const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

      // Fetch all protocol fee accrual entries
      const allEntries = await base44.asServiceRole.entities.LedgerEntry.filter({
        to_owner_type: 'protocol',
        entry_type: 'protocol_fee_accrual'
      }, '-created_date', 500);

      let last24h = 0n;
      let last7d = 0n;
      const SCALE = BigInt(10 ** 18);

      function toScaled(amount) {
        if (!amount) return 0n;
        if (typeof amount === 'string') {
          const [whole, frac = ''] = amount.split('.');
          const paddedFrac = frac.padEnd(18, '0').slice(0, 18);
          return BigInt(whole + paddedFrac);
        }
        return BigInt(Math.round(Number(amount) * 1e18));
      }

      function fromScaled(scaled) {
        const str = scaled.toString().padStart(19, '0');
        const whole = str.slice(0, -18) || '0';
        const frac = str.slice(-18).replace(/0+$/, '') || '0';
        return frac === '0' ? whole : `${whole}.${frac}`;
      }

      for (const entry of allEntries) {
        const createdDate = new Date(entry.created_date);
        const amountScaled = toScaled(entry.amount);

        if (createdDate >= oneDayAgo) {
          last24h += amountScaled;
        }
        if (createdDate >= sevenDaysAgo) {
          last7d += amountScaled;
        }
      }

      return Response.json({
        last_24h: fromScaled(last24h),
        last_7d: fromScaled(last7d),
        total_entries: allEntries.length
      });
    }

    // POST /admin/sweep_fees - Request a protocol fee sweep
    if (action === 'sweep_fees') {
      const { chain, amount, destination_address } = body;

      // Validation
      if (!chain || !['ETH', 'BTC'].includes(chain)) {
        return Response.json({ error: 'Invalid chain. Must be ETH or BTC' }, { status: 400 });
      }
      if (!amount || compareDecimal(amount, '0') <= 0) {
        return Response.json({ error: 'Amount must be greater than 0' }, { status: 400 });
      }
      if (!destination_address) {
        return Response.json({ error: 'destination_address is required' }, { status: 400 });
      }

      /**
       * MANDATORY: Use central treasury resolver for all sweep operations.
       * This ensures consistent validation and prevents hardcoded addresses.
       */
      let treasuryAddress;
      try {
        treasuryAddress = await getTreasuryAddress(base44, chain);
      } catch (treasuryError) {
        await base44.asServiceRole.entities.Event.create({
          event_type: 'system_error',
          entity_type: 'transaction',
          entity_id: 'sweep_blocked',
          actor_type: 'admin',
          actor_id: user.id,
          details: JSON.stringify({
            status: 'treasury_not_configured',
            action: 'sweep_blocked',
            chain,
            amount,
            reason: treasuryError.message
          })
        });
        return Response.json({ 
          error: treasuryError.message,
          status: 'treasury_not_configured'
        }, { status: 400 });
      }

      // Validate destination matches treasury (prevent sending to arbitrary addresses)
      if (destination_address !== treasuryAddress) {
        return Response.json({
          error: `Destination must match configured ${chain} treasury address: ${treasuryAddress}`,
          expected_address: treasuryAddress
        }, { status: 400 });
      }

      // Get protocol account
      const accounts = await base44.asServiceRole.entities.LedgerAccount.filter({
        owner_type: 'protocol',
        chain
      });

      if (accounts.length === 0) {
        return Response.json({ error: `Protocol account not found for chain ${chain}` }, { status: 404 });
      }

      const protocolAccount = accounts[0];
      const availableBalance = protocolAccount.available_balance || '0';

      // Check sufficient balance
      if (compareDecimal(amount, availableBalance) > 0) {
        return Response.json({ 
          error: `Insufficient balance. Available: ${availableBalance}, Requested: ${amount}` 
        }, { status: 400 });
      }

      // Create sweep record
      const sweep = await base44.asServiceRole.entities.Sweep.create({
        chain,
        amount,
        destination_address,
        status: 'requested',
        requested_by: user.id
      });

      // Lock funds: move from available to locked
      const newAvailable = subtractDecimal(availableBalance, amount);
      const newLocked = addDecimal(protocolAccount.locked_balance || '0', amount);

      await base44.asServiceRole.entities.LedgerAccount.update(protocolAccount.id, {
        available_balance: newAvailable,
        locked_balance: newLocked
      });

      // Create ledger entry
      await base44.asServiceRole.entities.LedgerEntry.create({
        chain,
        amount,
        entry_type: 'lock',
        from_owner_type: 'protocol',
        from_owner_id: null,
        to_owner_type: 'protocol',
        to_owner_id: null,
        metadata: JSON.stringify({
          sweep_id: sweep.id,
          destination_address,
          action: 'protocol_fee_sweep_requested'
        })
      });

      // Emit event
      await base44.asServiceRole.entities.Event.create({
        event_type: 'funds_locked',
        entity_type: 'transaction',
        entity_id: sweep.id,
        actor_type: 'admin',
        actor_id: user.id,
        details: JSON.stringify({
          stage: 'protocol_fee_sweep_requested',
          chain,
          amount,
          destination_address,
          sweep_id: sweep.id,
          new_available: newAvailable,
          new_locked: newLocked
        })
      });

      // Broadcast to Tatum
      let txHash = null;
      let broadcastError = null;

      try {
        const tatumChain = chain === 'ETH' 
          ? (TATUM_TESTNET ? 'ethereum-sepolia' : 'ethereum-mainnet')
          : (TATUM_TESTNET ? 'bitcoin-testnet' : 'bitcoin-mainnet');

        // Get protocol custody wallet for this chain
        const wallets = await base44.asServiceRole.entities.Worker.filter({});
        // Protocol uses a dedicated source - for now we'll use a configured address
        // In production, this would come from Tatum's managed wallets
        
        const tatumResponse = await fetch(`https://api.tatum.io/v3/${chain.toLowerCase()}/transaction`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': TATUM_API_KEY
          },
          body: JSON.stringify({
            to: destination_address,
            amount: amount,
            currency: chain
          })
        });

        if (!tatumResponse.ok) {
          const errData = await tatumResponse.json();
          throw new Error(errData.message || `Tatum API error: ${tatumResponse.status}`);
        }

        const tatumData = await tatumResponse.json();
        txHash = tatumData.txId || tatumData.txHash || tatumData.id;

        // Update sweep to broadcasted
        await base44.asServiceRole.entities.Sweep.update(sweep.id, {
          status: 'broadcasted',
          tx_hash: txHash
        });

        // Emit broadcasted event
        await base44.asServiceRole.entities.Event.create({
          event_type: 'funds_transferred',
          entity_type: 'transaction',
          entity_id: sweep.id,
          actor_type: 'system',
          actor_id: 'tatum',
          details: JSON.stringify({
            stage: 'protocol_fee_sweep_broadcasted',
            chain,
            amount,
            destination_address,
            sweep_id: sweep.id,
            tx_hash: txHash
          })
        });

      } catch (err) {
        broadcastError = err.message;

        // Rollback: return locked funds to available
        const rollbackAvailable = addDecimal(newAvailable, amount);
        const rollbackLocked = subtractDecimal(newLocked, amount);

        await base44.asServiceRole.entities.LedgerAccount.update(protocolAccount.id, {
          available_balance: rollbackAvailable,
          locked_balance: rollbackLocked
        });

        // Update sweep to failed
        await base44.asServiceRole.entities.Sweep.update(sweep.id, {
          status: 'failed',
          failure_reason: broadcastError
        });

        // Create unlock ledger entry
        await base44.asServiceRole.entities.LedgerEntry.create({
          chain,
          amount,
          entry_type: 'unlock',
          from_owner_type: 'protocol',
          from_owner_id: null,
          to_owner_type: 'protocol',
          to_owner_id: null,
          metadata: JSON.stringify({
            sweep_id: sweep.id,
            action: 'protocol_fee_sweep_failed_rollback',
            reason: broadcastError
          })
        });

        // Emit failed event
        await base44.asServiceRole.entities.Event.create({
          event_type: 'system_error',
          entity_type: 'transaction',
          entity_id: sweep.id,
          actor_type: 'system',
          actor_id: 'tatum',
          details: JSON.stringify({
            stage: 'protocol_fee_sweep_failed',
            chain,
            amount,
            destination_address,
            sweep_id: sweep.id,
            error: broadcastError,
            rollback_available: rollbackAvailable,
            rollback_locked: rollbackLocked
          })
        });

        return Response.json({
          success: false,
          sweep_id: sweep.id,
          chain,
          amount,
          destination_address,
          status: 'failed',
          error: broadcastError,
          protocol_balance: {
            available: rollbackAvailable,
            locked: rollbackLocked
          }
        }, { status: 500 });
      }

      return Response.json({
        success: true,
        sweep_id: sweep.id,
        chain,
        amount,
        destination_address,
        status: 'broadcasted',
        tx_hash: txHash,
        protocol_balance: {
          available: newAvailable,
          locked: newLocked
        }
      });
    }

    // GET sweeps list
    if (action === 'list_sweeps') {
      const { chain, status, limit = 50 } = body;
      
      const filter = {};
      if (chain) filter.chain = chain;
      if (status) filter.status = status;

      const sweeps = await base44.asServiceRole.entities.Sweep.filter(
        filter,
        '-created_date',
        limit
      );

      return Response.json({ sweeps });
    }

    // GET single sweep by ID
    if (action === 'get_sweep') {
      const { sweep_id } = body;

      if (!sweep_id) {
        return Response.json({ error: 'sweep_id required' }, { status: 400 });
      }

      const sweeps = await base44.asServiceRole.entities.Sweep.filter({ id: sweep_id });

      if (sweeps.length === 0) {
        return Response.json({ error: 'Sweep not found' }, { status: 404 });
      }

      return Response.json({ sweep: sweeps[0] });
    }

    /**
     * TREASURY ADDRESS MANAGEMENT
     * 
     * Treasury addresses are stored in ProtocolConfig entity with config_key='treasury_addresses'.
     * 
     * To set/update treasury addresses:
     * 1. Call action='set_treasury_addresses' with eth_treasury_address (required) and btc_treasury_address (optional)
     * 2. Or manually create/update ProtocolConfig record with config_key='treasury_addresses'
     * 
     * These addresses are used as destinations for protocol fee sweeps.
     * Do NOT auto-generate or infer from workers/Tatum - must be explicitly set by admin.
     * 
     * Validation:
     * - ETH: must be 0x + 40 hex characters
     * - BTC: basic format check (26-62 alphanumeric, starting with 1, 3, or bc1)
     */

    // Address validation helpers
    function isValidEthAddress(address) {
      if (!address || typeof address !== 'string') return false;
      return /^0x[a-fA-F0-9]{40}$/.test(address);
    }

    function isValidBtcAddress(address) {
      if (!address || typeof address !== 'string') return false;
      // Basic BTC format: P2PKH (1...), P2SH (3...), Bech32 (bc1...)
      return /^(1|3)[a-km-zA-HJ-NP-Z1-9]{25,34}$/.test(address) || 
             /^bc1[a-z0-9]{39,59}$/.test(address);
    }

    // GET treasury addresses with validation status
    if (action === 'get_treasury_addresses') {
      const configs = await base44.asServiceRole.entities.ProtocolConfig.filter({
        config_key: 'treasury_addresses'
      });

      if (configs.length === 0) {
        return Response.json({
          eth_treasury_address: null,
          btc_treasury_address: null,
          configured: false,
          treasury_ready: false,
          validation: {
            eth_valid: false,
            btc_valid: false,
            status: 'treasury_not_configured'
          }
        });
      }

      const config = configs[0];
      const ethValid = isValidEthAddress(config.eth_treasury_address);
      const btcValid = !config.btc_treasury_address || isValidBtcAddress(config.btc_treasury_address);
      const treasuryReady = ethValid; // ETH is required

      return Response.json({
        eth_treasury_address: config.eth_treasury_address || null,
        btc_treasury_address: config.btc_treasury_address || null,
        configured: true,
        treasury_ready: treasuryReady,
        validation: {
          eth_valid: ethValid,
          btc_valid: btcValid,
          status: treasuryReady ? 'treasury_configured' : 'treasury_invalid'
        },
        updated_at: config.updated_date
      });
    }

    // Validate treasury status (for system checks) - uses central resolver
    if (action === 'validate_treasury') {
      const ethReady = await isTreasuryReady(base44, 'ETH');
      const btcReady = await isTreasuryReady(base44, 'BTC');

      let ethAddress = null;
      let btcAddress = null;

      try { ethAddress = await getTreasuryAddress(base44, 'ETH'); } catch {}
      try { btcAddress = await getTreasuryAddress(base44, 'BTC'); } catch {}

      const treasuryReady = ethReady; // ETH is required minimum

      // Emit validation event
      await base44.asServiceRole.entities.Event.create({
        event_type: treasuryReady ? 'funds_deposited' : 'system_error',
        entity_type: 'system',
        entity_id: 'treasury_validation',
        actor_type: 'system',
        actor_id: 'validator',
        details: JSON.stringify({
          status: treasuryReady ? 'treasury_address_configured' : 'treasury_address_invalid',
          eth_address: ethAddress,
          eth_valid: ethReady,
          btc_address: btcAddress,
          btc_valid: btcReady,
          sweep_enabled: treasuryReady
        })
      });

      return Response.json({
        valid: treasuryReady,
        status: treasuryReady ? 'treasury_address_configured' : 'treasury_address_invalid',
        sweep_enabled: treasuryReady,
        validation: { eth_valid: ethReady, btc_valid: btcReady },
        addresses: { eth: ethAddress, btc: btcAddress }
      });
    }

    // SET treasury addresses with validation
    if (action === 'set_treasury_addresses') {
      const { eth_treasury_address, btc_treasury_address, notes } = body;

      // Check if treasury is already configured (locked)
      const existingConfigs = await base44.asServiceRole.entities.ProtocolConfig.filter({
        config_key: 'treasury_addresses'
      });

      if (existingConfigs.length > 0) {
        const existing = existingConfigs[0];
        const alreadyConfigured = isValidEthAddress(existing.eth_treasury_address);
        
        if (alreadyConfigured) {
          return Response.json({ 
            error: 'Treasury addresses are locked and cannot be changed once configured.',
            status: 'treasury_locked'
          }, { status: 403 });
        }
      }

      if (!eth_treasury_address) {
        return Response.json({ error: 'eth_treasury_address is required' }, { status: 400 });
      }

      // Validate ETH address format
      if (!isValidEthAddress(eth_treasury_address)) {
        await base44.asServiceRole.entities.Event.create({
          event_type: 'system_error',
          entity_type: 'system',
          entity_id: 'treasury_config',
          actor_type: 'admin',
          actor_id: user.id,
          details: JSON.stringify({
            status: 'treasury_address_invalid',
            eth_address: eth_treasury_address,
            reason: 'Invalid ETH address format (expected 0x + 40 hex chars)'
          })
        });
        return Response.json({ 
          error: 'Invalid ETH address format. Must be 0x followed by 40 hex characters.' 
        }, { status: 400 });
      }

      // Validate BTC address if provided
      if (btc_treasury_address && !isValidBtcAddress(btc_treasury_address)) {
        await base44.asServiceRole.entities.Event.create({
          event_type: 'system_error',
          entity_type: 'system',
          entity_id: 'treasury_config',
          actor_type: 'admin',
          actor_id: user.id,
          details: JSON.stringify({
            status: 'treasury_address_invalid',
            btc_address: btc_treasury_address,
            reason: 'Invalid BTC address format'
          })
        });
        return Response.json({ 
          error: 'Invalid BTC address format.' 
        }, { status: 400 });
      }

      // Find existing config
      const configs = await base44.asServiceRole.entities.ProtocolConfig.filter({
        config_key: 'treasury_addresses'
      });

      let config;
      if (configs.length > 0) {
        config = await base44.asServiceRole.entities.ProtocolConfig.update(configs[0].id, {
          eth_treasury_address,
          btc_treasury_address: btc_treasury_address || null,
          notes: notes || configs[0].notes
        });
      } else {
        config = await base44.asServiceRole.entities.ProtocolConfig.create({
          config_key: 'treasury_addresses',
          eth_treasury_address,
          btc_treasury_address: btc_treasury_address || null,
          notes: notes || 'Protocol treasury addresses'
        });
      }

      // Emit success event
      await base44.asServiceRole.entities.Event.create({
        event_type: 'funds_deposited', // Using as positive system event
        entity_type: 'system',
        entity_id: config.id,
        actor_type: 'admin',
        actor_id: user.id,
        details: JSON.stringify({
          status: 'treasury_address_configured',
          eth_treasury_address,
          btc_treasury_address: btc_treasury_address || null,
          sweep_enabled: true
        })
      });

      return Response.json({
        success: true,
        eth_treasury_address,
        btc_treasury_address: btc_treasury_address || null,
        treasury_ready: true,
        sweep_enabled: true
      });
    }

    return Response.json({ error: 'Unknown action' }, { status: 400 });
  } catch (error) {
    console.error('Admin protocol error:', error);
    return Response.json({ error: error.message }, { status: 500 });
  }
});