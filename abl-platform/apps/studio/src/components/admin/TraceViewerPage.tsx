/**
 * TraceViewerPage Component
 *
 * Workspace-level trace viewer with event stream DataTable,
 * category filter pills, search, and slide-over detail panel.
 */

import { useState, useMemo, useCallback, useEffect } from 'react';
import { useTranslations } from 'next-intl';
import { clsx } from 'clsx';
import {
  Activity,
  Zap,
  Wrench,
  GitBranch,
  ArrowRightLeft,
  AlertCircle,
  Search,
  Loader2,
  Bot,
} from 'lucide-react';
import { apiFetch } from '../../lib/api-client';
import { useAuthStore } from '../../store/auth-store';
import { formatNumber, formatDuration, formatTimestamp } from '../analytics/shared';
import { Badge, type BadgeVariant } from '../ui/Badge';
import { EmptyState } from '../ui/EmptyState';
import { Pagination } from '../ui/Pagination';
import { AnalyticsLayout, type AnalyticsContext } from './AnalyticsLayout';
import { TraceDetail } from './TraceDetail';
import { SQLQueryPanel } from './SQLQueryPanel';

// =============================================================================
// TYPES
// =============================================================================

interface TraceEvent {
  id: string;
  eventType: string;
  timestamp: string;
  agentName: string;
  sessionId: string;
  durationMs: number;
  hasError: boolean;
  spanId?: string;
  parentSpanId?: string;
  data: Record<string, unknown>;
}

type CategoryFilter =
  | 'all'
  | 'llm'
  | 'tool'
  | 'decision'
  | 'error'
  | 'handoff'
  | 'agent'
  | 'session';

const CATEGORY_FILTERS: { id: CategoryFilter; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'llm', label: 'LLM' },
  { id: 'tool', label: 'Tool' },
  { id: 'decision', label: 'Decision' },
  { id: 'error', label: 'Error' },
  { id: 'handoff', label: 'Handoff' },
  { id: 'agent', label: 'Agent' },
  { id: 'session', label: 'Session' },
];

type SortKey = 'timestamp' | 'eventType' | 'agentName' | 'durationMs';
type SortDir = 'asc' | 'desc';
type ViewTab = 'events' | 'sql';

const PAGE_SIZE = 30;

// =============================================================================
// HELPERS
// =============================================================================

function getEventCategory(eventType: string): string {
  if (eventType.startsWith('llm') || eventType === 'llm_call') return 'llm';
  if (eventType.startsWith('tool') || eventType === 'tool_call') return 'tool';
  if (eventType.includes('decision') || eventType.includes('engine')) return 'decision';
  if (
    eventType.includes('error') ||
    eventType.includes('failed') ||
    eventType.includes('violation')
  )
    return 'error';
  if (
    eventType.includes('handoff') ||
    eventType.includes('delegate') ||
    eventType.includes('escalat')
  )
    return 'handoff';
  if (eventType.includes('agent')) return 'agent';
  if (eventType.includes('session')) return 'session';
  return 'other';
}

function getEventBadgeVariant(eventType: string): BadgeVariant {
  const cat = getEventCategory(eventType);
  switch (cat) {
    case 'llm':
      return 'accent';
    case 'tool':
      return 'warning';
    case 'decision':
      return 'purple';
    case 'error':
      return 'error';
    case 'handoff':
      return 'info';
    case 'agent':
      return 'success';
    case 'session':
      return 'default';
    default:
      return 'default';
  }
}

// =============================================================================
// COMPONENT
// =============================================================================

export function TraceViewerPage() {
  return <AnalyticsLayout>{(context) => <TraceViewerContent context={context} />}</AnalyticsLayout>;
}

