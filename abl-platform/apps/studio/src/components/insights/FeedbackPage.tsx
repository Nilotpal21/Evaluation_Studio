/**
 * FeedbackPage (ABLP-1084)
 *
 * Project-scoped table of recent in-chat feedback (thumbs / star / text)
 * captured by the Agent Platform V2 runtime under ABLP-1068. Backs Studio
 * Insights → Feedback. Filters by date range, agent, channel, rating
 * type / value, and presence of comment. Cursor-paginated via
 * `useFeedback`.
 */

'use client';

import { useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useFeedback, type FeedbackFilters, type FeedbackItem } from '../../hooks/useFeedback';
import { PageHeader } from '../ui/PageHeader';
import { Skeleton } from '../ui/Skeleton';
import { DataTable, type Column } from '../ui/DataTable';
import { Button } from '../ui/Button';
import { Input } from '../ui/Input';
import { FilterSelect } from '../ui/FilterSelect';
import { InsightsDateRangeControl } from './shared/InsightsDateRangeControl';
import { CopyButton, FeedbackDetailDrawer } from './FeedbackDetailDrawer';

// =============================================================================
// HELPERS
// =============================================================================

function formatRating(item: FeedbackItem): string {
  if (item.ratingType === 'thumbs') {
    return item.ratingValue === 1 ? '\u{1F44D}' : '\u{1F44E}';
  }
  if (item.ratingType === 'star') {
    return `${item.ratingValue} ★`;
  }
  return '—';
}

function formatTimestamp(ts: string): string {
  try {
    const d = new Date(ts.endsWith('Z') ? ts : `${ts.replace(' ', 'T')}Z`);
    return d.toLocaleString();
  } catch {
    return ts;
  }
}

function truncate(text: string, max: number): string {
  if (!text) return '';
  return text.length > max ? `${text.slice(0, max).trimEnd()}…` : text;
}

// =============================================================================
// COMPONENT
// =============================================================================

const RATING_TYPE_OPTIONS = [
  { value: '', label: 'All ratings' },
  { value: 'thumbs', label: 'Thumbs' },
  { value: 'star', label: 'Star' },
  { value: 'text', label: 'Text only' },
];

const HAS_TEXT_OPTIONS = [
  { value: '', label: 'Comment: any' },
  { value: 'true', label: 'Has comment' },
  { value: 'false', label: 'No comment' },
];

