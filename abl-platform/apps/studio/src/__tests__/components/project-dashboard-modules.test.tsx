/**
 * Module-Related UI Tests
 *
 * @vitest-environment happy-dom
 *
 * Tests for:
 * 1. ModuleSettingsPanel — feature gate (hasModules), enable/disable toggle, visibility
 * 2. Project store selectors — selectModuleProjects, selectApplicationProjects
 * 3. ProjectDashboard — renders module-kind projects from store
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

// =============================================================================
// MOCKS
// =============================================================================

// Mock sonner toast
const mockToast = vi.hoisted(() => ({
  success: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
}));
vi.mock('sonner', () => ({
  toast: mockToast,
  Toaster: () => null,
}));

// Mock useFeatures hook
const mockFeatures = vi.hoisted(() => ({
  hasModules: true,
  isLoading: false,
}));
vi.mock('../../hooks/use-features', () => ({
  useFeatures: () => mockFeatures,
}));

// Mock navigation store
const mockNavigationStore = vi.hoisted(() => ({
  projectId: 'proj-123',
  area: 'projects',
  page: 'settings',
  subPage: null,
  tab: null,
  breadcrumbs: [],
  navigate: vi.fn(),
}));
vi.mock('../../store/navigation-store', () => ({
  useNavigationStore: Object.assign(
    vi.fn((selector?: (s: typeof mockNavigationStore) => unknown) =>
      selector ? selector(mockNavigationStore) : mockNavigationStore,
    ),
    {
      getState: () => mockNavigationStore,
      setState: vi.fn(),
      subscribe: vi.fn(),
    },
  ),
}));

// Mock module API
const mockGetModuleSettings = vi.fn();
const mockEnableModule = vi.fn();
vi.mock('../../api/modules', () => ({
  getModuleSettings: (...args: unknown[]) => mockGetModuleSettings(...args),
  enableModule: (...args: unknown[]) => mockEnableModule(...args),
  listCatalog: vi.fn().mockResolvedValue({ data: [] }),
  listDependencies: vi.fn().mockResolvedValue({ data: [] }),
  listReleases: vi.fn().mockResolvedValue({ data: [] }),
  publishRelease: vi.fn().mockResolvedValue({}),
  confirmImport: vi.fn().mockResolvedValue({ data: {} }),
  removeDependency: vi.fn().mockResolvedValue({}),
}));

const mockLoadProjects = vi.hoisted(() => vi.fn().mockResolvedValue([]));

// Mock Select component (Radix-based, can hang in happy-dom)
vi.mock('../../components/ui/Select', () => ({
  Select: ({
    label,
    options,
    value,
    onChange,
    disabled,
  }: {
    label?: string;
    options: Array<{ value: string; label: string }>;
    value?: string;
    onChange?: (value: string) => void;
    disabled?: boolean;
  }) => (
    <div data-testid="select">
      {label && <label>{label}</label>}
      <select
        value={value}
        onChange={(e) => onChange?.(e.target.value)}
        disabled={disabled}
        data-testid="select-input"
      >
        {options.map((opt) => (
          <option key={opt.value} value={opt.value}>
            {opt.label}
          </option>
        ))}
      </select>
    </div>
  ),
}));

// Mock project store for dashboard tests
const mockProjectStore = vi.hoisted(() => ({
  projects: [] as Array<{
    id: string;
    name: string;
    slug: string;
    description?: string;
    createdAt: string;
    updatedAt: string;
    agentCount: number;
    sessionCount: number;
    kind: 'application' | 'module';
    moduleVisibility?: 'private' | 'tenant';
  }>,
  currentProjectId: null as string | null,
  currentProject: null,
  isLoading: false,
  error: null,
  moduleFilter: 'all' as 'all' | 'application' | 'module',
  setProjects: vi.fn(),
  setCurrentProject: vi.fn(),
  setCurrentProjectId: vi.fn(),
  addProject: vi.fn(),
  updateProject: vi.fn(),
  removeProject: vi.fn(),
  setLoading: vi.fn(),
  setError: vi.fn(),
  setModuleFilter: vi.fn(),
}));
vi.mock('../../store/project-store', () => ({
  useProjectStore: Object.assign(
    vi.fn((selector?: (s: typeof mockProjectStore) => unknown) =>
      selector ? selector(mockProjectStore) : mockProjectStore,
    ),
    {
      getState: () => mockProjectStore,
      setState: vi.fn(),
      subscribe: vi.fn(),
    },
  ),
  selectProjects: (state: typeof mockProjectStore) => state.projects,
  selectCurrentProject: (state: typeof mockProjectStore) => state.currentProject,
  selectIsLoading: (state: typeof mockProjectStore) => state.isLoading,
  selectModuleProjects: (state: typeof mockProjectStore) =>
    state.projects.filter((p) => p.kind === 'module'),
  selectApplicationProjects: (state: typeof mockProjectStore) =>
    state.projects.filter((p) => p.kind === 'application'),
}));

// Mock auth store (needed by ProjectDashboard)
const mockAuthStore = vi.hoisted(() => ({
  isAuthenticated: true,
  user: { id: 'user-1', email: 'test@example.com' },
  accessToken: 'token',
  tenantId: 'tenant-1',
  isLoading: false,
  setAuth: vi.fn(),
  clearAuth: vi.fn(),
  setLoading: vi.fn(),
  setTenantId: vi.fn(),
  setTokens: vi.fn(),
  setUser: vi.fn(),
}));
vi.mock('../../store/auth-store', () => ({
  useAuthStore: Object.assign(
    vi.fn((selector?: (s: typeof mockAuthStore) => unknown) =>
      selector ? selector(mockAuthStore) : mockAuthStore,
    ),
    {
      getState: () => mockAuthStore,
      setState: vi.fn(),
      subscribe: vi.fn(),
    },
  ),
}));

// Mock preferences store (needed by ProjectDashboard for pin functionality)
const mockPreferencesStore = vi.hoisted(() => ({
  pinnedProjectIds: [] as string[],
  isLoading: false,
  loadPreferences: vi.fn(),
  togglePin: vi.fn(),
  unpinProject: vi.fn(),
  reorderPins: vi.fn(),
  isPinned: vi.fn().mockReturnValue(false),
}));
vi.mock('../../store/preferences-store', () => ({
  usePreferencesStore: Object.assign(
    vi.fn((selector?: (s: typeof mockPreferencesStore) => unknown) =>
      selector ? selector(mockPreferencesStore) : mockPreferencesStore,
    ),
    {
      getState: () => mockPreferencesStore,
      setState: vi.fn(),
      subscribe: vi.fn(),
    },
  ),
}));

// Mock ArchBar — renders a simple search input for testing
vi.mock('../../components/projects/ArchBar', () => ({
  ArchBar: () => <div data-testid="arch-bar">Search</div>,
}));

// Mock PinnedProjectsRow — renders nothing
vi.mock('../../components/projects/PinnedProjectsRow', () => ({
  PinnedProjectsRow: () => null,
}));

// Mock getProjectColor
vi.mock('../../lib/project-colors', () => ({
  getProjectColor: () => ({ bg: 'bg-blue-100', text: 'text-blue-600' }),
}));

// Mock API functions (needed by ProjectDashboard)
vi.mock('../../api/projects', () => ({
  loadProjects: (...args: unknown[]) => mockLoadProjects(...args),
  createAndAddProject: vi.fn(),
  fetchProject: vi.fn(() => Promise.resolve({})),
}));

// Mock NewProjectDropdown
vi.mock('../../components/creation/NewProjectDropdown', () => ({
  NewProjectDropdown: ({
    onBlankProject,
  }: {
    onStartWithArch?: () => void;
    onBlankProject?: () => void;
    onFromTemplate?: () => void;
  }) => <button onClick={onBlankProject}>New Project</button>,
}));

// =============================================================================
// IMPORTS (after mocks)
// =============================================================================

import { ModuleSettingsPanel } from '../../components/modules/ModuleSettingsPanel';
import { ProjectDashboard } from '../../components/projects/ProjectDashboard';
import { selectModuleProjects, selectApplicationProjects } from '../../store/project-store';

// =============================================================================
// TEST DATA
// =============================================================================

const moduleProject = {
  id: 'proj-mod-1',
  name: 'Helpdesk Module',
  slug: 'helpdesk-module',
  description: 'Reusable helpdesk agents',
  createdAt: '2026-03-01T00:00:00Z',
  updatedAt: '2026-03-20T00:00:00Z',
  agentCount: 3,
  sessionCount: 0,
  kind: 'module' as const,
  moduleVisibility: 'tenant' as const,
};

const appProject = {
  id: 'proj-app-1',
  name: 'Customer Support App',
  slug: 'customer-support',
  description: 'Main support application',
  createdAt: '2026-02-15T00:00:00Z',
  updatedAt: '2026-03-19T00:00:00Z',
  agentCount: 5,
  sessionCount: 42,
  kind: 'application' as const,
};

// =============================================================================
// TESTS — ModuleSettingsPanel
// =============================================================================

describe('ModuleSettingsPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFeatures.hasModules = true;
    mockFeatures.isLoading = false;
    mockNavigationStore.projectId = 'proj-123';
  });

  it('shows loading spinner while settings load', () => {
    mockGetModuleSettings.mockReturnValue(new Promise(() => {})); // never resolves
    render(<ModuleSettingsPanel />);
    // Loader icon rendered (real lucide SVG with class)
    expect(document.querySelector('.lucide-loader2')).toBeInTheDocument();
  });

  it('shows "Module Settings" title and enable toggle when loaded', async () => {
    mockGetModuleSettings.mockResolvedValue({
      data: { enabled: false, moduleVisibility: null },
    });

    render(<ModuleSettingsPanel />);

    await waitFor(() => {
      expect(screen.getByText('Module Settings')).toBeInTheDocument();
    });

    // Toggle shows "Enable as Reusable Module" label
    expect(screen.getByText('Enable as Reusable Module')).toBeInTheDocument();
  });

  it('disables toggle when hasModules feature flag is false', async () => {
    mockFeatures.hasModules = false;
    mockGetModuleSettings.mockResolvedValue({
      data: { enabled: false, moduleVisibility: null },
    });

    render(<ModuleSettingsPanel />);

    await waitFor(() => {
      expect(screen.getByText('Module Settings')).toBeInTheDocument();
    });

    // Feature disabled message
    expect(
      screen.getByText('Module features are not enabled for this tenant.'),
    ).toBeInTheDocument();

    // Toggle button should be disabled
    const toggleBtn = screen.getByRole('switch');
    expect(toggleBtn).toBeDisabled();
  });

  it('shows visibility select when module is enabled', async () => {
    mockGetModuleSettings.mockResolvedValue({
      data: { enabled: true, moduleVisibility: 'private' },
    });

    render(<ModuleSettingsPanel />);

    await waitFor(() => {
      expect(screen.getByText('Module Settings')).toBeInTheDocument();
    });

    // Toggle shows "Convert Back to Application" when enabled
    expect(screen.getByText('Convert Back to Application')).toBeInTheDocument();

    // Visibility select is shown
    expect(screen.getByText('Module Visibility')).toBeInTheDocument();
  });

  it('calls enableModule API when toggle is clicked', async () => {
    mockGetModuleSettings.mockResolvedValue({
      data: { enabled: false, moduleVisibility: null },
    });
    mockEnableModule.mockResolvedValue({ success: true, message: 'ok' });

    render(<ModuleSettingsPanel />);

    await waitFor(() => {
      expect(screen.getByText('Module Settings')).toBeInTheDocument();
    });

    // Click the toggle to enable
    const toggleBtn = screen.getByRole('switch');
    fireEvent.click(toggleBtn);

    await waitFor(() => {
      expect(mockEnableModule).toHaveBeenCalledWith('proj-123', {
        enabled: true,
        moduleVisibility: 'private',
      });
    });
  });
});

// =============================================================================
// TESTS — Project Store Selectors
// =============================================================================

describe('Project Store — Module Selectors', () => {
  it('selectModuleProjects filters to module-kind projects', () => {
    const state = {
      ...mockProjectStore,
      projects: [moduleProject, appProject],
    };
    const result = selectModuleProjects(state);
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('Helpdesk Module');
    expect(result[0].kind).toBe('module');
  });

  it('selectApplicationProjects filters to application-kind projects', () => {
    const state = {
      ...mockProjectStore,
      projects: [moduleProject, appProject],
    };
    const result = selectApplicationProjects(state);
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('Customer Support App');
    expect(result[0].kind).toBe('application');
  });

  it('returns empty array when no projects of that kind exist', () => {
    const state = {
      ...mockProjectStore,
      projects: [appProject],
    };
    expect(selectModuleProjects(state)).toHaveLength(0);
  });
});

// =============================================================================
// TESTS — ProjectDashboard with module projects
// =============================================================================

describe('ProjectDashboard — Module Projects', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuthStore.isAuthenticated = true;
    mockProjectStore.isLoading = false;
    mockProjectStore.projects = [];
  });

  it('renders both module and application projects in the grid', () => {
    mockProjectStore.projects = [moduleProject, appProject];

    render(<ProjectDashboard />);

    expect(screen.getByText('Helpdesk Module')).toBeInTheDocument();
    expect(screen.getByText('Customer Support App')).toBeInTheDocument();
  });

  it('navigates to project page when clicking a module project', () => {
    mockProjectStore.projects = [moduleProject];

    render(<ProjectDashboard />);

    fireEvent.click(screen.getByText('Helpdesk Module'));
    expect(mockNavigationStore.navigate).toHaveBeenCalledWith('/projects/proj-mod-1');
  });

  it('renders ArchBar search entry point for filtering projects', () => {
    mockProjectStore.projects = [moduleProject, appProject];

    render(<ProjectDashboard />);

    // ArchBar is rendered as the search entry point (cmdk command palette)
    expect(screen.getByTestId('arch-bar')).toBeInTheDocument();

    // Both projects remain visible in the grid (filtering is handled by ArchBar internally)
    expect(screen.getByText('Helpdesk Module')).toBeInTheDocument();
    expect(screen.getByText('Customer Support App')).toBeInTheDocument();
  });

  it('shows empty state when no projects exist', () => {
    mockProjectStore.projects = [];

    render(<ProjectDashboard />);

    // No project cards in the grid
    expect(screen.queryByText('Helpdesk Module')).not.toBeInTheDocument();
    expect(screen.queryByText('Customer Support App')).not.toBeInTheDocument();
  });

  it('refreshes projects when the dashboard is rendered after returning from a project', async () => {
    mockProjectStore.projects = [
      {
        ...appProject,
        id: 'proj-stale-count',
        name: 'Stale Count Project',
        agentCount: 0,
      },
    ];

    render(<ProjectDashboard />);

    await waitFor(() => {
      expect(mockLoadProjects).toHaveBeenCalledTimes(1);
    });
  });

  it('does not refresh projects when the dashboard is rendered unauthenticated', () => {
    mockAuthStore.isAuthenticated = false;
    mockProjectStore.projects = [
      {
        ...appProject,
        id: 'proj-stale-count',
        name: 'Stale Count Project',
        agentCount: 0,
      },
    ];

    render(<ProjectDashboard />);

    expect(mockLoadProjects).not.toHaveBeenCalled();
  });
});
