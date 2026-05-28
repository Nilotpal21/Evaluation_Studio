/**
 * Shared Worker Utilities
 *
 * Common setup for BullMQ workers: Redis connection, error handling, logging.
 * All pipeline workers import these helpers to avoid duplicating connection
 * logic and job-data interfaces.
 */

import crypto from 'crypto';
import { Queue } from 'bullmq';
import type { WorkerOptions } from 'bullmq';
import { defaultWorkerOptions } from '@agent-platform/redis/bullmq';
import {
  BULLMQ_CLUSTER_SAFE_PREFIX,
  createRedisConnection,
  resolveRedisOptionsFromEnv,
  type RedisConnectionHandle,
  type RedisClient,
} from '@agent-platform/redis';
import { extractTrace } from '@agent-platform/shared-observability/tracing';
import { runWithObservabilityContext } from '@abl/compiler/platform/observability';
import { createLogger } from '@abl/compiler/platform';

// =============================================================================
// REDIS CONNECTION (cluster-aware handle)
// =============================================================================

let _sharedHandle: RedisConnectionHandle | null | undefined;

function getHandle(): RedisConnectionHandle | null {
  if (_sharedHandle !== undefined) return _sharedHandle;
  const opts = resolveRedisOptionsFromEnv();
  _sharedHandle = opts ? createRedisConnection(opts) : null;
  return _sharedHandle;
}

/** Returns the shared Redis client (Redis | Cluster), or null if not configured. */
export function getSharedRedisClient(): RedisClient | null {
  return getHandle()?.client ?? null;
}

/** Returns the shared RedisConnectionHandle (for createSubscriber / createBullMQPair). */
export function getSharedRedisHandle(): RedisConnectionHandle | null {
  return getHandle();
}

/** Create a fresh BullMQ-ready connection (maxRetriesPerRequest: null). */
function newBullMQConnection(): RedisClient {
  const handle = getHandle();
  if (!handle)
    throw new Error('Redis not configured (REDIS_ENABLED=false or no REDIS_URL/REDIS_HOST)');
  return handle.duplicate({ maxRetriesPerRequest: null });
}

/**
 * Build a BullMQ-compatible Redis connection from environment variables.
 *
 * Returns a live Redis | Cluster instance (cluster-safe) instead of plain
 * ConnectionOptions. BullMQ Queue/Worker constructors accept either form.
 *
 * @deprecated Prefer `getSharedRedisClient()` or `newBullMQConnection()` for new code.
 */
export function getRedisConnection(): RedisClient {
  return newBullMQConnection();
}

// =============================================================================
// QUEUE & WORKER FACTORIES
// =============================================================================

/**
 * Pooled queue factory — reuses Queue instances per queue name.
 * Each Queue holds a single Redis connection. Without pooling, every
 * worker job creates + closes a Queue (and its Redis connection) per
 * downstream enqueue — thousands of connect/disconnect cycles under load.
 *
 * .close() is overridden to a no-op on pooled instances so existing
 * callers with try/finally { queue.close() } patterns don't kill the pool.
 * Real shutdown is handled by closeQueuePool().
 *
 * Self-healing: if the Redis connection drops (pod restart, Redis failover),
 * the stale entry is evicted and a fresh Queue is created on next access.
 */
const _queuePool = new Map<string, Queue>();

function getOrCreatePooledQueue(name: string): Queue {
  const existing = _queuePool.get(name);
  if (existing) {
    const client = (existing as any).client;
    if (client && client.status === 'end') {
      // Disconnect the owned connection of the stale entry
      const ownedConn = (existing as any)._ownedConn as RedisClient | undefined;
      if (ownedConn) {
        try {
          ownedConn.disconnect();
        } catch {
          /* ignore during eviction */
        }
      }
      _queuePool.delete(name);
    } else {
      return existing;
    }
  }
  const conn = newBullMQConnection();
  const queue = new Queue(name, { connection: conn, prefix: BULLMQ_CLUSTER_SAFE_PREFIX });
  // Store the owned connection for cleanup
  (queue as any)._ownedConn = conn;
  // Override .close() to no-op — prevents callers from killing the pooled connection.
  // The original close is stored for use in closeQueuePool() at shutdown.
  (queue as any)._realClose = queue.close.bind(queue);
  queue.close = async () => Promise.resolve();
  _queuePool.set(name, queue);
  return queue;
}

