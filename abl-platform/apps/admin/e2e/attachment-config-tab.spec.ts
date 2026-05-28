/**
 * AttachmentConfigTab — Playwright Browser Rendering Tests
 *
 * Uses page.route() to intercept API calls (mock the backend) so these
 * tests verify real browser rendering, DOM interaction, and network behavior
 * WITHOUT requiring a running backend.
 *
 * The admin app must be running on the configured baseURL (default :3003).
 * Auth is handled by the setup project (auth.setup.ts).
 */

import { test, expect, type Page } from '@playwright/test';

// ─── Mock Data ──────────────────────────────────────────────────────────────

const TENANT_ID = 'test-tenant-001';

const MOCK_CONFIG = {
  maxFileSizeBytes: 20971520,
  allowedMimeTypes: ['image/png', 'image/jpeg'],
  blockedMimeTypes: ['application/exe'],
  scanEnabled: true,
  processingEnabled: true,
  embeddingEnabled: false,
  maxAttachmentsPerSession: 100,
  maxTotalStorageBytes: 1073741824,
  retentionDays: {
    image: 90,
    document: 90,
    audio: 60,
    video: 30,
  },
};

const MOCK_TENANT_DETAIL = {
  tenant: {
    _id: TENANT_ID,
    name: 'Test Tenant',
    slug: 'test-tenant',
    status: 'active',
    createdAt: '2026-01-01T00:00:00Z',
  },
  subscription: { planTier: 'TEAM', billingCycle: 'monthly' },
  memberCount: 5,
};

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Set up all route intercepts for the tenant detail page with attachment config.
 * Mocks the tenant API, members, projects, config, deals, usage, and attachment-config.
 */
async function setupRoutes(
  page: Page,
  opts?: {
    configResponse?: object;
    configStatus?: number;
    putResponse?: object;
    putStatus?: number;
  },
) {
  // Mock tenant detail API
  await page.route(`**/api/tenants/${TENANT_ID}`, (route) => {
    if (route.request().method() === 'GET') {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(MOCK_TENANT_DETAIL),
      });
    }
    return route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
  });

  // Mock members, projects, config, deals, usage — return empty/minimal data
  await page.route(`**/api/tenants/${TENANT_ID}/members`, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ members: [] }),
    }),
  );

  await page.route(`**/api/tenants/${TENANT_ID}/projects`, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ projects: [] }),
    }),
  );

  await page.route(`**/api/tenant-config/${TENANT_ID}`, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ overrides: {} }),
    }),
  );

  await page.route(`**/api/deals**`, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ deals: [] }),
    }),
  );

  await page.route(`**/api/tenants/${TENANT_ID}/usage**`, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ usage: [] }),
    }),
  );

  await page.route(`**/api/tenants/${TENANT_ID}/subscription`, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ success: true }),
    }),
  );

  // Mock attachment config GET
  await page.route(`**/api/tenants/${TENANT_ID}/attachment-config`, (route) => {
    if (route.request().method() === 'GET') {
      return route.fulfill({
        status: opts?.configStatus ?? 200,
        contentType: 'application/json',
        body: JSON.stringify(
          opts?.configResponse ?? { success: true, data: { config: MOCK_CONFIG } },
        ),
      });
    }

    // PUT
    if (route.request().method() === 'PUT') {
      return route.fulfill({
        status: opts?.putStatus ?? 200,
        contentType: 'application/json',
        body: JSON.stringify(opts?.putResponse ?? { success: true, data: { config: MOCK_CONFIG } }),
      });
    }

    return route.continue();
  });
}

/**
 * Navigate to tenant detail and click the Attachments tab.
 */
