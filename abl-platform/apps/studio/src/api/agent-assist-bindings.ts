/**
 * Agent Assist Bindings API Client
 *
 * Functions for managing agentic compat bindings via the Studio proxy.
 * Mirrors the pattern of apps/studio/src/api/agent-transfer.ts.
 */

import { apiFetch, handleResponse } from '../lib/api-client';

// =============================================================================
// TYPE DEFINITIONS
// =============================================================================

export interface AgentAssistBinding {
  _id: string;
  tenantId: string;
  projectId: string;
  appId: string;
  environment: string;
  status: 'active' | 'disabled';
  deploymentId: string | null;
  apiKeyId: string | null;
  apiKeyPrefix: string | null;
  displayName: string | null;
  runtimeBaseUrl: string | null;
  createdBy: string;
  updatedBy: string | null;
  disabledAt: string | null;
  disabledBy: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AgentAssistBindingCreateInput {
  environment: string;
  displayName?: string | null;
  runtimeBaseUrl?: string | null;
}

/** @deprecated Legacy input that accepts appId — use AgentAssistBindingCreateInput */
export interface AgentAssistBindingCreateInputLegacy {
  appId: string;
  environment: string;
  deploymentId?: string | null;
  apiKeyId?: string | null;
  displayName?: string | null;
  runtimeBaseUrl?: string | null;
}

export interface AgentAssistBindingUpdateInput {
  deploymentId?: string | null;
  apiKeyId?: string | null;
  displayName?: string | null;
  runtimeBaseUrl?: string | null;
  status?: 'active' | 'disabled';
}

export interface AgentAssistSettings {
  enabled: boolean;
}

export interface GenerateApiKeyResult {
  rawKey: string;
  prefix: string;
  apiKeyId: string;
}

interface PaginatedResponse {
  items: AgentAssistBinding[];
  pagination: {
    page: number;
    limit: number;
    total: number;
    totalPages?: number;
  };
}

// =============================================================================
// API FUNCTIONS
// =============================================================================

function bindingsUrl(projectId: string, suffix = ''): string {
  return `/api/projects/${encodeURIComponent(projectId)}/agent-assist-bindings${suffix}`;
}

export async function listAgentAssistBindings(
  projectId: string,
  params?: { page?: number; limit?: number },
): Promise<PaginatedResponse> {
  const qs = new URLSearchParams();
  if (params?.page !== undefined) qs.set('page', String(params.page));
  if (params?.limit !== undefined) qs.set('limit', String(params.limit));
  const query = qs.toString();
  const url = bindingsUrl(projectId) + (query ? `?${query}` : '');

  const response = await apiFetch(url);
  const result = await handleResponse<{ success: boolean; data?: PaginatedResponse }>(response);
  return result.data ?? { items: [], pagination: { page: 1, limit: 25, total: 0 } };
}

export async function getAgentAssistBinding(
  projectId: string,
  bindingId: string,
): Promise<AgentAssistBinding> {
  const response = await apiFetch(bindingsUrl(projectId, `/${encodeURIComponent(bindingId)}`));
  const result = await handleResponse<{ success: boolean; data: AgentAssistBinding }>(response);
  return result.data;
}

export async function createAgentAssistBinding(
  projectId: string,
  input: AgentAssistBindingCreateInput,
): Promise<AgentAssistBinding> {
  const response = await apiFetch(bindingsUrl(projectId), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  const result = await handleResponse<{ success: boolean; data: AgentAssistBinding }>(response);
  return result.data;
}

export async function updateAgentAssistBinding(
  projectId: string,
  bindingId: string,
  patch: AgentAssistBindingUpdateInput,
): Promise<AgentAssistBinding> {
  const response = await apiFetch(bindingsUrl(projectId, `/${encodeURIComponent(bindingId)}`), {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  });
  const result = await handleResponse<{ success: boolean; data: AgentAssistBinding }>(response);
  return result.data;
}

export async function deleteAgentAssistBinding(
  projectId: string,
  bindingId: string,
): Promise<void> {
  const response = await apiFetch(bindingsUrl(projectId, `/${encodeURIComponent(bindingId)}`), {
    method: 'DELETE',
  });
  await handleResponse(response);
}

export async function disableAgentAssistBinding(
  projectId: string,
  bindingId: string,
): Promise<AgentAssistBinding> {
  const response = await apiFetch(
    bindingsUrl(projectId, `/${encodeURIComponent(bindingId)}/disable`),
    { method: 'POST' },
  );
  const result = await handleResponse<{ success: boolean; data: AgentAssistBinding }>(response);
  return result.data;
}

export async function enableAgentAssistBinding(
  projectId: string,
  bindingId: string,
): Promise<AgentAssistBinding> {
  const response = await apiFetch(
    bindingsUrl(projectId, `/${encodeURIComponent(bindingId)}/enable`),
    { method: 'POST' },
  );
  const result = await handleResponse<{ success: boolean; data: AgentAssistBinding }>(response);
  return result.data;
}

// =============================================================================
// SETTINGS API
// =============================================================================

export async function getAgentAssistSettings(projectId: string): Promise<AgentAssistSettings> {
  const response = await apiFetch(bindingsUrl(projectId, '/settings'));
  const result = await handleResponse<{ success: boolean; data: AgentAssistSettings }>(response);
  return result.data;
}

export async function updateAgentAssistSettings(
  projectId: string,
  patch: AgentAssistSettings,
): Promise<AgentAssistSettings> {
  const response = await apiFetch(bindingsUrl(projectId, '/settings'), {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  });
  const result = await handleResponse<{ success: boolean; data: AgentAssistSettings }>(response);
  return result.data;
}

// =============================================================================
// API KEY GENERATION
// =============================================================================

export async function generateAgentAssistApiKey(
  projectId: string,
  bindingId: string,
): Promise<GenerateApiKeyResult> {
  const response = await apiFetch(
    bindingsUrl(projectId, `/${encodeURIComponent(bindingId)}/generate-api-key`),
    { method: 'POST' },
  );
  const result = await handleResponse<{ success: boolean; data: GenerateApiKeyResult }>(response);
  return result.data;
}

// =============================================================================
// ENVIRONMENTS API
// =============================================================================

export async function listProjectEnvironments(projectId: string): Promise<string[]> {
  const response = await apiFetch(`/api/projects/${encodeURIComponent(projectId)}/environments`);
  const result = await handleResponse<{
    success: boolean;
    data: { environments: string[] };
  }>(response);
  return result.data.environments;
}
