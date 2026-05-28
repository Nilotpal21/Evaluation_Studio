'use client';

import { useEffect } from 'react';
import { RefreshCw, Download, ChevronLeft, ChevronRight } from 'lucide-react';
import { useArchAuditStore } from '@/lib/arch-ai/store/arch-audit-store';
import { authHeaders } from '@/lib/api-client';
import { AuditLogSummaryCards } from './AuditLogSummaryCards';
import { AuditLogFilters } from './AuditLogFilters';
import { AuditLogRow } from './AuditLogRow';
import { AuditLogTimeline } from './AuditLogTimeline';

export function ArchAuditLogsTab() {
  const entries = useArchAuditStore((s) => s.entries);
  const total = useArchAuditStore((s) => s.total);
  const page = useArchAuditStore((s) => s.page);
  const hasMore = useArchAuditStore((s) => s.hasMore);
  const loading = useArchAuditStore((s) => s.loading);
  const error = useArchAuditStore((s) => s.error);
  const filters = useArchAuditStore((s) => s.filters);
  const fetchLogs = useArchAuditStore((s) => s.fetchLogs);
  const fetchSummary = useArchAuditStore((s) => s.fetchSummary);
  const fetchTimeline = useArchAuditStore((s) => s.fetchTimeline);
  const setPage = useArchAuditStore((s) => s.setPage);
  const refresh = useArchAuditStore((s) => s.refresh);

  // Fetch on mount
  useEffect(() => {
    fetchLogs();
    fetchSummary();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Re-fetch when page changes
  useEffect(() => {
    fetchLogs();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page]);

  const handleExport = async (format: 'csv' | 'json-export') => {
    const params = new URLSearchParams();
    if (filters.category.length > 0) params.set('category', filters.category.join(','));
    if (filters.severity.length > 0) params.set('severity', filters.severity.join(','));
    if (filters.phase) params.set('phase', filters.phase);
    if (filters.from) params.set('from', filters.from);
    if (filters.to) params.set('to', filters.to);
    params.set('format', format);

    const res = await fetch(`/api/arch-ai/audit-logs?${params.toString()}`, {
      headers: authHeaders(),
    });
    if (!res.ok) return;

    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `arch-audit-logs.${format === 'csv' ? 'csv' : 'json'}`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="space-y-5">
      {/* Header with refresh + export */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold text-foreground">Audit Logs</h2>
          <p className="text-xs text-foreground-muted">
            Operational telemetry for Arch AI sessions
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => handleExport('csv')}
            className="inline-flex items-center gap-1.5 rounded-md border border-border/50 px-2.5 py-1.5 text-xs text-foreground-muted hover:bg-background-muted transition-default"
          >
            <Download className="h-3 w-3" />
            CSV
          </button>
          <button
            onClick={() => handleExport('json-export')}
            className="inline-flex items-center gap-1.5 rounded-md border border-border/50 px-2.5 py-1.5 text-xs text-foreground-muted hover:bg-background-muted transition-default"
          >
            <Download className="h-3 w-3" />
            JSON
          </button>
          <button
            onClick={refresh}
            disabled={loading}
            className="inline-flex items-center gap-1.5 rounded-md bg-foreground text-background px-3 py-1.5 text-xs font-medium hover:bg-foreground/90 transition-default disabled:opacity-50"
          >
            <RefreshCw className={`h-3 w-3 ${loading ? 'animate-spin' : ''}`} />
            Refresh
          </button>
        </div>
      </div>

      {/* Summary cards */}
      <AuditLogSummaryCards />

      {/* Filters */}
      <AuditLogFilters />

      {/* Timeline (if a session is selected) */}
      <AuditLogTimeline />

      {/* Error state */}
      {error && (
        <div className="rounded-lg border border-error/30 bg-error/5 p-3 text-xs text-error">
          {error}
        </div>
      )}

      {/* Log table */}
      <div className="rounded-lg border border-border/50 bg-background">
        {loading && entries.length === 0 ? (
          <div className="flex items-center justify-center py-12 text-sm text-foreground-muted">
            Loading audit logs...
          </div>
        ) : entries.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-12 text-center">
            <p className="text-sm text-foreground-muted">No audit logs found</p>
            <p className="mt-1 text-xs text-foreground-subtle">
              Logs will appear when Arch AI sessions generate events
            </p>
          </div>
        ) : (
          entries.map((entry) => (
            <AuditLogRow key={entry._id} entry={entry} onSessionClick={fetchTimeline} />
          ))
        )}
      </div>

      {/* Pagination */}
      {total > 0 && (
        <div className="flex items-center justify-between text-xs text-foreground-muted">
          <span>
            {(page - 1) * 50 + 1}–{Math.min(page * 50, total)} of {total} entries
          </span>
          <div className="flex items-center gap-1">
            <button
              onClick={() => setPage(page - 1)}
              disabled={page <= 1}
              className="rounded p-1 hover:bg-background-muted disabled:opacity-30"
            >
              <ChevronLeft className="h-4 w-4" />
            </button>
            <span className="px-2 tabular-nums">Page {page}</span>
            <button
              onClick={() => setPage(page + 1)}
              disabled={!hasMore}
              className="rounded p-1 hover:bg-background-muted disabled:opacity-30"
            >
              <ChevronRight className="h-4 w-4" />
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
