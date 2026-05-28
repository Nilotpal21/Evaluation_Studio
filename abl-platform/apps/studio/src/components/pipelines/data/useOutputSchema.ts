/**
 * useOutputSchema Hook
 *
 * Fetches the output schema (column metadata) for a pipeline's
 * ClickHouse output table via the runtime's pipeline-observability
 * endpoint. Returns null when no pipelineId or projectId is provided.
 */

import useSWR from 'swr';
import { swrFetcher } from '../../../lib/swr-config';
import type { OutputSchemaResponse } from './types';

export function useOutputSchema(pipelineId: string | null, projectId: string | null) {
  const { data, error, isLoading } = useSWR<OutputSchemaResponse>(
    pipelineId && projectId
      ? `/api/runtime/projects/${projectId}/pipeline-observability/pipelines/${pipelineId}/output-schema`
      : null,
    swrFetcher,
  );

  return { schema: data?.data ?? null, meta: data?.meta ?? null, error, isLoading };
}
