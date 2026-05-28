/**
 * Tenant Service Instance Model
 *
 * Stores tenant-level third-party service configurations (e.g. Deepgram,
 * ElevenLabs, Twilio). API keys are encrypted at rest. Each tenant can
 * have multiple instances per service type with one designated as default.
 */

import mongoose, { Schema, model } from 'mongoose';
import { uuidv7 } from '../mongo/base-document.js';
import { tenantIsolationPlugin } from '../mongo/plugins/tenant-isolation.plugin.js';
import { encryptionPlugin } from '../mongo/plugins/encryption.plugin.js';

// ─── Document Interface ──────────────────────────────────────────────────

export interface ITenantServiceInstance {
  _id: string;
  tenantId: string;
  displayName: string;
  serviceType: string;
  encryptedApiKey: string;
  /** Auth profile ID for credential resolution. Wired in VoiceServiceFactory.resolveAndDecrypt() via dualReadCredentials(). */
  authProfileId: string | null;
  encryptedConfig: any;
  jambonzSpeechCredentialSid: string | null;
  isDefault: boolean;
  isActive: boolean;
  createdBy: string;
  _v: number;
  createdAt: Date;
  updatedAt: Date;
}

// ─── Schema ──────────────────────────────────────────────────────────────

const TenantServiceInstanceSchema = new Schema<ITenantServiceInstance>(
  {
    _id: { type: String, default: uuidv7 },
    tenantId: { type: String, required: true },
    displayName: { type: String, required: true },
    serviceType: { type: String, required: true },
    encryptedApiKey: { type: String, required: true },
    authProfileId: { type: String, default: null },
    encryptedConfig: { type: Schema.Types.Mixed, default: {} },
    jambonzSpeechCredentialSid: { type: String, default: null },
    isDefault: { type: Boolean, default: false },
    isActive: { type: Boolean, default: true },
    createdBy: { type: String, required: true },
    _v: { type: Number, default: 1 },
  },
  { timestamps: true, collection: 'tenant_service_instances' },
);

// ─── Plugins ─────────────────────────────────────────────────────────────

TenantServiceInstanceSchema.plugin(tenantIsolationPlugin);
TenantServiceInstanceSchema.plugin(encryptionPlugin, {
  fieldsToEncrypt: ['encryptedApiKey', 'encryptedConfig'],
  scope: 'tenant',
  scopeFields: { tenantId: 'tenantId' },
});

// ─── Indexes ─────────────────────────────────────────────────────────────

TenantServiceInstanceSchema.index(
  { tenantId: 1, serviceType: 1, displayName: 1 },
  { unique: true },
);
TenantServiceInstanceSchema.index({ tenantId: 1, serviceType: 1, isActive: 1 });

// ─── Model ───────────────────────────────────────────────────────────────

export const TenantServiceInstance =
  (mongoose.models.TenantServiceInstance as any) ||
  model<ITenantServiceInstance>('TenantServiceInstance', TenantServiceInstanceSchema);
