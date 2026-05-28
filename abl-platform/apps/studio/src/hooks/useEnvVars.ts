/**
 * useEnvVars Hook
 *
 * SWR hook for environment variable management endpoints.
 * Fetched via the Studio proxy at /api/admin/env-vars.
 */

import useSWR from 'swr';
import { useAuthStore } from '../store/auth-store';
import { apiFetch } from '../lib/api-client';

// =============================================================================
// TYPES
// =============================================================================

export interface EnvVar {
  id: string;
  key: string;
  value?: string;
  environments: string[];
  encrypted: boolean;
  description?: string;
  updatedAt: string;
  createdAt: string;
}

export interface EnvVarsResponse {
  success: boolean;
  data: EnvVar[];
}

export interface CreateEnvVarInput {
  key: string;
  value: string;
  environments: string[];
  encrypted?: boolean;
  description?: string;
}

export interface UpdateEnvVarInput {
  key?: string;
  value?: string;
  environments?: string[];
  encrypted?: boolean;
  description?: string;
}

export interface CopyEnvVarsInput {
  sourceEnvironment: string;
  targetEnvironment: string;
  overwrite?: boolean;
}

export interface CopyEnvVarsResult {
  copied: number;
  skipped: number;
}

export interface ValidateEnvVarsInput {
  environment: string;
  agentNames?: string[];
}

export interface ValidateEnvVarsResult {
  missing: string[];
  defined: string[];
}

// =============================================================================
// HOOK
// =============================================================================

const SWR_OPTIONS = {
  refreshInterval: 30_000,
  keepPreviousData: true,
};

export function useEnvVars(projectId: string | null) {
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);

  const key =
    isAuthenticated && projectId
      ? `/api/admin/env-vars?projectId=${encodeURIComponent(projectId)}`
      : null;

  const { data, error, isLoading, mutate } = useSWR<EnvVarsResponse>(key, SWR_OPTIONS);

  const createEnvVar = async (input: CreateEnvVarInput): Promise<void> => {
    if (!projectId) return;
    const res = await apiFetch(`/api/admin/env-vars?projectId=${encodeURIComponent(projectId)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error((err as { error?: string }).error || 'Failed to create env var');
    }
    await mutate();
  };

  const updateEnvVar = async (envVarId: string, input: UpdateEnvVarInput): Promise<void> => {
    if (!projectId) return;
    const res = await apiFetch(
      `/api/admin/env-vars?projectId=${encodeURIComponent(projectId)}&envVarId=${encodeURIComponent(envVarId)}`,
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(input),
      },
    );
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error((err as { error?: string }).error || 'Failed to update env var');
    }
    await mutate();
  };

  const deleteEnvVar = async (envVarId: string): Promise<void> => {
    if (!projectId) return;
    const res = await apiFetch(
      `/api/admin/env-vars?projectId=${encodeURIComponent(projectId)}&envVarId=${encodeURIComponent(envVarId)}`,
      { method: 'DELETE' },
    );
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error((err as { error?: string }).error || 'Failed to delete env var');
    }
    await mutate();
  };

  const bulkImport = async (pairs: Array<{ key: string; value: string }>): Promise<void> => {
    if (!projectId) return;
    const res = await apiFetch(`/api/admin/env-vars?projectId=${encodeURIComponent(projectId)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ bulk: pairs }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error((err as { error?: string }).error || 'Failed to import env vars');
    }
    await mutate();
  };

  const copyEnvVars = async (input: CopyEnvVarsInput): Promise<CopyEnvVarsResult> => {
    if (!projectId) return { copied: 0, skipped: 0 };
    const res = await apiFetch(
      `/api/admin/env-vars?projectId=${encodeURIComponent(projectId)}&action=copy`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(input),
      },
    );
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error((err as { error?: string }).error || 'Failed to copy env vars');
    }
    const result = await res.json();
    await mutate();
    return { copied: result.copied ?? 0, skipped: result.skipped ?? 0 };
  };

  const validateEnvVars = async (input: ValidateEnvVarsInput): Promise<ValidateEnvVarsResult> => {
    if (!projectId) return { missing: [], defined: [] };
    const res = await apiFetch(
      `/api/admin/env-vars?projectId=${encodeURIComponent(projectId)}&action=validate`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(input),
      },
    );
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error((err as { error?: string }).error || 'Failed to validate env vars');
    }
    const result = await res.json();
    return { missing: result.missing ?? [], defined: result.defined ?? [] };
  };

  return {
    envVars: data?.data ?? [],
    isLoading,
    error: error ? String(error) : null,
    mutate,
    createEnvVar,
    updateEnvVar,
    deleteEnvVar,
    bulkImport,
    copyEnvVars,
    validateEnvVars,
  };
}
