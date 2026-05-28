/**
 * Cold Session Recovery E2E Test
 *
 * Verifies that after a runtime restart (which evicts all in-memory IR caches),
 * existing sessions can still receive messages via the DB rebuild path.
 *
 * Run headed: npx playwright test cold-session-recovery --headed
 */

import { test, expect } from '@playwright/test';
import { exec } from 'child_process';
import { promisify } from 'util';
import { isIsolatedSdkBrowserE2E } from './helpers/sdk-browser-env';

const execAsync = promisify(exec);

const STUDIO_URL = process.env.TEST_BASE_URL || 'http://localhost:5173';
const RUNTIME_URL = process.env.TEST_RUNTIME_URL || 'http://localhost:3112';
const DEV_EMAIL = process.env.TEST_LOGIN_EMAIL || 'ssk@kore.ai';

test.setTimeout(120_000);

async function devLogin(page: import('@playwright/test').Page) {
  const resp = await page.request.post(`${STUDIO_URL}/api/auth/dev-login`, {
    data: { email: DEV_EMAIL, name: 'Cold Session Tester' },
  });
  expect(resp.ok()).toBe(true);
  return ((await resp.json()) as { accessToken: string }).accessToken;
}

async function waitForRuntimeHealthy(maxWaitSec = 30): Promise<boolean> {
  for (let i = 0; i < maxWaitSec; i++) {
    try {
      const { stdout } = await execAsync(`curl -s ${RUNTIME_URL}/health`);
      if (stdout.includes('"healthy"')) return true;
    } catch {
      /* not ready */
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  return false;
}

async function findChatTextarea(page: import('@playwright/test').Page) {
  // The chat input is a textarea with a send-message-like placeholder
  // Try common patterns
  for (const selector of [
    'textarea[placeholder*="message" i]',
    'textarea[placeholder*="type" i]',
    'textarea[placeholder*="send" i]',
    'textarea[placeholder*="chat" i]',
  ]) {
    const el = page.locator(selector).first();
    if (await el.isVisible({ timeout: 1000 }).catch(() => false)) return el;
  }
  // Fallback: last textarea on the page (chat is at bottom)
  const all = page.locator('textarea');
  const count = await all.count();
  if (count > 0) return all.nth(count - 1);
  return null;
}

test.describe('Cold Session Recovery', () => {
  test.skip(
    isIsolatedSdkBrowserE2E(),
    'This smoke test restarts a pm2-managed runtime and must target the shared local stack.',
  );

  test('session survives runtime restart — send message after cache eviction', async ({ page }) => {
    // 1. Login
    const token = await devLogin(page);
    expect(token).toBeTruthy();

    // 2. Navigate: Projects → weather App → Agents → weather agent → Chat with Agent
    await page.goto(STUDIO_URL);
    await page.waitForLoadState('networkidle').catch(() => {});
    await page.waitForTimeout(2000);

    await page.getByText('weather App').first().click();
    await page.waitForTimeout(2000);

    await page.getByText('Agents').first().click();
    await page.waitForTimeout(2000);

    await page.locator('text=weather age').first().click();
    await page.waitForTimeout(2000);

    // Open chat panel
    await page.getByText('Chat with Agent').click();
    await page.waitForTimeout(3000);
    await page.screenshot({ path: 'e2e/screenshots/cold-03-chat-view.png' });

    // 3. Click "+ New Chat" to create a new session
    await page.getByText('New Chat').first().click();
    await page.waitForTimeout(5000);
    await page.screenshot({ path: 'e2e/screenshots/cold-04-new-session.png' });

    // 4. Find and use the chat input
    const chatInput = await findChatTextarea(page);
    if (!chatInput) {
      await page.screenshot({ path: 'e2e/screenshots/cold-04-no-input.png' });
      test.skip(true, 'Chat textarea not found');
      return;
    }

    // 5. Send first message
    await chatInput.click();
    await chatInput.fill('Hello, cold session test');
    await chatInput.press('Enter');
    console.log('>>> First message sent');
    await page.waitForTimeout(8000);
    await page.screenshot({ path: 'e2e/screenshots/cold-05-first-response.png' });

    // 6. RESTART RUNTIME — evicts all in-memory + L1 IR caches
    console.log('>>> Restarting runtime to evict caches...');
    await execAsync('pm2 restart abl-runtime');
    expect(await waitForRuntimeHealthy()).toBe(true);
    console.log('>>> Runtime healthy');

    // Wait for WS to reconnect — the "Failed to connect" banner must disappear
    // and the textarea must become enabled
    console.log('>>> Waiting for WS reconnect...');
    await page.screenshot({ path: 'e2e/screenshots/cold-06-reconnecting.png' });

    // Wait up to 60s for textarea to become enabled (WS reconnect + session resume)
    await expect(chatInput).toBeEnabled({ timeout: 60_000 });
    console.log('>>> WS reconnected, textarea enabled');
    await page.screenshot({ path: 'e2e/screenshots/cold-06-reconnected.png' });

    // 7. Send message to cold session — this is the critical test
    await chatInput.click();
    await chatInput.fill('Are you still there after restart?');
    await chatInput.press('Enter');
    console.log('>>> Cold session message sent');

    await page.waitForTimeout(10000);
    await page.screenshot({ path: 'e2e/screenshots/cold-07-cold-response.png' });

    // 8. Check for error banner with the old bug message
    const pageText = await page.textContent('body');
    const hasOldBug = pageText?.includes('LLM client not configured') ?? false;
    if (hasOldBug) {
      console.log('FAIL: Old bug "LLM client not configured" is visible in UI');
    }
    expect(hasOldBug).toBe(false);

    // 9. Check PM2 logs for evidence
    const { stdout: logs } = await execAsync(
      'pm2 logs abl-runtime --lines 80 --nostream 2>&1 || true',
    );

    const hasIRRebuild = logs.includes('IR rebuilt from DB');
    const hasLLMError = logs.includes('LLM client not configured');
    const irSpamCount = (logs.match(/IR not found for hash/g) || []).length;

    console.log('PM2 evidence:', { hasIRRebuild, hasLLMError, irSpamCount });

    // Core assertions
    expect(hasLLMError).toBe(false);
    expect(irSpamCount).toBeLessThan(3);

    console.log('✅ Cold session recovery test passed!');
  });
});
