/**
 * Routing Executor
 *
 * Handles all agent-to-agent coordination: handoff, delegate, fan-out,
 * escalate, complete, and completion/handoff condition checking.
 *
 * Receives an ExecutorContext for recursive executeMessage calls,
 * breaking the circular dependency with the orchestrator.
 */

import {
  evaluateConditionDual as compilerEvaluateCondition,
  extractVariableReferences,
  interpolateMessage,
  DEFAULT_AUTO_HANDOFF_HISTORY_FALLBACK_LAST_N,
  DEFAULT_HANDOFF_HISTORY_STRATEGY,
  DEFAULT_MESSAGES,
  ESCALATION_FORMAT,
  ESCALATION_REASON_MIN_LENGTH,
  ESCALATION_REASON_MAX_LENGTH,
  CompletionDetector,
  HandoffExecutor,
  DelegateExecutor,
  parseTimeoutString,
} from '@abl/compiler';
import { assertUrlSafeForSSRF, getDevSSRFOptions } from '@agent-platform/shared-kernel/security';
import { formatErrorSync } from '@agent-platform/i18n';
import type {
  HandoffConfig,
  HandoffReturnHandler,
  HistoryStrategy,
  ActionSetIR,
  RichContentIR,
  VoiceConfigIR,
} from '@abl/compiler';
import type { CustomerExperienceMode } from '@abl/compiler/platform/ir/schema.js';
import { createLogger } from '@abl/compiler/platform';
import {
  resolveProjectAgentTransferConnectionRef,
  KoreAdapter,
} from '@agent-platform/agent-transfer';
import { isDatabaseReady } from '../../db/index.js';
import type { ChannelType } from '../../channels/types.js';
import {
  completeCustomerContinuityPhrase,
  normalizeCustomerContinuityText,
  resolveCustomerContinuityDelivery,
} from '../../channels/customer-continuity.js';
import { emitDecisionEvent, buildHttpTraceMeta } from './trace-helpers.js';
import { traceHandoffBlocked, tracePipelineError } from '../guardrails/trace-events.js';
import {
  isAgentTransferInitialized,
  getAdapterRegistry,
  getTransferSessionStore,
  getTransferTraceEmitter,
} from '../agent-transfer/index.js';
import {
  sendTask,
  sendTaskAsync,
  // sendTaskStreaming disabled: @a2a-js/sdk async generator hangs on cleanup.
  // The SDK's sendMessageStream() SSE generator does not handle .return()/.throw()
  // properly, causing the event loop to block after the stream is fully consumed.
  // Using synchronous sendTask with response forwarding as workaround.
  // Re-enable when @a2a-js/sdk releases a fix for SSE generator teardown.
  SyncResponseForAsyncRequest,
  SsrfEndpointValidator,
  createA2AClient,
  createA2AClientWithAuth,
  discoverAgent,
  cancelRemoteTask,
  AgentCardCache,
} from '@agent-platform/a2a';
import type {
  A2ATracingPort,
  Task,
  Message,
  AgentCard,
  OutboundAuthConfig,
} from '@agent-platform/a2a';
import { nullSafeEvaluateCondition } from '../pipeline/null-safe-eval.js';
import { lookupAgentForSession } from './agent-lookup.js';
import {
  InProcessExecutionRuntime,
  CountingSemaphore,
  createChildSessionForDelegate,
  createChildSessionForFanOut,
  createExecutionId,
} from '@agent-platform/execution';
import type { ExecutionPlan, ExecutionUnit, ExecutionUnitResult } from '@agent-platform/execution';
import {
  getActiveThread,
  createThread,
  syncThreadToSession,
  tryThreadReturn,
  buildHandoffExecutionResult,
  buildStateUpdates,
  getGatherProgress,
  mergeReturnedExecutionTreeGrantWrites,
} from './types.js';
import {
  interpolateTemplate,
  interpolateVoiceConfig,
  interpolateRichContent,
  interpolateActionSet,
  resolveValuePath,
} from './value-resolution.js';
import {
  buildLocalizedMessageResolver,
  resolveLocalizedAgentMessage,
  resolveLocalizedAgentMessageWithMetadata,
  resolveSessionLocalizedCatalogMessage,
} from './localized-messages.js';
import { isVoiceChannel } from './prompt-builder.js';
import { promptTemplateLoader } from './prompt-template-loader.js';
import { executeRecallForAgentEvent } from './memory-integration.js';
import {
  emitProtectedAssistantMessage,
  emitProtectedExecutionResult,
  protectSessionOutputForUser,
  protectStructuredOutputForUser,
} from './session-output-protection.js';
import {
  applyGrantedMemoryState,
  buildGrantedMemoryState,
  getExecutionTreeValue,
  refreshExecutionTreeProjection,
} from './memory-scope-runtime.js';
import {
  isSystemAgent,
  handleSystemAgentDelegate,
  validateSystemAgentRequiredPermissions,
  type SystemAgentHandlerDeps,
} from './system-agent-handler.js';
import type {
  RuntimeSession,
  ExecutionResult,
  SubTaskResult,
  FanOutResult,
  FanOutTask,
  HandoffExecutionResult,
  AgentRegistryEntry,
  AgentThread,
  DelegateConfigIR,
  ExecutorContext,
  ResponseMessageMetadata,
} from './types.js';
import { getToolPIIAccess, restorePIITokensForToolExecution } from './pii-tool-execution.js';
import type { MessageContent } from '../session/types.js';
import { createPersistedStructuredMessageEnvelope } from '../session/persisted-message-content.js';
import type { LLMWiringService } from './llm-wiring.js';
import type { LookupExternalAgent } from '@agent-platform/shared/repos';
import type { MultiIntentResult, IntentRelationship } from '@abl/compiler/platform/nlu/types.js';
import type { AgentIR } from '@abl/compiler/platform/ir/schema.js';
import {
  getHandoffReturnInfo,
  getReturnExpectedForTarget,
  getValidHandoffTargets,
  resolveActiveRoutingCapabilities,
} from './routing-capabilities.js';
import {
  activateAgentExecutionContext,
  agentNeedsLLMWiring,
  deriveActivationAuthContext,
  resolveTargetActivationAuthContext,
} from './agent-activation-context.js';
import { buildRuntimeTransferEnvelope } from '../agent-transfer/transfer-routing-context.js';
import {
  validateDelegateAuthRequirements,
  validateHandoffAuthRequirements,
} from './auth-profile-handoff.js';
import {
  buildParentResumeSuspensionContract,
  buildRemoteBranchSuspensionContract,
  createAsyncFanOutExecutionContext,
} from './fanout/async-fanout-coordinator.js';
import { storeFanOutResultOnThread } from './fanout/fanout-results.js';
import {
  fromLegacyMultiIntentResult,
  resolveAgentExecutionType,
  resolveMultiIntentConfig,
} from './multi-intent/multi-intent-types.js';
import type { MultiIntentDispatchResult } from './multi-intent/multi-intent-types.js';
import {
  applyResolvedMultiIntentPlan,
  resolveDetectedMultiIntentPlan,
} from './multi-intent/multi-intent-router.js';
export {
  MULTI_INTENT_PLATFORM_DEFAULTS,
  resolveAgentExecutionType,
  resolveMultiIntentConfig,
} from './multi-intent/multi-intent-types.js';
export type { MultiIntentDispatchResult } from './multi-intent/multi-intent-types.js';

const log = createLogger('routing-executor');

export type CurrentA2AHandoffMode = 'async-push' | 'streaming' | 'sync';

export interface CurrentA2AHandoffModeInput {
  dslAsync: boolean;
  asyncInfraAvailable: boolean;
  userConnected: boolean;
  remoteSupportsStreaming: boolean;
  remoteSupportsPushNotifications: boolean;
}

export interface CurrentA2AHandoffModeDecision {
  mode: CurrentA2AHandoffMode;
  reason: string;
}

export function resolveCurrentA2AHandoffMode(
  input: CurrentA2AHandoffModeInput,
): CurrentA2AHandoffModeDecision {
  if (input.dslAsync && input.asyncInfraAvailable) {
    return {
      mode: 'async-push',
      reason: 'ASYNC:true and async infrastructure are present',
    };
  }

  if (input.userConnected && input.remoteSupportsStreaming) {
    return {
      mode: 'streaming',
      reason: 'remote supports streaming and user is connected',
    };
  }

  return {
    mode: 'sync',
    reason: 'default sync fallback',
  };
}

type CoordinationVisibility = 'customer_visible' | 'internal';

function resolveCoordinationVisibility(
  experienceMode: CustomerExperienceMode,
): CoordinationVisibility {
  return experienceMode === 'silent_delegate' ? 'internal' : 'customer_visible';
}

function shouldSuppressChildOutput(visibility: CoordinationVisibility): boolean {
  return visibility === 'internal';
}

function resolveHandoffExperienceMode(
  handoffConfig: HandoffConfig | undefined,
): CustomerExperienceMode {
  return handoffConfig?.experienceMode ?? 'shared_voice_handoff';
}

function resolveDelegateExperienceMode(
  delegateConfig: DelegateConfigIR | undefined,
): CustomerExperienceMode {
  return delegateConfig?.experienceMode ?? 'silent_delegate';
}

function buildHandoffTransitionContinuity(experienceMode: CustomerExperienceMode): {
  kind: 'handoff_transition';
  visibility: CoordinationVisibility;
  message?: string;
} {
  if (experienceMode === 'visible_handoff' || experienceMode === 'human_escalation') {
    return {
      kind: 'handoff_transition',
      visibility: 'customer_visible',
      message: "I'm connecting you with the right specialist now.",
    };
  }

  return {
    kind: 'handoff_transition',
    visibility: 'internal',
  };
}

function emitStreamedHandoffTransition(params: {
  session: RuntimeSession;
  continuity: ReturnType<typeof buildHandoffTransitionContinuity>;
  onChunk?: (chunk: string) => void;
}): boolean {
  if (
    !params.onChunk ||
    !params.continuity.message ||
    params.continuity.visibility !== 'customer_visible' ||
    !params.session.channelType ||
    params.session.channelType === 'http_async' ||
    isVoiceChannel(params.session)
  ) {
    return false;
  }

  const delivery = resolveCustomerContinuityDelivery(params.session.channelType as ChannelType);
  if (delivery.mode !== 'stream_text') {
    return false;
  }

  const safeText = normalizeCustomerContinuityText(params.continuity.message);
  const protectedText = protectSessionOutputForUser(params.session, safeText);
  params.onChunk(protectedText.deliveryText);
  return true;
}

function emitCompleteRuntimeStatusChunk(params: {
  session: RuntimeSession;
  onChunk?: (chunk: string) => void;
  text?: string | null;
}): void {
  if (!params.onChunk || !params.text) {
    return;
  }

  const safeText = completeCustomerContinuityPhrase(params.text);
  const protectedText = protectSessionOutputForUser(params.session, safeText);
  params.onChunk(protectedText.deliveryText);
}

function buildDelegationTraceData(params: {
  sourceAgent: string;
  targetAgent?: string;
  invocationType: 'delegate' | 'fan_out';
  delegationId?: string;
  parentSessionId?: string;
  childSessionId?: string;
  parentThreadIndex?: number;
  childThreadIndex?: number;
  success?: boolean;
  error?: string;
  result?: unknown;
  message?: string;
  input?: Record<string, unknown>;
  purpose?: string;
  experienceMode?: CustomerExperienceMode;
  visibility?: CoordinationVisibility;
  suppressChildOutput?: boolean;
}): Record<string, unknown> {
  return {
    sourceAgent: params.sourceAgent,
    targetAgent: params.targetAgent,
    fromAgent: params.sourceAgent,
    toAgent: params.targetAgent,
    from: params.sourceAgent,
    to: params.targetAgent,
    agentName: params.sourceAgent,
    invocationType: params.invocationType,
    delegationId: params.delegationId,
    parentSessionId: params.parentSessionId,
    childSessionId: params.childSessionId,
    parentThreadIndex: params.parentThreadIndex,
    childThreadIndex: params.childThreadIndex,
    threadIndex: params.childThreadIndex,
    success: params.success,
    error: params.error,
    result: params.result,
    message: params.message,
    input: params.input,
    purpose: params.purpose,
    experienceMode: params.experienceMode,
    visibility: params.visibility,
    suppressChildOutput: params.suppressChildOutput,
  };
}

import {
  createGuardrailPipeline,
  createLLMEvalFromClient,
  ensureTenantProvidersLoaded,
} from '../guardrails/pipeline-factory.js';

import { getSessionGuardrailCacheScopeKey, getSessionPolicy } from './session-policy.js';

/**
 * Keys used for handoff tracking that should NOT propagate as session metadata.
 */
const HANDOFF_TRACKING_KEYS = new Set(['handoff_from']);

/**
 * Extract session-level metadata from parent thread values, excluding:
 * - Internal keys (prefixed with `_`)
 * - Handoff tracking keys (e.g. `handoff_from`)
 * - Gathered field keys (domain data collected from user input on the parent thread)
 * - Null, undefined, or empty string values
 */
export function extractSessionMetadata(
  parentValues: Record<string, unknown>,
  excludedFieldNames: Iterable<string>,
): Record<string, unknown> {
  const excludedSet = new Set(excludedFieldNames);
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(parentValues)) {
    if (key.startsWith('_')) continue;
    if (HANDOFF_TRACKING_KEYS.has(key)) continue;
    if (excludedSet.has(key)) continue;
    if (value === undefined || value === null || value === '') continue;
    result[key] = value;
  }
  return result;
}

type ResolvedHandoffMemoryGrant = {
  access: 'read' | 'readwrite';
  path: string;
  sourcePath: string;
  sourceScope?: 'user' | 'project' | 'execution_tree';
  value: unknown;
};

function resolveConfiguredMemoryGrants(
  handoffConfig: HandoffConfig | undefined,
): Array<{ path: string; access: 'read' | 'readwrite' }> {
  const context = handoffConfig?.context as
    | (HandoffConfig['context'] & {
        // Narrow compatibility shim for pre-retirement persisted IR payloads.
        grant_memory?: string[];
      })
    | undefined;

  if (context?.memory_grants?.length) {
    return context.memory_grants.map((grant) => ({
      path: grant.path,
      access: grant.access ?? 'read',
    }));
  }

  return (
    context?.grant_memory?.map((path) => ({
      path,
      access: 'read' as const,
    })) ?? []
  );
}

async function resolveHandoffMemoryGrants(params: {
  session: RuntimeSession;
  currentThread: AgentThread;
  currentIR: AgentIR | null | undefined;
  handoffConfig: HandoffConfig | undefined;
}): Promise<ResolvedHandoffMemoryGrant[]> {
  const configuredGrants = resolveConfiguredMemoryGrants(params.handoffConfig);
  if (configuredGrants.length === 0) {
    return [];
  }

  const declarations = new Map(
    (params.currentIR?.memory?.persistent ?? []).map((entry) => [entry.path, entry]),
  );
  const projectPaths = new Set<string>();
  const userPaths = new Set<string>();
  const resolved = configuredGrants.map((grant) => {
    const normalizedGrantPath = grant.path.startsWith('execution_tree.')
      ? grant.path.slice('execution_tree.'.length)
      : grant.path;
    const declaration = declarations.get(grant.path) ?? declarations.get(normalizedGrantPath);
    const sourcePath = declaration?.path ?? normalizedGrantPath;
    const sourceScope = (
      grant.path.startsWith('execution_tree.') ? 'execution_tree' : declaration?.scope
    ) as 'user' | 'project' | 'execution_tree' | undefined;

    if (sourceScope === 'project') {
      projectPaths.add(sourcePath);
    } else if (sourceScope !== 'execution_tree') {
      userPaths.add(sourcePath);
    }

    return {
      access: grant.access,
      path: grant.path,
      sourcePath,
      sourceScope,
      value: undefined,
    };
  });

  const [userValues, projectValues] = await Promise.all([
    userPaths.size > 0 && params.session.factStore
      ? params.session.factStore.getMany([...userPaths])
      : Promise.resolve(new Map()),
    projectPaths.size > 0 && params.session.projectFactStore
      ? params.session.projectFactStore.getMany([...projectPaths])
      : Promise.resolve(new Map()),
  ]);

  return resolved.map((grant) => {
    let value: unknown;

    if (grant.sourceScope === 'execution_tree') {
      value = getExecutionTreeValue(params.session, grant.sourcePath);
    }

    if (value === undefined) {
      value = params.currentThread.data.values[grant.sourcePath];
    }
    if (value === undefined && grant.path !== grant.sourcePath) {
      value = params.currentThread.data.values[grant.path];
    }

    if (value === undefined && grant.sourceScope === 'project') {
      value = projectValues.get(grant.sourcePath)?.value;
    } else if (value === undefined && grant.sourceScope !== 'execution_tree') {
      value = userValues.get(grant.sourcePath)?.value;
    }

    const declaration = declarations.get(grant.sourcePath);
    if (value === undefined && declaration?.default_value !== undefined) {
      value = declaration.default_value;
    }

    return {
      ...grant,
      value,
    };
  });
}

function applyGrantedMemoryValues(
  values: Record<string, unknown>,
  grants: ResolvedHandoffMemoryGrant[],
): void {
  applyGrantedMemoryState(
    {
      data: {
        values,
      } as RuntimeSession['data'],
    },
    buildGrantedMemoryState(grants),
  );
}

/** Extract plain text from message content (string or ContentBlock[]) */
function contentToString(content: MessageContent): string {
  if (typeof content === 'string') return content;
  return content
    .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
    .map((b) => b.text)
    .join('\n');
}

const BUILTIN_HANDOFF_ON_RETURN_ACTIONS = new Set(['continue', 'resume_intent']);

export interface ResolvedHandoffOnReturnBehavior {
  action: 'continue' | 'resume_intent';
  handlerName?: string;
  map?: Record<string, string>;
  respond?: string;
  clear?: string[];
}

function resolveNamedReturnHandler(
  parentIR: AgentIR | null | undefined,
  handoffConfig: HandoffConfig | undefined,
): { name?: string; handler?: HandoffReturnHandler } {
  const onReturn = handoffConfig?.on_return as HandoffConfig['on_return'] | string | undefined;
  if (!onReturn) {
    return {};
  }

  const handlerName =
    typeof onReturn === 'string'
      ? BUILTIN_HANDOFF_ON_RETURN_ACTIONS.has(onReturn)
        ? undefined
        : onReturn
      : onReturn.handler;

  if (!handlerName) {
    return {};
  }

  return {
    name: handlerName,
    handler: parentIR?.coordination?.return_handlers?.[handlerName],
  };
}

export function resolveHandoffOnReturnBehavior(
  parentIR: AgentIR | null | undefined,
  handoffConfig: HandoffConfig | undefined,
): ResolvedHandoffOnReturnBehavior | null {
  const onReturn = handoffConfig?.on_return as HandoffConfig['on_return'] | string | undefined;
  if (!onReturn) {
    return null;
  }

  const { name: handlerName, handler } = resolveNamedReturnHandler(parentIR, handoffConfig);
  const actionCandidate =
    typeof onReturn === 'string'
      ? BUILTIN_HANDOFF_ON_RETURN_ACTIONS.has(onReturn)
        ? onReturn
        : undefined
      : onReturn.action;

  const action =
    actionCandidate === 'resume_intent' || (!actionCandidate && handler?.resume_intent === true)
      ? 'resume_intent'
      : 'continue';

  return {
    action,
    handlerName,
    map: typeof onReturn === 'object' && onReturn !== null ? onReturn.map : undefined,
    respond: handler?.respond,
    clear: handler?.clear,
  };
}

export function combineVisibleResponses(
  primaryResponse: string | undefined,
  followUpResponse: string | undefined,
): string | undefined {
  if (primaryResponse && followUpResponse) {
    return `${primaryResponse}\n${followUpResponse}`;
  }

  return followUpResponse ?? primaryResponse;
}

export function applyHandoffOnReturnEffects(
  session: RuntimeSession,
  parentThread: AgentThread,
  returnedFromAgent: string,
  behavior: ResolvedHandoffOnReturnBehavior | null,
  options?: {
    mergeWithLastAssistant?: boolean;
    onChunk?: (chunk: string) => void;
    onTraceEvent?: (event: { type: string; data: Record<string, unknown> }) => void;
    decisionId?: string;
    parentThreadIndex?: number;
    childThreadIndex?: number;
  },
): { emittedResponse?: string } {
  if (!behavior) {
    return {};
  }

  const clearedFields: string[] = [];
  for (const field of behavior.clear ?? []) {
    if (!field) {
      continue;
    }
    delete parentThread.data.values[field];
    parentThread.data.gatheredKeys.delete(field);
    if (session.data !== parentThread.data) {
      delete session.data.values[field];
      session.data.gatheredKeys.delete(field);
    }
    clearedFields.push(field);
  }

  const emittedResponseTemplate = behavior.respond?.trim();
  const emittedResponse = emittedResponseTemplate
    ? interpolateTemplate(
        emittedResponseTemplate,
        parentThread.data.values as Record<string, unknown>,
      )
    : undefined;

  const protectedEmittedResponse = emittedResponse
    ? protectSessionOutputForUser(session, emittedResponse)
    : undefined;

  if (protectedEmittedResponse) {
    const lastEntry = parentThread.conversationHistory.at(-1);
    if (
      options?.mergeWithLastAssistant &&
      lastEntry?.role === 'assistant' &&
      typeof lastEntry.content === 'string'
    ) {
      lastEntry.content = `${lastEntry.content}\n${protectedEmittedResponse.historyText}`;
    } else {
      parentThread.conversationHistory.push({
        role: 'assistant',
        content: protectedEmittedResponse.historyText,
      });
    }

    options?.onChunk?.(protectedEmittedResponse.deliveryText);
  }

  if (clearedFields.length > 0 || emittedResponse || behavior.handlerName) {
    options?.onTraceEvent?.({
      type: 'handoff_return_handler',
      data: {
        from: returnedFromAgent,
        sourceAgent: returnedFromAgent,
        parentAgent: parentThread.agentName,
        targetAgent: parentThread.agentName,
        handler: behavior.handlerName ?? null,
        action: behavior.action,
        handoffReturnBehavior: behavior.action,
        reasonCode: `handoff_return_${behavior.action}`,
        ...(options.decisionId ? { decisionId: options.decisionId } : {}),
        ...(options.parentThreadIndex !== undefined
          ? { parentThreadIndex: options.parentThreadIndex }
          : {}),
        ...(options.childThreadIndex !== undefined
          ? { childThreadIndex: options.childThreadIndex }
          : {}),
        clearedFields,
        emittedResponse: protectedEmittedResponse?.deliveryText ?? null,
      },
    });
  }

  return { emittedResponse: protectedEmittedResponse?.deliveryText };
}

function isGrokRealtimeVoiceSession(session: RuntimeSession): boolean {
  if (!isVoiceChannel(session)) {
    return false;
  }

  const sessionNamespace = session.data?.values?.session;
  if (!sessionNamespace || typeof sessionNamespace !== 'object') {
    return false;
  }

  return (sessionNamespace as Record<string, unknown>).s2sProvider === 's2s:grok';
}

function isGoogleRealtimeVoiceSession(session: RuntimeSession): boolean {
  if (!isVoiceChannel(session)) {
    return false;
  }

  const sessionNamespace = session.data?.values?.session;
  if (!sessionNamespace || typeof sessionNamespace !== 'object') {
    return false;
  }

  return (sessionNamespace as Record<string, unknown>).s2sProvider === 's2s:google';
}

function isOpenAIRealtimeVoiceSession(session: RuntimeSession): boolean {
  if (!isVoiceChannel(session)) {
    return false;
  }

  const sessionNamespace = session.data?.values?.session;
  if (!sessionNamespace || typeof sessionNamespace !== 'object') {
    return false;
  }

  return (sessionNamespace as Record<string, unknown>).s2sProvider === 's2s:openai';
}

function primeFanOutChildThreadForImmediateInput(
  thread: AgentThread,
  agentIR: AgentIR | null,
): void {
  if (!agentIR?.flow || thread.waitingForInput?.length) {
    return;
  }

  const entryPoint = agentIR.flow.entry_point;
  if (!entryPoint) {
    return;
  }

  const gatherFields = agentIR.flow.definitions?.[entryPoint]?.gather?.fields
    ?.map((field) => field.name)
    .filter((name): name is string => typeof name === 'string' && name.length > 0);

  if (gatherFields && gatherFields.length > 0) {
    thread.waitingForInput = gatherFields;
  }
}

/** Maximum delegate nesting depth to prevent runaway recursion */
const MAX_DELEGATE_DEPTH = 10;

/** Maximum resume_intent continuation depth to prevent infinite re-routing loops */
const MAX_RESUME_INTENT_DEPTH = 1;

const DEFAULT_ASYNC_FAN_OUT_TIMEOUT_SEC = 600;
const ASYNC_FAN_OUT_BARRIER_GRACE_MS = 60_000;

const VALID_ESCALATION_PRIORITIES = ['low', 'medium', 'high', 'critical'] as const;
const MIN_ESCALATION_REASON_LENGTH = ESCALATION_REASON_MIN_LENGTH;
const MAX_ESCALATION_REASON_LENGTH = ESCALATION_REASON_MAX_LENGTH;

export async function dispatchHandoffOnReturnBehavior(
  session: RuntimeSession,
  returnedFromAgent: string,
  options: {
    baseResponse?: string;
    originalUserIntent?: string;
    onChunk?: (chunk: string) => void;
    onTraceEvent?: (event: { type: string; data: Record<string, unknown> }) => void;
    executeMessage: (
      sessionId: string,
      userMessage: string,
      onChunk?: (chunk: string) => void,
      onTraceEvent?: (event: { type: string; data: Record<string, unknown> }) => void,
      executeOptions?: import('./types.js').ExecuteMessageOptions,
    ) => Promise<ExecutionResult>;
    isResumeIntentReplay?: boolean;
    baseResponseDelivery?: 'already_visible' | 'include_in_result';
    resumeTraceSource?: string;
    decisionId?: string;
    parentThreadIndex?: number;
    childThreadIndex?: number;
  },
): Promise<{ response?: string; resumed: boolean }> {
  const parentThread = getActiveThread(session);
  const parentIR = parentThread?.agentIR ?? session.agentIR;
  const handoffConfig = parentIR?.coordination?.handoffs?.find(
    (handoff: HandoffConfig) => handoff.to === returnedFromAgent,
  );
  const behavior = resolveHandoffOnReturnBehavior(parentIR, handoffConfig);

  let followUpResponse: string | undefined;
  if (parentThread && behavior) {
    const effectResult = applyHandoffOnReturnEffects(
      session,
      parentThread,
      returnedFromAgent,
      behavior,
      {
        mergeWithLastAssistant: !!options.baseResponse,
        onChunk: options.onChunk,
        onTraceEvent: options.onTraceEvent,
        decisionId: options.decisionId,
        parentThreadIndex: options.parentThreadIndex,
        childThreadIndex: options.childThreadIndex,
      },
    );
    followUpResponse = effectResult.emittedResponse;
    session._returnHandlerHandledByRouting = { from: returnedFromAgent };
  }

  if (
    options.isResumeIntentReplay ||
    behavior?.action !== 'resume_intent' ||
    !options.originalUserIntent
  ) {
    return {
      response: combineVisibleResponses(options.baseResponse, followUpResponse),
      resumed: false,
    };
  }

  const currentResumeDepth = session._resumeIntentDepth ?? 0;
  if (currentResumeDepth >= MAX_RESUME_INTENT_DEPTH) {
    return {
      response: combineVisibleResponses(options.baseResponse, followUpResponse),
      resumed: false,
    };
  }

  if (options.onTraceEvent && parentThread?.currentFlowStep === undefined) {
    options.onTraceEvent({
      type: 'resume_intent',
      data: {
        from: returnedFromAgent,
        sourceAgent: returnedFromAgent,
        parentAgent: session.agentName,
        targetAgent: session.agentName,
        originalMessage: options.originalUserIntent,
        handoffReturnBehavior: behavior.action,
        reasonCode: 'handoff_return_resume_intent',
        resumeDepth: currentResumeDepth + 1,
        ...(options.decisionId ? { decisionId: options.decisionId } : {}),
        ...(options.parentThreadIndex !== undefined
          ? { parentThreadIndex: options.parentThreadIndex }
          : {}),
        ...(options.childThreadIndex !== undefined
          ? { childThreadIndex: options.childThreadIndex }
          : {}),
        ...(options.resumeTraceSource ? { source: options.resumeTraceSource } : {}),
      },
    });
  }

  const leadingResponse =
    options.baseResponseDelivery === 'include_in_result'
      ? combineVisibleResponses(options.baseResponse, followUpResponse)
      : followUpResponse;

  session._resumeIntentDepth = currentResumeDepth + 1;
  try {
    const continuationResult = await options.executeMessage(
      session.id,
      options.originalUserIntent,
      options.onChunk,
      options.onTraceEvent,
      {
        resumeIntentReplay: true,
        messageSource: 'resume',
        sourceAgent: returnedFromAgent,
      },
    );
    session._resumeIntentHandledByRouting = { from: returnedFromAgent };
    return {
      response: combineVisibleResponses(leadingResponse, continuationResult.response),
      resumed: true,
    };
  } finally {
    if ((session._resumeIntentDepth ?? 0) <= 1) {
      delete session._resumeIntentDepth;
    } else {
      session._resumeIntentDepth = (session._resumeIntentDepth ?? 1) - 1;
    }
  }
}

