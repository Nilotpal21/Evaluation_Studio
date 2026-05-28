import { test, expect, type Page } from '@playwright/test';
import { getDevAccessToken, loginViaDevApi } from './helpers';
import { getSdkBrowserStudioBaseUrl } from './helpers/sdk-browser-env';

/**
 * E2E tests for the cURL Import feature in the HTTP Tool wizard.
 *
 * Tests the full flow: paste cURL → parse → verify preview → import → verify form.
 */

let BASE_URL: string;
const STUDIO_URL = getSdkBrowserStudioBaseUrl();
const TEST_LOGIN_EMAIL = 'curl-import@e2e-smoke.test';
const TEST_LOGIN_NAME = 'cURL Import E2E';
const BEST_EFFORT_NETWORK_IDLE_TIMEOUT_MS = 5_000;

interface CreateProjectResponse {
  success: boolean;
  project: {
    id: string;
  };
}

async function waitForBestEffortNetworkIdle(page: Page): Promise<void> {
  await page
    .waitForLoadState('networkidle', {
      timeout: BEST_EFFORT_NETWORK_IDLE_TIMEOUT_MS,
    })
    .catch(() => {});
}

async function createProjectViaApi(page: Page): Promise<string> {
  const accessToken = await getDevAccessToken(page, {
    baseUrl: STUDIO_URL,
    email: TEST_LOGIN_EMAIL,
    name: TEST_LOGIN_NAME,
  });
  expect(accessToken, 'Expected dev-login to return an access token').toBeTruthy();

  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const response = await page.request.post(`${STUDIO_URL}/api/projects`, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    data: {
      name: `Curl Import ${suffix}`,
      slug: `curl-import-${suffix}`,
    },
  });

  expect(response.status()).toBe(201);
  const body = (await response.json()) as CreateProjectResponse;
  expect(body.success).toBe(true);

  return body.project.id;
}

async function loginViaDevApiWithRetry(page: Page): Promise<void> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await loginViaDevApi(page, {
        baseUrl: STUDIO_URL,
        email: TEST_LOGIN_EMAIL,
        name: TEST_LOGIN_NAME,
      });
      return;
    } catch (error) {
      if (attempt === 1) {
        throw error;
      }
      await page.waitForTimeout(1_500);
    }
  }
}

async function loginAndNavigateToTools(page: Page) {
  await loginViaDevApiWithRetry(page);
  const projectId = await createProjectViaApi(page);
  BASE_URL = `${STUDIO_URL}/projects/${projectId}`;

  await page.goto(`${BASE_URL}/tools`);
  await expect(page).toHaveURL(/\/tools$/);
  await waitForBestEffortNetworkIdle(page);
}

async function openHttpWizardStep2(page: Page) {
  await page.goto(`${BASE_URL}/tools/new?type=http`);
  await expect(page).toHaveURL(/\/tools\/new\?type=http/);
  await page.locator('input[placeholder="weather_api"]').waitFor({ state: 'visible' });

  // Step 1: fill required fields
  await page.fill('input[placeholder="weather_api"]', 'curl_import_test');
  await page.fill(
    'input[placeholder="Fetches weather data from OpenWeather API"]',
    'Test tool for cURL import',
  );
  await page.locator('button:has-text("Next")').click();
  await expect(page.locator('text=Step 2 of 3')).toBeVisible();
}

async function openCurlDialog(page: Page) {
  await page.getByRole('button', { name: 'Import from cURL' }).click();
  await expect(page.getByTestId('curl-import-dialog')).toBeVisible();
}

async function parseCurl(page: Page, curl: string) {
  const dialog = page.getByTestId('curl-import-dialog');
  const textarea = dialog.getByTestId('curl-import-textarea');
  await textarea.fill(curl);
  await dialog.getByRole('button', { name: 'Parse cURL Command' }).click();
  await expect(dialog.getByTestId('curl-import-success')).toBeVisible();
}

function getPreview(page: Page) {
  return page.getByTestId('curl-import-preview');
}