function defaultQueueFactory(name: string): Queue {
  return getOrCreatePooledQueue(name);
}

/** Injectable queue factory — tests can replace this via setQueueFactory(). */
let _queueFactory: (name: string) => Queue = defaultQueueFactory;

/**
 * Get a BullMQ Queue for the given name. Queues are pooled and .close()
 * is a no-op on the returned instance. Callers can safely use existing
 * try/finally patterns without breaking the pool.
 */
export function createQueue(name: string): Queue {
  return _queueFactory(name);
}

/**
 * Replace the queue factory (DI hook for tests).
 * Avoids vi.mock() — the test injects a fake factory before routes are exercised.
 */
export function setQueueFactory(factory: (name: string) => Queue): void {
  _queueFactory = factory;
}

/**
 * Reset the queue factory to the default (creates real BullMQ queues).
 * Call in afterAll/afterEach to prevent test pollution.
 */
export function resetQueueFactory(): void {
  _queueFactory = defaultQueueFactory;
}

/**
 * Gracefully close all pooled queues. Call at process shutdown.
 * Uses the stored _realClose to actually disconnect (since .close() is a no-op).
 */
export async function closeQueuePool(): Promise<void> {
  const closePromises = Array.from(_queuePool.values()).map((q) => {
    // Disconnect the owned BullMQ connection before closing the queue
    const ownedConn = (q as any)._ownedConn as RedisClient | undefined;
    if (ownedConn) {
      try {
        ownedConn.disconnect();
      } catch {
        /* ignore during shutdown */
      }
    }
    const realClose = (q as any)._realClose;
    const closeFn: () => Promise<void> = realClose || q.close.bind(q);
    return closeFn().catch((err: unknown) => {
      getWorkerLogger('queue-pool').error('Failed to close pooled queue', {
        error: err instanceof Error ? err.message : String(err),
      });
    });
  });
  await Promise.allSettled(closePromises);
  _queuePool.clear();
}

/**
 * Build common WorkerOptions for pipeline workers.
 *
 * @param concurrency — max parallel jobs per worker (default 5)
 */
export function createWorkerOptions(concurrency = 5): WorkerOptions {
  return {
    connection: newBullMQConnection(),
    ...defaultWorkerOptions(concurrency),
  };
}

// =============================================================================
// LOGGING HELPERS
// =============================================================================

// Cache loggers per worker name to avoid creating new ones on every call
const workerLoggers = new Map<string, ReturnType<typeof createLogger>>();

function getWorkerLogger(worker: string) {
  let logger = workerLoggers.get(worker);
  if (!logger) {
    logger = createLogger(`worker:${worker}`);
    workerLoggers.set(worker, logger);
  }
  return logger;
}

export function workerLog(worker: string, message: string, meta?: Record<string, unknown>): void {
  getWorkerLogger(worker).info(message, meta);
}

export function workerError(
  worker: string,
  message: string,
  error: unknown,
  meta?: Record<string, unknown>,
): void {
  const errMsg = error instanceof Error ? error.message : String(error);
  const stack = error instanceof Error ? error.stack : undefined;
  getWorkerLogger(worker).error(message, {
    ...(meta ?? {}),
    error: errMsg,
    ...(stack ? { stack } : {}),
  });
}

export async function runBestEffortWorkerSideEffect(
  worker: string,
  sideEffect: string,
  fn: () => Promise<void>,
): Promise<void> {
  try {
    await fn();
  } catch (error) {
    workerError(worker, `Best-effort side effect failed: ${sideEffect}`, error);
  }
}

export function createWorkerSideEffectFailure(
  primaryError: unknown,
  sideEffect: string,
  sideEffectError: unknown,
): AggregateError {
  const primaryMessage =
    primaryError instanceof Error ? primaryError.message : String(primaryError);
  const sideEffectMessage =
    sideEffectError instanceof Error ? sideEffectError.message : String(sideEffectError);

  return new AggregateError(
    [primaryError, sideEffectError],
    `${primaryMessage}; failed to ${sideEffect}: ${sideEffectMessage}`,
  );
}

// =============================================================================
// TRACE CONTEXT PROPAGATION
// =============================================================================

/**
 * Extract trace context from a BullMQ job payload and run the callback
 * within an observability context. If no trace context is present in the
 * payload, generates a fresh traceId/spanId so downstream logging and
 * tracing still correlate.
 *
 * Usage:
 *   await withTraceContext(job.data, () => processJob(job));
 */
