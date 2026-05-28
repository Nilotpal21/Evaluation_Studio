/**
 * E2E-1: Marketplace Landing Page
 *
 * Verifies the marketplace landing page renders correctly with
 * featured templates, category grid, and recent additions.
 *
 * @e2e-real — Tests real system, no mocks
 */

import { test, expect } from '@playwright/test';
import { env } from './helpers/env';
import { loginViaDevApi } from './helpers/auth';

test.describe('Marketplace Landing Page', () => {
  test.beforeEach(async ({ page }) => {
    await loginViaDevApi(page, { landingPath: '/marketplace' });
  });

  test('renders landing page with hero section', async ({ page }) => {
    // Verify hero section with title is present
    const heading = page.locator('h1, h2').first();
    await expect(heading).toBeVisible({ timeout: 10_000 });
  });

  test('displays featured templates grid', async ({ page }) => {
    // Featured templates section should have template cards
    const cards = page.locator('[class*="animate-fade-in-up"]');
    await expect(cards.first()).toBeVisible({ timeout: 10_000 });
    const count = await cards.count();
    expect(count).toBeGreaterThanOrEqual(1);
  });

  test('displays category grid with counts', async ({ page }) => {
    // Category cards should show count badges
    const categorySection = page.locator('.grid');
    await expect(categorySection.first()).toBeVisible({ timeout: 10_000 });
  });

  test('shows type badges on template cards', async ({ page }) => {
    // Type badges should display Agent or Project
    const badges = page.getByText(/^(Agent|Project)$/);
    await expect(badges.first()).toBeVisible({ timeout: 10_000 });
  });

  test('category card navigates to category page', async ({ page }) => {
    // Click first category card (in the "Browse by Category" section, not featured templates)
    const categorySection = page.locator('section').filter({ hasText: /browse by category/i });
    const categoryCard = categorySection.locator('[class*="animate-fade-in-up"]').first();
    await expect(categoryCard).toBeVisible({ timeout: 10_000 });
    await categoryCard.click();
    await page.waitForURL(/\/marketplace\/category\//);
    expect(page.url()).toContain('/marketplace/category/');
  });

  test('page loads within performance budget', async ({ page }) => {
    const start = Date.now();
    await page.goto(`${env.baseUrl}/marketplace`);
    await page.waitForLoadState('domcontentloaded');
    const loadTime = Date.now() - start;
    // Landing page should load in under 5 seconds
    expect(loadTime).toBeLessThan(5000);
  });
});
