/**
 * Browser E2E: Attachment Settings UI
 *
 * Exercises the real AttachmentSettingsTab component in a Chromium browser
 * against running Studio (5173) and Runtime (3112). Closes GAP-003 from the
 * attachment-settings-ui feature spec.
 *
 * Scenarios:
 *   BRW-1 — Navigate to Settings > Attachments, verify page loads with resolved config
 *   BRW-2 — Override vs inherited indicators render correctly
 *   BRW-3 — Toggle enabled, change PII policy, save, reload, verify persistence
 *   BRW-4 — MIME type chip editor: add valid, reject invalid, remove chip
 *   BRW-5 — Per-field reset to default: override → save → reset → save → verify inherited
 *   BRW-6 — Save success toast appears on save
 *
 * Run: cd apps/studio && npx playwright test e2e/attachment-settings-e2e.spec.ts --headed
 * Requires: Studio on 5173, Runtime on 3112 (pnpm dev or PM2)
 */

import { test, expect, Page } from '@playwright/test';
import { getDevAccessToken, loginViaDevApi } from './helpers';

// ─── Constants ────────────────────────────────────────────────────────────────

const STUDIO_URL = 'http://localhost:5173';
const TEST_LOGIN_EMAIL = 'attachment-settings@e2e-smoke.test';
const TEST_LOGIN_NAME = 'Attachment Settings E2E';

function uniqueSuffix(): string {
  return `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function getTenantIdFromToken(token: string): string {
  const [, payload = ''] = token.split('.');
  const decoded = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as {
    tenantId?: string;
  };
  return decoded.tenantId ?? 'tenant-kore';
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function devLogin(page: Page): Promise<void> {
  await loginViaDevApi(page, {
    baseUrl: STUDIO_URL,
    email: TEST_LOGIN_EMAIL,
    name: TEST_LOGIN_NAME,
    landingPath: '/',
  });
}

/**
 * Get an access token via the dev-login API endpoint.
 */
async function getToken(page: Page): Promise<string> {
  return getDevAccessToken(page, {
    baseUrl: STUDIO_URL,
    email: TEST_LOGIN_EMAIL,
    name: TEST_LOGIN_NAME,
  });
}

async function createProject(page: Page, token: string): Promise<string> {
  const tenantId = getTenantIdFromToken(token);
  const suffix = uniqueSuffix();
  const response = await page.request.post(`${STUDIO_URL}/api/projects`, {
    headers: {
      Authorization: `Bearer ${token}`,
      'X-Tenant-Id': tenantId,
      'Content-Type': 'application/json',
    },
    data: {
      name: `Attachment Settings ${suffix}`,
      slug: `attachment-settings-${suffix.replace(/_/g, '-')}`,
      description: 'Project created by attachment settings Playwright coverage',
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

async function deleteProject(page: Page, projectId: string, token: string): Promise<void> {
  const tenantId = getTenantIdFromToken(token);
  const response = await page.request.delete(`${STUDIO_URL}/api/projects/${projectId}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      'X-Tenant-Id': tenantId,
    },
  });
  expect(response.ok()).toBeTruthy();
}

/**
 * Reset all attachment config overrides to platform defaults (all nulls).
 */
async function resetConfig(page: Page, projectId: string, token: string): Promise<void> {
  const resp = await page.request.put(`${STUDIO_URL}/api/projects/${projectId}/attachment-config`, {
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    data: {
      enabled: null,
      maxFileSizeBytes: null,
      allowedMimeTypes: null,
      piiPolicy: null,
      defaultProcessingMode: null,
    },
  });
  expect(resp.ok()).toBeTruthy();
}

/**
 * Navigate to the attachment settings page and wait for it to load.
 */
async function navigateToAttachmentSettings(page: Page, projectId: string): Promise<void> {
  await page.goto(`${STUDIO_URL}/projects/${projectId}/settings/attachments`);
  await page.waitForLoadState('networkidle');
  // Wait for the page title to be visible
  await expect(page.getByText('Attachment Settings').first()).toBeVisible({ timeout: 10_000 });
}

// ─── Test Suite ───────────────────────────────────────────────────────────────

