/**
 * Environment Variables API Client
 *
 * Functions for managing per-environment configuration variables.
 */

import { apiFetch, handleResponse } from '../lib/api-client';
import { getRuntimeUrl } from '../config/runtime';

// =============================================================================
// TYPES
// =============================================================================

export interface EnvironmentVariable {
  id: string;
  key: string;
  environment: string;
  isSecret: boolean;
  description: string | null;
  variableNamespaceIds: string[];
  createdBy: string;
  updatedBy: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface EnvVarWithValue {
  id: string;
  key: string;
  value: string;
}

export interface EnvVarValidation {
  missing: string[];
  defined: string[];
}

// =============================================================================
// API
// =============================================================================

function envVarUrl(projectId: string, path = '') {
  return `${getRuntimeUrl()}/api/projects/${projectId}/env-vars${path}`;
}

export async function fetchEnvironmentVariables(
  projectId: string,
  environment?: string,
  options?: { namespaceId?: string },
): Promise<{
  success: boolean;
  variables: EnvironmentVariable[];
  pagination: { page: number; limit: number; total: number; totalPages: number };
}> {
  const qs = new URLSearchParams();
  if (environment !== undefined) {
    qs.set('environment', environment);
  }
  qs.set('limit', '100');
  if (options?.namespaceId) qs.set('namespaceId', options.namespaceId);

  const response = await apiFetch(envVarUrl(projectId, `?${qs}`), {
    headers: { 'Content-Type': 'application/json' },
  });
  return handleResponse(response);
}

export async function createEnvironmentVariable(
  projectId: string,
  data: {
    environment: string;
    key: string;
    value: string;
    isSecret?: boolean;
    description?: string;
    variableNamespaceIds?: string[];
  },
): Promise<{ success: boolean; variable: EnvironmentVariable }> {
  const response = await apiFetch(envVarUrl(projectId), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
  return handleResponse(response);
}

export async function getEnvironmentVariableValue(
  projectId: string,
  id: string,
): Promise<{ success: boolean; variable: EnvVarWithValue }> {
  const response = await apiFetch(envVarUrl(projectId, `/${id}/value`), {
    headers: { 'Content-Type': 'application/json' },
  });
  return handleResponse(response);
}

export async function updateEnvironmentVariable(
  projectId: string,
  id: string,
  data: {
    value?: string;
    isSecret?: boolean;
    description?: string | null;
    variableNamespaceIds?: string[];
  },
): Promise<{ success: boolean; variable: EnvironmentVariable }> {
  const response = await apiFetch(envVarUrl(projectId, `/${id}`), {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
  return handleResponse(response);
}

export async function deleteEnvironmentVariable(
  projectId: string,
  id: string,
): Promise<{ success: boolean; deleted: string }> {
  const response = await apiFetch(envVarUrl(projectId, `/${id}`), {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
  });
  return handleResponse(response);
}

export async function copyEnvironmentVariables(
  projectId: string,
  data: { sourceEnvironment: string; targetEnvironment: string; overwrite?: boolean },
): Promise<{ success: boolean; copied: number; skipped: number }> {
  const response = await apiFetch(envVarUrl(projectId, '/copy'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
  return handleResponse(response);
}

export interface ExportedVariable {
  key: string;
  value: string;
  isSecret: boolean;
  description: string | null;
}

export interface EnvVarDiff {
  added: string[];
  removed: string[];
  changed: string[];
  unchanged: string[];
}

export async function exportEnvironmentVariables(
  projectId: string,
  environment: string,
): Promise<{ success: boolean; variables: ExportedVariable[] }> {
  const response = await apiFetch(envVarUrl(projectId, '/export'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ environment }),
  });
  return handleResponse(response);
}

export async function importEnvironmentVariables(
  projectId: string,
  data: {
    environment: string;
    variables: Array<{
      key: string;
      value: string;
      isSecret?: boolean;
      description?: string;
    }>;
    overwrite?: boolean;
  },
): Promise<{ success: boolean; imported: number; skipped: number; errors: string[] }> {
  const response = await apiFetch(envVarUrl(projectId, '/import'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
  return handleResponse(response);
}

export async function diffEnvironmentVariables(
  projectId: string,
  source: string,
  target: string,
): Promise<{ success: boolean; diff: EnvVarDiff }> {
  const qs = new URLSearchParams({ source, target });
  const response = await apiFetch(envVarUrl(projectId, `/diff?${qs}`), {
    headers: { 'Content-Type': 'application/json' },
  });
  return handleResponse(response);
}

export async function validateEnvVars(
  projectId: string,
  environment: string,
  agentNames?: string[],
): Promise<{ success: boolean } & EnvVarValidation> {
  const response = await apiFetch(envVarUrl(projectId, '/validate'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ environment, agentNames }),
  });
  return handleResponse(response);
}
