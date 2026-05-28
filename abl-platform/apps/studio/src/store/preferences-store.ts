/**
 * Preferences Store
 *
 * Manages user preferences such as pinned projects.
 *
 * Storage strategy:
 * - **localStorage** (Zustand persist) — instant offline cache, shown on page load
 * - **MongoDB** (via API) — source of truth, per-user-per-tenant
 *   Loaded async on app mount; overwrites localStorage.
 *   Saved back with debounce after preference changes.
 */

import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { fetchPreferences, updatePreferences } from '../api/preferences';
import {
  DEFAULT_INSIGHTS_ANALYTICS_FILTERS,
  normalizeInsightsAnalyticsFilters,
  type PersistedInsightsAnalyticsFilters,
  type SurfaceKey,
} from '../lib/preferences/insights-analytics-filters';

// =============================================================================
// CONSTANTS
// =============================================================================

/** Maximum number of pinned projects a user can have */
const MAX_PINNED = 20;

/** Debounce delay for saving preferences to server (ms) */
const SAVE_DEBOUNCE_MS = 2_000;

/** Persist version — bump when the persisted shape changes */
const PERSIST_VERSION = 1;

const DEFAULT_PENDING_SYNC = {
  pinnedProjectIds: false,
  filterSurfaces: [] as DirtyFilterSurface[],
};

// =============================================================================
// TYPES
// =============================================================================

interface DirtyFilterSurface {
  projectId: string;
  surfaceKey: SurfaceKey;
}

interface PendingSyncState {
  pinnedProjectIds: boolean;
  filterSurfaces: DirtyFilterSurface[];
}

interface PreferencesState {
  pinnedProjectIds: string[];
  insightsAnalyticsFilters: PersistedInsightsAnalyticsFilters;
  pendingSync: PendingSyncState;
  isLoading: boolean;
  hasAttemptedLoad: boolean;

  // Actions
  loadPreferences: () => Promise<void>;
  ensurePreferencesLoaded: () => Promise<void>;
  togglePin: (projectId: string) => void;
  unpinProject: (projectId: string) => void;
  reorderPins: (projectIds: string[]) => void;
  isPinned: (projectId: string) => boolean;
  setInsightsAnalyticsFilters: (
    next: PersistedInsightsAnalyticsFilters,
    dirtySurface?: DirtyFilterSurface,
  ) => void;
}

// =============================================================================
// SERVER SYNC (debounced save)
// =============================================================================

let _saveTimer: ReturnType<typeof setTimeout> | null = null;
let _loadPromise: Promise<void> | null = null;
let _localMutationVersion = 0;

function markLocalMutation(): number {
  _localMutationVersion += 1;
  return _localMutationVersion;
}

function addDirtyFilterSurface(
  dirtySurfaces: DirtyFilterSurface[],
  nextDirtySurface: DirtyFilterSurface,
): DirtyFilterSurface[] {
  if (
    dirtySurfaces.some(
      (dirtySurface) =>
        dirtySurface.projectId === nextDirtySurface.projectId &&
        dirtySurface.surfaceKey === nextDirtySurface.surfaceKey,
    )
  ) {
    return dirtySurfaces;
  }

  return [...dirtySurfaces, nextDirtySurface];
}

function mergeFiltersWithPendingLocalChanges(
  serverFilters: PersistedInsightsAnalyticsFilters,
  localFilters: PersistedInsightsAnalyticsFilters,
  dirtySurfaces: DirtyFilterSurface[],
): PersistedInsightsAnalyticsFilters {
  const normalizedServerFilters = normalizeInsightsAnalyticsFilters(serverFilters);
  const normalizedLocalFilters = normalizeInsightsAnalyticsFilters(localFilters);
  const nextByProject = { ...normalizedServerFilters.byProject };

  for (const dirtySurface of dirtySurfaces) {
    const localProjectState = normalizedLocalFilters.byProject[dirtySurface.projectId] ?? {};
    const nextProjectState = {
      ...(nextByProject[dirtySurface.projectId] ?? {}),
    } as Record<string, unknown>;
    const localSurfaceState = localProjectState[dirtySurface.surfaceKey];

    if (localSurfaceState !== undefined) {
      nextProjectState[dirtySurface.surfaceKey] = localSurfaceState;
    } else {
      delete nextProjectState[dirtySurface.surfaceKey];
    }

    if (Object.keys(nextProjectState).length === 0) {
      delete nextByProject[dirtySurface.projectId];
    } else {
      nextByProject[dirtySurface.projectId] = nextProjectState;
    }
  }

  return {
    version: 1,
    byProject: nextByProject,
  };
}

/**
 * Schedule a debounced save of pinned project IDs to the server.
 * Cancels any pending save and restarts the timer.
 */
function scheduleSave(
  setState: (partial: Partial<PreferencesState>) => void,
  getState: () => PreferencesState,
): void {
  if (_saveTimer) clearTimeout(_saveTimer);

  _saveTimer = setTimeout(() => {
    _saveTimer = null;
    const { pinnedProjectIds, insightsAnalyticsFilters } = getState();
    const saveVersion = _localMutationVersion;
    updatePreferences({ pinnedProjectIds, insightsAnalyticsFilters })
      .then((data) => {
        if (_localMutationVersion !== saveVersion) {
          return;
        }
        setState({
          pinnedProjectIds: data.pinnedProjectIds,
          insightsAnalyticsFilters: data.insightsAnalyticsFilters,
          pendingSync: DEFAULT_PENDING_SYNC,
        });
      })
      .catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        console.error('[Preferences Store] Failed to save preferences to server:', msg);
      });
  }, SAVE_DEBOUNCE_MS);
}

