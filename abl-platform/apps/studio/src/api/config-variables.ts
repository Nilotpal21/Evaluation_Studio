/**
 * Config Variables API Client
 *
 * Functions for managing project-level config variables (compile-time {{config.KEY}}).
 * Routes through the Studio API (not runtime).
 */

import { apiFetch, handleResponse } from '../lib/api-client';

// =============================================================================
// TYPES
// =============================================================================

export interface ConfigVariable {
  id: string;
  key: string;
  value: string;
  description: string | null;
  createdBy: string;
  updatedBy: string | null;
  createdAt: string;
  updatedAt: string;
}

// =============================================================================
// API
// =============================================================================

function configVarUrl(projectId: string, path = '') {
  return `/api/projects/${projectId}/config-variables${path}`;
}

export async function fetchConfigVariables(
  projectId: string,
): Promise<{ success: boolean; variables: ConfigVariable[] }> {
  const response = await apiFetch(configVarUrl(projectId), {
    headers: { 'Content-Type': 'application/json' },
  });
  return handleResponse(response);
}

export async function createConfigVariable(
  projectId: string,
  data: { key: string; value: string; description?: string },
): Promise<{ success: boolean; variable: ConfigVariable }> {
  const response = await apiFetch(configVarUrl(projectId), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
  return handleResponse(response);
}

export async function updateConfigVariable(
  projectId: string,
  id: string,
  data: { value?: string; description?: string | null },
): Promise<{ success: boolean; variable: ConfigVariable }> {
  const response = await apiFetch(configVarUrl(projectId, `/${id}`), {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
  return handleResponse(response);
}

export async function deleteConfigVariable(
  projectId: string,
  id: string,
): Promise<{ success: boolean; deleted: string }> {
  const response = await apiFetch(configVarUrl(projectId, `/${id}`), {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
  });
  return handleResponse(response);
}
