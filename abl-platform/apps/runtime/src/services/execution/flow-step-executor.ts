/**
 * Flow Step Executor
 *
 * Handles all scripted flow execution: step traversal, COLLECT/GATHER,
 * entity extraction, intent detection, correction detection, ON_INPUT
 * branching, ON_START, and CALL execution.
 *
 * Receives an ExecutorContext for access to config and debouncedPersist,
 * and a RoutingExecutor for completion/handoff condition checking.
 */

import crypto from 'crypto';

import {
  evaluateConditionDual,
  resolveValueDual,
  extractEntitiesForFields,
  DEFAULT_MESSAGES,
  GatherExecutor,
  FlowExecutor,
  setNestedValue,
  resolveReasoningZoneEmptyMessageGate,
} from '@abl/compiler';
import type {
  VoiceConfigIR,
  RichContentIR,
  ActionSetIR,
  ActionHandlerIR,
  ActionHandlerActionIR,
  ValidationRule,
  GatherFieldSemantics,
} from '@abl/compiler';
import {
  detectIntent,
  detectIntentLexically,
  detectCorrection,
  CORRECTION_FIELD_UNKNOWN,
  checkGatherComplete,
  buildGatherPrompt,
  validateField,
  evaluateOnInput,
} from '@abl/compiler/platform/constructs/utils.js';
import { buildSemanticHint } from '@abl/compiler/platform/constructs/semantic-hints.js';
import { createLogger } from '@abl/compiler/platform';
import { TRACE_MODEL_UNKNOWN } from '../llm/session-llm-client.js';
import type { ToolDefinition, ToolPropertySchema } from '../llm/session-llm-client.js';
import { ablTypeToJsonSchema, buildTools, buildPreTurnPromptSections } from './prompt-builder.js';
import { shouldSkipExtraction } from './gather-utils.js';
import {
  validateExtractedBatch,
  normalizeDate,
  type DateNormalizationOptions,
} from './extraction-validation.js';
import { buildNormalizedExtractionInput } from './input-normalization.js';
import { getModelCapabilities, calculateCost, hasKnownPricing } from '../llm/model-router.js';
import {
  setGatheredValues,
  getActiveThread,
  deleteSessionValue,
  buildStateUpdates,
  buildHandoffExecutionResult,
  buildFailedHandoffExecutionResult,
  tryThreadReturn,
} from './types.js';
import type { RuntimeSession, ExecutionResult, ExecutorContext } from './types.js';
import { lookupAgentForSession } from './agent-lookup.js';
import {
  interpolateTemplate,
  interpolateVoiceConfig,
  interpolateRichContent,
  interpolateActionSet,
  resolveSetValue,
} from './value-resolution.js';
import {
  checkConstraints,
  checkFlatConstraints,
  handleConstraintViolation,
  executeConstraintViolation,
  interpretConstraintControlFlow,
  checkFlatConstraintsAtCheckpoint,
  getConstraintFieldsToClear,
  setCurrentTurnInputContext,
} from './constraint-checker.js';
import type { ConstraintControlFlowDirective } from './constraint-checker.js';
import { resolveErrorHandler, executeWithRetry } from './error-handler-router.js';
import type { ErrorContext } from './error-handler-router.js';
import { validateFieldsWithLLM } from './llm-field-validator.js';
import type { RoutingExecutor } from './routing-executor.js';
import { executeComplete } from './routing-executor.js';
import {
  buildLocalizedMessageResolver,
  renderQueuedIntentNoticeMessage,
  renderAuthoredLocalizedTemplate,
  resolveLocalizedAgentMessage,
  resolveLocalizedErrorHandlerResponseWithMetadata,
  resolveLocalizedAgentMessageWithMetadata,
} from './localized-messages.js';
import {
  humanizeIntentLabel,
  resolveMultiIntentConfig,
  type DetectedMultiIntentResult,
  type MultiIntentDispatchResult,
  type MultiIntentDisambiguationChoice,
  type MultiIntentSource,
  type MultiIntentTarget,
  type PendingIntentSeed,
} from './multi-intent/multi-intent-types.js';
import {
  applyResolvedMultiIntentPlan,
  filterDetectedMultiIntentAlternatives,
  resolveDetectedMultiIntentPlan,
} from './multi-intent/multi-intent-router.js';
import {
  AppError,
  DEFAULT_TOOL_TIMEOUT_MS,
  ErrorCodes,
  isGatherInterruptTrace,
  isSidecarOutageKind,
  type GatherInterruptCandidateSurface,
  type GatherInterruptPolicyApplied,
  type GatherInterruptTrace,
} from '@agent-platform/shared-kernel';
import { formatErrorSync } from '@agent-platform/i18n';
import {
  evaluateRememberAfterStateChange,
  executeRecallAfterToolCall,
  executeRecallAfterExtraction,
  detectAndStorePreferences,
} from './memory-integration.js';
import { recordToolCall } from '../../observability/metrics.js';
import { extractWithJSLibs, isJSExtractableType } from './js-extraction.js';
import { extractEntityObservations } from './entity-pipeline.js';
import { createObservationSet, maskSensitiveValue } from './entity-observations.js';
import { traceEntityObservation, traceIntrinsicValidation } from './entity-trace-events.js';
import {
  pruneExpired,
  peekNext,
  dequeueNext,
  getPendingIntentDisplayLabel,
  createIntentQueue,
  enqueueIntents,
} from './intent-queue.js';
import { mergeSessionDimensions } from '../metadata/custom-dimensions.js';
import type {
  ExtractionField as SidecarExtractionField,
  SidecarCallContext,
} from '../nlu/sidecar-client.js';
import type { ExtractionStrategy } from '@abl/compiler/platform';
import type {
  LookupTableIR,
  AgentIR,
  FlowStep,
  SetAssignmentIR,
  CorrectionDetectionStrategy,
  Digression,
  DigressionAction,
  IntentCategory,
  RoutingRule,
  ToolInvocationIR,
} from '@abl/compiler/platform/ir/schema.js';
import { convertValue, isConversionSupported } from '@abl/compiler/platform';
import type { CurrencyRateClient } from '../nlu/currency-rate-client.js';
import * as classifierModule from '../pipeline/classifier.js';
import {
  resolveClassifierRuntimeContext,
  resolvePipelineConfig,
  resolvePipelineModel,
  resolveRouting,
  shouldRunPipelineClassifier,
  type ClassifiedIntent,
} from '../pipeline/index.js';
import {
  resolveGatherInterruptLexicalFallbackPolicy,
  shouldAllowGatherInterruptLexicalFallback,
  type GatherInterruptLexicalFallbackReason,
} from '../pipeline/routing-resolver.js';
import {
  isPipelineCircuitOpen,
  recordPipelineFailure,
  recordPipelineSuccess,
} from '../pipeline/circuit-breaker.js';
import { resolveLookup } from './lookup-resolver.js';
import type { LookupContext } from './lookup-resolver.js';
import { mergeLookupTables, LookupTableConflictError } from './lookup-table-merger.js';
import { shouldAttemptInference, applyInferences, type InferableField } from './field-inference.js';
import { checkOutputGuardrails } from './output-guardrails.js';
import { shouldExecuteReask } from './reask-executor.js';
import {
  emitDecisionEvent,
  buildHttpTraceMeta,
  buildFlowToolCallStartTraceData,
  buildFlowToolCallCompletionTraceData,
} from './trace-helpers.js';
import {
  traceToolBlocked,
  traceToolOutputBlocked,
  tracePipelineError,
} from '../guardrails/trace-events.js';
import { buildStepSummary, getStepType } from './step-thought.js';
import { promptTemplateLoader } from './prompt-template-loader.js';
import { getSessionGuardrailCacheScopeKey, getSessionPolicy } from './session-policy.js';
import { applyScopedMemoryWrite } from './memory-scope-runtime.js';
import {
  createLLMEvalFromClient,
  createGuardrailPipeline,
  ensureTenantProvidersLoaded,
} from '../guardrails/pipeline-factory.js';
import { refreshSessionPIIContext } from '../pii/session-pii-context.js';
import {
  classifyExecutionConfigurationDiagnostic,
  getToolExecutionErrorMetadata,
} from './configuration-diagnostics.js';
import { classifyToolError } from './tool-error-classifier.js';
import {
  getCurrentInteractionLanguage,
  getCurrentInteractionLocale,
  getCurrentInteractionParsingLocale,
  getCurrentInteractionTimezone,
} from './interaction-context.js';
import type { ActionEvent } from '../channels/action-event.js';
import { validateActionSubmitEnvelope } from '../channels/action-event-validation.js';
import {
  protectSessionOutputForUser,
  protectStructuredOutputForUser,
} from './session-output-protection.js';
import { restorePIITokensForTrustedInternalExecution } from './pii-tool-execution.js';
import { createPersistedStructuredMessageEnvelope } from '../session/persisted-message-content.js';

const log = createLogger('flow-step-executor');
const gatherExecutor = new GatherExecutor();
const flowExecutor = new FlowExecutor();

const META_PREFIX = '_meta.';
const SESSION_KEY_WAITING_FOR_ACTION = '_waiting_for_action';
const SESSION_KEY_ACTION_EVENT = '_action_event';
const SESSION_KEY_ACTION_CONTEXT = '_action';
const SESSION_KEY_ACTION_RENDER_ID = '_action_render_id';
const CONVERSATION_REPAIR_PROMPT_TEMPLATE =
  'I still need {fields} to continue. Please provide {fields} so I can continue.';
const CONVERSATION_WAITING_PROMPT_TEMPLATE =
  "I still need {fields} to continue. Share {fields} when you're ready.";
const FLOW_CHECK_FAILED_USER_MESSAGE =
  "I can't continue because this step's requirements were not met. Please try again.";

type RuntimeActionEvent = Pick<
  ActionEvent,
  'actionId' | 'value' | 'formData' | 'renderId' | 'source'
> &
  Partial<Pick<ActionEvent, 'type'>>;

type RuntimeActionEventParseResult =
  | { ok: true; value: RuntimeActionEvent }
  | { ok: false; message: string; actionId?: string }
  | { ok: false; absent: true };

type FlowTerminalTarget =
  | { type: 'complete' }
  | { type: 'escalate'; reason?: string; priority?: string };

type FlowTransitionResult =
  | { outcome: 'continue' }
  | { outcome: 'terminal'; result: ExecutionResult };

function unquoteTerminalDirectiveValue(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) {
    return undefined;
  }

  const quoted = trimmed.match(/^["'](.+)["']$/);
  return (quoted?.[1] ?? trimmed).trim() || undefined;
}

function parseFlowTerminalTarget(target: string | undefined): FlowTerminalTarget | undefined {
  const trimmed = target?.trim();
  if (!trimmed) {
    return undefined;
  }

  if (trimmed.toUpperCase() === 'COMPLETE') {
    return { type: 'complete' };
  }

  const escalateMatch = trimmed.match(
    /^ESCALATE(?:\s+WITH\s+REASON\s*:?\s*(?:"([^"]+)"|'([^']+)'|(.+?)))?(?:\s+PRIORITY\s*:?\s*([A-Za-z_]+))?$/i,
  );
  if (!escalateMatch) {
    return undefined;
  }

  return {
    type: 'escalate',
    reason: unquoteTerminalDirectiveValue(escalateMatch[1] ?? escalateMatch[2] ?? escalateMatch[3]),
    priority: unquoteTerminalDirectiveValue(escalateMatch[4]),
  };
}

function parseRuntimeActionEvent(raw: unknown): RuntimeActionEventParseResult {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, absent: true };
  }
  const obj = raw as Record<string, unknown>;
  const validation = validateActionSubmitEnvelope({
    actionId: obj.actionId,
    value: obj.value,
    formData: obj.formData,
    formDataPresent:
      Object.prototype.hasOwnProperty.call(obj, 'formData') && obj.formData !== undefined,
    renderId: obj.renderId,
  });

  if (!validation.ok) {
    return {
      ok: false,
      message: validation.message,
      actionId: typeof obj.actionId === 'string' ? obj.actionId : undefined,
    };
  }

  return {
    ok: true,
    value: {
      type: 'action_event',
      actionId: validation.value.actionId,
      ...(validation.value.value !== undefined ? { value: validation.value.value } : {}),
      ...(validation.value.formData !== undefined ? { formData: validation.value.formData } : {}),
      ...(validation.value.renderId !== undefined ? { renderId: validation.value.renderId } : {}),
      ...(typeof obj.source === 'string'
        ? { source: obj.source as RuntimeActionEvent['source'] }
        : {}),
    },
  };
}

function normalizeRuntimeActionEvent(raw: unknown): RuntimeActionEvent | undefined {
  const result = parseRuntimeActionEvent(raw);
  return result.ok ? result.value : undefined;
}

function buildActionContext(event: RuntimeActionEvent): Record<string, unknown> {
  return {
    type: event.type ?? 'action_event',
    actionId: event.actionId,
    id: event.actionId,
    value: event.value,
    formData: event.formData ?? {},
    form: event.formData ?? {},
    renderId: event.renderId,
    source: event.source,
  };
}

function createActionRenderId(): string {
  return `action-render-${crypto.randomUUID()}`;
}

function withActionRenderId(
  actions: ActionSetIR | undefined,
  renderId: string,
): ActionSetIR | undefined {
  return actions ? { ...actions, renderId } : { elements: [], renderId };
}

function armActionWait(session: RuntimeSession, stepName: string): string {
  const renderId = createActionRenderId();
  session.data.values[SESSION_KEY_WAITING_FOR_ACTION] = stepName;
  session.data.values[SESSION_KEY_ACTION_RENDER_ID] = renderId;
  return renderId;
}

function clearActionWaitState(session: RuntimeSession): void {
  delete session.data.values[SESSION_KEY_WAITING_FOR_ACTION];
  delete session.data.values[SESSION_KEY_ACTION_EVENT];
  delete session.data.values[SESSION_KEY_ACTION_RENDER_ID];
}

function clearActionEvent(session: RuntimeSession): void {
  delete session.data.values[SESSION_KEY_ACTION_EVENT];
}

function getExpectedActionRenderId(session: RuntimeSession): string | undefined {
  const value = session.data.values[SESSION_KEY_ACTION_RENDER_ID];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function renderLocalizedFlowTemplate(
  session: RuntimeSession,
  template: string,
  messageKey?: string,
  values: Record<string, unknown> = session.data.values,
): string {
  return renderAuthoredLocalizedTemplate({
    session,
    messageKey,
    fallbackTemplate: template,
    values,
  });
}

function buildLocalizedGatherPrompt(
  session: RuntimeSession,
  gather: FlowStep['gather'],
  missingFields: string[],
  values: Record<string, unknown> = session.data.values,
): string {
  if (!gather) {
    return '';
  }

  if (gather.message_key) {
    return renderLocalizedFlowTemplate(
      session,
      buildGatherPrompt(gather, missingFields, values),
      gather.message_key,
      {
        ...values,
        _missing: missingFields,
        _missingList: missingFields.join(', '),
      },
    );
  }

  const localizedGather = {
    ...gather,
    fields: gather.fields.map((field) => ({
      ...field,
      prompt: field.message_key
        ? renderAuthoredLocalizedTemplate({
            session,
            messageKey: field.message_key,
            fallbackTemplate: field.prompt,
            values,
          })
        : field.prompt,
    })),
  };

  return buildGatherPrompt(localizedGather, missingFields, values);
}

export type ClarificationResponseStage = 'clarify' | 'repair' | 'hold';

export interface ClarificationStrategyInput {
  currentCount: number;
  maxQuestions?: number;
  maxAttempts?: number;
}

export interface ClarificationStrategyResult {
  nextCount: number;
  stage: ClarificationResponseStage;
}

function normalizeClarificationLimit(value: number | undefined): number | undefined {
  if (value === undefined || !Number.isFinite(value) || value < 0) {
    return undefined;
  }

  return Math.floor(value);
}

export function resolveClarificationStrategy(
  input: ClarificationStrategyInput,
): ClarificationStrategyResult {
  const maxQuestions = normalizeClarificationLimit(input.maxQuestions);
  const maxAttempts = normalizeClarificationLimit(input.maxAttempts);

  if (maxQuestions === undefined && maxAttempts === undefined) {
    return {
      nextCount: input.currentCount + 1,
      stage: 'clarify',
    };
  }

  const clarificationBudget = maxQuestions ?? 0;
  const repairBudget = maxAttempts ?? 0;
  const totalBudget = clarificationBudget + repairBudget;

  if (totalBudget <= 0) {
    return {
      nextCount: input.currentCount,
      stage: 'hold',
    };
  }

  if (input.currentCount >= totalBudget) {
    return {
      nextCount: totalBudget,
      stage: 'hold',
    };
  }

  const nextCount = input.currentCount + 1;

  if (clarificationBudget > 0 && nextCount <= clarificationBudget) {
    return {
      nextCount,
      stage: 'clarify',
    };
  }

  if (repairBudget > 0) {
    return {
      nextCount,
      stage: 'repair',
    };
  }

  return {
    nextCount: clarificationBudget,
    stage: 'hold',
  };
}

function hasActionElements(actions: ActionSetIR | undefined): boolean {
  return Array.isArray(actions?.elements) && actions.elements.length > 0;
}

function richContentHasCarouselButtons(richContent: RichContentIR | undefined): boolean {
  return (
    richContent?.carousel?.cards?.some(
      (card) => Array.isArray(card.buttons) && card.buttons.length > 0,
    ) ?? false
  );
}

function stepHasInteractiveActionHandlers(step: FlowStep): boolean {
  return (
    Array.isArray(step.on_action) &&
    step.on_action.length > 0 &&
    (hasActionElements(step.actions) || richContentHasCarouselButtons(step.rich_content))
  );
}

/**
 * Build the tenancy envelope that every NLU sidecar call requires.
 *
 * Tenancy isolation is a platform invariant (Finding 1c7efeb2): runtime
 * sessions always carry tenantId/projectId/sessionId, and the sidecar
 * validates + logs them. Callers that cannot produce all three must fall
 * back to a local extraction tier rather than invoking the sidecar.
 */
function buildSidecarCallContext(session: RuntimeSession): SidecarCallContext | null {
  if (
    typeof session.tenantId !== 'string' ||
    session.tenantId.trim().length === 0 ||
    typeof session.projectId !== 'string' ||
    session.projectId.trim().length === 0 ||
    typeof session.id !== 'string' ||
    session.id.trim().length === 0
  ) {
    return null;
  }

  return {
    tenantId: session.tenantId,
    projectId: session.projectId,
    sessionId: session.id,
  };
}

function getDateNormalizationOptions(session: RuntimeSession): DateNormalizationOptions {
  return {
    locale: getCurrentInteractionParsingLocale(session.data, 'en') ?? 'en',
    timezone: getCurrentInteractionTimezone(session.data, 'UTC') ?? 'UTC',
    referenceInstant: session.lastActivityAt ?? session.createdAt,
  };
}

function getPromptToday(session: RuntimeSession): string {
  const options = getDateNormalizationOptions(session);
  return (
    normalizeDate('today', {
      locale: 'en',
      referenceInstant: options.referenceInstant,
      timezone: options.timezone,
    }) ??
    normalizeDate('today', { locale: 'en' }) ??
    new Date().toISOString().split('T')[0]
  );
}

// GAP-3/GAP-8: Token budget constants for lookup value injection into LLM prompts
/** Max values to inject as JSON Schema enum (keeps tool schema small) */
const LOOKUP_ENUM_INJECTION_MAX = 100;
/** Sample size for description hint when table exceeds enum injection max */
const LOOKUP_HINT_SAMPLE_SIZE = 20;

/**
 * Resolve available values from a lookup table for LLM prompt injection.
 * Returns the values array for inline tables, or undefined for dynamic sources
 * (collection/api) where values aren't statically known.
 */
function resolveLookupValuesForPrompt(table: LookupTableIR): string[] | undefined {
  if (table.source === 'inline' && table.values && table.values.length > 0) {
    return table.values;
  }
  // Collection and API sources: values are dynamic, not available at prompt build time
  return undefined;
}

/**
 * Hard cap for conversation history entries passed as context to the
 * entity extraction LLM call (system prompt).
 */
const MAX_CONVERSATION_HISTORY_WINDOW = 10;

/**
 * Format prior conversation history entries into a string suitable for
 * injection into the entity extraction system prompt.
 *
 * Rules:
 *  - Only string content entries are included (ContentBlock[] skipped).
 *  - If the last history entry matches `currentUserMessage`, it is stripped
 *    to avoid duplicating the current turn in the context.
 *  - Result is capped at `windowSize` prior entries (max 10).
 *  - Returns empty string when no prior context is available.
 */
function formatConversationContext(
  conversationHistory: Array<{ role: string; content: unknown }>,
  windowSize: number,
  currentUserMessage: string,
): string {
  if (windowSize <= 0 || conversationHistory.length === 0) {
    return '';
  }

  const effectiveWindow = Math.min(windowSize, MAX_CONVERSATION_HISTORY_WINDOW);

  // Filter to string-only entries
  const stringEntries = conversationHistory.filter(
    (entry): entry is { role: string; content: string } => typeof entry.content === 'string',
  );

  if (stringEntries.length === 0) {
    return '';
  }

  // Strip the trailing user entry if it matches the current user message
  // (runtime-executor pre-appends the current message to conversationHistory)
  let entries = stringEntries;
  const lastEntry = entries[entries.length - 1];
  if (lastEntry && lastEntry.role === 'user' && lastEntry.content === currentUserMessage) {
    entries = entries.slice(0, -1);
  }

  if (entries.length === 0) {
    return '';
  }

  // Take the last `effectiveWindow` entries
  const windowEntries = entries.slice(-effectiveWindow);

  // Format as "User: ...\nAssistant: ..." pairs
  return windowEntries
    .map((entry) => {
      const role = entry.role === 'user' ? 'User' : 'Assistant';
      return `${role}: ${entry.content}`;
    })
    .join('\n');
}

/**
 * Apply a SET assignment — if the key starts with `_meta.`, route it to customDimensions
 * instead of session.data.values. Returns true if the key was a meta key.
 */
function applySetValue(
  session: RuntimeSession,
  key: string,
  value: unknown,
  onTraceEvent?: (event: { type: string; data: Record<string, unknown> }) => void,
): boolean {
  if (key.startsWith(META_PREFIX)) {
    const dimensionKey = key.slice(META_PREFIX.length);
    const result = mergeSessionDimensions(session, {
      [dimensionKey]: value,
    });
    if (result.errors.length > 0) {
      log.warn('SET _meta dimension rejected', {
        sessionId: session.id,
        key: dimensionKey,
        errors: result.errors,
      });
    }
    return true;
  }
  emitDecisionEvent(onTraceEvent, session.traceVerbosity, 'data_mutation', {
    outcome: 'set',
    matched: true,
    field: key,
    oldValue: '<redacted>',
    newValue: '<redacted>',
    source: `set:${session.currentFlowStep ?? 'unknown'}`,
  });
  if (!applyScopedMemoryWrite(session, key, value)) {
    session.data.values[key] = value;
  }
  return false;
}

function parseOnStartSetValue(value: unknown): unknown {
  if (value === 'true') return true;
  if (value === 'false') return false;
  if (typeof value === 'string' && value.trim().length > 0 && !isNaN(Number(value))) {
    return Number(value);
  }
  return value;
}

function resolveSetAssignmentValue(rawValue: unknown, context: Record<string, unknown>): unknown {
  if (typeof rawValue !== 'string') {
    return rawValue;
  }

  return resolveSetValue(rawValue, context);
}

function normalizeSetAssignments(
  assignments: Record<string, unknown> | SetAssignmentIR[],
): Record<string, unknown> {
  if (!Array.isArray(assignments)) {
    return assignments;
  }
  return Object.fromEntries(
    assignments.map((assignment) => [assignment.variable, assignment.expression]),
  );
}

function normalizeDigressionActions(
  digression: Pick<
    Digression,
    | 'do'
    | 'respond'
    | 'message_key'
    | 'clear'
    | 'call'
    | 'call_spec'
    | 'delegate'
    | 'goto'
    | 'resume'
    | 'voice_config'
    | 'rich_content'
    | 'actions'
  >,
): DigressionAction[] {
  if (digression.do && digression.do.length > 0) {
    return digression.do;
  }

  const actions: DigressionAction[] = [];
  if (digression.respond !== undefined) {
    actions.push({
      respond: digression.respond,
      message_key: digression.message_key,
      voice_config: digression.voice_config,
      rich_content: digression.rich_content,
      actions: digression.actions,
    });
  }
  if (digression.clear?.length) {
    actions.push({ clear: [...digression.clear] });
  }
  if (digression.call || digression.call_spec) {
    actions.push({ call: digression.call, call_spec: digression.call_spec });
  }
  if (digression.delegate) {
    actions.push({ delegate: digression.delegate });
  }
  if (digression.goto) {
    actions.push({ goto: digression.goto });
  } else if (digression.resume) {
    actions.push({ resume: digression.resume });
  }
  return actions;
}

function parseDelegateResultData(result: unknown): Record<string, unknown> {
  if (result && typeof result === 'object' && !Array.isArray(result)) {
    return result as Record<string, unknown>;
  }

  if (typeof result === 'string') {
    try {
      const parsed = JSON.parse(result);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      return { response: result };
    }
  }

  return { response: result };
}

function applyDigressionReturnMap(
  session: RuntimeSession,
  mapping: Record<string, string> | undefined,
  result: unknown,
): void {
  if (!mapping || Object.keys(mapping).length === 0) {
    return;
  }

  const resultData = parseDelegateResultData(result);
  for (const [sourceKey, targetKey] of Object.entries(mapping)) {
    if (resultData[sourceKey] !== undefined) {
      session.data.values[targetKey] = resultData[sourceKey];
      session.data.gatheredKeys.add(targetKey);
    }
  }
}

// Re-export pure flow utility functions from compiler for backward compatibility
export {
  detectIntent,
  detectCorrection,
  checkGatherComplete,
  buildGatherPrompt,
  validateField,
  evaluateOnInput,
};

export { SESSION_KEY_ACTION_EVENT };

/**
 * Resolve per-field voice_config/rich_content for GATHER prompts.
 * When exactly one field is missing, that field's format overrides the step-level format
 * so that the prompt can use a field-specific voice persona or rich content template.
 */
function resolveGatherFormats(
  gatherFields: Array<{ name: string; voice_config?: VoiceConfigIR; rich_content?: RichContentIR }>,
  missingFields: string[],
  context: Record<string, unknown>,
): { voiceConfig?: VoiceConfigIR; richContent?: RichContentIR } {
  if (missingFields.length !== 1) return {};
  const field = gatherFields.find((f) => f.name === missingFields[0]);
  if (!field) return {};
  return {
    voiceConfig: field.voice_config
      ? interpolateVoiceConfig(field.voice_config, context)
      : undefined,
    richContent: field.rich_content
      ? interpolateRichContent(field.rich_content, context)
      : undefined,
  };
}

function resolvePendingRichContent(
  session: Pick<RuntimeSession, 'pendingRichContent'>,
  currentMessage: string,
  richContent: RichContentIR | undefined,
): RichContentIR | undefined {
  if (richContent !== undefined) {
    return richContent;
  }

  return currentMessage.trim().length === 0 ? session.pendingRichContent : undefined;
}

function resolvePendingResponse(
  session: Pick<RuntimeSession, 'pendingResponse'>,
  currentMessage: string,
  response: string | undefined,
): string {
  if ((response ?? '').trim().length > 0) {
    return response ?? '';
  }

  return currentMessage.trim().length === 0 ? (session.pendingResponse ?? '') : '';
}

function resolvePendingVoiceConfig(
  session: Pick<RuntimeSession, 'pendingVoiceConfig'>,
  currentMessage: string,
  voiceConfig: VoiceConfigIR | undefined,
): VoiceConfigIR | undefined {
  if (voiceConfig !== undefined) {
    return voiceConfig;
  }

  return currentMessage.trim().length === 0 ? session.pendingVoiceConfig : undefined;
}

function resolvePendingActions(
  session: Pick<RuntimeSession, 'pendingActions'>,
  currentMessage: string,
  actions: ActionSetIR | undefined,
): ActionSetIR | undefined {
  if (actions !== undefined) {
    return actions;
  }

  return currentMessage.trim().length === 0 ? session.pendingActions : undefined;
}

function protectAuthoredAssistantText(
  session: Pick<
    RuntimeSession,
    | 'id'
    | 'tenantId'
    | 'projectId'
    | 'piiRedactionConfig'
    | 'piiVault'
    | 'piiPatternConfigs'
    | 'piiRecognizerRegistry'
  >,
  text: string,
): { deliveryText: string; historyText: string } {
  return protectSessionOutputForUser(session, text);
}

function protectAuthoredStructuredPayload(
  session: Pick<
    RuntimeSession,
    | 'id'
    | 'tenantId'
    | 'projectId'
    | 'piiRedactionConfig'
    | 'piiVault'
    | 'piiPatternConfigs'
    | 'piiRecognizerRegistry'
  >,
  payload: {
    richContent?: RichContentIR;
    voiceConfig?: VoiceConfigIR;
    actions?: ActionSetIR;
  },
): {
  richContent?: RichContentIR;
  voiceConfig?: VoiceConfigIR;
  actions?: ActionSetIR;
} {
  const protectedPayload = protectStructuredOutputForUser(session, payload);
  return protectedPayload.delivery;
}

function protectExecutionResultStructuredPayload(
  session: Pick<
    RuntimeSession,
    | 'id'
    | 'tenantId'
    | 'projectId'
    | 'piiRedactionConfig'
    | 'piiVault'
    | 'piiPatternConfigs'
    | 'piiRecognizerRegistry'
  >,
  result: ExecutionResult | undefined,
): ExecutionResult | undefined {
  if (!result) {
    return result;
  }

  const protectedPayload = protectAuthoredStructuredPayload(session, {
    richContent: result.richContent,
    voiceConfig: result.voiceConfig,
    actions: result.actions,
  });

  return {
    ...result,
    richContent: protectedPayload.richContent,
    voiceConfig: protectedPayload.voiceConfig,
    actions: protectedPayload.actions,
  };
}

function hasAuthoredStructuredPayload(payload: {
  richContent?: RichContentIR;
  voiceConfig?: VoiceConfigIR;
  actions?: ActionSetIR;
}): boolean {
  return (
    payload.richContent !== undefined ||
    payload.voiceConfig !== undefined ||
    payload.actions !== undefined
  );
}

function emitProtectedAssistantText(
  session: Pick<
    RuntimeSession,
    | 'id'
    | 'tenantId'
    | 'projectId'
    | 'conversationHistory'
    | 'piiRedactionConfig'
    | 'piiVault'
    | 'piiPatternConfigs'
    | 'piiRecognizerRegistry'
  >,
  text: string,
  onChunk?: (chunk: string) => void,
  options: {
    chunkText?: string;
  } = {},
): { deliveryText: string; historyText: string } {
  const protectedText = protectAuthoredAssistantText(session, text);
  if (onChunk) {
    onChunk(options.chunkText ?? protectedText.deliveryText);
  }
  session.conversationHistory.push({ role: 'assistant', content: protectedText.historyText });
  return protectedText;
}

function appendProtectedAssistantHistoryPayload(
  session: Pick<
    RuntimeSession,
    | 'id'
    | 'tenantId'
    | 'projectId'
    | 'conversationHistory'
    | 'piiRedactionConfig'
    | 'piiVault'
    | 'piiPatternConfigs'
    | 'piiRecognizerRegistry'
  >,
  historyText: string,
  payload: {
    richContent?: RichContentIR;
    voiceConfig?: VoiceConfigIR;
    actions?: ActionSetIR;
  },
): void {
  const protectedStructured = protectStructuredOutputForUser(session, payload);
  const contentEnvelope = createPersistedStructuredMessageEnvelope(historyText, {
    ...protectedStructured.history,
  });

  if (!historyText && !contentEnvelope) {
    return;
  }

  session.conversationHistory.push({
    role: 'assistant',
    content: historyText,
    ...(contentEnvelope ? { contentEnvelope } : {}),
  });
}

function rememberPendingRenderedPayload(
  session: Pick<
    RuntimeSession,
    | 'id'
    | 'tenantId'
    | 'projectId'
    | 'pendingResponse'
    | 'pendingRichContent'
    | 'pendingVoiceConfig'
    | 'pendingActions'
    | 'piiRedactionConfig'
    | 'piiVault'
    | 'piiPatternConfigs'
    | 'piiRecognizerRegistry'
  >,
  response: string,
  richContent: RichContentIR | undefined,
  voiceConfig?: VoiceConfigIR,
  actions?: ActionSetIR,
): void {
  if (
    !response &&
    richContent === undefined &&
    voiceConfig === undefined &&
    actions === undefined
  ) {
    return;
  }

  if (response) {
    session.pendingResponse = protectAuthoredAssistantText(session, response).deliveryText;
  }

  if (richContent !== undefined) {
    session.pendingRichContent = protectAuthoredStructuredPayload(session, {
      richContent,
    }).richContent;
  }

  if (voiceConfig !== undefined) {
    session.pendingVoiceConfig = protectAuthoredStructuredPayload(session, {
      voiceConfig,
    }).voiceConfig;
  }

  if (actions !== undefined) {
    session.pendingActions = protectAuthoredStructuredPayload(session, {
      actions,
    }).actions;
  }
}

/**
 * Normalize a tool execution result to Record<string, unknown>.
 * Tool executors may return strings (MCP text, HTTP non-JSON), primitives,
 * arrays, or objects. Downstream code expects key-value pairs.
 */
export function normalizeToolResult(result: unknown): Record<string, unknown> {
  if (result === null || result === undefined) return {};
  if (typeof result === 'object' && !Array.isArray(result))
    return result as Record<string, unknown>;
  return { result };
}

export function normalizeToolCallName(callExpression: string): string {
  const trimmed = callExpression.trim();
  const toolNameMatch = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)(?:\s*\(|$)/);
  return toolNameMatch ? toolNameMatch[1] : trimmed;
}

/**
 * Apply unit conversions to extracted field values based on `convert_to` semantics.
 * Stores original (pre-conversion) values under `_original` for traceability.
 * Only converts numeric values where both source and target units are recognized.
 *
 * When a CurrencyRateClient is provided and both units are 3-letter ISO currency
 * codes, live (or cached) exchange rates are used instead of the static unit table.
 */
export async function applyPostExtractionConversions(
  values: Record<string, unknown>,
  fields: Array<{ name: string; semantics?: { unit?: string; convert_to?: string } }>,
  currencyClient?: CurrencyRateClient,
): Promise<Record<string, unknown>> {
  const originals: Record<string, unknown> = {};
  for (const field of fields) {
    const fromUnit = field.semantics?.unit;
    const toUnit = field.semantics?.convert_to;
    const value = values[field.name];
    if (!fromUnit || !toUnit || fromUnit === toUnit) continue;
    if (typeof value !== 'number') continue;

    // Live currency conversion via client
    if (currencyClient && isCurrencyCode(fromUnit) && isCurrencyCode(toUnit)) {
      originals[field.name] = value;
      const rate = await currencyClient.getRate(fromUnit, toUnit);
      values[field.name] = value * rate;
      continue;
    }

    // Static unit conversion
    if (!isConversionSupported(fromUnit, toUnit)) continue;
    originals[field.name] = value;
    values[field.name] = convertValue(value, fromUnit, toUnit);
  }
  if (Object.keys(originals).length > 0) {
    values._original = { ...((values._original as Record<string, unknown>) ?? {}), ...originals };
  }
  return values;
}

/** Check if a string looks like a 3-letter ISO currency code (e.g. USD, EUR). */
function isCurrencyCode(unit: string): boolean {
  return /^[A-Z]{3}$/.test(unit);
}

/**
 * Result from lookup table validation.
 * `errors` — fields that have no match at all.
 * `fuzzyMatches` — fields that have a close-but-not-exact match requiring confirmation.
 */
export interface LookupValidationResult {
  errors: Record<string, string>;
  fuzzyMatches: Record<string, { suggested: string; similarity: number }>;
}

/**
 * Validate extracted field values against lookup tables.
 * For each field with a `lookup` semantic, resolve the value against the
 * referenced lookup table. On exact match, normalize the value (e.g. case).
 * On fuzzy match (similarity < 1.0), report for confirmation instead of auto-applying.
 * On miss, add an error entry for the field.
 */
export async function validateWithLookupTables(
  values: Record<string, unknown>,
  fields: Array<{ name: string; semantics?: { lookup?: string } }>,
  lookupTables: Record<string, LookupTableIR> | undefined,
  context: LookupContext,
): Promise<LookupValidationResult> {
  const errors: Record<string, string> = {};
  const fuzzyMatches: Record<string, { suggested: string; similarity: number }> = {};
  if (!lookupTables) return { errors, fuzzyMatches };
  for (const field of fields) {
    const tableName = field.semantics?.lookup;
    if (!tableName) continue;
    const table = lookupTables[tableName];
    if (!table) continue;
    const value = values[field.name];
    if (value == null) continue;
    const result = await resolveLookup(String(value), table, context);
    if (!result.found) {
      errors[field.name] = `"${value}" is not a valid value for ${field.name}`;
    } else if (result.matched_value && result.matched_value !== String(value)) {
      if (result.similarity != null && result.similarity < 1.0) {
        // Fuzzy match — report for confirmation instead of auto-applying
        fuzzyMatches[field.name] = {
          suggested: result.matched_value,
          similarity: result.similarity,
        };
      } else {
        // Exact case normalization — auto-apply
        values[field.name] = result.matched_value;
      }
    }
  }
  return { errors, fuzzyMatches };
}

/**
 * Prepare the list of fields eligible for LLM inference.
 * Filters gather fields to those marked with `infer: true` that have
 * not yet been collected, and caps the result to `maxFieldsPerPass`.
 *
 * This is the first stage of the inference pipeline — the caller
 * then passes the result to `buildInferencePrompt` and an LLM client.
 */
export function prepareInferableFields(
  gatherFields: Array<{
    name: string;
    type: string;
    infer?: boolean;
    infer_confidence?: number;
    infer_confirm?: boolean;
    validation?: { type: string; rule: string; error_message: string };
  }>,
  collectedValues: Record<string, unknown>,
  maxFieldsPerPass: number,
): InferableField[] {
  return gatherFields
    .filter((f) =>
      shouldAttemptInference(
        {
          name: f.name,
          type: f.type,
          infer: f.infer,
          infer_confidence: f.infer_confidence,
          infer_confirm: f.infer_confirm,
          validation: f.validation,
        },
        collectedValues,
      ),
    )
    .slice(0, maxFieldsPerPass);
}

/** Parse a user's disambiguation choice. Accepts: "1", "2", or intent name. */
export function parseDisambiguationChoice(
  input: string,
  intents: string[],
): { index: number; intent: string } | null {
  const trimmed = input.trim();
  const num = parseInt(trimmed, 10);
  if (!isNaN(num) && num >= 1 && num <= intents.length) {
    return { index: num - 1, intent: intents[num - 1] };
  }
  const exactIdx = intents.findIndex((i) => i.toLowerCase() === trimmed.toLowerCase());
  if (exactIdx >= 0) return { index: exactIdx, intent: intents[exactIdx] };
  const prefixIdx = intents.findIndex((i) => i.toLowerCase().startsWith(trimmed.toLowerCase()));
  if (prefixIdx >= 0) return { index: prefixIdx, intent: intents[prefixIdx] };
  return null;
}

const SUPERVISOR_CATEGORY_STOP_WORDS = new Set([
  'agent',
  'agents',
  'assist',
  'assistant',
  'customer',
  'customers',
  'handle',
  'helps',
  'information',
  'issue',
  'issues',
  'request',
  'requests',
  'service',
  'services',
  'support',
  'tasks',
  'their',
  'user',
  'users',
  'with',
]);

