/**
 * Module Studio Wiring Tests
 *
 * @vitest-environment happy-dom
 */

import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const mockNavigationState = vi.hoisted(() => ({
  area: 'project',
  page: 'overview',
  projectId: 'proj-1',
  subPage: null,
  tab: null,
  breadcrumbs: [],
  navigate: vi.fn(),
}));

const mockSettingsPageSegments = vi.hoisted(() => ({
  'settings-members': 'members',
  'settings-api-keys': 'api-keys',
  'settings-models': 'models',
  'settings-config-vars': 'config-vars',
  'settings-localization': 'localization',
  'settings-git': 'git',
  'settings-advanced': 'advanced',
  'settings-runtime-config': 'runtime-config',
  'settings-trace-dimensions': 'trace-dimensions',
  'settings-agent-transfer': 'agent-transfer',
  'settings-agent-assist': 'agent-assist',
  'settings-pii-protection': 'pii-protection',
  'settings-auth-profiles': 'auth-profiles',
  'settings-attachments': 'attachments',
  'settings-omnichannel': 'omnichannel',
  'settings-modules': 'modules',
}));

const mockProjectStore = vi.hoisted(() => ({
  projects: [
    {
      id: 'proj-1',
      name: 'Consumer Project',
      slug: 'consumer-project',
      createdAt: '2026-01-01',
      updatedAt: '2026-01-01',
      agentCount: 2,
      sessionCount: 3,
      kind: 'application' as const,
    },
  ],
  currentProject: {
    id: 'proj-1',
    name: 'Consumer Project',
    slug: 'consumer-project',
    createdAt: '2026-01-01',
    updatedAt: '2026-01-01',
    agentCount: 2,
    sessionCount: 3,
    kind: 'application' as const,
  },
}));

const mockFeatureState = vi.hoisted(() => ({
  hasGovernance: true,
}));

vi.mock('../store/navigation-store', () => ({
  SETTINGS_PAGE_SEGMENTS: mockSettingsPageSegments,
  useNavigationStore: Object.assign(
    vi.fn((selector?: (state: typeof mockNavigationState) => unknown) =>
      selector ? selector(mockNavigationState) : mockNavigationState,
    ),
    {
      getState: () => mockNavigationState,
      setState: (partial: Partial<typeof mockNavigationState>) =>
        Object.assign(mockNavigationState, partial),
      subscribe: vi.fn(),
    },
  ),
}));

vi.mock('../store/project-store', () => ({
  useProjectStore: Object.assign(
    vi.fn((selector?: (state: typeof mockProjectStore) => unknown) =>
      selector ? selector(mockProjectStore) : mockProjectStore,
    ),
    {
      getState: () => mockProjectStore,
      setState: vi.fn(),
      subscribe: vi.fn(),
    },
  ),
}));

vi.mock('../hooks/use-features', () => ({
  useFeatures: () => ({
    hasModules: true,
    hasCodeTools: true,
    hasGovernance: mockFeatureState.hasGovernance,
    isLoading: false,
  }),
}));

import { ProjectSidebar } from '../components/navigation/ProjectSidebar';
import { getAllNavItems } from '../config/navigation';

describe('Module Studio Wiring', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockNavigationState.area = 'project';
    mockNavigationState.page = 'overview';
    mockNavigationState.projectId = 'proj-1';
    mockNavigationState.subPage = null;
    mockNavigationState.tab = null;
    mockProjectStore.projects[0].kind = 'application';
    mockProjectStore.currentProject.kind = 'application';
    mockFeatureState.hasGovernance = true;
  });

  it('renders the Imported Modules settings entry and navigates to module-dependencies', async () => {
    const user = userEvent.setup();
    mockNavigationState.page = 'settings-members';

    render(<ProjectSidebar collapsed={false} onToggleCollapse={vi.fn()} />);

    await user.click(screen.getByRole('button', { name: /imported modules/i }));

    expect(mockNavigationState.navigate).toHaveBeenCalledWith(
      '/projects/proj-1/module-dependencies',
    );
  });

  it('renders the Modules settings entry inside the settings group and navigates to settings-modules', async () => {
    const user = userEvent.setup();
    mockNavigationState.page = 'settings-members';

    render(<ProjectSidebar collapsed={false} onToggleCollapse={vi.fn()} />);

    await user.click(screen.getByRole('button', { name: /module publishing/i }));

    expect(mockNavigationState.navigate).toHaveBeenCalledWith('/projects/proj-1/settings/modules');
  });

  it('renders the Localization settings entry inside the settings group and navigates to settings-localization', async () => {
    const user = userEvent.setup();
    mockNavigationState.page = 'settings-members';

    render(<ProjectSidebar collapsed={false} onToggleCollapse={vi.fn()} />);

    await user.click(screen.getByRole('button', { name: /localization/i }));

    expect(mockNavigationState.navigate).toHaveBeenCalledWith(
      '/projects/proj-1/settings/localization',
    );
  });

  it('exports module pages through navigation config for universal search', () => {
    const items = getAllNavItems();

    expect(items.some((item) => item.id === 'module-dependencies')).toBe(true);
    expect(items.some((item) => item.id === 'settings-modules')).toBe(true);
    expect(items.some((item) => item.id === 'settings-localization')).toBe(true);
  });

  it('hides temporarily disabled experiment navigation from sidebar and universal search', () => {
    render(<ProjectSidebar collapsed={false} onToggleCollapse={vi.fn()} />);

    expect(screen.queryByRole('button', { name: /experiments/i })).not.toBeInTheDocument();
    expect(getAllNavItems().some((item) => item.id === 'experiments')).toBe(false);
  });

  it('hides the Dependencies resource entry for module projects', () => {
    mockProjectStore.projects[0].kind = 'module';
    mockProjectStore.currentProject.kind = 'module';

    render(<ProjectSidebar collapsed={false} onToggleCollapse={vi.fn()} />);

    expect(screen.queryByRole('button', { name: /dependencies/i })).not.toBeInTheDocument();
  });

  it('hides the Governance entry when the governance feature is disabled', () => {
    mockFeatureState.hasGovernance = false;

    render(<ProjectSidebar collapsed={false} onToggleCollapse={vi.fn()} />);

    expect(screen.queryByRole('button', { name: /governance/i })).not.toBeInTheDocument();
  });

  it('exposes full labels for expanded sidebar items that may visually truncate', () => {
    render(<ProjectSidebar collapsed={false} onToggleCollapse={vi.fn()} />);

    expect(screen.getByRole('button', { name: /knowledge bases/i })).toHaveAttribute(
      'title',
      'Knowledge Bases',
    );
    expect(screen.getByRole('button', { name: /insights/i })).toHaveAttribute('title', 'Insights');
    expect(screen.getByLabelText('Switch project')).toHaveAttribute('title', 'Consumer Project');
  });
});
