/**
 * Observatory Components Tests
 *
 * Comprehensive tests for the observatory/debug UI components:
 * - DebugTabs: Tab navigation and content switching
 * - SpanTree: Span hierarchy with expand/collapse and selection
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import React from 'react';

// =============================================================================
// MOCKS
// =============================================================================

// Track what setDebugPanelTab is called with
const mockSetDebugPanelTab = vi.fn();
const mockClearLogs = vi.fn();
const mockSelectSpan = vi.fn();
const mockSelectExecutionNode = vi.fn();

// Default observatory store state
const defaultObservatoryState = {
  debugPanelTab: 'traces' as string,
  setDebugPanelTab: mockSetDebugPanelTab,
  logs: [] as Array<{ timestamp: Date; level: 'info' | 'warn' | 'error'; message: string }>,
  clearLogs: mockClearLogs,
  events: [] as Array<{
    id: string;
    type: string;
    timestamp: Date;
    data?: Record<string, unknown>;
    durationMs?: number;
  }>,
  sessionStartTime: null as Date | null,
  totalLLMCalls: 0,
  totalToolCalls: 0,
  totalTokensIn: 0,
  totalTokensOut: 0,
  getTimeline: () =>
    [] as Array<{
      id: string;
      timestamp: Date;
      type: string;
      label: string;
      durationMs?: number;
      details?: Record<string, unknown>;
      status?: string;
    }>,
  lastVolleyClientMs: 0,
  avgVolleyClientMs: 0,
  volleyClientTimes: [] as number[],
  constraintHistory: [] as Array<{
    timestamp: Date;
    phaseName: string;
    condition: string;
    passed: boolean;
    value?: unknown;
    failureMessage?: string;
  }>,
  getSpanTree: () =>
    [] as Array<{
      span: {
        spanId: string;
        traceId: string;
        parentSpanId?: string;
        name: string;
        startTime: Date;
        endTime?: Date;
        durationMs?: number;
        status: 'running' | 'completed' | 'error';
        agentName: string;
        sessionId: string;
        events: Array<{ id: string; type: string; timestamp: Date }>;
        attributes: Record<string, unknown>;
      };
      children: unknown[];
      depth: number;
    }>,
  spans: new Map() as Map<string, unknown>,
  selection: {
    executionNodeId: null as string | null,
    spanId: null as string | null,
  },
  selectSpan: mockSelectSpan,
  selectExecutionNode: mockSelectExecutionNode,
  debugPanelMode: 'docked' as string,
  setDebugPanelMode: vi.fn(),
};

let observatoryStoreState = { ...defaultObservatoryState };

vi.mock('../../store/observatory-store', () => ({
  useObservatoryStore: vi.fn((sel?: (s: typeof defaultObservatoryState) => unknown) =>
    sel ? sel(observatoryStoreState) : observatoryStoreState,
  ),
}));

// Default UI store state
const defaultUIState = {
  sessionDetailMode: false,
  setSessionDetailMode: vi.fn(),
};

let uiStoreState = { ...defaultUIState };

vi.mock('../../store/ui-store', () => ({
  useUIStore: vi.fn((sel?: (s: typeof defaultUIState) => unknown) =>
    sel ? sel(uiStoreState) : uiStoreState,
  ),
}));

// Default session store state
const defaultSessionState = {
  sessionId: null as string | null,
  agent: null as { dsl?: string; ir?: unknown } | null,
  messages: [] as Array<{
    id: string;
    role: 'user' | 'assistant' | 'system';
    content: string;
    timestamp: Date;
  }>,
  state: null as {
    context: Record<string, unknown>;
    conversationPhase: string;
    gatherProgress: Record<string, unknown>;
    constraintResults: Record<string, boolean>;
    lastToolResults: Record<string, unknown>;
    memory: {
      session: Record<string, unknown>;
      persistentCache: Record<string, unknown>;
      pendingRemembers: unknown[];
    };
    flowState?: {
      currentStep: string;
      stepHistory: string[];
      stepResults: Record<string, unknown>;
      isComplete: boolean;
    };
    activeAgent?: {
      name: string;
      mode: string;
      ir?: unknown;
    };
  } | null,
};

let sessionStoreState = { ...defaultSessionState };

vi.mock('../../store/session-store', () => ({
  useSessionStore: vi.fn((sel?: (s: typeof defaultSessionState) => unknown) =>
    sel ? sel(sessionStoreState) : sessionStoreState,
  ),
}));

// Mock next-intl translations — namespace-aware like the real useTranslations
vi.mock('next-intl', () => ({
  useTranslations: (namespace: string) => {
    const allTranslations: Record<string, Record<string, string>> = {
      'observatory.debug_tabs': {
        tab_traces: 'Traces',
        tab_data: 'Data',
        tab_conversation: 'Conversation',
        tab_performance: 'Performance',
        tab_ir: 'IR',
        pop_out: 'Pop out',
        no_session_active: 'No session active',
        phase: 'Phase',
        collected_data: 'Collected Data',
        context: 'Context',
        flow_state: 'Flow State',
        current_step: 'Current Step',
        complete: 'Complete',
        step_history: 'Step History',
        constraints: 'Constraints',
        session_memory: 'Session Memory',
        no_conversation_history: 'No conversation history',
        no_agent_loaded: 'No agent loaded',
        section_llm_calls: 'LLM Calls',
        section_logs: 'Logs',
        clear_logs: 'Clear logs',
        export_trace: 'Export entire trace',
        no_logs: 'No logs',
        traces_not_stored: 'Trace events were not stored for this session.',
        traces_not_stored_detail: 'Metrics shown above are from session aggregates.',
        abl_source: 'ABL Source',
        ir_json: 'IR JSON',
        section_test_context: 'Test Context',
        no_abl_source: 'No ABL source',
        no_ir_available: 'No IR available',
      },
      'observatory.session_timeline': {
        no_activity: 'No session activity',
        session_time: 'Session Time',
        volley_count: '{count} volley',
        avg_volley: 'Avg Volley',
        last: 'Last: {value}',
        client_roundtrip: 'Client Round-trip',
        last_volley: 'Last Volley',
        average: 'Average',
        volleys_measured: '{count} volleys measured from browser',
        api_roundtrips: 'API Round-trips',
        llm_roundtrip: 'LLM Round-trip',
        call_count: '{count} calls',
        tool_roundtrip: 'Tool Round-trip',
        includes_network: 'includes network',
        tokens: 'Tokens',
        event_timeline: 'Event Timeline',
        no_events: 'No events yet',
      },
      'observatory.span_tree': {
        empty_title: 'No spans recorded',
        empty_hint: 'Start a conversation to see the span hierarchy',
        events_count: '{count} events',
        agent: 'Agent:',
        status: 'Status:',
        started: 'Started:',
        ended: 'Ended:',
        events_in_span: 'Events in this span:',
        span_id: 'Span ID:',
        parent: 'Parent:',
        trace_id: 'Trace ID:',
      },
      'observatory.constraints': {
        constraint_status: 'Constraint Status',
        no_constraints: 'No constraints defined',
        recent_violations: 'Recent Violations',
      },
      'observatory.gather': {
        no_data_title: 'No data collected',
        no_data_hint: 'Data will appear here',
        expected_fields: 'Expected Fields',
        agent_fields: '{agentName} Fields',
        received_data: 'Received Data',
        from_handoffs: 'from handoffs',
        handoff_label: 'handoff',
        waiting_for_input: 'Waiting for input...',
      },
      'observatory.llm_tab': {
        empty_title: 'No LLM calls yet',
        empty_hint: 'LLM calls will appear here',
      },
      observability: {
        live: 'Live',
        historical: 'Historical',
      },
      'observatory.llm_card': {},
      test_context: {},
      'test_context.panel': {},
    };
    const ns = allTranslations[namespace] || {};
    return (key: string, params?: Record<string, unknown>) => {
      let value = ns[key] || key;
      if (params) {
        for (const [k, v] of Object.entries(params)) {
          value = value.replace(`{${k}}`, String(v));
        }
      }
      return value;
    };
  },
}));

// Mock navigation store (needed by TracesTab for session aggregate detection)
vi.mock('../../store/navigation-store', () => ({
  useNavigationStore: vi.fn((sel?: (s: Record<string, unknown>) => unknown) => {
    const state = { subPage: null, projectId: null };
    return sel ? sel(state) : state;
  }),
}));

// Mock useSessionDetail hook (needed by TracesTab for DB-only session metrics)
vi.mock('../../hooks/useSessionDetail', () => ({
  useSessionDetail: () => ({
    session: null,
    loading: false,
    error: null,
    refresh: vi.fn(),
    tree: [],
    metrics: { totalTokens: 0, totalCost: 0, latencyMs: 0, llmCalls: 0 },
  }),
}));

// Mock deep DebugTabs child panels that are outside the unit scope of this suite.
// These imports pull in large runtime/testing graphs that are not needed to verify
// tab switching, traces mode badges, or span tree behavior here.
vi.mock('../../components/session/OverviewTab', () => ({
  OverviewTab: () => <div>Overview stub</div>,
}));

vi.mock('../../components/session/VoiceMetricsTab', () => ({
  VoiceMetricsTab: () => <div>Voice metrics stub</div>,
}));

vi.mock('../../components/observatory/WaterfallPanel', () => ({
  WaterfallPanel: ({
    children,
    mode,
  }: {
    children?: React.ReactNode;
    mode?: 'live' | 'historical';
  }) => (
    <div>
      <span>{mode === 'historical' ? 'Historical' : 'Live'}</span>
      {children}
    </div>
  ),
}));

vi.mock('../../components/observatory/NodeDetailPanel', () => ({
  NodeDetailPanel: () => <div>Node detail stub</div>,
}));

vi.mock('../../components/observatory/ErrorsTab', () => ({
  ErrorsTab: () => <div>Errors stub</div>,
  useErrorCount: () => 0,
}));

vi.mock('../../components/test-context/TestContextPanel', () => ({
  TestContextPanel: () => <div>Test context stub</div>,
}));

// =============================================================================
// IMPORTS (after mocks — vi.mock() calls above are hoisted)
// =============================================================================

import { DebugTabs } from '../../components/observatory/DebugTabs';
import { SpanTree } from '../../components/observatory/SpanTree';

beforeEach(() => {
  vi.clearAllMocks();
  observatoryStoreState = { ...defaultObservatoryState };
  sessionStoreState = { ...defaultSessionState };
  uiStoreState = { ...defaultUIState };
});

// =============================================================================
// DebugTabs
// =============================================================================

describe('DebugTabs', () => {
  test('renders all 5 tab buttons with correct labels', () => {
    render(<DebugTabs />);

    expect(screen.getByText('Traces')).toBeInTheDocument();
    expect(screen.getByText('Data')).toBeInTheDocument();
    expect(screen.getByText('Conversation')).toBeInTheDocument();
    expect(screen.getByText('Performance')).toBeInTheDocument();
    expect(screen.getByText('IR')).toBeInTheDocument();
  });

  test('default tab is traces', () => {
    // The default debugPanelTab in observatory store is 'traces'
    render(<DebugTabs />);

    // Traces tab should render the waterfall panel (live mode indicator)
    expect(screen.getByText('Live')).toBeInTheDocument();
  });

  test('historical traces mode renders historical badge', () => {
    render(<DebugTabs tracesMode="historical" />);

    expect(screen.getByText('Historical')).toBeInTheDocument();
    expect(screen.queryByText('Live')).not.toBeInTheDocument();
  });

  test('clicking a tab calls setDebugPanelTab with correct tab id', () => {
    render(<DebugTabs />);

    fireEvent.click(screen.getByText('Data'));
    expect(mockSetDebugPanelTab).toHaveBeenCalledWith('data');

    fireEvent.click(screen.getByText('Conversation'));
    expect(mockSetDebugPanelTab).toHaveBeenCalledWith('conversation');

    fireEvent.click(screen.getByText('IR'));
    expect(mockSetDebugPanelTab).toHaveBeenCalledWith('ir');

    fireEvent.click(screen.getByText('Performance'));
    expect(mockSetDebugPanelTab).toHaveBeenCalledWith('performance');

    fireEvent.click(screen.getByText('Traces'));
    expect(mockSetDebugPanelTab).toHaveBeenCalledWith('traces');
  });

  test('exports the full debug trace as JSON', async () => {
    vi.useFakeTimers();
    const createObjectURL = vi.fn(() => 'blob:debug-trace');
    const revokeObjectURL = vi.fn();
    vi.stubGlobal('URL', {
      ...URL,
      createObjectURL,
      revokeObjectURL,
    });
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    const unreadableValue: Record<string, unknown> = {};
    Object.defineProperty(unreadableValue, 'secret', {
      enumerable: true,
      get() {
        throw new Error('blocked getter');
      },
    });
    const circularData: Record<string, unknown> = {
      model: 'gpt-4.1',
      tokenTotal: 12n,
      metadataMap: new Map([[{ source: 'runtime' }, 'preserved']]),
      omittedValue: undefined,
      formatter: function traceFormatter() {
        return 'formatted';
      },
      symbolValue: Symbol('trace-symbol'),
      matcher: /token:\d+/gi,
      bytes: new Uint8Array([1, 2, 3]),
      unreadableValue,
    };
    circularData.self = circularData;
    const selfCausedError = new Error('recursive cause');
    selfCausedError.cause = selfCausedError;
    circularData.selfCausedError = selfCausedError;

    observatoryStoreState = {
      ...defaultObservatoryState,
      events: [
        {
          id: 'event-1',
          type: 'llm_call',
          timestamp: new Date('2026-05-17T12:00:00.000Z'),
          traceId: 'trace-1',
          spanId: 'span-1',
          sessionId: 'session-1',
          agentName: 'Planner',
          data: circularData,
        },
      ],
    };
    sessionStoreState = {
      ...defaultSessionState,
      sessionId: 'session-1',
      messages: [
        {
          id: 'msg-1',
          role: 'user',
          content: 'Hello',
          timestamp: new Date('2026-05-17T12:00:01.000Z'),
          traceIds: ['trace-1'],
        },
      ],
    };

    try {
      render(
        <DebugTabs
          projectId="project-1"
          agentName="Planner"
          traceEvents={[
            {
              id: 'event-historical',
              type: 'agent_enter',
              timestamp: '2026-05-17T11:59:59.000Z',
              sessionId: 'session-1',
              traceId: 'trace-1',
              data: { agentName: 'Planner' },
            },
            {
              id: 'event-1',
              type: 'llm_call',
              timestamp: '2026-05-17T12:00:00.000Z',
              sessionId: 'session-1',
              traceId: 'trace-1',
              data: { historicalOnly: true },
            },
          ]}
        />,
      );

      fireEvent.click(screen.getByLabelText('Export entire trace'));

      expect(clickSpy).toHaveBeenCalled();
      expect(revokeObjectURL).not.toHaveBeenCalled();
      vi.runAllTimers();
      expect(revokeObjectURL).toHaveBeenCalledWith('blob:debug-trace');
      const exportedBlob = createObjectURL.mock.calls[0]?.[0] as Blob;
      const payload = JSON.parse(await exportedBlob.text()) as {
        session: { sessionId: string | null; projectId: string | null; agentName: string | null };
        trace: {
          events: Array<{ id: string; data: Record<string, unknown> }>;
          liveEvents: Array<{ id: string; data: Record<string, unknown> }>;
          historicalEvents: Array<{ id: string; data: Record<string, unknown> }>;
        };
        conversation: { messages: Array<{ id: string; content: string }> };
      };

      expect(payload.session).toMatchObject({
        sessionId: 'session-1',
        projectId: 'project-1',
        agentName: 'Planner',
      });
      expect(payload.trace.events).toHaveLength(2);
      expect(payload.trace.liveEvents).toHaveLength(1);
      expect(payload.trace.historicalEvents).toHaveLength(2);
      expect(payload.trace.events.find((event) => event.id === 'event-1')).toMatchObject({
        id: 'event-1',
        data: {
          historicalOnly: true,
          model: 'gpt-4.1',
        },
      });
      expect(payload.trace.liveEvents[0]).toMatchObject({
        id: 'event-1',
        data: {
          model: 'gpt-4.1',
          tokenTotal: '12',
          metadataMap: [{ key: { source: 'runtime' }, value: 'preserved' }],
          omittedValue: '[Undefined]',
          formatter: '[Function: traceFormatter]',
          symbolValue: '[Symbol: trace-symbol]',
          matcher: { type: 'RegExp', source: 'token:\\d+', flags: 'gi' },
          bytes: { type: 'Uint8Array', values: [1, 2, 3] },
          unreadableValue: { secret: '[Unreadable: blocked getter]' },
          selfCausedError: expect.objectContaining({
            name: 'Error',
            message: 'recursive cause',
            cause: '[Circular]',
          }),
          self: '[Circular]',
        },
      });
      expect(payload.conversation.messages[0]).toMatchObject({ id: 'msg-1', content: 'Hello' });
    } finally {
      clickSpy.mockRestore();
      vi.unstubAllGlobals();
      vi.useRealTimers();
    }
  });

  test('switching to data tab shows context content', () => {
    observatoryStoreState = {
      ...defaultObservatoryState,
      debugPanelTab: 'data',
    };

    render(<DebugTabs />);

    // Without an active session, shows empty state from the context section
    expect(screen.getByText('No session active')).toBeInTheDocument();
  });

  test('data tab shows session state when available', () => {
    observatoryStoreState = {
      ...defaultObservatoryState,
      debugPanelTab: 'data',
    };
    sessionStoreState = {
      ...defaultSessionState,
      state: {
        context: { city: 'Paris' },
        conversationPhase: 'gathering',
        gatherProgress: { destination: 'London' },
        constraintResults: {},
        lastToolResults: {},
        memory: { session: {}, persistentCache: {}, pendingRemembers: [] },
      },
    };

    render(<DebugTabs />);

    // Shows the phase
    expect(screen.getByText('gathering')).toBeInTheDocument();
    // Shows collected data section
    expect(screen.getByText('Collected Data')).toBeInTheDocument();
    // Shows context section within the data tab
    expect(screen.getByText('Context')).toBeInTheDocument();
  });

  test('conversation tab shows empty state when no messages', () => {
    observatoryStoreState = {
      ...defaultObservatoryState,
      debugPanelTab: 'conversation',
    };

    render(<DebugTabs />);

    expect(screen.getByText('No conversation history')).toBeInTheDocument();
  });

  test('conversation tab shows messages when present', () => {
    observatoryStoreState = {
      ...defaultObservatoryState,
      debugPanelTab: 'conversation',
    };
    sessionStoreState = {
      ...defaultSessionState,
      messages: [
        {
          id: 'msg-1',
          role: 'user' as const,
          content: 'Hello there',
          timestamp: new Date('2025-01-01T10:00:00Z'),
        },
        {
          id: 'msg-2',
          role: 'assistant' as const,
          content: 'Hi! How can I help?',
          timestamp: new Date('2025-01-01T10:00:01Z'),
        },
      ],
    };

    render(<DebugTabs />);

    expect(screen.getByText('Hello there')).toBeInTheDocument();
    expect(screen.getByText('Hi! How can I help?')).toBeInTheDocument();
    expect(screen.getByText('user')).toBeInTheDocument();
    expect(screen.getByText('assistant')).toBeInTheDocument();
  });

  test('IR tab shows empty state when no agent loaded', () => {
    observatoryStoreState = {
      ...defaultObservatoryState,
      debugPanelTab: 'ir',
    };

    render(<DebugTabs />);

    expect(screen.getByText(/No agent loaded/)).toBeInTheDocument();
  });

  test('performance tab shows LLM calls by default', () => {
    observatoryStoreState = {
      ...defaultObservatoryState,
      debugPanelTab: 'performance',
    };

    render(<DebugTabs />);

    // Performance tab has LLM & Tools and Logs sub-sections
    expect(screen.getByText('LLM & Tools')).toBeInTheDocument();
    expect(screen.getByText('Logs')).toBeInTheDocument();
  });

  test('performance tab counts normalized realtime and platform tool events', () => {
    const now = new Date('2025-01-15T12:00:00Z');
    observatoryStoreState = {
      ...defaultObservatoryState,
      debugPanelTab: 'performance',
      events: [
        {
          id: 'evt-realtime-tool',
          type: 'voice.realtime.tool_call',
          timestamp: now,
          data: { toolName: 'lookup_member', durationMs: 75 },
        },
        {
          id: 'evt-platform-tool',
          type: 'tool.call.completed',
          timestamp: new Date(now.getTime() + 10),
          data: { toolName: 'search_docs', durationMs: 40 },
        },
        {
          id: 'evt-hook',
          type: 'agent.hook.executed',
          timestamp: new Date(now.getTime() + 20),
          data: { name: 'before_response', durationMs: 12 },
        },
      ],
    };

    render(<DebugTabs />);

    expect(screen.getByText('3')).toBeInTheDocument();
    expect(screen.getByText('lookup_member')).toBeInTheDocument();
    expect(screen.getByText('search_docs')).toBeInTheDocument();
    expect(screen.getByText('before_response')).toBeInTheDocument();
  });

  test('performance tab shows log badge count', () => {
    observatoryStoreState = {
      ...defaultObservatoryState,
      debugPanelTab: 'performance',
      logs: [
        { timestamp: new Date(), level: 'info', message: 'test log 1' },
        { timestamp: new Date(), level: 'warn', message: 'test log 2' },
        { timestamp: new Date(), level: 'error', message: 'test log 3' },
      ],
    };

    render(<DebugTabs />);

    // The badge shows the count "3" next to the Logs sub-section toggle
    expect(screen.getByText('3')).toBeInTheDocument();
  });

  test('performance tab logs section renders log entries with level indicators', () => {
    const now = new Date('2025-01-15T12:00:00Z');
    observatoryStoreState = {
      ...defaultObservatoryState,
      debugPanelTab: 'performance',
      logs: [
        { timestamp: now, level: 'info', message: 'Connected to server' },
        { timestamp: now, level: 'error', message: 'Connection lost' },
      ],
    };

    render(<DebugTabs />);

    // Click Logs sub-section to switch from LLM Calls
    fireEvent.click(screen.getByText('Logs'));

    expect(screen.getByText('Connected to server')).toBeInTheDocument();
    expect(screen.getByText('Connection lost')).toBeInTheDocument();
    expect(screen.getByText('[INFO]')).toBeInTheDocument();
    expect(screen.getByText('[ERROR]')).toBeInTheDocument();
  });

  test('performance tab logs clear button calls clearLogs', () => {
    observatoryStoreState = {
      ...defaultObservatoryState,
      debugPanelTab: 'performance',
      logs: [{ timestamp: new Date(), level: 'info', message: 'Some log' }],
    };

    render(<DebugTabs />);

    // Switch to Logs sub-section
    fireEvent.click(screen.getByText('Logs'));

    const clearButton = screen.getByTitle('Clear logs');
    fireEvent.click(clearButton);

    expect(mockClearLogs).toHaveBeenCalled();
  });

  test('performance tab logs filter buttons filter by level', () => {
    const now = new Date('2025-01-15T12:00:00Z');
    observatoryStoreState = {
      ...defaultObservatoryState,
      debugPanelTab: 'performance',
      logs: [
        { timestamp: now, level: 'info', message: 'Info message' },
        { timestamp: now, level: 'warn', message: 'Warning message' },
        { timestamp: now, level: 'error', message: 'Error message' },
      ],
    };

    render(<DebugTabs />);

    // Switch to Logs sub-section
    fireEvent.click(screen.getByText('Logs'));

    // Initially shows all
    expect(screen.getByText('Info message')).toBeInTheDocument();
    expect(screen.getByText('Warning message')).toBeInTheDocument();
    expect(screen.getByText('Error message')).toBeInTheDocument();

    // Filter to only errors
    fireEvent.click(screen.getByText('error'));
    expect(screen.queryByText('Info message')).not.toBeInTheDocument();
    expect(screen.queryByText('Warning message')).not.toBeInTheDocument();
    expect(screen.getByText('Error message')).toBeInTheDocument();

    // Filter to only info
    fireEvent.click(screen.getByText('info'));
    expect(screen.getByText('Info message')).toBeInTheDocument();
    expect(screen.queryByText('Warning message')).not.toBeInTheDocument();
    expect(screen.queryByText('Error message')).not.toBeInTheDocument();

    // Back to all
    fireEvent.click(screen.getByText('all'));
    expect(screen.getByText('Info message')).toBeInTheDocument();
    expect(screen.getByText('Warning message')).toBeInTheDocument();
    expect(screen.getByText('Error message')).toBeInTheDocument();
  });
});

// =============================================================================
// SpanTree
// =============================================================================

describe('SpanTree', () => {
  test('empty state shows "No spans recorded" message', () => {
    render(<SpanTree />);

    expect(screen.getByText(/No spans recorded/)).toBeInTheDocument();
    expect(screen.getByText(/Start a conversation to see the span hierarchy/)).toBeInTheDocument();
  });

  test('renders span tree with hierarchy', () => {
    const rootSpan = {
      spanId: 'span-root',
      traceId: 'trace-1',
      name: 'booking-agent',
      startTime: new Date('2025-01-01T10:00:00Z'),
      endTime: new Date('2025-01-01T10:00:05Z'),
      durationMs: 5000,
      status: 'completed' as const,
      agentName: 'booking-agent',
      sessionId: 'session-1',
      events: [{ id: 'e1', type: 'agent_enter', timestamp: new Date('2025-01-01T10:00:00Z') }],
      attributes: {},
    };

    const childSpan = {
      spanId: 'span-child',
      traceId: 'trace-1',
      parentSpanId: 'span-root',
      name: 'Step: greeting',
      startTime: new Date('2025-01-01T10:00:01Z'),
      endTime: new Date('2025-01-01T10:00:03Z'),
      durationMs: 2000,
      status: 'completed' as const,
      agentName: 'booking-agent',
      sessionId: 'session-1',
      events: [],
      attributes: {},
    };

    observatoryStoreState = {
      ...defaultObservatoryState,
      getSpanTree: () => [
        {
          span: rootSpan,
          children: [
            {
              span: childSpan,
              children: [],
              depth: 1,
            },
          ],
          depth: 0,
        },
      ],
    };

    render(<SpanTree />);

    // Both spans should render
    expect(screen.getByText('booking-agent')).toBeInTheDocument();
    expect(screen.getByText('Step: greeting')).toBeInTheDocument();

    // Duration should be shown
    expect(screen.getByText('5.0s')).toBeInTheDocument();
    expect(screen.getByText('2.0s')).toBeInTheDocument();

    // Event counts
    expect(screen.getByText('1 events')).toBeInTheDocument();
    expect(screen.getByText('0 events')).toBeInTheDocument();
  });

  test('clicking a span calls selectSpan', () => {
    const span = {
      spanId: 'span-1234567890abcdef1234567890abcdef',
      traceId: 'trace-abcdef1234567890abcdef1234567890',
      name: 'test-agent',
      startTime: new Date('2025-01-01T10:00:00Z'),
      durationMs: 1000,
      status: 'completed' as const,
      agentName: 'test-agent',
      sessionId: 'session-1',
      events: [],
      attributes: {},
    };

    observatoryStoreState = {
      ...defaultObservatoryState,
      getSpanTree: () => [
        {
          span,
          children: [],
          depth: 0,
        },
      ],
    };
    observatoryStoreState = {
      ...observatoryStoreState,
      selection: { ...observatoryStoreState.selection, spanId: null },
    };

    render(<SpanTree />);

    // Click the span row
    fireEvent.click(screen.getByText('test-agent'));

    expect(mockSelectSpan).toHaveBeenCalledWith('span-1234567890abcdef1234567890abcdef');
  });

  test('clicking selected span deselects it (toggles to null)', () => {
    const spanId = 'span-selected-abc12345678901234567';

    const span = {
      spanId,
      traceId: 'trace-abcdef1234567890abcdef1234567890',
      name: 'selected-agent',
      startTime: new Date('2025-01-01T10:00:00Z'),
      durationMs: 500,
      status: 'running' as const,
      agentName: 'selected-agent',
      sessionId: 'session-1',
      events: [],
      attributes: {},
    };

    observatoryStoreState = {
      ...defaultObservatoryState,
      getSpanTree: () => [
        {
          span,
          children: [],
          depth: 0,
        },
      ],
    };
    observatoryStoreState = {
      ...observatoryStoreState,
      selection: { ...observatoryStoreState.selection, spanId },
    };

    render(<SpanTree />);

    // Click the already-selected span should deselect
    fireEvent.click(screen.getByText('selected-agent'));

    expect(mockSelectSpan).toHaveBeenCalledWith(null);
  });

  test('selected span does not render duplicate inline details inside the tree', () => {
    const spanId = 'span-details-abcdef1234567890abcdef12';

    const span = {
      spanId,
      traceId: 'trace-details-abcdef1234567890abcdef',
      name: 'detail-agent',
      startTime: new Date('2025-01-01T10:00:00Z'),
      endTime: new Date('2025-01-01T10:00:02Z'),
      durationMs: 2000,
      status: 'completed' as const,
      agentName: 'detail-agent',
      sessionId: 'session-detail',
      events: [
        {
          id: 'evt-1',
          type: 'llm_call',
          timestamp: new Date('2025-01-01T10:00:01Z'),
        },
      ],
      attributes: {},
    };

    observatoryStoreState = {
      ...defaultObservatoryState,
      getSpanTree: () => [
        {
          span,
          children: [],
          depth: 0,
        },
      ],
    };
    observatoryStoreState = {
      ...observatoryStoreState,
      selection: { ...observatoryStoreState.selection, spanId },
    };

    render(<SpanTree />);

    expect(screen.getByText('detail-agent')).toBeInTheDocument();
    expect(screen.queryByText('Agent:')).not.toBeInTheDocument();
    expect(screen.queryByText('Status:')).not.toBeInTheDocument();
    expect(screen.queryByText('Started:')).not.toBeInTheDocument();
    expect(screen.queryByText('Ended:')).not.toBeInTheDocument();
    expect(screen.queryByText('Events in this span:')).not.toBeInTheDocument();
    expect(screen.queryByText(/Span ID:/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Trace ID:/)).not.toBeInTheDocument();
  });

  test('expand/collapse toggle works for parent spans', () => {
    const rootSpan = {
      spanId: 'span-parent-abc',
      traceId: 'trace-1',
      name: 'parent-agent',
      startTime: new Date(),
      durationMs: 5000,
      status: 'completed' as const,
      agentName: 'parent-agent',
      sessionId: 'session-1',
      events: [],
      attributes: {},
    };

    const childSpan = {
      spanId: 'span-child-abc',
      traceId: 'trace-1',
      parentSpanId: 'span-parent-abc',
      name: 'child-step',
      startTime: new Date(),
      durationMs: 1000,
      status: 'completed' as const,
      agentName: 'parent-agent',
      sessionId: 'session-1',
      events: [],
      attributes: {},
    };

    observatoryStoreState = {
      ...defaultObservatoryState,
      getSpanTree: () => [
        {
          span: rootSpan,
          children: [
            {
              span: childSpan,
              children: [],
              depth: 1,
            },
          ],
          depth: 0,
        },
      ],
    };

    render(<SpanTree />);

    // Child should be visible initially (default expanded)
    expect(screen.getByText('child-step')).toBeInTheDocument();

    // Find and click the collapse button (the parent has a chevron button)
    // The expand/collapse button is the first button inside the span row
    // We need to find the button with the ChevronDown icon
    const parentRow = screen.getByText('parent-agent').closest('div[class*="flex items-center"]');
    expect(parentRow).toBeTruthy();

    // The toggle button is the first button child
    const toggleButton = parentRow!.querySelector('button');
    expect(toggleButton).toBeTruthy();

    // Collapse
    fireEvent.click(toggleButton!);

    // Child should be hidden after collapse
    expect(screen.queryByText('child-step')).not.toBeInTheDocument();

    // Expand again
    fireEvent.click(toggleButton!);

    // Child should be visible again
    expect(screen.getByText('child-step')).toBeInTheDocument();
  });

  test('recomputes the rendered tree when spans change but getSpanTree is stable', () => {
    const rootSpan = {
      spanId: 'span-root-stable',
      traceId: 'trace-1',
      name: 'stable-root',
      startTime: new Date(),
      durationMs: 5000,
      status: 'completed' as const,
      agentName: 'stable-root',
      sessionId: 'session-1',
      events: [],
      attributes: {},
    };

    const childSpan = {
      spanId: 'span-child-stable',
      traceId: 'trace-1',
      parentSpanId: 'span-root-stable',
      name: 'late-child',
      startTime: new Date(),
      durationMs: 1000,
      status: 'completed' as const,
      agentName: 'stable-root',
      sessionId: 'session-1',
      events: [],
      attributes: {},
    };

    let currentTree = [
      {
        span: rootSpan,
        children: [] as Array<{ span: typeof childSpan; children: never[]; depth: number }>,
        depth: 0,
      },
    ];
    const getSpanTree = () => currentTree;

    observatoryStoreState = {
      ...defaultObservatoryState,
      spans: new Map([[rootSpan.spanId, rootSpan]]),
      getSpanTree,
    };

    const { rerender } = render(<SpanTree />);

    expect(screen.getByText('stable-root')).toBeInTheDocument();
    expect(screen.queryByText('late-child')).not.toBeInTheDocument();

    currentTree = [
      {
        span: rootSpan,
        children: [
          {
            span: childSpan,
            children: [],
            depth: 1,
          },
        ],
        depth: 0,
      },
    ];
    observatoryStoreState = {
      ...observatoryStoreState,
      spans: new Map([
        [rootSpan.spanId, rootSpan],
        [childSpan.spanId, childSpan],
      ]),
    };

    rerender(<SpanTree />);

    expect(screen.getByText('late-child')).toBeInTheDocument();
  });

  test('collapsing a parent with a selected child re-selects the parent', () => {
    const rootSpan = {
      spanId: 'span-parent-selected',
      traceId: 'trace-1',
      name: 'parent-selected',
      startTime: new Date(),
      durationMs: 5000,
      status: 'completed' as const,
      agentName: 'parent-selected',
      sessionId: 'session-1',
      events: [],
      attributes: {},
    };

    const childSpan = {
      spanId: 'span-child-selected',
      traceId: 'trace-1',
      parentSpanId: 'span-parent-selected',
      name: 'child-selected',
      startTime: new Date(),
      durationMs: 1000,
      status: 'completed' as const,
      agentName: 'parent-selected',
      sessionId: 'session-1',
      events: [],
      attributes: {},
    };

    observatoryStoreState = {
      ...defaultObservatoryState,
      getSpanTree: () => [
        {
          span: rootSpan,
          children: [
            {
              span: childSpan,
              children: [],
              depth: 1,
            },
          ],
          depth: 0,
        },
      ],
    };
    observatoryStoreState = {
      ...observatoryStoreState,
      selection: { ...observatoryStoreState.selection, spanId: childSpan.spanId },
    };

    render(<SpanTree />);

    const parentRow = screen
      .getByText('parent-selected')
      .closest('div[class*="flex items-center"]');
    const toggleButton = parentRow?.querySelector('button');

    expect(toggleButton).toBeTruthy();

    fireEvent.click(toggleButton!);

    expect(mockSelectSpan).toHaveBeenCalledWith(rootSpan.spanId);
  });

  test('keyboard navigation skips children hidden by collapse', () => {
    const rootSpan = {
      spanId: 'span-parent-nav',
      traceId: 'trace-1',
      name: 'parent-nav',
      startTime: new Date(),
      durationMs: 5000,
      status: 'completed' as const,
      agentName: 'parent-nav',
      sessionId: 'session-1',
      events: [],
      attributes: {},
    };

    const childSpan = {
      spanId: 'span-child-nav',
      traceId: 'trace-1',
      parentSpanId: 'span-parent-nav',
      name: 'child-nav',
      startTime: new Date(),
      durationMs: 1000,
      status: 'completed' as const,
      agentName: 'parent-nav',
      sessionId: 'session-1',
      events: [],
      attributes: {},
    };

    const siblingSpan = {
      spanId: 'span-sibling-nav',
      traceId: 'trace-1',
      name: 'sibling-nav',
      startTime: new Date(),
      durationMs: 800,
      status: 'completed' as const,
      agentName: 'sibling-nav',
      sessionId: 'session-1',
      events: [],
      attributes: {},
    };

    observatoryStoreState = {
      ...defaultObservatoryState,
      getSpanTree: () => [
        {
          span: rootSpan,
          children: [
            {
              span: childSpan,
              children: [],
              depth: 1,
            },
          ],
          depth: 0,
        },
        {
          span: siblingSpan,
          children: [],
          depth: 0,
        },
      ],
    };
    observatoryStoreState = {
      ...observatoryStoreState,
      selection: { ...observatoryStoreState.selection, spanId: rootSpan.spanId },
    };

    render(<SpanTree />);

    const parentRow = screen.getByText('parent-nav').closest('div[class*="flex items-center"]');
    const toggleButton = parentRow?.querySelector('button');

    expect(toggleButton).toBeTruthy();

    fireEvent.click(toggleButton!);
    fireEvent.keyDown(screen.getByRole('tree'), { key: 'ArrowDown' });

    expect(mockSelectSpan).toHaveBeenLastCalledWith(siblingSpan.spanId);
  });

  test('span with error status shows error icon', () => {
    const span = {
      spanId: 'span-error-abc',
      traceId: 'trace-1',
      name: 'error-agent',
      startTime: new Date(),
      durationMs: 300,
      status: 'error' as const,
      agentName: 'error-agent',
      sessionId: 'session-1',
      events: [],
      attributes: {},
    };

    observatoryStoreState = {
      ...defaultObservatoryState,
      getSpanTree: () => [
        {
          span,
          children: [],
          depth: 0,
        },
      ],
    };

    render(<SpanTree />);

    expect(screen.getByText('error-agent')).toBeInTheDocument();
    // The error XCircle icon has text-error class
    const container = screen.getByText('error-agent').closest('div[class*="flex items-center"]');
    expect(container).toBeTruthy();
  });
});
