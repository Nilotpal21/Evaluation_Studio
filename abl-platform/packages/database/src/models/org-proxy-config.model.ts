/**
 * Org Proxy Config Model
 *
 * Stores organization-level proxy configurations for outbound HTTP requests.
 * Supports multiple authentication types with encrypted credentials,
 * URL pattern matching, and environment-scoped priorities.
 */

import mongoose, { Schema, model } from 'mongoose';
import { uuidv7 } from '../mongo/base-document.js';
import { tenantIsolationPlugin } from '../mongo/plugins/tenant-isolation.plugin.js';
import { encryptionPlugin } from '../mongo/plugins/encryption.plugin.js';

// ─── Document Interface ──────────────────────────────────────────────────

export interface IOrgProxyConfig {
  _id: string;
  tenantId: string;
  name: string;
  proxyUrl: string;
  proxyAuthType: string;
  encryptedProxyUsername: string | null;
  encryptedProxyPassword: string | null;
  encryptedProxyToken: string | null;
  encryptedCaCertificate: string | null;
  encryptedClientCert: string | null;
  encryptedClientKey: string | null;
  /** Auth profile ID for credential resolution. Reserved — not yet wired to a runtime consumer. */
  authProfileId: string | null;
  urlPatterns: string;
  bypassPatterns: string | null;
  environment: string;
  priority: number;
  enabled: boolean;
  createdBy: string;
  _v: number;
  createdAt: Date;
  updatedAt: Date;
}

// ─── Schema ──────────────────────────────────────────────────────────────

const OrgProxyConfigSchema = new Schema<IOrgProxyConfig>(
  {
    _id: { type: String, default: uuidv7 },
    tenantId: { type: String, required: true },
    name: { type: String, required: true },
    proxyUrl: { type: String, required: true },
    proxyAuthType: { type: String, required: true },
    encryptedProxyUsername: { type: String, default: null },
    encryptedProxyPassword: { type: String, default: null },
    encryptedProxyToken: { type: String, default: null },
    encryptedCaCertificate: { type: String, default: null },
    encryptedClientCert: { type: String, default: null },
    encryptedClientKey: { type: String, default: null },
    authProfileId: { type: String, default: null },
    urlPatterns: { type: String, required: true },
    bypassPatterns: { type: String, default: null },
    environment: { type: String, required: true },
    priority: { type: Number, required: true },
    enabled: { type: Boolean, default: true },
    createdBy: { type: String, required: true },
    _v: { type: Number, default: 1 },
  },
  { timestamps: true, collection: 'org_proxy_configs' },
);

// ─── Plugins ─────────────────────────────────────────────────────────────

OrgProxyConfigSchema.plugin(tenantIsolationPlugin);
OrgProxyConfigSchema.plugin(encryptionPlugin, {
  fieldsToEncrypt: [
    'encryptedProxyUsername',
    'encryptedProxyPassword',
    'encryptedProxyToken',
    'encryptedCaCertificate',
    'encryptedClientCert',
    'encryptedClientKey',
  ],
  scope: 'tenant',
  scopeFields: { tenantId: 'tenantId' },
});

// ─── Indexes ─────────────────────────────────────────────────────────────

OrgProxyConfigSchema.index({ tenantId: 1, name: 1, environment: 1 }, { unique: true });
OrgProxyConfigSchema.index({ tenantId: 1, environment: 1 });

// ─── Model ───────────────────────────────────────────────────────────────

export const OrgProxyConfig =
  (mongoose.models.OrgProxyConfig as any) ||
  model<IOrgProxyConfig>('OrgProxyConfig', OrgProxyConfigSchema);
