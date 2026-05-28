/**
 * Channel Connection Model
 *
 * Represents an external channel installation/connection for a project.
 * Stores channel-specific credentials (encrypted) and configuration.
 * Supports HTTP Async, Slack, Email, MS Teams, VXML/IVR, Jambonz, etc.
 */

import mongoose, { Schema, model } from 'mongoose';
import { uuidv7 } from '../mongo/base-document.js';
import { tenantIsolationPlugin } from '../mongo/plugins/tenant-isolation.plugin.js';
import { encryptionPlugin } from '../mongo/plugins/encryption.plugin.js';

const CHANNEL_CONNECTION_TYPES = [
  'http_async',
  'slack',
  'line',
  'email',
  'msteams',
  'vxml',
  'voice_vxml',
  'korevg',
  'audiocodes',
  'whatsapp',
  'messenger',
  'instagram',
  'twilio_sms',
  'voice_realtime',
  'voice_pipeline',
  'voice_twilio',
  'ag_ui',
  'a2a',
  'zendesk',
  'telegram',
  'genesys',
  'ai4w',
] as const;
const CHANNEL_CONNECTION_STATUSES = ['active', 'inactive'] as const;

// ─── Document Interface ──────────────────────────────────────────────────

export interface IChannelConnection {
  _id: string;
  tenantId: string;
  projectId: string;
  agentId: string | null;
  deploymentId: string | null;
  environment: string | null;
  channelType: string;
  externalIdentifier: string;
  connectionId: string | null;
  displayName: string | null;
  encryptedCredentials: string | null;
  authProfileId: string | null;
  verifyTokenHash: string | null;
  config: any;
  status: string;
  _v: number;
  createdAt: Date;
  updatedAt: Date;
}

// ─── Schema ──────────────────────────────────────────────────────────────

const ChannelConnectionSchema = new Schema<IChannelConnection>(
  {
    _id: { type: String, default: uuidv7 },
    tenantId: { type: String, required: true },
    projectId: { type: String, required: true },
    agentId: { type: String, default: null },
    deploymentId: { type: String, default: null },
    environment: { type: String, default: null },
    channelType: { type: String, required: true, enum: CHANNEL_CONNECTION_TYPES },
    externalIdentifier: { type: String, required: true, trim: true, minlength: 1, maxlength: 255 },
    connectionId: { type: String, default: null },
    displayName: { type: String, default: null },
    encryptedCredentials: { type: String, default: null },
    authProfileId: { type: String, default: null },
    verifyTokenHash: { type: String, default: null },
    config: { type: Schema.Types.Mixed, default: {} },
    status: { type: String, enum: CHANNEL_CONNECTION_STATUSES, default: 'active' },
    _v: { type: Number, default: 1 },
  },
  { timestamps: true, collection: 'channel_connections' },
);

ChannelConnectionSchema.pre('validate', function normalizeEmailIdentifier(this: any) {
  if (this.channelType === 'email' && typeof this.externalIdentifier === 'string') {
    this.externalIdentifier = this.externalIdentifier.toLowerCase();
  }
});

// ─── Plugins ─────────────────────────────────────────────────────────────

ChannelConnectionSchema.plugin(tenantIsolationPlugin);
// NOTE: encryptedInboundAuthToken lives inside config (Schema.Types.Mixed), not as a
// top-level field. The plugin can only encrypt top-level fields, so it's handled
// manually in channel-connections route via encryptForTenant/decryptForTenant.
ChannelConnectionSchema.plugin(encryptionPlugin, {
  fieldsToEncrypt: ['encryptedCredentials'],
  scope: 'project',
  scopeFields: { tenantId: 'tenantId', projectId: 'projectId' },
});

// ─── Indexes ─────────────────────────────────────────────────────────────

ChannelConnectionSchema.index(
  { channelType: 1, externalIdentifier: 1 },
  { unique: true, partialFilterExpression: { status: 'active' } },
);
ChannelConnectionSchema.index({ tenantId: 1, channelType: 1 });
ChannelConnectionSchema.index({ tenantId: 1, projectId: 1 });
ChannelConnectionSchema.index({ tenantId: 1, deploymentId: 1 });
ChannelConnectionSchema.index({ tenantId: 1, projectId: 1, createdAt: -1 });
ChannelConnectionSchema.index(
  { channelType: 1, verifyTokenHash: 1 },
  {
    unique: true,
    partialFilterExpression: {
      status: 'active',
      verifyTokenHash: { $type: 'string' },
    },
  },
);

ChannelConnectionSchema.index(
  { connectionId: 1 },
  {
    unique: true,
    partialFilterExpression: { connectionId: { $type: 'string' } },
  },
);

// ─── Model ───────────────────────────────────────────────────────────────

export const ChannelConnection =
  (mongoose.models.ChannelConnection as any) ||
  model<IChannelConnection>('ChannelConnection', ChannelConnectionSchema);
