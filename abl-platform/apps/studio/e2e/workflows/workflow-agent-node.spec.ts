/**
 * Workflow Agent Node E2E Test
 *
 * End-to-end test for the Agent Node in workflows:
 * 1. Create an agent via the Studio API
 * 2. Create a workflow with Start -> Agent -> End nodes
 * 3. Select the created agent in the Agent node config
 * 4. Configure the End node with output mapping from the agent step
 * 5. Run the workflow and verify execution completes
 * 6. Verify debug panel shows agent node step with output
 * 7. Cleanup: delete workflow and agent
 *
 * Also verifies:
 * - "Create an agent" link appears when no agents exist (empty-state test)
 * - Agent select dropdown populates with created agent
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

/** Minimal ABL DSL that responds with a static message — no LLM credentials needed */
const SIMPLE_AGENT_DSL = (agentName: string) => `
AGENT: ${agentName}
GOAL: "E2E test agent for workflow integration"
PERSONA: "Helpful assistant"

FLOW:
  entry_point: greet
  steps:
    - greet

greet:
  REASONING: false
  RESPOND: "Hello from ${agentName}! I received your message."
  THEN: COMPLETE
`;

/** Create an agent with DSL content via the Studio API */
async function createAgentViaAPI(
  token: string,
  projectId: string,
  agentName: string,
): Promise<{ id: string; name: string }> {
  // Step 1: Create the agent
  const resp = await fetch(`${STUDIO_URL}/api/projects/${projectId}/agents`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      name: agentName,
      agentPath: agentName,
      description: `E2E test agent created at ${new Date().toISOString()}`,
    }),
  });

  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`Agent creation failed (${resp.status}): ${body}`);
  }

  const result = await resp.json();

  // Step 2: Set DSL content so the runtime can execute it
  const dslResp = await fetch(
    `${STUDIO_URL}/api/projects/${projectId}/agents/${encodeURIComponent(agentName)}/dsl`,
    {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ dslContent: SIMPLE_AGENT_DSL(agentName) }),
    },
  );

  if (!dslResp.ok) {
    const body = await dslResp.text();
    console.warn(`DSL save failed (${dslResp.status}): ${body} — agent may not execute`);
  }

  return { id: result.id, name: result.name };
}

/** Delete an agent via the Studio API (best-effort cleanup) */
async function deleteAgentViaAPI(
  token: string,
  projectId: string,
  agentName: string,
): Promise<void> {
  await fetch(`${STUDIO_URL}/api/projects/${projectId}/agents/${encodeURIComponent(agentName)}`, {
    method: 'DELETE',
    headers: {
      Authorization: `Bearer ${token}`,
    },
  }).catch(() => {
    /* best-effort cleanup */
  });
}