export interface ParentSupervisorRouteBase {
  category: string;
  matched: string;
  target: string;
  detectionMode: GatherInterruptTrace['detectionMode'];
  lexicalMatchType?: GatherInterruptTrace['lexicalMatchType'];
  candidateSurface: GatherInterruptTrace['candidateSurface'];
  policyApplied?: GatherInterruptTrace['policyApplied'];
  classifierConfidence?: GatherInterruptTrace['classifierConfidence'];
}

export interface ParentSupervisorRouteMatch extends ParentSupervisorRouteBase {
  kind: 'match';
}

export interface ParentSupervisorRouteBlocked extends ParentSupervisorRouteBase {
  kind: 'blocked';
  error: string;
}

export type ParentSupervisorRouteDecision =
  | ParentSupervisorRouteMatch
  | ParentSupervisorRouteBlocked;

interface FlowEscapeIntentCandidate {
  intent: string;
  keywords?: string[];
  condition?: string;
}

interface FlowEscapeMatch {
  intent: string;
  matched: string;
  detectionMode: GatherInterruptTrace['detectionMode'];
  candidateIndex: number;
  lexicalMatchType?: GatherInterruptTrace['lexicalMatchType'];
  candidateSurface: GatherInterruptTrace['candidateSurface'];
  policyApplied?: GatherInterruptTrace['policyApplied'];
  classifierConfidence?: GatherInterruptTrace['classifierConfidence'];
}

function applyCallResultSetAssignments(
  assignments: Record<string, string> | undefined,
  context: Record<string, unknown>,
): void {
  if (!assignments) {
    return;
  }

  for (const [path, valueExpr] of Object.entries(assignments)) {
    setNestedValue(context, path, resolveSetValue(valueExpr, context));
  }
}

function findDuplicateFlowEscapeIntents(candidates: FlowEscapeIntentCandidate[]): string[] {
  const counts = new Map<string, number>();
  for (const candidate of candidates) {
    counts.set(candidate.intent, (counts.get(candidate.intent) ?? 0) + 1);
  }
  return [...counts.entries()].filter(([, count]) => count > 1).map(([intent]) => intent);
}

function buildFlowEscapeIntentCategories(
  candidates: FlowEscapeIntentCandidate[],
): IntentCategory[] {
  return candidates
    .map((candidate) => {
      const descriptionParts: string[] = [];
      const humanizedIntent = humanizeIntentLabel(candidate.intent);
      if (
        humanizedIntent &&
        humanizedIntent.trim().toLowerCase() !== candidate.intent.trim().toLowerCase()
      ) {
        descriptionParts.push(`Intent: ${humanizedIntent}`);
      }

      const keywordExamples = candidate.keywords
        ?.map((keyword) => keyword.trim())
        .filter((keyword) => keyword.length > 0);
      if (keywordExamples && keywordExamples.length > 0) {
        descriptionParts.push(`Examples: ${keywordExamples.join(', ')}`);
      }

      return {
        name: candidate.intent,
        description: descriptionParts.length > 0 ? descriptionParts.join('. ') : undefined,
      };
    })
    .filter((category) => category.name.trim().length > 0);
}

function buildGatherInterruptCandidateSurface(params: {
  kind: GatherInterruptCandidateSurface['kind'];
  candidates: Array<FlowEscapeIntentCandidate | IntentCategory>;
}): GatherInterruptCandidateSurface {
  const candidateNames = params.candidates
    .map((candidate) => {
      if ('intent' in candidate) {
        return candidate.intent;
      }
      return candidate.name;
    })
    .map((candidate) => candidate.trim())
    .filter((candidate) => candidate.length > 0);

  return {
    kind: params.kind,
    size: candidateNames.length,
    candidates: candidateNames,
  };
}

export function toGatherInterruptTrace(trace: GatherInterruptTrace): GatherInterruptTrace {
  const canonicalTrace = {
    detectionMode: trace.detectionMode,
    candidateSurface: trace.candidateSurface,
    ...(trace.lexicalMatchType ? { lexicalMatchType: trace.lexicalMatchType } : {}),
    ...(trace.policyApplied ? { policyApplied: trace.policyApplied } : {}),
    ...(trace.classifierConfidence !== undefined
      ? { classifierConfidence: trace.classifierConfidence }
      : {}),
  };

  if (!isGatherInterruptTrace(canonicalTrace)) {
    throw new AppError('Gather interrupt trace payload violated the canonical schema', {
      ...ErrorCodes.INTERNAL_ERROR,
    });
  }

  return canonicalTrace;
}

function hasStepGatherFields(step: FlowStep): boolean {
  return Array.isArray(step.gather?.fields) && step.gather.fields.length > 0;
}

function resolveStepGatherAllowedToolNames(step: FlowStep): Set<string> {
  const allowed = new Set<string>();

  if (step.reasoning_zone?.available_tools) {
    for (const toolName of step.reasoning_zone.available_tools) {
      if (toolName.trim().length > 0) {
        allowed.add(toolName);
      }
    }
  }

  if (step.call) {
    allowed.add(normalizeToolCallName(step.call));
  }
  if (step.call_spec?.tool) {
    allowed.add(step.call_spec.tool);
  }

  return allowed;
}

function resolveStepGatherReasoningGate(
  step: FlowStep,
  values: Record<string, unknown>,
): {
  complete: boolean;
  missing: string[];
  allowedToolNames: Set<string>;
  shouldSkipReasoning: boolean;
} | null {
  if (!hasStepGatherFields(step) || !step.gather) {
    return null;
  }

  const gatherState = checkGatherComplete(step.gather, values, step.complete_when);
  const allowedToolNames = resolveStepGatherAllowedToolNames(step);

  return {
    complete: gatherState.complete,
    missing: gatherState.missing,
    allowedToolNames,
    // FLOW-step GATHER owns the turn until complete. After completion, only
    // explicit same-step tools may execute from the reasoning zone. Tool-less
    // reasoning steps still run after collection with an empty tool surface.
    shouldSkipReasoning: !gatherState.complete,
  };
}

function getUnsetStepGatherFieldNames(step: FlowStep, values: Record<string, unknown>): string[] {
  return (step.gather?.fields ?? [])
    .filter((field) => {
      const value = values[field.name];
      return value === undefined || value === null || value === '';
    })
    .map((field) => field.name);
}

function filterToolsWithMissingStepGatherParameters(
  tools: ToolDefinition[],
  step: FlowStep,
  values: Record<string, unknown>,
): ToolDefinition[] {
  const unsetGatherFields = new Set(getUnsetStepGatherFieldNames(step, values));
  if (unsetGatherFields.size === 0) {
    return tools;
  }

  return tools.filter((tool) => {
    const requiredParams = tool.input_schema?.required ?? [];
    return !requiredParams.some((paramName) => unsetGatherFields.has(paramName));
  });
}

function resolveFlowStepGatherFromAgentGather(
  step: FlowStep,
  agentGather: AgentIR['gather'],
): FlowStep {
  if (!step.gather?.fields?.length || !agentGather?.fields?.length) {
    return step;
  }

  const agentGatherFieldsByName = new Map(agentGather.fields.map((field) => [field.name, field]));
  let changed = false;
  const fields = step.gather.fields.map((field) => {
    const inherited = agentGatherFieldsByName.get(field.name);
    if (!inherited) {
      return field;
    }

    const hasStepSpecificMetadata = Object.entries(field).some(
      ([key, value]) => key !== 'name' && key !== 'required' && value !== undefined,
    );
    const overrides = Object.fromEntries(
      Object.entries(field).filter(
        ([key, value]) =>
          value !== undefined &&
          (hasStepSpecificMetadata || (key !== 'required' && key !== 'name')),
      ),
    );
    const resolved = { ...inherited, ...overrides, name: field.name } as typeof field;
    if (resolved !== field) {
      changed = true;
    }
    return resolved;
  });

  if (!changed) {
    return step;
  }

  return {
    ...step,
    gather: {
      ...step.gather,
      fields,
    },
  };
}

function buildPendingIntentSeed(params: {
  originalMessage: string;
  sourceStep: string;
  label: string;
  target: MultiIntentTarget;
  source: MultiIntentSource;
  category?: string | null;
  confidence?: number;
}): PendingIntentSeed {
  const {
    originalMessage,
    sourceStep,
    label,
    target,
    source,
    category = null,
    confidence = 0.8,
  } = params;

  return {
    intent: target.ref,
    confidence,
    original_message: originalMessage,
    label,
    category,
    summary: label,
    source,
    target,
    sourceStep,
  };
}

function buildQueueableDigressionEntry(params: {
  digression: Digression;
  originalMessage: string;
  sourceStep: string;
}): PendingIntentSeed | null {
  const { digression, originalMessage, sourceStep } = params;
  const label = humanizeIntentLabel(digression.intent);

  for (const action of normalizeDigressionActions(digression)) {
    if (action.goto && action.goto !== 'COMPLETE') {
      return buildPendingIntentSeed({
        originalMessage,
        sourceStep,
        label,
        target: {
          kind: 'flow_step',
          ref: action.goto,
          label: humanizeIntentLabel(action.goto),
        },
        source: 'flow',
        category: digression.intent,
      });
    }

    if (action.delegate) {
      return buildPendingIntentSeed({
        originalMessage,
        sourceStep,
        label,
        target: {
          kind: 'agent',
          ref: action.delegate,
          label: action.delegate,
        },
        source: 'flow',
        category: digression.intent,
      });
    }
  }

  return null;
}

function shouldQueueGatherLockedDigression(digression: Digression): boolean {
  for (const action of normalizeDigressionActions(digression)) {
    if (action.goto && action.goto !== 'COMPLETE') {
      return true;
    }

    if (action.delegate && action.return === true) {
      return true;
    }
  }

  return false;
}

function buildQueueableParentRouteEntry(params: {
  route: ParentSupervisorRouteMatch;
  originalMessage: string;
  sourceStep: string;
}): PendingIntentSeed {
  const { route, originalMessage, sourceStep } = params;

  return buildPendingIntentSeed({
    originalMessage,
    sourceStep,
    label: humanizeIntentLabel(route.category),
    target: {
      kind: 'agent',
      ref: route.target,
      label: route.target,
    },
    source: route.detectionMode === 'pipeline' ? 'pipeline' : 'flow',
    category: route.category,
    confidence: route.classifierConfidence ?? 0.8,
  });
}

