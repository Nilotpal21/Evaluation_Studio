/**
 * Runtime Express + WebSocket Server
 *
 * Handles agent execution, streaming chat, voice, and SDK WebSocket connections.
 * Design-time routes (auth, projects, credentials, etc.) live in Studio.
 */

import { PerformanceObserver, constants as perfConstants } from 'node:perf_hooks';
import { randomUUID } from 'node:crypto';
import type { Duplex } from 'node:stream';
import express, { type Express, Router } from 'express';
import { AppError, ErrorCodes } from '@agent-platform/shared-kernel';
import compression from 'compression';
import cors from 'cors';
import helmet from 'helmet';
import { createServer, type IncomingMessage } from 'http';
import { WebSocketServer } from 'ws';
import { startHeartbeat, stopHeartbeat, trackConnection } from './websocket/heartbeat.js';
import sessionsRouter from './routes/sessions.js';
import tracesRouter from './routes/traces.js';
import adminSessionsRouter from './routes/admin-sessions.js';
import transcriptsRouter from './routes/transcripts.js';
import chatRouter from './routes/chat.js';
import voiceRouter from './routes/voice.js';
import customTtsRouter from './routes/custom-tts.js';
import ttsPreviewRouter from './routes/tts-preview.js';
import livekitRouter from './routes/livekit.js';
import sdkRouter from './routes/sdk.js';
import sdkCustomerSessionsRouter from './routes/sdk-customer-sessions.js';
import sdkInitRouter from './routes/sdk-init.js';
import sdkWsTicketRouter from './routes/sdk-ws-ticket.js';
import agentsRouter from './routes/agents.js';
import authRouter from './routes/auth.js';
import deviceAuthRouter from './routes/device-auth.js';
import contactsRouter from './routes/contacts.js';
import workflowsRouter from './routes/workflows.js';
import workflowVersionsRouter from './routes/workflow-versions.js';
import { createWorkflowEngineProxy } from './middleware/workflow-engine-proxy.js';
import oauthRouter from './routes/oauth.js';
import promptLibraryRouter from './routes/prompt-library.js';
import externalAgentRouter from './routes/external-agents.js';
import versionsRouter from './routes/versions.js';
import projectAgentsRouter from './routes/project-agents.js';
import deploymentsRouter from './routes/deployments.js';
import diagnosticsRouter from './routes/diagnostics.js';
import validateRouter from './routes/validate.js';
import clickhouseDiagnosticsRouter from './routes/clickhouse-diagnostics.js';
import environmentVariablesRouter from './routes/environment-variables.js';
import agentModelConfigRouter from './routes/agent-model-config.js';
import projectLLMConfigRouter from './routes/project-llm-config.js';
import projectSettingsRouter from './routes/project-settings.js';
import projectRuntimeConfigRouter from './routes/project-runtime-config.js';
import simulateRouter from './routes/simulate.js';
import projectSessionLifecycleRouter from './routes/project-session-lifecycle.js';
import sdkChannelsRouter from './routes/sdk-channels.js';
import sdkPublicKeysRouter from './routes/sdk-public-keys.js';
import sdkJweCapabilityRouter from './routes/sdk-jwe-capability.js';
import sdkTokenDiagnosticsRouter from './routes/sdk-token-diagnostics.js';
import tenantModelsRouter from './routes/tenant-models.js';
import platformAdminModelsRouter from './routes/platform-admin-models.js';
import platformAdminConfigRouter from './routes/platform-admin-config.js';
import platformAdminBillingPolicyRouter from './routes/platform-admin-billing-policy.js';
import platformAdminTenantsRouter from './routes/platform-admin-tenants.js';
import platformAdminDealsRouter from './routes/platform-admin-deals.js';
import platformAdminHealthRouter from './routes/platform-admin-health.js';
import platformAdminUsageRouter from './routes/platform-admin-usage.js';
import tenantUsageRouter from './routes/tenant-usage.js';
import alertConfigRouter from './routes/alert-config.js';
import platformAdminHubspotRouter from './routes/platform-admin-hubspot.js';
import platformAdminResilienceRouter from './routes/platform-admin-resilience.js';
import tenantLLMPolicyRouter from './routes/tenant-llm-policy.js';
import tenantModelResolutionCacheRouter from './routes/tenant-model-resolution-cache.js';
import tenantServiceInstancesRouter from './routes/tenant-service-instances.js';
import modelCatalogRouter from './routes/model-catalog.js';
import modelCapabilitiesRouter from './routes/model-capabilities.js';
import {
  createA2AExpressHandlers,
  createA2ACallbackRouter,
  PushNotificationDeliveryService,
  SsrfEndpointValidator,
  RedisA2ATaskStore,
  LazyTaskStore,
  MemoryA2ASessionResolver,
  type A2ARedisClient,
} from '@agent-platform/a2a';
import {
  runWithTenantContext,
  type TenantContextData,
  type VerificationMethod,
} from '@agent-platform/shared-auth';
import type {
  A2ATracingPort,
  AgentExecutionPort,
  AgentCard,
  A2ARequestContext,
} from '@agent-platform/a2a';
import {
  InMemoryCallbackRegistry,
  InMemoryFanOutBarrierStore,
  RedisCallbackRegistry,
  RedisFanOutBarrierStore,
} from '@agent-platform/execution';
import { WebSocketConnectionRegistry } from './websocket/connection-registry.js';
import {
  PendingDeliveryStore,
  type PendingDeliveryRedisClient,
} from './services/execution/pending-delivery-store.js';
import { ChannelDispatcher } from './services/execution/channel-dispatcher.js';
import { createA2AAttachmentIngestor } from './services/a2a/attachment-ingestor.js';
import { normalizeSdkMessageMetadata } from './services/identity/sdk-message-metadata.js';
import { validateSessionMetadataSize } from './services/session-metadata.js';
import {
  extractLegacyClientInfoInteractionContext,
  mergeInteractionContextInputs,
  normalizeInteractionContextInput,
} from './services/execution/interaction-context.js';
import { getCurrentTraceId } from '@abl/compiler/platform/observability';
import { buildRequiredServicePrincipalProductionExecutionScope } from './services/session/execution-scope-factory.js';
import { buildProductionSessionLocator } from './services/session/execution-scope.js';
import { createCallbackRouter } from './routes/callbacks.js';
import {
  InMemoryLockPort,
  InMemoryPendingDeliveryRedisClient,
  InlineResumeDispatcher,
} from './services/execution/in-memory-async-infra.js';
import kmsAdminRouter from './routes/kms-admin.js';
import guardrailPoliciesRouter from './routes/guardrail-policies.js';
import guardrailProvidersRouter from './routes/guardrail-providers.js';
import piiPatternsRouter from './routes/pii-patterns.js';
import piiEntitiesRouter from './routes/pii-entities.js';
import httpAsyncChannelRouter from './routes/http-async-channel.js';
import channelVxmlRouter from './routes/channel-vxml.js';
import channelGenesysRouter from './routes/channel-genesys.js';
import channelAudiocodesRouter from './routes/channel-audiocodes.js';
import ai4wChannelRouter from './routes/ai4w-channel.js';
import internalDiscoveryRouter from './routes/internal-discovery.js';
import channelWebhooksRouter from './routes/channel-webhooks.js';
import channelConnectionsRouter from './routes/channel-connections.js';
import connectionsRouter from './routes/connections.js';
import attachmentsRouter from './routes/attachments.js';
import projectIORouter from './routes/project-io.js';
import projectsRouter from './routes/projects.js';
import toolSecretsRouter from './routes/tool-secrets.js';
import proxyConfigRouter from './routes/proxy-config.js';
import lookupDataRouter from './routes/lookup-data.js';
import analyticsRouter from './routes/analytics.js';
import feedbackListRouter from './routes/feedback-list.js';
import voiceAnalyticsRouter from './routes/voice-analytics.js';
import pipelineAnalyticsRouter from './routes/pipeline-analytics.js';
import pipelineConfigRouter, { pipelineManagementRouter } from './routes/pipeline-config.js';
import pipelineObservabilityRouter from './routes/pipeline-observability.js';
import projectBillingRouter from './routes/project-billing.js';
import customEventsRouter from './routes/custom-events.js';
import externalEventsRouter from './routes/external-events.js';
import tagsRouter from './routes/tags.js';
import alertsRouter from './routes/alerts.js';
import experimentsRouter from './routes/experiments.js';
import roiRouter from './routes/roi.js';
import nlAnalyticsRouter from './routes/nl-analytics.js';
import channelOAuthRouter from './routes/channel-oauth.js';
import { requireInternalNetworkAccess } from './middleware/internal-network.js';

/** Synthetic userId for KMS ALS context — not a real DB user, only used to satisfy TenantContextData shape. */
const KMS_SYSTEM_USER_ID = '__kms_system__';

function runKmsLookupInTenantContext<T>(tenantId: string, fn: () => Promise<T>): Promise<T> {
  const ctx: TenantContextData = {
    tenantId,
    userId: KMS_SYSTEM_USER_ID,
    role: 'SYSTEM',
    permissions: [],
    authType: 'user',
    isSuperAdmin: false,
  };
  return runWithTenantContext(ctx, fn);
}
import workspaceBillingRouter from './routes/workspace-billing.js';
import platformAdminFeaturesRouter from './routes/platform-admin-features.js';
import platformAdminAttachmentConfigRouter from './routes/platform-admin-attachment-config.js';
import feedbackRouter from './routes/feedback.js';
import softphoneWebhooksRouter from './routes/softphone-webhooks.js';
import memoryApiRouter from './routes/memory-api.js';
import omnichannelRouter from './routes/omnichannel.js';
import attachmentConfigRouter from './routes/attachment-config.js';
import insightsRouter from './routes/insights.js';
import authProfilesRouter from './routes/auth-profiles.js';
import platformAdminTracesRouter from './routes/platform-admin-traces.js';
import platformAdminAgentAssistRouter from './routes/platform-admin-agent-assist.js';
import projectAgentAssistBindingsRouter from './routes/project-agent-assist-bindings.js';
import projectEnvironmentsRouter from './routes/project-environments.js';
import variableNamespacesRouter from './routes/variable-namespaces.js';
import variableNamespaceMembersRouter from './routes/variable-namespace-members.js';
import tenantSdkChannelsRouter from './routes/tenant-sdk-channels.js';
import evaluationTagsRouter from './routes/evaluation-tags.js';
import { getRuntimeExecutor } from './services/runtime-executor.js';
import { getStores } from './services/stores/store-factory.js';
import type { MongoConversationStore } from './services/stores/mongo-conversation-store.js';
import { emitContactLifecycleAudit } from './services/audit-helpers.js';
import {
  setExecutionCoordinator,
  isCoordinatorAvailable,
  getExecutionCoordinator,
} from './services/execution/coordinator-singleton.js';
import { createIdentityVerificationRouter } from './routes/identity-verification.js';
import { createContactMergeRouter } from './routes/contact-merge.js';
import { createMergeSuggestionsRouter } from './routes/merge-suggestions.js';
import type { IdentityVerifier } from './contexts/identity/domain/identity-verifier.js';
import crawlerProfileRouter from './routes/crawler-profile.js';
import { VoiceServiceFactory } from './services/voice/voice-service-factory.js';
import {
  handleConnection,
  setConnectionRegistry as setDebugConnectionRegistry,
  setRedisPubSub,
} from './websocket/handler.js';
import { WfBridge } from './websocket/wf-bridge.js';
import { extractVerifiedUserTokenClaims } from './middleware/auth.js';
import {
  extractSdkTokenFromProtocolHeader,
  extractWebDebugTokenFromProtocolHeader,
} from '@agent-platform/shared/websocket-auth';
import { findProjectByIdAndTenant } from './repos/project-repo.js';
import { OrpheusCustomTtsStreamingHandler } from './websocket/orpheus-custom-tts-handler.js';
import {
  handleSDKConnection,
  sdkClients,
  setConnectionRegistry as setSdkConnectionRegistry,
} from './websocket/sdk-handler.js';
import { getRuntimeSdkTokenEnvelopeDeps } from './services/identity/sdk-jwe-runtime-config.js';
import { handleTwilioMediaConnection } from './websocket/twilio-media-handler.js';
import { KorevgRouter } from './services/voice/korevg/korevg-router.js';
import {
  registerConnection as registerAudioCodesWs,
  startCleanup as startAudioCodesCleanup,
  stopCleanup as stopAudioCodesCleanup,
} from './channels/audiocodes/ws-manager.js';
import { isDatabaseAvailable, disconnectDatabase, initMongoBackend } from './db/index.js';
import { getConfig } from './config/index.js';
import {
  disconnectRedis,
  getRedisClient,
  getRedisHandle,
  isRedisAvailable,
} from './services/redis/redis-client.js';
import { createSubscriber, createBullMQPair, getBullMQPrefix } from '@agent-platform/redis';
import { getInboundQueue, getDeliveryQueue } from './services/queues/channel-queues.js';
import { shutdownLLMQueue } from './services/llm/llm-queue.js';
import { resetHybridRateLimiter } from './services/resilience/hybrid-rate-limiter.js';
import { resetCircuitBreakerRegistry } from './services/resilience/hybrid-cb-registry.js';
import { persistMessage, shutdownMessageQueue } from './services/message-persistence-queue.js';
import { startSessionCleanupJob, stopSessionCleanupJob } from './services/session-cleanup-job.js';
import { startWorkflowPurgeJob, stopWorkflowPurgeJob } from './services/workflow-purge-job.js';
import {
  startSessionTimeoutSweepJob,
  stopSessionTimeoutSweepJob,
} from './services/session-timeout-sweep-job.js';
import { requestIdMiddleware } from '@agent-platform/shared-observability';
import { createExpressErrorHandler, requireTenantMatch } from '@agent-platform/shared/middleware';
import { authMiddleware as tenantAuthMiddleware } from './middleware/auth.js';
import { createLogger } from '@abl/compiler/platform';
import { loadServiceChangeCompatibility } from '@agent-platform/database';
import { getClickHouseClient, closeClickHouseClient } from '@agent-platform/database/clickhouse';
import { ensureClickHouseSchemaReady } from '@agent-platform/database/clickhouse-schemas/init-all';
import { resolveClickHouseAuditRetentionConfig } from '@agent-platform/database/clickhouse-schemas/init';
import type { DEKFacadeInitResult } from '@agent-platform/database/kms';
import {
  startClickHouseProbe,
  stopClickHouseProbe,
  getLastProbeResult,
} from './health/clickhouse-probe.js';
import {
  isTenantEncryptionReady,
  getEncryptionService,
  encryptForTenantAuto,
  decryptForTenantAuto,
} from '@agent-platform/shared/encryption';
import { clearContactLinkingDeps } from './services/identity/contact-linking-deps.js';
import { initializeRuntimeContactLinking } from './contexts/contact/runtime-contact-context.js';
import {
  isLiveKitWorkerRunning,
  stopLiveKitWorker,
} from './services/voice/livekit/worker-entry.js';
import { ToolOAuthService } from './services/tool-oauth-service.js';
import { getServiceBuildInfo } from '@agent-platform/shared/build-info';
import type {
  OAuthTokenStore,
  OAuthEncryptor,
  OAuthTokenCompareAndSwapParams,
} from './services/tool-oauth-service.js';
import { setToolOAuthService } from './services/tool-oauth-service-singleton.js';
import {
  resolveAuthProfileOAuthProvider,
  resolveAuthProfileOAuthProviderById,
} from './services/auth-profile/auth-profile-oauth-resolver.js';
import { serveOpenAPIDocs, introspectExpressRoutes } from '@agent-platform/openapi/express';
import { runtimeRegistry } from './openapi/registry.js';
import {
  incrementActiveRequests,
  decrementActiveRequests,
  recordHttpRequest,
} from './observability/metrics.js';
import {
  createEventBus,
  shutdownEventBus,
  type EventBusComponents,
} from './services/event-bus/index.js';
import { getRuntimeChangeRequirement } from './change-management/requirements.js';
import { createRuntimeLivenessHandler } from './change-management/liveness.js';
import { createRuntimeReadinessHandler } from './change-management/readiness.js';
import { createRuntimeDiagnoseHandler } from './diagnose/diagnose-handler.js';
import { probeKafkaFromConsumer } from './diagnose/kafka-diagnostics.js';
import { classifyProbeError } from './diagnose/error-classifier.js';
import { createDiagnoseRateLimit, createRequireDiagnoseKey } from './diagnose/diagnose-access.js';
import {
  WORKFLOW_EXECUTION_TOPIC,
  HUMAN_TASK_TOPIC,
  WORKFLOW_EXECUTION_GROUP_ID,
  HUMAN_TASK_GROUP_ID,
} from './services/workflow-events-consumer.js';
import {
  resolveRuntimeCorsAllowedHeaders,
  resolveRuntimeCorsMethods,
  resolveRuntimeCorsOrigin,
} from './lib/sdk-browser-cors.js';
import {
  getRuntimeEventBus,
  setRuntimeEventBus,
} from './services/event-bus/runtime-bus-accessor.js';

// =============================================================================
// EXPRESS APP
// =============================================================================

const app: Express = express();
const getConfigLazy = () => getConfig();
let clickhouseReady = false;
let clickhouseInitializationFailure: ClickHouseInitializationFailure | null = null;
let eventBusComponents: EventBusComponents | null = null;
let dekManagerInvalidationHandle: { shutdownTransport(): Promise<void> } | null = null;
let workflowEventsConsumer: {
  shutdown(): Promise<void>;
  flushAll(): Promise<void>;
  isHealthy(): boolean;
} | null = null;
let workflowHybridHumanTaskReader:
  | import('./services/hybrid-human-task-reader.js').HybridHumanTaskReader
  | null = null;

interface ClickHouseInitializationFailure {
  message: string;
  name?: string;
  stack?: string;
}

function toErrorDiagnostics(error: unknown): ClickHouseInitializationFailure {
  if (error instanceof Error) {
    return {
      message: error.message,
      name: error.name,
      stack: error.stack,
    };
  }

  return {
    message: String(error),
  };
}

function getConfiguredClickHouseEndpointSource(): 'CLICKHOUSE_URL' | 'CLICKHOUSE_HOST' | 'default' {
  if (process.env.CLICKHOUSE_URL) {
    return 'CLICKHOUSE_URL';
  }
  if (process.env.CLICKHOUSE_HOST) {
    return 'CLICKHOUSE_HOST';
  }
  return 'default';
}

function getClickHouseStartupDiagnostics() {
  const auditRetentionConfig = resolveClickHouseAuditRetentionConfig(process.env);

  return {
    endpointSource: getConfiguredClickHouseEndpointSource(),
    database: process.env.CLICKHOUSE_DATABASE || 'abl_platform',
    userConfigured: Boolean(process.env.CLICKHOUSE_USER),
    passwordConfigured: Boolean(process.env.CLICKHOUSE_PASSWORD),
    replicatedTablesEnabled: process.env.CLICKHOUSE_REPLICATED === 'true',
    tieredStorageEnabled: process.env.CLICKHOUSE_TIERED_STORAGE === 'true',
    deploymentEnvironment: auditRetentionConfig.deploymentEnvironment,
    auditEventsColdTtlDays: process.env.AUDIT_EVENTS_COLD_TTL_DAYS,
    kmsAuditWarmTtlDays: process.env.KMS_AUDIT_WARM_TTL_DAYS,
  };
}

