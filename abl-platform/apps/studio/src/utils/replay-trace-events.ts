/**
 * Replay Trace Events Utility
 *
 * Shared logic for hydrating observatory and session stores from
 * REST-fetched historical session data. Used by:
 * - useSessionDetail hook (historical session viewing)
 * - WebSocketContext switchSession (session switching)
 */

import { useObservatoryStore } from '../store/observatory-store';
import { useSessionStore } from '../store/session-store';
import { normalizeEventType } from '../lib/event-types';
import { toExtendedTraceEvent } from './trace-event-adapter';
import {
  accumulateResponseProvenance,
  buildResponseMessageMetadata,
  classifyLlmTraceVisibility,
  createResponseProvenanceAccumulator,
} from '@agent-platform/shared-kernel';
import type { TraceEvent, ExtendedTraceEvent, AgentDetails } from '../types';

const PRE_AGENT_ATTACHMENT_REPLAY_WINDOW_MS = 5_000;

// ── formatTraceEventLog ─────────────────────────────────────────────────────

/** Map trace event types to readable log messages */
export function formatTraceEventLog(
  type: string,
  data: Record<string, unknown>,
): { level: 'info' | 'warn' | 'error'; message: string } | null {
  switch (type) {
    case 'attachment_process':
      return {
        level: data.success === false ? 'warn' : 'info',
        message: `Attachment ${data.stage || 'process'}: ${data.filename || data.externalAttachmentId || 'attachment'}`,
      };
    case 'attachment_upload':
      return {
        level: data.success === false ? 'warn' : 'info',
        message: `Attachment upload: ${data.filename || data.attachmentId || 'attachment'}`,
      };
    case 'attachment_preprocess':
      return {
        level: 'info',
        message: `Attachment preprocess: ${data.attachmentSummary || `${data.attachmentCount || 0} attachments`}`,
      };
    case 'llm_call':
      return {
        level: 'info',
        message: `LLM call to ${data.model || 'claude'} (${data.agentName || data.agent_name || data.agent || 'unknown'})`,
      };
    case 'tool_call': {
      const toolName = (data.tool || data.toolName || data.tool_name) as string;
      const success = data.success !== false;
      return {
        level: success ? 'info' : 'error',
        message: `Tool: ${toolName} - ${success ? 'success' : 'failed'}${data.error ? ` (${data.error})` : ''}`,
      };
    }
    case 'handoff':
      return {
        level: 'info',
        message: `Handoff: ${data.from || data.fromAgent} → ${data.to || data.toAgent}`,
      };
    case 'constraint_check': {
      const passed = data.passed as boolean;
      return {
        level: passed ? 'info' : 'warn',
        message: `Constraint ${data.constraint || data.phase}: ${passed ? 'passed' : 'failed'}${data.message ? ` - ${data.message}` : ''}`,
      };
    }
    case 'error':
      return { level: 'error', message: `${data.message || 'Unknown error'}` };
    case 'flow_step_enter':
      return { level: 'info', message: `Entering step: ${data.stepName}` };
    case 'flow_step_exit':
      return {
        level: 'info',
        message: `Exiting step: ${data.stepName} (${data.result || 'done'})`,
      };
    case 'flow_transition':
      return { level: 'info', message: `Transition: ${data.fromStep} → ${data.toStep}` };
    case 'dsl_collect': {
      const fields = data.extracted
        ? Object.keys(data.extracted as object)
        : data.field
          ? [data.field]
          : [];
      return { level: 'info', message: `Collected: ${(fields as string[]).join(', ') || 'data'}` };
    }
    case 'entity_extraction': {
      const extracted = data.extracted as Record<string, unknown> | undefined;
      const extractedFields = extracted ? Object.keys(extracted) : [];
      return {
        level: 'info',
        message: `Extracted: ${extractedFields.join(', ') || 'entities'} from input`,
      };
    }
    case 'dsl_respond':
      return { level: 'info', message: 'Agent response' };
    case 'dsl_set': {
      const assignments = data.assignments as Record<string, unknown> | undefined;
      const keys = assignments ? Object.keys(assignments) : [];
      return { level: 'info', message: `Set context: ${keys.join(', ') || 'variables'}` };
    }
    case 'agent_enter':
      return {
        level: 'info',
        message: `Agent entered: ${data.agentName || data.agent_name || data.agent || 'unknown'}`,
      };
    case 'agent_exit':
      return {
        level: 'info',
        message: `Agent exited: ${data.agentName || data.agent_name || data.agent || 'unknown'}`,
      };
    case 'delegate_start':
      return {
        level: 'info',
        message: `Delegating to: ${data.targetAgent ?? data.toAgent ?? data.to}`,
      };
    case 'delegate_complete':
      return {
        level: 'info',
        message: `Delegation complete: ${data.targetAgent ?? data.toAgent ?? data.to}`,
      };
    case 'tool_thought': {
      if (data.visibility === 'chat_thought_only') return null;
      const thought = (data.thought as string) || (data.reasoning as string) || '';
      return {
        level: 'info',
        message: `Thought (${data.toolName || data.tool_name || 'unknown'}): ${thought.slice(0, 80)}${thought.length > 80 ? '...' : ''}`,
      };
    }
    default:
      return null;
  }
}

