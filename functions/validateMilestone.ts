import { createClientFromRequest } from 'npm:@base44/sdk@0.8.6';

/**
 * Deterministic validation logic
 */
async function runDeterministicValidation(validationSpec, outputData, artifactRequirements) {
  const results = {
    passed: false,
    checks: [],
    errors: []
  };

  try {
    const parsedOutput = typeof outputData === 'string' ? JSON.parse(outputData) : outputData;
    const spec = typeof validationSpec === 'string' ? JSON.parse(validationSpec) : validationSpec;

    // JSON schema validation
    if (spec.json_schema) {
      const schemaValid = validateJsonSchema(parsedOutput, spec.json_schema);
      results.checks.push({ type: 'json_schema', passed: schemaValid });
      if (!schemaValid) results.errors.push('JSON schema validation failed');
    }

    // Regex/constraint matching
    if (spec.constraints) {
      for (const [field, constraint] of Object.entries(spec.constraints)) {
        const value = parsedOutput[field];
        if (constraint.regex) {
          const regex = new RegExp(constraint.regex);
          const passed = regex.test(value);
          results.checks.push({ type: 'regex', field, passed });
          if (!passed) results.errors.push(`Field ${field} failed regex: ${constraint.regex}`);
        }
        if (constraint.min_length && value?.length < constraint.min_length) {
          results.checks.push({ type: 'min_length', field, passed: false });
          results.errors.push(`Field ${field} below min length: ${constraint.min_length}`);
        }
      }
    }

    // Artifact requirements
    if (artifactRequirements && artifactRequirements.length > 0) {
      for (const artifact of artifactRequirements) {
        const hasArtifact = parsedOutput.artifacts?.includes(artifact);
        results.checks.push({ type: 'artifact', artifact, passed: hasArtifact });
        if (!hasArtifact) results.errors.push(`Missing required artifact: ${artifact}`);
      }
    }

    // URL validation
    if (spec.url_checks) {
      for (const urlCheck of spec.url_checks) {
        const url = parsedOutput[urlCheck.field];
        if (url) {
          try {
            const response = await fetch(url, { method: 'HEAD' });
            const passed = response.ok;
            results.checks.push({ type: 'url_fetch', url, passed });
            if (!passed) results.errors.push(`URL fetch failed: ${url}`);
          } catch (e) {
            results.checks.push({ type: 'url_fetch', url, passed: false });
            results.errors.push(`URL fetch error: ${url}`);
          }
        }
      }
    }

    results.passed = results.errors.length === 0;
  } catch (error) {
    results.errors.push(`Validation error: ${error.message}`);
  }

  return results;
}

function validateJsonSchema(data, schema) {
  // Basic JSON schema validation
  if (schema.type === 'object' && schema.properties) {
    for (const [key, prop] of Object.entries(schema.properties)) {
      if (schema.required?.includes(key) && !(key in data)) {
        return false;
      }
      if (key in data && prop.type) {
        const actualType = typeof data[key];
        if (prop.type === 'array' && !Array.isArray(data[key])) return false;
        if (prop.type !== 'array' && actualType !== prop.type) return false;
      }
    }
  }
  return true;
}

