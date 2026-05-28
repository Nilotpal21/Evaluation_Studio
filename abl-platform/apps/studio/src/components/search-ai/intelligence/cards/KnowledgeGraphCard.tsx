/**
 * KnowledgeGraphCard
 *
 * Intelligence hub card for knowledge graph configuration status.
 * Uses shared hooks for KG configuration and taxonomy data.
 */

import { Share2 } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { IntelligenceCard, type IntelligenceCardState } from '../IntelligenceCard';
import { useReviewQueue } from '../../../../hooks/useAttributes';
import { useKGConfigurationStatus, useKGTaxonomy } from '../../../../hooks/useKnowledgeGraph';

interface KnowledgeGraphCardProps {
  indexId: string;
  onNavigate: (hasReviewItems: boolean) => void;
}

export function KnowledgeGraphCard({ indexId, onNavigate }: KnowledgeGraphCardProps) {
  const t = useTranslations('search_ai.intelligence');

  const { status: configStatus, isLoading, error } = useKGConfigurationStatus(indexId);

  // Conditional taxonomy check — only fetch when KG infra is available
  const { isNotFound: taxonomyNotFound, taxonomy } = useKGTaxonomy(
    configStatus?.environment?.available ? indexId : null,
  );
  const hasTaxonomy = !!taxonomy && !taxonomyNotFound;

  // Attribute review queue for attention state
  const { total: reviewQueueTotal } = useReviewQueue(indexId);

  let state: IntelligenceCardState = 'not-configured';
  let description = t('kg_description');
  let actionLabel = t('kg_action_setup');
  const stats: { label: string; value: string | number }[] = [];

  const configLevel = configStatus?.configurationLevel;

  if (configStatus && !configStatus.environment?.available) {
    state = 'not-deployed';
    actionLabel = t('kg_action_learn_more');
    description = t('kg_not_deployed_description');
  } else if (configLevel === 'none') {
    state = 'not-configured';
    actionLabel = t('kg_action_setup');
  } else if (!hasTaxonomy) {
    state = 'not-configured';
    actionLabel = t('kg_action_setup_kg');
    stats.push({ label: t('kg_stat_ready'), value: '✓' });
  } else if (reviewQueueTotal > 0) {
    state = 'needs-attention';
    actionLabel = t('kg_action_manage');
    stats.push({ label: t('kg_stat_review_queue'), value: reviewQueueTotal });
  } else {
    state = 'healthy';
    actionLabel = t('kg_action_manage');
  }

  return (
    <IntelligenceCard
      title={t('kg_title')}
      icon={Share2}
      state={state}
      stats={stats}
      description={description}
      actionLabel={actionLabel}
      onAction={() => onNavigate(reviewQueueTotal > 0)}
      attentionMessage={
        reviewQueueTotal > 0 ? t('kg_attention_review', { count: reviewQueueTotal }) : undefined
      }
      isLoading={isLoading}
      isError={!!error}
    />
  );
}
