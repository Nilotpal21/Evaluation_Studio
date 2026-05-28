import { test, expect, type Page } from '@playwright/test';
import { getDevAccessToken, loginViaDevApi } from './helpers';
import { getSdkBrowserStudioBaseUrl } from './helpers/sdk-browser-env';

const STUDIO_URL = getSdkBrowserStudioBaseUrl();
const TEST_LOGIN_EMAIL = 'tool-test-fixture-editor@e2e-smoke.test';
const TEST_LOGIN_NAME = 'Tool Test Fixture E2E';

interface ToolTestFixtureResponse {
  success: boolean;
  endpoint: {
    urls: {
      invokeUrl: string;
    };
    staticResponse: unknown;
    sampleInput: Record<string, unknown> | null;
    version: number;
  };
}

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
      name: `Tool Fixture ${suffix}`,
      slug: `tool-fixture-${suffix.replace(/_/g, '-')}`,
      description: 'Project created by tool-test fixture editor Playwright coverage',
    },
  });
  expect(response.ok()).toBeTruthy();
  const body = (await response.json()) as {
    project?: {
      id?: string;
    };
  };
  expect(body.project?.id).toBeTruthy();
  return body.project?.id ?? '';
}

async function createHttpTool(
  page: Page,
  token: string,
  tenantId: string,
  projectId: string,
): Promise<string> {
  const name = `get_order_${uniqueSuffix()}`;
  const response = await page.request.post(`${STUDIO_URL}/api/projects/${projectId}/tools`, {
    headers: {
      Authorization: `Bearer ${token}`,
      'X-Tenant-Id': tenantId,
      'Content-Type': 'application/json',
    },
    data: {
      name,
      description: 'Returns order status from the hosted tool-test fixture',
      toolType: 'http',
      endpoint: 'https://example.com/orders',
      method: 'GET',
      parameters: [
        {
          name: 'order_id',
          type: 'string',
          description: 'Order identifier',
          required: true,
        },
      ],
    },
  });
  expect(response.ok()).toBeTruthy();
  const body = (await response.json()) as {
    tool?: {
      id?: string;
    };
  };
  expect(body.tool?.id).toBeTruthy();
  return body.tool?.id ?? '';
}

async function deleteProject(page: Page, token: string, tenantId: string, projectId: string) {
  const response = await page.request.delete(`${STUDIO_URL}/api/projects/${projectId}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      'X-Tenant-Id': tenantId,
    },
  });
  expect(response.ok()).toBeTruthy();
}

async function fetchFixture(
  page: Page,
  token: string,
  tenantId: string,
  projectId: string,
  toolId: string,
): Promise<ToolTestFixtureResponse> {
  const response = await page.request.get(`${STUDIO_URL}/api/tool-test/${projectId}/${toolId}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      'X-Tenant-Id': tenantId,
    },
  });
  expect(response.ok()).toBeTruthy();
  return (await response.json()) as ToolTestFixtureResponse;
}

async function fetchFixtureStatus(
  page: Page,
  token: string,
  tenantId: string,
  projectId: string,
  toolId: string,
): Promise<number> {
  const response = await page.request.get(`${STUDIO_URL}/api/tool-test/${projectId}/${toolId}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      'X-Tenant-Id': tenantId,
    },
  });
  return response.status();
}

function resolveInvokeUrl(invokeUrl: string): string {
  const parsed = new URL(invokeUrl);
  return `${STUDIO_URL}${parsed.pathname}`;
}

async function openTestingTab(page: Page) {
  const testingTab = page.locator('button[role="tab"]').filter({ hasText: /^Testing$/ });
  await testingTab.click();
  await expect(testingTab).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('button', { name: 'Run Test' })).toBeVisible({ timeout: 5_000 });
}

test.describe('Tool-test fixture editor', () => {
  let token = '';
  let tenantId = '';
  let projectId = '';
  let toolId = '';

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
    toolId = await createHttpTool(page, token, tenantId, projectId);
  });

  test.afterEach(async ({ page }) => {
    if (!projectId) {
      return;
    }
    await deleteProject(page, token, tenantId, projectId);
    projectId = '';
    toolId = '';
  });

  test('edits fixture JSON, updates public response, and reloads saved editor state', async ({
    page,
  }) => {
    const staticResponse = {
      status: 'delayed',
      promised_delivery_date: '2026-05-19',
      customer_message: 'Your replacement is queued.',
    };
    const sampleInput = { order_id: 'VM-48217-A' };

    await page.goto(`${STUDIO_URL}/projects/${projectId}/tools/${toolId}`);
    await page.waitForLoadState('networkidle');
    await openTestingTab(page);

    await expect(page.getByRole('heading', { name: 'Tool-Test Fixture' })).toBeVisible();
    await expect(page.getByText('Not created')).toBeVisible();

    await page.getByLabel('Static response').fill(JSON.stringify(staticResponse, null, 2));
    await page.getByLabel('Sample input').fill(JSON.stringify(sampleInput, null, 2));
    await page.getByRole('button', { name: 'Save' }).click();

    await expect(page.getByText('v1 - active')).toBeVisible();

    const fixture = await fetchFixture(page, token, tenantId, projectId, toolId);
    expect(fixture.endpoint.staticResponse).toEqual(staticResponse);
    expect(fixture.endpoint.sampleInput).toEqual(sampleInput);

    const publicResponse = await page.request.post(
      resolveInvokeUrl(fixture.endpoint.urls.invokeUrl),
      {
        headers: {
          Origin: STUDIO_URL,
        },
        data: sampleInput,
      },
    );
    const publicResponseText = await publicResponse.text();
    expect(
      publicResponse.ok(),
      `expected public fixture invoke to succeed, got ${publicResponse.status()} ${publicResponseText}`,
    ).toBeTruthy();
    expect(JSON.parse(publicResponseText)).toEqual(staticResponse);

    await page.reload();
    await page.waitForLoadState('networkidle');
    await openTestingTab(page);

    await expect(page.getByText('v1 - active')).toBeVisible();
    await expect(page.getByLabel('Static response')).toHaveValue(
      JSON.stringify(staticResponse, null, 2),
    );
    await expect(page.getByLabel('Sample input')).toHaveValue(JSON.stringify(sampleInput, null, 2));
  });

  test('rejects invalid fixture JSON before creating a hosted endpoint', async ({ page }) => {
    await page.goto(`${STUDIO_URL}/projects/${projectId}/tools/${toolId}`);
    await page.waitForLoadState('networkidle');
    await openTestingTab(page);

    await expect(page.getByRole('heading', { name: 'Tool-Test Fixture' })).toBeVisible();
    await expect(page.getByText('Not created')).toBeVisible();

    await page.getByLabel('Static response').fill('{"status":');
    await page.getByLabel('Sample input').fill('{"order_id":"VM-48217-A"}');
    await page.getByRole('button', { name: 'Save' }).click();

    await expect(page.getByText('Fixture JSON is invalid.')).toBeVisible();
    expect(await fetchFixtureStatus(page, token, tenantId, projectId, toolId)).toBe(404);
  });
});