// ── synthesizeTurnSpans ──────────────────────────────────────────────────────

/** Safely extract agentName from a TraceEvent without unsafe casting. */
function getAgentName(event: TraceEvent): string {
  const data = (event.data || {}) as Record<string, unknown>;
  return (
    (event as unknown as { agentName?: string }).agentName ||
    (data.agentName as string | undefined) ||
    (data.agent_name as string | undefined) ||
    (data.agent as string | undefined) ||
    'unknown'
  );
}

/**
 * Injects synthetic agent_enter/agent_exit lifecycle events at user_message
 * boundaries for turns that are missing real lifecycle events. Turns that
 * already have real agent_enter/agent_exit are left untouched.
 *
 * This replaces the previous all-or-nothing approach where synthesis was
 * skipped entirely if *any* lifecycle events existed — leaving turns without
 * real events with no spans in the waterfall.
 */
function synthesizeTurnSpans(sorted: TraceEvent[], sessionId: string): TraceEvent[] {
  // Build turn boundaries: each user_message starts a new turn.
  // turnBoundaries[i] = index of the i-th user_message in sorted[]
  const turnBoundaries: number[] = [];
  for (let i = 0; i < sorted.length; i++) {
    if (normalizeEventType(sorted[i].type) === 'user_message') {
      turnBoundaries.push(i);
    }
  }

  if (turnBoundaries.length === 0) return sorted;

  // For each turn, check if it already has real agent_enter and agent_exit
  const turnsWithRealEnter = new Set<number>();
  const turnsWithRealExit = new Set<number>();

  for (let i = 0; i < sorted.length; i++) {
    const evtType = normalizeEventType(sorted[i].type);
    if (evtType !== 'agent_enter' && evtType !== 'agent_exit') continue;

    // Determine which turn this event belongs to
    let turnIdx = 0;
    for (let b = turnBoundaries.length - 1; b >= 0; b--) {
      if (i >= turnBoundaries[b]) {
        turnIdx = b;
        break;
      }
    }

    if (evtType === 'agent_enter') turnsWithRealEnter.add(turnIdx);
    if (evtType === 'agent_exit') turnsWithRealExit.add(turnIdx);
  }

  const result: TraceEvent[] = [];
  let currentTurn = -1;

  for (let i = 0; i < sorted.length; i++) {
    const event = sorted[i];
    const isUserMsg = normalizeEventType(event.type) === 'user_message';

    // Close previous turn's synthetic span before starting a new one
    if (isUserMsg && currentTurn >= 0 && !turnsWithRealExit.has(currentTurn)) {
      const prevEvent = sorted[i - 1] || event;
      const exitTs = new Date(new Date(prevEvent.timestamp).getTime() + 1);
      result.push(
        makeSyntheticEvent(
          'agent_exit',
          `synth-exit-${currentTurn + 1}`,
          `synth-span-turn-${currentTurn + 1}`,
          getAgentName(prevEvent),
          sessionId,
          exitTs,
          { result: 'completed', synthetic: true, turn: currentTurn + 1 },
        ),
      );
    }

    // Advance turn counter at user_message
    if (isUserMsg) {
      currentTurn++;

      // Inject synthetic agent_enter if this turn has no real one
      if (!turnsWithRealEnter.has(currentTurn)) {
        const enterTs = new Date(new Date(event.timestamp).getTime() - 1);
        result.push(
          makeSyntheticEvent(
            'agent_enter',
            `synth-enter-${currentTurn + 1}`,
            `synth-span-turn-${currentTurn + 1}`,
            getAgentName(event),
            sessionId,
            enterTs,
            {
              agentName: getAgentName(event),
              mode: 'reasoning',
              trigger: 'user_message',
              synthetic: true,
              turn: currentTurn + 1,
            },
          ),
        );
      }
    }

    // Inject spanId into events without one so they attach to the current turn span
    if (currentTurn >= 0 && !turnsWithRealEnter.has(currentTurn)) {
      const patched = {
        ...event,
        spanId: event.spanId || `synth-span-turn-${currentTurn + 1}`,
      } as TraceEvent;
      result.push(patched);
    } else {
      result.push(event);
    }
  }

  // Close final turn's synthetic span
  if (currentTurn >= 0 && !turnsWithRealExit.has(currentTurn) && sorted.length > 0) {
    const lastEvent = sorted[sorted.length - 1];
    const exitTs = new Date(new Date(lastEvent.timestamp).getTime() + 1);
    result.push(
      makeSyntheticEvent(
        'agent_exit',
        `synth-exit-${currentTurn + 1}`,
        `synth-span-turn-${currentTurn + 1}`,
        getAgentName(lastEvent),
        sessionId,
        exitTs,
        { result: 'completed', synthetic: true, turn: currentTurn + 1 },
      ),
    );
  }

  return result;
}

