/**
 * usePreviewablePipelines Hook
 *
 * Fetches pipelines that have a store-results node and can be previewed
 * in the Data tab. Sourced from the previewable-pipelines backend endpoint.
 */

import useSWR from 'swr';
import { swrFetcher } from '../../../lib/swr-config';
import type { PreviewablePipelinesResponse } from './types';

export function usePreviewablePipelines(projectId: string | null) {
  const { data, error, isLoading } = useSWR<PreviewablePipelinesResponse>(
    projectId
      ? `/api/runtime/projects/${projectId}/pipeline-observability/data/previewable-pipelines`
      : null,
    swrFetcher,
  );

  return { pipelines: data?.data ?? [], meta: data?.meta ?? null, error, isLoading };
}
