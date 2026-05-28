'use client';

/**
 * SessionsExplorerTab Component
 *
 * Data-driven session table with status filters, sortable columns,
 * expandable detail rows, search, column customization, CSV export, and pagination.
 */

import { useState, useMemo, useCallback, memo, useEffect } from 'react';
import { useTranslations } from 'next-intl';
import { clsx } from 'clsx';
import {
  Activity,
  ChevronDown,
  ChevronRight,
  ExternalLink,
  Copy,
  Check,
  SlidersHorizontal,
} from 'lucide-react';
import {
  useAnalyticsSessions,
  type AnalyticsSessionListItem,
  type TimeRange,
} from '../../hooks/useAnalytics';
import { usePersistedSurfaceFilters } from '../../hooks/usePersistedSurfaceFilters';
import type { SessionListItem } from '../../types';
import { KPICard, formatNumber, formatDuration, formatCost } from './shared';
import { Badge, type BadgeVariant } from '../ui/Badge';
import { Pagination } from '../ui/Pagination';
import { EmptyState } from '../ui/EmptyState';
import {
  AdvancedFilterPanel,
  applyAdvancedFilters,
  type FilterColumn,
  type FilterRow,
} from '../shared/AdvancedFilterPanel';
import { ActiveFiltersStrip } from '../shared/ActiveFiltersStrip';
import { ColumnCustomizer, useColumnConfig, type ColumnConfig } from '../shared/ColumnCustomizer';
import { CsvExport } from '../shared/CsvExport';
import { ResetFiltersButton } from '../shared/ResetFiltersButton';
import { SearchInput } from '../shared/SearchInput';
import { Select } from '../ui/Select';

// =============================================================================
// TYPES
// =============================================================================

interface SessionsExplorerTabProps {
  projectId: string | null;
  timeRange: TimeRange;
  onViewTraces?: (sessionId: string) => void;
}

type SortKey =
  | 'agentName'
  | 'status'
  | 'messageCount'
  | 'durationMs'
  | 'tokenCount'
  | 'estimatedCost'
  | 'errorCount'
  | 'lastActivityAt';
type SortDir = 'asc' | 'desc';

type StatusFilter = 'all' | 'active' | 'completed' | 'escalated' | 'failed' | 'ended';

const STATUS_FILTERS: StatusFilter[] = [
  'all',
  'active',
  'completed',
  'escalated',
  'failed',
  'ended',
];

const PAGE_SIZE = 50;
const ANALYTICS_SESSION_FETCH_LIMIT = 1_000;

// =============================================================================
// COLUMN CONFIGURATION
// =============================================================================

const DEFAULT_SESSION_COLUMNS: ColumnConfig[] = [
  { key: 'sessionId', label: 'Session ID', visible: true, pinned: true, order: 0 },
  { key: 'agentName', label: 'Agent', visible: true, order: 1 },
  { key: 'status', label: 'Status', visible: true, order: 2 },
  { key: 'environment', label: 'Environment', visible: true, order: 3 },
  { key: 'lastActivityAt', label: 'Last Activity', visible: true, order: 4 },
  { key: 'traceCount', label: 'Traces', visible: true, order: 5 },
  { key: 'durationMs', label: 'Duration', visible: true, order: 6 },
  { key: 'tokenCount', label: 'Tokens', visible: true, order: 7 },
  { key: 'estimatedCost', label: 'Cost', visible: true, order: 8 },
  { key: 'errorCount', label: 'Errors', visible: true, order: 9 },
  { key: 'userId', label: 'User ID', visible: false, order: 10 },
  { key: 'inputCost', label: 'Input Cost ($)', visible: false, order: 11 },
  { key: 'outputCost', label: 'Output Cost ($)', visible: false, order: 12 },
  { key: 'inputTokens', label: 'Input Tokens', visible: false, order: 13 },
  { key: 'outputTokens', label: 'Output Tokens', visible: false, order: 14 },
  { key: 'source', label: 'Source', visible: false, order: 15 },
  { key: 'channelType', label: 'Channel Type', visible: false, order: 16 },
];

// =============================================================================
// FILTER COLUMNS FOR ADVANCED FILTER PANEL
// =============================================================================

