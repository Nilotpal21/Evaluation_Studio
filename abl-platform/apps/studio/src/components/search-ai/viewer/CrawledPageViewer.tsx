'use client';

/**
 * CrawledPageViewer Component
 *
 * Full-width slide-out panel for viewing crawled page details.
 * Supports extracted content, original HTML, side-by-side comparison,
 * and metadata/quality views with chunk navigation.
 */

import { useState, useEffect, useCallback, useMemo } from 'react';
import { useTranslations } from 'next-intl';
import { motion, AnimatePresence } from 'framer-motion';
import { clsx } from 'clsx';
import { FileText, Globe, Columns2, BarChart3, AlertCircle, RefreshCw, Layers } from 'lucide-react';
import { springs, transitions } from '@/lib/animation';
import { Button } from '@/components/ui/Button';
import { Skeleton, SkeletonText } from '@/components/ui/Skeleton';
import { SegmentedControl, type SegmentOption } from '@/components/ui/SegmentedControl';
import { getDocumentDetail } from '@/api/search-ai';
import { PageViewerHeader } from './PageViewerHeader';
import { ExtractedContentView, type ChunkData } from './ExtractedContentView';
import { OriginalPageView } from './OriginalPageView';
import { SideBySideView } from './SideBySideView';
import { MetadataView } from './MetadataView';
import { ChunkNavigator } from './ChunkNavigator';
import { ChunkExplorerDialog } from '../ChunkExplorer';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface CrawledPageViewerProps {
  open: boolean;
  onClose: () => void;
  indexId: string;
  documentId: string;
}

type ViewTab = 'extracted' | 'original' | 'sideBySide' | 'metadata';

