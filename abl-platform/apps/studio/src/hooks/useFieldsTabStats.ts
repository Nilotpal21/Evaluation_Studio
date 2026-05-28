import useSWR from 'swr';

interface TabStats {
  confirmedCount: number;
  suggestedCount: number;
  unmappedCount: number;
  totalFields: number;
}

export function useFieldsTabStats(indexId: string | undefined) {
  const key = indexId ? `/api/search-ai/mappings/tab-stats?knowledgeBaseId=${indexId}` : null;
  const { data, error, isLoading, mutate } = useSWR<TabStats>(key);

  return {
    stats: data ?? { confirmedCount: 0, suggestedCount: 0, unmappedCount: 0, totalFields: 0 },
    isLoading,
    error: error ? String(error) : null,
    refresh: () => mutate(),
  };
}
