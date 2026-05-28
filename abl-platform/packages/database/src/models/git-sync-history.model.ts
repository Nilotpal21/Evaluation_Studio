/**
 * Git Sync History Model
 *
 * Records each push/pull sync operation between the platform and a git repository.
 */

import mongoose, { Schema, model } from 'mongoose';
import { uuidv7 } from '../mongo/base-document.js';
import { tenantIsolationPlugin } from '../mongo/plugins/tenant-isolation.plugin.js';

// ─── Document Interface ──────────────────────────────────────────────────

export interface IChangesSummary {
  added: string[];
  modified: string[];
  deleted: string[];
}

export interface IConflictDetail {
  agentName: string;
  file: string;
  resolved: boolean;
  resolution: 'local' | 'remote' | 'merged' | null;
}

export interface IGitSyncHistory {
  _id: string;
  projectId: string;
  tenantId: string;
  direction: 'push' | 'pull';
  commitSha: string | null;
  branch: string;
  status: 'success' | 'failed' | 'conflict';
  agentsAffected: string[];
  changesSummary: IChangesSummary;
  conflictDetails: IConflictDetail[];
  triggeredBy: string;
  error: string | null;
  _v: number;
  createdAt: Date;
  updatedAt: Date;
}

// ─── Schema ──────────────────────────────────────────────────────────────

const ChangesSummarySchema = new Schema<IChangesSummary>(
  {
    added: { type: [String], default: [] },
    modified: { type: [String], default: [] },
    deleted: { type: [String], default: [] },
  },
  { _id: false },
);

const ConflictDetailSchema = new Schema<IConflictDetail>(
  {
    agentName: { type: String, required: true },
    file: { type: String, required: true },
    resolved: { type: Boolean, default: false },
    resolution: { type: String, enum: ['local', 'remote', 'merged', null], default: null },
  },
  { _id: false },
);

const GitSyncHistorySchema = new Schema<IGitSyncHistory>(
  {
    _id: { type: String, default: uuidv7 },
    projectId: { type: String, required: true },
    tenantId: { type: String, required: true },
    direction: { type: String, enum: ['push', 'pull'], required: true },
    commitSha: { type: String, default: null },
    branch: { type: String, required: true },
    status: { type: String, enum: ['success', 'failed', 'conflict'], required: true },
    agentsAffected: { type: [String], default: [] },
    changesSummary: {
      type: ChangesSummarySchema,
      default: () => ({ added: [], modified: [], deleted: [] }),
    },
    conflictDetails: { type: [ConflictDetailSchema], default: [] },
    triggeredBy: { type: String, required: true },
    error: { type: String, default: null },
    _v: { type: Number, default: 1 },
  },
  { timestamps: true, collection: 'git_sync_history' },
);

// ─── Plugins ─────────────────────────────────────────────────────────────

GitSyncHistorySchema.plugin(tenantIsolationPlugin);

// ─── Indexes ─────────────────────────────────────────────────────────────

GitSyncHistorySchema.index({ projectId: 1, tenantId: 1, createdAt: -1 });
GitSyncHistorySchema.index({ projectId: 1, tenantId: 1, status: 1 });

// ─── Model ───────────────────────────────────────────────────────────────

export const GitSyncHistory =
  (mongoose.models.GitSyncHistory as any) ||
  model<IGitSyncHistory>('GitSyncHistory', GitSyncHistorySchema);
