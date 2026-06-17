'use client';

import { useEffect, useState } from 'react';
import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { apps } from '@/lib/mock-data/apps';
import { agentVersions } from '@/lib/mock-data/evaluation-studio';
import {
  defaultProjectId,
  getProjectById as getStaticProjectById,
  projectAppMap,
  projects,
  type Project,
} from '@/lib/mock-data/projects';

export interface CustomProjectContext {
  project: Project;
  sourceProjectId: string;
  selectedAgentId: string;
  environment: 'prod' | 'pre_prod';
  selectedVersionId?: string;
  duration?: string;
  sessionEvaluationEnabled: boolean;
  monitoringEnabled: boolean;
  lastLaunchedRunId?: string;
}

interface ProjectState {
  customProjects: Record<string, CustomProjectContext>;
  createProject: (input: {
    name: string;
    selectedAgentId: string;
    environment: 'prod' | 'pre_prod';
    selectedVersionId?: string;
    duration?: string;
  }) => string;
  startPreProdRun: (projectId: string, runId: string) => void;
  startProdRun: (projectId: string, runId: string) => void;
}

function slugify(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 36);
}

function fallbackTag(value: string) {
  return value.trim() || 'Custom Project';
}

function isPlaceholderProjectName(value: string) {
  return value.trim().toLowerCase() === 'x';
}

export const useProjectState = create<ProjectState>()(
  persist(
    (set) => ({
      customProjects: {},
      createProject: ({ name, selectedAgentId, environment, selectedVersionId, duration }) => {
        const sourceProjectId = projectAppMap[selectedAgentId] ?? defaultProjectId;
        const sourceProject = getStaticProjectById(sourceProjectId) ?? projects[0];
        const app = apps.find((item) => item.id === selectedAgentId);
        const selectedVersion = selectedVersionId
          ? agentVersions.find((version) => version.id === selectedVersionId)
          : undefined;
        const id = `proj_custom_${slugify(name) || 'workspace'}_${Date.now().toString(36)}`;
        const now = new Date().toISOString().slice(0, 10);

        const project: Project = {
          ...sourceProject,
          id,
          name: name.trim(),
          tag: fallbackTag(name),
          description:
            environment === 'pre_prod'
              ? `Autonomous pre-prod evaluation workspace for ${app?.name ?? 'the selected agent'}${selectedVersion ? ` on ${selectedVersion.label}` : ''}.`
              : `Production analysis workspace for ${app?.name ?? 'the selected agent'}${duration ? ` over ${duration}` : ''}.`,
          appCount: 1,
          sopCount: 0,
          createdAt: now,
        };

        set((state) => ({
          customProjects: {
            ...state.customProjects,
            [id]: {
              project,
              sourceProjectId,
              selectedAgentId,
              environment,
              selectedVersionId,
              duration,
              sessionEvaluationEnabled: environment === 'prod',
              monitoringEnabled: environment === 'prod',
              lastLaunchedRunId: undefined,
            },
          },
        }));

        return id;
      },
      startPreProdRun: (projectId, runId) =>
        set((state) => {
          const context = state.customProjects[projectId];
          if (!context || context.environment !== 'pre_prod') return state;
          return {
            customProjects: {
              ...state.customProjects,
              [projectId]: {
                ...context,
                sessionEvaluationEnabled: true,
                monitoringEnabled: true,
                lastLaunchedRunId: runId,
              },
            },
          };
        }),
      startProdRun: (projectId, runId) =>
        set((state) => {
          const context = state.customProjects[projectId];
          if (!context || context.environment !== 'prod') return state;
          return {
            customProjects: {
              ...state.customProjects,
              [projectId]: {
                ...context,
                sessionEvaluationEnabled: true,
                monitoringEnabled: true,
                lastLaunchedRunId: runId,
              },
            },
          };
        }),
    }),
    {
      name: 'studio-project-state',
      migrate: (persistedState: unknown) => {
        const state = persistedState as { customProjects?: Record<string, CustomProjectContext> } | undefined;
        if (!state?.customProjects) return persistedState as ProjectState;

        const cleanedProjects = Object.fromEntries(
          Object.entries(state.customProjects).filter(
            ([, context]) => !isPlaceholderProjectName(context.project.name),
          ),
        );

        return {
          ...state,
          customProjects: cleanedProjects,
        } as ProjectState;
      },
    },
  ),
);

export function useProjectStateHydrated() {
  const [hydrated, setHydrated] = useState(useProjectState.persist.hasHydrated());

  useEffect(() => {
    const unsubscribe = useProjectState.persist.onFinishHydration(() => setHydrated(true));
    setHydrated(useProjectState.persist.hasHydrated());
    return unsubscribe;
  }, []);

  return hydrated;
}

export function useAllProjects(): Project[] {
  const customProjects = useProjectState((state) => state.customProjects);
  return [
    ...projects,
    ...Object.values(customProjects)
      .filter((item) => !isPlaceholderProjectName(item.project.name))
      .map((item) => item.project),
  ];
}

export function useResolvedProject(projectId: string): Project | undefined {
  const customProject = useProjectState((state) => state.customProjects[projectId]?.project);
  return customProject ?? getStaticProjectById(projectId);
}

export function useProjectContext(projectId: string): CustomProjectContext | undefined {
  return useProjectState((state) => state.customProjects[projectId]);
}

export function useBackingProjectId(projectId: string): string {
  const sourceProjectId = useProjectState((state) => state.customProjects[projectId]?.sourceProjectId);
  return sourceProjectId ?? projectId;
}

export function useScopedProjectAppIds(projectId: string): string[] {
  const context = useProjectContext(projectId);
  if (context) return [context.selectedAgentId];
  return apps.filter((app) => projectAppMap[app.id] === projectId).map((app) => app.id);
}

export function useProjectNavAccess(projectId: string) {
  const context = useProjectContext(projectId);

  return {
    sessionEvaluationEnabled: context ? context.sessionEvaluationEnabled : true,
    monitoringEnabled: context ? context.monitoringEnabled : true,
  };
}
