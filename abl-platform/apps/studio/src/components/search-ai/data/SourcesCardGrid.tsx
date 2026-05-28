/**
 * SourcesCardGrid Component
 *
 * Card grid layout wrapping SourceCard components with a dashed
 * "+ Add Source" card at the end.
 */

import { useTranslations } from 'next-intl';
import { Plus } from 'lucide-react';
import { SourceCard } from './SourceCard';
import type { SearchAISource, KnowledgeBaseDetail } from '../../../api/search-ai';

interface SourcesCardGridProps {
  sources: SearchAISource[];
  connectorMap: Record<string, string>;
  onCardClick: (source: SearchAISource) => void;
  onDeleteClick: (source: SearchAISource, e: React.MouseEvent) => void;
  onViewDocuments: (sourceId: string, sourceName: string) => void;
  onUploadToSource: (sourceId: string, sourceName: string) => void;
  onAddSource?: () => void;
  knowledgeBase?: KnowledgeBaseDetail;
  /** Map of sourceId → effective status (e.g. derived 'crawling' from active CrawlJobs) */
  effectiveStatusMap?: Map<string, string>;
}

export function SourcesCardGrid({
  sources,
  connectorMap,
  onCardClick,
  onDeleteClick,
  onViewDocuments,
  onUploadToSource,
  onAddSource,
  knowledgeBase,
  effectiveStatusMap,
}: SourcesCardGridProps) {
  const t = useTranslations('search_ai.sources_table');

  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
      {sources.map((source) => (
        <SourceCard
          key={source._id}
          source={source}
          connectorId={connectorMap[source._id] ?? null}
          onClick={() => onCardClick(source)}
          onDelete={(e) => onDeleteClick(source, e)}
          onViewDocuments={() => onViewDocuments(source._id, source.name)}
          onUploadToSource={
            source.sourceType === 'manual' || source.sourceType === 'file'
              ? () => onUploadToSource(source._id, source.name)
              : undefined
          }
          knowledgeBase={knowledgeBase}
          effectiveStatus={effectiveStatusMap?.get(source._id)}
        />
      ))}
      {onAddSource && (
        <button
          onClick={onAddSource}
          className="flex flex-col items-center justify-center gap-2 p-4 rounded-xl border-2 border-dashed border-default hover:border-info/50 text-muted hover:text-foreground cursor-pointer transition-all min-h-[120px]"
          aria-label={t('card_add_source')}
        >
          <Plus className="w-6 h-6" />
          <span className="text-sm font-medium">{t('card_add_source')}</span>
        </button>
      )}
    </div>
  );
}
