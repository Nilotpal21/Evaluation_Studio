/**
 * LLM Request Queue
 *
 * Two-layer architecture:
 * 1. BullMQ for cluster-wide scheduling, backpressure, and global concurrency cap
 * 2. Local SessionQueue + Semaphore fallback when Redis unavailable
 *
 * Per-session ordering is enforced via SessionService execution locks
 * (Redis SET NX PX / memory Set), NOT BullMQ groups (which require Pro).
 * BullMQ handles global concurrency and backpressure only.
 */

import crypto from 'crypto';
import { AppError, ErrorCodes } from '@agent-platform/shared-kernel';
import { SessionQueue } from './local-semaphore.js';
import { getRedisClient, getRedisHandle, isRedisAvailable } from '../redis/redis-client.js';
import {
  BULLMQ_CLUSTER_SAFE_PREFIX,
  createBullMQPair,
  type RedisClient,
} from '@agent-platform/redis';
import { isConfigLoaded, getConfig } from '../../config/loader.js';
import { createLogger } from '@abl/compiler/platform';
import {
  getCurrentTraceId,
  getObservabilityContext,
  runWithObservabilityContext,
} from '@abl/compiler/platform/observability';
import { injectTrace, extractTrace } from '@agent-platform/shared-observability/tracing';
import { getTraceStore } from '../trace-store.js';
import { recordBackpressure } from '../../observability/metrics.js';
import type { ExecuteMessageOptions } from '../execution/types.js';

const log = createLogger('llm-queue');

// =============================================================================
// TYPES
// =============================================================================

interface LLMJobData {
  jobId: string;
  sessionId: string;
  message: string;
  tenantId?: string;
  enqueuedAt: number;
  execOptions?: Omit<ExecuteMessageOptions, 'signal'>;
  traceId?: string;
}

interface LLMJobCallbacks {
  onChunk?: (chunk: string) => void;
  onTraceEvent?: (event: { type: string; data: Record<string, unknown> }) => void;
  resolve: (result: any) => void;
  reject: (error: unknown) => void;
  registeredAt: number;
  execOptions?: ExecuteMessageOptions;
  detachAbortListener?: () => void;
}

export class BackpressureError extends AppError {
  constructor(message = 'Queue backpressure threshold exceeded') {
    super(message, {
      ...ErrorCodes.QUEUE_BACKPRESSURE,
    });
  }
}

// =============================================================================
// STATE
// =============================================================================

// BullMQ instances (lazily initialized)
let bullQueue: any = null;
let bullWorker: any = null;
let bullInitAttempted = false;
let bullAvailable = false;

// Duplicated Redis connections for BullMQ (tracked for cleanup on shutdown).
// Both halves come from `createBullMQPair(handle)` so they're typed as
// `RedisClient = Redis | Cluster` (cluster-aware).
let queueConnection: RedisClient | null = null;
let workerConnection: RedisClient | null = null;

// In-process callback registry: BullMQ serializes job data to Redis,
// but callbacks (onChunk, onTraceEvent) are closures.
// Workers look them up by jobId. Works because workers run in-process.
const callbackRegistry = new Map<string, LLMJobCallbacks>();

// Local fallback queue
let localQueue: SessionQueue | null = null;

// Timeout safety net for orphaned callbacks
const timeoutTimers = new Map<string, NodeJS.Timeout>();

// Registry bounds — prevent unbounded growth of callback closures
const _parsedMaxRegistry = parseInt(process.env.LLM_MAX_CALLBACK_REGISTRY || '5000', 10);
const MAX_CALLBACK_REGISTRY_SIZE = Number.isNaN(_parsedMaxRegistry) ? 5000 : _parsedMaxRegistry;
const _parsedCallbackTtl = parseInt(process.env.LLM_CALLBACK_TTL_MS || '300000', 10);
const CALLBACK_TTL_MS = Number.isNaN(_parsedCallbackTtl) ? 300000 : _parsedCallbackTtl; // 5 min

// Periodic sweep interval for stale callback cleanup (60s)
const STALE_SWEEP_INTERVAL_MS = 60_000;
let staleSweepTimer: NodeJS.Timeout | null = null;

