'use client';

/**
 * UnifiedSourcePage — Orchestrator component for the Unified Source Page.
 *
 * Responsibilities:
 * - SWR cascade: KB → indexId → source + jobs + dashboard
 * - Job anchoring: stable display context across SWR refreshes
 * - Display state derivation from source + job
 * - Tab state synced to ?tab= URL param
 * - Loading / error / not-found handling
 * - Delegates rendering to zone components (Header, StatusStrip, Tabs, ActionsBar)
 */

import { Suspense, useState, useMemo, useCallback, useRef, useEffect } from 'react';
import { useSearchParams } from 'next/navigation';
import useSWR from 'swr';
import { toast } from 'sonner';
import { useTranslations } from 'next-intl';
import { AlertTriangle, FileX, Database } from 'lucide-react';

import type { SearchAISource, KnowledgeBaseDetail } from '@/api/search-ai';
import type { CrawlHistoryResponse } from '@/api/crawl';
import { recrawlSource } from '@/api/crawl';
import { deleteSource } from '@/api/search-ai';
import { useCrawlFlowStore } from '@/store/crawl-flow-store';
import { useNavigationStore } from '@/store/navigation-store';
import { EmptyState } from '@/components/ui/EmptyState';
import { Button } from '@/components/ui/Button';
import type { UnifiedSourcePageProps, USPTab } from './types';
import { deriveDisplayState, resolveDisplayJob, filterJobsBySource, parseTabParam } from './utils';
import { Tabs } from '@/components/ui/Tabs';
import { USPHeader } from './USPHeader';
import { USPStatusStrip } from './USPStatusStrip';
import { CrawledPagesView } from '@/components/search-ai/CrawledPagesView';
import { CrawlProgressView } from '@/components/search-ai/crawl-flow/CrawlProgressView';
import { CrawlJobHistory } from '@/components/search-ai/CrawlJobHistory';
import { USPSettingsTab } from './USPSettingsTab';
import { USPActionsBar } from './USPActionsBar';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';

// ─── SWR Response Types ─────────────────────────────────────────────────────

interface KBResponse {
  knowledgeBase: KnowledgeBaseDetail;
}

interface SourcesResponse {
  sources: SearchAISource[];
  total: number;
}

// ─── Skeleton ───────────────────────────────────────────────────────────────

function USPSkeleton() {
  return (
    <div className="flex flex-col gap-6 p-6 animate-pulse" data-testid="usp-skeleton">
      {/* Header skeleton */}
      <div className="flex items-center gap-3">
        <div className="h-4 w-48 bg-background-muted rounded" />
        <div className="h-5 w-20 bg-background-muted rounded-full" />
      </div>
      {/* Status strip skeleton */}
      <div className="h-24 bg-background-muted rounded-xl" />
      {/* Tabs skeleton */}
      <div className="flex gap-4 border-b border-default pb-2">
        <div className="h-8 w-16 bg-background-muted rounded" />
        <div className="h-8 w-16 bg-background-muted rounded" />
        <div className="h-8 w-16 bg-background-muted rounded" />
      </div>
      {/* Content skeleton */}
      <div className="h-64 bg-background-muted rounded-xl" />
    </div>
  );
}

// ─── Error States (using DS EmptyState + Button) ────────────────────────────

function USPErrorState({
  icon,
  title,
  description,
  action,
}: {
  icon: React.ReactNode;
  title: string;
  description: string;
  action?: { label: string; onClick: () => void };
}) {
  return (
    <div data-testid="usp-error">
      <EmptyState
        icon={icon}
        title={title}
        description={description}
        action={
          action ? (
            <Button variant="primary" onClick={action.onClick}>
              {action.label}
            </Button>
          ) : undefined
        }
      />
    </div>
  );
}

// ─── Inner Content (needs Suspense boundary for useSearchParams) ────────────