function TraceViewerContent({ context }: { context: AnalyticsContext }) {
  const t = useTranslations('admin');
  const tenantId = useAuthStore((s) => s.tenantId);
  const [events, setEvents] = useState<TraceEvent[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [categoryFilter, setCategoryFilter] = useState<CategoryFilter>('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [page, setPage] = useState(1);
  const [sortKey, setSortKey] = useState<SortKey>('timestamp');
  const [sortDir, setSortDir] = useState<SortDir>('desc');
  const [selectedEvent, setSelectedEvent] = useState<TraceEvent | null>(null);
  const [viewTab, setViewTab] = useState<ViewTab>('events');

  const { projectId, timeRange } = context;

  // Fetch events
  const fetchEvents = useCallback(async () => {
    if (!tenantId) return;
    setIsLoading(true);
    try {
      const targetProjectId = projectId || context.projects[0]?.id;
      if (!targetProjectId) {
        setEvents([]);
        setIsLoading(false);
        return;
      }

      const params = new URLSearchParams({
        projectId: targetProjectId,
        endpoint: 'events',
        from: timeRange.from,
        to: timeRange.to,
        limit: '500',
      });

      const res = await apiFetch(`/api/runtime/analytics?${params.toString()}`);
      if (!res.ok) {
        setEvents([]);
        return;
      }
      const json = await res.json();
      const rawEvents = json.data?.events || [];
      setEvents(
        rawEvents.map((e: Record<string, unknown>) => ({
          id: String(e.id || ''),
          eventType: String(e.event_type || e.type || 'unknown'),
          timestamp: String(e.timestamp || ''),
          agentName: String(e.agent_name || e.agentName || ''),
          sessionId: String(e.session_id || e.sessionId || ''),
          durationMs: Number(e.duration_ms || e.durationMs || 0),
          hasError: Boolean(e.has_error),
          spanId: e.span_id ? String(e.span_id) : e.spanId ? String(e.spanId) : undefined,
          parentSpanId: e.parent_span_id
            ? String(e.parent_span_id)
            : e.parentSpanId
              ? String(e.parentSpanId)
              : undefined,
          data: (e.data as Record<string, unknown>) || {},
        })),
      );
    } catch {
      setEvents([]);
    } finally {
      setIsLoading(false);
    }
  }, [tenantId, projectId, context.projects, timeRange.from, timeRange.to]);

  useEffect(() => {
    fetchEvents();
  }, [fetchEvents]);

  // Filter
  const filteredEvents = useMemo(() => {
    return events.filter((e) => {
      if (categoryFilter !== 'all' && getEventCategory(e.eventType) !== categoryFilter)
        return false;

      if (searchQuery) {
        const q = searchQuery.toLowerCase();
        if (
          !e.sessionId.toLowerCase().includes(q) &&
          !e.agentName.toLowerCase().includes(q) &&
          !e.eventType.toLowerCase().includes(q) &&
          !JSON.stringify(e.data).toLowerCase().includes(q)
        )
          return false;
      }

      return true;
    });
  }, [events, categoryFilter, searchQuery]);

  // Sort
  const sortedEvents = useMemo(() => {
    const sorted = [...filteredEvents];
    sorted.sort((a, b) => {
      let aVal: string | number;
      let bVal: string | number;
      switch (sortKey) {
        case 'timestamp':
          aVal = new Date(a.timestamp).getTime();
          bVal = new Date(b.timestamp).getTime();
          break;
        case 'eventType':
          aVal = a.eventType;
          bVal = b.eventType;
          break;
        case 'agentName':
          aVal = a.agentName;
          bVal = b.agentName;
          break;
        case 'durationMs':
          aVal = a.durationMs;
          bVal = b.durationMs;
          break;
        default:
          aVal = 0;
          bVal = 0;
      }
      if (typeof aVal === 'string' && typeof bVal === 'string') {
        return sortDir === 'asc' ? aVal.localeCompare(bVal) : bVal.localeCompare(aVal);
      }
      return sortDir === 'asc'
        ? (aVal as number) - (bVal as number)
        : (bVal as number) - (aVal as number);
    });
    return sorted;
  }, [filteredEvents, sortKey, sortDir]);

  // Paginate
  const totalPages = Math.max(1, Math.ceil(sortedEvents.length / PAGE_SIZE));
  const paginatedEvents = sortedEvents.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

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

  return (
    <div className="space-y-6">
      {/* View tabs: Events | SQL */}
      <div className="flex items-center gap-1">
        <button
          onClick={() => setViewTab('events')}
          className={clsx(
            'px-3 py-1.5 rounded-md text-xs font-medium transition-default',
            viewTab === 'events'
              ? 'bg-accent text-accent-foreground'
              : 'bg-background-muted text-muted hover:text-foreground',
          )}
        >
          {t('analytics_traces.tab_event_stream')}
        </button>
        <button
          onClick={() => setViewTab('sql')}
          className={clsx(
            'px-3 py-1.5 rounded-md text-xs font-medium transition-default',
            viewTab === 'sql'
              ? 'bg-accent text-accent-foreground'
              : 'bg-background-muted text-muted hover:text-foreground',
          )}
        >
          {t('analytics_traces.tab_sql_query')}
        </button>
      </div>

      {viewTab === 'sql' ? (
        <SQLQueryPanel projectId={projectId || context.projects[0]?.id || null} />
      ) : (
        <>
          {/* Category filter pills */}
          <div className="flex items-center gap-3 flex-wrap">
            <div className="flex items-center gap-1">
              {CATEGORY_FILTERS.map((f) => (
                <button
                  key={f.id}
                  onClick={() => {
                    setCategoryFilter(f.id);
                    setPage(1);
                  }}
                  className={clsx(
                    'px-3 py-1.5 rounded-full text-xs font-medium transition-default',
                    categoryFilter === f.id
                      ? 'bg-accent text-accent-foreground'
                      : 'bg-background-muted text-muted hover:text-foreground',
                  )}
                >
                  {f.label}
                </button>
              ))}
            </div>

            {/* Search */}
            <div className="relative flex-1 min-w-[200px] max-w-sm">
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-4 h-4 text-foreground-subtle" />
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => {
                  setSearchQuery(e.target.value);
                  setPage(1);
                }}
                placeholder={t('analytics_traces.search_placeholder')}
                className="w-full rounded-lg border border-default bg-background text-foreground text-sm py-1.5 pl-8 pr-3 placeholder:text-foreground-subtle focus:outline-none focus:border-[hsl(var(--border-focus))] focus:ring-1 focus:ring-[hsl(var(--border-focus))] transition-colors"
              />
            </div>

            {/* Count */}
            <span className="text-xs text-muted">
              {t('analytics_traces.event_count', { count: filteredEvents.length })}
            </span>
          </div>

          {isLoading ? (
            <div className="flex items-center justify-center py-20">
              <Loader2 className="w-5 h-5 text-muted animate-spin" />
            </div>
          ) : events.length === 0 ? (
            <EmptyState
              icon={<Activity className="w-6 h-6" />}
              title={t('analytics_traces.empty_title')}
              description={t('analytics_traces.empty_description')}
            />
          ) : (
            <div className="bg-background-elevated border border-default rounded-xl shadow-sm overflow-hidden">
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-default">
                      {(
                        [
                          {
                            key: 'timestamp',
                            label: t('analytics_traces.col_timestamp'),
                          },
                          {
                            key: 'eventType',
                            label: t('analytics_traces.col_event_type'),
                          },
                          { key: 'agentName', label: t('analytics_traces.col_agent') },
                          {
                            key: 'sessionId' as SortKey,
                            label: t('analytics_traces.col_session'),
                          },
                          {
                            key: 'durationMs',
                            label: t('analytics_traces.col_duration'),
                            align: 'right',
                          },
                          {
                            key: 'error' as SortKey,
                            label: t('analytics_traces.col_error'),
                          },
                        ] as {
                          key: SortKey;
                          label: string;
                          align?: string;
                        }[]
                      ).map((col) => (
                        <th
                          key={col.key}
                          className={clsx(
                            'py-2 px-3 text-xs text-muted font-medium cursor-pointer hover:text-foreground whitespace-nowrap',
                            col.align === 'right' ? 'text-right' : 'text-left',
                          )}
                          onClick={() =>
                            ['timestamp', 'eventType', 'agentName', 'durationMs'].includes(col.key)
                              ? handleSort(col.key)
                              : undefined
                          }
                        >
                          {col.label}
                          {['timestamp', 'eventType', 'agentName', 'durationMs'].includes(col.key)
                            ? sortArrow(col.key)
                            : ''}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {paginatedEvents.map((event) => (
                      <tr
                        key={event.id}
                        onClick={() => setSelectedEvent(event)}
                        className={clsx(
                          'border-b border-default last:border-0 hover:bg-background-subtle cursor-pointer transition-default',
                          selectedEvent?.id === event.id && 'bg-accent-subtle/30',
                        )}
                      >
                        <td className="py-2 px-3 text-xs text-muted whitespace-nowrap">
                          {formatTimestamp(event.timestamp)}
                        </td>
                        <td className="py-2 px-3">
                          <Badge variant={getEventBadgeVariant(event.eventType)}>
                            {event.eventType}
                          </Badge>
                        </td>
                        <td className="py-2 px-3 text-foreground text-xs">
                          {event.agentName || '-'}
                        </td>
                        <td className="py-2 px-3 text-xs text-muted font-mono truncate max-w-[140px]">
                          {event.sessionId ? event.sessionId.slice(0, 12) + '...' : '-'}
                        </td>
                        <td className="py-2 px-3 text-right text-xs text-muted">
                          {event.durationMs > 0 ? formatDuration(event.durationMs) : '-'}
                        </td>
                        <td className="py-2 px-3">
                          {event.hasError && (
                            <Badge variant="error" dot>
                              Error
                            </Badge>
                          )}
                        </td>
                      </tr>
                    ))}
                    {paginatedEvents.length === 0 && (
                      <tr>
                        <td colSpan={6} className="py-12 text-center text-muted text-sm">
                          {t('analytics_traces.no_results')}
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
          )}
        </>
      )}

      {/* Trace detail slide-over */}
      {selectedEvent && (
        <TraceDetail event={selectedEvent} onClose={() => setSelectedEvent(null)} />
      )}
    </div>
  );
}
