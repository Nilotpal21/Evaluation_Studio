/**
 * Event Processor
 *
 * Transforms flat ExtendedTraceEvent[] from the observatory store
 * into grouped Interaction[] with step classification.
 */

import type { ExtendedTraceEvent } from '../../../types';
import type {
  Interaction,
  InteractionStep,
  InteractionStepType,
  SessionSummary,
  AgentPathNode,
  AgentSwitch,
  ProcessedInteractions,
  LifecycleBanner,
  SessionResolution,
  ToolCallStepItem,
} from './types';
import { normalizeEventType } from '../../../lib/event-types';
import {
  EVENT_TO_STEP,
  ERROR_EVENT_TYPES,
  COMPLETED_TOOL_CALL_EVENT_TYPES,
  WARNING_EVENT_TYPES,
  SCRIPTED_MODE_EVENTS,
  LIFECYCLE_EVENTS,
  SESSION_EVENTS,
} from './constants';
import {
  formatShortTraceId,
  getTraceCausalFields,
  getTraceSpanId,
} from '../../../utils/trace-causality';

export type { ProcessedInteractions };

interface FlowStepContext {
  agentName: string;
  flowStepName: string;
  flowStepType?: string;
  flowStepRunId?: string;
  flowIteration?: number;
}

/**
 * Process a flat array of trace events into grouped interactions.
 *
 * Transforms raw trace events from the observatory store into a structured
 * turn-by-turn narrative with interaction grouping, step classification,
 * agent path tracking, and session statistics.
 *
 * @param events - Flat array of trace events from useObservatoryStore
 * @returns Processed interactions with summary, agent path, and switches
 *
 * @remarks
 * - Sorts events by timestamp
 * - Groups events by user_message boundaries
 * - Filters out pure-init interactions (no user input or agent response)
 * - Performance: Logs warning if events > 500 or processing time > 100ms
 *
 * @example
 * ```ts
 * const events = useObservatoryStore((s) => s.events);
 * const { interactions, summary, agentPath } = processEventsToInteractions(events);
 * ```
 */
export function processEventsToInteractions(events: ExtendedTraceEvent[]): ProcessedInteractions {
  if (events.length === 0) {
    return {
      interactions: [],
      summary: emptySummary(''),
      agentPath: [],
      agentSwitches: [],
      resolution: null,
    };
  }

  const startTime = performance.now();

  const sorted = [...events].sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());

  const sessionId = sorted[0].sessionId;
  const groups = groupByUserMessage(sorted);
  const eventByReference = buildEventReferenceMap(sorted);
  const allInteractions = groups.map((group, i) =>
    buildInteraction(group, i + 1, eventByReference),
  );

  // L3: Preserve trailing events - Filter out ONLY pure-init interactions, not trailing events
  // A trailing interaction is meaningful if it has steps beyond just decisions/transitions
  // (e.g., session_resolution, tool calls, memory operations)
  const interactions = allInteractions.filter((interaction) => {
    const hasUserOrResponse = interaction.steps.some(
      (s) => s.type === 'user_input' || s.type === 'agent_response',
    );
    if (hasUserOrResponse) return true;

    // Preserve interactions with meaningful trailing events
    const meaningfulTypes = new Set([
      'tool_call',
      'parallel_tools',
      'llm_call',
      'memory_diff',
      'error',
      'output_guard',
      'decision',
    ]);
    const hasMeaningfulSteps = interaction.steps.some((s) => meaningfulTypes.has(s.type));
    return hasMeaningfulSteps;
  });
  // Re-index after filtering
  interactions.forEach((interaction, i) => {
    interaction.index = i + 1;
    interaction.id = `interaction-${i + 1}`;
  });

  const summary = buildSummary(sessionId, sorted, interactions);
  const agentPath = buildAgentPath(sorted);
  const agentSwitches = buildAgentSwitches(interactions);
  const resolution = buildResolution(sorted);

  return { interactions, summary, agentPath, agentSwitches, resolution };
}

function groupByUserMessage(sorted: ExtendedTraceEvent[]): ExtendedTraceEvent[][] {
  const groups: ExtendedTraceEvent[][] = [];
  let current: ExtendedTraceEvent[] = [];

  for (const event of sorted) {
    const eventType = normalizeEventType(event.type);
    const isUserMessage = eventType === 'user_message';

    if (isUserMessage && current.length > 0) {
      const hasSteps = current.some((e) => EVENT_TO_STEP[normalizeEventType(e.type)] != null);
      if (hasSteps) {
        // Pre-user events contain real steps (e.g. welcome message) — keep as own interaction
        groups.push(current);
        current = [event];
      } else {
        // Pure init events with no steps — fold into first user message group
        current.push(event);
      }
    } else {
      current.push(event);
    }
  }

  if (current.length > 0) {
    groups.push(current);
  }

  return groups;
}

function buildInteraction(
  events: ExtendedTraceEvent[],
  index: number,
  eventByReference: Map<string, ExtendedTraceEvent>,
): Interaction {
  const { steps, banners } = classifyStepsAndBanners(events, eventByReference);
  const displaySteps = mergeDuplicateResponseSteps(steps);
  const displayBanners = mergeDuplicateLifecycleBanners(banners);
  const agentName = detectPrimaryAgent(events);
  const entryAgentName = detectEntryAgent(events);
  const agentMode = detectAgentMode(events);
  const status = determineStatus(events);

  const startTime = events[0].timestamp;
  const endTime = events[events.length - 1].timestamp;
  const durationMs = endTime.getTime() - startTime.getTime();

  return {
    id: `interaction-${index}`,
    index,
    agentName,
    entryAgentName,
    agentMode,
    status,
    startTime,
    endTime,
    durationMs,
    steps: displaySteps,
    banners: displayBanners,
  };
}

