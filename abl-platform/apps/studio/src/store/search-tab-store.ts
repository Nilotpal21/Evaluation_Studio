/**
 * Search Tab Store
 *
 * Persists search state across tab switches so users don't lose context
 * when navigating between Data/Intelligence/Search tabs.
 *
 * Pattern: follows data-tab-filter-store.ts — simple Zustand store.
 */

import { create } from 'zustand';
import type { SearchAIResult } from '../api/search-ai';
import type { PipelineDebugTrace } from '../components/search-ai/search/debug-types';

interface SearchTabState {
  query: string;
  queryType: string;
  topK: string;
  debug: boolean;
  resolveMode: string;
  /** Skip multilingual preprocessing (spell correction, synonym expansion, entity extraction) */
  skipPreprocessing: boolean;

  /** Search results — persisted across tab switches */
  results: SearchAIResult[] | null;
  /** Debug trace from last search */
  debugTrace: PipelineDebugTrace | null;

  /** Whether auto-debug (triggered by search) is currently running */
  isAutoDebugging: boolean;
  /** Error from auto-debug call (non-blocking — search results unaffected) */
  autoDebugError: string | null;

  setQuery: (query: string) => void;
  setQueryType: (queryType: string) => void;
  setTopK: (topK: string) => void;
  setDebug: (debug: boolean) => void;
  setResolveMode: (resolveMode: string) => void;
  setSkipPreprocessing: (skipPreprocessing: boolean) => void;
  setResults: (results: SearchAIResult[] | null) => void;
  setDebugTrace: (trace: PipelineDebugTrace | null) => void;
  setIsAutoDebugging: (isAutoDebugging: boolean) => void;
  setAutoDebugError: (error: string | null) => void;

  /** Reset all state (e.g. when switching KB) */
  reset: () => void;
}

const INITIAL_STATE = {
  query: '',
  queryType: 'hybrid',
  topK: '10',
  debug: true,
  resolveMode: 'alias',
  skipPreprocessing: true,
  results: null as SearchAIResult[] | null,
  debugTrace: null as PipelineDebugTrace | null,
  isAutoDebugging: false,
  autoDebugError: null as string | null,
};

export const useSearchTabStore = create<SearchTabState>((set) => ({
  ...INITIAL_STATE,

  setQuery: (query) => set({ query }),
  setQueryType: (queryType) => set({ queryType }),
  setTopK: (topK) => set({ topK }),
  setDebug: (debug) => set({ debug }),
  setResolveMode: (resolveMode) => set({ resolveMode }),
  setSkipPreprocessing: (skipPreprocessing) => set({ skipPreprocessing }),
  setResults: (results) => set({ results }),
  setDebugTrace: (debugTrace) => set({ debugTrace }),
  setIsAutoDebugging: (isAutoDebugging) => set({ isAutoDebugging }),
  setAutoDebugError: (autoDebugError) => set({ autoDebugError }),

  reset: () => set(INITIAL_STATE),
}));
