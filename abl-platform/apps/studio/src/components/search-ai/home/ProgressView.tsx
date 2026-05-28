/**
 * ProgressView Component
 *
 * Shows processing status for a knowledge base.
 * Polls index stats every 5 seconds via SWR.
 */

import { useTranslations } from 'next-intl';
import useSWR from 'swr';
import { Loader2, AlertCircle, ArrowRight } from 'lucide-react';
import { Card } from '../../ui/Card';
import { Button } from '../../ui/Button';
import type { KnowledgeBaseDetail, SearchAIIndex, SearchAISource } from '../../../api/search-ai';
import { useDataTabFilterStore } from '../../../store/data-tab-filter-store';

/** Progress bar bounds and estimation constants */
const PROGRESS_MIN_PCT = 10;
const PROGRESS_MAX_PCT = 90;
const ESTIMATED_CHUNKS_PER_DOC = 10;

interface ProgressViewProps {
  knowledgeBase: KnowledgeBaseDetail;
  indexId: string;
  sources?: SearchAISource[];
  onNavigate?: (tab: string, subSection?: string) => void;
}

export function ProgressView({ knowledgeBase, indexId, sources, onNavigate }: ProgressViewProps) {
  const t = useTranslations('search_ai.progress');
  const setPendingFilter = useDataTabFilterStore((s) => s.setPendingFilter);

  // No polling — updates arrive via WebSocket event → parent useKnowledgeBase mutate()
  // → SWR global cache invalidation cascades to all hooks sharing index keys.
  const { data: indexData } = useSWR<{ index: SearchAIIndex }>(
    indexId ? `/api/search-ai/indexes/${indexId}` : null,
    { revalidateOnFocus: true },
  );
  const index = indexData?.index;

  const status = index?.status ?? knowledgeBase.status;
  const isError = status === 'error';
  const docCount = index?.documentCount ?? knowledgeBase.documentCount;
  const chunkCount = index?.chunkCount ?? 0;

  function statusLabel(s: string): string {
    switch (s) {
      case 'creating':
        return t('status_creating');
      case 'indexing':
        return t('status_indexing');
      case 'rebuilding':
        return t('status_rebuilding');
      case 'error':
        return t('status_error');
      default:
        return t('status_default');
    }
  }

  return (
    <div className="space-y-6">
      <Card hoverable={false} padding="lg">
        <div className="flex items-start gap-4">
          {isError ? (
            <div className="rounded-lg bg-error/10 p-2.5">
              <AlertCircle className="w-6 h-6 text-error" />
            </div>
          ) : (
            <div className="rounded-lg bg-accent/10 p-2.5">
              <Loader2 className="w-6 h-6 text-accent animate-spin" />
            </div>
          )}
          <div className="flex-1 min-w-0">
            <h3 className="text-base font-semibold text-foreground">{statusLabel(status)}</h3>
            <p className="text-sm text-muted mt-1">
              {isError
                ? (index?.indexError ?? knowledgeBase.indexError ?? t('error_fallback'))
                : t('auto_update_hint')}
            </p>

            {/* Progress indicator */}
            {!isError && (
              <div className="mt-4 space-y-2">
                <div className="h-2 rounded-full bg-background-muted overflow-hidden">
                  <div
                    className="h-full rounded-full bg-accent transition-all duration-500"
                    style={{
                      width:
                        docCount > 0
                          ? `${Math.min(PROGRESS_MAX_PCT, Math.max(PROGRESS_MIN_PCT, (chunkCount / Math.max(docCount * ESTIMATED_CHUNKS_PER_DOC, 1)) * 100))}%`
                          : `${PROGRESS_MIN_PCT}%`,
                    }}
                  />
                </div>
                <div className="flex items-center justify-between text-xs text-muted">
                  <span>{t('doc_count', { count: docCount })}</span>
                  <span>{t('chunks_created', { count: chunkCount })}</span>
                </div>
              </div>
            )}

            {/* Action links */}
            {isError ? (
              <div className="mt-4 flex flex-wrap items-center gap-3">
                <Button
                  variant="ghost"
                  size="xs"
                  onClick={() => {
                    const filter: Parameters<typeof setPendingFilter>[0] = {
                      view: 'documents',
                      statusFilter: 'error',
                    };
                    if (sources?.length === 1) {
                      filter.sourceId = sources[0]._id;
                    }
                    setPendingFilter(filter);
                    onNavigate?.('data');
                  }}
                >
                  {t('action_view_error_details')} <ArrowRight className="w-3 h-3" />
                </Button>
                <Button
                  variant="ghost"
                  size="xs"
                  onClick={() => onNavigate?.('intelligence', 'pipeline')}
                >
                  {t('action_check_pipeline')} <ArrowRight className="w-3 h-3" />
                </Button>
              </div>
            ) : (
              <div className="mt-4 flex flex-wrap items-center gap-3">
                <Button variant="ghost" size="xs" onClick={() => onNavigate?.('search')}>
                  {t('action_try_search')} <ArrowRight className="w-3 h-3" />
                </Button>
                <Button variant="ghost" size="xs" onClick={() => onNavigate?.('data')}>
                  {t('action_view_documents')} <ArrowRight className="w-3 h-3" />
                </Button>
                <Button
                  variant="ghost"
                  size="xs"
                  onClick={() => onNavigate?.('intelligence', 'fields')}
                >
                  {t('action_review_mappings')} <ArrowRight className="w-3 h-3" />
                </Button>
              </div>
            )}
          </div>
        </div>
      </Card>
    </div>
  );
}
