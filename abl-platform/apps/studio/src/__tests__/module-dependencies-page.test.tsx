/**
 * ModuleDependenciesPage Tests
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
  importDialogOpen: false,
  setImportDialogOpen: vi.fn(),
  loadDependencies: vi.fn(),
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

vi.mock('../components/modules/ModuleDependencyList', () => ({
  ModuleDependencyList: ({ projectId }: { projectId: string }) => (
    <div data-testid="module-dependency-list">{projectId}</div>
  ),
}));

vi.mock('../components/modules/ImportModuleDialog', () => ({
  ImportModuleDialog: ({
    open,
    projectId,
  }: {
    open: boolean;
    onClose: () => void;
    projectId: string;
    onImported?: () => void;
  }) => <div data-testid="import-module-dialog">{`${projectId}:${String(open)}`}</div>,
}));

import { ModuleDependenciesPage } from '../components/modules/ModuleDependenciesPage';

function HeaderActionsProbe() {
  const { actions } = usePageHeaderState();
  return <div data-testid="header-actions">{actions}</div>;
}

function renderPage() {
  return render(
    <PageHeaderProvider>
      <HeaderActionsProbe />
      <ModuleDependenciesPage />
    </PageHeaderProvider>,
  );
}

describe('ModuleDependenciesPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockNavigationState.projectId = 'proj-1';
    mockModuleStoreState.importDialogOpen = false;
  });

  it('renders the dependency list and dialog with project scope', () => {
    renderPage();

    expect(screen.getByTestId('module-dependency-list')).toHaveTextContent('proj-1');
    expect(screen.getByTestId('import-module-dialog')).toHaveTextContent('proj-1:false');
  });

  it('opens the import dialog via store action', async () => {
    const user = userEvent.setup();

    renderPage();

    await user.click(screen.getByRole('button', { name: /import module|modules\.import\.title/i }));

    expect(mockModuleStoreState.setImportDialogOpen).toHaveBeenCalledWith(true);
  });
});
