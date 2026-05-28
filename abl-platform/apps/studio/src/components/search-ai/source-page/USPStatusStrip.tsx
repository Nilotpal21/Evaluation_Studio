'use client';

/**
 * USPStatusStrip — Zone 2: Two-Row Crawl + Pipeline Stats
 *
 * Row 1 (Crawl): URLs Attempted, Fetched, Failed, Blocked
 * Row 2 (Pipeline): Documents Indexed, Processing Errors, Duration, Quality Distribution
 *
 * Data sources:
 * - Active crawl: dashboard REST polling + WS real-time
 * - Terminal state: displayJob.urls + displayJob.results
 */

import { useMemo } from 'react';
import useSWR from 'swr';
import { useTranslations } from 'next-intl';
import { Wifi, WifiOff, Clock } from 'lucide-react';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import type { CrawlJob, DashboardResponse } from '@/api/crawl';
import type { SearchAISource } from '@/api/search-ai';
import type { DisplayState } from './types';
import { useCrawlProgress } from '@/hooks/useCrawlProgress';
import { AnimatedCounter } from './AnimatedCounter';

interface USPStatusStripProps {
  source: SearchAISource;
  displayJob: CrawlJob | null;
  displayState: DisplayState;
  activeJobId: string | null;
  isViewingHistory: boolean;
  onBackToLatest: () => void;
}

// ─── Connection State ───────────────────────────────────────────────────────

type ConnectionState = 'connected' | 'reconnecting' | 'disconnected';

function deriveConnectionState(connected: boolean, isReconnecting: boolean): ConnectionState {
  if (isReconnecting) return 'reconnecting';
  if (connected) return 'connected';
  return 'disconnected';
}

// ─── Progress Color ─────────────────────────────────────────────────────────

function getProgressColor(state: DisplayState): string {
  switch (state) {
    case 'crawling':
      return 'bg-accent';
    case 'completed':
      return 'bg-success';
    case 'completed_with_issues':
      return 'bg-warning';
    case 'failed':
      return 'bg-error';
    case 'cancelled':
      return 'bg-muted';
    default:
      return 'bg-background-muted';
  }
}

// ─── Contextual Message ─────────────────────────────────────────────────────

function getContextualMessage(
  displayState: DisplayState,
  displayJob: CrawlJob | null,
  dashboard: DashboardResponse | null,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  t: (key: string, values?: any) => string,
): string {
  if (!displayJob) {
    if (displayState === 'pending') return t('status_pending');
    if (displayState === 'idle') return t('status_idle');
    return '';
  }

  switch (displayState) {
    case 'crawling': {
      const crawled = dashboard?.crawl?.urlsCrawled ?? displayJob.urls?.crawled ?? 0;
      const total = dashboard?.crawl?.totalUrls ?? 0;
      return total > 0
        ? t('status_crawling_of', { crawled, total })
        : t('status_crawling_so_far', { crawled });
    }
    case 'completed': {
      const unchangedCount = displayJob.urls?.unchanged ?? 0;
      if (unchangedCount > 0) {
        const updatedCount = (displayJob.urls?.crawled ?? 0) - unchangedCount;
        return t('status_recrawl_completed', {
          updated: Math.max(updatedCount, 0),
          unchanged: unchangedCount,
        });
      }
      return t('status_completed', { count: displayJob.urls?.crawled ?? 0 });
    }
    case 'completed_with_issues':
      return t('status_completed_issues', { count: displayJob.urls?.failed ?? 0 });
    case 'failed':
      return t('status_failed');
    case 'cancelled':
      return t('status_cancelled', { count: displayJob.urls?.crawled ?? 0 });
    default:
      return '';
  }
}

// ─── Elapsed / Duration ─────────────────────────────────────────────────────

function formatDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  if (minutes < 60) return `${minutes}m ${remainingSeconds}s`;
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return `${hours}h ${remainingMinutes}m`;
}