// Executor resolver — test-injectable to avoid dynamic import mocking issues
type ExecutorLike = { executeMessage: (...args: any[]) => Promise<any> };
let _executorResolver: (() => Promise<ExecutorLike>) | null = null;

/** @internal Test-only: inject a custom executor resolver */
export function _setExecutorResolver(resolver: (() => Promise<ExecutorLike>) | null): void {
  _executorResolver = resolver;
}

async function resolveExecutor(): Promise<ExecutorLike> {
  if (_executorResolver) return _executorResolver();
  const { getRuntimeExecutor } = await import('../runtime-executor.js');
  return getRuntimeExecutor();
}

// =============================================================================
// CONFIG
// =============================================================================

function getQueueConfig() {
  if (!isConfigLoaded()) {
    return {
      enabled: true,
      concurrency: 10,
      backpressureThreshold: 100,
      jobTimeoutMs: 60000,
    };
  }

  const config = getConfig() as any;
  return {
    enabled: config.llmQueue?.enabled ?? true,
    concurrency: config.llmQueue?.concurrency ?? 10,
    backpressureThreshold: config.llmQueue?.backpressureThreshold ?? 100,
    jobTimeoutMs: config.llmQueue?.jobTimeoutMs ?? 60000,
  };
}

// =============================================================================
// SESSION LOCK (per-session FIFO ordering)
// =============================================================================

/**
 * Acquire the session execution lock with spin-wait retry.
 * Returns true if acquired, false if all retries exhausted.
 * Uses existing SessionService.acquireLock (Redis SET NX PX / memory Set).
 */
async function acquireSessionLock(sessionId: string, timeoutMs: number): Promise<boolean> {
  const { getSessionService } = await import('../session/session-service.js');
  const svc = getSessionService();
  const start = Date.now();
  let delay = 50; // Initial retry delay ms

  while (Date.now() - start < timeoutMs) {
    const acquired = await svc.acquireLock(sessionId);
    if (acquired) return true;
    // Exponential backoff: 50 → 100 → 200 → 400, capped at 500ms
    await new Promise((r) => setTimeout(r, delay));
    delay = Math.min(delay * 2, 500);
  }
  return false;
}

async function releaseSessionLock(sessionId: string): Promise<void> {
  try {
    const { getSessionService } = await import('../session/session-service.js');
    const svc = getSessionService();
    await svc.releaseLock(sessionId);
  } catch {
    // Best-effort release — lock will expire via TTL anyway
  }
}

// =============================================================================
// INITIALIZATION
// =============================================================================

/**
 * Lazy-init BullMQ queue and worker on first enqueue.
 * Uses dynamic import for ESM compatibility.
 */
