/**
 * Remaining Stores Tests
 *
 * Comprehensive tests for the remaining Zustand stores:
 * - ui-store (trace selection, session detail mode/tab)
 * - theme-store (light/dark/system, toggle, resolve)
 * - observatory-store (debug state, spans, flow, breakpoints, metrics, graphs, UI)
 * - version-store (diff view state)
 *
 * @vitest-environment happy-dom
 */

import { describe, test, expect, beforeEach } from 'vitest';

// =============================================================================
// UI STORE
// =============================================================================

import { useUIStore } from '../../store/ui-store';

describe('UI Store', () => {
  beforeEach(() => {
    useUIStore.setState({
      sessionDetailMode: false,
    });
  });

  describe('initial state', () => {
    test('has correct defaults', () => {
      const state = useUIStore.getState();
      expect(state.sessionDetailMode).toBe(false);
    });

    test('all actions are defined', () => {
      const state = useUIStore.getState();
      expect(typeof state.setSessionDetailMode).toBe('function');
    });
  });

  describe('setSessionDetailMode()', () => {
    test('sets to true', () => {
      useUIStore.getState().setSessionDetailMode(true);
      expect(useUIStore.getState().sessionDetailMode).toBe(true);
    });

    test('sets to false', () => {
      useUIStore.getState().setSessionDetailMode(true);
      useUIStore.getState().setSessionDetailMode(false);
      expect(useUIStore.getState().sessionDetailMode).toBe(false);
    });
  });
});

// =============================================================================
// THEME STORE
// =============================================================================

import { useThemeStore } from '../../store/theme-store';
import type { ThemeMode } from '../../store/theme-store';

describe('Theme Store', () => {
  beforeEach(() => {
    // Reset to system mode
    useThemeStore.setState({
      mode: 'system',
      resolved: 'dark', // matchMedia mock returns true for dark
    });
  });

  describe('initial state', () => {
    test('has correct defaults', () => {
      const state = useThemeStore.getState();

      expect(['light', 'dark']).toContain(state.resolved);
    });

    test('actions are defined', () => {
      const state = useThemeStore.getState();
      expect(typeof state.setMode).toBe('function');
      expect(typeof state.toggle).toBe('function');
    });
  });

  describe('setMode()', () => {
    test('sets mode to light', () => {
      useThemeStore.getState().setMode('light');
      expect(useThemeStore.getState().mode).toBe('light');
      expect(useThemeStore.getState().resolved).toBe('light');
    });

    test('sets mode to dark', () => {
      useThemeStore.getState().setMode('dark');
      expect(useThemeStore.getState().mode).toBe('dark');
      expect(useThemeStore.getState().resolved).toBe('dark');
    });

    test('sets mode to system', () => {
      useThemeStore.getState().setMode('light');
      useThemeStore.getState().setMode('system');
      expect(useThemeStore.getState().mode).toBe('system');
      // resolved depends on matchMedia mock
      expect(['light', 'dark']).toContain(useThemeStore.getState().resolved);
    });

    test('applies theme to document', () => {
      useThemeStore.getState().setMode('dark');
      expect(document.documentElement.getAttribute('data-theme')).toBe('dark');

      useThemeStore.getState().setMode('light');
      expect(document.documentElement.getAttribute('data-theme')).toBe('light');
    });
  });

  describe('toggle()', () => {
    test('toggles from dark to light', () => {
      useThemeStore.setState({ resolved: 'dark', mode: 'dark' });
      useThemeStore.getState().toggle();
      expect(useThemeStore.getState().mode).toBe('light');
      expect(useThemeStore.getState().resolved).toBe('light');
    });

    test('toggles from light to dark', () => {
      useThemeStore.setState({ resolved: 'light', mode: 'light' });
      useThemeStore.getState().toggle();
      expect(useThemeStore.getState().mode).toBe('dark');
      expect(useThemeStore.getState().resolved).toBe('dark');
    });

    test('double toggle returns to original', () => {
      useThemeStore.setState({ resolved: 'dark', mode: 'dark' });
      useThemeStore.getState().toggle();
      useThemeStore.getState().toggle();
      expect(useThemeStore.getState().resolved).toBe('dark');
    });
  });

  describe('persist behavior', () => {
    test('store uses persist middleware', () => {
      const persistApi = (useThemeStore as any).persist;
      expect(persistApi).toBeDefined();
    });
  });
});

