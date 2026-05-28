/**
 * Versions API Client
 *
 * Functions for agent version management against the runtime API.
 * These go directly to runtime since studio doesn't proxy version routes yet.
 */

import { apiFetch, handleResponse } from '../lib/api-client';
import { getRuntimeUrl } from '../config/runtime';

// =============================================================================
// TYPES
// =============================================================================

export interface ToolSnapshotEntry {
  name: string;
  projectToolId: string;
  sourceHash: string;
  runtimeMetadataHash?: string;
  toolType: 'http' | 'sandbox' | 'mcp' | 'searchai' | 'workflow';
  description: string | null;
  dslContent: string;
}

export interface VersionRecord {
  id: string;
  projectId: string;
  agentName: string;
  version: string;
  status: 'draft' | 'testing' | 'staged' | 'active' | 'deprecated';
  dslContent: string;
  sourceHash: string;
  ir: unknown | null;
  compileErrors: string[] | null;
  toolSnapshot: ToolSnapshotEntry[] | null;
  createdAt: string;
  createdBy: string | null;
  changelog: string | null;
}

export interface VersionListResponse {
  success: boolean;
  versions: VersionRecord[];
  total: number;
  limit: number;
  offset: number;
  hasMore: boolean;
}

export interface VersionCreateResponse {
  success: boolean;
  versionId: string;
  version: string;
  sourceHash: string;
  deduplicated?: boolean;
  toolSnapshotRefresh?: {
    attempted: boolean;
    matchedCount: number;
    modifiedCount: number;
    refreshed: boolean;
  };
  errors?: string[];
  toolSnapshot?: ToolSnapshotEntry[] | null;
  warnings?: string[];
}

export interface VersionDiffResponse {
  success: boolean;
  diff: { dslContent: string; sourceHash: string }[];
}

// =============================================================================
// API
// =============================================================================

function versionUrl(projectId: string, agentName: string, path = '') {
  return `${getRuntimeUrl()}/api/projects/${projectId}/agents/${agentName}/versions${path}`;
}

export async function fetchVersions(
  projectId: string,
  agentName: string,
  opts: { limit?: number; offset?: number } = {},
): Promise<VersionListResponse> {
  const params = new URLSearchParams();
  if (opts.limit) params.set('limit', String(opts.limit));
  if (opts.offset) params.set('offset', String(opts.offset));
  const qs = params.toString() ? `?${params}` : '';

  const response = await apiFetch(versionUrl(projectId, agentName, qs), {
    headers: { 'Content-Type': 'application/json' },
  });
  return handleResponse<VersionListResponse>(response);
}

export async function fetchVersion(
  projectId: string,
  agentName: string,
  version: string,
): Promise<{ success: boolean; version: VersionRecord }> {
  const response = await apiFetch(versionUrl(projectId, agentName, `/${version}`), {
    headers: { 'Content-Type': 'application/json' },
  });
  return handleResponse(response);
}

export async function createVersion(
  projectId: string,
  agentName: string,
  changelog?: string,
): Promise<VersionCreateResponse> {
  const response = await apiFetch(versionUrl(projectId, agentName, ''), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ changelog }),
  });
  return handleResponse<VersionCreateResponse>(response);
}

export async function promoteVersion(
  projectId: string,
  agentName: string,
  version: string,
  targetStatus: string,
): Promise<{ success: boolean; version: VersionRecord; previousStatus?: string }> {
  const response = await apiFetch(versionUrl(projectId, agentName, `/${version}/promote`), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ targetStatus }),
  });
  return handleResponse(response);
}

export interface ToolPreviewEntry {
  toolId: string;
  toolName: string;
  toolType: string;
  draftOnly: boolean;
  publishedVersion?: {
    versionId: string;
    version: number;
    versionName: string | null;
  };
}

export interface ToolPreviewResponse {
  success: boolean;
  tools: ToolPreviewEntry[];
}

export async function fetchToolPreview(
  projectId: string,
  agentName: string,
): Promise<ToolPreviewResponse> {
  const response = await apiFetch(versionUrl(projectId, agentName, '/tool-preview'), {
    headers: { 'Content-Type': 'application/json' },
  });
  return handleResponse<ToolPreviewResponse>(response);
}

export async function fetchVersionDiff(
  projectId: string,
  agentName: string,
  version: string,
  otherVersion: string,
): Promise<VersionDiffResponse> {
  const response = await apiFetch(
    versionUrl(projectId, agentName, `/${version}/diff/${otherVersion}`),
    { headers: { 'Content-Type': 'application/json' } },
  );
  return handleResponse<VersionDiffResponse>(response);
}