async function initBullMQ(): Promise<boolean> {
  if (bullInitAttempted) return bullAvailable;
  bullInitAttempted = true;

  const redis = getRedisClient();
  const handle = getRedisHandle();
  if (!redis || !handle || !isRedisAvailable()) {
    log.info('Redis not available, using local SessionQueue fallback');
    return false;
  }

  try {
    const { Queue, Worker } = await import('bullmq');
    const config = getQueueConfig();

    // BullMQ Workers use blocking Redis commands (BRPOPLPUSH / XREADGROUP)
    // which require maxRetriesPerRequest: null.
    // createBullMQPair is cluster-aware: in cluster mode it builds fresh
    // Cluster instances from the handle's seed nodes.
    const pair = createBullMQPair(handle);
    queueConnection = pair.queueConnection;
    workerConnection = pair.workerConnection;
    bullQueue = new Queue('llm-requests', {
      connection: queueConnection,
      prefix: BULLMQ_CLUSTER_SAFE_PREFIX,
      defaultJobOptions: {
        removeOnComplete: { count: 1000, age: 86400 },
        removeOnFail: { count: 500, age: 604800 },
        attempts: 1, // LLM calls are not idempotent
      },
    });

    bullWorker = new Worker(
      'llm-requests',
      async (job: any) => {
        const data = job.data as LLMJobData;
        const callbacks = callbackRegistry.get(data.jobId);

        if (!callbacks) {
          log.warn('No callbacks found for job, likely timed out', { jobId: data.jobId });
          return;
        }

        if (callbacks.execOptions?.signal?.aborted) {
          callbacks.reject(new Error('Execution aborted'));
          return;
        }

        let lockAcquired = false;
        try {
          // Check job age — expire stale jobs
          const age = Date.now() - data.enqueuedAt;
          if (age > config.jobTimeoutMs) {
            callbacks.reject(
              new Error(`Job expired after ${age}ms (timeout: ${config.jobTimeoutMs}ms)`),
            );
            return;
          }

          // Acquire per-session execution lock (spin-wait with backoff)
          // This ensures only one message per session executes at a time,
          // even across pods. Replaces BullMQ Pro's group feature.
          lockAcquired = await acquireSessionLock(data.sessionId, config.jobTimeoutMs);
          if (!lockAcquired) {
            callbacks.reject(
              new Error(
                `Failed to acquire session lock for ${data.sessionId} within ${config.jobTimeoutMs}ms`,
              ),
            );
            return;
          }

          const executor = await resolveExecutor();

          // Establish observability context so downstream code can read getCurrentTraceId().
          // Prefer extracted span context (includes parent spanId) over raw traceId.
          const extracted = extractTrace(data as unknown as Record<string, unknown>);
          const traceId =
            extracted?.traceId || data.traceId || crypto.randomUUID().replace(/-/g, '');
          const spanId = extracted?.spanId || crypto.randomUUID().replace(/-/g, '').slice(0, 16);

          const result = await runWithObservabilityContext({ traceId, spanId }, () =>
            executor.executeMessage(
              data.sessionId,
              data.message,
              callbacks.onChunk,
              callbacks.onTraceEvent,
              callbacks.execOptions ?? data.execOptions,
            ),
          );

          callbacks.resolve(result);
        } catch (error) {
          callbacks.reject(error);
        } finally {
          if (lockAcquired) {
            await releaseSessionLock(data.sessionId);
          }
          cleanupJob(data.jobId);
        }
      },
      {
        connection: workerConnection,
        prefix: BULLMQ_CLUSTER_SAFE_PREFIX,
        concurrency: config.concurrency,
      },
    );

    bullWorker.on('error', (err: Error) => {
      log.error('BullMQ worker error', { error: err.message });
    });

    bullAvailable = true;

    // Start periodic stale callback sweep (if not already running)
    if (!staleSweepTimer) {
      staleSweepTimer = setInterval(cleanStaleCallbacks, STALE_SWEEP_INTERVAL_MS);
      staleSweepTimer.unref(); // Don't prevent process exit
    }

    log.info('BullMQ initialized', { concurrency: config.concurrency });
    return true;
  } catch (err) {
    log.warn('BullMQ init failed, using local fallback', {
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}

function getLocalQueue(): SessionQueue {
  if (!localQueue) {
    const config = getQueueConfig();
    localQueue = new SessionQueue(config.concurrency);
  }
  return localQueue;
}

/**
 * Scan the callback registry and remove entries older than CALLBACK_TTL_MS.
 * Rejected callbacks receive an expiry error so callers don't hang forever.
 */
function cleanStaleCallbacks(): number {
  const now = Date.now();
  let cleaned = 0;
  for (const [id, cb] of callbackRegistry) {
    if (now - cb.registeredAt > CALLBACK_TTL_MS) {
      cb.reject(new Error(`Callback expired after ${CALLBACK_TTL_MS}ms TTL`));
      cleanupJob(id);
      cleaned++;
    }
  }
  return cleaned;
}

function cleanupJob(jobId: string): void {
  const callbacks = callbackRegistry.get(jobId);
  callbacks?.detachAbortListener?.();
  callbackRegistry.delete(jobId);
  const timer = timeoutTimers.get(jobId);
  if (timer) {
    clearTimeout(timer);
    timeoutTimers.delete(jobId);
  }
}

// =============================================================================
// PUBLIC API
// =============================================================================

/** @deprecated LLM queue is now always active. Returns true unless explicitly disabled via LLM_QUEUE_ENABLED=false. */
export function isLLMQueueEnabled(): boolean {
  return getQueueConfig().enabled;
}

/**
 * Enqueue an LLM request. Returns a Promise that resolves when the worker finishes.
 *
 * If BullMQ is available, uses Redis-backed queue for global concurrency + backpressure.
 * Per-session FIFO ordering enforced via SessionService execution locks (not BullMQ groups).
 * Falls back to local SessionQueue with Semaphore cap when Redis unavailable.
 */
export async function enqueueLLMRequest(
  sessionId: string,
  message: string,
  onChunk?: (chunk: string) => void,
  onTraceEvent?: (event: { type: string; data: Record<string, unknown> }) => void,
  tenantId?: string,
  execOptions?: ExecuteMessageOptions,
): Promise<any> {
  if (execOptions?.signal?.aborted) {
    throw new Error('Execution aborted');
  }

  const config = getQueueConfig();
  const jobId = crypto.randomUUID();

  // Try BullMQ first
  const bullReady = await initBullMQ();

  if (bullReady && bullQueue) {
    // Backpressure check
    const waitingCount = await bullQueue.getWaitingCount();
    if (waitingCount > config.backpressureThreshold) {
      emitBackpressureTrace(sessionId, 'queue_depth_exceeded', {
        queueDepth: waitingCount,
        threshold: config.backpressureThreshold,
        tenantId,
      });
      recordBackpressure('queue_depth_exceeded', tenantId);
      throw new BackpressureError(
        `Queue depth ${waitingCount} exceeds threshold ${config.backpressureThreshold}`,
      );
    }

    // Bounds check: prevent unbounded growth of callback closures
    if (callbackRegistry.size >= MAX_CALLBACK_REGISTRY_SIZE) {
      cleanStaleCallbacks();
      if (callbackRegistry.size >= MAX_CALLBACK_REGISTRY_SIZE) {
        emitBackpressureTrace(sessionId, 'callback_registry_full', {
          registrySize: callbackRegistry.size,
          maxSize: MAX_CALLBACK_REGISTRY_SIZE,
          tenantId,
        });
        recordBackpressure('callback_registry_full', tenantId);
        throw new BackpressureError(
          `Callback registry full (${callbackRegistry.size}/${MAX_CALLBACK_REGISTRY_SIZE})`,
        );
      }
    }

    // Create promise that resolves when worker processes the job
    const result = new Promise<any>((resolve, reject) => {
      let detachAbortListener: (() => void) | undefined;
      if (execOptions?.signal) {
        const onAbort = () => {
          const callbacks = callbackRegistry.get(jobId);
          if (!callbacks) {
            return;
          }
          callbacks.reject(new Error('Execution aborted'));
          cleanupJob(jobId);
        };
        execOptions.signal.addEventListener('abort', onAbort, { once: true });
        detachAbortListener = () => execOptions.signal?.removeEventListener('abort', onAbort);
      }

      callbackRegistry.set(jobId, {
        onChunk,
        onTraceEvent,
        resolve,
        reject,
        registeredAt: Date.now(),
        execOptions,
        detachAbortListener,
      });

      // Timeout safety net: clean up orphaned callbacks
      const timer = setTimeout(() => {
        const callbacks = callbackRegistry.get(jobId);
        if (callbacks) {
          callbacks.reject(
            new Error(`Job ${jobId} timed out after ${config.jobTimeoutMs + 5000}ms`),
          );
          cleanupJob(jobId);
        }
      }, config.jobTimeoutMs + 5000);

      timeoutTimers.set(jobId, timer);
    });

    // Enqueue job — per-session ordering enforced by execution lock in worker
    const jobData: LLMJobData = {
      jobId,
      sessionId,
      message,
      tenantId,
      enqueuedAt: Date.now(),
      execOptions: execOptions
        ? {
            attachmentIds: execOptions.attachmentIds,
            messageMetadata: execOptions.messageMetadata,
            interactionContext: execOptions.interactionContext,
            actionEvent: execOptions.actionEvent,
            channelMetadata: execOptions.channelMetadata,
          }
        : undefined,
      traceId: getCurrentTraceId(),
    };

    // Inject full span context for cross-boundary propagation
    const obsCtx = getObservabilityContext();
    if (obsCtx) {
      injectTrace(jobData as unknown as Record<string, unknown>, {
        traceId: obsCtx.traceId,
        spanId: obsCtx.spanId,
      });
    }

    await bullQueue.add('llm-request', jobData);

    return result;
  }

  // Fallback: local SessionQueue (already provides per-session FIFO locally)
  const queue = getLocalQueue();
  return queue.enqueue(sessionId, async () => {
    if (execOptions?.signal?.aborted) {
      throw new Error('Execution aborted');
    }
    const config2 = getQueueConfig();
    const lockAcquired = await acquireSessionLock(sessionId, config2.jobTimeoutMs);
    if (!lockAcquired) {
      throw new AppError(
        `Failed to acquire session lock for ${sessionId} within ${config2.jobTimeoutMs}ms`,
        { ...ErrorCodes.SERVICE_UNAVAILABLE },
      );
    }
    try {
      if (execOptions?.signal?.aborted) {
        throw new Error('Execution aborted');
      }
      const executor = await resolveExecutor();
      return await executor.executeMessage(sessionId, message, onChunk, onTraceEvent, execOptions);
    } finally {
      await releaseSessionLock(sessionId);
    }
  });
}

/**
 * Gracefully shut down the LLM queue.
 * Pauses queue, waits for active workers, rejects pending callbacks, closes.
 */
export async function shutdownLLMQueue(): Promise<void> {
  log.info('LLM queue shutting down');

  // Stop periodic stale sweep
  if (staleSweepTimer) {
    clearInterval(staleSweepTimer);
    staleSweepTimer = null;
  }

  // Reject all pending callbacks
  for (const [jobId, callbacks] of callbackRegistry) {
    callbacks.reject(new Error('Queue shutting down'));
    cleanupJob(jobId);
  }

  // Clear all timeout timers
  for (const [jobId, timer] of timeoutTimers) {
    clearTimeout(timer);
  }
  timeoutTimers.clear();

  // Close BullMQ
  if (bullWorker) {
    try {
      await bullWorker.close();
    } catch {
      // Ignore close errors
    }
    bullWorker = null;
  }

  if (bullQueue) {
    try {
      await bullQueue.close();
    } catch {
      // Ignore close errors
    }
    bullQueue = null;
  }

  // Disconnect duplicated Redis connections (created by createBullMQPair in initBullMQ).
  // BullMQ's close() does not disconnect the underlying Redis connection it was given.
  if (queueConnection) {
    try {
      queueConnection.disconnect();
    } catch {
      // Best-effort cleanup
    }
    queueConnection = null;
  }
  if (workerConnection) {
    try {
      workerConnection.disconnect();
    } catch {
      // Best-effort cleanup
    }
    workerConnection = null;
  }

  bullInitAttempted = false;
  bullAvailable = false;
  localQueue = null;

  log.info('LLM queue shutdown complete');
}

// =============================================================================
// TRACE EVENT HELPERS
// =============================================================================

/**
 * Emit a trace event for backpressure / queue pressure decisions.
 * Best-effort — never throws (avoids masking the actual BackpressureError).
 * TODO: Route through session Tracer for span context once backpressure path has access to it
 */
function emitBackpressureTrace(
  sessionId: string,
  reason: string,
  data: Record<string, unknown>,
): void {
  try {
    getTraceStore().addEvent(sessionId, {
      id: crypto.randomUUID(),
      sessionId,
      type: 'queue_backpressure',
      timestamp: new Date(),
      data: { reason, ...data },
    });
  } catch {
    // Best-effort — don't fail the request because tracing broke
  }
}

// =============================================================================
// TEST-ONLY EXPORTS
// =============================================================================

/** @internal Test-only: get current callback registry size */
export function _getCallbackRegistrySize(): number {
  return callbackRegistry.size;
}

/** @internal Test-only: directly register a callback for bounds testing */
export function _registerTestCallback(jobId: string, callbacks: LLMJobCallbacks): void {
  callbackRegistry.set(jobId, callbacks);
}

/** @internal Test-only: clean stale callbacks */
export function _cleanStaleCallbacks(): number {
  return cleanStaleCallbacks();
}

/** @internal Test-only: get current duplicated Redis connection references */
export function _getConnections(): { queue: any; worker: any } {
  return { queue: queueConnection, worker: workerConnection };
}
