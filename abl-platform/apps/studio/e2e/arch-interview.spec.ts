import { test, expect, type Page } from '@playwright/test';
import { checkArchConversationPrerequisites } from './helpers/arch';
import { loginViaDevApi } from './helpers/auth';

/**
 * Arch AI — E2E smoke test suite
 *
 * Validates the INTERVIEW flow end-to-end against a running dev server.
 *
 * Prerequisites:
 *   - Studio running (PM2 or pnpm dev)
 *   - Runtime on port 3112 with a valid LLM model configured
 *   - MongoDB + Redis available
 *
 * Run:
 *   pnpm --filter @agent-platform/studio exec playwright test e2e/arch-interview.spec.ts
 *
 * To run headed (watch mode):
 *   pnpm --filter @agent-platform/studio exec playwright test e2e/arch-interview.spec.ts --headed
 */

const BASE_URL = process.env.STUDIO_URL ?? 'http://localhost:5173';
const TEST_LOGIN_EMAIL = 'arch-ai-e2e@e2e-smoke.test';
const TEST_LOGIN_NAME = 'Arch AI E2E';

/** Login and navigate to the /arch page. Waits for the hero or messages to load. */
async function loginAndGoToArch(page: Page): Promise<void> {
  await loginViaDevApi(page, {
    baseUrl: BASE_URL,
    email: TEST_LOGIN_EMAIL,
    name: TEST_LOGIN_NAME,
    landingPath: '/arch',
  });
  // Wait for the page to settle — either the entry hero or existing messages.
  await page.waitForLoadState('networkidle').catch(() => {});
  await page.waitForTimeout(2_000);
}

/**
 * If a prior session exists, dismiss it to get a clean slate.
 * Looks for "Start Fresh" or "Dismiss" and clicks if visible.
 */
async function dismissExistingSession(page: Page): Promise<void> {
  // The session resume card has "Start Fresh" / "Dismiss" buttons.
  // Also check for the "New chat" button in compact header.
  const newChatBtn = page.locator('button', { hasText: /new chat/i });
  const isNewChat = await newChatBtn.isVisible({ timeout: 3_000 }).catch(() => false);
  if (isNewChat) {
    await newChatBtn.click();
    // Confirm the "Start fresh" dialog if it appears
    const confirmBtn = page.locator('button', { hasText: /start fresh|confirm|yes/i });
    const hasConfirm = await confirmBtn.isVisible({ timeout: 3_000 }).catch(() => false);
    if (hasConfirm) {
      await confirmBtn.click();
    }
    await page.waitForTimeout(2_000);
    return;
  }

  // Alternative: dismiss resume card
  const dismissBtn = page.locator('button', { hasText: /dismiss|start fresh/i });
  const hasDismiss = await dismissBtn.isVisible({ timeout: 2_000 }).catch(() => false);
  if (hasDismiss) {
    await dismissBtn.click();
    await page.waitForTimeout(2_000);
  }
}

