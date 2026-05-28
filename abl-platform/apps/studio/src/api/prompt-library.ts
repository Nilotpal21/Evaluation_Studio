/**
 * Prompt Library API Client
 *
 * All calls proxy through Studio's Next.js route handlers, which forward
 * Authorization + X-Tenant-Id to the runtime service.
 *
 * Runtime response envelope: { success: true, data: <payload> }
 * Each function unwraps the `data` field and returns the caller-facing shape.
 */

import { apiFetch, handleResponse } from '../lib/api-client';

// =============================================================================
// TYPES
// =============================================================================

export type PromptLibraryItemStatus = 'active' | 'archived';
export type PromptLibraryVersionStatus = 'draft' | 'active' | 'archived';

export interface PromptLibraryItem {
  _id: string;
  name: string;
  description?: string;
  tags: string[];
  usageCount: number;
  status: PromptLibraryItemStatus;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface PromptLibraryVersion {
  _id: string;
  promptId: string;
  versionNumber: number;
  template: string;
  variables: string[];
  description?: string;
  status: PromptLibraryVersionStatus;
  sourceHash: string;
  createdBy: string;
  createdAt: string;
  publishedAt?: string;
  publishedBy?: string;
}

export interface PromptReference {
  agentName: string;
  versionId: string;
  resolvedHash: string;
}

export interface PromptDraftAgentReference {
  agentName: string;
  versionId: string;
  resolvedHash?: string;
}

export interface PromptReferencesResponse {
  count: number;
  agents: PromptReference[];
  draftAgents: PromptDraftAgentReference[];
}

export interface TestPane {
  promptVersionId: string;
  tenantModelId: string;
}

export interface TestPaneResult {
  promptVersionId: string;
  tenantModelId: string;
  output?: string;
  latencyMs?: number;
  inputTokens?: number;
  outputTokens?: number;
  usage?: { input: number; output: number; total: number };
  model?: string;
  provider?: string;
  error?: { code: string; message: string };
  /** True while the pane is actively receiving streamed tokens */
  streaming?: boolean;
}

// =============================================================================
// STREAMING EVENT TYPES (mirrored from runtime — do NOT import across app boundaries)
// =============================================================================

export type TestStreamEvent =
  | { type: 'pane_start'; paneIndex: number; tenantModelId: string }
  | { type: 'pane_delta'; paneIndex: number; text: string }
  | {
      type: 'pane_done';
      paneIndex: number;
      tenantModelId: string;
      latencyMs: number;
      usage: { input: number; output: number; total: number };
      model: string;
      provider: string;
    }
  | {
      type: 'pane_error';
      paneIndex: number;
      tenantModelId: string;
      error: { code: string; message: string };
    }
  | { type: 'done' };

export interface PromptListParams {
  limit?: number;
  offset?: number;
  status?: PromptLibraryItemStatus;
  search?: string;
  tags?: string[];
}

// =============================================================================
// INTERNAL HELPERS
// =============================================================================

/** Unwrap the standard `{ success, data }` runtime envelope. */
async function unwrap<T>(response: Response): Promise<T> {
  const result = await handleResponse<{ success: boolean; data: T }>(response);
  return result.data;
}

// =============================================================================
// PROMPTS CRUD
// =============================================================================

export async function fetchPrompts(
  projectId: string,
  params?: PromptListParams,
): Promise<{ items: PromptLibraryItem[]; total: number }> {
  const query = new URLSearchParams();
  if (params?.limit) query.set('limit', String(params.limit));
  if (params?.offset) query.set('offset', String(params.offset));
  if (params?.status) query.set('status', params.status);
  if (params?.search) query.set('search', params.search);
  if (params?.tags?.length) query.set('tags', params.tags.join(','));

  const qs = query.toString();
  const response = await apiFetch(
    `/api/projects/${projectId}/prompt-library/prompts${qs ? `?${qs}` : ''}`,
  );
  return unwrap<{ items: PromptLibraryItem[]; total: number }>(response);
}

export async function fetchPrompt(
  projectId: string,
  promptId: string,
): Promise<{ item: PromptLibraryItem }> {
  const response = await apiFetch(`/api/projects/${projectId}/prompt-library/prompts/${promptId}`);
  const item = await unwrap<PromptLibraryItem>(response);
  return { item };
}

export async function createPrompt(
  projectId: string,
  data: {
    name: string;
    description?: string;
    tags?: string[];
    initialVersion: { template: string; variables: string[]; description?: string };
  },
): Promise<{ item: PromptLibraryItem }> {
  const response = await apiFetch(`/api/projects/${projectId}/prompt-library/prompts`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
  const item = await unwrap<PromptLibraryItem>(response);
  return { item };
}

export async function updatePrompt(
  projectId: string,
  promptId: string,
  data: { name?: string; description?: string; tags?: string[] },
): Promise<{ item: PromptLibraryItem }> {
  const response = await apiFetch(`/api/projects/${projectId}/prompt-library/prompts/${promptId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
  const item = await unwrap<PromptLibraryItem>(response);
  return { item };
}

export async function deletePrompt(
  projectId: string,
  promptId: string,
): Promise<{ success: boolean }> {
  const response = await apiFetch(`/api/projects/${projectId}/prompt-library/prompts/${promptId}`, {
    method: 'DELETE',
  });
  await unwrap<{ deleted: boolean }>(response);
  return { success: true };
}

// =============================================================================
// VERSIONS CRUD
// =============================================================================

export async function fetchVersions(
  projectId: string,
  promptId: string,
  params?: { limit?: number; offset?: number },
): Promise<{ items: PromptLibraryVersion[]; total: number }> {
  const query = new URLSearchParams();
  if (params?.limit) query.set('limit', String(params.limit));
  if (params?.offset) query.set('offset', String(params.offset));

  const qs = query.toString();
  const response = await apiFetch(
    `/api/projects/${projectId}/prompt-library/prompts/${promptId}/versions${qs ? `?${qs}` : ''}`,
  );
  const data = await unwrap<{ versions: PromptLibraryVersion[] }>(response);
  return { items: data.versions, total: data.versions.length };
}

export async function fetchVersion(
  projectId: string,
  promptId: string,
  versionId: string,
): Promise<{ item: PromptLibraryVersion }> {
  const response = await apiFetch(
    `/api/projects/${projectId}/prompt-library/prompts/${promptId}/versions/${versionId}`,
  );
  const item = await unwrap<PromptLibraryVersion>(response);
  return { item };
}

export async function createVersion(
  projectId: string,
  promptId: string,
  data: { template: string; variables: string[]; description?: string },
): Promise<{ item: PromptLibraryVersion }> {
  const response = await apiFetch(
    `/api/projects/${projectId}/prompt-library/prompts/${promptId}/versions`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    },
  );
  const item = await unwrap<PromptLibraryVersion>(response);
  return { item };
}

export async function updateVersion(
  projectId: string,
  promptId: string,
  versionId: string,
  data: { template?: string; variables?: string[]; description?: string },
): Promise<{ item: PromptLibraryVersion }> {
  const response = await apiFetch(
    `/api/projects/${projectId}/prompt-library/prompts/${promptId}/versions/${versionId}`,
    {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    },
  );
  const item = await unwrap<PromptLibraryVersion>(response);
  return { item };
}

export async function promoteVersion(
  projectId: string,
  promptId: string,
  versionId: string,
): Promise<{ version: PromptLibraryVersion; previousActiveVersionId?: string }> {
  const response = await apiFetch(
    `/api/projects/${projectId}/prompt-library/prompts/${promptId}/versions/${versionId}/promote`,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' },
  );
  return unwrap<{ version: PromptLibraryVersion; previousActiveVersionId?: string }>(response);
}

export async function archiveVersion(
  projectId: string,
  promptId: string,
  versionId: string,
): Promise<{ item: PromptLibraryVersion }> {
  const response = await apiFetch(
    `/api/projects/${projectId}/prompt-library/prompts/${promptId}/versions/${versionId}/archive`,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' },
  );
  const item = await unwrap<PromptLibraryVersion>(response);
  return { item };
}

// =============================================================================
// REFERENCES
// =============================================================================

export async function fetchReferences(
  projectId: string,
  promptId: string,
): Promise<PromptReferencesResponse> {
  const response = await apiFetch(
    `/api/projects/${projectId}/prompt-library/prompts/${promptId}/references`,
  );
  const refs = await unwrap<Partial<PromptReferencesResponse>>(response);
  return {
    count: refs.count ?? (refs.agents?.length ?? 0) + (refs.draftAgents?.length ?? 0),
    agents: refs.agents ?? [],
    draftAgents: refs.draftAgents ?? [],
  };
}

// =============================================================================
// TEST
// =============================================================================

export async function testPrompt(
  projectId: string,
  data: {
    variables?: Record<string, string>;
    userMessage?: string;
    panes: TestPane[];
  },
): Promise<{ panes: TestPaneResult[]; failedPanes: TestPaneResult[] }> {
  const response = await apiFetch(`/api/projects/${projectId}/prompt-library/test`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
  return unwrap<{ panes: TestPaneResult[]; failedPanes: TestPaneResult[] }>(response);
}

// =============================================================================
// STREAMING TEST
// =============================================================================

/**
 * Stream a multi-pane prompt test via SSE, yielding events as tokens arrive.
 */
export async function* streamTestPrompt(
  projectId: string,
  data: { variables?: Record<string, string>; userMessage?: string; panes: TestPane[] },
  signal?: AbortSignal,
): AsyncGenerator<TestStreamEvent> {
  const response = await apiFetch(`/api/projects/${projectId}/prompt-library/test/stream`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
    signal,
  });

  if (!response.ok) {
    const err = (await response.json().catch(() => ({}))) as {
      error?: { code?: string; message?: string };
    };
    throw new Error(err?.error?.message ?? `Stream request failed: ${response.status}`);
  }
  if (!response.body) throw new Error('No response body');

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        if (line.startsWith('data: ')) {
          const json = line.slice(6).trim();
          if (json) yield JSON.parse(json) as TestStreamEvent;
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}
