import { createClientFromRequest } from 'npm:@base44/sdk@0.8.6';

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

      return Response.json({
        success: true,
        sweep_id: sweep.id,
        chain,
        amount,
        destination_address,
        status: 'requested',
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

    return Response.json({ error: 'Unknown action' }, { status: 400 });
  } catch (error) {
    console.error('Admin protocol error:', error);
    return Response.json({ error: error.message }, { status: 500 });
  }
});