import { test, expect, type Page } from '@playwright/test';

const PAGES: [string, string][] = [
  ['projects-dashboard', '/'],
  ['project-overview', '/projects/__TEST_PROJECT__/overview'],
  ['agent-list', '/projects/__TEST_PROJECT__/agents'],
  ['workflows-list', '/projects/__TEST_PROJECT__/workflows'],
  ['tools-list', '/projects/__TEST_PROJECT__/tools'],
  ['knowledge-bases', '/projects/__TEST_PROJECT__/search-ai'],
  ['connections', '/projects/__TEST_PROJECT__/connections'],
  ['sessions-list', '/projects/__TEST_PROJECT__/sessions'],
  ['deployments', '/projects/__TEST_PROJECT__/deployments'],
  ['alerts', '/projects/__TEST_PROJECT__/alerts'],
  ['insights-dashboard', '/projects/__TEST_PROJECT__/dashboard'],
  ['guardrails', '/projects/__TEST_PROJECT__/guardrails-config'],
  ['governance', '/projects/__TEST_PROJECT__/governance'],
  ['project-settings', '/projects/__TEST_PROJECT__/settings'],
  ['admin-members', '/admin/members'],
  ['admin-models', '/admin/models'],
  ['admin-billing', '/admin/billing'],
];

async function waitForPageReady(page: Page) {
  await page.waitForTimeout(500);
  try {
    await page.waitForSelector('.animate-pulse', { state: 'hidden', timeout: 5000 });
  } catch {
    // Some pages may not have skeletons
  }
  await page.waitForTimeout(300);
}

test.describe('Visual Regression Baseline', () => {
  test.describe.configure({ mode: 'serial' });

  for (const [name, path] of PAGES) {
    test(`capture ${name} (dark)`, async ({ page }) => {
      await page.goto(path);
      await waitForPageReady(page);
      await expect(page).toHaveScreenshot(`baseline/dark/${name}.png`, {
        fullPage: true,
        maxDiffPixelRatio: 0.01,
      });
    });
  }

  for (const [name, path] of PAGES) {
    test(`capture ${name} (light)`, async ({ page }) => {
      await page.goto(path);
      await page.evaluate(() => {
        document.documentElement.setAttribute('data-theme', 'light');
      });
      await waitForPageReady(page);
      await expect(page).toHaveScreenshot(`baseline/light/${name}.png`, {
        fullPage: true,
        maxDiffPixelRatio: 0.01,
      });
    });
  }
});
