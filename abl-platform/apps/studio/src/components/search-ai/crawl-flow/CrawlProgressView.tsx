'use client';

/**
 * CrawlProgressView — Reusable crawl progress display component.
 *
 * Pure progress visualisation: progress bar, phase cards, quality breakdown,
 * failure grouping, section fill rates, skipped URLs, WS/REST data sources.
 *
 * NO actions, NO dialogs, NO navigation — consumers wrap this with their own chrome:
 * - State4Crawl (wizard): cancel/back/backgrounding dialogs, completion summary
 * - USP Pages tab: leverages USPActionsBar for cancel/background, auto-transitions
 */

import { useState, useMemo, useCallback, useEffect, useRef } from 'react';
import { useTranslations } from 'next-intl';
import {
  CheckCircle2,
  XCircle,
  Loader2,
  AlertTriangle,
  BarChart3,
  Clock,
  ChevronDown,
  WifiOff,
} from 'lucide-react';
import { Card } from '@/components/ui/Card';
import { getCrawlStatus } from '@/api/crawl';
import { useCrawlProgress } from '@/hooks/useCrawlProgress';
import { useMultiPageProgress, type PageProgress } from '@/hooks/useMultiPageProgress';
import type {
  CrawlProgressViewProps,
  CrawlProgressResult,
  QualityBreakdown,
  CrawlSection,
} from './types';

// ─── Progress Bar ────────────────────────────────────────────────────────────

function ProgressBar({ value }: { value: number }) {
  return (
    <div className="h-2 w-full rounded-full bg-background-muted overflow-hidden">
      <div
        className="h-full rounded-full bg-accent transition-all duration-500"
        style={{ width: `${Math.min(100, Math.max(0, value))}%` }}
      />
    </div>
  );
}

// ─── Phase indicator ────────────────────────────────────────────────────────

function PhaseCard({
  label,
  value,
  subtitle,
  failed,
}: {
  label: string;
  value: number;
  subtitle: string;
  failed?: number;
}) {
  return (
    <Card padding="md" hoverable={false}>
      <p className="text-xs font-medium text-muted mb-1">{label}</p>
      <p className="text-2xl font-bold text-foreground">{value}</p>
      <p className="text-xs text-muted mt-0.5">
        {subtitle}
        {failed != null && failed > 0 && <span className="text-error"> ({failed} failed)</span>}
      </p>
    </Card>
  );
}

// ─── Failure grouping ─────────────────────────────────────────────────────────

interface FailureGroup {
  reason: string;
  urls: string[];
}

function groupFailures(pages: Record<string, PageProgress>): FailureGroup[] {
  const groups = new Map<string, string[]>();
  for (const [url, page] of Object.entries(pages)) {
    if (page.status !== 'failed') continue;
    const reason = page.error ?? 'Unknown error';
    const existing = groups.get(reason);
    if (existing) {
      existing.push(url);
    } else {
      groups.set(reason, [url]);
    }
  }
  return Array.from(groups.entries())
    .map(([reason, urls]) => ({ reason, urls }))
    .sort((a, b) => b.urls.length - a.urls.length);
}

// ─── Quality breakdown ───────────────────────────────────────────────────────

function computeQuality(pages: Record<string, PageProgress>): QualityBreakdown {
  const result: QualityBreakdown = { good: 0, thin: 0, empty: 0, unknown: 0 };
  for (const page of Object.values(pages)) {
    if (page.status !== 'completed' && page.status !== 'saved') continue;
    if (page.quality === 'good' || (page.qualityScore != null && page.qualityScore >= 0.5)) {
      result.good++;
    } else if (page.quality === 'thin' || (page.qualityScore != null && page.qualityScore > 0)) {
      result.thin++;
    } else if (page.quality === 'empty') {
      result.empty++;
    } else {
      result.unknown++;
    }
  }
  return result;
}

// ─── Section Fill Rates ─────────────────────────────────────────────────────

/** Max sections to show individually before collapsing to summary */
const SECTION_COLLAPSE_THRESHOLD = 10;

