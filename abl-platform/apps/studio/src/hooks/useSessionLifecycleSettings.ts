'use client';

import useSWR from 'swr';
import {
  DEFAULT_PROJECT_SESSION_LIFECYCLE_SETTINGS,
  getProjectSessionLifecycleSettings,
  patchProjectSessionLifecycleSettings,
  replaceProjectSessionLifecycleSettings,
  type ProjectSessionLifecyclePatch,
  type ProjectSessionLifecycleSettings,
} from '../api/session-lifecycle';
import { useNavigationStore } from '../store/navigation-store';

export function useSessionLifecycleSettings() {
  const { projectId } = useNavigationStore();

  const { data, error, isLoading, mutate } = useSWR(
    projectId ? ['session-lifecycle-settings', projectId] : null,
    async () => getProjectSessionLifecycleSettings(projectId!),
    { keepPreviousData: true },
  );

  const savePatch = async (patch: ProjectSessionLifecyclePatch) => {
    await patchProjectSessionLifecycleSettings(projectId!, patch);
    await mutate();
  };

  const replace = async (settings: ProjectSessionLifecycleSettings) => {
    await replaceProjectSessionLifecycleSettings(projectId!, settings);
    await mutate();
  };

  return {
    settings: data ?? DEFAULT_PROJECT_SESSION_LIFECYCLE_SETTINGS,
    isLoading,
    error: error ? String(error) : null,
    savePatch,
    replace,
    refresh: () => mutate(),
  };
}
