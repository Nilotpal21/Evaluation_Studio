/**
 * Execution Types & Helpers
 *
 * All type/interface definitions and standalone helper functions extracted
 * from runtime-executor.ts. These are the shared data structures and utilities
 * used across all execution modules.
 */

import { parseAgentBasedABL } from '@abl/core';
import { compileABLtoIR } from '@abl/compiler';
import { createLogger } from '@abl/compiler/platform';
import type {
  ActionSetIR,
  AgentIR,
  CompilationOutput,
  HandoffConfig,
  RichContentIR,
  VoiceConfigIR,
} from '@abl/compiler';
import type { CustomerExperienceMode } from '@abl/compiler/platform/ir/schema.js';
import type { EffectiveAgentConfig } from './profile-resolver.js';
import type {
  ContentBlock,
  ToolDefinition as LLMToolDefinition,
} from '@abl/compiler/platform/llm/types.js';
import type { ResolvedAgent } from '../deployment-resolver.js';
import { AppError, ErrorCodes, type InteractionContextInput } from '@agent-platform/shared-kernel';
import type { CallerContext } from '@agent-platform/shared-auth';
import type { PackName } from '@agent-platform/shared/validation';
import type { ExecutionScope, SessionLocator } from '../session/execution-scope.js';
import type { ResolvedToolDefinition } from '../modules/types.js';
import type { SdkMessageMetadata } from '../identity/sdk-message-metadata.js';
import type { ObservationSet } from './entity-observations.js';
import {
  createPersistedStructuredMessageEnvelope,
  type PersistedMessageLocalizationOwnershipV1,
  type PersistedStructuredMessageEnvelopeV2,
} from '../session/persisted-message-content.js';
import type { ConversationMessage } from '../session/types.js';
import type { ActionEvent } from '../channels/action-event.js';
import type { ResponseMessageMetadata } from '../channel/response-provenance.js';
import {
  emitProtectedAssistantMessage,
  protectStructuredOutputForUser,
  protectSessionOutputForUser,
} from './session-output-protection.js';

const log = createLogger('execution-types');

export type { ResponseMessageMetadata } from '../channel/response-provenance.js';

// =============================================================================
// TYPES
// =============================================================================

/**
 * Consolidated session data store — single source of truth for all collected/computed values.
 * Replaces the previous 3-map fragmentation (flowCollectedData, state.gatherProgress, state.context).
 */
export interface SessionDataStore {
  /** All collected and computed values (user gather inputs, tool results, SET variables, etc.) */
  values: Record<string, unknown>;
  /** Which keys were gathered from user input (vs computed/SET/tool-result) */
  gatheredKeys: Set<string>;
}

/**
 * Activation-scoped auth context derived from the runtime session.
 *
 * This is stored per active thread so orchestration can switch execution
 * surfaces without relying on stale parent state.
 */
export interface ActivationAuthContext {
  tenantId?: string;
  projectId?: string;
  /** User-scoped actor lane used for full model resolution and personal auth-profile lookup. */
  userId?: string;
  authToken?: string;
  callerContext?: CallerContext;
  authScope?: 'session' | 'user';
  delegatedBy?: string[];
  branchAgentName?: string;
  branchCredentialCache?: Map<string, unknown>;
}

/** Window after a transfer ends where trivial closeout messages should complete, not re-escalate. */
export const POST_TRANSFER_CLOSEOUT_WINDOW_MS = 5 * 60 * 1000;

