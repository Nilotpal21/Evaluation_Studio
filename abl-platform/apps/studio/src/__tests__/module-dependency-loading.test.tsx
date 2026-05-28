/**
 * Module Dependency Loading Tests
 *
 * @vitest-environment happy-dom
 */

import React, { useEffect } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';

const mockListDependencies = vi.fn();

vi.mock('../api/modules', () => ({
  listCatalog: vi.fn(),
  listDependencies: (...args: unknown[]) => mockListDependencies(...args),
  listReleases: vi.fn(),
  publishRelease: vi.fn(),
  confirmImport: vi.fn(),
  removeDependency: vi.fn(),
}));

import { useModuleStore } from '../store/module-store';
import { useImportedSymbols } from '../hooks/useImportedSymbols';

function SymbolsProbe() {
  const symbols = useImportedSymbols();

  return <pre data-testid="symbols">{JSON.stringify(symbols)}</pre>;
}

function DependencyBootstrap({ projectId }: { projectId: string }) {
  const loadDependencies = useModuleStore((s) => s.loadDependencies);

  useEffect(() => {
    void loadDependencies(projectId);
  }, [projectId, loadDependencies]);

  return <SymbolsProbe />;
}

describe('module dependency loading', () => {
  const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

  beforeEach(() => {
    vi.clearAllMocks();
    useModuleStore.getState().reset();
  });

  afterEach(() => {
    useModuleStore.getState().reset();
  });

  it('populates the store and useImportedSymbols from loadDependencies', async () => {
    mockListDependencies.mockResolvedValue({
      success: true,
      data: [
        {
          id: 'dep-1',
          alias: 'idv',
          moduleProjectId: 'mod-1',
          moduleProjectName: 'Identity Module',
          selector: { type: 'version', value: '1.0.0' },
          resolvedReleaseId: 'rel-1',
          resolvedVersion: '1.0.0',
          configOverrides: {},
          contractSnapshot: {
            providedAgents: [{ name: 'verify_identity' }],
            providedTools: [{ name: 'check_id' }],
          },
          createdAt: '2026-04-15T00:00:00.000Z',
          createdBy: 'user-1',
        },
      ],
    });

    await useModuleStore.getState().loadDependencies('proj-1');

    expect(useModuleStore.getState().dependencies).toHaveLength(1);

    render(<SymbolsProbe />);

    const symbols = JSON.parse(screen.getByTestId('symbols').textContent ?? '{}');
    expect(symbols.hasDependencies).toBe(true);
    expect(symbols.agents).toEqual([
      {
        name: 'verify_identity',
        alias: 'idv',
        moduleProjectName: 'Identity Module',
        dependencyId: 'dep-1',
        resolvedVersion: '1.0.0',
      },
    ]);
    expect(symbols.tools).toEqual([
      {
        name: 'check_id',
        alias: 'idv',
        moduleProjectName: 'Identity Module',
        dependencyId: 'dep-1',
        resolvedVersion: '1.0.0',
      },
    ]);
  });

  it('degrades gracefully when loadDependencies fails', async () => {
    mockListDependencies.mockRejectedValue(new Error('Network error'));

    await useModuleStore.getState().loadDependencies('proj-1');

    expect(useModuleStore.getState().dependencies).toEqual([]);
    expect(useModuleStore.getState().dependenciesLoading).toBe(false);

    render(<SymbolsProbe />);

    const symbols = JSON.parse(screen.getByTestId('symbols').textContent ?? '{}');
    expect(symbols).toEqual({
      agents: [],
      tools: [],
      hasDependencies: false,
    });
    expect(consoleErrorSpy).toHaveBeenCalled();
  });

  it('loads the latest project dependencies when the project context changes', async () => {
    mockListDependencies.mockImplementation(async (projectId: string) => {
      if (projectId === 'proj-A') {
        return {
          success: true,
          data: [
            {
              id: 'dep-alpha',
              alias: 'alpha',
              moduleProjectId: 'mod-alpha',
              moduleProjectName: 'Alpha Module',
              selector: { type: 'version', value: '1.0.0' },
              resolvedReleaseId: 'rel-alpha',
              resolvedVersion: '1.0.0',
              configOverrides: {},
              contractSnapshot: { providedAgents: [{ name: 'alpha_agent' }] },
              createdAt: '2026-04-15T00:00:00.000Z',
              createdBy: 'user-1',
            },
          ],
        };
      }

      return {
        success: true,
        data: [
          {
            id: 'dep-beta',
            alias: 'beta',
            moduleProjectId: 'mod-beta',
            moduleProjectName: 'Beta Module',
            selector: { type: 'version', value: '2.0.0' },
            resolvedReleaseId: 'rel-beta',
            resolvedVersion: '2.0.0',
            configOverrides: {},
            contractSnapshot: { providedAgents: [{ name: 'beta_agent' }] },
            createdAt: '2026-04-15T00:00:00.000Z',
            createdBy: 'user-1',
          },
        ],
      };
    });

    const { rerender } = render(<DependencyBootstrap projectId="proj-A" />);

    await waitFor(() => {
      const symbols = JSON.parse(screen.getByTestId('symbols').textContent ?? '{}');
      expect(symbols.agents[0].alias).toBe('alpha');
    });

    rerender(<DependencyBootstrap projectId="proj-B" />);

    await waitFor(() => {
      const symbols = JSON.parse(screen.getByTestId('symbols').textContent ?? '{}');
      expect(symbols.agents[0].alias).toBe('beta');
      expect(symbols.agents[0].name).toBe('beta_agent');
    });
  });
});
