/**
 * Human Step Timeout Enforcer
 *
 * Enforces the `dueAt` / `onTimeout` config on relay-race approval and
 * human-task (data-entry) steps. The Restate (legacy) path uses raceTimeout()
 * inside the handler; the relay-race path parks and returns immediately, so
 * timeout enforcement must happen out-of-band.
 *
 * Mechanism:
 *   1. Periodically queries HumanTask inbox records where
 *      `dueAt < now`, `status === 'pending'`, `mailbox === 'workflow'`.
 *   2. For each expired record:
 *      a. Resolves the parked step in execution-store (`resolveParkedStep`).
 *      b. Routes based on `onTimeout`:
 *         - `terminate` (default): marks execution `rejected`.
 *         - `skip`: dispatches next relay leg from `nextStepIds`.
 *      c. Marks the HumanTask mirror as `expired` in the inbox.
 *
 * Multi-replica safety: Redis distributed lock (SET NX PX).
 *
 * Configuration (env vars):
 *   HUMAN_STEP_TIMEOUT_SWEEP_INTERVAL_MS — sweep interval (default: 60 s)
 *   HUMAN_STEP_TIMEOUT_BATCH_SIZE        — max tasks per sweep (default: 50)
 *
 * Gherkin coverage (docs reference):
 *   Scenario: Approval times out with "Terminate workflow"
 *     Given step parked with dueAt=T and onTimeout=terminate
 *     When sweeper runs at T+1min
 *     Then step status → rejected, execution status → rejected
 *
 *   Scenario: Approval times out with "Skip this step"
 *     Given step parked with dueAt=T and onTimeout=skip
 *     When sweeper runs at T+1min
 *     Then step status → skipped, next relay leg dispatched from nextStepIds
 *
 *   Scenario: Step resolved before timeout
 *     Given step resolved at T-10min (HumanTask status=completed)
 *     When sweeper runs at T+1min
 *     Then sweeper ignores this task (status !== pending)
 */

import { createLogger } from '@abl/compiler/platform';
import type { RedisClient } from '@agent-platform/redis';
import type { MongooseModelLike } from '../persistence/execution-store.js';
import type { RestateWorkflowClient } from './restate-client.js';

const log = createLogger('workflow-engine:human-step-timeout-enforcer');

const DEFAULT_SWEEP_INTERVAL_MS = 60_000; // 1 min
const DEFAULT_BATCH_SIZE = 50;
const LOCK_KEY = 'workflow-engine:human-step-timeout:lock';

function parseEnvInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

// ── Minimal model shapes ──────────────────────────────────────────────────────

interface ExpiredTask {
  _id: string;
  tenantId: string;
  source: {
    type: string;
    executionId?: string;
    stepId?: string;
  };
  onTimeout?: 'terminate' | 'skip';
}

interface ExecutionStepEntry {
  stepId?: string;
  status?: string;
  parkPoint?: boolean;
  nextStepIds?: string[];
  branchId?: string;
  joinStepId?: string;
  barrierTotal?: number;
  failureStrategy?: string;
}

interface ExecutionDoc {
  _id: string;
  tenantId: string;
  projectId: string;
  status: string;
  context?: { steps?: Record<string, ExecutionStepEntry> };
}

export interface HumanStepTimeoutEnforcerDeps {
  /** HumanTask Mongoose model */
  humanTaskModel: Pick<MongooseModelLike<ExpiredTask>, 'find' | 'findOneAndUpdate'>;
  /** WorkflowExecution Mongoose model */
  executionModel: Pick<MongooseModelLike<ExecutionDoc>, 'findOne'>;
  /** Shared persistence for step/execution writes */
  persistence: {
    resolveParkedStep(
      executionId: string,
      tenantId: string,
      projectId: string,
      stepKey: string,
      expectedStatus: string,
      result: { decision?: string; completedAt?: string },
    ): Promise<boolean>;
    updateExecutionStatus(
      executionId: string,
      tenantId: string,
      projectId: string,
      status: string,
      data?: { completedAt?: Date },
    ): Promise<void>;
  };
  restateClient: Pick<RestateWorkflowClient, 'startWorkflow'>;
  redis: RedisClient | null;
}

export interface HumanStepTimeoutHandle {
  stop(): void;
}

// ── Lock helper ───────────────────────────────────────────────────────────────

async function tryAcquireLock(redis: RedisClient | null, ttlMs: number): Promise<boolean> {
  if (!redis) return false;
  try {
    const result = await redis.set(LOCK_KEY, '1', 'PX', ttlMs, 'NX');
    return result === 'OK';
  } catch {
    return false;
  }
}

// ── Core sweep ────────────────────────────────────────────────────────────────

