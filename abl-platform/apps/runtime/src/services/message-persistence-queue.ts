/**
 * Message Persistence Queue
 *
 * BullMQ-backed queue for writing messages to the database.
 * Batches writes to avoid per-message round-trips at scale.
 * Falls back to direct DB writes when Redis is unavailable.
 *
 * Architecture:
 *   Producer (WS handler) → BullMQ Queue (Redis) → Worker → MongoDB
 *   Fallback: Producer → direct DB write (no Redis)
 */

import crypto from 'crypto';
import type { Queue, Worker } from 'bullmq';

import { containsPII, redactPII } from '@abl/compiler';
import { createLogger } from '@abl/compiler/platform';
import type { MessageMetadata } from '@abl/compiler/platform/core/types.js';

import { getTenantConfigService, PLAN_LIMITS } from './tenant-config.js';
import {
  CircuitBreakerRegistry,
  type BreakerHandle,
  CircuitOpenError,
} from '@agent-platform/circuit-breaker';
import { BULLMQ_CLUSTER_SAFE_PREFIX } from '@agent-platform/redis';
import { runWithTenantContext, getTenantContextData } from '@agent-platform/shared-auth/middleware';
import { getCurrentTenantContext } from '@agent-platform/database/mongo';
import {
  batchCreateMessages,
  findSessionPersistenceContexts,
  applySessionTurnUpdate,
} from '../repos/session-repo.js';
import { isDatabaseAvailable } from '../db/index.js';
import { getStores, DualWriteMessageStore } from './stores/store-factory.js';
import { getTraceStore } from './trace-store.js';
import type { TraceEventWithId } from '../types/index.js';
import {
  isTenantEncryptionReady,
  encryptForTenantAuto,
  decryptForTenantAuto,
  wrapJobDataForEncrypt,
  unwrapJobDataForDecrypt,
} from '@agent-platform/shared/encryption';
import type { ProductionExecutionScope } from './session/execution-scope.js';
import { ScopeValidationError, assertProductionExecutionScope } from './session/scope-policy.js';
import {
  serializePersistedStructuredMessageEnvelope,
  type PersistedMessageStructuredContent,
} from './session/persisted-message-content.js';
import type { ResponseMessageMetadata } from './channel/response-provenance.js';
import { resolveProjectPIISnapshot } from './pii/session-pii-context.js';
import { transformStructuredOutputPayload } from './execution/session-output-protection.js';

const log = createLogger('message-persistence-queue');

// =============================================================================
// TYPES
// =============================================================================

interface MessageJobData {
  dbSessionId: string;
  role: string;
  content: string;
  contentEnvelope?: string;
  channel: string;
  tenantId?: string;
  projectId?: string;
  traceId?: string;
  contactId?: string;
  metadata?: ResponseMessageMetadata;
  hasPII: boolean;
  enqueuedAt: number;
  idempotencyKey: string;
  /** Optional explicit message id (ABLP-1068 — transport responseMessageId binding). */
  messageId?: string;
  /** Optional agent attribution (ABLP-1068 — first-class column for per-agent analytics). */
  agentName?: string;
}

export interface PersistMessageRequest {
  dbSessionId: string;
  role: string;
  content: string;
  channel?: string;
  tenantId?: string;
  traceId?: string;
  contactId?: string;
  projectId?: string;
  messageTimestamp?: number;
  structuredContent?: PersistedMessageStructuredContent;
  metadata?: Partial<MessageMetadata>;
  /**
   * Optional explicit message id (ABLP-1068).
   * When supplied, the persisted row's id MUST equal this value across all
   * stores (Mongo `_id`, CH `message_id`, in-memory `id`). This is what binds
   * the transport `responseMessageId` to the durable record so downstream
   * features (feedback capture, analytics joins) can reference it directly.
   */
  messageId?: string;
  /**
   * Optional agent attribution (ABLP-1068).
   * Persisted as a top-level column AND surfaced in `metadata.agentName`.
   */
  agentName?: string;
}

export interface ScopedPersistenceEnvelope {
  scope: ProductionExecutionScope;
  message: {
    dbSessionId: string;
    role: string;
    content: string;
    structuredContent?: PersistedMessageStructuredContent;
    metadata?: ResponseMessageMetadata;
    channel: string;
    traceId?: string;
    messageTimestamp?: number;
    /** Optional explicit message id (ABLP-1068). */
    messageId?: string;
    /** Optional agent attribution (ABLP-1068). */
    agentName?: string;
  };
}

// =============================================================================
// PII DETECTION
// =============================================================================

const REDACT_PII_ON_PERSIST = process.env.REDACT_PII_ON_PERSIST === 'true';

/** Resolve whether PII should be redacted for this tenant. */
async function shouldRedactPII(tenantId?: string): Promise<boolean> {
  if (REDACT_PII_ON_PERSIST) return true;
  if (!tenantId) return true; // fail-safe: scrub when tenant unknown
  try {
    const tenantCfg = await getTenantConfigService().getConfigAsync(tenantId);
    return tenantCfg?.security?.scrubPII ?? true;
  } catch {
    return true; // fail-safe: scrub if config unavailable
  }
}

// =============================================================================
// TURN METRICS
// =============================================================================

export interface TurnMetrics {
  dbSessionId: string;
  tenantId?: string;
  tokensIn: number;
  tokensOut: number;
  cost: number;
  traceEventCount: number;
  errorCount: number;
  handoffCount: number;
}

export interface ScopedTurnMetricsEnvelope {
  scope: ProductionExecutionScope;
  metrics: Omit<TurnMetrics, 'tenantId'>;
}

interface MetricsAccumulator {
  tenantId: string;
  tokensIn: number;
  tokensOut: number;
  cost: number;
  traceEventCount: number;
  errorCount: number;
  handoffCount: number;
}

interface MessageBatchJobData {
  messages: MessageJobData[];
  metrics?: Record<string, MetricsAccumulator>;
}

// =============================================================================
// STATE
// =============================================================================

let bullQueue: Queue | null = null;
let bullWorker: Worker | null = null;
let bullInitAttempted = false;
let bullAvailable = false;

// Circuit breaker for MongoDB writes in the BullMQ worker.
// Initialized alongside BullMQ — requires the same Redis connection.
let mongoPersistBreaker: BreakerHandle | null = null;

// In-memory buffer for batching (used when Redis available)
let messageBuffer = new Map<string, MessageJobData[]>();
let metricsBuffer = new Map<string, MetricsAccumulator>();
let totalBuffered = 0;
let flushTimer: NodeJS.Timeout | null = null;

// Per-session Promise chain: serializes persistMessage calls so messages
// enqueue in call order regardless of async init races.
const sessionChains = new Map<string, Promise<void>>();
const MAX_SESSION_CHAINS = 5000; // Evict oldest chains when exceeded
const FLUSH_INTERVAL_MS = parsePositiveIntEnv(
  process.env.MESSAGE_PERSISTENCE_FLUSH_INTERVAL_MS,
  500,
);
const MAX_BATCH_SIZE = parsePositiveIntEnv(process.env.MESSAGE_PERSISTENCE_MAX_BATCH_SIZE, 25);
const MAX_TOTAL_BUFFERED = 10000; // Global high-water mark
/** Maximum entries in the metricsBuffer before eviction */
export const MAX_METRICS_BUFFER = 10000;
/** Fallback retention when tenant config is unavailable — TEAM is safer than FREE */
const FALLBACK_MESSAGE_TTL_DAYS = PLAN_LIMITS.TEAM.messageRetentionDays;
const WORKER_CONCURRENCY = parsePositiveIntEnv(
  process.env.MESSAGE_PERSISTENCE_WORKER_CONCURRENCY,
  2,
);

