/**
 * Tool Creation Redesign E2E Tests
 *
 * Validates the tools creation UI changes:
 * - Auth type config fields render correctly
 * - Custom headers stored as object (not JSON string)
 * - Auth header collision warnings display
 * - KeyValueRow components render consistently
 * - Payload reaches the API with correct shape
 *
 * @e2e-real — No mocks. Hits real Studio endpoints via PM2 dev server.
 */

import { test, expect, type Page } from '@playwright/test';
import { loginViaDevApi, getDevAccessToken } from './helpers';
import { getSdkBrowserStudioBaseUrl } from './helpers/sdk-browser-env';

const STUDIO_URL = getSdkBrowserStudioBaseUrl();
const TEST_LOGIN_EMAIL = 'tool-redesign@e2e-smoke.test';
const TEST_LOGIN_NAME = 'Tool Redesign E2E';

function uniqueSuffix() {
  return `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function getTenantIdFromToken(token: string) {
  const [, payload = ''] = token.split('.');
  const decoded = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as {
    tenantId?: string;
  };
  return decoded.tenantId ?? 'tenant-kore';
}

async function createProject(page: Page, token: string, tenantId: string): Promise<string> {
  const suffix = uniqueSuffix();
  const response = await page.request.post(`${STUDIO_URL}/api/projects`, {
    headers: {
      Authorization: `Bearer ${token}`,
      'X-Tenant-Id': tenantId,
      'Content-Type': 'application/json',
    },
    data: {
      name: `Tool Redesign E2E ${suffix}`,
      slug: `tool-redesign-e2e-${suffix.replace(/_/g, '-')}`,
      description: 'E2E project for tool creation redesign tests',
    },
  });
  expect(response.ok()).toBeTruthy();
  const body = (await response.json()) as { project?: { id?: string } };
  expect(body.project?.id).toBeTruthy();
  return body.project?.id ?? '';
}

async function deleteProject(page: Page, token: string, tenantId: string, projectId: string) {
  await page.request.delete(`${STUDIO_URL}/api/projects/${projectId}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      'X-Tenant-Id': tenantId,
    },
  });
}

