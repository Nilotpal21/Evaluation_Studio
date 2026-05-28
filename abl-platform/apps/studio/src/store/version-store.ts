/**
 * Version Store
 *
 * UI-only state for the version diff viewer.
 * Version data is now managed by SWR in useAgentVersions.
 */

import { create } from 'zustand';

interface VersionUIState {
  // Diff view state
  diffVersionA: string | null;
  diffVersionB: string | null;
  showDiff: boolean;

  // Actions
  setDiffVersions: (a: string | null, b: string | null) => void;
  setShowDiff: (show: boolean) => void;
  reset: () => void;
}

export const useVersionStore = create<VersionUIState>((set) => ({
  diffVersionA: null,
  diffVersionB: null,
  showDiff: false,

  setDiffVersions: (a, b) => set({ diffVersionA: a, diffVersionB: b }),
  setShowDiff: (showDiff) => set({ showDiff }),

  reset: () =>
    set({
      diffVersionA: null,
      diffVersionB: null,
      showDiff: false,
    }),
}));
