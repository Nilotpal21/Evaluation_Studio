/**
 * Session types — Contract: session-state-machine.md, conversation-persistence.md
 */

import type { ARCH_PHASES, ARCH_MODES, SESSION_STATES } from './constants.js';
import type { Specification } from './specification.js';
import type { ArchContentBlock } from './content-blocks.js';
import type { TopologyOutput } from './blueprint.js';
import type { PageContext } from './page-context.js';

export type ArchPhase = (typeof ARCH_PHASES)[number];

export type ArchMode = (typeof ARCH_MODES)[number];

export type SessionState = (typeof SESSION_STATES)[number];

export type BlueprintStage =
  | 'concept_ready'
  | 'draft_generating'
  | 'draft_ready'
  | 'revising'
  | 'topology_locked';

/**
 * BuildProgress — durable build state for resume and UI derivation.
 * Replaces the gate-era fields: buildSubPhase, approvedAgents, selectedTools.
 * Written atomically per-agent/tool via $set during BUILD phase.
 */
export type BuildAgentStatus =
  | 'pending'
  | 'generated'
  | 'parsed'
  | 'validated'
  | 'compiled'
  | 'warning'
  | 'error';
export type BuildToolStatus = 'pending' | 'generated' | 'warning' | 'error';

export interface BuildProgress {
  stage: 'initialized' | 'generating' | 'agents_complete' | 'complete';
  agentStatuses: Record<string, BuildAgentStatus>;
  toolStatuses: Record<string, BuildToolStatus>;
}

/**
 * SessionCheckpoint — snapshot of session state at a phase gate.
 * Stored in SessionMetadata.checkpoints (max 5, sliding window).
 * Used for rollback to prior phase states.
 */
export interface SessionCheckpoint {
  checkpointId: string;
  phase: string;
  trigger: 'phase_transition' | 'build_complete' | 'topology_approved' | 'mutation_applied';
  timestamp: string;
  messageCount: number;
  stateSnapshot: {
    topology?: Record<string, unknown>;
    draftTopology?: Record<string, unknown>;
    lockedTopology?: Record<string, unknown>;
    blueprintOutput?: Record<string, unknown>;
    blueprintStage?: BlueprintStage;
    blueprintContextSummary?: string;
    buildProgress?: BuildProgress;
    files?: Record<string, unknown>;
    topologyApproved?: boolean;
    approvedAgents?: string[];
    specification?: Specification;
  };
}

export interface PendingWidgetPayload extends Record<string, unknown> {
  widgetType?: string;
  question?: string;
  message?: string;
}

/**
 * @deprecated Gate types removed in gate-free onboarding redesign.
 * Kept as type aliases for backward-compat in consumers that haven't migrated.
 */
export interface ToolGenerationEntry {
  name: string;
  usedBy: string[];
}

export interface QualityIssue {
  agent: string;
  issue: string;
}

export interface PendingWidgetInteraction {
  kind: 'widget';
  id: string;
  payload: PendingWidgetPayload;
  createdAt: string;
}

export interface PendingGateInteraction {
  kind: 'gate';
  id: string;
  payload: Record<string, unknown>;
  createdAt: string;
}

/**
 * PendingInteraction — widgets or gates.
 * Widgets keep session ACTIVE; gates transition to GATE_PENDING.
 */
export type PendingInteraction = PendingWidgetInteraction | PendingGateInteraction;

/**
 * A single validation issue (parse-time or compile-time) emitted by the
 * Studio route's validateProjectAgentCode. Shared between the server-side
 * return shape and the client-side ProposalValidation so the types don't drift.
 */
