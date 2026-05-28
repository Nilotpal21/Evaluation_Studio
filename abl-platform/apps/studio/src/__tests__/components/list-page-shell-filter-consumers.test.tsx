/**
 * ListPageShell filter consumer regressions
 *
 * Audits the remaining `ListPageShell` pages that rely on the shared
 * `filters` prop so the FilterSelect portal fix stays covered beyond Agents.
 *
 * @vitest-environment happy-dom
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { KnowledgeBase } from '../../api/search-ai';
import type { TransferSession } from '../../api/agent-transfer';

const mockUseTransferSessions = vi.fn();
const mockUseKnowledgeBases = vi.fn();
const mockUseConnections = vi.fn();
const mockNavigate = vi.fn();
const mockToastSuccess = vi.fn();
const mockToastError = vi.fn();
const mockEndTransferSession = vi.fn();

const mockNavigationStore = {
  projectId: 'proj-1',
  navigate: mockNavigate,
};

vi.mock('next-intl', () => ({
  useTranslations: (namespace: string) => (key: string, params?: Record<string, unknown>) => {
    const messages: Record<string, string> = {
      'search_ai.dashboard.title': 'Knowledge Bases',
      'search_ai.dashboard.description': 'Browse indexed knowledge bases',
      'search_ai.dashboard.new_kb': 'New Knowledge Base',
      'search_ai.dashboard.search_placeholder': 'Search knowledge bases',
      'search_ai.dashboard.filter_sort': 'Sort',
      'search_ai.dashboard.filter_status': 'Status',
      'search_ai.dashboard.filter_all': 'All',
      'search_ai.dashboard.filter_active': 'Active',
      'search_ai.dashboard.filter_indexing': 'Indexing',
      'search_ai.dashboard.filter_error': 'Error',
      'search_ai.dashboard.sort_newest': 'Newest',
      'search_ai.dashboard.sort_oldest': 'Oldest',
      'search_ai.dashboard.sort_name_asc': 'Name A-Z',
      'search_ai.dashboard.sort_name_desc': 'Name Z-A',
      'search_ai.dashboard.doc_count': `${params?.count ?? 0} docs`,
      'search_ai.dashboard.source_count': `${params?.count ?? 0} sources`,
      'search_ai.dashboard.updated_time': `Updated ${params?.time ?? ''}`,
      'search_ai.dashboard.no_description': 'No description',
      'search_ai.dashboard.stat_total': 'Total',
      'search_ai.dashboard.stat_active': 'Active',
      'search_ai.dashboard.stat_indexing': 'Indexing',
      'search_ai.dashboard.stat_total_documents': 'Total Documents',
      'search_ai.dashboard.stat_failed_documents': 'Failed Documents',
      'search_ai.dashboard.stat_errors': 'Errors',
      'search_ai.dashboard.time_just_now': 'just now',
      'search_ai.dashboard.time_minutes_ago': `${params?.count ?? 0} minutes ago`,
      'search_ai.dashboard.time_hours_ago': `${params?.count ?? 0} hours ago`,
      'search_ai.dashboard.time_days_ago': `${params?.count ?? 0} days ago`,
      'search_ai.dashboard.empty_title': 'No knowledge bases',
      'search_ai.dashboard.empty_description': 'Create one to get started',
      'search_ai.dashboard.no_results_title': 'No matching knowledge bases',
      'search_ai.dashboard.no_results_description': 'Try adjusting your filters',
      'search_ai.dashboard.error_title': 'Failed to load knowledge bases',
      'search_ai.dashboard.retry': 'Retry',
      'search_ai.dashboard.no_project_title': 'No project',
      'search_ai.dashboard.no_project_description': 'Select a project first',
    };

    return messages[`${namespace}.${key}`] ?? `${namespace}.${key}`;
  },
}));

vi.mock('sonner', () => ({
  toast: {
    success: (...args: unknown[]) => mockToastSuccess(...args),
    error: (...args: unknown[]) => mockToastError(...args),
  },
}));

vi.mock('../../store/navigation-store', () => ({
  useNavigationStore: vi.fn((selector?: (state: typeof mockNavigationStore) => unknown) =>
    selector ? selector(mockNavigationStore) : mockNavigationStore,
  ),
}));

vi.mock('../../hooks/useTransferSessions', () => ({
  useTransferSessions: (...args: unknown[]) => mockUseTransferSessions(...args),
}));

vi.mock('../../hooks/useKnowledgeBases', () => ({
  useKnowledgeBases: (...args: unknown[]) => mockUseKnowledgeBases(...args),
}));

vi.mock('../../hooks/useConnections', () => ({
  useConnections: (...args: unknown[]) => mockUseConnections(...args),
}));

vi.mock('../../api/agent-transfer', async () => {
  const actual = await vi.importActual<typeof import('../../api/agent-transfer')>(
    '../../api/agent-transfer',
  );

  return {
    ...actual,
    endTransferSession: (...args: unknown[]) => mockEndTransferSession(...args),
  };
});

vi.mock('../../components/operate/TransferSessionDetailModal', () => ({
  TransferSessionDetailModal: () => null,
}));

vi.mock('../../components/search-ai/CreateKnowledgeBaseDialog', () => ({
  CreateKnowledgeBaseDialog: () => null,
}));

vi.mock('@/hooks/useConnections', () => ({
  useConnections: () => ({
    connections: [{ connectorName: 'genesys' }, { connectorName: 'salesforce' }],
    isLoading: false,
    error: null,
    refresh: vi.fn(),
  }),
}));

import { TransferSessionsPage } from '../../components/operate/TransferSessionsPage';
import { KnowledgeBaseDashboardPage } from '../../components/search-ai/KnowledgeBaseDashboardPage';

const transferSessions: TransferSession[] = [
  {
    id: 'session-genesys-voice',
    contactId: 'contact-genesys-voice',
    agentId: 'agent-1',
    agentName: 'Genesys Voice Agent',
    provider: 'genesys',
    state: 'active',
    channel: 'voice',
    queue: 'priority',
    createdAt: '2026-04-01T10:00:00.000Z',
    updatedAt: '2026-04-01T10:05:00.000Z',
  },
  {
    id: 'session-salesforce-chat',
    contactId: 'contact-salesforce-chat',
    agentId: 'agent-2',
    agentName: 'Salesforce Chat Agent',
    provider: 'salesforce',
    state: 'pending',
    channel: 'chat',
    queue: 'default',
    createdAt: '2026-04-01T09:00:00.000Z',
    updatedAt: '2026-04-01T09:05:00.000Z',
  },
  {
    id: 'session-genesys-email',
    contactId: 'contact-genesys-email',
    agentId: 'agent-3',
    agentName: 'Genesys Email Agent',
    provider: 'genesys',
    state: 'ended',
    channel: 'email',
    queue: 'backlog',
    createdAt: '2026-04-01T08:00:00.000Z',
    updatedAt: '2026-04-01T08:05:00.000Z',
  },
];

const knowledgeBases: KnowledgeBase[] = [
  {
    _id: 'kb-ready',
    tenantId: 'tenant-1',
    projectId: 'proj-1',
    name: 'Active KB',
    description: 'Ready content',
    status: 'ready',
    searchIndexId: 'idx-1',
    canonicalSchemaId: 'schema-1',
    connectorCount: 2,
    documentCount: 14,
    lastIndexedAt: null,
    indexError: null,
    isPublic: false,
    createdAt: '2026-04-01T08:00:00.000Z',
    updatedAt: '2026-04-01T10:00:00.000Z',
  },
  {
    _id: 'kb-indexing',
    tenantId: 'tenant-1',
    projectId: 'proj-1',
    name: 'Indexing KB',
    description: 'Still building',
    status: 'indexing',
    searchIndexId: 'idx-2',
    canonicalSchemaId: 'schema-2',
    connectorCount: 1,
    documentCount: 4,
    lastIndexedAt: null,
    indexError: null,
    isPublic: false,
    createdAt: '2026-04-01T07:00:00.000Z',
    updatedAt: '2026-04-01T09:00:00.000Z',
  },
  {
    _id: 'kb-error',
    tenantId: 'tenant-1',
    projectId: 'proj-1',
    name: 'Broken KB',
    description: 'Needs attention',
    status: 'error',
    searchIndexId: 'idx-3',
    canonicalSchemaId: 'schema-3',
    connectorCount: 3,
    documentCount: 8,
    lastIndexedAt: null,
    indexError: 'Connector failed',
    isPublic: false,
    createdAt: '2026-04-01T06:00:00.000Z',
    updatedAt: '2026-04-01T08:30:00.000Z',
  },
];

function filterTransferSessions(filters?: { provider?: string; state?: string; channel?: string }) {
  return transferSessions.filter((session) => {
    if (filters?.provider && session.provider !== filters.provider) return false;
    if (filters?.state && session.state !== filters.state) return false;
    if (filters?.channel && session.channel !== filters.channel) return false;
    return true;
  });
}

async function choosePortaledOption(currentLabel: string, optionLabel: string) {
  const user = userEvent.setup();
  await user.click(screen.getByRole('button', { name: new RegExp(currentLabel, 'i') }));
  await user.click(
    await screen.findByRole('button', { name: new RegExp(`^${optionLabel}$`, 'i') }),
  );
}

describe('ListPageShell filter consumers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockNavigationStore.projectId = 'proj-1';
    mockUseTransferSessions.mockImplementation(
      (filters?: { provider?: string; state?: string; channel?: string }) => ({
        sessions: filterTransferSessions(filters),
        isLoading: false,
        error: null,
        refresh: vi.fn(),
      }),
    );
    mockUseKnowledgeBases.mockReturnValue({
      knowledgeBases,
      total: knowledgeBases.length,
      aggregateDocStats: { totalDocuments: 5, failedDocuments: 1 },
      isLoading: false,
      error: null,
      refresh: vi.fn(),
    });
    mockUseConnections.mockReturnValue({
      connections: [
        { id: 'conn-genesys', connectorName: 'genesys' },
        { id: 'conn-salesforce', connectorName: 'salesforce' },
      ],
      isLoading: false,
      error: null,
      refresh: vi.fn(),
    });
  });

  it('keeps TransferSessionsPage filters selectable through the shared portaled FilterSelect', async () => {
    render(<TransferSessionsPage />);

    expect(screen.getByText('Genesys Voice Agent')).toBeInTheDocument();
    expect(screen.getByText('Salesforce Chat Agent')).toBeInTheDocument();
    expect(screen.getByText('Genesys Email Agent')).toBeInTheDocument();

    await choosePortaledOption('All Providers', 'Genesys Cloud');

    await waitFor(() => {
      expect(mockUseTransferSessions).toHaveBeenLastCalledWith({
        provider: 'genesys',
        state: undefined,
        channel: undefined,
      });
    });

    expect(screen.getByText('Genesys Voice Agent')).toBeInTheDocument();
    expect(screen.getByText('Genesys Email Agent')).toBeInTheDocument();
    expect(screen.queryByText('Salesforce Chat Agent')).not.toBeInTheDocument();
  });

  it('keeps KnowledgeBaseDashboardPage filters selectable through the shared portaled FilterSelect', async () => {
    render(<KnowledgeBaseDashboardPage />);

    expect(screen.getByRole('heading', { name: 'Active KB' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Indexing KB' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Broken KB' })).toBeInTheDocument();

    await choosePortaledOption('All', 'Error');

    await waitFor(() => {
      expect(screen.getByRole('heading', { name: 'Broken KB' })).toBeInTheDocument();
    });

    expect(screen.queryByRole('heading', { name: 'Active KB' })).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Indexing KB' })).not.toBeInTheDocument();
  });
});
