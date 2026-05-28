'use client';

import { useState, useMemo, useCallback, Suspense } from 'react';
import { useSearchParams } from 'next/navigation';
import { useApi } from '../../../../hooks/use-swr-fetch';
import { Badge } from '../../../../components/ui/badge';
import { SkeletonTable } from '../../../../components/ui/skeleton';
import { EmptyState } from '../../../../components/ui/empty-state';
import type { ConfigDiff, DiffEntry } from '../../../../types/api';

// ─── Constants ──────────────────────────────────────────────────────────────

const ENVS = ['dev', 'staging', 'prod'] as const;

const SENSITIVE_MASK = '\u2022\u2022\u2022\u2022\u2022\u2022';

const statusRowClass: Record<DiffEntry['status'], string> = {
  added: 'diff-added',
  removed: 'diff-removed',
  changed: 'diff-changed',
  same: 'diff-same',
};

const statusBadgeVariant: Record<DiffEntry['status'], 'success' | 'error' | 'warning' | 'default'> =
  {
    added: 'success',
    removed: 'error',
    changed: 'warning',
    same: 'default',
  };

// ─── Helpers ────────────────────────────────────────────────────────────────

function formatValue(value: unknown, isSensitive: boolean): string {
  if (value === undefined || value === null) return '\u2014';
  if (isSensitive) return SENSITIVE_MASK;
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

// ─── Content Component ──────────────────────────────────────────────────────

function ConfigDiffContent() {
  const searchParams = useSearchParams();
  const [left, setLeft] = useState(searchParams.get('left') || 'dev');
  const [right, setRight] = useState(searchParams.get('right') || 'staging');
  const [showUnchanged, setShowUnchanged] = useState(false);
  const [criticalOnly, setCriticalOnly] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');

  const canCompare = left !== right;

  const apiUrl = canCompare
    ? `/api/config/diff?left=${encodeURIComponent(left)}&right=${encodeURIComponent(right)}`
    : null;

  const { data, loading, error, refetch } = useApi<ConfigDiff>(apiUrl);

  const filteredEntries = useMemo(() => {
    if (!data) return [];
    let entries = data.entries;

    // Hide unchanged unless toggled on
    if (!showUnchanged) {
      entries = entries.filter((e) => e.status !== 'same');
    }

    // Critical only — entries where isSensitive and status is not 'same'
    if (criticalOnly) {
      entries = entries.filter((e) => e.isSensitive && e.status !== 'same');
    }

    // Text search on path
    if (searchQuery.trim()) {
      const q = searchQuery.trim().toLowerCase();
      entries = entries.filter((e) => e.path.toLowerCase().includes(q));
    }

    return entries;
  }, [data, showUnchanged, criticalOnly, searchQuery]);

  const handleLeftChange = useCallback(
    (e: React.ChangeEvent<HTMLSelectElement>) => setLeft(e.target.value),
    [],
  );

  const handleRightChange = useCallback(
    (e: React.ChangeEvent<HTMLSelectElement>) => setRight(e.target.value),
    [],
  );

  // ─── Render ────────────────────────────────────────────────────────────────

  return (
    <div>
      <h2 className="text-2xl font-bold text-foreground mb-2">Environment Diff</h2>
      <p className="text-sm text-muted mb-6">Compare configuration between environments</p>

      {/* ── Environment Selectors ────────────────────────────────────────── */}
      <div className="flex items-center gap-4 mb-6">
        <div>
          <label className="block text-xs font-medium text-subtle mb-1">Left Environment</label>
          <select
            value={left}
            onChange={handleLeftChange}
            className="px-3 py-2 input-dark text-sm rounded-[var(--radius-md)]"
          >
            {ENVS.map((env) => (
              <option key={env} value={env}>
                {env.toUpperCase()}
              </option>
            ))}
          </select>
        </div>
        <span className="text-subtle text-sm mt-5">vs</span>
        <div>
          <label className="block text-xs font-medium text-subtle mb-1">Right Environment</label>
          <select
            value={right}
            onChange={handleRightChange}
            className="px-3 py-2 input-dark text-sm rounded-[var(--radius-md)]"
          >
            {ENVS.map((env) => (
              <option key={env} value={env}>
                {env.toUpperCase()}
              </option>
            ))}
          </select>
        </div>
        {!canCompare && (
          <span className="text-xs text-warning mt-5">Select two different environments</span>
        )}
      </div>

      {/* ── Error State ──────────────────────────────────────────────────── */}
      {error && (
        <div className="px-4 py-3 rounded-[var(--radius-md)] bg-error-subtle text-error text-sm mb-4">
          {error}
          <button onClick={refetch} className="ml-3 underline font-medium hover:opacity-80">
            Retry
          </button>
        </div>
      )}

      {/* ── Loading State ────────────────────────────────────────────────── */}
      {loading ? (
        <SkeletonTable rows={10} />
      ) : !canCompare ? (
        <EmptyState
          title="Select environments and compare"
          description="Choose two different environments to see configuration differences."
        />
      ) : data ? (
        <>
          {/* ── Diff Summary Header ──────────────────────────────────────── */}
          <div className="flex flex-wrap items-center gap-3 mb-4">
            <Badge variant="success">{data.summary.added} added</Badge>
            <Badge variant="error">{data.summary.removed} removed</Badge>
            <Badge variant="warning">{data.summary.changed} changed</Badge>
            <Badge variant="default">{data.summary.same} unchanged</Badge>
            {data.hasCriticalDiffs && <Badge variant="error">Critical diffs detected</Badge>}
          </div>

          {/* ── Filter Bar ───────────────────────────────────────────────── */}
          <div className="flex flex-wrap items-center gap-3 mb-4">
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Filter by path..."
              className="px-3 py-2 input-dark text-sm rounded-[var(--radius-md)] w-64"
            />
            <label className="flex items-center gap-2 text-sm text-muted cursor-pointer">
              <input
                type="checkbox"
                checked={showUnchanged}
                onChange={(e) => setShowUnchanged(e.target.checked)}
                className="accent-accent"
              />
              Show unchanged
            </label>
            <label className="flex items-center gap-2 text-sm text-muted cursor-pointer">
              <input
                type="checkbox"
                checked={criticalOnly}
                onChange={(e) => setCriticalOnly(e.target.checked)}
                className="accent-accent"
              />
              Critical only
            </label>
            <span className="ml-auto text-xs text-subtle">
              {filteredEntries.length} of {data.entries.length} entries
            </span>
          </div>

          {/* ── Side-by-side Diff Table ──────────────────────────────────── */}
          <div className="bg-background-muted border border-default rounded-[var(--radius-xl)] overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="bg-background-subtle text-subtle border-b border-border-muted">
                    <th className="text-left px-4 py-3 font-medium">Path</th>
                    <th className="text-left px-4 py-3 font-medium">{left.toUpperCase()}</th>
                    <th className="text-left px-4 py-3 font-medium">{right.toUpperCase()}</th>
                    <th className="text-left px-4 py-3 font-medium w-24">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredEntries.length > 0 ? (
                    filteredEntries.map((entry) => (
                      <tr
                        key={entry.path}
                        className={`border-b border-border-muted last:border-b-0 ${statusRowClass[entry.status]}`}
                      >
                        <td className="px-4 py-3 font-mono text-xs text-foreground">
                          {entry.path}
                        </td>
                        <td className="px-4 py-3 font-mono text-xs text-muted">
                          {entry.status === 'added'
                            ? '\u2014'
                            : formatValue(entry.leftValue, entry.isSensitive)}
                        </td>
                        <td className="px-4 py-3 font-mono text-xs text-muted">
                          {entry.status === 'removed'
                            ? '\u2014'
                            : formatValue(entry.rightValue, entry.isSensitive)}
                        </td>
                        <td className="px-4 py-3">
                          <Badge variant={statusBadgeVariant[entry.status]}>{entry.status}</Badge>
                        </td>
                      </tr>
                    ))
                  ) : (
                    <tr>
                      <td colSpan={4} className="px-4 py-8 text-center text-subtle">
                        {searchQuery || criticalOnly
                          ? 'No entries match current filters'
                          : 'No differences found'}
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </>
      ) : (
        <EmptyState
          title="Select environments and compare"
          description="Choose two different environments to see configuration differences."
        />
      )}
    </div>
  );
}

// ─── Page Export ─────────────────────────────────────────────────────────────

export default function ConfigDiffPage() {
  return (
    <Suspense
      fallback={
        <div>
          <h2 className="text-2xl font-bold text-foreground mb-2">Environment Diff</h2>
          <SkeletonTable rows={5} />
        </div>
      }
    >
      <ConfigDiffContent />
    </Suspense>
  );
}
