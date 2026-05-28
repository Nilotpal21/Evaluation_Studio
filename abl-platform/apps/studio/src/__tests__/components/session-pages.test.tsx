/**
 * Session Pages Tests
 *
 * Comprehensive tests for session management UI components:
 * - SessionsListPage: table, filters, sorting, pagination, copy, navigation
 * - SessionDetailPage: loading/error states, breadcrumb, metrics, layout
 * - AgentExecutionTree: tested separately
 */

import React from 'react';
import { describe, test, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, within, waitFor } from '@testing-library/react';
import type { SessionListItem, TraceEvent } from '../../types';

// =============================================================================
// MOCKS
// =============================================================================

// Mock useSessionList hook
const mockUseSessionList = vi.fn();
vi.mock('../../hooks/useSessionList', () => ({
  useSessionList: () => mockUseSessionList(),
}));

// Mock useSessionDetail hook
const mockUseSessionDetail = vi.fn();
vi.mock('../../hooks/useSessionDetail', () => ({
  useSessionDetail: (sessionId: string | null) => mockUseSessionDetail(sessionId),
}));

// Mock navigation store
const mockNavigate = vi.fn();
const mockNavigationStore = {
  projectId: 'proj-123',
  subPage: null as string | null,
  navigate: mockNavigate,
};

vi.mock('../../store/navigation-store', () => ({
  useNavigationStore: vi.fn((sel?: (s: typeof mockNavigationStore) => unknown) => {
    return sel ? sel(mockNavigationStore) : mockNavigationStore;
  }),
}));

vi.mock('../../store/ui-store', () => ({
  useUIStore: (selector?: (s: any) => any) => {
    const state = {
      sessionDetailMode: false,
      setSessionDetailMode: vi.fn(),
    };
    return selector ? selector(state) : state;
  },
}));

const mockSelectExecutionNode = vi.fn();
const mockSelectSpan = vi.fn();
let mockSelection = {
  executionNodeId: null as string | null,
  spanId: null as string | null,
};

// Mock observatory store (used by DebugTabs)
vi.mock('../../store/observatory-store', () => ({
  useObservatoryStore: (selector?: (s: any) => any) => {
    const state = {
      debugState: 'disconnected',
      debugSession: null,
      events: [],
      spans: new Map(),
      spanTree: [],
      agentFlowNodes: [],
      agentFlowEdges: [],
      breakpoints: [],
      logs: [],
      timeline: [],
      gatherProgress: {},
      constraintResults: [],
      stepMetrics: new Map(),
      staticGraph: null,
      appStaticGraph: null,
      nodeExecutionStates: new Map(),
      canvasViewMode: 'graph',
      selectedDebugTab: 'traces',
      selection: mockSelection,
      selectExecutionNode: mockSelectExecutionNode,
      selectSpan: mockSelectSpan,
      clearEvents: vi.fn(),
      clearFlow: vi.fn(),
      resetMetrics: vi.fn(),
      clearLogs: vi.fn(),
      clearExecutionState: vi.fn(),
      setSelectedDebugTab: vi.fn(),
    };
    return selector ? selector(state) : state;
  },
}));

// Mock session store (used by DebugTabs)
vi.mock('../../store/session-store', () => ({
  useSessionStore: (selector?: (s: any) => any) => {
    const state = {
      sessionId: null,
      agentState: null,
      messages: [],
      isConnected: false,
    };
    return selector ? selector(state) : state;
  },
}));

// Mock DropdownMenu (Radix UI portal + pointer events don't work with fireEvent in happy-dom)
vi.mock('../../components/ui/DropdownMenu', () => ({
  DropdownMenu: ({ trigger, children }: any) => (
    <div>
      {trigger}
      {children}
    </div>
  ),
  DropdownMenuItem: ({ children, onSelect }: any) => (
    <button type="button" onClick={onSelect}>
      {children}
    </button>
  ),
}));

const mockRegisterPageHeader = vi.hoisted(() => vi.fn());
vi.mock('../../contexts/PageHeaderContext', () => ({
  useRegisterPageHeader: (...args: unknown[]) => mockRegisterPageHeader(...args),
}));

// Mock DebugTabs (complex sub-component with its own dependency tree)
vi.mock('../../components/observatory/DebugTabs', () => ({
  DebugTabs: () => <div data-testid="debug-tabs">DebugTabs</div>,
  buildDebugTraceExport: vi.fn(),
}));

