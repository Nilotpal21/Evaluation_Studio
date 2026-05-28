/**
 * AnalyticsPage Component
 *
 * Container for the analytics dashboard with date range selector and tabs.
 * Mounted at /projects/:projectId/analytics in the project sidebar.
 */

import { useMemo, useState } from 'react';
import { clsx } from 'clsx';
import { useTranslations } from 'next-intl';
import { Calendar } from 'lucide-react';
import dynamic from 'next/dynamic';
import { usePersistedSurfaceFilters } from '../../hooks/usePersistedSurfaceFilters';
import { useNavigationStore } from '../../store/navigation-store';
import { ResetFiltersButton } from '../shared/ResetFiltersButton';
import { PageHeader } from '../ui/PageHeader';
import { Alert } from '../ui/Alert';
import { SessionsExplorerTab } from './SessionsExplorerTab';
import { TracesExplorerTab } from './TracesExplorerTab';
import { QueryExplorerTab } from './QueryExplorerTab';
import { useAnalyticsFlushStatus, type TimeRange } from '../../hooks/useAnalytics';

// Lazy-load tabs that import recharts (~80KB gzipped)
const OverviewTab = dynamic(
  () => import('./OverviewTab').then((m) => ({ default: m.OverviewTab })),
  { ssr: false, loading: () => <div className="h-64 animate-pulse bg-background-muted rounded" /> },
);
const LLMPerformanceTab = dynamic(
  () => import('./LLMPerformanceTab').then((m) => ({ default: m.LLMPerformanceTab })),
  { ssr: false, loading: () => <div className="h-64 animate-pulse bg-background-muted rounded" /> },
);

// =============================================================================
// DATE RANGE HELPERS — Grafana-style quick ranges
// =============================================================================

type DateRangeOption = '30m' | '1h' | '3h' | '6h' | '12h' | '24h' | '2d' | '7d' | '30d';

const DATE_RANGE_OPTIONS: { value: DateRangeOption; label: string }[] = [
  { value: '30m', label: '30m' },
  { value: '1h', label: '1h' },
  { value: '3h', label: '3h' },
  { value: '6h', label: '6h' },
  { value: '12h', label: '12h' },
  { value: '24h', label: '24h' },
  { value: '2d', label: '2d' },
  { value: '7d', label: '7d' },
  { value: '30d', label: '30d' },
];

/** Offset in milliseconds for each quick range. */
const RANGE_MS: Record<DateRangeOption, number> = {
  '30m': 30 * 60 * 1000,
  '1h': 60 * 60 * 1000,
  '3h': 3 * 60 * 60 * 1000,
  '6h': 6 * 60 * 60 * 1000,
  '12h': 12 * 60 * 60 * 1000,
  '24h': 24 * 60 * 60 * 1000,
  '2d': 2 * 24 * 60 * 60 * 1000,
  '7d': 7 * 24 * 60 * 60 * 1000,
  '30d': 30 * 24 * 60 * 60 * 1000,
};

function getTimeRange(range: DateRangeOption): TimeRange {
  const now = new Date();
  const from = new Date(now.getTime() - RANGE_MS[range]);
  return {
    from: from.toISOString(),
    to: now.toISOString(),
  };
}

// =============================================================================
// TABS
// =============================================================================

type TabId = 'overview' | 'llm' | 'sessions-explorer' | 'traces-explorer' | 'query';

const TABS: { id: TabId; labelKey: string }[] = [
  { id: 'overview', labelKey: 'tabs.overview' },
  { id: 'llm', labelKey: 'tabs.llm' },
  { id: 'sessions-explorer', labelKey: 'tabs.sessions_explorer' },
  { id: 'traces-explorer', labelKey: 'tabs.traces_explorer' },
  { id: 'query', labelKey: 'tabs.query' },
];

// =============================================================================
// COMPONENT
// =============================================================================