function makeSyntheticEvent(
  type: string,
  id: string,
  spanId: string,
  agentName: string,
  sessionId: string,
  timestamp: Date | string,
  data: Record<string, unknown>,
): TraceEvent {
  return {
    id,
    type,
    timestamp: timestamp instanceof Date ? timestamp : new Date(timestamp),
    data,
    agentName,
    spanId,
    sessionId,
  } as unknown as TraceEvent;
}

function isAttachmentReplayEvent(event: TraceEvent): boolean {
  const type = normalizeEventType(event.type);
  return (
    type === 'attachment_process' ||
    type === 'attachment_upload' ||
    type === 'attachment_preprocess'
  );
}

function hasExplicitAgent(event: TraceEvent): boolean {
  return getAgentName(event) !== 'unknown';
}

function alignAttachmentEventsForReplay(events: TraceEvent[]): TraceEvent[] {
  const bufferedByAgentEnterId = new Map<string, TraceEvent[]>();
  const bufferedEventIds = new Set<string>();

  for (let i = 0; i < events.length; i++) {
    const event = events[i];
    if (!isAttachmentReplayEvent(event) || hasExplicitAgent(event)) {
      continue;
    }

    const eventTime = new Date(event.timestamp).getTime();
    for (let j = i + 1; j < events.length; j++) {
      const candidate = events[j];
      const deltaMs = new Date(candidate.timestamp).getTime() - eventTime;
      if (deltaMs > PRE_AGENT_ATTACHMENT_REPLAY_WINDOW_MS) {
        break;
      }

      if (normalizeEventType(candidate.type) !== 'agent_enter') {
        continue;
      }

      const agentName = getAgentName(candidate);
      if (agentName === 'unknown') {
        continue;
      }

      const enrichedEvent = {
        ...event,
        agentName,
        data: {
          ...(event.data || {}),
          agentName,
        },
      } as TraceEvent;
      const buffered = bufferedByAgentEnterId.get(candidate.id) ?? [];
      buffered.push(enrichedEvent);
      bufferedByAgentEnterId.set(candidate.id, buffered);
      bufferedEventIds.add(event.id);
      break;
    }
  }

  if (bufferedEventIds.size === 0) {
    return events;
  }

  const aligned: TraceEvent[] = [];
  for (const event of events) {
    if (!bufferedEventIds.has(event.id)) {
      aligned.push(event);
    }

    if (normalizeEventType(event.type) === 'agent_enter') {
      const buffered = bufferedByAgentEnterId.get(event.id);
      if (buffered) {
        aligned.push(...buffered);
      }
    }
  }

  return aligned;
}

// ── replayTraceEventsIntoObservatory ─────────────────────────────────────────

/**
 * Replays an array of trace events into the observatory store.
 * Clears existing state first, then feeds events through addEvent()
 * which handles spans, flow nodes, metrics, constraint history, etc.
 */
