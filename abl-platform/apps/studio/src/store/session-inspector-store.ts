import { create } from 'zustand';
import { authHeaders } from '@/lib/api-client';
import type {
  SessionListItem,
  SessionTreeEvent,
  SparklinePoint,
} from '@/lib/arch-inspector-reader';
import type { SessionFilters, NodePayload } from '@/components/admin/session-inspector/types';

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

interface SessionInspectorState {
  sessions: SessionListItem[];
  total: number;
  loading: boolean;
  filters: SessionFilters;
  selectedSessionId: string | null;
  treeEvents: SessionTreeEvent[];
  treeLoading: boolean;
  sparkline: SparklinePoint[];
  sparklineLoading: boolean;
  expandedNodes: Set<string>;
  drawerEventId: string | null;
  drawerPayload: NodePayload | null;
  drawerLoading: boolean;
  lastError: string | null;

  fetchSessions: () => Promise<void>;
  fetchTree: (sessionId: string) => Promise<void>;
  fetchSparkline: () => Promise<void>;
  fetchPayload: (sessionId: string, eventId: string) => Promise<void>;
  selectSession: (sessionId: string) => void;
  toggleNode: (eventId: string) => void;
  openDrawer: (eventId: string) => void;
  closeDrawer: () => void;
  setFilters: (filters: Partial<SessionFilters>) => void;
}

export const useSessionInspectorStore = create<SessionInspectorState>((set, get) => ({
  sessions: [],
  total: 0,
  loading: false,
  filters: {},
  selectedSessionId: null,
  treeEvents: [],
  treeLoading: false,
  sparkline: [],
  sparklineLoading: false,
  expandedNodes: new Set<string>(),
  drawerEventId: null,
  drawerPayload: null,
  drawerLoading: false,
  lastError: null,

  fetchSessions: async () => {
    set({ loading: true });
    try {
      const { filters } = get();
      const params = new URLSearchParams();
      if (filters.projectId) params.set('projectId', filters.projectId);
      if (filters.userId) params.set('userId', filters.userId);
      if (filters.from) params.set('from', filters.from);
      if (filters.to) params.set('to', filters.to);
      if (filters.hasErrors) params.set('hasErrors', 'true');
      if (filters.minCost) params.set('minCost', String(filters.minCost));

      const res = await fetch(`/api/arch-ai/audit-logs/sessions?${params}`, {
        headers: authHeaders(),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      set({ sessions: data.sessions ?? [], total: data.total ?? 0 });
    } catch (err: unknown) {
      set({ sessions: [], total: 0, lastError: describeError(err) });
    } finally {
      set({ loading: false });
    }
  },

  fetchTree: async (sessionId: string) => {
    set({ treeLoading: true, treeEvents: [] });
    try {
      const { filters } = get();
      const params = new URLSearchParams();
      if (filters.projectId) params.set('projectId', filters.projectId);

      const res = await fetch(`/api/arch-ai/audit-logs/sessions/${sessionId}/tree?${params}`, {
        headers: authHeaders(),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      set({ treeEvents: data.events ?? [] });
    } catch (err: unknown) {
      set({ treeEvents: [], lastError: describeError(err) });
    } finally {
      set({ treeLoading: false });
    }
  },

  fetchSparkline: async () => {
    set({ sparklineLoading: true });
    try {
      const { filters } = get();
      const params = new URLSearchParams();
      if (filters.projectId) params.set('projectId', filters.projectId);

      const res = await fetch(`/api/arch-ai/audit-logs/insights?${params}`, {
        headers: authHeaders(),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      set({ sparkline: data.sparkline ?? [] });
    } catch (err: unknown) {
      set({ sparkline: [], lastError: describeError(err) });
    } finally {
      set({ sparklineLoading: false });
    }
  },

  fetchPayload: async (sessionId: string, eventId: string) => {
    set({ drawerLoading: true, drawerPayload: null });
    try {
      const { filters } = get();
      const params = new URLSearchParams();
      if (filters.projectId) params.set('projectId', filters.projectId);

      const res = await fetch(
        `/api/arch-ai/audit-logs/sessions/${sessionId}/payloads/${eventId}?${params}`,
        { headers: authHeaders() },
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      if (data.payload) {
        set({
          drawerPayload: {
            eventId,
            payloadType: data.payload.payloadType,
            content: data.payload.content,
          },
        });
      }
    } catch (err: unknown) {
      set({ drawerPayload: null, lastError: describeError(err) });
    } finally {
      set({ drawerLoading: false });
    }
  },

  selectSession: (sessionId: string) => {
    set({ selectedSessionId: sessionId, expandedNodes: new Set(), drawerEventId: null });
    get().fetchTree(sessionId);
  },

  toggleNode: (eventId: string) => {
    const expanded = new Set(get().expandedNodes);
    if (expanded.has(eventId)) {
      expanded.delete(eventId);
    } else {
      expanded.add(eventId);
    }
    set({ expandedNodes: expanded });
  },

  openDrawer: (eventId: string) => {
    const { selectedSessionId, treeEvents } = get();
    set({ drawerEventId: eventId });
    if (selectedSessionId) {
      // Payloads are keyed by toolCallId, not the audit log's event_id
      const event = treeEvents.find((e) => e.eventId === eventId);
      const payloadKey =
        (event?.detail?.toolCallId as string) || (event?.detail?.toolName ? eventId : '');
      if (payloadKey) {
        get().fetchPayload(selectedSessionId, payloadKey);
      }
    }
  },

  closeDrawer: () => {
    set({ drawerEventId: null, drawerPayload: null });
  },

  setFilters: (filters: Partial<SessionFilters>) => {
    set({ filters: { ...get().filters, ...filters } });
  },
}));
