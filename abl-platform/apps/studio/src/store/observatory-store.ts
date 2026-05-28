/**
 * Observatory Store
 *
 * Manages debug state, spans, and agent flow for visual debugging
 */

import { create } from 'zustand';
import { boundedPush, boundedMapSet } from '../lib/bounded-collection';
import { normalizeEventType } from '../lib/event-types';
import type {
  ExtendedTraceEvent,
  Span,
  SpanTreeNode,
  AgentFlowNode,
  AgentFlowEdge,
  Breakpoint,
  BreakpointType,
  DebugState,
  DebugSession,
  StaticGraph,
  NodeExecutionState,
  AppStaticGraph,
} from '../types';

// View mode for main canvas
export type CanvasViewMode = 'graph' | 'chat' | 'split' | 'app';

// Debug panel tab (consolidated from 10 to 5)
export type DebugTab =
  | 'overview'
  | 'traces'
  | 'data'
  | 'conversation'
  | 'performance'
  | 'ir'
  | 'voice'
  | 'errors'
  | 'interactions';

// Metrics types
export interface StepMetrics {
  visitCount: number;
  totalTimeMs: number;
  lastVisitTime?: Date;
  errors: number;
}

export interface ConstraintCheckResult {
  timestamp: Date;
  phaseName: string;
  condition: string;
  passed: boolean;
  value?: unknown;
  failureMessage?: string;
}

export interface TimelineEvent {
  id: string;
  timestamp: Date;
  type:
    | 'step_enter'
    | 'step_exit'
    | 'llm_call'
    | 'tool_call'
    | 'constraint_check'
    | 'handoff'
    | 'complete'
    | 'error'
    | 'completion_check'
    | 'engine_decision'
    | 'handoff_condition_check'
    | 'thread_return'
    | 'warning'
    | 'user_message';
  label: string;
  durationMs?: number;
  details?: Record<string, unknown>;
  status?: 'success' | 'error' | 'pending';
}

export interface ObservatorySelectionState {
  executionNodeId: string | null;
  spanId: string | null;
}

interface ObservatoryStore {
  // Connection state
  debugState: DebugState;
  debugSession: DebugSession | null;

  // Spans and events
  spans: Map<string, Span>;
  events: ExtendedTraceEvent[];
  // A4: Track seen event IDs to prevent duplicates from SSE reconnections
  seenEventIds: Set<string>;
  activeSpanIds: string[];
  activeAgentSpanIdsByAgent: Map<string, string[]>;
  activeStepSpanIdsByAgentStep: Map<string, string[]>;

  // Metrics tracking
  stepMetrics: Map<string, StepMetrics>;
  constraintHistory: ConstraintCheckResult[];
  sessionStartTime: Date | null;
  totalTokensIn: number;
  totalTokensOut: number;
  totalLLMCalls: number;
  totalToolCalls: number;

  // Client-side timing (true end-to-end)
  pendingMessageStartTime: number | null;
  lastVolleyClientMs: number;
  volleyClientTimes: number[];
  avgVolleyClientMs: number;

  // Agent flow
  flowNodes: AgentFlowNode[];
  flowEdges: AgentFlowEdge[];

  // Static graph (state machine visualization)
  staticGraph: StaticGraph | null;
  executionState: Map<string, NodeExecutionState>;

  // App-level graph (multi-agent visualization)
  appStaticGraph: AppStaticGraph | null;
  appExecutionState: Map<string, Map<string, NodeExecutionState>>; // agentName -> nodeId -> state
  graphViewMode: 'single' | 'app'; // Toggle between single agent and app view

  // Breakpoints
  breakpoints: Breakpoint[];

  // UI state
  selection: ObservatorySelectionState;
  showObservatory: boolean;
  activeTab: 'timeline' | 'spans' | 'flow' | 'state-machine' | 'breakpoints';

  // New: Canvas view mode and app navigation
  canvasViewMode: CanvasViewMode;
  selectedAppDomain: string | null;
  selectedAgentName: string | null;
  expandedApps: Set<string>;
  sessionSidebarOpen: boolean;
  debugPanelTab: DebugTab;
  debugPanelOpen: boolean;
  debugPanelWidth: number;
  debugPanelMode: 'docked' | 'floating';
  debugPanelPosition: { x: number; y: number };
  debugPanelSize: { width: number; height: number };
  logs: Array<{ timestamp: Date; level: 'info' | 'warn' | 'error'; message: string }>;

  // Actions - Connection
  setDebugState: (state: DebugState) => void;
  setDebugSession: (session: DebugSession | null) => void;

  // Actions - Events
  addEvent: (event: ExtendedTraceEvent) => boolean;
  clearEvents: () => void;

  // Actions - Spans
  startSpan: (
    spanId: string,
    name: string,
    traceId: string,
    sessionId: string,
    agentName: string,
    parentSpanId?: string,
    timestamp?: Date,
    attributes?: Record<string, unknown>,
  ) => void;
  endSpan: (spanId: string, status?: 'completed' | 'error', timestamp?: Date) => void;
  addEventToSpan: (spanId: string, event: ExtendedTraceEvent) => void;

  // Actions - Flow
  addFlowNode: (node: AgentFlowNode) => void;
  updateFlowNode: (id: string, updates: Partial<AgentFlowNode>) => void;
  addFlowEdge: (edge: AgentFlowEdge) => void;
  clearFlow: () => void;

  // Actions - Static Graph (State Machine)
  setStaticGraph: (graph: StaticGraph | null) => void;
  updateNodeExecutionState: (nodeId: string, state: NodeExecutionState) => void;
  clearExecutionState: () => void;

  // Actions - App Graph (Multi-Agent)
  setAppStaticGraph: (graph: AppStaticGraph | null) => void;
  updateAppNodeExecutionState: (
    agentName: string,
    nodeId: string,
    state: NodeExecutionState,
  ) => void;
  clearAppExecutionState: () => void;
  setGraphViewMode: (mode: 'single' | 'app') => void;

  // Actions - Breakpoints
  addBreakpoint: (type: BreakpointType, spec: Breakpoint['spec']) => void;
  removeBreakpoint: (id: string) => void;
  toggleBreakpoint: (id: string) => void;
  clearBreakpoints: () => void;

  // Actions - UI
  selectExecutionNode: (id: string | null) => void;
  selectSpan: (id: string | null) => void;
  clearSelection: () => void;
  setShowObservatory: (show: boolean) => void;
  setActiveTab: (tab: 'timeline' | 'spans' | 'flow' | 'state-machine' | 'breakpoints') => void;

