/**
 * useAgentAssistBindings Hook
 *
 * Fetches and manages agentic compat bindings for the current project.
 * Uses SWR for dedup, stale-while-revalidate, and background refresh.
 *
 * Mirrors the pattern of useAgentTransferSettings.ts.
 */

'use client';

import useSWR from 'swr';
import {
  listAgentAssistBindings,
  createAgentAssistBinding,
  updateAgentAssistBinding,
  deleteAgentAssistBinding,
  enableAgentAssistBinding,
  disableAgentAssistBinding,
  getAgentAssistSettings,
  updateAgentAssistSettings,
  generateAgentAssistApiKey,
  listProjectEnvironments,
  type AgentAssistBinding,
  type AgentAssistBindingCreateInput,
  type AgentAssistBindingUpdateInput,
  type AgentAssistSettings,
  type GenerateApiKeyResult,
} from '../api/agent-assist-bindings';
import { useNavigationStore } from '../store/navigation-store';

export function useAgentAssistBindings() {
  const { projectId } = useNavigationStore();

  const { data, error, isLoading, mutate } = useSWR(
    projectId ? ['agent-assist-bindings', projectId] : null,
    async () => {
      const result = await listAgentAssistBindings(projectId!);
      return result.items;
    },
    { keepPreviousData: true },
  );

  const create = async (input: AgentAssistBindingCreateInput): Promise<AgentAssistBinding> => {
    const binding = await createAgentAssistBinding(projectId!, input);
    await mutate();
    return binding;
  };

  const update = async (
    bindingId: string,
    patch: AgentAssistBindingUpdateInput,
  ): Promise<AgentAssistBinding> => {
    const binding = await updateAgentAssistBinding(projectId!, bindingId, patch);
    await mutate();
    return binding;
  };

  const remove = async (bindingId: string): Promise<void> => {
    await deleteAgentAssistBinding(projectId!, bindingId);
    await mutate();
  };

  const enable = async (bindingId: string): Promise<AgentAssistBinding> => {
    const binding = await enableAgentAssistBinding(projectId!, bindingId);
    await mutate();
    return binding;
  };

  const disable = async (bindingId: string): Promise<AgentAssistBinding> => {
    const binding = await disableAgentAssistBinding(projectId!, bindingId);
    await mutate();
    return binding;
  };

  const mintApiKey = async (bindingId: string): Promise<GenerateApiKeyResult> => {
    const result = await generateAgentAssistApiKey(projectId!, bindingId);
    await mutate();
    return result;
  };

  return {
    bindings: data ?? [],
    isLoading,
    error: error ? String(error) : null,
    create,
    update,
    remove,
    enable,
    disable,
    mintApiKey,
    refresh: () => mutate(),
  };
}

export function useProjectEnvironments(projectId: string | null) {
  const { data, error, isLoading } = useSWR(
    projectId ? ['project-environments', projectId] : null,
    async () => {
      return listProjectEnvironments(projectId!);
    },
    { keepPreviousData: true },
  );

  return {
    environments: data ?? [],
    isLoading,
    error: error ? String(error) : null,
  };
}

export function useAgentAssistSettings() {
  const { projectId } = useNavigationStore();

  const { data, error, isLoading, mutate } = useSWR(
    projectId ? ['agent-assist-settings', projectId] : null,
    async () => {
      return getAgentAssistSettings(projectId!);
    },
    { keepPreviousData: true },
  );

  const saveSettings = async (patch: AgentAssistSettings): Promise<AgentAssistSettings> => {
    const result = await updateAgentAssistSettings(projectId!, patch);
    await mutate();
    return result;
  };

  return {
    settings: data ?? { enabled: false },
    isLoading,
    error: error ? String(error) : null,
    saveSettings,
    refresh: () => mutate(),
  };
}
