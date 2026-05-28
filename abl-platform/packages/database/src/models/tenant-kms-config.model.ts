/**
 * Tenant KMS Configuration Model
 *
 * Per-tenant KMS configuration with project/environment overrides.
 * This is the source of truth for KMS config — written by admins,
 * consumed by the KMS materializer to produce pre-resolved configs.
 *
 * Resolution chain (5 levels):
 *   1. projects[projectId].environments[environment]
 *   2. projects[projectId].defaultProvider
 *   3. environments[environment]
 *   4. defaultProvider
 *   5. Platform default
 */

import mongoose, { Schema, model } from 'mongoose';
import { uuidv7 } from '../mongo/base-document.js';
import { tenantIsolationPlugin } from '../mongo/plugins/tenant-isolation.plugin.js';
import { auditTrailPlugin } from '../mongo/plugins/audit-trail.plugin.js';

// =============================================================================
// EMBEDDED SUBDOCUMENT INTERFACES
// =============================================================================

export interface IKMSProviderRef {
  providerType: string;
  keyId: string;
  region: string | null;
  vaultUrl: string | null;
  externalEndpoint: string | null;
  authMethod: string | null;
  authConfigEncrypted: string | null;
}

export interface IKMSEnvironmentOverride {
  environment: string;
  provider: IKMSProviderRef;
}

export interface IKMSProjectOverride {
  projectId: string;
  defaultProvider: IKMSProviderRef | null;
  environments: IKMSEnvironmentOverride[];
}

export interface ITenantKMSConfig {
  _id: string;
  tenantId: string;
  defaultProvider: IKMSProviderRef | null;
  environments: IKMSEnvironmentOverride[];
  projects: IKMSProjectOverride[];
  /** Hours per DEK epoch (default: 24). Controls expiresAt on new DEKs. Per-tenant only (Decision 9). */
  dekEpochIntervalHours: number;
  /** Max encryptions per DEK (default: 2^30). Safety ceiling, not precise limit (Decision 6). */
  dekMaxUsageCount: number;
  dekRetentionDays: number | null;
  kekRotationPeriodDays: number;
  reencryption: {
    enabled: boolean;
    concurrency: number;
    batchSize: number;
    maxRetries: number;
  };
  lastKekRotatedAt: Date | null;
  byokEnabled: boolean;
  byopEnabled: boolean;
  complianceLevel: string;
  failurePolicy: string;
  _v: number;
  createdAt: Date;
  updatedAt: Date;
}

// =============================================================================
// EMBEDDED SCHEMAS
// =============================================================================

const KMSProviderRefSchema = new Schema<IKMSProviderRef>(
  {
    providerType: {
      type: String,
      required: true,
      enum: [
        'local',
        'aws-kms',
        'azure-keyvault',
        'azure-managed-hsm',
        'gcp-cloud-kms',
        'external',
      ],
    },
    keyId: { type: String, required: true },
    region: { type: String, default: null },
    vaultUrl: { type: String, default: null },
    externalEndpoint: { type: String, default: null },
    authMethod: {
      type: String,
      default: null,
      enum: [
        null,
        'default-credentials',
        'service-account',
        'managed-identity',
        'api-key',
        'mtls',
        'oauth2',
        'hmac',
        'hmac-sha256',
      ],
    },
    authConfigEncrypted: { type: String, default: null },
  },
  { _id: false },
);

const KMSEnvironmentOverrideSchema = new Schema<IKMSEnvironmentOverride>(
  {
    environment: { type: String, required: true },
    provider: { type: KMSProviderRefSchema, required: true },
  },
  { _id: false },
);

const KMSProjectOverrideSchema = new Schema<IKMSProjectOverride>(
  {
    projectId: { type: String, required: true },
    defaultProvider: { type: KMSProviderRefSchema, default: null },
    environments: { type: [KMSEnvironmentOverrideSchema], default: [] },
  },
  { _id: false },
);

// =============================================================================
// MAIN SCHEMA
// =============================================================================

const TenantKMSConfigSchema = new Schema<ITenantKMSConfig>(
  {
    _id: { type: String, default: uuidv7 },
    tenantId: { type: String, required: true },
    defaultProvider: { type: KMSProviderRefSchema, default: null },
    environments: { type: [KMSEnvironmentOverrideSchema], default: [] },
    projects: { type: [KMSProjectOverrideSchema], default: [] },
    dekEpochIntervalHours: { type: Number, default: 24 },
    dekMaxUsageCount: { type: Number, default: 2 ** 30 },
    dekRetentionDays: { type: Number, default: null },
    kekRotationPeriodDays: { type: Number, default: 365 },
    reencryption: {
      type: new Schema(
        {
          enabled: { type: Boolean, default: true },
          concurrency: { type: Number, default: 1 },
          batchSize: { type: Number, default: 50 },
          maxRetries: { type: Number, default: 3 },
        },
        { _id: false },
      ),
      default: () => ({ enabled: true, concurrency: 1, batchSize: 50, maxRetries: 3 }),
    },
    lastKekRotatedAt: { type: Date, default: null },
    byokEnabled: { type: Boolean, default: false },
    byopEnabled: { type: Boolean, default: false },
    complianceLevel: {
      type: String,
      default: 'standard',
      enum: ['standard', 'pci-dss', 'hipaa', 'fips-140-3'],
    },
    failurePolicy: {
      type: String,
      default: 'fail-closed',
      enum: ['fail-closed', 'graceful-degradation'],
    },
    _v: { type: Number, default: 1 },
  },
  { timestamps: true, collection: 'tenant_kms_configs' },
);

TenantKMSConfigSchema.plugin(tenantIsolationPlugin);
TenantKMSConfigSchema.plugin(auditTrailPlugin);

// One config per tenant
TenantKMSConfigSchema.index({ tenantId: 1 }, { unique: true });

export const TenantKMSConfig =
  (mongoose.models.TenantKMSConfig as any) ||
  model<ITenantKMSConfig>('TenantKMSConfig', TenantKMSConfigSchema);
