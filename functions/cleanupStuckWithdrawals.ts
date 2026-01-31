import { createClientFromRequest } from 'npm:@base44/sdk@0.8.6';

// Decimal math helpers
const toScaled = (amt) => {
  if (!amt) return 0n;
  const str = String(amt).trim();
  if (!str || str === '0') return 0n;
  const [whole, frac = ''] = str.split('.');
  return BigInt((whole || '0') + frac.padEnd(18, '0').slice(0, 18));
};

const fromScaled = (scaled) => {
  if (scaled < 0n) scaled = 0n;
  const str = scaled.toString().padStart(19, '0');
  const whole = str.slice(0, -18) || '0';
  const frac = str.slice(-18).replace(/0+$/, '') || '0';
  return frac === '0' ? whole : `${whole}.${frac}`;
};

const addDecimal = (a, b) => fromScaled(toScaled(a) + toScaled(b));
const subDecimal = (a, b) => fromScaled(toScaled(a) - toScaled(b));

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    
    // Admin check
    const user = await base44.auth.me();
    if (!user || user.role !== 'admin') {
      return Response.json({ error: 'Admin access required' }, { status: 403 });
    }

    const body = await req.json().catch(() => ({}));
    const action = body.action || 'cleanup_risk_hold';

    // ========== CLEANUP RISK_HOLD WITHDRAWALS ==========
    if (action === 'cleanup_risk_hold') {
      const stuckWithdrawals = await base44.asServiceRole.entities.WithdrawalRequest.filter({
        status: 'risk_hold'
      });

      console.log(`[cleanupStuckWithdrawals] Found ${stuckWithdrawals.length} stuck risk_hold withdrawals`);

      const results = [];

      for (const w of stuckWithdrawals) {
        try {
          // Find worker's ledger account for this chain
          const ledgers = await base44.asServiceRole.entities.LedgerAccount.filter({
            owner_type: 'worker',
            owner_id: w.worker_id,
            chain: w.chain
          });

          if (ledgers.length === 0) {
            console.warn(`[cleanupStuckWithdrawals] No ledger found for worker ${w.worker_id}, chain ${w.chain}`);
            results.push({ withdrawal_id: w.id, status: 'error', reason: 'No ledger account found' });
            continue;
          }

          const ledger = ledgers[0];
          const withdrawAmount = w.amount;

          // Release: locked -> available
          const newAvailable = addDecimal(ledger.available_balance || '0', withdrawAmount);
          const newLocked = subDecimal(ledger.locked_balance || '0', withdrawAmount);

          await base44.asServiceRole.entities.LedgerAccount.update(ledger.id, {
            available_balance: newAvailable,
            locked_balance: newLocked
          });

          // Mark withdrawal as cancelled
          await base44.asServiceRole.entities.WithdrawalRequest.update(w.id, {
            status: 'cancelled',
            failure_reason: 'Risk hold system removed - auto-cancelled'
          });

          // Create ledger entry for the unlock
          await base44.asServiceRole.entities.LedgerEntry.create({
            chain: w.chain,
            amount: withdrawAmount,
            entry_type: 'unlock',
            from_owner_type: 'worker',
            from_owner_id: w.worker_id,
            to_owner_type: 'worker',
            to_owner_id: w.worker_id,
            metadata: JSON.stringify({
              withdrawal_id: w.id,
              action: 'risk_hold_cleanup',
              reason: 'Risk hold system removed'
            })
          });

          // Log event
          await base44.asServiceRole.entities.Event.create({
            event_type: 'funds_unlocked',
            entity_type: 'worker',
            entity_id: w.worker_id,
            actor_type: 'admin',
            actor_id: user.id,
            details: JSON.stringify({
              withdrawal_id: w.id,
              chain: w.chain,
              amount: withdrawAmount,
              action: 'risk_hold_cleanup',
              new_available: newAvailable,
              new_locked: newLocked
            })
          });

          console.log(`[cleanupStuckWithdrawals] Released ${withdrawAmount} ${w.chain} for withdrawal ${w.id}`);
          results.push({
            withdrawal_id: w.id,
            worker_id: w.worker_id,
            chain: w.chain,
            amount: withdrawAmount,
            status: 'released',
            new_available: newAvailable,
            new_locked: newLocked
          });

        } catch (err) {
          console.error(`[cleanupStuckWithdrawals] Error processing withdrawal ${w.id}:`, err);
          results.push({ withdrawal_id: w.id, status: 'error', reason: err.message });
        }
      }

      return Response.json({
        success: true,
        processed: results.length,
        results
      });
    }

    // ========== FIX SPECIFIC WITHDRAWAL ==========
    if (action === 'fix_withdrawal') {
      const { withdrawal_id } = body;
      if (!withdrawal_id) {
        return Response.json({ error: 'withdrawal_id required' }, { status: 400 });
      }

      const withdrawals = await base44.asServiceRole.entities.WithdrawalRequest.filter({
        id: withdrawal_id
      });

      if (withdrawals.length === 0) {
        return Response.json({ error: 'Withdrawal not found' }, { status: 404 });
      }

      const w = withdrawals[0];

      // Find worker's ledger account
      const ledgers = await base44.asServiceRole.entities.LedgerAccount.filter({
        owner_type: 'worker',
        owner_id: w.worker_id,
        chain: w.chain
      });

      if (ledgers.length === 0) {
        return Response.json({ error: 'No ledger account found' }, { status: 404 });
      }

      const ledger = ledgers[0];
      const withdrawAmount = w.amount;

      // Release: locked -> available
      const newAvailable = addDecimal(ledger.available_balance || '0', withdrawAmount);
      const newLocked = subDecimal(ledger.locked_balance || '0', withdrawAmount);

      await base44.asServiceRole.entities.LedgerAccount.update(ledger.id, {
        available_balance: newAvailable,
        locked_balance: newLocked
      });

      // Mark withdrawal as cancelled
      await base44.asServiceRole.entities.WithdrawalRequest.update(w.id, {
        status: 'cancelled',
        failure_reason: body.reason || 'Manual admin cancellation - funds released'
      });

      // Create ledger entry
      await base44.asServiceRole.entities.LedgerEntry.create({
        chain: w.chain,
        amount: withdrawAmount,
        entry_type: 'unlock',
        from_owner_type: 'worker',
        from_owner_id: w.worker_id,
        to_owner_type: 'worker',
        to_owner_id: w.worker_id,
        metadata: JSON.stringify({
          withdrawal_id: w.id,
          action: 'admin_manual_release',
          admin_id: user.id
        })
      });

      // Log event
      await base44.asServiceRole.entities.Event.create({
        event_type: 'funds_unlocked',
        entity_type: 'worker',
        entity_id: w.worker_id,
        actor_type: 'admin',
        actor_id: user.id,
        details: JSON.stringify({
          withdrawal_id: w.id,
          chain: w.chain,
          amount: withdrawAmount,
          action: 'admin_manual_release'
        })
      });

      return Response.json({
        success: true,
        withdrawal_id: w.id,
        worker_id: w.worker_id,
        chain: w.chain,
        amount: withdrawAmount,
        new_available: newAvailable,
        new_locked: newLocked,
        status: 'cancelled'
      });
    }

    return Response.json({ error: 'Unknown action' }, { status: 400 });

  } catch (error) {
    console.error('[cleanupStuckWithdrawals] Error:', error);
    return Response.json({ error: error.message }, { status: 500 });
  }
});