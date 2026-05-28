/**
 * WorkflowExecution Model
 *
 * Tracks workflow execution status in MongoDB for API queries,
 * observability dashboards, and audit trail. Restate handles
 * durable execution; this model provides queryable state snapshots.
 */

import mongoose, { Schema, model } from 'mongoose';
import { uuidv7 } from '../mongo/base-document.js';
import { tenantIsolationPlugin } from '../mongo/plugins/tenant-isolation.plugin.js';

// ─── Constants ──────────────────────────────────────────────────────

export const EXECUTION_STATUSES = [
  'running',
  'waiting_human',
  'completed',
  'failed',
  'cancelled',
  'rejected',
  'waiting_approval',
  'waiting_callback',
] as const;
export type ExecutionStatus = (typeof EXECUTION_STATUSES)[number];

/** Mirrors TRIGGER_TYPES in @agent-platform/shared/types/workflow-schemas */
export const TRIGGER_TYPES = ['webhook', 'cron', 'event', 'studio', 'agent'] as const;
export type TriggerType = (typeof TRIGGER_TYPES)[number];

/** Mirrors WEBHOOK_MODES in @agent-platform/shared/types/workflow-schemas */
export const WEBHOOK_MODES = ['sync', 'async'] as const;
export type WebhookMode = (typeof WEBHOOK_MODES)[number];

/** Mirrors WEBHOOK_DELIVERIES in @agent-platform/shared/types/workflow-schemas */
export const WEBHOOK_DELIVERIES = ['poll', 'push'] as const;
export type WebhookDelivery = (typeof WEBHOOK_DELIVERIES)[number];

// ─── Document Interface ─────────────────────────────────────────────

export interface IWorkflowExecution {
  _id: string;
  tenantId: string;
  projectId: string;
  workflowId: string;
  workflowVersionId?: string;
  workflowVersion?: string;
  status: ExecutionStatus;
  triggerType: TriggerType;
  webhookMode?: WebhookMode;
  webhookDelivery?: WebhookDelivery;
  callbackUrl?: string;
  input: unknown;
  output?: unknown;
  context: Record<string, unknown>;
  restateWorkflowId?: string;
  startTime?: string;
  endTime?: string;
  startedAt: Date;
  completedAt?: Date;
  cancelledAt?: Date;
  error?: { code: string; message: string };
  triggerMetadata?: Record<string, unknown>;
  durationMs?: number;
  /**
   * TTL timestamp — MongoDB auto-deletes the document after this time.
   *
   * Written only by the terminal-status transition path (completed /
   * failed / cancelled) when `WORKFLOW_MONGO_TTL_ENABLED=true`. Stays
   * `null` for in-flight rows so the partial-filter TTL index never
   * expires a running execution. See LLD §6.1 + HLD §4 concern #6.
   */
  expiresAt: Date | null;
  /**
   * Relay-race execution model fields (Phase 1 — additive, relay-race refactor).
   *
   * inputSnapshot — full WorkflowExecutionInput stored at workflow start so
   * every relay leg can reconstruct the DAG without relying on Restate's
   * journal. Absent on executions created before the relay-race deploy (those
   * use the legacy awakeable path via awakeableId on step records).
   *
   * runCounter — monotonically increasing sequence counter incremented
   * atomically on every step-status publish. Studio client uses this to
   * re-order WebSocket events that arrive out-of-sequence across runs.
   */
  inputSnapshot?: unknown;
  runCounter?: number;
  /** Set when a step parks waiting for human approval/input; prevents stuck-execution sweeper from terminating the run. */
  hasHumanWait?: boolean;
  createdAt: Date;
  updatedAt: Date;
}

// ─── Main Schema ────────────────────────────────────────────────────

