/**
 * SLA Checker
 *
 * Periodic job that checks for agent-escalation human tasks past their due date.
 * Marks SLA breaches, escalates to the next level in the chain,
 * and expires tasks when the escalation chain is exhausted.
 *
 * SCOPE: This checker only processes tasks with `source.type: 'agent_escalation'`.
 * Workflow-sourced tasks (`workflow_approval`, `workflow_human_task`) have their
 * timeouts enforced at the workflow-engine layer via Restate durable timers
 * (see `buildTimeoutDecision` in `apps/workflow-engine/src/executors/approval-executor.ts`).
 * Flipping their status here would diverge from the workflow execution state
 * and leave the Restate promise hanging. The `dueAt` / `onTimeout` fields on
 * workflow-sourced tasks are informational only — surfaced in the inbox UI
 * so the assignee knows what happens if they miss the window.
 */

import { createLogger } from '@abl/compiler/platform';
import { HumanTask } from '@agent-platform/database/models';

const log = createLogger('runtime:sla-checker');

const CHECK_INTERVAL_MS = 60_000; // 60 seconds

/**
 * Only agent-escalation tasks are managed by this checker. Workflow-sourced
 * tasks (approval, human_task) are timed out by the workflow engine itself.
 */
const MANAGED_SOURCE_TYPE = 'agent_escalation' as const;

let intervalHandle: ReturnType<typeof setInterval> | null = null;

/**
 * Run a single SLA check cycle.
 * Finds agent-escalation tasks past dueAt that haven't been marked as breached,
 * and tasks that need expiration or escalation.
 */
async function runCheck(): Promise<void> {
  const now = new Date();

  try {
    // Step 1: Mark SLA breached on overdue agent-escalation tasks
    const breachedResult = await HumanTask.updateMany(
      {
        'source.type': MANAGED_SOURCE_TYPE,
        status: { $in: ['pending', 'assigned', 'in_progress'] },
        dueAt: { $lte: now },
        slaBreachedAt: { $exists: false },
      },
      { $set: { slaBreachedAt: now } },
    );

    if (breachedResult.modifiedCount > 0) {
      log.info('SLA breaches marked', { count: breachedResult.modifiedCount });
    }

    // Step 2: Find breached tasks that can be escalated
    const escalatable = await HumanTask.find({
      'source.type': MANAGED_SOURCE_TYPE,
      status: { $in: ['pending', 'assigned'] },
      slaBreachedAt: { $exists: true },
      $expr: { $lt: ['$currentEscalationLevel', { $size: '$escalationChain' }] },
    })
      .limit(100)
      .lean();

    for (const task of escalatable) {
      const nextLevel = (task.currentEscalationLevel ?? 0) + 1;
      const nextAssignee = task.escalationChain?.[nextLevel];
      if (!nextAssignee) continue;

      await HumanTask.findOneAndUpdate(
        { _id: task._id, tenantId: task.tenantId },
        {
          $set: {
            currentEscalationLevel: nextLevel,
            assignedToTeam: nextAssignee,
            status: 'pending',
          },
        },
      );

      log.info('Task escalated to next level', {
        taskId: task._id,
        level: nextLevel,
        assignedToTeam: nextAssignee,
      });
    }

    // Step 3: Expire agent-escalation tasks that exhausted their escalation chain
    const expiredResult = await HumanTask.updateMany(
      {
        'source.type': MANAGED_SOURCE_TYPE,
        status: { $in: ['pending', 'assigned'] },
        slaBreachedAt: { $exists: true },
        $expr: { $gte: ['$currentEscalationLevel', { $size: '$escalationChain' }] },
        escalationChain: { $exists: true, $ne: [] },
      },
      { $set: { status: 'expired' } },
    );

    if (expiredResult.modifiedCount > 0) {
      log.info('Tasks expired after escalation chain exhausted', {
        count: expiredResult.modifiedCount,
      });
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error('SLA check failed', { error: msg });
  }
}

/**
 * Start the SLA checker periodic job.
 */
export function startSlaChecker(): void {
  if (intervalHandle) return;
  intervalHandle = setInterval(runCheck, CHECK_INTERVAL_MS);
  log.info('SLA checker started', { intervalMs: CHECK_INTERVAL_MS });
}

/**
 * Stop the SLA checker periodic job.
 */
export function stopSlaChecker(): void {
  if (intervalHandle) {
    clearInterval(intervalHandle);
    intervalHandle = null;
    log.info('SLA checker stopped');
  }
}
