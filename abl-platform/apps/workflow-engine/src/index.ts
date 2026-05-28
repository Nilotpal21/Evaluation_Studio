/**
 * Workflow Engine — Restate-backed durable workflow execution service.
 *
 * Entry point: starts Express server with API routes, health checks,
 * and Restate endpoint registration. OTel instrumentation is initialized
 * first (before any other imports) so it can monkey-patch HTTP/Express.
 */

// Load environment variables from .env file
import 'dotenv/config';

// OTel MUST be imported before any other module
import './observability/otel-setup.js';

import express, { type Express, type Request, type Response, type NextFunction } from 'express';
import { requestIdMiddleware } from '@agent-platform/shared';
import { getServiceBuildInfo } from '@agent-platform/shared/build-info';
import { createServiceToken } from '@agent-platform/shared-auth';
import { authMiddleware } from './middleware/auth.js';
import { decryptForTenantAuto, encryptForTenantAuto } from '@agent-platform/shared/encryption';
import { wrapJobDataForEncrypt } from '@agent-platform/shared-encryption';
import {
  Workflow,
  WorkflowExecution,
  HumanTask,
  ConnectorConnection,
  TriggerRegistration,
  Deployment,
  WorkflowVersion,
  WorkflowEventOutboxModel,
} from '@agent-platform/database/models';
import {
  ConnectorRegistry,
  ConnectionResolver,
  ConnectorToolExecutor,
  loadConnectors,
  TriggerEngine as ConnectorTriggerEngine,
  processPollingJob,
} from '@agent-platform/connectors';
import { Queue, Worker } from 'bullmq';
import { createLogger } from '@abl/compiler/platform';
import { scanToolParamsForPII, createLoggerTraceEventSink } from './services/pii-safety-net.js';
import { runWithObservabilityContext } from '@abl/compiler/platform/observability';
import { createObservabilityMiddleware } from '@agent-platform/shared-observability';
import {
  SHUTDOWN_TIMEOUT_MS,
  DEFAULT_RESTATE_ENDPOINT_PORT,
  POLLING_WORKER_CONCURRENCY,
} from './constants.js';
import { createCallbackRateLimit } from './routes/workflow-callbacks.js';
import {
  createWorkflowExecutionRouter,
  createCallbackRouter,
  createApprovalRouter,
  createConnectionRouter,
  createConnectorRouter,
  createConnectorWebhookRouter,
  createNotificationRuleRouter,
  createTriggerRouter,
  createTriggerCatalogRouter,
  createWebhookRouter,
} from './routes/index.js';
import { initDatabase, disconnectDatabase, isDatabaseAvailable } from './services/database.js';
import {
  initRedis,
  getRedisClient,
  getRedisHandle,
  disconnectRedis,
  pingRedis,
} from './services/redis.js';
import { createBullMQPair, BULLMQ_CLUSTER_SAFE_PREFIX } from '@agent-platform/redis';
import { RestateWorkflowClient } from './services/restate-client.js';
import { TriggerEngine } from './services/trigger-engine.js';
import { TriggerScheduler } from './services/trigger-scheduler.js';
import { convertWorkflowDocToSteps } from './handlers/canvas-to-steps.js';
import { rehydrateConnectorTriggers } from './services/connector-trigger-rehydrator.js';
import { ExecutionStore } from './persistence/execution-store.js';
import { buildRestateEndpoint } from './services/restate-endpoint.js';
import { RuntimeMemoryClient } from './clients/runtime-memory-client.js';
import { CallbackDeliveryWorker } from './services/callback-delivery-worker.js';
import {
  NotificationDispatcher,
  type WorkflowNotificationRule,
  type NotificationEvent,
} from './notifications/notification-dispatcher.js';
import type { WorkflowContextData } from './context/step-context-schema.js';
import type {
  RuntimeClient,
  AgentInvocationResult,
} from './executors/agent-invocation-executor.js';
import type { ToolExecutionClient, ToolCallResult } from './executors/tool-call-executor.js';
import type { CallbackUrlBuilder } from './executors/async-webhook-executor.js';
import type { ConnectorActionDeps } from './executors/connector-action-executor.js';
import type { WorkflowExecutionInput } from './handlers/workflow-handler.js';
import { createFileStorage } from './storage/storage-factory.js';
import { getStorageConfig } from './config/storage.js';
import { signAttachmentToken } from './lib/attachment-token.js';
import { startAttachmentCleanup } from './services/attachment-cleanup.js';
import { startStuckExecutionSweeper } from './services/stuck-execution-sweeper.js';
import type { StuckExecutionSweeperHandle } from './services/stuck-execution-sweeper.js';
import { startHumanStepTimeoutEnforcer } from './services/human-step-timeout-enforcer.js';
import type { HumanStepTimeoutHandle } from './services/human-step-timeout-enforcer.js';
import { createAttachmentsRouter } from './routes/attachments.js';
import { createFileWriterFactory } from './lib/attachment-writer.js';

const log = createLogger('workflow-engine');
const PORT = parseInt(process.env.PORT || '9080', 10);
const RESTATE_ENDPOINT_PORT = parseInt(
  process.env.RESTATE_ENDPOINT_PORT || String(DEFAULT_RESTATE_ENDPOINT_PORT),
  10,
);
const RESTATE_ADMIN_URL = process.env.RESTATE_ADMIN_URL || 'http://localhost:9070';

/**
 * Build the bearer header used on every outbound Restate call (admin + ingress).
 * Matches the `RestateWorkflowClient.buildHeaders()` contract — when
 * `RESTATE_INGRESS_AUTH_TOKEN` is set, Restate (or the auth sidecar in front
 * of it) is expected to reject requests missing the matching bearer, which
 * is what finding ABLP-2 #4 asks for. Returns an empty object in dev when
 * the env var is unset so local setups keep working.
 */
function restateAuthHeader(): Record<string, string> {
  const token = process.env.RESTATE_INGRESS_AUTH_TOKEN;
  return token && token.length > 0 ? { Authorization: `Bearer ${token}` } : {};
}

// How often to re-assert the workflow-runner deployment with Restate admin.
// Re-registration is idempotent (force: true) — the reconciler exists to
// self-heal after Restate loses state (pod restart, PVC wipe, admin reset)
// without requiring a workflow-engine restart.
const RESTATE_RECONCILE_INTERVAL_MS = 60_000;
// Initial backoff for the startup registration loop. Doubles on each failure
// up to RESTATE_BACKOFF_MAX_MS. No total retry limit — retries are safe because
// the self-healing client (postWithReregister) covers the gap in-flight.
const RESTATE_BACKOFF_INITIAL_MS = 500;
const RESTATE_BACKOFF_MAX_MS = 10_000;
const RESTATE_REGISTRATION_TIMEOUT_MS = 10_000;

const app: Express = express();
let isShuttingDown = false;
let isRestateRegistered = false;
let isRestateHealthy = false;

// Workflow event-sourcing pipeline readiness signals (ABLP-2). Each flag
// is polled periodically so the `/health/ready` handler stays fast (no
// per-request I/O). A flag is only *consulted* when the matching env
// `_ENABLED` gate is on, so dev envs without Redis / ClickHouse stay ready.
let isWorkflowRedisHealthy = false;
let isWorkflowClickHouseHealthy = false;
let workflowPipelineHealthTimer: NodeJS.Timeout | undefined;
let reconcileTimer: NodeJS.Timeout | undefined;
let activeTriggerScheduler: TriggerScheduler | undefined;
let activeCallbackDeliveryWorker: CallbackDeliveryWorker | undefined;
let activePollingWorker: InstanceType<typeof Worker> | undefined;
let activeAdiPollWorker: { close: () => Promise<void> } | undefined;
let activeStuckExecutionSweeper: StuckExecutionSweeperHandle | undefined;
let activeHumanStepTimeoutEnforcer: HumanStepTimeoutHandle | undefined;
let activeOutboxPoller:
  | InstanceType<typeof import('./outbox/outbox-poller.js').OutboxPoller>
  | undefined;

// ─── Body parsing ─────────────────────────────────────────────
// Capture raw body for HMAC signature verification on webhook/callback routes.
// All parsers store the raw buffer on req.rawBody so signature checks work
// regardless of Content-Type.
const captureRawBody = (req: Request, _res: Response, buf: Buffer) => {
  (req as any).rawBody = buf;
};
app.use(express.json({ limit: '1mb', verify: captureRawBody }));
app.use(express.urlencoded({ extended: true, limit: '1mb', verify: captureRawBody }));

// Paths excluded from observability/request-ID wrapping (health probes, metrics)
const observabilityExcludePaths = ['/health', '/health/ready', '/metrics'];

// ─── Request ID ───────────────────────────────────────────────
app.use(requestIdMiddleware({ excludePaths: observabilityExcludePaths }));

// ─── Observability context (W3C traceparent, traceId propagation via ALS) ───
app.use(
  createObservabilityMiddleware({
    runWithContext: (ctx, fn) => runWithObservabilityContext(ctx, fn),
    excludePaths: observabilityExcludePaths,
  }),
);

// ─── Health checks (unauthenticated) ─────────────────────────
app.get('/health', (_req: Request, res: Response) => {
  res.json({ ok: true, service: 'workflow-engine', build: getServiceBuildInfo() });
});

// ─── Diagnose (internal-network only) ─────────────────────────
// Full configuration + dependency + wiring snapshot for operators. Gated
// behind the shared internal-network middleware so it never surfaces
// publicly through an ingress.
import { requireInternalNetworkAccess } from './middleware/internal-network.js';
import { createDiagnoseHandler } from './diagnose/diagnose-handler.js';
import { probeKafkaFromProducer } from './diagnose/kafka-diagnostics.js';
import { classifyProbeError } from './diagnose/error-classifier.js';
import { createDiagnoseRateLimit, createRequireDiagnoseKey } from './diagnose/diagnose-access.js';

const WORKFLOW_EXECUTION_TOPIC_NAME = 'abl.workflow.execution';
const HUMAN_TASK_TOPIC_NAME = 'abl.human.task';

