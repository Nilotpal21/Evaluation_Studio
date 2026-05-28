/**
 * FieldsCard
 *
 * Intelligence hub card for field mapping status.
 */

import { TableProperties } from 'lucide-react';
import { useTranslations } from 'next-intl';
import useSWR from 'swr';
import { IntelligenceCard, type IntelligenceCardState } from '../IntelligenceCard';

interface FieldsCardProps {
  indexId: string;
  onNavigate: () => void;
}

interface IndexFieldsResponse {
  confirmedCount?: number;
  suggestedCount?: number;
  unmappedCount?: number;
  totalFields?: number;
}

export function FieldsCard({ indexId, onNavigate }: FieldsCardProps) {
  const t = useTranslations('search_ai.intelligence');
  const { data, error, isLoading } = useSWR<IndexFieldsResponse>(
    indexId ? `/api/search-ai/mappings/tab-stats?knowledgeBaseId=${indexId}` : null,
  );

  let state: IntelligenceCardState = 'not-configured';
  const stats: { label: string; value: string | number }[] = [];

  const confirmed = data?.confirmedCount ?? 0;
  const suggested = data?.suggestedCount ?? 0;

  if (confirmed > 0 && suggested === 0) {
    state = 'healthy';
  } else if (suggested > 0) {
    state = 'needs-attention';
  }

  if (confirmed > 0 || suggested > 0) {
    stats.push({ label: t('fields_stat_confirmed'), value: confirmed });
    stats.push({ label: t('fields_stat_suggested'), value: suggested });
  }

  return (
    <IntelligenceCard
      title={t('fields_title')}
      icon={TableProperties}
      state={state}
      stats={stats}
      description={t('fields_description')}
      actionLabel={
        state === 'not-configured' ? t('fields_action_setup') : t('fields_action_manage')
      }
      onAction={onNavigate}
      isLoading={isLoading}
      isError={!!error}
      attentionMessage={
        suggested > 0 ? t('fields_suggested_review', { count: suggested }) : undefined
      }
    />
  );
}