test.describe('cURL Import E2E Tests', () => {
  test.beforeEach(async ({ page }) => {
    await loginAndNavigateToTools(page);
    await openHttpWizardStep2(page);
  });

  test('basic POST with Bearer auth — preview shows correct method, auth, headers', async ({
    page,
  }) => {
    await openCurlDialog(page);
    await parseCurl(
      page,
      `curl -X POST https://api.example.com/v1/users -H "Authorization: Bearer sk-123456" -H "Content-Type: application/json" -d '{"name": "John Doe", "email": "john@example.com"}'`,
    );

    const preview = getPreview(page);

    // Check method in preview
    await expect(preview.getByTestId('curl-import-preview-method')).toContainText('POST');

    // Check endpoint in preview
    await expect(preview.getByTestId('curl-import-preview-endpoint')).toContainText(
      'https://api.example.com/v1/users',
    );

    // Check auth type
    await expect(preview.getByTestId('curl-import-preview-auth')).toContainText(/bearer/i);

    // Check Content-Type header is shown in preview
    await expect(preview.getByTestId('curl-import-preview-headers')).toContainText('Content-Type:');

    // Check body type
    await expect(preview.getByTestId('curl-import-preview-body-type')).toContainText(/json/i);

    // Import and verify form
    await page.getByRole('button', { name: 'Import Configuration' }).click();

    // Verify the imported configuration populates the form.
    const endpointInput = page.locator('input[placeholder*="https://"]');
    await expect(endpointInput).toHaveValue('https://api.example.com/v1/users');
  });

  test('--data= syntax parses body correctly', async ({ page }) => {
    await openCurlDialog(page);
    await parseCurl(
      page,
      `curl -X POST https://api.example.com/data --data='{"key":"value","count":42}'`,
    );

    const preview = getPreview(page);
    await expect(preview.getByTestId('curl-import-preview-method')).toContainText('POST');

    // Body should be visible in preview
    await expect(preview.getByTestId('curl-import-preview-body-content')).toContainText(
      '"key": "value"',
    );
    await expect(preview.getByTestId('curl-import-preview-body-content')).toContainText(
      '"count": 42',
    );
  });

  test('multiple -d flags concatenate with &', async ({ page }) => {
    await openCurlDialog(page);
    await parseCurl(
      page,
      `curl -X POST https://api.example.com/form -d "username=admin" -d "password=secret123"`,
    );

    const preview = getPreview(page);

    // Body should contain both values concatenated
    await expect(preview.getByTestId('curl-import-preview-body-content')).toContainText(
      'username=admin',
    );
    await expect(preview.getByTestId('curl-import-preview-body-content')).toContainText(
      'password=secret123',
    );
  });

  test('-H= syntax parses headers correctly', async ({ page }) => {
    await openCurlDialog(page);
    await parseCurl(
      page,
      `curl -X POST https://api.example.com/data -H="Content-Type: application/json" -H="Accept: text/plain" -d '{"test": true}'`,
    );

    const preview = getPreview(page);

    // Both headers should appear in preview
    await expect(preview.getByTestId('curl-import-preview-headers')).toContainText('Content-Type');
    await expect(preview.getByTestId('curl-import-preview-headers')).toContainText('Accept');
  });

  test('Chrome DevTools cURL with query params, auth, and body', async ({ page }) => {
    await openCurlDialog(page);
    await parseCurl(
      page,
      `curl 'https://api.example.com/v2/search?q=hello&limit=20' -H 'accept: application/json' -H 'authorization: Bearer eyJhbGciOiJSUzI1NiJ9.test' -H 'content-type: application/json' -H 'x-request-id: req-abc-123' --data-raw '{"filters":{"status":"active"}}'`,
    );

    const preview = getPreview(page);

    // Method should be POST (auto-upgraded because of body)
    await expect(preview.getByTestId('curl-import-preview-method')).toContainText('POST');

    // Auth should be bearer
    await expect(preview.getByTestId('curl-import-preview-auth')).toContainText(/bearer/i);

    // Query params should show
    await expect(preview.getByTestId('curl-import-preview-query-params')).toContainText('q=');
    await expect(preview.getByTestId('curl-import-preview-query-params')).toContainText('hello');
    await expect(preview.getByTestId('curl-import-preview-query-params')).toContainText('limit=');
    await expect(preview.getByTestId('curl-import-preview-query-params')).toContainText('20');

    // Headers (non-auth) should show
    await expect(preview.getByTestId('curl-import-preview-headers')).toContainText('content-type');
    await expect(preview.getByTestId('curl-import-preview-headers')).toContainText('x-request-id');

    // Import and verify form
    await page.getByRole('button', { name: 'Import Configuration' }).click();

    // Verify endpoint does NOT include query params
    const endpointInput = page.locator('input[placeholder*="https://"]');
    await expect(endpointInput).toHaveValue('https://api.example.com/v2/search');

    // Verify method is POST
    await expect(page.getByTestId('http-config-method')).toContainText('POST');
  });

  test('DELETE method is preserved after import', async ({ page }) => {
    await openCurlDialog(page);
    await parseCurl(
      page,
      `curl -X DELETE https://api.example.com/users/42 -H "Authorization: Bearer tok123"`,
    );

    const preview = getPreview(page);
    await expect(preview.getByTestId('curl-import-preview-method')).toContainText('DELETE');

    // Import and verify form
    await page.getByRole('button', { name: 'Import Configuration' }).click();

    await expect(page.getByTestId('http-config-method')).toContainText('DELETE');
  });

  test('API key header is detected as api_key auth type', async ({ page }) => {
    await openCurlDialog(page);
    await parseCurl(
      page,
      `curl https://api.example.com/data -H "X-API-Key: abc123secret" -H "Accept: application/json"`,
    );

    const preview = getPreview(page);

    // Auth type should be api_key
    await expect(preview.getByTestId('curl-import-preview-auth')).toContainText(/api.key/i);

    // Accept header should still show (not stripped)
    await expect(preview.getByTestId('curl-import-preview-headers')).toContainText('Accept');
  });

  test('--data-urlencode= syntax sets form body type', async ({ page }) => {
    await openCurlDialog(page);
    await parseCurl(
      page,
      `curl -X POST https://api.example.com/form --data-urlencode=name=John --data-urlencode=city=New`,
    );

    const preview = getPreview(page);

    // Body type should be FORM
    await expect(preview.getByTestId('curl-import-preview-body-type')).toContainText(/form/i);
  });

  test('Load Example button works and parses correctly', async ({ page }) => {
    await openCurlDialog(page);

    // Click Load Example
    await page.locator('button:has-text("Load Example")').click();

    // Textarea should be populated
    const dialog = page.getByTestId('curl-import-dialog');
    const textarea = dialog.getByTestId('curl-import-textarea');
    await expect(textarea).not.toBeEmpty();

    // Parse the example
    await dialog.getByRole('button', { name: 'Parse cURL Command' }).click();
    const preview = getPreview(page);

    // Verify example parses to POST with bearer auth
    await expect(preview.getByTestId('curl-import-preview-method')).toContainText('POST');
    await expect(preview.getByTestId('curl-import-preview-auth')).toContainText(/bearer/i);
  });
});
