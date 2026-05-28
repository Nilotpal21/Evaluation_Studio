/**
 * Service Node Model
 *
 * Stores external service integrations for projects.
 * Includes endpoint configuration, auth, retry/circuit-breaker settings,
 * and rate limiting. Secrets are field-level encrypted at rest.
 */

import mongoose, { Schema, model } from 'mongoose';
import { uuidv7 } from '../mongo/base-document.js';
import { encryptionPlugin } from '../mongo/plugins/encryption.plugin.js';
import { tenantIsolationPlugin } from '../mongo/plugins/tenant-isolation.plugin.js';

// ─── Document Interface ──────────────────────────────────────────────────

export interface IServiceNode {
  _id: string;
  tenantId: string;
  projectId: string;
  name: string;
  displayName: string;
  description: string | null;
  endpoint: string;
  method: string;
  authType: string;
  authConfig: any;
  encryptedSecrets: string | null;
  authProfileId: string | null;
  inputSchema: any;
  outputSchema: any;
  timeoutMs: number;
  retryCount: number;
  retryDelayMs: number;
  rateLimitPerMinute: number | null;
  rateLimitPerHour: number | null;
  circuitBreakerThreshold: number;
  circuitBreakerResetMs: number;
  isActive: boolean;
  _v: number;
  createdAt: Date;
  updatedAt: Date;
}

// ─── Schema ──────────────────────────────────────────────────────────────

const ServiceNodeSchema = new Schema<IServiceNode>(
  {
    _id: { type: String, default: uuidv7 },
    tenantId: { type: String, required: true },
    projectId: { type: String, required: true },
    name: { type: String, required: true },
    displayName: { type: String, required: true },
    description: { type: String, default: null },
    endpoint: { type: String, required: true },
    method: { type: String, required: true },
    authType: { type: String, required: true },
    authConfig: { type: Schema.Types.Mixed, default: null },
    encryptedSecrets: { type: String, default: null },
    authProfileId: { type: String, default: null },
    inputSchema: { type: Schema.Types.Mixed, default: null },
    outputSchema: { type: Schema.Types.Mixed, default: null },
    timeoutMs: { type: Number, required: true },
    retryCount: { type: Number, required: true },
    retryDelayMs: { type: Number, required: true },
    rateLimitPerMinute: { type: Number, default: null },
    rateLimitPerHour: { type: Number, default: null },
    circuitBreakerThreshold: { type: Number, required: true },
    circuitBreakerResetMs: { type: Number, required: true },
    isActive: { type: Boolean, required: true },
    _v: { type: Number, default: 1 },
  },
  { timestamps: true, collection: 'service_nodes' },
);

// ─── Plugins ─────────────────────────────────────────────────────────────

ServiceNodeSchema.plugin(tenantIsolationPlugin);
ServiceNodeSchema.plugin(encryptionPlugin, {
  fieldsToEncrypt: ['encryptedSecrets'],
  scope: 'project',
  scopeFields: { tenantId: 'tenantId', projectId: 'projectId' },
});

// ─── Indexes ─────────────────────────────────────────────────────────────

ServiceNodeSchema.index({ tenantId: 1, projectId: 1, name: 1 }, { unique: true });
ServiceNodeSchema.index({ tenantId: 1, projectId: 1 });
ServiceNodeSchema.index({ tenantId: 1, projectId: 1, authProfileId: 1 });

// ─── Model ───────────────────────────────────────────────────────────────

export const ServiceNode =
  (mongoose.models.ServiceNode as any) || model<IServiceNode>('ServiceNode', ServiceNodeSchema);
