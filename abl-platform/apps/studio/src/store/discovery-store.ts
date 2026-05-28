/**
 * Discovery Store (Zustand)
 *
 * Tracks backgrounded discovery and crawl activities across component trees.
 * The activity bar (in KBDetailLayout) and CrawlFlowPanel (in AddSourceButton)
 * are in separate trees — prop-drilling is impossible.
 *
 * Session-scoped: on mount, the activity bar queries the sources API to restore.
 */

import { create } from 'zustand';
import type { BackgroundedDiscovery } from '../components/search-ai/crawl-flow/types';

/** Maximum backgrounded items to retain. Server returns at most 20; this is a client-side safety cap. */
const MAX_BACKGROUNDED_ITEMS = 20;

interface DiscoveryStoreState {
  /** Backgrounded discovery/crawl items visible in the activity bar */
  backgroundedItems: BackgroundedDiscovery[];
  /** Source ID of the currently open panel (null if no panel open) */
  activePanelSourceId: string | null;

  /** Add a backgrounded item */
  addItem: (item: BackgroundedDiscovery) => void;
  /** Remove an item by sourceId */
  removeItem: (sourceId: string) => void;
  /** Update an existing item (partial merge) */
  updateItem: (sourceId: string, updates: Partial<BackgroundedDiscovery>) => void;
  /** Set the active panel source ID */
  setActivePanelSource: (sourceId: string | null) => void;
  /** Replace all items (used for initial hydration from API) */
  setItems: (items: BackgroundedDiscovery[]) => void;
}

export const useDiscoveryStore = create<DiscoveryStoreState>((set) => ({
  backgroundedItems: [],
  activePanelSourceId: null,

  addItem: (item) =>
    set((state) => {
      // Avoid duplicates
      if (state.backgroundedItems.some((i) => i.sourceId === item.sourceId)) {
        return state;
      }
      const next = [...state.backgroundedItems, item];
      // Evict oldest completed/stopped items if over cap
      if (next.length > MAX_BACKGROUNDED_ITEMS) {
        const evictIdx = next.findIndex((i) => i.status === 'complete' || i.status === 'stopped');
        if (evictIdx >= 0) next.splice(evictIdx, 1);
        else next.shift(); // drop oldest if all running
      }
      return { backgroundedItems: next };
    }),

  removeItem: (sourceId) =>
    set((state) => ({
      backgroundedItems: state.backgroundedItems.filter((i) => i.sourceId !== sourceId),
    })),

  updateItem: (sourceId, updates) =>
    set((state) => ({
      backgroundedItems: state.backgroundedItems.map((i) =>
        i.sourceId === sourceId ? { ...i, ...updates } : i,
      ),
    })),

  setActivePanelSource: (sourceId) => set({ activePanelSourceId: sourceId }),

  setItems: (items) => set({ backgroundedItems: items }),
}));
