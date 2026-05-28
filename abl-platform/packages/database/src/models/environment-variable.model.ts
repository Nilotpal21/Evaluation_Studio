/**
 * Environment Variable Model
 *
 * Stores per-environment key-value configuration variables within projects.
 * Values are encrypted at rest. Each variable is scoped to a tenant, project,
 * and environment with support for marking sensitive values as secrets.
 *
 * Referenced in ABL agent definitions as {{env.KEY}} placeholders.
 */

import mongoose, { Schema, model } from 'mongoose';
import { uuidv7 } from '../mongo/base-document.js';
import { tenantIsolationPlugin } from '../mongo/plugins/tenant-isolation.plugin.js';
import { auditTrailPlugin } from '../mongo/plugins/audit-trail.plugin.js';
import { encryptionPlugin } from '../mongo/plugins/encryption.plugin.js';

// ─── Document Interface ──────────────────────────────────────────────────

export interface IEnvironmentVariable {
  _id: string;
  tenantId: string;
  projectId: string;
  environment: string;
  key: string;
  encryptedValue: string;
  isSecret: boolean;
  description: string | null;
  createdBy: string;
  updatedBy: string | null;
  _v: number;
  createdAt: Date;
  updatedAt: Date;
}

// ─── Schema ──────────────────────────────────────────────────────────────

const EnvironmentVariableSchema = new Schema<IEnvironmentVariable>(
  {
    _id: { type: String, default: uuidv7 },
    tenantId: { type: String, required: true },
    projectId: { type: String, required: true },
    environment: {
      type: String,
      required: true,
      enum: ['global', 'dev', 'staging', 'production'],
      default: 'global',
    },
    key: { type: String, required: true },
    // Empty strings are valid (AES-GCM encrypts zero-length plaintext).
    // Mongoose `required: true` rejects "" as falsy, so we skip it here
    // and rely on the encryption plugin pre-save hook + the route-level
    // validation to ensure a value is provided.
    encryptedValue: { type: String },
    isSecret: { type: Boolean, default: false },
    description: { type: String, default: null },
    createdBy: { type: String, required: true },
    updatedBy: { type: String, default: null },
    _v: { type: Number, default: 1 },
  },
  { timestamps: true, collection: 'environment_variables' },
);

// ─── Plugins ─────────────────────────────────────────────────────────────

EnvironmentVariableSchema.plugin(tenantIsolationPlugin);
EnvironmentVariableSchema.plugin(encryptionPlugin, {
  fieldsToEncrypt: ['encryptedValue'],
  scope: 'project',
  scopeFields: { tenantId: 'tenantId', projectId: 'projectId', environment: 'environment' },
});
EnvironmentVariableSchema.plugin(auditTrailPlugin);

// ─── Indexes ─────────────────────────────────────────────────────────────

EnvironmentVariableSchema.index(
  { tenantId: 1, projectId: 1, environment: 1, key: 1 },
  { unique: true },
);
EnvironmentVariableSchema.index({ tenantId: 1, projectId: 1, environment: 1 });

// ─── Model ───────────────────────────────────────────────────────────────

export const EnvironmentVariable =
  (mongoose.models.EnvironmentVariable as any) ||
  model<IEnvironmentVariable>('EnvironmentVariable', EnvironmentVariableSchema);
