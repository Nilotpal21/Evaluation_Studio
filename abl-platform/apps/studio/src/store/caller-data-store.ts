/**
 * Caller Data Store
 *
 * localStorage-backed store for arbitrary key-value data sent with every
 * new debug chat session (load_agent.callerData). Not persisted to DB.
 */

import { create } from 'zustand';

const STORAGE_KEY = 'abl:caller-data';

interface CallerDataState {
  /** Key-value pairs sent as callerData on session creation */
  entries: Record<string, string>;
  /** Set a single entry */
  setEntry: (key: string, value: string) => void;
  /** Remove a single entry */
  removeEntry: (key: string) => void;
  /** Replace all entries */
  setAll: (entries: Record<string, string>) => void;
  /** Clear all entries */
  clear: () => void;
  /** Get entries as a plain object (for load_agent payload) */
  getCallerData: () => Record<string, unknown>;
  /** Whether there are any entries */
  hasEntries: () => boolean;
}

function loadFromStorage(): Record<string, string> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      // Ensure all values are strings
      const entries: Record<string, string> = {};
      for (const [k, v] of Object.entries(parsed)) {
        entries[k] = String(v);
      }
      return entries;
    }
  } catch {
    // Corrupt data — ignore
  }
  return {};
}

function saveToStorage(entries: Record<string, string>): void {
  try {
    if (Object.keys(entries).length === 0) {
      localStorage.removeItem(STORAGE_KEY);
    } else {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(entries));
    }
  } catch {
    // localStorage full or unavailable — ignore
  }
}

export const useCallerDataStore = create<CallerDataState>((set, get) => ({
  entries: loadFromStorage(),

  setEntry: (key, value) => {
    set((state) => {
      const entries = { ...state.entries, [key]: value };
      saveToStorage(entries);
      return { entries };
    });
  },

  removeEntry: (key) => {
    set((state) => {
      const entries = { ...state.entries };
      delete entries[key];
      saveToStorage(entries);
      return { entries };
    });
  },

  setAll: (entries) => {
    saveToStorage(entries);
    set({ entries });
  },

  clear: () => {
    saveToStorage({});
    set({ entries: {} });
  },

  getCallerData: () => {
    const entries = get().entries;
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(entries)) {
      // Try to parse JSON values (numbers, booleans, objects)
      try {
        result[k] = JSON.parse(v);
      } catch {
        result[k] = v;
      }
    }
    return result;
  },

  hasEntries: () => Object.keys(get().entries).length > 0,
}));