const FILTER_COLUMNS: FilterColumn[] = [
  { key: 'agentName', label: 'Agent', type: 'string' },
  {
    key: 'status',
    label: 'Status',
    type: 'multi_select',
    options: [
      { value: 'active', label: 'Active' },
      { value: 'completed', label: 'Completed' },
      { value: 'escalated', label: 'Escalated' },
      { value: 'failed', label: 'Failed' },
      { value: 'ended', label: 'Ended' },
    ],
  },
  { key: 'durationMs', label: 'Duration (ms)', type: 'number' },
  { key: 'tokenCount', label: 'Tokens', type: 'number' },
  { key: 'estimatedCost', label: 'Cost', type: 'number' },
  { key: 'errorCount', label: 'Errors', type: 'number' },
  { key: 'messageCount', label: 'Turns', type: 'number' },
  { key: 'channel', label: 'Channel', type: 'string' },
  { key: 'environment', label: 'Environment', type: 'string' },
];

// =============================================================================
// STATUS HELPERS
// =============================================================================

function getStatusVariant(status: string): BadgeVariant {
  switch (status.toLowerCase()) {
    case 'active':
    case 'processing':
      return 'accent';
    case 'completed':
    case 'ended':
      return 'success';
    case 'escalated':
      return 'warning';
    case 'failed':
    case 'error':
      return 'error';
    default:
      return 'default';
  }
}

function isStatusDotted(status: string): boolean {
  const lower = status.toLowerCase();
  return lower === 'active' || lower === 'processing';
}

function formatRelativeTime(dateStr: string): string {
  const now = Date.now();
  const then = new Date(dateStr).getTime();
  const diffSec = Math.floor((now - then) / 1000);
  if (diffSec < 60) return `${diffSec}s ago`;
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  const diffDay = Math.floor(diffHr / 24);
  return `${diffDay}d ago`;
}

// =============================================================================
// CELL RENDERERS
// =============================================================================

function renderCellValue(
  key: string,
  session: SessionListItem | AnalyticsSessionListItem,
): React.ReactNode {
  switch (key) {
    case 'sessionId':
      return null; // handled specially with copy button
    case 'agentName':
      return (
        <span
          className="text-foreground font-medium truncate max-w-[150px] block"
          title={session.agentName}
        >
          {session.agentName}
        </span>
      );
    case 'status':
      return (
        <Badge variant={getStatusVariant(session.status)} dot={isStatusDotted(session.status)}>
          {session.status}
        </Badge>
      );
    case 'environment':
      return <span className="text-muted">{session.environment || '--'}</span>;
    case 'lastActivityAt':
      return (
        <span className="text-muted whitespace-nowrap">
          {formatRelativeTime(session.lastActivityAt)}
        </span>
      );
    case 'traceCount':
      return <span className="text-muted">{session.traceEventCount || 0}</span>;
    case 'durationMs':
      return <span className="text-muted">{formatDuration(session.durationMs)}</span>;
    case 'tokenCount':
      return <span className="text-muted">{formatNumber(session.tokenCount)}</span>;
    case 'estimatedCost':
      return <span className="text-muted">{formatCost(session.estimatedCost)}</span>;
    case 'errorCount':
      return session.errorCount > 0 ? (
        <span className="text-error font-medium">{session.errorCount}</span>
      ) : (
        <span className="text-muted">0</span>
      );
    case 'messageCount':
      return <span className="text-muted">{session.messageCount}</span>;
    default:
      return (
        <span className="text-muted">
          {((session as unknown as Record<string, unknown>)[key] as string) || '--'}
        </span>
      );
  }
}

function isRightAligned(key: string): boolean {
  return [
    'durationMs',
    'tokenCount',
    'estimatedCost',
    'errorCount',
    'messageCount',
    'traceCount',
    'inputCost',
    'outputCost',
    'inputTokens',
    'outputTokens',
  ].includes(key);
}

// =============================================================================
// COPY BUTTON HOOK
// =============================================================================

function useCopyFeedback() {
  const [copiedId, setCopiedId] = useState<string | null>(null);

  const copyToClipboard = useCallback((text: string) => {
    navigator.clipboard.writeText(text).then(() => {
      setCopiedId(text);
      setTimeout(() => setCopiedId(null), 2000);
    });
  }, []);

  return { copiedId, copyToClipboard };
}

// =============================================================================
// COMPONENT
// =============================================================================

