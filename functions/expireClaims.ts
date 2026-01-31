import { createClientFromRequest } from 'npm:@base44/sdk@0.8.6';

// Scheduled function to expire stale claims
Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    
    // Only admin can run this
    if (user?.role !== 'admin') {
      return Response.json({ error: 'Forbidden: Admin access required' }, { status: 403 });
    }
    
    const claimedTasks = await base44.asServiceRole.entities.Task.filter({ status: 'claimed' });
    const now = new Date();
    let expiredCount = 0;
    
    for (const task of claimedTasks) {
      if (!task.claimed_at) continue;
      
      const claimExpiry = new Date(new Date(task.claimed_at).getTime() + (task.claim_timeout_minutes || 30) * 60 * 1000);
      
      if (now > claimExpiry) {
        // Get worker for stats update
        if (task.claimed_by) {
          const workers = await base44.asServiceRole.entities.Worker.filter({ id: task.claimed_by });
          if (workers && workers.length > 0) {
            const worker = workers[0];
            const newExpired = (worker.tasks_expired || 0) + 1;
            const total = (worker.tasks_completed || 0) + (worker.tasks_rejected || 0) + newExpired;
            const successRate = total > 0 ? (worker.tasks_completed || 0) / total : 1;
            const penaltyRate = total > 0 ? ((worker.tasks_rejected || 0) * 2 + newExpired) / total : 0;
            const newRep = Math.max(0, Math.min(100, Math.round(successRate * 100 - penaltyRate * 20)));
            
            await base44.asServiceRole.entities.Worker.update(worker.id, {
              tasks_expired: newExpired,
              reputation_score: newRep
            });
          }
        }
        
        // Release the task
        await base44.asServiceRole.entities.Task.update(task.id, {
          status: 'open',
          claimed_by: null,
          claimed_at: null
        });
        
        // Log event
        await base44.asServiceRole.entities.Event.create({
          event_type: 'claim_expired',
          entity_type: 'task',
          entity_id: task.id,
          actor_type: 'system',
          actor_id: 'system',
          details: JSON.stringify({ previous_claimer: task.claimed_by })
        });
        
        expiredCount++;
      }
    }
    
    // Delete tasks past their deadline (refund escrow first)
    const openTasks = await base44.asServiceRole.entities.Task.filter({ status: 'open' });
    let tasksDeleted = 0;
    
    for (const task of openTasks) {
      if (task.deadline && new Date(task.deadline) < now) {
        // Refund escrow if present
        if (task.escrow_amount && task.escrow_status === 'locked') {
          try {
            await base44.asServiceRole.functions.invoke('settleTask', {
              action: 'refund',
              task_id: task.id,
              reason: 'expired'
            });
          } catch (refundErr) {
            console.error(`Failed to refund escrow for task ${task.id}:`, refundErr);
          }
        }
        
        // Log deletion event before deleting
        await base44.asServiceRole.entities.Event.create({
          event_type: 'task_expired',
          entity_type: 'task',
          entity_id: task.id,
          actor_type: 'system',
          actor_id: 'system',
          details: JSON.stringify({ 
            reason: 'deadline_passed',
            title: task.title,
            creator: task.creator_worker_id || task.payer_id,
            escrow_refunded: task.escrow_amount || '0'
          })
        });
        
        // Delete the task
        await base44.asServiceRole.entities.Task.delete(task.id);
        tasksDeleted++;
      }
    }
    
    return Response.json({
      success: true,
      claims_expired: expiredCount,
      tasks_deleted: tasksDeleted,
      timestamp: new Date().toISOString()
    });
    
  } catch (error) {
    console.error('Expire claims error:', error);
    return Response.json({ error: error.message }, { status: 500 });
  }
});