  // Actions - Canvas and Navigation
  setCanvasViewMode: (mode: CanvasViewMode) => void;
  setSelectedApp: (domain: string | null) => void;
  setSelectedAgent: (agentName: string | null) => void;
  toggleAppExpanded: (domain: string) => void;
  toggleSessionSidebar: () => void;
  setDebugPanelTab: (tab: DebugTab) => void;
  setDebugPanelOpen: (open: boolean) => void;
  setDebugPanelWidth: (width: number) => void;
  setDebugPanelMode: (mode: 'docked' | 'floating') => void;
  setDebugPanelPosition: (pos: { x: number; y: number }) => void;
  setDebugPanelSize: (size: { width: number; height: number }) => void;
  toggleDebugPanel: () => void;
  addLog: (level: 'info' | 'warn' | 'error', message: string) => void;
  clearLogs: () => void;

  // Actions - Metrics
  recordStepVisit: (stepName: string, durationMs?: number, isError?: boolean) => void;
  recordConstraintCheck: (result: ConstraintCheckResult) => void;
  resetMetrics: () => void;

  // Actions - Client-side timing
  startClientTimer: () => void;
  endClientTimer: () => void;
  recordClientRoundTrip: (durationMs: number) => void; // For REST APIs or direct measurement

  // Computed
  getSpanTree: () => SpanTreeNode[];
  getSpan: (id: string) => Span | undefined;
  getActiveSpan: () => Span | undefined;
  getTimeline: () => TimelineEvent[];
  getStepHeatmapData: () => Map<
    string,
    { visitCount: number; avgTimeMs: number; errorRate: number }
  >;
}

/**
 * Normalize decision event data at the ingestion edge.
 * Old stored events may use `kind`, `decisionType`, or `decision_type`
 * instead of the canonical `decisionKind`. This function unifies them
 * so all downstream UI code can rely on a single field name.
 */
function normalizeDecisionData(data: Record<string, unknown>): Record<string, unknown> {
  if (!data.decisionKind && ('kind' in data || 'decisionType' in data || 'decision_type' in data)) {
    data.decisionKind = data.kind || data.decisionType || data.decision_type;
  }
  return data;
}

function cloneAndNormalizeEventData(
  data: Record<string, unknown> | undefined,
): Record<string, unknown> {
  return normalizeDecisionData({ ...(data ?? {}) });
}

type SpanLifecycleKind = 'agent' | 'step';

function getAgentStepKey(agentName: string, stepName: string): string {
  return `${agentName}::${stepName}`;
}

function getSpanLifecycleMetadata(attributes: Record<string, unknown> | undefined): {
  kind?: SpanLifecycleKind;
  stepName?: string;
} {
  const kind = attributes?.kind;
  const stepName = attributes?.stepName;
  return {
    kind: kind === 'agent' || kind === 'step' ? kind : undefined,
    stepName: typeof stepName === 'string' ? stepName : undefined,
  };
}

function appendUniqueValue(values: string[], value: string): string[] {
  return [...values.filter((entry) => entry !== value), value];
}

function removeValue(values: string[], value: string): string[] {
  return values.filter((entry) => entry !== value);
}

function appendStackValue(
  map: Map<string, string[]>,
  key: string,
  value: string,
): Map<string, string[]> {
  const next = new Map(map);
  next.set(key, appendUniqueValue(next.get(key) ?? [], value));
  return next;
}

function removeStackValue(
  map: Map<string, string[]>,
  key: string,
  value: string,
): Map<string, string[]> {
  const current = map.get(key);
  if (!current) return map;

  const nextValues = removeValue(current, value);
  const next = new Map(map);
  if (nextValues.length === 0) {
    next.delete(key);
  } else {
    next.set(key, nextValues);
  }
  return next;
}

function getLastValue(values: string[] | undefined): string | undefined {
  return values && values.length > 0 ? values[values.length - 1] : undefined;
}

function registerSpanLifecycle(
  state: Pick<
    ObservatoryStore,
    'activeSpanIds' | 'activeAgentSpanIdsByAgent' | 'activeStepSpanIdsByAgentStep'
  >,
  span: Span,
): Pick<
  ObservatoryStore,
  'activeSpanIds' | 'activeAgentSpanIdsByAgent' | 'activeStepSpanIdsByAgentStep'
> {
  const { kind, stepName } = getSpanLifecycleMetadata(span.attributes);

  let activeAgentSpanIdsByAgent = state.activeAgentSpanIdsByAgent;
  let activeStepSpanIdsByAgentStep = state.activeStepSpanIdsByAgentStep;

  if (kind === 'agent') {
    activeAgentSpanIdsByAgent = appendStackValue(
      state.activeAgentSpanIdsByAgent,
      span.agentName,
      span.spanId,
    );
  }

  if (kind === 'step' && stepName) {
    activeStepSpanIdsByAgentStep = appendStackValue(
      state.activeStepSpanIdsByAgentStep,
      getAgentStepKey(span.agentName, stepName),
      span.spanId,
    );
  }

  return {
    activeSpanIds: appendUniqueValue(state.activeSpanIds, span.spanId),
    activeAgentSpanIdsByAgent,
    activeStepSpanIdsByAgentStep,
  };
}

function unregisterSpanLifecycle(
  state: Pick<
    ObservatoryStore,
    'activeSpanIds' | 'activeAgentSpanIdsByAgent' | 'activeStepSpanIdsByAgentStep'
  >,
  span: Span,
): Pick<
  ObservatoryStore,
  'activeSpanIds' | 'activeAgentSpanIdsByAgent' | 'activeStepSpanIdsByAgentStep'
> {
  const { kind, stepName } = getSpanLifecycleMetadata(span.attributes);

  let activeAgentSpanIdsByAgent = state.activeAgentSpanIdsByAgent;
  let activeStepSpanIdsByAgentStep = state.activeStepSpanIdsByAgentStep;

  if (kind === 'agent') {
    activeAgentSpanIdsByAgent = removeStackValue(
      state.activeAgentSpanIdsByAgent,
      span.agentName,
      span.spanId,
    );
  }

  if (kind === 'step' && stepName) {
    activeStepSpanIdsByAgentStep = removeStackValue(
      state.activeStepSpanIdsByAgentStep,
      getAgentStepKey(span.agentName, stepName),
      span.spanId,
    );
  }

  return {
    activeSpanIds: removeValue(state.activeSpanIds, span.spanId),
    activeAgentSpanIdsByAgent,
    activeStepSpanIdsByAgentStep,
  };
}

function getMostRecentActiveSpanIdForAgent(
  state: Pick<ObservatoryStore, 'activeSpanIds' | 'spans'>,
  agentName: string,
): string | undefined {
  for (let i = state.activeSpanIds.length - 1; i >= 0; i -= 1) {
    const spanId = state.activeSpanIds[i];
    const span = state.spans.get(spanId);
    if (span && span.agentName === agentName && span.status === 'running') {
      return spanId;
    }
  }
  return undefined;
}

