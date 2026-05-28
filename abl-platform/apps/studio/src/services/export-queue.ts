/**
 * Async Export Queue -- BullMQ-backed queue for large project exports.
 *
 * For projects exceeding the sync threshold (>100 agents or explicit async request),
 * the export is queued as a background job. Results are stored temporarily in Redis
 * with a TTL, retrievable via job ID.
 */

import { createLogger } from '@abl/compiler/platform/logger.js';
import type { ExportDslFormat } from '@agent-platform/project-io';
import {
  createRedisConnection,
  resolveRedisOptionsFromEnv,
  type RedisConnectionHandle,
} from '@agent-platform/redis';
import {
  createBullMQPair,
  BULLMQ_CLUSTER_SAFE_PREFIX,
  type BullMQConnectionPair,
} from '@agent-platform/redis/bullmq';

const log = createLogger('export-queue');

/** Threshold above which export is automatically made async */
export const ASYNC_EXPORT_THRESHOLD = 100; // agents

export interface ExportJobData {
  projectId: string;
  tenantId: string;
  userId: string;
  format: 'folder' | 'zip' | 'tar.gz';
  layers?: string[];
  dslFormat: ExportDslFormat;
  includeDeployments: boolean;
}

export interface ExportJobResult {
  success: boolean;
  files?: Record<string, string>;
  manifest?: unknown;
  lockfile?: unknown;
  warnings?: string[];
  error?: { code: string; message: string };
  issues?: readonly unknown[];
}

export type ExportJobStatus = 'queued' | 'processing' | 'completed' | 'failed';

export interface ExportJobInfo {
  id: string;
  status: ExportJobStatus;
  progress: number; // 0-100
  tenantId: string;
  projectId: string;
  result?: ExportJobResult;
  createdAt: string;
  completedAt?: string;
  error?: string;
}

// Queue name constant
export const EXPORT_QUEUE_NAME = 'project-export';

// Result TTL: 1 hour
export const EXPORT_RESULT_TTL_MS = 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// Lazy Redis handle (shared across queue + worker in this process)
// ---------------------------------------------------------------------------

let _handle: RedisConnectionHandle | null | undefined;

export function getRedisHandle(): RedisConnectionHandle | null {
  if (_handle !== undefined) return _handle;
  const opts = resolveRedisOptionsFromEnv();
  _handle = opts ? createRedisConnection(opts) : null;
  return _handle;
}

/**
 * Get or create the export queue singleton.
 * Lazy-initialized to avoid connecting to Redis when not needed.
 */
let _queue: any = null;
let _queuePair: BullMQConnectionPair | undefined;

export async function getExportQueue(): Promise<any> {
  if (_queue) return _queue;

  const handle = getRedisHandle();
  if (!handle) throw new Error('Redis not configured for export queue');

  const { Queue } = await import('bullmq');
  const pair = createBullMQPair(handle);
  _queuePair = pair;

  _queue = new Queue(EXPORT_QUEUE_NAME, {
    connection: pair.queueConnection,
    prefix: BULLMQ_CLUSTER_SAFE_PREFIX,
    defaultJobOptions: {
      attempts: 2,
      backoff: { type: 'exponential', delay: 5000 },
      removeOnComplete: { age: EXPORT_RESULT_TTL_MS / 1000, count: 100 },
      removeOnFail: { age: EXPORT_RESULT_TTL_MS / 1000, count: 200 },
    },
  });

  log.info('Export queue initialized');
  return _queue;
}

/**
 * Close the export queue and disconnect the BullMQ Redis connections.
 */
export function closeExportQueue(): void {
  _queuePair?.disconnect();
  _queue = null;
  _queuePair = undefined;
}

/**
 * Enqueue an async export job.
 */
export async function enqueueExportJob(data: ExportJobData): Promise<string> {
  const queue = await getExportQueue();
  const job = await queue.add('export', data, {
    jobId: `export-${data.projectId}-${Date.now()}`,
  });
  log.info('Export job enqueued', { jobId: job.id, projectId: data.projectId });
  return job.id!;
}

/**
 * Get the status of an export job.
 */
export async function getExportJobStatus(jobId: string): Promise<ExportJobInfo | null> {
  const queue = await getExportQueue();
  const job = await queue.getJob(jobId);

  if (!job) return null;

  const state = await job.getState();
  const statusMap: Record<string, ExportJobStatus> = {
    waiting: 'queued',
    delayed: 'queued',
    active: 'processing',
    completed: 'completed',
    failed: 'failed',
  };

  const jobData = job.data as ExportJobData;

  return {
    id: job.id!,
    status: statusMap[state] ?? 'queued',
    progress: typeof job.progress === 'number' ? job.progress : 0,
    tenantId: jobData.tenantId,
    projectId: jobData.projectId,
    result: state === 'completed' ? job.returnvalue : undefined,
    createdAt: new Date(job.timestamp).toISOString(),
    completedAt: job.finishedOn ? new Date(job.finishedOn).toISOString() : undefined,
    error: state === 'failed' ? job.failedReason : undefined,
  };
}

/**
 * Check if a project should use async export based on agent count.
 */
export function shouldUseAsyncExport(agentCount: number, forceAsync?: boolean): boolean {
  return forceAsync === true || agentCount > ASYNC_EXPORT_THRESHOLD;
}
