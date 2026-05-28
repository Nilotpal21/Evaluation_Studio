import { useCallback, useEffect, useMemo } from 'react';
import { useNavigationStore } from '../store/navigation-store';
import { usePreferencesStore } from '../store/preferences-store';
import {
  getSurfaceState,
  resetSurfaceState,
  setSurfaceState,
  SURFACE_DESCRIPTORS,
  type PageFilterChip,
  type SurfaceKey,
  type SurfaceStateMap,
} from '../lib/preferences/insights-analytics-filters';

interface UsePersistedSurfaceFiltersResult<K extends SurfaceKey> {
  projectId: string | null;
  state: SurfaceStateMap[K];
  setState: (nextState: SurfaceStateMap[K]) => void;
  updateState: (patch: Partial<SurfaceStateMap[K]>) => void;
  reset: () => void;
  nonDefaultCount: number;
  hasNonDefault: boolean;
  pageChips: PageFilterChip[];
  clearPageChip: (chipKey: string) => void;
}

export function usePersistedSurfaceFilters<K extends SurfaceKey>(
  surfaceKey: K,
  projectIdOverride?: string | null,
): UsePersistedSurfaceFiltersResult<K> {
  const navigationProjectId = useNavigationStore((state) => state.projectId);
  const projectId = projectIdOverride ?? navigationProjectId;
  const ensurePreferencesLoaded = usePreferencesStore((state) => state.ensurePreferencesLoaded);
  const insightsAnalyticsFilters = usePreferencesStore((state) => state.insightsAnalyticsFilters);
  const setInsightsAnalyticsFilters = usePreferencesStore(
    (state) => state.setInsightsAnalyticsFilters,
  );

  useEffect(() => {
    void ensurePreferencesLoaded();
  }, [ensurePreferencesLoaded]);

  const descriptor = SURFACE_DESCRIPTORS[surfaceKey];

  const state = useMemo(
    () => getSurfaceState(insightsAnalyticsFilters, projectId, surfaceKey),
    [insightsAnalyticsFilters, projectId, surfaceKey],
  );

  const getLatestFilters = useCallback(
    () => usePreferencesStore.getState().insightsAnalyticsFilters,
    [],
  );

  const setState = useCallback(
    (nextState: SurfaceStateMap[K]) => {
      if (!projectId) return;
      setInsightsAnalyticsFilters(
        setSurfaceState(getLatestFilters(), projectId, surfaceKey, nextState),
        { projectId, surfaceKey },
      );
    },
    [getLatestFilters, projectId, setInsightsAnalyticsFilters, surfaceKey],
  );

  const updateState = useCallback(
    (patch: Partial<SurfaceStateMap[K]>) => {
      if (!projectId) return;
      const latestFilters = getLatestFilters();
      const latestState = getSurfaceState(latestFilters, projectId, surfaceKey);
      setInsightsAnalyticsFilters(
        setSurfaceState(latestFilters, projectId, surfaceKey, {
          ...latestState,
          ...patch,
        } as SurfaceStateMap[K]),
        { projectId, surfaceKey },
      );
    },
    [getLatestFilters, projectId, setInsightsAnalyticsFilters, surfaceKey],
  );

  const reset = useCallback(() => {
    if (!projectId) return;
    setInsightsAnalyticsFilters(resetSurfaceState(getLatestFilters(), projectId, surfaceKey), {
      projectId,
      surfaceKey,
    });
  }, [getLatestFilters, projectId, setInsightsAnalyticsFilters, surfaceKey]);

  const clearPageChip = useCallback(
    (chipKey: string) => {
      if (!projectId) return;
      const latestFilters = getLatestFilters();
      const latestState = getSurfaceState(latestFilters, projectId, surfaceKey);
      setInsightsAnalyticsFilters(
        setSurfaceState(
          latestFilters,
          projectId,
          surfaceKey,
          descriptor.clearPageChip(latestState, chipKey),
        ),
        { projectId, surfaceKey },
      );
    },
    [descriptor, getLatestFilters, projectId, setInsightsAnalyticsFilters, surfaceKey],
  );

  return {
    projectId,
    state,
    setState,
    updateState,
    reset,
    nonDefaultCount: descriptor.countNonDefault(state),
    hasNonDefault: descriptor.countNonDefault(state) > 0,
    pageChips: descriptor.getPageChips(state),
    clearPageChip,
  };
}