// Worker auto-recovery state
let workerRecoveryInProgress = false;
const MAX_WORKER_RECOVERY_DELAY_MS = 30_000;
const INITIAL_WORKER_RECOVERY_DELAY_MS = 1_000;
let workerRecoveryAttempts = 0;
const MAX_BATCH_LOG_ITEMS = 10;
const MISSING_PROJECT_CONTEXT_LOG_TTL_MS = 5 * 60 * 1000;
const MAX_MISSING_PROJECT_CONTEXT_LOG_KEYS = 1000;
const missingProjectContextLogCache = new Map<string, number>();
const legacyPersistenceApiLogCache = new Set<string>();

// Lazy message store — delegates to the store factory
function getMessageStore() {
  return getStores().message;
}

function parsePositiveIntEnv(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function shouldLogMissingProjectContext(cacheKey: string): boolean {
  const now = Date.now();

  for (const [key, expiresAt] of missingProjectContextLogCache) {
    if (expiresAt <= now) {
      missingProjectContextLogCache.delete(key);
    }
  }

  const existingExpiry = missingProjectContextLogCache.get(cacheKey);
  if (existingExpiry && existingExpiry > now) {
    return false;
  }

  if (missingProjectContextLogCache.size >= MAX_MISSING_PROJECT_CONTEXT_LOG_KEYS) {
    const oldestKey = missingProjectContextLogCache.keys().next().value;
    if (oldestKey) {
      missingProjectContextLogCache.delete(oldestKey);
    }
  }

  missingProjectContextLogCache.set(cacheKey, now + MISSING_PROJECT_CONTEXT_LOG_TTL_MS);
  return true;
}

function summarizeMessageBatch(messages: MessageJobData[]) {
  const sessionIds = new Set<string>();
  const tenantIds = new Set<string>();
  const projectIds = new Set<string>();
  const channels = new Set<string>();

  let missingTenantIdCount = 0;
  let missingProjectIdCount = 0;

  for (const message of messages) {
    sessionIds.add(message.dbSessionId);
    channels.add(message.channel);

    if (message.tenantId) {
      tenantIds.add(message.tenantId);
    } else {
      missingTenantIdCount++;
    }

    if (message.projectId) {
      projectIds.add(message.projectId);
    } else {
      missingProjectIdCount++;
    }
  }

  return {
    messageCount: messages.length,
    sessionCount: sessionIds.size,
    tenantCount: tenantIds.size,
    projectCount: projectIds.size,
    missingTenantIdCount,
    missingProjectIdCount,
    channels: [...channels].slice(0, MAX_BATCH_LOG_ITEMS),
    sampleSessionIds: [...sessionIds].slice(0, MAX_BATCH_LOG_ITEMS),
    tenantIds: [...tenantIds].slice(0, MAX_BATCH_LOG_ITEMS),
    projectIds: [...projectIds].slice(0, MAX_BATCH_LOG_ITEMS),
  };
}

function logLegacyPersistenceApiUsage(apiName: 'persistMessage' | 'persistTurnMetrics'): void {
  if (legacyPersistenceApiLogCache.has(apiName)) {
    return;
  }

  legacyPersistenceApiLogCache.add(apiName);
  log.warn('Legacy message persistence API used without canonical execution scope', {
    apiName,
    compatibilityPath: 'legacy_optional_scope',
  });
}

function resolveScopedContactId(scope: ProductionExecutionScope): string | undefined {
  return scope.subject.kind === 'contact' ? scope.subject.contactId : undefined;
}

function assertScopedMessagePayload(
  message: ScopedPersistenceEnvelope['message'],
): asserts message is ScopedPersistenceEnvelope['message'] {
  if (typeof message.dbSessionId !== 'string' || message.dbSessionId.trim().length === 0) {
    throw new ScopeValidationError(
      'INVALID_SESSION_SCOPE',
      'Scoped message payload requires a non-empty dbSessionId',
      {
        field: 'message.dbSessionId',
        reason: 'required_non_empty_string',
        received: message.dbSessionId,
      },
    );
  }

  if (typeof message.role !== 'string' || message.role.trim().length === 0) {
    throw new ScopeValidationError(
      'INVALID_SESSION_SCOPE',
      'Scoped message payload requires a non-empty role',
      {
        field: 'message.role',
        reason: 'required_non_empty_string',
        received: message.role,
      },
    );
  }

  if (typeof message.content !== 'string') {
    throw new ScopeValidationError(
      'INVALID_SESSION_SCOPE',
      'Scoped message payload content must be a string',
      {
        field: 'message.content',
        reason: 'required_string',
        received: message.content,
      },
    );
  }

  if (typeof message.channel !== 'string' || message.channel.trim().length === 0) {
    throw new ScopeValidationError(
      'INVALID_SESSION_SCOPE',
      'Scoped message payload requires a non-empty channel',
      {
        field: 'message.channel',
        reason: 'required_non_empty_string',
        received: message.channel,
      },
    );
  }
}

function assertScopedTurnMetricsPayload(
  metrics: ScopedTurnMetricsEnvelope['metrics'],
): asserts metrics is ScopedTurnMetricsEnvelope['metrics'] {
  if (typeof metrics.dbSessionId !== 'string' || metrics.dbSessionId.trim().length === 0) {
    throw new ScopeValidationError(
      'INVALID_SESSION_SCOPE',
      'Scoped turn metrics require a non-empty dbSessionId',
      {
        field: 'metrics.dbSessionId',
        reason: 'required_non_empty_string',
        received: metrics.dbSessionId,
      },
    );
  }
}

async function backfillMissingProjectIds(messages: MessageJobData[]): Promise<MessageJobData[]> {
  const missingProjectMessages = messages.filter((message) => !message.projectId);
  if (missingProjectMessages.length === 0) {
    return messages;
  }

  const batchSummary = summarizeMessageBatch(missingProjectMessages);

  try {
    const sessionContexts = await findSessionPersistenceContexts(
      missingProjectMessages.map((message) => message.dbSessionId),
      missingProjectMessages.map((message) => message.tenantId).filter(Boolean) as string[],
    );
    const contextBySessionId = new Map(sessionContexts.map((context) => [context.id, context]));

    let repairedCount = 0;
    let unresolvedCount = 0;
    let tenantMismatchCount = 0;

    const repairedMessages = messages.map((message) => {
      if (message.projectId) {
        return message;
      }

      const sessionContext = contextBySessionId.get(message.dbSessionId);
      if (!sessionContext?.projectId) {
        unresolvedCount++;
        return message;
      }

      if (
        message.tenantId &&
        sessionContext.tenantId &&
        sessionContext.tenantId !== message.tenantId
      ) {
        tenantMismatchCount++;
        unresolvedCount++;
        return message;
      }

      repairedCount++;
      return {
        ...message,
        projectId: sessionContext.projectId,
      };
    });

    if (repairedCount > 0 || unresolvedCount > 0 || tenantMismatchCount > 0) {
      log.warn('Resolved missing projectId values for message persistence batch', {
        ...batchSummary,
        repairedCount,
        unresolvedCount,
        tenantMismatchCount,
      });
    }

    return repairedMessages;
  } catch (err: unknown) {
    log.error('Failed to resolve missing projectId values for message persistence batch', {
      ...batchSummary,
      error: err instanceof Error ? err.message : String(err),
    });
    return messages;
  }
}

function logMissingProjectContext(
  stage: 'enqueue' | 'direct-write',
  message: MessageJobData,
): void {
  if (message.projectId) {
    return;
  }

  const cacheKey = [
    stage,
    message.channel,
    message.dbSessionId,
    message.tenantId ?? '_missing-tenant',
  ].join(':');

  if (!shouldLogMissingProjectContext(cacheKey)) {
    return;
  }

  log.warn('Persist message missing projectId context', {
    stage,
    role: message.role,
    hasTraceId: !!message.traceId,
    hasContactId: !!message.contactId,
    ...summarizeMessageBatch([message]),
  });
}

/**
 * Build a tenant-context object suitable for runWithTenantContext.
 * Used by background workers (BullMQ worker, flush timer) that need to
 * establish ALS context from job data rather than from an HTTP request.
 */
function buildWorkerTenantContext(tenantId: string) {
  return {
    tenantId,
    userId: 'system',
    role: 'system' as const,
    permissions: [] as string[],
    authType: 'api_key' as const,
    isSuperAdmin: false,
  };
}

/**
 * Group messages by tenantId for batched tenant-scoped operations.
 */
function groupByTenant(messages: MessageJobData[]): Map<string, MessageJobData[]> {
  const groups = new Map<string, MessageJobData[]>();
  for (const m of messages) {
    if (!m.tenantId) continue;
    let group = groups.get(m.tenantId);
    if (!group) {
      group = [];
      groups.set(m.tenantId, group);
    }
    group.push(m);
  }
  return groups;
}

/**
 * Encrypt message content before enqueuing to BullMQ (Redis).
 * Groups messages by tenant and encrypts each group inside the correct ALS
 * context so DEK lookups through MongoDB pass the tenant isolation plugin.
 * Messages without tenantId are passed through unchanged.
 */
async function encryptBatchForQueue(batch: MessageBatchJobData): Promise<MessageBatchJobData> {
  if (!isTenantEncryptionReady()) {
    throw new Error('Tenant DEK encryption is not initialized for message persistence queue.');
  }
  const svc = {
    encryptForTenant: (plaintext: string, tenantId: string) =>
      encryptForTenantAuto(plaintext, tenantId),
    decryptForTenant: (ciphertext: string, tenantId: string) =>
      decryptForTenantAuto(ciphertext, tenantId),
  };

  // Group by tenant so each runWithTenantContext call covers all messages for that tenant,
  // allowing DEK cache hits within the group instead of per-message ALS overhead.
  const noTenantMessages = batch.messages.filter((m) => !m.tenantId);
  const byTenant = groupByTenant(batch.messages);
  const encryptedGroups = await Promise.all(
    [...byTenant.entries()].map(([tenantId, group]) =>
      runWithTenantContext(buildWorkerTenantContext(tenantId), () =>
        Promise.all(
          group.map(
            async (m) =>
              (await wrapJobDataForEncrypt(
                'message-persistence',
                m as unknown as Record<string, unknown>,
                svc,
              )) as unknown as MessageJobData,
          ),
        ),
      ),
    ),
  );

  return {
    ...batch,
    messages: [...noTenantMessages, ...encryptedGroups.flat()],
  };
}

/**
 * Decrypt message content after dequeuing from BullMQ (Redis).
 * Reverses encryptBatchForQueue. Groups by tenant for correct ALS context.
 */
async function decryptBatchFromQueue(batch: MessageBatchJobData): Promise<MessageBatchJobData> {
  if (!isTenantEncryptionReady()) {
    throw new Error('Tenant DEK encryption is not initialized for message persistence queue.');
  }
  const svc = {
    encryptForTenant: (plaintext: string, tenantId: string) =>
      encryptForTenantAuto(plaintext, tenantId),
    decryptForTenant: (ciphertext: string, tenantId: string) =>
      decryptForTenantAuto(ciphertext, tenantId),
  };

  const noTenantMessages = batch.messages.filter((m) => !m.tenantId);
  const byTenant = groupByTenant(batch.messages);
  const decryptedGroups = await Promise.all(
    [...byTenant.entries()].map(([tenantId, group]) =>
      runWithTenantContext(buildWorkerTenantContext(tenantId), () =>
        Promise.all(
          group.map(
            async (m) =>
              (await unwrapJobDataForDecrypt(
                'message-persistence',
                m as unknown as Record<string, unknown>,
                svc,
              )) as unknown as MessageJobData,
          ),
        ),
      ),
    ),
  );

  return {
    ...batch,
    messages: [...noTenantMessages, ...decryptedGroups.flat()],
  };
}

// =============================================================================
// ALS DIAGNOSTICS (sampled — avoids log flood at scale)
// =============================================================================

/**
 * Log the current state of both ALS layers for debugging tenant isolation issues.
 * Sampled: only logs once per DIAG_SAMPLE_INTERVAL calls to limit volume at scale.
 * Always logs when a context mismatch is detected (potential bug).
 */
let _diagCounter = 0;
const DIAG_SAMPLE_INTERVAL = 100; // Log 1 in every 100 calls
const DIAG_VERBOSE = process.env.MESSAGE_PERSISTENCE_DIAG_VERBOSE === 'true';

function logALSState(label: string, expectedTenantId?: string): void {
  _diagCounter++;
  const shouldSample = DIAG_VERBOSE || _diagCounter % DIAG_SAMPLE_INTERVAL === 1;

  const sharedAuthCtx = getTenantContextData();
  const dbCtx = getCurrentTenantContext();
  const sharedTenant = sharedAuthCtx?.tenantId ?? '(none)';
  const dbTenant = dbCtx?.tenantId ?? '(none)';
  const match = expectedTenantId
    ? sharedTenant === expectedTenantId && dbTenant === expectedTenantId
    : sharedTenant === dbTenant;

  // Always log mismatches — they indicate a bug
  if (!match) {
    log.warn(`ALS-diag MISMATCH [${label}]`, {
      sharedAuthTenantId: sharedTenant,
      sharedAuthIsSuperAdmin: sharedAuthCtx?.isSuperAdmin ?? false,
      dbTenantId: dbTenant,
      dbIsSuperAdmin: dbCtx?.isSuperAdmin ?? false,
      expectedTenantId: expectedTenantId ?? '(not specified)',
      contextMatch: false,
    });
    return;
  }

  if (!shouldSample) return;

  log.info(`ALS-diag [${label}]`, {
    sharedAuthTenantId: sharedTenant,
    dbTenantId: dbTenant,
    expectedTenantId: expectedTenantId ?? '(not specified)',
    contextMatch: true,
    sample: `${_diagCounter}/${DIAG_SAMPLE_INTERVAL}`,
  });
}

// =============================================================================
// INITIALIZATION
// =============================================================================

/**
 * Process a single tenant's messages: persist to MongoDB, dual-write to ClickHouse,
 * and update session activity/metrics. Runs inside the correct ALS context.
 */
async function processTenantBatch(
  tenantId: string,
  tenantMessages: MessageJobData[],
  batchMetrics: Record<string, MetricsAccumulator> | undefined,
): Promise<void> {
  logALSState('workerJobHandler:tenant-batch:inside-context', tenantId);

  // Resolve per-tenant retention
  let tenantRetentionDays = FALLBACK_MESSAGE_TTL_DAYS;
  try {
    const cfg = await getTenantConfigService().getConfigAsync(tenantId);
    tenantRetentionDays = cfg.limits?.messageRetentionDays ?? FALLBACK_MESSAGE_TTL_DAYS;
  } catch (err: unknown) {
    log.warn('Failed to resolve tenant retention config', {
      tenantId,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  // Resolve per-project retention overrides (caps at plan limit)
  const projectRetentionCache = new Map<string, number | null>();
  for (const m of tenantMessages) {
    if (!m.projectId) continue;
    const key = `${tenantId}:${m.projectId}`;
    if (projectRetentionCache.has(key)) continue;
    try {
      projectRetentionCache.set(
        key,
        await getTenantConfigService().resolveProjectMessageRetention(tenantId, m.projectId),
      );
    } catch (err: unknown) {
      log.warn('Failed to resolve project retention override', {
        tenantId,
        projectId: m.projectId,
        error: err instanceof Error ? err.message : String(err),
      });
      projectRetentionCache.set(key, null);
    }
  }

  // Build messages with correct retention (encryption handled by Mongoose plugin)
  const mappedMessages = tenantMessages.map((m) => {
    const projectKey = m.projectId ? `${tenantId}:${m.projectId}` : null;
    const projectRetention = projectKey ? projectRetentionCache.get(projectKey) : null;
    const retentionDays = projectRetention ?? tenantRetentionDays;
    const enqueuedDate = new Date(m.enqueuedAt);

    return {
      sessionId: m.dbSessionId,
      tenantId: m.tenantId,
      projectId: m.projectId || '',
      role: m.role,
      content: m.content,
      ...(m.contentEnvelope ? { contentEnvelope: m.contentEnvelope } : {}),
      channel: m.channel,
      ...(m.metadata ? { metadata: m.metadata } : {}),
      timestamp: enqueuedDate,
      idempotencyKey: m.idempotencyKey,
      contactId: m.contactId,
      hasPII: m.hasPII,
      encrypted: isTenantEncryptionReady(),
      expiresAt: new Date(enqueuedDate.getTime() + retentionDays * 86_400_000),
      ...(m.messageId ? { messageId: m.messageId } : {}),
      agentName: m.agentName ?? '',
    };
  });

  // Pre-compute message counts and tenant-scoped metrics for the session turn update.
  const msgCountBySession = new Map<string, number>();
  for (const m of tenantMessages) {
    msgCountBySession.set(m.dbSessionId, (msgCountBySession.get(m.dbSessionId) ?? 0) + 1);
  }

  const scopedMetricsBySession = new Map<string, MetricsAccumulator>();
  if (batchMetrics) {
    for (const [sid, metrics] of Object.entries(batchMetrics)) {
      if (metrics.tenantId === tenantId && msgCountBySession.has(sid)) {
        scopedMetricsBySession.set(sid, metrics);
      }
    }
  }

  const allSessionIds = new Set([...msgCountBySession.keys(), ...scopedMetricsBySession.keys()]);

  // ── Step 1: Insert messages ────────────────────────────────────────────
  // Retries are safe via idempotencyKey (duplicate inserts ignored, code 11000).
  try {
    const insertMessages = async () => {
      // structuredClone: defense-in-depth against the Mongoose encryption
      // plugin's in-place mutation of doc[field] during pre('insertMany').
      await batchCreateMessages(structuredClone(mappedMessages), { tenantId });
    };

    if (mongoPersistBreaker) {
      await mongoPersistBreaker.execute(insertMessages);
    } else {
      await insertMessages();
    }
  } catch (err: unknown) {
    const batchSummary = summarizeMessageBatch(tenantMessages);

    if (err instanceof CircuitOpenError) {
      log.warn('Message persistence batch rejected by circuit breaker', {
        ...batchSummary,
        tenantId,
        retryAfterMs: err.retryAfterMs,
        breakerLevel: err.level,
        breakerKey: err.key,
      });
    } else {
      log.error('Message persistence insert failed', {
        ...batchSummary,
        tenantId,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    throw err;
  }

  // ── Step 2: Update session turn counters ──────────────────────────────
  // $inc is NOT idempotent — if BullMQ retries the whole job, messages are
  // deduplicated by idempotencyKey but the $inc double-counts. The drift
  // is bounded to one batch per retry and acceptable for approximate
  // session-level counters (messageCount, tokenCount, etc.).
  // Running independently (not in a transaction with the insert) eliminates
  // write conflicts that caused transient errors under high pod counts.
  try {
    await Promise.all(
      [...allSessionIds].map((sid) => {
        const msgCount = msgCountBySession.get(sid) ?? 0;
        const metrics = scopedMetricsBySession.get(sid);
        const totalTokens = metrics ? metrics.tokensIn + metrics.tokensOut : 0;

        return applySessionTurnUpdate(
          sid,
          {
            messageCountIncrement: msgCount,
            tokenCountIncrement: totalTokens,
            estimatedCostIncrement: metrics?.cost ?? 0,
            traceEventCountIncrement: metrics?.traceEventCount ?? 0,
            errorCountIncrement: metrics?.errorCount ?? 0,
            handoffCountIncrement: metrics?.handoffCount ?? 0,
            touchLastActivityAt: msgCount > 0 || !!metrics,
          },
          tenantId,
          { requireMatched: true },
        );
      }),
    );
  } catch (err: unknown) {
    // Log but don't throw — messages are already persisted. Counters
    // will be under-counted for this batch; acceptable for approximate metrics.
    log.warn('Session turn update failed after successful message insert', {
      tenantId,
      sessionIds: [...allSessionIds],
      error: err instanceof Error ? err.message : String(err),
    });
  }

  // Fire-and-forget ClickHouse dual-write
  try {
    const messageStore = getMessageStore();
    if (
      messageStore instanceof DualWriteMessageStore &&
      process.env.USE_MONGO_CLICKHOUSE === 'true'
    ) {
      for (const m of tenantMessages) {
        messageStore.writeToClickHouseOnly({
          sessionId: m.dbSessionId,
          role: m.role as 'user' | 'assistant' | 'system' | 'tool',
          content: m.content,
          channel: m.channel as import('@abl/compiler/platform/core/types').Channel,
          traceId: m.traceId || '',
          contactId: m.contactId,
          hasPII: m.hasPII,
          tenantId: m.tenantId,
          projectId: m.projectId,
          ...(m.messageId ? { messageId: m.messageId } : {}),
          ...(m.agentName ? { agentName: m.agentName } : {}),
          metadata: m.metadata as unknown as Partial<
            import('@abl/compiler/platform/core/types').MessageMetadata
          >,
        });
      }
    }
  } catch (err) {
    log.warn('ClickHouse dual-write in worker failed', {
      tenantId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/** Worker job handler — extracted so it can be reused during recovery. */
async function workerJobHandler(job: { data: MessageBatchJobData }): Promise<void> {
  // Diagnostic: log ALS state at worker entry BEFORE we set any context.
  // This reveals stale ALS leaks from the parent async context.
  logALSState('workerJobHandler:entry:pre-context');

  const batch = await decryptBatchFromQueue(job.data);

  // Fail-closed: reject messages missing tenantId (required for isolation + encryption)
  const invalidMessages = batch.messages.filter((m) => !m.tenantId);
  if (invalidMessages.length > 0) {
    log.error('Dropping messages without tenantId — fail-closed', {
      count: invalidMessages.length,
      sessionIds: [...new Set(invalidMessages.map((m) => m.dbSessionId))],
    });
  }
  const tenantScopedMessages = batch.messages.filter((m) => !!m.tenantId);
  const projectScopedMessages = await backfillMissingProjectIds(tenantScopedMessages);

  const invalidProjectMessages = projectScopedMessages.filter((message) => !message.projectId);
  if (invalidProjectMessages.length > 0) {
    log.error('Dropping messages without projectId — fail-closed', {
      ...summarizeMessageBatch(invalidProjectMessages),
    });
  }
  const validMessages = projectScopedMessages.filter((message) => !!message.projectId);

  // ── Group by tenant and process in parallel ────────────────────────
  // Each tenant's batch runs inside runWithTenantContext so the Mongoose
  // tenant-isolation plugin sees the correct ALS context on insertMany.
  // Tenants are processed concurrently since they're independent.
  const messagesByTenant = groupByTenant(validMessages);

  await Promise.all(
    [...messagesByTenant.entries()].map(([tenantId, tenantMessages]) =>
      runWithTenantContext(buildWorkerTenantContext(tenantId), () =>
        processTenantBatch(tenantId, tenantMessages, batch.metrics),
      ),
    ),
  );

  // Handle metrics-only sessions that had no messages in this batch.
  // The MetricsAccumulator now carries tenantId, so we can process them
  // inside the correct tenant context instead of dropping them.
  if (batch.metrics) {
    const processedSessionIds = new Set(validMessages.map((m) => m.dbSessionId));
    const metricsOnlyEntries = Object.entries(batch.metrics).filter(
      ([sid]) => !processedSessionIds.has(sid),
    );

    if (metricsOnlyEntries.length > 0) {
      // Group metrics-only sessions by tenantId for batched ALS scoping
      const metricsOnlyByTenant = new Map<string, Array<[string, MetricsAccumulator]>>();
      const orphaned: string[] = [];
      for (const entry of metricsOnlyEntries) {
        const [sid, acc] = entry;
        if (!acc.tenantId) {
          orphaned.push(sid);
          continue;
        }
        let group = metricsOnlyByTenant.get(acc.tenantId);
        if (!group) {
          group = [];
          metricsOnlyByTenant.set(acc.tenantId, group);
        }
        group.push(entry);
      }

      if (orphaned.length > 0) {
        log.warn('Metrics-only sessions dropped — no tenantId in accumulator', {
          sessionIds: orphaned,
        });
      }

      // Process each tenant's metrics-only sessions — single atomic update per session
      await Promise.all(
        [...metricsOnlyByTenant.entries()].map(([tenantId, entries]) =>
          runWithTenantContext(buildWorkerTenantContext(tenantId), () =>
            Promise.all(
              entries.map(([sid, metrics]) => {
                const totalTokens = metrics.tokensIn + metrics.tokensOut;
                return applySessionTurnUpdate(
                  sid,
                  {
                    tokenCountIncrement: totalTokens,
                    estimatedCostIncrement: metrics.cost,
                    traceEventCountIncrement: metrics.traceEventCount,
                    errorCountIncrement: metrics.errorCount,
                    handoffCountIncrement: metrics.handoffCount,
                    touchLastActivityAt: true,
                  },
                  tenantId,
                ).catch((err) =>
                  log.warn('metrics-only session turn update failed', {
                    sessionId: sid,
                    tenantId,
                    error: err instanceof Error ? err.message : String(err),
                  }),
                );
              }),
            ),
          ),
        ),
      );
    }
  }
}

/**
 * Create a BullMQ worker with error handling and auto-recovery.
 * On close or fatal error, schedules re-creation with exponential backoff.
 */
async function createWorker(): Promise<void> {
  const { getRedisHandle } = await import('./redis/redis-client.js');
  const handle = getRedisHandle();
  if (!handle) return;

  const { Worker: BullWorker } = await import('bullmq');

  // Close existing worker if any (best-effort)
  if (bullWorker) {
    try {
      await bullWorker.close();
    } catch {
      // Already dead — that's why we're recreating
    }
    bullWorker = null;
  }

  // handle.duplicate() is cluster-aware (rebuilds Cluster from seed nodes
  // when client is a Cluster instance). maxRetriesPerRequest: null is
  // required for BullMQ blocking commands.
  bullWorker = new BullWorker(
    'message-persistence',
    async (job) => workerJobHandler(job as { data: MessageBatchJobData }),
    {
      connection: handle.duplicate({ maxRetriesPerRequest: null }),
      prefix: BULLMQ_CLUSTER_SAFE_PREFIX,
      concurrency: WORKER_CONCURRENCY,
    },
  );

  bullWorker.on('error', (err: Error) => {
    log.error('BullMQ message-persistence worker error', {
      error: err.message,
    });
  });

  bullWorker.on('failed', (job, err) => {
    const isCircuitOpen = err instanceof CircuitOpenError;
    const batchData = job?.data as MessageBatchJobData | undefined;
    const failedMessages = batchData?.messages ?? [];
    log.error('BullMQ message-persistence job failed', {
      jobId: job?.id,
      attemptsMade: job?.attemptsMade,
      maxAttempts: job?.opts?.attempts,
      ...summarizeMessageBatch(failedMessages),
      isCircuitOpen,
      isTenantViolation: err.message?.includes('Tenant isolation violation'),
      error: err.message,
      errorStack: err.stack?.split('\n').slice(0, 5).join(' | '),
      ...(err instanceof CircuitOpenError
        ? {
            retryAfterMs: err.retryAfterMs,
            breakerLevel: err.level,
            breakerKey: err.key,
          }
        : {}),
    });
  });

  // Auto-recover: when the worker closes unexpectedly, recreate it.
  bullWorker.on('closed', () => {
    log.warn('BullMQ message-persistence worker closed, scheduling recovery');
    scheduleWorkerRecovery();
  });

  // Reset backoff on successful start
  workerRecoveryAttempts = 0;
  workerRecoveryInProgress = false;
}

/**
 * Schedule worker re-creation with exponential backoff.
 * Caps at MAX_WORKER_RECOVERY_DELAY_MS between attempts.
 */
function scheduleWorkerRecovery(): void {
  if (workerRecoveryInProgress) return;
  workerRecoveryInProgress = true;

  const delay = Math.min(
    INITIAL_WORKER_RECOVERY_DELAY_MS * Math.pow(2, workerRecoveryAttempts),
    MAX_WORKER_RECOVERY_DELAY_MS,
  );
  workerRecoveryAttempts++;

  log.info('Worker recovery scheduled', { delay, attempt: workerRecoveryAttempts });

  setTimeout(async () => {
    try {
      await createWorker();
      log.info('BullMQ message-persistence worker recovered', {
        attempt: workerRecoveryAttempts,
      });
    } catch (err) {
      log.error('Worker recovery failed', {
        error: err instanceof Error ? err.message : String(err),
        attempt: workerRecoveryAttempts,
      });
      workerRecoveryInProgress = false;
      scheduleWorkerRecovery();
    }
  }, delay);
}

async function initBullMQ(): Promise<boolean> {
  if (bullInitAttempted) return bullAvailable;
  bullInitAttempted = true;

  try {
    const { getRedisClient, getRedisHandle, isRedisAvailable } =
      await import('./redis/redis-client.js');
    if (!isRedisAvailable()) {
      log.info('Redis not available, using direct writes');
      return false;
    }

    const redis = getRedisClient();
    const handle = getRedisHandle();
    if (!redis || !handle) return false;

    const { Queue: BullQueue } = await import('bullmq');

    // BullMQ Workers use blocking Redis commands (BRPOPLPUSH / XREADGROUP)
    // which require maxRetriesPerRequest: null. The shared client sets
    // maxRetriesPerRequest: 3, so we override on the duplicated connection.
    // handle.duplicate() is cluster-aware.
    bullQueue = new BullQueue('message-persistence', {
      connection: handle.duplicate({ maxRetriesPerRequest: null }),
      prefix: BULLMQ_CLUSTER_SAFE_PREFIX,
      defaultJobOptions: {
        removeOnComplete: { count: 2000, age: 3600 },
        removeOnFail: { count: 1000, age: 604800 },
        attempts: 5,
        backoff: { type: 'exponential', delay: 2000 },
      },
    });

    // Initialize circuit breaker for MongoDB writes.
    // Uses 'system' tenant since message persistence is cross-tenant.
    const cbRegistry = new CircuitBreakerRegistry(redis, {
      defaults: {
        app: {
          failureThreshold: 5,
          successThreshold: 2,
          resetTimeout: 30_000,
          monitorWindow: 30_000,
          halfOpenMaxConcurrent: 1,
          failureRateThreshold: 50,
          minimumRequestCount: 3,
        },
      },
    });
    mongoPersistBreaker = cbRegistry.app('system', 'message-persistence-mongo');

    await createWorker();

    bullAvailable = true;
    log.info('BullMQ initialized for message persistence');

    // Recover stale jobs left in "active" state by a previous worker that
    // crashed or was killed. Without this, stale active jobs permanently
    // consume concurrency slots and block new jobs from processing.
    // Strategy: re-enqueue their data as new jobs, then remove the stale ones.
    try {
      const active = await bullQueue.getJobs(['active']);
      if (active.length > 0) {
        let recovered = 0;
        for (const job of active) {
          try {
            if (job.data) {
              await bullQueue.add(job.name, job.data);
            }
            await job.remove();
            recovered++;
          } catch {
            // Job may have been picked up by the new worker — safe to ignore
          }
        }
        if (recovered > 0) {
          log.info('Recovered stale active jobs', { recovered, total: active.length });
        }
      }
    } catch (err) {
      log.warn('Stale job recovery failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    }

    // Start periodic flush timer
    startFlushTimer();

    return true;
  } catch (err) {
    log.warn('BullMQ init failed, using direct writes', {
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}

// =============================================================================
// BATCHING
// =============================================================================

function startFlushTimer(): void {
  if (flushTimer) return;
  flushTimer = setInterval(() => {
    flushAllBuffers().catch((err) => {
      log.error('Flush error', { error: err instanceof Error ? err.message : String(err) });
    });
  }, FLUSH_INTERVAL_MS);
}

async function flushAllBuffers(): Promise<void> {
  if (!bullQueue || (messageBuffer.size === 0 && metricsBuffer.size === 0)) return;

  // Diagnostic: log ALS state at flush entry — reveals stale context from setInterval
  logALSState('flushAllBuffers:entry');

  // Atomic swap: replace the buffers with fresh Maps so concurrent writers
  // don't mutate the same Maps we're draining.
  const msgSnapshot = messageBuffer;
  const metricsSnapshot = metricsBuffer;
  messageBuffer = new Map();
  metricsBuffer = new Map();
  totalBuffered = 0;

  const allMessages: MessageJobData[] = [];
  for (const [, messages] of msgSnapshot) {
    allMessages.push(...messages);
  }

  // Convert metrics snapshot to a plain record for serialization
  const metricsRecord: Record<string, MetricsAccumulator> = {};
  for (const [sid, acc] of metricsSnapshot) {
    metricsRecord[sid] = acc;
  }
  const hasMetrics = Object.keys(metricsRecord).length > 0;

  if (allMessages.length === 0 && !hasMetrics) return;

  const uniqueTenantIds = [...new Set(allMessages.map((m) => m.tenantId).filter(Boolean))];
  log.info('Flushing message buffers', {
    messageCount: allMessages.length,
    metricsSessionCount: Object.keys(metricsRecord).length,
    uniqueTenantIds,
  });

  // Split into batches of MAX_BATCH_SIZE; attach metrics to the first batch
  try {
    if (allMessages.length === 0 && hasMetrics) {
      // Metrics-only flush (no messages in this batch)
      await bullQueue.add('message-batch', {
        messages: [],
        metrics: metricsRecord,
      } as MessageBatchJobData);
    } else {
      // Build all batch job data first, then encrypt + enqueue in parallel.
      // Sequential encryption of 400+ batches (10K messages / 25 per batch)
      // was a bottleneck at XL scale — parallelizing reduces flush latency.
      const batches: MessageBatchJobData[] = [];
      for (let i = 0; i < allMessages.length; i += MAX_BATCH_SIZE) {
        const batch = allMessages.slice(i, i + MAX_BATCH_SIZE);
        const jobData: MessageBatchJobData = { messages: batch };
        if (i === 0 && hasMetrics) {
          jobData.metrics = metricsRecord;
        }
        batches.push(jobData);
      }

      const encrypted = await Promise.all(batches.map((b) => encryptBatchForQueue(b)));
      // addBulk uses a single Redis pipeline instead of N individual add() calls.
      await bullQueue!.addBulk(encrypted.map((e) => ({ name: 'message-batch', data: e })));
    }
  } catch (err) {
    // Messages were already swapped out of the buffer — log the count so operators
    // know how many were dropped before investigating the BullMQ failure.
    log.error('Flush failed — messages dropped', {
      droppedMessages: allMessages.length,
      error: err instanceof Error ? err.message : String(err),
    });
    // Emit a TraceEvent per affected session so the drop is visible in the
    // trace pipeline alongside the session's execution history (Core Invariant 4).
    for (const [sid, messages] of msgSnapshot) {
      try {
        const event: TraceEventWithId = {
          id: crypto.randomUUID(),
          sessionId: sid,
          type: 'error',
          timestamp: new Date(),
          data: {
            reason: 'message_persistence_flush_failed',
            droppedCount: messages.length,
            error: err instanceof Error ? err.message : String(err),
          },
        };
        getTraceStore().addEvent(sid, event);
      } catch {
        // trace store failure must not mask the original flush error
      }
    }
    throw err;
  }
}

// =============================================================================
// PUBLIC API
// =============================================================================

/**
 * Enqueue a message for persistent storage.
 * Uses BullMQ with batching when Redis is available, falls back to direct DB writes.
 *
 * Messages for the same session are serialized via a per-session Promise chain
 * to guarantee enqueue order. This prevents async init races from swapping
 * user/assistant message ordering in the buffer.
 */
export async function persistMessage(
  dbSessionId: string,
  role: string,
  content: string,
  channel = 'web_debug',
  tenantId?: string,
  traceId?: string,
  contactId?: string,
  projectId?: string,
  /** Actual message generation time. When omitted, defaults to Date.now() at enqueue time. */
  messageTimestamp?: number,
  structuredContent?: PersistedMessageStructuredContent,
  metadata?: ResponseMessageMetadata,
): Promise<void> {
  logLegacyPersistenceApiUsage('persistMessage');

  return persistMessageRecord({
    dbSessionId,
    role,
    content,
    channel,
    tenantId,
    traceId,
    contactId,
    projectId,
    messageTimestamp,
    structuredContent,
    metadata: metadata as unknown as Partial<MessageMetadata> | undefined,
  });
}

export async function persistMessageRecord(params: PersistMessageRequest): Promise<void> {
  return enqueueMessagePersist({
    ...params,
    channel: params.channel ?? 'web_debug',
    metadata: params.metadata as unknown as ResponseMessageMetadata | undefined,
  });
}

export async function persistScopedMessage(envelope: ScopedPersistenceEnvelope): Promise<void> {
  assertProductionExecutionScope(envelope.scope);
  assertScopedMessagePayload(envelope.message);

  return enqueueMessagePersist({
    dbSessionId: envelope.message.dbSessionId,
    role: envelope.message.role,
    content: envelope.message.content,
    channel: envelope.message.channel,
    structuredContent: envelope.message.structuredContent,
    tenantId: envelope.scope.tenantId,
    traceId: envelope.message.traceId ?? envelope.scope.traceId,
    contactId: resolveScopedContactId(envelope.scope),
    projectId: envelope.scope.projectId,
    messageTimestamp: envelope.message.messageTimestamp,
    metadata: envelope.message.metadata,
    messageId: envelope.message.messageId,
    agentName: envelope.message.agentName,
  });
}

async function enqueueMessagePersist(params: {
  dbSessionId: string;
  role: string;
  content: string;
  channel: string;
  tenantId?: string;
  traceId?: string;
  contactId?: string;
  projectId?: string;
  messageTimestamp?: number;
  structuredContent?: PersistedMessageStructuredContent;
  metadata?: ResponseMessageMetadata;
  messageId?: string;
  agentName?: string;
}): Promise<void> {
  const {
    dbSessionId,
    role,
    content,
    channel = 'web_debug',
    tenantId,
    traceId,
    contactId,
    projectId,
    messageTimestamp,
    structuredContent,
    metadata,
    messageId,
    agentName,
  } = params;

  // Chain on the previous persist for this session to preserve ordering.
  // Even though callers fire-and-forget, the chain ensures that the
  // async initBullMQ() call in the first message completes before the
  // second message enters the buffer.
  const prev = sessionChains.get(dbSessionId) ?? Promise.resolve();
  const next = prev.then(() =>
    _persistMessageImpl({
      dbSessionId,
      role,
      content,
      channel,
      tenantId,
      traceId,
      contactId,
      projectId,
      messageTimestamp,
      structuredContent,
      metadata,
      messageId,
      agentName,
    }),
  );
  // Swallow errors so the chain continues for subsequent messages
  const guarded = next.catch((err: unknown) => {
    log.warn('Message persist failed', {
      dbSessionId,
      error: err instanceof Error ? err.stack : String(err),
    });
  });
  sessionChains.set(dbSessionId, guarded);

  // Evict oldest chain entries when the map exceeds its cap
  if (sessionChains.size > MAX_SESSION_CHAINS) {
    const it = sessionChains.keys();
    const oldest = it.next().value;
    if (oldest) sessionChains.delete(oldest);
  }

  return guarded;
}

interface PersistMessageImplArgs {
  dbSessionId: string;
  role: string;
  content: string;
  channel: string;
  tenantId?: string;
  traceId?: string;
  contactId?: string;
  projectId?: string;
  messageTimestamp?: number;
  structuredContent?: PersistedMessageStructuredContent;
  metadata?: ResponseMessageMetadata;
  messageId?: string;
  agentName?: string;
}

/** Internal: actual persist logic, called serially per session via chain. */
async function _persistMessageImpl(args: PersistMessageImplArgs): Promise<void> {
  const {
    dbSessionId,
    role,
    content,
    channel,
    tenantId,
    traceId,
    contactId,
    projectId,
    messageTimestamp,
    structuredContent,
    metadata,
    messageId,
    agentName,
  } = args;
  const bullReady = await initBullMQ();

  // Detect PII and redact before persistence when tenant requires it
  let hasPII = false;
  let persistContent = content;
  let persistStructuredContent = structuredContent;
  try {
    const projectPIISnapshot = await resolveProjectPIISnapshot({
      tenantId,
      projectId,
    });
    const textHasPII = containsPII(content, projectPIISnapshot.piiRecognizerRegistry);
    const structuredContentJson = structuredContent ? JSON.stringify(structuredContent) : undefined;
    const structuredHasPII = structuredContentJson
      ? containsPII(structuredContentJson, projectPIISnapshot.piiRecognizerRegistry)
      : false;
    hasPII = textHasPII || structuredHasPII;

    const redactForPersistence = hasPII && (await shouldRedactPII(tenantId));
    if (textHasPII && redactForPersistence) {
      persistContent = redactPII(content, projectPIISnapshot.piiRecognizerRegistry);
    }

    if (structuredContent && structuredHasPII && redactForPersistence) {
      const protectedStructuredContent = {
        ...transformStructuredOutputPayload(structuredContent, (text) =>
          redactPII(text, projectPIISnapshot.piiRecognizerRegistry),
        ),
        ...(structuredContent.localization ? { localization: structuredContent.localization } : {}),
      };
      const remainingStructuredPII = containsPII(
        JSON.stringify(protectedStructuredContent),
        projectPIISnapshot.piiRecognizerRegistry,
      );
      persistStructuredContent = remainingStructuredPII ? undefined : protectedStructuredContent;
    }
  } catch (err) {
    log.warn('PII detection error', { error: err instanceof Error ? err.message : String(err) });
  }

  const contentEnvelope = persistStructuredContent
    ? serializePersistedStructuredMessageEnvelope(persistContent, persistStructuredContent)
    : undefined;

  // Use caller-provided timestamp (actual message generation time) or fall back to now
  const enqueuedAt = messageTimestamp ?? Date.now();
  const idempotencyKey = crypto
    .createHash('sha256')
    .update(
      `${dbSessionId}:${role}:${messageId ?? ''}:${persistContent}:${contentEnvelope ?? ''}:${JSON.stringify(metadata ?? {})}:${enqueuedAt}`,
    )
    .digest('hex')
    .slice(0, 32);

  const msg: MessageJobData = {
    dbSessionId,
    role,
    content: persistContent,
    ...(contentEnvelope ? { contentEnvelope } : {}),
    channel,
    tenantId,
    projectId,
    traceId,
    contactId,
    ...(metadata ? { metadata } : {}),
    hasPII,
    enqueuedAt,
    idempotencyKey,
    ...(messageId ? { messageId } : {}),
    ...(agentName ? { agentName } : {}),
  };

  if (bullReady) {
    logMissingProjectContext('enqueue', msg);

    // Add to buffer for batched write
    let buffer = messageBuffer.get(dbSessionId);
    if (!buffer) {
      buffer = [];
      messageBuffer.set(dbSessionId, buffer);
    }
    buffer.push(msg);
    totalBuffered++;

    // Flush immediately if per-session buffer exceeds threshold or global cap hit
    if (buffer.length >= MAX_BATCH_SIZE || totalBuffered >= MAX_TOTAL_BUFFERED) {
      await flushAllBuffers();
    }
    return;
  }

  // Fallback: direct DB write (no Redis)
  if (!isDatabaseAvailable()) {
    log.warn('Skipping direct message persist — database unavailable', { dbSessionId });
    return;
  }
  try {
    logMissingProjectContext('direct-write', msg);

    const store = getMessageStore();
    await store.addMessage({
      sessionId: msg.dbSessionId,
      role: msg.role as 'user' | 'assistant' | 'system' | 'tool',
      content: msg.content,
      contentEnvelope: msg.contentEnvelope,
      channel: msg.channel as import('@abl/compiler/platform/core/types').Channel,
      traceId: msg.traceId || '',
      contactId: msg.contactId,
      projectId: msg.projectId,
      hasPII: msg.hasPII,
      tenantId: msg.tenantId,
      messageTimestamp: msg.enqueuedAt,
      ...(msg.messageId ? { messageId: msg.messageId } : {}),
      ...(msg.agentName ? { agentName: msg.agentName } : {}),
      ...(msg.metadata
        ? {
            metadata: msg.metadata as unknown as Partial<
              import('@abl/compiler/platform/core/types').MessageMetadata
            >,
          }
        : {}),
    });
  } catch (err) {
    log.error('Direct write failed', {
      dbSessionId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Enqueue turn metrics (token counts, trace counts, etc.) for batched persistence.
 * Uses BullMQ with batching when Redis is available, falls back to direct MongoDB writes.
 */
export async function persistTurnMetrics(metrics: TurnMetrics): Promise<void> {
  logLegacyPersistenceApiUsage('persistTurnMetrics');
  return persistTurnMetricsInternal(metrics);
}

export async function persistScopedTurnMetrics(envelope: ScopedTurnMetricsEnvelope): Promise<void> {
  assertProductionExecutionScope(envelope.scope);
  assertScopedTurnMetricsPayload(envelope.metrics);
  return persistTurnMetricsInternal({
    ...envelope.metrics,
    tenantId: envelope.scope.tenantId,
  });
}

async function persistTurnMetricsInternal(metrics: TurnMetrics): Promise<void> {
  const {
    dbSessionId,
    tenantId,
    tokensIn,
    tokensOut,
    cost,
    traceEventCount,
    errorCount,
    handoffCount,
  } = metrics;
  const hasUpdates =
    tokensIn + tokensOut > 0 || traceEventCount > 0 || errorCount > 0 || handoffCount > 0;
  if (!hasUpdates) return;

  const bullReady = await initBullMQ();

  if (bullReady) {
    // Evict oldest metrics entries when buffer is at capacity
    if (metricsBuffer.size >= MAX_METRICS_BUFFER) {
      const dropCount = Math.floor(MAX_METRICS_BUFFER * 0.1);
      let dropped = 0;
      for (const key of metricsBuffer.keys()) {
        if (dropped >= dropCount) break;
        metricsBuffer.delete(key);
        dropped++;
      }
      log.warn('metricsBuffer at capacity — evicted oldest entries', {
        dropped,
        max: MAX_METRICS_BUFFER,
      });
    }

    // Accumulate into metricsBuffer for batched write
    let acc = metricsBuffer.get(dbSessionId);
    if (!acc) {
      acc = {
        tenantId: tenantId ?? '',
        tokensIn: 0,
        tokensOut: 0,
        cost: 0,
        traceEventCount: 0,
        errorCount: 0,
        handoffCount: 0,
      };
      metricsBuffer.set(dbSessionId, acc);
    }
    // Keep tenantId current — later calls may have it even if the first didn't
    if (tenantId && !acc.tenantId) acc.tenantId = tenantId;
    acc.tokensIn += tokensIn;
    acc.tokensOut += tokensOut;
    acc.cost += cost;
    acc.traceEventCount += traceEventCount;
    acc.errorCount += errorCount;
    acc.handoffCount += handoffCount;
    return;
  }

  // Fallback: direct MongoDB write (no Redis)
  if (!isDatabaseAvailable()) {
    log.warn('Skipping direct metrics persist — database unavailable', { dbSessionId });
    return;
  }
  if (!tenantId) {
    log.warn('Skipping direct session metric writes — no tenantId available', { dbSessionId });
    return;
  }
  try {
    const totalTokens = tokensIn + tokensOut;
    await applySessionTurnUpdate(
      dbSessionId,
      {
        tokenCountIncrement: totalTokens,
        estimatedCostIncrement: cost,
        traceEventCountIncrement: traceEventCount,
        errorCountIncrement: errorCount,
        handoffCountIncrement: handoffCount,
        touchLastActivityAt: true,
      },
      tenantId,
    ).catch((err) =>
      log.warn('direct session turn update failed', {
        dbSessionId,
        error: err instanceof Error ? err.message : String(err),
      }),
    );
  } catch (err) {
    log.error('Direct metrics write failed', {
      dbSessionId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Flush buffered messages for a specific session, or all sessions if no ID given.
 * Call with sessionId during WS close to avoid flushing other sessions' buffers.
 * Call without args during graceful shutdown to flush everything.
 */
export async function flushMessageQueue(sessionId?: string): Promise<void> {
  // No BullMQ = messages were direct-written, nothing to flush
  if (!bullQueue) return;

  // No sessionId = flush everything (graceful shutdown)
  if (!sessionId) {
    await flushAllBuffers();
    return;
  }

  // Chain the flush onto the existing session promise so any concurrent
  // persistMessage() that fires after this call starts will enqueue *after*
  // the flush drains rather than racing with it.
  const prev = sessionChains.get(sessionId) ?? Promise.resolve();
  const flushWork = prev
    .catch((err: unknown) => {
      log.warn('Pending persist failed during flush', {
        sessionId,
        error: err instanceof Error ? err.stack : String(err),
      });
    })
    .then(() => _flushSessionBuffer(sessionId));
  sessionChains.set(
    sessionId,
    flushWork.catch(() => undefined),
  );
  await flushWork;
}

/** Internal: drain the in-memory buffer for a single session into BullMQ. */
async function _flushSessionBuffer(sessionId: string): Promise<void> {
  if (!bullQueue) return;

  // Read the buffer after the pending chain settles so a closeout flush cannot
  // miss a message that was still being enqueued.
  const buffer = messageBuffer.get(sessionId);
  const sessionMetrics = metricsBuffer.get(sessionId);

  if ((!buffer || buffer.length === 0) && !sessionMetrics) return;

  if (buffer) {
    messageBuffer.delete(sessionId);
    totalBuffered = Math.max(0, totalBuffered - buffer.length);
  }
  if (sessionMetrics) {
    metricsBuffer.delete(sessionId);
  }

  const messages = buffer || [];
  const metricsRecord = sessionMetrics ? { [sessionId]: sessionMetrics } : undefined;

  for (let i = 0; i < messages.length; i += MAX_BATCH_SIZE) {
    const batch = messages.slice(i, i + MAX_BATCH_SIZE);
    const jobData: MessageBatchJobData = { messages: batch };
    // Attach metrics only to the first batch
    if (i === 0 && metricsRecord) {
      jobData.metrics = metricsRecord;
    }
    await bullQueue.add('message-batch', await encryptBatchForQueue(jobData));
  }

  // Metrics-only flush (no messages but has metrics)
  if (messages.length === 0 && metricsRecord) {
    await bullQueue.add('message-batch', {
      messages: [],
      metrics: metricsRecord,
    } as MessageBatchJobData);
  }
}

/**
 * Shutdown the message persistence queue gracefully.
 */
export async function shutdownMessageQueue(): Promise<void> {
  log.info('Shutting down message queue');

  // Stop flush timer
  if (flushTimer) {
    clearInterval(flushTimer);
    flushTimer = null;
  }

  // Flush remaining buffered messages
  await flushAllBuffers();

  // Close BullMQ
  if (bullWorker) {
    try {
      await bullWorker.close();
    } catch (err) {
      log.warn('BullMQ worker close failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
    bullWorker = null;
  }
  if (bullQueue) {
    try {
      await bullQueue.close();
    } catch (err) {
      log.warn('BullMQ queue close failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
    bullQueue = null;
  }

  bullInitAttempted = false;
  bullAvailable = false;
  totalBuffered = 0;
  metricsBuffer = new Map();
  sessionChains.clear();
  missingProjectContextLogCache.clear();
  legacyPersistenceApiLogCache.clear();
  workerRecoveryInProgress = false;
  workerRecoveryAttempts = 0;

  log.info('Message queue shutdown complete');
}

// =============================================================================
// TEST HELPERS (not for production use)
// =============================================================================

/** Reset all internal state. Test-only. */
export function _resetForTest(): void {
  bullQueue = null;
  bullWorker = null;
  bullInitAttempted = false;
  bullAvailable = false;
  mongoPersistBreaker = null;
  messageBuffer = new Map();
  metricsBuffer = new Map();
  totalBuffered = 0;
  sessionChains.clear();
  missingProjectContextLogCache.clear();
  legacyPersistenceApiLogCache.clear();
  workerRecoveryInProgress = false;
  workerRecoveryAttempts = 0;
  if (flushTimer) {
    clearInterval(flushTimer);
    flushTimer = null;
  }
}

/** Get the current message buffer for a session. Test-only. */
export function _getMessageBuffer(sessionId: string): MessageJobData[] | undefined {
  return messageBuffer.get(sessionId);
}

/** Override initBullMQ result for testing. */
export function _setBullAvailable(available: boolean): void {
  bullInitAttempted = true;
  bullAvailable = available;
}

/** Override the BullMQ queue handle for focused flush tests. Test-only. */
export function _setBullQueueForTest(queue: Pick<Queue, 'add'> | null): void {
  bullQueue = queue as Queue | null;
  bullInitAttempted = true;
  bullAvailable = queue !== null;
}

/** Get current metricsBuffer size. Test-only. */
export function _getMetricsBufferSize(): number {
  return metricsBuffer.size;
}

/** Get a metricsBuffer entry. Test-only. */
export function _getMetricsEntry(dbSessionId: string): MetricsAccumulator | undefined {
  return metricsBuffer.get(dbSessionId);
}

/** Run the BullMQ worker handler directly. Test-only. */
export async function _processBatchForTest(data: MessageBatchJobData): Promise<void> {
  await workerJobHandler({ data });
}