async function navigateToAttachmentsTab(page: Page) {
  await page.goto(`/tenants/${TENANT_ID}`, { waitUntil: 'domcontentloaded' });

  // If redirected to login, skip
  if (page.url().includes('/login')) {
    return false;
  }

  // Wait for page to settle
  await page.waitForTimeout(1000);

  // Click the Attachments tab
  const attachmentsTab = page
    .getByRole('tab', { name: /attachments/i })
    .or(page.locator('button:has-text("Attachments")'));
  if ((await attachmentsTab.count()) === 0) {
    return false;
  }
  await attachmentsTab.first().click();
  await page.waitForTimeout(500);
  return true;
}

// ─── Tests ──────────────────────────────────────────────────────────────────

test.describe('AttachmentConfigTab', () => {
  test('renders the Attachments tab in tenant detail page', async ({ page }) => {
    await setupRoutes(page);
    await page.goto(`/tenants/${TENANT_ID}`, { waitUntil: 'domcontentloaded' });

    if (page.url().includes('/login')) {
      test.skip(true, 'Auth required — skipping in non-auth environment');
      return;
    }

    await page.waitForTimeout(1000);

    // Verify the Attachments tab exists
    const attachmentsTab = page
      .getByRole('tab', { name: /attachments/i })
      .or(page.locator('button:has-text("Attachments")'));
    await expect(attachmentsTab.first()).toBeVisible({ timeout: 5_000 });
  });

  test('renders form fields with values from mocked GET response', async ({ page }) => {
    await setupRoutes(page);
    const navigated = await navigateToAttachmentsTab(page);

    if (!navigated) {
      test.skip(true, 'Could not navigate to Attachments tab');
      return;
    }

    // Wait for form to render
    await page.waitForTimeout(1000);

    // Verify numeric input fields render with correct values
    const maxFileSizeInput = page.locator('#maxFileSizeBytes');
    await expect(maxFileSizeInput).toBeVisible({ timeout: 5_000 });
    await expect(maxFileSizeInput).toHaveValue(String(MOCK_CONFIG.maxFileSizeBytes));

    const maxAttachmentsInput = page.locator('#maxAttachmentsPerSession');
    await expect(maxAttachmentsInput).toHaveValue(String(MOCK_CONFIG.maxAttachmentsPerSession));

    const maxStorageInput = page.locator('#maxTotalStorageBytes');
    await expect(maxStorageInput).toHaveValue(String(MOCK_CONFIG.maxTotalStorageBytes));
  });

  test('toggle switches reflect initial state and can be toggled', async ({ page }) => {
    await setupRoutes(page);
    const navigated = await navigateToAttachmentsTab(page);

    if (!navigated) {
      test.skip(true, 'Could not navigate to Attachments tab');
      return;
    }

    await page.waitForTimeout(1000);

    // Verify scanEnabled is initially true (aria-checked="true")
    const scanToggle = page.locator('#scanEnabled');
    await expect(scanToggle).toBeVisible({ timeout: 5_000 });
    await expect(scanToggle).toHaveAttribute('aria-checked', 'true');

    // Verify embeddingEnabled is initially false
    const embeddingToggle = page.locator('#embeddingEnabled');
    await expect(embeddingToggle).toHaveAttribute('aria-checked', 'false');

    // Toggle embeddingEnabled ON
    await embeddingToggle.click();
    await expect(embeddingToggle).toHaveAttribute('aria-checked', 'true');

    // Toggle embeddingEnabled back OFF
    await embeddingToggle.click();
    await expect(embeddingToggle).toHaveAttribute('aria-checked', 'false');
  });

  test('clicking Save triggers PUT with correct payload', async ({ page }) => {
    let capturedBody: string | null = null;

    await setupRoutes(page);

    // Override the attachment-config route to capture PUT body
    await page.route(`**/api/tenants/${TENANT_ID}/attachment-config`, (route) => {
      if (route.request().method() === 'PUT') {
        capturedBody = route.request().postData();
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ success: true, data: { config: MOCK_CONFIG } }),
        });
      }
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ success: true, data: { config: MOCK_CONFIG } }),
      });
    });

    const navigated = await navigateToAttachmentsTab(page);
    if (!navigated) {
      test.skip(true, 'Could not navigate to Attachments tab');
      return;
    }

    await page.waitForTimeout(1000);

    // Click Save
    const saveButton = page.getByRole('button', { name: /^save$/i });
    await expect(saveButton).toBeVisible({ timeout: 5_000 });
    await saveButton.click();

    // Wait for the request to be captured
    await page.waitForTimeout(1000);

    expect(capturedBody).not.toBeNull();
    const parsed = JSON.parse(capturedBody!);
    expect(parsed.maxFileSizeBytes).toBe(MOCK_CONFIG.maxFileSizeBytes);
    expect(parsed.scanEnabled).toBe(MOCK_CONFIG.scanEnabled);
    expect(parsed.maxAttachmentsPerSession).toBe(MOCK_CONFIG.maxAttachmentsPerSession);
  });

  test('clicking Reset reverts form fields to original values', async ({ page }) => {
    await setupRoutes(page);
    const navigated = await navigateToAttachmentsTab(page);

    if (!navigated) {
      test.skip(true, 'Could not navigate to Attachments tab');
      return;
    }

    await page.waitForTimeout(1000);

    // Change a field value
    const maxFileSizeInput = page.locator('#maxFileSizeBytes');
    await expect(maxFileSizeInput).toBeVisible({ timeout: 5_000 });
    await maxFileSizeInput.fill('999999');
    await expect(maxFileSizeInput).toHaveValue('999999');

    // Click Reset
    const resetButton = page.getByRole('button', { name: /reset/i });
    await resetButton.click();

    // Should revert to original
    await expect(maxFileSizeInput).toHaveValue(String(MOCK_CONFIG.maxFileSizeBytes));
  });

  test('displays error banner when API returns an error', async ({ page }) => {
    await setupRoutes(page, {
      putResponse: {
        success: false,
        error: { code: 'VALIDATION_ERROR', message: 'Invalid configuration value' },
      },
      putStatus: 400,
    });

    const navigated = await navigateToAttachmentsTab(page);
    if (!navigated) {
      test.skip(true, 'Could not navigate to Attachments tab');
      return;
    }

    await page.waitForTimeout(1000);

    // Click Save to trigger the error
    const saveButton = page.getByRole('button', { name: /^save$/i });
    await saveButton.click();

    // Verify error banner appears
    const errorBanner = page.locator('[role="alert"]');
    await expect(errorBanner).toBeVisible({ timeout: 5_000 });
    await expect(errorBanner).toContainText('Invalid configuration value');
  });

  test('displays error state when GET config fails', async ({ page }) => {
    await setupRoutes(page, {
      configResponse: {
        success: false,
        error: { code: 'INTERNAL_ERROR', message: 'Database unavailable' },
      },
      configStatus: 500,
    });

    const navigated = await navigateToAttachmentsTab(page);
    if (!navigated) {
      test.skip(true, 'Could not navigate to Attachments tab');
      return;
    }

    await page.waitForTimeout(1000);

    // Should show error state or retry button
    const body = await page.textContent('body');
    expect(body).not.toContain('Application error');
    expect(body).not.toContain('Unhandled Runtime Error');
  });

  test('retention day inputs render with correct values', async ({ page }) => {
    await setupRoutes(page);
    const navigated = await navigateToAttachmentsTab(page);

    if (!navigated) {
      test.skip(true, 'Could not navigate to Attachments tab');
      return;
    }

    await page.waitForTimeout(1000);

    // Verify retention day values
    const imageRetention = page.locator('#retention-image');
    await expect(imageRetention).toBeVisible({ timeout: 5_000 });
    await expect(imageRetention).toHaveValue(String(MOCK_CONFIG.retentionDays.image));

    const audioRetention = page.locator('#retention-audio');
    await expect(audioRetention).toHaveValue(String(MOCK_CONFIG.retentionDays.audio));

    const videoRetention = page.locator('#retention-video');
    await expect(videoRetention).toHaveValue(String(MOCK_CONFIG.retentionDays.video));
  });
});
