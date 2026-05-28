/**
 * Stuck-Execution Sweeper (P-6 / P-7)
 *
 * Periodic background sweep that detects relay-race workflow executions stuck
 * at `waiting_callback` (ADI / Docling / async-webhook) beyond a configurable
 * TTL and marks them `failed` (code: INACTIVITY_TIMEOUT).
 *
 * ── Scope ────────────────────────────────────────────────────────────────────
 * The sweeper intentionally skips executions that have an active human-wait
 * step (approval / human-task). Those nodes have a per-step `timeoutMs`
 * configured by the workflow designer and can legitimately run for hours or
 * days. The sweeper only targets callback-wait executions where the external
 * worker (ADI poll worker, Docling BullMQ job) is the intended timer — and
 * where all other safeguards (poll-count cap, BullMQ retries, circuit breaker)
 * have already fired without resolving the park.
 *
 * Executions with an active human-wait step are flagged via `hasHumanWait: true`
 * written by `parkStep` and cleared by `resolveParkedStep` / when the execution
 * reaches a terminal status. The sweeper query filters them out with
 * `hasHumanWait: { $ne: true }`.
 *
 * ── Disabled by default ──────────────────────────────────────────────────────
 * There is no safe hardcoded default for STUCK_EXECUTION_MAX_AGE_MS because the
 * right value is deployment-specific. Deployments that run only ADI/Docling
 * workflows should set it to 1–2 h. The sweeper skips every cycle when the env
 * var is absent or zero.
 *
 * ── Multi-replica safety ─────────────────────────────────────────────────────
 * A distributed Redis lock (SET NX PX) ensures only one pod runs the sweep per
 * interval. When Redis is unavailable the sweep is skipped.
 *
 * Configuration (env vars):
 *   STUCK_EXECUTION_MAX_AGE_MS        — age threshold (default: 14400000 = 4 h).
 *                                       ADI/Docling callbacks should complete in
 *                                       seconds–minutes; 4 h is a generous backstop.
 *                                       Set to 0 to disable entirely.
 *   STUCK_EXECUTION_SWEEP_INTERVAL_MS — how often to run (default: 5 min)
 *   STUCK_EXECUTION_BATCH_SIZE        — max per cycle (default: 100)
 */

import { createLogger } from '@abl/compiler/platform';
import type { RedisClient } from '@agent-platform/redis';
import type { MongooseModelLike } from '../persistence/execution-store.js';

const log = createLogger('workflow-engine:stuck-execution-sweeper');

const DEFAULT_SWEEP_INTERVAL_MS = 5 * 60 * 1000; // 5 min
const DEFAULT_BATCH_SIZE = 100;
const LOCK_KEY = 'workflow-engine:stuck-execution-sweep:lock';

function parseEnvInt(name: string, fallback: number, min = 1): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n >= min ? n : fallback;
}

/** Minimal execution document shape read by the sweeper. */
interface StuckExecDoc {
  _id: string;
  tenantId: string;
  projectId: string;
  workflowId?: string;
  startedAt?: Date;
}

export interface StuckExecutionSweeperModel extends Pick<
  MongooseModelLike<StuckExecDoc>,
  'find' | 'findOneAndUpdate'
> {}

export interface StuckExecutionSweeperHandle {
  stop(): void;
}