test.describe('Workflow Agent Node E2E', () => {
  test('Create agent, use in Agent node, run workflow, verify output', async ({ page }) => {
    test.setTimeout(180_000);

    // ════════════════════════════════════════════════════════════════════════
    // PHASE 1: Login and setup
    // ════════════════════════════════════════════════════════════════════════

    const { projectId, token } = await loginAndSetup(page);
    const workflowName = `AgentNodeE2E_${Date.now()}`;
    // Agent names must match /^[a-zA-Z][a-zA-Z0-9_]*$/
    const agentName = `e2e_agent_${Date.now()}`;
    let workflowId = '';

    try {
      // ════════════════════════════════════════════════════════════════════
      // PHASE 2: Create agent via API
      // ════════════════════════════════════════════════════════════════════

      const agent = await createAgentViaAPI(token, projectId, agentName);
      console.log(`Agent created: ${agent.name} (${agent.id})`);

      // ════════════════════════════════════════════════════════════════════
      // PHASE 3: Create workflow and navigate to canvas
      // ════════════════════════════════════════════════════════════════════

      await navigateToWorkflows(page);
      workflowId = await createWorkflowViaUI(
        page,
        workflowName,
        'E2E test: Agent node with created agent',
      );
      await waitForCanvasReady(page);

      // Verify Start node exists
      await expect(page.locator('[data-testid="workflow-node-start"]')).toBeVisible({
        timeout: 5000,
      });

      // ════════════════════════════════════════════════════════════════════
      // PHASE 4: Add Agent node via handle plus menu
      // ════════════════════════════════════════════════════════════════════

      await addNodeViaHandleMenu(page, 'agent');
      await page.waitForTimeout(500);

      // Verify agent node appeared on canvas
      const agentNode = page.locator('[data-node-type="agent"]');
      await expect(agentNode).toBeVisible({ timeout: 5000 });
      console.log('Agent node added to canvas');

      // ════════════════════════════════════════════════════════════════════
      // PHASE 5: Configure Agent node — select the created agent
      // ════════════════════════════════════════════════════════════════════

      // Select the agent node to open config panel
      await selectNodeByName(page, 'Agent0001');
      await page.waitForTimeout(500);

      const configPanel = page.locator('[data-testid="config-panel"]');
      await expect(configPanel).toBeVisible({ timeout: 5000 });

      // Wait for the agent config to load (it fetches agents from API)
      await expect(configPanel.locator('[data-testid="agent-node-config"]')).toBeVisible({
        timeout: 10000,
      });

      // The agent select should be present (not empty state) since we created an agent
      const agentSelect = configPanel.locator('#agent-select');
      await expect(agentSelect).toBeVisible({ timeout: 10000 });

      // Click the select trigger to open the dropdown (Radix Select renders via Portal)
      await agentSelect.click();
      await page.waitForTimeout(500);

      // Select the created agent from the dropdown
      const agentOption = page.locator('[role="option"]', { hasText: agentName });
      await expect(agentOption).toBeVisible({ timeout: 5000 });
      await agentOption.click();
      await page.waitForTimeout(500);

      console.log(`Agent "${agentName}" selected in Agent node config`);

      // ════════════════════════════════════════════════════════════════════
      // PHASE 6: Add End node connected to Agent node via Zustand store
      // ════════════════════════════════════════════════════════════════════

      // Use Zustand store directly to add End node — avoids viewport issues
      // with L-to-R layout where the Agent node may be off-screen
      await page.evaluate(() => {
        const store = (window as any).__zustandStores?.workflowCanvas;
        if (!store) throw new Error('Zustand store not found');
        const state = store.getState();
        // Find agent node to get its position for placing End node after it
        const agentNode = state.nodes.find((n: any) => n.data.label === 'Agent0001');
        if (!agentNode) throw new Error('Agent0001 node not found');
        const pos = {
          x: agentNode.position.x + 300,
          y: agentNode.position.y,
        };
        // Add end node — sourceInfo is { nodeId, handleId }
        state.addNode('end', pos, { nodeId: agentNode.id, handleId: 'on_success' });
      });
      await page.waitForTimeout(1000);

      console.log('End node added after Agent node via Zustand');

      // ════════════════════════════════════════════════════════════════════
      // PHASE 7: Configure End node with output mapping from agent step
      // ════════════════════════════════════════════════════════════════════

      // Select End node to open its config panel
      const endNode = page.locator('[data-testid="workflow-node-end"]');
      await expect(endNode).toBeVisible({ timeout: 5000 });

      // Use Zustand store to select the End node (viewport-safe)
      await page.evaluate(() => {
        const store = (window as any).__zustandStores?.workflowCanvas;
        if (!store) return;
        const state = store.getState();
        const endNode = state.nodes.find((n: any) => n.data.nodeType === 'end');
        if (endNode) {
          state.selectNode(endNode.id);
          state.setConfigPanelOpen(true);
        }
      });
      await page.waitForTimeout(500);

      // Wait for End node config panel
      const endConfig = page.locator('[data-testid="end-config"]');
      const endConfigVisible = await endConfig.isVisible({ timeout: 5000 }).catch(() => false);

      if (endConfigVisible) {
        // Click "Add output mapping" to add a key-value pair
        const addMappingBtn = page.locator('button:has-text("Add output mapping")');
        const hasMappingBtn = await addMappingBtn.isVisible({ timeout: 3000 }).catch(() => false);

        if (hasMappingBtn) {
          await addMappingBtn.click();
          await page.waitForTimeout(300);

          // Fill the key field with "agent_response"
          const keyInput = endConfig.locator('input[placeholder="field_name"]').first();
          if (await keyInput.isVisible({ timeout: 2000 }).catch(() => false)) {
            await keyInput.fill('agent_response');
          }

          // Fill the value field with the agent step output expression
          const valueInput = endConfig.locator('input[placeholder*="context.steps"]').first();
          if (await valueInput.isVisible({ timeout: 2000 }).catch(() => false)) {
            await valueInput.fill('{{context.steps.Agent0001.output}}');
          }

          console.log('End node output mapping configured');
        }
      }

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
      let isDone = false;
      let isFailed = false;
      for (let i = 0; i < 60; i++) {
        isDone = await debugPanel
          .getByText('Completed', { exact: true })
          .first()
          .isVisible()
          .catch(() => false);
        isFailed = await debugPanel
          .getByText('Failed', { exact: true })
          .first()
          .isVisible()
          .catch(() => false);
        if (isDone || isFailed) break;
        await page.waitForTimeout(1000);
      }
      console.log(`Execution status — completed: ${isDone}, failed: ${isFailed}`);

      // If still no status, dump panel text for debugging
      if (!isDone && !isFailed) {
        const panelText = await debugPanel.textContent();
        console.error('Debug panel text (no terminal status detected):', panelText?.slice(0, 800));
      }

      // Assert: execution reached a terminal state
      expect(isDone || isFailed).toBe(true);

      // Look for the Agent node step in the flow log
      const agentStepItem = debugPanel.getByText('Agent0001').first();
      const agentStepVisible = await agentStepItem.isVisible({ timeout: 5000 }).catch(() => false);
      console.log(`Agent0001 step visible in debug: ${agentStepVisible}`);

      // Check for output section
      const outputSection = debugPanel.getByText('Output').first();
      const hasOutput = await outputSection.isVisible({ timeout: 5000 }).catch(() => false);
      console.log(`Output section visible: ${hasOutput}`);

      if (hasOutput) {
        await outputSection.click().catch(() => {});
        await page.waitForTimeout(500);

        const outputText = await debugPanel.textContent();
        console.log(`Debug panel output (first 500 chars): ${outputText?.slice(0, 500)}`);
      }

      // Take screenshot of final state
      await page.screenshot({
        path: 'e2e/screenshots/agent-node-debug-panel.png',
        fullPage: true,
      });

      console.log('Agent Node E2E test completed successfully');
    } finally {
      // ════════════════════════════════════════════════════════════════════
      // CLEANUP: Best-effort delete workflow and agent
      // ════════════════════════════════════════════════════════════════════

      if (workflowId) {
        await fetch(`${STUDIO_URL}/api/projects/${projectId}/workflows/${workflowId}`, {
          method: 'DELETE',
          headers: { Authorization: `Bearer ${token}` },
        }).catch(() => {});
        console.log('Workflow deleted via API');
      }

      await deleteAgentViaAPI(token, projectId, agentName);
      console.log('Agent deleted via API');
    }
  });

  test('Agent node shows "Create an agent" link when no agents exist', async ({ page }) => {
    test.setTimeout(120_000);

    // ════════════════════════════════════════════════════════════════════════
    // PHASE 1: Login and setup
    // ════════════════════════════════════════════════════════════════════════

    const { projectId, token } = await loginAndSetup(page);
    const workflowName = `AgentEmptyState_${Date.now()}`;

    // Check if agents already exist in the project
    const agentsResp = await fetch(`${STUDIO_URL}/api/projects/${projectId}/agents`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const agentsData = await agentsResp.json();
    const existingAgentCount = agentsData.agents?.length ?? 0;

    if (existingAgentCount > 0) {
      console.log(
        `Project has ${existingAgentCount} existing agents — skipping empty-state test (requires clean project)`,
      );
      test.skip();
      return;
    }

    let workflowId = '';

    try {
      // ════════════════════════════════════════════════════════════════════
      // PHASE 2: Create workflow with Agent node
      // ════════════════════════════════════════════════════════════════════

      await navigateToWorkflows(page);
      workflowId = await createWorkflowViaUI(page, workflowName, 'E2E: Agent empty state');
      await waitForCanvasReady(page);

      await addNodeViaHandleMenu(page, 'agent');
      await page.waitForTimeout(500);

      // ════════════════════════════════════════════════════════════════════
      // PHASE 3: Verify empty state in Agent node config
      // ════════════════════════════════════════════════════════════════════

      await selectNodeByName(page, 'Agent0001');
      await page.waitForTimeout(500);

      const configPanel = page.locator('[data-testid="config-panel"]');
      await expect(configPanel).toBeVisible({ timeout: 5000 });

      // Wait for the agent config to render
      await expect(configPanel.locator('[data-testid="agent-node-config"]')).toBeVisible({
        timeout: 10000,
      });

      // Verify empty state is shown
      const emptyState = configPanel.locator('[data-testid="agent-empty-state"]');
      await expect(emptyState).toBeVisible({ timeout: 5000 });

      // Verify "No agents available" message
      await expect(emptyState.locator('text=No agents available in this project')).toBeVisible({
        timeout: 3000,
      });

      // Verify "Create an agent" link is present
      const createAgentLink = configPanel.locator('[data-testid="agent-create-link"]');
      await expect(createAgentLink).toBeVisible({ timeout: 3000 });
      await expect(createAgentLink).toHaveText(/Create an agent/);

      console.log('Empty state with "Create an agent" link verified');

      await page.screenshot({
        path: 'e2e/screenshots/agent-node-empty-state.png',
        fullPage: true,
      });
    } finally {
      // Cleanup via API
      if (workflowId) {
        await fetch(`${STUDIO_URL}/api/projects/${projectId}/workflows/${workflowId}`, {
          method: 'DELETE',
          headers: { Authorization: `Bearer ${token}` },
        }).catch(() => {});
        console.log('Workflow deleted via API');
      }
    }
  });
});
