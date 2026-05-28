/**
 * Workflow Store
 *
 * Manages workflow UI state with localStorage persistence.
 * Tracks current workflow selection and execution filter preferences.
 */

import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export type ExecutionFilter =
  | 'all'
  | 'running'
  | 'completed'
  | 'failed'
  | 'waiting_human'
  | 'waiting_approval'
  | 'waiting_callback'
  | 'cancelled'
  | 'rejected';

export type WorkflowViewMode = 'list' | 'grid';

interface WorkflowStore {
  // State
  currentWorkflowId: string | null;
  selectedStepId: string | null;
  contextExplorerOpen: boolean;
  executionFilter: ExecutionFilter;
  viewMode: WorkflowViewMode;

  // Actions
  setCurrentWorkflow: (id: string | null) => void;
  setSelectedStepId: (id: string | null) => void;
  setContextExplorerOpen: (open: boolean) => void;
  toggleContextExplorer: () => void;
  setExecutionFilter: (filter: ExecutionFilter) => void;
  setViewMode: (mode: WorkflowViewMode) => void;
  reset: () => void;
}

export const useWorkflowStore = create<WorkflowStore>()(
  persist(
    (set, get) => ({
      currentWorkflowId: null,
      selectedStepId: null,
      contextExplorerOpen: false,
      executionFilter: 'all',
      viewMode: 'list',

      setCurrentWorkflow: (id) => set({ currentWorkflowId: id }),
      setSelectedStepId: (id) => set({ selectedStepId: id }),
      setContextExplorerOpen: (open) => set({ contextExplorerOpen: open }),
      toggleContextExplorer: () => set({ contextExplorerOpen: !get().contextExplorerOpen }),
      setExecutionFilter: (filter) => set({ executionFilter: filter }),
      setViewMode: (mode) => set({ viewMode: mode }),
      reset: () =>
        set({
          currentWorkflowId: null,
          selectedStepId: null,
          contextExplorerOpen: false,
          executionFilter: 'all',
          viewMode: 'list',
        }),
    }),
    {
      name: 'kore-workflow-storage',
      partialize: (state) => ({
        currentWorkflowId: state.currentWorkflowId,
        executionFilter: state.executionFilter,
        viewMode: state.viewMode,
      }),
    },
  ),
);
