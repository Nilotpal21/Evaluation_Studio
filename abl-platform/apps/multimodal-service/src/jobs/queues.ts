/**
 * BullMQ Queue Definitions and Shared Infrastructure
 *
 * Defines queue names, job data interfaces, and shared helpers for the
 * attachment processing pipeline: scan -> validate -> process -> index.
 *
 * Follows the same pattern as `apps/search-ai/src/workers/shared.ts`.
 * All queues share a single Redis connection derived from environment variables.
 */

import { Queue } from 'bullmq';
import type { WorkerOptions } from 'bullmq';
import { createLogger } from '@abl/compiler/platform';
import {
  BULLMQ_CLUSTER_SAFE_PREFIX,
  createRedisConnection,
  resolveRedisOptionsFromEnv,
  type RedisConnectionHandle,
} from '@agent-platform/redis';

const log = createLogger('multimodal-job-queues');

// =============================================================================
// QUEUE NAMES
// =============================================================================

export const QUEUE_NAMES = {
  SCAN: 'attachment-scan',
  VALIDATE: 'attachment-validate',
  PROCESS: 'attachment-process',
  INDEX: 'attachment-index',
  CLEANUP: 'attachment-cleanup',
} as const;

// =============================================================================
// JOB DATA INTERFACES
// =============================================================================

export interface ScanJobData {
  attachmentId: string;
  tenantId: string;
}

export interface ValidateJobData {
  attachmentId: string;
  tenantId: string;
}

export interface ProcessJobData {
  attachmentId: string;
  tenantId: string;
  category: string;
}

export interface IndexJobData {
  attachmentId: string;
  tenantId: string;
}

export interface CleanupJobData {
  attachmentId: string;
  tenantId: string;
  reason: string;
}

// =============================================================================
// REDIS CONNECTION (cluster-aware via @agent-platform/redis)
// =============================================================================

let _handle: RedisConnectionHandle | null | undefined;

/**
 * Lazy-initialize a shared RedisConnectionHandle from environment variables.
 * Returns null if Redis is explicitly disabled (REDIS_ENABLED=false).
 *
 * The handle supports both standalone and cluster mode (REDIS_CLUSTER=true).
 * BullMQ Queue/Worker connections are derived via `handle.duplicate()`.
 */
function getHandle(): RedisConnectionHandle | null {
  if (_handle !== undefined) return _handle;
  const opts = resolveRedisOptionsFromEnv();
  _handle = opts ? createRedisConnection(opts) : null;
  return _handle;
}

// =============================================================================
// QUEUE & WORKER FACTORIES
// =============================================================================

/**
 * Create a BullMQ Queue attached to the shared Redis connection.
 * Each Queue gets its own duplicated connection (BullMQ best practice).
 */
export function createQueue(name: string): Queue {
  const handle = getHandle();
  if (!handle) throw new Error('Redis not configured for queues');
  return new Queue(name, {
    connection: handle.duplicate({ maxRetriesPerRequest: null }),
    prefix: BULLMQ_CLUSTER_SAFE_PREFIX,
  });
}

/**
 * Build common WorkerOptions for pipeline workers.
 *
 * @param concurrency - max parallel jobs per worker (default 5)
 */
export function createWorkerOptions(concurrency = 5): WorkerOptions {
  // BullMQ Workers use blocking Redis commands (BRPOPLPUSH / XREADGROUP)
  // which require maxRetriesPerRequest: null to avoid premature failures.
  const handle = getHandle();
  if (!handle) throw new Error('Redis not configured for workers');
  return {
    connection: handle.duplicate({ maxRetriesPerRequest: null }),
    prefix: BULLMQ_CLUSTER_SAFE_PREFIX,
    concurrency,
    // Auto-remove completed / failed jobs after 24h / 7d to avoid unbounded growth
    removeOnComplete: { age: 86_400 },
    removeOnFail: { age: 604_800 },
  };
}

// =============================================================================
// LOGGING HELPERS
// =============================================================================

export function workerLog(worker: string, message: string, meta?: Record<string, unknown>): void {
  log.info(message, { worker, ...meta });
}

export function workerError(worker: string, message: string, error: unknown): void {
  log.error(message, {
    worker,
    error: error instanceof Error ? error.message : String(error),
    stack: error instanceof Error ? error.stack : undefined,
  });
}
