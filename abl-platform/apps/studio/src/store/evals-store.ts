/**
 * Evals Zustand Store
 *
 * Manages UI state for the evaluations page: active tab, selected run,
 * selected heat map cell, comparison pair, and production time range.
 */

import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export type EvalTab = 'personas' | 'scenarios' | 'evaluators' | 'eval-sets' | 'runs';

interface EvalsState {
  // Active tab
  activeTab: EvalTab;
  setActiveTab: (tab: EvalTab) => void;

  // Selected run for heat map
  selectedRunId: string | null;
  setSelectedRunId: (id: string | null) => void;

  // Selected heat map cell
  selectedCell: { personaId: string; scenarioId: string } | null;
  setSelectedCell: (cell: { personaId: string; scenarioId: string } | null) => void;

  // Run comparison
  compareBaselineId: string | null;
  compareCurrentId: string | null;
  setCompare: (baseline: string | null, current: string | null) => void;
}

export const useEvalsStore = create<EvalsState>()(
  persist(
    (set) => ({
      activeTab: 'runs',
      setActiveTab: (activeTab) => set({ activeTab }),

      selectedRunId: null,
      setSelectedRunId: (selectedRunId) => set({ selectedRunId, selectedCell: null }),

      selectedCell: null,
      setSelectedCell: (selectedCell) => set({ selectedCell }),

      compareBaselineId: null,
      compareCurrentId: null,
      setCompare: (compareBaselineId, compareCurrentId) =>
        set({ compareBaselineId, compareCurrentId }),
    }),
    {
      name: 'kore-evals-storage',
      partialize: (state) => ({
        activeTab: state.activeTab,
      }),
    },
  ),
);
