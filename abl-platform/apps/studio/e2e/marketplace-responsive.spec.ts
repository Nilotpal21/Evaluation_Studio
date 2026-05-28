/**
 * E2E-5: Responsive Layout
 *
 * Verifies the marketplace adapts to mobile, tablet, and desktop viewports.
 *
 * @e2e-real — Tests real system, no mocks
 */

import { test, expect } from '@playwright/test';
import { env } from './helpers/env';
import { loginViaDevApi } from './helpers/auth';

test.describe('Marketplace Responsive Layout', () => {
  test('mobile viewport (375px) renders correctly', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await loginViaDevApi(page, { landingPath: '/marketplace' });

    // Page should render without horizontal scroll
    const bodyWidth = await page.evaluate(() => document.body.scrollWidth);
    expect(bodyWidth).toBeLessThanOrEqual(375 + 20); // Allow small tolerance

    // Template cards should be visible
    const cards = page.locator('[class*="animate-fade-in-up"]');
    await expect(cards.first()).toBeVisible({ timeout: 10_000 });
  });

  test('tablet viewport (768px) renders correctly', async ({ page }) => {
    await page.setViewportSize({ width: 768, height: 1024 });
    await loginViaDevApi(page, { landingPath: '/marketplace' });

    // Page should render
    const heading = page.locator('h1, h2').first();
    await expect(heading).toBeVisible({ timeout: 10_000 });
  });

  test('desktop viewport (1280px) renders correctly', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await loginViaDevApi(page, { landingPath: '/marketplace' });

    // Grid should use multi-column layout
    const grid = page.locator('.grid').first();
    await expect(grid).toBeVisible({ timeout: 10_000 });
  });

  test('mobile detail page renders correctly', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await loginViaDevApi(page, { landingPath: '/marketplace' });

    const card = page.locator('[class*="animate-fade-in-up"]').first();
    await expect(card).toBeVisible({ timeout: 10_000 });
    await card.click();
    await page.waitForURL(/\/marketplace\/templates\//);

    const heading = page.locator('h1, h2').first();
    await expect(heading).toBeVisible({ timeout: 10_000 });
  });
});
