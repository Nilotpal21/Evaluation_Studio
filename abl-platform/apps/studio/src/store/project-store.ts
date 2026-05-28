/**
 * Project Store
 *
 * Manages project state with Zustand.
 */

import { create } from 'zustand';
import { persist } from 'zustand/middleware';

// =============================================================================
// TYPES
// =============================================================================

export interface Project {
  id: string;
  name: string;
  slug: string;
  description?: string;
  entryAgentName?: string | null;
  createdAt: string;
  updatedAt: string;
  agentCount: number;
  sessionCount: number;
  kind: 'application' | 'module';
  moduleVisibility?: 'private' | 'tenant';
}

export interface ProjectAgent {
  id: string;
  projectId: string;
  name: string;
  agentPath: string;
  description?: string;
  createdAt: string;
  updatedAt: string;
}

interface ProjectState {
  projects: Project[];
  currentProjectId: string | null;
  currentProject: Project | null;
  isLoading: boolean;
  error: string | null;
  // True once the first live loadProjects() fetch completes in this session.
  // Not persisted — resets on every page load so stale localStorage data
  // is never mistaken for a confirmed fresh list.
  sessionLoaded: boolean;

  // Module filter
  moduleFilter: 'all' | 'application' | 'module';

  // Actions
  setProjects: (projects: Project[]) => void;
  setCurrentProject: (project: Project | null) => void;
  setCurrentProjectId: (id: string | null) => void;
  addProject: (project: Project) => void;
  updateProject: (id: string, updates: Partial<Project>) => void;
  removeProject: (id: string) => void;
  setLoading: (loading: boolean) => void;
  setError: (error: string | null) => void;
  setModuleFilter: (filter: 'all' | 'application' | 'module') => void;
}

// =============================================================================
// STORE
// =============================================================================

export const useProjectStore = create<ProjectState>()(
  persist(
    (set, get) => ({
      projects: [],
      currentProjectId: null,
      currentProject: null,
      isLoading: false,
      sessionLoaded: false,
      error: null,
      moduleFilter: 'all',

      setProjects: (projects) => {
        const { currentProjectId } = get();
        const currentProject = currentProjectId
          ? projects.find((p) => p.id === currentProjectId) || null
          : null;
        set({ projects, currentProject, sessionLoaded: true });
      },

      setCurrentProject: (project) =>
        set({
          currentProject: project,
          currentProjectId: project?.id || null,
        }),

      setCurrentProjectId: (id) => {
        const { projects } = get();
        const currentProject = id ? projects.find((p) => p.id === id) || null : null;
        set({ currentProjectId: id, currentProject });
      },

      addProject: (project) =>
        set((state) => ({
          projects: [project, ...state.projects.filter((p) => p.id !== project.id)],
        })),

      updateProject: (id, updates) =>
        set((state) => ({
          projects: state.projects.map((p) => (p.id === id ? { ...p, ...updates } : p)),
          currentProject:
            state.currentProject?.id === id
              ? { ...state.currentProject, ...updates }
              : state.currentProject,
        })),

      removeProject: (id) =>
        set((state) => ({
          projects: state.projects.filter((p) => p.id !== id),
          currentProject: state.currentProject?.id === id ? null : state.currentProject,
          currentProjectId: state.currentProjectId === id ? null : state.currentProjectId,
        })),

      setLoading: (isLoading) => set({ isLoading }),

      setError: (error) => set({ error }),

      setModuleFilter: (moduleFilter) => set({ moduleFilter }),
    }),
    {
      name: 'kore-project-storage',
      partialize: (state) => ({
        currentProjectId: state.currentProjectId,
      }),
    },
  ),
);

// =============================================================================
// SELECTORS
// =============================================================================

export const selectProjects = (state: ProjectState) => state.projects;
export const selectCurrentProject = (state: ProjectState) => state.currentProject;
export const selectIsLoading = (state: ProjectState) => state.isLoading;
export const selectModuleProjects = (state: ProjectState) =>
  state.projects.filter((p) => p.kind === 'module');
export const selectApplicationProjects = (state: ProjectState) =>
  state.projects.filter((p) => p.kind === 'application');
