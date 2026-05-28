/**
 * Restate Server Entrypoint
 *
 * Connects to MongoDB, then binds all Restate handlers into a single endpoint.
 * The endpoint listens on RESTATE_SERVICE_PORT (default: 9082) and exposes
 * all handlers for discovery and invocation by the Restate runtime.
 *
 * On startup:
 *   1. Connect MongoDB, init ClickHouse
 *   2. Seed all 10 built-in pipeline definitions (upsert)
 *   3. Listen on Restate endpoint
 *   4. Register deployment with Restate admin
 *   5. Register Kafka subscriptions for event-driven triggers
 *
 * PipelineScheduler lifecycle is driven by user action, not server startup:
 *   - Builtin schedule pipelines (drift_detection, anomaly_detection): started/stopped
 *     by the runtime toggle route when a user enables/disables the pipeline for a project.
 *   - User-created schedule pipelines: started/stopped by the runtime activate/deactivate
 *     endpoints. Restate's durable sleep survives pod restarts — no re-registration needed.
 */
import * as restate from '@restatedev/restate-sdk';
import { createLogger } from '@abl/compiler/platform';
import { ensureConnected } from '@agent-platform/database/models';
import {
  createRedisConnection,
  resolveRedisOptionsFromEnv,
  type RedisConnectionHandle,
} from '@agent-platform/redis';
import { initDefinitionCache, invalidateDefinitionCache } from './services/definition-cache.js';
import { loadConfig } from './config.js';
import { seedBuiltinPipelineDefinitions } from './seed-defaults.js';
import {
  auditKafkaSubscriptions,
  buildKafkaSubscriptionSources,
  summarizeStartupProbes,
  type StartupProbe,
} from './startup-diagnostics.js';

const log = createLogger('pipeline-server');

import { getClickHouseClient } from '@agent-platform/database/clickhouse';
import { ensureClickHouseSchemaReady } from '@agent-platform/database/clickhouse-schemas/init-all';
import { assertDefaultSyntheticRetentionIsShorter } from '@agent-platform/database';
import { pipelineRun } from './handlers/pipeline-run.workflow.js';
import { pipelineTrigger } from './handlers/pipeline-trigger.service.js';
import { pipelineScheduler } from './handlers/pipeline-scheduler.js';
import { activityRouter } from './handlers/activity-router.service.js';
import { evaluateMetricsService } from './services/evaluate-metrics.service.js';
import { evaluatePolicyService } from './services/evaluate-policy.service.js';
import { storeResultsService } from './services/store-results.service.js';
import { sendNotificationService } from './services/send-notification.service.js';
import { transformService } from './services/transform.service.js';
import { runLegacyWorkflowService } from './services/run-legacy-workflow.service.js';
import { storeInsightService } from './services/store-insight.service.js';
import { computeToxicityService } from './services/compute-toxicity.service.js';
import { computeToolEffectivenessService } from './services/compute-tool-effectiveness.service.js';
import { llmEvaluateService } from './services/llm-evaluate.service.js';
import { readConversationService } from './services/read-conversation.service.js';
import { computeSentimentService } from './services/compute-sentiment.service.js';
import { computeIntentService } from './services/compute-intent.service.js';
import { computeQualityService } from './services/compute-quality.service.js';
import { conversationAnalyzerService } from './services/compute-llm-evaluation.service.js';
import { computeStatisticalService } from './services/compute-statistical.service.js';
import { computePredictiveFeaturesService } from './services/compute-predictive-features.service.js';
import { computeMentionsService } from './services/compute-mentions.service.js';
import { computeGoalCompletionService } from './services/compute-goal-completion.service.js';
import { httpRequestService } from './services/http-request.service.js';
import { readMessageWindowService } from './services/read-message-window.service.js';

// Extended node types
import { subPipelineService } from './services/sub-pipeline.service.js';
import { dbQueryService } from './services/db-query.service.js';
import { filterService } from './services/filter.service.js';
import { aggregateService } from './services/aggregate.service.js';
import { sendEmailService } from './services/send-email.service.js';
import { sendSlackService } from './services/send-slack.service.js';
import { publishKafkaService } from './services/publish-kafka.service.js';

// Alert evaluation
import { alertEvaluatorService } from './services/alert-evaluator.service.js';
import { alertEvaluationScheduler } from './handlers/alert-evaluation-scheduler.js';

// Experiment results cron
import {
  runExperimentResultsCron,
  EXPERIMENT_RESULTS_CRON_INTERVAL_MS,
} from './handlers/experiment-results-cron.js';