function classifyStepsAndBanners(
  events: ExtendedTraceEvent[],
  eventByReference: Map<string, ExtendedTraceEvent>,
): {
  steps: InteractionStep[];
  banners: LifecycleBanner[];
} {
  const steps: InteractionStep[] = [];
  const banners: LifecycleBanner[] = [];
  let currentStep: InteractionStep | null = null;
  const activeFlowStepsByAgent = new Map<string, FlowStepContext>();

  for (let eventIndex = 0; eventIndex < events.length; eventIndex += 1) {
    const event = events[eventIndex];
    const previousEvent = findAdjacentNonLifecycleEvent(events, eventIndex, -1);
    const flowStepContext = resolveFlowStepContext(event, activeFlowStepsByAgent);

    const eventType = normalizeEventType(event.type);

    // Lifecycle events → banners (not steps)
    if (LIFECYCLE_EVENTS.has(eventType)) {
      banners.push(buildLifecycleBanner(event, previousEvent, eventByReference));
      continue;
    }

    // Session events → skip (handled separately by buildResolution)
    if (SESSION_EVENTS.has(eventType)) {
      continue;
    }

    const stepType = EVENT_TO_STEP[eventType] as InteractionStepType | undefined;

    // Skip late-fired tool_call events for handoff/delegate action tools.
    // These events are emitted AFTER the child agent finishes (so their timestamp
    // is after all child steps), but the type:'handoff' event emitted before the
    // child runs already captures the intent at the correct position in the timeline.
    // Showing both creates a duplicate "handoff_to_*" entry after the child's response.
    if (stepType === 'tool_call') {
      const toolName =
        (event.data.toolName as string | undefined) ??
        (event.data.tool as string | undefined) ??
        (event.data.name as string | undefined) ??
        '';
      if (toolName.startsWith('handoff_to_') || toolName.startsWith('delegate_to_')) {
        if (currentStep) currentStep.events.push(event);
        continue;
      }
    }

    if (stepType) {
      // A1: Break step grouping when agent changes to prevent cross-agent event merging.
      // Tool steps can still merge same-agent events, but step.data.toolCalls preserves
      // distinct sibling tool invocations for downstream rendering.
      const canMergeWithCurrent =
        currentStep &&
        currentStep.type === stepType &&
        event.agentName === currentStep.agentName &&
        hasCompatibleFlowStepContext(currentStep, flowStepContext);

      if (canMergeWithCurrent && currentStep) {
        currentStep.events.push(event);
        if (event.durationMs) {
          currentStep.durationMs = (currentStep.durationMs ?? 0) + event.durationMs;
        }
        mergeFlowStepContext(currentStep, flowStepContext);
        mergeStepData(currentStep, event);
      } else {
        currentStep = {
          id: `step-${event.id}`,
          type: stepType,
          timestamp: event.timestamp,
          durationMs: event.durationMs,
          agentName: event.agentName,
          ...flowStepContext,
          events: [event],
          data: extractStepData(stepType, event),
        };
        steps.push(currentStep);
      }
    } else if (currentStep) {
      currentStep.events.push(event);
      mergeFlowStepContext(currentStep, flowStepContext);
    }

    if (normalizeEventType(event.type) === 'flow_step_exit' && flowStepContext) {
      activeFlowStepsByAgent.delete(flowStepContext.agentName);
    }
  }

  return { steps, banners };
}

function resolveFlowStepContext(
  event: ExtendedTraceEvent,
  activeFlowStepsByAgent: Map<string, FlowStepContext>,
): FlowStepContext | undefined {
  const data = event.data ?? {};
  const agentName = pickString(data.agentName, data.agent, event.agentName);
  if (!agentName) {
    return undefined;
  }

  const eventType = normalizeEventType(event.type);
  const explicitStepName = pickString(data.flowStepName, data.stepName, data.step);
  const explicitContext = explicitStepName
    ? {
        agentName,
        flowStepName: explicitStepName,
        flowStepType: pickString(data.flowStepType, data.stepType),
        flowStepRunId: pickString(data.flowStepRunId),
        flowIteration: pickNumber(data.flowIteration),
      }
    : undefined;

  if (explicitContext && eventType !== 'flow_step_exit') {
    activeFlowStepsByAgent.set(agentName, explicitContext);
    return explicitContext;
  }

  return explicitContext ?? activeFlowStepsByAgent.get(agentName);
}

function hasCompatibleFlowStepContext(
  step: InteractionStep,
  flowStepContext: FlowStepContext | undefined,
): boolean {
  const existingKey = step.flowStepRunId ?? step.flowStepName;
  const nextKey = flowStepContext?.flowStepRunId ?? flowStepContext?.flowStepName;

  if (!existingKey && !nextKey) {
    return true;
  }

  return existingKey !== undefined && existingKey === nextKey;
}

function mergeFlowStepContext(
  step: InteractionStep,
  flowStepContext: FlowStepContext | undefined,
): void {
  if (!flowStepContext) {
    return;
  }
  step.flowStepName ??= flowStepContext.flowStepName;
  step.flowStepType ??= flowStepContext.flowStepType;
  step.flowStepRunId ??= flowStepContext.flowStepRunId;
  step.flowIteration ??= flowStepContext.flowIteration;
}

function mergeDuplicateResponseSteps(steps: InteractionStep[]): InteractionStep[] {
  const mergedSteps: InteractionStep[] = [];
  const responseByContent = new Map<string, InteractionStep>();

  for (const step of steps) {
    if (step.type !== 'agent_response') {
      mergedSteps.push(step);
      continue;
    }

    const responseContent = normalizeResponseContent(step.data.content);
    const existing = responseContent ? responseByContent.get(responseContent) : undefined;
    if (existing && shouldMergeResponseSteps(existing, step)) {
      existing.events.push(...step.events);
      existing.durationMs = mergeDuration(existing.durationMs, step.durationMs);
      existing.data = {
        ...step.data,
        ...existing.data,
        content: existing.data.content ?? step.data.content,
        mergedResponseEventCount: existing.events.length,
      };
      continue;
    }

    mergedSteps.push(step);
    if (responseContent) {
      responseByContent.set(responseContent, step);
    }
  }

  return mergedSteps;
}

