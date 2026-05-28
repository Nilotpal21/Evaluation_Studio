export type RuntimeTracePhase =
  | 'session'
  | 'message'
  | 'agent_lifecycle'
  | 'decision'
  | 'llm'
  | 'tool'
  | 'flow'
  | 'handoff'
  | 'delegate'
  | 'guardrail'
  | 'memory'
  | 'attachment'
  | 'voice'
  | 'channel'
  | 'error'
  | 'runtime';

export interface RuntimeTraceCausalFields {
  turnId?: string;
  executionId?: string;
  parentExecutionId?: string;
  agentRunId?: string;
  decisionId?: string;
  parentDecisionId?: string;
  causeEventId?: string;
  phase: RuntimeTracePhase;
  reasonCode?: string;
}

export interface RuntimeTraceCausalInput {
  id: string;
  sessionId: string;
  type: string;
  data: Record<string, unknown>;
  agentName?: string;
}

export interface RuntimeTraceCausalTracker {
  enrich(input: RuntimeTraceCausalInput): RuntimeTraceCausalFields;
}

const CAUSAL_FIELD_NAMES = [
  'turnId',
  'executionId',
  'parentExecutionId',
  'agentRunId',
  'decisionId',
  'parentDecisionId',
  'causeEventId',
  'phase',
  'reasonCode',
] as const satisfies readonly (keyof RuntimeTraceCausalFields)[];

const AGENT_RUN_FIELD_NAMES = ['agentRunId', 'agent_run_id'] as const;
const AGENT_NAME_FIELD_NAMES = [
  'agentName',
  'agent',
  'activeAgent',
  'fromAgent',
  'toAgent',
] as const;
const TURN_FIELD_NAMES = ['turnId', 'turn_id', 'messageId', 'userMessageId'] as const;
const EXECUTION_FIELD_NAMES = ['executionId', 'execution_id'] as const;
const PARENT_EXECUTION_FIELD_NAMES = ['parentExecutionId', 'parent_execution_id'] as const;
const DECISION_FIELD_NAMES = ['decisionId', 'decision_id'] as const;
const PARENT_DECISION_FIELD_NAMES = ['parentDecisionId', 'parent_decision_id'] as const;
const CAUSE_FIELD_NAMES = ['causeEventId', 'cause_event_id'] as const;
const REASON_FIELD_NAMES = [
  'reasonCode',
  'reason_code',
  'outcomeReasonCode',
  'errorCode',
  'errorType',
  'code',
] as const;

const FIELD_NAME_BY_CAUSAL_KEY: Record<keyof RuntimeTraceCausalFields, string> = {
  turnId: 'turnId',
  executionId: 'executionId',
  parentExecutionId: 'parentExecutionId',
  agentRunId: 'agentRunId',
  decisionId: 'decisionId',
  parentDecisionId: 'parentDecisionId',
  causeEventId: 'causeEventId',
  phase: 'phase',
  reasonCode: 'reasonCode',
};

const CAUSAL_TRACKER_MAX_AGENT_KEYS = 128;
const CAUSAL_TRACKER_ENTRY_TTL_MS = 30 * 60 * 1000;

interface CausalTrackerEntry<T> {
  value: T;
  lastSeenAtMs: number;
}

