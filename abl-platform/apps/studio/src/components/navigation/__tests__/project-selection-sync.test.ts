import { describe, expect, it, vi } from 'vitest';

import { syncProjectSelectionFromNavigation } from '../project-selection-sync';

describe('syncProjectSelectionFromNavigation', () => {
  it('clears the selected project when navigation leaves project scope', () => {
    const setCurrentProjectId = vi.fn();
    const loadProjects = vi.fn();
    const projectRefetchedRef = { current: 'proj-1' };

    syncProjectSelectionFromNavigation({
      projectId: null,
      projectRefetchedRef,
      setCurrentProjectId,
      getProjectState: () => ({ currentProject: { id: 'proj-1' }, isLoading: false }),
      loadProjects,
    });

    expect(setCurrentProjectId).toHaveBeenCalledWith(null);
    expect(projectRefetchedRef.current).toBeNull();
    expect(loadProjects).not.toHaveBeenCalled();
  });

  it('refetches a missing project once for direct project navigation', () => {
    const setCurrentProjectId = vi.fn();
    const loadProjects = vi.fn();
    const projectRefetchedRef = { current: null as string | null };

    syncProjectSelectionFromNavigation({
      projectId: 'proj-1',
      projectRefetchedRef,
      setCurrentProjectId,
      getProjectState: () => ({ currentProject: null, isLoading: false }),
      loadProjects,
    });

    expect(setCurrentProjectId).toHaveBeenCalledWith('proj-1');
    expect(projectRefetchedRef.current).toBe('proj-1');
    expect(loadProjects).toHaveBeenCalledTimes(1);
  });

  it('does not refetch while project data is already loading', () => {
    const setCurrentProjectId = vi.fn();
    const loadProjects = vi.fn();
    const projectRefetchedRef = { current: null as string | null };

    syncProjectSelectionFromNavigation({
      projectId: 'proj-1',
      projectRefetchedRef,
      setCurrentProjectId,
      getProjectState: () => ({ currentProject: null, isLoading: true }),
      loadProjects,
    });

    expect(setCurrentProjectId).toHaveBeenCalledWith('proj-1');
    expect(projectRefetchedRef.current).toBeNull();
    expect(loadProjects).not.toHaveBeenCalled();
  });
});