type ExperimentResultsCronRedis = Parameters<typeof runExperimentResultsCron>[0];

// Eval pipeline workflow + services
import { evalRunWorkflow } from './handlers/eval-run.workflow.js';
import {
  evalRetentionScheduler,
  evalRetentionSweepService,
} from './handlers/eval-retention-scheduler.js';
import { simulatePersonaService } from './services/eval/simulate-persona.service.js';
import { executeAgentTurnService } from './services/eval/execute-agent-turn.service.js';
import { runEvalConversationService } from './services/eval/run-eval-conversation.service.js';
import { judgeConversationService } from './services/eval/judge-conversation.service.js';
import { aggregateEvalRunService } from './services/eval/aggregate-eval-run.service.js';
import { evalPreflightService } from './services/eval/eval-preflight.service.js';
import { isPreflightWarningStatus, runEvalPreflight } from './services/eval/eval-preflight.js';
import {
  createEvalRetentionClickHouseTraceSink,
  setEvalRetentionTraceSink,
} from './services/eval/eval-retention-cleanup.js';

const port = parseInt(process.env.RESTATE_SERVICE_PORT ?? '9082', 10);

const RESTATE_ADMIN_URL = process.env.RESTATE_ADMIN_URL || 'http://localhost:9070';
const RESTATE_ENDPOINT_URL = process.env.RESTATE_ENDPOINT_URL || `http://localhost:${port}`;
const RESTATE_INGRESS_URL = process.env.RESTATE_INGRESS_URL || 'http://localhost:8091';
const PIPELINE_TRIGGER_SINK = 'service://PipelineTrigger/handleEvent';

const KAFKA_TOPICS = [
  'abl.session.created',
  'abl.session.ended',
  'abl.session.handoff',
  'abl.session.escalation',
  'abl.message.user',
  'abl.message.agent',
  'abl.tool.called',
  'abl.tool.completed',
];
const EXPECTED_KAFKA_SUBSCRIPTION_SOURCES = buildKafkaSubscriptionSources(KAFKA_TOPICS);

// ─── Auto-seed pipeline definitions into MongoDB ──────────────────
async function seedBuiltinDefinitions(): Promise<void> {
  try {
    const seeded = await seedBuiltinPipelineDefinitions();
    log.info(`Seeded ${seeded} pipeline definitions`);
  } catch (err) {
    log.warn('Failed to seed pipeline definitions (non-fatal)', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

// ─── Retry helper ────────────────────────────────────────────────
// Retries an async operation with exponential backoff.
// Returns the result of the first successful call, or throws the last error.
async function retryWithBackoff<T>(
  fn: () => Promise<T>,
  { attempts, baseDelayMs, label }: { attempts: number; baseDelayMs: number; label: string },
): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (attempt < attempts) {
        const delayMs = baseDelayMs * 2 ** (attempt - 1);
        log.warn(`${label} attempt ${attempt}/${attempts} failed, retrying in ${delayMs}ms`, {
          error: err instanceof Error ? err.message : String(err),
        });
        await new Promise((r) => setTimeout(r, delayMs));
      }
    }
  }
  throw lastErr;
}

// ─── Register deployment with Restate admin ───────────────────────
// Uses `force: true` so Restate discovers updated handler code and avoids
// journal-mismatch errors (RT0016 / error 570) when replaying invocations
// that were journaled against a previous code version.
//
// Retries up to 5 times with exponential backoff (2 s → 32 s) to handle
// the transient startup race where Restate returns 500 because it cannot
// yet reach the endpoint for service discovery immediately after listen().
async function registerWithRestate(): Promise<StartupProbe> {
  const MAX_ATTEMPTS = 5;
  const BASE_DELAY_MS = 2_000;

  try {
    await retryWithBackoff(
      async () => {
        const response = await fetch(`${RESTATE_ADMIN_URL}/deployments`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ uri: RESTATE_ENDPOINT_URL, force: true }),
        });
        if (!response.ok) {
          const body = await response.text().catch(() => '');
          throw new Error(
            `Restate admin returned ${response.status}: ${response.statusText} — ${body}`,
          );
        }
      },
      {
        attempts: MAX_ATTEMPTS,
        baseDelayMs: BASE_DELAY_MS,
        label: 'Restate deployment registration',
      },
    );

    log.info('Registered with Restate (force=true)', { adminUrl: RESTATE_ADMIN_URL });
    return {
      dependency: 'restate_deployment_registration',
      status: 'pass',
      detail: 'Registered deployment with Restate admin',
      metadata: {
        adminUrl: RESTATE_ADMIN_URL,
        endpointUrl: RESTATE_ENDPOINT_URL,
      },
    };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    log.warn('Failed to register with Restate after retries', {
      adminUrl: RESTATE_ADMIN_URL,
      endpointUrl: RESTATE_ENDPOINT_URL,
      error,
    });
    return {
      dependency: 'restate_deployment_registration',
      status: 'fail',
      detail: `Restate deployment registration failed: ${error}`,
      metadata: {
        adminUrl: RESTATE_ADMIN_URL,
        endpointUrl: RESTATE_ENDPOINT_URL,
      },
    };
  }
}