function shouldMergeResponseSteps(existing: InteractionStep, candidate: InteractionStep): boolean {
  const existingTypes = new Set(existing.events.map((event) => normalizeEventType(event.type)));
  const candidateTypes = new Set(candidate.events.map((event) => normalizeEventType(event.type)));
  const existingHasScriptedResponse =
    existingTypes.has('dsl_respond') || existingTypes.has('dsl_prompt');
  const candidateHasScriptedResponse =
    candidateTypes.has('dsl_respond') || candidateTypes.has('dsl_prompt');
  const existingHasFinalResponse = existingTypes.has('agent_response');
  const candidateHasFinalResponse = candidateTypes.has('agent_response');

  return (
    (existingHasScriptedResponse && candidateHasFinalResponse) ||
    (existingHasFinalResponse && candidateHasScriptedResponse)
  );
}

function normalizeResponseContent(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const normalized = value.replace(/\s+/g, ' ').trim();
  return normalized.length > 0 ? normalized : undefined;
}

function mergeDuration(
  existingDuration: number | undefined,
  candidateDuration: number | undefined,
): number | undefined {
  if (existingDuration === undefined) {
    return candidateDuration;
  }
  if (candidateDuration === undefined) {
    return existingDuration;
  }
  return existingDuration + candidateDuration;
}

function mergeDuplicateLifecycleBanners(banners: LifecycleBanner[]): LifecycleBanner[] {
  const merged: LifecycleBanner[] = [];
  const recentByKey = new Map<string, LifecycleBanner>();

  for (const banner of banners) {
    const key = [
      banner.kind,
      banner.agentName,
      banner.targetAgent ?? '',
      banner.parentAgent ?? '',
      banner.reasonCode ?? '',
      banner.trigger ?? '',
      banner.result ?? '',
      banner.status ?? '',
      banner.phase ?? '',
      banner.agentRunId ?? '',
    ].join('\u0000');
    const previous = recentByKey.get(key);
    if (previous && Math.abs(banner.timestamp.getTime() - previous.timestamp.getTime()) <= 10) {
      continue;
    }

    merged.push(banner);
    recentByKey.set(key, banner);
  }

  return merged;
}

function buildLifecycleBanner(
  event: ExtendedTraceEvent,
  previousEvent: ExtendedTraceEvent | undefined,
  eventByReference: Map<string, ExtendedTraceEvent>,
): LifecycleBanner {
  const data = event.data ?? {};
  const causal = getTraceCausalFields(event);
  const causeEvent = causal.causeEventId ? eventByReference.get(causal.causeEventId) : undefined;
  const kind = normalizeEventType(event.type) as LifecycleBanner['kind'];
  const agentName =
    event.agentName ??
    pickString(data.agentName, data.sourceAgent, data.agent, data.fromAgent) ??
    'unknown';
  const targetAgent = pickString(data.targetAgent, data.toAgent, data.target, data.to);
  const parentAgent = pickString(data.fromAgent, data.parentAgent, data.sourceAgent, data.from);
  const trigger = pickString(data.trigger, data.entryReason, data.source);
  const result = pickString(data.result, data.exitReason, data.outcome);
  const status = pickString(data.status, data.state);
  const durationMs = pickNumber(data.durationMs, event.durationMs);
  const reasonCode = causal.reasonCode ?? pickString(data.reasonCode, data.reason_code);
  const causeLabel = causeEvent
    ? `${normalizeEventType(causeEvent.type)} ${formatShortTraceId(causeEvent.id)}`
    : !causal.causeEventId && previousEvent
      ? `${normalizeEventType(previousEvent.type)} ${formatShortTraceId(previousEvent.id)}`
      : undefined;
  const reason = summarizeLifecycleReason({
    kind,
    agentName,
    trigger,
    result,
    status,
    reasonCode,
    targetAgent,
    parentAgent,
    previousEvent,
  });

  return {
    id: `banner-${event.id}`,
    timestamp: event.timestamp,
    kind,
    agentName,
    targetAgent,
    parentAgent,
    event,
    reason,
    reasonDetail: buildLifecycleReasonDetail({
      trigger,
      result,
      status,
      reasonCode,
      causeLabel,
      previousEvent,
    }),
    trigger,
    result,
    status,
    durationMs,
    causeEventId: causal.causeEventId,
    causeLabel,
    reasonCode,
    phase: causal.phase,
    agentRunId: causal.agentRunId,
  };
}

function buildEventReferenceMap(events: ExtendedTraceEvent[]): Map<string, ExtendedTraceEvent> {
  const eventByReference = new Map<string, ExtendedTraceEvent>();
  for (const event of events) {
    eventByReference.set(event.id, event);
    const spanId = getTraceSpanId(event);
    if (spanId) {
      eventByReference.set(spanId, event);
    }
  }
  return eventByReference;
}

function findAdjacentNonLifecycleEvent(
  events: ExtendedTraceEvent[],
  startIndex: number,
  direction: -1 | 1,
): ExtendedTraceEvent | undefined {
  for (
    let index = startIndex + direction;
    index >= 0 && index < events.length;
    index += direction
  ) {
    const event = events[index];
    const eventType = normalizeEventType(event.type);
    if (!LIFECYCLE_EVENTS.has(eventType) && !SESSION_EVENTS.has(eventType)) {
      return event;
    }
  }
  return undefined;
}

