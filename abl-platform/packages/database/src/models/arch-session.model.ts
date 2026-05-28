/**
 * Arch AI Session Model
 *
 * Stores the full state of an Arch AI session: phase, specification, messages,
 * pending interactions, and lifecycle state. One non-terminal session per
 * (tenantId, userId, mode, projectId, surface, agentNameKey, threadId) at any time.
 *
 * Contract: session-state-machine.md, specification-schema.md, conversation-persistence.md
 */

import mongoose, { Schema, model } from 'mongoose';
import { uuidv7 } from '../mongo/base-document.js';
import { tenantIsolationPlugin } from '../mongo/plugins/tenant-isolation.plugin.js';

const CURRENT_IN_PROJECT_SESSION_CONTRACT_VERSION = 3;
const PROJECT_SESSION_AGENT_KEY = '__project__';
const DEFAULT_SESSION_THREAD_ID = '__default__';

// ─── Document Interface ──────────────────────────────────────────────────

export interface IArchSession {
  _id: string;
  tenantId: string;
  userId: string;
  state: 'IDLE' | 'ACTIVE' | 'GATE_PENDING' | 'COMPLETE' | 'ARCHIVED';
  metadata: {
    phase: 'INTERVIEW' | 'BLUEPRINT' | 'BUILD' | 'CREATE';
    mode: 'ONBOARDING' | 'IN_PROJECT';
    contractVersion?: number;
    surface?: 'project' | 'agent-editor';
    agentName?: string | null;
    agentNameKey?: string;
    threadId?: string;
    specification: Record<string, unknown>;
    pendingInteraction: {
      kind: 'widget' | 'gate';
      id: string;
      payload: unknown;
      createdAt: string;
    } | null;
    messages: Array<{
      id: string;
      role: 'user' | 'assistant';
      content: string;
      timestamp: string;
      specialist?: string;
      toolCalls?: Array<{
        toolCallId: string;
        toolName: string;
        input: Record<string, unknown>;
        result?: unknown;
      }>;
      phase: string;
    }>;
    projectId?: string;
    topology?: Record<string, unknown>;
    blueprintOutput?: Record<string, unknown>;
    topologyApproved?: boolean;
    files?: Record<string, unknown>;
    buildProgress?: {
      stage?: 'generating' | 'agents_complete' | 'complete';
      agentStatuses?: Record<string, string>;
      toolStatuses?: Record<string, string>;
    } | null;
    buildSubPhase?: 'AGENTS' | 'TOOLS' | 'COMPLETE' | null;
    selectedTools?: string[] | null;
    toolDsls?: Record<string, string>;
    /**
     * Agents the user has explicitly approved via agent_review gate.
     * Used by the parallel-generation gate queue to decide which agent
     * to review next, and preserved across BUILD↔BLUEPRINT backtracking
     * so already-approved work is never regenerated.
     */
    approvedAgents?: string[];
    qualityGateOverridden?: boolean;
    mockServer?: Record<string, unknown>;
    activeSpecialist?: string | null;
    pendingMutation?: Record<string, unknown> | null;
    activeIntegrationDraftId?: string | null;
  };
  /** Tracks when the session was last actively processing (set on ACTIVE transition). */
  lastActiveAt?: Date | null;
  archivedAt: Date | null;
  _v: number;
  createdAt: Date;
  updatedAt: Date;
}

// ─── Schema ──────────────────────────────────────────────────────────────

const StoredToolCallSchema = new Schema(
  {
    toolCallId: { type: String, required: true },
    toolName: { type: String, required: true },
    input: { type: Schema.Types.Mixed, default: {} },
    result: { type: Schema.Types.Mixed, default: null },
  },
  { _id: false },
);

const StoredMessageSchema = new Schema(
  {
    id: { type: String, required: true },
    role: { type: String, required: true, enum: ['user', 'assistant'] },
    content: { type: Schema.Types.Mixed, required: true }, // B03: string | ArchContentBlock[]
    timestamp: { type: String, required: true },
    specialist: { type: String, default: null },
    toolCalls: { type: [StoredToolCallSchema], default: undefined },
    phase: { type: String, required: true },
  },
  { _id: false },
);

const PendingInteractionSchema = new Schema(
  {
    kind: { type: String, required: true, enum: ['widget', 'gate'] },
    id: { type: String, required: true },
    payload: { type: Schema.Types.Mixed, required: true },
    createdAt: { type: String, required: true },
  },
  { _id: false },
);

const ConversationNoteSchema = new Schema(
  {
    icon: { type: String, required: true },
    label: { type: String, required: true },
    detail: { type: String, required: true },
    category: {
      type: String,
      required: true,
      enum: ['compliance', 'integration', 'sla', 'channel', 'escalation', 'general'],
    },
  },
  { _id: false },
);

const FileRefSchema = new Schema(
  {
    name: { type: String, required: true },
    size: { type: Number, required: true },
    type: { type: String, required: true },
    uploadedAt: { type: Date, required: true },
  },
  { _id: false },
);

const SpecificationSubSchema = new Schema(
  {
    version: { type: Number, default: 1 },
    projectName: { type: String, default: '' },
    description: { type: String, default: null },
    channels: { type: [String], default: [] },
    language: { type: String, default: 'English' },
    uploadedFiles: { type: [FileRefSchema], default: [] },
    conversationNotes: { type: [ConversationNoteSchema], default: [] },
  },
  { _id: false },
);

