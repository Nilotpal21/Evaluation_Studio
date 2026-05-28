'use client';

import { useState, useCallback, useRef, useEffect } from 'react';
import { useApi } from '../../../hooks/use-swr-fetch';
import { SkeletonTable } from '../../../components/ui/skeleton';
import { EmptyState } from '../../../components/ui/empty-state';
import { Badge } from '../../../components/ui/badge';
import type { AuditResponse } from '../../../types/api';
import { formatAuditEntriesAsCsv } from '../../../lib/audit-page-export';

const ACTION_OPTIONS = [
  { value: '', label: 'All actions' },
  { value: 'config_view', label: 'Config View' },
  { value: 'secret_list', label: 'Secret List' },
];

const actionBadgeVariant: Record<
  string,
  'default' | 'accent' | 'warning' | 'error' | 'info' | 'success'
> = {
  config_view: 'default',
  secret_list: 'default',
};

function buildUrl(actor: string, action: string, from: string, to: string, limit: number): string {
  const params = new URLSearchParams();
  if (actor) params.set('actor', actor);
  if (action) params.set('action', action);
  if (from) params.set('from', from);
  if (to) params.set('to', to);
  params.set('limit', String(limit));
  return `/api/audit?${params.toString()}`;
}

function downloadCSV(csv: string) {
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `audit-log-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

export default function AuditPage() {
  const [actor, setActor] = useState('');
  const [action, setAction] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [limit, setLimit] = useState(50);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [debouncedActor, setDebouncedActor] = useState('');

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => setDebouncedActor(actor), 300);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [actor]);

  const url = buildUrl(debouncedActor, action, from, to, limit);
  const { data, loading, error, refetch } = useApi<AuditResponse>(url);

  const handleExport = useCallback(() => {
    if (!data?.entries.length) return;
    downloadCSV(formatAuditEntriesAsCsv(data.entries));
  }, [data]);

  const handleLoadMore = useCallback(() => {
    setLimit((l) => l + 50);
  }, []);

  return (
    <div>
      <h2 className="text-2xl font-bold text-foreground mb-2">Audit Log</h2>
      <p className="text-sm text-muted mb-6">Track admin UI access events</p>

      <div className="mb-4 px-4 py-3 bg-info-subtle border border-info-muted rounded-[var(--radius-md)] text-sm text-info">
        This log tracks admin UI access events. For config/secret mutation history, see{' '}
        <a
          href={process.env.NEXT_PUBLIC_BITBUCKET_REPO_URL || '#'}
          target="_blank"
          rel="noopener noreferrer"
          className="underline font-medium"
        >
          Bitbucket commits
        </a>{' '}
        and{' '}
        <a
          href={process.env.NEXT_PUBLIC_ARGOCD_URL || '#'}
          target="_blank"
          rel="noopener noreferrer"
          className="underline font-medium"
        >
          ArgoCD sync history
        </a>
        .
      </div>

      <div className="flex flex-wrap items-center gap-3 mb-6">
        <input
          type="text"
          value={actor}
          onChange={(e) => setActor(e.target.value)}
          placeholder="Filter by actor..."
          className="px-3 py-2 input-dark text-sm rounded-[var(--radius-md)] w-48"
        />
        <select
          value={action}
          onChange={(e) => setAction(e.target.value)}
          className="px-3 py-2 input-dark text-sm rounded-[var(--radius-md)]"
        >
          {ACTION_OPTIONS.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {opt.label}
            </option>
          ))}
        </select>
        <input
          type="date"
          value={from}
          onChange={(e) => setFrom(e.target.value)}
          className="px-3 py-2 input-dark text-sm rounded-[var(--radius-md)]"
        />
        <input
          type="date"
          value={to}
          onChange={(e) => setTo(e.target.value)}
          className="px-3 py-2 input-dark text-sm rounded-[var(--radius-md)]"
        />
        <button
          onClick={handleExport}
          disabled={!data?.entries.length}
          className="px-4 py-2 bg-background-muted border border-default rounded-[var(--radius-md)] text-sm text-muted hover:text-foreground transition-default disabled:opacity-50"
        >
          Export CSV
        </button>
      </div>

      {loading ? (
        <SkeletonTable rows={8} />
      ) : error ? (
        <EmptyState
          title="Failed to load audit log"
          description={error}
          action={
            <button
              onClick={refetch}
              className="px-4 py-2 bg-accent text-accent-foreground rounded-[var(--radius-md)] text-sm btn-press"
            >
              Retry
            </button>
          }
        />
      ) : data && data.entries.length > 0 ? (
        <>
          <div className="bg-background-muted border border-default rounded-[var(--radius-xl)] overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-background-subtle text-subtle border-b border-border-muted">
                  <th className="text-left px-4 py-3 font-medium">Timestamp</th>
                  <th className="text-left px-4 py-3 font-medium">Actor</th>
                  <th className="text-left px-4 py-3 font-medium">Action</th>
                  <th className="text-left px-4 py-3 font-medium">Target</th>
                  <th className="text-left px-4 py-3 font-medium">IP Address</th>
                </tr>
              </thead>
              <tbody>
                {data.entries.map((entry, i) => (
                  <tr
                    key={i}
                    className="border-b border-border-muted last:border-b-0 table-row-hover"
                  >
                    <td className="px-4 py-3 text-xs text-muted">
                      {new Date(entry.timestamp).toLocaleString()}
                    </td>
                    <td className="px-4 py-3 text-xs text-foreground">{entry.actor}</td>
                    <td className="px-4 py-3">
                      <Badge variant={actionBadgeVariant[entry.action] || 'default'}>
                        {entry.action}
                      </Badge>
                    </td>
                    <td className="px-4 py-3 font-mono text-xs text-muted">{entry.target}</td>
                    <td className="px-4 py-3 text-xs text-subtle">{entry.ipAddress ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {data.count >= limit && (
            <div className="mt-4 text-center">
              <button
                onClick={handleLoadMore}
                className="px-4 py-2 bg-background-muted border border-default rounded-[var(--radius-md)] text-sm text-muted hover:text-foreground transition-default"
              >
                Load more
              </button>
            </div>
          )}
        </>
      ) : (
        <EmptyState
          title="No entries match filters"
          description="Try adjusting your filters to see audit log entries."
        />
      )}
    </div>
  );
}
