/**
 * Click through all visible sessions in the chat sidebar and check UI state.
 */

import { test, expect } from '@playwright/test';
import { isIsolatedSdkBrowserE2E } from './helpers/sdk-browser-env';

const STUDIO_URL = process.env.TEST_BASE_URL || 'http://localhost:5173';
const DEV_EMAIL = process.env.TEST_LOGIN_EMAIL || 'ssk@kore.ai';

test.setTimeout(180_000);
test.skip(
  isIsolatedSdkBrowserE2E(),
  'This local clickthrough smoke test depends on seeded manual data in the shared dev stack.',
);

test('click all sessions and verify UI state', async ({ page }) => {
  // Login
  const resp = await page.request.post(`${STUDIO_URL}/api/auth/dev-login`, {
    data: { email: DEV_EMAIL, name: 'Session Clicker' },
  });
  expect(resp.ok()).toBe(true);

  // Navigate to weather App → Agents → weather agent → Chat with Agent
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
  await page.waitForTimeout(4000);

  // First create a fresh session so we're in the chat view
  await page.getByText('New Chat').first().click();
  await page.waitForTimeout(5000);
  await page.screenshot({ path: 'e2e/screenshots/click-all-00-chat-view.png' });

  // Now collect session items from the sidebar (w-56 panel on the left)
  // Session items have font-mono text with 8-char hex IDs
  const sessionItems = page.locator('button:has(span.font-mono)');
  const count = await sessionItems.count();
  console.log(`Found ${count} sessions in chat sidebar`);

  if (count === 0) {
    console.log('No sessions found — skipping');
    return;
  }

  const results: Array<{ id: string; status: string }> = [];
  const maxSessions = Math.min(count, 10);

  for (let i = 0; i < maxSessions; i++) {
    const btn = sessionItems.nth(i);
    const idSpan = btn.locator('span.font-mono').first();
    const sessionId = (await idSpan.textContent().catch(() => '')) || `idx-${i}`;

    console.log(`[${i + 1}/${maxSessions}] Clicking session ${sessionId}...`);
    await btn.click();
    await page.waitForTimeout(3000);

    // Determine state
    const errorBanner = page.locator('[class*="bg-error"]').first();
    const hasError = await errorBanner.isVisible().catch(() => false);
    const errorText = hasError ? (await errorBanner.textContent().catch(() => '')) || '' : '';

    const chatInput = page.locator('textarea[placeholder*="message" i]').first();
    const inputEnabled = await chatInput.isEnabled({ timeout: 1500 }).catch(() => false);

    const bodyText = (await page.textContent('body').catch(() => '')) || '';
    const hasExpired = bodyText.includes('Session expired');

    let status: string;
    if (hasExpired) status = 'EXPIRED';
    else if (hasError) status = `ERROR: ${errorText.slice(0, 50)}`;
    else if (inputEnabled) status = 'OK (chat ready)';
    else status = 'LOADING/DISABLED';

    results.push({ id: sessionId.trim(), status });
    console.log(`  → ${status}`);

    await page.screenshot({
      path: `e2e/screenshots/click-all-${String(i + 1).padStart(2, '0')}-${sessionId.trim().slice(0, 8)}.png`,
    });
  }

  console.log('\n=== SESSION SUMMARY ===');
  for (const r of results) {
    const icon = r.status.startsWith('OK') ? '✅' : r.status === 'EXPIRED' ? '⏰' : '❌';
    console.log(`  ${icon} ${r.id}: ${r.status}`);
  }

  const ok = results.filter((r) => r.status.startsWith('OK')).length;
  const expired = results.filter((r) => r.status === 'EXPIRED').length;
  const errors = results.filter((r) => r.status.startsWith('ERROR')).length;
  const other = results.length - ok - expired - errors;
  console.log(`\nOK: ${ok}, Expired: ${expired}, Errors: ${errors}, Other: ${other}`);
});
