/**
 * useRunPolling Hook
 *
 * Polls /api/pipelines/runs/:runId every 2s until the run reaches a terminal state.
 */

import useSWR from 'swr';
import { swrFetcher } from '../../../lib/swr-config';
import type { IPipelineRunRecord } from './types';

const TERMINAL_STATUSES = ['completed', 'failed', 'cancelled'];

interface RunDetailResponse {
  success: boolean;
  run: IPipelineRunRecord;
}

export function useRunPolling(runId: string | null) {
  const { data, error, isLoading, mutate } = useSWR<RunDetailResponse>(
    runId ? `/api/pipelines/runs/${runId}` : null,
    swrFetcher,
    {
      refreshInterval: (latestData?: RunDetailResponse) => {
        if (!latestData?.run) return 2000;
        return TERMINAL_STATUSES.includes(latestData.run.status) ? 0 : 2000;
      },
      revalidateOnFocus: false,
    },
  );

  return { run: data?.run ?? null, error, isLoading, refresh: mutate };
}