function summarizeLifecycleReason(input: {
  kind: LifecycleBanner['kind'];
  agentName?: string;
  trigger?: string;
  result?: string;
  status?: string;
  reasonCode?: string;
  targetAgent?: string;
  parentAgent?: string;
  previousEvent?: ExtendedTraceEvent;
}): string {
  const previousType = input.previousEvent
    ? normalizeEventType(input.previousEvent.type)
    : undefined;

  switch (input.kind) {
    case 'agent_enter':
      if (input.trigger === 'user_message' || previousType === 'user_message') {
        return 'Started after user input';
      }
      if (input.trigger === 'delegate') {
        return input.parentAgent
          ? `Entered because ${input.parentAgent} delegated work`
          : 'Entered by delegation';
      }
      if (input.trigger === 'handoff') {
        return input.parentAgent
          ? `Entered by handoff from ${input.parentAgent}`
          : 'Entered by handoff';
      }
      if (input.trigger === 'fan_out') {
        return 'Entered as part of fan-out execution';
      }
      if (input.trigger === 'resume_intent') {
        return 'Resumed an existing intent';
      }
      if (previousType === 'decision' || previousType === 'handoff') {
        return 'Entered after routing decision';
      }
      return humanizeCode(input.reasonCode) ?? 'Agent run started';

    case 'agent_exit':
      if (input.result === 'error' || input.status === 'error' || previousType === 'error') {
        return 'Exited after runtime error';
      }
      if (input.result === 'constraint_blocked') {
        return 'Exited because a constraint blocked execution';
      }
      if (input.result === 'handoff') {
        if (input.targetAgent === input.agentName) {
          return previousType === 'agent_response' || previousType === 'message.agent.sent'
            ? 'Parent agent finished after handoff returned'
            : 'Parent handoff run ended';
        }
        return input.targetAgent && input.targetAgent !== input.agentName
          ? `Exited after handoff to ${input.targetAgent}`
          : 'Exited after handoff';
      }
      if (input.result === 'escalate') {
        return 'Exited after escalation';
      }
      if (
        input.result === 'completed' ||
        input.result === 'continue' ||
        previousType === 'agent_response' ||
        previousType === 'execution.completed' ||
        previousType === 'message.agent.sent'
      ) {
        return 'Exited after response completed';
      }
      return input.result
        ? `Exited with result: ${humanizeCode(input.result)}`
        : (humanizeCode(input.reasonCode) ?? 'Agent run ended');

    case 'delegate_start':
      return input.targetAgent
        ? `Delegated execution to ${input.targetAgent}`
        : 'Delegated execution started';

    case 'delegate_complete':
      return input.targetAgent
        ? `Delegated execution completed for ${input.targetAgent}`
        : 'Delegated execution completed';

    case 'handoff_return_handler':
      return input.targetAgent
        ? `Prepared return handling for ${input.targetAgent}`
        : 'Prepared handoff return handling';

    case 'resume_intent':
      return input.agentName
        ? `Resumed intent for ${input.agentName}`
        : 'Resumed an existing intent';

    case 'thread_resume':
      return input.agentName ? `Resumed thread for ${input.agentName}` : 'Resumed thread';

    case 'return_to_parent':
      if (input.parentAgent && input.targetAgent) {
        return `${input.parentAgent} returned control to ${input.targetAgent}`;
      }
      return input.targetAgent
        ? `Returned control to ${input.targetAgent}`
        : 'Returned control to parent';

    case 'thread_return':
      if (input.parentAgent && input.targetAgent) {
        return `${input.parentAgent} returned control to ${input.targetAgent}`;
      }
      return input.targetAgent
        ? `Returned control to ${input.targetAgent}`
        : 'Returned control to parent thread';
  }
}

function buildLifecycleReasonDetail(input: {
  trigger?: string;
  result?: string;
  status?: string;
  reasonCode?: string;
  causeLabel?: string;
  previousEvent?: ExtendedTraceEvent;
}): string | undefined {
  const details = [
    input.trigger ? `trigger=${input.trigger}` : undefined,
    input.result ? `result=${input.result}` : undefined,
    input.status ? `status=${input.status}` : undefined,
    input.reasonCode ? `reasonCode=${input.reasonCode}` : undefined,
    input.causeLabel ? `cause=${input.causeLabel}` : undefined,
    input.previousEvent ? `previous=${normalizeEventType(input.previousEvent.type)}` : undefined,
  ].filter(Boolean);

  return details.length > 0 ? details.join(' · ') : undefined;
}

function pickString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === 'string' && value.length > 0) {
      return value;
    }
  }
  return undefined;
}

function pickNumber(...values: unknown[]): number | undefined {
  for (const value of values) {
    if (typeof value === 'number' && Number.isFinite(value)) {
      return value;
    }
  }
  return undefined;
}