// =============================================================================
// VERSION STORE
// =============================================================================

import { useVersionStore } from '../../store/version-store';

describe('Version Store', () => {
  beforeEach(() => {
    useVersionStore.getState().reset();
  });

  describe('initial state', () => {
    test('has correct defaults', () => {
      const state = useVersionStore.getState();
      expect(state.diffVersionA).toBeNull();
      expect(state.diffVersionB).toBeNull();
      expect(state.showDiff).toBe(false);
    });

    test('actions are defined', () => {
      const state = useVersionStore.getState();
      expect(typeof state.setDiffVersions).toBe('function');
      expect(typeof state.setShowDiff).toBe('function');
      expect(typeof state.reset).toBe('function');
    });
  });

  describe('setDiffVersions()', () => {
    test('sets both versions', () => {
      useVersionStore.getState().setDiffVersions('v1', 'v2');

      const state = useVersionStore.getState();
      expect(state.diffVersionA).toBe('v1');
      expect(state.diffVersionB).toBe('v2');
    });

    test('sets with null values', () => {
      useVersionStore.getState().setDiffVersions('v1', null);
      expect(useVersionStore.getState().diffVersionA).toBe('v1');
      expect(useVersionStore.getState().diffVersionB).toBeNull();
    });

    test('clears both with null', () => {
      useVersionStore.getState().setDiffVersions('v1', 'v2');
      useVersionStore.getState().setDiffVersions(null, null);
      expect(useVersionStore.getState().diffVersionA).toBeNull();
      expect(useVersionStore.getState().diffVersionB).toBeNull();
    });
  });

  describe('setShowDiff()', () => {
    test('sets showDiff to true', () => {
      useVersionStore.getState().setShowDiff(true);
      expect(useVersionStore.getState().showDiff).toBe(true);
    });

    test('sets showDiff to false', () => {
      useVersionStore.getState().setShowDiff(true);
      useVersionStore.getState().setShowDiff(false);
      expect(useVersionStore.getState().showDiff).toBe(false);
    });
  });

  describe('reset()', () => {
    test('resets all state to defaults', () => {
      useVersionStore.getState().setDiffVersions('v1', 'v2');
      useVersionStore.getState().setShowDiff(true);

      useVersionStore.getState().reset();

      const state = useVersionStore.getState();
      expect(state.diffVersionA).toBeNull();
      expect(state.diffVersionB).toBeNull();
      expect(state.showDiff).toBe(false);
    });
  });
});

// =============================================================================
// OBSERVATORY STORE
// =============================================================================

import { useObservatoryStore } from '../../store/observatory-store';
import type { ExtendedTraceEvent } from '../../types';

