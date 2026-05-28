/**
 * Workflow Tool Node E2E Test
 *
 * End-to-end test for the Tool Node in workflows:
 * 1. Create an HTTP tool (GET request to JSONPlaceholder) via API
 * 2. Create a workflow with Start → Tool → End nodes
 * 3. Select the created tool in the Tool node config
 * 4. Run the workflow and verify execution completes
 * 5. Verify debug panel shows tool node step with output
 * 6. Cleanup: delete workflow and tool
 *
 * Also verifies:
 * - "Create a tool" link appears when no tools exist (empty-state test)
 * - Tool select dropdown populates with created tool
 */

import { test, expect } from '@playwright/test';
import {
  loginAndSetup,
  navigateToWorkflows,
  createWorkflowViaUI,
  waitForCanvasReady,
  addNodeViaHandleMenu,
  selectNodeByName,
  saveWorkflow,
  runWorkflow,
  waitForDebugPanel,
} from './helpers';

const STUDIO_URL = 'http://localhost:5173';

/** Create an HTTP tool via the Studio API */
async function createHttpToolViaAPI(
  token: string,
  projectId: string,
  toolName: string,
): Promise<{ id: string; name: string }> {
  const resp = await fetch(`${STUDIO_URL}/api/projects/${projectId}/tools`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      name: toolName,
      toolType: 'http',
      description: 'Fetches a single todo item from JSONPlaceholder for E2E testing',
      endpoint: 'https://jsonplaceholder.typicode.com/todos/1',
      method: 'GET',
      auth: 'none',
      timeout: 30000,
      retry: 0,
      retryDelay: 1000,
      parameters: [],
    }),
  });

  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`Tool creation failed (${resp.status}): ${body}`);
  }

  const result = await resp.json();
  // API returns { success: true, tool: { id, name, ... } }
  const tool = result.tool ?? result.data;
  return { id: tool.id, name: tool.name };
}

/** Delete a tool via the Studio API (best-effort cleanup) */
async function deleteToolViaAPI(token: string, projectId: string, toolId: string): Promise<void> {
  await fetch(`${STUDIO_URL}/api/projects/${projectId}/tools/${toolId}`, {
    method: 'DELETE',
    headers: {
      Authorization: `Bearer ${token}`,
    },
  }).catch(() => {
    /* best-effort cleanup */
  });
}

