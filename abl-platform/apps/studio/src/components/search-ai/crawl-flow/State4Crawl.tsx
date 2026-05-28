'use client';

/**
 * State4Crawl — Step 4: Crawl Progress In-Panel (Wizard Wrapper)
 *
 * Thin wrapper around CrawlProgressView that adds wizard-specific chrome:
 * - Cancel/back confirmation dialogs
 * - Backgrounding to activity bar (3-option dialog)
 * - CrawlCompletionSummary card with "View Results" button
 * - Action bar (Back, Cancel, View Results)
 */

import { useState, useCallback } from 'react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import {
  CheckCircle2,
  AlertTriangle,
  ExternalLink,
  StopCircle,
  Loader2,
  RefreshCw,
} from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { Dialog } from '@/components/ui/Dialog';
import { cancelCrawlJob } from '@/api/crawl';
import { useDiscoveryStore } from '@/store/discovery-store';
import { CrawlProgressView } from './CrawlProgressView';
import type {
  State4CrawlProps,
  CrawlProgressResult,
  CrawlProgressStats,
  QualityBreakdown,
} from './types';

// ─── Completion Summary ─────────────────────────────────────────────────────

function CrawlCompletionSummary({
  completedCount,
  failedCount,
  thinCount,
  quality,
  totalCount,
  sourceId,
  onViewResults,
  t,
}: {
  completedCount: number;
  failedCount: number;
  thinCount: number;
  quality: QualityBreakdown;
  totalCount: number;
  sourceId: string;
  onViewResults: (sourceId: string, filter?: string) => void;
  t: ReturnType<typeof useTranslations>;
}) {
  const qualityTotal = quality.good + quality.thin + quality.empty + quality.unknown;
  const qualityPercent = qualityTotal > 0 ? Math.round((quality.good / qualityTotal) * 100) : 0;

  return (
    <Card padding="md" hoverable={false}>
      <div className="space-y-3">
        <div className="flex items-center gap-2">
          <CheckCircle2 className="w-5 h-5 text-success" />
          <h4 className="text-sm font-semibold text-foreground">{t('completion_summary_title')}</h4>
        </div>

        {/* Stats grid */}
        <div className="grid grid-cols-3 gap-4 text-center">
          <div>
            <p className="text-lg font-bold text-foreground">{completedCount}</p>
            <p className="text-xs text-muted">{t('completion_pages_crawled')}</p>
          </div>
          <div>
            <p className="text-lg font-bold text-foreground">{thinCount}</p>
            <p className="text-xs text-muted">{t('completion_thin_content')}</p>
          </div>
          <div>
            <p className="text-lg font-bold text-foreground">{failedCount}</p>
            <p className="text-xs text-muted">{t('completion_failed')}</p>
          </div>
        </div>

        {/* Quality percentage bar */}
        <div className="space-y-1">
          <div className="flex items-center justify-between text-xs">
            <span className="text-muted">{t('completion_quality')}</span>
            <span className="font-medium text-foreground">{qualityPercent}%</span>
          </div>
          <div className="h-2 w-full rounded-full bg-background-muted overflow-hidden">
            <div
              className="h-full rounded-full bg-success transition-all duration-500"
              style={{ width: `${qualityPercent}%` }}
            />
          </div>
        </div>

        {/* Actions */}
        <div className="flex items-center gap-2 pt-1">
          {thinCount > 0 && (
            <Button variant="secondary" size="xs" onClick={() => onViewResults(sourceId, 'thin')}>
              <AlertTriangle className="w-3 h-3 mr-1" />
              {t('completion_view_thin', { count: thinCount })}
            </Button>
          )}
          <Button variant="primary" size="sm" onClick={() => onViewResults(sourceId)}>
            <ExternalLink className="w-3.5 h-3.5 mr-1.5" />
            {t('view_results')}
          </Button>
        </div>
      </div>
    </Card>
  );
}

// ─── Main Component ─────────────────────────────────────────────────────────

