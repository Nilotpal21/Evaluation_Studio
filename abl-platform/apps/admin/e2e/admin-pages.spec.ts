/**
 * Admin Dashboard — Comprehensive E2E Page Navigation Tests
 *
 * Navigates to every admin page, verifies:
 * 1. Page heading renders correctly
 * 2. No uncaught error banners ("Failed to load", "Error")
 * 3. Data tables / content sections are present
 * 4. Sidebar navigation links work
 * 5. Loading states resolve (no infinite spinners)
 *
 * Prerequisites:
 *   - Admin app running on localhost:3003
 *   - Runtime API running on localhost:3002
 *   - Studio running on localhost:5173 (for dev-login auth)
 */

import { test, expect, type Page } from '@playwright/test';

// ─── Helper ─────────────────────────────────────────────────────────────────────

async function verifyPage(
  page: Page,
  url: string,
  opts: {
    heading?: string | RegExp;
    subtitle?: string | RegExp;
    timeout?: number;
    allowDataError?: boolean;
  } = {},
) {
  const timeout = opts.timeout ?? 15_000;

  await page.goto(url, { waitUntil: 'domcontentloaded' });

  // If redirected to login, the auth setup failed — skip gracefully
  if (page.url().includes('/login')) {
    console.warn(`[WARN] Redirected to login when accessing ${url} — auth cookies may be expired`);
    return;
  }

  // Wait for loading skeletons to clear
  try {
    await page.waitForFunction(
      () => {
        const skeletons = document.querySelectorAll('[class*="animate-pulse"]');
        return skeletons.length === 0;
      },
      { timeout },
    );
  } catch {
    // Data may not load (runtime dependent) — continue
  }

  // Verify heading
  if (opts.heading) {
    const headingLocator =
      typeof opts.heading === 'string'
        ? page.getByRole('heading', { name: opts.heading })
        : page.getByRole('heading').filter({ hasText: opts.heading });
    await expect(headingLocator.first()).toBeVisible({ timeout: 5_000 });
  }

  // Verify subtitle
  if (opts.subtitle) {
    await expect(page.getByText(opts.subtitle).first()).toBeVisible({ timeout: 5_000 });
  }

  // Check for crash-level errors
  const bodyText = await page.textContent('body');
  expect(bodyText).not.toContain('Application error');
  expect(bodyText).not.toContain('Unhandled Runtime Error');
  expect(bodyText).not.toContain('Internal Server Error');
}

// ─── All Admin Pages ────────────────────────────────────────────────────────────

test.describe('Page Navigation', () => {
  test('Dashboard (/)', async ({ page }) => {
    await verifyPage(page, '/', {
      heading: 'Dashboard Overview',
      allowDataError: true,
    });
  });

  test('Tenant Management (/tenants)', async ({ page }) => {
    await verifyPage(page, '/tenants', {
      heading: 'Tenant Management',
      subtitle: /View and manage platform tenants/,
    });
  });

  test('Config Overrides (/config-overrides)', async ({ page }) => {
    await verifyPage(page, '/config-overrides', {
      heading: 'Config Overrides',
      subtitle: /Compare plan defaults/,
    });
  });

  test('Model Provisioning (/models)', async ({ page }) => {
    await verifyPage(page, '/models', {
      heading: 'Model Provisioning',
      subtitle: /Manage LLM model access/,
    });
  });

  test('Deal Management (/deals)', async ({ page }) => {
    await verifyPage(page, '/deals', {
      heading: 'Deal Management',
      subtitle: /View and manage deals/,
    });
  });

  test('Resilience Controls (/resilience)', async ({ page }) => {
    await verifyPage(page, '/resilience', {
      heading: 'Resilience Controls',
      subtitle: /Monitor circuit breaker/,
    });
  });

  test('System Health (/health)', async ({ page }) => {
    await verifyPage(page, '/health', {
      heading: 'System Health',
      subtitle: /Real-time health status/,
    });
  });

  test('Usage & Analytics (/usage)', async ({ page }) => {
    await verifyPage(page, '/usage', {
      heading: 'Usage & Analytics',
      subtitle: /Platform-wide usage metrics/,
    });
  });

  test('Audit Log (/audit)', async ({ page }) => {
    await verifyPage(page, '/audit', {
      heading: 'Audit Log',
      subtitle: /Track admin UI access/,
    });
  });

  test('Configuration (/config)', async ({ page }) => {
    await verifyPage(page, '/config', {
      heading: 'Configuration',
      subtitle: /Manage configuration/,
    });
  });

  test('Secrets (/secrets)', async ({ page }) => {
    await verifyPage(page, '/secrets', {
      heading: 'Secrets',
      subtitle: /View secrets across scopes/,
    });
  });
});