app.get(
  '/diagnose',
  requireInternalNetworkAccess,
  createRequireDiagnoseKey(),
  createDiagnoseRateLimit(),
  createDiagnoseHandler({
    auditLogger: {
      info: (event, fields) => log.info(event, fields),
    },
    getServiceBuildInfo: () => getServiceBuildInfo(),
    probeMongo: async () => {
      const start = performance.now();
      if (!isDatabaseAvailable()) {
        return { ok: false, latencyMs: 0, detail: 'not_connected' };
      }
      try {
        const { MongoConnectionManager } = await import('@agent-platform/database/mongo');
        const health = await MongoConnectionManager.getInstance().healthCheck();
        return {
          ok: health.ok,
          latencyMs: Math.round(performance.now() - start),
          detail: health.ok ? undefined : 'healthcheck_failed',
        };
      } catch (err) {
        log.warn('diagnose.mongo_probe_failed', {
          error: err instanceof Error ? err.message : String(err),
        });
        return {
          ok: false,
          latencyMs: Math.round(performance.now() - start),
          detail: classifyProbeError(err),
        };
      }
    },
    probeRedis: async () => {
      const start = performance.now();
      const ok = await pingRedis(2_000);
      return {
        ok,
        latencyMs: Math.round(performance.now() - start),
        ...(ok ? {} : { detail: 'ping_failed' }),
      };
    },
    probeClickHouse: async () => {
      if (process.env.WORKFLOW_DUAL_READ_ENABLED !== 'true') return null;
      const start = performance.now();
      try {
        const { getClickHouseClient } = await import('@agent-platform/database/clickhouse');
        const result = await getClickHouseClient().ping();
        if (!result.success) {
          log.warn('diagnose.clickhouse_probe_failed', {
            error: result.error?.message ?? 'ping failed',
          });
        }
        return {
          ok: result.success,
          latencyMs: Math.round(performance.now() - start),
          detail: result.success ? undefined : classifyProbeError(result.error ?? 'ping failed'),
        };
      } catch (err) {
        log.warn('diagnose.clickhouse_probe_failed', {
          error: err instanceof Error ? err.message : String(err),
        });
        return {
          ok: false,
          latencyMs: Math.round(performance.now() - start),
          detail: classifyProbeError(err),
        };
      }
    },
    probeKafka: async () => {
      if (process.env.WORKFLOW_OUTBOX_ENABLED !== 'true') return null;
      const brokers = (process.env.EVENT_KAFKA_BROKERS ?? 'localhost:9092').split(',');
      return probeKafkaFromProducer({
        brokers,
        topicsToCheck: [WORKFLOW_EXECUTION_TOPIC_NAME, HUMAN_TASK_TOPIC_NAME],
      });
    },
    getOutboxPollerState: () => {
      const poller = activeOutboxPoller;
      if (!poller) {
        return { running: false, pollIntervalMs: null, unpublishedRows: null };
      }
      const pollInterval = parseInt(process.env.WORKFLOW_OUTBOX_POLL_INTERVAL_MS ?? '1000', 10);
      return {
        running: !isShuttingDown,
        pollIntervalMs: Number.isFinite(pollInterval) ? pollInterval : 1000,
        // Backlog is expensive to compute — skipped here; operators can read
        // the `workflow.outbox.unpublished_rows` gauge from /metrics instead.
        unpublishedRows: null,
      };
    },
  }),
);

app.get('/health/ready', (_req: Request, res: Response) => {
  if (isShuttingDown) {
    return res.status(503).json({ ok: false, reason: 'shutting_down' });
  }
  if (!isDatabaseAvailable()) {
    return res.status(503).json({ ok: false, reason: 'database_not_ready' });
  }
  // Readiness gates on Restate *reachability*, not registration. Gating on
  // registration creates a deadlock: Restate's discovery callback goes through
  // the K8s Service, which only routes to ready pods — but readiness requires
  // registration to have already succeeded. Checking that Restate admin is
  // healthy is sufficient: the pod must be routable so Restate can discover it,
  // and the registration loop will complete once discovery succeeds.
  if (!isRestateHealthy) {
    return res.status(503).json({ ok: false, reason: 'restate_not_healthy' });
  }
  // Event-sourcing pipeline gates (ABLP-2). Each is consulted only when its
  // `_ENABLED` flag is on — so the probe's behaviour is unchanged for
  // environments with the migration off (the default).
  if (process.env.WORKFLOW_OUTBOX_ENABLED === 'true' && !isWorkflowRedisHealthy) {
    return res.status(503).json({ ok: false, reason: 'workflow_redis_not_healthy' });
  }
  if (process.env.WORKFLOW_DUAL_READ_ENABLED === 'true' && !isWorkflowClickHouseHealthy) {
    return res.status(503).json({ ok: false, reason: 'workflow_clickhouse_not_healthy' });
  }
  return res.json({ ok: true });
});

// ─── Restate health check ────────────────────────────────────────
const RESTATE_HEALTH_CHECK_TIMEOUT_MS = 3_000;
const RESTATE_HEALTH_CHECK_INTERVAL_MS = 10_000;
let healthCheckTimer: NodeJS.Timeout | undefined;

/**
 * Ping Restate admin's `/health` endpoint and flip `isRestateHealthy`.
 * The readiness probe gates on this flag instead of `isRestateRegistered`
 * to avoid the registration-readiness deadlock: Restate's discovery
 * callback needs to reach the pod through the K8s Service, which requires
 * the pod to be ready first.
 */
async function checkRestateHealth(): Promise<boolean> {
  try {
    const response = await fetch(`${RESTATE_ADMIN_URL}/health`, {
      headers: restateAuthHeader(),
      signal: AbortSignal.timeout(RESTATE_HEALTH_CHECK_TIMEOUT_MS),
    });
    isRestateHealthy = response.ok;
    return response.ok;
  } catch {
    isRestateHealthy = false;
    return false;
  }
}

/**
 * Start a periodic Restate health check that keeps `isRestateHealthy`
 * up-to-date. The readiness probe reflects the latest result, so the
 * pod drops out of the K8s Service if Restate becomes unreachable.
 */
function startRestateHealthCheck(): void {
  // Run immediately so the first readiness probe after startup has data.
  void checkRestateHealth();

  healthCheckTimer = setInterval(() => {
    if (isShuttingDown) return;
    void checkRestateHealth();
  }, RESTATE_HEALTH_CHECK_INTERVAL_MS);
  healthCheckTimer.unref();
}

// ─── Workflow event-sourcing pipeline health check (ABLP-2) ───────────────
const WORKFLOW_PIPELINE_HEALTH_INTERVAL_MS = 10_000;
const WORKFLOW_PIPELINE_PING_TIMEOUT_MS = 3_000;

/**
 * Poll the dependencies the workflow event-sourcing pipeline needs and flip
 * the module-level readiness flags. Each check is flag-gated so dev/test
 * environments without Redis or ClickHouse stay ready by default.
 *
 * `WORKFLOW_OUTBOX_ENABLED=true` ⇒ BullMQ poller needs Redis. Without a
 * reachable Redis, the poller can't lease jobs and the outbox will back up.
 *
 * `WORKFLOW_DUAL_READ_ENABLED=true` ⇒ the hybrid reader queries ClickHouse
 * on the read path. Routing traffic to a pod that can't reach CH would make
 * list/read endpoints 500 instead of falling back cleanly.
 */
async function checkWorkflowPipelineHealth(): Promise<void> {
  if (process.env.WORKFLOW_OUTBOX_ENABLED === 'true') {
    isWorkflowRedisHealthy = await pingRedis(WORKFLOW_PIPELINE_PING_TIMEOUT_MS);
  } else {
    isWorkflowRedisHealthy = true;
  }

  if (process.env.WORKFLOW_DUAL_READ_ENABLED === 'true') {
    try {
      const { getClickHouseClient } = await import('@agent-platform/database/clickhouse');
      const client = getClickHouseClient();
      const result = await Promise.race<{ success: boolean } | undefined>([
        client.ping() as Promise<{ success: boolean }>,
        new Promise<undefined>((resolve) =>
          setTimeout(() => resolve(undefined), WORKFLOW_PIPELINE_PING_TIMEOUT_MS),
        ),
      ]);
      isWorkflowClickHouseHealthy = result?.success === true;
    } catch (err) {
      log.warn('workflow.pipeline.clickhouse_probe_failed', {
        error: err instanceof Error ? err.message : String(err),
      });
      isWorkflowClickHouseHealthy = false;
    }
  } else {
    isWorkflowClickHouseHealthy = true;
  }
}

function startWorkflowPipelineHealthCheck(): void {
  // Run immediately so the first readiness probe after the flip has data.
  void checkWorkflowPipelineHealth();

  workflowPipelineHealthTimer = setInterval(() => {
    if (isShuttingDown) return;
    void checkWorkflowPipelineHealth();
  }, WORKFLOW_PIPELINE_HEALTH_INTERVAL_MS);
  workflowPipelineHealthTimer.unref();
}

// ─── Restate registration ──────────────────────────────────────
/**
 * Attempt a single registration of this workflow-engine instance with the
 * Restate admin API. Idempotent — safe to call repeatedly. Flips the
 * module-level `isRestateRegistered` flag based on the outcome so the
 * readiness probe can gate traffic accordingly.
 *
 * Registers the Restate endpoint (HTTP/2) URL, not the Express API URL.
 * `force: true` lets Restate pick up code changes on restart and makes
 * repeated calls with the same URL effectively no-ops.
 */
async function tryRegisterWithRestate(): Promise<boolean> {
  const selfUrl = process.env.RESTATE_ENDPOINT_URL || `http://localhost:${RESTATE_ENDPOINT_PORT}`;

  // Fail loudly on obvious misconfiguration — Restate running in a separate
  // pod cannot reach `localhost` in a production cluster. Surfacing this at
  // startup prevents a silent, long-running outage caused by a missing
  // RESTATE_ENDPOINT_URL in Helm values.
  if (process.env.NODE_ENV === 'production' && selfUrl.includes('localhost')) {
    log.error('RESTATE_ENDPOINT_URL must be a cluster-reachable URL in production', {
      selfUrl,
    });
    isRestateRegistered = false;
    return false;
  }

  try {
    const response = await fetch(`${RESTATE_ADMIN_URL}/deployments`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...restateAuthHeader() },
      body: JSON.stringify({ uri: selfUrl, force: true }),
      signal: AbortSignal.timeout(RESTATE_REGISTRATION_TIMEOUT_MS),
    });
    if (response.ok) {
      const wasRegistered = isRestateRegistered;
      isRestateRegistered = true;
      if (!wasRegistered) {
        log.info('Registered with Restate', { adminUrl: RESTATE_ADMIN_URL, selfUrl });
      }
      // Phase 7: inactivity_timeout PATCH removed.
      // The relay-race execution model (workflow-executor restate.object) replaces
      // the legacy workflow.run handler for all new executions. Relay runs are short,
      // exclusive handlers that run to completion and return — they never suspend, so
      // the Restate 1.6.2 re-dispatch bug has no surface area.
      // Legacy executions (RELAY_RACE_DISABLED=true) still use the old workflow.run
      // path; if re-dispatch is needed for those, set
      // RESTATE_WORKFLOW_RUNNER_INACTIVITY_TIMEOUT and restore this block.
      return true;
    }
    const body = await response.text();
    log.error('Restate registration rejected', {
      adminUrl: RESTATE_ADMIN_URL,
      status: response.status,
      statusText: response.statusText,
      body,
    });
  } catch (err) {
    log.error('Could not reach Restate admin', {
      adminUrl: RESTATE_ADMIN_URL,
      error: err instanceof Error ? err.message : String(err),
    });
  }
  isRestateRegistered = false;
  return false;
}

