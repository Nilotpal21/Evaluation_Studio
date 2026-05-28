/**
 * Connector Cleanup Job Model
 *
 * Tracks the progress and state of content purge operations.
 * Each cleanup job represents a request to delete all synced content
 * (documents, chunks, embeddings) for a specific connector.
 */

import mongoose, { Schema, model } from 'mongoose';
import { uuidv7 } from '../mongo/base-document.js';
import { tenantIsolationPlugin } from '../mongo/plugins/tenant-isolation.plugin.js';
import { ModelRegistry } from '../model-registry.js';

// ─── Document Interface ──────────────────────────────────────────────────

export interface IConnectorCleanupJob {
  _id: string;
  connectorId: string;
  tenantId: string;
  status: 'idle' | 'in_progress' | 'completed' | 'failed' | 'cancelled';
  documents: { total: number; removed: number };
  chunks: { total: number; removed: number };
  vectorEmbeddings: { total: number; removed: number };
  estimatedTimeRemaining: number | null;
  error: string | null;
  startedAt: Date;
  completedAt: Date | null;
  initiatedBy: string;
  _v: number;
  createdAt: Date;
  updatedAt: Date;
}

// ─── Sub-schemas ─────────────────────────────────────────────────────────

const ProgressSchema = new Schema(
  {
    total: { type: Number, default: 0 },
    removed: { type: Number, default: 0 },
  },
  { _id: false },
);

// ─── Schema ──────────────────────────────────────────────────────────────

const ConnectorCleanupJobSchema = new Schema<IConnectorCleanupJob>(
  {
    _id: { type: String, default: uuidv7 },
    connectorId: { type: String, required: true },
    tenantId: { type: String, required: true },
    status: {
      type: String,
      enum: ['idle', 'in_progress', 'completed', 'failed', 'cancelled'],
      default: 'idle',
    },
    documents: { type: ProgressSchema, default: () => ({ total: 0, removed: 0 }) },
    chunks: { type: ProgressSchema, default: () => ({ total: 0, removed: 0 }) },
    vectorEmbeddings: { type: ProgressSchema, default: () => ({ total: 0, removed: 0 }) },
    estimatedTimeRemaining: { type: Number, default: null },
    error: { type: String, default: null },
    startedAt: { type: Date, required: true },
    completedAt: { type: Date, default: null },
    initiatedBy: { type: String, required: true },
    _v: { type: Number, default: 1 },
  },
  { timestamps: true, collection: 'connector_cleanup_jobs' },
);

// ─── Plugins ─────────────────────────────────────────────────────────────

ConnectorCleanupJobSchema.plugin(tenantIsolationPlugin);

// ─── Indexes ─────────────────────────────────────────────────────────────

// Find cleanup jobs for a connector
ConnectorCleanupJobSchema.index({ tenantId: 1, connectorId: 1, status: 1 });

// ─── Model ───────────────────────────────────────────────────────────────

ModelRegistry.registerModelDefinition('ConnectorCleanupJob', ConnectorCleanupJobSchema, 'platform');

export const ConnectorCleanupJob =
  (mongoose.models.ConnectorCleanupJob as mongoose.Model<IConnectorCleanupJob>) ||
  model<IConnectorCleanupJob>('ConnectorCleanupJob', ConnectorCleanupJobSchema);
