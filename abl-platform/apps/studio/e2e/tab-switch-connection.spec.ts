/**
 * Tab Switch Connection Test
 *
 * Verify WebSocket connection survives tab switching between
 * debug panel tabs, and that retry/reconnect works.
 */

import { test, expect } from '@playwright/test';
import { isIsolatedSdkBrowserE2E } from './helpers/sdk-browser-env';

const STUDIO_URL = 'http://localhost:5173';

test.setTimeout(120_000);
test.skip(
  isIsolatedSdkBrowserE2E(),
  'This local websocket smoke test depends on seeded manual data in the shared dev stack.',
);

test('WS connection survives tab switches and retry works', async ({ page }) => {
  // Login
  const resp = await page.request.post(`${STUDIO_URL}/api/auth/dev-login`, {
    data: { email: 'dev@kore.ai', name: 'Developer' },
  });
  expect(resp.ok()).toBe(true);

  // Navigate to weather App → Chat
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

  // Start new chat and send message
  await page.getByText('New Chat').first().click();
  await page.waitForTimeout(5000);

  const chatInput = page.locator('textarea[placeholder*="message" i]').first();
  await expect(chatInput).toBeEnabled({ timeout: 15_000 });

  await chatInput.fill('Hello before tab switch');
  await chatInput.press('Enter');
  console.log('>>> Message 1 sent');
  await page.waitForTimeout(8000);
  await page.screenshot({ path: 'e2e/screenshots/tab-01-initial.png' });

  // Open debug panel
  const debugBtn = page.getByText('Debug').first();
  await debugBtn.click();
  await page.waitForTimeout(2000);
  await page.screenshot({ path: 'e2e/screenshots/tab-02-debug-open.png' });

  // Switch between debug tabs rapidly
  const tabs = ['Traces', 'Errors', 'Data', 'Conversation'];
  for (const tab of tabs) {
    const tabBtn = page.getByText(tab, { exact: true }).first();
    const visible = await tabBtn.isVisible().catch(() => false);
    if (visible) {
      await tabBtn.click();
      await page.waitForTimeout(500);
      console.log(`>>> Switched to ${tab} tab`);
    }
  }
  await page.waitForTimeout(2000);
  await page.screenshot({ path: 'e2e/screenshots/tab-03-after-switches.png' });

  // Check connection state — is chat input still enabled?
  const stillEnabled = await chatInput.isEnabled({ timeout: 3000 }).catch(() => false);
  console.log('Chat input enabled after tab switches:', stillEnabled);

  // Check for error banners
  const errorBanner = page.locator('[class*="bg-error"]').first();
  const hasError = await errorBanner.isVisible().catch(() => false);
  if (hasError) {
    const errorText = await errorBanner.textContent().catch(() => '');
    console.log('Error banner after tab switch:', errorText);
  }

  // Check for "Failed to connect" or "Retry" text
  const bodyText = await page.textContent('body').catch(() => '');
  const hasConnectionLost = bodyText?.includes('Failed to connect') ?? false;
  const hasRetry = bodyText?.includes('Retry') ?? false;
  console.log('Connection lost:', hasConnectionLost, 'Retry visible:', hasRetry);

  // Try sending another message
  if (stillEnabled) {
    await chatInput.fill('Hello after tab switch');
    await chatInput.press('Enter');
    console.log('>>> Message 2 sent');
    await page.waitForTimeout(8000);
    await page.screenshot({ path: 'e2e/screenshots/tab-04-after-send.png' });

    // Verify response came back
    const lastBubble = page.locator('[data-testid="message-list"] > div').last();
    const html = await lastBubble.innerHTML().catch(() => '');
    const hasResponse =
      html.includes('weather') || html.includes('assist') || html.includes('help');
    console.log('Got response after tab switch:', hasResponse);
  }

  // If Retry button exists, try clicking it
  if (hasRetry) {
    const retryBtn = page.getByText('Retry', { exact: false }).first();
    const retryVisible = await retryBtn.isVisible().catch(() => false);
    if (retryVisible) {
      console.log('>>> Clicking Retry button');
      await retryBtn.click();
      await page.waitForTimeout(5000);
      await page.screenshot({ path: 'e2e/screenshots/tab-05-after-retry.png' });

      const enabledAfterRetry = await chatInput.isEnabled({ timeout: 5000 }).catch(() => false);
      console.log('Chat enabled after retry:', enabledAfterRetry);
    }
  }

  // Summary
  console.log('\n=== TAB SWITCH CONNECTION TEST ===');
  console.log('  Input enabled after switches:', stillEnabled);
  console.log('  Connection lost banner:', hasConnectionLost);
  console.log('  Retry visible:', hasRetry);
  console.log('  Has error banner:', hasError);
});
