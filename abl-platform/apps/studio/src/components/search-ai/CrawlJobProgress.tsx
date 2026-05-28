/**
 * CrawlJobProgress Component
 *
 * Real-time crawl job progress with:
 * - WebSocket for live updates (badge: "Live")
 * - Polling fallback if WebSocket disconnects (badge: "Polling")
 * - Multi-phase progress visualisation (crawl -> ingest -> extract -> index)
 */

import { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import useSWR from 'swr';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { Card } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import { Alert } from '@/components/ui/Alert';
import {
  Wifi,
  WifiOff,
  CheckCircle2,
  XCircle,
  FileText,
  Plus,
  RotateCw,
  StopCircle,
  Clock,
  List,
  Trash2,
  Pause,
  Play,
  ChevronDown,
  ChevronRight,
} from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { getCrawlDashboard, cancelCrawlJob, deleteCrawlJob } from '@/api/crawl';
import { useCrawlProgress } from '@/hooks/useCrawlProgress';
import { useMultiPageProgress, type PageProgress } from '@/hooks/useMultiPageProgress';

// ---------------------------------------------------------------------------
// Mini progress bar (no dependency on external Progress component)
// ---------------------------------------------------------------------------

function ProgressBar({ value, className }: { value: number; className?: string }) {
  return (
    <div
      className={`h-1.5 w-full rounded-full bg-background-muted overflow-hidden ${className ?? ''}`}
    >
      <div
        className="h-full rounded-full bg-accent transition-all duration-500"
        style={{ width: `${Math.min(100, Math.max(0, value))}%` }}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Phase card
// ---------------------------------------------------------------------------

interface PhaseCardProps {
  label: string;
  value: number;
  subtitle: string;
  failed?: number;
}

function PhaseCard({ label, value, subtitle, failed }: PhaseCardProps) {
  const t = useTranslations('search_ai.crawl_progress');
  return (
    <Card padding="md" hoverable={false}>
      <p className="text-xs font-medium text-muted mb-1">{label}</p>
      <p className="text-2xl font-bold text-foreground">{value}</p>
      <p className="text-xs text-muted mt-0.5">
        {subtitle}
        {failed != null && failed > 0 && (
          <span className="text-error"> ({t('n_failed', { n: failed })})</span>
        )}
      </p>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Helpers for intelligence progress
// ---------------------------------------------------------------------------

const PAGE_STATUS_ORDER: Record<string, number> = {
  analyzing: 0,
  completed: 1,
  reused: 1,
  saved: 2,
  failed: 3,
  queued: 4,
};

function statusIcon(status: PageProgress['status']): string {
  switch (status) {
    case 'analyzing':
      return '\u{1F504}';
    case 'completed':
    case 'reused':
    case 'saved':
      return '\u2705';
    case 'failed':
      return '\u274C';
    case 'queued':
      return '\u23F3';
    default:
      return '';
  }
}

function formatElapsed(startedAt?: string, completedAt?: string): string | null {
  if (!startedAt) return null;
  const start = new Date(startedAt).getTime();
  const end = completedAt ? new Date(completedAt).getTime() : Date.now();
  const seconds = Math.round((end - start) / 1000);
  if (seconds < 60) return `${seconds}s`;
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return `${mins}m ${secs}s`;
}

function truncateUrl(url: string, maxLen = 40): string {
  try {
    const parsed = new URL(url);
    const path = parsed.pathname + parsed.search;
    if (path.length <= maxLen) return path;
    return path.slice(0, maxLen - 3) + '...';
  } catch {
    if (url.length <= maxLen) return url;
    return url.slice(0, maxLen - 3) + '...';
  }
}

// ---------------------------------------------------------------------------
// Timeline Expanded Detail Panel (V7 — per-page detail)
// ---------------------------------------------------------------------------

interface PageDetailPanelProps {
  page: PageProgress;
  t: ReturnType<typeof useTranslations<'search_ai.crawl_progress'>>;
}

function PageDetailPanel({ page, t }: PageDetailPanelProps) {
  const flags = page.interactiveFlags ?? [];
  return (
    <div className="ml-6 mt-1 mb-2 p-2 rounded bg-background-muted text-xs space-y-2">
      {/* What happened */}
      <div>
        <p className="font-semibold text-foreground mb-1">{t('what_happened')}</p>
        <ul className="list-disc list-inside space-y-0.5 text-muted">
          {/* A11 method reason */}
          <li>
            {page.method === 'playwright' ? t('a11_playwright_reason') : t('a11_http_reason')}
          </li>
          {/* A7 quality reason */}
          <li>
            {page.qualityScore != null && page.qualityScore >= 0.5
              ? t('a7_good_reason', { score: Math.round((page.qualityScore ?? 0) * 100) })
              : t('a7_blocked_reason')}
          </li>
          {/* A8 interactive flags */}
          <li>{flags.length > 0 ? t('a8_detected', { types: flags.join(', ') }) : t('a8_none')}</li>
        </ul>
      </div>
      {/* Extraction detail */}
      <div>
        <p className="font-semibold text-foreground mb-1">{t('extraction_detail')}</p>
        <ul className="list-disc list-inside space-y-0.5 text-muted">
          <li>
            {page.method === 'playwright'
              ? t('extraction_method_playwright')
              : t('extraction_method_http')}
          </li>
          <li>
            {page.handlerReused ? t('extraction_handler_reused') : t('extraction_handler_fresh')}
          </li>
          {page.quality && <li>{t('extraction_quality', { quality: page.quality })}</li>}
        </ul>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Group Progress Section (A3 + A11)
// ---------------------------------------------------------------------------

interface GroupProgressSectionProps {
  groupProgress: Record<string, { completed: number; total: number; method: string }>;
  t: ReturnType<typeof useTranslations<'search_ai.crawl_progress'>>;
}

function GroupProgressSection({ groupProgress, t }: GroupProgressSectionProps) {
  const entries = Object.entries(groupProgress);
  if (entries.length === 0) return null;

  return (
    <Card padding="md" hoverable={false}>
      <h4 className="text-xs font-semibold text-foreground mb-3">{t('group_progress')}</h4>
      <div className="space-y-2.5">
        {entries.map(([pattern, info]) => {
          const pct = info.total > 0 ? Math.round((info.completed / info.total) * 100) : 0;
          const methodIcon = info.method === 'playwright' ? '\u{1F50D}' : '\u26A1';
          return (
            <div key={pattern}>
              <div className="flex items-center justify-between text-xs mb-1">
                <span className="font-mono text-muted truncate" title={pattern}>
                  {pattern}
                </span>
                <span className="text-muted shrink-0 ml-2">
                  {info.completed}/{info.total} {methodIcon}
                </span>
              </div>
              <div className="h-1.5 w-full rounded-full bg-background-muted overflow-hidden">
                <div
                  className="h-full rounded-full bg-accent transition-all duration-500"
                  style={{ width: `${pct}%` }}
                />
              </div>
            </div>
          );
        })}
      </div>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Crawl Completion Panel ("How the crawl went")
// ---------------------------------------------------------------------------

interface CrawlCompletionPanelProps {
  fastCount: number;
  aiCount: number;
  blockedCount: number;
  reusedCount: number;
  totalPages: number;
  pages?: PageProgress[];
  onViewPages?: () => void;
  t: ReturnType<typeof useTranslations<'search_ai.crawl_progress'>>;
}

function CrawlCompletionPanel({
  fastCount,
  aiCount,
  blockedCount,
  reusedCount,
  totalPages,
  pages,
  onViewPages,
  t,
}: CrawlCompletionPanelProps) {
  // Estimate: each fast page saves ~4 seconds vs AI analysis
  const savedMinutes = Math.max(1, Math.round((fastCount * 4) / 60));

  return (
    <Card padding="lg" hoverable={false}>
      <h4 className="text-sm font-semibold text-foreground mb-4">{t('how_crawl_went')}</h4>
      <div className="space-y-3 text-sm">
        {/* Fast extraction summary */}
        <div>
          <p className="text-foreground">
            {'\u26A1'} {t('fast_extraction_summary', { count: fastCount, total: totalPages })}
          </p>
          <p className="text-xs text-muted ml-5">{t('time_saved', { minutes: savedMinutes })}</p>
        </div>

        {/* AI analysis summary */}
        {aiCount > 0 && (
          <div>
            <p className="text-foreground">
              {'\u{1F50D}'} {t('ai_analysis_summary', { count: aiCount })}
            </p>
            <p className="text-xs text-muted ml-5">{t('ai_analysis_reason')}</p>
          </div>
        )}

        {/* Blocked/excluded summary */}
        {blockedCount > 0 && (
          <div>
            <p className="text-foreground">
              {'\u2717'} {t('excluded_summary', { count: blockedCount })}
            </p>
            {onViewPages && (
              <button
                className="text-xs text-accent hover:underline ml-5 cursor-pointer"
                onClick={onViewPages}
              >
                {t('view_excluded')} {'\u2192'}
              </button>
            )}
          </div>
        )}

        {/* Pattern reuse summary */}
        {reusedCount > 0 && (
          <div>
            <p className="text-foreground">
              {'\u{1F501}'} {t('pattern_reuse_summary', { count: reusedCount, total: totalPages })}
            </p>
          </div>
        )}

        {/* A8 interactive elements summary */}
        {(() => {
          const interactiveCount = pages
            ? pages.filter((p) => p.interactiveFlags && p.interactiveFlags.length > 0).length
            : 0;
          if (interactiveCount === 0) return null;
          return (
            <div>
              <p className="text-foreground">
                {'\u{1F3AF}'} {t('interactive_pages_summary', { count: interactiveCount })}
              </p>
            </div>
          );
        })()}
      </div>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Intelligence Progress View
// ---------------------------------------------------------------------------

const MAX_VISIBLE_PAGES = 10;

interface IntelligenceProgressProps {
  jobId: string;
  onRetry?: (jobId: string) => void;
  onStartNewCrawl?: () => void;
  onViewPages?: () => void;
  onDeleteJob?: () => void;
}

function IntelligenceProgress({
  jobId,
  onRetry,
  onStartNewCrawl,
  onViewPages,
  onDeleteJob,
}: IntelligenceProgressProps) {
  const t = useTranslations('search_ai.crawl_progress');
  const progress = useMultiPageProgress(jobId);
  const [cancelling, setCancelling] = useState(false);
  const [cancelError, setCancelError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [confirmAction, setConfirmAction] = useState<{ type: string } | null>(null);
  const [timelinePaused, setTimelinePaused] = useState(false);
  const [expandedUrls, setExpandedUrls] = useState<Set<string>>(new Set());
  const timelineEndRef = useRef<HTMLDivElement>(null);

  const toggleExpanded = useCallback((url: string) => {
    setExpandedUrls((prev) => {
      const next = new Set(prev);
      if (next.has(url)) {
        next.delete(url);
      } else {
        next.add(url);
      }
      return next;
    });
  }, []);

  const handleCancel = async () => {
    setCancelling(true);
    setCancelError(null);
    try {
      await cancelCrawlJob(jobId);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setCancelError(t('cancel_failed', { message: msg }));
    } finally {
      setCancelling(false);
    }
  };

  const handleDelete = async () => {
    setDeleting(true);
    try {
      await deleteCrawlJob(jobId);
      setDeleting(false);
      onDeleteJob?.();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('delete_failed'));
      setDeleting(false);
    }
  };

  // Derived page metrics
  const pages = Object.values(progress.pages);
  const completedCount = pages.filter(
    (p) => p.status === 'completed' || p.status === 'reused' || p.status === 'saved',
  ).length;
  const reusedCount = pages.filter((p) => p.handlerReused).length;
  const analyzedCount = pages.filter(
    (p) => !p.handlerReused && (p.status === 'completed' || p.status === 'saved'),
  ).length;
  const failedCount = pages.filter((p) => p.status === 'failed').length;
  const totalLlmCalls = pages.reduce((sum, p) => sum + p.llmCalls, 0);

  const percentage =
    progress.totalPages > 0 ? Math.round((completedCount / progress.totalPages) * 100) : 0;

  const isActive = !progress.isComplete && !progress.isFailed;

  // Sort pages: analyzing first, then completed/reused/saved, then failed, then queued
  const sortedPages = useMemo(() => {
    return [...pages].sort(
      (a, b) => (PAGE_STATUS_ORDER[a.status] ?? 99) - (PAGE_STATUS_ORDER[b.status] ?? 99),
    );
  }, [pages]);

  const visiblePages = sortedPages.slice(0, MAX_VISIBLE_PAGES);
  const remainingQueued = Math.max(0, sortedPages.length - MAX_VISIBLE_PAGES);

  // Auto-scroll timeline to bottom when new pages arrive (unless paused)
  useEffect(() => {
    if (!timelinePaused && timelineEndRef.current) {
      timelineEndRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [sortedPages.length, timelinePaused]);

  // ---------------------------------------------------------------------------
  // Completed state
  // ---------------------------------------------------------------------------
  if (progress.isComplete) {
    const summary = progress.summary;
    const totalPagesCount = summary?.totalPages ?? progress.totalPages;
    const summaryFastCount = summary?.fastCount ?? progress.fastCount;
    const summaryAiCount = summary?.aiCount ?? progress.aiCount;
    const summaryBlockedCount = summary?.blockedCount ?? progress.blockedCount;
    const summaryReusedCount = summary?.reused ?? reusedCount;

    return (
      <div className="space-y-4">
        {/* Summary card */}
        <Card padding="lg" hoverable={false}>
          <div className="flex items-center gap-3 mb-4">
            <CheckCircle2 className="w-5 h-5 text-success" />
            <div>
              <p className="text-sm font-semibold text-foreground">
                {t('intelligence_completed_title')}
              </p>
              <p className="text-xs text-muted">
                {t('intelligence_completed_desc', {
                  total: totalPagesCount,
                  reused: summaryReusedCount,
                  analyzed: (summary?.completed ?? completedCount) - summaryReusedCount,
                })}
              </p>
            </div>
          </div>

          {/* Method breakdown metrics */}
          <div className="flex flex-wrap items-center gap-4 text-xs mb-4">
            <span>
              {'\u26A1'} {t('fast_count', { count: summaryFastCount })}
            </span>
            <span>
              {'\u{1F50D}'} {t('ai_count', { count: summaryAiCount })}
            </span>
            {summaryBlockedCount > 0 && (
              <span>{t('blocked_count', { count: summaryBlockedCount })}</span>
            )}
          </div>

          {summary && (
            <div className="flex items-center gap-4 text-xs text-muted mb-4">
              <span>{t('total_llm_calls', { count: summary.llmCallsTotal })}</span>
            </div>
          )}

          <div className="flex flex-wrap gap-2">
            {onViewPages && (
              <Button variant="primary" size="sm" onClick={onViewPages}>
                <FileText className="w-3.5 h-3.5 mr-1.5" />
                {t('view_crawled_pages', { count: totalPagesCount })}
              </Button>
            )}
            {onStartNewCrawl && (
              <Button variant="secondary" size="sm" onClick={onStartNewCrawl}>
                <Plus className="w-3.5 h-3.5 mr-1.5" />
                {t('start_new_crawl')}
              </Button>
            )}
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setConfirmAction({ type: 'delete' })}
              loading={deleting}
            >
              <Trash2 className="w-3.5 h-3.5 mr-1.5" />
              {t('delete_job')}
            </Button>
          </div>
        </Card>

        {/* "How the crawl went" panel */}
        <CrawlCompletionPanel
          fastCount={summaryFastCount}
          aiCount={summaryAiCount}
          blockedCount={summaryBlockedCount}
          reusedCount={summaryReusedCount}
          totalPages={totalPagesCount}
          pages={pages}
          onViewPages={summaryBlockedCount > 0 ? onViewPages : undefined}
          t={t}
        />

        <ConfirmDialog
          open={confirmAction?.type === 'delete'}
          onClose={() => setConfirmAction(null)}
          onConfirm={() => {
            handleDelete();
            setConfirmAction(null);
          }}
          title={t('confirm_delete_title')}
          description={t('confirm_delete_desc')}
          variant="danger"
          loading={deleting}
        />
      </div>
    );
  }

  // ---------------------------------------------------------------------------
  // Failed state
  // ---------------------------------------------------------------------------
  if (progress.isFailed) {
    return (
      <div className="space-y-4">
        <Card padding="lg" hoverable={false}>
          <div className="flex items-center gap-3 mb-4">
            <XCircle className="w-5 h-5 text-error" />
            <div>
              <p className="text-sm font-semibold text-foreground">
                {t('intelligence_failed_title')}
              </p>
              <p className="text-xs text-muted">
                {progress.error ?? t('intelligence_failed_desc')}
              </p>
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            {onRetry && (
              <Button variant="primary" size="sm" onClick={() => onRetry(jobId)}>
                <RotateCw className="w-3.5 h-3.5 mr-1.5" />
                {t('retry_crawl')}
              </Button>
            )}
            {onStartNewCrawl && (
              <Button variant="secondary" size="sm" onClick={onStartNewCrawl}>
                <Plus className="w-3.5 h-3.5 mr-1.5" />
                {t('start_new_crawl')}
              </Button>
            )}
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setConfirmAction({ type: 'delete' })}
              loading={deleting}
            >
              <Trash2 className="w-3.5 h-3.5 mr-1.5" />
              {t('delete_job')}
            </Button>
          </div>
        </Card>

        <ConfirmDialog
          open={confirmAction?.type === 'delete'}
          onClose={() => setConfirmAction(null)}
          onConfirm={() => {
            handleDelete();
            setConfirmAction(null);
          }}
          title={t('confirm_delete_title')}
          description={t('confirm_delete_desc')}
          variant="danger"
          loading={deleting}
        />
      </div>
    );
  }

  // ---------------------------------------------------------------------------
  // Active / discovering state
  // ---------------------------------------------------------------------------
  return (
    <div className="space-y-4">
      {cancelError && <Alert variant="error">{cancelError}</Alert>}

      {/* Main progress card */}
      <Card padding="lg" hoverable={false}>
        <div className="space-y-4">
          {/* Title + connection badge */}
          <div className="flex items-center justify-between">
            <h3 className="text-base font-semibold text-foreground">
              {t('intelligence_progress_title')}
            </h3>
            <div className="flex items-center gap-2">
              {progress.connected ? (
                <Badge variant="success">
                  <Wifi className="w-3 h-3 mr-1" />
                  {t('connection_live')}
                </Badge>
              ) : (
                <Badge variant="default">
                  <WifiOff className="w-3 h-3 mr-1" />
                  {t('connection_polling')}
                </Badge>
              )}
            </div>
          </div>

          {/* Discovery phase */}
          {progress.discovering && (
            <p className="text-sm text-muted animate-pulse">
              {t('discovering')}
              {progress.totalPages > 0 && (
                <> {t('found_from_sitemap', { count: progress.totalPages })}</>
              )}
            </p>
          )}

          {/* Progress bar */}
          {progress.totalPages > 0 && (
            <div>
              <div className="flex items-center justify-between text-xs text-muted mb-1">
                <span>
                  {t('total_pages_label', {
                    completed: completedCount + failedCount,
                    total: progress.totalPages,
                  })}
                </span>
                <span>{percentage}%</span>
              </div>
              <ProgressBar value={percentage} />
            </div>
          )}

          {/* Metrics row */}
          <div className="flex flex-wrap items-center gap-4 text-xs">
            <span title={t('handler_reused_icon_label')}>
              {'\u26A1'} {t('fast_count', { count: progress.fastCount })}
            </span>
            <span title={t('analyzed_icon_label')}>
              {'\u{1F50D}'} {t('ai_count', { count: progress.aiCount })}
            </span>
            <span>
              {'\u274C'} {t('failed_count', { count: failedCount })}
            </span>
          </div>
          {progress.blockedCount > 0 && (
            <p className="text-xs text-muted">
              {t('blocked_count', { count: progress.blockedCount })}
            </p>
          )}

          {/* LLM budget */}
          <p className="text-xs text-muted">
            {t('llm_calls_budget', {
              used: totalLlmCalls,
              budget: progress.maxLlmCalls || '—',
            })}
          </p>

          {/* Current page + phase */}
          {progress.currentUrl && (
            <p className="text-xs text-muted font-mono">
              {t('current_page', { url: truncateUrl(progress.currentUrl) })}
            </p>
          )}
          {progress.currentPhase && (
            <p className="text-xs text-muted">
              {t('phase_label', {
                phase: progress.currentPhase,
                iteration: progress.currentIteration ?? '?',
                max: 8,
              })}
            </p>
          )}
        </div>
      </Card>

      {/* Group progress bars (A3 + A11) */}
      <GroupProgressSection groupProgress={progress.groupProgress} t={t} />

      {/* Decision Timeline — live pages list with algorithm labels */}
      {sortedPages.length > 0 && (
        <Card padding="md" hoverable={false} className="max-h-80 overflow-y-auto">
          {/* Timeline header with pause toggle */}
          <div className="flex items-center justify-between mb-2">
            <h4 className="text-xs font-semibold text-foreground">
              {t('intelligence_progress_title')}
            </h4>
            <Button variant="ghost" size="sm" onClick={() => setTimelinePaused((prev) => !prev)}>
              {timelinePaused ? (
                <>
                  <Play className="w-3 h-3 mr-1" />
                  {t('resume_timeline')}
                </>
              ) : (
                <>
                  <Pause className="w-3 h-3 mr-1" />
                  {t('pause_timeline')}
                </>
              )}
            </Button>
          </div>
          <div className="space-y-1">
            {visiblePages.map((page) => {
              const isExpanded = expandedUrls.has(page.url);
              const isTerminal =
                page.status === 'completed' ||
                page.status === 'reused' ||
                page.status === 'saved' ||
                page.status === 'failed';
              return (
                <div key={page.url}>
                  <div className="flex items-center gap-2 text-xs py-1 border-b border-default last:border-0">
                    {/* Expand toggle */}
                    {isTerminal ? (
                      <button
                        className="shrink-0 p-0.5 rounded hover:bg-background-muted cursor-pointer"
                        onClick={() => toggleExpanded(page.url)}
                        aria-label={isExpanded ? t('timeline_collapse') : t('timeline_expand')}
                      >
                        {isExpanded ? (
                          <ChevronDown className="w-3 h-3 text-muted" />
                        ) : (
                          <ChevronRight className="w-3 h-3 text-muted" />
                        )}
                      </button>
                    ) : (
                      <span className="w-4 shrink-0" />
                    )}
                    {/* Method icon */}
                    <span className="shrink-0">
                      {page.method === 'playwright' ? '\u{1F50D}' : '\u26A1'}
                    </span>
                    <span className="font-mono text-muted truncate flex-1" title={page.url}>
                      {truncateUrl(page.url)}
                    </span>
                    <span>{statusIcon(page.status)}</span>
                    <Badge
                      variant={
                        page.status === 'failed'
                          ? 'error'
                          : page.status === 'analyzing'
                            ? 'accent'
                            : page.status === 'queued'
                              ? 'default'
                              : 'success'
                      }
                    >
                      {page.status === 'analyzing'
                        ? t('analyzing_badge')
                        : page.status === 'queued'
                          ? t('queued_badge')
                          : page.status === 'failed'
                            ? t('fail_badge')
                            : page.status === 'reused'
                              ? t('reused_badge')
                              : page.status === 'saved'
                                ? t('saved_badge')
                                : t('done_badge')}
                    </Badge>
                    {/* Algorithm labels: A11 method + A7 quality */}
                    {page.method != null && (
                      <Badge variant={page.method === 'http' ? 'info' : 'purple'}>
                        {page.method === 'http' ? t('method_fast') : t('method_ai')}
                      </Badge>
                    )}
                    {page.qualityScore != null && (
                      <Badge variant={page.qualityScore >= 0.5 ? 'success' : 'warning'}>
                        {page.qualityScore >= 0.5 ? t('quality_good') : t('quality_blocked')}
                      </Badge>
                    )}
                    {page.startedAt != null && (
                      <span className="text-muted tabular-nums w-12 text-right shrink-0">
                        {t('time_elapsed', {
                          time: formatElapsed(page.startedAt, page.completedAt) ?? '',
                        })}
                      </span>
                    )}
                  </div>
                  {/* Expanded detail panel */}
                  {isExpanded && isTerminal && <PageDetailPanel page={page} t={t} />}
                </div>
              );
            })}
            {remainingQueued > 0 && (
              <p className="text-xs text-muted py-1">
                {t('more_queued', { count: remainingQueued })}
              </p>
            )}
            <div ref={timelineEndRef} />
          </div>
        </Card>
      )}

      {/* Cancel button */}
      {isActive && (
        <Button
          variant="danger"
          size="sm"
          onClick={() => setConfirmAction({ type: 'cancel' })}
          loading={cancelling}
        >
          <StopCircle className="w-3.5 h-3.5 mr-1.5" />
          {t('cancel_crawl')}
        </Button>
      )}

      {/* Confirm cancel dialog */}
      <ConfirmDialog
        open={confirmAction?.type === 'cancel'}
        onClose={() => setConfirmAction(null)}
        onConfirm={() => {
          handleCancel();
          setConfirmAction(null);
        }}
        title={t('confirm_cancel_title')}
        description={t('confirm_cancel_desc')}
        variant="danger"
        loading={cancelling}
      />

      {/* Confirm delete dialog */}
      <ConfirmDialog
        open={confirmAction?.type === 'delete'}
        onClose={() => setConfirmAction(null)}
        onConfirm={() => {
          handleDelete();
          setConfirmAction(null);
        }}
        title={t('confirm_delete_title')}
        description={t('confirm_delete_desc')}
        variant="danger"
        loading={deleting}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

interface CrawlJobProgressProps {
  jobId: string;
  strategy?: string;
  onStartNewCrawl?: () => void;
  onRetry?: (jobId: string) => void;
  onViewPages?: () => void;
  onDeleteJob?: () => void;
}

export function CrawlJobProgress({
  jobId,
  strategy,
  onStartNewCrawl,
  onRetry,
  onViewPages,
  onDeleteJob,
}: CrawlJobProgressProps) {
  const t = useTranslations('search_ai.crawl_progress');

  // Intelligence strategy renders a dedicated view
  if (strategy === 'intelligence') {
    return (
      <IntelligenceProgress
        jobId={jobId}
        onRetry={onRetry}
        onStartNewCrawl={onStartNewCrawl}
        onViewPages={onViewPages}
        onDeleteJob={onDeleteJob}
      />
    );
  }

  // WebSocket for live events
  const { connected, lastEvent, events, error: wsError, isReconnecting } = useCrawlProgress(jobId);
  const [cancelling, setCancelling] = useState(false);
  const [showEventLog, setShowEventLog] = useState(false);

  const [cancelError, setCancelError] = useState<string | null>(null);
  const [confirmAction, setConfirmAction] = useState<{ type: string } | null>(null);

  const handleCancel = async () => {
    setCancelling(true);
    setCancelError(null);
    try {
      await cancelCrawlJob(jobId);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setCancelError(t('cancel_failed', { message: msg }));
    } finally {
      setCancelling(false);
    }
  };

  const [deleting, setDeleting] = useState(false);

  const handleDelete = async () => {
    setDeleting(true);
    try {
      await deleteCrawlJob(jobId);
      setDeleting(false);
      onDeleteJob?.();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('delete_failed'));
      setDeleting(false);
    }
  };

  // Polling fallback -- only active when WebSocket is disconnected
  const { data: dashboard, error: queryError } = useSWR(
    jobId ? ['crawl-dashboard', jobId] : null,
    () => getCrawlDashboard(jobId),
    { refreshInterval: connected ? 0 : 5000 },
  );

  // ---------------------------------------------------------------------------
  // Derived state (must be before conditional returns)
  // ---------------------------------------------------------------------------

  const phase = dashboard?.phase;
  const isCompleted = phase === 'completed';
  const isFailed = phase === 'failed';
  const isCancelled = phase === 'cancelled';
  const isActive = !isCompleted && !isFailed && !isCancelled;
  const overallProgress = lastEvent?.data?.progress?.percentage ?? dashboard?.crawl?.progress ?? 0;

  // Auto-navigate to pages tab for single-page crawls
  // CRITICAL: This useEffect must run before any conditional returns
  useEffect(() => {
    if (isCompleted && dashboard?.crawl?.totalUrls === 1 && onViewPages) {
      const timer = setTimeout(() => onViewPages(), 1500);
      return () => clearTimeout(timer);
    }
  }, [isCompleted, dashboard?.crawl?.totalUrls, onViewPages]);

  // ---------------------------------------------------------------------------
  // Loading / error states
  // ---------------------------------------------------------------------------

  if (!dashboard && !lastEvent) {
    if (queryError || wsError) {
      return (
        <Alert variant="error">
          {wsError ??
            (queryError instanceof Error ? queryError.message : t('load_progress_failed'))}
        </Alert>
      );
    }
    return <div className="text-center py-8 text-sm text-muted">{t('loading_progress')}</div>;
  }

  if (!dashboard) return null;

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  return (
    <div className="space-y-4">
      {/* Cancel error feedback */}
      {cancelError && <Alert variant="error">{cancelError}</Alert>}

      {/* Header row */}
      <Card padding="lg" hoverable={false}>
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <h3 className="text-base font-semibold text-foreground">{t('crawl_progress_title')}</h3>
            <div className="flex items-center gap-2">
              {/* Cancel button */}
              {isActive && (
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => setConfirmAction({ type: 'cancel' })}
                  loading={cancelling}
                  className="text-error"
                >
                  <StopCircle className="w-3.5 h-3.5 mr-1" />
                  {t('cancel')}
                </Button>
              )}
              {/* Phase badge */}
              {isCompleted ? (
                <Badge variant="success" dot>
                  {t('phase_completed')}
                </Badge>
              ) : isCancelled ? (
                <Badge variant="warning" dot>
                  {t('phase_cancelled')}
                </Badge>
              ) : isFailed ? (
                <Badge variant="error" dot>
                  {t('phase_failed')}
                </Badge>
              ) : (
                <Badge variant="accent" dot>
                  {phase}
                </Badge>
              )}
              {/* Connection badge */}
              {connected ? (
                <Badge variant="success">
                  <Wifi className="w-3 h-3 mr-1" />
                  {t('connection_live')}
                </Badge>
              ) : isReconnecting ? (
                <Badge variant="warning">{t('connection_reconnecting')}</Badge>
              ) : (
                <Badge variant="default">
                  <WifiOff className="w-3 h-3 mr-1" />
                  {t('connection_polling')}
                </Badge>
              )}
            </div>
          </div>

          {/* Overall progress bar */}
          <div>
            <div className="flex items-center justify-between text-xs text-muted mb-1">
              <span className="capitalize">{phase}</span>
              <span>{Math.round(overallProgress)}%</span>
            </div>
            <ProgressBar value={overallProgress} />
            {/* ETA estimate */}
            {isActive && overallProgress > 5 && dashboard.crawl.totalUrls > 0 && (
              <p className="text-xs text-muted mt-1.5 flex items-center gap-1">
                <Clock className="w-3 h-3" />
                {(() => {
                  const started = dashboard.timeline?.started;
                  if (!started) return t('eta_estimating');
                  const elapsed = Date.now() - started;
                  const rate = overallProgress / Math.max(elapsed, 1);
                  const remaining = (100 - overallProgress) / rate;
                  const mins = Math.ceil(remaining / 60000);
                  if (mins <= 1) return t('eta_less_than_minute');
                  if (mins < 60) return t('eta_minutes', { n: mins });
                  return t('eta_hours', { n: Math.ceil(mins / 60) });
                })()}
              </p>
            )}
          </div>
        </div>
      </Card>

      {/* Phase detail cards */}
      <div className="grid grid-cols-2 gap-3">
        <PhaseCard
          label={t('phase_crawling')}
          value={dashboard.crawl.urlsCrawled}
          subtitle={t('of_total_urls', { total: dashboard.crawl.totalUrls })}
          failed={dashboard.crawl.urlsFailed}
        />
        <PhaseCard
          label={t('phase_documents')}
          value={dashboard.ingestion.documentsCreated}
          subtitle={t('created')}
          failed={dashboard.ingestion.documentsFailed}
        />
        <PhaseCard
          label={t('phase_chunks')}
          value={dashboard.extraction.chunksCreated}
          subtitle={t('extracted')}
        />
        <PhaseCard
          label={t('phase_indexed')}
          value={dashboard.indexing.chunksIndexed}
          subtitle={t('searchable')}
        />
      </div>

      {/* Latest event */}
      {lastEvent && lastEvent.type !== 'connected' && (
        <Alert variant="info" title={t('latest_event')}>
          <span className="capitalize">{lastEvent.type.replace(/_/g, ' ')}</span>
          {lastEvent.data?.url && (
            <>
              {' — '}
              <span className="font-mono text-xs break-all">{lastEvent.data.url}</span>
            </>
          )}
          {lastEvent.data?.error && (
            <>
              {' — '}
              <span className="text-error">{lastEvent.data.error.message}</span>
            </>
          )}
        </Alert>
      )}

      {/* Event log */}
      {events.length > 1 && (
        <Button
          variant="secondary"
          size="sm"
          onClick={() => setShowEventLog(!showEventLog)}
          className="w-full"
        >
          <List className="w-3.5 h-3.5 mr-1.5" />
          {showEventLog
            ? t('hide_event_log', { count: events.length })
            : t('show_event_log', { count: events.length })}
        </Button>
      )}

      {showEventLog && events.length > 0 && (
        <Card padding="md" hoverable={false} className="max-h-64 overflow-y-auto">
          <div className="space-y-1.5">
            {events
              .slice()
              .reverse()
              .map((evt, i) => (
                <div key={i} className="flex items-start gap-2 text-xs">
                  <span className="text-muted shrink-0 w-16 tabular-nums">
                    {new Date(evt.timestamp).toLocaleTimeString()}
                  </span>
                  <span className="capitalize">{evt.type.replace(/_/g, ' ')}</span>
                  {evt.data?.url && (
                    <span className="font-mono text-muted truncate">{evt.data.url}</span>
                  )}
                </div>
              ))}
          </div>
        </Card>
      )}

      {/* Post-completion actions */}
      {isCompleted && (
        <Card padding="lg" hoverable={false}>
          <div className="flex items-center gap-3 mb-4">
            <CheckCircle2 className="w-5 h-5 text-success" />
            <div>
              <p className="text-sm font-semibold text-foreground">{t('completed_title')}</p>
              <p className="text-xs text-muted">
                {t('completed_desc', {
                  count: dashboard.ingestion.documentsCreated,
                })}
              </p>
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            {onViewPages && (
              <Button variant="primary" size="sm" onClick={onViewPages}>
                <FileText className="w-3.5 h-3.5 mr-1.5" />
                {t('view_crawled_pages', { count: dashboard.ingestion.documentsCreated })}
              </Button>
            )}
            {onStartNewCrawl && (
              <Button variant="secondary" size="sm" onClick={onStartNewCrawl}>
                <Plus className="w-3.5 h-3.5 mr-1.5" />
                {t('start_new_crawl')}
              </Button>
            )}
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setConfirmAction({ type: 'delete' })}
              loading={deleting}
            >
              <Trash2 className="w-3.5 h-3.5 mr-1.5" />
              {t('delete_job')}
            </Button>
          </div>
        </Card>
      )}

      {isFailed && (
        <Card padding="lg" hoverable={false}>
          <div className="flex items-center gap-3 mb-4">
            <XCircle className="w-5 h-5 text-error" />
            <div>
              <p className="text-sm font-semibold text-foreground">{t('failed_title')}</p>
              <p className="text-xs text-muted">{t('failed_desc')}</p>
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            {onRetry && (
              <Button variant="primary" size="sm" onClick={() => onRetry(jobId)}>
                <RotateCw className="w-3.5 h-3.5 mr-1.5" />
                {t('retry_crawl')}
              </Button>
            )}
            {onStartNewCrawl && (
              <Button variant="secondary" size="sm" onClick={onStartNewCrawl}>
                <Plus className="w-3.5 h-3.5 mr-1.5" />
                {t('start_new_crawl')}
              </Button>
            )}
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setConfirmAction({ type: 'delete' })}
              loading={deleting}
            >
              <Trash2 className="w-3.5 h-3.5 mr-1.5" />
              {t('delete_job')}
            </Button>
          </div>
        </Card>
      )}

      {isCancelled && (
        <Card padding="lg" hoverable={false}>
          <div className="flex items-center gap-3 mb-4">
            <StopCircle className="w-5 h-5 text-warning" />
            <div>
              <p className="text-sm font-semibold text-foreground">{t('cancelled_title')}</p>
              <p className="text-xs text-muted">
                {t('cancelled_desc', {
                  count: dashboard.ingestion.documentsCreated,
                })}
              </p>
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            {onStartNewCrawl && (
              <Button variant="primary" size="sm" onClick={onStartNewCrawl}>
                <Plus className="w-3.5 h-3.5 mr-1.5" />
                {t('start_new_crawl')}
              </Button>
            )}
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setConfirmAction({ type: 'delete' })}
              loading={deleting}
            >
              <Trash2 className="w-3.5 h-3.5 mr-1.5" />
              {t('delete_job')}
            </Button>
          </div>
        </Card>
      )}

      {/* Confirm cancel dialog */}
      <ConfirmDialog
        open={confirmAction?.type === 'cancel'}
        onClose={() => setConfirmAction(null)}
        onConfirm={() => {
          handleCancel();
          setConfirmAction(null);
        }}
        title={t('confirm_cancel_title')}
        description={t('confirm_cancel_desc')}
        variant="danger"
        loading={cancelling}
      />

      {/* Confirm delete dialog */}
      <ConfirmDialog
        open={confirmAction?.type === 'delete'}
        onClose={() => setConfirmAction(null)}
        onConfirm={() => {
          handleDelete();
          setConfirmAction(null);
        }}
        title={t('confirm_delete_title')}
        description={t('confirm_delete_desc')}
        variant="danger"
        loading={deleting}
      />
    </div>
  );
}