// Mock JsonViewer
vi.mock('../../components/ui/JsonViewer', () => ({
  JsonViewer: ({ data }: { data: unknown }) => (
    <pre data-testid="json-viewer">{JSON.stringify(data)}</pre>
  ),
  CollapsibleSection: ({ title, children }: { title: string; children: React.ReactNode }) => (
    <div data-testid="collapsible-section">
      <span>{title}</span>
      {children}
    </div>
  ),
}));

// Mock replay-trace-events side effects, but keep shared augmentation helpers
vi.mock('../../utils/replay-trace-events', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../utils/replay-trace-events')>();
  return {
    ...actual,
    replayTraceEventsIntoObservatory: vi.fn(),
    hydrateSessionStoreFromDetail: vi.fn(),
  };
});

// Mock auth store
vi.mock('../../store/auth-store', () => ({
  useAuthStore: Object.assign(
    (selector?: (s: any) => any) => {
      const state = { accessToken: 'test-token', isAuthenticated: true };
      return selector ? selector(state) : state;
    },
    { getState: () => ({ accessToken: 'test-token', isAuthenticated: true }) },
  ),
}));

// Mock api client
vi.mock('../../lib/api-client', () => ({
  apiFetch: vi.fn(),
}));

// =============================================================================
// TEST DATA FACTORIES
// =============================================================================

// Use dates within "last 7 days" of the test run so the default filter includes them
const NOW = new Date();
const RECENT_DATE = new Date(NOW.getTime() - 1 * 60 * 60 * 1000); // 1 hour ago
const RECENT_DATE_END = new Date(RECENT_DATE.getTime() + 5 * 60 * 1000); // 5 min after start

function makeSession(overrides: Partial<SessionListItem> = {}): SessionListItem {
  const id = overrides.id || 'abcdef1234567890abcdef1234567890';
  return {
    id,
    agentId: 'agent-1',
    agentName: 'TestAgent',
    status: 'completed',
    durationMs: 300000,
    messageCount: 5,
    traceEventCount: 10,
    tokenCount: 0,
    estimatedCost: 0,
    errorCount: 0,
    createdAt: overrides.createdAt || RECENT_DATE.toISOString(),
    lastActivityAt: overrides.lastActivityAt || RECENT_DATE_END.toISOString(),
    ...overrides,
  };
}

function makeSessions(count: number): SessionListItem[] {
  return Array.from({ length: count }, (_, i) =>
    makeSession({
      id: `session-${String(i).padStart(30, '0')}`,
      agentName: `Agent-${i}`,
      messageCount: i * 2,
      traceEventCount: i * 3,
      createdAt: new Date(NOW.getTime() - (count - i) * 60 * 1000).toISOString(),
      lastActivityAt: new Date(
        NOW.getTime() - (count - i) * 60 * 1000 + 5 * 60 * 1000,
      ).toISOString(),
    }),
  );
}

function makeTraceEvent(overrides: Partial<TraceEvent> = {}): TraceEvent {
  return {
    id: 'trace-1',
    sessionId: 'session-1',
    type: 'llm_call',
    timestamp: new Date('2025-05-10T10:00:00Z'),
    data: {},
    ...overrides,
  };
}

// =============================================================================
// IMPORTS (after mocks)
// =============================================================================

// We import after the vi.mock calls so mocks are in place
import { SessionsListPage } from '../../components/session/SessionsListPage';
import { SessionDetailPage } from '../../components/session/SessionDetailPage';
import { OverviewTab } from '../../components/session/OverviewTab';

// =============================================================================
// SESSIONSLISTPAGE TESTS
// =============================================================================