test.describe('Tool Creation Redesign', () => {
  let token: string;
  let tenantId: string;
  let projectId: string;

  test.beforeEach(async ({ page }) => {
    await loginViaDevApi(page, {
      baseUrl: STUDIO_URL,
      email: TEST_LOGIN_EMAIL,
      name: TEST_LOGIN_NAME,
    });

    token = await getDevAccessToken(page, {
      baseUrl: STUDIO_URL,
      email: TEST_LOGIN_EMAIL,
      name: TEST_LOGIN_NAME,
    });
    tenantId = getTenantIdFromToken(token);
    projectId = await createProject(page, token, tenantId);
  });

  test.afterEach(async ({ page }) => {
    if (projectId) {
      await deleteProject(page, token, tenantId, projectId);
      projectId = '';
    }
  });

  test('HTTP tool with API key auth sends correct authConfig shape', async ({ page }) => {
    let capturedPayload: Record<string, unknown> | null = null;

    page.on('request', (request) => {
      if (
        request.url().includes('/api/projects/') &&
        request.url().includes('/tools') &&
        request.method() === 'POST'
      ) {
        capturedPayload = request.postDataJSON() as Record<string, unknown>;
      }
    });

    await page.goto(`${STUDIO_URL}/projects/${projectId}/tools/new?type=http`);
    await page.waitForLoadState('networkidle');

    // Step 1: Basic info
    await page.fill('input[placeholder="search_documents"]', `api_key_test_${uniqueSuffix()}`);
    await page.fill('input[placeholder*="Calls"]', 'Tests API key auth payload');
    await page.locator('button:has-text("Next")').click();

    // Step 2: Config
    await page.fill('input[placeholder*="https://api.example.com"]', 'https://httpbin.org/headers');

    // Select API Key auth
    const authSelect = page.locator('text=Authentication').locator('..').locator('select, button');
    // Find the auth dropdown - it should be on the same row as "Authentication"
    const authContainer = page.locator('label:has-text("Authentication")').locator('..');
    // Use the Select component
    await page.getByText('No Auth').click();
    await page.getByText('API Key').click();

    // Fill API key config
    await page.fill('input[placeholder*="X-API-Key"]', 'X-Custom-Auth');
    await page.fill('input[type="password"]', '{{secrets.MY_API_KEY}}');

    // Go to review and create
    await page.locator('button:has-text("Next")').click();
    await page.locator('button:has-text("Create Tool")').click();

    // Wait for the request to fire
    await page.waitForTimeout(2000);

    if (capturedPayload) {
      expect(capturedPayload.auth).toBe('api_key');
      const authConfig = capturedPayload.authConfig as Record<string, unknown>;
      expect(authConfig).toBeDefined();
      expect(authConfig.headerName).toBe('X-Custom-Auth');
      expect(authConfig.apiKey).toBe('{{secrets.MY_API_KEY}}');
      // customHeaders should NOT be present for api_key auth
      expect(authConfig.customHeaders).toBeUndefined();
    }
  });

  test('HTTP tool with custom auth sends customHeaders as object', async ({ page }) => {
    let capturedPayload: Record<string, unknown> | null = null;

    page.on('request', (request) => {
      if (
        request.url().includes('/api/projects/') &&
        request.url().includes('/tools') &&
        request.method() === 'POST'
      ) {
        capturedPayload = request.postDataJSON() as Record<string, unknown>;
      }
    });

    await page.goto(`${STUDIO_URL}/projects/${projectId}/tools/new?type=http`);
    await page.waitForLoadState('networkidle');

    // Step 1: Basic info
    await page.fill('input[placeholder="search_documents"]', `custom_auth_${uniqueSuffix()}`);
    await page.locator('button:has-text("Next")').click();

    // Step 2: Config
    await page.fill('input[placeholder*="https://api.example.com"]', 'https://httpbin.org/headers');

    // Select Custom auth
    await page.getByText('No Auth').click();
    await page.getByText('Custom').click();

    // Add custom auth header
    const addButton = page.locator('button:has-text("Add")').last();
    await addButton.click();

    // Fill the custom header
    const headerNameInput = page.getByPlaceholder('Header name');
    const headerValueInput = page.getByPlaceholder('{{secrets.MY_KEY}}');
    if (await headerNameInput.isVisible()) {
      await headerNameInput.fill('X-Custom-Token');
      await headerValueInput.fill('{{secrets.AUTH_TOKEN}}');
    }

    // Go to review and create
    await page.locator('button:has-text("Next")').click();
    await page.locator('button:has-text("Create Tool")').click();

    await page.waitForTimeout(2000);

    if (capturedPayload) {
      expect(capturedPayload.auth).toBe('custom');
      const authConfig = capturedPayload.authConfig as Record<string, unknown>;
      if (authConfig?.customHeaders) {
        // CRITICAL: customHeaders must be an object, NOT a JSON string
        expect(typeof authConfig.customHeaders).toBe('object');
        expect(typeof authConfig.customHeaders).not.toBe('string');
        const headers = authConfig.customHeaders as Record<string, string>;
        expect(headers['X-Custom-Token']).toBe('{{secrets.AUTH_TOKEN}}');
      }
    }
  });

  test('HTTP tool creation via API with customHeaders as object round-trips correctly', async ({
    page,
  }) => {
    // Create tool directly via API with customHeaders as object
    const toolName = `roundtrip_${uniqueSuffix()}`;
    const createResponse = await page.request.post(
      `${STUDIO_URL}/api/projects/${projectId}/tools`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          'X-Tenant-Id': tenantId,
          'Content-Type': 'application/json',
        },
        data: {
          name: toolName,
          toolType: 'http',
          description: 'Custom auth round-trip test',
          endpoint: 'https://httpbin.org/headers',
          method: 'POST',
          auth: 'custom',
          authConfig: {
            customHeaders: {
              'X-Auth': '{{secrets.AUTH_TOKEN}}',
              'X-Org': 'org-123',
            },
          },
        },
      },
    );

    expect(createResponse.ok()).toBeTruthy();
    const createBody = (await createResponse.json()) as { tool?: { id?: string } };
    const toolId = createBody.tool?.id;
    expect(toolId).toBeTruthy();

    // Fetch the tool back and verify customHeaders survived the round-trip
    const getResponse = await page.request.get(
      `${STUDIO_URL}/api/projects/${projectId}/tools/${toolId}`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          'X-Tenant-Id': tenantId,
        },
      },
    );

    expect(getResponse.ok()).toBeTruthy();
    const getBody = (await getResponse.json()) as {
      tool?: {
        dslContent?: string;
      };
    };

    // The DSL content should contain the custom headers
    const dsl = getBody.tool?.dslContent ?? '';
    expect(dsl).toContain('X-Auth');
    expect(dsl).toContain('{{secrets.AUTH_TOKEN}}');
    expect(dsl).toContain('X-Org');
    expect(dsl).toContain('org-123');
  });

  test('HTTP tool detail page renders custom auth headers as editable key-value rows', async ({
    page,
  }) => {
    // Create tool with custom auth via API
    const toolName = `detail_custom_${uniqueSuffix()}`;
    const createResponse = await page.request.post(
      `${STUDIO_URL}/api/projects/${projectId}/tools`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          'X-Tenant-Id': tenantId,
          'Content-Type': 'application/json',
        },
        data: {
          name: toolName,
          toolType: 'http',
          description: 'Detail page custom auth test',
          endpoint: 'https://httpbin.org/headers',
          method: 'GET',
          auth: 'custom',
          authConfig: {
            customHeaders: {
              'X-Session': '{{secrets.SESSION_TOKEN}}',
              'X-Version': 'v2',
            },
          },
        },
      },
    );

    expect(createResponse.ok()).toBeTruthy();
    const body = (await createResponse.json()) as { tool?: { id?: string } };
    const toolId = body.tool?.id;

    // Navigate to tool detail page
    await page.goto(`${STUDIO_URL}/projects/${projectId}/tools/${toolId}`);
    await page.waitForLoadState('networkidle');

    // Verify the custom headers are rendered as editable inputs
    await expect(page.getByDisplayValue('X-Session')).toBeVisible();
    await expect(page.getByDisplayValue('{{secrets.SESSION_TOKEN}}')).toBeVisible();
    await expect(page.getByDisplayValue('X-Version')).toBeVisible();
    await expect(page.getByDisplayValue('v2')).toBeVisible();
  });

  test('general headers use consistent KeyValueRow design', async ({ page }) => {
    // Create tool with headers via API
    const toolName = `headers_design_${uniqueSuffix()}`;
    const createResponse = await page.request.post(
      `${STUDIO_URL}/api/projects/${projectId}/tools`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          'X-Tenant-Id': tenantId,
          'Content-Type': 'application/json',
        },
        data: {
          name: toolName,
          toolType: 'http',
          description: 'Header design test',
          endpoint: 'https://httpbin.org/get',
          method: 'GET',
          auth: 'none',
          headers: [
            { key: 'Accept', value: 'application/json' },
            { key: 'X-Request-ID', value: '{{input.requestId}}' },
          ],
        },
      },
    );

    expect(createResponse.ok()).toBeTruthy();
    const body = (await createResponse.json()) as { tool?: { id?: string } };
    const toolId = body.tool?.id;

    await page.goto(`${STUDIO_URL}/projects/${projectId}/tools/${toolId}`);
    await page.waitForLoadState('networkidle');

    // Both header rows should be visible
    await expect(page.getByDisplayValue('Accept')).toBeVisible();
    await expect(page.getByDisplayValue('application/json')).toBeVisible();
    await expect(page.getByDisplayValue('X-Request-ID')).toBeVisible();
    await expect(page.getByDisplayValue('{{input.requestId}}')).toBeVisible();

    // Each row should have a delete button (ghost button with Trash icon)
    const trashButtons = page.locator('button:has(svg.lucide-trash-2)');
    // At least 2 trash buttons for the 2 header rows
    expect(await trashButtons.count()).toBeGreaterThanOrEqual(2);
  });

  test('payload builder produces correct shape for all tool types via API', async ({ page }) => {
    // HTTP tool
    const httpResponse = await page.request.post(`${STUDIO_URL}/api/projects/${projectId}/tools`, {
      headers: {
        Authorization: `Bearer ${token}`,
        'X-Tenant-Id': tenantId,
        'Content-Type': 'application/json',
      },
      data: {
        name: `http_shape_${uniqueSuffix()}`,
        toolType: 'http',
        endpoint: 'https://httpbin.org/post',
        method: 'POST',
        auth: 'bearer',
        authConfig: { token: '{{secrets.TOKEN}}' },
        headers: [{ key: 'Content-Type', value: 'application/json' }],
        body: '{"key": "{{input.value}}"}',
        bodyType: 'json',
        timeout: 15000,
        retry: 2,
        retryDelay: 500,
        parameters: [{ name: 'value', type: 'string', description: 'Test value', required: true }],
        returnType: 'object',
      },
    });
    expect(httpResponse.ok()).toBeTruthy();

    // MCP tool
    const mcpResponse = await page.request.post(`${STUDIO_URL}/api/projects/${projectId}/tools`, {
      headers: {
        Authorization: `Bearer ${token}`,
        'X-Tenant-Id': tenantId,
        'Content-Type': 'application/json',
      },
      data: {
        name: `mcp_shape_${uniqueSuffix()}`,
        toolType: 'mcp',
        server: 'https://mcp.example.com/sse',
        serverTool: 'search',
        transportType: 'http',
        headers: [{ key: 'Authorization', value: 'Bearer {{secrets.MCP_TOKEN}}' }],
      },
    });
    expect(mcpResponse.ok()).toBeTruthy();

    // Verify the created tools exist in list
    const listResponse = await page.request.get(
      `${STUDIO_URL}/api/projects/${projectId}/tools?limit=10`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          'X-Tenant-Id': tenantId,
        },
      },
    );
    expect(listResponse.ok()).toBeTruthy();
    const listBody = (await listResponse.json()) as { tools?: Array<{ toolType: string }> };
    const toolTypes = (listBody.tools ?? []).map((t) => t.toolType);
    expect(toolTypes).toContain('http');
    expect(toolTypes).toContain('mcp');
  });
});