test.describe('Arch AI — INTERVIEW flow @arch-ai', () => {
  // All tests need generous timeouts — LLM responses can take 30-60s.
  test.setTimeout(120_000);

  test('entry state renders hero, chips, and input bar', async ({ page }) => {
    await loginAndGoToArch(page);
    await dismissExistingSession(page);

    // Hero: "Hi, I'm Arch" heading
    await expect(page.getByRole('heading', { name: /Arch/i })).toBeVisible({ timeout: 15_000 });

    // Tagline
    await expect(page.getByText(/Tell me what you want to build/i)).toBeVisible();

    // Use-case chips
    await expect(page.getByRole('button', { name: /automate customer support/i })).toBeVisible();
    await expect(
      page.getByRole('button', { name: /let customers book appointments/i }),
    ).toBeVisible();
    await expect(page.getByRole('button', { name: /qualify leads before sales/i })).toBeVisible();

    // Chat input textarea
    const input = page.getByTestId('chat-input-textarea');
    await expect(input).toBeVisible();
    await expect(input).toHaveAttribute('placeholder', 'Describe your project...');
  });

  test('user sends message and receives streamed assistant response', async ({ page }) => {
    const prerequisites = await checkArchConversationPrerequisites(page.request);
    if (!prerequisites.ok) {
      test.skip(true, prerequisites.reason);
    }

    await loginAndGoToArch(page);
    await dismissExistingSession(page);

    // Ensure we see the entry state
    await expect(page.getByRole('heading', { name: /Arch/i })).toBeVisible({ timeout: 15_000 });

    // Type and send a message
    const input = page.getByTestId('chat-input-textarea');
    await input.fill('I want to build a customer support agent for e-commerce');
    await input.press('Enter');

    // User message bubble should appear
    await expect(
      page.getByText('I want to build a customer support agent for e-commerce'),
    ).toBeVisible({
      timeout: 10_000,
    });

    // Wait for streaming to begin — either "Arch is working..." indicator or actual content
    const streamingOrContent = page
      .locator('text=/Arch is working|specialist|support|customer|commerce/i')
      .first();
    await expect(streamingOrContent).toBeVisible({ timeout: 30_000 });

    // Wait for streaming to finish — the "Arch is working..." text should disappear
    // and we should see substantive assistant content or a widget (ask_user).
    await page.waitForFunction(
      () => {
        const working = document.body.textContent?.includes('Arch is working...');
        const hasContent =
          document.querySelectorAll('p, [role="listbox"], [role="option"]').length > 3;
        return !working && hasContent;
      },
      { timeout: 90_000 },
    );

    // After streaming completes, there should be assistant content visible
    // (either markdown text or an interactive widget like single_select/multi_select)
    const hasWidget = await page
      .locator('[role="listbox"]')
      .isVisible()
      .catch(() => false);
    const hasMarkdown = await page.locator('p').count();

    expect(hasWidget || hasMarkdown > 2, 'Expected assistant response content').toBeTruthy();
  });

  test('clicking a use-case chip sends the prompt and triggers streaming', async ({ page }) => {
    const prerequisites = await checkArchConversationPrerequisites(page.request);
    if (!prerequisites.ok) {
      test.skip(true, prerequisites.reason);
    }

    await loginAndGoToArch(page);
    await dismissExistingSession(page);

    await expect(page.getByRole('heading', { name: /Arch/i })).toBeVisible({ timeout: 15_000 });

    // Click "Automate customer support" chip
    await page.getByRole('button', { name: /automate customer support/i }).click();

    // The chip's chatPrompt is "Build a customer support agent for e-commerce"
    // User message should appear
    await expect(page.getByText(/build a customer support agent for e-commerce/i)).toBeVisible({
      timeout: 10_000,
    });

    // Streaming should start
    const streamingIndicator = page.getByText('Arch is working...');
    await expect(streamingIndicator).toBeVisible({ timeout: 20_000 });

    // Wait for streaming to complete — content should appear
    await page.waitForFunction(() => !document.body.textContent?.includes('Arch is working...'), {
      timeout: 90_000,
    });

    // Verify we transitioned to the messages view (compact header with phase badge)
    const phaseIndicator = page.locator('text=/INTERVIEW/i');
    await expect(phaseIndicator).toBeVisible({ timeout: 5_000 });
  });

  test('no JavaScript errors on entry state load', async ({ page }) => {
    const jsErrors: string[] = [];
    page.on('pageerror', (error) => {
      jsErrors.push(error.message);
    });

    await loginAndGoToArch(page);
    await dismissExistingSession(page);
    await expect(page.getByRole('heading', { name: /Arch/i })).toBeVisible({ timeout: 15_000 });
    await page.waitForTimeout(1_500);

    // Filter out known non-issues (network errors, cancelled requests)
    const relevantErrors = jsErrors.filter(
      (e) =>
        !e.includes('net::ERR') &&
        !e.includes('Failed to fetch') &&
        !e.includes('NetworkError') &&
        !e.includes('AbortError') &&
        !e.includes('signal is aborted'),
    );
    expect(relevantErrors, `JS errors found: ${relevantErrors.join(', ')}`).toHaveLength(0);
  });

  // ── Deferred edge-case tests ─────────────────────────────────────────────
  // These require infrastructure that goes beyond happy-path: reconnect
  // simulation, multi-tab sync, cancel timing. Marked .fixme so they show
  // in the Playwright report but don't block CI.

  test.fixme('reload restores session with pending widget', async () => {
    // After a message exchange, reload page. The session resume card should
    // appear, and clicking "Continue" should restore the conversation state
    // including any pending ask_user widget.
  });

  test.fixme('cancel button stops in-flight streaming turn', async () => {
    // Send a message, wait for streaming indicator, click Stop. Verify
    // the streaming indicator disappears and the input re-enables.
  });

  test.fixme('multi-tab convergence: same session in two tabs', async () => {
    // Open /arch in two browser contexts with the same auth. Send a message
    // in tab A. Reload tab B. Verify tab B sees the same messages.
  });

  test.fixme('reconnect replay: SSE drop recovery', async () => {
    // Start streaming, kill the SSE connection (e.g., page.route to abort),
    // wait for reconnect, verify state eventually matches a clean run.
  });
});