export interface ValidationIssue {
  /** 1-indexed line number in the offending code. Undefined for non-positional errors. */
  line?: number;
  message: string;
  severity: 'error' | 'warning';
  /** Where in the pipeline the issue was detected. Parse errors are position-accurate; compile errors may not be; diagnostics are semantic findings from the diagnostic engine. */
  source?: 'parse' | 'compile' | 'diagnostics';
  /** When an edit to agent A breaks agent B, this carries B's name so the UI can label the error. */
  agent?: string;
  /**
   * Optional IR path to the offending construct, e.g.
   * `coordination.handoffs[to=Booking].context.pass`. Carried straight from
   * `DiagnosticFinding.path` so the LLM (and UI) know which IR location to
   * re-edit when fixing this finding.
   */
  path?: string;
  /**
   * True when this finding was introduced by the proposed edit (post-edit
   * only). False/undefined for pre-existing tolerated findings that were
   * already present in the project before this edit. The diff filter at the
   * call site decides which findings are new; see toDiagnosticValidationIssue
   * in apps/studio/src/lib/arch-ai/tools/in-project-tools.ts.
   */
  introduced?: boolean;
}

export interface PersistedValidation {
  valid: boolean;
  errors: ValidationIssue[];
  warnings: ValidationIssue[];
  hint?: string;
  repairAttempts: number;
}

export interface PendingMutation {
  tool: string;
  target: string;
  scope: 'SMALL' | 'MEDIUM' | 'LARGE';
  /** True when proposing a new agent creation (no existing agent to update). */
  isNew?: boolean;
  before?: unknown;
  after?: unknown;
  /**
   * SHA-256 hex digest of `before` at proposal time. Apply-time concurrency
   * check: re-read the current DB DSL, recompute the hash, and reject with
   * PROPOSAL_STALE if it does not match. Closes the TOCTOU window where a
   * concurrent canvas/sibling-session edit could be silently overwritten by
   * apply. Optional for backward compatibility with sessions persisted before
   * this field was introduced — those continue to apply without the check.
   */
  beforeHash?: string;
  /** Opaque lock reference for the Redis-backed per-agent mutation lock. */
  proposalId?: string;
  changeSummary?: string;
  /**
   * Server-persisted review status. Narrower than the client-side
   * `ProposalReviewStatus` union (apps/studio/src/types/arch.ts): the server
   * only ever stores 'pending' (default when undefined) or 'blocked' (the
   * repair loop exhausted its budget). The other client states — 'applying',
   * 'applied', 'rejected' — are transient UI states the Studio client derives
   * from the apply-modification mutation lifecycle and are never written back
   * to `session.metadata.pendingMutation`. Keep this union narrow so the
   * server model stays the source of truth for durable review state.
   */
  reviewStatus?: 'pending' | 'blocked';
  /** Present only when reviewStatus is 'blocked'. Carries the compiler errors the UI renders. */
  validation?: PersistedValidation;
  /** Server-generated topology/tool impact summary used to explain why a proposal is safe to apply. */
  impact?: unknown;
}

export interface PendingPlanMutation {
  sourceTool: string;
  sourceAction: string;
  targetKind:
    | 'agent_dsl'
    | 'agent_topology'
    | 'project_memory'
    | 'tool_binding'
    | 'project_config'
    | 'integration_config'
    | 'test_or_eval';
  operation: 'create' | 'modify' | 'delete' | 'rename' | 'apply';
  agentName?: string;
  targetId?: string;
  rationale?: string;
}

export interface PendingPlanSectionChange {
  agentName: string;
  construct: string;
  operation: 'create' | 'modify' | 'delete' | 'rename';
  reason: string;
}

export interface PendingPlanReference {
  kind: 'memory' | 'gather_field' | 'tool' | 'agent' | 'cel_var';
  sourceAgent: string;
  targetAgent?: string;
  fieldName?: string;
  toolName?: string;
  variableName?: string;
  detail?: string;
}

export interface PendingPlanDependentsAnalysis {
  summary: string;
  referencesFound: PendingPlanReference[];
}

export interface PendingPlanAlternative {
  option: string;
  rejectedBecause: string;
}

export interface PendingPlanCitation {
  sourceType:
    | 'construct_spec'
    | 'validation_code'
    | 'topology_pattern'
    | 'reference_analysis'
    | 'feasibility_check'
    | 'runtime_context'
    | 'tool_readiness';
  reference: string;
  relevance: string;
}

