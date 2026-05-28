/**
 * KnowledgeBaseDetailPage Component
 *
 * Detail page for a single knowledge base.
 * URL: /projects/:id/search-ai/:kbId/:tab
 *
 * When the crawl flow is active (via crawl-flow-store), the entire right panel
 * is replaced with the full-page CrawlFlowV5 — matching the Workflows/Agents
 * page layout pattern where content fills the full area beside the sidebar.
 */

import { useCallback, useRef } from 'react';
import { ArrowLeft } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useNavigationStore } from '../../store/navigation-store';
import { useKnowledgeBase } from '../../hooks/useKnowledgeBase';
import { useCrawlFlowStore } from '../../store/crawl-flow-store';
import { KBDetailLayout } from './layout';
import { CrawlFlowV5 } from './crawl-flow';
import type { CrawlFlowHandle } from './crawl-flow/types';

export function KnowledgeBaseDetailPage() {
  const t = useTranslations('search_ai.detail');
  const tData = useTranslations('search_ai.data');
  const tCrawl = useTranslations('search_ai.crawl_flow');
  const { projectId, subPage: kbId } = useNavigationStore();
  const { knowledgeBase, sources, isLoading, error, refresh, refreshSources } =
    useKnowledgeBase(kbId);

  const crawlFlowActive = useCrawlFlowStore((s) => s.active);
  const crawlFlowSourceId = useCrawlFlowStore((s) => s.sourceId);
  const crawlFlowReturnUrl = useCrawlFlowStore((s) => s.returnUrl);
  const crawlFlowSourceName = useCrawlFlowStore((s) => s.sourceName);
  const crawlFlowHasCrawled = useCrawlFlowStore((s) => s.hasCrawledBefore);
  const closeCrawlFlow = useCrawlFlowStore((s) => s.close);
  const crawlFlowRef = useRef<CrawlFlowHandle>(null);
  const navigate = useNavigationStore((s) => s.navigate);

  const handleCrawlComplete = useCallback(
    (_jobId: string, sourceId: string, _crawlUrl: string) => {
      closeCrawlFlow();
      refreshSources();
      refresh();
      // Navigate to USP for the just-crawled source
      if (projectId && kbId) {
        navigate(`/projects/${projectId}/search-ai/${kbId}/sources/${sourceId}`);
      }
    },
    [closeCrawlFlow, refreshSources, refresh, projectId, kbId, navigate],
  );

  /** Close crawl flow and refresh sources list (handles delete-and-close, save-and-close) */
  const handleCrawlFlowCancel = useCallback(() => {
    // If opened from USP (returnUrl set), navigate back to USP instead of staying on KB page
    const returnTo = crawlFlowReturnUrl;
    closeCrawlFlow();
    refreshSources();
    refresh();
    if (returnTo) {
      navigate(returnTo);
    }
  }, [closeCrawlFlow, crawlFlowReturnUrl, refreshSources, refresh, navigate]);

  if (!projectId || !kbId) return null;

  if (isLoading) {
    return (
      <div className="h-full overflow-y-auto bg-background">
        <div className="max-w-5xl mx-auto px-6 py-8">
          <div className="text-sm text-muted">{t('loading')}</div>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="h-full overflow-y-auto bg-background">
        <div className="max-w-5xl mx-auto px-6 py-8">
          <div className="text-sm text-error">{t('error_loading')}</div>
          <button
            onClick={refresh}
            className="mt-2 text-sm text-accent hover:underline transition-default"
          >
            {t('retry')}
          </button>
        </div>
      </div>
    );
  }

  if (!knowledgeBase) {
    return (
      <div className="h-full overflow-y-auto bg-background">
        <div className="max-w-5xl mx-auto px-6 py-8">
          <div className="text-sm text-muted">{t('not_found')}</div>
        </div>
      </div>
    );
  }

  // Determine breadcrumb: if reconfiguring from USP, show source name context
  const isReconfiguring = !!crawlFlowReturnUrl && !!crawlFlowSourceName;
  const breadcrumbLabel = isReconfiguring ? crawlFlowSourceName : knowledgeBase.name;
  const breadcrumbSuffix = isReconfiguring ? tCrawl('reconfigure_title') : tData('web_crawl_title');

  // ── Full-page crawl flow ────────────────────────────────────────────────
  if (crawlFlowActive) {
    return (
      <div className="h-full flex flex-col bg-background">
        {/* Slim header with back button + title */}
        <div className="shrink-0 flex items-center gap-3 px-6 py-4 border-b border-default">
          <button
            onClick={() => crawlFlowRef.current?.requestClose()}
            className="flex items-center gap-1.5 text-sm text-muted hover:text-foreground transition-default"
          >
            <ArrowLeft className="w-4 h-4" />
            {breadcrumbLabel}
          </button>
          <span className="text-muted">/</span>
          <span className="text-sm font-medium text-foreground">{breadcrumbSuffix}</span>
        </div>

        {/* Crawl flow fills the remaining space */}
        <div className="flex-1 overflow-y-auto px-6 py-6">
          <CrawlFlowV5
            ref={crawlFlowRef}
            indexId={knowledgeBase.searchIndexId ?? ''}
            sourceId={crawlFlowSourceId}
            hasCrawledBefore={crawlFlowHasCrawled}
            onComplete={handleCrawlComplete}
            onCancel={handleCrawlFlowCancel}
          />
        </div>
      </div>
    );
  }

  return (
    <KBDetailLayout
      knowledgeBase={knowledgeBase}
      sources={sources}
      isLoading={isLoading}
      onRefresh={refresh}
      onRefreshSources={refreshSources}
    />
  );
}
