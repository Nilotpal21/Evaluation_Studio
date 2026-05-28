/**
 * Workflow Version Model
 *
 * Stores versioned snapshots of workflow definitions.
 * Each version captures the canvas graph plus any persisted workflow-state
 * fields that affect execution, rollback, or audit history.
 */

import mongoose, { Schema, model } from 'mongoose';
import { uuidv7 } from '../mongo/base-document.js';
import { tenantIsolationPlugin } from '../mongo/plugins/tenant-isolation.plugin.js';

// ─── Nested Interfaces ──────────────────────────────────────────────────

export interface IWorkflowVersionDefinition {
  nodes?: unknown[];
  edges?: unknown[];
  envVars?: Record<string, string>;
  inputSchema?: Record<string, unknown> | null;
  outputSchema?: Record<string, unknown> | null;
  type?: string;
  entryAgent?: string | null;
  steps?: unknown[];
  slaMinutes?: number | null;
  escalationRules?: unknown[];
  notificationRules?: unknown[];
  archivedAt?: Date | null;
  [key: string]: unknown;
}

// ─── Trigger Interface ──────────────────────────────────────────────────

export interface IWorkflowVersionTrigger {
  id: string;
  type: string; // 'cron' | 'webhook' | 'event'
  config: Record<string, unknown>;
}

// ─── Document Interface ──────────────────────────────────────────────────

export type WorkflowVersionState = 'active' | 'inactive';

export interface IWorkflowVersion {
  _id: string;
  tenantId: string;
  projectId: string;
  workflowId: string;
  version: string;
  definition: IWorkflowVersionDefinition;
  sourceHash: string;
  state?: WorkflowVersionState;
  environment: string | null;
  deploymentId: string | null;
  triggers: IWorkflowVersionTrigger[];
  deleted: boolean;
  deletedAt: Date | null;
  changelog: string | null;
  createdBy: string;
  publishedAt: Date | null;
  publishedBy: string | null;
  metadata: Record<string, unknown> | null;
  _v: number;
  createdAt: Date;
  updatedAt: Date;
}

// ─── Sub-Schemas ────────────────────────────────────────────────────────

const WorkflowVersionDefinitionSchema = new Schema<IWorkflowVersionDefinition>(
  {
    nodes: { type: [Schema.Types.Mixed], default: [] },
    edges: { type: [Schema.Types.Mixed], default: [] },
    envVars: { type: Schema.Types.Mixed, default: {} },
    inputSchema: { type: Schema.Types.Mixed, default: null },
    outputSchema: { type: Schema.Types.Mixed, default: null },
  },
  { _id: false, strict: false },
);

const WorkflowVersionTriggerSchema = new Schema<IWorkflowVersionTrigger>(
  {
    id: { type: String, required: true },
    type: { type: String, required: true },
    config: { type: Schema.Types.Mixed, default: {} },
  },
  { _id: false },
);

// ─── Schema ──────────────────────────────────────────────────────────────

const WorkflowVersionSchema = new Schema<IWorkflowVersion>(
  {
    _id: { type: String, default: uuidv7 },
    tenantId: { type: String, required: true },
    projectId: { type: String, required: true },
    workflowId: { type: String, required: true },
    version: { type: String, required: true },
    definition: { type: WorkflowVersionDefinitionSchema, required: true },
    sourceHash: { type: String, required: true },
    state: { type: String, enum: ['active', 'inactive'] },
    environment: { type: String, default: null },
    deploymentId: { type: String, default: null },
    triggers: { type: [WorkflowVersionTriggerSchema], default: [] },
    deleted: { type: Boolean, default: false },
    deletedAt: { type: Date, default: null },
    changelog: { type: String, default: null },
    createdBy: { type: String, required: true },
    publishedAt: { type: Date, default: null },
    publishedBy: { type: String, default: null },
    metadata: { type: Schema.Types.Mixed, default: null },
    _v: { type: Number, default: 1 },
  },
  { timestamps: true, collection: 'workflow_versions' },
);

// ─── Plugins ─────────────────────────────────────────────────────────────

WorkflowVersionSchema.plugin(tenantIsolationPlugin);

// ─── Indexes ─────────────────────────────────────────────────────────────

WorkflowVersionSchema.index(
  { tenantId: 1, projectId: 1, workflowId: 1, version: 1 },
  { unique: true },
);
WorkflowVersionSchema.index({
  tenantId: 1,
  projectId: 1,
  workflowId: 1,
  state: 1,
  deleted: 1,
  publishedAt: -1,
});
WorkflowVersionSchema.index({ tenantId: 1, workflowId: 1, sourceHash: 1 });

// ─── Model ───────────────────────────────────────────────────────────────

export const WorkflowVersion =
  (mongoose.models.WorkflowVersion as any) ||
  model<IWorkflowVersion>('WorkflowVersion', WorkflowVersionSchema);
