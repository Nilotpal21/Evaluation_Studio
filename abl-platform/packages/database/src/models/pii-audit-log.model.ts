/**
 * PII Audit Log Model
 *
 * Records PII access events for compliance and audit purposes.
 * TTL index auto-expires records after configurable retention period.
 *
 * Each entry records: who accessed what PII, for what purpose (consumer type),
 * in which session, for which tenant.
 */

import mongoose, { Schema, model } from 'mongoose';
import { uuidv7 } from '../mongo/base-document.js';
import { ModelRegistry } from '../model-registry.js';
import { tenantIsolationPlugin } from '../mongo/plugins/tenant-isolation.plugin.js';

// ─── Document Interface ──────────────────────────────────────────────────

export interface IPIIAuditLog {
  _id: string;
  tenantId: string;
  projectId: string;
  sessionId: string;
  /** PII token ID from the vault */
  tokenId: string;
  /** PII type that was accessed */
  piiType: string;
  /** Consumer that accessed the PII: llm, user, logs, tools, admin, system */
  consumer: string;
  /** Render mode used for this access (e.g. masked, redacted, tokenized) */
  renderMode?: string;
  /** Action performed: tokenize, detokenize, render, clear */
  action: string;
  /** Detection confidence carried over from the source PIIDetection (0..1). */
  confidence?: number;
  /** Originating recognizer name (e.g. 'core-email', 'eu-iban'). */
  recognizer?: string;
  /** Optional metadata (e.g. tool name for tools consumer) */
  metadata?: Record<string, unknown>;
  /** TTL field — MongoDB auto-deletes after expireAt */
  expireAt: Date;
  _v: number;
  createdAt: Date;
}

// ─── Schema ──────────────────────────────────────────────────────────────

/** Default retention: 90 days */
const DEFAULT_RETENTION_DAYS = 90;

const PIIAuditLogSchema = new Schema<IPIIAuditLog>(
  {
    _id: { type: String, default: uuidv7 },
    tenantId: { type: String, required: true, index: true },
    projectId: { type: String, required: true },
    sessionId: { type: String, required: true, index: true },
    tokenId: { type: String, required: true },
    piiType: { type: String, required: true },
    consumer: {
      type: String,
      required: true,
      enum: ['llm', 'user', 'logs', 'tools', 'admin', 'system'],
    },
    renderMode: { type: String, default: undefined },
    action: {
      type: String,
      required: true,
      enum: ['tokenize', 'detokenize', 'render', 'clear'],
    },
    confidence: { type: Number, default: undefined },
    recognizer: { type: String, default: undefined },
    metadata: { type: Schema.Types.Mixed, default: null },
    expireAt: {
      type: Date,
      default: () => new Date(Date.now() + DEFAULT_RETENTION_DAYS * 24 * 60 * 60 * 1000),
      index: { expires: 0 },
    },
    _v: { type: Number, default: 1 },
  },
  {
    timestamps: { createdAt: true, updatedAt: false },
    collection: 'pii_audit_logs',
  },
);

// ─── Indexes ─────────────────────────────────────────────────────────────

PIIAuditLogSchema.index({ tenantId: 1, sessionId: 1 });
PIIAuditLogSchema.index({ tenantId: 1, projectId: 1 });
PIIAuditLogSchema.index({ tenantId: 1, createdAt: -1 });
PIIAuditLogSchema.index({ tenantId: 1, piiType: 1, createdAt: -1 });

// ─── Plugins ─────────────────────────────────────────────────────────────

PIIAuditLogSchema.plugin(tenantIsolationPlugin);

// ─── Registry ────────────────────────────────────────────────────────────

ModelRegistry.registerModelDefinition('PIIAuditLog', PIIAuditLogSchema, 'platform');

// ─── Model ───────────────────────────────────────────────────────────────

export const PIIAuditLog =
  (mongoose.models.PIIAuditLog as any) || model<IPIIAuditLog>('PIIAuditLog', PIIAuditLogSchema);
