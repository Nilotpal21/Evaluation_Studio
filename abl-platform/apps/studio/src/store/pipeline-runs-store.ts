/**
 * Pipeline Runs Store
 *
 * Manages filter state and drawer selection for the Recent Runs panel.
 */

import { create } from 'zustand';

export type RunStatusFilter = 'all' | 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';
export type RunTypeFilter = 'all' | 'builtin' | 'custom';
export type RunTimeWindow = '1h' | '24h' | '7d';

interface RunsStoreState {
  typeFilter: RunTypeFilter;
  pipelineFilter: string | null;
  statusFilter: RunStatusFilter;
  timeWindow: RunTimeWindow;
  openRunId: string | null;

  setTypeFilter: (t: RunTypeFilter) => void;
  setPipelineFilter: (id: string | null) => void;
  setStatusFilter: (s: RunStatusFilter) => void;
  setTimeWindow: (w: RunTimeWindow) => void;
  openRun: (id: string) => void;
  closeRun: () => void;
}

export const useRunsStore = create<RunsStoreState>((set) => ({
  typeFilter: 'all',
  pipelineFilter: null,
  statusFilter: 'all',
  timeWindow: '24h',
  openRunId: null,

  setTypeFilter: (typeFilter) => set({ typeFilter }),
  setPipelineFilter: (pipelineFilter) => set({ pipelineFilter }),
  setStatusFilter: (statusFilter) => set({ statusFilter }),
  setTimeWindow: (timeWindow) => set({ timeWindow }),
  openRun: (openRunId) => set({ openRunId }),
  closeRun: () => set({ openRunId: null }),
}));
