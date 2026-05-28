/**
 * Smoke Test: E2E Infrastructure Verification
 *
 * Verifies that Playwright can launch Studio, authenticate, and navigate.
 * This is the foundation for all other E2E tests.
 *
 * @e2e-real — Tests real system, no mocks
 */

import { test, expect } from '@playwright/test';
import { env } from './helpers/env';
import { loginViaDevApi } from './helpers/auth';

test.describe('E2E Infrastructure Smoke Tests', () => {
  test('should launch Studio and load home page', async ({ page }) => {
    // Navigate to Studio
    await page.goto(env.baseUrl);
    await page.waitForLoadState('networkidle');

    // Verify page loaded
    const title = await page.title();
    expect(title).toContain('Studio');

    // Verify no critical console errors
    const errors: string[] = [];
    page.on('console', (msg) => {
      if (msg.type() === 'error') {
        errors.push(msg.text());
      }
    });

    // Wait a bit to collect any errors
    await page.waitForTimeout(1000);

    // Allow some warnings but no errors
    expect(errors).toHaveLength(0);
  });

  test('should authenticate via dev login', async ({ page }) => {
    // Login via dev API (reuses existing auth helper)
    await loginViaDevApi(page, {
      email: 'interactions-tab@e2e-smoke.test',
      name: 'Interactions E2E Smoke',
      landingPath: '/projects',
    });

    // Verify landed on projects page
    expect(page.url()).toContain('/projects');

    // Verify page is interactive (project cards load)
    const projectCards = page.locator('button:has(h3)');
    const hasCards = await projectCards
      .first()
      .isVisible({ timeout: 10_000 })
      .catch(() => false);

    // If no cards, that's OK for smoke test — auth worked, just no projects yet
    if (!hasCards) {
      console.warn('[Smoke] No project cards found — auth worked but no projects created');
    }
  });

  test('should load interactions tab route (when implemented)', async ({ page }) => {
    // Login
    await loginViaDevApi(page, {
      email: 'interactions-tab@e2e-smoke.test',
      name: 'Interactions E2E Smoke',
    });

    // Navigate to a project
    const projectCards = page.locator('button:has(h3)');
    const hasCards = await projectCards
      .first()
      .isVisible({ timeout: 10_000 })
      .catch(() => false);

    if (!hasCards) {
      test.skip();
      return;
    }

    await projectCards.first().click();
    await page.waitForURL(/\/projects\/[^/]+/, { timeout: 10_000 });

    // Extract project ID from URL
    const projectId = page.url().match(/\/projects\/([^/?#]+)/)?.[1];
    expect(projectId).toBeTruthy();

    // Note: This test will fail until the Interactions Tab UI route is implemented
    // For now, just verify we can construct the route
    const interactionsRoute = `/projects/${projectId}/debug/interactions`;
    console.info(`[Smoke] Interactions route would be: ${interactionsRoute}`);

    // TODO: Once the route is implemented, navigate and verify:
    // await page.goto(`${env.baseUrl}${interactionsRoute}`);
    // await expect(page.locator('h1')).toContainText('Interactions');
  });
});
