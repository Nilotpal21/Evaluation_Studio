/**
 * SessionExplorerPage Component
 *
 * Workspace-level session explorer with DataTable, filters, and
 * expandable detail panel. Uses existing analytics proxy for session data.
 */

import { useState, useMemo, useCallback, useEffect } from 'react';
import { useTranslations } from 'next-intl';
import { clsx } from 'clsx';
import { Activity, Loader2, ChevronDown, ChevronRight, Search } from 'lucide-react';
import { Select } from '../ui/Select';
import { apiFetch } from '../../lib/api-client';
import { useAuthStore } from '../../store/auth-store';
import {
  KPICard,
  formatNumber,
  formatDuration,
  formatCost,
  formatTimestamp,
} from '../analytics/shared';
import { Badge, type BadgeVariant } from '../ui/Badge';
import { EmptyState } from '../ui/EmptyState';
import { Pagination } from '../ui/Pagination';
import { AnalyticsLayout, type AnalyticsContext } from './AnalyticsLayout';
import { SessionDetail } from './SessionDetail';

// =============================================================================
// TYPES
// =============================================================================

interface SessionRow {
  id: string;
  agentName: string;
  status: string;
  channel?: string;
  messageCount: number;
  durationMs: number;
  estimatedCost: number;
  errorCount: number;
  createdAt: string;
  lastActivityAt: string;
}

type StatusFilter = 'all' | 'active' | 'completed' | 'failed' | 'ended';
type SortKey =
  | 'agentName'
  | 'status'
  | 'messageCount'
  | 'durationMs'
  | 'estimatedCost'
  | 'errorCount'
  | 'lastActivityAt';
type SortDir = 'asc' | 'desc';

const STATUS_FILTERS: StatusFilter[] = ['all', 'active', 'completed', 'failed', 'ended'];

const PAGE_SIZE = 20;

// =============================================================================
// HELPERS
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
// COMPONENT
// =============================================================================

export function SessionExplorerPage() {
  return (
    <AnalyticsLayout>{(context) => <SessionExplorerContent context={context} />}</AnalyticsLayout>
  );
}

