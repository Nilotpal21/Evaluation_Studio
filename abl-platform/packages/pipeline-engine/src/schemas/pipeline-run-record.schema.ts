/**
 * PipelineRunRecord Model
 *
 * Persists the execution state of individual pipeline runs.
 * Each record tracks the run lifecycle, per-step status, timing,
 * and any error that caused the run to fail.
 */

import mongoose, { Schema, model, type Model } from 'mongoose';

// ─── Document Interface ──────────────────────────────────────────────────

export interface IPipelineRunRecord {
  _id: string;
  runId: string;
  pipelineId: string;
  pipelineVersion: number;
  tenantId: string;
  projectId?: string;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';
  trigger: {
    type: 'kafka' | 'schedule' | 'manual';
    kafkaTopic?: string;
    triggeredBy?: string;
    triggerId: string;
    executionMode: 'batch' | 'realtime';
  };
  input: Record<string, any>;
  triggerInput?: Record<string, any>;
  triggerInputTruncated?: boolean;
  steps: Array<{
    id: string;
    name: string;
    type: string;
    status: 'pending' | 'running' | 'completed' | 'failed' | 'skipped';
    startedAt?: Date;
    completedAt?: Date;
    durationMs?: number;
    output?: Record<string, any>;
  }>;
  startedAt: Date;
  completedAt?: Date;
  durationMs?: number;
  error?: {
    stepId: string;
    message: string;
  };
}

// ─── Schema ──────────────────────────────────────────────────────────────

const PipelineRunRecordSchema = new Schema<IPipelineRunRecord>(
  {
    _id: { type: String, required: true },
    runId: { type: String, required: true },
    pipelineId: { type: String, required: true },
    pipelineVersion: { type: Number, required: true },
    tenantId: { type: String, required: true },
    projectId: { type: String, index: true },
    status: {
      type: String,
      required: true,
      enum: ['pending', 'running', 'completed', 'failed', 'cancelled'],
    },
    trigger: {
      type: { type: String, required: true, enum: ['kafka', 'schedule', 'manual'] },
      kafkaTopic: { type: String },
      triggeredBy: { type: String },
      triggerId: { type: String, default: '' },
      executionMode: { type: String, enum: ['batch', 'realtime'], default: 'batch' },
    },
    input: { type: Schema.Types.Mixed, default: {} },
    triggerInput: { type: Schema.Types.Mixed },
    triggerInputTruncated: { type: Boolean },
    steps: [{ type: Schema.Types.Mixed }],
    startedAt: { type: Date, required: true },
    completedAt: { type: Date },
    durationMs: { type: Number },
    error: {
      stepId: { type: String },
      message: { type: String },
    },
  },
  { collection: 'pipeline_run_records' },
);

// ─── Indexes ─────────────────────────────────────────────────────────────

PipelineRunRecordSchema.index({ runId: 1 }, { unique: true });
PipelineRunRecordSchema.index({ tenantId: 1, pipelineId: 1, startedAt: -1 });
PipelineRunRecordSchema.index({ tenantId: 1, status: 1 });
PipelineRunRecordSchema.index({ startedAt: 1 }, { expireAfterSeconds: 90 * 24 * 60 * 60 }); // 90-day TTL
PipelineRunRecordSchema.index({ tenantId: 1, projectId: 1, startedAt: -1 });
PipelineRunRecordSchema.index({ tenantId: 1, projectId: 1, pipelineId: 1, startedAt: -1 });

// ─── Model ───────────────────────────────────────────────────────────────

export const PipelineRunRecordModel =
  (mongoose.models['PipelineRunRecord'] as Model<IPipelineRunRecord>) ??
  model<IPipelineRunRecord>('PipelineRunRecord', PipelineRunRecordSchema);
