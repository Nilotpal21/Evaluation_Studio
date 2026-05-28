/**
 * useKnowledgeBases Hook
 *
 * SWR hook for fetching the list of knowledge bases for a project.
 */

import { useMemo } from 'react';
import useSWR from 'swr';
import type { KnowledgeBase } from '../api/search-ai';

interface AggregateDocStats {
  totalDocuments: number;
  failedDocuments: number;
}

interface KnowledgeBasesResponse {
  knowledgeBases: KnowledgeBase[];
  total: number;
  aggregateDocStats?: AggregateDocStats;
}

interface UseKnowledgeBasesReturn {
  knowledgeBases: KnowledgeBase[];
  total: number;
  aggregateDocStats: AggregateDocStats;
  isLoading: boolean;
  error: string | null;
  refresh: () => void;
}

export function useKnowledgeBases(projectId: string | null): UseKnowledgeBasesReturn {
  const key = projectId ? `/api/search-ai/knowledge-bases?projectId=${projectId}` : null;
  const { data, error, isLoading, mutate } = useSWR<KnowledgeBasesResponse>(key, {
    shouldRetryOnError: false,
    errorRetryCount: 0,
  });

  const knowledgeBases = useMemo(() => data?.knowledgeBases ?? [], [data]);
  const total = data?.total ?? 0;
  const aggregateDocStats = useMemo(
    () => data?.aggregateDocStats ?? { totalDocuments: 0, failedDocuments: 0 },
    [data],
  );

  return {
    knowledgeBases,
    total,
    aggregateDocStats,
    isLoading,
    error: error ? String(error) : null,
    refresh: () => mutate(),
  };
}
