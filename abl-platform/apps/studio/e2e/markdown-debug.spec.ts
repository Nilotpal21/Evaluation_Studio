/**
 * Debug: check what content the chat bubble actually receives.
 */

import { test, expect } from '@playwright/test';
import { isIsolatedSdkBrowserE2E } from './helpers/sdk-browser-env';

const STUDIO_URL = 'http://localhost:5173';

test.setTimeout(60_000);
test.skip(
  isIsolatedSdkBrowserE2E(),
  'This local markdown inspection smoke test depends on seeded manual data in the shared dev stack.',
);

test('debug markdown content', async ({ page }) => {
  const resp = await page.request.post(`${STUDIO_URL}/api/auth/dev-login`, {
    data: { email: 'dev@kore.ai', name: 'Developer' },
  });
  expect(resp.ok()).toBe(true);

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
  await page.getByText('New Chat').first().click();
  await page.waitForTimeout(5000);

  const chatInput = page.locator('textarea[placeholder*="message" i]').first();
  await expect(chatInput).toBeEnabled({ timeout: 15_000 });

  // Send a message
  await chatInput.fill('Say hello with a ## heading and a **bold** word');
  await chatInput.press('Enter');
  await page.waitForTimeout(10000);

  // Inspect the rendered HTML of the last assistant bubble
  const assistantBubbles = page.locator('[data-testid="message-list"] > div').last();
  const innerHTML = await assistantBubbles.innerHTML().catch(() => 'N/A');
  const innerText = await assistantBubbles.innerText().catch(() => 'N/A');

  console.log('=== BUBBLE INNER HTML (first 500 chars) ===');
  console.log(innerHTML.slice(0, 500));
  console.log('=== BUBBLE INNER TEXT (first 300 chars) ===');
  console.log(innerText.slice(0, 300));

  // Also check if there's a <pre> tag wrapping everything
  const hasPre = innerHTML.includes('<pre>');
  const hasH2 = innerHTML.includes('<h2>') || innerHTML.includes('<h3>');
  const hasStrong = innerHTML.includes('<strong>');
  console.log('Has <pre>:', hasPre, 'Has heading:', hasH2, 'Has <strong>:', hasStrong);

  await page.screenshot({ path: 'e2e/screenshots/md-debug.png' });
});
