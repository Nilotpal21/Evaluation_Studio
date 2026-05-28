/**
 * Status Transition Logger
 *
 * Centralized logging for document status transitions across all workers.
 * Provides visibility into pipeline flow and helps debug stuck documents.
 */

import { createLogger } from '@abl/compiler/platform';
import type { DocumentStatus } from '@agent-platform/search-ai-sdk';

const logger = createLogger('status-logger');

export interface StatusTransitionMetadata {
  documentId: string;
  indexId: string;
  tenantId: string;
  fromStatus: string | DocumentStatus;
  toStatus: DocumentStatus;
  worker: string;
  timestamp: Date;
  /** Duration since document creation or last transition (ms) */
  durationMs?: number;
  /** Additional context (e.g., chunk count, error details) */
  metadata?: Record<string, any>;
}

/**
 * Log a status transition with structured metadata
 */
export function logStatusTransition(transition: StatusTransitionMetadata): void {
  const {
    documentId,
    indexId,
    tenantId,
    fromStatus,
    toStatus,
    worker,
    timestamp,
    durationMs,
    metadata,
  } = transition;

  logger.info(`[status-transition][${worker}] ${documentId}: ${fromStatus} → ${toStatus}`, {
    documentId,
    indexId,
    tenantId,
    fromStatus,
    toStatus,
    worker,
    timestamp: timestamp.toISOString(),
    durationMs,
    ...metadata,
  });
}

/**
 * Log queue job pickup
 */
export function logJobPickup(data: {
  worker: string;
  jobId: string;
  documentId?: string;
  queueName: string;
  timestamp: Date;
}): void {
  const { worker, jobId, documentId, queueName, timestamp } = data;

  logger.info(`[job-pickup][${worker}] Job picked up from queue ${queueName}`, {
    worker,
    jobId,
    documentId,
    queueName,
    timestamp: timestamp.toISOString(),
  });
}

/**
 * Log job completion
 */
export function logJobCompletion(data: {
  worker: string;
  jobId: string;
  documentId?: string;
  status: 'completed' | 'failed';
  durationMs: number;
  timestamp: Date;
  error?: string;
}): void {
  const { worker, jobId, documentId, status, durationMs, timestamp, error } = data;

  const logMethod = status === 'failed' ? 'error' : 'info';
  logger[logMethod](`[job-completion][${worker}] Job ${status}: ${jobId}`, {
    worker,
    jobId,
    documentId,
    status,
    durationMs,
    timestamp: timestamp.toISOString(),
    error,
  });
}

/**
 * Log queue enqueue operation
 */
export function logQueueEnqueue(data: {
  worker: string;
  targetQueue: string;
  jobId: string;
  documentId?: string;
  timestamp: Date;
}): void {
  const { worker, targetQueue, jobId, documentId, timestamp } = data;

  logger.info(`[queue-enqueue][${worker}] Enqueued job to ${targetQueue}`, {
    worker,
    targetQueue,
    jobId,
    documentId,
    timestamp: timestamp.toISOString(),
  });
}