test.describe.serial('Attachment Settings Browser E2E', () => {
  test.setTimeout(120_000); // 2 min per test — settings page is fast

  let page: Page;
  let projectId: string;
  let token: string;

  test.beforeAll(async ({ browser }) => {
    page = await browser.newPage();
    await devLogin(page);
    token = await getToken(page);
    projectId = await createProject(page, token);
    // Reset config to clean slate (all defaults)
    await resetConfig(page, projectId, token);
  });
  // NOTE: page is kept OPEN and shared across all BRW tests.
  // Each test() uses the shared `page` variable, NOT the fixture { page }.
  // Cookies and localStorage persist across tests within the same BrowserContext.

  test.afterAll(async () => {
    if (page) {
      if (projectId && token) {
        await resetConfig(page, projectId, token);
        await deleteProject(page, projectId, token);
      }
      await page.close();
    }
  });

  // ─── BRW-1: Page load with resolved config ──────────────────────────────

  test('BRW-1: Navigate to Settings > Attachments, verify page loads with resolved config', async () => {
    await navigateToAttachmentSettings(page, projectId);

    // Verify all 6 field labels are visible
    await expect(page.getByText('Enable Attachments', { exact: true })).toBeVisible();
    await expect(page.getByText('Maximum File Size', { exact: true })).toBeVisible();
    await expect(page.getByText('Allowed File Types', { exact: true })).toBeVisible();
    await expect(page.getByText('PII Policy', { exact: true })).toBeVisible();
    await expect(page.getByText('Default Processing Mode', { exact: true })).toBeVisible();
    await expect(page.getByText('Max Files Per Session', { exact: true })).toBeVisible();

    // Verify the enabled toggle exists and is checked (platform default: true)
    await expect(page.getByRole('switch')).toHaveAttribute('aria-checked', 'true');

    // Verify PII policy shows "Redact" by default
    await expect(page.getByLabel('PII Policy')).toHaveValue('redact');

    // Verify Save button is visible but disabled (no changes)
    await expect(page.getByRole('button', { name: /Save/ })).toBeDisabled();
  });

  // ─── BRW-2: Override vs inherited indicators ────────────────────────────

  test('BRW-2: Override vs inherited indicators render correctly', async () => {
    // Precondition: Set piiPolicy override via API
    const seedResp = await page.request.put(
      `${STUDIO_URL}/api/projects/${projectId}/attachment-config`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        data: { piiPolicy: 'block' },
      },
    );
    expect(seedResp.ok()).toBeTruthy();

    await navigateToAttachmentSettings(page, projectId);

    await expect(page.getByText('Custom override')).toHaveCount(1);
    await expect(page.getByText('Inherited from defaults')).toHaveCount(5);
    await expect(page.getByLabel(/Reset.*to default/)).toHaveCount(1);

    // Cleanup: reset config via API
    await resetConfig(page, projectId, token);
  });

  // ─── BRW-3: Toggle, PII, file size — save-reload persistence ───────────

  test('BRW-3: Toggle enabled, change PII policy, change file size, save, reload, verify persistence', async () => {
    await navigateToAttachmentSettings(page, projectId);

    // Toggle enabled OFF
    await page.getByRole('switch').click();
    await expect(page.getByRole('switch')).toHaveAttribute('aria-checked', 'false');

    // Change PII policy to "Block"
    await page.getByLabel('PII Policy').selectOption('block');

    // Change max file size to 10 MB
    const fileSizeInput = page.getByLabel('Maximum File Size');
    await fileSizeInput.fill('10');

    // Verify Save button is now enabled
    await expect(page.getByRole('button', { name: /Save/ })).toBeEnabled();

    // Click Save
    await page.getByRole('button', { name: /Save/ }).click();

    // Wait for success toast
    await expect(page.getByText('Attachment settings saved')).toBeVisible({ timeout: 5_000 });

    // Reload the page
    await page.reload();
    await expect(page.getByText('Attachment Settings').first()).toBeVisible({ timeout: 10_000 });

    // Verify persisted values
    await expect(page.getByRole('switch')).toHaveAttribute('aria-checked', 'false');
    await expect(page.getByLabel('PII Policy')).toHaveValue('block');
    await expect(page.getByLabel('Maximum File Size')).toHaveValue('10');

    await expect(page.getByText('Custom override')).toHaveCount(3);
    await expect(page.getByText('Inherited from defaults')).toHaveCount(3);
    await expect(page.getByLabel(/Reset.*to default/)).toHaveCount(3);

    // Cleanup: reset config via API, reload
    await resetConfig(page, projectId, token);
    await page.reload();
    await expect(page.getByText('Attachment Settings').first()).toBeVisible({ timeout: 10_000 });
  });

  // ─── BRW-4: MIME type chip editor ───────────────────────────────────────

  test('BRW-4: MIME type chip editor: add valid, reject invalid, remove chip', async () => {
    await navigateToAttachmentSettings(page, projectId);

    const mimeInput = page.getByLabel('Add MIME type');

    // Add a valid MIME type
    await mimeInput.fill('application/json');
    await mimeInput.press('Enter');

    // Verify the chip appears
    await expect(page.getByText('application/json')).toBeVisible();

    // Verify the remove button exists
    await expect(page.getByLabel('Remove MIME type application/json')).toBeVisible();

    // Try an invalid MIME type
    await mimeInput.fill('not-a-mime');
    await mimeInput.press('Enter');

    // Verify error message appears
    await expect(page.getByText(/Invalid MIME type format/)).toBeVisible();

    // Verify "not-a-mime" chip does NOT appear
    await expect(
      page.locator('span').filter({ hasText: 'not-a-mime' }).locator('button'),
    ).not.toBeVisible();

    // Remove the valid chip
    await page.getByLabel('Remove MIME type application/json').click();

    // Verify the chip is gone
    await expect(page.getByLabel('Remove MIME type application/json')).not.toBeVisible();
  });

  // ─── BRW-5: Per-field reset to default ──────────────────────────────────

  test('BRW-5: Per-field reset to default: override → save → reset → save → verify inherited', async () => {
    // Set piiPolicy override via API
    const seedResp = await page.request.put(
      `${STUDIO_URL}/api/projects/${projectId}/attachment-config`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        data: { piiPolicy: 'block' },
      },
    );
    expect(seedResp.ok()).toBeTruthy();

    await navigateToAttachmentSettings(page, projectId);

    await expect(page.getByText('Custom override')).toHaveCount(1);
    await expect(page.getByLabel(/Reset.*to default/)).toHaveCount(1);

    // Verify PII Policy shows "Block"
    await expect(page.getByLabel('PII Policy')).toHaveValue('block');

    // Click the reset icon next to PII Policy
    await page.getByLabel(/Reset.*to default/).click();

    // Verify Save button is enabled (dirty state from reset)
    await expect(page.getByRole('button', { name: /Save/ })).toBeEnabled();

    // Click Save
    await page.getByRole('button', { name: /Save/ }).click();

    // Wait for success toast
    await expect(page.getByText('Attachment settings saved')).toBeVisible({ timeout: 5_000 });

    // Reload the page
    await page.reload();
    await expect(page.getByText('Attachment Settings').first()).toBeVisible({ timeout: 10_000 });

    // Verify PII Policy shows "Redact" (platform default)
    await expect(page.getByLabel('PII Policy')).toHaveValue('redact');

    await expect(page.getByText('Custom override')).toHaveCount(0);
    await expect(page.getByLabel(/Reset.*to default/)).toHaveCount(0);
    await expect(page.getByText('Inherited from defaults')).toHaveCount(6);
  });

  // ─── BRW-6: Save success toast ─────────────────────────────────────────

  test('BRW-6: Save success toast appears on save', async () => {
    await navigateToAttachmentSettings(page, projectId);

    // Change the processing mode dropdown to "Metadata Only"
    await page.getByLabel('Default Processing Mode').selectOption('metadata_only');

    // Click Save
    await page.getByRole('button', { name: /Save/ }).click();

    // Wait for toast notification
    await expect(page.getByText('Attachment settings saved')).toBeVisible({ timeout: 5_000 });

    // Cleanup: reset config via API
    await resetConfig(page, projectId, token);
  });
});