function getElapsedOrDuration(displayJob: CrawlJob | null, isCrawling: boolean): string | null {
  if (!displayJob?.timeline) return null;

  const startedAt = displayJob.timeline.startedAt
    ? new Date(displayJob.timeline.startedAt).getTime()
    : null;

  if (!startedAt) return null;

  if (isCrawling) {
    const elapsed = Date.now() - startedAt;
    return formatDuration(elapsed);
  }

  const completedAt = displayJob.timeline.completedAt
    ? new Date(displayJob.timeline.completedAt).getTime()
    : null;

  if (completedAt) {
    return formatDuration(completedAt - startedAt);
  }

  return null;
}

// ─── Component ──────────────────────────────────────────────────────────────

export function USPStatusStrip({
  source,
  displayJob,
  displayState,
  activeJobId,
  isViewingHistory,
  onBackToLatest,
}: USPStatusStripProps) {
  const t = useTranslations('search_ai.source_page');
  const tPages = useTranslations('search_ai.crawled_pages');
  const isCrawling = displayState === 'crawling';
  const isTerminal = ['completed', 'completed_with_issues', 'failed', 'cancelled'].includes(
    displayState,
  );

  // ── WS — only connect during active crawl ──────────────────────────────
  const { connected, isReconnecting, lastEvent } = useCrawlProgress(
    isCrawling ? activeJobId : null,
  );

  const connectionState = deriveConnectionState(connected, isReconnecting);

  // ── REST Fallback — poll dashboard when WS is disconnected ─────────────
  const shouldPollREST = isCrawling && connectionState === 'disconnected';

  const { data: dashboard } = useSWR<DashboardResponse>(
    activeJobId && isCrawling ? `/api/search-ai/crawl/dashboard/${activeJobId}` : null,
    {
      refreshInterval: shouldPollREST ? 10000 : isCrawling ? 30000 : undefined,
      revalidateOnFocus: false,
    },
  );

  // ── Crawl Stats (Row 1) ─────────────────────────────────────────────────
  const crawlStats = useMemo(() => {
    if (isCrawling) {
      // During active crawl, prefer dashboard (REST polling) data.
      // If dashboard hasn't loaded yet, show zeros — NOT stale data from
      // the previous CrawlJob which would show progress=100%.
      if (dashboard) {
        return {
          attempted: dashboard.crawl?.totalUrls ?? 0,
          fetched: dashboard.crawl?.urlsCrawled ?? 0,
          failed: dashboard.crawl?.urlsFailed ?? 0,
          blocked: 0, // Blocked count not in dashboard.crawl during active crawl
          unchanged: 0,
          progress: dashboard.crawl?.progress ?? 0,
        };
      }
      return { attempted: 0, fetched: 0, failed: 0, blocked: 0, unchanged: 0, progress: 0 };
    }
    if (displayJob) {
      return {
        attempted: displayJob.urls?.original?.length ?? displayJob.urls?.crawled ?? 0,
        fetched: displayJob.urls?.crawled ?? 0,
        failed: displayJob.urls?.failed ?? 0,
        blocked: displayJob.urls?.blocked ?? 0,
        unchanged: displayJob.urls?.unchanged ?? 0,
        progress: 100,
      };
    }
    return { attempted: 0, fetched: 0, failed: 0, blocked: 0, unchanged: 0, progress: 0 };
  }, [isCrawling, dashboard, displayJob]);

  // ── Pipeline Stats (Row 2) ──────────────────────────────────────────────
  const pipelineStats = useMemo(() => {
    if (isCrawling && dashboard) {
      return {
        documentsIndexed: dashboard.ingestion?.documentsIndexed ?? 0,
        processingErrors: dashboard.ingestion?.documentsFailed ?? 0,
        qualityDistribution: dashboard.ingestion?.qualityDistribution ?? null,
      };
    }
    if (displayJob) {
      return {
        documentsIndexed: displayJob.results?.documentsCreated ?? 0,
        processingErrors: 0,
        qualityDistribution: null,
      };
    }
    return { documentsIndexed: 0, processingErrors: 0, qualityDistribution: null };
  }, [isCrawling, dashboard, displayJob]);

  const contextualMessage = getContextualMessage(displayState, displayJob, dashboard ?? null, t);
  const elapsedOrDuration = getElapsedOrDuration(displayJob, isCrawling);
  const progressColor = getProgressColor(displayState);

  // ── Historical banner (State J) ────────────────────────────────────────
  if (isViewingHistory && displayJob) {
    const jobDate =
      displayJob.timeline?.completedAt ?? displayJob.timeline?.startedAt ?? displayJob.createdAt;
    const formattedDate = new Date(jobDate).toLocaleDateString(undefined, {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    });
    return (
      <Card
        padding="md"
        hoverable={false}
        className="bg-info-subtle border-info/20"
        data-testid="usp-historical-banner"
      >
        <div className="flex items-center justify-between text-sm">
          <span className="text-info">{t('viewing_history', { date: formattedDate })}</span>
          <Button
            variant="ghost"
            size="sm"
            onClick={onBackToLatest}
            data-testid="usp-back-to-latest"
          >
            {t('back_to_latest')}
          </Button>
        </div>
      </Card>
    );
  }

  // ── Main strip ─────────────────────────────────────────────────────────
  return (
    <Card padding="md" hoverable={false} className="space-y-3" data-testid="usp-status-strip">
      {/* Contextual message */}
      {contextualMessage && (
        <p className="text-sm text-muted" data-testid="usp-contextual-message">
          {contextualMessage}
        </p>
      )}

      {/* Progress bar — only during crawl */}
      {isCrawling && (
        <div
          className="w-full h-2 bg-background-muted rounded-full overflow-hidden"
          data-testid="usp-progress-bar"
        >
          <div
            className={`h-full rounded-full transition-all duration-500 ${progressColor}`}
            style={{ width: `${Math.min(crawlStats.progress, 100)}%` }}
          />
        </div>
      )}

      {/* Row 1: Crawl Stats */}
      <div data-testid="usp-crawl-stats">
        <div className="text-xs text-muted mb-1 font-medium">{tPages('crawl_status')}</div>
        <div className="flex items-center gap-6 text-sm">
          <StatItem
            label={t('stat_attempted')}
            value={crawlStats.attempted}
            testid="usp-stat-attempted"
          />
          <StatItem
            label={t('stat_fetched')}
            value={crawlStats.fetched}
            testid="usp-stat-fetched"
          />
          {crawlStats.failed > 0 && (
            <StatItem
              label={t('stat_failed')}
              value={crawlStats.failed}
              variant="error"
              testid="usp-stat-failed"
            />
          )}
          {crawlStats.blocked > 0 && (
            <StatItem
              label={t('stat_blocked')}
              value={crawlStats.blocked}
              variant="warning"
              testid="usp-stat-blocked"
            />
          )}
          {crawlStats.unchanged > 0 && (
            <StatItem
              label={t('stat_unchanged')}
              value={crawlStats.unchanged}
              testid="usp-stat-unchanged"
            />
          )}
        </div>
      </div>

      {/* Row 2: Pipeline Stats */}
      <div data-testid="usp-pipeline-stats">
        <div className="text-xs text-muted mb-1 font-medium">{tPages('index_status')}</div>
        <div className="flex items-center gap-6 text-sm">
          <StatItem
            label={t('stat_documents')}
            value={pipelineStats.documentsIndexed}
            testid="usp-stat-docs"
          />
          {pipelineStats.processingErrors > 0 && (
            <StatItem
              label={t('stat_processing_errors')}
              value={pipelineStats.processingErrors}
              variant="error"
              testid="usp-stat-proc-errors"
            />
          )}
          {elapsedOrDuration && (
            <div className="flex items-center gap-1.5 text-muted">
              <Clock className="h-3.5 w-3.5" />
              <span>{elapsedOrDuration}</span>
            </div>
          )}
          {/* Quality distribution mini-bar */}
          {pipelineStats.qualityDistribution && (
            <QualityMiniBar distribution={pipelineStats.qualityDistribution} t={tPages} />
          )}
        </div>
      </div>

      {/* Connection indicator — only during crawl */}
      {isCrawling && (
        <div className="flex items-center gap-1.5 text-xs" data-testid="usp-connection">
          {connectionState === 'connected' && (
            <>
              <Wifi className="h-3 w-3 text-success" />
              <span className="text-success">{t('connection_live')}</span>
            </>
          )}
          {connectionState === 'reconnecting' && (
            <>
              <WifiOff className="h-3 w-3 text-warning animate-pulse" />
              <span className="text-warning">{t('connection_reconnecting')}</span>
            </>
          )}
          {connectionState === 'disconnected' && (
            <>
              <WifiOff className="h-3 w-3 text-warning" />
              <span className="text-warning">{t('connection_polling')}</span>
            </>
          )}
        </div>
      )}

      {/* Quality bar — terminal states only (full-width, from CrawlJob results) */}
      {isTerminal && displayJob && <QualityBar job={displayJob} t={t} />}
    </Card>
  );
}

