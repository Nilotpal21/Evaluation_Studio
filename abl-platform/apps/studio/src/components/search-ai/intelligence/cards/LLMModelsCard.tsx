/**
 * LLMModelsCard
 *
 * Intelligence hub card for LLM model configuration status.
 */

import { Cpu } from 'lucide-react';
import { useTranslations } from 'next-intl';
import useSWR from 'swr';
import { IntelligenceCard, type IntelligenceCardState } from '../IntelligenceCard';

interface LLMModelsCardProps {
  indexId: string;
  onNavigate: () => void;
}

interface LLMConfigResponse {
  indexId?: string;
  rawConfig?: {
    useCases?: Record<string, { enabled?: boolean }>;
  };
  enhancedConfig?: {
    useCases?: Record<string, { enabled?: boolean; status?: string }>;
  };
}

export function LLMModelsCard({ indexId, onNavigate }: LLMModelsCardProps) {
  const t = useTranslations('search_ai.intelligence');
  const { data, error, isLoading } = useSWR<LLMConfigResponse>(
    indexId ? `/api/search-ai/indexes/${indexId}/llm-config` : null,
  );

  let state: IntelligenceCardState = 'not-configured';
  const stats: { label: string; value: string | number }[] = [];

  // Check enhanced config use cases for enabled entries
  const useCases = data?.enhancedConfig?.useCases ?? data?.rawConfig?.useCases ?? {};
  const enabledCount = Object.values(useCases).filter((uc) => uc.enabled).length;
  const totalCount = Object.keys(useCases).length;

  if (enabledCount > 0) {
    state = 'healthy';
    stats.push({
      label: t('llm_stat_active_use_cases'),
      value: `${enabledCount}/${totalCount}`,
    });
  } else if (totalCount > 0) {
    state = 'needs-attention';
  }

  return (
    <IntelligenceCard
      title={t('llm_title')}
      icon={Cpu}
      state={state}
      stats={stats}
      description={t('llm_description')}
      attentionMessage={state === 'needs-attention' ? t('llm_attention_none_enabled') : undefined}
      actionLabel={state === 'not-configured' ? t('llm_action_setup') : t('llm_action_configure')}
      onAction={onNavigate}
      isLoading={isLoading}
      isError={!!error}
    />
  );
}
