import { expect, test, type Page } from '@playwright/test';
import { loginViaDevApi } from './helpers';
import { getSdkBrowserStudioBaseUrl } from './helpers/sdk-browser-env';

const STUDIO_URL = getSdkBrowserStudioBaseUrl();
const TEST_LOGIN_EMAIL = 'workspace-menu@e2e-smoke.test';
const TEST_LOGIN_NAME = 'Workspace Menu E2E';

async function openUserMenu(page: Page): Promise<void> {
  const userMenuTrigger = page.getByTestId('user-menu-trigger');
  await expect(userMenuTrigger).toBeVisible();
  await userMenuTrigger.click();
  await expect(page.getByTestId('user-menu-dropdown')).toBeVisible();
}

test('user menu exposes create workspace from the workspace switcher', async ({ page }) => {
  await loginViaDevApi(page, {
    baseUrl: STUDIO_URL,
    email: TEST_LOGIN_EMAIL,
    name: TEST_LOGIN_NAME,
    landingPath: '/',
  });

  await openUserMenu(page);
  await page.getByTestId('user-menu-workspace-toggle').click();
  await expect(page.getByTestId('user-menu-create-workspace')).toBeVisible();

  await page.getByTestId('user-menu-create-workspace').click();
  await expect(page).toHaveURL(/\/onboarding/);
});
