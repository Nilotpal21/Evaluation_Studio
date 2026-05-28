import useSWR from 'swr';
import { useAuthStore } from '../store/auth-store';
import { apiFetch } from '../lib/api-client';
import type {
  AuditResponse,
  CreateOverrideBody,
  OverrideResponse,
} from '../lib/governance-contracts';

const SWR_OPTIONS = {
  refreshInterval: 30_000,
  keepPreviousData: true,
};

export interface AuditQueryParams {
  period?: string;
  page?: number;
  limit?: number;
  pipelineTypes?: string[];
  agentNames?: string[];
  severities?: string[];
  eventTypes?: string[];
}

export function useGovernanceAudit(projectId: string | null, params: AuditQueryParams = {}) {
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);

  const { period = '7d', page = 1, limit = 50 } = params;

  let key: string | null = null;
  if (isAuthenticated && projectId) {
    const qs = new URLSearchParams({
      projectId,
      period,
      page: String(page),
      limit: String(limit),
    });
    if (params.pipelineTypes?.length) qs.set('pipelineType', params.pipelineTypes.join(','));
    if (params.agentNames?.length) qs.set('agentName', params.agentNames.join(','));
    if (params.severities?.length) qs.set('severity', params.severities.join(','));
    if (params.eventTypes?.length) qs.set('eventType', params.eventTypes.join(','));
    key = `/api/runtime/governance/audit?${qs.toString()}`;
  }

  const { data, error, isLoading, mutate } = useSWR<AuditResponse>(key, SWR_OPTIONS);

  const createOverride = async (
    eventRef: string,
    body: CreateOverrideBody,
  ): Promise<OverrideResponse> => {
    if (!projectId) throw new Error('No project selected');
    const res = await apiFetch(
      `/api/runtime/governance/audit/${encodeURIComponent(eventRef)}/override?projectId=${encodeURIComponent(projectId)}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      },
    );
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(
        (err as { error?: { message?: string } })?.error?.message ?? 'Failed to create override',
      );
    }
    const result: OverrideResponse = await res.json();
    await mutate();
    return result;
  };

  return {
    events: data?.data?.events ?? [],
    total: data?.data?.total ?? 0,
    page: data?.data?.page ?? page,
    limit: data?.data?.limit ?? limit,
    isLoading,
    error,
    createOverride,
    mutate,
  };
}
