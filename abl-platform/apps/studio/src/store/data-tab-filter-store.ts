import { create } from 'zustand';

export type DataView = 'documents' | 'chunks' | 'sources';

export interface PendingFilter {
  view?: DataView;
  sourceType?: string;
  statusFilter?: string;
  sourceId?: string;
  /** One-shot flag: auto-open the AddSource dialog on the Data tab */
  autoOpenAddSource?: boolean;
}

interface DataTabFilterState {
  pendingFilter: PendingFilter | null;
  setPendingFilter: (filter: PendingFilter) => void;
  consumeFilter: () => PendingFilter | null;
}

export const useDataTabFilterStore = create<DataTabFilterState>((set, get) => ({
  pendingFilter: null,
  setPendingFilter: (filter) => set({ pendingFilter: filter }),
  consumeFilter: () => {
    const current = get().pendingFilter;
    if (current) set({ pendingFilter: null });
    return current;
  },
}));