function makeExtendedEvent(overrides: Partial<ExtendedTraceEvent> = {}): ExtendedTraceEvent {
  return {
    id: `evt-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    type: 'llm_call',
    timestamp: new Date('2025-01-01T00:00:00Z'),
    traceId: 'trace-1',
    spanId: 'span-1',
    sessionId: 'session-1',
    agentName: 'test-agent',
    data: {},
    ...overrides,
  };
}

describe('Observatory Store', () => {
  beforeEach(() => {
    useObservatoryStore.setState({
      debugState: 'disconnected',
      debugSession: null,
      spans: new Map(),
      events: [],
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
      canvasViewMode: 'graph',
      selectedAppDomain: null,
      selectedAgentName: null,
      expandedApps: new Set(),
      sessionSidebarOpen: true,
      debugPanelTab: 'traces',
      debugPanelOpen: false,
      debugPanelWidth: 480,
      debugPanelMode: 'docked',
      debugPanelPosition: { x: 100, y: 100 },
      debugPanelSize: { width: 520, height: 600 },
      logs: [],
    });
  });

  // Connection state
  describe('connection state', () => {
    test('initial debug state is disconnected', () => {
      expect(useObservatoryStore.getState().debugState).toBe('disconnected');
    });

    test('setDebugState changes state', () => {
      useObservatoryStore.getState().setDebugState('connected');
      expect(useObservatoryStore.getState().debugState).toBe('connected');

      useObservatoryStore.getState().setDebugState('running');
      expect(useObservatoryStore.getState().debugState).toBe('running');
    });

    test('setDebugSession sets session', () => {
      const session = {
        id: 'debug-1',
        name: 'Test Session',
        currentAgent: 'booking',
        state: 'connected' as const,
        startedAt: new Date(),
        turnCount: 0,
      };
      useObservatoryStore.getState().setDebugSession(session);

      expect(useObservatoryStore.getState().debugSession).toEqual(session);
    });

    test('setDebugSession clears with null', () => {
      useObservatoryStore.getState().setDebugSession({
        id: 's1',
        name: 'S',
        currentAgent: 'a',
        state: 'connected',
        startedAt: new Date(),
        turnCount: 0,
      });
      useObservatoryStore.getState().setDebugSession(null);
      expect(useObservatoryStore.getState().debugSession).toBeNull();
    });
  });

  // Span actions
  describe('span actions', () => {
    test('startSpan creates a new span', () => {
      useObservatoryStore
        .getState()
        .startSpan('span-1', 'Agent', 'trace-1', 'session-1', 'booking');

      const span = useObservatoryStore.getState().spans.get('span-1');
      expect(span).toBeDefined();
      expect(span!.name).toBe('Agent');
      expect(span!.status).toBe('running');
      expect(span!.agentName).toBe('booking');
    });

    test('endSpan marks span as completed', () => {
      useObservatoryStore.getState().startSpan('span-1', 'Agent', 'trace-1', 'session-1', 'agent');
      useObservatoryStore.getState().endSpan('span-1');

      const span = useObservatoryStore.getState().spans.get('span-1');
      expect(span!.status).toBe('completed');
      expect(span!.endTime).toBeDefined();
      expect(span!.durationMs).toBeDefined();
    });

    test('endSpan with error status', () => {
      useObservatoryStore
        .getState()
        .startSpan('span-err', 'Agent', 'trace-1', 'session-1', 'agent');
      useObservatoryStore.getState().endSpan('span-err', 'error');

      expect(useObservatoryStore.getState().spans.get('span-err')!.status).toBe('error');
    });

    test('addEventToSpan adds event to span', () => {
      useObservatoryStore.getState().startSpan('span-1', 'Agent', 'trace-1', 'session-1', 'agent');

      const event = makeExtendedEvent({ id: 'evt-1' });
      useObservatoryStore.getState().addEventToSpan('span-1', event);

      const span = useObservatoryStore.getState().spans.get('span-1');
      expect(span!.events).toHaveLength(1);
      expect(span!.events[0].id).toBe('evt-1');
    });

    test('getActiveSpan returns most recently started running span', () => {
      useObservatoryStore.getState().startSpan('span-1', 'First', 'trace-1', 'session-1', 'agent');
      useObservatoryStore.getState().startSpan('span-2', 'Second', 'trace-1', 'session-1', 'agent');

      const active = useObservatoryStore.getState().getActiveSpan();
      expect(active!.spanId).toBe('span-2');
    });

    test('getActiveSpan returns undefined when no running spans', () => {
      expect(useObservatoryStore.getState().getActiveSpan()).toBeUndefined();
    });
  });

  // Flow actions
  describe('flow actions', () => {
    test('addFlowNode adds a node', () => {
      useObservatoryStore.getState().addFlowNode({
        id: 'booking',
        agentName: 'booking',
        mode: 'scripted',
        status: 'active',
        turnCount: 0,
      });

      expect(useObservatoryStore.getState().flowNodes).toHaveLength(1);
      expect(useObservatoryStore.getState().flowNodes[0].agentName).toBe('booking');
    });

    test('updateFlowNode updates matching node', () => {
      useObservatoryStore.getState().addFlowNode({
        id: 'booking',
        agentName: 'booking',
        mode: 'scripted',
        status: 'active',
        turnCount: 0,
      });

      useObservatoryStore.getState().updateFlowNode('booking', { status: 'completed' });

      expect(useObservatoryStore.getState().flowNodes[0].status).toBe('completed');
    });

    test('addFlowEdge adds an edge', () => {
      useObservatoryStore.getState().addFlowEdge({
        id: 'edge-1',
        from: 'supervisor',
        to: 'booking',
        type: 'handoff',
        timestamp: new Date(),
      });

      expect(useObservatoryStore.getState().flowEdges).toHaveLength(1);
    });

    test('clearFlow clears nodes and edges', () => {
      useObservatoryStore.getState().addFlowNode({
        id: 'n1',
        agentName: 'a',
        mode: 'scripted',
        status: 'active',
        turnCount: 0,
      });
      useObservatoryStore.getState().addFlowEdge({
        id: 'e1',
        from: 'a',
        to: 'b',
        type: 'handoff',
        timestamp: new Date(),
      });

      useObservatoryStore.getState().clearFlow();

      expect(useObservatoryStore.getState().flowNodes).toEqual([]);
      expect(useObservatoryStore.getState().flowEdges).toEqual([]);
    });
  });

  // Breakpoint actions
  describe('breakpoint actions', () => {
    test('addBreakpoint creates a breakpoint', () => {
      useObservatoryStore.getState().addBreakpoint('agent', { agentName: 'booking' });

      const bps = useObservatoryStore.getState().breakpoints;
      expect(bps).toHaveLength(1);
      expect(bps[0].type).toBe('agent');
      expect(bps[0].spec.agentName).toBe('booking');
      expect(bps[0].enabled).toBe(true);
      expect(bps[0].hitCount).toBe(0);
    });

    test('removeBreakpoint removes by id', () => {
      useObservatoryStore.getState().addBreakpoint('step', { stepName: 'greeting' });
      const id = useObservatoryStore.getState().breakpoints[0].id;

      useObservatoryStore.getState().removeBreakpoint(id);

      expect(useObservatoryStore.getState().breakpoints).toHaveLength(0);
    });

    test('toggleBreakpoint toggles enabled state', () => {
      useObservatoryStore.getState().addBreakpoint('event', { eventType: 'error' });
      const id = useObservatoryStore.getState().breakpoints[0].id;

      useObservatoryStore.getState().toggleBreakpoint(id);
      expect(useObservatoryStore.getState().breakpoints[0].enabled).toBe(false);

      useObservatoryStore.getState().toggleBreakpoint(id);
      expect(useObservatoryStore.getState().breakpoints[0].enabled).toBe(true);
    });

    test('clearBreakpoints removes all', () => {
      useObservatoryStore.getState().addBreakpoint('agent', { agentName: 'a' });
      useObservatoryStore.getState().addBreakpoint('step', { stepName: 'b' });

      useObservatoryStore.getState().clearBreakpoints();

      expect(useObservatoryStore.getState().breakpoints).toEqual([]);
    });
  });

  // UI actions
  describe('UI actions', () => {
    test('selectExecutionNode stores execution tree selection', () => {
      useObservatoryStore.getState().selectExecutionNode('node-42');
      expect(useObservatoryStore.getState().selection.executionNodeId).toBe('node-42');
    });

    test('selectSpan stores span selection', () => {
      useObservatoryStore.getState().selectSpan('span-42');
      expect(useObservatoryStore.getState().selection.spanId).toBe('span-42');
    });

    test('clearSelection resets all observatory selection channels', () => {
      const store = useObservatoryStore.getState();
      store.selectExecutionNode('node-42');
      store.selectSpan('span-42');

      store.clearSelection();

      expect(useObservatoryStore.getState().selection).toEqual({
        executionNodeId: null,
        spanId: null,
      });
    });

    test('setShowObservatory toggles visibility', () => {
      useObservatoryStore.getState().setShowObservatory(true);
      expect(useObservatoryStore.getState().showObservatory).toBe(true);
    });

    test('setActiveTab changes tab', () => {
      useObservatoryStore.getState().setActiveTab('spans');
      expect(useObservatoryStore.getState().activeTab).toBe('spans');
    });

    test('setCanvasViewMode changes view mode', () => {
      useObservatoryStore.getState().setCanvasViewMode('chat');
      expect(useObservatoryStore.getState().canvasViewMode).toBe('chat');
    });

    test('setSelectedApp sets app domain', () => {
      useObservatoryStore.getState().setSelectedApp('healthcare');
      expect(useObservatoryStore.getState().selectedAppDomain).toBe('healthcare');
    });

    test('setSelectedAgent sets agent name', () => {
      useObservatoryStore.getState().setSelectedAgent('booking');
      expect(useObservatoryStore.getState().selectedAgentName).toBe('booking');
    });

    test('toggleAppExpanded toggles app in set', () => {
      useObservatoryStore.getState().toggleAppExpanded('healthcare');
      expect(useObservatoryStore.getState().expandedApps.has('healthcare')).toBe(true);

      useObservatoryStore.getState().toggleAppExpanded('healthcare');
      expect(useObservatoryStore.getState().expandedApps.has('healthcare')).toBe(false);
    });

    test('toggleSessionSidebar toggles sidebar', () => {
      expect(useObservatoryStore.getState().sessionSidebarOpen).toBe(true);
      useObservatoryStore.getState().toggleSessionSidebar();
      expect(useObservatoryStore.getState().sessionSidebarOpen).toBe(false);
    });

    test('setDebugPanelTab changes tab', () => {
      useObservatoryStore.getState().setDebugPanelTab('data');
      expect(useObservatoryStore.getState().debugPanelTab).toBe('data');
    });

    test('toggleDebugPanel toggles open state', () => {
      useObservatoryStore.getState().toggleDebugPanel();
      expect(useObservatoryStore.getState().debugPanelOpen).toBe(true);

      useObservatoryStore.getState().toggleDebugPanel();
      expect(useObservatoryStore.getState().debugPanelOpen).toBe(false);
    });

    test('setDebugPanelWidth clamps to valid range', () => {
      useObservatoryStore.getState().setDebugPanelWidth(200);
      expect(useObservatoryStore.getState().debugPanelWidth).toBe(320); // clamped min

      useObservatoryStore.getState().setDebugPanelWidth(1000);
      expect(useObservatoryStore.getState().debugPanelWidth).toBe(720); // clamped max
    });

    test('setDebugPanelSize clamps width and height', () => {
      useObservatoryStore.getState().setDebugPanelSize({ width: 100, height: 100 });
      const size = useObservatoryStore.getState().debugPanelSize;
      expect(size.width).toBe(360); // min 360
      expect(size.height).toBe(300); // min 300
    });

    test('setDebugPanelMode switches mode', () => {
      useObservatoryStore.getState().setDebugPanelMode('floating');
      expect(useObservatoryStore.getState().debugPanelMode).toBe('floating');
    });

    test('setDebugPanelPosition sets position', () => {
      useObservatoryStore.getState().setDebugPanelPosition({ x: 200, y: 300 });
      expect(useObservatoryStore.getState().debugPanelPosition).toEqual({ x: 200, y: 300 });
    });
  });

  // Log actions
  describe('log actions', () => {
    test('addLog adds a log entry', () => {
      useObservatoryStore.getState().addLog('info', 'Connected');

      const logs = useObservatoryStore.getState().logs;
      expect(logs).toHaveLength(1);
      expect(logs[0].level).toBe('info');
      expect(logs[0].message).toBe('Connected');
    });

    test('addLog keeps max 100 logs', () => {
      for (let i = 0; i < 105; i++) {
        useObservatoryStore.getState().addLog('info', `Log ${i}`);
      }

      expect(useObservatoryStore.getState().logs.length).toBeLessThanOrEqual(100);
    });

    test('clearLogs empties logs', () => {
      useObservatoryStore.getState().addLog('error', 'fail');
      useObservatoryStore.getState().clearLogs();
      expect(useObservatoryStore.getState().logs).toEqual([]);
    });
  });

  // Metrics actions
  describe('metrics actions', () => {
    test('recordStepVisit tracks step visits', () => {
      useObservatoryStore.getState().recordStepVisit('greeting', 100);
      useObservatoryStore.getState().recordStepVisit('greeting', 200);

      const metrics = useObservatoryStore.getState().stepMetrics.get('greeting');
      expect(metrics!.visitCount).toBe(2);
      expect(metrics!.totalTimeMs).toBe(300);
    });

    test('recordStepVisit tracks errors', () => {
      useObservatoryStore.getState().recordStepVisit('step1', 100, true);

      const metrics = useObservatoryStore.getState().stepMetrics.get('step1');
      expect(metrics!.errors).toBe(1);
    });

    test('recordConstraintCheck adds to history', () => {
      useObservatoryStore.getState().recordConstraintCheck({
        timestamp: new Date(),
        phaseName: 'validation',
        condition: 'age >= 18',
        passed: true,
      });

      expect(useObservatoryStore.getState().constraintHistory).toHaveLength(1);
    });

    test('resetMetrics clears all metric data', () => {
      useObservatoryStore.getState().recordStepVisit('step1', 100);
      useObservatoryStore.getState().recordConstraintCheck({
        timestamp: new Date(),
        phaseName: 'p',
        condition: 'c',
        passed: true,
      });
      useObservatoryStore.setState({
        totalLLMCalls: 5,
        totalToolCalls: 3,
        totalTokensIn: 1000,
        totalTokensOut: 500,
      });

      useObservatoryStore.getState().resetMetrics();

      const state = useObservatoryStore.getState();
      expect(state.stepMetrics.size).toBe(0);
      expect(state.constraintHistory).toEqual([]);
      expect(state.totalLLMCalls).toBe(0);
      expect(state.totalToolCalls).toBe(0);
      expect(state.totalTokensIn).toBe(0);
      expect(state.totalTokensOut).toBe(0);
    });
  });

  // Client timing
  describe('client timing', () => {
    test('startClientTimer records start time', () => {
      useObservatoryStore.getState().startClientTimer();
      expect(useObservatoryStore.getState().pendingMessageStartTime).not.toBeNull();
    });

    test('endClientTimer calculates elapsed time', () => {
      // Set a known start time
      const startTime = Date.now() - 100;
      useObservatoryStore.setState({ pendingMessageStartTime: startTime });

      useObservatoryStore.getState().endClientTimer();

      const state = useObservatoryStore.getState();
      expect(state.pendingMessageStartTime).toBeNull();
      expect(state.lastVolleyClientMs).toBeGreaterThanOrEqual(100);
      expect(state.volleyClientTimes).toHaveLength(1);
    });

    test('endClientTimer no-ops when no timer started', () => {
      useObservatoryStore.getState().endClientTimer();
      expect(useObservatoryStore.getState().lastVolleyClientMs).toBe(0);
    });

    test('recordClientRoundTrip records direct measurement', () => {
      useObservatoryStore.getState().recordClientRoundTrip(250);

      const state = useObservatoryStore.getState();
      expect(state.lastVolleyClientMs).toBe(250);
      expect(state.volleyClientTimes).toEqual([250]);
      expect(state.avgVolleyClientMs).toBe(250);
    });

    test('recordClientRoundTrip calculates average over multiple calls', () => {
      useObservatoryStore.getState().recordClientRoundTrip(100);
      useObservatoryStore.getState().recordClientRoundTrip(200);
      useObservatoryStore.getState().recordClientRoundTrip(300);

      expect(useObservatoryStore.getState().avgVolleyClientMs).toBe(200);
    });
  });

  // Static graph
  describe('static graph actions', () => {
    test('setStaticGraph sets graph and initializes execution state', () => {
      const graph = {
        nodes: [
          { id: 'greeting', type: 'step' as const, label: 'Greeting', deterministic: true },
          { id: 'farewell', type: 'step' as const, label: 'Farewell', deterministic: true },
        ],
        edges: [],
        entryPoint: 'greeting',
      };

      useObservatoryStore.getState().setStaticGraph(graph);

      expect(useObservatoryStore.getState().staticGraph).toEqual(graph);
      expect(useObservatoryStore.getState().executionState.get('greeting')).toBe('unvisited');
      expect(useObservatoryStore.getState().executionState.get('farewell')).toBe('unvisited');
    });

    test('updateNodeExecutionState updates state for a node', () => {
      useObservatoryStore.getState().updateNodeExecutionState('step1', 'active');
      expect(useObservatoryStore.getState().executionState.get('step1')).toBe('active');
    });

    test('clearExecutionState resets to unvisited', () => {
      const graph = {
        nodes: [{ id: 'step1', type: 'step' as const, label: 'S1', deterministic: true }],
        edges: [],
        entryPoint: 'step1',
      };
      useObservatoryStore.getState().setStaticGraph(graph);
      useObservatoryStore.getState().updateNodeExecutionState('step1', 'visited');

      useObservatoryStore.getState().clearExecutionState();

      expect(useObservatoryStore.getState().executionState.get('step1')).toBe('unvisited');
    });
  });

  // App graph
  describe('app graph actions', () => {
    test('setGraphViewMode changes view mode', () => {
      useObservatoryStore.getState().setGraphViewMode('app');
      expect(useObservatoryStore.getState().graphViewMode).toBe('app');
    });

    test('updateAppNodeExecutionState sets state per agent per node', () => {
      useObservatoryStore.getState().updateAppNodeExecutionState('booking', 'step1', 'active');

      const agentState = useObservatoryStore.getState().appExecutionState.get('booking');
      expect(agentState).toBeDefined();
      expect(agentState!.get('step1')).toBe('active');
    });
  });

  // getSpanTree
  describe('getSpanTree()', () => {
    test('returns empty array when no spans', () => {
      expect(useObservatoryStore.getState().getSpanTree()).toEqual([]);
    });

    test('builds tree with parent-child relationships', () => {
      useObservatoryStore.getState().startSpan('parent', 'Parent', 'trace-1', 'session-1', 'agent');
      useObservatoryStore
        .getState()
        .startSpan('child', 'Child', 'trace-1', 'session-1', 'agent', 'parent');

      const tree = useObservatoryStore.getState().getSpanTree();
      expect(tree).toHaveLength(1);
      expect(tree[0].span.spanId).toBe('parent');
      expect(tree[0].children).toHaveLength(1);
      expect(tree[0].children[0].span.spanId).toBe('child');
    });

    test('sets correct depth values', () => {
      useObservatoryStore.getState().startSpan('root', 'Root', 'trace-1', 'session-1', 'agent');
      useObservatoryStore
        .getState()
        .startSpan('child', 'Child', 'trace-1', 'session-1', 'agent', 'root');
      useObservatoryStore
        .getState()
        .startSpan('grandchild', 'Grandchild', 'trace-1', 'session-1', 'agent', 'child');

      const tree = useObservatoryStore.getState().getSpanTree();
      expect(tree[0].depth).toBe(0);
      expect(tree[0].children[0].depth).toBe(1);
      expect(tree[0].children[0].children[0].depth).toBe(2);
    });
  });

  // getStepHeatmapData
  describe('getStepHeatmapData()', () => {
    test('returns empty map when no metrics', () => {
      expect(useObservatoryStore.getState().getStepHeatmapData().size).toBe(0);
    });

    test('calculates avg time and error rate', () => {
      useObservatoryStore.getState().recordStepVisit('greeting', 100, false);
      useObservatoryStore.getState().recordStepVisit('greeting', 200, true);

      const heatmap = useObservatoryStore.getState().getStepHeatmapData();
      const data = heatmap.get('greeting');
      expect(data!.visitCount).toBe(2);
      expect(data!.avgTimeMs).toBe(150);
      expect(data!.errorRate).toBe(0.5);
    });
  });

  // clearEvents
  describe('clearEvents()', () => {
    test('clears events, spans, flow, and selection', () => {
      useObservatoryStore.getState().startSpan('s1', 'S1', 't1', 'sess1', 'agent');
      useObservatoryStore.getState().addFlowNode({
        id: 'n1',
        agentName: 'a',
        mode: 'scripted',
        status: 'active',
        turnCount: 0,
      });
      useObservatoryStore.getState().selectExecutionNode('node-1');
      useObservatoryStore.getState().selectSpan('s1');

      useObservatoryStore.getState().clearEvents();

      const state = useObservatoryStore.getState();
      expect(state.events).toEqual([]);
      expect(state.spans.size).toBe(0);
      expect(state.flowNodes).toEqual([]);
      expect(state.flowEdges).toEqual([]);
      expect(state.selection).toEqual({
        executionNodeId: null,
        spanId: null,
      });
    });

    test('preserves static graph but resets execution state', () => {
      const graph = {
        nodes: [{ id: 'step1', type: 'step' as const, label: 'S1', deterministic: true }],
        edges: [],
        entryPoint: 'step1',
      };
      useObservatoryStore.getState().setStaticGraph(graph);
      useObservatoryStore.getState().updateNodeExecutionState('step1', 'visited');

      useObservatoryStore.getState().clearEvents();

      expect(useObservatoryStore.getState().staticGraph).toEqual(graph);
      expect(useObservatoryStore.getState().executionState.get('step1')).toBe('unvisited');
    });
  });
});
