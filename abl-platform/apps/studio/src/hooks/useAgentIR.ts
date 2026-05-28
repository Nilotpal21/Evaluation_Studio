/**
 * useAgentIR Hook
 *
 * Fetches agent DSL, compiles to IR via the project-aware compile endpoint,
 * and loads parsed sections into agent-detail-store.
 */

import useSWR from 'swr';
import { apiFetch, handleResponse } from '@/lib/api-client';
import { useAgentDetailStore } from '@/store/agent-detail-store';

interface CompileResponse {
  success: boolean;
  ir: Record<string, unknown> | null;
  errors?: string[];
  warnings?: string[];
}

interface FetchAndCompileResult {
  ir: Record<string, unknown> | null;
  dsl: string;
  errors: string[];
  warnings: string[];
}

async function fetchAndCompile(
  projectId: string,
  agentName: string,
): Promise<FetchAndCompileResult> {
  // 1. Fetch agent DSL
  const agentRes = await apiFetch(
    `/api/projects/${projectId}/agents/${encodeURIComponent(agentName)}`,
  );
  const { agent } = await handleResponse<{ agent: { dslContent: string | null } }>(agentRes);

  if (!agent.dslContent) {
    return { ir: null, dsl: '', errors: ['Agent has no DSL content'], warnings: [] };
  }

  // 2. Compile DSL to IR
  const compileRes = await apiFetch(
    `/api/projects/${projectId}/agents/${encodeURIComponent(agentName)}/compile`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    },
  );
  const compileData = await handleResponse<CompileResponse>(compileRes);

  return {
    ir: compileData.success ? compileData.ir : null,
    dsl: agent.dslContent,
    errors: compileData.errors ?? [],
    warnings: compileData.warnings ?? [],
  };
}

export function useAgentIR(projectId: string | null, agentName: string | null) {
  const loadFromIR = useAgentDetailStore((s) => s.loadFromIR);

  const key = projectId && agentName ? (['agent-ir', projectId, agentName] as const) : null;

  const { data, error, isLoading, mutate } = useSWR(
    key,
    () => fetchAndCompile(projectId!, agentName!),
    {
      revalidateOnFocus: false,
      errorRetryCount: 2,
      errorRetryInterval: 2000,
      onSuccess: (result) => {
        if (result.ir) {
          loadFromIR(result.ir, `${projectId}/${agentName}`);
        }
      },
    },
  );

  return {
    ir: data?.ir ?? null,
    dsl: data?.dsl ?? '',
    compileErrors: data?.errors ?? [],
    compileWarnings: data?.warnings ?? [],
    isLoading,
    error: error ? String(error) : null,
    reload: () => mutate(),
  };
}
