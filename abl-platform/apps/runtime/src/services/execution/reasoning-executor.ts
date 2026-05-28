/**
 * Reasoning Executor
 *
 * Handles reasoning-mode (tool-use agentic loop) execution:
 * - Multi-turn LLM ↔ tool loop with configurable iteration limits
 * - System tool dispatch (handoff, delegate, fan-out, escalate, complete)
 * - Regular tool execution via session's ToolExecutor
 * - Entity extraction for reasoning-mode GATHER fields
 * - Post-extraction constraint checking
 *
 * Extracted from RuntimeExecutor to isolate the reasoning execution path
 * from session management and lifecycle orchestration.
 */

import { randomUUID } from 'crypto';
import type { LanguageModel } from 'ai';
import {
  SYSTEM_TOOL_HANDOFF,
  SYSTEM_TOOL_DELEGATE,
  SYSTEM_TOOL_COMPLETE,
  SYSTEM_TOOL_ESCALATE,
  SYSTEM_TOOL_FAN_OUT,
  SYSTEM_TOOL_SET_CONTEXT,
  SYSTEM_TOOL_RETURN_TO_PARENT,
  CONSTRAINT_CHECKPOINT_KIND_KEY,
  DEFAULT_MESSAGES,
  extractVariableReferences,
} from '@abl/compiler';
import type { AgentIR } from '@abl/compiler';
import { createLogger } from '@abl/compiler/platform';
import { getCurrentTraceId } from '@abl/compiler/platform/observability';
import type { GatherField } from '@abl/compiler';
import { checkGatherComplete, validateField } from '@abl/compiler/platform/constructs/utils.js';
import { shouldSkipExtraction } from './gather-utils.js';
import {
  validateExtractedBatch,
  normalizeEnumValue,
  type DateNormalizationOptions,
} from './extraction-validation.js';
import { getModelCapabilities, calculateCost, hasKnownPricing } from '../llm/model-router.js';
import type {
  ToolResultContent,
  ContentBlock,
  TextContent,
} from '@abl/compiler/platform/llm/types.js';
import { AppError, ErrorCodes } from '@agent-platform/shared-kernel';
import { formatErrorSync } from '@agent-platform/i18n';

const log = createLogger('reasoning-executor');

import {
  createGuardrailPipeline,
  createLLMEvalFromClient,
  ensureTenantProvidersLoaded,
} from '../guardrails/pipeline-factory.js';

import { getSessionGuardrailCacheScopeKey, getSessionPolicy } from './session-policy.js';
import { compressToolResult, summarizeToolResult } from './tool-result-compressor.js';
import { DEFAULT_COMPACTION_POLICY, resolveCompactionPolicy } from './compaction-policy.js';
import type { CompactionPolicy } from '@abl/compiler/platform/ir/schema.js';

import type {
  ToolDefinition,
  ToolCall,
  Message,
  ChatProviderErrorResult,
  ChatResult,
} from '../llm/session-llm-client.js';
import { TRACE_MODEL_UNKNOWN } from '../llm/session-llm-client.js';
import {
  buildSimpleClassifyPrompt,
  buildVocabClassifyPromptMulti,
  parseClassifyPlan,
} from '../search-ai/description-builder.js';

import {
  setGatheredValues,
  deleteSessionValue,
  buildStateUpdates,
  buildFailedHandoffExecutionResult,
  buildHandoffExecutionResult,
  getActiveThread,
} from './types.js';
import type {
  RuntimeSession,
  ExecutionResult,
  ExecutionOutputMessage,
  ExecutorContext,
  FanOutTask,
} from './types.js';
import {
  applyScopedMemoryWrite,
  getWritableExecutionTreePaths,
  getWritableGrantedMemoryKeys,
} from './memory-scope-runtime.js';
import {
  getCurrentInteractionParsingLocale,
  getCurrentInteractionTimezone,
  readSessionInteractionState,
} from './interaction-context.js';
import {
  mergeProfileInteractionContextInputs,
  readProfileInteractionContextFromSessionData,
} from './profile-resolver.js';
import {
  buildLocalizedMessageResolver,
  ensureRuntimeSessionDataStore,
  resolveLocalizedAgentMessage,
  resolveLocalizedErrorHandlerResponseWithMetadata,
} from './localized-messages.js';
import { buildConversationBehaviorTraceSummary } from './conversation-behavior-resolver.js';

import {
  checkFlatConstraints,
  checkFlatConstraintsAtCheckpoint,
  executeConstraintViolation,
  getConstraintFieldsToClear,
  setCurrentTurnInputContext,
} from './constraint-checker.js';
import { resolveErrorHandler, executeWithRetry } from './error-handler-router.js';
import type { ErrorContext } from './error-handler-router.js';
import {
  isVoiceChannel,
  buildSystemPrompt,
  buildTools,
  getReasoningZoneSettableContextVars,
} from './prompt-builder.js';
import { preparePreTurnExecutionView } from './pre-turn-execution-view.js';
import { getNestedValue, interpolateTemplate, resolveSetValue } from './value-resolution.js';
import { mergeSessionDimensions } from '../metadata/custom-dimensions.js';
import { stripForVoice } from '../channel/channel-adapter.js';
import {
  evaluateRememberAfterStateChange,
  executeRecallAfterToolCall,
  executeRecallAfterExtraction,
  detectAndStorePreferences,
} from './memory-integration.js';
import { recordToolCall } from '../../observability/metrics.js';
import { checkOutputGuardrails } from './output-guardrails.js';
import {
  getLlmOperatorDiagnostic,
  isLlmError,
  deriveLlmErrorSubtype,
  buildContentFilterAppError,
} from '../llm/classify-llm-error.js';
import { buildRuntimeErrorEnvelope, type RuntimeErrorEnvelope } from './runtime-error-envelope.js';
import { shouldExecuteReask, executeReaskLoop } from './reask-executor.js';
import { emitDecisionEvent, buildHttpTraceMeta } from './trace-helpers.js';
import {
  shouldRequireConfirmation,
  createSnapshot,
  validateImmutability,
  isSnapshotExpired,
  formatConfirmationMessage,
  evaluateConversationConsent,
  shouldBlockForMissingConversationConsent,
} from './tool-confirmation.js';
import type { CompactionEngine } from '../session/compaction-engine.js';
import { filterOutputPII } from './output-pii-filter.js';
import { renderTextForLLMWithPIIRedaction } from './pii-llm-redaction.js';
import { flushAndClearSessionPIIVault } from '../pii/pii-token-vault-service.js';
import { refreshSessionPIIContext } from '../pii/session-pii-context.js';
import {
  emitProtectedExecutionResult,
  protectSessionOutputForUser,
  protectStructuredOutputForUser,
} from './session-output-protection.js';
import {
  getToolPIIAccess,
  restorePIITokensForToolExecution,
  restorePIITokensForTrustedInternalExecution,
  restorePIITokensForTrustedInternalExecutionText,
} from './pii-tool-execution.js';
import { cleanupTransientFields } from './transient-cleanup.js';
import { getPIIAuditLogger } from './pii-audit-singleton.js';
import {
  classifyExecutionConfigurationDiagnostic,
  getToolExecutionErrorMetadata,
} from './configuration-diagnostics.js';
import type { ExecutionConfigurationDiagnostic } from './configuration-diagnostics.js';
import { isAttachmentTool } from '../../tools/attachment-tool-executor.js';
import { classifyToolError } from './tool-error-classifier.js';

import { extractEntityObservations } from './entity-pipeline.js';
import { createObservationSet } from './entity-observations.js';
import { traceEntityObservation, traceIntrinsicValidation } from './entity-trace-events.js';
import {
  traceToolBlocked,
  traceToolOutputBlocked,
  tracePipelineError,
} from '../guardrails/trace-events.js';
import { maskSensitiveValue } from './entity-observations.js';

import type { RoutingExecutor } from './routing-executor.js';
import { FlowStepExecutor } from './flow-step-executor.js';
import { validateWithLookupTables } from './flow-step-executor.js';
import type { LookupContext } from './lookup-resolver.js';
import { mergeLookupTables } from './lookup-table-merger.js';
import {
  classify,
  shouldShortCircuit,
  filterTools,
  resolveRouting,
  bridgeIntentsToSessionState,
  bridgeToDetectedMultiIntent,
  resolveHighConfidenceMultiIntentMode,
  resolveTieredAction,
  resolvePipelineConfig,
  resolvePipelineModel,
  mergeResponses,
  extractToolNames,
  resolveClassifierRuntimeContext,
  shouldRunPipelineClassifier,
} from '../pipeline/index.js';
import type { AgentScopeContext } from '../pipeline/index.js';
import type { IntentCategory } from '@abl/compiler/platform/ir/schema.js';
import type { ClassifierResult, OnTraceEvent, ToolFilterResult } from '../pipeline/types.js';
import {
  isPipelineCircuitOpen,
  recordPipelineSuccess,
  recordPipelineFailure,
} from '../pipeline/circuit-breaker.js';
import { resolveMultiIntentConfig } from './multi-intent/multi-intent-types.js';
import {
  applyResolvedMultiIntentPlan,
  buildSupervisorRoutingToolFanOutPlan,
  filterDetectedMultiIntentAlternatives,
  resolveDetectedMultiIntentPlan,
} from './multi-intent/multi-intent-router.js';
import {
  buildSequentialMultiIntentTasks,
  executeSequentialMultiIntentPlan,
} from './multi-intent/sequential-executor.js';

// =============================================================================
// CONSTANTS
// =============================================================================

/** Default max tool iterations when not specified in agent IR */
const DEFAULT_MAX_TOOL_ITERATIONS = 10;

/** Break the loop after this many consecutive empty LLM responses */
const MAX_CONSECUTIVE_EMPTY_RESPONSES = 2;

const SUPERVISOR_ROUTING_REPAIR_MAX_RETRIES = 1;

function isLlmProviderErrorResult(result: ChatResult): result is ChatProviderErrorResult {
  return result.kind === 'provider_error' || result.stopReason.trim().toLowerCase() === 'error';
}

function buildLlmProviderResultError(result: ChatResult): AppError {
  const provider =
    result.kind === 'provider_error'
      ? (result.providerError.provider ?? result.resolvedModel?.provider ?? 'unknown')
      : (result.resolvedModel?.provider ?? 'unknown');
  const modelId =
    result.kind === 'provider_error'
      ? (result.providerError.modelId ?? result.resolvedModel?.modelId ?? TRACE_MODEL_UNKNOWN)
      : (result.resolvedModel?.modelId ?? TRACE_MODEL_UNKNOWN);
  const stopReason =
    result.kind === 'provider_error' ? result.providerError.stopReason : result.stopReason;

  // Output-side content-filter: use MODEL_CONTENT_FILTERED so the downstream
  // catch block can derive the correct errorCtx.type and subtype for
  // agent-level error handlers. Attach a structured diagnostic so
  // getLlmOperatorDiagnostic returns data for the agent_error_handled trace.
  if (
    result.kind === 'provider_error' &&
    result.providerError.code === 'LLM_PROVIDER_CONTENT_FILTERED'
  ) {
    return buildContentFilterAppError(result.providerError.stopReason);
  }

  return new AppError(
    `LLM provider returned stopReason "${stopReason}" for provider "${provider}" and model "${modelId}".`,
    { ...ErrorCodes.SERVICE_UNAVAILABLE },
  );
}

/**
 * Tight per-call timeout for the KB fast-path classify LLM call.
 *
 * The classifier is a small model running a short prompt and is expected to
 * complete well under 1s; 2500ms is a defensive cap that still returns long
 * before the global `LLM_CALL_TIMEOUT_MS` (~60s) would fire. On timeout, the
 * try/catch around the call degrades gracefully to the normal search path,
 * so a hung upstream never stalls the whole turn.
 */
const KB_CLASSIFY_TIMEOUT_MS = 2500;

/** Citation instruction appended to system prompts when citations are enabled. */
const CITATION_INSTRUCTION =
  ' IMPORTANT: When using information from search results, cite the source by including ' +
  'the result number in square brackets, like [1], [2], etc. Always cite your sources. ' +
  'Only cite results that are DIRECTLY relevant to the specific question asked. ' +
  'If a result mentions a different person, entity, or topic than what was asked about, do NOT cite it. ' +
  'Quality over quantity — fewer accurate citations are better than many irrelevant ones.';

function stripObservabilityFieldsFromRegularToolInput(
  input: Record<string, unknown>,
  toolDef?: { parameters?: Array<{ name: string }> },
): {
  cleanInput: Record<string, unknown>;
  thought?: unknown;
  reason?: unknown;
} {
  const declaredParamNames = new Set(toolDef?.parameters?.map((parameter) => parameter.name) ?? []);
  const cleanInput = { ...input };

  let thought: unknown;
  if (!declaredParamNames.has('thought') && 'thought' in cleanInput) {
    thought = cleanInput.thought;
    delete cleanInput.thought;
  }

  let reason: unknown;
  if (!declaredParamNames.has('reason') && 'reason' in cleanInput) {
    reason = cleanInput.reason;
    delete cleanInput.reason;
  }

  return { cleanInput, thought, reason };
}

function getLatestUserText(session: RuntimeSession): string | undefined {
  const lastUserContent = session.conversationHistory
    .filter((message) => message.role === 'user')
    .pop()?.content;

  return typeof lastUserContent === 'string'
    ? lastUserContent
    : Array.isArray(lastUserContent)
      ? (lastUserContent.find((block): block is TextContent => block.type === 'text')?.text ??
        undefined)
      : undefined;
}

function resolveCurrentTurnInput(session: RuntimeSession): string | undefined {
  const stampedInput = session.data.values['input'];
  if (typeof stampedInput === 'string' && stampedInput.trim() !== '') {
    return stampedInput;
  }

  return getLatestUserText(session);
}

function resolveCurrentTurnRawInput(
  session: RuntimeSession,
  currentTurnInput: string | undefined,
): string | undefined {
  const stampedRawInput = session.data.values['_raw_input'];
  if (typeof stampedRawInput === 'string' && stampedRawInput.trim() !== '') {
    return stampedRawInput;
  }

  return currentTurnInput;
}

async function applyLookupValidationToExtractedValues(
  session: RuntimeSession,
  extractedValues: Record<string, unknown>,
  gatherFields: GatherField[],
  onTraceEvent?: OnTraceEvent,
): Promise<Record<string, string>> {
  if (Object.keys(extractedValues).length === 0) {
    return {};
  }

  const mergedLookup = mergeLookupTables(
    session.agentIR?.lookup_tables,
    session._projectRuntimeConfig,
  );
  if (Object.keys(mergedLookup).length === 0) {
    return {};
  }

  const lookupFields = gatherFields.filter(
    (field) =>
      field.semantics?.lookup &&
      Object.prototype.hasOwnProperty.call(extractedValues, field.name) &&
      extractedValues[field.name] !== undefined &&
      extractedValues[field.name] !== null &&
      extractedValues[field.name] !== '',
  );
  if (lookupFields.length === 0) {
    return {};
  }

  const rawValues = { ...extractedValues };
  const lookupContext: LookupContext = {
    tenantId: session.tenantId ?? '',
    projectId: session.projectId ?? '',
  };
  const { errors, fuzzyMatches } = await validateWithLookupTables(
    extractedValues,
    lookupFields,
    mergedLookup,
    lookupContext,
  );

  const normalizedErrors: Record<string, string> = { ...errors };
  for (const fieldName of Object.keys(errors)) {
    delete extractedValues[fieldName];
  }

  for (const [fieldName, match] of Object.entries(fuzzyMatches)) {
    const rawValue = rawValues[fieldName];
    normalizedErrors[fieldName] =
      `Value "${String(rawValue)}" is close to "${match.suggested}" for ${fieldName}. ` +
      'Please confirm or provide the exact value.';
    delete extractedValues[fieldName];
  }

  if (onTraceEvent && Object.keys(normalizedErrors).length > 0) {
    onTraceEvent({
      type: 'lookup_validation_failed',
      data: {
        agentName: session.agentName,
        stepName: session.currentFlowStep,
        errors: normalizedErrors,
        mode: 'inline_gather',
        ...(Object.keys(fuzzyMatches).length > 0 ? { fuzzyMatches } : {}),
      },
    });
  }

  return normalizedErrors;
}

function resolveSupervisorParallelRoutingPolicy(session: RuntimeSession): {
  enabled: boolean;
  multiIntentEnabled: boolean;
  strategy: string | null;
} {
  const agentIR = session.agentIR;
  if (!agentIR || agentIR.metadata?.type !== 'supervisor') {
    return {
      enabled: false,
      multiIntentEnabled: false,
      strategy: null,
    };
  }

  const config = resolveMultiIntentConfig(agentIR);
  return {
    enabled: config.enabled && (config.strategy === 'parallel' || config.strategy === 'auto'),
    multiIntentEnabled: config.enabled,
    strategy: config.strategy,
  };
}

function shouldRepairSupervisorRoutingTurn(params: {
  session: RuntimeSession;
  tools: ToolDefinition[];
  userMessage: string | undefined;
  responseText?: string | undefined;
}): boolean {
  if (params.session.agentIR?.metadata?.type !== 'supervisor') return false;
  if (!params.tools.some((tool) => tool.name.startsWith('handoff_to_'))) return false;

  const userMessage = params.userMessage?.trim();
  if (!userMessage) return false;

  const responseText = params.responseText?.trim();
  if (responseText && isLikelyUserFacingQuestion(responseText)) return false;

  return true;
}

function isLikelyUserFacingQuestion(text: string): boolean {
  const normalized = text.trim().toLowerCase();
  const startsWithQuestionWord = /^(clarify|confirm|which|what|who|when|where|how)\b/.test(
    normalized,
  );
  const asksForPrerequisite =
    /\b(may i have|could you|can you|please provide|please share|please tell|provide your|share your|tell me|tell us|need to know|need your)\b/.test(
      normalized,
    );
  return normalized.includes('?') || startsWithQuestionWord || asksForPrerequisite;
}

function isSupervisorRoutingToolName(name: string): boolean {
  return (
    name === SYSTEM_TOOL_HANDOFF ||
    name === SYSTEM_TOOL_DELEGATE ||
    name === SYSTEM_TOOL_FAN_OUT ||
    name.startsWith('handoff_to_') ||
    name.startsWith('delegate_to_')
  );
}

function shouldForceSupervisorRoutingToolChoice(
  isSupervisor: boolean,
  tools: ToolDefinition[],
): boolean {
  return (
    isSupervisor &&
    tools.length > 0 &&
    tools.every((tool) => isSupervisorRoutingToolName(tool.name))
  );
}

const PLACEHOLDER_SESSION_MEMORY_VALUES = new Set([
  'unknown',
  'n/a',
  'na',
  'none',
  'null',
  'undefined',
  'not provided',
  'not available',
  'unavailable',
  'tbd',
  'to be determined',
  '?',
  '-',
]);

function isPlaceholderSessionMemoryValue(value: unknown): boolean {
  return (
    typeof value === 'string' && PLACEHOLDER_SESSION_MEMORY_VALUES.has(value.trim().toLowerCase())
  );
}

function shouldRedactRawOutputPII(session: RuntimeSession): boolean {
  return (
    session.piiRedactionConfig?.enabled === true && session.piiRedactionConfig.redactOutput === true
  );
}

function buildSupervisorRoutingRepairPrompt(tools: ToolDefinition[]): string {
  const targets = tools
    .filter((tool) => tool.name.startsWith('handoff_to_'))
    .map((tool) => tool.name)
    .join(', ');

  return [
    '## Routing correction',
    'The previous response did not route this actionable user request.',
    `Call exactly one of these routing tools now: ${targets}.`,
    'If none of those tools fits, ask one concise clarification question instead of completing or answering directly.',
  ].join('\n');
}

interface UserMessageLike {
  role: string;
  content: string | ContentBlock[];
}

function replaceLatestUserText(messages: UserMessageLike[], text: string): void {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message.role !== 'user') {
      continue;
    }

    if (typeof message.content === 'string') {
      message.content = text;
      return;
    }

    if (Array.isArray(message.content)) {
      let replaced = false;
      const updatedBlocks = message.content.map((block) => {
        if (block.type !== 'text' || replaced) {
          return block;
        }
        replaced = true;
        return { ...block, text };
      });

      message.content = replaced
        ? updatedBlocks
        : ([{ type: 'text', text } as TextContent, ...updatedBlocks] as ContentBlock[]);
      return;
    }
  }
}

function updateLatestUserText(session: RuntimeSession, text: string): void {
  replaceLatestUserText(session.conversationHistory as UserMessageLike[], text);
}

function applyCurrentTurnInputToMessages(
  messages: Message[],
  currentTurnInput: string | undefined,
): void {
  if (!currentTurnInput) {
    return;
  }

  replaceLatestUserText(messages as UserMessageLike[], currentTurnInput);
}

function applyInputPIIRedactionToMessages(session: RuntimeSession, messages: Message[]): void {
  if (!session.piiRedactionConfig?.enabled || !session.piiRedactionConfig.redactInput) {
    return;
  }
  if (!session.piiVault) {
    return;
  }

  for (const message of messages) {
    if (message.role !== 'user') {
      continue;
    }

    if (typeof message.content === 'string') {
      message.content = renderTextForLLMWithPIIRedaction(session, message.content);
      continue;
    }

    if (Array.isArray(message.content)) {
      message.content = message.content.map((block) => {
        if (
          block &&
          typeof block === 'object' &&
          'type' in block &&
          block.type === 'text' &&
          'text' in block &&
          typeof block.text === 'string'
        ) {
          return { ...block, text: renderTextForLLMWithPIIRedaction(session, block.text) };
        }
        return block;
      });
    }
  }
}

function redactToolResultsForLLM(
  session: RuntimeSession,
  toolResults: Array<ToolResultContent>,
): Array<ToolResultContent> {
  if (!session.piiRedactionConfig?.enabled || !session.piiRedactionConfig.redactInput) {
    return toolResults;
  }

  return toolResults.map((toolResult) => ({
    ...toolResult,
    content: renderTextForLLMWithPIIRedaction(session, toolResult.content),
  }));
}

async function executeParallelMultiIntentPlan(
  routing: RoutingExecutor,
  session: RuntimeSession,
  pipelineModel: LanguageModel,
  userMessage: string,
  tasks: FanOutTask[],
  source: 'pipeline' | 'guided' | 'tool_call',
  onChunk?: (chunk: string) => void,
  onTraceEvent?: (event: { type: string; data: Record<string, unknown> }) => void,
): Promise<ExecutionResult> {
  const fanOutResult = await routing.handleFanOut(
    session,
    {
      tasks: tasks.map((task) => ({
        target: task.target,
        intent: task.intent,
        ...(task.context ? { context: task.context } : {}),
      })),
    },
    undefined,
    onTraceEvent,
  );

  const agentResults = fanOutResult.results.map((result, index) => ({
    target: result.target,
    intent: tasks[index]?.intent || userMessage,
    response: result.response || '',
    status: result.status === 'completed' ? ('completed' as const) : ('failed' as const),
    error: result.error,
  }));

  const mergedResponse = await mergeResponses(
    pipelineModel,
    userMessage,
    agentResults,
    onChunk,
    onTraceEvent as (event: { type: string; data: Record<string, unknown> }) => void,
  );

  if (onTraceEvent) {
    onTraceEvent({
      type: 'decision',
      data: {
        type: 'multi_intent_parallel_executed',
        sessionId: session.id,
        agentName: session.agentName,
        source,
        taskCount: fanOutResult.results.length,
        failedCount: fanOutResult.failedCount,
        targets: tasks.map((task) => task.target),
      },
    });
  }

  return {
    response: mergedResponse,
    action: {
      type: 'fan_out',
      taskCount: fanOutResult.results.length,
      failedCount: fanOutResult.failedCount,
    },
    stateUpdates: buildStateUpdates(session),
  };
}

// Tool result compaction thresholds moved to CompactionPolicy (compaction-policy.ts).
// See DEFAULT_COMPACTION_POLICY for platform defaults.

/**
 * Replace tool result content from old iterations with a short placeholder.
 * The LLM already saw the full result; keeping the full JSON wastes tokens
 * on later iterations. Complements CompactionPolicy.tool_results.max_chars
 * (per-result size) with per-iteration staleness truncation.
 *
 * Exported for testing.
 */
export function truncateOldToolResults(
  messages: Array<{ role: string; content: unknown }>,
  currentIteration: number,
  keepRecent = DEFAULT_COMPACTION_POLICY.tool_results.keep_recent,
): void {
  // Skip if too few tool-result messages could exist to warrant truncation.
  // Use currentIteration as a cheap proxy; the inner toolResultMsgCount check
  // is the authoritative guard.
  if (currentIteration <= keepRecent) return;

  // Walk messages backward counting tool-result user messages (each corresponds to one iteration)
  let toolResultMsgCount = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role !== 'user' || !Array.isArray(msg.content)) continue;

    const blocks = msg.content as Array<{ type: string; content?: string; tool_use_id?: string }>;
    const hasToolResult = blocks.some((b) => b.type === 'tool_result');
    if (!hasToolResult) continue;

    toolResultMsgCount++;
    if (toolResultMsgCount <= keepRecent) continue;

    // This is an old iteration's tool results — replace content with placeholder
    for (const block of blocks) {
      if (block.type === 'tool_result' && block.content) {
        block.content = `[Result available — see earlier in conversation]`;
      }
    }
  }
}

/**
 * Truncate tool results from prior turns in conversation history.
 *
 * A "turn boundary" is detected by finding user messages that are plain text
 * (not tool_result content blocks). Tool results between the start of the
 * conversation and the last plain-text user message are from prior turns
 * and should be truncated.
 *
 * This prevents multi-turn conversations from accumulating stale tool results
 * (e.g., 20K+ tokens of Pinecone product data from Turn 1 polluting Turn 3's
 * context window, causing the LLM to answer from memory instead of re-searching).
 *
 * Exported for testing.
 */
