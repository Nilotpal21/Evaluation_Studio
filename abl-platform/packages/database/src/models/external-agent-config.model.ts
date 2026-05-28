/**
 * External Agent Config Model
 *
 * Stores external agent configurations per project. Each config defines
 * how to connect to a remote agent (A2A or REST protocol), with
 * optional encrypted auth credentials.
 */

import mongoose, { Schema, model } from 'mongoose';
import { uuidv7 } from '../mongo/base-document.js';
import { tenantIsolationPlugin } from '../mongo/plugins/tenant-isolation.plugin.js';
import { encryptionPlugin } from '../mongo/plugins/encryption.plugin.js';

// ─── Document Interface ──────────────────────────────────────────────────

export interface IExternalAgentConfig {
  _id: string;
  tenantId: string;
  projectId: string;
  name: string;
  displayName: string | null;
  endpoint: string;
  protocol: 'a2a' | 'rest';
  authType: 'none' | 'bearer' | 'api_key';
  encryptedAuthConfig: string | null;
  // plaintext JSON: { value: string, header?: string }
  // Field name is `header` (NOT `headerName`). Matches OutboundAuthConfig.header.
  lastDiscoveredCard: object | null;
  lastConnectionStatus: 'connected' | 'failed' | null;
  lastConnectionAt: Date | null;
  lastConnectionLatencyMs: number | null;
  lastConnectionError: string | null;
  createdBy: string | null;
  modifiedBy: string | null;
  createdAt: Date;
  updatedAt: Date;
}

// ─── Schema ──────────────────────────────────────────────────────────────

const ExternalAgentConfigSchema = new Schema<IExternalAgentConfig>(
  {
    _id: { type: String, default: uuidv7 },
    tenantId: { type: String, required: true },
    projectId: { type: String, required: true },
    name: { type: String, required: true },
    displayName: { type: String, default: null },
    endpoint: { type: String, required: true },
    protocol: { type: String, required: true, enum: ['a2a', 'rest'] },
    authType: { type: String, required: true, enum: ['none', 'bearer', 'api_key'] },
    encryptedAuthConfig: { type: String, default: null },
    lastDiscoveredCard: { type: Schema.Types.Mixed, default: null },
    lastConnectionStatus: {
      type: String,
      enum: ['connected', 'failed'],
      default: null,
    },
    lastConnectionAt: { type: Date, default: null },
    lastConnectionLatencyMs: { type: Number, default: null },
    lastConnectionError: { type: String, default: null },
    createdBy: { type: String, default: null },
    modifiedBy: { type: String, default: null },
  },
  { timestamps: true, collection: 'external_agent_configs' },
);

// ─── Plugins ─────────────────────────────────────────────────────────────

ExternalAgentConfigSchema.plugin(tenantIsolationPlugin);
ExternalAgentConfigSchema.plugin(encryptionPlugin, {
  fieldsToEncrypt: ['encryptedAuthConfig'],
  scope: 'project',
  scopeFields: { tenantId: 'tenantId', projectId: 'projectId' },
});

// ─── Indexes ─────────────────────────────────────────────────────────────

ExternalAgentConfigSchema.index({ tenantId: 1, projectId: 1, name: 1 }, { unique: true });
ExternalAgentConfigSchema.index({ tenantId: 1, projectId: 1 });

// ─── Model ───────────────────────────────────────────────────────────────

export const ExternalAgentConfig =
  (mongoose.models.ExternalAgentConfig as any) ||
  model<IExternalAgentConfig>('ExternalAgentConfig', ExternalAgentConfigSchema);
