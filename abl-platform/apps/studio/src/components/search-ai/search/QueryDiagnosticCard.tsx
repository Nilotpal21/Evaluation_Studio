/**
 * QueryDiagnosticCard Component
 *
 * Displays diagnostic categories for a search index:
 * Data & Indexing, Enrichment, and Pipeline Health.
 * Uses SWR to fetch index stats.
 */

import { useState, useCallback } from 'react';
import { useTranslations } from 'next-intl';
import useSWR from 'swr';
import {
  ChevronDown,
  ChevronRight,
  Database,
  Sparkles,
  Activity,
  Loader2,
  ExternalLink,
} from 'lucide-react';
import { useNavigationStore } from '../../../store/navigation-store';
import type { SearchAIIndex } from '../../../api/search-ai';

interface QueryDiagnosticCardProps {
  indexId: string;
  knowledgeBaseId: string;
}

interface DiagnosticItem {
  label: string;
  value: string | number | null;
}

function DiagnosticSection({
  title,
  icon,
  items,
  defaultOpen = false,
  actionLabel,
  onAction,
}: {
  title: string;
  icon: React.ReactNode;
  items: DiagnosticItem[];
  defaultOpen?: boolean;
  actionLabel?: string;
  onAction?: () => void;
}) {
  const [open, setOpen] = useState(defaultOpen);

  return (
    <div className="border-b border-default last:border-b-0">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className="flex items-center gap-2 w-full px-4 py-3 text-sm font-medium text-foreground hover:bg-background-muted transition-default"
      >
        {open ? (
          <ChevronDown className="w-3.5 h-3.5 text-muted" />
        ) : (
          <ChevronRight className="w-3.5 h-3.5 text-muted" />
        )}
        <span className="text-muted">{icon}</span>
        {title}
      </button>
      {open && (
        <>
          <div className="px-4 pb-3 space-y-2">
            {items.map((item) => (
              <div key={item.label} className="flex items-center justify-between text-xs">
                <span className="text-muted">{item.label}</span>
                <span className="font-mono text-foreground">{item.value ?? '\u2014'}</span>
              </div>
            ))}
          </div>
          {onAction && actionLabel && (
            <button
              type="button"
              onClick={onAction}
              className="flex items-center gap-1 text-xs text-accent hover:text-accent-hover transition-default mt-2 px-4 pb-2"
            >
              <ExternalLink className="w-3 h-3" />
              {actionLabel}
            </button>
          )}
        </>
      )}
    </div>
  );
}

function formatDate(dateStr: string | null): string {
  if (!dateStr) return '\u2014';
  try {
    return new Date(dateStr).toLocaleDateString(undefined, {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return '\u2014';
  }
}

export function QueryDiagnosticCard({ indexId, knowledgeBaseId }: QueryDiagnosticCardProps) {
  const t = useTranslations('search_ai.diagnostics');
  const { setTabAndSubSection } = useNavigationStore();
  const navigateToIntelligence = useCallback(
    (sub: string) => {
      setTabAndSubSection('intelligence', sub);
    },
    [setTabAndSubSection],
  );
  const {
    data: indexData,
    error,
    isLoading,
    mutate,
  } = useSWR<{ index: SearchAIIndex }>(indexId ? `/api/search-ai/indexes/${indexId}` : null);
  const data = indexData?.index;

  // Vocabulary: fetch term count for this index
  const { data: vocabData } = useSWR<{ count?: number; terms?: unknown[] }>(
    indexId ? `/api/search-ai/indexes/${indexId}/vocabulary` : null,
  );

  // Field mapping stats: confirmed/suggested/unmapped counts
  const { data: fieldStats } = useSWR<{
    confirmedCount?: number;
    suggestedCount?: number;
    unmappedCount?: number;
    totalFields?: number;
  }>(
    knowledgeBaseId ? `/api/search-ai/mappings/tab-stats?knowledgeBaseId=${knowledgeBaseId}` : null,
  );

  const vocabCount = vocabData?.count ?? vocabData?.terms?.length ?? 0;
  const vocabStatus =
    vocabCount > 0 ? t('vocab_terms', { count: vocabCount }) : t('not_configured');

  const confirmedFields = fieldStats?.confirmedCount ?? 0;
  const suggestedFields = fieldStats?.suggestedCount ?? 0;
  const fieldStatus =
    confirmedFields > 0
      ? suggestedFields > 0
        ? t('fields_confirmed_suggested', {
            confirmed: confirmedFields,
            suggested: suggestedFields,
          })
        : t('fields_confirmed', { confirmed: confirmedFields })
      : suggestedFields > 0
        ? t('fields_suggested', { suggested: suggestedFields })
        : t('not_configured');

  if (isLoading) {
    return (
      <div className="rounded-xl border border-default bg-background-elevated p-4">
        <div className="flex items-center gap-2 text-sm text-muted">
          <Loader2 className="w-4 h-4 animate-spin" />
          {t('loading')}
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="rounded-xl border border-default bg-background-elevated p-4">
        <p className="text-sm text-error">{t('error_loading')}</p>
        <button
          type="button"
          onClick={() => mutate()}
          className="mt-2 text-sm text-accent hover:underline"
        >
          {t('retry')}
        </button>
      </div>
    );
  }

  const index = data;

  return (
    <div className="rounded-xl border border-default bg-background-elevated">
      <div className="px-4 py-3 border-b border-default">
        <h3 className="text-sm font-semibold text-foreground">{t('title')}</h3>
      </div>

      <DiagnosticSection
        title={t('section_data_indexing')}
        icon={<Database className="w-3.5 h-3.5" />}
        defaultOpen
        items={[
          { label: t('label_documents'), value: index?.documentCount ?? 0 },
          { label: t('label_chunks'), value: index?.chunkCount ?? 0 },
          { label: t('label_last_indexed'), value: formatDate(index?.lastIndexedAt ?? null) },
        ]}
        actionLabel={t('view_pipeline')}
        onAction={() => navigateToIntelligence('pipeline')}
      />

      <DiagnosticSection
        title={t('section_enrichment')}
        icon={<Sparkles className="w-3.5 h-3.5" />}
        items={[
          { label: t('label_vocabulary'), value: vocabStatus },
          { label: t('label_field_mappings'), value: fieldStatus },
        ]}
        actionLabel={t('view_vocabulary')}
        onAction={() => navigateToIntelligence('vocabulary')}
      />

      <DiagnosticSection
        title={t('section_pipeline_health')}
        icon={<Activity className="w-3.5 h-3.5" />}
        items={[
          { label: t('label_embedding_model'), value: index?.embeddingModel ?? '\u2014' },
          { label: t('label_status'), value: index?.status ?? '\u2014' },
          { label: t('label_index_error'), value: index?.indexError ?? t('no_error') },
        ]}
        actionLabel={t('view_knowledge_graph')}
        onAction={() => navigateToIntelligence('knowledge-graph')}
      />
    </div>
  );
}