const WorkflowExecutionSchema = new Schema<IWorkflowExecution>(
  {
    _id: { type: String, default: uuidv7 },
    tenantId: { type: String, required: true },
    projectId: { type: String, required: true },
    workflowId: { type: String, required: true },
    workflowVersionId: { type: String },
    workflowVersion: { type: String },
    status: {
      type: String,
      required: true,
      enum: EXECUTION_STATUSES,
      default: 'running',
    },
    triggerType: {
      type: String,
      required: true,
      enum: [...TRIGGER_TYPES],
    },
    webhookMode: {
      type: String,
      enum: [...WEBHOOK_MODES],
    },
    webhookDelivery: {
      type: String,
      enum: [...WEBHOOK_DELIVERIES],
    },
    callbackUrl: { type: String },
    // Note: the async-push bearer token is carried as an encrypted blob inside
    // `triggerMetadata.encryptedAccessToken` (written by the /execute route
    // and decrypted by the callback-delivery worker immediately before the
    // Bearer header is built). Never persist the plaintext token here.
    input: { type: Schema.Types.Mixed, default: {} },
    output: { type: Schema.Types.Mixed },
    context: { type: Schema.Types.Mixed, default: {} },
    hasHumanWait: { type: Boolean },
    restateWorkflowId: { type: String },
    startTime: { type: String },
    endTime: { type: String },
    startedAt: { type: Date, required: true },
    completedAt: { type: Date },
    cancelledAt: { type: Date },
    error: {
      type: new Schema(
        {
          code: { type: String, required: true },
          message: { type: String, required: true },
        },
        { _id: false },
      ),
    },
    triggerMetadata: { type: Schema.Types.Mixed, default: {} },
    durationMs: { type: Number },
    expiresAt: { type: Date, default: null },
    inputSnapshot: { type: Schema.Types.Mixed },
    runCounter: { type: Number, default: 0 },
  },
  { timestamps: true, collection: 'workflow_executions' },
);

// ─── Plugins ────────────────────────────────────────────────────────

WorkflowExecutionSchema.plugin(tenantIsolationPlugin);

// ─── Indexes ────────────────────────────────────────────────────────

WorkflowExecutionSchema.index(
  { tenantId: 1, restateWorkflowId: 1 },
  { unique: true, sparse: true },
);
WorkflowExecutionSchema.index({ tenantId: 1, workflowId: 1, status: 1 });
WorkflowExecutionSchema.index({
  tenantId: 1,
  projectId: 1,
  startedAt: -1,
});
// Used for stale execution cleanup — tenantId prefix for tenant-scoped queries
WorkflowExecutionSchema.index({ tenantId: 1, status: 1, startedAt: 1 });

// Stuck-execution sweeper query (P-2 / P-7):
//   { status: 'running', startedAt: { $lt: cutoff }, hasHumanWait: { $ne: true } }
// hasHumanWait is set by parkStep for approval/human-task steps and cleared on
// resolution. Sparse partial filter keeps the index small (only running docs).
WorkflowExecutionSchema.index(
  { status: 1, startedAt: 1, hasHumanWait: 1 },
  { partialFilterExpression: { status: 'running' } },
);

// TTL partial-filter index (LLD §6.1, HLD §4 concern #6).
//
// Only rows with a non-null `expiresAt` are considered by the partial
// filter, which means in-flight executions (`expiresAt: null`) are never
// eligible for auto-delete even with the index present.
//
// Gated on `WORKFLOW_MONGO_TTL_ENABLED=true` so index creation itself is
// flag-conditional — matches the LLD directive `"ensureIndex only runs
// at startup when WORKFLOW_MONGO_TTL_ENABLED=true"`.
if (process.env.WORKFLOW_MONGO_TTL_ENABLED === 'true') {
  WorkflowExecutionSchema.index(
    { expiresAt: 1 },
    {
      expireAfterSeconds: 0,
      // `$type: 'date'` matches real Date values only — avoids the same
      // `$ne` partial-filter gotcha fixed by Phase 3 commit ff16216e6e
      // on the outbox model (Mongo rejects `$ne` in partial filters).
      partialFilterExpression: { expiresAt: { $type: 'date' } },
    },
  );
}

// ─── Model ──────────────────────────────────────────────────────────

export const WorkflowExecution =
  (mongoose.models.WorkflowExecution as any) ||
  model<IWorkflowExecution>('WorkflowExecution', WorkflowExecutionSchema);
