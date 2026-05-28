/**
 * External Agents API Client
 *
 * Typed functions for external agent registry CRUD operations.
 * Proxied to runtime via Studio API routes.
 */

import { apiFetch, handleResponse } from '../lib/api-client';

// =============================================================================
// TYPES
// =============================================================================

export interface ExternalAgentConfig {
  id: string;
  name: string;
  displayName: string | null;
  endpoint: string;
  protocol: 'a2a' | 'rest';
  authType: 'none' | 'bearer' | 'api_key';
  authConfigured: boolean;
  lastDiscoveredCard: Record<string, unknown> | null;
  lastConnectionStatus: 'connected' | 'failed' | null;
  lastConnectionAt: string | null;
  lastConnectionLatencyMs: number | null;
  lastConnectionError: string | null;
  createdBy: string | null;
  modifiedBy: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ExternalAgentListResponse {
  success: boolean;
  data: ExternalAgentConfig[];
}

export interface ExternalAgentDetailResponse {
  success: boolean;
  data: ExternalAgentConfig;
}

export interface CreateExternalAgentInput {
  name: string;
  displayName?: string | null;
  endpoint: string;
  protocol: 'a2a' | 'rest';
  authType: 'none' | 'bearer' | 'api_key';
  authConfig?: { value: string; header?: string } | null;
}

export interface UpdateExternalAgentInput {
  displayName?: string | null;
  endpoint?: string;
  protocol?: 'a2a' | 'rest';
  authType?: 'none' | 'bearer' | 'api_key';
  authConfig?: { value: string; header?: string } | null;
}

// =============================================================================
// API FUNCTIONS
// =============================================================================

export async function fetchExternalAgents(projectId: string): Promise<ExternalAgentListResponse> {
  const response = await apiFetch(`/api/projects/${projectId}/external-agents`);
  return handleResponse<ExternalAgentListResponse>(response);
}

export async function fetchExternalAgent(
  projectId: string,
  agentId: string,
): Promise<ExternalAgentDetailResponse> {
  const response = await apiFetch(`/api/projects/${projectId}/external-agents/${agentId}`);
  return handleResponse<ExternalAgentDetailResponse>(response);
}

export async function createExternalAgent(
  projectId: string,
  data: CreateExternalAgentInput,
): Promise<ExternalAgentDetailResponse> {
  const response = await apiFetch(`/api/projects/${projectId}/external-agents`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
  return handleResponse<ExternalAgentDetailResponse>(response);
}

export async function updateExternalAgent(
  projectId: string,
  agentId: string,
  data: UpdateExternalAgentInput,
): Promise<ExternalAgentDetailResponse> {
  const response = await apiFetch(`/api/projects/${projectId}/external-agents/${agentId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
  return handleResponse<ExternalAgentDetailResponse>(response);
}

export async function deleteExternalAgent(projectId: string, agentId: string): Promise<void> {
  const response = await apiFetch(`/api/projects/${projectId}/external-agents/${agentId}`, {
    method: 'DELETE',
  });
  // DELETE returns 204 No Content — only check for errors
  if (!response.ok) {
    await handleResponse(response);
  }
}

export async function testExternalAgentConnection(
  projectId: string,
  agentId: string,
): Promise<ExternalAgentDetailResponse> {
  const response = await apiFetch(
    `/api/projects/${projectId}/external-agents/${agentId}/test-connection`,
    { method: 'POST' },
  );
  return handleResponse<ExternalAgentDetailResponse>(response);
}
