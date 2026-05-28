/**
 * Lookup Entry Model
 *
 * Stores individual lookup table entries for collection-backed lookup tables.
 * Platform-managed, tenant-scoped — each entry belongs to a specific
 * tenant + project + table combination.
 */

import mongoose, { Schema, model } from 'mongoose';
import { uuidv7 } from '../mongo/base-document.js';
import { tenantIsolationPlugin } from '../mongo/plugins/tenant-isolation.plugin.js';

// ─── Document Interface ──────────────────────────────────────────────────

export interface ILookupEntry {
  _id: string;
  tenantId: string;
  projectId: string;
  tableName: string;
  value: string;
  field?: string;
  metadata?: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
}

// ─── Schema ──────────────────────────────────────────────────────────────

const LookupEntrySchema = new Schema<ILookupEntry>(
  {
    _id: { type: String, default: uuidv7 },
    tenantId: { type: String, required: true },
    projectId: { type: String, required: true },
    tableName: { type: String, required: true },
    value: { type: String, required: true },
    field: { type: String },
    metadata: { type: Schema.Types.Mixed },
  },
  { timestamps: true, collection: 'lookup_entries' },
);

// ─── Plugins ─────────────────────────────────────────────────────────────

LookupEntrySchema.plugin(tenantIsolationPlugin);

// ─── Indexes ─────────────────────────────────────────────────────────────

// Exact match lookup (primary query path)
LookupEntrySchema.index({ tenantId: 1, projectId: 1, tableName: 1, value: 1 }, { unique: true });
// List all entries for a table
LookupEntrySchema.index({ tenantId: 1, projectId: 1, tableName: 1 });

// ─── Model ───────────────────────────────────────────────────────────────

export const LookupEntry =
  (mongoose.models.LookupEntry as any) || model<ILookupEntry>('LookupEntry', LookupEntrySchema);