// ─── Stat Item ──────────────────────────────────────────────────────────────

function StatItem({
  label,
  value,
  variant,
  suffix,
  testid,
}: {
  label: string;
  value: number;
  variant?: 'error' | 'warning';
  suffix?: string;
  testid?: string;
}) {
  const colorClass =
    variant === 'error'
      ? 'font-semibold text-error'
      : variant === 'warning'
        ? 'font-semibold text-warning'
        : 'font-semibold text-foreground';

  return (
    <div className="flex items-center gap-1.5" data-testid={testid}>
      <span className="text-muted">{label}</span>
      <span className={colorClass}>
        <AnimatedCounter value={value} />
        {suffix}
      </span>
    </div>
  );
}

// ─── Quality Mini Bar ────────────────────────────────────────────────────────

function QualityMiniBar({
  distribution,
  t,
}: {
  distribution: Record<string, number>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  t: (key: string, values?: any) => string;
}) {
  const rich = distribution.rich ?? 0;
  const standard = distribution.standard ?? 0;
  const thin = distribution.thin ?? 0;
  const total = rich + standard + thin;

  if (total === 0) return null;

  const richPct = (rich / total) * 100;
  const standardPct = (standard / total) * 100;
  const thinPct = (thin / total) * 100;

  return (
    <div
      className="flex items-center gap-2"
      data-testid="usp-quality-mini-bar"
      title={`${t('quality_rich')}: ${rich}, ${t('quality_standard')}: ${standard}, ${t('quality_thin')}: ${thin}`}
    >
      <span className="text-xs text-muted">{t('quality_rich').charAt(0).toUpperCase()}:</span>
      <div className="w-16 h-2 bg-background-muted rounded-full overflow-hidden flex">
        {richPct > 0 && <div className="h-full bg-success" style={{ width: `${richPct}%` }} />}
        {standardPct > 0 && (
          <div className="h-full bg-warning" style={{ width: `${standardPct}%` }} />
        )}
        {thinPct > 0 && <div className="h-full bg-error" style={{ width: `${thinPct}%` }} />}
      </div>
    </div>
  );
}

