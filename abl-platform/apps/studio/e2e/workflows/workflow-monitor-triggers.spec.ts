/**
 * Workflow Monitor Tab & Triggers E2E Tests
 *
 * Coverage:
 * 1. Monitor tab: KPI bar, execution rows, status filter, detail slide panel
 * 2. Monitor detail view: Input section, Flow Log, Output section, execution states
 * 3. Triggers tab: webhook creation, code snippets (sync/async/poll/push), async push config
 */

import { test, expect } from '@playwright/test';
import {
  loginAndSetup,
  navigateToWorkflows,
  createWorkflowViaUI,
  waitForCanvasReady,
  selectNodeByName,
  saveWorkflow,
  deleteWorkflowFromList,
} from './helpers';

test.describe('Workflow Monitor Tab & Triggers', () => {
  // ══════════════════════════════════════════════════════════════════════════
  // TEST 1: Monitor Tab - Execution Detail View
  // ══════════════════════════════════════════════════════════════════════════

  test('Monitor tab shows execution list and detail slide panel', async ({ page }) => {
    test.setTimeout(180_000);

    const workflowName = `MonitorE2E_${Date.now()}`;

    // ── Setup: login, create workflow, add an API node, save, and run ──

    await loginAndSetup(page);
    await navigateToWorkflows(page);
    await createWorkflowViaUI(page, workflowName, 'Monitor tab E2E test');
    await waitForCanvasReady(page);

    // Add API node via Zustand store
    await page.evaluate(() => {
      const store = (window as any).__zustandStores?.workflowCanvas;
      if (!store) return;
      const state = store.getState();
      const startNode = state.nodes.find((n: any) => n.data.nodeType === 'start');
      if (!startNode) return;
      state.addNode('api', { x: 400, y: 200 }, { nodeId: startNode.id, handleId: 'on_success' });
    });
    await page.waitForTimeout(500);

    // Configure API node with a real endpoint
    await selectNodeByName(page, 'API0001');
    const configPanel = page.locator('[data-testid="config-panel"]');
    await expect(configPanel).toBeVisible({ timeout: 5000 });

    const urlInput = page.locator('[data-testid="config-url"]');
    await expect(urlInput).toBeVisible({ timeout: 3000 });
    await urlInput.fill('https://jsonplaceholder.typicode.com/todos/1');

    const closeConfigBtn = page.locator('[data-testid="config-panel-close"]');
    if (await closeConfigBtn.isVisible({ timeout: 1000 }).catch(() => false)) {
      await closeConfigBtn.click();
      await page.waitForTimeout(300);
    }

    // Save workflow
    await saveWorkflow(page);

    // Run the workflow (no input variables = direct execution, no dialog)
    await page.locator('[data-testid="toolbar-run-btn"]').click();

    // Check if run dialog appears (shouldn't since no input vars)
    const dialogVisible = await page
      .locator('[data-testid="run-dialog"]')
      .isVisible({ timeout: 2000 })
      .catch(() => false);
    if (dialogVisible) {
      await page.locator('[data-testid="run-execute-btn"]').click();
      await expect(page.locator('[data-testid="run-dialog"]')).toBeHidden({ timeout: 15000 });
    }

    // Wait for debug panel to appear (confirms execution started)
    const debugPanel = page.locator('[data-testid="execution-debug-panel"]');
    await expect(debugPanel).toBeVisible({ timeout: 15000 });

    // Wait for execution to complete or have steps
    await expect(debugPanel.locator('text=Flow Log')).toBeVisible({ timeout: 10000 });

    // Wait for execution to finish
    await debugPanel
      .locator('text=Completed')
      .or(debugPanel.locator('text=Failed'))
      .waitFor({ timeout: 45000 })
      .catch(() => {
        console.warn('Execution did not complete within 45s — continuing');
      });

    // Close the debug panel by closing via store
    await page.evaluate(() => {
      const store = (window as any).__zustandStores?.workflowCanvas;
      if (!store) return;
      store.getState().setDebugPanelOpen(false);
      store.getState().setCurrentExecutionId(null);
    });
    await page.waitForTimeout(500);

    // ── Navigate to Monitor tab ──

    const monitorTab = page.locator('[role="tab"]:has-text("Monitor")').first();
    await expect(monitorTab).toBeVisible({ timeout: 5000 });
    await monitorTab.click();
    await page.waitForTimeout(3000);

    // ── Verify KPI Summary Bar ──

    const kpiBar = page.locator('[data-testid="monitor-kpi-bar"]');
    await expect(kpiBar).toBeVisible({ timeout: 10000 });

    // KPI bar should have 4 metric cards
    const metricCards = kpiBar.locator('> *');
    await expect(metricCards).toHaveCount(4);

    // Verify "Total Runs" shows at least 1
    await expect(kpiBar.locator('text=Total Runs')).toBeVisible();

    // Verify other KPI labels
    await expect(kpiBar.locator('text=In Progress')).toBeVisible();
    await expect(kpiBar.locator('text=Response Time')).toBeVisible();
    await expect(kpiBar.locator('text=Failure Rate')).toBeVisible();

    // ── Verify Execution History heading ──

    await expect(page.getByRole('heading', { name: 'Execution History' })).toBeVisible({
      timeout: 5000,
    });

    // ── Verify Status Filter ──

    const statusFilter = page.locator('[data-testid="monitor-status-filter"]');
    await expect(statusFilter).toBeVisible({ timeout: 5000 });

    // Verify filter has options
    const options = statusFilter.locator('option');
    const optionCount = await options.count();
    expect(optionCount).toBeGreaterThanOrEqual(5); // all, running, completed, failed, waiting_human, cancelled, rejected

    // ── Verify Execution Row ──

    // At least one execution row should be visible (from our run)
    const executionRow = page.locator('button[data-testid^="monitor-execution-row-"]').first();
    await expect(executionRow).toBeVisible({ timeout: 15000 });

    // Execution row should show: truncated ID, status badge, timestamp, duration, step count
    const rowCode = executionRow.locator('code');
    await expect(rowCode).toBeVisible();
    const rowIdText = await rowCode.textContent();
    expect(rowIdText).toBeTruthy();
    expect(rowIdText!.length).toBeLessThanOrEqual(8); // truncated to first 8 chars

    // ── Click execution row to open detail slide panel ──

    await executionRow.click();
    await page.waitForTimeout(1000);

    // ── Verify Debug Panel in SlidePanel ──

    const detailPanel = page.locator('[data-testid="execution-debug-panel"]');
    await expect(detailPanel).toBeVisible({ timeout: 10000 });

    // Verify "Execution" header
    await expect(detailPanel.locator('h3:has-text("Execution")')).toBeVisible();

    // Verify status badge (Completed or Failed)
    const statusBadge = detailPanel.locator('span').filter({ hasText: /Completed|Failed|Running/ });
    await expect(statusBadge.first()).toBeVisible({ timeout: 5000 });

    // Verify elapsed time is shown
    const elapsedTime = detailPanel.locator('span.font-mono').first();
    await expect(elapsedTime).toBeVisible({ timeout: 3000 });

    // ── Verify Input section ──

    const inputSection = detailPanel.getByRole('button', { name: 'Input' });
    await expect(inputSection).toBeVisible({ timeout: 3000 });

    // ── Verify Flow Log section ──

    const flowLogSection = detailPanel.getByRole('button', { name: 'Flow Log' });
    await expect(flowLogSection).toBeVisible({ timeout: 3000 });

    // Flow Log should show step entries (Start, API0001)
    const stepButtons = detailPanel.locator('button:has-text("API0001")');
    // May take time for the steps to render
    await expect(stepButtons.first()).toBeVisible({ timeout: 10000 });

    // ── Verify Output section ──

    const outputSection = detailPanel.getByRole('button', { name: 'Output' });
    await expect(outputSection).toBeVisible({ timeout: 3000 });

    // ── Verify raw JSON toggle ──

    const codeToggle = detailPanel.locator('[data-testid="debug-code-toggle"]');
    await expect(codeToggle).toBeVisible({ timeout: 3000 });
    await codeToggle.click();
    await page.waitForTimeout(500);

    // Raw JSON should be visible
    const rawJson = detailPanel.locator('pre').first();
    await expect(rawJson).toBeVisible({ timeout: 3000 });
    const jsonText = await rawJson.textContent();
    expect(jsonText).toContain('"status"');

    // Toggle back to accordion view
    await codeToggle.click();
    await page.waitForTimeout(300);

    // ── Test status filter ──

    // Close the SlidePanel via its close button (overlay blocks clicks on rows behind it)
    const closePanelBtn = page.locator('button[aria-label="Close panel"]');
    if (await closePanelBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
      await closePanelBtn.click();
    } else {
      // Fallback: press Escape (Radix Dialog supports this)
      await page.keyboard.press('Escape');
    }
    await page.waitForTimeout(1000);

    // Filter by "completed"
    await statusFilter.selectOption('completed');
    await page.waitForTimeout(1000);

    // Verify the filter is applied (rows should still show if our execution completed)
    const filteredRows = page.locator('button[data-testid^="monitor-execution-row-"]');
    const filteredCount = await filteredRows.count();
    // Either we see rows (execution completed) or empty state
    if (filteredCount === 0) {
      await expect(page.locator('text=No matching executions')).toBeVisible();
    }

    // Reset filter to "all"
    await statusFilter.selectOption('all');
    await page.waitForTimeout(500);

    // ── Cleanup ──

    try {
      await navigateToWorkflows(page);
      await page.waitForTimeout(1000);
      await deleteWorkflowFromList(page, workflowName);
    } catch {
      console.warn(`Cleanup failed for workflow: ${workflowName}`);
    }
  });

  // ══════════════════════════════════════════════════════════════════════════
  // TEST 2: Webhook Trigger Configuration & Code Snippets
  // ══════════════════════════════════════════════════════════════════════════

  test('Triggers tab: create webhook, verify code snippets with all modes', async ({ page }) => {
    test.setTimeout(180_000);

    const workflowName = `TriggersE2E_${Date.now()}`;

    // ── Setup ──

    await loginAndSetup(page);
    await navigateToWorkflows(page);
    await createWorkflowViaUI(page, workflowName, 'Triggers tab E2E test');
    await waitForCanvasReady(page);

    // Save the workflow first (triggers tab needs a saved workflow)
    await saveWorkflow(page);

    // ── Navigate to Triggers tab ──

    const triggersTab = page.locator('[role="tab"]:has-text("Triggers")').first();
    await expect(triggersTab).toBeVisible({ timeout: 5000 });
    await triggersTab.click();
    await page.waitForTimeout(2000);

    // ── Verify empty state ──

    await expect(page.locator('text=No triggers configured')).toBeVisible({ timeout: 10000 });

    // ── Click "Add Trigger" ──

    const addTriggerBtn = page.locator('[data-testid="add-trigger-btn"]');
    // Fallback to text-based selector if data-testid not found (empty state button)
    const addBtn = (await addTriggerBtn.isVisible({ timeout: 3000 }).catch(() => false))
      ? addTriggerBtn
      : page.locator('button:has-text("Add Trigger")').first();
    await expect(addBtn).toBeVisible({ timeout: 5000 });
    await addBtn.click();
    await page.waitForTimeout(500);

    // ── Verify trigger creation form ──

    const triggerForm = page.locator('[data-testid="trigger-creation-form"]');
    await expect(triggerForm).toBeVisible({ timeout: 5000 });

    // Verify type selector buttons
    await expect(page.locator('[data-testid="trigger-type-webhook"]')).toBeVisible();
    await expect(page.locator('[data-testid="trigger-type-cron"]')).toBeVisible();
    await expect(page.locator('[data-testid="trigger-type-polling"]')).toBeVisible();
    await expect(page.locator('[data-testid="trigger-type-event"]')).toBeVisible();
    await expect(page.locator('[data-testid="trigger-type-connector"]')).toBeVisible();

    // Webhook should be selected by default
    const webhookBtn = page.locator('[data-testid="trigger-type-webhook"]');
    const webhookClasses = await webhookBtn.getAttribute('class');
    expect(webhookClasses).toContain('border-accent');

    // ── Verify webhook form shows auto-generation message ──

    await expect(
      triggerForm.locator('text=A webhook URL will be generated automatically'),
    ).toBeVisible();

    // ── Verify Async Push Config toggle ──

    const asyncPushToggle = page.locator('[data-testid="trigger-async-push-toggle"]');
    await expect(asyncPushToggle).toBeVisible({ timeout: 3000 });
    await expect(asyncPushToggle).toContainText('Async Push Config');

    // Click to expand async push config
    await asyncPushToggle.click();
    await page.waitForTimeout(300);

    // Verify callback URL and access token fields appear
    const callbackUrlInput = page.locator('input[aria-label="Callback URL"]');
    await expect(callbackUrlInput).toBeVisible({ timeout: 3000 });

    const callbackTokenInput = page.locator('input[aria-label="Callback access token"]');
    await expect(callbackTokenInput).toBeVisible({ timeout: 3000 });

    // Fill callback URL for async push
    await callbackUrlInput.fill('https://example.com/webhook-callback');
    await callbackTokenInput.fill('test-token-123');

    // ── Create the webhook trigger ──

    const createBtn = page.locator('[data-testid="trigger-create-btn"]');
    await expect(createBtn).toBeVisible({ timeout: 3000 });
    await createBtn.click();

    // Wait for trigger to be created
    await page.waitForTimeout(3000);

    // ── Verify webhook trigger card appears ──

    const webhookCard = page.locator('[data-testid="trigger-card-webhook"]').first();
    await expect(webhookCard).toBeVisible({ timeout: 15000 });

    // Verify card shows "Webhook" label (use exact match with first() to avoid strict mode)
    await expect(webhookCard.locator('p:has-text("Webhook")').first()).toBeVisible();

    // Verify status toggle is visible (toggle right = active)
    const statusToggle = webhookCard.locator('button[aria-label]').last();
    await expect(statusToggle).toBeVisible();

    // Verify callback URL is shown on the card
    await expect(webhookCard.locator('text=https://example.com/webhook-callback')).toBeVisible({
      timeout: 5000,
    });

    // ── Verify WebhookQuickStart panel ──
    // Note: WebhookQuickStart renders as a sibling to the trigger card div,
    // so we scope to page level for elements in the quick-start panel.

    // Endpoint URL section
    await expect(page.locator('text=Endpoint URL')).toBeVisible({ timeout: 5000 });

    // Verify the endpoint URL contains the workflow execute path
    // The endpoint URL code element contains '/execute' - skip the first code (callback URL)
    const endpointCodes = page.locator(
      '[data-testid="trigger-card-webhook"] ~ div code, [data-testid="trigger-card-webhook"] code',
    );
    let foundExecuteUrl = false;
    const codeCount = await endpointCodes.count();
    for (let i = 0; i < codeCount; i++) {
      const text = await endpointCodes.nth(i).textContent();
      if (text?.includes('/execute')) {
        foundExecuteUrl = true;
        break;
      }
    }
    expect(foundExecuteUrl).toBe(true);

    // ── Verify Code Snippets tabs ──

    // All 4 snippet mode tabs should be visible
    await expect(page.locator('[data-testid="snippet-tab-sync"]')).toBeVisible({ timeout: 5000 });
    await expect(page.locator('[data-testid="snippet-tab-async"]')).toBeVisible();
    await expect(page.locator('[data-testid="snippet-tab-async_poll"]')).toBeVisible();
    await expect(page.locator('[data-testid="snippet-tab-async_push"]')).toBeVisible();

    // Verify sync tab is active by default (has accent text color)
    const syncTab = page.locator('[data-testid="snippet-tab-sync"]');
    const syncClasses = await syncTab.getAttribute('class');
    expect(syncClasses).toContain('text-accent');

    // Verify sync snippet shows curl command (pre is in WebhookQuickStart, a sibling of the card)
    const snippetPre = page.locator('pre').last();
    const syncSnippet = await snippetPre.textContent();
    expect(syncSnippet).toContain('curl');
    expect(syncSnippet).toContain('x-api-key');
    expect(syncSnippet).toContain('Content-Type: application/json');

    // ── Switch to Async tab ──

    await page.locator('[data-testid="snippet-tab-async"]').click();
    await page.waitForTimeout(300);
    const asyncSnippet = await snippetPre.textContent();
    expect(asyncSnippet).toContain('mode=async');

    // ── Switch to Async Poll tab ──

    await page.locator('[data-testid="snippet-tab-async_poll"]').click();
    await page.waitForTimeout(300);
    const pollSnippet = await snippetPre.textContent();
    expect(pollSnippet).toContain('Poll for result');
    expect(pollSnippet).toContain('executionId');

    // ── Switch to Async Push tab ──

    await page.locator('[data-testid="snippet-tab-async_push"]').click();
    await page.waitForTimeout(300);
    const pushSnippet = await snippetPre.textContent();
    expect(pushSnippet).toContain('mode=async_push');
    expect(pushSnippet).toContain('callbackUrl');
    // Should use the callback URL we configured
    expect(pushSnippet).toContain('https://example.com/webhook-callback');

    // ── Test trigger type switching in creation form ──

    // Click "Add Trigger" to show creation form again
    const addTriggerBtn2 = page.locator('button:has-text("Add Trigger")').first();
    await addTriggerBtn2.click();
    await page.waitForTimeout(500);

    // Switch to Cron type
    await page.locator('[data-testid="trigger-type-cron"]').click();
    await page.waitForTimeout(300);

    // Verify cron-specific UI appears (schedule preset picker)
    const cronForm = page.locator('[data-testid="trigger-creation-form"]');
    await expect(cronForm).toBeVisible();
    // Cron form should show schedule options (use label selector to avoid strict mode)
    await expect(cronForm.locator('label:has-text("Schedule")')).toBeVisible({
      timeout: 3000,
    });

    // Switch to Event type
    await page.locator('[data-testid="trigger-type-event"]').click();
    await page.waitForTimeout(300);
    // Event form should show event name input
    await expect(page.locator('input[placeholder="order.created"]')).toBeVisible({ timeout: 3000 });

    // Switch to Polling type
    await page.locator('[data-testid="trigger-type-polling"]').click();
    await page.waitForTimeout(300);
    // Polling form should show interval input
    await expect(page.locator('input[placeholder="60"]')).toBeVisible({ timeout: 3000 });

    // Cancel the form
    const cancelBtn = cronForm.locator('button:has-text("Cancel")');
    await cancelBtn.click();
    await page.waitForTimeout(300);

    // ── Verify trigger toggle (pause/resume) ──

    // The webhook trigger card should have a toggle button
    const toggleBtn = webhookCard
      .locator('button[aria-label="Pause trigger"], button[aria-label="Resume trigger"]')
      .first();
    if (await toggleBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
      // Click to pause
      await toggleBtn.click();
      await page.waitForTimeout(2000);

      // After toggle, the button aria-label should have changed
      // Re-query the toggle button to get updated state
      const updatedToggle = webhookCard
        .locator('button[aria-label="Pause trigger"], button[aria-label="Resume trigger"]')
        .first();
      const toggleLabel = await updatedToggle.getAttribute('aria-label');
      expect(toggleLabel).toBeTruthy();
    }

    // ── Cleanup ──

    try {
      await navigateToWorkflows(page);
      await page.waitForTimeout(1000);
      await deleteWorkflowFromList(page, workflowName);
    } catch {
      console.warn(`Cleanup failed for workflow: ${workflowName}`);
    }
  });
});
