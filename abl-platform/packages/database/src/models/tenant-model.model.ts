/**
 * Tenant Model Model
 *
 * Represents an LLM model configured at the tenant level.
 * Supports both easy (provider-managed) and API (custom endpoint)
 * integration types, with multiple named connections per model.
 */

import mongoose, { Schema, model } from 'mongoose';
import { uuidv7 } from '../mongo/base-document.js';
import { tenantIsolationPlugin } from '../mongo/plugins/tenant-isolation.plugin.js';
import { encryptionPlugin } from '../mongo/plugins/encryption.plugin.js';

// ─── Embedded Interfaces ─────────────────────────────────────────────────

export type ConnectionHealthStatus = 'healthy' | 'unhealthy' | 'unknown' | 'unchecked';

export interface ITenantModelConnection {
  id: string;
  credentialId: string;
  authProfileId: string | null;
  connectionType: string;
  isActive: boolean;
  isPrimary: boolean;
  lastHealthCheck: Date | null;
  healthStatus: ConnectionHealthStatus;
  healthMessage: string | null;
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
}

// ─── Document Interface ──────────────────────────────────────────────────

export interface ITenantModel {
  _id: string;
  tenantId: string;
  displayName: string;
  integrationType: string;
  modelId: string | null;
  provider: string | null;
  endpointUrl: string | null;
  customEndpoint: string | null;
  providerStructure: string | null;
  requestTemplate: any;
  responseMapping: any;
  gatewayConfig: any;
  customHeaders: Record<string, string> | null;
  temperature: number;
  maxTokens: number;
  /** Provider-specific hyperparameter values (e.g. { temperature: 0.7, max_tokens: 4096, top_p: 0.9 }) */
  hyperParameters: Record<string, unknown>;
  supportsTools: boolean;
  supportsStreaming: boolean;
  supportsVision: boolean;
  supportsStructured: boolean;
  /** OpenAI only: null = auto-detect from registry, true = force Responses API, false = force Chat Completions */
  useResponsesApi: boolean | null;
  /** null = auto-detect from supportsStreaming, true = force streaming, false = force non-streaming */
  useStreaming: boolean | null;
  capabilities: string[];
  realtimeConfig: any;
  tier: string;
  isDefault: boolean;
  isActive: boolean;
  inferenceEnabled: boolean;
  createdBy: string;
  connections: ITenantModelConnection[];
  provisionedBy: string | null;
  provisionedAt: Date | null;
  provisioningNote: string | null;
  _v: number;
  createdAt: Date;
  updatedAt: Date;
}

// ─── Embedded Schemas ────────────────────────────────────────────────────

const TenantModelConnectionSchema = new Schema<ITenantModelConnection>(
  {
    id: { type: String, required: true },
    credentialId: { type: String, required: true },
    authProfileId: { type: String, default: null },
    connectionType: { type: String, default: 'http', enum: ['http', 'websocket'] },
    isActive: { type: Boolean, required: true },
    isPrimary: { type: Boolean, required: true },
    lastHealthCheck: { type: Date, default: null },
    healthStatus: {
      type: String,
      enum: ['healthy', 'unhealthy', 'unknown', 'unchecked'],
      default: 'unchecked',
    },
    healthMessage: { type: String, default: null },
    createdBy: { type: String, required: true },
    createdAt: { type: Date, required: true },
    updatedAt: { type: Date, required: true },
  },
  { _id: false },
);

// ─── Schema ──────────────────────────────────────────────────────────────

const TenantModelSchema = new Schema<ITenantModel>(
  {
    _id: { type: String, default: uuidv7 },
    tenantId: { type: String, required: true },
    displayName: { type: String, required: true },
    integrationType: { type: String, required: true },
    modelId: { type: String, default: null },
    provider: { type: String, default: null },
    endpointUrl: { type: String, default: null },
    customEndpoint: { type: String, default: null },
    providerStructure: { type: String, default: null },
    requestTemplate: { type: Schema.Types.Mixed, default: {} },
    responseMapping: { type: Schema.Types.Mixed, default: {} },
    gatewayConfig: { type: Schema.Types.Mixed, default: {} },
    customHeaders: { type: Schema.Types.Mixed, default: null },
    temperature: { type: Number, required: true },
    maxTokens: { type: Number, required: true },
    hyperParameters: { type: Schema.Types.Mixed, default: {} },
    supportsTools: { type: Boolean, required: true },
    supportsStreaming: { type: Boolean, required: true },
    supportsVision: { type: Boolean, required: true },
    supportsStructured: { type: Boolean, required: true },
    useResponsesApi: { type: Boolean, default: null },
    useStreaming: { type: Boolean, default: null },
    capabilities: { type: [String], default: ['text'] },
    realtimeConfig: { type: Schema.Types.Mixed, default: null },
    tier: { type: String, required: true },
    isDefault: { type: Boolean, default: false },
    isActive: { type: Boolean, default: true },
    inferenceEnabled: { type: Boolean, default: true },
    createdBy: { type: String, required: true },
    connections: { type: [TenantModelConnectionSchema], default: [] },
    provisionedBy: { type: String, default: null },
    provisionedAt: { type: Date, default: null },
    provisioningNote: { type: String, default: null },
    _v: { type: Number, default: 1 },
  },
  { timestamps: true, collection: 'tenant_models' },
);

// ─── Plugins ─────────────────────────────────────────────────────────────

TenantModelSchema.plugin(tenantIsolationPlugin);
TenantModelSchema.plugin(encryptionPlugin, {
  fieldsToEncrypt: ['customHeaders'],
  scope: 'tenant',
  scopeFields: { tenantId: 'tenantId' },
});

// ─── Indexes ─────────────────────────────────────────────────────────────

TenantModelSchema.index({ tenantId: 1, displayName: 1 }, { unique: true });
TenantModelSchema.index({ tenantId: 1, tier: 1, isActive: 1 });
TenantModelSchema.index({ tenantId: 1, provider: 1, isActive: 1 });
TenantModelSchema.index({ tenantId: 1, capabilities: 1, isActive: 1 });
TenantModelSchema.index({ provisionedBy: 1, createdAt: -1 }, { sparse: true });
// Hot-path: model-resolution Level 4 — default model for tier with inference filter
TenantModelSchema.index({ tenantId: 1, tier: 1, isDefault: 1, isActive: 1, inferenceEnabled: 1 });
// Hot-path: model-resolution — provider-based credential resolution
TenantModelSchema.index({
  tenantId: 1,
  provider: 1,
  isDefault: 1,
  isActive: 1,
  inferenceEnabled: 1,
});
// Hot-path: model-resolution — voice model lookup
TenantModelSchema.index({ tenantId: 1, capabilities: 1, isActive: 1, inferenceEnabled: 1 });

// ─── Model ───────────────────────────────────────────────────────────────

export const TenantModel =
  (mongoose.models.TenantModel as any) || model<ITenantModel>('TenantModel', TenantModelSchema);
