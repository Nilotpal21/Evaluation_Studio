import useSWR from 'swr';
import { useAuthStore } from '../store/auth-store';
import { apiFetch } from '../lib/api-client';
import type {
  PoliciesResponse,
  PolicyResponse,
  CreatePolicyBody,
  UpdatePolicyBody,
} from '../lib/governance-contracts';

const SWR_OPTIONS = {
  refreshInterval: 30_000,
  keepPreviousData: true,
};

export function useGovernancePolicies(projectId: string | null) {
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  const key =
    isAuthenticated && projectId
      ? `/api/runtime/governance/policies?projectId=${encodeURIComponent(projectId)}`
      : null;

  const { data, error, isLoading, mutate } = useSWR<PoliciesResponse>(key, SWR_OPTIONS);

  const createPolicy = async (body: CreatePolicyBody): Promise<PolicyResponse> => {
    if (!projectId) throw new Error('No project selected');
    const res = await apiFetch(
      `/api/runtime/governance/policies?projectId=${encodeURIComponent(projectId)}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      },
    );
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(
        (err as { error?: { message?: string } })?.error?.message ?? 'Failed to create policy',
      );
    }
    const result: PolicyResponse = await res.json();
    await mutate();
    return result;
  };

  const updatePolicy = async (
    policyId: string,
    body: UpdatePolicyBody,
  ): Promise<PolicyResponse> => {
    if (!projectId) throw new Error('No project selected');
    const res = await apiFetch(
      `/api/runtime/governance/policies/${encodeURIComponent(policyId)}?projectId=${encodeURIComponent(projectId)}`,
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      },
    );
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(
        (err as { error?: { message?: string } })?.error?.message ?? 'Failed to update policy',
      );
    }
    const result: PolicyResponse = await res.json();
    await mutate();
    return result;
  };

  const deletePolicy = async (policyId: string): Promise<void> => {
    if (!projectId) throw new Error('No project selected');
    const res = await apiFetch(
      `/api/runtime/governance/policies/${encodeURIComponent(policyId)}?projectId=${encodeURIComponent(projectId)}`,
      { method: 'DELETE' },
    );
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(
        (err as { error?: { message?: string } })?.error?.message ?? 'Failed to delete policy',
      );
    }
    await mutate();
  };

  return {
    policies: data?.data ?? [],
    isLoading,
    error,
    createPolicy,
    updatePolicy,
    deletePolicy,
    mutate,
  };
}