function humanizeCode(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  return value
    .replace(/[_:.-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function extractStepData(
  stepType: InteractionStepType,
  event: ExtendedTraceEvent,
): Record<string, unknown> {
  const d = event.data;
  const eventType = String(event.type);

  switch (stepType) {
    case 'user_input':
      return {
        content: d.content ?? d.message ?? '',
        inputKind:
          d.inputKind ??
          d.messageSource ??
          (eventType === 'delegated_message' ? 'delegated' : undefined),
        sourceAgent: d.sourceAgent ?? d.fromAgent,
      };

    case 'llm_call': {
      const usage = d.usage as Record<string, unknown> | undefined;
      return {
        model: d.model ?? 'unknown',
        tokensIn: usage?.inputTokens ?? d.tokensIn ?? d.promptTokens ?? 0,
        tokensOut: usage?.outputTokens ?? d.tokensOut ?? d.completionTokens ?? 0,
        cost: d.cost ?? 0,
        contextWindowSize: d.contextWindowSize ?? usage?.contextWindowSize ?? 0,
        prompt: d.prompt ?? d.systemMessage,
      };
    }

    case 'tool_call':
      return buildToolCallStepData(event);

    case 'agent_response':
      return {
        content: d.content ?? d.rendered ?? d.text ?? d.message ?? d.response ?? '',
        contentLength: d.contentLength,
      };

    case 'decision': {
      // Infer kind from data.decisionKind first, then fall back to event type.
      // Events like 'handoff', 'completion_check', 'engine_decision',
      // 'handoff_condition_check' don't carry decisionKind — the event type IS the kind.
      const eventType = normalizeEventType(event.type);
      // L1: Use || null instead of ?? for string fields to fall through on empty strings
      const decisionType =
        ((d.decisionKind as string) || null) ??
        (eventType !== 'decision' ? eventType : null) ??
        ((d.decision as string) || null) ??
        // Infer from data shape when nothing explicit is set
        (d.toAgent || d.to ? 'handoff' : null) ??
        (d.fromStep || d.toStep ? 'flow_transition' : null) ??
        (d.guardrailName ? 'guardrail_check' : null) ??
        (d.field && d.violation != null ? 'field_validation' : null) ??
        (eventType === 'correction' || eventType === 'correction_invalidation'
          ? 'correction'
          : null) ??
        (eventType === 'digression' ? 'digression' : null) ??
        (eventType === 'sub_intent' ? 'sub_intent' : null) ??
        (eventType === 'pipeline_intent_bridge' ? 'intent_bridge' : null) ??
        (eventType === 'pipeline_tiered_action' ? 'tiered_action' : null) ??
        (eventType === 'pipeline_out_of_scope_decline' ? 'out_of_scope' : null) ??
        (eventType === 'escalation' ? 'escalation' : null) ??
        (eventType === 'constraint_check' ? 'constraint_check' : null) ??
        (eventType === 'validation_fail_open' ? 'field_validation' : null) ??
        // Never show "unknown" — use the event type which humanizes to "Decision"
        eventType;

      return {
        decisionType,
        target: d.target ?? d.toAgent ?? d.to,
        reason: d.reason ?? d.handoffReason ?? d.reasoning ?? d.summary ?? d.text,
        outcome: d.outcome ?? d.result,
        condition: d.condition,
        matched: d.matched ?? d.result,
        field: d.field,
        violation: d.violation,
        trigger: d.trigger,
        candidates: d.candidates,
        source: d.source,
        action: d.action,
        thought: d.thought,
        toolName: d.toolName,
        operation: d.operation,
        from: d.from,
        agent: d.agent,
      };
    }

    case 'error':
      return {
        message: d.message ?? d.error ?? (typeof d.code === 'string' ? d.code : 'Unknown error'),
        code: d.code ?? d.errorCode,
        severity: event.type === 'warning' ? 'warning' : 'error',
      };

    case 'input_guard':
    case 'output_guard':
      return {
        checkType: d.checkType ?? d.guardName ?? event.type,
        result: d.result ?? d.outcome ?? 'unknown',
        confidence: d.confidence ?? d.score,
        details: d.details ?? d.message,
      };

    case 'gather':
      return {
        fields: d.fields,
        confidence: d.confidence,
        extractedValues: d.extractedValues ?? d.values ?? d.extracted,
        requestedFields: d.requestedFields,
        extractedFields: d.extractedFields,
        missingFields: d.missingFields ?? d.missing,
        userMessage: d.userMessage ?? d.userInput,
        method: d.method,
        mode: d.mode,
        skipped: d.skipped,
        skipReason: d.reason,
        stepName: d.stepName,
        complete: d.complete,
      };

    case 'flow_transition':
      return {
        fromStep: d.fromStep ?? d.previousStep,
        toStep: d.toStep ?? d.nextStep ?? d.step,
        conditions: d.conditions ?? d.transitionConditions,
        variableResolutions: d.variableResolutions,
      };

    case 'memory_diff':
      return {
        key: d.key ?? d.field,
        value: d.value,
        source: d.source ?? d.tool,
        contextBefore: d.contextBefore,
        contextAfter: d.contextAfter,
        sourceMap: d.sourceMap,
        readKeys: d.readKeys,
        memoryType: d.memoryType,
        operation: d.operation ?? event.type,
        query: d.query,
        found: d.found,
        preferences: d.preferences,
        trigger: d.trigger,
        result: d.result,
        reason: d.reason,
        preference: d.preference,
      };

    case 'parallel_tools':
      return {
        taskCount: d.taskCount ?? d.parallelCount,
        tasks: d.tasks,
      };

    case 'retry':
      return {
        attempt: d.attempt ?? d.retryCount,
        maxRetries: d.maxRetries,
        backoffMs: d.backoffMs ?? d.delayMs,
      };

    default:
      return { ...d };
  }
}

function mergeStepData(step: InteractionStep, event: ExtendedTraceEvent): void {
  const d = event.data;

  switch (step.type) {
    case 'tool_call': {
      mergeToolCallStepData(step, event);
      break;
    }

    case 'llm_call': {
      const usage = d.usage as Record<string, unknown> | undefined;
      if (usage || d.tokensOut || d.completionTokens) {
        step.data.tokensOut =
          usage?.outputTokens ?? d.tokensOut ?? d.completionTokens ?? step.data.tokensOut;
      }
      if (d.cost) step.data.cost = d.cost;
      break;
    }

    case 'gather': {
      // Merge extraction results from subsequent entity_extraction events
      const vals = (d.extractedValues ?? d.values ?? d.extracted) as
        | Record<string, unknown>
        | undefined;
      if (vals) {
        const existing = (step.data.extractedValues ?? {}) as Record<string, unknown>;
        step.data.extractedValues = { ...existing, ...vals };
      }
      if (d.requestedFields) step.data.requestedFields = d.requestedFields;
      if (d.extractedFields) step.data.extractedFields = d.extractedFields;
      if (d.missingFields) step.data.missingFields = d.missingFields;
      if (d.userMessage ?? d.userInput) step.data.userMessage = d.userMessage ?? d.userInput;
      if (d.method) step.data.method = d.method;
      // Merge new gather sub-events
      if (d.strategy) step.data.strategy = d.strategy;
      if (d.completeReason) step.data.completeReason = d.completeReason;
      if (d.directive) step.data.directive = d.directive;
      if (event.type === 'dsl_on_input') {
        step.data.userInput = d.userInput ?? d.input ?? d.content;
      }
      if (event.type === 'dsl_await_attachment') {
        step.data.awaitingAttachment = true;
      }
      if (event.type === 'gather_field_activation') {
        const activated = (step.data.activatedFields ?? []) as string[];
        const fieldName = (d.field ?? d.fieldName) as string | undefined;
        // L7: Bound gather field arrays to prevent unbounded growth in long loops
        if (fieldName && activated.length < 50) {
          activated.push(fieldName);
        }
        step.data.activatedFields = activated;
      }
      if (event.type === 'constraint_backtrack') {
        step.data.backtracked = true;
        step.data.backtrackField = d.field ?? d.fieldName;
      }
      if (event.type === 'constraint_backtrack_limit') {
        step.data.backtrackLimitHit = true;
      }
      if (event.type === 'constraint_mini_collect') {
        const miniFields = (step.data.miniCollectFields ?? []) as string[];
        const fieldName = (d.field ?? d.fieldName) as string | undefined;
        // L7: Bound gather field arrays to prevent unbounded growth in long loops
        if (fieldName && miniFields.length < 50) {
          miniFields.push(fieldName);
        }
        step.data.miniCollectFields = miniFields;
      }
      break;
    }

    default:
      break;
  }
}

function buildToolCallStepData(event: ExtendedTraceEvent): Record<string, unknown> {
  const toolCall = createToolCallItem(event);
  return {
    tool: toolCall.tool,
    input: toolCall.input,
    result: toolCall.result,
    status: toolCall.status,
    error: toolCall.error,
    latencyMs: toolCall.durationMs,
    url: toolCall.url,
    method: toolCall.method,
    authType: toolCall.authType,
    authHeaderName: toolCall.authHeaderName,
    authHeaderPrefix: toolCall.authHeaderPrefix,
    headerNames: toolCall.headerNames,
    queryParams: toolCall.queryParams,
    toolCalls: [toolCall],
    toolCallCount: 1,
  };
}

function mergeToolCallStepData(step: InteractionStep, event: ExtendedTraceEvent): void {
  const existingToolCalls = Array.isArray(step.data.toolCalls)
    ? (step.data.toolCalls as ToolCallStepItem[])
    : [];
  const toolCalls =
    existingToolCalls.length > 0 ? existingToolCalls : [createToolCallItem(step.events[0])];
  const matchingToolCall = findMatchingToolCall(toolCalls, event);

  if (matchingToolCall) {
    mergeToolCallItem(matchingToolCall, event);
  } else {
    toolCalls.push(createToolCallItem(event));
  }

  syncToolCallStepData(step.data, toolCalls);
}

function syncToolCallStepData(data: Record<string, unknown>, toolCalls: ToolCallStepItem[]): void {
  data.toolCalls = toolCalls;
  data.toolCallCount = toolCalls.length;

  const primaryToolCall = toolCalls[0];
  if (!primaryToolCall) {
    return;
  }

  data.tool = primaryToolCall.tool;
  data.status = toolCalls.some((toolCall) => toolCall.status === 'failed') ? 'failed' : 'success';

  if (toolCalls.length === 1) {
    data.input = primaryToolCall.input;
    data.result = primaryToolCall.result;
    data.error = primaryToolCall.error;
    data.latencyMs = primaryToolCall.durationMs;
    data.url = primaryToolCall.url;
    data.method = primaryToolCall.method;
    data.authType = primaryToolCall.authType;
    data.authHeaderName = primaryToolCall.authHeaderName;
    data.authHeaderPrefix = primaryToolCall.authHeaderPrefix;
    data.headerNames = primaryToolCall.headerNames;
    data.queryParams = primaryToolCall.queryParams;
    return;
  }

  delete data.input;
  delete data.result;
  delete data.error;
  delete data.latencyMs;
  delete data.url;
  delete data.method;
  delete data.authType;
  delete data.authHeaderName;
  delete data.authHeaderPrefix;
  delete data.headerNames;
  delete data.queryParams;
}

function createToolCallItem(event: ExtendedTraceEvent): ToolCallStepItem {
  const d = event.data;

  return {
    id: getToolCallKey(event),
    tool: getToolName(d),
    input: d.input ?? d.args ?? d.params,
    result: d.result ?? d.output,
    status: d.error ? 'failed' : d.success === false ? 'failed' : 'success',
    error: d.error,
    durationMs: getToolDuration(event),
    url: getStringValue(d.url ?? d.endpoint ?? d.uri),
    method: getStringValue(d.method ?? d.httpMethod),
    authType: getStringValue(d.authType),
    authHeaderName: getStringValue(d.authHeaderName),
    authHeaderPrefix: getStringValue(d.authHeaderPrefix),
    headerNames: getStringArray(d.headerNames),
    queryParams: getStringRecord(d.queryParams),
    eventIds: [event.id],
  };
}

function mergeToolCallItem(toolCall: ToolCallStepItem, event: ExtendedTraceEvent): void {
  const d = event.data;

  if (!toolCall.eventIds.includes(event.id)) {
    toolCall.eventIds.push(event.id);
  }

  if (toolCall.tool === 'unknown') {
    toolCall.tool = getToolName(d);
  }

  if (toolCall.input === undefined && (d.input ?? d.args ?? d.params) !== undefined) {
    toolCall.input = d.input ?? d.args ?? d.params;
  }

  if (isToolCompletionEvent(event)) {
    toolCall.result = d.result ?? d.output ?? toolCall.result;
    toolCall.status = d.error ? 'failed' : d.success === false ? 'failed' : 'success';
  }

  if (d.error !== undefined) {
    toolCall.error = d.error;
  }

  const durationMs = getToolDuration(event);
  if (durationMs !== undefined) {
    toolCall.durationMs = durationMs;
  }

  if (!toolCall.url) {
    toolCall.url = getStringValue(d.url ?? d.endpoint ?? d.uri);
  }
  if (!toolCall.method) {
    toolCall.method = getStringValue(d.method ?? d.httpMethod);
  }
  if (!toolCall.authType) {
    toolCall.authType = getStringValue(d.authType);
  }
  if (!toolCall.authHeaderName) {
    toolCall.authHeaderName = getStringValue(d.authHeaderName);
  }
  if (!toolCall.authHeaderPrefix) {
    toolCall.authHeaderPrefix = getStringValue(d.authHeaderPrefix);
  }
  if (!toolCall.headerNames) {
    toolCall.headerNames = getStringArray(d.headerNames);
  }
  if (!toolCall.queryParams) {
    toolCall.queryParams = getStringRecord(d.queryParams);
  }
}

function findMatchingToolCall(
  toolCalls: ToolCallStepItem[],
  event: ExtendedTraceEvent,
): ToolCallStepItem | undefined {
  const explicitKey = getExplicitToolCallKey(event);
  if (explicitKey) {
    const matchByExplicitKey = toolCalls.find((toolCall) => toolCall.id === explicitKey);
    if (matchByExplicitKey) {
      return matchByExplicitKey;
    }
  }

  if (event.type === 'tool_result') {
    const toolName = getToolName(event.data);
    if (toolName !== 'unknown') {
      const matchingNames = toolCalls.filter((toolCall) => toolCall.tool === toolName);
      if (matchingNames.length === 1) {
        return matchingNames[0];
      }
    }

    if (toolCalls.length === 1) {
      return toolCalls[0];
    }

    const incompleteToolCalls = toolCalls.filter(
      (toolCall) => toolCall.result === undefined && toolCall.error === undefined,
    );
    if (incompleteToolCalls.length === 1) {
      return incompleteToolCalls[0];
    }
  }

  return undefined;
}

function getToolCallKey(event: ExtendedTraceEvent): string {
  return getExplicitToolCallKey(event) ?? `event:${event.id}`;
}

function getExplicitToolCallKey(event: ExtendedTraceEvent): string | null {
  const d = event.data;
  const candidates = [d.toolCallId, d.callId, d.toolUseId, d.tool_use_id];
  for (const candidate of candidates) {
    const value = getStringValue(candidate);
    if (value) {
      return `call:${value}`;
    }
  }

  const spanId = getStringValue(event.spanId);
  return spanId ? `span:${spanId}` : null;
}

function getToolName(data: Record<string, unknown>): string {
  return getStringValue(data.tool ?? data.toolName ?? data.name) ?? 'unknown';
}

function getToolDuration(event: ExtendedTraceEvent): number | undefined {
  const latency = event.data.latencyMs;
  if (typeof latency === 'number') {
    return latency;
  }
  return event.durationMs;
}

function isToolCompletionEvent(event: ExtendedTraceEvent): boolean {
  const d = event.data;
  const normalizedEventType = normalizeEventType(event.type);
  const hasCompletionPayload =
    d.result !== undefined ||
    d.output !== undefined ||
    d.error !== undefined ||
    d.success !== undefined;

  return (
    event.type === 'tool_result' || (normalizedEventType === 'tool_call' && hasCompletionPayload)
  );
}

function getStringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function getStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }

  const items = value.filter((item): item is string => typeof item === 'string' && item.length > 0);
  return items.length > 0 ? items : undefined;
}

function getStringRecord(value: unknown): Record<string, string> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }

  const entries = Object.entries(value).filter(
    (entry): entry is [string, string] => typeof entry[1] === 'string',
  );
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

