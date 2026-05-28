/**
 * Git Integration Model
 *
 * Stores git repository connection settings per project.
 * Supports GitHub, GitLab, Bitbucket, and generic git hosts.
 */

import mongoose, { Schema, model } from 'mongoose';
import { uuidv7 } from '../mongo/base-document.js';
import { tenantIsolationPlugin } from '../mongo/plugins/tenant-isolation.plugin.js';

// ─── Document Interface ──────────────────────────────────────────────────

export interface IGitAutoDeployConfig {
  enabled: boolean;
  environment: string;
  branch: string;
}

export interface IGitSyncConfig {
  autoSync: boolean;
  autoDeploy: IGitAutoDeployConfig | null;
  conflictStrategy: 'manual' | 'local_wins' | 'remote_wins';
}

export interface IGitIntegration {
  _id: string;
  projectId: string;
  tenantId: string;
  provider: 'github' | 'gitlab' | 'bitbucket' | 'generic';
  repositoryUrl: string;
  defaultBranch: string;
  syncPath: string;
  authProfileId: string;
  webhookSecret: string | null;
  previousWebhookSecret: string | null;
  previousWebhookSecretExpiresAt: Date | null;
  webhookId: string | null;
  syncConfig: IGitSyncConfig;
  lastSyncAt: Date | null;
  lastSyncCommit: string | null;
  lastSyncStatus: 'success' | 'failed' | 'conflict' | null;
  lastSyncError: string | null;
  status: 'active' | 'disconnected' | 'error';
  _v: number;
  createdAt: Date;
  updatedAt: Date;
}

// ─── Schema ──────────────────────────────────────────────────────────────

const GitAutoDeploySchema = new Schema<IGitAutoDeployConfig>(
  {
    enabled: { type: Boolean, required: true },
    environment: { type: String, required: true },
    branch: { type: String, required: true },
  },
  { _id: false },
);

const GitSyncConfigSchema = new Schema<IGitSyncConfig>(
  {
    autoSync: { type: Boolean, default: false },
    autoDeploy: { type: GitAutoDeploySchema, default: null },
    conflictStrategy: {
      type: String,
      enum: ['manual', 'local_wins', 'remote_wins'],
      default: 'manual',
    },
  },
  { _id: false },
);

const GitIntegrationSchema = new Schema<IGitIntegration>(
  {
    _id: { type: String, default: uuidv7 },
    projectId: { type: String, required: true },
    tenantId: { type: String, required: true },
    provider: { type: String, enum: ['github', 'gitlab', 'bitbucket', 'generic'], required: true },
    repositoryUrl: { type: String, required: true },
    defaultBranch: { type: String, default: 'main' },
    syncPath: { type: String, default: '/' },
    authProfileId: { type: String, required: true },
    webhookSecret: { type: String, default: null },
    previousWebhookSecret: { type: String, default: null },
    previousWebhookSecretExpiresAt: { type: Date, default: null },
    webhookId: { type: String, default: null },
    syncConfig: {
      type: GitSyncConfigSchema,
      default: () => ({ autoSync: false, autoDeploy: null, conflictStrategy: 'manual' }),
    },
    lastSyncAt: { type: Date, default: null },
    lastSyncCommit: { type: String, default: null },
    lastSyncStatus: { type: String, enum: ['success', 'failed', 'conflict', null], default: null },
    lastSyncError: { type: String, default: null },
    status: { type: String, enum: ['active', 'disconnected', 'error'], default: 'active' },
    _v: { type: Number, default: 1 },
  },
  { timestamps: true, collection: 'git_integrations' },
);

// ─── Indexes ─────────────────────────────────────────────────────────────

GitIntegrationSchema.index({ tenantId: 1, projectId: 1 }, { unique: true });
GitIntegrationSchema.index({ tenantId: 1 });

// ─── Plugins ─────────────────────────────────────────────────────────────

GitIntegrationSchema.plugin(tenantIsolationPlugin);

// ─── Model ───────────────────────────────────────────────────────────────

export const GitIntegration =
  (mongoose.models.GitIntegration as any) ||
  model<IGitIntegration>('GitIntegration', GitIntegrationSchema);
