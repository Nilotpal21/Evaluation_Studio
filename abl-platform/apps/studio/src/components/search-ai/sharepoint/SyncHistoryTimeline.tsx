'use client';

/**
 * SyncHistoryTimeline
 *
 * Timeline-style sync history display matching wireframe.
 * Each entry shows: colored status dot, date, sync type + status, details.
 */

import { useTranslations } from 'next-intl';
import { useSyncHistory, type SyncHistoryEntry } from '../../../hooks/useSyncHistory';
import { Button } from '../../ui/Button';

interface SyncHistoryTimelineProps {
  indexId: string;
  connectorId: string;
}

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  if (mins < 60) return secs > 0 ? `${mins}m ${secs}s` : `${mins}m`;
  const hrs = Math.floor(mins / 60);
  const remainMins = mins % 60;
  return remainMins > 0 ? `${hrs}h ${remainMins}m` : `${hrs}h`;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

const DOT_COLORS: Record<string, string> = {
  done: 'bg-transparent border-success',
  failed: 'bg-transparent border-error',
  cancelled: 'bg-transparent border-warning',
  initial: 'bg-transparent border-info',
};

const STATUS_TEXT_COLORS: Record<string, string> = {
  done: 'text-success',
  failed: 'text-error',
  cancelled: 'text-warning',
  initial: 'text-info',
};

function SyncEntry({ entry, isFirst }: { entry: SyncHistoryEntry; isFirst: boolean }) {
  const statusLabel =
    isFirst && entry.status === 'done'
      ? 'Initial'
      : entry.status === 'done'
        ? 'Completed'
        : entry.status === 'failed'
          ? 'Failed'
          : 'Cancelled';
  const dotColor =
    isFirst && entry.status === 'done'
      ? DOT_COLORS.initial
      : DOT_COLORS[entry.status] || DOT_COLORS.done;
  const textColor =
    isFirst && entry.status === 'done'
      ? STATUS_TEXT_COLORS.initial
      : STATUS_TEXT_COLORS[entry.status] || STATUS_TEXT_COLORS.done;
  const syncType = entry.type === 'full' ? 'Full Sync' : 'Delta Sync';

  const date = new Date(entry.date);
  const dateStr = date.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
  const timeStr = date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });

  return (
    <div className="relative pl-6 pb-6 last:pb-0">
      {/* Timeline line */}
      <div className="absolute left-[7px] top-3 bottom-0 w-0.5 bg-border" />
      {/* Dot */}
      <div
        className={`absolute left-0 top-1.5 w-[15px] h-[15px] rounded-full border-2 ${dotColor}`}
      />

      <div className="ml-2">
        <p className="text-[10px] text-muted">
          {dateStr} — {timeStr}
        </p>
        <p className="text-xs font-medium text-foreground mt-0.5">
          {syncType} — <span className={textColor}>{statusLabel}</span>
        </p>
        {entry.status === 'done' && (
          <p className="text-[10px] text-muted mt-0.5">
            {entry.docsAdded > 0
              ? `${entry.docsAdded.toLocaleString()} documents synced`
              : 'No new documents'}
            {entry.docsRemoved > 0 ? ` · ${entry.docsRemoved} removed` : ''}
            {entry.duration > 0 ? ` · Duration: ${formatDuration(entry.duration)}` : ''}
          </p>
        )}
        {entry.status === 'failed' && (
          <p className="text-[10px] text-error/80 mt-0.5">Sync failed</p>
        )}
      </div>
    </div>
  );
}

export function SyncHistoryTimeline({ indexId, connectorId }: SyncHistoryTimelineProps) {
  const t = useTranslations('search_ai.sharepoint.overview');
  const { history, total, page, isLoading, setPage } = useSyncHistory(indexId, connectorId);

  if (isLoading) {
    return (
      <div className="space-y-3">
        {[1, 2, 3].map((i) => (
          <div key={i} className="h-12 bg-background-muted rounded animate-pulse" />
        ))}
      </div>
    );
  }

  if (history.length === 0) {
    return <p className="text-xs text-muted">{t('no_issues')}</p>;
  }

  const totalPages = Math.ceil(total / 20);

  return (
    <div>
      <div className="space-y-0">
        {history.map((entry, i) => (
          <SyncEntry
            key={`${entry.date}-${entry.type}`}
            entry={entry}
            isFirst={i === history.length - 1 && page >= totalPages}
          />
        ))}
      </div>

      {totalPages > 1 && (
        <div className="flex items-center justify-center gap-2 pt-3">
          <Button variant="ghost" size="xs" disabled={page <= 1} onClick={() => setPage(page - 1)}>
            &larr;
          </Button>
          <span className="text-xs text-muted">
            {page} / {totalPages}
          </span>
          <Button
            variant="ghost"
            size="xs"
            disabled={page >= totalPages}
            onClick={() => setPage(page + 1)}
          >
            &rarr;
          </Button>
        </div>
      )}
    </div>
  );
}
