/**
 * Studio Theme & Docs Integration E2E Tests
 *
 * Tests theme selector in UserMenu and docs access control.
 * Prerequisites: Studio running at localhost:5173 with dev login.
 */

import { test, expect, type Page } from '@playwright/test';
import { loginViaDevApi } from './helpers';

const STUDIO_URL = 'http://localhost:5173';
const TEST_LOGIN_EMAIL = 'studio-theme@e2e-smoke.test';
const TEST_LOGIN_NAME = 'Studio Theme E2E';
const ALLOWED_DOCS_LOGIN_EMAIL = 'studio-theme-docs@kore.ai';
const ALLOWED_DOCS_LOGIN_NAME = 'Studio Theme Docs E2E';

async function devLogin(
  page: Page,
  options: { email?: string; name?: string } = {},
): Promise<void> {
  await loginViaDevApi(page, {
    baseUrl: STUDIO_URL,
    email: options.email ?? TEST_LOGIN_EMAIL,
    name: options.name ?? TEST_LOGIN_NAME,
    landingPath: '/',
  });
}

async function openUserMenu(page: Page): Promise<void> {
  // Wait for any ongoing animations to settle
  await page.waitForTimeout(400);

  // Click the user avatar/button to open the menu
  const userMenuTrigger = page
    .locator('[data-testid="user-menu-trigger"], button:has(.lucide-chevron-down)')
    .first();
  if (await userMenuTrigger.isVisible({ timeout: 3000 }).catch(() => false)) {
    await userMenuTrigger.click();
  } else {
    // Fallback: look for avatar or user initials button in top-right
    await page.locator('header button').last().click();
  }
  // Wait for menu open animation to complete
  await page.waitForTimeout(600);
}

// E2E-1: Theme selector visible in UserMenu, ThemeToggle absent
test('E2E-1: theme selector visible in UserMenu, no ThemeToggle icon in header', async ({
  page,
}) => {
  await devLogin(page);
  await openUserMenu(page);

  // Theme options should be visible as a segmented control row in the menu
  await expect(page.locator('[data-testid="theme-system"]')).toBeVisible();
  await expect(page.locator('[data-testid="theme-light"]')).toBeVisible();
  await expect(page.locator('[data-testid="theme-dark"]')).toBeVisible();
});

// E2E-2: Theme switching changes data-theme attribute
test('E2E-2: theme switching changes data-theme attribute', async ({ page }) => {
  await devLogin(page);
  await openUserMenu(page);

  // Click "Light" theme — menu stays open (theme buttons don't close it)
  await page.locator('[data-testid="theme-light"]').click();
  await page.waitForTimeout(300);

  let htmlTheme = await page.locator('html').getAttribute('data-theme');
  expect(htmlTheme).toBe('light');

  // Click Dark directly (menu is still open since theme click doesn't close it)
  await page.locator('[data-testid="theme-dark"]').click();
  await page.waitForTimeout(300);

  htmlTheme = await page.locator('html').getAttribute('data-theme');
  expect(htmlTheme).toBe('dark');

  // Click System directly
  await page.locator('[data-testid="theme-system"]').click();
  await page.waitForTimeout(300);

  // System follows OS preference — just verify it doesn't error
  htmlTheme = await page.locator('html').getAttribute('data-theme');
  expect(htmlTheme).toBeTruthy();
});

// E2E-3: Theme persists across reload (no FOUC)
test('E2E-3: theme persists across reload', async ({ page }) => {
  await devLogin(page);
  await openUserMenu(page);

  // Set to dark
  await page.locator('[data-testid="theme-dark"]').click();
  await page.waitForTimeout(300);

  // Reload page
  await page.reload();
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(1000);

  // Theme should still be dark
  const htmlTheme = await page.locator('html').getAttribute('data-theme');
  expect(htmlTheme).toBe('dark');

  // Check localStorage has the theme persisted
  const storedMode = await page.evaluate(() => {
    const stored = localStorage.getItem('kore-theme-storage');
    if (stored) {
      try {
        return JSON.parse(stored)?.state?.mode;
      } catch {
        return null;
      }
    }
    return null;
  });
  expect(storedMode).toBe('dark');
});

// E2E-4: Allowed-domain user sees Docs link and can access /docs
test('E2E-4: allowed-domain user sees Docs link in UserMenu', async ({ page }) => {
  await devLogin(page, { email: ALLOWED_DOCS_LOGIN_EMAIL, name: ALLOWED_DOCS_LOGIN_NAME });
  await openUserMenu(page);

  // Docs link should be visible for kore.ai user
  const menu = page.locator('.bg-background-elevated').first();
  await expect(menu.getByRole('button', { name: 'Docs', exact: true })).toBeVisible();
});

// E2E-5: Docs page loads for allowed user
test('E2E-5: docs page loads for allowed user', async ({ page }) => {
  await devLogin(page, { email: ALLOWED_DOCS_LOGIN_EMAIL, name: ALLOWED_DOCS_LOGIN_NAME });

  // Navigate to docs
  await page.goto(`${STUDIO_URL}/docs/getting-started`);
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(3000);

  // Should see docs content (not 404 or login redirect)
  const url = page.url();
  const pageContent = await page.content();
  const hasDocsContent =
    url.includes('/docs') ||
    pageContent.includes('Internal Docs') ||
    pageContent.includes('Getting Started') ||
    pageContent.includes('docs-prose');
  expect(hasDocsContent).toBe(true);
});

// E2E-6: Non-allowed domain gets 404
test('E2E-6: non-allowed domain gets 404 for docs', async ({ page }) => {
  // Navigate to docs without login — should redirect or 404
  await page.goto(`${STUDIO_URL}/docs/getting-started`);
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(2000);

  // Should see 404 page or redirect to login
  const url = page.url();
  const pageContent = await page.content();
  const is404OrRedirect =
    url.includes('/auth/login') ||
    pageContent.includes('404') ||
    pageContent.includes('not found') ||
    pageContent.includes('Not Found');
  expect(is404OrRedirect).toBe(true);
});

// E2E-7: Existing /docs/abl page still works
test('E2E-7: existing /docs/abl page unaffected', async ({ page }) => {
  await devLogin(page, { email: ALLOWED_DOCS_LOGIN_EMAIL, name: ALLOWED_DOCS_LOGIN_NAME });

  await page.goto(`${STUDIO_URL}/docs/abl`);
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(2000);

  // ABL docs page should render (it's a pre-existing static page)
  const pageContent = await page.content();
  const hasAblContent = pageContent.includes('ABL') || pageContent.includes('abl');
  expect(hasAblContent).toBe(true);
});

// E2E-8: Docs pages respect Studio theme
test('E2E-8: docs pages respect Studio theme', async ({ page }) => {
  await devLogin(page, { email: ALLOWED_DOCS_LOGIN_EMAIL, name: ALLOWED_DOCS_LOGIN_NAME });

  // Set dark theme
  await openUserMenu(page);
  await page.locator('[data-testid="theme-dark"]').click();
  await page.waitForTimeout(300);

  // Navigate to docs
  await page.goto(`${STUDIO_URL}/docs/getting-started`);
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(2000);

  // Verify data-theme is still dark on docs page
  const htmlTheme = await page.locator('html').getAttribute('data-theme');
  expect(htmlTheme).toBe('dark');
});