export async function withTraceContext<T>(
  jobData: Record<string, unknown>,
  fn: () => Promise<T>,
): Promise<T> {
  const extracted = extractTrace(jobData);
  const traceId = extracted?.traceId || crypto.randomUUID().replace(/-/g, '');
  const spanId = extracted?.spanId || crypto.randomUUID().replace(/-/g, '').slice(0, 16);

  return runWithObservabilityContext({ traceId, spanId }, fn);
}

// =============================================================================
// PIPELINE STAGE CONFIG (injected by ingestion worker when pipeline exists)
// =============================================================================

/**
 * Pipeline stage configuration passed through the worker chain.
 * When present, workers use these settings instead of hardcoded defaults.
 * When absent, workers fall back to current behavior (backward compatible).
 */
export interface PipelineStageConfig {
  /** Pipeline definition ID */
  pipelineId: string;
  /** Selected flow ID */
  flowId: string;
  /** Provider for this stage (e.g., 'docling', 'fixed-size', 'bge-m3') */
  provider: string;
  /** Provider-specific configuration (e.g., { chunkSize: 10000, chunkOverlap: 200 }) */
  providerConfig: Record<string, unknown>;
}

// =============================================================================
// JOB DATA INTERFACES
// =============================================================================

export interface IngestionJobData {
  jobId: string;
  indexId: string;
  sourceId: string;
  tenantId: string;
  documentIds?: string[];
  options?: {
    forceExtract?: boolean;
    forceEmbed?: boolean;
    skipEnrichment?: boolean;
    batchSize?: number;
  };
  /** Pre-sync field configuration (from connector fieldConfig). Null = use defaults. */
  preConfiguredFields?: {
    /** Source field paths to extract during sync */
    selectedFields: string[];
    /** Source field paths to include in embedding text */
    embeddingFields: string[];
    /** Pre-resolved field-to-canonical mappings */
    fieldMappings: Array<{
      sourceField: string;
      canonicalField: string;
      type: string;
      alias: string;
    }>;
  };
}

export interface ExtractionJobData {
  indexId: string;
  sourceId: string;
  documentId: string;
  tenantId: string;
}

export interface DoclingExtractionJobData {
  indexId: string;
  documentId: string;
  sourceUrl: string; // S3 URL or HTTP URL
  tenantId: string;
  /** Pipeline stage config — when present, controls extraction behavior */
  pipelineStage?: PipelineStageConfig;
}

export interface PageProcessingJobData {
  indexId: string;
  documentId: string;
  tenantId: string;
  pageIds: string[]; // Batch of page IDs to process
  previousPageSummary: string | null; // Context from previous batch
  /** Pipeline stage config — when present, controls chunking behavior */
  pipelineStage?: PipelineStageConfig;
}

export interface CanonicalMapJobData {
  indexId: string;
  documentId: string;
  tenantId: string;
  connectorId?: string;
}

export interface EnrichmentJobData {
  indexId: string;
  documentId: string;
  chunkIds: string[];
  tenantId: string;
  /** Pipeline stage config — when present, controls enrichment behavior */
  pipelineStage?: PipelineStageConfig;
}

export interface EmbeddingJobData {
  indexId: string;
  documentId: string;
  chunkIds: string[];
  tenantId: string;
  /** Pipeline ID for traceability (optional, for backward compat) */
  pipelineId?: string;
  /** Knowledge base ID for pipeline config resolution (optional) */
  knowledgeBaseId?: string;
  /** Reindex mode - when 'reindex', marks questions as pending for re-embedding */
  mode?: 'reindex';
  /** Batch ID for reindex traceability (optional) */
  batchId?: string;
  /** Pipeline stage config — when present, controls embedding behavior */
  pipelineStage?: PipelineStageConfig;
}

export interface MultiModalJobData {
  indexId: string;
  documentId: string;
  chunkIds: string[];
  tenantId: string;
}

export interface TreeBuildingJobData {
  indexId: string;
  documentId: string;
  tenantId: string;
}

export interface QuestionSynthesisJobData {
  indexId: string;
  documentId: string;
  tenantId: string;
}

export interface ScopeClassificationJobData {
  indexId: string;
  documentId: string;
  tenantId: string;
}

export interface VisualEnrichmentJobData {
  indexId: string;
  documentId: string;
  tenantId: string;
  pageNumber: number;
  chunkId: string;
}