function getActiveAgentSpanIdForAgent(
  state: Pick<ObservatoryStore, 'activeAgentSpanIdsByAgent'>,
  agentName: string,
): string | undefined {
  return getLastValue(state.activeAgentSpanIdsByAgent.get(agentName));
}

function getActiveStepSpanIdForAgentStep(
  state: Pick<ObservatoryStore, 'activeStepSpanIdsByAgentStep'>,
  agentName: string,
  stepName: string,
): string | undefined {
  return getLastValue(state.activeStepSpanIdsByAgentStep.get(getAgentStepKey(agentName, stepName)));
}

const SYNTHETIC_SPAN_EVENT_TYPES = new Set([
  'session_created',
  'session_start',
  'session_updated',
  'session_end',
  'session_ended',
  'voice_session_start',
  'voice_session_end',
  'voice_turn',
  'voice_turn_start',
  'voice_turn_end',
  'voice_stt',
  'voice_tts',
  'voice_llm',
  'voice_realtime_tool_call',
  'voice_barge_in',
  'voice_tts_quality',
  'voice_asr_quality',
  'voice_asr_cascade',
]);

const SYNTHETIC_SPAN_TERMINAL_EVENT_TYPES = new Set([
  'session_end',
  'session_ended',
  'voice_session_end',
]);

const SYNTHETIC_SPAN_ONE_SHOT_EVENT_TYPES = new Set([
  'voice_turn',
  'voice_turn_start',
  'voice_turn_end',
  'voice_stt',
  'voice_tts',
  'voice_llm',
  'voice_realtime_tool_call',
  'voice_barge_in',
  'voice_tts_quality',
  'voice_asr_quality',
  'voice_asr_cascade',
]);

function pickNumericData(...values: unknown[]): number | undefined {
  for (const value of values) {
    if (typeof value === 'number' && Number.isFinite(value)) {
      return value;
    }
  }

  return undefined;
}

function pickStringData(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === 'string' && value.length > 0) {
      return value;
    }
  }

  return undefined;
}

function isSyntheticSpanEventType(type: string): boolean {
  return SYNTHETIC_SPAN_EVENT_TYPES.has(type);
}

function isSyntheticSpanTerminalEventType(type: string): boolean {
  return SYNTHETIC_SPAN_TERMINAL_EVENT_TYPES.has(type);
}

function isSyntheticSpanOneShotEventType(type: string): boolean {
  return SYNTHETIC_SPAN_ONE_SHOT_EVENT_TYPES.has(type);
}

function resolveSyntheticSpanName(event: ExtendedTraceEvent): string {
  const data = event.data ?? {};

  switch (event.type) {
    case 'session_created':
    case 'session_start':
      return 'Session';
    case 'session_updated':
      return 'Session Update';
    case 'session_end':
    case 'session_ended':
      return 'Session End';
    case 'voice_session_start':
      return 'Voice Session';
    case 'voice_session_end':
      return 'Voice Session End';
    case 'voice_turn':
    case 'voice_turn_start':
    case 'voice_turn_end': {
      const turnLabel = pickNumericData(data.turn, data.turnNumber, data.turn_number);
      return turnLabel !== undefined ? `Voice Turn ${turnLabel}` : 'Voice Turn';
    }
    case 'voice_stt':
      return 'Speech-to-Text';
    case 'voice_tts':
      return 'Text-to-Speech';
    case 'voice_llm':
      return 'Voice LLM';
    case 'voice_realtime_tool_call':
      return 'Realtime Tool Call';
    case 'voice_barge_in':
      return 'Barge-In';
    case 'voice_tts_quality':
      return 'TTS Quality';
    case 'voice_asr_quality':
      return 'ASR Quality';
    case 'voice_asr_cascade':
      return 'ASR Cascade';
    default:
      return pickStringData(data.spanName, data.name, data.eventType) ?? event.type;
  }
}

function resolveSyntheticSpanStartTime(event: ExtendedTraceEvent): Date {
  const durationMs =
    pickNumericData(
      event.durationMs,
      event.data?.durationMs,
      event.data?.duration_ms,
      event.data?.latencyMs,
      event.data?.latency_ms,
    ) ?? 0;

  if (!isSyntheticSpanOneShotEventType(event.type) || durationMs <= 0) {
    return event.timestamp;
  }

  return new Date(event.timestamp.getTime() - durationMs);
}

function resolveSyntheticSpanStatus(event: ExtendedTraceEvent): 'completed' | 'error' {
  return event.data.status === 'error' || event.data.hasError === true || event.type === 'error'
    ? 'error'
    : 'completed';
}

const MAX_OBSERVATORY_EVENTS = 5000;
const MAX_SPANS = 3000;
const MAX_FLOW_NODES = 500;
const MAX_FLOW_EDGES = 1000;
const MAX_CONSTRAINT_HISTORY = 500;
const MAX_VOLLEY_CLIENT_TIMES = 200;
const MAX_SPAN_EVENTS = 200;
const MAX_STEP_METRICS = 500;

