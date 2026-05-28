import { test, expect, type Page } from '@playwright/test';
import { loginViaDevApi } from './helpers/auth';

const BASE_URL = process.env.STUDIO_URL ?? 'http://localhost:5173';
const ARCH_E2E_SMOKE_DOMAIN = '@e2e-smoke.test';

function buildLoginIdentity(prefix: string): { email: string; name: string } {
  const nonce = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  return {
    email: `${prefix}-${nonce}${ARCH_E2E_SMOKE_DOMAIN}`,
    name: 'Arch UX E2E',
  };
}

async function loginAndGoToArch(page: Page, prefix: string): Promise<void> {
  const identity = buildLoginIdentity(prefix);
  await loginViaDevApi(page, {
    baseUrl: BASE_URL,
    email: identity.email,
    name: identity.name,
    landingPath: '/arch',
  });
  await page.waitForLoadState('networkidle').catch(() => {});
  await page.waitForTimeout(2_000);
}

test.describe('Arch UX polish', () => {
  test('entry state shows the current hero, chips, and input affordances', async ({ page }) => {
    await loginAndGoToArch(page, 'arch-ux-entry');

    await expect(page.getByRole('heading', { name: /hi, i'm arch/i })).toBeVisible({
      timeout: 15_000,
    });
    await expect(page.getByText(/tell me what you want to build/i)).toBeVisible();
    await expect(page.getByText('Interview', { exact: true })).toBeVisible();
    await expect(page.getByText('Blueprint', { exact: true })).toBeVisible();
    await expect(page.getByText('Build', { exact: true })).toBeVisible();
    await expect(page.getByText('What do you want to automate?')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Automate customer support' })).toBeVisible();
    await expect(
      page.getByRole('button', { name: 'Let customers book appointments' }),
    ).toBeVisible();
    await expect(page.getByRole('button', { name: 'Qualify leads before sales' })).toBeVisible();
    await expect(page.getByTestId('chat-input-textarea')).toBeVisible();
  });

  test('rendered HTML avoids hardcoded numbered palette classes', async ({ page }) => {
    await loginAndGoToArch(page, 'arch-ux-colors');
    await expect(page.getByRole('heading', { name: /hi, i'm arch/i })).toBeVisible({
      timeout: 15_000,
    });

    const html = await page.content();
    const violations = [
      /class="[^"]*bg-purple-\d/,
      /class="[^"]*text-purple-\d/,
      /class="[^"]*border-purple-\d/,
      /class="[^"]*bg-red-\d/,
      /class="[^"]*text-red-\d/,
      /class="[^"]*bg-green-\d/,
      /class="[^"]*text-green-\d/,
      /class="[^"]*bg-amber-\d/,
    ];

    for (const pattern of violations) {
      expect(html, `Found hardcoded color: ${pattern}`).not.toMatch(pattern);
    }
  });

  test('no JavaScript errors are thrown on entry-state load', async ({ page }) => {
    const jsErrors: string[] = [];
    page.on('pageerror', (error) => {
      jsErrors.push(error.message);
    });

    await loginAndGoToArch(page, 'arch-ux-errors');
    await expect(page.getByRole('heading', { name: /hi, i'm arch/i })).toBeVisible({
      timeout: 15_000,
    });
    await page.waitForTimeout(1_000);

    const relevantErrors = jsErrors.filter(
      (message) =>
        !message.includes('net::ERR') &&
        !message.includes('Failed to fetch') &&
        !message.includes('NetworkError') &&
        !message.includes('AbortError'),
    );
    expect(relevantErrors, `JS errors found: ${relevantErrors.join(', ')}`).toHaveLength(0);
  });

  test('chip buttons and chat input are keyboard accessible', async ({ page }) => {
    await loginAndGoToArch(page, 'arch-ux-a11y');

    const chip = page.getByRole('button', { name: 'Automate customer support' });
    await chip.focus();
    await expect(chip).toBeFocused();

    const input = page.getByTestId('chat-input-textarea');
    await input.focus();
    await expect(input).toBeFocused();
  });

  test('page loads within five seconds after auth', async ({ page }) => {
    await loginViaDevApi(page, {
      baseUrl: BASE_URL,
      ...buildLoginIdentity('arch-ux-speed'),
      landingPath: '/projects',
    });

    const startedAt = Date.now();
    await page.goto(`${BASE_URL}/arch`);
    await expect(page.getByRole('heading', { name: /hi, i'm arch/i })).toBeVisible({
      timeout: 10_000,
    });

    expect(Date.now() - startedAt).toBeLessThan(5_000);
  });
});
