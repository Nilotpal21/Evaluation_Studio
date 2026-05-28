'use client';

import { create } from 'zustand';
import { apiFetch } from '@/lib/api-client';
import type { AuditLogCategory, AuditLogSeverity } from '@agent-platform/arch-ai';

export interface ArchAuditLogEntry {
  _id: string;
  tenantId: string;
  userId: string;
  sessionId: string;
  projectId?: string;
  category: string;
  severity: string;
  summary: string;
  detail: Record<string, unknown>;
  specialist?: string;
  phase?: string;
  durationMs?: number;
  tokens?: {
    input: number;
    output: number;
    total: number;
    estimatedCost: number;
  };
  timestamp: string;
}

export interface ArchAuditSummary {
  totalEvents: number;
  totalTokens: { input: number; output: number; total: number };
  estimatedCost: number;
  errorCount: { total: number; critical: number; error: number; warning: number };
  byCategory: Record<string, number>;
}

interface ArchAuditFilters {
  category: AuditLogCategory[];
  severity: AuditLogSeverity[];
  phase: string;
  userId: string;
  sessionId: string;
  from: string;
  to: string;
}

interface ArchAuditStoreState {
  entries: ArchAuditLogEntry[];
  total: number;
  page: number;
  hasMore: boolean;
  loading: boolean;
  error: string | null;
  filters: ArchAuditFilters;
  summary: ArchAuditSummary | null;
  summaryLoading: boolean;
  timelineSessionId: string | null;
  timelineEntries: ArchAuditLogEntry[];
  timelineLoading: boolean;
  setPage: (page: number) => void;
  setFilter: <K extends keyof ArchAuditFilters>(key: K, value: ArchAuditFilters[K]) => void;
  toggleCategory: (category: AuditLogCategory) => void;
  clearFilters: () => void;
  fetchLogs: () => Promise<void>;
  fetchSummary: () => Promise<void>;
  fetchTimeline: (sessionId: string) => Promise<void>;
  closeTimeline: () => void;
  refresh: () => Promise<void>;
}

const DEFAULT_FILTERS: ArchAuditFilters = {
  category: [],
  severity: [],
  phase: '',
  userId: '',
  sessionId: '',
  from: '',
  to: '',
};

function readErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function buildLogParams(filters: ArchAuditFilters, page: number): URLSearchParams {
  const params = new URLSearchParams();
  params.set('page', String(page));
  if (filters.category.length > 0) params.set('category', filters.category.join(','));
  if (filters.severity.length > 0) params.set('severity', filters.severity.join(','));
  if (filters.phase) params.set('phase', filters.phase);
  if (filters.userId) params.set('userId', filters.userId);
  if (filters.sessionId) params.set('sessionId', filters.sessionId);
  if (filters.from) params.set('from', filters.from);
  if (filters.to) params.set('to', filters.to);
  return params;
}

function buildSummaryParams(filters: ArchAuditFilters): URLSearchParams {
  const params = new URLSearchParams();
  if (filters.from) params.set('from', filters.from);
  if (filters.to) params.set('to', filters.to);
  return params;
}

export const useArchAuditStore = create<ArchAuditStoreState>((set, get) => ({
  entries: [],
  total: 0,
  page: 1,
  hasMore: false,
  loading: false,
  error: null,
  filters: DEFAULT_FILTERS,
  summary: null,
  summaryLoading: false,
  timelineSessionId: null,
  timelineEntries: [],
  timelineLoading: false,

  setPage: (page) => {
    set({ page: Math.max(1, page) });
  },

  setFilter: (key, value) => {
    set((state) => ({
      filters: { ...state.filters, [key]: value },
      page: 1,
    }));
  },

  toggleCategory: (category) => {
    set((state) => {
      const active = state.filters.category.includes(category);
      return {
        filters: {
          ...state.filters,
          category: active
            ? state.filters.category.filter((item) => item !== category)
            : [...state.filters.category, category],
        },
        page: 1,
      };
    });
  },

  clearFilters: () => {
    set({ filters: DEFAULT_FILTERS, page: 1 });
  },

  fetchLogs: async () => {
    const { filters, page } = get();
    set({ loading: true, error: null });
    try {
      const params = buildLogParams(filters, page);
      const response = await apiFetch(`/api/arch-ai/audit-logs?${params.toString()}`);
      if (!response.ok) {
        throw new Error('Failed to fetch audit logs');
      }
      const data = (await response.json()) as {
        entries?: ArchAuditLogEntry[];
        total?: number;
        page?: number;
        hasMore?: boolean;
      };
      set({
        entries: data.entries ?? [],
        total: data.total ?? 0,
        page: data.page ?? page,
        hasMore: Boolean(data.hasMore),
        loading: false,
      });
    } catch (err) {
      set({ loading: false, error: readErrorMessage(err) });
    }
  },

  fetchSummary: async () => {
    const { filters } = get();
    set({ summaryLoading: true });
    try {
      const params = buildSummaryParams(filters);
      const suffix = params.size > 0 ? `?${params.toString()}` : '';
      const response = await apiFetch(`/api/arch-ai/audit-logs/summary${suffix}`);
      if (!response.ok) {
        throw new Error('Failed to fetch audit summary');
      }
      const data = (await response.json()) as { data?: ArchAuditSummary };
      set({ summary: data.data ?? null, summaryLoading: false });
    } catch (err) {
      set({ summaryLoading: false, error: readErrorMessage(err) });
    }
  },

  fetchTimeline: async (sessionId) => {
    set({
      timelineSessionId: sessionId,
      timelineEntries: [],
      timelineLoading: true,
      error: null,
    });
    try {
      const response = await apiFetch(`/api/arch-ai/audit-logs/sessions/${sessionId}/timeline`);
      if (!response.ok) {
        throw new Error('Failed to fetch audit timeline');
      }
      const data = (await response.json()) as { entries?: ArchAuditLogEntry[] };
      set({ timelineEntries: data.entries ?? [], timelineLoading: false });
    } catch (err) {
      set({ timelineLoading: false, error: readErrorMessage(err) });
    }
  },

  closeTimeline: () => {
    set({ timelineSessionId: null, timelineEntries: [], timelineLoading: false });
  },

  refresh: async () => {
    await Promise.all([get().fetchLogs(), get().fetchSummary()]);
  },
}));
