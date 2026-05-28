/**
 * Materialized KMS Config
 *
 * Pre-resolved KMS configuration for each tenant+project+environment scope.
 * Written by KMSMaterializer (5-level config inheritance chain), read by KMSResolver.
 *
 * Decision 11: Materialization runs synchronously in PUT/POST config handler.
 */

import mongoose, { Schema, model } from 'mongoose';
import { uuidv7 } from '../mongo/base-document.js';
import { tenantIsolationPlugin } from '../mongo/plugins/tenant-isolation.plugin.js';

// =============================================================================
// INTERFACES
// =============================================================================

export interface IResolvedProviderRef {
  providerType: string;
  keyId: string;
  region: string | null;
  vaultUrl: string | null;
  externalEndpoint: string | null;
  authMethod: string | null;
  authConfigEncrypted: string | null;
}

export interface IMaterializedKMSConfig {
  _id: string;
  tenantId: string;
  projectId: string;
  environment: string;
  resolvedProvider: IResolvedProviderRef;
  resolvedKeyId: string;
  /** Hours per DEK epoch (default: 24). Controls expiresAt on new DEKs. */
  dekEpochIntervalHours: number;
  /** Max encryptions per DEK (default: 2^30). Safety ceiling (Decision 6). */
  dekMaxUsageCount: number;
  dekRetentionDays: number | null;
  kekRotationPeriodDays: number;
  failurePolicy: string;
  sourceConfigVersion: number;
  materializedAt: Date;
  _v: number;
  createdAt: Date;
  updatedAt: Date;
}

// =============================================================================
// EMBEDDED SCHEMAS
// =============================================================================

const ResolvedProviderRefSchema = new Schema<IResolvedProviderRef>(
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
// MAIN SCHEMA
// =============================================================================

const MaterializedKMSConfigSchema = new Schema<IMaterializedKMSConfig>(
  {
    _id: { type: String, default: uuidv7 },
    tenantId: { type: String, required: true },
    projectId: { type: String, required: true },
    environment: { type: String, required: true },
    resolvedProvider: { type: ResolvedProviderRefSchema, required: true },
    resolvedKeyId: { type: String, required: true },
    dekEpochIntervalHours: { type: Number, default: 24 },
    dekMaxUsageCount: { type: Number, default: 2 ** 30 },
    dekRetentionDays: { type: Number, default: null },
    kekRotationPeriodDays: { type: Number, required: true },
    failurePolicy: {
      type: String,
      required: true,
      enum: ['fail-closed', 'graceful-degradation'],
    },
    sourceConfigVersion: { type: Number, required: true },
    materializedAt: { type: Date, required: true },
    _v: { type: Number, default: 1 },
  },
  { timestamps: true, collection: 'materialized_kms_configs' },
);

MaterializedKMSConfigSchema.plugin(tenantIsolationPlugin);

// Primary lookup: one materialized config per scope
MaterializedKMSConfigSchema.index({ tenantId: 1, projectId: 1, environment: 1 }, { unique: true });

// Stale detection: find all materialized configs for a tenant with mismatched version
MaterializedKMSConfigSchema.index({ tenantId: 1, sourceConfigVersion: 1 });

export const MaterializedKMSConfig =
  (mongoose.models.MaterializedKMSConfig as any) ||
  model<IMaterializedKMSConfig>('MaterializedKMSConfig', MaterializedKMSConfigSchema);