async function tryAcquireLock(redis: RedisClient | null, ttlMs: number): Promise<boolean> {
  if (!redis) return false;
  try {
    const result = await redis.set(LOCK_KEY, '1', 'PX', ttlMs, 'NX');
    return result === 'OK';
  } catch (err) {
    log.warn('stuck-sweep.lock-failed', {
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}

async function sweepOnce(
  model: StuckExecutionSweeperModel,
  maxAgeMs: number,
  batchSize: number,
): Promise<void> {
  const cutoff = new Date(Date.now() - maxAgeMs);
  const sweepStart = Date.now();

  let candidates: StuckExecDoc[];
  try {
    candidates = await model
      .find({
        status: 'running',
        startedAt: { $lt: cutoff },
        // Exclude executions with an active approval / human-task step.
        // These have a per-step timeoutMs configured by the workflow designer
        // and must never be force-failed by the sweeper (SEC comment above).
        hasHumanWait: { $ne: true },
      })
      .sort({ startedAt: 1 })
      .limit(batchSize)
      .lean();
  } catch (err) {
    log.error('stuck-sweep.query-failed', {
      error: err instanceof Error ? err.message : String(err),
    });
    return;
  }

  if (candidates.length > 0) {
    log.warn('stuck-sweep.stuck-executions-found', {
      count: candidates.length,
      maxAgeMs,
      cutoff: cutoff.toISOString(),
    });
  }

  let markedFailed = 0;
  let skipped = 0;

  for (const doc of candidates) {
    try {
      const result = await model.findOneAndUpdate(
        {
          _id: doc._id,
          tenantId: doc.tenantId,
          projectId: doc.projectId,
          status: 'running',
          hasHumanWait: { $ne: true }, // double-check in the write filter
        },
        {
          $set: {
            status: 'failed',
            completedAt: new Date(),
            error: {
              code: 'INACTIVITY_TIMEOUT',
              message: `Workflow execution exceeded callback inactivity timeout (${maxAgeMs}ms) — marked failed by stuck-execution sweeper`,
            },
          },
        },
      );
      if (result) {
        markedFailed++;
        log.info('stuck-sweep.execution-timed-out', {
          executionId: doc._id,
          tenantId: doc.tenantId,
          projectId: doc.projectId,
          workflowId: doc.workflowId,
          startedAt: doc.startedAt?.toISOString(),
        });
      } else {
        skipped++; // Already transitioned, or hasHumanWait was set between query and write.
      }
    } catch (err) {
      skipped++;
      log.warn('stuck-sweep.mark-failed-error', {
        executionId: doc._id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  log.info('stuck-sweep.cycle-complete', {
    candidates: candidates.length,
    markedFailed,
    skipped,
    durationMs: Date.now() - sweepStart,
  });
}

/**
 * Start the periodic sweep. Returns a handle whose `stop()` clears all timers.
 * The sweep is a no-op when STUCK_EXECUTION_MAX_AGE_MS is unset or zero.
 */
export function startStuckExecutionSweeper(
  model: StuckExecutionSweeperModel,
  redis: RedisClient | null,
): StuckExecutionSweeperHandle {
  const maxAgeMs = parseEnvInt('STUCK_EXECUTION_MAX_AGE_MS', 4 * 60 * 60 * 1000, 0); // default 4 h; 0 = disable

  if (maxAgeMs === 0) {
    log.info('stuck-execution-sweeper.disabled', {
      reason: 'STUCK_EXECUTION_MAX_AGE_MS=0 — sweeper explicitly disabled',
    });
    return { stop(): void {} };
  }

  const intervalMs = parseEnvInt('STUCK_EXECUTION_SWEEP_INTERVAL_MS', DEFAULT_SWEEP_INTERVAL_MS);
  const batchSize = parseEnvInt('STUCK_EXECUTION_BATCH_SIZE', DEFAULT_BATCH_SIZE);

  const runSweep = async (): Promise<void> => {
    const lockTtl = Math.max(intervalMs - 5_000, 30_000);
    const haveLock = await tryAcquireLock(redis, lockTtl);
    if (!haveLock) {
      log.debug('stuck-sweep.skipped-no-lock');
      return;
    }
    try {
      await sweepOnce(model, maxAgeMs, batchSize);
    } catch (err) {
      log.error('stuck-sweep.cycle-unhandled', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  };

  const runOrLog = (): void => {
    runSweep().catch((err: unknown) => {
      log.error('stuck-sweep.timer-unhandled', {
        error: err instanceof Error ? err.message : String(err),
      });
    });
  };

  const bootTimer = setTimeout(runOrLog, 60_000);
  bootTimer.unref?.();
  const periodic = setInterval(runOrLog, intervalMs);
  periodic.unref?.();

  log.info('stuck-execution-sweeper.started', { intervalMs, maxAgeMs, batchSize });

  return {
    stop(): void {
      clearTimeout(bootTimer);
      clearInterval(periodic);
      log.info('stuck-execution-sweeper.stopped');
    },
  };
}
