/**
 * MCP Servers API Client
 *
 * Functions for MCP server management and tool discovery.
 * Proxied to runtime via next.config.mjs rewrites.
 */

import { apiFetch, handleResponse } from '../lib/api-client';

// =============================================================================
// TYPES
// =============================================================================

export type McpTransportType = 'sse' | 'http';
export type McpAuthType =
  | 'none'
  | 'bearer'
  | 'api_key'
  | 'custom_headers'
  | 'oauth2_client_credentials';

export interface McpServer {
  id: string;
  name: string;
  description: string | null;
  transport: McpTransportType;
  url: string | null;
  priority: number;
  tags: string[];
  connectionTimeoutMs: number;
  requestTimeoutMs: number;
  autoReconnect: boolean;
  maxReconnectAttempts: number;
  authType: McpAuthType;
  authProfileId?: string | null;
  envProfileId?: string | null;
  headers?: Record<string, string>;
  discoveredToolCount: number;
  lastConnectionStatus: 'connected' | 'failed' | 'untested' | null;
  lastConnectionAt: string | null;
  lastConnectionLatencyMs: number | null;
  lastConnectionToolCount: number | null;
  lastConnectionError: string | null;
  createdBy: string | null;
  modifiedBy: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface McpServerListResponse {
  success: boolean;
  servers: McpServer[];
}

export interface McpServerDetailResponse {
  success: boolean;
  server: McpServer;
}

export interface CreateMcpServerPayload {
  name: string;
  description?: string;
  transport: McpTransportType;
  url?: string;
  env?: Record<string, string>;
  authType?: McpAuthType;
  authConfig?: Record<string, unknown>;
  headers?: Record<string, string>;
  authProfileId?: string | null;
  envProfileId?: string | null;
  priority?: number;
  tags?: string[];
  connectionTimeoutMs?: number;
  requestTimeoutMs?: number;
  autoReconnect?: boolean;
  maxReconnectAttempts?: number;
}

export interface TestConnectionResult {
  connected: boolean;
  toolCount?: number;
  tools?: Array<{ name: string; description?: string }>;
  latencyMs: number;
  error?: string;
}

export interface DiscoveredToolPreview {
  name: string;
  description: string | null;
  inputSchema: object | null;
  suggestedSlug: string;
}

export interface DiscoverPreviewResponse {
  success: boolean;
  tools: DiscoveredToolPreview[];
  totalDiscovered: number;
}

export interface DiscoverImportResponse {
  success: boolean;
  successful: number;
  failed: Array<{ toolName: string; error: string }>;
  schemaDrift: Array<{ toolName: string; field: string }>;
  conflicting: Array<{ toolName: string; reason: string }>;
  totalDiscovered: number;
}

export interface ServerTool {
  id: string;
  toolName: string;
  description: string | null;
  inputSchema: object;
  serverName: string;
  discoveredAt: string;
  lastVerifiedAt: string;
  isAvailable: boolean;
}

export interface ServerToolsResponse {
  success: boolean;
  tools: ServerTool[];
}

// =============================================================================
// CRUD
// =============================================================================

export async function fetchMcpServers(projectId: string): Promise<McpServerListResponse> {
  const response = await apiFetch(`/api/projects/${projectId}/mcp-servers`);
  return handleResponse<McpServerListResponse>(response);
}

export async function fetchMcpServer(
  projectId: string,
  serverId: string,
): Promise<McpServerDetailResponse> {
  const response = await apiFetch(`/api/projects/${projectId}/mcp-servers/${serverId}`);
  return handleResponse<McpServerDetailResponse>(response);
}

export async function createMcpServer(
  projectId: string,
  data: CreateMcpServerPayload,
): Promise<McpServerDetailResponse> {
  const response = await apiFetch(`/api/projects/${projectId}/mcp-servers`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
  return handleResponse<McpServerDetailResponse>(response);
}

export async function updateMcpServer(
  projectId: string,
  serverId: string,
  data: Partial<CreateMcpServerPayload>,
): Promise<McpServerDetailResponse> {
  const response = await apiFetch(`/api/projects/${projectId}/mcp-servers/${serverId}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
  return handleResponse<McpServerDetailResponse>(response);
}

export async function deleteMcpServer(projectId: string, serverId: string): Promise<void> {
  const response = await apiFetch(`/api/projects/${projectId}/mcp-servers/${serverId}`, {
    method: 'DELETE',
  });
  await handleResponse<{ success: boolean }>(response);
}

// =============================================================================
// OPERATIONS
// =============================================================================

export async function testMcpServerConnection(
  projectId: string,
  serverId: string,
): Promise<{ success: boolean; result: TestConnectionResult }> {
  const response = await apiFetch(
    `/api/projects/${projectId}/mcp-servers/${serverId}/test-connection`,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' },
  );
  return handleResponse(response);
}

export async function discoverToolsPreview(
  projectId: string,
  serverId: string,
): Promise<DiscoverPreviewResponse> {
  const response = await apiFetch(
    `/api/projects/${projectId}/mcp-servers/${serverId}/tools/discover/preview`,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' },
  );
  return handleResponse<DiscoverPreviewResponse>(response);
}

export async function discoverAndImportTools(
  projectId: string,
  serverId: string,
  toolNames?: string[],
): Promise<DiscoverImportResponse> {
  const response = await apiFetch(
    `/api/projects/${projectId}/mcp-servers/${serverId}/tools/discover`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(toolNames ? { toolNames } : {}),
    },
  );
  return handleResponse<DiscoverImportResponse>(response);
}

export async function fetchServerTools(
  projectId: string,
  serverId: string,
): Promise<ServerToolsResponse> {
  const response = await apiFetch(`/api/projects/${projectId}/mcp-servers/${serverId}/tools`);
  return handleResponse<ServerToolsResponse>(response);
}

export interface McpToolTestResult {
  success: boolean;
  output: unknown;
  latencyMs: number;
  logs?: string[];
  error?: string;
}

export async function testMcpTool(
  projectId: string,
  serverId: string,
  toolName: string,
  input: Record<string, unknown>,
): Promise<McpToolTestResult> {
  const response = await apiFetch(
    `/api/projects/${projectId}/mcp-servers/${serverId}/tools/${encodeURIComponent(toolName)}/test`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ input }),
    },
  );
  return handleResponse<McpToolTestResult>(response);
}