async function sweepOnce(deps: HumanStepTimeoutEnforcerDeps, batchSize: number): Promise<void> {
  const now = new Date();

  let expired: ExpiredTask[];
  try {
    expired = await deps.humanTaskModel
      .find({
        dueAt: { $lt: now },
        status: 'pending',
        mailbox: 'workflow',
        'source.type': { $in: ['workflow_approval', 'workflow_human_task'] },
      })
      .limit(batchSize)
      .lean();
  } catch (err) {
    log.error('human-step-timeout.query-failed', {
      error: err instanceof Error ? err.message : String(err),
    });
    return;
  }

  if (expired.length === 0) return;

  log.info('human-step-timeout.expired-tasks-found', { count: expired.length });

  for (const task of expired) {
    const { executionId, stepId } = (task.source ?? {}) as {
      executionId?: string;
      stepId?: string;
    };
    if (!executionId || !stepId) continue;

    try {
      await processExpiredTask(deps, task, executionId, stepId);
    } catch (err) {
      log.warn('human-step-timeout.task-error', {
        taskId: task._id,
        executionId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

async function processExpiredTask(
  deps: HumanStepTimeoutEnforcerDeps,
  task: ExpiredTask,
  executionId: string,
  stepId: string,
): Promise<void> {
  // 1. Load execution
  const execution = (await deps.executionModel.findOne({
    _id: executionId,
    tenantId: task.tenantId,
  })) as ExecutionDoc | null;

  if (!execution || !['running'].includes(execution.status)) {
    // Execution already terminal or not found — just mark task expired.
    await markTaskExpired(deps, task._id, task.tenantId);
    return;
  }

  // 2. Find step key by stepId value
  const steps = execution.context?.steps ?? {};
  const stepKey = Object.keys(steps).find((k) => steps[k]?.stepId === stepId);
  if (!stepKey) {
    log.warn('human-step-timeout.step-not-found', { executionId, stepId });
    await markTaskExpired(deps, task._id, task.tenantId);
    return;
  }

  const step = steps[stepKey];
  const expectedStatus =
    task.source.type === 'workflow_approval' ? 'waiting_approval' : 'waiting_human_task';

  if (step.status !== expectedStatus || !step.parkPoint) {
    // Step already resolved — mark inbox expired and move on.
    await markTaskExpired(deps, task._id, task.tenantId);
    return;
  }

  const onTimeout = task.onTimeout ?? 'terminate';
  const completedAt = new Date().toISOString();

  // 3. Resolve the parked step
  const resolved = await deps.persistence.resolveParkedStep(
    executionId,
    task.tenantId,
    execution.projectId,
    stepKey,
    expectedStatus,
    // Match develop-branch: skip→'skipped', terminate→'expired' (maps to step status 'failed')
    { decision: onTimeout === 'skip' ? 'skipped' : 'expired', completedAt },
  );

  if (!resolved) {
    // Race: another pod already resolved it.
    await markTaskExpired(deps, task._id, task.tenantId);
    return;
  }

  log.info('human-step-timeout.step-timed-out', {
    executionId,
    stepId,
    stepKey,
    onTimeout,
  });

  // 4. Route based on onTimeout
  if (onTimeout === 'skip') {
    // Continue on the success (on_approve / on_success) path.
    const nextStepIds = step.nextStepIds ?? [];
    if (nextStepIds.length > 0) {
      await deps.restateClient.startWorkflow(executionId, {
        tenantId: task.tenantId,
        projectId: execution.projectId,
        startFromStepIds: nextStepIds,
        branchId: step.branchId,
        resumeStepId: stepId,
        joinStepId: step.joinStepId,
        barrierTotal: step.barrierTotal,
        failureStrategy: step.failureStrategy as
          | 'fail_fast'
          | 'wait_all'
          | 'ignore_errors'
          | undefined,
      });
    } else {
      // No successors — terminate normally (execution ends at this step).
      await deps.persistence.updateExecutionStatus(
        executionId,
        task.tenantId,
        execution.projectId,
        'completed',
        { completedAt: new Date() },
      );
    }
  } else {
    // terminate: step=failed, execution=failed — no edge routing (matches develop-branch)
    await deps.persistence.updateExecutionStatus(
      executionId,
      task.tenantId,
      execution.projectId,
      'failed',
      { completedAt: new Date() },
    );
  }

  // 5. Mark inbox task expired
  await markTaskExpired(deps, task._id, task.tenantId);
}

async function markTaskExpired(
  deps: HumanStepTimeoutEnforcerDeps,
  taskId: string,
  tenantId: string,
): Promise<void> {
  try {
    await deps.humanTaskModel.findOneAndUpdate(
      { _id: taskId, tenantId, status: 'pending' },
      { $set: { status: 'expired' } },
    );
  } catch (err) {
    log.warn('human-step-timeout.mark-expired-failed', {
      taskId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

// ── Public factory ────────────────────────────────────────────────────────────

export function startHumanStepTimeoutEnforcer(
  deps: HumanStepTimeoutEnforcerDeps,
): HumanStepTimeoutHandle {
  const intervalMs = parseEnvInt('HUMAN_STEP_TIMEOUT_SWEEP_INTERVAL_MS', DEFAULT_SWEEP_INTERVAL_MS);
  const batchSize = parseEnvInt('HUMAN_STEP_TIMEOUT_BATCH_SIZE', DEFAULT_BATCH_SIZE);

  const runSweep = async (): Promise<void> => {
    const lockTtl = Math.max(intervalMs - 5_000, 30_000);
    const haveLock = await tryAcquireLock(deps.redis, lockTtl);
    if (!haveLock) return;
    try {
      await sweepOnce(deps, batchSize);
    } catch (err) {
      log.error('human-step-timeout.sweep-unhandled', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  };

  const runOrLog = (): void => {
    runSweep().catch((err: unknown) => {
      log.error('human-step-timeout.timer-error', {
        error: err instanceof Error ? err.message : String(err),
      });
    });
  };

  // First run 30 s after boot, then on the interval.
  const bootTimer = setTimeout(runOrLog, 30_000);
  bootTimer.unref?.();
  const periodic = setInterval(runOrLog, intervalMs);
  periodic.unref?.();

  log.info('human-step-timeout-enforcer.started', { intervalMs, batchSize });

  return {
    stop(): void {
      clearTimeout(bootTimer);
      clearInterval(periodic);
      log.info('human-step-timeout-enforcer.stopped');
    },
  };
}