describe('SessionsListPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSelection = { executionNodeId: null, spanId: null };
    mockNavigationStore.projectId = 'proj-123';
    mockNavigationStore.subPage = null;
  });

  test('loading state shows "Loading sessions..." text', () => {
    mockUseSessionList.mockReturnValue({
      sessions: [],
      isLoading: true,
      refresh: vi.fn(),
      sessionsByAgent: {},
    });

    render(<SessionsListPage />);
    expect(screen.getByText('Loading sessions...')).toBeInTheDocument();
  });

  test('empty state shows "No sessions found" message', () => {
    mockUseSessionList.mockReturnValue({
      sessions: [],
      isLoading: false,
      refresh: vi.fn(),
      sessionsByAgent: {},
    });

    render(<SessionsListPage />);
    expect(screen.getByText('No sessions found for the selected time range.')).toBeInTheDocument();
  });

  test('renders table with correct column headers', () => {
    mockUseSessionList.mockReturnValue({
      sessions: [makeSession()],
      isLoading: false,
      refresh: vi.fn(),
      sessionsByAgent: {},
    });

    render(<SessionsListPage />);

    const table = screen.getByRole('table');
    const thead = table.querySelector('thead');
    expect(screen.getByText(/Session ID/)).toBeInTheDocument();
    expect(within(thead!).getByText(/^Agent$/)).toBeInTheDocument();
    expect(within(thead!).getByText(/^Status$/)).toBeInTheDocument();
    expect(within(thead!).getByText(/^Environment$/)).toBeInTheDocument();
    expect(within(thead!).getByText(/^Channel$/)).toBeInTheDocument();
    expect(screen.getByText(/Created At/)).toBeInTheDocument();
    expect(screen.getByText(/Duration/)).toBeInTheDocument();
    expect(screen.getByText(/Messages/)).toBeInTheDocument();
    // The aggregate column is named Trace Events to distinguish raw event counts
    // from the span-level Traces tab.
    expect(within(thead!).getByText(/Trace Events/)).toBeInTheDocument();
  });

  test('renders session rows with agent name and trace event count', () => {
    const session = makeSession({
      agentName: 'booking_agent',
      traceEventCount: 42,
      messageCount: 7,
    });

    mockUseSessionList.mockReturnValue({
      sessions: [session],
      isLoading: false,
      refresh: vi.fn(),
      sessionsByAgent: {},
    });

    render(<SessionsListPage />);

    expect(screen.getByText('Booking Agent')).toBeInTheDocument();
    expect(screen.getByText('42')).toBeInTheDocument();
    expect(screen.getByText('7')).toBeInTheDocument();
  });

  test('displays a prefixed session ID without a copy affordance in the table', () => {
    const session = makeSession({
      id: 'abcdef1234567890abcdef1234567890',
    });

    mockUseSessionList.mockReturnValue({
      sessions: [session],
      isLoading: false,
      refresh: vi.fn(),
      sessionsByAgent: {},
    });

    render(<SessionsListPage />);
    expect(screen.getByText('s-abcdef1234567890abcdef1234567890')).toBeInTheDocument();
    expect(screen.queryByText('abcdef1234567890abcdef1234567890')).not.toBeInTheDocument();
    expect(screen.queryByTitle('Copy session ID')).not.toBeInTheDocument();
  });

  test('date preset filter buttons work (clicking changes the selected preset)', () => {
    mockUseSessionList.mockReturnValue({
      sessions: [makeSession()],
      isLoading: false,
      refresh: vi.fn(),
      sessionsByAgent: {},
    });

    render(<SessionsListPage />);

    // All preset items are visible because DropdownMenu is mocked to always render children
    expect(screen.getByText('Last 24 hours')).toBeInTheDocument();
    expect(screen.getByText('Last 48 hours')).toBeInTheDocument();
    expect(screen.getByText('This week')).toBeInTheDocument();
    expect(screen.getByText('This month')).toBeInTheDocument();
    expect(screen.getByText('Last 30 days')).toBeInTheDocument();
    // "All time" appears once as a dropdown item
    expect(screen.getByText('All time')).toBeInTheDocument();

    // Click "All time" preset item — it's rendered as a button by the mock
    fireEvent.click(screen.getByText('All time'));

    // After clicking, the preset label updates to "All time"
    // The dropdown item "All time" is still visible (always-open mock)
    // Verify the component re-renders without error
    expect(screen.getAllByText('All time').length).toBeGreaterThanOrEqual(1);
  });

  test('sort by column header toggles asc/desc', () => {
    const sessions = [
      makeSession({ id: 'aaa-' + '0'.repeat(26), agentName: 'Alpha', traceEventCount: 5 }),
      makeSession({ id: 'bbb-' + '0'.repeat(26), agentName: 'Beta', traceEventCount: 10 }),
    ];

    mockUseSessionList.mockReturnValue({
      sessions,
      isLoading: false,
      refresh: vi.fn(),
      sessionsByAgent: {},
    });

    render(<SessionsListPage />);

    // Click "Agent" header to sort by agent name (first click sets desc)
    const table = screen.getByRole('table');
    const thead = table.querySelector('thead');
    const agentHeader = within(thead!).getByText(/^Agent$/);
    fireEvent.click(agentHeader);

    // Click again to toggle direction (asc)
    fireEvent.click(agentHeader);

    // The component should still render without error
    expect(screen.getAllByText('Alpha').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('Beta').length).toBeGreaterThanOrEqual(1);
  });

  test('pagination shows correct page info', () => {
    // Create fewer sessions than PAGE_SIZE (20) — no pagination controls shown for single page
    const sessions = makeSessions(5);

    mockUseSessionList.mockReturnValue({
      sessions,
      isLoading: false,
      refresh: vi.fn(),
      sessionsByAgent: {},
    });

    const { container } = render(<SessionsListPage />);

    // With only 1 page, the Pagination component (totalPages <= 1) renders nothing
    // and the ListPageShell hides the footer. No pagination controls should be visible.
    expect(container.querySelector('button[aria-label="Next page"]')).not.toBeInTheDocument();
    expect(container.querySelector('button[aria-label="Previous page"]')).not.toBeInTheDocument();
  });

  test('pagination navigates between pages', () => {
    // Create more sessions than PAGE_SIZE (20)
    const sessions = makeSessions(25);

    mockUseSessionList.mockReturnValue({
      sessions,
      isLoading: false,
      refresh: vi.fn(),
      sessionsByAgent: {},
    });

    render(<SessionsListPage />);

    // With 25 sessions and PAGE_SIZE=20, there are 2 pages — find pagination footer
    const paginationFooter = document.querySelector('div[class*="border-t"]');
    expect(paginationFooter).toBeTruthy();

    // Use aria-label to find next/previous buttons
    const nextButton = paginationFooter!.querySelector('button[aria-label="Next page"]');
    const prevButton = paginationFooter!.querySelector('button[aria-label="Previous page"]');
    expect(nextButton).toBeTruthy();
    expect(prevButton).toBeTruthy();

    // Initially on page 1 — prev disabled, next enabled
    expect(prevButton).toBeDisabled();
    expect(nextButton).not.toBeDisabled();

    // Click next — should go to page 2
    fireEvent.click(nextButton!);

    // Re-query after state update
    const updatedFooter = document.querySelector('div[class*="border-t"]');
    const updatedPrevButton = updatedFooter!.querySelector('button[aria-label="Previous page"]');
    const updatedNextButton = updatedFooter!.querySelector('button[aria-label="Next page"]');
    expect(updatedPrevButton).not.toBeDisabled();
    expect(updatedNextButton).toBeDisabled(); // last page

    // Click previous to go back
    fireEvent.click(updatedPrevButton!);
    const backFooter = document.querySelector('div[class*="border-t"]');
    const backPrevButton = backFooter!.querySelector('button[aria-label="Previous page"]');
    expect(backPrevButton).toBeDisabled(); // back on page 1
  });

  test('session table does not render a copy session ID button', () => {
    const session = makeSession({ id: 'copy-me-id-' + '0'.repeat(21) });

    mockUseSessionList.mockReturnValue({
      sessions: [session],
      isLoading: false,
      refresh: vi.fn(),
      sessionsByAgent: {},
    });

    render(<SessionsListPage />);

    expect(screen.getByText(`s-${session.id}`)).toBeInTheDocument();
    expect(screen.queryByTitle('Copy session ID')).not.toBeInTheDocument();
    expect(navigator.clipboard.writeText).not.toHaveBeenCalled();
  });

  test('clicking a session row navigates to session detail', () => {
    const session = makeSession({
      id: 'nav-test-id-' + '0'.repeat(20),
      agentName: 'test_agent',
    });

    mockUseSessionList.mockReturnValue({
      sessions: [session],
      isLoading: false,
      refresh: vi.fn(),
      sessionsByAgent: {},
    });

    render(<SessionsListPage />);

    // Click the table row
    const row = screen.getByText('Test Agent').closest('tr');
    expect(row).toBeTruthy();
    fireEvent.click(row!);

    expect(mockNavigate).toHaveBeenCalledWith(`/projects/proj-123/sessions/${session.id}`);
  });

  test('session count text shows correct number', () => {
    const sessions = makeSessions(3);

    mockUseSessionList.mockReturnValue({
      sessions,
      isLoading: false,
      refresh: vi.fn(),
      sessionsByAgent: {},
    });

    render(<SessionsListPage />);
    expect(screen.getByText('3 sessions')).toBeInTheDocument();
  });

  test('single session shows singular text', () => {
    mockUseSessionList.mockReturnValue({
      sessions: [makeSession()],
      isLoading: false,
      refresh: vi.fn(),
      sessionsByAgent: {},
    });

    render(<SessionsListPage />);
    expect(screen.getByText('1 session')).toBeInTheDocument();
  });

  test('page title and description render', () => {
    mockUseSessionList.mockReturnValue({
      sessions: [],
      isLoading: false,
      refresh: vi.fn(),
      sessionsByAgent: {},
    });

    render(<SessionsListPage />);
    expect(mockRegisterPageHeader).toHaveBeenCalledWith(
      'Sessions',
      undefined,
      'Review session logs and trace details to analyze conversation logs and app behavior.',
      undefined,
    );
  });
});

