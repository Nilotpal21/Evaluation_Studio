/**
 * Pipeline Orchestration Types
 *
 * Type definitions for BullMQ Flows integration with pluggable pipelines.
 *
 * Reference: docs/searchai/BULLMQ-FLOWS-PRODUCTION-GUIDE.md
 */

import type { FlowJob, JobsOptions } from 'bullmq';
import type { FlowContext } from '../flow-selection/types.js';

// ─── Flow Context ────────────────────────────────────────────────────────

/**
 * Context passed to flow builder for pipeline execution.
 *
 * Extends FlowContext (document + source metadata) so the builder can
 * pass it directly to FlowSelectionService.selectFlow() without mapping.
 */
export interface FlowBuildContext extends FlowContext {
  /** Document being processed */
  documentId: string;
  /** Tenant ID for multi-tenancy isolation */
  tenantId: string;
  /** Source that triggered ingestion */
  sourceId: string;
  /** Knowledge base index */
  indexId: string;
  /** Source URL (S3 or HTTP) — required by extraction workers to fetch the file */
  sourceUrl?: string;
}

/**
 * Pipeline context embedded in every flow job.
 *
 * This context is added to job.data by the flow builder and tracked
 * in JobExecution for observability.
 */
export interface PipelineJobContext {
  /** Pipeline definition ID */
  pipelineId: string;
  /** Pipeline version number */
  pipelineVersion: number;
  /** Flow parent job ID for tracking */
  flowJobId: string;
  /** Document being processed */
  documentId: string;
  /** Tenant ID */
  tenantId: string;
  /** Source ID */
  sourceId: string;
  /** Index ID */
  indexId: string;
}

// ─── Flow Builder Results ────────────────────────────────────────────────

/**
 * Result of flow building operation.
 */
export interface FlowBuildResult {
  /** Whether flow was built successfully */
  success: boolean;
  /** Flow parent job ID (if success) */
  flowJobId?: string;
  /** Flow structure (if success) */
  flow?: FlowJob;
  /** Error message (if failure) */
  error?: string;
  /** Build details */
  details: {
    /** Pipeline ID used */
    pipelineId: string;
    /** Selected flow ID */
    selectedFlowId?: string;
    /** Number of stages in flow */
    stageCount: number;
    /** Queue names used */
    queueNames: string[];
  };
}

// ─── Lock Duration Settings ──────────────────────────────────────────────

/**
 * Lock duration settings for a worker.
 *
 * lockDuration: How long a worker can hold a job before it's considered stalled
 * stalledInterval: How often to check for stalled jobs
 */
export interface LockSettings {
  /** Lock duration in milliseconds */
  lockDuration: number;
  /** Stalled check interval in milliseconds */
  stalledInterval: number;
}

// ─── Error Classes ───────────────────────────────────────────────────────

/**
 * Error thrown when queue backpressure threshold is exceeded.
 */
export class BackpressureError extends Error {
  constructor(
    message: string,
    public readonly queueName: string,
    public readonly currentDepth: number,
    public readonly maxDepth: number,
    public readonly retryAfterMs: number = 30_000,
  ) {
    super(message);
    this.name = 'BackpressureError';
    Error.captureStackTrace?.(this, BackpressureError);
  }
}

/**
 * Error thrown when flow building fails.
 */
export class FlowBuildError extends Error {
  constructor(
    message: string,
    public readonly pipelineId: string,
    public readonly cause?: Error,
  ) {
    super(message);
    this.name = 'FlowBuildError';
    Error.captureStackTrace?.(this, FlowBuildError);
  }
}

/**
 * Error thrown when FlowProducer.add() fails silently.
 *
 * Issue #3851: FlowProducer.add() does not throw when Redis operations fail.
 */
export class FlowCreationValidationError extends Error {
  constructor(
    message: string,
    public readonly flowName: string,
    public readonly flowJobId: string,
  ) {
    super(message);
    this.name = 'FlowCreationValidationError';
    Error.captureStackTrace?.(this, FlowCreationValidationError);
  }
}

// ─── Constants ───────────────────────────────────────────────────────────

/**
 * CRITICAL: Flow child job defaults.
 *
 * These options MUST be applied to EVERY child job in a flow.
 * Without failParentOnFailure, the parent waits FOREVER for failed children.
 * Without removeOnComplete/removeOnFail, Redis memory grows unbounded.
 *
 * Reference: docs/searchai/BULLMQ-FLOWS-PRODUCTION-GUIDE.md (lines 631-644)
 */
export const FLOW_CHILD_DEFAULTS: JobsOptions = {
  // CRITICAL: Define failure behavior (without this, parent waits forever)
  failParentOnFailure: true,

  // CRITICAL: Prevent Redis memory accumulation
  removeOnComplete: {
    age: 3600, // 1 hour
    count: 200, // Keep last 200 completed jobs
  },
  removeOnFail: {
    age: 86400, // 24 hours (keep failures longer for debugging)
    count: 1000, // Keep last 1000 failed jobs
  },

  // Retry with exponential backoff
  attempts: 3,
  backoff: {
    type: 'exponential',
    delay: 5000, // Start with 5s, then 10s, 20s
  },

  // Note: lockDuration, stalledInterval, maxStalledCount are WorkerOptions (not JobsOptions).
  // They must be configured per-worker, not per-job. See getWorkerLockSettings() in flow-builder.ts.
};

/**
 * Maximum queue depth before backpressure kicks in.
 *
 * BullMQ has NO built-in backpressure mechanism. These limits prevent
 * Redis OOM when downstream services are slow.
 *
 * Reference: docs/searchai/BULLMQ-FLOWS-PRODUCTION-GUIDE.md (lines 284-289)
 */
export const MAX_QUEUE_DEPTH: Record<string, number> = {
  // Heavy processing stages (CPU/model intensive)
  'search-extraction': 500,
  'search-docling-extraction': 300, // Slower than regular extraction
  'search-page-processing': 500,

  // Knowledge graph stages (Neo4j intensive)
  'search-kg-enrichment': 200,
  'search-tree-building': 200,

  // LLM stages (rate limited)
  'search-enrichment': 1000,
  'search-question-synthesis': 500,
  'search-scope-classification': 500,

  // Embedding/multimodal stages (API rate limited)
  'search-embedding': 500,
  'search-multimodal': 500,
  'search-visual-enrichment': 500,

  // Fast stages
  'search-ingestion': 1000,
  'search-canonical-mapper': 1000,
  'search-cleanup': 1000,
};
