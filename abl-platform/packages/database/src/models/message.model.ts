/**
 * Message Model
 *
 * Individual messages within a conversation session.
 * Stores role, content, channel, trace correlation, and PII flags.
 * Tenant-scoped via denormalized tenantId from the parent session.
 */

import mongoose, { Schema, model } from 'mongoose';
import { uuidv7 } from '../mongo/base-document.js';
import { tenantIsolationPlugin } from '../mongo/plugins/tenant-isolation.plugin.js';
import { encryptionPlugin } from '../mongo/plugins/encryption.plugin.js';

// ─── Document Interface ──────────────────────────────────────────────────

export interface IMessage {
  _id: string;
  sessionId: string;
  tenantId: string;
  projectId: string;
  contactId: string | null;
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  contentEnvelope: string | null;
  channel: string;
  traceId: string | null;
  attachmentIds: string[];
  hasPII: boolean;
  scrubbed: boolean;
  scrubbedAt: Date | null;
  encrypted: boolean;
  metadata: any;
  timestamp: Date;
  expiresAt: Date | null;
  idempotencyKey: string | null;
  /** Originating channel for omnichannel recall display */
  sourceChannel: string | null;
  /** Input mode: voice, typed, tool, or system */
  inputMode: 'voice' | 'typed' | 'tool' | 'system' | null;
  /** Which participant sent this message (omnichannel live sync) */
  participantId: string | null;
  /** True for persisted/finalized transcript items */
  final: boolean;
  /** Monotonic sequence number per session via Redis INCR */
  sequence: number | null;
  /** Channels this message was fanned out to */
  deliveryChannels: string[];
  /**
   * Agent that produced the message. Top-level field (in addition to
   * `metadata.agentName`) so per-agent analytics and feedback target lookups
   * do not need to parse the metadata blob. Empty string when unknown.
   */
  agentName: string;
  _v: number;
  createdAt: Date;
  updatedAt: Date;
}

// ─── Schema ──────────────────────────────────────────────────────────────

const MessageSchema = new Schema<IMessage>(
  {
    _id: { type: String, default: uuidv7 },
    sessionId: { type: String, required: true },
    tenantId: { type: String, required: true },
    projectId: { type: String, required: true, default: '' },
    contactId: { type: String, default: null },
    role: { type: String, required: true, enum: ['user', 'assistant', 'system', 'tool'] },
    content: { type: String, required: true },
    contentEnvelope: { type: String, default: null },
    channel: { type: String, required: true },
    traceId: { type: String, default: null },
    attachmentIds: { type: [String], default: [] },
    hasPII: { type: Boolean, default: false },
    scrubbed: { type: Boolean, default: false },
    scrubbedAt: { type: Date, default: null },
    encrypted: { type: Boolean, default: false },
    metadata: { type: Schema.Types.Mixed, default: {} },
    timestamp: { type: Date, default: () => new Date() },
    expiresAt: { type: Date, default: null },
    idempotencyKey: { type: String },
    sourceChannel: { type: String, default: null },
    inputMode: { type: String, default: null, enum: [null, 'voice', 'typed', 'tool', 'system'] },
    participantId: { type: String, default: null },
    final: { type: Boolean, default: true },
    sequence: { type: Number, default: null },
    deliveryChannels: { type: [String], default: [] },
    agentName: { type: String, default: '' },
    _v: { type: Number, default: 1 },
  },
  { timestamps: true, collection: 'messages' },
);

// ─── Plugins ─────────────────────────────────────────────────────────────

MessageSchema.plugin(tenantIsolationPlugin);
MessageSchema.plugin(encryptionPlugin, {
  fieldsToEncrypt: ['content', 'contentEnvelope'],
  tenantIdField: 'tenantId',
  scope: 'project',
  scopeFields: { tenantId: 'tenantId', projectId: 'projectId' },
});

// ─── Indexes ─────────────────────────────────────────────────────────────

MessageSchema.index({ sessionId: 1 });
MessageSchema.index({ timestamp: 1 });
MessageSchema.index({ tenantId: 1 });
// Compound index for contact history queries and GDPR cross-reference
MessageSchema.index({ tenantId: 1, sessionId: 1, timestamp: -1 });
// Compound index for PII scrubbing retention queries
MessageSchema.index({ tenantId: 1, hasPII: 1, scrubbed: 1, timestamp: 1 });
// Compound index for cross-session contact message history
MessageSchema.index(
  { tenantId: 1, contactId: 1, timestamp: -1 },
  { partialFilterExpression: { contactId: { $type: 'string' } } },
);

// TTL index: auto-expire messages after expiresAt. Messages without expiresAt (null) are not expired.
MessageSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0, sparse: true });

// Idempotency index: prevents duplicate message writes, scoped by tenant + session.
// Uses partialFilterExpression (not sparse) so explicit null values are excluded.
// MIGRATION NOTE: This replaces the previous single-field { idempotencyKey: 1 } unique index.
// On upgrade, drop the old index first: db.messages.dropIndex('idempotencyKey_1')
// before Mongoose auto-creates this one. The partialFilterExpression ensures null
// idempotencyKey values are excluded, so no conflicts from existing null records.
MessageSchema.index(
  { tenantId: 1, sessionId: 1, idempotencyKey: 1 },
  { unique: true, partialFilterExpression: { idempotencyKey: { $type: 'string' } } },
);

// Compound index for omnichannel project-scoped recall queries
MessageSchema.index(
  { tenantId: 1, projectId: 1, contactId: 1, createdAt: -1 },
  { partialFilterExpression: { contactId: { $type: 'string' }, projectId: { $gt: '' } } },
);
// Compound index for session-scoped sequence ordering (live transcript sync)
MessageSchema.index({ tenantId: 1, sessionId: 1, sequence: 1 });

// TODO: Text index for future recall_history tool — not yet consumed by any query.
// Uncomment when the recall_history tool is implemented. Text indexes are expensive
// to maintain on high-write collections — deferring avoids unnecessary write overhead.
// Note: only one text index is allowed per collection — do not add another.
// MessageSchema.index({ tenantId: 1, contactId: 1, content: 'text' });

// ─── Model ───────────────────────────────────────────────────────────────

export const Message =
  (mongoose.models.Message as any) || model<IMessage>('Message', MessageSchema);