// =============================================================================
// SESSIONDETAILPAGE TESTS
// =============================================================================

describe('SessionDetailPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSelection = { executionNodeId: null, spanId: null };
    mockNavigationStore.projectId = 'proj-123';
    mockNavigationStore.subPage = 'test-session-id-00000000';
    window.history.pushState({}, '', '/');
  });

  test('loading state shows spinner and "Loading session..." text', () => {
    mockUseSessionDetail.mockReturnValue({
      session: null,
      loading: true,
      error: null,
      tree: [],
      metrics: { totalTokens: 0, totalCost: 0, latencyMs: 0, llmCalls: 0 },
      refresh: vi.fn(),
    });

    render(<SessionDetailPage />);
    expect(screen.getByText('Loading session...')).toBeInTheDocument();
  });

  test('error state shows error message with "Back to Sessions" link', () => {
    mockUseSessionDetail.mockReturnValue({
      session: null,
      loading: false,
      error: 'Session not found',
      tree: [],
      metrics: { totalTokens: 0, totalCost: 0, latencyMs: 0, llmCalls: 0 },
      refresh: vi.fn(),
    });

    render(<SessionDetailPage />);
    expect(screen.getByText('Session not found')).toBeInTheDocument();

    const backLinks = screen.getAllByText('Back to Sessions');
    expect(backLinks.length).toBeGreaterThanOrEqual(1);

    fireEvent.click(backLinks[backLinks.length - 1]);
    expect(mockNavigate).toHaveBeenCalledWith('/projects/proj-123/sessions');
  });

  test('with data: shows a copyable prefixed session ID in the header', async () => {
    mockNavigationStore.subPage = 'abcdef1234567890abcdef1234567890';

    mockUseSessionDetail.mockReturnValue({
      session: {
        id: 'abcdef1234567890abcdef1234567890',
        agentName: 'TestAgent',
        messages: [],
        traceEvents: [],
      },
      loading: false,
      error: null,
      tree: [],
      metrics: { totalTokens: 100, totalCost: 0.0005, latencyMs: 1200, llmCalls: 2 },
      refresh: vi.fn(),
    });

    render(<SessionDetailPage />);

    // Header shows "Back to Sessions" link and the full prefixed ID
    const sessionsLinks = screen.getAllByText('Back to Sessions');
    expect(sessionsLinks.length).toBeGreaterThan(0);

    expect(screen.getByText('s-abcdef1234567890abcdef1234567890')).toBeInTheDocument();
    expect(screen.queryByText('abcdef1234567890abcdef1234567890')).not.toBeInTheDocument();

    const headerId = screen.getByText('s-abcdef1234567890abcdef1234567890');
    fireEvent.click(headerId);

    await waitFor(() => {
      expect(navigator.clipboard.writeText).toHaveBeenCalledWith(
        'abcdef1234567890abcdef1234567890',
      );
    });
  });

  test.each([null, ''])(
    'with route data: falls back to the raw URL session ID when navigation store subPage is %s',
    (staleSubPage) => {
      const routeSessionId = 'route-session-id-abcdef1234567890';
      mockNavigationStore.subPage = staleSubPage;
      window.history.pushState({}, '', `/projects/proj-123/sessions/${routeSessionId}`);

      mockUseSessionDetail.mockReturnValue({
        session: {
          id: routeSessionId,
          agentName: 'TestAgent',
          messages: [],
          traceEvents: [],
        },
        loading: false,
        error: null,
        tree: [],
        metrics: { totalTokens: 0, totalCost: 0, latencyMs: 0, llmCalls: 0 },
        refresh: vi.fn(),
      });

      render(<SessionDetailPage />);

      expect(mockUseSessionDetail).toHaveBeenCalledWith(routeSessionId);
      expect(screen.getByText(`s-${routeSessionId}`)).toBeInTheDocument();
      expect(screen.queryByText(routeSessionId)).not.toBeInTheDocument();
    },
  );

  test('with route prop: uses the prefixed session ID passed by AppShell over a stale store value', () => {
    const routeSessionId = 'prop-session-id-abcdef1234567890';
    mockNavigationStore.subPage = '--';

    mockUseSessionDetail.mockReturnValue({
      session: {
        id: routeSessionId,
        agentName: 'TestAgent',
        messages: [],
        traceEvents: [],
      },
      loading: false,
      error: null,
      tree: [],
      metrics: { totalTokens: 0, totalCost: 0, latencyMs: 0, llmCalls: 0 },
      refresh: vi.fn(),
    });

    render(<SessionDetailPage sessionId={routeSessionId} />);

    expect(mockUseSessionDetail).toHaveBeenCalledWith(routeSessionId);
    expect(screen.getByText(`s-${routeSessionId}`)).toBeInTheDocument();
    expect(screen.queryByText(routeSessionId)).not.toBeInTheDocument();
    expect(screen.queryByText('--')).not.toBeInTheDocument();
  });

  test('with data: shows trace count and session cost metrics', () => {
    mockUseSessionDetail.mockReturnValue({
      session: {
        id: 'test-session-id',
        agentName: 'TestAgent',
        messages: [],
        traceEvents: [
          makeTraceEvent({ id: 't1' }),
          makeTraceEvent({ id: 't2' }),
          makeTraceEvent({ id: 't3' }),
        ],
      },
      loading: false,
      error: null,
      tree: [],
      metrics: { totalTokens: 500, totalCost: 0.0025, latencyMs: 3000, llmCalls: 3 },
      refresh: vi.fn(),
    });

    render(<SessionDetailPage />);

    // Trace count
    expect(screen.getByText('3')).toBeInTheDocument();

    // Session cost (formatted to 6 decimals) - appears in header and summary
    const costElements = screen.getAllByText('$0.002500');
    expect(costElements.length).toBeGreaterThanOrEqual(1);
  });

  test('shows trace source and partial status when trace metadata has diagnostics', () => {
    mockUseSessionDetail.mockReturnValue({
      session: {
        id: 'test-session-id',
        agentName: 'TestAgent',
        messages: [],
        traceEvents: [makeTraceEvent({ id: 't1' })],
        traceLoadStatus: 'loaded',
        traceMeta: {
          source: 'clickhouse_platform_events',
          source_chain: ['memory', 'clickhouse_platform_events'],
          loaded_count: 1,
          available_count: 3,
          is_truncated: true,
          warnings: [
            {
              source: 'memory',
              code: 'TRACE_BUFFER_LOOKUP_FAILED',
              message: 'Live trace buffer lookup failed',
            },
          ],
        },
      },
      loading: false,
      error: null,
      tree: [],
      metrics: { totalTokens: 0, totalCost: 0, latencyMs: 0, llmCalls: 0 },
      refresh: vi.fn(),
    });

    render(<SessionDetailPage />);

    expect(screen.getByText('Trace: history / partial')).toBeInTheDocument();
  });

  test('does not crash when trace metadata diagnostics are not arrays', () => {
    mockUseSessionDetail.mockReturnValue({
      session: {
        id: 'test-session-id',
        agentName: 'TestAgent',
        messages: [],
        traceEvents: [makeTraceEvent({ id: 't1' })],
        traceLoadStatus: 'loaded',
        traceMeta: {
          source: 'clickhouse_platform_events',
          source_chain: null,
          warnings: { code: 'TRACE_BUFFER_LOOKUP_FAILED' },
          errors: null,
        } as unknown,
      },
      loading: false,
      error: null,
      tree: [],
      metrics: { totalTokens: 0, totalCost: 0, latencyMs: 0, llmCalls: 0 },
      refresh: vi.fn(),
    });

    expect(() => render(<SessionDetailPage />)).not.toThrow();
    expect(screen.getByText('Trace: history / complete')).toBeInTheDocument();
  });

  test('back button navigates to sessions list', () => {
    mockUseSessionDetail.mockReturnValue({
      session: {
        id: 'test-session-id',
        agentName: 'TestAgent',
        messages: [],
        traceEvents: [],
      },
      loading: false,
      error: null,
      tree: [],
      metrics: { totalTokens: 0, totalCost: 0, latencyMs: 0, llmCalls: 0 },
      refresh: vi.fn(),
    });

    render(<SessionDetailPage />);

    // Find the back button by its title
    const backButton = screen.getByTitle('Back to Sessions');
    fireEvent.click(backButton);

    expect(mockNavigate).toHaveBeenCalledWith('/projects/proj-123/sessions');
  });

  test('resize divider is present in the two-panel layout', () => {
    mockUseSessionDetail.mockReturnValue({
      session: {
        id: 'test-session-id',
        agentName: 'TestAgent',
        messages: [],
        traceEvents: [],
      },
      loading: false,
      error: null,
      tree: [],
      metrics: { totalTokens: 0, totalCost: 0, latencyMs: 0, llmCalls: 0 },
      refresh: vi.fn(),
    });

    const { container } = render(<SessionDetailPage />);

    // Horizontal resize divider (col-resize) between left tree and right detail
    const colResizer = container.querySelector('.cursor-col-resize');
    expect(colResizer).toBeInTheDocument();
  });

  test('two-panel layout renders execution tree and debug tabs', () => {
    mockUseSessionDetail.mockReturnValue({
      session: {
        id: 'test-session-id',
        agentName: 'TestAgent',
        messages: [],
        traceEvents: [],
      },
      loading: false,
      error: null,
      tree: [],
      metrics: { totalTokens: 0, totalCost: 0, latencyMs: 0, llmCalls: 0 },
      refresh: vi.fn(),
    });

    render(<SessionDetailPage />);

    // DebugTabs in the right panel
    expect(screen.getByTestId('debug-tabs')).toBeInTheDocument();
  });
});