interface RedisPubSubClient {
  on(event: 'message', handler: (channel: string, message: string) => void): void;
  publish(channel: string, message: string): Promise<unknown>;
  subscribe(channel: string): Promise<unknown>;
  unsubscribe(): Promise<unknown>;
  quit(): Promise<unknown>;
}

interface CacheInvalidationTransport {
  publish(channel: string, message: string): Promise<void>;
  subscribe(channel: string, handler: (message: string) => void): Promise<void>;
  shutdown(): Promise<void>;
}

function createRedisInvalidationTransport(
  pubClient: RedisPubSubClient,
  subClient: RedisPubSubClient,
): CacheInvalidationTransport {
  return {
    async publish(channel: string, message: string): Promise<void> {
      await pubClient.publish(channel, message);
    },
    async subscribe(channel: string, handler: (message: string) => void): Promise<void> {
      subClient.on('message', (incomingChannel: string, incomingMessage: string) => {
        if (incomingChannel === channel) {
          handler(incomingMessage);
        }
      });
      await subClient.subscribe(channel);
    },
    async shutdown(): Promise<void> {
      try {
        await subClient.unsubscribe();
        await subClient.quit();
      } catch {
        // Best-effort cleanup on shutdown — intentional
      }
    },
  };
}

async function closeRedisSubscriber(subClient: RedisPubSubClient | null): Promise<void> {
  if (!subClient) {
    return;
  }
  try {
    await subClient.quit();
  } catch {
    // Best-effort cleanup on startup failure — intentional
  }
}

async function wireKmsAndDekInvalidation(dek: DEKFacadeInitResult): Promise<void> {
  try {
    const { createRedisSubscriber, getRedisClient } =
      await import('./services/redis/redis-client.js');
    const pubClient = getRedisClient() as RedisPubSubClient | null;
    if (!pubClient) {
      serverLog.warn(
        'KMS/DEK cache invalidation: Redis not available — relying on L1 TTL for consistency',
      );
      return;
    }

    const resolverSubClient = createRedisSubscriber() as RedisPubSubClient | null;
    const dekSubClient = createRedisSubscriber() as RedisPubSubClient | null;
    if (!resolverSubClient || !dekSubClient) {
      await closeRedisSubscriber(resolverSubClient);
      await closeRedisSubscriber(dekSubClient);
      serverLog.warn(
        'KMS/DEK cache invalidation: Redis subscriber unavailable — relying on L1 TTL for consistency',
      );
      return;
    }

    dek.resolver.setInvalidationTransport(
      createRedisInvalidationTransport(pubClient, resolverSubClient),
    );
    if (await dek.resolver.subscribeInvalidation()) {
      serverLog.info('KMS cache invalidation subscriber active');
    }

    dek.dekManager.setInvalidationTransport(
      createRedisInvalidationTransport(pubClient, dekSubClient),
    );
    dekManagerInvalidationHandle = dek.dekManager;
    if (await dek.dekManager.subscribeInvalidation()) {
      serverLog.info('DEK cross-pod cache invalidation subscriber active');
    }
  } catch (dekPubSubErr) {
    serverLog.warn('KMS/DEK cache invalidation wiring failed (non-fatal, L1 TTL fallback)', {
      error: dekPubSubErr instanceof Error ? dekPubSubErr.message : String(dekPubSubErr),
    });
  }
}

async function wireModelHubInvalidation(encMasterKey: string): Promise<void> {
  try {
    const { createRedisSubscriber, getRedisClient } =
      await import('./services/redis/redis-client.js');
    const modelPubClient = getRedisClient() as RedisPubSubClient | null;
    if (!modelPubClient) {
      serverLog.warn(
        'Model Hub cache invalidation: Redis not available — relying on local TTL for consistency',
      );
      return;
    }

    const modelSubClient = createRedisSubscriber() as RedisPubSubClient | null;
    if (!modelSubClient) {
      serverLog.warn(
        'Model Hub cache invalidation: Redis subscriber unavailable — relying on local TTL for consistency',
      );
      return;
    }

    const { setModelInvalidationTransport, subscribeModelInvalidation, setInvalidationHmacKey } =
      await import('./services/llm/model-cache-invalidation.js');

    const { createHmac } = await import('node:crypto');
    const derivedKey = createHmac('sha256', encMasterKey)
      .update('model-hub-invalidation')
      .digest('hex');
    setInvalidationHmacKey(derivedKey);

    setModelInvalidationTransport(createRedisInvalidationTransport(modelPubClient, modelSubClient));
    await subscribeModelInvalidation();
  } catch (modelInvErr) {
    serverLog.warn('Model Hub cache invalidation wiring failed (non-fatal, local TTL fallback)', {
      error: modelInvErr instanceof Error ? modelInvErr.message : String(modelInvErr),
    });
  }
}

export function getEventBus() {
  return getRuntimeEventBus();
}
// Security
app.use((req, res, next) => {
  const config = getConfigLazy();
  const helmetConfig =
    config.env === 'production'
      ? {
          contentSecurityPolicy: false, // Runtime is API-only
          crossOriginEmbedderPolicy: false,
          hsts: { maxAge: 31536000, includeSubDomains: true, preload: true },
        }
      : {
          contentSecurityPolicy: false,
          crossOriginEmbedderPolicy: false,
        };
  helmet(helmetConfig)(req, res, next);
});

// CORS
app.use((req, res, next) => {
  const config = getConfigLazy();
  const corsOptions = {
    origin: resolveRuntimeCorsOrigin(req, config),
    credentials: config.cors.credentials,
    methods: resolveRuntimeCorsMethods(req, config),
    allowedHeaders: resolveRuntimeCorsAllowedHeaders(req, config),
    exposedHeaders: config.cors.exposedHeaders,
  };
  cors(corsOptions)(req, res, next);
});

// Response compression (threshold: 1KB — cuts large JSON payloads ~70%)
// eslint-disable-next-line @typescript-eslint/no-explicit-any
app.use(compression({ threshold: 1024 }) as any);

// Body parsing — capture raw body for webhook signature verification
app.use(
  express.json({
    limit: '1mb',
    verify: (req: any, _res, buf) => {
      req.rawBody = buf;
    },
  }),
);

// Text body parsing — for CSV upload (lookup table entries)
app.use(express.text({ type: 'text/csv', limit: '1mb' }));

// Request correlation ID
app.use(requestIdMiddleware());

// HTTP request metrics (OTEL)
app.use((req, res, next) => {
  const start = Date.now();
  incrementActiveRequests();
  res.on('finish', () => {
    decrementActiveRequests();
    recordHttpRequest({
      method: req.method,
      route: req.route?.path || req.path,
      statusCode: res.statusCode,
      durationMs: Date.now() - start,
    });
  });
  next();
});

// ---------------------------------------------------------------------------
// GC + Event Loop Instrumentation — lightweight, zero-dependency, always-on
// Tracks GC pause durations and event loop lag for the /health endpoint.
// Uses Node.js built-in perf_hooks — no npm packages needed.
// ---------------------------------------------------------------------------

const gcStats = {
  /** Total number of GC events since process start */
  totalCount: 0,
  /** Total time spent in GC since last reset (ms) */
  totalPauseMs: 0,
  /** Maximum single GC pause since last reset (ms) */
  maxPauseMs: 0,
  /** GC events since last /health read (rolling window) */
  windowCount: 0,
  /** Total GC pause in current window (ms) */
  windowPauseMs: 0,
  /** Max GC pause in current window (ms) */
  windowMaxMs: 0,
  /** Breakdown by GC type: major, minor, incremental, weak */
  byType: {} as Record<string, { count: number; totalMs: number; maxMs: number }>,
  /** Timestamp of last reset */
  windowStartedAt: Date.now(),
};

// Map V8 GC flags to human-readable names
const gcFlagNames: Record<number, string> = {
  [perfConstants.NODE_PERFORMANCE_GC_FLAGS_NO]: 'unknown',
  [perfConstants.NODE_PERFORMANCE_GC_MINOR]: 'minor',
  [perfConstants.NODE_PERFORMANCE_GC_MAJOR]: 'major',
  [perfConstants.NODE_PERFORMANCE_GC_INCREMENTAL]: 'incremental',
  [perfConstants.NODE_PERFORMANCE_GC_WEAKCB]: 'weak',
};

try {
  const gcObserver = new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) {
      const durationMs = entry.duration;
      const kind =
        gcFlagNames[(entry as { flags?: number }).flags ?? 0] ??
        gcFlagNames[(entry as { detail?: { kind?: number } }).detail?.kind ?? 0] ??
        'unknown';

      gcStats.totalCount++;
      gcStats.totalPauseMs += durationMs;
      if (durationMs > gcStats.maxPauseMs) gcStats.maxPauseMs = durationMs;

      gcStats.windowCount++;
      gcStats.windowPauseMs += durationMs;
      if (durationMs > gcStats.windowMaxMs) gcStats.windowMaxMs = durationMs;

      // Per-type breakdown
      if (!gcStats.byType[kind]) {
        gcStats.byType[kind] = { count: 0, totalMs: 0, maxMs: 0 };
      }
      gcStats.byType[kind].count++;
      gcStats.byType[kind].totalMs += durationMs;
      if (durationMs > gcStats.byType[kind].maxMs) {
        gcStats.byType[kind].maxMs = durationMs;
      }
    }
  });
  gcObserver.observe({ entryTypes: ['gc'] });
} catch {
  // perf_hooks GC observation may not be available in all Node.js builds
}

// Event loop lag tracker — measures how long a setImmediate actually takes.
// setImmediate fires at the end of the current I/O cycle. Any lag above ~0.1ms
// means the event loop was blocked (GC, sync I/O, long computation).
let eventLoopLagMs = 0;
let eventLoopLagPeakMs = 0;
let eventLoopLagWindowPeakMs = 0;

function measureEventLoopLag(): void {
  const start = process.hrtime.bigint();
  // Use setImmediate (fires after I/O, ~0ms baseline) instead of setTimeout
  // which has a minimum ~1ms delay even when the event loop is idle.
  // We schedule the NEXT measurement with setTimeout(200ms) to avoid
  // burning CPU on continuous setImmediate calls.
  setImmediate(() => {
    const elapsed = Number(process.hrtime.bigint() - start) / 1_000_000; // ns → ms
    eventLoopLagMs = Math.max(0, elapsed);
    if (eventLoopLagMs > eventLoopLagPeakMs) eventLoopLagPeakMs = eventLoopLagMs;
    if (eventLoopLagMs > eventLoopLagWindowPeakMs) eventLoopLagWindowPeakMs = eventLoopLagMs;
    // Schedule next measurement after 200ms — frequent enough to catch GC pauses
    setTimeout(measureEventLoopLag, 200);
  });
}
measureEventLoopLag();

// Health check
app.get('/health', requireInternalNetworkAccess, async (_req, res) => {
  try {
    if (isDatabaseAvailable()) {
      const { MongoConnectionManager } = await import('@agent-platform/database/mongo');
      const health = await MongoConnectionManager.getInstance().healthCheck();
      if (!health.ok)
        throw new AppError('MongoDB health check failed', { ...ErrorCodes.SERVICE_UNAVAILABLE });
    }
    const config = getConfigLazy();
    const dbLabel = isDatabaseAvailable() ? 'connected (mongo)' : 'not configured';

    // Operational metrics — session count is pod-local only (executor may not be initialized)
    let localCachedSessions = -1;
    try {
      localCachedSessions = getRuntimeExecutor().getSessionCount();
    } catch {
      // Executor not initialized yet
    }
    const mem = process.memoryUsage();
    const { getAuditStoreStatus } = await import('./services/audit-store-singleton.js');

    res.json({
      status: 'healthy',
      service: 'runtime',
      build: getServiceBuildInfo(),
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
      database: dbLabel,
      clickhouse: (() => {
        const probe = getLastProbeResult();
        if (probe) return probe.ok ? 'connected' : 'degraded';
        return clickhouseReady ? 'connected' : 'not configured';
      })(),
      clickhouseProbe: getLastProbeResult() ?? undefined,
      redis: isRedisAvailable() ? 'connected' : getRedisClient() ? 'degraded' : 'not configured',
      livekit: config.features.livekitEnabled
        ? isLiveKitWorkerRunning()
          ? 'running'
          : 'stopped'
        : 'disabled',
      channelQueues: {
        inbound: getInboundQueue() ? 'ready' : 'not initialized',
        delivery: getDeliveryQueue() ? 'ready' : 'not initialized',
      },
      auditStore: getAuditStoreStatus(),
      metrics: {
        localCachedSessions,
        memoryUsageMB: Math.round(mem.rss / 1048576),
        heapUsedMB: Math.round(mem.heapUsed / 1048576),
        heapTotalMB: Math.round(mem.heapTotal / 1048576),
        externalMB: Math.round((mem.external || 0) / 1048576),
        arrayBuffersMB: Math.round((mem.arrayBuffers || 0) / 1048576),
      },
      gc: {
        /** GC stats since last /health read (rolling window) */
        windowCount: gcStats.windowCount,
        windowPauseMs: Math.round(gcStats.windowPauseMs),
        windowMaxMs: Math.round(gcStats.windowMaxMs),
        windowDurationSec: Math.round((Date.now() - gcStats.windowStartedAt) / 1000),
        /** GC stats since process start (cumulative) */
        totalCount: gcStats.totalCount,
        totalPauseMs: Math.round(gcStats.totalPauseMs),
        maxPauseMs: Math.round(gcStats.maxPauseMs),
        /** Breakdown by GC type */
        byType: Object.fromEntries(
          Object.entries(gcStats.byType).map(([k, v]) => [
            k,
            { count: v.count, totalMs: Math.round(v.totalMs), maxMs: Math.round(v.maxMs) },
          ]),
        ),
      },
      eventLoop: {
        lagMs: Math.round(eventLoopLagMs),
        lagPeakMs: Math.round(eventLoopLagPeakMs),
        windowPeakMs: Math.round(eventLoopLagWindowPeakMs),
      },
    });

    // Reset rolling window after each /health read so next poll sees fresh data
    gcStats.windowCount = 0;
    gcStats.windowPauseMs = 0;
    gcStats.windowMaxMs = 0;
    gcStats.windowStartedAt = Date.now();
    eventLoopLagWindowPeakMs = 0;
  } catch {
    res.status(503).json({
      status: 'unhealthy',
      service: 'runtime',
      error: 'Database connection failed',
    });
  }
});

// Readiness probe — fails during shutdown, under memory pressure, if Redis is unreachable,
// or when required change-management entries are missing.
const HEAP_LIMIT_DEFAULT_MB = 1536;

function getRuntimeHeapLimitMb(): number {
  const parsedLimit = parseInt(
    process.env.HEALTH_HEAP_LIMIT_MB || String(HEAP_LIMIT_DEFAULT_MB),
    10,
  );
  return Number.isNaN(parsedLimit) ? HEAP_LIMIT_DEFAULT_MB : parsedLimit;
}