function doesFlowEscapeConditionMatch(params: {
  candidate: FlowEscapeIntentCandidate;
  context: Record<string, unknown>;
  currentMessage: string;
}): boolean {
  const { candidate, context, currentMessage } = params;
  if (!candidate.condition) {
    return true;
  }

  try {
    return evaluateConditionDual(candidate.condition, {
      ...context,
      input: currentMessage.toLowerCase().trim(),
    });
  } catch (err) {
    log.warn('flow escape condition evaluation failed', {
      intent: candidate.intent,
      condition: candidate.condition,
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}

function resolveFlowEscapeLexicalMatch(params: {
  candidates: FlowEscapeIntentCandidate[];
  currentMessage: string;
  context: Record<string, unknown>;
  candidateSurface: GatherInterruptCandidateSurface;
  policyApplied: GatherInterruptPolicyApplied;
}): FlowEscapeMatch | null {
  const { candidates, currentMessage, context, candidateSurface, policyApplied } = params;
  const lexicalMatch = detectIntentLexically(currentMessage, candidates, context, {
    allowNormalized: true,
  });
  if (!lexicalMatch) {
    return null;
  }

  return {
    intent: lexicalMatch.intent,
    matched: lexicalMatch.matched,
    detectionMode: 'lexical',
    lexicalMatchType: lexicalMatch.matchType,
    candidateIndex: lexicalMatch.candidateIndex,
    candidateSurface,
    policyApplied,
  };
}

function resolveFlowEscapePipelineMatch(params: {
  candidates: FlowEscapeIntentCandidate[];
  classifierIntents: ClassifiedIntent[];
  currentMessage: string;
  context: Record<string, unknown>;
  candidateSurface: GatherInterruptCandidateSurface;
  policyApplied: GatherInterruptPolicyApplied;
}): FlowEscapeMatch | null {
  const {
    candidates,
    classifierIntents,
    currentMessage,
    context,
    candidateSurface,
    policyApplied,
  } = params;
  const classifiedByCategory = new Map<string, ClassifiedIntent>();
  for (const intent of classifierIntents) {
    if (!intent.category || classifiedByCategory.has(intent.category)) {
      continue;
    }
    classifiedByCategory.set(intent.category, intent);
  }

  for (const [candidateIndex, candidate] of candidates.entries()) {
    const classifiedIntent = classifiedByCategory.get(candidate.intent);
    if (!classifiedIntent) {
      continue;
    }
    if (
      !doesFlowEscapeConditionMatch({
        candidate,
        context,
        currentMessage,
      })
    ) {
      continue;
    }

    return {
      intent: candidate.intent,
      matched: classifiedIntent.summary || currentMessage,
      detectionMode: 'pipeline',
      candidateIndex,
      candidateSurface,
      policyApplied,
      classifierConfidence: classifiedIntent.confidence,
    };
  }

  return null;
}

// Explicit flow escape hatches use the same classifier-first contract as
// parent reroutes so semantic paraphrases do not get swallowed by gather input.
async function detectFlowEscapeMatch(params: {
  session: RuntimeSession;
  currentMessage: string;
  candidates: FlowEscapeIntentCandidate[];
  candidateSurfaceKind: GatherInterruptCandidateSurface['kind'];
  skipPipeline?: boolean;
  onTraceEvent?: (event: { type: string; data: Record<string, unknown> }) => void;
}): Promise<FlowEscapeMatch | null> {
  const { session, currentMessage, candidates, candidateSurfaceKind, skipPipeline, onTraceEvent } =
    params;
  if (currentMessage.trim().length === 0 || candidates.length === 0) {
    return null;
  }

  const activeThread = getActiveThread(session);
  const activeIR = activeThread.agentIR ?? session.agentIR;
  const categories = buildFlowEscapeIntentCategories(candidates);
  const candidateSurface = buildGatherInterruptCandidateSurface({
    kind: candidateSurfaceKind,
    candidates,
  });
  const lexicalFallbackPolicy = resolveGatherInterruptLexicalFallbackPolicy(
    activeIR?.routing?.intent_classification?.lexical_fallback,
  );
  if (!activeIR || categories.length === 0) {
    if (!shouldAllowGatherInterruptLexicalFallback(lexicalFallbackPolicy, 'unavailable')) {
      return null;
    }

    const lexicalMatch = detectIntentLexically(currentMessage, candidates, session.data.values, {
      allowNormalized: true,
    });
    return lexicalMatch
      ? {
          intent: lexicalMatch.intent,
          matched: lexicalMatch.matched,
          detectionMode: 'lexical',
          lexicalMatchType: lexicalMatch.matchType,
          candidateIndex: lexicalMatch.candidateIndex,
          candidateSurface,
          policyApplied: lexicalFallbackPolicy,
        }
      : null;
  }

  const pipelineConfig = resolvePipelineConfig(
    activeIR.execution,
    activeIR.project_runtime_config?.pipeline,
  );
  const tenantId = session.tenantId ?? '';
  const llmClient = activeThread.llmClient ?? session.llmClient;
  let lexicalFallbackReason: 'semantic_rejection' | 'unavailable' = 'unavailable';

  if (!skipPipeline && pipelineConfig.enabled && llmClient && !isPipelineCircuitOpen(tenantId)) {
    try {
      const pipelineModel = await resolvePipelineModel(pipelineConfig, {
        llmClient,
        tenantId: session.tenantId,
      });

      if (pipelineModel) {
        const classifierContext = resolveClassifierRuntimeContext({
          conversationHistory: activeThread.conversationHistory,
          currentInput: currentMessage,
          rawInput: currentMessage,
        });
        const classifierResult = await classifierModule.classify(pipelineModel, {
          mode: 'gather_scoped',
          userMessage: classifierContext.currentMessage,
          categories,
          candidateSurface,
          config: pipelineConfig,
          onTraceEvent,
          agentScope: activeIR.identity?.goal
            ? {
                goal: activeIR.identity.goal,
                limitations: activeIR.identity.limitations,
              }
            : undefined,
          recentConversation: classifierContext.recentConversation,
        });
        recordPipelineSuccess(tenantId);

        const pipelineMatch = resolveFlowEscapePipelineMatch({
          candidates,
          classifierIntents: classifierResult.intents,
          currentMessage,
          context: session.data.values,
          candidateSurface,
          policyApplied: lexicalFallbackPolicy,
        });
        if (pipelineMatch) {
          return pipelineMatch;
        }

        lexicalFallbackReason = 'semantic_rejection';
      }
    } catch (err) {
      recordPipelineFailure(tenantId);
      log.warn('flow escape pipeline intent detection failed', {
        agentName: activeThread.agentName,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  if (!shouldAllowGatherInterruptLexicalFallback(lexicalFallbackPolicy, lexicalFallbackReason)) {
    return null;
  }

  return resolveFlowEscapeLexicalMatch({
    candidates,
    currentMessage,
    context: session.data.values,
    candidateSurface,
    policyApplied: lexicalFallbackPolicy,
  });
}

function buildSupervisorCategoryKeywords(category: {
  name: string;
  description?: string;
}): string[] {
  const keywords = new Set<string>();
  const addKeyword = (value: string): void => {
    const normalized = value.trim().toLowerCase();
    if (normalized.length >= 3) {
      keywords.add(normalized);
    }
  };

  addKeyword(category.name);
  for (const token of category.name.split(/[^a-zA-Z0-9]+/)) {
    if (token.length >= 3) {
      addKeyword(token);
    }
  }

  if (category.description) {
    for (const token of category.description.split(/[^a-zA-Z0-9]+/)) {
      const rawToken = token.trim();
      const normalized = rawToken.toLowerCase();
      const isShortAcronym = /^[A-Z0-9]{2,}$/.test(rawToken);
      if (
        (normalized.length >= 5 || isShortAcronym) &&
        !SUPERVISOR_CATEGORY_STOP_WORDS.has(normalized)
      ) {
        keywords.add(normalized);
      }
    }
  }

  return [...keywords];
}

function findParentSupervisorDeclaredHandoff(
  parentIR: NonNullable<RuntimeSession['agentIR']>,
  target: string,
): { to: string; remote?: { location?: string } } | null {
  return (
    parentIR.coordination?.handoffs?.find(
      (handoff: { to: string; remote?: { location?: string } }) => handoff.to === target,
    ) ?? null
  );
}

function finalizeParentSupervisorRoute(params: {
  ctx: ExecutorContext;
  session: RuntimeSession;
  currentAgentName: string;
  parentIR: NonNullable<RuntimeSession['agentIR']>;
  route: ParentSupervisorRouteBase;
}): ParentSupervisorRouteDecision | null {
  const { ctx, session, currentAgentName, parentIR, route } = params;
  if (!route.target || route.target === currentAgentName) {
    return null;
  }

  if (
    typeof session.tenantId !== 'string' ||
    session.tenantId.trim().length === 0 ||
    typeof session.projectId !== 'string' ||
    session.projectId.trim().length === 0
  ) {
    return {
      kind: 'blocked',
      ...route,
      error: 'Parent supervisor reroute requires tenantId and projectId context.',
    };
  }

  const declaredHandoff = findParentSupervisorDeclaredHandoff(parentIR, route.target);
  if (!declaredHandoff) {
    return {
      kind: 'blocked',
      ...route,
      error: `Parent supervisor reroute target is not declared: ${route.target}`,
    };
  }

  if (declaredHandoff.remote?.location === 'remote') {
    return {
      kind: 'match',
      ...route,
    };
  }

  if (!lookupAgentForSession(ctx, session, route.target)) {
    return {
      kind: 'blocked',
      ...route,
      error: `Agent not found: ${route.target}`,
    };
  }

  return {
    kind: 'match',
    ...route,
  };
}

// ─── Spike 3: pure decision functions for parent supervisor route ─────────────
//
// These two pure functions capture the deterministic decision graph of
// `detectParentSupervisorRoute`, leaving the async orchestrator below as the
// only I/O-aware caller. Production and tests both call these functions; there
// is no parallel implementation. Trace effects are returned as data; the
// orchestrator dispatches them.

export type ParentSupervisorRouteSkipReason =
  | 'suppressed'
  | 'no_active_thread_or_return'
  | 'empty_thread_stack'
  | 'no_parent_ir'
  | 'parent_not_supervisor'
  | 'no_categories_or_rules'
  | 'empty_message';

export interface ParentSupervisorRoutePrecheckProceed {
  kind: 'proceed';
  parentIR: NonNullable<RuntimeSession['agentIR']>;
  categories: IntentCategory[];
  rules: RoutingRule[];
  lexicalFallbackPolicy: GatherInterruptPolicyApplied;
  candidateSurface: GatherInterruptCandidateSurface;
}

export type ParentSupervisorRoutePrecheckResult =
  | { kind: 'skip'; reason: ParentSupervisorRouteSkipReason }
  | ParentSupervisorRoutePrecheckProceed;

export interface ParentSupervisorRoutePrecheckInput {
  suppressParentSupervisorRoute: boolean;
  activeThreadReturnExpected: boolean | undefined;
  threadStackLength: number;
  parentIR: NonNullable<RuntimeSession['agentIR']> | null;
  currentMessage: string;
}

/**
 * Pure precondition gate. Decides whether the orchestrator should proceed
 * with classifier/lexical evaluation OR short-circuit with null. No I/O.
 */
export function evaluateParentSupervisorRoutePrecheck(
  input: ParentSupervisorRoutePrecheckInput,
): ParentSupervisorRoutePrecheckResult {
  if (input.suppressParentSupervisorRoute) {
    return { kind: 'skip', reason: 'suppressed' };
  }
  if (input.activeThreadReturnExpected !== true) {
    return { kind: 'skip', reason: 'no_active_thread_or_return' };
  }
  if (input.threadStackLength === 0) {
    return { kind: 'skip', reason: 'empty_thread_stack' };
  }
  if (input.parentIR === null) {
    return { kind: 'skip', reason: 'no_parent_ir' };
  }
  if (input.parentIR.metadata?.type !== 'supervisor') {
    return { kind: 'skip', reason: 'parent_not_supervisor' };
  }
  const rawCategories = input.parentIR.routing?.intent_classification?.categories ?? [];
  const categories: IntentCategory[] = rawCategories
    .map((category) => (typeof category === 'string' ? { name: category } : category))
    .filter((category) => category.name.trim().length > 0);
  const rules = input.parentIR.routing?.rules ?? [];
  if (categories.length === 0 || rules.length === 0) {
    return { kind: 'skip', reason: 'no_categories_or_rules' };
  }
  if (input.currentMessage.trim().length === 0) {
    return { kind: 'skip', reason: 'empty_message' };
  }
  const lexicalFallbackPolicy = resolveGatherInterruptLexicalFallbackPolicy(
    input.parentIR.routing?.intent_classification?.lexical_fallback,
  );
  const candidateSurface = buildGatherInterruptCandidateSurface({
    kind: 'parent_supervisor_route',
    candidates: categories,
  });
  return {
    kind: 'proceed',
    parentIR: input.parentIR,
    categories,
    rules,
    lexicalFallbackPolicy,
    candidateSurface,
  };
}

export type ClassifierOutcome =
  | { kind: 'not_attempted' }
  | { kind: 'model_unavailable' }
  | { kind: 'failed' }
  | { kind: 'classified'; intents: ClassifiedIntent[] };

export interface ParentSupervisorRouteAfterClassifierInput {
  precheck: ParentSupervisorRoutePrecheckProceed;
  classifierOutcome: ClassifierOutcome;
  parentValues: Record<string, unknown>;
  currentMessage: string;
}

export type ParentSupervisorRouteAfterClassifierResult =
  | {
      kind: 'no_route';
      reason: 'lexical_fallback_blocked' | 'no_lexical_match' | 'lexical_match_no_routing';
      effects: ReadonlyArray<{ type: string; data: Record<string, unknown> }>;
    }
  | {
      kind: 'route';
      route: ParentSupervisorRouteBase;
      effects: ReadonlyArray<{ type: string; data: Record<string, unknown> }>;
    };

/**
 * Pure post-classifier decision. Captures the entire post-classifier decision
 * graph: try classifier-based routing first, fall through to lexical fallback
 * based on policy and reason. Trace effects from internal routing resolution
 * are returned as `effects` for the orchestrator to dispatch.
 *
 * Outcome semantics:
 * - `classified` with target → route via pipeline.
 * - `classified` without target → fallback reason='semantic_rejection'.
 * - `not_attempted` / `model_unavailable` / `failed` → reason='unavailable'.
 * - Lexical fallback may be blocked by policy regardless of reason.
 */
export function evaluateParentSupervisorRouteAfterClassifier(
  input: ParentSupervisorRouteAfterClassifierInput,
): ParentSupervisorRouteAfterClassifierResult {
  const { precheck, classifierOutcome, parentValues, currentMessage } = input;
  const effects: Array<{ type: string; data: Record<string, unknown> }> = [];
  const gatherRoutingOptions = {
    classifierMode: 'gather_scoped' as const,
    gatherInterrupt: {
      candidateSurface: precheck.candidateSurface,
      policyApplied: precheck.lexicalFallbackPolicy,
    },
  };

  let resolvedLexicalFallbackPolicy: GatherInterruptPolicyApplied = precheck.lexicalFallbackPolicy;
  let lexicalFallbackReason: GatherInterruptLexicalFallbackReason = 'unavailable';

  // Exhaustiveness check: a new ClassifierOutcome kind added later must
  // explicitly opt into one of these branches OR get its own branch. If TS
  // does not infer `never` at the unreachable end of this switch, the build
  // breaks with the offending kind named in the error.
  switch (classifierOutcome.kind) {
    case 'classified':
    case 'failed':
    case 'model_unavailable':
    case 'not_attempted':
      break;
    default: {
      const _exhaustive: never = classifierOutcome;
      void _exhaustive;
    }
  }

  if (classifierOutcome.kind === 'classified') {
    const routingMatches = resolveRouting(
      classifierOutcome.intents,
      precheck.rules,
      parentValues,
      (event) => effects.push(event),
      gatherRoutingOptions,
    );
    const primaryRoutingMatch = routingMatches[0];
    resolvedLexicalFallbackPolicy =
      primaryRoutingMatch?.gatherInterrupt?.policyApplied ?? resolvedLexicalFallbackPolicy;
    const pipelineTarget = primaryRoutingMatch?.target;
    if (pipelineTarget) {
      return {
        kind: 'route',
        route: {
          category: primaryRoutingMatch?.intent.category ?? precheck.categories[0]?.name ?? '',
          matched: primaryRoutingMatch?.intent.summary || currentMessage,
          target: pipelineTarget,
          detectionMode: 'pipeline',
          candidateSurface:
            primaryRoutingMatch?.gatherInterrupt?.candidateSurface ?? precheck.candidateSurface,
          policyApplied: primaryRoutingMatch?.gatherInterrupt?.policyApplied,
          classifierConfidence: primaryRoutingMatch?.intent.confidence,
        },
        effects,
      };
    }
    lexicalFallbackReason = 'semantic_rejection';
  }

  if (
    !shouldAllowGatherInterruptLexicalFallback(resolvedLexicalFallbackPolicy, lexicalFallbackReason)
  ) {
    return { kind: 'no_route', reason: 'lexical_fallback_blocked', effects };
  }

  const lexicalMatch = resolveFlowEscapeLexicalMatch({
    currentMessage,
    candidates: precheck.categories.map((category) => ({
      intent: category.name,
      keywords: buildSupervisorCategoryKeywords(category),
    })),
    context: parentValues,
    candidateSurface: precheck.candidateSurface,
    policyApplied: resolvedLexicalFallbackPolicy,
  });

  if (!lexicalMatch) {
    return { kind: 'no_route', reason: 'no_lexical_match', effects };
  }

  const lexicalRoutingMatches = resolveRouting(
    [
      {
        category: lexicalMatch.intent,
        confidence: precheck.parentIR.routing?.intent_classification?.min_confidence ?? 0.7,
        summary: currentMessage,
      },
    ],
    precheck.rules,
    parentValues,
    (event) => effects.push(event),
    gatherRoutingOptions,
  );
  const lexicalPrimary = lexicalRoutingMatches[0];
  if (!lexicalPrimary?.target) {
    return { kind: 'no_route', reason: 'lexical_match_no_routing', effects };
  }

  return {
    kind: 'route',
    route: {
      category: lexicalMatch.intent,
      matched: lexicalMatch.matched,
      target: lexicalPrimary.target,
      detectionMode: 'lexical',
      lexicalMatchType: lexicalMatch.lexicalMatchType,
      candidateSurface:
        lexicalPrimary.gatherInterrupt?.candidateSurface ?? precheck.candidateSurface,
      policyApplied: lexicalPrimary.gatherInterrupt?.policyApplied,
    },
    effects,
  };
}

export async function detectParentSupervisorRoute(params: {
  ctx: ExecutorContext;
  session: RuntimeSession;
  currentMessage: string;
  currentAgentName: string;
  skipPipeline?: boolean;
  suppressParentSupervisorRoute?: boolean;
  onTraceEvent?: (event: { type: string; data: Record<string, unknown> }) => void;
}): Promise<ParentSupervisorRouteDecision | null> {
  const {
    ctx,
    session,
    currentMessage,
    currentAgentName,
    skipPipeline,
    suppressParentSupervisorRoute,
    onTraceEvent,
  } = params;

  // Extract typed-slice facts from the live session for the pure precheck.
  const activeThread = getActiveThread(session);
  const parentIndex =
    session.threadStack.length > 0
      ? session.threadStack[session.threadStack.length - 1]
      : undefined;
  const parentThread = parentIndex !== undefined ? session.threads[parentIndex] : undefined;

  const precheck = evaluateParentSupervisorRoutePrecheck({
    suppressParentSupervisorRoute: suppressParentSupervisorRoute === true,
    activeThreadReturnExpected: activeThread?.returnExpected,
    threadStackLength: session.threadStack.length,
    parentIR: parentThread?.agentIR ?? null,
    currentMessage,
  });
  if (precheck.kind === 'skip') {
    return null;
  }

  // I/O: try the pipeline classifier if config + circuit + skipPipeline allow.
  const pipelineConfig = resolvePipelineConfig(
    precheck.parentIR.execution,
    precheck.parentIR.project_runtime_config?.pipeline,
  );
  const tenantId = session.tenantId ?? '';
  let classifierOutcome: ClassifierOutcome = { kind: 'not_attempted' };

  if (
    !skipPipeline &&
    pipelineConfig.enabled &&
    parentThread?.llmClient &&
    !isPipelineCircuitOpen(tenantId)
  ) {
    const classifierDecision = shouldRunPipelineClassifier({
      categories: precheck.categories,
      routingRules: precheck.rules,
      intentBridgeEnabled: pipelineConfig.intentBridge?.enabled === true,
    });

    if (classifierDecision.shouldRun) {
      try {
        const pipelineModel = await resolvePipelineModel(pipelineConfig, {
          llmClient: parentThread.llmClient,
          tenantId: session.tenantId,
        });

        if (pipelineModel) {
          const classifierContext = resolveClassifierRuntimeContext({
            conversationHistory: parentThread.conversationHistory,
            currentInput: currentMessage,
            rawInput: currentMessage,
          });
          const classifierResult = await classifierModule.classify(pipelineModel, {
            mode: 'gather_scoped',
            userMessage: classifierContext.currentMessage,
            categories: precheck.categories,
            candidateSurface: precheck.candidateSurface,
            config: pipelineConfig,
            onTraceEvent,
            agentScope: precheck.parentIR.identity?.goal
              ? {
                  goal: precheck.parentIR.identity.goal,
                  limitations: precheck.parentIR.identity.limitations,
                }
              : undefined,
            recentConversation: classifierContext.recentConversation,
          });
          recordPipelineSuccess(tenantId);
          classifierOutcome = { kind: 'classified', intents: classifierResult.intents };
        } else {
          classifierOutcome = { kind: 'model_unavailable' };
        }
      } catch (err) {
        recordPipelineFailure(tenantId);
        log.warn('parent supervisor pipeline digression detection failed', {
          parentAgent: parentThread?.agentName,
          childAgent: currentAgentName,
          error: err instanceof Error ? err.message : String(err),
        });
        classifierOutcome = { kind: 'failed' };
      }
    }
  }

  // Pure decision: classifier route OR lexical fallback OR no route.
  const decision = evaluateParentSupervisorRouteAfterClassifier({
    precheck,
    classifierOutcome,
    parentValues: parentThread?.data.values ?? {},
    currentMessage,
  });

  // Dispatch returned effects (trace events from internal resolveRouting calls).
  //
  // BEHAVIOR CHANGE — flagged in GPT-5.5 code audit. Pre-refactor: a throwing
  // `onTraceEvent` inside the classifier-path `resolveRouting` was caught by
  // the wider classifier try/catch, which had ALREADY called
  // `recordPipelineSuccess(tenantId)` — so a trace failure would then trigger
  // `recordPipelineFailure(tenantId)` (double-recording state) and fall
  // through to lexical fallback, discarding the computed route.
  //
  // Post-refactor: trace events are returned as `effects` data and dispatched
  // here, after the classifier try/catch and after the route decision is
  // finalized. A throwing `onTraceEvent` no longer triggers `recordPipelineFailure`
  // and no longer discards the route. The per-event try/catch below preserves
  // the old code's "trace errors do not propagate to callers" contract, but
  // the side-effect ordering is intentionally different (and arguably more
  // correct: trace failures shouldn't invert the routing decision).
  //
  // Migration note: any downstream consumer that relied on the old fallback
  // behavior on trace failure would no longer see it.
  if (onTraceEvent) {
    for (const event of decision.effects) {
      try {
        onTraceEvent(event);
      } catch (err) {
        log.warn('parent supervisor route trace dispatch failed', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  if (decision.kind === 'no_route') {
    return null;
  }

  return finalizeParentSupervisorRoute({
    ctx,
    session,
    currentAgentName,
    parentIR: precheck.parentIR,
    route: decision.route,
  });
}

/**
 * FlowStepExecutor — handles scripted flow step execution.
 *
 * Receives an ExecutorContext for config and debouncedPersist,
 * and a RoutingExecutor for completion/handoff condition checking.
 */
function resolveCallArgumentExpression(
  expression: string,
  sessionValues: Record<string, unknown>,
): unknown {
  let resolved = resolveValueDual(expression, sessionValues);

  // ABL convention: `session.X` may refer either to the nested session namespace
  // or to a flat session-scoped MEMORY key. Keep CALL WITH aligned with inline
  // named CALL arguments by falling back to the flat key when the dotted path
  // does not resolve.
  if (resolved === undefined && expression.startsWith('session.')) {
    const flatKey = expression.slice('session.'.length);
    resolved = sessionValues[flatKey] ?? undefined;
  }

  return resolved;
}

/**
 * Resolve a CALL WITH value while preserving its declared type.
 *
 * `step.call_with` values come from parsed YAML, so they may be strings (with
 * template placeholders), arrays, plain objects, numbers, booleans, or null.
 * Template substitution must only apply to string nodes — coercing arrays /
 * objects via `String(value)` would produce broken results like
 * `String(["a","b"]) === "a,b"`, which would then fail tool param validation
 * with "expected type 'array', got 'string'" (ABLP-714).
 *
 * Walks the value recursively so an array/object literal containing string
 * templates (e.g. `productIds: ["{{productId}}"]`) still gets per-element
 * template resolution while the surrounding array structure is preserved.
 */
export function resolveCallWithValue(
  value: unknown,
  sessionValues: Record<string, unknown>,
): unknown {
  if (typeof value === 'string') {
    return resolveCallArgumentExpression(value, sessionValues);
  }
  if (Array.isArray(value)) {
    return value.map((item) => resolveCallWithValue(item, sessionValues));
  }
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = resolveCallWithValue(v, sessionValues);
    }
    return out;
  }
  return value;
}

interface ToolInvocationConfig {
  call?: string;
  call_spec?: ToolInvocationIR;
  call_with?: Record<string, unknown>;
  call_as?: string;
}

type ToolInvocationBindingMode = 'step' | 'branch' | 'lifecycle' | 'hook';

function getToolInvocationToolName(invocation: ToolInvocationConfig): string | undefined {
  return (
    invocation.call_spec?.tool ??
    (invocation.call ? normalizeToolCallName(invocation.call) : undefined)
  );
}

function getToolInvocationResultKey(invocation: ToolInvocationConfig): string | undefined {
  return invocation.call_spec?.as ?? invocation.call_as;
}

function buildToolInvocationParams(
  invocation: ToolInvocationConfig,
  sessionValues: Record<string, unknown>,
): Record<string, unknown> | undefined {
  const declaredWith = invocation.call_spec?.with ?? invocation.call_with;
  if (!declaredWith || Object.keys(declaredWith).length === 0) {
    return undefined;
  }

  const params: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(declaredWith)) {
    params[key] = resolveCallWithValue(value, sessionValues);
  }
  return params;
}

export class FlowStepExecutor {
  constructor(
    private ctx: ExecutorContext,
    private routing: RoutingExecutor,
  ) {}

  private async applySetAssignmentsAndRemember(
    session: RuntimeSession,
    assignments: Record<string, unknown> | SetAssignmentIR[],
    options: {
      source: string;
      onTraceEvent?: (event: { type: string; data: Record<string, unknown> }) => void;
      resolveValue?: (rawValue: unknown, key: string) => unknown;
    },
  ): Promise<void> {
    const { source, onTraceEvent, resolveValue } = options;
    let wroteSessionValue = false;
    const normalizedAssignments = normalizeSetAssignments(assignments);

    for (const [key, rawValue] of Object.entries(normalizedAssignments)) {
      const resolvedValue = resolveValue ? resolveValue(rawValue, key) : rawValue;
      const wroteMetaValue = applySetValue(session, key, resolvedValue, onTraceEvent);
      if (!wroteMetaValue) {
        wroteSessionValue = true;
      }
    }

    if (!wroteSessionValue) {
      return;
    }

    try {
      await evaluateRememberAfterStateChange(session, onTraceEvent);
    } catch (err) {
      log.warn('memory operations failed after SET batch', {
        source,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private getOrderedActionHandlerActions(handler: ActionHandlerIR): ActionHandlerActionIR[] {
    if (handler.do && handler.do.length > 0) {
      return handler.do;
    }

    const actions: ActionHandlerActionIR[] = [];
    if (handler.set) {
      actions.push({ set: handler.set });
    }
    if (handler.respond !== undefined) {
      actions.push({
        respond: handler.respond,
        voice_config: handler.voice_config,
        rich_content: handler.rich_content,
        actions: handler.actions,
      });
    }
    if (handler.transition) {
      actions.push({ goto: handler.transition });
    }
    return actions;
  }

  private async executeActionHandlerComplete(
    session: RuntimeSession,
    stepName: string,
    onChunk?: (chunk: string) => void,
    onTraceEvent?: (event: { type: string; data: Record<string, unknown> }) => void,
  ): Promise<ExecutionResult> {
    const handoffResult = await this.routing.checkHandoffConditions(session, onChunk, onTraceEvent);
    if (handoffResult) {
      return handoffResult;
    }

    const conditionResult = this.routing.checkCompletionConditions(session, onChunk, onTraceEvent, {
      source: 'action_handler_complete',
      currentStep: stepName,
    });
    if (conditionResult) {
      return conditionResult;
    }

    const result = executeComplete(session, undefined, undefined, onChunk, onTraceEvent);
    tryThreadReturn(session, result, onTraceEvent);
    return result;
  }

  private async handleTerminalFlowTarget(
    session: RuntimeSession,
    target: string,
    options: {
      currentStep: string;
      previousStep?: string;
      currentMessage?: string;
      response?: string;
      richContent?: RichContentIR;
      voiceConfig?: VoiceConfigIR;
      actions?: ActionSetIR;
      localization?: ExecutionResult['localization'];
      completionSource: 'explicit_complete_step' | 'flow_transition';
      onChunk?: (chunk: string) => void;
      onTraceEvent?: (event: { type: string; data: Record<string, unknown> }) => void;
    },
  ): Promise<ExecutionResult | undefined> {
    const terminal = parseFlowTerminalTarget(target);
    if (!terminal) {
      return undefined;
    }

    const {
      currentStep,
      previousStep,
      currentMessage = '',
      response,
      richContent,
      voiceConfig,
      actions,
      localization,
      completionSource,
      onChunk,
      onTraceEvent,
    } = options;

    if (terminal.type === 'complete') {
      session.currentFlowStep = 'COMPLETE';

      const handoffResult = await this.routing.checkHandoffConditions(
        session,
        onChunk,
        onTraceEvent,
      );
      if (handoffResult) {
        return handoffResult;
      }

      const conditionResult = this.routing.checkCompletionConditions(
        session,
        onChunk,
        onTraceEvent,
        {
          source: completionSource,
          currentStep,
          nextStep: completionSource === 'flow_transition' ? target : undefined,
        },
      );
      if (conditionResult) {
        return conditionResult;
      }

      if (completionSource === 'explicit_complete_step') {
        const result = executeComplete(session, undefined, undefined, onChunk, onTraceEvent);
        tryThreadReturn(session, result, onTraceEvent);
        return result;
      }

      session.isComplete = true;

      tryThreadReturn(
        session,
        {
          response: response ?? '',
          ...(richContent !== undefined ? { richContent } : {}),
          ...(voiceConfig !== undefined ? { voiceConfig } : {}),
          ...(actions !== undefined ? { actions } : {}),
          ...(localization !== undefined ? { localization } : {}),
        },
        onTraceEvent,
      );

      return {
        response: resolvePendingResponse(session, currentMessage, response),
        action: { type: 'complete' },
        stateUpdates: buildStateUpdates(session),
        voiceConfig: resolvePendingVoiceConfig(session, currentMessage, voiceConfig),
        richContent: resolvePendingRichContent(session, currentMessage, richContent),
        actions: resolvePendingActions(session, currentMessage, actions),
        ...(localization !== undefined ? { localization } : {}),
      };
    }

    const escalationReason =
      terminal.reason ?? session.escalationReason ?? 'Escalated via flow step transition';
    const escalationPriority = terminal.priority ?? 'medium';
    const escalateResult = await this.routing.handleEscalate(
      session,
      { reason: escalationReason, priority: escalationPriority },
      onTraceEvent,
    );

    let escalationMessage = escalateResult.message;
    if (!escalateResult.success) {
      if (escalateResult.error === 'ESCALATION_NOT_CONFIGURED') {
        session.isEscalated = true;
        session.escalationReason = escalationReason;
        session.currentFlowStep = 'ESCALATE';
        escalationMessage = interpolateTemplate(DEFAULT_MESSAGES.escalation_format, {
          reason: escalationReason,
          priority: escalationPriority,
        });
      } else {
        session.currentFlowStep = previousStep ?? currentStep;
        const protectedFailure = emitProtectedAssistantText(
          session,
          escalationMessage || 'Unable to escalate right now.',
          onChunk,
        );
        return {
          response: protectedFailure.deliveryText,
          action: {
            type: 'error',
            failedAction: 'escalate',
            reason: escalationReason,
            error: escalateResult.error,
          },
          stateUpdates: buildStateUpdates(session),
        };
      }
    } else {
      session.currentFlowStep = 'ESCALATE';
    }

    const protectedEscalation = emitProtectedAssistantText(
      session,
      escalationMessage || 'Escalating to a human agent.',
      onChunk,
    );

    return {
      response: protectedEscalation.deliveryText,
      action: { type: 'escalate', reason: session.escalationReason ?? escalationReason },
      stateUpdates: buildStateUpdates(session),
      voiceConfig: resolvePendingVoiceConfig(session, currentMessage, voiceConfig),
      richContent: resolvePendingRichContent(session, currentMessage, richContent),
      actions: resolvePendingActions(session, currentMessage, actions),
      ...(localization !== undefined ? { localization } : {}),
    };
  }

  private async transitionToFlowTarget(
    session: RuntimeSession,
    target: string,
    options: {
      currentStep: string;
      currentMessage?: string;
      response?: string;
      richContent?: RichContentIR;
      voiceConfig?: VoiceConfigIR;
      actions?: ActionSetIR;
      localization?: ExecutionResult['localization'];
      completionSource?: 'explicit_complete_step' | 'flow_transition';
      onChunk?: (chunk: string) => void;
      onTraceEvent?: (event: { type: string; data: Record<string, unknown> }) => void;
    },
  ): Promise<FlowTransitionResult> {
    const terminalResult = await this.handleTerminalFlowTarget(session, target, {
      ...options,
      previousStep: options.currentStep,
      completionSource: options.completionSource ?? 'flow_transition',
    });

    if (terminalResult) {
      return { outcome: 'terminal', result: terminalResult };
    }

    session.currentFlowStep = target;
    return { outcome: 'continue' };
  }

  private getActionHandlerActionType(action: ActionHandlerActionIR): string {
    if (action.set) return 'set';
    if (action.clear) return 'clear';
    if (action.respond !== undefined) return 'respond';
    if (action.call || action.call_spec) return 'call';
    if (action.goto) return 'goto';
    if (action.handoff) return 'handoff';
    if (action.delegate) return 'delegate';
    if (action.complete) return 'complete';
    return 'unknown';
  }

  private buildActionHandlerForwardingPayload(
    actionEvent: RuntimeActionEvent,
    currentMessage: string,
  ): {
    message: string;
    source: 'message' | 'action_value' | 'action_id';
    context: Record<string, unknown>;
  } {
    const actionContext = buildActionContext(actionEvent);
    const context: Record<string, unknown> = {
      action_id: actionEvent.actionId,
      action: actionContext,
    };
    if (actionEvent.value) {
      context.action_value = actionEvent.value;
    }
    if (actionEvent.source) {
      context.action_source = actionEvent.source;
    }
    if (actionEvent.formData) {
      context.action_form_data = actionEvent.formData;
    }
    if (actionEvent.renderId) {
      context.action_render_id = actionEvent.renderId;
    }

    if (currentMessage.trim().length > 0) {
      return { message: currentMessage, source: 'message', context };
    }

    if (actionEvent.value && actionEvent.value.trim().length > 0) {
      return { message: actionEvent.value, source: 'action_value', context };
    }

    return { message: actionEvent.actionId, source: 'action_id', context };
  }

  private buildActionHandlerTraceDetails(
    action: ActionHandlerActionIR,
    forwardingPayload?: { source: string },
  ): Record<string, unknown> {
    const toolName = getToolInvocationToolName({
      call: action.call,
      call_spec: action.call_spec,
      call_as: action.result_key,
    });

    return {
      ...(action.handoff ? { target: action.handoff } : {}),
      ...(action.delegate ? { target: action.delegate } : {}),
      ...(action.goto ? { goto: action.goto } : {}),
      ...(toolName ? { tool: toolName } : {}),
      ...(action.set ? { setKeys: Object.keys(action.set) } : {}),
      ...(action.clear ? { clearKeys: action.clear } : {}),
      ...(action.respond !== undefined
        ? {
            responds: true,
            richContent: action.rich_content !== undefined,
            voiceConfig: action.voice_config !== undefined,
            actions: action.actions !== undefined,
          }
        : {}),
      ...(action.complete ? { complete: true } : {}),
      ...(action.return !== undefined ? { return: action.return } : {}),
      ...(forwardingPayload ? { forwardedMessageSource: forwardingPayload.source } : {}),
    };
  }

  private attachActionHandlerResponsePayload(
    result: ExecutionResult,
    payload: {
      richContent?: RichContentIR;
      voiceConfig?: VoiceConfigIR;
      actions?: ActionSetIR;
    },
  ): ExecutionResult {
    return {
      ...result,
      ...(result.richContent === undefined && payload.richContent !== undefined
        ? { richContent: payload.richContent }
        : {}),
      ...(result.voiceConfig === undefined && payload.voiceConfig !== undefined
        ? { voiceConfig: payload.voiceConfig }
        : {}),
      ...(result.actions === undefined && payload.actions !== undefined
        ? { actions: payload.actions }
        : {}),
    };
  }

  private async executeActionHandlerActions(
    session: RuntimeSession,
    handler: ActionHandlerIR,
    params: {
      actionId: string;
      actionValue?: string;
      actionEvent?: RuntimeActionEvent;
      stepName: string;
      currentMessage: string;
      onChunk?: (chunk: string) => void;
      onTraceEvent?: (event: { type: string; data: Record<string, unknown> }) => void;
    },
  ): Promise<
    | { outcome: 'fallthrough' }
    | { outcome: 'continue' }
    | { outcome: 'break'; result: ExecutionResult }
  > {
    const { actionId, actionValue, actionEvent, stepName, currentMessage, onChunk, onTraceEvent } =
      params;
    const actions = this.getOrderedActionHandlerActions(handler);
    let finalResponse: string | undefined;
    let finalRichContent: RichContentIR | undefined;
    let finalVoiceConfig: VoiceConfigIR | undefined;
    let finalActions: ActionSetIR | undefined;

    for (let actionIndex = 0; actionIndex < actions.length; actionIndex++) {
      const action = actions[actionIndex];
      const forwardingPayload =
        action.handoff || action.delegate
          ? this.buildActionHandlerForwardingPayload(
              actionEvent ?? { actionId, value: actionValue },
              currentMessage,
            )
          : undefined;
      const actionType = this.getActionHandlerActionType(action);
      onTraceEvent?.({
        type: 'action_handler_action_executed',
        data: {
          actionId,
          actionIndex,
          step: stepName,
          agent: session.agentName,
          actionType,
          ...this.buildActionHandlerTraceDetails(action, forwardingPayload),
        },
      });

      if (action.set) {
        await this.applySetAssignmentsAndRemember(session, action.set, {
          source: `action_handler:${actionId}`,
          onTraceEvent,
          resolveValue: (rawValue) => resolveSetAssignmentValue(rawValue, session.data.values),
        });
      }

      if (action.clear) {
        for (const field of action.clear) {
          deleteSessionValue(session, field);
        }
      }

      if (action.respond !== undefined) {
        const renderedResponse = interpolateTemplate(action.respond, session.data.values);
        const protectedResponse = emitProtectedAssistantText(session, renderedResponse, onChunk);
        finalResponse = protectedResponse.deliveryText;
        finalRichContent = action.rich_content
          ? interpolateRichContent(action.rich_content, session.data.values)
          : undefined;
        finalVoiceConfig = action.voice_config
          ? interpolateVoiceConfig(action.voice_config, session.data.values)
          : undefined;
        finalActions = action.actions
          ? interpolateActionSet(action.actions, session.data.values)
          : undefined;
        const protectedPayload = protectAuthoredStructuredPayload(session, {
          richContent: finalRichContent,
          voiceConfig: finalVoiceConfig,
          actions: finalActions,
        });
        finalRichContent = protectedPayload.richContent;
        finalVoiceConfig = protectedPayload.voiceConfig;
        finalActions = protectedPayload.actions;
        rememberPendingRenderedPayload(
          session,
          protectedResponse.deliveryText,
          finalRichContent,
          finalVoiceConfig,
          finalActions,
        );
      }

      if (action.call || action.call_spec) {
        const invocation = {
          call: action.call,
          call_spec: action.call_spec,
          call_as: action.result_key,
        };
        const toolName = getToolInvocationToolName(invocation);
        if (toolName) {
          const violation = checkFlatConstraintsAtCheckpoint(
            session,
            { kind: 'tool_call', target: toolName },
            onTraceEvent,
          );
          if (violation) {
            return {
              outcome: 'break',
              result: await executeConstraintViolation(session, violation, {
                onChunk,
                onTraceEvent,
                executeHandoff: async (input, chunk, trace) => {
                  return this.routing.handleHandoff(session, input, chunk, trace);
                },
              }),
            };
          }
        }

        const { result: callResult } = await this.executeConfiguredToolInvocation(
          session,
          invocation,
          {
            source: 'action_handler',
            stepName,
          },
          onTraceEvent,
          onChunk,
        );
        this.bindToolInvocationResult(
          session,
          invocation,
          toolName,
          callResult,
          'branch',
          `action_handler:${actionId}`,
          onTraceEvent,
        );

        const resultKey = getToolInvocationResultKey(invocation);
        if (resultKey) {
          session.data.gatheredKeys.add(resultKey);
        }
        try {
          await evaluateRememberAfterStateChange(session, onTraceEvent);
          if (toolName) {
            await executeRecallAfterToolCall(session, toolName, onTraceEvent);
          }
        } catch (err) {
          log.warn('memory operations failed after action handler CALL', {
            error: err instanceof Error ? err.message : String(err),
          });
        }
        onTraceEvent?.({
          type: 'action_handler_action_result',
          data: {
            actionId,
            actionIndex,
            step: stepName,
            agent: session.agentName,
            actionType,
            tool: toolName,
            success: true,
            ...(resultKey ? { resultKey } : { mergedIntoState: true }),
          },
        });
      }

      if (action.goto) {
        session.waitingForInput = undefined;
        const transitionResult = await this.transitionToFlowTarget(session, action.goto, {
          currentStep: stepName,
          currentMessage,
          response: finalResponse,
          richContent: finalRichContent,
          voiceConfig: finalVoiceConfig,
          actions: finalActions,
          onChunk,
          onTraceEvent,
        });
        onTraceEvent?.({
          type: 'action_handler_action_result',
          data: {
            actionId,
            actionIndex,
            step: stepName,
            agent: session.agentName,
            actionType,
            goto: action.goto,
            success: true,
            outcome: 'continue',
          },
        });
        if (transitionResult.outcome === 'terminal') {
          return { outcome: 'break', result: transitionResult.result };
        }
        return { outcome: 'continue' };
      }

      if (action.handoff) {
        const handoffResult = await this.routing.handleHandoff(
          session,
          {
            target: action.handoff,
            message: forwardingPayload?.message ?? currentMessage,
            context: forwardingPayload?.context,
          },
          onChunk,
          onTraceEvent,
        );
        if (handoffResult.success) {
          const result = this.attachActionHandlerResponsePayload(
            buildHandoffExecutionResult(session, action.handoff, handoffResult),
            { richContent: finalRichContent, voiceConfig: finalVoiceConfig, actions: finalActions },
          );
          onTraceEvent?.({
            type: 'action_handler_action_result',
            data: {
              actionId,
              actionIndex,
              step: stepName,
              agent: session.agentName,
              actionType,
              target: action.handoff,
              success: true,
              forwardedMessageSource: forwardingPayload?.source,
              richContentForwarded:
                finalRichContent !== undefined && handoffResult.result?.richContent === undefined,
              voiceConfigForwarded:
                finalVoiceConfig !== undefined && handoffResult.result?.voiceConfig === undefined,
              actionsForwarded:
                finalActions !== undefined && handoffResult.result?.actions === undefined,
            },
          });
          return {
            outcome: 'break',
            result,
          };
        }
        const result = this.attachActionHandlerResponsePayload(
          buildFailedHandoffExecutionResult(session, action.handoff, handoffResult.error),
          { richContent: finalRichContent, voiceConfig: finalVoiceConfig, actions: finalActions },
        );
        onChunk?.(result.response);
        onTraceEvent?.({
          type: 'action_handler_action_result',
          data: {
            actionId,
            actionIndex,
            step: stepName,
            agent: session.agentName,
            actionType,
            target: action.handoff,
            success: false,
            forwardedMessageSource: forwardingPayload?.source,
            richContentForwarded: finalRichContent !== undefined,
            voiceConfigForwarded: finalVoiceConfig !== undefined,
            actionsForwarded: finalActions !== undefined,
          },
        });
        return { outcome: 'break', result };
      }

      if (action.delegate) {
        const delegateResult = await this.routing.handleDelegate(
          session,
          {
            target: action.delegate,
            message: forwardingPayload?.message ?? currentMessage,
            context: forwardingPayload?.context,
          },
          onChunk,
          onTraceEvent,
        );

        if (!delegateResult.success) {
          const result = this.attachActionHandlerResponsePayload(
            {
              response: delegateResult.error || '',
              action: { type: 'delegate', target: action.delegate, success: false },
              stateUpdates: buildStateUpdates(session),
            },
            { richContent: finalRichContent, voiceConfig: finalVoiceConfig, actions: finalActions },
          );
          onTraceEvent?.({
            type: 'action_handler_action_result',
            data: {
              actionId,
              actionIndex,
              step: stepName,
              agent: session.agentName,
              actionType,
              target: action.delegate,
              success: false,
              forwardedMessageSource: forwardingPayload?.source,
              richContentForwarded: finalRichContent !== undefined,
              voiceConfigForwarded: finalVoiceConfig !== undefined,
              actionsForwarded: finalActions !== undefined,
            },
          });
          return {
            outcome: 'break',
            result,
          };
        }

        applyDigressionReturnMap(session, action.on_return?.map, delegateResult.result);
        onTraceEvent?.({
          type: 'action_handler_action_result',
          data: {
            actionId,
            actionIndex,
            step: stepName,
            agent: session.agentName,
            actionType,
            target: action.delegate,
            success: true,
            return: action.return === true,
            forwardedMessageSource: forwardingPayload?.source,
            richContentForwarded: action.return !== true && finalRichContent !== undefined,
            voiceConfigForwarded: action.return !== true && finalVoiceConfig !== undefined,
            actionsForwarded: action.return !== true && finalActions !== undefined,
          },
        });
        if (action.return !== true) {
          return {
            outcome: 'break',
            result: {
              response: finalResponse || '',
              action: { type: 'delegate', target: action.delegate, success: true },
              stateUpdates: buildStateUpdates(session),
              ...(finalRichContent !== undefined ? { richContent: finalRichContent } : {}),
              ...(finalVoiceConfig !== undefined ? { voiceConfig: finalVoiceConfig } : {}),
              ...(finalActions !== undefined ? { actions: finalActions } : {}),
            },
          };
        }
      }

      if (action.complete) {
        const completeResult = await this.executeActionHandlerComplete(
          session,
          stepName,
          onChunk,
          onTraceEvent,
        );
        const result = this.attachActionHandlerResponsePayload(completeResult, {
          richContent: finalRichContent,
          voiceConfig: finalVoiceConfig,
          actions: finalActions,
        });
        onTraceEvent?.({
          type: 'action_handler_action_result',
          data: {
            actionId,
            actionIndex,
            step: stepName,
            agent: session.agentName,
            actionType,
            success: true,
            richContentForwarded:
              finalRichContent !== undefined && completeResult.richContent === undefined,
            voiceConfigForwarded:
              finalVoiceConfig !== undefined && completeResult.voiceConfig === undefined,
            actionsForwarded: finalActions !== undefined && completeResult.actions === undefined,
          },
        });
        return {
          outcome: 'break',
          result,
        };
      }
    }

    if (finalResponse !== undefined) {
      const actionRenderId = hasActionElements(finalActions)
        ? armActionWait(session, stepName)
        : undefined;
      const returnedActions = actionRenderId
        ? withActionRenderId(finalActions, actionRenderId)
        : finalActions;
      if (returnedActions !== undefined) {
        session.pendingActions = returnedActions;
      }
      return {
        outcome: 'break',
        result: {
          response: finalResponse,
          action: actionRenderId ? { type: 'waiting_for_action' } : { type: 'continue' },
          richContent: finalRichContent,
          voiceConfig: finalVoiceConfig,
          actions: returnedActions,
          stateUpdates: buildStateUpdates(session),
        },
      };
    }

    return { outcome: 'fallthrough' };
  }

  private async executeDigressionActions(
    session: RuntimeSession,
    digression: Digression,
    currentMessage: string,
    onChunk?: (chunk: string) => void,
    onTraceEvent?: (event: { type: string; data: Record<string, unknown> }) => void,
  ): Promise<{
    handled: boolean;
    consumeMessage?: boolean;
    result?: ExecutionResult;
  }> {
    const actions = normalizeDigressionActions(digression);
    let finalResponse = digression.respond || '';
    let finalVoiceConfig = digression.voice_config;
    let finalRichContent = digression.rich_content;
    let finalActions = digression.actions;

    for (const action of actions) {
      if (action.respond !== undefined) {
        const response = renderLocalizedFlowTemplate(session, action.respond, action.message_key);
        const protectedResponse = emitProtectedAssistantText(session, response, onChunk);
        finalResponse = protectedResponse.deliveryText;
        finalVoiceConfig = action.voice_config;
        finalRichContent = action.rich_content;
        finalActions = action.actions;
      }

      if (action.set) {
        await this.applySetAssignmentsAndRemember(session, action.set, {
          source: `digression:${digression.intent}`,
          onTraceEvent,
          resolveValue: (rawValue) => resolveSetAssignmentValue(rawValue, session.data.values),
        });
      }

      if (action.clear) {
        for (const field of action.clear) {
          deleteSessionValue(session, field);
        }
      }

      if (action.call || action.call_spec) {
        const invocation = {
          call: action.call,
          call_spec: action.call_spec,
        };
        const toolName = getToolInvocationToolName(invocation);
        if (toolName) {
          const violation = checkFlatConstraintsAtCheckpoint(
            session,
            { kind: 'tool_call', target: toolName },
            onTraceEvent,
          );
          if (violation) {
            const violationResult = await executeConstraintViolation(session, violation, {
              onChunk,
              onTraceEvent,
              executeHandoff: async (input, chunk, trace) => {
                return this.routing.handleHandoff(session, input, chunk, trace);
              },
            });
            return {
              handled: true,
              result: violationResult,
            };
          }
        }

        const { result: callResult } = await this.executeConfiguredToolInvocation(
          session,
          invocation,
          {
            source: 'digression',
            stepName: session.currentFlowStep,
          },
          onTraceEvent,
          onChunk,
        );
        this.bindToolInvocationResult(
          session,
          invocation,
          toolName,
          callResult,
          'branch',
          `digression:${digression.intent}`,
          onTraceEvent,
        );

        try {
          await evaluateRememberAfterStateChange(session, onTraceEvent);
          if (toolName) {
            await executeRecallAfterToolCall(session, toolName, onTraceEvent);
          }
        } catch (err) {
          log.warn('memory operations failed after digression call', {
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }

      if (action.delegate) {
        if (action.return !== true) {
          return {
            handled: true,
            result: {
              response: `Digression delegate "${action.delegate}" requires RETURN: true`,
              action: { type: 'digression', intent: digression.intent, error: 'delegate_return' },
              stateUpdates: buildStateUpdates(session),
            },
          };
        }

        const delegateResult = await this.routing.handleDelegate(
          session,
          {
            target: action.delegate,
            message: currentMessage,
          },
          onChunk,
          onTraceEvent,
        );

        if (!delegateResult.success) {
          return {
            handled: true,
            result: {
              response: delegateResult.error || '',
              action: { type: 'delegate', target: action.delegate, success: false },
              stateUpdates: buildStateUpdates(session),
            },
          };
        }

        applyDigressionReturnMap(session, action.on_return?.map, delegateResult.result);
      }

      if (action.goto) {
        session.waitingForInput = undefined;
        const sourceStep = session.currentFlowStep ?? digression.intent;
        const transitionResult = await this.transitionToFlowTarget(session, action.goto, {
          currentStep: sourceStep,
          currentMessage,
          response: finalResponse,
          richContent: finalRichContent,
          voiceConfig: finalVoiceConfig,
          actions: finalActions,
          onChunk,
          onTraceEvent,
        });
        if (transitionResult.outcome === 'terminal') {
          return {
            handled: true,
            result: transitionResult.result,
          };
        }
        return {
          handled: true,
          consumeMessage: true,
        };
      }

      if (action.resume) {
        return {
          handled: true,
          consumeMessage: true,
        };
      }
    }

    return {
      handled: true,
      result: {
        response: finalResponse,
        action: { type: 'digression', intent: digression.intent },
        stateUpdates: buildStateUpdates(session),
        voiceConfig: finalVoiceConfig,
        richContent: finalRichContent,
        actions: finalActions,
      },
    };
  }

  /**
   * Check if a multi-intent result should be dispatched, and if so,
   * delegate to the routing executor's handleMultiIntent method.
   *
   * This is the integration hook between intent detection (NLU layer)
   * and multi-intent strategy dispatch (routing layer). It checks:
   * 1. Whether multi-intent is enabled for this agent
   * 2. Whether the result contains meaningful alternatives
   * 3. Whether the confidence threshold is met
   *
   * @returns The dispatch result if multi-intent was handled, null otherwise
   */
  dispatchMultiIntentIfNeeded(
    session: RuntimeSession,
    multiResult: DetectedMultiIntentResult,
    userMessage: string,
    sourceStep: string | undefined,
    onTraceEvent?: (event: { type: string; data: Record<string, unknown> }) => void,
  ): MultiIntentDispatchResult | null {
    const agentIR = session.agentIR;
    if (!agentIR) return null;

    // Resolve config to check if multi-intent is enabled
    const config = resolveMultiIntentConfig(agentIR);
    if (!config.enabled) return null;

    const filteredResult = filterDetectedMultiIntentAlternatives(
      multiResult,
      config.confidence_threshold,
    );

    if (!filteredResult) return null;

    const plan = resolveDetectedMultiIntentPlan({
      sessionId: session.id,
      agentName: session.agentName,
      agentIR,
      detected: filteredResult,
      userMessage,
      ...(sourceStep ? { sourceStep } : {}),
      onTraceEvent,
      resolveMessage: buildLocalizedMessageResolver(session, agentIR),
    });

    return applyResolvedMultiIntentPlan({ session, plan, onTraceEvent });
  }

  /**
   * Detect multiple matching intents from ON_INPUT branches.
   *
   * Evaluates all ON_INPUT branches on the current step to find multiple
   * keyword matches. This is the keyword-based implementation — full NLU-driven
   * detection via the sidecar is a future enhancement.
   *
   * Returns null if fewer than 2 intents match (single match = no multi-intent).
   */
  private detectMultipleIntents(
    session: RuntimeSession,
    message: string,
    step: FlowStep,
  ): DetectedMultiIntentResult | null {
    const onInputEntries = step.on_input ?? [];
    if (onInputEntries.length < 2) return null;

    const matches: DetectedMultiIntentResult['alternatives'] = [];

    for (const entry of onInputEntries) {
      // Use the THEN target as the intent name for ON_INPUT branches
      const intentName = entry.then;
      if (!intentName || intentName === 'COMPLETE') continue;

      // Skip ELSE branches (no condition = always matches, not a real intent signal)
      if (!entry.condition) continue;

      // Try evaluateOnInput-style matching for this single branch
      const singleBranchResult = evaluateOnInput([entry], message, session.data.values);
      if (singleBranchResult) {
        const label = humanizeIntentLabel(intentName);
        matches.push({
          intent: label,
          target: {
            kind: 'flow_step',
            ref: intentName,
            label,
          },
          category: null,
          summary: label,
          confidence: 0.8,
          source: 'flow',
        });
      }
    }

    if (matches.length < 2) return null;

    return {
      primary: matches[0],
      alternatives: matches.slice(1),
      relationships: {
        type: 'ambiguous' as const,
        reasoning: 'Multiple ON_INPUT branches matched user message',
      },
    };
  }

  private enqueueGatherDeferredIntents(
    session: RuntimeSession,
    entries: PendingIntentSeed[],
    onTraceEvent?: (event: { type: string; data: Record<string, unknown> }) => void,
  ): void {
    if (entries.length === 0) {
      return;
    }

    if (!session.intentQueue) {
      session.intentQueue = createIntentQueue();
    }

    const agentIR = session.agentIR;
    const maxQueueSize = agentIR ? resolveMultiIntentConfig(agentIR).max_intents : undefined;
    enqueueIntents(session.intentQueue, entries, maxQueueSize);

    for (const entry of entries) {
      onTraceEvent?.({
        type: 'gather_locked_intent_queued',
        data: {
          agentName: session.agentName,
          sourceStep: entry.sourceStep ?? session.currentFlowStep,
          queuedIntent: entry.intent,
          queuedLabel: entry.label ?? entry.summary ?? entry.intent,
          queuedTarget: entry.target?.ref ?? null,
          queuedTargetKind: entry.target?.kind ?? null,
          queueSize: session.intentQueue.pending.length,
        },
      });
    }
  }

  private async detectDeferredGatherQueueEntries(
    session: RuntimeSession,
    step: FlowStep,
    stepName: string,
    currentMessage: string,
    onChunk?: (chunk: string) => void,
    onTraceEvent?: (event: { type: string; data: Record<string, unknown> }) => void,
    options?: {
      suppressParentSupervisorRoute?: boolean;
    },
  ): Promise<{
    queueEntries: PendingIntentSeed[];
    handled: boolean;
    lastResult?: ExecutionResult;
    consumeMessage?: boolean;
  }> {
    if (!currentMessage.trim()) {
      return {
        queueEntries: [],
        handled: false,
      };
    }

    const entries: PendingIntentSeed[] = [];
    const allDigressions = [
      ...(step.digressions || []),
      ...(session.agentIR?.flow?.global_digressions || []),
    ];

    if (allDigressions.length > 0) {
      const digressionMatch = await detectFlowEscapeMatch({
        session,
        currentMessage,
        candidates: allDigressions,
        candidateSurfaceKind: 'digression',
        onTraceEvent,
      });

      if (digressionMatch) {
        const digression = allDigressions[digressionMatch.candidateIndex];
        if (digression) {
          const digressionActions = normalizeDigressionActions(digression);
          const traceAction = digressionActions.find((action) => action.goto)?.goto
            ? 'goto'
            : digressionActions.find((action) => action.delegate)?.delegate
              ? 'delegate'
              : digressionActions.find((action) => action.resume)?.resume
                ? 'resume'
                : 'respond';
          onTraceEvent?.({
            type: 'digression',
            data: {
              agentName: session.agentName,
              stepName,
              intent: digression.intent,
              matched: digressionMatch.matched,
              ...toGatherInterruptTrace(digressionMatch),
              action: traceAction,
            },
          });

          if (shouldQueueGatherLockedDigression(digression)) {
            const queueEntry = buildQueueableDigressionEntry({
              digression,
              originalMessage: currentMessage,
              sourceStep: stepName,
            });
            if (queueEntry) {
              entries.push(queueEntry);
            }
            return {
              queueEntries: entries,
              handled: false,
            };
          }

          const digressionResult = await this.executeDigressionActions(
            session,
            digression,
            currentMessage,
            onChunk,
            onTraceEvent,
          );

          if (digressionResult.result) {
            return {
              queueEntries: entries,
              handled: true,
              lastResult: digressionResult.result,
            };
          }

          if (digressionResult.handled) {
            return {
              queueEntries: entries,
              handled: true,
              consumeMessage: digressionResult.consumeMessage,
            };
          }
        }
      }
    }

    const parentRoute = await detectParentSupervisorRoute({
      ctx: this.ctx,
      session,
      currentMessage,
      currentAgentName: session.agentName,
      suppressParentSupervisorRoute: options?.suppressParentSupervisorRoute,
      onTraceEvent,
    });

    if (parentRoute) {
      onTraceEvent?.({
        type: 'digression',
        data: {
          agentName: session.agentName,
          stepName,
          intent: parentRoute.category,
          matched: parentRoute.matched,
          ...toGatherInterruptTrace(parentRoute),
          action: 'return_to_parent',
          target: parentRoute.target,
          ...(parentRoute.kind === 'blocked' ? { rerouteError: parentRoute.error } : {}),
        },
      });
    }

    if (parentRoute?.kind === 'match') {
      entries.push(
        buildQueueableParentRouteEntry({
          route: parentRoute,
          originalMessage: currentMessage,
          sourceStep: stepName,
        }),
      );
      return {
        queueEntries: entries,
        handled: false,
      };
    }

    if (parentRoute?.kind === 'blocked') {
      return {
        queueEntries: entries,
        handled: true,
        lastResult: {
          response: parentRoute.error,
          action: {
            type: 'error',
            blockedParentReroute: true,
            category: parentRoute.category,
            target: parentRoute.target,
            forwardedMessage: currentMessage,
            detectionMode: parentRoute.detectionMode,
            rerouteError: parentRoute.error,
            ...(parentRoute.lexicalMatchType
              ? { lexicalMatchType: parentRoute.lexicalMatchType }
              : {}),
          },
          stateUpdates: buildStateUpdates(session),
        },
      };
    }

    return {
      queueEntries: entries,
      handled: false,
    };
  }

  private async handleDeferredGatherInterruptWithoutExtraction(
    session: RuntimeSession,
    step: FlowStep,
    stepName: string,
    currentMessage: string,
    onChunk?: (chunk: string) => void,
    onTraceEvent?: (event: { type: string; data: Record<string, unknown> }) => void,
    options?: {
      skipPipeline?: boolean;
      suppressParentSupervisorRoute?: boolean;
    },
  ): Promise<
    | { handled: false }
    | {
        handled: true;
        lastResult?: ExecutionResult;
        consumeMessage?: boolean;
      }
  > {
    const skipPipeline = options?.skipPipeline === true;
    const allDigressions = [
      ...(step.digressions || []),
      ...(session.agentIR?.flow?.global_digressions || []),
    ];

    if (allDigressions.length > 0) {
      const digressionMatch = await detectFlowEscapeMatch({
        session,
        currentMessage,
        candidates: allDigressions,
        candidateSurfaceKind: 'digression',
        skipPipeline,
        onTraceEvent,
      });

      if (digressionMatch) {
        const digression = allDigressions[digressionMatch.candidateIndex];
        if (digression) {
          const digressionActions = normalizeDigressionActions(digression);
          const traceAction = digressionActions.find((action) => action.goto)?.goto
            ? 'goto'
            : digressionActions.find((action) => action.delegate)?.delegate
              ? 'delegate'
              : digressionActions.find((action) => action.resume)?.resume
                ? 'resume'
                : 'respond';

          onTraceEvent?.({
            type: 'digression',
            data: {
              agentName: session.agentName,
              stepName,
              intent: digression.intent,
              matched: digressionMatch.matched,
              ...toGatherInterruptTrace(digressionMatch),
              action: traceAction,
            },
          });

          const digressionResult = await this.executeDigressionActions(
            session,
            digression,
            currentMessage,
            onChunk,
            onTraceEvent,
          );

          if (digressionResult.result) {
            return { handled: true, lastResult: digressionResult.result };
          }

          if (digressionResult.handled) {
            return {
              handled: true,
              consumeMessage: digressionResult.consumeMessage,
            };
          }
        }
      }
    }

    return this.handleDeferredParentSupervisorRouteWithoutExtraction(
      session,
      stepName,
      currentMessage,
      onTraceEvent,
      {
        skipPipeline,
        suppressParentSupervisorRoute: options?.suppressParentSupervisorRoute,
      },
    );
  }

  private async handleDeferredParentSupervisorRouteWithoutExtraction(
    session: RuntimeSession,
    stepName: string,
    currentMessage: string,
    onTraceEvent?: (event: { type: string; data: Record<string, unknown> }) => void,
    options?: {
      skipPipeline?: boolean;
      suppressParentSupervisorRoute?: boolean;
    },
  ): Promise<
    | { handled: false }
    | {
        handled: true;
        lastResult?: ExecutionResult;
      }
  > {
    const parentRoute = await detectParentSupervisorRoute({
      ctx: this.ctx,
      session,
      currentMessage,
      currentAgentName: session.agentName,
      skipPipeline: options?.skipPipeline,
      suppressParentSupervisorRoute: options?.suppressParentSupervisorRoute,
      onTraceEvent,
    });

    if (!parentRoute) {
      return { handled: false };
    }

    onTraceEvent?.({
      type: 'digression',
      data: {
        agentName: session.agentName,
        stepName,
        intent: parentRoute.category,
        matched: parentRoute.matched,
        ...toGatherInterruptTrace(parentRoute),
        action: 'return_to_parent',
        target: parentRoute.target,
        ...(parentRoute.kind === 'blocked' ? { rerouteError: parentRoute.error } : {}),
      },
    });

    if (parentRoute.kind === 'match') {
      const returnToParent = this.routing.handleReturnToParent(
        session,
        {
          reason: `Detected parent supervisor intent "${parentRoute.category}" while collecting flow input.`,
          message: currentMessage,
        },
        onTraceEvent,
      );

      if (returnToParent.success) {
        return {
          handled: true,
          lastResult: {
            response: '',
            action: {
              type: 'return_to_parent',
              category: parentRoute.category,
              target: parentRoute.target,
              forwardedMessage: currentMessage,
              detectionMode: parentRoute.detectionMode,
              ...(parentRoute.lexicalMatchType
                ? { lexicalMatchType: parentRoute.lexicalMatchType }
                : {}),
            },
            stateUpdates: buildStateUpdates(session),
          },
        };
      }

      return { handled: false };
    }

    return {
      handled: true,
      lastResult: {
        response: parentRoute.error,
        action: {
          type: 'error',
          blockedParentReroute: true,
          category: parentRoute.category,
          target: parentRoute.target,
          forwardedMessage: currentMessage,
          detectionMode: parentRoute.detectionMode,
          rerouteError: parentRoute.error,
          ...(parentRoute.lexicalMatchType
            ? { lexicalMatchType: parentRoute.lexicalMatchType }
            : {}),
        },
        stateUpdates: buildStateUpdates(session),
      },
    };
  }

  /**
   * Execute a tool call with error-handler-router resolution.
   *
   * Wraps session.toolExecutor.execute() in a try/catch that:
   * 1. Creates an ErrorContext from the caught error
   * 2. Resolves the best matching error handler from IR (step → agent → default)
   * 3. Retries if the handler specifies retry with backoff
   * 4. Returns error metadata (action, respond, handoff target) for the caller
   */
  private async executeToolWithErrorHandling(
    session: RuntimeSession,
    toolName: string,
    params: Record<string, unknown>,
    onTraceEvent?: (event: { type: string; data: Record<string, unknown> }) => void,
    onChunk?: (chunk: string) => void,
  ): Promise<Record<string, unknown>> {
    if (!session.toolExecutor) {
      log.warn('No tool executor configured', { toolName, step: session.currentFlowStep });
      return { __error: `No tool executor configured for: ${toolName}` };
    }

    const executionParams = restorePIITokensForTrustedInternalExecution(session, params) as Record<
      string,
      unknown
    >;
    const toolStartTime = Date.now();
    const executeFn = () =>
      session.toolExecutor!.execute(toolName, executionParams, DEFAULT_TOOL_TIMEOUT_MS);

    // Look up current flow step for step-level error handlers
    const currentStep = session.agentIR?.flow?.definitions?.[session.currentFlowStep || ''];

    try {
      const result = await executeFn();
      recordToolCall({
        toolName,
        durationMs: Date.now() - toolStartTime,
        success: true,
      });
      return normalizeToolResult(result);
    } catch (err) {
      recordToolCall({
        toolName,
        durationMs: Date.now() - toolStartTime,
        success: false,
      });
      const errorMessage = err instanceof Error ? err.message : String(err);
      const toolErrorMeta = getToolExecutionErrorMetadata(err);
      const classification = classifyToolError(err);
      const diagnostic = classifyExecutionConfigurationDiagnostic(err);
      const errorCtx: ErrorContext = {
        type: 'tool_error',
        subtype: classification.subtype ?? toolErrorMeta.code,
        message: errorMessage,
        retryable: classification.subtype
          ? classification.retryable
          : (toolErrorMeta.retryable ?? true),
        stepName: session.currentFlowStep || undefined,
      };

      // Try to resolve an error handler from IR
      if (session.agentIR) {
        const resolution = resolveErrorHandler(errorCtx, session.agentIR, currentStep);
        if (resolution) {
          onTraceEvent?.({
            type: 'error_handler_resolved',
            data: {
              toolName,
              errorType: errorCtx.type,
              errorMessage: errorMessage.slice(0, 200),
              handlerAction: resolution.action,
              hasRetry: !!resolution.retryCount,
              ...(toolErrorMeta.code ? { errorCode: toolErrorMeta.code } : {}),
              ...(diagnostic ? { diagnostic } : {}),
            },
          });

          // Attempt retry if configured
          if (resolution.retryCount && resolution.retryDelays) {
            try {
              const retryResult = await executeWithRetry(
                executeFn,
                resolution,
                (attempt, delay) => {
                  onTraceEvent?.({
                    type: 'tool_call_retry',
                    data: { toolName, attempt, delay, maxRetries: resolution.retryCount },
                  });
                },
              );
              return (retryResult as Record<string, unknown>) ?? {};
            } catch (retryErr) {
              // Retries exhausted — fall through to resolution action
              log.warn('Tool retries exhausted', { toolName, retryCount: resolution.retryCount });
            }
          }

          // Emit respond message if handler has one; stream to user when onChunk is provided.
          const localizedResponse = resolveLocalizedErrorHandlerResponseWithMetadata({
            session,
            resolution,
          });
          const responseText = localizedResponse?.text ?? resolution.respond;
          const renderedResponseText = responseText
            ? renderLocalizedFlowTemplate(session, responseText)
            : undefined;
          const protectedResponse = renderedResponseText
            ? protectAuthoredAssistantText(session, renderedResponseText)
            : undefined;
          if (responseText) {
            onTraceEvent?.({
              type: 'error_handler_response',
              data: { toolName, respond: responseText },
            });
            if (resolution.action !== 'continue') {
              try {
                onChunk?.(protectedResponse?.deliveryText ?? renderedResponseText ?? responseText);
              } catch {
                /* post-close or consumer rejected — trace already recorded */
              }
            }
          }

          if (
            resolution.action !== 'continue' &&
            hasAuthoredStructuredPayload({
              richContent: resolution.richContent,
              voiceConfig: resolution.voiceConfig,
              actions: resolution.actions,
            })
          ) {
            rememberPendingRenderedPayload(
              session,
              protectedResponse?.deliveryText ?? '',
              resolution.richContent
                ? interpolateRichContent(resolution.richContent, session.data.values)
                : undefined,
              resolution.voiceConfig
                ? interpolateVoiceConfig(resolution.voiceConfig, session.data.values)
                : undefined,
              resolution.actions
                ? interpolateActionSet(resolution.actions, session.data.values)
                : undefined,
            );
          }

          // Return error with handler metadata for caller to handle action
          return {
            __error: errorMessage,
            __error_handler_action: resolution.action,
            ...(resolution.action !== 'continue'
              ? {
                  __error_handler_respond: responseText,
                  __error_handler_localization: localizedResponse?.localization,
                  __error_handler_rich_content: resolution.richContent,
                  __error_handler_voice_config: resolution.voiceConfig,
                  __error_handler_actions: resolution.actions,
                }
              : {}),
            __error_handler_handoff_target: resolution.handoffTarget,
            __error_handler_backtrack_to: resolution.backtrackTo,
          };
        }
      }

      // No handler found — return raw error
      onTraceEvent?.({
        type: 'tool_call_error',
        data: {
          toolName,
          error: errorMessage.slice(0, 200),
          handlerFound: false,
          ...(toolErrorMeta.code ? { errorCode: toolErrorMeta.code } : {}),
          ...(diagnostic ? { diagnostic } : {}),
        },
      });
      return { __error: errorMessage };
    }
  }

  /**
   * Execute a tool call with tool_input/tool_output guardrail checks.
   * Mirrors the pattern from reasoning-executor: evaluates tool_input guardrails
   * before execution and tool_output guardrails after execution.
   */
  private async executeToolWithGuardrails(
    session: RuntimeSession,
    toolName: string,
    params: Record<string, unknown>,
    onTraceEvent?: (event: { type: string; data: Record<string, unknown> }) => void,
    onChunk?: (chunk: string) => void,
  ): Promise<Record<string, unknown>> {
    const dslGuardrails = session.agentIR?.constraints?.guardrails ?? [];
    const toolPolicy = await getSessionPolicy(session);
    const allGuardrails = [...dslGuardrails, ...(toolPolicy?.additionalGuardrails ?? [])];

    // Tool input guardrail check — evaluate before executing the tool
    if (allGuardrails.some((g) => g.kind === 'tool_input')) {
      try {
        if (session.tenantId) await ensureTenantProvidersLoaded(session.tenantId);
        const llmEval = session.llmClient ? createLLMEvalFromClient(session.llmClient) : undefined;
        const pipeline = createGuardrailPipeline(llmEval, session.tenantId, session.projectId, {
          policy: toolPolicy,
          piiRecognizerRegistry: session.piiRecognizerRegistry,
          cacheScopeKey: getSessionGuardrailCacheScopeKey(session),
        });
        const guardrailResult = await pipeline.execute(
          dslGuardrails,
          JSON.stringify(params),
          'tool_input',
          {
            toolName,
            toolParameters: params,
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
          const violationMsg =
            guardrailResult.primaryViolation?.message ??
            formatErrorSync('GUARDRAIL_TOOL_INPUT_BLOCKED').message;
          onTraceEvent?.(
            traceToolBlocked({
              toolName,
              guardrailName: guardrailResult.primaryViolation?.name ?? 'unknown',
              reason: guardrailResult.primaryViolation?.action ?? 'block',
              agent: session.agentName,
            }),
          );
          return { __error: violationMsg, __guardrail: guardrailResult.primaryViolation?.name };
        }

        // If guardrail redacted/modified the content, use modified parameters
        if (guardrailResult.modifiedContent) {
          try {
            const modifiedParams = JSON.parse(guardrailResult.modifiedContent);
            if (typeof modifiedParams === 'object' && modifiedParams !== null) {
              Object.assign(params, modifiedParams);
            }
          } catch {
            log.warn('Guardrail modified tool input is not valid JSON, using original params', {
              toolName,
            });
          }
        }
      } catch (guardrailErr) {
        log.warn('Tool input guardrail evaluation failed, proceeding with tool execution', {
          toolName,
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

    const executionParams = restorePIITokensForTrustedInternalExecution(session, params) as Record<
      string,
      unknown
    >;

    // Execute the actual tool
    let result = await this.executeToolWithErrorHandling(
      session,
      toolName,
      executionParams,
      onTraceEvent,
      onChunk,
    );

    // Tool output guardrail check — evaluate after tool execution
    if (allGuardrails.some((g) => g.kind === 'tool_output')) {
      try {
        if (session.tenantId) await ensureTenantProvidersLoaded(session.tenantId);
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
        const outputContent = typeof result === 'string' ? result : JSON.stringify(result);
        const outputGuardrailResult = await outputPipeline.execute(
          dslGuardrails,
          outputContent,
          'tool_output',
          {
            toolName,
            toolResult: result,
            toolSuccess: !(typeof result === 'object' && result !== null && '__error' in result),
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
          result = {
            __error: violationMsg,
            __guardrail: outputGuardrailResult.primaryViolation?.name,
          };
          onTraceEvent?.(
            traceToolOutputBlocked({
              toolName,
              guardrailName: outputGuardrailResult.primaryViolation?.name ?? 'unknown',
              reason: outputGuardrailResult.primaryViolation?.action ?? 'block',
              agent: session.agentName,
            }),
          );
        }

        if (outputGuardrailResult.modifiedContent) {
          try {
            result = JSON.parse(outputGuardrailResult.modifiedContent);
          } catch {
            log.warn('Guardrail modified tool output is not valid JSON, using original result', {
              toolName,
            });
          }
        }
      } catch (guardrailErr) {
        log.warn('Tool output guardrail evaluation failed, using original result', {
          toolName,
          error: guardrailErr instanceof Error ? guardrailErr.message : String(guardrailErr),
        });
        onTraceEvent?.(
          tracePipelineError({
            kind: 'tool_output',
            error: guardrailErr instanceof Error ? guardrailErr.message : String(guardrailErr),
            agent: session.agentName,
          }),
        );
      }
    }

    return result;
  }

  /**
   * Increment the _clarification_count built-in variable on the session and
   * return the current clarification stage derived from Conversation Behavior.
   * Called each time the user is re-prompted for missing/invalid fields.
   */
  private incrementClarificationCount(session: RuntimeSession): ClarificationResponseStage {
    const strategy = resolveClarificationStrategy({
      currentCount: (session.data.values._clarification_count as number) || 0,
      maxQuestions:
        session._effectiveConfig?.conversationBehavior?.interaction?.clarification?.max_questions,
      maxAttempts:
        session._effectiveConfig?.conversationBehavior?.interaction?.repair?.max_attempts,
    });

    session.data.values._clarification_count = strategy.nextCount;
    return strategy.stage;
  }

  private buildClarificationPrompt(params: {
    missingFields: string[];
    defaultPrompt: string;
    stage: ClarificationResponseStage;
  }): string {
    const { missingFields, defaultPrompt, stage } = params;
    if (stage === 'clarify') {
      return defaultPrompt;
    }

    const fieldsText = missingFields.join(', ');
    if (stage === 'repair') {
      return CONVERSATION_REPAIR_PROMPT_TEMPLATE.replaceAll('{fields}', fieldsText);
    }

    return CONVERSATION_WAITING_PROMPT_TEMPLATE.replaceAll('{fields}', fieldsText);
  }

  /**
   * Handle a constraint control flow directive (collect_field, goto_step, retry_step).
   * Updates session state accordingly and returns an action descriptor for the caller.
   */
  private handleConstraintControlFlow(
    session: RuntimeSession,
    violation: import('@abl/compiler').ConstraintCheckInfo,
    directive: ConstraintControlFlowDirective,
    onChunk?: (chunk: string) => void,
    onTraceEvent?: (event: { type: string; data: Record<string, unknown> }) => void,
  ): { action: 'collect' | 'goto' | 'retry'; nextStep?: string; respond?: string } | null {
    switch (directive.type) {
      case 'collect_field': {
        session.constraintCollectState = {
          fields: directive.fields || [],
          thenAction: directive.thenAction || 'continue',
          ...(directive.thenStep ? { thenStep: directive.thenStep } : {}),
          constraintCondition: directive.constraintCondition,
        };
        return { action: 'collect', respond: directive.respond };
      }
      case 'goto_step': {
        if (!session.backtrackCounts) session.backtrackCounts = {};
        const step = directive.targetStep || '';
        session.backtrackCounts[step] = (session.backtrackCounts[step] || 0) + 1;
        return { action: 'goto', nextStep: step, respond: directive.respond };
      }
      case 'retry_step': {
        return { action: 'retry', respond: directive.respond };
      }
      default:
        return null;
    }
  }

  /**
   * Execute a mini-collect cycle for constraint control flow.
   * Extracts entities from user input for the constraint-requested fields,
   * merges into session, re-evaluates the constraint, and returns the outcome.
   *
   * Returns 'continue' (constraint now passes, proceed), 'retry' (constraint passes,
   * re-run current step), 'goto' (constraint passes, transition to follow-up step),
   * or 'escalate' (constraint still fails after collection).
   */
  private async executeMiniCollect(
    session: RuntimeSession,
    userMessage: string,
    onChunk?: (chunk: string) => void,
    onTraceEvent?: (event: { type: string; data: Record<string, unknown> }) => void,
  ): Promise<
    | { action: 'continue' | 'retry' }
    | { action: 'goto'; nextStep: string }
    | { action: 'escalate'; constraintCondition: string }
  > {
    const state = session.constraintCollectState;
    if (!state) return { action: 'continue' };

    // Extract entities for the requested fields
    const extracted = await this.extractEntitiesWithLLM(
      userMessage,
      state.fields,
      session,
      onTraceEvent,
    );

    // Validate, normalize, and merge extracted values into session
    if (Object.keys(extracted).length > 0) {
      const gatherFields = session.agentIR?.gather?.fields ?? [];
      const { valid: validated } = validateExtractedBatch(
        gatherFields,
        extracted,
        getDateNormalizationOptions(session),
      );
      if (Object.keys(validated).length > 0) {
        setGatheredValues(session, validated);
      }
    }

    setCurrentTurnInputContext(session, userMessage);

    // Capture thenAction before clearing state
    const thenAction = state.thenAction;
    const thenStep = state.thenStep?.trim();
    const constraintCondition = state.constraintCondition;

    // Clear the mini-collect state (no nesting)
    session.constraintCollectState = undefined;

    // Re-evaluate only flat constraints (no guardrails) after mini-collect
    const violation = checkFlatConstraints(session, onTraceEvent);

    if (!violation) {
      // Constraint passes now
      if (thenStep) {
        return { action: 'goto', nextStep: thenStep };
      }
      return { action: thenAction === 'retry' ? 'retry' : 'continue' };
    }

    // Still failing — escalate (no nesting of mini-collects)
    return { action: 'escalate', constraintCondition };
  }

  /**
   * Detect a correction using LLM when regex-based detection fails.
   * Asks the LLM whether the user is correcting a previously provided value.
   * Returns null on LLM failure (non-blocking).
   */
  private async detectCorrectionWithLLM(
    userMessage: string,
    session: RuntimeSession,
    gatherFields?: Array<{ name: string; depends_on?: string[] }>,
  ): Promise<{ field: string; newValue: string; oldValue: unknown } | null> {
    if (!session.llmClient) return null;

    // Build a summary of currently collected values for LLM context
    const collectedEntries = Object.entries(session.data.values)
      .filter(([key]) => !key.startsWith('_') && !key.startsWith('last_') && key !== 'input')
      .map(([key, value]) => `${key}: ${JSON.stringify(value)}`);

    if (collectedEntries.length === 0) return null;

    const fieldNames = gatherFields
      ? gatherFields.map((f) => f.name)
      : collectedEntries.map((e) => e.split(':')[0]);

    const systemPrompt = interpolateTemplate(
      session.promptOverrides?.['llm_prompt.correction_detection'] ??
        promptTemplateLoader.getLLMPrompt('correction_detection'),
      {
        collectedEntries: collectedEntries.join('\n'),
        fieldNames: fieldNames.join(', '),
      },
    );

    try {
      const response = await session.llmClient.chatWithToolUse(
        systemPrompt,
        [{ role: 'user', content: userMessage }],
        [],
        'extraction',
      );

      const responseText = (response.text || '').trim();

      if (responseText === 'null' || responseText === '') return null;

      let parsed: { field: string; newValue: string };
      try {
        parsed = JSON.parse(responseText);
      } catch {
        const jsonMatch = responseText.match(/\{[\s\S]*\}/);
        if (!jsonMatch) return null;
        parsed = JSON.parse(jsonMatch[0]);
      }

      if (!parsed.field || parsed.newValue === undefined) return null;

      // Verify the field exists in collected values
      const oldValue = session.data.values[parsed.field];
      if (oldValue === undefined) return null;

      return {
        field: parsed.field,
        newValue: String(parsed.newValue),
        oldValue,
      };
    } catch (error) {
      log.warn('LLM correction detection failed', {
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  /**
   * Invalidate fields that transitively depend on a corrected field.
   * Uses BFS to walk the depends_on graph: if B depends on A and C depends on B,
   * correcting A invalidates both B and C.
   * Returns the list of invalidated field names.
   */
  private invalidateDependentFields(
    correctedField: string,
    gatherFields: Array<{ name: string; depends_on?: string[] }> | undefined,
    session: RuntimeSession,
  ): string[] {
    if (!gatherFields || gatherFields.length === 0) return [];

    // Build a reverse dependency map: field -> fields that depend on it
    const dependentsMap = new Map<string, string[]>();
    for (const field of gatherFields) {
      if (field.depends_on) {
        for (const dep of field.depends_on) {
          const existing = dependentsMap.get(dep) || [];
          existing.push(field.name);
          dependentsMap.set(dep, existing);
        }
      }
    }

    // BFS from correctedField to find all transitively dependent fields
    const invalidated: string[] = [];
    const queue: string[] = [correctedField];
    const visited = new Set<string>();
    visited.add(correctedField); // Don't invalidate the corrected field itself

    while (queue.length > 0) {
      const current = queue.shift()!;
      const dependents = dependentsMap.get(current) || [];
      for (const dep of dependents) {
        if (!visited.has(dep)) {
          visited.add(dep);
          invalidated.push(dep);
          deleteSessionValue(session, dep);
          queue.push(dep);
        }
      }
    }

    return invalidated;
  }

  private async executeConfiguredToolInvocation(
    session: RuntimeSession,
    invocation: ToolInvocationConfig,
    options: {
      source:
        | 'flow_step'
        | 'on_input'
        | 'on_result'
        | 'on_start'
        | 'hook'
        | 'call_result_branch'
        | 'action_handler'
        | 'digression'
        | 'sub_intent';
      stepName?: string;
      useGuardrails?: boolean;
    },
    onTraceEvent?: (event: { type: string; data: Record<string, unknown> }) => void,
    onChunk?: (chunk: string) => void,
  ): Promise<{ toolName?: string; result: Record<string, unknown> }> {
    const toolName = getToolInvocationToolName(invocation);
    if (!toolName) {
      const callExpression = invocation.call?.trim() || '<empty>';
      log.error('Invalid tool invocation', {
        callExpression,
        source: options.source,
        step: options.stepName ?? session.currentFlowStep,
      });
      onTraceEvent?.({
        type: 'error',
        data: {
          message: `Invalid tool invocation: ${callExpression}`,
          source: options.source,
          step: options.stepName ?? session.currentFlowStep,
        },
      });
      return { result: { __error: `Invalid tool invocation: ${callExpression}` } };
    }

    const params = buildToolInvocationParams(invocation, session.data.values);
    if (params) {
      const traceSource = options.source === 'flow_step' ? 'call_with' : `${options.source}_with`;
      onTraceEvent?.({
        type: 'dsl_call',
        data: {
          agentName: session.agentName,
          stepName: options.stepName ?? session.currentFlowStep,
          callExpression: invocation.call ?? toolName,
          toolName,
          params,
          source: traceSource,
          contextBefore: { ...session.data.values },
        },
      });

      const result =
        options.useGuardrails === false
          ? await this.executeToolWithErrorHandling(
              session,
              toolName,
              params,
              onTraceEvent,
              onChunk,
            )
          : await this.executeToolWithGuardrails(session, toolName, params, onTraceEvent, onChunk);
      return { toolName, result };
    }

    if (invocation.call?.includes('(')) {
      const result = await this.executeFlowCall(session, invocation.call, onTraceEvent, onChunk);
      return { toolName, result };
    }

    onTraceEvent?.({
      type: 'dsl_call',
      data: {
        agentName: session.agentName,
        stepName: options.stepName ?? session.currentFlowStep,
        callExpression: invocation.call ?? toolName,
        toolName,
        params: {},
        source: options.source,
        contextBefore: { ...session.data.values },
      },
    });

    const result =
      options.useGuardrails === false
        ? await this.executeToolWithErrorHandling(session, toolName, {}, onTraceEvent, onChunk)
        : await this.executeToolWithGuardrails(session, toolName, {}, onTraceEvent, onChunk);

    return { toolName, result };
  }

  private bindToolInvocationResult(
    session: RuntimeSession,
    invocation: ToolInvocationConfig,
    toolName: string | undefined,
    result: Record<string, unknown> | undefined,
    mode: ToolInvocationBindingMode,
    source: string,
    onTraceEvent?: (event: { type: string; data: Record<string, unknown> }) => void,
  ): void {
    if (!result) {
      return;
    }

    const resultKey = getToolInvocationResultKey(invocation);
    const emitBindingTrace = (field: string): void => {
      emitDecisionEvent(onTraceEvent, session.traceVerbosity, 'data_mutation', {
        outcome: 'call_result',
        matched: true,
        field,
        oldValue: '<redacted>',
        newValue: '<redacted>',
        source,
      });
    };

    if (resultKey) {
      emitBindingTrace(resultKey);
      session.data.values[resultKey] = result;
    }

    if (mode === 'step') {
      if (!resultKey) {
        Object.assign(session.data.values, result);
      }
      if (toolName) {
        session.data.values[toolName] = { ...result };
      }
      return;
    }

    if (mode === 'branch') {
      if (!resultKey) {
        Object.assign(session.data.values, result);
      }
      return;
    }

    if (mode === 'lifecycle' && toolName) {
      if (!resultKey && !result.__error) {
        const resultField = `_${toolName}_result`;
        emitBindingTrace(resultField);
        session.data.values[resultField] = result;
      }

      const lastResultField = `last_${toolName}_result`;
      emitBindingTrace(lastResultField);
      session.data.values[lastResultField] = result;
    }
  }

  /**
   * Execute ON_START directives when a session first begins
   */
  async executeOnStart(
    session: RuntimeSession,
    onChunk?: (chunk: string) => void,
    onTraceEvent?: (event: { type: string; data: Record<string, unknown> }) => void,
  ): Promise<ExecutionResult | null> {
    const ir = session.agentIR;
    if (!ir?.on_start) {
      return null; // No ON_START defined
    }

    await refreshSessionPIIContext(session);

    const onStart = ir.on_start;

    // CRITICAL: Skip ON_START auto-response for AI4W channels
    // AI4W channels should only respond to user messages, not send automatic greetings
    // or structured starter payloads. We still execute SET and CALL for initialization,
    // but skip RESPOND, rich_content, voice_config, and actions to avoid unwanted
    // first-turn responses.
    const isAI4WChannel = session.channelType === 'ai4w';

    if (isAI4WChannel) {
      log.info('Executing ON_START for AI4W channel (response payload suppressed)', {
        agent: session.agentName,
        sessionId: session.id,
      });
    } else {
      log.debug('Executing ON_START', { agent: session.agentName });
    }

    // Emit trace event
    if (onTraceEvent) {
      onTraceEvent({
        type: 'dsl_on_start',
        data: {
          agent: session.agentName,
          config: onStart,
        },
      });
    }

    // Execute SET first (initialize variables)
    if (onStart.set) {
      for (const [key, value] of Object.entries(onStart.set)) {
        if (onTraceEvent) {
          onTraceEvent({
            type: 'dsl_set',
            data: { variable: key, value: parseOnStartSetValue(value), source: 'on_start' },
          });
        }
      }

      await this.applySetAssignmentsAndRemember(session, onStart.set, {
        source: 'on_start',
        onTraceEvent,
        resolveValue: (rawValue) => parseOnStartSetValue(rawValue),
      });
    }

    // Execute CALL if specified
    if (onStart.call || onStart.call_spec) {
      try {
        const { toolName, result: toolResult } = await this.executeConfiguredToolInvocation(
          session,
          {
            call: onStart.call,
            call_spec: onStart.call_spec,
          },
          {
            source: 'on_start',
            useGuardrails: false,
          },
          onTraceEvent,
          onChunk,
        );
        this.bindToolInvocationResult(
          session,
          {
            call: onStart.call,
            call_spec: onStart.call_spec,
          },
          toolName,
          toolResult,
          'lifecycle',
          'lifecycle_hook:on_start',
          onTraceEvent,
        );
      } catch (error) {
        log.error('ON_START call error', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    const onStartVoiceConfig = onStart.voice_config
      ? interpolateVoiceConfig(onStart.voice_config, session.data.values)
      : undefined;
    const onStartRichContent = onStart.rich_content
      ? interpolateRichContent(onStart.rich_content, session.data.values)
      : undefined;
    const onStartActions = onStart.actions
      ? interpolateActionSet(onStart.actions, session.data.values)
      : undefined;

    // Execute RESPOND if specified (skip for AI4W channels — trace emitted at end)
    let authoredOnStartResponse: { deliveryText: string; historyText: string } | undefined;
    if (onStart.respond && !isAI4WChannel) {
      const response = interpolateTemplate(onStart.respond, session.data.values);
      authoredOnStartResponse = protectAuthoredAssistantText(session, response);

      if (onChunk) {
        onChunk(`${authoredOnStartResponse.deliveryText}\n\n`);
      }

      if (onTraceEvent) {
        onTraceEvent({
          type: 'dsl_respond',
          data: { message: response, source: 'on_start' },
        });
      }
    }

    if (
      !isAI4WChannel &&
      (onStart.respond ||
        hasAuthoredStructuredPayload({
          richContent: onStartRichContent,
          voiceConfig: onStartVoiceConfig,
          actions: onStartActions,
        }))
    ) {
      appendProtectedAssistantHistoryPayload(session, authoredOnStartResponse?.historyText ?? '', {
        richContent: onStartRichContent,
        voiceConfig: onStartVoiceConfig,
        actions: onStartActions,
      });
    }

    // Execute DELEGATE if specified
    if (onStart.delegate) {
      if (onTraceEvent) {
        onTraceEvent({
          type: 'delegate_start',
          data: { agent: onStart.delegate, source: 'on_start' },
        });
      }

      // For AI4W: still delegate, but suppress the starter response payload
      if (isAI4WChannel) {
        return protectExecutionResultStructuredPayload(session, {
          response: '',
          action: { type: 'delegate', agent: onStart.delegate },
        })!;
      }

      return protectExecutionResultStructuredPayload(session, {
        response: authoredOnStartResponse?.deliveryText ?? (onStart.respond || ''),
        action: {
          type: 'delegate',
          agent: onStart.delegate,
        },
        voiceConfig: onStartVoiceConfig,
        richContent: onStartRichContent,
        actions: onStartActions,
      })!;
    }

    // Return respond result with structured payload (skip entirely for AI4W)
    if (isAI4WChannel) {
      if (
        onStart.respond ||
        hasAuthoredStructuredPayload({
          richContent: onStartRichContent,
          voiceConfig: onStartVoiceConfig,
          actions: onStartActions,
        })
      ) {
        if (onTraceEvent) {
          onTraceEvent({
            type: 'dsl_on_start_skipped',
            data: {
              agent: session.agentName,
              channelType: session.channelType,
              reason: 'ai4w_channel_no_auto_starter',
              hadRespond: !!onStart.respond,
              hadRichContent: !!onStartRichContent,
              hadVoiceConfig: !!onStartVoiceConfig,
              hadActions: !!onStartActions,
            },
          });
        }
      }
      return null;
    }

    if (
      onStart.respond ||
      hasAuthoredStructuredPayload({
        richContent: onStartRichContent,
        voiceConfig: onStartVoiceConfig,
        actions: onStartActions,
      })
    ) {
      return protectExecutionResultStructuredPayload(session, {
        response: authoredOnStartResponse?.deliveryText ?? '',
        action: { type: 'respond', message: authoredOnStartResponse?.deliveryText ?? '' },
        voiceConfig: onStartVoiceConfig,
        richContent: onStartRichContent,
        actions: onStartActions,
      })!;
    }

    return null;
  }

  /**
   * Apply an ON_INPUT branch result: SET, RESPOND, CALL (with constraints + memory), THEN.
   *
   * Shared between the normal ON_INPUT evaluation path and the queued-intent
   * fast path so both execute the full branch semantics without duplication.
   *
   * Returns 'transition' when the branch specifies a THEN target (caller should
   * update currentFlowStep and continue), 'break' when a constraint violation
   * occurred during CALL (caller should break), or 'none' otherwise.
   */
  async applyOnInputBranchResult(
    session: RuntimeSession,
    stepName: string,
    branchResult: {
      set?: Record<string, string>;
      respond?: string;
      message_key?: string;
      voice_config?: VoiceConfigIR;
      rich_content?: RichContentIR;
      actions?: ActionSetIR;
      call?: string;
      call_spec?: ToolInvocationIR;
      then: string;
    },
    onChunk: ((chunk: string) => void) | undefined,
    onTraceEvent: ((event: { type: string; data: Record<string, unknown> }) => void) | undefined,
  ): Promise<{ outcome: 'transition' | 'break' | 'none'; lastResult?: ExecutionResult }> {
    // Apply SET assignments
    if (branchResult.set) {
      if (onTraceEvent) {
        onTraceEvent({
          type: 'dsl_set',
          data: {
            agentName: session.agentName,
            stepName,
            assignments: branchResult.set,
            contextBefore: { ...session.data.values },
          },
        });
      }
      await this.applySetAssignmentsAndRemember(session, branchResult.set, {
        source: `on_input:${stepName}`,
        onTraceEvent,
        resolveValue: (rawValue) => resolveSetAssignmentValue(rawValue, session.data.values),
      });
    }

    // Execute branch CALL with constraint checks and memory hooks
    if (branchResult.call || branchResult.call_spec) {
      const branchCallToolName = getToolInvocationToolName(branchResult);
      if (branchCallToolName) {
        const branchCallViolation = checkFlatConstraintsAtCheckpoint(
          session,
          { kind: 'tool_call', target: branchCallToolName },
          onTraceEvent,
        );
        if (branchCallViolation) {
          const lastResult = await executeConstraintViolation(session, branchCallViolation, {
            onChunk,
            onTraceEvent,
            executeHandoff: async (input, chunk, trace) => {
              return this.routing.handleHandoff(session, input, chunk, trace);
            },
          });
          return { outcome: 'break', lastResult };
        }
      }

      const { toolName, result: callResult } = await this.executeConfiguredToolInvocation(
        session,
        {
          call: branchResult.call,
          call_spec: branchResult.call_spec,
        },
        {
          source: 'on_input',
          stepName,
        },
        onTraceEvent,
        onChunk,
      );
      this.bindToolInvocationResult(
        session,
        {
          call: branchResult.call,
          call_spec: branchResult.call_spec,
        },
        toolName,
        callResult,
        'branch',
        `on_input:${stepName}`,
        onTraceEvent,
      );

      try {
        await evaluateRememberAfterStateChange(session, onTraceEvent);
        if (toolName) {
          await executeRecallAfterToolCall(session, toolName, onTraceEvent);
        }
      } catch (err) {
        log.warn('memory operations failed after branch call', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    const branchVoiceConfig = branchResult.voice_config
      ? interpolateVoiceConfig(branchResult.voice_config, session.data.values)
      : undefined;
    const branchRichContent = branchResult.rich_content
      ? interpolateRichContent(branchResult.rich_content, session.data.values)
      : undefined;
    const branchActions = branchResult.actions
      ? interpolateActionSet(branchResult.actions, session.data.values)
      : undefined;

    // Show branch response after CALL so templates can reference AS-bound results.
    let protectedBranchResponse: { deliveryText: string; historyText: string } | undefined;
    if (branchResult.respond) {
      const resp = renderLocalizedFlowTemplate(
        session,
        branchResult.respond,
        branchResult.message_key,
      );
      if (onTraceEvent) {
        onTraceEvent({
          type: 'dsl_respond',
          data: {
            agentName: session.agentName,
            stepName,
            template: branchResult.respond,
            rendered: resp,
          },
        });
      }
      protectedBranchResponse = protectAuthoredAssistantText(session, resp);
      if (onChunk) {
        onChunk(protectedBranchResponse.deliveryText);
      }
    }
    if (
      branchResult.respond ||
      hasAuthoredStructuredPayload({
        richContent: branchRichContent,
        voiceConfig: branchVoiceConfig,
        actions: branchActions,
      })
    ) {
      appendProtectedAssistantHistoryPayload(session, protectedBranchResponse?.historyText ?? '', {
        richContent: branchRichContent,
        voiceConfig: branchVoiceConfig,
        actions: branchActions,
      });
    }
    rememberPendingRenderedPayload(
      session,
      protectedBranchResponse?.deliveryText ?? '',
      branchRichContent,
      branchVoiceConfig,
      branchActions,
    );

    if (branchResult.then) {
      return { outcome: 'transition' };
    }
    return { outcome: 'none' };
  }

  /**
   * Resolve and apply a single targeted ON_INPUT branch by its THEN target.
   *
   * Used by queued-intent replay and prompt-less multi-intent continuation so
   * both paths execute the same branch semantics without duplicating the branch
   * lookup + apply logic.
   */
  private async continueWithTargetedOnInputBranch(
    session: RuntimeSession,
    stepName: string,
    userMessage: string,
    targetStep: string,
    onChunk: ((chunk: string) => void) | undefined,
    onTraceEvent: ((event: { type: string; data: Record<string, unknown> }) => void) | undefined,
  ): Promise<{ outcome: 'transition' | 'break' | 'none'; lastResult?: ExecutionResult }> {
    const currentStep = session.agentIR?.flow?.definitions?.[stepName];
    const targetBranch = currentStep?.on_input?.find((branch) => branch.then === targetStep);

    if (!targetBranch) {
      return { outcome: 'none' };
    }

    // Preserve the current user message in session context so branch conditions
    // like `input contains "billing"` continue to evaluate consistently.
    session.data.values['input'] = userMessage;
    session.data.values['_raw_input'] = userMessage;

    const branchResult = evaluateOnInput(
      [targetBranch],
      userMessage,
      session.data.values,
      undefined,
      onTraceEvent,
    );

    if (!branchResult) {
      return { outcome: 'none' };
    }

    const applied = await this.applyOnInputBranchResult(
      session,
      stepName,
      branchResult,
      onChunk,
      onTraceEvent,
    );

    if (applied.outcome === 'transition') {
      const transitionResult = await this.transitionToFlowTarget(session, branchResult.then, {
        currentStep: stepName,
        currentMessage: userMessage,
        onChunk,
        onTraceEvent,
      });
      if (transitionResult.outcome === 'terminal') {
        return { outcome: 'break', lastResult: transitionResult.result };
      }
    }

    return applied;
  }

  /**
   * Execute a CALL in flow step
   */
  async executeFlowCall(
    session: RuntimeSession,
    callExpr: string,
    onTraceEvent?: (event: { type: string; data: Record<string, unknown> }) => void,
    onChunk?: (chunk: string) => void,
  ): Promise<Record<string, unknown>> {
    // Parse call expression: tool_name(arg1, arg2, ...)
    const match = callExpr.match(/^(\w+)\((.*)\)$/);
    if (!match) {
      log.error('Invalid call expression', { callExpr, step: session.currentFlowStep });
      if (onTraceEvent)
        onTraceEvent({
          type: 'error',
          data: { message: `Invalid call expression: ${callExpr}`, step: session.currentFlowStep },
        });
      return { __error: `Invalid call expression: ${callExpr}` };
    }

    const toolName = match[1];
    const argList = match[2]
      .split(',')
      .map((a) => a.trim())
      .filter(Boolean);

    // Build params from collected data.
    // Supports two inline formats:
    //   Positional: tool(arg1, arg2) — looks up each arg as a key in session.data.values
    //   Named:      tool(key: expr, key2: expr2) — resolves expr via resolveValueDual
    // Named format is detected by the presence of "key: value" in the first arg.
    const params: Record<string, unknown> = {};
    const isNamed = argList.length > 0 && argList[0].includes(':');
    if (isNamed) {
      for (const arg of argList) {
        const colonIdx = arg.indexOf(':');
        if (colonIdx === -1) {
          // Malformed named arg — skip with warning
          log.warn('CALL named parameter missing colon', {
            arg,
            step: session.currentFlowStep,
            agentName: session.agentName,
          });
          continue;
        }
        const paramName = arg.slice(0, colonIdx).trim();
        const expr = arg.slice(colonIdx + 1).trim();
        // Resolve value expression: handles dotted paths (session.channel),
        // string literals ("value"), and CEL expressions.
        params[paramName] = resolveCallArgumentExpression(expr, session.data.values);
      }
    } else {
      for (const arg of argList) {
        const val = session.data.values[arg];
        if (val === undefined || val === null) {
          log.warn('CALL parameter not found in session data', {
            parameter: arg,
            step: session.currentFlowStep,
            agentName: session.agentName,
          });
        }
        params[arg] = val !== undefined ? val : null;
      }
    }

    // Emit ABL CALL trace event (higher-level than tool_call)
    if (onTraceEvent) {
      onTraceEvent({
        type: 'dsl_call',
        data: {
          agentName: session.agentName,
          stepName: session.currentFlowStep,
          callExpression: callExpr,
          toolName,
          params,
          contextBefore: { ...session.data.values },
        },
      });
    }

    // ABLP-1094: align FLOW tool emission with the LLM reasoning-executor path
    // so the Debug UI's TOOL CALL card groups call+result into a single block
    // showing Input AND Output. We share `toolCallId` across all three events
    // (tool_call_start, completed tool_call, tool_result) so consumers that
    // correlate by id (Studio event-processor, mcp-debug) all fuse correctly.
    const toolCallId = crypto.randomUUID();
    const toolDef = session.agentIR?.tools?.find((t) => t.name === toolName);
    const httpMeta =
      toolDef?.tool_type === 'http' && toolDef.http_binding
        ? buildHttpTraceMeta(toolDef.http_binding)
        : undefined;

    if (onTraceEvent) {
      onTraceEvent({
        type: 'tool_call_start',
        data: buildFlowToolCallStartTraceData({
          toolCallId,
          toolName,
          input: params,
          agent: session.agentName,
          httpMeta,
        }),
      });
    }

    // Inject session namespace for {{session.X}} placeholders in HTTP tool body templates.
    // This allows parameterless tools to read values directly from the session namespace
    // (e.g., {{session.idCard}}, {{session.channel}}) without requiring explicit CALL params.
    const sessionNs = session.data.values.session;
    if (sessionNs && typeof sessionNs === 'object') {
      const sessionNamespace = sessionNs as Record<string, unknown>;
      const interactionState = sessionNamespace.interactionContext ?? sessionNamespace.interaction;
      params._session = {
        ...sessionNamespace,
        ...(interactionState ? { interactionContext: interactionState } : {}),
        ...(session.data.values._metadata ? { _metadata: session.data.values._metadata } : {}),
      };
    } else if (session.data.values._metadata) {
      // Ensure _session is injected with metadata even when session namespace is empty,
      // so MCP tools can resolve {{_session._metadata.*}} placeholders.
      params._session = {
        id: session.id,
        tenantId: session.tenantId,
        projectId: session.projectId,
        agentName: session.agentName,
        _metadata: session.data.values._metadata,
      };
    }

    // Execute tool via session's tool executor (with guardrails + error handler resolution)
    const startedAt = Date.now();
    const result = await this.executeToolWithGuardrails(
      session,
      toolName,
      params,
      onTraceEvent,
      onChunk,
    );
    const latencyMs = Date.now() - startedAt;
    const toolError =
      typeof result?.__error === 'string'
        ? (result.__error as string)
        : result?.__error
          ? String(result.__error)
          : undefined;
    const toolErrorCode =
      typeof result?.__errorCode === 'string' ? (result.__errorCode as string) : undefined;

    if (onTraceEvent) {
      onTraceEvent({
        type: 'tool_call',
        data: buildFlowToolCallCompletionTraceData({
          toolCallId,
          toolName,
          input: params,
          output: result,
          success: toolError === undefined,
          latencyMs,
          agent: session.agentName,
          ...(toolError ? { error: toolError } : {}),
          ...(toolErrorCode ? { errorCode: toolErrorCode } : {}),
          httpMeta,
        }),
      });
    }

    try {
      if (onTraceEvent) {
        onTraceEvent({
          type: 'tool_result',
          data: {
            toolCallId,
            toolName,
            tool: toolName,
            result,
          },
        });
      }
    } catch (traceErr) {
      log.warn('tool_result trace event failed', {
        toolName,
        error: traceErr instanceof Error ? traceErr.message : String(traceErr),
      });
    }
    return result;
  }

  /**
   * Build a tool definition for structured entity extraction via tool call.
   * Each gather field becomes a property in the tool's input schema, using
   * ablTypeToJsonSchema() for type mapping and embedding validation constraints.
   */
  static buildExtractionTool(
    gatherFields: Array<{
      name: string;
      type?: string;
      prompt?: string;
      extraction_hints?: string[];
      validation?: ValidationRule;
      default?: unknown;
      range?: boolean;
      list?: boolean;
      options?: string[];
      semantics?: GatherFieldSemantics;
      synonyms?: Record<string, string[]>;
    }>,
    lookupTables?: Record<string, LookupTableIR>,
  ): ToolDefinition {
    const properties: Record<string, ToolPropertySchema> = {};

    for (const field of gatherFields) {
      const ablType = field.type || 'string';

      // Build description from field metadata
      const descParts: string[] = [];
      if (field.prompt) descParts.push(field.prompt);
      else descParts.push(`The ${field.name.replace(/_/g, ' ')}`);
      if (field.extraction_hints && field.extraction_hints.length > 0) {
        descParts.push(`(hints: ${field.extraction_hints.join(', ')})`);
      }
      // Defaults are applied by runtime gather completeness, not by extraction.
      // Including them here causes the extractor to hallucinate unspecified values.
      const description = descParts.join(' ');

      // Use ablTypeToJsonSchema for base schema
      const schema = ablTypeToJsonSchema(ablType, description);

      // Embed validation constraints into schema — cast via unknown for JSON Schema
      // extensions (minimum, maximum, pattern) not in ToolPropertySchema interface
      const schemaExt = schema as unknown as Record<string, unknown>;
      if (field.validation) {
        switch (field.validation.type) {
          case 'range': {
            const rangeMatch = field.validation.rule.match(
              /^(\d+(?:\.\d+)?)\s*-\s*(\d+(?:\.\d+)?)$/,
            );
            if (rangeMatch) {
              schemaExt.minimum = parseFloat(rangeMatch[1]);
              schemaExt.maximum = parseFloat(rangeMatch[2]);
            }
            break;
          }
          case 'enum':
            schema.enum = field.validation.rule.split('|').map((v) => v.trim());
            break;
          case 'pattern':
            schemaExt.pattern = field.validation.rule;
            break;
          case 'llm':
            // Append LLM validation instruction to description
            schema.description = schema.description
              ? `${schema.description}. Constraint: ${field.validation.rule}`
              : `Constraint: ${field.validation.rule}`;
            break;
        }
      }

      // GAP-3: Inject lookup table values into schema for LLM guidance
      if (!schema.enum && field.semantics?.lookup && lookupTables) {
        const table = lookupTables[field.semantics.lookup];
        if (table) {
          const lookupValues = resolveLookupValuesForPrompt(table);
          if (lookupValues) {
            if (lookupValues.length <= LOOKUP_ENUM_INJECTION_MAX) {
              // Small enough to inject as JSON Schema enum constraint
              schema.enum = lookupValues;
            } else {
              // Too large for enum — add as description hint
              const sample = lookupValues.slice(0, LOOKUP_HINT_SAMPLE_SIZE).join(', ');
              schema.description =
                (schema.description ?? '') +
                ` [valid values include: ${sample}, ... (${lookupValues.length} total)]`;
            }
          }
        }
      }

      // Inject GATHER options as enum constraint so the LLM normalises
      // extracted values to one of the declared options (e.g. "MacBook Pro" → "Mac").
      const fieldOptions = field.options || (field as Record<string, unknown>).enum_values;
      if (!schema.enum && Array.isArray(fieldOptions) && fieldOptions.length > 0) {
        schema.enum = fieldOptions as string[];
      }

      // GAP-32: Append synonym info so the LLM maps user language to canonical values
      if (field.synonyms && Object.keys(field.synonyms).length > 0) {
        const synonymHint = Object.entries(field.synonyms)
          .map(([canonical, aliases]) => `${canonical} (${aliases.join(', ')})`)
          .join('; ');
        schema.description = (schema.description ?? '') + ` [synonyms: ${synonymHint}]`;
      }

      // Wrap in range/list if needed
      if (field.list) {
        properties[field.name] = {
          type: 'array',
          description: `List of ${field.name.replace(/_/g, ' ')} values`,
          items: schema,
        };
      } else if (field.range) {
        properties[field.name] = {
          type: 'object',
          description: `Range for ${field.name.replace(/_/g, ' ')}`,
          properties: {
            low: schema,
            high: schema,
          },
        };
      } else {
        properties[field.name] = schema;
      }
    }

    return {
      name: '_extract_entities',
      description:
        'Extract entity values from the user message. Call this tool with any entities you can identify.',
      input_schema: {
        type: 'object',
        properties,
        required: [], // All optional — only extract what's present
      },
    };
  }

  /**
   * Extract entities from user input using a 4-tier pipeline:
   *
   *   Tier 1 — JS libs (chrono-node, libphonenumber-js): date, datetime, phone
   *   Tier 2 — NLU sidecar (Python ML service): named entities, custom types
   *   Tier 3 — LLM tool-call extraction: remaining unfilled fields
   *   Tier 4 — Regex fallback: pattern-based extraction on LLM failure
   *
   * The extraction_strategy from the project runtime config controls which
   * tiers are active:
   *   'auto'    — Tier 1 → Tier 2 → Tier 3 → Tier 4 (full pipeline)
   *   'hybrid'  — Same as auto
   *   'ml'      — Tier 1 → Tier 2 only, no LLM
   *   'llm'     — Tier 3 only (skip JS libs and sidecar)
   *   'pattern' — Existing regex-based extraction only
   */
  async extractEntitiesWithLLM(
    userMessage: string,
    fields: string[],
    session: RuntimeSession,
    onTraceEvent?: (event: { type: string; data: Record<string, unknown> }) => void,
    gatherFields?: Array<{
      name: string;
      type?: string;
      prompt?: string;
      extraction_hints?: string[];
      validation?: ValidationRule;
      options?: string[];
      semantics?: GatherFieldSemantics;
      range?: boolean;
      list?: boolean;
      preferences?: boolean;
      strategy?: 'pattern' | 'llm' | 'hybrid';
      default?: unknown;
    }>,
    gatherBlockStrategy?: 'pattern' | 'llm' | 'hybrid',
  ): Promise<Record<string, unknown>> {
    const normalizedInput = buildNormalizedExtractionInput(userMessage, gatherFields ?? []);
    const extractionMessage = normalizedInput.extractionText;
    const extractionTraceInput =
      extractionMessage !== userMessage ? { extractionInput: extractionMessage } : {};

    // Build fieldTypes map for regex fallback extraction (Gap 26)
    const fieldTypes = (gatherFields ?? []).reduce(
      (acc: Record<string, string>, f: { name: string; type?: string }) => {
        acc[f.name] = f.type ?? '';
        return acc;
      },
      {} as Record<string, string>,
    );
    const dateNormalization = getDateNormalizationOptions(session);
    const locale = dateNormalization.locale ?? 'en';
    const dateExtractionOptions = {
      referenceInstant: dateNormalization.referenceInstant,
      timezone: dateNormalization.timezone,
    };

    // If no LLM client, try Tier 1 JS libs then fall back to regex extraction
    if (!session.llmClient) {
      log.debug('No LLM client, using JS libs + regex fallback for entity extraction');

      // Tier 1: JS libs for typed fields even without LLM
      const jsFieldDescs = fields
        .map((fieldName) => {
          const gf = gatherFields?.find((f) => f.name === fieldName);
          return { name: fieldName, type: gf?.type ?? '' };
        })
        .filter((f) => isJSExtractableType(f.type));

      const jsResults =
        jsFieldDescs.length > 0
          ? extractWithJSLibs(extractionMessage, jsFieldDescs, locale, dateExtractionOptions)
          : {};

      // Regex fallback for fields not covered by JS libs
      const jsFilledFields = new Set(
        Object.keys(jsResults).filter((k) => jsResults[k] !== undefined),
      );
      const regexFields = fields.filter((f) => !jsFilledFields.has(f));
      const regexResult =
        regexFields.length > 0
          ? extractEntitiesForFields(
              extractionMessage,
              regexFields,
              undefined,
              fieldTypes,
              locale,
              dateExtractionOptions,
            )
          : {};

      const result = { ...jsResults, ...regexResult };

      // Emit entity extraction trace event for regex-only mode
      if (onTraceEvent) {
        const extractedFields = Object.keys(result).filter((k) => result[k] !== undefined);
        const missingFields = fields.filter((f) => result[f] === undefined);
        onTraceEvent({
          type: 'entity_extraction',
          data: {
            agentName: session.agentName,
            stepName: session.currentFlowStep,
            userMessage,
            ...extractionTraceInput,
            requestedFields: fields,
            extractedFields,
            missingFields,
            values: result,
            method: jsFilledFields.size > 0 ? 'js_libs_and_regex' : 'regex',
          },
        });
      }

      return result;
    }

    // Resolve per-field strategy: field.strategy → gatherBlockStrategy → 'hybrid'
    const resolvedStrategies = new Map<string, 'pattern' | 'llm' | 'hybrid'>();
    for (const field of fields) {
      const gf = gatherFields?.find((f) => f.name === field);
      const strategy = gf?.strategy || gatherBlockStrategy || 'hybrid';
      resolvedStrategies.set(field, strategy);
    }

    // Emit extraction_strategy_resolved decision trace at verbose/debug
    const verbosity = session.traceVerbosity ?? 'standard';
    const emitDecisionTrace = onTraceEvent && (verbosity === 'verbose' || verbosity === 'debug');
    if (emitDecisionTrace) {
      const fieldStrategyInfo: Record<string, { strategy: string; source: string }> = {};
      for (const field of fields) {
        const gf = gatherFields?.find((f) => f.name === field);
        const strategy = resolvedStrategies.get(field)!;
        const source = gf?.strategy ? 'field' : gatherBlockStrategy ? 'block' : 'default';
        fieldStrategyInfo[field] = { strategy, source };
      }
      onTraceEvent!({
        type: 'extraction_strategy_resolved',
        data: {
          agentName: session.agentName,
          stepName: session.currentFlowStep,
          fields: fieldStrategyInfo,
        },
      });
    }

    const patternOnlyFields = fields.filter((f) => resolvedStrategies.get(f) === 'pattern');
    const llmOnlyFields = fields.filter((f) => resolvedStrategies.get(f) === 'llm');
    const hybridFields = fields.filter((f) => resolvedStrategies.get(f) === 'hybrid');

    // Pattern-only fields: extract with regex, skip LLM entirely
    const patternResults: Record<string, unknown> = {};
    if (patternOnlyFields.length > 0) {
      const regexResult = extractEntitiesForFields(
        extractionMessage,
        patternOnlyFields,
        undefined,
        fieldTypes,
        locale,
        dateExtractionOptions,
      );
      Object.assign(patternResults, regexResult);
    }

    // If ALL fields are pattern-only, return immediately without calling LLM
    if (llmOnlyFields.length === 0 && hybridFields.length === 0) {
      // Emit extraction_attempt decision trace for pattern-only extraction
      if (emitDecisionTrace) {
        const matched = patternOnlyFields.filter((f) => patternResults[f] !== undefined);
        const missed = patternOnlyFields.filter((f) => patternResults[f] === undefined);
        onTraceEvent!({
          type: 'extraction_attempt',
          data: {
            method: 'pattern',
            fields: patternOnlyFields,
            matched,
            missed,
          },
        });
      }

      if (onTraceEvent) {
        const extractedFields = Object.keys(patternResults).filter(
          (k) => patternResults[k] !== undefined,
        );
        const missingFields = fields.filter((f) => patternResults[f] === undefined);
        onTraceEvent({
          type: 'entity_extraction',
          data: {
            agentName: session.agentName,
            stepName: session.currentFlowStep,
            userMessage,
            ...extractionTraceInput,
            requestedFields: fields,
            extractedFields,
            missingFields,
            values: patternResults,
            method: 'pattern',
          },
        });
      }

      emitDecisionEvent(onTraceEvent, session.traceVerbosity, 'gather_extraction', {
        outcome: `${Object.keys(patternResults).join(', ')} (${Object.keys(patternResults).length} extracted)`,
        matched: Object.keys(patternResults).length > 0,
        trigger: { strategy: 'pattern', fieldsRequested: fields },
      });

      return patternResults;
    }

    // =========================================================================
    // Tier 1: JS libs (chrono-node, libphonenumber-js) for date/phone fields
    // =========================================================================
    // Read the project-level extraction strategy from the IR
    const projectStrategy: ExtractionStrategy =
      session.agentIR?.project_runtime_config?.extraction_strategy ?? 'auto';
    const enableJSLibs = projectStrategy !== 'llm' && projectStrategy !== 'pattern';
    const nluProvider: string = session.agentIR?.project_runtime_config?.nlu_provider ?? 'standard';
    let enableSidecar =
      nluProvider === 'advanced' && projectStrategy !== 'llm' && projectStrategy !== 'pattern';

    // Runtime safety net: downgrade non-enterprise tenants
    if (enableSidecar && session.tenantId) {
      try {
        const { resolveAdvancedNluEntitlement } = await import('@agent-platform/project-io/import');
        const entitlement = await resolveAdvancedNluEntitlement(session.tenantId);
        if (!entitlement.allowed) {
          log.warn('Tenant is not entitled to advanced NLU, downgrading to standard', {
            tenantId: session.tenantId,
            agent: session.agentName,
          });
          enableSidecar = false;
        }
      } catch {
        // Config resolution failed — default to safe (no sidecar)
        enableSidecar = false;
      }
    }

    const enableLLM = projectStrategy !== 'ml' && projectStrategy !== 'pattern';

    // Fields that are candidates for pre-LLM extraction tiers (Tier 1 JS libs, Tier 2 sidecar).
    // llm-only fields skip Tier 1/2 entirely — they go directly to Tier 3 (LLM).
    const preLLMFields = [...hybridFields];
    const tier1Results: Record<string, unknown> = {};

    if (enableJSLibs && preLLMFields.length > 0) {
      // Build field descriptors with type info for Tier 1
      const jsFields = preLLMFields
        .map((fieldName) => {
          const gf = gatherFields?.find((f) => f.name === fieldName);
          return { name: fieldName, type: gf?.type ?? '' };
        })
        .filter((f) => isJSExtractableType(f.type));

      if (jsFields.length > 0) {
        const jsResults = extractWithJSLibs(
          extractionMessage,
          jsFields,
          locale,
          dateExtractionOptions,
        );
        Object.assign(tier1Results, jsResults);

        if (emitDecisionTrace) {
          const matched = Object.keys(jsResults).filter((k) => jsResults[k] !== undefined);
          const missed = jsFields.map((f) => f.name).filter((n) => jsResults[n] === undefined);
          onTraceEvent!({
            type: 'extraction_attempt',
            data: {
              method: 'js_libs',
              tier: 1,
              fields: jsFields.map((f) => f.name),
              matched,
              missed,
            },
          });
        }
      }
    }

    // =========================================================================
    // Tier 2: NLU sidecar (Python ML service) for remaining fields
    // =========================================================================
    const tier1FilledFields = new Set(
      Object.keys(tier1Results).filter((k) => tier1Results[k] !== undefined),
    );
    const tier2CandidateFields = preLLMFields.filter((f) => !tier1FilledFields.has(f));
    const tier2Results: Record<string, unknown> = {};

    if (enableSidecar && tier2CandidateFields.length > 0 && session._nluSidecarClient) {
      const sidecarCallContext = buildSidecarCallContext(session);
      if (!sidecarCallContext) {
        log.debug('Skipping NLU sidecar extraction because tenancy context is incomplete', {
          agentName: session.agentName,
          sessionId: session.id,
          hasTenantId: Boolean(session.tenantId),
          hasProjectId: Boolean(session.projectId),
        });

        if (emitDecisionTrace) {
          onTraceEvent!({
            type: 'extraction_attempt',
            data: {
              method: 'nlu_sidecar',
              tier: 2,
              fields: tier2CandidateFields,
              matched: [],
              missed: tier2CandidateFields,
              skipped: 'missing_tenancy_context',
            },
          });
        }
      } else {
        try {
          const locale = getCurrentInteractionLocale(session.data, 'en') ?? 'en';
          const sidecarFields: SidecarExtractionField[] = tier2CandidateFields.map((fieldName) => {
            const gf = gatherFields?.find((f) => f.name === fieldName);
            return {
              name: fieldName,
              type: gf?.type ?? 'string',
              hints: gf?.extraction_hints ?? [],
            };
          });

          const sidecarResult = await session._nluSidecarClient.extract(
            {
              text: extractionMessage,
              fields: sidecarFields,
              locale,
            },
            sidecarCallContext,
          );

          let sidecarConfidence: Record<string, number> | undefined;
          if (sidecarResult.ok) {
            Object.assign(tier2Results, sidecarResult.value.entities);
            sidecarConfidence = sidecarResult.value.confidence;
          } else {
            log.debug('NLU sidecar extraction returned err, falling through to LLM', {
              kind: sidecarResult.error.kind,
              code: sidecarResult.error.code,
              message: sidecarResult.error.message,
            });
          }

          if (emitDecisionTrace) {
            const matched = Object.keys(tier2Results).filter((k) => tier2Results[k] !== undefined);
            const missed = tier2CandidateFields.filter((n) => tier2Results[n] === undefined);
            onTraceEvent!({
              type: 'extraction_attempt',
              data: {
                method: 'nlu_sidecar',
                tier: 2,
                fields: tier2CandidateFields,
                matched,
                missed,
                confidence: sidecarConfidence,
                sidecarError: sidecarResult.ok
                  ? undefined
                  : { kind: sidecarResult.error.kind, code: sidecarResult.error.code },
              },
            });
          }
        } catch (err) {
          log.debug('NLU sidecar extraction threw unexpectedly, falling through to LLM', {
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    }

    // Merge Tier 1 + Tier 2 results and compute remaining unfilled fields for LLM.
    // Tier 1 (JS libs) produces higher-quality results for supported types
    // (E.164 phone numbers, ISO dates). Tier 1 takes priority over Tier 2.
    const preLLMResults: Record<string, unknown> = { ...tier2Results, ...tier1Results };
    const preLLMFilledFields = new Set(
      Object.keys(preLLMResults).filter((k) => preLLMResults[k] !== undefined),
    );

    // For 'ml' strategy: return Tier 1 + Tier 2 results without LLM
    if (!enableLLM) {
      const result = { ...patternResults, ...preLLMResults };
      if (onTraceEvent) {
        const extractedFields = Object.keys(result).filter((k) => result[k] !== undefined);
        const missingFields = fields.filter((f) => result[f] === undefined);
        onTraceEvent({
          type: 'entity_extraction',
          data: {
            agentName: session.agentName,
            stepName: session.currentFlowStep,
            userMessage,
            ...extractionTraceInput,
            requestedFields: fields,
            extractedFields,
            missingFields,
            values: result,
            method: 'ml_only',
            projectStrategy,
          },
        });
      }
      return result;
    }

    // LLM candidates: llm-only fields (never pre-filled) + hybrid fields not filled by Tier 1/2
    const llmCandidateFields = [
      ...llmOnlyFields,
      ...preLLMFields.filter((f) => !preLLMFilledFields.has(f)),
    ];

    // If all pre-LLM fields were satisfied, merge and return without LLM call
    if (llmCandidateFields.length === 0) {
      const result = { ...patternResults, ...preLLMResults };
      if (onTraceEvent) {
        const extractedFields = Object.keys(result).filter((k) => result[k] !== undefined);
        const missingFields = fields.filter((f) => result[f] === undefined);
        onTraceEvent({
          type: 'entity_extraction',
          data: {
            agentName: session.agentName,
            stepName: session.currentFlowStep,
            userMessage,
            ...extractionTraceInput,
            requestedFields: fields,
            extractedFields,
            missingFields,
            values: result,
            method: 'js_libs_and_sidecar',
            projectStrategy,
          },
        });
      }
      return result;
    }

    // =========================================================================
    // Tier 3: LLM extraction for remaining unfilled fields
    // =========================================================================

    // Merge agent-level and project-level lookup tables once for all downstream consumers.
    // LookupTableConflictError propagates to the caller (executeFlowStep) which can
    // surface it to the user via onChunk.
    const mergedLookup: Record<string, LookupTableIR> = mergeLookupTables(
      session.agentIR?.lookup_tables,
      session._projectRuntimeConfig,
    );

    // Get current context to help LLM understand references like "same", "already given".
    // Only include gather field values — never leak internal session state (tenant IDs,
    // session objects, intent classifier output) into the extraction prompt.
    const gatherKeySet = new Set(gatherFields?.map((g) => g.name) ?? []);
    const contextSummary = Object.entries(session.data.values)
      .filter(([key]) => gatherKeySet.has(key))
      .map(([key, value]) => `${key}: ${JSON.stringify(value)}`)
      .join('\n');

    // Build field descriptions for the LLM from LLM-candidate fields + GATHER metadata
    const gatherFieldNames = gatherFields?.map((g) => g.name) || [];
    const allFieldNames = new Set([
      ...llmCandidateFields,
      ...gatherFieldNames.filter((n) => !patternOnlyFields.includes(n)),
    ]);

    const fieldDescriptions = Array.from(allFieldNames)
      .map((field) => {
        const isExtractionCandidate = llmCandidateFields.includes(field);
        const prefix = isExtractionCandidate ? '(extract if stated) ' : '(already resolved) ';

        // Build description from GATHER field metadata (IR-driven)
        const gatherField = gatherFields?.find((f) => f.name === field);
        let desc: string;
        if (gatherField) {
          const parts = [`"${field}"`];
          if (gatherField.type && gatherField.type !== 'string')
            parts.push(`(${gatherField.type})`);
          if (gatherField.prompt) parts.push(`- ${gatherField.prompt}`);
          else if (gatherField.extraction_hints) parts.push(`- ${gatherField.extraction_hints}`);
          else parts.push(`- the ${field.replace(/_/g, ' ')}`);
          desc = `${prefix}${parts.join(' ')}`;
        } else {
          desc = `${prefix}"${field}": the ${field.replace(/_/g, ' ')}`;
        }

        // Append validation hints from gatherFields if available
        if (gatherField?.validation) {
          switch (gatherField.validation.type) {
            case 'pattern':
              desc += ` [must match pattern: ${gatherField.validation.rule}]`;
              break;
            case 'range':
              desc += ` [valid range: ${gatherField.validation.rule}]`;
              break;
            case 'enum':
              desc += ` [allowed values: ${gatherField.validation.rule.split('|').join(', ')}]`;
              break;
          }
        }

        // GAP-3: Append lookup table values as prompt hints
        if (gatherField?.semantics?.lookup && Object.keys(mergedLookup).length > 0) {
          const table = mergedLookup[gatherField.semantics.lookup];
          if (table) {
            const lookupValues = resolveLookupValuesForPrompt(table);
            if (lookupValues && !gatherField.validation?.type?.includes('enum')) {
              if (lookupValues.length <= LOOKUP_ENUM_INJECTION_MAX) {
                desc += ` [allowed values: ${lookupValues.join(', ')}]`;
              } else {
                const sample = lookupValues.slice(0, LOOKUP_HINT_SAMPLE_SIZE).join(', ');
                desc += ` [valid values include: ${sample}, ... (${lookupValues.length} total)]`;
              }
            }
          }
        }

        // Append GATHER options as allowed values hint
        const gfOptions =
          (gatherField as Record<string, unknown> | undefined)?.options ??
          (gatherField as Record<string, unknown> | undefined)?.enum_values;
        if (
          Array.isArray(gfOptions) &&
          gfOptions.length > 0 &&
          !gatherField?.validation?.type?.includes('enum')
        ) {
          desc += ` [allowed values: ${(gfOptions as string[]).join(', ')}]`;
        }

        // GAP-32: Append synonyms so the LLM can map user language to canonical values
        const gfSynonyms = (gatherField as Record<string, unknown> | undefined)?.synonyms as
          | Record<string, string[]>
          | undefined;
        if (gfSynonyms && Object.keys(gfSynonyms).length > 0) {
          const synonymHints = Object.entries(gfSynonyms)
            .map(([canonical, aliases]) => `${canonical} (${aliases.join(', ')})`)
            .join('; ');
          desc += ` [synonyms: ${synonymHints}]`;
        }

        // Defaults stay out of extraction prompts. The extractor should only
        // return user-explicit values or referenced prior values from context.
        // Append semantic extraction hints from field metadata (semantics, range, list, preferences)
        if (gatherField) {
          const semanticHint = buildSemanticHint(gatherField);
          if (semanticHint) {
            desc += ` ${semanticHint}`;
          }
        }

        return desc;
      })
      .join('\n');

    // Build context section if we have existing data
    const contextSection = contextSummary
      ? `\nALREADY COLLECTED (use these if user says "same", "already given", or refers to previous values):\n${contextSummary}\n`
      : '';

    // Derive agent language: prefer runtime locale override, fall back to
    // the DSL LANGUAGE: directive compiled into AgentIdentity.
    const agentLanguage =
      getCurrentInteractionLanguage(session.data) ||
      getCurrentInteractionLocale(session.data) ||
      session.agentIR?.identity?.language ||
      '';

    // Resolve conversation history window for coreference resolution context.
    // conversation_history_window is an extension field not yet in the ExecutionConfig schema,
    // so we access it via a typed cast.
    const configuredWindow = (session.agentIR?.execution as Record<string, unknown> | undefined)
      ?.conversation_history_window;
    const historyWindow = typeof configuredWindow === 'number' ? configuredWindow : 2;
    const conversationContext = formatConversationContext(
      session.conversationHistory,
      historyWindow,
      userMessage,
    );

    const systemPrompt = interpolateTemplate(
      session.promptOverrides?.['llm_prompt.entity_extraction'] ??
        promptTemplateLoader.getLLMPrompt('entity_extraction'),
      {
        contextSection,
        today: getPromptToday(session),
        fieldDescriptions,
        agentLanguage: agentLanguage !== 'en' ? agentLanguage : '',
        conversationContext,
      },
    );

    try {
      const startTime = Date.now();

      // Build structured extraction tool from gather field metadata
      const extractionTool = FlowStepExecutor.buildExtractionTool(
        (gatherFields || []).filter((gf) => !patternOnlyFields.includes(gf.name)),
        mergedLookup,
      );

      const response = await session.llmClient!.chatWithToolUse(
        systemPrompt,
        [{ role: 'user', content: extractionMessage }],
        [extractionTool],
        'extraction',
        { toolChoice: { type: 'tool', name: '_extract_entities' } },
      );

      const durationMs = Date.now() - startTime;

      // Log trace event for LLM call
      if (onTraceEvent) {
        const extractionInputTokens = response.usage?.inputTokens || 0;
        const extractionOutputTokens = response.usage?.outputTokens || 0;
        onTraceEvent({
          type: 'llm_call',
          data: {
            purpose: 'entity_extraction',
            operationType: 'extraction',
            agent: session.agentName,
            responseContribution: 'internal_only',
            model: response.resolvedModel?.modelId || TRACE_MODEL_UNKNOWN,
            provider: response.resolvedModel?.provider,
            source: response.resolvedModel?.source,
            input: userMessage,
            ...extractionTraceInput,
            fields: fields,
            durationMs,
            usage: response.usage,
            // Flat token fields for direct bridge access
            tokensIn: extractionInputTokens,
            tokensOut: extractionOutputTokens,
            totalTokens: extractionInputTokens + extractionOutputTokens,
            stopReason: response.stopReason,
            systemPrompt,
            tools: [
              {
                name: extractionTool.name,
                description: extractionTool.description,
                input_schema: extractionTool.input_schema,
              },
            ],
            messages: [{ role: 'user', content: extractionMessage }],
            response: response.text?.slice(0, 2000) || '',
            toolCalls: response.toolCalls.map((tc) => ({
              id: tc.id,
              name: tc.name,
              input: tc.input,
            })),
            extractionMethod: response.toolCalls.length > 0 ? 'tool_call' : 'text_fallback',
            toolChoice: { type: 'tool', name: '_extract_entities' },
            cost: (() => {
              const mid = response.resolvedModel?.modelId || TRACE_MODEL_UNKNOWN;
              if (
                mid !== TRACE_MODEL_UNKNOWN &&
                hasKnownPricing(mid) &&
                (extractionInputTokens > 0 || extractionOutputTokens > 0)
              ) {
                const caps = getModelCapabilities(mid);
                return calculateCost(
                  caps.inputCostPer1k,
                  caps.outputCostPer1k,
                  extractionInputTokens,
                  extractionOutputTokens,
                );
              }
              return undefined;
            })(),
          },
        });
      }

      // Extract parsed entities from tool call result (structured) or fall back to text parsing
      let parsed: Record<string, unknown> = {};
      if (response.toolCalls.length > 0 && response.toolCalls[0].name === '_extract_entities') {
        parsed = response.toolCalls[0].input as Record<string, unknown>;
      } else if (response.text) {
        // Fallback: if LLM didn't use the tool, try parsing raw text response
        try {
          parsed = JSON.parse(response.text);
        } catch {
          const jsonMatch =
            response.text.match(/```(?:json)?\s*([\s\S]*?)```/) ||
            response.text.match(/\{[\s\S]*\}/);
          if (jsonMatch) {
            try {
              parsed = JSON.parse(jsonMatch[1] || jsonMatch[0]);
            } catch {
              /* not valid JSON */
            }
          }
        }
        if (emitDecisionTrace) {
          onTraceEvent!({
            type: 'extraction_parse_fallback',
            data: {
              toolCallUsed: false,
              responsePreview: response.text.slice(0, 200),
            },
          });
        }
      }

      log.debug('LLM entity extraction complete', {
        request: {
          systemPrompt,
          messages: [{ role: 'user', content: extractionMessage }],
          tools: [extractionTool],
          toolChoice: 'auto',
        },
        response: {
          text: response.text,
          toolCalls: response.toolCalls,
          stopReason: response.stopReason,
          usage: response.usage,
          model: response.resolvedModel?.modelId,
          provider: response.resolvedModel?.provider,
        },
        parsed,
        method: response.toolCalls.length > 0 ? 'tool_call' : 'text_fallback',
      });

      // Unwrap model nesting quirk: some models wrap tool args inside the tool
      // name, e.g. {_extract_entities: {device_type: "Mac", ...}} instead of
      // {device_type: "Mac", ...}. Detect and flatten.
      if (
        Object.keys(parsed).length === 1 &&
        parsed['_extract_entities'] &&
        typeof parsed['_extract_entities'] === 'object' &&
        !Array.isArray(parsed['_extract_entities'])
      ) {
        parsed = parsed['_extract_entities'] as Record<string, unknown>;
      }

      // Start with pattern results + pre-LLM tier results + LLM extracted fields
      const result: Record<string, unknown> = { ...patternResults, ...preLLMResults, ...parsed };

      // Validate extracted values against gatherFields validation rules
      const validationErrors: Record<string, string> = {};
      if (gatherFields) {
        for (const gf of gatherFields) {
          if (gf.validation && result[gf.name] !== undefined && result[gf.name] !== null) {
            const error = validateField(result[gf.name], gf.validation);
            if (error) {
              validationErrors[gf.name] = error;
              delete result[gf.name]; // Remove invalid value
            }
            emitDecisionEvent(onTraceEvent, session.traceVerbosity, 'field_validation', {
              outcome: error ? 'fail' : 'pass',
              matched: !error,
              field: gf.name,
              violation: error ?? undefined,
              trigger: { valuePresent: result[gf.name] !== undefined, rule: gf.validation?.type },
            });
          }
        }
      }

      // Pass 2: Async LLM validation (for validation rules with type: 'llm')
      if (gatherFields && session.llmClient) {
        const llmErrors = await validateFieldsWithLLM(
          result,
          gatherFields,
          session.llmClient,
          onTraceEvent,
          session.promptOverrides?.['llm_prompt.field_validation'],
          session.agentName,
        );
        for (const [field, error] of Object.entries(llmErrors)) {
          validationErrors[field] = error;
          delete result[field];
        }
      }

      // Track validation retry state on the session
      const failedFieldNames = Object.keys(validationErrors);
      if (failedFieldNames.length > 0) {
        // Increment per-field retry counts
        const retries = (session.data.values._validation_retries as Record<string, number>) || {};
        for (const fieldName of failedFieldNames) {
          retries[fieldName] = (retries[fieldName] || 0) + 1;
        }
        session.data.values._validation_retries = retries;

        // Store retry_prompt values from validation rules for failed fields
        if (gatherFields) {
          const retryPrompts: Record<string, string> = {};
          for (const fieldName of failedFieldNames) {
            const gf = gatherFields.find((f) => f.name === fieldName);
            if (gf?.validation?.retry_prompt) {
              retryPrompts[fieldName] = gf.validation.retry_prompt;
            }
          }
          if (Object.keys(retryPrompts).length > 0) {
            session.data.values._validation_retry_prompts = retryPrompts;
          }
        }

        // Check max_retries enforcement
        if (gatherFields) {
          for (const fieldName of failedFieldNames) {
            const gf = gatherFields.find((f) => f.name === fieldName);
            const maxRetries = gf?.validation?.max_retries;
            if (maxRetries !== undefined && retries[fieldName] >= maxRetries) {
              const exceeded = (session.data.values._validation_exceeded as string[]) || [];
              if (!exceeded.includes(fieldName)) {
                exceeded.push(fieldName);
              }
              session.data.values._validation_exceeded = exceeded;

              if (onTraceEvent) {
                onTraceEvent({
                  type: 'validation_max_retries',
                  data: {
                    agentName: session.agentName,
                    stepName: session.currentFlowStep,
                    field: fieldName,
                    attempts: retries[fieldName],
                    maxRetries,
                  },
                });
              }

              // Route validation_error through ON_ERROR handler chain
              if (session.agentIR) {
                const validationErrCtx: ErrorContext = {
                  type: 'validation_error',
                  subtype: 'max_retries_exceeded',
                  message: `Field "${fieldName}" failed validation after ${retries[fieldName]} attempts`,
                  retryable: false,
                  stepName: session.currentFlowStep || undefined,
                };
                const resolution = resolveErrorHandler(validationErrCtx, session.agentIR);
                if (resolution) {
                  onTraceEvent?.({
                    type: 'agent_error_handled',
                    data: {
                      errorType: validationErrCtx.type,
                      subtype: validationErrCtx.subtype,
                      message: validationErrCtx.message,
                      action: resolution.action,
                      handler: resolution.handler.type,
                      field: fieldName,
                      agent: session.agentName,
                    },
                  });
                }
              }
            }
          }
        }
      } else {
        // No validation errors — clear stale retry prompt data
        delete session.data.values._validation_retry_prompts;
      }

      // Emit entity extraction trace event
      if (onTraceEvent) {
        const extractedFields = Object.keys(result).filter((k) => result[k] !== undefined);
        const missingFields = fields.filter((f) => result[f] === undefined);
        onTraceEvent({
          type: 'entity_extraction',
          data: {
            agentName: session.agentName,
            stepName: session.currentFlowStep,
            userMessage,
            ...extractionTraceInput,
            requestedFields: fields,
            extractedFields,
            missingFields,
            values: result,
            method: 'llm',
            durationMs,
            ...(Object.keys(validationErrors).length > 0 ? { validationErrors } : {}),
          },
        });
      }

      emitDecisionEvent(onTraceEvent, session.traceVerbosity, 'gather_extraction', {
        outcome: `${Object.keys(result).join(', ')} (${Object.keys(result).length} extracted)`,
        matched: Object.keys(result).length > 0,
        trigger: { strategy: gatherBlockStrategy ?? 'hybrid', fieldsRequested: fields },
      });

      return result;
    } catch (error) {
      log.error('LLM extraction failed, using fallback', {
        error: error instanceof Error ? error.message : String(error),
      });
      // Fall back to regex-based extraction for hybrid fields only.
      // LLM-only fields get no fallback (they stay missing).
      // Pattern-only fields were already extracted above.
      const fallbackFields = hybridFields;
      const regexFallback =
        fallbackFields.length > 0
          ? extractEntitiesForFields(
              extractionMessage,
              fallbackFields,
              undefined,
              fieldTypes,
              locale,
              dateExtractionOptions,
            )
          : {};
      const result = { ...patternResults, ...preLLMResults, ...regexFallback };

      // Emit extraction_fallback decision trace for hybrid fields falling back to pattern
      if (emitDecisionTrace && fallbackFields.length > 0) {
        onTraceEvent!({
          type: 'extraction_fallback',
          data: {
            fields: fallbackFields,
            from: 'llm',
            to: 'pattern',
            reason: 'llm_error',
            error: error instanceof Error ? error.message : String(error),
          },
        });
      }

      // Emit entity extraction trace event for fallback
      if (onTraceEvent) {
        const extractedFields = Object.keys(result).filter((k) => result[k] !== undefined);
        const missingFields = fields.filter((f) => result[f] === undefined);
        onTraceEvent({
          type: 'entity_extraction',
          data: {
            agentName: session.agentName,
            stepName: session.currentFlowStep,
            userMessage,
            ...extractionTraceInput,
            requestedFields: fields,
            extractedFields,
            missingFields,
            values: result,
            method: 'regex_fallback',
            error: String(error),
          },
        });
      }

      return result;
    }
  }

  private async extractStepGatherValuesBeforeReasoning(
    session: RuntimeSession,
    step: FlowStep,
    stepName: string,
    currentMessage: string,
    onTraceEvent?: (event: { type: string; data: Record<string, unknown> }) => void,
  ): Promise<void> {
    if (!step.gather?.fields?.length) {
      return;
    }

    const fieldsToExtract = getUnsetStepGatherFieldNames(step, session.data.values);
    if (fieldsToExtract.length === 0) {
      return;
    }

    if (shouldSkipExtraction(currentMessage)) {
      onTraceEvent?.({
        type: 'dsl_collect',
        data: {
          agentName: session.agentName,
          stepName,
          mode: 'gather_pre_reasoning',
          fields: fieldsToExtract,
          userInput: currentMessage,
          skipped: true,
          reason: 'trivial_input',
        },
      });
      return;
    }

    const rawExtracted = await this.extractEntitiesWithLLM(
      currentMessage,
      fieldsToExtract,
      session,
      onTraceEvent,
      step.gather.fields,
      step.gather.strategy,
    );

    const { valid: extractedData } = validateExtractedBatch(
      step.gather.fields,
      rawExtracted,
      getDateNormalizationOptions(session),
    );
    const meaningfulData = Object.fromEntries(
      Object.entries(extractedData).filter(
        ([, value]) => value !== undefined && value !== null && value !== '',
      ),
    );

    if (Object.keys(meaningfulData).length > 0) {
      setGatheredValues(session, meaningfulData);

      try {
        await evaluateRememberAfterStateChange(session, onTraceEvent);
        await executeRecallAfterExtraction(session, Object.keys(meaningfulData), onTraceEvent);
        await detectAndStorePreferences(
          session,
          currentMessage,
          Object.keys(meaningfulData),
          onTraceEvent,
        );
      } catch (err) {
        log.warn('memory operations failed after pre-reasoning gather extraction', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    onTraceEvent?.({
      type: 'dsl_collect',
      data: {
        agentName: session.agentName,
        stepName,
        mode: 'gather_pre_reasoning',
        fields: fieldsToExtract,
        userInput: currentMessage,
        extracted: meaningfulData,
        context: { ...session.data.values },
      },
    });
  }

  /**
   * Execute a flow step — the core scripted flow engine.
   *
   * Uses an iterative while loop instead of recursion to avoid stack
   * overflows on loop-back flows. Each former recursive call site sets
   * `currentMessage` and `continue`s to re-enter the loop.
   *
   * Handles: COLLECT, GATHER, ON_INPUT, digressions, sub-intents,
   * corrections, CALL, ON_SUCCESS/ON_FAILURE, THEN, loop detection,
   * and auto-advancement.
   */
  async executeFlowStep(
    session: RuntimeSession,
    userMessage: string,
    onChunk?: (chunk: string) => void,
    onTraceEvent?: (event: { type: string; data: Record<string, unknown> }) => void,
    options?: {
      suppressParentSupervisorRoute?: boolean;
      suppressEmptyReasoningZoneExecution?: boolean;
    },
  ): Promise<ExecutionResult> {
    const ir = session.agentIR;
    if (!ir?.flow) {
      throw new AppError('No flow configuration for agent', { ...ErrorCodes.INTERNAL_ERROR });
    }

    await refreshSessionPIIContext(session);

    // NOTE: User message is already pushed by executeMessage() (line 1560).
    // Do NOT push here — it creates duplicate user messages and pushes empty strings
    // from auto-advance transitions and initializeSession().

    let currentMessage = userMessage;
    const visited = new Set<string>();
    const MAX_CHAIN_ITERATIONS = 100;
    let iterations = 0;
    let lastResult: ExecutionResult = { response: '', action: { type: 'flow' } };
    const rootTraceEvent = onTraceEvent;

    while (iterations < MAX_CHAIN_ITERATIONS) {
      iterations++;
      onTraceEvent = rootTraceEvent;

      // ======================================================================
      // MINI-COLLECT RESUME: If we're in a constraint-collect state, handle
      // the user's response before normal step processing.
      // ======================================================================
      if (session.constraintCollectState && currentMessage) {
        const collectResult = await this.executeMiniCollect(
          session,
          currentMessage,
          onChunk,
          onTraceEvent,
        );
        if (collectResult.action === 'escalate') {
          const conditionDesc = collectResult.constraintCondition;
          session.isEscalated = true;
          session.escalationReason = `Constraint still violated after collection: ${conditionDesc}`;
          const msg = `Escalated to human agent. Reason: ${session.escalationReason}`;
          const protectedMessage = emitProtectedAssistantText(session, msg, onChunk);
          lastResult = {
            response: protectedMessage.deliveryText,
            action: { type: 'escalate', reason: session.escalationReason },
          };
          break;
        }
        if (collectResult.action === 'goto') {
          const transitionResult = await this.transitionToFlowTarget(
            session,
            collectResult.nextStep,
            {
              currentStep: session.currentFlowStep ?? '',
              currentMessage,
              onChunk,
              onTraceEvent,
            },
          );
          if (transitionResult.outcome === 'terminal') {
            lastResult = transitionResult.result;
            break;
          }
          currentMessage = '';
          continue;
        }
        if (collectResult.action === 'retry') {
          // Re-run the current step with empty message
          currentMessage = '';
          continue;
        }
        // 'continue' — fall through to normal step execution
      }

      // ======================================================================
      // QUEUED INTENT CONFIRMATION: If the user is responding to a surfaced
      // queued intent prompt, handle yes/no before normal step processing.
      // ======================================================================
      if (
        session.waitingForInput?.includes('_queued_intent_confirmation_') &&
        currentMessage &&
        session.intentQueue?.pending?.length
      ) {
        const affirmative = /^(yes|sure|ok|please|yeah|go ahead|yep|y)\b/i.test(
          currentMessage.trim(),
        );

        if (affirmative) {
          const nextIntent = dequeueNext(session.intentQueue);
          if (nextIntent) {
            const nextIntentKey =
              nextIntent.target?.kind === 'flow_step' ? nextIntent.target.ref : nextIntent.intent;
            const nextIntentSourceStep = nextIntent.sourceStep ?? session.currentFlowStep;
            session.waitingForInput = undefined;

            if (onTraceEvent) {
              onTraceEvent({
                type: 'multi_intent_queue_accepted',
                data: {
                  agent: session.agentName,
                  intent: nextIntentKey,
                  label: getPendingIntentDisplayLabel(nextIntent),
                  confidence: nextIntent.confidence,
                  originalMessage: nextIntent.original_message,
                  remainingCount: session.intentQueue.pending.length,
                },
              });
            }

            // Route the dequeued intent by resetting completion state
            session.isComplete = false;
            session.state.conversationPhase = 'active';

            log.debug('User accepted queued intent, re-routing', {
              agent: session.agentName,
              intent: nextIntentKey,
            });

            const stepName = session.currentFlowStep!;
            const applied = await this.continueWithTargetedOnInputBranch(
              session,
              nextIntentSourceStep ?? stepName,
              nextIntent.original_message,
              nextIntentKey,
              onChunk,
              onTraceEvent,
            );
            if (applied.outcome === 'break') {
              lastResult = applied.lastResult!;
              break;
            }
            if (applied.outcome === 'transition') {
              currentMessage = '';
              continue;
            }

            // Fallback: set pinned intent and re-loop for standard processing
            currentMessage = nextIntent.original_message;
            if (nextIntentSourceStep) {
              session.currentFlowStep = nextIntentSourceStep;
            }
            session._pinnedIntent = nextIntentKey;
            continue;
          }
        } else {
          // User declined — remove the front intent and clear confirmation wait
          session.intentQueue.pending.shift();
          session.waitingForInput = undefined;

          if (onTraceEvent) {
            onTraceEvent({
              type: 'multi_intent_queue_declined',
              data: {
                agent: session.agentName,
                remainingCount: session.intentQueue.pending.length,
              },
            });
          }

          // If there are more queued intents, surface the next one
          if (session.intentQueue.pending.length > 0) {
            const nextAfterDecline = peekNext(session.intentQueue);
            if (nextAfterDecline) {
              const intentLabel = getPendingIntentDisplayLabel(nextAfterDecline);
              const surfaceMessage = resolveLocalizedAgentMessageWithMetadata({
                session,
                messageKey: 'multi_intent_queued_notice',
                fallbackMessage:
                  session.agentIR?.messages?.multi_intent_queued_notice ||
                  DEFAULT_MESSAGES.multi_intent_queued_notice,
              });
              const noticeText = renderQueuedIntentNoticeMessage({
                intentLabel,
                resolveMessage: buildLocalizedMessageResolver(session),
                noticeFallback: surfaceMessage.text,
              });

              const protectedNotice = emitProtectedAssistantText(session, noticeText, onChunk);
              session.waitingForInput = ['_queued_intent_confirmation_'];

              lastResult = {
                response: protectedNotice.deliveryText,
                localization: surfaceMessage.localization,
                action: { type: 'queued_intent_prompt' },
              };
              break;
            }
          }

          // No more queued intents — treat the user's message as a new input
          // and fall through to normal step processing
        }
      }

      // ======================================================================
      // INFERENCE CONFIRMATION: If the user is responding to an inference
      // confirmation prompt, handle yes/no before normal step processing.
      // ======================================================================
      if (
        session.waitingForInput?.includes('_inference_confirmation_') &&
        currentMessage &&
        session.data.values._pending_inferences
      ) {
        const affirmative = /^(yes|sure|ok|please|yeah|go ahead|yep|y)\b/i.test(
          currentMessage.trim(),
        );
        const pending = session.data.values._pending_inferences as Record<string, unknown>;

        if (affirmative) {
          // Apply the pending inferences
          for (const [field, value] of Object.entries(pending)) {
            session.data.values[field] = value;
          }
          if (onTraceEvent) {
            onTraceEvent({
              type: 'inference_accepted',
              data: {
                agent: session.agentName,
                fields: Object.keys(pending),
              },
            });
          }
        } else {
          // Discard — remove inferred metadata too
          const inferredMeta = session.data.values._inferred as Record<string, unknown> | undefined;
          if (inferredMeta) {
            for (const field of Object.keys(pending)) {
              delete inferredMeta[field];
            }
          }
          if (onTraceEvent) {
            onTraceEvent({
              type: 'inference_rejected',
              data: {
                agent: session.agentName,
                fields: Object.keys(pending),
                userResponse: currentMessage.trim().slice(0, 100),
              },
            });
          }
        }

        delete session.data.values._pending_inferences;
        session.waitingForInput = undefined;
        // Continue loop — normal step processing will re-evaluate gather state
        continue;
      }

      // ======================================================================
      // FUZZY MATCH CONFIRMATION: If the user is responding to a fuzzy
      // lookup confirmation, apply or discard the suggested values.
      // ======================================================================
      if (
        session.waitingForInput?.includes('_fuzzy_confirmation_') &&
        currentMessage &&
        session.data.values._pending_fuzzy
      ) {
        const affirmative = /^(yes|sure|ok|please|yeah|go ahead|yep|y|correct)\b/i.test(
          currentMessage.trim(),
        );
        const pending = session.data.values._pending_fuzzy as Record<
          string,
          { suggested: string; similarity: number }
        >;

        if (affirmative) {
          for (const [field, match] of Object.entries(pending)) {
            session.data.values[field] = match.suggested;
          }
          if (onTraceEvent) {
            onTraceEvent({
              type: 'lookup_fuzzy_accepted',
              data: { agent: session.agentName, fields: Object.keys(pending) },
            });
          }
        } else {
          // Clear the fuzzy-matched values so they're re-prompted
          for (const field of Object.keys(pending)) {
            delete session.data.values[field];
          }
          if (onTraceEvent) {
            onTraceEvent({
              type: 'lookup_fuzzy_rejected',
              data: { agent: session.agentName, fields: Object.keys(pending) },
            });
          }
        }
        delete session.data.values._pending_fuzzy;
        session.waitingForInput = undefined;
        continue;
      }

      // ======================================================================
      // DISAMBIGUATION CHOICE: If the user is choosing from disambiguated
      // intents, parse their choice and route to the selected intent.
      // ======================================================================
      if (
        session.waitingForInput?.includes('_disambiguation_choice') &&
        currentMessage &&
        session.data.values._disambiguation_intents
      ) {
        const structuredChoices = session.data.values._disambiguation_choices as
          | MultiIntentDisambiguationChoice[]
          | undefined;
        const intents = structuredChoices?.length
          ? structuredChoices.map((choice) => choice.label)
          : (session.data.values._disambiguation_intents as string[]);
        const choice = parseDisambiguationChoice(currentMessage, intents);

        if (choice) {
          const selectedChoice = structuredChoices?.[choice.index];
          const chosenIntent = selectedChoice?.intent ?? choice.intent;
          const chosenTarget =
            selectedChoice?.target?.kind === 'flow_step' ? selectedChoice.target.ref : chosenIntent;
          const queueEntry = session.intentQueue?.pending?.find(
            (pending) =>
              pending.intent === chosenIntent ||
              pending.label?.toLowerCase() ===
                (selectedChoice?.label ?? choice.intent).toLowerCase(),
          );
          const chosenSourceStep =
            selectedChoice?.sourceStep ?? queueEntry?.sourceStep ?? session.currentFlowStep;
          const disambiguationOriginalMessage = session.data.values
            ._disambiguation_original_message as string | undefined;
          session.waitingForInput = undefined;
          delete session.data.values._disambiguation_choices;
          delete session.data.values._disambiguation_intents;
          delete session.data.values._disambiguation_original_message;

          if (onTraceEvent) {
            onTraceEvent({
              type: 'multi_intent_disambiguate_choice',
              data: {
                agent: session.agentName,
                chosenIntent: chosenIntent,
                chosenLabel: selectedChoice?.label ?? choice.intent,
                chosenTarget: selectedChoice?.target?.ref ?? null,
                chosenIndex: choice.index,
                userInput: currentMessage.trim().slice(0, 100),
              },
            });
          }

          // Re-process with the chosen intent's original message
          currentMessage =
            queueEntry?.original_message || disambiguationOriginalMessage || currentMessage;
          session.isComplete = false;
          session.state.conversationPhase = 'active';

          // Remove the chosen intent from queue if present
          if (session.intentQueue) {
            session.intentQueue.pending = session.intentQueue.pending.filter(
              (pending) => pending.intent !== chosenIntent,
            );
          }

          if (chosenTarget) {
            const applied = await this.continueWithTargetedOnInputBranch(
              session,
              chosenSourceStep ?? session.currentFlowStep!,
              currentMessage,
              chosenTarget,
              onChunk,
              onTraceEvent,
            );
            if (applied.outcome === 'break') {
              lastResult = applied.lastResult!;
              break;
            }
            if (applied.outcome === 'transition') {
              currentMessage = '';
              continue;
            }
          }

          if (chosenSourceStep) {
            session.currentFlowStep = chosenSourceStep;
          }
          session._pinnedIntent = chosenTarget;
          continue;
        } else {
          // Invalid choice — re-prompt
          const reprompt = 'Please choose a number or type the intent name.';
          const protectedReprompt = emitProtectedAssistantText(session, reprompt, onChunk);
          lastResult = {
            response: protectedReprompt.deliveryText,
            action: { type: 'disambiguation_reprompt' },
          };
          break;
        }
      }

      const stepName = session.currentFlowStep!;
      if (!stepName) break;

      // Per-step session memory reset: when the flow moves to a different step,
      // reset all session memory vars with reset: 'per_step' to their initial value.
      const prevStep = session.data.values['_current_step_for_reset'];
      const stepJustEntered = prevStep !== stepName;
      if (stepJustEntered) {
        session.data.values['_current_step_for_reset'] = stepName;
        // Built-in: always reset _clarification_count per step
        session.data.values._clarification_count = 0;
        // User-declared session vars with reset: 'per_step'
        const sessionMemVars = ir.memory?.session;
        if (sessionMemVars) {
          for (const sv of sessionMemVars) {
            if (sv.reset === 'per_step') {
              session.data.values[sv.name] = sv.initial_value ?? undefined;
            }
          }
        }
      }

      // Track visited steps for loop-back detection on THEN transitions.
      // Reset when we have new user input (user broke the cycle),
      // then always add the current step.
      if (currentMessage) visited.clear();
      visited.add(stepName);

      const stepStartTime = Date.now();
      const rawStep = ir.flow.definitions[stepName];
      const step = rawStep ? resolveFlowStepGatherFromAgentGather(rawStep, ir.gather) : undefined;
      let queuedGatherDeferredIntentsThisTurn = false;

      if (!step) {
        const terminalResult = await this.handleTerminalFlowTarget(session, stepName, {
          currentStep: stepName,
          currentMessage,
          completionSource: 'explicit_complete_step',
          onChunk,
          onTraceEvent,
        });
        if (terminalResult) {
          lastResult = terminalResult;
          break;
        }
        throw new AppError(`Flow step not found: ${stepName}`, { ...ErrorCodes.NOT_FOUND });
      }

      const stepType = getStepType(step);
      const flowStepRunId = `flow-step-${crypto.randomUUID()}`;
      const flowStepTraceContext = {
        agentName: session.agentName,
        stepName,
        stepType,
        flowStepName: stepName,
        flowStepType: stepType,
        flowStepRunId,
        flowIteration: iterations,
      };
      if (rootTraceEvent) {
        onTraceEvent = (event) => {
          rootTraceEvent({
            ...event,
            data: {
              ...flowStepTraceContext,
              ...event.data,
            },
          });
        };
      }

      // Emit flow_step_enter after resolving the step so every consumer gets the
      // same step identity contract as nested LLM/tool/guardrail events.
      if (onTraceEvent) {
        onTraceEvent({
          type: 'flow_step_enter',
          data: {
            input: currentMessage,
            collected: session.data.values,
          },
        });
      }

      const stepAssignments = step.set ? normalizeSetAssignments(step.set) : {};
      const hasStepAssignments = Object.keys(stepAssignments).length > 0;
      if (stepJustEntered && hasStepAssignments) {
        if (onTraceEvent) {
          onTraceEvent({
            type: 'dsl_set',
            data: {
              agentName: session.agentName,
              stepName,
              assignments: stepAssignments,
              contextBefore: { ...session.data.values },
              source: 'step_enter',
            },
          });
        }
        await this.applySetAssignmentsAndRemember(session, stepAssignments, {
          source: `step:${stepName}`,
          onTraceEvent,
          resolveValue: (rawValue) => resolveSetAssignmentValue(rawValue, session.data.values),
        });
      }

      // Check if we're waiting for an action from the user
      const waitingForAction = session.data.values[SESSION_KEY_WAITING_FOR_ACTION] as
        | string
        | undefined;
      if (waitingForAction && waitingForAction === stepName) {
        const parsedActionEvent = parseRuntimeActionEvent(
          session.data.values[SESSION_KEY_ACTION_EVENT],
        );

        if (!parsedActionEvent.ok && !('absent' in parsedActionEvent)) {
          const message =
            'That action payload is invalid. Please use the latest options shown in the chat.';
          onTraceEvent?.({
            type: 'action_submit_rejected',
            data: {
              actionId: parsedActionEvent.actionId,
              step: stepName,
              agent: session.agentName,
              reason: 'invalid_action_event',
              detail: parsedActionEvent.message,
            },
          });
          clearActionEvent(session);
          lastResult = {
            response: message,
            action: { type: 'waiting_for_action' },
            stateUpdates: buildStateUpdates(session),
          };
          break;
        }

        const actionEvent = parsedActionEvent.ok ? parsedActionEvent.value : undefined;

        if (actionEvent && (step.on_action || session.agentIR?.action_handlers)) {
          const expectedRenderId = getExpectedActionRenderId(session);
          if (
            expectedRenderId &&
            actionEvent.renderId &&
            actionEvent.renderId !== expectedRenderId
          ) {
            const message =
              'That action is no longer available. Please use the latest options shown in the chat.';
            onTraceEvent?.({
              type: 'action_submit_rejected',
              data: {
                actionId: actionEvent.actionId,
                step: stepName,
                agent: session.agentName,
                reason: 'render_id_mismatch',
              },
            });
            clearActionEvent(session);
            lastResult = {
              response: message,
              action: { type: 'waiting_for_action' },
              stateUpdates: buildStateUpdates(session),
            };
            break;
          }
          const actionContext = buildActionContext(actionEvent);
          const hadPreviousActionContext = Object.prototype.hasOwnProperty.call(
            session.data.values,
            SESSION_KEY_ACTION_CONTEXT,
          );
          const previousActionContext = session.data.values[SESSION_KEY_ACTION_CONTEXT];
          session.data.values[SESSION_KEY_ACTION_CONTEXT] = actionContext;

          try {
            // Find matching handler: step-level first, then agent-level fallback
            let handler = step.on_action?.find(
              (h) =>
                h.action_id === actionEvent.actionId &&
                (!h.condition || evaluateConditionDual(h.condition, session.data.values)),
            );
            let handlerSource: 'step' | 'agent' = 'step';

            // Agent-level ACTION_HANDLERS fallback when step has no match
            if (!handler && session.agentIR?.action_handlers) {
              handler = session.agentIR.action_handlers.find(
                (h) =>
                  h.action_id === actionEvent.actionId &&
                  (!h.condition || evaluateConditionDual(h.condition, session.data.values)),
              );
              if (handler) handlerSource = 'agent';
            }

            // Clear waiting state
            clearActionWaitState(session);
            session.waitingForInput = undefined;

            if (handler) {
              // Emit action_handler_executed trace event
              onTraceEvent?.({
                type: 'action_handler_executed',
                data: {
                  actionId: actionEvent.actionId,
                  source: handlerSource,
                  hasSet: !!handler.set,
                  hasRespond: !!handler.respond,
                  hasTransition: !!handler.transition,
                  hasDo: (handler.do?.length ?? 0) > 0,
                  step: stepName,
                  agent: session.agentName,
                },
              });

              const handlerExecution = await this.executeActionHandlerActions(session, handler, {
                actionId: actionEvent.actionId,
                actionValue: actionEvent.value,
                actionEvent,
                stepName,
                currentMessage,
                onChunk,
                onTraceEvent,
              });
              if (handlerExecution.outcome === 'continue') {
                continue;
              }
              if (handlerExecution.outcome === 'break') {
                lastResult = handlerExecution.result;
                break;
              }
            }
            // No matching handler — fall through to normal step processing
          } finally {
            if (hadPreviousActionContext) {
              session.data.values[SESSION_KEY_ACTION_CONTEXT] = previousActionContext;
            } else {
              delete session.data.values[SESSION_KEY_ACTION_CONTEXT];
            }
          }
        } else if (actionEvent) {
          // Non-action message while waiting — clear waiting state and process normally
          clearActionWaitState(session);
        }
      }

      // Initialize flow data if needed

      // ==========================================================================
      // STEP THOUGHT EMISSION: Emit a step_thought trace event for debugging
      // ==========================================================================
      const showStepThoughts = (session.agentIR?.execution as Record<string, unknown> | undefined)
        ?.show_step_thoughts;
      if (onTraceEvent && showStepThoughts !== false) {
        const stepType = getStepType(step);
        const summary = buildStepSummary(step);
        onTraceEvent({
          type: 'step_thought',
          data: {
            agent: session.agentName,
            stepName,
            stepType,
            summary,
          },
        });
      }

      // ==========================================================================
      // INPUT GUARDRAILS: Check via pipeline (Tier-1/2/3 + policy)
      // ==========================================================================
      const rawCurrentMessage = currentMessage;
      if (currentMessage) {
        setCurrentTurnInputContext(session, currentMessage);
        const inputGuardrails =
          session.agentIR?.constraints?.guardrails?.filter((g) => !g.kind || g.kind === 'input') ??
          [];
        const inputPolicy = await getSessionPolicy(session);
        const hasPolicyInputGuardrails = !!inputPolicy?.additionalGuardrails?.length;
        if (inputGuardrails.length || hasPolicyInputGuardrails) {
          try {
            if (session.tenantId) {
              await ensureTenantProvidersLoaded(session.tenantId);
            }
            const llmEval = session.llmClient
              ? createLLMEvalFromClient(session.llmClient)
              : undefined;
            const inputPipeline = createGuardrailPipeline(
              llmEval,
              session.tenantId,
              session.projectId,
              {
                policy: inputPolicy,
                piiRecognizerRegistry: session.piiRecognizerRegistry,
                cacheScopeKey: getSessionGuardrailCacheScopeKey(session),
              },
            );
            const policy = inputPolicy;

            const pipelineResult = await inputPipeline.execute(
              inputGuardrails,
              currentMessage,
              'input',
              { agentGoal: session.agentIR?.identity?.goal },
              onTraceEvent ? (evt: unknown) => onTraceEvent!(evt as any) : undefined,
              policy,
            );

            // Persist any sanitized/redacted form before handling a blocking result so
            // runtime-executor can rewrite the pre-appended user history entry.
            if (pipelineResult.modifiedContent) {
              currentMessage = pipelineResult.modifiedContent;
              setCurrentTurnInputContext(session, currentMessage, rawCurrentMessage);
              // Flow turns append the user message before step execution begins, so
              // update that most-recent history entry as soon as guardrails sanitize it.
              for (let i = session.conversationHistory.length - 1; i >= 0; i--) {
                const entry = session.conversationHistory[i];
                if (entry?.role !== 'user') continue;
                if (typeof entry.content === 'string' && entry.content === rawCurrentMessage) {
                  session.conversationHistory[i] = {
                    ...entry,
                    content: currentMessage,
                  };
                }
                break;
              }
            }

            if (!pipelineResult.passed && pipelineResult.primaryViolation) {
              const v = pipelineResult.primaryViolation;
              const blockMessage = v.message || formatErrorSync('GUARDRAIL_INPUT_BLOCKED').message;
              const protectedBlockMessage = emitProtectedAssistantText(
                session,
                blockMessage,
                onChunk,
              );

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

              lastResult = {
                response: protectedBlockMessage.deliveryText,
                action: { type: 'constraint_blocked', constraint: `guardrail:${v.name}` },
              };
              break;
            }
          } catch (pipelineError) {
            // Fail-open: log and continue if guardrail pipeline errors
            log.warn('Input guardrail pipeline error in flow-mode, continuing (fail-open)', {
              sessionId: session.id,
              error: pipelineError instanceof Error ? pipelineError.message : String(pipelineError),
            });
          }
        }
      }

      // ==========================================================================
      // CONSTRAINT CHECKING: Check guardrails before processing
      // ==========================================================================
      const guardrailViolation = checkConstraints(session, onTraceEvent);
      if (guardrailViolation) {
        const preDirective = interpretConstraintControlFlow(
          session,
          guardrailViolation,
          onTraceEvent,
        );
        if (preDirective) {
          const controlResult = this.handleConstraintControlFlow(
            session,
            guardrailViolation,
            preDirective,
            onChunk,
            onTraceEvent,
          );
          if (controlResult) {
            let protectedControlResponse: string | undefined;
            if (controlResult.respond) {
              const msg = interpolateTemplate(controlResult.respond, session.data.values);
              protectedControlResponse = emitProtectedAssistantText(
                session,
                msg,
                onChunk,
              ).deliveryText;
            }
            if (controlResult.action === 'collect') {
              session.waitingForInput = preDirective.fields;
              lastResult = {
                response: protectedControlResponse || 'Please provide additional information.',
                action: { type: 'constraint_collect', fields: preDirective.fields || [] },
              };
              break;
            }
            if (controlResult.action === 'goto' && controlResult.nextStep) {
              const transitionResult = await this.transitionToFlowTarget(
                session,
                controlResult.nextStep,
                {
                  currentStep: stepName,
                  currentMessage,
                  response: protectedControlResponse,
                  onChunk,
                  onTraceEvent,
                },
              );
              if (transitionResult.outcome === 'terminal') {
                lastResult = transitionResult.result;
                break;
              }
              currentMessage = '';
              continue;
            }
            if (controlResult.action === 'retry') {
              currentMessage = '';
              continue;
            }
          }
        }
        // Terminal handling — use executeConstraintViolation to support handoff actions
        lastResult = await executeConstraintViolation(session, guardrailViolation, {
          onChunk,
          onTraceEvent,
          executeHandoff: async (input, chunk, trace) => {
            return this.routing.handleHandoff(session, input, chunk, trace);
          },
        });
        break;
      }

      // ==========================================================================
      // CONSTRAINT CHECKING: Evaluate inline CHECK condition
      // ==========================================================================
      if (step.check) {
        const checkPassed = evaluateConditionDual(step.check, session.data.values);
        if (onTraceEvent) {
          onTraceEvent({
            type: 'constraint_check',
            data: {
              agentName: session.agentName,
              constraintType: 'step_check',
              stepName,
              condition: step.check,
              passed: checkPassed,
            },
          });
        }
        if (!checkPassed) {
          if (step.on_fail) {
            if (onTraceEvent) {
              onTraceEvent({
                type: 'flow_transition',
                data: {
                  agentName: session.agentName,
                  fromStep: stepName,
                  toStep: step.on_fail,
                  condition: `check_failed: ${step.check}`,
                },
              });
            }
            const transitionResult = await this.transitionToFlowTarget(session, step.on_fail, {
              currentStep: stepName,
              currentMessage,
              onChunk,
              onTraceEvent,
            });
            if (transitionResult.outcome === 'terminal') {
              lastResult = transitionResult.result;
              break;
            }
            continue;
          }
          const protectedMessage = emitProtectedAssistantText(
            session,
            FLOW_CHECK_FAILED_USER_MESSAGE,
            onChunk,
          );
          lastResult = {
            response: protectedMessage.deliveryText,
            action: { type: 'continue' },
          };
          break;
        }
      }

      // ==========================================================================
      // MULTI-INTENT DISPATCH: If multiple intents are detected in the user's
      // message, dispatch to the configured strategy (queue, disambiguate, etc.).
      // Skipped when: no message or waiting for input.
      // ==========================================================================
      if (currentMessage && !session.waitingForInput && !session._pinnedIntent) {
        const multiConfig = resolveMultiIntentConfig(ir);
        if (multiConfig.enabled) {
          const multiResult = this.detectMultipleIntents(session, currentMessage, step);
          if (multiResult) {
            const dispatchResult = this.dispatchMultiIntentIfNeeded(
              session,
              multiResult,
              currentMessage,
              stepName,
              onTraceEvent,
            );
            if (dispatchResult) {
              if (
                dispatchResult.strategy === 'disambiguate' &&
                dispatchResult.disambiguationMessage
              ) {
                const protectedMessage = emitProtectedAssistantText(
                  session,
                  dispatchResult.disambiguationMessage,
                  onChunk,
                );
                lastResult = {
                  response: protectedMessage.deliveryText,
                  action: { type: 'disambiguate' },
                };
                break;
              }
              // primary_queue / sequential: alternatives are queued, so continue
              // by immediately applying the primary branch on this same message.
              const primaryTarget =
                multiResult.primary.target?.kind === 'flow_step'
                  ? multiResult.primary.target.ref
                  : multiResult.primary.intent;
              if (primaryTarget) {
                const applied = await this.continueWithTargetedOnInputBranch(
                  session,
                  stepName,
                  currentMessage,
                  primaryTarget,
                  onChunk,
                  onTraceEvent,
                );
                if (applied.outcome === 'break') {
                  lastResult = applied.lastResult!;
                  break;
                }
                if (applied.outcome === 'transition') {
                  currentMessage = '';
                  continue;
                }
              }
              // parallel: fan-out tasks returned but not executed here. Flow mode
              // is single-threaded and cannot fan-out. The parallel strategy is
              // normally downgraded to sequential by resolveStrategy() for
              // non-supervisor agents, so this branch is a defensive no-op.
            }
          }
        }
      }

      // ==========================================================================
      // ENHANCED FLOW: Check for digressions (intent-based escapes)
      // ==========================================================================
      let digressionHandled = false;
      if (currentMessage && !session._pinnedIntent) {
        const deferGatherInterrupts =
          Boolean(session.waitingForInput?.length) && hasStepGatherFields(step);
        // Step-local digressions are more specific than global ones for stale IR
        // compiled before duplicate-intent validation landed.
        const allDigressions = [...(step.digressions || []), ...(ir.flow.global_digressions || [])];
        const duplicateDigressionIntents = findDuplicateFlowEscapeIntents(allDigressions);
        if (duplicateDigressionIntents.length > 0) {
          onTraceEvent?.({
            type: 'warning',
            data: {
              message:
                'Duplicate digression intents detected in legacy IR; runtime will match by declaration order.',
              agentName: session.agentName,
              stepName,
              intents: duplicateDigressionIntents,
            },
          });
        }

        if (!deferGatherInterrupts && allDigressions.length > 0) {
          const digressionMatch = await detectFlowEscapeMatch({
            session,
            currentMessage,
            candidates: allDigressions,
            candidateSurfaceKind: 'digression',
            onTraceEvent,
          });

          if (digressionMatch) {
            const digression = allDigressions[digressionMatch.candidateIndex];
            if (digression) {
              const digressionActions = normalizeDigressionActions(digression);
              const traceAction = digressionActions.find((action) => action.goto)?.goto
                ? 'goto'
                : digressionActions.find((action) => action.delegate)?.delegate
                  ? 'delegate'
                  : digressionActions.find((action) => action.resume)?.resume
                    ? 'resume'
                    : 'respond';

              if (onTraceEvent) {
                onTraceEvent({
                  type: 'digression',
                  data: {
                    agentName: session.agentName,
                    stepName: stepName,
                    intent: digression.intent,
                    matched: digressionMatch.matched,
                    ...toGatherInterruptTrace(digressionMatch),
                    action: traceAction,
                  },
                });
              }

              const digressionResult = await this.executeDigressionActions(
                session,
                digression,
                currentMessage,
                onChunk,
                onTraceEvent,
              );

              if (digressionResult.result) {
                lastResult = digressionResult.result;
                break;
              }

              if (digressionResult.handled) {
                currentMessage = digressionResult.consumeMessage ? '' : currentMessage;
                digressionHandled = true;
              }
            }
          }
        }

        if (digressionHandled) {
          continue;
        }

        // Check for sub-intents (scoped to current step)
        let subIntentHandled = false;
        if (step.sub_intents && step.sub_intents.length > 0) {
          const duplicateSubIntentIntents = findDuplicateFlowEscapeIntents(step.sub_intents);
          if (duplicateSubIntentIntents.length > 0) {
            onTraceEvent?.({
              type: 'warning',
              data: {
                message:
                  'Duplicate sub-intent labels detected in legacy IR; runtime will match by declaration order.',
                agentName: session.agentName,
                stepName,
                intents: duplicateSubIntentIntents,
              },
            });
          }
          const subIntentMatch = await detectFlowEscapeMatch({
            session,
            currentMessage,
            candidates: step.sub_intents,
            candidateSurfaceKind: 'sub_intent',
            onTraceEvent,
          });

          if (subIntentMatch) {
            const subIntent = step.sub_intents[subIntentMatch.candidateIndex];
            if (subIntent) {
              if (onTraceEvent) {
                onTraceEvent({
                  type: 'sub_intent',
                  data: {
                    agentName: session.agentName,
                    stepName: stepName,
                    intent: subIntent.intent,
                    matched: subIntentMatch.matched,
                    ...toGatherInterruptTrace(subIntentMatch),
                  },
                });
              }

              // Clear specified fields (triggers re-collection)
              if (subIntent.clear) {
                for (const field of subIntent.clear) {
                  deleteSessionValue(session, field);
                }
              }

              // Set specified values
              if (subIntent.set) {
                await this.applySetAssignmentsAndRemember(session, subIntent.set, {
                  source: `sub_intent:${subIntent.intent}`,
                  onTraceEvent,
                  resolveValue: (rawValue) =>
                    resolveSetAssignmentValue(rawValue, session.data.values),
                });
              }

              // Execute call if any
              if (subIntent.call || subIntent.call_spec) {
                const invocation = {
                  call: subIntent.call,
                  call_spec: subIntent.call_spec,
                };
                const subCallToolName = getToolInvocationToolName(invocation);
                if (subCallToolName) {
                  const subCallViolation = checkFlatConstraintsAtCheckpoint(
                    session,
                    { kind: 'tool_call', target: subCallToolName },
                    onTraceEvent,
                  );
                  if (subCallViolation) {
                    lastResult = await executeConstraintViolation(session, subCallViolation, {
                      onChunk,
                      onTraceEvent,
                      executeHandoff: async (input, chunk, trace) => {
                        return this.routing.handleHandoff(session, input, chunk, trace);
                      },
                    });
                    break;
                  }
                }
                const { result: callResult } = await this.executeConfiguredToolInvocation(
                  session,
                  invocation,
                  {
                    source: 'sub_intent',
                    stepName,
                  },
                  onTraceEvent,
                  onChunk,
                );
                this.bindToolInvocationResult(
                  session,
                  invocation,
                  subCallToolName,
                  callResult,
                  'branch',
                  `sub_intent:${subIntent.intent}`,
                  onTraceEvent,
                );

                // Memory: REMEMBER triggers + RECALL after tool call
                try {
                  await evaluateRememberAfterStateChange(session, onTraceEvent);
                  if (subCallToolName) {
                    await executeRecallAfterToolCall(session, subCallToolName, onTraceEvent);
                  }
                } catch (err) {
                  log.warn('memory operations failed after sub-intent call', {
                    error: err instanceof Error ? err.message : String(err),
                  });
                }
              }

              // Show response
              if (subIntent.respond) {
                const resp = renderLocalizedFlowTemplate(
                  session,
                  subIntent.respond,
                  subIntent.message_key,
                );
                const protectedResponse = emitProtectedAssistantText(session, resp, onChunk);
                const subIntentVoiceConfig = subIntent.voice_config
                  ? interpolateVoiceConfig(subIntent.voice_config, session.data.values)
                  : undefined;
                const subIntentRichContent = subIntent.rich_content
                  ? interpolateRichContent(subIntent.rich_content, session.data.values)
                  : undefined;
                rememberPendingRenderedPayload(
                  session,
                  protectedResponse.deliveryText,
                  subIntentRichContent,
                  subIntentVoiceConfig,
                  subIntent.actions,
                );
                lastResult = {
                  response: protectedResponse.deliveryText,
                  action: { type: 'continue' },
                  stateUpdates: buildStateUpdates(session),
                  voiceConfig: subIntentVoiceConfig,
                  richContent: subIntentRichContent,
                  actions: subIntent.actions,
                };
                break;
              }

              // Re-execute current step (sub-intents stay in step by default)
              currentMessage = '';
              subIntentHandled = true;
            }
          }
        }

        if (subIntentHandled) {
          continue;
        }

        if (!deferGatherInterrupts) {
          const parentRoute = await detectParentSupervisorRoute({
            ctx: this.ctx,
            session,
            currentMessage,
            currentAgentName: session.agentName,
            suppressParentSupervisorRoute: options?.suppressParentSupervisorRoute,
            onTraceEvent,
          });
          if (parentRoute) {
            onTraceEvent?.({
              type: 'digression',
              data: {
                agentName: session.agentName,
                stepName,
                intent: parentRoute.category,
                matched: parentRoute.matched,
                ...toGatherInterruptTrace(parentRoute),
                action: 'return_to_parent',
                target: parentRoute.target,
                ...(parentRoute.kind === 'blocked' ? { rerouteError: parentRoute.error } : {}),
              },
            });

            if (parentRoute.kind === 'match') {
              const returnToParent = this.routing.handleReturnToParent(
                session,
                {
                  reason: `Detected parent supervisor intent "${parentRoute.category}" while collecting flow input.`,
                  message: currentMessage,
                },
                onTraceEvent,
              );

              if (returnToParent.success) {
                lastResult = {
                  response: '',
                  action: {
                    type: 'return_to_parent',
                    category: parentRoute.category,
                    target: parentRoute.target,
                    forwardedMessage: currentMessage,
                    detectionMode: parentRoute.detectionMode,
                    ...(parentRoute.lexicalMatchType
                      ? { lexicalMatchType: parentRoute.lexicalMatchType }
                      : {}),
                  },
                  stateUpdates: buildStateUpdates(session),
                };
                break;
              }
            } else {
              lastResult = {
                response: parentRoute.error,
                action: {
                  type: 'error',
                  blockedParentReroute: true,
                  category: parentRoute.category,
                  target: parentRoute.target,
                  forwardedMessage: currentMessage,
                  detectionMode: parentRoute.detectionMode,
                  rerouteError: parentRoute.error,
                  ...(parentRoute.lexicalMatchType
                    ? { lexicalMatchType: parentRoute.lexicalMatchType }
                    : {}),
                },
                stateUpdates: buildStateUpdates(session),
              };
              break;
            }
          }
        }
      }

      // ==========================================================================
      // ENHANCED FLOW: Check for corrections (when corrections: true)
      // Uses 3-tier detection: regex (fast) → sidecar ML → LLM (slowest).
      // ==========================================================================
      if (step.corrections && currentMessage) {
        const correctionMode: CorrectionDetectionStrategy =
          session.agentIR?.project_runtime_config?.correction_detection ?? 'ml';

        let correctionField: string | undefined;
        let correctionNewValue: string | undefined;
        let correctionDetectionMethod: 'regex' | 'sidecar' | 'llm' = 'regex';

        if (correctionMode !== 'disabled') {
          const enableRegex =
            correctionMode === 'auto' || correctionMode === 'ml' || correctionMode === 'regex';
          const corrNluProvider: string =
            session.agentIR?.project_runtime_config?.nlu_provider ?? 'standard';
          const enableSidecar =
            corrNluProvider === 'advanced' &&
            (correctionMode === 'auto' || correctionMode === 'ml' || correctionMode === 'sidecar');
          const enableLLM = correctionMode === 'auto' || correctionMode === 'llm';

          // 1. Try fast regex-based detection first
          if (enableRegex) {
            const regexCorrection = detectCorrection(
              currentMessage,
              session.data.values,
              session.agentIR?.gather?.correction_patterns,
            );

            if (regexCorrection) {
              correctionField = regexCorrection.field;
              correctionNewValue = regexCorrection.newValue;
              correctionDetectionMethod = 'regex';
            }
          }

          // 2. If regex didn't match, try sidecar ML detection. The sidecar
          // returns a tagged Result — outage kinds (`unavailable` / `timeout`
          // / `circuit_open`) degrade silently to the LLM tier; non-outage
          // kinds (`no_match`, `not_implemented`, `invalid_response`) are
          // contract outcomes that also fall through to LLM but are logged
          // distinctly so operators can distinguish infrastructure problems
          // from backend coverage gaps (Finding f03f0e46).
          if (!correctionField && enableSidecar) {
            const sidecarClient = session._nluSidecarClient;
            if (sidecarClient) {
              const ctx = buildSidecarCallContext(session);
              if (!ctx) {
                log.debug(
                  'Skipping sidecar correction detection because tenancy context is incomplete',
                  {
                    agentName: session.agentName,
                    sessionId: session.id,
                    hasTenantId: Boolean(session.tenantId),
                    hasProjectId: Boolean(session.projectId),
                  },
                );
              } else {
                try {
                  const perProjectTimeoutMs =
                    session.agentIR?.project_runtime_config?.sidecar_timeout_ms;
                  const callArgs = {
                    text: currentMessage,
                    context: session.data.values,
                    locale: getCurrentInteractionLocale(session.data, 'en') ?? 'en',
                  };

                  let sidecarResult;
                  if (perProjectTimeoutMs) {
                    const controller = new AbortController();
                    const timer = setTimeout(() => controller.abort(), perProjectTimeoutMs);
                    try {
                      sidecarResult = await Promise.race([
                        sidecarClient.detectCorrection(callArgs, ctx),
                        new Promise<never>((_, reject) => {
                          controller.signal.addEventListener('abort', () =>
                            reject(new Error('Per-project sidecar timeout')),
                          );
                        }),
                      ]);
                    } finally {
                      clearTimeout(timer);
                    }
                  } else {
                    sidecarResult = await sidecarClient.detectCorrection(callArgs, ctx);
                  }

                  if (sidecarResult.ok) {
                    const value = sidecarResult.value;
                    if (value.is_correction && value.field) {
                      correctionField = value.field;
                      correctionNewValue = String(value.new_value);
                      correctionDetectionMethod = 'sidecar';
                    }
                  } else {
                    const outage = isSidecarOutageKind(sidecarResult.error.kind);
                    log.debug(
                      outage
                        ? 'Sidecar correction detection unavailable, falling back to LLM'
                        : 'Sidecar correction detection returned no match / contract error',
                      {
                        kind: sidecarResult.error.kind,
                        code: sidecarResult.error.code,
                        message: sidecarResult.error.message,
                      },
                    );
                  }
                } catch (err) {
                  log.debug('Sidecar correction detection threw unexpectedly, falling back', {
                    error: err instanceof Error ? err.message : String(err),
                  });
                }
              }
            }
          }

          // 3. If neither regex nor sidecar matched, try LLM-based detection (slowest)
          if (!correctionField && enableLLM && session.llmClient) {
            const llmCorrection = await this.detectCorrectionWithLLM(
              currentMessage,
              session,
              step.gather?.fields,
            );
            if (llmCorrection) {
              correctionField = llmCorrection.field;
              correctionNewValue = llmCorrection.newValue;
              correctionDetectionMethod = 'llm';
            }
          }

          // Validate correctionField against declared gather fields
          if (correctionField && correctionNewValue !== undefined) {
            const declaredFieldNames = new Set(
              (step.gather?.fields ?? []).map((f: { name: string }) => f.name),
            );

            if (
              correctionField === CORRECTION_FIELD_UNKNOWN ||
              !declaredFieldNames.has(correctionField)
            ) {
              if (correctionDetectionMethod !== 'llm') {
                log.debug('Correction field not in gather schema, deferring to LLM', {
                  agent: session.agentName,
                  field: correctionField,
                  method: correctionDetectionMethod,
                });
                correctionField = undefined;
                correctionNewValue = undefined;

                // Actually invoke LLM fallback
                if (enableLLM && session.llmClient) {
                  const llmFallback = await this.detectCorrectionWithLLM(
                    currentMessage,
                    session,
                    step.gather?.fields,
                  );
                  if (llmFallback && declaredFieldNames.has(llmFallback.field)) {
                    correctionField = llmFallback.field;
                    correctionNewValue = llmFallback.newValue;
                    correctionDetectionMethod = 'llm';
                  } else if (llmFallback) {
                    log.warn('LLM correction fallback also returned undeclared field, skipping', {
                      agent: session.agentName,
                      field: llmFallback.field,
                    });
                  }
                }
              } else {
                log.warn('LLM correction returned undeclared field, skipping', {
                  agent: session.agentName,
                  field: correctionField,
                });
                correctionField = undefined;
                correctionNewValue = undefined;
              }
            }
          }
        } // end correctionMode !== 'disabled'

        if (correctionField && correctionNewValue !== undefined) {
          emitDecisionEvent(onTraceEvent, session.traceVerbosity, 'correction', {
            outcome: correctionField,
            matched: true,
            field: correctionField,
            oldValue: '<redacted>',
            newValue: '<redacted>',
            source: correctionDetectionMethod,
          });

          // Emit correction trace event
          if (onTraceEvent) {
            onTraceEvent({
              type: 'correction',
              data: {
                agentName: session.agentName,
                stepName: stepName,
                field: correctionField,
                oldValue: session.data.values[correctionField],
                newValue: correctionNewValue,
                detectionMethod: correctionDetectionMethod,
              },
            });
          }

          // Apply correction - extract properly via LLM (or regex fallback)
          const extracted = await this.extractEntitiesWithLLM(
            correctionNewValue,
            [correctionField],
            session,
            onTraceEvent,
            step.gather?.fields,
            step.gather?.strategy,
          );
          const correctionFields = step.gather?.fields ?? [];
          const { valid: validatedCorrection } = validateExtractedBatch(
            correctionFields,
            extracted,
            getDateNormalizationOptions(session),
          );
          setGatheredValues(session, validatedCorrection);

          // Invalidate dependent fields (BFS walk on depends_on graph)
          const invalidated = this.invalidateDependentFields(
            correctionField,
            step.gather?.fields,
            session,
          );

          if (invalidated.length > 0 && onTraceEvent) {
            onTraceEvent({
              type: 'correction_invalidation',
              data: {
                agentName: session.agentName,
                stepName: stepName,
                correctedField: correctionField,
                invalidatedFields: invalidated,
              },
            });
          }

          // Memory: REMEMBER triggers + RECALL on entity events + preference detection
          try {
            await evaluateRememberAfterStateChange(session, onTraceEvent);
            await executeRecallAfterExtraction(session, Object.keys(extracted), onTraceEvent);
            if (currentMessage) {
              await detectAndStorePreferences(
                session,
                currentMessage,
                Object.keys(extracted),
                onTraceEvent,
              );
            }
          } catch (err) {
            log.warn('memory operations failed after extraction', {
              error: err instanceof Error ? err.message : String(err),
            });
          }

          // Acknowledge correction (include invalidated fields info if any)
          const correctedValue =
            validatedCorrection[correctionField] ||
            extracted[correctionField] ||
            correctionNewValue;
          let ackMsg = `Updated ${correctionField} to ${correctedValue}.`;
          if (invalidated.length > 0) {
            ackMsg += ` Note: ${invalidated.join(', ')} ${invalidated.length === 1 ? 'has' : 'have'} been cleared and will need to be re-collected.`;
          }
          const protectedAck = emitProtectedAssistantText(session, ackMsg, onChunk);
          ackMsg = protectedAck.deliveryText;

          // Continue with current step
          currentMessage = '';
          continue;
        }
      }

      // Prompt-less ON_INPUT steps should evaluate the live user turn even
      // before the step has entered an explicit waiting state.
      if (
        !session.waitingForInput &&
        !hasStepGatherFields(step) &&
        step.on_input &&
        step.on_input.length > 0 &&
        currentMessage.trim() &&
        !queuedGatherDeferredIntentsThisTurn
      ) {
        session.data.values['input'] = currentMessage;
        session.data.values['_raw_input'] = currentMessage;

        let branchesToEvaluate = step.on_input;
        if (session._pinnedIntent) {
          const pinnedBranch = step.on_input.find((b) => b.then === session._pinnedIntent);
          if (pinnedBranch) {
            branchesToEvaluate = step.on_input.filter(
              (b) => b.then === session._pinnedIntent || !b.condition,
            );
          } else {
            branchesToEvaluate = [];
          }

          if (onTraceEvent) {
            onTraceEvent({
              type: 'decision',
              data: {
                type: 'pinned_intent_on_input_filter',
                agentName: session.agentName,
                stepName: stepName,
                pinnedIntent: session._pinnedIntent,
                totalBranches: step.on_input.length,
                filteredBranches: branchesToEvaluate.length,
                pinnedBranchFound: !!pinnedBranch,
              },
            });
          }
        }

        const branchResult =
          branchesToEvaluate.length > 0
            ? evaluateOnInput(
                branchesToEvaluate,
                currentMessage,
                session.data.values,
                onChunk,
                onTraceEvent,
              )
            : null;

        if (branchResult) {
          emitDecisionEvent(onTraceEvent, session.traceVerbosity, 'flow_transition', {
            outcome: branchResult.then ?? 'continue',
            condition: 'on_input_match',
            matched: true,
            trigger: { source: 'on_input_match' },
          });

          session._pinnedIntent = undefined;

          const applied = await this.applyOnInputBranchResult(
            session,
            stepName,
            branchResult,
            onChunk,
            onTraceEvent,
          );
          if (applied.outcome === 'break') {
            lastResult = applied.lastResult!;
            break;
          }

          if (onTraceEvent) {
            onTraceEvent({
              type: 'flow_step_exit',
              data: {
                agentName: session.agentName,
                stepName: stepName,
                durationMs: Date.now() - stepStartTime,
                result: 'branch',
              },
            });
            onTraceEvent({
              type: 'flow_transition',
              data: {
                agentName: session.agentName,
                fromStep: stepName,
                toStep: branchResult.then,
                condition: 'on_input_match',
              },
            });
          }

          const transitionResult = await this.transitionToFlowTarget(session, branchResult.then, {
            currentStep: stepName,
            currentMessage,
            onChunk,
            onTraceEvent,
          });
          if (transitionResult.outcome === 'terminal') {
            lastResult = transitionResult.result;
            break;
          }
          currentMessage = '';
          continue;
        }
      }

      // Check if we're waiting for input collection (user just provided it)
      const justCollectedInput = session.waitingForInput && session.waitingForInput.length > 0;

      if (justCollectedInput) {
        const waitingFields = step.gather?.fields ?? [];
        const deferGatherInterrupts =
          Boolean(session.waitingForInput?.length) && hasStepGatherFields(step);
        const singleUntypedGatherField =
          deferGatherInterrupts &&
          waitingFields.length === 1 &&
          session.waitingForInput?.length === 1 &&
          waitingFields[0]?.name === session.waitingForInput[0] &&
          !waitingFields[0]?.type
            ? waitingFields[0]
            : undefined;

        if (deferGatherInterrupts) {
          const deferredParentRoute =
            await this.handleDeferredParentSupervisorRouteWithoutExtraction(
              session,
              stepName,
              currentMessage,
              onTraceEvent,
              {
                suppressParentSupervisorRoute: options?.suppressParentSupervisorRoute,
              },
            );

          if (deferredParentRoute.handled) {
            if (deferredParentRoute.lastResult) {
              lastResult = deferredParentRoute.lastResult;
              break;
            }
          }
        }

        if (singleUntypedGatherField) {
          const deferredInterrupt = await this.handleDeferredGatherInterruptWithoutExtraction(
            session,
            step,
            stepName,
            currentMessage,
            onChunk,
            onTraceEvent,
            {
              suppressParentSupervisorRoute: options?.suppressParentSupervisorRoute,
            },
          );

          if (deferredInterrupt.handled) {
            if (deferredInterrupt.lastResult) {
              lastResult = deferredInterrupt.lastResult;
              break;
            }

            if (deferredInterrupt.consumeMessage) {
              currentMessage = '';
              continue;
            }
          }
        }

        // Extract entities from user input using LLM (or regex fallback)
        const rawExtracted = await this.extractEntitiesWithLLM(
          currentMessage,
          session.waitingForInput!,
          session,
          onTraceEvent,
          waitingFields,
          step.gather?.strategy,
        );
        // Validate and normalize extracted values
        const { valid: extractedData } = validateExtractedBatch(
          waitingFields,
          rawExtracted,
          getDateNormalizationOptions(session),
        );

        // Check if any required fields were actually extracted (before writing to session)
        const collectedFields = Object.keys(extractedData).filter(
          (k) =>
            extractedData[k] !== undefined && extractedData[k] !== null && extractedData[k] !== '',
        );
        const meaningfulData: Record<string, unknown> = {};
        for (const key of collectedFields) {
          meaningfulData[key] = extractedData[key];
        }

        // Only write meaningfully extracted values to session (skip empty/null/undefined)
        if (Object.keys(meaningfulData).length > 0) {
          setGatheredValues(session, meaningfulData);

          // Memory: REMEMBER triggers + RECALL on entity events + preference detection
          try {
            await evaluateRememberAfterStateChange(session, onTraceEvent);
            await executeRecallAfterExtraction(session, Object.keys(meaningfulData), onTraceEvent);
            if (currentMessage) {
              await detectAndStorePreferences(
                session,
                currentMessage,
                Object.keys(meaningfulData),
                onTraceEvent,
              );
            }
          } catch (err) {
            log.warn('memory operations failed after extraction', {
              error: err instanceof Error ? err.message : String(err),
            });
          }
        }

        // Emit COLLECT trace event
        if (onTraceEvent) {
          onTraceEvent({
            type: 'dsl_collect',
            data: {
              agentName: session.agentName,
              stepName: stepName,
              fields: session.waitingForInput,
              userInput: currentMessage,
              extracted: extractedData,
              context: { ...session.data.values },
            },
          });
        }

        // Also store raw input for condition evaluation
        session.data.values['input'] = currentMessage;
        session.data.values['_raw_input'] = currentMessage;
        const requiredFields = session.waitingForInput || [];
        const missingFields = requiredFields.filter((f) => !collectedFields.includes(f));
        if (collectedFields.length > 0) {
          session.waitingForInput = missingFields.length > 0 ? missingFields : undefined;
        }

        log.debug('Extraction result', {
          collected: collectedFields,
          required: requiredFields,
          missing: missingFields,
        });

        if (deferGatherInterrupts && collectedFields.length > 0) {
          const deferredInterrupt = await this.detectDeferredGatherQueueEntries(
            session,
            step,
            stepName,
            currentMessage,
            onChunk,
            onTraceEvent,
            {
              suppressParentSupervisorRoute: options?.suppressParentSupervisorRoute,
            },
          );
          this.enqueueGatherDeferredIntents(session, deferredInterrupt.queueEntries, onTraceEvent);
          queuedGatherDeferredIntentsThisTurn = deferredInterrupt.queueEntries.length > 0;

          if (deferredInterrupt.handled) {
            if (deferredInterrupt.lastResult) {
              lastResult = deferredInterrupt.lastResult;
              break;
            }

            currentMessage = deferredInterrupt.consumeMessage ? '' : currentMessage;
            continue;
          }
        }

        if (deferGatherInterrupts && missingFields.length > 0 && collectedFields.length === 0) {
          const deferredInterrupt = await this.handleDeferredGatherInterruptWithoutExtraction(
            session,
            step,
            stepName,
            currentMessage,
            onChunk,
            onTraceEvent,
          );

          if (deferredInterrupt.handled) {
            if (deferredInterrupt.lastResult) {
              lastResult = deferredInterrupt.lastResult;
              break;
            }

            currentMessage = deferredInterrupt.consumeMessage ? '' : currentMessage;
            continue;
          }
        }

        // IMPORTANT: Check ON_INPUT BEFORE re-prompting for missing fields
        // This allows navigation commands like "back", "change X" to work even when no data was extracted
        if (
          missingFields.length > 0 &&
          collectedFields.length === 0 &&
          step.on_input &&
          step.on_input.length > 0
        ) {
          const navigationResult = evaluateOnInput(
            step.on_input,
            currentMessage,
            session.data.values,
            undefined, // Don't send response yet
            onTraceEvent,
          );

          if (navigationResult && navigationResult.then) {
            log.debug('Navigation command detected', {
              input: currentMessage,
              target: navigationResult.then,
            });

            emitDecisionEvent(onTraceEvent, session.traceVerbosity, 'flow_transition', {
              outcome: navigationResult.then,
              condition: 'navigation_command',
              matched: true,
              trigger: { source: 'navigation_command' },
            });

            const applied = await this.applyOnInputBranchResult(
              session,
              stepName,
              navigationResult,
              onChunk,
              onTraceEvent,
            );

            if (applied.outcome === 'break') {
              if (applied.lastResult) {
                lastResult = applied.lastResult;
                break;
              }
              continue;
            }

            // Clear waiting state and transition
            session.waitingForInput = undefined;

            // Emit flow_step_exit and flow_transition
            if (onTraceEvent) {
              onTraceEvent({
                type: 'flow_step_exit',
                data: {
                  agentName: session.agentName,
                  stepName: stepName,
                  durationMs: Date.now() - stepStartTime,
                  result: 'navigation',
                },
              });
              onTraceEvent({
                type: 'flow_transition',
                data: {
                  agentName: session.agentName,
                  fromStep: stepName,
                  toStep: navigationResult.then,
                  condition: 'navigation_command',
                },
              });
            }

            // Handle the navigation
            const transitionResult = await this.transitionToFlowTarget(
              session,
              navigationResult.then,
              {
                currentStep: stepName,
                currentMessage,
                onChunk,
                onTraceEvent,
              },
            );
            if (transitionResult.outcome === 'terminal') {
              lastResult = transitionResult.result;
              break;
            }
            currentMessage = '';
            continue;
          }
        }

        // If no required fields were extracted and no navigation command matched, re-prompt
        if (missingFields.length > 0 && collectedFields.length === 0) {
          log.debug('No required fields extracted, re-prompting', { missingFields });
          const clarificationStage = this.incrementClarificationCount(session);
          // Prefer field-specific validation retry_prompt, then original gather prompt.
          // Never use step.respond here — it is a terminal/intro template, not a re-prompt.
          const retryPrompts = session.data.values._validation_retry_prompts as
            | Record<string, string>
            | undefined;
          const firstMissing = missingFields[0];
          const fieldRetryPrompt = retryPrompts?.[firstMissing];
          const gatherPrompt = step.gather
            ? buildLocalizedGatherPrompt(session, step.gather, missingFields, session.data.values)
            : null;
          const promptText = this.buildClarificationPrompt({
            missingFields,
            defaultPrompt:
              fieldRetryPrompt || gatherPrompt || `Please provide: ${missingFields.join(', ')}`,
            stage: clarificationStage,
          });
          const interpolatedPrompt = interpolateTemplate(promptText, session.data.values);

          const protectedPrompt = emitProtectedAssistantText(session, interpolatedPrompt, onChunk);

          const retryFormats = step.gather
            ? resolveGatherFormats(step.gather.fields, missingFields, session.data.values)
            : {};
          const retryVoiceConfig =
            retryFormats.voiceConfig ??
            (step.voice_config
              ? interpolateVoiceConfig(step.voice_config, session.data.values)
              : undefined);
          const retryRichContent = resolvePendingRichContent(
            session,
            currentMessage,
            retryFormats.richContent ??
              (step.rich_content
                ? interpolateRichContent(step.rich_content, session.data.values)
                : undefined),
          );
          rememberPendingRenderedPayload(
            session,
            protectedPrompt.deliveryText,
            retryRichContent,
            retryVoiceConfig,
            step.actions,
          );

          // Keep waiting for the same fields
          lastResult = {
            response: protectedPrompt.deliveryText,
            action: { type: 'collect', fields: missingFields },
            stateUpdates: buildStateUpdates(session),
            voiceConfig: retryVoiceConfig,
            richContent: retryRichContent,
            actions: step.actions,
          };
          break;
        }

        // For GATHER steps with partial extraction (some fields collected, others missing),
        // re-prompt for remaining fields instead of falling through
        if (
          missingFields.length > 0 &&
          collectedFields.length > 0 &&
          step.gather &&
          step.gather.fields &&
          step.gather.fields.length > 0
        ) {
          log.debug('GATHER partial extraction', {
            collected: collectedFields,
            missing: missingFields,
          });
          const clarificationStage = this.incrementClarificationCount(session);
          session.waitingForInput = missingFields;
          const prompt = this.buildClarificationPrompt({
            missingFields,
            defaultPrompt: buildLocalizedGatherPrompt(
              session,
              step.gather,
              missingFields,
              session.data.values,
            ),
            stage: clarificationStage,
          });
          const interpolatedPrompt = interpolateTemplate(prompt, session.data.values);

          const protectedPrompt = emitProtectedAssistantText(session, interpolatedPrompt, onChunk);

          const gatherFormats = resolveGatherFormats(
            step.gather.fields,
            missingFields,
            session.data.values,
          );
          const gatherRichContent = resolvePendingRichContent(
            session,
            currentMessage,
            gatherFormats.richContent,
          );
          rememberPendingRenderedPayload(session, protectedPrompt.deliveryText, gatherRichContent);
          lastResult = {
            response: protectedPrompt.deliveryText,
            action: { type: 'collect', fields: missingFields, mode: 'gather' },
            stateUpdates: buildStateUpdates(session),
            voiceConfig: gatherFormats.voiceConfig,
            richContent: gatherRichContent,
            actions: step.actions,
          };
          break;
        }

        session.waitingForInput = undefined;

        // ==========================================================================
        // POST-EXTRACTION LOOKUP TABLE VALIDATION
        // Validate collected values against lookup tables before constraint checks.
        // ==========================================================================
        const mergedLookupForValidation = mergeLookupTables(
          session.agentIR?.lookup_tables,
          session._projectRuntimeConfig,
        );
        if (Object.keys(mergedLookupForValidation).length > 0 && step.gather?.fields) {
          const lookupContext: LookupContext = {
            tenantId: session.tenantId ?? '',
            projectId: session.projectId ?? '',
          };
          const { errors: lookupErrors, fuzzyMatches } = await validateWithLookupTables(
            session.data.values,
            step.gather.fields,
            mergedLookupForValidation,
            lookupContext,
          );

          // Clear invalid values — they need to be re-collected
          const invalidFields = Object.keys(lookupErrors);
          if (invalidFields.length > 0) {
            for (const field of invalidFields) {
              deleteSessionValue(session, field);
            }
            // Re-prompt for invalid fields
            session.waitingForInput = invalidFields;
            const errorMsg = invalidFields.map((f) => lookupErrors[f]).join('. ');
            const protectedError = emitProtectedAssistantText(session, errorMsg, onChunk);

            if (onTraceEvent) {
              onTraceEvent({
                type: 'lookup_validation_failed',
                data: {
                  agentName: session.agentName,
                  stepName,
                  errors: lookupErrors,
                },
              });
            }

            lastResult = {
              response: protectedError.deliveryText,
              action: { type: 'collect', fields: invalidFields, mode: 'gather' },
              stateUpdates: buildStateUpdates(session),
            };
            break;
          }

          // Handle fuzzy matches — ask user for confirmation
          if (Object.keys(fuzzyMatches).length > 0) {
            session.data.values._pending_fuzzy = fuzzyMatches;
            const msg = Object.entries(fuzzyMatches)
              .map(([f, m]) => `Did you mean "${m.suggested}" for ${f}?`)
              .join(' ');
            const protectedMessage = emitProtectedAssistantText(session, msg, onChunk);

            if (onTraceEvent) {
              onTraceEvent({
                type: 'lookup_fuzzy_confirmation_requested',
                data: {
                  agentName: session.agentName,
                  stepName,
                  fields: fuzzyMatches,
                },
              });
            }

            session.waitingForInput = ['_fuzzy_confirmation_'];
            lastResult = {
              response: protectedMessage.deliveryText,
              action: { type: 'collect', fields: ['_fuzzy_confirmation_'], mode: 'gather' },
              stateUpdates: buildStateUpdates(session),
            };
            break;
          }
        }

        // ==========================================================================
        // POST-EXTRACTION CONSTRAINT CHECK: Now that we have collected data,
        // check constraints again (e.g., "num_guests <= 10" after collecting num_guests)
        // ==========================================================================
        const postExtractionViolation = checkConstraints(session, onTraceEvent);
        if (postExtractionViolation) {
          const postDirective = interpretConstraintControlFlow(
            session,
            postExtractionViolation,
            onTraceEvent,
          );
          if (postDirective) {
            const controlResult = this.handleConstraintControlFlow(
              session,
              postExtractionViolation,
              postDirective,
              onChunk,
              onTraceEvent,
            );
            if (controlResult) {
              let protectedControlResponse: string | undefined;
              if (controlResult.respond) {
                const msg = interpolateTemplate(controlResult.respond, session.data.values);
                protectedControlResponse = emitProtectedAssistantText(
                  session,
                  msg,
                  onChunk,
                ).deliveryText;
              }
              if (controlResult.action === 'collect') {
                session.waitingForInput = postDirective.fields;
                lastResult = {
                  response: protectedControlResponse || 'Please provide additional information.',
                  action: { type: 'constraint_collect', fields: postDirective.fields || [] },
                };
                break;
              }
              if (controlResult.action === 'goto' && controlResult.nextStep) {
                const transitionResult = await this.transitionToFlowTarget(
                  session,
                  controlResult.nextStep,
                  {
                    currentStep: stepName,
                    currentMessage,
                    response: protectedControlResponse,
                    onChunk,
                    onTraceEvent,
                  },
                );
                if (transitionResult.outcome === 'terminal') {
                  lastResult = transitionResult.result;
                  break;
                }
                currentMessage = '';
                continue;
              }
              if (controlResult.action === 'retry') {
                for (const field of Object.keys(extractedData)) {
                  deleteSessionValue(session, field);
                }
                session.waitingForInput = Object.keys(extractedData);
                currentMessage = '';
                continue;
              }
            }
          }
          // Fallback: clear only the fields referenced by the violating condition
          const fieldsToClear = getConstraintFieldsToClear(
            Object.keys(extractedData),
            postExtractionViolation.condition,
          );
          for (const field of fieldsToClear) {
            deleteSessionValue(session, field);
          }
          session.waitingForInput = fieldsToClear;
          lastResult = await executeConstraintViolation(session, postExtractionViolation, {
            onChunk,
            onTraceEvent,
            executeHandoff: async (input, chunk, trace) => {
              return this.routing.handleHandoff(session, input, chunk, trace);
            },
          });
          break;
        }

        // Check ON_INPUT conditions for branching
        // NOTE: Only evaluate ON_INPUT if we have actual user input
        // (not when entering a step with empty message after a transition)
        if (
          step.on_input &&
          step.on_input.length > 0 &&
          currentMessage.trim() &&
          !queuedGatherDeferredIntentsThisTurn
        ) {
          // Keep ON_INPUT condition evaluation aligned with targeted-branch replay:
          // branch expressions reference `input`, so populate the canonical turn
          // variables before evaluating the branch list.
          session.data.values['input'] = currentMessage;
          session.data.values['_raw_input'] = currentMessage;

          // When pinned intent is active, filter ON_INPUT branches to only the
          // branch whose `then` matches the pinned intent, plus ELSE fallback.
          let branchesToEvaluate = step.on_input;
          if (session._pinnedIntent) {
            const pinnedBranch = step.on_input.find((b) => b.then === session._pinnedIntent);
            if (pinnedBranch) {
              branchesToEvaluate = step.on_input.filter(
                (b) => b.then === session._pinnedIntent || !b.condition,
              );
            } else {
              // Pinned intent for a different step — skip ON_INPUT entirely
              branchesToEvaluate = [];
            }

            if (onTraceEvent) {
              onTraceEvent({
                type: 'decision',
                data: {
                  type: 'pinned_intent_on_input_filter',
                  agentName: session.agentName,
                  stepName: stepName,
                  pinnedIntent: session._pinnedIntent,
                  totalBranches: step.on_input.length,
                  filteredBranches: branchesToEvaluate.length,
                  pinnedBranchFound: !!pinnedBranch,
                },
              });
            }
          }

          const branchResult =
            branchesToEvaluate.length > 0
              ? evaluateOnInput(
                  branchesToEvaluate,
                  currentMessage,
                  session.data.values,
                  onChunk,
                  onTraceEvent,
                )
              : null;

          if (branchResult) {
            emitDecisionEvent(onTraceEvent, session.traceVerbosity, 'flow_transition', {
              outcome: branchResult.then ?? 'continue',
              condition: 'on_input_match',
              matched: true,
              trigger: { source: 'on_input_match' },
            });

            session._pinnedIntent = undefined;

            const applied = await this.applyOnInputBranchResult(
              session,
              stepName,
              branchResult,
              onChunk,
              onTraceEvent,
            );
            if (applied.outcome === 'break') {
              lastResult = applied.lastResult!;
              break;
            }

            // Emit flow_step_exit and flow_transition for branch
            if (onTraceEvent) {
              onTraceEvent({
                type: 'flow_step_exit',
                data: {
                  agentName: session.agentName,
                  stepName: stepName,
                  durationMs: Date.now() - stepStartTime,
                  result: 'branch',
                },
              });
              onTraceEvent({
                type: 'flow_transition',
                data: {
                  agentName: session.agentName,
                  fromStep: stepName,
                  toStep: branchResult.then,
                  condition: 'on_input_match',
                },
              });
            }

            // Transition to branch target
            const transitionResult = await this.transitionToFlowTarget(session, branchResult.then, {
              currentStep: stepName,
              currentMessage,
              onChunk,
              onTraceEvent,
            });
            if (transitionResult.outcome === 'terminal') {
              lastResult = transitionResult.result;
              break;
            }
            currentMessage = '';
            continue;
          }
        }
      }
      if (session._pinnedIntent) {
        session._pinnedIntent = undefined;
      }

      // ==========================================================================
      // REASONING ZONE: If step has reasoning_zone, invoke reasoning executor.
      // Skip during initialization (empty currentMessage) — reasoning zones
      // require user input and system tools may lack input_schema before the
      // first real message, causing crashes in jsonSchemaToZod.
      // ==========================================================================
      const emptyReasoningGate = resolveReasoningZoneEmptyMessageGate({
        hasReasoningZone: !!step.reasoning_zone,
        currentMessage,
        present: step.present,
        goal: step.reasoning_zone?.goal,
      });
      const effectiveEmptyReasoningGate =
        options?.suppressEmptyReasoningZoneExecution &&
        emptyReasoningGate.mode === 'execute_reasoning_with_goal'
          ? ({ mode: 'park_without_output' } as const)
          : emptyReasoningGate;
      if (
        effectiveEmptyReasoningGate.mode === 'emit_present_and_park' ||
        effectiveEmptyReasoningGate.mode === 'park_without_output'
      ) {
        // During init/auto-transition: emit PRESENT intro verbatim (per ABL spec
        // §3.20.2) before parking for user input. RESPOND is LLM instruction for
        // reasoning steps and is folded into the system prompt on the next turn.
        if (effectiveEmptyReasoningGate.mode === 'emit_present_and_park' && step.present) {
          const presentText = interpolateTemplate(step.present, session.data.values);
          emitProtectedAssistantText(session, presentText, onChunk);
        }
        // Park on this step and wait for user input. Without this break, the flow
        // falls through to THEN and may advance past the reasoning zone step
        // prematurely.
        break;
      }
      const shouldExecuteReasoningZone =
        step.reasoning_zone &&
        (currentMessage || effectiveEmptyReasoningGate.mode === 'execute_reasoning_with_goal');
      if (shouldExecuteReasoningZone) {
        if (!justCollectedInput && hasStepGatherFields(step)) {
          await this.extractStepGatherValuesBeforeReasoning(
            session,
            step,
            stepName,
            currentMessage,
            onTraceEvent,
          );
        }

        const gatherReasoningGate = resolveStepGatherReasoningGate(step, session.data.values);
        if (gatherReasoningGate?.shouldSkipReasoning) {
          log.debug('Skipping reasoning zone while FLOW-step gather owns the turn', {
            agentName: session.agentName,
            stepName,
            gatherComplete: gatherReasoningGate.complete,
            missingFields: gatherReasoningGate.missing,
            allowedToolCount: gatherReasoningGate.allowedToolNames.size,
          });
        } else {
          const buildReasoningZoneSurface = () => {
            // Build system prompt from agent identity + step goal.
            const agentGoal = ir.identity?.goal || '';
            const stepGoal = step.reasoning_zone!.goal || agentGoal;
            const systemPromptParts = [
              ir.identity?.persona ? `You are: ${ir.identity.persona}` : '',
              `Goal: ${stepGoal}`,
              step.reasoning_zone!.constraints?.length
                ? `Constraints:\n${step.reasoning_zone!.constraints.map((c) => `- ${c}`).join('\n')}`
                : '',
            ];

            // Inject step-level RESPOND as turn instruction. In REASONING: true steps
            // RESPOND is an LLM instruction (e.g. "Thank the customer and summarize"),
            // not a literal template — fold it into the system prompt so the LLM acts
            // on it this turn.
            if (step.respond) {
              const instruction = renderLocalizedFlowTemplate(
                session,
                step.respond,
                step.message_key,
              );
              systemPromptParts.push(`Turn instruction: ${instruction}`);
            }

            if (step.reasoning_zone!.exit_when) {
              systemPromptParts.push(
                `Exit condition: ${step.reasoning_zone!.exit_when}. When the user's response satisfies this condition, call __set_context__ with the state updates needed to make the condition true before responding.`,
              );
            }

            const projectedSections = buildPreTurnPromptSections(session);
            if (projectedSections) {
              systemPromptParts.push(projectedSections);
            }

            // Build full tool set (IR tools + dynamic system tools like handoff_to_*,
            // delegate_to_*). FLOW-step GATHER steps are fail-closed here: only
            // explicit same-step tools remain visible once collection is complete.
            const allTools = buildTools(session);
            let stepTools = allTools;
            if (gatherReasoningGate) {
              stepTools = allTools.filter((tool) =>
                gatherReasoningGate.allowedToolNames.has(tool.name),
              );
              stepTools = filterToolsWithMissingStepGatherParameters(
                stepTools,
                step,
                session.data.values,
              );
            } else if (step.reasoning_zone!.available_tools) {
              const allowed = resolveStepGatherAllowedToolNames(step);
              stepTools = allTools.filter((tool) => allowed.has(tool.name));
            }

            return {
              goal: stepGoal,
              systemPrompt: systemPromptParts.filter(Boolean).join('\n\n'),
              tools: stepTools,
            };
          };

          const reasoningZoneSurface = buildReasoningZoneSurface();

          // Check if we have an LLM client
          if (!session.llmClient) {
            const msg = 'Reasoning zone requires LLM credentials — step cannot execute.';
            const protectedMessage = protectAuthoredAssistantText(session, msg);
            if (onChunk) onChunk(protectedMessage.deliveryText);
            lastResult = { response: protectedMessage.deliveryText, action: { type: 'error' } };
            break;
          }

          // Emit reasoning zone trace
          if (onTraceEvent) {
            onTraceEvent({
              type: 'reasoning_zone_enter',
              data: {
                agentName: session.agentName,
                stepName,
                goal: reasoningZoneSurface.goal,
                maxTurns: step.reasoning_zone!.max_turns,
                exitWhen: step.reasoning_zone!.exit_when,
                availableTools: step.reasoning_zone!.available_tools,
              },
            });
          }

          // Import and use reasoning executor
          const reasoningResult = await this.ctx.reasoning.execute(
            session,
            reasoningZoneSurface.systemPrompt,
            reasoningZoneSurface.tools,
            onChunk,
            onTraceEvent,
            {
              surfaceBuilder: async () => buildReasoningZoneSurface(),
            },
          );

          // Check exit condition
          if (step.reasoning_zone!.exit_when) {
            const exitMet = evaluateConditionDual(
              step.reasoning_zone!.exit_when,
              session.data.values,
            );
            if (exitMet && step.then) {
              if (onTraceEvent) {
                onTraceEvent({
                  type: 'reasoning_zone_exit',
                  data: {
                    agentName: session.agentName,
                    stepName,
                    reason: 'exit_condition_met',
                    condition: step.reasoning_zone!.exit_when,
                  },
                });
              }
              const transitionResult = await this.transitionToFlowTarget(session, step.then, {
                currentStep: stepName,
                currentMessage,
                response: reasoningResult.response,
                richContent: reasoningResult.richContent,
                voiceConfig: reasoningResult.voiceConfig,
                actions: reasoningResult.actions,
                localization: reasoningResult.localization,
                onChunk,
                onTraceEvent,
              });
              if (transitionResult.outcome === 'terminal') {
                lastResult = transitionResult.result;
                break;
              }
              currentMessage = '';
              continue;
            }
          }

          // If reasoning produced a response that needs user input, break
          if (
            reasoningResult.action?.type === 'continue' ||
            reasoningResult.action?.type === 'flow'
          ) {
            lastResult = reasoningResult;
            break;
          }

          // If a system tool (handoff, escalate, complete) was triggered
          if (
            reasoningResult.action?.type === 'handoff' ||
            reasoningResult.action?.type === 'escalate' ||
            reasoningResult.action?.type === 'complete'
          ) {
            lastResult = reasoningResult;
            break;
          }

          // Advance to next step if reasoning concluded
          if (step.then) {
            const transitionResult = await this.transitionToFlowTarget(session, step.then, {
              currentStep: stepName,
              currentMessage,
              response: reasoningResult.response,
              richContent: reasoningResult.richContent,
              voiceConfig: reasoningResult.voiceConfig,
              actions: reasoningResult.actions,
              localization: reasoningResult.localization,
              onChunk,
              onTraceEvent,
            });
            if (transitionResult.outcome === 'terminal') {
              lastResult = transitionResult.result;
              break;
            }
            currentMessage = '';
            continue;
          }

          lastResult = reasoningResult;
          break;
        }
      }

      // === ENTITY PIPELINE: Per-turn extraction from ir.entities ===
      const irEntities = session.agentIR?.entities;
      if (irEntities && irEntities.length > 0 && currentMessage) {
        const dateNormalization = getDateNormalizationOptions(session);
        const locale = dateNormalization.locale ?? 'en';
        const turnNumber = session.conversationHistory.length;

        try {
          const observations = extractEntityObservations(
            currentMessage,
            irEntities,
            locale,
            turnNumber,
            {
              referenceInstant: dateNormalization.referenceInstant,
              timezone: dateNormalization.timezone,
            },
          );

          session.observations = observations;

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
          log.warn('Entity pipeline extraction failed in flow step', {
            agentName: session.agentName,
            stepName,
            error: err instanceof Error ? err.message : String(err),
          });
          session.observations = createObservationSet(session.conversationHistory.length);
        }
      }

      // ==========================================================================
      // ENHANCED FLOW: Handle GATHER within flow step (flexible multi-field collection)
      // ==========================================================================
      if (step.gather && step.gather.fields && step.gather.fields.length > 0) {
        // Check which fields still need to be collected
        let { complete, missing } = checkGatherComplete(
          step.gather,
          session.data.values,
          step.complete_when,
        );

        // When a GATHER step is re-entered via auto-advance (loop-back with no user
        // input), force re-collection even if GATHER appears "complete" from the
        // previous iteration's values. Without this, the GATHER skips straight
        // through and creates an infinite auto-advance loop.
        if (complete && !currentMessage && !justCollectedInput && iterations > 1) {
          complete = false;
          missing = step.gather.fields.map((f) => f.name);
        }

        if (!complete) {
          // Try to extract from user message if we have one
          if (justCollectedInput && currentMessage) {
            if (shouldSkipExtraction(currentMessage)) {
              // Skip extraction for trivial input (greetings, acks)
              if (onTraceEvent) {
                onTraceEvent({
                  type: 'dsl_collect',
                  data: {
                    agentName: session.agentName,
                    mode: 'scripted_gather',
                    userInput: currentMessage,
                    skipped: true,
                    reason: 'trivial_input',
                  },
                });
              }
            } else {
              // For LLM extraction, pass all fields (LLM can identify multiple entities in one message)
              // For regex fallback (no LLM), pass only missing fields so progressive collection works
              const fieldsToExtract = session.llmClient
                ? step.gather.fields.map((f) => f.name)
                : missing;
              const rawExtracted = await this.extractEntitiesWithLLM(
                currentMessage,
                fieldsToExtract,
                session,
                onTraceEvent,
                step.gather.fields,
                step.gather.strategy,
              );

              // Validate and normalize, then merge
              const { valid: extractedData } = validateExtractedBatch(
                step.gather.fields,
                rawExtracted,
                getDateNormalizationOptions(session),
              );
              setGatheredValues(session, extractedData);

              // Run GatherExecutor to determine completeness
              try {
                const gatherResult = gatherExecutor.evaluate(
                  step.gather,
                  // Use pre-extraction values (before setGatheredValues merged)
                  Object.fromEntries(
                    Object.entries(session.data.values).filter(
                      ([k]) => !(k in extractedData) || session.data.gatheredKeys.has(k),
                    ),
                  ),
                  extractedData,
                  step.complete_when,
                );
                complete = gatherResult.complete;
                missing = gatherResult.missing;
              } catch (gatherErr) {
                log.warn('GatherExecutor.evaluate failed, falling back to inline check', {
                  agentName: session.agentName,
                  stepName,
                  error: gatherErr instanceof Error ? gatherErr.message : String(gatherErr),
                });
              }

              // Memory: REMEMBER triggers + RECALL on entity events + preference detection
              try {
                await evaluateRememberAfterStateChange(session, onTraceEvent);
                await executeRecallAfterExtraction(
                  session,
                  Object.keys(extractedData),
                  onTraceEvent,
                );
                if (currentMessage) {
                  await detectAndStorePreferences(
                    session,
                    currentMessage,
                    Object.keys(extractedData),
                    onTraceEvent,
                  );
                }
              } catch (err) {
                log.warn('memory operations failed after extraction', {
                  error: err instanceof Error ? err.message : String(err),
                });
              }

              // Emit trace event
              if (onTraceEvent) {
                onTraceEvent({
                  type: 'dsl_collect',
                  data: {
                    agentName: session.agentName,
                    stepName: stepName,
                    mode: 'gather',
                    fields: step.gather.fields.map((f) => f.name),
                    userInput: currentMessage,
                    extracted: extractedData,
                    context: { ...session.data.values },
                  },
                });
              }
            }

            session.waitingForInput = undefined;

            // Recheck completion
            const recheck = checkGatherComplete(
              step.gather,
              session.data.values,
              step.complete_when,
            );

            if (recheck.complete) {
              // All gathered - continue to next step
              // (fall through to execute CALL and THEN)
            } else {
              // Still missing fields - prompt for them
              const clarificationStage = this.incrementClarificationCount(session);
              const prompt = this.buildClarificationPrompt({
                missingFields: recheck.missing,
                defaultPrompt: buildLocalizedGatherPrompt(
                  session,
                  step.gather,
                  recheck.missing,
                  session.data.values,
                ),
                stage: clarificationStage,
              });
              const interpolatedPrompt = interpolateTemplate(prompt, session.data.values);

              const protectedPrompt = emitProtectedAssistantText(
                session,
                interpolatedPrompt,
                onChunk,
              );

              session.waitingForInput = recheck.missing;
              const recheckFormats = resolveGatherFormats(
                step.gather.fields,
                recheck.missing,
                session.data.values,
              );
              const recheckRichContent = resolvePendingRichContent(
                session,
                currentMessage,
                recheckFormats.richContent,
              );
              const recheckVoiceConfig = recheckFormats.voiceConfig;
              rememberPendingRenderedPayload(
                session,
                protectedPrompt.deliveryText,
                recheckRichContent,
                recheckVoiceConfig,
                step.actions,
              );
              lastResult = {
                response: protectedPrompt.deliveryText,
                action: { type: 'collect', fields: recheck.missing, mode: 'gather' },
                stateUpdates: buildStateUpdates(session),
                voiceConfig: recheckVoiceConfig,
                richContent: recheckRichContent,
                actions: step.actions,
              };
              break;
            }
          } else {
            // Show PRESENT template first (intro before collection per ABL spec §3.20.2).
            // Backward-compat: if no PRESENT but the step has both GATHER and RESPOND,
            // treat RESPOND as the gather intro (legacy agents used RESPOND this way).
            const introText =
              step.present || (step.gather && step.respond ? step.respond : undefined);
            if (introText) {
              const presentText = renderLocalizedFlowTemplate(
                session,
                introText,
                step.present ? undefined : step.message_key,
              );
              const protectedPresentText = protectAuthoredAssistantText(session, presentText);
              if (onChunk) onChunk(`${protectedPresentText.deliveryText}\n\n`);
              session.conversationHistory.push({
                role: 'assistant',
                content: protectedPresentText.historyText,
              });
            }

            // Prompt for missing fields
            const prompt = buildLocalizedGatherPrompt(
              session,
              step.gather,
              missing,
              session.data.values,
            );
            const interpolatedPrompt = interpolateTemplate(prompt, session.data.values);

            if (onTraceEvent) {
              onTraceEvent({
                type: 'dsl_prompt',
                data: {
                  agentName: session.agentName,
                  stepName: stepName,
                  mode: 'gather',
                  missingFields: missing,
                  template: prompt,
                  rendered: interpolatedPrompt,
                  context: session.data.values,
                },
              });
            }

            const protectedPrompt = emitProtectedAssistantText(
              session,
              interpolatedPrompt,
              onChunk,
            );

            session.waitingForInput = missing;
            const initialFormats = resolveGatherFormats(
              step.gather.fields,
              missing,
              session.data.values,
            );
            const initialRichContent = resolvePendingRichContent(
              session,
              currentMessage,
              initialFormats.richContent,
            );
            const initialVoiceConfig = initialFormats.voiceConfig;
            rememberPendingRenderedPayload(
              session,
              protectedPrompt.deliveryText,
              initialRichContent,
              initialVoiceConfig,
              step.actions,
            );
            lastResult = {
              response: protectedPrompt.deliveryText,
              action: { type: 'collect', fields: missing, mode: 'gather' },
              stateUpdates: buildStateUpdates(session),
              voiceConfig: initialVoiceConfig,
              richContent: initialRichContent,
              actions: step.actions,
            };
            break;
          }
        }
        // If GATHER is complete, fall through to execute CALL and THEN
      }

      // ==========================================================================
      // AWAIT_ATTACHMENT: Suspend until user uploads a matching attachment
      // ==========================================================================
      if (step.await_attachment) {
        const { executeAwaitAttachment } = await import('./await-attachment-executor.js');
        const awaitResult = executeAwaitAttachment(
          session,
          step as { await_attachment: typeof step.await_attachment; name: string },
          currentMessage,
          onChunk,
          onTraceEvent,
        );

        if (!awaitResult.advance) {
          // Still waiting for attachment — return wait signal (same as GATHER suspension)
          const awaitRichContent = resolvePendingRichContent(
            session,
            currentMessage,
            awaitResult.result.richContent,
          );
          rememberPendingRenderedPayload(
            session,
            awaitResult.result.response ?? '',
            awaitRichContent,
          );
          lastResult = {
            ...awaitResult.result,
            richContent: awaitRichContent,
          };
          break;
        }

        // Attachment received (or timeout with onTimeout step)
        if (awaitResult.result.action.type === 'timeout' && awaitResult.result.action.nextStep) {
          // Transition to the onTimeout step
          const transitionResult = await this.transitionToFlowTarget(
            session,
            awaitResult.result.action.nextStep as string,
            {
              currentStep: stepName,
              currentMessage,
              response: awaitResult.result.response,
              richContent: awaitResult.result.richContent,
              voiceConfig: awaitResult.result.voiceConfig,
              actions: awaitResult.result.actions,
              localization: awaitResult.result.localization,
              onChunk,
              onTraceEvent,
            },
          );
          if (transitionResult.outcome === 'terminal') {
            lastResult = transitionResult.result;
            break;
          }
          currentMessage = '';
          continue;
        }

        // Attachment received — fall through to execute CALL and THEN
      }

      // If step has RESPOND + ON_INPUT but no GATHER, show prompt and wait for ON_INPUT
      // This handles steps like promo_check that have interactive prompts without collecting
      if (
        step.respond &&
        step.on_input &&
        step.on_input.length > 0 &&
        !step.gather &&
        !currentMessage
      ) {
        const hasInteractiveActionHandlers = stepHasInteractiveActionHandlers(step);
        const promptText = step.respond;
        const interpolatedPrompt = renderLocalizedFlowTemplate(
          session,
          promptText,
          step.message_key,
        );
        const promptVoiceConfig = step.voice_config
          ? interpolateVoiceConfig(step.voice_config, session.data.values)
          : undefined;
        const promptRichContent = resolvePendingRichContent(
          session,
          currentMessage,
          step.rich_content
            ? interpolateRichContent(step.rich_content, session.data.values)
            : undefined,
        );

        // Emit ABL PROMPT trace event
        if (onTraceEvent) {
          onTraceEvent({
            type: 'dsl_prompt',
            data: {
              agentName: session.agentName,
              stepName: stepName,
              template: promptText,
              rendered: interpolatedPrompt,
              context: session.data.values,
              hasOnInput: true,
            },
          });
        }

        const protectedPrompt = interpolatedPrompt
          ? emitProtectedAssistantText(session, interpolatedPrompt, onChunk)
          : undefined;
        rememberPendingRenderedPayload(
          session,
          protectedPrompt?.deliveryText ?? interpolatedPrompt,
          promptRichContent,
          promptVoiceConfig,
          step.actions,
        );

        // Mark as waiting for ON_INPUT response (use special marker)
        session.waitingForInput = ['_on_input_'];
        let actionRenderId: string | undefined;
        if (hasInteractiveActionHandlers) {
          actionRenderId = armActionWait(session, stepName);
        }
        lastResult = {
          response: protectedPrompt?.deliveryText ?? interpolatedPrompt,
          action: hasInteractiveActionHandlers
            ? { type: 'waiting_for_action' }
            : { type: 'prompt', step: stepName },
          stateUpdates: buildStateUpdates(session),
          voiceConfig: promptVoiceConfig,
          richContent: promptRichContent,
          actions: actionRenderId ? withActionRenderId(step.actions, actionRenderId) : step.actions,
        };
        break;
      }

      // STRUCTURAL CONSTRAINT CHECK: BEFORE calling (tool_call checkpoint)
      const configuredStepToolName = getToolInvocationToolName({
        call: step.call,
        call_spec: step.call_spec,
      });
      if (configuredStepToolName) {
        const callCheckpointViolation = checkFlatConstraintsAtCheckpoint(
          session,
          { kind: 'tool_call', target: configuredStepToolName },
          onTraceEvent,
        );
        if (callCheckpointViolation) {
          lastResult = await executeConstraintViolation(session, callCheckpointViolation, {
            onChunk,
            onTraceEvent,
            executeHandoff: async (input, chunk, trace) => {
              return this.routing.handleHandoff(session, input, chunk, trace);
            },
          });
          break;
        }
      }

      // Now we have all collected data (if any), execute CALL
      let callSuccess = true;
      let callResult: Record<string, unknown> | undefined;
      let handledErrorResponse:
        | {
            response?: string;
            localization?: ExecutionResult['localization'];
            richContent?: RichContentIR;
            voiceConfig?: VoiceConfigIR;
            actions?: ActionSetIR;
          }
        | undefined;
      if (step.call || step.call_spec) {
        const { toolName: executedStepToolName, result } =
          await this.executeConfiguredToolInvocation(
            session,
            {
              call: step.call,
              call_spec: step.call_spec,
              call_with: step.call_with,
              call_as: step.call_as,
            },
            {
              source: 'flow_step',
              stepName,
            },
            onTraceEvent,
            onChunk,
          );
        callResult = result;

        // ON_ERROR action propagation — flow mode (Bruce feedback 2.3).
        // The error handler returned metadata via reserved keys; act on it here
        // so `THEN: handoff` and `THEN: backtrack_to` don't silently drop.
        // The `__error` guard ensures a successful tool whose return value
        // happens to contain `__error_handler_*` keys cannot hijack control flow.
        const isHandledError = Boolean(callResult && callResult.__error);
        if (isHandledError && callResult.__error_handler_action === 'handoff') {
          const handoffTarget = callResult.__error_handler_handoff_target;
          if (typeof handoffTarget === 'string' && handoffTarget.length > 0) {
            try {
              const handoffResult = await this.routing.handleHandoff(
                session,
                { target: handoffTarget },
                onChunk,
                onTraceEvent,
              );
              lastResult = buildHandoffExecutionResult(session, handoffTarget, handoffResult);
            } catch {
              /* routing errors are traced by the router itself; fall through */
            }
            break;
          }
        }

        if (isHandledError && callResult.__error_handler_action === 'backtrack') {
          const backtrackTo = callResult.__error_handler_backtrack_to;
          if (typeof backtrackTo === 'string' && backtrackTo.length > 0) {
            session.currentFlowStep = backtrackTo;
            currentMessage = '';
            continue;
          }
        }

        if (isHandledError && callResult.__error_handler_action === 'continue') {
          handledErrorResponse = {
            localization:
              callResult.__error_handler_localization as ExecutionResult['localization'],
          };
        }

        this.bindToolInvocationResult(
          session,
          {
            call: step.call,
            call_spec: step.call_spec,
            call_with: step.call_with,
            call_as: step.call_as,
          },
          executedStepToolName,
          callResult,
          'step',
          `call:${step.call ?? executedStepToolName ?? 'unknown'}`,
          onTraceEvent,
        );

        // Memory: REMEMBER triggers + RECALL after tool call
        try {
          await evaluateRememberAfterStateChange(session, onTraceEvent);
          if (executedStepToolName) {
            await executeRecallAfterToolCall(session, executedStepToolName, onTraceEvent);
          }
        } catch (err) {
          log.warn('memory operations failed after call step', {
            error: err instanceof Error ? err.message : String(err),
          });
        }

        // Determine if call was successful
        // Check success_when from step definition first, then use generic detection
        if (step.success_when) {
          callSuccess = evaluateConditionDual(step.success_when, {
            ...session.data.values,
            _result: callResult,
          });
        } else {
          // Generic detection: check for error indicators
          callSuccess =
            !callResult!._error && callResult!.error === undefined && callResult!.success !== false;
        }
      }

      // ==========================================================================
      // ON_RESULT: Multi-way branching on call result (before ON_SUCCESS/ON_FAILURE)
      // Also supports deterministic gate steps (no CALL): branches evaluate against
      // session vars and the current user message, enabling REASONING:false + ON_RESULT
      // gate patterns used by orchestrators.
      // ==========================================================================
      if (step.on_result && step.on_result.length > 0) {
        const resultContext = { ...session.data.values };
        const stepResultKey = getToolInvocationResultKey({
          call: step.call,
          call_spec: step.call_spec,
          call_as: step.call_as,
        });
        // If an explicit result binding was used, the result is already in session.data.values.
        // If not, spread callResult into context for condition evaluation
        if (callResult && !stepResultKey) Object.assign(resultContext, callResult);

        // For deterministic gate steps (no CALL), evaluate branch conditions against
        // the current user message; for CALL steps, the result has already been merged
        // into resultContext, so input matching is not used.
        const userInputForBranch = callResult ? '' : currentMessage;
        const branchTriggerSource = callResult ? 'call_result' : 'flow_context';

        const matchedBranch = evaluateOnInput(
          step.on_result,
          userInputForBranch,
          resultContext,
          undefined,
          onTraceEvent,
        );

        if (matchedBranch) {
          emitDecisionEvent(onTraceEvent, session.traceVerbosity, 'flow_transition', {
            outcome: matchedBranch.then ?? 'continue',
            condition: 'on_result_match',
            matched: true,
            trigger: { source: branchTriggerSource },
          });

          // Apply SET assignments from the branch
          if (matchedBranch.set) {
            await this.applySetAssignmentsAndRemember(session, matchedBranch.set, {
              source: `on_result:${stepName}`,
              onTraceEvent,
              resolveValue: (rawValue) => interpolateTemplate(String(rawValue), resultContext),
            });
          }
          if (matchedBranch.call || matchedBranch.call_spec) {
            const branchToolName = getToolInvocationToolName(matchedBranch);
            if (branchToolName) {
              const violation = checkFlatConstraintsAtCheckpoint(
                session,
                { kind: 'tool_call', target: branchToolName },
                onTraceEvent,
              );
              if (violation) {
                lastResult = await executeConstraintViolation(session, violation, {
                  onChunk,
                  onTraceEvent,
                  executeHandoff: async (input, chunk, trace) => {
                    return this.routing.handleHandoff(session, input, chunk, trace);
                  },
                });
                break;
              }
            }

            const { toolName, result: branchCallResult } =
              await this.executeConfiguredToolInvocation(
                session,
                {
                  call: matchedBranch.call,
                  call_spec: matchedBranch.call_spec,
                },
                {
                  source: 'on_result',
                  stepName,
                },
                onTraceEvent,
                onChunk,
              );

            this.bindToolInvocationResult(
              session,
              {
                call: matchedBranch.call,
                call_spec: matchedBranch.call_spec,
              },
              toolName,
              branchCallResult,
              'branch',
              `on_result:${stepName}`,
              onTraceEvent,
            );

            try {
              await evaluateRememberAfterStateChange(session, onTraceEvent);
              if (toolName) {
                await executeRecallAfterToolCall(session, toolName, onTraceEvent);
              }
            } catch (err) {
              log.warn('memory operations failed after on_result branch call', {
                error: err instanceof Error ? err.message : String(err),
              });
            }
          }
          const branchVoiceConfig = matchedBranch.voice_config
            ? interpolateVoiceConfig(matchedBranch.voice_config, session.data.values)
            : undefined;
          const branchRichContent = matchedBranch.rich_content
            ? interpolateRichContent(matchedBranch.rich_content, session.data.values)
            : undefined;
          const branchActions = matchedBranch.actions
            ? interpolateActionSet(matchedBranch.actions, session.data.values)
            : undefined;

          // Emit response if the branch has one
          let protectedBranchResponse: { deliveryText: string; historyText: string } | undefined;
          if (matchedBranch.respond) {
            const matchedBranchMessageKey = (matchedBranch as { message_key?: string }).message_key;
            const msg = renderLocalizedFlowTemplate(
              session,
              matchedBranch.respond,
              matchedBranchMessageKey,
            );
            protectedBranchResponse = protectAuthoredAssistantText(session, msg);
            if (onChunk) {
              onChunk(protectedBranchResponse.deliveryText);
            }
          }
          if (
            matchedBranch.respond ||
            hasAuthoredStructuredPayload({
              richContent: branchRichContent,
              voiceConfig: branchVoiceConfig,
              actions: branchActions,
            })
          ) {
            appendProtectedAssistantHistoryPayload(
              session,
              protectedBranchResponse?.historyText ?? '',
              {
                richContent: branchRichContent,
                voiceConfig: branchVoiceConfig,
                actions: branchActions,
              },
            );
          }
          rememberPendingRenderedPayload(
            session,
            protectedBranchResponse?.deliveryText ?? '',
            branchRichContent,
            branchVoiceConfig,
            branchActions,
          );
          // Transition to branch target
          if (matchedBranch.then) {
            // Emit flow_step_exit and flow_transition
            if (onTraceEvent) {
              onTraceEvent({
                type: 'flow_step_exit',
                data: {
                  agentName: session.agentName,
                  stepName: stepName,
                  durationMs: Date.now() - stepStartTime,
                  result: 'on_result_branch',
                },
              });
              onTraceEvent({
                type: 'flow_transition',
                data: {
                  agentName: session.agentName,
                  fromStep: stepName,
                  toStep: matchedBranch.then,
                  condition: 'on_result_match',
                },
              });
            }
            const transitionResult = await this.transitionToFlowTarget(
              session,
              matchedBranch.then,
              {
                currentStep: stepName,
                currentMessage,
                onChunk,
                onTraceEvent,
              },
            );
            if (transitionResult.outcome === 'terminal') {
              lastResult = transitionResult.result;
              break;
            }
            currentMessage = '';
            continue; // re-enter while loop
          }
        }
      }

      // ==========================================================================
      // TRANSFORM: Array pipeline (filter -> map -> sort_by -> limit)
      // ==========================================================================
      if (step.transform) {
        const {
          source,
          item_var: itemVar,
          target,
          filter,
          map,
          sort_by: sortBy,
          limit,
        } = step.transform;
        const sourceArray = session.data.values[source];

        if (Array.isArray(sourceArray)) {
          let transformed = [...sourceArray];

          // FILTER
          if (filter) {
            transformed = transformed.filter((item) => {
              const ctx = { ...session.data.values, [itemVar]: item };
              return evaluateConditionDual(filter, ctx);
            });
          }

          // MAP
          if (map) {
            const mapEntries = Object.entries(map);
            transformed = transformed.map((item) => {
              const ctx = { ...session.data.values, [itemVar]: item };
              const mapped: Record<string, unknown> = {};
              for (const [key, expr] of mapEntries) {
                mapped[key] = resolveValueDual(String(expr), ctx);
              }
              return mapped;
            });
          }

          // SORT_BY
          if (sortBy) {
            transformed.sort((a: unknown, b: unknown) => {
              const va = (a as Record<string, unknown>)?.[sortBy.field];
              const vb = (b as Record<string, unknown>)?.[sortBy.field];
              const cmp =
                va == null && vb == null
                  ? 0
                  : va == null
                    ? -1
                    : vb == null
                      ? 1
                      : va < vb
                        ? -1
                        : va > vb
                          ? 1
                          : 0;
              return sortBy.order === 'desc' ? -cmp : cmp;
            });
          }

          // LIMIT
          if (limit != null && limit > 0) {
            transformed = transformed.slice(0, limit);
          }

          session.data.values[target] = transformed;

          if (onTraceEvent) {
            onTraceEvent({
              type: 'dsl_transform',
              data: {
                agentName: session.agentName,
                stepName: stepName,
                source,
                target,
                inputCount: sourceArray.length,
                outputCount: transformed.length,
                hasFilter: !!filter,
                hasMap: !!map,
                hasSortBy: !!sortBy,
                limit: limit ?? null,
              },
            });
          }
        }
      }

      // Determine response and next step based on success/failure branches
      let response: string = '';
      let responseTemplate: string = '';
      let responseSource: 'on_success' | 'on_failure' | 'step' = 'step';
      let nextStep: string | undefined;
      let stepVoiceConfig: VoiceConfigIR | undefined;
      let stepRichContent: RichContentIR | undefined;
      let stepActions: ActionSetIR | undefined;
      let responseLocalization: ExecutionResult['localization'] | undefined;
      let responseMessageKey: string | undefined;
      let interruptCurrentStep = false;

      if (step.call && (step.on_success || step.on_failure)) {
        // Use branching logic for CALL steps with ON_SUCCESS/ON_FAILURE
        const block = callSuccess ? step.on_success : step.on_failure;
        responseSource = callSuccess ? 'on_success' : 'on_failure';

        if (block) {
          if (block.branches && block.branches.length > 0) {
            // Conditional form: evaluate branches in order, first match wins
            for (const branch of block.branches) {
              let matched = false;
              if (!branch.condition) {
                // ELSE branch (no condition) — always matches as fallback
                matched = true;
              } else {
                // IF branch — evaluate condition against session data
                matched = evaluateConditionDual(branch.condition, session.data.values);
              }

              if (matched) {
                applyCallResultSetAssignments(branch.set, session.data.values);

                if (branch.call || branch.call_spec) {
                  const branchToolName = getToolInvocationToolName(branch);
                  if (branchToolName) {
                    const violation = checkFlatConstraintsAtCheckpoint(
                      session,
                      { kind: 'tool_call', target: branchToolName },
                      onTraceEvent,
                    );
                    if (violation) {
                      lastResult = await executeConstraintViolation(session, violation, {
                        onChunk,
                        onTraceEvent,
                        executeHandoff: async (input, chunk, trace) => {
                          return this.routing.handleHandoff(session, input, chunk, trace);
                        },
                      });
                      interruptCurrentStep = true;
                      break;
                    }
                  }

                  const { toolName, result: branchCallResult } =
                    await this.executeConfiguredToolInvocation(
                      session,
                      {
                        call: branch.call,
                        call_spec: branch.call_spec,
                      },
                      {
                        source: 'call_result_branch',
                        stepName,
                      },
                      onTraceEvent,
                      onChunk,
                    );

                  this.bindToolInvocationResult(
                    session,
                    {
                      call: branch.call,
                      call_spec: branch.call_spec,
                    },
                    toolName,
                    branchCallResult,
                    'branch',
                    `${responseSource}:${stepName}`,
                    onTraceEvent,
                  );

                  try {
                    await evaluateRememberAfterStateChange(session, onTraceEvent);
                    if (toolName) {
                      await executeRecallAfterToolCall(session, toolName, onTraceEvent);
                    }
                  } catch (err) {
                    log.warn('memory operations failed after call result branch call', {
                      error: err instanceof Error ? err.message : String(err),
                    });
                  }
                }

                response = branch.respond || '';
                responseTemplate = branch.respond || '';
                responseMessageKey = branch.message_key;
                stepVoiceConfig = branch.voice_config;
                stepRichContent = branch.rich_content;
                stepActions = branch.actions;
                nextStep = branch.then;
                break;
              }
            }
          } else {
            // Simple form: single respond + then
            applyCallResultSetAssignments(block.set, session.data.values);
            response = block.respond || '';
            responseTemplate = block.respond || '';
            responseMessageKey = block.message_key;
            stepVoiceConfig = block.voice_config;
            stepRichContent = block.rich_content;
            stepActions = block.actions;
            nextStep = block.then;
          }
        }
      } else {
        // Default: use step.respond and step.then
        response = step.respond || '';
        responseTemplate = step.respond || '';
        responseMessageKey = step.message_key;
        stepVoiceConfig = step.voice_config;
        stepRichContent = step.rich_content;
        stepActions = step.actions;
        responseSource = 'step';
        nextStep = step.then;
      }

      if (
        handledErrorResponse &&
        !response &&
        stepVoiceConfig === undefined &&
        stepRichContent === undefined &&
        stepActions === undefined
      ) {
        response = handledErrorResponse.response ?? '';
        responseTemplate = handledErrorResponse.response ?? '';
        responseSource = 'on_failure';
        stepVoiceConfig = handledErrorResponse.voiceConfig;
        stepRichContent = handledErrorResponse.richContent;
        stepActions = handledErrorResponse.actions;
        responseLocalization = handledErrorResponse.localization;
      }

      if (interruptCurrentStep) {
        break;
      }

      // Resolve next step via FlowExecutor
      if (ir.flow) {
        try {
          const flowResult = flowExecutor.resolveNextStep(stepName, ir.flow, visited, {
            callSuccess,
            evaluateCondition: evaluateConditionDual,
            context: session.data.values,
          });
          nextStep = flowResult.nextStep;
        } catch (err) {
          log.warn('FlowExecutor.resolveNextStep failed, using inline nextStep', {
            agentName: session.agentName,
            sessionId: session.id,
            step: stepName,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }

      // STRUCTURAL CONSTRAINT CHECK: BEFORE responding (response checkpoint)
      if (response) {
        const respondCheckpointViolation = checkFlatConstraintsAtCheckpoint(
          session,
          { kind: 'response', target: stepName },
          onTraceEvent,
        );
        if (respondCheckpointViolation) {
          lastResult = await executeConstraintViolation(session, respondCheckpointViolation, {
            onChunk,
            onTraceEvent,
            executeHandoff: async (input, chunk, trace) => {
              return this.routing.handleHandoff(session, input, chunk, trace);
            },
          });
          break;
        }
      }

      // Interpolate template with collected data (now includes call results)
      response = renderLocalizedFlowTemplate(session, response, responseMessageKey);
      const interpolatedVoiceConfig = stepVoiceConfig
        ? interpolateVoiceConfig(stepVoiceConfig, session.data.values)
        : undefined;
      const interpolatedRichContent = stepRichContent
        ? interpolateRichContent(stepRichContent, session.data.values)
        : undefined;
      const interpolatedActions = stepActions
        ? interpolateActionSet(stepActions, session.data.values)
        : undefined;
      let approvedVoiceConfig = interpolatedVoiceConfig;
      let approvedRichContent = interpolatedRichContent;
      let approvedActions = interpolatedActions;
      const clearStructuredResponsePayload = () => {
        approvedVoiceConfig = undefined;
        approvedRichContent = undefined;
        approvedActions = undefined;
      };

      // Output guardrails: evaluate response before delivery (DSL + policy-defined)
      const flowPolicy = await getSessionPolicy(session);
      const hasDslGuardrails = !!session.agentIR?.constraints?.guardrails?.length;
      const hasPolicyGuardrails = !!flowPolicy?.additionalGuardrails?.length;
      if (response && (hasDslGuardrails || hasPolicyGuardrails)) {
        const llmEval = session.llmClient ? createLLMEvalFromClient(session.llmClient) : undefined;
        const guardrailResult = await checkOutputGuardrails(
          response,
          session.agentIR?.constraints?.guardrails ?? [],
          { agentGoal: session.agentIR?.identity?.goal },
          flowPolicy,
          llmEval,
          session.tenantId,
          session,
          onTraceEvent,
        );

        if (!guardrailResult.passed && guardrailResult.violation) {
          if (onTraceEvent) {
            onTraceEvent({
              type: 'constraint_check',
              data: {
                agentName: session.agentName,
                kind: 'output',
                guardrailName: guardrailResult.violation.guardrailName,
                action: guardrailResult.violation.action,
                message: guardrailResult.violation.message,
                passed: false,
              },
            });
          }

          if (guardrailResult.violation.action === 'block') {
            response = guardrailResult.violation.message || 'I cannot provide that response.';
            clearStructuredResponsePayload();
          } else if (guardrailResult.violation.action === 'escalate') {
            session.data.values._escalated = true;
            response = guardrailResult.violation.message || 'Escalating to a human agent.';
            clearStructuredResponsePayload();
          } else if (guardrailResult.violation.action === 'reask') {
            // Flow RESPOND steps use templates, not LLM generation — reask is
            // inapplicable (there is no LLM call to retry). Emit trace and
            // fall back to block behavior.
            const reaskDecision = shouldExecuteReask({
              primaryAction: 'reask',
              primaryMessage: guardrailResult.violation.message,
              hasReaskViolation: true,
              isStreaming: !!onChunk,
            });
            if (onTraceEvent) {
              onTraceEvent({
                type:
                  reaskDecision.skipReason === 'streaming'
                    ? 'guardrail_reask_skipped_streaming'
                    : 'guardrail_reask',
                data: {
                  agentName: session.agentName,
                  guardrailName: guardrailResult.violation.guardrailName,
                  reason: 'Reask not applicable for flow template RESPOND steps',
                  fallbackAction: 'block',
                },
              });
            }
            response = guardrailResult.violation.message || 'I cannot provide that response.';
            clearStructuredResponsePayload();
          }
        } else if (guardrailResult.modifiedContent) {
          // Non-terminal action (redact/fix/filter) modified the output
          response = guardrailResult.modifiedContent;
          clearStructuredResponsePayload();
        }
      }

      // Emit ABL RESPOND trace event
      if (response && onTraceEvent) {
        onTraceEvent({
          type: 'dsl_respond',
          data: {
            agentName: session.agentName,
            stepName: stepName,
            template: responseTemplate,
            rendered: response,
            source: responseSource,
            callSuccess: step.call ? callSuccess : undefined,
          },
        });
      }
      const protectedResponse = response
        ? protectAuthoredAssistantText(session, response)
        : undefined;
      if (response && onChunk) {
        onChunk(protectedResponse?.deliveryText ?? response);
      }
      appendProtectedAssistantHistoryPayload(session, protectedResponse?.historyText ?? '', {
        richContent: approvedRichContent,
        voiceConfig: approvedVoiceConfig,
        actions: approvedActions,
      });
      rememberPendingRenderedPayload(
        session,
        protectedResponse?.deliveryText ?? response,
        approvedRichContent,
        approvedVoiceConfig,
        approvedActions,
      );
      response = protectedResponse?.deliveryText ?? response;

      // Check if carousel cards contain any buttons
      const carouselHasButtons =
        approvedRichContent?.carousel?.cards?.some((c) => c.buttons && c.buttons.length > 0) ??
        false;

      // Pause for user action if step has interactive actions (standalone or carousel) with handlers
      if (
        ((approvedActions && approvedActions.elements.length > 0) || carouselHasButtons) &&
        step.on_action &&
        step.on_action.length > 0
      ) {
        const actionRenderId = armActionWait(session, stepName);
        lastResult = {
          response: resolvePendingResponse(session, currentMessage, response),
          action: { type: 'waiting_for_action' },
          richContent: resolvePendingRichContent(session, currentMessage, approvedRichContent),
          actions: withActionRenderId(
            resolvePendingActions(session, currentMessage, approvedActions),
            actionRenderId,
          ),
          voiceConfig: resolvePendingVoiceConfig(session, currentMessage, approvedVoiceConfig),
          ...(responseLocalization !== undefined ? { localization: responseLocalization } : {}),
        };
        break;
      }

      // Advance to next step
      if (nextStep) {
        // Emit flow_step_exit and flow_transition
        if (onTraceEvent) {
          onTraceEvent({
            type: 'flow_step_exit',
            data: {
              agentName: session.agentName,
              stepName: stepName,
              durationMs: Date.now() - stepStartTime,
              result: callSuccess ? 'completed' : 'failed',
            },
          });
          onTraceEvent({
            type: 'flow_transition',
            data: {
              agentName: session.agentName,
              fromStep: stepName,
              toStep: nextStep,
              condition: callSuccess ? 'on_success' : 'on_failure',
            },
          });
        }

        const transitionResult = await this.transitionToFlowTarget(session, nextStep, {
          currentStep: stepName,
          currentMessage,
          response,
          richContent: approvedRichContent,
          voiceConfig: approvedVoiceConfig,
          actions: approvedActions,
          localization: responseLocalization,
          onChunk,
          onTraceEvent,
        });
        if (transitionResult.outcome === 'terminal') {
          lastResult = transitionResult.result;
          break;
        }

        // Check completion conditions before auto-advancing, but ONLY for loop-back
        // transitions (when we're about to revisit a step already executed in this chain).
        // Forward-progressing flows must execute the next step first — otherwise COMPLETE
        // conditions that are trivially true (e.g., "x IS SET OR true") fire prematurely
        // and skip steps that haven't run yet (like greeting steps after a check step).
        if (visited.has(nextStep)) {
          const completionBeforeAdvance = this.routing.checkCompletionConditions(
            session,
            onChunk,
            onTraceEvent,
            {
              source: 'loop_back_pre_advance',
              currentStep: stepName,
              nextStep,
            },
          );
          if (completionBeforeAdvance) {
            lastResult = completionBeforeAdvance;
            break;
          }
        } else if (onTraceEvent) {
          onTraceEvent({
            type: 'engine_decision',
            data: {
              decision: 'skip_completion_check',
              reason: 'forward_progressing_transition',
              currentStep: stepName,
              nextStep,
              agent: session.agentName,
            },
          });
        }

        // Auto-advance to next step
        if (onTraceEvent) {
          onTraceEvent({
            type: 'engine_decision',
            data: {
              decision: 'auto_advance',
              fromStep: stepName,
              toStep: nextStep,
              agent: session.agentName,
              chainDepth: visited.size,
            },
          });
        }

        currentMessage = '';
        continue;
      }

      // Emit flow_step_exit for step without transition
      if (onTraceEvent) {
        onTraceEvent({
          type: 'flow_step_exit',
          data: {
            agentName: session.agentName,
            stepName: stepName,
            durationMs: Date.now() - stepStartTime,
            result: 'waiting',
          },
        });
      }

      // AUTO-COMPLETION: Check completion conditions for terminal steps (no THEN)
      const completionResult = this.routing.checkCompletionConditions(
        session,
        onChunk,
        onTraceEvent,
        {
          source: 'terminal_step',
          currentStep: stepName,
        },
      );
      if (completionResult) {
        lastResult = completionResult;
        break;
      }

      // Schedule debounced persist after flow step execution
      this.ctx.debouncedPersist(session);

      lastResult = {
        response: resolvePendingResponse(session, currentMessage, response),
        action: { type: 'flow', step: stepName },
        stateUpdates: buildStateUpdates(session),
        voiceConfig: resolvePendingVoiceConfig(session, currentMessage, approvedVoiceConfig),
        richContent: resolvePendingRichContent(session, currentMessage, approvedRichContent),
        actions: resolvePendingActions(session, currentMessage, approvedActions),
        ...(responseLocalization !== undefined ? { localization: responseLocalization } : {}),
      };
      break;
    }

    // If we exhausted the iteration limit, emit an error trace
    if (iterations >= MAX_CHAIN_ITERATIONS && onTraceEvent) {
      onTraceEvent({
        type: 'error',
        data: {
          message: `Flow step chain exceeded maximum iterations (${MAX_CHAIN_ITERATIONS})`,
          agent: session.agentName,
          lastStep: session.currentFlowStep,
        },
      });
    }

    // ========================================================================
    // POST-COMPLETION INTENT QUEUE SURFACING
    // After primary flow completes, check if there are queued intents
    // from multi-intent detection that should be surfaced to the user.
    // ========================================================================
    if (lastResult.action?.type === 'complete' && session.intentQueue?.pending?.length) {
      const agentIR = session.agentIR;
      if (agentIR) {
        const multiConfig = resolveMultiIntentConfig(agentIR);
        const maxAge = multiConfig.queue_max_age_ms;

        pruneExpired(session.intentQueue, maxAge);

        const next = peekNext(session.intentQueue);
        if (next) {
          const intentLabel = getPendingIntentDisplayLabel(next);
          const surfaceMessage = resolveLocalizedAgentMessageWithMetadata({
            session,
            messageKey: 'multi_intent_queued_notice',
            fallbackMessage:
              session.agentIR?.messages?.multi_intent_queued_notice ||
              DEFAULT_MESSAGES.multi_intent_queued_notice,
          });

          // Append the queued-intent notice to the completion response
          const noticeText = renderQueuedIntentNoticeMessage({
            intentLabel,
            resolveMessage: buildLocalizedMessageResolver(session),
            noticeFallback: surfaceMessage.text,
          });
          const protectedNotice = protectAuthoredAssistantText(session, noticeText);
          lastResult = {
            ...lastResult,
            response: lastResult.response
              ? `${lastResult.response}\n\n${protectedNotice.deliveryText}`
              : protectedNotice.deliveryText,
          };

          // Stream the notice if chunking is active
          if (onChunk) {
            onChunk(`\n\n${protectedNotice.deliveryText}`);
            session.conversationHistory.push({
              role: 'assistant',
              content: protectedNotice.historyText,
            });
          } else {
            emitProtectedAssistantText(session, noticeText);
          }

          // Signal that we're waiting for the user to confirm the queued intent
          session.waitingForInput = ['_queued_intent_confirmation_'];

          if (onTraceEvent) {
            onTraceEvent({
              type: 'multi_intent_queue_surfaced',
              data: {
                agent: session.agentName,
                queuedIntent: next.intent,
                queuedIntentLabel: intentLabel,
                queuedIntentTarget: next.target?.ref ?? null,
                queuedIntentConfidence: next.confidence,
                remainingCount: session.intentQueue.pending.length,
              },
            });
          }

          log.debug('Surfaced queued intent after completion', {
            agent: session.agentName,
            intent: next.intent,
            remaining: session.intentQueue.pending.length,
          });
        }
      }
    }

    return protectExecutionResultStructuredPayload(session, lastResult) ?? lastResult;
  }
}