export function State4Crawl({
  jobId,
  sourceId,
  url,
  sections,
  totalPages,
  onViewResults,
  onBack,
  onCrawlComplete,
  discoveryProgress,
  categoryCrawlStatus,
}: State4CrawlProps) {
  const t = useTranslations('search_ai.crawl_flow');
  const [showCancelConfirm, setShowCancelConfirm] = useState(false);
  const [showBackConfirm, setShowBackConfirm] = useState(false);
  const [isCancelling, setIsCancelling] = useState(false);
  const [terminalResult, setTerminalResult] = useState<CrawlProgressResult | null>(null);

  // Live progress stats — updated by CrawlProgressView on each WS/REST event.
  // Used by the backgrounding dialog which fires during ACTIVE crawl (terminalResult is null).
  const [liveStats, setLiveStats] = useState<CrawlProgressStats>({
    completedCount: 0,
    failedCount: 0,
    totalCount: 0,
  });

  // Discovery store for crawl backgrounding
  const addItem = useDiscoveryStore((s) => s.addItem);

  const handleProgressComplete = useCallback(
    (result: CrawlProgressResult) => {
      setTerminalResult(result);
      if (result.state === 'done') onCrawlComplete?.();
    },
    [onCrawlComplete],
  );

  // Mirror live stats from CrawlProgressView — for backgrounding dialog
  const handleProgressUpdate = useCallback((stats: CrawlProgressStats) => {
    setLiveStats(stats);
  }, []);

  const effectiveIsDone = terminalResult?.state === 'done';
  const effectiveIsFailed = terminalResult?.state === 'failed';

  // Cancel handler
  const handleCancel = useCallback(async () => {
    setIsCancelling(true);
    try {
      await cancelCrawlJob(jobId);
      toast.success(t('crawl_cancelled'));
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      toast.error(msg);
    } finally {
      setIsCancelling(false);
      setShowCancelConfirm(false);
    }
  }, [jobId, t]);

  return (
    <div className="space-y-6">
      <CrawlProgressView
        jobId={jobId}
        sourceId={sourceId}
        url={url}
        sections={sections}
        totalPages={totalPages}
        onComplete={handleProgressComplete}
        onProgressUpdate={handleProgressUpdate}
        discoveryProgress={discoveryProgress}
        categoryCrawlStatus={categoryCrawlStatus}
      />

      {/* Completion summary — wizard-specific */}
      {effectiveIsDone && terminalResult && (
        <CrawlCompletionSummary
          completedCount={terminalResult.completedCount}
          failedCount={terminalResult.failedCount}
          thinCount={terminalResult.thinCount}
          quality={terminalResult.quality}
          totalCount={terminalResult.totalCount}
          sourceId={sourceId}
          onViewResults={onViewResults}
          t={t}
        />
      )}

      {/* Actions */}
      <div className="flex items-center justify-between pt-2 border-t border-border-default">
        {effectiveIsDone ? (
          <>
            <Button variant="ghost" size="sm" onClick={onBack}>
              {t('button_back')}
            </Button>
            <div className="flex items-center gap-2">
              {(terminalResult?.thinCount ?? 0) > 0 && (
                <span className="text-xs text-muted flex items-center gap-1">
                  <RefreshCw className="w-3 h-3" />
                  {t('recrawl_thin_coming_soon', {
                    count: (terminalResult?.thinCount ?? 0).toString(),
                  })}
                </span>
              )}
              <Button variant="primary" size="sm" onClick={() => onViewResults(sourceId)}>
                <ExternalLink className="w-3.5 h-3.5 mr-1.5" />
                {t('view_results')}
              </Button>
            </div>
          </>
        ) : effectiveIsFailed ? (
          <>
            <Button variant="ghost" size="sm" onClick={onBack}>
              {t('button_back')}
            </Button>
            <Button variant="primary" size="sm" onClick={() => onViewResults(sourceId)}>
              {t('view_results')}
            </Button>
          </>
        ) : (
          <>
            <Button variant="ghost" size="sm" onClick={() => setShowBackConfirm(true)}>
              {t('button_back')}
            </Button>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => setShowCancelConfirm(true)}
              disabled={isCancelling}
            >
              {isCancelling ? (
                <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" />
              ) : (
                <StopCircle className="w-3.5 h-3.5 mr-1.5" />
              )}
              {t('cancel')}
            </Button>
          </>
        )}
      </div>

      {/* Cancel confirmation */}
      <ConfirmDialog
        open={showCancelConfirm}
        onClose={() => setShowCancelConfirm(false)}
        title={t('cancel_crawl_title')}
        description={t('cancel_crawl_desc')}
        confirmLabel={t('cancel_crawl_confirm')}
        onConfirm={handleCancel}
        variant="danger"
      />

      {/* Back confirmation — 3-option dialog for crawl backgrounding */}
      <Dialog
        open={showBackConfirm}
        onClose={() => setShowBackConfirm(false)}
        title={t('crawl_close_confirm_title')}
        maxWidth="sm"
      >
        <div className="space-y-3">
          <p className="text-sm text-muted">{t('crawl_close_confirm_description')}</p>
          <div className="space-y-2">
            <Button
              size="sm"
              className="w-full justify-start"
              variant="secondary"
              onClick={() => {
                // Minimize to activity bar — use liveStats for current progress
                const domain = (() => {
                  try {
                    return new URL(url).hostname;
                  } catch {
                    return url;
                  }
                })();
                addItem({
                  sourceId: jobId,
                  domain,
                  discoveredCount: liveStats.completedCount,
                  sectionCount: sections.filter((s) => s.included).length,
                  status: 'running',
                  ownerName: '',
                  ownerId: '',
                  isOwner: true,
                  type: 'crawl',
                  jobId,
                  crawlProgress: {
                    crawled: liveStats.completedCount,
                    total: liveStats.totalCount,
                    failed: liveStats.failedCount,
                  },
                });
                setShowBackConfirm(false);
                onBack();
              }}
            >
              {t('crawl_close_confirm_minimize')}
            </Button>
            <Button
              size="sm"
              className="w-full justify-start"
              variant="secondary"
              onClick={() => {
                setShowBackConfirm(false);
                onBack();
              }}
            >
              {t('back_during_crawl_confirm')}
            </Button>
            <Button
              size="sm"
              className="w-full justify-start"
              variant="ghost"
              onClick={() => setShowBackConfirm(false)}
            >
              {t('cancel')}
            </Button>
          </div>
        </div>
      </Dialog>
    </div>
  );
}
