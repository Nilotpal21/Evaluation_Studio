// apps/studio/src/lib/buildAgentTree.ts
import type { TreeNode, TreeNodeType } from '../hooks/useSessionDetail';
import type { TraceEvent, SessionMessage } from '../types';
import {
  resolveAgentLabel,
  resolveLLMLabel,
  resolveToolLabel,
  resolveDecisionLabel,
  resolveDelegateLabel,
} from './label-utils';
import { deriveSyntheticSpanFields } from '../utils/trace-event-adapter';

const SYSTEM_TOOLS: Record<string, TreeNodeType> = {
  __handoff__: 'handoff',
  __delegate__: 'delegate_action',
  __complete__: 'complete',
  __escalate__: 'escalate',
};

const ATTACHMENT_TREE_EVENT_TYPES = new Set([
  'attachment_process',
  'attachment_upload',
  'attachment_preprocess',
]);
const PRE_AGENT_ATTACHMENT_WINDOW_MS = 5_000;

const COLLAPSIBLE_TYPES = new Set([
  'constraint_check',
  'guardrail_check',
  'gather_extraction',
  'correction',
]);
const ASSISTANT_DUPLICATE_WINDOW_MS = 10_000;
const ASSISTANT_FRAGMENT_MERGE_WINDOW_MS = 1_000;
const PRE_TURN_AGENT_WINDOW_MS = 2_000;

function extractTokens(data: Record<string, unknown>) {
  const tokenUsage = data.tokenUsage as Record<string, number> | undefined;
  return {
    input: (data.tokensIn as number) || tokenUsage?.input || 0,
    output: (data.tokensOut as number) || tokenUsage?.output || 0,
  };
}

function toISOString(ts: Date | string): string {
  return ts instanceof Date ? ts.toISOString() : String(ts);
}

