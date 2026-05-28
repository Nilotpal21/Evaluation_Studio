/**
 * Tool API E2E Tests
 *
 * Exercises the current flat project-tool lifecycle through Studio's public API.
 *
 * Requires: Studio dev server running on localhost:5173
 */

import { test, expect, type APIRequestContext } from '@playwright/test';
import { apiDelete, apiGet, apiPost, apiPut } from './helpers/api';
import { env } from './helpers/env';

const TEST_LOGIN_EMAIL = 'tool-api@e2e-smoke.test';
const TEST_LOGIN_NAME = 'Tool API E2E';

interface ProjectRecord {
  id: string;
  name: string;
  slug: string;
}

interface ToolRecord {
  id: string;
  name: string;
  toolType: 'http' | 'sandbox' | 'mcp' | 'searchai' | 'workflow';
  description: string | null;
  dslContent: string;
  sourceHash: string;
  variableNamespaceIds?: string[];
  projectId?: string;
  createdBy?: string;
  lastEditedBy?: string | null;
  createdAt?: string;
  updatedAt?: string;
  [key: string]: unknown;
}

interface ToolDetailResponse {
  success: boolean;
  tool: ToolRecord;
}

interface ToolListResponse {
  success: boolean;
  data: ToolRecord[];
  pagination: {
    page: number;
    limit: number;
    total: number;
    hasMore: boolean;
  };
}

interface ToolExportRouteResponse {
  success: boolean;
  export: {
    exportVersion: number;
    tool: ToolRecord & {
      id?: string;
      projectId?: string;
    };
  };
}

interface DeleteResponse {
  success: boolean;
  deleted: string;
}

