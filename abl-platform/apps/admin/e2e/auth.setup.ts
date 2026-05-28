/**
 * Global auth setup — runs once before all tests.
 * Gets a JWT token via dev-login and saves the auth state for reuse.
 */
import { test as setup } from '@playwright/test';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const AUTH_FILE = join(__dirname, '..', '.auth', 'admin.json');

setup('authenticate as admin', async ({ page }) => {
  // Navigate to login page
  await page.goto('/login');
  await page.waitForLoadState('domcontentloaded');

  // Fill in email and submit
  const emailInput = page.locator('input[type="email"]');
  await emailInput.waitFor({ state: 'visible', timeout: 10_000 });
  await emailInput.fill('superadmin@platform.internal');
  await page.getByRole('button', { name: 'Dev Login' }).click();

  // Wait for redirect after successful login
  await page.waitForURL((url) => !url.toString().includes('/login'), { timeout: 20_000 });

  // Save storage state (cookies + localStorage)
  await page.context().storageState({ path: AUTH_FILE });
});
