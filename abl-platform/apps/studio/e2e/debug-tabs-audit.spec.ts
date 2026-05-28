/**
 * Debug Tabs Audit — Click every debug panel tab, screenshot, check for issues.
 */

import { test, expect } from '@playwright/test';
import { isIsolatedSdkBrowserE2E } from './helpers/sdk-browser-env';

const STUDIO_URL = 'http://localhost:5173';

test.setTimeout(120_000);
test.skip(
  isIsolatedSdkBrowserE2E(),
  'This local debug audit depends on seeded manual data in the shared dev stack.',
);

test('audit all debug tabs', async ({ page }) => {
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
  await chatInput.fill('Tell me about weather in New York with a table of temperatures');
  await chatInput.press('Enter');
  await page.waitForTimeout(10000);

  // Open debug panel
  await page.locator('text=Debug').last().click();
  await page.waitForTimeout(2000);
  await page.screenshot({ path: 'e2e/screenshots/audit-00-debug-open.png' });

  // Tab names to audit
  const tabNames = ['Overview', 'Traces', 'Errors', 'Data', 'Conversation'];

  for (const tabName of tabNames) {
    // Find ALL elements with this text, pick the one in the debug panel (rightmost/last)
    const allMatches = page.locator(`text="${tabName}"`);
    const count = await allMatches.count();

    if (count === 0) {
      console.log(`\n=== ${tabName.toUpperCase()} === ❌ Not found`);
      continue;
    }

    // Click the last match (debug panel is on the right)
    await allMatches.nth(count - 1).click();
    await page.waitForTimeout(1500);
    await page.screenshot({ path: `e2e/screenshots/audit-${tabName.toLowerCase()}.png` });

    const bodyText = await page.textContent('body').catch(() => '');

    // Check timestamps
    const times24h = (bodyText || '').match(/\b\d{2}:\d{2}:\d{2}\b/g) || [];
    const timesAmPm = (bodyText || '').match(/\d{1,2}:\d{2}:\d{2}\s*(AM|PM)/gi) || [];

    const issues: string[] = [];
    if (timesAmPm.length > 0) issues.push(`${timesAmPm.length} AM/PM timestamps (should be 24h)`);

    console.log(`\n=== ${tabName.toUpperCase()} ===`);
    console.log(`  24h timestamps: ${times24h.length}`);
    console.log(`  AM/PM timestamps: ${timesAmPm.length}`);
    if (issues.length > 0) {
      console.log(`  ⚠️  ${issues.join(', ')}`);
    } else {
      console.log(`  ✅ OK`);
    }
  }

  console.log('\n=== AUDIT COMPLETE ===');
});
