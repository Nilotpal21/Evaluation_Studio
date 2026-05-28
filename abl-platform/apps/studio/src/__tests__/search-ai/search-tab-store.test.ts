/**
 * Tests for search-tab-store — persistence across simulated unmount/remount.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { useSearchTabStore } from '../../store/search-tab-store';

describe('useSearchTabStore', () => {
  beforeEach(() => {
    // Reset store to defaults before each test
    useSearchTabStore.getState().reset();
  });

  it('has correct initial state', () => {
    const state = useSearchTabStore.getState();
    expect(state.query).toBe('');
    expect(state.queryType).toBe('hybrid');
    expect(state.topK).toBe('10');
    expect(state.debug).toBe(true);
    expect(state.resolveMode).toBe('alias');
  });

  it('persists query across simulated unmount/remount', () => {
    // Simulate: component sets query before unmount
    useSearchTabStore.getState().setQuery('test query');

    // Simulate: component remounts and reads from store
    const state = useSearchTabStore.getState();
    expect(state.query).toBe('test query');
  });

  it('persists all search parameters', () => {
    const store = useSearchTabStore.getState();
    store.setQuery('my query');
    store.setQueryType('vector');
    store.setTopK('20');
    store.setDebug(false);
    store.setResolveMode('fuzzy');

    // Simulated re-read after tab switch
    const state = useSearchTabStore.getState();
    expect(state.query).toBe('my query');
    expect(state.queryType).toBe('vector');
    expect(state.topK).toBe('20');
    expect(state.debug).toBe(false);
    expect(state.resolveMode).toBe('fuzzy');
  });

  it('reset restores defaults', () => {
    const store = useSearchTabStore.getState();
    store.setQuery('modified');
    store.setQueryType('structured');
    store.setTopK('5');
    store.setDebug(false);
    store.setResolveMode('exact');

    store.reset();

    const state = useSearchTabStore.getState();
    expect(state.query).toBe('');
    expect(state.queryType).toBe('hybrid');
    expect(state.topK).toBe('10');
    expect(state.debug).toBe(true);
    expect(state.resolveMode).toBe('alias');
  });

  it('individual setters do not affect other fields', () => {
    const store = useSearchTabStore.getState();
    store.setQuery('hello');
    store.setQueryType('vector');

    // Changing query should not reset queryType
    store.setQuery('world');
    expect(useSearchTabStore.getState().queryType).toBe('vector');
  });

  // ---------------------------------------------------------------------------
  // Results and debug trace fields
  // ---------------------------------------------------------------------------

  it('has null initial results and debugTrace', () => {
    const state = useSearchTabStore.getState();
    expect(state.results).toBeNull();
    expect(state.debugTrace).toBeNull();
  });

  it('setResults stores and retrieves results', () => {
    const mockResults = [{ id: 'r-1', score: 0.95, content: 'Test result' }] as any;
    useSearchTabStore.getState().setResults(mockResults);

    const state = useSearchTabStore.getState();
    expect(state.results).toEqual(mockResults);
    expect(state.results).toHaveLength(1);
  });

  it('setDebugTrace stores and retrieves debug trace', () => {
    const mockTrace = {
      queryId: 'q-1',
      stages: [{ name: 'embedding', durationMs: 42 }],
    } as any;
    useSearchTabStore.getState().setDebugTrace(mockTrace);

    const state = useSearchTabStore.getState();
    expect(state.debugTrace).toEqual(mockTrace);
  });

  it('reset clears results and debugTrace back to null', () => {
    const store = useSearchTabStore.getState();
    store.setResults([{ id: 'r-1', score: 0.9, content: 'test' }] as any);
    store.setDebugTrace({ queryId: 'q-1', stages: [] } as any);

    store.reset();

    const state = useSearchTabStore.getState();
    expect(state.results).toBeNull();
    expect(state.debugTrace).toBeNull();
  });

  it('results persist across store access (simulating tab switch)', () => {
    const mockResults = [
      { id: 'r-1', score: 0.9 },
      { id: 'r-2', score: 0.8 },
    ] as any;
    useSearchTabStore.getState().setResults(mockResults);

    // Simulate: component unmounts, another component reads the store
    const stateAfterSwitch = useSearchTabStore.getState();
    expect(stateAfterSwitch.results).toHaveLength(2);
    expect((stateAfterSwitch.results?.[0] as any).id).toBe('r-1');
  });
});
