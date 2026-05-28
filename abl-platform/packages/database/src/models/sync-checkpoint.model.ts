/**
 * Sync Checkpoint Model
 *
 * Enables pause/resume functionality for connector syncs.
 * Stores pagination state, progress tracking, and ETA calculations.
 * Allows long-running syncs to be interrupted and resumed without data loss.
 */

import mongoose, { Schema, model } from 'mongoose';
import { uuidv7 } from '../mongo/base-document.js';
import { tenantIsolationPlugin } from '../mongo/plugins/tenant-isolation.plugin.js';

// ─── Document Interface ──────────────────────────────────────────────────

export interface ISyncCheckpoint {
  _id: string;
  tenantId: string;
  /** References ConnectorConfig._id */
  connectorId: string;

  // ─── Sync Metadata ─────────────────────────────────────────────────────

  /** Sync type */
  syncType: 'full' | 'delta';
  /** When sync started */
  startedAt: Date;
  /** Last checkpoint timestamp */
  checkpointedAt: Date;

  // ─── Pagination State ──────────────────────────────────────────────────

  state: {
    /** Current site URL being processed (SharePoint) */
    currentSiteUrl: string | null;
    /** Current library/drive ID being processed */
    currentLibraryId: string | null;
    /** Next page link (provider-specific pagination token) */
    nextLink: string | null;
    /** Documents processed so far */
    processedCount: number;
    /** Estimated total documents (null if unknown) */
    remainingCount: number | null;
  };

  // ─── Progress Tracking ─────────────────────────────────────────────────

  progress: {
    /** Completion percentage (0-100) */
    percentage: number;
    /** Estimated completion time */
    eta: Date | null;
    /** Processing rate (documents per second) */
    documentsPerSecond: number;
  };

  _v: number;
  createdAt: Date;
  updatedAt: Date;
}

// ─── Schema ──────────────────────────────────────────────────────────────

const SyncCheckpointSchema = new Schema<ISyncCheckpoint>(
  {
    _id: { type: String, default: uuidv7 },
    tenantId: { type: String, required: true },
    connectorId: { type: String, required: true },

    syncType: {
      type: String,
      required: true,
      enum: ['full', 'delta'],
    },
    startedAt: { type: Date, required: true },
    checkpointedAt: { type: Date, required: true },

    state: {
      type: {
        currentSiteUrl: { type: String, default: null },
        currentLibraryId: { type: String, default: null },
        nextLink: { type: String, default: null },
        processedCount: { type: Number, default: 0 },
        remainingCount: { type: Number, default: null },
      },
      default: () => ({
        currentSiteUrl: null,
        currentLibraryId: null,
        nextLink: null,
        processedCount: 0,
        remainingCount: null,
      }),
    },

    progress: {
      type: {
        percentage: { type: Number, default: 0, min: 0, max: 100 },
        eta: { type: Date, default: null },
        documentsPerSecond: { type: Number, default: 0 },
      },
      default: () => ({
        percentage: 0,
        eta: null,
        documentsPerSecond: 0,
      }),
    },

    _v: { type: Number, default: 1 },
  },
  { timestamps: true, collection: 'sync_checkpoints' },
);

// ─── Plugins ─────────────────────────────────────────────────────────────

SyncCheckpointSchema.plugin(tenantIsolationPlugin);

// ─── Indexes ─────────────────────────────────────────────────────────────

// Primary lookup: latest checkpoint for a connector
SyncCheckpointSchema.index({ tenantId: 1, connectorId: 1, checkpointedAt: -1 });

// Find active syncs (recent checkpoints)
SyncCheckpointSchema.index({ connectorId: 1, syncType: 1, startedAt: -1 });

// Cleanup: find old checkpoints for deletion
SyncCheckpointSchema.index({ checkpointedAt: 1 });

// ─── Model ───────────────────────────────────────────────────────────────

export const SyncCheckpoint =
  (mongoose.models.SyncCheckpoint as mongoose.Model<ISyncCheckpoint>) ||
  model<ISyncCheckpoint>('SyncCheckpoint', SyncCheckpointSchema);