function SessionExplorerContent({ context }: { context: AnalyticsContext }) {
  const t = useTranslations('admin');
  const tenantId = useAuthStore((s) => s.tenantId);
  const [sessions, setSessions] = useState<SessionRow[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [agentFilter, setAgentFilter] = useState<string>('');
  const [hasErrorFilter, setHasErrorFilter] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [page, setPage] = useState(1);
  const [sortKey, setSortKey] = useState<SortKey>('lastActivityAt');
  const [sortDir, setSortDir] = useState<SortDir>('desc');
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);

  const { projectId, timeRange } = context;

  // Fetch sessions
  const fetchSessions = useCallback(async () => {
    if (!tenantId) return;
    setIsLoading(true);
    try {
      const targetProjectId = projectId || context.projects[0]?.id;
      if (!targetProjectId) {
        setSessions([]);
        setIsLoading(false);
        return;
      }

      const params = new URLSearchParams({
        projectId: targetProjectId,
      });

      const res = await apiFetch(`/api/runtime/sessions?${params.toString()}`);
      if (!res.ok) {
        setSessions([]);
        return;
      }
      const json = await res.json();
      const items = json.sessions || json.data || [];
      setSessions(
        items
          .filter((s: Record<string, unknown>) => s.disposition !== 'abandoned')
          .map((s: Record<string, unknown>) => ({
            id: String(s.id || s._id || ''),
            agentName: String(s.agentName || 'Unknown'),
            status: String(s.status || 'unknown'),
            channel: s.channel ? String(s.channel) : undefined,
            messageCount: Number(s.messageCount || 0),
            durationMs: Number(s.durationMs || 0),
            estimatedCost: Number(s.estimatedCost || 0),
            errorCount: Number(s.errorCount || 0),
            createdAt: String(s.createdAt || ''),
            lastActivityAt: String(s.lastActivityAt || s.createdAt || ''),
          })),
      );
    } catch {
      setSessions([]);
    } finally {
      setIsLoading(false);
    }
  }, [tenantId, projectId, context.projects, timeRange.from, timeRange.to]);

  useEffect(() => {
    fetchSessions();
  }, [fetchSessions]);

  // Unique agent names for filter
  const agentNames = useMemo(() => {
    const names = new Set(sessions.map((s) => s.agentName));
    return Array.from(names).sort();
  }, [sessions]);

  // Filter by the same timestamp the runtime session route uses for ranges.
  const filteredSessions = useMemo(() => {
    const fromMs = new Date(timeRange.from).getTime();
    const toMs = new Date(timeRange.to).getTime();

    return sessions.filter((s) => {
      const lastActivityMs = new Date(s.lastActivityAt).getTime();
      if (lastActivityMs < fromMs || lastActivityMs > toMs) return false;

      if (statusFilter !== 'all') {
        const lower = s.status.toLowerCase();
        if (statusFilter === 'failed') {
          if (lower !== 'failed' && lower !== 'error') return false;
        } else if (lower !== statusFilter) return false;
      }

      if (agentFilter && s.agentName !== agentFilter) return false;
      if (hasErrorFilter && s.errorCount === 0) return false;
      if (
        searchQuery &&
        !s.id.toLowerCase().includes(searchQuery.toLowerCase()) &&
        !s.agentName.toLowerCase().includes(searchQuery.toLowerCase())
      )
        return false;

      return true;
    });
  }, [
    sessions,
    timeRange.from,
    timeRange.to,
    statusFilter,
    agentFilter,
    hasErrorFilter,
    searchQuery,
  ]);

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

  // KPIs
  const kpis = useMemo(() => {
    const total = filteredSessions.length;
    const active = filteredSessions.filter((s) => {
      const l = s.status.toLowerCase();
      return l === 'active' || l === 'processing';
    }).length;
    const avgDuration =
      total > 0 ? filteredSessions.reduce((sum, x) => sum + x.durationMs, 0) / total : 0;
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

  const sortArrow = (key: SortKey) => {
    if (sortKey !== key) return '';
    return sortDir === 'asc' ? ' \u2191' : ' \u2193';
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-20">
        <Loader2 className="w-5 h-5 text-muted animate-spin" />
      </div>
    );
  }

  if (sessions.length === 0) {
    return (
      <EmptyState
        icon={<Activity className="w-6 h-6" />}
        title={t('analytics_sessions.empty_title')}
        description={t('analytics_sessions.empty_description')}
      />
    );
  }

  return (
    <div className="space-y-6">
      {/* KPIs */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
        <KPICard
          title={t('analytics_sessions.kpi_total_sessions')}
          value={formatNumber(kpis.total)}
        />
        <KPICard title={t('analytics_sessions.kpi_active')} value={formatNumber(kpis.active)} />
        <KPICard
          title={t('analytics_sessions.kpi_avg_duration')}
          value={formatDuration(kpis.avgDuration)}
        />
        <KPICard
          title={t('analytics_sessions.kpi_error_rate')}
          value={`${(kpis.errorRate * 100).toFixed(1)}%`}
        />
      </div>

      {/* Filters */}
      <div className="flex items-center gap-3 flex-wrap">
        {/* Status pills */}
        <div className="flex items-center gap-1">
          {STATUS_FILTERS.map((f) => (
            <button
              key={f}
              onClick={() => {
                setStatusFilter(f);
                setPage(1);
              }}
              className={clsx(
                'px-3 py-1.5 rounded-full text-xs font-medium transition-default capitalize',
                statusFilter === f
                  ? 'bg-accent text-accent-foreground'
                  : 'bg-background-muted text-muted hover:text-foreground',
              )}
            >
              {f}
            </button>
          ))}
        </div>

        {/* Agent filter */}
        <Select
          options={[
            { value: '', label: t('analytics_sessions.filter_all_agents') },
            ...agentNames.map((name) => ({ value: name, label: name })),
          ]}
          value={agentFilter}
          onChange={(v) => {
            setAgentFilter(v);
            setPage(1);
          }}
        />

        {/* Has error toggle */}
        <button
          onClick={() => {
            setHasErrorFilter(!hasErrorFilter);
            setPage(1);
          }}
          className={clsx(
            'px-3 py-1.5 rounded-full text-xs font-medium transition-default',
            hasErrorFilter
              ? 'bg-error text-error-foreground'
              : 'bg-background-muted text-muted hover:text-foreground',
          )}
        >
          {t('analytics_sessions.filter_has_error')}
        </button>

        {/* Search */}
        <div className="relative flex-1 min-w-[200px] max-w-xs">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-4 h-4 text-foreground-subtle" />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => {
              setSearchQuery(e.target.value);
              setPage(1);
            }}
            placeholder={t('analytics_sessions.search_placeholder')}
            className="w-full rounded-lg border border-default bg-background text-foreground text-sm py-1.5 pl-8 pr-3 placeholder:text-foreground-subtle focus:outline-none focus:border-[hsl(var(--border-focus))] focus:ring-1 focus:ring-[hsl(var(--border-focus))] transition-colors"
          />
        </div>
      </div>

      {/* Sessions table */}
      <div className="bg-background-elevated border border-default rounded-xl shadow-sm overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-default">
                {(
                  [
                    { key: 'agentName', label: t('analytics_sessions.col_agent') },
                    { key: 'status', label: t('analytics_sessions.col_status') },
                    {
                      key: 'messageCount',
                      label: t('analytics_sessions.col_messages'),
                      align: 'right',
                    },
                    {
                      key: 'durationMs',
                      label: t('analytics_sessions.col_duration'),
                      align: 'right',
                    },
                    {
                      key: 'estimatedCost',
                      label: t('analytics_sessions.col_cost'),
                      align: 'right',
                    },
                    {
                      key: 'errorCount',
                      label: t('analytics_sessions.col_errors'),
                      align: 'right',
                    },
                    {
                      key: 'lastActivityAt',
                      label: t('analytics_sessions.col_started'),
                      align: 'right',
                    },
                  ] as { key: SortKey; label: string; align?: string }[]
                ).map((col) => (
                  <th
                    key={col.key}
                    className={clsx(
                      'py-2 px-3 text-xs text-muted font-medium cursor-pointer hover:text-foreground whitespace-nowrap',
                      col.align === 'right' ? 'text-right' : 'text-left',
                    )}
                    onClick={() => handleSort(col.key)}
                  >
                    {col.label}
                    {sortArrow(col.key)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {paginatedSessions.map((session) => (
                <tr
                  key={session.id}
                  onClick={() => setSelectedSessionId(session.id)}
                  className={clsx(
                    'border-b border-default last:border-0 hover:bg-background-subtle cursor-pointer transition-default',
                    selectedSessionId === session.id && 'bg-accent-subtle/30',
                  )}
                >
                  <td className="py-2 px-3 text-foreground font-medium">{session.agentName}</td>
                  <td className="py-2 px-3">
                    <Badge
                      variant={getStatusVariant(session.status)}
                      dot={isStatusDotted(session.status)}
                    >
                      {session.status}
                    </Badge>
                  </td>
                  <td className="py-2 px-3 text-right text-muted">{session.messageCount}</td>
                  <td className="py-2 px-3 text-right text-muted">
                    {formatDuration(session.durationMs)}
                  </td>
                  <td className="py-2 px-3 text-right text-muted">
                    {formatCost(session.estimatedCost)}
                  </td>
                  <td className="py-2 px-3 text-right">
                    {session.errorCount > 0 ? (
                      <span className="text-error font-medium">{session.errorCount}</span>
                    ) : (
                      <span className="text-muted">0</span>
                    )}
                  </td>
                  <td className="py-2 px-3 text-right text-muted whitespace-nowrap">
                    {formatRelativeTime(session.lastActivityAt)}
                  </td>
                </tr>
              ))}
              {paginatedSessions.length === 0 && (
                <tr>
                  <td colSpan={7} className="py-12 text-center text-muted text-sm">
                    {t('analytics_sessions.no_results')}
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

      {/* Session detail slide-over */}
      {selectedSessionId && (
        <SessionDetail
          sessionId={selectedSessionId}
          projectId={projectId || context.projects[0]?.id || null}
          onClose={() => setSelectedSessionId(null)}
        />
      )}
    </div>
  );
}