export function createRuntimeTraceCausalTracker(): RuntimeTraceCausalTracker {
  const activeAgentRuns = new Map<string, CausalTrackerEntry<string>>();
  const agentRunCounters = new Map<string, CausalTrackerEntry<number>>();
  let previousEventId: string | undefined;

  return {
    enrich(input: RuntimeTraceCausalInput): RuntimeTraceCausalFields {
      const nowMs = Date.now();
      evictExpiredTrackerEntries(activeAgentRuns, nowMs);
      evictExpiredTrackerEntries(agentRunCounters, nowMs);
      const phase = deriveRuntimeTracePhase(input.type);
      const agentKey = resolveAgentKey(input);
      const explicitAgentRunId = readOptionalString(input.data, AGENT_RUN_FIELD_NAMES);
      const isAgentEnter = input.type === 'agent_enter';
      const isAgentExit = input.type === 'agent_exit';

      const activeAgentRunEntry = activeAgentRuns.get(agentKey);
      if (activeAgentRunEntry) {
        setBoundedTrackerEntry(activeAgentRuns, agentKey, activeAgentRunEntry.value, nowMs);
      }
      let agentRunId = explicitAgentRunId ?? activeAgentRunEntry?.value;
      if (isAgentEnter) {
        agentRunId =
          explicitAgentRunId ?? nextAgentRunId(input.sessionId, agentKey, agentRunCounters, nowMs);
        setBoundedTrackerEntry(activeAgentRuns, agentKey, agentRunId, nowMs);
      } else if (explicitAgentRunId) {
        setBoundedTrackerEntry(activeAgentRuns, agentKey, explicitAgentRunId, nowMs);
      }

      const decisionId =
        readOptionalString(input.data, DECISION_FIELD_NAMES) ??
        (phase === 'decision' ? input.id : undefined);

      const causal: RuntimeTraceCausalFields = {
        turnId: readOptionalString(input.data, TURN_FIELD_NAMES),
        executionId: readOptionalString(input.data, EXECUTION_FIELD_NAMES),
        parentExecutionId: readOptionalString(input.data, PARENT_EXECUTION_FIELD_NAMES),
        agentRunId,
        decisionId,
        parentDecisionId: readOptionalString(input.data, PARENT_DECISION_FIELD_NAMES),
        causeEventId: readOptionalString(input.data, CAUSE_FIELD_NAMES) ?? previousEventId,
        phase,
        reasonCode: deriveRuntimeTraceReasonCode(input.type, input.data, phase),
      };

      previousEventId = input.id;
      if (isAgentExit && agentRunId) {
        activeAgentRuns.delete(agentKey);
      }

      return causal;
    },
  };
}

export function attachRuntimeTraceCausalData(
  data: Record<string, unknown>,
  causal: RuntimeTraceCausalFields,
): Record<string, unknown> {
  const causalRecord = toDefinedRecord(causal);
  const existingCausal = asRecord(data.causal);
  const nextData: Record<string, unknown> = {
    ...data,
    causal: {
      ...existingCausal,
      ...causalRecord,
    },
  };

  for (const fieldName of CAUSAL_FIELD_NAMES) {
    const value = causal[fieldName];
    if (value !== undefined && nextData[FIELD_NAME_BY_CAUSAL_KEY[fieldName]] === undefined) {
      nextData[FIELD_NAME_BY_CAUSAL_KEY[fieldName]] = value;
    }
  }

  return nextData;
}

export function deriveRuntimeTracePhase(type: string): RuntimeTracePhase {
  if (
    type === 'session_start' ||
    type === 'session_end' ||
    type === 'session_complete' ||
    type === 'turn_start' ||
    type === 'turn_end'
  ) {
    return 'session';
  }
  if (type === 'user_message' || type === 'agent_response' || type === 'message_persisted') {
    return 'message';
  }
  if (type === 'agent_enter' || type === 'agent_exit' || type === 'agent_handoff') {
    return 'agent_lifecycle';
  }
  if (
    type === 'decision' ||
    type === 'completion_check' ||
    type === 'routing_capabilities_resolved' ||
    type === 'handoff_condition_check' ||
    type === 'constraint_check' ||
    type === 'engine_decision' ||
    type === 'deterministic_routing' ||
    type === 'deterministic_handoff' ||
    type.includes('decision')
  ) {
    return 'decision';
  }
  if (type === 'llm_call') {
    return 'llm';
  }
  if (type.startsWith('tool_') || type.includes('tool')) {
    return 'tool';
  }
  if (
    type === 'handoff_return_handler' ||
    type === 'resume_intent' ||
    type === 'thread_resume' ||
    type === 'return_to_parent'
  ) {
    return 'handoff';
  }
  if (type.startsWith('flow_') || type.includes('flow_transition')) {
    return 'flow';
  }
  if (type.includes('handoff')) {
    return 'handoff';
  }
  if (type.includes('delegate') || type.includes('delegation')) {
    return 'delegate';
  }
  if (type.includes('guardrail')) {
    return 'guardrail';
  }
  if (type.includes('memory')) {
    return 'memory';
  }
  if (type.includes('attachment')) {
    return 'attachment';
  }
  if (type.includes('voice') || type.includes('audio')) {
    return 'voice';
  }
  if (type.includes('channel') || type.includes('omnichannel')) {
    return 'channel';
  }
  if (type === 'error' || type === 'warning' || type.includes('error') || type.includes('fail')) {
    return 'error';
  }

  return 'runtime';
}