const POST_TRANSFER_CLOSEOUT_PATTERNS = [
  /^(?:thanks|thank you|thx|ty)[!. ]*$/i,
  /^(?:bye|goodbye|see you)[!. ]*$/i,
  /^(?:done|all set|that'?s all|thats all|ok done|okay done)[!. ]*$/i,
] as const;

export function isPostTransferCloseoutMessage(message: string): boolean {
  const trimmed = message.trim();
  if (!trimmed) return false;
  return POST_TRANSFER_CLOSEOUT_PATTERNS.some((pattern) => pattern.test(trimmed));
}

/**
 * A single decision log entry — captures WHY a runtime decision was made.
 * Emitted only when session.traceVerbosity >= 'verbose'.
 */
export interface DecisionEntry {
  turn: number;
  timestamp: number;
  type: DecisionType;
  outcome: string;
  condition?: string;
  /** Whether the condition/rule evaluated to a positive result (passed, matched, succeeded). */
  matched: boolean;
  trigger?: Record<string, unknown>;
  candidates?: string[];
  selectedReason?: string;
  field?: string;
  violation?: string;
  oldValue?: unknown;
  newValue?: unknown;
  source?: string;
}

export type DecisionType =
  | 'handoff'
  | 'flow_transition'
  | 'constraint_check'
  | 'completion'
  | 'escalation'
  | 'delegation'
  | 'gather_extraction'
  | 'field_validation'
  | 'guardrail_check'
  | 'correction'
  | 'data_mutation';

/**
 * PendingAwaitAttachment — tracks an active AWAIT_ATTACHMENT suspension.
 * Stored on the thread to survive serialization round-trips (part of thread JSON blob).
 */
export interface PendingAwaitAttachment {
  type: 'await_attachment';
  /** Variable name where the attachment ID will be stored */
  variable: string;
  /** Optional category filter for MIME type matching */
  category?: string;
  /** Whether the attachment is required (default: true) */
  required: boolean;
  /** Prompt text shown to the user */
  prompt: string;
  /** Timeout in seconds (undefined = no timeout) */
  timeoutSeconds?: number;
  /** Step to transition to on timeout */
  onTimeout?: string;
  /** Timestamp (Date.now()) when the await started */
  startedAt: number;
}

export interface PreTurnBlockedTool {
  name: string;
  reason: 'missing_user_context' | 'session_scoped_auth_requires_user' | 'policy_hidden' | 'custom';
  detail?: string;
}

export interface PreTurnExecutionView {
  generatedAt: number;
  memory: {
    session: Record<string, unknown>;
    executionTree: Record<string, unknown>;
    granted: Record<string, unknown>;
    gather: Record<string, unknown>;
  };
  policy?: {
    failMode: 'open' | 'closed';
    disabledGuardrails: string[];
    additionalGuardrailCount: number;
  };
  auth: {
    hasUserContext: boolean;
    hasSessionToken: boolean;
    authScope?: 'session' | 'user';
  };
  tools: {
    allowedToolNames: string[];
    blocked: PreTurnBlockedTool[];
  };
}

/**
 * AgentThread — represents a single agent activation within a session.
 * A session contains one or more threads; handoffs/delegates create new threads
 * instead of new sessions, eliminating session sprawl.
 */
export interface AgentThread {
  agentName: string;
  agentIR: AgentIR | null;
  /** Cached IR hash for this thread's agent — avoids recomputing on every persist */
  _cachedIRHash?: string;
  conversationHistory: ConversationMessage[];
  state: RuntimeState;
  data: SessionDataStore;
  /** Activation-scoped auth context for this thread. */
  activationAuthContext?: ActivationAuthContext;
  startedAt: number;
  endedAt?: number;
  /** Parent thread index at creation time — used to walk true handoff ancestry even after permanent handoffs. */
  parentThreadIndex?: number;
  handoffFrom?: string;
  handoffContext?: Record<string, unknown>;
  returnExpected: boolean;
  /** Timestamp when handoff started (for timeout enforcement) */
  handoffStartedAt?: number;
  /** Timeout in ms for EXPECT_RETURN handoffs */
  handoffTimeoutMs?: number;
  /** Action to take on timeout: "escalate", "respond:<message>", "continue" */
  handoffTimeoutAction?: string;
  currentFlowStep?: string;
  waitingForInput?: string[];
  pendingResponse?: string;
  pendingRichContent?: RichContentIR;
  pendingVoiceConfig?: VoiceConfigIR;
  pendingActions?: ActionSetIR;
  status: 'active' | 'waiting' | 'completed' | 'escalated' | 'suspended' | 'human_agent';
  /** Per-thread LLM client (cached after first wiring) */
  llmClient?: import('../llm/session-llm-client.js').SessionLLMClient;
  /** Active AWAIT_ATTACHMENT suspension state — survives serialization via thread JSON blob */
  pendingAwaitAttachment?: PendingAwaitAttachment;
}

/**
 * Health entry collected during session initialization — captures subsystem
 * availability issues discovered during LLM wiring, tool binding, etc.
 */
export interface SessionHealthEntry {
  category: 'llm' | 'tool' | 'memory' | 'audit' | 'proxy' | 'encryption' | 'database';
  severity: 'warning' | 'error';
  code: string;
  message: string;
  timestamp: number;
}

export interface RuntimeAuthChallengeParams {
  sessionId: string;
  toolCallId: string;
  authType: string;
  authUrl?: string;
  profileId: string;
  profileName: string;
  prompt: string;
  timeoutMs: number;
}

export interface RuntimeJitOAuthParams {
  profileId: string;
  authProfileRef?: string;
  sessionId: string;
  toolCallId: string;
  projectId?: string;
  environment?: string;
  scopes?: string[];
  connectionMode?: 'per_user' | 'shared';
}

export interface RuntimeSession {
  id: string;
  agentName: string;
  agentIR: AgentIR | null;
  compilationOutput: CompilationOutput | null;
  conversationHistory: ConversationMessage[];
  state: RuntimeState;
  /** Consolidated data store — single source of truth */
  data: SessionDataStore;
  /** Utterance-scoped entity observations — replaced each turn */
  observations?: ObservationSet;
  // Action state
  isComplete: boolean;
  isEscalated: boolean;
  transferInitiated?: boolean;
  escalationReason?: string;
  recentTransferEndedAt?: number;
  handoffStack: string[]; // Stack of agent names for nested handoffs
  delegateStack: string[]; // Stack of agent names for nested delegates — cycle/depth detection
  // Return info for handoff targets (from routing rules)
  handoffReturnInfo?: Record<string, boolean>;
  // Flow execution state (for scripted mode)
  currentFlowStep?: string;
  waitingForInput?: string[]; // Fields being collected
  pendingResponse?: string; // Response from previous step when auto-advancing to a step without prompt
  pendingRichContent?: RichContentIR; // Structured payload from the current auto-advance chain
  pendingVoiceConfig?: VoiceConfigIR; // Voice payload from the current auto-advance chain
  pendingActions?: ActionSetIR; // Interactive actions from the current auto-advance chain
  // Tool execution
  toolExecutor?: import('@abl/compiler').ToolExecutor; // Per-session tool executor (ToolBindingExecutor or NoOpToolExecutor)
  /** Preserved external tool executor used as fallback across active-agent rewires. */
  _externalToolExecutor?: import('@abl/compiler').ToolExecutor;
  /** Module tool implementations resolved from deployment snapshots, keyed by alias-rewritten name. */
  resolvedTools?: Record<string, ResolvedToolDefinition>;
  /** Active tool mocks for test sessions (debug only) */
  toolMocks?: import('../../types/test-context.js').ToolMockConfig[];
  authToken?: string; // User's auth token for tool API calls
  tenantId?: string; // Tenant context
  projectId?: string; // Project context for LLM resolution
  userId?: string; // Compatibility actor identity for model resolution and credential lookup
  /** Effective caller permissions captured at session creation for in-runtime authorization checks. */
  permissions?: string[];
  /** Live auth challenge delivery for JIT OAuth tool pauses */
  sendAuthChallenge?: (params: RuntimeAuthChallengeParams) => void;
  /** Live OAuth initiation callback for JIT auth flows */
  initiateJitOAuth?: (params: RuntimeJitOAuthParams) => Promise<string | undefined>;
  /** Channel type set at session creation — survives handoffs (e.g. 'voice', 'voice_twilio', 'sdk_websocket') */
  channelType?: string;
  /** Unified end-user identity — set at session creation from edge layer */
  callerContext?: CallerContext;
  /** Canonical execution-scope kind when session bootstrap used a validated scope. */
  executionScopeKind?: ExecutionScope['kind'];
  /** Session purpose tag — orthogonal to channel/source. Persisted on the DB session
   *  and used by billing/analytics to exclude eval and synthetic traffic. */
  knownSource?: 'production' | 'eval' | 'synthetic';
  /** Activation-scoped auth context for the active thread. */
  _activationAuthContext?: ActivationAuthContext;
  /** Arbitrary client-supplied data (e.g., customerId, planName) — merged into session namespace
   *  so ABL agents can reference them as session.<key>. Set from load_agent.callerData. */
  callerData?: Record<string, unknown>;
  // LLM client (per-session, multi-level resolution)
  llmClient?: import('../llm/session-llm-client.js').SessionLLMClient;
  /** Tenant-isolated fact store for persistent memory (REMEMBER/RECALL) — contact/actor owned */
  factStore?: import('@abl/compiler/platform/stores/fact-store.js').FactStore;
  /** Project-scoped fact store for shared persistent memory across all users */
  projectFactStore?: import('@abl/compiler/platform/stores/fact-store.js').FactStore;
  /** Workflow-scoped durable memory shared across one handoff / execution tree. */
  executionTreeValues?: Record<string, unknown>;

  /** Content blocks from preprocessed attachments, ready to prepend to the next LLM call */
  pendingContentBlocks?: ContentBlock[];

  /** Attachment IDs from the current message — set before executeFlowStep, cleared after */
  currentAttachmentIds?: string[];

  /** Whether ON_START has been executed and session is initialized */
  initialized: boolean;

  // Thread model — session as container for agent activations
  threads: AgentThread[];
  activeThreadIndex: number;
  threadStack: number[]; // indices for return-type handoffs

  /** Counts how many times each step has been backtracked to — prevents infinite loops */
  backtrackCounts?: Record<string, number>;
  /** State for constraint-driven mini-collect (collect missing field then resume) */
  constraintCollectState?: {
    fields: string[];
    thenAction: 'continue' | 'retry';
    thenStep?: string;
    constraintCondition: string;
  };

  /** Multi-intent queue — stores alternative intents detected by the NLU layer for post-completion surfacing */
  intentQueue?: import('./intent-queue.js').IntentQueue;

  /** Pinned intent name — set when replaying a queued intent to prevent re-detection loops */
  _pinnedIntent?: string;

  /** Per-session NLU sidecar client — created when nlu_provider is 'advanced' and advanced_sidecar_url is set */
  _nluSidecarClient?: import('../nlu/sidecar-client.js').NLUSidecarClient;
  /**
   * Fail-closed per-session agent registry rebuilt from the session's own
   * resolved agents / compilation output. Used as a compatibility lane when a
   * legacy persisted session has no `rawVersions` and therefore cannot address
   * the composite-key AgentRegistryStore safely.
   */
  _sessionAgentRegistry?: AgentRegistry;

  /** Cached project runtime config — reapplied after handoff/delegate IR switch */
  _projectRuntimeConfig?: import('@abl/compiler/platform/ir/schema.js').ProjectRuntimeConfigIR;
  /** Effective agent config from resolved behavior profiles */
  _effectiveConfig?: EffectiveAgentConfig;
  /** Names of active behavior profiles (for tracing/debugging) */
  _activeProfileNames?: string[];
  /** Turn counter — incremented at the start of each reasoning turn for per-turn profile re-evaluation */
  turnCount?: number;
  /** Whether filler status messages are enabled for this session (default: true) */
  _fillerEnabled?: boolean;
  /** Transient flag while a resume_intent replay is actively executing (not serialized) */
  _resumeIntentReplayActive?: boolean;
  /** Transient depth guard for resume_intent continuation (not serialized) */
  _resumeIntentDepth?: number;
  /**
   * Transient marker set by RoutingExecutor when it already dispatched the
   * ON_RETURN: resume_intent continuation for the current child return.
   */
  _resumeIntentHandledByRouting?: { from: string };
  /**
   * Transient marker set by RoutingExecutor when it already applied the named
   * RETURN_HANDLER prelude (clear/respond) for the current child return.
   */
  _returnHandlerHandledByRouting?: { from: string };
  /** Transient flag: true when async workflow tools exist and check_workflow_status should be injected */
  _workflowStatusToolActive?: boolean;
  /** Canonical per-turn projection used for prompt/tool shaping. */
  _preTurnView?: PreTurnExecutionView;

  /** SearchAI KB tool executor reference — used for speculative parallel search.
   *  Set during LLM wiring when SearchAI tools are configured. */
  _searchaiToolExecutor?: import('../search-ai/searchai-kb-tool-executor.js').SearchAIKBToolExecutor;

  /** Per-tool KB complexity tier — set by discovery callback, read by buildTools()
   *  to apply tier-aware param stripping (reduces LLM input tokens). */
  _searchaiToolTiers?: Map<string, import('../search-ai/description-builder.js').KBComplexityTier>;

  /** Resolves when all SearchAI discovery calls complete (or timeout).
   *  Awaited before `agent_loaded` so the first LLM call has enriched
   *  descriptions + correct tier from the start. */
  _searchaiDiscoveryReady?: Promise<void>;

  // Deployment-aware version tracking (pinned at session start)
  versionInfo?: {
    deploymentId?: string;
    environment?: string;
    versions: Record<string, number>;
    /**
     * Raw version strings (e.g. "0.1.0", "1.0.0-beta.3") per agent name.
     * Used as the composite-key version segment for AgentRegistryStore lookups.
     * Numeric `versions` is retained for legacy/numeric comparisons.
     */
    rawVersions?: Record<string, string>;
    workflowVersionManifest?: Record<string, string>;
  };

  // Experiment assignment (A/B testing)
  /** ID of the A/B experiment this session is assigned to, if any. */
  experimentId?: string;
  /** Group assignment for the experiment ('control' or 'experiment'). */
  experimentGroup?: 'control' | 'experiment';

  // Timestamps
  createdAt: Date;
  lastActivityAt: Date;
  /** Per-tenant max session age in seconds — when set, Redis TTL is capped to remaining lifetime */
  maxAgeSeconds?: number;
  /** Per-tenant idle timeout in seconds — Redis key expires after inactivity */
  idleSeconds?: number;

  /** Warnings produced during tool wiring (e.g. missing secrets, unreachable endpoints) */
  toolWarnings?: string[];

  /** Health entries collected during session initialization */
  sessionHealth?: SessionHealthEntry[];

  /** Controls verbosity of decision trace events (extraction, memory, constraint) */
  traceVerbosity?: 'minimal' | 'standard' | 'verbose' | 'debug';

  /** Cached guardrail policy resolved from DB — lazily loaded once per session.
   *  undefined = not yet resolved, null = resolved to nothing, PipelinePolicy = resolved. */
  _guardrailPolicy?: import('@abl/compiler').PipelinePolicy | null;

  /** Policy epoch corresponding to the cached guardrail policy payload. */
  _guardrailPolicyEpoch?: number;

  /** Agent/config scope corresponding to the cached guardrail policy payload. */
  _guardrailPolicyScopeKey?: string;

  /** Cached streaming guardrail config from DB policy.
   *  undefined = not yet resolved, null = resolved to nothing. */
  _streamingConfig?: import('../guardrails/policy-resolver.js').StreamingSettings | null;

  /** Cached compaction policy — lazily resolved once per session.
   *  See compaction-policy.ts for resolution chain. */
  _compactionPolicy?: import('@abl/compiler/platform/ir/schema.js').CompactionPolicy;

  /** Resolved enableThinking from model resolution (project/agent DB overrides).
   *  When set, takes priority over IR value. undefined = not yet resolved. */
  resolvedEnableThinking?: boolean;

  /** Resolved thinkingBudget (token count) from model resolution.
   *  When enableThinking is true, this is the budget to include in thought descriptions. */
  resolvedThinkingBudget?: number;

  /** Resolved thoughtDescription from model resolution chain:
   *  Agent IR → Agent DB → ProjectSettings → catalog default. */
  resolvedThoughtDescription?: string;

  /** Resolved compaction threshold from model resolution chain:
   *  Agent IR → Agent DB hyperParams → ProjectSettings → env var default. */
  resolvedCompactionThreshold?: number;

  /** Resolved REMEMBER-trigger dedup depth cap from ProjectSettings.memory.dedupMaxDepth.
   *  Populated lazily on first REMEMBER evaluation; undefined → use platform default. */
  resolvedDedupMaxDepth?: number;

  /** Resolved model ID from model resolution (Agent IR → Agent DB → Tenant Model).
   *  Used by CompactionEngine to look up the correct context window size. */
  resolvedModelId?: string;

  /** Project-level prompt overrides loaded from ProjectSettings.promptOverrides.
   *  Resolution: session.promptOverrides[key] → promptTemplateLoader → PromptCatalog. */
  promptOverrides?: Record<string, string>;

  /** Pinned ProjectSettingsVersion ID from deployment (for enableThinking/thinkingBudget resolution). */
  settingsVersionId?: string;

  /** Cached IR source hash — computed once at session creation, reused on every persist.
   *  Avoids re-serializing the full AgentIR (JSON.stringify + SHA-256) on every saveSessionSnapshot. */
  _cachedIRHash?: string;
  /** Cached compilation output hash — computed once at session creation, reused on every persist. */
  _cachedCompilationHash?: string | null;

  /** Optimistic concurrency version from session store — used for cross-pod stale detection */
  storeVersion: number;

  /** Custom dimensions for analytics — extracted to ClickHouse custom_dimensions column.
   *  Populated from SDK customAttributes, DSL `SET _meta.*`, and REST injection. */
  customDimensions?: Map<string, string>;

  /** Project-configured session value keys to auto-extract as custom dimensions.
   *  Loaded from ProjectSettings.traceDimensions during LLM wiring, applied after session values are populated. */
  traceDimensionKeys?: string[];

  /** Span-aware tracer for structured observability — created per session, managed by TracerRegistry */
  tracer?: import('@agent-platform/shared-observability/tracing').Tracer;

  /** Cached config hash (SHA-256) of agent DSL — computed once at session creation for STI tracing */
  configHash?: string;

  /** True for editor simulations that must not persist production session, trace, or analytics state. */
  _ephemeralExecution?: { kind: 'simulation'; scenarioId?: string };

  /** Module provenance map — tracks which agents/tools came from mounted modules */
  moduleProvenance?: Record<string, import('../modules/types.js').ModuleProvenance>;

  /** PII token vault for reversible tokenization (Phase 2) */
  piiVault?: import('@abl/compiler/platform/security/pii-vault.js').PIIVault;

  /** Session-scoped recognizer registry loaded with project PII patterns */
  piiRecognizerRegistry?: import('@abl/compiler/platform/security/pii-recognizer-registry.js').PIIRecognizerRegistry;

  /** Project pattern rendering configs for the PII vault */
  piiPatternConfigs?: import('@abl/compiler/platform/security/pii-vault.js').PIIPatternConfig[];

  /** Resolved PII redaction config — built from environment + env vars at session start */
  piiRedactionConfig?: {
    enabled: boolean;
    redactInput: boolean;
    redactOutput: boolean;
    tier: 'basic' | 'standard' | 'advanced' | 'maximum';
    latencyBudgetMs: number;
    confidenceThreshold: number;
    enabledRecognizerPacks: PackName[];
  };

  /** Intent bridge from pipeline classification — carries intent/confidence for gather bridging */
  intentBridge?: {
    intent?: string;
    confidence?: number;
    entities?: Record<string, unknown>;
  };

  /** Omnichannel configuration — set from agent IR at session creation */
  omnichannel?: {
    recall?: {
      enabled?: boolean;
      maxMessages?: number;
      maxAgeDays?: number;
    };
  };
}

export interface RuntimeState {
  gatherProgress: Record<string, unknown>;
  conversationPhase: string;
  context: Record<string, unknown>;
  /** Currently active agent (set during handoff for UI) */
  activeAgent?: {
    name: string;
    mode: string;
    ir?: unknown;
  };
}

export interface RuntimeExecutorConfig {
  anthropicApiKey?: string;
  model?: string;
  timeoutMs?: number;
  /** Max concurrent LLM calls across all fan-out children (pod-level semaphore capacity) */
  maxConcurrentFanOutCalls?: number;
  /** Platform-level max async handoff timeout in seconds (default: 30 days) */
  maxAsyncTimeoutSec?: number;
  /** Test/host override for built-in system agent invocation. */
  systemAgentHandlerDeps?: import('./system-agent-handler.js').SystemAgentHandlerDeps;
}

export interface ExecutionOutputMessage {
  id: string;
  turnId: string;
  sequence: number;
  agentName?: string;
  role: 'assistant';
  phase: 'interim' | 'final' | 'status';
  text: string;
  deliveredToUser: boolean;
  includeInModelContext: boolean;
  persistToTranscript: boolean;
}

export interface ExecutionResult {
  response: string;
  action: { type: string; [key: string]: unknown };
  stateUpdates?: Partial<RuntimeState>;
  voiceConfig?: import('@abl/compiler').VoiceConfigIR;
  richContent?: import('@abl/compiler').RichContentIR;
  actions?: import('@abl/compiler').ActionSetIR;
  localization?: PersistedMessageLocalizationOwnershipV1;
  responseMetadata?: ResponseMessageMetadata;
  outputMessages?: ExecutionOutputMessage[];
  finalOutputMessageId?: string;
  citations?: import('../../types/index.js').Citation[];
}

export interface HandoffExecutionResult {
  success: boolean;
  response?: string;
  error?: string;
  result?: ExecutionResult;
}

export interface SubTaskResult {
  target: string;
  status: 'completed' | 'error';
  response?: string;
  error?: string;
  gatheredData?: Record<string, unknown>;
}

export interface FanOutResult {
  success: boolean;
  results: SubTaskResult[];
  failedCount: number;
}

/** A single task in a fan-out dispatch */
export interface FanOutTask {
  /** 'agent' for full child reasoning loop, 'tool' for direct tool execution. Defaults to 'agent'. */
  type?: 'agent' | 'tool';
  /** Agent name or tool name to dispatch to */
  target: string;
  /** For agents: the user's sub-request. Ignored for tools. */
  intent: string;
  /** For tools: input parameters. Ignored for agents. */
  params?: Record<string, unknown>;
  /** Optional context (for agents: handoff context) */
  context?: Record<string, unknown>;
}

// Agent registry for loading child agents
export interface AgentRegistryEntry {
  dsl: string;
  ir: AgentIR | null;
  /** Agent location: local (in-process) or remote (A2A endpoint) */
  location?: 'local' | 'remote';
  /** Agent version identifier — used to detect stale cache entries */
  version?: string;
  /** Remote agent configuration (only when location === 'remote') */
  remote?: {
    endpoint: string;
    protocol: 'a2a' | 'rest';
    auth?: {
      type: 'api_key' | 'bearer' | 'oauth';
      header?: string;
      value?: string;
    };
    timeout?: number;
  };
}

export interface AgentRegistry {
  [agentName: string]: AgentRegistryEntry;
}

// Delegate config from IR
export interface DelegateConfigIR {
  agent: string;
  when: string;
  purpose: string;
  input: Record<string, string>;
  returns: Record<string, string>;
  use_result: string;
  timeout?: string;
  on_failure: 'continue' | 'escalate' | 'respond';
  failure_message?: string;
  experienceMode?: CustomerExperienceMode;
}

/** Options for executeMessage — carries attachment and multimodal context */
export interface ExecuteMessageOptions {
  attachmentIds?: string[];
  /** Per-message metadata supplied by SDK callers for the current turn only. */
  messageMetadata?: SdkMessageMetadata;
  /** Canonical per-turn interaction context resolved at ingress. */
  interactionContext?: InteractionContextInput;
  /** Non-durable per-turn interaction hint supplied by channel ingress. */
  interactionContextHint?: InteractionContextInput;
  /** Integration-supplied session metadata merged into session.data.values._metadata. */
  sessionMetadata?: Record<string, unknown>;
  /** Canonical session locator for scoped rehydrate/load paths. */
  sessionLocator?: SessionLocator;
  /** Abort signal for cooperative cancellation (used by ExecutionCoordinator) */
  signal?: AbortSignal;
  /**
   * Internal provenance for recursive/child executions. Used only for trace
   * labeling so delegated or fan-out inputs are not rendered as fresh user
   * messages in debug surfaces.
   */
  messageSource?: 'user' | 'handoff' | 'delegate' | 'fan_out' | 'system' | 'resume';
  /** Stable inbound turn correlation id. Generated by RuntimeExecutor when omitted. */
  turnId?: string;
  sourceAgent?: string;
  delegationId?: string;
  parentSessionId?: string;
  parentThreadIndex?: number;
  childThreadIndex?: number;
  /**
   * Replays an existing user intent after ON_RETURN: resume_intent without
   * duplicating the user message in history/events.
   */
  resumeIntentReplay?: boolean;
  /**
   * Message is being forwarded from a parent agent during handoff.
   * Prevents adding the message to the child thread's history since it's
   * already in the parent thread's history.
   */
  messageForwardedFromHandoff?: boolean;
  /**
   * Marks a recursive execution's assistant output as internal coordination
   * output rather than customer-visible content.
   */
  responseVisibility?: 'customer_visible' | 'internal';
  /**
   * Prevents recursive/internal executions from emitting renderable customer
   * message events while still allowing traces and model-context state updates.
   */
  suppressRenderableOutput?: boolean;
  /** Action event from interactive elements (buttons, quick replies, carousels) */
  actionEvent?: Pick<ActionEvent, 'actionId' | 'value' | 'formData' | 'renderId' | 'source'> &
    Partial<Pick<ActionEvent, 'type'>>;
  /** Channel-specific metadata emitted with centralized agent lifecycle events (agent_enter/exit, user_message) */
  channelMetadata?: {
    channel: string;
    contentLength?: number;
    hasAttachments?: boolean;
    attachmentCount?: number;
  };
  /**
   * Internal async remote-handoff completion payload.
   * Skips user-message ingestion and routes the remote child result back through
   * the parent handoff return contract.
   */
  remoteHandoffResume?: {
    targetAgent: string;
    responseText: string;
    taskId?: string;
    status?: string;
  };
}

/**
 * ExecutorContext — interface that breaks circular dependencies between
 * the orchestrator and extracted modules. Modules depend on this interface,
 * not on the concrete RuntimeExecutor class.
 */
export interface ExecutorContext {
  executeMessage(
    sessionId: string,
    userMessage: string,
    onChunk?: (chunk: string) => void,
    onTraceEvent?: (event: { type: string; data: Record<string, unknown> }) => void,
    options?: ExecuteMessageOptions,
  ): Promise<ExecutionResult>;

  wireLLMClient(
    session: RuntimeSession,
    agentIR: AgentIR,
    tenantId?: string,
    projectId?: string,
    userId?: string,
  ): Promise<void>;

  checkConstraints(
    session: RuntimeSession,
    onTraceEvent?: (event: { type: string; data: Record<string, unknown> }) => void,
  ): import('@abl/compiler').ConstraintCheckInfo | null;

  handleConstraintViolation(
    session: RuntimeSession,
    violation: import('@abl/compiler').ConstraintCheckInfo,
    onChunk?: (chunk: string) => void,
    onTraceEvent?: (event: { type: string; data: Record<string, unknown> }) => void,
  ): ExecutionResult;

  interpolateTemplate(template: string, data: Record<string, unknown>): string;

  debouncedPersist(session: RuntimeSession, delayMs?: number): void;

  /** Mark a session as actively executing (prevents reaper eviction) */
  markExecuting(sessionId: string): void;
  /** Unmark a session from the executing set */
  unmarkExecuting(sessionId: string): void;
  /** Cancel any pending debounced persist for a session */
  cancelPendingPersist(sessionId: string): void;

  readonly agentRegistry: AgentRegistry;
  /**
   * Project- and version-scoped agent registry. Prefer this over `agentRegistry`
   * for lookups that have a session in hand — use `lookupAgentForSession(session, name)`
   * to route through the store when `session.projectId` + version are known.
   * The legacy `agentRegistry` is retained during migration and for test paths
   * that register agents without a project context.
   */
  readonly agentRegistryStore: import('./agent-registry.js').AgentRegistryStore;
  readonly sessions: Map<string, RuntimeSession>;
  readonly config: RuntimeExecutorConfig;

  /** Optional NLU sidecar client for Tier 2 ML-based entity extraction */
  readonly nluSidecarClient?: import('../nlu/sidecar-client.js').NLUSidecarClient;

  /** Async infrastructure for suspension/resumption (available when Redis is enabled) */
  readonly asyncInfra?: {
    callbackRegistry: import('@agent-platform/execution').CallbackRegistry;
    suspensionStore: import('@agent-platform/execution').SuspensionStore;
    barrierStore: import('@agent-platform/execution').FanOutBarrierStore;
    callbackBaseUrl: string;
    /** Optional: register a polling fallback for async tasks when push notifications may fail */
    registerPollFallback?: (params: {
      suspensionId: string;
      endpoint: string;
      remoteTaskId: string;
      tenantId: string;
      pollIntervalMs: number;
      maxPolls: number;
    }) => Promise<void>;
  };

  /** Immediately persist session to store (no debounce). Used before suspension. */
  persistSession(session: RuntimeSession): Promise<void>;

  /** Reasoning executor for reasoning zone steps */
  readonly reasoning: {
    execute(
      session: RuntimeSession,
      systemPrompt: string,
      tools: LLMToolDefinition[],
      onChunk?: (chunk: string) => void,
      onTraceEvent?: (event: { type: string; data: Record<string, unknown> }) => void,
      options?: {
        skipInputGuardrails?: boolean;
        surfaceBuilder?: (
          session: RuntimeSession,
        ) =>
          | { systemPrompt: string; tools: LLMToolDefinition[] }
          | Promise<{ systemPrompt: string; tools: LLMToolDefinition[] }>;
      },
    ): Promise<ExecutionResult>;
  };
}

// =============================================================================
// SESSION DATA HELPERS — computed views over the single data store
// =============================================================================

/** Returns only the values that were gathered from user input */
export function getGatherProgress(session: RuntimeSession): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const key of session.data.gatheredKeys) {
    if (key in session.data.values) {
      result[key] = session.data.values[key];
    }
  }
  return result;
}

