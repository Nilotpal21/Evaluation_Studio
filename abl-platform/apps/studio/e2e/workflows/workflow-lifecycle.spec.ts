/**
 * Workflow Lifecycle E2E Test
 *
 * Single comprehensive test covering the full workflow lifecycle:
 * create -> add nodes -> connect edges -> configure -> save -> verify persistence -> run -> verify debug panel -> delete
 *
 * Flow: Start → API (public endpoint) → Condition (branch on response) → End
 */

import { test, expect } from '@playwright/test';
import {
  loginAndSetup,
  navigateToWorkflows,
  createWorkflowViaUI,
  waitForCanvasReady,
  addNodeViaHandleMenu,
  selectNodeByName,
  selectNodeByTestId,
  saveWorkflow,
  deleteWorkflowFromList,
} from './helpers';

test.describe('Workflow Lifecycle', () => {
  const workflowName = `LifecycleTest${Date.now()}`;

  test('Full lifecycle: create, build, connect, configure, save, persist, run, debug, delete', async ({
    page,
  }) => {
    test.setTimeout(180_000);

    // ── Step 1: Login and navigate ──────────────────────────────────────
    await loginAndSetup(page);
    await navigateToWorkflows(page);

    // ── Step 2: Create workflow ─────────────────────────────────────────
    await createWorkflowViaUI(page, workflowName, 'API → Condition → End lifecycle test');
    await waitForCanvasReady(page);

    // Verify Start node exists
    await expect(page.locator('[data-testid="workflow-node-start"]')).toBeVisible();

    // ── Step 3: Add nodes via handle plus menu (auto-creates edges) ─────
    // Flow: Start → API → Condition → End (success path)
    //                        └─ else → End (also routes to End)
    await addNodeViaHandleMenu(page, 'api'); // Start → API
    await addNodeViaHandleMenu(page, 'condition', '[data-node-type="api"]'); // API → Condition
    await addNodeViaHandleMenu(page, 'end', '[data-node-type="condition"]', 'else'); // Condition (else) → End

    // Verify 4 nodes present (Start + API + Condition + End)
    const allNodes = page.locator('[data-testid^="workflow-node-"]');
    await expect(allNodes).toHaveCount(4, { timeout: 5000 });

    // Edge from Condition (else) → End was auto-created by addNodeViaHandleMenu above.

    // ── Step 5: Configure API node with public endpoint ─────────────────
    await selectNodeByName(page, 'API0001');

    const configPanel = page.locator('[data-testid="config-panel"]');
    await expect(configPanel).toBeVisible({ timeout: 5000 });

    // Set URL to a public API endpoint (JSONPlaceholder)
    const urlInput = page.locator('[data-testid="config-url"]');
    await expect(urlInput).toBeVisible({ timeout: 3000 });
    await urlInput.fill('https://jsonplaceholder.typicode.com/todos/1');

    // ── Step 6: Configure Condition node ────────────────────────────────
    // Close config panel first to avoid stale state, then reselect
    const closeConfigBtn = page.locator('[data-testid="config-panel-close"]');
    if (await closeConfigBtn.isVisible({ timeout: 1000 }).catch(() => false)) {
      await closeConfigBtn.click();
      await page.waitForTimeout(300);
    }

    await selectNodeByName(page, 'Condition0001');
    await page.waitForTimeout(500);

    await expect(configPanel).toBeVisible({ timeout: 5000 });

    // Wait for config panel to update to condition node
    const conditionConfig = page.locator('[data-testid="condition-config"]');
    await expect(conditionConfig).toBeVisible({ timeout: 5000 });

    // Fill "Field" for the first condition — check API response's "completed" field
    const fieldInput = conditionConfig.locator('input').first();
    await expect(fieldInput).toBeVisible({ timeout: 2000 });
    await fieldInput.fill('{{context.steps.API0001.output.completed}}');

    // Select operator "Equals"
    const operatorSelect = conditionConfig.locator('select').first();
    if (await operatorSelect.isVisible({ timeout: 1000 }).catch(() => false)) {
      await operatorSelect.selectOption('equals');
    }

    // Fill "Value" input
    const valueInputs = conditionConfig.locator('input[placeholder="Compare value"]');
    if (
      await valueInputs
        .first()
        .isVisible({ timeout: 1000 })
        .catch(() => false)
    ) {
      await valueInputs.first().fill('false');
    }

    // Verify "Else (default path)" label is shown
    await expect(conditionConfig.locator('text=Else (default path)')).toBeVisible();

    // ── Step 7: Reposition nodes for clean top-down layout ──────────────
    await page.evaluate(() => {
      const store = (window as any).__zustandStores?.workflowCanvas;
      if (!store) return;
      const state = store.getState();
      const positions: Record<string, { x: number; y: number }> = {};
      for (const node of state.nodes) {
        if (node.data.nodeType === 'start') positions[node.id] = { x: 400, y: 50 };
        else if (node.data.nodeType === 'api') positions[node.id] = { x: 400, y: 200 };
        else if (node.data.nodeType === 'condition') positions[node.id] = { x: 400, y: 380 };
        else if (node.data.nodeType === 'end') positions[node.id] = { x: 400, y: 560 };
      }
      const updatedNodes = state.nodes.map((n: any) => ({
        ...n,
        position: positions[n.id] || n.position,
      }));
      store.setState({ nodes: updatedNodes, isDirty: true });
    });
    await page.waitForTimeout(500);

    // ── Step 8: Save the workflow ───────────────────────────────────────
    await saveWorkflow(page);

    // ── Step 9: Navigate away and back to verify persistence ────────────
    await navigateToWorkflows(page);
    await page.waitForTimeout(1000);

    const workflowCard = page.locator(`text=${workflowName}`).first();
    await expect(workflowCard).toBeVisible({ timeout: 5000 });
    await workflowCard.click();

    await waitForCanvasReady(page);

    // Verify core nodes persisted (Start + API + Condition at minimum)
    await expect(page.locator('[data-testid="workflow-node-start"]')).toBeVisible({
      timeout: 5000,
    });
    await expect(page.locator('[data-node-name="API0001"]')).toBeVisible({ timeout: 5000 });
    await expect(page.locator('[data-node-name="Condition0001"]')).toBeVisible({ timeout: 5000 });

    // Verify API node config persisted
    await selectNodeByName(page, 'API0001');
    await page.waitForTimeout(500);
    const persistedUrl = page.locator('[data-testid="config-url"]');
    if (await persistedUrl.isVisible({ timeout: 2000 }).catch(() => false)) {
      await expect(persistedUrl).toHaveValue('https://jsonplaceholder.typicode.com/todos/1');
    }

    // Verify Condition node config persisted
    await selectNodeByName(page, 'Condition0001');
    await page.waitForTimeout(500);
    const persistedCondConfig = page.locator('[data-testid="condition-config"]');
    if (await persistedCondConfig.isVisible({ timeout: 2000 }).catch(() => false)) {
      const persistedField = persistedCondConfig.locator('input').first();
      await expect(persistedField).toHaveValue('{{context.steps.API0001.output.completed}}');
    }

    // ── Step 10: Run the workflow ───────────────────────────────────────
    // No input variables → executes directly (no dialog)
    await page.locator('[data-testid="toolbar-run-btn"]').click();
    // Wait for execution to start (toast or stop button appears)
    await page.waitForTimeout(2000);

    // ── Step 11: Verify debug panel opens with execution data ───────────
    const debugPanel = page.locator('[data-testid="execution-debug-panel"]');
    await expect(debugPanel).toBeVisible({ timeout: 15000 });

    // Verify the "Execution" header is present
    await expect(debugPanel.locator('h3:has-text("Execution")')).toBeVisible();

    // Verify the accordion sections are visible (Input, Flow Log, Output)
    await expect(debugPanel.locator('text=Flow Log')).toBeVisible({ timeout: 5000 });

    // Wait for execution to progress — poll until we see per-node step items
    // The execution runs asynchronously: each node transitions pending→running→completed
    // Note: Start and End are control-flow markers, not executable steps.
    // Only API and Condition nodes appear as execution steps.
    await expect(debugPanel.locator('button:has-text("API0001")')).toBeVisible({ timeout: 15000 });

    // Wait for execution to complete (all nodes should finish within ~10s)
    // Look for the "Completed" status badge
    await expect(debugPanel.locator('text=Completed')).toBeVisible({ timeout: 30000 });

    // ── Step 12: Verify per-node progress in debug panel ────────────────
    // Each executable node should show as a step item with status icon and name

    // Verify API node step in the Flow Log
    const apiStep = debugPanel.locator('button:has-text("API0001")').first();
    await expect(apiStep).toBeVisible({ timeout: 5000 });

    // Verify Condition node step
    const conditionStep = debugPanel.locator('button:has-text("Condition0001")').first();
    await expect(conditionStep).toBeVisible({ timeout: 5000 });

    // ── Step 13: Verify step details are expandable ─────────────────────
    // Click on API step to expand and see output
    await apiStep.click();
    await page.waitForTimeout(500);

    // Should show the step output section
    const apiOutput = debugPanel.locator('text=Output').first();
    await expect(apiOutput).toBeVisible({ timeout: 3000 });

    // ── Step 14: Verify code toggle shows raw JSON ──────────────────────
    const codeToggle = debugPanel.locator('[data-testid="debug-code-toggle"]');
    if (await codeToggle.isVisible({ timeout: 2000 }).catch(() => false)) {
      await codeToggle.click();
      await page.waitForTimeout(500);
      // Raw JSON view should show execution data
      const rawJson = debugPanel.locator('pre').first();
      if (await rawJson.isVisible({ timeout: 2000 }).catch(() => false)) {
        const text = await rawJson.textContent();
        expect(text).toBeTruthy();
      }
      // Toggle back to accordion view
      await codeToggle.click();
      await page.waitForTimeout(300);
    }

    // ── Step 15: Close debug panel ──────────────────────────────────────
    const closeBtn = debugPanel.locator('button[aria-label="Close debug panel"]');
    await closeBtn.click();
    await expect(debugPanel).not.toBeVisible();

    // ── Step 16: Navigate back to list and delete ───────────────────────
    const backBtn = page.locator('[data-testid="toolbar-back-btn"]');
    if (await backBtn.isVisible()) {
      await backBtn.click();
    } else {
      await navigateToWorkflows(page);
    }

    await page.waitForTimeout(1000);

    // Delete (archive) the workflow
    await deleteWorkflowFromList(page, workflowName);

    // Verify workflow card shows "Archived" badge
    await page.waitForTimeout(1000);
    const archivedCard = page.locator('[role="button"]', { hasText: workflowName }).first();
    await expect(archivedCard.locator('text=Archived')).toBeVisible({ timeout: 5000 });
  });

  // ===========================================================================
  // TRIGGER TESTS
  // ===========================================================================

  /**
   * Helper: Create a simple Start → End workflow, save, and return IDs.
   */
  async function createSimpleWorkflow(
    page: import('@playwright/test').Page,
    name: string,
  ): Promise<{ projectId: string; workflowId: string; token: string }> {
    const { projectId, token } = await loginAndSetup(page);
    await navigateToWorkflows(page);
    const workflowId = await createWorkflowViaUI(page, name, 'Trigger E2E test');
    await waitForCanvasReady(page);

    // Add End node from Start (auto-creates Start → End edge)
    await addNodeViaHandleMenu(page, 'end');

    await saveWorkflow(page);
    return { projectId, workflowId, token };
  }

  test('Webhook trigger: create via UI, fire via API, verify in Monitor', async ({ page }) => {
    test.setTimeout(120_000);
    const triggerWorkflowName = `WebhookTriggerE2E${Date.now()}`;

    // ── 1. Create a simple workflow ────────────────────────────────────────
    const { projectId, workflowId, token } = await createSimpleWorkflow(page, triggerWorkflowName);

    // ── 2. Navigate to Triggers tab ────────────────────────────────────────
    const triggersTab = page.locator('[role="tab"]:has-text("Triggers")').first();
    await expect(triggersTab).toBeVisible({ timeout: 10000 });
    await triggersTab.click();
    await page.waitForTimeout(2000);

    // ── 3. Click "Add Trigger" and create webhook ──────────────────────────
    const addTriggerBtn = page.locator('button:has-text("Add Trigger")').first();
    await expect(addTriggerBtn).toBeVisible({ timeout: 5000 });
    await addTriggerBtn.click();
    await page.waitForTimeout(1000);

    // Verify the creation form appeared
    await expect(page.locator('h3:has-text("New Trigger")')).toBeVisible({ timeout: 5000 });

    // Webhook is the default type — click "Create Trigger" and wait for API response
    const createTriggerBtn = page.locator('button:has-text("Create Trigger")').first();
    await expect(createTriggerBtn).toBeVisible({ timeout: 3000 });

    const triggerApiPromise = page.waitForResponse(
      (resp) => resp.url().includes('/workflows/triggers') && resp.request().method() === 'POST',
      { timeout: 15000 },
    );
    await createTriggerBtn.click();
    const triggerApiResp = await triggerApiPromise;
    const triggerBody = await triggerApiResp.json();

    if (!triggerBody?.success) {
      throw new Error(`Trigger creation failed: ${JSON.stringify(triggerBody)}`);
    }

    await page.waitForTimeout(2000);

    // ── 4. Verify trigger card appeared ────────────────────────────────────
    await expect(page.locator('text=Webhook').first()).toBeVisible({ timeout: 5000 });

    // ── 5. Get trigger ID ──────────────────────────────────────────────────
    const triggerId = triggerBody?.data?.registrationId;
    expect(triggerId).toBeTruthy();

    // ── 6. Fire the webhook trigger via Runtime API ────────────────────────
    const RUNTIME_URL = 'http://localhost:3112';
    const fireResp = await page.request.post(
      `${RUNTIME_URL}/api/projects/${projectId}/workflows/triggers/${triggerId}/fire`,
      {
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        data: { test: true, source: 'e2e-webhook-test' },
      },
    );
    expect(fireResp.status()).toBe(202);

    // ── 7. Wait for execution to complete ──────────────────────────────────
    await page.waitForTimeout(8000);

    // ── 8. Navigate to Monitor tab ─────────────────────────────────────────
    const monitorTab = page.locator('[role="tab"]:has-text("Monitor")').first();
    await expect(monitorTab).toBeVisible({ timeout: 5000 });
    await monitorTab.click();
    await page.waitForTimeout(3000);

    // ── 9. Verify execution appears ────────────────────────────────────────
    await expect(page.getByRole('heading', { name: 'Execution History' })).toBeVisible({
      timeout: 5000,
    });

    // Wait for at least one execution row (button containing execution ID + status)
    const executionRow = page.locator('button:has(code)').first();
    await expect(executionRow).toBeVisible({ timeout: 30000 });

    // ── 10. Cleanup: delete the workflow ───────────────────────────────────
    await navigateToWorkflows(page);
    await page.waitForTimeout(1000);
    await deleteWorkflowFromList(page, triggerWorkflowName);
  });

  test('Scheduled trigger: create cron via UI, wait for fire, verify in Monitor', async ({
    page,
  }) => {
    test.setTimeout(180_000);
    const cronWorkflowName = `CronTriggerE2E${Date.now()}`;

    // ── 1. Create a simple workflow ────────────────────────────────────────
    const { projectId, workflowId } = await createSimpleWorkflow(page, cronWorkflowName);

    // ── 2. Navigate to Triggers tab ────────────────────────────────────────
    const triggersTab = page.locator('[role="tab"]:has-text("Triggers")').first();
    await expect(triggersTab).toBeVisible({ timeout: 10000 });
    await triggersTab.click();
    await page.waitForTimeout(2000);

    // ── 3. Click "Add Trigger" ─────────────────────────────────────────────
    const addTriggerBtn = page.locator('button:has-text("Add Trigger")').first();
    await expect(addTriggerBtn).toBeVisible({ timeout: 5000 });
    await addTriggerBtn.click();
    await page.waitForTimeout(1000);

    // Verify the creation form appeared
    await expect(page.locator('h3:has-text("New Trigger")')).toBeVisible({ timeout: 5000 });

    // ── 4. Select "Cron Schedule" type ─────────────────────────────────────
    const cronTypeBtn = page.locator('button:has-text("Cron Schedule")').first();
    await expect(cronTypeBtn).toBeVisible({ timeout: 3000 });
    await cronTypeBtn.click();
    await page.waitForTimeout(500);

    // ── 5. Select "Custom Cron" preset and enter every-minute expression ───
    const customCronPresetBtn = page.locator('button:has-text("Custom Cron")').first();
    await expect(customCronPresetBtn).toBeVisible({ timeout: 3000 });
    await customCronPresetBtn.click();
    await page.waitForTimeout(300);

    // Fill the cron expression input (placeholder: "0 9 * * 1-5")
    const cronInput = page.locator('input[placeholder="0 9 * * 1-5"]').first();
    await expect(cronInput).toBeVisible({ timeout: 3000 });
    await cronInput.fill('* * * * *');
    await page.waitForTimeout(300);

    // ── 6. Click "Create Trigger" and wait for API response ────────────────
    const createTriggerBtn = page.locator('button:has-text("Create Trigger")').first();
    await expect(createTriggerBtn).toBeVisible({ timeout: 3000 });

    const cronApiPromise = page.waitForResponse(
      (resp) => resp.url().includes('/workflows/triggers') && resp.request().method() === 'POST',
      { timeout: 15000 },
    );
    await createTriggerBtn.click();
    const cronApiResp = await cronApiPromise;
    const cronBody = await cronApiResp.json();
    if (!cronBody?.success) {
      throw new Error(`Cron trigger creation failed: ${JSON.stringify(cronBody)}`);
    }
    await page.waitForTimeout(2000);

    // ── 7. Verify cron trigger card appeared ───────────────────────────────
    await expect(page.locator('text=Cron Schedule').first()).toBeVisible({ timeout: 5000 });
    // Verify cron expression is displayed
    await expect(page.locator('text=* * * * *').first()).toBeVisible({ timeout: 3000 });

    // ── 8. Wait for the cron trigger to fire (~65 seconds) ─────────────────
    // Cron fires at the next minute boundary. Wait enough for one trigger.
    await page.waitForTimeout(70_000);

    // ── 9. Navigate to Monitor tab ─────────────────────────────────────────
    const monitorTab = page.locator('[role="tab"]:has-text("Monitor")').first();
    await expect(monitorTab).toBeVisible({ timeout: 5000 });
    await monitorTab.click();
    await page.waitForTimeout(5000);

    // ── 10. Verify execution appears ───────────────────────────────────────
    await expect(page.getByRole('heading', { name: 'Execution History' })).toBeVisible({
      timeout: 5000,
    });

    // Wait for at least one execution row (button containing execution ID + status)
    const executionRow = page.locator('button:has(code)').first();
    await expect(executionRow).toBeVisible({ timeout: 30000 });

    // ── 11. Pause the cron trigger to stop further firings ─────────────────
    await triggersTab.click();
    await page.waitForTimeout(2000);

    const pauseBtn = page.locator('button[aria-label="Pause trigger"]').first();
    if (await pauseBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
      await pauseBtn.click();
      await page.waitForTimeout(1000);
    }

    // ── 12. Cleanup: delete the workflow ───────────────────────────────────
    await navigateToWorkflows(page);
    await page.waitForTimeout(1000);
    await deleteWorkflowFromList(page, cronWorkflowName);
  });
});