export interface PendingPlanRisk {
  severity: 'low' | 'medium' | 'high';
  description: string;
  mitigation: string;
}

export interface PendingPlan {
  id: string;
  projectId: string;
  status: 'proposed' | 'approved' | 'refining' | 'cancelled' | 'invalidated';
  title: string;
  summary: string;
  goal: string;
  architecturalPattern: string;
  evidence: string[];
  affectedAgents: string[];
  sectionsToChange: PendingPlanSectionChange[];
  dependentsAnalysis: PendingPlanDependentsAnalysis;
  alternativesConsidered: PendingPlanAlternative[];
  citations: PendingPlanCitation[];
  plannedMutations: PendingPlanMutation[];
  risks: PendingPlanRisk[];
  questionsForUser?: string[];
  validationNotes: string[];
  architectureNotes?: unknown;
  stateFingerprintsAtApproval?: Record<string, string>;
  createdAt: string;
  updatedAt: string;
  approvedAt?: string;
  cancelledAt?: string;
  refinementHistory?: Array<{
    feedback: string;
    timestamp: string;
    previousPlanId?: string;
  }>;
}

export interface StoredMessageMetadata {
  source?: 'deterministic_tool_answer' | 'deterministic_mutation_resolution';
  toolCallId?: string;
  action?: 'applied' | 'rejected';
  targetAgent?: string;
  changeSummary?: string;
  artifactsClosed?: boolean;
  planCleared?: boolean;
  topologyRefreshed?: boolean;
}

/**
 * Persisted message — Contract: conversation-persistence.md
 * Messages are NEVER deleted (needed for resume). The LLM receives
 * only a compacted sliding window; the UI shows full history.
 *
 * B03: content can be string (text-only, backward-compatible) or
 * ArchContentBlock[] (multimodal). All read sites MUST use
 * normalizeContent() for display text extraction.
 */
export interface StoredMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string | ArchContentBlock[];
  timestamp: string;
  specialist?: string;
  toolCalls?: StoredToolCall[];
  messageMetadata?: StoredMessageMetadata;
  phase: string;
}

export interface StoredToolCall {
  toolCallId: string;
  toolName: string;
  input: Record<string, unknown>;
  result?: unknown;
}

export interface HistorySummarySpecSnapshot {
  projectName?: string;
  description?: string;
  channels?: string[];
  language?: string;
}

export interface HistorySummaryCapturedAnswer {
  toolCallId: string;
  toolName: string;
  prompt: string;
  answer: string;
  phase: ArchPhase;
  timestamp: string;
}

export interface HistorySummaryDecision {
  messageId: string;
  summary: string;
  phase: ArchPhase;
  timestamp: string;
}

export interface HistorySummaryToolOutcome {
  messageId: string;
  toolCallId: string;
  toolName: string;
  summary: string;
  phase: ArchPhase;
  timestamp: string;
}

export interface HistorySummaryOpenThread {
  messageId: string;
  summary: string;
  phase: ArchPhase;
  timestamp: string;
}

export interface HistorySummary {
  version: number;
  compactedThroughMessageId: string | null;
  phase: ArchPhase;
  updatedAt: string;
  specSnapshot: HistorySummarySpecSnapshot;
  capturedAnswers: HistorySummaryCapturedAnswer[];
  decisions: HistorySummaryDecision[];
  toolOutcomes: HistorySummaryToolOutcome[];
  openThreads: HistorySummaryOpenThread[];
}

export interface SessionMetadata {
  phase: ArchPhase;
  mode: ArchMode;
  contractVersion?: number;
  surface?: 'project' | 'agent-editor';
  agentName?: string | null;
  agentNameKey?: string;
  threadId?: string;
  specification: Specification;
  pendingInteraction: PendingInteraction | null;
  messages: StoredMessage[];
  historySummary?: HistorySummary | null;
  projectId?: string;
  lastUserPageContext?: PageContext;

