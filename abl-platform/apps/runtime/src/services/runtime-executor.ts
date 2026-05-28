/**
 * Runtime Executor
 *
 * Integrates with the real Agent ABL runtime engine from @abl/compiler.
 * Provides real LLM calls via Anthropic and mocked tool implementations.
 *
 * Supports ABL action constructs:
 * - TOOLS: External function calls (with mocks)
 * - HANDOFF: Route conversation to another agent
 * - DELEGATE: Call another agent and use its result
 * - COMPLETE: End conversation
 * - ESCALATE: Transfer to human agent (mocked with echo)
 *
 * UNIFICATION NOTE: This runtime is being unified with ConstructExecutor.
 * The shared FlowExecutor in @abl/compiler now supports all FLOW features:
 * - GATHER (flexible multi-field collection)
 * - Digressions (intent-based escapes with goto/delegate/resume)
 * - Sub-intents (scoped to current step)
 * - ON_SUCCESS/ON_FAILURE branching
 * - Corrections detection
 *
 * See adapters/ directory for integration helpers:
 * - MockToolExecutor: Implements ToolExecutor with mock responses
 * - TestAgentRegistry: Implements ConstructAgentRegistry for handoff/delegate
 * - TestTraceManager: Implements TraceContextManager for Observatory
 *
 * LLM client is now per-session via SessionLLMClient (services/llm/session-llm-client.ts)
 * with multi-level model resolution (agent IR → agent DB → project DB → org DB → env).
 */

import crypto from 'crypto';
import { AppError, ErrorCodes, type InteractionContextInput } from '@agent-platform/shared-kernel';
import { formatErrorSync } from '@agent-platform/i18n';
import { getTraceStore } from './trace-store.js';
import { initializeSessionMetadata, updateSessionMetadata } from './session-metadata.js';
import {
  FillerMessageService,
  generatePipelineFiller,
  buildStaticFillerCandidate,
  normalizeFillerStatusText,
  resolveFillerConfig,
  resolveFillerRuntimeConfig,
  resolveFillerModel,
  StatusTagParser,
} from './filler/index.js';
import type { StatusOperation } from './filler/types.js';
import { resolveRuntimePromptOverride } from './prompt-library/runtime-prompt-overrides.js';
// NOTE: ClickHouse trace singleton removed — all persistence goes through EventStore (platform_events)
import type { TraceEventWithId, TraceEventType } from '../types/index.js';

// Import parser from core
import { parseAgentBasedABL } from '@abl/core';

// Import compiler functions
import {
  compileABLtoIR,
  DEFAULT_MESSAGES,
  SYSTEM_TOOL_RETURN_TO_PARENT,
  scrubTraceEvent,
} from '@abl/compiler';
import { createLogger, PIIVault } from '@abl/compiler/platform';
import { getCurrentTraceId } from '@abl/compiler/platform/observability';
import { isDatabaseAvailable, isDatabaseReady } from '../db/index.js';
import { findExternalAgentConfigByName } from '@agent-platform/shared/repos';
import { tracePath, computeConfigHash } from '@agent-platform/shared-observability/sti';
import { getChannelManifest } from '../channels/manifest.js';
import { renderTextForLLMWithPIIRedaction } from './execution/pii-llm-redaction.js';
import { protectSessionOutputForUser } from './execution/session-output-protection.js';
import { getLlmOperatorDiagnostic } from './llm/classify-llm-error.js';
import { buildRuntimeErrorEnvelope } from './execution/runtime-error-envelope.js';
import {
  ProjectRuntimeConfigResolutionError,
  resolveProjectRuntimeConfig,
} from './config/project-runtime-config-resolver.js';
import { refreshSessionPIIContext } from './pii/session-pii-context.js';
import { evaluateProjectExecutionReadiness } from './session/project-agent-dsl-readiness.js';
import {
  accumulateResponseProvenance,
  buildResponseMessageMetadata,
  createResponseProvenanceAccumulator,
} from './channel/response-provenance.js';
import { buildMessageAgentPayload } from './event-bus/message-event-payload.js';
import { renderPayloadForPipelineEvent } from './event-bus/pii-event-boundary.js';
import { emitToEventStore } from './trace/emit-to-eventstore.js';
import {
  attachRuntimeTraceCausalData,
  createRuntimeTraceCausalTracker,
} from './trace/causal-envelope.js';

const log = createLogger('runtime-executor');
type EventStoreSingletonModule = typeof import('./eventstore-singleton.js');
let eventStoreSingletonPromise: Promise<EventStoreSingletonModule> | undefined;

function loadEventStoreSingleton(): Promise<EventStoreSingletonModule> {
  eventStoreSingletonPromise ??= import('./eventstore-singleton.js').catch((error) => {
    eventStoreSingletonPromise = undefined;
    throw error;
  });
  return eventStoreSingletonPromise;
}

function formatRuntimeAsyncError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function isEnvironmentTeardownError(err: unknown): boolean {
  const errorText = err instanceof Error ? `${err.message}\n${err.stack ?? ''}` : String(err ?? '');
  return errorText.includes('after the environment was torn down');
}

function warnIfRuntimeStillAlive(
  message: string,
  metadata: Record<string, unknown>,
  err: unknown,
): void {
  if (isEnvironmentTeardownError(err)) {
    return;
  }

  log.warn(message, {
    ...metadata,
    error: formatRuntimeAsyncError(err),
  });
}

function errorIfRuntimeStillAlive(
  message: string,
  metadata: Record<string, unknown>,
  err: unknown,
): void {
  if (isEnvironmentTeardownError(err)) {
    return;
  }

  log.error(message, {
    ...metadata,
    error: formatRuntimeAsyncError(err),
  });
}

function hasRenderableAgentMessagePayload(
  result: Pick<
    ExecutionResult,
    'response' | 'richContent' | 'actions' | 'voiceConfig' | 'localization'
  >,
): boolean {
  return Boolean(
    result.response ||
    result.richContent ||
    result.actions ||
    result.voiceConfig ||
    result.localization,
  );
}

function applyExecutionResponseVisibility(
  result: ExecutionResult,
  options: ExecuteMessageOptions | undefined,
): ExecutionResult {
  if (options?.responseVisibility !== 'internal') {
    return result;
  }

  return {
    ...result,
    responseMetadata: {
      ...(result.responseMetadata ??
        buildResponseMessageMetadata(createResponseProvenanceAccumulator())),
      responseVisibility: 'internal',
      deliveredToUser: false,
      coordination: {
        visibility: 'internal',
        suppressChildOutput: true,
        ...(options.messageSource ? { source: options.messageSource } : {}),
        ...(options.sourceAgent ? { sourceAgent: options.sourceAgent } : {}),
      },
    },
  };
}

function restoreConversationHistoryLength(
  session: RuntimeSession,
  snapshot: {
    sessionHistoryLength: number;
    activeThreadHistoryLength?: number;
    activeThreadHistory?: RuntimeSession['conversationHistory'];
  },
): void {
  if (session.conversationHistory.length > snapshot.sessionHistoryLength) {
    session.conversationHistory.splice(snapshot.sessionHistoryLength);
  }

  if (
    snapshot.activeThreadHistory &&
    snapshot.activeThreadHistory !== session.conversationHistory &&
    snapshot.activeThreadHistoryLength !== undefined &&
    snapshot.activeThreadHistory.length > snapshot.activeThreadHistoryLength
  ) {
    snapshot.activeThreadHistory.splice(snapshot.activeThreadHistoryLength);
  }
}

function isGoogleRealtimeSession(session: RuntimeSession): boolean {
  const sessionNamespace = session.data.values.session;
  return (
    !!sessionNamespace &&
    typeof sessionNamespace === 'object' &&
    (sessionNamespace as Record<string, unknown>).s2sProvider === 's2s:google'
  );
}

/**
 * Resolve the scrubPII setting from tenant config.
 * Defaults to true (fail-safe: scrub if config unavailable).
 */
async function resolveScrubPII(tenantId: string | undefined): Promise<boolean> {
  if (!tenantId) return true;
  try {
    const { getTenantConfigService } = await import('./tenant-config.js');
    const tenantCfg = await getTenantConfigService().getConfigAsync(tenantId);
    return tenantCfg?.security?.scrubPII ?? true;
  } catch {
    return true; // fail-safe: scrub if config unavailable
  }
}

type RuntimeTraceHandler = (event: { type: string; data: Record<string, unknown> }) => void;

const centralizedTraceHandlers = new WeakMap<RuntimeTraceHandler, string>();

function markCentralizedTraceHandler(
  handler: RuntimeTraceHandler,
  sessionId: string,
): RuntimeTraceHandler {
  centralizedTraceHandlers.set(handler, sessionId);
  return handler;
}

function inheritsCentralizedTraceHandler(
  handler: RuntimeTraceHandler,
  wrappedHandler: RuntimeTraceHandler | undefined,
  sessionId: string,
): void {
  if (wrappedHandler && centralizedTraceHandlers.get(wrappedHandler) === sessionId) {
    markCentralizedTraceHandler(handler, sessionId);
  }
}

function resolveRuntimeTurnId(candidate: unknown): string {
  return typeof candidate === 'string' && candidate.length > 0 ? candidate : crypto.randomUUID();
}

async function ensureSessionPIIVault(session: RuntimeSession): Promise<void> {
  await refreshSessionPIIContext(session);
}

async function renderUserMessageForFillerModel(
  session: RuntimeSession,
  userMessage: string,
): Promise<string> {
  await ensureSessionPIIVault(session);

  return renderTextForLLMWithPIIRedaction(session, userMessage);
}

// Import types from platform
import type { AgentIR, CompilationOutput, ToolDefinition } from '@abl/compiler';
import type { MessageContent } from './session/types.js';
import type { StreamingGuardrailEvaluator as StreamingGuardrailEvaluatorType } from './guardrails/streaming-evaluator.js';
import type {
  createGuardrailPipeline as CreateGuardrailPipelineFn,
  createLLMEvalFromClient as CreateLLMEvalFn,
  ensureTenantProvidersLoaded as EnsureTenantProvidersFn,
} from './guardrails/pipeline-factory.js';
import type {
  getSessionPolicy as GetSessionPolicyFn,
  getSessionGuardrailCacheScopeKey as GetSessionGuardrailCacheScopeKeyFn,
  getSessionStreamingConfig as GetSessionStreamingConfigFn,
  toStreamingEvalConfig as ToStreamingEvalConfigFn,
} from './execution/session-policy.js';

/** Extract plain text from message content (string or ContentBlock[]) */
function contentToString(content: MessageContent): string {
  if (typeof content === 'string') return content;
  return content
    .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
    .map((b) => b.text)
    .join('\n');
}

function extractVisibleResponseText(result: unknown): string | undefined {
  if (typeof result === 'string' && result.trim()) {
    return result;
  }

  if (!result || typeof result !== 'object') {
    return undefined;
  }

  if ('response' in result && typeof result.response === 'string' && result.response.trim()) {
    return result.response;
  }

  if ('message' in result && typeof result.message === 'string' && result.message.trim()) {
    return result.message;
  }

  return undefined;
}

/**
 * Ensure the current turn's user message exists in the active thread history.
 *
 * Forwarded handoff turns are special:
 * - if the child thread was seeded with parent history and already ends with the
 *   forwarded user turn, reuse that entry
 * - otherwise append the forwarded turn so the child agent has a real prompt
 *
 * Returns the index of the current turn's user entry, or null when the turn is
 * an internal replay that should not be persisted.
 */
function ensureCurrentTurnUserHistoryEntry(params: {
  session: RuntimeSession;
  userMessage: string;
  rawUserMessage: string;
  isResumeIntentReplay: boolean;
  isMessageForwardedFromHandoff: boolean;
}): number | null {
  const {
    session,
    userMessage,
    rawUserMessage,
    isResumeIntentReplay,
    isMessageForwardedFromHandoff,
  } = params;

  if (isResumeIntentReplay) {
    return null;
  }

  if (!isMessageForwardedFromHandoff) {
    return session.conversationHistory.push({ role: 'user', content: userMessage }) - 1;
  }

  const lastHistoryIndex = session.conversationHistory.length - 1;
  const lastHistoryEntry = session.conversationHistory[lastHistoryIndex];

  if (lastHistoryEntry?.role === 'user') {
    const existingText = contentToString(lastHistoryEntry.content);
    if (existingText === userMessage || existingText === rawUserMessage) {
      if (
        typeof lastHistoryEntry.content === 'string' &&
        lastHistoryEntry.content !== userMessage
      ) {
        session.conversationHistory[lastHistoryIndex] = {
          ...lastHistoryEntry,
          content: userMessage,
        };
      }
      return lastHistoryIndex;
    }
  }

  return session.conversationHistory.push({ role: 'user', content: userMessage }) - 1;
}