// =============================================================================
// STORE
// =============================================================================

export const usePreferencesStore = create<PreferencesState>()(
  persist(
    (set, get) => ({
      pinnedProjectIds: [],
      insightsAnalyticsFilters: DEFAULT_INSIGHTS_ANALYTICS_FILTERS,
      pendingSync: DEFAULT_PENDING_SYNC,
      isLoading: false,
      hasAttemptedLoad: false,

      loadPreferences: async () => {
        if (_loadPromise) {
          await _loadPromise;
          return;
        }

        set({ isLoading: true, hasAttemptedLoad: true });
        const loadVersion = _localMutationVersion;
        _loadPromise = fetchPreferences()
          .then((data) => {
            if (_localMutationVersion !== loadVersion) {
              set({ isLoading: false });
              return;
            }
            const currentState = get();
            const hasPendingFilterSync = currentState.pendingSync.filterSurfaces.length > 0;
            const hasPendingPinSync = currentState.pendingSync.pinnedProjectIds;

            set({
              pinnedProjectIds: hasPendingPinSync
                ? currentState.pinnedProjectIds
                : data.pinnedProjectIds,
              insightsAnalyticsFilters: hasPendingFilterSync
                ? mergeFiltersWithPendingLocalChanges(
                    data.insightsAnalyticsFilters,
                    currentState.insightsAnalyticsFilters,
                    currentState.pendingSync.filterSurfaces,
                  )
                : data.insightsAnalyticsFilters,
              pendingSync: currentState.pendingSync,
              isLoading: false,
            });

            if (hasPendingFilterSync || hasPendingPinSync) {
              scheduleSave(set, get);
            }
          })
          .catch((err: unknown) => {
            const msg = err instanceof Error ? err.message : String(err);
            console.error('[Preferences Store] Failed to load preferences from server:', msg);
            set({ isLoading: false });
            // Silently fall back to localStorage cache
          })
          .finally(() => {
            _loadPromise = null;
          });

        await _loadPromise;
      },

      ensurePreferencesLoaded: async () => {
        if (get().hasAttemptedLoad) return;
        await get().loadPreferences();
      },

      togglePin: (projectId: string) => {
        const { pinnedProjectIds } = get();
        const index = pinnedProjectIds.indexOf(projectId);

        if (index >= 0) {
          // Unpin
          set((state) => ({
            pinnedProjectIds: pinnedProjectIds.filter((id) => id !== projectId),
            pendingSync: { ...state.pendingSync, pinnedProjectIds: true },
          }));
        } else {
          // Pin — enforce max limit
          if (pinnedProjectIds.length >= MAX_PINNED) return;
          set((state) => ({
            pinnedProjectIds: [projectId, ...pinnedProjectIds],
            pendingSync: { ...state.pendingSync, pinnedProjectIds: true },
          }));
        }
        markLocalMutation();
        scheduleSave(set, get);
      },

      unpinProject: (projectId: string) => {
        const { pinnedProjectIds } = get();
        if (!pinnedProjectIds.includes(projectId)) return;
        set((state) => ({
          pinnedProjectIds: pinnedProjectIds.filter((id) => id !== projectId),
          pendingSync: { ...state.pendingSync, pinnedProjectIds: true },
        }));
        markLocalMutation();
        scheduleSave(set, get);
      },

      reorderPins: (projectIds: string[]) => {
        set((state) => ({
          pinnedProjectIds: projectIds.slice(0, MAX_PINNED),
          pendingSync: { ...state.pendingSync, pinnedProjectIds: true },
        }));
        markLocalMutation();
        scheduleSave(set, get);
      },

      isPinned: (projectId: string) => {
        return get().pinnedProjectIds.includes(projectId);
      },

      setInsightsAnalyticsFilters: (next, dirtySurface) => {
        set((state) => ({
          insightsAnalyticsFilters: normalizeInsightsAnalyticsFilters(next),
          pendingSync: {
            ...state.pendingSync,
            filterSurfaces: dirtySurface
              ? addDirtyFilterSurface(state.pendingSync.filterSurfaces, dirtySurface)
              : state.pendingSync.filterSurfaces,
          },
        }));
        markLocalMutation();
        scheduleSave(set, get);
      },
    }),
    {
      name: 'kore-preferences-storage',
      version: PERSIST_VERSION,
      partialize: (state) => ({
        pinnedProjectIds: state.pinnedProjectIds,
        insightsAnalyticsFilters: state.insightsAnalyticsFilters,
        pendingSync: state.pendingSync,
      }),
    },
  ),
);

// =============================================================================
// SELECTORS
// =============================================================================

export const selectPinnedProjectIds = (state: PreferencesState) => state.pinnedProjectIds;
export const selectIsPreferencesLoading = (state: PreferencesState) => state.isLoading;
export const selectInsightsAnalyticsFilters = (state: PreferencesState) =>
  state.insightsAnalyticsFilters;