export const useObservatoryStore = create<ObservatoryStore>((set, get) => ({
  // Initial state
  debugState: 'disconnected',
  debugSession: null,
  spans: new Map(),
  events: [],
  seenEventIds: new Set(),
  activeSpanIds: [],
  activeAgentSpanIdsByAgent: new Map(),
  activeStepSpanIdsByAgentStep: new Map(),
  flowNodes: [],
  flowEdges: [],
  staticGraph: null,
  executionState: new Map(),
  appStaticGraph: null,
  appExecutionState: new Map(),
  graphViewMode: 'single',
  breakpoints: [],
  selection: {
    executionNodeId: null,
    spanId: null,
  },
  showObservatory: false,
  activeTab: 'timeline',

  // Metrics state
  stepMetrics: new Map(),
  constraintHistory: [],
  sessionStartTime: null,
  totalTokensIn: 0,
  totalTokensOut: 0,
  totalLLMCalls: 0,
  totalToolCalls: 0,

  // Client-side timing state
  pendingMessageStartTime: null,
  lastVolleyClientMs: 0,
  volleyClientTimes: [],
  avgVolleyClientMs: 0,

  // New state
  canvasViewMode: 'graph',
  selectedAppDomain: null,
  selectedAgentName: null,
  expandedApps: new Set<string>(),
  sessionSidebarOpen: true,
  debugPanelTab: 'overview',
  debugPanelOpen: false,
  debugPanelWidth: 480,
  debugPanelMode: 'docked',
  debugPanelPosition: { x: 100, y: 100 },
  debugPanelSize: { width: 520, height: 600 },
  logs: [],

  // Connection actions
  setDebugState: (state) => set({ debugState: state }),
  setDebugSession: (session) => set({ debugSession: session }),

  // Event actions
  addEvent: (rawEvent) => {
    // A4: Deduplicate events by ID to prevent duplicates from SSE reconnections
    if (get().seenEventIds.has(rawEvent.id)) {
      return false; // Skip duplicate event
    }

    // Normalize dotted types (from ClickHouse) to underscore types (used by all UI code)
    const event = {
      ...rawEvent,
      data: cloneAndNormalizeEventData(rawEvent.data),
      type: normalizeEventType(rawEvent.type) as typeof rawEvent.type,
    };

    // Track session start time
    const currentSessionStart = get().sessionStartTime;
    if (!currentSessionStart) {
      set({ sessionStartTime: event.timestamp });
    }

    set((state) => {
      const newEvents = boundedPush(state.events, event, MAX_OBSERVATORY_EVENTS);
      const newSeenIds = new Set(state.seenEventIds);
      newSeenIds.add(event.id);

      // If events were evicted (length didn't increase by 1), prune old IDs from Set
      if (
        newEvents.length === MAX_OBSERVATORY_EVENTS &&
        state.events.length === MAX_OBSERVATORY_EVENTS
      ) {
        // Event was evicted - find which events are still in the array
        const currentEventIds = new Set(newEvents.map((e) => e.id));
        // Keep only IDs that are still in the events array
        for (const id of newSeenIds) {
          if (!currentEventIds.has(id)) {
            newSeenIds.delete(id);
          }
        }
      }

      return {
        events: newEvents,
        seenEventIds: newSeenIds,
      };
    });

    // Handle session_ended — sweep all running spans
    if (event.type === 'session_ended') {
      const { spans: currentSpans } = get();
      for (const [sid, s] of currentSpans) {
        if (s.status === 'running') {
          get().endSpan(sid, 'completed', event.timestamp);
        }
      }
    }

    // Handle span_end — server-provided span duration
    if (event.type === 'span_end') {
      const targetSpanId = event.spanId;
      const status =
        (event.data.status as string) === 'error' ? ('error' as const) : ('completed' as const);
      if (targetSpanId && get().spans.has(targetSpanId)) {
        get().endSpan(targetSpanId, status, event.timestamp);
      }
    }

    // Track metrics based on event type
    if (event.type === 'llm_call') {
      const usage = event.data.usage as { inputTokens?: number; outputTokens?: number } | undefined;
      const tokensIn = usage?.inputTokens || (event.data.tokensIn as number) || 0;
      const tokensOut = usage?.outputTokens || (event.data.tokensOut as number) || 0;
      set((state) => ({
        totalLLMCalls: state.totalLLMCalls + 1,
        totalTokensIn: state.totalTokensIn + tokensIn,
        totalTokensOut: state.totalTokensOut + tokensOut,
      }));
    }

    if (event.type === 'tool_call') {
      set((state) => ({
        totalToolCalls: state.totalToolCalls + 1,
      }));
    }

    if (event.type === 'constraint_check') {
      const result: ConstraintCheckResult = {
        timestamp: event.timestamp,
        phaseName: (event.data.phase as string) || (event.data.constraint as string) || 'unknown',
        condition: (event.data.condition as string) || '',
        passed: (event.data.passed as boolean) ?? true,
        value: event.data.value,
        failureMessage: event.data.passed === false ? (event.data.message as string) : undefined,
      };
      set((state) => ({
        constraintHistory: boundedPush(state.constraintHistory, result, MAX_CONSTRAINT_HISTORY),
      }));
    }

    // Auto-process events to update spans and flow
    const { flowNodes, spans } = get();
    const agentName = event.agentName || 'unknown';

    // Auto-create flow node for any agent we see
    const existingNode = flowNodes.find((n) => n.agentName === agentName);
    if (!existingNode && agentName !== 'unknown') {
      get().addFlowNode({
        id: agentName,
        agentName: agentName,
        mode: (event.data.mode as 'scripted' | 'reasoning') || 'reasoning',
        status: 'active',
        enteredAt: event.timestamp,
        turnCount: 0,
      });
    }

    // Handle agent_enter - create new span and flow node
    if (event.type === 'agent_enter') {
      get().startSpan(
        event.spanId,
        event.agentName,
        event.traceId,
        event.sessionId,
        event.agentName,
        event.parentSpanId,
        event.timestamp,
        { kind: 'agent' },
      );
      get().addEventToSpan(event.spanId, event);
      get().updateFlowNode(agentName, { status: 'active', enteredAt: event.timestamp });
    }

    // Handle agent_exit - end span
    if (event.type === 'agent_exit') {
      const { spans: currentSpans } = get();
      const status = event.data.result === 'error' ? ('error' as const) : ('completed' as const);
      const activeAgentSpanId = getActiveAgentSpanIdForAgent(get(), event.agentName);
      let targetAgentSpanId: string | undefined;

      // Direct spanId match first (live sessions), LIFO fallback (replay/re-entrant)
      if (currentSpans.has(event.spanId) && currentSpans.get(event.spanId)!.status === 'running') {
        targetAgentSpanId = event.spanId;
      } else if (activeAgentSpanId) {
        targetAgentSpanId = activeAgentSpanId;
      }

      if (targetAgentSpanId) {
        get().addEventToSpan(targetAgentSpanId, event);
        get().endSpan(targetAgentSpanId, status, event.timestamp);
      }

      get().updateFlowNode(event.agentName, {
        status,
        exitedAt: event.timestamp,
      });
    }

    // Handle handoff - add flow edge and create target node
    if (event.type === 'handoff') {
      const fromAgent = (event.data.fromAgent || event.data.from) as string;
      const toAgent = (event.data.toAgent || event.data.to) as string;

      // Create target agent node if needed
      if (toAgent && !flowNodes.find((n) => n.agentName === toAgent)) {
        get().addFlowNode({
          id: toAgent,
          agentName: toAgent,
          mode: 'reasoning',
          status: 'idle',
          turnCount: 0,
        });
      }

      if (fromAgent && toAgent) {
        get().addFlowEdge({
          id: `edge-${Date.now()}`,
          from: fromAgent,
          to: toAgent,
          type: 'handoff',
          timestamp: event.timestamp,
          label: event.data.reason as string,
        });
      }

      // Update static graph execution state for generated supervisor graphs
      // Mark intent classifier as visited, handoff target as active
      get().updateNodeExecutionState('__intent_classifier__', 'visited');
      if (toAgent) {
        get().updateNodeExecutionState(`__handoff_${toAgent}__`, 'active');
      }
    }

    // Handle llm_call - mark reasoning/intent node as active
    if (event.type === 'llm_call') {
      // For supervisors, mark intent classifier as active
      get().updateNodeExecutionState('__intent_classifier__', 'active');
      // For reasoning agents, mark reasoning node as active
      get().updateNodeExecutionState('__reasoning__', 'active');
    }

    // Handle tool_call - mark tool node as active
    if (event.type === 'tool_call') {
      const toolName = (event.data.tool || event.data.toolName) as string;
      if (toolName) {
        // Mark reasoning node as visited (we moved to a tool)
        get().updateNodeExecutionState('__reasoning__', 'visited');
        // Mark tool node as active
        get().updateNodeExecutionState(`__tool_${toolName}__`, 'active');
      }
    }

    // Handle delegate - add flow edge
    if (event.type === 'delegate_start') {
      const targetAgent = event.data.targetAgent as string;
      if (targetAgent && !flowNodes.find((n) => n.agentName === targetAgent)) {
        get().addFlowNode({
          id: targetAgent,
          agentName: targetAgent,
          mode: 'reasoning',
          status: 'idle',
          turnCount: 0,
        });
      }
      get().addFlowEdge({
        id: `edge-${Date.now()}`,
        from: event.agentName,
        to: targetAgent,
        type: 'delegate',
        timestamp: event.timestamp,
      });
    }

    // Handle flow_step_enter - create span for the flow step
    if (event.type === 'flow_step_enter') {
      const stepName = event.data.stepName as string;
      const stepSpanId = event.spanId || `span-step-${agentName}-${stepName}-${event.id}`;
      const agentParentSpanId = getActiveAgentSpanIdForAgent(get(), agentName);
      get().startSpan(
        stepSpanId,
        `Step: ${stepName}`,
        event.traceId,
        event.sessionId,
        agentName,
        agentParentSpanId,
        event.timestamp,
        { kind: 'step', stepName },
      );
      get().addEventToSpan(stepSpanId, event);

      // Track step visit in metrics
      const currentMetrics = get().stepMetrics.get(stepName) || {
        visitCount: 0,
        totalTimeMs: 0,
        errors: 0,
      };
      set((state) => ({
        stepMetrics: boundedMapSet(
          state.stepMetrics,
          stepName,
          {
            ...currentMetrics,
            visitCount: currentMetrics.visitCount + 1,
            lastVisitTime: event.timestamp,
          },
          MAX_STEP_METRICS,
        ),
      }));

      // Create flow node for the step if visualizing steps
      const stepNodeId = `${agentName}:${stepName}`;
      if (!flowNodes.find((n) => n.id === stepNodeId)) {
        get().addFlowNode({
          id: stepNodeId,
          agentName: `${agentName}:${stepName}`,
          mode: 'scripted',
          status: 'active',
          enteredAt: event.timestamp,
          turnCount: 0,
        });
      } else {
        get().updateFlowNode(stepNodeId, { status: 'active', enteredAt: event.timestamp });
      }

      // Update static graph execution state - mark step as active
      get().updateNodeExecutionState(stepName, 'active');
      // Also update app-level execution state if in app view
      get().updateAppNodeExecutionState(agentName, stepName, 'active');
    }

    // Handle flow_step_exit - complete the step span
    if (event.type === 'flow_step_exit') {
      const stepName = event.data.stepName as string;
      const stepNodeId = `${agentName}:${stepName}`;
      const result = event.data.result as string;
      const durationMs = event.durationMs || 0;

      // Update step metrics with duration
      const currentMetrics = get().stepMetrics.get(stepName);
      if (currentMetrics) {
        const isError = result === 'error';
        set((state) => ({
          stepMetrics: boundedMapSet(
            state.stepMetrics,
            stepName,
            {
              ...currentMetrics,
              totalTimeMs: currentMetrics.totalTimeMs + durationMs,
              errors: currentMetrics.errors + (isError ? 1 : 0),
            },
            MAX_STEP_METRICS,
          ),
        }));
      }

      // End the active span for this step
      const activeStepSpanId = getActiveStepSpanIdForAgentStep(get(), agentName, stepName);
      if (activeStepSpanId) {
        get().addEventToSpan(activeStepSpanId, event);
        get().endSpan(
          activeStepSpanId,
          result === 'error' ? 'error' : 'completed',
          event.timestamp,
        );
      }

      // Update flow node status
      get().updateFlowNode(stepNodeId, {
        status: result === 'waiting' ? 'active' : 'completed',
        exitedAt: event.timestamp,
      });

      // Update static graph execution state - mark step as visited (unless waiting for input)
      if (result !== 'waiting') {
        get().updateNodeExecutionState(stepName, 'visited');
        // Also update app-level execution state if in app view
        get().updateAppNodeExecutionState(agentName, stepName, 'visited');
      }
    }

    // Handle flow_transition - add edge between steps
    if (event.type === 'flow_transition') {
      const fromStep = event.data.fromStep as string;
      const toStep = event.data.toStep as string;
      const fromNodeId = `${agentName}:${fromStep}`;
      const toNodeId = `${agentName}:${toStep}`;

      // Create target step node if needed
      if (!flowNodes.find((n) => n.id === toNodeId)) {
        get().addFlowNode({
          id: toNodeId,
          agentName: `${agentName}:${toStep}`,
          mode: 'scripted',
          status: 'idle',
          turnCount: 0,
        });
      }

      // Add edge for the transition
      get().addFlowEdge({
        id: `edge-${fromStep}-${toStep}-${Date.now()}`,
        from: fromNodeId,
        to: toNodeId,
        type: 'handoff',
        timestamp: event.timestamp,
        label: event.data.condition as string,
      });
    }

    let syntheticSpanHandled = false;
    if (isSyntheticSpanEventType(event.type) && event.spanId) {
      const syntheticSpanId = event.spanId;
      const existingSyntheticSpan = get().spans.get(syntheticSpanId);

      if (!existingSyntheticSpan) {
        get().startSpan(
          syntheticSpanId,
          resolveSyntheticSpanName(event),
          event.traceId,
          event.sessionId,
          agentName,
          event.parentSpanId,
          resolveSyntheticSpanStartTime(event),
          { synthetic: true, syntheticType: event.type },
        );
      }

      get().addEventToSpan(syntheticSpanId, event);

      if (
        isSyntheticSpanTerminalEventType(event.type) ||
        isSyntheticSpanOneShotEventType(event.type)
      ) {
        get().endSpan(syntheticSpanId, resolveSyntheticSpanStatus(event), event.timestamp);
      }

      syntheticSpanHandled = true;
    }

    // Add event to the agent's running span.
    // Skip events that already created their own span to avoid duplicates.
    const spanLifecycleEvents = new Set([
      'agent_enter',
      'agent_exit',
      'flow_step_enter',
      'flow_step_exit',
    ]);
    if (!spanLifecycleEvents.has(event.type) && !syntheticSpanHandled) {
      const { spans: latestSpans } = get();
      let attachedToSpan = false;

      // Prefer attaching to the most specific running span (step span > agent span)
      const activeSpanId = getMostRecentActiveSpanIdForAgent(get(), agentName);
      if (activeSpanId) {
        get().addEventToSpan(activeSpanId, event);
        attachedToSpan = true;
      }

      if (!attachedToSpan && agentName !== 'unknown') {
        const fallbackSpanId = `span-${agentName}-${event.sessionId}`;
        if (!latestSpans.has(fallbackSpanId)) {
          get().startSpan(
            fallbackSpanId,
            agentName,
            event.traceId,
            event.sessionId,
            agentName,
            undefined,
            event.timestamp,
            { kind: 'agent', synthetic: true },
          );
        }
        get().addEventToSpan(fallbackSpanId, event);
      }
    }

    return true;
  },

  clearEvents: () => {
    const { staticGraph } = get();
    // Reset execution state but keep static graph
    const executionState = new Map<string, NodeExecutionState>();
    if (staticGraph) {
      for (const node of staticGraph.nodes) {
        executionState.set(node.id, 'unvisited');
      }
    }
    set({
      events: [],
      seenEventIds: new Set(), // A4: Clear seen event IDs when clearing events
      spans: new Map(),
      activeSpanIds: [],
      activeAgentSpanIdsByAgent: new Map(),
      activeStepSpanIdsByAgentStep: new Map(),
      flowNodes: [],
      flowEdges: [],
      executionState,
      selection: {
        executionNodeId: null,
        spanId: null,
      },
    });
  },

  // Span actions
  startSpan: (spanId, name, traceId, sessionId, agentName, parentSpanId, timestamp, attributes) => {
    set((state) => {
      const span: Span = {
        spanId,
        traceId,
        parentSpanId,
        name,
        startTime: timestamp ?? new Date(),
        status: 'running' as const,
        agentName,
        sessionId,
        events: [],
        attributes: attributes ?? {},
      };
      const existingSpan = state.spans.get(spanId);
      let lifecycleState = existingSpan ? unregisterSpanLifecycle(state, existingSpan) : state;
      const newSpans = boundedMapSet(state.spans, spanId, span, MAX_SPANS);
      lifecycleState = registerSpanLifecycle(lifecycleState, span);
      const evictedSpan = [...state.spans.values()].find(
        (existingSpan) => !newSpans.has(existingSpan.spanId),
      );
      if (evictedSpan) {
        lifecycleState = unregisterSpanLifecycle(lifecycleState, evictedSpan);
      }
      return {
        spans: newSpans,
        ...lifecycleState,
      };
    });
  },

  endSpan: (spanId, status = 'completed', timestamp) => {
    set((state) => {
      const newSpans = new Map(state.spans);
      const span = newSpans.get(spanId);
      if (span) {
        const endTime = timestamp ?? new Date();
        newSpans.set(spanId, {
          ...span,
          endTime,
          durationMs: endTime.getTime() - span.startTime.getTime(),
          status,
        });
        return {
          spans: newSpans,
          ...unregisterSpanLifecycle(state, span),
        };
      }
      return { spans: newSpans };
    });
  },

  addEventToSpan: (spanId, event) => {
    set((state) => {
      const newSpans = new Map(state.spans);
      const span = newSpans.get(spanId);
      if (span) {
        newSpans.set(spanId, {
          ...span,
          events:
            span.events.length >= MAX_SPAN_EVENTS
              ? [...span.events.slice(1), event]
              : [...span.events, event],
        });
      }
      return { spans: newSpans };
    });
  },

  // Flow actions
  addFlowNode: (node) => {
    set((state) => ({
      flowNodes: boundedPush(state.flowNodes, node, MAX_FLOW_NODES),
    }));
  },

  updateFlowNode: (id, updates) => {
    set((state) => ({
      flowNodes: state.flowNodes.map((n) => (n.id === id ? { ...n, ...updates } : n)),
    }));
  },

  addFlowEdge: (edge) => {
    set((state) => ({
      flowEdges: boundedPush(state.flowEdges, edge, MAX_FLOW_EDGES),
    }));
  },

  clearFlow: () => {
    set({ flowNodes: [], flowEdges: [] });
  },

  // Static Graph (State Machine) actions
  setStaticGraph: (graph) => {
    set({ staticGraph: graph });
    // Initialize execution state for all nodes as unvisited
    if (graph) {
      const executionState = new Map<string, NodeExecutionState>();
      for (const node of graph.nodes) {
        executionState.set(node.id, 'unvisited');
      }
      set({ executionState });
    }
  },

  updateNodeExecutionState: (nodeId, state) => {
    set((current) => {
      const newExecutionState = new Map(current.executionState);
      newExecutionState.set(nodeId, state);
      return { executionState: newExecutionState };
    });
  },

  clearExecutionState: () => {
    set((current) => {
      const newExecutionState = new Map<string, NodeExecutionState>();
      if (current.staticGraph) {
        for (const node of current.staticGraph.nodes) {
          newExecutionState.set(node.id, 'unvisited');
        }
      }
      return { executionState: newExecutionState };
    });
  },

  // App Graph (Multi-Agent) actions
  setAppStaticGraph: (graph) => {
    set({ appStaticGraph: graph });
    // Initialize execution state for all agents and their nodes
    if (graph) {
      const appExecutionState = new Map<string, Map<string, NodeExecutionState>>();
      for (const [agentName, agentGraph] of Object.entries(graph.agentGraphs)) {
        const agentState = new Map<string, NodeExecutionState>();
        for (const node of agentGraph.nodes) {
          agentState.set(node.id, 'unvisited');
        }
        appExecutionState.set(agentName, agentState);
      }
      set({ appExecutionState });
    }
  },

  updateAppNodeExecutionState: (agentName, nodeId, state) => {
    set((current) => {
      const newAppExecutionState = new Map(current.appExecutionState);
      const agentState = new Map(newAppExecutionState.get(agentName) || new Map());
      agentState.set(nodeId, state);
      newAppExecutionState.set(agentName, agentState);
      return { appExecutionState: newAppExecutionState };
    });
  },

  clearAppExecutionState: () => {
    set((current) => {
      const newAppExecutionState = new Map<string, Map<string, NodeExecutionState>>();
      if (current.appStaticGraph) {
        for (const [agentName, agentGraph] of Object.entries(current.appStaticGraph.agentGraphs)) {
          const agentState = new Map<string, NodeExecutionState>();
          for (const node of agentGraph.nodes) {
            agentState.set(node.id, 'unvisited');
          }
          newAppExecutionState.set(agentName, agentState);
        }
      }
      return { appExecutionState: newAppExecutionState };
    });
  },

  setGraphViewMode: (mode) => {
    set({ graphViewMode: mode });
  },

  // Breakpoint actions
  addBreakpoint: (type, spec) => {
    const id = `bp-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`;
    set((state) => ({
      breakpoints: [...state.breakpoints, { id, type, spec, enabled: true, hitCount: 0 }],
    }));
  },

  removeBreakpoint: (id) => {
    set((state) => ({
      breakpoints: state.breakpoints.filter((bp) => bp.id !== id),
    }));
  },

  toggleBreakpoint: (id) => {
    set((state) => ({
      breakpoints: state.breakpoints.map((bp) =>
        bp.id === id ? { ...bp, enabled: !bp.enabled } : bp,
      ),
    }));
  },

  clearBreakpoints: () => {
    set({ breakpoints: [] });
  },

  // UI actions
  selectExecutionNode: (id) =>
    set((state) => ({
      selection: {
        ...state.selection,
        executionNodeId: id,
      },
    })),
  selectSpan: (id) =>
    set((state) => ({
      selection: {
        ...state.selection,
        spanId: id,
      },
    })),
  clearSelection: () =>
    set({
      selection: {
        executionNodeId: null,
        spanId: null,
      },
    }),
  setShowObservatory: (show) => set({ showObservatory: show }),
  setActiveTab: (tab) => set({ activeTab: tab }),

  // Canvas and Navigation actions
  setCanvasViewMode: (mode) => set({ canvasViewMode: mode }),
  setSelectedApp: (domain) => set({ selectedAppDomain: domain }),
  setSelectedAgent: (agentName) => set({ selectedAgentName: agentName }),
  toggleAppExpanded: (domain) =>
    set((state) => {
      const newExpanded = new Set(state.expandedApps);
      if (newExpanded.has(domain)) {
        newExpanded.delete(domain);
      } else {
        newExpanded.add(domain);
      }
      return { expandedApps: newExpanded };
    }),
  toggleSessionSidebar: () => set((state) => ({ sessionSidebarOpen: !state.sessionSidebarOpen })),
  setDebugPanelTab: (tab) => set({ debugPanelTab: tab }),
  setDebugPanelOpen: (open) => set({ debugPanelOpen: open }),
  setDebugPanelWidth: (width) => set({ debugPanelWidth: Math.max(320, Math.min(720, width)) }),
  setDebugPanelMode: (mode) => set({ debugPanelMode: mode }),
  setDebugPanelPosition: (pos) => set({ debugPanelPosition: pos }),
  setDebugPanelSize: (size) =>
    set({
      debugPanelSize: {
        width: Math.max(360, Math.min(1200, size.width)),
        height: Math.max(300, Math.min(900, size.height)),
      },
    }),
  toggleDebugPanel: () => set((state) => ({ debugPanelOpen: !state.debugPanelOpen })),
  addLog: (level, message) =>
    set((state) => ({
      logs: [...state.logs.slice(-99), { timestamp: new Date(), level, message }],
    })),
  clearLogs: () => set({ logs: [] }),

  // Computed
  getSpanTree: () => {
    const { spans } = get();
    const nodeMap = new Map<string, SpanTreeNode>();
    const roots: SpanTreeNode[] = [];

    // Create nodes — skip spans without a valid spanId (backward compat)
    for (const span of spans.values()) {
      if (!span.spanId) continue;
      nodeMap.set(span.spanId, { span, children: [], depth: 0 });
    }

    // Build hierarchy
    for (const span of spans.values()) {
      const node = nodeMap.get(span.spanId)!;
      if (span.parentSpanId) {
        const parent = nodeMap.get(span.parentSpanId);
        if (parent) {
          parent.children.push(node);
          node.depth = parent.depth + 1;
        } else {
          roots.push(node);
        }
      } else {
        roots.push(node);
      }
    }

    // Update depths recursively
    const updateDepths = (node: SpanTreeNode, depth: number) => {
      node.depth = depth;
      for (const child of node.children) {
        updateDepths(child, depth + 1);
      }
    };
    roots.forEach((r) => updateDepths(r, 0));

    // Sort children by startTime for chronological ordering
    for (const node of nodeMap.values()) {
      if (node.children.length > 1) {
        node.children.sort((a, b) => a.span.startTime.getTime() - b.span.startTime.getTime());
      }
    }

    return roots;
  },

  getSpan: (id) => get().spans.get(id),

  getActiveSpan: () => {
    const { activeSpanIds, spans } = get();
    for (let i = activeSpanIds.length - 1; i >= 0; i -= 1) {
      const span = spans.get(activeSpanIds[i]);
      if (span?.status === 'running') {
        return span;
      }
    }
    return undefined;
  },

  // Metrics actions
  recordStepVisit: (stepName, durationMs, isError) => {
    set((state) => {
      const current = state.stepMetrics.get(stepName) || {
        visitCount: 0,
        totalTimeMs: 0,
        errors: 0,
      };
      return {
        stepMetrics: boundedMapSet(
          state.stepMetrics,
          stepName,
          {
            visitCount: current.visitCount + 1,
            totalTimeMs: current.totalTimeMs + (durationMs || 0),
            errors: current.errors + (isError ? 1 : 0),
            lastVisitTime: new Date(),
          },
          MAX_STEP_METRICS,
        ),
      };
    });
  },

  recordConstraintCheck: (result) => {
    set((state) => ({
      constraintHistory: boundedPush(state.constraintHistory, result, MAX_CONSTRAINT_HISTORY),
    }));
  },

  resetMetrics: () => {
    set({
      stepMetrics: new Map(),
      constraintHistory: [],
      sessionStartTime: null,
      totalTokensIn: 0,
      totalTokensOut: 0,
      totalLLMCalls: 0,
      totalToolCalls: 0,
      pendingMessageStartTime: null,
      lastVolleyClientMs: 0,
      volleyClientTimes: [],
      avgVolleyClientMs: 0,
    });
  },

  // Client-side timing actions
  startClientTimer: () => {
    set({ pendingMessageStartTime: Date.now() });
  },

  endClientTimer: () => {
    const { pendingMessageStartTime, volleyClientTimes } = get();
    if (pendingMessageStartTime === null) return;

    const elapsed = Date.now() - pendingMessageStartTime;
    const newTimes = boundedPush(volleyClientTimes, elapsed, MAX_VOLLEY_CLIENT_TIMES);
    const avgMs = newTimes.reduce((a, b) => a + b, 0) / newTimes.length;

    set({
      pendingMessageStartTime: null,
      lastVolleyClientMs: elapsed,
      volleyClientTimes: newTimes,
      avgVolleyClientMs: avgMs,
    });
  },

  // For REST APIs - directly record a measured duration
  recordClientRoundTrip: (durationMs: number) => {
    const { volleyClientTimes } = get();
    const newTimes = boundedPush(volleyClientTimes, durationMs, MAX_VOLLEY_CLIENT_TIMES);
    const avgMs = newTimes.reduce((a, b) => a + b, 0) / newTimes.length;

    set({
      lastVolleyClientMs: durationMs,
      volleyClientTimes: newTimes,
      avgVolleyClientMs: avgMs,
    });
  },

  // Computed: Get timeline events from trace events
  getTimeline: () => {
    const { events } = get();
    const timeline: TimelineEvent[] = [];

    for (const event of events) {
      let timelineEvent: TimelineEvent | null = null;

      switch (event.type) {
        case 'flow_step_enter':
          timelineEvent = {
            id: event.id,
            timestamp: event.timestamp,
            type: 'step_enter',
            label: `Step: ${event.data.stepName}`,
            status: 'pending',
            details: { stepName: event.data.stepName },
          };
          break;

        case 'flow_step_exit':
          timelineEvent = {
            id: event.id,
            timestamp: event.timestamp,
            type: 'step_exit',
            label: `Step: ${event.data.stepName}`,
            durationMs: event.durationMs,
            status: event.data.result === 'error' ? 'error' : 'success',
            details: { stepName: event.data.stepName, result: event.data.result },
          };
          break;

        case 'llm_call':
          timelineEvent = {
            id: event.id,
            timestamp: event.timestamp,
            type: 'llm_call',
            label: `LLM: ${event.data.model || 'claude'}`,
            durationMs: event.durationMs || (event.data.latencyMs as number),
            status: 'success',
            details: {
              tokensIn: event.data.tokensIn,
              tokensOut: event.data.tokensOut,
              model: event.data.model,
            },
          };
          break;

        case 'tool_call':
          timelineEvent = {
            id: event.id,
            timestamp: event.timestamp,
            type: 'tool_call',
            label: `Tool: ${event.data.tool || event.data.toolName}`,
            durationMs: event.durationMs || (event.data.latencyMs as number),
            status: event.data.success === false ? 'error' : 'success',
            details: {
              tool: event.data.tool || event.data.toolName,
              result: event.data.result,
            },
          };
          break;

        case 'constraint_check': {
          const constraintName = (event.data.constraint ||
            event.data.constraintType ||
            event.data.name ||
            'constraint') as string;
          const conditionText = event.data.condition as string | undefined;
          const passed = event.data.passed as boolean | undefined;
          // Show a meaningful label: constraint name + pass/fail
          const checkLabel = conditionText
            ? `${passed ? '\u2713' : '\u2717'} ${String(conditionText).substring(0, 40)}`
            : `Check: ${constraintName}`;
          timelineEvent = {
            id: event.id,
            timestamp: event.timestamp,
            type: 'constraint_check',
            label: checkLabel,
            status: passed ? 'success' : 'error',
            details: {
              constraint: constraintName,
              condition: conditionText,
              passed,
              message: event.data.message,
            },
          };
          break;
        }

        case 'completion_check': {
          const source = (event.data.source as string) || 'unknown';
          const condition = (event.data.condition as string) || '';
          const result = event.data.result as boolean;
          timelineEvent = {
            id: event.id,
            timestamp: event.timestamp,
            type: 'completion_check',
            label: result
              ? `\u26a0 Complete: [${source}] "${String(condition).substring(0, 30)}"`
              : `Check: [${source}] not met`,
            status: result ? 'error' : 'success',
            details: {
              source,
              condition,
              result,
              currentStep: event.data.currentStep,
              nextStep: event.data.nextStep,
            },
          };
          break;
        }

        case 'engine_decision': {
          const decision = event.data.decision as string;
          const reason = (event.data.reason || event.data.toStep || '') as string;
          timelineEvent = {
            id: event.id,
            timestamp: event.timestamp,
            type: 'engine_decision',
            label:
              decision === 'auto_advance'
                ? `Advance: ${event.data.fromStep} \u2192 ${event.data.toStep}`
                : `Skip: ${reason}`,
            status: 'success',
            details: event.data,
          };
          break;
        }

        case 'handoff_condition_check': {
          const target = (event.data.target as string) || 'unknown';
          const matched = event.data.result as boolean;
          timelineEvent = {
            id: event.id,
            timestamp: event.timestamp,
            type: 'handoff_condition_check',
            label: `Handoff check: ${target} \u2192 ${matched ? 'matched' : 'no match'}`,
            status: matched ? 'success' : 'pending',
            details: event.data,
          };
          break;
        }

        case 'thread_return':
          timelineEvent = {
            id: event.id,
            timestamp: event.timestamp,
            type: 'thread_return',
            label: `Return: ${event.data.from || event.data.childAgent} \u2192 ${event.data.to || event.data.parentAgent}`,
            status: 'success',
            details: event.data,
          };
          break;

        case 'warning':
          timelineEvent = {
            id: event.id,
            timestamp: event.timestamp,
            type: 'warning',
            label: `Warning: ${String(event.data.message || event.data.warning || 'unknown').substring(0, 50)}`,
            status: 'error',
            details: event.data,
          };
          break;

        case 'user_message':
          timelineEvent = {
            id: event.id,
            timestamp: event.timestamp,
            type: 'user_message',
            label: `User: "${String(event.data.message || event.data.text || '').substring(0, 40)}"`,
            status: 'success',
            details: event.data,
          };
          break;

        case 'handoff':
          timelineEvent = {
            id: event.id,
            timestamp: event.timestamp,
            type: 'handoff',
            label: `Handoff → ${event.data.to || event.data.toAgent}`,
            status: 'success',
            details: {
              from: event.data.from || event.data.fromAgent,
              to: event.data.to || event.data.toAgent,
            },
          };
          break;

        case 'error':
          timelineEvent = {
            id: event.id,
            timestamp: event.timestamp,
            type: 'error',
            label: `Error: ${event.data.message || 'Unknown'}`,
            status: 'error',
            details: event.data,
          };
          break;
      }

      if (timelineEvent) {
        timeline.push(timelineEvent);
      }
    }

    return timeline.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
  },

  // Computed: Get heatmap data for steps
  getStepHeatmapData: () => {
    const { stepMetrics } = get();
    const heatmapData = new Map<
      string,
      { visitCount: number; avgTimeMs: number; errorRate: number }
    >();

    for (const [stepName, metrics] of stepMetrics) {
      heatmapData.set(stepName, {
        visitCount: metrics.visitCount,
        avgTimeMs: metrics.visitCount > 0 ? metrics.totalTimeMs / metrics.visitCount : 0,
        errorRate: metrics.visitCount > 0 ? metrics.errors / metrics.visitCount : 0,
      });
    }

    return heatmapData;
  },
}));