/** Keys that store metadata alongside gathered values but should not be tracked as gathered fields */
const METADATA_KEYS = new Set(['_original', '_inferred']);
const EXECUTION_TREE_NAMESPACE = 'execution_tree';
const GRANTED_MEMORY_NAMESPACE = 'granted_memory';

function normalizeExecutionTreePath(path: string): string {
  return path.startsWith(`${EXECUTION_TREE_NAMESPACE}.`)
    ? path.slice(`${EXECUTION_TREE_NAMESPACE}.`.length)
    : path;
}

function deleteNestedPath(root: Record<string, unknown>, path: string): void {
  const segments = path.split('.').filter(Boolean);
  if (segments.length === 0) {
    return;
  }

  const stack: Array<{ owner: Record<string, unknown>; key: string }> = [];
  let current: Record<string, unknown> | undefined = root;

  for (let index = 0; index < segments.length - 1; index++) {
    const segment = segments[index];
    const next = current?.[segment];
    if (!next || typeof next !== 'object' || Array.isArray(next)) {
      return;
    }
    stack.push({ owner: current!, key: segment });
    current = next as Record<string, unknown>;
  }

  if (!current) {
    return;
  }

  delete current[segments[segments.length - 1]];

  for (let index = stack.length - 1; index >= 0; index--) {
    const { owner, key } = stack[index];
    const candidate = owner[key];
    if (
      candidate &&
      typeof candidate === 'object' &&
      !Array.isArray(candidate) &&
      Object.keys(candidate as Record<string, unknown>).length === 0
    ) {
      delete owner[key];
      continue;
    }
    break;
  }
}

