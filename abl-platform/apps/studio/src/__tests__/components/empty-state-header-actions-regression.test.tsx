/**
 * Empty-state header action regressions
 *
 * Reproduces duplicate create/add CTAs when list pages render both a header
 * action and an empty-state CTA for zero-item states.
 *
 * @vitest-environment happy-dom
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import type { ModuleDependency } from '../../api/modules';
import type { KnowledgeBase } from '../../api/search-ai';
import type { WorkflowSummary } from '../../api/workflows';

const mockApiFetch = vi.fn();
const mockFetchVariableNamespaces = vi.fn();
const mockUseWorkflows = vi.fn();
const mockUseKnowledgeBases = vi.fn();
const mockUseSWR = vi.fn();
const mockFetchMcpServers = vi.fn();
const mockSetCurrentWorkflow = vi.fn();
const mockNavigate = vi.fn();
const mockToastError = vi.fn();
const mockToastSuccess = vi.fn();
const mockSetActivePipelineTab = vi.fn();
const mockSetPipelineSearchQuery = vi.fn();
const mockSetMcpServers = vi.fn();
const mockSetMcpServersLoading = vi.fn();
const mockSetMcpServersError = vi.fn();

const mockNavigationStore = {
  projectId: 'proj-1',
  navigate: mockNavigate,
};

const mockProjectStore = {
  currentProject: {
    id: 'proj-1',
  },
};

const mockPipelineListStore = {
  activeTab: 'custom',
  setActiveTab: mockSetActivePipelineTab,
  searchQuery: '',
  setSearchQuery: mockSetPipelineSearchQuery,
};

const mockMcpServerStore = {
  servers: [],
  isLoading: false,
  error: null,
  setServers: mockSetMcpServers,
  setLoading: mockSetMcpServersLoading,
  setError: mockSetMcpServersError,
};

const translations: Record<string, string> = {
  'settings.api_keys.page_title': 'API Keys',
  'settings.api_keys.page_description': 'Manage project API keys.',
  'settings.api_keys.count': '0 keys',
  'settings.api_keys.create_key': 'Create Key',
  'settings.api_keys.empty_title': 'No API keys yet',
  'settings.api_keys.empty_description': 'Create your first API key to access the SDK.',
  'settings.api_keys.load_failed': 'Failed to load API keys',
  'settings.api_keys.created': 'API key created',
  'settings.api_keys.create_failed': 'Failed to create API key',
  'settings.api_keys.deleted': 'API key deleted',
  'settings.api_keys.delete_failed': 'Failed to delete API key',
  'settings.api_keys.created_title': 'API key created',
  'settings.api_keys.created_warning': 'Copy it now.',
  'settings.api_keys.done': 'Done',
  'settings.api_keys.create': 'Create API key',
  'settings.api_keys.key_name_label': 'Key name',
  'settings.api_keys.key_name_placeholder': 'Production key',
  'settings.config_variables.page_title': 'Config Variables',
  'settings.config_variables.page_description': 'Project-level variables resolved at compile time.',
  'settings.config_variables.info_text': 'Config variables are available during compile time.',
  'settings.config_variables.info_syntax': '{{config.KEY}}',
  'settings.config_variables.count': '0 variables',
  'settings.config_variables.add_variable': 'Add Variable',
  'settings.config_variables.empty': 'No config variables yet',
  'settings.config_variables.empty_description':
    'Add your first project config variable to reference it in templates.',
  'settings.config_variables.load_failed': 'Failed to load variables',
  'settings.config_variables.key_required': 'Key is required',
  'settings.config_variables.key_format_error': 'Invalid key format',
  'settings.config_variables.key_duplicate': 'Duplicate key',
  'settings.config_variables.create_failed': 'Failed to create variable',
  'settings.config_variables.created': 'Variable created',
  'settings.config_variables.update_failed': 'Failed to update variable',
  'settings.config_variables.updated': 'Variable updated',
  'settings.config_variables.deleted': 'Variable deleted',
  'settings.config_variables.delete_failed': 'Failed to delete variable',
  'settings.config_vars.filter_placeholder': 'Search variables',
  'settings.config_vars.type_auto': 'Config',
  'common.cancel': 'Cancel',
  'common.confirm': 'Confirm',
  'common.delete': 'Delete',
  'common.edit': 'Edit',
  'common.save': 'Save',
  'common.add': 'Add',
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
  'search_ai.dashboard.empty_title': 'No knowledge bases',
  'search_ai.dashboard.empty_description': 'Create one to get started',
  'search_ai.dashboard.no_results_title': 'No matching knowledge bases',
  'search_ai.dashboard.no_results_description': 'Try adjusting your filters',
  'search_ai.dashboard.error_title': 'Failed to load knowledge bases',
  'search_ai.dashboard.retry': 'Retry',
  'search_ai.dashboard.no_project_title': 'No project',
  'search_ai.dashboard.no_project_description': 'Select a project first',
  'search_ai.dashboard.time_just_now': 'just now',
  'search_ai.dashboard.time_minutes_ago': '1 minute ago',
  'search_ai.dashboard.time_hours_ago': '1 hour ago',
  'search_ai.dashboard.time_days_ago': '1 day ago',
  'pipelines.title': 'Pipelines',
  'pipelines.description': 'Build and run project pipelines.',
  'pipelines.search_placeholder': 'Search pipelines...',
  'pipelines.tab_builtin': 'Built-in',
  'pipelines.tab_custom': 'Custom',
  'pipelines.create_pipeline': 'Create Pipeline',
  'pipelines.empty_custom': 'No custom pipelines yet',
  'pipelines.empty_custom_description': 'Create a custom pipeline to get started.',
  'pipelines.no_matching_pipelines': 'No matching pipelines',
  'pipelines.try_adjusting_search': 'Try adjusting your search.',
};

vi.mock('next-intl', () => ({
  useTranslations: (namespace: string) => {
    const t = ((key: string) => translations[`${namespace}.${key}`] ?? `${namespace}.${key}`) as ((
      key: string,
    ) => string) & {
      rich: (key: string, values?: Record<string, (chunks: string) => unknown>) => unknown;
    };

    t.rich = (key: string, values?: Record<string, (chunks: string) => unknown>) => {
      const message = translations[`${namespace}.${key}`] ?? `${namespace}.${key}`;
      return values?.strong ? values.strong(message) : message;
    };

    return t;
  },
}));

vi.mock('sonner', () => ({
  toast: {
    success: (...args: unknown[]) => mockToastSuccess(...args),
    error: (...args: unknown[]) => mockToastError(...args),
  },
}));

vi.mock('../../lib/api-client', () => ({
  apiFetch: (...args: unknown[]) => mockApiFetch(...args),
}));

vi.mock('../../api/variable-namespaces', () => ({
  fetchVariableNamespaces: (...args: unknown[]) => mockFetchVariableNamespaces(...args),
}));

vi.mock('../../store/navigation-store', () => ({
  useNavigationStore: (selector?: (state: typeof mockNavigationStore) => unknown) =>
    selector ? selector(mockNavigationStore) : mockNavigationStore,
}));

vi.mock('../../store/project-store', () => ({
  useProjectStore: (selector?: (state: typeof mockProjectStore) => unknown) =>
    selector ? selector(mockProjectStore) : mockProjectStore,
}));

vi.mock('../../store/workflow-store', () => ({
  useWorkflowStore: () => ({
    setCurrentWorkflow: mockSetCurrentWorkflow,
  }),
}));

vi.mock('../../hooks/useWorkflows', () => ({
  useWorkflows: (...args: unknown[]) => mockUseWorkflows(...args),
}));

vi.mock('../../hooks/useKnowledgeBases', () => ({
  useKnowledgeBases: (...args: unknown[]) => mockUseKnowledgeBases(...args),
}));

vi.mock('swr', () => ({
  default: (...args: unknown[]) => mockUseSWR(...args),
}));

vi.mock('../../store/pipeline-list-store', () => ({
  usePipelineListStore: (selector?: (state: typeof mockPipelineListStore) => unknown) =>
    selector ? selector(mockPipelineListStore) : mockPipelineListStore,
}));

vi.mock('../../store/mcp-server-store', () => ({
  useMcpServerStore: (selector?: (state: typeof mockMcpServerStore) => unknown) =>
    selector ? selector(mockMcpServerStore) : mockMcpServerStore,
}));

vi.mock('../../api/mcp-servers', () => ({
  fetchMcpServers: (...args: unknown[]) => mockFetchMcpServers(...args),
}));

vi.mock('../../components/workflows/CreateWorkflowModal', () => ({
  CreateWorkflowModal: () => null,
}));

vi.mock('../../components/search-ai/CreateKnowledgeBaseDialog', () => ({
  CreateKnowledgeBaseDialog: () => null,
}));

vi.mock('../../components/variables/VariableNamespaceDropdown', () => ({
  VariableNamespaceDropdown: () => null,
}));

vi.mock('../../components/variables/VariableNamespaceTagPopover', () => ({
  VariableNamespaceTagPopover: () => null,
}));

vi.mock('../../components/variables/ManageVariableNamespacesPanel', () => ({
  ManageVariableNamespacesPanel: () => null,
}));

vi.mock('../../components/mcp-servers/McpServerCreateDialog', () => ({
  McpServerCreateDialog: () => null,
}));

import { ApiKeysTab } from '../../components/settings/ApiKeysTab';
import { ConfigVariablesTab } from '../../components/settings/ConfigVariablesTab';
import { McpServersListPage } from '../../components/mcp-servers/McpServersListPage';
import { PipelinesListPage } from '../../components/pipelines/PipelinesListPage';
import { KnowledgeBaseDashboardPage } from '../../components/search-ai/KnowledgeBaseDashboardPage';
import { useModuleStore } from '../../store/module-store';
import { WorkflowsListPage } from '../../components/workflows/WorkflowsListPage';

function jsonResponse(body: unknown) {
  return {
    json: async () => body,
  };
}

const localWorkflow: WorkflowSummary = {
  id: 'workflow-local',
  name: 'Local Workflow',
  description: 'Owned by the consumer project',
  status: 'active',
  triggerType: 'manual',
  stepCount: 3,
  lastRunAt: null,
  createdAt: '2026-04-01T08:00:00.000Z',
  updatedAt: '2026-04-01T10:00:00.000Z',
};

const localKnowledgeBase: KnowledgeBase = {
  _id: 'kb-local',
  tenantId: 'tenant-1',
  projectId: 'proj-1',
  name: 'Local Knowledge Base',
  description: 'Owned by the consumer project',
  status: 'ready',
  searchIndexId: 'search-index-local',
  canonicalSchemaId: 'schema-local',
  connectorCount: 2,
  documentCount: 12,
  lastIndexedAt: null,
  indexError: null,
  isPublic: false,
  createdAt: '2026-04-01T08:00:00.000Z',
  updatedAt: '2026-04-01T10:00:00.000Z',
};

function seedModuleDependencyWithUnsupportedAssets() {
  // Cast unsupported asset keys into the snapshot so local-only pages stay pinned
  // even if module contracts evolve in the future.
  const contractSnapshot = {
    providedAgents: [{ name: 'claims_agent' }],
    providedTools: [{ name: 'lookup_claim' }],
    providedWorkflows: [{ name: 'Imported Module Workflow' }],
    providedKnowledgeBases: [{ name: 'Imported Module Knowledge Base' }],
  } as unknown as ModuleDependency['contractSnapshot'];

  useModuleStore.setState({
    dependencies: [
      {
        id: 'dep-claims',
        alias: 'claims',
        moduleProjectId: 'module-claims',
        moduleProjectName: 'Claims Module',
        selector: { type: 'version', value: '1.2.3' },
        resolvedReleaseId: 'rel-claims-1',
        resolvedVersion: '1.2.3',
        configOverrides: {},
        contractSnapshot,
        createdAt: '2026-04-15T00:00:00.000Z',
        createdBy: 'user-1',
      },
    ],
  });
}

describe('empty-state header action regressions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useModuleStore.getState().reset();

    mockUseWorkflows.mockReturnValue({
      workflows: [],
      isLoading: false,
      error: null,
      refresh: vi.fn(),
    });

    mockUseKnowledgeBases.mockReturnValue({
      knowledgeBases: [],
      aggregateDocStats: { totalDocuments: 0, failedDocuments: 0 },
      total: 0,
      isLoading: false,
      error: null,
      refresh: vi.fn(),
    });

    mockUseSWR.mockReturnValue({
      data: { pipelines: [] },
      error: null,
      isLoading: false,
      mutate: vi.fn(),
    });

    mockFetchMcpServers.mockResolvedValue({ servers: [] });

    mockFetchVariableNamespaces.mockResolvedValue({
      success: true,
      namespaces: [],
    });
  });

  afterEach(() => {
    useModuleStore.getState().reset();
  });

  it('keeps only one Create Key button when API Keys is empty', async () => {
    mockApiFetch.mockResolvedValue(jsonResponse({ keys: [] }));

    render(<ApiKeysTab />);

    await waitFor(() => {
      expect(screen.getByText('No API keys yet')).toBeInTheDocument();
    });

    expect(screen.getAllByRole('button', { name: /Create Key$/ })).toHaveLength(1);
  });

  it('keeps only one Add Variable button when Config Variables is empty', async () => {
    mockApiFetch.mockResolvedValue(jsonResponse({ variables: [] }));

    render(<ConfigVariablesTab />);

    await waitFor(() => {
      expect(screen.getByText('No config variables yet')).toBeInTheDocument();
    });

    expect(screen.getAllByRole('button', { name: /Add Variable$/ })).toHaveLength(1);
  });

  it('keeps only one New Workflow button when Workflows is empty', async () => {
    render(<WorkflowsListPage />);

    await waitFor(() => {
      expect(screen.getByText('No workflows yet')).toBeInTheDocument();
    });

    expect(screen.getAllByRole('button', { name: /New Workflow$/ })).toHaveLength(1);
  });

  it('keeps workflows local-only even when module dependency state is hydrated', async () => {
    seedModuleDependencyWithUnsupportedAssets();
    mockUseWorkflows.mockReturnValue({
      workflows: [localWorkflow],
      isLoading: false,
      error: null,
      refresh: vi.fn(),
    });

    render(<WorkflowsListPage />);

    await waitFor(() => {
      expect(screen.getByText('Local Workflow')).toBeInTheDocument();
    });
    expect(screen.queryByText('Imported Module Workflow')).not.toBeInTheDocument();
  });

  it('keeps only one New Knowledge Base button when Knowledge Bases is empty', async () => {
    render(<KnowledgeBaseDashboardPage />);

    await waitFor(() => {
      expect(screen.getByText('No knowledge bases')).toBeInTheDocument();
    });

    expect(screen.getAllByRole('button', { name: /New Knowledge Base$/ })).toHaveLength(1);
  });

  it('keeps knowledge bases local-only even when module dependency state is hydrated', async () => {
    seedModuleDependencyWithUnsupportedAssets();
    mockUseKnowledgeBases.mockReturnValue({
      knowledgeBases: [localKnowledgeBase],
      aggregateDocStats: { totalDocuments: 12, failedDocuments: 0 },
      total: 1,
      isLoading: false,
      error: null,
      refresh: vi.fn(),
    });

    render(<KnowledgeBaseDashboardPage />);

    await waitFor(() => {
      expect(screen.getByText('Local Knowledge Base')).toBeInTheDocument();
    });
    expect(screen.queryByText('Imported Module Knowledge Base')).not.toBeInTheDocument();
  });

  it('keeps only one Create Pipeline button when Custom Pipelines is empty', async () => {
    render(<PipelinesListPage />);

    await waitFor(() => {
      expect(screen.getByText('No custom pipelines yet')).toBeInTheDocument();
    });

    expect(screen.getAllByRole('button', { name: /Create Pipeline$/ })).toHaveLength(1);
  });

  it('keeps only one Register Server button when MCP Servers is empty', async () => {
    render(<McpServersListPage />);

    await waitFor(() => {
      expect(screen.getByText('No MCP servers yet')).toBeInTheDocument();
    });

    expect(screen.getAllByRole('button', { name: /Register Server$/ })).toHaveLength(1);
  });
});
