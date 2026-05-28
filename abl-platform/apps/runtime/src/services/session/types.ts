/**
 * Session Types
 *
 * Core types for cluster-ready session management.
 * SessionData is the serializable session state stored in the session store.
 * HydratedSession adds resolved AgentIR and CompilationOutput for execution.
 */

import type {
  ActionSetIR,
  AgentIR,
  CompilationOutput,
  RichContentIR,
  VoiceConfigIR,
} from '@abl/compiler';
import type { ContentBlock } from '@abl/compiler/platform/llm/types.js';
import type { CallerContext } from '@agent-platform/shared-auth';
import type { PackName } from '@agent-platform/shared/validation';
import type { SerializedObservationSet } from '../execution/entity-observations.js';
import type { ExecutionScope } from './execution-scope.js';
import type { PersistedStructuredMessageEnvelopeV2 } from './persisted-message-content.js';

/** Message content can be a plain string or multimodal content blocks */
export type MessageContent = string | ContentBlock[];

/** Conversation history entry stored on runtime sessions and serialized stores. */
export interface ConversationMessage {
  role: string;
  content: MessageContent;
  metadata?: Record<string, unknown>;
  contentEnvelope?: PersistedStructuredMessageEnvelopeV2;
}

// =============================================================================
// SESSION DATA (Serializable — stored in Redis/Memory)
// =============================================================================

export interface SessionData {
  id: string;
  agentName: string;
  /** Hash of the AgentIR source — used to look up IR from cache instead of storing per-session */
  irSourceHash: string;
  /** Hash of the CompilationOutput — used to look up compilation from cache */
  compilationHash: string | null;
  /** Conversation history (sliding window, capped by config) */
  conversationHistory: ConversationMessage[];
  /** Mutable runtime state */
  state: SessionState;
  /** Optimistic concurrency version — incremented on every save */
  version: number;
  /** Workflow-scoped durable memory shared across one execution / handoff tree. */
  executionTreeValues?: Record<string, unknown>;

  // Action state
  isComplete: boolean;
  isEscalated: boolean;
  transferInitiated?: boolean;
  escalationReason?: string;
  /** Timestamp of the most recent human-agent transfer end/return to bot. */
  recentTransferEndedAt?: number;

  handoffStack: string[];
  delegateStack: string[];
  handoffReturnInfo?: Record<string, boolean>;

  // Consolidated data store
  dataValues: Record<string, unknown>;
  dataGatheredKeys: string[]; // Set<string> serialized as array for storage
  /** Utterance-scoped entity observations — replaced each turn, not persisted across sessions */
  observations?: SerializedObservationSet;

  // Flow execution state (for scripted mode)
  currentFlowStep?: string;
  waitingForInput?: string[];
  gatherFieldsCollected?: string[];
  pendingResponse?: string;
  pendingRichContent?: RichContentIR;
  pendingVoiceConfig?: VoiceConfigIR;
  pendingActions?: ActionSetIR;

  // Auth/identity context (needed for session rehydration on different pods)
  tenantId?: string;
  projectId?: string;
  deploymentId?: string;
  authToken?: string;
  userId?: string;
  permissions?: string[];
  /** Unified end-user identity — set at session creation from edge layer */
  callerContext?: CallerContext;
  /** Canonical execution-scope kind when the session was created through a scoped boundary. */
  executionScopeKind?: ExecutionScope['kind'];

  // Deployment-aware version tracking (pinned at session start)
  environment?: string;
  agentVersions?: Record<string, number>; // agentName → version number
  /**
   * Raw version strings (e.g. "1.2.3") used to address the AgentRegistryStore
   * by composite key. The lossy numeric `agentVersions` map is kept for legacy
   * trace and reporting surfaces that expect a number.
   */
  agentRawVersions?: Record<string, string>;

  // Lifecycle
  /** Whether ON_START has been executed for this session */
  initialized: boolean;

  // Metadata
  createdAt: number;
  lastActivityAt: number;
  /** Per-tenant max session age in seconds — when set, touch() caps TTL to remaining lifetime */
  maxAgeSeconds?: number;
  /** Per-tenant idle timeout in seconds — session expires after this many seconds of inactivity */
  idleSeconds?: number;

