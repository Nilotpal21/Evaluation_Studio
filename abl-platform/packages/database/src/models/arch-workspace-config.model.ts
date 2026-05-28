/**
 * ArchWorkspaceConfig
 *
 * Stores per-tenant configuration for the Arch AI assistant:
 * model selection, credential reference, and LLM parameters.
 * One document per tenant.
 */

import mongoose, { Schema, model } from 'mongoose';
import { uuidv7 } from '../mongo/base-document.js';
import { tenantIsolationPlugin } from '../mongo/plugins/tenant-isolation.plugin.js';
import { encryptionPlugin } from '../mongo/plugins/encryption.plugin.js';
import { auditTrailPlugin } from '../mongo/plugins/audit-trail.plugin.js';

// ─── Document Interface ──────────────────────────────────────────────────

export interface IArchWorkspaceConfig {
  _id: string;
  tenantId: string;
  modelId: string;
  provider: string;
  tenantModelId?: string;
  usePlatformCredits: boolean;
  maxTokensChat: number;
  maxTokensGenerate: number;
  temperature: number;
  rateLimitRpm: number;
  rateLimitRph: number;
  systemPromptOverride?: string;
  encryptedApiKey?: string;
  encryptedEndpoint?: string;
  authProfileId: string | null;
  authType: string;
  customHeaders?: Record<string, string> | null;
  hyperParameters: Record<string, unknown>;
  lastValidatedAt?: Date | null;
  _v: number;
  isActive: boolean;
  updatedBy?: string;
  createdAt: Date;
  updatedAt: Date;
}

// ─── Schema ──────────────────────────────────────────────────────────────

const ArchWorkspaceConfigSchema = new Schema<IArchWorkspaceConfig>(
  {
    _id: { type: String, default: uuidv7 },
    tenantId: { type: String, required: true },
    modelId: { type: String, required: true, default: 'claude-sonnet-4-20250514' },
    provider: {
      type: String,
      required: true,
      default: 'anthropic',
    },
    tenantModelId: { type: String, default: null },
    usePlatformCredits: { type: Boolean, required: true, default: true },
    maxTokensChat: { type: Number, required: true, default: 2048 },
    maxTokensGenerate: { type: Number, required: true, default: 8192 },
    temperature: { type: Number, required: true, default: 0.7 },
    rateLimitRpm: { type: Number, required: true, default: 0 },
    rateLimitRph: { type: Number, required: true, default: 0 },
    systemPromptOverride: { type: String, default: null },
    encryptedApiKey: { type: String, default: null },
    encryptedEndpoint: { type: String, default: null },
    authProfileId: { type: String, default: null },
    authType: { type: String, default: 'api_key' },
    customHeaders: { type: Schema.Types.Mixed, default: null },
    hyperParameters: { type: Schema.Types.Mixed, default: {} },
    lastValidatedAt: { type: Date, default: null },
    _v: { type: Number, default: 1 },
    isActive: { type: Boolean, required: true, default: true },
    updatedBy: { type: String, default: null },
  },
  { timestamps: true, collection: 'arch_workspace_configs' },
);

// ─── Plugins ─────────────────────────────────────────────────────────────

ArchWorkspaceConfigSchema.plugin(tenantIsolationPlugin);
ArchWorkspaceConfigSchema.plugin(encryptionPlugin, {
  fieldsToEncrypt: ['encryptedApiKey', 'encryptedEndpoint', 'customHeaders'],
  scope: 'tenant',
  scopeFields: { tenantId: 'tenantId' },
});
ArchWorkspaceConfigSchema.plugin(auditTrailPlugin);

// ─── Indexes ─────────────────────────────────────────────────────────────

ArchWorkspaceConfigSchema.index({ tenantId: 1 }, { unique: true });

// ─── Model ───────────────────────────────────────────────────────────────

export const ArchWorkspaceConfig =
  (mongoose.models.ArchWorkspaceConfig as any) ||
  model<IArchWorkspaceConfig>('ArchWorkspaceConfig', ArchWorkspaceConfigSchema);
