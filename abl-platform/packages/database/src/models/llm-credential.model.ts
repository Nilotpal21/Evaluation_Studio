/**
 * LLM Credential Model
 *
 * Stores encrypted API keys and endpoint configurations for LLM providers.
 * Supports user-scoped and tenant-scoped credentials via credentialScope/ownerId.
 * Sensitive fields are encrypted at rest via the encryption plugin.
 */

import mongoose, { Schema, model } from 'mongoose';
import { uuidv7 } from '../mongo/base-document.js';
import { tenantIsolationPlugin } from '../mongo/plugins/tenant-isolation.plugin.js';
import { encryptionPlugin } from '../mongo/plugins/encryption.plugin.js';
import { auditTrailPlugin } from '../mongo/plugins/audit-trail.plugin.js';

// ─── Document Interface ──────────────────────────────────────────────────

export interface ILLMCredential {
  _id: string;
  credentialScope: 'user' | 'tenant';
  ownerId: string;
  tenantId: string;
  provider: string;
  name: string;
  encryptedApiKey: string;
  encryptedEndpoint: string | null;
  customHeaders: Record<string, string> | null;
  authType: string;
  authConfig: any;
  isActive: boolean;
  isDefault: boolean;
  lastUsedAt: Date | null;
  lastValidatedAt: Date | null;
  _v: number;
  createdAt: Date;
  updatedAt: Date;
}

// ─── Schema ──────────────────────────────────────────────────────────────

const LLMCredentialSchema = new Schema<ILLMCredential>(
  {
    _id: { type: String, default: uuidv7 },
    credentialScope: { type: String, required: true, enum: ['user', 'tenant'] },
    ownerId: { type: String, required: true },
    tenantId: { type: String, required: true },
    provider: { type: String, required: true },
    name: { type: String, required: true },
    encryptedApiKey: { type: String, required: true },
    encryptedEndpoint: { type: String, default: null },
    customHeaders: { type: Schema.Types.Mixed, default: null },
    authType: { type: String, required: true },
    authConfig: { type: Schema.Types.Mixed, default: {} },
    isActive: { type: Boolean, default: true },
    isDefault: { type: Boolean, default: false },
    lastUsedAt: { type: Date, default: null },
    lastValidatedAt: { type: Date, default: null },
    _v: { type: Number, default: 1 },
  },
  { timestamps: true, collection: 'llm_credentials' },
);

// ─── Plugins ─────────────────────────────────────────────────────────────

LLMCredentialSchema.plugin(tenantIsolationPlugin);
LLMCredentialSchema.plugin(encryptionPlugin, {
  fieldsToEncrypt: ['encryptedApiKey', 'encryptedEndpoint', 'customHeaders', 'authConfig'],
  scope: 'tenant',
  scopeFields: { tenantId: 'tenantId' },
});
LLMCredentialSchema.plugin(auditTrailPlugin);

// ─── Indexes ─────────────────────────────────────────────────────────────

LLMCredentialSchema.index(
  { tenantId: 1, credentialScope: 1, ownerId: 1, provider: 1, name: 1 },
  { unique: true },
);
LLMCredentialSchema.index({ tenantId: 1, credentialScope: 1, ownerId: 1 });
LLMCredentialSchema.index({ provider: 1 });
LLMCredentialSchema.index({ tenantId: 1 });
// Hot-path: model-resolution credential lookup by scope+owner+provider+active+default
LLMCredentialSchema.index({
  credentialScope: 1,
  ownerId: 1,
  provider: 1,
  isActive: 1,
  isDefault: 1,
});

// ─── Model ───────────────────────────────────────────────────────────────

export const LLMCredential =
  (mongoose.models.LLMCredential as any) ||
  model<ILLMCredential>('LLMCredential', LLMCredentialSchema);
