/**
 * Pipeline List Store
 *
 * Manages UI state for the Pipelines list page:
 *   - Active tab (builtin vs custom)
 *   - Search query for filtering cards
 */

import { create } from 'zustand';

export type PipelineListTab = 'builtin' | 'custom' | 'runs' | 'data';

interface PipelineListState {
  /** Currently active tab */
  activeTab: PipelineListTab;

  /** Search filter applied to pipeline cards */
  searchQuery: string;

  /** Actions */
  setActiveTab: (tab: PipelineListTab) => void;
  setSearchQuery: (query: string) => void;
  reset: () => void;
}

export const usePipelineListStore = create<PipelineListState>((set) => ({
  activeTab: 'builtin',
  searchQuery: '',

  setActiveTab: (tab) => set({ activeTab: tab, searchQuery: '' }),
  setSearchQuery: (query) => set({ searchQuery: query }),
  reset: () => set({ activeTab: 'builtin', searchQuery: '' }),
}));