interface DocumentDetail {
  document: {
    _id: string;
    title: string;
    url: string;
    status: string;
    contentType: string;
    contentSizeBytes: number;
    extractedText: string | null;
    sourceMetadata: Record<string, unknown>;
    rawHtmlUrl?: string;
    createdAt: string;
    updatedAt?: string;
  };
  chunks: ChunkData[];
  chunkCount: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

// TAB_OPTIONS moved inside component as useMemo (needs `t()` for i18n)

// ---------------------------------------------------------------------------
// Loading skeleton
// ---------------------------------------------------------------------------

function ViewerSkeleton() {
  return (
    <div className="flex flex-col h-full">
      {/* Header skeleton */}
      <div className="flex items-center gap-4 px-5 py-3 border-b border-default">
        <div className="flex-1 space-y-2">
          <Skeleton className="h-4 w-48" />
          <Skeleton className="h-3 w-64" />
        </div>
        <Skeleton className="h-6 w-16 rounded-full" />
        <Skeleton className="h-6 w-24 rounded-full" />
      </div>

      {/* Tab skeleton */}
      <div className="px-5 py-3 border-b border-default">
        <Skeleton className="h-9 w-96 rounded-lg" />
      </div>

      {/* Content skeleton */}
      <div className="flex-1 p-5 space-y-4">
        <Skeleton className="h-6 w-24" />
        <SkeletonText lines={4} />
        <Skeleton className="h-px w-full" />
        <Skeleton className="h-6 w-24" />
        <SkeletonText lines={3} />
        <Skeleton className="h-px w-full" />
        <Skeleton className="h-6 w-24" />
        <SkeletonText lines={5} />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Error state
// ---------------------------------------------------------------------------

function ViewerError({ message, onRetry }: { message: string; onRetry: () => void }) {
  const t = useTranslations('search_ai.viewer');
  return (
    <div className="flex flex-col items-center justify-center h-full gap-4 p-8">
      <div className="w-12 h-12 rounded-full bg-error-subtle flex items-center justify-center">
        <AlertCircle className="w-6 h-6 text-error" />
      </div>
      <div className="text-center space-y-1">
        <p className="text-sm font-medium text-foreground">{t('error_title')}</p>
        <p className="text-xs text-muted max-w-sm">{message}</p>
      </div>
      <Button
        variant="secondary"
        size="sm"
        onClick={onRetry}
        icon={<RefreshCw className="w-3.5 h-3.5" />}
      >
        {t('retry')}
      </Button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main Component
// ---------------------------------------------------------------------------

export function CrawledPageViewer({ open, onClose, indexId, documentId }: CrawledPageViewerProps) {
  const t = useTranslations('search_ai.viewer');
  const [data, setData] = useState<DocumentDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<ViewTab>('extracted');
  const [activeChunkIndex, setActiveChunkIndex] = useState(0);
  const [chunkExplorerOpen, setChunkExplorerOpen] = useState(false);

  // rawHtmlUrl is set by the backend document detail endpoint
  const rawHtmlUrl = data?.document.rawHtmlUrl ?? null;
  const fallbackHtml: string | null = null;

  // Only show Original/SideBySide tabs when rawHtmlUrl is available (#82)
  // Non-web documents (file uploads, DB) don't have original HTML to display.
  const tabOptions: SegmentOption[] = useMemo(() => {
    const tabs: SegmentOption[] = [
      { id: 'extracted', label: t('tab_extracted'), icon: <FileText className="w-3.5 h-3.5" /> },
    ];
    if (rawHtmlUrl) {
      tabs.push(
        { id: 'original', label: t('tab_original'), icon: <Globe className="w-3.5 h-3.5" /> },
        {
          id: 'sideBySide',
          label: t('tab_side_by_side'),
          icon: <Columns2 className="w-3.5 h-3.5" />,
        },
      );
    }
    tabs.push({
      id: 'metadata',
      label: t('tab_metadata'),
      icon: <BarChart3 className="w-3.5 h-3.5" />,
    });
    return tabs;
  }, [t, rawHtmlUrl]);

  // Reset activeTab if it's no longer in the available tabs (e.g., switched from web to file doc)
  // Learning from B6/R1-2: don't let stale state persist when context changes.
  useEffect(() => {
    if (!tabOptions.some((tab) => tab.id === activeTab)) {
      setActiveTab('extracted');
    }
  }, [tabOptions, activeTab]);

  // Fetch document detail
  const fetchDocument = useCallback(async () => {
    if (!indexId || !documentId) return;

    setLoading(true);
    setError(null);

    try {
      const result = await getDocumentDetail(indexId, documentId);

      const chunks: ChunkData[] = result.chunks.map((c, i) => ({
        _id: c._id,
        content: c.content,
        position: { ...c.position, order: c.chunkIndex ?? c.position?.order ?? i },
        tokenCount: c.tokenCount ?? Math.ceil(c.content.length / 4),
      }));

      setData({
        document: result.document,
        chunks,
        chunkCount: result.chunkCount,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setError(message);
    } finally {
      setLoading(false);
    }
  }, [indexId, documentId]);

  // Fetch on mount / when IDs change
  useEffect(() => {
    if (open) {
      fetchDocument();
      setActiveTab('extracted');
      setActiveChunkIndex(0);
    }
  }, [open, fetchDocument]);

  // Close on Escape
  useEffect(() => {
    if (!open) return;

    function handleEscape(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        onClose();
      }
    }

    window.addEventListener('keydown', handleEscape);
    return () => window.removeEventListener('keydown', handleEscape);
  }, [open, onClose]);

  // Extract quality score from metadata
  const qualityScore =
    data?.document.sourceMetadata?.qualityMetrics &&
    typeof (data.document.sourceMetadata.qualityMetrics as Record<string, unknown>).overallScore ===
      'number'
      ? ((data.document.sourceMetadata.qualityMetrics as Record<string, unknown>)
          .overallScore as number)
      : null;

  // Render active tab content
  function renderTabContent() {
    if (!data) return null;

    switch (activeTab) {
      case 'extracted':
        return (
          <ExtractedContentView
            chunks={data.chunks}
            extractedText={data.document.extractedText}
            activeChunkIndex={activeChunkIndex}
            onChunkClick={setActiveChunkIndex}
          />
        );
      case 'original':
        return <OriginalPageView rawHtmlUrl={rawHtmlUrl} fallbackHtml={fallbackHtml} />;
      case 'sideBySide':
        return (
          <SideBySideView
            rawHtmlUrl={rawHtmlUrl}
            fallbackHtml={fallbackHtml}
            chunks={data.chunks}
            extractedText={data.document.extractedText}
            activeChunkIndex={activeChunkIndex}
            onChunkClick={setActiveChunkIndex}
          />
        );
      case 'metadata':
        return (
          <MetadataView
            sourceMetadata={data.document.sourceMetadata}
            status={data.document.status}
            createdAt={data.document.createdAt}
            updatedAt={data.document.updatedAt}
            contentSizeBytes={data.document.contentSizeBytes}
          />
        );
      default:
        return null;
    }
  }

  const showChunkNav = activeTab === 'extracted' || activeTab === 'sideBySide';

  return (
    <AnimatePresence>
      {open && (
        <>
          {/* Backdrop */}
          <motion.div
            className="fixed inset-0 z-50 bg-overlay backdrop-blur-sm"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={transitions.backdrop}
            onClick={onClose}
            aria-hidden="true"
          />

          {/* Panel */}
          <motion.div
            className={clsx(
              'fixed top-0 right-0 z-50 h-full w-full max-w-5xl',
              'bg-background-elevated border-l border-default shadow-xl',
              'flex flex-col',
            )}
            initial={{ x: '100%' }}
            animate={{ x: 0 }}
            exit={{ x: '100%' }}
            transition={springs.gentle}
            role="dialog"
            aria-modal="true"
            aria-label={t('aria_label')}
          >
            {loading && <ViewerSkeleton />}

            {!loading && error && <ViewerError message={error} onRetry={fetchDocument} />}

            {!loading && !error && data && (
              <>
                {/* Header */}
                <PageViewerHeader
                  title={data.document.title}
                  url={data.document.url}
                  status={data.document.status}
                  qualityScore={qualityScore}
                  crawledAt={data.document.createdAt}
                  onClose={onClose}
                />

                {/* Explore chunks bar */}
                <div className="px-5 py-1.5 border-b border-default flex items-center justify-between">
                  <span className="text-xs text-muted">
                    {t('chunk_count_summary', { count: data.chunkCount })}
                  </span>
                  <Button
                    variant="secondary"
                    size="xs"
                    onClick={() => setChunkExplorerOpen(true)}
                    aria-label={t('explore_chunks')}
                  >
                    <Layers className="w-3.5 h-3.5" />
                    {t('explore_chunks')}
                  </Button>
                </div>

                {/* Tab bar */}
                <div className="px-5 py-3 border-b border-default shrink-0">
                  <SegmentedControl
                    options={tabOptions}
                    value={activeTab}
                    onChange={(val) => setActiveTab(val as ViewTab)}
                    size="sm"
                  />
                </div>

                {/* Content area */}
                <div className="flex-1 overflow-hidden">{renderTabContent()}</div>

                {/* Chunk navigator (only for extracted / side-by-side) */}
                {showChunkNav && data.chunks.length > 0 && (
                  <ChunkNavigator
                    chunks={data.chunks}
                    activeIndex={activeChunkIndex}
                    onSelect={setActiveChunkIndex}
                  />
                )}
              </>
            )}

            {data && (
              <ChunkExplorerDialog
                open={chunkExplorerOpen}
                onClose={() => setChunkExplorerOpen(false)}
                indexId={indexId}
                documentId={documentId}
                documentTitle={data.document.title ?? 'Document'}
                totalChunks={data.chunkCount}
              />
            )}
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
}
