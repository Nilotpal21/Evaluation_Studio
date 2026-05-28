/**
 * Audit Log Model
 *
 * Stores audit trail for sensitive operations.
 * NOT tenant-scoped (allows cross-tenant audit queries by admins).
 */

import mongoose, { Schema, model } from 'mongoose';
import { uuidv7 } from '../mongo/base-document.js';
import { ModelRegistry } from '../model-registry.js';
import { tenantIsolationPlugin } from '../mongo/plugins/tenant-isolation.plugin.js';

const DEFAULT_AUDIT_LOG_TTL_INDEX_ENABLED = false;

function parseBooleanEnv(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) {
    return fallback;
  }

  const normalized = value.trim().toLowerCase();
  if (normalized === 'true') {
    return true;
  }
  if (normalized === 'false') {
    return false;
  }
  return fallback;
}

export function isAuditLogTTLIndexEnabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return parseBooleanEnv(env.AUDIT_LOG_TTL_INDEX_ENABLED, DEFAULT_AUDIT_LOG_TTL_INDEX_ENABLED);
}

interface AuditLogCollectionLike {
  createIndex(
    indexSpec: Record<string, 1 | -1>,
    options: { name?: string; expireAfterSeconds?: number; sparse?: boolean },
  ): Promise<unknown>;
}

// ─── Document Interface ──────────────────────────────────────────────────

export interface IAuditLog {
  _id: string;
  userId: string | null;
  tenantId: string | null;
  action: string;
  ip: string | null;
  userAgent: string | null;
  metadata: Record<string, unknown> | string | null;
  eventType: string | null;
  actorType: string | null;
  projectId: string | null;
  resourceType: string | null;
  resourceId: string | null;
  environment: string | null;
  traceId: string | null;
  source: string | null;
  schemaVersion: number | null;
  metadataEncoding: 'object' | 'json-string' | null;
  retentionClass: 'default' | 'auth' | 'crud' | 'indefinite' | null;
  expiresAt: Date | null;
  _v: number;
  createdAt: Date;
  updatedAt: Date;
}

// ─── Schema ──────────────────────────────────────────────────────────────

export function createAuditLogSchema(options?: { enableTtlIndex?: boolean }): Schema<IAuditLog> {
  const schema = new Schema<IAuditLog>(
    {
      _id: { type: String, default: uuidv7 },
      userId: { type: String, default: null },
      tenantId: { type: String, default: null },
      action: { type: String, required: true },
      ip: { type: String, default: null },
      userAgent: { type: String, default: null },
      metadata: { type: Schema.Types.Mixed, default: null },
      eventType: { type: String, default: null },
      actorType: { type: String, default: null },
      projectId: { type: String, default: null },
      resourceType: { type: String, default: null },
      resourceId: { type: String, default: null },
      environment: { type: String, default: null },
      traceId: { type: String, default: null },
      source: { type: String, default: null },
      schemaVersion: { type: Number, default: null },
      metadataEncoding: {
        type: String,
        enum: ['object', 'json-string'],
        default: null,
      },
      retentionClass: {
        type: String,
        enum: ['default', 'auth', 'crud', 'indefinite'],
        default: 'default',
      },
      expiresAt: { type: Date, default: null },
      _v: { type: Number, default: 1 },
    },
    { timestamps: true, collection: 'audit_logs' },
  );

  // ─── Indexes ───────────────────────────────────────────────────────────

  schema.index({ tenantId: 1, createdAt: -1 });
  schema.index({ userId: 1 });
  schema.index({ action: 1 });
  schema.index({ createdAt: -1 });
  schema.index({ tenantId: 1, action: 1, createdAt: -1 });
  schema.index({ tenantId: 1, eventType: 1, createdAt: -1 });
  schema.index({ tenantId: 1, resourceType: 1, resourceId: 1, createdAt: -1 }, { sparse: true });
  schema.index({ tenantId: 1, projectId: 1, createdAt: -1 }, { sparse: true });
  schema.index({ traceId: 1, createdAt: -1 }, { sparse: true });
  schema.index({ schemaVersion: 1, source: 1, createdAt: -1 }, { sparse: true });

  // Sparse index for metadata dot-notation queries used by search-ai audit-logger
  schema.index(
    { tenantId: 1, 'metadata.resourceType': 1, 'metadata.resourceId': 1 },
    { sparse: true },
  );

  if (options?.enableTtlIndex ?? isAuditLogTTLIndexEnabled()) {
    schema.index({ expiresAt: 1 }, { expireAfterSeconds: 0, sparse: true });
  }

  // ─── Plugins ───────────────────────────────────────────────────────────

  schema.plugin(tenantIsolationPlugin);

  return schema;
}

export async function ensureAuditLogTTLIndex(
  env: Record<string, string | undefined> = process.env,
  collection: AuditLogCollectionLike = AuditLog.collection as AuditLogCollectionLike,
): Promise<boolean> {
  if (!isAuditLogTTLIndexEnabled(env)) {
    return false;
  }

  await collection.createIndex(
    { expiresAt: 1 },
    {
      name: 'expiresAt_1',
      expireAfterSeconds: 0,
      sparse: true,
    },
  );

  return true;
}

const AuditLogSchema = createAuditLogSchema();

// ─── Model ───────────────────────────────────────────────────────────────

// Register with ModelRegistry for dual-database support
ModelRegistry.registerModelDefinition('AuditLog', AuditLogSchema, 'platform');

export const AuditLog =
  (mongoose.models.AuditLog as mongoose.Model<IAuditLog>) ||
  model<IAuditLog>('AuditLog', AuditLogSchema);
