/**
 * Project Settings Version Model
 *
 * Stores versioned snapshots of project execution settings.
 * Tracks version lifecycle: draft -> testing -> staged -> active -> deprecated.
 */

import mongoose, { Schema, model } from 'mongoose';
import { uuidv7 } from '../mongo/base-document.js';
import { tenantIsolationPlugin } from '../mongo/plugins/tenant-isolation.plugin.js';
import type { IProjectMemorySettings } from './project-settings.model.js';

// ─── Document Interfaces ─────────────────────────────────────────────────

export interface IProjectSettingsVersionSettings {
  enableThinking: boolean;
  thinkingBudget: number | null;
  thoughtDescription: string | null;
  compactionThreshold?: number | null;
  promptOverrides?: Record<string, unknown>;
  memory?: IProjectMemorySettings | null;
}

export interface IProjectSettingsVersion {
  _id: string;
  tenantId: string;
  projectId: string;
  version: string;
  status: 'draft' | 'testing' | 'staged' | 'active' | 'deprecated';
  settings: IProjectSettingsVersionSettings;
  sourceHash: string;
  changelog: string | null;
  createdBy: string;
  promotedAt: Date | null;
  promotedBy: string | null;
  _v: number;
  createdAt: Date;
  updatedAt: Date;
}

// ─── Schema ──────────────────────────────────────────────────────────────

const ProjectSettingsVersionSchema = new Schema<IProjectSettingsVersion>(
  {
    _id: { type: String, default: uuidv7 },
    tenantId: { type: String, required: true },
    projectId: { type: String, required: true },
    version: { type: String, required: true },
    status: {
      type: String,
      required: true,
      enum: ['draft', 'testing', 'staged', 'active', 'deprecated'],
    },
    settings: {
      type: new Schema(
        {
          enableThinking: { type: Boolean, required: true },
          thinkingBudget: { type: Number, default: null },
          thoughtDescription: { type: String, default: null },
          compactionThreshold: { type: Number, default: null },
          promptOverrides: { type: Schema.Types.Mixed, default: undefined },
          memory: { type: Schema.Types.Mixed, default: null },
        },
        { _id: false },
      ),
      required: true,
    },
    sourceHash: { type: String, required: true },
    changelog: { type: String, default: null },
    createdBy: { type: String, required: true },
    promotedAt: { type: Date, default: null },
    promotedBy: { type: String, default: null },
    _v: { type: Number, default: 1 },
  },
  { timestamps: true, collection: 'project_settings_versions' },
);

// ─── Plugins ─────────────────────────────────────────────────────────────

ProjectSettingsVersionSchema.plugin(tenantIsolationPlugin);

// ─── Indexes ─────────────────────────────────────────────────────────────

ProjectSettingsVersionSchema.index({ tenantId: 1, projectId: 1, version: 1 }, { unique: true });
ProjectSettingsVersionSchema.index({ tenantId: 1, projectId: 1, createdAt: -1 });
ProjectSettingsVersionSchema.index({ tenantId: 1, projectId: 1, status: 1 });

// ─── Model ───────────────────────────────────────────────────────────────

export const ProjectSettingsVersion =
  (mongoose.models.ProjectSettingsVersion as any) ||
  model<IProjectSettingsVersion>('ProjectSettingsVersion', ProjectSettingsVersionSchema);
