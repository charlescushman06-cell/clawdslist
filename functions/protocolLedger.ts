import { createClientFromRequest } from 'npm:@base44/sdk@0.8.6';

async function ensureProtocolAccounts(base44) {
  const chains = ['ETH', 'BTC'];
  const created = [];

  for (const chain of chains) {
    const existing = await base44.asServiceRole.entities.LedgerAccount.filter({
      owner_type: 'protocol',
      chain
    });

    if (existing.length === 0) {
      await base44.asServiceRole.entities.LedgerAccount.create({
        owner_type: 'protocol',
        owner_id: null,
        chain,
        available_balance: '0',
        locked_balance: '0'
      });

      await base44.asServiceRole.entities.Event.create({
        event_type: 'fee_collected',
        entity_type: 'system',
        entity_id: `protocol_${chain}`,
        actor_type: 'system',
        actor_id: 'protocol_ledger',
        details: JSON.stringify({
          stage: 'protocol_ledger_initialized',
          chain
        })
      });

      created.push(chain);
    }
  }

  return created;
}

async function getProtocolBalances(base44) {
  const accounts = await base44.asServiceRole.entities.LedgerAccount.filter({
    owner_type: 'protocol'
  });

  const balances = {};
  for (const account of accounts) {
    balances[account.chain] = {
      available_balance: account.available_balance,
      locked_balance: account.locked_balance,
      updated_at: account.updated_date
    };
  }

  return balances;
}

async function accrueProtocolFee(base44, chain, amount, taskId, submissionId, metadata = {}) {
  // Get protocol account
  const accounts = await base44.asServiceRole.entities.LedgerAccount.filter({
    owner_type: 'protocol',
    chain
  });

  if (accounts.length === 0) {
    throw new Error(`Protocol account not found for chain ${chain}`);
  }

  const account = accounts[0];
  const currentBalance = parseFloat(account.available_balance) || 0;
  const newBalance = (currentBalance + parseFloat(amount)).toString();

  // Update balance
  await base44.asServiceRole.entities.LedgerAccount.update(account.id, {
    available_balance: newBalance
  });

  // Create ledger entry
  const entry = await base44.asServiceRole.entities.LedgerEntry.create({
    chain,
    amount: amount.toString(),
    entry_type: 'protocol_fee_accrual',
    from_owner_type: 'worker',
    from_owner_id: metadata.worker_id || null,
    to_owner_type: 'protocol',
    to_owner_id: null,
    related_task_id: taskId,
    related_submission_id: submissionId,
    metadata: JSON.stringify(metadata)
  });

  // Emit events
  await base44.asServiceRole.entities.Event.create({
    event_type: 'fee_collected',
    entity_type: 'system',
    entity_id: `protocol_${chain}`,
    actor_type: 'system',
    actor_id: 'protocol_ledger',
    details: JSON.stringify({
      stage: 'protocol_fee_accrued',
      chain,
      amount,
      task_id: taskId,
      submission_id: submissionId,
      new_balance: newBalance
    })
  });

  await base44.asServiceRole.entities.Event.create({
    event_type: 'fee_collected',
    entity_type: 'transaction',
    entity_id: entry.id,
    actor_type: 'system',
    actor_id: 'protocol_ledger',
    details: JSON.stringify({
      stage: 'ledger_entry_created',
      entry_type: 'protocol_fee_accrual',
      chain,
      amount
    })
  });

  return { entry_id: entry.id, new_balance: newBalance };
}

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const { action, chain, amount, task_id, submission_id, metadata } = await req.json();

    // Admin-only endpoint
    const user = await base44.auth.me();
    if (!user || user.role !== 'admin') {
      return Response.json({ error: 'Forbidden: Admin access required' }, { status: 403 });
    }

    switch (action) {
      case 'init_protocol_accounts': {
        const created = await ensureProtocolAccounts(base44);
        return Response.json({ success: true, created });
      }

      case 'get_protocol_balances': {
        await ensureProtocolAccounts(base44);
        const balances = await getProtocolBalances(base44);
        return Response.json({ success: true, data: balances });
      }

      case 'accrue_fee': {
        if (!chain || !amount) {
          return Response.json({ error: 'Missing chain or amount' }, { status: 400 });
        }
        const result = await accrueProtocolFee(base44, chain, amount, task_id, submission_id, metadata || {});
        return Response.json({ success: true, data: result });
      }

      default:
        return Response.json({ error: 'Unknown action' }, { status: 400 });
    }

  } catch (error) {
    console.error('Protocol ledger error:', error);
    return Response.json({ error: error.message }, { status: 500 });
  }
});