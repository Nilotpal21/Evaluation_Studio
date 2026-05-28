/**
 * Git webhook cleanup job.
 *
 * Durable retry state for provider webhooks that could not be removed while
 * disabling auto-sync or disconnecting an integration.
 */

import mongoose, { Schema, model } from 'mongoose';
import { uuidv7 } from '../mongo/base-document.js';
import { tenantIsolationPlugin } from '../mongo/plugins/tenant-isolation.plugin.js';
export type GitWebhookCleanupOperation = 'disable_auto_sync' | 'disconnect';
export type GitWebhookCleanupStatus = 'pending' | 'succeeded' | 'failed';

export interface IGitWebhookCleanupJob {
  _id: string;
  tenantId: string;
  projectId: string;
  provider: 'github' | 'gitlab' | 'bitbucket' | 'generic';
  repositoryUrl: string;
  authProfileId: string;
  webhookId: string;
  operation: GitWebhookCleanupOperation;
  status: GitWebhookCleanupStatus;
  attempts: number;
  lastError: string | null;
  nextAttemptAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

const GitWebhookCleanupJobSchema = new Schema<IGitWebhookCleanupJob>(
  {
    _id: { type: String, default: uuidv7 },
    tenantId: { type: String, required: true },
    projectId: { type: String, required: true },
    provider: { type: String, enum: ['github', 'gitlab', 'bitbucket', 'generic'], required: true },
    repositoryUrl: { type: String, required: true },
    authProfileId: { type: String, required: true },
    webhookId: { type: String, required: true },
    operation: {
      type: String,
      enum: ['disable_auto_sync', 'disconnect'],
      required: true,
    },
    status: { type: String, enum: ['pending', 'succeeded', 'failed'], default: 'pending' },
    attempts: { type: Number, default: 0 },
    lastError: { type: String, default: null },
    nextAttemptAt: { type: Date, default: () => new Date() },
  },
  { timestamps: true, collection: 'git_webhook_cleanup_jobs' },
);

GitWebhookCleanupJobSchema.index({ tenantId: 1, status: 1, nextAttemptAt: 1 });
GitWebhookCleanupJobSchema.index({ tenantId: 1, projectId: 1 });
GitWebhookCleanupJobSchema.index({ tenantId: 1, webhookId: 1, status: 1 });

GitWebhookCleanupJobSchema.plugin(tenantIsolationPlugin);

export const GitWebhookCleanupJob =
  (mongoose.models.GitWebhookCleanupJob as any) ||
  model<IGitWebhookCleanupJob>('GitWebhookCleanupJob', GitWebhookCleanupJobSchema);
