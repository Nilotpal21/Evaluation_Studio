/**
 * DEK Registry Model
 *
 * Per-tenant/project/environment Data Encryption Key entries.
 * Each scope (tenant+project+environment) has one active DEK; on rotation,
 * old DEKs are marked decrypt_only.
 *
 * Decision 3: `dekId` is an opaque random string (crypto.randomBytes base64url),
 * globally unique. Decrypt lookup uses `{ dekId }` only — no scope needed.
 *
 * Decision 4: `epoch` is for concurrent creation dedup only (not embedded in ciphertext).
 * Unique index on `{ tenantId, projectId, environment, epoch }` prevents duplicate DEKs.
 *
 * Lifecycle: active → decrypt_only → destroyed
 *   - active: used for new encryptions and decryptions
 *   - decrypt_only: rotated — can decrypt but no new encryptions
 *   - destroyed: wrappedDek zeroed — unrecoverable (NIST SP 800-57)
 */

import crypto from 'node:crypto';
import mongoose, { Schema, model } from 'mongoose';
import { uuidv7 } from '../mongo/base-document.js';
import { tenantIsolationPlugin } from '../mongo/plugins/tenant-isolation.plugin.js';
import type { IResolvedProviderRef } from './materialized-kms-config.model.js';

/** Generate opaque DEK identifier — 16 URL-safe chars (Decision 3). */
export function generateDekId(): string {
  return crypto.randomBytes(12).toString('base64url');
}

// =============================================================================
// INTERFACES
// =============================================================================

export interface IDEKEntry {
  _id: string;
  /** Opaque DEK identifier — globally unique (Decision 3). */
  dekId: string;
  tenantId: string;
  /** Required — Decision 1: greenfield, no default. Use '_tenant' for tenant-scoped models. */
  projectId: string;
  /** Required — Decision 1: greenfield, no default. Use '_tenant' for tenant-scoped, '_shared' for no-env models. */
  environment: string;
  /** Epoch string for concurrent creation dedup (Decision 4). */
  epoch: string;
  wrappedDek: string;
  kekKeyId: string;
  kekKeyVersion: number;
  /** Provider-specific version identifier (e.g., Azure Key Vault hex version string).
   *  Null for local provider or DEKs created before version tracking was added. */
  kekKeyVersionId: string | null;
  /** Immutable provider snapshot used to wrap this DEK. */
  wrappingProvider: IResolvedProviderRef | null;
  /** Source config version when the wrapping provider was resolved. */
  wrappingSourceConfigVersion: number | null;
  status: string;
  usageCount: number;
  /** Max encryptions per DEK (default: 2^30). Safety ceiling — triggers rotation (Decision 6). */
  maxUsageCount: number;
  /** Precomputed epoch boundary — hot path checks expiresAt < now (Decision 5). */
  expiresAt: Date | null;
  /** Timestamp when the DEK stopped being used for new writes. */
  retiredAt: Date | null;
  destroyedAt: Date | null;
  _v: number;
  createdAt: Date;
  updatedAt: Date;
}

const WrappingProviderRefSchema = new Schema<IResolvedProviderRef>(
  {
    providerType: { type: String, required: true },
    keyId: { type: String, required: true },
    region: { type: String, default: null },
    vaultUrl: { type: String, default: null },
    externalEndpoint: { type: String, default: null },
    authMethod: { type: String, default: null },
    authConfigEncrypted: { type: String, default: null },
  },
  { _id: false },
);

// =============================================================================
// SCHEMA
// =============================================================================

const DEKEntrySchema = new Schema<IDEKEntry>(
  {
    _id: { type: String, default: uuidv7 },
    dekId: { type: String, required: true },
    tenantId: { type: String, required: true },
    projectId: { type: String, required: true },
    environment: { type: String, required: true },
    epoch: { type: String, required: true },
    wrappedDek: { type: String, required: true },
    kekKeyId: { type: String, required: true },
    kekKeyVersion: { type: Number, required: true },
    kekKeyVersionId: { type: String, default: null },
    wrappingProvider: { type: WrappingProviderRefSchema, default: null },
    wrappingSourceConfigVersion: { type: Number, default: null },
    status: {
      type: String,
      required: true,
      enum: ['active', 'decrypt_only', 'destroyed'],
      default: 'active',
    },
    usageCount: { type: Number, default: 0 },
    maxUsageCount: { type: Number, default: 2 ** 30 },
    expiresAt: { type: Date, default: null },
    retiredAt: { type: Date, default: null },
    destroyedAt: { type: Date, default: null },
    _v: { type: Number, default: 1 },
  },
  { timestamps: true, collection: 'dek_registry' },
);

DEKEntrySchema.plugin(tenantIsolationPlugin);

// Decision 3: Decrypt lookup — dekId is globally unique
DEKEntrySchema.index({ dekId: 1 }, { unique: true });

// Decision 4: Concurrent creation dedup — one active DEK per scope+epoch.
// Partial filter ensures only 'active' entries are constrained — rotated
// (decrypt_only) DEKs don't block new active DEK creation with the same epoch.
DEKEntrySchema.index(
  { tenantId: 1, projectId: 1, environment: 1, epoch: 1 },
  { unique: true, partialFilterExpression: { status: 'active' } },
);

// Find active DEK for a scope
DEKEntrySchema.index({ tenantId: 1, projectId: 1, environment: 1, status: 1 });

// Status-based queries (rotation, cleanup)
DEKEntrySchema.index({ status: 1 });
DEKEntrySchema.index({ status: 1, retiredAt: 1, tenantId: 1 });

// Re-encryption queries: find DEKs wrapped by a specific KEK
DEKEntrySchema.index({ kekKeyId: 1, status: 1 });

export const DEKEntry =
  (mongoose.models.DEKEntry as any) || model<IDEKEntry>('DEKEntry', DEKEntrySchema);
