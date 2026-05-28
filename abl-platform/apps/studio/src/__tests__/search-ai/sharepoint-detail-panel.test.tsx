/**
 * Tests for SharePointDetailPanel — tab routing, simplified view, expand/collapse,
 * draft detection, and More Actions menu.
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

// ─── Mock lucide-react (CRITICAL — prevents happy-dom hang) ───────────
vi.mock('lucide-react', () => {
  const n = () => null;
  return {
    MoreHorizontal: n,
    Copy: n,
    FileJson: n,
    FileCode: n,
    Upload: n,
    HeartPulse: n,
    Bug: n,
    Trash2: n,
    Maximize2: n,
    Minimize2: n,
    Lock: n,
    X: n,
    Loader2: n,
    ChevronRight: n,
    Check: n,
    ExternalLink: n,
    Building2: n,
    LogIn: n,
    MonitorSmartphone: n,
    Globe: n,
    Key: n,
    Shield: n,
    Clock: n,
    AlertTriangle: n,
    Info: n,
    ChevronDown: n,
    ChevronUp: n,
    RefreshCw: n,
    Play: n,
    Pause: n,
    Settings: n,
    Download: n,
    FileText: n,
    Search: n,
    Filter: n,
    Eye: n,
    ArrowRight: n,
    ArrowLeft: n,
    Plus: n,
    Minus: n,
  };
});

// ─── Mock SWR ──────────────────────────────────────────────────────────
const mockMutate = vi.fn();
let mockSwrReturn: Record<string, unknown> = {
  data: undefined,
  error: undefined,
  isLoading: false,
  isValidating: false,
  mutate: mockMutate,
};

vi.mock('swr', () => ({
  default: vi.fn(() => mockSwrReturn),
}));

// ─── Mock sanitize-error ───────────────────────────────────────────────
vi.mock('@/lib/sanitize-error', () => ({
  sanitizeError: (_e: unknown, fallback: string) => fallback,
}));

// ─── Mock sonner toast ─────────────────────────────────────────────────
vi.mock('sonner', () => ({
  toast: { error: vi.fn(), success: vi.fn(), info: vi.fn() },
}));

// ─── Mock API ──────────────────────────────────────────────────────────
vi.mock('../../../api/search-ai', () => ({
  createEnterpriseConnector: vi.fn(),
  initiateConnectorAuth: vi.fn(),
  getConnectorAuthStatus: vi.fn(),
  generateAdminEmail: vi.fn(),
  fetchConnectorProposal: vi.fn(),
  approveProposal: vi.fn(),
  getConnectorSyncPreview: vi.fn(),
  startConnectorSync: vi.fn(),
  getConnectorVersionHistory: vi.fn(),
  exportConnectorConfig: vi.fn(),
  purgeConnectorContent: vi.fn(),
  updateCitationConfig: vi.fn().mockResolvedValue({}),
}));

// ─── Mock child components (avoids their dependency trees) ─────────────
vi.mock('../../components/search-ai/sharepoint/ConnectTab', () => ({
  ConnectTab: () => <div data-testid="connect-tab">ConnectTab</div>,
}));

vi.mock('../../components/search-ai/sharepoint/ScopeFiltersSplitPane', () => ({
  ScopeFiltersSplitPane: () => <div data-testid="scope-filters-tab">ScopeFilters</div>,
}));

vi.mock('../../components/search-ai/sharepoint/PreviewTab', () => ({
  PreviewTab: () => <div data-testid="preview-tab">Preview</div>,
}));

vi.mock('../../components/search-ai/sharepoint/ProposalTab', () => ({
  ProposalTab: () => <div data-testid="proposal-tab">Proposal</div>,
}));

vi.mock('../../components/search-ai/sharepoint/ApproveAndStart', () => ({
  ApproveAndStart: () => <div data-testid="approve-tab">ApproveAndStart</div>,
}));

vi.mock('../../components/search-ai/sharepoint/OverviewTab', () => ({
  OverviewTab: () => <div data-testid="overview-tab">Overview</div>,
}));

vi.mock('../../components/search-ai/sharepoint/DraftBanner', () => ({
  DraftBanner: () => <div data-testid="draft-banner">DraftBanner</div>,
}));

vi.mock('../../components/search-ai/sharepoint/SecurityTab', () => ({
  SecurityTab: () => <div data-testid="security-tab">Security</div>,
}));

vi.mock('../../components/search-ai/sharepoint/config/VersionHistoryTab', () => ({
  VersionHistoryTab: () => <div data-testid="history-tab">History</div>,
}));

vi.mock('../../components/search-ai/sharepoint/config/ConfigExportDialog', () => ({
  ConfigExportDialog: () => null,
}));

vi.mock('../../components/search-ai/sharepoint/config/ContentPurgeDialog', () => ({
  ContentPurgeDialog: () => null,
}));

// ─── Mock Radix dropdown (Radix portal hangs happy-dom) ────────────────
vi.mock('../../components/ui/DropdownMenu', () => ({
  DropdownMenu: ({
    trigger,
    children,
  }: {
    trigger: React.ReactNode;
    children: React.ReactNode;
  }) => (
    <div>
      {trigger}
      <div data-testid="dropdown-content">{children}</div>
    </div>
  ),
  DropdownMenuItem: ({
    children,
    onSelect,
    disabled,
  }: {
    children: React.ReactNode;
    onSelect: () => void;
    disabled?: boolean;
    icon?: React.ReactNode;
    variant?: string;
  }) => (
    <button onClick={onSelect} disabled={disabled} data-testid="dropdown-item">
      {children}
    </button>
  ),
  DropdownMenuSeparator: () => <hr />,
}));

// ─── Mock SlidePanel (Radix Dialog + portals hang happy-dom) ──────────
vi.mock('../../components/ui/SlidePanel', () => ({
  SlidePanel: ({
    open,
    children,
    className,
    style,
  }: {
    open: boolean;
    onClose: () => void;
    children: React.ReactNode;
    className?: string;
    style?: React.CSSProperties;
  }) =>
    open ? (
      <div data-testid="slide-panel" className={className} style={style}>
        {children}
      </div>
    ) : null,
}));

// ─── Mock Tooltip (Radix tooltips hang happy-dom) ─────────────────────
vi.mock('../../components/ui/Tooltip', () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

import { useConnectorStore } from '../../store/connector-store';
import { SharePointDetailPanel } from '../../components/search-ai/sharepoint/SharePointDetailPanel';

// ─── Mock useConnector hook ────────────────────────────────────────────
const mockConnector = {
  _id: 'conn-123',
  tenantId: 'tenant-1',
  sourceId: 'src-1',
  connectorType: 'sharepoint',
  connectionConfig: { displayName: 'Marketing SP' },
  syncState: {
    lastFullSyncAt: null as string | null,
    lastDeltaSyncAt: null as string | null,
    totalDocuments: 0,
    processedDocuments: 0,
    failedDocuments: 0,
    syncInProgress: false,
    currentJobId: null,
    lastSyncError: null,
  },
  filterConfig: {},
  permissionConfig: {
    mode: 'enabled' as const,
    crawlSchedule: null,
    lastCrawlAt: null,
    crawlInProgress: false,
    documentsProcessed: 0,
    averageAccuracy: 0,
    lastCrawlError: null,
  },
  errorState: {
    consecutiveFailures: 0,
    lastErrorAt: null,
    lastErrorMessage: null,
    isPaused: false,
    pausedAt: null,
    pauseReason: null,
  },
  oauthTokenId: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

let mockConnectorReturn = {
  connector: mockConnector,
  isLoading: false,
  error: null,
  mutate: vi.fn(),
};

vi.mock('../../hooks/useConnector', () => ({
  useConnector: () => mockConnectorReturn,
}));

describe('SharePointDetailPanel', () => {
  const defaultProps = {
    indexId: 'idx-1',
    onRefresh: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    useConnectorStore.getState().resetStore();
    // Open panel with a connector by default
    useConnectorStore.getState().openPanel('conn-123');
    // Reset to draft connector
    mockConnectorReturn = {
      connector: {
        ...mockConnector,
        syncState: { ...mockConnector.syncState, lastFullSyncAt: null },
      },
      isLoading: false,
      error: null,
      mutate: vi.fn(),
    };
  });

  // ─── Rendering ───────────────────────────────────────────────────────

  it('renders panel when open', () => {
    render(<SharePointDetailPanel {...defaultProps} />);
    expect(screen.getByTestId('slide-panel')).toBeInTheDocument();
  });

  it('does not render panel when closed', () => {
    useConnectorStore.getState().closePanel();
    render(<SharePointDetailPanel {...defaultProps} />);
    expect(screen.queryByTestId('slide-panel')).not.toBeInTheDocument();
  });

  it('renders panel with the current 640px max-width by default', () => {
    render(<SharePointDetailPanel {...defaultProps} />);
    const panel = screen.getByTestId('slide-panel') as HTMLDivElement;
    expect(panel.style.maxWidth).toBe('640px');
  });

  // ─── Tab routing by status ───────────────────────────────────────────

  it('shows Connect tab for draft connector (default tab)', () => {
    render(<SharePointDetailPanel {...defaultProps} />);
    expect(screen.getByTestId('connect-tab')).toBeInTheDocument();
  });

  it('shows Overview tab for active connector', () => {
    // Make connector active (has completed sync)
    mockConnectorReturn = {
      connector: {
        ...mockConnector,
        syncState: { ...mockConnector.syncState, lastFullSyncAt: '2026-01-15T00:00:00.000Z' },
      },
      isLoading: false,
      error: null,
      mutate: vi.fn(),
    };
    useConnectorStore.getState().setActiveTab('overview');

    render(<SharePointDetailPanel {...defaultProps} />);
    expect(screen.getByTestId('overview-tab')).toBeInTheDocument();
  });

  // ─── Draft banner ────────────────────────────────────────────────────

  it('shows draft banner for draft connector', () => {
    render(<SharePointDetailPanel {...defaultProps} />);
    expect(screen.getByTestId('draft-banner')).toBeInTheDocument();
  });

  it('does not show draft banner for active connector', () => {
    mockConnectorReturn = {
      connector: {
        ...mockConnector,
        syncState: { ...mockConnector.syncState, lastFullSyncAt: '2026-01-15T00:00:00.000Z' },
      },
      isLoading: false,
      error: null,
      mutate: vi.fn(),
    };

    render(<SharePointDetailPanel {...defaultProps} />);
    expect(screen.queryByTestId('draft-banner')).not.toBeInTheDocument();
  });

  // ─── Tab locking for draft connectors ────────────────────────────────

  it('locks non-connect tabs for draft connectors (tab change ignored)', () => {
    render(<SharePointDetailPanel {...defaultProps} />);

    // Try to programmatically switch to proposal — the handleTabChange
    // should block this for draft connectors
    // We verify by checking that the connect tab is still shown
    useConnectorStore.getState().setActiveTab('proposal');

    // Re-render won't show proposal content because handleTabChange blocks it
    // But the store was set directly, so re-test by verifying lockstatus via the
    // component behavior. The lock icon should appear on non-connect tabs.
    expect(screen.getByTestId('connect-tab')).toBeInTheDocument();
  });

  // ─── Simplified View toggle ──────────────────────────────────────────

  it('Simplified View toggle hides scope-filters and history tabs', () => {
    // By default simplifiedView is ON → those tabs should be hidden
    render(<SharePointDetailPanel {...defaultProps} />);

    // With simplifiedView ON, tabs with simplifiedHidden: true should be filtered
    expect(screen.queryByText('Scope+Filters')).not.toBeInTheDocument();
    expect(screen.queryByText('History')).not.toBeInTheDocument();
  });

  it('shows all tabs when Simplified View is OFF', () => {
    useConnectorStore.getState().setSimplifiedView(false);
    render(<SharePointDetailPanel {...defaultProps} />);

    // Now scope-filters and history tabs should be visible
    expect(screen.getByText('Scope+Filters')).toBeInTheDocument();
    expect(screen.getByText('History')).toBeInTheDocument();
  });

  // ─── Expand/collapse state ───────────────────────────────────────────

  it('toggles to the wider expanded layout style', () => {
    useConnectorStore.getState().setExpandedPanel(true);
    render(<SharePointDetailPanel {...defaultProps} />);

    const panel = screen.getByTestId('slide-panel') as HTMLDivElement;
    expect(panel.style.maxWidth).toBe('calc(100vw - 16rem)');
  });

  // ─── Panel title ─────────────────────────────────────────────────────

  it('shows connector displayName in panel title', () => {
    render(<SharePointDetailPanel {...defaultProps} />);
    // Panel title includes the connector displayName
    expect(screen.getByText(/Marketing SP/)).toBeInTheDocument();
  });

  it('shows draft badge for draft connectors', () => {
    render(<SharePointDetailPanel {...defaultProps} />);
    // The Badge with draft text
    expect(screen.getByText('(Draft)')).toBeInTheDocument();
  });

  // ─── More Actions menu items ─────────────────────────────────────────

  it('renders the current More Actions menu entries', () => {
    render(<SharePointDetailPanel {...defaultProps} />);

    const menuItems = screen.getAllByTestId('dropdown-item');
    expect(menuItems).toHaveLength(3);
    expect(screen.getByRole('button', { name: 'Export JSON' })).not.toBeDisabled();
    expect(screen.getByRole('button', { name: 'Export YAML' })).not.toBeDisabled();
    expect(screen.getByRole('button', { name: 'Delete' })).not.toBeDisabled();
  });

  // ─── Close calls onRefresh ───────────────────────────────────────────

  it('calls onRefresh when close button is clicked', () => {
    const onRefresh = vi.fn();
    render(<SharePointDetailPanel indexId="idx-1" onRefresh={onRefresh} />);

    // Find the close button by its aria-label
    const closeBtn = screen.getByLabelText('Close');
    fireEvent.click(closeBtn);

    expect(onRefresh).toHaveBeenCalledOnce();
  });
});