// ─── Quality Bar ────────────────────────────────────────────────────────────

function QualityBar({
  job,
  t,
}: {
  job: CrawlJob;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  t: (key: string, values?: any) => string;
}) {
  const qualityMetrics = (job.results as Record<string, unknown>)?.qualityMetrics as
    | { avgQualityScore?: number; successRate?: number }
    | undefined;

  if (!qualityMetrics?.avgQualityScore) {
    return null;
  }

  // avgQualityScore and successRate are 0-1 scale from backend — convert to %
  const scorePct = Math.min((qualityMetrics.avgQualityScore ?? 0) * 100, 100);
  const successRatePct = Math.min((qualityMetrics.successRate ?? 0) * 100, 100);

  const goodWidth = scorePct;
  const issueWidth = Math.max(0, 100 - scorePct);

  return (
    <div className="space-y-1" data-testid="usp-quality-bar">
      <div className="flex items-center justify-between text-xs text-muted">
        <span>{t('quality_label')}</span>
        <span>
          {t('quality_stats', {
            score: Math.round(scorePct),
            successRate: Math.round(successRatePct),
          })}
        </span>
      </div>
      <div className="w-full h-2 bg-background-muted rounded-full overflow-hidden flex">
        <div className="h-full bg-success rounded-l-full" style={{ width: `${goodWidth}%` }} />
        {issueWidth > 0 && (
          <div className="h-full bg-warning rounded-r-full" style={{ width: `${issueWidth}%` }} />
        )}
      </div>
    </div>
  );
}
