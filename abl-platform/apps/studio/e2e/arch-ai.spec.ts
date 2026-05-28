import { test, expect, type Page } from '@playwright/test';
import { checkArchConversationPrerequisites } from './helpers/arch';
import { loginViaDevApi } from './helpers/auth';

const BASE_URL = process.env.STUDIO_URL ?? 'http://localhost:5173';
const ARCH_E2E_SMOKE_DOMAIN = '@e2e-smoke.test';

function buildLoginIdentity(prefix: string): { email: string; name: string } {
  const nonce = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  return {
    email: `${prefix}-${nonce}${ARCH_E2E_SMOKE_DOMAIN}`,
    name: 'Arch AI E2E',
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

test.describe('Arch AI smoke', () => {
  test('entry state renders the current hero, journey pills, chips, and input', async ({
    page,
  }) => {
    await loginAndGoToArch(page, 'arch-ai-entry');

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

    const input = page.getByTestId('chat-input-textarea');
    await expect(input).toBeVisible();
    await expect(input).toHaveAttribute('placeholder', 'Describe your project...');
    await expect(page.getByRole('button', { name: 'Send message' })).toBeDisabled();
  });

  test('typing enables send and clearing disables it again', async ({ page }) => {
    await loginAndGoToArch(page, 'arch-ai-compose');

    const input = page.getByTestId('chat-input-textarea');
    const sendButton = page.getByRole('button', { name: 'Send message' });

    await expect(sendButton).toBeDisabled();
    await input.fill('Help me build a routing assistant');
    await expect(sendButton).toBeEnabled();
    await input.fill('');
    await expect(sendButton).toBeDisabled();
  });

  test('clicking a use-case chip sends the live prompt and starts the interview flow', async ({
    page,
    request,
  }) => {
    const prerequisites = await checkArchConversationPrerequisites(request);
    if (!prerequisites.ok) {
      test.skip(true, prerequisites.reason);
    }

    await loginAndGoToArch(page, 'arch-ai-chip');

    await page.getByRole('button', { name: 'Automate customer support' }).click();
    await expect(page.getByText(/build a customer support agent for e-commerce/i)).toBeVisible({
      timeout: 10_000,
    });

    await page.waitForFunction(
      () => {
        const bodyText = document.body.innerText;
        return (
          bodyText.includes('Arch is working...') ||
          bodyText.includes('Something else...') ||
          bodyText.includes('Continue') ||
          Boolean(document.querySelector('[role="listbox"], [role="option"]'))
        );
      },
      { timeout: 30_000 },
    );
  });
});
