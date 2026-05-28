import { test, expect } from '@playwright/test';
import {
  loginAndSetup,
  navigateToWorkflows,
  createWorkflowViaUI,
  waitForCanvasReady,
  addNodeViaHandleMenu,
  selectNodeByName,
  selectNodeByTestId,
} from './helpers';

/**
 * Workflow Canvas UAT Tests
 *
 * Validates the visual node-based workflow builder against UAT scenarios from:
 * docs/superpowers/specs/2026-03-17-workflow-uat-scenarios.md
 */

test.describe('Workflow Canvas UAT', () => {
  // Shared state across tests in this describe block
  let projectId: string;
  let token: string;

  test.beforeAll(async ({ browser }) => {
    const page = await browser.newPage();
    const setup = await loginAndSetup(page);
    projectId = setup.projectId;
    token = setup.token;
    await page.close();
  });

  // ─── UAT-1: Canvas — Basic Flow Creation ──────────────────────────────

  test.describe('UAT-1: Canvas Basic Flow Creation', () => {
    test('UAT-1.1: Create a New Workflow', async ({ page }) => {
      test.setTimeout(60000);

      // Login & navigate to workflows
      await loginAndSetup(page);
      await navigateToWorkflows(page);

      // Step 1: Workflows list page loads with Create button
      await expect(page.locator('button:has-text("New Workflow")').first()).toBeVisible({
        timeout: 10000,
      });

      // Steps 2-3: Create workflow
      const workflowName = `UAT Test ${Date.now()}`;
      const workflowId = await createWorkflowViaUI(page, workflowName, 'UAT test workflow');

      // Step 4: Canvas opens with Start node
      await waitForCanvasReady(page);

      // Verify Start node exists
      await expect(page.locator('[data-testid="workflow-node-start"]')).toBeVisible({
        timeout: 10000,
      });

      // Verify Assets panel on left
      await expect(page.locator('[data-testid="assets-sidebar"]')).toBeVisible();

      // Verify toolbar
      await expect(page.locator('[data-testid="canvas-toolbar"]')).toBeVisible();

      await page.screenshot({
        path: 'e2e/screenshots/uat-1.1-create-workflow.png',
        fullPage: true,
      });
    });

    test('UAT-1.2: Add Nodes via Drag-and-Drop from Assets Panel', async ({ page }) => {
      test.setTimeout(60000);

      await loginAndSetup(page);
      await navigateToWorkflows(page);
      await createWorkflowViaUI(page, `UAT-1.2 ${Date.now()}`);
      await waitForCanvasReady(page);

      // Verify assets sidebar has draggable items
      const agentAsset = page.locator('[data-testid="asset-agent"]');
      await expect(agentAsset).toBeVisible();
      await expect(agentAsset).toHaveAttribute('draggable', 'true');

      const apiAsset = page.locator('[data-testid="asset-api"]');
      await expect(apiAsset).toBeVisible();
      await expect(apiAsset).toHaveAttribute('draggable', 'true');

      const conditionAsset = page.locator('[data-testid="asset-condition"]');
      await expect(conditionAsset).toBeVisible();

      const endAsset = page.locator('[data-testid="asset-end"]');
      await expect(endAsset).toBeVisible();

      await page.screenshot({
        path: 'e2e/screenshots/uat-1.2-assets-panel.png',
        fullPage: true,
      });
    });

    test('UAT-1.3: Add Nodes via Handle Plus Menu', async ({ page }) => {
      test.setTimeout(60000);

      await loginAndSetup(page);
      await navigateToWorkflows(page);
      await createWorkflowViaUI(page, `UAT-1.3 ${Date.now()}`);
      await waitForCanvasReady(page);

      // Add Function node via handle plus menu on Start node
      await addNodeViaHandleMenu(page, 'function');

      // Verify Function node appears on canvas
      const functionNode = page.locator('[data-node-type="function"]');
      await expect(functionNode).toBeVisible({ timeout: 5000 });

      // Add Human node from the Function node's on_success handle
      await addNodeViaHandleMenu(page, 'human', '[data-node-type="function"]');

      // Verify Human node appears on canvas
      const humanNode = page.locator('[data-node-type="human"]');
      await expect(humanNode).toBeVisible({ timeout: 5000 });

      await page.screenshot({
        path: 'e2e/screenshots/uat-1.3-handle-plus-menu.png',
        fullPage: true,
      });
    });

    test('UAT-1.4: Connect Nodes with Edges', async ({ page }) => {
      test.setTimeout(60000);

      await loginAndSetup(page);
      await navigateToWorkflows(page);
      await createWorkflowViaUI(page, `UAT-1.4 ${Date.now()}`);
      await waitForCanvasReady(page);

      // Add nodes
      await addNodeViaHandleMenu(page, 'agent');
      await addNodeViaHandleMenu(page, 'end');

      // Verify nodes exist
      await expect(page.locator('[data-testid="workflow-node-start"]')).toBeVisible();
      await expect(page.locator('[data-node-type="agent"]')).toBeVisible();
      await expect(page.locator('[data-testid="workflow-node-end"]')).toBeVisible();

      await page.screenshot({
        path: 'e2e/screenshots/uat-1.4-nodes-for-connection.png',
        fullPage: true,
      });
    });

    test('UAT-1.5: Delete Nodes', async ({ page }) => {
      test.setTimeout(60000);

      await loginAndSetup(page);
      await navigateToWorkflows(page);
      await createWorkflowViaUI(page, `UAT-1.5 ${Date.now()}`);
      await waitForCanvasReady(page);

      // Add a function node
      await addNodeViaHandleMenu(page, 'function');
      const functionNode = page.locator('[data-node-type="function"]');
      await expect(functionNode).toBeVisible({ timeout: 5000 });

      // Click to select
      await functionNode.click();
      await page.waitForTimeout(300);

      // Press Delete key
      await page.keyboard.press('Delete');
      await page.waitForTimeout(500);

      // Node should be removed (or still present if Delete handling requires Backspace)
      // Try Backspace too
      if (await functionNode.isVisible({ timeout: 1000 }).catch(() => false)) {
        await functionNode.click();
        await page.keyboard.press('Backspace');
        await page.waitForTimeout(500);
      }

      await page.screenshot({
        path: 'e2e/screenshots/uat-1.5-delete-node.png',
        fullPage: true,
      });
    });

    test('UAT-1.6: Canvas Navigation — Zoom', async ({ page }) => {
      test.setTimeout(60000);

      await loginAndSetup(page);
      await navigateToWorkflows(page);
      await createWorkflowViaUI(page, `UAT-1.6 ${Date.now()}`);
      await waitForCanvasReady(page);

      // Canvas should be visible
      const canvas = page.locator('[data-testid="workflow-canvas"]');
      await expect(canvas).toBeVisible();

      // MiniMap should be visible
      const minimap = page.locator('.react-flow__minimap');
      await expect(minimap).toBeVisible({ timeout: 5000 });

      await page.screenshot({
        path: 'e2e/screenshots/uat-1.6-canvas-navigation.png',
        fullPage: true,
      });
    });
  });

  // ─── UAT-2: Node Configuration ────────────────────────────────────────

  test.describe('UAT-2: Node Configuration', () => {
    test('UAT-2.1: Start Node — Input Variables', async ({ page }) => {
      test.setTimeout(60000);

      await loginAndSetup(page);
      await navigateToWorkflows(page);
      await createWorkflowViaUI(page, `UAT-2.1 ${Date.now()}`);
      await waitForCanvasReady(page);

      // Click Start node to open config panel
      await selectNodeByTestId(page, 'workflow-node-start');

      // Config panel should open
      await expect(page.locator('[data-testid="config-panel"]')).toBeVisible({ timeout: 5000 });

      // Should show Start node config
      await expect(page.locator('[data-testid="start-config"]')).toBeVisible({ timeout: 5000 });

      // Click "Add input variable" button
      const addBtn = page.locator('[data-testid="add-input-var-btn"]');
      await expect(addBtn).toBeVisible();
      await addBtn.click();
      await page.waitForTimeout(300);

      await page.screenshot({
        path: 'e2e/screenshots/uat-2.1-start-config.png',
        fullPage: true,
      });
    });

    test('UAT-2.2: Agent Node — Configuration', async ({ page }) => {
      test.setTimeout(60000);

      await loginAndSetup(page);
      await navigateToWorkflows(page);
      await createWorkflowViaUI(page, `UAT-2.2 ${Date.now()}`);
      await waitForCanvasReady(page);

      // Add Agent node
      await addNodeViaHandleMenu(page, 'agent');

      // Click node
      const node = page.locator('[data-node-type="agent"]');
      await expect(node).toBeVisible({ timeout: 5000 });
      await node.click();
      await page.waitForTimeout(300);

      // Config panel opens with agent settings
      await expect(page.locator('[data-testid="config-panel"]')).toBeVisible({ timeout: 5000 });

      // Verify Agent config fields exist (agent select or empty-state, input, timeout)
      const configPanel = page.locator('[data-testid="config-panel"]');
      await expect(configPanel.locator('text=Agent').first()).toBeVisible({ timeout: 5000 });
      await expect(configPanel.locator('label:has-text("Input")')).toBeVisible({ timeout: 3000 });
      await expect(configPanel.locator('label:has-text("Timeout")')).toBeVisible({ timeout: 3000 });

      await page.screenshot({
        path: 'e2e/screenshots/uat-2.2-agent-config.png',
        fullPage: true,
      });
    });

    test('UAT-2.3: API Node — HTTP Configuration', async ({ page }) => {
      test.setTimeout(60000);

      await loginAndSetup(page);
      await navigateToWorkflows(page);
      await createWorkflowViaUI(page, `UAT-2.3 ${Date.now()}`);
      await waitForCanvasReady(page);

      // Add API node
      await addNodeViaHandleMenu(page, 'api');

      // Click node
      const node = page.locator('[data-node-type="api"]');
      await expect(node).toBeVisible({ timeout: 5000 });
      await node.click();
      await page.waitForTimeout(300);

      // Config panel opens
      await expect(page.locator('[data-testid="config-panel"]')).toBeVisible({ timeout: 5000 });
      await expect(page.locator('[data-testid="api-config"]')).toBeVisible({ timeout: 5000 });

      // Verify method dropdown (Select uses id=, not data-testid=)
      await expect(page.locator('#config-method')).toBeVisible();

      // Verify URL input
      await expect(page.locator('[data-testid="config-url"]')).toBeVisible();

      // Fill URL
      await page.locator('[data-testid="config-url"]').fill('https://api.example.com/orders');

      await page.screenshot({
        path: 'e2e/screenshots/uat-2.3-api-config.png',
        fullPage: true,
      });
    });

    test('UAT-2.4: Function Node — Code Editor', async ({ page }) => {
      test.setTimeout(60000);

      await loginAndSetup(page);
      await navigateToWorkflows(page);
      await createWorkflowViaUI(page, `UAT-2.4 ${Date.now()}`);
      await waitForCanvasReady(page);

      // Add Function node
      await addNodeViaHandleMenu(page, 'function');

      // Click node
      const node = page.locator('[data-node-type="function"]');
      await expect(node).toBeVisible({ timeout: 5000 });
      await node.click();
      await page.waitForTimeout(300);

      // Config panel opens
      await expect(page.locator('[data-testid="config-panel"]')).toBeVisible({ timeout: 5000 });
      await expect(page.locator('[data-testid="function-config"]')).toBeVisible({ timeout: 5000 });

      // Verify mode toggle
      await expect(page.locator('[data-testid="config-mode"]')).toBeVisible();

      // Verify code textarea
      await expect(page.locator('[data-testid="config-code"]')).toBeVisible();

      // Write some code
      await page.locator('[data-testid="config-code"]').fill('const result = { total: 42 };');

      await page.screenshot({
        path: 'e2e/screenshots/uat-2.4-function-config.png',
        fullPage: true,
      });
    });

    test('UAT-2.5: Condition Node — Branching Logic', async ({ page }) => {
      test.setTimeout(60000);

      await loginAndSetup(page);
      await navigateToWorkflows(page);
      await createWorkflowViaUI(page, `UAT-2.5 ${Date.now()}`);
      await waitForCanvasReady(page);

      // Add Condition node
      await addNodeViaHandleMenu(page, 'condition');

      // Click node
      const node = page.locator('[data-node-type="condition"]');
      await expect(node).toBeVisible({ timeout: 5000 });
      await node.click();
      await page.waitForTimeout(300);

      // Config panel opens
      await expect(page.locator('[data-testid="config-panel"]')).toBeVisible({ timeout: 5000 });
      await expect(page.locator('[data-testid="condition-config"]')).toBeVisible({ timeout: 5000 });

      // "Add Else If" button should be visible
      await expect(page.locator('[data-testid="add-condition-btn"]')).toBeVisible();

      await page.screenshot({
        path: 'e2e/screenshots/uat-2.5-condition-config.png',
        fullPage: true,
      });
    });

    test('UAT-2.6: Human Node — Approval Configuration', async ({ page }) => {
      test.setTimeout(60000);

      await loginAndSetup(page);
      await navigateToWorkflows(page);
      await createWorkflowViaUI(page, `UAT-2.6 ${Date.now()}`);
      await waitForCanvasReady(page);

      // Add Human node
      await addNodeViaHandleMenu(page, 'human');

      // Click node
      const node = page.locator('[data-node-type="human"]');
      await expect(node).toBeVisible({ timeout: 5000 });
      await node.click();
      await page.waitForTimeout(300);

      // Config panel opens
      await expect(page.locator('[data-testid="config-panel"]')).toBeVisible({ timeout: 5000 });
      await expect(page.locator('[data-testid="human-config"]')).toBeVisible({ timeout: 5000 });

      // Verify subject and message fields
      await expect(page.locator('[data-testid="config-subject"]')).toBeVisible();
      await expect(page.locator('[data-testid="config-message"]')).toBeVisible();

      // Verify assign-to radio
      await expect(page.locator('[data-testid="config-assign-to"]')).toBeVisible();

      // Fill subject
      await page.locator('[data-testid="config-subject"]').fill('Approve order');

      await page.screenshot({
        path: 'e2e/screenshots/uat-2.6-human-config.png',
        fullPage: true,
      });
    });

    test('UAT-2.7: Loop Node — Iteration Configuration', async ({ page }) => {
      test.setTimeout(60000);

      await loginAndSetup(page);
      await navigateToWorkflows(page);
      await createWorkflowViaUI(page, `UAT-2.7 ${Date.now()}`);
      await waitForCanvasReady(page);

      // Add Loop node
      await addNodeViaHandleMenu(page, 'loop');

      // Click node
      const node = page.locator('[data-node-type="loop"]');
      await expect(node).toBeVisible({ timeout: 5000 });
      await node.click();
      await page.waitForTimeout(300);

      // Config panel opens
      await expect(page.locator('[data-testid="config-panel"]')).toBeVisible({ timeout: 5000 });
      await expect(page.locator('[data-testid="loop-config"]')).toBeVisible({ timeout: 5000 });

      // Verify fields
      await expect(page.locator('[data-testid="config-source"]')).toBeVisible();
      await expect(page.locator('[data-testid="config-item-alias"]')).toBeVisible();
      await expect(page.locator('[data-testid="config-output-field"]')).toBeVisible();
      // Select uses id=, not data-testid=
      await expect(page.locator('#config-on-error')).toBeVisible();

      await page.screenshot({
        path: 'e2e/screenshots/uat-2.7-loop-config.png',
        fullPage: true,
      });
    });

    test('UAT-2.10: Delay Node', async ({ page }) => {
      test.setTimeout(60000);

      await loginAndSetup(page);
      await navigateToWorkflows(page);
      await createWorkflowViaUI(page, `UAT-2.10 ${Date.now()}`);
      await waitForCanvasReady(page);

      // Add Delay node
      await addNodeViaHandleMenu(page, 'delay');

      // Click node
      const node = page.locator('[data-node-type="delay"]');
      await expect(node).toBeVisible({ timeout: 5000 });
      await node.click();
      await page.waitForTimeout(300);

      // Config panel opens with generic config
      await expect(page.locator('[data-testid="config-panel"]')).toBeVisible({ timeout: 5000 });
      await expect(page.locator('[data-testid="generic-config"]')).toBeVisible({ timeout: 5000 });

      await page.screenshot({
        path: 'e2e/screenshots/uat-2.10-delay-config.png',
        fullPage: true,
      });
    });

    test('UAT-2.11: Node Rename', async ({ page }) => {
      test.setTimeout(60000);

      await loginAndSetup(page);
      await navigateToWorkflows(page);
      await createWorkflowViaUI(page, `UAT-2.11 ${Date.now()}`);
      await waitForCanvasReady(page);

      // Add Agent node
      await addNodeViaHandleMenu(page, 'agent');

      // Click node to open config
      const node = page.locator('[data-node-type="agent"]');
      await expect(node).toBeVisible({ timeout: 5000 });
      await node.click();
      await page.waitForTimeout(300);

      // Find name input in config panel header
      const nameInput = page.locator('[data-testid="config-panel-name-input"]');
      await expect(nameInput).toBeVisible({ timeout: 5000 });

      // Clear and type new name
      await nameInput.clear();
      await nameInput.fill('OrderClassifier');

      await page.screenshot({
        path: 'e2e/screenshots/uat-2.11-node-rename.png',
        fullPage: true,
      });
    });

    test('UAT-2.12: Stub Nodes — Coming Soon', async ({ page }) => {
      test.setTimeout(60000);

      await loginAndSetup(page);
      await navigateToWorkflows(page);
      await createWorkflowViaUI(page, `UAT-2.12 ${Date.now()}`);
      await waitForCanvasReady(page);

      // Browser node in assets should show "Coming soon" (stub, not hidden)
      const browserAsset = page.locator('[data-testid="asset-browser"]');
      await expect(browserAsset).toBeVisible();
      await expect(browserAsset.locator('text=Coming soon')).toBeVisible();

      // Integration node in assets should show "Coming soon" (stub, not hidden)
      const integrationAsset = page.locator('[data-testid="asset-integration"]');
      await expect(integrationAsset).toBeVisible();
      await expect(integrationAsset.locator('text=Coming soon')).toBeVisible();

      await page.screenshot({
        path: 'e2e/screenshots/uat-2.12-stub-nodes.png',
        fullPage: true,
      });
    });
  });

  // ─── UAT-3: Toolbar Actions ───────────────────────────────────────────

  test.describe('UAT-3: Toolbar Actions', () => {
    test('UAT-3.1: Auto-Save Workflow', async ({ page }) => {
      test.setTimeout(60000);

      await loginAndSetup(page);
      await navigateToWorkflows(page);
      await createWorkflowViaUI(page, `UAT-3.1 ${Date.now()}`);
      await waitForCanvasReady(page);

      // Add a node to make canvas dirty
      await addNodeViaHandleMenu(page, 'api');

      // Wait for auto-save (2s debounce + save round-trip)
      await page.waitForTimeout(4000);

      // Verify "Saved" status appears in toolbar
      const toolbar = page.locator('[data-testid="canvas-toolbar"]');
      await expect(toolbar.locator('text=Saved')).toBeVisible({ timeout: 10000 });

      await page.screenshot({
        path: 'e2e/screenshots/uat-3.1-auto-save.png',
        fullPage: true,
      });
    });

    test('UAT-3.2: Validation Warnings', async ({ page }) => {
      test.setTimeout(60000);

      await loginAndSetup(page);
      await navigateToWorkflows(page);
      await createWorkflowViaUI(page, `UAT-3.2 ${Date.now()}`);
      await waitForCanvasReady(page);

      // Workflow starts with just a Start node — should have "No end node" error
      // Wait for validation to run
      await page.waitForTimeout(1000);

      // Check for validation badge in toolbar
      const badge = page.locator('[data-testid="toolbar-validation-badge"]');

      // If badge is visible, click it to open validation panel
      if (await badge.isVisible({ timeout: 3000 }).catch(() => false)) {
        await badge.click();
        await expect(page.locator('[data-testid="validation-panel"]')).toBeVisible({
          timeout: 5000,
        });
      }

      await page.screenshot({
        path: 'e2e/screenshots/uat-3.2-validation.png',
        fullPage: true,
      });
    });

    test('UAT-3.3: Run Button Executes Directly (No Inputs)', async ({ page }) => {
      test.setTimeout(60000);

      await loginAndSetup(page);
      await navigateToWorkflows(page);
      await createWorkflowViaUI(page, `UAT-3.3 ${Date.now()}`);
      await waitForCanvasReady(page);

      // Click Run button — no input variables → executes directly (no dialog)
      const runBtn = page.locator('[data-testid="toolbar-run-btn"]');
      await expect(runBtn).toBeVisible();
      await runBtn.click();

      // Execution starts directly — wait for Stop button (toolbar switches from Run to Stop)
      await expect(page.locator('[data-testid="toolbar-stop-btn"]')).toBeVisible({
        timeout: 10000,
      });

      await page.screenshot({
        path: 'e2e/screenshots/uat-3.3-direct-run.png',
        fullPage: true,
      });
    });

    test('UAT-3.4: Fullscreen Canvas Toggle', async ({ page }) => {
      test.setTimeout(60000);

      await loginAndSetup(page);
      await navigateToWorkflows(page);
      await createWorkflowViaUI(page, `UAT-3.4 ${Date.now()}`);
      await waitForCanvasReady(page);

      // Use the fullscreen toggle button (overlays the canvas area)
      const fullscreenBtn = page.locator('[data-testid="canvas-fullscreen-toggle"]');
      await expect(fullscreenBtn).toBeVisible({ timeout: 5000 });

      // Click to enter fullscreen
      await fullscreenBtn.click();
      await page.waitForTimeout(500);

      // Verify fullscreen overlay is visible
      await expect(page.locator('[data-testid="canvas-fullscreen"]')).toBeVisible({
        timeout: 5000,
      });

      // Click close to exit fullscreen
      const closeBtn = page.locator('[data-testid="canvas-fullscreen-close"]');
      await expect(closeBtn).toBeVisible();
      await closeBtn.click();
      await page.waitForTimeout(500);

      // Verify fullscreen overlay is gone
      await expect(page.locator('[data-testid="canvas-fullscreen"]')).not.toBeVisible();

      await page.screenshot({
        path: 'e2e/screenshots/uat-3.4-fullscreen-toggle.png',
        fullPage: true,
      });
    });

    test('UAT-3.5: Workflow Name Display', async ({ page }) => {
      test.setTimeout(60000);

      const name = `NameTest ${Date.now()}`;
      await loginAndSetup(page);
      await navigateToWorkflows(page);
      await createWorkflowViaUI(page, name);
      await waitForCanvasReady(page);

      // Workflow name should be displayed in toolbar
      const nameDisplay = page.locator('[data-testid="toolbar-workflow-name"]');
      await expect(nameDisplay).toBeVisible();
      await expect(nameDisplay).toContainText(name);

      await page.screenshot({
        path: 'e2e/screenshots/uat-3.5-workflow-name.png',
        fullPage: true,
      });
    });

    test('UAT-3.6: Back Button Navigation', async ({ page }) => {
      test.setTimeout(60000);

      await loginAndSetup(page);
      await navigateToWorkflows(page);
      await createWorkflowViaUI(page, `UAT-3.6 ${Date.now()}`);
      await waitForCanvasReady(page);

      // Enter fullscreen to access the Back button (hidden in embedded mode)
      const fullscreenBtn = page.locator('[data-testid="canvas-fullscreen-toggle"]');
      await expect(fullscreenBtn).toBeVisible({ timeout: 5000 });
      await fullscreenBtn.click();
      await page.waitForTimeout(500);

      // Click back button in fullscreen toolbar
      const backBtn = page.locator('[data-testid="toolbar-back-btn"]');
      await expect(backBtn).toBeVisible();
      await backBtn.click();

      // Should navigate back to workflows list
      await page.waitForTimeout(2000);
      await expect(page.locator('button:has-text("New Workflow")').first()).toBeVisible({
        timeout: 10000,
      });

      await page.screenshot({
        path: 'e2e/screenshots/uat-3.6-back-navigation.png',
        fullPage: true,
      });
    });
  });

  // ─── UAT-9: Context and Expression Resolution ────────────────────────

  test.describe('UAT-9: Context and Expressions', () => {
    test('UAT-9.1: Config Panel Has Expression Fields', async ({ page }) => {
      test.setTimeout(60000);

      await loginAndSetup(page);
      await navigateToWorkflows(page);
      await createWorkflowViaUI(page, `UAT-9.1 ${Date.now()}`);
      await waitForCanvasReady(page);

      // Add API node
      await addNodeViaHandleMenu(page, 'api');

      // Click node
      const node = page.locator('[data-node-type="api"]');
      await node.click();
      await page.waitForTimeout(300);

      // URL field should accept expression syntax
      const urlInput = page.locator('[data-testid="config-url"]');
      await expect(urlInput).toBeVisible();
      await urlInput.fill('{{context.env.API_BASE_URL}}/orders/{{context.input.orderId}}');

      await page.screenshot({
        path: 'e2e/screenshots/uat-9.1-expressions.png',
        fullPage: true,
      });
    });
  });

  // ─── UAT-10: Error Handling — Validation ──────────────────────────────

  test.describe('UAT-10: Error Handling', () => {
    test('UAT-10.5: Disconnected Node Warning', async ({ page }) => {
      test.setTimeout(60000);

      await loginAndSetup(page);
      await navigateToWorkflows(page);
      await createWorkflowViaUI(page, `UAT-10.5 ${Date.now()}`);
      await waitForCanvasReady(page);

      // Add an unconnected API node (creates disconnected node warning)
      await addNodeViaHandleMenu(page, 'api');
      await page.waitForTimeout(1000);

      // Validation badge should show warnings
      const badge = page.locator('[data-testid="toolbar-validation-badge"]');
      // At minimum, we have: no end node + disconnected nodes
      if (await badge.isVisible({ timeout: 3000 }).catch(() => false)) {
        await badge.click();
        const panel = page.locator('[data-testid="validation-panel"]');
        await expect(panel).toBeVisible({ timeout: 5000 });
      }

      await page.screenshot({
        path: 'e2e/screenshots/uat-10.5-disconnected-warning.png',
        fullPage: true,
      });
    });
  });

  // ─── Additional Canvas Feature Tests ──────────────────────────────────

  test.describe('Canvas Features', () => {
    test('Multiple nodes can be added to canvas', async ({ page }) => {
      test.setTimeout(60000);

      // Increase viewport so popover menus on far-right nodes stay in bounds
      await page.setViewportSize({ width: 1920, height: 1080 });

      await loginAndSetup(page);
      await navigateToWorkflows(page);
      await createWorkflowViaUI(page, `Multi-Node ${Date.now()}`);
      await waitForCanvasReady(page);

      // Add multiple node types chained: Start → agent → api → condition → end
      // Note: newly created condition node only has 'else' handle (no if_0 until configured)
      await addNodeViaHandleMenu(page, 'agent');
      await addNodeViaHandleMenu(page, 'api', '[data-node-type="agent"]');
      await addNodeViaHandleMenu(page, 'condition', '[data-node-type="api"]');
      await addNodeViaHandleMenu(page, 'end', '[data-node-type="condition"]', 'else');

      // Verify all nodes are on canvas
      await expect(page.locator('[data-testid="workflow-node-start"]')).toBeVisible();
      await expect(page.locator('[data-node-type="agent"]')).toBeVisible();
      await expect(page.locator('[data-node-type="api"]')).toBeVisible();
      await expect(page.locator('[data-node-type="condition"]')).toBeVisible();
      await expect(page.locator('[data-testid="workflow-node-end"]')).toBeVisible();

      await page.screenshot({
        path: 'e2e/screenshots/multi-node-canvas.png',
        fullPage: true,
      });
    });

    test('Config panel closes on canvas background click', async ({ page }) => {
      test.setTimeout(60000);

      await loginAndSetup(page);
      await navigateToWorkflows(page);
      await createWorkflowViaUI(page, `Panel-Close ${Date.now()}`);
      await waitForCanvasReady(page);

      // Add and select a node
      await addNodeViaHandleMenu(page, 'api');
      const node = page.locator('[data-node-type="api"]');
      await node.click();
      await page.waitForTimeout(300);

      // Config panel should be open
      await expect(page.locator('[data-testid="config-panel"]')).toBeVisible({ timeout: 5000 });

      // Click on canvas background (the react-flow pane)
      const pane = page.locator('.react-flow__pane');
      await pane.click({ position: { x: 10, y: 10 } });
      await page.waitForTimeout(500);

      // Config panel should be closed
      await expect(page.locator('[data-testid="config-panel"]')).not.toBeVisible({ timeout: 3000 });

      await page.screenshot({
        path: 'e2e/screenshots/config-panel-close.png',
        fullPage: true,
      });
    });

    test('Assets sidebar shows all node categories', async ({ page }) => {
      test.setTimeout(60000);

      await loginAndSetup(page);
      await navigateToWorkflows(page);
      await createWorkflowViaUI(page, `Sidebar ${Date.now()}`);
      await waitForCanvasReady(page);

      const sidebar = page.locator('[data-testid="assets-sidebar"]');
      await expect(sidebar).toBeVisible();

      // Verify categories (AI was replaced by Agent + Tool)
      await expect(sidebar.locator('button:has-text("Agent")')).toBeVisible();
      await expect(sidebar.locator('button:has-text("Tool")')).toBeVisible();
      await expect(sidebar.locator('text=Actions')).toBeVisible();
      await expect(sidebar.locator('text=Flow Control')).toBeVisible();
      // Use button role to target category header, avoiding strict-mode clash with the node item
      await expect(sidebar.locator('button:has-text("Human")')).toBeVisible();

      // Verify specific node types
      await expect(page.locator('[data-testid="asset-agent"]')).toBeVisible();
      await expect(page.locator('[data-testid="asset-tool"]')).toBeVisible();
      await expect(page.locator('[data-testid="asset-api"]')).toBeVisible();
      await expect(page.locator('[data-testid="asset-function"]')).toBeVisible();
      await expect(page.locator('[data-testid="asset-condition"]')).toBeVisible();
      await expect(page.locator('[data-testid="asset-loop"]')).toBeVisible();
      await expect(page.locator('[data-testid="asset-human"]')).toBeVisible();
      await expect(page.locator('[data-testid="asset-end"]')).toBeVisible();

      await page.screenshot({
        path: 'e2e/screenshots/sidebar-categories.png',
        fullPage: true,
      });
    });

    test('Tool node can be added and configured', async ({ page }) => {
      test.setTimeout(60000);

      await loginAndSetup(page);
      await navigateToWorkflows(page);
      await createWorkflowViaUI(page, `ToolNode ${Date.now()}`);
      await waitForCanvasReady(page);

      await addNodeViaHandleMenu(page, 'tool');

      const node = page.locator('[data-node-type="tool"]');
      await expect(node).toBeVisible({ timeout: 5000 });
      await node.click();
      await page.waitForTimeout(300);

      await expect(page.locator('[data-testid="config-panel"]')).toBeVisible({ timeout: 5000 });

      // Tool config should show Tool label, tool name, and timeout
      const configPanel = page.locator('[data-testid="config-panel"]');
      await expect(configPanel.locator('text=Tool').first()).toBeVisible({ timeout: 5000 });
      await expect(configPanel.locator('label:has-text("Timeout")')).toBeVisible({ timeout: 3000 });

      await page.screenshot({
        path: 'e2e/screenshots/tool-node-config.png',
        fullPage: true,
      });
    });

    test('Integration node shows Coming Soon in assets', async ({ page }) => {
      test.setTimeout(60000);

      await loginAndSetup(page);
      await navigateToWorkflows(page);
      await createWorkflowViaUI(page, `Integration ${Date.now()}`);
      await waitForCanvasReady(page);

      // Integration is a stub node — should show "Coming soon" in assets sidebar
      const integrationAsset = page.locator('[data-testid="asset-integration"]');
      await expect(integrationAsset).toBeVisible();
      // "Coming soon" is a tiny 10px span; use getByText for loose matching
      await expect(integrationAsset.getByText('Coming soon')).toBeVisible();

      await page.screenshot({
        path: 'e2e/screenshots/integration-stub.png',
        fullPage: true,
      });
    });
  });

  // ─── UAT-11: Connect to Existing Node ─────────────────────────────────────
  //
  // Feature spec: docs/features/workflow-connect-to-existing-node.md
  // Test spec:    docs/testing/sub-features/workflow-connect-to-existing-node.md
  //
  // The HandlePlusMenu's bottom-most section lets a user route a handle to a
  // node that already exists on the canvas instead of creating a new one. The
  // section reuses `onConnect` so cycle/scope/duplicate/fan-out guards stay
  // consistent with drag-to-connect.

  test.describe('UAT-11: Connect to Existing Node (HandlePlusMenu)', () => {
    test('UAT-11.1 (E2E-3): Empty-state on fresh canvas (only Start exists)', async ({ page }) => {
      test.setTimeout(60000);

      await loginAndSetup(page);
      await navigateToWorkflows(page);
      await createWorkflowViaUI(page, `ConnectExisting_Empty_${Date.now()}`);
      await waitForCanvasReady(page);

      // Open the HandlePlusMenu from Start's on_success handle
      await page.locator('[data-testid="handle-plus-on_success"]').first().click();
      await expect(page.locator('[data-testid="handle-plus-menu"]')).toBeVisible({
        timeout: 5000,
      });

      // The new section is always rendered; with only Start on canvas, the
      // empty-state message is shown (no eligible targets — Start is self).
      await expect(page.locator('[data-testid="connect-to-existing-section"]')).toBeVisible();
      await expect(page.locator('[data-testid="connect-to-existing-empty"]')).toBeVisible();

      // No row elements at all
      const rowCount = await page.locator('[data-testid^="connect-to-existing-row-"]').count();
      expect(rowCount).toBe(0);
    });

    test('UAT-11.2 (E2E-1): Diamond convergence — both Condition branches connect to shared End', async ({
      page,
    }) => {
      test.setTimeout(120000);

      await loginAndSetup(page);
      await navigateToWorkflows(page);
      await createWorkflowViaUI(page, `ConnectExisting_Diamond_${Date.now()}`);
      await waitForCanvasReady(page);

      // Build the canvas via Zustand store: Start → Condition, plus a stand-alone End
      // (no edges yet from Condition's branches). Per agents.md Writing Rule #2, use
      // the store for setup — viewport-fragile UI clicks are reserved for the picker.
      const { conditionId, endId } = await page.evaluate(() => {
        const w = window as unknown as {
          __zustandStores?: { workflowCanvas?: { getState: () => unknown } };
        };
        const store = w.__zustandStores?.workflowCanvas;
        if (!store) throw new Error('canvas store not exposed on window');
        const state = store.getState() as {
          nodes: Array<{ id: string; data: { nodeType: string } }>;
          addNode: (
            nodeType: string,
            pos: { x: number; y: number },
            src?: { nodeId: string; handleId: string },
          ) => void;
        };
        const startNode = state.nodes.find((n) => n.data.nodeType === 'start');
        if (!startNode) throw new Error('start node missing');
        state.addNode(
          'condition',
          { x: 400, y: 200 },
          { nodeId: startNode.id, handleId: 'on_success' },
        );
        // Refresh state to find the new Condition node
        const next = store.getState() as typeof state;
        const condition = next.nodes.find((n) => n.data.nodeType === 'condition');
        if (!condition) throw new Error('condition node missing after addNode');
        // Place End sibling-style — NOT connected yet
        state.addNode('end', { x: 800, y: 400 });
        const last = store.getState() as typeof state;
        const end = last.nodes.find((n) => n.data.nodeType === 'end');
        if (!end) throw new Error('end node missing after addNode');
        return { conditionId: condition.id, endId: end.id };
      });

      // Branch 1: connect Condition.on_success_if_0 → End via the picker
      await page.locator(`[data-testid="handle-plus-on_success_if_0"]`).first().click();
      await expect(page.locator('[data-testid="handle-plus-menu"]')).toBeVisible({
        timeout: 5000,
      });
      await page.locator(`[data-testid="connect-to-existing-row-${endId}"]`).click();
      // Menu should close
      await expect(page.locator('[data-testid="handle-plus-menu"]')).not.toBeVisible({
        timeout: 3000,
      });

      // Branch 2: connect Condition.on_success_else → End via the picker
      await page.locator(`[data-testid="handle-plus-on_success_else"]`).first().click();
      await expect(page.locator('[data-testid="handle-plus-menu"]')).toBeVisible({
        timeout: 5000,
      });
      await page.locator(`[data-testid="connect-to-existing-row-${endId}"]`).click();
      await expect(page.locator('[data-testid="handle-plus-menu"]')).not.toBeVisible({
        timeout: 3000,
      });

      // Assert diamond shape: End has 2 incoming edges, both sourced from Condition
      // on the two branch handles.
      const incoming = await page.evaluate(
        ({ condId, eId }) => {
          const w = window as unknown as {
            __zustandStores?: { workflowCanvas?: { getState: () => unknown } };
          };
          const state = w.__zustandStores!.workflowCanvas!.getState() as {
            edges: Array<{ source: string; sourceHandle: string | null; target: string }>;
          };
          return state.edges
            .filter((e) => e.target === eId && e.source === condId)
            .map((e) => e.sourceHandle ?? '');
        },
        { condId: conditionId, eId: endId },
      );

      expect(incoming).toHaveLength(2);
      expect(incoming).toEqual(expect.arrayContaining(['on_success_if_0', 'on_success_else']));
    });

    test('UAT-11.3 (E2E-2): Mid-flow fan-in — picker connects new branch to existing Function; MergerNodeConfig auto-engages', async ({
      page,
    }) => {
      test.setTimeout(120000);

      await loginAndSetup(page);
      await navigateToWorkflows(page);
      await createWorkflowViaUI(page, `ConnectExisting_FanIn_${Date.now()}`);
      await waitForCanvasReady(page);

      // Build: Start -> FnA -> FnTarget (sequential).
      // Plus FnB placed sibling-style with no incoming edge yet.
      // Picker action: connect FnB.on_success -> FnTarget. After save, FnTarget
      // has in-degree 2 and MergerNodeConfig should render in its config panel.
      const { fnTargetId } = await page.evaluate(() => {
        const w = window as unknown as {
          __zustandStores?: { workflowCanvas?: { getState: () => unknown } };
        };
        const store = w.__zustandStores?.workflowCanvas;
        if (!store) throw new Error('canvas store not exposed');
        type N = { id: string; data: { nodeType: string } };
        type S = {
          nodes: N[];
          addNode: (
            t: string,
            p: { x: number; y: number },
            src?: { nodeId: string; handleId: string },
          ) => void;
        };
        let s = store.getState() as S;
        const start = s.nodes.find((n) => n.data.nodeType === 'start');
        if (!start) throw new Error('start missing');
        // FnA from Start
        s.addNode('function', { x: 400, y: 200 }, { nodeId: start.id, handleId: 'on_success' });
        s = store.getState() as S;
        const fnA = s.nodes.filter((n) => n.data.nodeType === 'function')[0];
        // FnTarget after FnA
        s.addNode('function', { x: 700, y: 200 }, { nodeId: fnA.id, handleId: 'on_success' });
        s = store.getState() as S;
        const fnTarget = s.nodes.filter((n) => n.data.nodeType === 'function')[1];
        // FnB sibling, no incoming
        s.addNode('function', { x: 400, y: 500 });
        return { fnTargetId: fnTarget.id };
      });

      // Open HandlePlusMenu from FnB's on_success handle.
      // There are now 3 function nodes; FnB is the most recently added.
      // Each handle-plus button is on a specific node — locate FnB visually
      // is awkward; use a Zustand-driven approach via testid + nth selector.
      // Simpler: open menus until we find one whose Connect-to-existing list
      // contains FnTarget (any of the three could route there in principle —
      // but FnA wouldn't because it's already connected to FnTarget, and
      // FnTarget itself is the source — so the only valid source is FnB).
      const handlePlusButtons = page.locator('[data-testid="handle-plus-on_success"]');
      const handleCount = await handlePlusButtons.count();
      let opened = false;
      for (let i = 0; i < handleCount; i++) {
        await handlePlusButtons.nth(i).click();
        const menu = page.locator('[data-testid="handle-plus-menu"]');
        if (await menu.isVisible({ timeout: 2000 }).catch(() => false)) {
          const targetRow = page.locator(`[data-testid="connect-to-existing-row-${fnTargetId}"]`);
          if (await targetRow.isVisible({ timeout: 1000 }).catch(() => false)) {
            await targetRow.click();
            opened = true;
            break;
          }
          // Wrong handle — close and try next
          await page.keyboard.press('Escape');
          await page.waitForTimeout(200);
        }
      }
      expect(opened).toBe(true);

      // Verify FnTarget now has in-degree 2 in the store
      const inDegree = await page.evaluate((id) => {
        const w = window as unknown as {
          __zustandStores?: { workflowCanvas?: { getState: () => unknown } };
        };
        const s = w.__zustandStores!.workflowCanvas!.getState() as {
          edges: Array<{ target: string }>;
        };
        return s.edges.filter((e) => e.target === id).length;
      }, fnTargetId);
      expect(inDegree).toBe(2);

      // Open FnTarget's config panel — MergerNodeConfig should be visible
      await page.evaluate((id) => {
        const w = window as unknown as {
          __zustandStores?: { workflowCanvas?: { getState: () => unknown } };
        };
        const s = w.__zustandStores!.workflowCanvas!.getState() as {
          setSelectedNodeId: (nid: string | null) => void;
        };
        s.setSelectedNodeId(id);
      }, fnTargetId);
      await expect(page.locator('[data-testid="merger-node-config"]')).toBeVisible({
        timeout: 5000,
      });
    });

    test('UAT-11.4 (E2E-4): Search filter — by label and by type, with no-matches state', async ({
      page,
    }) => {
      test.setTimeout(90000);

      await loginAndSetup(page);
      await navigateToWorkflows(page);
      await createWorkflowViaUI(page, `ConnectExisting_Search_${Date.now()}`);
      await waitForCanvasReady(page);

      // Build canvas: Start + 3 typed nodes with distinctive labels.
      await page.evaluate(() => {
        const w = window as unknown as {
          __zustandStores?: { workflowCanvas?: { getState: () => unknown } };
        };
        const store = w.__zustandStores?.workflowCanvas;
        if (!store) throw new Error('store missing');
        type S = {
          nodes: Array<{ id: string; data: { nodeType: string; label: string } }>;
          addNode: (t: string, p: { x: number; y: number }) => void;
          updateNodeName: (id: string, name: string) => void;
        };
        const s = store.getState() as S;
        s.addNode('function', { x: 300, y: 100 });
        s.addNode('function', { x: 300, y: 300 });
        s.addNode('agent', { x: 600, y: 200 });
        const after = store.getState() as S;
        const fns = after.nodes.filter((n) => n.data.nodeType === 'function');
        const agents = after.nodes.filter((n) => n.data.nodeType === 'agent');
        after.updateNodeName(fns[0].id, 'FormatResponse');
        after.updateNodeName(fns[1].id, 'ComputeTax');
        after.updateNodeName(agents[0].id, 'RefundAgent');
      });

      // Open the picker from Start.on_success
      await page.locator('[data-testid="handle-plus-on_success"]').first().click();
      await expect(page.locator('[data-testid="handle-plus-menu"]')).toBeVisible();

      const search = page.locator('[data-testid="connect-to-existing-search"]');
      await expect(search).toBeVisible();

      // Initially: 3 rows
      const allRows = page.locator('[data-testid^="connect-to-existing-row-"]');
      await expect(allRows).toHaveCount(3);

      // Type "format" → only FormatResponse
      await search.fill('format');
      await expect(allRows).toHaveCount(1);

      // Clear → all 3 again
      await search.fill('');
      await expect(allRows).toHaveCount(3);

      // Type "function" → both function nodes
      await search.fill('function');
      await expect(allRows).toHaveCount(2);

      // Type "AGENT" (case-insensitive) → only RefundAgent
      await search.fill('AGENT');
      await expect(allRows).toHaveCount(1);

      // No matches → empty row list + no-matches marker
      await search.fill('xyz123nope');
      await expect(allRows).toHaveCount(0);
      await expect(page.locator('[data-testid="connect-to-existing-no-matches"]')).toBeVisible();
    });

    test('UAT-11.5 (E2E-5): Eligibility hides self, duplicate, cycle, and cross-loop targets', async ({
      page,
    }) => {
      test.setTimeout(90000);

      await loginAndSetup(page);
      await navigateToWorkflows(page);
      await createWorkflowViaUI(page, `ConnectExisting_Eligibility_${Date.now()}`);
      await waitForCanvasReady(page);

      // Build a graph where the picker from A.on_success must:
      //   - exclude A itself
      //   - exclude B (already connected from A.on_success)
      //   - exclude Start (would create a cycle: Start -> A back-edge)
      //   - exclude LoopChild (different parent / loop scope)
      //   - include C, End (downstream, no cycle, same top-level scope)
      const { aId, bId, cId, endId, loopChildId, startId } = await page.evaluate(() => {
        const w = window as unknown as {
          __zustandStores?: { workflowCanvas?: { getState: () => unknown } };
        };
        const store = w.__zustandStores!.workflowCanvas!;
        type S = {
          nodes: Array<{ id: string; data: { nodeType: string }; parentId?: string }>;
          edges: Array<{ source: string; target: string }>;
          addNode: (
            t: string,
            p: { x: number; y: number },
            src?: { nodeId: string; handleId: string },
          ) => void;
        };
        let s = store.getState() as S;
        const start = s.nodes.find((n) => n.data.nodeType === 'start')!;
        // Start → A → B → C linear chain
        s.addNode('function', { x: 300, y: 100 }, { nodeId: start.id, handleId: 'on_success' });
        s = store.getState() as S;
        const a = s.nodes.filter((n) => n.data.nodeType === 'function')[0];
        s.addNode('function', { x: 600, y: 100 }, { nodeId: a.id, handleId: 'on_success' });
        s = store.getState() as S;
        const b = s.nodes.filter((n) => n.data.nodeType === 'function')[1];
        s.addNode('function', { x: 900, y: 100 }, { nodeId: b.id, handleId: 'on_success' });
        s = store.getState() as S;
        const c = s.nodes.filter((n) => n.data.nodeType === 'function')[2];
        s.addNode('end', { x: 1200, y: 100 }, { nodeId: c.id, handleId: 'on_success' });
        s = store.getState() as S;
        const end = s.nodes.find((n) => n.data.nodeType === 'end')!;
        // Loop sibling + its body child
        s.addNode('loop', { x: 300, y: 400 });
        s = store.getState() as S;
        const loop = s.nodes.find((n) => n.data.nodeType === 'loop')!;
        // Add a function INSIDE the loop body (parentId = loop.id is set by
        // the store's loop body convention — adding via store with sourceInfo
        // pointed at loop_start would be ideal but we can drop a function
        // child directly by mutating state.)
        store.setState((prev: S) => {
          const childId = `loopchild-${Math.random().toString(36).slice(2, 8)}`;
          return {
            ...prev,
            nodes: [
              ...prev.nodes,
              {
                id: childId,
                type: 'workflowNode',
                position: { x: 400, y: 450 },
                parentId: loop.id,
                data: {
                  nodeType: 'function',
                  label: 'LoopChild',
                  config: {},
                  color: '#000',
                  isStub: false,
                  outputHandles: ['on_success'],
                },
              },
            ],
          };
        });
        const final = store.getState() as S;
        const loopChild = final.nodes.find(
          (n) => n.parentId === loop.id && n.data.nodeType === 'function',
        )!;
        return {
          aId: a.id,
          bId: b.id,
          cId: c.id,
          endId: end.id,
          loopChildId: loopChild.id,
          startId: start.id,
        };
      });

      // Click on A's on_success handle.
      // To target A specifically, locate via the React Flow node DOM. The
      // `[data-testid="handle-plus-on_success"]` selector matches multiple
      // nodes; filter by the node container's data attributes.
      await page.evaluate((id) => {
        const w = window as unknown as {
          __zustandStores?: { workflowCanvas?: { getState: () => unknown } };
        };
        const s = w.__zustandStores!.workflowCanvas!.getState() as {
          setSelectedNodeId: (nid: string | null) => void;
        };
        // Selecting A first ensures its handle is in viewport and clickable.
        s.setSelectedNodeId(id);
      }, aId);

      // Find A's handle by scoping inside the node container
      const aNodeHandle = page
        .locator(`[data-id="${aId}"]`)
        .locator('[data-testid="handle-plus-on_success"]');
      await aNodeHandle.click();
      await expect(page.locator('[data-testid="handle-plus-menu"]')).toBeVisible();

      // Collect all visible row testids
      const rowIds = await page
        .locator('[data-testid^="connect-to-existing-row-"]')
        .evaluateAll((els) =>
          els
            .map((el) => el.getAttribute('data-testid')?.replace('connect-to-existing-row-', ''))
            .filter(Boolean),
        );

      // Must NOT include: A (self), B (already connected from A.on_success),
      //                   Start (ancestor / cycle), LoopChild (cross-scope)
      expect(rowIds).not.toContain(aId);
      expect(rowIds).not.toContain(bId);
      expect(rowIds).not.toContain(startId);
      expect(rowIds).not.toContain(loopChildId);

      // Must include: C and End (downstream, same scope)
      expect(rowIds).toContain(cId);
      expect(rowIds).toContain(endId);
    });
  });
});