function refreshExecutionTreeProjection(session: RuntimeSession): void {
  const declaredPaths =
    session.agentIR?.memory?.persistent
      ?.filter((entry) => (entry.scope as string) === 'execution_tree')
      .map((entry) => entry.path) ?? [];

  if (declaredPaths.length === 0) {
    delete session.data.values[EXECUTION_TREE_NAMESPACE];
    return;
  }

  const projection: Record<string, unknown> = {};
  for (const path of declaredPaths) {
    const normalizedPath = normalizeExecutionTreePath(path);
    const value =
      session.executionTreeValues?.[normalizedPath] ?? session.data.values[path] ?? undefined;
    if (value === undefined) {
      continue;
    }

    const segments = path.split('.').filter(Boolean);
    let current = projection;
    for (let index = 0; index < segments.length - 1; index++) {
      const segment = segments[index];
      const next = current[segment];
      if (!next || typeof next !== 'object' || Array.isArray(next)) {
        current[segment] = {};
      }
      current = current[segment] as Record<string, unknown>;
    }
    current[segments[segments.length - 1]] = value;
  }

  if (Object.keys(projection).length === 0) {
    delete session.data.values[EXECUTION_TREE_NAMESPACE];
    return;
  }

  session.data.values[EXECUTION_TREE_NAMESPACE] = projection;
}

