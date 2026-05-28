import useSWR from 'swr';
import { useAuthStore } from '../store/auth-store';
import type { TraceExplorerRow } from '../types';

export interface TraceExplorerFilters {
  q?: string;
  agentName?: string | string[];
  environment?: string | string[];
  channel?: string | string[];
  type?: string | string[];
  status?: 'ok' | 'error' | Array<'ok' | 'error'>;
  errorsOnly?: boolean;
  range?: string;
  minLatencyMs?: number;
  maxLatencyMs?: number;
  minTokens?: number;
  maxTokens?: number;
  minCost?: number;
  maxCost?: number;
  sortBy?: string;
  sortDir?: 'asc' | 'desc';
  limit?: number;
  offset?: number;
}

interface TraceExplorerResponse {
  success?: boolean;
  traces?: unknown;
  total?: number;
  offset?: number;
  limit?: number;
}

const TRACE_REFRESH_INTERVAL_MS = 15_000;

export function useTraceExplorer(projectId?: string | null, filters: TraceExplorerFilters = {}) {
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  const key =
    isAuthenticated && projectId
      ? `/api/runtime/traces?${buildTraceQuery(projectId, filters).toString()}`
      : null;

  const { data, error, isLoading, isValidating, mutate } = useSWR<TraceExplorerResponse>(key, {
    refreshInterval: TRACE_REFRESH_INTERVAL_MS,
    keepPreviousData: true,
  });

  const traces = normalizeTraceExplorerRows(data?.traces);

  return {
    traces,
    total: Number.isFinite(data?.total) ? Number(data?.total) : traces.length,
    isLoading,
    isValidating,
    error: error ? String(error) : null,
    refresh: () => mutate(),
  };
}

function buildTraceQuery(projectId: string, filters: TraceExplorerFilters): URLSearchParams {
  const params = new URLSearchParams({ projectId });
  for (const [key, value] of Object.entries(filters)) {
    if (value === undefined || value === null || value === '') continue;
    if (Array.isArray(value)) {
      const filtered = value.map((item) => String(item).trim()).filter(Boolean);
      if (filtered.length > 0) params.set(key, filtered.join(','));
      continue;
    }
    if (key === 'range' && value === 'today') {
      const start = new Date();
      start.setHours(0, 0, 0, 0);
      params.set('from', start.toISOString());
      continue;
    }
    params.set(key, String(value));
  }
  return params;
}

function normalizeTraceExplorerRows(value: unknown): TraceExplorerRow[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.flatMap((row) => {
    const normalized = normalizeTraceExplorerRow(row);
    return normalized ? [normalized] : [];
  });
}

function normalizeTraceExplorerRow(value: unknown): TraceExplorerRow | null {
  if (!isRecord(value)) {
    return null;
  }

  const spanId = readNonEmptyString(value.spanId);
  const sessionId = readNonEmptyString(value.sessionId);
  if (!spanId || !sessionId) {
    return null;
  }

  return {
    traceId: readNonEmptyString(value.traceId) ?? sessionId,
    spanId,
    sessionId,
    agentName: readNullableString(value.agentName),
    environment: readNullableString(value.environment),
    channel: readNullableString(value.channel),
    type: readNonEmptyString(value.type) ?? 'span',
    status: value.status === 'error' ? 'error' : 'ok',
    startedAt: readNonEmptyString(value.startedAt) ?? '',
    durationMs: readNullableNumber(value.durationMs),
    inputTokens: readNumber(value.inputTokens),
    outputTokens: readNumber(value.outputTokens),
    totalTokens: readNumber(value.totalTokens),
    estimatedCost: readNumber(value.estimatedCost),
    eventCount: readNumber(value.eventCount),
    errorCount: readNumber(value.errorCount),
    warningCount:
      value.warningCount === undefined || value.warningCount === null
        ? undefined
        : readNumber(value.warningCount),
    warnings: normalizeTraceWarnings(value.warnings),
    operatorDiagnostics: normalizeOperatorDiagnostics(value.operatorDiagnostics),
    preview: readNonEmptyString(value.preview) ?? '',
  };
}

function normalizeTraceWarnings(value: unknown): TraceExplorerRow['warnings'] {
  if (!Array.isArray(value)) {
    return undefined;
  }

  const warnings = value.flatMap((warning) => {
    if (!isRecord(warning)) {
      return [];
    }

    const code = readNonEmptyString(warning.code);
    const message = readNonEmptyString(warning.message);
    if (!code || !message) {
      return [];
    }

    return [{ code, message, severity: 'warning' as const }];
  });

  return warnings.length > 0 ? warnings : undefined;
}

function normalizeOperatorDiagnostics(value: unknown): TraceExplorerRow['operatorDiagnostics'] {
  if (!Array.isArray(value)) {
    return undefined;
  }

  const diagnostics = value.flatMap((diagnostic) => {
    if (!isRecord(diagnostic)) {
      return [];
    }

    const code = readNonEmptyString(diagnostic.code);
    const operatorHint = readNonEmptyString(diagnostic.operatorHint);
    const traceId = readNonEmptyString(diagnostic.traceId);
    if (!code || !operatorHint || !traceId) {
      return [];
    }

    const severity: NonNullable<TraceExplorerRow['operatorDiagnostics']>[number]['severity'] =
      diagnostic.severity === 'error' || diagnostic.severity === 'warning'
        ? diagnostic.severity
        : 'info';
    const category: NonNullable<TraceExplorerRow['operatorDiagnostics']>[number]['category'] =
      diagnostic.category === 'tool' || diagnostic.category === 'runtime'
        ? diagnostic.category
        : 'llm';

    return [
      {
        code,
        customerMessage: readNonEmptyString(diagnostic.customerMessage) ?? '',
        operatorHint,
        traceId,
        severity,
        category,
        agentName: readNullableString(diagnostic.agentName),
        toolName: readNullableString(diagnostic.toolName),
        recommendedAction: readNullableString(diagnostic.recommendedAction),
      },
    ];
  });

  return diagnostics.length > 0 ? diagnostics : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function readNonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

function readNullableString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

function readNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function readNullableNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}
