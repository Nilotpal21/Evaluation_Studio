/**
 * API Key Model
 *
 * Stores API keys for programmatic access to the ABL Platform.
 * Each key is scoped to a tenant with specific permissions,
 * project access, and environment restrictions.
 */

import mongoose, { Schema, model } from 'mongoose';
import { uuidv7 } from '../mongo/base-document.js';
import { tenantIsolationPlugin } from '../mongo/plugins/tenant-isolation.plugin.js';
import { auditTrailPlugin } from '../mongo/plugins/audit-trail.plugin.js';

// ─── Document Interface ──────────────────────────────────────────────────

export interface IApiKey {
  _id: string;
  tenantId: string;
  name: string;
  clientId: string;
  keyHash: string;
  prefix: string;
  scopes: string[];
  projectIds: string[];
  environments: string[];
  expiresAt: Date | null;
  lastUsedAt: Date | null;
  createdBy: string;
  revokedAt: Date | null;
  _v: number;
  createdAt: Date;
  updatedAt: Date;
}

// ─── Schema ──────────────────────────────────────────────────────────────

const ApiKeySchema = new Schema<IApiKey>(
  {
    _id: { type: String, default: uuidv7 },
    tenantId: { type: String, required: true },
    name: { type: String, required: true },
    clientId: { type: String, required: true },
    keyHash: { type: String, required: true },
    prefix: { type: String, required: true },
    scopes: { type: [String], default: [] },
    projectIds: { type: [String], default: [] },
    environments: { type: [String], default: [] },
    expiresAt: { type: Date, default: null },
    lastUsedAt: { type: Date, default: null },
    createdBy: { type: String, required: true },
    revokedAt: { type: Date, default: null },
    _v: { type: Number, default: 1 },
  },
  { timestamps: true, collection: 'api_keys' },
);

// ─── Plugins ─────────────────────────────────────────────────────────────

ApiKeySchema.plugin(tenantIsolationPlugin);
ApiKeySchema.plugin(auditTrailPlugin);

// ─── Indexes ─────────────────────────────────────────────────────────────

ApiKeySchema.index({ keyHash: 1 }, { unique: true });
ApiKeySchema.index({ tenantId: 1, clientId: 1 }, { unique: true });
ApiKeySchema.index({ tenantId: 1 });
ApiKeySchema.index({ prefix: 1 });

// ─── Model ───────────────────────────────────────────────────────────────

export const ApiKey = (mongoose.models.ApiKey as any) || model<IApiKey>('ApiKey', ApiKeySchema);