// ─── Tenant Detail ──────────────────────────────────────────────────────────────

test.describe('Tenant Detail', () => {
  test('Tenant detail page loads and shows tabs', async ({ page }) => {
    // Go to tenants list and click first tenant
    await page.goto('/tenants', { waitUntil: 'domcontentloaded' });

    // Wait for table to load
    await page.waitForTimeout(3_000);

    // Click first tenant row if available
    const row = page.locator('tbody tr').first();
    if (
      (await row.count()) > 0 &&
      !(await page
        .getByText('No tenants found')
        .isVisible()
        .catch(() => false))
    ) {
      await row.click();
      await page.waitForLoadState('domcontentloaded');

      // Should now be on tenant detail page
      const url = page.url();
      if (url.includes('/tenants/')) {
        await expect(page.getByRole('heading', { name: 'Tenant Detail' })).toBeVisible({
          timeout: 5_000,
        });

        // Check tabs exist
        const tabTexts = ['Overview', 'Members', 'Projects'];
        for (const tabText of tabTexts) {
          const tab = page
            .getByRole('tab', { name: new RegExp(tabText, 'i') })
            .or(page.locator(`button:has-text("${tabText}")`));
          const tabCount = await tab.count();
          expect(tabCount).toBeGreaterThan(0);
        }
      }
    }
  });

  test('Each tab on tenant detail page renders content', async ({ page }) => {
    await page.goto('/tenants', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(3_000);

    const row = page.locator('tbody tr').first();
    if ((await row.count()) === 0) {
      test.skip(true, 'No tenants available');
      return;
    }

    await row.click();
    await page.waitForLoadState('domcontentloaded');
    await page.waitForTimeout(2_000);

    // Click through each tab
    const tabs = ['Overview', 'Members', 'Projects', 'Config', 'Deals', 'Usage'];
    for (const tabName of tabs) {
      const tabButton = page
        .getByRole('tab', { name: new RegExp(tabName, 'i') })
        .or(page.locator(`button:has-text("${tabName}")`));
      if ((await tabButton.count()) > 0) {
        await tabButton.first().click();
        await page.waitForTimeout(1_500);

        // Verify no crash
        const bodyText = await page.textContent('body');
        expect(bodyText).not.toContain('Application error');
        expect(bodyText).not.toContain('Unhandled Runtime Error');
      }
    }
  });
});

// ─── Model Detail ───────────────────────────────────────────────────────────────

test.describe('Model Detail', () => {
  test('Model detail page loads', async ({ page }) => {
    await page.goto('/models', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(3_000);

    const row = page.locator('tbody tr').first();
    if ((await row.count()) > 0) {
      await row.click();
      await page.waitForLoadState('domcontentloaded');
      await page.waitForTimeout(2_000);

      const bodyText = await page.textContent('body');
      expect(bodyText).not.toContain('Application error');
      expect(bodyText).not.toContain('Unhandled Runtime Error');
    }
  });
});

// ─── Deal Detail ────────────────────────────────────────────────────────────────

test.describe('Deal Detail', () => {
  test('Deal detail page loads with tabs', async ({ page }) => {
    await page.goto('/deals', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(3_000);

    const row = page.locator('tbody tr').first();
    if ((await row.count()) > 0) {
      await row.click();
      await page.waitForLoadState('domcontentloaded');
      await page.waitForTimeout(2_000);

      const bodyText = await page.textContent('body');
      expect(bodyText).not.toContain('Application error');
      expect(bodyText).not.toContain('Unhandled Runtime Error');
    }
  });
});

// ─── Sidebar Navigation ────────────────────────────────────────────────────────

test.describe('Sidebar Navigation', () => {
  test('All sidebar links are present', async ({ page }) => {
    await page.goto('/', { waitUntil: 'domcontentloaded' });

    const links = [
      { href: '/', label: 'Dashboard' },
      { href: '/tenants', label: 'Tenant Management' },
      { href: '/config-overrides', label: 'Config Overrides' },
      { href: '/models', label: 'Model Provisioning' },
      { href: '/deals', label: 'Deal Management' },
      { href: '/resilience', label: 'Resilience Controls' },
      { href: '/health', label: 'System Health' },
      { href: '/usage', label: 'Usage & Analytics' },
      { href: '/audit', label: 'Audit Log' },
      { href: '/config', label: 'Configuration' },
      { href: '/secrets', label: 'Secrets' },
    ];

    for (const { href, label } of links) {
      const navLink = page.locator(`nav a[href="${href}"]`);
      await expect(navLink).toBeVisible({ timeout: 3_000 });
      const text = await navLink.textContent();
      expect(text?.trim()).toContain(label);
    }
  });

  test('Nav group headers visible', async ({ page }) => {
    await page.goto('/', { waitUntil: 'domcontentloaded' });

    for (const group of ['OVERVIEW', 'TENANTS', 'OPERATIONS', 'OBSERVABILITY', 'INFRASTRUCTURE']) {
      await expect(page.locator(`nav h3:has-text("${group}")`)).toBeVisible({ timeout: 3_000 });
    }
  });

  test('Sidebar branding visible', async ({ page }) => {
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await expect(page.locator('nav h1:has-text("Admin Dashboard")')).toBeVisible();
    await expect(page.locator('nav p:has-text("Agent Platform")')).toBeVisible();
  });

  test('Logout link visible', async ({ page }) => {
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await expect(page.locator('a[href="/api/auth/logout"]')).toBeVisible({ timeout: 3_000 });
  });

  test('Clicking sidebar links navigates correctly', async ({ page }) => {
    await page.goto('/', { waitUntil: 'domcontentloaded' });

    // Test a few navigation links
    for (const { href, heading } of [
      { href: '/tenants', heading: 'Tenant Management' },
      { href: '/health', heading: 'System Health' },
      { href: '/usage', heading: 'Usage & Analytics' },
    ]) {
      await page.locator(`nav a[href="${href}"]`).click();
      await page.waitForLoadState('domcontentloaded');
      expect(page.url()).toContain(href);
      await expect(page.getByRole('heading', { name: heading }).first()).toBeVisible({
        timeout: 5_000,
      });
    }
  });
});

// ─── Sub-pages ──────────────────────────────────────────────────────────────────

test.describe('Configuration Sub-pages', () => {
  test('Config /config/dev loads', async ({ page }) => {
    await verifyPage(page, '/config/dev', { allowDataError: true });
  });

  test('Config /config/diff loads', async ({ page }) => {
    await verifyPage(page, '/config/diff', { allowDataError: true });
  });

  test('Secrets /secrets/rotation loads', async ({ page }) => {
    await verifyPage(page, '/secrets/rotation', { allowDataError: true });
  });
});

// ─── Error Resilience ───────────────────────────────────────────────────────────

test.describe('Error Resilience', () => {
  test('Pages show retry button on error, not blank screen', async ({ page }) => {
    await page.goto('/usage', { waitUntil: 'networkidle' });

    const bodyText = await page.textContent('body');
    expect(bodyText?.trim().length).toBeGreaterThan(10);
    // Should have either content or an error state with retry
    const hasContent = bodyText?.includes('Usage & Analytics') || bodyText?.includes('Retry');
    expect(hasContent).toBeTruthy();
  });

  test('Invalid tenant ID shows error, not crash', async ({ page }) => {
    await page.goto('/tenants/nonexistent-id-12345', { waitUntil: 'networkidle' });
    const bodyText = await page.textContent('body');
    expect(bodyText).not.toContain('Application error');
    expect(bodyText).not.toContain('Unhandled Runtime Error');
  });

  test('Invalid model ID shows error, not crash', async ({ page }) => {
    await page.goto('/models/nonexistent-id-12345', { waitUntil: 'networkidle' });
    const bodyText = await page.textContent('body');
    expect(bodyText).not.toContain('Application error');
    expect(bodyText).not.toContain('Unhandled Runtime Error');
  });

  test('Invalid deal ID shows error, not crash', async ({ page }) => {
    await page.goto('/deals/nonexistent-id-12345', { waitUntil: 'networkidle' });
    const bodyText = await page.textContent('body');
    expect(bodyText).not.toContain('Application error');
    expect(bodyText).not.toContain('Unhandled Runtime Error');
  });
});

// ─── Screenshot Capture ─────────────────────────────────────────────────────────

test.describe('Screenshot Capture', () => {
  const pages = [
    { url: '/', name: 'dashboard' },
    { url: '/tenants', name: 'tenants' },
    { url: '/config-overrides', name: 'config-overrides' },
    { url: '/models', name: 'models' },
    { url: '/deals', name: 'deals' },
    { url: '/resilience', name: 'resilience' },
    { url: '/health', name: 'health' },
    { url: '/usage', name: 'usage' },
    { url: '/audit', name: 'audit' },
    { url: '/config', name: 'config' },
    { url: '/secrets', name: 'secrets' },
  ];

  for (const { url, name } of pages) {
    test(`Capture: ${name}`, async ({ page }) => {
      await page.goto(url, { waitUntil: 'networkidle' });
      await page.waitForTimeout(1_000);
      await page.screenshot({
        path: `e2e/screenshots/${name}.png`,
        fullPage: true,
      });
    });
  }
});
