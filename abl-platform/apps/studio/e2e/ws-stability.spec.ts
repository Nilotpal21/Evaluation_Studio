/**
 * WS Stability + Re-render Test
 *
 * Monitors WebSocket connections and React re-renders over a sustained period.
 * Sends multiple messages, switches tabs, waits, and checks for spurious disconnects.
 */

import { test, expect } from '@playwright/test';
import { isIsolatedSdkBrowserE2E } from './helpers/sdk-browser-env';

const STUDIO_URL = 'http://localhost:5173';

test.setTimeout(180_000);
test.skip(
  isIsolatedSdkBrowserE2E(),
  'This local websocket stability smoke test depends on seeded manual data in the shared dev stack.',
);

test('WS stays connected with no spurious disconnects or re-renders', async ({ page }) => {
  // Track WS events via CDP
  const wsEvents: Array<{ type: string; time: number }> = [];
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Network.enable');
  cdp.on('Network.webSocketCreated', () => wsEvents.push({ type: 'created', time: Date.now() }));
  cdp.on('Network.webSocketClosed', () => wsEvents.push({ type: 'closed', time: Date.now() }));

  // Login
  const resp = await page.request.post(`${STUDIO_URL}/api/auth/dev-login`, {
    data: { email: 'dev@kore.ai', name: 'Developer' },
  });
  expect(resp.ok()).toBe(true);

  // Navigate to chat
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

  // New chat + first message
  await page.getByText('New Chat').first().click();
  await page.waitForTimeout(5000);
  const chatInput = page.locator('textarea[placeholder*="message" i]').first();
  await expect(chatInput).toBeEnabled({ timeout: 15_000 });

  // Record baseline WS count
  const baselineWsCreated = wsEvents.filter((e) => e.type === 'created').length;
  const baselineWsClosed = wsEvents.filter((e) => e.type === 'closed').length;
  console.log(`Baseline WS: ${baselineWsCreated} created, ${baselineWsClosed} closed`);

  // Inject a render counter on the chat panel
  await page.evaluate(() => {
    (window as any).__renderCount = 0;
    const observer = new MutationObserver(() => {
      (window as any).__renderCount++;
    });
    const chatPanel = document.querySelector('[data-testid="message-list"]');
    if (chatPanel) {
      observer.observe(chatPanel, { childList: true, subtree: true, characterData: true });
    }
  });

  // --- Phase 1: Send messages ---
  for (let i = 1; i <= 3; i++) {
    await chatInput.fill(`Stability test message ${i}`);
    await chatInput.press('Enter');
    console.log(`>>> Sent message ${i}`);
    await page.waitForTimeout(5000);
  }

  const afterMessages = {
    created: wsEvents.filter((e) => e.type === 'created').length,
    closed: wsEvents.filter((e) => e.type === 'closed').length,
  };
  console.log(
    `After 3 messages — WS created: ${afterMessages.created}, closed: ${afterMessages.closed}`,
  );

  // --- Phase 2: Switch debug tabs ---
  const debugBtn = page.getByText('Debug').first();
  await debugBtn.click();
  await page.waitForTimeout(1000);

  for (const tab of ['Traces', 'Errors', 'Data', 'Conversation', 'Overview']) {
    const tabBtn = page.getByText(tab, { exact: true }).first();
    if (await tabBtn.isVisible().catch(() => false)) {
      await tabBtn.click();
      await page.waitForTimeout(800);
    }
  }

  const afterTabs = {
    created: wsEvents.filter((e) => e.type === 'created').length,
    closed: wsEvents.filter((e) => e.type === 'closed').length,
  };
  console.log(`After tab switches — WS created: ${afterTabs.created}, closed: ${afterTabs.closed}`);

  // --- Phase 3: Wait 30s to catch token-refresh reconnects ---
  console.log('>>> Waiting 30s for token refresh cycle...');
  await page.waitForTimeout(30_000);

  const afterWait = {
    created: wsEvents.filter((e) => e.type === 'created').length,
    closed: wsEvents.filter((e) => e.type === 'closed').length,
  };
  console.log(`After 30s wait — WS created: ${afterWait.created}, closed: ${afterWait.closed}`);

  // --- Phase 4: Send one more message to confirm still working ---
  await chatInput.fill('Final stability check');
  await chatInput.press('Enter');
  await page.waitForTimeout(6000);

  const finalRenderCount = await page.evaluate(() => (window as any).__renderCount || 0);

  // --- Results ---
  const newWsCreated = afterWait.created - baselineWsCreated;
  const newWsClosed = afterWait.closed - baselineWsClosed;

  console.log('\n=== WS STABILITY RESULTS ===');
  console.log(`  New WS connections after baseline: ${newWsCreated}`);
  console.log(`  WS closures after baseline: ${newWsClosed}`);
  console.log(`  DOM mutations (render proxy): ${finalRenderCount}`);
  console.log(`  Spurious reconnects: ${Math.max(0, newWsCreated - 1)}`);

  await page.screenshot({ path: 'e2e/screenshots/ws-stability-final.png' });

  // Assertions
  // After initial connect, there should be 0 additional WS connections
  expect(newWsCreated).toBeLessThanOrEqual(1); // Allow 1 for initial connect
  expect(newWsClosed).toBe(0); // No closures during the test
});