function sanitizeEscalatedSessionDisplay(value: string, maxLength = 200): string {
  return value
    .replace(/<[^>]*>/g, '')
    .replace(/[*_~`#\[\]]/g, '')
    .slice(0, maxLength);
}

function buildEscalatedSessionMockResponse(
  userMessage: string,
  escalationReason: string | undefined,
): { response: string; resolvedReason: string } {
  const resolvedReason =
    escalationReason && escalationReason.trim().length > 0
      ? sanitizeEscalatedSessionDisplay(escalationReason)
      : 'Not specified';
  const safeUserMessage = sanitizeEscalatedSessionDisplay(userMessage, 500);

  return {
    response: `[HUMAN AGENT] Message received: ${safeUserMessage}\nReason: ${resolvedReason}`,
    resolvedReason,
  };
}

function buildConversationCompleteResult(
  session: RuntimeSession,
  options?: {
    agentName?: string;
    agentIR?: AgentIR | null;
    actionMessage?: string;
  },
) {
  const completionMessage = resolveLocalizedAgentMessageWithMetadata({
    session,
    agentName: options?.agentName,
    agentIR: options?.agentIR ?? undefined,
    messageKey: 'conversation_complete',
    fallbackMessage:
      options?.agentIR?.messages?.conversation_complete ||
      session.agentIR?.messages?.conversation_complete ||
      DEFAULT_MESSAGES.conversation_complete,
  });

  return {
    response: completionMessage.text,
    localization: completionMessage.localization,
    action: {
      type: 'complete' as const,
      message: options?.actionMessage ?? 'Session already complete',
    },
  };
}

function clearEscalationStateForBotResume(session: RuntimeSession): void {
  session.isEscalated = false;
  session.transferInitiated = false;
  session.escalationReason = undefined;

  const activeThread = getActiveThread(session);
  if (activeThread && activeThread.status === 'escalated') {
    activeThread.status = 'active';
    syncThreadToSession(session);
    session.transferInitiated = false;
    session.escalationReason = undefined;
  }
}

type FillerTraceEvent = {
  type: string;
  data?: Record<string, unknown>;
};

function resolveAgentExitResponseDisposition(lifecycleResult: string): string {
  switch (lifecycleResult) {
    case 'continue':
      return 'continued';
    case 'respond':
      return 'responded';
    case 'complete':
      return 'completed';
    case 'handoff':
      return 'handoff';
    case 'delegate':
      return 'delegated';
    case 'fan_out':
      return 'fan_out';
    case 'escalate':
      return 'escalated';
    case 'constraint_blocked':
      return 'blocked';
    case 'error':
      return 'error';
    default:
      return lifecycleResult;
  }
}

function isCompletedToolCallTrace(data: Record<string, unknown> | undefined): boolean {
  if (!data) {
    return false;
  }

  return (
    data.phase === 'complete' ||
    data.latencyMs !== undefined ||
    data.durationMs !== undefined ||
    data.output !== undefined ||
    data.result !== undefined ||
    data.success !== undefined ||
    data.status === 'rejected' ||
    data.status === 'success' ||
    data.status === 'error'
  );
}

/** Map trace events to filler operation categories */
function traceToFillerOperation(event: FillerTraceEvent): StatusOperation | null {
  switch (event.type) {
    case 'tool_call_start':
      return 'tool_call';
    case 'tool_call':
      if (isCompletedToolCallTrace(event.data)) {
        return null;
      }
      return 'tool_call';
    case 'handoff':
    case 'handoff_progress':
      return 'handoff';
    case 'delegate_start':
    case 'fan_out_start':
      return 'delegation';
    case 'dsl_collect':
      return 'extraction';
    case 'constraint_check':
      return 'constraint_check';
    default:
      return null;
  }
}

/** Determine whether a channel type requires immediate persistence (no debounce) */
function shouldPersistImmediately(channelType: string | undefined): boolean {
  if (!channelType) {
    return false;
  }

  const manifest = getChannelManifest(channelType);
  if (!manifest) {
    return channelType === 'http' || channelType === 'api';
  }

  return manifest.delivery === 'sync_response' && manifest.ingress !== 'websocket';
}

const SESSION_KEY_MESSAGE_METADATA = 'message_metadata';

interface MessageMetadataRestoreState {
  hadFlatValue: boolean;
  previousFlatValue: unknown;
  hadSessionValue: boolean;
  previousSessionValue: unknown;
}

function getSessionNamespace(session: RuntimeSession): Record<string, unknown> {
  const namespace = session.data.values.session;
  if (namespace && typeof namespace === 'object' && !Array.isArray(namespace)) {
    return namespace as Record<string, unknown>;
  }

  const nextNamespace: Record<string, unknown> = {};
  session.data.values.session = nextNamespace;
  return nextNamespace;
}

function readRuntimeSessionString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

function readRuntimeNestedString(
  record: Record<string, unknown>,
  key: string,
  nestedKey: string,
): string | undefined {
  const nested = record[key];
  if (!nested || typeof nested !== 'object' || Array.isArray(nested)) {
    return undefined;
  }

  return readRuntimeSessionString((nested as Record<string, unknown>)[nestedKey]);
}

function resolveRuntimeTransferParentConversationSessionId(
  session: RuntimeSession,
): string | undefined {
  const values = session.data.values;

  return (
    readRuntimeNestedString(values, 'session', 'conversationSessionId') ??
    readRuntimeSessionString(values.conversation_session_id) ??
    readRuntimeNestedString(values, '_metadata', 'conversationSessionId') ??
    session.id
  );
}

function applyMessageMetadataToSession(
  session: RuntimeSession,
  messageMetadata: SdkMessageMetadata | undefined,
): MessageMetadataRestoreState | undefined {
  if (!messageMetadata) {
    return undefined;
  }

  const sessionNamespace = getSessionNamespace(session);
  const restoreState: MessageMetadataRestoreState = {
    hadFlatValue: Object.prototype.hasOwnProperty.call(
      session.data.values,
      SESSION_KEY_MESSAGE_METADATA,
    ),
    previousFlatValue: session.data.values[SESSION_KEY_MESSAGE_METADATA],
    hadSessionValue: Object.prototype.hasOwnProperty.call(sessionNamespace, 'messageMetadata'),
    previousSessionValue: sessionNamespace.messageMetadata,
  };

  // Canonical agent-facing access is `session.messageMetadata`.
  // Preserve the flat `message_metadata` alias for tool context_access and
  // backwards compatibility with existing runtime authoring patterns.
  session.data.values[SESSION_KEY_MESSAGE_METADATA] = cloneSdkMessageMetadata(messageMetadata);
  sessionNamespace.messageMetadata = cloneSdkMessageMetadata(messageMetadata);
  return restoreState;
}

function restoreMessageMetadataOnSession(
  session: RuntimeSession,
  restoreState: MessageMetadataRestoreState | undefined,
): void {
  if (!restoreState) {
    return;
  }

  if (restoreState.hadFlatValue) {
    session.data.values[SESSION_KEY_MESSAGE_METADATA] = restoreState.previousFlatValue;
  } else {
    delete session.data.values[SESSION_KEY_MESSAGE_METADATA];
  }

  const sessionNamespace = getSessionNamespace(session);
  if (restoreState.hadSessionValue) {
    sessionNamespace.messageMetadata = restoreState.previousSessionValue;
  } else {
    delete sessionNamespace.messageMetadata;
  }
}

function resolveAgentDefaultInteractionInput(
  agentIR: AgentIR | null | undefined,
): InteractionContextInput | undefined {
  if (
    typeof agentIR?.identity?.language !== 'string' ||
    agentIR.identity.language.trim().length === 0
  ) {
    return undefined;
  }

  return {
    language: agentIR.identity.language,
  };
}

function extractInteractionContextFromSdkMessageMetadata(
  messageMetadata: SdkMessageMetadata | undefined,
): InteractionContextInput | undefined {
  if (!messageMetadata) {
    return undefined;
  }

  const direct = normalizeInteractionContextInput(
    {
      language: typeof messageMetadata.language === 'string' ? messageMetadata.language : undefined,
      locale: typeof messageMetadata.locale === 'string' ? messageMetadata.locale : undefined,
      timezone: typeof messageMetadata.timezone === 'string' ? messageMetadata.timezone : undefined,
    },
    'sanitize',
  );
  const nested = extractInteractionContextFromMetadata(
    messageMetadata as Record<string, unknown>,
    'sanitize',
  );

  return mergeInteractionContextInputs(
    direct.success ? direct.data : undefined,
    nested.success ? nested.data : undefined,
  );
}

// Import adapters (for unified execution)
export { TestAgentRegistry, TestTraceManager } from './adapters/index.js';
export { MockToolExecutor } from './execution/mock-tool-executor.js';

// =============================================================================
// TYPES — Re-exported from execution/types.ts for backward compatibility
// =============================================================================

export type {
  SessionDataStore,
  AgentThread,
  RuntimeSession,
  RuntimeState,
  RuntimeExecutorConfig,
  ExecutionResult,
  SubTaskResult,
  FanOutResult,
  AgentRegistryEntry,
  AgentRegistry,
  DelegateConfigIR,
  ExecutorContext,
  ExecuteMessageOptions,
} from './execution/types.js';

export {
  getGatherProgress,
  getActiveThread,
  applyResponseMetadataToLatestAssistantMessage,
  buildExecutionResultContentEnvelope,
  buildFailedHandoffExecutionResult,
  buildHandoffExecutionResult,
  createThread,
  createInitialThread,
  syncThreadToSession,
  tryThreadReturn,
  compileToResolvedAgent,
  resolveProjectTools,
  resolveProjectToolsFromDocuments,
} from './execution/types.js';

// Re-export value resolution for backward compatibility
export { interpolateTemplate } from './execution/value-resolution.js';

// Memory integration — fire-and-forget safe facade
import { initializeAllMemory } from './execution/memory-integration.js';
import { refreshExecutionTreeProjection } from './execution/memory-scope-runtime.js';
import {
  createMongoDBFactStore,
  createProjectFactStore,
  PROJECT_SCOPE_USER_ID,
} from './stores/mongodb-fact-store.js';
import {
  resolveRuntimeSessionUserId,
  rewireRuntimeSessionFactStores,
} from './session/runtime-session-identity.js';

// Re-export prompt building & routing utilities for backward compatibility
export { buildSystemPrompt, buildTools, ablTypeToJsonSchema } from './execution/prompt-builder.js';
export { deduplicateFanOutTasks, formatFanOutToolResult } from './execution/routing-executor.js';

// Import for internal use within this file
import {
  getActiveThread,
  applyResponseMetadataToLatestAssistantMessage,
  buildExecutionResultContentEnvelope,
  buildFailedHandoffExecutionResult,
  buildHandoffExecutionResult,
  createInitialThread,
  isPostTransferCloseoutMessage,
  POST_TRANSFER_CLOSEOUT_WINDOW_MS,
  tryThreadReturn,
  syncThreadToSession,
  compileToResolvedAgent,
} from './execution/types.js';
import { AgentRegistryStore } from './execution/agent-registry.js';
import { buildSessionScopedAgentRegistry } from './execution/session-agent-registry.js';
import { resolveVersionString } from './execution/agent-version-utils.js';
import { findGoogleRealtimeDeclaringThreadIndex as resolveGoogleRealtimeDeclaringThreadIndex } from './voice/korevg/google-realtime-tool-routing.js';

import type {
  SessionDataStore,
  AgentThread,
  RuntimeSession,
  RuntimeState,
  RuntimeExecutorConfig,
  ExecutionResult,
  SubTaskResult,
  FanOutResult,
  AgentRegistryEntry,
  AgentRegistry,
  DelegateConfigIR,
  ExecutorContext,
  ExecuteMessageOptions,
} from './execution/types.js';

import {
  checkConstraints,
  checkFlatConstraints,
  handleConstraintViolation,
  setCurrentTurnInputContext,
} from './execution/constraint-checker.js';

import { buildSystemPrompt, buildTools, isVoiceChannel } from './execution/prompt-builder.js';

import { stripForVoice, stripForVoiceStreamChunk } from './channel/channel-adapter.js';

import { LLMWiringService } from './execution/llm-wiring.js';

import {
  RoutingExecutor,
  applyHandoffOnReturnEffects,
  combineVisibleResponses,
  dispatchHandoffOnReturnBehavior,
  resolveHandoffOnReturnBehavior,
} from './execution/routing-executor.js';
import {
  FlowStepExecutor,
  SESSION_KEY_ACTION_EVENT,
  detectParentSupervisorRoute,
  toGatherInterruptTrace,
} from './execution/flow-step-executor.js';
import { ReasoningExecutor } from './execution/reasoning-executor.js';
import { CompactionEngine } from './session/compaction-engine.js';

import {
  applyProfileInteractionContextToSessionData,
  assembleProfileContext,
  buildEffectiveConfig,
  extractProfileInteractionContextFromMetadata,
  mergeProfileInteractionContextInputs,
  readProfileInteractionContextFromSessionData,
  resolveActiveProfiles,
  type EffectiveAgentConfig,
} from './execution/profile-resolver.js';
import { buildConversationBehaviorTraceSummary } from './execution/conversation-behavior-resolver.js';
import {
  extractInteractionContextFromContactPreferences,
  extractInteractionContextFromMetadata,
  extractLegacyClientInfoInteractionContext,
  inferInteractionContextFromUserMessage,
  mergeInteractionContextInputs,
  normalizeInteractionContextInput,
  readSessionInteractionState,
  resolveAndApplyInteractionContextToSessionData,
} from './execution/interaction-context.js';
import { resolveLocalizedAgentMessageWithMetadata } from './execution/localized-messages.js';

// =============================================================================
// LLM CLIENT (Session-scoped via ModelResolutionService)
// =============================================================================

// ToolDefinition, ToolCall, Message, ToolResultContent — now used in execution/reasoning-executor.ts
import type { ToolCall } from './llm/session-llm-client.js';

import type { ResolvedAgent } from './deployment-resolver.js';
import type { CallerContext } from '@agent-platform/shared-auth';
import type { EventBus, AnyPlatformEvent } from './event-bus/types.js';
import {
  cloneSdkMessageMetadata,
  type SdkMessageMetadata,
} from './identity/sdk-message-metadata.js';
import type { ExecutionScope, SessionLocator } from './session/execution-scope.js';
import { assertProductionExecutionScope } from './session/scope-policy.js';
import type { ResolvedToolDefinition } from './modules/types.js';
import { injectMissingModuleTools } from './modules/module-tool-injection.js';

// =============================================================================
// STALE SESSION REAPER CONSTANTS
// =============================================================================

interface RealtimeReasoningToolDispatcher {
  executeToolCall(
    session: RuntimeSession,
    toolCall: ToolCall,
    onChunk?: (chunk: string) => void,
    onTraceEvent?: (event: { type: string; data: Record<string, unknown> }) => void,
    llmCallId?: string,
  ): Promise<{
    toolResult: unknown;
    action?: { type: string; [key: string]: unknown };
    breakLoop?: boolean;
  }>;
}

function resolveScopeBackedSessionOptions(scope: ExecutionScope | undefined): {
  tenantId?: string;
  projectId?: string;
  sessionId?: string;
  callerContext?: CallerContext;
  userId?: string;
} {
  if (!scope) {
    return {};
  }

  if (scope.kind === 'production') {
    assertProductionExecutionScope(scope);
    return {
      tenantId: scope.tenantId,
      projectId: scope.projectId,
      sessionId: scope.sessionId,
      callerContext: scope.callerContext as unknown as CallerContext,
      userId:
        scope.subject.kind === 'contact' ? scope.subject.contactId : scope.subject.principalId,
    };
  }

  if (scope.kind === 'debug') {
    return {
      tenantId: scope.tenantId,
      projectId: scope.projectId,
      sessionId: scope.sessionId,
      userId:
        scope.actor.kind === 'platform_user'
          ? scope.actor.userId
          : scope.actor.kind === 'api_key'
            ? scope.actor.keyId
            : scope.actor.principalId,
    };
  }

  return {
    tenantId: scope.tenantId,
    projectId: scope.projectId,
    sessionId: scope.sessionId,
    userId: scope.actor.principalId,
  };
}

function buildSessionLocator(
  session:
    | Pick<RuntimeSession, 'id' | 'tenantId' | 'projectId' | 'executionScopeKind' | 'callerContext'>
    | undefined,
): SessionLocator | null {
  if (!session?.executionScopeKind || !session.tenantId) {
    return null;
  }

  if (session.executionScopeKind !== 'system' && !session.projectId) {
    return null;
  }

  return {
    kind: session.executionScopeKind,
    tenantId: session.tenantId,
    projectId: session.projectId,
    sessionId: session.id,
    ...(session.callerContext?.sessionPrincipalId || session.callerContext?.anonymousId
      ? {
          sessionPrincipalId:
            session.callerContext?.sessionPrincipalId ?? session.callerContext?.anonymousId,
        }
      : {}),
  };
}

function clearPendingRenderedPayload(
  session: Pick<
    RuntimeSession,
    'pendingResponse' | 'pendingRichContent' | 'pendingVoiceConfig' | 'pendingActions'
  >,
): void {
  session.pendingResponse = undefined;
  session.pendingRichContent = undefined;
  session.pendingVoiceConfig = undefined;
  session.pendingActions = undefined;
}

const MODULE_TOOL_DSL_DIRECTIVE_FIELDS: ReadonlyArray<keyof ToolDefinition> = [
  'store_result',
  'on_result',
  'on_error',
  'context_access',
  'confirmation',
  'pii_access',
  'compaction',
  'auth_profile_ref',
  'connection_mode',
  'consent_mode',
  'identity_tier_required',
  'jit_auth',
];

function mergeModuleResolvedToolDefinition(
  resolvedTool: ResolvedToolDefinition,
  agentTool: ToolDefinition,
): ToolDefinition {
  const materialized = { ...resolvedTool } as ToolDefinition;
  const materializedRecord = materialized as unknown as Record<string, unknown>;
  const agentToolRecord = agentTool as unknown as Record<string, unknown>;

  for (const field of MODULE_TOOL_DSL_DIRECTIVE_FIELDS) {
    const value = agentToolRecord[field];
    if (value !== undefined) {
      materializedRecord[field] = value;
    }
  }

  return materialized;
}

function materializeModuleResolvedTools(params: {
  agents: Record<string, AgentIR>;
  compilationOutput: CompilationOutput | null | undefined;
  resolvedTools?: Record<string, ResolvedToolDefinition>;
}): void {
  const { agents, compilationOutput, resolvedTools } = params;
  if (!resolvedTools || Object.keys(resolvedTools).length === 0) {
    return;
  }

  // Phase 1: Enrich existing tool stubs with resolved definitions
  const materializeAgentTools = (agent: AgentIR | undefined): void => {
    if (!agent?.tools?.length) {
      return;
    }

    let replaced = false;
    const materializedTools = agent.tools.map((tool) => {
      const resolvedTool = resolvedTools[tool.name];
      if (!resolvedTool) {
        return tool;
      }
      replaced = true;
      return mergeModuleResolvedToolDefinition(resolvedTool, tool);
    });

    if (replaced) {
      agent.tools = materializedTools;
    }
  };

  for (const agent of Object.values(agents)) {
    materializeAgentTools(agent);
  }
  for (const agent of Object.values(compilationOutput?.agents ?? {})) {
    materializeAgentTools(agent);
  }

  // Phase 2: Inject missing module tools that are referenced but not present
  for (const agent of Object.values(agents)) {
    injectMissingModuleTools(agent, resolvedTools);
  }
  for (const agent of Object.values(compilationOutput?.agents ?? {})) {
    injectMissingModuleTools(agent, resolvedTools);
  }
}

interface GuardrailModules {
  StreamingGuardrailEvaluator: typeof StreamingGuardrailEvaluatorType;
  createGuardrailPipeline: typeof CreateGuardrailPipelineFn;
  createLLMEvalFromClient: typeof CreateLLMEvalFn;
  ensureTenantProvidersLoaded: typeof EnsureTenantProvidersFn;
  getSessionPolicy: typeof GetSessionPolicyFn;
  getSessionGuardrailCacheScopeKey: typeof GetSessionGuardrailCacheScopeKeyFn;
  getSessionStreamingConfig: typeof GetSessionStreamingConfigFn;
  toStreamingEvalConfig: typeof ToStreamingEvalConfigFn;
}

let guardrailModules: GuardrailModules | null = null;
let guardrailModulesPromise: Promise<GuardrailModules> | null = null;

function getGuardrailModules(): GuardrailModules | null {
  return guardrailModules;
}

function loadGuardrailModules(): Promise<GuardrailModules> {
  if (guardrailModules) {
    return Promise.resolve(guardrailModules);
  }

  if (!guardrailModulesPromise) {
    guardrailModulesPromise = Promise.all([
      import('./guardrails/streaming-evaluator.js'),
      import('./guardrails/pipeline-factory.js'),
      import('./execution/session-policy.js'),
    ])
      .then(([evaluatorMod, pipelineMod, policyMod]) => {
        guardrailModules = {
          StreamingGuardrailEvaluator: evaluatorMod.StreamingGuardrailEvaluator,
          createGuardrailPipeline: pipelineMod.createGuardrailPipeline,
          createLLMEvalFromClient: pipelineMod.createLLMEvalFromClient,
          ensureTenantProvidersLoaded: pipelineMod.ensureTenantProvidersLoaded,
          getSessionPolicy: policyMod.getSessionPolicy,
          getSessionGuardrailCacheScopeKey: policyMod.getSessionGuardrailCacheScopeKey,
          getSessionStreamingConfig: policyMod.getSessionStreamingConfig,
          toStreamingEvalConfig: policyMod.toStreamingEvalConfig,
        };
        return guardrailModules;
      })
      .catch((err: unknown) => {
        guardrailModulesPromise = null;
        throw err;
      });
  }

  return guardrailModulesPromise;
}

/** How often to check for stale sessions (5 minutes) */
const STALE_SESSION_CHECK_INTERVAL_MS = 5 * 60 * 1000;

/** Sessions with no activity for this long are considered stale (30 minutes) */
const DEFAULT_SESSION_STALE_THRESHOLD_MS = 30 * 60 * 1000;

/** Maximum in-memory sessions per pod before forced eviction */
const MAX_IN_MEMORY_SESSIONS = 10_000;

// =============================================================================
// RUNTIME EXECUTOR
// =============================================================================

export class RuntimeExecutor {
  private config: RuntimeExecutorConfig;
  private sessions: Map<string, RuntimeSession> = new Map();
  private agentRegistry: AgentRegistry = {};
  readonly agentRegistryStore: AgentRegistryStore = new AgentRegistryStore();

  /** Active realtime voice executors, keyed by session ID */
  private realtimeVoiceExecutors: Map<
    string,
    import('./voice/realtime-voice-executor.js').RealtimeVoiceExecutor
  > = new Map();

  /** Debounce timers for session persistence (cleared on detach) */
  private persistDebounceTimers: Map<string, NodeJS.Timeout> = new Map();

  /** Periodic timer for stale session reaper */
  private staleReaperTimer: NodeJS.Timeout | null = null;
  private _reapInProgress = false;

  /** Sessions currently inside executeMessage — prevents stale-check rehydration during recursive calls (handoff/delegate) */
  private _executingSessions: Set<string> = new Set();

  /** NLU sidecar client — optional, requires NLU_SIDECAR_URL env var */
  private _nluSidecarClient: import('./nlu/sidecar-client.js').NLUSidecarClient | undefined;

  /** Async infrastructure for suspension/resumption — set after Redis init */
  private _asyncInfra?: {
    callbackRegistry: import('@agent-platform/execution').CallbackRegistry;
    suspensionStore: import('@agent-platform/execution').SuspensionStore;
    barrierStore: import('@agent-platform/execution').FanOutBarrierStore;
    callbackBaseUrl: string;
  };

  /** LLM wiring service — manages LLM client and tool executor lifecycle */
  private llmWiring: LLMWiringService;

  /** Routing executor — handles handoff, delegate, fan-out, escalate, complete */
  private routing: RoutingExecutor;
  private flowStep: FlowStepExecutor;
  private reasoning: ReasoningExecutor;

  /** Session-scoped tracer lifecycle management */
  private _tracerRegistry: import('./tracing/tracer-registry.js').TracerRegistry | null = null;

  // Cluster-ready session service (Sprint 1)
  private _sessionService: import('./session/session-service.js').SessionService | null = null;
  private _sessionServicePromise: Promise<
    import('./session/session-service.js').SessionService
  > | null = null;

  /** EventBus for centralized event production (set from server.ts after initialization) */
  private _eventBus: EventBus | null = null;

  /**
   * Get the SessionService instance (lazy-init via dynamic import for ESM).
   * Used by external callers (e.g. SessionFactory in Sprint 3).
   */
  private async getSessionServiceAsync(): Promise<
    import('./session/session-service.js').SessionService
  > {
    if (this._sessionService) return this._sessionService;
    if (!this._sessionServicePromise) {
      this._sessionServicePromise = import('./session/session-service.js').then((mod) => {
        this._sessionService = mod.getSessionService();
        return this._sessionService;
      });
    }
    return this._sessionServicePromise;
  }

  /** Synchronous accessor — returns null if not yet initialized */
  get sessionService(): import('./session/session-service.js').SessionService | null {
    return this._sessionService;
  }

  /** Set session service directly (for testing or explicit wiring) */
  setSessionService(svc: import('./session/session-service.js').SessionService): void {
    this._sessionService = svc;
  }

  /**
   * Get or lazily create the TracerRegistry singleton.
   * Lazy to avoid importing tracing modules when not needed (e.g. unit tests).
   */
  private async getTracerRegistryAsync(): Promise<
    import('./tracing/tracer-registry.js').TracerRegistry
  > {
    if (!this._tracerRegistry) {
      const { TracerRegistry } = await import('./tracing/tracer-registry.js');
      this._tracerRegistry = new TracerRegistry();
    }
    return this._tracerRegistry;
  }

  private clearInMemorySessionArtifacts(sessionId: string): void {
    if (!this.sessions.has(sessionId)) {
      return;
    }

    log.debug('[SESSION-MAP] session removed from in-memory map', {
      sessionId,
      mapSize: this.sessions.size,
    });

    this.agentRegistryStore.releaseOwner(sessionId);
    this.sessions.delete(sessionId);
    this.realtimeVoiceExecutors.delete(sessionId);
    this.llmWiring.clearCooldown(sessionId);
    this._executingSessions.delete(sessionId);

    if (this._tracerRegistry) {
      this._tracerRegistry.remove(sessionId);
    }

    const timer = this.persistDebounceTimers.get(sessionId);
    if (timer) {
      clearTimeout(timer);
      this.persistDebounceTimers.delete(sessionId);
    }

    import('./execution/memory-bridge-registry.js')
      .then(({ getMemoryBridgeRegistry }) => getMemoryBridgeRegistry().unregister(sessionId))
      .catch((err) => {
        log.warn('Failed to unregister memory bridge while replacing runtime session', {
          sessionId,
          error: err instanceof Error ? err.message : String(err),
        });
      });
  }

  /**
   * Wire a Tracer onto a session. Creates a WritePipelineImpl + TracerImpl via
   * TracerRegistry.getOrCreate, then attaches it to session.tracer.
   *
   * Synchronous variant that skips wiring if modules haven't been loaded yet.
   * Called from createSessionFromResolved — tracer will be lazily wired on
   * first executeMessage if not ready.
   */
  private wireTracer(session: RuntimeSession): void {
    // Fire-and-forget async wiring — tracer will be available by the time
    // executeMessage runs (which is always async and comes later).
    this.wireTracerAsync(session).catch((err) => {
      warnIfRuntimeStillAlive(
        'Tracer wiring failed — span context disabled for session',
        { sessionId: session.id },
        err,
      );
    });
  }

  private async wireTracerAsync(session: RuntimeSession): Promise<void> {
    const { WritePipelineImpl } = await import('./tracing/write-pipeline.js');
    const { getEventStore: getES } = await import('./eventstore-singleton.js');

    const enableScrubPII = await resolveScrubPII(session.tenantId);

    const writePipeline = new WritePipelineImpl({
      getTraceStore: () => {
        try {
          return getTraceStore();
        } catch {
          return null;
        }
      },
      getEventStore: () => {
        try {
          return getES();
        } catch {
          return null;
        }
      },
      broadcastToSession: () => {
        // WS broadcast is handled by the existing trace-emitter emit path;
        // the WritePipeline is for tracer-initiated span events only.
      },
      getPIIRecognizerRegistry: () => session.piiRecognizerRegistry,
      getKnownSource: () => session.knownSource,
      scrubPII: enableScrubPII,
    });

    const registry = await this.getTracerRegistryAsync();
    const tracer = registry.getOrCreate(session.id, {
      sessionId: session.id,
      tenantId: session.tenantId,
      projectId: session.projectId,
      writePipeline,
    });
    session.tracer = tracer;
  }

  /** Set EventBus for centralized event production (wired from server.ts) */
  setEventBus(bus: EventBus): void {
    this._eventBus = bus;
  }

  /** Async infrastructure accessor */
  get asyncInfra() {
    return this._asyncInfra;
  }

  /** Set async infrastructure after Redis initialization */
  setAsyncInfra(infra: {
    callbackRegistry: import('@agent-platform/execution').CallbackRegistry;
    suspensionStore: import('@agent-platform/execution').SuspensionStore;
    barrierStore: import('@agent-platform/execution').FanOutBarrierStore;
    callbackBaseUrl: string;
  }): void {
    this._asyncInfra = infra;
  }

  /** Immediately persist session to store (no debounce). Used before suspension. */
  async persistSession(session: RuntimeSession): Promise<void> {
    await this.saveSessionSnapshot(session);
  }

  constructor(config: RuntimeExecutorConfig = {}) {
    this.config = {
      timeoutMs: 30000,
      ...config,
    };

    log.info('LLM config', {
      hasApiKey: !!config.anthropicApiKey,
    });
    this.llmWiring = new LLMWiringService(this.config);
    // RoutingExecutor receives `this` as ExecutorContext — safe because
    // it only calls back during executeMessage, not during construction.
    this.routing = new RoutingExecutor(
      this as unknown as ExecutorContext,
      this.llmWiring,
      findExternalAgentConfigByName,
    );
    this.flowStep = new FlowStepExecutor(this as unknown as ExecutorContext, this.routing);
    this.reasoning = new ReasoningExecutor(
      this as unknown as ExecutorContext,
      this.routing,
      this.flowStep,
      new CompactionEngine(),
    );

    // Start the stale session reaper to enforce in-memory Map bounds
    this.startStaleReaper();
  }

  // ===========================================================================
  // STALE SESSION REAPER
  // ===========================================================================

  /**
   * Start the periodic stale session reaper.
   * Idempotent — calling multiple times is safe.
   */
  private startStaleReaper(): void {
    if (this.staleReaperTimer) return;

    this.staleReaperTimer = setInterval(() => {
      this.reapStaleSessions().catch((err) =>
        log.warn('Stale session reaper failed', {
          error: err instanceof Error ? err.message : String(err),
        }),
      );
    }, STALE_SESSION_CHECK_INTERVAL_MS);

    // Don't prevent process exit
    this.staleReaperTimer.unref();
  }

  /**
   * Scan in-memory sessions and evict those that are stale (no activity past
   * threshold), expired (past maxAgeSeconds), or excess (over MAX_IN_MEMORY_SESSIONS).
   *
   * Evicted sessions are persisted to the session store (best-effort) before
   * removal so they can be rehydrated by another pod on demand.
   */
  async reapStaleSessions(): Promise<void> {
    if (this._reapInProgress) return;
    this._reapInProgress = true;

    try {
      await this._doReap();
    } finally {
      this._reapInProgress = false;
    }
  }

  private async _doReap(): Promise<void> {
    const now = Date.now();
    const staleIds: string[] = [];

    for (const [id, session] of this.sessions) {
      // Skip sessions currently being executed — they are actively in use
      if (this._executingSessions.has(id)) continue;

      const lastActivity = session.lastActivityAt?.getTime() || 0;
      const age = now - lastActivity;

      // Check 1: Session exceeds stale threshold (no activity)
      if (age > DEFAULT_SESSION_STALE_THRESHOLD_MS) {
        staleIds.push(id);
        continue;
      }

      // Check 2: Session has maxAgeSeconds and exceeds absolute lifetime
      if (session.maxAgeSeconds) {
        const createdAt = session.createdAt?.getTime() || 0;
        const lifetimeMs = session.maxAgeSeconds * 1000;
        if (now - createdAt > lifetimeMs) {
          staleIds.push(id);
          continue;
        }
      }
    }

    // Check 3: If still over MAX_IN_MEMORY_SESSIONS, evict oldest by lastActivity
    const staleSet = new Set(staleIds);
    const remainingCount = this.sessions.size - staleIds.length;
    if (remainingCount > MAX_IN_MEMORY_SESSIONS) {
      const remaining = [...this.sessions.entries()]
        .filter(([id]) => !staleSet.has(id) && !this._executingSessions.has(id))
        .sort((a, b) => {
          const aTime = a[1].lastActivityAt?.getTime() || 0;
          const bTime = b[1].lastActivityAt?.getTime() || 0;
          return aTime - bTime; // oldest first
        });

      const excessCount = remainingCount - MAX_IN_MEMORY_SESSIONS;
      for (let i = 0; i < excessCount && i < remaining.length; i++) {
        staleIds.push(remaining[i][0]);
      }
    }

    if (staleIds.length === 0) return;

    log.info('Reaping stale sessions', { count: staleIds.length, total: this.sessions.size });

    for (const id of staleIds) {
      const session = this.sessions.get(id);
      const tenantId = session?.tenantId;

      // Persist final state before reaping (best-effort)
      if (session) {
        try {
          await this.saveSessionSnapshot(session);
        } catch (err) {
          log.warn('Failed to persist session before reap', {
            sessionId: id,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }

      // Shared in-memory cleanup: registry, sessions map, voice executors,
      // cooldowns, tracer, debounce timer, memory bridge.
      this.clearInMemorySessionArtifacts(id);

      // Clean up paused JIT auth executions (fire-and-forget)
      import('./auth-profile/paused-execution-store.js')
        .then(({ getPausedExecutionStore }) =>
          getPausedExecutionStore().cleanupSession(id, 'disconnect'),
        )
        .catch((err: unknown) =>
          log.warn('Paused execution cleanup failed during reap', {
            sessionId: id,
            error: err instanceof Error ? err.message : String(err),
          }),
        );

      // Release session slot for quota tracking (fire-and-forget)
      if (tenantId) {
        import('../middleware/rate-limiter.js')
          .then(({ releaseSessionSlot: release }) => release(tenantId, id))
          .catch((err) =>
            log.warn('Session count decrement failed during reap', {
              error: err instanceof Error ? err.message : String(err),
            }),
          );
      }
    }
  }

  /**
   * Stop the stale session reaper. Called during shutdown/cleanup.
   */
  stopStaleReaper(): void {
    if (this.staleReaperTimer) {
      clearInterval(this.staleReaperTimer);
      this.staleReaperTimer = null;
    }
  }

  /**
   * Register an agent in the registry for handoff/delegate.
   *
   * When `scope` is provided, the entry is also written to the composite-key
   * `AgentRegistryStore`, which is what session-scoped lookups prefer (see
   * `lookupAgentForSession`). Omitting `scope` writes only to the legacy flat
   * registry — this is the compatibility path used by test harnesses whose
   * sessions carry no `projectId`. New production callers must always pass a
   * scope so cross-project / cross-version isolation is enforced end to end.
   */
  registerAgent(
    agentName: string,
    dsl: string,
    scope?: { tenantId?: string; projectId: string; version: string; ownerId?: string },
  ): void {
    const parseResult = parseAgentBasedABL(dsl);
    let ir: AgentIR | null = null;

    if (parseResult.document) {
      try {
        const compilationOutput = compileABLtoIR([parseResult.document]);
        const entryName = compilationOutput.entry_agent;
        ir =
          (entryName ? compilationOutput.agents[entryName] : null) ||
          Object.values(compilationOutput.agents)[0] ||
          null;
      } catch (error) {
        log.error(`Failed to compile agent ${agentName}`, {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    const entry: AgentRegistryEntry = {
      dsl,
      ir,
      location: 'local',
      version: scope?.version,
    };
    this.agentRegistry[agentName] = entry;
    if (scope) {
      this.agentRegistryStore.register(
        scope.tenantId ? { tenantId: scope.tenantId, projectId: scope.projectId } : scope.projectId,
        agentName,
        scope.version,
        entry,
        {
          ownerId: scope.ownerId,
        },
      );
    }
    log.info(`Registered agent: ${agentName}`);
  }

  // NOTE: Remote agents are no longer stored in the registry. They are
  // resolved inline from the active agent's HANDOFF config at dispatch
  // time (see `lookupAgentForSession` / `resolveRemoteFromHandoff`).
  // This guarantees cross-project isolation — a remote URL declared in
  // project A's HANDOFF can never be reached from a session scoped to
  // project B, because the resolver only reads the session's own IR.

  /**
   * Check if runtime is properly configured.
   * Always true — LLM resolution happens per-session via ModelResolutionService.
   */
  isConfigured(): boolean {
    return true;
  }

  /**
   * Pre-flight check: verify tenant has capacity for a new session.
   * Call this before createSessionFromResolved().
   */
  async checkSessionQuota(tenantId: string, projectId?: string, sessionId?: string): Promise<void> {
    if (!tenantId) return; // No tenant = dev mode, skip
    try {
      const { claimSessionSlot, getTenantRateLimits } =
        await import('../middleware/rate-limiter.js');
      const limits = await getTenantRateLimits(tenantId, projectId);

      // Unlimited concurrent sessions — skip check
      if (limits.concurrentSessions === -1) return;

      // Atomically claim a session slot in the SET-based tracker.
      // Returns -1 if the limit has been reached.
      // If session creation fails after this, the caller MUST call releaseSessionSlot().
      const slotId = sessionId || crypto.randomUUID();
      const result = await claimSessionSlot(tenantId, slotId, limits.concurrentSessions);
      if (result === -1) {
        // The cached config may be stale (e.g. subscription upgraded mid-TTL).
        // Invalidate and re-check from DB before rejecting.
        const { getTenantConfigService } = await import('./tenant-config.js');
        const configService = getTenantConfigService();
        await configService.invalidateCache(tenantId);
        const freshLimits = await getTenantRateLimits(tenantId, projectId);

        if (freshLimits.concurrentSessions === -1) {
          // Plan was upgraded to unlimited — the stale session SET entries are
          // from the old plan and no longer meaningful. Claim succeeds.
          return;
        }

        // Re-check with fresh limit (plan may have been upgraded to a higher tier)
        if (freshLimits.concurrentSessions > limits.concurrentSessions) {
          const retry = await claimSessionSlot(tenantId, slotId, freshLimits.concurrentSessions);
          if (retry !== -1) return;
        }

        throw new AppError('Concurrent session limit exceeded', {
          ...ErrorCodes.TOO_MANY_REQUESTS,
          code: 'SESSION_LIMIT_EXCEEDED',
        });
      }
    } catch (err) {
      if (err instanceof AppError) throw err;
      // Rate limiter failure is non-fatal — allow session creation
      log.warn('Session limit check failed, allowing', {
        tenantId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * Release a pre-claimed session slot if session creation fails after checkSessionQuota.
   * Safe to call even if no slot was claimed (e.g., unlimited plan or rate limiter failure).
   */
  async releaseSessionSlot(tenantId: string, sessionId: string): Promise<void> {
    try {
      const { releaseSessionSlot: release } = await import('../middleware/rate-limiter.js');
      await release(tenantId, sessionId);
    } catch (err) {
      log.warn('Failed to release session slot', {
        tenantId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * Create a session from pre-resolved agents (from DeploymentResolver or compileToResolvedAgent).
   * This is the single session creation entry point.
   */
  createSessionFromResolved(
    resolved: ResolvedAgent,
    options: {
      tenantId?: string;
      projectId?: string;
      userId?: string;
      channelType?: string;
      authToken?: string;
      permissions?: string[];
      deploymentId?: string;
      sessionId?: string;
      callerContext?: CallerContext;
      /** Arbitrary client-supplied data — merged into session namespace for ABL agents */
      callerData?: Record<string, unknown>;
      /** Canonical interaction-context input forwarded during session bootstrap. */
      interactionContext?: InteractionContextInput;
      /** Integration-supplied metadata — stored at session.data.values._metadata (isolated namespace) */
      metadata?: Record<string, unknown>;
      /** Validated canonical execution scope for production/debug/system bootstrap paths. */
      scope?: ExecutionScope;
      /** Ephemeral execution sessions must not write production session, trace, or analytics state. */
      ephemeralExecution?: { kind: 'simulation'; scenarioId?: string };
      /** Per-tenant session max age from TenantSecurityConfig */
      sessionMaxAgeSeconds?: number;
      /** Per-tenant idle timeout from TenantSecurityConfig */
      sessionIdleSeconds?: number;
      /** Session purpose tag — propagated to DB session and used for billing/analytics exclusion */
      knownSource?: 'production' | 'eval' | 'synthetic';
    } = {},
  ): RuntimeSession {
    const { agents, entryAgent, compilationOutput, versionInfo } = resolved;
    materializeModuleResolvedTools({
      agents,
      compilationOutput,
      resolvedTools: resolved.resolvedTools,
    });

    if (!entryAgent || entryAgent === 'default') {
      throw new AppError('Session requires a valid agent name', { ...ErrorCodes.BAD_REQUEST });
    }

    let agentIR = agents[entryAgent] || Object.values(agents)[0] || null;

    // Guard: if the stored IR is actually a CompilationOutput (has 'agents' map),
    // unwrap it to get the individual agent IR.
    if (agentIR && 'agents' in agentIR && !('execution' in agentIR)) {
      const wrapped = agentIR as unknown as {
        agents: Record<string, AgentIR>;
        entry_agent?: string;
      };
      const innerName = wrapped.entry_agent || entryAgent;
      agentIR = wrapped.agents[innerName] || Object.values(wrapped.agents)[0] || null;
    }

    if (!agentIR) {
      throw new AppError(`Entry agent "${entryAgent}" not found in resolved agents`, {
        ...ErrorCodes.NOT_FOUND,
      });
    }

    const scopedOptions = resolveScopeBackedSessionOptions(options.scope);
    const effectiveTenantId = scopedOptions.tenantId ?? options.tenantId;
    const effectiveProjectId = scopedOptions.projectId ?? options.projectId;
    const effectiveCallerContext = scopedOptions.callerContext ?? options.callerContext;
    const effectiveSessionPrincipalId =
      options.scope?.kind === 'production'
        ? options.scope.sessionPrincipalId
        : (effectiveCallerContext?.sessionPrincipalId ?? effectiveCallerContext?.anonymousId);
    const effectiveUserId = scopedOptions.userId ?? options.userId;
    const resolvedUserId = effectiveUserId ?? resolveRuntimeSessionUserId(effectiveCallerContext);
    const sessionId = scopedOptions.sessionId ?? options.sessionId ?? crypto.randomUUID();
    const sessionScopedRegistry = buildSessionScopedAgentRegistry(
      compilationOutput,
      resolved.versionInfo,
    );

    const isFlowMode = !!agentIR.flow;
    const entryPoint = agentIR.flow?.entry_point || agentIR.flow?.steps?.[0];

    const initialData: SessionDataStore = {
      values: {
        // The `session` namespace object provides dotted-path access for CALL expressions
        // (e.g., session.sessionId, session.channel). Flat keys (session_id, tenant_id, etc.)
        // are kept for backward compatibility with positional CALL args and tool auto-injection.
        session: {
          // 1. Arbitrary client-supplied data (callerData) — lowest priority
          ...(options.callerData || {}),
          // 2. CallerContext fields (customerId, contactContext, etc.)
          ...(effectiveCallerContext
            ? Object.fromEntries(
                Object.entries(effectiveCallerContext).filter(
                  ([, v]) => v !== undefined && v !== null,
                ),
              )
            : {}),
          // 3. Platform fields — highest priority, never overridden
          channel: options.channelType || 'digital',
          sessionId,
          ...(effectiveSessionPrincipalId
            ? { sessionPrincipalId: effectiveSessionPrincipalId }
            : {}),
          ...(resolvedUserId ? { userId: resolvedUserId } : {}),
          ...(effectiveTenantId ? { tenantId: effectiveTenantId } : {}),
          ...(effectiveProjectId ? { projectId: effectiveProjectId } : {}),
        },
        _clarification_count: 0,
        // Built-in session-level variables — available to CALL expressions in ABL DSL
        session_id: sessionId,
        ...(effectiveSessionPrincipalId
          ? { session_principal_id: effectiveSessionPrincipalId }
          : {}),
        ...(resolvedUserId ? { user_id: resolvedUserId } : {}),
        ...(effectiveTenantId ? { tenant_id: effectiveTenantId } : {}),
        ...(effectiveProjectId ? { project_id: effectiveProjectId } : {}),
      },
      gatheredKeys: new Set(),
    };

    // Store integration-supplied metadata in isolated namespace (session.data.values._metadata)
    initializeSessionMetadata(initialData, options.metadata);

    const contactPreferenceResult = extractInteractionContextFromContactPreferences(
      options.callerContext?.contactPreferences,
      'sanitize',
    );
    const initialInteractionState = resolveAndApplyInteractionContextToSessionData({
      sessionData: initialData,
      explicit: options.interactionContext,
      contactPreference: contactPreferenceResult.success ? contactPreferenceResult.data : undefined,
      agentDefault: resolveAgentDefaultInteractionInput(agentIR),
    });
    applyProfileInteractionContextToSessionData(
      initialData,
      mergeProfileInteractionContextInputs(
        initialInteractionState.current,
        extractProfileInteractionContextFromMetadata(options.metadata),
        options.interactionContext,
      ),
    );
    const initialInteractionContext = readSessionInteractionState(initialData)?.current;
    const initialProfileInteractionContext = mergeProfileInteractionContextInputs(
      initialInteractionContext,
      readProfileInteractionContextFromSessionData(initialData),
    );

    const now = new Date();
    const session: RuntimeSession = {
      id: sessionId,
      agentName: entryAgent,
      agentIR,
      compilationOutput,
      conversationHistory: [],
      state: {
        gatherProgress: {},
        conversationPhase: 'start',
        context: {},
      },
      data: initialData,
      executionTreeValues: {},
      isComplete: false,
      isEscalated: false,
      transferInitiated: false,
      handoffStack: [entryAgent],
      delegateStack: [],
      currentFlowStep: isFlowMode ? entryPoint : undefined,
      waitingForInput: undefined,
      projectId: effectiveProjectId,
      userId: resolvedUserId,
      tenantId: effectiveTenantId,
      permissions: options.permissions ? [...options.permissions] : undefined,
      resolvedTools: resolved.resolvedTools,
      channelType: options.channelType,
      versionInfo: resolved.versionInfo,
      settingsVersionId: resolved.settingsVersionId,
      initialized: false,
      callerContext: effectiveCallerContext,
      executionScopeKind: options.scope?.kind,
      ...(options.knownSource ? { knownSource: options.knownSource } : {}),
      _sessionAgentRegistry: sessionScopedRegistry,
      callerData: options.callerData,
      threads: [],
      activeThreadIndex: 0,
      threadStack: [],
      storeVersion: 0,
      createdAt: now,
      lastActivityAt: now,
      maxAgeSeconds: options.sessionMaxAgeSeconds,
      idleSeconds: options.sessionIdleSeconds,
      // Studio debug sessions default to verbose for decision log visibility
      traceVerbosity: options.channelType === 'debug_websocket' ? 'verbose' : 'standard',
      ...(options.ephemeralExecution ? { _ephemeralExecution: options.ephemeralExecution } : {}),
    };

    // Create the initial thread
    createInitialThread(session);

    // Wire FactStore for persistent memory (REMEMBER/RECALL)
    // Requires all three ownership dimensions: tenant, user, and project
    rewireRuntimeSessionFactStores(session);

    if (isFlowMode) {
      log.info('Flow mode agent (resolved)', { agentName: entryAgent, entryPoint });
    }

    // Resolve behavior profiles and base conversation behavior
    if (agentIR.behavior_profiles?.length || agentIR.conversation_behavior) {
      const profileCtx = assembleProfileContext({
        channelType: options.channelType || 'digital',
        sessionMeta: { isNew: true, turnCount: 0 },
        interactionContext: initialProfileInteractionContext,
      });
      const activeProfiles = agentIR.behavior_profiles
        ? resolveActiveProfiles(agentIR.behavior_profiles, profileCtx)
        : [];
      if (activeProfiles.length > 0 || agentIR.conversation_behavior) {
        session._effectiveConfig = buildEffectiveConfig(agentIR, activeProfiles, {
          channelType: options.channelType || 'digital',
        });
        session._activeProfileNames = activeProfiles.map((p) => p.name);
      }

      // Emit profile_resolution trace event for observability
      try {
        const evaluatedProfiles = agentIR.behavior_profiles?.map((p) => p.name) ?? [];
        const hasEffectiveBehaviorConfig =
          activeProfiles.length > 0 || !!session._effectiveConfig?.conversationBehavior;
        getTraceStore().addEvent(session.id, {
          id: crypto.randomUUID(),
          sessionId: session.id,
          type: 'profile_resolution' as TraceEventType,
          timestamp: new Date(),
          data: {
            evaluatedProfiles,
            matchedProfiles: activeProfiles.map((p) => p.name),
            channel: options.channelType || 'digital',
            effectiveSummary: hasEffectiveBehaviorConfig
              ? {
                  instructionsAppended:
                    session._effectiveConfig?.additionalInstructions?.length ?? 0,
                  constraintsAdded: session._effectiveConfig?.additionalConstraints?.length ?? 0,
                  toolsHidden:
                    agentIR.tools?.filter(
                      (t) => !session._effectiveConfig?.tools?.some((et) => et.name === t.name),
                    ).length ?? 0,
                  toolsAdded:
                    session._effectiveConfig?.tools?.filter(
                      (t) => !agentIR.tools?.some((bt) => bt.name === t.name),
                    ).length ?? 0,
                  hasResponseRules: !!session._effectiveConfig?.responseRules,
                  hasVoiceConfig: !!session._effectiveConfig?.voiceConfig,
                  hasConversationBehavior: !!session._effectiveConfig?.conversationBehavior,
                  conversationBehaviorSourceChain:
                    session._effectiveConfig?.conversationBehavior?.sourceChain ?? [],
                  conversationBehaviorCapabilityDrops:
                    session._effectiveConfig?.conversationBehavior?.capabilityDrops.length ?? 0,
                  conversationBehaviorCapabilityDropDetails:
                    session._effectiveConfig?.conversationBehavior?.capabilityDrops ?? [],
                  conversationBehavior: buildConversationBehaviorTraceSummary(
                    session._effectiveConfig?.conversationBehavior,
                    {
                      interactionLanguage: initialInteractionContext?.language ?? undefined,
                      interactionLocale: initialInteractionContext?.locale ?? undefined,
                      interactionTimezone: initialInteractionContext?.timezone ?? undefined,
                    },
                  ),
                  hasGatherOverrides: !!session._effectiveConfig?.gatherOverrides,
                  hasFlowReplace: !!session._effectiveConfig?.flowReplace,
                }
              : null,
          },
        });
      } catch (err) {
        log.debug('Failed to emit profile_resolution trace event', {
          error: err instanceof Error ? err.message : String(err),
          sessionId: session.id,
        });
      }
    }

    // Build module provenance map from resolved agents that carry _moduleProvenance
    const moduleProvenance: Record<
      string,
      {
        alias: string;
        moduleProjectId: string;
        moduleReleaseId: string;
        sourceAgentName: string;
      }
    > = {};
    for (const [name, ir] of Object.entries(agents)) {
      const prov = (ir as { _moduleProvenance?: (typeof moduleProvenance)[string] })
        ._moduleProvenance;
      if (prov) {
        moduleProvenance[name] = prov;
      }
    }
    if (Object.keys(moduleProvenance).length > 0) {
      session.moduleProvenance = moduleProvenance;
    }

    // Compute the full config hash once per session for STI tracing.
    // This intentionally tracks the entire effective AgentIR and is broader
    // than the narrower model-resolution snapshot fingerprint used by LLM caches.
    if (agentIR) {
      try {
        session.configHash = computeConfigHash(agentIR as unknown as Record<string, unknown>);
      } catch (err) {
        log.warn('Failed to compute config hash', {
          sessionId: session.id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    this.clearInMemorySessionArtifacts(session.id);

    // Register the session's own agent graph in both the legacy compatibility
    // map and the composite-key store. The per-session registry remains the
    // fail-closed compatibility lane for sessions that cannot address the
    // store by raw version.
    const storeProjectId = effectiveProjectId;
    for (const [name, entry] of Object.entries(sessionScopedRegistry)) {
      this.agentRegistry[name] = entry;
      if (storeProjectId && entry.version) {
        this.agentRegistryStore.register(
          effectiveTenantId
            ? { tenantId: effectiveTenantId, projectId: storeProjectId }
            : storeProjectId,
          name,
          entry.version,
          entry,
          {
            ownerId: sessionId,
          },
        );
      }
      log.info('Registered resolved agent', { name, version: entry.version });
    }

    // Wire Tracer for span-aware observability. Simulations stream trace events
    // to the caller only and must not write to long-lived trace pipelines.
    if (!session._ephemeralExecution) {
      this.wireTracer(session);
    }

    // Wire tool executor and LLM client
    this.llmWiring.wireToolExecutor(
      session,
      compilationOutput,
      options.authToken,
      effectiveTenantId,
      effectiveProjectId,
    );

    if (agentIR) {
      this.llmWiring
        .wireLLMClient(session, agentIR, effectiveTenantId, effectiveProjectId, options.userId)
        .catch((err) => {
          log.error('Failed to wire LLM client (resolved) — will retry lazily on first message', {
            error: err instanceof Error ? err.message : String(err),
            sessionId: session.id,
          });
        });
    }

    this.sessions.set(session.id, session);
    log.debug('[SESSION-MAP] session added to in-memory map', {
      sessionId: session.id,
      agentName: session.agentName,
      mapSize: this.sessions.size,
    });

    // Emit session.started event directly to EventStore (fire-and-forget, non-fatal).
    // TraceEmitter is not available at session creation — it's created later in the WS handler.
    if (effectiveTenantId && !session._ephemeralExecution) {
      Promise.all([import('./eventstore-singleton.js'), import('./trace-event-types.js')])
        .then(([singletonMod, typesMod]) => {
          const eventStore = singletonMod.getEventStore();
          if (!eventStore) return;
          const platformType =
            typesMod.TRACE_TO_PLATFORM_TYPE['session_created'] || 'session.started';
          eventStore.emitter.emit({
            event_type: platformType,
            category: typesMod.inferCategory(platformType),
            session_id: session.id,
            tenant_id: effectiveTenantId,
            project_id: effectiveProjectId || '',
            agent_name: entryAgent,
            known_source: options.knownSource ?? 'production',
            timestamp: new Date(),
            data: {
              channel: options.channelType || 'unknown',
              entryAgent,
              deploymentId: resolved.versionInfo.deploymentId || '',
              resolutionMethod: 'new',
              callerIdentityTier: effectiveCallerContext?.identityTier || 'anonymous',
              ...(options.knownSource ? { knownSource: options.knownSource } : {}),
            },
          });
        })
        .catch((err) => {
          warnIfRuntimeStillAlive(
            'EventStore emit failed (non-fatal)',
            { sessionId: session.id },
            err,
          );
        });
    }

    // Load deployment env vars into session data for template interpolation.
    // Fire-and-forget: env vars will be available by the time the first
    // executeMessage() runs (always async, comes later).
    if (session.tenantId && session.projectId && session.versionInfo?.environment) {
      this.llmWiring
        .loadEnvironmentVariables(
          session.tenantId,
          session.projectId,
          session.versionInfo.environment,
        )
        .then((envVars) => {
          if (Object.keys(envVars).length > 0) {
            session.data.values.env = envVars;
            log.info('Env vars loaded', {
              sessionId: session.id,
              count: Object.keys(envVars).length,
            });
          }
        })
        .catch((err) => {
          log.warn('Failed to load env vars', {
            sessionId: session.id,
            error: err instanceof Error ? err.message : String(err),
          });
        });
    }

    // Persist to SessionService
    if (!session._ephemeralExecution) {
      this.persistSessionToService(session, options.channelType).catch((err) => {
        log.error('Failed to persist resolved session', {
          error: err instanceof Error ? err.message : String(err),
        });
      });
    }

    return session;
  }

  /**
   * Public: ensure a session's LLM client is wired without executing anything.
   * Used by SDK WS warmup to prime the LLM connection without triggering ON_START.
   */
  async ensureLLMReady(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    await this.llmWiring.ensureSessionLLMClient(session);
  }

  /**
   * Unified session initialization — handles both flow and reasoning modes.
   * Idempotent: calling multiple times returns null after the first call.
   *
   * 1. Executes ON_START lifecycle hook (SET, CALL, RESPOND, DELEGATE)
   * 2. For flow mode: executes the first flow step
   * 3. Sets initialized=true to prevent re-execution
   *
   * Channels that want a welcome message before user input (e.g., Debug WS)
   * call this explicitly after session creation. Other channels get ON_START
   * for free via lazy initialization in executeMessage().
   */
  async initializeSession(
    sessionId: string,
    onChunk?: (chunk: string) => void,
    onTraceEvent?: (event: { type: string; data: Record<string, unknown> }) => void,
    options: { runInitialFlowStep?: boolean } = {},
  ): Promise<ExecutionResult | null> {
    const session = this.sessions.get(sessionId);
    if (!session || session.initialized) return null; // idempotent

    try {
      await refreshSessionPIIContext(session);
    } catch (err) {
      log.warn('Failed to refresh session PII context during initialization', {
        sessionId: session.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    onTraceEvent = await this.ensureCentralizedTraceHandler(
      session,
      onTraceEvent,
      getCurrentTraceId(),
    );

    // Streaming output guardrails: wrap onChunk to evaluate output guardrails mid-stream.
    // Same wrapper as executeMessage — initializeSession can be called standalone.
    const initOutputGuardrails =
      session.agentIR?.constraints?.guardrails?.filter((g) => g.kind === 'output') ?? [];
    const {
      getSessionPolicy: getInitPolicy,
      getSessionGuardrailCacheScopeKey,
      getSessionStreamingConfig,
      toStreamingEvalConfig,
    } = await import('./execution/session-policy.js');
    const initPolicy = await getInitPolicy(session);
    const hasInitOutputGuardrails =
      initOutputGuardrails.length > 0 ||
      initPolicy?.additionalGuardrails?.some((g) => g.kind === 'output');

    if (onChunk && hasInitOutputGuardrails) {
      const { StreamingGuardrailEvaluator } = await import('./guardrails/streaming-evaluator.js');
      const { createGuardrailPipeline, createLLMEvalFromClient, ensureTenantProvidersLoaded } =
        await import('./guardrails/pipeline-factory.js');
      if (session.tenantId) {
        await ensureTenantProvidersLoaded(session.tenantId);
      }
      const llmEval = session.llmClient ? createLLMEvalFromClient(session.llmClient) : undefined;
      const pipeline = createGuardrailPipeline(llmEval, session.tenantId, session.projectId, {
        policy: initPolicy,
        piiRecognizerRegistry: session.piiRecognizerRegistry,
        cacheScopeKey: getSessionGuardrailCacheScopeKey(session),
      });
      // Known trade-off: chunks are forwarded optimistically before async
      // guardrail evaluation completes. Buffering would add latency to every
      // chunk. This is an accepted P2 leak window for streaming performance.
      const initStreamingConfig = toStreamingEvalConfig(getSessionStreamingConfig(session));
      const evaluator = new StreamingGuardrailEvaluator(
        initOutputGuardrails,
        initStreamingConfig,
        pipeline,
        initPolicy,
        { agentGoal: session.agentIR?.identity?.goal },
      );
      const guardedOnChunk = onChunk;
      onChunk = (chunk: string) => {
        if (evaluator.isTerminated()) return;

        evaluator
          .evaluateChunk(chunk)
          .then((event) => {
            if (event.type === 'terminate' && onTraceEvent) {
              onTraceEvent({
                type: 'constraint_check',
                data: {
                  agentName: session.agentName,
                  kind: 'output_streaming',
                  guardrailName: event.violation?.guardrailName ?? 'unknown',
                  action: event.violation?.action ?? 'block',
                  message:
                    event.violation?.message ??
                    formatErrorSync('GUARDRAIL_STREAM_TERMINATED').message,
                  passed: false,
                },
              });
            }
          })
          .catch((err) => {
            log.warn('Streaming guardrail evaluation error', {
              error: err instanceof Error ? err.message : String(err),
              sessionId,
            });
          });

        guardedOnChunk(chunk);
      };
    }

    // Voice safety net: wrap onChunk when called directly from channel handlers
    // (executeMessage wraps its own copy, but initializeSession can be called standalone)
    if (onChunk && isVoiceChannel(session)) {
      const originalOnChunk = onChunk;
      onChunk = (chunk: string) => originalOnChunk(stripForVoiceStreamChunk(chunk));
    }

    session.initialized = true;

    // Load project runtime config from DB and merge into agent IR
    if (session.agentIR && session.tenantId && session.projectId) {
      try {
        const projectConfig = await resolveProjectRuntimeConfig(
          session.tenantId,
          session.projectId,
        );
        if (projectConfig) {
          session.agentIR.project_runtime_config = projectConfig;
          session._projectRuntimeConfig = projectConfig;
        }
      } catch (err) {
        if (err instanceof ProjectRuntimeConfigResolutionError) {
          throw err;
        }
        log.debug('Project runtime config resolver unavailable', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // Create per-session NLU sidecar client when project uses advanced NLU provider
    if (
      session.agentIR?.project_runtime_config?.nlu_provider === 'advanced' &&
      session.agentIR.project_runtime_config.advanced_sidecar_url
    ) {
      try {
        const { resolveAdvancedNluEntitlement } = await import('@agent-platform/project-io/import');
        const entitlement = session.tenantId
          ? await resolveAdvancedNluEntitlement(session.tenantId)
          : { allowed: false };
        if (!entitlement.allowed) {
          log.warn('Tenant is not entitled to advanced NLU, skipping sidecar client', {
            tenantId: session.tenantId,
            sessionId,
          });
        } else {
          const { NLUSidecarClient } = await import('./nlu/sidecar-client.js');
          session._nluSidecarClient = new NLUSidecarClient({
            url: session.agentIR.project_runtime_config.advanced_sidecar_url,
            timeoutMs: session.agentIR.project_runtime_config.advanced_sidecar_timeout_ms,
            circuitBreakerThreshold:
              session.agentIR.project_runtime_config.advanced_sidecar_circuit_breaker_threshold,
          });
          log.info('Per-session NLU sidecar client created', {
            url: session.agentIR.project_runtime_config.advanced_sidecar_url,
            sessionId,
          });
        }
      } catch (err) {
        log.warn('Failed to create per-session NLU sidecar client', {
          error: err instanceof Error ? err.message : String(err),
          sessionId,
        });
      }
    }

    // Initialize memory: load persistent defaults + session_start RECALL (parallel, 1 DB round-trip)
    if (session.agentIR) {
      await initializeAllMemory(session, session.agentIR, onTraceEvent);
    }

    // Execute HOOKS: before_agent lifecycle hook (IR-gated: no-op if not defined)
    let beforeAgentEmittedMessage:
      | Pick<ExecutionResult, 'response' | 'richContent' | 'voiceConfig' | 'actions'>
      | undefined;
    if (session.agentIR?.hooks) {
      const { executeHook } = await import('./execution/hook-executor.js');
      const beforeAgentHookResult = await executeHook(
        'before_agent',
        session.agentIR.hooks,
        session,
        onChunk,
        onTraceEvent,
      );
      beforeAgentEmittedMessage = beforeAgentHookResult.emittedMessage;
    }

    // Execute ON_START lifecycle hook if defined
    const onStartResult = await this.flowStep.executeOnStart(session, onChunk, onTraceEvent);
    if (onStartResult) {
      // If ON_START returned a delegate/handoff action, return it for the caller to handle
      if (onStartResult.action.type === 'delegate' || onStartResult.action.type === 'handoff') {
        return onStartResult;
      }
    }

    // For flow mode: execute the first step when initialization is its own
    // visible turn. When lazy initialization happens inside executeMessage()
    // for an already-present user turn, the real message must drive the first
    // flow step below instead of an empty initializer input.
    if (session.currentFlowStep && options.runInitialFlowStep !== false) {
      const suppressEmptyReasoningZoneExecution = Boolean(
        beforeAgentEmittedMessage ||
        (onStartResult && hasRenderableAgentMessagePayload(onStartResult)),
      );
      const flowResult = await this.flowStep.executeFlowStep(session, '', onChunk, onTraceEvent, {
        suppressEmptyReasoningZoneExecution,
      });
      if (!beforeAgentEmittedMessage) {
        return flowResult;
      }

      return {
        ...flowResult,
        response: `${beforeAgentEmittedMessage.response ?? ''}${flowResult.response ?? ''}`,
        ...(beforeAgentEmittedMessage.richContent !== undefined
          ? { richContent: beforeAgentEmittedMessage.richContent }
          : {}),
        ...(beforeAgentEmittedMessage.voiceConfig !== undefined
          ? { voiceConfig: beforeAgentEmittedMessage.voiceConfig }
          : {}),
        ...(beforeAgentEmittedMessage.actions !== undefined
          ? { actions: beforeAgentEmittedMessage.actions }
          : {}),
      };
    }

    // Reasoning mode with just RESPOND/SET — return the ON_START result
    if (onStartResult) {
      return onStartResult;
    }

    if (beforeAgentEmittedMessage) {
      return {
        response: beforeAgentEmittedMessage.response,
        action: { type: 'continue' },
        ...(beforeAgentEmittedMessage.richContent !== undefined
          ? { richContent: beforeAgentEmittedMessage.richContent }
          : {}),
        ...(beforeAgentEmittedMessage.voiceConfig !== undefined
          ? { voiceConfig: beforeAgentEmittedMessage.voiceConfig }
          : {}),
        ...(beforeAgentEmittedMessage.actions !== undefined
          ? { actions: beforeAgentEmittedMessage.actions }
          : {}),
      };
    }

    return null;
  }

  // executeOnStart — extracted to execution/flow-step-executor.ts

  /**
   * Convenience method: compile DSL and create a session in one call.
   * Used primarily in tests — production code should use createSessionFromResolved().
   */
  createSession(
    dsl: string,
    agentName: string,
    options: { channel?: string; tenantId?: string; projectId?: string } = {},
  ): RuntimeSession {
    const resolved = compileToResolvedAgent([dsl], agentName);
    return this.createSessionFromResolved(resolved, {
      channelType: options.channel,
      tenantId: options.tenantId,
      projectId: options.projectId,
    });
  }

  /**
   * Convenience method: compile multiple DSLs and create a session.
   * Used primarily in tests — production code should use createSessionFromResolved().
   */
  createSessionFromMultipleDSLs(
    dsls: string[],
    agentName: string,
    options: { channel?: string; tenantId?: string; projectId?: string } = {},
  ): RuntimeSession {
    const resolved = compileToResolvedAgent(dsls, agentName);
    return this.createSessionFromResolved(resolved, {
      channelType: options.channel,
      tenantId: options.tenantId,
      projectId: options.projectId,
    });
  }

  /**
   * Build the system prompt for a session — delegates to prompt-builder module.
   * Exposed as an instance method for testing convenience.
   */
  buildSystemPrompt(session: RuntimeSession): string {
    return buildSystemPrompt(session);
  }

  /**
   * Build the tool list for a session — delegates to prompt-builder module.
   * Exposed as an instance method for testing convenience.
   */
  buildTools(session: RuntimeSession): ReturnType<typeof buildTools> {
    return buildTools(session);
  }

  /** Return count of in-memory sessions (for health/monitoring). */
  getSessionCount(): number {
    return this.sessions.size;
  }

  /**
   * Get a session by ID
   */
  getSession(sessionId: string): RuntimeSession | undefined {
    return this.sessions.get(sessionId);
  }

  /**
   * Re-bind the tool executor for a session after auth callbacks are updated.
   * Called by WS handlers after setting sendAuthChallenge/initiateJitOAuth on a session.
   */
  rewireSessionToolExecutor(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    this.llmWiring.wireToolExecutor(
      session,
      session.compilationOutput,
      session.authToken,
      session.tenantId,
      session.projectId,
    );
  }

  /**
   * Clear model resolution caches (delegates to LLM wiring layer).
   */
  clearModelResolutionCache(tenantId?: string): void {
    this.llmWiring.clearModelResolutionCache(tenantId);
  }

  /**
   * Store a realtime voice executor for a session.
   */
  setRealtimeVoiceExecutor(
    sessionId: string,
    executor: import('./voice/realtime-voice-executor.js').RealtimeVoiceExecutor,
  ): void {
    this.realtimeVoiceExecutors.set(sessionId, executor);
  }

  /**
   * Get the realtime voice executor for a session.
   */
  getRealtimeVoiceExecutor(
    sessionId: string,
  ): import('./voice/realtime-voice-executor.js').RealtimeVoiceExecutor | undefined {
    return this.realtimeVoiceExecutors.get(sessionId);
  }

  /**
   * Remove a realtime voice executor (on session end/disconnect).
   */
  removeRealtimeVoiceExecutor(sessionId: string): void {
    this.realtimeVoiceExecutors.delete(sessionId);
  }

  /**
   * Check if the local session copy is stale compared to the store (another pod
   * may have updated it). If stale, rehydrate from the store. Fail-open: on any
   * store read error, proceed with the local copy.
   */
  private async checkAndRefreshIfStale(session: RuntimeSession): Promise<RuntimeSession | null> {
    try {
      const svc = await this.getSessionServiceAsync();
      const locator = buildSessionLocator(session);
      const storeVersion = locator
        ? await svc.getVersionScoped(locator)
        : await svc.getVersion(session.id, session.tenantId);
      if (storeVersion === null || storeVersion <= session.storeVersion) {
        return null; // up-to-date or not in store
      }
      log.info('Stale session detected, rehydrating', {
        sessionId: session.id,
        localVersion: session.storeVersion,
        storeVersion,
      });
      return this.rehydrateSession(session.id, locator ? { locator } : undefined);
    } catch (err) {
      // Fail-open: proceed with local copy on store read error
      log.warn('Version check failed, proceeding with local session', {
        sessionId: session.id,
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  }

  /**
   * Rebuild AgentIR and CompilationOutput from the project's DSLs stored in the database.
   * Used when the IR cache (L1 LRU + L2 Redis) has evicted entries but the session
   * still references them via irSourceHash. This is the recovery path for cold sessions.
   */
  private async rebuildIRFromProject(
    tenantId: string,
    projectId: string,
    agentName: string,
  ): Promise<{ agentIR: AgentIR; compilationOutput: CompilationOutput } | null> {
    if (!isDatabaseAvailable()) {
      log.warn('rebuildIRFromProject: database unavailable', { tenantId, projectId, agentName });
      return null;
    }

    try {
      const { findProjectRuntimeConfig, findProjectWithAgents } =
        await import('../repos/project-repo.js');
      const project = await findProjectWithAgents(projectId, tenantId);
      if (!project || !project.agents || project.agents.length === 0) {
        log.warn('rebuildIRFromProject: project or agents not found', {
          tenantId,
          projectId,
          agentName,
        });
        return null;
      }

      const readiness = await evaluateProjectExecutionReadiness({
        agents: project.agents,
        tenantId,
        projectId,
        runtimeConfig: await findProjectRuntimeConfig(projectId, tenantId),
        lazyBackfill: true,
      });
      if (readiness.hasBlockingErrors) {
        log.warn('rebuildIRFromProject: refusing invalid project DSL', {
          tenantId,
          projectId,
          agentName,
          blockedAgents: readiness.blockedAgents,
          issueKinds: readiness.issues.map((issue) => issue.kind),
        });
        return null;
      }

      const { buildProjectWorkingCopyAgentSources, compileProjectWorkingCopy } =
        await import('./project-working-copy-compiler.js');
      const workingCopyAgents = buildProjectWorkingCopyAgentSources(
        readiness.executableAgents as Array<{
          name?: unknown;
          dslContent?: unknown;
          systemPromptLibraryRef?: unknown;
        }>,
      );

      if (workingCopyAgents.length === 0) {
        log.warn('rebuildIRFromProject: no DSL content in project agents', {
          tenantId,
          projectId,
          agentName,
        });
        return null;
      }
      const compileResult = await compileProjectWorkingCopy({
        tenantId,
        projectId,
        entryAgentName: agentName,
        environment: 'dev',
        agents: workingCopyAgents,
      });
      const resolved = compileResult.resolved;

      const entryIR = resolved.agents[resolved.entryAgent] ?? resolved.agents[agentName];
      if (!entryIR || !resolved.compilationOutput) {
        log.warn('rebuildIRFromProject: compilation produced no IR', {
          tenantId,
          projectId,
          agentName,
          entryAgent: resolved.entryAgent,
          availableAgents: Object.keys(resolved.agents),
        });
        return null;
      }

      return { agentIR: entryIR, compilationOutput: resolved.compilationOutput };
    } catch (err) {
      log.error('rebuildIRFromProject: compilation failed', {
        tenantId,
        projectId,
        agentName,
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  }

  /**
   * Rehydrate a session from SessionService when it's not in the local in-memory map.
   * This enables distributed pod deployment: when a message arrives at pod B for a session
   * created on pod A, we load the serialized SessionData from the session store (Redis/memory),
   * resolve the AgentIR from cache, recreate the runtime, and wire up the tool executor.
   */
  async rehydrateSession(
    sessionId: string,
    options: {
      locator?: SessionLocator;
      sendAuthChallenge?: (
        params: import('./execution/types.js').RuntimeAuthChallengeParams,
      ) => void;
      initiateJitOAuth?: (
        params: import('./execution/types.js').RuntimeJitOAuthParams,
      ) => Promise<string | undefined>;
    } = {},
  ): Promise<RuntimeSession | null> {
    try {
      const svc = await this.getSessionServiceAsync();
      const hydrated = options.locator
        ? await svc.loadSessionScoped(options.locator)
        : await svc.loadSession(sessionId);
      if (!hydrated) {
        log.warn('rehydrateSession: session not found in SessionService', { sessionId });
        return null;
      }

      let agentIR = hydrated.agentIR;
      let compilationOutput = hydrated.compilationOutput;

      // When IR cache has evicted (L1 LRU + L2 Redis TTL), rebuild from project DSLs
      if (!agentIR && hydrated.tenantId && hydrated.projectId) {
        log.warn('rehydrateSession: agentIR missing, rebuilding from project DB', {
          sessionId,
          irHash: hydrated.irSourceHash,
          tenantId: hydrated.tenantId,
          projectId: hydrated.projectId,
          agentName: hydrated.agentName,
        });
        const rebuilt = await this.rebuildIRFromProject(
          hydrated.tenantId,
          hydrated.projectId,
          hydrated.agentName,
        );
        if (rebuilt) {
          agentIR = rebuilt.agentIR;
          compilationOutput = rebuilt.compilationOutput;
          // Re-cache so future loads for this session (and others sharing the same IR) don't miss
          await svc.cacheAgentIR(agentIR);
          if (compilationOutput) {
            await svc.cacheCompilationOutput(compilationOutput);
          }
          log.info('rehydrateSession: IR rebuilt from DB', {
            sessionId,
            agentName: hydrated.agentName,
          });
        } else {
          // Module agents do not exist in the project's own DSL agents. The resolver
          // verifies the mounted alias against ProjectModuleDependency before loading a release.
          try {
            const { resolveModuleAgentIR } =
              await import('./modules/module-rehydration-fallback.js');
            const moduleResult = await resolveModuleAgentIR(
              hydrated.agentName,
              hydrated.tenantId,
              hydrated.projectId,
            );
            if (moduleResult) {
              agentIR = moduleResult.agentIR;
              await svc.cacheAgentIR(agentIR);
              log.info('rehydrateSession: module agent IR resolved from release', {
                sessionId,
                agentName: hydrated.agentName,
                alias: moduleResult.alias,
              });
            } else {
              log.error('rehydrateSession: IR rebuild failed — session will lack LLM capability', {
                sessionId,
                tenantId: hydrated.tenantId,
                projectId: hydrated.projectId,
              });
            }
          } catch (err) {
            log.error(
              'rehydrateSession: module agent IR resolution failed — session will lack LLM capability',
              {
                sessionId,
                tenantId: hydrated.tenantId,
                projectId: hydrated.projectId,
                error: err instanceof Error ? err.message : String(err),
              },
            );
          }
        }
      }

      // Reconstruct RuntimeSession from HydratedSession
      const session: RuntimeSession = {
        id: hydrated.id,
        agentName: hydrated.agentName,
        agentIR,
        compilationOutput,
        conversationHistory: hydrated.conversationHistory,
        state: hydrated.state,
        data: {
          values: hydrated.dataValues || {},
          gatheredKeys: new Set(hydrated.dataGatheredKeys || []),
        },
        executionTreeValues: hydrated.executionTreeValues || {},
        isComplete: hydrated.isComplete,
        isEscalated: hydrated.isEscalated,
        transferInitiated: hydrated.transferInitiated || false,
        escalationReason: hydrated.escalationReason,
        handoffStack: hydrated.handoffStack || [],
        delegateStack: hydrated.delegateStack || [],
        handoffReturnInfo: hydrated.handoffReturnInfo,
        currentFlowStep: hydrated.currentFlowStep,
        waitingForInput: hydrated.waitingForInput,
        pendingResponse: hydrated.pendingResponse,
        pendingRichContent: hydrated.pendingRichContent,
        pendingVoiceConfig: hydrated.pendingVoiceConfig,
        pendingActions: hydrated.pendingActions,
        tenantId: hydrated.tenantId,
        projectId: hydrated.projectId,
        authToken: hydrated.authToken,
        userId: hydrated.userId,
        permissions: hydrated.permissions,
        executionScopeKind: hydrated.executionScopeKind,
        sendAuthChallenge: options.sendAuthChallenge,
        initiateJitOAuth: options.initiateJitOAuth,
        // Rehydrated sessions default to initialized=true (ON_START already ran on original pod)
        // unless persisted state says otherwise
        initialized: hydrated.initialized !== undefined ? hydrated.initialized : true,
        // Restore caller context
        callerContext: hydrated.callerContext,
        // Restore deployment version context from persisted session
        versionInfo:
          hydrated.deploymentId ||
          hydrated.environment ||
          hydrated.agentVersions ||
          hydrated.agentRawVersions
            ? {
                deploymentId: hydrated.deploymentId,
                environment: hydrated.environment,
                versions: hydrated.agentVersions || {},
                rawVersions: hydrated.agentRawVersions,
              }
            : undefined,
        // Thread model — deserialize or create initial thread for pre-thread sessions
        threads: [],
        activeThreadIndex: hydrated.activeThreadIndex,
        threadStack: hydrated.threadStack,
        // Track store version for cross-pod stale detection
        storeVersion: hydrated.version,
        // Per-tenant session max age and idle timeout (dynamic TTL enforcement)
        maxAgeSeconds: hydrated.maxAgeSeconds,
        idleSeconds: hydrated.idleSeconds,
        // Timestamps — preserve originals for TTL computation; fall back to now
        createdAt: hydrated.createdAt ? new Date(hydrated.createdAt) : new Date(),
        lastActivityAt: hydrated.lastActivityAt ? new Date(hydrated.lastActivityAt) : new Date(),
        // Restore custom dimensions from serialized Record → Map
        customDimensions: hydrated.customDimensions
          ? new Map(Object.entries(hydrated.customDimensions))
          : undefined,
        // Restore PII redaction config
        piiRedactionConfig: hydrated.piiRedactionConfig,
        // Restore module provenance map for cross-pod trace enrichment
        moduleProvenance: hydrated.moduleProvenance,
        // Cache IR/compilation hashes from persisted data — avoids recomputing on every persist
        _cachedIRHash: hydrated.irSourceHash,
        _cachedCompilationHash: hydrated.compilationHash,
      };

      session._sessionAgentRegistry = buildSessionScopedAgentRegistry(
        compilationOutput,
        session.versionInfo,
      );

      if (Object.keys(session._sessionAgentRegistry).length === 0) {
        const persistedRegistry = options.locator
          ? await svc.getAgentRegistryScoped(options.locator)
          : await svc.getAgentRegistry(sessionId);
        if (persistedRegistry) {
          const resolvedEntries = await Promise.all(
            Object.entries(persistedRegistry).map(async ([name, irHash]) => {
              const ir = await svc.resolveAgentIR(irHash);
              if (!ir) return null;
              const entry: AgentRegistryEntry = {
                dsl: '',
                ir,
                location: 'local',
                version: resolveVersionString(session.versionInfo, name),
              };
              return [name, entry] as const;
            }),
          );
          session._sessionAgentRegistry = Object.fromEntries(
            resolvedEntries.filter(
              (candidate): candidate is readonly [string, AgentRegistryEntry] => candidate !== null,
            ),
          );
        }
      }

      // Deserialize threads from persisted data, or create initial thread
      if (hydrated.threads.length > 0) {
        session.threads = hydrated.threads.map((td) => ({
          agentName: td.agentName,
          agentIR: null, // Will be resolved below from compilation output
          _cachedIRHash: td.irSourceHash || undefined,
          conversationHistory: td.conversationHistory,
          state: td.state,
          data: {
            values: td.dataValues || {},
            gatheredKeys: new Set(td.dataGatheredKeys || []),
          },
          startedAt: td.startedAt,
          endedAt: td.endedAt,
          handoffFrom: td.handoffFrom,
          handoffContext: td.handoffContext,
          returnExpected: td.returnExpected,
          currentFlowStep: td.currentFlowStep,
          waitingForInput: td.waitingForInput,
          pendingResponse: td.pendingResponse,
          pendingRichContent: td.pendingRichContent,
          pendingVoiceConfig: td.pendingVoiceConfig,
          pendingActions: td.pendingActions,
          status: td.status,
          pendingAwaitAttachment: td.pendingAwaitAttachment,
        }));
        // Resolve agentIR for each thread from compilation output.
        // Thread agentName may use the ABL-declared name (PascalSnake) while
        // compilationOutput.agents uses manifest names (lowercase). Fall back
        // to case-insensitive lookup when exact key match fails.
        if (compilationOutput) {
          for (const thread of session.threads) {
            thread.agentIR = compilationOutput.agents[thread.agentName] || null;
            if (!thread.agentIR) {
              const lowerName = thread.agentName.toLowerCase();
              for (const [key, ir] of Object.entries(compilationOutput.agents)) {
                if (key.toLowerCase() === lowerName) {
                  thread.agentIR = ir;
                  break;
                }
                // Also check IR metadata name (handles case where key is lowercase
                // but the IR was extracted correctly and has the PascalSnake name)
                if ((ir as AgentIR).metadata?.name === thread.agentName) {
                  thread.agentIR = ir;
                  break;
                }
              }
            }
            if (!thread.agentIR) {
              thread.agentIR = session._sessionAgentRegistry?.[thread.agentName]?.ir ?? null;
            }
            // Ensure _cachedIRHash is populated after IR resolution (fixes cold persist validation)
            if (thread.agentIR && !thread._cachedIRHash) {
              thread._cachedIRHash = svc.computeIRHash(thread.agentIR as AgentIR);
            }
          }
        }
      } else {
        // Empty threads (newly created session not yet populated) — create initial thread
        createInitialThread(session);
      }

      // Re-establish session <-> active-thread references after deserialization
      // (deserialized threads have independent arrays; syncThreadToSession aliases them)
      syncThreadToSession(session);
      refreshExecutionTreeProjection(session);

      this.clearInMemorySessionArtifacts(session.id);

      // Re-register only the session's own scoped agent graph. This keeps
      // legacy sessions fail-closed and ensures the persisted per-session
      // registry, rather than the global flat map, remains the compatibility
      // fallback when rawVersions are unavailable.
      if (session._sessionAgentRegistry) {
        for (const [name, entry] of Object.entries(session._sessionAgentRegistry)) {
          if (session.projectId && entry.version) {
            this.agentRegistryStore.register(
              session.tenantId
                ? { tenantId: session.tenantId, projectId: session.projectId }
                : session.projectId,
              name,
              entry.version,
              entry,
              {
                ownerId: session.id,
              },
            );
          }
          if (!this.agentRegistry[name]?.version) {
            this.agentRegistry[name] = entry;
          }
        }
      }

      // Recreate tool executor with auth/org context
      this.llmWiring.wireToolExecutor(
        session,
        compilationOutput,
        hydrated.authToken,
        hydrated.tenantId,
        session.projectId,
      );

      // Recreate LLM client
      if (agentIR) {
        await this.llmWiring
          .wireLLMClient(session, agentIR, hydrated.tenantId, session.projectId, hydrated.userId)
          .catch((err) => {
            log.warn(
              'Failed to wire LLM client during rehydration; will retry lazily on first message',
              {
                sessionId,
                tenantId: hydrated.tenantId,
                agentName: agentIR.metadata?.name ?? hydrated.agentName,
                error: err instanceof Error ? err.message : String(err),
              },
            );
          });
      }

      // Re-resolve env vars (not persisted — re-queried from DB for security)
      if (session.tenantId && session.projectId && session.versionInfo?.environment) {
        try {
          const envVars = await this.llmWiring.loadEnvironmentVariables(
            session.tenantId,
            session.projectId,
            session.versionInfo.environment,
          );
          if (Object.keys(envVars).length > 0) {
            session.data.values.env = envVars;
          }
        } catch (err) {
          log.warn('Failed to load env vars on rehydration', {
            sessionId,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }

      try {
        await refreshSessionPIIContext(session);
      } catch (err) {
        log.warn('Failed to refresh session PII context on rehydration', {
          sessionId: session.id,
          error: err instanceof Error ? err.message : String(err),
        });
      }

      // Restore PII vault from serialized data
      if (hydrated.piiVaultData) {
        try {
          session.piiVault = PIIVault.deserialize(hydrated.piiVaultData, {
            recognizerRegistry: session.piiRecognizerRegistry,
          });
        } catch (err) {
          log.warn('PII vault restoration failed on rehydration', {
            sessionId: session.id,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }

      // Recreate FactStore for persistent memory
      rewireRuntimeSessionFactStores(session);

      // Store in local map for subsequent calls on this pod
      this.sessions.set(session.id, session);
      log.debug('[SESSION-MAP] session rehydrated into in-memory map', {
        sessionId: session.id,
        agentName: session.agentName,
        mapSize: this.sessions.size,
      });

      log.info('Session rehydrated from SessionService', { sessionId });
      return session;
    } catch (err) {
      log.error('Failed to rehydrate session', {
        sessionId,
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  }

  private async ensureCentralizedTraceHandler(
    session: RuntimeSession,
    onTraceEvent?: RuntimeTraceHandler,
    traceId?: string,
  ): Promise<RuntimeTraceHandler> {
    if (onTraceEvent && centralizedTraceHandlers.get(onTraceEvent) === session.id) {
      return onTraceEvent;
    }

    const handler = this.createCentralizedTraceHandler(
      session.id,
      session.tenantId,
      session.agentName,
      session.projectId,
      session.channelType,
      onTraceEvent,
      session,
      traceId ?? getCurrentTraceId(),
      await resolveScrubPII(session.tenantId),
    );
    return markCentralizedTraceHandler(handler, session.id);
  }

  /**
   * Create a centralized trace handler that wraps the caller's optional callback.
   *
   * The returned function:
   * 1. Builds a TraceEventWithId (id, sessionId, timestamp, type, data, agentName)
   * 2. Always stores in in-memory TraceStore (for sessions API retrieval)
   * 3. Persists to ClickHouse when enabled (fire-and-forget)
   * 4. Calls the original onTraceEvent callback if provided (for WS forwarding, metrics, etc.)
   *
   * This ensures ALL channels automatically get trace storage without per-handler work.
   */
  private createCentralizedTraceHandler(
    sessionId: string,
    tenantId: string | undefined,
    agentName: string | undefined,
    projectId: string | undefined,
    channelType: string | undefined,
    originalOnTraceEvent?: (event: { type: string; data: Record<string, unknown> }) => void,
    sessionRef?: Pick<
      RuntimeSession,
      | 'customDimensions'
      | 'piiRecognizerRegistry'
      | 'piiRedactionConfig'
      | 'piiVault'
      | 'piiPatternConfigs'
      | '_ephemeralExecution'
      | 'knownSource'
      | 'versionInfo'
    >,
    traceId?: string,
    scrubPII?: boolean,
  ): (event: { type: string; data: Record<string, unknown> }) => void {
    // Cache dimension Record to avoid Object.fromEntries on every emit
    let _cachedDimRecord: Record<string, string> | undefined;
    let _cachedDimRef: Map<string, string> | undefined;
    function getDimRecord(): Record<string, string> | undefined {
      const dims = sessionRef?.customDimensions;
      if (!dims || dims.size === 0) return undefined;
      if (dims === _cachedDimRef && _cachedDimRecord) return _cachedDimRecord;
      _cachedDimRef = dims;
      _cachedDimRecord = Object.fromEntries(dims);
      return _cachedDimRecord;
    }

    // Track last llm_call span_id per session for parent-child linking
    let lastLlmSpanId: string | undefined;
    const causalTracker = createRuntimeTraceCausalTracker();

    return (event) => {
      // Scrub PII and secrets from event data before storage/transmission
      if (scrubPII && event.data && typeof event.data === 'object') {
        try {
          const piiRecognizerRegistry = sessionRef?.piiRecognizerRegistry;
          event.data = scrubTraceEvent(
            event.data,
            piiRecognizerRegistry ? { piiRecognizerRegistry } : undefined,
          );
        } catch (err) {
          log.warn('Trace event data scrubbing failed', {
            sessionId,
            eventType: event.type,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }

      // Resolve traceId: prefer ALS (set by middleware/WS context), fall back to param
      const resolvedTraceId = getCurrentTraceId() || traceId;

      const traceEventId = crypto.randomUUID();
      const resolvedAgentName =
        typeof event.data?.agentName === 'string'
          ? event.data.agentName
          : typeof event.data?.agent === 'string'
            ? event.data.agent
            : agentName;

      // Derive parent span: tool_call events are children of the preceding llm_call
      let parentSpanId: string | undefined = (event.data?.parentSpanId as string) || undefined;
      if (event.type === 'llm_call') {
        lastLlmSpanId = traceEventId;
      } else if (event.type === 'tool_call' && lastLlmSpanId && !parentSpanId) {
        parentSpanId = lastLlmSpanId;
      }

      const causalFields = causalTracker.enrich({
        id: traceEventId,
        sessionId,
        type: event.type,
        data: event.data,
        agentName: resolvedAgentName,
      });
      const callbackTraceData = attachRuntimeTraceCausalData({ ...event.data }, causalFields);
      const traceData = tenantId ? { ...callbackTraceData, tenantId } : callbackTraceData;
      event.data = callbackTraceData;

      // Build a TraceEventWithId for storage
      const traceEvent: TraceEventWithId = {
        id: traceEventId,
        sessionId,
        type: event.type as TraceEventType,
        timestamp: new Date(),
        data: traceData,
        agentName: resolvedAgentName,
        spanId: traceEventId,
        ...(parentSpanId && { parentSpanId }),
        ...causalFields,
        ...(tenantId && { tenantId }),
        ...(projectId && { projectId }),
        ...(resolvedTraceId && { traceId: resolvedTraceId }),
      };

      // Build the data payload for ClickHouse — ensure cost exists for llm_call
      const chData =
        event.type === 'llm_call'
          ? { ...callbackTraceData, cost: (event.data?.cost as number) ?? 0 }
          : callbackTraceData;

      // 1. Store in shared TraceStore for normal executions. Simulations stream
      // only to the caller so dirty DSL and synthetic turns cannot reach
      // production observability sinks via TraceStore adapters.
      if (!sessionRef?._ephemeralExecution) {
        getTraceStore().addEvent(sessionId, traceEvent);
      }

      // 2. Emit to EventStore directly (platform_events table, fire-and-forget).
      //     Mapped events keep their semantic platform type; unmapped runtime
      //     events use the generic durable runtime-trace envelope.
      if (tenantId && !sessionRef?._ephemeralExecution) {
        loadEventStoreSingleton()
          .then(({ getEventStore }) => {
            const eventStore = getEventStore();
            if (!eventStore) return;
            emitToEventStore({
              eventStore,
              event: {
                id: traceEvent.id,
                type: event.type,
                sessionId,
                traceId: resolvedTraceId,
                tenantId,
                projectId: projectId || undefined,
                agentName: resolvedAgentName,
                environment: sessionRef?.versionInfo?.environment,
                timestamp: traceEvent.timestamp,
                durationMs: (event.data?.durationMs as number) || undefined,
                spanId: traceEvent.id,
                parentSpanId,
                ...causalFields,
                data: (chData as Record<string, unknown>) || {},
              },
              knownSource: sessionRef?.knownSource ?? 'production',
              dimensionRecord: getDimRecord(),
            });
          })
          .catch((err) => {
            warnIfRuntimeStillAlive('EventStore emit failed (non-fatal)', { sessionId }, err);
          });
      }

      // 3. Record token usage for quota tracking (fire-and-forget).
      //    Intercept llm_call trace events which carry usage.inputTokens / outputTokens.
      //    Skip if the event was already counted by a fan-out child's centralized handler
      //    to prevent double-counting tokens when the event bubbles up to the parent.
      if (
        tenantId &&
        event.type === 'llm_call' &&
        !event.data?.__tokenRecorded &&
        !sessionRef?._ephemeralExecution
      ) {
        const usage = event.data?.usage as
          | { inputTokens?: number; outputTokens?: number }
          | undefined;
        const totalTokens = (usage?.inputTokens || 0) + (usage?.outputTokens || 0);
        if (totalTokens > 0) {
          // Mark the event as already recorded so parent handlers skip re-counting
          event.data.__tokenRecorded = true;
          import('../middleware/rate-limiter.js')
            .then(({ recordTokenUsage }) => recordTokenUsage(tenantId!, totalTokens, projectId))
            .catch((err) => {
              log.warn('Token quota recording failed', {
                tenantId,
                error: err instanceof Error ? err.message : String(err),
              });
            });
        }
      }

      // 5. Emit business events to EventBus for pipeline consumption (fire-and-forget).
      //    Maps trace event types to platform event types so ALL channels get
      //    handoff/escalation/tool events without per-handler duplication.
      if (this._eventBus && !sessionRef?._ephemeralExecution) {
        const baseEnvelope = {
          tenantId: tenantId || '',
          projectId: projectId || '',
          sessionId,
          channel: channelType || 'unknown',
          timestamp: new Date().toISOString(),
        };

        if (event.type === 'handoff' && event.data) {
          this._eventBus.emit({
            eventId: crypto.randomUUID(),
            type: 'session.handoff',
            ...baseEnvelope,
            agentName: (event.data.from as string) || agentName || '',
            payload: {
              fromAgent: event.data.from,
              toAgent: event.data.to,
              reason: event.data.context ? 'handoff' : undefined,
              context: renderPayloadForPipelineEvent(event.data.context, sessionRef),
            },
          } as AnyPlatformEvent);
        }

        if (event.type === 'escalation' && event.data) {
          this._eventBus.emit({
            eventId: crypto.randomUUID(),
            type: 'session.escalation',
            ...baseEnvelope,
            agentName: (event.data.agent as string) || agentName || '',
            payload: renderPayloadForPipelineEvent(
              {
                agent: event.data.agent,
                reason: event.data.reason,
                priority: event.data.priority || 'medium',
              },
              sessionRef,
            ),
          } as AnyPlatformEvent);
        }

        if (event.type === 'tool_call_start' && event.data) {
          this._eventBus.emit({
            eventId: crypto.randomUUID(),
            type: 'tool.called',
            ...baseEnvelope,
            agentName: (event.data.agent as string) || agentName || '',
            payload: renderPayloadForPipelineEvent(
              {
                toolName: event.data.toolName,
                parameters: event.data.input || {},
              },
              sessionRef,
            ),
          } as AnyPlatformEvent);
        }

        if (event.type === 'tool_call' && event.data) {
          const isCompletedToolCall = isCompletedToolCallTrace(event.data);
          if (!isCompletedToolCall || event.data.phase !== 'complete') {
            this._eventBus.emit({
              eventId: crypto.randomUUID(),
              type: 'tool.called',
              ...baseEnvelope,
              agentName: (event.data.agent as string) || agentName || '',
              payload: renderPayloadForPipelineEvent(
                {
                  toolName: event.data.toolName,
                  parameters: event.data.input || {},
                },
                sessionRef,
              ),
            } as AnyPlatformEvent);
          }

          if (isCompletedToolCall) {
            this._eventBus.emit({
              eventId: crypto.randomUUID(),
              type: 'tool.completed',
              ...baseEnvelope,
              agentName: (event.data.agent as string) || agentName || '',
              payload: {
                toolName: event.data.toolName,
                durationMs: event.data.latencyMs || event.data.durationMs || 0,
                success:
                  event.data.success ??
                  (event.data.status !== 'error' && event.data.status !== 'rejected'),
              },
            } as AnyPlatformEvent);
          }
        }
      }

      // 6. Forward the canonical event to the original callback (WS send,
      // token accumulation, inline REST traces, etc.). Older callbacks only
      // read type/data, while HTTP chat can now expose the same id/timestamp
      // and causal fields that TraceStore/EventStore receive.
      if (originalOnTraceEvent) {
        originalOnTraceEvent(traceEvent);
      }
    };
  }

  /**
   * Fire-and-forget event emission to the EventBus (Kafka pipeline).
   * No-ops silently when the bus is not set (EVENT_KAFKA_ENABLED=false).
   */
  private emitEvent(type: string, session: RuntimeSession, payload: unknown): void {
    if (!this._eventBus) return;
    const role =
      type === 'message.user' ? 'user' : type === 'message.agent' ? 'assistant' : undefined;
    this._eventBus.emit({
      eventId: crypto.randomUUID(),
      type,
      tenantId: session.tenantId || '',
      projectId: session.projectId || '',
      sessionId: session.id,
      agentName: session.agentName || '',
      channel: session.channelType || 'unknown',
      timestamp: new Date().toISOString(),
      payload: renderPayloadForPipelineEvent(payload, session, role),
    } as AnyPlatformEvent);
  }

  private emitRenderableAgentMessage(
    session: RuntimeSession,
    result: Pick<
      ExecutionResult,
      'response' | 'richContent' | 'actions' | 'voiceConfig' | 'localization' | 'responseMetadata'
    >,
  ): void {
    if (!hasRenderableAgentMessagePayload(result)) {
      return;
    }

    this.emitEvent(
      'message.agent',
      session,
      buildMessageAgentPayload({
        messageId: crypto.randomUUID(),
        messageIndex: session.conversationHistory.length,
        result,
      }),
    );
  }

  private async handleReturnToParentResult(
    session: RuntimeSession,
    result: ExecutionResult,
    onChunk?: (chunk: string) => void,
    onTraceEvent?: (event: { type: string; data: Record<string, unknown> }) => void,
    options?: ExecuteMessageOptions,
  ): Promise<ExecutionResult | null> {
    const activeThread = getActiveThread(session);
    if (!activeThread || session.threadStack.length === 0) {
      return null;
    }

    const parentIndex = session.threadStack.pop()!;
    session.handoffStack = session.handoffStack.slice(0, -1);
    const parentThread = session.threads[parentIndex];
    parentThread.status = 'active';
    session.activeThreadIndex = parentIndex;

    const forwardedMsg =
      typeof activeThread.data.values._forwarded_message === 'string'
        ? (activeThread.data.values._forwarded_message as string)
        : '';
    if (forwardedMsg) {
      parentThread.conversationHistory.push({
        role: 'user',
        content: forwardedMsg,
      });
      delete activeThread.data.values._forwarded_message;
    }

    syncThreadToSession(session);
    refreshExecutionTreeProjection(session);

    // Clear child-agent-scoped session state so it doesn't bleed into the parent.
    // Without this, the child's _effectiveConfig (which may have an empty tools list)
    // persists and causes the parent's tools to resolve as [] on subsequent turns.
    session._effectiveConfig = undefined;
    session._activeProfileNames = undefined;
    session.resolvedEnableThinking = undefined;
    session.resolvedThinkingBudget = undefined;
    session.resolvedThoughtDescription = undefined;
    session.resolvedCompactionThreshold = undefined;
    session.resolvedModelId = undefined;
    session._streamingConfig = undefined;

    // Re-wire tool executor for the parent agent's tools.
    // The child's toolExecutor is bound to the child's tool definitions — without
    // re-wiring, tool calls on subsequent turns fail with "Cannot read properties
    // of undefined (reading 'get')" because the parent's tools aren't in the
    // child's ToolBindingExecutor map.
    this.llmWiring.wireToolExecutor(
      session,
      session.compilationOutput,
      session.authToken,
      session.tenantId,
      session.projectId,
    );

    session.llmClient = parentThread.llmClient;

    const autoTarget =
      typeof result.action?.target === 'string' ? (result.action.target as string) : undefined;
    const rerouteError =
      typeof result.action?.rerouteError === 'string'
        ? (result.action.rerouteError as string)
        : undefined;
    if (autoTarget && rerouteError) {
      return buildFailedHandoffExecutionResult(session, autoTarget, rerouteError);
    }
    if (autoTarget && forwardedMsg) {
      if (result.action?.detectionMode === 'pipeline') {
        return this.executeMessage(session.id, forwardedMsg, onChunk, onTraceEvent, {
          ...options,
          messageForwardedFromHandoff: true,
        });
      }

      const handoffResult = await this.routing.handleHandoff(
        session,
        { target: autoTarget, message: forwardedMsg },
        onChunk,
        onTraceEvent,
        options,
      );

      if (!handoffResult.success) {
        return buildFailedHandoffExecutionResult(session, autoTarget, handoffResult.error);
      }

      return buildHandoffExecutionResult(session, autoTarget, handoffResult, {
        stateUpdates: {},
      });
    }

    return null;
  }

  private async handleActiveReasoningChildParentReroute(
    session: RuntimeSession,
    currentMessage: string,
    onChunk?: (chunk: string) => void,
    onTraceEvent?: (event: { type: string; data: Record<string, unknown> }) => void,
    options?: ExecuteMessageOptions,
  ): Promise<ExecutionResult | null> {
    const activeThread = getActiveThread(session);
    if (
      !activeThread ||
      session.currentFlowStep !== undefined ||
      !activeThread.returnExpected ||
      session.threadStack.length === 0 ||
      !currentMessage.trim()
    ) {
      return null;
    }

    const parentRoute = await detectParentSupervisorRoute({
      ctx: this as unknown as ExecutorContext,
      session,
      currentMessage,
      currentAgentName: activeThread.agentName,
      onTraceEvent,
    });

    if (!parentRoute) {
      return null;
    }

    onTraceEvent?.({
      type: 'digression',
      data: {
        agentName: activeThread.agentName,
        intent: parentRoute.category,
        matched: parentRoute.matched,
        ...toGatherInterruptTrace(parentRoute),
        action: 'return_to_parent',
        target: parentRoute.target,
        ...(parentRoute.kind === 'blocked' ? { rerouteError: parentRoute.error } : {}),
      },
    });

    const returnToParent = this.routing.handleReturnToParent(
      session,
      {
        reason:
          parentRoute.kind === 'blocked'
            ? parentRoute.error
            : `Detected parent supervisor intent "${parentRoute.category}" before child reasoning turn.`,
        message: currentMessage,
      },
      onTraceEvent,
    );

    if (!returnToParent.success) {
      return null;
    }

    return this.handleReturnToParentResult(
      session,
      {
        response: '',
        action: {
          type: 'return_to_parent',
          target: parentRoute.target,
          forwardedMessage: currentMessage,
          category: parentRoute.category,
          detectionMode: parentRoute.detectionMode,
          ...(parentRoute.lexicalMatchType
            ? { lexicalMatchType: parentRoute.lexicalMatchType }
            : {}),
          ...(parentRoute.kind === 'blocked' ? { rerouteError: parentRoute.error } : {}),
        },
      },
      onChunk,
      onTraceEvent,
      options,
    );
  }

  /**
   * Execute a user message and return the response.
   *
   * @internal Callers should use ExecutionCoordinator.submit() instead of calling
   * this directly. Direct calls bypass queue, dedup, and concurrency management.
   */
  async executeMessage(
    sessionId: string,
    userMessage: string,
    onChunk?: (chunk: string) => void,
    onTraceEvent?: (event: { type: string; data: Record<string, unknown> }) => void,
    options?: ExecuteMessageOptions,
  ): Promise<ExecutionResult> {
    let session = this.sessions.get(sessionId);
    log.debug('[SESSION-MAP] executeMessage lookup', {
      sessionId,
      foundInMap: !!session,
      mapSize: this.sessions.size,
      agentName: session?.agentName,
    });

    // Track whether this is a recursive call (handoff/delegate within same session).
    // Recursive calls must NOT run stale checks — the in-memory session is the
    // source of truth during an active execution chain on this pod.
    const isRecursive = this._executingSessions.has(sessionId);

    // If session not in local map, try to rehydrate from SessionService (distributed pod support)
    if (!session) {
      session =
        (await this.rehydrateSession(
          sessionId,
          options?.sessionLocator ? { locator: options.sessionLocator } : undefined,
        )) ?? undefined;
    } else if (!isRecursive) {
      // Check if another pod updated this session since we last synced.
      // Skip during recursive calls — our in-memory state is authoritative.
      session = (await this.checkAndRefreshIfStale(session)) ?? session;
    }

    if (!session) {
      throw new AppError(`Session not found: ${sessionId}`, { ...ErrorCodes.NOT_FOUND });
    }

    const hadTransferLifecycleAtEntry = Boolean(
      session.transferInitiated ||
      session.isEscalated ||
      session.recentTransferEndedAt !== undefined,
    );

    if (options?.sessionMetadata) {
      updateSessionMetadata(session.data, options.sessionMetadata);
    }

    const contactPreferenceResult = extractInteractionContextFromContactPreferences(
      session.callerContext?.contactPreferences,
      'sanitize',
    );
    const sessionMetadataInteraction = extractLegacyClientInfoInteractionContext(
      options?.sessionMetadata,
      'sanitize',
    );
    const messageMetadataInteraction = extractInteractionContextFromSdkMessageMetadata(
      options?.messageMetadata,
    );
    const explicitInteractionContext = mergeInteractionContextInputs(
      sessionMetadataInteraction.success ? sessionMetadataInteraction.data : undefined,
      messageMetadataInteraction,
      options?.interactionContext,
    );
    const channelInteractionContextHint = options?.interactionContextHint
      ? {
          ...options.interactionContextHint,
          source: 'channel' as const,
          confidence: 'medium' as const,
        }
      : undefined;
    const existingInteractionState = readSessionInteractionState(session.data);
    const inferredInteractionContext =
      !explicitInteractionContext &&
      !options?.resumeIntentReplay &&
      !options?.messageForwardedFromHandoff &&
      options?.messageSource !== 'delegate' &&
      options?.messageSource !== 'fan_out'
        ? inferInteractionContextFromUserMessage(
            userMessage,
            existingInteractionState?.current.language ??
              existingInteractionState?.preference?.language,
          )
        : undefined;
    const messageHintInteractionContext = channelInteractionContextHint
      ? {
          ...mergeInteractionContextInputs(
            inferredInteractionContext,
            channelInteractionContextHint,
          ),
          source: 'channel' as const,
          confidence: 'medium' as const,
        }
      : inferredInteractionContext;

    const isResumeIntentReplay = options?.resumeIntentReplay === true;
    const rawUserMessage = userMessage;
    const isMessageForwardedFromHandoff = options?.messageForwardedFromHandoff === true;
    const executionMessageSource = options?.messageSource;
    const isDelegatedExecutionInput =
      executionMessageSource === 'delegate' || executionMessageSource === 'fan_out';
    if (rawUserMessage.trim().length > 0 && !options?.actionEvent) {
      userMessage = await renderUserMessageForFillerModel(session, userMessage);
    }
    const resumeIntentReplayWasActive = session._resumeIntentReplayActive === true;
    if (isResumeIntentReplay) {
      session._resumeIntentReplayActive = true;
    }

    const hasPendingQueuedConfirmation =
      session.waitingForInput?.includes('_queued_intent_confirmation_') &&
      (session.intentQueue?.pending?.length ?? 0) > 0;
    const hasPendingDisambiguationChoice =
      session.waitingForInput?.includes('_disambiguation_choice') &&
      Array.isArray(session.data.values._disambiguation_intents) &&
      session.data.values._disambiguation_intents.length > 0;
    const hasPendingInteractiveMultiIntentInput =
      hasPendingQueuedConfirmation || hasPendingDisambiguationChoice;
    let finalizedActionType: string | undefined;
    const responseProvenance = createResponseProvenanceAccumulator();
    const finalizeExecutionResult = (result: ExecutionResult): ExecutionResult => {
      const finalizedResult = applyExecutionResponseVisibility(
        result.responseMetadata
          ? result
          : {
              ...result,
              responseMetadata: buildResponseMessageMetadata(responseProvenance),
            },
        options,
      );
      finalizedActionType = finalizedResult.action?.type;
      const contentEnvelope = buildExecutionResultContentEnvelope(finalizedResult);

      const activeThread = getActiveThread(session);
      const appliedToActiveThread = activeThread
        ? applyResponseMetadataToLatestAssistantMessage(
            activeThread.conversationHistory,
            finalizedResult.response,
            finalizedResult.responseMetadata,
            contentEnvelope,
          )
        : false;

      if (
        !appliedToActiveThread &&
        session.conversationHistory !== activeThread?.conversationHistory
      ) {
        applyResponseMetadataToLatestAssistantMessage(
          session.conversationHistory,
          finalizedResult.response,
          finalizedResult.responseMetadata,
          contentEnvelope,
        );
      }

      if (onTraceEvent && hasRenderableAgentMessagePayload(finalizedResult)) {
        onTraceEvent({
          type: 'agent_response',
          data: {
            agentName: session.agentName || 'unknown',
            content: finalizedResult.response,
            response: finalizedResult.response,
            responseMetadata: finalizedResult.responseMetadata,
            ...(contentEnvelope ? { contentEnvelope } : {}),
            isFinalForTurn: true,
            source: 'finalizeExecutionResult',
          },
        });
      }

      return finalizedResult;
    };
    const originalOnTraceEvent = onTraceEvent;
    onTraceEvent = (event) => {
      accumulateResponseProvenance(responseProvenance, event);
      originalOnTraceEvent?.(event);
    };
    inheritsCentralizedTraceHandler(onTraceEvent, originalOnTraceEvent, sessionId);

    if (!isRecursive) {
      this._executingSessions.add(sessionId);
    }

    // ─── Escalation Pause Check ─────────────────────────────────────
    // If the session has an active escalation suspension, reject the message.
    // This prevents message processing while waiting for human resolution.
    // Only check on non-recursive calls (handoff/delegate within escalation is fine).
    if (!isRecursive && session.isEscalated && !hasPendingInteractiveMultiIntentInput) {
      try {
        const suspensionStore =
          this._asyncInfra?.suspensionStore ??
          (isDatabaseReady()
            ? new (await import('./execution/mongo-suspension-store.js')).MongoSuspensionStore()
            : null);

        if (!suspensionStore) {
          log.debug('Skipping escalation suspension lookup — no suspension store available', {
            sessionId,
          });
        } else {
          const suspensions = await suspensionStore.findBySession(sessionId);
          const activeEscalation = suspensions.find(
            (s) => s.continuation?.type === 'escalation' && s.status === 'suspended',
          );
          if (activeEscalation) {
            if (!isRecursive) {
              this._executingSessions.delete(sessionId);
            }
            return finalizeExecutionResult({
              response:
                'Session is escalated and awaiting human resolution. Use POST /:id/escalation/resolve to resume.',
              action: {
                type: 'escalation_blocked',
                escalated: true,
                suspensionId: activeEscalation.suspensionId,
              },
            });
          }
        }
      } catch (err) {
        log.warn('Escalation suspension check failed — allowing message through', {
          sessionId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // Bump activity timestamp
    session.lastActivityAt = new Date();
    const appliedInteractionState = resolveAndApplyInteractionContextToSessionData({
      sessionData: session.data,
      explicit: explicitInteractionContext,
      messageHint: messageHintInteractionContext,
      contactPreference: contactPreferenceResult.success ? contactPreferenceResult.data : undefined,
      agentDefault: resolveAgentDefaultInteractionInput(session.agentIR),
      resolvedAt: session.lastActivityAt,
    });
    const fillerLanguage =
      appliedInteractionState.current.language ??
      appliedInteractionState.preference?.language ??
      undefined;
    const fillerLocale =
      appliedInteractionState.current.locale ??
      appliedInteractionState.preference?.locale ??
      fillerLanguage;
    applyProfileInteractionContextToSessionData(
      session.data,
      mergeProfileInteractionContextInputs(
        appliedInteractionState.current,
        extractProfileInteractionContextFromMetadata(options?.sessionMetadata),
        extractProfileInteractionContextFromMetadata(options?.messageMetadata),
        options?.interactionContext,
      ),
    );

    // Declared outside try so finally can clean up
    let fillerService: FillerMessageService | undefined;
    let fillerStatusVisible = false;

    // ── Centralized agent lifecycle tracking ───────────────────────────────
    // agent_enter is emitted once at the single execution convergence point
    // (covers all 12+ channel handlers: WS, SDK, REST, VXML, AudioCodes, etc.).
    // agent_exit is emitted in the finally block for every exit path.
    let agentLifecycleEmitted = false;
    let lifecycleResult = 'completed';
    let lifecycleError: { type: string; message: string } | undefined;
    let executionStartMs = 0;
    let executingAgentName = '';
    let messageMetadataRestoreState: MessageMetadataRestoreState | undefined;
    const shouldEmitTurnRoot = !isRecursive && !isResumeIntentReplay;
    const runtimeTurnId = resolveRuntimeTurnId(options?.turnId);
    const turnStartedAt = Date.now();
    let turnRootEmitted = false;

    try {
      // Wrap caller's callback with centralized trace storage.
      // All downstream code uses this wrapped handler, so TraceStore + ClickHouse
      // storage happens automatically for every channel without per-handler work.
      onTraceEvent = await this.ensureCentralizedTraceHandler(
        session,
        onTraceEvent,
        getCurrentTraceId(),
      );

      if (shouldEmitTurnRoot && onTraceEvent) {
        const centralizedTurnTraceHandler = onTraceEvent;
        onTraceEvent = (event) => {
          centralizedTurnTraceHandler({
            ...event,
            data: {
              turnId: runtimeTurnId,
              ...event.data,
            },
          });
        };
        markCentralizedTraceHandler(onTraceEvent, sessionId);
        onTraceEvent({
          type: 'turn_start',
          data: {
            turnId: runtimeTurnId,
            sessionId,
            agentName: session.agentName || 'unknown',
            targetAgent: session.agentName || 'unknown',
            messageSource: executionMessageSource ?? 'user',
            sourceAgent: options?.sourceAgent,
            delegationId: options?.delegationId,
            channel: options?.channelMetadata?.channel ?? session.channelType,
            contentLength: rawUserMessage.length,
            hasAttachments: (options?.attachmentIds?.length ?? 0) > 0,
            attachmentCount: options?.attachmentIds?.length ?? 0,
            reasonCode: 'turn_start',
          },
        });
        turnRootEmitted = true;
      }

      // Streaming output guardrails: wrap onChunk to evaluate output guardrails mid-stream.
      // Runs BEFORE voice stripping so guardrails see raw LLM output. On 'terminate',
      // future chunks are dropped and a constraint_check trace event is emitted.
      const dslOutputGuardrails =
        session.agentIR?.constraints?.guardrails?.filter((g) => g.kind === 'output') ?? [];
      // Always check policy — DB policies may define output guardrails even when DSL has none
      const guardrailMods = getGuardrailModules() ?? (await loadGuardrailModules());
      const {
        StreamingGuardrailEvaluator,
        createGuardrailPipeline,
        createLLMEvalFromClient,
        ensureTenantProvidersLoaded,
        getSessionPolicy,
        getSessionGuardrailCacheScopeKey: getStreamGuardrailCacheScopeKey,
        getSessionStreamingConfig: getStreamConfig,
        toStreamingEvalConfig: toStreamConfig,
      } = guardrailMods;
      const streamPolicy = await getSessionPolicy(session);
      const hasOutputGuardrails =
        dslOutputGuardrails.length > 0 ||
        streamPolicy?.additionalGuardrails?.some((g) => g.kind === 'output');

      if (onChunk && hasOutputGuardrails) {
        if (session.tenantId) {
          await ensureTenantProvidersLoaded(session.tenantId);
        }
        const llmEval = session.llmClient ? createLLMEvalFromClient(session.llmClient) : undefined;
        const streamPipeline = createGuardrailPipeline(
          llmEval,
          session.tenantId,
          session.projectId,
          {
            policy: streamPolicy,
            piiRecognizerRegistry: session.piiRecognizerRegistry,
            cacheScopeKey: getStreamGuardrailCacheScopeKey(session),
          },
        );
        // Known trade-off: chunks are forwarded optimistically before async
        // guardrail evaluation completes. Buffering would add latency to every
        // chunk. This is an accepted P2 leak window for streaming performance.
        const streamingEvalConfig = toStreamConfig(getStreamConfig(session));
        const evaluator = new StreamingGuardrailEvaluator(
          dslOutputGuardrails,
          streamingEvalConfig,
          streamPipeline,
          streamPolicy,
          { agentGoal: session.agentIR?.identity?.goal },
        );
        const guardedOnChunk = onChunk;
        onChunk = (chunk: string) => {
          // Sync gate: once terminated, drop all subsequent chunks immediately
          if (evaluator.isTerminated()) return;

          // Fire-and-forget async evaluation; chunks stream optimistically.
          // Termination takes effect on the *next* chunk after a sentence-boundary violation.
          evaluator
            .evaluateChunk(chunk)
            .then((event) => {
              if (event.type === 'terminate' && onTraceEvent) {
                onTraceEvent({
                  type: 'constraint_check',
                  data: {
                    agentName: session.agentName,
                    kind: 'output_streaming',
                    guardrailName: event.violation?.guardrailName ?? 'unknown',
                    action: event.violation?.action ?? 'block',
                    message:
                      event.violation?.message ??
                      formatErrorSync('GUARDRAIL_STREAM_TERMINATED').message,
                    passed: false,
                  },
                });
              }
            })
            .catch((err) => {
              // Fail-open: guardrail errors must not break streaming
              log.warn('Streaming guardrail evaluation error', {
                error: err instanceof Error ? err.message : String(err),
                sessionId,
              });
            });

          // Forward chunk unless already terminated (checked at top of wrapper)
          guardedOnChunk(chunk);
        };
      }

      // Voice safety net: wrap onChunk to strip markdown/emoji for voice sessions.
      // The system prompt asks the LLM to avoid formatting, but this catches anything
      // that slips through — including hardcoded messages from routing, escalation, etc.
      if (onChunk && isVoiceChannel(session)) {
        const originalOnChunk = onChunk;
        onChunk = (chunk: string) => originalOnChunk(stripForVoiceStreamChunk(chunk));
      }

      // Filler messages are scoped to the whole user-message turn:
      // 1. Open a turn-level silence window as soon as execution starts.
      // 2. Pipeline, LLM <status> tags, and operation traces update the pending text.
      // 3. The configured delay remains anchored to message start, not tool completion.
      //
      // The StatusTagParser intercepts <status>...</status> from the LLM stream,
      // strips them from user-visible output, and queues the extracted text as a
      // piggybacked filler. Static fillers fire on operation trace events as fallback.
      // Channel-type resolution (ABLP-710): mirrors isVoiceChannel() two-step fallback.
      // fillerMode:'none' channels (voice_realtime, voice_vxml) skip this block entirely.
      const rawChannel =
        session.channelType ??
        (session.data?.values?.session as Record<string, unknown> | undefined)?.channel;
      const sessionChannelType = typeof rawChannel === 'string' ? rawChannel : undefined;
      const channelFillerDefaults = resolveFillerConfig(sessionChannelType);
      const sessionIsVoiceChannel = isVoiceChannel(session);
      const suppressCustomerVisibleFiller = options?.suppressRenderableOutput === true;

      // Project + channel settings resolution (ABLP-696).
      // channelFillerDefaults (ABLP-710) passed as timing base so voice channels
      // inherit their voiceDelayMs/cooldownMs/maxPerTurn without hardcoded fallbacks.
      let projectRuntimeConfig = session.agentIR?.project_runtime_config;
      if (!projectRuntimeConfig?.filler?.promptRef && session.tenantId && session.projectId) {
        const runtimeConfigFromDb = await resolveProjectRuntimeConfig(
          session.tenantId,
          session.projectId,
        );
        if (runtimeConfigFromDb?.filler) {
          projectRuntimeConfig = {
            ...(projectRuntimeConfig ?? {}),
            ...runtimeConfigFromDb,
            filler: {
              ...(projectRuntimeConfig?.filler ?? {}),
              ...runtimeConfigFromDb.filler,
            },
          };
        }
      }

      const resolvedFillerConfig = resolveFillerRuntimeConfig({
        projectFiller: projectRuntimeConfig?.filler,
        isVoiceChannel: sessionIsVoiceChannel,
        channelDefaults: channelFillerDefaults,
      });

      // Apply none-mode override: voice_realtime/voice_vxml cannot receive mid-flight fillers
      if (!channelFillerDefaults.enabled) {
        resolvedFillerConfig.serviceConfig.enabled = false;
      }

      session._fillerEnabled = Boolean(
        onChunk &&
        resolvedFillerConfig.serviceConfig.enabled &&
        resolvedFillerConfig.piggybackEnabled &&
        !sessionIsVoiceChannel &&
        !suppressCustomerVisibleFiller,
      );
      const voicePromptFillerPreferred = Boolean(
        sessionIsVoiceChannel &&
        !suppressCustomerVisibleFiller &&
        resolvedFillerConfig.promptRef &&
        resolvedFillerConfig.pipelineGenerationEnabled &&
        session.llmClient,
      );
      if (
        sessionIsVoiceChannel &&
        resolvedFillerConfig.serviceConfig.enabled &&
        !suppressCustomerVisibleFiller
      ) {
        log.debug('Resolved voice filler configuration', {
          sessionId,
          projectId: session.projectId,
          hasPromptRef: Boolean(resolvedFillerConfig.promptRef),
          pipelineGenerationEnabled: resolvedFillerConfig.pipelineGenerationEnabled,
          voicePromptFillerPreferred,
        });
      }
      const fillerTurnStartedAt = Date.now();
      const fillerDelayMs =
        resolvedFillerConfig.serviceConfig.voiceDelayMs ??
        resolvedFillerConfig.serviceConfig.chatDelayMs;
      let awaitingPreferredVoicePromptFiller = voicePromptFillerPreferred;
      const waitForFillerDelay = async () => {
        const remainingDelayMs = fillerDelayMs - (Date.now() - fillerTurnStartedAt);
        if (remainingDelayMs > 0) {
          await new Promise((resolve) => setTimeout(resolve, remainingDelayMs));
        }
      };
      const emitStatusClear = () => {
        if (!fillerStatusVisible || !onTraceEvent) return;
        fillerStatusVisible = false;
        onTraceEvent({
          type: 'status_clear',
          data: {},
        });
      };

      if (
        onTraceEvent &&
        resolvedFillerConfig.serviceConfig.enabled &&
        !suppressCustomerVisibleFiller
      ) {
        const buildFallbackCandidate = (operation: StatusOperation) =>
          buildStaticFillerCandidate({
            operation,
            isVoiceChannel: sessionIsVoiceChannel,
            language: fillerLanguage,
            locale: fillerLocale,
          });
        fillerService = new FillerMessageService(
          sessionId,
          resolvedFillerConfig.serviceConfig,
          (statusEvent) => {
            fillerStatusVisible = true;
            // Emit filler as a status_update trace event — channel handlers
            // decide how to render it (WS sends status_update message, voice
            // could TTS it, channels that don't handle it simply ignore it).
            onTraceEvent!({
              type: 'status_update',
              data: {
                text: statusEvent.text,
                operation: statusEvent.operation,
                source: statusEvent.source,
                index: statusEvent.index,
                transient: true,
              },
            });
          },
          {
            normalizeText: (candidate) =>
              normalizeFillerStatusText(candidate.text, {
                isVoiceChannel: sessionIsVoiceChannel,
                language: fillerLanguage,
                locale: fillerLocale,
              }),
          },
        );
        const emitStaticFallbackNow = () => {
          const candidate = buildFallbackCandidate('reasoning');
          fillerService?.emitImmediate(candidate.operation, candidate.text, candidate.source);
        };

        if (voicePromptFillerPreferred) {
          fillerService.openTurn();
        } else {
          const candidate = buildFallbackCandidate('reasoning');
          fillerService.startTurn(candidate.operation, candidate.text, candidate.source);
        }

        // Wire StatusTagParser into onChunk to intercept <status> tags from LLM stream
        const statusTagParser = new StatusTagParser();
        if (onChunk) {
          const fillerOnChunk = onChunk;
          onChunk = (chunk: string) => {
            const { outputChunk, statusText } = statusTagParser.processChunk(chunk);

            // LLM emitted a <status> tag — update the active turn-level filler text.
            if (
              statusText &&
              resolvedFillerConfig.piggybackEnabled &&
              !awaitingPreferredVoicePromptFiller
            ) {
              fillerService!.queueFiller('general', statusText, 'piggybacked');
            }

            // Forward cleaned output (status tags stripped) to the real consumer
            if (outputChunk) {
              fillerService?.cancel(); // Real output arrived — close the filler window
              emitStatusClear();
              fillerOnChunk(outputChunk);
            }
          };
        }

        // Pipeline-generated contextual filler: fire a parallel call to generate
        // text specific to the user's query. When it arrives, it updates the
        // active silence window but does not own timing.
        if (resolvedFillerConfig.pipelineGenerationEnabled && session.llmClient) {
          resolveFillerModel(resolvedFillerConfig, session)
            .then(async (pipelineModel) => {
              if (!pipelineModel || fillerService!.isDestroyed()) return;
              const safeUserMessage = await renderUserMessageForFillerModel(session, userMessage);
              const promptOverride = await resolveRuntimePromptOverride(
                resolvedFillerConfig.promptRef,
                { tenantId: session.tenantId, projectId: session.projectId },
                { userMessage: safeUserMessage },
              );
              return generatePipelineFiller(pipelineModel, safeUserMessage, {
                promptOverride,
                language: fillerLanguage,
                locale: fillerLocale,
                isVoiceChannel: sessionIsVoiceChannel,
              });
            })
            .then(async (text) => {
              if (!fillerService || fillerService.isDestroyed()) {
                return;
              }

              if (voicePromptFillerPreferred) {
                await waitForFillerDelay();
                awaitingPreferredVoicePromptFiller = false;
                if (text) {
                  fillerService.emitImmediate('tool_call', text, 'pipeline');
                } else {
                  emitStaticFallbackNow();
                }
                return;
              }

              if (text) {
                fillerService.queueFiller('tool_call', text, 'pipeline');
              }
            })
            .catch(async (err) => {
              log.debug('Pipeline filler generation failed; static fallback remains available', {
                error: err instanceof Error ? err.message : String(err),
              });
              if (voicePromptFillerPreferred && fillerService && !fillerService.isDestroyed()) {
                await waitForFillerDelay();
                awaitingPreferredVoicePromptFiller = false;
                emitStaticFallbackNow();
              }
            });
        }

        // Operation trace events refine the pending filler text without restarting
        // the message-level trigger interval.
        const fillerOnTraceEvent = onTraceEvent;
        onTraceEvent = (event: { type: string; data: Record<string, unknown> }) => {
          const fillerOp = traceToFillerOperation(event);
          if (fillerOp) {
            const candidate = buildFallbackCandidate(fillerOp);
            if (!awaitingPreferredVoicePromptFiller) {
              fillerService!.queueFiller(candidate.operation, candidate.text, candidate.source);
            }
          }
          fillerOnTraceEvent(event);
        };
        markCentralizedTraceHandler(onTraceEvent, sessionId);
      }

      // Attachment preprocessing: convert attachmentIds → ContentBlocks for the LLM.
      // Uses lazy initialization — only creates the preprocessor if attachments are present.
      // Failures are non-blocking: text message still proceeds if attachment processing fails.
      if (options?.attachmentIds && options.attachmentIds.length > 0 && session.tenantId) {
        const preprocessStartMs = Date.now();
        try {
          const { MultimodalServiceClient } =
            await import('../attachments/multimodal-service-client.js');
          const { MessagePreprocessor } = await import('../attachments/message-preprocessor.js');

          const multimodalUrl = process.env.MULTIMODAL_SERVICE_URL || 'http://localhost:3005';
          const client = new MultimodalServiceClient(multimodalUrl);
          const preprocessor = new MessagePreprocessor(client);

          // Resolve piiPolicy from project → tenant → defaults
          const resolvedPiiPolicy = session.projectId
            ? (
                await import('../attachments/attachment-config-resolver.js').then((m) =>
                  m.resolveAttachmentConfig(session.tenantId!, session.projectId!),
                )
              ).piiPolicy
            : undefined;

          // Resolve vision capability from the session's model
          let supportsVision = false;
          try {
            const { getModelCapabilities } =
              await import('@abl/compiler/platform/llm/model-capabilities.js');
            const modelId = session.resolvedModelId ?? session.agentIR?.execution?.model;
            if (modelId) {
              const caps = getModelCapabilities(modelId);
              supportsVision = caps.supportsVision ?? false;
            }
          } catch {
            // Non-blocking — default to no vision
            log.warn('Failed to resolve model vision capability — defaulting to no vision', {
              sessionId,
            });
          }

          if (onTraceEvent) {
            onTraceEvent({
              type: 'attachment_preprocess_start',
              data: {
                attachmentCount: options.attachmentIds.length,
              },
            });
          }

          const engineReady = await preprocessor.preprocess({
            message: {
              content: userMessage,
              attachmentIds: options.attachmentIds,
              channel: session.channelType || 'digital',
            },
            tenantId: session.tenantId,
            piiPolicy: resolvedPiiPolicy,
            supportsVision,
          });

          // Store content blocks on the session for the reasoning executor to consume
          if (engineReady.contentBlocks.length > 0) {
            session.pendingContentBlocks = engineReady.contentBlocks;
          }

          if (onTraceEvent) {
            onTraceEvent({
              type: 'attachment_preprocess',
              data: {
                attachmentIds: options.attachmentIds,
                attachmentCount: options.attachmentIds.length,
                contentBlockCount: engineReady.contentBlocks.length,
                attachmentSummary: engineReady.metadata.attachmentSummary,
                durationMs: Date.now() - preprocessStartMs,
              },
            });
          }

          log.info('Attachments preprocessed', {
            sessionId,
            attachmentCount: options.attachmentIds.length,
            contentBlockCount: engineReady.contentBlocks.length,
            durationMs: Date.now() - preprocessStartMs,
          });
        } catch (err) {
          // Attachment failures must NOT block the text message from being processed
          log.error('Attachment preprocessing failed — continuing with text only', {
            sessionId,
            attachmentIds: options.attachmentIds,
            error: err instanceof Error ? err.message : String(err),
          });

          if (onTraceEvent) {
            onTraceEvent({
              type: 'attachment_preprocess',
              data: {
                attachmentIds: options.attachmentIds,
                attachmentCount: options.attachmentIds.length,
                error: err instanceof Error ? err.message : String(err),
                durationMs: Date.now() - preprocessStartMs,
              },
            });
          }
        }
      }

      // Agent transfer intercept: if a transfer is active, forward user messages
      // to the agent desktop (e.g. Five9) instead of processing through the bot.
      if (session.transferInitiated && session.isEscalated) {
        try {
          const { getAdapterRegistry, getTransferSessionStore } =
            await import('./agent-transfer/index.js');
          const registry = getAdapterRegistry();
          const store = getTransferSessionStore();
          if (registry && store) {
            // Look up active transfer session by tenantId + contactId + channel.
            // Must use normalizeTransferChannel() to match the key format used when
            // the session was created (e.g. 'web_debug' → 'chat').
            const { sessionKey: transferSessionKey, normalizeTransferChannel } =
              await import('@agent-platform/agent-transfer');
            const rawChannel =
              ((session.callerContext as Record<string, unknown> | undefined)?.channel as string) ||
              session.channelType ||
              'chat';
            const transferChannel = normalizeTransferChannel(rawChannel);
            const transferSessionId = transferSessionKey(
              session.tenantId || '',
              session.id,
              transferChannel,
            );
            const transferSession = await store.get(transferSessionId);
            if (transferSession) {
              const provider = transferSession['provider'] as string;
              const adapter = registry.get(provider);
              if (adapter) {
                log.info('Forwarding user message to agent transfer', {
                  sessionId,
                  provider,
                  transferSessionId,
                  contentLength: userMessage.length,
                });
                await adapter.sendUserMessage(transferSessionId, {
                  content: userMessage,
                });
                const { getAgentTransferTranscriptPersistenceService } =
                  await import('./agent-transfer/transcript-persistence.js');
                await getAgentTransferTranscriptPersistenceService()
                  .persistForwardedUserMessage({
                    transferSessionId,
                    transferSession:
                      transferSession as unknown as import('@agent-platform/agent-transfer').TransferSessionData,
                    content: userMessage,
                    traceId: getCurrentTraceId() ?? undefined,
                  })
                  .catch((persistErr: unknown) => {
                    log.warn(
                      'Agent transfer transcript persistence failed for forwarded user message',
                      {
                        sessionId,
                        transferSessionId,
                        error:
                          persistErr instanceof Error ? persistErr.message : String(persistErr),
                      },
                    );
                  });
                // Signal that message was forwarded to human agent —
                // the WS handler should suppress the response bubble.
                return finalizeExecutionResult({
                  response: '',
                  action: { type: 'transfer_active' as const },
                });
              }
            } else {
              // Transfer session no longer exists in the store — the human agent
              // closed the conversation. Clear stale in-memory flags so the bot
              // resumes normal processing for subsequent user messages.
              log.info('Transfer session ended, clearing stale escalation flags', {
                sessionId,
                transferSessionId,
              });
              clearEscalationStateForBotResume(session);
              session.recentTransferEndedAt = Date.now();
              await this.saveSessionSnapshot(session);
              if (isPostTransferCloseoutMessage(rawUserMessage)) {
                session.isComplete = true;
                session.recentTransferEndedAt = undefined;
                return buildConversationCompleteResult(session, {
                  actionMessage: 'Post-transfer closeout completed',
                });
              }
            }
          }
        } catch (err) {
          log.warn('Agent transfer message forwarding failed, falling back to bot', {
            sessionId,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }

      // Thread-aware: check active thread status
      const activeThread = getActiveThread(session);
      if (
        activeThread &&
        activeThread.status === 'completed' &&
        !hasPendingInteractiveMultiIntentInput
      ) {
        // All threads completed
        return buildConversationCompleteResult(session, {
          agentName: activeThread.agentName,
          agentIR: activeThread.agentIR,
        });
      }

      // Handle suspended thread resumption (async remote handoff callback).
      // When a remote agent completes, ResumptionService calls executeMessage
      // with the remote response. The active thread is the remote thread with
      // status 'suspended' and agentIR null. We must complete it, return to
      // the parent supervisor, and continue the parent's reasoning loop.
      if (activeThread && activeThread.status === 'suspended' && options?.remoteHandoffResume) {
        const remoteResume = options.remoteHandoffResume;
        const parentThreadIndex =
          session.threadStack.length > 0 ? session.threadStack[session.threadStack.length - 1] : -1;
        const parentThread =
          parentThreadIndex >= 0 ? session.threads[parentThreadIndex] : undefined;
        const originalUserIntent = parentThread
          ? contentToString(
              parentThread.conversationHistory.filter((message) => message.role === 'user').pop()
                ?.content || '',
            )
          : '';

        log.info('SUSPENDED REMOTE HANDOFF DETECTED - Starting coordinated resumption', {
          sessionId,
          activeThreadAgent: activeThread.agentName,
          targetAgent: remoteResume.targetAgent,
          threadIndex: session.activeThreadIndex,
          threadStackDepth: session.threadStack.length,
          status: remoteResume.status,
          responseLength: remoteResume.responseText.length,
        });
        const protectedResumeResponse = protectSessionOutputForUser(
          session,
          remoteResume.responseText,
        );
        activeThread.conversationHistory.push({
          role: 'assistant',
          content: protectedResumeResponse.historyText,
        });

        if (tryThreadReturn(session, protectedResumeResponse.historyText, onTraceEvent)) {
          log.info('REMOTE HANDOFF RETURN SUCCESSFUL - Parent agent restored', {
            sessionId,
            parentAgent: session.agentName,
            parentThreadIndex: session.activeThreadIndex,
            returnedFrom: remoteResume.targetAgent,
          });
          if (onChunk) {
            onChunk(protectedResumeResponse.deliveryText);
          }

          const postReturn = await dispatchHandoffOnReturnBehavior(
            session,
            remoteResume.targetAgent,
            {
              baseResponse: protectedResumeResponse.deliveryText,
              originalUserIntent,
              onChunk,
              onTraceEvent,
              executeMessage: this.executeMessage.bind(this),
              isResumeIntentReplay: options.resumeIntentReplay === true,
              baseResponseDelivery: onChunk ? 'already_visible' : 'include_in_result',
              resumeTraceSource:
                remoteResume.status === 'timeout'
                  ? 'remote_handoff_timeout'
                  : 'remote_handoff_resume',
            },
          );

          await this.saveSessionSnapshot(session);
          return finalizeExecutionResult({
            response: postReturn.response ?? protectedResumeResponse.deliveryText,
            action: { type: 'continue' },
          });
        }

        syncThreadToSession(session);
        await this.saveSessionSnapshot(session);
        return finalizeExecutionResult({
          response: protectedResumeResponse.deliveryText,
          action: { type: 'complete', message: 'Remote handoff completed' },
        });
      }

      if (activeThread && activeThread.status === 'suspended') {
        log.info('SUSPENDED THREAD DETECTED - Starting resumption', {
          sessionId,
          activeThreadAgent: activeThread.agentName,
          threadIndex: session.activeThreadIndex,
          threadStackDepth: session.threadStack.length,
          responseLength: userMessage.length,
        });
        const protectedUserMessage = protectSessionOutputForUser(session, userMessage);
        activeThread.conversationHistory.push({
          role: 'assistant',
          content: protectedUserMessage.historyText,
        });

        if (tryThreadReturn(session, protectedUserMessage.historyText, onTraceEvent)) {
          log.info('THREAD RETURN SUCCESSFUL - Parent supervisor restored', {
            sessionId,
            parentAgent: session.agentName,
            parentThreadIndex: session.activeThreadIndex,
          });

          // Deliver the remote agent's response directly to the user.
          // We intentionally skip the parent's reasoning loop here because
          // the conversation flow after async resumption has two consecutive
          // assistant messages (the "working" response + the remote result)
          // with no user message in between. Running the LLM would cause it
          // to re-trigger the handoff in a loop.
          if (onChunk) {
            onChunk(protectedUserMessage.deliveryText);
          }

          // Immediate persist — session was rehydrated from store and must be saved
          // before the response returns (debounced persist risks data loss on pod crash)
          await this.saveSessionSnapshot(session);
          return finalizeExecutionResult({
            response: protectedUserMessage.deliveryText,
            action: { type: 'continue' },
          });
        }

        // No parent to return to (fire-and-forget handoff) — just mark complete
        syncThreadToSession(session);
        await this.saveSessionSnapshot(session);
        return finalizeExecutionResult({
          response: protectedUserMessage.deliveryText,
          action: { type: 'complete', message: 'Remote handoff completed' },
        });
      }

      // Check if conversation is already complete (no active child).
      // Bypass: when the user is responding to a queued-intent confirmation prompt,
      // let the flow-step-executor handle the yes/no and potentially reopen the session.
      if (session.isComplete) {
        if (!hasPendingInteractiveMultiIntentInput) {
          return buildConversationCompleteResult(session);
        }
      }

      if (
        !session.isEscalated &&
        session.recentTransferEndedAt !== undefined &&
        !hasPendingInteractiveMultiIntentInput
      ) {
        const ageMs = Date.now() - session.recentTransferEndedAt;
        const isCloseout = isPostTransferCloseoutMessage(rawUserMessage);

        if (ageMs >= 0 && ageMs <= POST_TRANSFER_CLOSEOUT_WINDOW_MS && isCloseout) {
          session.isComplete = true;
          session.recentTransferEndedAt = undefined;
          return buildConversationCompleteResult(session, {
            actionMessage: 'Post-transfer closeout completed',
          });
        }

        if (ageMs > POST_TRANSFER_CLOSEOUT_WINDOW_MS || !isCloseout) {
          session.recentTransferEndedAt = undefined;
        }
      }

      if (session.isEscalated && !hasPendingInteractiveMultiIntentInput) {
        const { response: mockHumanResponse, resolvedReason } = buildEscalatedSessionMockResponse(
          userMessage,
          session.escalationReason,
        );
        const protectedMockHumanResponse = protectSessionOutputForUser(session, mockHumanResponse);

        ensureCurrentTurnUserHistoryEntry({
          session,
          userMessage,
          rawUserMessage,
          isResumeIntentReplay,
          isMessageForwardedFromHandoff,
        });
        session.conversationHistory.push({
          role: 'assistant',
          content: protectedMockHumanResponse.historyText,
        });

        onTraceEvent?.({
          type: 'escalation',
          data: {
            agent: session.agentName,
            reason: resolvedReason,
            priority: 'medium',
            humanResponse: true,
            message: userMessage,
          },
        });

        lifecycleResult = 'escalate';
        this.debouncedPersist(session);

        return finalizeExecutionResult({
          response: protectedMockHumanResponse.deliveryText,
          action: {
            type: 'escalate',
            reason: resolvedReason,
            priority: 'medium',
            escalated: true,
          },
        });
      }

      // Ensure session has an LLM client (before flow mode which may need it for extraction)
      if (!session.llmClient) {
        await this.llmWiring.ensureSessionLLMClient(session);
      }

      const hasInboundUserMessage = Boolean(userMessage?.trim() || options?.actionEvent);

      // Lazy ON_START: ensure session is initialized before first message.
      // Even if no channel calls initializeSession() explicitly, the first
      // user message triggers it here — every channel gets ON_START for free.
      if (!session.initialized) {
        const initHistorySnapshot = hasInboundUserMessage
          ? {
              sessionHistoryLength: session.conversationHistory.length,
              activeThreadHistoryLength:
                session.threads[session.activeThreadIndex]?.conversationHistory.length,
              activeThreadHistory: session.threads[session.activeThreadIndex]?.conversationHistory,
            }
          : null;
        const initResult = await this.initializeSession(
          sessionId,
          hasInboundUserMessage ? undefined : onChunk,
          onTraceEvent,
          { runInitialFlowStep: !hasInboundUserMessage },
        );
        // If ON_START delegated/handed off, return that result instead of processing the message
        if (initResult?.action?.type === 'delegate' || initResult?.action?.type === 'handoff') {
          return finalizeExecutionResult(initResult);
        }
        if (hasInboundUserMessage && initResult && hasRenderableAgentMessagePayload(initResult)) {
          if (initHistorySnapshot) {
            restoreConversationHistoryLength(session, initHistorySnapshot);
          }
          onTraceEvent?.({
            type: 'engine_decision',
            data: {
              decision: 'lazy_on_start_response_suppressed',
              reason: 'inbound_user_message_already_present',
              agent: session.agentName || 'unknown',
              sessionId,
            },
          });
        } else if (initResult && hasRenderableAgentMessagePayload(initResult)) {
          // If initialization produced a response (e.g. welcome step with actions),
          // return it directly. The user's message will be processed on the next call.
          // Without this, executeFlowStep runs the same step again (doubling the response)
          // because currentFlowStep hasn't advanced when the step has no `then`.
          const initResponseMetadata =
            initResult.responseMetadata ?? buildResponseMessageMetadata(responseProvenance);
          this.emitEvent(
            'message.agent',
            session,
            buildMessageAgentPayload({
              messageId: crypto.randomUUID(),
              messageIndex: session.conversationHistory.length,
              result: {
                ...initResult,
                responseMetadata: initResponseMetadata,
              },
            }),
          );
          return finalizeExecutionResult({
            ...initResult,
            responseMetadata: initResponseMetadata,
          });
        }
      }

      // Sanitize input: reject empty or whitespace-only messages before they reach history.
      // Action events (button/select callbacks) may arrive with empty text from adapters,
      // so bypass this guard when an actionEvent is present.
      const trimmedMessage = userMessage?.trim() ?? '';
      if (!trimmedMessage && !options?.actionEvent) {
        const emptyInputMessage = resolveLocalizedAgentMessageWithMetadata({
          session,
          messageKey: 'empty_input',
          fallbackMessage: session.agentIR?.messages?.empty_input || DEFAULT_MESSAGES.empty_input,
        });
        return finalizeExecutionResult({
          response: emptyInputMessage.text,
          localization: emptyInputMessage.localization,
          action: { type: 'continue' },
        });
      }

      if (trimmedMessage || options?.actionEvent) {
        clearPendingRenderedPayload(session);
      }

      messageMetadataRestoreState = applyMessageMetadataToSession(
        session,
        options?.messageMetadata,
      );

      // ── user_message trace ──────────────────────────────────────────────────
      // Emitted here, before any routing decisions including the parent-reroute
      // check below. handleActiveReasoningChildParentReroute returns early when a
      // child agent's incoming message is rerouted to the parent supervisor —
      // without this pre-emission the user's message is silently dropped from
      // the trace whenever that path fires.
      if (
        onTraceEvent &&
        !isResumeIntentReplay &&
        !isMessageForwardedFromHandoff &&
        !isDelegatedExecutionInput
      ) {
        onTraceEvent({
          type: 'user_message',
          data: {
            message: userMessage,
            sessionId,
            agent: session.agentName || 'unknown',
            ...options?.channelMetadata,
          },
        });
      }
      if (onTraceEvent && isDelegatedExecutionInput) {
        onTraceEvent({
          type: executionMessageSource === 'fan_out' ? 'fan_out_message' : 'delegated_message',
          data: {
            message: userMessage,
            sessionId,
            agent: session.agentName || 'unknown',
            agentName: session.agentName || 'unknown',
            sourceAgent: options?.sourceAgent,
            fromAgent: options?.sourceAgent,
            delegationId: options?.delegationId,
            parentSessionId: options?.parentSessionId,
            parentThreadIndex: options?.parentThreadIndex,
            childThreadIndex: options?.childThreadIndex,
            inputKind: executionMessageSource === 'fan_out' ? 'fan_out' : 'delegated',
          },
        });
      }

      if (
        !isResumeIntentReplay &&
        !isMessageForwardedFromHandoff &&
        !isDelegatedExecutionInput &&
        !options?.actionEvent &&
        session.currentFlowStep === undefined
      ) {
        const parentRerouteResult = await this.handleActiveReasoningChildParentReroute(
          session,
          userMessage,
          onChunk,
          onTraceEvent,
          options,
        );
        if (parentRerouteResult) {
          lifecycleResult = parentRerouteResult.action?.type || 'completed';
          this.debouncedPersist(session);
          return parentRerouteResult;
        }
      }

      // Emit user message event to EventBus (common to all channels and modes)
      if (!isResumeIntentReplay && !isDelegatedExecutionInput) {
        const messageIndex = session.conversationHistory.length;
        this.emitEvent('message.user', session, {
          messageId: crypto.randomUUID(),
          content: userMessage,
          messageIndex,
        });
      }

      // ── Centralized agent lifecycle: agent_enter ────────────────────────────
      // Emitted ONCE here at the single execution convergence point, AFTER all
      // early-exit guards (completed, escalated, empty input, ON_START).
      // Covers all 14 channel handlers (WS, SDK, REST, VXML, AudioCodes,
      // Genesys, Twilio, pipeline, A2A, etc.) without any per-handler code.
      // Note: user_message is emitted above (before routing) so it is always
      // present even when handleActiveReasoningChildParentReroute returns early.
      executionStartMs = Date.now();
      executingAgentName = session.agentName || 'unknown';
      const channelMeta = options?.channelMetadata;
      const agentEnterTrigger =
        isResumeIntentReplay || executionMessageSource === 'resume'
          ? 'resume_intent'
          : executionMessageSource === 'delegate'
            ? 'delegate'
            : executionMessageSource === 'fan_out'
              ? 'fan_out'
              : executionMessageSource === 'handoff' || isMessageForwardedFromHandoff || isRecursive
                ? 'handoff'
                : executionMessageSource === 'system'
                  ? 'system'
                  : 'user_message';
      const lifecycleMessageSource =
        executionMessageSource ??
        (agentEnterTrigger === 'user_message' ? 'user' : agentEnterTrigger);
      if (onTraceEvent) {
        onTraceEvent({
          type: 'agent_enter',
          data: {
            agentName: executingAgentName,
            targetAgent: executingAgentName,
            ...(options?.sourceAgent ? { sourceAgent: options.sourceAgent } : {}),
            ...(options?.delegationId ? { delegationId: options.delegationId } : {}),
            mode: session.currentFlowStep !== undefined ? 'scripted' : 'reasoning',
            trigger: agentEnterTrigger,
            messageSource: lifecycleMessageSource,
            entryReason: agentEnterTrigger,
            reasonCode: `agent_enter_${agentEnterTrigger}`,
            ...(options?.parentSessionId ? { parentSessionId: options.parentSessionId } : {}),
            ...(options?.parentThreadIndex !== undefined
              ? { parentThreadIndex: options.parentThreadIndex }
              : {}),
            ...(options?.childThreadIndex !== undefined
              ? { childThreadIndex: options.childThreadIndex }
              : {}),
            ...(session.currentFlowStep !== undefined
              ? { currentStep: session.currentFlowStep, targetStep: session.currentFlowStep }
              : {}),
            threadStackDepth: session.threadStack?.length ?? 0,
            handoffStackDepth: session.handoffStack?.length ?? 0,
            delegateStackDepth: session.delegateStack?.length ?? 0,
            ...channelMeta,
          },
        });
        agentLifecycleEmitted = true;
      }

      // Check if this is a flow mode agent
      if (session.currentFlowStep !== undefined) {
        // Pass action event to session for flow-step-executor to pick up
        if (options?.actionEvent) {
          session.data.values[SESSION_KEY_ACTION_EVENT] = {
            type: options.actionEvent.type ?? 'action_event',
            actionId: options.actionEvent.actionId,
            value: options.actionEvent.value,
            formData: options.actionEvent.formData,
            renderId: options.actionEvent.renderId,
            source: options.actionEvent.source,
          };
        }
        // Capture agent name before execution — used to detect thread returns below
        const flowAgentBefore = session.agentName;

        // Add the current turn to the active thread history unless it is an
        // internal resume_intent replay. Forwarded handoff turns reuse a copied
        // parent entry when available, otherwise they are appended here.
        const flowUserHistoryIndex = ensureCurrentTurnUserHistoryEntry({
          session,
          userMessage,
          rawUserMessage,
          isResumeIntentReplay,
          isMessageForwardedFromHandoff,
        });
        // Make attachment IDs from this message available to flow step executors
        // (e.g. AwaitAttachmentExecutor). Cleared in finally to avoid leaking across turns.
        session.currentAttachmentIds = options?.attachmentIds;
        try {
          const flowResult = await tracePath(
            'runtime/executor/flow/step-entry',
            this.flowStep.executeFlowStep.bind(this.flowStep),
          )(session, userMessage, onChunk, onTraceEvent, {
            suppressParentSupervisorRoute: isMessageForwardedFromHandoff,
          });
          if (flowResult.action?.type === 'return_to_parent') {
            const reroutedResult = await this.handleReturnToParentResult(
              session,
              flowResult,
              onChunk,
              onTraceEvent,
              options,
            );
            if (reroutedResult) {
              lifecycleResult = reroutedResult.action?.type || 'completed';
              return finalizeExecutionResult(reroutedResult);
            }
          }
          if (
            flowResult.action?.type === 'error' &&
            flowResult.action?.blockedParentReroute === true
          ) {
            const rerouteError =
              typeof flowResult.action?.rerouteError === 'string'
                ? flowResult.action.rerouteError
                : 'Parent supervisor reroute failed.';
            const forwardedMessage =
              typeof flowResult.action?.forwardedMessage === 'string'
                ? flowResult.action.forwardedMessage
                : userMessage;
            const returnToParent = this.routing.handleReturnToParent(
              session,
              {
                reason: rerouteError,
                message: forwardedMessage,
              },
              onTraceEvent,
            );
            if (returnToParent.success) {
              const reroutedResult = await this.handleReturnToParentResult(
                session,
                {
                  ...flowResult,
                  action: {
                    type: 'return_to_parent',
                    target: flowResult.action?.target,
                    rerouteError,
                    forwardedMessage,
                    ...(typeof flowResult.action?.category === 'string'
                      ? { category: flowResult.action.category }
                      : {}),
                    ...(typeof flowResult.action?.detectionMode === 'string'
                      ? { detectionMode: flowResult.action.detectionMode }
                      : {}),
                    ...(typeof flowResult.action?.lexicalMatchType === 'string'
                      ? { lexicalMatchType: flowResult.action.lexicalMatchType }
                      : {}),
                  },
                },
                onChunk,
                onTraceEvent,
                options,
              );
              if (reroutedResult) {
                lifecycleResult = reroutedResult.action?.type || 'completed';
                return finalizeExecutionResult(reroutedResult);
              }
            }
          }
          if (
            flowUserHistoryIndex !== null &&
            flowUserHistoryIndex >= 0 &&
            typeof session.data.values['input'] === 'string' &&
            typeof session.data.values['_raw_input'] === 'string' &&
            session.data.values['_raw_input'] === userMessage &&
            session.data.values['input'] !== session.data.values['_raw_input']
          ) {
            const existingUserEntry = session.conversationHistory[flowUserHistoryIndex];
            if (existingUserEntry?.role === 'user') {
              session.conversationHistory[flowUserHistoryIndex] = {
                ...existingUserEntry,
                content: session.data.values['input'],
              };
            }
          }
          if (options?.suppressRenderableOutput !== true) {
            this.emitRenderableAgentMessage(session, {
              ...flowResult,
              responseMetadata:
                flowResult.responseMetadata ?? buildResponseMessageMetadata(responseProvenance),
            });
          }
          lifecycleResult = flowResult.action?.type || 'completed';

          // POST-FLOW: resume_intent dispatch after thread return.
          // When a multi-turn child flow agent (e.g. authentication) completes and
          // tryThreadReturn switches back to the parent reasoning agent, check if the
          // parent's handoff config declares ON_RETURN: resume_intent. If so,
          // re-execute with the parent's original intent so the parent can continue
          // (e.g. call get_account_info) without the user repeating themselves.
          const flowDidReturn =
            session.agentName !== flowAgentBefore && flowResult.action?.type !== 'handoff';
          if (flowDidReturn) {
            const returnedFrom = flowAgentBefore;
            const parentIR = session.agentIR;
            const parentHandoff = parentIR?.coordination?.handoffs?.find(
              (h: { to: string }) => h.to === returnedFrom,
            );
            const onReturnBehavior = resolveHandoffOnReturnBehavior(parentIR, parentHandoff);

            const resumeHandledByRouting =
              session._resumeIntentHandledByRouting?.from === returnedFrom;
            if (resumeHandledByRouting) {
              delete session._resumeIntentHandledByRouting;
            }
            const handlerHandledByRouting =
              session._returnHandlerHandledByRouting?.from === returnedFrom;
            if (handlerHandledByRouting) {
              delete session._returnHandlerHandledByRouting;
            }

            if (!handlerHandledByRouting && onReturnBehavior) {
              const activeThread = getActiveThread(session);
              if (activeThread) {
                const effectResult = applyHandoffOnReturnEffects(
                  session,
                  activeThread,
                  returnedFrom,
                  onReturnBehavior,
                  {
                    mergeWithLastAssistant: !!flowResult.response,
                    onChunk,
                    onTraceEvent,
                  },
                );
                flowResult.response =
                  combineVisibleResponses(flowResult.response, effectResult.emittedResponse) ??
                  flowResult.response;
              }
            }

            if (
              !isResumeIntentReplay &&
              !resumeHandledByRouting &&
              onReturnBehavior?.action === 'resume_intent'
            ) {
              const currentDepth = session._resumeIntentDepth ?? 0;
              const MAX_DEPTH = 1;
              if (currentDepth < MAX_DEPTH) {
                const originalIntent = contentToString(
                  session.conversationHistory
                    .filter((m: { role: string }) => m.role === 'user')
                    .pop()?.content || '',
                );

                if (originalIntent) {
                  onTraceEvent?.({
                    type: 'resume_intent',
                    data: {
                      from: returnedFrom,
                      sourceAgent: returnedFrom,
                      parentAgent: session.agentName,
                      targetAgent: session.agentName,
                      originalMessage: originalIntent,
                      handoffReturnBehavior: onReturnBehavior.action,
                      reasonCode: 'handoff_return_resume_intent',
                      resumeDepth: currentDepth + 1,
                      source: 'flow_thread_return',
                    },
                  });

                  session._resumeIntentDepth = currentDepth + 1;
                  try {
                    const resumeResult = await this.executeMessage(
                      sessionId,
                      originalIntent,
                      onChunk,
                      onTraceEvent,
                      {
                        resumeIntentReplay: true,
                        messageSource: 'resume',
                        sourceAgent: returnedFrom,
                      },
                    );
                    return finalizeExecutionResult(resumeResult);
                  } finally {
                    if ((session._resumeIntentDepth ?? 0) <= 1) {
                      delete session._resumeIntentDepth;
                    } else {
                      session._resumeIntentDepth = (session._resumeIntentDepth ?? 1) - 1;
                    }
                  }
                }
              }
            }
          }

          return finalizeExecutionResult(flowResult);
        } finally {
          session.currentAttachmentIds = undefined;
        }
      }

      if (!session.llmClient) {
        lifecycleResult = 'error';
        throw new AppError(
          'LLM client not configured. Ensure a TenantModel with credentials is configured for this tenant.',
          { ...ErrorCodes.SERVICE_UNAVAILABLE },
        );
      }

      const hasGatherFields =
        session.agentIR?.gather?.fields && session.agentIR.gather.fields.length > 0;

      // ==========================================================================
      // INPUT GUARDRAILS: Check via pipeline (Tier-1/2/3 + policy)
      // ==========================================================================
      const dslInputGuardrails =
        session.agentIR?.constraints?.guardrails?.filter((g) => !g.kind || g.kind === 'input') ??
        [];
      // Always check policy — DB policies may define input guardrails even when DSL has none
      const {
        createGuardrailPipeline: createInputPipeline,
        createLLMEvalFromClient: createInputLLMEval,
        ensureTenantProvidersLoaded: ensureInputProviders,
      } = await import('./guardrails/pipeline-factory.js');
      const {
        getSessionPolicy: getInputPolicy,
        getSessionGuardrailCacheScopeKey: getInputGuardrailCacheScopeKey,
      } = await import('./execution/session-policy.js');
      const inputPolicy = await getInputPolicy(session);
      const hasInputGuardrails =
        dslInputGuardrails.length > 0 ||
        inputPolicy?.additionalGuardrails?.some((g) => !g.kind || g.kind === 'input');

      if (hasInputGuardrails) {
        if (session.tenantId) {
          await ensureInputProviders(session.tenantId);
        }
        const llmEval = session.llmClient ? createInputLLMEval(session.llmClient) : undefined;
        const inputPipeline = createInputPipeline(llmEval, session.tenantId, session.projectId, {
          policy: inputPolicy,
          piiRecognizerRegistry: session.piiRecognizerRegistry,
          cacheScopeKey: getInputGuardrailCacheScopeKey(session),
        });

        const pipelineResult = await inputPipeline.execute(
          dslInputGuardrails,
          userMessage,
          'input',
          { agentGoal: session.agentIR?.identity?.goal },
          onTraceEvent ? (evt: unknown) => onTraceEvent!(evt as any) : undefined,
          inputPolicy,
        );

        if (pipelineResult.modifiedContent) {
          userMessage = pipelineResult.modifiedContent;
        }

        if (!pipelineResult.passed && pipelineResult.primaryViolation) {
          const v = pipelineResult.primaryViolation;
          const blockMessage = v.message || formatErrorSync('GUARDRAIL_INPUT_BLOCKED').message;
          const protectedBlockMessage = protectSessionOutputForUser(session, blockMessage);
          if (onChunk) onChunk(protectedBlockMessage.deliveryText);
          ensureCurrentTurnUserHistoryEntry({
            session,
            userMessage,
            rawUserMessage,
            isResumeIntentReplay,
            isMessageForwardedFromHandoff,
          });
          session.conversationHistory.push({
            role: 'assistant',
            content: protectedBlockMessage.historyText,
          });

          if (onTraceEvent) {
            onTraceEvent({
              type: 'constraint_check',
              data: {
                agentName: session.agentName,
                kind: 'input',
                guardrailName: v.name,
                action: v.action,
                message: v.message,
                passed: false,
              },
            });
          }

          lifecycleResult = 'constraint_blocked';
          return finalizeExecutionResult({
            response: protectedBlockMessage.deliveryText,
            action: { type: 'constraint_blocked', constraint: `guardrail:${v.name}` },
          });
        }
      }

      // Stamp the current turn onto session context before any pre-reasoning
      // constraint or routing logic runs. `input` reflects the possibly
      // sanitized message for this turn, while `_raw_input` preserves the
      // original user text.
      setCurrentTurnInputContext(session, userMessage, rawUserMessage);

      // ==========================================================================
      // CONSTRAINT CHECKING: Check flat constraints (legacy path)
      // Skip pre-extraction check for agents with GATHER fields — the
      // reasoning-executor re-checks constraints after entity extraction,
      // preventing premature ON_FAIL returns before the user's entities are
      // extracted from their first message.
      // ==========================================================================
      if (!hasGatherFields) {
        const constraintViolation = checkFlatConstraints(session, onTraceEvent);
        if (constraintViolation) {
          ensureCurrentTurnUserHistoryEntry({
            session,
            userMessage,
            rawUserMessage,
            isResumeIntentReplay,
            isMessageForwardedFromHandoff,
          });
          lifecycleResult = 'constraint_blocked';
          return finalizeExecutionResult(
            handleConstraintViolation(session, constraintViolation, onChunk, onTraceEvent),
          );
        }
      }

      // Add user message to history AFTER guardrails so redacted/fixed content is persisted.
      // Forwarded handoff turns are appended only when the child thread does not
      // already contain the copied user entry.
      ensureCurrentTurnUserHistoryEntry({
        session,
        userMessage,
        rawUserMessage,
        isResumeIntentReplay,
        isMessageForwardedFromHandoff,
      });

      // NOTE: user_message trace event is now emitted centrally above (before agent_enter),
      // covering both flow mode and reasoning mode. No per-path emission needed here.
      //
      // ========================================================================
      // DETERMINISTIC PRE-ROUTING: Supervisor guard rules (priority cascade)
      // Evaluate non-intent routing rules in priority order BEFORE the LLM.
      // Guards like validation gates and session bootstrap fire deterministically
      // so the LLM cannot skip them by choosing an intent-based route.
      // After the handoff completes (RETURN: true + resume_intent), executeMessage
      // is re-entered and the guard condition will be false, letting the LLM run.
      //
      // Must run AFTER user message push — handleHandoff captures originalUserIntent
      // from the last user message in conversation history for resume_intent.
      // ========================================================================
      // Some focused unit tests stub RoutingExecutor with only the methods they
      // exercise. Fall back cleanly when deterministic routing is not part of
      // the stubbed surface so executeMessage can still cover the rest of the path.
      const deterministicTarget = this.routing.checkDeterministicRouting?.(session);
      if (deterministicTarget) {
        // Ensure handoffReturnInfo is populated before handleHandoff reads it.
        // Normally buildSystemPrompt or checkHandoffConditions builds this map,
        // but deterministic routing fires before both. Without this, RETURN: true
        // in the HANDOFF config is ignored and resume_intent never fires.
        if (!session.handoffReturnInfo || Object.keys(session.handoffReturnInfo).length === 0) {
          const ir = session.agentIR;
          const returnInfo: Record<string, boolean> = {};
          if (ir?.routing?.rules) {
            for (const rule of ir.routing.rules) {
              returnInfo[rule.to] = (rule as unknown as { return?: boolean }).return === true;
            }
          }
          if (ir?.coordination?.handoffs) {
            for (const h of ir.coordination.handoffs) {
              returnInfo[h.to] = (h as unknown as { return?: boolean }).return === true;
            }
          }
          session.handoffReturnInfo = returnInfo;
        }

        if (onTraceEvent) {
          onTraceEvent({
            type: 'deterministic_routing',
            data: {
              target: deterministicTarget.to,
              condition: deterministicTarget.when,
              priority: deterministicTarget.priority,
              agent: session.agentName,
            },
          });
        }

        const handoffResult = await this.routing.handleHandoff(
          session,
          { target: deterministicTarget.to, message: userMessage },
          onChunk,
          onTraceEvent,
          options,
        );

        if (!handoffResult.success) {
          lifecycleResult = 'error';
          this.debouncedPersist(session);
          return finalizeExecutionResult(
            buildFailedHandoffExecutionResult(session, deterministicTarget.to, handoffResult.error),
          );
        }

        lifecycleResult = 'handoff';
        this.debouncedPersist(session);
        return finalizeExecutionResult(
          buildHandoffExecutionResult(session, deterministicTarget.to, handoffResult, {
            stateUpdates: {},
          }),
        );
      }

      const deterministicHandoffTarget =
        !isResumeIntentReplay &&
        !session.agentIR?.flow &&
        session.agentIR?.metadata?.type !== 'supervisor'
          ? this.routing.checkDeterministicHandoff?.(session)
          : null;
      if (deterministicHandoffTarget) {
        if (!session.handoffReturnInfo || Object.keys(session.handoffReturnInfo).length === 0) {
          const ir = session.agentIR;
          const returnInfo: Record<string, boolean> = {};
          if (ir?.routing?.rules) {
            for (const rule of ir.routing.rules) {
              returnInfo[rule.to] = (rule as unknown as { return?: boolean }).return === true;
            }
          }
          if (ir?.coordination?.handoffs) {
            for (const h of ir.coordination.handoffs) {
              returnInfo[h.to] = (h as unknown as { return?: boolean }).return === true;
            }
          }
          session.handoffReturnInfo = returnInfo;
        }

        if (onTraceEvent) {
          onTraceEvent({
            type: 'deterministic_handoff',
            data: {
              target: deterministicHandoffTarget.to,
              condition: deterministicHandoffTarget.when,
              agent: session.agentName,
            },
          });
        }

        const handoffResult = await this.routing.handleHandoff(
          session,
          { target: deterministicHandoffTarget.to, message: userMessage },
          onChunk,
          onTraceEvent,
          options,
        );

        if (!handoffResult.success) {
          lifecycleResult = 'error';
          this.debouncedPersist(session);
          return finalizeExecutionResult(
            buildFailedHandoffExecutionResult(
              session,
              deterministicHandoffTarget.to,
              handoffResult.error,
            ),
          );
        }

        lifecycleResult = 'handoff';
        this.debouncedPersist(session);
        return finalizeExecutionResult(
          buildHandoffExecutionResult(session, deterministicHandoffTarget.to, handoffResult, {
            stateUpdates: {},
          }),
        );
      }

      // Build system prompt from agent IR
      const systemPrompt = buildSystemPrompt(session);

      // Build tools from agent IR (including action tools)
      const tools = buildTools(session);

      // Capture agent name before execution — used to detect thread returns below
      const agentNameBeforeExecution = session.agentName;

      try {
        const result = await tracePath(
          'runtime/executor/agent-enter',
          this.reasoning.execute.bind(this.reasoning),
        )(session, systemPrompt, tools, onChunk, onTraceEvent, {
          skipInputGuardrails: true,
        });

        // ========================================================================
        // POST-TURN: Return-to-parent handling
        // If the child agent called __return_to_parent__, pop the threadStack,
        // reactivate the parent, and forward the digression message.
        // ========================================================================
        if (result.action?.type === 'return_to_parent') {
          const reroutedResult = await this.handleReturnToParentResult(
            session,
            result,
            onChunk,
            onTraceEvent,
            options,
          );
          if (reroutedResult) {
            lifecycleResult = reroutedResult.action?.type || 'completed';
            this.debouncedPersist(session);
            return finalizeExecutionResult(reroutedResult);
          }
        }

        // ========================================================================
        // POST-TURN: Runtime-evaluated completion (Option C)
        // After each reasoning turn, check if COMPLETE conditions are met in actual
        // state or if all GATHER fields have been collected. This replaces the
        // LLM-driven __complete_conversation__ tool with server-side evaluation.
        // ========================================================================
        if (
          !session.isComplete &&
          result.action?.type !== 'complete' &&
          result.action?.type !== 'handoff' &&
          result.action?.type !== 'escalate' &&
          result.action?.type !== 'return_to_parent'
        ) {
          if (this.routing.checkAndMarkComplete(session, onTraceEvent)) {
            // Session auto-completed. Update result action so caller knows.
            // The LLM's response is already sent — no additional message needed.
            result.action = { type: 'complete', message: result.response };
            tryThreadReturn(session, result, onTraceEvent);
          }
        }

        // ========================================================================
        // POST-TURN: resume_intent dispatch after thread return
        // When a child agent completes and returns to parent, check if the parent's
        // handoff config declares ON_RETURN: resume_intent. If so, re-execute with
        // the parent's last user message to auto-continue without user repeating.
        // This handles multi-turn child agents (auth, booking, etc.) that complete
        // across several messages — handleHandoff only fires for the first message.
        // ========================================================================
        const didThreadReturn =
          session.agentName !== agentNameBeforeExecution && result.action?.type !== 'handoff';
        if (didThreadReturn) {
          const returnedFromAgent = agentNameBeforeExecution;
          const parentIR = session.agentIR;
          const handoffConfig = parentIR?.coordination?.handoffs?.find(
            (h: { to: string }) => h.to === returnedFromAgent,
          );
          const onReturnBehavior = resolveHandoffOnReturnBehavior(parentIR, handoffConfig);

          const resumeHandledByRouting =
            session._resumeIntentHandledByRouting?.from === returnedFromAgent;
          if (resumeHandledByRouting) {
            delete session._resumeIntentHandledByRouting;
          }
          const handlerHandledByRouting =
            session._returnHandlerHandledByRouting?.from === returnedFromAgent;
          if (handlerHandledByRouting) {
            delete session._returnHandlerHandledByRouting;
          }

          if (!handlerHandledByRouting && onReturnBehavior) {
            const activeThread = getActiveThread(session);
            if (activeThread) {
              const effectResult = applyHandoffOnReturnEffects(
                session,
                activeThread,
                returnedFromAgent,
                onReturnBehavior,
                {
                  mergeWithLastAssistant: !!result.response,
                  onChunk,
                  onTraceEvent,
                },
              );
              result.response =
                combineVisibleResponses(result.response, effectResult.emittedResponse) ??
                result.response;
            }
          }

          if (
            !isResumeIntentReplay &&
            !resumeHandledByRouting &&
            onReturnBehavior?.action === 'resume_intent'
          ) {
            const currentDepth = session._resumeIntentDepth ?? 0;
            const MAX_DEPTH = 1;
            if (currentDepth < MAX_DEPTH) {
              // Replay the parent's last user message (the original intent before child ran)
              const originalIntent = contentToString(
                session.conversationHistory.filter((m: { role: string }) => m.role === 'user').pop()
                  ?.content || '',
              );

              if (originalIntent) {
                if (onTraceEvent) {
                  onTraceEvent({
                    type: 'resume_intent',
                    data: {
                      from: returnedFromAgent,
                      sourceAgent: returnedFromAgent,
                      parentAgent: session.agentName,
                      targetAgent: session.agentName,
                      originalMessage: originalIntent,
                      handoffReturnBehavior: onReturnBehavior.action,
                      reasonCode: 'handoff_return_resume_intent',
                      resumeDepth: currentDepth + 1,
                    },
                  });
                }

                session._resumeIntentDepth = currentDepth + 1;
                try {
                  const resumeResult = await this.executeMessage(
                    sessionId,
                    originalIntent,
                    onChunk,
                    onTraceEvent,
                    {
                      resumeIntentReplay: true,
                      messageSource: 'resume',
                      sourceAgent: returnedFromAgent,
                    },
                  );
                  lifecycleResult = resumeResult.action?.type || 'completed';
                  return finalizeExecutionResult(resumeResult);
                } finally {
                  if ((session._resumeIntentDepth ?? 0) <= 1) {
                    delete session._resumeIntentDepth;
                  } else {
                    session._resumeIntentDepth = (session._resumeIntentDepth ?? 1) - 1;
                  }
                }
              }
            }
          }
        }

        // Emit agent response event to EventBus (common to all channels)
        if (options?.suppressRenderableOutput !== true) {
          this.emitRenderableAgentMessage(session, {
            ...result,
            responseMetadata:
              result.responseMetadata ?? buildResponseMessageMetadata(responseProvenance),
          });
        }

        // Schedule debounced persist after successful execution
        this.debouncedPersist(session);

        // Refresh session TTL explicitly — cheap safety net alongside save().
        // save() already calls EXPIRE via Lua, but touch() guarantees it even if
        // the debounced persist hasn't fired yet or save encounters a version conflict.
        this.getSessionServiceAsync()
          .then((svc) => {
            const locator = buildSessionLocator(session);
            const activityTs =
              typeof session.lastActivityAt === 'number' && session.lastActivityAt > 0
                ? new Date(session.lastActivityAt)
                : undefined;
            if (locator) {
              return svc.touchScoped(locator, activityTs);
            }
            return svc.touch(session.id, activityTs);
          })
          .catch((err) =>
            log.warn('session TTL touch failed', {
              error: err instanceof Error ? err.message : String(err),
            }),
          );

        lifecycleResult = result.action?.type || 'completed';
        return finalizeExecutionResult(result);
      } catch (error) {
        lifecycleResult = 'error';
        const operatorDiagnostic = getLlmOperatorDiagnostic(error);
        const errorEnvelope = buildRuntimeErrorEnvelope(error, {
          traceId: getCurrentTraceId() ?? undefined,
          agentName: session.agentName,
        });
        lifecycleError = {
          type: 'execution_error',
          message:
            errorEnvelope?.customer_message ??
            operatorDiagnostic?.customerMessage ??
            (error instanceof Error ? error.message : String(error)),
        };
        log.error('Execution error', {
          error: error instanceof Error ? error.message : String(error),
        });

        if (onTraceEvent) {
          onTraceEvent({
            type: 'error',
            data: {
              errorType: lifecycleError.type,
              message: lifecycleError.message,
              ...(operatorDiagnostic ? { diagnostic: operatorDiagnostic } : {}),
              ...(errorEnvelope ? { errorEnvelope } : {}),
            },
          });
        }

        throw error;
      }
    } finally {
      restoreMessageMetadataOnSession(session, messageMetadataRestoreState);

      // Clean up filler service
      if (fillerStatusVisible && onTraceEvent) {
        fillerStatusVisible = false;
        onTraceEvent({
          type: 'status_clear',
          data: {},
        });
      }
      fillerService?.destroy();

      // ── Centralized agent lifecycle: agent_exit ──────────────────────────
      // Emitted for EVERY exit path (success, error, constraint block, etc.)
      // after agent_enter was emitted. Single point — no per-handler code needed.
      if (agentLifecycleEmitted && onTraceEvent) {
        try {
          const nextAgent =
            session.agentName && session.agentName !== executingAgentName
              ? session.agentName
              : undefined;
          const exitLifecycleResult =
            lifecycleResult === 'handoff' && !nextAgent ? 'continue' : lifecycleResult;
          const exitReasonCode =
            exitLifecycleResult === 'error'
              ? 'agent_exit_error'
              : `agent_exit_${exitLifecycleResult}`;
          onTraceEvent({
            type: 'agent_exit',
            data: {
              agentName: executingAgentName,
              targetAgent: executingAgentName,
              ...(nextAgent ? { nextAgent } : {}),
              result: exitLifecycleResult,
              exitReason: exitLifecycleResult,
              exitReasonCode,
              terminalAction: exitLifecycleResult,
              responseDisposition: resolveAgentExitResponseDisposition(exitLifecycleResult),
              reasonCode: exitReasonCode,
              ...(exitLifecycleResult !== lifecycleResult
                ? {
                    originalTerminalAction: lifecycleResult,
                    returnedHandoff: true,
                  }
                : {}),
              durationMs: Date.now() - executionStartMs,
              ...(session.currentFlowStep !== undefined
                ? { currentStep: session.currentFlowStep, targetStep: session.currentFlowStep }
                : {}),
              threadStackDepth: session.threadStack?.length ?? 0,
              handoffStackDepth: session.handoffStack?.length ?? 0,
              delegateStackDepth: session.delegateStack?.length ?? 0,
              ...(lifecycleError ? { error: lifecycleError } : {}),
            },
          });
        } catch (err) {
          log.warn('agent_exit trace emission failed', {
            sessionId,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }

      if (turnRootEmitted && onTraceEvent) {
        try {
          const turnOutcome =
            lifecycleResult === 'error'
              ? 'error'
              : finalizedActionType === 'complete'
                ? 'completed'
                : 'continued';
          onTraceEvent({
            type: 'turn_end',
            data: {
              turnId: runtimeTurnId,
              sessionId,
              agentName: session.agentName || executingAgentName || 'unknown',
              targetAgent: session.agentName || executingAgentName || 'unknown',
              messageSource: executionMessageSource ?? 'user',
              sourceAgent: options?.sourceAgent,
              delegationId: options?.delegationId,
              outcome: turnOutcome,
              terminalAction: finalizedActionType ?? lifecycleResult,
              reasonCode:
                lifecycleResult === 'error' ? 'turn_end_error' : `turn_end_${turnOutcome}`,
              durationMs: Date.now() - turnStartedAt,
              ...(lifecycleError ? { error: lifecycleError } : {}),
            },
          });
        } catch (err) {
          log.warn('turn_end trace emission failed', {
            sessionId,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }

      if (
        !isRecursive &&
        (hadTransferLifecycleAtEntry ||
          session.transferInitiated ||
          session.isEscalated ||
          session.recentTransferEndedAt !== undefined)
      ) {
        try {
          const { getAgentTransferTranscriptPersistenceService } =
            await import('./agent-transfer/transcript-persistence.js');
          await getAgentTransferTranscriptPersistenceService().flushRuntimeSessionTransferTranscript(
            {
              runtimeSessionId: session.id,
              tenantId: session.tenantId,
              channelType: session.callerContext?.channel ?? session.channelType,
              parentConversationSessionId:
                resolveRuntimeTransferParentConversationSessionId(session),
              reason:
                lifecycleResult === 'error' ? 'runtime_execution_error' : 'runtime_execution_exit',
            },
          );
        } catch (err) {
          log.warn('Agent transfer transcript queue flush failed during execution teardown', {
            sessionId,
            tenantId: session.tenantId,
            projectId: session.projectId,
            result: lifecycleResult,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }

      // Clear execution tracking — only the outermost call removes the flag.
      // Recursive calls (handoff/delegate) leave it set so inner calls skip stale checks.
      if (isResumeIntentReplay) {
        if (resumeIntentReplayWasActive) {
          session._resumeIntentReplayActive = true;
        } else {
          delete session._resumeIntentReplayActive;
        }
      }

      if (!isRecursive) {
        this._executingSessions.delete(sessionId);
      }
    }
  }

  async executeRealtimeToolCall(
    sessionId: string,
    toolName: string,
    input: Record<string, unknown>,
    onTraceEvent?: (event: { type: string; data: Record<string, unknown> }) => void,
    options?: {
      sessionLocator?: SessionLocator;
    },
  ): Promise<{
    result: unknown;
    activeAgentName: string;
    activeAgentIR: AgentIR | null;
  }> {
    let session = this.sessions.get(sessionId);
    const isRecursive = this._executingSessions.has(sessionId);

    if (!session) {
      session =
        (await this.rehydrateSession(
          sessionId,
          options?.sessionLocator ? { locator: options.sessionLocator } : undefined,
        )) ?? undefined;
    } else if (!isRecursive) {
      session = (await this.checkAndRefreshIfStale(session)) ?? session;
    }

    if (!session) {
      throw new AppError(`Session not found: ${sessionId}`, { ...ErrorCodes.NOT_FOUND });
    }

    let result: unknown;
    const agentNameBeforeTool = session.agentName;
    const parentThreadIndex =
      session.threadStack.length > 0 ? session.threadStack[session.threadStack.length - 1] : -1;
    const parentThreadBeforeTool =
      parentThreadIndex >= 0 ? session.threads[parentThreadIndex] : undefined;
    const parentOriginalUserIntent = contentToString(
      parentThreadBeforeTool?.conversationHistory.filter((message) => message.role === 'user').pop()
        ?.content || '',
    );

    if (!toolName || typeof toolName !== 'string') {
      throw new AppError('Realtime tool call is missing toolName', { ...ErrorCodes.BAD_REQUEST });
    }

    if (!session.initialized && isGoogleRealtimeSession(session)) {
      await this.initializeSession(sessionId, () => undefined, onTraceEvent);
    }

    const realtimeToolCall: ToolCall = {
      id: crypto.randomUUID(),
      name: toolName,
      input,
    };

    const reasoningToolDispatcher = this.reasoning as unknown as RealtimeReasoningToolDispatcher;
    const fallbackThreadIndex = this.findGoogleRealtimeDeclaringThreadIndex(session, toolName);
    const toolExecution =
      fallbackThreadIndex !== null
        ? await this.executeGoogleRealtimeAncestorToolCall(
            session,
            fallbackThreadIndex,
            realtimeToolCall,
            onTraceEvent,
            reasoningToolDispatcher,
          )
        : await reasoningToolDispatcher.executeToolCall(
            session,
            realtimeToolCall,
            undefined,
            onTraceEvent,
            realtimeToolCall.id,
          );
    result = toolExecution.toolResult;

    let returnHandlerAlreadyDispatched = false;
    let forwardedReturnMessage = '';

    if (toolExecution.action?.type === 'return_to_parent') {
      forwardedReturnMessage =
        typeof toolExecution.action.forwardedMessage === 'string'
          ? toolExecution.action.forwardedMessage
          : typeof input.message === 'string'
            ? input.message
            : '';
      const reroutedResult = await this.handleReturnToParentResult(
        session,
        {
          response: '',
          action: toolExecution.action,
          stateUpdates: {},
        },
        undefined,
        onTraceEvent,
      );

      if (reroutedResult?.response) {
        result = reroutedResult.response;
        returnHandlerAlreadyDispatched = true;
      }
    }

    if (toolExecution.action?.type === 'complete') {
      tryThreadReturn(session, extractVisibleResponseText(result) ?? '', onTraceEvent);
    }

    const shouldDispatchReturnHandler =
      toolExecution.action?.type === 'return_to_parent' ||
      toolExecution.action?.type === 'complete';

    if (
      shouldDispatchReturnHandler &&
      !returnHandlerAlreadyDispatched &&
      session.agentName !== agentNameBeforeTool
    ) {
      const returnDispatch = await dispatchHandoffOnReturnBehavior(session, agentNameBeforeTool, {
        baseResponse:
          toolExecution.action?.type === 'complete'
            ? extractVisibleResponseText(result)
            : undefined,
        originalUserIntent: forwardedReturnMessage || parentOriginalUserIntent,
        onTraceEvent,
        executeMessage: this.executeMessage.bind(this),
        baseResponseDelivery: 'include_in_result',
        resumeTraceSource:
          toolExecution.action?.type === 'return_to_parent'
            ? 'voice_realtime_return_to_parent'
            : 'voice_realtime_child_complete',
      });

      if (returnDispatch.response) {
        result = returnDispatch.response;
      }
    }

    this.debouncedPersist(session);
    this.getSessionServiceAsync()
      .then((svc) => {
        const locator = buildSessionLocator(session);
        const activityTs =
          typeof session.lastActivityAt === 'number' && session.lastActivityAt > 0
            ? new Date(session.lastActivityAt)
            : undefined;
        if (locator) {
          return svc.touchScoped(locator, activityTs);
        }
        return svc.touch(session.id, activityTs);
      })
      .catch((err) =>
        log.warn('session TTL touch failed after realtime tool call', {
          error: err instanceof Error ? err.message : String(err),
        }),
      );

    return {
      result,
      activeAgentName: session.agentName,
      activeAgentIR: getActiveThread(session)?.agentIR || session.agentIR,
    };
  }

  private findGoogleRealtimeDeclaringThreadIndex(
    session: RuntimeSession,
    toolName: string,
  ): number | null {
    return resolveGoogleRealtimeDeclaringThreadIndex(session, toolName);
  }

  private async executeGoogleRealtimeAncestorToolCall(
    session: RuntimeSession,
    declaringThreadIndex: number,
    realtimeToolCall: ToolCall,
    onTraceEvent: ((event: { type: string; data: Record<string, unknown> }) => void) | undefined,
    reasoningToolDispatcher: RealtimeReasoningToolDispatcher,
  ) {
    const originalActiveThreadIndex = session.activeThreadIndex;
    const originalAgentName = session.agentName;
    const originalAgentIR = session.agentIR;
    const declaringThread = session.threads[declaringThreadIndex];

    log.info('Executing Google realtime stale tool via declaring ancestor thread', {
      sessionId: session.id,
      toolName: realtimeToolCall.name,
      activeAgent: originalAgentName,
      declaringAgent: declaringThread?.agentName,
      declaringThreadIndex,
      activeThreadIndex: originalActiveThreadIndex,
    });

    try {
      session.activeThreadIndex = declaringThreadIndex;
      syncThreadToSession(session);
      this.llmWiring.wireToolExecutor(
        session,
        session.compilationOutput,
        session.authToken,
        session.tenantId,
        session.projectId,
      );

      return await reasoningToolDispatcher.executeToolCall(
        session,
        realtimeToolCall,
        undefined,
        onTraceEvent,
        realtimeToolCall.id,
      );
    } finally {
      session.activeThreadIndex = originalActiveThreadIndex;
      syncThreadToSession(session);
      session.agentName = originalAgentName;
      session.agentIR = originalAgentIR;
      this.llmWiring.wireToolExecutor(
        session,
        session.compilationOutput,
        session.authToken,
        session.tenantId,
        session.projectId,
      );
    }
  }

  // executeFlowStep, executeFlowCall, detectIntent, detectCorrection,
  // checkGatherComplete, buildGatherPrompt, extractEntitiesWithLLM,
  // validateField, evaluateOnInput
  // — extracted to execution/flow-step-executor.ts

  // executeWithTools, executeToolCall
  // — extracted to execution/reasoning-executor.ts

  // handleHandoff, handleDelegate, handleFanOut, handleComplete, handleEscalate,
  // checkCompletionConditions, checkAndMarkComplete, checkHandoffConditions,
  // executeComplete, executeDelegate, formatFanOutToolResult
  // — extracted to execution/routing-executor.ts

  /**
   * Reset a session
   */
  resetSession(sessionId: string): RuntimeSession | undefined {
    const session = this.sessions.get(sessionId);
    if (session) {
      const now = new Date();
      const resetFlowStep = session.agentIR?.flow
        ? session.agentIR.flow.entry_point || session.agentIR.flow.steps?.[0]
        : undefined;

      session.state = {
        gatherProgress: {},
        conversationPhase: 'start',
        context: {},
      };
      session.data = {
        values: session.channelType ? { session: { channel: session.channelType } } : {},
        gatheredKeys: new Set(),
      };
      session.conversationHistory = [];
      session.isComplete = false;
      session.isEscalated = false;
      session.transferInitiated = false;
      session.escalationReason = undefined;
      session.handoffStack = [session.agentName];
      session.delegateStack = [];
      session.executionTreeValues = {};
      session.currentFlowStep = resetFlowStep;
      session.waitingForInput = undefined;
      session.pendingResponse = undefined;
      session.pendingRichContent = undefined;
      session.pendingContentBlocks = undefined;
      session.initialized = false;
      session.createdAt = now;
      // Reset threads — clear all and recreate initial thread
      session.threads = [];
      session.activeThreadIndex = 0;
      session.threadStack = [];
      createInitialThread(session);
      session.lastActivityAt = now;
    }
    return session;
  }

  /**
   * End a session
   */
  endSession(sessionId: string, options?: { preserveColdState?: boolean }): void {
    const session = this.sessions.get(sessionId);
    const tenantId = session?.tenantId;
    const preserveColdState = options?.preserveColdState ?? false;

    // Execute HOOKS: after_agent lifecycle hook (fire-and-forget since endSession is sync)
    if (session?.agentIR?.hooks) {
      import('./execution/hook-executor.js')
        .then(({ executeHook }) => executeHook('after_agent', session.agentIR!.hooks, session))
        .catch((err: unknown) =>
          log.warn('after_agent hook failed during session end', {
            sessionId,
            error: err instanceof Error ? err.message : String(err),
          }),
        );
    }

    // Shared in-memory cleanup: registry, sessions map, voice executors,
    // cooldowns, tracer, debounce timer, memory bridge.
    this.clearInMemorySessionArtifacts(sessionId);

    // Remove from SessionService (Redis).
    // When preserveColdState=true (user started a new chat), only evict from
    // the hot tier so the session remains resumable from the sidebar.
    this.getSessionServiceAsync()
      .then((svc) => {
        const locator = buildSessionLocator(session);
        if (preserveColdState) {
          return svc.evictSessionHotOnly(sessionId, locator ?? undefined);
        }
        if (locator) {
          return svc.deleteSessionScoped(locator);
        }
        return svc.deleteSession(sessionId);
      })
      .catch((err: unknown) =>
        log.warn('Session service delete failed', {
          error: err instanceof Error ? err.stack : String(err),
        }),
      );

    // Clean up paused JIT auth executions
    import('./auth-profile/paused-execution-store.js')
      .then(({ getPausedExecutionStore }) =>
        getPausedExecutionStore().cleanupSession(sessionId, 'disconnect'),
      )
      .catch((err: unknown) =>
        log.warn('Paused execution cleanup failed during session end', {
          sessionId,
          error: err instanceof Error ? err.message : String(err),
        }),
      );

    // Release session slot for quota tracking (fire-and-forget)
    if (tenantId) {
      import('../middleware/rate-limiter.js')
        .then(({ releaseSessionSlot: release }) => release(tenantId, sessionId))
        .catch((err) =>
          log.warn('Session count decrement failed', {
            error: err instanceof Error ? err.message : String(err),
          }),
        );
    }
  }

  /**
   * Detach a session from this pod's active WS connection WITHOUT deleting it.
   * The session stays in the in-memory map so it can be listed and inspected
   * via the Sessions API. Only truly removed by explicit endSession() or TTL expiry.
   */
  detachSession(_sessionId: string): void {
    // Keep session in the in-memory map — the sessions API needs to list it.
    // Only clear debounce timer; the session data itself is preserved.
    const timer = this.persistDebounceTimers.get(_sessionId);
    if (timer) {
      clearTimeout(timer);
      this.persistDebounceTimers.delete(_sessionId);
    }
    // Intentionally NOT calling svc.deleteSession or sessions.delete
  }

  /**
   * Persist current in-memory session state to SessionService for cluster readiness.
   * Uses saveSessionAndConversation() for optimistic concurrency updates in a single
   * Redis pipeline (save hash + replace conversation list = 1 round-trip instead of 3).
   * Falls back to persistSessionToService() if session not yet in store.
   */
  async saveSessionSnapshot(session: RuntimeSession): Promise<void> {
    if (session._ephemeralExecution) {
      return;
    }

    // Yield to the event loop before starting CPU-intensive serialization.
    // When multiple LLM callbacks complete in the same tick (15-19 under load),
    // this spreads persist work across CFS windows, preventing burst throttling.
    await new Promise<void>((resolve) => setImmediate(resolve));

    try {
      const svc = await this.getSessionServiceAsync();
      const locator = buildSessionLocator(session);

      // Lightweight existence check: getVersion() does HGET on a single field
      // instead of HGETALL + LRANGE that load() performs.
      const storeVersion = locator
        ? await svc.getVersionScoped(locator)
        : await svc.getVersion(session.id, session.tenantId);
      if (storeVersion === null) {
        // Session not yet in store — do initial persist
        await this.persistSessionToService(session);
        return;
      }

      // Build SessionData from in-memory RuntimeSession — avoids full load() round-trip.
      // Use cached hashes when available (computed once at session creation or rehydration).
      // Only recompute if the cache is missing (should not happen in normal flow).
      let irSourceHash: string;
      if (session._cachedIRHash !== undefined) {
        irSourceHash = session._cachedIRHash;
      } else if (session.agentIR) {
        irSourceHash = svc.computeIRHash(session.agentIR);
        session._cachedIRHash = irSourceHash;
      } else {
        irSourceHash = '';
      }

      let compilationHash: string | null;
      if (session._cachedCompilationHash !== undefined) {
        compilationHash = session._cachedCompilationHash;
      } else if (session.compilationOutput) {
        compilationHash = svc.computeCompilationHash(session.compilationOutput);
        session._cachedCompilationHash = compilationHash;
      } else {
        compilationHash = null;
      }

      // Strip transient env namespace — decrypted values must not persist to store
      const { env: _envVars, ...dataValuesForPersistence } = session.data.values;

      const sessionData: import('./session/types.js').SessionData = {
        id: session.id,
        agentName: session.agentName,
        irSourceHash,
        compilationHash,
        conversationHistory: session.conversationHistory,
        state: {
          gatherProgress: session.state.gatherProgress,
          conversationPhase: session.state.conversationPhase,
          context: session.state.context,
          activeAgent: session.state.activeAgent,
        },
        version: session.storeVersion,
        isComplete: session.isComplete,
        isEscalated: session.isEscalated,
        transferInitiated: session.transferInitiated,
        escalationReason: session.escalationReason,
        recentTransferEndedAt: session.recentTransferEndedAt,
        handoffStack: session.handoffStack,
        delegateStack: session.delegateStack,
        handoffReturnInfo: session.handoffReturnInfo,
        dataValues: dataValuesForPersistence,
        dataGatheredKeys: Array.from(session.data.gatheredKeys),
        executionTreeValues: session.executionTreeValues,
        currentFlowStep: session.currentFlowStep,
        waitingForInput: session.waitingForInput,
        pendingResponse: session.pendingResponse,
        pendingRichContent: session.pendingRichContent,
        pendingVoiceConfig: session.pendingVoiceConfig,
        pendingActions: session.pendingActions,
        initialized: session.initialized,
        createdAt:
          session.createdAt instanceof Date ? session.createdAt.getTime() : session.createdAt,
        lastActivityAt:
          session.lastActivityAt instanceof Date
            ? session.lastActivityAt.getTime()
            : (session.lastActivityAt ?? Date.now()),
        // Auth/identity context
        tenantId: session.tenantId,
        projectId: session.projectId,
        authToken: session.authToken,
        userId: session.userId,
        permissions: session.permissions,
        callerContext: session.callerContext,
        executionScopeKind: session.executionScopeKind,
        // Dynamic TTL
        maxAgeSeconds: session.maxAgeSeconds,
        idleSeconds: session.idleSeconds,
        // Custom dimensions (Map → Record for Redis serialization)
        customDimensions:
          session.customDimensions && session.customDimensions.size > 0
            ? Object.fromEntries(session.customDimensions)
            : undefined,
        // Deployment context
        deploymentId: session.versionInfo?.deploymentId,
        environment: session.versionInfo?.environment,
        agentVersions: session.versionInfo?.versions,
        agentRawVersions: session.versionInfo?.rawVersions,
        // Thread model
        threads: session.threads.length > 0 ? this.serializeThreads(session, svc) : [],
        activeThreadIndex: session.activeThreadIndex,
        threadStack: session.threadStack,
        // PII vault
        piiVaultData:
          session.piiVault && session.piiVault.getTokenCount() > 0
            ? session.piiVault.serialize()
            : undefined,
        piiRedactionConfig: session.piiRedactionConfig,
        // Module provenance for cross-pod trace enrichment
        ...(session.moduleProvenance && { moduleProvenance: session.moduleProvenance }),
        // Backtrack and constraint-collect state
        backtrackCounts: session.backtrackCounts,
        constraintCollectState: session.constraintCollectState,
      };

      // Single batched operation: save session hash + replace conversation list
      // When backed by Redis, this uses a pipeline (Lua save + DEL/RPUSH) instead of
      // 3 sequential round-trips (load + save + replaceConversation).
      const saved = await svc.saveSessionAndConversation(sessionData, session.conversationHistory);
      if (saved) {
        // saveSessionAndConversation increments version internally
        session.storeVersion = sessionData.version + 1;
      } else {
        log.warn('Session save version conflict', { sessionId: session.id });
      }
    } catch (err) {
      log.error('saveSessionSnapshot error', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // ---------------------------------------------------------------------------
  // ExecutorContext lifecycle methods — used by RoutingExecutor for fan-out
  // ---------------------------------------------------------------------------

  /** Mark a session as actively executing (prevents reaper eviction) */
  markExecuting(sessionId: string): void {
    this._executingSessions.add(sessionId);
  }

  /** Unmark a session from the executing set */
  unmarkExecuting(sessionId: string): void {
    this._executingSessions.delete(sessionId);
  }

  /** Cancel any pending debounced persist for a session */
  cancelPendingPersist(sessionId: string): void {
    const timer = this.persistDebounceTimers.get(sessionId);
    if (timer) {
      clearTimeout(timer);
      this.persistDebounceTimers.delete(sessionId);
    }
  }

  /**
   * Schedule a debounced persist for a session. Prevents Redis hammering during
   * rapid multi-turn conversations while ensuring state eventually persists.
   */
  private debouncedPersist(session: RuntimeSession, delayMs = 300): void {
    if (session._ephemeralExecution) {
      return;
    }

    // Sync request/response channels must persist immediately so the next request
    // or admin read on any pod sees the latest state without waiting on debounce.
    if (shouldPersistImmediately(session.channelType)) {
      this.saveSessionSnapshot(session).catch((err) => {
        log.error('Immediate persist error', {
          sessionId: session.id,
          error: err instanceof Error ? err.message : String(err),
        });
      });
      return;
    }

    // WebSocket/voice: keep debounced (sticky connection, same pod)
    const existing = this.persistDebounceTimers.get(session.id);
    if (existing) clearTimeout(existing);

    const timer = setTimeout(() => {
      this.persistDebounceTimers.delete(session.id);
      this.saveSessionSnapshot(session).catch((err) => {
        log.error('Debounced persist error', {
          error: err instanceof Error ? err.message : String(err),
        });
      });
    }, delayMs);

    this.persistDebounceTimers.set(session.id, timer);
  }

  /**
   * Add a message to a session's conversation history.
   * Used by the WS handler to store ON_START, fallback, and flow init messages
   * without reaching into RuntimeSession internals.
   */
  addMessage(
    sessionId: string,
    role: string,
    content: string,
    metadata?: Record<string, unknown>,
    contentEnvelope?: import('./session/persisted-message-content.js').PersistedStructuredMessageEnvelopeV2,
  ): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    const thread = getActiveThread(session);
    if (thread) {
      // Push to thread only — when aliased (createInitialThread), this also
      // mutates session.conversationHistory. When not aliased (createThread),
      // syncThreadToSession() handles sync at handoff boundaries.
      thread.conversationHistory.push({
        role,
        content,
        ...(metadata ? { metadata } : {}),
        ...(contentEnvelope ? { contentEnvelope } : {}),
      });
    } else {
      session.conversationHistory.push({
        role,
        content,
        ...(metadata ? { metadata } : {}),
        ...(contentEnvelope ? { contentEnvelope } : {}),
      });
    }
    session.lastActivityAt = new Date();
  }

  /**
   * List all active sessions with summary info
   */
  listSessions(): Array<{
    id: string;
    agentName: string;
    messageCount: number;
    createdAt: string;
    lastActivityAt: string;
    activeAgent: string;
    threadCount: number;
  }> {
    const results: Array<{
      id: string;
      agentName: string;
      messageCount: number;
      createdAt: string;
      lastActivityAt: string;
      activeAgent: string;
      threadCount: number;
    }> = [];

    for (const session of this.sessions.values()) {
      // Count total messages across all threads for accurate message count
      let totalMessages = 0;
      for (const thread of session.threads) {
        totalMessages += thread.conversationHistory.length;
      }
      const activeThread = session.threads[session.activeThreadIndex];
      // Use the entry agent name (threads[0]) for display, not the mutated session.agentName
      const entryAgentName = session.threads[0]?.agentName ?? session.agentName;
      results.push({
        id: session.id,
        agentName: entryAgentName,
        messageCount: totalMessages,
        createdAt: session.createdAt.toISOString(),
        lastActivityAt: session.lastActivityAt.toISOString(),
        activeAgent: activeThread?.agentName ?? session.agentName,
        threadCount: session.threads.length,
      });
    }

    return results;
  }

  /**
   * Get full session detail including messages and trace events
   */
  getSessionDetail(sessionId: string): {
    id: string;
    agentName: string;
    state: RuntimeState;
    messages: Array<{
      id: string;
      role: string;
      content: string;
      rawContent?: import('@abl/compiler/platform/llm/types.js').ContentBlock[];
      contentEnvelope?: import('./session/persisted-message-content.js').PersistedStructuredMessageEnvelopeV2;
      metadata?: Record<string, unknown>;
      timestamp: string;
    }>;
    traceEvents: unknown[];
    threads: Array<{
      agentName: string;
      status: string;
      startedAt: number;
      endedAt?: number;
      messageCount: number;
      handoffFrom?: string;
    }>;
    activeThreadIndex: number;
    createdAt: string;
    lastActivityAt: string;
  } | null {
    const session = this.sessions.get(sessionId);
    if (!session) return null;

    // Get trace events from trace store
    let traceEvents: unknown[] = [];
    try {
      const store = getTraceStore();
      const events = store.getEvents(sessionId);
      // getEvents may return a Promise (Redis) or array (Memory)
      if (Array.isArray(events)) {
        traceEvents = events;
      }
    } catch {
      // Trace store not available
    }

    // Build messages with ids and timestamps from conversation history.
    // Use trace events to estimate timestamps: user messages align with
    // agent_enter events, assistant messages align with agent_exit/llm_call events.
    const traceTimestamps: Date[] = (traceEvents as Array<{ timestamp?: string | Date }>)
      .map((e) => (e.timestamp ? new Date(e.timestamp) : null))
      .filter((d): d is Date => d !== null);

    const allMessages: Array<{
      id: string;
      role: string;
      content: string;
      rawContent?: import('@abl/compiler/platform/llm/types.js').ContentBlock[];
      contentEnvelope?: import('./session/persisted-message-content.js').PersistedStructuredMessageEnvelopeV2;
      metadata?: Record<string, unknown>;
      timestamp: string;
    }> = [];
    const sessionStart = session.createdAt.getTime();
    let msgIndex = 0;
    let userMsgCount = 0;
    let assistantMsgCount = 0;

    // Collect messages from the active conversation (prefer session-level which merges all threads)
    const rawMessages =
      session.conversationHistory.length > 0
        ? session.conversationHistory
        : session.threads.flatMap((t) => t.conversationHistory);

    // Filter out empty/internal messages (flow engine produces empty user messages for step transitions)
    // Also deduplicate consecutive same-role messages with identical content
    const filteredMessages: typeof rawMessages = [];
    for (const msg of rawMessages) {
      const textContent = contentToString(msg.content || '');
      const hasStructuredPayload = Array.isArray(msg.content) || Boolean(msg.contentEnvelope);
      if (textContent.trim().length === 0 && !hasStructuredPayload) continue;
      const prev = filteredMessages[filteredMessages.length - 1];
      if (
        prev &&
        prev.role === msg.role &&
        prev.content === msg.content &&
        JSON.stringify(prev.contentEnvelope ?? null) ===
          JSON.stringify(msg.contentEnvelope ?? null) &&
        JSON.stringify(prev.metadata ?? null) === JSON.stringify(msg.metadata ?? null)
      ) {
        continue;
      }
      filteredMessages.push(msg);
    }

    for (const msg of filteredMessages) {
      // Estimate timestamp: spread messages evenly across the trace timeline
      let estimatedTime: Date;
      if (traceTimestamps.length >= 2) {
        const traceStart = traceTimestamps[0].getTime();
        const traceEnd = traceTimestamps[traceTimestamps.length - 1].getTime();
        const progress = filteredMessages.length > 1 ? msgIndex / (filteredMessages.length - 1) : 0;
        estimatedTime = new Date(traceStart + (traceEnd - traceStart) * progress);
      } else {
        estimatedTime = new Date(sessionStart + msgIndex * 1000);
      }

      allMessages.push({
        id: `msg-${sessionId.slice(0, 8)}-${msgIndex}`,
        role: msg.role,
        content: contentToString(msg.content),
        ...(Array.isArray(msg.content) ? { rawContent: msg.content } : {}),
        ...(msg.contentEnvelope ? { contentEnvelope: msg.contentEnvelope } : {}),
        ...(msg.metadata ? { metadata: msg.metadata } : {}),
        timestamp: estimatedTime.toISOString(),
      });
      if (msg.role === 'user') userMsgCount++;
      if (msg.role === 'assistant') assistantMsgCount++;
      msgIndex++;
    }

    // Use entry agent name for display (threads[0]) instead of mutated session.agentName
    const entryAgentName = session.threads[0]?.agentName ?? session.agentName;

    return {
      id: session.id,
      agentName: entryAgentName,
      state: session.state,
      messages: allMessages,
      traceEvents,
      threads: session.threads.map((t) => ({
        agentName: t.agentName,
        status: t.status,
        startedAt: t.startedAt,
        endedAt: t.endedAt,
        messageCount: t.conversationHistory.length,
        handoffFrom: t.handoffFrom,
      })),
      activeThreadIndex: session.activeThreadIndex,
      createdAt: session.createdAt.toISOString(),
      lastActivityAt: session.lastActivityAt.toISOString(),
    };
  }

  // ===========================================================================
  // SESSION SERVICE BRIDGE (Sprint 1)
  // ===========================================================================

  /**
   * Serialize runtime threads to AgentThreadData[] for persistence.
   */
  private serializeThreads(
    session: RuntimeSession,
    svc: import('./session/session-service.js').SessionService,
  ): import('./session/types.js').AgentThreadData[] {
    return session.threads.map((thread, index) => {
      const isActiveThread = index === session.activeThreadIndex;
      const threadAgentName = isActiveThread ? session.agentName : thread.agentName;
      const threadAgentIR = isActiveThread ? session.agentIR : thread.agentIR;
      const threadConversationHistory = isActiveThread
        ? session.conversationHistory
        : thread.conversationHistory;
      const threadState = isActiveThread ? session.state : thread.state;
      const threadData = isActiveThread ? session.data : thread.data;
      const threadCurrentFlowStep = isActiveThread
        ? session.currentFlowStep
        : thread.currentFlowStep;
      const threadWaitingForInput = isActiveThread
        ? session.waitingForInput
        : thread.waitingForInput;
      const threadPendingResponse = isActiveThread
        ? session.pendingResponse
        : thread.pendingResponse;
      const threadPendingRichContent = isActiveThread
        ? session.pendingRichContent
        : thread.pendingRichContent;
      const threadPendingVoiceConfig = isActiveThread
        ? session.pendingVoiceConfig
        : thread.pendingVoiceConfig;
      const threadPendingActions = isActiveThread ? session.pendingActions : thread.pendingActions;
      const threadStatus = isActiveThread
        ? session.isEscalated
          ? 'escalated'
          : session.isComplete
            ? 'completed'
            : thread.status
        : thread.status;

      // Use cached hash when available; only recompute if missing
      let irHash: string;
      if (thread._cachedIRHash !== undefined) {
        irHash = thread._cachedIRHash;
      } else if (threadAgentIR) {
        irHash = svc.computeIRHash(threadAgentIR);
        thread._cachedIRHash = irHash;
      } else {
        irHash = '';
      }
      return {
        agentName: threadAgentName,
        irSourceHash: irHash,
        conversationHistory: threadConversationHistory,
        state: threadState,
        dataValues: threadData.values,
        dataGatheredKeys: Array.from(threadData.gatheredKeys),
        startedAt: thread.startedAt,
        endedAt: thread.endedAt,
        handoffFrom: thread.handoffFrom,
        handoffContext: thread.handoffContext,
        returnExpected: thread.returnExpected,
        currentFlowStep: threadCurrentFlowStep,
        waitingForInput: threadWaitingForInput,
        pendingResponse: threadPendingResponse,
        pendingRichContent: threadPendingRichContent,
        pendingVoiceConfig: threadPendingVoiceConfig,
        pendingActions: threadPendingActions,
        status: threadStatus,
      };
    });
  }

  /**
   * Persist a RuntimeSession to the SessionService for cluster-readiness.
   * This is a fire-and-forget operation — the in-memory session is the source
   * of truth during this pod's execution. The SessionService persistence
   * enables another pod to pick up the session after this pod releases it.
   */
  private async persistSessionToService(session: RuntimeSession, channel?: string): Promise<void> {
    if (session._ephemeralExecution) {
      return;
    }

    try {
      const svc = await this.getSessionServiceAsync();
      const locator = buildSessionLocator(session);
      const isFlowMode = session.currentFlowStep !== undefined;

      // Strip transient env namespace — decrypted values must not persist to store
      const { env: _envVars, ...initialContextForPersistence } = session.data.values;

      const hydratedSession = await svc.createSession({
        id: session.id,
        agentName: session.agentName,
        agentIR: session.agentIR,
        compilationOutput: session.compilationOutput,
        channel,
        handoffStack: session.handoffStack,
        initialContext: initialContextForPersistence,
        isFlowMode,
        entryPoint: session.currentFlowStep,
        tenantId: session.tenantId,
        projectId: session.projectId,
        authToken: session.authToken,
        userId: session.userId,
        permissions: session.permissions,
        deploymentId: session.versionInfo?.deploymentId,
        environment: session.versionInfo?.environment,
        agentVersions: session.versionInfo?.versions,
        agentRawVersions: session.versionInfo?.rawVersions,
        callerContext: session.callerContext,
        executionScopeKind: session.executionScopeKind,
        maxAgeSeconds: session.maxAgeSeconds,
        idleSeconds: session.idleSeconds,
      });

      // Track store version so stale checks don't trigger against our own writes
      session.storeVersion = hydratedSession.version;

      // Cache IR/compilation hashes — computed once at creation, reused on every subsequent persist
      session._cachedIRHash = hydratedSession.irSourceHash;
      session._cachedCompilationHash = hydratedSession.compilationHash;

      // Serialize thread data into the session for persistence
      if (session.threads.length > 0) {
        const threadData = this.serializeThreads(session, svc);
        // Save threads as part of session data update
        const sessionData = locator
          ? await svc.loadSessionScoped(locator)
          : await svc.loadSession(session.id);
        if (sessionData) {
          sessionData.threads = threadData;
          sessionData.activeThreadIndex = session.activeThreadIndex;
          sessionData.threadStack = session.threadStack;
          const saved = await svc.saveSession(sessionData);
          if (saved) {
            session.storeVersion = sessionData.version + 1;
          }
        }
      }

      // Persist only the session's own agent registry. Persisting the global
      // flat registry here would reintroduce cross-session bleed into the
      // compatibility lane used by rehydration.
      const registry: Record<string, string> = {};
      for (const [name, info] of Object.entries(session._sessionAgentRegistry ?? {})) {
        if (info.ir) {
          const hash = await svc.cacheAgentIR(info.ir);
          registry[name] = hash;
        }
      }
      if (Object.keys(registry).length > 0) {
        if (locator) {
          await svc.setAgentRegistryScoped(locator, registry);
        } else {
          await svc.setAgentRegistry(session.id, registry);
        }
      }
    } catch (err) {
      errorIfRuntimeStillAlive('SessionService persist error', {}, err);
    }
  }

  // ===========================================================================
  // ESCALATION RESOLUTION
  // ===========================================================================

  /**
   * Resolve an escalation on a session. Called when a human agent submits
   * a response via the unified inbox.
   *
   * Clears the escalation flag, pushes the human response into the
   * conversation history, and persists the session.
   */
  async resolveEscalation(
    sessionId: string,
    data: { respondedBy: string; message: string },
    options: { locator?: SessionLocator } = {},
  ): Promise<{ success: boolean }> {
    const sessionService = await this.getSessionServiceAsync();
    const session = options.locator
      ? await sessionService.loadSessionScoped(options.locator)
      : await sessionService.loadSession(sessionId);
    if (!session) {
      return { success: false };
    }

    session.isEscalated = false;
    session.escalationReason = undefined;

    const agentMessage = `[Human Agent ${data.respondedBy}]: ${data.message}`;
    session.conversationHistory.push({
      role: 'assistant',
      content: agentMessage,
    });

    await sessionService.saveSession(session);
    log.info('Escalation resolved', { sessionId, respondedBy: data.respondedBy });
    return { success: true };
  }
}

// =============================================================================
// SINGLETON INSTANCE
// =============================================================================

let runtimeExecutorInstance: RuntimeExecutor | null = null;

export function getRuntimeExecutor(): RuntimeExecutor {
  if (!runtimeExecutorInstance) {
    runtimeExecutorInstance = new RuntimeExecutor();
  }
  return runtimeExecutorInstance;
}

/** Returns the singleton RuntimeExecutor if already created, or null otherwise. */
export function getRuntimeExecutorIfInitialized(): RuntimeExecutor | null {
  return runtimeExecutorInstance;
}

export function createRuntimeExecutor(config?: RuntimeExecutorConfig): RuntimeExecutor {
  return new RuntimeExecutor(config);
}