function SectionFillRates({
  sectionFill,
  t,
}: {
  sectionFill: Array<{ name: string; completed: number; total: number }>;
  t: ReturnType<typeof useTranslations>;
}) {
  const [expanded, setExpanded] = useState(false);
  const shouldCollapse = sectionFill.length > SECTION_COLLAPSE_THRESHOLD;
  const visibleSections = shouldCollapse && !expanded ? sectionFill.slice(0, 5) : sectionFill;

  // Summary stats for collapsed view
  const totalCompleted = sectionFill.reduce((sum, s) => sum + s.completed, 0);
  const totalAll = sectionFill.reduce((sum, s) => sum + s.total, 0);
  const completedSections = sectionFill.filter((s) => s.total > 0 && s.completed >= s.total).length;

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <h4 className="text-sm font-medium text-foreground">{t('section_fill')}</h4>
        {shouldCollapse && (
          <button
            onClick={() => setExpanded(!expanded)}
            className="text-xs text-accent hover:text-accent/80 transition-default"
          >
            {expanded
              ? t('section_fill_collapse')
              : t('section_fill_expand', { count: sectionFill.length })}
          </button>
        )}
      </div>

      {/* Summary bar when collapsed */}
      {shouldCollapse && !expanded && (
        <div className="text-xs text-muted">
          {t('section_fill_summary', {
            completed: completedSections,
            total: sectionFill.length,
            pages: totalCompleted,
            allPages: totalAll,
          })}
        </div>
      )}

      <div className="space-y-1.5">
        {visibleSections.map((s) => (
          <div key={s.name} className="flex items-center gap-2 text-xs">
            <span className="w-32 truncate text-muted" title={s.name}>
              {s.name}
            </span>
            <div className="flex-1 h-1.5 rounded-full bg-background-muted overflow-hidden">
              <div
                className="h-full rounded-full bg-accent transition-all"
                style={{
                  width: `${s.total > 0 ? Math.round((s.completed / s.total) * 100) : 0}%`,
                }}
              />
            </div>
            <span className="text-muted w-16 text-right">
              {s.completed}/{s.total}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── Main Component ─────────────────────────────────────────────────────────

export function CrawlProgressView({
  jobId,
  sourceId,
  url,
  sections = [],
  totalPages = 0,
  onComplete,
  onProgressUpdate,
  discoveryProgress,
  categoryCrawlStatus,
}: CrawlProgressViewProps) {
  const t = useTranslations('search_ai.crawl_flow');
  const [skippedUrls, setSkippedUrls] = useState<Array<{ url: string; reason: string }>>([]);
  const [showSkipped, setShowSkipped] = useState(false);
  const [wsConnected, setWsConnected] = useState(true);
  const [restProgress, setRestProgress] = useState<{
    total: number;
    completed: number;
    failed: number;
    percentage: number;
    isDone: boolean;
    isFailed: boolean;
  } | null>(null);
  const pollIntervalRef = useRef<NodeJS.Timeout | null>(null);

  // Real-time progress via WebSocket
  const crawlProgress = useCrawlProgress(jobId);
  const multiPage = useMultiPageProgress(jobId);

  // Derive overall progress — prefer WS data, fall back to REST polling
  const progressData =
    crawlProgress.lastEvent?.data?.progress ??
    (restProgress
      ? {
          total: restProgress.total,
          completed: restProgress.completed,
          failed: restProgress.failed,
          percentage: restProgress.percentage,
        }
      : null);
  const percentage = progressData?.percentage ?? 0;
  const completedCount = progressData?.completed ?? 0;
  const failedCount = progressData?.failed ?? 0;
  const totalCount = progressData?.total ?? totalPages;

  // Check if done
  const isDone =
    multiPage.isComplete ||
    crawlProgress.lastEvent?.type === 'job_completed' ||
    crawlProgress.lastEvent?.type === 'intelligence_crawl_complete' ||
    restProgress?.isDone === true;

  const isFailed =
    multiPage.isFailed ||
    crawlProgress.lastEvent?.type === 'job_failed' ||
    crawlProgress.lastEvent?.type === 'intelligence_crawl_failed' ||
    restProgress?.isFailed === true;

  // Sticky refs — once terminal, never revert (prevents flicker on late WS events)
  const isDoneRef = useRef(false);
  const isFailedRef = useRef(false);
  if (isDone) isDoneRef.current = true;
  if (isFailed) isFailedRef.current = true;
  const effectiveIsDone = isDoneRef.current;
  const effectiveIsFailed = isFailedRef.current;

  // Compute quality + thin count for terminal snapshot
  const quality = useMemo(() => computeQuality(multiPage.pages), [multiPage.pages]);
  const thinCount = useMemo(() => {
    return Object.values(multiPage.pages).filter(
      (p) =>
        (p.status === 'completed' || p.status === 'saved') &&
        (p.quality === 'thin' ||
          (p.qualityScore != null && p.qualityScore < 0.5 && p.qualityScore > 0)),
    ).length;
  }, [multiPage.pages]);

  // Fire onComplete once when terminal state is reached
  const completeFiredRef = useRef(false);
  useEffect(() => {
    if ((effectiveIsDone || effectiveIsFailed) && !completeFiredRef.current) {
      completeFiredRef.current = true;
      onComplete?.({
        state: effectiveIsDone ? 'done' : 'failed',
        completedCount,
        failedCount,
        totalCount,
        quality,
        thinCount,
      });
    }
  }, [
    effectiveIsDone,
    effectiveIsFailed,
    onComplete,
    completedCount,
    failedCount,
    totalCount,
    quality,
    thinCount,
  ]);

  // Fire onProgressUpdate on each progress change
  useEffect(() => {
    onProgressUpdate?.({ completedCount, failedCount, totalCount });
  }, [completedCount, failedCount, totalCount, onProgressUpdate]);

  // Track url_skipped events from the crawl progress stream (display capped at 200)
  const skippedTotalRef = useRef(0);

  useEffect(() => {
    const event = crawlProgress.lastEvent;
    if (event?.type === 'url_skipped' && event.data?.url) {
      skippedTotalRef.current++;
      setSkippedUrls((prev) => {
        if (prev.length >= 200) return prev; // Cap display entries to prevent unbounded growth
        return [
          ...prev,
          {
            url: event.data?.url ?? '',
            reason: event.data?.skipReason ?? event.data?.reason ?? 'Unknown',
          },
        ];
      });
    }
  }, [crawlProgress.lastEvent]);

  // Track WS connection status — fall back to polling after WS failure
  const POLL_INTERVAL = 10_000;

  useEffect(() => {
    if (crawlProgress.error && !crawlProgress.connected && !crawlProgress.isReconnecting) {
      setWsConnected(false);
    } else if (crawlProgress.connected) {
      setWsConnected(true);
    }
  }, [crawlProgress.error, crawlProgress.connected, crawlProgress.isReconnecting]);

  // REST polling fallback when WS is unavailable
  useEffect(() => {
    if (wsConnected || effectiveIsDone || effectiveIsFailed) {
      if (pollIntervalRef.current) {
        clearInterval(pollIntervalRef.current);
        pollIntervalRef.current = null;
      }
      return;
    }

    const poll = async () => {
      try {
        const status = await getCrawlStatus(jobId);
        const total = status.urls ?? totalPages;
        setRestProgress({
          total,
          completed: status.crawled ?? 0,
          failed: status.failed ?? 0,
          percentage: total > 0 ? Math.round(((status.crawled ?? 0) / total) * 100) : 0,
          isDone: status.state === 'completed',
          isFailed: status.state === 'failed' || status.state === 'cancelled',
        });
      } catch {
        // REST poll failed — will retry next interval
      }
    };

    poll(); // Immediate first poll
    pollIntervalRef.current = setInterval(poll, POLL_INTERVAL);

    return () => {
      if (pollIntervalRef.current) {
        clearInterval(pollIntervalRef.current);
        pollIntervalRef.current = null;
      }
    };
  }, [wsConnected, effectiveIsDone, effectiveIsFailed, jobId, totalPages]);

  // Failure groups
  const failureGroups = useMemo(() => groupFailures(multiPage.pages), [multiPage.pages]);

  // Section fill rates
  const sectionFill = useMemo(() => {
    // Priority 1: intelligence group progress (for intelligence crawls)
    const fills: Array<{ name: string; completed: number; total: number }> = [];
    for (const [group, progress] of Object.entries(multiPage.groupProgress)) {
      fills.push({ name: group, completed: progress.completed, total: progress.total });
    }
    if (fills.length > 0) return fills;

    // Priority 2: derive from bulk crawl job_completed event's sections data
    const completedEvent = crawlProgress.events.find((e) => e.type === 'job_completed');
    if (completedEvent?.data?.sections && Array.isArray(completedEvent.data.sections)) {
      for (const s of completedEvent.data.sections) {
        const sec = s as { sectionId: string; name: string; count: number };
        const matchingSection = sections.find(
          (section) => (section.sectionId ?? '') === sec.sectionId,
        );
        fills.push({
          name: sec.name,
          completed: sec.count,
          total: matchingSection?.pageCount ?? sec.count,
        });
      }
      if (fills.length > 0) return fills;
    }

    // Priority 3: fallback — sections from props with overall progress
    for (const section of sections.filter((s) => s.included)) {
      fills.push({
        name: section.name,
        completed: sections.length === 1 ? completedCount : 0,
        total: section.pageCount,
      });
    }
    return fills;
  }, [multiPage.groupProgress, crawlProgress.events, sections, completedCount]);

  // ─── Render ─────────────────────────────────────────────────────────

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-base font-semibold text-foreground">
            {effectiveIsDone
              ? t('crawl_complete')
              : effectiveIsFailed
                ? t('crawl_failed_title')
                : t('crawl_in_progress')}
          </h3>
          <p className="text-sm text-muted mt-0.5">{url}</p>
        </div>
        <div className="flex items-center gap-2">
          {/* Connection indicator */}
          {crawlProgress.connected && !effectiveIsDone && !effectiveIsFailed && (
            <span className="flex items-center gap-1 text-xs text-success">
              <span className="w-1.5 h-1.5 rounded-full bg-success animate-pulse" />
              {t('crawl_live')}
            </span>
          )}
          {/* Polling fallback indicator */}
          {!wsConnected && !effectiveIsDone && !effectiveIsFailed && (
            <span className="flex items-center gap-1 text-xs text-muted">
              <WifiOff className="w-3 h-3" />
              {t('crawl_polling_fallback')}
            </span>
          )}
        </div>
      </div>

      {/* Progress bar (hide when done) */}
      {!effectiveIsDone && !effectiveIsFailed && (
        <div className="space-y-2">
          <ProgressBar value={percentage} />
          <div className="flex justify-between text-xs text-muted">
            <span>
              {completedCount} / {totalCount} {t('pages_processed')}
            </span>
            <span>{Math.round(percentage)}%</span>
          </div>
        </div>
      )}

      {/* Phase cards */}
      <div className="grid grid-cols-3 gap-3">
        <PhaseCard
          label={t('phase_crawled')}
          value={multiPage.fastCount + multiPage.aiCount || completedCount}
          subtitle={
            multiPage.fastCount > 0 || multiPage.aiCount > 0
              ? t('step4_method_summary', {
                  httpCount: multiPage.fastCount,
                  browserCount: multiPage.aiCount,
                })
              : t('pages_label')
          }
        />
        <PhaseCard
          label={t('phase_processed')}
          value={
            Object.values(multiPage.pages).filter(
              (p) => p.status === 'completed' || p.status === 'saved',
            ).length
          }
          subtitle={t('pages_label')}
        />
        <PhaseCard label={t('phase_failed')} value={failedCount} subtitle={t('pages_label')} />
      </div>

      {/* Quality breakdown (show when there's data) */}
      {(quality.good > 0 || quality.thin > 0 || quality.empty > 0) && (
        <div className="space-y-2">
          <h4 className="text-sm font-medium text-foreground flex items-center gap-1.5">
            <BarChart3 className="w-4 h-4" />
            {t('quality_distribution')}
          </h4>
          <div className="flex gap-4 text-xs">
            <span className="flex items-center gap-1">
              <CheckCircle2 className="w-3.5 h-3.5 text-success" />
              {quality.good} {t('quality_good')}
            </span>
            <span className="flex items-center gap-1">
              <AlertTriangle className="w-3.5 h-3.5 text-warning" />
              {quality.thin} {t('quality_thin')}
            </span>
            {quality.empty > 0 && (
              <span className="flex items-center gap-1">
                <XCircle className="w-3.5 h-3.5 text-error" />
                {quality.empty} {t('quality_empty')}
              </span>
            )}
          </div>
        </div>
      )}

      {/* Dual progress bars (crawl-as-you-discover mode) */}
      {discoveryProgress && (
        <div className="space-y-2">
          <h4 className="text-sm font-medium text-foreground">{t('step4_dual_progress')}</h4>
          <div className="space-y-1.5">
            <div className="flex items-center gap-2 text-xs">
              <span className="w-20 text-muted">{t('step4_discovery_bar')}</span>
              <div className="flex-1">
                <ProgressBar value={discoveryProgress.isRunning ? 50 : 100} />
              </div>
              <span className="text-muted w-20 text-right">
                {discoveryProgress.discoveredUrls} URLs
              </span>
            </div>
            <div className="flex items-center gap-2 text-xs">
              <span className="w-20 text-muted">{t('step4_crawl_bar')}</span>
              <div className="flex-1">
                <ProgressBar value={percentage} />
              </div>
              <span className="text-muted w-20 text-right">
                {completedCount}/{totalCount}
              </span>
            </div>
          </div>
        </div>
      )}

      {/* Per-category crawl status */}
      {categoryCrawlStatus && categoryCrawlStatus.length > 0 && (
        <div className="space-y-2">
          <h4 className="text-sm font-medium text-foreground">{t('step4_category_status')}</h4>
          <div className="space-y-1.5">
            {categoryCrawlStatus.map((cat) => (
              <div key={cat.category} className="flex items-center gap-2 text-xs">
                {cat.status === 'complete' && (
                  <CheckCircle2 className="w-3.5 h-3.5 text-success flex-shrink-0" />
                )}
                {cat.status === 'crawling' && (
                  <Loader2 className="w-3.5 h-3.5 text-accent animate-spin flex-shrink-0" />
                )}
                {cat.status === 'queued' && (
                  <Clock className="w-3.5 h-3.5 text-muted flex-shrink-0" />
                )}
                {cat.status === 'failed' && (
                  <XCircle className="w-3.5 h-3.5 text-error flex-shrink-0" />
                )}
                <span className="w-32 truncate text-muted" title={cat.category}>
                  {cat.category}
                </span>
                <div className="flex-1 h-1.5 rounded-full bg-background-muted overflow-hidden">
                  <div
                    className="h-full rounded-full bg-accent transition-all"
                    style={{
                      width: `${cat.total > 0 ? Math.round((cat.crawled / cat.total) * 100) : 0}%`,
                    }}
                  />
                </div>
                <span className="text-muted w-16 text-right">
                  {cat.crawled}/{cat.total}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Section fill rates */}
      {sectionFill.length > 0 && <SectionFillRates sectionFill={sectionFill} t={t} />}

      {/* Failure details */}
      {failureGroups.length > 0 && (
        <div className="space-y-2">
          <h4 className="text-sm font-medium text-foreground flex items-center gap-1.5">
            <AlertTriangle className="w-4 h-4 text-error" />
            {t('failures_title')}
          </h4>
          <div className="space-y-2">
            {failureGroups.map((group) => (
              <div key={group.reason} className="rounded-md bg-background-muted p-3 text-xs">
                <p className="font-medium text-foreground">
                  {group.urls.length} {t('pages_label')} — {group.reason}
                </p>
                <div className="mt-1 space-y-0.5 text-muted max-h-24 overflow-y-auto">
                  {group.urls.slice(0, 5).map((u) => (
                    <p key={u} className="truncate" title={u}>
                      {u}
                    </p>
                  ))}
                  {group.urls.length > 5 && (
                    <p className="text-muted">
                      +{group.urls.length - 5} {t('more')}
                    </p>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Skipped URLs (collapsible) */}
      {skippedUrls.length > 0 && (
        <div className="space-y-2">
          <button
            onClick={() => setShowSkipped(!showSkipped)}
            className="flex items-center gap-1 text-sm text-muted hover:text-foreground transition-default"
          >
            <ChevronDown
              className={`w-3.5 h-3.5 transition-transform ${showSkipped ? 'rotate-0' : '-rotate-90'}`}
            />
            {t('crawl_skipped_urls', { count: skippedTotalRef.current || skippedUrls.length })}
          </button>
          {showSkipped && (
            <ul className="space-y-1 text-xs text-muted max-h-40 overflow-y-auto">
              {skippedUrls.map((s, i) => (
                <li key={i} className="truncate" title={`${s.url} — ${s.reason}`}>
                  {s.url} — {s.reason}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