export interface DocumentVisualEnrichmentJobData {
  indexId: string;
  documentId: string;
  tenantId: string;
}

export interface KGEnrichmentJobData {
  indexId: string;
  tenantId: string;
  filter?: {
    status?: ('NOT_ENRICHED' | 'SKIPPED')[];
    uploadedAfter?: string;
  };
  options?: {
    batchSize?: number;
    parallelBatches?: number;
    retrySkipped?: boolean;
    forceReclassify?: boolean; // Re-process ALL documents regardless of status
  };
  priority?: 'low' | 'normal' | 'high';
}

export interface TaxonomySetupJobData {
  indexId: string;
  tenantId: string;
  domainDefinitionPaths: string[];
  organizationProfilePath?: string;
  organizationProfile?: {
    organizationName: string;
    products: Array<{
      productId: string;
      organizationSpecificNames: string[];
      attributeContext?: Record<
        string,
        {
          typicalRange?: string;
          aliases?: string[];
        }
      >;
    }>;
  };
  version?: string;
  priority?: 'low' | 'normal' | 'high';
}

// ─── IdP Sync Job Data (Phase 2B: IdP Authentication) ───────────────────────

export interface AzureADUserSyncJobData {
  tenantId: string;
  credentialId: string; // LLMCredential ID with Microsoft Graph API token
  syncMode: 'full' | 'delta'; // Full sync or delta query (incremental)
  deltaToken?: string; // Delta link from previous sync
  authProfileId?: string; // Auth Profile ID for dual-read migration
}

export interface AzureADGroupSyncJobData {
  tenantId: string;
  credentialId: string; // LLMCredential ID with Microsoft Graph API token
  syncMode: 'full' | 'delta';
  deltaToken?: string;
  authProfileId?: string; // Auth Profile ID for dual-read migration
}

export interface OktaUserSyncJobData {
  tenantId: string;
  credentialId: string; // LLMCredential ID with Okta API token
  syncMode: 'full' | 'delta';
  lastUpdated?: string; // ISO 8601 timestamp for delta query (filter=lastUpdated gt)
  oktaDomain: string; // e.g., "company.okta.com"
  authProfileId?: string; // Auth Profile ID for dual-read migration
}

export interface OktaGroupSyncJobData {
  tenantId: string;
  credentialId: string;
  syncMode: 'full' | 'delta';
  lastUpdated?: string; // ISO 8601 timestamp for delta query
  oktaDomain: string; // e.g., "company.okta.com"
  authProfileId?: string; // Auth Profile ID for dual-read migration
}

export interface GoogleUserSyncJobData {
  tenantId: string;
  credentialId: string; // LLMCredential ID with Google Workspace service account
  syncMode: 'full' | 'delta';
  lastUpdated?: string; // ISO 8601 timestamp for delta query (no native delta in Google)
  googleDomain: string; // e.g., "company.com" (Google Workspace domain)
  authProfileId?: string; // Auth Profile ID for dual-read migration
}

export interface GoogleGroupSyncJobData {
  tenantId: string;
  credentialId: string;
  syncMode: 'full' | 'delta';
  lastUpdated?: string; // ISO 8601 timestamp for delta query
  googleDomain: string; // e.g., "company.com"
  authProfileId?: string; // Auth Profile ID for dual-read migration
}

export interface ConnectorDiscoveryJobData {
  connectorId: string;
  tenantId: string;
  connectorType: string;
  mode: 'discover_only' | 'discover_and_profile' | 'quick_setup';
  sampleSize?: number;
  discoveryId: string;
}

export interface WebhookNotificationJobData {
  connectorId: string;
  tenantId: string;
  subscriptionId: string;
  changeType: string;
  resource: string;
  driveId?: string;
}
export interface WebhookNotificationBatchJobData {
  connectorId: string;
  tenantId: string;
  notifications: Array<{
    subscriptionId: string;
    changeType: string;
    resource: string;
    driveId?: string;
  }>;
}

export interface ReconciliationJobData {
  tenantId?: string;
  indexId?: string;
}

export interface GroupStrategy {
  pattern: string;
  method: 'http' | 'playwright';
  llmEstimate: number;
  reason: string;
  count?: number;
}

// =============================================================================
// BLIND INDEX & ENCRYPTION HELPERS (for MongoPermissionStore)
// =============================================================================
// These mirror the algorithm from @agent-platform/shared-encryption
// (HKDF + HMAC-SHA256) so workers can provide blindIndexFn / encryptFn
// without importing the full encryption engine package.

