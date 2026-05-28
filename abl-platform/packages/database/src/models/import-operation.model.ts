/**
 * ImportOperation Model
 *
 * Tracks staged import operations for crash recovery and progress monitoring.
 * Each import goes through phases: validating → staging → activating → completed.
 * On failure, supports rollback of partially activated layers.
 */

import mongoose, { Schema, model } from 'mongoose';
import { uuidv7 } from '../mongo/base-document.js';
import { tenantIsolationPlugin } from '../mongo/plugins/tenant-isolation.plugin.js';

// ─── Constants ──────────────────────────────────────────────────────────

/** TTL for completed operations with snapshots (30 days) */
export const COMPLETED_OPERATION_TTL_SECONDS = 30 * 24 * 3600;

/** Threshold for detecting stuck operations (5 minutes) */
export const STUCK_OPERATION_THRESHOLD_MS = 5 * 60 * 1000;

// ─── Document Interface ──────────────────────────────────────────────────

export type ImportPhase =
  | 'validating'
  | 'staging'
  | 'activating'
  | 'completed'
  | 'failed'
  | 'rolling_back'
  | 'reverted';

export type LayerImportStatus = 'pending' | 'staged' | 'activated' | 'rolled_back';

export interface IImportOperationLayer {
  status: LayerImportStatus;
}

export interface IImportOperationError {
  phase: string;
  layer: string;
  message: string;
}

export interface IImportOperation {
  _id: string;
  projectId: string;
  tenantId: string;
  status: ImportPhase;
  layers: Record<string, IImportOperationLayer>;
  stagedRecordIds: Record<string, string[]>;
  supersededRecordIds: Record<string, string[]>;
  error?: IImportOperationError;
  preImportSnapshot?: Buffer;
  createdAt: Date;
  updatedAt: Date;
  expiresAt: Date;
}

// ─── Schema ──────────────────────────────────────────────────────────────

const ImportOperationSchema = new Schema<IImportOperation>(
  {
    _id: { type: String, default: uuidv7 },
    projectId: { type: String, required: true },
    tenantId: { type: String, required: true },
    status: {
      type: String,
      required: true,
      enum: [
        'validating',
        'staging',
        'activating',
        'completed',
        'failed',
        'rolling_back',
        'reverted',
      ],
      default: 'validating',
    },
    layers: { type: Schema.Types.Mixed, default: {} },
    stagedRecordIds: { type: Schema.Types.Mixed, default: {} },
    supersededRecordIds: { type: Schema.Types.Mixed, default: {} },
    error: {
      type: new Schema(
        {
          phase: { type: String, required: true },
          layer: { type: String, required: true },
          message: { type: String, required: true },
        },
        { _id: false },
      ),
      default: undefined,
    },
    preImportSnapshot: { type: Buffer, default: undefined },
    expiresAt: { type: Date, required: true },
  },
  { timestamps: true, collection: 'import_operations' },
);

// ─── Plugins ─────────────────────────────────────────────────────────────

ImportOperationSchema.plugin(tenantIsolationPlugin);

// ─── Indexes ─────────────────────────────────────────────────────────────

ImportOperationSchema.index({ projectId: 1, tenantId: 1, status: 1 });
ImportOperationSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
ImportOperationSchema.index({ status: 1, updatedAt: 1 });

// ─── Model ───────────────────────────────────────────────────────────────

export const ImportOperation =
  (mongoose.models.ImportOperation as mongoose.Model<IImportOperation>) ||
  model<IImportOperation>('ImportOperation', ImportOperationSchema);