function uniqueSuffix() {
  return `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function getTenantIdFromToken(token: string) {
  const [, payload = ''] = token.split('.');
  const decoded = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as {
    tenantId?: string;
  };
  return decoded.tenantId ?? env.tenantId;
}

async function getDevAccessToken(request: APIRequestContext) {
  const response = await request.post(`${env.baseUrl}/api/auth/dev-login`, {
    data: { email: TEST_LOGIN_EMAIL, name: TEST_LOGIN_NAME },
  });

  expect(response.ok()).toBeTruthy();

  const body = (await response.json()) as {
    accessToken?: string;
  };

  expect(body.accessToken).toBeTruthy();
  return body.accessToken ?? '';
}

async function createProject(request: APIRequestContext, token: string, tenantId: string) {
  const suffix = uniqueSuffix();
  const slugSuffix = suffix.replace(/_/g, '-');
  const response = await apiPost<{ success: boolean; project: ProjectRecord }>(
    request,
    '/api/projects',
    token,
    {
      name: `Tool API Parity ${suffix}`,
      slug: `tool-api-parity-${slugSuffix}`,
      description: 'Playwright parity coverage for Studio tool API routes',
    },
    {
      headers: { 'X-Tenant-Id': tenantId },
    },
  );

  expect(response.status).toBe(201);
  expect(response.body.success).toBe(true);

  return response.body.project;
}

async function createHttpTool(
  request: APIRequestContext,
  token: string,
  tenantId: string,
  projectId: string,
  name: string,
) {
  const response = await apiPost<ToolDetailResponse>(
    request,
    `/api/projects/${projectId}/tools`,
    token,
    {
      name,
      description: 'Fetch weather data from an HTTP endpoint',
      toolType: 'http',
      endpoint: 'https://example.com/weather',
      method: 'GET',
    },
    {
      headers: { 'X-Tenant-Id': tenantId },
    },
  );

  expect(response.status).toBe(201);
  expect(response.body.success).toBe(true);

  return response.body.tool;
}

test.describe.configure({ mode: 'serial' });

test.describe('Tool API Lifecycle', () => {
  let token = '';
  let tenantId = '';
  let projectId = '';
  let originalTool: ToolRecord | null = null;
  let importedToolId = '';
  let duplicatedToolId = '';

  test.beforeAll(async ({ request }) => {
    token = await getDevAccessToken(request);
    tenantId = getTenantIdFromToken(token);

    const project = await createProject(request, token, tenantId);
    projectId = project.id;
  });

  test.afterAll(async ({ request }) => {
    if (projectId && token) {
      await apiDelete(request, `/api/projects/${projectId}`, token, {
        headers: { 'X-Tenant-Id': tenantId },
      });
    }
  });

  test('POST /tools creates a flat project tool document', async ({ request }) => {
    const toolName = `tool_api_${uniqueSuffix()}`;
    originalTool = await createHttpTool(request, token, tenantId, projectId, toolName);

    expect(originalTool.id).toBeTruthy();
    expect(originalTool.name).toBe(toolName);
    expect(originalTool.toolType).toBe('http');
    expect(originalTool.description).toBe('Fetch weather data from an HTTP endpoint');
    expect(originalTool.dslContent).toContain('endpoint: "https://example.com/weather"');
    expect(originalTool.sourceHash).toBeTruthy();
    expect(originalTool.tenantId).toBeUndefined();
  });

  test('GET /tools/:id returns the same flat tool shape', async ({ request }) => {
    expect(originalTool?.id).toBeTruthy();

    const response = await apiGet<ToolDetailResponse>(
      request,
      `/api/projects/${projectId}/tools/${originalTool?.id}`,
      token,
      {
        headers: { 'X-Tenant-Id': tenantId },
      },
    );

    expect(response.status).toBe(200);
    expect(response.body.success).toBe(true);
    expect(response.body.tool.id).toBe(originalTool?.id);
    expect(response.body.tool.name).toBe(originalTool?.name);
    expect(response.body.tool.dslContent).toBe(originalTool?.dslContent);
  });

  test('PUT /tools/:id updates the flat tool document', async ({ request }) => {
    expect(originalTool?.id).toBeTruthy();

    const updatedDescription = 'Updated by Playwright tool lifecycle coverage';
    const response = await apiPut<ToolDetailResponse>(
      request,
      `/api/projects/${projectId}/tools/${originalTool?.id}`,
      token,
      {
        description: updatedDescription,
      },
      {
        headers: { 'X-Tenant-Id': tenantId },
      },
    );

    expect(response.status).toBe(200);
    expect(response.body.success).toBe(true);
    expect(response.body.tool.id).toBe(originalTool?.id);
    expect(response.body.tool.description).toBe(updatedDescription);
    expect(response.body.tool.toolType).toBe('http');
    expect(response.body.tool.dslContent).toContain('endpoint: "https://example.com/weather"');

    originalTool = response.body.tool;
  });

  test('GET /tools lists the created tool in the paginated flat collection', async ({
    request,
  }) => {
    expect(originalTool?.id).toBeTruthy();

    const response = await apiGet<ToolListResponse>(
      request,
      `/api/projects/${projectId}/tools?page=1&limit=20`,
      token,
      {
        headers: { 'X-Tenant-Id': tenantId },
      },
    );

    expect(response.status).toBe(200);
    expect(response.body.success).toBe(true);
    expect(response.body.data.some((tool) => tool.id === originalTool?.id)).toBe(true);
    expect(response.body.pagination.total).toBeGreaterThanOrEqual(1);
  });

  test('GET /tools/:id/export returns the current v2 flat export format', async ({ request }) => {
    expect(originalTool?.id).toBeTruthy();

    const response = await apiGet<ToolExportRouteResponse>(
      request,
      `/api/projects/${projectId}/tools/${originalTool?.id}/export`,
      token,
      {
        headers: { 'X-Tenant-Id': tenantId },
      },
    );

    expect(response.status).toBe(200);
    expect(response.body.success).toBe(true);
    expect(response.body.export.exportVersion).toBe(2);
    expect(response.body.export.tool.name).toBe(originalTool?.name);
    expect(response.body.export.tool.toolType).toBe('http');
    expect(response.body.export.tool.id).toBeUndefined();
    expect(response.body.export.tool.projectId).toBeUndefined();
    expect('version' in response.body.export).toBe(false);
  });

  test('POST /tools/import accepts the legacy wrapped export payload', async ({ request }) => {
    expect(originalTool?.id).toBeTruthy();

    const exportResponse = await apiGet<ToolExportRouteResponse>(
      request,
      `/api/projects/${projectId}/tools/${originalTool?.id}/export`,
      token,
      {
        headers: { 'X-Tenant-Id': tenantId },
      },
    );

    expect(exportResponse.status).toBe(200);

    const importName = `tool_import_${uniqueSuffix()}`;
    const response = await apiPost<ToolDetailResponse>(
      request,
      `/api/projects/${projectId}/tools/import`,
      token,
      {
        export: {
          ...exportResponse.body.export,
          tool: {
            ...exportResponse.body.export.tool,
            name: importName,
          },
          version: {
            versionId: 'legacy-version-id',
            versionName: 'legacy-v1',
          },
        },
      },
      {
        headers: { 'X-Tenant-Id': tenantId },
      },
    );

    expect(response.status).toBe(201);
    expect(response.body.success).toBe(true);
    expect(response.body.tool.name).toBe(importName);
    expect(response.body.tool.toolType).toBe('http');
    expect(response.body.tool.dslContent).toContain('endpoint: "https://example.com/weather"');

    importedToolId = response.body.tool.id;
  });

  test('POST /tools/:id/duplicate uses the current _copy naming scheme', async ({ request }) => {
    expect(originalTool?.id).toBeTruthy();

    const response = await apiPost<ToolDetailResponse>(
      request,
      `/api/projects/${projectId}/tools/${originalTool?.id}/duplicate`,
      token,
      {},
      {
        headers: { 'X-Tenant-Id': tenantId },
      },
    );

    expect(response.status).toBe(201);
    expect(response.body.success).toBe(true);
    expect(response.body.tool.name).toBe(`${originalTool?.name}_copy`);
    expect(response.body.tool.name.includes('(Copy)')).toBe(false);
    expect(response.body.tool.dslContent.split('\n')[0]).toBe(
      `${originalTool?.name}_copy() -> object`,
    );

    duplicatedToolId = response.body.tool.id;
  });

  test('DELETE /tools/:id removes the tool and GET returns 404 afterwards', async ({ request }) => {
    expect(originalTool?.id).toBeTruthy();

    const deleteResponse = await apiDelete<DeleteResponse>(
      request,
      `/api/projects/${projectId}/tools/${originalTool?.id}`,
      token,
      {
        headers: { 'X-Tenant-Id': tenantId },
      },
    );

    expect(deleteResponse.status).toBe(200);
    expect(deleteResponse.body.success).toBe(true);
    expect(deleteResponse.body.deleted).toBe(originalTool?.id);

    const getResponse = await apiGet<{
      success: false;
      errors: Array<{ code: string; msg: string }>;
    }>(request, `/api/projects/${projectId}/tools/${originalTool?.id}`, token, {
      headers: { 'X-Tenant-Id': tenantId },
    });

    expect(getResponse.status).toBe(404);
    expect(getResponse.body.success).toBe(false);
    expect(getResponse.body.errors[0]?.code).toBe('NOT_FOUND');
  });

  test('cleanup sanity check keeps imported and duplicated tools scoped to the test project', async ({
    request,
  }) => {
    expect(importedToolId).toBeTruthy();
    expect(duplicatedToolId).toBeTruthy();

    const response = await apiGet<ToolListResponse>(
      request,
      `/api/projects/${projectId}/tools?page=1&limit=20`,
      token,
      {
        headers: { 'X-Tenant-Id': tenantId },
      },
    );

    expect(response.status).toBe(200);
    expect(response.body.data.some((tool) => tool.id === importedToolId)).toBe(true);
    expect(response.body.data.some((tool) => tool.id === duplicatedToolId)).toBe(true);
  });
});