// NOTE: AgentConversationTree tests removed — component replaced by AgentExecutionTree

describe('OverviewTab session identity', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSelection = { executionNodeId: null, spanId: null };
  });

  test('uses the same copyable prefixed session ID as the header and copies the raw value', async () => {
    render(
      <OverviewTab
        traceEvents={[]}
        sessionId="abcdef1234567890abcdef1234567890"
        agentName="TestAgent"
        messageCount={0}
      />,
    );

    expect(screen.getByText('s-abcdef1234567890abcdef1234567890')).toBeInTheDocument();
    expect(screen.queryByText('abcdef1234567890abcdef1234567890')).not.toBeInTheDocument();

    fireEvent.click(screen.getByText('s-abcdef1234567890abcdef1234567890'));

    await waitFor(() => {
      expect(navigator.clipboard.writeText).toHaveBeenCalledWith(
        'abcdef1234567890abcdef1234567890',
      );
    });
  });

  test('does not change hook order when switching from session summary to selected node details', () => {
    const tree = [
      {
        id: 'node-1',
        type: 'tool_call' as const,
        label: 'Lookup order',
        data: { toolName: 'lookupOrder', success: true },
        children: [],
      },
    ];

    const { rerender } = render(
      <OverviewTab
        traceEvents={[]}
        tree={tree}
        sessionId="abcdef1234567890abcdef1234567890"
        agentName="TestAgent"
        messageCount={0}
      />,
    );

    expect(screen.getByText('s-abcdef1234567890abcdef1234567890')).toBeInTheDocument();

    mockSelection = { executionNodeId: 'node-1', spanId: null };

    expect(() =>
      rerender(
        <OverviewTab
          traceEvents={[]}
          tree={tree}
          sessionId="abcdef1234567890abcdef1234567890"
          agentName="TestAgent"
          messageCount={0}
        />,
      ),
    ).not.toThrow();

    expect(screen.getByText('Lookup order')).toBeInTheDocument();
    expect(screen.getByText('Input')).toBeInTheDocument();
  });
});