function detectPrimaryAgent(events: ExtendedTraceEvent[]): string {
  const counts = new Map<string, number>();
  for (const e of events) {
    if (e.agentName) {
      counts.set(e.agentName, (counts.get(e.agentName) ?? 0) + 1);
    }
  }

  let best = 'unknown';
  let bestCount = 0;
  for (const [name, count] of counts) {
    if (count > bestCount) {
      best = name;
      bestCount = count;
    }
  }
  return best;
}

function detectEntryAgent(events: ExtendedTraceEvent[]): string | undefined {
  const userMessage = events.find((event) => normalizeEventType(event.type) === 'user_message');
  const userAgent = pickString(userMessage?.agentName, userMessage?.data?.agentName);
  if (userAgent) {
    return userAgent;
  }

  const agentEnter = events.find((event) => normalizeEventType(event.type) === 'agent_enter');
  const entryAgent = pickString(agentEnter?.agentName, agentEnter?.data?.agentName);
  if (entryAgent) {
    return entryAgent;
  }

  const firstAgentEvent = events.find((event) => event.agentName || event.data?.agentName);
  return pickString(firstAgentEvent?.agentName, firstAgentEvent?.data?.agentName);
}

// L2/M4: Improved agent mode detection - count all events instead of short-circuiting on first
// Falls back to agent_enter data.mode if count-based heuristic is inconclusive
function detectAgentMode(events: ExtendedTraceEvent[]): 'reasoning' | 'scripted' | 'unknown' {
  let scriptedCount = 0;
  let reasoningCount = 0;

  for (const e of events) {
    if (SCRIPTED_MODE_EVENTS.has(e.type)) scriptedCount++;
    if (normalizeEventType(e.type) === 'llm_call') reasoningCount++;
  }

  // Determine mode based on dominant event type
  if (scriptedCount > reasoningCount) return 'scripted';
  if (reasoningCount > 0) return 'reasoning';

  // Fallback: check agent_enter event's data.mode field
  const agentEnter = events.find((e) => e.type === 'agent_enter');
  if (agentEnter?.data?.mode === 'reasoning') return 'reasoning';
  if (agentEnter?.data?.mode === 'scripted') return 'scripted';

  // If no clear indicators, default to 'unknown'
  return 'unknown';
}

