/**
 * IntelligenceHub
 *
 * Hub view showing 5 adaptive-state cards in a responsive grid.
 * Each card navigates to its corresponding sub-section.
 */

import { useTranslations } from 'next-intl';
import { useNavigationStore } from '../../../store/navigation-store';
import { PipelineCard } from './cards/PipelineCard';
import { FieldsCard } from './cards/FieldsCard';
import { VocabularyCard } from './cards/VocabularyCard';
import { KnowledgeGraphCard } from './cards/KnowledgeGraphCard';
import { LLMModelsCard } from './cards/LLMModelsCard';

interface IntelligenceHubProps {
  indexId: string;
  knowledgeBaseId: string;
}

export function IntelligenceHub({ indexId, knowledgeBaseId }: IntelligenceHubProps) {
  const t = useTranslations('search_ai.intelligence');
  const setSubSection = useNavigationStore((s) => s.setSubSection);

  return (
    <div className="p-6">
      <div className="mb-4">
        <h2 className="text-lg font-semibold text-foreground">{t('title')}</h2>
        <p className="text-sm text-muted mt-1">{t('description')}</p>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
        <PipelineCard
          knowledgeBaseId={knowledgeBaseId}
          onNavigate={() => setSubSection('pipeline')}
        />
        <FieldsCard indexId={indexId} onNavigate={() => setSubSection('fields')} />
        <VocabularyCard indexId={indexId} onNavigate={() => setSubSection('vocabulary')} />
        <KnowledgeGraphCard
          indexId={indexId}
          onNavigate={(hasReviewItems) => {
            setSubSection('knowledge-graph');
            // Auto-switch to Attributes view when review queue has items (attention state).
            // Otherwise keep current kgView (defaults to 'graph' on first visit).
            if (hasReviewItems) {
              useNavigationStore.getState().setKgView('attributes');
            }
          }}
        />
        <LLMModelsCard indexId={indexId} onNavigate={() => setSubSection('llm-models')} />
      </div>
    </div>
  );
}
