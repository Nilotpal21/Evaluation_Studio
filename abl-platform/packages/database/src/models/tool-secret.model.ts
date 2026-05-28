/**
 * Tool Secret Model
 *
 * Stores encrypted secrets for tool integrations within projects.
 * Each secret is scoped to a tenant, project, tool, and environment
 * with support for key rotation and expiration.
 */

import mongoose, { Schema, model } from 'mongoose';
import { uuidv7 } from '../mongo/base-document.js';
import { tenantIsolationPlugin } from '../mongo/plugins/tenant-isolation.plugin.js';
import { encryptionPlugin } from '../mongo/plugins/encryption.plugin.js';
import { auditTrailPlugin } from '../mongo/plugins/audit-trail.plugin.js';

// ─── Document Interface ──────────────────────────────────────────────────

export interface IToolSecret {
  _id: string;
  tenantId: string;
  projectId: string;
  toolName: string;
  secretKey: string;
  encryptedValue: string;
  environment: string;
  version: number;
  expiresAt: Date | null;
  rotatedAt: Date | null;
  createdBy: string;
  _v: number;
  createdAt: Date;
  updatedAt: Date;
}

// ─── Schema ──────────────────────────────────────────────────────────────

const ToolSecretSchema = new Schema<IToolSecret>(
  {
    _id: { type: String, default: uuidv7 },
    tenantId: { type: String, required: true },
    projectId: { type: String, required: true },
    toolName: { type: String, required: true },
    secretKey: { type: String, required: true },
    encryptedValue: { type: String, required: true },
    environment: { type: String, required: true },
    version: { type: Number, required: true, default: 1 },
    expiresAt: { type: Date, default: null },
    rotatedAt: { type: Date, default: null },
    createdBy: { type: String, required: true },
    _v: { type: Number, default: 1 },
  },
  { timestamps: true, collection: 'tool_secrets' },
);

// ─── Plugins ─────────────────────────────────────────────────────────────

ToolSecretSchema.plugin(tenantIsolationPlugin);
ToolSecretSchema.plugin(encryptionPlugin, {
  fieldsToEncrypt: ['encryptedValue'],
  scope: 'project',
  scopeFields: { tenantId: 'tenantId', projectId: 'projectId', environment: 'environment' },
});
ToolSecretSchema.plugin(auditTrailPlugin);

// ─── Indexes ─────────────────────────────────────────────────────────────

ToolSecretSchema.index(
  { tenantId: 1, projectId: 1, toolName: 1, secretKey: 1, environment: 1 },
  { unique: true },
);
ToolSecretSchema.index({ tenantId: 1, projectId: 1 });

// ─── Model ───────────────────────────────────────────────────────────────

export const ToolSecret =
  (mongoose.models.ToolSecret as any) || model<IToolSecret>('ToolSecret', ToolSecretSchema);