const HKDF_HASH = 'sha512';
const KEY_LENGTH = 32;
const AES_ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;

/**
 * Derive a blind-index HMAC key for a tenant using HKDF.
 * Matches EncryptionService.deriveBlindIndexKey(tenantId) exactly.
 */
function deriveBlindIndexKey(masterKeyHex: string, tenantId: string): Buffer {
  return Buffer.from(
    crypto.hkdfSync(
      HKDF_HASH,
      Buffer.from(masterKeyHex, 'hex'),
      `blind:${tenantId}`,
      'blind-index-key',
      KEY_LENGTH,
    ),
  );
}

/**
 * Derive a contact encryption key for a tenant using HKDF.
 * Matches EncryptionService.deriveContactEncryptionKey(tenantId) exactly.
 */
function deriveContactEncryptionKey(masterKeyHex: string, tenantId: string): Buffer {
  return Buffer.from(
    crypto.hkdfSync(
      HKDF_HASH,
      Buffer.from(masterKeyHex, 'hex'),
      tenantId,
      'user-key-derivation',
      KEY_LENGTH,
    ),
  );
}

/**
 * Create a BlindIndexFn compatible with MongoPermissionStore.
 * Uses ENCRYPTION_MASTER_KEY from environment.
 *
 * Algorithm: HKDF(masterKey, "blind:{tenantId}", "blind-index-key") → HMAC-SHA256(value)
 */
export function createBlindIndexFn(): (tenantId: string, value: string) => string {
  const masterKeyHex = process.env.ENCRYPTION_MASTER_KEY;
  if (!masterKeyHex) {
    throw new Error('ENCRYPTION_MASTER_KEY is required for blind index computation');
  }

  return (tenantId: string, value: string): string => {
    const key = deriveBlindIndexKey(masterKeyHex, tenantId);
    return crypto.createHmac('sha256', key).update(value).digest('hex');
  };
}

/**
 * Create an EncryptFn compatible with MongoPermissionStore.
 * Uses ENCRYPTION_MASTER_KEY from environment.
 *
 * Algorithm: AES-256-GCM with HKDF-derived key. Output: "iv:encrypted:authTag" hex.
 */
export function createEncryptFn(): (tenantId: string, value: string) => string {
  const masterKeyHex = process.env.ENCRYPTION_MASTER_KEY;
  if (!masterKeyHex) {
    throw new Error('ENCRYPTION_MASTER_KEY is required for encryption');
  }

  return (tenantId: string, value: string): string => {
    const key = deriveContactEncryptionKey(masterKeyHex, tenantId);
    const iv = crypto.randomBytes(IV_LENGTH);
    const cipher = crypto.createCipheriv(AES_ALGORITHM, key, iv);
    const encrypted = cipher.update(value, 'utf8', 'hex') + cipher.final('hex');
    const authTag = cipher.getAuthTag().toString('hex');
    return `${iv.toString('hex')}:${encrypted}:${authTag}`;
  };
}

export const QUEUE_BULK_CRAWL = 'bulk-crawl';

export interface BulkCrawlSectionMapping {
  sectionId: string;
  pattern: string;
  name: string;
  urls: string[];
  strategy: 'http' | 'browser';
}

export interface BulkCrawlJobData {
  jobId: string;
  tenantId: string;
  userId: string;
  indexId: string;
  sourceId: string;
  urls: string[];
  sectionMapping: BulkCrawlSectionMapping[];
  crawlSettings: {
    crawlDelay: number;
    respectRobotsTxt: boolean;
    cleanupLevel: 'standard' | 'aggressive' | 'none';
    deduplicate: boolean;
    cookieConsent: boolean;
    reuseHandlers: boolean;
  };
  /** Force re-process all pages even if content hash is unchanged */
  forceReprocess?: boolean;
}

export interface IntelligenceCrawlJobData {
  jobId: string;
  tenantId: string;
  indexId: string;
  sourceId: string;
  entryUrl: string;
  discoveredUrls: string[];
  intent?: string;
  limits: { maxPages: number; maxDepth: number; maxLlmCalls: number };
  discovery: { useSitemap: boolean; followLinks: boolean };
  filters?: { includePaths?: string[]; excludePaths?: string[] };
  groupStrategies?: GroupStrategy[];
}