function isExecutionTreeMemoryPath(session: RuntimeSession, key: string): boolean {
  if (key.startsWith(`${EXECUTION_TREE_NAMESPACE}.`)) {
    return true;
  }

  return (
    session.agentIR?.memory?.persistent?.some(
      (entry) => (entry.scope as string) === 'execution_tree' && entry.path === key,
    ) ?? false
  );
}

/** Writes values to session data and marks them as gathered (excluding metadata keys) */
export function setGatheredValues(session: RuntimeSession, values: Record<string, unknown>): void {
  Object.assign(session.data.values, values);
  for (const key of Object.keys(values)) {
    if (!METADATA_KEYS.has(key)) {
      session.data.gatheredKeys.add(key);
    }
  }
}

/** Deletes a value and removes it from gathered keys */
export function deleteSessionValue(session: RuntimeSession, key: string): void {
  if (key.startsWith(`${GRANTED_MEMORY_NAMESPACE}.`)) {
    const grantPath = key.slice(`${GRANTED_MEMORY_NAMESPACE}.`.length);
    const grantedRoot =
      session.data.values[GRANTED_MEMORY_NAMESPACE] &&
      typeof session.data.values[GRANTED_MEMORY_NAMESPACE] === 'object' &&
      !Array.isArray(session.data.values[GRANTED_MEMORY_NAMESPACE])
        ? (session.data.values[GRANTED_MEMORY_NAMESPACE] as Record<string, unknown>)
        : undefined;
    if (grantedRoot) {
      deleteNestedPath(grantedRoot, grantPath);
      if (Object.keys(grantedRoot).length === 0) {
        delete session.data.values[GRANTED_MEMORY_NAMESPACE];
      }
    }

    const flatGranted =
      session.data.values._granted_memory &&
      typeof session.data.values._granted_memory === 'object' &&
      !Array.isArray(session.data.values._granted_memory)
        ? (session.data.values._granted_memory as Record<string, unknown>)
        : undefined;
    if (flatGranted) {
      delete flatGranted[grantPath];
      if (Object.keys(flatGranted).length === 0) {
        delete session.data.values._granted_memory;
      }
    }

    const metaMap =
      session.data.values._granted_memory_meta &&
      typeof session.data.values._granted_memory_meta === 'object' &&
      !Array.isArray(session.data.values._granted_memory_meta)
        ? (session.data.values._granted_memory_meta as Record<
            string,
            { access?: 'read' | 'readwrite'; sourcePath?: string; sourceScope?: string }
          >)
        : undefined;

    const grantMeta = metaMap?.[grantPath];
    if (grantMeta?.access === 'readwrite' && grantMeta.sourceScope === 'execution_tree') {
      const sourcePath = grantMeta.sourcePath || grantPath;
      const normalizedPath = normalizeExecutionTreePath(sourcePath);
      delete session.executionTreeValues?.[normalizedPath];
      delete session.data.values[sourcePath];
      delete session.data.values[normalizedPath];
      refreshExecutionTreeProjection(session);
    }

    delete session.data.values[key];
    session.data.gatheredKeys.delete(key);
    return;
  }

  if (isExecutionTreeMemoryPath(session, key)) {
    const normalizedPath = normalizeExecutionTreePath(key);
    const metaMap =
      session.data.values._granted_memory_meta &&
      typeof session.data.values._granted_memory_meta === 'object' &&
      !Array.isArray(session.data.values._granted_memory_meta)
        ? (session.data.values._granted_memory_meta as Record<
            string,
            { sourcePath?: string; sourceScope?: string }
          >)
        : undefined;

    if (metaMap) {
      for (const [grantPath, meta] of Object.entries(metaMap)) {
        if (meta.sourceScope !== 'execution_tree' || meta.sourcePath !== normalizedPath) {
          continue;
        }

        const grantedRoot =
          session.data.values[GRANTED_MEMORY_NAMESPACE] &&
          typeof session.data.values[GRANTED_MEMORY_NAMESPACE] === 'object' &&
          !Array.isArray(session.data.values[GRANTED_MEMORY_NAMESPACE])
            ? (session.data.values[GRANTED_MEMORY_NAMESPACE] as Record<string, unknown>)
            : undefined;
        if (grantedRoot) {
          deleteNestedPath(grantedRoot, grantPath);
          if (Object.keys(grantedRoot).length === 0) {
            delete session.data.values[GRANTED_MEMORY_NAMESPACE];
          }
        }

        const flatGranted =
          session.data.values._granted_memory &&
          typeof session.data.values._granted_memory === 'object' &&
          !Array.isArray(session.data.values._granted_memory)
            ? (session.data.values._granted_memory as Record<string, unknown>)
            : undefined;
        if (flatGranted) {
          delete flatGranted[grantPath];
          if (Object.keys(flatGranted).length === 0) {
            delete session.data.values._granted_memory;
          }
        }
      }
    }

    delete session.executionTreeValues?.[normalizedPath];
    delete session.data.values[key];
    delete session.data.values[normalizedPath];
    session.data.gatheredKeys.delete(key);
    session.data.gatheredKeys.delete(normalizedPath);
    refreshExecutionTreeProjection(session);
    return;
  }

  delete session.data.values[key];
  session.data.gatheredKeys.delete(key);
}

/** Builds stateUpdates payload for ExecutionResult (computed from data store) */
export function buildStateUpdates(session: RuntimeSession): Partial<RuntimeState> {
  return {
    gatherProgress: getGatherProgress(session),
    context: { ...session.data.values },
    conversationPhase: session.state.conversationPhase,
    activeAgent: session.state.activeAgent,
  };
}

export function mergeReturnedExecutionTreeGrantWrites(
  session: RuntimeSession,
  parentThread: AgentThread,
  childThread: AgentThread,
): boolean {
  const flatGranted =
    childThread.data.values._granted_memory &&
    typeof childThread.data.values._granted_memory === 'object' &&
    !Array.isArray(childThread.data.values._granted_memory)
      ? (childThread.data.values._granted_memory as Record<string, unknown>)
      : {};
  const metaMap =
    childThread.data.values._granted_memory_meta &&
    typeof childThread.data.values._granted_memory_meta === 'object' &&
    !Array.isArray(childThread.data.values._granted_memory_meta)
      ? (childThread.data.values._granted_memory_meta as Record<
          string,
          { access?: 'read' | 'readwrite'; sourcePath?: string; sourceScope?: string }
        >)
      : undefined;

  if (!metaMap) {
    return false;
  }

  let merged = false;

  for (const [grantPath, meta] of Object.entries(metaMap)) {
    if (meta.access !== 'readwrite' || meta.sourceScope !== 'execution_tree') {
      continue;
    }

    const sourcePath = meta.sourcePath || grantPath;
    const normalizedPath = normalizeExecutionTreePath(sourcePath);
    if (!Object.prototype.hasOwnProperty.call(flatGranted, grantPath)) {
      const hadParentValue =
        (session.executionTreeValues &&
          Object.prototype.hasOwnProperty.call(session.executionTreeValues, normalizedPath)) ||
        Object.prototype.hasOwnProperty.call(parentThread.data.values, sourcePath) ||
        Object.prototype.hasOwnProperty.call(parentThread.data.values, normalizedPath);

      delete session.executionTreeValues?.[normalizedPath];
      delete parentThread.data.values[sourcePath];
      delete parentThread.data.values[normalizedPath];
      parentThread.data.gatheredKeys.delete(sourcePath);
      parentThread.data.gatheredKeys.delete(normalizedPath);

      if (hadParentValue) {
        merged = true;
      }
      continue;
    }

    const value = flatGranted[grantPath];
    session.executionTreeValues = session.executionTreeValues ?? {};
    session.executionTreeValues[normalizedPath] = value;

    parentThread.data.values[sourcePath] = value;
    parentThread.data.gatheredKeys.add(sourcePath);
    if (normalizedPath !== sourcePath) {
      parentThread.data.values[normalizedPath] = value;
      parentThread.data.gatheredKeys.add(normalizedPath);
    }

    merged = true;
  }

  return merged;
}

// =============================================================================
// THREAD HELPERS
// =============================================================================