export function AnalyticsPage() {
  const t = useTranslations('analytics');
  const { projectId } = useNavigationStore();
  const {
    liveSessionCount,
    unflushedLiveSessionCount,
    pendingSessionIds,
    isLoading: flushStatusLoading,
  } = useAnalyticsFlushStatus(projectId);
  const {
    state: analyticsFilters,
    updateState,
    reset,
    nonDefaultCount,
  } = usePersistedSurfaceFilters('analyticsPage');
  const [tracesSessionId, setTracesSessionId] = useState<string | null>(null);
  const showCustomRange = analyticsFilters.dateRangeMode === 'custom';
  const activeTab = analyticsFilters.activeTab;
  const customFromDate =
    analyticsFilters.customFrom.length > 0 ? new Date(analyticsFilters.customFrom) : null;
  const customToDate =
    analyticsFilters.customTo.length > 0 ? new Date(analyticsFilters.customTo) : null;
  const hasValidCustomRange =
    showCustomRange &&
    customFromDate !== null &&
    customToDate !== null &&
    !Number.isNaN(customFromDate.getTime()) &&
    !Number.isNaN(customToDate.getTime()) &&
    customFromDate.getTime() < customToDate.getTime();

  const quickTimeRange = useMemo(
    () => getTimeRange(analyticsFilters.quickRange),
    [activeTab, analyticsFilters.dateRangeMode, analyticsFilters.quickRange],
  );

  // Keep relative ranges stable while a tab is rendering to avoid fetch loops.
  // Recompute when the user changes the top-level tab or date mode/range selection.
  const timeRange = hasValidCustomRange
    ? {
        from: customFromDate.toISOString(),
        to: customToDate.toISOString(),
      }
    : quickTimeRange;

  // Navigate from Sessions Explorer → Traces Explorer for a specific session
  const handleViewTraces = (sessionId: string) => {
    setTracesSessionId(sessionId);
    updateState({ activeTab: 'traces-explorer' });
  };

  const dateRangeActions = (
    <div className="flex items-center gap-2 shrink-0 flex-wrap">
      <div className="flex items-center gap-0.5 bg-background-muted rounded-lg p-0.5">
        {DATE_RANGE_OPTIONS.map((r) => (
          <button
            key={r.value}
            onClick={() =>
              updateState({
                quickRange: r.value,
                dateRangeMode: 'quick',
              })
            }
            className={clsx(
              'px-2.5 py-1.5 rounded-md text-xs font-medium transition-default',
              analyticsFilters.quickRange === r.value && !showCustomRange
                ? 'bg-accent text-accent-foreground'
                : 'text-muted hover:text-foreground',
            )}
          >
            {r.label}
          </button>
        ))}
        <button
          onClick={() =>
            updateState({
              dateRangeMode: showCustomRange ? 'quick' : 'custom',
            })
          }
          className={clsx(
            'px-2.5 py-1.5 rounded-md text-xs font-medium transition-default inline-flex items-center gap-1',
            showCustomRange
              ? 'bg-accent text-accent-foreground'
              : 'text-muted hover:text-foreground',
          )}
        >
          <Calendar className="w-3 h-3" />
          Custom
        </button>
      </div>
      {showCustomRange && (
        <div className="flex items-center gap-1.5 text-xs">
          <input
            type="datetime-local"
            value={analyticsFilters.customFrom}
            onChange={(e) =>
              updateState({
                dateRangeMode: 'custom',
                customFrom: e.target.value,
              })
            }
            className="rounded-md border border-default bg-background-subtle text-foreground text-xs px-2 py-1.5 focus:outline-none focus:border-border-focus"
          />
          <span className="text-muted">to</span>
          <input
            type="datetime-local"
            value={analyticsFilters.customTo}
            onChange={(e) =>
              updateState({
                dateRangeMode: 'custom',
                customTo: e.target.value,
              })
            }
            className="rounded-md border border-default bg-background-subtle text-foreground text-xs px-2 py-1.5 focus:outline-none focus:border-border-focus"
          />
        </div>
      )}
    </div>
  );

  return (
    <div className="h-full overflow-y-auto">
      <div className="max-w-7xl mx-auto px-6 py-8">
        <PageHeader
          title={t('title')}
          description={t('description')}
          beforeActions={<ResetFiltersButton count={nonDefaultCount} onClick={reset} />}
          actions={dateRangeActions}
          className="mb-6"
        />

        {!flushStatusLoading && liveSessionCount > 0 && (
          <Alert
            variant={unflushedLiveSessionCount > 0 ? 'warning' : 'info'}
            title={t('live_sessions_notice.title')}
            className="mb-6"
          >
            <p>
              {t('live_sessions_notice.body', {
                liveSessionCount,
                unflushedLiveSessionCount,
              })}
            </p>
            {pendingSessionIds.length > 0 && (
              <p className="mt-2 font-mono text-xs">
                {t('live_sessions_notice.pending_ids', {
                  sessionIds: pendingSessionIds.join(', '),
                })}
              </p>
            )}
          </Alert>
        )}

        {/* Tab bar */}
        <div className="flex items-center gap-1 border-b border-default mb-6">
          {TABS.map((tab) => (
            <button
              key={tab.id}
              onClick={() => updateState({ activeTab: tab.id })}
              className={clsx(
                'px-4 py-2.5 text-sm font-medium border-b-2 transition-default -mb-px',
                activeTab === tab.id
                  ? 'border-accent text-accent'
                  : 'border-transparent text-muted hover:text-foreground',
              )}
            >
              {t(tab.labelKey)}
            </button>
          ))}
        </div>

        {/* Active tab */}
        {activeTab === 'overview' && <OverviewTab projectId={projectId} timeRange={timeRange} />}
        {activeTab === 'llm' && <LLMPerformanceTab projectId={projectId} timeRange={timeRange} />}
        {activeTab === 'sessions-explorer' && (
          <SessionsExplorerTab
            projectId={projectId}
            timeRange={timeRange}
            onViewTraces={handleViewTraces}
          />
        )}
        {activeTab === 'traces-explorer' && (
          <TracesExplorerTab
            projectId={projectId}
            timeRange={timeRange}
            initialSessionId={tracesSessionId}
          />
        )}
        {activeTab === 'query' && <QueryExplorerTab projectId={projectId} timeRange={timeRange} />}
      </div>
    </div>
  );
}
