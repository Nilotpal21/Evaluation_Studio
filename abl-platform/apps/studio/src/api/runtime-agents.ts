/**
 * Runtime Agents API Client
 *
 * Functions for project-scoped agent CRUD.
 * Uses studio proxy at /api/projects/:id/agents (which reads from MongoDB).
 * Falls back to runtime direct call for operations not proxied by studio.
 */

import { apiFetch, handleResponse } from '../lib/api-client';

// =============================================================================
// TYPES
// =============================================================================

export interface RuntimeAgent {
  id: string;
  name: string;
  agentPath: string;
  description: string | null;
  dslContent: string | null;
  versionCount?: number;
  activeVersions: Record<string, string> | string; // JSON string from DB or parsed object
  createdAt: string;
  updatedAt: string;
}

export interface RuntimeAgentListResponse {
  agents: RuntimeAgent[];
}

export interface RuntimeAgentDetailResponse {
  agent: RuntimeAgent;
}

/** Safely parse activeVersions which may be a JSON string or already an object */
export function parseActiveVersions(
  av: Record<string, string> | string | null | undefined,
): Record<string, string> {
  if (!av) return {};
  if (typeof av === 'string') {
    try {
      return JSON.parse(av);
    } catch {
      return {};
    }
  }
  return av;
}

// =============================================================================
// API — uses studio proxy (same-origin /api/projects/:id/agents)
// =============================================================================

export async function fetchRuntimeAgents(projectId: string): Promise<RuntimeAgentListResponse> {
  const response = await apiFetch(`/api/projects/${projectId}/agents`);
  return handleResponse<RuntimeAgentListResponse>(response);
}

export async function fetchRuntimeAgent(
  projectId: string,
  agentName: string,
): Promise<RuntimeAgentDetailResponse> {
  const response = await apiFetch(
    `/api/projects/${projectId}/agents/${encodeURIComponent(agentName)}`,
  );
  return handleResponse<RuntimeAgentDetailResponse>(response);
}

export async function saveDslWorkingCopy(
  projectId: string,
  agentName: string,
  dslContent: string,
): Promise<{ success: boolean; updatedAt: string }> {
  // Use studio proxy to avoid cross-origin issues with direct runtime calls
  const response = await apiFetch(`/api/projects/${projectId}/agents/${agentName}/dsl`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ dslContent }),
  });
  return handleResponse(response);
}