export function SessionsExplorerTab({
  projectId,
  timeRange,
  onViewTraces,
}: SessionsExplorerTabProps) {
  const t = useTranslations('analytics');
  const {
    state: persistedFilters,
    updateState,
    reset,
    nonDefaultCount,
    pageChips,
    clearPageChip,
  } = usePersistedSurfaceFilters('analyticsSessions', projectId);

  const sourceFilter = persistedFilters.sourceFilter;
  const { sessions, isLoading } = useAnalyticsSessions(projectId, timeRange, {
    limit: ANALYTICS_SESSION_FETCH_LIMIT,
    knownSource: sourceFilter,
  });

  // Filters
  const [page, setPage] = useState(1);
  const [filterPanelOpen, setFilterPanelOpen] = useState(false);
  const [columnPanelOpen, setColumnPanelOpen] = useState(false);
  const statusFilter = persistedFilters.statusFilter;
  const search = persistedFilters.search;
  const channelFilter = persistedFilters.channelFilter;
  const environmentFilter = persistedFilters.environmentFilter;
  const filters = persistedFilters.filters as FilterRow[];

  // Column config
  const {
    columns,
    setColumns,
    visibleColumns,
    reset: resetColumns,
  } = useColumnConfig('sessions-explorer', DEFAULT_SESSION_COLUMNS);

  // Sort state
  const [sortKey, setSortKey] = useState<SortKey>('lastActivityAt');
  const [sortDir, setSortDir] = useState<SortDir>('desc');

  // Expanded rows
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());

  // Copy feedback
  const { copiedId, copyToClipboard } = useCopyFeedback();

  // Convert timeRange to milliseconds for filtering
  const fromMs = new Date(timeRange.from).getTime();
  const toMs = new Date(timeRange.to).getTime();

  const channelOptions = useMemo(
    () => [
      { value: '', label: t('sessions_explorer.channel_filter_all') },
      ...Array.from(new Set(sessions.map((session) => session.channel).filter(Boolean)))
        .sort((left, right) => left!.localeCompare(right!))
        .map((channel) => ({ value: channel!, label: channel! })),
    ],
    [sessions, t],
  );

  const environmentOptions = useMemo(
    () => [
      { value: '', label: t('sessions_explorer.environment_filter_all') },
      ...Array.from(new Set(sessions.map((session) => session.environment).filter(Boolean)))
        .sort((left, right) => left!.localeCompare(right!))
        .map((environment) => ({ value: environment!, label: environment! })),
    ],
    [sessions, t],
  );

  const sourceOptions = useMemo(
    () => [
      { value: 'production', label: t('sessions_explorer.source_filter_production') },
      { value: 'eval', label: t('sessions_explorer.source_filter_eval') },
      { value: 'synthetic', label: t('sessions_explorer.source_filter_synthetic') },
      { value: 'all', label: t('sessions_explorer.source_filter_all') },
    ],
    [t],
  );

  // Filter by last activity so analytics windows match the runtime session contract.
  const filteredSessions = useMemo(() => {
    const searchLower = search.toLowerCase().trim();

    let result = sessions.filter((s) => {
      const lastActivityMs = new Date(s.lastActivityAt).getTime();
      if (lastActivityMs < fromMs || lastActivityMs > toMs) return false;
      if (statusFilter !== 'all') {
        const lower = s.status.toLowerCase();
        if (statusFilter === 'failed') {
          if (lower !== 'failed' && lower !== 'error') return false;
        } else if (lower !== statusFilter) {
          return false;
        }
      }
      if (channelFilter && s.channel !== channelFilter) return false;
      if (environmentFilter && s.environment !== environmentFilter) return false;
      // Search filter
      if (searchLower) {
        const matchesSearch =
          s.agentName.toLowerCase().includes(searchLower) ||
          s.id.toLowerCase().includes(searchLower) ||
          s.status.toLowerCase().includes(searchLower) ||
          (s.channel && s.channel.toLowerCase().includes(searchLower)) ||
          (s.environment && s.environment.toLowerCase().includes(searchLower));
        if (!matchesSearch) return false;
      }
      return true;
    });

    // Apply advanced filters
    if (filters.length > 0) {
      result = applyAdvancedFilters(result, filters, FILTER_COLUMNS);
    }

    return result;
  }, [sessions, statusFilter, channelFilter, environmentFilter, search, filters, fromMs, toMs]);

  // Sort
  const sortedSessions = useMemo(() => {
    const sorted = [...filteredSessions];
    sorted.sort((a, b) => {
      let aVal: string | number;
      let bVal: string | number;
      switch (sortKey) {
        case 'agentName':
          aVal = a.agentName;
          bVal = b.agentName;
          break;
        case 'status':
          aVal = a.status;
          bVal = b.status;
          break;
        case 'lastActivityAt':
          aVal = new Date(a.lastActivityAt).getTime();
          bVal = new Date(b.lastActivityAt).getTime();
          break;
        default:
          aVal = a[sortKey] as number;
          bVal = b[sortKey] as number;
          break;
      }
      if (typeof aVal === 'string' && typeof bVal === 'string') {
        return sortDir === 'asc' ? aVal.localeCompare(bVal) : bVal.localeCompare(aVal);
      }
      return sortDir === 'asc'
        ? (aVal as number) - (bVal as number)
        : (bVal as number) - (aVal as number);
    });
    return sorted;
  }, [filteredSessions, sortKey, sortDir]);

  // Paginate
  const totalPages = Math.max(1, Math.ceil(sortedSessions.length / PAGE_SIZE));
  const paginatedSessions = sortedSessions.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  useEffect(() => {
    setPage(1);
  }, [statusFilter, search, channelFilter, environmentFilter, sourceFilter, filters]);

  useEffect(() => {
    setPage((currentPage) => Math.min(currentPage, totalPages));
  }, [totalPages]);

  // KPIs
  const kpis = useMemo(() => {
    const total = filteredSessions.length;
    const active = filteredSessions.filter((s) => {
      const l = s.status.toLowerCase();
      return l === 'active' || l === 'processing';
    }).length;
    const avgDuration =
      total > 0 ? filteredSessions.reduce((s, x) => s + x.durationMs, 0) / total : 0;
    const errorRate =
      total > 0 ? filteredSessions.filter((s) => s.errorCount > 0).length / total : 0;
    return { total, active, avgDuration, errorRate };
  }, [filteredSessions]);

  const handleSort = (key: SortKey) => {
    if (sortKey === key) {
      setSortDir(sortDir === 'asc' ? 'desc' : 'asc');
    } else {
      setSortKey(key);
      setSortDir('desc');
    }
  };

  const toggleExpanded = (id: string) => {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const sortArrow = (key: SortKey) => {
    if (sortKey !== key) return '';
    return sortDir === 'asc' ? ' \u2191' : ' \u2193';
  };

  // CSV export handler
  const handleExport = useCallback(async (): Promise<Blob> => {
    const visibleKeys = visibleColumns.map((c) => c.key);
    const header = visibleColumns.map((c) => c.label).join(',');
    const rows = sortedSessions.map((s) =>
      visibleKeys
        .map((key) => {
          const val = key === 'sessionId' ? s.id : (s as unknown as Record<string, unknown>)[key];
          const str = val !== undefined && val !== null ? String(val) : '';
          return `"${str.replace(/"/g, '""')}"`;
        })
        .join(','),
    );
    const csv = [header, ...rows].join('\n');
    return new Blob([csv], { type: 'text/csv' });
  }, [sortedSessions, visibleColumns]);

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-20">
        <div className="text-sm text-muted">Loading sessions...</div>
      </div>
    );
  }

  if (sessions.length === 0) {
    return (
      <EmptyState
        icon={<Activity className="w-8 h-8" />}
        title={t('sessions_explorer.empty_title')}
        description={t('sessions_explorer.empty_description')}
      />
    );
  }

  // Compute the visible column count for colSpan (expand column + visible columns)
  const visibleColCount = visibleColumns.length + 1;

  return (
    <div className="space-y-6">
      {/* KPI Cards */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
        <KPICard title={t('sessions_explorer.kpi_total')} value={formatNumber(kpis.total)} />
        <KPICard title={t('sessions_explorer.kpi_active')} value={formatNumber(kpis.active)} />
        <KPICard
          title={t('sessions_explorer.kpi_avg_duration')}
          value={formatDuration(kpis.avgDuration)}
        />
        <KPICard
          title={t('sessions_explorer.kpi_error_rate')}
          value={`${(kpis.errorRate * 100).toFixed(1)}%`}
        />
      </div>

      {/* Status filter pills */}
      <div className="flex items-center gap-1 flex-wrap">
        {STATUS_FILTERS.map((f) => (
          <button
            key={f}
            onClick={() => updateState({ statusFilter: f })}
            className={clsx(
              'px-3 py-1.5 rounded-full text-xs font-medium transition-default',
              statusFilter === f
                ? 'bg-accent text-accent-foreground'
                : 'bg-background-muted text-muted hover:text-foreground',
            )}
          >
            {t(`sessions_explorer.filter_${f}`)}
          </button>
        ))}
      </div>

      {/* Toolbar */}
      <div className="rounded-xl border border-default bg-background-elevated/70 p-3 shadow-sm">
        <div className="flex flex-wrap items-end gap-3">
          <SearchInput
            label="Search"
            value={search}
            onChange={(value) => updateState({ search: value })}
            placeholder="Search sessions..."
            className="flex-1 min-w-[220px] max-w-sm"
          />

          <Select
            label={t('sessions_explorer.channel_filter_label')}
            options={channelOptions}
            value={channelFilter}
            onChange={(value) => updateState({ channelFilter: value })}
            className="min-w-[180px]"
          />

          <Select
            label={t('sessions_explorer.environment_filter_label')}
            options={environmentOptions}
            value={environmentFilter}
            onChange={(value) => updateState({ environmentFilter: value })}
            className="min-w-[180px]"
          />

          <Select
            label={t('sessions_explorer.source_filter_label')}
            options={sourceOptions}
            value={sourceFilter}
            onChange={(value) =>
              updateState({
                sourceFilter: value as 'production' | 'eval' | 'synthetic' | 'all',
              })
            }
            className="min-w-[160px]"
          />

          <div className="ml-auto flex items-center gap-2 self-end">
            <ResetFiltersButton count={nonDefaultCount} onClick={reset} />

            <button
              onClick={() => setFilterPanelOpen(true)}
              className={clsx(
                'inline-flex items-center gap-1.5 rounded-lg border px-3 py-2 text-xs font-medium transition-colors duration-150 focus-visible:ring-2 focus-visible:ring-border-focus focus-visible:ring-offset-1 outline-none',
                filters.length > 0
                  ? 'border-accent text-accent bg-accent-subtle'
                  : 'border-default text-muted bg-background-subtle hover:text-foreground',
              )}
              aria-label="Open filters"
            >
              <SlidersHorizontal className="w-3.5 h-3.5" />
              Filters
              {filters.length > 0 && (
                <span className="ml-1 px-1.5 py-0.5 text-xs rounded-full bg-accent text-accent-foreground">
                  {filters.length}
                </span>
              )}
            </button>

            <button
              onClick={() => setColumnPanelOpen(true)}
              className="inline-flex items-center gap-1.5 rounded-lg border border-default bg-background-subtle px-3 py-2 text-xs font-medium text-muted transition-colors duration-150 hover:text-foreground focus-visible:ring-2 focus-visible:ring-border-focus focus-visible:ring-offset-1 outline-none"
              aria-label="Customize columns"
            >
              Columns
            </button>

            <CsvExport onExport={handleExport} filename="sessions-export.csv" label="Export" />
          </div>
        </div>
      </div>

      <ActiveFiltersStrip
        pageChips={pageChips}
        onRemovePageChip={clearPageChip}
        advancedFilters={filters}
        advancedColumns={FILTER_COLUMNS}
        onRemoveAdvancedFilter={(filterId) =>
          updateState({
            filters: filters.filter((filter) => filter.id !== filterId),
          })
        }
        onClearAll={reset}
      />

      {/* Sessions table */}
      <div className="bg-background-elevated border border-default rounded-xl shadow-sm overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-default">
                <th className="w-8 py-2 px-3" />
                {visibleColumns.map((col) => {
                  const isSortable = [
                    'agentName',
                    'status',
                    'messageCount',
                    'durationMs',
                    'tokenCount',
                    'estimatedCost',
                    'errorCount',
                    'lastActivityAt',
                  ].includes(col.key);
                  return (
                    <th
                      key={col.key}
                      className={clsx(
                        'py-2 px-3 text-xs text-muted font-medium whitespace-nowrap',
                        isRightAligned(col.key) ? 'text-right' : 'text-left',
                        isSortable && 'cursor-pointer hover:text-foreground',
                      )}
                      onClick={isSortable ? () => handleSort(col.key as SortKey) : undefined}
                    >
                      {col.label}
                      {isSortable ? sortArrow(col.key as SortKey) : ''}
                    </th>
                  );
                })}
              </tr>
            </thead>
            <tbody>
              {paginatedSessions.map((session) => (
                <SessionRow
                  key={session.id}
                  session={session}
                  expanded={expandedIds.has(session.id)}
                  onToggle={() => toggleExpanded(session.id)}
                  onViewTraces={onViewTraces}
                  visibleColumns={visibleColumns}
                  visibleColCount={visibleColCount}
                  copiedId={copiedId}
                  onCopyId={copyToClipboard}
                  t={t}
                />
              ))}
              {paginatedSessions.length === 0 && (
                <tr>
                  <td colSpan={visibleColCount} className="py-12 text-center text-muted text-sm">
                    {t('sessions_explorer.no_matches')}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        {/* Pagination */}
        <div className="px-4 pb-3 border-t border-default">
          <Pagination page={page} totalPages={totalPages} onPageChange={setPage} />
        </div>
      </div>

      {/* Slideout panels */}
      <AdvancedFilterPanel
        open={filterPanelOpen}
        onClose={() => setFilterPanelOpen(false)}
        columns={FILTER_COLUMNS}
        filters={filters}
        onChange={(nextFilters) => updateState({ filters: nextFilters })}
      />
      <ColumnCustomizer
        open={columnPanelOpen}
        onClose={() => setColumnPanelOpen(false)}
        columns={columns}
        onChange={setColumns}
        onReset={resetColumns}
      />
    </div>
  );
}

// =============================================================================
// SESSION ROW
// =============================================================================

const SessionRow = memo(function SessionRow({
  session,
  expanded,
  onToggle,
  onViewTraces,
  visibleColumns,
  visibleColCount,
  copiedId,
  onCopyId,
  t,
}: {
  session: SessionListItem;
  expanded: boolean;
  onToggle: () => void;
  onViewTraces?: (sessionId: string) => void;
  visibleColumns: ColumnConfig[];
  visibleColCount: number;
  copiedId: string | null;
  onCopyId: (text: string) => void;
  t: ReturnType<typeof useTranslations>;
}) {
  return (
    <>
      <tr
        className="border-b border-default last:border-0 hover:bg-background-subtle cursor-pointer transition-colors duration-150"
        onClick={onToggle}
      >
        <td className="px-3 py-2 text-muted">
          {expanded ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
        </td>
        {visibleColumns.map((col) => {
          if (col.key === 'sessionId') {
            const isCopied = copiedId === session.id;
            return (
              <td key={col.key} className="px-3 py-2">
                <span className="inline-flex items-center gap-1.5">
                  <span
                    className="font-mono text-xs text-foreground truncate max-w-[200px]"
                    title={session.id}
                  >
                    {session.id.slice(0, 12)}...
                  </span>
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      onCopyId(session.id);
                    }}
                    className="p-0.5 rounded text-muted hover:text-foreground transition-colors duration-150 focus-visible:ring-2 focus-visible:ring-border-focus focus-visible:ring-offset-1 outline-none"
                    title="Copy session ID"
                    aria-label="Copy session ID"
                  >
                    {isCopied ? (
                      <Check className="w-3 h-3 text-success" />
                    ) : (
                      <Copy className="w-3 h-3" />
                    )}
                  </button>
                </span>
              </td>
            );
          }
          return (
            <td
              key={col.key}
              className={clsx('px-3 py-2', isRightAligned(col.key) && 'text-right')}
            >
              {renderCellValue(col.key, session)}
            </td>
          );
        })}
      </tr>

      {/* Expanded detail */}
      {expanded && (
        <tr className="bg-background-subtle">
          <td colSpan={visibleColCount} className="px-6 py-4">
            <div className="flex flex-wrap gap-x-8 gap-y-2 text-xs mb-3">
              <DetailItem
                label={t('sessions_explorer.detail_session_id')}
                value={session.id}
                mono
              />
              {session.channel && (
                <DetailItem label={t('sessions_explorer.detail_channel')} value={session.channel} />
              )}
              <DetailItem
                label={t('sessions_explorer.detail_trace_events')}
                value={String(session.traceEventCount)}
              />
              <DetailItem
                label={t('sessions_explorer.detail_last_activity')}
                value={formatRelativeTime(session.lastActivityAt)}
              />
            </div>
            {onViewTraces && (
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  onViewTraces(session.id);
                }}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-accent bg-accent-subtle rounded-md hover:opacity-80 transition-colors duration-150 focus-visible:ring-2 focus-visible:ring-border-focus focus-visible:ring-offset-1 outline-none"
              >
                <ExternalLink className="w-3 h-3" />
                {t('sessions_explorer.view_traces')}
              </button>
            )}
          </td>
        </tr>
      )}
    </>
  );
});

// =============================================================================
// DETAIL ITEM
// =============================================================================

const DetailItem = memo(function DetailItem({
  label,
  value,
  mono,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <div>
      <span className="text-muted">{label}: </span>
      <span
        className={clsx(
          'text-foreground',
          mono && 'font-mono truncate max-w-[200px] inline-block align-bottom',
        )}
        title={mono ? value : undefined}
      >
        {value}
      </span>
    </div>
  );
});
