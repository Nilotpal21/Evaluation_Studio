/**
 * Quick session check — click a specific session and verify it loads or shows error.
 */

import { test, expect } from '@playwright/test';
import { isIsolatedSdkBrowserE2E } from './helpers/sdk-browser-env';

const STUDIO_URL = process.env.TEST_BASE_URL || 'http://localhost:5173';
const DEV_EMAIL = process.env.TEST_LOGIN_EMAIL || 'ssk@kore.ai';
const TARGET_SESSION = 'd4253d75';

test.setTimeout(60_000);
test.skip(
  isIsolatedSdkBrowserE2E(),
  'This local session smoke test depends on seeded manual data in the shared dev stack.',
);

test('check session d4253d75 status', async ({ page }) => {
  // Login
  const resp = await page.request.post(`${STUDIO_URL}/api/auth/dev-login`, {
    data: { email: DEV_EMAIL, name: 'Session Checker' },
  });
  expect(resp.ok()).toBe(true);

  // Navigate to projects → weather App → Chat with Agent
  await page.goto(STUDIO_URL);
  await page.waitForLoadState('networkidle').catch(() => {});
  await page.waitForTimeout(2000);

  await page.getByText('weather App').first().click();
  await page.waitForTimeout(2000);

  await page.getByText('Agents').first().click();
  await page.waitForTimeout(2000);

  await page.locator('text=weather age').first().click();
  await page.waitForTimeout(2000);

  await page.getByText('Chat with Agent').click();
  await page.waitForTimeout(3000);
  await page.screenshot({ path: 'e2e/screenshots/check-01-session-list.png' });

  // Find and click the target session in the sidebar
  const sessionLink = page.locator(`text=${TARGET_SESSION}`).first();
  const found = await sessionLink.isVisible({ timeout: 5000 }).catch(() => false);

  if (!found) {
    console.log(`Session ${TARGET_SESSION} NOT visible in sidebar`);
    await page.screenshot({ path: 'e2e/screenshots/check-02-not-in-list.png' });

    // Try scrolling the sidebar to find it
    const sidebar = page.locator('.overflow-y-auto').first();
    await sidebar.evaluate((el) => (el.scrollTop = el.scrollHeight));
    await page.waitForTimeout(1000);
    await page.screenshot({ path: 'e2e/screenshots/check-02-scrolled.png' });

    const foundAfterScroll = await sessionLink.isVisible().catch(() => false);
    if (!foundAfterScroll) {
      console.log('Session not found even after scrolling — likely expired or cleared');
      return;
    }
  }

  console.log(`Session ${TARGET_SESSION} found in sidebar — clicking`);
  await sessionLink.click();
  await page.waitForTimeout(5000);
  await page.screenshot({ path: 'e2e/screenshots/check-03-session-loaded.png' });

  // Check what happened
  const pageText = await page.textContent('body');

  const hasExpired = pageText?.includes('expired') ?? false;
  const hasNotFound = pageText?.includes('not found') ?? false;
  const hasError = pageText?.includes('LLM client not configured') ?? false;
  const hasFailed = pageText?.includes('Failed to connect') ?? false;
  const hasMessages = pageText?.includes('Send a message') ?? false;

  console.log('Session state:', {
    expired: hasExpired,
    notFound: hasNotFound,
    llmError: hasError,
    connectionFailed: hasFailed,
    chatReady: hasMessages,
  });

  // Try sending a message if chat is ready
  const chatInput = page.locator('textarea[placeholder*="message" i]').first();
  const inputEnabled = await chatInput.isEnabled({ timeout: 3000 }).catch(() => false);

  if (inputEnabled) {
    console.log('Chat input enabled — sending test message');
    await chatInput.fill('Hello from session check');
    await chatInput.press('Enter');
    await page.waitForTimeout(8000);
    await page.screenshot({ path: 'e2e/screenshots/check-04-message-sent.png' });

    const responseText = await page.textContent('body');
    const gotResponse = responseText?.includes('weather') ?? false;
    console.log('Got agent response:', gotResponse);
  } else {
    console.log('Chat input disabled — session not active');
    await page.screenshot({ path: 'e2e/screenshots/check-04-input-disabled.png' });
  }
});