function deriveRuntimeTraceReasonCode(
  type: string,
  data: Record<string, unknown>,
  phase: RuntimeTracePhase,
): string | undefined {
  const explicitReasonCode = readOptionalString(data, REASON_FIELD_NAMES);
  if (explicitReasonCode) {
    return explicitReasonCode;
  }

  if (
    phase === 'decision' ||
    phase === 'agent_lifecycle' ||
    phase === 'handoff' ||
    phase === 'delegate' ||
    phase === 'guardrail' ||
    phase === 'error'
  ) {
    return type;
  }

  return undefined;
}

function resolveAgentKey(input: RuntimeTraceCausalInput): string {
  return (
    input.agentName ??
    readOptionalString(input.data, AGENT_NAME_FIELD_NAMES) ??
    readNestedAgentName(input.data) ??
    'unknown-agent'
  );
}

function readNestedAgentName(data: Record<string, unknown>): string | undefined {
  const activeAgent = asRecord(data.activeAgent);
  return readOptionalString(activeAgent, ['name'] as const);
}

function nextAgentRunId(
  sessionId: string,
  agentKey: string,
  counters: Map<string, CausalTrackerEntry<number>>,
  nowMs: number,
): string {
  const counterEntry = counters.get(agentKey);
  const nextCount = (counterEntry?.value ?? 0) + 1;
  setBoundedTrackerEntry(counters, agentKey, nextCount, nowMs);
  return `${sessionId}:${sanitizeIdPart(agentKey)}:${nextCount}`;
}

function setBoundedTrackerEntry<T>(
  entries: Map<string, CausalTrackerEntry<T>>,
  key: string,
  value: T,
  nowMs: number,
): void {
  if (entries.has(key)) {
    entries.delete(key);
  }
  entries.set(key, { value, lastSeenAtMs: nowMs });
  evictOverflowTrackerEntries(entries);
}

function evictExpiredTrackerEntries<T>(
  entries: Map<string, CausalTrackerEntry<T>>,
  nowMs: number,
): void {
  for (const [key, entry] of entries) {
    if (nowMs - entry.lastSeenAtMs > CAUSAL_TRACKER_ENTRY_TTL_MS) {
      entries.delete(key);
    }
  }
}

function evictOverflowTrackerEntries<T>(entries: Map<string, CausalTrackerEntry<T>>): void {
  while (entries.size > CAUSAL_TRACKER_MAX_AGENT_KEYS) {
    const oldestKey = entries.keys().next().value as string | undefined;
    if (!oldestKey) {
      return;
    }
    entries.delete(oldestKey);
  }
}

function sanitizeIdPart(value: string): string {
  return value.replace(/[^A-Za-z0-9_.:-]/g, '_');
}

function readOptionalString(
  data: Record<string, unknown>,
  fieldNames: readonly string[],
): string | undefined {
  for (const fieldName of fieldNames) {
    const value = data[fieldName];
    if (typeof value === 'string' && value.length > 0) {
      return value;
    }
  }
  return undefined;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function toDefinedRecord(fields: RuntimeTraceCausalFields): Record<string, string> {
  const record: Record<string, string> = {};
  for (const fieldName of CAUSAL_FIELD_NAMES) {
    const value = fields[fieldName];
    if (value !== undefined) {
      record[FIELD_NAME_BY_CAUSAL_KEY[fieldName]] = value;
    }
  }
  return record;
}
