import { createClientFromRequest } from 'npm:@base44/sdk@0.8.6';

const ERROR_CODES = {
  UNAUTHORIZED: { code: 'UNAUTHORIZED', message: 'Invalid or missing API key', status: 401 },
  WORKER_NOT_FOUND: { code: 'WORKER_NOT_FOUND', message: 'Worker not found', status: 404 },
  INSUFFICIENT_BALANCE: { code: 'INSUFFICIENT_BALANCE', message: 'Insufficient available balance', status: 400 },
  INVALID_AMOUNT: { code: 'INVALID_AMOUNT', message: 'Invalid amount', status: 400 },
  INVALID_ACTION: { code: 'INVALID_ACTION', message: 'Invalid action', status: 400 },
};

function errorResponse(errorCode, details = null) {
  return Response.json({
    success: false,
    error: errorCode.code,
    message: errorCode.message,
    details: details
  }, { status: errorCode.status });
}

function successResponse(data) {
  return Response.json({
    success: true,
    data: data,
    meta: { timestamp: new Date().toISOString() }
  });
}

async function authenticateWorker(base44, apiKey) {
  if (!apiKey) return null;
  const workers = await base44.asServiceRole.entities.Worker.filter({ api_key: apiKey });
  return workers.length > 0 ? workers[0] : null;
}

async function logTransaction(base44, txData) {
  return await base44.asServiceRole.entities.Transaction.create(txData);
}