  // Thread model — session contains agent threads
  threads: AgentThreadData[];
  activeThreadIndex: number;
  threadStack: number[];
  /** Custom dimensions for analytics — serialized as plain object for Redis storage */
  customDimensions?: Record<string, string>;
  /** Counts for backtrack loop prevention */
  backtrackCounts?: Record<string, number>;
  /** Active constraint-collect state */
  constraintCollectState?: {
    fields: string[];
    thenAction: 'continue' | 'retry';
    thenStep?: string;
    constraintCondition: string;
  };
  /** Module provenance map — tracks which agents/tools came from mounted modules */
  moduleProvenance?: Record<string, import('../modules/types.js').ModuleProvenance>;
  /** Serialized PII vault data (encrypted at rest via ENCRYPTED_FIELDS) */
  piiVaultData?: string;
  /** Resolved PII redaction config — cached for session lifetime */
  piiRedactionConfig?: {
    enabled: boolean;
    redactInput: boolean;
    redactOutput: boolean;
    tier: 'basic' | 'standard' | 'advanced' | 'maximum';
    latencyBudgetMs: number;
    confidenceThreshold: number;
    enabledRecognizerPacks: PackName[];
  };
}

export interface SessionState {
  gatherProgress: Record<string, unknown>;
  conversationPhase: string;
  context: Record<string, unknown>;
  activeAgent?: {
    name: string;
    mode: string;
    ir?: unknown;
  };
}

// =============================================================================
// AGENT THREAD DATA (Serializable — stored alongside SessionData)
// =============================================================================

/** Serializable form of PendingAwaitAttachment (stored in thread JSON blob) */
export interface PendingAwaitAttachmentData {
  type: 'await_attachment';
  variable: string;
  category?: string;
  required: boolean;
  prompt: string;
  timeoutSeconds?: number;
  onTimeout?: string;
  startedAt: number;
}

export interface AgentThreadData {
  agentName: string;
  irSourceHash: string;
  conversationHistory: ConversationMessage[];
  state: SessionState;
  dataValues: Record<string, unknown>;
  dataGatheredKeys: string[];
  startedAt: number;
  endedAt?: number;
  handoffFrom?: string;
  handoffContext?: Record<string, unknown>;
  returnExpected: boolean;
  currentFlowStep?: string;
  waitingForInput?: string[];
  pendingResponse?: string;
  pendingRichContent?: RichContentIR;
  pendingVoiceConfig?: VoiceConfigIR;
  pendingActions?: ActionSetIR;
  status: 'active' | 'waiting' | 'completed' | 'escalated' | 'suspended' | 'human_agent';
  /** Active AWAIT_ATTACHMENT suspension state — serialized as part of thread JSON blob */
  pendingAwaitAttachment?: PendingAwaitAttachmentData;
}

// =============================================================================
// HYDRATED SESSION (Resolved — ready for execution)
// =============================================================================

export interface HydratedSession extends SessionData {
  /** Resolved AgentIR (from cache via irSourceHash) */
  agentIR: AgentIR | null;
  /** Resolved CompilationOutput (from cache via compilationHash) */
  compilationOutput: CompilationOutput | null;
}

// =============================================================================
// CONVERSATION CONFIG
// =============================================================================

export interface ConversationWindowConfig {
  /** Maximum messages to keep in conversation history */
  maxMessages: number;
  /** Number of system message slots reserved at the start */
  systemMessageSlots: number;
}

export const DEFAULT_CONVERSATION_WINDOW: ConversationWindowConfig = {
  maxMessages: 40,
  systemMessageSlots: 1,
};

// =============================================================================
// SESSION CONFIG
// =============================================================================

export interface SessionConfig {
  /** Storage backend: 'redis' or 'memory' */
  store: 'redis' | 'memory';
  /** Conversation window size */
  conversationWindow: number;
  /** Max entries in pod-local IR cache (L1) */
  irCacheMaxEntries: number;
  /** Execution lock TTL in ms */
  lockTtlMs: number;
  /** Session TTL in minutes (for Redis expiry) */
  sessionTtlMinutes: number;
  /** Whether cold storage (MongoDB session_states) is enabled */
  coldStorageEnabled: boolean;
  /** Cold storage TTL in days */
  coldTtlDays: number;
  /** Debounce repeated cold-storage upserts to reduce Mongo write pressure */
  coldPersistDebounceMs: number;
  /** Whether auto-compaction is enabled */
  compactionEnabled: boolean;
  /** Trigger auto-compact when context usage exceeds this ratio (0-1) */
  autoCompactThreshold: number;
  /** Model to use for compaction summaries */
  compactionModel: string;
}

export const DEFAULT_SESSION_CONFIG: SessionConfig = {
  store: 'memory',
  conversationWindow: 40,
  irCacheMaxEntries: 200,
  lockTtlMs: 5000,
  sessionTtlMinutes: 1440, // 24 hours — prevents premature conversation data loss
  coldStorageEnabled: true, // MongoDB backup when Redis expires — prevents data loss on eviction
  coldTtlDays: 90, // 90 days cold storage — aligns with BUSINESS plan retention
  coldPersistDebounceMs: 2000, // Coalesce repeated hot-session upserts before writing to Mongo
  compactionEnabled: false,
  autoCompactThreshold: 0.8,
  compactionModel: 'gpt-4o-mini',
};
