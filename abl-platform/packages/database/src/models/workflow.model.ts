/**
 * Workflow Model
 *
 * Stores node-based workflow definitions in the ABL Platform.
 * Each workflow belongs to a project and tenant, defining a directed graph
 * of nodes and edges for visual workflow automation.
 */

import mongoose, { Schema, model } from 'mongoose';
import { uuidv7 } from '../mongo/base-document.js';
import { tenantIsolationPlugin } from '../mongo/plugins/tenant-isolation.plugin.js';

// ─── Constants ──────────────────────────────────────────────────────────

export const WORKFLOW_NODE_TYPES = [
  'start',
  'end',
  'condition',
  'loop',
  'delay',
  'text_to_text',
  'text_to_image',
  'audio_to_text',
  'image_to_text',
  'api',
  'function',
  'integration',
  'browser',
  'doc_search',
  'doc_intelligence',
  'human',
  'agentic_app',
  'agent',
  'tool',
  'data_entry',
] as const;

export type WorkflowNodeType = (typeof WORKFLOW_NODE_TYPES)[number];

export const WORKFLOW_STATUSES = ['draft', 'active', 'paused', 'archived'] as const;
export type WorkflowStatus = (typeof WORKFLOW_STATUSES)[number];

export const WORKFLOW_TYPES = ['cx_automation', 'ex_automation', 'internal'] as const;
export type WorkflowType = (typeof WORKFLOW_TYPES)[number];

export const WORKFLOW_DEPLOYMENT_MODES = ['sync', 'async_poll', 'async_push'] as const;
export type WorkflowDeploymentMode = (typeof WORKFLOW_DEPLOYMENT_MODES)[number];

// ─── Nested Interfaces ──────────────────────────────────────────────────

export interface IWorkflowNodePosition {
  x: number;
  y: number;
}

export interface IWorkflowNode {
  id: string;
  nodeType: WorkflowNodeType;
  name: string;
  position: IWorkflowNodePosition;
  config: Record<string, unknown>;
}

export interface IWorkflowEdge {
  id: string;
  source: string;
  sourceHandle: string;
  target: string;
  label?: string;
}

export interface IAsyncPushConfig {
  webhookUrl: string;
  // Note: the deployment-time bearer token used to be stored here as a
  // plaintext String. It was never wired (no writer or reader in production
  // code), so the field has been removed rather than migrated. If push-mode
  // deployments need per-workflow outbound auth in future, route it through
  // the same encrypted-blob pattern used for `triggerMetadata.encryptedAccessToken`
  // on `WorkflowExecution` — see `apps/workflow-engine/src/routes/workflow-executions.ts`.
}

export interface IWorkflowDeployment {
  endpointSlug: string;
  mode: WorkflowDeploymentMode;
  asyncPushConfig?: IAsyncPushConfig;
  timeout: number;
  deployedAt: Date;
  deployedBy: string;
  deployedVersion: number;
}

// ─── Document Interface ──────────────────────────────────────────────────

export interface IWorkflow {
  _id: string;
  tenantId: string;
  projectId: string;
  name: string;
  type: WorkflowType;
  description: string | null;
  entryAgent: string | null;
  nodes: IWorkflowNode[];
  edges: IWorkflowEdge[];
  envVars: Record<string, string>;
  inputSchema: Record<string, unknown> | null;
  outputSchema: Record<string, unknown> | null;
  status: WorkflowStatus;
  deployment?: IWorkflowDeployment;
  metadata: Record<string, unknown> | null;
  triggers?: Array<{ id: string; type: string; config: Record<string, unknown>; status: string }>;
  steps: unknown[];
  slaMinutes: number | null;
  escalationRules: unknown[];
  notificationRules: unknown[];
  archivedAt: Date | null;
  deleted: boolean;
  deletedAt: Date | null;
  tags: string[];
  createdBy: string;
  _v: number;
  createdAt: Date;
  updatedAt: Date;
}

// ─── Sub-Schemas ────────────────────────────────────────────────────────

const WorkflowNodePositionSchema = new Schema<IWorkflowNodePosition>(
  {
    x: { type: Number, required: true },
    y: { type: Number, required: true },
  },
  { _id: false },
);

