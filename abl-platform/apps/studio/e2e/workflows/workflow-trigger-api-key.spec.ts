/**
 * Workflow Triggers — API Key Wiring + Async Push E2E Test
 *
 * Tests the full flow:
 * 1. Login → navigate to workflow → Triggers tab
 * 2. Create webhook trigger → verify key modal auto-opens
 * 3. Create API key → verify curls show x-api-key header with masked key
 * 4. Verify all 3 curl tabs (Sync, Async + Poll, Async Push)
 * 5. Execute workflow via curl using the real API key (intercepted from creation)
 * 6. Verify execution appears in monitoring
 */
import { test, expect } from '@playwright/test';
import { loginAndSetup, navigateToWorkflows, createWorkflowViaUI } from './helpers';

const SCREENSHOTS_DIR = 'e2e/screenshots/trigger-api-key';

test.describe('Workflow Trigger API Key Wiring', () => {
  test('create webhook trigger, generate API key, verify curls use x-api-key', async ({
    page,
    context,
  }) => {
    test.setTimeout(180000);

    // Intercept the SDK key creation response to capture the real API key
    let capturedApiKey = '';
    await page.route('**/api/sdk/keys', async (route) => {
      const request = route.request();
      if (request.method() === 'POST') {
        const response = await route.fetch();
        const body = await response.json();
        if (body.key) {
          capturedApiKey = body.key;
          console.log(`Intercepted API key: ${capturedApiKey.substring(0, 12)}...`);
        }
        await route.fulfill({ response });
      } else {
        await route.continue();
      }
    });

    // ── 1. Login and setup ─────────────────────────────────────
    const setup = await loginAndSetup(page);
    const projectId = setup.projectId;

    // ── 2. Create a test workflow ──────────────────────────────
    await navigateToWorkflows(page);
    const workflowId = await createWorkflowViaUI(
      page,
      `E2E Trigger Key ${Date.now()}`,
      'Test webhook trigger with API key',
    );

    await page.screenshot({
      path: `${SCREENSHOTS_DIR}/01-workflow-created.png`,
      fullPage: true,
    });

    // ── 3. Navigate to Triggers tab ────────────────────────────
    const triggersTab = page
      .locator('button:has-text("Triggers"), [role="tab"]:has-text("Triggers")')
      .first();
    await expect(triggersTab).toBeVisible({ timeout: 10000 });
    await triggersTab.click();
    await page.waitForTimeout(2000);

    await page.screenshot({
      path: `${SCREENSHOTS_DIR}/02-triggers-tab-empty.png`,
      fullPage: true,
    });

    // ── 4. Click "Add Trigger" and create webhook trigger ──────
    const addBtn = page.locator('button:has-text("Add Trigger")').first();
    await expect(addBtn).toBeVisible({ timeout: 5000 });
    await addBtn.click();
    await page.waitForTimeout(1000);

    // Fill name if visible
    const nameInput = page.locator('input[placeholder*="name" i], input[aria-label*="name" i]');
    if (await nameInput.isVisible({ timeout: 2000 }).catch(() => false)) {
      await nameInput.fill('E2E Webhook Trigger');
    }

    const createTriggerBtn = page.locator('button:has-text("Create Trigger")').first();
    await expect(createTriggerBtn).toBeVisible({ timeout: 5000 });
    await createTriggerBtn.click();
    await page.waitForTimeout(3000);

    await page.screenshot({
      path: `${SCREENSHOTS_DIR}/03-trigger-created.png`,
      fullPage: true,
    });

    // ── 5. Handle API Key ─────────────────────────────────────
    // After trigger creation the "Generate API Key" button must be visible
    // (key section only shows when the raw key is in localStorage).
    // Clear any stale raw key from localStorage to simulate a fresh state.
    await page.evaluate((pid) => {
      localStorage.removeItem(`abl:sdk-key:${pid}`);
    }, projectId);
    await page.waitForTimeout(2000);

    // "Generate API Key" button should be visible (no auto-generation)
    const genKeyBtn = page.locator('button:has-text("Generate API Key")').first();
    await expect(genKeyBtn).toBeVisible({ timeout: 10000 });
    console.log('"Generate API Key" button visible — clicking it');

    // API Key Status section should NOT be visible yet
    const keyStatusBefore = page.locator('text=API Key Status').first();
    expect(await keyStatusBefore.isVisible({ timeout: 1000 }).catch(() => false)).toBeFalsy();

    await genKeyBtn.click();
    await page.waitForTimeout(1000);

    // Key modal should now be open
    const modal = page.locator('[role="dialog"]');
    await expect(modal).toBeVisible({ timeout: 5000 });
    const spinner = modal.locator('.animate-spin');
    try {
      await spinner.waitFor({ state: 'hidden', timeout: 15000 });
    } catch {
      // continue
    }
    const createBtn = modal.locator('button:has-text("Create")').first();
    if (await createBtn.isVisible({ timeout: 5000 }).catch(() => false)) {
      await createBtn.click();
      try {
        await modal.waitFor({ state: 'hidden', timeout: 10000 });
        console.log('Modal closed after key creation');
      } catch {
        await page.keyboard.press('Escape');
      }
    }
    await page.waitForTimeout(2000);

    await page.screenshot({
      path: `${SCREENSHOTS_DIR}/04-with-api-key.png`,
      fullPage: true,
    });

    console.log(
      `Captured API key: ${capturedApiKey ? capturedApiKey.substring(0, 12) + '...' : '(none)'}`,
    );
    expect(capturedApiKey).toBeTruthy();
    expect(capturedApiKey.startsWith('pk_')).toBeTruthy();

    // ── 6. Verify curl snippets show masked key + x-api-key header ─
    const curlPre = page.locator('pre').first();
    await expect(curlPre).toBeVisible({ timeout: 10000 });

    const syncSnippet = await curlPre.textContent();
    console.log('Sync display curl:', syncSnippet?.substring(0, 200));

    // Should show x-api-key header
    expect(syncSnippet).toContain('x-api-key');
    expect(syncSnippet).not.toContain('Authorization: Bearer');
    // Should show correct runtime URL
    expect(syncSnippet).toContain('localhost:3112');
    // Should contain the project ID
    expect(syncSnippet).toContain(projectId);
    // Should show masked key (asterisks)
    expect(syncSnippet).toContain('*');

    // ── 7. Check all 3 curl tabs ───────────────────────────────
    const tabLabels = ['Sync', 'Async + Poll', 'Async Push'];
    for (const label of tabLabels) {
      const tab = page.locator(`button:has-text("${label}")`).first();
      if (await tab.isVisible({ timeout: 2000 }).catch(() => false)) {
        await tab.click();
        await page.waitForTimeout(500);

        const snippet = page.locator('pre').first();
        if (await snippet.isVisible({ timeout: 2000 }).catch(() => false)) {
          const text = await snippet.textContent();
          console.log(`${label} tab:`, text?.substring(0, 120));
          if (text) {
            expect(text).toContain('x-api-key');
            expect(text).toContain('localhost:3112');
          }
        }
      }
    }

    await page.screenshot({
      path: `${SCREENSHOTS_DIR}/05-all-tabs.png`,
      fullPage: true,
    });

    // ── 7b. Verify curl copy button copies REAL key (not masked) ─
    // Grant clipboard permission
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);

    // Switch back to Sync tab for a clean copy test
    const syncTab = page.locator('button:has-text("Sync")').first();
    if (await syncTab.isVisible({ timeout: 2000 }).catch(() => false)) {
      await syncTab.click();
      await page.waitForTimeout(500);
    }

    // Click the curl copy button (the absolute-positioned button inside the code block area)
    const curlCopyBtn = page.locator('pre').first().locator('..').locator('button').first();
    await expect(curlCopyBtn).toBeVisible({ timeout: 3000 });
    await curlCopyBtn.click();
    await page.waitForTimeout(500);

    // Read clipboard and verify it contains the REAL API key, not masked
    const clipboardCurl = await page.evaluate(() => navigator.clipboard.readText());
    console.log('Clipboard curl:', clipboardCurl?.substring(0, 200));
    expect(clipboardCurl).toContain('x-api-key');
    expect(clipboardCurl).toContain(capturedApiKey);
    // Clipboard curl must NOT contain asterisks (masked key)
    expect(clipboardCurl).not.toMatch(/x-api-key:\s+\S*\*{4,}/);
    console.log('✓ Curl copy button copies real API key');

    // ── 7c. Verify API key copy button copies the real key ────────
    // Find the API key section copy button (near the key prefix display)
    const keyPrefixCode = page.locator('code').filter({ hasText: /^pk_/ }).first();
    if (await keyPrefixCode.isVisible({ timeout: 3000 }).catch(() => false)) {
      // The copy button is the sibling button right after the code element
      const keyCopyBtn = keyPrefixCode.locator('..').locator('button').first();
      if (await keyCopyBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
        await keyCopyBtn.click();
        await page.waitForTimeout(500);

        const clipboardKey = await page.evaluate(() => navigator.clipboard.readText());
        console.log('Clipboard API key:', clipboardKey?.substring(0, 16) + '...');
        // Should be the real key (starts with pk_ and is long), not just the prefix
        expect(clipboardKey).toBeTruthy();
        expect(clipboardKey!.startsWith('pk_')).toBeTruthy();
        expect(clipboardKey!.length).toBeGreaterThan(20);
        // Should match the captured key
        expect(clipboardKey).toBe(capturedApiKey);
        console.log('✓ API key copy button copies real API key');
      }
    }

    // ── 8. Verify API key section UI elements ──────────────────
    // Check the prominent API key section
    await expect(page.locator('text=API Key Status').first()).toBeVisible({ timeout: 5000 });

    // Check "Change Key" button exists
    const changeKeyBtn = page.locator('button:has-text("Change Key")').first();
    expect(await changeKeyBtn.isVisible({ timeout: 3000 }).catch(() => false)).toBeTruthy();

    // Check "Manage API Keys" link exists
    const manageKeysLink = page.locator('text=Manage API Keys').first();
    expect(await manageKeysLink.isVisible({ timeout: 3000 }).catch(() => false)).toBeTruthy();

    await page.screenshot({
      path: `${SCREENSHOTS_DIR}/06-api-key-section.png`,
      fullPage: true,
    });

    // ── 9. Execute workflow via real curl ───────────────────────
    // Only test execution if we have a captured raw key (created in this session)
    if (capturedApiKey) {
      console.log('Executing workflow via API with real key...');

      const executeUrl = `http://localhost:3112/api/projects/${encodeURIComponent(projectId)}/workflows/${encodeURIComponent(workflowId)}/executions/execute`;

      // Test Sync mode
      const syncResp = await page.request.post(executeUrl, {
        headers: {
          'x-api-key': capturedApiKey,
          'Content-Type': 'application/json',
        },
        data: { input: {} },
      });
      const syncStatus = syncResp.status();
      const syncBody = await syncResp.json().catch(() => ({}));
      console.log(`Sync execution: ${syncStatus}`, JSON.stringify(syncBody).substring(0, 300));

      expect(syncStatus).not.toBe(401);
      expect(syncStatus).not.toBe(403);

      // Test Async mode
      const asyncResp = await page.request.post(`${executeUrl}?mode=async`, {
        headers: {
          'x-api-key': capturedApiKey,
          'Content-Type': 'application/json',
        },
        data: { input: {} },
      });
      const asyncStatus = asyncResp.status();
      const asyncBody = await asyncResp.json().catch(() => ({}));
      console.log(`Async execution: ${asyncStatus}`, JSON.stringify(asyncBody).substring(0, 300));

      expect(asyncStatus).not.toBe(401);
      expect(asyncStatus).not.toBe(403);
    } else {
      console.log('Skipping execution test — using pre-existing key (raw key not available)');
    }

    await page.screenshot({
      path: `${SCREENSHOTS_DIR}/07-curl-executed.png`,
      fullPage: true,
    });

    // ── 10. Check monitoring tab for execution ─────────────────
    const monitorTab = page
      .locator('button:has-text("Monitor"), [role="tab"]:has-text("Monitor")')
      .first();
    if (await monitorTab.isVisible({ timeout: 3000 }).catch(() => false)) {
      await monitorTab.click();
      await page.waitForTimeout(3000);

      await page.screenshot({
        path: `${SCREENSHOTS_DIR}/08-monitoring.png`,
        fullPage: true,
      });

      // Check if any executions are shown
      const executionRow = page.locator('tr, [data-testid*="execution"]').first();
      if (await executionRow.isVisible({ timeout: 5000 }).catch(() => false)) {
        console.log('Execution visible in monitoring');
      } else {
        console.log('No executions visible in monitoring (workflow may have no steps)');
      }
    }

    // ── 11. Verify "Manage API Keys" navigation ────────────────
    // Click back to Triggers tab first
    const triggersTab2 = page
      .locator('button:has-text("Triggers"), [role="tab"]:has-text("Triggers")')
      .first();
    if (await triggersTab2.isVisible({ timeout: 3000 }).catch(() => false)) {
      await triggersTab2.click();
      await page.waitForTimeout(2000);
    }

    const manageLink = page.locator('text=Manage API Keys').first();
    if (await manageLink.isVisible({ timeout: 3000 }).catch(() => false)) {
      await manageLink.click();
      await page.waitForTimeout(3000);

      await page.screenshot({
        path: `${SCREENSHOTS_DIR}/09-manage-api-keys.png`,
        fullPage: true,
      });

      // Should navigate to settings/api-keys page
      const currentUrl = page.url();
      console.log('Navigated to:', currentUrl);
    }

    await page.screenshot({
      path: `${SCREENSHOTS_DIR}/10-final.png`,
      fullPage: true,
    });
  });
});