/** Get the currently active thread for a session */
export function getActiveThread(session: RuntimeSession): AgentThread {
  return session.threads[session.activeThreadIndex];
}

function cloneActivationAuthContext(
  context?: ActivationAuthContext,
): ActivationAuthContext | undefined {
  if (!context) {
    return undefined;
  }

  return {
    ...context,
    ...(context.callerContext ? { callerContext: { ...context.callerContext } } : {}),
    ...(context.delegatedBy ? { delegatedBy: [...context.delegatedBy] } : {}),
  };
}

/** Create a new thread within a session and return it */
export function createThread(
  session: RuntimeSession,
  agentName: string,
  agentIR: AgentIR | null,
  options?: {
    parentThreadIndex?: number;
    handoffFrom?: string;
    handoffContext?: Record<string, unknown>;
    returnExpected?: boolean;
    initialData?: Record<string, unknown>;
    initialHistory?: ConversationMessage[];
  },
): AgentThread {
  const thread: AgentThread = {
    agentName,
    agentIR,
    conversationHistory: options?.initialHistory ? [...options.initialHistory] : [],
    state: {
      gatherProgress: {},
      conversationPhase: 'start',
      context: {},
    },
    data: {
      values: {
        // Carry forward built-in session-level variables so CALL expressions can reference them
        session_id: session.id,
        ...(session.userId ? { user_id: session.userId } : {}),
        ...(session.tenantId ? { tenant_id: session.tenantId } : {}),
        ...(session.projectId ? { project_id: session.projectId } : {}),
        // Carry forward integration-supplied session metadata (e.g. sessionToken for MCP headers)
        ...(session.data.values._metadata ? { _metadata: session.data.values._metadata } : {}),
        // initialData first so platform `session` namespace below takes precedence
        ...(options?.initialData || {}),
        // The `session` namespace provides dotted-path access for CALL expressions
        // (e.g., session.sessionId, session.channel). Spread AFTER initialData so
        // platform fields (sessionId, tenantId) are never overwritten by handoff context.
        session: {
          // Preserve any fields from initialData.session (e.g., channel from handoff)
          ...((options?.initialData?.session as Record<string, unknown> | undefined) || {}),
          // 1. Arbitrary client-supplied data (load_agent.callerData) — lowest priority
          ...(session.callerData || {}),
          // 2. CallerContext fields (customerId, contactContext, etc.) — override callerData
          ...(session.callerContext
            ? Object.fromEntries(
                Object.entries(session.callerContext).filter(
                  ([, v]) => v !== undefined && v !== null,
                ),
              )
            : {}),
          // 3. Platform fields — highest priority, never overridden
          channel:
            (options?.initialData?.session as Record<string, unknown> | undefined)?.channel ??
            (session as any).channelType ??
            'digital',
          sessionId: session.id,
          ...(session.userId ? { userId: session.userId } : {}),
          ...(session.tenantId ? { tenantId: session.tenantId } : {}),
          ...(session.projectId ? { projectId: session.projectId } : {}),
        },
      },
      gatheredKeys: new Set(),
    },
    startedAt: Date.now(),
    activationAuthContext: cloneActivationAuthContext(session._activationAuthContext),
    parentThreadIndex:
      options?.parentThreadIndex ??
      (session.threads.length > 0 ? session.activeThreadIndex : undefined),
    handoffFrom: options?.handoffFrom,
    handoffContext: options?.handoffContext,
    returnExpected: options?.returnExpected ?? false,
    status: 'active',
    currentFlowStep: agentIR?.flow
      ? agentIR.flow.entry_point || agentIR.flow.steps?.[0]
      : undefined,
  };
  session.threads.push(thread);
  return thread;
}

/** Create the initial thread from top-level session fields (migration bridge) */
export function createInitialThread(session: RuntimeSession): void {
  if (session.threads.length > 0) return; // already has threads

  const thread: AgentThread = {
    agentName: session.agentName,
    agentIR: session.agentIR,
    conversationHistory: session.conversationHistory,
    state: session.state,
    data: session.data,
    activationAuthContext: cloneActivationAuthContext(session._activationAuthContext),
    startedAt: Date.now(),
    returnExpected: false,
    status: 'active',
    currentFlowStep: session.currentFlowStep,
    waitingForInput: session.waitingForInput,
    pendingResponse: session.pendingResponse,
    pendingRichContent: session.pendingRichContent,
    pendingVoiceConfig: session.pendingVoiceConfig,
    pendingActions: session.pendingActions,
  };
  session.threads = [thread];
  session.activeThreadIndex = 0;
  session.threadStack = [];
}

/** Sync active thread state back to top-level session fields (backward compat) */
export function syncThreadToSession(session: RuntimeSession): void {
  const thread = getActiveThread(session);
  if (!thread) return;

  // Invalidate cached guardrail policy if agentIR changed — prevents policy bleed across agents
  if (session.agentIR !== thread.agentIR) {
    session._guardrailPolicy = undefined;
    session._guardrailPolicyEpoch = undefined;
    session._guardrailPolicyScopeKey = undefined;
    session._streamingConfig = undefined;
    // Invalidate cached IR hash — will be recomputed on next persist
    session._cachedIRHash = thread._cachedIRHash;
  }

  session.agentName = thread.agentName;
  session.agentIR = thread.agentIR;
  session.conversationHistory = thread.conversationHistory;
  session.state = thread.state;
  session.data = thread.data;
  session._activationAuthContext = cloneActivationAuthContext(thread.activationAuthContext);
  session.currentFlowStep = thread.currentFlowStep;
  session.waitingForInput = thread.waitingForInput;
  session.pendingResponse = thread.pendingResponse;
  session.pendingRichContent = thread.pendingRichContent;
  session.pendingVoiceConfig = thread.pendingVoiceConfig;
  session.pendingActions = thread.pendingActions;
  session.isComplete = thread.status === 'completed';
  session.isEscalated = thread.status === 'escalated';
}

function conversationMessageContentToString(content: ConversationMessage['content']): string {
  if (typeof content === 'string') {
    return content;
  }

  return content
    .map((block) => {
      if (block.type === 'text' && typeof block.text === 'string') {
        return block.text;
      }
      return '';
    })
    .join('')
    .trim();
}

const PII_TOKEN_PLACEHOLDER_PATTERN = /\{\{PII:[^}]+\}\}/g;
const REDACTED_PII_PLACEHOLDER_PATTERN = /\[REDACTED_[A-Z0-9_]+\]/g;
const ANY_PII_PLACEHOLDER_SEGMENT_PATTERN = /(\{\{PII:[^}]+\}\}|\[REDACTED_[A-Z0-9_]+\])/;
const ANY_PII_PLACEHOLDER_SEGMENT_GLOBAL_PATTERN = /(\{\{PII:[^}]+\}\}|\[REDACTED_[A-Z0-9_]+\])/g;

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function normalizePIIPlaceholderText(text: string): string {
  return text
    .replace(PII_TOKEN_PLACEHOLDER_PATTERN, '[PII]')
    .replace(REDACTED_PII_PLACEHOLDER_PATTERN, '[PII]');
}

function buildAssistantComparisonCandidates(text: string): string[] {
  const trimmed = text.trim();
  if (!trimmed) {
    return [];
  }

  const baseCandidates = new Set<string>([trimmed]);
  const colonIndex = trimmed.lastIndexOf(': ');
  if (colonIndex !== -1 && colonIndex + 2 < trimmed.length) {
    baseCandidates.add(trimmed.slice(colonIndex + 2).trim());
  }

  const newlineIndex = trimmed.lastIndexOf('\n');
  if (newlineIndex !== -1 && newlineIndex + 1 < trimmed.length) {
    baseCandidates.add(trimmed.slice(newlineIndex + 1).trim());
  }

  const candidates = new Set<string>();
  for (const candidate of baseCandidates) {
    if (!candidate) {
      continue;
    }

    candidates.add(candidate);
    const normalized = normalizePIIPlaceholderText(candidate);
    if (normalized !== candidate) {
      candidates.add(normalized);
    }
  }

  return [...candidates];
}

function isPIIPlaceholderSegment(segment: string): boolean {
  return /^\{\{PII:[^}]+\}\}$/.test(segment) || /^\[REDACTED_[A-Z0-9_]+\]$/.test(segment);
}

function buildFlexiblePIIPlaceholderPattern(text: string): RegExp | null {
  if (!ANY_PII_PLACEHOLDER_SEGMENT_PATTERN.test(text)) {
    return null;
  }

  const segments = text
    .split(ANY_PII_PLACEHOLDER_SEGMENT_GLOBAL_PATTERN)
    .filter((segment) => segment.length > 0);

  const pattern = segments
    .map((segment) => (isPIIPlaceholderSegment(segment) ? '.+?' : escapeRegExp(segment)))
    .join('');

  return new RegExp(`^${pattern}$`);
}