const WorkflowNodeSchema = new Schema<IWorkflowNode>(
  {
    id: { type: String, required: true },
    nodeType: {
      type: String,
      required: true,
      enum: WORKFLOW_NODE_TYPES,
    },
    name: { type: String, required: true },
    position: { type: WorkflowNodePositionSchema, required: true },
    config: { type: Schema.Types.Mixed, default: {} },
  },
  { _id: false },
);

const WorkflowEdgeSchema = new Schema<IWorkflowEdge>(
  {
    id: { type: String, required: true },
    source: { type: String, required: true },
    sourceHandle: { type: String, required: true, default: 'default' },
    target: { type: String, required: true },
    label: { type: String },
  },
  { _id: false },
);

const AsyncPushConfigSchema = new Schema<IAsyncPushConfig>(
  {
    webhookUrl: { type: String, required: true },
  },
  { _id: false },
);

const WorkflowDeploymentSchema = new Schema<IWorkflowDeployment>(
  {
    endpointSlug: { type: String, required: true },
    mode: {
      type: String,
      required: true,
      enum: WORKFLOW_DEPLOYMENT_MODES,
    },
    asyncPushConfig: { type: AsyncPushConfigSchema },
    timeout: { type: Number, required: true },
    deployedAt: { type: Date, required: true },
    deployedBy: { type: String, required: true },
    deployedVersion: { type: Number, required: true },
  },
  { _id: false },
);

// ─── Schema ──────────────────────────────────────────────────────────────

const WorkflowSchema = new Schema<IWorkflow>(
  {
    _id: { type: String, default: uuidv7 },
    tenantId: { type: String, required: true },
    projectId: { type: String, required: true },
    name: { type: String, required: true },
    type: {
      type: String,
      required: true,
      enum: WORKFLOW_TYPES,
      default: 'cx_automation',
    },
    description: { type: String, default: null },
    entryAgent: { type: String, default: null },
    nodes: { type: [WorkflowNodeSchema], default: [] },
    edges: { type: [WorkflowEdgeSchema], default: [] },
    envVars: { type: Schema.Types.Mixed, default: {} },
    inputSchema: { type: Schema.Types.Mixed, default: null },
    outputSchema: { type: Schema.Types.Mixed, default: null },
    status: {
      type: String,
      required: true,
      enum: WORKFLOW_STATUSES,
      default: 'draft',
    },
    deployment: { type: WorkflowDeploymentSchema },
    metadata: { type: Schema.Types.Mixed, default: null },
    triggers: {
      type: [
        new Schema(
          { id: String, type: String, config: Schema.Types.Mixed, status: String },
          { _id: false },
        ),
      ],
      default: [],
    },
    steps: { type: [Schema.Types.Mixed], default: [] },
    slaMinutes: { type: Number, default: null },
    escalationRules: { type: [Schema.Types.Mixed], default: [] },
    notificationRules: { type: [Schema.Types.Mixed], default: [] },
    archivedAt: { type: Date, default: null },
    deleted: { type: Boolean, default: false },
    deletedAt: { type: Date, default: null },
    tags: { type: [String], default: [] },
    createdBy: { type: String, default: '' },
    _v: { type: Number, default: 1 },
  },
  { timestamps: true, collection: 'workflows' },
);

// ─── Plugins ─────────────────────────────────────────────────────────────

WorkflowSchema.plugin(tenantIsolationPlugin);

// ─── Indexes ─────────────────────────────────────────────────────────────

WorkflowSchema.index(
  { tenantId: 1, projectId: 1, name: 1 },
  {
    name: 'tenantId_1_projectId_1_name_1_active',
    unique: true,
    partialFilterExpression: { deleted: false },
  },
);
WorkflowSchema.index({ tenantId: 1, projectId: 1, status: 1 });
WorkflowSchema.index(
  { tenantId: 1, 'deployment.endpointSlug': 1 },
  {
    unique: true,
    partialFilterExpression: { 'deployment.endpointSlug': { $exists: true, $type: 'string' } },
  },
);
WorkflowSchema.index({ tenantId: 1, projectId: 1, deleted: 1 });

// ─── Model ───────────────────────────────────────────────────────────────

export const Workflow =
  (mongoose.models.Workflow as any) || model<IWorkflow>('Workflow', WorkflowSchema);