app.get(
  '/diagnose',
  requireInternalNetworkAccess,
  createRequireDiagnoseKey(),
  createDiagnoseRateLimit(),
  createRuntimeDiagnoseHandler({
    auditLogger: {
      info: (event, fields) => serverLog.info(event, fields),
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
        serverLog.warn('diagnose.mongo_probe_failed', {
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
      const redis = getRedisClient();
      if (!redis) return { ok: false, latencyMs: 0, detail: 'not_configured' };
      try {
        const result = await redis.ping();
        return {
          ok: result === 'PONG',
          latencyMs: Math.round(performance.now() - start),
          ...(result === 'PONG' ? {} : { detail: 'ping_failed' }),
        };
      } catch (err) {
        serverLog.warn('diagnose.redis_probe_failed', {
          error: err instanceof Error ? err.message : String(err),
        });
        return {
          ok: false,
          latencyMs: Math.round(performance.now() - start),
          detail: classifyProbeError(err),
        };
      }
    },
    probeClickHouse: async () => {
      if (process.env.WORKFLOW_CH_SINK_ENABLED !== 'true') return null;
      const start = performance.now();
      try {
        const { getClickHouseClient } = await import('@agent-platform/database/clickhouse');
        const result = await getClickHouseClient().ping();
        if (!result.success) {
          serverLog.warn('diagnose.clickhouse_probe_failed', {
            error: result.error?.message ?? 'ping failed',
          });
        }
        return {
          ok: result.success,
          latencyMs: Math.round(performance.now() - start),
          detail: result.success ? undefined : classifyProbeError(result.error ?? 'ping failed'),
        };
      } catch (err) {
        serverLog.warn('diagnose.clickhouse_probe_failed', {
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
      if (process.env.WORKFLOW_CH_SINK_ENABLED !== 'true') return null;
      const brokers = (process.env.EVENT_KAFKA_BROKERS ?? 'localhost:9092').split(',');
      return probeKafkaFromConsumer({
        brokers,
        topicsToCheck: [WORKFLOW_EXECUTION_TOPIC, HUMAN_TASK_TOPIC],
        groupsToCheck: [WORKFLOW_EXECUTION_GROUP_ID, HUMAN_TASK_GROUP_ID],
      });
    },
    getConsumerState: () => {
      if (!workflowEventsConsumer) return null;
      return {
        running: workflowEventsConsumer.isHealthy(),
        topics: [WORKFLOW_EXECUTION_TOPIC, HUMAN_TASK_TOPIC],
        groupIds: [WORKFLOW_EXECUTION_GROUP_ID, HUMAN_TASK_GROUP_ID],
      };
    },
  }),
);

app.get(
  '/health/ready',
  createRuntimeReadinessHandler({
    isShuttingDown: () => isShuttingDown,
    getHeapUsedMb: () => process.memoryUsage().heapUsed / 1048576,
    getHeapLimitMb: () => getRuntimeHeapLimitMb(),
    isMongoReady: async () => {
      if (!isDatabaseAvailable()) {
        return process.env.OBS_STRICT_READINESS_GATES !== 'true';
      }

      if (process.env.OBS_STRICT_READINESS_GATES !== 'true') {
        return true;
      }

      const mongoose = (await import('mongoose')).default;
      return mongoose.connection.readyState === 1;
    },
    pingRedis: async () => {
      const redis = getRedisClient();
      if (redis) {
        await redis.ping();
      }
    },
    // Workflow event-sourcing pipeline gates (ABLP-2). Wired only when the
    // matching `_ENABLED` flag is on, so readiness behaviour for runtime
    // instances with the sink disabled is unchanged.
    isWorkflowConsumerHealthy:
      process.env.WORKFLOW_CH_SINK_ENABLED === 'true'
        ? () => {
            const consumer = workflowEventsConsumer;
            return consumer ? consumer.isHealthy() : false;
          }
        : undefined,
    isWorkflowClickHouseHealthy:
      process.env.WORKFLOW_CH_SINK_ENABLED === 'true'
        ? () => {
            const probe = getLastProbeResult();
            // Before the first probe completes, fall back to the static
            // startup flag so readiness doesn't flap for the first few seconds.
            if (probe === null) return clickhouseReady;
            return probe.ok;
          }
        : undefined,
    loadCompatibility: async () => {
      if (!isDatabaseAvailable()) {
        return null;
      }

      const mongoose = (await import('mongoose')).default;
      const db = mongoose.connection.db;
      if (!db) {
        return null;
      }

      return loadServiceChangeCompatibility(db, getRuntimeChangeRequirement());
    },
    onHardFail: (result) => {
      serverLog.error('Runtime change compatibility requires hard fail handling', {
        blockers: result.blockingIssues,
      });
    },
  }),
);

// Liveness probe — zero I/O, only checks shutdown flag and heap pressure.
// Kubelet restarts the pod when this returns 503.
app.get(
  '/health/live',
  createRuntimeLivenessHandler({
    isShuttingDown: () => isShuttingDown,
    getHeapUsedMb: () => process.memoryUsage().heapUsed / 1048576,
    getHeapLimitMb: () => getRuntimeHeapLimitMb(),
  }),
);

// =============================================================================
// ENCRYPTION CONTEXT — AsyncLocalStorage (Decision 12: two-layer middleware)
// Layer 1 (global): Sets baseline environment=null for all requests.
// Layer 2 (project routes): Overrides with deployment environment context.
// =============================================================================
import { runWithEncryptionContext } from '@agent-platform/shared-encryption';

// Layer 1: Global encryption context — every request runs in ALS with env=null
app.use((req, res, next) => {
  runWithEncryptionContext({ environment: null }, () => next());
});

// =============================================================================
// EXECUTION PLANE — /api/v1/*
// High-volume end-user conversation traffic. Autoscales independently.
// Production ingress: /api/v1/* → runtime-execution pods
// =============================================================================
app.use('/api/v1/chat', chatRouter);
app.use('/api/v1/voice', voiceRouter);
app.use('/api/v1/voice/custom-tts', customTtsRouter);
app.use('/api/v1/voice/tts-preview', ttsPreviewRouter);
app.use('/api/v1/voice/softphone', softphoneWebhooksRouter);
app.use('/api/v1/livekit', livekitRouter);
app.use('/api/v1/sdk', sdkRouter);
app.use('/api/v1/sdk', sdkCustomerSessionsRouter);
app.use('/api/v1/sdk', sdkInitRouter);
app.use('/api/v1/sdk', sdkWsTicketRouter);
app.use('/api/v1/oauth', oauthRouter);
app.use('/api/v1/channel-oauth', channelOAuthRouter);
app.use('/api/v1/transcripts', transcriptsRouter);
app.use('/api/v1/channels/http-async', httpAsyncChannelRouter);
app.use('/api/v1/channels/vxml', channelVxmlRouter);
app.use('/api/v1/channels/genesys', channelGenesysRouter);
app.use('/api/v1/channels/audiocodes', channelAudiocodesRouter);
app.use('/api/v1/channels/ai4w', ai4wChannelRouter);
if (process.env.AI4W_INTERNAL_API_ENABLED === 'true') {
  app.use('/api/internal/v1', internalDiscoveryRouter);
}
app.use('/api/v1/channels', channelWebhooksRouter);
app.use('/api/v1/feedback', feedbackRouter);

// Agent transfer webhooks (SmartAssist inbound events)
import agentTransferWebhooksRouter from './routes/agent-transfer-webhooks.js';
app.use('/api/v1/agent-transfer/webhooks', agentTransferWebhooksRouter);

// Agent transfer sessions, settings, and CSAT (authenticated)
import agentTransferSessionsRouter from './routes/agent-transfer-sessions.js';
import agentTransferSettingsRouter from './routes/agent-transfer-settings.js';
import agentTransferCsatRouter from './routes/agent-transfer-csat.js';
app.use('/api/v1/agent-transfer/sessions', agentTransferSessionsRouter);
app.use('/api/v1/agent-transfer/settings', agentTransferSettingsRouter);
app.use('/api/v1/agent-transfer/csat', agentTransferCsatRouter);

// External workflow execution API (short URL + path-segment forms)
import { SyncExecutionService } from './services/sync-execution.js';
import { DEFAULT_WORKFLOW_ENGINE_PORT } from '@agent-platform/config/constants';
import { createWorkflowsExecuteRouter } from './routes/workflows-execute.js';

const workflowEngineBaseUrl =
  process.env.WORKFLOW_ENGINE_URL || `http://localhost:${DEFAULT_WORKFLOW_ENGINE_PORT}`;

// `syncExecutionService` is created LATER in startServer() once
// `initializeRedis()` resolves. The router receives a lazy getter so it
// picks up the service at request time rather than module-load time.
let syncExecutionService: SyncExecutionService | undefined;

const workflowsExecuteRouter = createWorkflowsExecuteRouter({
  syncExecution: () => syncExecutionService,
  engineBaseUrl: workflowEngineBaseUrl,
});
app.use('/api/v1/workflows', tenantAuthMiddleware, workflowsExecuteRouter);

// Agent Assist V1 Compatibility Facade.
// Spec: docs/features/agent-assist-runtime-compat.md
// Mount path matches the legacy Agentic Platform V1 URL shape so Kore.ai Agent Assist
// Agentic Configurations can be repointed to ABL without widget changes.
import { createAgentAssistRouter } from './routes/agent-assist.js';
import { createBindingResolver } from './services/agent-assist/binding-resolver.js';
import { createAgentAssistBindingRepo } from './repos/agent-assist-binding-repo.js';
import { setAgentAssistTraceEmitter } from './services/agent-assist/trace-events.js';
import { getTraceStore as getAgentAssistTraceStore } from './services/trace-store.js';
import type { AgentAssistCallbackJob } from './workers/agent-assist-callback-worker.js';
let agentAssistCallbackQueue:
  | {
      add: (data: AgentAssistCallbackJob) => Promise<unknown>;
      close: () => Promise<void>;
    }
  | undefined;
app.use(
  '/api/v2/apps',
  createAgentAssistRouter({
    bindings: createBindingResolver({
      mongoRepo: createAgentAssistBindingRepo(),
    }),
    callbackQueue: () => agentAssistCallbackQueue,
  }),
);
// Route typed agent_assist.* trace events into the runtime TraceStore so Observatory,
// debugging tooling, and billing attribution receive them. Payloads carry sessionId when
// known; early-phase events (received, binding_resolved) use a synthetic pre-session key
// so they remain queryable before a session exists.
setAgentAssistTraceEmitter((type, payload) => {
  const p = payload as Record<string, unknown>;
  const sessionId =
    typeof p.sessionId === 'string' && p.sessionId.length > 0
      ? p.sessionId
      : `agent-assist:${String(p.tenantId ?? 'unknown')}:${String(p.appId ?? 'unknown')}:${String(p.environment ?? 'unknown')}`;
  getAgentAssistTraceStore().addEvent(sessionId, {
    id: randomUUID(),
    sessionId,
    type,
    timestamp: new Date(),
    data: p,
  });
});

// =============================================================================
// INTERNAL PLANE — Service-to-service APIs (/api/internal/*)
// Called by workflow-engine and other internal services. Not externally exposed.
// =============================================================================
import internalToolsRouter from './routes/internal-tools.js';
import internalChatRouter from './routes/internal-chat.js';
import internalMemoryRouter from './routes/internal-memory.js';
import { requireServiceAuth } from './middleware/internal-service-auth.js';
import { registerInternalMcpRoutes } from './routes/internal-mcp.js';
import { getRuntimeMcpProvider } from './services/mcp/runtime-mcp-provider.js';
app.use('/api/internal/tools', requireServiceAuth, internalToolsRouter);
app.use('/api/internal/chat', requireServiceAuth, internalChatRouter);
app.use('/api/internal/memory', requireServiceAuth, internalMemoryRouter);

// Cluster-internal MCP cache-bust hook for Studio after mcp_server_ops writes.
// Gated by `requireServiceAuth` so callers must present a valid service token
// whose `tenantId` / `projectId` claims match the request body — same posture
// as `/api/internal/tools` and `/api/internal/memory`. Network-only gating is
// not enough: any in-cluster pod could otherwise spam cross-tenant cache
// invalidation. The route handler additionally requires a `projectId` claim
// on the token via `rejectIfTokenMismatch` (defense-in-depth).
const internalMcpRouter: Router = Router();
internalMcpRouter.use(requireServiceAuth);
registerInternalMcpRoutes(internalMcpRouter, getRuntimeMcpProvider());
app.use('/api/internal/mcp', internalMcpRouter);

// Workflow async callback endpoint — delegating router registered now (before 404),
// actual handler wired in startServer() after Redis is available
import { WorkflowCallbackHandler } from './services/workflow/workflow-callback-handler.js';
import { createInternalCallbacksRouter } from './routes/internal-callbacks.js';
import { getInternalConnectionManager } from './websocket/handler.js';
import { getSdkConnectionManager } from './websocket/sdk-handler.js';

let _workflowCallbackRouter: Router | null = null;
app.use('/api/internal/workflow-callback', (req, res, next) => {
  if (_workflowCallbackRouter) {
    _workflowCallbackRouter(req, res, next);
  } else {
    res.status(503).json({
      success: false,
      error: { code: 'SERVICE_UNAVAILABLE', message: 'Callback endpoint not yet initialized' },
    });
  }
});

// =============================================================================
// CONTROL PLANE — Project Management (/api/projects/:pid/*)
// Developer-facing project configuration and observability.
// =============================================================================

// Layer 2: Project-scoped encryption context — override environment from deployment context
const VALID_ENVIRONMENT_RE = /^[a-zA-Z0-9_-]{1,64}$/;
app.use('/api/projects/:projectId', (req, _res, next) => {
  // Read environment from query param, body, or default to '_shared'
  const raw =
    (req.query.environment as string) || (req.body?.environment as string | undefined) || '_shared';
  // Sanitize: only allow safe characters to prevent arbitrary DEK scope creation
  const env = VALID_ENVIRONMENT_RE.test(raw) ? raw : '_shared';
  runWithEncryptionContext({ environment: env }, () => next());
});

app.use('/api/projects/:projectId', projectsRouter);
app.use('/api/projects/:projectId/sessions', sessionsRouter);
app.use('/api/projects/:projectId/traces', tracesRouter);
app.use('/api/projects/:projectId/sessions/:sessionId/attachments', attachmentsRouter);
app.use('/api/projects/:projectId/agents', projectAgentsRouter);
app.use('/api/projects/:projectId/agents/:agentName/versions', versionsRouter);
app.use('/api/projects/:projectId/agents/:agentName/model-config', agentModelConfigRouter);
app.use('/api/projects/:projectId/llm-config', projectLLMConfigRouter);
app.use('/api/projects/:projectId/settings', projectSettingsRouter);
app.use('/api/projects/:projectId/runtime-config', projectRuntimeConfigRouter);
app.use('/api/projects/:projectId/runtime/simulate', simulateRouter);
app.use('/api/projects/:projectId/session-lifecycle', projectSessionLifecycleRouter);
app.use('/api/projects/:projectId/billing', projectBillingRouter);
app.use('/api/projects/:projectId/deployments', deploymentsRouter);
app.use('/api/projects/:projectId/diagnostics', diagnosticsRouter);
app.use('/api/projects/:projectId/validate', validateRouter);
app.use('/api/projects/:projectId/env-vars', environmentVariablesRouter);
app.use('/api/projects/:projectId/sdk-channels', sdkChannelsRouter);
app.use('/api/projects/:projectId/sdk-public-keys', sdkPublicKeysRouter);
app.use('/api/projects/:projectId/sdk-jwe-capability', sdkJweCapabilityRouter);
app.use('/api/projects/:projectId/sdk-token-diagnostics', sdkTokenDiagnosticsRouter);
app.use('/api/projects/:projectId/channel-connections', channelConnectionsRouter);
app.use('/api/projects/:projectId/connections', connectionsRouter);
app.use('/api/projects/:projectId/prompt-library', promptLibraryRouter);
app.use('/api/projects/:projectId/external-agents', externalAgentRouter);
app.use('/api/projects/:projectId/workflows', workflowsRouter);
app.use('/api/projects/:projectId/workflows/:workflowId/versions', workflowVersionsRouter);
// Workflow engine proxy — execution, approval, trigger, and connector routes
// forwarded to the workflow-engine service. Mounted AFTER CRUD router so
// design-time routes match first.
app.use(
  '/api/projects/:projectId/workflows',
  tenantAuthMiddleware,
  createWorkflowEngineProxy({
    syncExecution: () => syncExecutionService,
  }),
);
// Human-in-the-loop unified inbox
import { createHumanTaskRouter } from './routes/human-tasks.js';

app.use(
  '/api/projects/:projectId/human-tasks',
  tenantAuthMiddleware,
  createHumanTaskRouter({
    resolveApproval: async (executionId, stepId, decision, ctx) => {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (ctx.authHeader) headers['Authorization'] = ctx.authHeader;
      const resp = await fetch(
        `${workflowEngineBaseUrl}/api/v1/projects/${encodeURIComponent(ctx.projectId)}/approvals/${encodeURIComponent(ctx.workflowId ?? executionId)}/executions/${encodeURIComponent(executionId)}/steps/${encodeURIComponent(stepId)}/approve`,
        {
          method: 'POST',
          headers,
          body: JSON.stringify({
            decision: decision.approved ? 'approve' : 'reject',
            reason: decision.reason,
          }),
          signal: AbortSignal.timeout(10_000),
        },
      );
      if (!resp.ok) {
        throw new Error(`Workflow engine resolveApproval failed (${resp.status})`);
      }
    },
    resolveHumanTask: async (executionId, stepId, response, ctx) => {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (ctx.authHeader) headers['Authorization'] = ctx.authHeader;
      const resp = await fetch(
        `${workflowEngineBaseUrl}/api/v1/projects/${encodeURIComponent(ctx.projectId)}/human-tasks/executions/${encodeURIComponent(executionId)}/steps/${encodeURIComponent(stepId)}/resolve`,
        {
          method: 'POST',
          headers,
          body: JSON.stringify(response),
          signal: AbortSignal.timeout(10_000),
        },
      );
      if (!resp.ok) {
        throw new Error(`Workflow engine resolveHumanTask failed (${resp.status})`);
      }
    },
    resolveEscalation: async (sessionId, data, ctx) => {
      const locator = buildProductionSessionLocator({
        tenantId: ctx.tenantId,
        projectId: ctx.projectId,
        sessionId,
      });
      return getRuntimeExecutor().resolveEscalation(
        sessionId,
        data,
        locator ? { locator } : undefined,
      );
    },
    // Late-binding hook: the hybrid reader is constructed inside
    // startServer() after CH is ready (LLD §5.3). Until then this returns
    // null and the route falls back to the direct HumanTask Mongo query.
    workflowHybridReader: () =>
      workflowHybridHumanTaskReader as unknown as ReturnType<
        NonNullable<Parameters<typeof createHumanTaskRouter>[0]['workflowHybridReader']>
      > | null,
  }),
);
app.use('/api/projects/:projectId/guardrail-policies', guardrailPoliciesRouter);
app.use('/api/guardrail-policies', guardrailPoliciesRouter);
app.use('/api/projects/:projectId/pii-patterns', piiPatternsRouter);
app.use('/api/projects/:projectId/pii-entities', piiEntitiesRouter);
app.use('/api/projects/:projectId/project-io', projectIORouter);
app.use('/api/projects/:projectId/lookup-tables', lookupDataRouter);
app.use('/api/projects/:projectId/omnichannel', omnichannelRouter);
app.use('/api/projects/:projectId/attachment-config', attachmentConfigRouter);
app.use('/api/projects/:projectId/namespaces', variableNamespacesRouter);
app.use(
  '/api/projects/:projectId/variable-namespaces/:variableNamespaceId/members',
  variableNamespaceMembersRouter,
);
app.use('/api/projects/:projectId/evaluation-tags', evaluationTagsRouter);
app.use('/api/projects/:projectId/environments', projectEnvironmentsRouter);
app.use('/api/projects/:projectId/agent-assist-bindings', projectAgentAssistBindingsRouter);

// =============================================================================
// CONTROL PLANE — Analytics & Observability (/api/projects/:pid/*)
// Developer analytics dashboards and event pipelines.
// =============================================================================
app.use('/api/projects/:projectId/analytics', analyticsRouter);
app.use('/api/projects/:projectId/voice-analytics', voiceAnalyticsRouter);
app.use('/api/projects/:projectId/pipeline-analytics', pipelineAnalyticsRouter);
const { default: governanceRouter } = await import('./routes/governance.js');
app.use('/api/projects/:projectId/governance', governanceRouter);
app.use('/api/projects/:projectId/pipeline-observability', pipelineObservabilityRouter);
app.use('/api/projects/:projectId/pipeline-config', pipelineConfigRouter);
app.use('/api/projects/:projectId/pipelines', pipelineManagementRouter);
app.use('/api/projects/:projectId/custom-events', customEventsRouter);
app.use('/api/projects/:projectId/external-events', externalEventsRouter);
app.use('/api/projects/:projectId/tags', tagsRouter);
app.use('/api/projects/:projectId/alerts', alertsRouter);
app.use('/api/projects/:projectId/experiments', experimentsRouter);
app.use('/api/projects/:projectId/roi', roiRouter);
app.use('/api/projects/:projectId/nl-analytics', nlAnalyticsRouter);
app.use('/api/projects/:projectId/insights', insightsRouter);
app.use('/api/projects/:projectId/feedback', feedbackListRouter);

// =============================================================================
// CONTROL PLANE — Tenant Administration (/api/tenants/:tid/*)
// Tenant-scoped configuration, billing, and usage.
// =============================================================================
const tenantRouter = express.Router({ mergeParams: true });
tenantRouter.use(tenantAuthMiddleware);
tenantRouter.use(requireTenantMatch);
tenantRouter.use('/models', tenantModelsRouter);
tenantRouter.use('/usage', tenantUsageRouter);
tenantRouter.use('/alerts', alertConfigRouter);
tenantRouter.use('/llm-policy', tenantLLMPolicyRouter);
tenantRouter.use('/model-resolution-cache', tenantModelResolutionCacheRouter);
tenantRouter.use('/service-instances', tenantServiceInstancesRouter);
tenantRouter.use('/kms', kmsAdminRouter);
tenantRouter.use('/guardrail-providers', guardrailProvidersRouter);
tenantRouter.use('/billing', workspaceBillingRouter);
tenantRouter.use('/sdk-channels', tenantSdkChannelsRouter);
app.use('/api/tenants/:tenantId', tenantRouter);

// =============================================================================
// CONTROL PLANE — Platform Admin (/api/platform/admin/*)
// Super-admin operations.
// =============================================================================
app.use('/api/platform/admin/tenant-models', platformAdminModelsRouter);
app.use('/api/platform/admin/tenant-config', platformAdminConfigRouter);
app.use('/api/platform/admin/billing-policy', platformAdminBillingPolicyRouter);
app.use('/api/platform/admin/tenants', platformAdminTenantsRouter);
app.use('/api/platform/admin/deals', platformAdminDealsRouter);
app.use('/api/platform/admin/system-health', platformAdminHealthRouter);
app.use('/api/platform/admin/usage-summary', platformAdminUsageRouter);
app.use('/api/platform/admin/features', platformAdminFeaturesRouter);
app.use('/api/platform/admin/hubspot', platformAdminHubspotRouter);
app.use('/api/platform/admin/resilience', platformAdminResilienceRouter);
app.use('/api/platform/admin/tenant-attachment-config', platformAdminAttachmentConfigRouter);
app.use('/api/platform/admin/traces', platformAdminTracesRouter);
app.use('/api/platform/admin/agent-assist', platformAdminAgentAssistRouter);

// =============================================================================
// CONTROL PLANE — Auth & Shared Utilities
// Cross-cutting auth and utility endpoints.
// =============================================================================
app.use('/api/auth', authRouter);
app.use('/api/auth/device', deviceAuthRouter);
app.use('/api/admin/runtime/sessions', adminSessionsRouter);
app.use('/api/admin/clickhouse', clickhouseDiagnosticsRouter);
app.use('/api/agents', agentsRouter);
app.use('/api/contacts', contactsRouter);
app.use('/api/model-catalog', modelCatalogRouter);
app.use('/api/model-capabilities', modelCapabilitiesRouter);
app.use('/api/crawler', crawlerProfileRouter);
app.use('/api/tool-secrets', toolSecretsRouter);
app.use('/api/proxy-configs', proxyConfigRouter);
app.use('/api/auth-profiles', authProfilesRouter);

// --- Sandbox Memory API (callback from gvisor pods) ----------------------
app.use(memoryApiRouter);
// --- A2A Protocol (Full Async Support) ------------------------------------
{
  const a2aLog = createLogger('a2a');
  const resolveA2AInteractionContextInput = (context: A2ARequestContext) => {
    const explicitResult = normalizeInteractionContextInput(context.interactionContext, 'strict');
    if (!explicitResult.success) {
      const issueSummary = explicitResult.error.issues.join('; ');
      throw new Error(
        issueSummary
          ? `Invalid A2A interaction context: ${issueSummary}`
          : 'Invalid A2A interaction context',
      );
    }

    const legacyClientInfoResult = extractLegacyClientInfoInteractionContext(context.metadata);
    return mergeInteractionContextInputs(
      legacyClientInfoResult.success ? legacyClientInfoResult.data : undefined,
      explicitResult.data,
    );
  };

  const buildA2AExecutionOptions = (
    sessionId: string,
    message: string,
    context: A2ARequestContext,
  ) => {
    const metadataResult = normalizeSdkMessageMetadata(context.messageMetadata);
    if (!metadataResult.success) {
      const issueSummary = metadataResult.error.issues.join('; ');
      throw new Error(
        issueSummary
          ? `Invalid A2A message metadata: ${issueSummary}`
          : 'Invalid A2A message metadata',
      );
    }

    if (context.metadata) {
      validateSessionMetadataSize(context.metadata);
    }

    const interactionContext = resolveA2AInteractionContextInput(context);

    return {
      ...(context.attachmentIds ? { attachmentIds: context.attachmentIds } : {}),
      ...(metadataResult.data ? { messageMetadata: metadataResult.data } : {}),
      ...(interactionContext ? { interactionContext } : {}),
      ...(context.metadata ? { sessionMetadata: context.metadata } : {}),
      sessionLocator:
        buildProductionSessionLocator({
          tenantId: context.tenantId,
          projectId: context.projectId,
          sessionId,
        }) ?? undefined,
      channelMetadata: { channel: 'a2a' as const, contentLength: message.length },
    };
  };

  const executionPort: AgentExecutionPort = {
    async executeMessage(sessionId: string, message: string, context: A2ARequestContext) {
      a2aLog.debug('executeMessage', {
        sessionId,
        tenantId: context.tenantId,
        projectId: context.projectId,
      });
      const executor = getRuntimeExecutor();
      return executor.executeMessage(
        sessionId,
        message,
        undefined,
        undefined,
        buildA2AExecutionOptions(sessionId, message, context),
      );
    },

    async executeMessageStreaming(sessionId, message, onChunk, onTraceEvent, context) {
      const execOptions = buildA2AExecutionOptions(sessionId, message, context);
      // Route through ExecutionCoordinator for proper dedup/concurrency/queueing
      if (isCoordinatorAvailable()) {
        const coordinator = getExecutionCoordinator();
        const execution = await coordinator.submit(sessionId, message, {
          tenantId: context!.tenantId,
          onChunk,
          onTraceEvent,
          ...execOptions,
        });
        const execResult = execution.resultData as
          | { response: string; action?: { type: string; [key: string]: unknown } }
          | undefined;
        return execResult ?? { response: execution.response || '' };
      }
      // Fallback: direct executor call with streaming callbacks
      const executor = getRuntimeExecutor();
      return executor.executeMessage(sessionId, message, onChunk, onTraceEvent, execOptions);
    },

    getSessionDetail(sessionId: string) {
      const executor = getRuntimeExecutor();
      return executor.getSessionDetail(sessionId);
    },

    async createSession(context: A2ARequestContext): Promise<string> {
      const { createRuntimeSession } = await import('./channels/pipeline/session-factory.js');
      const interactionContext = resolveA2AInteractionContextInput(context);
      const sessionId = randomUUID();
      const scope = buildRequiredServicePrincipalProductionExecutionScope({
        tenantId: context.tenantId,
        projectId: context.projectId,
        sessionId,
        channelId: context.connectionId,
        environment: context.environment ?? (context.deploymentId ? 'unknown' : 'dev'),
        source: 'a2a',
        authType: 'a2a_connection',
        traceId: getCurrentTraceId() ?? randomUUID(),
        principalType: 'integration',
        principalId: context.connectionId,
        callerContext: {
          connectionId: context.connectionId,
          deploymentId: context.deploymentId,
          environment: context.environment,
        },
      });
      const result = await createRuntimeSession({
        tenantId: context.tenantId,
        projectId: context.projectId,
        channelType: 'a2a',
        deploymentId: context.deploymentId,
        environment: context.environment,
        ...(interactionContext ? { interactionContext } : {}),
        metadata: context.metadata,
        sessionId,
        scope,
      });
      return result.runtimeSession.id;
    },
  };

  const tracingPort: A2ATracingPort = {
    traceInbound(params) {
      a2aLog.info('A2A inbound', params);
    },
    traceOutbound(params) {
      a2aLog.info('A2A outbound', params);
    },
  };

  // Agent Card — declares all implemented A2A capabilities
  const agentCard: AgentCard = {
    name: 'Agent Runtime',
    description: 'ABL Agent Runtime — multi-turn, streaming, async A2A agent',
    url: '/a2a',
    version: '2.0.0',
    protocolVersion: '0.2.1',
    capabilities: {
      streaming: true,
      pushNotifications: true,
      stateTransitionHistory: true,
    },
    defaultInputModes: ['text'],
    defaultOutputModes: ['text'],
    skills: [
      {
        id: 'general',
        name: 'General Agent Execution',
        description: 'Execute any configured agent with multi-turn conversation support',
        tags: ['agent', 'multi-turn', 'a2a'],
      },
    ],
  };

  // LazyTaskStore starts with InMemory, upgrades to Redis in wireAsyncInfra()
  const lazyTaskStore = new LazyTaskStore();
  const memorySessionResolver = new MemoryA2ASessionResolver();
  const attachmentIngestor = createA2AAttachmentIngestor();

  const a2aHandlers = createA2AExpressHandlers({
    agentCard,
    agentName: 'runtime',
    executionPort,
    tracing: tracingPort,
    taskStore: lazyTaskStore,
    baseUrl: '/a2a',
    sessionResolver: memorySessionResolver,
    attachmentIngestor,
    getConnection: async (connectionId: string) => {
      const { ChannelConnection } = await import('@agent-platform/database/models');
      const conn = await ChannelConnection.findOne({
        _id: connectionId,
        channelType: 'a2a',
      });
      if (!conn) return null;

      // Decrypt inbound API key from config.encryptedA2aApiKey if available
      let inboundApiKey: string | null = null;
      const connConfig =
        typeof conn.config === 'string' ? JSON.parse(conn.config || '{}') : (conn.config ?? {});
      if (connConfig.encryptedA2aApiKey) {
        if (!isTenantEncryptionReady()) {
          throw new Error('Tenant DEK encryption is not initialized for A2A connection auth');
        }
        try {
          inboundApiKey = await decryptForTenantAuto(
            connConfig.encryptedA2aApiKey as string,
            conn.tenantId,
          );
        } catch (err) {
          a2aLog.error('Failed to decrypt A2A API key', {
            connectionId,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }

      return {
        _id: String(conn._id),
        tenantId: conn.tenantId,
        projectId: conn.projectId,
        deploymentId: conn.deploymentId ?? null,
        environment: conn.environment ?? null,
        status: conn.status,
        inboundApiKey,
      };
    },
    agentCardProvider: async (_context) => {
      return agentCard;
    },
  });

  // Mount callback routes before connection-scoped /a2a/:connectionId routes.
  // Otherwise Express will treat "callbacks" as a connection id and async
  // push notifications will never reach the callback handler.
  const callbackRouter = Router();
  const a2aCallbackRouter = Router();
  callbackRouter.all('/:callbackId', (_req, res) =>
    res.status(503).json({ error: 'Async infrastructure not ready' }),
  );
  a2aCallbackRouter.all('/:callbackId', (_req, res) =>
    res.status(503).json({ error: 'Async infrastructure not ready' }),
  );
  app.use('/api/v1/callbacks', callbackRouter);
  app.use('/a2a/callbacks', a2aCallbackRouter);
  (app as any)._callbackRouter = callbackRouter;
  (app as any)._a2aCallbackRouter = a2aCallbackRouter;

  a2aHandlers.setupRoutes(app);

  // --- Async Infrastructure (initialized lazily when Redis available) ------
  // The async infra (callback registry, barrier store, channel dispatcher,
  // callback routes) is only wired when Redis is available. Without Redis,
  // the runtime operates in sync-only mode (no push notifications, no
  // async tools, no fan-out barriers).
  const asyncInfraLog = createLogger('async-infra');

  // Export a singleton WebSocket connection registry for use by WS handlers
  const wsConnectionRegistry = new WebSocketConnectionRegistry();
  (app as any)._wsConnectionRegistry = wsConnectionRegistry;

  const buildCallbackBaseUrl = (config: ReturnType<typeof getConfig>) => {
    const runtimePublicBaseUrl = process.env.RUNTIME_PUBLIC_BASE_URL?.replace(/\/+$/, '');
    return (
      (config as any).callbackBaseUrl ||
      process.env.CALLBACK_BASE_URL ||
      (runtimePublicBaseUrl
        ? `${runtimePublicBaseUrl}/a2a/callbacks`
        : `http://localhost:${config.server?.port || 3112}/a2a/callbacks`)
    );
  };

  const replaceAsyncCallbackRouters = (deps: {
    callbackRegistry: import('@agent-platform/execution').CallbackRegistry;
    suspensionStore: import('@agent-platform/execution').SuspensionStore;
    resumptionQueue: { add(name: string, data: unknown): Promise<void> };
  }) => {
    const realA2ARouter = createA2ACallbackRouter({
      callbackRegistry: deps.callbackRegistry as any,
      resumptionQueue: deps.resumptionQueue,
      tracing: tracingPort,
      suspensionLookup: deps.suspensionStore as any,
    });
    (app as any)._a2aCallbackRouter.stack.length = 0;
    (app as any)._a2aCallbackRouter.use('/', realA2ARouter);

    const realCallbackRouter = createCallbackRouter({
      callbackRegistry: deps.callbackRegistry,
      suspensionStore: deps.suspensionStore as any,
      resumptionQueue: deps.resumptionQueue,
      decryptSecret: (encrypted, tenantId) => decryptForTenantAuto(encrypted, tenantId),
    });
    (app as any)._callbackRouter.stack.length = 0;
    (app as any)._callbackRouter.use('/', realCallbackRouter);
  };

  // Attempt to wire async infrastructure after config is loaded
  const wireAsyncInfra = async () => {
    try {
      const { isConfigLoaded, getConfig } = await import('./config/loader.js');
      if (!isConfigLoaded()) return;
      const config = getConfig();
      const allowInMemoryAsyncInfra = process.env.ALLOW_INMEMORY_ASYNC_INFRA === 'true';
      if ((!config.redis?.enabled || !config.redis?.url) && !allowInMemoryAsyncInfra) {
        asyncInfraLog.info('Async infrastructure skipped — Redis not available');
        return;
      }

      const callbackBaseUrl = buildCallbackBaseUrl(config);
      const { ResumptionService } = await import('./services/execution/resumption-service.js');

      if (!config.redis?.enabled || !config.redis?.url) {
        const { MemorySuspensionStore } =
          await import('./services/execution/memory-suspension-store.js');
        const callbackRegistry = new InMemoryCallbackRegistry();
        const barrierStore = new InMemoryFanOutBarrierStore();
        const pendingDeliveryStore = new PendingDeliveryStore(
          new InMemoryPendingDeliveryRedisClient(),
        );
        const suspensionStore = new MemorySuspensionStore();
        const channelDispatcher = new ChannelDispatcher({
          wsRegistry: wsConnectionRegistry,
          messagePersister: {
            persistMessage: async (
              dbSessionId,
              role,
              content,
              channelType,
              tenantId,
              projectId,
              structuredContent,
              metadata,
            ) =>
              persistMessage(
                dbSessionId,
                role,
                content,
                channelType,
                tenantId,
                undefined,
                undefined,
                projectId,
                undefined,
                structuredContent,
                metadata,
              ),
          },
          pendingDeliveryStore,
        });
        const resumeBridge = new InlineResumeDispatcher();

        const resumptionService = new ResumptionService({
          suspensionStore,
          callbackRegistry,
          barrierStore,
          channelDispatcher,
          executor: getRuntimeExecutor() as any,
          resumeDispatcher: resumeBridge,
          lockManager: new InMemoryLockPort(),
        });
        resumeBridge.bind((suspensionId, data) => resumptionService.resume(suspensionId, data));

        replaceAsyncCallbackRouters({
          callbackRegistry,
          suspensionStore,
          resumptionQueue: resumeBridge,
        });

        (app as any)._asyncInfra = {
          callbackRegistry,
          barrierStore,
          pendingDeliveryStore,
          channelDispatcher,
          suspensionStore,
          callbackBaseUrl,
        };

        getRuntimeExecutor().setAsyncInfra({
          callbackRegistry,
          suspensionStore,
          callbackBaseUrl,
          barrierStore,
        });

        setDebugConnectionRegistry(wsConnectionRegistry);
        setSdkConnectionRegistry(wsConnectionRegistry);

        try {
          const { startSuspensionTimeoutWorker } =
            await import('./services/queues/suspension-timeout-worker.js');
          startSuspensionTimeoutWorker({
            suspensionStore,
            callbackRegistry,
            barrierStore,
            resumeDispatcher: resumeBridge,
          });
          asyncInfraLog.info('Suspension timeout worker started (in-memory)');
        } catch (timeoutErr) {
          asyncInfraLog.warn('Failed to start in-memory suspension timeout worker', {
            error: timeoutErr instanceof Error ? timeoutErr.message : String(timeoutErr),
          });
        }

        asyncInfraLog.warn('Async infrastructure initialized in-memory (test/dev only)', {
          callbackBaseUrl,
        });
        return;
      }

      const redisHandle = getRedisHandle();
      if (!redisHandle) {
        asyncInfraLog.warn('Redis handle not available — A2A infra skipped');
        return;
      }
      const redisClient = redisHandle.client;

      const callbackRegistry = new RedisCallbackRegistry(redisClient);
      const barrierStore = new RedisFanOutBarrierStore(redisClient);
      // PendingDeliveryRedisClient / A2ARedisClient have simplified structural signatures
      // that ioredis Redis/Cluster satisfies at runtime but not statically (overloads).
      const pendingDeliveryStore = new PendingDeliveryStore(
        redisClient as unknown as PendingDeliveryRedisClient,
      );
      const a2aTaskStore = new RedisA2ATaskStore(
        redisClient as unknown as A2ARedisClient,
        process.env.DEFAULT_TENANT_ID || 'system',
      );

      lazyTaskStore.upgrade(a2aTaskStore, (info) => asyncInfraLog.info(info.message));
      asyncInfraLog.info('A2A TaskStore upgraded to Redis');

      const pushNotificationService = new PushNotificationDeliveryService(
        new SsrfEndpointValidator(),
        tracingPort,
      );
      const channelDispatcher = new ChannelDispatcher({
        wsRegistry: wsConnectionRegistry,
        pushNotificationSender: pushNotificationService,
        messagePersister: {
          persistMessage: async (
            dbSessionId,
            role,
            content,
            channelType,
            tenantId,
            projectId,
            structuredContent,
            metadata,
          ) =>
            persistMessage(
              dbSessionId,
              role,
              content,
              channelType,
              tenantId,
              undefined,
              undefined,
              projectId,
              undefined,
              structuredContent,
              metadata,
            ),
        },
        pendingDeliveryStore,
        redisPubSub: redisClient,
      });

      let suspensionStore: import('@agent-platform/execution').SuspensionStore;
      try {
        const { MongoSuspensionStore } =
          await import('./services/execution/mongo-suspension-store.js');
        suspensionStore = new MongoSuspensionStore();
        asyncInfraLog.info('Using MongoDB-backed SuspensionStore');
      } catch {
        const { MemorySuspensionStore } =
          await import('./services/execution/memory-suspension-store.js');
        suspensionStore = new MemorySuspensionStore();
        asyncInfraLog.warn(
          'MongoDB SuspensionStore unavailable, falling back to in-memory (not production-safe)',
        );
      }

      const bullmq = await import('bullmq');
      const redisMode =
        redisHandle.client.constructor.name === 'Cluster' ? 'cluster' : 'standalone';
      asyncInfraLog.info('BullMQ connection pair created', {
        mode: redisMode,
        queueConnectionType: redisMode,
      });
      const resumptionPair = createBullMQPair(redisHandle);
      const resumptionPrefix = getBullMQPrefix(redisHandle, { standalonePrefix: '{bull}' });
      asyncInfraLog.info('BullMQ prefix resolved', {
        queue: 'execution-resume',
        prefix: resumptionPrefix,
        mode: redisMode,
      });
      const resumptionQueue = new bullmq.Queue('execution-resume', {
        connection: resumptionPair.queueConnection,
        prefix: resumptionPrefix,
        defaultJobOptions: {
          removeOnComplete: { count: 1000, age: 86400 },
          removeOnFail: { count: 500, age: 604800 },
        },
      });
      const resumeDispatcher = {
        enqueueResume: async (suspensionId: string, data: unknown) => {
          await resumptionQueue.add('resume', {
            suspensionId,
            ...(data as Record<string, unknown>),
          });
        },
      };

      replaceAsyncCallbackRouters({
        callbackRegistry,
        suspensionStore,
        resumptionQueue: {
          add: async (name: string, data: unknown) => {
            await resumptionQueue.add(name, data);
          },
        },
      });

      (app as any)._asyncInfra = {
        callbackRegistry,
        barrierStore,
        pendingDeliveryStore,
        a2aTaskStore,
        channelDispatcher,
        pushNotificationService,
        suspensionStore,
        callbackBaseUrl,
      };

      getRuntimeExecutor().setAsyncInfra({
        callbackRegistry,
        suspensionStore,
        callbackBaseUrl,
        barrierStore,
      });

      try {
        const { ensureSessionService } = await import('./services/session/session-service.js');
        await ensureSessionService({ store: 'redis' });
        asyncInfraLog.info('Session store upgraded to Redis');
      } catch (sessErr) {
        asyncInfraLog.warn('Failed to upgrade session store to Redis', {
          error: sessErr instanceof Error ? sessErr.message : String(sessErr),
        });
      }

      setDebugConnectionRegistry(wsConnectionRegistry);
      setSdkConnectionRegistry(wsConnectionRegistry);
      setRedisPubSub(redisClient);

      const { DistributedLockManager } = await import('@agent-platform/shared');
      const lockManager = new DistributedLockManager(redisClient);

      const resumptionService = new ResumptionService({
        suspensionStore,
        callbackRegistry,
        barrierStore,
        channelDispatcher,
        executor: getRuntimeExecutor() as any,
        resumeDispatcher,
        lockManager: {
          acquire: async (key: string, options: any) => {
            const lock = await lockManager.acquire(key, options);
            return lock ? { key: lock.key, owner: lock.value } : null;
          },
          release: async (lock: any) => {
            await lockManager.release({ key: lock.key, value: lock.owner, expiresAt: new Date() });
          },
          extend: (lock: any, ttlMs: number) =>
            lockManager.extend({ key: lock.key, value: lock.owner, expiresAt: new Date() }, ttlMs),
        },
      });

      try {
        const { startResumptionWorker } = await import('./services/queues/resumption-worker.js');
        await startResumptionWorker({
          resumptionService: resumptionService as any,
          workerConnection: resumptionPair.workerConnection,
        });
        asyncInfraLog.info('BullMQ resumption worker started');
      } catch (workerErr) {
        asyncInfraLog.warn('Failed to start resumption worker', {
          error: workerErr instanceof Error ? workerErr.message : String(workerErr),
        });
      }

      try {
        const { startSuspensionTimeoutWorker } =
          await import('./services/queues/suspension-timeout-worker.js');
        startSuspensionTimeoutWorker({
          suspensionStore,
          callbackRegistry,
          barrierStore,
          resumeDispatcher,
        });
        asyncInfraLog.info('Suspension timeout worker started');
      } catch (timeoutErr) {
        asyncInfraLog.warn('Failed to start suspension timeout worker', {
          error: timeoutErr instanceof Error ? timeoutErr.message : String(timeoutErr),
        });
      }

      // Agent Assist async-push callback worker
      try {
        const { createCallbackQueue, startAgentAssistCallbackWorker } =
          await import('./workers/agent-assist-callback-worker.js');
        const { executeTurn } = await import('./services/agent-assist/execution-bridge.js');
        const { buildV1Envelope } = await import('./services/agent-assist/envelope-builder.js');
        const { AGENT_ASSIST_SOURCE_TAG } = await import('./services/agent-assist/constants.js');

        const agentAssistPair = createBullMQPair(redisHandle);

        agentAssistCallbackQueue = await createCallbackQueue({
          queueConnection: agentAssistPair.queueConnection,
        });

        await startAgentAssistCallbackWorker({
          queueConnection: agentAssistPair.queueConnection,
          workerConnection: agentAssistPair.workerConnection,
          deps: {
            executeTurnAndBuildEnvelope: async (job) => {
              const {
                callerApiKeyId,
                callerUserId,
                executionInput,
                metadata,
                source,
                userReference,
              } = job.input;
              const binding = {
                appId: job.appId,
                environment: job.envName,
                tenantId: job.tenantId,
                projectId: job.projectId,
                deploymentId: job.binding.deploymentId ?? undefined,
                apiKeyId: job.binding.apiKeyId ?? undefined,
                runtimeBaseUrl: job.binding.runtimeBaseUrl ?? undefined,
                status: 'active' as const,
              };

              const result = await executeTurn({
                binding,
                input: executionInput,
                apiKeyId: callerApiKeyId,
                userId: callerUserId,
                runId: job.runId,
              });

              return buildV1Envelope({
                messageId: job.messageId,
                sessionId: result.sessionId,
                runId: result.runId,
                appId: job.appId,
                sessionReference: executionInput.sessionReference,
                userReference,
                userId: callerUserId,
                source: source ?? AGENT_ASSIST_SOURCE_TAG,
                outputText: result.responseText,
                ...(result.richContent ? { richContent: result.richContent } : {}),
                ...(result.actions ? { actions: result.actions } : {}),
                ...(result.voiceConfig ? { voiceConfig: result.voiceConfig } : {}),
                ...(result.contentEnvelope ? { contentEnvelope: result.contentEnvelope } : {}),
                metadata,
                status: 'completed',
              });
            },
          },
        });
        asyncInfraLog.info('Agent Assist callback worker started');
      } catch (compatWorkerErr) {
        asyncInfraLog.warn('Failed to start Agent Assist callback worker', {
          error:
            compatWorkerErr instanceof Error ? compatWorkerErr.message : String(compatWorkerErr),
        });
      }

      asyncInfraLog.info('Async infrastructure initialized', { callbackBaseUrl });
    } catch (err) {
      asyncInfraLog.warn('Failed to initialize async infrastructure', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  };

  // Wire async infra after a tick to allow config to load
  setTimeout(wireAsyncInfra, 0);
}

// OpenAPI/Swagger docs
app.use(
  '/docs',
  requireInternalNetworkAccess,
  serveOpenAPIDocs(runtimeRegistry, {
    title: 'ABL Runtime API',
    version: '1.0.0',
    description: 'ABL Platform Runtime API - Agent execution, chat, voice, and SDK endpoints',
  }),
);

// Auto-discover any routes not explicitly registered with OpenAPI schemas
// This provides immediate visibility of all endpoints (with auto-derived tags)
// while detailed schemas are added incrementally
introspectExpressRoutes(app, runtimeRegistry);

// Late-bound test-diagnostic router mount — the real router is created inside
// `startServer()` once ClickHouse + the workflow consumer are ready, but we
// must reserve the route path BEFORE the catch-all 404 handler below (Express
// matches middleware in registration order). See `startServer()` near the end
// of this file for where `setWorkflowTestDiagnosticRouter` is called.
let workflowTestDiagnosticRouter: Router | null = null;
app.use('/api/admin/test', (req, res, next) => {
  if (workflowTestDiagnosticRouter) {
    return workflowTestDiagnosticRouter(req, res, next);
  }
  return next();
});
function setWorkflowTestDiagnosticRouter(router: Router): void {
  workflowTestDiagnosticRouter = router;
}

// 404 handler - skip WebSocket paths
app.use((req, res, next) => {
  // Let WebSocket upgrades pass through
  if (req.headers.upgrade === 'websocket') {
    return next();
  }
  res.status(404).json({ error: 'Not found' });
});

// Error handler
const serverLog = createLogger('runtime-server');
app.use(
  createExpressErrorHandler({
    logError: (error, _req, normalized) => {
      serverLog.error('Server error', {
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
        statusCode: normalized.statusCode,
        code: normalized.code,
      });
    },
  }),
);

// =============================================================================
// HTTP + WEBSOCKET SERVER
// =============================================================================

const server = createServer(app);

// Internal debug/test WebSocket — enforce maxPayload to prevent oversized frames
const WS_MAX_PAYLOAD_DEFAULT = 512 * 1024; // 512 KB
const WS_MAX_PAYLOAD_TWILIO = 64 * 1024; // 64 KB (Twilio sends small mulaw chunks)

const wss = new WebSocketServer({ noServer: true, maxPayload: WS_MAX_PAYLOAD_DEFAULT });
const wssSDK = new WebSocketServer({ noServer: true, maxPayload: WS_MAX_PAYLOAD_DEFAULT });
const wssTwilioMedia = new WebSocketServer({ noServer: true, maxPayload: WS_MAX_PAYLOAD_TWILIO });
const wssAudioCodes = new WebSocketServer({ noServer: true, maxPayload: WS_MAX_PAYLOAD_DEFAULT });
const wssCustomTts = new WebSocketServer({ noServer: true, maxPayload: WS_MAX_PAYLOAD_DEFAULT });
const orpheusCustomTtsStreamingHandler = new OrpheusCustomTtsStreamingHandler();
const wssWorkflows = new WebSocketServer({ noServer: true, maxPayload: WS_MAX_PAYLOAD_DEFAULT });
let wfBridge: WfBridge | null = null;

// =============================================================================
// WEBSOCKET CONNECTION HANDLERS
// =============================================================================

const wssLog = createLogger('wss');
wss.on('connection', (ws, req) => {
  trackConnection(ws);
  handleConnection(ws, req);
});
wss.on('error', (error) => {
  wssLog.error('WebSocket server error', {
    error: error instanceof Error ? error.message : String(error),
  });
});

const wssSDKLog = createLogger('wss-sdk');
wssSDK.on('connection', (ws, req) => {
  trackConnection(ws);
  wssSDKLog.info('SDK client connected');
  handleSDKConnection(ws, req);
});
wssSDK.on('error', (error) => {
  wssSDKLog.error('SDK WebSocket server error', {
    error: error instanceof Error ? error.message : String(error),
  });
});

const wssTwilioLog = createLogger('wss-twilio');
wssTwilioMedia.on('connection', (ws, req) => {
  trackConnection(ws);
  wssTwilioLog.info('Twilio media stream connected');
  handleTwilioMediaConnection(ws, req);
});
wssTwilioMedia.on('error', (error) => {
  wssTwilioLog.error('Twilio media WebSocket error', {
    error: error instanceof Error ? error.message : String(error),
  });
});

const wssAudioCodesLog = createLogger('wss-audiocodes');
wssAudioCodes.on('connection', async (ws, request) => {
  trackConnection(ws);
  const url = new URL(request.url || '', `http://${request.headers.host}`);
  const pathParts = url.pathname.split('/');
  const identifierIdx = pathParts.indexOf('audiocodes') + 1;
  const conversationIdx = pathParts.indexOf('conversation') + 1;
  const identifier = pathParts[identifierIdx] ? decodeURIComponent(pathParts[identifierIdx]) : null;
  const conversationId = pathParts[conversationIdx]
    ? decodeURIComponent(pathParts[conversationIdx])
    : null;
  if (!identifier || !conversationId) {
    ws.close(1008, 'Missing identifier or conversationId');
    return;
  }

  // Verify auth token from query param (AudioCodes sends ?token=<token> on WS URL)
  try {
    const { resolveChannelConnection } = await import('./channels/connection-resolver.js');
    const { extractIngressToken, tokensMatch } =
      await import('@agent-platform/shared-kernel/security');
    const connection = await resolveChannelConnection('audiocodes', identifier);
    if (!connection) {
      wssAudioCodesLog.warn('AudioCodes WS: no connection found', { identifier });
      ws.close(1008, 'Channel not configured');
      return;
    }
    const acConfig = (connection.config || {}) as Record<string, unknown>;
    const acCreds = (connection.credentials || {}) as Record<string, string>;
    // Token may come from credentials (user-provided via Studio UI) or config (API/migration)
    const expectedToken =
      acCreds.inboundAuthToken?.trim() || (acConfig.inboundAuthToken as string)?.trim() || null;
    const queryToken = url.searchParams.get('token');
    const providedToken = extractIngressToken(request.headers, queryToken);

    if (expectedToken && !tokensMatch(providedToken, expectedToken)) {
      wssAudioCodesLog.warn('AudioCodes WS: token verification failed', { identifier });
      ws.close(1008, 'Unauthorized');
      return;
    }
    if (!expectedToken) {
      if (process.env.NODE_ENV === 'production') {
        wssAudioCodesLog.error('AudioCodes WS: no token configured in production', { identifier });
        ws.close(1008, 'Channel not fully configured');
        return;
      }
      wssAudioCodesLog.warn('AudioCodes WS: no token configured; allowing in non-production', {
        identifier,
      });
    }
  } catch (err) {
    wssAudioCodesLog.error('AudioCodes WS: auth check failed', {
      identifier,
      error: err instanceof Error ? err.message : String(err),
    });
    ws.close(1011, 'Internal error');
    return;
  }

  wssAudioCodesLog.info('AudioCodes WebSocket connected', { identifier, conversationId });
  registerAudioCodesWs(conversationId, ws, identifier);
});
wssAudioCodes.on('error', (error) => {
  wssAudioCodesLog.error('AudioCodes WebSocket server error', {
    error: error instanceof Error ? error.message : String(error),
  });
});

const wssCustomTtsLog = createLogger('wss-custom-tts');
wssCustomTts.on('connection', (ws, req) => {
  trackConnection(ws);
  orpheusCustomTtsStreamingHandler.handleConnection(ws, req);
});
wssCustomTts.on('error', (error) => {
  wssCustomTtsLog.error('Custom TTS WebSocket server error', {
    error: error instanceof Error ? error.message : String(error),
  });
});

const wssWorkflowsLog = createLogger('wss-workflows');
wssWorkflows.on('connection', (ws, req) => {
  const token = extractWebDebugTokenFromProtocolHeader(req.headers);
  if (!token) {
    ws.close(4001, 'Authentication required');
    return;
  }
  const claims = extractVerifiedUserTokenClaims(token);
  if (!claims || !claims.tenantId) {
    ws.close(4001, 'Invalid authentication token');
    return;
  }
  const authCtx = { tenantId: claims.tenantId, userId: claims.userId, role: claims.role };

  if (!wfBridge) {
    wfBridge = new WfBridge({
      getRedisClient,
      getRedisHandle,
      executionModel: {
        findOne: async (filter, projection) => {
          const { WorkflowExecution } = await import('@agent-platform/database/models');
          return (WorkflowExecution as any)
            .findOne(filter, projection ?? {})
            .lean() as Promise<Record<string, unknown> | null>;
        },
      },
      checkProjectAccess: async (tenantId, userId, projectId) => {
        const project = await findProjectByIdAndTenant(projectId, tenantId);
        if (project && (project as any).ownerId?.toString() === userId) return true;
        const { ProjectMember } = await import('@agent-platform/database/models');
        const member = await (ProjectMember as any).exists({ tenantId, projectId, userId }).lean();
        return member !== null;
      },
    });
    wfBridge.start();
  }

  wssWorkflowsLog.info('wf-ws.connected', { tenantId: authCtx.tenantId, userId: authCtx.userId });

  ws.on('message', (data: Buffer) => {
    wfBridge?.handleMessage(ws, authCtx, data.toString());
  });

  ws.on('close', () => {
    wfBridge?.handleClose(ws, authCtx.tenantId);
    wssWorkflowsLog.info('wf-ws.disconnected', { tenantId: authCtx.tenantId });
  });

  ws.on('error', (err: Error) => {
    wssWorkflowsLog.warn('wf-ws.socket_error', { error: err.message, tenantId: authCtx.tenantId });
  });
});
wssWorkflows.on('error', (error) => {
  wssWorkflowsLog.error('Workflow WebSocket server error', {
    error: error instanceof Error ? error.message : String(error),
  });
});

// Korevg Voice Integration Router
const config = getConfigLazy();
export const korevgRouter = new KorevgRouter({
  baseUrl: config.server.frontendUrl || `http://localhost:${config.server.port}`,
});
const korevgLog = createLogger('korevg-router');
korevgLog.info('Korevg router initialized');

// Manual upgrade handling for proper path routing
function rejectWebSocketUpgrade(socket: Duplex, statusCode: number, reason: string): void {
  socket.write(
    `HTTP/1.1 ${statusCode} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`,
  );
  socket.destroy();
}

function isSdkWebSocketTokenOverBudget(request: IncomingMessage): boolean {
  const token = extractSdkTokenFromProtocolHeader(request.headers);
  if (!token) {
    return false;
  }

  const maxBytes =
    token.split('.').length === 5
      ? getRuntimeSdkTokenEnvelopeDeps().maxEncryptedSessionBytes
      : 4096;
  return Buffer.byteLength(token, 'utf8') > maxBytes;
}

server.on('upgrade', (request, socket, head) => {
  const pathname = new URL(request.url || '', `http://${request.headers.host}`).pathname;

  if (pathname === '/ws/sdk') {
    if (isSdkWebSocketTokenOverBudget(request)) {
      rejectWebSocketUpgrade(socket, 431, 'Request Header Fields Too Large');
      return;
    }
    wssSDK.handleUpgrade(request, socket, head, (ws) => {
      wssSDK.emit('connection', ws, request);
    });
  } else if (pathname === '/ws') {
    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit('connection', ws, request);
    });
  } else if (pathname === '/voice/media') {
    wssTwilioMedia.handleUpgrade(request, socket, head, (ws) => {
      wssTwilioMedia.emit('connection', ws, request);
    });
  } else if (pathname.startsWith('/ws/audiocodes/')) {
    wssAudioCodes.handleUpgrade(request, socket, head, (ws) => {
      wssAudioCodes.emit('connection', ws, request);
    });
  } else if (pathname === '/ws/custom-tts/orpheus') {
    wssCustomTts.handleUpgrade(request, socket, head, (ws) => {
      wssCustomTts.emit('connection', ws, request);
    });
  } else if (pathname === '/ws/workflows') {
    wssWorkflows.handleUpgrade(request, socket, head, (ws) => {
      wssWorkflows.emit('connection', ws, request);
    });
  } else if (pathname.startsWith('/ws/korevg/')) {
    korevgRouter.handleUpgrade(request, socket, head);
  } else {
    socket.destroy();
  }
});

// =============================================================================
// EXPORTS
// =============================================================================

export async function startServer(): Promise<void> {
  const config = getConfigLazy();
  const port = config.server.port;
  const host = config.server.host;
  const encMasterKey =
    process.env.ENCRYPTION_ENABLED !== 'false' ? process.env.ENCRYPTION_MASTER_KEY : undefined;
  if (!encMasterKey) {
    throw new Error('ENCRYPTION_MASTER_KEY is required for runtime startup');
  }
  let dek: DEKFacadeInitResult | null = null;

  // ─── Database Initialization (MongoDB) ──────────────────────────────────
  try {
    await initMongoBackend({
      enabled: true,
      url:
        process.env.MONGODB_URL ||
        'mongodb://abl_admin:abl_dev_password@localhost:27018/abl_platform?authSource=admin&directConnection=true',
      database: process.env.MONGODB_DATABASE || 'abl_platform',
      minPoolSize: parseInt(process.env.MONGODB_MIN_POOL_SIZE || '2', 10),
      maxPoolSize: parseInt(process.env.MONGODB_MAX_POOL_SIZE || '5', 10),
      maxIdleTimeMs: 30000,
      waitQueueTimeoutMs: parseInt(process.env.MONGODB_WAIT_QUEUE_TIMEOUT_MS || '10000', 10),
      connectTimeoutMs: 10000,
      socketTimeoutMs: 45000,
      serverSelectionTimeoutMs: 10000,
      heartbeatFrequencyMs: 10000,
      tls: process.env.MONGODB_TLS === 'true',
      tlsAllowInvalidCertificates: process.env.MONGODB_TLS_ALLOW_INVALID === 'true',
      authSource: process.env.MONGODB_AUTH_SOURCE || 'admin',
      writeConcern: (process.env.MONGODB_WRITE_CONCERN as 'majority' | '1' | '0') || 'majority',
      readPreference: (process.env.MONGODB_READ_PREFERENCE as 'primary') || 'primary',
      retryWrites: true,
      retryReads: true,
      directConnection: process.env.MONGODB_DIRECT_CONNECTION === 'true',
      autoIndex: process.env.NODE_ENV !== 'production',
      slowQueryThresholdMs: parseInt(process.env.MONGODB_SLOW_QUERY_MS || '200', 10),
      appName: 'abl-runtime',
    });
    serverLog.info('MongoDB initialized');

    // Seed pipeline node type definitions (idempotent upsert)
    try {
      const { seedNodeTypes } = await import('@agent-platform/pipeline-engine');
      const seedResult = await seedNodeTypes();
      serverLog.info(`Seeded ${seedResult.count} node type definitions`);
    } catch (seedErr: unknown) {
      serverLog.warn(
        `Failed to seed node type definitions: ${seedErr instanceof Error ? seedErr.message : String(seedErr)}`,
      );
    }

    // Set the Mongoose encryption plugin master key (used by TenantModel, User, etc.)
    const { setMasterKey } = await import('@agent-platform/database/models');
    setMasterKey(encMasterKey);
    serverLog.info('Mongoose field encryption master key set');

    try {
      const { initDEKFacade, setGlobalKMSResolver } = await import('@agent-platform/database/kms');
      dek = await initDEKFacade({
        masterKeyHex: encMasterKey,
        logger: serverLog,
        tenantContextRunner: runKmsLookupInTenantContext,
      });
      setGlobalKMSResolver(dek.resolver);
      serverLog.info('Tenant DEK encryption initialized', {
        platformProvider: process.env.KMS_PROVIDER ?? 'local',
      });
    } catch (facadeError) {
      throw new Error(
        `DEK facade initialization failed: ${facadeError instanceof Error ? facadeError.message : String(facadeError)}`,
      );
    }

    // ── Model Hub: local cache invalidation wiring ────────────────────────
    const { setLocalCacheInvalidator } = await import('./services/llm/model-cache-invalidation.js');
    const { clearProviderCache } = await import('./services/llm/session-llm-client.js');
    const { clearChatResolutionCache } = await import('./services/llm/chat-resolution-service.js');
    const { getRuntimeExecutorIfInitialized } = await import('./services/runtime-executor.js');
    setLocalCacheInvalidator((tenantId?: string) => {
      clearProviderCache(tenantId);
      clearChatResolutionCache(tenantId);
      getRuntimeExecutorIfInitialized()?.clearModelResolutionCache(tenantId);
    });
    serverLog.info('Model Hub local cache invalidation wired');
  } catch (error) {
    serverLog.error('MongoDB initialization failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    throw error; // Fatal — cannot start without DB
  }

  // ─── Identity & Contact Route Wiring ─────────────────────────────────
  try {
    const { MergeSuggestion: MergeSuggestionModel, Session: SessionModel } =
      await import('@agent-platform/database/models');
    const { MergeSuggestionMongoStore } = await import('./contexts/contact/index.js');
    const {
      CompleteVerification,
      ConfigurableOAuthProviderAdapter,
      createIdentityContext,
      EmailLinkVerifier,
      GitHubOAuthAdapter,
      GoogleOAuthAdapter,
      HmacVerifier,
      MicrosoftOAuthAdapter,
      OAuthVerifier,
      OtpVerifier,
      ProviderVerifier,
      WebhookVerifier,
    } = await import('./contexts/identity/index.js');
    const { RedisVerificationTokenStore } =
      await import('./contexts/identity/infrastructure/redis-verification-token-store.js');
    const { RedisResolutionKeyStore } =
      await import('./contexts/identity/infrastructure/resolution-key-store.js');
    const { PromoteAndLink } =
      await import('./contexts/orchestration/use-cases/promote-and-link.js');
    const { createBackfillContactId } = await import('./contexts/orchestration/index.js');
    const { getAuditStore } = await import('./services/audit-store-singleton.js');
    const { getTraceStore } = await import('./services/trace-store.js');

    // Wire message scrubbing for GDPR cascade deletion
    const { DualWriteMessageStore } = await import('./services/stores/store-factory.js');
    const scrubMessages = async (tenantId: string, contactId: string) => {
      const store = getStores().message;
      if (store instanceof DualWriteMessageStore) {
        return store.scrubMessages(tenantId, contactId);
      }
      return 0;
    };

    // Wire ClickHouse contact cleanup (optional — only when CH is available)
    let clickhouseCleanup: ((tenantId: string, contactId: string) => Promise<void>) | undefined;
    if (process.env.USE_MONGO_CLICKHOUSE === 'true') {
      clickhouseCleanup = async (tenantId: string, contactId: string) => {
        const { clickhouseContactCleanup } =
          await import('./services/stores/clickhouse-message-store.js');
        const { getClickHouseClient } = await import('@agent-platform/database/clickhouse');
        await clickhouseContactCleanup(getClickHouseClient(), tenantId, contactId);
      };
    }

    const contactCtx = await initializeRuntimeContactLinking({
      scrubMessages,
      clickhouseCleanup,
      onContactAudit: emitContactLifecycleAudit,
      onAudit: async (event) => {
        serverLog.info('Contact audit event', {
          action: event.action,
          contactId: event.contactId,
        });
      },
    });

    const contactMergeRouter = createContactMergeRouter({
      executeMerge: contactCtx.executeMerge,
      selfMerge: contactCtx.selfMerge,
      cascadeDelete: contactCtx.cascadeDeleteContact,
    });
    app.use('/api/contacts/manage', contactMergeRouter);

    const mergeSuggestionStore = new MergeSuggestionMongoStore(MergeSuggestionModel);
    const mergeSuggestionsRouter = createMergeSuggestionsRouter({ store: mergeSuggestionStore });
    app.use('/api/merge-suggestions', mergeSuggestionsRouter);

    const identityHmacSecret = process.env.IDENTITY_HMAC_SECRET ?? encMasterKey;
    if (!identityHmacSecret) {
      serverLog.warn('Identity verification routes skipped because no HMAC secret is configured');
    } else {
      const getIdentityRedis = () => {
        const redis = getRedisClient();
        if (!redis) {
          throw new Error('Redis unavailable for identity verification');
        }
        return redis;
      };

      const tokenStore = new RedisVerificationTokenStore(getIdentityRedis);
      const resolutionStore = new RedisResolutionKeyStore(getIdentityRedis);
      const verifiers = new Map<VerificationMethod, IdentityVerifier>();

      verifiers.set('hmac', new HmacVerifier(identityHmacSecret));
      verifiers.set('otp', new OtpVerifier(tokenStore, identityHmacSecret));
      verifiers.set('provider', new ProviderVerifier());
      verifiers.set('email_link', new EmailLinkVerifier(identityHmacSecret, tokenStore));
      verifiers.set(
        'webhook',
        new WebhookVerifier(
          tokenStore,
          async ({ url, tenantId, sessionId, identityValue, challenge }) => {
            const response = await fetch(url, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'X-ABL-Verification': 'challenge',
              },
              body: JSON.stringify({
                tenantId,
                sessionId,
                identityValue,
                challenge,
              }),
              signal: AbortSignal.timeout(10_000),
            });

            if (!response.ok) {
              throw new Error(`Webhook challenge delivery failed with ${response.status}`);
            }

            return { success: true };
          },
          identityHmacSecret,
        ),
      );

      const oauthProviderName = process.env.IDENTITY_OAUTH_PROVIDER?.trim().toLowerCase();
      if (oauthProviderName) {
        const providerKey = oauthProviderName.toUpperCase();
        const clientId = process.env[`IDENTITY_OAUTH_${providerKey}_CLIENT_ID`];
        const clientSecret = process.env[`IDENTITY_OAUTH_${providerKey}_CLIENT_SECRET`];
        const redirectUri = process.env[`IDENTITY_OAUTH_${providerKey}_REDIRECT_URI`];

        if (clientId && clientSecret && redirectUri) {
          let oauthAdapter: ConstructorParameters<typeof OAuthVerifier>[1] | null = null;

          switch (oauthProviderName) {
            case 'google':
              oauthAdapter = new GoogleOAuthAdapter(clientId, clientSecret, redirectUri);
              break;
            case 'microsoft':
              oauthAdapter = new MicrosoftOAuthAdapter(
                process.env.IDENTITY_OAUTH_MICROSOFT_TENANT ?? 'common',
                clientId,
                clientSecret,
                redirectUri,
              );
              break;
            case 'github':
              oauthAdapter = new GitHubOAuthAdapter(clientId, clientSecret, redirectUri);
              break;
            default: {
              const authorizationEndpoint =
                process.env[`IDENTITY_OAUTH_${providerKey}_AUTHORIZE_URL`];
              const tokenEndpoint = process.env[`IDENTITY_OAUTH_${providerKey}_TOKEN_URL`];
              const userinfoEndpoint = process.env[`IDENTITY_OAUTH_${providerKey}_USERINFO_URL`];

              if (authorizationEndpoint && tokenEndpoint && userinfoEndpoint) {
                oauthAdapter = new ConfigurableOAuthProviderAdapter({
                  authorizationEndpoint,
                  tokenEndpoint,
                  userinfoEndpoint,
                  clientId,
                  clientSecret,
                  redirectUri,
                });
              }
            }
          }

          if (oauthAdapter) {
            verifiers.set('oauth', new OAuthVerifier(tokenStore, oauthAdapter));
          } else {
            serverLog.warn('Identity OAuth wiring skipped because provider config is incomplete', {
              provider: oauthProviderName,
            });
          }
        } else {
          serverLog.warn('Identity OAuth wiring skipped because credentials are incomplete', {
            provider: oauthProviderName,
          });
        }
      }

      const identityCtx = createIdentityContext({
        verifiers,
        resolutionStore,
        tokenStore,
      });

      const runtimeEnvironment =
        process.env.NODE_ENV === 'production'
          ? 'production'
          : process.env.NODE_ENV === 'staging'
            ? 'staging'
            : 'dev';
      const promoteAndLink = new PromoteAndLink({
        promoteTier: identityCtx.promoteTier,
        resolveOrCreateContact: {
          execute: async (tenantId, identityType, identityValue, channelType) => ({
            contact: await contactCtx.resolveOrCreateContact.execute(
              tenantId,
              identityType === 'email' || identityType === 'email_thread'
                ? 'email'
                : identityType === 'phone' || identityType === 'caller_id'
                  ? 'phone'
                  : 'external',
              identityValue,
              channelType,
            ),
          }),
        },
        linkSession: contactCtx.linkSessionToContact,
        backfillContactId: createBackfillContactId(),
        updateSessionVerifiedIdentity: async (tenantId, sessionId, verifiedIdentity) => {
          await SessionModel.findOneAndUpdate(
            { _id: sessionId, tenantId },
            {
              $set: {
                verifiedIdentity,
                identityTier: verifiedIdentity.strength,
                verificationMethod: verifiedIdentity.method,
                lastActivityAt: new Date(),
              },
            },
          );
        },
        registerResolutionKey: identityCtx.registerResolutionKey,
        recordVerificationProvenance: async (event) => {
          try {
            getTraceStore().addEvent(event.sessionId, {
              id: randomUUID(),
              sessionId: event.sessionId,
              type: 'identity_verified',
              timestamp: event.verifiedAt,
              agentName: 'identity-verification',
              tenantId: event.tenantId,
              data: {
                projectId: event.projectId,
                sessionPrincipalId: event.sessionPrincipalId,
                verificationMethod: event.verificationMethod,
                identityTier: event.identityTier,
                contactId: event.contactId,
                policySource: event.policySource,
                grantScope: event.grantScope,
                traceId: event.traceId,
                ...(event.verificationAttemptId
                  ? { verificationAttemptId: event.verificationAttemptId }
                  : {}),
              },
            });
          } catch (error) {
            serverLog.warn('Identity verification trace emission failed', {
              sessionId: event.sessionId,
              error: error instanceof Error ? error.message : String(error),
            });
          }

          try {
            const auditStore = getAuditStore();
            if (!auditStore) {
              return;
            }

            await auditStore.log({
              tenantId: event.tenantId,
              projectId: event.projectId,
              eventType: 'session.modified',
              actor: event.sessionPrincipalId,
              actorType: 'user',
              resourceType: 'session',
              resourceId: event.sessionId,
              environment: runtimeEnvironment,
              action: `Identity verified via ${event.verificationMethod}`,
              traceId: event.traceId,
              newValue: {
                contactId: event.contactId,
                identityTier: event.identityTier,
                verificationMethod: event.verificationMethod,
                sessionPrincipalId: event.sessionPrincipalId,
              },
              metadata: {
                policySource: event.policySource,
                grantScope: event.grantScope,
                verifiedAt: event.verifiedAt.toISOString(),
                ...(event.verificationAttemptId
                  ? { verificationAttemptId: event.verificationAttemptId }
                  : {}),
              },
            });
          } catch (error) {
            serverLog.warn('Identity verification audit emission failed', {
              sessionId: event.sessionId,
              error: error instanceof Error ? error.message : String(error),
            });
          }
        },
      });

      const completeVerification = new CompleteVerification({
        tokenStore,
        verifiers,
        loadSession: async (tenantId, sessionId) => {
          const session = await SessionModel.findOne(
            { _id: sessionId, tenantId },
            {
              _id: 1,
              tenantId: 1,
              projectId: 1,
              sessionPrincipalId: 1,
              channel: 1,
              channelId: 1,
              channelArtifact: 1,
              identityTier: 1,
            },
          ).lean();

          if (!session) {
            return null;
          }

          return {
            tenantId: session.tenantId,
            projectId: session.projectId,
            sessionId: session._id,
            sessionPrincipalId: session.sessionPrincipalId,
            channel: session.channel,
            channelId: session.channelId,
            channelArtifact: session.channelArtifact,
            identityTier: session.identityTier,
          };
        },
        promoteAndLink,
        onPostVerificationFailure: ({
          tenantId,
          attemptId,
          sessionId,
          verificationMethod,
          error,
        }) => {
          serverLog.warn('Post-verification continuity wiring failed', {
            tenantId,
            attemptId,
            sessionId,
            verificationMethod,
            error,
          });
        },
      });

      const identityVerificationRouter = createIdentityVerificationRouter({
        verifyIdentity: identityCtx.verifyIdentity,
        tokenStore,
        completeVerification: (attemptId, proof) => completeVerification.execute(attemptId, proof),
      });
      app.use('/api/identity/verify', identityVerificationRouter);
      serverLog.info('Identity verification routes mounted', {
        verifiers: Array.from(verifiers.keys()),
      });
    }

    serverLog.info('Contact merge & merge suggestion routes mounted');
  } catch (error) {
    clearContactLinkingDeps();
    serverLog.warn('Identity & contact route wiring failed (non-fatal)', {
      error: error instanceof Error ? error.message : String(error),
    });
  }

  // ─── ToolOAuthService ─────────────────────────────────────────────────
  if (isDatabaseAvailable() && isTenantEncryptionReady()) {
    try {
      const tokenStore: OAuthTokenStore = await buildMongoOAuthTokenStore();

      const encryptor: OAuthEncryptor = {
        encryptForTenant: (plaintext, tenantId, context) =>
          encryptForTenantAuto(plaintext, tenantId, '_tenant', '_tenant', context),
        decryptForTenant: (encrypted, tenantId, context) =>
          decryptForTenantAuto(encrypted, tenantId, context),
      };

      // D4: Load OAuth provider configs from environment variables
      const { loadProviderConfigsFromEnv } = await import('./services/tool-oauth-service.js');
      const providerConfigs = loadProviderConfigsFromEnv();

      const oauthService = new ToolOAuthService(tokenStore, encryptor, providerConfigs, undefined, {
        resolveProvider: ({ provider, ...params }) =>
          resolveAuthProfileOAuthProvider({
            ...params,
            authProfileRef: provider,
          }),
        resolveProviderById: resolveAuthProfileOAuthProviderById,
      });
      setToolOAuthService(oauthService);
      app.locals.toolOAuthService = oauthService;

      serverLog.info('ToolOAuthService initialized', {
        registeredProviders: oauthService.getRegisteredProviders(),
      });
    } catch (error) {
      serverLog.warn('ToolOAuthService initialization skipped', {
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  }

  // ─── ChannelOAuthService ──────────────────────────────────────────────
  try {
    const { ChannelOAuthService, registerChannelOAuthProviders } =
      await import('./services/channel-oauth/index.js');
    const { RedisOAuthStateStore } = await import('./services/tool-oauth-service.js');

    let channelOAuthStateStore: import('./services/tool-oauth-service.js').OAuthStateStore;
    try {
      const redis = getRedisClient();
      if (redis) {
        channelOAuthStateStore = new RedisOAuthStateStore(redis as any);
      } else {
        const { InMemoryOAuthStateStore } = await import('./services/tool-oauth-service.js');
        channelOAuthStateStore = new InMemoryOAuthStateStore();
      }
    } catch {
      const { InMemoryOAuthStateStore } = await import('./services/tool-oauth-service.js');
      channelOAuthStateStore = new InMemoryOAuthStateStore();
    }

    const channelOAuthService = new ChannelOAuthService(channelOAuthStateStore);
    registerChannelOAuthProviders(channelOAuthService);
    app.locals.channelOAuthService = channelOAuthService;

    serverLog.info('ChannelOAuthService initialized', {
      registeredChannelTypes: channelOAuthService.getRegisteredChannelTypes(),
    });
  } catch (error) {
    serverLog.warn('ChannelOAuthService initialization skipped', {
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }

  // ─── VoiceServiceFactory ──────────────────────────────────────────────
  if (isDatabaseAvailable() && isTenantEncryptionReady()) {
    try {
      const factory = new VoiceServiceFactory();
      app.locals.voiceServiceFactory = factory;

      // Wire factory into LiveKit worker so agent-worker can resolve tenant credentials
      const { setVoiceServiceFactory } = await import('./services/voice/livekit/worker-entry.js');
      setVoiceServiceFactory(factory);

      serverLog.info('VoiceServiceFactory initialized');
    } catch (error) {
      serverLog.warn('VoiceServiceFactory initialization skipped', {
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  }

  // Initialize ClickHouse (optional — graceful fallback)
  if (process.env.CLICKHOUSE_URL || process.env.CLICKHOUSE_HOST) {
    serverLog.info('ClickHouse initialization starting', getClickHouseStartupDiagnostics());
    try {
      const chClient = getClickHouseClient({
        url: process.env.CLICKHOUSE_URL || process.env.CLICKHOUSE_HOST,
        username: process.env.CLICKHOUSE_USER,
        password: process.env.CLICKHOUSE_PASSWORD,
        database: process.env.CLICKHOUSE_DATABASE,
      });
      // ClickHouse schema DDL is now handled by the centralized PreSync CLI.
      // Transitional safety net: verify tables exist, run init as fallback if not.
      await ensureClickHouseSchemaReady(chClient);
      clickhouseReady = true;
      clickhouseInitializationFailure = null;
      startClickHouseProbe(chClient);

      const voiceAnalyticsMvRepairEnabled =
        process.env.CLICKHOUSE_REPAIR_VOICE_ANALYTICS_MV === 'true';
      serverLog.info('Voice analytics ClickHouse repair flag evaluated', {
        enabled: voiceAnalyticsMvRepairEnabled,
      });

      if (voiceAnalyticsMvRepairEnabled) {
        serverLog.info('Voice analytics ClickHouse repair check starting');
        void (async () => {
          try {
            const { ensureVoiceAnalyticsMvUpToDateWithDedicatedClient } =
              await import('./services/voice-analytics-mv-repair.js');
            await ensureVoiceAnalyticsMvUpToDateWithDedicatedClient({
              url:
                process.env.CLICKHOUSE_URL ||
                process.env.CLICKHOUSE_HOST ||
                'http://localhost:8123',
              username: process.env.CLICKHOUSE_USER,
              password: process.env.CLICKHOUSE_PASSWORD,
            });
            serverLog.info('Voice analytics ClickHouse repair check finished');
          } catch (repairError) {
            serverLog.warn('Voice analytics ClickHouse repair failed (non-fatal)', {
              error: repairError instanceof Error ? repairError.message : String(repairError),
            });
          }
        })();
      } else {
        serverLog.info('Voice analytics ClickHouse repair check skipped', {
          reason: 'flag-disabled',
        });
      }

      // Start ClickHouse observability monitor (slow queries, replication, disk)
      try {
        const { ClickHouseObservabilityMonitor } =
          await import('./services/clickhouse-observability-monitor.js');
        const chMonitor = new ClickHouseObservabilityMonitor(chClient);
        chMonitor.start();
        (app as any)._clickhouseObservabilityMonitor = chMonitor;
        serverLog.info('ClickHouse observability monitor started');
      } catch (chMonErr) {
        serverLog.warn('ClickHouse observability monitor failed to start (non-fatal)', {
          error: chMonErr instanceof Error ? chMonErr.message : String(chMonErr),
        });
      }

      // Enable KMS audit logging now that ClickHouse is available
      try {
        const { setKMSAuditClickHouseAvailable } =
          await import('./services/kms/kms-audit-logger.js');
        setKMSAuditClickHouseAvailable(true);
      } catch {
        // KMS audit logger module may not be loaded — non-fatal
      }

      serverLog.info('ClickHouse initialized', {
        database: process.env.CLICKHOUSE_DATABASE || 'abl_platform',
        endpointSource: getConfiguredClickHouseEndpointSource(),
      });
    } catch (error) {
      clickhouseInitializationFailure = toErrorDiagnostics(error);
      serverLog.warn('ClickHouse initialization failed — analytics stores unavailable', {
        ...clickhouseInitializationFailure,
        ...getClickHouseStartupDiagnostics(),
      });
    }
  } else {
    serverLog.info('ClickHouse initialization skipped — endpoint not configured', {
      database: process.env.CLICKHOUSE_DATABASE || 'abl_platform',
    });
  }

  // Initialize EventBus (Kafka event production) — optional, off by default
  if (process.env.EVENT_KAFKA_ENABLED === 'true' && clickhouseReady) {
    try {
      const chClient = getClickHouseClient();
      const { findKafkaSubscriptions } = await import('./repos/pipeline-repo.js');

      // Sync function: joins pipeline_configs (tenant-scoped, enabled flag) with
      // pipeline_definitions (platform templates with Kafka triggers) to build
      // a Map<tenantId, Set<eventType>>. Only tenants with enabled pipelines get events.
      const syncFn = async (): Promise<Map<string, Set<string>>> => {
        try {
          return await findKafkaSubscriptions();
        } catch (err) {
          serverLog.warn('EventBus syncFn failed, returning empty subscriptions', {
            error: err instanceof Error ? err.message : String(err),
          });
          return new Map();
        }
      };

      eventBusComponents = await createEventBus(chClient, syncFn);
      setRuntimeEventBus(eventBusComponents.bus);
      getRuntimeExecutor().setEventBus(eventBusComponents.bus);
      // Wire EventBus to conversation store for centralized session lifecycle events.
      // Wrap emit to bridge the minimal StoreEventBus interface (Record<string, unknown>)
      // with the typed EventBus interface (AnyPlatformEvent).
      const convStore = getStores().conversation as MongoConversationStore;
      const bus = eventBusComponents.bus;
      convStore.setEventBus({
        emit: (event) =>
          bus.emit(event as unknown as import('./services/event-bus/types.js').AnyPlatformEvent),
      });
      // Wire escalation bridge to create HumanTask records from agent escalations
      try {
        const { initEscalationBridge } = await import('./services/escalation-bridge.js');
        initEscalationBridge(eventBusComponents.bus);
      } catch (bridgeErr) {
        serverLog.warn('Escalation bridge initialization failed', {
          error: bridgeErr instanceof Error ? bridgeErr.message : String(bridgeErr),
        });
      }
      serverLog.info('EventBus initialized with Kafka event production');
    } catch (err) {
      serverLog.warn('EventBus initialization failed, continuing without event production', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // Start SLA checker for human tasks
  try {
    const { startSlaChecker } = await import('./services/sla-checker.js');
    startSlaChecker();
  } catch (err) {
    serverLog.warn('SLA checker initialization failed', {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  // Initialize Redis (ESM dynamic import — must happen before services that use getRedisClient)
  try {
    const { initializeRedis } = await import('./services/redis/redis-client.js');
    await initializeRedis();
  } catch (error) {
    serverLog.warn('Redis initialization failed (non-fatal)', {
      error: error instanceof Error ? error.message : String(error),
    });
  }

  // AI4W trusted-issuer config validation. Pure config parsing — no network
  // calls — so this only fails on invalid AI4W_TRUSTED_ISSUERS / overrides.
  // Per-issuer JWKS resolvers are registered lazily on the first JWT for each
  // issuer, with single-flight + failure cooldown (AI4W_JWKS_COOLDOWN_MS), so
  // a transiently-unreachable issuer does not require a pod restart to recover.
  {
    const { initAI4WAuth } = await import('./channels/adapters/ai4w-auth.js');
    try {
      await initAI4WAuth();
    } catch (err: unknown) {
      serverLog.error('AI4W auth config invalid — JWT verification disabled', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // Fail-fast on misconfigured AI4W_TRUSTED_CALLBACK_CIDRS. Overly-broad
  // prefixes (e.g. /0) would silently disable SSRF protection on file-download
  // and async-callback paths; we'd rather the pod refuse to start than accept
  // that risk at request time.
  {
    const { validateAI4WTrustedCallbackCIDRs } = await import('./channels/adapters/ai4w-ssrf.js');
    validateAI4WTrustedCallbackCIDRs();
  }

  // Wire SyncExecutionService now that Redis has finished initializing.
  // Both the Process API and the workflow-engine proxy hold a lazy getter
  // over `syncExecutionService`, so assigning here activates `?mode=sync`.
  try {
    const redis = getRedisClient();
    const redisHandle = getRedisHandle();
    if (redis && redisHandle && !syncExecutionService) {
      // Cluster-aware subscriber. `maxRetriesPerRequest: null` is harmless for
      // pub/sub subscribers (it just disables blocking-command timeouts) and is
      // already the cluster-mode default in createSubscriber.
      const subscriber = createSubscriber(redisHandle);
      syncExecutionService = new SyncExecutionService({ redisSubscriber: subscriber });
      serverLog.info('SyncExecutionService wired');
    } else if (!redis) {
      serverLog.warn('Redis unavailable — sync execution will return 503 until Redis is reachable');
    }
  } catch (error) {
    serverLog.warn('SyncExecutionService wiring failed (non-fatal)', {
      error: error instanceof Error ? error.message : String(error),
    });
  }

  // Register workflow callback endpoint after Redis is available
  const internalCallbackSecret = process.env.INTERNAL_CALLBACK_SECRET;
  if (internalCallbackSecret) {
    const callbackRedis = getRedisClient();
    if (callbackRedis) {
      const callbackHandler = new WorkflowCallbackHandler({
        redis: callbackRedis,
        messageStore: getStores().message,
        internalWsManager: getInternalConnectionManager(),
        sdkWsManager: getSdkConnectionManager(),
        internalSecret: internalCallbackSecret,
      });
      _workflowCallbackRouter = createInternalCallbacksRouter(callbackHandler);
      serverLog.info('Workflow callback endpoint registered');
    } else {
      serverLog.warn(
        'INTERNAL_CALLBACK_SECRET set but Redis unavailable — workflow callbacks disabled',
      );
    }
  } else if (process.env.RUNTIME_URL) {
    serverLog.warn(
      'RUNTIME_URL is set but INTERNAL_CALLBACK_SECRET is missing — workflow push callbacks will not be received',
    );
  }

  if (dek) {
    await wireKmsAndDekInvalidation(dek);
  }
  await wireModelHubInvalidation(encMasterKey);

  // Initialize audit store (strict Kafka -> ClickHouse pipeline; otherwise InMemory for dev/test)
  const { initializeAuditStore } = await import('./services/audit-store-singleton.js');
  await initializeAuditStore({
    clickhouseReady,
    clickhouseInitFailure: clickhouseInitializationFailure,
  });
  const { ensureRuntimeAuditTrailHandlerRegistered } =
    await import('./services/audit/runtime-audit-trail-handler.js');
  ensureRuntimeAuditTrailHandlerRegistered();

  // Initialize EventStore (ClickHouse > Memory fallback)
  try {
    const { initializeEventStore } = await import('./services/eventstore-singleton.js');
    await initializeEventStore({ clickhouseReady });
    serverLog.info('EventStore initialized');
  } catch (error) {
    serverLog.warn('EventStore initialization failed (non-fatal)', {
      error: error instanceof Error ? error.message : String(error),
    });
  }

  // Workflow event-sourcing CH tables are now created by the centralized PreSync CLI.

  if (process.env.WORKFLOW_CH_SINK_ENABLED === 'true' && clickhouseReady) {
    try {
      const { KafkaEventQueue } = await import('@abl/eventstore/queues');
      const { getClickHouseClient } = await import('@agent-platform/database/clickhouse');
      const {
        WorkflowEventsConsumer,
        WORKFLOW_EXECUTION_TOPIC,
        HUMAN_TASK_TOPIC,
        WORKFLOW_EXECUTION_GROUP_ID,
        HUMAN_TASK_GROUP_ID,
      } = await import('./services/workflow-events-consumer.js');
      const kafkaBrokers = (process.env.EVENT_KAFKA_BROKERS ?? 'localhost:9092').split(',');
      const executionQueue = new KafkaEventQueue({
        kafka: {
          brokers: kafkaBrokers,
          topic: WORKFLOW_EXECUTION_TOPIC,
          groupId: WORKFLOW_EXECUTION_GROUP_ID,
        },
      });
      const humanTaskQueue = new KafkaEventQueue({
        kafka: {
          brokers: kafkaBrokers,
          topic: HUMAN_TASK_TOPIC,
          groupId: HUMAN_TASK_GROUP_ID,
        },
      });
      const consumer = new WorkflowEventsConsumer({
        chClient: getClickHouseClient(),
        executionQueue,
        humanTaskQueue,
      });
      consumer.start();
      workflowEventsConsumer = consumer;
      (app as any)._workflowEventsConsumer = consumer;
      serverLog.info('Workflow events consumer started');
    } catch (consumerErr) {
      serverLog.warn('Workflow events consumer failed to start (non-fatal)', {
        error: consumerErr instanceof Error ? consumerErr.message : String(consumerErr),
      });
    }
  }

  // Hybrid human-task reader (LLD §5.3). Constructed after CH is ready so
  // `workflowHybridReader` in createHumanTaskRouter resolves to a live
  // reader once this runs. Flag off ⇒ skip wiring entirely.
  if (process.env.WORKFLOW_DUAL_READ_ENABLED === 'true' && clickhouseReady) {
    try {
      const { HybridHumanTaskReader } = await import('./services/hybrid-human-task-reader.js');
      const { getClickHouseClient } = await import('@agent-platform/database/clickhouse');
      const { HumanTask } = await import('@agent-platform/database/models');
      workflowHybridHumanTaskReader = new HybridHumanTaskReader({
        mongoModel: {
          find: (filter) => HumanTask.find(filter),
          countDocuments: (filter) => HumanTask.countDocuments(filter),
          distinctTaskIds: (filter) =>
            HumanTask.distinct('_id', filter).exec() as Promise<string[]>,
        },
        chClient: getClickHouseClient() as never,
        readFlags: () => ({ dualReadEnabled: true }),
      });
      serverLog.info('HybridHumanTaskReader wired (dual-read on)');
    } catch (err) {
      serverLog.warn('HybridHumanTaskReader failed to wire — falling back to Mongo-only', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // Workflow test-diagnostic routes (LLD §4.4). Mounted behind the full
  // runtime authMiddleware stack and only in NODE_ENV=test — see
  // apps/runtime/src/routes/test-diagnostic-workflow.ts.
  if (process.env.NODE_ENV === 'test' && clickhouseReady) {
    try {
      const { createWorkflowTestDiagnosticRouter } =
        await import('./routes/test-diagnostic-workflow.js');
      const { getClickHouseClient } = await import('@agent-platform/database/clickhouse');
      const { authMiddleware } = await import('./middleware/auth.js');
      const testRouter = createWorkflowTestDiagnosticRouter({
        chClient: getClickHouseClient(),
        consumer: workflowEventsConsumer ?? undefined,
        authMiddleware: [authMiddleware],
      });
      // Late-bound: populates the reserved mount at line ~1714 BEFORE the
      // module-scope 404 handler so requests reach the router.
      setWorkflowTestDiagnosticRouter(testRouter);
      serverLog.info('Workflow test-diagnostic routes mounted');
    } catch (routeErr) {
      serverLog.warn('Workflow test-diagnostic routes failed to mount (non-fatal)', {
        error: routeErr instanceof Error ? routeErr.message : String(routeErr),
      });
    }
  }

  // Start credential age monitor (warns on old ToolSecret, LLMCredential, ApiKey, AuthProfile)
  try {
    const { getEventStore } = await import('./services/eventstore-singleton.js');
    const eventStore = getEventStore();
    if (eventStore) {
      const { CredentialAgeMonitor } = await import('./services/credential-age-monitor.js');
      const credMonitor = new CredentialAgeMonitor({
        eventStore: { write: (event: unknown) => eventStore.emitter.emit(event) },
      });
      credMonitor.start();
      (app as any)._credentialAgeMonitor = credMonitor;
      serverLog.info('Credential age monitor started');
    }
  } catch (credMonErr) {
    serverLog.warn('Credential age monitor failed to start (non-fatal)', {
      error: credMonErr instanceof Error ? credMonErr.message : String(credMonErr),
    });
  }

  // ─── Redis + Session Store ───────────────────────────────────────────
  try {
    const { ensureRedisInitialized } = await import('./services/redis/redis-client.js');
    await ensureRedisInitialized();
    const { ensureSessionService } = await import('./services/session/session-service.js');
    await ensureSessionService(config.session);
  } catch (error) {
    serverLog.warn('Redis/SessionService initialization — falling back to memory', {
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }

  // ─── Agent Transfer Subsystem ────────────────────────────────────────
  // Initialize after Redis so the transfer session store can use it.
  try {
    const { isAgentTransferEnabled, loadAgentTransferConfig } =
      await import('./config/agent-transfer.js');
    if (!isAgentTransferEnabled()) {
      serverLog.info('Agent transfer subsystem disabled by kill switch', {
        source: 'AGENT_TRANSFER_ENABLED',
      });
    } else if (!isRedisAvailable()) {
      serverLog.warn('Agent transfer initialization skipped because Redis is unavailable');
    } else {
      const atConfig = loadAgentTransferConfig();
      if (atConfig) {
        const { initializeAgentTransfer } = await import('./services/agent-transfer/index.js');
        // initializeAgentTransfer accepts RedisClient (Redis | Cluster).
        // BullMQ factories inside use getRedisHandle() + createBullMQPair() — cluster-safe.
        const redis = getRedisClient()!;
        await initializeAgentTransfer(redis, atConfig);
        serverLog.info('Agent transfer subsystem initialized');
      }
    }
  } catch (error) {
    serverLog.warn('Agent transfer initialization skipped (non-fatal)', {
      error: error instanceof Error ? error.message : String(error),
    });
  }

  // ─── Connector Registry ─────────────────────────────────────────────
  // Initialize after DB/encryption so connector tool resolution is available.
  try {
    const { initConnectorRegistry } = await import('./services/connector-registry-singleton.js');
    await initConnectorRegistry();
  } catch (error) {
    serverLog.warn('Connector registry initialization skipped (non-fatal)', {
      error: error instanceof Error ? error.message : String(error),
    });
  }

  // ─── ExecutionCoordinator Singleton ──────────────────────────────────
  // Create the coordinator after Redis/SessionService init so the executor
  // is fully available. Prefers Redis-backed queue/dedup for multi-pod;
  // falls back to in-memory for single-pod dev or when Redis is unavailable.
  try {
    const { InMemoryExecutionQueue } = await import('@agent-platform/execution');
    const { ExecutionCoordinator } = await import('./services/execution/execution-coordinator.js');
    const { ExecutionDedup, InMemoryDedupStore, RedisDedupStore } =
      await import('./services/execution/execution-dedup.js');

    const runtimeExecutor = getRuntimeExecutor();

    let executionQueue;
    let dedupStore;
    let queueType: string;

    if (isRedisAvailable()) {
      const redis = getRedisClient()!;
      const { RedisExecutionQueue } = await import('./services/execution/redis-execution-queue.js');
      executionQueue = new RedisExecutionQueue(redis);
      dedupStore = new RedisDedupStore(redis);
      queueType = 'redis';
    } else {
      executionQueue = new InMemoryExecutionQueue();
      dedupStore = new InMemoryDedupStore();
      queueType = 'in-memory';
    }

    const coordinator = new ExecutionCoordinator({
      queue: executionQueue,
      dedup: new ExecutionDedup(dedupStore),
      executor: runtimeExecutor,
      sessionLoader: async (sessionId) => {
        const session = runtimeExecutor.getSession(sessionId);
        if (!session) return null;
        return {
          agentName: session.agentName,
          agentIR: {
            execution: {
              concurrency: session.agentIR?.execution?.concurrency,
              max_queue_depth: session.agentIR?.execution?.max_queue_depth,
              max_concurrent_messages: session.agentIR?.execution?.max_concurrent_messages,
            },
          },
        };
      },
    });
    setExecutionCoordinator(coordinator);
    serverLog.info(`ExecutionCoordinator initialized (${queueType} queue + dedup)`);
  } catch (error) {
    serverLog.warn(
      'ExecutionCoordinator initialization failed (non-fatal, fallback to direct execution)',
      {
        error: error instanceof Error ? error.message : String(error),
      },
    );
  }

  // Start session retention cleanup job
  startSessionCleanupJob(config.cleanup);

  // Start workflow purge job (hard-delete soft-deleted workflows past retention)
  startWorkflowPurgeJob({ retentionDays: 30, intervalMinutes: 60 * 24 });

  // Start active session timeout sweep
  startSessionTimeoutSweepJob(config.sessionTimeoutSweep);

  // Start scheduled billing materialization
  try {
    const { startBillingUsageMaterializationScheduler } =
      await import('./services/billing/billing-usage-materialization-scheduler.js');
    startBillingUsageMaterializationScheduler(config.billingMaterialization);
    serverLog.info('Billing materialization scheduler started');
  } catch (err) {
    serverLog.warn('Billing materialization scheduler failed to start (non-fatal)', {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  // Start low-frequency billing publication
  try {
    const { startBillingUsagePublicationScheduler } =
      await import('./services/billing/billing-usage-publication-scheduler.js');
    startBillingUsagePublicationScheduler(config.billingPublication);
    serverLog.info('Billing publication scheduler started');
  } catch (err) {
    serverLog.warn('Billing publication scheduler failed to start (non-fatal)', {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  // Start KMS rotation job (epoch transitions, DEK destruction, KEK age check)
  try {
    const { startKMSRotationJob } = await import('./services/kms/kms-rotation-job.js');
    startKMSRotationJob({
      intervalMinutes: parseInt(process.env.KMS_ROTATION_INTERVAL_MINUTES || '60', 10),
      // DEK destruction is explicitly opt-in. Null keeps decrypt_only DEKs readable indefinitely.
      dekRetentionDays: null,
      kekRotationPeriodDays: 365,
      enableReencryption: true,
    });
    serverLog.info('KMS rotation job started');
  } catch (err) {
    serverLog.warn('KMS rotation job failed to start (non-fatal)', {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  // Start auth profile rotation job (credential expiry checks, key version sync)
  try {
    const { startAuthProfileRotationJob } =
      await import('./services/auth-profile/auth-profile-rotation-scheduler.js');
    startAuthProfileRotationJob();
    serverLog.info('Auth profile rotation job started');
  } catch (err) {
    serverLog.warn('Auth profile rotation job failed to start (non-fatal)', {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  // Start auth profile force-invalidate subscriber (Redis pub/sub)
  try {
    if (isRedisAvailable()) {
      const { ForceInvalidateSubscriber } =
        await import('./services/auth-profile/force-invalidate-subscriber.js');
      const { getAuthProfileCache } = await import('./services/auth-profile-resolver.js');
      const { createRedisSubscriber } = await import('./services/redis/redis-client.js');
      const subscriber = new ForceInvalidateSubscriber({
        cache: getAuthProfileCache(),
        createSubscriber: () => createRedisSubscriber(),
      });
      await subscriber.start();
      (app as any)._authProfileForceInvalidateSubscriber = subscriber;
      serverLog.info('Auth profile force-invalidate subscriber started');
    }
  } catch (err) {
    serverLog.warn('Auth profile force-invalidate subscriber failed to start (non-fatal)', {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  // Start automated model health check job (if enabled)
  if (config.features.enableHealthChecks) {
    try {
      const { startModelHealthJob } = await import('./services/llm/model-health-service.js');
      const { getRedisClient } = await import('./services/redis/redis-client.js');
      const intervalMs = config.features.healthCheckIntervalHours * 3_600_000;
      startModelHealthJob(intervalMs, getRedisClient() ?? undefined);
      serverLog.info('Model health check job started', {
        intervalHours: config.features.healthCheckIntervalHours,
      });
    } catch (err) {
      serverLog.warn('Model health check job failed to start (non-fatal)', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // Start LiveKit agent worker if enabled
  if (config.features.livekitEnabled) {
    try {
      const { startLiveKitWorker } = await import('./services/voice/livekit/worker-entry.js');
      await startLiveKitWorker();
      serverLog.info('LiveKit agent worker started');
    } catch (error) {
      serverLog.warn('LiveKit agent worker failed to start', {
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  }

  // Initialize channel queues (BullMQ workers for HTTP Async channel)
  try {
    const { startChannelQueues } = await import('./services/queues/index.js');
    await startChannelQueues();
  } catch (error) {
    serverLog.warn('Channel queues initialization skipped', {
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }

  // Start embedded SMTP server for email channel (inbound)
  if (process.env.SMTP_LISTEN_PORT || process.env.EMAIL_FROM_ADDRESS) {
    try {
      const { startSmtpServer } = await import('./services/email/smtp-server.js');
      await startSmtpServer();
      serverLog.info('Embedded SMTP server started', {
        port: process.env.SMTP_LISTEN_PORT || '2525',
      });
    } catch (error) {
      serverLog.warn('SMTP server initialization skipped', {
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  }

  // Start WebSocket heartbeat (keeps connections alive through AppGW/NGINX/LB)
  const heartbeatMs = (() => {
    try {
      return config.websocket.heartbeatIntervalMs;
    } catch {
      return 30_000;
    }
  })();
  startHeartbeat([wss, wssSDK, wssTwilioMedia], heartbeatMs);
  startAudioCodesCleanup();

  return new Promise<void>((resolve, reject) => {
    server.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE') {
        console.error(
          `[runtime] Port ${port} is already in use. ` +
            `Kill the existing process or use a different PORT.`,
        );
        process.exit(1);
      }
      reject(err);
    });

    server.listen(port, host, () => {
      console.log(`
╔════════════════════════════════════════════════════════════╗
║           Agent Runtime Server                             ║
╠════════════════════════════════════════════════════════════╣
║  HTTP API:    http://${host}:${port}                           ║
║  WebSocket:   ws://${host}:${port}/ws                          ║
║  SDK WS:      ws://${host}:${port}/ws/sdk                      ║
║  Health:      http://${host}:${port}/health                    ║
╠════════════════════════════════════════════════════════════╣
║  Runtime Endpoints:                                        ║
║    POST /api/projects/:pid/sessions   Create session       ║
║    GET  /api/projects/:pid/sessions/:id  Get session       ║
║    POST /api/v1/chat/stream    SSE streaming chat          ║
║    POST /api/v1/chat/complete  Non-streaming chat          ║
║    GET  /api/v1/transcripts/:id  Get transcript            ║
║    POST /api/v1/voice/connect  Twilio webhook              ║
║    POST /api/v1/voice/status   Twilio status               ║
║    POST /api/v1/livekit/token  LiveKit token               ║
║    GET  /api/v1/livekit/capabilities  LiveKit status       ║
║    GET  /api/v1/sdk/config/:id Widget config (public)      ║
║    POST /api/v1/sdk/init       SDK session token exchange  ║
║    CRUD /api/contacts          Contact management          ║
║    CRUD /api/projects/:pid/workflows  Workflow mgmt        ║
╚════════════════════════════════════════════════════════════╝
`);
      resolve();
    });
  });
}

// =============================================================================
// OAUTH TOKEN STORE BUILDER
// =============================================================================

async function buildMongoOAuthTokenStore(): Promise<OAuthTokenStore> {
  const { EndUserOAuthToken } = await import('@agent-platform/database/models');
  return {
    async findToken(tenantId, userId, provider) {
      const record = await EndUserOAuthToken.findOne(
        { tenantId, userId, provider, revokedAt: null },
        { encryptedAccessToken: 1, encryptedRefreshToken: 1, scope: 1, expiresAt: 1, revokedAt: 1 },
      ).lean();
      if (!record) return null;
      return record as any;
    },
    async upsertToken(params) {
      // Use findOne + save/create so the encryption plugin's pre-save hook fires
      const existing = await EndUserOAuthToken.findOne({
        tenantId: params.tenantId,
        userId: params.userId,
        provider: params.provider,
      });
      if (existing) {
        existing.set('encryptedAccessToken', params.encryptedAccessToken);
        existing.set('encryptedRefreshToken', params.encryptedRefreshToken ?? null);
        if (params.scope) existing.set('scope', params.scope);
        existing.set('expiresAt', params.expiresAt ?? null);
        existing.set('refreshedAt', new Date());
        existing.set('revokedAt', null);
        await existing.save();
      } else {
        await EndUserOAuthToken.create({
          tenantId: params.tenantId,
          userId: params.userId,
          provider: params.provider,
          encryptedAccessToken: params.encryptedAccessToken,
          encryptedRefreshToken: params.encryptedRefreshToken ?? null,
          scope: params.scope || undefined,
          expiresAt: params.expiresAt ?? null,
          refreshedAt: new Date(),
          revokedAt: null,
        });
      }
    },
    async compareAndSwapToken(params: OAuthTokenCompareAndSwapParams): Promise<boolean> {
      const now = new Date();
      if (params.expectedVersion == null) {
        if (params.next.kind === 'revoke') {
          return false;
        }

        const token = params.next.token;
        const reactivated = await EndUserOAuthToken.updateOne(
          {
            tenantId: params.tenantId,
            userId: params.userId,
            provider: params.provider,
            revokedAt: { $ne: null },
          },
          {
            $set: {
              encryptedAccessToken: token.encryptedAccessToken,
              encryptedRefreshToken: token.encryptedRefreshToken ?? null,
              scope: token.scope || undefined,
              expiresAt: token.expiresAt ?? null,
              refreshedAt: now,
              revokedAt: null,
            },
            $inc: { __v: 1 },
          },
        );
        if (reactivated.modifiedCount === 1) {
          return true;
        }

        try {
          await EndUserOAuthToken.create({
            tenantId: params.tenantId,
            userId: params.userId,
            provider: params.provider,
            encryptedAccessToken: token.encryptedAccessToken,
            encryptedRefreshToken: token.encryptedRefreshToken ?? null,
            scope: token.scope || undefined,
            expiresAt: token.expiresAt ?? null,
            refreshedAt: now,
            revokedAt: null,
          });
          return true;
        } catch (err) {
          const code =
            err && typeof err === 'object' && 'code' in err
              ? (err as { code?: unknown }).code
              : undefined;
          if (code === 11000) {
            return false;
          }
          throw err;
        }
      }

      if (params.next.kind === 'upsert') {
        const token = params.next.token;
        const result = await EndUserOAuthToken.updateOne(
          {
            tenantId: params.tenantId,
            userId: params.userId,
            provider: params.provider,
            revokedAt: null,
            __v: params.expectedVersion,
          },
          {
            $set: {
              encryptedAccessToken: token.encryptedAccessToken,
              encryptedRefreshToken: token.encryptedRefreshToken ?? null,
              scope: token.scope || undefined,
              expiresAt: token.expiresAt ?? null,
              refreshedAt: now,
              revokedAt: null,
            },
            $inc: { __v: 1 },
          },
        );
        return result.modifiedCount === 1;
      }

      const result = await EndUserOAuthToken.updateOne(
        {
          tenantId: params.tenantId,
          userId: params.userId,
          provider: params.provider,
          revokedAt: null,
          __v: params.expectedVersion,
        },
        {
          $set: { revokedAt: now },
          $inc: { __v: 1 },
        },
      );
      return result.modifiedCount === 1;
    },
    async markRevoked(tenantId, userId, provider) {
      await EndUserOAuthToken.updateOne(
        { tenantId, userId, provider },
        { $set: { revokedAt: new Date() } },
      );
    },
    async updateLastUsed(tenantId, userId, provider) {
      await EndUserOAuthToken.updateOne(
        { tenantId, userId, provider },
        { $set: { lastUsedAt: new Date() } },
      );
    },
  };
}

// =============================================================================
// GRACEFUL SHUTDOWN
// =============================================================================

const shutdownLog = createLogger('shutdown');
let isShuttingDown = false;

interface RuntimeShutdownOptions {
  /** When false, skip process.exit() — used by test harnesses. Defaults to true. */
  exitProcess?: boolean;
}

async function shutdownRuntimeServer(options: RuntimeShutdownOptions = {}): Promise<void> {
  const { exitProcess = true } = options;

  if (isShuttingDown) return;
  isShuttingDown = true;

  // Force exit if shutdown takes too long (only when exiting the process)
  let forceTimer: ReturnType<typeof setTimeout> | undefined;
  if (exitProcess) {
    forceTimer = setTimeout(() => {
      shutdownLog.error('Forced shutdown after timeout');
      process.exit(1);
    }, 30_000);
    forceTimer.unref();
  }

  try {
    shutdownLog.info('Shutting down runtime gracefully');

    // Close HTTP server FIRST to release the port immediately.
    // This allows tsx watch to bind the port on restart without EADDRINUSE.
    server.keepAliveTimeout = 0;
    await new Promise<void>((resolve) => {
      let resolved = false;
      server.close(() => {
        if (!resolved) {
          resolved = true;
          shutdownLog.info('HTTP server closed, port released');
          resolve();
        }
      });
      setTimeout(() => {
        if (!resolved) {
          resolved = true;
          shutdownLog.warn('HTTP server close timed out after 10s');
          resolve();
        }
      }, 10_000);
    });

    // Now clean up everything else (port is already free for restarts)
    stopHeartbeat();
    stopAudioCodesCleanup();

    wss.clients.forEach((client) => {
      client.close(1001, 'Server shutting down');
    });
    wssSDK.clients.forEach((client) => {
      client.close(1001, 'Server shutting down');
    });
    wssCustomTts.clients.forEach((client) => {
      client.close(1001, 'Server shutting down');
    });
    // Tear down the WF bridge first so the Redis subscriber stops before we
    // signal clients to close. wfBridge is intentionally left non-null so the
    // async WS 'close' events can still invoke handleClose for registry cleanup.
    wfBridge?.close();
    wssWorkflows.clients.forEach((client) => {
      client.close(1001, 'Server shutting down');
    });

    // Shutdown agent transfer subsystem (drain adapters, stop recovery)
    try {
      const { shutdownAgentTransfer } = await import('./services/agent-transfer/index.js');
      await shutdownAgentTransfer();
    } catch {
      // May not have been initialized
    }

    // Shutdown sync execution service (Redis Pub/Sub subscriber)
    if (syncExecutionService) {
      await syncExecutionService.shutdown();
    }

    // Shutdown Korevg router (handles all Korevg voice connections)
    await korevgRouter.shutdown();

    for (const [ws] of sdkClients) {
      try {
        if (ws.readyState === ws.OPEN) {
          ws.send(JSON.stringify({ type: 'server_shutdown', message: 'Server is shutting down' }));
          ws.close(1001, 'Server shutting down');
        }
      } catch {
        // Ignore errors during shutdown
      }
    }
    sdkClients.clear();

    stopSessionCleanupJob();
    stopSessionTimeoutSweepJob();
    stopWorkflowPurgeJob();

    try {
      const { stopBillingUsageMaterializationScheduler } =
        await import('./services/billing/billing-usage-materialization-scheduler.js');
      stopBillingUsageMaterializationScheduler();
    } catch {
      // Module may not be loaded
    }

    try {
      const { stopBillingUsagePublicationScheduler } =
        await import('./services/billing/billing-usage-publication-scheduler.js');
      stopBillingUsagePublicationScheduler();
    } catch {
      // Module may not be loaded
    }

    // Clear resilience recovery timers (rate limiter + circuit breaker)
    resetHybridRateLimiter();
    resetCircuitBreakerRegistry();

    getRuntimeExecutor().stopStaleReaper();
    await stopLiveKitWorker();
    await shutdownMessageQueue();
    await shutdownLLMQueue();

    // Flush + close workflow events CH consumer (LLD §4.1). Last-in-first-
    // out with the start order: stop ingesting before closing CH writers so
    // the final flush carries every buffered row through before the process
    // exits.
    if (workflowEventsConsumer) {
      try {
        await workflowEventsConsumer.shutdown();
      } catch (err) {
        shutdownLog.warn('WorkflowEventsConsumer shutdown failed', {
          error: err instanceof Error ? err.message : String(err),
        });
      } finally {
        workflowEventsConsumer = null;
      }
    }

    // Stop KMS rotation job + re-encryption queue
    try {
      const { stopKMSRotationJob } = await import('./services/kms/kms-rotation-job.js');
      stopKMSRotationJob();
    } catch {
      // Module may not be loaded
    }
    try {
      const { shutdownReencryptionQueue } = await import('./services/kms/reencryption-queue.js');
      await shutdownReencryptionQueue();
    } catch {
      // Module may not be loaded
    }

    // Stop auth profile rotation job
    try {
      const { stopAuthProfileRotationJob } =
        await import('./services/auth-profile/auth-profile-rotation-scheduler.js');
      stopAuthProfileRotationJob();
    } catch {
      // Module may not be loaded
    }

    if (agentAssistCallbackQueue) {
      try {
        await agentAssistCallbackQueue.close();
      } catch (err) {
        shutdownLog.warn('Agent Assist callback queue close failed', {
          error: err instanceof Error ? err.message : String(err),
        });
      } finally {
        agentAssistCallbackQueue = undefined;
      }
    }

    // Stop auth profile force-invalidate subscriber
    try {
      const sub = (app as any)._authProfileForceInvalidateSubscriber;
      if (sub) {
        await sub.stop();
        (app as any)._authProfileForceInvalidateSubscriber = null;
      }
    } catch {
      // Subscriber may not have been started
    }

    // Stop model health check job
    try {
      const { stopModelHealthJob } = await import('./services/llm/model-health-service.js');
      stopModelHealthJob();
    } catch {
      // Module may not be loaded
    }

    // Shutdown DEK Manager invalidation transport (close Redis subscriber)
    try {
      if (dekManagerInvalidationHandle) {
        await dekManagerInvalidationHandle.shutdownTransport();
        dekManagerInvalidationHandle = null;
      }
    } catch {
      // DEK manager may not be initialized — intentional ignore
    }

    // Shutdown Model Hub cache invalidation transport
    try {
      const { shutdownModelInvalidation } =
        await import('./services/llm/model-cache-invalidation.js');
      await shutdownModelInvalidation();
    } catch {
      // Module may not be loaded — intentional ignore
    }

    // Shutdown KMS resolver (close Redis subscriber, clear cache)
    try {
      const { getGlobalKMSResolver, clearGlobalKMSResolver } =
        await import('@agent-platform/database/kms');
      const resolver = getGlobalKMSResolver();
      if (resolver) {
        await resolver.shutdown();
        clearGlobalKMSResolver();
      }
    } catch {
      // Resolver may not be initialized — ignore
    }

    // Shutdown KMS provider pool (zero-fill key material) before DB disconnect
    try {
      const { shutdownKMSRegistry } = await import('@agent-platform/database/kms');
      await shutdownKMSRegistry();
    } catch {
      // KMS module may not be loaded — ignore
    }

    // Shutdown EventBus (drain Kafka buffers + dead-letter)
    // Stop SLA checker
    try {
      const { stopSlaChecker } = await import('./services/sla-checker.js');
      stopSlaChecker();
    } catch {
      // Ignore
    }

    if (eventBusComponents) {
      try {
        await shutdownEventBus(eventBusComponents);
      } catch (err) {
        shutdownLog.warn('EventBus shutdown failed', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
      eventBusComponents = null;
      setRuntimeEventBus(null);
    }

    // Stop ClickHouse observability monitor
    try {
      const chMon = (app as any)._clickhouseObservabilityMonitor;
      if (chMon) {
        chMon.stop();
        (app as any)._clickhouseObservabilityMonitor = null;
      }
    } catch {
      // Monitor may not have been started
    }

    // Stop credential age monitor
    try {
      const credMon = (app as any)._credentialAgeMonitor;
      if (credMon) {
        credMon.stop();
        (app as any)._credentialAgeMonitor = null;
      }
    } catch {
      // Monitor may not have been started
    }

    stopClickHouseProbe();

    // Stop embedded SMTP server
    try {
      const { stopSmtpServer } = await import('./services/email/smtp-server.js');
      await stopSmtpServer();
    } catch {
      // SMTP may not have been started
    }

    // Stop channel queues before disconnecting Redis
    try {
      const { stopChannelQueues } = await import('./services/queues/index.js');
      await stopChannelQueues();
    } catch {
      // Queues may not have been started
    }

    // Flush EventStore buffered events to ClickHouse before closing the connection.
    // Without this, events in the BufferedWriter's 5-second batch window are lost on restart.
    try {
      const { getEventStore } = await import('./services/eventstore-singleton.js');
      const eventStore = getEventStore();
      if (eventStore?.store) {
        await eventStore.store.close();
        shutdownLog.info('EventStore flushed and closed');
      }
      if (eventStore?.emitter) {
        await eventStore.emitter.close();
      }
    } catch (err) {
      shutdownLog.warn('EventStore flush failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    }

    try {
      const { flushBufferedPersistenceOnShutdown } =
        await import('./services/runtime-shutdown-flush.js');
      await flushBufferedPersistenceOnShutdown();
    } catch (err) {
      shutdownLog.warn('Buffered persistence flush failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    }

    try {
      const { shutdownAuditStore } = await import('./services/audit-store-singleton.js');
      await shutdownAuditStore();
    } catch (err) {
      shutdownLog.warn('Audit store shutdown failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    }

    await closeClickHouseClient();

    await disconnectDatabase();
    await disconnectRedis();

    if (exitProcess) {
      process.exit(0);
    }
  } catch (err) {
    shutdownLog.error('Shutdown error, forcing exit', {
      error: err instanceof Error ? err.message : String(err),
    });
    if (exitProcess) {
      process.exit(1);
    }
  } finally {
    if (forceTimer) clearTimeout(forceTimer);
    if (!exitProcess) {
      isShuttingDown = false;
    }
  }
}

process.on('SIGTERM', () => shutdownRuntimeServer());
process.on('SIGINT', () => shutdownRuntimeServer());

export { app, server, wss, wssSDK, shutdownRuntimeServer };
