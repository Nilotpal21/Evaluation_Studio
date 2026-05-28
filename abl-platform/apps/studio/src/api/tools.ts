/**
 * Tools API Client
 *
 * Functions for unified tool system API calls.
 * Proxied to runtime via next.config.mjs rewrites.
 */

import { apiFetch, handleResponse } from '../lib/api-client';
import type {
  ToolType,
  ToolListResponse,
  ToolDetailResponse,
  ToolTestResult,
} from '../store/tool-store';

export interface ToolExportResponse {
  success: boolean;
  export: {
    exportVersion: number;
    tool: Record<string, unknown>;
  };
}

export interface ToolImportPayload {
  tool?: Record<string, unknown>;
  export?: {
    tool: Record<string, unknown>;
    version?: Record<string, unknown>;
  };
}

type RuntimeNumericValue = number | `{{config.${string}}}`;

interface RuntimeCircuitBreakerInput {
  threshold: RuntimeNumericValue;
  resetMs: RuntimeNumericValue;
}

// =============================================================================
// TOOLS CRUD
// =============================================================================

export async function fetchTools(
  projectId: string,
  params?: { page?: number; limit?: number; toolType?: ToolType; search?: string },
): Promise<ToolListResponse> {
  const query = new URLSearchParams();
  if (params?.page) query.set('page', String(params.page));
  if (params?.limit) query.set('limit', String(params.limit));
  if (params?.toolType) query.set('toolType', params.toolType);
  if (params?.search) query.set('search', params.search);

  const qs = query.toString();
  const response = await apiFetch(`/api/projects/${projectId}/tools${qs ? `?${qs}` : ''}`);
  return handleResponse<ToolListResponse>(response);
}

export async function fetchTool(projectId: string, toolId: string): Promise<ToolDetailResponse> {
  const response = await apiFetch(`/api/projects/${projectId}/tools/${toolId}`);
  return handleResponse<ToolDetailResponse>(response);
}

export async function createTool(
  projectId: string,
  data: {
    name: string;
    toolType: 'http' | 'sandbox' | 'mcp' | 'searchai' | 'workflow';
    description?: string;
    // Workflow
    workflowId?: string;
    workflowVersionId?: string;
    workflowVersion?: string;
    triggerId?: string;
    mode?: 'sync' | 'async';
    timeoutMs?: RuntimeNumericValue;
    paramMapping?: Record<string, string>;
    // HTTP
    endpoint?: string;
    method?: string;
    auth?: string;
    authConfig?: object;
    authProfileRef?: string;
    authJit?: boolean;
    consentMode?: 'preflight' | 'inline';
    connectionMode?: 'per_user' | 'shared';
    headers?: Array<{ key: string; value: string }>;
    queryParams?: Array<{ key: string; value: string }>;
    body?: string;
    bodyType?: string;
    bodySchema?: string;
    useBodySchema?: boolean;
    timeout?: RuntimeNumericValue;
    retry?: RuntimeNumericValue;
    retryDelay?: RuntimeNumericValue;
    rateLimit?: RuntimeNumericValue;
    circuitBreaker?: RuntimeCircuitBreakerInput;
    // Sandbox
    runtime?: string;
    code?: string;
    memoryMb?: RuntimeNumericValue;
    // MCP
    server?: string;
    serverTool?: string;
    transportType?: string;
    // Common
    parameters?: Array<{
      name: string;
      type: string;
      description?: string;
      required?: boolean;
      enumValues?: string[];
      defaultValue?: string;
      objectSchema?: string;
    }>;
    returnType?: string;
  },
): Promise<ToolDetailResponse> {
  const response = await apiFetch(`/api/projects/${projectId}/tools`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
  return handleResponse<ToolDetailResponse>(response);
}

export async function updateTool(
  projectId: string,
  toolId: string,
  data: Record<string, unknown>,
): Promise<ToolDetailResponse> {
  const response = await apiFetch(`/api/projects/${projectId}/tools/${toolId}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
  return handleResponse<ToolDetailResponse>(response);
}

export async function deleteTool(
  projectId: string,
  toolId: string,
  options?: { force?: boolean },
): Promise<void> {
  const query = new URLSearchParams();
  if (options?.force) query.set('force', 'true');
  const qs = query.toString();

  const response = await apiFetch(
    `/api/projects/${projectId}/tools/${toolId}${qs ? `?${qs}` : ''}`,
    {
      method: 'DELETE',
    },
  );
  await handleResponse<{ success: boolean }>(response);
}

export async function duplicateTool(
  projectId: string,
  toolId: string,
): Promise<ToolDetailResponse> {
  const response = await apiFetch(`/api/projects/${projectId}/tools/${toolId}/duplicate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  });
  return handleResponse<ToolDetailResponse>(response);
}

// =============================================================================
// TEST
// =============================================================================

export async function testTool(
  projectId: string,
  toolId: string,
  input: Record<string, unknown>,
): Promise<{ success: boolean; result: ToolTestResult }> {
  const response = await apiFetch(`/api/projects/${projectId}/tools/${toolId}/test`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ input }),
  });
  return handleResponse(response);
}

type JsonPrimitive = string | number | boolean | null;
export type ToolTestJsonValue = JsonPrimitive | Record<string, unknown> | ToolTestJsonValue[];

export interface ToolTestEndpointFixture {
  endpointId: string;
  projectToolId: string;
  toolName: string;
  status: string;
  staticResponse: ToolTestJsonValue;
  sampleInput: Record<string, unknown> | null;
  urls: {
    invokeUrl: string;
    specUrl: string;
  };
  version: number;
  updatedAt: string;
}

export async function getToolTestEndpointFixture(
  projectId: string,
  toolId: string,
): Promise<ToolTestEndpointFixture | null> {
  const response = await apiFetch(`/api/tool-test/${projectId}/${toolId}`);
  if (response.status === 404) {
    return null;
  }
  const payload = await handleResponse<{ success: boolean; endpoint: ToolTestEndpointFixture }>(
    response,
  );
  return payload.endpoint;
}

export async function updateToolTestEndpointFixture(
  projectId: string,
  toolId: string,
  input: {
    staticResponse?: ToolTestJsonValue;
    sampleInput?: Record<string, unknown> | null;
  },
): Promise<ToolTestEndpointFixture> {
  const response = await apiFetch(`/api/tool-test/${projectId}/${toolId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  const payload = await handleResponse<{ success: boolean; endpoint: ToolTestEndpointFixture }>(
    response,
  );
  return payload.endpoint;
}

// =============================================================================
// EXPORT / IMPORT
// =============================================================================

export async function exportTool(projectId: string, toolId: string): Promise<ToolExportResponse> {
  const response = await apiFetch(`/api/projects/${projectId}/tools/${toolId}/export`);
  return handleResponse<ToolExportResponse>(response);
}

export async function importTool(
  projectId: string,
  payload: ToolImportPayload,
): Promise<ToolDetailResponse> {
  const response = await apiFetch(`/api/projects/${projectId}/tools/import`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return handleResponse(response);
}
