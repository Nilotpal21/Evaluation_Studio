/**
 * Pipeline Types
 *
 * Shared interfaces consumed by all pipeline modules (session-factory,
 * message-pipeline, lifecycle-manager). These types standardize the
 * input/output contracts across all 5 realtime channel handlers.
 */

import type { RuntimeSession, ExecutionResult } from '../../services/runtime-executor.js';
import type { ResolvedAgent } from '../../services/deployment-resolver.js';
import type {
  AgentSessionLifecycleConfig,
  Channel,
  Environment,
} from '@abl/compiler/platform/core/types';
import type {
  CallerContext,
  ChannelArtifactType,
  IdentityTier,
  VerificationMethod,
} from '@agent-platform/shared-auth';
import type { InteractionContextInput } from '@agent-platform/shared-kernel';
import type { ExecuteMessageOptions } from '../../services/execution/types.js';
import type { ExecutionScope } from '../../services/session/execution-scope.js';

// =============================================================================
// SESSION CREATION
// =============================================================================

/** Input for creating a runtime session via the 3-tier resolution chain. */
export interface SessionCreationContext {
  projectId: string;
  tenantId?: string;
  deploymentId?: string;
  environment?: string;
  agentName?: string;
  /** Canonical external/stored session identifier to reuse during bootstrap. */
  sessionId?: string;
  channelType: string;
  userId?: string;
  authToken?: string;
  /** Allow working copy fallback when no deployment/env specified (debug only). */
  allowWorkingCopy?: boolean;
  /** Await LLM client readiness after session creation (needed by channel workers). */
  ensureLLMReady?: boolean;
  /** Caller identity extracted from channel message metadata. */
  callerContext?: CallerContext;
  /** Arbitrary client-supplied data merged into the runtime session namespace. */
  callerData?: Record<string, unknown>;
  /** Canonical interaction-context input forwarded during session bootstrap. */
  interactionContext?: InteractionContextInput;
  /** Integration-supplied session metadata → stored at session.data.values._metadata */
  metadata?: Record<string, unknown>;
  /** Validated canonical execution scope for production/debug/system bootstrap paths. */
  scope?: ExecutionScope;
}

/** Result of createRuntimeSession — the runtime session + resolved metadata. */
export interface SessionCreationResult {
  runtimeSession: RuntimeSession;
  entryAgentName: string;
  /** Populated when the deployment path was used. */
  resolved?: ResolvedAgent;
}

/** Input for creating + linking a DB session to a runtime session. */
export interface DBSessionCreationContext {
  channel: Channel;
  agentName: string;
  agentVersion: string;
  environment: Environment;
  projectId: string;
  tenantId?: string;
  initiatedById?: string;
  deploymentId?: string;
  sessionId: string;
  customerId?: string;
  anonymousId?: string;
  sessionPrincipalId?: string;
  contactId?: string;
  channelArtifact?: string;
  channelArtifactType?: ChannelArtifactType;
  identityTier?: IdentityTier;
  verificationMethod?: VerificationMethod;
  channelId?: string;
  callerNumber?: string;
  metadata?: Record<string, unknown>;
  /** Experiment ID from runtime session assignment. */
  experimentId?: string;
  /** Experiment group from runtime session assignment. */
  experimentGroup?: 'control' | 'experiment';
}

/** Result of createAndLinkDBSession. */
export interface DBSessionResult {
  dbSessionId: string;
}

// =============================================================================
// TRACE ACCUMULATION
// =============================================================================

/** Token/cost counters accumulated during a single message turn. */
export interface TraceAccumulator {
  tokensIn: number;
  tokensOut: number;
  cost: number;
  traceCount: number;
  errorCount: number;
  handoffCount: number;
}

// =============================================================================
// MESSAGE PIPELINE
// =============================================================================

/** Context for fire-and-forget message persistence. */
export interface PersistenceContext {
  dbSessionId: string;
  channel: Channel;
  tenantId?: string;
  contactId?: string;
  projectId?: string;
}

/** Options for executeAndPersist. */
export interface ExecuteAndPersistOptions {
  sessionId: string;
  userText: string;
  /** Streaming callback (transport-specific). */
  onChunk?: (chunk: string) => void;
  /** Additional trace processing (handler-specific: WS emit, ClickHouse). */
  onTraceEventExtra?: (event: { type: string; data: Record<string, unknown> }) => void;
  /** Use LLM queue backpressure when enabled. */
  useLLMQueue?: boolean;
  tenantId?: string;
  /** Omit to skip DB writes. */
  persistence?: PersistenceContext;
  /** Execution options forwarded to executor.executeMessage (e.g. file attachments, channel metadata). */
  execOptions?: ExecuteMessageOptions;
}

/** Result from executeAndPersist. */
export interface ExecuteAndPersistResult {
  result: ExecutionResult;
  accumulator: TraceAccumulator;
}

// =============================================================================
// LIFECYCLE
// =============================================================================

/** Context for handling disconnect cleanup. */
export interface DisconnectContext {
  channel: Channel;
  sessionId?: string;
  dbSessionId?: string;
  userId?: string;
  tenantId?: string;
  projectId?: string;
  agentName?: string;
  agentLifecycle?: AgentSessionLifecycleConfig;
  sessionStartedAt?: Date;
}