export function FeedbackPage() {
  const t = useTranslations('insights');
  const [dateRange, setDateRange] = useState<'7d' | '30d' | '90d'>('30d');
  const [ratingType, setRatingType] = useState<'' | 'thumbs' | 'star' | 'text'>('');
  const [hasText, setHasText] = useState<'' | 'true' | 'false'>('');
  const [agentInput, setAgentInput] = useState('');
  const [channelInput, setChannelInput] = useState('');
  const [agentFilter, setAgentFilter] = useState('');
  const [channelFilter, setChannelFilter] = useState('');

  const filters = useMemo<FeedbackFilters>(
    () => ({
      dateRange,
      agentName: agentFilter || undefined,
      channel: channelFilter || undefined,
      ratingType: ratingType || undefined,
      hasText: hasText === '' ? undefined : hasText === 'true',
    }),
    [dateRange, agentFilter, channelFilter, ratingType, hasText],
  );

  const { items, isLoading, isValidating, error, hasMore, loadMore, refresh, projectId } =
    useFeedback(filters);
  const [selected, setSelected] = useState<FeedbackItem | null>(null);

  const columns: Column<FeedbackItem>[] = [
    {
      key: 'timestamp',
      label: 'When',
      render: (row) => (
        <span className="text-sm text-muted whitespace-nowrap">
          {formatTimestamp(row.timestamp)}
        </span>
      ),
      sortable: true,
      sortValue: (row) => row.timestamp,
      width: '180px',
    },
    {
      key: 'agent',
      label: 'Agent',
      render: (row) => (
        <span className="text-sm font-medium text-foreground">{row.agentName || '—'}</span>
      ),
      sortable: true,
      sortValue: (row) => row.agentName,
    },
    {
      key: 'channel',
      label: 'Channel',
      render: (row) => <span className="text-sm text-muted">{row.channel || '—'}</span>,
      sortable: true,
      sortValue: (row) => row.channel,
    },
    {
      key: 'rating',
      label: 'Rating',
      render: (row) => (
        <span
          className="text-base text-foreground"
          aria-label={`${row.ratingType}:${row.ratingValue}`}
        >
          {formatRating(row)}
        </span>
      ),
      sortable: true,
      sortValue: (row) => `${row.ratingType}:${row.ratingValue}`,
      width: '90px',
    },
    {
      key: 'comment',
      label: 'Comment',
      render: (row) => (
        <span className="text-sm text-foreground" title={row.feedbackText}>
          {row.hasText ? truncate(row.feedbackText, 140) : <span className="text-muted">—</span>}
        </span>
      ),
    },
    {
      key: 'session',
      label: 'Session',
      render: (row) => (
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              setSelected(row);
            }}
            className="font-mono text-xs text-accent hover:underline"
            title={`Open feedback detail — ${row.sessionId}`}
          >
            {truncate(row.sessionId, 14)}
          </button>
          <CopyButton value={row.sessionId} label="Copy session id" />
        </div>
      ),
      width: '180px',
    },
  ];

  if (!projectId) {
    return (
      <div className="flex items-center justify-center h-64 text-muted">
        {t('select_project') || 'Select a project to view feedback'}
      </div>
    );
  }

  const filterBar = (
    <div className="flex flex-wrap items-center gap-2">
      <InsightsDateRangeControl
        preset="day"
        value={dateRange}
        onChange={(value) => setDateRange(value as '7d' | '30d' | '90d')}
      />
      <FilterSelect
        options={RATING_TYPE_OPTIONS}
        value={ratingType}
        onChange={(v) => setRatingType(v as '' | 'thumbs' | 'star' | 'text')}
      />
      <FilterSelect
        options={HAS_TEXT_OPTIONS}
        value={hasText}
        onChange={(v) => setHasText(v as '' | 'true' | 'false')}
      />
      <Input
        value={agentInput}
        onChange={(e) => setAgentInput(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') setAgentFilter(agentInput.trim());
        }}
        onBlur={() => setAgentFilter(agentInput.trim())}
        placeholder="Agent name"
        aria-label="Filter by agent name"
        className="w-44"
      />
      <Input
        value={channelInput}
        onChange={(e) => setChannelInput(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') setChannelFilter(channelInput.trim());
        }}
        onBlur={() => setChannelFilter(channelInput.trim())}
        placeholder="Channel"
        aria-label="Filter by channel"
        className="w-36"
      />
      <Button variant="ghost" size="sm" onClick={refresh}>
        Refresh
      </Button>
    </div>
  );

  return (
    <div className="h-full overflow-y-auto bg-noise">
      <div className="max-w-7xl mx-auto px-6 py-8 space-y-6">
        <PageHeader
          title="Feedback"
          description="End-user feedback captured from chat sessions in this project."
          actions={filterBar}
        />

        {error && (
          <div className="rounded-lg border border-error/30 bg-error-subtle p-4 text-sm text-error">
            {error}
          </div>
        )}

        <div className="bg-background-elevated rounded-xl border border-default overflow-hidden">
          {isLoading && items.length === 0 ? (
            <div className="p-6 space-y-3">
              {Array.from({ length: 8 }).map((_, i) => (
                <Skeleton key={i} className="h-10 rounded" />
              ))}
            </div>
          ) : items.length > 0 ? (
            <>
              <DataTable
                columns={columns}
                data={items}
                keyExtractor={(row) => row.feedbackId}
                onRowClick={(row) => setSelected(row)}
                emptyMessage="No feedback yet"
              />
              <div className="flex items-center justify-between px-6 py-3 border-t border-default">
                <span className="text-xs text-muted">
                  {items.length} item{items.length === 1 ? '' : 's'}
                </span>
                {hasMore && (
                  <Button variant="secondary" size="sm" onClick={loadMore} disabled={isValidating}>
                    {isValidating ? 'Loading…' : 'Load more'}
                  </Button>
                )}
              </div>
            </>
          ) : (
            <div className="p-8 text-center text-sm text-muted">
              No feedback found for the selected filters.
            </div>
          )}
        </div>
      </div>

      {projectId && (
        <FeedbackDetailDrawer
          feedback={selected}
          projectId={projectId}
          onClose={() => setSelected(null)}
        />
      )}
    </div>
  );
}
