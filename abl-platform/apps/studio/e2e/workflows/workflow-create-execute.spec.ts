import { test, expect, Page } from '@playwright/test';
import { loginAndSetup } from './helpers';

/**
 * E2E test: Create a workflow via UI, add steps via API (HTTP + Agent Invocation),
 * verify steps in UI, check triggers tab, and confirm Run button.
 */

const RUNTIME_URL = 'http://localhost:3002';
const TEST_LOGIN_EMAIL = 'workflow-create-execute@e2e-smoke.test';
const TEST_LOGIN_NAME = 'Workflow Create Execute E2E';

/** Add a step to a workflow via Runtime API */
async function addStepViaAPI(
  token: string,
  projectId: string,
  workflowId: string,
  steps: Array<{ id: string; name: string; type: string; config: Record<string, unknown> }>,
) {
  const resp = await fetch(`${RUNTIME_URL}/api/projects/${projectId}/workflows/${workflowId}`, {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      'X-Tenant-Id': 'tenant-kore',
    },
    body: JSON.stringify({ steps }),
  });
  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`API update failed (${resp.status}): ${body}`);
  }
  return resp.json();
}

test.describe('Workflow E2E', () => {
  test('Create workflow, add steps, verify UI, check triggers', async ({ page }) => {
    test.setTimeout(120000);

    // ── 1. Login & Navigate ──────────────────────────────────────────
    const { projectId, token } = await loginAndSetup(page);
    await page.screenshot({ path: 'e2e/screenshots/01-project.png', fullPage: true });

    // ── 2. Go to Workflows ───────────────────────────────────────────
    await page.locator('nav >> text=Workflows').click();
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(1000);
    await page.screenshot({ path: 'e2e/screenshots/02-workflows-list.png', fullPage: true });

    // ── 3. Create Workflow via UI ────────────────────────────────────
    const newBtn = page.locator('button:has-text("New Workflow")').first();
    await expect(newBtn).toBeVisible({ timeout: 10000 });
    await newBtn.click();

    // Wait for dialog
    await expect(
      page.locator('h2:has-text("Create Workflow"), h3:has-text("Create Workflow")'),
    ).toBeVisible({ timeout: 5000 });

    const workflowName = `E2E Workflow ${Date.now()}`;
    const nameInput = page.locator('input[placeholder*="Order"]');
    await expect(nameInput).toBeVisible({ timeout: 5000 });
    await nameInput.fill(workflowName);

    const descInput = page.locator('textarea[placeholder*="description" i]');
    if (await descInput.isVisible({ timeout: 1000 }).catch(() => false)) {
      await descInput.fill('HTTP + Agent Invocation + Trigger');
    }

    await page.screenshot({ path: 'e2e/screenshots/03-create-modal.png', fullPage: true });

    const dialog = page.locator('[role="dialog"]');
    const createBtn = dialog.locator('button:has-text("Create Workflow")');
    await createBtn.click();

    // Wait for navigation to detail page
    await page.waitForURL(/\/workflows\/[^/]+$/, { timeout: 15000 });
    await page.waitForTimeout(1000);

    const detailUrl = page.url();
    const workflowId = detailUrl.match(/\/workflows\/([^/]+)$/)?.[1];
    expect(workflowId).toBeTruthy();
    console.log(`Workflow created: ${workflowId}`);

    await page.screenshot({ path: 'e2e/screenshots/04-workflow-detail.png', fullPage: true });

    // ── 4. Add steps via API ─────────────────────────────────────────
    const steps = [
      {
        id: 'step-http-1',
        name: 'Fetch order data',
        type: 'http',
        config: {
          method: 'GET',
          url: 'https://httpbin.org/get',
          headers: { Accept: 'application/json' },
          timeout: 30000,
        },
        position: 0,
      },
      {
        id: 'step-agent-1',
        name: 'Process with AI agent',
        type: 'agent_invocation',
        config: {
          agentId: 'order-processing-agent',
          message: '{{steps.step-http-1.output.body}}',
          maxTurns: 5,
          timeout: 60000,
        },
        position: 1,
      },
    ];

    await addStepViaAPI(token, projectId, workflowId!, steps);
    console.log('Steps added via API: HTTP + Agent Invocation');

    // ── 5. Verify steps in UI ────────────────────────────────────────
    // Navigate to Flow tab (formerly "Steps")
    const flowTab = page.locator('button:has-text("Flow")').first();
    await expect(flowTab).toBeVisible({ timeout: 5000 });
    await flowTab.click();
    await page.waitForTimeout(2000);

    // Reload to pick up API changes
    await page.reload({ waitUntil: 'networkidle' });
    await page.waitForTimeout(1000);

    // Click Flow tab again after reload
    await flowTab.click();
    await page.waitForTimeout(1500);

    await page.screenshot({ path: 'e2e/screenshots/05-steps-tab.png', fullPage: true });

    // Check for steps by their type labels
    const httpStep = page.getByText('HTTP Request');
    const agentStep = page.getByText('Agent Invocation');

    const httpStepVisible = await httpStep
      .first()
      .isVisible({ timeout: 5000 })
      .catch(() => false);
    const agentStepVisible = await agentStep
      .first()
      .isVisible({ timeout: 3000 })
      .catch(() => false);

    console.log(`Steps visible — HTTP: ${httpStepVisible}, Agent: ${agentStepVisible}`);
    expect(httpStepVisible).toBe(true);
    expect(agentStepVisible).toBe(true);

    // ── 6. Click HTTP step to see editor ─────────────────────────────
    await httpStep.first().click();
    await page.waitForTimeout(1000);
    await page.screenshot({ path: 'e2e/screenshots/06-http-step-editor.png', fullPage: true });

    // ── 7. Click Agent step to see editor ────────────────────────────
    await agentStep.first().click();
    await page.waitForTimeout(1000);
    await page.screenshot({ path: 'e2e/screenshots/07-agent-step-editor.png', fullPage: true });

    // ── 8. Triggers tab ──────────────────────────────────────────────
    const triggersTab = page.locator('button:has-text("Triggers")').first();
    await expect(triggersTab).toBeVisible({ timeout: 5000 });
    await triggersTab.click();
    await page.waitForTimeout(1000);
    await page.screenshot({ path: 'e2e/screenshots/08-triggers-tab.png', fullPage: true });

    // Check for trigger-related UI elements
    const triggerContent = await page.textContent('main, [role="main"], .flex-1');
    console.log('Triggers tab content includes:', triggerContent?.slice(0, 200));

    // ── 9. Monitor tab ───────────────────────────────────────────────
    const monitorTab = page.locator('button:has-text("Monitor")').first();
    if (await monitorTab.isVisible({ timeout: 3000 }).catch(() => false)) {
      await monitorTab.click();
      await page.waitForTimeout(1000);
      await page.screenshot({ path: 'e2e/screenshots/09-monitor-tab.png', fullPage: true });
    }

    // ── 10. Verify Run button ────────────────────────────────────────
    const runBtn = page.locator('button:has-text("Run")').first();
    const runVisible = await runBtn.isVisible({ timeout: 3000 }).catch(() => false);
    console.log('Run button visible:', runVisible);
    expect(runVisible).toBe(true);

    await page.screenshot({ path: 'e2e/screenshots/10-final.png', fullPage: true });
    console.log('\nE2E complete! Screenshots in e2e/screenshots/');
  });
});