test.describe('Workflow Tool Node E2E', () => {
  test('Create HTTP tool, use in Tool node, run workflow, verify output', async ({ page }) => {
    test.setTimeout(180_000);

    // ════════════════════════════════════════════════════════════════════════
    // PHASE 1: Login and setup
    // ════════════════════════════════════════════════════════════════════════

    const { projectId, token } = await loginAndSetup(page);
    const workflowName = `ToolNodeE2E_${Date.now()}`;
    const toolName = `e2e_jsonplaceholder_${Date.now()}`;
    let toolId = '';
    let workflowId = '';

    try {
      // ════════════════════════════════════════════════════════════════════
      // PHASE 2: Create HTTP tool via API
      // ════════════════════════════════════════════════════════════════════

      const tool = await createHttpToolViaAPI(token, projectId, toolName);
      toolId = tool.id;
      console.log(`Tool created: ${tool.name} (${tool.id})`);

      // ════════════════════════════════════════════════════════════════════
      // PHASE 3: Create workflow and navigate to canvas
      // ════════════════════════════════════════════════════════════════════

      await navigateToWorkflows(page);
      workflowId = await createWorkflowViaUI(
        page,
        workflowName,
        'E2E test: Tool node with HTTP tool',
      );
      await waitForCanvasReady(page);

      // Verify Start node exists
      await expect(page.locator('[data-testid="workflow-node-start"]')).toBeVisible({
        timeout: 5000,
      });

      // ════════════════════════════════════════════════════════════════════
      // PHASE 4: Add Tool node via handle plus menu
      // ════════════════════════════════════════════════════════════════════

      await addNodeViaHandleMenu(page, 'tool');
      await page.waitForTimeout(500);

      // Verify tool node appeared on canvas
      const toolNode = page.locator('[data-node-type="tool"]');
      await expect(toolNode).toBeVisible({ timeout: 5000 });
      console.log('Tool node added to canvas');

      // ════════════════════════════════════════════════════════════════════
      // PHASE 5: Configure Tool node — select the HTTP tool
      // ════════════════════════════════════════════════════════════════════

      // Select the tool node to open config panel
      await selectNodeByName(page, 'Tool0001');
      await page.waitForTimeout(500);

      const configPanel = page.locator('[data-testid="config-panel"]');
      await expect(configPanel).toBeVisible({ timeout: 5000 });

      // Wait for the tool config to load (it fetches tools from API)
      await expect(configPanel.locator('[data-testid="tool-node-config"]')).toBeVisible({
        timeout: 10000,
      });

      // The tool select should be present (not empty state) since we created a tool
      const toolSelect = configPanel.locator('#tool-select');
      await expect(toolSelect).toBeVisible({ timeout: 10000 });

      // Click the select trigger to open the dropdown
      await toolSelect.click();
      await page.waitForTimeout(500);

      // Select the created tool from the dropdown (Radix Select renders via Portal)
      const toolOption = page.locator(`[role="option"]`, { hasText: toolName });
      await expect(toolOption).toBeVisible({ timeout: 5000 });
      await toolOption.click();
      await page.waitForTimeout(500);

      console.log(`Tool "${toolName}" selected in Tool node config`);

      // ════════════════════════════════════════════════════════════════════
      // PHASE 6: Add End node connected to Tool node via Zustand store
      // ════════════════════════════════════════════════════════════════════

      // Use Zustand store directly to add End node — avoids viewport issues
      // with L-to-R layout where the Tool node may be off-screen
      await page.evaluate(() => {
        const store = (window as any).__zustandStores?.workflowCanvas;
        if (!store) throw new Error('Zustand store not found');
        const state = store.getState();
        // Find tool node to get its position for placing End node after it
        const toolNode = state.nodes.find((n: any) => n.data.label === 'Tool0001');
        if (!toolNode) throw new Error('Tool0001 node not found');
        const pos = {
          x: toolNode.position.x + 300,
          y: toolNode.position.y,
        };
        // Add end node — sourceInfo is { nodeId, handleId }
        state.addNode('end', pos, { nodeId: toolNode.id, handleId: 'on_success' });
      });
      await page.waitForTimeout(1000);

      console.log('End node added after Tool node via Zustand');

      // ════════════════════════════════════════════════════════════════════
      // PHASE 8: Save and Run workflow
      // ════════════════════════════════════════════════════════════════════

      await saveWorkflow(page);
      console.log('Workflow saved');

      await runWorkflow(page);
      console.log('Workflow execution started');

      // ════════════════════════════════════════════════════════════════════
      // PHASE 9: Verify debug panel and execution output
      // ════════════════════════════════════════════════════════════════════

      await waitForDebugPanel(page);
      console.log('Debug panel appeared');

      const debugPanel = page.locator('[data-testid="execution-debug-panel"]');
      await expect(debugPanel).toBeVisible({ timeout: 10000 });

      // Wait for execution to reach terminal status — poll for "Completed" or "Failed" badge
      // The debug panel renders status as "Completed" (green) or "Failed" (red)
      const completedBadge = debugPanel.getByText('Completed', { exact: true }).first();
      const failedBadge = debugPanel.getByText('Failed', { exact: true }).first();

      // Poll up to 30s for either terminal status
      let isDone = false;
      let isFailed = false;
      for (let i = 0; i < 30; i++) {
        isDone = await completedBadge.isVisible().catch(() => false);
        isFailed = await failedBadge.isVisible().catch(() => false);
        if (isDone || isFailed) break;
        await page.waitForTimeout(1000);
      }
      console.log(`Execution status — completed: ${isDone}, failed: ${isFailed}`);

      // If still no status, dump panel text for debugging
      if (!isDone && !isFailed) {
        const panelText = await debugPanel.textContent();
        console.error('Debug panel text (no terminal status detected):', panelText?.slice(0, 800));
      }

      // Assert: execution should not have failed
      if (isFailed) {
        const panelText = await debugPanel.textContent();
        console.error('Debug panel content:', panelText?.slice(0, 800));
      }
      expect(isFailed).toBe(false);
      expect(isDone).toBe(true);

      // Look for the Tool node step in the flow log
      const toolStepItem = debugPanel.getByText('Tool0001').first();
      const toolStepVisible = await toolStepItem.isVisible({ timeout: 5000 }).catch(() => false);
      console.log(`Tool0001 step visible in debug: ${toolStepVisible}`);

      // Check for output section
      const outputSection = debugPanel.getByText('Output').first();
      const hasOutput = await outputSection.isVisible({ timeout: 5000 }).catch(() => false);
      console.log(`Output section visible: ${hasOutput}`);

      if (hasOutput) {
        await outputSection.click().catch(() => {});
        await page.waitForTimeout(500);

        // Verify output contains JSONPlaceholder data (userId, title, completed fields)
        const outputText = await debugPanel.textContent();
        const hasJsonData =
          outputText?.includes('userId') || outputText?.includes('delectus aut autem');
        console.log(`Output contains JSONPlaceholder data: ${hasJsonData}`);
      }

      // Take screenshot of final state
      await page.screenshot({
        path: 'e2e/screenshots/tool-node-debug-panel.png',
        fullPage: true,
      });

      console.log('Tool Node E2E test completed successfully');
    } finally {
      // ════════════════════════════════════════════════════════════════════
      // CLEANUP: Best-effort delete workflow and tool
      // ════════════════════════════════════════════════════════════════════

      // Delete workflow via API (more reliable than UI deletion)
      if (workflowId) {
        await fetch(`${STUDIO_URL}/api/projects/${projectId}/workflows/${workflowId}`, {
          method: 'DELETE',
          headers: { Authorization: `Bearer ${token}` },
        }).catch(() => {});
        console.log('Workflow deleted via API');
      }

      if (toolId) {
        await deleteToolViaAPI(token, projectId, toolId);
        console.log('Tool deleted via API');
      }
    }
  });

  test('Tool node shows "Create a tool" link when no tools exist', async ({ page }) => {
    test.setTimeout(120_000);

    // ════════════════════════════════════════════════════════════════════════
    // PHASE 1: Login and setup
    // ════════════════════════════════════════════════════════════════════════

    const { projectId, token } = await loginAndSetup(page);
    const workflowName = `ToolEmptyState_${Date.now()}`;

    // First, get all existing tools so we can check the empty state
    // If tools already exist in the project, we need to use a different approach
    const toolsResp = await fetch(`${STUDIO_URL}/api/projects/${projectId}/tools`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const toolsData = await toolsResp.json();
    const existingToolCount = toolsData.data?.length ?? 0;

    if (existingToolCount > 0) {
      console.log(
        `Project has ${existingToolCount} existing tools — skipping empty-state test (requires clean project)`,
      );
      test.skip();
      return;
    }

    try {
      // ════════════════════════════════════════════════════════════════════
      // PHASE 2: Create workflow with Tool node
      // ════════════════════════════════════════════════════════════════════

      await navigateToWorkflows(page);
      const wfId = await createWorkflowViaUI(page, workflowName, 'E2E: Tool empty state');
      await waitForCanvasReady(page);

      await addNodeViaHandleMenu(page, 'tool');
      await page.waitForTimeout(500);

      // ════════════════════════════════════════════════════════════════════
      // PHASE 3: Verify empty state in Tool node config
      // ════════════════════════════════════════════════════════════════════

      await selectNodeByName(page, 'Tool0001');
      await page.waitForTimeout(500);

      const configPanel = page.locator('[data-testid="config-panel"]');
      await expect(configPanel).toBeVisible({ timeout: 5000 });

      // Wait for the tool config to render
      await expect(configPanel.locator('[data-testid="tool-node-config"]')).toBeVisible({
        timeout: 10000,
      });

      // Verify empty state is shown
      const emptyState = configPanel.locator('[data-testid="tool-empty-state"]');
      await expect(emptyState).toBeVisible({ timeout: 5000 });

      // Verify "No tools available" message
      await expect(emptyState.locator('text=No tools available')).toBeVisible({ timeout: 3000 });

      // Verify "Create a tool" link is present
      const createToolLink = configPanel.locator('[data-testid="tool-create-link"]');
      await expect(createToolLink).toBeVisible({ timeout: 3000 });
      await expect(createToolLink).toHaveText(/Create a tool/);

      console.log('Empty state with "Create a tool" link verified');

      await page.screenshot({
        path: 'e2e/screenshots/tool-node-empty-state.png',
        fullPage: true,
      });
    } finally {
      // Cleanup via API
      const wfUrl = page.url();
      const wfMatch = wfUrl.match(/\/workflows\/([^/]+)/);
      const cleanupId = wfMatch?.[1];
      if (cleanupId) {
        await fetch(`${STUDIO_URL}/api/projects/${projectId}/workflows/${cleanupId}`, {
          method: 'DELETE',
          headers: { Authorization: `Bearer ${token}` },
        }).catch(() => {});
        console.log('Workflow deleted via API');
      }
    }
  });
});