function shouldAllowPrivateRemoteEndpoints(): boolean {
  const ssrfOptions = getDevSSRFOptions();
  return ssrfOptions.allowLocalhost === true || ssrfOptions.allowPrivateRanges === true;
}

/** Sanitize a string for safe display in escalation messages — strips HTML tags and markdown */
function sanitizeForEscalation(value: string, maxLength = 200): string {
  return value
    .replace(/<[^>]*>/g, '')
    .replace(/[*_~`#\[\]]/g, '')
    .slice(0, maxLength);
}

/**
 * RoutingExecutor — handles all agent-to-agent coordination.
 *
 * Depends on ExecutorContext for:
 * - executeMessage() — recursive calls during handoff/delegate/fan-out
 * - agentRegistry — looking up target agents
 * - config — timeout defaults
 *
 * Depends on LLMWiringService for:
 * - wireLLMClient() — wiring LLM clients for target agents
 */
const DEFAULT_MAX_CONCURRENT_FAN_OUT_CALLS = 10;

/**
 * Enrich a context so that every dotted-path variable referenced in the
 * expression has a resolvable value — injecting `null` for missing nested
 * keys on existing objects, and creating stub objects for entirely absent
 * roots that are referenced via dotted paths.
 *
 * This prevents CEL "No such key" errors while preserving valid
 * null-testing semantics (IS NOT SET, == null, || short-circuit).
 *
 * Returns a shallow copy with cloned root objects where needed.
 * Does NOT mutate the original context.
 */
function enrichContextForNestedPaths(
  expression: string,
  context: Record<string, unknown>,
): Record<string, unknown> {
  const vars = extractVariableReferences(expression);
  const dottedVars = vars.filter((v) => v.includes('.'));
  if (dottedVars.length === 0) return context;

  const enriched = { ...context };
  const clonedRoots = new Set<string>();

  for (const v of dottedVars) {
    const parts = v.split('.');
    const root = parts[0];

    // Ensure root exists — create empty object if absent or null so CEL
    // can walk the path (injectMissingAsNull would set it to null which
    // causes "no such key" on the nested access).
    if (!(root in enriched) || enriched[root] == null) {
      enriched[root] = {};
      clonedRoots.add(root);
    } else if (!clonedRoots.has(root) && typeof enriched[root] === 'object') {
      enriched[root] = { ...(enriched[root] as Record<string, unknown>) };
      clonedRoots.add(root);
    }

    // Walk the path and inject null for missing intermediate/leaf keys
    let cur: unknown = enriched[root];
    for (let i = 1; i < parts.length; i++) {
      if (cur == null || typeof cur !== 'object') break;
      const obj = cur as Record<string, unknown>;
      if (i === parts.length - 1) {
        // Leaf — inject null if missing
        if (!(parts[i] in obj)) {
          obj[parts[i]] = null;
        }
      } else {
        // Intermediate — create empty object if missing
        if (!(parts[i] in obj)) {
          obj[parts[i]] = {};
        }
        cur = obj[parts[i]];
      }
    }
  }

  return enriched;
}

export class RoutingExecutor {
  private executionRuntime = new InProcessExecutionRuntime();
  private fanOutSemaphore: CountingSemaphore;
  /** (A4) Guard against concurrent fan-out calls from the same parent session */
  private _activeFanOutSessions = new Set<string>();
  /** Shadow-mode completion detector (compiler-layer) */
  private completionDetector = new CompletionDetector();
  /** Shadow-mode handoff executor (compiler-layer) */
  private handoffExecutor = new HandoffExecutor();
  /** Shadow-mode delegate executor (compiler-layer) */
  private delegateExecutor = new DelegateExecutor();
  /** Cached agent cards for capability inspection (5-min TTL, max 100 entries) */
  private readonly agentCardCache = new AgentCardCache();

  constructor(
    private ctx: ExecutorContext,
    private llmWiring: LLMWiringService,
    private lookupExternalAgent?: LookupExternalAgent,
  ) {
    // (R1) Read capacity from config, not hardcoded
    const capacity = ctx.config.maxConcurrentFanOutCalls ?? DEFAULT_MAX_CONCURRENT_FAN_OUT_CALLS;
    this.fanOutSemaphore = new CountingSemaphore(capacity);
  }

  /**
   * SSRF preflight for a remote handoff target resolved from HANDOFF config.
   * Remote agents are never stored in the registry — lookupAgentForSession
   * synthesizes them inline — so the URL-safety check must happen at the
   * dispatch site, not at register time.
   */
  private assertRemoteTargetSafe(entry: AgentRegistryEntry): void {
    if (entry.location !== 'remote' || !entry.remote?.endpoint) return;
    assertUrlSafeForSSRF(entry.remote.endpoint, getDevSSRFOptions());
  }

  /**
   * Enrich a remote AgentRegistryEntry with credentials from the external agent
   * registry (MongoDB). Only runs for remote entries that have no pre-existing
   * auth.value — inline HANDOFF-declared credentials take precedence.
   */
  private async enrichWithRegistryAuth(
    entry: AgentRegistryEntry,
    session: RuntimeSession,
    targetAgent: string,
  ): Promise<AgentRegistryEntry> {
    // Only enrich remote entries without an existing auth.value
    if (entry.location !== 'remote' || entry.remote?.auth?.value) {
      return entry;
    }
    if (!this.lookupExternalAgent) {
      return entry;
    }
    if (!session.tenantId || !session.projectId) {
      log.warn('Skipping external agent registry lookup — missing tenant or project context', {
        agentName: targetAgent,
        hasTenantId: !!session.tenantId,
        hasProjectId: !!session.projectId,
      });
      return entry;
    }

    const registryEntry = await this.lookupExternalAgent(
      session.tenantId,
      session.projectId,
      targetAgent,
    );

    if (!registryEntry) {
      // Registry miss — no external config for this agent name
      return entry;
    }

    // Build enriched entry
    let auth: { type: 'api_key' | 'bearer'; value: string; header?: string } | undefined;

    if (registryEntry.authType !== 'none' && registryEntry.encryptedAuthConfig) {
      let authPayload: { value: string; header?: string };
      try {
        authPayload = JSON.parse(registryEntry.encryptedAuthConfig) as {
          value: string;
          header?: string;
        };
      } catch (err) {
        log.error('Failed to parse decrypted external agent credentials', {
          agentName: targetAgent,
          error: err instanceof Error ? err.message : String(err),
        });
        throw new Error(
          `Remote handoff to "${targetAgent}" failed: credential configuration error`,
        );
      }

      if (registryEntry.authType === 'bearer' || registryEntry.authType === 'api_key') {
        auth = {
          type: registryEntry.authType,
          value: authPayload.value,
          header: authPayload.header,
        };
      }
    }
    // authType 'none' → auth remains undefined → createClientForAgent uses unauthenticated path

    return {
      ...entry,
      remote: {
        ...entry.remote!,
        endpoint: registryEntry.endpoint,
        protocol: registryEntry.protocol as 'a2a' | 'rest',
        auth,
      },
    };
  }

  // =============================================================================
  // HANDOFF
  // =============================================================================

  async handleHandoff(
    session: RuntimeSession,
    input: Record<string, unknown>,
    onChunk?: (chunk: string) => void,
    onTraceEvent?: (event: { type: string; data: Record<string, unknown> }) => void,
    options?: import('./types.js').ExecuteMessageOptions,
  ): Promise<HandoffExecutionResult> {
    const targetAgent = input.target as string;
    let context: Record<string, unknown> = {};
    if (input.context) {
      if (typeof input.context === 'string') {
        try {
          const parsed = JSON.parse(input.context);
          if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            context = parsed;
          }
        } catch {
          log.warn('Handoff context is not valid JSON, preserving as summary string');
          context = { _summary: String(input.context) };
        }
      } else if (typeof input.context === 'object' && !Array.isArray(input.context)) {
        context = input.context as Record<string, unknown>;
      }
    }

    const currentThread = getActiveThread(session);

    const currentIR = currentThread?.agentIR || session.agentIR;
    const routingCapabilities = resolveActiveRoutingCapabilities(currentIR ?? null);
    const validTargets = getValidHandoffTargets(routingCapabilities);
    const parentThreadIndexAtStart = session.activeThreadIndex;
    const handoffDecisionId =
      typeof input.decisionId === 'string' && input.decisionId.length > 0
        ? input.decisionId
        : createExecutionId();
    const returnExpected = getReturnExpectedForTarget(routingCapabilities, targetAgent);
    const handoffConfig = findHandoffConfig(session, targetAgent);
    const handoffExperienceMode = resolveHandoffExperienceMode(handoffConfig);
    const handoffVisibility = resolveCoordinationVisibility(handoffExperienceMode);
    const suppressChildOutput = shouldSuppressChildOutput(handoffVisibility);
    const handoffContinuity = buildHandoffTransitionContinuity(handoffExperienceMode);
    const onReturnBehavior = resolveHandoffOnReturnBehavior(currentIR ?? null, handoffConfig);

    // Skip routing trace events during resume_intent replay to prevent duplicate trace pollution
    if (!options?.resumeIntentReplay) {
      onTraceEvent?.({
        type: 'routing_capabilities_resolved',
        data: {
          agentName: currentThread?.agentName || session.agentName,
          sourceAgent: currentThread?.agentName || session.agentName,
          targetAgent,
          decisionId: handoffDecisionId,
          reasonCode: 'routing_capabilities_resolved',
          parentThreadIndex: parentThreadIndexAtStart,
          handoffTargets: validTargets,
          delegateTargets: Array.from(routingCapabilities.delegateTargets),
          source: 'handle_handoff',
        },
      });
    }

    if (validTargets.length === 0) {
      onTraceEvent?.({
        type: 'handoff_authority_denied',
        data: {
          agentName: currentThread?.agentName || session.agentName,
          targetAgent,
          reason: 'agent_not_configured_for_handoffs',
        },
      });
      return {
        success: false,
        error: `Agent "${currentThread?.agentName || session.agentName}" is not configured for handoffs. Only supervisors with routing rules or handoff configuration can hand off to other agents.`,
      };
    }

    // Prevent self-handoff
    if (currentThread.agentName === targetAgent) {
      return {
        success: false,
        error: `Cannot hand off to yourself (${targetAgent}). Either help the user directly or choose a different target.`,
      };
    }

    // Validate target is in the active IR-defined handoff targets
    if (!validTargets.includes(targetAgent)) {
      onTraceEvent?.({
        type: 'handoff_authority_denied',
        data: {
          agentName: currentThread.agentName,
          targetAgent,
          reason: 'target_not_in_active_ir',
          validTargets,
        },
      });
      return {
        success: false,
        error: `Invalid handoff target: "${targetAgent}". Valid targets are: ${validTargets.join(', ')}. Do NOT hand off to yourself.`,
      };
    }

    // Prevent recursion cycles (A → B → A)
    if (session.handoffStack.includes(targetAgent)) {
      return {
        success: false,
        error: `Handoff cycle detected: ${[...session.handoffStack, targetAgent].join(' → ')}. Agent "${targetAgent}" is already in the active handoff chain.`,
      };
    }

    // Look up target agent in registry. Remote agents declared in HANDOFF
    // config are synthesized inline by lookupAgentForSession — they never
    // land in the registry.
    const targetAgentInfo = lookupAgentForSession(this.ctx, session, targetAgent);

    // Enrich remote entries with credentials from the external agent registry
    let resolvedAgentInfo = targetAgentInfo;
    if (targetAgentInfo?.location === 'remote') {
      resolvedAgentInfo = await this.enrichWithRegistryAuth(targetAgentInfo, session, targetAgent);
    }

    // Validate handoff via HandoffExecutor
    {
      const handoffResult = this.handoffExecutor.validate(
        { agentName: currentThread.agentName },
        {
          handoffStack: session.handoffStack,
          handoffReturnInfo: getHandoffReturnInfo(routingCapabilities),
          agentIR: (currentIR ?? null) as AgentIR | null,
        },
        { target: targetAgent, context },
        !!resolvedAgentInfo,
      );
      if (!handoffResult.allowed) {
        if (!resolvedAgentInfo) {
          return handleHandoffFailure(
            session,
            handoffConfig,
            `Agent not found: ${targetAgent}`,
            'setup',
            onChunk,
            onTraceEvent,
          );
        }
        return {
          success: false,
          error: `Handoff to ${targetAgent} blocked by HandoffExecutor: ${handoffResult.reason}`,
        };
      }
    }

    if (onTraceEvent) {
      onTraceEvent({
        type: 'handoff',
        data: {
          from: currentThread.agentName,
          sourceAgent: currentThread.agentName,
          to: targetAgent,
          targetAgent,
          message: input.message,
          context,
          returnExpected,
          experienceMode: handoffExperienceMode,
          visibility: handoffVisibility,
          suppressChildOutput,
          continuity: handoffContinuity,
          handoffReturnBehavior: onReturnBehavior?.action,
          decisionId: handoffDecisionId,
          reasonCode: returnExpected ? 'handoff_return_expected' : 'handoff_permanent',
          threadIndex: session.activeThreadIndex,
          parentThreadIndex: parentThreadIndexAtStart,
          agentName: currentThread.agentName,
        },
      });
    }

    if (!resolvedAgentInfo) {
      return handleHandoffFailure(
        session,
        handoffConfig,
        `Agent not found: ${targetAgent}`,
        'setup',
        onChunk,
        onTraceEvent,
      );
    }
    // Remote targets get SSRF preflight at dispatch time.
    this.assertRemoteTargetSafe(resolvedAgentInfo);
    let mergedContext: Record<string, unknown> = { handoff_from: currentThread.agentName };

    // Propagate session-level metadata from parent to child (lowest priority).
    // This ensures conversationSummary, user, gender, location, etc. flow through
    // supervisor → specialist handoffs without requiring explicit PASS config.
    const sessionMetadata = extractSessionMetadata(
      currentThread.data.values,
      currentThread.data.gatheredKeys,
    );
    Object.assign(mergedContext, sessionMetadata);

    // Start with LLM-provided context (overrides metadata)
    Object.assign(mergedContext, context);

    // PASS fields OVERRIDE LLM context (fix bug: was reversed before)
    if (handoffConfig?.context?.pass && handoffConfig.context.pass.length > 0) {
      const parentData = currentThread.data.values;
      for (const passField of handoffConfig.context.pass) {
        const fieldName = typeof passField === 'string' ? passField : passField.name;
        if (parentData[fieldName] !== undefined) {
          mergedContext[fieldName] = parentData[fieldName];
        }
      }
    }

    // If config has summary, interpolate and set as _handoff_summary
    if (handoffConfig?.context?.summary) {
      mergedContext._handoff_summary = interpolateMessage(
        handoffConfig.context.summary,
        currentThread.data.values,
      );
    }

    const grantedMemory = await resolveHandoffMemoryGrants({
      session,
      currentThread,
      currentIR,
      handoffConfig,
    });
    applyGrantedMemoryValues(mergedContext, grantedMemory);

    // Handoff guardrail check — evaluate before context transfer
    const dslGuardrails = currentIR?.constraints?.guardrails ?? [];
    const handoffPolicy = await getSessionPolicy(session);
    const allHandoffGuardrails = [...dslGuardrails, ...(handoffPolicy?.additionalGuardrails ?? [])];
    if (allHandoffGuardrails.some((g) => g.kind === 'handoff')) {
      try {
        if (session.tenantId) await ensureTenantProvidersLoaded(session.tenantId);
        // Create per-invocation pipeline with llmEval for Tier 3 guardrails
        const llmEval = session.llmClient ? createLLMEvalFromClient(session.llmClient) : undefined;
        const pipeline = createGuardrailPipeline(llmEval, session.tenantId, session.projectId, {
          policy: handoffPolicy,
          piiRecognizerRegistry: session.piiRecognizerRegistry,
          cacheScopeKey: getSessionGuardrailCacheScopeKey(session),
        });
        const handoffContent = JSON.stringify(mergedContext);
        const guardrailResult = await pipeline.execute(
          dslGuardrails,
          handoffContent,
          'handoff',
          {
            sourceAgent: currentThread.agentName,
            targetAgent,
            handoffContext: JSON.stringify(context),
            handoffReason: (input.reason as string) ?? '',
            agentGoal: currentIR?.identity?.goal,
          },
          onTraceEvent
            ? (event) =>
                onTraceEvent({
                  type: 'guardrail_check',
                  data: event as Record<string, unknown>,
                })
            : undefined,
          handoffPolicy,
        );

        if (!guardrailResult.passed) {
          const violationMsg =
            guardrailResult.primaryViolation?.message ??
            formatErrorSync('GUARDRAIL_HANDOFF_BLOCKED').message;
          onTraceEvent?.(
            traceHandoffBlocked({
              fromAgent: currentThread.agentName,
              toAgent: targetAgent,
              guardrailName: guardrailResult.primaryViolation?.name ?? 'unknown',
              reason: guardrailResult.primaryViolation?.action ?? 'block',
            }),
          );
          return handleHandoffFailure(
            session,
            handoffConfig,
            violationMsg,
            'setup',
            onChunk,
            onTraceEvent,
          );
        }

        // If guardrail modified the context (e.g., redacted PII), use modified version
        if (guardrailResult.modifiedContent) {
          try {
            mergedContext = JSON.parse(guardrailResult.modifiedContent);
          } catch {
            log.warn('Guardrail modified handoff context is not valid JSON, using original', {
              from: currentThread.agentName,
              to: targetAgent,
            });
          }
        }
      } catch (guardrailErr) {
        // Fail-open: guardrail errors should NOT block handoffs
        log.warn('Handoff guardrail evaluation failed, proceeding with handoff', {
          from: currentThread.agentName,
          to: targetAgent,
          error: guardrailErr instanceof Error ? guardrailErr.message : String(guardrailErr),
        });
        onTraceEvent?.(
          tracePipelineError({
            kind: 'handoff',
            error: guardrailErr instanceof Error ? guardrailErr.message : String(guardrailErr),
            agent: currentThread.agentName,
          }),
        );
      }
    }

    // --- Remote handoff via A2A ---
    if (resolvedAgentInfo.location === 'remote' && resolvedAgentInfo.remote) {
      return this.handleRemoteHandoff(
        session,
        targetAgent,
        resolvedAgentInfo,
        mergedContext,
        returnExpected,
        handoffConfig,
        input.message as string | undefined,
        onChunk,
        onTraceEvent,
      );
    }

    // --- Local thread-based handoff ---
    if (!resolvedAgentInfo.ir) {
      return handleHandoffFailure(
        session,
        handoffConfig,
        `Agent ${targetAgent} has no IR (not compiled)`,
        'setup',
        onChunk,
        onTraceEvent,
      );
    }

    const handoffAuth = await validateHandoffAuthRequirements({
      targetAgentName: targetAgent,
      targetAgentIR: resolvedAgentInfo.ir,
      authContext: deriveActivationAuthContext(session),
      environment: session.versionInfo?.environment,
    });
    if (!handoffAuth.satisfied) {
      onTraceEvent?.({
        type: 'handoff_auth_preflight_blocked',
        data: {
          from: currentThread.agentName,
          to: targetAgent,
          experienceMode: handoffExperienceMode,
          visibility: handoffVisibility,
          suppressChildOutput,
          missingRequirements: handoffAuth.missing.map((requirement) => ({
            connector: requirement.connector,
            authProfileRef: requirement.authProfileRef,
            connectionMode: requirement.connectionMode,
          })),
        },
      });

      const missingSummary = handoffAuth.missing
        .map((requirement) => `${requirement.authProfileRef} (${requirement.connectionMode})`)
        .join(', ');
      return handleHandoffFailure(
        session,
        handoffConfig,
        `Cannot hand off to ${targetAgent} until required auth profiles are authorized: ${missingSummary}.`,
        'setup',
        onChunk,
        onTraceEvent,
      );
    }

    if (returnExpected) {
      // Parent thread waits for child to complete or return — threadStack tracks
      // the return path. Note: child still streams directly to user via onChunk
      // passthrough; this flag only controls thread lifecycle, not streaming.
      currentThread.status = 'waiting';
      currentThread.handoffStartedAt = Date.now();
      if (handoffConfig?.timeout) {
        const timeoutMs = parseTimeout(handoffConfig.timeout);
        if (timeoutMs) {
          currentThread.handoffTimeoutMs = timeoutMs;
          currentThread.handoffTimeoutAction = handoffConfig.on_timeout ?? 'escalate';
        }
      }
      session.threadStack.push(session.activeThreadIndex);
    } else {
      // Permanent handoff — parent thread is done. Child becomes the active
      // thread and streams directly to user (same as returnExpected, but no
      // return path is preserved).
      currentThread.status = 'completed';
      currentThread.endedAt = Date.now();
    }

    // --- Thread resume: check for existing waiting thread ---
    const existingWaitingIndex = session.threads.reduce(
      (latest: number, t, i) =>
        t.agentName === targetAgent && t.status === 'waiting' ? i : latest,
      -1,
    );
    const reusingWaitingThread = existingWaitingIndex >= 0;

    let newThread: AgentThread;
    if (existingWaitingIndex >= 0) {
      // RESUME existing thread — preserves conversation history and gathered data
      newThread = session.threads[existingWaitingIndex];
      newThread.status = 'active';

      // Merge new context into existing data (don't overwrite existing values)
      for (const [key, value] of Object.entries(mergedContext)) {
        if (key.startsWith('_') || newThread.data.values[key] === undefined) {
          newThread.data.values[key] = value;
        }
      }

      applyGrantedMemoryValues(newThread.data.values, grantedMemory);

      onTraceEvent?.({
        type: 'thread_resume',
        data: {
          agentName: targetAgent,
          targetAgent,
          threadIndex: existingWaitingIndex,
          childThreadIndex: existingWaitingIndex,
          from: currentThread.agentName,
          sourceAgent: currentThread.agentName,
          parentAgent: currentThread.agentName,
          parentThreadIndex: parentThreadIndexAtStart,
          returnExpected,
          decisionId: handoffDecisionId,
          reasonCode: 'thread_resume_handoff',
          preservedHistoryLength: newThread.conversationHistory.length,
          preservedDataKeys: [...newThread.data.gatheredKeys],
        },
      });
    } else {
      // No waiting thread — create new one (existing logic)
      const historyStrategy = resolveHistoryStrategy(handoffConfig, session, {
        targetSupportsSummaryOnly: agentNeedsLLMWiring(resolvedAgentInfo.ir),
      });
      let initialHistory: Array<{ role: string; content: MessageContent }> | undefined;
      if (historyStrategy === 'full') {
        initialHistory = [...currentThread.conversationHistory];
      } else if (typeof historyStrategy === 'object' && 'last_n' in historyStrategy) {
        const n = historyStrategy.last_n;
        initialHistory = currentThread.conversationHistory.slice(-n);
      }
      // 'none' and 'summary_only' → no history (summary already in mergedContext._handoff_summary)

      newThread = createThread(session, targetAgent, resolvedAgentInfo.ir, {
        handoffFrom: currentThread.agentName,
        handoffContext: mergedContext,
        returnExpected,
        initialData: mergedContext,
        initialHistory,
      });
    }

    session.handoffStack = [...session.handoffStack, targetAgent];
    try {
      await activateAgentExecutionContext({
        session,
        targetAgentName: targetAgent,
        targetIR: resolvedAgentInfo.ir,
        targetThread: newThread,
        authMode: 'handoff',
        authContext: newThread.activationAuthContext,
        llmWiring: this.llmWiring,
        wireLLMClient: agentNeedsLLMWiring(resolvedAgentInfo.ir),
        onTraceEvent,
      });
    } catch (error) {
      if (session.handoffStack.at(-1) === targetAgent) {
        session.handoffStack = session.handoffStack.slice(0, -1);
      }
      if (returnExpected) {
        currentThread.status = 'active';
        delete currentThread.handoffStartedAt;
        delete currentThread.handoffTimeoutMs;
        delete currentThread.handoffTimeoutAction;
        if (session.threadStack.at(-1) === session.threads.indexOf(currentThread)) {
          session.threadStack.pop();
        }
      } else {
        currentThread.status = 'active';
        delete currentThread.endedAt;
      }
      if (reusingWaitingThread) {
        newThread.status = 'waiting';
      } else {
        const newThreadIndex = session.threads.indexOf(newThread);
        if (newThreadIndex >= 0) {
          session.threads.splice(newThreadIndex, 1);
        }
      }
      session.activeThreadIndex = session.threads.indexOf(currentThread);
      syncThreadToSession(session);
      refreshExecutionTreeProjection(session);
      return handleHandoffFailure(
        session,
        handoffConfig,
        error instanceof Error ? error.message : String(error),
        'dispatch',
        onChunk,
        onTraceEvent,
      );
    }
    if (!session.isEscalated) {
      session.escalationReason = undefined;
    }

    // Emit agent_switch event so streaming consumers (SSE/WS) can surface active agent identity
    if (onTraceEvent) {
      onTraceEvent({
        type: 'agent_switch',
        data: {
          agentName: targetAgent,
          previousAgent: currentThread.agentName,
          mode: resolvedAgentInfo.ir.flow ? 'scripted' : 'reasoning',
          experienceMode: handoffExperienceMode,
          visibility: handoffVisibility,
        },
      });
    }

    // Use explicit message from supervisor (required field), falling back to
    // last user message as safety net if the LLM omits it.
    const messageToForward =
      (input.message as string) ||
      contentToString(
        currentThread.conversationHistory.filter((m) => m.role === 'user').pop()?.content || '',
      );

    // Capture the original user intent for resume_intent continuation.
    // Must be done before child execution mutates conversation history.
    const originalUserIntent = contentToString(
      currentThread.conversationHistory.filter((m) => m.role === 'user').pop()?.content || '',
    );

    const handoffMessageSession =
      currentThread.data === session.data &&
      currentThread.agentIR === session.agentIR &&
      currentThread.agentName === session.agentName
        ? session
        : ({
            ...session,
            data: currentThread.data,
            agentIR: currentThread.agentIR ?? session.agentIR,
            agentName: currentThread.agentName,
          } as RuntimeSession);

    const localVoiceHandoffMessage = isVoiceChannel(session)
      ? (() => {
          const fallbackTemplate =
            currentThread.agentIR?.messages?.handoff_message_voice ||
            DEFAULT_MESSAGES.handoff_message_voice;
          const resolution = resolveLocalizedAgentMessageWithMetadata({
            session: handoffMessageSession,
            messageKey: 'handoff_message_voice',
            fallbackMessage: fallbackTemplate,
            agentIR: currentThread.agentIR,
            agentName: currentThread.agentName,
          });

          return {
            text: interpolateTemplate(resolution.text, {
              target: targetAgent.replace(/_/g, ' '),
            }),
            isProjectOwned: resolution.localization?.domain === 'project',
          };
        })()
      : null;

    // Emit agent:before lifecycle event before child agent executes
    await executeRecallForAgentEvent(session, targetAgent, 'before', onTraceEvent).catch((err) => {
      log.warn('RECALL for agent:before failed during handoff', {
        target: targetAgent,
        error: err instanceof Error ? err.message : String(err),
      });
    });
    onTraceEvent?.({
      type: 'agent_lifecycle',
      data: {
        agentName: targetAgent,
        phase: 'before',
        invocationType: 'handoff',
        from: currentThread.agentName,
      },
    });

    // Realtime voice providers that keep the live transport session active
    // across handoff should not execute the child agent here. Doing so invokes
    // the generic runtime LLM path and surfaces the child agent's configured
    // text model in traces before the transport session has applied the new
    // agent context.
    if (
      isGrokRealtimeVoiceSession(session) ||
      isGoogleRealtimeVoiceSession(session) ||
      isOpenAIRealtimeVoiceSession(session)
    ) {
      const isGoogleRealtime = isGoogleRealtimeVoiceSession(session);
      const isOpenAIRealtime = isOpenAIRealtimeVoiceSession(session);
      if (!suppressChildOutput && localVoiceHandoffMessage?.isProjectOwned) {
        emitCompleteRuntimeStatusChunk({
          session,
          onChunk,
          text: localVoiceHandoffMessage.text,
        });
      }
      log.info('Deferring realtime handoff child execution to voice transport', {
        sessionId: session.id,
        targetAgent,
        activeAgent: session.agentName,
        provider: isGoogleRealtime ? 'google' : isOpenAIRealtime ? 'openai' : 'grok',
      });
      return { success: true };
    }

    // Execute child agent in the same session (new active thread).
    // Customer-visible handoffs forward child chunks. Internal handoffs keep the
    // child result in model context/traces but do not stream it to the caller.
    // returnExpected only controls whether the parent thread enters 'waiting'
    // state (with threadStack push for later return) vs 'completed' state.
    // For resume_intent replays, pass options through to prevent duplicate messages.
    // For normal handoffs, pass options only if already set (preserving other options).
    let childStreamedVisibleOutput = false;
    const childOnChunk =
      onChunk && !suppressChildOutput
        ? (chunk: string) => {
            if (chunk.trim().length > 0) {
              childStreamedVisibleOutput = true;
            }
            onChunk(chunk);
          }
        : undefined;

    if (!suppressChildOutput && localVoiceHandoffMessage?.isProjectOwned) {
      emitCompleteRuntimeStatusChunk({
        session,
        onChunk,
        text: localVoiceHandoffMessage.text,
      });
    }

    if (!suppressChildOutput) {
      emitStreamedHandoffTransition({
        session,
        continuity: handoffContinuity,
        onChunk,
      });
    }

    const childExecutionOptions: import('./types.js').ExecuteMessageOptions = options
      ? { ...options }
      : {};
    if (!options?.resumeIntentReplay) {
      childExecutionOptions.messageForwardedFromHandoff = true;
    }
    if (suppressChildOutput) {
      childExecutionOptions.messageSource = childExecutionOptions.messageSource ?? 'handoff';
      childExecutionOptions.responseVisibility = 'internal';
      childExecutionOptions.suppressRenderableOutput = true;
      childExecutionOptions.sourceAgent = currentThread.agentName;
    }

    const result = await this.ctx.executeMessage(
      session.id,
      messageToForward,
      childOnChunk,
      onTraceEvent,
      childExecutionOptions,
    );

    const childReturnedVisibleResponse =
      !suppressChildOutput &&
      typeof result.response === 'string' &&
      result.response.trim().length > 0;
    if (
      onChunk &&
      localVoiceHandoffMessage &&
      !localVoiceHandoffMessage.isProjectOwned &&
      localVoiceHandoffMessage.text &&
      !suppressChildOutput &&
      !childStreamedVisibleOutput &&
      !childReturnedVisibleResponse
    ) {
      emitCompleteRuntimeStatusChunk({
        session,
        onChunk,
        text: localVoiceHandoffMessage.text,
      });
    }

    // Emit agent:after lifecycle event after child agent completes
    await executeRecallForAgentEvent(session, targetAgent, 'after', onTraceEvent).catch((err) => {
      log.warn('RECALL for agent:after failed during handoff', {
        target: targetAgent,
        error: err instanceof Error ? err.message : String(err),
      });
    });
    onTraceEvent?.({
      type: 'agent_lifecycle',
      data: {
        agentName: targetAgent,
        phase: 'after',
        invocationType: 'handoff',
        from: currentThread.agentName,
      },
    });

    // Sync child thread completion: flow agents set session.isComplete but don't update thread status
    if (session.isComplete || result.action?.type === 'complete') {
      newThread.status = 'completed';
      newThread.endedAt = Date.now();
      if (returnExpected) {
        // Reset session-level flag — will be re-evaluated after return-to-parent
        session.isComplete = false;
      }
    }

    // Implicit completion for text-only RETURN:true children.
    // Agents with no tools (can't call __complete__) and no flow (no THEN:COMPLETE
    // path) have no mechanism to explicitly signal completion. After they produce
    // a response, they're done.
    if (
      returnExpected &&
      newThread.status !== 'completed' &&
      result.action?.type === 'continue' &&
      result.response &&
      !session.agentIR?.tools?.length &&
      !session.currentFlowStep
    ) {
      newThread.status = 'completed';
      newThread.endedAt = Date.now();
    }

    // Propagate new thread's gathered data to session-level for UI display
    if (newThread.data.gatheredKeys.size > 0) {
      const gathered = getGatherProgress({ data: newThread.data } as RuntimeSession);
      for (const [key, value] of Object.entries(gathered)) {
        session.data.values[key] = value;
        session.data.gatheredKeys.add(key);
      }
    }

    let returnAlreadyHandled = false;

    // Handle return if expected and thread completed (or child called return_to_parent)
    if (
      returnExpected &&
      (newThread.status === 'completed' || result.action?.type === 'return_to_parent')
    ) {
      const childThreadIndex = session.threads.indexOf(newThread);
      const childStillActive =
        childThreadIndex === session.activeThreadIndex && session.agentName === targetAgent;

      const unwindHandoffStack = () => {
        if (session.handoffStack.at(-1) === targetAgent) {
          session.handoffStack = session.handoffStack.slice(0, -1);
        }
      };

      let resolvedParentIndex: number | undefined;
      if (childStillActive) {
        resolvedParentIndex = session.threadStack.pop();
      } else {
        // tryThreadReturn may already have popped the stack and activated the parent thread.
        const activeIdx = session.activeThreadIndex;
        const activeThread = session.threads[activeIdx];
        if (
          activeThread &&
          activeThread.agentName !== targetAgent &&
          activeThread.status === 'active'
        ) {
          resolvedParentIndex = activeIdx;
        }
      }

      if (resolvedParentIndex !== undefined) {
        // Unwind handoffStack to match — keep stack in sync with threadStack
        unwindHandoffStack();
        const parentThread = session.threads[resolvedParentIndex];
        parentThread.status = 'active';
        session.activeThreadIndex = resolvedParentIndex;
        returnAlreadyHandled = !childStillActive;

        // Merge data back to parent — use ON_RETURN.MAP if configured, otherwise merge all
        const onReturn = handoffConfig?.on_return;
        const returnMap =
          typeof onReturn === 'object' && onReturn !== null ? onReturn.map : undefined;

        if (returnMap && Object.keys(returnMap).length > 0) {
          // Structured return mapping: child key → parent key
          for (const [childKey, parentKey] of Object.entries(returnMap)) {
            const value = newThread.data.values[childKey];
            if (value !== undefined) {
              parentThread.data.values[parentKey] = value;
              parentThread.data.gatheredKeys.add(parentKey);
            }
          }
        } else {
          // Default: merge all gathered data back
          for (const key of newThread.data.gatheredKeys) {
            parentThread.data.values[key] = newThread.data.values[key];
            parentThread.data.gatheredKeys.add(key);
          }
        }

        mergeReturnedExecutionTreeGrantWrites(session, parentThread, newThread);

        // Add child output to parent conversation. Structured-only child returns still need
        // to survive in the parent runtime context even when there is no text carrier.
        if (
          !returnAlreadyHandled &&
          (result.response ||
            result.richContent ||
            result.actions ||
            result.voiceConfig ||
            result.responseMetadata)
        ) {
          const { message } = buildStructuredHandoffAssistantMessage(
            session,
            {
              text: result.response,
              richContent: result.richContent,
              actions: result.actions,
              voiceConfig: result.voiceConfig,
              responseMetadata: result.responseMetadata,
            },
            { prefix: `[${targetAgent}]: ` },
          );
          parentThread.conversationHistory.push(message);
        }

        // Forward out-of-scope message to parent so supervisor can re-route
        const forwardedMsg = newThread.data.values._forwarded_message;
        if (forwardedMsg && typeof forwardedMsg === 'string') {
          parentThread.conversationHistory.push({
            role: 'user',
            content: forwardedMsg,
          });
          delete newThread.data.values._forwarded_message;
        }

        // Sync parent thread back to session top-level
        syncThreadToSession(session);
        refreshExecutionTreeProjection(session);
        const parentIR =
          parentThread.agentIR ??
          lookupAgentForSession(this.ctx, session, parentThread.agentName)?.ir;
        if (parentIR) {
          await activateAgentExecutionContext({
            session,
            targetAgentName: parentThread.agentName,
            targetIR: parentIR,
            targetThread: parentThread,
            authMode: 'handoff',
            authContext: parentThread.activationAuthContext,
            llmWiring: this.llmWiring,
            wireLLMClient: agentNeedsLLMWiring(parentIR),
            onTraceEvent,
          });
        }
      } else {
        unwindHandoffStack();
      }
    } else if (!returnExpected) {
      // Permanent handoff - parent stays completed, session continues with new thread
      // isComplete stays false at session level since new thread is active
    }

    // ── ON_RETURN action dispatch ──────────────────────────────────────────
    // Dispatch post-return actions declared in the handoff config.
    // Detection: regardless of whether tryThreadReturn (inside child's executeMessage)
    // or handleHandoff's return block (above) performed the actual return, if
    // session.agentName !== targetAgent then the parent is now active.
    //
    // Currently only `resume_intent` is implemented. The switch structure makes
    // adding future actions (complete, respond:, goto:, escalate) a one-case change.
    const returnedToParent = returnExpected && session.agentName !== targetAgent;
    const childResponseForDelivery = suppressChildOutput ? undefined : result.response;
    let postReturnResponse = childResponseForDelivery;

    if (returnedToParent && handoffConfig?.on_return && !returnAlreadyHandled) {
      const returnDispatch = await dispatchHandoffOnReturnBehavior(session, targetAgent, {
        baseResponse: childResponseForDelivery,
        originalUserIntent,
        onChunk,
        onTraceEvent,
        executeMessage: this.ctx.executeMessage,
        isResumeIntentReplay: session._resumeIntentReplayActive === true,
        baseResponseDelivery:
          onChunk && !suppressChildOutput ? 'already_visible' : 'include_in_result',
        decisionId: handoffDecisionId,
        parentThreadIndex: session.activeThreadIndex,
        childThreadIndex: session.threads.indexOf(newThread),
      });

      if (returnDispatch.resumed) {
        return {
          success: true,
          response: returnDispatch.response ?? result.response ?? '',
        };
      }

      postReturnResponse = returnDispatch.response ?? result.response;
    }

    // Re-wire LLM client for the now-active agent.
    if (!session.llmClient && session.agentIR && agentNeedsLLMWiring(session.agentIR)) {
      await this.llmWiring
        .wireLLMClient(
          session,
          session.agentIR,
          session.tenantId,
          session.projectId,
          session.userId,
        )
        .catch((err) => {
          log.error('Failed to re-wire LLM client after handoff return', { error: String(err) });
        });
    }

    return {
      success: true,
      response: postReturnResponse ?? '',
      result:
        postReturnResponse === result.response
          ? result
          : {
              response: postReturnResponse ?? '',
              action: result.action,
              ...(result.stateUpdates !== undefined ? { stateUpdates: result.stateUpdates } : {}),
            },
    };
  }

  // =============================================================================
  // REMOTE AGENT CAPABILITY INSPECTION
  // =============================================================================

  /**
   * Create an A2AClient with the appropriate auth headers for a remote agent.
   * If the agent registry entry has auth config, uses createA2AClientWithAuth.
   * Otherwise, uses the plain createA2AClient.
   */
  private createClientForAgent(
    agentInfo: AgentRegistryEntry,
  ): (baseUrl: string) => ReturnType<typeof createA2AClient> {
    const auth = agentInfo.remote?.auth;
    if (auth?.type && auth?.value) {
      const outboundAuth: OutboundAuthConfig = {
        type: auth.type as 'bearer' | 'api_key',
        value: auth.value,
        header: auth.header,
      };
      return (baseUrl: string) => createA2AClientWithAuth(baseUrl, outboundAuth);
    }
    return createA2AClient;
  }

  /**
   * Discover and cache a remote agent's capabilities.
   * Used to determine the best dispatch method (sync, streaming, async).
   * Returns null if discovery fails (fallback to DSL config).
   */
  private async getRemoteAgentCard(
    endpoint: string,
    tenantId: string,
    tracing: A2ATracingPort,
    validator: SsrfEndpointValidator,
    allowPrivate: boolean,
  ): Promise<AgentCard | null> {
    const cached = this.agentCardCache.get(endpoint);
    if (cached) return cached;

    try {
      const card = await discoverAgent(
        { endpoint, tenantId, allowPrivate },
        { tracing, validator, createClient: createA2AClient },
      );
      if (!card) {
        log.info('Remote agent discovery returned no card; falling back to DSL config', {
          endpoint,
        });
        return null;
      }
      this.agentCardCache.set(endpoint, card);
      log.info('Remote agent card discovered', { endpoint, capabilities: card.capabilities });
      return card;
    } catch (err) {
      log.warn('Remote agent card discovery failed', {
        endpoint,
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  }

  private async finalizeRemoteReturn(
    session: RuntimeSession,
    targetAgent: string,
    responseText: string,
    originalUserIntent: string | undefined,
    onChunk?: (chunk: string) => void,
    onTraceEvent?: (event: { type: string; data: Record<string, unknown> }) => void,
  ): Promise<string | undefined> {
    const returnDispatch = await dispatchHandoffOnReturnBehavior(session, targetAgent, {
      baseResponse: responseText,
      originalUserIntent,
      onChunk,
      onTraceEvent,
      executeMessage: this.ctx.executeMessage,
      isResumeIntentReplay: session._resumeIntentReplayActive === true,
      baseResponseDelivery: onChunk ? 'already_visible' : 'include_in_result',
      resumeTraceSource: 'remote_handoff_return',
    });

    return returnDispatch.response;
  }

  // =============================================================================
  // REMOTE HANDOFF
  // =============================================================================

  private async handleRemoteHandoff(
    session: RuntimeSession,
    targetAgent: string,
    agentInfo: AgentRegistryEntry,
    context: Record<string, unknown>,
    returnExpected: boolean,
    handoffConfig: HandoffConfig | undefined,
    messageOverride?: string,
    onChunk?: (chunk: string) => void,
    onTraceEvent?: (event: { type: string; data: Record<string, unknown> }) => void,
  ): Promise<HandoffExecutionResult> {
    const currentThread = getActiveThread(session);

    // Build history for remote based on strategy
    const historyStrategy = resolveHistoryStrategy(handoffConfig, session, {
      targetSupportsSummaryOnly: agentInfo.ir ? agentNeedsLLMWiring(agentInfo.ir) : true,
    });
    let historyMessages: Array<{ role: string; content: MessageContent }> | undefined;
    if (historyStrategy === 'full') {
      historyMessages = [...currentThread.conversationHistory];
    } else if (typeof historyStrategy === 'object' && 'last_n' in historyStrategy) {
      historyMessages = currentThread.conversationHistory.slice(-historyStrategy.last_n);
    }

    // Create a thread to track the remote execution
    if (returnExpected) {
      currentThread.status = 'waiting';
      currentThread.handoffStartedAt = Date.now();
      if (handoffConfig?.timeout) {
        const timeoutMs = parseTimeout(handoffConfig.timeout);
        if (timeoutMs) {
          currentThread.handoffTimeoutMs = timeoutMs;
          currentThread.handoffTimeoutAction = handoffConfig.on_timeout ?? 'escalate';
        }
      }
      session.threadStack.push(session.activeThreadIndex);
    } else {
      currentThread.status = 'completed';
      currentThread.endedAt = Date.now();
    }

    const remoteThread = createThread(session, targetAgent, null, {
      handoffFrom: currentThread.agentName,
      handoffContext: context,
      returnExpected,
    });
    session.activeThreadIndex = session.threads.length - 1;

    // Use explicit message from supervisor (required field), falling back to
    // last user message as safety net if the LLM omits it.
    const messageToForward =
      messageOverride ||
      contentToString(
        currentThread.conversationHistory.filter((m) => m.role === 'user').pop()?.content || '',
      );
    const originalUserIntent = messageToForward;

    if (onChunk) {
      const handoffVars = { target: targetAgent.replace(/_/g, ' ') };
      const messageKey = isVoiceChannel(session)
        ? 'remote_handoff_message_voice'
        : 'remote_handoff_message';
      const fallbackTemplate = isVoiceChannel(session)
        ? session.agentIR?.messages?.remote_handoff_message_voice ||
          DEFAULT_MESSAGES.remote_handoff_message_voice
        : session.agentIR?.messages?.remote_handoff_message ||
          DEFAULT_MESSAGES.remote_handoff_message;
      const msg = interpolateTemplate(
        resolveLocalizedAgentMessage({
          session,
          messageKey,
          fallbackMessage: fallbackTemplate,
        }),
        handoffVars,
      );
      emitCompleteRuntimeStatusChunk({ session, onChunk, text: msg });
    }

    // Build SDK message for sendTask
    const taskId = `task_${session.id}_${Date.now()}`;
    const sdkMessage = {
      message: {
        kind: 'message' as const,
        messageId: `msg-${session.id}-${Date.now()}`,
        role: 'user' as const,
        contextId: session.id,
        parts: [{ kind: 'text' as const, text: messageToForward }],
        // History is placed on message.metadata so the receiving SDK's
        // RequestContext.userMessage.metadata preserves it for inbound adapters.
        // MessageSendParams.metadata (top-level) is NOT forwarded to RequestContext.
        ...(historyMessages ? { metadata: { history: historyMessages } } : {}),
      },
      metadata: {
        context,
      },
    };

    // Create tracing adapter that bridges to the existing onTraceEvent callback
    const tracing: A2ATracingPort = {
      traceOutbound(params) {
        if (onTraceEvent) {
          onTraceEvent({
            type: 'a2a_call',
            data: {
              targetAgent,
              endpoint: params.targetEndpoint,
              taskId: params.taskId,
              tenantId: params.tenantId,
              durationMs: params.durationMs,
              status: params.status,
              ...(params.error ? { error: params.error } : {}),
            },
          });
        }
      },
      traceInbound() {
        // Not used for outbound handoffs
      },
    };

    const validator = new SsrfEndpointValidator();
    const allowPrivate = shouldAllowPrivateRemoteEndpoints();
    const remoteTimeoutMs = agentInfo.remote?.timeout ?? 30_000;

    // --- Async A2A path: suspend session and wait for push notification callback ---
    if (handoffConfig?.async && this.ctx.asyncInfra) {
      return this.handleAsyncRemoteHandoff(
        session,
        targetAgent,
        agentInfo,
        taskId,
        sdkMessage,
        remoteThread,
        returnExpected,
        originalUserIntent,
        handoffConfig,
        tracing,
        validator,
        allowPrivate,
        remoteTimeoutMs,
        onChunk,
        onTraceEvent,
      );
    }

    // --- Streaming path: if remote supports SSE and user is connected ---
    if (onChunk) {
      const remoteCard = await this.getRemoteAgentCard(
        agentInfo.remote!.endpoint,
        session.tenantId || 'unknown',
        tracing,
        validator,
        allowPrivate,
      );
      if (remoteCard?.capabilities?.streaming) {
        return this.handleStreamingRemoteHandoff(
          session,
          targetAgent,
          agentInfo,
          taskId,
          sdkMessage,
          remoteThread,
          returnExpected,
          originalUserIntent,
          tracing,
          validator,
          allowPrivate,
          remoteTimeoutMs,
          onChunk,
          onTraceEvent,
        );
      }
    }

    // Emit handoff_progress: started
    const handoffStartTime = Date.now();
    if (onTraceEvent) {
      onTraceEvent({
        type: 'handoff_progress',
        data: { phase: 'started', targetAgent, taskId, async: false },
      });
    }

    let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await Promise.race([
        sendTask(
          {
            endpoint: agentInfo.remote!.endpoint,
            tenantId: session.tenantId || 'unknown',
            taskId,
            message: sdkMessage,
            allowPrivate,
          },
          {
            tracing,
            validator,
            createClient: this.createClientForAgent(agentInfo),
          },
        ),
        new Promise<never>((_, reject) => {
          timeoutTimer = setTimeout(
            () => reject(new Error(`Remote handoff timeout after ${remoteTimeoutMs}ms`)),
            remoteTimeoutMs,
          );
        }),
      ]);
      if (timeoutTimer) clearTimeout(timeoutTimer);

      const responseOutput = extractA2AResponseOutput(result);
      const protectedResponse = buildStructuredHandoffAssistantMessage(session, responseOutput);

      if (result.kind === 'task') {
        const taskState = result.status.state;

        if (taskState === 'completed') {
          remoteThread.conversationHistory.push(protectedResponse.message);
          remoteThread.status = 'completed';
          remoteThread.endedAt = Date.now();

          // Handle return
          if (returnExpected) {
            const parentIndex = session.threadStack.pop();
            if (parentIndex !== undefined) {
              const parentThread = session.threads[parentIndex];
              parentThread.status = 'active';
              session.activeThreadIndex = parentIndex;
              const { message } = buildStructuredHandoffAssistantMessage(session, responseOutput, {
                prefix: `[${targetAgent}]: `,
              });
              parentThread.conversationHistory.push(message);
              syncThreadToSession(session);
            }
          }

          // Emit handoff_progress: completed
          if (onTraceEvent) {
            onTraceEvent({
              type: 'handoff_progress',
              data: {
                phase: 'completed',
                targetAgent,
                taskId,
                async: false,
                durationMs: Date.now() - handoffStartTime,
              },
            });
          }

          if (onChunk) onChunk(protectedResponse.deliveryText);
          const response =
            (await this.finalizeRemoteReturn(
              session,
              targetAgent,
              protectedResponse.deliveryText,
              originalUserIntent,
              onChunk,
              onTraceEvent,
            )) ?? protectedResponse.deliveryText;
          return {
            success: true,
            response,
            result: { ...protectedResponse.result, response },
          };
        } else if (taskState === 'input-required') {
          remoteThread.conversationHistory.push(protectedResponse.message);
          // Keep thread active for multi-turn remote conversation
          syncThreadToSession(session);
          if (onChunk) onChunk(protectedResponse.deliveryText);
          return {
            success: true,
            response: protectedResponse.deliveryText,
            result: protectedResponse.result,
          };
        } else {
          // Remote agent reported a failed state — restore parent if waiting
          remoteThread.status = 'completed';
          remoteThread.endedAt = Date.now();
          if (returnExpected) {
            const parentIndex = session.threadStack.pop();
            if (parentIndex !== undefined) {
              session.threads[parentIndex].status = 'active';
              session.activeThreadIndex = parentIndex;
              syncThreadToSession(session);
            }
          }

          // Emit handoff_progress: failed
          if (onTraceEvent) {
            onTraceEvent({
              type: 'handoff_progress',
              data: {
                phase: 'failed',
                targetAgent,
                taskId,
                async: false,
                error: `Remote agent failed: ${taskState}`,
                durationMs: Date.now() - handoffStartTime,
              },
            });
          }

          return { success: false, error: `Remote agent failed: ${taskState}` };
        }
      } else {
        // Result is a Message — treat as completed response
        remoteThread.conversationHistory.push(protectedResponse.message);
        remoteThread.status = 'completed';
        remoteThread.endedAt = Date.now();

        if (returnExpected) {
          const parentIndex = session.threadStack.pop();
          if (parentIndex !== undefined) {
            const parentThread = session.threads[parentIndex];
            parentThread.status = 'active';
            session.activeThreadIndex = parentIndex;
            const { message } = buildStructuredHandoffAssistantMessage(session, responseOutput, {
              prefix: `[${targetAgent}]: `,
            });
            parentThread.conversationHistory.push(message);
            syncThreadToSession(session);
          }
        }

        // Emit handoff_progress: completed
        if (onTraceEvent) {
          onTraceEvent({
            type: 'handoff_progress',
            data: {
              phase: 'completed',
              targetAgent,
              taskId,
              async: false,
              durationMs: Date.now() - handoffStartTime,
            },
          });
        }

        if (onChunk) onChunk(protectedResponse.deliveryText);
        const response =
          (await this.finalizeRemoteReturn(
            session,
            targetAgent,
            protectedResponse.deliveryText,
            originalUserIntent,
            onChunk,
            onTraceEvent,
          )) ?? protectedResponse.deliveryText;
        return {
          success: true,
          response,
          result: { ...protectedResponse.result, response },
        };
      }
    } catch (error) {
      if (timeoutTimer) clearTimeout(timeoutTimer);
      // Remote call threw — restore parent from waiting so session isn't stranded
      remoteThread.status = 'completed';
      remoteThread.endedAt = Date.now();
      if (returnExpected) {
        const parentIndex = session.threadStack.pop();
        if (parentIndex !== undefined) {
          session.threads[parentIndex].status = 'active';
          session.activeThreadIndex = parentIndex;
          syncThreadToSession(session);
        }
      } else {
        currentThread.status = 'active';
        delete currentThread.endedAt;
        session.activeThreadIndex = session.threads.indexOf(currentThread);
        syncThreadToSession(session);
      }

      // Best-effort: cancel the remote task on timeout/error
      cancelRemoteTask(
        {
          endpoint: agentInfo.remote!.endpoint,
          tenantId: session.tenantId || 'unknown',
          taskId,
          allowPrivate,
        },
        { tracing, validator, createClient: this.createClientForAgent(agentInfo) },
      ).catch((cancelErr: unknown) => {
        log.warn('Best-effort remote task cancel failed', {
          taskId,
          targetAgent,
          error: cancelErr instanceof Error ? cancelErr.message : String(cancelErr),
        });
      });

      // Emit handoff_progress: failed
      if (onTraceEvent) {
        onTraceEvent({
          type: 'handoff_progress',
          data: {
            phase: 'failed',
            targetAgent,
            taskId,
            async: false,
            error: error instanceof Error ? error.message : String(error),
            durationMs: Date.now() - handoffStartTime,
          },
        });
      }

      return handleHandoffFailure(
        session,
        handoffConfig,
        `Remote handoff failed: ${error instanceof Error ? error.message : String(error)}`,
        'dispatch',
        onChunk,
        onTraceEvent,
      );
    }
  }

  // =============================================================================
  // STREAMING REMOTE HANDOFF — consume remote SSE and forward to user
  // =============================================================================

  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- matches handleRemoteHandoff signature
  private async handleStreamingRemoteHandoff(
    session: RuntimeSession,
    targetAgent: string,
    agentInfo: AgentRegistryEntry,
    taskId: string,
    sdkMessage: any, // TODO: type as MessageSendParams when handleRemoteHandoff is typed
    remoteThread: any, // TODO: type as AgentThread when handleRemoteHandoff is typed
    returnExpected: boolean,
    originalUserIntent: string | undefined,
    tracing: A2ATracingPort,
    validator: SsrfEndpointValidator,
    allowPrivate: boolean,
    _remoteTimeoutMs: number,
    onChunk: (chunk: string) => void,
    onTraceEvent?: (event: { type: string; data: Record<string, unknown> }) => void,
  ): Promise<HandoffExecutionResult> {
    const handoffStartTime = Date.now();

    if (onTraceEvent) {
      onTraceEvent({
        type: 'handoff_progress',
        data: { phase: 'started', targetAgent, taskId, async: false },
      });
    }

    try {
      let fullText = '';
      // sendTaskStreaming disabled: SDK async generator hangs on cleanup.
      // Using synchronous sendTask with response forwarding as workaround.
      // See import block comment for details on the @a2a-js/sdk limitation.
      log.info('Using degraded streaming path (sync+forward) due to SDK generator limitation', {
        targetAgent,
        taskId,
        endpoint: agentInfo.remote!.endpoint,
      });
      let streamTimeoutTimer: ReturnType<typeof setTimeout> | undefined;
      const result = await Promise.race([
        sendTask(
          {
            endpoint: agentInfo.remote!.endpoint,
            tenantId: session.tenantId || 'unknown',
            taskId,
            message: sdkMessage,
            allowPrivate,
          },
          { tracing, validator, createClient: this.createClientForAgent(agentInfo) },
        ),
        new Promise<never>((_, reject) => {
          streamTimeoutTimer = setTimeout(
            () => reject(new Error(`Streaming handoff timeout after ${_remoteTimeoutMs}ms`)),
            _remoteTimeoutMs,
          );
        }),
      ]);

      // Extract response text and forward to user via onChunk
      if (streamTimeoutTimer) clearTimeout(streamTimeoutTimer);

      const responseOutput = extractA2AResponseOutput(result);
      fullText = responseOutput.text;
      const protectedResponse = buildStructuredHandoffAssistantMessage(session, responseOutput);
      if (fullText) {
        onChunk(protectedResponse.deliveryText);
      }

      log.info('Streaming handoff complete', { targetAgent, fullTextLength: fullText.length });

      // Complete the handoff
      remoteThread.conversationHistory.push(protectedResponse.message);
      remoteThread.status = 'completed';
      remoteThread.endedAt = Date.now();

      if (returnExpected) {
        const parentIndex = session.threadStack.pop();
        if (parentIndex !== undefined) {
          const parentThread = session.threads[parentIndex];
          parentThread.status = 'active';
          session.activeThreadIndex = parentIndex;
          const { message } = buildStructuredHandoffAssistantMessage(session, responseOutput, {
            prefix: `[${targetAgent}]: `,
          });
          parentThread.conversationHistory.push(message);
          syncThreadToSession(session);
        }
      }

      if (onTraceEvent) {
        onTraceEvent({
          type: 'handoff_progress',
          data: {
            phase: 'completed',
            targetAgent,
            taskId,
            async: false,
            durationMs: Date.now() - handoffStartTime,
          },
        });
      }

      const response =
        (await this.finalizeRemoteReturn(
          session,
          targetAgent,
          protectedResponse.deliveryText,
          originalUserIntent,
          onChunk,
          onTraceEvent,
        )) ?? protectedResponse.deliveryText;
      return {
        success: true,
        response,
        result: { ...protectedResponse.result, response },
      };
    } catch (error) {
      // Streaming failed — fall back handled by caller or report error
      remoteThread.status = 'completed';
      remoteThread.endedAt = Date.now();
      if (returnExpected) {
        const parentIndex = session.threadStack.pop();
        if (parentIndex !== undefined) {
          session.threads[parentIndex].status = 'active';
          session.activeThreadIndex = parentIndex;
          syncThreadToSession(session);
        }
      }

      if (onTraceEvent) {
        onTraceEvent({
          type: 'handoff_progress',
          data: {
            phase: 'failed',
            targetAgent,
            taskId,
            async: false,
            error: error instanceof Error ? error.message : String(error),
            durationMs: Date.now() - handoffStartTime,
          },
        });
      }

      return {
        success: false,
        error: `Streaming handoff failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  // =============================================================================
  // ASYNC REMOTE HANDOFF — suspend session, wait for push notification
  // =============================================================================

  private async handleAsyncRemoteHandoff(
    session: RuntimeSession,
    targetAgent: string,
    agentInfo: AgentRegistryEntry,
    taskId: string,
    sdkMessage: any,
    remoteThread: any,
    returnExpected: boolean,
    originalUserIntent: string | undefined,
    handoffConfig: HandoffConfig,
    tracing: A2ATracingPort,
    validator: SsrfEndpointValidator,
    allowPrivate: boolean,
    remoteTimeoutMs: number,
    onChunk?: (chunk: string) => void,
    onTraceEvent?: (event: { type: string; data: Record<string, unknown> }) => void,
  ): Promise<HandoffExecutionResult> {
    const asyncInfra = this.ctx.asyncInfra!;
    const crypto = await import('crypto');

    const suspensionId = crypto.randomUUID();
    const callbackId = crypto.randomUUID();
    const callbackUrl = `${asyncInfra.callbackBaseUrl}/${callbackId}`;
    const callbackSecretPlain = crypto.randomBytes(32).toString('hex');
    const { encryptForTenantAuto: encryptSecret } =
      await import('@agent-platform/shared/encryption');
    const callbackSecret = await encryptSecret(
      callbackSecretPlain,
      session.tenantId || 'unknown',
      '_tenant',
      '_tenant',
    );
    const DEFAULT_MAX_ASYNC_TIMEOUT_SEC = 30 * 24 * 60 * 60; // 30 days
    const DEFAULT_ASYNC_TIMEOUT_SEC = 300;
    const maxAsyncTimeoutSec = this.ctx.config.maxAsyncTimeoutSec || DEFAULT_MAX_ASYNC_TIMEOUT_SEC;
    const requestedTimeout = handoffConfig.asyncTimeout || DEFAULT_ASYNC_TIMEOUT_SEC;
    const asyncTimeoutSec = Math.min(requestedTimeout, maxAsyncTimeoutSec);

    log.info('Initiating async A2A handoff', {
      targetAgent,
      endpoint: agentInfo.remote!.endpoint,
      asyncTimeoutSec,
      taskId,
    });

    // Create suspension record
    const now = new Date();
    const suspension = {
      suspensionId,
      executionId: taskId,
      sessionId: session.id,
      tenantId: session.tenantId || 'unknown',
      projectId: session.projectId,
      reason: {
        type: 'remote_handoff' as const,
        target: targetAgent,
        remoteTaskId: taskId,
        callbackId,
        timeout: asyncTimeoutSec,
      },
      continuation: {
        type: 'remote_handoff_result' as const,
        targetAgent,
        remoteThreadIndex: session.threads.length - 1,
        parentThreadIndex: returnExpected
          ? session.threadStack[session.threadStack.length - 1]
          : undefined,
        returnExpected,
        remoteTaskId: taskId,
      },
      channelBinding: {
        channelType: 'web_debug',
        tenantId: session.tenantId || 'unknown',
        wsSessionId: session.id,
        projectId: session.projectId,
      },
      callbackId,
      callbackSecret,
      status: 'suspended' as const,
      suspendedAt: now,
      expiresAt: new Date(now.getTime() + asyncTimeoutSec * 1000),
      resumeAttempts: 0,
    };

    // Persist suspension and register callback
    await asyncInfra.suspensionStore.create(suspension);
    await asyncInfra.callbackRegistry.register({
      callbackId,
      suspensionId,
      sessionId: session.id,
      tenantId: session.tenantId || 'unknown',
      expiresAt: suspension.expiresAt.getTime(),
    });

    if (onTraceEvent) {
      onTraceEvent({
        type: 'a2a_async_suspend',
        data: {
          targetAgent,
          endpoint: agentInfo.remote!.endpoint,
          taskId,
          suspensionId,
          callbackUrl,
          asyncTimeoutSec,
          agentName: session.agentName,
        },
      });
      // Emit handoff_progress: submitted
      onTraceEvent({
        type: 'handoff_progress',
        data: { phase: 'submitted', targetAgent, taskId, async: true },
      });
    }

    try {
      const result = await sendTaskAsync(
        {
          endpoint: agentInfo.remote!.endpoint,
          tenantId: session.tenantId || 'unknown',
          taskId,
          message: sdkMessage,
          allowPrivate,
          pushNotificationUrl: callbackUrl,
          pushNotificationToken: callbackSecretPlain,
        },
        {
          tracing,
          validator,
          createClient: this.createClientForAgent(agentInfo),
        },
      );

      log.info('Async A2A task submitted', {
        taskId,
        remoteTaskState: result.status.state,
        targetAgent,
      });

      // Mark remote thread as suspended (waiting for callback)
      remoteThread.status = 'suspended';

      // Checkpoint session immediately (no debounce) so it can be restored on resume
      await this.ctx.persistSession(session);

      // Register polling fallback: if push notification never arrives,
      // the suspension expiration handler can poll the remote task status
      // as a recovery mechanism. Store the polling metadata in the suspension.
      if (asyncInfra.registerPollFallback) {
        asyncInfra
          .registerPollFallback({
            suspensionId,
            endpoint: agentInfo.remote!.endpoint,
            remoteTaskId: taskId,
            tenantId: session.tenantId || 'unknown',
            pollIntervalMs: 30_000,
            maxPolls: Math.ceil((asyncTimeoutSec * 1000) / 30_000),
          })
          .catch((err: unknown) => {
            log.warn('Failed to register poll fallback', {
              suspensionId,
              error: err instanceof Error ? err.message : String(err),
            });
          });
      }

      // Emit handoff_progress: suspended
      if (onTraceEvent) {
        onTraceEvent({
          type: 'handoff_progress',
          data: { phase: 'suspended', targetAgent, taskId, async: true },
        });
      }

      const waitingMsg = `The request has been submitted to ${targetAgent.replace(/_/g, ' ')} and is being processed. Results will be delivered when ready.`;
      if (onChunk) onChunk(waitingMsg);

      return { success: true, response: waitingMsg };
    } catch (error) {
      if (error instanceof SyncResponseForAsyncRequest) {
        // Remote agent completed synchronously despite our non-blocking request
        // Handle inline like the sync path
        log.info('Async A2A completed synchronously', { taskId, targetAgent });
        const result = error.result as Task | Message;
        const responseOutput = extractA2AResponseOutput(result);
        const protectedResponse = buildStructuredHandoffAssistantMessage(session, responseOutput);

        // Clean up suspension since we got an immediate result
        await asyncInfra.suspensionStore.complete(suspensionId);
        await asyncInfra.callbackRegistry.remove(callbackId);

        remoteThread.conversationHistory.push(protectedResponse.message);
        remoteThread.status = 'completed';
        remoteThread.endedAt = Date.now();

        if (returnExpected) {
          const parentIndex = session.threadStack.pop();
          if (parentIndex !== undefined) {
            const parentThread = session.threads[parentIndex];
            parentThread.status = 'active';
            session.activeThreadIndex = parentIndex;
            const { message } = buildStructuredHandoffAssistantMessage(session, responseOutput, {
              prefix: `[${targetAgent}]: `,
            });
            parentThread.conversationHistory.push(message);
            syncThreadToSession(session);
          }
        }

        // Emit handoff_progress: completed (sync fallback)
        if (onTraceEvent) {
          onTraceEvent({
            type: 'handoff_progress',
            data: { phase: 'completed', targetAgent, taskId, async: true },
          });
        }

        if (onChunk) onChunk(protectedResponse.deliveryText);
        const response =
          (await this.finalizeRemoteReturn(
            session,
            targetAgent,
            protectedResponse.deliveryText,
            originalUserIntent,
            onChunk,
            onTraceEvent,
          )) ?? protectedResponse.deliveryText;
        return {
          success: true,
          response,
          result: { ...protectedResponse.result, response },
        };
      }

      // Clean up suspension on failure
      await asyncInfra.suspensionStore.fail(suspensionId, {
        code: 'ASYNC_HANDOFF_FAILED',
        message: error instanceof Error ? error.message : String(error),
      });
      await asyncInfra.callbackRegistry.remove(callbackId);

      remoteThread.status = 'completed';
      remoteThread.endedAt = Date.now();
      if (returnExpected) {
        const parentIndex = session.threadStack.pop();
        if (parentIndex !== undefined) {
          session.threads[parentIndex].status = 'active';
          session.activeThreadIndex = parentIndex;
          syncThreadToSession(session);
        }
      }

      // Emit handoff_progress: failed
      if (onTraceEvent) {
        onTraceEvent({
          type: 'handoff_progress',
          data: {
            phase: 'failed',
            targetAgent,
            taskId,
            async: true,
            error: error instanceof Error ? error.message : String(error),
          },
        });
      }

      return {
        success: false,
        error: `Async remote handoff failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  // =============================================================================
  // ASYNC FAN-OUT — barrier-based coordination for mixed local/remote fan-out
  // =============================================================================

  private async handleAsyncFanOut(
    session: RuntimeSession,
    currentThread: any,
    localAgentTasks: any[],
    remoteAgentTasks: any[],
    toolTasks: any[],
    existingResults: any[],
    childThreadRefs: Map<string, any>,
    executionId: string,
    onChunk?: (chunk: string) => void,
    onTraceEvent?: (event: { type: string; data: Record<string, unknown> }) => void,
  ): Promise<{ success: boolean; results: any[]; failedCount: number }> {
    const asyncInfra = this.ctx.asyncInfra!;
    const crypto = await import('crypto');
    const totalBranches = localAgentTasks.length + remoteAgentTasks.length + toolTasks.length;
    const timeoutMs = this.ctx.config.timeoutMs || 30000;
    const tenantId = session.tenantId || 'unknown';
    const maxAsyncTimeoutSec =
      this.ctx.config.maxAsyncTimeoutSec || DEFAULT_ASYNC_FAN_OUT_TIMEOUT_SEC;
    const branchTimeoutSec = Math.min(DEFAULT_ASYNC_FAN_OUT_TIMEOUT_SEC, maxAsyncTimeoutSec);
    const barrierTimeoutMs = branchTimeoutSec * 1000 + ASYNC_FAN_OUT_BARRIER_GRACE_MS;
    const parentTimeoutSec = Math.ceil(barrierTimeoutMs / 1000);

    const barrierId = await asyncInfra.barrierStore.create({
      parentSessionId: session.id,
      parentExecutionId: executionId,
      tenantId,
      totalBranches,
      timeoutMs: barrierTimeoutMs,
    });

    for (const task of localAgentTasks) {
      const targetInfo = lookupAgentForSession(this.ctx, session, task.target);
      const childThread = createThread(session, task.target, targetInfo?.ir ?? null, {
        handoffFrom: currentThread.agentName,
        initialData: {
          ...task.context,
          _fan_out_intent: task.intent,
          _fan_out_child: true,
        },
      });
      primeFanOutChildThreadForImmediateInput(childThread, targetInfo?.ir ?? null);
      childThreadRefs.set(task.target, childThread);
    }

    for (const task of remoteAgentTasks) {
      const targetInfo = lookupAgentForSession(this.ctx, session, task.target);
      const remoteThread = createThread(session, task.target, targetInfo?.ir ?? null, {
        handoffFrom: currentThread.agentName,
        initialData: {
          ...task.context,
          _fan_out_intent: task.intent,
          _fan_out_child: true,
        },
      });
      remoteThread.status = 'waiting';
      childThreadRefs.set(task.target, remoteThread);
    }

    const childSessionIds = new Map<string, string>();
    for (const task of localAgentTasks) {
      childSessionIds.set(task.target, `${session.id}__fanout__${executionId}__${task.target}`);
    }

    const executionContext = createAsyncFanOutExecutionContext({
      executionId,
      barrierId,
      parentSessionId: session.id,
      parentExecutionId: executionId,
      parentThreadIndex: session.activeThreadIndex,
      timeoutMs: barrierTimeoutMs,
      branches: [
        ...toolTasks.map((task) => ({
          targetAgent: task.target,
          branchType: 'tool' as const,
        })),
        ...localAgentTasks.map((task) => {
          const childThread = childThreadRefs.get(task.target);
          return {
            targetAgent: task.target,
            branchType: 'local_agent' as const,
            threadIndex: childThread ? session.threads.indexOf(childThread) : undefined,
            childSessionId: childSessionIds.get(task.target),
          };
        }),
        ...remoteAgentTasks.map((task) => {
          const childThread = childThreadRefs.get(task.target);
          return {
            targetAgent: task.target,
            branchType: 'remote_agent' as const,
            threadIndex: childThread ? session.threads.indexOf(childThread) : undefined,
          };
        }),
      ],
    });

    const branchLookup = new Map(
      executionContext.branches.map((branch) => [
        `${branch.branchType}:${branch.targetAgent}`,
        branch,
      ]),
    );

    const getBranch = (
      branchType: 'tool' | 'local_agent' | 'remote_agent',
      targetAgent: string,
    ) => {
      const branch = branchLookup.get(`${branchType}:${targetAgent}`);
      if (!branch) {
        throw new Error(`Missing async fan-out branch record for ${branchType}:${targetAgent}`);
      }
      return branch;
    };

    const emitBarrierProgress = (
      branch: ReturnType<typeof getBranch>,
      outcome: Awaited<ReturnType<typeof asyncInfra.barrierStore.completeBranch>>,
    ) => {
      onTraceEvent?.({
        type: 'fan_out_barrier_progress',
        data: {
          barrierId,
          branchId: branch.branchId,
          targetAgent: branch.targetAgent,
          branchType: branch.branchType,
          threadIndex: branch.threadIndex,
          disposition: outcome.disposition,
          completedCount: outcome.completedCount,
          totalCount: outcome.totalCount,
          parentResumeReady: outcome.parentResumeReady,
        },
      });
    };

    const results = [...existingResults];
    let parentSuspensionId: string | null = null;

    onTraceEvent?.({
      type: 'fan_out_async_started',
      data: {
        barrierId,
        executionId,
        agentName: currentThread.agentName,
        localAgentCount: localAgentTasks.length,
        remoteAgentCount: remoteAgentTasks.length,
        toolTaskCount: toolTasks.length,
        totalBranches,
        branchTimeoutSec,
        barrierTimeoutMs,
      },
    });

    for (const branch of executionContext.branches) {
      const childThread = childThreadRefs.get(branch.targetAgent);
      if (childThread) {
        childThread.data.values._fan_out_branch_id = branch.branchId;
      }

      onTraceEvent?.({
        type: 'fan_out_branch_registered',
        data: {
          barrierId,
          executionId,
          branchId: branch.branchId,
          targetAgent: branch.targetAgent,
          branchType: branch.branchType,
          threadIndex: branch.threadIndex,
          childSessionId: branch.childSessionId,
          status: branch.status,
        },
      });
    }

    log.info('Initiating async fan-out with barrier', {
      sessionId: session.id,
      executionId,
      barrierId,
      localAgentCount: localAgentTasks.length,
      remoteAgentCount: remoteAgentTasks.length,
      toolTaskCount: toolTasks.length,
      totalBranches,
    });

    if (remoteAgentTasks.length > 0) {
      const parentSuspensionContract = buildParentResumeSuspensionContract({
        barrierId,
        parentThreadIndex: session.activeThreadIndex,
        parentExecutionId: executionId,
        callbackId: crypto.randomUUID(),
        timeoutSeconds: parentTimeoutSec,
      });
      parentSuspensionId = crypto.randomUUID();
      const now = new Date();

      await asyncInfra.suspensionStore.create({
        suspensionId: parentSuspensionId,
        executionId,
        sessionId: session.id,
        tenantId,
        projectId: session.projectId,
        reason: parentSuspensionContract.reason,
        continuation: parentSuspensionContract.continuation,
        channelBinding: {
          channelType: 'web_debug',
          tenantId,
          wsSessionId: session.id,
          projectId: session.projectId,
        },
        callbackId: parentSuspensionContract.reason.callbackId,
        callbackSecret: '',
        barrierId,
        status: 'suspended',
        suspendedAt: now,
        expiresAt: new Date(now.getTime() + barrierTimeoutMs),
        resumeAttempts: 0,
      });

      await asyncInfra.barrierStore.setParentSuspension(barrierId, parentSuspensionId);
      onTraceEvent?.({
        type: 'fan_out_parent_suspended',
        data: {
          barrierId,
          executionId,
          parentSuspensionId,
          parentThreadIndex: session.activeThreadIndex,
          continuationType: parentSuspensionContract.continuation.type,
        },
      });
    }

    for (const task of toolTasks) {
      const branch = getBranch('tool', task.target);
      try {
        // F-1: pass auditContext so audit emission happens inside the function
        const { value: executionParams } = restorePIITokensForToolExecution(
          session,
          task.params ?? {},
          {
            piiAccess: getToolPIIAccess(session, task.target),
            auditContext: {
              onTraceEvent,
              toolName: task.target,
              agentId: session.agentName,
              sessionId: session.id,
              tenantId: session.tenantId,
              projectId: session.projectId,
            },
          },
        );
        const result = session.toolExecutor
          ? await session.toolExecutor.execute(
              task.target,
              executionParams as Record<string, unknown>,
              timeoutMs,
            )
          : { error: 'No tool executor' };
        const response = typeof result === 'string' ? result : JSON.stringify(result);
        const outcome = await asyncInfra.barrierStore.completeBranch(barrierId, {
          branchId: branch.branchId,
          branchAgent: task.target,
          status: 'completed',
          response,
          completedAt: Date.now(),
        });
        emitBarrierProgress(branch, outcome);
        results.push({ target: task.target, status: 'completed', response });
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        log.error('Fan-out branch failed', {
          sessionId: session.id,
          executionId,
          target: task.target,
          barrierId,
          errorCode: err instanceof Error ? (err as any).code || err.name : 'UNKNOWN',
          error: errorMsg,
        });
        const outcome = await asyncInfra.barrierStore.completeBranch(barrierId, {
          branchId: branch.branchId,
          branchAgent: task.target,
          status: 'error',
          error: errorMsg,
          completedAt: Date.now(),
        });
        emitBarrierProgress(branch, outcome);
        results.push({ target: task.target, status: 'error', error: errorMsg });
      }
    }

    for (const task of localAgentTasks) {
      const branch = getBranch('local_agent', task.target);
      const targetInfo = lookupAgentForSession(this.ctx, session, task.target);
      if (!targetInfo?.ir) {
        const outcome = await asyncInfra.barrierStore.completeBranch(barrierId, {
          branchId: branch.branchId,
          branchAgent: task.target,
          status: 'error',
          error: `Agent ${task.target} has no IR`,
          completedAt: Date.now(),
        });
        emitBarrierProgress(branch, outcome);
        results.push({
          target: task.target,
          status: 'error',
          error: `Agent ${task.target} has no IR`,
        });

        const missingIrThread = childThreadRefs.get(task.target);
        if (missingIrThread) {
          missingIrThread.status = 'completed';
          missingIrThread.endedAt = Date.now();
          missingIrThread.data.values._fan_out_error = `Agent ${task.target} has no IR`;
        }
        continue;
      }

      const childThread = childThreadRefs.get(task.target);
      if (!childThread) {
        throw new Error(`Missing local async fan-out thread for ${task.target}`);
      }

      const childIndex = session.threads.indexOf(childThread);
      const childSessionId = childSessionIds.get(task.target);
      if (childIndex < 0 || !childSessionId) {
        throw new Error(`Missing local async fan-out session wiring for ${task.target}`);
      }

      const childSession = createChildSessionForFanOut(session, childIndex);
      childSession.id = childSessionId;

      await activateAgentExecutionContext({
        session: childSession,
        targetAgentName: task.target,
        targetIR: targetInfo.ir,
        targetThread: childThread,
        authMode: 'fan_out',
        childSessionId,
        llmWiring: this.llmWiring,
        wireLLMClient: agentNeedsLLMWiring(targetInfo.ir),
        onTraceEvent,
      });

      this.ctx.markExecuting(childSessionId);
      this.ctx.sessions.set(childSessionId, childSession);

      try {
        await executeRecallForAgentEvent(childSession, task.target, 'before', onTraceEvent).catch(
          (err) => {
            log.warn('RECALL for agent:before failed during async fan-out', {
              target: task.target,
              error: err instanceof Error ? err.message : String(err),
            });
          },
        );
        onTraceEvent?.({
          type: 'agent_lifecycle',
          data: {
            agentName: task.target,
            phase: 'before',
            invocationType: 'fan_out',
            from: currentThread.agentName,
            fromAgent: currentThread.agentName,
            sourceAgent: currentThread.agentName,
            targetAgent: task.target,
            toAgent: task.target,
            childSessionId,
            async: true,
          },
        });

        onTraceEvent?.({
          type: 'fan_out_task_start',
          data: {
            ...buildDelegationTraceData({
              sourceAgent: currentThread.agentName,
              targetAgent: task.target,
              invocationType: 'fan_out',
              parentSessionId: session.id,
              childSessionId,
              parentThreadIndex: session.activeThreadIndex,
              childThreadIndex: childIndex,
              message: task.intent,
              purpose: task.intent,
            }),
            barrierId,
            branchId: branch.branchId,
            async: true,
          },
        });

        const childResult = await this.ctx.executeMessage(
          childSessionId,
          task.intent,
          undefined,
          onTraceEvent,
          {
            messageSource: 'fan_out',
            sourceAgent: currentThread.agentName,
            parentSessionId: session.id,
            parentThreadIndex: session.activeThreadIndex,
            childThreadIndex: childIndex,
          },
        );
        await executeRecallForAgentEvent(childSession, task.target, 'after', onTraceEvent).catch(
          (err) => {
            log.warn('RECALL for agent:after failed during async fan-out', {
              target: task.target,
              error: err instanceof Error ? err.message : String(err),
            });
          },
        );
        onTraceEvent?.({
          type: 'agent_lifecycle',
          data: {
            agentName: task.target,
            phase: 'after',
            invocationType: 'fan_out',
            from: currentThread.agentName,
            fromAgent: currentThread.agentName,
            sourceAgent: currentThread.agentName,
            targetAgent: task.target,
            toAgent: task.target,
            childSessionId,
            async: true,
          },
        });
        childThread.status = 'completed';
        childThread.endedAt = Date.now();

        const outcome = await asyncInfra.barrierStore.completeBranch(barrierId, {
          branchId: branch.branchId,
          branchAgent: task.target,
          status: 'completed',
          response: childResult.response,
          completedAt: Date.now(),
        });
        emitBarrierProgress(branch, outcome);
        results.push({ target: task.target, status: 'completed', response: childResult.response });
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        log.error('Fan-out branch failed', {
          sessionId: session.id,
          executionId,
          target: task.target,
          barrierId,
          errorCode: err instanceof Error ? (err as any).code || err.name : 'UNKNOWN',
          error: errorMsg,
        });
        await executeRecallForAgentEvent(childSession, task.target, 'after', onTraceEvent).catch(
          (recallErr) => {
            log.warn('RECALL for agent:after failed during async fan-out error path', {
              target: task.target,
              error: recallErr instanceof Error ? recallErr.message : String(recallErr),
            });
          },
        );
        onTraceEvent?.({
          type: 'agent_lifecycle',
          data: {
            agentName: task.target,
            phase: 'after',
            invocationType: 'fan_out',
            from: currentThread.agentName,
            fromAgent: currentThread.agentName,
            sourceAgent: currentThread.agentName,
            targetAgent: task.target,
            toAgent: task.target,
            childSessionId,
            async: true,
            error: true,
          },
        });
        childThread.status = 'completed';
        childThread.endedAt = Date.now();
        childThread.data.values._fan_out_error = errorMsg;

        const outcome = await asyncInfra.barrierStore.completeBranch(barrierId, {
          branchId: branch.branchId,
          branchAgent: task.target,
          status: 'error',
          error: errorMsg,
          completedAt: Date.now(),
        });
        emitBarrierProgress(branch, outcome);
        results.push({ target: task.target, status: 'error', error: errorMsg });
      } finally {
        this.ctx.cancelPendingPersist(childSessionId);
        this.ctx.unmarkExecuting(childSessionId);
        this.llmWiring.clearCooldown(childSessionId);
        this.ctx.sessions.delete(childSessionId);
      }
    }

    if (remoteAgentTasks.length > 0) {
      await this.ctx.persistSession(session);
    }

    let pendingRemoteBranches = 0;
    for (const task of remoteAgentTasks) {
      const branch = getBranch('remote_agent', task.target);
      const targetInfo = lookupAgentForSession(this.ctx, session, task.target);
      const childThread = childThreadRefs.get(task.target);
      if (!targetInfo?.remote || !childThread) {
        throw new Error(`Missing remote async fan-out wiring for ${task.target}`);
      }

      const threadIndex = session.threads.indexOf(childThread);
      if (threadIndex < 0) {
        throw new Error(`Missing persisted remote thread index for ${task.target}`);
      }

      const suspensionId = crypto.randomUUID();
      const callbackId = crypto.randomUUID();
      const callbackSecretPlainFanOut = crypto.randomBytes(32).toString('hex');
      const { encryptForTenantAuto: encryptSecretFanOut } =
        await import('@agent-platform/shared/encryption');
      const callbackSecret = await encryptSecretFanOut(
        callbackSecretPlainFanOut,
        tenantId,
        '_tenant',
        '_tenant',
      );
      const callbackUrl = `${asyncInfra.callbackBaseUrl}/${callbackId}`;
      const taskId = `task_${executionId}_${task.target}_${Date.now()}`;
      const branchSuspensionContract = buildRemoteBranchSuspensionContract({
        branch: {
          branchId: branch.branchId,
          targetAgent: task.target,
          threadIndex,
        },
        barrierId,
        parentExecutionId: executionId,
        callbackId,
        timeoutSeconds: branchTimeoutSec,
      });
      const suspendedAt = new Date();
      const expiresAt = new Date(suspendedAt.getTime() + branchTimeoutSec * 1000);

      await asyncInfra.suspensionStore.create({
        suspensionId,
        executionId: taskId,
        sessionId: session.id,
        tenantId,
        projectId: session.projectId,
        reason: branchSuspensionContract.reason,
        continuation: branchSuspensionContract.continuation,
        channelBinding: {
          channelType: 'web_debug',
          tenantId,
          wsSessionId: session.id,
          projectId: session.projectId,
        },
        callbackId,
        callbackSecret,
        barrierId,
        status: 'suspended',
        suspendedAt,
        expiresAt,
        resumeAttempts: 0,
      });
      await asyncInfra.callbackRegistry.register({
        callbackId,
        suspensionId,
        sessionId: session.id,
        tenantId,
        expiresAt: expiresAt.getTime(),
      });

      try {
        const tracing: A2ATracingPort = {
          traceOutbound(params) {
            onTraceEvent?.({ type: 'a2a_call', data: { targetAgent: task.target, ...params } });
          },
          traceInbound() {},
        };

        await sendTaskAsync(
          {
            endpoint: targetInfo.remote!.endpoint,
            tenantId,
            taskId,
            message: {
              message: {
                kind: 'message' as const,
                messageId: `msg-${executionId}-fanout-${task.target}`,
                role: 'user' as const,
                contextId: session.id,
                parts: [{ kind: 'text' as const, text: task.intent }],
              },
            },
            allowPrivate: shouldAllowPrivateRemoteEndpoints(),
            pushNotificationUrl: callbackUrl,
            pushNotificationToken: callbackSecretPlainFanOut,
          },
          {
            tracing,
            validator: new SsrfEndpointValidator(),
            createClient: this.createClientForAgent(targetInfo),
          },
        );

        pendingRemoteBranches++;
        childThread.status = 'waiting';

        onTraceEvent?.({
          type: 'fan_out_branch_dispatched',
          data: {
            barrierId,
            executionId,
            branchId: branch.branchId,
            targetAgent: task.target,
            branchType: branch.branchType,
            threadIndex,
            taskId,
          },
        });

        log.info('Fan-out remote branch dispatched', {
          sessionId: session.id,
          executionId,
          barrierId,
          branchId: branch.branchId,
          targetAgent: task.target,
          threadIndex,
          continuationType: branchSuspensionContract.continuation.type,
          taskId,
        });
      } catch (err) {
        childThread.status = 'completed';
        childThread.endedAt = Date.now();
        childThread.data.values._fan_out_error = err instanceof Error ? err.message : String(err);

        await asyncInfra.suspensionStore.fail(suspensionId, {
          code: 'DISPATCH_FAILED',
          message: err instanceof Error ? err.message : String(err),
        });
        await asyncInfra.callbackRegistry.remove(callbackId);
        const outcome = await asyncInfra.barrierStore.completeBranch(barrierId, {
          branchId: branch.branchId,
          branchAgent: task.target,
          status: 'error',
          error: err instanceof Error ? err.message : String(err),
          completedAt: Date.now(),
        });
        emitBarrierProgress(branch, outcome);
        results.push({
          target: task.target,
          status: 'error',
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    const immediateFanOutResult = {
      success: results.some((result) => result.status === 'completed'),
      results,
      failedCount: results.filter((result) => result.status === 'error').length,
    };
    storeFanOutResultOnThread(currentThread, immediateFanOutResult);
    syncThreadToSession(session);
    await this.ctx.persistSession(session);

    if (pendingRemoteBranches === 0) {
      if (parentSuspensionId) {
        await asyncInfra.suspensionStore.complete(parentSuspensionId);
      }
      await asyncInfra.barrierStore.delete(barrierId);
      childThreadRefs.clear();
      return immediateFanOutResult;
    }

    if (parentSuspensionId) {
      const waitingMsg = `Processing ${pendingRemoteBranches} remote task(s) asynchronously. Local results are ready, remote results will follow.`;
      if (onChunk) onChunk(waitingMsg);
    }

    childThreadRefs.clear();
    return immediateFanOutResult;
  }

  // =============================================================================
  // DELEGATE
  // =============================================================================

  async handleDelegate(
    session: RuntimeSession,
    input: Record<string, unknown>,
    onChunk?: (chunk: string) => void,
    onTraceEvent?: (event: { type: string; data: Record<string, unknown> }) => void,
  ): Promise<{ success: boolean; result?: unknown; error?: string }> {
    const targetAgent = input.target as string;
    const normalizedDelegateInput = normalizeDelegateToolInput(input);
    const delegateInput = normalizedDelegateInput.input ?? {};

    // Find matching delegate config from IR
    const delegateConfig = session.agentIR?.coordination?.delegates?.find(
      (d: DelegateConfigIR) => d.agent === targetAgent,
    );

    // Check WHEN condition if defined
    if (delegateConfig?.when) {
      const evalCtx = session.data.values;
      const conditionMet = compilerEvaluateCondition(delegateConfig.when, evalCtx);

      emitDecisionEvent(onTraceEvent, session.traceVerbosity, 'delegation', {
        outcome: conditionMet ? targetAgent : `skip:${targetAgent}`,
        condition: delegateConfig.when,
        matched: conditionMet,
        trigger: Object.fromEntries(
          Object.entries(evalCtx).filter(([k]) => delegateConfig.when?.includes(k)),
        ),
      });

      if (!conditionMet) {
        if (onTraceEvent) {
          onTraceEvent({
            type: 'constraint_check',
            data: {
              agentName: session.agentName,
              constraintType: 'delegate_when',
              target: targetAgent,
              condition: delegateConfig.when,
              passed: false,
              context: evalCtx,
            },
          });
        }
        return {
          success: false,
          error: `Delegate to ${targetAgent} blocked: WHEN condition not met (${delegateConfig.when}). Collect the required data first, then retry.`,
        };
      }
    }

    // ─── System agent shortcut ──────────────────────────────────────────
    // System agents (system/*) are platform-provided and bypass IR-based
    // delegate validation and execution. Runtime invokes them in-process so
    // the current durable session remains the orchestration boundary.
    if (isSystemAgent(targetAgent)) {
      const permissionFailure = validateSystemAgentRequiredPermissions(
        {
          target: targetAgent,
          permissions: session.permissions ?? [],
          principalId:
            session.userId ??
            session.callerContext?.sessionPrincipalId ??
            session.callerContext?.anonymousId,
          tenantId: session.tenantId,
          projectId: session.projectId,
        },
        onTraceEvent,
      );
      if (permissionFailure) {
        return permissionFailure;
      }

      const systemDeps: SystemAgentHandlerDeps = this.ctx.config.systemAgentHandlerDeps ?? {};

      return handleSystemAgentDelegate(
        {
          target: targetAgent,
          input: delegateInput,
          message: input.message as string | undefined,
          tenantId: session.tenantId || '',
          projectId: session.projectId || '',
          userId:
            session.userId ??
            session.callerContext?.sessionPrincipalId ??
            session.callerContext?.anonymousId,
          permissions: session.permissions,
          timeoutMs: parseTimeout(delegateConfig?.timeout) || this.ctx.config.timeoutMs || 30000,
        },
        systemDeps,
        onTraceEvent,
      );
    }

    // Validate delegate via DelegateExecutor
    {
      const currentThread = getActiveThread(session);
      const delegateExperienceMode = resolveDelegateExperienceMode(delegateConfig);
      const delegateVisibility: CoordinationVisibility = 'internal';
      const delegateResult = this.delegateExecutor.validate(
        { agentName: currentThread.agentName, dataValues: session.data.values },
        { delegateStack: session.delegateStack, agentIR: session.agentIR },
        {
          target: targetAgent,
          input: normalizedDelegateInput.hasExplicitInput ? delegateInput : undefined,
          message: input.message as string | undefined,
        },
        !!lookupAgentForSession(this.ctx, session, targetAgent)?.ir,
      );
      if (!delegateResult.allowed) {
        const error = `Delegate to ${targetAgent} blocked by DelegateExecutor: ${delegateResult.reason}`;
        // Emit delegate_start trace so callers see the attempt
        if (onTraceEvent) {
          onTraceEvent({
            type: 'delegate_start',
            data: {
              from: currentThread.agentName,
              to: targetAgent,
              purpose: delegateConfig?.purpose,
              agentName: currentThread.agentName,
              experienceMode: delegateExperienceMode,
              visibility: delegateVisibility,
              suppressChildOutput: delegateVisibility === 'internal',
            },
          });
        }
        // Use handleDelegateFailure to emit delegate_complete trace and handle on_failure
        return handleDelegateFailure(session, delegateConfig, error, onChunk, onTraceEvent);
      }
    }

    // Use the enhanced executeDelegate method
    return this.executeDelegate(
      session,
      targetAgent,
      delegateConfig,
      normalizedDelegateInput.hasExplicitInput ? delegateInput : undefined,
      input.message as string | undefined,
      onChunk,
      onTraceEvent,
    );
  }

  private async executeDelegate(
    session: RuntimeSession,
    targetAgent: string,
    delegateConfig: DelegateConfigIR | undefined,
    overrideInput?: Record<string, unknown>,
    message?: string,
    onChunk?: (chunk: string) => void,
    onTraceEvent?: (event: { type: string; data: Record<string, unknown> }) => void,
  ): Promise<{ success: boolean; result?: unknown; error?: string }> {
    const currentThread = getActiveThread(session);

    // --- Delegate safety guards (mirrors handleHandoff pattern) ---
    // Prevent self-delegation
    if (currentThread.agentName === targetAgent) {
      const error = `Cannot delegate to yourself (${targetAgent}).`;
      return handleDelegateFailure(session, delegateConfig, error, onChunk, onTraceEvent);
    }

    // Prevent delegate cycles (A → B → A)
    if (session.delegateStack.includes(targetAgent)) {
      const error = `Delegate cycle detected: ${[...session.delegateStack, targetAgent].join(' → ')}. Agent "${targetAgent}" is already in the active delegate chain.`;
      return handleDelegateFailure(session, delegateConfig, error, onChunk, onTraceEvent);
    }

    // Prevent unbounded depth
    if (session.delegateStack.length >= MAX_DELEGATE_DEPTH) {
      const error = `Delegate depth limit reached (${MAX_DELEGATE_DEPTH}). Chain: ${session.delegateStack.join(' → ')}.`;
      return handleDelegateFailure(session, delegateConfig, error, onChunk, onTraceEvent);
    }

    const context = currentThread.data.values;

    // Build input using INPUT mapping from config, or use override
    let delegateInput: Record<string, unknown> = overrideInput || {};
    if (!overrideInput && delegateConfig?.input) {
      delegateInput = mapDelegateInput(delegateConfig.input, context);
    }

    // Look up target agent in registry
    const targetAgentInfo = lookupAgentForSession(this.ctx, session, targetAgent);
    if (!targetAgentInfo || !targetAgentInfo.ir) {
      const error = `Agent not found: ${targetAgent}`;
      return handleDelegateFailure(session, delegateConfig, error, onChunk, onTraceEvent);
    }

    const delegateAuth = await validateDelegateAuthRequirements({
      targetAgentName: targetAgent,
      targetAgentIR: targetAgentInfo.ir,
      authContext: resolveTargetActivationAuthContext({
        session,
        authMode: 'delegate',
        targetAgentName: targetAgent,
      }),
      environment: session.versionInfo?.environment,
    });

    // Parse timeout
    const timeoutMs = parseTimeout(delegateConfig?.timeout) || this.ctx.config.timeoutMs || 30000;
    const delegateExperienceMode = resolveDelegateExperienceMode(delegateConfig);
    const delegateVisibility: CoordinationVisibility = 'internal';
    const suppressChildOutput = true;

    if (!delegateAuth.satisfied) {
      const missingRequirements = delegateAuth.missing.map((requirement) => ({
        connector: requirement.connector,
        authProfileRef: requirement.authProfileRef,
        connectionMode: requirement.connectionMode,
      }));

      onTraceEvent?.({
        type: 'delegate_start',
        data: {
          ...buildDelegationTraceData({
            sourceAgent: currentThread.agentName,
            targetAgent,
            invocationType: 'delegate',
            parentSessionId: session.id,
            parentThreadIndex: session.activeThreadIndex,
            message,
            input: delegateInput,
            purpose: delegateConfig?.purpose,
            experienceMode: delegateExperienceMode,
            visibility: delegateVisibility,
            suppressChildOutput,
          }),
          blocked: true,
          blockReason: 'auth_preflight',
          authPreflight: {
            satisfied: false,
            missingRequirements,
          },
          parentAction: 'continue',
        },
      });

      return handleDelegateFailure(
        session,
        delegateConfig,
        `Cannot delegate to ${targetAgent} until required authorization is complete.`,
        onChunk,
        onTraceEvent,
        {
          sourceAgent: currentThread.agentName,
          targetAgent,
          parentThreadIndex: session.activeThreadIndex,
        },
      );
    }

    // --- Ephemeral thread for delegate ---
    const savedActiveIndex = session.activeThreadIndex;
    const delegateExecutionId = createExecutionId();
    const delegationId = delegateExecutionId;
    const delegateChildSessionId = `${session.id}__delegate__${delegateExecutionId}__${targetAgent}`;

    // Push to delegate stack FIRST so cycle detection works even if subsequent code throws
    session.delegateStack.push(targetAgent);

    const delegateThread = createThread(session, targetAgent, targetAgentInfo.ir, {
      handoffFrom: currentThread.agentName,
      initialData: { ...delegateInput, delegate_from: currentThread.agentName },
    });
    const delegateThreadIndex = session.threads.length - 1;
    if (onTraceEvent) {
      onTraceEvent({
        type: 'delegate_start',
        data: {
          ...buildDelegationTraceData({
            sourceAgent: currentThread.agentName,
            targetAgent,
            invocationType: 'delegate',
            delegationId,
            parentSessionId: session.id,
            childSessionId: delegateChildSessionId,
            parentThreadIndex: savedActiveIndex,
            childThreadIndex: delegateThreadIndex,
            message,
            input: delegateInput,
            purpose: delegateConfig?.purpose,
            experienceMode: delegateExperienceMode,
            visibility: delegateVisibility,
            suppressChildOutput,
          }),
          parentAction: 'pause',
        },
      });
    }
    await activateAgentExecutionContext({
      session,
      targetAgentName: targetAgent,
      targetIR: targetAgentInfo.ir,
      targetThread: delegateThread,
      authMode: 'delegate',
      llmWiring: this.llmWiring,
      wireLLMClient: agentNeedsLLMWiring(targetAgentInfo.ir),
      onTraceEvent,
    });

    // --- Timeout with cooperative cancellation (hoisted for catch access) ---
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
    const delegateSession = createChildSessionForDelegate(session, delegateThreadIndex);
    delegateSession.id = delegateChildSessionId;
    this.ctx.markExecuting(delegateChildSessionId);
    this.ctx.sessions.set(delegateChildSessionId, delegateSession);
    let abortHandler: (() => void) | undefined;

    try {
      // Execute with timeout: prefer explicit message from parent, fall back to
      // stringified input data as safety net.
      const inputMessage =
        message ||
        (typeof delegateInput === 'string' ? delegateInput : JSON.stringify(delegateInput));

      // Emit agent:before lifecycle event before delegate child executes
      await executeRecallForAgentEvent(session, targetAgent, 'before', onTraceEvent).catch(
        (err) => {
          log.warn('RECALL for agent:before failed during delegate', {
            target: targetAgent,
            error: err instanceof Error ? err.message : String(err),
          });
        },
      );
      onTraceEvent?.({
        type: 'agent_lifecycle',
        data: {
          agentName: targetAgent,
          phase: 'before',
          invocationType: 'delegate',
          from: currentThread.agentName,
          fromAgent: currentThread.agentName,
          sourceAgent: currentThread.agentName,
          delegationId,
          targetAgent,
          toAgent: targetAgent,
          parentSessionId: session.id,
          childSessionId: delegateChildSessionId,
          parentThreadIndex: savedActiveIndex,
          childThreadIndex: delegateThreadIndex,
        },
      });

      // Attach .catch() to prevent unhandled rejection if abort wins the race
      const executePromise = this.ctx.executeMessage(
        delegateChildSessionId,
        inputMessage,
        undefined,
        onTraceEvent,
        {
          signal: controller.signal,
          messageSource: 'delegate',
          sourceAgent: currentThread.agentName,
          parentSessionId: session.id,
          delegationId,
          parentThreadIndex: savedActiveIndex,
          childThreadIndex: delegateThreadIndex,
        },
      );
      executePromise.catch((err) => {
        log.warn('Detached delegate child execution failed after abort', {
          target: targetAgent,
          error: err instanceof Error ? err.message : String(err),
        });
      });

      const abortPromise = new Promise<never>((_, reject) => {
        if (controller.signal.aborted) {
          reject(new Error('Delegate timeout'));
          return;
        }
        abortHandler = () => reject(new Error('Delegate timeout'));
        controller.signal.addEventListener('abort', abortHandler, { once: true });
      });

      const result = await Promise.race([executePromise, abortPromise]);
      const delegateResultEnvelope = buildDelegateResultEnvelope(result, delegateSession);

      // Emit agent:after lifecycle event after delegate child completes
      await executeRecallForAgentEvent(session, targetAgent, 'after', onTraceEvent).catch((err) => {
        log.warn('RECALL for agent:after failed during delegate', {
          target: targetAgent,
          error: err instanceof Error ? err.message : String(err),
        });
      });
      onTraceEvent?.({
        type: 'agent_lifecycle',
        data: {
          agentName: targetAgent,
          phase: 'after',
          invocationType: 'delegate',
          from: currentThread.agentName,
          fromAgent: currentThread.agentName,
          sourceAgent: currentThread.agentName,
          delegationId,
          targetAgent,
          toAgent: targetAgent,
          parentSessionId: session.id,
          childSessionId: delegateChildSessionId,
          parentThreadIndex: savedActiveIndex,
          childThreadIndex: delegateThreadIndex,
        },
      });

      // Restore active thread to caller
      session.activeThreadIndex = savedActiveIndex;
      delegateThread.status = 'completed';
      delegateThread.endedAt = Date.now();
      syncThreadToSession(session);
      session.delegateStack.pop();
      const parentThread = session.threads[savedActiveIndex];
      const parentIR =
        parentThread?.agentIR ??
        lookupAgentForSession(this.ctx, session, parentThread?.agentName ?? '')?.ir;
      if (parentThread && parentIR) {
        await activateAgentExecutionContext({
          session,
          targetAgentName: parentThread.agentName,
          targetIR: parentIR,
          targetThread: parentThread,
          authMode: 'delegate',
          authContext: parentThread.activationAuthContext,
          llmWiring: this.llmWiring,
          wireLLMClient: agentNeedsLLMWiring(parentIR),
          onTraceEvent,
        });
      }
      onTraceEvent?.({
        type: 'thread_return',
        data: {
          fromAgent: targetAgent,
          toAgent: parentThread?.agentName,
          sourceAgent: targetAgent,
          targetAgent: parentThread?.agentName,
          from: targetAgent,
          to: parentThread?.agentName,
          agentName: parentThread?.agentName,
          returnType: 'delegate',
          invocationType: 'delegate',
          delegationId,
          parentSessionId: session.id,
          childSessionId: delegateChildSessionId,
          parentThreadIndex: savedActiveIndex,
          childThreadIndex: delegateThreadIndex,
        },
      });

      // Map results back using RETURNS config
      if (delegateConfig?.returns) {
        mapDelegateReturns(delegateConfig.returns, delegateResultEnvelope, session);
      }

      // Process USE_RESULT instruction
      const useResultKey = delegateConfig?.use_result || 'delegate_result';
      currentThread.data.values[useResultKey] = delegateResultEnvelope;
      session.data.values[useResultKey] = delegateResultEnvelope;

      if (onTraceEvent) {
        onTraceEvent({
          type: 'delegate_complete',
          data: buildDelegationTraceData({
            sourceAgent: currentThread.agentName,
            targetAgent,
            invocationType: 'delegate',
            delegationId,
            parentSessionId: session.id,
            childSessionId: delegateChildSessionId,
            parentThreadIndex: savedActiveIndex,
            childThreadIndex: delegateThreadIndex,
            success: true,
            result: delegateResultEnvelope,
            experienceMode: delegateExperienceMode,
            visibility: delegateVisibility,
            suppressChildOutput,
          }),
        });
      }

      return { success: true, result: delegateResultEnvelope };
    } catch (error) {
      // Emit agent:after lifecycle event even on failure
      await executeRecallForAgentEvent(session, targetAgent, 'after', onTraceEvent).catch((err) => {
        log.warn('RECALL for agent:after failed during delegate error path', {
          target: targetAgent,
          error: err instanceof Error ? err.message : String(err),
        });
      });
      onTraceEvent?.({
        type: 'agent_lifecycle',
        data: {
          agentName: targetAgent,
          phase: 'after',
          invocationType: 'delegate',
          from: currentThread.agentName,
          fromAgent: currentThread.agentName,
          sourceAgent: currentThread.agentName,
          delegationId,
          targetAgent,
          toAgent: targetAgent,
          parentSessionId: session.id,
          childSessionId: delegateChildSessionId,
          parentThreadIndex: savedActiveIndex,
          childThreadIndex: delegateThreadIndex,
          error: true,
        },
      });

      // Restore active thread to caller on failure
      session.activeThreadIndex = savedActiveIndex;
      delegateThread.status = 'completed';
      delegateThread.endedAt = Date.now();
      syncThreadToSession(session);
      session.delegateStack.pop();

      const parentThread = session.threads[savedActiveIndex];
      const parentIR =
        parentThread?.agentIR ??
        lookupAgentForSession(this.ctx, session, parentThread?.agentName ?? '')?.ir;
      if (parentThread && parentIR) {
        await activateAgentExecutionContext({
          session,
          targetAgentName: parentThread.agentName,
          targetIR: parentIR,
          targetThread: parentThread,
          authMode: 'delegate',
          authContext: parentThread.activationAuthContext,
          llmWiring: this.llmWiring,
          wireLLMClient: agentNeedsLLMWiring(parentIR),
          onTraceEvent,
        });
      }
      onTraceEvent?.({
        type: 'thread_return',
        data: {
          fromAgent: targetAgent,
          toAgent: parentThread?.agentName,
          sourceAgent: targetAgent,
          targetAgent: parentThread?.agentName,
          from: targetAgent,
          to: parentThread?.agentName,
          agentName: parentThread?.agentName,
          returnType: 'delegate',
          invocationType: 'delegate',
          delegationId,
          parentSessionId: session.id,
          childSessionId: delegateChildSessionId,
          parentThreadIndex: savedActiveIndex,
          childThreadIndex: delegateThreadIndex,
          error: true,
        },
      });

      const errorMsg = error instanceof Error ? error.message : String(error);

      // On timeout, sever shared references so the detached execution can't corrupt parent
      if (errorMsg === 'Delegate timeout') {
        delegateThread.conversationHistory = [];
        delegateThread.state = { ...delegateThread.state };
        delegateThread.data = { values: {}, gatheredKeys: new Set<string>() };
      }

      return handleDelegateFailure(session, delegateConfig, errorMsg, onChunk, onTraceEvent, {
        delegationId,
        childSessionId: delegateChildSessionId,
        parentThreadIndex: savedActiveIndex,
        childThreadIndex: delegateThreadIndex,
        sourceAgent: currentThread.agentName,
        targetAgent,
      });
    } finally {
      clearTimeout(timeoutId);
      if (abortHandler) {
        controller.signal.removeEventListener('abort', abortHandler);
      }
      this.ctx.cancelPendingPersist(delegateChildSessionId);
      this.ctx.unmarkExecuting(delegateChildSessionId);
      this.llmWiring.clearCooldown(delegateChildSessionId);
      this.ctx.sessions.delete(delegateChildSessionId);
    }
  }

  // =============================================================================
  // COMPLETE
  // =============================================================================

  handleComplete(
    session: RuntimeSession,
    input: Record<string, unknown>,
    onTraceEvent?: (event: { type: string; data: Record<string, unknown> }) => void,
    onChunk?: (chunk: string) => void,
  ): { success: boolean; message: string } {
    const message = input.message as string | undefined;
    const storeKey = input.store as string | undefined;

    const result = executeComplete(session, message, storeKey, onChunk, onTraceEvent);

    // Thread return: if this child thread has a parent waiting, return control
    tryThreadReturn(session, result, onTraceEvent);

    return { success: true, message: result.response };
  }

  // =============================================================================
  // ESCALATE
  // =============================================================================

  async handleEscalate(
    session: RuntimeSession,
    input: Record<string, unknown>,
    onTraceEvent?: (event: { type: string; data: Record<string, unknown> }) => void,
  ): Promise<{ success: boolean; message: string; error?: string }> {
    // Validate escalation is configured in the agent IR
    const escalationConfig = session.agentIR?.coordination?.escalation;
    if (!escalationConfig) {
      return {
        success: false,
        message: 'Escalation is not configured for this agent.',
        error: 'ESCALATION_NOT_CONFIGURED',
      };
    }

    // Validate reason
    const rawReason = ((input.reason as string) || '').trim();
    if (rawReason.length < MIN_ESCALATION_REASON_LENGTH) {
      return {
        success: false,
        message: 'Escalation reason is too short or missing.',
        error: 'INVALID_ESCALATION_REASON',
      };
    }
    const reason =
      rawReason.length > MAX_ESCALATION_REASON_LENGTH
        ? rawReason.slice(0, MAX_ESCALATION_REASON_LENGTH)
        : rawReason;

    // Validate priority — default to 'medium' if invalid
    const rawPriority = input.priority as string;
    const priority =
      typeof rawPriority === 'string' &&
      (VALID_ESCALATION_PRIORITIES as readonly string[]).includes(rawPriority)
        ? rawPriority
        : 'medium';
    const requiresPersistedPause = escalationConfig.on_human_complete.length > 0;

    session.isEscalated = true;
    session.escalationReason = reason;

    // Escalation template resolution:
    // project override → locale asset overlay → explicit IR override → channel-aware loader → compiler default
    const escalationChannel = promptTemplateLoader.resolveEscalationChannel(session.channelType);
    const rawIrEscalationTemplate = session.agentIR?.messages?.escalation_format;
    const localizedCatalogEscalationTemplate = resolveSessionLocalizedCatalogMessage({
      session,
      messageKey: 'escalation_format',
    });
    const hasCustomIrEscalationTemplate =
      typeof rawIrEscalationTemplate === 'string' &&
      rawIrEscalationTemplate !== DEFAULT_MESSAGES.escalation_format;
    const escalationTemplate =
      session.promptOverrides?.[`escalation.${escalationChannel}`] ||
      session.promptOverrides?.['escalation.plain'] ||
      localizedCatalogEscalationTemplate ||
      (hasCustomIrEscalationTemplate ? rawIrEscalationTemplate : undefined) ||
      promptTemplateLoader.getEscalation(escalationChannel) ||
      DEFAULT_MESSAGES.escalation_format;
    // Sanitize reason/priority for display — strip HTML tags and markdown formatting
    const displayReason = sanitizeForEscalation(reason);
    const displayPriority = sanitizeForEscalation(priority, 20);
    const message = interpolateTemplate(escalationTemplate, {
      reason: displayReason,
      priority: displayPriority,
    });

    const failEscalationPersistence = (error: string, details: Record<string, unknown>) => {
      session.isEscalated = false;
      session.escalationReason = undefined;
      session.transferInitiated = false;

      log.error('Escalation requires persistence but backing stores are unavailable', {
        sessionId: session.id,
        tenantId: session.tenantId,
        projectId: session.projectId,
        ...details,
      });

      return {
        success: false as const,
        message:
          'Unable to escalate right now because human-resolution persistence is unavailable.',
        error,
      };
    };

    // ─── Create HumanTask Record ────────────────────────────────────
    // Always create a HumanTask for escalation tracking, even without
    // agent-transfer or ITSM connector. This enables the resolution API.
    const ESCALATION_DUE_HOURS = 24;
    const targetTeam = (input.target_team as string) || undefined;
    let humanTaskId: string | undefined;
    if (isDatabaseReady()) {
      try {
        const { HumanTask } = await import('@agent-platform/database/models');
        const humanTask = await HumanTask.create({
          tenantId: session.tenantId || '',
          projectId: session.projectId || '',
          type: 'escalation',
          mailbox: 'agent',
          status: 'pending',
          priority: priority as 'low' | 'medium' | 'high' | 'critical',
          title: `Escalation: ${reason.slice(0, 100)}`,
          description: reason,
          source: {
            type: 'agent_escalation',
            sessionId: session.id,
            agentName: session.agentName,
          },
          assignedToTeam: targetTeam,
          fields: [],
          context: {
            ...filterEscalationContext(session, escalationConfig),
            on_human_complete: escalationConfig.on_human_complete,
          },
          dueAt: new Date(Date.now() + ESCALATION_DUE_HOURS * 60 * 60 * 1000),
          escalationChain: targetTeam ? [targetTeam] : [],
          currentEscalationLevel: 0,
        });
        humanTaskId = humanTask._id;
      } catch (err) {
        log.error('Failed to create HumanTask for escalation', {
          error: err instanceof Error ? err.message : String(err),
          sessionId: session.id,
          tenantId: session.tenantId,
        });
      }
    } else {
      log.warn('Skipping HumanTask creation for escalation — database not ready', {
        sessionId: session.id,
        tenantId: session.tenantId,
        projectId: session.projectId,
      });
    }

    if (requiresPersistedPause && !humanTaskId) {
      return failEscalationPersistence('ESCALATION_PERSISTENCE_UNAVAILABLE', {
        needsHumanTask: true,
      });
    }

    // ─── Agent-Transfer Wiring ───────────────────────────────────────
    // If routing config exists and agent-transfer is initialized, kick off
    // the transfer asynchronously. The escalation still succeeds immediately
    // (HITL fallback) — the transfer is best-effort on top.
    //
    // Routing resolution order:
    //   1. Agent IR escalation routing (escalationConfig.routing.connection)
    //   2. Project-level default routing (agentTransfer.defaultRouting.connection)
    const routing = escalationConfig.routing;
    const transferInitialized = isAgentTransferInitialized();

    log.info('Escalation agent-transfer check', {
      agentName: session.agentName,
      tenantId: session.tenantId,
      projectId: session.projectId,
      hasIrRouting: !!routing?.connection,
      irConnection: routing?.connection ?? null,
      transferInitialized,
    });

    if (transferInitialized) {
      // Await the transfer so failure messages can be returned to the user
      try {
        // Resolve connection: IR routing → project settings fallback
        let connection = routing?.connection;
        let queue = routing?.queue;
        let skills = routing?.skills;
        let routingPriority = routing?.priority;
        let postAgent = routing?.post_agent;
        let resolvedConnectionId: string | undefined;

        if (!connection) {
          if (!isDatabaseReady()) {
            log.info('Skipping project-level default routing lookup — database not ready', {
              agentName: session.agentName,
              tenantId: session.tenantId,
              projectId: session.projectId,
            });
            return { success: true, message };
          }

          // Fallback: read project-level agent transfer settings
          const { findProjectSettings } = await import('../../repos/project-settings-repo.js');
          const projectSettings = await findProjectSettings(
            session.projectId || '',
            session.tenantId || '',
          );
          const defaultRouting = projectSettings?.agentTransfer?.defaultRouting;
          const defaultRoutingConnection = resolveProjectAgentTransferConnectionRef(
            projectSettings?.agentTransfer ?? null,
          );
          if (defaultRoutingConnection?.connectionId) {
            resolvedConnectionId = defaultRoutingConnection.connectionId;
            // connectionId is the ConnectorConnection document _id. Resolve the
            // durable routing reference back to connectorName/auth credentials,
            // while allowing the canonical settings object to carry explicit
            // compatibility hints during rollout.
            const { ConnectorConnection } = await import('@agent-platform/database/models');
            const connDoc = await ConnectorConnection.findOne({
              _id: defaultRoutingConnection.connectionId,
              tenantId: session.tenantId || '',
            }).lean();

            const resolvedConnectorName =
              defaultRoutingConnection.connectorName ??
              (typeof connDoc?.connectorName === 'string' ? connDoc.connectorName : undefined);
            const resolvedAuthProfileId =
              defaultRoutingConnection.authProfileId ??
              (typeof connDoc?.authProfileId === 'string' ? connDoc.authProfileId : undefined);

            if (!resolvedConnectorName) {
              log.warn('Default routing connection reference could not be resolved', {
                connectionId: defaultRoutingConnection.connectionId,
                tenantId: session.tenantId,
                projectId: session.projectId,
                hasConnectionDoc: !!connDoc,
                hasConnectorHint: !!defaultRoutingConnection.connectorName,
              });
              return { success: true, message };
            }

            connection = resolvedConnectorName;
            queue = queue ?? defaultRouting.queue;
            routingPriority = routingPriority ?? defaultRouting.priority;
            postAgent = postAgent ?? defaultRouting.postAgentAction;
            log.info('Using project-level default routing for agent transfer', {
              connectionId: defaultRoutingConnection.connectionId,
              connectorName: resolvedConnectorName,
              queue,
              agentName: session.agentName,
              tenantId: session.tenantId,
              projectId: session.projectId,
              hasConnectionDoc: !!connDoc,
              authProfileSource: defaultRoutingConnection.authProfileId ? 'settings' : 'connection',
            });

            // Lazy-initialize the adapter with credentials from the linked auth profile.
            // Five9 (and similar adapters) require per-connection auth config.
            if (resolvedAuthProfileId) {
              try {
                const { createAuthProfileResolver } =
                  await import('@agent-platform/connectors/services');
                const { AuthProfile } = await import('@agent-platform/database/models');
                const { decryptForTenantAuto } = await import('@agent-platform/shared/encryption');
                const resolver = createAuthProfileResolver({
                  authProfileModel: AuthProfile as any,
                  decrypt: (ciphertext, tid) => decryptForTenantAuto(ciphertext, tid),
                });
                const creds = await resolver.resolve({
                  authProfileId: resolvedAuthProfileId,
                  tenantId: connDoc?.tenantId ?? session.tenantId ?? '',
                  projectId: connDoc?.projectId ?? session.projectId,
                });
                const connectionMetadata =
                  connDoc?.metadata &&
                  typeof connDoc.metadata === 'object' &&
                  !Array.isArray(connDoc.metadata)
                    ? (connDoc.metadata as Record<string, unknown>)
                    : {};
                const adapterAuth = { ...connectionMetadata, ...creds };
                const initRegistry = getAdapterRegistry();
                const connName = resolvedConnectorName;
                const initAdapter = initRegistry?.get(connName);
                if (initAdapter) {
                  await initAdapter.initialize({
                    name: connName,
                    enabled: true,
                    auth: adapterAuth,
                    options: {},
                    timeoutMs: 30000,
                    circuitBreaker: { failureThreshold: 5, resetTimeoutMs: 30000 },
                  });
                  log.info('Adapter initialized with auth profile credentials', {
                    connection,
                    connectionId: defaultRoutingConnection.connectionId,
                    authProfileId: resolvedAuthProfileId,
                    metadataKeys: Object.keys(connectionMetadata),
                  });

                  // Wire orgId/accountId write-back: when KoreAdapter lazily fetches
                  // orgId+accountId via getAccountIdByBotId, persist both into
                  // ConnectorConnection.metadata so future transfers skip the API call.
                  if (initAdapter instanceof KoreAdapter) {
                    const writeBackConnectionId = defaultRoutingConnection.connectionId;
                    const writeBackTenantId = connDoc?.tenantId ?? session.tenantId ?? '';
                    initAdapter.setOnOrgIdResolved(async (orgId: string, accountId?: string) => {
                      const { ConnectorConnection } =
                        await import('@agent-platform/database/models');
                      const updatedMetadata: Record<string, unknown> = {
                        ...connectionMetadata,
                        orgId,
                        ...(accountId ? { accountId } : {}),
                      };
                      await ConnectorConnection.findOneAndUpdate(
                        { _id: writeBackConnectionId, tenantId: writeBackTenantId },
                        { $set: { metadata: updatedMetadata } },
                      );
                      log.info('Persisted resolved orgId/accountId to connection metadata', {
                        connectionId: writeBackConnectionId,
                        orgId,
                        hasAccountId: !!accountId,
                      });
                    });
                  }
                }
              } catch (initErr) {
                log.error('Failed to initialize adapter from auth profile', {
                  connection,
                  connectionId: defaultRoutingConnection.connectionId,
                  authProfileId: resolvedAuthProfileId,
                  error: initErr instanceof Error ? initErr.message : String(initErr),
                });
                return { success: true, message };
              }
            }
          } else {
            log.info('No agent-transfer routing configured (IR or project settings)', {
              agentName: session.agentName,
              tenantId: session.tenantId,
              projectId: session.projectId,
              hasProjectSettings: !!projectSettings,
              hasAgentTransfer: !!projectSettings?.agentTransfer,
              hasDefaultRouting: !!defaultRouting,
            });
            return { success: true, message };
          }
        }

        // connection is guaranteed non-empty here — either from IR routing or project fallback
        const resolvedConnection = connection as string;
        const registry = getAdapterRegistry();
        const store = getTransferSessionStore();
        const adapter = registry?.get(resolvedConnection);

        if (!adapter) {
          log.warn('Agent transfer adapter not found in registry', {
            connection,
            availableAdapters:
              registry && typeof registry.listNames === 'function'
                ? Array.from(registry.listNames())
                : [],
            agentName: session.agentName,
          });
          return { success: true, message };
        }

        if (!store) {
          log.warn('Agent transfer session store not available', {
            connection,
            agentName: session.agentName,
          });
          return { success: true, message };
        }

        session.transferInitiated = true;
        session.recentTransferEndedAt = undefined;
        const tid = session.tenantId || '';

        const voiceGatewayChannels = new Set(['korevg', 'audiocodes', 'jambonz', 'voice_twilio']);
        const rawChannel = session.callerContext?.channel || session.channelType || 'chat';
        const transferChannel = (voiceGatewayChannels.has(rawChannel) ? 'voice' : rawChannel) as
          | 'chat'
          | 'voice'
          | 'email'
          | 'messaging';

        let voiceData:
          | {
              callSid: string;
              caller: string;
              called: string;
              sipCallId?: string;
              sipFrom?: string;
              sipTo?: string;
              originatingSipIp?: string;
              direction?: string;
              callerName?: string;
            }
          | undefined;

        if (transferChannel === 'voice') {
          try {
            const { getVoiceSession } =
              await import('../../services/voice/korevg/korevg-session.js');
            const voiceSession = getVoiceSession(session.id);
            if (voiceSession) {
              voiceData = voiceSession.getVoiceTransferData();
              log.info('Extracted voice transfer data for ESCALATE', {
                callSid: voiceData.callSid,
                caller: voiceData.caller,
                called: voiceData.called,
                hasSipCallId: !!voiceData.sipCallId,
              });
            } else {
              log.warn('No active pipeline voice session found for ESCALATE, checking realtime', {
                sessionId: session.id,
              });
            }
          } catch (err) {
            log.warn('Failed to extract pipeline voice session data for ESCALATE', {
              sessionId: session.id,
              error: err instanceof Error ? err.message : String(err),
            });
          }

          // Fallback: realtime (S2S) sessions use RealtimeVoiceGatewaySession instead of KorevgSession.
          if (!voiceData) {
            try {
              const { getRealtimeVoiceCallData } =
                await import('../../services/voice/korevg/realtime-voice-session.js');
              const realtimeData = getRealtimeVoiceCallData(session.id);
              if (realtimeData) {
                voiceData = realtimeData;
                log.info('Extracted voice transfer data from realtime session for ESCALATE', {
                  callSid: voiceData.callSid,
                  caller: voiceData.caller,
                  called: voiceData.called,
                  hasSipCallId: !!voiceData.sipCallId,
                });
              } else {
                log.warn('No active realtime voice session found for ESCALATE', {
                  sessionId: session.id,
                });
              }
            } catch (err) {
              log.warn('Failed to extract realtime voice session data for ESCALATE', {
                sessionId: session.id,
                error: err instanceof Error ? err.message : String(err),
              });
            }
          }
        }

        const transferEnvelope = await buildRuntimeTransferEnvelope({ session, voiceData });

        log.info('Initiating agent transfer via escalation', {
          connection,
          queue,
          agentName: session.agentName,
          tenantId: tid,
          projectId: session.projectId,
          contactId: transferEnvelope.contactId,
          runtimeSessionId: session.id,
          normalizedTransferChannel: transferEnvelope.routing.normalizedTransferChannel,
          sourceChannelType: transferEnvelope.routing.sourceChannelType,
        });

        const escalationTraceEmitter = getTransferTraceEmitter();
        if (escalationTraceEmitter) {
          void Promise.resolve(
            escalationTraceEmitter.emit({
              type: 'agent_transfer.transfer_initiated',
              timestamp: Date.now(),
              data: {
                tenantId: tid,
                projectId: session.projectId ?? '',
                contactId: transferEnvelope.contactId,
                provider: connection,
                channel: transferEnvelope.routing.normalizedTransferChannel,
                runtimeSessionId: session.id,
                queue: queue ?? undefined,
                skills: skills ?? undefined,
              },
            }),
          ).catch((err) =>
            log.warn('Failed to emit transfer_initiated trace from escalation path', {
              provider: connection,
              tenantId: tid,
              sessionId: session.id,
              error: err instanceof Error ? err.message : String(err),
            }),
          );
        }

        const transferResult = await adapter.execute({
          tenantId: tid,
          projectId: session.projectId || '',
          agentId: session.agentName,
          contactId: transferEnvelope.contactId,
          sessionId: session.id,
          channel: transferEnvelope.routing.normalizedTransferChannel,
          routing: transferEnvelope.routing,
          contextSnapshot: transferEnvelope.contextSnapshot,
          queue,
          skills,
          priority: routingPriority,
          contact: transferEnvelope.contact,
          conversationHistory: session.conversationHistory
            .filter(
              (m: { role: string }) =>
                m.role === 'user' || m.role === 'assistant' || m.role === 'system',
            )
            .map((m: { role: string; content: unknown; timestamp?: string }) => ({
              role: m.role === 'assistant' ? ('agent' as const) : (m.role as 'user' | 'system'),
              content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content),
              timestamp: m.timestamp || new Date().toISOString(),
            })),
          metadata: { reason, priority },
          postAgentAction: postAgent,
          language: transferEnvelope.language,
          voiceData: transferEnvelope.voiceData,
        });

        if (onTraceEvent) {
          onTraceEvent({
            type: 'agent_transfer_initiated',
            data: {
              success: transferResult.success,
              status: transferResult.status,
              provider: connection,
              sessionKey: transferResult.providerSessionId,
              providerSessionId: transferResult.providerSessionId,
              queue,
            },
          });
        }

        if (transferResult.success) {
          log.info('Agent transfer succeeded via escalation', {
            connection,
            providerSessionId: transferResult.providerSessionId,
            status: transferResult.status,
            agentName: session.agentName,
            tenantId: tid,
          });
        } else {
          log.warn('Agent transfer execution failed', {
            error: transferResult.error,
            provider: connection,
            agentName: session.agentName,
          });
          const transferError = transferResult.error ?? {
            code: 'TRANSFER_FAILED',
            message: `Transfer failed with status: ${transferResult.status ?? 'unknown'}`,
          };
          if (escalationTraceEmitter) {
            void Promise.resolve(
              escalationTraceEmitter.emit({
                type: 'agent_transfer.transfer_failed',
                timestamp: Date.now(),
                data: {
                  tenantId: tid,
                  projectId: session.projectId ?? '',
                  contactId: transferEnvelope.contactId,
                  provider: connection,
                  channel: transferEnvelope.routing.normalizedTransferChannel,
                  runtimeSessionId: session.id,
                  errorCode: transferError.code,
                  errorMessage: transferError.message,
                  error: transferError.message,
                  errorType: transferError.code,
                },
              }),
            ).catch((err) =>
              log.warn('Failed to emit transfer_failed trace from escalation path', {
                provider: connection,
                tenantId: tid,
                sessionId: session.id,
                error: err instanceof Error ? err.message : String(err),
              }),
            );
          }
          // Transfer failed — reset escalation flags so the bot resumes
          // normal operation on subsequent messages instead of acting as
          // if a human agent is connected.
          session.isEscalated = false;
          session.transferInitiated = false;
          if (transferResult.error?.message) {
            return {
              success: false,
              message: transferResult.error.message,
              error: transferResult.error.code,
            };
          }
        }
      } catch (err) {
        log.error('Agent transfer wiring error', {
          error: err instanceof Error ? err.message : String(err),
          provider: routing?.connection,
          agentName: session.agentName,
          tenantId: session.tenantId,
        });
        // Transfer threw — reset escalation flags so the bot resumes
        // normal operation instead of acting as if a human agent is connected.
        session.isEscalated = false;
        session.transferInitiated = false;
        const errMsg = err instanceof Error ? err.message : String(err);
        return {
          success: false,
          message: `Agent transfer failed: ${errMsg}`,
          error: 'AGENT_TRANSFER_ERROR',
        };
      }
    } else {
      log.warn(
        'Agent transfer routing configured but subsystem unavailable; falling back to HITL only',
        {
          agentName: session.agentName,
          tenantId: session.tenantId,
          projectId: session.projectId,
          configuredConnection: routing?.connection ?? null,
          hasProjectScopedFallback: !routing?.connection,
        },
      );
    }

    // ─── ITSM Connector Action ──────────────────────────────────────
    // If connector_action is defined, fire-and-forget an ITSM ticket creation.
    // Errors are logged but don't block the escalation.
    if (escalationConfig.connector_action && humanTaskId) {
      void (async () => {
        try {
          const { createConnectorToolExecutorAdapter } =
            await import('../connector-registry-singleton.js');
          const adapter = await createConnectorToolExecutorAdapter(
            session.tenantId || '',
            session.projectId || '',
          );
          if (adapter) {
            const result = await adapter.execute(
              escalationConfig.connector_action!,
              {
                context: filterEscalationContext(session, escalationConfig),
                reason,
                priority,
                sessionId: session.id,
                agentName: session.agentName,
              },
              30_000,
            );

            // Update HumanTask with ticket info if available
            const ticketResult = result as Record<string, unknown> | undefined;
            if (ticketResult) {
              const ticketId =
                typeof ticketResult.ticketId === 'string' ? ticketResult.ticketId : undefined;
              const ticketUrl =
                typeof ticketResult.ticketUrl === 'string' ? ticketResult.ticketUrl : undefined;

              if (ticketId || ticketUrl) {
                const { HumanTask } = await import('@agent-platform/database/models');
                await HumanTask.findOneAndUpdate(
                  { _id: humanTaskId, tenantId: session.tenantId },
                  {
                    $set: {
                      ...(ticketId ? { connectorTicketId: ticketId } : {}),
                      ...(ticketUrl ? { connectorTicketUrl: ticketUrl } : {}),
                      connectorActionName: escalationConfig.connector_action,
                    },
                  },
                );
              }
            }

            onTraceEvent?.({
              type: 'itsm_ticket_created',
              data: {
                connectorAction: escalationConfig.connector_action!,
                humanTaskId: humanTaskId!,
                ticketId: (ticketResult as Record<string, unknown> | undefined)?.ticketId,
                ticketUrl: (ticketResult as Record<string, unknown> | undefined)?.ticketUrl,
                sessionId: session.id,
              },
            });
          }
        } catch (err) {
          log.error('ITSM connector action failed', {
            error: err instanceof Error ? err.message : String(err),
            connectorAction: escalationConfig.connector_action,
            sessionId: session.id,
            tenantId: session.tenantId,
          });
        }
      })();
    }

    // ─── Session Pause (Suspension) ─────────────────────────────────
    // If on_human_complete has conditions, pause the session by creating
    // a SuspendedExecution record. This prevents message processing until
    // the escalation is resolved via POST /:id/escalation/resolve.
    if (requiresPersistedPause && humanTaskId) {
      try {
        const suspensionStore =
          this.ctx.asyncInfra?.suspensionStore ??
          (isDatabaseReady()
            ? new (await import('./mongo-suspension-store.js')).MongoSuspensionStore()
            : null);

        if (!suspensionStore) {
          return failEscalationPersistence('ESCALATION_PERSISTENCE_UNAVAILABLE', {
            needsSuspensionStore: true,
            humanTaskId,
          });
        }

        const { v4: uuidv4 } = await import('uuid');
        const suspensionId = uuidv4();

        await suspensionStore.create({
          suspensionId,
          executionId: `escalation-${session.id}`,
          sessionId: session.id,
          tenantId: session.tenantId || '',
          projectId: session.projectId,
          reason: { type: 'escalation', humanTaskId },
          continuation: {
            type: 'escalation',
            escalationConfig: {
              on_human_complete: escalationConfig.on_human_complete,
              context_for_human: escalationConfig.context_for_human,
              connector_action: escalationConfig.connector_action,
            },
            humanTaskId,
          },
          channelBinding: {
            channelType: session.channelType || 'unknown',
            tenantId: session.tenantId || '',
            projectId: session.projectId,
          },
          callbackId: `escalation-cb-${session.id}`,
          callbackSecret: '',
          status: 'suspended',
          suspendedAt: new Date(),
          expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000), // 7 days
          resumeAttempts: 0,
        });

        log.info('Session paused for escalation', {
          suspensionId,
          sessionId: session.id,
          humanTaskId,
          onHumanCompleteCount: escalationConfig.on_human_complete.length,
        });
      } catch (err) {
        return failEscalationPersistence('ESCALATION_PERSISTENCE_UNAVAILABLE', {
          humanTaskId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    emitDecisionEvent(onTraceEvent, session.traceVerbosity, 'escalation', {
      outcome: reason ?? 'unknown',
      matched: true,
      trigger: { priority, reason },
    });

    onTraceEvent?.({
      type: 'escalation',
      data: {
        reason,
        priority,
        agent: session.agentName,
        context: filterEscalationContext(session, escalationConfig),
      },
    });

    // ─── Enhanced Trace Event ───────────────────────────────────────
    onTraceEvent?.({
      type: 'escalation_triggered',
      data: {
        reason,
        priority,
        agent: session.agentName,
        humanTaskId: humanTaskId ?? null,
        hasAgentTransfer: !!(routing?.connection && isAgentTransferInitialized()),
        hasItsmConnector: !!escalationConfig.connector_action,
        isPaused: escalationConfig.on_human_complete.length > 0,
        sessionId: session.id,
      },
    });

    return { success: true, message };
  }

  // =============================================================================
  // RETURN TO PARENT
  // =============================================================================

  handleReturnToParent(
    session: RuntimeSession,
    input: Record<string, unknown>,
    onTraceEvent?: (event: { type: string; data: Record<string, unknown> }) => void,
  ): { success: boolean; message: string; forwardedMessage?: string } {
    const activeThread = getActiveThread(session);
    if (!activeThread?.returnExpected || session.threadStack.length === 0) {
      return { success: false, message: 'No parent to return to.' };
    }

    const forwardedMessage = (input.message as string) || '';

    // Mark child as WAITING (not completed) — the child is pausing, not finishing.
    // This makes the thread resumable when the supervisor re-routes back.
    activeThread.status = 'waiting';

    // Store forwarded message for the parent to process after return
    activeThread.data.values._forwarded_message = forwardedMessage;

    onTraceEvent?.({
      type: 'return_to_parent',
      data: {
        from: activeThread.agentName,
        sourceAgent: activeThread.agentName,
        to: activeThread.handoffFrom || '',
        targetAgent: activeThread.handoffFrom || '',
        reason: (input.reason as string) || '',
        reasonCode: 'return_to_parent_requested',
        childThreadIndex: session.activeThreadIndex,
        parentThreadIndex: session.threadStack.at(-1),
        forwardedMessage,
      },
    });

    return { success: true, message: '', forwardedMessage };
  }

  // =============================================================================
  // FAN-OUT
  // =============================================================================

  async handleFanOut(
    session: RuntimeSession,
    input: { tasks: FanOutTask[] },
    onChunk?: (chunk: string) => void,
    onTraceEvent?: (event: { type: string; data: Record<string, unknown> }) => void,
  ): Promise<FanOutResult> {
    // (A4) Prevent concurrent fan-out from the same parent session
    if (this._activeFanOutSessions.has(session.id)) {
      return {
        success: false,
        results: [
          {
            target: '_guard',
            status: 'error',
            error: 'Fan-out already in progress for this session',
          },
        ],
        failedCount: 1,
      };
    }
    this._activeFanOutSessions.add(session.id);

    // (Gap9) Hoist thread references so the outer finally can always prune child threads
    const parentThreadRef = getActiveThread(session);
    let childThreadRefs = new Map<string, ReturnType<typeof getActiveThread>>();

    try {
      const tasks = input.tasks;
      const currentThread = parentThreadRef;
      const results: SubTaskResult[] = [];
      const executionId = createExecutionId();
      const fanOutStartTime = Date.now(); // (R11) For totalDurationMs

      const getReusableFanOutThread = (target: string): AgentThread | undefined => {
        for (let i = session.threads.length - 1; i >= 0; i--) {
          const thread = session.threads[i];
          if (
            thread.agentName === target &&
            thread.status === 'waiting' &&
            thread.data.values._fan_out_child === true
          ) {
            return thread;
          }
        }
        return undefined;
      };

      const mergeFanOutContextIntoThread = (thread: AgentThread, task: FanOutTask): void => {
        thread.status = 'active';
        thread.endedAt = undefined;
        thread.pendingResponse = undefined;
        thread.data.values._fan_out_child = true;
        thread.data.values._fan_out_intent = task.intent;
        thread.data.values.delegate_from = currentThread.agentName;

        if (task.context) {
          for (const [key, value] of Object.entries(task.context)) {
            thread.data.values[key] = value;
          }
        }
      };

      const shouldKeepFanOutThreadWaiting = (
        childSession: RuntimeSession,
        result: ExecutionResult,
      ): boolean => {
        if (childSession.isComplete || childSession.isEscalated) {
          return false;
        }

        return result.action?.type === 'collect' || result.action?.type === 'waiting_for_action';
      };

      // --- Wrap onTraceEvent to inject executionId into ALL fan-out events (R4) ---
      const fanOutTraceEvent = onTraceEvent
        ? (event: { type: string; data: Record<string, unknown> }) =>
            onTraceEvent({
              type: event.type,
              data: {
                ...event.data,
                executionId,
                parentSessionId: session.id,
              },
            })
        : undefined;

      // --- Validation ---
      const dedupedTasks = deduplicateFanOutTasks(tasks);
      const filteredTasks = dedupedTasks.filter((t) => t.target !== currentThread.agentName);
      const executableTasks: FanOutTask[] = [];
      for (const task of filteredTasks) {
        if (task.type === 'tool') {
          // Tool tasks: always executable (tool executor handles unknown tool errors)
          executableTasks.push(task);
        } else {
          // lookupAgentForSession synthesizes remote targets from the active
          // agent's HANDOFF config — no ensureFanOutTargetRegistered side
          // effect is needed.
          const targetInfo = lookupAgentForSession(this.ctx, session, task.target);

          if (!targetInfo) {
            results.push({
              target: task.target,
              status: 'error',
              error: `Agent not found: ${task.target}`,
            });
          } else if (targetInfo.location === 'remote' && targetInfo.remote) {
            this.assertRemoteTargetSafe(targetInfo);
            executableTasks.push(task);
          } else if (targetInfo.ir) {
            executableTasks.push(task);
          } else {
            results.push({
              target: task.target,
              status: 'error',
              error: `Agent not found: ${task.target}`,
            });
          }
        }
      }

      // Separate tool tasks from agent tasks
      const agentTasks: FanOutTask[] = [];
      const toolTasks: FanOutTask[] = [];
      for (const task of executableTasks) {
        if (task.type === 'tool') {
          toolTasks.push(task);
        } else {
          agentTasks.push(task);
        }
      }

      // (R13) Emit trace event before early-return so the fan-out is always observable
      if (executableTasks.length === 0) {
        fanOutTraceEvent?.({
          type: 'fan_out_start',
          data: {
            taskCount: 0,
            targets: [],
            agentName: currentThread.agentName,
            abortReason: 'all_tasks_invalid',
            channel: session.callerContext?.channel || session.channelType,
          },
        });
        return { success: false, results, failedCount: results.length };
      }

      // --- Partition agent tasks into local and remote ---
      const localAgentTasks: FanOutTask[] = [];
      const remoteAgentTasks: FanOutTask[] = [];
      for (const task of agentTasks) {
        const targetInfo = lookupAgentForSession(this.ctx, session, task.target);
        if (targetInfo?.location === 'remote' && targetInfo.remote) {
          remoteAgentTasks.push(task);
        } else {
          localAgentTasks.push(task);
        }
      }

      if (remoteAgentTasks.length > 0 && !this.ctx.asyncInfra) {
        for (const remoteTask of remoteAgentTasks) {
          results.push({
            target: remoteTask.target,
            status: 'error',
            error: 'Async infrastructure unavailable for remote fan-out target',
          });
        }

        if (localAgentTasks.length === 0 && toolTasks.length === 0) {
          fanOutTraceEvent?.({
            type: 'fan_out_start',
            data: {
              taskCount: remoteAgentTasks.length,
              targets: remoteAgentTasks.map((task) => task.target),
              agentName: currentThread.agentName,
              abortReason: 'async_infra_unavailable',
              channel: session.callerContext?.channel || session.channelType,
            },
          });
          return {
            success: false,
            results,
            failedCount: results.filter((result) => result.status === 'error').length,
          };
        }
      }

      // --- Async fan-out: if remote agents present, use barrier-based coordination ---
      if (remoteAgentTasks.length > 0 && this.ctx.asyncInfra) {
        return this.handleAsyncFanOut(
          session,
          currentThread,
          localAgentTasks,
          remoteAgentTasks,
          toolTasks,
          results,
          childThreadRefs,
          executionId,
          onChunk,
          fanOutTraceEvent,
        );
      }

      // --- Build execution plan (all-local path) ---
      const timeoutMs = this.ctx.config.timeoutMs || 30000;
      const syncAgentTasks = remoteAgentTasks.length > 0 ? localAgentTasks : agentTasks;

      // (R12) Include callerContext in fan_out_start
      fanOutTraceEvent?.({
        type: 'fan_out_start',
        data: {
          taskCount: toolTasks.length + syncAgentTasks.length,
          targets: [...toolTasks, ...syncAgentTasks].map((t) => t.target),
          agentName: currentThread.agentName,
          channel: session.callerContext?.channel || session.channelType,
          identityTier: session.callerContext?.identityTier,
          toolTaskCount: toolTasks.length,
          agentTaskCount: syncAgentTasks.length,
        },
      });

      // --- Tool task execution function ---
      const executeToolTask = async (task: FanOutTask): Promise<SubTaskResult> => {
        const startTime = Date.now();

        fanOutTraceEvent?.({
          type: 'fan_out_task_start',
          data: {
            index: executableTasks.findIndex((t) => t.target === task.target && t.type === 'tool'),
            target: task.target,
            type: 'tool',
            intent: task.intent,
            agentName: currentThread.agentName,
          },
        });

        // Look up HTTP binding for method/endpoint/auth enrichment
        const toolDef = session.agentIR?.tools?.find((t) => t.name === task.target);
        const httpMeta =
          toolDef?.tool_type === 'http' && toolDef.http_binding
            ? buildHttpTraceMeta(toolDef.http_binding)
            : {};

        try {
          if (!session.toolExecutor) {
            throw new Error('No tool executor available on session');
          }
          // F-1: pass auditContext so audit emission happens inside the function
          const { value: executionParams } = restorePIITokensForToolExecution(
            session,
            task.params ?? {},
            {
              piiAccess: getToolPIIAccess(session, task.target),
              auditContext: {
                onTraceEvent: fanOutTraceEvent,
                toolName: task.target,
                agentId: session.agentName,
                sessionId: session.id,
                tenantId: session.tenantId,
                projectId: session.projectId,
              },
            },
          );
          const result = await session.toolExecutor.execute(
            task.target,
            executionParams as Record<string, unknown>,
            timeoutMs,
          );

          fanOutTraceEvent?.({
            type: 'tool_call',
            data: {
              toolName: task.target,
              params: task.params,
              status: 'success',
              durationMs: Date.now() - startTime,
              invocationType: 'fan_out',
              ...httpMeta,
            },
          });

          return {
            target: task.target,
            status: 'completed',
            response: typeof result === 'string' ? result : JSON.stringify(result),
          };
        } catch (err) {
          const errorMsg = err instanceof Error ? err.message : String(err);

          fanOutTraceEvent?.({
            type: 'tool_call',
            data: {
              toolName: task.target,
              params: task.params,
              status: 'error',
              error: errorMsg,
              durationMs: Date.now() - startTime,
              invocationType: 'fan_out',
              ...httpMeta,
            },
          });

          return {
            target: task.target,
            status: 'error',
            error: errorMsg,
          };
        }
      };

      // --- Agent execution plan (agent tasks only) ---
      const plan: ExecutionPlan = {
        type: 'parallel',
        units: syncAgentTasks.map((task) => ({
          agentName: task.target,
          message: task.intent,
          context: task.context,
          timeout: timeoutMs,
        })),
        timeout: timeoutMs * 2,
        onPartialFailure: 'continue',
      };

      // --- Prepare child threads for AGENT tasks only (R5: store object refs, not indices) ---
      for (const task of syncAgentTasks) {
        const targetInfo = lookupAgentForSession(this.ctx, session, task.target);
        if (!targetInfo) {
          throw new Error(`Agent not found: ${task.target}`);
        }
        const reusableThread = getReusableFanOutThread(task.target);

        if (reusableThread) {
          mergeFanOutContextIntoThread(reusableThread, task);
          childThreadRefs.set(task.target, reusableThread);
          fanOutTraceEvent?.({
            type: 'thread_resume',
            data: {
              agentName: task.target,
              invocationType: 'fan_out',
              from: currentThread.agentName,
              preservedHistoryLength: reusableThread.conversationHistory.length,
              preservedDataKeys: [...reusableThread.data.gatheredKeys],
            },
          });
          continue;
        }

        const childThread = createThread(session, task.target, targetInfo.ir, {
          handoffFrom: currentThread.agentName,
          initialData: {
            ...task.context,
            _fan_out_intent: task.intent,
            _fan_out_child: true,
            delegate_from: currentThread.agentName,
          },
        });
        primeFanOutChildThreadForImmediateInput(childThread, targetInfo.ir);
        childThreadRefs.set(task.target, childThread);
      }

      // --- Execute in parallel via ExecutionRuntime ---
      const executeUnit = async (
        unit: ExecutionUnit,
        signal: AbortSignal,
      ): Promise<ExecutionUnitResult> => {
        // (R5) Use stable object reference instead of index-based lookup
        const childThread = childThreadRefs.get(unit.agentName)!;
        const childIndex = session.threads.indexOf(childThread);
        const targetInfo = lookupAgentForSession(this.ctx, session, unit.agentName);
        if (!targetInfo?.ir) {
          throw new Error(`Agent ${unit.agentName} has no IR (not compiled)`);
        }

        // (R4) Compute childSessionId before emitting fan_out_task_start
        const childSessionId = `${session.id}__fanout__${executionId}__${unit.agentName}`;

        // Create isolated child session pointing to this child's thread
        const childSession = createChildSessionForFanOut(session, childIndex);
        childSession.id = childSessionId;

        await activateAgentExecutionContext({
          session: childSession,
          targetAgentName: unit.agentName,
          targetIR: targetInfo.ir,
          targetThread: childThread,
          authMode: 'fan_out',
          childSessionId,
          llmWiring: this.llmWiring,
          wireLLMClient: agentNeedsLLMWiring(targetInfo.ir),
          onTraceEvent: fanOutTraceEvent,
        });

        // (A1) Emit child session lifecycle event — created
        fanOutTraceEvent?.({
          type: 'fan_out_child_created',
          data: {
            childSessionId,
            agentName: unit.agentName,
            intent: unit.message,
          },
        });

        // (R9) Track semaphore wait time for observability
        const semaphoreWaitStart = Date.now();
        await this.fanOutSemaphore.acquire();
        const semaphoreWaitMs = Date.now() - semaphoreWaitStart;
        if (semaphoreWaitMs > 100) {
          log.debug('Fan-out semaphore acquired after wait', {
            executionId,
            target: unit.agentName,
            semaphoreWaitMs,
          });
        }

        // (R10) Capture startTime AFTER semaphore acquire so durationMs excludes queue time
        const startTime = Date.now();

        // (Gap2) Register child in global state INSIDE the cleanup-guarded try/finally
        // so unmarkExecuting/sessions.delete always run even if fanOutTraceEvent throws.
        this.ctx.markExecuting(childSessionId);
        this.ctx.sessions.set(childSessionId, childSession);

        // (Gap1) Track child execution outcome for fan_out_child_completed event
        let childOutcome: 'completed' | 'error' = 'completed';
        let childErrorMsg: string | undefined;

        // (R6+R7) Typed abort handler closure — no any casts
        let abortHandler: (() => void) | undefined;

        try {
          // (R4) Emit fan_out_task_start with childSessionId for correlation
          fanOutTraceEvent?.({
            type: 'fan_out_task_start',
            data: {
              ...buildDelegationTraceData({
                sourceAgent: currentThread.agentName,
                targetAgent: unit.agentName,
                invocationType: 'fan_out',
                parentSessionId: session.id,
                childSessionId,
                parentThreadIndex: session.activeThreadIndex,
                childThreadIndex: childIndex,
                message: unit.message,
                purpose: unit.message,
              }),
              childSessionId,
              index: executableTasks.findIndex((t) => t.target === unit.agentName),
              target: unit.agentName,
              intent: unit.message,
              agentName: currentThread.agentName,
              semaphoreWaitMs,
            },
          });

          // Emit agent:before lifecycle event for fan-out child
          await executeRecallForAgentEvent(
            childSession,
            unit.agentName,
            'before',
            fanOutTraceEvent,
          ).catch((err) => {
            log.warn('RECALL for agent:before failed during fan-out', {
              target: unit.agentName,
              error: err instanceof Error ? err.message : String(err),
            });
          });
          fanOutTraceEvent?.({
            type: 'agent_lifecycle',
            data: {
              agentName: unit.agentName,
              phase: 'before',
              invocationType: 'fan_out',
              from: currentThread.agentName,
              fromAgent: currentThread.agentName,
              sourceAgent: currentThread.agentName,
              targetAgent: unit.agentName,
              toAgent: unit.agentName,
              childSessionId,
            },
          });

          const abortPromise = new Promise<never>((_, reject) => {
            if (signal.aborted) {
              reject(new Error(`Fan-out to ${unit.agentName} timed out`));
              return;
            }
            abortHandler = () => reject(new Error(`Fan-out to ${unit.agentName} timed out`));
            signal.addEventListener('abort', abortHandler, { once: true });
          });

          // (R2) Capture raw promise and attach .catch() to prevent unhandled rejection
          // if abortPromise wins the race and executeMessage continues detached.
          const executePromise = this.ctx.executeMessage(
            childSessionId,
            unit.message,
            undefined,
            fanOutTraceEvent,
            {
              messageSource: 'fan_out',
              sourceAgent: currentThread.agentName,
              parentSessionId: session.id,
              parentThreadIndex: session.activeThreadIndex,
              childThreadIndex: childIndex,
            },
          );
          executePromise.catch((err) => {
            // Detached child execution failed after abort — benign post-pruning
            log.warn('Detached fan-out child execution failed after abort', {
              executionId,
              target: unit.agentName,
              error: err instanceof Error ? err.message : String(err),
            });
          });

          const result = await Promise.race([executePromise, abortPromise]);

          // Emit agent:after lifecycle event for fan-out child (success)
          await executeRecallForAgentEvent(
            childSession,
            unit.agentName,
            'after',
            fanOutTraceEvent,
          ).catch((err) => {
            log.warn('RECALL for agent:after failed during fan-out', {
              target: unit.agentName,
              error: err instanceof Error ? err.message : String(err),
            });
          });
          fanOutTraceEvent?.({
            type: 'agent_lifecycle',
            data: {
              agentName: unit.agentName,
              phase: 'after',
              invocationType: 'fan_out',
              from: currentThread.agentName,
              fromAgent: currentThread.agentName,
              sourceAgent: currentThread.agentName,
              targetAgent: unit.agentName,
              toAgent: unit.agentName,
              childSessionId,
            },
          });

          if (shouldKeepFanOutThreadWaiting(childSession, result)) {
            childThread.status = 'waiting';
            childThread.endedAt = undefined;
            childThread.pendingResponse = result.response;
          } else {
            childThread.status = 'completed';
            childThread.endedAt = Date.now();
          }

          return {
            agentName: unit.agentName,
            status: 'completed',
            response: result.response,
            gatheredData: Object.fromEntries(
              [...childThread.data.gatheredKeys].map((k) => [k, childThread.data.values[k]]),
            ),
            durationMs: Date.now() - startTime,
          };
        } catch (error) {
          childOutcome = 'error';
          childErrorMsg = error instanceof Error ? error.message : String(error);

          // Emit agent:after lifecycle event for fan-out child (error)
          await executeRecallForAgentEvent(
            childSession,
            unit.agentName,
            'after',
            fanOutTraceEvent,
          ).catch((err) => {
            log.warn('RECALL for agent:after failed during fan-out error path', {
              target: unit.agentName,
              error: err instanceof Error ? err.message : String(err),
            });
          });
          fanOutTraceEvent?.({
            type: 'agent_lifecycle',
            data: {
              agentName: unit.agentName,
              phase: 'after',
              invocationType: 'fan_out',
              from: currentThread.agentName,
              fromAgent: currentThread.agentName,
              sourceAgent: currentThread.agentName,
              targetAgent: unit.agentName,
              toAgent: unit.agentName,
              childSessionId,
              error: true,
            },
          });

          childThread.status = 'completed';
          childThread.endedAt = Date.now();

          // Sever shared references between childSession and childThread so the
          // still-running detached executeMessage (which holds childSession) cannot
          // corrupt the parent session's thread data via the shared reference chain.
          // createChildSession shares conversationHistory, state, and data by reference;
          // replacing them on childSession orphans the old objects for the detached execution.
          childSession.conversationHistory = [];
          childSession.state = { ...childSession.state } as typeof childSession.state;
          childSession.data = {
            values: {},
            gatheredKeys: new Set<string>(),
          };

          return {
            agentName: unit.agentName,
            status: 'error',
            error: childErrorMsg,
            durationMs: Date.now() - startTime,
          };
        } finally {
          // (R6) Remove abort listener on ALL paths (success, error, timeout)
          if (abortHandler) signal.removeEventListener('abort', abortHandler);
          this.fanOutSemaphore.release();

          // Critical cleanup FIRST — these must run unconditionally
          this.ctx.cancelPendingPersist(childSessionId);
          this.ctx.unmarkExecuting(childSessionId);
          // (A3) Clear LLM resolution cooldown to prevent _llmResolutionFailedSessions accumulation
          this.llmWiring.clearCooldown(childSessionId);
          this.ctx.sessions.delete(childSessionId);

          // (A1+Gap1) Emit child session lifecycle event AFTER cleanup —
          // wrapped in try/catch so a stringify/WebSocket failure cannot
          // prevent the critical cleanup above from completing.
          try {
            fanOutTraceEvent?.({
              type: 'fan_out_child_completed',
              data: {
                childSessionId,
                agentName: unit.agentName,
                status: childOutcome,
                error: childErrorMsg,
                durationMs: Date.now() - startTime,
              },
            });
          } catch (traceErr) {
            log.warn('Failed to emit fan_out_child_completed trace event', {
              childSessionId,
              error: traceErr instanceof Error ? traceErr.message : String(traceErr),
            });
          }
        }
      };

      // --- Execute ALL tasks (tool + agent) in parallel ---
      // Tool tasks run as direct tool executor calls (no child session, no LLM).
      // Agent tasks run via ExecutionRuntime with child sessions.
      // Both run concurrently in a single Promise.allSettled for maximum parallelism.

      const toolPromises = toolTasks.map((task) =>
        executeToolTask(task).then((r) => ({ type: 'tool' as const, result: r })),
      );

      let agentPromise: Promise<{
        type: 'agent';
        results: ExecutionUnitResult[];
      }> | null = null;

      if (agentTasks.length > 0) {
        // (I3) Use manual AbortController instead of AbortSignal.timeout for cleanup
        const planController = new AbortController();
        const planTimer = setTimeout(() => planController.abort('plan-timeout'), plan.timeout);

        agentPromise = this.executionRuntime
          .execute(plan, executeUnit, planController.signal)
          .then((agentResults) => ({
            type: 'agent' as const,
            results: agentResults,
          }))
          .finally(() => clearTimeout(planTimer));
      }

      // Await EVERYTHING concurrently — tools and agents run at the same time
      const allPromises = [
        ...toolPromises,
        ...(agentPromise
          ? [
              agentPromise.then(
                (a) =>
                  a as {
                    type: 'tool' | 'agent';
                    result?: SubTaskResult;
                    results?: ExecutionUnitResult[];
                  },
              ),
            ]
          : []),
      ];

      const settled = await Promise.allSettled(allPromises);

      // --- Map unified results ---
      for (const entry of settled) {
        if (entry.status === 'fulfilled') {
          const val = entry.value;
          if (val.type === 'tool' && val.result) {
            // Tool task: result is already a SubTaskResult
            const toolResult = val.result as SubTaskResult;
            results.push(toolResult);
            fanOutTraceEvent?.({
              type: 'fan_out_task_complete',
              data: {
                target: toolResult.target,
                type: 'tool',
                status: toolResult.status,
                error: toolResult.error,
                agentName: currentThread.agentName,
              },
            });
          } else if (val.type === 'agent' && val.results) {
            // Agent batch: map ExecutionUnitResult[] → SubTaskResult[]
            for (const er of val.results as ExecutionUnitResult[]) {
              results.push({
                target: er.agentName,
                status: er.status === 'completed' ? 'completed' : 'error',
                response: er.response,
                error: er.error,
                gatheredData: er.gatheredData,
              });

              fanOutTraceEvent?.({
                type: 'fan_out_task_complete',
                data: {
                  target: er.agentName,
                  type: 'agent',
                  status: er.status,
                  durationMs: er.durationMs,
                  error: er.error,
                  agentName: currentThread.agentName,
                },
              });
            }
          }
        } else {
          // Promise rejected — guard against unexpected failures
          results.push({
            target: 'unknown',
            status: 'error',
            error: entry.reason instanceof Error ? entry.reason.message : String(entry.reason),
          });
        }
      }

      // --- Store results ---
      const fanOutResult: FanOutResult = {
        success: results.some((r) => r.status === 'completed'),
        results,
        failedCount: results.filter((r) => r.status === 'error').length,
      };

      storeFanOutResultOnThread(currentThread, fanOutResult);

      // (A5) Fan-out results are NOT pushed to conversationHistory here.
      // They flow back to the LLM as the __fan_out__ tool result (via formatFanOutToolResult),
      // and the LLM's synthesized response becomes the authoritative assistant message.
      // Raw per-agent results remain accessible via _last_fan_out and _fan_out_result_{target}.

      // (I9) Single sync point after all result processing
      syncThreadToSession(session);

      // (R11) Include totalDurationMs in fan_out_complete
      fanOutTraceEvent?.({
        type: 'fan_out_complete',
        data: {
          taskCount: executableTasks.length,
          completedCount: results.filter((r) => r.status === 'completed').length,
          failedCount: fanOutResult.failedCount,
          agentName: currentThread.agentName,
          totalDurationMs: Date.now() - fanOutStartTime,
        },
      });

      return fanOutResult;
    } finally {
      // (Gap9) Always prune child threads — even if executionRuntime.execute() threw
      if (childThreadRefs.size > 0) {
        const preservedWaitingThreads = [...childThreadRefs.values()].filter(
          (thread) => thread.status === 'waiting',
        );
        const childThreadSet = new Set(
          [...childThreadRefs.values()].filter((thread) => thread.status !== 'waiting'),
        );
        session.threads = session.threads.filter((t) => !childThreadSet.has(t));

        // (R5) Re-resolve activeThreadIndex using parent thread reference
        const newParentIndex = session.threads.indexOf(parentThreadRef);
        if (newParentIndex >= 0) {
          session.activeThreadIndex = newParentIndex;
        } else {
          // (Issue3) parentThreadRef lost — log error and attempt name-based fallback
          log.error('Parent thread reference lost after fan-out pruning', {
            sessionId: session.id,
            parentAgent: parentThreadRef.agentName,
            remainingThreadCount: session.threads.length,
          });
          const fallbackIndex = session.threads.findIndex(
            (t) => t.agentName === parentThreadRef.agentName,
          );
          if (fallbackIndex >= 0) session.activeThreadIndex = fallbackIndex;
        }

        log.debug('Pruned fan-out child threads', {
          prunedCount: childThreadSet.size,
          preservedWaitingCount: preservedWaitingThreads.length,
          remainingThreadCount: session.threads.length,
        });
      }

      // (A4) Release the concurrent fan-out guard
      this._activeFanOutSessions.delete(session.id);
    }
  }

  // =============================================================================
  // COMPLETION CHECKING
  // =============================================================================

  /**
   * Check completion conditions and auto-complete if met
   */
  checkCompletionConditions(
    session: RuntimeSession,
    onChunk?: (chunk: string) => void,
    onTraceEvent?: (event: { type: string; data: Record<string, unknown> }) => void,
    callContext?: { source: string; currentStep?: string; nextStep?: string },
  ): ExecutionResult | null {
    const ir = session.agentIR;
    if (!ir?.completion?.conditions || ir.completion.conditions.length === 0) {
      return null;
    }

    const context = session.data.values;

    // Enrich context so dotted-path variables have null instead of missing
    // keys. This prevents CEL "No such key" errors while preserving
    // IS NOT SET / == null / || semantics.
    const guardedEvaluate = (expr: string, ctx: Record<string, unknown>) => {
      const enriched = enrichContextForNestedPaths(expr, ctx);
      return compilerEvaluateCondition(expr, enriched);
    };

    try {
      const detectorResult = this.completionDetector.check(ir, context, {
        evaluateCondition: guardedEvaluate,
        onCheck: (info) => {
          if (onTraceEvent) {
            onTraceEvent({
              type: 'completion_check',
              data: {
                condition: info.condition,
                result: info.passed,
                agent: session.agentName,
                context,
                ...(callContext?.source ? { source: callContext.source } : {}),
                ...(callContext?.currentStep ? { currentStep: callContext.currentStep } : {}),
                ...(callContext?.nextStep ? { nextStep: callContext.nextStep } : {}),
              },
            });
          }
        },
      });
      if (detectorResult.shouldComplete && detectorResult.matchedCondition) {
        const result = executeComplete(
          session,
          detectorResult.matchedCondition.respond,
          detectorResult.matchedCondition.store,
          onChunk,
          onTraceEvent,
          detectorResult.matchedCondition.voice_config,
          detectorResult.matchedCondition.rich_content,
          detectorResult.matchedCondition.actions,
        );
        tryThreadReturn(session, result, onTraceEvent);
        return result;
      }
    } catch (err) {
      log.error('CompletionDetector error in checkCompletionConditions', {
        agent: session.agentName,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    return null;
  }

  /**
   * Runtime-evaluated completion check (Option C).
   * Called after each reasoning turn.
   */
  checkAndMarkComplete(
    session: RuntimeSession,
    onTraceEvent?: (event: { type: string; data: Record<string, unknown> }) => void,
  ): boolean {
    const ir = session.agentIR;

    if (!ir) return false;

    // Enrich context so dotted-path variables have null instead of missing keys.
    const guardedEvaluate = (expr: string, ctx: Record<string, unknown>) => {
      const enriched = enrichContextForNestedPaths(expr, ctx);
      return compilerEvaluateCondition(expr, enriched);
    };

    try {
      const detectorResult = this.completionDetector.check(ir, session.data.values, {
        evaluateCondition: guardedEvaluate,
        onCheck: (info) => {
          if (onTraceEvent) {
            onTraceEvent({
              type: 'completion_check',
              data: {
                condition: info.condition,
                result: info.passed,
                agent: session.agentName,
                source: 'post_turn_eval',
                context: session.data.values,
              },
            });
          }
        },
      });
      if (detectorResult.shouldComplete && detectorResult.matchedCondition) {
        session.isComplete = true;
        session.state.conversationPhase = 'complete';
        if (detectorResult.matchedCondition.store) {
          session.data.values[`_stored_${detectorResult.matchedCondition.store}`] = {
            key: detectorResult.matchedCondition.store,
            value: { ...session.data.values },
            timestamp: new Date().toISOString(),
            sessionId: session.id,
            agentName: session.agentName,
          };
        }
        if (onTraceEvent) {
          onTraceEvent({
            type: 'decision',
            data: {
              type: 'auto_complete',
              agent: session.agentName,
              condition: detectorResult.matchedCondition.when,
              stored: detectorResult.matchedCondition.store,
            },
          });
        }
        return true;
      }
    } catch (err) {
      log.error('CompletionDetector error in checkAndMarkComplete', {
        agent: session.agentName,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    return false;
  }

  /**
   * Check handoff conditions before completing a scripted flow.
   */
  async checkHandoffConditions(
    session: RuntimeSession,
    onChunk?: (chunk: string) => void,
    onTraceEvent?: (event: { type: string; data: Record<string, unknown> }) => void,
  ): Promise<ExecutionResult | null> {
    const activeThread = getActiveThread(session);
    const ir = activeThread?.agentIR || session.agentIR;
    const handoffs = ir?.coordination?.handoffs;
    const routingCapabilities = resolveActiveRoutingCapabilities(ir ?? null);

    onTraceEvent?.({
      type: 'routing_capabilities_resolved',
      data: {
        agentName: activeThread?.agentName || session.agentName,
        handoffTargets: getValidHandoffTargets(routingCapabilities),
        delegateTargets: Array.from(routingCapabilities.delegateTargets),
        source: 'check_handoff_conditions',
      },
    });

    if (!handoffs || handoffs.length === 0) {
      return null;
    }

    const context = session.data.values;

    for (const handoff of handoffs) {
      if (!handoff.when) continue;

      const handoffDecisionId = createExecutionId();
      const matches = compilerEvaluateCondition(handoff.when, context);

      if (onTraceEvent) {
        onTraceEvent({
          type: 'handoff_condition_check',
          data: {
            agent: session.agentName,
            agentName: activeThread?.agentName || session.agentName,
            sourceAgent: activeThread?.agentName || session.agentName,
            target: handoff.to,
            targetAgent: handoff.to,
            condition: handoff.when,
            result: matches,
            decisionId: handoffDecisionId,
            reasonCode: matches ? 'handoff_condition_matched' : 'handoff_condition_skipped',
            parentThreadIndex: session.activeThreadIndex,
            context,
          },
        });
      }

      emitDecisionEvent(onTraceEvent, session.traceVerbosity, 'handoff', {
        outcome: matches ? handoff.to : `skip:${handoff.to}`,
        condition: handoff.when ?? 'always',
        matched: matches,
        candidates: handoffs.map((h: { to: string }) => h.to),
        selectedReason: matches ? 'first_match' : undefined,
        trigger: handoff.when
          ? Object.fromEntries(
              Object.entries(session.data.values).filter(([k]) => handoff.when?.includes(k)),
            )
          : undefined,
      });

      if (matches) {
        const passContext: Record<string, unknown> = {};
        if (handoff.context?.pass) {
          for (const passField of handoff.context.pass) {
            const fieldName = typeof passField === 'string' ? passField : passField.name;
            if (context[fieldName] !== undefined) {
              passContext[fieldName] = context[fieldName];
            }
          }
        }

        const handoffResult = await this.handleHandoff(
          session,
          { target: handoff.to, context: passContext, decisionId: handoffDecisionId },
          onChunk,
          onTraceEvent,
        );

        if (handoffResult.success) {
          return buildHandoffExecutionResult(session, handoff.to, handoffResult);
        }
      }
    }

    return null;
  }

  /**
   * Deterministic pre-routing for non-flow agent handoffs.
   *
   * Evaluates HANDOFF WHEN rules that do not depend on LLM-derived intent state
   * so scripted non-flow agents can route before entering the reasoning loop.
   */
  checkDeterministicHandoff(
    session: RuntimeSession,
  ): { to: string; when: string; return?: boolean } | null {
    const handoffs = session.agentIR?.coordination?.handoffs;
    if (!handoffs || handoffs.length === 0) return null;
    if (!session.data?.values) return null;

    for (const handoff of handoffs) {
      if (!handoff.when) continue;

      const vars = extractVariableReferences(handoff.when);
      const roots = vars.map((value) => value.split('.')[0]);
      if (roots.includes('intent')) continue;
      if (roots.includes('previous_system_message_was_offer')) continue;

      try {
        const enrichedCtx = enrichContextForNestedPaths(handoff.when, session.data.values);
        if (nullSafeEvaluateCondition(handoff.when, enrichedCtx)) {
          return {
            to: handoff.to,
            when: handoff.when,
            return: (handoff as unknown as { return?: boolean }).return,
          };
        }
      } catch {
        continue;
      }
    }

    return null;
  }

  /**
   * Deterministic pre-routing for supervisors.
   *
   * Evaluates routing rules in priority order BEFORE the LLM reasoning loop.
   * Rules whose WHEN conditions reference `intent` are skipped (LLM decides those).
   * Rules with literal `true` (fallback) are also skipped.
   *
   * Returns the first matching rule, or null if no deterministic guard matches.
   * This enforces the "priority cascade" pattern: validation gates and session
   * bootstrap rules fire before the LLM can choose an intent-based route.
   *
   * Note: Missing nested keys on existing objects are enriched with null
   * before evaluation to prevent CEL "No such key" errors while preserving
   * IS NOT SET / == null / || semantics.
   */
  checkDeterministicRouting(
    session: RuntimeSession,
  ): { to: string; when: string; priority: number; return?: boolean } | null {
    if (session.agentIR?.metadata?.type !== 'supervisor') return null;

    const rules = session.agentIR?.routing?.rules;
    if (!rules || rules.length === 0) return null;
    if (!session.data?.values) return null;

    const sorted = [...rules].sort((a, b) => (a.priority ?? Infinity) - (b.priority ?? Infinity));

    for (const rule of sorted) {
      if (!rule.when) continue;

      // Skip literal-true fallback rules
      if (rule.when.trim() === 'true') continue;

      // Skip intent-based rules — the LLM decides these.
      // extractVariableReferences returns dotted paths (e.g. "intent.category"),
      // so check root identifiers, not exact string match.
      const vars = extractVariableReferences(rule.when);
      const roots = vars.map((v) => v.split('.')[0]);
      if (roots.includes('intent')) continue;
      // Also skip rules that reference LLM-context vars
      if (roots.includes('previous_system_message_was_offer')) continue;

      // Enrich context so dotted-path variables have null instead of missing
      // keys, then evaluate with null-safe relational guards. This prevents
      // CEL "No such key" errors while preserving IS NOT SET / == null / ||
      // semantics. nullSafeEvaluateCondition additionally wraps relational
      // comparisons (< > <= >=) with null checks so `null < 80` returns
      // false instead of true (JS coerces null to 0).
      try {
        const enrichedCtx = enrichContextForNestedPaths(rule.when, session.data.values);
        const conditionMet = nullSafeEvaluateCondition(rule.when, enrichedCtx);
        if (conditionMet) {
          return { to: rule.to, when: rule.when, priority: rule.priority, return: rule.return };
        }
      } catch {
        // If evaluation throws (malformed expression), skip this rule
        continue;
      }
    }

    return null;
  }

  /**
   * Format fan-out results as a structured text summary for the LLM to synthesize.
   */
  formatFanOutToolResult(result: FanOutResult): {
    success: boolean;
    summary: string;
    results: SubTaskResult[];
  } {
    return formatFanOutToolResult(result);
  }

  // =============================================================================
  // MULTI-INTENT DISPATCH
  // =============================================================================

  /**
   * Handle a multi-intent detection result by resolving the appropriate strategy
   * and dispatching accordingly.
   *
   * Config resolution order (highest priority first):
   *   1. agent-level (DSL): agentIR.intent_handling?.multi_intent
   *   2. project-level (DB): agentIR.project_runtime_config?.multi_intent
   *   3. platform fallback: MULTI_INTENT_PLATFORM_DEFAULTS
   *
   * @param session    - The current runtime session
   * @param multiResult - The multi-intent detection result from the NLU layer
   * @param agentIR    - The agent's IR for config resolution
   * @param userMessage - The original user message (needed for intent queue entries)
   * @param onTraceEvent - Optional trace event callback
   * @returns Dispatch result describing what was done
   */
  handleMultiIntent(
    session: RuntimeSession,
    multiResult: MultiIntentResult,
    agentIR: AgentIR,
    userMessage: string,
    onTraceEvent?: (event: { type: string; data: Record<string, unknown> }) => void,
  ): MultiIntentDispatchResult {
    const detected = fromLegacyMultiIntentResult(multiResult, 'legacy');
    const config = resolveMultiIntentConfig(agentIR);
    const agentType = resolveAgentExecutionType(agentIR);
    const plan = resolveDetectedMultiIntentPlan({
      sessionId: session.id,
      agentName: session.agentName,
      agentIR,
      detected,
      userMessage,
      onTraceEvent,
      resolveMessage: buildLocalizedMessageResolver(session, agentIR),
    });

    if (onTraceEvent) {
      onTraceEvent({
        type: 'decision',
        data: {
          type: 'multi_intent_dispatch',
          agentName: session.agentName,
          declaredStrategy: config.strategy,
          effectiveStrategy: plan.strategy,
          agentType,
          relationship: multiResult.relationships.type,
          primaryIntent: multiResult.primary.intent,
          alternativeCount: multiResult.alternatives.length,
          alternatives: multiResult.alternatives.map((a) => ({
            intent: a.intent,
            confidence: a.confidence,
          })),
        },
      });
    }

    return applyResolvedMultiIntentPlan({
      session,
      plan,
      onTraceEvent,
    });
  }
}
// STANDALONE HELPER FUNCTIONS (no this. references)
// =============================================================================

/**
 * Filter session data to only include fields listed in escalation config's context_for_human.
 * If no fields are specified, returns minimal safe context (agent name, conversation turns).
 */
function filterEscalationContext(
  session: RuntimeSession,
  escalationConfig: { context_for_human: string[] },
): Record<string, unknown> {
  if (escalationConfig.context_for_human.length > 0) {
    const filtered: Record<string, unknown> = {};
    for (const field of escalationConfig.context_for_human) {
      if (field in session.data.values) {
        filtered[field] = session.data.values[field];
      }
    }
    return filtered;
  }
  return {
    agentName: session.agentName,
    conversationTurns: session.conversationHistory.length,
  };
}

/**
 * Find HandoffConfig from the session's agentIR coordination.handoffs[] by target agent name
 */
export function findHandoffConfig(
  session: RuntimeSession,
  targetAgent: string,
): HandoffConfig | undefined {
  const activeThread = getActiveThread(session);
  const ir = activeThread?.agentIR || session.agentIR;
  return ir?.coordination?.handoffs?.find((h: HandoffConfig) => h.to === targetAgent);
}

export interface A2AResponseOutput {
  text: string;
  richContent?: RichContentIR;
  actions?: ActionSetIR;
  voiceConfig?: VoiceConfigIR;
  responseMetadata?: ResponseMessageMetadata;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasStructuredA2AOutput(output: A2AResponseOutput): boolean {
  return Boolean(output.richContent || output.actions || output.voiceConfig);
}

function mergeStructuredDataPart(output: A2AResponseOutput, data: Record<string, unknown>): void {
  if (isRecord(data.richContent)) {
    output.richContent = data.richContent as RichContentIR;
  }
  if (isRecord(data.actions)) {
    output.actions = data.actions as unknown as ActionSetIR;
  }
  if (isRecord(data.voiceConfig)) {
    output.voiceConfig = data.voiceConfig as VoiceConfigIR;
  }
  if (isRecord(data.responseMetadata)) {
    output.responseMetadata = data.responseMetadata as ResponseMessageMetadata;
  }
}

function collectA2AParts(parts: unknown[] | undefined, output: A2AResponseOutput): void {
  if (!Array.isArray(parts)) {
    return;
  }

  const textParts: string[] = [];
  for (const part of parts) {
    if (!isRecord(part)) {
      continue;
    }
    if (part.kind === 'text' && typeof part.text === 'string') {
      textParts.push(part.text);
      continue;
    }
    if (part.kind === 'data' && isRecord(part.data)) {
      mergeStructuredDataPart(output, part.data);
    }
  }

  if (textParts.length > 0) {
    output.text = output.text ? `${output.text}\n${textParts.join('\n')}` : textParts.join('\n');
  }
}

/**
 * Extract consolidated text and structured payloads from an A2A SDK Task or Message result.
 *
 * For a Message: concatenates all text parts and preserves data parts.
 * For a Task: prefers the status message text, falls back to artifact text, and preserves
 * structured data from both locations so remote returns keep runtime parity with local returns.
 */
export function extractA2AResponseOutput(result: Task | Message): A2AResponseOutput {
  const output: A2AResponseOutput = { text: '' };

  if (result.kind === 'message') {
    collectA2AParts(result.parts, output);
    return output;
  }

  collectA2AParts(result.status?.message?.parts, output);

  if (!output.text) {
    for (const artifact of result.artifacts ?? []) {
      collectA2AParts(artifact.parts, output);
    }
  } else {
    for (const artifact of result.artifacts ?? []) {
      collectA2AParts(
        artifact.parts?.filter((part) => isRecord(part) && part.kind === 'data'),
        output,
      );
    }
  }

  return output;
}

function buildStructuredHandoffExecutionResult(output: A2AResponseOutput): ExecutionResult {
  return {
    response: output.text,
    action: { type: 'remote_handoff_return' },
    ...(output.richContent !== undefined ? { richContent: output.richContent } : {}),
    ...(output.actions !== undefined ? { actions: output.actions } : {}),
    ...(output.voiceConfig !== undefined ? { voiceConfig: output.voiceConfig } : {}),
    ...(output.responseMetadata !== undefined ? { responseMetadata: output.responseMetadata } : {}),
  };
}

export function buildStructuredHandoffAssistantMessage(
  session: RuntimeSession,
  output: A2AResponseOutput,
  options: { prefix?: string } = {},
) {
  const protectedText = protectSessionOutputForUser(session, output.text);
  const content =
    options.prefix && protectedText.historyText
      ? `${options.prefix}${protectedText.historyText}`
      : options.prefix
        ? options.prefix.trimEnd()
        : protectedText.historyText;
  const protectedStructured = protectStructuredOutputForUser(session, {
    richContent: output.richContent,
    actions: output.actions,
    voiceConfig: output.voiceConfig,
  });
  const contentEnvelope = hasStructuredA2AOutput(output)
    ? (createPersistedStructuredMessageEnvelope(content, {
        ...(protectedStructured.history.richContent !== undefined
          ? { richContent: protectedStructured.history.richContent }
          : {}),
        ...(protectedStructured.history.actions !== undefined
          ? { actions: protectedStructured.history.actions }
          : {}),
        ...(protectedStructured.history.voiceConfig !== undefined
          ? { voiceConfig: protectedStructured.history.voiceConfig }
          : {}),
      }) ?? undefined)
    : undefined;

  return {
    message: {
      role: 'assistant',
      content,
      ...(output.responseMetadata ? { metadata: output.responseMetadata } : {}),
      ...(contentEnvelope ? { contentEnvelope } : {}),
    },
    deliveryText: protectedText.deliveryText,
    historyText: protectedText.historyText,
    result: buildStructuredHandoffExecutionResult({
      ...output,
      richContent: protectedStructured.delivery.richContent,
      actions: protectedStructured.delivery.actions,
      voiceConfig: protectedStructured.delivery.voiceConfig,
    }),
  };
}

/**
 * Resolve concrete runtime history behavior with config hierarchy:
 * Handoff-level > Project-level > Platform default (`auto`)
 */
export function resolveHistoryStrategy(
  handoffConfig?: HandoffConfig,
  session?: RuntimeSession,
  options?: {
    targetSupportsSummaryOnly?: boolean;
  },
): HistoryStrategy {
  const projectDefaults = session?.compilationOutput?.coordination_defaults;
  const configuredStrategy =
    handoffConfig?.context?.history ??
    projectDefaults?.defaultHistoryStrategy ??
    DEFAULT_HANDOFF_HISTORY_STRATEGY;

  if (configuredStrategy !== 'auto') {
    return configuredStrategy;
  }

  const targetSupportsSummaryOnly = options?.targetSupportsSummaryOnly ?? true;
  if (handoffConfig?.context?.summary?.trim() && targetSupportsSummaryOnly) {
    return 'summary_only';
  }

  return {
    last_n: normalizeAutoHistoryFallbackLastN(projectDefaults?.autoHistoryFallbackLastN),
  };
}

function normalizeAutoHistoryFallbackLastN(value?: number): number {
  if (!Number.isInteger(value) || typeof value !== 'number' || value <= 0) {
    return DEFAULT_AUTO_HANDOFF_HISTORY_FALLBACK_LAST_N;
  }

  return value;
}

/**
 * Parse timeout string to milliseconds
 */
export function parseTimeout(timeout?: string): number | undefined {
  return parseTimeoutString(timeout);
}

/**
 * Map INPUT fields from context to delegate input.
 *
 * INPUT mappings use dot-path resolution only (e.g., "user.name").
 * CEL expressions are NOT supported in INPUT sources. If transformation
 * is needed, use SET before the DELEGATE to compute derived values,
 * then reference those computed values in INPUT.
 *
 * @example
 *   SET: formatted = abl.upper(user.name)
 *   DELEGATE: agent
 *     INPUT:
 *       name: formatted       // path reference to SET result
 */
export function mapDelegateInput(
  inputMapping: Record<string, string>,
  context: Record<string, unknown>,
): Record<string, unknown> {
  const mapped: Record<string, unknown> = {};

  for (const [targetKey, sourceExpr] of Object.entries(inputMapping)) {
    const value = resolveValuePath(sourceExpr, context);
    if (value !== undefined) {
      mapped[targetKey] = value;
    } else {
      log.warn('INPUT mapping resolved to undefined — field dropped from delegate input', {
        targetKey,
        sourceExpr,
        hint: 'If using CEL expressions, move computation to a SET step before DELEGATE',
      });
    }
  }

  return mapped;
}

const DELEGATE_CONTROL_INPUT_KEYS = new Set(['input', 'message', 'reason', 'target', 'thought']);

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function normalizeDelegateToolInput(input: Record<string, unknown>): {
  input?: Record<string, unknown>;
  hasExplicitInput: boolean;
} {
  if (isPlainRecord(input.input) && Object.keys(input.input).length > 0) {
    return { input: input.input, hasExplicitInput: true };
  }

  const topLevelInput = Object.fromEntries(
    Object.entries(input).filter(
      ([key, value]) => !DELEGATE_CONTROL_INPUT_KEYS.has(key) && value !== undefined,
    ),
  );

  if (Object.keys(topLevelInput).length > 0) {
    return { input: topLevelInput, hasExplicitInput: true };
  }

  return { hasExplicitInput: false };
}

function parseDelegateResponseData(response: unknown): unknown {
  if (typeof response !== 'string') {
    return response;
  }

  try {
    return JSON.parse(response);
  } catch {
    return response;
  }
}

function buildDelegateResultEnvelope(
  result: ExecutionResult,
  childSession?: Pick<RuntimeSession, 'data' | 'state'>,
): Record<string, unknown> {
  const responseData = parseDelegateResponseData(result.response);
  const childValues = childSession?.data?.values ? { ...childSession.data.values } : undefined;
  const envelope: Record<string, unknown> = {
    response: result.response,
    responseText: result.response,
    rawResponse: result.response,
    responseData,
    action: result.action,
  };

  if (isPlainRecord(responseData)) {
    Object.assign(envelope, responseData);
  }

  if (childValues) {
    envelope.values = childValues;
    envelope.data = {
      values: childValues,
      gatheredKeys: Array.from(childSession?.data?.gatheredKeys ?? []),
    };
  }

  if (childSession?.state) {
    envelope.state = { ...childSession.state };
  }

  if (result.stateUpdates) {
    envelope.stateUpdates = result.stateUpdates;
  }

  if (result.voiceConfig) {
    envelope.voiceConfig = result.voiceConfig;
  }

  if (result.richContent) {
    envelope.richContent = result.richContent;
  }

  if (result.actions) {
    envelope.actions = result.actions;
  }

  if (result.localization) {
    envelope.localization = result.localization;
  }

  if (result.responseMetadata) {
    envelope.responseMetadata = result.responseMetadata;
  }

  return envelope;
}

function resolveDelegateReturnValue(
  resultEnvelope: Record<string, unknown>,
  sourceKey: string,
): unknown {
  if (Object.prototype.hasOwnProperty.call(resultEnvelope, sourceKey)) {
    return resultEnvelope[sourceKey];
  }

  const directValue = resolveValuePath(sourceKey, resultEnvelope);
  if (directValue !== undefined) {
    return directValue;
  }

  const fallbackPaths = [
    `values.${sourceKey}`,
    `data.values.${sourceKey}`,
    `stateUpdates.context.${sourceKey}`,
    `stateUpdates.gatherProgress.${sourceKey}`,
  ];

  for (const path of fallbackPaths) {
    const [namespace, ...rest] = path.split('.');
    const namespaceValue = resultEnvelope[namespace];
    const literalKey = rest.join('.');
    if (
      isPlainRecord(namespaceValue) &&
      Object.prototype.hasOwnProperty.call(namespaceValue, literalKey)
    ) {
      return namespaceValue[literalKey];
    }

    const value = resolveValuePath(path, resultEnvelope);
    if (value !== undefined) {
      return value;
    }
  }

  return undefined;
}

/**
 * Map RETURNS fields from delegate result back to session context
 */
export function mapDelegateReturns(
  returnsMapping: Record<string, string>,
  result: ExecutionResult | Record<string, unknown>,
  session: RuntimeSession,
): void {
  const resultEnvelope =
    'rawResponse' in result || 'responseData' in result
      ? result
      : buildDelegateResultEnvelope(result as ExecutionResult);

  for (const [sourceKey, targetKey] of Object.entries(returnsMapping)) {
    const value = resolveDelegateReturnValue(resultEnvelope, sourceKey);
    if (value !== undefined) {
      session.data.values[targetKey] = value;
      session.data.gatheredKeys.add(targetKey);
    }
  }
}

/**
 * Handle delegate failure according to ON_FAILURE config
 */
export function handleDelegateFailure(
  session: RuntimeSession,
  delegateConfig: DelegateConfigIR | undefined,
  error: string,
  onChunk?: (chunk: string) => void,
  onTraceEvent?: (event: { type: string; data: Record<string, unknown> }) => void,
  traceContext?: {
    delegationId?: string;
    childSessionId?: string;
    parentThreadIndex?: number;
    childThreadIndex?: number;
    sourceAgent?: string;
    targetAgent?: string;
  },
): { success: boolean; result?: unknown; error?: string } {
  const delegateExperienceMode = resolveDelegateExperienceMode(delegateConfig);
  const delegateVisibility: CoordinationVisibility = 'internal';
  if (onTraceEvent) {
    onTraceEvent({
      type: 'delegate_complete',
      data: {
        ...buildDelegationTraceData({
          sourceAgent: traceContext?.sourceAgent ?? session.agentName,
          targetAgent: traceContext?.targetAgent ?? delegateConfig?.agent,
          invocationType: 'delegate',
          delegationId: traceContext?.delegationId,
          parentSessionId: session.id,
          childSessionId: traceContext?.childSessionId,
          parentThreadIndex: traceContext?.parentThreadIndex,
          childThreadIndex: traceContext?.childThreadIndex,
          error,
          success: false,
          experienceMode: delegateExperienceMode,
          visibility: delegateVisibility,
          suppressChildOutput: true,
        }),
        success: false,
        error,
      },
    });
  }

  const onFailure = delegateConfig?.on_failure || 'continue';

  switch (onFailure) {
    case 'respond': {
      const message = delegateConfig?.failure_message || `Unable to complete request: ${error}`;
      const protectedMessage = emitProtectedAssistantMessage(session, message, {
        onChunk,
        historyTarget: session.conversationHistory as Array<{
          role: string;
          content: string;
          metadata?: Record<string, unknown>;
        }>,
      });
      return { success: false, error, result: protectedMessage.deliveryText };
    }

    case 'escalate': {
      session.isEscalated = true;
      session.escalationReason = `Delegate failed: ${error}`;
      return { success: false, error };
    }

    case 'continue':
    default:
      return { success: false, error };
  }
}

/**
 * Handle handoff failure according to ON_FAILURE config.
 * Applies only to parent-owned setup/dispatch failures before the child
 * handoff is considered accepted.
 */
export function handleHandoffFailure(
  session: RuntimeSession,
  handoffConfig: HandoffConfig | undefined,
  error: string,
  phase: 'setup' | 'dispatch',
  onChunk?: (chunk: string) => void,
  onTraceEvent?: (event: { type: string; data: Record<string, unknown> }) => void,
): { success: boolean; response?: string; error?: string } {
  const activeThread = getActiveThread(session);
  const fromAgent = activeThread?.agentName ?? session.agentName;
  const targetAgent = handoffConfig?.to;
  const onFailure = handoffConfig?.on_failure || 'continue';

  onTraceEvent?.({
    type: 'handoff_failure',
    data: {
      from: fromAgent,
      to: targetAgent,
      phase,
      action: onFailure,
      error,
    },
  });

  switch (onFailure) {
    case 'respond': {
      const message =
        handoffConfig?.failure_message ||
        `Unable to hand off to ${targetAgent ?? 'the requested agent'}: ${error}`;
      const historyTarget = activeThread?.conversationHistory ?? session.conversationHistory;
      const protectedMessage = emitProtectedAssistantMessage(session, message, {
        onChunk,
        historyTarget: historyTarget as Array<{
          role: string;
          content: string;
          metadata?: Record<string, unknown>;
        }>,
      });
      if (activeThread) {
        syncThreadToSession(session);
      }
      return { success: false, response: protectedMessage.deliveryText, error };
    }

    case 'escalate': {
      session.isEscalated = true;
      session.escalationReason = `Handoff failed during ${phase}: ${error}`;
      return { success: false, error };
    }

    case 'continue':
    default:
      return { success: false, error };
  }
}

/**
 * Deduplicate fan-out tasks by target agent.
 */
export function deduplicateFanOutTasks(tasks: FanOutTask[]): FanOutTask[] {
  const seen = new Map<string, FanOutTask>();
  for (const task of tasks) {
    // Use target + type as dedup key so tool and agent with same name aren't merged
    const dedupKey = `${task.type ?? 'agent'}:${task.target}`;
    const existing = seen.get(dedupKey);
    if (existing) {
      existing.intent = `${existing.intent}; ${task.intent}`;
      if (task.context) {
        existing.context = { ...existing.context, ...task.context };
      }
      if (task.params) {
        existing.params = { ...existing.params, ...task.params };
      }
    } else {
      seen.set(dedupKey, { ...task });
    }
  }
  return Array.from(seen.values());
}

/**
 * Format fan-out results as a structured text summary for the LLM to synthesize.
 */
export function formatFanOutToolResult(result: FanOutResult): {
  success: boolean;
  summary: string;
  results: SubTaskResult[];
} {
  const lines: string[] = [];
  lines.push(
    `Fan-out completed: ${result.results.length - result.failedCount}/${result.results.length} tasks succeeded.`,
  );
  lines.push('');
  for (const r of result.results) {
    if (r.status === 'completed') {
      lines.push(`[${r.target}] SUCCESS: ${r.response}`);
    } else {
      lines.push(`[${r.target}] FAILED: ${r.error}`);
    }
  }
  lines.push('');
  lines.push('## Synthesis Instructions');
  lines.push(
    '1. Lead with the most relevant result — prioritize actionable information over supplementary details.',
  );
  lines.push(
    '2. If results conflict, note the discrepancy factually. Do not silently pick one version.',
  );
  if (result.failedCount > 0) {
    lines.push(
      '3. For failed tasks, briefly explain what could not be completed in user-friendly language. ' +
        'Say "I wasn\'t able to [X] right now" rather than exposing internal errors.',
    );
    lines.push(
      '4. Produce a single cohesive response. ' +
        'Do NOT list results per-agent or reveal that multiple specialists were involved.',
    );
  } else {
    lines.push(
      '3. Produce a single cohesive response. ' +
        'Do NOT list results per-agent or reveal that multiple specialists were involved.',
    );
  }
  return {
    success: result.success,
    summary: lines.join('\n'),
    results: result.results,
  };
}

/**
 * Execute completion with STORE support
 */
export function executeComplete(
  session: RuntimeSession,
  message?: string,
  storeKey?: string,
  onChunk?: (chunk: string) => void,
  onTraceEvent?: (event: { type: string; data: Record<string, unknown> }) => void,
  voiceConfig?: VoiceConfigIR,
  richContent?: import('@abl/compiler').RichContentIR,
  actions?: ActionSetIR,
): ExecutionResult {
  session.isComplete = true;
  session.state.conversationPhase = 'complete';

  const context = session.data.values;
  const localizedCompletion =
    message === undefined || message === null
      ? resolveLocalizedAgentMessageWithMetadata({
          session,
          messageKey: 'conversation_complete',
          fallbackMessage:
            session.agentIR?.messages?.conversation_complete ||
            DEFAULT_MESSAGES.conversation_complete,
        })
      : null;

  const completionMessage =
    message !== undefined && message !== null
      ? interpolateTemplate(message, context)
      : (localizedCompletion?.text ?? '');

  if (storeKey) {
    const storedData = {
      key: storeKey,
      value: context,
      timestamp: new Date().toISOString(),
      sessionId: session.id,
      agentName: session.agentName,
    };

    log.debug('Storing completion data', { storeKey });
    session.data.values[`_stored_${storeKey}`] = storedData;

    if (onTraceEvent) {
      onTraceEvent({
        type: 'data_stored',
        data: {
          key: storeKey,
          agent: session.agentName,
          sessionId: session.id,
        },
      });
    }
  }

  if (onTraceEvent) {
    onTraceEvent({
      type: 'decision',
      data: {
        type: 'complete',
        message: completionMessage || '(silent)',
        stored: storeKey,
        agent: session.agentName,
      },
    });
  }

  const completionResult: ExecutionResult = {
    response: completionMessage,
    action: { type: 'complete', message: completionMessage, stored: storeKey },
    voiceConfig: voiceConfig ? interpolateVoiceConfig(voiceConfig, session.data.values) : undefined,
    richContent: richContent ? interpolateRichContent(richContent, session.data.values) : undefined,
    actions: actions ? interpolateActionSet(actions, session.data.values) : undefined,
    localization: localizedCompletion?.localization,
  };

  if (
    completionResult.response ||
    completionResult.voiceConfig ||
    completionResult.richContent ||
    completionResult.actions
  ) {
    return emitProtectedExecutionResult(session, completionResult, onChunk).result;
  }

  return completionResult;
}
