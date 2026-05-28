import { test, expect, type Page } from '@playwright/test';
import { getDevAccessToken, loginViaDevApi } from './helpers';
import { getSdkBrowserStudioBaseUrl } from './helpers/sdk-browser-env';

const STUDIO_URL = getSdkBrowserStudioBaseUrl();
const TEST_LOGIN_EMAIL = 'tools-ui@e2e-smoke.test';
const TEST_LOGIN_NAME = 'Tools UI E2E';

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
      name: `Tools Layout ${suffix}`,
      slug: `tools-layout-${suffix.replace(/_/g, '-')}`,
      description: 'Project created by tools layout Playwright coverage',
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

async function createHttpToolWithParameters(
  page: Page,
  token: string,
  tenantId: string,
  projectId: string,
): Promise<string> {
  const name = `layout_probe_${uniqueSuffix()}`;
  const response = await page.request.post(`${STUDIO_URL}/api/projects/${projectId}/tools`, {
    headers: {
      Authorization: `Bearer ${token}`,
      'X-Tenant-Id': tenantId,
      'Content-Type': 'application/json',
    },
    data: {
      name,
      description: 'HTTP tool used to verify parameter layout behavior on the detail page',
      toolType: 'http',
      endpoint: 'https://api.example.com/weather',
      method: 'GET',
      parameters: [
        {
          name: 'customer_email_address',
          type: 'string',
          description: 'Customer email address',
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

function toolCreationButton(page: Page) {
  return page.getByRole('button', { name: /^(Create|New) Tool$/ }).first();
}

test.describe('Tool Management UI Tests', () => {
  let BASE_URL: string;
  let token: string;
  let tenantId: string;
  let projectId: string;
  let seedToolId: string;

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
    seedToolId = await createHttpToolWithParameters(page, token, tenantId, projectId);
    BASE_URL = `${STUDIO_URL}/projects/${projectId}`;

    await page.goto(`${BASE_URL}/tools`);
    await page.waitForLoadState('networkidle');
  });

  test.afterEach(async ({ page }) => {
    if (!projectId) {
      return;
    }
    await deleteProject(page, token, tenantId, projectId);
    projectId = '';
    seedToolId = '';
  });

  test('Tools list page uses full width layout', async ({ page }) => {
    // Check that the tools list is visible
    await expect(page.locator('h1:has-text("Tools")')).toBeVisible();

    const container = page.locator('main .flex-1.overflow-auto').first();
    await expect(container).toHaveClass(/overflow-auto/);
    await expect(container).toHaveClass(/px-6/);
    await expect(container).toHaveClass(/py-6/);
    await expect(container).not.toHaveClass(/max-w-/);
  });

  test('Tool creation dropdown is present and functional', async ({ page }) => {
    const newToolButton = toolCreationButton(page);
    await expect(newToolButton).toBeVisible();

    // Click to open dropdown
    await newToolButton.click();

    // Check for tool type options
    await expect(page.getByRole('button', { name: 'HTTP Call external REST APIs' })).toBeVisible();
    await expect(
      page.getByRole('button', { name: 'MCP Server Manage servers & import tools' }),
    ).toBeVisible();

    // Code tools are feature-gated in the isolated E2E tenant.
    await expect(page.locator('text=Code Tool')).not.toBeVisible();
  });

  test('HTTP tool creation wizard flow', async ({ page }) => {
    // Open dropdown and select HTTP
    await toolCreationButton(page).click();
    await page.getByRole('button', { name: 'HTTP Call external REST APIs' }).click();

    // Should navigate to wizard with type query param
    await expect(page).toHaveURL(/\/tools\/new\?type=http/);

    // Check for wizard layout
    await expect(page.locator('h1:has-text("Create HTTP")')).toBeVisible();
    await expect(page.locator('text=Step 1 of 3')).toBeVisible();

    // Check for progress indicators
    await expect(page.locator('text=Basic Info')).toBeVisible();
    await expect(page.locator('text=Configuration')).toBeVisible();
    await expect(page.locator('text=Review')).toBeVisible();

    // Step 1: Fill basic info
    await page.fill('input[placeholder="search_documents"]', 'test_http_tool');
    await page.fill('input[placeholder*="Calls"]', 'Test HTTP tool for Playwright');

    // Check that Next button becomes enabled
    const nextButton = page.locator('button:has-text("Next")');
    await expect(nextButton).toBeEnabled();

    // Go to next step
    await nextButton.click();
    await expect(page.locator('text=Step 2 of 3')).toBeVisible();

    // Step 2: Fill HTTP config
    await page.fill('input[placeholder*="https://api.example.com"]', 'https://httpbin.org/get');

    // Check auth presets dropdown exists
    await expect(page.locator('text=Quick Setup')).toBeVisible();

    // Go to review step
    await nextButton.click();
    await expect(page.locator('text=Step 3 of 3')).toBeVisible();
    await expect(page.locator('text=Review')).toBeVisible();

    // Verify review shows entered data
    await expect(page.locator(`text=test_http_tool`)).toBeVisible();
    await expect(page.locator('text=https://httpbin.org/get')).toBeVisible();
  });

  test('Sandbox tool creation wizard flow', async ({ page }) => {
    const codeToolOption = page.getByText('Code Tool');
    if (!(await codeToolOption.isVisible().catch(() => false))) {
      test.skip(true, 'Code tools are disabled in the isolated E2E tenant');
    }

    // Open dropdown and select Code Tool
    await toolCreationButton(page).click();
    await codeToolOption.first().click();

    // Should navigate to wizard
    await expect(page).toHaveURL(/\/tools\/new\?type=sandbox/);
    await expect(page.locator('h1:has-text("Create Code")')).toBeVisible();

    // Step 1: Fill basic info
    await page.fill('input[placeholder="search_documents"]', 'test_code_tool');
    await page.locator('button:has-text("Next")').click();

    // Step 2: Check code editor is present
    await expect(page.locator('text=Code & Config')).toBeVisible();

    // Check for code templates dropdown
    await expect(page.locator('text=Load Template')).toBeVisible();

    // Check for Parse button (auto-parse params)
    await expect(page.locator('button:has-text("Parse")')).toBeVisible();
  });

  test('MCP tool creation wizard flow', async ({ page }) => {
    // Open dropdown and select MCP Tool
    await toolCreationButton(page).click();
    await page.getByRole('button', { name: 'MCP Server Manage servers & import tools' }).click();

    // Should navigate to wizard
    await expect(page).toHaveURL(/\/tools\/new\?type=mcp/);
    await expect(page.locator('h1:has-text("Create MCP")')).toBeVisible();

    // Step 1: Fill basic info
    await page.fill('input[placeholder="search_documents"]', 'test_mcp_tool');
    await page.locator('button:has-text("Next")').click();

    // Step 2: Check MCP config fields
    await expect(page.locator('text=Server URL')).toBeVisible();
    await expect(page.locator('text=Transport')).toBeVisible();
  });

  test('Tool detail page has tab layout with Config, Test, and Versions', async ({ page }) => {
    await page.goto(`${BASE_URL}/tools/${seedToolId}`);
    await page.waitForLoadState('networkidle');

    // Check that we're on a detail page (not the new page)
    await expect(page).toHaveURL(/\/tools\/[^/]+$/);

    // Verify tabs are present
    await expect(page.locator('button:has-text("Config")')).toBeVisible();
    await expect(page.locator('button:has-text("Test")')).toBeVisible();
    await expect(page.locator('button:has-text("Versions")')).toBeVisible();

    // Config tab should be active by default
    await expect(page.locator('text=Description')).toBeVisible();
    await expect(page.locator('text=Timeout (ms)')).toBeVisible();

    // Click Test tab
    await page.locator('button:has-text("Test")').click();
    await expect(page.locator('h3:has-text("Test Tool")')).toBeVisible();
    await expect(page.locator('button:has-text("Run Test")')).toBeVisible();

    // Click Versions tab
    await page.locator('button:has-text("Versions")').click();
    await expect(page.locator('text=Version History')).toBeVisible();
  });

  test('Test panel is accessible via Test tab', async ({ page }) => {
    await page.goto(`${BASE_URL}/tools/${seedToolId}`);
    await page.waitForLoadState('networkidle');

    // Click Test tab to access test panel
    await page.locator('button:has-text("Test")').click();

    // Test panel should now be visible
    await expect(page.locator('h3:has-text("Test Tool")')).toBeVisible();
    await expect(page.locator('button:has-text("Run Test")')).toBeVisible();
  });

  test('Tool detail parameter rows do not overflow the config container', async ({ page }) => {
    await page.setViewportSize({ width: 1024, height: 900 });

    const token = await getDevAccessToken(page, {
      baseUrl: STUDIO_URL,
      email: TEST_LOGIN_EMAIL,
      name: TEST_LOGIN_NAME,
    });
    expect(token).toBeTruthy();

    const tenantId = getTenantIdFromToken(token);
    const projectId = await createProject(page, token, tenantId);

    try {
      const toolId = await createHttpToolWithParameters(page, token, tenantId, projectId);

      await page.goto(`${STUDIO_URL}/projects/${projectId}/tools/${toolId}`);
      await page.waitForLoadState('networkidle');

      const parameterRow = page.getByTestId('parameter-row-0');
      await expect(parameterRow).toBeVisible();
      await expect(page.getByRole('checkbox', { name: 'Required' })).toBeVisible();

      const metrics = await parameterRow.evaluate((row) => {
        if (!(row instanceof HTMLElement)) {
          throw new Error('Parameter row is not an HTML element');
        }

        const detailContainer = row.closest('.max-w-4xl');
        if (!(detailContainer instanceof HTMLElement)) {
          throw new Error('Tool detail container not found');
        }

        return {
          rowClientWidth: row.clientWidth,
          rowScrollWidth: row.scrollWidth,
          containerClientWidth: detailContainer.clientWidth,
          containerScrollWidth: detailContainer.scrollWidth,
          rowRight: row.getBoundingClientRect().right,
          containerRight: detailContainer.getBoundingClientRect().right,
        };
      });

      expect(metrics.rowScrollWidth).toBeLessThanOrEqual(metrics.rowClientWidth + 1);
      expect(metrics.containerScrollWidth).toBeLessThanOrEqual(metrics.containerClientWidth + 1);
      expect(metrics.rowRight).toBeLessThanOrEqual(metrics.containerRight + 1);
    } finally {
      await deleteProject(page, token, tenantId, projectId);
    }
  });

  test('Wizard layout uses max-w-5xl (not full width)', async ({ page }) => {
    // Open HTTP wizard
    await toolCreationButton(page).click();
    await page.locator('text=HTTP').first().click();

    // Check that wizard container has max-w-5xl
    const wizardContainer = page.locator('.overflow-y-auto > div').first();
    await expect(wizardContainer).toHaveClass(/max-w-5xl/);

    // Verify it's centered (mx-auto)
    await expect(wizardContainer).toHaveClass(/mx-auto/);
  });

  test('MCP servers page uses full width', async ({ page }) => {
    // Navigate to MCP servers (if link exists)
    const mcpServersLink = page.locator('a:has-text("MCP Servers")');

    if (await mcpServersLink.isVisible()) {
      await mcpServersLink.click();
      await page.waitForLoadState('networkidle');

      // Check for full width layout
      const container = page.locator('.overflow-y-auto > div').first();
      await expect(container).toHaveClass(/w-full/);
    }
  });

  test('Tool creation configs are properly cleaned', async ({ page }) => {
    // This test verifies the backend receives clean configs
    // by intercepting the API call

    let requestBody: any = null;

    page.on('request', (request) => {
      if (
        request.url().includes('/api/projects/') &&
        request.url().includes('/tools') &&
        request.method() === 'POST'
      ) {
        requestBody = request.postDataJSON();
      }
    });

    // Create HTTP tool
    await toolCreationButton(page).click();
    await page.locator('text=HTTP').first().click();

    // Fill form
    await page.fill('input[placeholder="search_documents"]', 'test_clean_config');
    await page.locator('button:has-text("Next")').click();

    await page.fill('input[placeholder*="https://api.example.com"]', 'https://httpbin.org/get');
    await page.locator('button:has-text("Next")').click();

    // Create tool
    await page.locator('button:has-text("Create Tool")').click();

    // Wait a bit for request to complete
    await page.waitForTimeout(1000);

    // Verify httpConfig only has allowed fields
    if (requestBody && requestBody.httpConfig) {
      const httpConfig = requestBody.httpConfig;

      // Should have these fields
      expect(httpConfig).toHaveProperty('endpoint');
      expect(httpConfig).toHaveProperty('method');
      expect(httpConfig).toHaveProperty('authType');

      // Should NOT have these fields
      expect(httpConfig).not.toHaveProperty('queryParams');
      expect(httpConfig).not.toHaveProperty('body');
      expect(httpConfig).not.toHaveProperty('bodyType');
    }
  });
});
