/**
 * VocabularyCard
 *
 * Intelligence hub card for vocabulary configuration status.
 */

import { BookOpen } from 'lucide-react';
import { useTranslations } from 'next-intl';
import useSWR from 'swr';
import { IntelligenceCard, type IntelligenceCardState } from '../IntelligenceCard';

interface VocabularyCardProps {
  indexId: string;
  onNavigate: () => void;
}

interface VocabularyEntry {
  id: string;
  term: string;
  aliases?: string[];
  description?: string;
  fieldRef?: string;
  enabled?: boolean;
  confidence?: number | null;
  generatedBy?: string;
  [key: string]: unknown;
}

interface VocabularyResponse {
  entries: VocabularyEntry[];
  total: number;
}

export function VocabularyCard({ indexId, onNavigate }: VocabularyCardProps) {
  const t = useTranslations('search_ai.intelligence');
  const { data, error, isLoading } = useSWR<VocabularyResponse>(
    indexId ? `/api/search-ai/indexes/${indexId}/vocabulary` : null,
  );

  let state: IntelligenceCardState = 'not-configured';
  const stats: { label: string; value: string | number }[] = [];

  const totalEntries = data?.total ?? 0;
  const enabledCount = data?.entries?.filter((e) => e.enabled !== false).length ?? 0;
  const withAliases = data?.entries?.filter((e) => e.aliases && e.aliases.length > 0).length ?? 0;

  if (totalEntries > 0) {
    state = 'healthy';
    stats.push({ label: t('vocabulary_stat_terms'), value: totalEntries });
    if (withAliases > 0) {
      stats.push({ label: t('vocabulary_stat_synonyms'), value: withAliases });
    }
  }

  return (
    <IntelligenceCard
      title={t('vocabulary_title')}
      icon={BookOpen}
      state={state}
      stats={stats}
      description={t('vocabulary_description')}
      actionLabel={
        state === 'not-configured' ? t('vocabulary_action_setup') : t('vocabulary_action_manage')
      }
      onAction={onNavigate}
      isLoading={isLoading}
      isError={!!error}
    />
  );
}
