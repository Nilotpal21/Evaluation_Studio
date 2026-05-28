/**
 * Archive Manifest Model
 *
 * Tracks archived data batches stored in external object storage.
 * Each manifest records the type, size, checksum, and date range
 * of archived records for audit and retrieval purposes.
 */

import mongoose, { Schema, model } from 'mongoose';
import { uuidv7 } from '../mongo/base-document.js';
import { tenantIsolationPlugin } from '../mongo/plugins/tenant-isolation.plugin.js';

// ─── Document Interface ──────────────────────────────────────────────────

export interface IArchiveManifest {
  _id: string;
  tenantId: string;
  type: string;
  recordCount: number;
  sizeBytes: number;
  storageKey: string;
  storageBucket: string | null;
  region: string | null;
  checksum: string;
  format: string;
  dateRangeStart: Date;
  dateRangeEnd: Date;
  expiresAt: Date | null;
  _v: number;
  createdAt: Date;
  updatedAt: Date;
}

// ─── Schema ──────────────────────────────────────────────────────────────

const ArchiveManifestSchema = new Schema<IArchiveManifest>(
  {
    _id: { type: String, default: uuidv7 },
    tenantId: { type: String, required: true },
    type: { type: String, required: true },
    recordCount: { type: Number, required: true },
    sizeBytes: { type: Number, required: true },
    storageKey: { type: String, required: true },
    storageBucket: { type: String, default: null },
    region: { type: String, default: null },
    checksum: { type: String, required: true },
    format: { type: String, required: true },
    dateRangeStart: { type: Date, required: true },
    dateRangeEnd: { type: Date, required: true },
    expiresAt: { type: Date, default: null },
    _v: { type: Number, default: 1 },
  },
  { timestamps: true, collection: 'archive_manifests' },
);

// ─── Plugins ─────────────────────────────────────────────────────────────

ArchiveManifestSchema.plugin(tenantIsolationPlugin);

// ─── Indexes ─────────────────────────────────────────────────────────────

ArchiveManifestSchema.index({ tenantId: 1 });
ArchiveManifestSchema.index({ type: 1 });
ArchiveManifestSchema.index({ createdAt: -1 });
ArchiveManifestSchema.index({ expiresAt: 1 }, { sparse: true });

// ─── Model ───────────────────────────────────────────────────────────────

export const ArchiveManifest =
  (mongoose.models.ArchiveManifest as any) ||
  model<IArchiveManifest>('ArchiveManifest', ArchiveManifestSchema);