function determineStatus(events: ExtendedTraceEvent[]): 'ok' | 'warning' | 'error' {
  let hasWarning = false;

  for (const e of events) {
    if (ERROR_EVENT_TYPES.has(e.type)) return 'error';
    if (WARNING_EVENT_TYPES.has(e.type)) hasWarning = true;
    if (e.metadata?.severity === 'error') return 'error';
    if (e.metadata?.severity === 'warn') hasWarning = true;
  }

  return hasWarning ? 'warning' : 'ok';
}

function buildSummary(
  sessionId: string,
  sorted: ExtendedTraceEvent[],
  interactions: Interaction[],
): SessionSummary {
  const agents = new Set<string>();
  let llmCallCount = 0;
  let toolCallCount = 0;
  let totalTokensIn = 0;
  let totalTokensOut = 0;
  let totalCost = 0;
  let maxContextWindowSize = 0;

  // L9: Track seen event IDs to prevent double-counting when both llm_call and llm.call.completed exist
  const countedLLMEventIds = new Set<string>();
  const countedToolEventIds = new Set<string>();

  for (const e of sorted) {
    if (e.agentName) agents.add(e.agentName);

    const eventType = normalizeEventType(e.type);
    if (eventType === 'llm_call') {
      // Only count if we haven't seen this event ID before
      if (!countedLLMEventIds.has(e.id)) {
        countedLLMEventIds.add(e.id);
        llmCallCount++;
        const usage = e.data.usage as Record<string, unknown> | undefined;
        totalTokensIn += (usage?.inputTokens as number) ?? (e.data.tokensIn as number) ?? 0;
        totalTokensOut += (usage?.outputTokens as number) ?? (e.data.tokensOut as number) ?? 0;
        totalCost += (e.data.cost as number) ?? 0;
        const ctxSize =
          (e.data.contextWindowSize as number) ?? (usage?.contextWindowSize as number) ?? 0;
        if (ctxSize > maxContextWindowSize) maxContextWindowSize = ctxSize;
      }
    }

    if (COMPLETED_TOOL_CALL_EVENT_TYPES.has(eventType)) {
      // Only count if we haven't seen this event ID before
      if (!countedToolEventIds.has(e.id)) {
        countedToolEventIds.add(e.id);
        toolCallCount++;
      }
    }
  }

  const firstTime = sorted[0].timestamp.getTime();
  const lastTime = sorted[sorted.length - 1].timestamp.getTime();

  const hasError = interactions.some((i) => i.status === 'error');
  const lastInteraction = interactions[interactions.length - 1];

  // A2: Improved session status logic - check for session_resolution event or time heuristic
  const hasResolution = sorted.some((e) => e.type === 'session_resolution');
  const timeSinceLastEvent = Date.now() - lastTime;
  const isLikelyActive = timeSinceLastEvent < 10000; // 10 seconds threshold

  const sessionStatus = hasError
    ? 'failed'
    : hasResolution
      ? 'completed'
      : lastInteraction && !isLikelyActive
        ? 'completed'
        : 'running';

  return {
    sessionId,
    status: sessionStatus,
    interactionCount: interactions.length,
    agentCount: agents.size,
    llmCallCount,
    toolCallCount,
    totalDurationMs: lastTime - firstTime,
    totalTokensIn,
    totalTokensOut,
    totalCost,
    maxContextWindowSize,
  };
}

