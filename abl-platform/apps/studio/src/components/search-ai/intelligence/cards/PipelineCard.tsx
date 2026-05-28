/**
 * PipelineCard
 *
 * Intelligence hub card for pipeline configuration status.
 * Uses SWR (cache-deduped with parent useKnowledgeBase hook — no extra network request).
 */

import { Workflow } from 'lucide-react';
import { useTranslations } from 'next-intl';
import useSWR from 'swr';
import { IntelligenceCard, type IntelligenceCardState } from '../IntelligenceCard';
import type { KnowledgeBaseDetail } from '../../../../api/search-ai';

interface PipelineCardProps {
  knowledgeBaseId: string;
  onNavigate: () => void;
}

interface KBResponse {
  knowledgeBase: KnowledgeBaseDetail;
}

export function PipelineCard({ knowledgeBaseId, onNavigate }: PipelineCardProps) {
  const t = useTranslations('search_ai.intelligence');
  const { data, error, isLoading } = useSWR<KBResponse>(
    knowledgeBaseId ? `/api/search-ai/knowledge-bases/${knowledgeBaseId}` : null,
  );

  let state: IntelligenceCardState = 'not-configured';
  const stats: { label: string; value: string | number }[] = [];

  if (data?.knowledgeBase?.status === 'active') {
    state = 'healthy';
    stats.push({ label: t('pipeline_stat_status'), value: t('pipeline_stat_active') });
  }

  return (
    <IntelligenceCard
      title={t('pipeline_title')}
      icon={Workflow}
      state={state}
      stats={stats}
      description={t('pipeline_description')}
      actionLabel={
        state === 'not-configured' ? t('pipeline_action_setup') : t('pipeline_action_configure')
      }
      onAction={onNavigate}
      isLoading={isLoading}
      isError={!!error}
    />
  );
}
