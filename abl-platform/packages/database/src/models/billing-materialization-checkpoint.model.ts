/**
 * BillingMaterializationCheckpoint Model
 *
 * Tracks scheduler-owned progress for billing materialization. Manual replay
 * and manual materialization batches are intentionally separate so ad hoc
 * operator actions do not move the automated billing cursor.
 */

import mongoose, { Schema, model } from 'mongoose';
import { uuidv7 } from '../mongo/base-document.js';
import { tenantIsolationPlugin } from '../mongo/plugins/tenant-isolation.plugin.js';
import type { BillingMaterializationBasis } from './subscription.model.js';

export interface IBillingMaterializationCheckpointCursor {
  lastWindowEnd: Date | null;
  lastEndedAt: Date | null;
  lastSessionId: string | null;
}

export interface IBillingMaterializationCheckpoint {
  _id: string;
  tenantId: string;
  projectId: string | null;
  basis: BillingMaterializationBasis;
  cursor: IBillingMaterializationCheckpointCursor;
  lastBatchId: string | null;
  lastMaterializedAt: Date | null;
  _v: number;
  createdAt: Date;
  updatedAt: Date;
}

const BillingMaterializationCheckpointSchema = new Schema<IBillingMaterializationCheckpoint>(
  {
    _id: { type: String, default: uuidv7 },
    tenantId: { type: String, required: true },
    projectId: { type: String, default: null },
    basis: {
      type: String,
      enum: ['time_window', 'completed_sessions'],
      required: true,
    },
    cursor: {
      type: {
        lastWindowEnd: { type: Date, default: null },
        lastEndedAt: { type: Date, default: null },
        lastSessionId: { type: String, default: null },
      },
      default: () => ({
        lastWindowEnd: null,
        lastEndedAt: null,
        lastSessionId: null,
      }),
    },
    lastBatchId: { type: String, default: null },
    lastMaterializedAt: { type: Date, default: null },
    _v: { type: Number, default: 1 },
  },
  { timestamps: true, collection: 'billing_materialization_checkpoints' },
);

BillingMaterializationCheckpointSchema.plugin(tenantIsolationPlugin);

BillingMaterializationCheckpointSchema.index(
  { tenantId: 1, projectId: 1, basis: 1 },
  { unique: true, name: 'uniq_billing_materialization_checkpoint_scope' },
);
BillingMaterializationCheckpointSchema.index({ tenantId: 1, basis: 1, updatedAt: -1 });

export const BillingMaterializationCheckpoint =
  (mongoose.models
    .BillingMaterializationCheckpoint as mongoose.Model<IBillingMaterializationCheckpoint>) ||
  model<IBillingMaterializationCheckpoint>(
    'BillingMaterializationCheckpoint',
    BillingMaterializationCheckpointSchema,
  );
