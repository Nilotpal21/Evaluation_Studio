/**
 * Project Agent Assist Settings Model
 *
 * Stores the project-level enable/disable flag for the Agent Assist
 * compatibility facade. When enabled=false, the runtime facade returns
 * 404 for this project regardless of tenant-level feature grants.
 *
 * One document per (tenantId, projectId).
 */

import mongoose, { Schema, model } from 'mongoose';
import { uuidv7 } from '../mongo/base-document.js';
import { tenantIsolationPlugin } from '../mongo/plugins/tenant-isolation.plugin.js';
import { auditTrailPlugin } from '../mongo/plugins/audit-trail.plugin.js';

// ─── Document Interface ─────────────────────────────────────────────────

export interface IProjectAgentAssistSettings {
  _id: string;
  tenantId: string;
  projectId: string;
  enabled: boolean;
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
}

// ─── Schema ─────────────────────────────────────────────────────────────

const ProjectAgentAssistSettingsSchema = new Schema<IProjectAgentAssistSettings>(
  {
    _id: { type: String, default: uuidv7 },
    tenantId: { type: String, required: true },
    projectId: { type: String, required: true },
    enabled: { type: Boolean, required: true, default: false },
    createdBy: { type: String, required: true, immutable: true },
  },
  { timestamps: true, collection: 'project_agent_assist_settings' },
);

// ─── Plugins ────────────────────────────────────────────────────────────

ProjectAgentAssistSettingsSchema.plugin(tenantIsolationPlugin);
ProjectAgentAssistSettingsSchema.plugin(auditTrailPlugin);

// ─── Indexes ────────────────────────────────────────────────────────────

ProjectAgentAssistSettingsSchema.index({ tenantId: 1, projectId: 1 }, { unique: true });

// ─── Model ──────────────────────────────────────────────────────────────

export const ProjectAgentAssistSettings =
  (mongoose.models.ProjectAgentAssistSettings as any) ||
  model<IProjectAgentAssistSettings>(
    'ProjectAgentAssistSettings',
    ProjectAgentAssistSettingsSchema,
  );
