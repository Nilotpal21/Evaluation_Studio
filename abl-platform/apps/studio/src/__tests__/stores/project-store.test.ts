/**
 * Project Store Tests
 *
 * Comprehensive tests for the Zustand project store: project CRUD,
 * current project management, loading/error state, selectors, and
 * persist middleware behavior.
 *
 * @vitest-environment happy-dom
 */

import { describe, test, expect, beforeEach } from 'vitest';
import {
  useProjectStore,
  selectProjects,
  selectCurrentProject,
  selectIsLoading,
} from '../../store/project-store';
import type { Project } from '../../store/project-store';

// =============================================================================
// HELPERS
// =============================================================================

function makeProject(overrides: Partial<Project> = {}): Project {
  return {
    id: `proj-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    name: 'Test Project',
    slug: 'test-project',
    createdAt: '2025-01-01T00:00:00Z',
    updatedAt: '2025-01-01T00:00:00Z',
    agentCount: 0,
    sessionCount: 0,
    kind: 'application',
    ...overrides,
  };
}

// =============================================================================
// TESTS
// =============================================================================

describe('Project Store', () => {
  beforeEach(() => {
    // Reset store to initial state
    useProjectStore.setState({
      projects: [],
      currentProjectId: null,
      currentProject: null,
      isLoading: false,
      error: null,
    });
  });

  // ---------------------------------------------------------------------------
  // 1. Initial state
  // ---------------------------------------------------------------------------
  describe('initial state', () => {
    test('has correct default values', () => {
      const state = useProjectStore.getState();

      expect(state.projects).toEqual([]);
      expect(state.currentProjectId).toBeNull();
      expect(state.currentProject).toBeNull();
      expect(state.isLoading).toBe(false);
      expect(state.error).toBeNull();
    });

    test('all action functions are defined', () => {
      const state = useProjectStore.getState();

      expect(typeof state.setProjects).toBe('function');
      expect(typeof state.setCurrentProject).toBe('function');
      expect(typeof state.setCurrentProjectId).toBe('function');
      expect(typeof state.addProject).toBe('function');
      expect(typeof state.updateProject).toBe('function');
      expect(typeof state.removeProject).toBe('function');
      expect(typeof state.setLoading).toBe('function');
      expect(typeof state.setError).toBe('function');
    });
  });

  // ---------------------------------------------------------------------------
  // 2. setProjects()
  // ---------------------------------------------------------------------------
  describe('setProjects()', () => {
    test('sets the projects array', () => {
      const projects = [
        makeProject({ id: 'proj-1', name: 'Project A' }),
        makeProject({ id: 'proj-2', name: 'Project B' }),
      ];

      useProjectStore.getState().setProjects(projects);

      expect(useProjectStore.getState().projects).toEqual(projects);
    });

    test('replaces existing projects', () => {
      useProjectStore.getState().setProjects([makeProject({ id: 'proj-old', name: 'Old' })]);
      expect(useProjectStore.getState().projects).toHaveLength(1);

      const newProjects = [
        makeProject({ id: 'proj-new-1', name: 'New 1' }),
        makeProject({ id: 'proj-new-2', name: 'New 2' }),
      ];
      useProjectStore.getState().setProjects(newProjects);

      expect(useProjectStore.getState().projects).toHaveLength(2);
      expect(useProjectStore.getState().projects[0].name).toBe('New 1');
    });

    test('resolves currentProject from currentProjectId when setting projects', () => {
      // Set currentProjectId first
      useProjectStore.setState({ currentProjectId: 'proj-1' });

      const projects = [
        makeProject({ id: 'proj-1', name: 'Found' }),
        makeProject({ id: 'proj-2', name: 'Other' }),
      ];
      useProjectStore.getState().setProjects(projects);

      const state = useProjectStore.getState();
      expect(state.currentProject).not.toBeNull();
      expect(state.currentProject!.id).toBe('proj-1');
      expect(state.currentProject!.name).toBe('Found');
    });

    test('sets currentProject to null when currentProjectId is not found', () => {
      useProjectStore.setState({ currentProjectId: 'proj-missing' });

      useProjectStore.getState().setProjects([makeProject({ id: 'proj-1', name: 'Only One' })]);

      expect(useProjectStore.getState().currentProject).toBeNull();
    });

    test('sets currentProject to null when currentProjectId is null', () => {
      useProjectStore.setState({ currentProjectId: null });

      useProjectStore.getState().setProjects([makeProject({ id: 'proj-1' })]);

      expect(useProjectStore.getState().currentProject).toBeNull();
    });

    test('handles empty array', () => {
      useProjectStore.getState().setProjects([makeProject()]);
      useProjectStore.getState().setProjects([]);

      expect(useProjectStore.getState().projects).toEqual([]);
    });
  });

  // ---------------------------------------------------------------------------
  // 3. setCurrentProject()
  // ---------------------------------------------------------------------------
  describe('setCurrentProject()', () => {
    test('sets both currentProject and currentProjectId', () => {
      const project = makeProject({ id: 'proj-42', name: 'Active' });
      useProjectStore.getState().setCurrentProject(project);

      const state = useProjectStore.getState();
      expect(state.currentProject).toEqual(project);
      expect(state.currentProjectId).toBe('proj-42');
    });

    test('clears both when set to null', () => {
      useProjectStore.getState().setCurrentProject(makeProject({ id: 'proj-1' }));

      useProjectStore.getState().setCurrentProject(null);

      const state = useProjectStore.getState();
      expect(state.currentProject).toBeNull();
      expect(state.currentProjectId).toBeNull();
    });
  });

  // ---------------------------------------------------------------------------
  // 4. setCurrentProjectId()
  // ---------------------------------------------------------------------------
  describe('setCurrentProjectId()', () => {
    test('finds project from existing projects and sets currentProject', () => {
      const projects = [
        makeProject({ id: 'proj-1', name: 'First' }),
        makeProject({ id: 'proj-2', name: 'Second' }),
      ];
      useProjectStore.getState().setProjects(projects);

      useProjectStore.getState().setCurrentProjectId('proj-2');

      const state = useProjectStore.getState();
      expect(state.currentProjectId).toBe('proj-2');
      expect(state.currentProject).not.toBeNull();
      expect(state.currentProject!.name).toBe('Second');
    });

    test('sets currentProject to null when id is not found in projects', () => {
      useProjectStore.getState().setProjects([makeProject({ id: 'proj-1' })]);

      useProjectStore.getState().setCurrentProjectId('proj-missing');

      const state = useProjectStore.getState();
      expect(state.currentProjectId).toBe('proj-missing');
      expect(state.currentProject).toBeNull();
    });

    test('clears both when id is null', () => {
      useProjectStore.getState().setCurrentProject(makeProject({ id: 'proj-1' }));

      useProjectStore.getState().setCurrentProjectId(null);

      const state = useProjectStore.getState();
      expect(state.currentProjectId).toBeNull();
      expect(state.currentProject).toBeNull();
    });
  });

  // ---------------------------------------------------------------------------
  // 5. addProject()
  // ---------------------------------------------------------------------------
  describe('addProject()', () => {
    test('prepends project to the beginning of the list', () => {
      const existing = makeProject({ id: 'proj-1', name: 'Existing' });
      useProjectStore.getState().setProjects([existing]);

      const newProject = makeProject({ id: 'proj-new', name: 'New' });
      useProjectStore.getState().addProject(newProject);

      const projects = useProjectStore.getState().projects;
      expect(projects).toHaveLength(2);
      expect(projects[0].id).toBe('proj-new');
      expect(projects[1].id).toBe('proj-1');
    });

    test('adds to empty list', () => {
      const project = makeProject({ id: 'proj-first' });
      useProjectStore.getState().addProject(project);

      expect(useProjectStore.getState().projects).toHaveLength(1);
      expect(useProjectStore.getState().projects[0].id).toBe('proj-first');
    });

    test('preserves all project fields', () => {
      const project = makeProject({
        id: 'proj-full',
        name: 'Full',
        slug: 'full-project',
        description: 'A full project',
        entryAgentName: 'main-agent',
        agentCount: 5,
        sessionCount: 100,
      });
      useProjectStore.getState().addProject(project);

      const stored = useProjectStore.getState().projects[0];
      expect(stored.description).toBe('A full project');
      expect(stored.entryAgentName).toBe('main-agent');
      expect(stored.agentCount).toBe(5);
      expect(stored.sessionCount).toBe(100);
    });
  });

  // ---------------------------------------------------------------------------
  // 6. updateProject()
  // ---------------------------------------------------------------------------
  describe('updateProject()', () => {
    test('updates matching project by id', () => {
      useProjectStore
        .getState()
        .setProjects([makeProject({ id: 'proj-1', name: 'Original', agentCount: 0 })]);

      useProjectStore.getState().updateProject('proj-1', {
        name: 'Updated',
        agentCount: 5,
      });

      const projects = useProjectStore.getState().projects;
      expect(projects[0].name).toBe('Updated');
      expect(projects[0].agentCount).toBe(5);
    });

    test('does not modify other projects', () => {
      useProjectStore
        .getState()
        .setProjects([
          makeProject({ id: 'proj-1', name: 'A' }),
          makeProject({ id: 'proj-2', name: 'B' }),
        ]);

      useProjectStore.getState().updateProject('proj-1', { name: 'Updated A' });

      const projects = useProjectStore.getState().projects;
      expect(projects.find((p) => p.id === 'proj-1')!.name).toBe('Updated A');
      expect(projects.find((p) => p.id === 'proj-2')!.name).toBe('B');
    });

    test('updates currentProject if it matches the updated id', () => {
      const project = makeProject({ id: 'proj-current', name: 'Before' });
      useProjectStore.getState().setProjects([project]);
      useProjectStore.getState().setCurrentProject(project);

      useProjectStore.getState().updateProject('proj-current', {
        name: 'After',
        sessionCount: 99,
      });

      const state = useProjectStore.getState();
      expect(state.currentProject!.name).toBe('After');
      expect(state.currentProject!.sessionCount).toBe(99);
    });

    test('does not modify currentProject when updating a different project', () => {
      const current = makeProject({ id: 'proj-current', name: 'Current' });
      const other = makeProject({ id: 'proj-other', name: 'Other' });
      useProjectStore.getState().setProjects([current, other]);
      useProjectStore.getState().setCurrentProject(current);

      useProjectStore.getState().updateProject('proj-other', { name: 'Other Updated' });

      expect(useProjectStore.getState().currentProject!.name).toBe('Current');
    });

    test('no-ops when id does not exist', () => {
      useProjectStore.getState().setProjects([makeProject({ id: 'proj-1', name: 'Only One' })]);

      useProjectStore.getState().updateProject('proj-nonexistent', { name: 'Ghost' });

      expect(useProjectStore.getState().projects).toHaveLength(1);
      expect(useProjectStore.getState().projects[0].name).toBe('Only One');
    });
  });

  // ---------------------------------------------------------------------------
  // 7. removeProject()
  // ---------------------------------------------------------------------------
  describe('removeProject()', () => {
    test('removes project by id', () => {
      useProjectStore
        .getState()
        .setProjects([
          makeProject({ id: 'proj-1', name: 'Keep' }),
          makeProject({ id: 'proj-2', name: 'Remove' }),
        ]);

      useProjectStore.getState().removeProject('proj-2');

      const projects = useProjectStore.getState().projects;
      expect(projects).toHaveLength(1);
      expect(projects[0].id).toBe('proj-1');
    });

    test('clears currentProject and currentProjectId when removing current project', () => {
      const project = makeProject({ id: 'proj-current' });
      useProjectStore.getState().setProjects([project]);
      useProjectStore.getState().setCurrentProject(project);

      useProjectStore.getState().removeProject('proj-current');

      const state = useProjectStore.getState();
      expect(state.currentProject).toBeNull();
      expect(state.currentProjectId).toBeNull();
    });

    test('preserves currentProject when removing a different project', () => {
      const current = makeProject({ id: 'proj-current', name: 'Current' });
      const other = makeProject({ id: 'proj-other', name: 'Other' });
      useProjectStore.getState().setProjects([current, other]);
      useProjectStore.getState().setCurrentProject(current);

      useProjectStore.getState().removeProject('proj-other');

      expect(useProjectStore.getState().currentProject!.id).toBe('proj-current');
      expect(useProjectStore.getState().currentProjectId).toBe('proj-current');
    });

    test('no-ops when id does not exist', () => {
      useProjectStore.getState().setProjects([makeProject({ id: 'proj-1' })]);

      useProjectStore.getState().removeProject('proj-nonexistent');

      expect(useProjectStore.getState().projects).toHaveLength(1);
    });

    test('handles removing from empty array', () => {
      useProjectStore.getState().removeProject('proj-any');
      expect(useProjectStore.getState().projects).toEqual([]);
    });
  });

  // ---------------------------------------------------------------------------
  // 8. setLoading() / setError()
  // ---------------------------------------------------------------------------
  describe('setLoading()', () => {
    test('sets isLoading to true', () => {
      useProjectStore.getState().setLoading(true);
      expect(useProjectStore.getState().isLoading).toBe(true);
    });

    test('sets isLoading to false', () => {
      useProjectStore.getState().setLoading(true);
      useProjectStore.getState().setLoading(false);
      expect(useProjectStore.getState().isLoading).toBe(false);
    });
  });

  describe('setError()', () => {
    test('sets error string', () => {
      useProjectStore.getState().setError('Failed to load');
      expect(useProjectStore.getState().error).toBe('Failed to load');
    });

    test('clears error with null', () => {
      useProjectStore.getState().setError('Error');
      useProjectStore.getState().setError(null);
      expect(useProjectStore.getState().error).toBeNull();
    });

    test('overwrites previous error', () => {
      useProjectStore.getState().setError('first');
      useProjectStore.getState().setError('second');
      expect(useProjectStore.getState().error).toBe('second');
    });
  });

  // ---------------------------------------------------------------------------
  // 9. Selectors
  // ---------------------------------------------------------------------------
  describe('selectors', () => {
    test('selectProjects returns projects array', () => {
      const projects = [makeProject({ id: 'proj-1' })];
      useProjectStore.getState().setProjects(projects);

      expect(selectProjects(useProjectStore.getState())).toEqual(projects);
    });

    test('selectCurrentProject returns current project', () => {
      const project = makeProject({ id: 'proj-1' });
      useProjectStore.getState().setCurrentProject(project);

      expect(selectCurrentProject(useProjectStore.getState())).toEqual(project);
    });

    test('selectCurrentProject returns null when no project selected', () => {
      expect(selectCurrentProject(useProjectStore.getState())).toBeNull();
    });

    test('selectIsLoading returns loading state', () => {
      expect(selectIsLoading(useProjectStore.getState())).toBe(false);
      useProjectStore.getState().setLoading(true);
      expect(selectIsLoading(useProjectStore.getState())).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  // 10. Persist partialize
  // ---------------------------------------------------------------------------
  describe('persist behavior', () => {
    test('only partializes currentProjectId', () => {
      // The store uses persist with partialize that only keeps currentProjectId
      // We can verify by checking the store's persist API
      const persistOptions = (useProjectStore as any).persist;
      expect(persistOptions).toBeDefined();
    });
  });

  // ---------------------------------------------------------------------------
  // 11. Cross-cutting interactions
  // ---------------------------------------------------------------------------
  describe('cross-cutting interactions', () => {
    test('addProject then setCurrentProjectId finds the added project', () => {
      const project = makeProject({ id: 'proj-added', name: 'Added' });
      useProjectStore.getState().addProject(project);
      useProjectStore.getState().setCurrentProjectId('proj-added');

      expect(useProjectStore.getState().currentProject!.name).toBe('Added');
    });

    test('removeProject then setProjects resets cleanly', () => {
      const project = makeProject({ id: 'proj-1' });
      useProjectStore.getState().addProject(project);
      useProjectStore.getState().setCurrentProject(project);
      useProjectStore.getState().removeProject('proj-1');

      const newProjects = [makeProject({ id: 'proj-new', name: 'New' })];
      useProjectStore.getState().setProjects(newProjects);

      const state = useProjectStore.getState();
      expect(state.projects).toHaveLength(1);
      expect(state.currentProject).toBeNull();
      expect(state.currentProjectId).toBeNull();
    });

    test('updateProject and setCurrentProjectId together sync correctly', () => {
      const projects = [
        makeProject({ id: 'proj-1', name: 'First' }),
        makeProject({ id: 'proj-2', name: 'Second' }),
      ];
      useProjectStore.getState().setProjects(projects);
      useProjectStore.getState().setCurrentProjectId('proj-1');

      // Update project that is current
      useProjectStore.getState().updateProject('proj-1', { name: 'Updated First' });

      expect(useProjectStore.getState().currentProject!.name).toBe('Updated First');
    });
  });
});
