/**
 * Attribute Merge Event Model
 *
 * Records merge operations when duplicate/similar attributes are
 * reconciled in the Browse SDK attribute registry. Supports both
 * automatic reconciliation and admin-initiated merges, with
 * reversibility tracking.
 */

import mongoose, { Schema, model } from 'mongoose';
import { uuidv7 } from '../mongo/base-document.js';
import { tenantIsolationPlugin } from '../mongo/plugins/tenant-isolation.plugin.js';
import { ModelRegistry } from '../model-registry.js';

// ─── Document Interface ──────────────────────────────────────────────────

export interface IAttributeMergeEvent {
  _id: string;
  tenantId: string;
  indexId: string;
  productScope: string;
  timestamp: Date;
  sourceAttributeIds: string[];
  targetAttributeId: string;
  mergeScore: number;
  mergeMethod: 'auto_reconciliation' | 'admin_manual';
  reversible: boolean;
  reversedAt?: Date;
  metadata?: {
    clusterSize?: number;
    promotionTier?: string;
    reason?: string;
  };
  createdAt: Date;
  updatedAt: Date;
}

// ─── Schema ──────────────────────────────────────────────────────────────

const AttributeMergeEventSchema = new Schema<IAttributeMergeEvent>(
  {
    _id: { type: String, default: uuidv7 },
    tenantId: { type: String, required: true },
    indexId: { type: String, required: true },
    productScope: { type: String, required: true },
    timestamp: { type: Date, required: true },
    sourceAttributeIds: [{ type: String }],
    targetAttributeId: { type: String, required: true },
    mergeScore: { type: Number, required: true },
    mergeMethod: {
      type: String,
      enum: ['auto_reconciliation', 'admin_manual'],
      required: true,
    },
    reversible: { type: Boolean, default: true },
    reversedAt: { type: Date },
    metadata: {
      type: new Schema(
        {
          clusterSize: { type: Number },
          promotionTier: { type: String },
          reason: { type: String },
        },
        { _id: false },
      ),
    },
  },
  { timestamps: true, collection: 'attribute_merge_events' },
);

// ─── Plugins ─────────────────────────────────────────────────────────────

AttributeMergeEventSchema.plugin(tenantIsolationPlugin);

// ─── Indexes ─────────────────────────────────────────────────────────────

// Timeline queries: merge events for an index ordered by time
AttributeMergeEventSchema.index({ tenantId: 1, indexId: 1, timestamp: -1 });

// Lookup: all merges targeting a specific attribute
AttributeMergeEventSchema.index({ tenantId: 1, targetAttributeId: 1 });

// ─── Model ───────────────────────────────────────────────────────────────

// Register with ModelRegistry for dual-database support
// Uses 'platform' (abl_platform) — merge events are admin metadata,
// and the reconciliation service writes via default mongoose connection (abl_platform).
ModelRegistry.registerModelDefinition('AttributeMergeEvent', AttributeMergeEventSchema, 'platform');

export const AttributeMergeEvent =
  (mongoose.models.AttributeMergeEvent as any) ||
  model<IAttributeMergeEvent>('AttributeMergeEvent', AttributeMergeEventSchema);
