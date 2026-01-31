import { createClientFromRequest } from 'npm:@base44/sdk@0.8.6';

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

    return Response.json({ error: 'Unknown action' }, { status: 400 });
  } catch (error) {
    console.error('Admin protocol error:', error);
    return Response.json({ error: error.message }, { status: 500 });
  }
});