/**
 * Variable Namespaces API Client
 *
 * Functions for managing variable namespaces (organizational grouping for env/config variables).
 * Routes through the Studio API proxy (not direct runtime — avoids CORS).
 */

import { apiFetch, handleResponse } from '../lib/api-client';

// =============================================================================
// TYPES
// =============================================================================

export interface VariableNamespace {
  id: string;
  name: string;
  displayName: string;
  description: string | null;
  icon: string | null;
  color: string | null;
  order: number;
  isDefault: boolean;
  memberCounts: { env: number; config: number };
  createdAt: string;
}

export interface CreateVariableNamespaceInput {
  name: string;
  displayName: string;
  description?: string;
  icon?: string;
  color?: string;
}

export interface UpdateVariableNamespaceInput {
  displayName?: string;
  description?: string | null;
  icon?: string | null;
  color?: string | null;
}

export interface ReorderItem {
  variableNamespaceId: string;
  order: number;
}

export interface MemberVariable {
  variableId: string;
  variableType: 'env' | 'config';
}

// =============================================================================
// HELPERS
// =============================================================================

function variableNamespaceUrl(projectId: string, path = '') {
  return `/api/projects/${projectId}/variable-namespaces${path}`;
}

// =============================================================================
// CRUD
// =============================================================================

export async function fetchVariableNamespaces(
  projectId: string,
): Promise<{ success: boolean; namespaces: VariableNamespace[] }> {
  const response = await apiFetch(variableNamespaceUrl(projectId), {
    headers: { 'Content-Type': 'application/json' },
  });
  return handleResponse(response);
}

export async function createVariableNamespace(
  projectId: string,
  data: CreateVariableNamespaceInput,
): Promise<{ success: boolean; namespace: VariableNamespace }> {
  const response = await apiFetch(variableNamespaceUrl(projectId), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
  return handleResponse(response);
}

export async function updateVariableNamespace(
  projectId: string,
  variableNamespaceId: string,
  data: UpdateVariableNamespaceInput,
): Promise<{ success: boolean; namespace: VariableNamespace }> {
  const response = await apiFetch(variableNamespaceUrl(projectId, `/${variableNamespaceId}`), {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
  return handleResponse(response);
}

export async function deleteVariableNamespace(
  projectId: string,
  variableNamespaceId: string,
): Promise<{ success: boolean; movedToDefault: number }> {
  const response = await apiFetch(variableNamespaceUrl(projectId, `/${variableNamespaceId}`), {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
  });
  return handleResponse(response);
}

export async function reorderVariableNamespaces(
  projectId: string,
  order: ReorderItem[],
): Promise<{ success: boolean }> {
  const response = await apiFetch(variableNamespaceUrl(projectId, '/reorder'), {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ order }),
  });
  return handleResponse(response);
}

// =============================================================================
// MEMBERSHIP
// =============================================================================

function variableNamespaceMemberUrl(projectId: string, variableNamespaceId: string, path = '') {
  return `/api/projects/${projectId}/variable-namespaces/${variableNamespaceId}/members${path}`;
}

export async function addMembersToVariableNamespace(
  projectId: string,
  variableNamespaceId: string,
  variables: MemberVariable[],
): Promise<{
  success: boolean;
  added: number;
  skipped: number;
  errors: Array<{ variableId: string; reason: string }>;
}> {
  const response = await apiFetch(variableNamespaceMemberUrl(projectId, variableNamespaceId), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ variables }),
  });
  return handleResponse(response);
}

export async function removeMemberFromVariableNamespace(
  projectId: string,
  variableNamespaceId: string,
  variableId: string,
  type: 'env' | 'config',
): Promise<{ success: boolean; movedToDefault: boolean }> {
  const response = await apiFetch(
    variableNamespaceMemberUrl(projectId, variableNamespaceId, `/${variableId}?type=${type}`),
    {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
    },
  );
  return handleResponse(response);
}