  // Slice 2: Blueprint phase data
  blueprintStage?: BlueprintStage;
  topology?: Record<string, unknown>;
  draftTopology?: Record<string, unknown>;
  lockedTopology?: Record<string, unknown>;
  blueprintOutput?: Record<string, unknown>;
  blueprintContextSummary?: string;
  sourceArchitectureContract?: Record<string, unknown>;
  topologyApproved?: boolean;

  // Slice 3: Build phase data
  files?: Record<string, unknown>;
  toolDsls?: Record<string, string>;
  /** Durable build progress */
  buildProgress?: BuildProgress;
  /** Agents approved through gate review */
  approvedAgents?: string[];

  // Mock server artifacts (separate from agent files per review)
  mockServer?: {
    projectName: string;
    endpointCount: number;
    files: Array<{ path: string; content: string }>;
  } | null;

  /** IN_PROJECT: currently active specialist */
  activeSpecialist?: string;
  /** IN_PROJECT: pending mutation awaiting approval */
  pendingMutation?: PendingMutation;
  /** IN_PROJECT: pending/approved analysis plan that gates project mutations */
  pendingPlan?: PendingPlan;
  /** IN_PROJECT: durable tool/auth/variable workflow pointer */
  activeIntegrationDraftId?: string;

  /** Phase-gate checkpoints for rollback (max 5, sliding window) */
  checkpoints?: SessionCheckpoint[];

  // --- Expansion points (added by later slices) ---
  // specVersions: Specification[]     — Contract 3: version history (Slice 2+, on edit after continue)
}

export interface ArchSession {
  id: string;
  tenantId: string;
  userId: string;
  state: SessionState;
  metadata: SessionMetadata;
  archivedAt?: string;
  createdAt: string;
  updatedAt: string;
}

export type ResumeCheckpoint =
  | 'message_appended'
  | 'artifact_persisted'
  | 'phase_transition'
  | 'unknown';

export type ResumePendingState =
  | { kind: 'widget'; interaction: PendingWidgetInteraction }
  | { kind: 'mutation'; mutation: PendingMutation }
  | { kind: 'plan'; plan: PendingPlan };

export type ResumeNextAction =
  | { type: 'answer_widget'; interaction: PendingWidgetInteraction }
  | {
      type: 'continue_phase';
      phase: ArchPhase;
      reason: string;
      pendingAgents?: string[];
    }
  | { type: 'create_project'; reason: string }
  | { type: 'review_mutation'; target: string; reviewStatus: 'pending' | 'blocked' }
  | { type: 'review_plan'; planId: string; status: PendingPlan['status'] }
  | { type: 'send_message'; reason: string }
  | { type: 'none'; reason: string };

export interface ResumeArtifacts {
  topology: {
    exists: boolean;
    approved: boolean;
    stage?: BlueprintStage;
    locked: boolean;
    agentCount: number;
    edgeCount: number;
    entryPoint?: string;
  };
  files: {
    count: number;
    names: string[];
    mockFileCount: number;
    mockFilePaths: string[];
  };
  buildProgress: BuildProgress | null;
  pendingMutation: {
    target: string;
    reviewStatus: 'pending' | 'blocked';
    isNew?: boolean;
  } | null;
  pendingPlan?: {
    id: string;
    title: string;
    status: PendingPlan['status'];
    affectedAgents: string[];
    plannedMutations: PendingPlanMutation[];
  } | null;
  integrationDraft?: {
    id: string;
  } | null;
}

export interface ResumeInterruption {
  wasInterrupted: boolean;
  lastDurableCheckpoint: ResumeCheckpoint;
  canContinueByMessage: boolean;
}

export interface ResumeSnapshot {
  phase: ArchPhase;
  state: SessionState;
  canSendMessage: boolean;
  pending: ResumePendingState | null;
  nextAction: ResumeNextAction;
  interruption: ResumeInterruption;
  artifacts: ResumeArtifacts;
}