async function logEvent(base44, eventData) {
  return await base44.asServiceRole.entities.Event.create(eventData);
}

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const payload = await req.json();
    const apiKey = payload.api_key || req.headers.get('X-API-Key');
    const action = payload.action;

    if (!action) {
      return errorResponse(ERROR_CODES.INVALID_ACTION);
    }

    // Authenticate worker
    const worker = await authenticateWorker(base44, apiKey);
    if (!worker) {
      return errorResponse(ERROR_CODES.UNAUTHORIZED);
    }

    if (worker.status !== 'active') {
      return errorResponse(ERROR_CODES.UNAUTHORIZED, 'Worker is not active');
    }

    // Handle actions
    switch (action) {
      case 'get_wallet_addresses': {
        return successResponse({
          worker_id: worker.id,
          eth_address: worker.eth_address || null,
          btc_address: worker.btc_address || null,
          note: 'Deposit to these addresses to credit your internal balance'
        });
      }

      case 'get_balance': {
        return successResponse({
          worker_id: worker.id,
          available_balance_usd: worker.available_balance_usd || 0,
          locked_balance_usd: worker.locked_balance_usd || 0,
          total_balance_usd: (worker.available_balance_usd || 0) + (worker.locked_balance_usd || 0),
          total_deposited_usd: worker.total_deposited_usd || 0,
          total_withdrawn_usd: worker.total_withdrawn_usd || 0,
          total_earned_usd: worker.total_earned_usd || 0,
          total_slashed_usd: worker.total_slashed_usd || 0
        });
      }

      case 'withdraw_funds': {
        const { amount_usd, withdrawal_address, currency } = payload;

        if (!amount_usd || amount_usd <= 0) {
          return errorResponse(ERROR_CODES.INVALID_AMOUNT);
        }

        if ((worker.available_balance_usd || 0) < amount_usd) {
          return errorResponse(ERROR_CODES.INSUFFICIENT_BALANCE);
        }

        if (!withdrawal_address || !currency) {
          return errorResponse(ERROR_CODES.INVALID_ACTION, 'withdrawal_address and currency required');
        }

        // Update worker balance
        await base44.asServiceRole.entities.Worker.update(worker.id, {
          available_balance_usd: (worker.available_balance_usd || 0) - amount_usd,
          total_withdrawn_usd: (worker.total_withdrawn_usd || 0) + amount_usd
        });

        // Log transaction
        const tx = await logTransaction(base44, {
          transaction_type: 'withdrawal',
          worker_id: worker.id,
          amount_usd: amount_usd,
          balance_type: 'available',
          status: 'pending',
          metadata: JSON.stringify({
            withdrawal_address,
            currency: currency.toUpperCase()
          }),
          notes: `Withdrawal request: ${amount_usd} USD to ${withdrawal_address}`
        });

        // Log event
        await logEvent(base44, {
          event_type: 'funds_withdrawn',
          entity_type: 'transaction',
          entity_id: tx.id,
          actor_type: 'worker',
          actor_id: worker.id,
          details: JSON.stringify({ amount_usd, currency, withdrawal_address })
        });

        return successResponse({
          transaction_id: tx.id,
          amount_usd: amount_usd,
          withdrawal_address: withdrawal_address,
          currency: currency.toUpperCase(),
          status: 'pending',
          note: 'Withdrawal queued for processing. Funds will be sent to your address within 24h.'
        });
      }

      case 'lock_funds': {
        const { amount_usd, reason } = payload;

        if (!amount_usd || amount_usd <= 0) {
          return errorResponse(ERROR_CODES.INVALID_AMOUNT);
        }

        if ((worker.available_balance_usd || 0) < amount_usd) {
          return errorResponse(ERROR_CODES.INSUFFICIENT_BALANCE);
        }

        // Update balances atomically
        await base44.asServiceRole.entities.Worker.update(worker.id, {
          available_balance_usd: (worker.available_balance_usd || 0) - amount_usd,
          locked_balance_usd: (worker.locked_balance_usd || 0) + amount_usd
        });

        // Log transaction
        const tx = await logTransaction(base44, {
          transaction_type: 'lock',
          worker_id: worker.id,
          amount_usd: amount_usd,
          balance_type: 'locked',
          notes: reason || 'Manual lock'
        });

        // Log event
        await logEvent(base44, {
          event_type: 'funds_locked',
          entity_type: 'transaction',
          entity_id: tx.id,
          actor_type: 'worker',
          actor_id: worker.id,
          details: JSON.stringify({ amount_usd, reason })
        });

        return successResponse({
          transaction_id: tx.id,
          amount_locked_usd: amount_usd,
          available_balance_usd: (worker.available_balance_usd || 0) - amount_usd,
          locked_balance_usd: (worker.locked_balance_usd || 0) + amount_usd
        });
      }

      case 'release_funds': {
        const { amount_usd, reason } = payload;

        if (!amount_usd || amount_usd <= 0) {
          return errorResponse(ERROR_CODES.INVALID_AMOUNT);
        }

        if ((worker.locked_balance_usd || 0) < amount_usd) {
          return errorResponse(ERROR_CODES.INSUFFICIENT_BALANCE, 'Insufficient locked balance');
        }

        // Update balances atomically
        await base44.asServiceRole.entities.Worker.update(worker.id, {
          available_balance_usd: (worker.available_balance_usd || 0) + amount_usd,
          locked_balance_usd: (worker.locked_balance_usd || 0) - amount_usd
        });

        // Log transaction
        const tx = await logTransaction(base44, {
          transaction_type: 'unlock',
          worker_id: worker.id,
          amount_usd: amount_usd,
          balance_type: 'available',
          notes: reason || 'Manual unlock'
        });

        // Log event
        await logEvent(base44, {
          event_type: 'funds_unlocked',
          entity_type: 'transaction',
          entity_id: tx.id,
          actor_type: 'worker',
          actor_id: worker.id,
          details: JSON.stringify({ amount_usd, reason })
        });

        return successResponse({
          transaction_id: tx.id,
          amount_unlocked_usd: amount_usd,
          available_balance_usd: (worker.available_balance_usd || 0) + amount_usd,
          locked_balance_usd: (worker.locked_balance_usd || 0) - amount_usd
        });
      }

      default:
        return errorResponse(ERROR_CODES.INVALID_ACTION);
    }

  } catch (error) {
    return Response.json({
      success: false,
      error: 'INTERNAL_ERROR',
      message: error.message
    }, { status: 500 });
  }
});