/**
 * HumanTask Model
 *
 * Unified human-in-the-loop task collection. Supports workflow approvals,
 * data entry forms, reviews, multi-choice decisions, and agent escalations.
 *
 * Each task has a discriminated `source` field linking back to the originating
 * system (workflow step, agent session, etc.) and a `fields` array defining
 * the form schema for data collection.
 */

import mongoose, { Schema, model } from 'mongoose';
import { uuidv7 } from '../mongo/base-document.js';
import { tenantIsolationPlugin } from '../mongo/plugins/tenant-isolation.plugin.js';

// ─── Field Definition ───────────────────────────────────────────────

export interface ISelectOption {
  label: string;
  value: string;
}

export interface IHumanTaskFieldDef {
  name: string;
  type: 'text' | 'number' | 'boolean' | 'select' | 'textarea' | 'date';
  label: string;
  required: boolean;
  options?: (string | ISelectOption)[];
  validation?: Record<string, unknown>;
  defaultValue?: unknown;
}

// ─── Source Discriminated Union ──────────────────────────────────────

export interface IWorkflowApprovalSource {
  type: 'workflow_approval';
  workflowId: string;
  executionId: string;
  stepId: string;
}

export interface IWorkflowHumanTaskSource {
  type: 'workflow_human_task';
  workflowId: string;
  executionId: string;
  stepId: string;
}

export interface IAgentEscalationSource {
  type: 'agent_escalation';
  sessionId: string;
  agentName: string;
}

export type IHumanTaskSource =
  | IWorkflowApprovalSource
  | IWorkflowHumanTaskSource
  | IAgentEscalationSource;

// ─── Response ───────────────────────────────────────────────────────

export interface IHumanTaskResponse {
  respondedBy: string;
  respondedAt: Date;
  fields: Record<string, unknown>;
  notes?: string;
  decision?: string;
}

// ─── Document Interface ─────────────────────────────────────────────

export type HumanTaskType = 'approval' | 'data_entry' | 'review' | 'decision' | 'escalation';
export type HumanTaskMailbox = 'workflow' | 'agent';
export type HumanTaskStatus =
  | 'pending'
  | 'assigned'
  | 'in_progress'
  | 'completed'
  | 'expired'
  | 'cancelled';
export type HumanTaskPriority = 'low' | 'medium' | 'high' | 'critical';

