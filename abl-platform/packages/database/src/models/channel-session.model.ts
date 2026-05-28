/**
 * Channel Session Model
 *
 * Maps external session keys (e.g. Slack thread ID, call ID, email subject)
 * to internal runtime session IDs. Enables session continuity across
 * channel-specific conversation identifiers.
 */

import mongoose, { Schema, model } from 'mongoose';
import { uuidv7 } from '../mongo/base-document.js';
import { tenantIsolationPlugin } from '../mongo/plugins/tenant-isolation.plugin.js';

const CHANNEL_SESSION_STATUSES = ['active', 'inactive', 'ended'] as const;
const CHANNEL_SESSION_RETENTION_DAYS = Number.parseInt(
  process.env.CHANNEL_SESSION_RETENTION_DAYS || '0',
  10,
);

// ─── Document Interface ──────────────────────────────────────────────────

export interface IChannelSession {
  _id: string;
  tenantId: string;
  channelConnectionId: string;
  externalSessionKey: string;
  sessionId: string;
  /** Working-copy source fingerprint used to invalidate stale runtime sessions */
  compilationHash: string | null;
  projectId: string;
  agentId: string | null;
  metadata: any;
  /** RFC 5322 Message-IDs (inbound + outbound) for email thread resolution */
  emailMessageIds: string[];
  status: string;
  lastMessageAt: Date;
  _v: number;
  createdAt: Date;
  updatedAt: Date;
}

// ─── Schema ──────────────────────────────────────────────────────────────

const ChannelSessionSchema = new Schema<IChannelSession>(
  {
    _id: { type: String, default: uuidv7 },
    tenantId: { type: String, required: true },
    channelConnectionId: { type: String, required: true },
    externalSessionKey: { type: String, required: true, minlength: 1, maxlength: 512 },
    sessionId: { type: String, required: true },
    compilationHash: { type: String, default: null },
    projectId: { type: String, required: true },
    agentId: { type: String, default: null },
    metadata: { type: Schema.Types.Mixed, default: {} },
    emailMessageIds: { type: [String], default: [] },
    status: { type: String, enum: CHANNEL_SESSION_STATUSES, default: 'active' },
    lastMessageAt: { type: Date, default: Date.now },
    _v: { type: Number, default: 1 },
  },
  { timestamps: true, collection: 'channel_sessions' },
);

// ─── Plugins ─────────────────────────────────────────────────────────────

ChannelSessionSchema.plugin(tenantIsolationPlugin);

// ─── Indexes ─────────────────────────────────────────────────────────────

ChannelSessionSchema.index(
  { tenantId: 1, channelConnectionId: 1, externalSessionKey: 1 },
  { unique: true },
);
ChannelSessionSchema.index({ channelConnectionId: 1 });
ChannelSessionSchema.index({ sessionId: 1 });
ChannelSessionSchema.index({ tenantId: 1, status: 1 });
ChannelSessionSchema.index({ tenantId: 1, channelConnectionId: 1, lastMessageAt: -1 });
ChannelSessionSchema.index(
  { tenantId: 1, channelConnectionId: 1, emailMessageIds: 1 },
  { partialFilterExpression: { 'emailMessageIds.0': { $exists: true } } },
);

if (Number.isFinite(CHANNEL_SESSION_RETENTION_DAYS) && CHANNEL_SESSION_RETENTION_DAYS > 0) {
  ChannelSessionSchema.index(
    { lastMessageAt: 1 },
    { expireAfterSeconds: CHANNEL_SESSION_RETENTION_DAYS * 24 * 60 * 60 },
  );
}

// ─── Model ───────────────────────────────────────────────────────────────

export const ChannelSession =
  (mongoose.models.ChannelSession as any) ||
  model<IChannelSession>('ChannelSession', ChannelSessionSchema);
