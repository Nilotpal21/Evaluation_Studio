/**
 * Job Execution Model
 *
 * Tracks individual job executions for all SearchAI pipeline workers.
 * Implements 90-day TTL retention policy to prevent unbounded storage growth.
 *
 * Design: Flat schema with context fields (no parent-child links)
 * Retention: TTL index automatically deletes jobs after 90 days
 * Scoped to tenant via tenant isolation plugin
 *
 * Reference: docs/searchai/pipelines/design/backend/02-JOB-TRACKING-RETENTION.md
 */

import mongoose, { Schema, model } from 'mongoose';
import { uuidv7 } from '../mongo/base-document.js';
import { tenantIsolationPlugin } from '../mongo/plugins/tenant-isolation.plugin.js';

// ─── Document Interfaces ─────────────────────────────────────────────────

export type WorkerStage =
  | 'connector-discovery'
  | 'connector-ingestion'
  | 'docling-extraction'
  | 'tree-building'
  | 'embedding'
  | 'enrichment'
  | 'multimodal'
  | 'storage';

export type JobExecutionStatus = 'pending' | 'running' | 'completed' | 'failed';

export interface IJobExecutionError {
  code: string;
  message: string;
  stack?: string;
}

export interface IJobExecution {
  _id: string;
  tenantId: string;

  // BullMQ correlation
  bullJobId: string;
  workerStage: WorkerStage;

  // Context fields (enables flat schema queries)
  documentId: string;
  sourceId: string;
  indexId: string;

  // Execution state
  status: JobExecutionStatus;
  startedAt: Date;
  completedAt?: Date;
  duration?: number;

  // Metrics and tracing
  metrics?: Record<string, unknown>;
  error?: IJobExecutionError;
  traceId?: string;

  // BullMQ Flows integration (RFC-006)
  pipelineId?: string;
  pipelineVersion?: number;
  flowJobId?: string;

  // Timestamps (createdAt used for TTL index)
  createdAt: Date;
  updatedAt: Date;
}

// ─── Schemas ─────────────────────────────────────────────────────────────

const JobExecutionSchema = new Schema<IJobExecution>(
  {
    _id: { type: String, default: uuidv7 },
    tenantId: {
      type: String,
      required: true,
      index: true,
    },
    bullJobId: {
      type: String,
      required: true,
      index: true,
    },
    workerStage: {
      type: String,
      required: true,
      enum: [
        'connector-discovery',
        'connector-ingestion',
        'docling-extraction',
        'tree-building',
        'embedding',
        'enrichment',
        'multimodal',
        'storage',
      ],
    },
    documentId: {
      type: String,
      required: true,
      index: true,
    },
    sourceId: {
      type: String,
      required: true,
    },
    indexId: {
      type: String,
      required: true,
    },
    status: {
      type: String,
      enum: ['pending', 'running', 'completed', 'failed'],
      required: true,
      default: 'pending',
    },
    startedAt: {
      type: Date,
      required: true,
      default: Date.now,
    },
    completedAt: {
      type: Date,
      required: false,
    },
    duration: {
      type: Number,
      min: 0,
      required: false,
    },
    metrics: {
      type: Schema.Types.Mixed,
      required: false,
    },
    error: {
      type: {
        code: { type: String, required: true },
        message: { type: String, required: true },
        stack: { type: String, required: false },
      },
      required: false,
    },
    traceId: {
      type: String,
      index: true,
      required: false,
    },

    // BullMQ Flows integration
    pipelineId: {
      type: String,
      index: true,
      required: false,
    },
    pipelineVersion: {
      type: Number,
      min: 1,
      required: false,
    },
    flowJobId: {
      type: String,
      index: true,
      required: false,
    },
  },
  {
    timestamps: true,
    collection: 'job_executions',
  },
);

// ─── Plugins ─────────────────────────────────────────────────────────────

JobExecutionSchema.plugin(tenantIsolationPlugin);

// ─── Indexes ─────────────────────────────────────────────────────────────

// 1. Unique index: (tenantId, bullJobId) - prevent duplicates
JobExecutionSchema.index({ tenantId: 1, bullJobId: 1 }, { unique: true });

// 2. Document history: (tenantId, documentId, createdAt desc) - O(log n) document history queries
JobExecutionSchema.index({ tenantId: 1, documentId: 1, createdAt: -1 });

// 3. Source summary: (tenantId, sourceId, status) - O(log n) source-level aggregations
JobExecutionSchema.index({ tenantId: 1, sourceId: 1, status: 1 });

// 4. BullMQ Flows: (pipelineId, flowJobId) - Flow execution lookup
JobExecutionSchema.index({ pipelineId: 1, flowJobId: 1 });

// 5. BullMQ Flows: (pipelineId, pipelineVersion, status) - Pipeline metrics
JobExecutionSchema.index({ pipelineId: 1, pipelineVersion: 1, status: 1 });

// ─── TTL Index (Retention Policy) ────────────────────────────────────────

/**
 * TTL Index: Automatic deletion after 90 days
 *
 * How it works:
 * - MongoDB background thread runs every 60 seconds
 * - Deletes documents where createdAt + 90 days < now
 * - Deletion is permanent (no recovery)
 *
 * Retention calculation:
 * - expireAfterSeconds: 7776000 (90 days * 24 hours * 3600 seconds)
 * - Documents created on Jan 1 will be deleted on Apr 1
 *
 * Performance impact:
 * - Minimal: TTL deletion is batched and throttled
 * - Does not block writes or reads
 * - Runs during low-load periods when possible
 *
 * Storage impact:
 * - Without TTL: 730GB/year growth (unbounded)
 * - With TTL: ~180GB cap (90-day retention)
 * - Savings: 75%+ after first year
 */
JobExecutionSchema.index(
  { createdAt: 1 },
  {
    expireAfterSeconds: 7776000, // 90 days
    name: 'ttl_createdAt_90days',
  },
);

// ─── Model ───────────────────────────────────────────────────────────────

export const JobExecution =
  (mongoose.models.JobExecution as any) || model<IJobExecution>('JobExecution', JobExecutionSchema);
