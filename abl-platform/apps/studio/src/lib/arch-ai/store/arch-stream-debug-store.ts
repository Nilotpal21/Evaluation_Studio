import { create } from 'zustand';

export type ArchStreamLogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface ArchStreamDebugEntry {
  id: string;
  requestId: string;
  sessionId: string | null;
  direction: 'client' | 'server';
  type: string;
  level: ArchStreamLogLevel;
  timestamp: string;
  data: Record<string, unknown>;
}

declare global {
  interface Window {
    __archStreamDebug?: {
      clear: () => void;
      getEntries: () => ArchStreamDebugEntry[];
      isEnabled: () => boolean;
      setEnabled: (enabled: boolean) => void;
    };
  }
}

interface ArchStreamDebugState {
  enabled: boolean;
  entries: ArchStreamDebugEntry[];
  setEnabled: (enabled: boolean) => void;
  record: (entry: Omit<ArchStreamDebugEntry, 'id' | 'timestamp'>) => void;
  clear: () => void;
}

const MAX_DEBUG_ENTRIES = 400;
const DEFAULT_ENABLED =
  process.env.NODE_ENV === 'development' || process.env.NEXT_PUBLIC_ARCH_STREAM_DEBUG === 'true';

export const useArchStreamDebugStore = create<ArchStreamDebugState>((set) => ({
  enabled: DEFAULT_ENABLED,
  entries: [],

  setEnabled: (enabled) => set({ enabled }),

  record: (entry) =>
    set((state) => {
      if (!state.enabled) {
        return state;
      }

      const nextEntry: ArchStreamDebugEntry = {
        ...entry,
        id: crypto.randomUUID(),
        timestamp: new Date().toISOString(),
      };
      const nextEntries =
        state.entries.length >= MAX_DEBUG_ENTRIES
          ? [...state.entries.slice(-MAX_DEBUG_ENTRIES + 1), nextEntry]
          : [...state.entries, nextEntry];

      return { entries: nextEntries };
    }),

  clear: () => set({ entries: [] }),
}));

export function getArchStreamDebugSnapshot(): ArchStreamDebugEntry[] {
  return useArchStreamDebugStore.getState().entries;
}

function installArchStreamDebugBridge(): void {
  if (typeof window === 'undefined' || window.__archStreamDebug) {
    return;
  }

  window.__archStreamDebug = {
    clear: () => {
      useArchStreamDebugStore.getState().clear();
    },
    getEntries: () => getArchStreamDebugSnapshot(),
    isEnabled: () => useArchStreamDebugStore.getState().enabled,
    setEnabled: (enabled: boolean) => {
      useArchStreamDebugStore.getState().setEnabled(enabled);
    },
  };
}

installArchStreamDebugBridge();