function assistantMessageMatchesResponse(assistantContent: string, response: string): boolean {
  const assistantCandidates = buildAssistantComparisonCandidates(assistantContent);
  const responseCandidates = buildAssistantComparisonCandidates(response);

  if (assistantCandidates.length === 0 || responseCandidates.length === 0) {
    return false;
  }

  for (const assistantCandidate of assistantCandidates) {
    for (const responseCandidate of responseCandidates) {
      if (assistantCandidate === responseCandidate) {
        return true;
      }
    }

    const flexiblePattern = buildFlexiblePIIPlaceholderPattern(assistantCandidate);
    if (flexiblePattern) {
      for (const responseCandidate of responseCandidates) {
        if (flexiblePattern.test(responseCandidate)) {
          return true;
        }
      }
    }
  }

  return false;
}

function mergeResponseMetadataIntoAssistantMessage(
  message: ConversationMessage,
  responseMetadata: ResponseMessageMetadata,
): void {
  message.metadata = {
    ...(message.metadata ?? {}),
    ...responseMetadata,
  };
}

function mergeContentEnvelopeIntoAssistantMessage(
  message: ConversationMessage,
  contentEnvelope: PersistedStructuredMessageEnvelopeV2,
): void {
  message.contentEnvelope = contentEnvelope;
}

function mergeResponseOutputIntoAssistantMessage(
  message: ConversationMessage,
  responseMetadata?: ResponseMessageMetadata,
  contentEnvelope?: PersistedStructuredMessageEnvelopeV2,
): void {
  if (responseMetadata) {
    mergeResponseMetadataIntoAssistantMessage(message, responseMetadata);
  }

  if (contentEnvelope) {
    mergeContentEnvelopeIntoAssistantMessage(message, contentEnvelope);
  }
}

export function buildExecutionResultContentEnvelope(
  result: Pick<
    ExecutionResult,
    'response' | 'voiceConfig' | 'richContent' | 'actions' | 'localization'
  >,
): PersistedStructuredMessageEnvelopeV2 | undefined {
  return (
    createPersistedStructuredMessageEnvelope(result.response, {
      ...(result.richContent ? { richContent: result.richContent } : {}),
      ...(result.actions ? { actions: result.actions } : {}),
      ...(result.voiceConfig ? { voiceConfig: result.voiceConfig } : {}),
      ...(result.localization ? { localization: result.localization } : {}),
    }) ?? undefined
  );
}

type ThreadReturnResponse =
  | string
  | Pick<ExecutionResult, 'response' | 'voiceConfig' | 'richContent' | 'actions' | 'localization'>;

function hasStructuredThreadReturnPayload(
  result: ThreadReturnResponse,
): result is Exclude<ThreadReturnResponse, string> {
  return (
    typeof result !== 'string' &&
    (result.richContent !== undefined ||
      result.actions !== undefined ||
      result.voiceConfig !== undefined ||
      result.localization !== undefined)
  );
}

export function applyResponseMetadataToLatestAssistantMessage(
  conversationHistory: ConversationMessage[],
  response: string,
  responseMetadata?: ResponseMessageMetadata,
  contentEnvelope?: PersistedStructuredMessageEnvelopeV2,
): boolean {
  if ((!responseMetadata && !contentEnvelope) || conversationHistory.length === 0) {
    return false;
  }

  const normalizedResponse = response.trim();
  let sawAssistant = false;
  let latestAssistantIndex: number | null = null;
  for (let index = conversationHistory.length - 1; index >= 0; index -= 1) {
    const message = conversationHistory[index];

    if (message.role !== 'assistant') {
      if (sawAssistant && message.role === 'user') {
        break;
      }
      continue;
    }

    sawAssistant = true;
    if (latestAssistantIndex === null) {
      latestAssistantIndex = index;
    }

    if (!normalizedResponse) {
      continue;
    }

    const messageContent = conversationMessageContentToString(message.content);
    if (!assistantMessageMatchesResponse(messageContent, normalizedResponse)) {
      continue;
    }

    mergeResponseOutputIntoAssistantMessage(message, responseMetadata, contentEnvelope);
    return true;
  }

  if (latestAssistantIndex !== null) {
    const latestAssistantMessage = conversationHistory[latestAssistantIndex];
    const latestAssistantContent = conversationMessageContentToString(
      latestAssistantMessage.content,
    );
    const shouldFallBackToLatestAssistant =
      !normalizedResponse || (!!contentEnvelope && latestAssistantContent.trim().length === 0);

    if (shouldFallBackToLatestAssistant) {
      mergeResponseOutputIntoAssistantMessage(
        latestAssistantMessage,
        responseMetadata,
        contentEnvelope,
      );
      return true;
    }
  }

  return false;
}

export function buildFailedHandoffExecutionResult(
  session: RuntimeSession,
  targetAgent: string,
  error?: string,
): ExecutionResult {
  const response = error || `Unable to hand off to ${targetAgent}.`;
  const protectedResponse = emitProtectedAssistantMessage(session, response, {
    historyTarget: session.conversationHistory as Array<{
      role: string;
      content: string;
      metadata?: Record<string, unknown>;
    }>,
  });

  return {
    response: protectedResponse.deliveryText,
    action: {
      type: 'error',
      failedAction: 'handoff',
      target: targetAgent,
    },
    stateUpdates: buildStateUpdates(session),
  };
}

export function buildHandoffExecutionResult(
  session: RuntimeSession,
  targetAgent: string,
  handoffResult: HandoffExecutionResult,
  options: { stateUpdates?: Partial<RuntimeState> } = {},
): ExecutionResult {
  const sourceResult = handoffResult.result;
  return {
    response: handoffResult.response ?? sourceResult?.response ?? '',
    action: { type: 'handoff', target: targetAgent },
    stateUpdates: options.stateUpdates ?? buildStateUpdates(session),
    ...(sourceResult?.voiceConfig !== undefined ? { voiceConfig: sourceResult.voiceConfig } : {}),
    ...(sourceResult?.richContent !== undefined ? { richContent: sourceResult.richContent } : {}),
    ...(sourceResult?.actions !== undefined ? { actions: sourceResult.actions } : {}),
    ...(sourceResult?.localization !== undefined
      ? { localization: sourceResult.localization }
      : {}),
    ...(sourceResult?.responseMetadata !== undefined
      ? { responseMetadata: sourceResult.responseMetadata }
      : {}),
  };
}

/**
 * Try to return from a completed child thread to its parent supervisor.
 * Marks the child thread as completed, pops the threadStack, merges data
 * back to the parent using ON_RETURN.MAP if configured, appends the child
 * response to parent conversation, and syncs the parent back to session.
 *
 * Returns true if a thread return was performed, false otherwise.
 */
