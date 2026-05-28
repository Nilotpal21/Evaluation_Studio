/**
 * Schema Change Log Model
 *
 * Tracks detected changes between schema versions for a connector.
 * Flags changes that may affect existing canonical mappings for review.
 */

import mongoose, { Schema, model } from 'mongoose';
import { uuidv7 } from '../mongo/base-document.js';
import { tenantIsolationPlugin } from '../mongo/plugins/tenant-isolation.plugin.js';

// ─── Document Interface ──────────────────────────────────────────────────

export interface ISchemaChangeLog {
  _id: string;
  tenantId: string;
  connectorId: string;
  schemaVersion: number;
  changeType: string;
  /** Dot-path to the changed field */
  fieldPath: string;
  previousValue: any | null;
  newValue: any | null;
  reviewStatus: string;
  /** Whether this change affects existing canonical mappings */
  affectsMapping: boolean;
  _v: number;
  createdAt: Date;
  updatedAt: Date;
}

// ─── Schema ──────────────────────────────────────────────────────────────

const SchemaChangeLogSchema = new Schema<ISchemaChangeLog>(
  {
    _id: { type: String, default: uuidv7 },
    tenantId: { type: String, required: true },
    connectorId: { type: String, required: true },
    schemaVersion: { type: Number, required: true },
    changeType: { type: String, required: true },
    fieldPath: { type: String, required: true },
    previousValue: { type: Schema.Types.Mixed, default: null },
    newValue: { type: Schema.Types.Mixed, default: null },
    reviewStatus: { type: String, required: true, default: 'pending' },
    affectsMapping: { type: Boolean, default: false },
    _v: { type: Number, default: 1 },
  },
  { timestamps: true, collection: 'schema_change_logs' },
);

// ─── Plugins ─────────────────────────────────────────────────────────────

SchemaChangeLogSchema.plugin(tenantIsolationPlugin);

// ─── Indexes ─────────────────────────────────────────────────────────────

SchemaChangeLogSchema.index({ connectorId: 1 });
SchemaChangeLogSchema.index({ reviewStatus: 1 });
SchemaChangeLogSchema.index({ tenantId: 1, connectorId: 1, schemaVersion: 1 });

// ─── Model ───────────────────────────────────────────────────────────────

export const SchemaChangeLog =
  (mongoose.models.SchemaChangeLog as any) ||
  model<ISchemaChangeLog>('SchemaChangeLog', SchemaChangeLogSchema);
