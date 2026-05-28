/**
 * Fact Model
 *
 * Key-value store for agent facts with optional TTL expiration.
 * Values are stored as JSON-stringified strings. Supports provenance
 * tracking via source fields (agent, session, trace).
 */

import mongoose, { Schema, model } from 'mongoose';
import { uuidv7 } from '../mongo/base-document.js';
import { tenantIsolationPlugin } from '../mongo/plugins/tenant-isolation.plugin.js';

// ─── Document Interface ──────────────────────────────────────────────────

export interface IFact {
  _id: string;
  tenantId: string;
  /** Owner — only this user's sessions can read/write their facts */
  userId: string;
  /** Scope — facts are isolated per project (agent group) */
  projectId: string;
  /** Memory scope: 'user' (per-user) or 'project' (shared across all users in project) */
  scope: 'user' | 'project';
  key: string;
  value: string;
  expiresAt: Date | null;
  sourceType: string;
  sourceAgentName: string | null;
  sourceSessionId: string | null;
  sourceTraceId: string | null;
  metadata: Record<string, unknown> | null;
  _v: number;
  /** Tombstone marker — true once delete() is called. Reads filter on { isDeleted: { $ne: true } }. */
  isDeleted?: boolean;
  /** Audit-reconstructible deletion timestamp. Tombstone TTL still governed by expiresAt. */
  deletedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

// ─── Schema ──────────────────────────────────────────────────────────────

const FactSchema = new Schema<IFact>(
  {
    _id: { type: String, default: uuidv7 },
    tenantId: { type: String, required: true },
    userId: { type: String, required: true },
    projectId: { type: String, required: true },
    scope: { type: String, enum: ['user', 'project'], default: 'user' },
    key: { type: String, required: true },
    value: { type: String, required: true },
    expiresAt: { type: Date, default: null },
    sourceType: { type: String, required: true },
    sourceAgentName: { type: String, default: null },
    sourceSessionId: { type: String, default: null },
    sourceTraceId: { type: String, default: null },
    metadata: { type: Schema.Types.Mixed, default: null },
    _v: { type: Number, default: 1 },
    isDeleted: { type: Boolean, default: undefined },
    deletedAt: { type: Date, default: undefined },
  },
  { timestamps: true, collection: 'facts' },
);

// ─── Indexes ─────────────────────────────────────────────────────────────

// Ownership compound key: tenant + user + project + scope + key
// scope distinguishes user-level from project-level facts with the same key
FactSchema.index({ tenantId: 1, userId: 1, projectId: 1, scope: 1, key: 1 }, { unique: true });
FactSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
FactSchema.index({ sourceType: 1 });

// ─── Plugins ─────────────────────────────────────────────────────────────

FactSchema.plugin(tenantIsolationPlugin);

// ─── Model ───────────────────────────────────────────────────────────────

export const Fact = (mongoose.models.Fact as any) || model<IFact>('Fact', FactSchema);