export function tryThreadReturn(
  session: RuntimeSession,
  responseOrResult: ThreadReturnResponse,
  onTraceEvent?: (event: { type: string; data: Record<string, unknown> }) => void,
): boolean {
  const response =
    typeof responseOrResult === 'string' ? responseOrResult : responseOrResult.response;
  const activeThread = getActiveThread(session);
  if (!activeThread) return false;

  // Mark thread completed
  activeThread.status = 'completed';
  activeThread.endedAt = Date.now();

  // Only return if this thread expects return and has a parent waiting
  if (!activeThread.returnExpected || session.threadStack.length === 0) {
    return false;
  }

  const parentIndex = session.threadStack.pop()!;
  const parentThread = session.threads[parentIndex];
  parentThread.status = 'active';
  session.activeThreadIndex = parentIndex;

  // Keep handoffStack aligned with threadStack for later-turn returns.
  // Same-call returns may already unwind separately, so only pop when
  // the active child still owns the top frame.
  if (session.handoffStack.at(-1) === activeThread.agentName) {
    session.handoffStack = session.handoffStack.slice(0, -1);
  }

  // Check handoff timeout on the parent thread
  if (parentThread.handoffTimeoutMs && parentThread.handoffStartedAt) {
    const elapsed = Date.now() - parentThread.handoffStartedAt;
    if (elapsed > parentThread.handoffTimeoutMs) {
      const action = parentThread.handoffTimeoutAction ?? 'escalate';

      if (onTraceEvent) {
        onTraceEvent({
          type: 'handoff_timeout',
          data: {
            parentAgent: parentThread.agentName,
            childAgent: activeThread.agentName,
            timeoutMs: parentThread.handoffTimeoutMs,
            elapsedMs: elapsed,
            action,
          },
        });
      }

      // Clean up timeout metadata
      delete parentThread.handoffStartedAt;
      delete parentThread.handoffTimeoutMs;
      delete parentThread.handoffTimeoutAction;

      if (action === 'escalate') {
        session.isEscalated = true;
        session.escalationReason = `Handoff to ${activeThread.agentName} timed out after ${elapsed}ms`;
        syncThreadToSession(session);
        session.llmClient = undefined;
        return true;
      } else if (action === 'continue') {
        // Fall through to normal return processing
      } else if (action.startsWith('respond:')) {
        const message = action.slice('respond:'.length).trim();
        emitProtectedAssistantMessage(session, message, {
          historyTarget: parentThread.conversationHistory as Array<{
            role: string;
            content: string;
            metadata?: Record<string, unknown>;
          }>,
        });
        syncThreadToSession(session);
        session.llmClient = undefined;
        return true;
      }
    }
  }

  // Clean up timeout metadata on normal return
  delete parentThread.handoffStartedAt;
  delete parentThread.handoffTimeoutMs;
  delete parentThread.handoffTimeoutAction;

  // Merge data back to parent — look up ON_RETURN.MAP from the parent's handoff config
  const parentIR = parentThread.agentIR;
  const handoffConfig = parentIR?.coordination?.handoffs?.find(
    (h: HandoffConfig) => h.to === activeThread.agentName,
  );
  const onReturn = handoffConfig?.on_return;
  const returnMap = typeof onReturn === 'object' && onReturn !== null ? onReturn.map : undefined;

  if (returnMap && Object.keys(returnMap).length > 0) {
    for (const [childKey, parentKey] of Object.entries(returnMap)) {
      const value = activeThread.data.values[childKey];
      if (value !== undefined) {
        parentThread.data.values[parentKey] = value;
        parentThread.data.gatheredKeys.add(parentKey);
      }
    }
  } else {
    for (const key of activeThread.data.gatheredKeys) {
      parentThread.data.values[key] = activeThread.data.values[key];
      parentThread.data.gatheredKeys.add(key);
    }
  }

  mergeReturnedExecutionTreeGrantWrites(session, parentThread, activeThread);

  const hasStructuredReturnPayload = hasStructuredThreadReturnPayload(responseOrResult);

  // Add child response to parent conversation. Silent text-only completions
  // produce no history entry, but structured-only returns are visible output
  // and must keep their content envelope on the parent thread.
  if (response || hasStructuredReturnPayload) {
    const protectedResponse = protectSessionOutputForUser(session, response);
    const parentHistoryText = response
      ? `[${activeThread.agentName}]: ${protectedResponse.historyText}`
      : '';
    const parentMessage: ConversationMessage = {
      role: 'assistant',
      content: parentHistoryText,
    };
    if (hasStructuredReturnPayload) {
      const protectedStructured = protectStructuredOutputForUser(session, {
        richContent: responseOrResult.richContent,
        actions: responseOrResult.actions,
        voiceConfig: responseOrResult.voiceConfig,
      });
      const contentEnvelope = createPersistedStructuredMessageEnvelope(parentHistoryText, {
        ...protectedStructured.history,
        ...(responseOrResult.localization ? { localization: responseOrResult.localization } : {}),
      });
      if (contentEnvelope) {
        parentMessage.contentEnvelope = contentEnvelope;
      }
    }
    parentThread.conversationHistory.push(parentMessage);
  }

  // Sync parent thread back to session top-level (resets isComplete to false)
  syncThreadToSession(session);
  refreshExecutionTreeProjection(session);

  // Invalidate the LLM client — it was wired for the child agent's IR.
  // The caller (handleHandoff) will re-wire it for the parent's agentIR.
  session.llmClient = undefined;

  if (onTraceEvent) {
    onTraceEvent({
      type: 'thread_return',
      data: {
        from: activeThread.agentName,
        to: parentThread.agentName,
        threadIndex: parentIndex,
        silent: !response,
      },
    });
  }

  return true;
}

// =============================================================================
// COMPILE-TO-RESOLVED HELPER
// =============================================================================

/**
 * Compile one or more DSL strings into a ResolvedAgent object.
 * This is the standalone replacement for the old createSession / createSessionFromMultipleDSLs
 * parse+compile logic. Callers pass the result to executor.createSessionFromResolved().
 *
 * For production, use DeploymentResolver instead — this compiles at session time
 * and is intended for debug/test/working-copy scenarios.
 */
export function compileToResolvedAgent(
  dsls: string[],
  entryAgentName: string,
  configVariables?: Record<string, string>,
  resolvedToolImplementations?: Map<string, import('@abl/compiler').ToolDefinition[]>,
  environment: string = 'dev',
): ResolvedAgent {
  // Parse each DSL separately (parser handles one agent per call)
  const documents: import('@abl/core').AgentBasedDocument[] = [];

  for (const dsl of dsls) {
    const parseResult = parseAgentBasedABL(dsl);
    if (parseResult.errors.length > 0) {
      log.warn('ABL parse warnings', { errors: parseResult.errors });
    }
    if (parseResult.document) {
      documents.push(parseResult.document);
    }
  }

  if (documents.length === 0) {
    throw new AppError('No valid agent documents parsed', { ...ErrorCodes.BAD_REQUEST });
  }

  // Compile all documents together (pass config variables and resolved tool implementations)
  const compilerOptions: Record<string, unknown> = {};
  if (configVariables && Object.keys(configVariables).length > 0) {
    compilerOptions.config_variables = configVariables;
  }
  if (resolvedToolImplementations && resolvedToolImplementations.size > 0) {
    compilerOptions.resolvedToolImplementations = resolvedToolImplementations;
  }
  const compilationOutput = compileABLtoIR(
    documents,
    Object.keys(compilerOptions).length > 0 ? compilerOptions : undefined,
  );

  if (compilationOutput.compilation_errors?.length) {
    log.warn('Compilation completed with errors', {
      errorCount: compilationOutput.compilation_errors.length,
      errors: compilationOutput.compilation_errors
        .map((e) => `${e.agent}: ${e.message}`)
        .join('; '),
    });
  }

  log.warn('Compiling from working copy — use deployments for production');

  return {
    agents: compilationOutput.agents,
    entryAgent: compilationOutput.agents[entryAgentName]
      ? entryAgentName
      : compilationOutput.entry_agent || entryAgentName,
    compilationOutput,
    sourceHash: 'working-copy',
    versionInfo: { environment, versions: {} },
  };
}

/**
 * Resolve tool implementations from pre-parsed AgentBasedDocuments.
 *
 * Extracts tool names per agent from parsed documents, queries project_tools for
 * binding metadata (endpoint, method, auth, etc.), and returns ToolDefinition[]
 * keyed by agent name for the compiler's resolvedToolImplementations option.
 *
 * Used by both resolveProjectTools (raw DSL path) and DeploymentResolver (pre-parsed path).
 */
export async function resolveProjectToolsFromDocuments(
  tenantId: string,
  projectId: string,
  documents: import('@abl/core').AgentBasedDocument[],
  options: { failOnErrors?: boolean } = {},
): Promise<Map<string, import('@abl/compiler').ToolDefinition[]>> {
  const toolsByAgent = new Map<string, string[]>();
  for (const doc of documents) {
    const toolNames = (doc.tools ?? []).map((t) => t.name).filter(Boolean);
    if (toolNames.length > 0) {
      toolsByAgent.set(doc.name, toolNames);
    }
  }

  if (toolsByAgent.size === 0) {
    return new Map();
  }

  try {
    const { resolveToolImplementations } = await import('@agent-platform/shared/tools/resolve');
    const { buildModuleToolResolver } =
      await import('@agent-platform/shared/tools/resolve-module-tool');
    const { findMcpServerConfigsRaw } = await import('@agent-platform/shared/repos');
    const { buildConnectorToolResolver } = await import('../connector-registry-singleton.js');
    const resolved = await resolveToolImplementations(
      { tenantId, projectId, toolsByAgent },
      {
        mcpServerConfigRawLoader: (tid: string, pid: string) => findMcpServerConfigsRaw(tid, pid),
        connectorToolResolver: buildConnectorToolResolver(),
        moduleToolResolver: buildModuleToolResolver(tenantId, projectId),
      },
    );

    if (resolved.errors.length > 0) {
      for (const e of resolved.errors) {
        log.warn('Tool resolution error (working-copy)', {
          code: e.code,
          message: e.message,
          location: e.location,
        });
      }
      if (options.failOnErrors) {
        throw new Error(resolved.errors.map((e) => `${e.code}: ${e.message}`).join('; '));
      }
    }
    // Cast is structurally safe: ToolDefinitionLocal (from @agent-platform/shared) is a
    // subset of compiler ToolDefinition — all required fields match, compiler-only fields
    // (e.g. `system`) are optional. See shared/tools/resolve-tool-implementations.ts line ~68.
    return resolved.resolvedByAgent as Map<string, import('@abl/compiler').ToolDefinition[]>;
  } catch (err) {
    log.warn('Failed to resolve tool implementations', {
      error: err instanceof Error ? err.message : String(err),
      projectId,
    });
    if (options.failOnErrors) {
      throw err;
    }
    return new Map();
  }
}

/**
 * Resolve tool implementations from raw DSL strings.
 *
 * Convenience wrapper over resolveProjectToolsFromDocuments that parses DSLs first.
 * Used by entry points that only have raw DSL strings (WebSocket handlers, REST chat, etc.).
 */
export async function resolveProjectTools(
  tenantId: string,
  projectId: string,
  dsls: string[],
  options: { failOnErrors?: boolean } = {},
): Promise<Map<string, import('@abl/compiler').ToolDefinition[]>> {
  const documents: import('@abl/core').AgentBasedDocument[] = [];
  for (const dsl of dsls) {
    const parseResult = parseAgentBasedABL(dsl);
    if (parseResult.document) {
      documents.push(parseResult.document);
    }
  }
  return resolveProjectToolsFromDocuments(tenantId, projectId, documents, options);
}
