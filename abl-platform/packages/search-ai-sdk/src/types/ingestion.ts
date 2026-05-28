/**
 * Ingestion Types
 *
 * Job definitions and events for the ingestion pipeline.
 */

import type { IngestionStage } from '../constants.js';

// ─── Ingestion Jobs ──────────────────────────────────────────────────────────

export interface IngestionJob {
  jobId: string;
  indexId: string;
  sourceId: string;
  tenantId: string;
  /** Document IDs to process (empty = full source sync) */
  documentIds?: string[];
  /** Priority (lower = higher priority) */
  priority?: number;
  /** Job-specific options */
  options?: IngestionJobOptions;
}

export interface IngestionJobOptions {
  /** Force re-extraction even if content hash hasn't changed */
  forceExtract?: boolean;
  /** Force re-embedding even if content hasn't changed */
  forceEmbed?: boolean;
  /** Skip enrichment step */
  skipEnrichment?: boolean;
  /** Maximum documents to process in this job */
  batchSize?: number;
}

// ─── Ingestion Events ────────────────────────────────────────────────────────

export interface IngestionEvent {
  eventId: string;
  indexId: string;
  sourceId: string;
  documentId?: string;
  tenantId: string;
  /** Pipeline stage */
  stage: IngestionStage;
  /** Event status */
  status: 'started' | 'completed' | 'failed' | 'retried';
  /** Duration in milliseconds */
  durationMs: number;
  /** Number of chunks produced (for chunk/embed stages) */
  chunkCount?: number;
  /** Token count (for embedding stage) */
  tokenCount?: number;
  /** Estimated embedding cost */
  embeddingCost?: number;
  /** Number of canonical fields successfully mapped */
  fieldsMapped?: number;
  /** Error details */
  error?: IngestionErrorDetail;
  /** Content metadata */
  contentType?: string;
  contentSizeBytes?: number;
  /** Retry count */
  retryCount?: number;
  timestamp: string;
}

export interface IngestionErrorDetail {
  message: string;
  code?: string;
  retryable: boolean;
}

// ─── Ingestion Status ────────────────────────────────────────────────────────

export interface IngestionProgress {
  indexId: string;
  sourceId: string;
  /** Total documents to process */
  totalDocuments: number;
  /** Documents completed */
  processedDocuments: number;
  /** Documents failed */
  failedDocuments: number;
  /** Total chunks created */
  totalChunks: number;
  /** Total tokens embedded */
  totalTokens: number;
  /** Estimated cost so far */
  estimatedCost: number;
  /** Current stage of the pipeline */
  currentStage: IngestionStage | null;
  /** Start time */
  startedAt: string;
  /** Estimated completion time */
  estimatedCompletionAt?: string;
}
