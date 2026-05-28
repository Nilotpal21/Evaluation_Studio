/**
 * Trace Store
 *
 * Manages trace events for visualization
 */

import { create } from 'zustand';
import { ALL_TRACE_EVENT_TYPES } from '@agent-platform/shared-kernel';
import type { TraceEvent, ExtendedTraceEventType } from '../types';
import { boundedPush } from '../lib/bounded-collection';

const MAX_TRACE_EVENTS = 1000;
const MAX_EXPANDED = 200;

interface TraceStore {
  // Trace data
  events: TraceEvent[];

  // Filter state
  selectedTypes: ExtendedTraceEventType[];
  searchQuery: string;

  // Selection state
  selectedEventId: string | null;
  expandedEventIds: Set<string>;

  // Actions
  addEvent: (event: TraceEvent) => void;
  setEvents: (events: TraceEvent[]) => void;
  clearEvents: () => void;

  setSelectedTypes: (types: ExtendedTraceEventType[]) => void;
  toggleType: (type: ExtendedTraceEventType) => void;
  setSearchQuery: (query: string) => void;

  selectEvent: (id: string | null) => void;
  toggleEventExpanded: (id: string) => void;
  expandAll: () => void;
  collapseAll: () => void;

  // Computed
  getFilteredEvents: () => TraceEvent[];
}

const ALL_TYPES: ExtendedTraceEventType[] = [...ALL_TRACE_EVENT_TYPES];

export const useTraceStore = create<TraceStore>((set, get) => ({
  // Initial state
  events: [],
  selectedTypes: ALL_TYPES,
  searchQuery: '',
  selectedEventId: null,
  expandedEventIds: new Set(),

  // Actions
  addEvent: (event) => {
    set((state) => {
      const events = boundedPush(state.events, event, MAX_TRACE_EVENTS);
      const eventIds = new Set(events.map((e) => e.id));
      const expandedEventIds = new Set(
        [...state.expandedEventIds].filter((id) => eventIds.has(id)),
      );
      expandedEventIds.add(event.id);
      return { events, expandedEventIds };
    });
  },

  setEvents: (events) => {
    const ids = events.slice(0, MAX_EXPANDED).map((e) => e.id);
    set({
      events,
      selectedEventId: null,
      expandedEventIds: new Set(ids),
    });
  },

  clearEvents: () => {
    set({
      events: [],
      selectedEventId: null,
      expandedEventIds: new Set(),
    });
  },

  setSelectedTypes: (types) => {
    set({ selectedTypes: types });
  },

  toggleType: (type) => {
    set((state) => {
      const types = state.selectedTypes.includes(type)
        ? state.selectedTypes.filter((t) => t !== type)
        : [...state.selectedTypes, type];
      return { selectedTypes: types };
    });
  },

  setSearchQuery: (query) => {
    set({ searchQuery: query });
  },

  selectEvent: (id) => {
    set({ selectedEventId: id });
  },

  toggleEventExpanded: (id) => {
    set((state) => {
      const expanded = new Set(state.expandedEventIds);
      if (expanded.has(id)) {
        expanded.delete(id);
      } else {
        expanded.add(id);
      }
      return { expandedEventIds: expanded };
    });
  },

  expandAll: () => {
    set((state) => ({
      expandedEventIds: new Set(state.events.slice(0, MAX_EXPANDED).map((e) => e.id)),
    }));
  },

  collapseAll: () => {
    set({ expandedEventIds: new Set() });
  },

  getFilteredEvents: () => {
    const { events, selectedTypes, searchQuery } = get();

    return events.filter((event) => {
      // Type filter
      if (!selectedTypes.includes(event.type)) {
        return false;
      }

      // Search filter
      if (searchQuery) {
        const query = searchQuery.toLowerCase();
        const dataStr = JSON.stringify(event.data).toLowerCase();
        const typeStr = event.type.toLowerCase();
        return dataStr.includes(query) || typeStr.includes(query);
      }

      return true;
    });
  },
}));
