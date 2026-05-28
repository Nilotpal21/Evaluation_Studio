/**
 * Prompt Library E2E Test Helpers
 *
 * Thin wrappers around the prompt-library API routes for use in E2E tests.
 * All calls go through the HTTP API — no direct DB access.
 */

import { expect } from 'vitest';
import { authHeaders, requestJson } from './channel-e2e-bootstrap.js';
import type { RuntimeApiHarness } from './runtime-api-harness.js';

// =============================================================================
// RESPONSE TYPES
// =============================================================================

export interface PromptItem {
  _id: string;
  tenantId: string;
  projectId: string;
  name: string;
  description?: string;
  status: 'active' | 'archived';
  tags: string[];
  createdAt: string;
  updatedAt: string;
}

export interface PromptVersion {
  _id: string;
  promptId: string;
  versionNumber: number;
  template: string;
  variables: string[];
  status: 'draft' | 'active' | 'archived';
  sourceHash: string;
  description?: string;
  publishedAt?: string;
  createdAt: string;
}

// =============================================================================
// API HELPERS
// =============================================================================

export async function createPrompt(
  harness: RuntimeApiHarness,
  token: string,
  projectId: string,
  body: {
    name: string;
    description?: string;
    tags?: string[];
    initialVersion?: {
      template: string;
      variables?: string[];
      description?: string;
    };
  },
): Promise<{ item: PromptItem; version?: PromptVersion }> {
  const res = await requestJson<{ success: boolean; item: PromptItem; version?: PromptVersion }>(
    harness,
    `/api/projects/${projectId}/prompt-library/prompts`,
    {
      method: 'POST',
      headers: authHeaders(token),
      body,
    },
  );
  expect(res.status, `createPrompt: ${JSON.stringify(res.body)}`).toBe(201);
  expect(res.body.success).toBe(true);
  return { item: res.body.item, version: res.body.version };
}

export async function createVersion(
  harness: RuntimeApiHarness,
  token: string,
  projectId: string,
  promptId: string,
  body: {
    template: string;
    variables?: string[];
    description?: string;
  },
): Promise<PromptVersion> {
  const res = await requestJson<{ success: boolean; item: PromptVersion }>(
    harness,
    `/api/projects/${projectId}/prompt-library/prompts/${promptId}/versions`,
    {
      method: 'POST',
      headers: authHeaders(token),
      body,
    },
  );
  expect(res.status, `createVersion: ${JSON.stringify(res.body)}`).toBe(201);
  expect(res.body.success).toBe(true);
  return res.body.item;
}

export async function promoteVersion(
  harness: RuntimeApiHarness,
  token: string,
  projectId: string,
  promptId: string,
  versionId: string,
): Promise<PromptVersion> {
  const res = await requestJson<{ success: boolean; item: PromptVersion }>(
    harness,
    `/api/projects/${projectId}/prompt-library/prompts/${promptId}/versions/${versionId}/promote`,
    {
      method: 'POST',
      headers: authHeaders(token),
    },
  );
  expect(res.status, `promoteVersion: ${JSON.stringify(res.body)}`).toBe(200);
  expect(res.body.success).toBe(true);
  return res.body.item;
}

export async function archiveVersion(
  harness: RuntimeApiHarness,
  token: string,
  projectId: string,
  promptId: string,
  versionId: string,
): Promise<PromptVersion> {
  const res = await requestJson<{ success: boolean; item: PromptVersion }>(
    harness,
    `/api/projects/${projectId}/prompt-library/prompts/${promptId}/versions/${versionId}/archive`,
    {
      method: 'POST',
      headers: authHeaders(token),
    },
  );
  expect(res.status, `archiveVersion: ${JSON.stringify(res.body)}`).toBe(200);
  expect(res.body.success).toBe(true);
  return res.body.item;
}

export async function listVersions(
  harness: RuntimeApiHarness,
  token: string,
  projectId: string,
  promptId: string,
): Promise<PromptVersion[]> {
  const res = await requestJson<{ success: boolean; items: PromptVersion[] }>(
    harness,
    `/api/projects/${projectId}/prompt-library/prompts/${promptId}/versions`,
    { headers: authHeaders(token) },
  );
  expect(res.status).toBe(200);
  expect(res.body.success).toBe(true);
  return res.body.items;
}

export async function runTestPanes(
  harness: RuntimeApiHarness,
  token: string,
  projectId: string,
  body: {
    panes: Array<{ promptVersionId: string; tenantModelId: string }>;
    variables?: Record<string, string>;
    userMessage?: string;
  },
): Promise<{
  status: number;
  body: {
    success?: boolean;
    results?: Array<{
      promptVersionId: string;
      tenantModelId: string;
      output: string;
      latencyMs: number;
    }>;
    failedPanes?: Array<{ error: { code: string; message: string } }>;
    error?: { code: string; message: string };
  };
}> {
  return requestJson(harness, `/api/projects/${projectId}/prompt-library/test`, {
    method: 'POST',
    headers: authHeaders(token),
    body,
  });
}