function toTimestampMs(ts: Date | string): number {
  const timestamp = ts instanceof Date ? ts.getTime() : new Date(ts).getTime();
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function normalizeMessageText(content: string): string {
  return content.replace(/\s+/g, ' ').trim().toLowerCase();
}

function resolveMessageAgentName(message: SessionMessage): string {
  const agentName = message.metadata?.agentName;
  return typeof agentName === 'string' ? agentName : '';
}

function mergeAssistantText(left: string, right: string): string {
  const first = left.trim();
  const second = right.trim();
  if (!first) return second;
  if (!second) return first;

  const normalizedFirst = normalizeMessageText(first);
  const normalizedSecond = normalizeMessageText(second);
  if (normalizedFirst === normalizedSecond || normalizedFirst.includes(normalizedSecond)) {
    return first;
  }
  if (normalizedSecond.includes(normalizedFirst)) {
    return second;
  }

  return `${first} ${second}`;
}

function prepareTreeMessages(messages: SessionMessage[]): SessionMessage[] {
  const sortedMessages = [...messages].sort(
    (a, b) => toTimestampMs(a.timestamp) - toTimestampMs(b.timestamp),
  );
  const prepared: SessionMessage[] = [];

  for (const message of sortedMessages) {
    const content = message.content?.trim() || '';
    if (!content) {
      prepared.push(message);
      continue;
    }

    const previous = prepared[prepared.length - 1];
    if (!previous || previous.role !== 'assistant' || message.role !== 'assistant') {
      prepared.push(message);
      continue;
    }

    const previousContent = previous.content?.trim() || '';
    const timeDeltaMs = Math.abs(
      toTimestampMs(message.timestamp) - toTimestampMs(previous.timestamp),
    );
    const previousAgentName = resolveMessageAgentName(previous);
    const messageAgentName = resolveMessageAgentName(message);
    if (previousAgentName && messageAgentName && previousAgentName !== messageAgentName) {
      prepared.push(message);
      continue;
    }

    if (
      normalizeMessageText(previousContent) === normalizeMessageText(content) &&
      timeDeltaMs <= ASSISTANT_DUPLICATE_WINDOW_MS
    ) {
      continue;
    }

    if (timeDeltaMs <= ASSISTANT_FRAGMENT_MERGE_WINDOW_MS) {
      prepared[prepared.length - 1] = {
        ...previous,
        id: `${previous.id}+${message.id}`,
        content: mergeAssistantText(previousContent, content),
        traceIds: Array.from(new Set([...(previous.traceIds || []), ...(message.traceIds || [])])),
        metadata: {
          ...previous.metadata,
          ...(message.metadata || {}),
        },
      };
      continue;
    }

    prepared.push(message);
  }

  return prepared;
}

function toTitleCase(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function formatAttachmentLabel(
  type: Extract<TreeNodeType, 'attachment_process' | 'attachment_upload' | 'attachment_preprocess'>,
  data: Record<string, unknown>,
): string {
  const filename = typeof data.filename === 'string' ? data.filename : undefined;
  const stage = typeof data.stage === 'string' && data.stage.length > 0 ? data.stage : undefined;
  const summary =
    typeof data.attachmentSummary === 'string' && data.attachmentSummary.length > 0
      ? data.attachmentSummary
      : undefined;

  switch (type) {
    case 'attachment_process': {
      const action =
        stage === 'download'
          ? 'Attachment Fetch'
          : stage
            ? `Attachment ${toTitleCase(stage)}`
            : 'Attachment Fetch';
      return filename ? `${action}: ${filename}` : action;
    }

    case 'attachment_upload':
      return filename ? `Attachment Ingest: ${filename}` : 'Attachment Ingest';

    case 'attachment_preprocess':
      return summary ? `Attachment Preprocess: ${summary}` : 'Attachment Preprocess';
  }
}

function resolveTraceSpanId(event: TraceEvent): string | undefined {
  const eventRecord = event as unknown as Record<string, unknown>;
  const explicitSpanId =
    (eventRecord.spanId as string | undefined) || (eventRecord.span_id as string | undefined);
  if (explicitSpanId) {
    return explicitSpanId;
  }

  return deriveSyntheticSpanFields(event).spanId;
}

function resolveTraceParentSpanId(event: TraceEvent): string | undefined {
  const eventRecord = event as unknown as Record<string, unknown>;
  const explicitParentSpanId =
    (eventRecord.parentSpanId as string | undefined) ||
    (eventRecord.parent_span_id as string | undefined);
  if (explicitParentSpanId) {
    return explicitParentSpanId;
  }

  return deriveSyntheticSpanFields(event).parentSpanId;
}

function pickNumber(...values: unknown[]): number | undefined {
  for (const value of values) {
    if (typeof value === 'number' && Number.isFinite(value)) {
      return value;
    }
  }

  return undefined;
}

function resolveVoiceTurnKey(data: Record<string, unknown>, fallbackId: string): string {
  const turnId = data.turnId;
  if (typeof turnId === 'string' && turnId.length > 0) {
    return turnId;
  }

  const turnNumber = pickNumber(data.turn, data.turnNumber, data.turn_number);
  if (turnNumber !== undefined) {
    return String(turnNumber);
  }

  return fallbackId;
}

const VOICE_TREE_EVENT_TYPES = new Set([
  'voice_session_start',
  'voice_session_end',
  'voice_turn',
  'voice_stt',
  'voice_tts',
  'voice_realtime_tool_call',
  'voice_barge_in',
]);

function isVoiceTreeEvent(event: TraceEvent): boolean {
  return VOICE_TREE_EVENT_TYPES.has(event.type);
}

function isVoiceLifecycleTreeEvent(event: TraceEvent): boolean {
  return event.type === 'voice_session_start' || event.type === 'voice_session_end';
}

function getVoiceTurnLabel(data: Record<string, unknown>, turnKey: string): string {
  const turnNumber = pickNumber(data.turn, data.turnNumber, data.turn_number);
  if (turnNumber !== undefined) {
    return `Turn ${turnNumber}`;
  }

  return `Turn ${turnKey}`;
}

function sortTreeNodes(nodes: TreeNode[]): TreeNode[] {
  nodes.sort((left, right) => {
    const leftTime = left.timestamp ? new Date(left.timestamp).getTime() : 0;
    const rightTime = right.timestamp ? new Date(right.timestamp).getTime() : 0;
    return leftTime - rightTime;
  });

  for (const node of nodes) {
    if (node.children.length > 1) {
      sortTreeNodes(node.children);
    }
  }

  return nodes;
}

function getNodeTimestampMs(node: TreeNode): number {
  return node.timestamp ? new Date(node.timestamp).getTime() : 0;
}

function createUserMessageNode(message: SessionMessage, content: string): TreeNode {
  return {
    id: message.id,
    type: 'user_input',
    label: `"${content.slice(0, 60)}${content.length > 60 ? '…' : ''}"`,
    timestamp:
      message.timestamp instanceof Date
        ? message.timestamp.toISOString()
        : String(message.timestamp),
    children: [],
    data: {
      content,
      messageIds: [message.id],
    },
  };
}

function createAssistantMessageNode(
  message: SessionMessage,
  content: string,
  fallbackAgentName?: string,
): TreeNode {
  const messageIds = message.id.split('+').filter(Boolean);
  const bracketedAgentMatch = content.match(/^\[([^\]]+)\]:\s*(.*)$/);
  const agentName =
    resolveMessageAgentName(message) || bracketedAgentMatch?.[1]?.trim() || fallbackAgentName;
  const displayContent = (bracketedAgentMatch?.[2] || content).trim();
  const speaker = agentName || 'Agent';
  return {
    id: message.id,
    type: 'agent_response',
    label: `${speaker}: "${displayContent.slice(0, 60)}${displayContent.length > 60 ? '…' : ''}"`,
    timestamp:
      message.timestamp instanceof Date
        ? message.timestamp.toISOString()
        : String(message.timestamp),
    children: [],
    data: {
      content,
      messageIds,
      mergedMessageCount: messageIds.length,
    },
  };
}

function buildVoiceTree(events: TraceEvent[]): TreeNode[] {
  const voiceEvents = events.filter(isVoiceTreeEvent);
  if (voiceEvents.length === 0) {
    return [];
  }

  const sessionStartEvent = voiceEvents.find((event) => event.type === 'voice_session_start');
  const firstVoiceEvent = sessionStartEvent || voiceEvents[0];
  const sessionData = firstVoiceEvent.data || {};
  const sessionNode: TreeNode = {
    id: sessionStartEvent?.id || `voice-session-${firstVoiceEvent.sessionId}`,
    type: 'voice_session_start',
    label: 'Voice Session',
    spanId: sessionStartEvent
      ? resolveTraceSpanId(sessionStartEvent)
      : `voice-session:${firstVoiceEvent.sessionId}`,
    timestamp: toISOString(firstVoiceEvent.timestamp),
    children: [],
    data: sessionData,
  };

  const turnsByKey = new Map<string, TreeNode>();

  const ensureTurnNode = (event: TraceEvent): TreeNode => {
    const eventData = event.data || {};
    const turnKey = resolveVoiceTurnKey(eventData, event.id);
    const existing = turnsByKey.get(turnKey);
    if (existing) {
      if (event.type === 'voice_turn') {
        existing.label = getVoiceTurnLabel(eventData, turnKey);
        existing.spanId = resolveTraceSpanId(event) ?? existing.spanId;
        existing.latencyMs =
          event.durationMs || (eventData.durationMs as number) || existing.latencyMs;
        existing.timestamp = toISOString(event.timestamp);
        existing.data = eventData;
      }
      return existing;
    }

    const parentSpanId = resolveTraceParentSpanId(event);
    const placeholderSpanId =
      resolveTraceSpanId(event) ||
      (typeof parentSpanId === 'string' && parentSpanId.length > 0 ? parentSpanId : undefined);

    const turnNode: TreeNode = {
      id: `voice-turn-${turnKey}`,
      type: 'voice_turn',
      label: getVoiceTurnLabel(eventData, turnKey),
      spanId: placeholderSpanId,
      latencyMs: event.type === 'voice_turn' ? event.durationMs : undefined,
      timestamp: toISOString(event.timestamp),
      children: [],
      data: eventData,
    };
    turnsByKey.set(turnKey, turnNode);
    sessionNode.children.push(turnNode);
    return turnNode;
  };

  const createVoicePhaseNode = (event: TraceEvent): TreeNode | null => {
    const eventData = event.data || {};
    const spanId = resolveTraceSpanId(event);
    const durationMs = event.durationMs || (eventData.durationMs as number) || undefined;

    switch (event.type) {
      case 'voice_stt':
        return {
          id: event.id,
          type: 'voice_stt',
          label: 'Speech-to-Text',
          spanId,
          detail: typeof eventData.provider === 'string' ? eventData.provider : undefined,
          latencyMs: durationMs,
          timestamp: toISOString(event.timestamp),
          children: [],
          data: eventData,
        };

      case 'voice_tts':
        return {
          id: event.id,
          type: 'voice_tts',
          label: 'Text-to-Speech',
          spanId,
          detail: typeof eventData.provider === 'string' ? eventData.provider : undefined,
          latencyMs: durationMs,
          timestamp: toISOString(event.timestamp),
          children: [],
          data: eventData,
        };

      case 'voice_realtime_tool_call': {
        const toolName =
          typeof eventData.toolName === 'string'
            ? eventData.toolName
            : typeof eventData.tool_name === 'string'
              ? eventData.tool_name
              : 'unknown';
        return {
          id: event.id,
          type: 'voice_realtime_tool_call',
          label: `Tool Call: ${toolName}`,
          spanId,
          detail: toolName,
          latencyMs: durationMs,
          timestamp: toISOString(event.timestamp),
          children: [],
          data: eventData,
        };
      }

      case 'voice_barge_in':
        return {
          id: event.id,
          type: 'voice_barge_in',
          label: 'Barge-In',
          spanId,
          latencyMs: durationMs,
          timestamp: toISOString(event.timestamp),
          children: [],
          data: eventData,
        };

      default:
        return null;
    }
  };

  for (const event of voiceEvents) {
    if (event.type === 'voice_session_start') {
      sessionNode.spanId = resolveTraceSpanId(event) ?? sessionNode.spanId;
      sessionNode.timestamp = toISOString(event.timestamp);
      sessionNode.data = event.data || sessionNode.data;
      continue;
    }

    if (event.type === 'voice_session_end') {
      sessionNode.children.push({
        id: event.id,
        type: 'voice_session_end',
        label: 'Voice Session End',
        spanId: resolveTraceSpanId(event),
        latencyMs: event.durationMs || undefined,
        timestamp: toISOString(event.timestamp),
        children: [],
        data: event.data || {},
      });
      continue;
    }

    const turnNode = ensureTurnNode(event);
    if (event.type === 'voice_turn') {
      continue;
    }

    const phaseNode = createVoicePhaseNode(event);
    if (phaseNode) {
      turnNode.children.push(phaseNode);
    }
  }

  return sortTreeNodes([sessionNode]);
}

function collapseConsecutive(nodes: TreeNode[]): TreeNode[] {
  const result: TreeNode[] = [];
  let i = 0;
  while (i < nodes.length) {
    const node = nodes[i];
    if (COLLAPSIBLE_TYPES.has(node.type)) {
      const group: TreeNode[] = [node];
      while (i + 1 < nodes.length && nodes[i + 1].type === node.type) {
        i++;
        group.push(nodes[i]);
      }
      if (group.length > 1) {
        const allPassed = group.every((n) => n.data?.passed !== false && n.data?.success !== false);
        const typeName =
          node.type === 'guardrail_check'
            ? 'guardrails'
            : node.type === 'gather_extraction'
              ? 'extractions'
              : node.type === 'correction'
                ? 'corrections'
                : 'constraints';
        const totalMs = group.reduce((sum, n) => sum + (n.latencyMs || 0), 0);
        result.push({
          id: `group-${node.id}`,
          type: node.type as TreeNodeType,
          label: `${typeName} (${group.length}) ${allPassed ? '✓' : '✗'}`,
          latencyMs: totalMs,
          children: group,
          data: { collapsed: true, count: group.length, allPassed },
        });
      } else {
        result.push(node);
      }
    } else {
      result.push(node);
    }
    i++;
  }
  return result;
}

// ── Agent span tracking ─────────────────────────────────────────────────────

/** Represents an open agent span that collects child events */
interface AgentSpan {
  spanId: string;
  agentName: string;
  node: TreeNode;
  startTime: number;
  endTime?: number;
  /** The agent span this was invoked from (for nesting sub-agents) */
  parentAgentName?: string;
}

/**
 * Resolve the agent name for an event. Prefers top-level agentName field
 * (set by ClickHouse platform_events), falls back to data.agentName.
 */
function resolveEventAgent(event: TraceEvent): string {
  const rawEvent = event as unknown as Record<string, unknown>;
  const top = rawEvent.agentName;
  if (typeof top === 'string' && top) return top;
  const snakeTop = rawEvent.agent_name;
  if (typeof snakeTop === 'string' && snakeTop) return snakeTop;
  const data = event.data || {};
  if (typeof data.agentName === 'string' && data.agentName) return data.agentName;
  if (typeof data.agent_name === 'string' && data.agent_name) return data.agent_name;
  if (typeof data.agent === 'string' && data.agent) return data.agent;
  return '';
}

function isAttachmentTreeEventType(type: string): boolean {
  return ATTACHMENT_TREE_EVENT_TYPES.has(type);
}

/**
 * Build a tree node from a non-agent event (llm_call, tool_call, decision, etc.)
 */
function buildEventNode(event: TraceEvent): TreeNode | null {
  const eventData = event.data || {};
  const type = event.type;
  const spanId = resolveTraceSpanId(event);

  switch (type) {
    case 'llm_call': {
      const tokens = extractTokens(eventData);
      return {
        id: event.id,
        type: 'llm_call',
        label: resolveLLMLabel(eventData),
        spanId,
        detail: typeof eventData.model === 'string' ? eventData.model : undefined,
        tokens,
        latencyMs: event.durationMs || (eventData.durationMs as number) || undefined,
        timestamp: toISOString(event.timestamp),
        children: [],
        data: eventData,
      };
    }

    case 'tool_call': {
      const toolName =
        typeof eventData.toolName === 'string'
          ? eventData.toolName
          : typeof eventData.tool_name === 'string'
            ? eventData.tool_name
            : typeof eventData.tool === 'string'
              ? eventData.tool
              : typeof eventData.name === 'string'
                ? eventData.name
                : '';
      const systemType = SYSTEM_TOOLS[toolName];
      if (systemType) {
        const input = eventData.input as Record<string, unknown> | undefined;
        const target = (input?.target as string) || '';
        if (systemType === 'handoff') {
          return {
            id: event.id,
            type: 'handoff',
            label: target ? `handoff → ${target}` : 'Handoff',
            children: [],
            data: eventData,
          };
        } else if (systemType === 'delegate_action') {
          return {
            id: event.id,
            type: 'delegate_action',
            label: target ? `delegate → ${target}` : 'Delegate',
            children: [],
            data: eventData,
          };
        } else {
          return {
            id: event.id,
            type: systemType,
            label: systemType === 'complete' ? 'Complete' : 'Escalate',
            children: [],
            data: eventData,
          };
        }
      }
      return {
        id: event.id,
        type: 'tool_call',
        label: resolveToolLabel(eventData),
        spanId,
        detail: toolName || undefined,
        latencyMs: event.durationMs || (eventData.durationMs as number) || undefined,
        children: [],
        data: eventData,
      };
    }

    case 'attachment_process':
      return {
        id: event.id,
        type: 'attachment_process',
        label: formatAttachmentLabel('attachment_process', eventData),
        spanId,
        detail: typeof eventData.stage === 'string' ? eventData.stage : undefined,
        latencyMs: event.durationMs || (eventData.durationMs as number) || undefined,
        timestamp: toISOString(event.timestamp),
        children: [],
        data: eventData,
      };

    case 'attachment_upload':
      return {
        id: event.id,
        type: 'attachment_upload',
        label: formatAttachmentLabel('attachment_upload', eventData),
        spanId,
        detail: typeof eventData.attachmentId === 'string' ? eventData.attachmentId : undefined,
        latencyMs: event.durationMs || (eventData.durationMs as number) || undefined,
        timestamp: toISOString(event.timestamp),
        children: [],
        data: eventData,
      };

    case 'attachment_preprocess':
      return {
        id: event.id,
        type: 'attachment_preprocess',
        label: formatAttachmentLabel('attachment_preprocess', eventData),
        spanId,
        latencyMs: event.durationMs || (eventData.durationMs as number) || undefined,
        timestamp: toISOString(event.timestamp),
        children: [],
        data: eventData,
      };

    case 'decision':
      return {
        id: event.id,
        type: 'decision',
        label: resolveDecisionLabel(eventData),
        spanId,
        latencyMs: event.durationMs || (eventData.durationMs as number) || undefined,
        children: [],
        data: eventData,
      };

    case 'constraint_check':
      return {
        id: event.id,
        type: 'constraint_check' as TreeNodeType,
        label: `constraint: ${eventData.constraint || 'check'}`,
        spanId,
        latencyMs: event.durationMs || (eventData.durationMs as number) || undefined,
        children: [],
        data: eventData,
      };

    case 'guardrail_check':
      return {
        id: event.id,
        type: 'guardrail_check',
        label: `guardrail: ${eventData.constraint || eventData.name || 'check'}`,
        spanId,
        latencyMs: event.durationMs || (eventData.durationMs as number) || undefined,
        children: [],
        data: eventData,
      };

    case 'gather_extraction':
      return {
        id: event.id,
        type: 'gather_extraction',
        label: `extraction: ${eventData.fieldName || eventData.field || 'extract'}`,
        spanId,
        latencyMs: event.durationMs || (eventData.durationMs as number) || undefined,
        children: [],
        data: eventData,
      };

    case 'correction':
      return {
        id: event.id,
        type: 'correction',
        label: `correction: ${eventData.field || eventData.reason || 'fix'}`,
        spanId,
        latencyMs: event.durationMs || (eventData.durationMs as number) || undefined,
        children: [],
        data: eventData,
      };

    case 'flow_step_enter':
      return {
        id: event.id,
        type: 'flow_step',
        label: `step: ${eventData.stepName || 'Step'}`,
        spanId,
        detail: typeof eventData.stepName === 'string' ? eventData.stepName : undefined,
        children: [],
        data: eventData,
      };

    case 'flow_transition': {
      const from = typeof eventData.fromStep === 'string' ? eventData.fromStep : '';
      const to = typeof eventData.toStep === 'string' ? eventData.toStep : '';
      return {
        id: event.id,
        type: 'flow_transition',
        label: from && to ? `${from} → ${to}` : 'transition',
        spanId,
        children: [],
        data: eventData,
      };
    }

    case 'error': {
      const msg =
        typeof eventData.errorMessage === 'string'
          ? eventData.errorMessage
          : typeof eventData.message === 'string'
            ? eventData.message
            : 'Error';
      return {
        id: event.id,
        type: 'error',
        label: `error: ${msg.slice(0, 60)}`,
        spanId,
        children: [],
        data: eventData,
      };
    }

    case 'handoff':
      return {
        id: event.id,
        type: 'handoff',
        label: eventData.to
          ? `handoff → ${eventData.to}`
          : eventData.from
            ? `handoff from ${eventData.from}`
            : 'Handoff',
        spanId,
        children: [],
        data: eventData,
      };

    case 'voice_turn':
      return {
        id: event.id,
        type: 'voice_turn',
        label: getVoiceTurnLabel(eventData, resolveVoiceTurnKey(eventData, event.id)),
        spanId,
        latencyMs: event.durationMs || (eventData.durationMs as number) || undefined,
        timestamp: toISOString(event.timestamp),
        children: [],
        data: eventData,
      };

    case 'voice_stt':
      return {
        id: event.id,
        type: 'voice_stt',
        label: 'Speech-to-Text',
        spanId,
        detail: typeof eventData.provider === 'string' ? eventData.provider : undefined,
        latencyMs: event.durationMs || (eventData.durationMs as number) || undefined,
        timestamp: toISOString(event.timestamp),
        children: [],
        data: eventData,
      };

    case 'voice_tts':
      return {
        id: event.id,
        type: 'voice_tts',
        label: 'Text-to-Speech',
        spanId,
        detail: typeof eventData.provider === 'string' ? eventData.provider : undefined,
        latencyMs: event.durationMs || (eventData.durationMs as number) || undefined,
        timestamp: toISOString(event.timestamp),
        children: [],
        data: eventData,
      };

    case 'voice_realtime_tool_call': {
      const toolName =
        typeof eventData.toolName === 'string'
          ? eventData.toolName
          : typeof eventData.tool_name === 'string'
            ? eventData.tool_name
            : 'unknown';
      return {
        id: event.id,
        type: 'voice_realtime_tool_call',
        label: `Tool Call: ${toolName}`,
        spanId,
        detail: toolName,
        latencyMs: event.durationMs || (eventData.durationMs as number) || undefined,
        timestamp: toISOString(event.timestamp),
        children: [],
        data: eventData,
      };
    }

    case 'voice_barge_in':
      return {
        id: event.id,
        type: 'voice_barge_in',
        label: 'Barge-In',
        spanId,
        latencyMs: event.durationMs || (eventData.durationMs as number) || undefined,
        timestamp: toISOString(event.timestamp),
        children: [],
        data: eventData,
      };

    default:
      return null;
  }
}

/**
 * Build agent-centric tree using spanId/agentName correlation instead of a
 * linear stack. This correctly handles parallel delegates and sub-agents.
 *
 * Algorithm:
 * 1. Identify agent spans from agent_enter/agent_exit pairs (matched by spanId)
 * 2. For each non-agent event, find the owning agent span by agentName + time window
 * 3. Nest sub-agent spans under their parent agent based on time containment
 */
function buildAgentNodes(
  events: TraceEvent[],
  sessionAgentName?: string,
  options: { synthesizeOrphanEvents?: boolean } = {},
): TreeNode[] {
  // ── Pass 1: Identify agent spans ──────────────────────────────────────────
  const agentSpans: AgentSpan[] = [];
  const spanById = new Map<string, AgentSpan>();
  const orphanEventsByAgent = new Map<string, TreeNode[]>();

  for (const event of events) {
    const eventData = event.data || {};
    const spanId = resolveTraceSpanId(event);

    if (event.type === 'agent_enter') {
      const agentName = resolveEventAgent(event);
      const node: TreeNode = {
        id: event.id,
        type: 'agent',
        label: resolveAgentLabel(eventData, sessionAgentName),
        spanId,
        timestamp: toISOString(event.timestamp),
        children: [],
        data: eventData,
      };
      const span: AgentSpan = {
        spanId: spanId || `auto-${event.id}`,
        agentName,
        node,
        startTime: new Date(event.timestamp).getTime(),
      };
      agentSpans.push(span);
      if (spanId) spanById.set(spanId, span);
    }

    if (event.type === 'agent_exit') {
      // Match by spanId first, then by agent name (last unclosed)
      let span: AgentSpan | undefined;
      if (spanId) {
        span = spanById.get(spanId);
      }
      if (!span) {
        const exitAgent = resolveEventAgent(event);
        // Find last unclosed span for this agent
        for (let i = agentSpans.length - 1; i >= 0; i--) {
          if (agentSpans[i].agentName === exitAgent && !agentSpans[i].endTime) {
            span = agentSpans[i];
            break;
          }
        }
      }
      if (span) {
        span.endTime = new Date(event.timestamp).getTime();
        span.node.latencyMs = span.endTime - span.startTime;
      }
    }

    if (event.type === 'delegate_start') {
      const delegateData = event.data || {};
      const node: TreeNode = {
        id: event.id,
        type: 'sub_agent',
        label: resolveDelegateLabel(delegateData),
        spanId,
        timestamp: toISOString(event.timestamp),
        children: [],
        data: delegateData,
      };
      const span: AgentSpan = {
        spanId: spanId || `delegate-${event.id}`,
        agentName: (delegateData.targetAgent as string) || (delegateData.to as string) || '',
        node,
        startTime: new Date(event.timestamp).getTime(),
      };
      agentSpans.push(span);
      if (spanId) spanById.set(spanId, span);
    }

    if (event.type === 'delegate_complete') {
      let span: AgentSpan | undefined;
      if (spanId) span = spanById.get(spanId);
      if (span) {
        span.endTime = new Date(event.timestamp).getTime();
        span.node.latencyMs = span.endTime - span.startTime;
      }
    }
  }

  // Close any unclosed spans (use last event timestamp)
  if (events.length > 0) {
    const lastTs = new Date(events[events.length - 1].timestamp).getTime();
    for (const span of agentSpans) {
      if (!span.endTime) span.endTime = lastTs;
    }
  }

  // ── Pass 2: Assign non-agent events to their owning agent span ────────────
  for (const event of events) {
    if (
      event.type === 'agent_enter' ||
      event.type === 'agent_exit' ||
      event.type === 'delegate_start' ||
      event.type === 'delegate_complete' ||
      event.type === 'session_start' ||
      event.type === 'session_end' ||
      event.type === 'session_ended'
    ) {
      continue;
    }

    const node = buildEventNode(event);
    if (!node) continue;

    const eventAgent = resolveEventAgent(event);
    const eventTime = new Date(event.timestamp).getTime();

    // Find the owning agent span: match by agentName + time containment
    let ownerSpan: AgentSpan | undefined;
    for (let i = agentSpans.length - 1; i >= 0; i--) {
      const span = agentSpans[i];
      if (
        span.agentName === eventAgent &&
        eventTime >= span.startTime &&
        eventTime <= (span.endTime || Infinity)
      ) {
        ownerSpan = span;
        break;
      }
    }

    if (!ownerSpan && isAttachmentTreeEventType(event.type)) {
      for (let i = agentSpans.length - 1; i >= 0; i--) {
        const span = agentSpans[i];
        if (eventTime >= span.startTime && eventTime <= (span.endTime || Infinity)) {
          ownerSpan = span;
          break;
        }
      }
    }

    if (!ownerSpan && isAttachmentTreeEventType(event.type)) {
      let closestFutureDelta = Infinity;
      for (const span of agentSpans) {
        const delta = span.startTime - eventTime;
        if (delta >= 0 && delta <= PRE_AGENT_ATTACHMENT_WINDOW_MS && delta < closestFutureDelta) {
          closestFutureDelta = delta;
          ownerSpan = span;
        }
      }
    }

    if (ownerSpan) {
      ownerSpan.node.children.push(node);
    } else if (options.synthesizeOrphanEvents && !isVoiceLifecycleTreeEvent(event)) {
      const fallbackAgent = eventAgent || sessionAgentName || 'Agent';
      const nodes = orphanEventsByAgent.get(fallbackAgent) ?? [];
      nodes.push(node);
      orphanEventsByAgent.set(fallbackAgent, nodes);
    }
    // Events without a matching agent span are either synthesized for
    // conversation replay or dropped as noise in trace-only views.
  }

  if (options.synthesizeOrphanEvents) {
    for (const [agentName, orphanNodes] of orphanEventsByAgent) {
      if (orphanNodes.length === 0) {
        continue;
      }

      const sortedOrphans = sortTreeNodes(orphanNodes);
      const firstNode = sortedOrphans[0];
      const lastNode = sortedOrphans[sortedOrphans.length - 1];
      const startTime = getNodeTimestampMs(firstNode);
      const endTime = getNodeTimestampMs(lastNode) || startTime;
      const syntheticSpanId = `synthetic-agent-${agentName}-${startTime || 'unknown'}`;
      agentSpans.push({
        spanId: syntheticSpanId,
        agentName,
        startTime,
        endTime,
        node: {
          id: syntheticSpanId,
          type: 'agent',
          label: resolveAgentLabel({ agentName }, sessionAgentName),
          spanId: syntheticSpanId,
          timestamp: firstNode.timestamp,
          latencyMs: endTime >= startTime ? endTime - startTime : undefined,
          children: sortedOrphans,
          data: {
            agentName,
            synthetic: true,
            reason: 'orphan_trace_events',
          },
        },
      });
    }
  }

  // ── Pass 3: Nest sub-agent spans under parent agents ──────────────────────
  // A sub-agent span whose time window is contained within a parent agent's
  // time window becomes a child of that parent.
  const topLevel: TreeNode[] = [];
  const nested = new Set<AgentSpan>();

  for (const span of agentSpans) {
    // Find the innermost parent agent span that contains this span's time window
    let bestParent: AgentSpan | undefined;
    let bestDuration = Infinity;

    for (const candidate of agentSpans) {
      if (candidate === span) continue;
      if (candidate.agentName === span.agentName) continue; // Same agent can't be its own parent
      const cStart = candidate.startTime;
      const cEnd = candidate.endTime || Infinity;
      if (span.startTime >= cStart && (span.endTime || Infinity) <= cEnd) {
        const duration = cEnd - cStart;
        if (duration < bestDuration) {
          bestDuration = duration;
          bestParent = candidate;
        }
      }
    }

    if (bestParent) {
      // Insert as child at the correct chronological position
      const children = bestParent.node.children;
      let insertIdx = children.length;
      for (let i = 0; i < children.length; i++) {
        const childTime = children[i].timestamp ? new Date(children[i].timestamp!).getTime() : 0;
        if (span.startTime < childTime) {
          insertIdx = i;
          break;
        }
      }
      children.splice(insertIdx, 0, span.node);
      nested.add(span);
    }
  }

  // Top-level spans are those not nested under any parent
  for (const span of agentSpans) {
    if (!nested.has(span)) {
      topLevel.push(span.node);
    }
  }

  // ── Pass 4: Collapse consecutive collapsible nodes within each agent ──────
  for (const span of agentSpans) {
    span.node.children = collapseConsecutive(span.node.children);
  }

  return topLevel;
}

/**
 * Build an agent-centric tree from messages and trace events.
 * Agents are top-level nodes. User messages appear as separators.
 */
export function buildAgentTree(
  messages: SessionMessage[],
  traceEvents: TraceEvent[],
  sessionAgentName?: string,
): TreeNode[] {
  if (!traceEvents.length && !messages.length) return [];

  // Sort events chronologically
  const sorted = [...traceEvents].sort(
    (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime(),
  );

  // Build the agent nodes from trace events
  const agentNodes = buildAgentNodes(sorted, sessionAgentName, {
    synthesizeOrphanEvents: messages.length > 0,
  });

  if (agentNodes.length === 0) {
    const voiceTree = buildVoiceTree(sorted);
    if (voiceTree.length > 0) {
      return voiceTree;
    }
  }

  // If no messages, return agent nodes directly
  if (!messages.length) return agentNodes;

  // Interleave user/assistant messages as a conversation-first narrative:
  // user input -> execution flow -> agent response. This keeps the chat spine
  // readable while still exposing the spans that happened between messages.
  const sortedMsgs = prepareTreeMessages(messages);
  const sortedAgentNodes = sortTreeNodes([...agentNodes]);
  const consumedAgentNodeIds = new Set<string>();
  const consumedMessageIds = new Set<string>();

  const result: TreeNode[] = [];

  const flushAgentNodesBefore = (timestampMs: number) => {
    for (const node of sortedAgentNodes) {
      if (consumedAgentNodeIds.has(node.id)) {
        continue;
      }
      if (getNodeTimestampMs(node) < timestampMs) {
        result.push(node);
        consumedAgentNodeIds.add(node.id);
      }
    }
  };

  const appendAgentNodesInWindow = (startMs: number, endMs: number) => {
    for (const node of sortedAgentNodes) {
      if (consumedAgentNodeIds.has(node.id)) {
        continue;
      }
      const nodeTime = getNodeTimestampMs(node);
      if (nodeTime >= startMs && nodeTime < endMs) {
        result.push(node);
        consumedAgentNodeIds.add(node.id);
      }
    }
  };

  const findNextUserIndex = (startIndex: number): number => {
    for (let i = startIndex + 1; i < sortedMsgs.length; i++) {
      if (sortedMsgs[i].role === 'user') {
        return i;
      }
    }
    return -1;
  };

  const findAssistantResponseIndex = (startIndex: number, endIndex: number): number => {
    const limit = endIndex === -1 ? sortedMsgs.length : endIndex;
    for (let i = startIndex + 1; i < limit; i++) {
      if (sortedMsgs[i].role === 'assistant') {
        return i;
      }
    }
    return -1;
  };

  for (let index = 0; index < sortedMsgs.length; index++) {
    const msg = sortedMsgs[index];
    if (consumedMessageIds.has(msg.id)) {
      continue;
    }

    const content = msg.content?.trim() || '';
    if (!content) {
      continue;
    }

    const msgTime = new Date(msg.timestamp).getTime();

    if (msg.role === 'user') {
      const nextUserIndex = findNextUserIndex(index);
      const nextUserTime =
        nextUserIndex === -1
          ? Number.POSITIVE_INFINITY
          : new Date(sortedMsgs[nextUserIndex].timestamp).getTime();
      const responseIndex = findAssistantResponseIndex(index, nextUserIndex);
      const turnStartMs = msgTime - PRE_TURN_AGENT_WINDOW_MS;

      flushAgentNodesBefore(turnStartMs);
      result.push(createUserMessageNode(msg, content));
      consumedMessageIds.add(msg.id);
      appendAgentNodesInWindow(turnStartMs, nextUserTime);

      if (responseIndex !== -1) {
        const responseMessage = sortedMsgs[responseIndex];
        const responseContent = responseMessage.content?.trim() || '';
        if (responseContent) {
          result.push(
            createAssistantMessageNode(responseMessage, responseContent, sessionAgentName),
          );
          consumedMessageIds.add(responseMessage.id);
        }
      }
      continue;
    }

    if (msg.role === 'assistant') {
      flushAgentNodesBefore(msgTime);
      result.push(createAssistantMessageNode(msg, content, sessionAgentName));
      consumedMessageIds.add(msg.id);
    }
  }

  for (const node of sortedAgentNodes) {
    if (!consumedAgentNodeIds.has(node.id)) {
      result.push(node);
    }
  }

  return result;
}
