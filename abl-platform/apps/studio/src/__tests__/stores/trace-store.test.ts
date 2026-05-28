/**
 * Trace Store Tests
 *
 * Comprehensive tests for the Zustand trace store: event management,
 * type filtering, search, selection, expand/collapse, and the
 * getFilteredEvents computed method.
 *
 * @vitest-environment happy-dom
 */

import { describe, test, expect, beforeEach } from 'vitest';
import { ALL_TRACE_EVENT_TYPES } from '@agent-platform/shared-kernel';
import { useTraceStore } from '../../store/trace-store';
import type { TraceEvent, ExtendedTraceEventType } from '../../types';

// =============================================================================
// HELPERS
// =============================================================================

function makeEvent(overrides: Partial<TraceEvent> = {}): TraceEvent {
  return {
    id: `evt-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    sessionId: 'session-1',
    type: 'llm_call',
    timestamp: new Date('2025-01-01T00:00:00Z'),
    data: {},
    ...overrides,
  };
}

function resetTraceStore() {
  useTraceStore.setState({
    events: [],
    selectedTypes: [...ALL_TRACE_EVENT_TYPES],
    searchQuery: '',
    selectedEventId: null,
    expandedEventIds: new Set(),
  });
}

// =============================================================================
// TESTS
// =============================================================================

describe('Trace Store', () => {
  beforeEach(() => {
    resetTraceStore();
  });

  // ---------------------------------------------------------------------------
  // 1. Initial state
  // ---------------------------------------------------------------------------
  describe('initial state', () => {
    test('has correct default values', () => {
      const state = useTraceStore.getState();

      expect(state.events).toEqual([]);
      expect(state.selectedTypes.length).toBeGreaterThan(0);
      expect(state.searchQuery).toBe('');
      expect(state.selectedEventId).toBeNull();
      expect(state.expandedEventIds.size).toBe(0);
    });

    test('all action functions are defined', () => {
      const state = useTraceStore.getState();

      expect(typeof state.addEvent).toBe('function');
      expect(typeof state.setEvents).toBe('function');
      expect(typeof state.clearEvents).toBe('function');
      expect(typeof state.setSelectedTypes).toBe('function');
      expect(typeof state.toggleType).toBe('function');
      expect(typeof state.setSearchQuery).toBe('function');
      expect(typeof state.selectEvent).toBe('function');
      expect(typeof state.toggleEventExpanded).toBe('function');
      expect(typeof state.expandAll).toBe('function');
      expect(typeof state.collapseAll).toBe('function');
      expect(typeof state.getFilteredEvents).toBe('function');
    });

    test('selectedTypes includes all event types', () => {
      const state = useTraceStore.getState();

      expect(state.selectedTypes).toEqual([...ALL_TRACE_EVENT_TYPES]);
    });
  });

  // ---------------------------------------------------------------------------
  // 2. addEvent()
  // ---------------------------------------------------------------------------
  describe('addEvent()', () => {
    test('adds event to the events array', () => {
      const event = makeEvent({ id: 'evt-1' });
      useTraceStore.getState().addEvent(event);

      expect(useTraceStore.getState().events).toHaveLength(1);
      expect(useTraceStore.getState().events[0]).toEqual(event);
    });

    test('appends events in order', () => {
      const evt1 = makeEvent({ id: 'evt-1' });
      const evt2 = makeEvent({ id: 'evt-2', type: 'tool_call' });

      useTraceStore.getState().addEvent(evt1);
      useTraceStore.getState().addEvent(evt2);

      const events = useTraceStore.getState().events;
      expect(events).toHaveLength(2);
      expect(events[0].id).toBe('evt-1');
      expect(events[1].id).toBe('evt-2');
    });

    test('auto-expands the added event', () => {
      const event = makeEvent({ id: 'evt-auto-expand' });
      useTraceStore.getState().addEvent(event);

      expect(useTraceStore.getState().expandedEventIds.has('evt-auto-expand')).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  // 3. setEvents()
  // ---------------------------------------------------------------------------
  describe('setEvents()', () => {
    test('replaces all events', () => {
      useTraceStore.getState().addEvent(makeEvent({ id: 'old' }));

      const newEvents = [makeEvent({ id: 'new-1' }), makeEvent({ id: 'new-2' })];
      useTraceStore.getState().setEvents(newEvents);

      expect(useTraceStore.getState().events).toHaveLength(2);
      expect(useTraceStore.getState().events[0].id).toBe('new-1');
    });

    test('clears selectedEventId', () => {
      useTraceStore.getState().selectEvent('some-id');
      useTraceStore.getState().setEvents([]);

      expect(useTraceStore.getState().selectedEventId).toBeNull();
    });

    test('expands all new events', () => {
      const events = [makeEvent({ id: 'e1' }), makeEvent({ id: 'e2' }), makeEvent({ id: 'e3' })];
      useTraceStore.getState().setEvents(events);

      const expanded = useTraceStore.getState().expandedEventIds;
      expect(expanded.has('e1')).toBe(true);
      expect(expanded.has('e2')).toBe(true);
      expect(expanded.has('e3')).toBe(true);
    });

    test('handles empty array', () => {
      useTraceStore.getState().setEvents([]);
      expect(useTraceStore.getState().events).toEqual([]);
      expect(useTraceStore.getState().expandedEventIds.size).toBe(0);
    });
  });

  // ---------------------------------------------------------------------------
  // 4. clearEvents()
  // ---------------------------------------------------------------------------
  describe('clearEvents()', () => {
    test('empties events array', () => {
      useTraceStore.getState().addEvent(makeEvent());
      useTraceStore.getState().addEvent(makeEvent());

      useTraceStore.getState().clearEvents();

      expect(useTraceStore.getState().events).toEqual([]);
    });

    test('clears selectedEventId', () => {
      useTraceStore.getState().selectEvent('some-id');
      useTraceStore.getState().clearEvents();

      expect(useTraceStore.getState().selectedEventId).toBeNull();
    });

    test('clears expandedEventIds', () => {
      useTraceStore.getState().addEvent(makeEvent({ id: 'e1' }));
      useTraceStore.getState().clearEvents();

      expect(useTraceStore.getState().expandedEventIds.size).toBe(0);
    });
  });

  // ---------------------------------------------------------------------------
  // 5. Type filter actions
  // ---------------------------------------------------------------------------
  describe('setSelectedTypes()', () => {
    test('sets selected types', () => {
      useTraceStore.getState().setSelectedTypes(['llm_call', 'tool_call']);

      expect(useTraceStore.getState().selectedTypes).toEqual(['llm_call', 'tool_call']);
    });

    test('replaces all types', () => {
      useTraceStore.getState().setSelectedTypes(['error']);

      expect(useTraceStore.getState().selectedTypes).toEqual(['error']);
    });

    test('handles empty array (no types selected)', () => {
      useTraceStore.getState().setSelectedTypes([]);

      expect(useTraceStore.getState().selectedTypes).toEqual([]);
    });
  });

  describe('toggleType()', () => {
    test('removes type when it is selected', () => {
      useTraceStore.getState().setSelectedTypes(['llm_call', 'tool_call', 'error']);

      useTraceStore.getState().toggleType('tool_call');

      const types = useTraceStore.getState().selectedTypes;
      expect(types).toContain('llm_call');
      expect(types).not.toContain('tool_call');
      expect(types).toContain('error');
    });

    test('adds type when it is not selected', () => {
      useTraceStore.getState().setSelectedTypes(['llm_call']);

      useTraceStore.getState().toggleType('handoff');

      const types = useTraceStore.getState().selectedTypes;
      expect(types).toContain('llm_call');
      expect(types).toContain('handoff');
    });

    test('toggle on then off returns to original state', () => {
      useTraceStore.getState().setSelectedTypes(['llm_call']);

      useTraceStore.getState().toggleType('tool_call');
      expect(useTraceStore.getState().selectedTypes).toContain('tool_call');

      useTraceStore.getState().toggleType('tool_call');
      expect(useTraceStore.getState().selectedTypes).not.toContain('tool_call');
    });
  });

  // ---------------------------------------------------------------------------
  // 6. Search
  // ---------------------------------------------------------------------------
  describe('setSearchQuery()', () => {
    test('sets search query', () => {
      useTraceStore.getState().setSearchQuery('booking');

      expect(useTraceStore.getState().searchQuery).toBe('booking');
    });

    test('clears search with empty string', () => {
      useTraceStore.getState().setSearchQuery('term');
      useTraceStore.getState().setSearchQuery('');

      expect(useTraceStore.getState().searchQuery).toBe('');
    });
  });

  // ---------------------------------------------------------------------------
  // 7. Selection
  // ---------------------------------------------------------------------------
  describe('selectEvent()', () => {
    test('selects an event by id', () => {
      useTraceStore.getState().selectEvent('evt-42');

      expect(useTraceStore.getState().selectedEventId).toBe('evt-42');
    });

    test('deselects with null', () => {
      useTraceStore.getState().selectEvent('evt-42');
      useTraceStore.getState().selectEvent(null);

      expect(useTraceStore.getState().selectedEventId).toBeNull();
    });
  });

  // ---------------------------------------------------------------------------
  // 8. Expand / Collapse
  // ---------------------------------------------------------------------------
  describe('toggleEventExpanded()', () => {
    test('expands a collapsed event', () => {
      useTraceStore.getState().toggleEventExpanded('evt-1');

      expect(useTraceStore.getState().expandedEventIds.has('evt-1')).toBe(true);
    });

    test('collapses an expanded event', () => {
      useTraceStore.getState().toggleEventExpanded('evt-1');
      useTraceStore.getState().toggleEventExpanded('evt-1');

      expect(useTraceStore.getState().expandedEventIds.has('evt-1')).toBe(false);
    });

    test('does not affect other expanded events', () => {
      useTraceStore.getState().toggleEventExpanded('evt-1');
      useTraceStore.getState().toggleEventExpanded('evt-2');

      useTraceStore.getState().toggleEventExpanded('evt-1');

      expect(useTraceStore.getState().expandedEventIds.has('evt-1')).toBe(false);
      expect(useTraceStore.getState().expandedEventIds.has('evt-2')).toBe(true);
    });
  });

  describe('expandAll()', () => {
    test('expands all events', () => {
      const events = [makeEvent({ id: 'e1' }), makeEvent({ id: 'e2' }), makeEvent({ id: 'e3' })];
      useTraceStore.getState().setEvents(events);
      useTraceStore.getState().collapseAll();

      useTraceStore.getState().expandAll();

      const expanded = useTraceStore.getState().expandedEventIds;
      expect(expanded.has('e1')).toBe(true);
      expect(expanded.has('e2')).toBe(true);
      expect(expanded.has('e3')).toBe(true);
    });

    test('handles no events', () => {
      useTraceStore.getState().expandAll();
      expect(useTraceStore.getState().expandedEventIds.size).toBe(0);
    });
  });

  describe('collapseAll()', () => {
    test('collapses all events', () => {
      useTraceStore.getState().addEvent(makeEvent({ id: 'e1' }));
      useTraceStore.getState().addEvent(makeEvent({ id: 'e2' }));

      useTraceStore.getState().collapseAll();

      expect(useTraceStore.getState().expandedEventIds.size).toBe(0);
    });
  });

  // ---------------------------------------------------------------------------
  // 9. getFilteredEvents()
  // ---------------------------------------------------------------------------
  describe('getFilteredEvents()', () => {
    test('returns all events when no filters applied', () => {
      const events = [
        makeEvent({ id: 'e1', type: 'llm_call' }),
        makeEvent({ id: 'e2', type: 'tool_call' }),
      ];
      useTraceStore.getState().setEvents(events);

      const filtered = useTraceStore.getState().getFilteredEvents();
      expect(filtered).toHaveLength(2);
    });

    test('filters by selected types', () => {
      const events = [
        makeEvent({ id: 'e1', type: 'llm_call' }),
        makeEvent({ id: 'e2', type: 'tool_call' }),
        makeEvent({ id: 'e3', type: 'error' }),
      ];
      useTraceStore.getState().setEvents(events);
      useTraceStore.getState().setSelectedTypes(['tool_call']);

      const filtered = useTraceStore.getState().getFilteredEvents();
      expect(filtered).toHaveLength(1);
      expect(filtered[0].type).toBe('tool_call');
    });

    test('returns empty when no types are selected', () => {
      useTraceStore.getState().addEvent(makeEvent({ type: 'llm_call' }));
      useTraceStore.getState().setSelectedTypes([]);

      const filtered = useTraceStore.getState().getFilteredEvents();
      expect(filtered).toEqual([]);
    });

    test('filters by search query on event data', () => {
      const events = [
        makeEvent({ id: 'e1', type: 'llm_call', data: { model: 'claude-3' } }),
        makeEvent({ id: 'e2', type: 'tool_call', data: { tool: 'search_hotels' } }),
      ];
      useTraceStore.getState().setEvents(events);
      useTraceStore.getState().setSearchQuery('hotels');

      const filtered = useTraceStore.getState().getFilteredEvents();
      expect(filtered).toHaveLength(1);
      expect(filtered[0].id).toBe('e2');
    });

    test('filters by search query on event type', () => {
      const events = [
        makeEvent({ id: 'e1', type: 'llm_call', data: {} }),
        makeEvent({ id: 'e2', type: 'tool_call', data: {} }),
      ];
      useTraceStore.getState().setEvents(events);
      useTraceStore.getState().setSearchQuery('llm');

      const filtered = useTraceStore.getState().getFilteredEvents();
      expect(filtered).toHaveLength(1);
      expect(filtered[0].type).toBe('llm_call');
    });

    test('search is case-insensitive', () => {
      const events = [makeEvent({ id: 'e1', data: { message: 'Hello World' } })];
      useTraceStore.getState().setEvents(events);
      useTraceStore.getState().setSearchQuery('hello world');

      const filtered = useTraceStore.getState().getFilteredEvents();
      expect(filtered).toHaveLength(1);
    });

    test('combines type filter and search filter', () => {
      const events = [
        makeEvent({ id: 'e1', type: 'llm_call', data: { model: 'claude' } }),
        makeEvent({ id: 'e2', type: 'tool_call', data: { tool: 'claude_search' } }),
        makeEvent({ id: 'e3', type: 'tool_call', data: { tool: 'weather' } }),
      ];
      useTraceStore.getState().setEvents(events);
      useTraceStore.getState().setSelectedTypes(['tool_call']);
      useTraceStore.getState().setSearchQuery('claude');

      const filtered = useTraceStore.getState().getFilteredEvents();
      expect(filtered).toHaveLength(1);
      expect(filtered[0].id).toBe('e2');
    });

    test('returns empty for no events', () => {
      const filtered = useTraceStore.getState().getFilteredEvents();
      expect(filtered).toEqual([]);
    });

    test('search query that matches nothing returns empty', () => {
      useTraceStore.getState().addEvent(makeEvent({ data: { key: 'value' } }));
      useTraceStore.getState().setSearchQuery('nonexistent-term-xyz');

      const filtered = useTraceStore.getState().getFilteredEvents();
      expect(filtered).toEqual([]);
    });
  });

  // ---------------------------------------------------------------------------
  // 10. Cross-cutting interactions
  // ---------------------------------------------------------------------------
  describe('cross-cutting interactions', () => {
    test('addEvent then filter shows correct results', () => {
      useTraceStore.getState().addEvent(makeEvent({ id: 'e1', type: 'llm_call' }));
      useTraceStore.getState().addEvent(makeEvent({ id: 'e2', type: 'error' }));
      useTraceStore.getState().setSelectedTypes(['error']);

      const filtered = useTraceStore.getState().getFilteredEvents();
      expect(filtered).toHaveLength(1);
      expect(filtered[0].type).toBe('error');
    });

    test('setEvents then selectEvent then clearEvents resets selection', () => {
      useTraceStore.getState().setEvents([makeEvent({ id: 'e1' })]);
      useTraceStore.getState().selectEvent('e1');
      expect(useTraceStore.getState().selectedEventId).toBe('e1');

      useTraceStore.getState().clearEvents();
      expect(useTraceStore.getState().selectedEventId).toBeNull();
    });

    test('expand/collapse cycle works correctly', () => {
      const events = [makeEvent({ id: 'e1' }), makeEvent({ id: 'e2' })];
      useTraceStore.getState().setEvents(events);

      // All expanded after setEvents
      expect(useTraceStore.getState().expandedEventIds.size).toBe(2);

      // Collapse all
      useTraceStore.getState().collapseAll();
      expect(useTraceStore.getState().expandedEventIds.size).toBe(0);

      // Expand all
      useTraceStore.getState().expandAll();
      expect(useTraceStore.getState().expandedEventIds.size).toBe(2);

      // Toggle one off
      useTraceStore.getState().toggleEventExpanded('e1');
      expect(useTraceStore.getState().expandedEventIds.has('e1')).toBe(false);
      expect(useTraceStore.getState().expandedEventIds.has('e2')).toBe(true);
    });
  });
});
