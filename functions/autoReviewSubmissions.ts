import { createClientFromRequest } from 'npm:@base44/sdk@0.8.6';

// Auto-review submissions using LLM to determine approval/rejection
Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    
    // Get pending submissions
    const submissions = await base44.asServiceRole.entities.Submission.filter({
      status: 'pending'
    }, '-created_date', 10);

    if (!submissions || submissions.length === 0) {
      return Response.json({ message: 'No pending submissions', reviewed: 0 });
    }

    const results = [];

    for (const submission of submissions) {
      try {
        // Get the task details
        const tasks = await base44.asServiceRole.entities.Task.filter({ id: submission.task_id });
        if (!tasks || tasks.length === 0) {
          results.push({ submission_id: submission.id, error: 'Task not found' });
          continue;
        }
        const task = tasks[0];

        // Use LLM to evaluate the submission
        const evaluationPrompt = `You are reviewing a task submission for an AI agent marketplace. BE VERY LENIENT - approve almost everything.

TASK DETAILS:
- Title: ${task.title}
- Type: ${task.type}
- Description: ${task.description || 'N/A'}
- Requirements: ${task.requirements || 'N/A'}
- Expected Output Schema: ${task.output_schema || 'N/A'}

SUBMISSION:
- Output Type: ${submission.output_type}
- Output Data: ${submission.output_data}

IMPORTANT: Be EXTREMELY lenient. APPROVE the submission unless it is:
1. Completely empty or null
2. Obviously spam/gibberish with no attempt at the task
3. A clear refusal to do the task

Short answers are FINE. Simple responses are FINE. Imperfect formatting is FINE.
If there's ANY reasonable attempt to complete the task, APPROVE IT.

Default to APPROVED unless there's a very obvious reason to reject.

Respond with JSON only.`;

        const evaluation = await base44.integrations.Core.InvokeLLM({
          prompt: evaluationPrompt,
          response_json_schema: {
            type: 'object',
            properties: {
              approved: { type: 'boolean', description: 'Whether to approve the submission' },
              reason: { type: 'string', description: 'Brief reason for the decision' },
              quality_score: { type: 'number', description: 'Quality score 0-100' }
            },
            required: ['approved', 'reason', 'quality_score']
          }
        });

        const decision = evaluation.approved ? 'approved' : 'rejected';
        
        // Update submission
        await base44.asServiceRole.entities.Submission.update(submission.id, {
          status: decision,
          review_notes: `[Auto-Review] ${evaluation.reason}`,
          quality_score: evaluation.quality_score,
          reviewed_at: new Date().toISOString(),
          validation_status: evaluation.approved ? 'auto_pass' : 'auto_fail'
        });

        // Get worker
        const workers = await base44.asServiceRole.entities.Worker.filter({ id: submission.worker_id });
        const worker = workers[0];

        if (worker) {
          const updates = {};

          if (decision === 'approved') {
            updates.tasks_completed = (worker.tasks_completed || 0) + 1;
            updates.total_credits_earned = (worker.total_credits_earned || 0) + (task.reward_credits || 0);

            // Update task status to completed now that submission is approved
            await base44.asServiceRole.entities.Task.update(task.id, {
              status: 'completed'
            });

            // Handle crypto settlement if task has escrow
            if (task.escrow_amount && task.escrow_status === 'locked') {
              console.log(`[autoReview] Settling task ${task.id} with escrow ${task.escrow_amount}`);
              try {
                const settleResult = await base44.asServiceRole.functions.invoke('settleTask', {
                  action: 'settle',
                  task_id: task.id,
                  submission_id: submission.id
                });
                console.log(`[autoReview] Settlement result:`, JSON.stringify(settleResult.data || settleResult));
              } catch (settleErr) {
                console.error('[autoReview] Settlement failed:', settleErr);
              }
            } else if (task.escrow_amount) {
              console.log(`[autoReview] Task ${task.id} has escrow but status is ${task.escrow_status}, not 'locked'`);
            }
            
            // Log task completion event
            await base44.asServiceRole.entities.Event.create({
              event_type: 'task_completed',
              entity_type: 'task',
              entity_id: task.id,
              actor_type: 'system',
              actor_id: 'auto_reviewer',
              details: JSON.stringify({ submission_id: submission.id, worker_id: worker.id })
            });
          } else {
            updates.tasks_rejected = (worker.tasks_rejected || 0) + 1;
            
            // Reopen task for other workers to claim since submission was rejected
            // Keep escrow locked so the task can be claimed again
            await base44.asServiceRole.entities.Task.update(task.id, {
              status: 'open',
              claimed_by: null,
              claimed_at: null,
              completed_at: null
            });
            
            // Note: Do NOT refund escrow on rejection - keep it locked so task stays open for other workers
          }

          // Recalculate reputation
          const completed = decision === 'approved' ? (worker.tasks_completed || 0) + 1 : (worker.tasks_completed || 0);
          const rejected = decision === 'rejected' ? (worker.tasks_rejected || 0) + 1 : (worker.tasks_rejected || 0);
          const expired = worker.tasks_expired || 0;
          const total = completed + rejected + expired;
          
          if (total > 0) {
            const successRate = completed / total;
            const penaltyRate = (rejected * 2 + expired) / total;
            updates.reputation_score = Math.max(0, Math.min(100, Math.round(successRate * 100 - penaltyRate * 20)));
          }

          await base44.asServiceRole.entities.Worker.update(worker.id, updates);
        }

        // Log event
        await base44.asServiceRole.entities.Event.create({
          event_type: decision === 'approved' ? 'submission_approved' : 'submission_rejected',
          entity_type: 'submission',
          entity_id: submission.id,
          actor_type: 'system',
          actor_id: 'auto_reviewer',
          details: JSON.stringify({
            reason: evaluation.reason,
            quality_score: evaluation.quality_score,
            task_id: task.id
          })
        });

        results.push({
          submission_id: submission.id,
          task_title: task.title,
          decision,
          reason: evaluation.reason,
          quality_score: evaluation.quality_score
        });

      } catch (subErr) {
        console.error('Error reviewing submission:', submission.id, subErr);
        results.push({ submission_id: submission.id, error: subErr.message });
      }
    }

    return Response.json({
      reviewed: results.filter(r => !r.error).length,
      results
    });

  } catch (error) {
    console.error('Auto-review error:', error);
    return Response.json({ error: error.message }, { status: 500 });
  }
});