export function replayTraceEventsIntoObservatory(
  traceEvents: TraceEvent[],
  sessionId: string,
): void {
  const obs = useObservatoryStore.getState();

  // Clear existing observatory state fully
  obs.clearEvents();
  obs.clearFlow();
  obs.resetMetrics();
  obs.clearLogs();
  obs.clearExecutionState();
  obs.clearAppExecutionState();

  // Sort chronologically
  const sorted = [...traceEvents].sort(
    (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime(),
  );

  // ── Synthesize per-turn agent spans for turns missing agent_enter/agent_exit ──
  // Always run synthesis — it detects which turns have real lifecycle events
  // and only injects synthetic ones for turns that are missing them.
  const eventsToReplay = alignAttachmentEventsForReplay(synthesizeTurnSpans(sorted, sessionId));

  // Replay each event through the observatory store
  for (const event of eventsToReplay) {
    const extendedEvent: ExtendedTraceEvent = toExtendedTraceEvent(event, {
      fallbackSessionId: sessionId,
      fallbackTraceId: sessionId,
    });

    const accepted = obs.addEvent(extendedEvent);

    // Generate log entry (normalize type for historical events from ClickHouse)
    const logEntry = accepted
      ? formatTraceEventLog(normalizeEventType(event.type), extendedEvent.data)
      : null;
    if (logEntry) {
      obs.addLog(logEntry.level, logEntry.message);
    }
  }

  // ── Post-replay sweep: close all still-running spans ──
  // Historical sessions are complete — no span should remain "running".
  // IMPORTANT: Must get fresh state — obs.spans captured before the loop is stale.
  const postReplayState = useObservatoryStore.getState();
  const postReplaySpans = postReplayState.spans;
  if (postReplaySpans instanceof Map) {
    // Use the last event's timestamp as the end time
    const lastTimestamp =
      sorted.length > 0 ? new Date(sorted[sorted.length - 1].timestamp) : new Date();
    for (const [spanId, span] of postReplaySpans) {
      if (span.status === 'running') {
        postReplayState.endSpan(spanId, 'completed', lastTimestamp);
      }
    }
  }

  // For historical sessions, override sessionStartTime so that
  // SessionTimeline computes duration correctly (from first→last event,
  // not from first event to Date.now()).
  // We set a fake "start time" that is (last - first) ms before Date.now(),
  // so Date.now() - sessionStartTime equals the actual session duration.
  if (sorted.length >= 2) {
    const firstTs = new Date(sorted[0].timestamp).getTime();
    const lastTs = new Date(sorted[sorted.length - 1].timestamp).getTime();
    const actualDuration = lastTs - firstTs;
    useObservatoryStore.setState({
      sessionStartTime: new Date(Date.now() - actualDuration),
    });
  }
}

// ── hydrateSessionStoreFromDetail ────────────────────────────────────────────

type HydrationMessageInput = {
  id: string;
  role: string;
  content: string;
  rawContent?: import('../types').SessionMessage['rawContent'];
  contentEnvelope?: import('../types').SessionMessage['contentEnvelope'];
  timestamp: Date | string;
  traceIds?: string[];
  metadata?: import('../types').SessionMessage['metadata'];
};

type AssistantTraceCandidate = {
  traceId: string;
  content: string;
  metadata: NonNullable<HydrationMessageInput['metadata']>;
  rawContent?: HydrationMessageInput['rawContent'];
  contentEnvelope?: HydrationMessageInput['contentEnvelope'];
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

const TRACE_TEXT_KEYS = [
  'transcript',
  'responseText',
  'outputText',
  'output_text',
  'text',
  'content',
  'message',
  'output',
] as const;

function readTraceTextCandidate(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }

  if (Array.isArray(value)) {
    return value
      .map(readTraceTextCandidate)
      .filter((candidate) => candidate.trim().length > 0)
      .join('\n');
  }

  if (!isRecord(value)) {
    return '';
  }

  for (const key of TRACE_TEXT_KEYS) {
    const candidate = readTraceTextCandidate(value[key]);
    if (candidate.trim()) {
      return candidate;
    }
  }

  return '';
}

function getLlmTraceResponseText(data: Record<string, unknown>): string {
  const responseText = readTraceTextCandidate(data.response);
  if (responseText.trim()) {
    return responseText;
  }

  for (const key of TRACE_TEXT_KEYS) {
    const candidate = readTraceTextCandidate(data[key]);
    if (candidate.trim()) {
      return candidate;
    }
  }

  return '';
}

function getTracePayloadText(data: Record<string, unknown>, eventType: string): string {
  const contentEnvelope = isRecord(data.contentEnvelope) ? data.contentEnvelope : undefined;
  const envelopeText = typeof contentEnvelope?.text === 'string' ? contentEnvelope.text : '';
  if (envelopeText.trim()) {
    return envelopeText;
  }

  if (eventType === 'llm_call') {
    return getLlmTraceResponseText(data);
  }
  if (eventType === 'dsl_respond') {
    return typeof data.rendered === 'string' ? data.rendered : '';
  }

  return String(data.content ?? data.message ?? data.text ?? data.output ?? '');
}

function getMessageAgentContentEnvelope(
  data: Record<string, unknown>,
  content: string,
): HydrationMessageInput['contentEnvelope'] | undefined {
  if (isRecord(data.contentEnvelope)) {
    return data.contentEnvelope as HydrationMessageInput['contentEnvelope'];
  }

  const structuredContent = isRecord(data.structuredContent) ? data.structuredContent : undefined;
  if (!structuredContent) {
    return undefined;
  }

  return {
    version: 2,
    format: 'message_envelope',
    text: content,
    ...(Array.isArray(structuredContent.blocks) ? { blocks: structuredContent.blocks } : {}),
    ...(isRecord(structuredContent.richContent)
      ? { richContent: structuredContent.richContent }
      : {}),
    ...(isRecord(structuredContent.actions) ? { actions: structuredContent.actions } : {}),
    ...(isRecord(structuredContent.voiceConfig)
      ? { voiceConfig: structuredContent.voiceConfig }
      : {}),
    ...(isRecord(structuredContent.localization)
      ? { localization: structuredContent.localization }
      : {}),
  } as HydrationMessageInput['contentEnvelope'];
}

function getContentEnvelopeBlocks(
  contentEnvelope: HydrationMessageInput['contentEnvelope'] | undefined,
): HydrationMessageInput['rawContent'] | undefined {
  return isRecord(contentEnvelope) && Array.isArray(contentEnvelope.blocks)
    ? (contentEnvelope.blocks as HydrationMessageInput['rawContent'])
    : undefined;
}

function getContentEnvelopeRichnessScore(
  contentEnvelope: HydrationMessageInput['contentEnvelope'] | undefined,
): number {
  if (!isRecord(contentEnvelope)) {
    return 0;
  }

  let score = 1;
  if (Array.isArray(contentEnvelope.blocks) && contentEnvelope.blocks.length > 0) score += 2;
  if (
    isRecord(contentEnvelope.richContent) &&
    Object.keys(contentEnvelope.richContent).length > 0
  ) {
    score += 2;
  }
  if (
    isRecord(contentEnvelope.actions) &&
    Array.isArray(contentEnvelope.actions.elements) &&
    contentEnvelope.actions.elements.length > 0
  ) {
    score += 2;
  }
  if (
    isRecord(contentEnvelope.voiceConfig) &&
    Object.keys(contentEnvelope.voiceConfig).length > 0
  ) {
    score += 2;
  }
  if (isRecord(contentEnvelope.localization)) score += 1;
  return score;
}

function shouldPreferCandidateEnvelope(
  currentEnvelope: HydrationMessageInput['contentEnvelope'] | undefined,
  candidateEnvelope: HydrationMessageInput['contentEnvelope'] | undefined,
): boolean {
  if (!candidateEnvelope) {
    return false;
  }
  if (!currentEnvelope) {
    return true;
  }

  const candidateScore = getContentEnvelopeRichnessScore(candidateEnvelope);
  const currentScore = getContentEnvelopeRichnessScore(currentEnvelope);
  return (
    candidateScore > currentScore ||
    (candidateScore === currentScore &&
      JSON.stringify(candidateEnvelope) !== JSON.stringify(currentEnvelope))
  );
}

function getMessageAgentResponseMetadata(
  data: Record<string, unknown>,
): NonNullable<HydrationMessageInput['metadata']> {
  return isRecord(data.responseMetadata)
    ? (data.responseMetadata as NonNullable<HydrationMessageInput['metadata']>)
    : {};
}

function isInternalResponseMetadata(metadata: unknown): boolean {
  if (!isRecord(metadata)) {
    return false;
  }

  if (metadata.responseVisibility === 'internal') {
    return true;
  }

  const coordination = metadata.coordination;
  return isRecord(coordination) && coordination.visibility === 'internal';
}

function isInternalAgentResponseTrace(data: Record<string, unknown>): boolean {
  return (
    data.responseVisibility === 'internal' || isInternalResponseMetadata(data.responseMetadata)
  );
}

function normalizeComparableMessageText(content: string): string {
  return content.trim().replace(/\s+/g, ' ').toLowerCase();
}

function messagesLikelyMatch(left: string, right: string): boolean {
  const normalizedLeft = normalizeComparableMessageText(left);
  const normalizedRight = normalizeComparableMessageText(right);

  if (!normalizedLeft || !normalizedRight) {
    return false;
  }

  if (normalizedLeft === normalizedRight) {
    return true;
  }

  return (
    normalizedLeft.startsWith(normalizedRight) ||
    normalizedRight.startsWith(normalizedLeft) ||
    normalizedLeft.slice(0, 100) === normalizedRight.slice(0, 100)
  );
}

function collectAssistantTraceCandidates(traceEvents: TraceEvent[]): AssistantTraceCandidate[] {
  const sortedTraceEvents = [...traceEvents].sort(
    (left, right) => new Date(left.timestamp).getTime() - new Date(right.timestamp).getTime(),
  );
  const candidates: AssistantTraceCandidate[] = [];
  let responseProvenance = createResponseProvenanceAccumulator();

  for (const event of sortedTraceEvents) {
    const eventType = normalizeEventType(event.type);
    if (eventType === 'user_message') {
      responseProvenance = createResponseProvenanceAccumulator();
      continue;
    }

    if (eventType === 'llm_call') {
      const data = (event.data || {}) as Record<string, unknown>;
      accumulateResponseProvenance(responseProvenance, {
        type: event.type,
        data,
      });
      if (classifyLlmTraceVisibility(data) !== 'customer_visible') {
        continue;
      }

      const content = getLlmTraceResponseText(data);
      if (!content.trim()) {
        continue;
      }

      const truncated = content.length === 2000;
      candidates.push({
        traceId: event.id,
        content: content.trim(),
        metadata: {
          ...buildResponseMessageMetadata(responseProvenance),
          ...(truncated ? { truncated: true } : {}),
        },
      });
      continue;
    }

    if (eventType === 'agent_response') {
      const data = (event.data || {}) as Record<string, unknown>;
      if (isInternalAgentResponseTrace(data)) {
        continue;
      }

      const content = getTracePayloadText(data, eventType);
      if (!content.trim()) {
        continue;
      }

      const contentEnvelope = getMessageAgentContentEnvelope(data, content.trim());
      const rawContent = getContentEnvelopeBlocks(contentEnvelope);
      candidates.push({
        traceId: event.id,
        content: content.trim(),
        ...(rawContent ? { rawContent } : {}),
        ...(contentEnvelope ? { contentEnvelope } : {}),
        metadata: {
          ...buildResponseMessageMetadata(responseProvenance),
          ...getMessageAgentResponseMetadata(data),
        },
      });
      continue;
    }

    if (eventType !== 'dsl_respond') {
      continue;
    }

    const data = (event.data || {}) as Record<string, unknown>;
    const content = getTracePayloadText(data, eventType);
    if (!content.trim()) {
      continue;
    }

    candidates.push({
      traceId: event.id,
      content: content.trim(),
      metadata: {
        ...buildResponseMessageMetadata(responseProvenance),
      },
    });
  }

  return candidates;
}

function enrichSessionMessagesWithTraceMetadata(
  baseMessages: HydrationMessageInput[],
  traceEvents: TraceEvent[],
): HydrationMessageInput[] {
  const candidates = collectAssistantTraceCandidates(traceEvents);
  if (candidates.length === 0) {
    return baseMessages;
  }

  const enrichedMessages = baseMessages.map((message) => ({
    ...message,
    traceIds: [...(message.traceIds ?? [])],
    ...(message.metadata ? { metadata: { ...message.metadata } } : {}),
  }));

  let candidateIndex = 0;
  for (const message of enrichedMessages) {
    if (message.role !== 'assistant') {
      continue;
    }

    const alreadyHasProvenance =
      typeof message.metadata?.isLlmGenerated === 'boolean' ||
      message.metadata?.responseProvenance !== undefined;
    if (alreadyHasProvenance || !message.content.trim()) {
      continue;
    }

    for (let index = candidateIndex; index < candidates.length; index += 1) {
      const candidate = candidates[index];
      if (!messagesLikelyMatch(message.content, candidate.content)) {
        continue;
      }

      message.metadata = {
        ...(message.metadata ?? {}),
        ...candidate.metadata,
      };
      if (
        candidate.rawContent &&
        (!message.rawContent ||
          getContentEnvelopeRichnessScore(candidate.contentEnvelope) >=
            getContentEnvelopeRichnessScore(message.contentEnvelope))
      ) {
        message.rawContent = candidate.rawContent;
      }
      if (shouldPreferCandidateEnvelope(message.contentEnvelope, candidate.contentEnvelope)) {
        message.contentEnvelope = candidate.contentEnvelope;
      }
      message.traceIds = Array.from(new Set([...message.traceIds, candidate.traceId]));
      candidateIndex = index + 1;
      break;
    }
  }

  return enrichedMessages;
}

function countTraceMessages(traceEvents: TraceEvent[], role: 'user' | 'assistant'): number {
  return traceEvents.reduce((count, event) => {
    const eventType = normalizeEventType(event.type);
    if (role === 'user' && eventType !== 'user_message') {
      return count;
    }
    if (
      role === 'assistant' &&
      eventType !== 'llm_call' &&
      eventType !== 'dsl_respond' &&
      eventType !== 'agent_response'
    ) {
      return count;
    }

    const data = (event.data || {}) as Record<string, unknown>;
    if (role === 'assistant' && eventType === 'llm_call') {
      if (classifyLlmTraceVisibility(data) !== 'customer_visible') {
        return count;
      }
    }
    if (
      role === 'assistant' &&
      eventType === 'agent_response' &&
      isInternalAgentResponseTrace(data)
    ) {
      return count;
    }

    const content =
      role === 'user'
        ? (data.message as string) || (data.content as string) || ''
        : getTracePayloadText(data, eventType);
    return content.trim() ? count + 1 : count;
  }, 0);
}

function shouldAugmentSessionMessagesWithTraceEvents(
  baseMessages: HydrationMessageInput[],
  traceEvents: TraceEvent[],
): boolean {
  if (traceEvents.length === 0) {
    return false;
  }

  const conversationMessages = baseMessages.filter(
    (message) => message.role === 'user' || message.role === 'assistant',
  );
  if (conversationMessages.length === 0) {
    return true;
  }
  if (conversationMessages.length === 1) {
    return true;
  }

  const userMessages = conversationMessages.filter((message) => message.role === 'user');
  const assistantMessages = conversationMessages.filter((message) => message.role === 'assistant');
  const traceUserCount = countTraceMessages(traceEvents, 'user');
  const traceAssistantCount = countTraceMessages(traceEvents, 'assistant');

  if (userMessages.length === 0 && traceUserCount > 0) {
    return true;
  }
  if (assistantMessages.length === 0 && traceAssistantCount > 0) {
    return true;
  }
  if (traceUserCount >= 2 && userMessages.length < traceUserCount) {
    return true;
  }

  const lastConversationMessage = conversationMessages[conversationMessages.length - 1];
  if (
    lastConversationMessage?.role === 'user' &&
    assistantMessages.length < userMessages.length &&
    traceAssistantCount >= userMessages.length
  ) {
    return true;
  }

  return false;
}

export function augmentSessionMessagesWithTraceEvents(
  baseMessages: HydrationMessageInput[],
  traceEvents: TraceEvent[],
): HydrationMessageInput[] {
  const enrichedBaseMessages = enrichSessionMessagesWithTraceMetadata(baseMessages, traceEvents);

  if (!shouldAugmentSessionMessagesWithTraceEvents(enrichedBaseMessages, traceEvents)) {
    return enrichedBaseMessages;
  }

  const DEDUP_WINDOW_MS = 5000;
  const seenMessages = [...enrichedBaseMessages];
  const sortedTraceEvents = [...traceEvents].sort(
    (left, right) => new Date(left.timestamp).getTime() - new Date(right.timestamp).getTime(),
  );
  let responseProvenance = createResponseProvenanceAccumulator();

  const isDuplicate = (role: 'user' | 'assistant', content: string, timestamp: Date): boolean => {
    const prefix = content.trim().toLowerCase().slice(0, 100);
    const ts = timestamp.getTime();
    return seenMessages.some((message) => {
      if (message.role !== role) {
        return false;
      }
      const existingPrefix = message.content?.trim().toLowerCase().slice(0, 100) || '';
      if (existingPrefix !== prefix) {
        return false;
      }
      const diff = Math.abs(new Date(message.timestamp).getTime() - ts);
      return diff < DEDUP_WINDOW_MS;
    });
  };

  for (const event of sortedTraceEvents) {
    if (normalizeEventType(event.type) !== 'user_message') {
      continue;
    }

    const data = (event.data || {}) as Record<string, unknown>;
    const content = (data.message as string) || (data.content as string) || '';
    if (!content.trim()) {
      continue;
    }

    const eventTimestamp =
      event.timestamp instanceof Date ? event.timestamp : new Date(event.timestamp);
    if (isDuplicate('user', content, eventTimestamp)) {
      continue;
    }

    seenMessages.push({
      id: `trace-msg-${event.id}`,
      role: 'user',
      content: content.trim(),
      timestamp: eventTimestamp,
      traceIds: [event.id],
      metadata: { synthetic: true },
    });

    responseProvenance = createResponseProvenanceAccumulator();
  }

  for (const event of sortedTraceEvents) {
    const eventType = normalizeEventType(event.type);
    if (eventType === 'user_message') {
      responseProvenance = createResponseProvenanceAccumulator();
      continue;
    }

    if (eventType === 'llm_call') {
      const data = (event.data || {}) as Record<string, unknown>;
      accumulateResponseProvenance(responseProvenance, {
        type: event.type,
        data,
      });
      if (classifyLlmTraceVisibility(data) !== 'customer_visible') {
        continue;
      }

      const content = getLlmTraceResponseText(data);
      if (!content.trim()) {
        continue;
      }

      const eventTimestamp =
        event.timestamp instanceof Date ? event.timestamp : new Date(event.timestamp);
      if (isDuplicate('assistant', content, eventTimestamp)) {
        continue;
      }

      const truncated = content.length === 2000;
      seenMessages.push({
        id: `trace-resp-${event.id}`,
        role: 'assistant',
        content: content.trim(),
        timestamp: eventTimestamp,
        traceIds: [event.id],
        metadata: {
          synthetic: true,
          ...buildResponseMessageMetadata(responseProvenance),
          ...(truncated ? { truncated: true } : {}),
        },
      });
      continue;
    }

    if (eventType === 'agent_response') {
      const data = (event.data || {}) as Record<string, unknown>;
      if (isInternalAgentResponseTrace(data)) {
        continue;
      }

      const content = getTracePayloadText(data, eventType);
      if (!content.trim()) {
        continue;
      }

      const eventTimestamp =
        event.timestamp instanceof Date ? event.timestamp : new Date(event.timestamp);
      if (isDuplicate('assistant', content, eventTimestamp)) {
        continue;
      }

      const contentEnvelope = getMessageAgentContentEnvelope(data, content.trim());
      const rawContent = getContentEnvelopeBlocks(contentEnvelope);
      seenMessages.push({
        id: `trace-resp-${event.id}`,
        role: 'assistant',
        content: content.trim(),
        ...(rawContent ? { rawContent } : {}),
        ...(contentEnvelope ? { contentEnvelope } : {}),
        timestamp: eventTimestamp,
        traceIds: [event.id],
        metadata: {
          synthetic: true,
          ...buildResponseMessageMetadata(responseProvenance),
          ...getMessageAgentResponseMetadata(data),
        },
      });
      continue;
    }

    if (eventType !== 'dsl_respond') {
      continue;
    }

    const data = (event.data || {}) as Record<string, unknown>;
    const content = getTracePayloadText(data, eventType);
    if (!content.trim()) {
      continue;
    }

    const eventTimestamp =
      event.timestamp instanceof Date ? event.timestamp : new Date(event.timestamp);
    if (isDuplicate('assistant', content, eventTimestamp)) {
      continue;
    }

    seenMessages.push({
      id: `trace-resp-${event.id}`,
      role: 'assistant',
      content: content.trim(),
      timestamp: eventTimestamp,
      traceIds: [event.id],
      metadata: {
        synthetic: true,
        ...buildResponseMessageMetadata(responseProvenance),
      },
    });
  }

  return seenMessages.sort(
    (left, right) => new Date(left.timestamp).getTime() - new Date(right.timestamp).getTime(),
  );
}

/**
 * Hydrates the session store from a REST-fetched session detail response.
 * This makes ContextSection, HistoryTab, and IRTab work for historical sessions.
 */
export function hydrateSessionStoreFromDetail(
  session: {
    id: string;
    agentName: string;
    agent?: string | Record<string, unknown>;
    state?: Record<string, unknown>;
    messages: Array<{
      id: string;
      role: string;
      content: string;
      rawContent?: import('../types').SessionMessage['rawContent'];
      contentEnvelope?: import('../types').SessionMessage['contentEnvelope'];
      timestamp: Date | string;
      traceIds?: string[];
      metadata?: import('../types').SessionMessage['metadata'];
    }>;
  },
  traceEvents: TraceEvent[] = [],
): void {
  // Replace the session atomically so transport/session listeners do not
  // observe an intermediate "no session" state during historical hydration.
  useObservatoryStore.getState().clearSelection();

  // Build a minimal AgentDetails from the session data.
  // The REST API may return `agent` as a string (agent name)
  // rather than an object, so guard against that.
  const agentRaw = typeof session.agent === 'object' ? session.agent : undefined;
  const agentDetails: AgentDetails = {
    id: (agentRaw?.id as string) || session.id,
    name: session.agentName || 'Unknown',
    filePath: (agentRaw?.filePath as string) || undefined,
    type: (agentRaw?.type as 'agent' | 'supervisor') || 'agent',
    mode: (agentRaw?.mode as 'scripted' | 'reasoning') || 'reasoning',
    toolCount: (agentRaw?.toolCount as number) || 0,
    gatherFieldCount: (agentRaw?.gatherFieldCount as number) || 0,
    isSupervisor: (agentRaw?.isSupervisor as boolean) || false,
    dsl: (agentRaw?.dsl as string) || '',
    ir: agentRaw?.ir,
  };

  const messages = augmentSessionMessagesWithTraceEvents(session.messages, traceEvents).map(
    (m) => ({
      id: m.id,
      role: m.role as 'user' | 'assistant' | 'system' | 'thought',
      content: m.content,
      ...(m.rawContent ? { rawContent: m.rawContent } : {}),
      ...(m.contentEnvelope ? { contentEnvelope: m.contentEnvelope } : {}),
      timestamp: m.timestamp instanceof Date ? m.timestamp : new Date(m.timestamp),
      traceIds: m.traceIds || [],
      ...(m.metadata ? { metadata: m.metadata } : {}),
    }),
  );

  // Provide a default state so ContextSection doesn't show "No session active"
  // even when the REST API returns state: null/undefined
  const defaultState: import('../types').AgentState = {
    context: {},
    conversationPhase: 'start',
    gatherProgress: {},
    constraintResults: {},
    lastToolResults: {},
    memory: { session: {}, persistentCache: {}, pendingRemembers: [] },
  };

  useSessionStore.getState().restoreSession({
    sessionId: session.id,
    agent: agentDetails,
    messages,
    state: session.state
      ? (session.state as unknown as import('../types').AgentState)
      : defaultState,
  });
}
