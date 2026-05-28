/**
 * Omnichannel Project Settings Model
 *
 * Project-level configuration for omnichannel session continuity features:
 * recall, identity verification, consent, and live sync.
 * One document per project. Falls back to platform defaults when absent.
 */

import mongoose, { Schema, model } from 'mongoose';
import { uuidv7 } from '../mongo/base-document.js';
import { tenantIsolationPlugin } from '../mongo/plugins/tenant-isolation.plugin.js';

// ─── Document Interface ──────────────────────────────────────────────────

export interface IOmnichannelProjectSettings {
  _id: string;
  tenantId: string;
  projectId: string;
  recall: {
    enabled: boolean;
    maxMessages: number;
    maxAgeDays: number;
    defaultAllowedChannels: string[];
  };
  identity: {
    requireVerification: boolean;
    minTier: number;
  };
  consent: {
    requireExplicitConsent: boolean;
    defaultCapabilities: string[];
  };
  liveSync: {
    enabled: boolean;
    joinMode: string;
    transcriptMode: string;
  };
  retention: {
    maxRetentionDays: number;
    enableAutoPurge: boolean;
  };
  _v: number;
  createdAt: Date;
  updatedAt: Date;
}

// ─── Subdocument Schemas ─────────────────────────────────────────────────

const RecallConfigSchema = new Schema(
  {
    enabled: { type: Boolean, default: false },
    maxMessages: { type: Number, default: 20 },
    maxAgeDays: { type: Number, default: 30 },
    defaultAllowedChannels: { type: [String], default: [] },
  },
  { _id: false },
);

const IdentityConfigSchema = new Schema(
  {
    requireVerification: { type: Boolean, default: true },
    minTier: { type: Number, default: 2 },
  },
  { _id: false },
);

const ConsentConfigSchema = new Schema(
  {
    requireExplicitConsent: { type: Boolean, default: true },
    defaultCapabilities: { type: [String], default: [] },
  },
  { _id: false },
);

const LiveSyncConfigSchema = new Schema(
  {
    enabled: { type: Boolean, default: false },
    joinMode: { type: String, default: 'prompt', enum: ['prompt', 'auto'] },
    transcriptMode: {
      type: String,
      default: 'final_only',
      enum: ['final_only', 'interim'],
    },
  },
  { _id: false },
);

const RetentionConfigSchema = new Schema(
  {
    maxRetentionDays: { type: Number, default: 90 },
    enableAutoPurge: { type: Boolean, default: false },
  },
  { _id: false },
);

// ─── Schema ──────────────────────────────────────────────────────────────

const OmnichannelProjectSettingsSchema = new Schema<IOmnichannelProjectSettings>(
  {
    _id: { type: String, default: uuidv7 },
    tenantId: { type: String, required: true },
    projectId: { type: String, required: true },
    recall: { type: RecallConfigSchema, default: () => ({}) },
    identity: { type: IdentityConfigSchema, default: () => ({}) },
    consent: { type: ConsentConfigSchema, default: () => ({}) },
    liveSync: { type: LiveSyncConfigSchema, default: () => ({}) },
    retention: { type: RetentionConfigSchema, default: () => ({}) },
    _v: { type: Number, default: 1 },
  },
  { timestamps: true, collection: 'omnichannel_project_settings' },
);

// ─── Plugins ─────────────────────────────────────────────────────────────

OmnichannelProjectSettingsSchema.plugin(tenantIsolationPlugin);

// ─── Indexes ─────────────────────────────────────────────────────────────

OmnichannelProjectSettingsSchema.index({ tenantId: 1, projectId: 1 }, { unique: true });

// ─── Model ───────────────────────────────────────────────────────────────

export const OmnichannelProjectSettings =
  (mongoose.models.OmnichannelProjectSettings as mongoose.Model<IOmnichannelProjectSettings>) ||
  model<IOmnichannelProjectSettings>(
    'OmnichannelProjectSettings',
    OmnichannelProjectSettingsSchema,
  );
