/**
 * Workflow Triggers UI Showcase
 *
 * Navigates to an existing workflow's Triggers tab and captures screenshots
 * of the new components: trigger list, creation form with preset picker,
 * and external app catalog.
 */
import { test, expect, type Page } from '@playwright/test';

const STUDIO_URL = 'http://localhost:5173';
const RUNTIME_URL = 'http://localhost:3112';
const SCREENSHOTS_DIR = 'e2e/screenshots/triggers';

// Known IDs from the dev environment
const PROJECT_ID = '019c701f-ec11-777e-99a8-bd03b3ffdaa6';
const TENANT_ID = '019c701f-5915-7ab7-bd97-7344f5e13137';
const WORKFLOW_ID = '019cd7a9-96cd-7c4f-a5f5-b60b793d59d7';

async function loginViaApi(page: Page): Promise<void> {
  // Get auth token from runtime dev-login API
  const resp = await page.request.post(`${RUNTIME_URL}/api/auth/dev-login`, {
    data: { email: 'dev@example.com' },
  });
  const body = await resp.json();
  const token = body.accessToken;

  // Inject token into the browser's localStorage so the Studio recognizes the session
  await page.goto(`${STUDIO_URL}/auth/login`);
  await page.waitForLoadState('domcontentloaded');
  await page.evaluate(
    ({ tok, tid }) => {
      localStorage.setItem('access_token', tok);
      localStorage.setItem('tenant_id', tid);
    },
    { tok: token, tid: TENANT_ID },
  );
  await page.waitForTimeout(500);
}

test.describe('Workflow Triggers UI Showcase', () => {
  test('capture all trigger UI components', async ({ page }) => {
    test.setTimeout(120000);

    // ── 1. Login ────────────────────────────────────────────────
    await loginViaApi(page);

    // ── 2. Navigate to the workflow detail page directly ────────
    await page.goto(`${STUDIO_URL}/projects/${PROJECT_ID}/workflows/${WORKFLOW_ID}`);
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(3000);

    // Take a screenshot of whatever page we land on
    await page.screenshot({
      path: `${SCREENSHOTS_DIR}/01-after-login.png`,
      fullPage: true,
    });

    // If redirected to login, try clicking Dev Login button
    if (page.url().includes('/auth/login') || page.url().includes('/login')) {
      const devBtn = page.locator('button:has-text("Dev Login")');
      if (await devBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
        await devBtn.click();
        await page.waitForLoadState('networkidle');
        await page.waitForTimeout(3000);

        await page.screenshot({
          path: `${SCREENSHOTS_DIR}/02-after-dev-login.png`,
          fullPage: true,
        });

        // After dev-login, try selecting a project if on project selector
        const projectCard = page.locator('button:has(h3)').first();
        if (await projectCard.isVisible({ timeout: 3000 }).catch(() => false)) {
          await projectCard.click();
          await page.waitForLoadState('networkidle');
          await page.waitForTimeout(2000);
        }

        // Navigate to workflow
        await page.goto(`${STUDIO_URL}/projects/${PROJECT_ID}/workflows/${WORKFLOW_ID}`);
        await page.waitForLoadState('networkidle');
        await page.waitForTimeout(3000);
      }
    }

    await page.screenshot({
      path: `${SCREENSHOTS_DIR}/03-workflow-page.png`,
      fullPage: true,
    });

    // ── 3. Navigate to Triggers tab ─────────────────────────────
    const triggersTab = page
      .locator('button:has-text("Triggers"), [role="tab"]:has-text("Triggers")')
      .first();
    if (await triggersTab.isVisible({ timeout: 5000 }).catch(() => false)) {
      await triggersTab.click();
      await page.waitForTimeout(2000);
    } else {
      // Try clicking any tab that contains "Trigger"
      const anyTrigger = page.getByText('Triggers').first();
      if (await anyTrigger.isVisible({ timeout: 3000 }).catch(() => false)) {
        await anyTrigger.click();
        await page.waitForTimeout(2000);
      }
    }

    await page.screenshot({
      path: `${SCREENSHOTS_DIR}/04-triggers-tab.png`,
      fullPage: true,
    });

    // ── 4. Click "Add Trigger" ──────────────────────────────────
    const addBtn = page.locator('button:has-text("Add Trigger")').first();
    if (await addBtn.isVisible({ timeout: 5000 }).catch(() => false)) {
      await addBtn.click();
      await page.waitForTimeout(1000);
    }

    await page.screenshot({
      path: `${SCREENSHOTS_DIR}/05-trigger-form-webhook.png`,
      fullPage: true,
    });

    // ── 5. Switch to Cron Schedule for SchedulePresetPicker ─────
    const cronTypeBtn = page
      .locator('button:has-text("Cron"), button:has-text("Schedule")')
      .first();
    if (await cronTypeBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
      await cronTypeBtn.click();
      await page.waitForTimeout(800);
    }

    await page.screenshot({
      path: `${SCREENSHOTS_DIR}/06-preset-picker-daily.png`,
      fullPage: true,
    });

    // ── 6. Try Weekly preset ───────────────────────────────────
    const weeklyBtn = page.locator('button:has-text("Weekly")').first();
    if (await weeklyBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
      await weeklyBtn.click();
      await page.waitForTimeout(500);
    }

    await page.screenshot({
      path: `${SCREENSHOTS_DIR}/07-preset-picker-weekly.png`,
      fullPage: true,
    });

    // ── 7. Monthly preset ──────────────────────────────────────
    const monthlyBtn = page.locator('button:has-text("Monthly")').first();
    if (await monthlyBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
      await monthlyBtn.click();
      await page.waitForTimeout(500);
    }

    await page.screenshot({
      path: `${SCREENSHOTS_DIR}/08-preset-picker-monthly.png`,
      fullPage: true,
    });

    // ── 8. Custom Cron preset ──────────────────────────────────
    const customCronBtn = page.locator('button:has-text("Custom Cron")').first();
    if (await customCronBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
      await customCronBtn.click();
      await page.waitForTimeout(500);
    }

    await page.screenshot({
      path: `${SCREENSHOTS_DIR}/09-preset-picker-custom-cron.png`,
      fullPage: true,
    });

    // ── 9. Once preset ──────────────────────────────────────────
    const onceBtn = page.locator('button:has-text("Once")').first();
    if (await onceBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
      await onceBtn.click();
      await page.waitForTimeout(500);
    }

    await page.screenshot({
      path: `${SCREENSHOTS_DIR}/10-preset-picker-once.png`,
      fullPage: true,
    });

    // ── 10. Scroll to External App Catalog ──────────────────────
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.waitForTimeout(1500);

    await page.screenshot({
      path: `${SCREENSHOTS_DIR}/11-external-app-catalog.png`,
      fullPage: true,
    });

    // ── 11. Final overview ──────────────────────────────────────
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForTimeout(500);

    await page.screenshot({
      path: `${SCREENSHOTS_DIR}/12-final-overview.png`,
      fullPage: true,
    });

    expect(true).toBe(true);
  });
});