const MetadataSchema = new Schema(
  {
    phase: {
      type: String,
      required: true,
      enum: ['INTERVIEW', 'BLUEPRINT', 'BUILD', 'CREATE'],
    },
    mode: {
      type: String,
      required: true,
      enum: ['ONBOARDING', 'IN_PROJECT'],
    },
    contractVersion: {
      type: Number,
      default: CURRENT_IN_PROJECT_SESSION_CONTRACT_VERSION,
    },
    surface: {
      type: String,
      enum: ['project', 'agent-editor'],
      default: 'project',
    },
    agentName: { type: String, default: null },
    agentNameKey: { type: String, default: PROJECT_SESSION_AGENT_KEY },
    threadId: { type: String, default: DEFAULT_SESSION_THREAD_ID },
    specification: { type: SpecificationSubSchema, required: true },
    pendingInteraction: { type: PendingInteractionSchema, default: null },
    messages: { type: [StoredMessageSchema], default: [] },
    projectId: { type: String, default: null },
    // Slice 2: Blueprint phase data
    topology: { type: Schema.Types.Mixed, default: null },
    blueprintOutput: { type: Schema.Types.Mixed, default: null },
    topologyApproved: { type: Boolean, default: false },
    // Slice 3: Build phase data
    files: { type: Schema.Types.Mixed, default: {} },
    buildProgress: { type: Schema.Types.Mixed, default: null },
    buildSubPhase: {
      type: String,
      enum: ['AGENTS', 'TOOLS', 'COMPLETE'],
      default: null,
    },
    selectedTools: { type: [String], default: null },
    toolDsls: { type: Schema.Types.Mixed, default: {} },
    // Agents the user has approved via agent_review gate. Preserved across
    // BUILD↔BLUEPRINT backtracking so already-reviewed work is not regenerated.
    approvedAgents: { type: [String], default: [] },
    qualityGateOverridden: { type: Boolean, default: false },
    // Mock server artifacts (separate from agent files per review)
    mockServer: { type: Schema.Types.Mixed, default: null },
    activeSpecialist: { type: String, default: null },
    // In-project proposal state: stores the pending modification for user review
    pendingMutation: { type: Schema.Types.Mixed, default: null },
    activeIntegrationDraftId: { type: String, default: null },
    // Expansion points (added by later slices):
    // specVersions: [Mixed]    — Slice 2+, version history
    // reviewStatus: Mixed      — Slice 3, per-agent review state
    // createStatus: Mixed      — Slice 4, project creation state
  },
  { _id: false },
);

const ArchSessionSchema = new Schema<IArchSession>(
  {
    _id: { type: String, default: uuidv7 },
    tenantId: { type: String, required: true },
    userId: { type: String, required: true },
    state: {
      type: String,
      required: true,
      enum: ['IDLE', 'ACTIVE', 'GATE_PENDING', 'COMPLETE', 'ARCHIVED'],
      default: 'IDLE',
    },
    metadata: { type: MetadataSchema, required: true },
    /** Set when session transitions to ACTIVE; used for stuck-session detection. */
    lastActiveAt: { type: Date, default: null },
    archivedAt: { type: Date, default: null },
    _v: { type: Number, default: 1 },
  },
  { timestamps: true, collection: 'arch_sessions' },
);

// ─── Plugins ─────────────────────────────────────────────────────────────

ArchSessionSchema.plugin(tenantIsolationPlugin);

// ─── Indexes ─────────────────────────────────────────────────────────────

// Primary query: getOrCreate — find non-terminal session for the scoped Arch thread.
// Contract 13 (execution-model): "One active session per user per mode per project"
ArchSessionSchema.index(
  {
    tenantId: 1,
    userId: 1,
    'metadata.mode': 1,
    'metadata.projectId': 1,
    'metadata.surface': 1,
    'metadata.agentNameKey': 1,
    'metadata.threadId': 1,
    state: 1,
  },
  { name: 'arch_session_scope_thread_lookup_v1' },
);

// Enforce at most ONE non-terminal session per scoped Arch thread.
// Contract 13 (execution-model): "getOrCreate returns the ACTIVE session for
// (tenantId, userId, mode, projectId)." A user can have separate onboarding,
// project-level, per-agent editor sessions, and multiple hidden threads simultaneously.
// NOTE: Contract 2 (session-state-machine) says "one per tenant per user" without
// mode. Contract 13 is more specific. We follow contract 13.
ArchSessionSchema.index(
  {
    tenantId: 1,
    userId: 1,
    'metadata.mode': 1,
    'metadata.projectId': 1,
    'metadata.surface': 1,
    'metadata.agentNameKey': 1,
    'metadata.threadId': 1,
  },
  {
    unique: true,
    name: 'arch_session_scope_thread_unique_v1',
    partialFilterExpression: {
      state: { $in: ['IDLE', 'ACTIVE', 'GATE_PENDING'] },
    },
  },
);

// 30-day retention for archived sessions.
// S1-F05 req 5: "Archived sessions are retained for 30 days (configurable),
// then eligible for hard delete via a cleanup job."
// TTL index on archivedAt: MongoDB auto-deletes documents 30 days after archival.
// Only affects documents where archivedAt is a Date (non-null).
ArchSessionSchema.index({ archivedAt: 1 }, { expireAfterSeconds: 30 * 24 * 60 * 60 });

// ─── Model ───────────────────────────────────────────────────────────────

export const ArchSession =
  (mongoose.models.ArchSession as mongoose.Model<IArchSession>) ||
  model<IArchSession>('ArchSession', ArchSessionSchema);