// L2: Improved agent path mode detection - analyze all events per agent, not just first
function buildAgentPath(sorted: ExtendedTraceEvent[]): AgentPathNode[] {
  const path: AgentPathNode[] = [];
  const agentEvents = new Map<string, ExtendedTraceEvent[]>();

  // Group events by agent
  for (const e of sorted) {
    if (e.agentName) {
      if (!agentEvents.has(e.agentName)) {
        agentEvents.set(e.agentName, []);
      }
      agentEvents.get(e.agentName)!.push(e);
    }
  }

  // Build path in order agents were seen, but determine mode from all their events
  let lastAgent = '';
  for (const e of sorted) {
    if (e.agentName && e.agentName !== lastAgent) {
      const events = agentEvents.get(e.agentName) || [];
      const mode = detectAgentMode(events);
      path.push({ agentName: e.agentName, mode });
      lastAgent = e.agentName;
    }
  }

  return path;
}

function buildAgentSwitches(interactions: Interaction[]): AgentSwitch[] {
  const switches: AgentSwitch[] = [];

  for (let i = 1; i < interactions.length; i++) {
    const prev = interactions[i - 1];
    const curr = interactions[i];
    const prevAgent = prev.entryAgentName ?? prev.agentName;
    const currAgent = curr.entryAgentName ?? curr.agentName;

    if (prevAgent !== currAgent) {
      switches.push({
        fromAgent: prevAgent,
        toAgent: currAgent,
        fromMode: prev.agentMode,
        toMode: curr.agentMode,
        afterInteractionIndex: prev.index,
      });
    }
  }

  return switches;
}

function buildResolution(sorted: ExtendedTraceEvent[]): SessionResolution | null {
  for (let i = sorted.length - 1; i >= 0; i--) {
    const e = sorted[i];
    if (e.type === 'session_resolution') {
      return {
        timestamp: e.timestamp,
        outcome: (e.data.outcome ?? e.data.status ?? 'completed') as string,
        reason: e.data.reason as string | undefined,
        finalAgent: e.agentName ?? (e.data.agentName as string | undefined),
        durationMs: e.data.durationMs as number | undefined,
      };
    }
  }
  return null;
}

function emptySummary(sessionId: string): SessionSummary {
  return {
    sessionId,
    status: 'running',
    interactionCount: 0,
    agentCount: 0,
    llmCallCount: 0,
    toolCallCount: 0,
    totalDurationMs: 0,
    totalTokensIn: 0,
    totalTokensOut: 0,
    totalCost: 0,
    maxContextWindowSize: 0,
  };
}