/**
 * Initial registration loop with bounded exponential backoff, followed by a
 * periodic reconciler that self-heals if Restate loses state.
 *
 * The readiness probe gates on Restate *health* (not registration), so the
 * pod is routable during the registration loop — Restate's discovery callback
 * can reach it. Registration still retries until it succeeds.
 */
async function startRegistrationLoop(): Promise<void> {
  let delay = RESTATE_BACKOFF_INITIAL_MS;
  while (!isShuttingDown) {
    if (await tryRegisterWithRestate()) break;
    await new Promise<void>((resolve) => {
      setTimeout(resolve, delay).unref();
    });
    delay = Math.min(delay * 2, RESTATE_BACKOFF_MAX_MS);
  }

  if (isShuttingDown) return;

  // Periodic reconciliation — re-asserts the deployment so that Restate state
  // loss (pod restart with ephemeral storage, admin reset) is picked up
  // automatically without a workflow-engine restart.
  reconcileTimer = setInterval(() => {
    if (isShuttingDown) return;
    void tryRegisterWithRestate();
  }, RESTATE_RECONCILE_INTERVAL_MS);
  reconcileTimer.unref();
}

// ─── Graceful shutdown ─────────────────────────────────────────
let server: ReturnType<typeof app.listen>;

async function shutdown(): Promise<void> {
  if (isShuttingDown) return;
  isShuttingDown = true;
  log.info('Shutting down gracefully...');

  const forceTimer = setTimeout(() => {
    log.error('Forced shutdown after timeout');
    process.exit(1);
  }, SHUTDOWN_TIMEOUT_MS).unref();

  // 1. Stop accepting new HTTP connections
  if (server) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    log.info('HTTP server closed');
  }

  // Stop the Restate re-registration reconciler and health check so they
  // don't race with teardown or keep scheduling work during graceful shutdown.
  if (reconcileTimer) {
    clearInterval(reconcileTimer);
    reconcileTimer = undefined;
  }
  if (healthCheckTimer) {
    clearInterval(healthCheckTimer);
    healthCheckTimer = undefined;
  }
  if (workflowPipelineHealthTimer) {
    clearInterval(workflowPipelineHealthTimer);
    workflowPipelineHealthTimer = undefined;
  }

  // 2. Shut down trigger scheduler, polling worker, callback delivery worker,
  //    and workflow outbox poller (BullMQ workers)
  if (activeTriggerScheduler) {
    await activeTriggerScheduler.shutdown();
  }
  if (activePollingWorker) {
    await activePollingWorker.close();
  }
  if (activeCallbackDeliveryWorker) {
    await activeCallbackDeliveryWorker.shutdown();
  }
  if (activeAdiPollWorker) {
    await activeAdiPollWorker.close();
  }
  if (activeStuckExecutionSweeper) {
    activeStuckExecutionSweeper.stop();
  }
  if (activeHumanStepTimeoutEnforcer) {
    activeHumanStepTimeoutEnforcer.stop();
  }
  if (activeOutboxPoller) {
    await activeOutboxPoller.shutdown();
  }

  // 3. Disconnect Redis
  await disconnectRedis();

  // 3. Disconnect MongoDB
  await disconnectDatabase();

  // 4. In-flight Restate invocations complete on their own (Restate manages retries).
  // TODO(lifecycle): Restate SDK's endpoint.listen() returns a port number, not a
  // server handle. To close the HTTP/2 server on shutdown, switch to
  // endpoint.http2Handler() with a manually-managed http2.createSecureServer().
  log.info('In-flight Restate invocations will complete independently');

  // 5. TODO(security): Zero-fill encryption key material once EncryptionService
  // exposes a cleanup/destroy method for secure key disposal on shutdown

  clearTimeout(forceTimer);
  log.info('Shutdown complete');
  process.exit(0);
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