// ─── Register Kafka subscriptions with Restate ────────────────────
async function registerKafkaSubscriptions(): Promise<StartupProbe> {
  // Fetch existing subscriptions to avoid creating duplicates.
  // Without this check, every restart accumulates extra subscriptions and
  // Restate delivers each Kafka message once per subscription, causing
  // N-fold duplicate pipeline runs and LLM calls.
  const existingSources = new Set<string>();
  try {
    const listRes = await fetch(`${RESTATE_ADMIN_URL}/subscriptions`);
    if (listRes.ok) {
      const body = (await listRes.json()) as {
        subscriptions?: { source: string; sink: string }[];
      };
      for (const sub of body.subscriptions ?? []) {
        if (sub.sink === PIPELINE_TRIGGER_SINK) {
          existingSources.add(sub.source);
        }
      }
      if (existingSources.size > 0) {
        log.info(`Found ${existingSources.size} existing Kafka subscriptions, skipping duplicates`);
      }
    } else {
      const body = await listRes.text().catch(() => '');
      log.error('Cannot list existing subscriptions — skipping registration to avoid duplicates', {
        status: listRes.status,
        statusText: listRes.statusText,
        body,
      });
      return {
        dependency: 'restate_kafka_subscriptions',
        status: 'fail',
        detail: `Restate subscription list returned ${listRes.status}: ${listRes.statusText}`,
        metadata: {
          adminUrl: RESTATE_ADMIN_URL,
          expectedSources: EXPECTED_KAFKA_SUBSCRIPTION_SOURCES,
        },
      };
    }
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    log.error('Cannot list existing subscriptions — skipping registration to avoid duplicates', {
      error,
    });
    // Fail-hard: if we can't confirm what subscriptions exist, bail out entirely.
    // Subscriptions persist in Restate — they don't need re-registration on every startup.
    // The old fail-open behavior created duplicate subscriptions on every restart when
    // Restate was down, causing N-fold duplicate pipeline runs and OOM cascades.
    return {
      dependency: 'restate_kafka_subscriptions',
      status: 'fail',
      detail: `Could not inspect existing subscriptions: ${error}`,
      metadata: {
        adminUrl: RESTATE_ADMIN_URL,
        expectedSources: EXPECTED_KAFKA_SUBSCRIPTION_SOURCES,
      },
    };
  }

  const initialAudit = auditKafkaSubscriptions(
    EXPECTED_KAFKA_SUBSCRIPTION_SOURCES,
    existingSources,
  );
  let registered = 0;
  const skipped = initialAudit.totalExpected - initialAudit.missingSources.length;
  const failedSources: string[] = [];
  for (const source of initialAudit.missingSources) {
    const topic = source.replace('kafka://local/', '');
    try {
      const response = await fetch(`${RESTATE_ADMIN_URL}/subscriptions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          source,
          sink: PIPELINE_TRIGGER_SINK,
        }),
      });
      if (response.ok || response.status === 409) {
        registered++;
        existingSources.add(source);
      } else {
        failedSources.push(source);
        const body = await response.text().catch(() => '');
        log.warn(`Failed to subscribe to ${topic}`, {
          status: response.status,
          statusText: response.statusText,
          body,
        });
      }
    } catch (err) {
      failedSources.push(source);
      log.warn(`Could not create subscription for ${topic}`, {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const finalAudit = auditKafkaSubscriptions(EXPECTED_KAFKA_SUBSCRIPTION_SOURCES, existingSources);
  log.info(
    `Kafka subscriptions: ${registered} registered, ${skipped} already existed (${KAFKA_TOPICS.length} total)`,
  );

  if (finalAudit.isComplete) {
    return {
      dependency: 'restate_kafka_subscriptions',
      status: 'pass',
      detail: `All ${finalAudit.totalExpected} Kafka subscriptions are present`,
      metadata: {
        expectedSources: finalAudit.expectedSources,
        existingSources: finalAudit.existingSources,
        missingSources: finalAudit.missingSources,
        totalExpected: finalAudit.totalExpected,
        totalExisting: finalAudit.totalExisting,
        isComplete: finalAudit.isComplete,
      },
    };
  }

  return {
    dependency: 'restate_kafka_subscriptions',
    status: 'fail',
    detail: `Missing ${finalAudit.missingSources.length} Kafka subscriptions after registration`,
    metadata: {
      ...finalAudit,
      failedSources,
    },
  };
}

function logStartupDiagnostics(checks: readonly StartupProbe[]): void {
  const summary = summarizeStartupProbes(checks);

  if (summary.overall === 'fail') {
    log.error('Startup diagnostics detected failed dependencies', {
      failingDependencies: summary.failingDependencies,
      warningDependencies: summary.warningDependencies,
      checks: summary.checks,
    });
    return;
  }

  if (summary.overall === 'warn') {
    log.warn('Startup diagnostics detected degraded dependencies', {
      warningDependencies: summary.warningDependencies,
      checks: summary.checks,
    });
    return;
  }

  log.info('Startup diagnostics passed', {
    checks: summary.checks,
  });
}

async function startEvalRetentionScheduler(): Promise<void> {
  if (process.env.EVAL_RETENTION_SCHEDULER_DISABLED === 'true') {
    log.info('Eval retention scheduler disabled by env');
    return;
  }

  try {
    const response = await fetch(
      `${RESTATE_INGRESS_URL}/EvalRetentionScheduler/global/start/send`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      },
    );
    if (!response.ok) {
      const body = await response.text().catch(() => '');
      log.warn('Failed to start eval retention scheduler via Restate ingress', {
        status: response.status,
        body,
      });
    }
  } catch (error) {
    log.warn('Failed to start eval retention scheduler via Restate ingress', {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

async function start() {
  // Load validated config (JWT, eval settings) via @agent-platform/config
  await loadConfig({ logSummary: false });
  assertDefaultSyntheticRetentionIsShorter();
  log.info('Config loaded');

  // Wait for the barrel's auto-connect to complete (uses MONGODB_URL env var)
  await ensureConnected();
  log.info('MongoDB connected');

  // Set the Mongoose encryption plugin master key (used by LLMCredential auto-decrypt)
  const encMasterKey = process.env.ENCRYPTION_MASTER_KEY;
  if (!encMasterKey) {
    throw new Error('ENCRYPTION_MASTER_KEY is required for pipeline-engine startup');
  }

  const { setMasterKey } = await import('@agent-platform/database/models');
  setMasterKey(encMasterKey);
  log.info('Mongoose field encryption master key set');

  try {
    const { withTenantContext } = await import('@agent-platform/database/mongo');
    const { initDEKFacade, setGlobalKMSResolver } = await import('@agent-platform/database/kms');
    const dek = await initDEKFacade({
      masterKeyHex: encMasterKey,
      logger: log,
      tenantContextRunner: (tenantId, fn) => withTenantContext({ tenantId }, fn),
    });
    setGlobalKMSResolver(dek.resolver);
    log.info('DEK encryption facade initialized');
  } catch (tenantEncError) {
    throw new Error(
      `DEK facade initialization failed: ${tenantEncError instanceof Error ? tenantEncError.message : String(tenantEncError)}`,
    );
  }

  // Initialize Redis for definition cache (fail-open)
  let redisClient: ExperimentResultsCronRedis | null = null;
  let redisHandle: RedisConnectionHandle | null = null;
  const redisOptions = resolveRedisOptionsFromEnv();
  if (redisOptions?.url || redisOptions?.host || redisOptions?.port) {
    try {
      const handle = createRedisConnection({
        ...redisOptions,
        maxRetriesPerRequest: 3,
        lazyConnect: true,
      });
      redisHandle = handle;
      const redis = handle.client;
      await redis.connect();
      redisClient = redis as unknown as ExperimentResultsCronRedis;
      initDefinitionCache(redis);
      // Clear stale cache on startup so fresh definitions are loaded
      await invalidateDefinitionCache(redis);
      log.info('Redis connected — definition cache enabled');
    } catch (err) {
      log.warn('Redis unavailable — definition cache disabled (fail-open)', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  } else {
    log.info('Redis not configured — definition cache disabled (direct MongoDB queries)');
  }

  // ClickHouse schema DDL is now handled by the centralized PreSync CLI.
  // Services only use the client for reads/writes — no DDL at startup.
  // Transitional safety net: verify tables exist, run init as fallback if not.
  const chClient = getClickHouseClient();
  await ensureClickHouseSchemaReady(chClient);
  setEvalRetentionTraceSink(
    createEvalRetentionClickHouseTraceSink(chClient, {
      database: process.env.CLICKHOUSE_DATABASE,
    }),
  );
  log.info('ClickHouse client ready');

  // Fire-and-forget system-level preflight (non-blocking)
  runEvalPreflight('_system_')
    .then((result) => {
      if (result.overall === 'fail') {
        const failed = result.checks
          .filter((c) => c.status === 'fail')
          .map((c) => `${c.name}: ${c.message}`);
        log.warn('Startup preflight: FAILED checks detected', { failed });
      } else if (result.overall === 'warn') {
        const warned = result.checks
          .filter((c) => isPreflightWarningStatus(c.status))
          .map((c) => `${c.name}: ${c.message}`);
        log.info('Startup preflight: warnings detected', { warned });
      } else {
        log.info('Startup preflight: all checks passed');
      }
    })
    .catch((err) => {
      log.warn('Startup preflight failed to run', {
        error: err instanceof Error ? err.message : String(err),
      });
    });

  // Seed all built-in pipeline definitions into MongoDB
  await seedBuiltinDefinitions();

  await restate
    .endpoint()
    .bind(pipelineRun)
    .bind(pipelineTrigger)
    .bind(pipelineScheduler)
    .bind(activityRouter)
    .bind(evaluateMetricsService)
    .bind(evaluatePolicyService)
    .bind(storeResultsService)
    .bind(sendNotificationService)
    .bind(transformService)
    .bind(runLegacyWorkflowService)
    .bind(storeInsightService)
    .bind(computeToxicityService)
    .bind(computeToolEffectivenessService)
    .bind(llmEvaluateService)
    .bind(readConversationService)
    .bind(computeSentimentService)
    .bind(computeIntentService)
    .bind(computeQualityService)
    .bind(conversationAnalyzerService)
    .bind(computeStatisticalService)
    .bind(computePredictiveFeaturesService)
    .bind(computeMentionsService)
    .bind(computeGoalCompletionService)
    .bind(httpRequestService)
    .bind(readMessageWindowService)
    // Extended node types
    .bind(subPipelineService)
    .bind(dbQueryService)
    .bind(filterService)
    .bind(aggregateService)
    .bind(sendEmailService)
    .bind(sendSlackService)
    .bind(publishKafkaService)
    // Alert evaluation
    .bind(alertEvaluatorService)
    .bind(alertEvaluationScheduler)
    // Eval pipeline workflow + services
    .bind(evalRunWorkflow)
    .bind(simulatePersonaService)
    .bind(executeAgentTurnService)
    .bind(runEvalConversationService)
    .bind(judgeConversationService)
    .bind(aggregateEvalRunService)
    .bind(evalPreflightService)
    .bind(evalRetentionSweepService)
    .bind(evalRetentionScheduler)
    .listen(port);

  log.info(`Restate server listening on port ${port}`);

  // Register with Restate and set up Kafka subscriptions
  const deploymentProbe = await registerWithRestate();
  const subscriptionProbe = await registerKafkaSubscriptions();
  logStartupDiagnostics([deploymentProbe, subscriptionProbe]);
  if (deploymentProbe.status === 'pass') {
    await startEvalRetentionScheduler();
  }

  // Start experiment results cron (requires Redis for distributed locking)
  if (redisClient) {
    setInterval(() => {
      runExperimentResultsCron(redisClient).catch((err) => {
        log.warn('Experiment results cron iteration failed', {
          error: err instanceof Error ? err.message : String(err),
        });
      });
    }, EXPERIMENT_RESULTS_CRON_INTERVAL_MS);
    log.info('Experiment results cron registered', {
      intervalMs: EXPERIMENT_RESULTS_CRON_INTERVAL_MS,
    });
  } else {
    log.info('Experiment results cron disabled — Redis not available');
  }
}

start().catch((err) => {
  log.error('Failed to start pipeline engine', {
    error: err instanceof Error ? err.message : String(err),
  });
  process.exit(1);
});
