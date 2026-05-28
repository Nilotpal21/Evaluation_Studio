/**
 * SDK Channel Model
 *
 * Represents an SDK channel configuration for a project deployment.
 * Each channel provides a public API endpoint with specific config
 * and is linked to a public API key for authentication.
 */

import mongoose, { Schema, model } from 'mongoose';
import { uuidv7 } from '../mongo/base-document.js';
import { tenantIsolationPlugin } from '../mongo/plugins/tenant-isolation.plugin.js';

// ─── Document Interface ──────────────────────────────────────────────────

type SDKChannelConfig = Record<string, unknown> & {
  rateLimitRpm?: number;
};

export type SDKChannelAuthMode = 'anonymous' | 'hosted_exchange';

export interface ISDKChannel {
  _id: string;
  tenantId: string;
  projectId: string;
  deploymentId: string | null;
  name: string;
  channelType: string;
  publicApiKeyId: string;
  config: SDKChannelConfig;
  isActive: boolean;
  environment: string | null;
  followEnvironment: boolean;
  authMode: SDKChannelAuthMode;
  serverSecretHash: string | null;
  serverSecretSalt: string | null;
  serverSecretPrefix: string | null;
  serverSecretLastRotatedAt: Date | null;
  _v: number;
  createdAt: Date;
  updatedAt: Date;
}

// ─── Schema ──────────────────────────────────────────────────────────────

const SDKChannelSchema = new Schema<ISDKChannel>(
  {
    _id: { type: String, default: uuidv7 },
    tenantId: { type: String, required: true },
    projectId: { type: String, required: true },
    deploymentId: { type: String, default: null },
    name: { type: String, required: true },
    channelType: { type: String, required: true },
    publicApiKeyId: { type: String, required: true },
    config: { type: Schema.Types.Mixed, default: {} },
    isActive: { type: Boolean, default: true },
    environment: { type: String, default: null, enum: ['dev', 'staging', 'production', null] },
    followEnvironment: { type: Boolean, default: true },
    authMode: {
      type: String,
      default: 'anonymous',
      enum: ['anonymous', 'hosted_exchange'],
    },
    serverSecretHash: { type: String, default: null },
    serverSecretSalt: { type: String, default: null },
    serverSecretPrefix: { type: String, default: null },
    serverSecretLastRotatedAt: { type: Date, default: null },
    _v: { type: Number, default: 1 },
  },
  { timestamps: true, collection: 'sdk_channels' },
);

// ─── Plugins ─────────────────────────────────────────────────────────────

SDKChannelSchema.plugin(tenantIsolationPlugin);

// ─── Indexes ─────────────────────────────────────────────────────────────

SDKChannelSchema.index({ tenantId: 1, projectId: 1, name: 1 }, { unique: true });
SDKChannelSchema.index({ tenantId: 1, projectId: 1 });
SDKChannelSchema.index({ publicApiKeyId: 1 });
SDKChannelSchema.index({ projectId: 1, environment: 1, followEnvironment: 1 });
SDKChannelSchema.index({ authMode: 1, serverSecretPrefix: 1 });

// ─── Model ───────────────────────────────────────────────────────────────

export const SDKChannel =
  (mongoose.models.SDKChannel as any) || model<ISDKChannel>('SDKChannel', SDKChannelSchema);