/**
 * Main validation handler
 */
Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();

    if (!user || user.role !== 'admin') {
      return Response.json({ error: 'Admin access required' }, { status: 403 });
    }

    const body = await req.json();
    const { milestone_id, submission_id, action } = body;

    if (action === 'validate_submission') {
      // Get milestone and submission
      const milestones = await base44.asServiceRole.entities.Milestone.filter({ id: milestone_id });
      if (!milestones || milestones.length === 0) {
        return Response.json({ error: 'Milestone not found' }, { status: 404 });
      }

      const submissions = await base44.asServiceRole.entities.Submission.filter({ id: submission_id });
      if (!submissions || submissions.length === 0) {
        return Response.json({ error: 'Submission not found' }, { status: 404 });
      }

      const milestone = milestones[0];
      const submission = submissions[0];

      if (milestone.validation_mode === 'deterministic') {
        const validationResult = await runDeterministicValidation(
          milestone.validation_spec,
          submission.output_data,
          milestone.artifact_requirements
        );

        const validationStatus = validationResult.passed ? 'auto_pass' : 'auto_fail';
        const newMilestoneStatus = validationResult.passed ? 'accepted' : 'rejected';

        await base44.asServiceRole.entities.Submission.update(submission_id, {
          validation_status: validationStatus,
          validator_output: JSON.stringify(validationResult),
          status: validationResult.passed ? 'approved' : 'rejected',
          rejection_reason: validationResult.passed ? null : validationResult.errors.join('; ')
        });

        await base44.asServiceRole.entities.Milestone.update(milestone_id, {
          status: newMilestoneStatus,
          completed_at: new Date().toISOString(),
          review_notes: validationResult.passed ? 'Auto-validated' : validationResult.errors.join('; ')
        });
        
        // Handle payment if accepted
        if (validationResult.passed && milestone.payout_percentage) {
          const tasks = await base44.asServiceRole.entities.Task.filter({ id: milestone.task_id });
          if (tasks && tasks.length > 0) {
            const task = tasks[0];
            const milestonePayment = (task.total_price * milestone.payout_percentage) / 100;
            const protocolFee = (milestonePayment * (task.protocol_fee_percentage || 5)) / 100;
            
            if (task.payer_id && task.claimed_by) {
              await base44.functions.invoke('settlements', {
                action: 'transfer_payment',
                from_worker_id: task.payer_id,
                to_worker_id: task.claimed_by,
                task_id: task.id,
                milestone_id: milestone_id,
                amount: milestonePayment,
                protocol_fee: protocolFee
              });
            }
            
            // Release milestone stake
            if (milestone.required_stake_percentage && task.total_required_stake) {
              const milestoneStake = (task.total_required_stake * milestone.required_stake_percentage) / 100;
              if (milestoneStake > 0) {
                await base44.functions.invoke('settlements', {
                  action: 'unlock_stake',
                  worker_id: task.claimed_by,
                  task_id: task.id,
                  milestone_id: milestone_id,
                  amount: milestoneStake
                });
              }
            }
          }
        }
        
        // Slash stake if rejected
        if (!validationResult.passed && milestone.required_stake_percentage) {
          const tasks = await base44.asServiceRole.entities.Task.filter({ id: milestone.task_id });
          if (tasks && tasks.length > 0) {
            const task = tasks[0];
            const milestoneStake = (task.total_required_stake * milestone.required_stake_percentage) / 100;
            const slashAmount = (milestoneStake * (task.slash_percentage || 100)) / 100;
            
            if (slashAmount > 0 && task.claimed_by) {
              await base44.functions.invoke('settlements', {
                action: 'slash_stake',
                worker_id: task.claimed_by,
                task_id: task.id,
                milestone_id: milestone_id,
                amount: slashAmount
              });
            }
          }
        }

        await base44.asServiceRole.entities.Event.create({
          event_type: validationResult.passed ? 'milestone_auto_accepted' : 'milestone_auto_rejected',
          entity_type: 'milestone',
          entity_id: milestone_id,
          actor_type: 'system',
          actor_id: 'validator',
          details: JSON.stringify({ validation_result: validationResult, submission_id })
        });

        return Response.json({
          success: true,
          validation_status: validationStatus,
          milestone_status: newMilestoneStatus,
          results: validationResult
        });
      }

      if (milestone.validation_mode === 'quorum') {
        await base44.asServiceRole.entities.Submission.update(submission_id, {
          validation_status: 'needs_review'
        });

        return Response.json({
          success: true,
          validation_status: 'needs_review',
          message: 'Submission added to review queue'
        });
      }

      return Response.json({ error: 'Invalid validation mode' }, { status: 400 });
    }

    if (action === 'get_validation_report') {
      if (!milestone_id) {
        return Response.json({ error: 'milestone_id required' }, { status: 400 });
      }

      const milestones = await base44.asServiceRole.entities.Milestone.filter({ id: milestone_id });
      if (!milestones || milestones.length === 0) {
        return Response.json({ error: 'Milestone not found' }, { status: 404 });
      }

      const milestone = milestones[0];
      const submissions = await base44.asServiceRole.entities.Submission.filter({ milestone_id });
      const reviews = await base44.asServiceRole.entities.Review.filter({ milestone_id });

      return Response.json({
        success: true,
        data: {
          milestone: {
            id: milestone.id,
            title: milestone.title,
            validation_mode: milestone.validation_mode,
            status: milestone.status
          },
          submissions: submissions.map(s => ({
            id: s.id,
            worker_id: s.worker_id,
            worker_name: s.worker_name,
            validation_status: s.validation_status,
            quality_score: s.quality_score,
            created_date: s.created_date
          })),
          reviews: reviews.map(r => ({
            id: r.id,
            reviewer_name: r.reviewer_name,
            decision: r.decision,
            overall_score: r.overall_score,
            created_date: r.created_date
          }))
        }
      });
    }

    return Response.json({ error: 'Unknown action' }, { status: 400 });
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
});