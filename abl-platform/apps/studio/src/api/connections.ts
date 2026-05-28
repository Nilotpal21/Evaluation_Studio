/**
 * Connections API Client
 *
 * Functions for connector connection management API calls.
 * Connections are pure binding records linking connectors to auth profiles.
 * All routes are project-scoped under /api/projects/:projectId/connections.
 */

import { apiFetch, handleResponse } from '../lib/api-client';
import {
  getConnectionCategory,
  type ConnectionCategory,
} from '../components/connections/agent-desktop-registry';

// =============================================================================
// TYPE DEFINITIONS
// =============================================================================

/** Raw shape returned by the API (MongoDB `_id` field). */
interface ConnectionSummaryRaw {
  _id: string;
  connectorName: string;
  displayName: string;
  scope: 'tenant' | 'user';
  userId?: string;
  authProfileId: string;
  metadata?: Record<string, unknown> | null;
  status: 'active' | 'expired' | 'revoked';
  createdAt: string;
  updatedAt: string;
}

/** Normalized shape used throughout the UI (with `id` mapped from `_id`). */
export interface ConnectionSummary {
  id: string;
  connectorName: string;
  displayName: string;
  scope: 'tenant' | 'user';
  userId?: string;
  authProfileId: string;
  metadata?: Record<string, unknown> | null;
  status: 'active' | 'expired' | 'revoked';
  createdAt: string;
  updatedAt: string;
  category?: ConnectionCategory;
}

/** Map a raw API connection to the normalized UI shape. */
export function normalizeConnection(raw: ConnectionSummaryRaw): ConnectionSummary {
  const { _id, ...rest } = raw;
  return {
    ...rest,
    id: _id,
    category: getConnectionCategory(raw.connectorName),
  };
}

export interface ConnectionDetail extends ConnectionSummary {
  metadata?: Record<string, unknown> | null;
}

// =============================================================================
// CONNECTIONS CRUD
// =============================================================================

export async function listConnections(
  projectId: string,
): Promise<{ success: boolean; data: ConnectionSummary[] }> {
  const response = await apiFetch(`/api/projects/${encodeURIComponent(projectId)}/connections`);
  const result = await handleResponse<{ success: boolean; data: ConnectionSummaryRaw[] }>(response);
  return {
    ...result,
    data: result.data.map(normalizeConnection),
  };
}

export async function getConnection(
  projectId: string,
  connectionId: string,
): Promise<{ success: boolean; data: ConnectionDetail }> {
  const response = await apiFetch(
    `/api/projects/${encodeURIComponent(projectId)}/connections/${encodeURIComponent(connectionId)}`,
  );
  const result = await handleResponse<{ success: boolean; data: ConnectionSummaryRaw }>(response);
  return {
    ...result,
    data: normalizeConnection(result.data),
  };
}

export async function createConnection(
  projectId: string,
  data: {
    connectorName: string;
    displayName: string;
    authProfileId: string;
    metadata?: Record<string, unknown>;
    scope?: 'tenant' | 'user';
  },
): Promise<{ success: boolean; data: ConnectionSummary }> {
  const response = await apiFetch(`/api/projects/${encodeURIComponent(projectId)}/connections`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
  const result = await handleResponse<{ success: boolean; data: ConnectionSummaryRaw }>(response);
  return {
    ...result,
    data: normalizeConnection(result.data),
  };
}

export async function updateConnection(
  projectId: string,
  connectionId: string,
  data: {
    displayName?: string;
    authProfileId?: string;
    metadata?: Record<string, unknown> | null;
    status?: 'active' | 'expired' | 'revoked';
  },
): Promise<{ success: boolean; data: ConnectionSummary }> {
  const response = await apiFetch(
    `/api/projects/${encodeURIComponent(projectId)}/connections/${encodeURIComponent(connectionId)}`,
    {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    },
  );
  const result = await handleResponse<{ success: boolean; data: ConnectionSummaryRaw }>(response);
  return {
    ...result,
    data: normalizeConnection(result.data),
  };
}

export async function deleteConnection(
  projectId: string,
  connectionId: string,
): Promise<{ success: boolean }> {
  const response = await apiFetch(
    `/api/projects/${encodeURIComponent(projectId)}/connections/${encodeURIComponent(connectionId)}`,
    {
      method: 'DELETE',
    },
  );
  return handleResponse(response);
}

// =============================================================================
// CONNECTION ACTIONS
// =============================================================================

export async function testConnection(
  projectId: string,
  connectionId: string,
): Promise<{ success: boolean; data?: { message?: string } }> {
  const response = await apiFetch(
    `/api/projects/${encodeURIComponent(projectId)}/connections/${encodeURIComponent(connectionId)}/test`,
    {
      method: 'POST',
    },
  );
  return handleResponse(response);
}
