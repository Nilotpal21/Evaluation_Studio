/**
 * Experiment Results Cron Handler
 *
 * Periodically computes results for all running experiments, evaluates
 * safety rules, and auto-stops experiments that breach safety thresholds.
 *
 * Uses a Redis distributed lock (SET NX PX) to prevent concurrent
 * execution across multiple pipeline-engine instances.
 */

import { createLogger } from '@abl/compiler/platform';
import { ExperimentResultsService } from '../services/experiment-results.service.js';
import { evaluateSafetyRules } from '../../services/experiment-safety.js';
import type { IExperiment, ExperimentBreachDetail } from '../../schemas/experiment.schema.js';

const log = createLogger('experiment-results-cron');

// ─── Configuration ─────────────────────────────────────────────────────

/** Redis lock key for distributed mutual exclusion. */
const LOCK_KEY = 'cron:experiment-results';

/** Lock TTL in milliseconds (5 minutes). */
const LOCK_TTL_MS = 5 * 60 * 1000;

/** Default cron interval in milliseconds (10 minutes). */
export const EXPERIMENT_RESULTS_CRON_INTERVAL_MS = 10 * 60 * 1000;

// ─── Redis Interface ───────────────────────────────────────────────────

/**
 * Extended Redis interface supporting SET NX PX for distributed locking.
 * ioredis supports this overload natively.
 */
interface LockableRedis {
  set(key: string, value: string, ...args: (string | number)[]): Promise<string | null>;
  del(...keys: string[]): Promise<number>;
}

// ─── Lock Helpers ──────────────────────────────────────────────────────

async function acquireLock(redis: LockableRedis): Promise<boolean> {
  // SET key value PX ttl NX — returns 'OK' if acquired, null if not
  const result = await redis.set(LOCK_KEY, '1', 'PX', LOCK_TTL_MS, 'NX');
  return result === 'OK';
}

async function releaseLock(redis: LockableRedis): Promise<void> {
  await redis.del(LOCK_KEY);
}

// ─── Cron Handler ──────────────────────────────────────────────────────

/**
 * Run one iteration of the experiment results cron.
 *
 * 1. Acquire distributed lock (skip if another instance holds it)
 * 2. Find all experiments with status='running'
 * 3. For each, compute results via ClickHouse + statistical tests
 * 4. Evaluate safety rules against computed results
 * 5. Auto-stop experiments that breach safety rules
 * 6. Release lock
 *
 * @param redis - Redis client for distributed locking and cache invalidation
 */
export async function runExperimentResultsCron(redis: LockableRedis): Promise<void> {
  const locked = await acquireLock(redis);
  if (!locked) {
    log.debug('Experiment results cron skipped — another instance holds the lock');
    return;
  }

  try {
    // Lazy import to avoid circular dependency at module load time
    const { ExperimentModel } = await import('../../schemas/experiment.schema.js');

    // Find all running experiments across all tenants
    const runningExperiments = await ExperimentModel.find({ status: 'running' }).lean<
      IExperiment[]
    >();

    if (runningExperiments.length === 0) {
      log.debug('No running experiments to process');
      return;
    }

    log.info('Processing experiment results', {
      count: runningExperiments.length,
    });

    const resultsService = new ExperimentResultsService();

    for (const experiment of runningExperiments) {
      try {
        await processExperiment(experiment, resultsService, redis);
      } catch (err) {
        log.error('Failed to process experiment results', {
          experimentId: String(experiment._id),
          tenantId: experiment.tenantId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  } finally {
    await releaseLock(redis);
  }
}

// ─── Per-Experiment Processing ─────────────────────────────────────────

async function processExperiment(
  experiment: IExperiment,
  resultsService: ExperimentResultsService,
  redis: LockableRedis,
): Promise<void> {
  const experimentId = String(experiment._id);
  const { tenantId, projectId } = experiment;

  // ── Compute results ──
  const results = await resultsService.computeExperimentResults(experimentId, tenantId, experiment);

  // ── Persist results on the experiment document ──
  const { ExperimentModel } = await import('../../schemas/experiment.schema.js');
  await ExperimentModel.findOneAndUpdate(
    { _id: experimentId, tenantId, status: 'running' },
    {
      $set: {
        results,
        lastResultsAt: new Date(),
      },
    },
  );

  // ── Evaluate safety rules ──
  if (experiment.safetyRules.length === 0) {
    return;
  }

  // Build metric maps from significance results
  const controlMetrics: Record<string, number> = {};
  const experimentMetrics: Record<string, number> = {};

  for (const sig of results.significance) {
    controlMetrics[sig.metric] = sig.controlMean;
    experimentMetrics[sig.metric] = sig.experimentMean;
  }

  const safetyResults = evaluateSafetyRules(
    experiment.safetyRules,
    controlMetrics,
    experimentMetrics,
    {
      control: results.controlSampleSize,
      experiment: results.experimentSampleSize,
    },
  );

  const breachedRules = safetyResults.filter((r) => !r.passing && !r.skipped);

  if (breachedRules.length === 0) {
    return;
  }

  // ── Auto-stop on safety breach ──
  const firstBreach = breachedRules[0];
  const breachDetail: ExperimentBreachDetail = {
    metric: firstBreach.metric,
    value: firstBreach.value,
    controlValue: firstBreach.controlValue,
    threshold: firstBreach.threshold,
    comparison: firstBreach.comparison,
    checkedAt: new Date(),
  };

  const now = new Date();

  await ExperimentModel.findOneAndUpdate(
    { _id: experimentId, tenantId, status: 'running' },
    {
      $set: {
        status: 'stopped',
        stoppedReason: 'safety_breach',
        breachDetail,
        stoppedAt: now,
        results,
        lastResultsAt: now,
      },
    },
  );

  log.warn('Experiment auto-stopped due to safety breach', {
    experimentId,
    tenantId,
    projectId,
    breachedMetric: firstBreach.metric,
    breachedValue: firstBreach.value,
    threshold: firstBreach.threshold,
    comparison: firstBreach.comparison,
    totalBreaches: breachedRules.length,
  });

  // ── Write audit log ──
  try {
    const { AuditLog } = await import('@agent-platform/database/models');
    await AuditLog.create({
      tenantId,
      userId: null, // system action
      action: 'experiment.auto_stopped',
      metadata: {
        experimentId,
        projectId,
        reason: 'safety_breach',
        breachDetail,
        breachedRuleCount: breachedRules.length,
      },
    });
  } catch (auditErr) {
    log.warn('Failed to write audit log for experiment auto-stop', {
      experimentId,
      error: auditErr instanceof Error ? auditErr.message : String(auditErr),
    });
  }

  // ── Invalidate Redis cache ──
  // The cache key pattern from ExperimentService is 'experiment:active:{tenantId}:{projectId}'
  try {
    const cacheKey = `experiment:active:${tenantId}:${projectId}`;
    await redis.del(cacheKey);
    log.info('Experiment cache invalidated after safety breach auto-stop', {
      experimentId,
      tenantId,
      projectId,
    });
  } catch (cacheErr) {
    log.warn('Failed to invalidate experiment cache after auto-stop', {
      experimentId,
      error: cacheErr instanceof Error ? cacheErr.message : String(cacheErr),
    });
  }
}