export function truncatePriorTurnToolResults(
  messages: Array<{ role: string; content: unknown }>,
  policy?: CompactionPolicy,
): void {
  const priorTurns = policy?.prior_turns ?? DEFAULT_COMPACTION_POLICY.prior_turns;

  // Strategy: none — keep full history
  if (priorTurns.strategy === 'none') return;

  // Find the index of the last plain-text user message (current turn start)
  let lastPlainUserIdx = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role !== 'user') continue;
    // Plain text user message = turn boundary
    if (typeof msg.content === 'string') {
      lastPlainUserIdx = i;
      break;
    }
    // ContentBlock[] user message could be text or tool_result
    if (Array.isArray(msg.content)) {
      const blocks = msg.content as Array<{ type: string }>;
      const hasToolResult = blocks.some((b) => b.type === 'tool_result');
      if (!hasToolResult) {
        lastPlainUserIdx = i;
        break;
      }
    }
  }

  if (lastPlainUserIdx <= 0) return; // No prior turns or single-turn conversation

  // Truncate all tool results before the current turn
  for (let i = 0; i < lastPlainUserIdx; i++) {
    const msg = messages[i];
    if (msg.role !== 'user' || !Array.isArray(msg.content)) continue;

    const blocks = msg.content as Array<{ type: string; content?: string }>;
    const hasToolResult = blocks.some((b) => b.type === 'tool_result');
    if (!hasToolResult) continue;

    for (const block of blocks) {
      if (block.type === 'tool_result' && block.content) {
        block.content = '[Prior turn result — summarized]';
      }
    }
  }

  // Strategy: compact or summarize — also compact assistant messages following truncated tool results
  if (priorTurns.strategy === 'compact' || priorTurns.strategy === 'summarize') {
    const previewChars = priorTurns.assistant_preview_chars;
    for (let i = 0; i < lastPlainUserIdx; i++) {
      const msg = messages[i];
      if (msg.role !== 'assistant' || typeof msg.content !== 'string') continue;

      if (i === 0) continue;
      const prev = messages[i - 1];
      if (prev.role !== 'user' || !Array.isArray(prev.content)) continue;
      const prevBlocks = prev.content as Array<{ type: string; content?: string }>;
      const wasTruncated = prevBlocks.some(
        (b) => b.type === 'tool_result' && b.content === '[Prior turn result — summarized]',
      );
      if (!wasTruncated) continue;

      const text = msg.content;
      if (text.length > previewChars) {
        msg.content = `[Prior response: "${text.slice(0, previewChars)}..." — full details omitted, re-invoke tools if the user changes or refines their request]`;
      }
    }
  }
}

/**
 * Normalize conversation history content to a format safe for LLM consumption.
 *
 * Content may be a string, a ContentBlock[], or an unexpected type (object/number/boolean)
 * from deserialized session state. This function ensures only string or ContentBlock[]
 * values pass through; everything else is coerced to a string representation so the
 * LLM never receives a raw object or number as message content.
 */
function normalizeMessageContent(content: unknown): string | ContentBlock[] {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content as ContentBlock[];
  // Unexpected type — coerce to string so the LLM can still process it
  if (content != null && typeof content === 'object') {
    try {
      return JSON.stringify(content);
    } catch {
      return String(content);
    }
  }
  return String(content ?? '');
}

/**
 * Sanitize a string for safe display — strips HTML tags and markdown formatting chars.
 */
