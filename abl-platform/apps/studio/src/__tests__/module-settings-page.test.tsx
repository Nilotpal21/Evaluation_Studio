/**
 * ModuleSettingsPage Tests
 *
 * @vitest-environment happy-dom
 */

import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { PageHeaderProvider, usePageHeaderState } from '../contexts/PageHeaderContext';

const mockNavigationState = vi.hoisted(() => ({
  projectId: 'proj-1',
}));

const mockModuleStoreState = vi.hoisted(() => ({
  releases: [
    {
      id: 'rel-1',
      version: '1.0.0',
      releaseNotes: 'Initial release',
      contract: null,
      sourceHash: 'hash-1',
      createdBy: 'user-1',
      createdAt: '2026-04-15T00:00:00.000Z',
      archivedAt: null,
    },
  ],
  releasesLoading: false,
  setPublishDialogOpen: vi.fn(),
  loadReleases: vi.fn(),
}));

vi.mock('../store/navigation-store', () => ({
  useNavigationStore: Object.assign(
    vi.fn((selector?: (state: typeof mockNavigationState) => unknown) =>
      selector ? selector(mockNavigationState) : mockNavigationState,
    ),
    {
      getState: () => mockNavigationState,
      setState: vi.fn(),
      subscribe: vi.fn(),
    },
  ),
}));

vi.mock('../store/module-store', () => ({
  useModuleStore: vi.fn((selector?: (state: typeof mockModuleStoreState) => unknown) =>
    selector ? selector(mockModuleStoreState) : mockModuleStoreState,
  ),
}));

vi.mock('../components/modules/ModuleSettingsPanel', () => ({
  ModuleSettingsPanel: () => <div data-testid="module-settings-panel" />,
}));

vi.mock('../components/modules/PublishModuleDialog', () => ({
  PublishModuleDialog: ({ projectId }: { projectId: string }) => (
    <div data-testid="publish-module-dialog">{projectId}</div>
  ),
}));

vi.mock('../components/modules/ArchiveReleaseButton', () => ({
  ArchiveReleaseButton: ({ version }: { version: string }) => (
    <button type="button">{`archive-${version}`}</button>
  ),
}));

import { ModuleSettingsPage } from '../components/modules/ModuleSettingsPage';

function HeaderActionsProbe() {
  const { actions } = usePageHeaderState();
  return <div data-testid="header-actions">{actions}</div>;
}

function renderPage() {
  return render(
    <PageHeaderProvider>
      <HeaderActionsProbe />
      <ModuleSettingsPage />
    </PageHeaderProvider>,
  );
}

describe('ModuleSettingsPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockNavigationState.projectId = 'proj-1';
    mockModuleStoreState.releases = [
      {
        id: 'rel-1',
        version: '1.0.0',
        releaseNotes: 'Initial release',
        contract: null,
        sourceHash: 'hash-1',
        createdBy: 'user-1',
        createdAt: '2026-04-15T00:00:00.000Z',
        archivedAt: null,
      },
    ];
    mockModuleStoreState.releasesLoading = false;
  });

  it('renders the settings panel, release list, and publish dialog', () => {
    renderPage();

    expect(screen.getByTestId('module-settings-panel')).toBeInTheDocument();
    expect(screen.getByTestId('publish-module-dialog')).toHaveTextContent('proj-1');
    expect(screen.getByText('1.0.0')).toBeInTheDocument();
    expect(screen.getByText('archive-1.0.0')).toBeInTheDocument();
    expect(mockModuleStoreState.loadReleases).toHaveBeenCalledWith('proj-1');
  });

  it('opens the publish dialog via store action', async () => {
    const user = userEvent.setup();

    renderPage();

    await user.click(
      screen.getByRole('button', { name: /publish release|modules\.publish\.submit/i }),
    );

    expect(mockModuleStoreState.setPublishDialogOpen).toHaveBeenCalledWith(true);
  });
});