export interface IHumanTask {
  _id: string;
  tenantId: string;
  projectId: string;
  type: HumanTaskType;
  mailbox: HumanTaskMailbox;
  status: HumanTaskStatus;
  priority: HumanTaskPriority;
  title: string;
  description?: string;
  source: IHumanTaskSource;
  /**
   * Users allowed to act on this task.
   * - `undefined` / `[]` → open pool: any project member can claim.
   * - `[u]`              → direct assignment: only `u` sees it, no claim needed.
   * - `[u1, u2, ...]`    → scoped pool: only those N see it, first-claim-wins.
   * Admin/owner always sees every task regardless of this field.
   */
  assignedTo?: string[];
  assignedToTeam?: string;
  claimedBy?: string;
  claimedAt?: Date;
  fields: IHumanTaskFieldDef[];
  context: Record<string, unknown>;
  response?: IHumanTaskResponse;
  dueAt?: Date;
  /**
   * Routing behavior when `dueAt` elapses without human response.
   * - `terminate` (default): workflow fails with a timeout error.
   * - `skip`: workflow continues on the normal path as if the task completed.
   * Populated from the step config at task creation time so the inbox UI
   * can show the human assignee what will happen if they miss the window.
   */
  onTimeout?: 'terminate' | 'skip';
  slaBreachedAt?: Date;
  escalationChain: string[];
  currentEscalationLevel: number;
  /** ITSM connector ticket ID (set after connector action creates a ticket) */
  connectorTicketId?: string;
  /** ITSM connector ticket URL (set after connector action creates a ticket) */
  connectorTicketUrl?: string;
  /** Connector action name used to create the ITSM ticket */
  connectorActionName?: string;
  /**
   * TTL timestamp — MongoDB auto-deletes the document after this time.
   *
   * Set by the terminal-status write path **only when** `mailbox === 'workflow'`
   * AND `status ∈ {completed, expired, cancelled}` AND `WORKFLOW_MONGO_TTL_ENABLED=true`.
   * Agent/escalation/other mailboxes stay `null` and are untouched by TTL
   * (HLD §5 scope constraint — non-workflow mailboxes are out of scope for
   * this event-sourcing pipeline).
   */
  expiresAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

// ─── Schemas ────────────────────────────────────────────────────────

const SelectOptionSchema = new Schema(
  {
    label: { type: String, required: true },
    value: { type: String, required: true },
  },
  { _id: false },
);

const FieldDefSchema = new Schema(
  {
    name: { type: String, required: true },
    type: {
      type: String,
      required: true,
      enum: ['text', 'number', 'boolean', 'select', 'textarea', 'date'],
    },
    label: { type: String, required: true },
    required: { type: Boolean, default: false },
    options: { type: [Schema.Types.Mixed], default: undefined },
    validation: { type: Schema.Types.Mixed },
    defaultValue: { type: Schema.Types.Mixed },
  },
  { _id: false },
);

const ResponseSchema = new Schema(
  {
    respondedBy: { type: String, required: true },
    respondedAt: { type: Date, required: true },
    fields: { type: Schema.Types.Mixed, default: {} },
    notes: { type: String },
    decision: { type: String },
  },
  { _id: false },
);

const SourceSchema = new Schema(
  {
    type: {
      type: String,
      required: true,
      enum: ['workflow_approval', 'workflow_human_task', 'agent_escalation'],
    },
    workflowId: { type: String },
    executionId: { type: String },
    stepId: { type: String },
    sessionId: { type: String },
    agentName: { type: String },
  },
  { _id: false },
);

const HumanTaskSchema = new Schema(
  {
    _id: { type: String, default: uuidv7 },
    tenantId: { type: String, required: true, index: true },
    projectId: { type: String, required: true, index: true },
    type: {
      type: String,
      required: true,
      enum: ['approval', 'data_entry', 'review', 'decision', 'escalation'],
    },
    mailbox: {
      type: String,
      required: true,
      enum: ['workflow', 'agent'],
    },
    status: {
      type: String,
      required: true,
      default: 'pending',
      enum: ['pending', 'assigned', 'in_progress', 'completed', 'expired', 'cancelled'],
    },
    priority: {
      type: String,
      required: true,
      default: 'medium',
      enum: ['low', 'medium', 'high', 'critical'],
    },
    title: { type: String, required: true },
    description: { type: String },
    source: { type: SourceSchema, required: true },
    // Array of user IDs. Empty/absent = open pool. Length 1 = direct. Length 2+ = scoped pool.
    assignedTo: { type: [String], default: undefined },
    assignedToTeam: { type: String },
    claimedBy: { type: String },
    claimedAt: { type: Date },
    fields: { type: [FieldDefSchema], default: [] },
    context: { type: Schema.Types.Mixed, default: {} },
    response: { type: ResponseSchema },
    dueAt: { type: Date },
    onTimeout: { type: String, enum: ['terminate', 'skip'] },
    slaBreachedAt: { type: Date },
    escalationChain: { type: [String], default: [] },
    currentEscalationLevel: { type: Number, default: 0 },
    connectorTicketId: { type: String },
    connectorTicketUrl: { type: String },
    connectorActionName: { type: String },
    expiresAt: { type: Date, default: null },
  },
  {
    timestamps: true,
    collection: 'human_tasks',
  },
);

// ─── Indexes ────────────────────────────────────────────────────────

// Derive mailbox from source.type when not explicitly set (safety net for legacy documents)
HumanTaskSchema.pre('validate', function () {
  if (!this.mailbox && this.source?.type) {
    this.mailbox = this.source.type === 'agent_escalation' ? 'agent' : 'workflow';
  }
});

HumanTaskSchema.index({ tenantId: 1, projectId: 1, mailbox: 1, status: 1, createdAt: -1 });
HumanTaskSchema.index({ 'source.type': 1, 'source.executionId': 1, 'source.stepId': 1 });
HumanTaskSchema.index({ status: 1, dueAt: 1 });
HumanTaskSchema.index({ 'source.sessionId': 1, tenantId: 1 });

// TTL partial-filter index (LLD §6.2, HLD §5 scope).
//
// The caller-side writer pins `expiresAt` only on `mailbox === 'workflow'`
// + terminal-status transitions, so the partial filter `expiresAt $type date`
// is sufficient — agent/escalation mailboxes never get a value and are
// therefore never TTL-expired by this index.
//
// Gated on `WORKFLOW_MONGO_TTL_ENABLED=true` so index creation itself is
// flag-conditional — matches the LLD directive that the index only exists
// when the feature flag is on.
if (process.env.WORKFLOW_MONGO_TTL_ENABLED === 'true') {
  HumanTaskSchema.index(
    { expiresAt: 1 },
    {
      expireAfterSeconds: 0,
      partialFilterExpression: { expiresAt: { $type: 'date' } },
    },
  );
}

// ─── Plugin ─────────────────────────────────────────────────────────

HumanTaskSchema.plugin(tenantIsolationPlugin);

// ─── Model ──────────────────────────────────────────────────────────

export const HumanTask =
  (mongoose.models.HumanTask as mongoose.Model<IHumanTask>) ||
  model<IHumanTask>('HumanTask', HumanTaskSchema);