function UnifiedSourcePageContent({ projectId, kbId, sourceId }: UnifiedSourcePageProps) {
  const searchParams = useSearchParams();
  const navigate = useNavigationStore((s) => s.navigate);
  const t = useTranslations('search_ai.source_page');

  // ── Close CrawlFlow if it was left active ─────────────────────────────
  // When navigating to USP from CrawlFlow (e.g. after submission redirect or
  // from sources list), the crawl-flow-store may still have active=true.
  // Clear it on mount so navigating back to KB detail won't show the wizard.
  const closeCrawlFlow = useCrawlFlowStore((s) => s.close);
  const crawlFlowActive = useCrawlFlowStore((s) => s.active);
  useEffect(() => {
    if (crawlFlowActive) {
      closeCrawlFlow();
    }
  }, [crawlFlowActive, closeCrawlFlow]);

  // ── Tab State ───────────────────────────────────────────────────────────
  const [activeTab, setActiveTab] = useState<USPTab>(parseTabParam(searchParams.get('tab')));

  const handleTabChange = useCallback(
    (tabId: string) => {
      const tab = parseTabParam(tabId);
      setActiveTab(tab);
      const params = new URLSearchParams(searchParams.toString());
      params.set('tab', tabId);
      window.history.replaceState({}, '', `${window.location.pathname}?${params.toString()}`);
    },
    [searchParams],
  );

  // ── SWR Cascade: Step 1 — KB ────────────────────────────────────────────
  const {
    data: kbData,
    error: kbError,
    isLoading: kbLoading,
    mutate: mutateKB,
  } = useSWR<KBResponse>(`/api/search-ai/knowledge-bases/${kbId}`, {
    revalidateOnFocus: true,
  });

  const knowledgeBase = kbData?.knowledgeBase ?? null;
  const indexId = knowledgeBase?.searchIndexId ?? null;

  // ── SWR Cascade: Step 2a — Sources (conditional on indexId) ─────────────
  const {
    data: sourcesData,
    error: sourcesError,
    isLoading: sourcesLoading,
    mutate: mutateSources,
  } = useSWR<SourcesResponse>(indexId ? `/api/search-ai/indexes/${indexId}/sources` : null, {
    revalidateOnFocus: true,
  });

  // Find our source from the list
  const source = useMemo(
    () => sourcesData?.sources?.find((s) => s._id === sourceId) ?? null,
    [sourcesData, sourceId],
  );

  // ── SWR Cascade: Step 2b — Crawl History (conditional on indexId) ───────
  // Track whether we have active jobs — useState (not useRef) so that
  // toggling it triggers a re-render and SWR picks up the new refreshInterval.
  const [hasActiveJob, setHasActiveJob] = useState(false);
  const {
    data: historyData,
    error: historyError,
    isLoading: historyLoading,
    mutate: mutateHistory,
  } = useSWR<CrawlHistoryResponse>(
    indexId ? `/api/search-ai/crawl/history?indexId=${indexId}&limit=100` : null,
    { revalidateOnFocus: true, refreshInterval: hasActiveJob ? 5000 : undefined },
  );

  // Filter jobs for this source only
  const sourceJobs = useMemo(
    () => filterJobsBySource(historyData?.jobs ?? [], sourceId),
    [historyData, sourceId],
  );

  // Update active job tracking after data arrives — drives polling via re-render
  useEffect(() => {
    const active = sourceJobs.some((j) =>
      ['queued', 'crawling', 'ingesting', 'indexing'].includes(j.status),
    );
    setHasActiveJob((prev) => (prev !== active ? active : prev));
  }, [sourceJobs]);

  // ── Job Anchoring ──────────────────────────────────────────────────────
  // anchoredJobId: stable display context across SWR refreshes.
  // Updates when: fresh mount, OR a new active job appears (recrawl started).
  // Does NOT change for: SWR background refresh returning same jobs.
  const ACTIVE_STATUSES = useMemo(
    () => new Set(['queued', 'crawling', 'ingesting', 'indexing']),
    [],
  );
  const anchoredJobIdRef = useRef<string | null>(null);
  const [viewingJobId, setViewingJobId] = useState<string | null>(null);

  // Set anchor on first data load, and re-anchor when a new active job appears
  useEffect(() => {
    if (sourceJobs.length === 0) return;

    const latestJob = sourceJobs[0];

    // First load — set anchor
    if (anchoredJobIdRef.current === null) {
      anchoredJobIdRef.current = latestJob._id;
      return;
    }

    // New active job appeared (recrawl) — re-anchor to it
    if (latestJob._id !== anchoredJobIdRef.current && ACTIVE_STATUSES.has(latestJob.status)) {
      anchoredJobIdRef.current = latestJob._id;
      // Clear any history viewing so user sees the new crawl
      setViewingJobId(null);
    }
  }, [sourceJobs, ACTIVE_STATUSES]);

  const anchoredJobId = anchoredJobIdRef.current;
  const activeJobId = viewingJobId ?? anchoredJobId;
  const displayJob = resolveDisplayJob(sourceJobs, activeJobId);
  const isViewingHistory = viewingJobId !== null && viewingJobId !== anchoredJobId;

  // ── Display State ──────────────────────────────────────────────────────
  const displayState = deriveDisplayState(source, displayJob);
  const isCrawling = displayState === 'crawling';

  // ── Optimistic Recrawl Progress ──────────────────────────────────────
  // Bridges the 200ms-5s SWR gap: captures jobId from recrawl API response
  // so CrawlProgressView can connect via WebSocket immediately.
  const [recrawlJobId, setRecrawlJobId] = useState<string | null>(null);

  // When displayState transitions to crawling (SWR caught up), clear optimistic recrawlJobId.
  // This is more robust than jobId matching — handles cases where backend returns
  // a different jobId than the recrawl API (e.g., deduplication to existing queued job).
  useEffect(() => {
    if (isCrawling && recrawlJobId) {
      setRecrawlJobId(null);
    }
  }, [isCrawling, recrawlJobId]);

  // Show progress view during active crawl OR optimistic recrawl gap
  const showCrawlProgress = isCrawling || recrawlJobId !== null;
  const progressJobId = isCrawling ? activeJobId : recrawlJobId;

  // ── Callbacks ──────────────────────────────────────────────────────────
  const handleBackToLatest = useCallback(() => {
    setViewingJobId(null);
  }, []);

  const handleSelectJob = useCallback((jobId: string) => {
    setViewingJobId(jobId);
    // Switch to Pages tab so user sees the selected job's crawled pages
    setActiveTab('pages');
    window.history.replaceState({}, '', `${window.location.pathname}?tab=pages`);
  }, []);

  const openCrawlFlow = useCrawlFlowStore((s) => s.open);

  // Quick recrawl: backend reads stored config (URLs, strategy, settings, sections)
  // Frontend only sends sourceId + indexId — no payload reconstruction needed.
  const handleQuickRecrawl = useCallback(
    async (options?: { force?: boolean }) => {
      if (!indexId || !sourceId) return;

      try {
        const result = await recrawlSource({
          sourceId,
          indexId,
          forceReprocess: options?.force ?? false,
        });

        if (result.success) {
          toast.success(options?.force ? t('force_recrawl_submitted') : t('recrawl_submitted'));
          // Immediately enable polling so the new job is picked up fast
          setHasActiveJob(true);
          // Capture jobId for instant CrawlProgressView — bridges the SWR gap
          if (result.jobId) {
            setRecrawlJobId(result.jobId);
            // Auto-switch to pages tab so user sees progress immediately
            setActiveTab('pages');
            window.history.replaceState({}, '', `${window.location.pathname}?tab=pages`);
          }
          // Refresh both SWR caches: sources (status change) + history (new job)
          mutateSources();
          mutateHistory();
        } else {
          toast.error(t('recrawl_failed'));
        }
      } catch (err) {
        toast.error(err instanceof Error ? err.message : t('recrawl_failed'));
      }
    },
    [indexId, sourceId, t, mutateSources, mutateHistory],
  );

  // Reconfigure: go to wizard Step 2 to change sections/settings
  // Pass returnUrl so the wizard close handler can navigate back to USP
  const handleReconfigure = useCallback(() => {
    const returnUrl = `/projects/${projectId}/search-ai/${kbId}/sources/${sourceId}`;
    // Source has been crawled if it has any completed/failed jobs (i.e. not just configuring)
    const hasCrawledBefore = sourceJobs.some((j) =>
      ['completed', 'failed', 'cancelled'].includes(j.status),
    );
    openCrawlFlow({
      sourceId,
      returnUrl,
      sourceName: source?.name || undefined,
      hasCrawledBefore,
    });
    navigate(`/projects/${projectId}/search-ai/${kbId}`);
  }, [openCrawlFlow, sourceId, projectId, kbId, navigate, source, sourceJobs]);

  // CrawlJobHistory passes (urls, strategy) but our recrawl endpoint reads
  // everything from backend — adapter discards both params intentionally.
  const handleHistoryRecrawl = useCallback(
    (_urls: string[], _strategy?: string) => {
      handleQuickRecrawl();
    },
    [handleQuickRecrawl],
  );

  const handleCancel = useCallback(() => {
    // Cancel is handled by USPActionsBar directly (it calls cancelCrawlJob)
    // Refresh all SWR caches so status/history update immediately
    mutateKB();
    mutateSources();
    mutateHistory();
  }, [mutateKB, mutateSources, mutateHistory]);

  const handleSourceRenamed = useCallback(() => {
    mutateSources();
  }, [mutateSources]);

  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);

  const requestDeleteSource = useCallback(() => {
    setDeleteDialogOpen(true);
  }, []);

  const handleDeleteSource = useCallback(async () => {
    if (!indexId) return;
    setIsDeleting(true);
    try {
      await deleteSource(indexId, sourceId);
      toast.success(t('source_deleted'));
      navigate(`/projects/${projectId}/search-ai/${kbId}`);
    } catch (err) {
      toast.error(t('delete_failed', { error: err instanceof Error ? err.message : String(err) }));
    } finally {
      setIsDeleting(false);
      setDeleteDialogOpen(false);
    }
  }, [indexId, sourceId, projectId, kbId, navigate, t]);

  // ── Loading State ──────────────────────────────────────────────────────
  const isLoading = kbLoading || sourcesLoading || historyLoading;

  if (isLoading) {
    return <USPSkeleton />;
  }

  // ── Error States ──────────────────────────────────────────────────────
  if (kbError) {
    return (
      <USPErrorState
        icon={<AlertTriangle className="w-6 h-6" />}
        title={t('error_kb_title')}
        description={t('error_kb_description')}
        action={{ label: t('retry'), onClick: () => mutateKB() }}
      />
    );
  }

  if (!knowledgeBase) {
    return (
      <USPErrorState
        icon={<Database className="w-6 h-6" />}
        title={t('error_kb_not_found')}
        description={t('error_kb_not_found')}
        action={{
          label: t('back_to_kb'),
          onClick: () => navigate(`/projects/${projectId}/search-ai`),
        }}
      />
    );
  }

  if (!indexId) {
    return (
      <USPErrorState
        icon={<Database className="w-6 h-6" />}
        title={t('error_kb_no_index_title')}
        description={t('error_kb_no_index_description')}
        action={{
          label: t('back_to_kb'),
          onClick: () => navigate(`/projects/${projectId}/search-ai/${kbId}`),
        }}
      />
    );
  }

  if (sourcesError || historyError) {
    return (
      <USPErrorState
        icon={<AlertTriangle className="w-6 h-6" />}
        title={t('error_source_data_title')}
        description={t('error_source_data_description')}
        action={{ label: t('retry'), onClick: () => window.location.reload() }}
      />
    );
  }

  if (!source) {
    return (
      <USPErrorState
        icon={<FileX className="w-6 h-6" />}
        title={t('error_source_not_found_title')}
        description={t('error_source_not_found_description')}
        action={{
          label: t('back_to_kb'),
          onClick: () => navigate(`/projects/${projectId}/search-ai/${kbId}`),
        }}
      />
    );
  }

  // ── Tab Config ─────────────────────────────────────────────────────────
  const tabs = [
    { id: 'pages', label: t('tab_pages'), testid: 'usp-tab-pages' },
    { id: 'history', label: t('tab_history'), testid: 'usp-tab-history' },
    { id: 'settings', label: t('tab_settings'), testid: 'usp-tab-settings' },
  ];

  // ── Render ─────────────────────────────────────────────────────────────
  return (
    <div className="flex flex-col gap-6 p-6" data-testid="unified-source-page">
      {/* Zone 1: Header */}
      <USPHeader
        source={source}
        knowledgeBase={knowledgeBase}
        displayState={displayState}
        projectId={projectId}
        kbId={kbId}
        indexId={indexId!}
        onRecrawl={handleQuickRecrawl}
        onReconfigure={handleReconfigure}
        onDeleteSource={requestDeleteSource}
        onSourceRenamed={handleSourceRenamed}
      />

      {/* Zone 2: Status Strip */}
      <USPStatusStrip
        source={source}
        displayJob={displayJob}
        displayState={displayState}
        activeJobId={activeJobId}
        isViewingHistory={isViewingHistory}
        onBackToLatest={handleBackToLatest}
      />

      {/* Zone 3: Tabs */}
      <Tabs tabs={tabs} activeTab={activeTab} onTabChange={handleTabChange} layoutId="usp-tabs" />

      {/* Tab Content */}
      <div className="min-h-[300px]" data-testid="usp-tab-content">
        {activeTab === 'pages' && showCrawlProgress && progressJobId && (
          <CrawlProgressView
            jobId={progressJobId}
            sourceId={sourceId}
            url={source.name}
            onComplete={() => {
              // Crawl finished — clear optimistic state, refresh data
              setRecrawlJobId(null);
              mutateSources();
              mutateHistory();
            }}
          />
        )}
        {activeTab === 'pages' && !showCrawlProgress && displayJob && indexId && (
          <CrawledPagesView
            jobId={displayJob._id}
            indexId={indexId}
            sourceId={sourceId}
            refreshInterval={undefined}
          />
        )}
        {activeTab === 'pages' && !showCrawlProgress && !displayJob && (
          <div className="text-sm text-muted p-8 text-center">{t('no_crawl_data')}</div>
        )}
        {activeTab === 'history' && indexId && (
          <div>
            <CrawlJobHistory
              indexId={indexId}
              externalJobs={sourceJobs}
              onSelectJob={handleSelectJob}
              onRecrawl={handleHistoryRecrawl}
              onDeleteJob={mutateHistory}
            />
            {sourceJobs.length > 0 && (
              <p className="text-xs text-muted mt-2 text-center">{t('history_hint')}</p>
            )}
            {sourceJobs.length === 0 && (
              <div className="text-sm text-muted p-8 text-center">
                <p className="font-medium text-foreground mb-1">{t('no_history_title')}</p>
                <p>{t('no_history_description')}</p>
              </div>
            )}
          </div>
        )}
        {activeTab === 'settings' && (
          <USPSettingsTab source={source} onDeleteSource={requestDeleteSource} />
        )}
      </div>

      {/* Zone 4: Actions Bar */}
      <USPActionsBar
        displayState={displayState}
        source={source}
        displayJob={displayJob}
        activeJobId={activeJobId}
        projectId={projectId}
        kbId={kbId}
        indexId={indexId!}
        isViewingHistory={isViewingHistory}
        onRecrawl={handleQuickRecrawl}
        onReconfigure={handleReconfigure}
        onCancel={handleCancel}
        onSourceRenamed={handleSourceRenamed}
      />

      {/* Delete confirmation dialog */}
      <ConfirmDialog
        open={deleteDialogOpen}
        onClose={() => setDeleteDialogOpen(false)}
        onConfirm={handleDeleteSource}
        title={t('settings_danger_title')}
        description={t('settings_danger_description')}
        confirmLabel={t('settings_delete_source')}
        variant="danger"
        loading={isDeleting}
      />
    </div>
  );
}

// ─── Exported Page (Suspense boundary for useSearchParams) ──────────────────

export function UnifiedSourcePage(props: UnifiedSourcePageProps) {
  return (
    <Suspense fallback={<USPSkeleton />}>
      <UnifiedSourcePageContent {...props} />
    </Suspense>
  );
}