// ─── Async startup ───────────────────────────────────────────
async function start(): Promise<void> {
  // 1. Initialize MongoDB (must happen before any model access)
  await initDatabase();

  // 2. Initialize Redis (best-effort — logs warning if unavailable)
  await initRedis();

  const registry = new ConnectorRegistry();

  // Load all available connectors (native HTTP + installed Activepieces pieces)
  await loadConnectors(registry);

  // `registerFn` lets the client self-heal on a 404 "service not found" by
  // re-asserting the workflow-engine deployment before retrying the invocation
  // once — closing the small gap between Restate state loss and the next
  // periodic reconciliation tick.
  const restateClient = new RestateWorkflowClient({ registerFn: tryRegisterWithRestate });

  // F-4 fix: RESTATE_INGRESS_AUTH_TOKEN is mandatory in production.
  // Without it, any cluster peer can POST to the Restate ingress and invoke
  // runWorkflow() / cancelWorkflow() on workflow-executor with a forged WorkflowRunInput.
  // MongoDB tenant isolation provides defense-in-depth (getExecutionForLeg
  // returns null on tenant mismatch), but the transport must also be secured.
  // Allow opt-out via RESTATE_INGRESS_AUTH_OPTIONAL=true only for staging
  // environments that intentionally run without a sidecar.
  if (process.env.NODE_ENV === 'production' && !process.env.RESTATE_INGRESS_AUTH_TOKEN) {
    if (process.env.RESTATE_INGRESS_AUTH_OPTIONAL === 'true') {
      log.warn(
        'RESTATE_INGRESS_AUTH_TOKEN is not set (RESTATE_INGRESS_AUTH_OPTIONAL=true bypasses enforcement). ' +
          'workflow-executor runWorkflow/cancelWorkflow are accessible without bearer auth. ' +
          'Only permitted in staging environments — never in production.',
      );
    } else {
      log.error(
        'RESTATE_INGRESS_AUTH_TOKEN is required in production. ' +
          'The workflow-executor Restate object (relay-race execution path) is accessible ' +
          'via the Restate ingress without a bearer token, allowing any cluster peer to forge ' +
          'WorkflowRunInput payloads. Set RESTATE_INGRESS_AUTH_TOKEN and configure the Restate auth sidecar. ' +
          'To bypass this check in staging: set RESTATE_INGRESS_AUTH_OPTIONAL=true.',
      );
      process.exit(1);
    }
  }

  // Encryption helper callbacks for routes
  const encryptSecret = async (plaintext: string, tenantId: string): Promise<string> => {
    return encryptForTenantAuto(plaintext, tenantId, '_tenant', '_tenant');
  };

  const decryptSecret = async (ciphertext: string, tenantId: string): Promise<string> => {
    return decryptForTenantAuto(ciphertext, tenantId);
  };

  const tenantEncryption = {
    encryptForTenant: (plaintext: string, tenantId: string) =>
      encryptForTenantAuto(plaintext, tenantId),
    decryptForTenant: (ciphertext: string, tenantId: string) =>
      decryptForTenantAuto(ciphertext, tenantId),
  };

  // Publisher adapter: the execution route expects a generic publish(channel, message) interface
  const publisherAdapter = {
    publish: async (channel: string, message: string): Promise<void> => {
      const client = getRedisClient();
      if (client) {
        try {
          await client.publish(channel, message);
        } catch (err) {
          log.warn('Failed to publish Redis event', {
            channel,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    },
  };

  // 3b. Persistence and publishing for Restate workflow handler
  const rawExecutionStore = new ExecutionStore(WorkflowExecution as any, encryptSecret);
  let executionStore:
    | ExecutionStore
    | InstanceType<
        typeof import('./outbox/execution-persistence-with-outbox.js').ExecutionPersistenceWithOutbox
      > = rawExecutionStore;

  // ─── Step dispatcher dependencies ──────────────────────────────
  const RUNTIME_URL = process.env.RUNTIME_URL || 'http://localhost:3112';
  const PUBLIC_URL = process.env.WORKFLOW_ENGINE_PUBLIC_URL || `http://localhost:${PORT}`;
  const RUNTIME_JWT_SECRET = process.env.JWT_SECRET;
  if (!RUNTIME_JWT_SECRET) {
    throw new Error(
      'JWT_SECRET is required — workflow-engine mints service tokens to call the runtime chat/tool APIs',
    );
  }

  // Mint a short-lived service-to-service JWT for internal runtime calls.
  // tenantId and projectId come from the verified token on the runtime side —
  // never from raw headers.
  const mintServiceToken = (tenantId: string, projectId: string): string => {
    const secret = process.env.JWT_SECRET;
    if (!secret) throw new Error('JWT_SECRET environment variable is required');
    return createServiceToken(secret, {
      tenantId,
      projectId,
      serviceName: 'workflow-engine',
    });
  };

  // Envelope returned by runtime internal routes: { success, data?, error? }
  interface RuntimeEnvelope<T> {
    success: boolean;
    data?: T;
    error?: { code: string; message: string };
  }

  // RuntimeClient — sends messages to agents via runtime /api/internal/chat/agent
  // System agents (system/*) route through Runtime as normal agent invocations;
  // Runtime owns the in-process Arch driver and durable session boundary.
  const runtimeClient: RuntimeClient = {
    async sendMessage(input) {
      const token = mintServiceToken(input.tenantId, input.projectId);
      const response = await fetch(`${RUNTIME_URL}/api/internal/chat/agent`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          agentId: input.agentId,
          sessionId: input.sessionId,
          message: input.message,
          projectId: input.projectId,
          callerContext: input.callerContext,
        }),
        signal: AbortSignal.timeout(input.timeout ?? 120_000),
      });
      let envelope: RuntimeEnvelope<AgentInvocationResult> | null = null;
      try {
        envelope = (await response.json()) as RuntimeEnvelope<AgentInvocationResult>;
      } catch (parseErr) {
        log.warn('Failed to parse runtime chat response body', {
          status: response.status,
          error: parseErr instanceof Error ? parseErr.message : String(parseErr),
        });
      }
      if (!response.ok || !envelope?.success || !envelope?.data) {
        let msg: string;
        if (envelope?.error?.message) {
          msg = envelope.error.message;
        } else if (envelope !== null) {
          msg = envelope.error?.code
            ? `Runtime chat API reported failure (${envelope.error.code})`
            : 'Runtime chat API reported failure with no detail';
        } else {
          msg = `Runtime chat API returned ${response.status}: ${response.statusText}`;
        }
        throw new Error(msg);
      }
      // Runtime's chat envelope carries internal session state plus the raw
      // SDK `response` blob. Workflow-engine only consumes the agent message
      // (`agentResponse` + `sessionId`), so strip these here — they bloat the
      // step output that gets persisted to MongoDB and rendered in the
      // Studio debug panel, and `state` may include sensitive session data.
      const {
        state: _state,
        response: _response,
        ...cleanData
      } = envelope.data as unknown as Record<string, unknown>;
      void _state;
      void _response;
      return cleanData as unknown as AgentInvocationResult;
    },
  };

  // ToolExecutionClient — executes registered tools via runtime internal API
  //
  // NOTE (F-7 / ABLP-535): This path dispatches tool params WITHOUT PII vault
  // rendering. The workflow engine does not have access to the session's
  // PIIVault (it runs as a separate Restate service). Tool params may contain
  // PII in plaintext. Full PII rendering for workflow-dispatched tool calls is
  // tracked as a future work item. Meanwhile, the lightweight scanner below
  // emits a structured log warning when PII patterns are detected in tool
  // params so that compliance dashboards can flag unprotected dispatches.
  //
  // DFA-L1: Logger-backed trace event sink routes events into structured
  // logging until the workflow engine wires a real TraceStore.
  const workflowTraceEventSink = createLoggerTraceEventSink();

  const toolClient: ToolExecutionClient = {
    async executeTool(input) {
      // F-7 + DFA-M2 + DFA-L1: PII presence scan extracted to scanToolParamsForPII
      // for testability. Emits workflow_unprotected_pii_dispatched as a structured
      // trace event (DFA-L1) alongside the log.warn. Best-effort, never blocks.
      scanToolParamsForPII(
        {
          toolName: input.toolName,
          params: input.params,
          tenantId: input.tenantId,
          projectId: input.projectId,
        },
        workflowTraceEventSink,
      );

      const token = mintServiceToken(input.tenantId, input.projectId);
      const response = await fetch(`${RUNTIME_URL}/api/internal/tools/execute`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          toolName: input.toolName,
          params: input.params,
          projectId: input.projectId,
          ...(input.actorUserId ? { actorUserId: input.actorUserId } : {}),
          ...(input.executionMode ? { executionMode: input.executionMode } : {}),
          ...(input.callback ? { callback: input.callback } : {}),
          ...(input.callbackConfig ? { callbackConfig: input.callbackConfig } : {}),
          ...(input.asyncHttpSuccess ? { asyncHttpSuccess: input.asyncHttpSuccess } : {}),
        }),
        signal: AbortSignal.timeout(input.timeout ?? 30_000),
      });
      let envelope: {
        success: boolean;
        data?: ToolCallResult;
        error?: { code?: string; message?: string };
      } | null = null;
      try {
        envelope = (await response.json()) as {
          success: boolean;
          data?: ToolCallResult;
          error?: { code?: string; message?: string };
        };
      } catch (parseErr) {
        log.warn('Failed to parse tool execution response body', {
          status: response.status,
          error: parseErr instanceof Error ? parseErr.message : String(parseErr),
        });
      }
      if (!response.ok || !envelope?.success || !envelope?.data) {
        let msg: string;
        if (envelope?.error?.message) {
          msg = envelope.error.message;
        } else if (envelope !== null) {
          msg = envelope.error?.code
            ? `Tool execution API reported failure (${envelope.error.code})`
            : 'Tool execution API reported failure with no detail';
        } else {
          msg = `Tool execution API returned ${response.status}: ${response.statusText}`;
        }
        throw new Error(msg);
      }
      return envelope.data;
    },
  };

  // CallbackUrlBuilder — constructs callback URLs for async webhook steps.
  // When tenantId is provided the URL uses the tenant-scoped path prefix /t/:tenantId
  // so the callback route can do a tenant-isolated MongoDB findOne (SEC-1).
  // Legacy callers that omit tenantId keep the unscoped /…/callbacks/:executionId/:stepId
  // path for backward compatibility with in-flight jobs.
  const callbackUrlBuilder: CallbackUrlBuilder = {
    buildCallbackUrl: (executionId: string, stepId: string, tenantId?: string) =>
      tenantId
        ? `${PUBLIC_URL}/api/v1/workflows/callbacks/t/${tenantId}/${executionId}/${stepId}`
        : `${PUBLIC_URL}/api/v1/workflows/callbacks/${executionId}/${stepId}`,
  };

  // ConnectorDeps factory — creates per-execution connector deps with tenant/project context
  // Auth profile resolver: shared factory with projectId scope validation
  const { createAuthProfileResolver } = await import('@agent-platform/connectors/services');
  const { AuthProfile } = await import('@agent-platform/database/models');
  const authProfileResolver = createAuthProfileResolver({
    authProfileModel: AuthProfile as any,
    decrypt: (ciphertext, tenantId) => decryptForTenantAuto(ciphertext, tenantId),
  });

  // OAuth grant resolver: extracted to services/oauth-grant-resolver.ts for testability
  const { EndUserOAuthToken } = await import('@agent-platform/database/models');
  const { createOAuthGrantResolver } = await import('./services/oauth-grant-resolver.js');
  const oauthGrantResolver = createOAuthGrantResolver({
    tokenModel:
      EndUserOAuthToken as unknown as import('./services/oauth-grant-resolver.js').OAuthTokenModel,
    authProfileModel:
      AuthProfile as unknown as import('./services/oauth-grant-resolver.js').AuthProfileModel,
    encryption: {
      encrypt: (plaintext, tenantId) => encryptForTenantAuto(plaintext, tenantId),
      decrypt: (ciphertext, tenantId) => decryptForTenantAuto(ciphertext, tenantId),
    },
    redis: (getRedisClient() ?? undefined) as
      | import('./services/oauth-grant-resolver.js').RedisLike
      | undefined,
  });

  const connectionResolver = new ConnectionResolver(
    ConnectorConnection as unknown as import('@agent-platform/connectors/auth').ConnectorConnectionModel,
    authProfileResolver,
    oauthGrantResolver,
    // ABLP-913 fallback: workflow IR `connectionId` may carry an auth-profile id.
    AuthProfile as unknown as import('@agent-platform/connectors/auth').AuthProfileLookupModel,
  );

  // Tenant-bound writer factory used by both the polling worker (triggers)
  // and the connector-tool executor (actions). Both paths produce signed
  // attachment URLs backed by the shared storage layer (NFS in cluster,
  // local FS in dev, S3 when STORAGE_PROVIDER=s3).
  const attachmentStorage = createFileStorage(getStorageConfig());

  // Periodic sweep: deletes attachments older than ATTACHMENT_FILE_MAX_AGE_MS
  if (getStorageConfig().provider === 'local') {
    startAttachmentCleanup(attachmentStorage.basePath, getRedisClient());
  }

  const fileWriterFactory = createFileWriterFactory(
    attachmentStorage,
    signAttachmentToken,
    PUBLIC_URL,
  );

  // Lazy-construct the workflow-docling-extraction BullMQ queue handle used by
  // the Docling connector's `enqueueWorkflowDoclingJob`. Constructed once per
  // process; gated on the feature flag so flag-off deployments don't open a
  // Redis subscription. When Redis is unavailable (dev without docker-compose),
  // the connector's `INTEGRATION_UNAVAILABLE` error surfaces cleanly.
  const workflowDoclingHandle = getRedisHandle();
  const workflowDoclingQueue =
    process.env.WORKFLOW_DOC_EXTRACTION_INTEGRATIONS_ENABLED === 'true' && workflowDoclingHandle
      ? new Queue('workflow-docling-extraction', {
          connection: workflowDoclingHandle.duplicate({ maxRetriesPerRequest: null }),
          prefix: BULLMQ_CLUSTER_SAFE_PREFIX,
        })
      : null;

  // ADI poll worker + queue — replaces the inline Azure DI polling loop so the
  // Restate handler parks on an awakeable immediately (zero blocking). Always
  // constructed when Redis is available; gated on the same feature flag as the
  // Docling queue so flag-off deployments skip it.
  const { createAdiPollWorker } = await import('./services/adi-poll-worker.js');
  const adiPollRedisHandle = getRedisHandle();
  const adiPollWorkerInstance =
    process.env.WORKFLOW_DOC_EXTRACTION_INTEGRATIONS_ENABLED === 'true' && adiPollRedisHandle
      ? createAdiPollWorker({ redisHandle: adiPollRedisHandle })
      : null;
  if (adiPollWorkerInstance) {
    activeAdiPollWorker = adiPollWorkerInstance;
  }

  // Stuck-execution sweeper (P-6/P-7) — periodically marks relay-race executions
  // that have been `running` past STUCK_EXECUTION_MAX_AGE_MS as `failed`.
  // Redis lock prevents multi-pod double-failure.
  activeStuckExecutionSweeper = startStuckExecutionSweeper(
    WorkflowExecution as unknown as import('./services/stuck-execution-sweeper.js').StuckExecutionSweeperModel,
    getRedisClient(),
  );

  // Human-step timeout enforcer — fires raceTimeout equivalent for relay-race
  // approval / human-task steps whose dueAt has elapsed. Queries HumanTask
  // inbox records with status:pending and dueAt < now, resolves them per
  // onTimeout config (terminate → rejected, skip → continue on success path).
  const { HumanTask } = await import('@agent-platform/database/models');
  activeHumanStepTimeoutEnforcer = startHumanStepTimeoutEnforcer({
    humanTaskModel:
      HumanTask as unknown as import('./services/human-step-timeout-enforcer.js').HumanStepTimeoutEnforcerDeps['humanTaskModel'],
    executionModel: WorkflowExecution as any,
    persistence: rawExecutionStore,
    restateClient,
    redis: getRedisClient(),
  });

  // Process-level singleton kvStore for connector actions running inside a
  // workflow step (LLD §3 Phase 3 Task 3.1). When Redis is available the store
  // is backed by Redis (TTL-bearing, durable across replays); otherwise the
  // executor falls back to its built-in NOOP store and replay-unsafe actions
  // re-run from scratch. `RedisKvStore` is stateless beyond the prefix, so one
  // instance handles all tenants.
  const { RedisKvStore } = await import('./services/redis-kv-store.js');
  const sharedRedisClient = getRedisClient();
  const connectorKvStore: import('@agent-platform/connectors').KeyValueStore | undefined =
    sharedRedisClient ? new RedisKvStore(sharedRedisClient, 'connector-kv:') : undefined;

  // Process-level circuit-breaker registry (LLD §3 Phase 3 D-13). The Azure DI
  // piece wraps each outbound call in `breaker.execute(fn)`; the Redis-backed
  // registry coordinates state atomically across pods via Lua scripts.
  // Falls back to undefined when Redis isn't available — the connector deps
  // factory then refuses to construct the Azure DI services bag and the piece
  // hard-fails with `INTEGRATION_UNAVAILABLE`.
  let breakerRegistry: import('@agent-platform/circuit-breaker').CircuitBreakerRegistry | undefined;
  if (sharedRedisClient) {
    const cb = await import('@agent-platform/circuit-breaker');
    breakerRegistry = new cb.CircuitBreakerRegistry(sharedRedisClient);
    // Wire the Azure DI breaker state observer (HLD §4.2 — `azure_di_circuit_breaker_state` gauge).
    // The listener fires on `state_change` events as well as per-call results; we map the
    // post-event state onto the gauge keyed by tenant. Tenant keys take the form
    // `<tenantId>:azure-di` (matches `RedisCircuitBreaker.toolService`).
    const { recordAzureDIBreakerState } = await import('./observability/extraction-metrics.js');
    breakerRegistry.onEvent((event) => {
      // Only `tool_service` events from the Azure DI key are relevant.
      if (event.level !== 'tool_service') return;
      if (!event.key.endsWith(':azure-di')) return;
      const tenant = event.key.slice(0, -':azure-di'.length);
      // `BreakerStateChangeEvent` carries `to`; `BreakerExecutionEvent` carries `state`.
      const nextState = 'to' in event ? event.to : event.state;
      recordAzureDIBreakerState(tenant, nextState);
    });
  }

  // Lazy Azure DI usage counter — constructed per (tenantId, projectId) by the
  // deps factory. Each invocation is cheap; the heavy state lives in
  // ConnectorConnection docs.
  const { AzureDIUsageCounter } = await import('./services/azure-di-usage-counter.js');

  /**
   * Build the `CallbackContext` passed to native connector actions invoked
   * inside a workflow step. Function-references over local closures keep
   * the connector layer decoupled from the engine's wiring details.
   */
  function buildCallbackContext(
    workflowExecutionId: string,
    stepId: string,
    tenantId?: string,
  ): import('@agent-platform/connectors').CallbackContext {
    return {
      callbackId: `${workflowExecutionId}:${stepId}`,
      callbackUrlBuilder: (eId, sId) => callbackUrlBuilder.buildCallbackUrl(eId, sId, tenantId),
      encryptSecret: (plaintext, tenantId) => encryptSecret(plaintext, tenantId),
      // P-12: only wire enqueueWorkflowDoclingJob when the feature flag is on AND
      // the queue handle is available. When the flag is off and a step references
      // Docling, the connector will receive no enqueueWorkflowDoclingJob and throw
      // a clear INTEGRATION_UNAVAILABLE error instead of a cryptic null crash.
      ...(workflowDoclingQueue &&
      process.env.WORKFLOW_DOC_EXTRACTION_INTEGRATIONS_ENABLED === 'true'
        ? {
            enqueueWorkflowDoclingJob: async (payload) => {
              // Encrypt `callbackSecret` at-rest in Redis via the platform's
              // field-encryption manifest (see `workflow-docling-extraction`
              // entry in `REDIS_QUEUE_ENCRYPTION_MANIFEST`). The worker calls
              // `unwrapJobDataForDecrypt` symmetrically at dequeue time.
              const encryptedPayload = (await wrapJobDataForEncrypt(
                'workflow-docling-extraction',
                payload as unknown as Record<string, unknown>,
                tenantEncryption,
              )) as unknown as typeof payload;
              // S-5: 3 attempts so a transient worker crash doesn't permanently
              // hang the workflow step at waiting_callback until awakeable timeout.
              const job = await workflowDoclingQueue.add('extraction', encryptedPayload, {
                attempts: 3,
              });
              return { jobId: String(job.id ?? '') };
            },
          }
        : {}),
      ...(adiPollWorkerInstance
        ? {
            enqueueADIPollJob: async (payload) => {
              const encryptedPayload = (await wrapJobDataForEncrypt(
                'workflow-adi-poll',
                payload as unknown as Record<string, unknown>,
                tenantEncryption,
              )) as unknown as typeof payload;
              const job = await adiPollWorkerInstance.queue.add('poll', encryptedPayload, {
                attempts: 1,
              });
              return { jobId: String(job.id ?? '') };
            },
          }
        : {}),
      getSharedRedisClient: () => getRedisClient() ?? null,
    };
  }

  const connectorDepsFactory = connectionResolver
    ? (
        tenantId: string,
        projectId: string,
        workflowExecutionId?: string,
        stepId?: string,
        callbackContext?: import('@agent-platform/connectors').CallbackContext,
      ): ConnectorActionDeps => {
        const effectiveCallbackContext =
          callbackContext ??
          (workflowExecutionId && stepId
            ? buildCallbackContext(workflowExecutionId, stepId, tenantId)
            : undefined);
        // Azure DI services bag — only constructed when Redis + flag are up
        // (the piece itself hard-fails when the bag is absent). Tenant-scoped
        // pre-keyed breaker handle keeps the piece breaker-key-agnostic.
        const azureDocumentIntelligence:
          | import('@agent-platform/connectors').AzureDocumentIntelligenceServices
          | undefined =
          breakerRegistry && process.env.WORKFLOW_DOC_EXTRACTION_INTEGRATIONS_ENABLED === 'true'
            ? {
                checkUsage: (connectionId: string) =>
                  new AzureDIUsageCounter({
                    model: ConnectorConnection as any,
                    tenantId,
                    projectId,
                  }).checkUsage(connectionId),
                recordUsage: (connectionId: string) =>
                  new AzureDIUsageCounter({
                    model: ConnectorConnection as any,
                    tenantId,
                    projectId,
                  }).recordUsage(connectionId),
                breaker: breakerRegistry.toolService(tenantId, 'azure-di'),
              }
            : undefined;
        return {
          connectorToolExecutor: new ConnectorToolExecutor(
            registry,
            connectionResolver,
            {
              tenantId,
              projectId,
              ...(workflowExecutionId ? { workflowExecutionId } : {}),
              ...(stepId ? { stepId } : {}),
              ...(azureDocumentIntelligence ? { azureDocumentIntelligence } : {}),
            },
            connectorKvStore,
            effectiveCallbackContext,
            fileWriterFactory,
          ),
        };
      }
    : undefined;

  // Instantiate HumanTask store for HITL workflow steps
  const humanTaskStoreMod = await import('./persistence/human-task-store.js');
  const { MongoHumanTaskStore } = humanTaskStoreMod;
  type MongoHumanTaskStoreType = InstanceType<typeof MongoHumanTaskStore>;
  const rawHumanTaskStore = new MongoHumanTaskStore();
  let humanTaskStore:
    | MongoHumanTaskStoreType
    | InstanceType<
        typeof import('./outbox/execution-persistence-with-outbox.js').HumanTaskStoreWithOutbox
      > = rawHumanTaskStore;

  // ─── Workflow event-sourcing outbox (LLD §3.2 / Phase 3) ────────────────────
  // When WORKFLOW_OUTBOX_ENABLED=true, decorate execution + human-task stores
  // so each state-machine transition commits an outbox row in the same Mongo
  // transaction as the domain write. Poller (created below) drains those rows
  // into Kafka. Flag off → decorators are no-ops, behavior unchanged.
  const { readFlags } = await import('./outbox/flag-gates.js');
  const flags = readFlags();
  if (flags.outboxEnabled) {
    const { wireOutboxDecorators } = await import('./outbox/execution-persistence-with-outbox.js');
    const wired = wireOutboxDecorators({
      executionStore: rawExecutionStore,
      humanTaskStore: rawHumanTaskStore,
      outboxModel:
        WorkflowEventOutboxModel as unknown as import('./outbox/workflow-event-outbox-writer.js').OutboxModelLike,
      executionReadModel: {
        findOne: async (filter, options) =>
          (WorkflowExecution as any).findOne(filter, options ?? undefined),
      },
    });
    executionStore = wired.executionPersistence as InstanceType<
      typeof import('./outbox/execution-persistence-with-outbox.js').ExecutionPersistenceWithOutbox
    >;
    humanTaskStore = wired.humanTaskStore as InstanceType<
      typeof import('./outbox/execution-persistence-with-outbox.js').HumanTaskStoreWithOutbox
    >;
    log.info('Workflow-event outbox decorators wired', {
      outboxEnabled: true,
      chSinkEnabled: flags.chSinkEnabled,
      dualReadEnabled: flags.dualReadEnabled,
    });

    // BullMQ outbox poller — drains workflow_event_outbox rows into Kafka.
    // Requires Redis; skips start if Redis is unavailable (flag still works
    // for domain+outbox write path, poller can be started in a follow-up
    // deploy once Redis is reachable).
    const pollerHandle = getRedisHandle();
    if (pollerHandle) {
      const kafkaBrokers = (process.env.EVENT_KAFKA_BROKERS ?? 'localhost:9092').split(',');
      const { KafkaEventQueue } = await import('@abl/eventstore/queues');
      const outboxKafkaQueue = new KafkaEventQueue({
        kafka: { brokers: kafkaBrokers, topic: 'abl.workflow.execution' },
      });
      const { OutboxPoller } = await import('./outbox/outbox-poller.js');
      activeOutboxPoller = new OutboxPoller({
        handle: pollerHandle,
        model:
          WorkflowEventOutboxModel as unknown as import('./outbox/outbox-poller.js').OutboxPollModel,
        kafkaQueue: outboxKafkaQueue,
      });
      await activeOutboxPoller.start();
    } else {
      log.warn('WORKFLOW_OUTBOX_ENABLED=true but Redis is unavailable — outbox poller not started');
    }
  }

  // LLD §6.3 — TTL-enablement safety check.
  //
  // If TTL is being turned on, verify the outbox isn't backed up. A stuck
  // outbox means CH hasn't caught up yet, and TTL-deleting Mongo rows
  // before CH knows about them risks data loss. We log a warning rather
  // than hard-fail — the operator decides whether to roll back TTL.
  if (process.env.WORKFLOW_MONGO_TTL_ENABLED === 'true') {
    const threshold = Number.parseInt(process.env.WORKFLOW_OUTBOX_ALERT_THRESHOLD ?? '10000', 10);
    try {
      const unpublishedCount = await WorkflowEventOutboxModel.countDocuments({
        publishedAt: null,
      });
      if (unpublishedCount > threshold) {
        log.warn(
          'WORKFLOW_MONGO_TTL_ENABLED=true but outbox backlog is large — CH may lag Mongo TTL deletions',
          { unpublishedCount, threshold, action: 'Consider disabling TTL until backlog drains' },
        );
      } else {
        log.info('Outbox-backlog check passed for TTL enablement', {
          unpublishedCount,
          threshold,
        });
      }
    } catch (err) {
      log.warn('Outbox-backlog check failed (non-fatal)', {
        error: err instanceof Error ? err.message : String(err),
      });
    }

    // HLD §4 concern #11 (rollback safety) — CRITICAL startup validation.
    //
    // When `WORKFLOW_MONGO_TTL_ENABLED=true`, the `workflow_executions` and
    // `human_tasks` collections MUST have a TTL index with a partial filter
    // of `{ expiresAt: { $type: 'date' } }`. Without this filter the TTL
    // reaper would see every document (including in-flight executions with
    // `expiresAt: null`) as a candidate for deletion. A model edit that
    // accidentally drops the `partialFilterExpression` would silently cause
    // mass deletion of running workflows — the HLD calls this out as the
    // primary safety mechanism and requires a startup check that refuses
    // to continue when the index shape is wrong.
    //
    // We fail loudly (CRITICAL log + process exit) rather than continue
    // with TTL active but unsafe.
    const ttlCollections: Array<{
      label: string;
      model: {
        collection: { listIndexes(): { toArray(): Promise<Array<Record<string, unknown>>> } };
      };
    }> = [
      { label: 'workflow_executions', model: WorkflowExecution as never },
      { label: 'human_tasks', model: HumanTask as never },
    ];
    for (const { label, model } of ttlCollections) {
      try {
        const indexes = await model.collection.listIndexes().toArray();
        const ttlIdx = indexes.find((i) => {
          const key = i.key as Record<string, number> | undefined;
          return key?.expiresAt === 1;
        });
        const partial = ttlIdx?.partialFilterExpression as
          | { expiresAt?: { $type?: string } }
          | undefined;
        const filterShape = partial?.expiresAt?.$type;
        if (!ttlIdx) {
          log.error(
            'CRITICAL: TTL index missing on Mongo collection — refusing to start with TTL enabled',
            {
              collection: label,
              action:
                'Confirm `WORKFLOW_MONGO_TTL_ENABLED=true` was set BEFORE pod start; restart after fix.',
            },
          );
          process.exit(1);
        }
        if (filterShape !== 'date') {
          log.error(
            'CRITICAL: TTL index partial-filter missing or wrong — refusing to start with TTL enabled',
            {
              collection: label,
              indexShape: {
                key: ttlIdx.key,
                expireAfterSeconds: ttlIdx.expireAfterSeconds,
                partialFilterExpression: ttlIdx.partialFilterExpression ?? null,
              },
              expected: "{ expiresAt: { $type: 'date' } }",
              action: 'Drop the index, redeploy with the correct schema, then re-enable TTL.',
            },
          );
          process.exit(1);
        }
        log.info('TTL index shape validated', {
          collection: label,
          expireAfterSeconds: ttlIdx.expireAfterSeconds,
        });
      } catch (err) {
        log.error(
          'CRITICAL: TTL index validation failed to execute — refusing to start with TTL enabled',
          {
            collection: label,
            error: err instanceof Error ? err.message : String(err),
          },
        );
        process.exit(1);
      }
    }
  }

  // Callback delivery worker — delivers webhook callbacks on workflow completion
  const earlyRedisClient = getRedisClient();
  const earlyRedisHandle = getRedisHandle();
  let callbackDeliveryWorker: CallbackDeliveryWorker | undefined;
  if (earlyRedisClient && earlyRedisHandle) {
    callbackDeliveryWorker = new CallbackDeliveryWorker(earlyRedisHandle, {
      webhookSecret: async (tenantId: string, source?: string) => {
        // Internal agent-tool callbacks use a dedicated secret
        if (source === 'agent_tool') {
          const internalSecret = process.env.INTERNAL_CALLBACK_SECRET;
          if (!internalSecret) {
            throw new Error('INTERNAL_CALLBACK_SECRET not configured');
          }
          return internalSecret;
        }
        // Per-tenant callback signing secret — uses env secret with tenant suffix
        const secret = process.env.CALLBACK_HMAC_SECRET || 'default-callback-secret';
        return `${secret}:${tenantId}`;
      },
      // Bearer-token decrypter — the async-push access token lives on the
      // job as ciphertext and is decrypted only inside processJob, one frame
      // above the outbound fetch.
      decryptSecret,
    });
  }
  activeCallbackDeliveryWorker = callbackDeliveryWorker;

  // RuntimeMemoryClient — Phase 4 wiring. The same client instance is used at
  // TWO call sites: (a) the workflow handler calls `loadProjection` at run
  // start; (b) the function-node executor calls `get/set/delete` from inside
  // the V8 isolate. Constructed once here so both code paths share the same
  // JWT secret + base URL configuration.
  const runtimeMemoryClient = new RuntimeMemoryClient({
    baseUrl: RUNTIME_URL,
    serviceTokenSecret: RUNTIME_JWT_SECRET,
  });

  // Extraction audit-event emitter (Phase 4 task 4.7b). Uses the default
  // structured-log sink — downstream log-tailing audit ingest materializes
  // each line into `audit_logs`. Sink is injected, so tests can swap in an
  // array collector via `WorkflowHandlerDeps.extractionAuditEmitter`.
  const { ExtractionAuditEmitter } = await import('./services/extraction-audit-events.js');
  const extractionAuditEmitter = new ExtractionAuditEmitter();

  // Relay-race wrapper for trigger-fired executions.
  // Triggers call startWorkflow(executionId, WorkflowExecutionInput) — this wrapper
  // stores inputSnapshot in MongoDB and dispatches the first relay-race slice via
  // restateClient.startWorkflow(), so trigger-fired executions are also protected
  // from the Restate 1.6.2 re-dispatch bug.
  async function relayStartWorkflow(
    executionId: string,
    input: Record<string, unknown>,
  ): Promise<void> {
    const wfInput = input as unknown as WorkflowExecutionInput;
    const stepRecords = (
      (wfInput.steps ?? []) as Array<{ id: string; type: string; name: string }>
    ).map((s) => ({
      stepId: s.id,
      name: s.name ?? s.id,
      type: s.type,
      status: 'pending' as const,
    }));
    await rawExecutionStore.createExecution({
      executionId,
      tenantId: wfInput.tenantId,
      projectId: wfInput.projectId,
      workflowId: wfInput.workflowId,
      ...(wfInput.workflowVersionId
        ? { workflowVersionId: wfInput.workflowVersionId as string }
        : {}),
      ...(wfInput.workflowVersion ? { workflowVersion: wfInput.workflowVersion as string } : {}),
      status: 'running',
      triggerType: wfInput.triggerType as string,
      triggerPayload: (wfInput.triggerPayload ?? {}) as Record<string, unknown>,
      triggerMetadata: (wfInput.triggerMetadata ?? {}) as Record<string, unknown>,
      steps: [
        { stepId: 'start', name: 'Start', type: 'start', status: 'completed' as const },
        ...stepRecords,
        { stepId: 'end', name: 'End', type: 'end', status: 'pending' as const },
      ],
      ...(wfInput.webhookMode ? { webhookMode: wfInput.webhookMode as 'sync' | 'async' } : {}),
      ...(wfInput.webhookDelivery
        ? { webhookDelivery: wfInput.webhookDelivery as 'poll' | 'push' }
        : {}),
      inputSnapshot: wfInput,
    });
    const inDegreeMap = (wfInput.inDegreeMap ?? {}) as Record<string, number>;
    const allStepIds = ((wfInput.steps ?? []) as Array<{ id: string }>).map((s) => s.id);
    const rootStepIds =
      Object.keys(inDegreeMap).length > 0
        ? Object.entries(inDegreeMap)
            .filter(([, deg]) => deg === 0)
            .map(([id]) => id)
        : allStepIds.slice(0, 1);
    await restateClient.startWorkflow(executionId, {
      tenantId: wfInput.tenantId,
      projectId: wfInput.projectId,
      startFromStepIds: rootStepIds.length > 0 ? rootStepIds : ['start'],
    });
  }

  // Build Restate service endpoint with real dependencies.
  const restateEndpoint = buildRestateEndpoint({
    persistence: executionStore,
    publisher: publisherAdapter,
    dispatcherDeps: {
      runtimeClient,
      toolClient,
      callbackUrlBuilder,
      memoryClient: runtimeMemoryClient,
    },
    connectorDepsFactory,
    humanTaskStore,
    callbackQueue: callbackDeliveryWorker?.queue,
    encryptSecret,
    decryptSecret,
    memoryClient: runtimeMemoryClient,
    extractionAuditEmitter,
    // Relay-race: fan-out parallel branches via startWorkflow() from inside executeWorkflow().
    startWorkflow: restateClient.startWorkflow.bind(restateClient),
  });

  // 3c. Notification dispatcher (uses real class for template resolution and rule matching)
  const notificationDispatcher = new NotificationDispatcher();
  // TODO: Register channel adapters (webhook, slack, email) when implemented
  const notificationDispatcherAdapter = {
    sendTest: async (rule: unknown, tenantId: string) => {
      try {
        const typedRule = rule as WorkflowNotificationRule;
        const syntheticCtx: WorkflowContextData = {
          trigger: { type: 'test', payload: {} },
          workflow: { id: 'test', name: 'Test Notification', executionId: 'test' },
          tenant: { tenantId, projectId: '' },
          steps: {},
        };
        // Pick the first configured event for the test fire. Fall back to
        // a generic workflow.started so a test can still be sent for a rule
        // that has not declared events yet.
        const event = (typedRule.events?.[0] ?? 'workflow.started') as NotificationEvent;
        const results = await notificationDispatcher.dispatch(event, [typedRule], syntheticCtx);
        return { sent: results.length > 0 };
      } catch (err) {
        log.warn('Notification sendTest failed', {
          error: err instanceof Error ? err.message : String(err),
        });
        return { sent: false };
      }
    },
  };

  // 4. Wire routers with real dependencies

  // Callback routes (unauthenticated — uses HMAC secret)
  const callbackRouter = createCallbackRouter({
    executionModel: WorkflowExecution as any,
    restateClient,
    decryptSecret,
    // Relay-race: use rawExecutionStore (base ExecutionStore) which has
    // resolveParkedStep. The outbox-wrapped store delegates relay-race
    // methods through; rawExecutionStore always has them.
    persistence: rawExecutionStore,
  });
  // Callback payloads (ADI envelopes) can reach the ADI inline cap (default
  // 10 MB). Override the global 1 MB limit for this route only so large
  // extraction results are not rejected with HTTP 413 causing infinite retry.
  const ADI_CALLBACK_BODY_LIMIT = process.env.AZURE_DI_WORKFLOW_INLINE_CAP_BYTES
    ? `${Math.ceil(Number(process.env.AZURE_DI_WORKFLOW_INLINE_CAP_BYTES) / (1024 * 1024) + 2)}mb`
    : '12mb';
  app.use(
    '/api/v1/workflows/callbacks',
    createCallbackRateLimit(),
    express.json({ limit: ADI_CALLBACK_BODY_LIMIT, verify: captureRawBody }),
    callbackRouter,
  );

  // Connector webhook receiver (unauthenticated — HMAC via handleWebhook).
  // Mounted here so no auth middleware runs; tenant is resolved from the
  // registration row inside the handler. Requires Redis for dedup; skipped
  // with a warn log when Redis is absent (same posture as the polling worker).
  const webhookRedisClient = getRedisClient();
  if (webhookRedisClient) {
    const connectorWebhookRouter = createConnectorWebhookRouter({
      registry,
      registrationModel: TriggerRegistration as any,
      redis: webhookRedisClient as any,
      restateClient: {
        startWorkflow: relayStartWorkflow,
      } as any,
      decryptSecret,
    });
    app.use('/api/v1/webhooks', connectorWebhookRouter);
  } else {
    log.warn(
      'Connector webhook router not mounted — Redis unavailable. Inbound connector webhooks will 404.',
    );
  }

  // Attachment download — token-gated, no auth middleware, unconditional.
  // Mounted here so Redis unavailability never blocks attachment downloads.
  app.use('/attachments', createAttachmentsRouter(attachmentStorage));

  // Authenticated API routes
  const apiRouter = express.Router();
  apiRouter.use(...authMiddleware);

  // Connectors (catalog routes are read-only, no project scope needed —
  // the dynamic dropdown options endpoint takes projectId in its body).
  const connectorRouter = createConnectorRouter({
    registry,
    connectionResolver,
  });
  // Trigger catalog MUST be registered before /connectors to avoid
  // /:connectorName param capturing "triggers" as a connector name
  const triggerCatalogRouter = createTriggerCatalogRouter({ registry });
  apiRouter.use('/connectors/triggers/catalog', triggerCatalogRouter);

  apiRouter.use('/connectors', connectorRouter);

  // Project-scoped routes
  const projectRouter = express.Router({ mergeParams: true });

  // Workflow executions
  //
  // Hybrid reader wired only when `WORKFLOW_DUAL_READ_ENABLED=true` (LLD §5.2).
  // Flag off ⇒ `hybridReader` stays undefined and the route delegates to the
  // Mongo model — current behaviour, zero behaviour change.
  let executionHybridReader:
    | import('./persistence/hybrid-execution-reader.js').HybridExecutionReader
    | undefined;
  if (flags.dualReadEnabled) {
    try {
      const { getClickHouseClient } = await import('@agent-platform/database/clickhouse');
      const { HybridExecutionReader } = await import('./persistence/hybrid-execution-reader.js');
      const { recordDualReadLatency } = await import('./persistence/hybrid-read-metrics.js');
      executionHybridReader = new HybridExecutionReader({
        mongoModel: WorkflowExecution as any,
        chClient:
          getClickHouseClient() as unknown as import('./persistence/hybrid-execution-reader.js').HybridReaderChClient,
        readFlags: () => ({ dualReadEnabled: true }),
        onLatency: (mode, durationMs) =>
          recordDualReadLatency(durationMs, { entity: 'workflow_execution', mode }),
      });
      log.info('HybridExecutionReader wired (dual-read on)');
    } catch (err) {
      log.warn('HybridExecutionReader failed to wire — falling back to Mongo-only', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const executionRouter = createWorkflowExecutionRouter({
    executionModel: WorkflowExecution as any,
    workflowModel: Workflow as any,
    workflowVersionModel: WorkflowVersion as any,
    restateClient,
    publisher: publisherAdapter,
    humanTaskModel: HumanTask as any,
    encryptSecret,
    hybridReader: executionHybridReader as unknown as
      | import('./routes/workflow-executions.js').HybridReaderAdapter
      | undefined,
    // Relay-race: wire persistence so the execute route can create the
    // execution record + inputSnapshot before startWorkflow() (RELAY_RACE_ENABLED=true).
    persistence: executionStore,
  });
  projectRouter.use('/workflows/:workflowId/executions', executionRouter);

  // Notification rules
  const notificationRouter = createNotificationRuleRouter({
    workflowModel: Workflow as any,
    dispatcher: notificationDispatcherAdapter,
  });
  projectRouter.use('/workflows/:workflowId/notifications', notificationRouter);

  // Approvals
  const approvalRouter = createApprovalRouter({
    executionModel: WorkflowExecution as any,
    restateClient,
    humanTaskStore,
    persistence: rawExecutionStore,
  });
  projectRouter.use('/approvals', approvalRouter);

  // Human task resolution
  const { createHumanTaskResolutionRouter } = await import('./routes/human-task-resolution.js');
  const humanTaskResolutionRouter = createHumanTaskResolutionRouter({
    executionModel: WorkflowExecution as any,
    restateClient,
    humanTaskStore,
    persistence: rawExecutionStore,
  });
  projectRouter.use('/human-tasks', humanTaskResolutionRouter);

  // Connections
  const connectionRouter = createConnectionRouter({
    connectionModel: ConnectorConnection as any,
    registry,
    authProfileResolver: authProfileResolver ?? undefined,
  });
  projectRouter.use('/connections', connectionRouter);

  // Integrations — project-scoped Docling toggle + quota (LLD Phase 2 Task 2.8)
  const { createIntegrationsRouter } = await import('./routes/integrations.js');
  const integrationsRouter = createIntegrationsRouter({
    connectorConnectionModel: ConnectorConnection as any,
  });
  projectRouter.use('/integrations', integrationsRouter);

  // Azure DI usage routes (LLD §3 Phase 3 Task 3.11).
  const { createAzureDIUsageRouter } = await import('./routes/azure-di-usage.js');
  const azureDIUsageRouter = createAzureDIUsageRouter({
    connectorConnectionModel: ConnectorConnection as any,
  });
  projectRouter.use('/integrations', azureDIUsageRouter);

  // Triggers — wire BullMQ scheduler if Redis is available
  const redisClient = getRedisClient();
  const triggerSchedulerHandle = getRedisHandle();
  let triggerScheduler: TriggerScheduler | undefined;
  if (redisClient && triggerSchedulerHandle) {
    triggerScheduler = new TriggerScheduler(triggerSchedulerHandle, {
      triggerModel: TriggerRegistration as any,
      workflowModel: Workflow as any,
      restateClient: { startWorkflow: relayStartWorkflow } as any,
      // Without this, cron jobs with a pinned `workflowVersionId` silently
      // fall back to the working copy at fire time because
      // `TriggerScheduler.processJob` gates version resolution on
      // `deps.workflowVersionModel` being truthy.
      workflowVersionModel: WorkflowVersion as any,
      // Enables the deployment tier of the fire-time version cascade so cron
      // triggers resolve the env-pinned manifest version, matching webhooks.
      deploymentModel: Deployment as any,
    });
  }

  // Store scheduler in module scope for shutdown handler
  activeTriggerScheduler = triggerScheduler;

  // Wire connector trigger engine if Redis is available (handles connector-native triggers)
  let connectorTriggerEngine: InstanceType<typeof ConnectorTriggerEngine> | undefined;
  const redisHandle = getRedisHandle();
  if (redisClient && redisHandle) {
    // Polling queue has both Queue and Worker — use a connection pair.
    // Cron queue is Queue-only (no Worker in this process), so a single
    // duplicated connection is sufficient.
    const pollingPair = createBullMQPair(redisHandle);
    const pollingQueue = new Queue('connector-polling', {
      connection: pollingPair.queueConnection,
      prefix: BULLMQ_CLUSTER_SAFE_PREFIX,
    }) as any;
    const cronQueue = new Queue('connector-cron', {
      connection: redisHandle.duplicate({ maxRetriesPerRequest: null }),
      prefix: BULLMQ_CLUSTER_SAFE_PREFIX,
    }) as any;
    const storeFactory = (connectionId: string) => ({
      get: async <T>(key: string): Promise<T | undefined> => {
        const val = await redisClient.get(`conn:${connectionId}:${key}`);
        return val ? (JSON.parse(val) as T) : undefined;
      },
      set: async (key: string, value: unknown, ttlMs?: number): Promise<void> => {
        if (ttlMs) {
          await redisClient.set(`conn:${connectionId}:${key}`, JSON.stringify(value), 'PX', ttlMs);
        } else {
          await redisClient.set(`conn:${connectionId}:${key}`, JSON.stringify(value));
        }
      },
      delete: async (key: string): Promise<void> => {
        await redisClient.del(`conn:${connectionId}:${key}`);
      },
    });

    connectorTriggerEngine = new ConnectorTriggerEngine({
      registry,
      registrationModel: TriggerRegistration as any,
      restateClient: { startWorkflow: relayStartWorkflow } as any,
      redis: redisClient as any,
      pollingQueue,
      cronQueue,
      decryptSecret: (encryptedSecret: string, tenantId: string) =>
        decryptSecret(encryptedSecret, tenantId),
      storeFactory,
      webhookBaseUrl: PUBLIC_URL,
      authResolver: {
        async resolveConnectionAuth(opts) {
          const { connection } = await connectionResolver.resolve({
            connectorName: '',
            tenantId: opts.tenantId,
            projectId: opts.projectId,
            connectionId: opts.connectionId,
          });
          return connectionResolver.resolveAuth(connection);
        },
      },
      encryptSample: (plaintext, tenantId) => encryptForTenantAuto(plaintext, tenantId),
    });

    // ── Inbound webhook route (unauthenticated — signature-verified) ──────
    // Must be mounted OUTSIDE the project router (no JWT, providers don't
    // hold tokens). Raw body is captured globally via `captureRawBody`.
    const webhookRouter = createWebhookRouter({
      webhookDeps: {
        registry,
        registrationModel: TriggerRegistration as any,
        redis: redisClient as any,
        restateClient: {
          startWorkflow: relayStartWorkflow,
        } as any,
        decryptSecret: (encryptedSecret: string, tenantId: string) =>
          decryptSecret(encryptedSecret, tenantId),
        workflowResolver: {
          async resolve(opts) {
            const wf = await Workflow.findOne({
              _id: opts.workflowId,
              tenantId: opts.tenantId,
              projectId: opts.projectId,
            })
              .lean()
              .select('name steps');
            if (!wf) return null;
            return {
              workflowName: (wf as Record<string, unknown>).name as string,
              steps: ((wf as Record<string, unknown>).steps as unknown[]) ?? [],
            };
          },
        },
      },
    });
    app.use('/api/v1/webhooks/connector', webhookRouter);

    // BullMQ Worker for connector-polling — processes repeatable poll jobs
    const pollingWorker = new Worker(
      'connector-polling',
      async (job) => {
        await processPollingJob(job.data, {
          registry,
          registrationModel: TriggerRegistration as any,
          restateClient: {
            startWorkflow: relayStartWorkflow,
          } as any,
          queue: pollingQueue,
          storeFactory,
          // Bind fileWriter to the job's tenantId so attachment keys are
          // tenant-scoped (matches the search-ai storage key convention).
          fileWriter: fileWriterFactory(job.data.tenantId),
          authResolver: {
            async resolveConnectionAuth(opts) {
              const { connection } = await connectionResolver.resolve({
                connectorName: job.data.connectorName,
                tenantId: opts.tenantId,
                projectId: opts.projectId,
                connectionId: opts.connectionId,
              });
              return connectionResolver.resolveAuth(connection);
            },
          },
          workflowResolver: {
            // Canvas-authored workflows store topology as `nodes`+`edges`, not
            // as a legacy `steps` array. Modern Studio-built workflows always
            // take the canvas path, so the resolver MUST convert via
            // `convertWorkflowDocToSteps` to get executable steps +
            // `outputMappings` + `nameToIdMap`. Without this, Restate started
            // polling-fired executions with empty steps and produced
            // instant-complete no-op runs (symptom: Gmail trigger registered
            // and fired but no real workflow output). Mirrors the equivalent
            // branch in `TriggerScheduler.processJob()` so cron, one-shot,
            // and connector-polling paths agree on the wire shape.
            async resolve(opts) {
              const wf = await Workflow.findOne({
                _id: opts.workflowId,
                tenantId: opts.tenantId,
                projectId: opts.projectId,
              })
                .lean()
                .select('name steps nodes edges');
              if (!wf) return null;
              const doc = wf as Record<string, unknown>;
              const legacySteps = doc.steps as unknown[] | undefined;
              if (legacySteps && Array.isArray(legacySteps) && legacySteps.length > 0) {
                return {
                  workflowName: doc.name as string,
                  steps: legacySteps,
                };
              }
              const conversion = convertWorkflowDocToSteps(doc);
              return {
                workflowName: doc.name as string,
                steps: conversion.steps,
                outputMappings: conversion.outputMappings,
                outputMappingsByEndNodeId: conversion.outputMappingsByEndNodeId,
                nameToIdMap: conversion.nameToIdMap,
              };
            },
          },
        });
      },
      {
        connection: pollingPair.workerConnection,
        prefix: BULLMQ_CLUSTER_SAFE_PREFIX,
        concurrency: POLLING_WORKER_CONCURRENCY,
      },
    );
    activePollingWorker = pollingWorker;

    pollingWorker.on('failed', (job, err) => {
      log.error('Polling job failed', {
        jobId: job?.id,
        registrationId: job?.data?.registrationId,
        error: err instanceof Error ? err.message : String(err),
      });
    });

    log.info('Connector polling worker started with workflow resolution', {
      concurrency: POLLING_WORKER_CONCURRENCY,
    });

    // Boot-time rehydrate of connector-backed polling triggers.
    //
    // BullMQ repeatable-job state lives in Redis — a flush/restart wipes the
    // schedule but leaves the trigger registration document intact. Absent
    // rehydrate, those registrations look active in Studio but never fire.
    // Also heals the backlog left by the 2026-04-14 unified-trigger-types
    // refactor window, when `TriggerEngine.register()` silently skipped
    // connector delegation; commit 33db1df381 fixed new registers, this
    // fixes anything registered before that.
    //
    // Fire-and-forget: don't block workflow-engine startup on this. If
    // MongoDB or the connector engine are temporarily unavailable, boot
    // continues and operators can restart the pod after the backend is
    // back up. Idempotent via BullMQ jobId dedupe, so re-runs are safe.
    rehydrateConnectorTriggers({
      triggerModel: TriggerRegistration as unknown as Parameters<
        typeof rehydrateConnectorTriggers
      >[0]['triggerModel'],
      connectorTriggerEngine: connectorTriggerEngine as unknown as Parameters<
        typeof rehydrateConnectorTriggers
      >[0]['connectorTriggerEngine'],
    }).catch((err) => {
      log.error('Connector trigger rehydrate threw unexpectedly', {
        error: err instanceof Error ? err.message : String(err),
      });
    });
  }

  // Default audit emitter — until the workflow-engine wires a real TraceStore
  // sink, route trigger-lifecycle events through the structured logger so
  // operators have a single grep-able audit trail. Errors are loud (`log.error`)
  // so failed updates are alertable from the log pipeline; successes are
  // `log.info` (sampleable). The shape mirrors the runtime `audit-helpers`
  // structure (`action`, `actor`, `outcome`, `metadata`) so downstream
  // consumers can switch sinks later without re-mapping fields.
  const triggerAuditLog = createLogger('workflow-engine:trigger-audit');
  const emitTriggerAudit = (event: import('./services/trigger-engine.js').TriggerAuditEvent) => {
    const fields: Record<string, unknown> = {
      action: event.action,
      registrationId: event.registrationId,
      tenantId: event.tenantId,
      outcome: event.outcome,
      ...(event.projectId ? { projectId: event.projectId } : {}),
      ...(event.workflowId ? { workflowId: event.workflowId } : {}),
      ...(event.triggerType ? { triggerType: event.triggerType } : {}),
      ...(event.metadata ? { metadata: event.metadata } : {}),
    };
    if (event.outcome === 'error') {
      triggerAuditLog.error(event.action, fields);
    } else {
      triggerAuditLog.info(event.action, fields);
    }
  };
  const triggerEngine = new TriggerEngine({
    triggerModel: TriggerRegistration as any,
    workflowModel: Workflow as any,
    restateClient: { startWorkflow: relayStartWorkflow } as any,
    scheduler: triggerScheduler,
    connectorTriggerEngine,
    deploymentModel: Deployment as any,
    workflowVersionModel: WorkflowVersion as any,
    executionModel: WorkflowExecution as any,
    auditEmitter: emitTriggerAudit,
    decryptSample: (ciphertext, tenantId) => decryptForTenantAuto(ciphertext, tenantId),
  });
  const triggerRouter = createTriggerRouter({ triggerEngine, auditEmitter: emitTriggerAudit });
  projectRouter.use('/triggers', triggerRouter);

  // Per-node integration test (test-action) — design-time only
  const { ActionTestService } = await import('./services/action-test-service.js');
  const { createWorkflowNodeTestsRouter } = await import('./routes/workflow-node-tests.js');
  const actionTestService = new ActionTestService({
    registry,
    connectionResolver,
    workflowModel: Workflow as any,
    encryptField: (plaintext, tenantId) => encryptForTenantAuto(plaintext, tenantId),
    fileWriterFactory,
  });
  projectRouter.use(
    '/workflows',
    createWorkflowNodeTestsRouter({ actionTestService, auditEmitter: emitTriggerAudit }),
  );

  apiRouter.use('/projects/:projectId', projectRouter);
  app.use('/api/v1', apiRouter);

  // ─── Test-diagnostic routes (NODE_ENV=test only, LLD §3.6) ─────
  // Dynamic import so production/dev bundles don't load the module.
  // Fully authenticated via `authMiddleware` (no bypass) and tenant-scoped.
  if (process.env.NODE_ENV === 'test') {
    const { createTestDiagnosticRouter } = await import('./routes/test-diagnostic.js');
    // Inspector adapter — narrows the HybridExecutionReader surface to the
    // 3-mode hybrid-endpoint contract (LLD §5.7). Only wired when the
    // dual-read flag is on (so `executionHybridReader` was constructed).
    const hybridInspector = executionHybridReader
      ? {
          mongoOnly: (p: { tenantId: string; projectId: string; executionId: string }) =>
            executionHybridReader!
              .inspectMongoOnly(p)
              .then((r) => (r ? (r as unknown as Record<string, unknown>) : null)),
          chOnly: (p: { tenantId: string; projectId: string; executionId: string }) =>
            executionHybridReader!
              .inspectChOnly(p)
              .then((r) => (r ? (r as unknown as Record<string, unknown>) : null)),
          union: (p: { tenantId: string; projectId: string; executionId: string }) =>
            executionHybridReader!
              .inspectUnion(p)
              .then((r) => (r ? (r as unknown as Record<string, unknown>) : null)),
        }
      : undefined;
    const testDiagnosticRouter = createTestDiagnosticRouter({
      outboxModel:
        WorkflowEventOutboxModel as unknown as import('./routes/test-diagnostic.js').WorkflowOutboxReadModel,
      executionModel:
        WorkflowExecution as unknown as import('./routes/test-diagnostic.js').ExecutionReadModel,
      poller: activeOutboxPoller,
      hybridInspector,
      authMiddleware,
    });
    app.use('/api/admin/test', testDiagnosticRouter);
    log.info('Test-diagnostic routes mounted', {
      mount: '/api/admin/test',
      hybridEnabled: Boolean(hybridInspector),
    });
  }

  // ─── 404 handler (must be after all routes) ────────────────
  app.use((_req: Request, res: Response) => {
    res.status(404).json({ success: false, error: 'Not found' });
  });

  // ─── Error handler ────────────────────────────────────────────
  app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
    log.error('Unhandled error in request', {
      error: err instanceof Error ? err.message : String(err),
    });
    res.status(500).json({ success: false, error: 'Internal server error' });
  });

  // 5. Start Restate service endpoint (HTTP/2, separate from Express). The
  // HTTP/2 endpoint must be listening before we tell Restate admin about it,
  // otherwise Restate's discovery probe will fail and the registration is
  // rejected.
  try {
    await restateEndpoint.listen(RESTATE_ENDPOINT_PORT);
    log.info('Restate service endpoint listening', { port: RESTATE_ENDPOINT_PORT });
  } catch (err) {
    log.error('Failed to start Restate endpoint — workflow execution via Restate unavailable', {
      port: RESTATE_ENDPOINT_PORT,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  // 6. Start the Restate health check loop. Readiness gates on Restate
  // *reachability* (not registration) to avoid the bootstrap deadlock:
  // registration requires Restate to discover this pod via the K8s Service,
  // which requires readiness to pass first.
  startRestateHealthCheck();
  startWorkflowPipelineHealthCheck();

  // 7. Kick off the Restate registration loop (fire-and-forget). The loop
  // retries with backoff until it succeeds, then reconciles periodically.
  // Because readiness gates on Restate health (not registration), the pod is
  // routable during this loop — Restate's discovery callback can reach it.
  void startRegistrationLoop();

  // 8. Start Express HTTP server (REST API). Readiness stays 503 until the
  // Restate health check succeeds.
  server = app.listen(PORT, () => {
    log.info('Workflow engine listening', { port: PORT });
  });
}

start().catch((err) => {
  log.error('Failed to start workflow-engine', {
    error: err instanceof Error ? err.message : String(err),
  });
  process.exit(1);
});

export { app };
