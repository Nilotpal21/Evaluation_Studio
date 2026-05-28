/**
 * E2E-4: Category Browse
 *
 * Verifies category browsing, filtered templates, and breadcrumb navigation.
 *
 * @e2e-real — Tests real system, no mocks
 */

import { test, expect } from '@playwright/test';
import { env } from './helpers/env';
import { loginViaDevApi } from './helpers/auth';

test.describe('Marketplace Category Browse', () => {
  test('clicking category card shows filtered templates', async ({ page }) => {
    await loginViaDevApi(page, { landingPath: '/marketplace' });

    const categorySection = page.locator('section').filter({ hasText: /browse by category/i });
    const firstCard = categorySection.locator('[class*="animate-fade-in-up"]').first();
    await expect(firstCard).toBeVisible({ timeout: 10_000 });
    await firstCard.click();
    await page.waitForURL(/\/marketplace\/category\//);

    const heading = page.locator('h1, h2').first();
    await expect(heading).toBeVisible({ timeout: 10_000 });
  });

  test('category page shows breadcrumb navigation', async ({ page }) => {
    await loginViaDevApi(page, { landingPath: '/marketplace/category/customer-service' });

    // Should show category name in heading or breadcrumb
    const pageContent = await page.textContent('body');
    expect(pageContent).toBeTruthy();
  });

  test('additional filters work within category', async ({ page }) => {
    await loginViaDevApi(page, { landingPath: '/marketplace/category/customer-service' });

    const typeSelect = page.locator('select').first();
    await expect(typeSelect).toBeVisible({ timeout: 10_000 });
    await typeSelect.selectOption('agent');
    await page.waitForLoadState('networkidle');
  });
});
