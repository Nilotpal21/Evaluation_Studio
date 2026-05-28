/**
 * UI Store
 *
 * Manages UI state like panel visibility and selected tabs
 */

import { create } from 'zustand';

interface UIStore {
  // Session detail mode (split view: messages + traces)
  sessionDetailMode: boolean;

  // Actions
  setSessionDetailMode: (mode: boolean) => void;
}

export const useUIStore = create<UIStore>((set) => ({
  sessionDetailMode: false,

  setSessionDetailMode: (mode) => {
    set({ sessionDetailMode: mode });
  },
}));
