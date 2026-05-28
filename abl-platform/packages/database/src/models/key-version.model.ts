/**
 * Key Version Model
 *
 * Tracks encryption key versions for key rotation management.
 * Each version has a lifecycle: active -> decrypt_only -> destroyed.
 */

import mongoose, { Schema, model } from 'mongoose';
import { uuidv7 } from '../mongo/base-document.js';
import { tenantIsolationPlugin } from '../mongo/plugins/tenant-isolation.plugin.js';

// ─── Document Interface ──────────────────────────────────────────────────

export interface IKeyVersion {
  _id: string;
  tenantId: string;
  version: number;
  status: string;
  algorithm: string;
  rotatedAt: Date | null;
  destroyedAt: Date | null;
  _v: number;
  createdAt: Date;
  updatedAt: Date;
}

// ─── Schema ──────────────────────────────────────────────────────────────

const KeyVersionSchema = new Schema<IKeyVersion>(
  {
    _id: { type: String, default: uuidv7 },
    tenantId: { type: String, required: true },
    version: { type: Number, required: true },
    status: {
      type: String,
      required: true,
      enum: ['active', 'decrypt_only', 'destroyed'],
    },
    algorithm: { type: String, required: true },
    rotatedAt: { type: Date, default: null },
    destroyedAt: { type: Date, default: null },
    _v: { type: Number, default: 1 },
  },
  { timestamps: true, collection: 'key_versions' },
);

// ─── Plugins ─────────────────────────────────────────────────────────────

KeyVersionSchema.plugin(tenantIsolationPlugin);

// ─── Indexes ─────────────────────────────────────────────────────────────

KeyVersionSchema.index({ tenantId: 1, version: 1 }, { unique: true });
KeyVersionSchema.index({ tenantId: 1 });
KeyVersionSchema.index({ status: 1 });

// ─── Model ───────────────────────────────────────────────────────────────

export const KeyVersion =
  (mongoose.models.KeyVersion as any) || model<IKeyVersion>('KeyVersion', KeyVersionSchema);
