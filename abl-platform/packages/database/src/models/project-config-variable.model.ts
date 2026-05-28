/**
 * Project Config Variable Model
 *
 * Stores project-level reusable configuration variables (key-value pairs).
 * Values are plaintext (NOT encrypted — use env/secrets for sensitive data).
 * Resolved at compile time via {{config.KEY}} syntax in ABL files.
 * Scoped to a tenant and project.
 */

import mongoose, { Schema, model } from 'mongoose';
import { uuidv7 } from '../mongo/base-document.js';
import { tenantIsolationPlugin } from '../mongo/plugins/tenant-isolation.plugin.js';
import { auditTrailPlugin } from '../mongo/plugins/audit-trail.plugin.js';

// ─── Document Interface ──────────────────────────────────────────────────

export interface IProjectConfigVariable {
  _id: string;
  tenantId: string;
  projectId: string;
  key: string;
  value: string;
  description: string | null;
  createdBy: string;
  updatedBy: string | null;
  _v: number;
  createdAt: Date;
  updatedAt: Date;
}

// ─── Schema ──────────────────────────────────────────────────────────────

const ProjectConfigVariableSchema = new Schema<IProjectConfigVariable>(
  {
    _id: { type: String, default: uuidv7 },
    tenantId: { type: String, required: true },
    projectId: { type: String, required: true },
    key: { type: String, required: true },
    value: { type: String, required: true },
    description: { type: String, default: null },
    createdBy: { type: String, required: true },
    updatedBy: { type: String, default: null },
    _v: { type: Number, default: 1 },
  },
  { timestamps: true, collection: 'project_config_variables' },
);

// ─── Plugins ─────────────────────────────────────────────────────────────

ProjectConfigVariableSchema.plugin(tenantIsolationPlugin);
ProjectConfigVariableSchema.plugin(auditTrailPlugin);

// ─── Indexes ─────────────────────────────────────────────────────────────

ProjectConfigVariableSchema.index({ tenantId: 1, projectId: 1, key: 1 }, { unique: true });
ProjectConfigVariableSchema.index({ tenantId: 1, projectId: 1 });

// ─── Model ───────────────────────────────────────────────────────────────

export const ProjectConfigVariable =
  (mongoose.models.ProjectConfigVariable as any) ||
  model<IProjectConfigVariable>('ProjectConfigVariable', ProjectConfigVariableSchema);