function sanitizeForDisplay(value: unknown, maxLength = 200): string {
  if (typeof value !== 'string') return String(value ?? '');
  return value
    .replace(/<[^>]*>/g, '')
    .replace(/[*_~`#\[\]]/g, '')
    .slice(0, maxLength);
}

function extractBreakLoopResponse(toolResult: unknown): string | undefined {
  if (!toolResult || typeof toolResult !== 'object') {
    return undefined;
  }

  if ('response' in toolResult && typeof toolResult.response === 'string') {
    return toolResult.response;
  }

  if ('message' in toolResult && typeof toolResult.message === 'string') {
    return toolResult.message;
  }

  return undefined;
}

function extractBreakLoopStructuredResult(
  toolResult: unknown,
):
  | Partial<Pick<ExecutionResult, 'richContent' | 'voiceConfig' | 'actions' | 'localization'>>
  | undefined {
  if (!toolResult || typeof toolResult !== 'object') {
    return undefined;
  }

  const candidate = toolResult as Partial<ExecutionResult>;
  const record = toolResult as Record<string, unknown>;
  const nestedCandidate =
    record.result && typeof record.result === 'object'
      ? (record.result as Partial<ExecutionResult>)
      : undefined;
  const structuredResult: Partial<
    Pick<ExecutionResult, 'richContent' | 'voiceConfig' | 'actions' | 'localization'>
  > = {};

  if (candidate.richContent !== undefined || nestedCandidate?.richContent !== undefined) {
    structuredResult.richContent = candidate.richContent ?? nestedCandidate?.richContent;
  }
  if (candidate.voiceConfig !== undefined || nestedCandidate?.voiceConfig !== undefined) {
    structuredResult.voiceConfig = candidate.voiceConfig ?? nestedCandidate?.voiceConfig;
  }
  if (candidate.actions !== undefined || nestedCandidate?.actions !== undefined) {
    structuredResult.actions = candidate.actions ?? nestedCandidate?.actions;
  }
  if (candidate.localization !== undefined || nestedCandidate?.localization !== undefined) {
    structuredResult.localization = candidate.localization ?? nestedCandidate?.localization;
  }

  return Object.keys(structuredResult).length > 0 ? structuredResult : undefined;
}

function protectBreakLoopStructuredResult(
  session: RuntimeSession,
  structuredResult:
    | Partial<Pick<ExecutionResult, 'richContent' | 'voiceConfig' | 'actions' | 'localization'>>
    | undefined,
):
  | Partial<Pick<ExecutionResult, 'richContent' | 'voiceConfig' | 'actions' | 'localization'>>
  | undefined {
  if (!structuredResult) {
    return undefined;
  }

  const protectedResult = protectStructuredOutputForUser(session, {
    richContent: structuredResult.richContent,
    voiceConfig: structuredResult.voiceConfig,
    actions: structuredResult.actions,
  }).delivery;

  return {
    ...protectedResult,
    ...(structuredResult.localization !== undefined
      ? { localization: structuredResult.localization }
      : {}),
  };
}

function getDateNormalizationOptions(session: RuntimeSession): DateNormalizationOptions {
  return {
    locale: getCurrentInteractionParsingLocale(session.data, 'en') ?? 'en',
    timezone: getCurrentInteractionTimezone(session.data, 'UTC') ?? 'UTC',
    referenceInstant: session.lastActivityAt ?? session.createdAt,
  };
}

// =============================================================================
// REASONING EXECUTOR
// =============================================================================

/**
 * ReasoningExecutor — manages the reasoning-mode agentic loop.
 *
 * Public interface:
 *   execute(session, systemPrompt, tools, onChunk, onTraceEvent) → ExecutionResult
 */
export class ReasoningExecutor {
  private ctx: ExecutorContext;
  private routing: RoutingExecutor;
  private flowStep: FlowStepExecutor;
  private compactionEngine?: CompactionEngine;

  constructor(
    ctx: ExecutorContext,
    routing: RoutingExecutor,
    flowStep: FlowStepExecutor,
    compactionEngine?: CompactionEngine,
  ) {
    this.ctx = ctx;
    this.routing = routing;
    this.flowStep = flowStep;
    this.compactionEngine = compactionEngine;
  }

  /**
   * Execute the reasoning-mode agentic loop with tool use.
   *
   * Runs LLM ↔ tool iterations until:
   * - The LLM produces a final text response (no tool calls)
   * - A system tool (handoff/complete/escalate) breaks the loop
   * - The configurable max iteration limit is reached
   * - Consecutive empty responses trigger the safety guard
   */
  async execute(
    session: RuntimeSession,
    systemPrompt: string,
    inputTools: ToolDefinition[],
    onChunk?: (chunk: string) => void,
    onTraceEvent?: (event: { type: string; data: Record<string, unknown> }) => void,
    options: {
      skipInputGuardrails?: boolean;
      surfaceBuilder?: (
        session: RuntimeSession,
      ) =>
        | { systemPrompt: string; tools: ToolDefinition[] }
        | Promise<{ systemPrompt: string; tools: ToolDefinition[] }>;
    } = {},
  ): Promise<ExecutionResult> {
    ensureRuntimeSessionDataStore(session);

    // Pipeline may filter tools before the reasoning loop
    let tools = inputTools;
    if (!session.llmClient) {
      throw new AppError('Session LLM client not configured', {
        ...ErrorCodes.SERVICE_UNAVAILABLE,
      });
    }

    // Resolve project PII settings and patterns every turn so Studio changes
    // take effect for active sessions as well as new sessions.
    await refreshSessionPIIContext(session);
    let iterations = 0;
    const maxIterations = session.agentIR?.execution?.max_iterations ?? DEFAULT_MAX_TOOL_ITERATIONS;
    let consecutiveEmptyResponses = 0;
    let finalResponse = '';
    let finalAction: { type: string; [key: string]: unknown } = { type: 'continue' };
    let finalVoiceConfig: ExecutionResult['voiceConfig'];
    let finalRichContent: ExecutionResult['richContent'];
    let finalActions: ExecutionResult['actions'];
    let finalLocalization: ExecutionResult['localization'];
    const outputTurnId = randomUUID();
    const outputMessages: ExecutionOutputMessage[] = [];
    let outputSequence = 0;
    let finalOutputMessageId: string | undefined;
    const appendOutputMessage = (
      phase: ExecutionOutputMessage['phase'],
      text: string,
      options: {
        deliveredToUser: boolean;
        includeInModelContext?: boolean;
        persistToTranscript?: boolean;
      },
    ): string | undefined => {
      const normalizedText = text.trim();
      if (!normalizedText) return undefined;

      const id = randomUUID();
      outputMessages.push({
        id,
        turnId: outputTurnId,
        sequence: outputSequence++,
        agentName: session.agentName,
        role: 'assistant',
        phase,
        text: normalizedText,
        deliveredToUser: options.deliveredToUser,
        includeInModelContext: options.includeInModelContext ?? true,
        persistToTranscript: options.persistToTranscript ?? true,
      });
      if (phase === 'final') {
        finalOutputMessageId = id;
      }
      return id;
    };
    let beforeTurnEmittedMessage:
      | Pick<ExecutionResult, 'response' | 'richContent' | 'voiceConfig' | 'actions'>
      | undefined;
    let afterTurnEmittedMessage:
      | Pick<ExecutionResult, 'response' | 'richContent' | 'voiceConfig' | 'actions'>
      | undefined;
    let finalCitations: ExecutionResult['citations'];
    let supervisorRoutingRepairAttempts = 0;

    // Merge pending content blocks (e.g. images from attachments) into the last
    // user message in conversation history so that LLM receives multimodal input.
    if (session.pendingContentBlocks && session.pendingContentBlocks.length > 0) {
      // Find the last user message in conversation history
      for (let i = session.conversationHistory.length - 1; i >= 0; i--) {
        if (session.conversationHistory[i].role === 'user') {
          const existing = session.conversationHistory[i].content;
          let baseBlocks: ContentBlock[];
          if (Array.isArray(existing)) {
            baseBlocks = existing as ContentBlock[];
          } else {
            baseBlocks = [
              {
                type: 'text',
                text: typeof existing === 'string' ? existing : '',
              } as TextContent,
            ];
          }
          const contentBlocks: ContentBlock[] = [...baseBlocks, ...session.pendingContentBlocks];
          session.conversationHistory[i].content = contentBlocks;
          break;
        }
      }
      // Clear after consuming — blocks are now part of conversation history
      session.pendingContentBlocks = undefined;
    }

    // Build messages with proper Anthropic format, normalizing non-string content
    let messages: Message[] = session.conversationHistory
      .filter((m) => m.content && (typeof m.content !== 'string' || m.content.trim() !== ''))
      .map((m) => ({
        role: m.role === 'user' ? ('user' as const) : ('assistant' as const),
        content: normalizeMessageContent(m.content),
      }));

    // Truncate tool results from prior turns to prevent token bloat.
    // Without this, multi-turn conversations accumulate 20K+ tokens of stale
    // product search results, causing the LLM to answer from memory instead
    // of making fresh tool calls.
    truncatePriorTurnToolResults(messages, resolveCompactionPolicy(session));

    let currentTurnInput = resolveCurrentTurnInput(session);
    if (currentTurnInput !== undefined) {
      const rawCurrentTurnInput = resolveCurrentTurnRawInput(session, currentTurnInput);
      setCurrentTurnInputContext(session, currentTurnInput, rawCurrentTurnInput);
    }
    applyCurrentTurnInputToMessages(messages, currentTurnInput);
    applyInputPIIRedactionToMessages(session, messages);

    // === ENTITY PIPELINE: Per-turn extraction from ir.entities ===
    // Runs for ALL defined entities, not just GATHER fields.
    // Observations are utterance-scoped — replaced each turn.
    const irEntities = session.agentIR?.entities;
    if (irEntities && irEntities.length > 0 && currentTurnInput) {
      const dateNormalization = getDateNormalizationOptions(session);
      const turnNumber = session.conversationHistory.length;

      try {
        const observations = extractEntityObservations(
          currentTurnInput,
          irEntities,
          dateNormalization.locale ?? 'en',
          turnNumber,
          {
            referenceInstant: dateNormalization.referenceInstant,
            timezone: dateNormalization.timezone,
          },
        );

        // Store observations on session (utterance-scoped)
        session.observations = observations;

        // Emit trace events for each observation
        if (onTraceEvent) {
          for (const [entityName, entityObs] of Object.entries(observations.entities)) {
            for (const obs of entityObs) {
              onTraceEvent(
                traceEntityObservation(
                  session.agentName,
                  entityName,
                  obs.entityType,
                  obs.value,
                  obs.confidence,
                  undefined,
                  obs.sensitive,
                  maskSensitiveValue,
                ),
              );
              onTraceEvent(
                traceIntrinsicValidation(
                  session.agentName,
                  entityName,
                  obs.entityType,
                  obs.value,
                  obs.intrinsicValid ?? true,
                  obs.intrinsicError,
                  obs.sensitive,
                  maskSensitiveValue,
                ),
              );
            }
          }
        }
      } catch (err) {
        log.warn('Entity pipeline extraction failed', {
          agentName: session.agentName,
          error: err instanceof Error ? err.message : String(err),
        });
        session.observations = createObservationSet(session.conversationHistory.length);
      }
    }

    // For reasoning agents with GATHER fields, extract entities from the latest user message
    const gatherFields = session.agentIR?.gather?.fields;
    const inlineGather = session.agentIR?.execution?.inline_gather === true;
    let toolSelectionFilter: Set<string> | undefined;
    const hiddenToolNames = new Set<string>();

    const isPinnedTurnTool = (toolName: string): boolean =>
      toolName === '_extract_entities' ||
      toolName.startsWith('__') ||
      toolName.startsWith('handoff_to_') ||
      toolName.startsWith('delegate_to_');

    const applyTurnToolFilters = (candidateTools: ToolDefinition[]): ToolDefinition[] => {
      let nextTools = candidateTools.filter((tool) => !hiddenToolNames.has(tool.name));

      if (toolSelectionFilter) {
        nextTools = nextTools.filter(
          (tool) => isPinnedTurnTool(tool.name) || toolSelectionFilter?.has(tool.name),
        );
      }

      return nextTools;
    };

    const buildInlineGatherTool = (): ToolDefinition | undefined => {
      if (!inlineGather || !gatherFields || gatherFields.length === 0) {
        return undefined;
      }

      const uncollectedFields = (gatherFields as GatherField[]).filter((field) => {
        const value = session.data.values[field.name];
        return value === undefined || value === null || value === '';
      });

      const delegateWhenVars = getDelegateWhenVariables(session.agentIR);
      const supplementaryFields = delegateWhenVars.filter(
        (name) =>
          !uncollectedFields.some((field) => field.name === name) &&
          !(name in (session.data.values ?? {})),
      );
      const allInlineFields = [
        ...uncollectedFields,
        ...supplementaryFields.map((name) => {
          const hints = getDelegateFieldHints(session.agentIR, name);
          return {
            name,
            type: 'string',
            extraction_hints: hints.length > 0 ? hints : undefined,
          } as GatherField;
        }),
      ];

      if (allInlineFields.length === 0) {
        return undefined;
      }

      const mergedLookup = mergeLookupTables(
        session.agentIR?.lookup_tables,
        session._projectRuntimeConfig,
      );
      return FlowStepExecutor.buildExtractionTool(allInlineFields, mergedLookup);
    };

    const resolveTurnSurface = async (): Promise<{
      systemPrompt: string;
      tools: ToolDefinition[];
    }> => {
      await preparePreTurnExecutionView(session, onTraceEvent);
      const baseSurface = options.surfaceBuilder
        ? await options.surfaceBuilder(session)
        : {
            systemPrompt: buildSystemPrompt(session),
            tools: buildTools(session),
          };
      const nextTools = applyTurnToolFilters(baseSurface.tools);
      const extractionTool = buildInlineGatherTool();
      return {
        systemPrompt: baseSurface.systemPrompt,
        tools: extractionTool ? [extractionTool, ...nextTools] : nextTools,
      };
    };

    const refreshTurnSurface = async (): Promise<void> => {
      const nextSurface = await resolveTurnSurface();
      systemPrompt = nextSurface.systemPrompt;
      tools = nextSurface.tools;
    };

    const refreshPromptOnly = async (): Promise<void> => {
      await preparePreTurnExecutionView(session, onTraceEvent);
      systemPrompt = options.surfaceBuilder
        ? (await options.surfaceBuilder(session)).systemPrompt
        : buildSystemPrompt(session);
    };

    let justExtractedFields: string[] = [];
    if (gatherFields && gatherFields.length > 0 && !inlineGather) {
      const lastUserMsg = currentTurnInput;
      if (lastUserMsg) {
        if (shouldSkipExtraction(lastUserMsg)) {
          // Skip extraction for trivial input (greetings, acks)
          if (onTraceEvent) {
            onTraceEvent({
              type: 'dsl_collect',
              data: {
                agentName: session.agentName,
                mode: 'reasoning_gather',
                userInput: lastUserMsg,
                skipped: true,
                reason: 'trivial_input',
              },
            });
          }
        } else {
          const fieldNames = gatherFields.map((f) => (typeof f === 'string' ? f : f.name));

          // Extend extraction scope: include variables referenced in DELEGATE WHEN
          // conditions so the runtime can evaluate delegation guards. Without this,
          // WHEN conditions like `incident_category == "fiber_cut"` fail because
          // entity extraction only populates GATHER fields.
          const delegateWhenVars = getDelegateWhenVariables(session.agentIR);
          const supplementaryFields = delegateWhenVars.filter(
            (v) => !fieldNames.includes(v) && !(v in (session.data.values ?? {})),
          );
          const allFieldNames = [...fieldNames, ...supplementaryFields];
          const allGatherFields = [
            ...(gatherFields as GatherField[]),
            ...supplementaryFields.map((name) => {
              const hints = getDelegateFieldHints(session.agentIR, name);
              return {
                name,
                type: 'string',
                extraction_hints: hints.length > 0 ? hints : undefined,
              } as GatherField;
            }),
          ];

          try {
            const extracted = await this.flowStep.extractEntitiesWithLLM(
              lastUserMsg,
              allFieldNames,
              session,
              onTraceEvent,
              allGatherFields,
            );

            // Filter out empty/undefined values, then validate & normalize
            const nonEmpty: Record<string, unknown> = {};
            for (const [key, value] of Object.entries(extracted)) {
              if (value !== undefined && value !== null && value !== '') {
                nonEmpty[key] = value;
              }
            }
            const { valid: validExtracted, invalid: invalidFields } = validateExtractedBatch(
              allGatherFields,
              nonEmpty,
              getDateNormalizationOptions(session),
            );
            if (Object.keys(invalidFields).length > 0) {
              log.debug('Pre-pass extraction validation rejected fields', {
                agent: session.agentName,
                invalid: invalidFields,
              });
              // Surface validation errors to the LLM so it can ask for correction
              // instead of generically re-asking for the field.
              session.data.values._validation_errors = invalidFields;
            } else {
              delete session.data.values._validation_errors;
            }

            // Apply lookup-table validation (same gate as inline fallback path)
            const lookupErrors = await applyLookupValidationToExtractedValues(
              session,
              validExtracted,
              allGatherFields,
              onTraceEvent,
            );
            if (Object.keys(lookupErrors).length > 0) {
              const merged = {
                ...(typeof session.data.values._validation_errors === 'object' &&
                session.data.values._validation_errors !== null
                  ? (session.data.values._validation_errors as Record<string, string>)
                  : {}),
                ...lookupErrors,
              };
              session.data.values._validation_errors = merged;
            }

            if (Object.keys(validExtracted).length > 0) {
              justExtractedFields = Object.keys(validExtracted);
              setGatheredValues(session, validExtracted);

              // Memory: REMEMBER triggers + RECALL on entity events + preference detection
              try {
                await evaluateRememberAfterStateChange(session, onTraceEvent);
              } catch (err) {
                log.warn('memory remember after state change failed', {
                  error: err instanceof Error ? err.message : String(err),
                });
              }
              try {
                await executeRecallAfterExtraction(
                  session,
                  Object.keys(validExtracted),
                  onTraceEvent,
                );
              } catch (err) {
                log.warn('memory recall after extraction failed', {
                  error: err instanceof Error ? err.message : String(err),
                });
              }
              if (lastUserMsg) {
                try {
                  await detectAndStorePreferences(
                    session,
                    lastUserMsg,
                    Object.keys(validExtracted),
                    onTraceEvent,
                  );
                } catch (err) {
                  log.warn('memory detect preferences failed', {
                    error: err instanceof Error ? err.message : String(err),
                  });
                }
              }

              if (onTraceEvent) {
                onTraceEvent({
                  type: 'dsl_collect',
                  data: {
                    agentName: session.agentName,
                    mode: 'reasoning_gather',
                    fields: fieldNames,
                    userInput: lastUserMsg,
                    extracted: validExtracted,
                    context: { ...session.data.values },
                  },
                });
              }
            }
          } catch (err) {
            log.error('Entity extraction failed', {
              agent: session.agentName,
              error: err instanceof Error ? err.message : String(err),
            });
          }
        }
      }
    } else if (gatherFields && gatherFields.length > 0 && inlineGather) {
      // === INLINE PATH: skip LLM extraction, JS-lib pre-processing only ===
      if (onTraceEvent) {
        onTraceEvent({
          type: 'dsl_collect',
          data: {
            agentName: session.agentName,
            mode: 'inline_gather',
            phase: 'skip_prepass',
          },
        });
      }
    }

    // ==========================================================================
    // POST-EXTRACTION CONSTRAINT CHECK: Now that entities are stored in context,
    // re-check constraints (e.g., "destination != origin" after extracting both)
    // ==========================================================================
    if (justExtractedFields.length > 0) {
      const postExtractionViolation = checkFlatConstraints(session, onTraceEvent);
      if (postExtractionViolation) {
        const fieldsToClear = getConstraintFieldsToClear(
          justExtractedFields,
          postExtractionViolation.condition,
        );
        for (const field of fieldsToClear) {
          deleteSessionValue(session, field);
        }
        return executeConstraintViolation(session, postExtractionViolation, {
          onChunk,
          onTraceEvent,
          executeHandoff: (handoffInput) =>
            this.routing.handleHandoff(session, handoffInput, onChunk, onTraceEvent),
        });
      }

      // Rebuild system prompt with updated context after extraction
      await refreshTurnSurface();
    }

    // Auto-compact if context is approaching model limit
    if (this.compactionEngine) {
      try {
        await this.compactionEngine.autoCompact(session, onTraceEvent);
      } catch (err) {
        log.warn('auto-compact failed, continuing without compaction', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // Run opt-in pipeline (classifier + tool filter) before the reasoning loop
    const pipelineConfig = resolvePipelineConfig(
      session.agentIR?.execution,
      session.agentIR?.project_runtime_config?.pipeline,
    );
    if (pipelineConfig.enabled) {
      const currentInput = resolveCurrentTurnInput(session);
      const rawInput = resolveCurrentTurnRawInput(session, currentInput) ?? '';
      const handoffFrom =
        typeof session.data?.values?.handoff_from === 'string'
          ? (session.data.values.handoff_from as string)
          : '';
      const classifierContext = resolveClassifierRuntimeContext({
        conversationHistory: session.conversationHistory,
        currentInput,
        rawInput,
        handoffFrom,
      });
      const lastUserMsg = classifierContext.currentMessage;

      const tenantId = session.tenantId ?? '';
      if (lastUserMsg && session.llmClient && !isPipelineCircuitOpen(tenantId)) {
        try {
          const rawCategories = session.agentIR?.routing?.intent_classification?.categories ?? [];
          const categories: IntentCategory[] = rawCategories.map((c: string | IntentCategory) =>
            typeof c === 'string' ? { name: c } : c,
          );
          const routingRules = session.agentIR?.routing?.rules ?? [];
          const classifierDecision = shouldRunPipelineClassifier({
            categories,
            routingRules,
            intentBridgeEnabled: pipelineConfig.intentBridge?.enabled === true,
          });

          if (!classifierDecision.shouldRun) {
            log.debug('skipping pipeline classifier', {
              reason: classifierDecision.reason,
              agentName: session.agentName,
            });
          }

          // Skipping classifier is intentionally fail-open. Non-actionable child
          // agents still use the normal reasoning path for out-of-scope
          // behaviors such as __return_to_parent__.
          if (classifierDecision.shouldRun || pipelineConfig.toolFilter.enabled) {
            const pipelineModel = await resolvePipelineModel(pipelineConfig, session);
            if (pipelineModel) {
              // Provide the agent's GOAL and LIMITATIONS to the classifier on every
              // turn so it can determine out-of-scope accurately.
              const agentScope: AgentScopeContext | undefined = session.agentIR?.identity?.goal
                ? {
                    goal: session.agentIR.identity.goal,
                    limitations: session.agentIR.identity.limitations,
                  }
                : undefined;

              const toolNames = extractToolNames(tools);
              let classifierResult: ClassifierResult | undefined;
              let toolFilterResult: ToolFilterResult | undefined;

              if (pipelineConfig.mode === 'parallel') {
                const [cResult, fResult] = await Promise.all([
                  classifierDecision.shouldRun
                    ? classify(pipelineModel, {
                        mode: 'global',
                        userMessage: lastUserMsg,
                        categories,
                        config: pipelineConfig,
                        onTraceEvent: onTraceEvent as OnTraceEvent,
                        agentScope,
                        recentConversation: classifierContext.recentConversation,
                      })
                    : Promise.resolve(undefined),
                  pipelineConfig.toolFilter.enabled
                    ? filterTools(
                        pipelineModel,
                        lastUserMsg,
                        tools,
                        pipelineConfig,
                        onTraceEvent as OnTraceEvent,
                      )
                    : Promise.resolve(undefined),
                ]);
                classifierResult = cResult;
                toolFilterResult = fResult;
              } else {
                if (classifierDecision.shouldRun) {
                  classifierResult = await classify(pipelineModel, {
                    mode: 'global',
                    userMessage: lastUserMsg,
                    categories,
                    config: pipelineConfig,
                    onTraceEvent: onTraceEvent as OnTraceEvent,
                    agentScope,
                    recentConversation: classifierContext.recentConversation,
                  });
                }

                const scCheck = classifierResult
                  ? shouldShortCircuit(classifierResult, lastUserMsg, toolNames, pipelineConfig)
                  : { shortCircuit: false };
                if (!scCheck.shortCircuit && pipelineConfig.toolFilter.enabled) {
                  toolFilterResult = await filterTools(
                    pipelineModel,
                    lastUserMsg,
                    tools,
                    pipelineConfig,
                    onTraceEvent as OnTraceEvent,
                  );
                }
              }

              recordPipelineSuccess(tenantId);

              const routingMatches = classifierResult
                ? resolveRouting(
                    classifierResult.intents,
                    routingRules,
                    session.data.values,
                    onTraceEvent as OnTraceEvent,
                    { classifierMode: 'global' },
                  )
                : [];

              if (pipelineConfig.intentBridge?.enabled && session.agentIR && classifierResult) {
                const intentState = bridgeIntentsToSessionState(classifierResult, routingMatches);
                session.data.values.intent = intentState;

                if (onTraceEvent) {
                  onTraceEvent({
                    type: 'pipeline_intent_bridge',
                    data: { intentState, tier: 0 },
                  });
                }
              }

              if (classifierResult) {
                await refreshTurnSurface();
              }

              // NOTE: toolFilterResult.selectedTools is string[] (tool NAMES, not objects)
              if (toolFilterResult?.selectedTools) {
                toolSelectionFilter = new Set(toolFilterResult.selectedTools);
                tools = applyTurnToolFilters(tools);
              }

              if (classifierResult) {
                const scCheck = shouldShortCircuit(
                  classifierResult,
                  lastUserMsg,
                  toolNames,
                  pipelineConfig,
                );
                if (
                  scCheck.shortCircuit &&
                  routingMatches.length === 1 &&
                  routingMatches[0].target
                ) {
                  const target = routingMatches[0].target;
                  const handoffResult = await this.routing.handleHandoff(
                    session,
                    {
                      target,
                      message: lastUserMsg,
                      context: {},
                    },
                    onChunk,
                    onTraceEvent,
                  );

                  if (!handoffResult.success) {
                    return buildFailedHandoffExecutionResult(session, target, handoffResult.error);
                  }

                  return buildHandoffExecutionResult(session, target, handoffResult);
                }

                const highConfidenceMultiIntentMode = resolveHighConfidenceMultiIntentMode({
                  classifierResult,
                  routingMatches,
                  userMessage: lastUserMsg,
                  shortCircuitEnabled: pipelineConfig.shortCircuit.enabled,
                  confidenceThreshold: pipelineConfig.shortCircuit.confidenceThreshold,
                });

                if (highConfidenceMultiIntentMode.mode === 'parallel') {
                  return executeParallelMultiIntentPlan(
                    this.routing,
                    session,
                    pipelineModel,
                    lastUserMsg,
                    routingMatches
                      .filter((m) => m.target !== null)
                      .map((m) => ({
                        target: m.target!,
                        intent: m.intent.summary,
                      })),
                    'pipeline',
                    onChunk,
                    onTraceEvent,
                  );
                }

                if (
                  highConfidenceMultiIntentMode.mode === 'sequential' &&
                  pipelineConfig.intentBridge?.enabled &&
                  session.agentIR
                ) {
                  const detectedMultiIntent = bridgeToDetectedMultiIntent(
                    classifierResult,
                    routingMatches,
                    lastUserMsg,
                  );
                  const multiConfig = resolveMultiIntentConfig(session.agentIR);
                  if (detectedMultiIntent && multiConfig.enabled) {
                    const filteredResult = filterDetectedMultiIntentAlternatives(
                      detectedMultiIntent,
                      multiConfig.confidence_threshold,
                    );
                    if (filteredResult) {
                      const resolveLocalizedMessage = buildLocalizedMessageResolver(session);
                      const plan = resolveDetectedMultiIntentPlan({
                        sessionId: session.id,
                        agentName: session.agentName,
                        agentIR: session.agentIR,
                        detected: filteredResult,
                        userMessage: lastUserMsg,
                        onTraceEvent,
                        resolveMessage: resolveLocalizedMessage,
                      });

                      if (plan.strategy === 'sequential') {
                        const sequentialTasks = buildSequentialMultiIntentTasks(plan);
                        if (sequentialTasks.length > 0) {
                          return executeSequentialMultiIntentPlan(
                            this.routing,
                            session,
                            pipelineModel,
                            lastUserMsg,
                            sequentialTasks,
                            'pipeline',
                            highConfidenceMultiIntentMode.relationship ?? plan.relationship,
                            onChunk,
                            onTraceEvent,
                          );
                        }
                      }
                    }
                  }
                }

                if (pipelineConfig.intentBridge?.enabled && session.agentIR) {
                  const resolveLocalizedMessage = buildLocalizedMessageResolver(session);
                  const tieredAction = resolveTieredAction(
                    classifierResult,
                    routingMatches,
                    pipelineConfig.intentBridge,
                    session.agentIR,
                    resolveLocalizedMessage,
                  );

                  if (onTraceEvent) {
                    onTraceEvent({
                      type: 'pipeline_tiered_action',
                      data: {
                        tier: tieredAction.tier,
                        action: tieredAction.action,
                        details:
                          tieredAction.action === 'decline_out_of_scope'
                            ? { message: tieredAction.message }
                            : tieredAction.action === 'guided'
                              ? {
                                  hiddenTools: tieredAction.hints.hiddenTools,
                                  hasMultiIntent: !!tieredAction.hints.multiIntentSignal,
                                }
                              : tieredAction.action === 'autonomous'
                                ? { reason: tieredAction.reason }
                                : {},
                      },
                    });
                  }

                  // Skip decline when the agent was reached via handoff — the supervisor
                  // already validated this is the correct target.
                  const reachedViaHandoff = !!session.data?.values?.handoff_from;
                  if (
                    tieredAction.tier === 1 &&
                    tieredAction.action === 'decline_out_of_scope' &&
                    !reachedViaHandoff
                  ) {
                    const message = tieredAction.message;
                    const protectedMessage = protectSessionOutputForUser(session, message);
                    if (onChunk) onChunk(protectedMessage.deliveryText);
                    session.conversationHistory.push({
                      role: 'assistant',
                      content: protectedMessage.historyText,
                    });
                    return {
                      response: protectedMessage.deliveryText,
                      action: { type: 'decline' },
                      stateUpdates: buildStateUpdates(session),
                    };
                  }

                  if (tieredAction.tier === 2 && tieredAction.action === 'guided') {
                    if (tieredAction.hints.hiddenTools.length > 0) {
                      for (const hiddenTool of tieredAction.hints.hiddenTools) {
                        hiddenToolNames.add(hiddenTool);
                      }
                      tools = applyTurnToolFilters(tools);
                    }

                    if (tieredAction.hints.multiIntentSignal) {
                      const detectedMultiIntent = bridgeToDetectedMultiIntent(
                        classifierResult,
                        routingMatches,
                        lastUserMsg,
                      );
                      if (detectedMultiIntent) {
                        const multiConfig = resolveMultiIntentConfig(session.agentIR);
                        if (multiConfig.enabled) {
                          const filteredResult = filterDetectedMultiIntentAlternatives(
                            detectedMultiIntent,
                            multiConfig.confidence_threshold,
                          );
                          if (filteredResult) {
                            const plan = resolveDetectedMultiIntentPlan({
                              sessionId: session.id,
                              agentName: session.agentName,
                              agentIR: session.agentIR,
                              detected: filteredResult,
                              userMessage: lastUserMsg,
                              onTraceEvent,
                              resolveMessage: resolveLocalizedMessage,
                            });

                            if (plan.strategy === 'parallel' && plan.fanOutTasks?.length) {
                              return executeParallelMultiIntentPlan(
                                this.routing,
                                session,
                                pipelineModel,
                                lastUserMsg,
                                plan.fanOutTasks,
                                'guided',
                                onChunk,
                                onTraceEvent,
                              );
                            }

                            if (plan.strategy === 'sequential') {
                              const sequentialTasks = buildSequentialMultiIntentTasks(plan);
                              if (sequentialTasks.length > 0) {
                                return executeSequentialMultiIntentPlan(
                                  this.routing,
                                  session,
                                  pipelineModel,
                                  lastUserMsg,
                                  sequentialTasks,
                                  'guided',
                                  plan.relationship,
                                  onChunk,
                                  onTraceEvent,
                                );
                              }
                            }

                            const dispatch = applyResolvedMultiIntentPlan({
                              session,
                              plan,
                              onTraceEvent,
                            });
                            if (dispatch.disambiguationMessage) {
                              const protectedMessage = protectSessionOutputForUser(
                                session,
                                dispatch.disambiguationMessage,
                              );
                              if (onChunk) onChunk(protectedMessage.deliveryText);
                              session.conversationHistory.push({
                                role: 'assistant',
                                content: protectedMessage.historyText,
                              });
                              return {
                                response: protectedMessage.deliveryText,
                                action: { type: 'multi_intent' },
                                stateUpdates: buildStateUpdates(session),
                              };
                            }
                          }
                        }
                      }
                    }

                    await refreshPromptOnly();
                  }
                }
              }
            }
          }
        } catch (err) {
          recordPipelineFailure(tenantId);
          log.warn('pipeline execution failed, continuing with full tool set', {
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    }

    // --- PER-TURN PROFILE RE-EVALUATION (IR-gated: no-op if no profiles) ---
    session.turnCount = (session.turnCount ?? 0) + 1;
    const shouldTraceConversationBehavior =
      !!session.agentIR?.behavior_profiles?.length || !!session.agentIR?.conversation_behavior;
    if (session.agentIR?.behavior_profiles?.length) {
      const { assembleProfileContext, resolveActiveProfiles, buildEffectiveConfig } =
        await import('./profile-resolver.js');
      const profileInteractionContext = mergeProfileInteractionContextInputs(
        readSessionInteractionState(session.data)?.current,
        readProfileInteractionContextFromSessionData(session.data),
      );
      const profileCtx = assembleProfileContext({
        channelType: session.channelType || 'digital',
        sessionMeta: {
          isNew: false,
          turnCount: session.turnCount,
        },
        interactionContext: profileInteractionContext,
      });
      const activeProfiles = resolveActiveProfiles(session.agentIR.behavior_profiles, profileCtx);
      const newNames = activeProfiles.map((p: { name: string }) => p.name);
      const prevNames = session._activeProfileNames ?? [];
      const profilesChanged =
        newNames.length !== prevNames.length || newNames.some((n, i) => n !== prevNames[i]);

      if (profilesChanged) {
        session._effectiveConfig =
          activeProfiles.length > 0 || !!session.agentIR.conversation_behavior
            ? buildEffectiveConfig(session.agentIR, activeProfiles, {
                channelType: session.channelType || 'digital',
              })
            : undefined;
        session._activeProfileNames = newNames;

        // Rebuild system prompt and tools with updated profile config
        await refreshTurnSurface();

        onTraceEvent?.({
          type: 'behavior_profile_applied',
          data: {
            turnCount: session.turnCount,
            previousProfiles: prevNames,
            activeProfiles: newNames,
            toolsAdded:
              session._effectiveConfig?.tools?.filter(
                (t) => !session.agentIR?.tools?.some((bt) => bt.name === t.name),
              ).length ?? 0,
            toolsHidden:
              session.agentIR?.tools?.filter(
                (t) => !session._effectiveConfig?.tools?.some((et) => et.name === t.name),
              ).length ?? 0,
            hasVoiceOverride: !!session._effectiveConfig?.voiceConfig,
            hasConversationBehavior: !!session._effectiveConfig?.conversationBehavior,
            conversationBehaviorSourceChain:
              session._effectiveConfig?.conversationBehavior?.sourceChain ?? [],
            conversationBehaviorCapabilityDrops:
              session._effectiveConfig?.conversationBehavior?.capabilityDrops.length ?? 0,
            conversationBehaviorCapabilityDropDetails:
              session._effectiveConfig?.conversationBehavior?.capabilityDrops ?? [],
            agent: session.agentName,
          },
        });
      }
    }
    if (shouldTraceConversationBehavior) {
      const interaction = readSessionInteractionState(session.data)?.current;
      const activeProfiles = session._activeProfileNames ?? [];
      const baseTools = session.agentIR?.tools ?? [];
      const effectiveTools = session._effectiveConfig?.tools ?? baseTools;
      const behaviorTraceSummary = buildConversationBehaviorTraceSummary(
        session._effectiveConfig?.conversationBehavior,
        {
          interactionLanguage: interaction?.language ?? undefined,
          interactionLocale: interaction?.locale ?? undefined,
          interactionTimezone: interaction?.timezone ?? undefined,
        },
      );

      onTraceEvent?.({
        type: 'profile_resolution',
        data: {
          turnCount: session.turnCount,
          perTurn: true,
          evaluatedProfiles: session.agentIR?.behavior_profiles?.map((p) => p.name) ?? [],
          matchedProfiles: activeProfiles,
          channel: session.channelType || 'digital',
          effectiveSummary: {
            instructionsAppended: session._effectiveConfig?.additionalInstructions?.length ?? 0,
            constraintsAdded: session._effectiveConfig?.additionalConstraints?.length ?? 0,
            toolsHidden: baseTools.filter(
              (tool) => !effectiveTools.some((effectiveTool) => effectiveTool.name === tool.name),
            ).length,
            toolsAdded: effectiveTools.filter(
              (tool) => !baseTools.some((baseTool) => baseTool.name === tool.name),
            ).length,
            hasResponseRules: !!session._effectiveConfig?.responseRules,
            hasVoiceConfig: !!session._effectiveConfig?.voiceConfig,
            hasConversationBehavior: !!session._effectiveConfig?.conversationBehavior,
            conversationBehaviorSourceChain:
              session._effectiveConfig?.conversationBehavior?.sourceChain ?? [],
            conversationBehaviorCapabilityDrops:
              session._effectiveConfig?.conversationBehavior?.capabilityDrops.length ?? 0,
            conversationBehaviorCapabilityDropDetails:
              session._effectiveConfig?.conversationBehavior?.capabilityDrops ?? [],
            conversationBehavior: behaviorTraceSummary,
            hasGatherOverrides: !!session._effectiveConfig?.gatherOverrides,
            hasFlowReplace: !!session._effectiveConfig?.flowReplace,
          },
        },
      });
    }

    // --- HOOKS: before_turn lifecycle hook (IR-gated: no-op if not defined) ---
    if (session.agentIR?.hooks?.before_turn) {
      const { executeHook } = await import('./hook-executor.js');
      const beforeTurnHookResult = await executeHook(
        'before_turn',
        session.agentIR.hooks,
        session,
        onChunk,
        onTraceEvent,
      );
      beforeTurnEmittedMessage = beforeTurnHookResult.emittedMessage;
    }

    // --- INPUT GUARDRAILS: evaluate user message BEFORE LLM call ---
    const inputPolicy = await getSessionPolicy(session);
    const dslInputGuardrails = session.agentIR?.constraints?.guardrails ?? [];
    const allInputGuardrails = [
      ...dslInputGuardrails,
      ...(inputPolicy?.additionalGuardrails ?? []),
    ];
    const hasInputGuardrails = allInputGuardrails.some((g) => g.kind === 'input');

    if (!options.skipInputGuardrails && hasInputGuardrails) {
      // Extract the last user message text for evaluation
      const lastUserContent = session.conversationHistory
        .filter((m) => m.role === 'user')
        .pop()?.content;
      const userMessageText =
        typeof lastUserContent === 'string'
          ? lastUserContent
          : Array.isArray(lastUserContent)
            ? ((lastUserContent as Array<{ type: string; text?: string }>).find(
                (b) => b.type === 'text',
              )?.text ?? '')
            : '';

      if (userMessageText) {
        try {
          if (session.tenantId) {
            await ensureTenantProvidersLoaded(session.tenantId);
          }
          const llmEval = session.llmClient
            ? createLLMEvalFromClient(session.llmClient)
            : undefined;
          const pipeline = createGuardrailPipeline(llmEval, session.tenantId, session.projectId, {
            policy: inputPolicy,
            piiRecognizerRegistry: session.piiRecognizerRegistry,
            cacheScopeKey: getSessionGuardrailCacheScopeKey(session),
          });
          const inputResult = await pipeline.execute(
            dslInputGuardrails,
            userMessageText,
            'input',
            { agentGoal: session.agentIR?.identity?.goal },
            undefined,
            inputPolicy,
          );

          // Log input guardrail decision
          emitDecisionEvent(onTraceEvent, session.traceVerbosity, 'guardrail_check', {
            outcome: inputResult.passed
              ? 'pass'
              : (inputResult.primaryViolation?.action ?? 'block'),
            matched: inputResult.passed,
            trigger: inputResult.primaryViolation
              ? {
                  guardrail: inputResult.primaryViolation.name,
                  tier: inputResult.primaryViolation.tier,
                  kind: 'input',
                }
              : undefined,
          });

          if (!inputResult.passed && inputResult.primaryViolation) {
            const primary = inputResult.primaryViolation;
            const blockedMessage = primary.message || 'I cannot process that request.';
            if (onTraceEvent) {
              onTraceEvent({
                type: 'guardrail_input_blocked',
                data: {
                  agentName: session.agentName,
                  kind: 'input',
                  guardrailName: primary.name,
                  action: primary.action,
                  message: primary.message,
                  presetKey: primary.presetKey,
                  passed: false,
                },
              });
            }

            if (primary.action === 'block' || primary.action === 'escalate') {
              const protectedBlockedMessage = protectSessionOutputForUser(session, blockedMessage);
              if (onChunk) {
                onChunk(protectedBlockedMessage.deliveryText);
              }
              session.conversationHistory.push({
                role: 'assistant',
                content: protectedBlockedMessage.historyText,
              });
              return {
                response: protectedBlockedMessage.deliveryText,
                action: { type: 'respond' },
              };
            }
          }

          if (inputResult.modifiedContent && inputResult.modifiedContent !== userMessageText) {
            updateLatestUserText(session, inputResult.modifiedContent);
            currentTurnInput = inputResult.modifiedContent;
            setCurrentTurnInputContext(session, inputResult.modifiedContent, userMessageText);
            await refreshPromptOnly();
          }
        } catch (err) {
          log.warn('Input guardrail evaluation failed', {
            error: err instanceof Error ? err.message : String(err),
            agentName: session.agentName,
          });
          // Fail open — continue to LLM call
        }
      }
    }

    if (currentTurnInput !== undefined) {
      const rawCurrentTurnInput =
        resolveCurrentTurnRawInput(session, currentTurnInput) ?? currentTurnInput;
      setCurrentTurnInputContext(session, currentTurnInput, rawCurrentTurnInput);
      await refreshPromptOnly();
    }

    const allFlatConstraints = [
      ...((session.agentIR?.constraints?.constraints ?? []) as Array<{ condition?: string }>),
      ...((session._effectiveConfig?.additionalConstraints ?? []) as Array<{
        condition?: string;
      }>),
    ];
    const hasResponseCheckpointConstraints = allFlatConstraints.some(
      (constraint) =>
        typeof constraint.condition === 'string' &&
        constraint.condition.includes(CONSTRAINT_CHECKPOINT_KIND_KEY) &&
        constraint.condition.includes('"response"'),
    );
    const hasOutputGuardrails =
      (session.agentIR?.constraints?.guardrails?.some((guardrail) => guardrail.kind === 'output') ??
        false) ||
      (inputPolicy?.additionalGuardrails?.some((guardrail) => guardrail.kind === 'output') ??
        false);
    const mustDelayStreamedOutput = hasResponseCheckpointConstraints || hasOutputGuardrails;

    log.info('Streaming config resolved', {
      agent: session.agentName,
      hasOnChunk: !!onChunk,
      mustDelayStreamedOutput,
      hasResponseCheckpointConstraints,
      hasOutputGuardrails,
      hasInputPolicyOutputGuardrails:
        inputPolicy?.additionalGuardrails?.some((g: any) => g.kind === 'output') ?? false,
      hasAgentIROutputGuardrails:
        session.agentIR?.constraints?.guardrails?.some(
          (guardrail: any) => guardrail.kind === 'output',
        ) ?? false,
    });

    if (!gatherFields || gatherFields.length === 0) {
      const preLoopViolation = checkFlatConstraints(session, onTraceEvent);
      if (preLoopViolation) {
        return executeConstraintViolation(session, preLoopViolation, {
          onChunk,
          onTraceEvent,
          executeHandoff: (handoffInput) =>
            this.routing.handleHandoff(session, handoffInput, onChunk, onTraceEvent),
        });
      }
    }

    messages = session.conversationHistory
      .filter((m) => m.content && (typeof m.content !== 'string' || m.content.trim() !== ''))
      .map((m) => ({
        role: m.role === 'user' ? ('user' as const) : ('assistant' as const),
        content: normalizeMessageContent(m.content),
      }));
    truncatePriorTurnToolResults(messages, resolveCompactionPolicy(session));
    applyCurrentTurnInputToMessages(messages, currentTurnInput);
    applyInputPIIRedactionToMessages(session, messages);
    await refreshTurnSurface();

    let streamedText = false;
    let inlineExtractionCalled = false;

    // ─── KB Fast Path: Unified Pre-Search + Classify ─────────────────────
    //
    // For KB-only agents (all non-system tools are searchai): skip the tool-call
    // loop entirely. ONE path for all KB types — no tier branching:
    //
    //   Turn 1: ZERO classify overhead — speculative hybrid search → inject → synthesize
    //   Turn 2+: Light classify (DIRECT/SEARCH/rephrase) → search → synthesize
    //
    // Speculative hybrid search fires immediately (before classify) and runs in
    // parallel. For most queries the speculative result IS the final result —
    // hybrid search is robust to minor rephrasing. The synthesis LLM sees the
    // tool description with vocabulary/filter guidance and answers naturally.
    //
    // Falls back to normal tool loop when:
    //   - Agent has non-KB tools (custom HTTP, MCP, etc.)
    //   - Inline gather is active (extraction tool injected)
    //   - Agent is a supervisor (has routing tools)
    //   - No currentTurnInput (e.g., system-triggered)
    //   - No search executor wired

    let kbFastPathUsed = false;

    if (session._searchaiToolExecutor && currentTurnInput) {
      // Detect KB-only agent: all non-system tools are searchai type
      const allAgentTools = session._effectiveConfig?.tools ?? session.agentIR?.tools ?? [];
      const nonSystemTools = allAgentTools.filter(
        (t) =>
          !t.system &&
          !t.name.startsWith('__') &&
          !t.name.startsWith('handoff_to_') &&
          !t.name.startsWith('delegate_to_'),
      );
      const isKBOnly =
        nonSystemTools.length > 0 && nonSystemTools.every((t) => t.tool_type === 'searchai');
      const isSupervisorAgent = session.agentIR?.metadata?.type === 'supervisor';
      const hasInlineGather = inlineGather && gatherFields && gatherFields.length > 0;

      if (isKBOnly && !isSupervisorAgent && !hasInlineGather) {
        const kbFastPathStart = Date.now();

        // Await discovery if still in-flight (needed for tier detection)
        if (session._searchaiDiscoveryReady) {
          await session._searchaiDiscoveryReady;
        }

        // Determine tier — only DOMAIN vocab counts (standard auto-seeded
        // fields like mime_type/source_type are excluded by classifyKBComplexity)
        const searchaiToolNames = nonSystemTools.map((t) => t.name);
        let highestTier: 'simple' | 'filtered' | 'advanced' = 'simple';
        let hasNullTier = false;
        for (const toolName of searchaiToolNames) {
          const tier = session._searchaiToolExecutor.getToolTier(toolName);
          if (tier === null) {
            hasNullTier = true;
            continue;
          }
          if (tier === 'advanced') {
            highestTier = 'advanced';
            break;
          }
          if (tier === 'filtered') highestTier = 'filtered';
        }
        // If any tool has null tier (discovery cache expired), re-discover
        if (hasNullTier && highestTier === 'simple') {
          for (const toolName of searchaiToolNames) {
            const tier = session._searchaiToolExecutor.getToolTier(toolName);
            if (tier === null) {
              await session._searchaiToolExecutor.triggerEagerDiscovery(toolName);
              const newTier = session._searchaiToolExecutor.getToolTier(toolName);
              if (newTier === 'advanced') {
                highestTier = 'advanced';
                break;
              }
              if (newTier === 'filtered') highestTier = 'filtered';
            }
          }
        }

        // Scope all speculative-cache reads/writes for this turn to a
        // freshly-generated turnId. Two consecutive user messages cannot
        // consume each other's speculative results — previously the cache
        // used only `indexId + wall-clock 10s window`, which cross-polluted
        // on retries, double-sends, paste-and-send, and autotext.
        const kbTurnId = randomUUID();
        session._searchaiToolExecutor.setCurrentTurn(kbTurnId);

        const currentTurnToolInput = restorePIITokensForTrustedInternalExecutionText(
          session,
          currentTurnInput,
        );

        // Fire speculative hybrid search immediately — before classify.
        // Runs in parallel. For simple queries the speculative result IS
        // the final result. For filtered queries it's a fallback if the
        // LLM plan has no filters.
        session._searchaiToolExecutor.fireSpeculativeSearch(currentTurnToolInput);

        // Build conversation context
        const priorUserMessages = session.conversationHistory.filter(
          (m) => m.role === 'user' && typeof m.content === 'string' && m.content.trim().length > 0,
        );
        const hasRealConversationHistory = priorUserMessages.length > 1;

        const recentHistory = hasRealConversationHistory
          ? session.conversationHistory
              .filter(
                (m) =>
                  (m.role === 'user' || m.role === 'assistant') &&
                  typeof m.content === 'string' &&
                  m.content.trim().length > 0,
              )
              .slice(-6)
              .map((m) => `${m.role}: ${String(m.content).slice(0, 200)}`)
              .join('\n')
          : '';

        let skipSearch = false;
        let searchQuery = currentTurnInput;
        let searchExecutionQuery = currentTurnToolInput;
        let directResponse: string | null = null;
        let searchPlan: {
          query: string;
          queryType?: string;
          filters?: Array<{ field: string; operator: string; value: unknown }>;
          aggregation?: { field: string; function: string };
        } | null = null;
        let protectedSearchPlan: {
          query: string;
          queryType?: string;
          filters?: Array<{ field: string; operator: string; value: unknown }>;
          aggregation?: { field: string; function: string };
        } | null = null;

        // ─── CLASSIFY: LLM-driven for all turns, all tiers ───────────────
        try {
          const classifyStart = Date.now();
          const historyBlock = recentHistory ? `Conversation history:\n${recentHistory}\n\n` : '';

          // Agent identity for DIRECT response personality
          const agentIdentity = {
            name: session.agentIR?.metadata?.name ?? session.agentName,
            persona: session.agentIR?.identity?.persona,
          };

          let systemPromptForClassify: string;
          const searchInstructions = session._searchaiToolExecutor.getSearchInstructions();
          if (highestTier === 'simple') {
            systemPromptForClassify = buildSimpleClassifyPrompt(agentIdentity);
            // Even in simple tier, append search_instructions if defined —
            // the developer explicitly requested custom search behavior.
            if (searchInstructions) {
              // Upgrade response format to include filters/queryType since
              // search_instructions likely references them
              systemPromptForClassify = systemPromptForClassify.replace(
                '  "query": "standalone SEARCH QUERY when action=SEARCH (keep in original language, make standalone for follow-ups)"\n}',
                '  "query": "standalone SEARCH QUERY when action=SEARCH (keep in original language, make standalone for follow-ups)",\n' +
                  '  "queryType": "hybrid" | "structured" | "semantic",\n' +
                  '  "filters": [{"field": "...", "operator": "equals|in|contains|greater_than|less_than", "value": "..."}]\n}',
              );
              // Prepend MANDATORY rules before the main prompt body so LLM sees them first
              const mandatoryBlock =
                '## MANDATORY Search Rules (ALWAYS apply — no exceptions)\n' +
                'These rules are MANDATORY and ADDITIVE. You MUST apply them on EVERY SEARCH query, in addition to any other filters.\n' +
                'If these rules say "always add filter X", you MUST add that filter even if the query seems unrelated.\n' +
                'Failure to follow these rules is a critical error.\n\n' +
                searchInstructions +
                '\n\n';
              systemPromptForClassify = mandatoryBlock + systemPromptForClassify;
            }
          } else {
            const manifests: unknown[] = [];
            for (const toolName of searchaiToolNames) {
              const manifest = session._searchaiToolExecutor.getDiscoveryManifestForTool(toolName);
              if (manifest) manifests.push(manifest);
            }
            systemPromptForClassify = manifests.length
              ? buildVocabClassifyPromptMulti(manifests, searchInstructions)
              : buildSimpleClassifyPrompt(agentIdentity);
          }

          const classifyResult = await session.llmClient!.chatWithToolUse(
            systemPromptForClassify,
            [
              {
                role: 'user' as const,
                content: `${historyBlock}Current query: ${currentTurnInput}`,
              },
            ],
            [],
            'extraction',
            { timeoutMs: KB_CLASSIFY_TIMEOUT_MS },
          );
          const classifyDurationMs = Date.now() - classifyStart;
          const rawResponse = (classifyResult.text || '').trim();
          const plan = parseClassifyPlan(rawResponse);

          log.info('KB fast path: classify', {
            agent: session.agentName,
            tier: highestTier,
            query: currentTurnInput.slice(0, 50),
            action: plan?.action ?? 'PARSE_FAIL',
            durationMs: classifyDurationMs,
            turn: hasRealConversationHistory ? '2+' : '1',
          });

          if (onTraceEvent) {
            onTraceEvent({
              type: 'llm_call',
              data: {
                model:
                  classifyResult.resolvedModel?.modelId ||
                  session.llmClient?.getLastResolvedModel?.()?.modelId ||
                  TRACE_MODEL_UNKNOWN,
                provider:
                  classifyResult.resolvedModel?.provider ||
                  session.llmClient?.getLastResolvedModel?.()?.provider,
                operationType: highestTier === 'simple' ? 'kb_classify' : 'kb_classify_vocab',
                responseContribution: 'internal_only',
                agent: session.agentName,
                durationMs: classifyDurationMs,
                response: rawResponse.slice(0, 200),
                query: currentTurnInput.slice(0, 200),
                classification: plan?.action ?? 'PARSE_FAIL',
                tier: highestTier,
                hasToolCalls: false,
                toolCallCount: 0,
                iteration: 0,
                usage: classifyResult.usage,
                tokensIn: classifyResult.usage?.inputTokens ?? 0,
                tokensOut: classifyResult.usage?.outputTokens ?? 0,
                totalTokens:
                  (classifyResult.usage?.inputTokens ?? 0) +
                  (classifyResult.usage?.outputTokens ?? 0),
              },
            });
          }

          if (plan?.action === 'DIRECT') {
            skipSearch = true;
            if (plan.response) directResponse = plan.response;
          } else if (plan?.action === 'SEARCH') {
            searchQuery = plan.query && plan.query.length > 0 ? plan.query : currentTurnInput;
            searchExecutionQuery = restorePIITokensForTrustedInternalExecutionText(
              session,
              searchQuery,
            );
            // Always build search plan — LLM decides filters/aggregation
            // regardless of tier. The classify prompt includes filters in
            // its schema for all tiers when search_instructions is present,
            // and for filtered/advanced tiers by default.
            if (plan.filters?.length || plan.queryType || plan.aggregation) {
              protectedSearchPlan = {
                query: searchQuery,
                queryType: plan.queryType,
                filters: plan.filters,
                aggregation: plan.aggregation,
              };
              searchPlan = {
                query: searchExecutionQuery,
                queryType: plan.queryType,
                filters: restorePIITokensForTrustedInternalExecution(
                  session,
                  plan.filters,
                ) as Array<{
                  field: string;
                  operator: string;
                  value: unknown;
                }>,
                aggregation: plan.aggregation,
              };
            }
          } else {
            log.warn('KB fast path: classify plan unparsable, defaulting to raw search', {
              rawResponse: rawResponse.slice(0, 100),
            });
          }
        } catch (err) {
          log.warn('KB fast path: classify failed, defaulting to search', {
            tier: highestTier,
            error: err instanceof Error ? err.message : String(err),
          });
        }

        // ─── SEARCH: Execute based on classify result ──────────────────
        if (!skipSearch) {
          try {
            const preSearchResults = searchPlan
              ? await session._searchaiToolExecutor.executePreSearchWithPlan(searchPlan)
              : await session._searchaiToolExecutor.executePreSearch(searchExecutionQuery);

            if (preSearchResults.length > 0) {
              const syntheticInput: Record<string, unknown> = protectedSearchPlan
                ? {
                    query: protectedSearchPlan.query,
                    queryType: protectedSearchPlan.queryType || 'hybrid',
                    ...(protectedSearchPlan.filters?.length
                      ? { filters: protectedSearchPlan.filters }
                      : {}),
                    ...(protectedSearchPlan.aggregation
                      ? { aggregation: protectedSearchPlan.aggregation }
                      : {}),
                  }
                : { query: searchQuery, queryType: 'hybrid' };

              // ── KB fast path: tool_output guardrails on chunks ──────────
              // Paths 2 (tool loop) and 3 (flow executor) evaluate tool_output
              // guardrails on search results before the LLM sees them. The fast
              // path previously skipped this — apply the same check here so all
              // three paths have guardrail parity on retrieved chunk content.
              const fpDslGuardrails = session.agentIR?.constraints?.guardrails ?? [];
              const fpToolPolicy = await getSessionPolicy(session);
              const fpAllGuardrails = [
                ...fpDslGuardrails,
                ...(fpToolPolicy?.additionalGuardrails ?? []),
              ];
              if (fpAllGuardrails.some((g) => g.kind === 'tool_output')) {
                for (const preResult of preSearchResults) {
                  try {
                    if (session.tenantId) await ensureTenantProvidersLoaded(session.tenantId);
                    const fpLlmEval = session.llmClient
                      ? createLLMEvalFromClient(session.llmClient)
                      : undefined;
                    const fpPipeline = createGuardrailPipeline(
                      fpLlmEval,
                      session.tenantId,
                      session.projectId,
                      {
                        policy: fpToolPolicy,
                        piiRecognizerRegistry: session.piiRecognizerRegistry,
                        cacheScopeKey: getSessionGuardrailCacheScopeKey(session),
                      },
                    );
                    const chunkContent = JSON.stringify(preResult.formattedResult);
                    const fpGuardrailResult = await fpPipeline.execute(
                      fpDslGuardrails,
                      chunkContent,
                      'tool_output',
                      {
                        toolName: preResult.toolName,
                        toolResult: preResult.formattedResult as Record<string, unknown>,
                        toolSuccess: true,
                        agentGoal: session.agentIR?.identity?.goal,
                      },
                      onTraceEvent
                        ? (event) =>
                            onTraceEvent({
                              type: 'guardrail_check',
                              data: event as Record<string, unknown>,
                            })
                        : undefined,
                      fpToolPolicy,
                    );

                    if (!fpGuardrailResult.passed) {
                      const violationMsg =
                        fpGuardrailResult.primaryViolation?.message ??
                        formatErrorSync('GUARDRAIL_TOOL_OUTPUT_BLOCKED').message;
                      preResult.formattedResult = {
                        error: violationMsg,
                        guardrail: fpGuardrailResult.primaryViolation?.name,
                      };
                      onTraceEvent?.(
                        traceToolOutputBlocked({
                          toolName: preResult.toolName,
                          guardrailName: fpGuardrailResult.primaryViolation?.name ?? 'unknown',
                          reason: fpGuardrailResult.primaryViolation?.action ?? 'block',
                          agent: session.agentName,
                        }),
                      );
                    } else if (fpGuardrailResult.modifiedContent) {
                      try {
                        preResult.formattedResult = JSON.parse(fpGuardrailResult.modifiedContent);
                      } catch {
                        log.warn(
                          'Guardrail modified fast-path tool output is not valid JSON, using original',
                          { toolName: preResult.toolName },
                        );
                      }
                    }
                  } catch (guardrailErr) {
                    // Fail-open: pipeline errors should NOT block search results
                    log.warn('KB fast path tool_output guardrail failed, using original result', {
                      toolName: preResult.toolName,
                      error:
                        guardrailErr instanceof Error ? guardrailErr.message : String(guardrailErr),
                    });
                    onTraceEvent?.({
                      type: 'guardrail_pipeline_error',
                      data: {
                        toolName: preResult.toolName,
                        kind: 'tool_output',
                        error:
                          guardrailErr instanceof Error
                            ? guardrailErr.message
                            : String(guardrailErr),
                        agent: session.agentName,
                        kbFastPath: true,
                      },
                    });
                  }
                }
              }

              // Inject results into messages as synthetic tool_use + tool_result pairs.
              // Strip citation metadata (_sourceUrl, _documentId, etc.) so the LLM
              // uses [1], [2] markers instead of raw URLs in its response.
              for (const preResult of preSearchResults) {
                const syntheticToolCallId = `kb_presearch_${preResult.toolName}`;

                messages.push({
                  role: 'assistant' as const,
                  content: [
                    {
                      type: 'tool_use',
                      id: syntheticToolCallId,
                      name: preResult.toolName,
                      input: syntheticInput,
                    },
                  ] as any,
                });

                // Send only title + content + resultIndex to LLM (no URLs/metadata)
                const llmSafeResult =
                  typeof session._searchaiToolExecutor.stripCitationMetadataForLLM === 'function'
                    ? session._searchaiToolExecutor.stripCitationMetadataForLLM(
                        preResult.formattedResult,
                      )
                    : preResult.formattedResult;
                const resultContent = JSON.stringify(llmSafeResult);
                log.info('KB fast path: tool_result injected (FULL, not truncated)', {
                  toolName: preResult.toolName,
                  contentLength: resultContent.length,
                  resultCount: preResult.formattedResult?.results?.length ?? 0,
                  endsWithBrace: resultContent.endsWith('}'),
                });
                messages.push({
                  role: 'user' as const,
                  content: [
                    {
                      type: 'tool_result',
                      tool_use_id: syntheticToolCallId,
                      content: resultContent,
                    },
                  ] as any,
                });

                if (onTraceEvent) {
                  onTraceEvent({
                    type: 'tool_call',
                    data: {
                      phase: 'complete',
                      toolName: preResult.toolName,
                      input: syntheticInput,
                      output: preResult.formattedResult,
                      success: true,
                      latencyMs: preResult.searchLatencyMs,
                      isActionTool: false,
                      agent: session.agentName,
                      kbFastPath: true,
                      tier: highestTier,
                    },
                  });
                }
              }

              // Remove KB tools — results already injected
              tools = tools.filter(
                (t) =>
                  t.name.startsWith('__') ||
                  t.name.startsWith('handoff_to_') ||
                  t.name.startsWith('delegate_to_'),
              );

              kbFastPathUsed = true;

              // ── Lean synthesis prompt ──────────────────────────────
              const ir = session.agentIR;
              const agentName = ir?.metadata?.name ?? session.agentName ?? 'AI assistant';
              const persona = ir?.identity?.persona;
              const goal = ir?.identity?.goal;
              const limitations = ir?.identity?.limitations;
              const leanParts: string[] = [`You are ${agentName}, an AI assistant.`];
              if (goal) leanParts.push(`Your goal: ${goal}`);
              if (persona) leanParts.push(`Persona: ${persona}`);
              if (limitations?.length) leanParts.push(`Limitations:\n${limitations.join('\n')}`);
              // Check if citations are enabled via discovery manifest
              const citationsEnabled = (() => {
                for (const toolName of searchaiToolNames) {
                  const m = session._searchaiToolExecutor.getDiscoveryManifestForTool(toolName);
                  if (m?.citationConfig?.enabled === false) return false;
                }
                return true;
              })();

              leanParts.push(
                "Answer the user's question using ONLY the search results provided in the conversation. " +
                  "Be concise and direct. If the results don't contain the answer, say so honestly. " +
                  'Do not make up information beyond what the search results show. ' +
                  'IMPORTANT: Always respond in the SAME language the user used in their query.' +
                  (citationsEnabled ? CITATION_INSTRUCTION : ''),
              );
              systemPrompt = leanParts.join('\n');

              // ── Trim messages to essentials ────────────────────────
              const injectedCount = preSearchResults.length * 2;
              const priorMessages = messages.length - injectedCount;
              const keepPrior = Math.min(priorMessages, 5);
              if (priorMessages > keepPrior) {
                messages = [
                  ...messages.slice(priorMessages - keepPrior, priorMessages),
                  ...messages.slice(priorMessages),
                ];
              }
            }

            const totalPreSearchMs = Date.now() - kbFastPathStart;
            if (onTraceEvent) {
              onTraceEvent({
                type: 'kb_fast_path' as any,
                data: {
                  agent: session.agentName,
                  kbToolCount: preSearchResults.length,
                  tier: highestTier,
                  hadHistory: hasRealConversationHistory,
                  rephrased: searchQuery !== currentTurnInput,
                  totalLatencyMs: totalPreSearchMs,
                  searchResults: preSearchResults.map((r) => ({
                    toolName: r.toolName,
                    resultCount: r.formattedResult?.results?.length ?? 0,
                    searchLatencyMs: r.searchLatencyMs,
                  })),
                },
              });
            }

            log.info('KB fast path: results injected', {
              agent: session.agentName,
              hadHistory: hasRealConversationHistory,
              rephrased: searchQuery !== currentTurnInput,
              totalLatencyMs: Date.now() - kbFastPathStart,
              resultCount: preSearchResults.reduce(
                (sum, r) => sum + (r.formattedResult?.results?.length ?? 0),
                0,
              ),
            });

            // ── Build citation map from pre-search results ──────────
            // Re-check citationsEnabled outside the lean-prompt block scope
            const citationsEnabledForMap = (() => {
              for (const toolName of searchaiToolNames) {
                const m = session._searchaiToolExecutor.getDiscoveryManifestForTool(toolName);
                if (m?.citationConfig?.enabled === false) return false;
              }
              return true;
            })();
            if (citationsEnabledForMap && preSearchResults.length > 0) {
              // Merge all results across KB tools for a single citation list
              const allFormattedResults: Array<{
                title?: string;
                content: string;
                _sourceUrl?: string;
                _documentId?: string;
                _sourceType?: string;
                _sourceKey?: string;
              }> = [];
              for (const preResult of preSearchResults) {
                const results = preResult.formattedResult?.results;
                if (Array.isArray(results)) {
                  allFormattedResults.push(...results);
                }
              }
              // Get citationConfig from first manifest
              let citationCfg: {
                enabled: boolean;
                linkMode?: string;
                linkTtlSeconds?: number;
                maxClicks?: number;
              } | null = null;
              for (const toolName of searchaiToolNames) {
                const m = session._searchaiToolExecutor.getDiscoveryManifestForTool(toolName);
                if (m?.citationConfig) {
                  citationCfg = m.citationConfig;
                  break;
                }
              }
              finalCitations = session._searchaiToolExecutor.buildCitationMap(
                { results: allFormattedResults },
                citationCfg,
                {
                  tenantId: session.tenantId ?? '',
                  indexId: preSearchResults[0]?.toolName
                    ? session._searchaiToolExecutor.getIndexIdForTool(preSearchResults[0].toolName)
                    : undefined,
                },
              );
            }
          } catch (err) {
            log.warn('KB fast path: pre-search failed, falling back to tool loop', {
              error: err instanceof Error ? err.message : String(err),
            });
          }
        } else {
          // DIRECT path — classify LLM already generated the conversational
          // response. We can short-circuit ONLY when the agent has no
          // output-side policy that must inspect the final text. Otherwise
          // the classifier's raw text would bypass response checkpoints and
          // output guardrails entirely, violating the agent's opt-in policy.
          kbFastPathUsed = true;

          const totalMs = Date.now() - kbFastPathStart;
          const canShortCircuit = !mustDelayStreamedOutput;
          if (onTraceEvent) {
            onTraceEvent({
              type: 'kb_fast_path' as any,
              data: {
                agent: session.agentName,
                tier: highestTier,
                classification: 'DIRECT',
                hadHistory: hasRealConversationHistory,
                directResponse: !!directResponse,
                totalLatencyMs: totalMs,
                guardrailDeferred: !canShortCircuit,
              },
            });
          }

          if (directResponse && canShortCircuit) {
            // No output guardrails / response checkpoints configured — safe
            // to stream the classifier's reply directly and skip synthesis.
            const protectedDirectResult = emitProtectedExecutionResult(
              session,
              {
                response: directResponse,
                action: { type: 'respond' },
                stateUpdates: buildStateUpdates(session),
              },
              onChunk,
            );
            finalResponse = protectedDirectResult.result.response;
            finalAction = protectedDirectResult.result.action;

            log.info('KB fast path: DIRECT short-circuit (no synthesis LLM)', {
              agent: session.agentName,
              responseLength: directResponse.length,
              totalLatencyMs: totalMs,
            });

            return protectedDirectResult.result;
          }

          // Fall through to synthesis:
          //   - classify said DIRECT but didn't include response text, OR
          //   - agent has output guardrails / response checkpoints (must
          //     run against the final assistant text).
          // Remove KB tools so the normal loop synthesizes a fresh reply
          // without re-searching.
          tools = tools.filter(
            (t) =>
              t.name.startsWith('__') ||
              t.name.startsWith('handoff_to_') ||
              t.name.startsWith('delegate_to_'),
          );
          log.info('KB fast path: DIRECT routed to synthesis', {
            agent: session.agentName,
            hasDirectResponse: !!directResponse,
            guardrailDeferred: !canShortCircuit,
            totalLatencyMs: totalMs,
          });
        }
      } else {
        // Not KB-only — still fire speculative hybrid so the tool loop's
        // search tool call can reuse it. Scope by a fresh turnId to keep
        // the same cross-turn isolation guarantee as the fast path.
        session._searchaiToolExecutor.setCurrentTurn(randomUUID());
        session._searchaiToolExecutor.fireSpeculativeSearch(currentTurnInput);
      }
    }

    // --- ON_ERROR: Wrap reasoning loop for non-tool error routing ---
    try {
      let supervisorRoutingToolExecuted = false;
      // Accumulate raw searchai tool results for citation map building (tool loop path).
      // Declared outside the while loop to persist across iterations.
      const searchToolResults: Array<{
        toolName: string;
        formattedResult: { results?: Array<Record<string, unknown>> };
      }> = [];
      while (iterations < maxIterations) {
        iterations++;
        streamedText = false;

        // Streaming strategy: stream directly only when we do not need to hold
        // text for response checkpoints/output guardrails. Supervisor agents
        // still buffer so we can suppress text when all tool calls are system
        // tools, and response/output safeguards force the same buffered path.
        const isSupervisor = session.agentIR?.metadata?.type === 'supervisor';
        const hasOnlySystemTools =
          isSupervisor &&
          tools.every(
            (t) =>
              t.name.startsWith('__') ||
              t.name.startsWith('handoff_to_') ||
              t.name.startsWith('delegate_to_'),
          );
        const shouldBufferPIIOutput = shouldRedactRawOutputPII(session);
        const shouldBufferStreamedOutput =
          hasOnlySystemTools || mustDelayStreamedOutput || shouldBufferPIIOutput;

        let iterBuffer = '';
        let emittedTextThisIteration = false;
        const bufferChunk = onChunk
          ? (chunk: string) => {
              emittedTextThisIteration = true;
              iterBuffer += chunk;
            }
          : undefined;
        const directStreamChunk = onChunk
          ? (chunk: string) => {
              emittedTextThisIteration = true;
              const safeChunk = this.filterChunkPII(session, chunk);
              if (safeChunk) {
                onChunk(safeChunk);
              }
            }
          : undefined;

        // Stream directly only when buffered post-generation validation is unnecessary.
        const streamCallback = shouldBufferStreamedOutput ? bufferChunk : directStreamChunk;

        // Truncate old tool results to save tokens on later iterations
        const compactionPolicy = resolveCompactionPolicy(session);
        truncateOldToolResults(messages, iterations, compactionPolicy.tool_results.keep_recent);

        // Call LLM with tools — uses streaming when useStreaming is enabled.
        // Supervisors only allow parallel routing tool calls when their
        // effective multi-intent strategy can legally fan out work.
        const supervisorParallelRouting = resolveSupervisorParallelRoutingPolicy(session);
        const disableParallelToolUse = isSupervisor && !supervisorParallelRouting.enabled;
        // Generate a stable ID for this LLM call iteration so tool_thought
        // events can correlate back to their parent llm_call event.
        const llmCallId = randomUUID();
        const llmStart = Date.now();
        // ABLP-715: force tool choice only when every available tool is an
        // actual routing control tool. Memory tools such as __set_context__ are
        // not routing decisions; forcing them can make the model fabricate
        // prerequisite values instead of asking the user.
        const forceRoutingToolChoice = shouldForceSupervisorRoutingToolChoice(isSupervisor, tools);
        const result = await session.llmClient!.chatWithToolUseStreamable(
          systemPrompt,
          messages,
          tools,
          'response_gen',
          streamCallback,
          {
            ...(forceRoutingToolChoice ? { toolChoice: 'any' as const } : {}),
            ...(disableParallelToolUse ? { disableParallelToolUse: true } : {}),
            ...(isVoiceChannel(session) ? { forceStreaming: true } : {}),
          },
        );
        const llmDurationMs = Date.now() - llmStart;
        const willRetrySupervisorRouting =
          result.toolCalls.length === 0 &&
          !supervisorRoutingToolExecuted &&
          shouldRepairSupervisorRoutingTurn({
            session,
            tools,
            userMessage: currentTurnInput,
            responseText: result.text,
          }) &&
          supervisorRoutingRepairAttempts < SUPERVISOR_ROUTING_REPAIR_MAX_RETRIES;

        if (onTraceEvent) {
          // Build a compact messages snapshot for trace display.
          // Includes text, tool_use, and tool_result messages so the debug UI
          // can show the full conversation including fan-out round-trips.
          const traceMessages = messages.slice(-20).map((m) => {
            if (typeof m.content === 'string') {
              return { role: m.role, content: m.content.slice(0, 2000) };
            }
            // Content blocks: tool_use (assistant), tool_result (user), text, image, etc.
            if (Array.isArray(m.content)) {
              const blocks = (m.content as unknown as Array<Record<string, unknown>>).map(
                (block) => {
                  if (block.type === 'text') {
                    return { type: 'text', text: String(block.text || '').slice(0, 2000) };
                  }
                  if (block.type === 'tool_use') {
                    return { type: 'tool_use', id: block.id, name: block.name, input: block.input };
                  }
                  if (block.type === 'tool_result') {
                    const content = String(block.content || '');
                    return {
                      type: 'tool_result',
                      tool_use_id: block.tool_use_id,
                      content: content.slice(0, 4000),
                    };
                  }
                  return { type: block.type };
                },
              );
              return { role: m.role, content: blocks };
            }
            return { role: m.role, content: String(m.content).slice(0, 2000) };
          });

          const traceUsage = result.usage;
          const traceInputTokens = traceUsage?.inputTokens || 0;
          const traceOutputTokens = traceUsage?.outputTokens || 0;

          const llmTraceData: Record<string, unknown> = {
            llmCallId,
            model:
              result.resolvedModel?.modelId ||
              session.llmClient?.getLastResolvedModel?.()?.modelId ||
              TRACE_MODEL_UNKNOWN,
            provider:
              result.resolvedModel?.provider ||
              session.llmClient?.getLastResolvedModel?.()?.provider,
            source:
              result.resolvedModel?.source || session.llmClient?.getLastResolvedModel?.()?.source,
            operationType: 'response_gen',
            responseContribution: willRetrySupervisorRouting ? 'internal_only' : 'customer_visible',
            ...(willRetrySupervisorRouting
              ? { responseSuppressedReason: 'supervisor_routing_repair' }
              : {}),
            iteration: iterations,
            agent: session.agentName,
            hasToolCalls: result.toolCalls.length > 0,
            toolCallCount: result.toolCalls.length,
            stopReason: result.stopReason,
            durationMs: llmDurationMs,
            usage: traceUsage,
            // Flat token fields for direct bridge access
            tokensIn: traceInputTokens,
            tokensOut: traceOutputTokens,
            totalTokens: traceInputTokens + traceOutputTokens,
            // Whether this iteration used direct streaming (not buffered)
            streaming: !shouldBufferStreamedOutput && emittedTextThisIteration,
            streamingBuffered: shouldBufferStreamedOutput && emittedTextThisIteration,
            messages: traceMessages,
            response: result.text?.slice(0, 2000) || '',
          };

          // Cache token metrics (all providers — Anthropic + OpenAI)
          // cacheCreationInputTokens: Anthropic-only (explicit cache creation)
          // cacheReadInputTokens: Both providers (cached prompt tokens that were reused)
          if (traceUsage?.cacheCreationInputTokens != null) {
            llmTraceData.cacheCreationTokens = traceUsage.cacheCreationInputTokens;
          }
          if (traceUsage?.cacheReadInputTokens != null) {
            llmTraceData.cacheReadTokens = traceUsage.cacheReadInputTokens;
          }

          // Tool call details and system prompt for debugging
          llmTraceData.toolCalls = result.toolCalls.map((tc) => ({
            id: tc.id,
            name: tc.name,
            input: tc.input,
          }));
          llmTraceData.systemPrompt = systemPrompt.slice(0, 4000);
          llmTraceData.tools = tools.map((t) => ({
            name: t.name,
            description: t.description,
            input_schema: t.input_schema,
          }));

          // Compute cost from model pricing
          const modelId = result.resolvedModel?.modelId || TRACE_MODEL_UNKNOWN;
          if (
            modelId !== TRACE_MODEL_UNKNOWN &&
            hasKnownPricing(modelId) &&
            (traceInputTokens > 0 || traceOutputTokens > 0)
          ) {
            const caps = getModelCapabilities(modelId);
            llmTraceData.cost = calculateCost(
              caps.inputCostPer1k,
              caps.outputCostPer1k,
              traceInputTokens,
              traceOutputTokens,
            );
          }

          onTraceEvent({
            type: 'llm_call',
            data: llmTraceData,
          });
        }

        if (isLlmProviderErrorResult(result)) {
          const stopReasonError = buildLlmProviderResultError(result);
          const diagnostic = classifyExecutionConfigurationDiagnostic(stopReasonError);
          const errorEnvelope = buildRuntimeErrorEnvelope(stopReasonError, {
            traceId: getCurrentTraceId() ?? undefined,
            agentName: session.agentName,
          });

          onTraceEvent?.({
            type: 'error',
            data: {
              message: stopReasonError.message,
              agent: session.agentName,
              stopReason: result.stopReason,
              ...(result.kind === 'provider_error' ? { providerError: result.providerError } : {}),
              model: result.resolvedModel?.modelId ?? TRACE_MODEL_UNKNOWN,
              provider: result.resolvedModel?.provider,
              ...(diagnostic ? { diagnostic } : {}),
              ...(errorEnvelope ? { errorEnvelope } : {}),
            },
          });

          throw stopReasonError;
        }

        // Track consecutive empty responses
        if (!result.text && result.toolCalls.length === 0) {
          consecutiveEmptyResponses++;
          if (consecutiveEmptyResponses >= MAX_CONSECUTIVE_EMPTY_RESPONSES) {
            if (onTraceEvent) {
              onTraceEvent({
                type: 'warning',
                data: {
                  message: 'Consecutive empty LLM responses — breaking loop',
                  agent: session.agentName,
                  iterations,
                  consecutiveEmpty: consecutiveEmptyResponses,
                },
              });
            }
            break;
          }
        } else {
          consecutiveEmptyResponses = 0;
        }

        // If there are tool calls, execute them
        if (result.toolCalls.length > 0) {
          // Application-level guard for providers that don't support
          // disableParallelToolUse (Gemini, Cohere, etc.).
          //
          // If a supervisor returns multiple __handoff__/__delegate__ calls,
          // synthesize a single __fan_out__ call so all intents are preserved.
          // For mixed system tool types (e.g. handoff + escalate), keep only
          // the first — fan_out conversion doesn't apply.
          let effectiveToolCalls = result.toolCalls;
          if (
            isSupervisor &&
            result.toolCalls.length > 1 &&
            result.toolCalls.every(
              (tc) =>
                tc.name.startsWith('__') ||
                tc.name.startsWith('handoff_to_') ||
                tc.name.startsWith('delegate_to_'),
            )
          ) {
            const routableCalls = result.toolCalls.filter(
              (tc) =>
                tc.name === SYSTEM_TOOL_HANDOFF ||
                tc.name === SYSTEM_TOOL_DELEGATE ||
                tc.name.startsWith('handoff_to_') ||
                tc.name.startsWith('delegate_to_'),
            );
            if (routableCalls.length === result.toolCalls.length && routableCalls.length >= 2) {
              const userMessage = resolveCurrentTurnInput(session) || 'Handle user request';
              if (!supervisorParallelRouting.enabled) {
                log.warn(
                  'Supervisor returned parallel handoffs but effective multi-intent strategy does not allow fan-out batching',
                  {
                    agent: session.agentName,
                    multiIntentEnabled: supervisorParallelRouting.multiIntentEnabled,
                    multiIntentStrategy: supervisorParallelRouting.strategy,
                    toolCalls: result.toolCalls.map((tc) => ({
                      name: tc.name,
                      target: tc.input?.target,
                    })),
                  },
                );
                effectiveToolCalls = [result.toolCalls[0]];

                if (onTraceEvent) {
                  onTraceEvent({
                    type: 'decision',
                    data: {
                      decision: 'parallel_handoffs_blocked_by_strategy',
                      message:
                        `Ignored ${routableCalls.length - 1} extra parallel handoff calls because ` +
                        `multi-intent strategy ${supervisorParallelRouting.strategy ?? 'disabled'} ` +
                        'does not allow fan-out batching.',
                      agent: session.agentName,
                      multiIntentEnabled: supervisorParallelRouting.multiIntentEnabled,
                      multiIntentStrategy: supervisorParallelRouting.strategy,
                      originalCalls: result.toolCalls.map((tc) => tc.name),
                    },
                  });
                }
              } else {
                const fanOutPlanResult = buildSupervisorRoutingToolFanOutPlan({
                  sessionId: session.id,
                  agentName: session.agentName,
                  toolCalls: routableCalls,
                  userMessage,
                  onTraceEvent,
                });

                if (fanOutPlanResult?.fanOutTasks?.length) {
                  log.warn('Supervisor returned parallel handoffs — converting to __fan_out__', {
                    agent: session.agentName,
                    multiIntentEnabled: supervisorParallelRouting.multiIntentEnabled,
                    multiIntentStrategy: supervisorParallelRouting.strategy,
                    toolCalls: result.toolCalls.map((tc) => ({
                      name: tc.name,
                      target: tc.input?.target,
                    })),
                  });

                  const synthesizedFanOut: ToolCall = {
                    id: result.toolCalls[0].id,
                    name: SYSTEM_TOOL_FAN_OUT,
                    input: {
                      reason: 'Converted from parallel routing tool calls',
                      tasks: fanOutPlanResult.fanOutTasks.map((task) => ({
                        type: 'agent' as const,
                        target: task.target,
                        intent: task.intent,
                        ...(task.context ? { context: task.context } : {}),
                      })),
                    },
                  };
                  effectiveToolCalls = [synthesizedFanOut];

                  if (onTraceEvent) {
                    onTraceEvent({
                      type: 'decision',
                      data: {
                        decision: 'parallel_handoffs_to_fan_out',
                        message: `Converted ${routableCalls.length} parallel handoff calls to __fan_out__`,
                        agent: session.agentName,
                        multiIntentEnabled: supervisorParallelRouting.multiIntentEnabled,
                        multiIntentStrategy: supervisorParallelRouting.strategy,
                        originalCalls: result.toolCalls.map((tc) => tc.name),
                        targets: fanOutPlanResult.fanOutTasks.map((task) => task.target),
                      },
                    });
                  }
                } else {
                  log.warn('Unable to build supervisor routing fan-out plan, keeping first call', {
                    agent: session.agentName,
                    multiIntentEnabled: supervisorParallelRouting.multiIntentEnabled,
                    multiIntentStrategy: supervisorParallelRouting.strategy,
                    toolCalls: result.toolCalls.map((tc) => tc.name),
                  });
                  effectiveToolCalls = [result.toolCalls[0]];
                }
              }
            } else {
              // Mixed system tool types — keep only the first
              log.warn('Supervisor returned multiple system tool calls — keeping only first', {
                agent: session.agentName,
                toolCalls: result.toolCalls.map((tc) => tc.name),
              });
              effectiveToolCalls = [result.toolCalls[0]];
            }
          }

          // Add assistant message with content blocks.
          // Always preserve original rawContent (including providerMetadata such as
          // Gemini thoughtSignatures). When we synthesized a fan_out from parallel
          // handoffs, the fan_out is executed internally but the message history
          // keeps the original tool calls so providers that require round-trip
          // metadata (like Gemini's thoughtSignature) continue to work.
          const wasSynthesized =
            effectiveToolCalls.length === 1 &&
            effectiveToolCalls[0].name === SYSTEM_TOOL_FAN_OUT &&
            result.toolCalls.length > 1;
          messages.push({
            role: 'assistant',
            content: result.rawContent,
          });

          // Flush buffered text for non-system-tool rounds. System-tool rounds
          // (handoff, delegate, etc.) have their text suppressed — the thought
          // card provides the reasoning context instead.
          const allSystemTools = effectiveToolCalls.every(
            (tc) =>
              tc.name.startsWith('__') ||
              tc.name.startsWith('handoff_to_') ||
              tc.name.startsWith('delegate_to_'),
          );
          let emittedCustomerInterimThisIteration = false;
          if (
            !allSystemTools &&
            hasOnlySystemTools &&
            !mustDelayStreamedOutput &&
            iterBuffer &&
            onChunk
          ) {
            // Supervisor agent that produced non-system tool calls — flush buffer
            onChunk(this.filterChunkPII(session, iterBuffer) + '\n\n');
            streamedText = true;
            emittedCustomerInterimThisIteration = true;
          } else if (!allSystemTools && shouldBufferPIIOutput && iterBuffer && onChunk) {
            // PII-aware rendering needs the complete generated text so custom
            // patterns and disabled built-ins resolve before any user-visible text.
            onChunk(this.filterChunkPII(session, iterBuffer) + '\n\n');
            streamedText = true;
            emittedCustomerInterimThisIteration = true;
          } else if (
            !allSystemTools &&
            !shouldBufferStreamedOutput &&
            onChunk &&
            emittedTextThisIteration
          ) {
            // Specialist agent — text was already streamed directly via onChunk.
            // Just send the separator.
            onChunk('\n\n');
            streamedText = true;
            emittedCustomerInterimThisIteration = true;
          }

          if (emittedCustomerInterimThisIteration && result.text) {
            appendOutputMessage('interim', this.filterChunkPII(session, result.text), {
              deliveredToUser: true,
            });
          }

          // Execute tools: parallel for regular tools, serial for system tools.
          // System tools (handoff, delegate, fan_out, etc.) have side effects
          // and breakLoop semantics that require serial execution.
          const toolResults: Array<ToolResultContent> = [];
          let shouldBreak = false;

          const isSystemToolCall = (name: string) =>
            name.startsWith('__') ||
            name.startsWith('handoff_to_') ||
            name.startsWith('delegate_to_');

          const regularToolCalls = effectiveToolCalls.filter((tc) => !isSystemToolCall(tc.name));
          const systemToolCalls = effectiveToolCalls.filter((tc) => isSystemToolCall(tc.name));

          if (
            isSupervisor &&
            systemToolCalls.some(
              (tc) =>
                tc.name === SYSTEM_TOOL_HANDOFF ||
                tc.name === SYSTEM_TOOL_DELEGATE ||
                tc.name === SYSTEM_TOOL_FAN_OUT ||
                tc.name.startsWith('handoff_to_') ||
                tc.name.startsWith('delegate_to_'),
            )
          ) {
            supervisorRoutingToolExecuted = true;
          }

          // Execute regular tools in parallel
          if (regularToolCalls.length > 0) {
            const parallelResults = await Promise.all(
              regularToolCalls.map(async (toolCall) => {
                const { toolResult, action, breakLoop } = await this.executeToolCall(
                  session,
                  toolCall,
                  onChunk,
                  onTraceEvent,
                  llmCallId,
                );
                return { toolCall, toolResult, action, breakLoop };
              }),
            );

            for (const { toolCall, toolResult, action, breakLoop } of parallelResults) {
              // Stash raw searchai results BEFORE truncation strips citation metadata
              if (
                session._searchaiToolExecutor &&
                toolCall.name &&
                typeof toolResult === 'object' &&
                toolResult !== null &&
                session._searchaiToolExecutor.getDiscoveryManifestForTool(toolCall.name)
              ) {
                searchToolResults.push({
                  toolName: toolCall.name,
                  formattedResult: toolResult as {
                    results?: Array<Record<string, unknown>>;
                  },
                });
              }

              const truncated = await this.compressAndTruncateToolResult(
                session,
                toolCall,
                toolResult,
                onTraceEvent,
              );

              toolResults.push({
                type: 'tool_result',
                tool_use_id: toolCall.id,
                content: truncated,
              });

              if (breakLoop && !shouldBreak) {
                shouldBreak = true;
                if (action) {
                  finalAction = action;
                }
                finalResponse = extractBreakLoopResponse(toolResult) ?? '';
                const structuredBreakLoopResult = protectBreakLoopStructuredResult(
                  session,
                  extractBreakLoopStructuredResult(toolResult),
                );
                if (structuredBreakLoopResult) {
                  finalVoiceConfig = structuredBreakLoopResult.voiceConfig;
                  finalRichContent = structuredBreakLoopResult.richContent;
                  finalActions = structuredBreakLoopResult.actions;
                  finalLocalization = structuredBreakLoopResult.localization;
                }
                if (!finalResponse && action?.message && typeof action.message === 'string') {
                  finalResponse = action.message;
                }
              } else if (!shouldBreak && action) {
                finalAction = action;
              }
            }
          }

          // Execute system tools serially (breakLoop semantics)
          for (const toolCall of shouldBreak ? [] : systemToolCalls) {
            const { toolResult, action, breakLoop } = await this.executeToolCall(
              session,
              toolCall,
              onChunk,
              onTraceEvent,
              llmCallId,
            );

            const truncated = await this.compressAndTruncateToolResult(
              session,
              toolCall,
              toolResult,
              onTraceEvent,
            );

            toolResults.push({
              type: 'tool_result',
              tool_use_id: toolCall.id,
              content: truncated,
            });

            if (action) {
              finalAction = action;
            }

            // Silent handoff (breakLoop=false): the child completed without a response,
            // so the supervisor continues. Reset finalAction so the supervisor's eventual
            // response is properly streamed and pushed to history (not skipped as 'handoff').
            if (!breakLoop && action?.type === 'handoff') {
              finalAction = { type: 'continue' };
            }

            if (breakLoop) {
              shouldBreak = true;
              finalResponse = extractBreakLoopResponse(toolResult) ?? '';
              const structuredBreakLoopResult = protectBreakLoopStructuredResult(
                session,
                extractBreakLoopStructuredResult(toolResult),
              );
              if (structuredBreakLoopResult) {
                finalVoiceConfig = structuredBreakLoopResult.voiceConfig;
                finalRichContent = structuredBreakLoopResult.richContent;
                finalActions = structuredBreakLoopResult.actions;
                finalLocalization = structuredBreakLoopResult.localization;
              }
              // For handoff, the response comes from the child agent
              if (
                action?.type === 'handoff' &&
                typeof toolResult === 'object' &&
                toolResult !== null &&
                'response' in toolResult
              ) {
                finalResponse = (toolResult as { response: string }).response;
              }
              // For escalate, use the channel-aware message from handleEscalate
              if (
                action?.type === 'escalate' &&
                typeof toolResult === 'object' &&
                toolResult !== null &&
                'message' in toolResult
              ) {
                finalResponse = (toolResult as { message: string }).message;
              }
              // For complete, set the completion message as the response
              if (
                action?.type === 'complete' &&
                typeof toolResult === 'object' &&
                toolResult !== null &&
                'message' in toolResult
              ) {
                finalResponse = (toolResult as { message: string }).message;
              }
              if (
                !finalResponse &&
                typeof toolResult === 'object' &&
                toolResult !== null &&
                'message' in toolResult &&
                typeof (toolResult as { message?: unknown }).message === 'string'
              ) {
                finalResponse = (toolResult as { message: string }).message;
              }
              // For constraint violation, use the violation message as response
              if (!finalResponse && action?.type === 'constraint_violation' && action.message) {
                finalResponse = action.message as string;
              }
              if (
                action?.type === 'handoff' &&
                typeof toolResult === 'object' &&
                toolResult !== null &&
                'result' in toolResult
              ) {
                const handoffExecutionResult = (toolResult as { result?: ExecutionResult }).result;
                if (handoffExecutionResult) {
                  finalVoiceConfig = handoffExecutionResult.voiceConfig;
                  finalRichContent = handoffExecutionResult.richContent;
                  finalActions = handoffExecutionResult.actions;
                  finalLocalization = handoffExecutionResult.localization;
                }
              }
              if (
                finalResponse &&
                onChunk &&
                action?.type !== 'handoff' &&
                action?.type !== 'complete'
              ) {
                onChunk(this.filterChunkPII(session, finalResponse));
              }
              break;
            }
          }

          // Add tool results as user message.
          // When we synthesized a fan_out from parallel tool calls, the message
          // history still has the original tool_use blocks (for providerMetadata
          // round-trip). We must provide a tool_result for each original tool call
          // ID so the provider sees a complete request/response pair.
          // Each original tool call gets its specific specialist result extracted
          // from the fan-out results array.
          let messageToolResults: Array<ToolResultContent>;
          if (wasSynthesized) {
            // Parse the fan-out result to extract per-target responses
            let fanOutResults: Array<{ target: string; response?: string }> = [];
            try {
              const parsed = JSON.parse(toolResults[0]?.content || '{}');
              fanOutResults = parsed.results || [];
            } catch {
              // If parsing fails, fall back to full content for all
            }

            messageToolResults = result.toolCalls.map((origTc) => {
              // Extract target name from tool call name: delegate_to_Cards_Manager → Cards_Manager
              const target = origTc.name.startsWith('delegate_to_')
                ? origTc.name.slice('delegate_to_'.length)
                : origTc.name.startsWith('handoff_to_')
                  ? origTc.name.slice('handoff_to_'.length)
                  : (origTc.input?.target as string) || '';
              // Find matching result for this target
              const match = fanOutResults.find((r) => r.target === target);
              const content = match
                ? JSON.stringify({ success: true, response: match.response })
                : toolResults[0]?.content || '{}';
              return {
                type: 'tool_result' as const,
                tool_use_id: origTc.id,
                content,
              };
            });
          } else {
            messageToolResults = toolResults;
          }
          messages.push({
            role: 'user',
            content: redactToolResultsForLLM(session, messageToolResults),
          });

          // After inline gather extraction, refresh tool set
          if (
            inlineGather &&
            gatherFields &&
            effectiveToolCalls.some((tc) => tc.name === '_extract_entities')
          ) {
            inlineExtractionCalled = true;
            // Check if all fields (required + optional) are now collected
            const allCollected = (gatherFields as GatherField[]).every((f) => {
              const val = session.data.values[f.name];
              return val !== undefined && val !== null && val !== '';
            });
            if (allCollected) {
              // Remove _extract_entities — all fields collected
              tools = tools.filter((t) => t.name !== '_extract_entities');
            }
            // Rebuild system prompt with updated context
            await refreshPromptOnly();
          }

          if (shouldBreak) {
            break;
          }

          // Rebuild system prompt with updated context after tool execution
          await refreshTurnSurface();
        } else {
          // No tool calls — this is the final response.
          const shouldRepairSupervisorRouting =
            !supervisorRoutingToolExecuted &&
            shouldRepairSupervisorRoutingTurn({
              session,
              tools,
              userMessage: currentTurnInput,
              responseText: result.text,
            });

          if (
            shouldRepairSupervisorRouting &&
            supervisorRoutingRepairAttempts < SUPERVISOR_ROUTING_REPAIR_MAX_RETRIES
          ) {
            supervisorRoutingRepairAttempts++;
            systemPrompt = `${systemPrompt}\n\n${buildSupervisorRoutingRepairPrompt(tools)}`;
            if (onTraceEvent) {
              onTraceEvent({
                type: 'decision',
                data: {
                  decision: 'supervisor_routing_repair_retry',
                  agent: session.agentName,
                  attempt: supervisorRoutingRepairAttempts,
                  responsePreview: result.text?.slice(0, 200) ?? '',
                  availableRoutingTools: tools
                    .filter((tool) => tool.name.startsWith('handoff_to_'))
                    .map((tool) => tool.name),
                },
              });
            }
            continue;
          }

          if (shouldRepairSupervisorRouting) {
            finalResponse =
              'I need a little more detail to route that. Are you asking about structured metadata, or content inside the documents?';
            if (onTraceEvent) {
              onTraceEvent({
                type: 'decision',
                data: {
                  decision: 'supervisor_routing_clarification_fallback',
                  agent: session.agentName,
                  responsePreview: result.text?.slice(0, 200) ?? '',
                },
              });
            }
            break;
          }

          if (hasOnlySystemTools && !mustDelayStreamedOutput && iterBuffer && onChunk) {
            // Supervisor agent that produced a direct response (e.g. guard rail
            // rejection). Flush the buffer.
            onChunk(this.filterChunkPII(session, iterBuffer));
            streamedText = true;
          } else if (shouldBufferPIIOutput && iterBuffer && onChunk) {
            // PII-aware rendering needs the complete generated text so custom
            // patterns and disabled built-ins resolve before any user-visible text.
            onChunk(this.filterChunkPII(session, iterBuffer));
            streamedText = true;
          } else if (!shouldBufferStreamedOutput && onChunk && emittedTextThisIteration) {
            // Specialist agent — text was already streamed directly.
            streamedText = true;
          }
          finalResponse = result.text;
          break;
        }
      }

      // ── Tool loop citation map: build from the LAST search call's results ──
      // The LLM generates [1]..[N] markers based on the most recent search results
      // in its context window. Use only the last call to keep indices aligned.
      if (searchToolResults.length > 0 && session._searchaiToolExecutor) {
        const lastSearch = searchToolResults[searchToolResults.length - 1];
        const results = lastSearch.formattedResult?.results;
        if (Array.isArray(results) && results.length > 0) {
          const manifest = session._searchaiToolExecutor.getDiscoveryManifestForTool(
            lastSearch.toolName,
          );
          const citationCfg = manifest?.citationConfig ?? null;
          const toolLoopCitations = session._searchaiToolExecutor.buildCitationMap(
            {
              results: results as Array<{
                title?: string;
                content: string;
                _sourceUrl?: string;
                _documentId?: string;
                _sourceType?: string;
                _sourceKey?: string;
              }>,
            },
            citationCfg,
            {
              tenantId: session.tenantId ?? '',
              indexId: session._searchaiToolExecutor.getIndexIdForTool(lastSearch.toolName),
            },
          );
          if (toolLoopCitations) {
            // Defensive merge: KB fast path and tool loop are mutually exclusive,
            // but merge rather than overwrite just in case.
            finalCitations = finalCitations
              ? [...finalCitations, ...toolLoopCitations]
              : toolLoopCitations;
          }
        }
      }
    } catch (loopErr) {
      // --- ON_ERROR: Route non-tool errors through agent-level error handlers ---
      if (session.agentIR) {
        const errorMsg = loopErr instanceof Error ? loopErr.message : String(loopErr);
        const errorCode = loopErr instanceof AppError ? loopErr.code : undefined;
        const diagnostic =
          getLlmOperatorDiagnostic(loopErr) ?? classifyExecutionConfigurationDiagnostic(loopErr);
        const errorEnvelope = buildRuntimeErrorEnvelope(loopErr, {
          traceId: getCurrentTraceId() ?? undefined,
          agentName: session.agentName,
        });
        const llmErrorType = isLlmError(loopErr) ? 'llm_error' : 'unknown_error';
        const llmErrorSubtype = deriveLlmErrorSubtype(loopErr);
        const errorCtx: ErrorContext = {
          type: llmErrorType,
          subtype: llmErrorSubtype,
          message: errorMsg,
          retryable: false,
        };
        // First attempt: try to match with the derived type (e.g. 'llm_error').
        // Backwards-compatibility fallback: if the error is an LLM error but no
        // handler matched 'llm_error', retry with 'unknown_error' so that
        // existing agents whose only on_error handler targets 'unknown_error'
        // continue to work without modification.
        let resolution = resolveErrorHandler(errorCtx, session.agentIR);
        if (!resolution && llmErrorType === 'llm_error') {
          resolution = resolveErrorHandler(
            { ...errorCtx, type: 'unknown_error', subtype: undefined },
            session.agentIR,
          );
        }
        if (resolution) {
          const localizedResolution = resolveLocalizedErrorHandlerResponseWithMetadata({
            session,
            resolution,
          });
          // Subtype-specific message key resolution (F-5):
          // When the error has a recognized subtype, look for a subtype-specific
          // message key (e.g. 'error_llm_content_filter') before falling back to
          // 'error_default'. Default values for subtype keys are deliberately the
          // same as 'error_default' so existing agents see ZERO behavior change.
          const subtypeKey = llmErrorSubtype ? `error_llm_${llmErrorSubtype}` : undefined;
          const subtypeMessage = subtypeKey
            ? (session.agentIR?.messages?.[subtypeKey] ?? DEFAULT_MESSAGES[subtypeKey])
            : undefined;

          const defaultErrorResponse = resolveLocalizedAgentMessage({
            session,
            messageKey: subtypeKey ?? 'error_default',
            fallbackMessage:
              resolution.respond ??
              subtypeMessage ??
              session.agentIR?.messages?.error_default ??
              DEFAULT_MESSAGES.error_default,
          });
          onTraceEvent?.({
            type: 'agent_error_handled',
            data: {
              errorType: errorCtx.type,
              ...(errorCtx.subtype ? { errorSubtype: errorCtx.subtype } : {}),
              message: errorMsg,
              ...(errorCode ? { errorCode } : {}),
              action: resolution.action,
              handler: resolution.handler.type,
              agent: session.agentName,
              ...(diagnostic ? { diagnostic } : {}),
              ...(errorEnvelope ? { errorEnvelope } : {}),
            },
          });
          if (localizedResolution?.text) {
            finalResponse = localizedResolution.text;
          }
          if (resolution.action === 'escalate') {
            session.data.values._escalated = true;
            if (!finalResponse) {
              finalResponse = 'Escalating to a human agent.';
            }
            finalAction = { type: 'escalate' };
          } else if (resolution.action === 'continue') {
            if (!finalResponse) {
              finalResponse = defaultErrorResponse;
            }
          } else if (resolution.action === 'handoff' && resolution.handoffTarget) {
            // Route the error to the fallback agent via the routing executor.
            try {
              const handoffResult = await this.routing.handleHandoff(
                session,
                { target: resolution.handoffTarget },
                onChunk,
                onTraceEvent,
              );
              if (handoffResult.response && !finalResponse) {
                finalResponse = handoffResult.response;
              }
              if (handoffResult.result) {
                finalVoiceConfig = handoffResult.result.voiceConfig;
                finalRichContent = handoffResult.result.richContent;
                finalActions = handoffResult.result.actions;
                finalLocalization = handoffResult.result.localization;
              }
            } catch {
              /* routing errors are traced by the router itself; fall through */
            }
            if (!finalResponse) {
              // Never surface raw errorMsg to the user — it may contain credentials,
              // tenant identifiers, or upstream stack traces. Fall back to the DSL-authored
              // respond string, or a generic safe message.
              finalResponse = localizedResolution?.text ?? defaultErrorResponse;
            }
          } else {
            // For other actions (complete, backtrack, retry_step),
            // set response and let the normal flow handle it
            if (!finalResponse) {
              finalResponse = localizedResolution?.text ?? defaultErrorResponse;
            }
          }
          // Don't rethrow — the handler consumed the error
        } else {
          throw loopErr; // No handler found — propagate
        }
      } else {
        throw loopErr; // No agentIR — propagate
      }
    }

    // Safety: if loop exhausted without producing a response, provide a fallback
    if (!finalResponse && iterations >= maxIterations) {
      finalResponse = 'I was unable to complete the response. Please try again.';
      if (onTraceEvent) {
        onTraceEvent({
          type: 'warning',
          data: {
            message: 'Max iterations reached without final response',
            agent: session.agentName,
            iterations,
            maxIterations,
          },
        });
      }
    }

    // --- RESPONSE CONSTRAINTS: evaluate BEFORE fallback extraction ---
    // Constraint check must run before fallback extraction so that constraints
    // referencing ungathered GATHER fields are correctly skipped by the
    // ungathered-field filter in checkFlatConstraints. If fallback extraction
    // ran first, it would mark fields as "gathered" with potentially non-
    // normalised values, causing false constraint violations that replace the
    // LLM's actual (often correct) response.
    if (finalResponse) {
      const beforeResponseViolation = checkFlatConstraintsAtCheckpoint(
        session,
        { kind: 'response' },
        onTraceEvent,
      );
      if (beforeResponseViolation) {
        return executeConstraintViolation(session, beforeResponseViolation, {
          onChunk,
          onTraceEvent,
          executeHandoff: (handoffInput) =>
            this.routing.handleHandoff(session, handoffInput, onChunk, onTraceEvent),
        });
      }

      const policy = await getSessionPolicy(session);
      const dslGuardrails = session.agentIR?.constraints?.guardrails;
      const hasGuardrails =
        (dslGuardrails?.length ?? 0) > 0 || policy?.additionalGuardrails?.length;

      if (hasGuardrails) {
        const llmEval = session.llmClient ? createLLMEvalFromClient(session.llmClient) : undefined;
        const guardrailResult = await checkOutputGuardrails(
          finalResponse,
          dslGuardrails,
          { agentGoal: session.agentIR?.identity?.goal },
          policy,
          llmEval,
          session.tenantId,
          session,
          onTraceEvent,
        );

        if (!guardrailResult.passed && guardrailResult.violation) {
          if (onTraceEvent) {
            onTraceEvent({
              type: 'guardrail_output_blocked',
              data: {
                agentName: session.agentName,
                kind: 'output',
                guardrailName: guardrailResult.violation.guardrailName,
                action: guardrailResult.violation.action,
                message: guardrailResult.violation.message,
                presetKey: guardrailResult.violation.presetKey,
                passed: false,
              },
            });
          }

          if (guardrailResult.violation.action === 'block') {
            finalResponse = guardrailResult.violation.message || 'I cannot provide that response.';
          } else if (guardrailResult.violation.action === 'escalate') {
            session.data.values._escalated = true;
            finalResponse = guardrailResult.violation.message || 'Escalating to a human agent.';
          } else if (guardrailResult.violation.action === 'reask') {
            // ── Reask: retry LLM generation with sanitized prompt ──
            const reaskDecision = shouldExecuteReask({
              primaryAction: guardrailResult.violation.action,
              primaryMessage: guardrailResult.violation.message,
              hasReaskViolation: true,
              isStreaming: !!onChunk,
            });

            if (reaskDecision.shouldReask && session.llmClient) {
              const maxReasks =
                guardrailResult.pipelineResult?.primaryViolation?.resolvedAction?.maxReasks ?? 2;
              // Snapshot history length so intermediate reask prompts and rejected
              // LLM outputs can be removed after the loop. Persisting rejected content
              // in conversationHistory pollutes the next turn's LLM context with
              // disallowed material and wastes the token budget.
              const historyLengthBeforeReask = session.conversationHistory.length;
              const reaskResult = await executeReaskLoop(
                {
                  generateResponse: async (reaskPrompt: string) => {
                    session.conversationHistory.push({ role: 'user', content: reaskPrompt });
                    const llmResult = await session.llmClient!.chatWithToolUseStreamable(
                      systemPrompt,
                      session.conversationHistory.map((m) => ({
                        role: m.role as 'user' | 'assistant' | 'system',
                        content: m.content,
                      })),
                      [],
                      'response_gen',
                      undefined,
                    );
                    const text =
                      typeof llmResult.text === 'string' ? llmResult.text : String(llmResult.text);
                    session.conversationHistory.push({ role: 'assistant', content: text });
                    return text;
                  },
                  checkGuardrails: async (text: string) => {
                    return checkOutputGuardrails(
                      text,
                      dslGuardrails,
                      { agentGoal: session.agentIR?.identity?.goal },
                      policy,
                      llmEval,
                      session.tenantId,
                      session,
                      onTraceEvent,
                    );
                  },
                  onTraceEvent: onTraceEvent ?? (() => {}),
                  agentName: session.agentName,
                },
                guardrailResult,
                maxReasks,
              );

              // Drop intermediate reask messages regardless of outcome — the post-guardrail
              // commit at the end of execute() pushes finalResponse exactly once.
              session.conversationHistory.length = historyLengthBeforeReask;
              finalResponse = reaskResult.finalText;

              if (onTraceEvent) {
                onTraceEvent({
                  type: reaskResult.succeeded
                    ? 'guardrail_reask_succeeded'
                    : 'guardrail_reask_exhausted',
                  data: {
                    agentName: session.agentName,
                    guardrailName: guardrailResult.violation.guardrailName,
                    reaskCount: reaskResult.reaskCount,
                    maxReasks,
                  },
                });
              }
            } else {
              // Streaming or no LLM client — fall back to block behavior
              if (reaskDecision.skipReason === 'streaming' && onTraceEvent) {
                onTraceEvent({
                  type: 'guardrail_reask_skipped_streaming',
                  data: {
                    agentName: session.agentName,
                    guardrailName: guardrailResult.violation.guardrailName,
                    reason: 'Reask not supported in streaming mode',
                  },
                });
              }
              finalResponse =
                guardrailResult.violation.message || 'I cannot provide that response.';
            }
          }
        } else if (guardrailResult.modifiedContent) {
          // Non-terminal action (redact/fix/filter) modified the output content
          finalResponse = guardrailResult.modifiedContent;
        }
      }
    }

    // ── Flush buffered streaming output after guardrails pass ──
    // When mustDelayStreamedOutput was true, text was buffered during generation
    // for post-generation guardrail evaluation. Now that guardrails have run
    // (and possibly modified finalResponse), stream the checked response to the
    // user. This prevents the fallback at the bottom from sending the entire
    // response as a single chunk — which defeats perceived-latency benefits.
    if (mustDelayStreamedOutput && onChunk && finalResponse && !streamedText) {
      onChunk(this.filterChunkPII(session, finalResponse));
      streamedText = true;
    }

    // ── Fallback extraction for inline_gather when model skipped _extract_entities ──
    // Runs AFTER constraint checks so that ungathered GATHER fields correctly
    // trigger the skip-filter in checkFlatConstraints. Values extracted here
    // update session state for the NEXT turn's "Still needed" list but do not
    // retroactively affect constraint evaluation for the current response.
    if (inlineGather && !inlineExtractionCalled && gatherFields && gatherFields.length > 0) {
      const uncollected = (gatherFields as GatherField[]).filter((f) => {
        const val = session.data.values[f.name];
        return val === undefined || val === null || val === '';
      });
      if (uncollected.length > 0) {
        const lastUserMsg = resolveCurrentTurnInput(session);
        if (lastUserMsg && !shouldSkipExtraction(lastUserMsg)) {
          try {
            // Only extract uncollected fields — avoid overwriting already-gathered values
            const uncollectedFields = (gatherFields as GatherField[]).filter((f) => {
              const val = session.data.values[f.name];
              return val === undefined || val === null || val === '';
            });
            const uncollectedNames = uncollectedFields.map((f) => f.name);
            if (uncollectedNames.length > 0) {
              const extracted = await this.flowStep.extractEntitiesWithLLM(
                lastUserMsg,
                uncollectedNames,
                session,
                onTraceEvent,
                uncollectedFields,
              );

              const nonEmpty: Record<string, unknown> = {};
              for (const [key, value] of Object.entries(extracted)) {
                if (value !== undefined && value !== null && value !== '') {
                  nonEmpty[key] = value;
                }
              }
              const { valid: validExtracted, invalid: invalidFields } = validateExtractedBatch(
                uncollectedFields,
                nonEmpty,
                getDateNormalizationOptions(session),
              );
              if (Object.keys(invalidFields).length > 0) {
                log.debug('Inline fallback validation rejected fields', {
                  agent: session.agentName,
                  invalid: invalidFields,
                });
              }

              await applyLookupValidationToExtractedValues(
                session,
                validExtracted,
                uncollectedFields,
                onTraceEvent,
              );

              if (Object.keys(validExtracted).length > 0) {
                setGatheredValues(session, validExtracted);
                if (onTraceEvent) {
                  onTraceEvent({
                    type: 'dsl_collect',
                    data: {
                      agentName: session.agentName,
                      mode: 'inline_gather_fallback',
                      fields: uncollectedNames,
                      userInput: lastUserMsg,
                      extracted: validExtracted,
                    },
                  });
                }
              }
            }
          } catch (err) {
            log.warn('Inline gather fallback extraction failed', {
              agent: session.agentName,
              error: err instanceof Error ? err.message : String(err),
            });
          }
        }
      }
    }

    // --- HOOKS: after_turn lifecycle hook (IR-gated: no-op if not defined) ---
    if (session.agentIR?.hooks?.after_turn) {
      const { executeHook } = await import('./hook-executor.js');
      const afterTurnHookResult = await executeHook(
        'after_turn',
        session.agentIR.hooks,
        session,
        onChunk,
        onTraceEvent,
      );
      afterTurnEmittedMessage = afterTurnHookResult.emittedMessage;
    }

    // --- PII Phase 2: tokenize or redact PII from output before delivery ---
    // When vault is available, use reversible tokenization so history stores tokens
    // and per-consumer rendering can recover originals for authorized consumers.
    // Falls back to destructive redaction when vault is not initialized.
    let historyResponse = finalResponse;
    if (finalResponse && session.piiRedactionConfig?.enabled) {
      if (session.piiVault) {
        if (shouldRedactRawOutputPII(session)) {
          const tokenized = session.piiVault.tokenize(finalResponse, undefined, {
            confidenceThreshold: session.piiRedactionConfig.confidenceThreshold,
          });
          if (tokenized.tokens.length > 0) {
            historyResponse = tokenized.text; // {{PII:<type>:<uuid>}} tokens for history
            finalResponse = session.piiVault.renderForConsumer(
              tokenized.text,
              'user',
              session.piiPatternConfigs,
            );

            // Audit: log tokenize events
            const auditLogger = getPIIAuditLogger();
            for (const token of tokenized.tokens) {
              auditLogger.log({
                tenantId: session.tenantId || '',
                projectId: session.projectId || '',
                sessionId: session.id,
                tokenId: token.id,
                piiType: token.type,
                consumer: 'user',
                action: 'tokenize',
              });
            }
          } else if (finalResponse.includes('{{PII:')) {
            finalResponse = session.piiVault.renderForConsumer(
              finalResponse,
              'user',
              session.piiPatternConfigs,
            );
          }
        } else if (finalResponse.includes('{{PII:')) {
          finalResponse = session.piiVault.renderForConsumer(
            finalResponse,
            'user',
            session.piiPatternConfigs,
          );
        }
      } else if (shouldRedactRawOutputPII(session)) {
        const piiResult = filterOutputPII(finalResponse, session.piiRedactionConfig, {
          patternConfigs: session.piiPatternConfigs,
          recognizerRegistry: session.piiRecognizerRegistry,
        });
        if (piiResult.filtered) {
          finalResponse = piiResult.text;
          historyResponse = finalResponse;
        }
      }
    }

    // --- COMMIT: push to history and emit AFTER guardrails ---
    // Skip for actions that already pushed their own response:
    // - 'handoff': handleHandoff() added the child's response to the (switched) child thread
    // - 'complete': executeComplete() already pushed the completion message
    // For 'escalate' and 'continue', we push here since the handler didn't.
    const skipPush = finalAction.type === 'handoff' || finalAction.type === 'complete';
    if (finalResponse && !skipPush) {
      // Store only plain Q&A in history — no tool blocks, no chunks.
      // The rephrase/classify LLM sees clean conversation context:
      //   user: "show me documents about security"
      //   assistant: "Here are security documents: 1. Auth Policy..."
      // This keeps history lean and avoids bloating subsequent LLM calls
      // with tool_use/tool_result structures from prior turns.
      session.conversationHistory.push({ role: 'assistant', content: historyResponse });

      if (onChunk && finalAction.type === 'continue' && !streamedText) {
        onChunk(finalResponse);
      }
    }

    // Strip markdown/emoji from the returned response for voice sessions.
    // onChunk wrapping handles the streaming path; this covers the return value
    // used by non-streaming callers (REST chat, etc.).
    if (isVoiceChannel(session) && finalResponse) {
      finalResponse = stripForVoice(finalResponse);
    }

    // --- PII Phase 2: clean up transient fields and vault on gather completion ---
    if (finalAction.type === 'complete' || finalAction.type === 'handoff') {
      const gatherFields = session.agentIR?.gather?.fields;
      if (gatherFields && gatherFields.length > 0) {
        cleanupTransientFields(session.data.values, gatherFields);
      }
      // Persist revealable token originals before terminal cleanup, then clear
      // the session-local vault so Redis/session state cannot reveal raw PII.
      if (session.piiVault) {
        await flushAndClearSessionPIIVault(session);
        getPIIAuditLogger().log({
          tenantId: session.tenantId || '',
          projectId: session.projectId || '',
          sessionId: session.id,
          tokenId: '*',
          piiType: '*',
          consumer: 'system',
          action: 'clear',
        });
      }
    }

    if (beforeTurnEmittedMessage) {
      if (!finalResponse && beforeTurnEmittedMessage.response) {
        finalResponse = beforeTurnEmittedMessage.response;
      }
      if (finalRichContent === undefined && beforeTurnEmittedMessage.richContent !== undefined) {
        finalRichContent = beforeTurnEmittedMessage.richContent;
      }
      if (finalVoiceConfig === undefined && beforeTurnEmittedMessage.voiceConfig !== undefined) {
        finalVoiceConfig = beforeTurnEmittedMessage.voiceConfig;
      }
      if (finalActions === undefined && beforeTurnEmittedMessage.actions !== undefined) {
        finalActions = beforeTurnEmittedMessage.actions;
      }
    }

    if (afterTurnEmittedMessage) {
      if (!finalResponse && afterTurnEmittedMessage.response) {
        finalResponse = afterTurnEmittedMessage.response;
      }
      if (afterTurnEmittedMessage.richContent !== undefined) {
        finalRichContent = afterTurnEmittedMessage.richContent;
      }
      if (afterTurnEmittedMessage.voiceConfig !== undefined) {
        finalVoiceConfig = afterTurnEmittedMessage.voiceConfig;
      }
      if (afterTurnEmittedMessage.actions !== undefined) {
        finalActions = afterTurnEmittedMessage.actions;
      }
    }

    if (finalResponse) {
      const latestFinalOutput = [...outputMessages]
        .reverse()
        .find((message) => message.phase === 'final');
      if (latestFinalOutput?.text !== finalResponse.trim()) {
        appendOutputMessage('final', finalResponse, {
          deliveredToUser: !!onChunk,
        });
      } else {
        finalOutputMessageId = latestFinalOutput.id;
      }
    }

    // Filter citations to only those the LLM actually referenced in its response.
    // The LLM uses [1], [2], etc. markers — only include citations whose index
    // appears in the response text. This lets the LLM decide relevance instead of
    // applying an arbitrary score threshold.
    let filteredCitations = finalCitations;
    if (finalCitations && finalResponse) {
      const referencedIndices = new Set<number>();
      const citationRefPattern = /\[(\d+)\]/g;
      let match: RegExpExecArray | null;
      while ((match = citationRefPattern.exec(finalResponse)) !== null) {
        referencedIndices.add(parseInt(match[1], 10));
      }
      if (referencedIndices.size > 0) {
        filteredCitations = finalCitations.filter((c) => referencedIndices.has(c.index));
      }
      // If LLM didn't use any [N] markers, keep all citations as fallback
    }

    return {
      response: finalResponse,
      action: finalAction,
      stateUpdates: buildStateUpdates(session),
      ...(finalVoiceConfig !== undefined ? { voiceConfig: finalVoiceConfig } : {}),
      ...(finalRichContent !== undefined ? { richContent: finalRichContent } : {}),
      ...(finalActions !== undefined ? { actions: finalActions } : {}),
      ...(finalLocalization !== undefined ? { localization: finalLocalization } : {}),
      ...(outputMessages.length > 0 ? { outputMessages } : {}),
      ...(finalOutputMessageId !== undefined ? { finalOutputMessageId } : {}),
      ...(filteredCitations !== undefined && filteredCitations.length > 0
        ? { citations: filteredCitations }
        : {}),
    };
  }

  /**
   * Compress and truncate a tool result for inclusion in the conversation.
   * Applies policy-driven compaction and emits trace events for truncation.
   * When strategy is 'summarize' and the result exceeds the structured threshold,
   * uses LLM to produce a concise summary before falling back to structural compression.
   *
   * Performance optimization: SearchAI KB tools skip LLM summarization and use
   * structural compression only. The agent LLM is perfectly capable of reading
   * structured search results directly — the extra summarization LLM call added
   * ~6s latency without meaningful quality improvement.
   */
  private async compressAndTruncateToolResult(
    session: RuntimeSession,
    toolCall: ToolCall,
    toolResult: unknown,
    onTraceEvent?: (event: { type: string; data: Record<string, unknown> }) => void,
  ): Promise<string> {
    // For SearchAI KB tools, strip citation metadata (_sourceUrl, _documentId, etc.)
    // so the LLM uses [1], [2] markers instead of embedding raw URLs in its response.
    // The original (unstripped) result is already stashed for buildCitationMap().
    const isSearchAI = this.isSearchAIKBTool(session, toolCall.name);
    const effectiveResult =
      isSearchAI &&
      session._searchaiToolExecutor &&
      typeof session._searchaiToolExecutor.stripCitationMetadataForLLM === 'function'
        ? session._searchaiToolExecutor.stripCitationMetadataForLLM(toolResult)
        : toolResult;
    const serialized = JSON.stringify(effectiveResult);
    const compactionPolicy = resolveCompactionPolicy(session);
    const { strategy, structured_threshold } = compactionPolicy.tool_results;

    // Skip LLM summarization for SearchAI KB tools — the agent LLM reads structured
    // search results directly. This eliminates ~6s of latency per search call.
    // The synthesis LLM already has the full context to interpret search results.
    const isSearchAITool = this.isSearchAIKBTool(session, toolCall.name);

    // LLM summarization: attempt when strategy is 'summarize', result is large,
    // and session has an LLM client. Falls back to structural compression on failure.
    // Excluded for SearchAI KB tools where structural compression is sufficient.
    if (
      !isSearchAITool &&
      strategy === 'summarize' &&
      serialized.length > structured_threshold &&
      session.llmClient
    ) {
      try {
        const llmFn = async (systemPrompt: string, userContent: string) => {
          const result = await session.llmClient!.chatWithToolUse(
            systemPrompt,
            [{ role: 'user' as const, content: userContent }],
            [],
            'summarization',
            {},
          );
          return result.text || '';
        };
        const summarized = await summarizeToolResult(
          serialized,
          toolCall.name,
          llmFn,
          compactionPolicy.tool_results.summarize_prompt,
        );
        if (summarized) {
          if (onTraceEvent) {
            onTraceEvent({
              type: 'tool_result_summarized',
              data: {
                toolName: toolCall.name,
                originalSize: serialized.length,
                summarizedSize: summarized.length,
                agent: session.agentName,
              },
            });
          }
          return summarized;
        }
      } catch (err) {
        log.warn('Tool result LLM summarization failed, falling back to structural compression', {
          toolName: toolCall.name,
          error: err instanceof Error ? err.message : String(err),
          agent: session.agentName,
        });
      }
    }

    if (isSearchAITool && strategy === 'summarize' && serialized.length > structured_threshold) {
      log.info('SearchAI KB tool: skipping LLM summarization, using structural compression', {
        toolName: toolCall.name,
        originalSize: serialized.length,
        threshold: structured_threshold,
        agent: session.agentName,
      });
    }

    const compressed = compressToolResult(serialized, toolCall.name, compactionPolicy);
    const maxChars = compactionPolicy.tool_results.max_chars;
    const truncated =
      compressed.length > maxChars
        ? compressed.slice(0, maxChars) +
          `\n...[truncated: ${compressed.length} chars, showing first ${maxChars}]`
        : compressed;

    if (compressed.length > maxChars) {
      log.warn('Tool result truncated after compression — exceeds size limit', {
        toolName: toolCall.name,
        originalSize: serialized.length,
        compressedSize: compressed.length,
        truncatedSize: maxChars,
        agent: session.agentName,
      });
      if (onTraceEvent) {
        onTraceEvent({
          type: 'tool_result_truncated',
          data: {
            toolName: toolCall.name,
            originalSize: serialized.length,
            compressedSize: compressed.length,
            truncatedSize: maxChars,
            agent: session.agentName,
          },
        });
      }
    } else if (compressed.length < serialized.length) {
      log.info('Tool result compressed', {
        toolName: toolCall.name,
        originalSize: serialized.length,
        compressedSize: compressed.length,
        agent: session.agentName,
      });
    }

    return truncated;
  }

  /**
   * Check if a tool is a SearchAI KB tool by looking at the session's tool definitions.
   * Used to skip LLM summarization for search results (structural compression is sufficient).
   */
  private isSearchAIKBTool(session: RuntimeSession, toolName: string): boolean {
    // Check effective config tools first (includes dynamically loaded tools)
    const tools = session._effectiveConfig?.tools ?? session.agentIR?.tools ?? [];
    const toolDef = tools.find((t) => t.name === toolName);
    return toolDef?.tool_type === 'searchai';
  }

  /**
   * Filter PII from a buffered streaming chunk before sending to the user.
   * Uses vault tokenization when available, falls back to destructive redaction.
   */
  private filterChunkPII(session: RuntimeSession, chunk: string): string {
    if (!session.piiRedactionConfig?.enabled) return chunk;
    if (session.piiVault) {
      if (!shouldRedactRawOutputPII(session) && !chunk.includes('{{PII:')) {
        return chunk;
      }
      const tokenized = session.piiVault.tokenize(chunk, undefined, {
        confidenceThreshold: session.piiRedactionConfig.confidenceThreshold,
      });
      if (tokenized.tokens.length > 0) {
        return session.piiVault.renderForConsumer(
          tokenized.text,
          'user',
          session.piiPatternConfigs,
        );
      }
      if (chunk.includes('{{PII:')) {
        return session.piiVault.renderForConsumer(chunk, 'user', session.piiPatternConfigs);
      }
      return chunk;
    }
    if (!shouldRedactRawOutputPII(session)) return chunk;
    const result = filterOutputPII(chunk, session.piiRedactionConfig, {
      patternConfigs: session.piiPatternConfigs,
      recognizerRegistry: session.piiRecognizerRegistry,
    });
    return result.filtered ? result.text : chunk;
  }

  private async executeConstraintViolationInLoop(
    session: RuntimeSession,
    violation: import('@abl/compiler').ConstraintCheckInfo,
    onChunk?: (chunk: string) => void,
    onTraceEvent?: (event: { type: string; data: Record<string, unknown> }) => void,
  ): Promise<{
    toolResult: unknown;
    action?: { type: string; [key: string]: unknown };
    breakLoop?: boolean;
  }> {
    const result = await executeConstraintViolation(session, violation, {
      onChunk,
      onTraceEvent,
      executeHandoff: (handoffInput) =>
        this.routing.handleHandoff(session, handoffInput, onChunk, onTraceEvent),
      applyResponseSideEffects: false,
    });

    const action = result.action;
    const toolResult: Record<string, unknown> = {};

    if (result.response) {
      toolResult.message = result.response;
      // Keep the canonical break-loop payload aligned across tool results.
      // Downstream callers already prefer `response`, while older tests and
      // adapters still read `message`.
      toolResult.response = result.response;
    } else if (action.type !== 'handoff') {
      toolResult.error = 'Constraint violated';
    }
    if (
      result.voiceConfig !== undefined ||
      result.richContent !== undefined ||
      result.actions !== undefined ||
      result.localization !== undefined
    ) {
      toolResult.result = result;
    }
    if ('fields' in action && Array.isArray(action.fields)) {
      toolResult.fields = action.fields;
    }
    if ('target' in action && typeof action.target === 'string') {
      toolResult.target = action.target;
    }

    return {
      toolResult,
      action,
      breakLoop: true,
    };
  }

  /**
   * Handle _extract_entities tool calls inline within the reasoning loop.
   * Runs validation, retry tracking, constraint checks, and memory ops —
   * same semantics as the legacy separate pre-pass, but as a tool result.
   */
  private async handleInlineExtraction(
    session: RuntimeSession,
    toolCall: { name: string; input: Record<string, unknown> },
    onChunk?: (chunk: string) => void,
    onTraceEvent?: (event: { type: string; data: Record<string, unknown> }) => void,
  ): Promise<{
    toolResult: unknown;
    action?: { type: string; [key: string]: unknown };
    breakLoop?: boolean;
  }> {
    const extracted = toolCall.input as Record<string, unknown>;
    const gatherFields = (session.agentIR?.gather?.fields ?? []) as GatherField[];
    const currentTurnInput = resolveCurrentTurnInput(session);

    if (currentTurnInput !== undefined) {
      const rawCurrentTurnInput = resolveCurrentTurnRawInput(session, currentTurnInput);
      setCurrentTurnInputContext(session, currentTurnInput, rawCurrentTurnInput);
    }

    // 1. Type-level validation + normalization (email, phone E.164, date ISO, etc.)
    //    Uses the same pipeline as the pre-pass path for consistency.
    const nonEmpty: Record<string, unknown> = {};
    for (const [name, value] of Object.entries(extracted)) {
      if (value !== undefined && value !== null && value !== '') {
        nonEmpty[name] = value;
      }
    }
    const { valid: typeValid, invalid: typeInvalid } = validateExtractedBatch(
      gatherFields,
      nonEmpty,
      getDateNormalizationOptions(session),
    );

    // 2. Apply custom validation rules (pattern, range, max_retries) on type-valid values
    const errors: Record<string, string> = {};
    const valid: Record<string, unknown> = {};

    for (const [name, errMsg] of Object.entries(typeInvalid)) {
      errors[name] = errMsg;
    }

    for (const [name, value] of Object.entries(typeValid)) {
      const field = gatherFields.find((f) => f.name === name);
      if (field?.validation) {
        const error = validateField(value, field.validation);
        if (error) {
          errors[name] = error;
          continue;
        }
      }
      valid[name] = value;
    }

    const lookupErrors = await applyLookupValidationToExtractedValues(
      session,
      valid,
      gatherFields,
      onTraceEvent,
    );
    Object.assign(errors, lookupErrors);

    // 2. Track retries for failed fields
    if (Object.keys(errors).length > 0) {
      const retries = {
        ...((session.data.values._validation_retries as Record<string, number>) ?? {}),
      };
      const exceeded = [...((session.data.values._validation_exceeded as string[]) ?? [])];

      for (const fieldName of Object.keys(errors)) {
        retries[fieldName] = (retries[fieldName] ?? 0) + 1;
        const gf = gatherFields.find((f) => f.name === fieldName);
        const maxRetries = gf?.validation?.max_retries;
        if (
          maxRetries !== undefined &&
          retries[fieldName] >= maxRetries &&
          !exceeded.includes(fieldName)
        ) {
          exceeded.push(fieldName);
          if (onTraceEvent) {
            onTraceEvent({
              type: 'validation_max_retries',
              data: {
                field: fieldName,
                retries: retries[fieldName],
                maxRetries,
                agent: session.agentName,
              },
            });
          }
        }
      }
      session.data.values._validation_retries = retries;
      if (exceeded.length > 0) session.data.values._validation_exceeded = exceeded;

      // Collect retry prompts for the LLM
      const retryHints: string[] = [];
      for (const [fieldName, errMsg] of Object.entries(errors)) {
        const gf = gatherFields.find((f) => f.name === fieldName);
        const hint = gf?.validation?.retry_prompt ?? errMsg;
        retryHints.push(`- ${fieldName}: ${hint}`);
      }

      // Still store any VALID fields from this extraction
      if (Object.keys(valid).length > 0) {
        setGatheredValues(session, valid);
      }

      return {
        toolResult: {
          success: false,
          error: {
            code: 'VALIDATION_ERROR',
            message: `Some fields failed validation:\n${retryHints.join('\n')}\nPlease ask the user to correct these values.`,
            fields: errors,
          },
          ...(Object.keys(valid).length > 0 ? { stored: Object.keys(valid) } : {}),
        },
        breakLoop: false,
      };
    }

    // 3. All valid — persist to session
    if (Object.keys(valid).length > 0) {
      setGatheredValues(session, valid);

      // Memory operations (same as legacy path)
      try {
        await evaluateRememberAfterStateChange(session, onTraceEvent);
      } catch (err) {
        log.warn('inline gather: remember failed', {
          error: err instanceof Error ? err.message : String(err),
        });
      }

      try {
        await executeRecallAfterExtraction(session, Object.keys(valid), onTraceEvent);
      } catch (err) {
        log.warn('inline gather: recall failed', {
          error: err instanceof Error ? err.message : String(err),
        });
      }

      if (currentTurnInput) {
        try {
          await detectAndStorePreferences(
            session,
            currentTurnInput,
            Object.keys(valid),
            onTraceEvent,
          );
        } catch (err) {
          log.warn('inline gather: preferences failed', {
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }

      // 4. Post-extraction constraint check
      const violation = checkFlatConstraints(session, onTraceEvent);
      if (violation) {
        for (const field of getConstraintFieldsToClear(Object.keys(valid), violation.condition)) {
          deleteSessionValue(session, field);
        }
        return this.executeConstraintViolationInLoop(session, violation, onChunk, onTraceEvent);
      }
    }

    // 5. Check gather completeness
    const { complete, missing } = checkGatherComplete(
      { fields: gatherFields },
      session.data.values,
      undefined,
    );

    if (onTraceEvent) {
      onTraceEvent({
        type: 'dsl_collect',
        data: {
          agentName: session.agentName,
          mode: 'inline_gather',
          extracted: valid,
          complete,
          missing,
        },
      });
    }

    return {
      toolResult: {
        success: true,
        data: {
          stored: Object.keys(valid),
          complete,
          missing,
          next_action: complete
            ? "All required fields collected. Proceed with the user's request using domain tools."
            : `Still need: ${missing.join(', ')}. Ask the user for these values.`,
        },
      },
      breakLoop: false,
    };
  }

  /**
   * Execute a single tool call — dispatches to system tools (handoff, delegate,
   * fan-out, escalate, complete) or regular tools via the session's ToolExecutor.
   */
  private async executeToolCall(
    session: RuntimeSession,
    toolCallParam: ToolCall,
    onChunk?: (chunk: string) => void,
    onTraceEvent?: (event: { type: string; data: Record<string, unknown> }) => void,
    llmCallId?: string,
  ): Promise<{
    toolResult: unknown;
    action?: { type: string; [key: string]: unknown };
    breakLoop?: boolean;
  }> {
    ensureRuntimeSessionDataStore(session);

    const startTime = Date.now();
    // Mutable binding: guardrail redaction may replace input parameters
    let toolCall = toolCallParam;
    let toolResult: unknown;
    let action: { type: string; [key: string]: unknown } | undefined;
    let breakLoop = false;
    let configurationDiagnostic: ExecutionConfigurationDiagnostic | undefined;
    let toolErrorCode: string | undefined;
    let runtimeErrorEnvelope: RuntimeErrorEnvelope | undefined;

    try {
      // --- Inline gather: handle _extract_entities tool calls ---
      if (toolCall.name === '_extract_entities' && session.agentIR?.execution?.inline_gather) {
        return this.handleInlineExtraction(session, toolCall, onChunk, onTraceEvent);
      }

      // --- Inline gather completeness gate ---
      // Block domain tools until required GATHER fields are collected
      if (
        session.agentIR?.execution?.inline_gather &&
        toolCall.name !== '_extract_entities' &&
        !toolCall.name.startsWith('__') &&
        !toolCall.name.startsWith('handoff_to_') &&
        !toolCall.name.startsWith('delegate_to_')
      ) {
        const gf = session.agentIR?.gather?.fields;
        if (gf && gf.length > 0) {
          const { complete, missing } = checkGatherComplete(
            { fields: gf as GatherField[] },
            session.data.values,
            undefined,
          );
          if (!complete) {
            return {
              toolResult: {
                success: false,
                error: {
                  code: 'GATHER_INCOMPLETE',
                  message: `Cannot call ${toolCall.name} yet — missing required fields: ${missing.join(', ')}. Use _extract_entities to collect them first, or ask the user.`,
                  missing_fields: missing,
                },
              },
              breakLoop: false,
            };
          }
        }
      }

      // -----------------------------------------------------------------------
      // Strip observability-only fields (reason, thought) from system tool input.
      // These are captured as a decision trace event but must NOT be forwarded to
      // the tool executor or routing handler.
      //
      // Exception: __escalate__ and __return_to_parent__ use `reason` as an
      // operational field, so we only strip `thought` from those calls.
      // -----------------------------------------------------------------------
      const isSystemTool =
        toolCall.name.startsWith('__') ||
        toolCall.name.startsWith('handoff_to_') ||
        toolCall.name.startsWith('delegate_to_');
      let input = toolCall.input;
      if (isSystemTool) {
        const { reason, thought, ...rest } = toolCall.input;
        // For __escalate__ and __return_to_parent__, `reason` is operational — keep it.
        // For all other system tools, `reason` is observability-only and stripped.
        if (
          toolCall.name === SYSTEM_TOOL_ESCALATE ||
          toolCall.name === SYSTEM_TOOL_RETURN_TO_PARENT
        ) {
          const { thought: _t, ...cleanInput } = toolCall.input;
          input = cleanInput;
        } else {
          input = rest;
        }
        if (reason || thought) {
          onTraceEvent?.({
            type: 'decision',
            data: {
              action: toolCall.name,
              reasoning: reason,
              thought,
            },
          });
          if (thought) {
            onTraceEvent?.({
              type: 'tool_thought',
              data: {
                toolName: toolCall.name,
                thought,
                reasoning: reason,
                agent: session.agentName,
                llmCallId,
                visibility: 'chat_thought_only',
              },
            });
          } else if (reason) {
            // Emit lightweight tool_thought with thought: null when only reason
            // exists (enableThinking is off). Studio renders this as a "Reasoning" card.
            onTraceEvent?.({
              type: 'tool_thought',
              data: {
                toolName: toolCall.name,
                thought: null,
                reasoning: reason,
                agent: session.agentName,
                llmCallId,
                visibility: 'chat_thought_only',
              },
            });
          }
        }
      }

      const preToolViolation = checkFlatConstraintsAtCheckpoint(
        session,
        { kind: 'tool_call', target: toolCall.name },
        onTraceEvent,
      );
      if (preToolViolation) {
        return this.executeConstraintViolationInLoop(
          session,
          preToolViolation,
          onChunk,
          onTraceEvent,
        );
      }

      // Check for action tools — per-agent routing tools (handoff_to_*, delegate_to_*)
      if (toolCall.name.startsWith('handoff_to_')) {
        // Per-agent handoff: target encoded in tool name
        const target = toolCall.name.slice('handoff_to_'.length);
        // Inject target into input so handleHandoff can find it
        const handoffInput = { ...input, target };
        const result = await this.routing.handleHandoff(
          session,
          handoffInput,
          onChunk,
          onTraceEvent,
        );
        toolResult = result;
        if (result.success) {
          action = { type: 'handoff', target, ...result };
          breakLoop = !!result.response;
        }
      } else if (toolCall.name.startsWith('delegate_to_')) {
        // Per-agent delegate: target encoded in tool name
        const target = toolCall.name.slice('delegate_to_'.length);
        const delegateInput = { ...input, target };
        const result = await this.routing.handleDelegate(
          session,
          delegateInput,
          onChunk,
          onTraceEvent,
        );
        toolResult = result;
        action = { type: 'delegate', target };
        // Don't break - continue with the result
      } else if (toolCall.name === SYSTEM_TOOL_HANDOFF) {
        // Legacy: generic __handoff__ tool (kept as safety net for cached tool lists)
        const result = await this.routing.handleHandoff(session, input, onChunk, onTraceEvent);
        toolResult = result;
        // Break loop only when the child produced a response (non-empty).
        // Silent child completion (response = "") means the supervisor should continue —
        // the handoff was a tool call, and an empty result lets the LLM respond itself.
        if (result.success) {
          action = { type: 'handoff', target: input.target, ...result };
          breakLoop = !!result.response;
        }
      } else if (toolCall.name === SYSTEM_TOOL_DELEGATE) {
        const result = await this.routing.handleDelegate(session, input, onChunk, onTraceEvent);
        toolResult = result;
        action = { type: 'delegate', target: input.target };
        // Don't break - continue with the result
      } else if (toolCall.name === SYSTEM_TOOL_FAN_OUT) {
        // Prevent recursive fan-out: only block if we're inside a fan-out child thread
        // (delegates and normal handoffs CAN still fan-out)
        const activeThread = getActiveThread(session);
        if (activeThread.data.values._fan_out_child) {
          toolResult = { success: false, error: 'Cannot fan-out from within a fan-out task' };
        } else {
          const result = await this.routing.handleFanOut(
            session,
            input as {
              tasks: Array<{ target: string; intent: string; context?: Record<string, unknown> }>;
            },
            onChunk,
            onTraceEvent,
          );
          // (Issue5) Handle A4 concurrent guard error without leaking _guard sentinel to LLM
          if (
            !result.success &&
            result.results.length === 1 &&
            result.results[0].target === '_guard'
          ) {
            toolResult = { success: false, error: result.results[0].error };
          } else {
            // Format as structured text so the LLM can synthesize a unified response
            toolResult = this.routing.formatFanOutToolResult(result);
          }
          action = {
            type: 'fan_out',
            taskCount: result.results.length,
            failedCount: result.failedCount,
          };
        }
        // Do NOT set breakLoop — results go back to LLM for synthesis
      } else if (toolCall.name === SYSTEM_TOOL_COMPLETE) {
        // Option C: The COMPLETE tool is no longer offered to LLMs via buildTools().
        // This handler is kept as a safety net — if the LLM somehow calls it (e.g.,
        // from cached tool lists or test mocks), it still works correctly.
        const result = this.routing.handleComplete(session, input, onTraceEvent);
        toolResult = result;
        action = { type: 'complete', message: input.message };
        breakLoop = true;

        if (onChunk && input.message) {
          onChunk(this.filterChunkPII(session, input.message as string));
        }
      } else if (toolCall.name === SYSTEM_TOOL_ESCALATE) {
        // First-turn warning: emit trace if escalating on the very first user message
        const userMessages = session.conversationHistory.filter((m) => m.role === 'user');
        if (userMessages.length <= 1 && onTraceEvent) {
          onTraceEvent({
            type: 'warning',
            data: {
              message: 'Escalation triggered on first user message',
              agent: session.agentName,
            },
          });
        }

        const result = await this.routing.handleEscalate(session, input, onTraceEvent);
        toolResult = result;
        action = {
          type: 'escalate',
          reason: input.reason,
          priority: input.priority,
        };
        breakLoop = result.success !== false;

        if (onChunk && result.message) {
          const protectedEscalation = protectSessionOutputForUser(session, result.message);
          onChunk(`\n\n${protectedEscalation.deliveryText}`);
        }
      } else if (toolCall.name === SYSTEM_TOOL_RETURN_TO_PARENT) {
        const result = this.routing.handleReturnToParent(session, input, onTraceEvent);
        toolResult = result;
        action = { type: 'return_to_parent', forwardedMessage: input.message };
        breakLoop = true;
      } else if (toolCall.name === SYSTEM_TOOL_SET_CONTEXT) {
        const updates = input?.updates;
        if (updates && typeof updates === 'object') {
          // Validate: allow declared session vars, writable execution_tree memory,
          // writable granted memory, or _meta.* for custom dimensions.
          const sessionMemoryKeys =
            session.agentIR?.memory?.session?.map((s: string | { name: string }) =>
              typeof s === 'string' ? s : s.name,
            ) ?? [];
          const reasoningZoneKeys = getReasoningZoneSettableContextVars(session).map(
            (entry) => entry.name,
          );
          const allowedKeys = new Set([
            ...sessionMemoryKeys,
            ...reasoningZoneKeys,
            ...getWritableExecutionTreePaths(session),
            ...getWritableGrantedMemoryKeys(session),
          ]);
          const gatheredSessionKeys = new Set(sessionMemoryKeys);
          const applied: Record<string, unknown> = {};
          const rejected: string[] = [];
          const rejectedPlaceholderKeys: string[] = [];
          for (const [key, value] of Object.entries(updates as Record<string, unknown>)) {
            if (key.startsWith('_meta.')) {
              // Route _meta.* keys to customDimensions
              const dimensionKey = key.slice(6);
              const dimResult = mergeSessionDimensions(session, {
                [dimensionKey]: value,
              });
              if (dimResult.dimensions.size > 0) {
                applied[key] = value;
              } else {
                rejected.push(key);
              }
            } else if (allowedKeys.has(key)) {
              if (gatheredSessionKeys.has(key) && isPlaceholderSessionMemoryValue(value)) {
                rejected.push(key);
                rejectedPlaceholderKeys.push(key);
                continue;
              }
              if (!applyScopedMemoryWrite(session, key, value)) {
                session.data.values[key] = value;
              }
              if (gatheredSessionKeys.has(key)) {
                session.data.gatheredKeys.add(key);
              }
              applied[key] = value;
            } else {
              rejected.push(key);
            }
          }

          toolResult = {
            success: true,
            stored: Object.keys(applied),
            ...(rejected.length > 0 && { rejected_keys: rejected }),
            ...(rejectedPlaceholderKeys.length > 0 && {
              rejected_placeholder_keys: rejectedPlaceholderKeys,
            }),
          };

          // Trigger REMEMBER evaluation — same as after any state change
          if (Object.keys(applied).length > 0) {
            try {
              await evaluateRememberAfterStateChange(session, onTraceEvent);
            } catch (err) {
              log.warn('memory remember after set_context failed', {
                error: err instanceof Error ? err.message : String(err),
              });
            }

            // Check if COMPLETE conditions are now satisfied after state change.
            // This eliminates a redundant LLM iteration in fan-out scenarios where
            // __set_context__ writes the value that satisfies the completion condition.
            const completionResult = this.routing.checkCompletionConditions(
              session,
              onChunk,
              onTraceEvent,
              { source: 'set_context_state_change' },
            );
            if (completionResult) {
              return {
                toolResult: {
                  ...((toolResult as Record<string, unknown>) ?? {}),
                  message: completionResult.response,
                },
                action: {
                  type: 'complete',
                  message: completionResult.response,
                },
                breakLoop: true,
              };
            }

            const constraintViolation = checkFlatConstraints(session, onTraceEvent);
            if (constraintViolation) {
              return this.executeConstraintViolationInLoop(
                session,
                constraintViolation,
                onChunk,
                onTraceEvent,
              );
            }
          }
        } else {
          toolResult = { success: false, error: 'updates must be an object of key-value pairs' };
        }
      } else {
        // Guard: reject tool calls that are not declared in the agent IR
        const declaredToolNames = session.agentIR?.tools?.map((t) => t.name) ?? [];
        if (
          declaredToolNames.length > 0 &&
          !declaredToolNames.includes(toolCall.name) &&
          !isAttachmentTool(toolCall.name)
        ) {
          toolResult = { error: `Tool "${toolCall.name}" is not declared in agent configuration` };
          onTraceEvent?.({
            type: 'tool_call',
            data: {
              phase: 'complete',
              toolCallId: toolCall.id,
              toolName: toolCall.name,
              status: 'rejected',
              reason: 'undeclared_tool',
              agent: session.agentName,
              durationMs: Date.now() - startTime,
            },
          });
          return { toolResult };
        }

        // Tool input guardrail check — evaluate before executing the tool
        const dslGuardrails = session.agentIR?.constraints?.guardrails ?? [];
        const toolPolicy = await getSessionPolicy(session);
        const allGuardrails = [...dslGuardrails, ...(toolPolicy?.additionalGuardrails ?? [])];
        if (allGuardrails.some((g) => g.kind === 'tool_input')) {
          try {
            if (session.tenantId) await ensureTenantProvidersLoaded(session.tenantId);
            // Create per-invocation pipeline with llmEval for Tier 3 guardrails
            const llmEval = session.llmClient
              ? createLLMEvalFromClient(session.llmClient)
              : undefined;
            const pipeline = createGuardrailPipeline(llmEval, session.tenantId, session.projectId, {
              policy: toolPolicy,
              piiRecognizerRegistry: session.piiRecognizerRegistry,
              cacheScopeKey: getSessionGuardrailCacheScopeKey(session),
            });
            // Pipeline merges policy-defined guardrails internally; pass DSL guardrails only.
            const guardrailResult = await pipeline.execute(
              dslGuardrails,
              JSON.stringify(toolCall.input),
              'tool_input',
              {
                toolName: toolCall.name,
                toolParameters: toolCall.input as Record<string, unknown>,
                agentGoal: session.agentIR?.identity?.goal,
              },
              onTraceEvent
                ? (event) =>
                    onTraceEvent({
                      type: 'guardrail_check',
                      data: event as Record<string, unknown>,
                    })
                : undefined,
              toolPolicy,
            );

            if (!guardrailResult.passed) {
              // Guardrail blocked this tool call
              const violationMsg =
                guardrailResult.primaryViolation?.message ??
                formatErrorSync('GUARDRAIL_TOOL_INPUT_BLOCKED').message;
              toolResult = {
                error: violationMsg,
                guardrail: guardrailResult.primaryViolation?.name,
              };
              const latencyMs = Date.now() - startTime;
              recordToolCall({ toolName: toolCall.name, durationMs: latencyMs, success: false });
              onTraceEvent?.(
                traceToolBlocked({
                  toolName: toolCall.name,
                  guardrailName: guardrailResult.primaryViolation?.name ?? 'unknown',
                  reason: guardrailResult.primaryViolation?.action ?? 'block',
                  agent: session.agentName,
                }),
              );
              onTraceEvent?.({
                type: 'tool_call',
                data: {
                  phase: 'complete',
                  toolCallId: toolCall.id,
                  toolName: toolCall.name,
                  input: toolCall.input,
                  output: toolResult,
                  success: false,
                  latencyMs,
                  isActionTool: false,
                  agent: session.agentName,
                  blockedByGuardrail: true,
                },
              });
              return { toolResult };
            }

            // If guardrail redacted/modified the content, use modified parameters
            if (guardrailResult.modifiedContent) {
              try {
                toolCall = {
                  ...toolCall,
                  input: JSON.parse(guardrailResult.modifiedContent),
                };

                // Re-validate modified params — guardrail redaction can break type/required constraints
                const toolDefForRevalidation = session.agentIR?.tools?.find(
                  (t) => t.name === toolCall.name,
                );
                if (toolDefForRevalidation?.parameters?.length) {
                  const { validateToolInputs } = await import('@abl/compiler/platform/constructs');
                  try {
                    validateToolInputs(
                      toolCall.name,
                      toolCall.input as Record<string, unknown>,
                      toolDefForRevalidation.parameters,
                    );
                  } catch (validationErr) {
                    log.warn('Post-guardrail re-validation failed', {
                      toolName: toolCall.name,
                      error:
                        validationErr instanceof Error
                          ? validationErr.message
                          : String(validationErr),
                    });
                    toolResult = {
                      error: `Tool input invalid after guardrail modification: ${validationErr instanceof Error ? validationErr.message : String(validationErr)}`,
                      guardrail: 'post_modification_revalidation',
                    };
                    return { toolResult };
                  }
                }
              } catch {
                // If modified content isn't valid JSON, use original parameters
                log.warn(
                  'Guardrail modified content is not valid JSON, using original parameters',
                  {
                    toolName: toolCall.name,
                  },
                );
              }
            }
          } catch (guardrailErr) {
            // Fail-open: pipeline errors should NOT block tool execution
            log.warn('Guardrail pipeline error — failing open, tool execution proceeds', {
              toolName: toolCall.name,
              error: guardrailErr instanceof Error ? guardrailErr.message : String(guardrailErr),
            });
            onTraceEvent?.(
              tracePipelineError({
                kind: 'tool_input',
                error: guardrailErr instanceof Error ? guardrailErr.message : String(guardrailErr),
                agent: session.agentName,
              }),
            );
          }
        }

        // Resolve tool definition from IR (used for context injection + post-tool mappings)
        const toolDef = session.agentIR?.tools?.find((t) => t.name === toolCall.name);

        // Confirmation gate — require user approval for configured tools
        if (toolDef?.confirmation && shouldRequireConfirmation(toolDef)) {
          const conversationConsent = evaluateConversationConsent(
            toolCall,
            toolDef.confirmation,
            session.conversationHistory,
          );
          if (conversationConsent.satisfied) {
            delete session.data.values._pending_tool_confirmation;
            onTraceEvent?.({
              type: 'tool_confirmation_consent_detected',
              data: {
                toolName: toolCall.name,
                toolCallId: toolCall.id,
                agent: session.agentName,
                matchedAction: conversationConsent.evidence?.matchedAction,
                scopedFields: conversationConsent.evidence?.scopedFields ?? [],
              },
            });
          } else {
            const pendingConfirmation = session.data.values._pending_tool_confirmation as
              | import('./tool-confirmation.js').ToolConfirmationSnapshot
              | undefined;

            if (!pendingConfirmation || pendingConfirmation.toolCallId !== toolCall.id) {
              if (conversationConsent.reason === 'scope_mismatch') {
                onTraceEvent?.({
                  type: 'tool_confirmation_consent_scope_mismatch',
                  data: {
                    toolName: toolCall.name,
                    toolCallId: toolCall.id,
                    agent: session.agentName,
                  },
                });
              }

              if (
                shouldBlockForMissingConversationConsent(toolDef.confirmation, conversationConsent)
              ) {
                onTraceEvent?.({
                  type: 'tool_confirmation_rejected',
                  data: {
                    toolName: toolCall.name,
                    toolCallId: toolCall.id,
                    agent: session.agentName,
                    reason:
                      conversationConsent.reason === 'scope_mismatch'
                        ? 'conversation_consent_scope_mismatch'
                        : 'conversation_consent_missing',
                  },
                });
                return {
                  toolResult: {
                    error:
                      'This action requires consent in the conversation before it can proceed.',
                  },
                };
              }

              // First time — create snapshot and pause for confirmation
              const snapshot = createSnapshot(toolCall, toolDef.confirmation);
              session.data.values._pending_tool_confirmation = snapshot;

              onTraceEvent?.({
                type: 'tool_confirmation_requested',
                data: {
                  toolName: toolCall.name,
                  toolCallId: toolCall.id,
                  immutableParams: snapshot.immutableParams,
                  agent: session.agentName,
                },
              });

              const confirmMsg = formatConfirmationMessage(toolCall, toolDef.confirmation);
              return {
                toolResult: { confirmation_required: true, message: confirmMsg },
                action: { type: 'await_confirmation', toolName: toolCall.name },
                breakLoop: true,
              };
            }

            // Re-execution after user confirmed — validate immutability
            if (isSnapshotExpired(pendingConfirmation)) {
              delete session.data.values._pending_tool_confirmation;
              onTraceEvent?.({
                type: 'tool_confirmation_rejected',
                data: { toolName: toolCall.name, toolCallId: toolCall.id, reason: 'expired' },
              });
              return { toolResult: { error: 'Confirmation expired. Please try again.' } };
            }

            const immutabilityCheck = validateImmutability(
              pendingConfirmation,
              toolCall.input as Record<string, unknown>,
            );

            if (!immutabilityCheck.valid) {
              delete session.data.values._pending_tool_confirmation;
              onTraceEvent?.({
                type: 'tool_confirmation_immutability_violation',
                data: {
                  toolName: toolCall.name,
                  violations: immutabilityCheck.violations,
                  agent: session.agentName,
                },
              });
              return {
                toolResult: {
                  error: `Parameter tampering detected. Locked parameters changed: ${immutabilityCheck.violations.join(', ')}`,
                },
              };
            }

            // Passed — clean up and proceed to execution
            delete session.data.values._pending_tool_confirmation;
            onTraceEvent?.({
              type: 'tool_confirmation_approved',
              data: { toolName: toolCall.name, toolCallId: toolCall.id, agent: session.agentName },
            });
          }
        }

        // Regular tool — use session's tool executor (ToolBindingExecutor or NoOpToolExecutor)
        if (session.toolExecutor) {
          // Strip observability-only fields (thought, reason) only when they are
          // not part of the declared tool schema. Some business tools legitimately
          // expose a `reason` parameter that must survive dispatch.
          const {
            thought: userToolThought,
            reason: userToolReason,
            cleanInput,
          } = stripObservabilityFieldsFromRegularToolInput(
            toolCall.input as Record<string, unknown>,
            toolDef,
          );
          // F-1: audit emission is now centralized inside restorePIITokensForToolExecution
          // via auditContext — no inline emission needed here.
          const { value: rawExecutionInput } = restorePIITokensForToolExecution(
            session,
            cleanInput,
            {
              piiAccess: toolDef?.pii_access,
              auditContext: {
                onTraceEvent,
                toolName: toolCall.name,
                agentId: session.agentName,
                sessionId: session.id,
                tenantId: session.tenantId,
                projectId: session.projectId,
              },
            },
          );
          const executionInput = rawExecutionInput as Record<string, unknown>;

          if (userToolThought) {
            onTraceEvent?.({
              type: 'tool_thought',
              data: {
                toolName: toolCall.name,
                thought: userToolThought,
                reasoning: userToolReason,
                agent: session.agentName,
                llmCallId,
              },
            });
          } else if (userToolReason) {
            // Emit lightweight tool_thought with thought: null when only reason
            // exists (enableThinking is off). Studio renders this as a "Reasoning" card.
            onTraceEvent?.({
              type: 'tool_thought',
              data: {
                toolName: toolCall.name,
                thought: null,
                reasoning: userToolReason,
                agent: session.agentName,
                llmCallId,
              },
            });
          }
          // D1: Inject declared CONTEXT_ACCESS.read vars into tool params
          if (toolDef?.context_access?.read?.length) {
            const ctx: Record<string, unknown> = {};
            const piiConsumer = toolDef.pii_access ?? getToolPIIAccess(session, toolCall.name);
            for (const key of toolDef.context_access.read) {
              if (key in session.data.values) {
                const val = session.data.values[key];
                // F-8: audit emission now uses real per-token data via auditContext,
                // replacing the synthetic tokenId/piiType that was here before.
                const { value: renderedValue } = restorePIITokensForToolExecution(session, val, {
                  piiAccess: piiConsumer,
                  auditContext: {
                    onTraceEvent,
                    toolName: toolCall.name,
                    agentId: session.agentName,
                    sessionId: session.id,
                    tenantId: session.tenantId,
                    projectId: session.projectId,
                  },
                });
                ctx[key] = renderedValue;
              }
            }
            executionInput._context = ctx;
          }

          // Inject session metadata for {{session.X}} placeholders in tool DSL templates.
          // Only safe, non-sensitive metadata — no secrets, API keys, or conversation history.
          executionInput._session = {
            id: session.id,
            tenantId: session.tenantId,
            projectId: session.projectId,
            agentName: session.agentName,
            ...(session.data.values._metadata ? { _metadata: session.data.values._metadata } : {}),
          };

          try {
            const httpMeta =
              toolDef?.tool_type === 'http' && toolDef.http_binding
                ? buildHttpTraceMeta(toolDef.http_binding)
                : {};
            onTraceEvent?.({
              type: 'tool_call_start',
              data: {
                ...httpMeta,
                toolCallId: toolCall.id,
                toolName: toolCall.name,
                input: toolCall.input,
                isActionTool: false,
                agent: session.agentName,
                ...(llmCallId ? { llmCallId } : {}),
              },
            });
            toolResult = await session.toolExecutor.execute(toolCall.name, executionInput, 30000);
          } catch (toolErr) {
            const errorMessage = toolErr instanceof Error ? toolErr.message : String(toolErr);
            const toolErrorMeta = getToolExecutionErrorMetadata(toolErr);
            const classification = classifyToolError(toolErr);
            runtimeErrorEnvelope = buildRuntimeErrorEnvelope(toolErr, {
              traceId: getCurrentTraceId() ?? undefined,
              agentName: session.agentName,
              toolName: toolCall.name,
            });
            toolErrorCode = toolErrorMeta.code;
            configurationDiagnostic = classifyExecutionConfigurationDiagnostic(toolErr);
            const errorCtx: ErrorContext = {
              type: 'tool_error',
              subtype: classification.subtype ?? toolErrorMeta.code,
              message: errorMessage,
              retryable: classification.subtype
                ? classification.retryable
                : (toolErrorMeta.retryable ?? true),
            };

            if (session.agentIR) {
              const resolution = resolveErrorHandler(errorCtx, session.agentIR);
              if (resolution?.retryCount && resolution.retryDelays) {
                try {
                  toolResult = await executeWithRetry(
                    () => session.toolExecutor!.execute(toolCall.name, executionInput, 30000),
                    resolution,
                    (attempt, delay) => {
                      onTraceEvent?.({
                        type: 'tool_call_retry',
                        data: { toolName: toolCall.name, attempt, delay },
                      });
                    },
                  );
                  toolErrorCode = undefined;
                  configurationDiagnostic = undefined;
                  runtimeErrorEnvelope = undefined;
                } catch {
                  toolResult = { error: errorMessage, handlerAction: resolution.action };
                }
              } else if (resolution) {
                toolResult = { error: errorMessage, handlerAction: resolution.action };
              } else {
                toolResult = { error: errorMessage };
              }

              if (!resolution) {
                onTraceEvent?.({
                  type: 'tool_call_error',
                  data: {
                    toolName: toolCall.name,
                    error: errorMessage.slice(0, 200),
                    handlerFound: false,
                    ...(errorCtx.subtype ? { subtype: errorCtx.subtype } : {}),
                    ...(toolErrorCode ? { errorCode: toolErrorCode } : {}),
                    ...(configurationDiagnostic ? { diagnostic: configurationDiagnostic } : {}),
                    ...(runtimeErrorEnvelope ? { errorEnvelope: runtimeErrorEnvelope } : {}),
                  },
                });
              }

              if (resolution) {
                const localizedHandlerResponse = resolveLocalizedErrorHandlerResponseWithMetadata({
                  session,
                  resolution,
                });
                const responseText = localizedHandlerResponse?.text ?? resolution.respond;
                const protectedHandlerResponse = responseText
                  ? protectSessionOutputForUser(session, responseText)
                  : undefined;
                const protectedStructuredHandlerPayload =
                  resolution.richContent !== undefined ||
                  resolution.voiceConfig !== undefined ||
                  resolution.actions !== undefined
                    ? protectStructuredOutputForUser(session, {
                        richContent: resolution.richContent,
                        voiceConfig: resolution.voiceConfig,
                        actions: resolution.actions,
                      })
                    : undefined;
                onTraceEvent?.({
                  type: 'error_handler_resolved',
                  data: {
                    toolName: toolCall.name,
                    errorMessage: errorMessage.slice(0, 200),
                    handlerAction: resolution.action,
                    ...(errorCtx.subtype ? { subtype: errorCtx.subtype } : {}),
                    ...(toolErrorCode ? { errorCode: toolErrorCode } : {}),
                    ...(configurationDiagnostic ? { diagnostic: configurationDiagnostic } : {}),
                    ...(runtimeErrorEnvelope ? { errorEnvelope: runtimeErrorEnvelope } : {}),
                  },
                });
                const shouldExposeHandlerOutput = resolution.action !== 'continue';

                // `continue` handlers are observability-only for tool errors: the
                // trace records the authored response, but intermediate recovery
                // copy must not become user-visible assistant text.
                if (responseText) {
                  onTraceEvent?.({
                    type: 'error_handler_response',
                    data: { toolName: toolCall.name, respond: responseText },
                  });
                  if (shouldExposeHandlerOutput) {
                    try {
                      onChunk?.(protectedHandlerResponse?.deliveryText ?? responseText);
                    } catch {
                      /* post-close or consumer rejected — trace already recorded */
                    }
                  }
                }

                if (
                  shouldExposeHandlerOutput &&
                  protectedStructuredHandlerPayload?.delivery.richContent !== undefined
                ) {
                  session.pendingRichContent =
                    protectedStructuredHandlerPayload.delivery.richContent;
                  if (protectedHandlerResponse?.deliveryText) {
                    session.pendingResponse = protectedHandlerResponse.deliveryText;
                  }
                }

                if (
                  shouldExposeHandlerOutput &&
                  typeof toolResult === 'object' &&
                  toolResult !== null
                ) {
                  Object.assign(toolResult as Record<string, unknown>, {
                    ...(responseText ? { __error_handler_respond: responseText } : {}),
                    ...(localizedHandlerResponse?.localization
                      ? { __error_handler_localization: localizedHandlerResponse.localization }
                      : {}),
                    ...(protectedStructuredHandlerPayload?.delivery.richContent !== undefined
                      ? {
                          __error_handler_rich_content:
                            protectedStructuredHandlerPayload.delivery.richContent,
                        }
                      : {}),
                    ...(protectedStructuredHandlerPayload?.delivery.voiceConfig !== undefined
                      ? {
                          __error_handler_voice_config:
                            protectedStructuredHandlerPayload.delivery.voiceConfig,
                        }
                      : {}),
                    ...(protectedStructuredHandlerPayload?.delivery.actions !== undefined
                      ? {
                          __error_handler_actions:
                            protectedStructuredHandlerPayload.delivery.actions,
                        }
                      : {}),
                  });
                }

                if (shouldExposeHandlerOutput && protectedStructuredHandlerPayload !== undefined) {
                  action = { type: 'continue' };
                  breakLoop = true;
                  toolResult = {
                    response: responseText ?? '',
                    ...(localizedHandlerResponse?.localization
                      ? { localization: localizedHandlerResponse.localization }
                      : {}),
                    ...(protectedStructuredHandlerPayload?.delivery.richContent !== undefined
                      ? { richContent: protectedStructuredHandlerPayload.delivery.richContent }
                      : {}),
                    ...(protectedStructuredHandlerPayload?.delivery.voiceConfig !== undefined
                      ? { voiceConfig: protectedStructuredHandlerPayload.delivery.voiceConfig }
                      : {}),
                    ...(protectedStructuredHandlerPayload?.delivery.actions !== undefined
                      ? { actions: protectedStructuredHandlerPayload.delivery.actions }
                      : {}),
                  };
                }

                // Handle handoff action by invoking routing — mirror the outer
                // loop's handoff signaling (action + breakLoop) so the reasoning
                // loop exits with the child agent's response.
                if (resolution.action === 'handoff' && resolution.handoffTarget) {
                  try {
                    const handoffResult = await this.routing.handleHandoff(
                      session,
                      { target: resolution.handoffTarget },
                      onChunk,
                      onTraceEvent,
                    );
                    action = { type: 'handoff', target: resolution.handoffTarget };
                    breakLoop = true;
                    toolResult = {
                      error: errorMessage,
                      handlerAction: 'handoff',
                      handoffTarget: resolution.handoffTarget,
                      response: handoffResult.response,
                      result: handoffResult.result,
                    };
                  } catch {
                    /* routing invocation traced internally; keep toolResult as-is */
                  }
                }
              }
            } else {
              onTraceEvent?.({
                type: 'tool_call_error',
                data: {
                  toolName: toolCall.name,
                  error: errorMessage.slice(0, 200),
                  handlerFound: false,
                  ...(errorCtx.subtype ? { subtype: errorCtx.subtype } : {}),
                },
              });
              toolResult = { error: errorMessage };
            }
          }
        } else {
          toolResult = { error: `No tool executor configured for: ${toolCall.name}` };
        }

        // Tool output guardrail check — evaluate after tool execution, before results reach LLM
        if (allGuardrails.some((g) => g.kind === 'tool_output')) {
          try {
            if (session.tenantId) await ensureTenantProvidersLoaded(session.tenantId);
            // Create per-invocation pipeline with llmEval for Tier 3 guardrails
            const llmEvalOut = session.llmClient
              ? createLLMEvalFromClient(session.llmClient)
              : undefined;
            const outputPipeline = createGuardrailPipeline(
              llmEvalOut,
              session.tenantId,
              session.projectId,
              {
                policy: toolPolicy,
                piiRecognizerRegistry: session.piiRecognizerRegistry,
                cacheScopeKey: getSessionGuardrailCacheScopeKey(session),
              },
            );
            const outputContent =
              typeof toolResult === 'string' ? toolResult : JSON.stringify(toolResult);
            const outputGuardrailResult = await outputPipeline.execute(
              dslGuardrails,
              outputContent,
              'tool_output',
              {
                toolName: toolCall.name,
                toolResult: toolResult as Record<string, unknown>,
                toolSuccess: !(
                  typeof toolResult === 'object' &&
                  toolResult !== null &&
                  'error' in toolResult
                ),
                toolDurationMs: Date.now() - startTime,
                agentGoal: session.agentIR?.identity?.goal,
              },
              onTraceEvent
                ? (event) =>
                    onTraceEvent({
                      type: 'guardrail_check',
                      data: event as Record<string, unknown>,
                    })
                : undefined,
              toolPolicy,
            );

            if (!outputGuardrailResult.passed) {
              const violationMsg =
                outputGuardrailResult.primaryViolation?.message ??
                formatErrorSync('GUARDRAIL_TOOL_OUTPUT_BLOCKED').message;
              toolResult = {
                error: violationMsg,
                guardrail: outputGuardrailResult.primaryViolation?.name,
              };
              onTraceEvent?.(
                traceToolOutputBlocked({
                  toolName: toolCall.name,
                  guardrailName: outputGuardrailResult.primaryViolation?.name ?? 'unknown',
                  reason: outputGuardrailResult.primaryViolation?.action ?? 'block',
                  agent: session.agentName,
                }),
              );
            }

            if (outputGuardrailResult.modifiedContent) {
              try {
                toolResult = JSON.parse(outputGuardrailResult.modifiedContent);
              } catch {
                log.warn(
                  'Guardrail modified tool output is not valid JSON, using original result',
                  {
                    toolName: toolCall.name,
                  },
                );
              }
            }
          } catch (guardrailErr) {
            // Fail-open: pipeline errors should NOT block tool results
            log.warn('Tool output guardrail evaluation failed, using original result', {
              toolName: toolCall.name,
              error: guardrailErr instanceof Error ? guardrailErr.message : String(guardrailErr),
            });
            onTraceEvent?.(
              tracePipelineError({
                kind: 'tool_output',
                toolName: toolCall.name,
                error: guardrailErr instanceof Error ? guardrailErr.message : String(guardrailErr),
                agent: session.agentName,
              }),
            );
          }
        }

        const isError =
          typeof toolResult === 'object' &&
          toolResult !== null &&
          ('error' in toolResult || (toolResult as Record<string, unknown>).is_error === true);

        // NOTE: the completion tool_call trace is emitted at the end of executeToolCall().
        // Do NOT emit completion here — it would duplicate the trace event.

        // Conditionally store raw result (default: true if no on_result, false if on_result defined)
        const shouldStoreRaw = toolDef?.store_result ?? (toolDef?.on_result ? false : true);
        if (shouldStoreRaw) {
          session.data.values[`last_${toolCall.name}_result`] = toolResult;
        }

        // Apply ON_RESULT or ON_ERROR SET mappings
        const mapping = isError ? toolDef?.on_error?.set : toolDef?.on_result?.set;
        if (mapping) {
          for (const [varName, valueExpr] of Object.entries(mapping)) {
            const resolvedValue = valueExpr.startsWith('result.')
              ? getNestedValue(toolResult as Record<string, unknown>, valueExpr.slice(7))
              : resolveSetValue(valueExpr, session.data.values);
            if (valueExpr.startsWith('result.')) {
              if (!applyScopedMemoryWrite(session, varName, resolvedValue)) {
                session.data.values[varName] = resolvedValue;
              }
              continue;
            }

            if (!applyScopedMemoryWrite(session, varName, resolvedValue)) {
              session.data.values[varName] = resolvedValue;
            }
          }
        }

        // D2: Apply context_updates from tool response (CONTEXT_ACCESS.write whitelist)
        // Updates are written to session.data.values. For persistent DB writes,
        // use REMEMBER triggers — they evaluate right after this block.
        if (
          toolDef?.context_access?.write?.length &&
          typeof toolResult === 'object' &&
          toolResult !== null &&
          'context_updates' in toolResult
        ) {
          const updates = (toolResult as Record<string, unknown>).context_updates;
          if (typeof updates === 'object' && updates !== null) {
            const writeSet = new Set(toolDef.context_access.write);
            for (const [key, value] of Object.entries(updates as Record<string, unknown>)) {
              if (writeSet.has(key)) {
                if (!applyScopedMemoryWrite(session, key, value)) {
                  session.data.values[key] = value;
                }
              }
            }
            onTraceEvent?.({
              type: 'context_access_write',
              data: {
                toolName: toolCall.name,
                updatedKeys: Object.keys(updates as Record<string, unknown>).filter((k) =>
                  writeSet.has(k),
                ),
              },
            });
          }
        }

        // Memory: REMEMBER triggers + RECALL on tool events.
        // SearchAI KB tools are read-only — their results don't mutate session state
        // in ways that affect REMEMBER/RECALL triggers. Fire-and-forget to avoid
        // blocking the LLM iteration on no-op async work (~1-5ms saved per search call).
        const isReadOnlySearchTool = this.isSearchAIKBTool(session, toolCall.name);
        if (isReadOnlySearchTool) {
          evaluateRememberAfterStateChange(session, onTraceEvent).catch((err) => {
            log.warn('memory remember after search tool call failed', {
              error: err instanceof Error ? err.message : String(err),
            });
          });
          executeRecallAfterToolCall(session, toolCall.name, onTraceEvent).catch((err) => {
            log.warn('memory recall after search tool call failed', {
              error: err instanceof Error ? err.message : String(err),
            });
          });
        } else {
          try {
            await evaluateRememberAfterStateChange(session, onTraceEvent);
          } catch (err) {
            log.warn('memory remember after tool call failed', {
              error: err instanceof Error ? err.message : String(err),
            });
          }
          try {
            await executeRecallAfterToolCall(session, toolCall.name, onTraceEvent);
          } catch (err) {
            log.warn('memory recall after tool call failed', {
              error: err instanceof Error ? err.message : String(err),
            });
          }
        }

        // Post-tool constraint check
        const postToolViolation = checkFlatConstraints(session, onTraceEvent);
        if (postToolViolation) {
          const constraintOutcome = await this.executeConstraintViolationInLoop(
            session,
            postToolViolation,
            onChunk,
            onTraceEvent,
          );
          toolResult = constraintOutcome.toolResult;
          action = constraintOutcome.action;
          breakLoop = constraintOutcome.breakLoop === true;
        }
      }
    } catch (e) {
      const toolErrorMeta = getToolExecutionErrorMetadata(e);
      toolErrorCode = toolErrorMeta.code;
      configurationDiagnostic = classifyExecutionConfigurationDiagnostic(e);
      runtimeErrorEnvelope = buildRuntimeErrorEnvelope(e, {
        traceId: getCurrentTraceId() ?? undefined,
        agentName: session.agentName,
        toolName: toolCall.name,
      });
      const error = e instanceof Error ? e.message : String(e);
      toolResult = { error };
    }

    const latencyMs = Date.now() - startTime;
    const toolSuccess = !(
      typeof toolResult === 'object' &&
      toolResult !== null &&
      'error' in toolResult
    );
    const toolErrorMessage =
      !toolSuccess &&
      typeof toolResult === 'object' &&
      toolResult !== null &&
      'error' in toolResult &&
      typeof (toolResult as { error?: unknown }).error === 'string'
        ? (toolResult as { error: string }).error
        : undefined;

    // Record OTEL metric for tool call duration + success
    recordToolCall({
      toolName: toolCall.name,
      durationMs: latencyMs,
      success: toolSuccess,
    });

    if (onTraceEvent) {
      // Look up HTTP binding for method/endpoint/auth enrichment
      const toolDef = session.agentIR?.tools?.find((t) => t.name === toolCall.name);
      const httpMeta =
        toolDef?.tool_type === 'http' && toolDef.http_binding
          ? buildHttpTraceMeta(toolDef.http_binding)
          : {};

      onTraceEvent({
        type: 'tool_call',
        data: {
          // L5: Spread httpMeta first so tool-specific fields can override if needed
          ...httpMeta,
          phase: 'complete',
          toolCallId: toolCall.id,
          toolName: toolCall.name,
          input: toolCall.input,
          output: toolResult,
          success: toolSuccess,
          latencyMs,
          isActionTool: toolCall.name.startsWith('__'),
          agent: session.agentName,
          ...(toolErrorMessage ? { error: toolErrorMessage } : {}),
          ...(toolErrorCode ? { errorCode: toolErrorCode } : {}),
          ...(configurationDiagnostic ? { diagnostic: configurationDiagnostic } : {}),
          ...(runtimeErrorEnvelope ? { errorEnvelope: runtimeErrorEnvelope } : {}),
        },
      });
    }

    return { toolResult, action, breakLoop };
  }
}

// =============================================================================
// HELPERS
// =============================================================================

/**
 * Extract variable names referenced in DELEGATE WHEN conditions.
 *
 * Without this, DELEGATE WHEN conditions like `incident_category == "fiber_cut"`
 * fail because entity extraction only populates GATHER fields. By including
 * WHEN variables in the extraction scope, the runtime can evaluate delegation
 * guards against user input.
 */
function getDelegateWhenVariables(ir: AgentIR | null | undefined): string[] {
  if (!ir?.coordination?.delegates) return [];
  const vars = new Set<string>();
  for (const delegate of ir.coordination.delegates) {
    if ((delegate as { when?: string }).when) {
      for (const v of extractVariableReferences((delegate as { when: string }).when)) {
        if (!v.includes('.')) vars.add(v);
      }
    }
  }
  return [...vars];
}

/**
 * Extract routing hints for a supplementary field from DELEGATE WHEN conditions.
 *
 * Finds all delegates whose `when` condition references `fieldName`, extracts
 * comparison values (e.g. `"fiber_cut"` from `incident_category == "fiber_cut"`),
 * and includes delegate `purpose` for additional extraction context.
 */
export function getDelegateFieldHints(ir: AgentIR | null | undefined, fieldName: string): string[] {
  if (!ir?.coordination?.delegates) return [];

  const comparisonValues: string[] = [];
  const purposes: string[] = [];

  for (const delegate of ir.coordination.delegates) {
    const d = delegate as { when?: string; purpose?: string; agent: string };
    if (!d.when) continue;

    const referencedVars = extractVariableReferences(d.when);
    if (!referencedVars.includes(fieldName)) continue;

    // Extract string literal comparison values from the condition
    // Matches patterns like: fieldName == "value" or fieldName == 'value'
    const valuePattern = new RegExp(`${fieldName}\\s*(?:==|!=|IS)\\s*["']([^"']+)["']`, 'gi');
    let match: RegExpExecArray | null;
    while ((match = valuePattern.exec(d.when)) !== null) {
      comparisonValues.push(match[1]);
    }

    if (d.purpose) {
      purposes.push(d.purpose);
    }
  }

  const hints: string[] = [];
  if (comparisonValues.length > 0) {
    hints.push(`Used for routing: ${comparisonValues.join(', ')}`);
  }
  if (purposes.length > 0) {
    hints.push(`Delegate purposes: ${purposes.join('; ')}`);
  }
  return hints;
}
