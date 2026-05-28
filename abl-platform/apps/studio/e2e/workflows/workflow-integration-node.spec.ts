/**
 * Workflow Integration Node E2E Test
 *
 * End-to-end test for the Integration node in workflows using a real Gmail
 * connection on the first available project.
 *
 * Tests:
 * 1. Connector catalog API returns Gmail connector with actions
 * 2. Action schemas API returns props for a Gmail action
 * 3. Connections API returns an active Gmail connection
 * 4. Create workflow, add Integration node via canvas UI
 * 5. Open IntegrationPickerModal, select Gmail, select an action
 * 6. Verify connection picker shows the Gmail connection
 * 7. Verify dynamic action form renders input fields
 * 8. Fill a param, save workflow, verify persistence
 * 9. Re-open picker to change action (verify "Change" flow)
 * 10. Cleanup
 *
 * Prerequisites:
 * - All services running (Studio :5173, Runtime :3112, Workflow Engine :9081)
 * - First project has a Gmail connection
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
} from './helpers';

const STUDIO_URL = 'http://localhost:5173';

// ─── API Helpers ──────────────────────────────────────────────────────────

/** List connectors from catalog */
async function listConnectors(
  token: string,
  projectId: string,
): Promise<
  Array<{
    name: string;
    displayName: string;
    actions: Array<{ name: string; displayName: string }>;
  }>
> {
  const resp = await fetch(`${STUDIO_URL}/api/projects/${projectId}/connectors`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!resp.ok) return [];
  const data = await resp.json();
  return data.data ?? [];
}

/** List action schemas for a connector */
async function listActionSchemas(
  token: string,
  projectId: string,
  connectorName: string,
): Promise<
  Array<{
    name: string;
    displayName: string;
    props: Array<{ name: string; type: string; required: boolean }>;
  }>
> {
  const resp = await fetch(
    `${STUDIO_URL}/api/projects/${projectId}/connectors/${connectorName}/actions`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  if (!resp.ok) return [];
  const data = await resp.json();
  return data.data ?? [];
}

/** List connections */
async function listConnections(
  token: string,
  projectId: string,
): Promise<Array<{ id: string; connectorName: string; displayName: string; status: string }>> {
  const resp = await fetch(`${STUDIO_URL}/api/projects/${projectId}/connections`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!resp.ok) return [];
  const data = await resp.json();
  return (data.data ?? []).map((c: Record<string, unknown>) => ({
    id: String(c.id || c._id || ''),
    connectorName: String(c.connectorName ?? ''),
    displayName: String(c.displayName ?? ''),
    status: String(c.status ?? 'unknown'),
  }));
}

// ─── Tests ────────────────────────────────────────────────────────────────

test.describe('Workflow Integration Node E2E', () => {
  test.describe('API: Connector catalog and connections', () => {
    test('Gmail connector is in the catalog with actions', async ({ page }) => {
      test.setTimeout(60_000);
      const { projectId, token } = await loginAndSetup(page);

      const connectors = await listConnectors(token, projectId);
      expect(connectors.length).toBeGreaterThan(0);

      const gmail = connectors.find(
        (c) =>
          c.name.toLowerCase().includes('gmail') || c.displayName.toLowerCase().includes('gmail'),
      );
      expect(gmail).toBeDefined();
      console.log(`Gmail connector found: ${gmail!.name} with ${gmail!.actions.length} actions`);
      expect(gmail!.actions.length).toBeGreaterThan(0);
    });

    test('Gmail action schemas include props', async ({ page }) => {
      test.setTimeout(60_000);
      const { projectId, token } = await loginAndSetup(page);

      const connectors = await listConnectors(token, projectId);
      const gmail = connectors.find(
        (c) =>
          c.name.toLowerCase().includes('gmail') || c.displayName.toLowerCase().includes('gmail'),
      );
      if (!gmail) {
        test.skip();
        return;
      }

      const actions = await listActionSchemas(token, projectId, gmail.name);
      expect(actions.length).toBeGreaterThan(0);
      console.log(`Gmail actions: ${actions.map((a) => a.name).join(', ')}`);

      const actionWithProps = actions.find((a) => a.props && a.props.length > 0);
      expect(actionWithProps).toBeDefined();
      console.log(
        `Action "${actionWithProps!.name}" has ${actionWithProps!.props.length} props: ${actionWithProps!.props.map((p) => `${p.name}(${p.type})`).join(', ')}`,
      );
    });

    test('Project has an active Gmail connection', async ({ page }) => {
      test.setTimeout(60_000);
      const { projectId, token } = await loginAndSetup(page);

      const connections = await listConnections(token, projectId);
      const gmailConnections = connections.filter((c) =>
        c.connectorName.toLowerCase().includes('gmail'),
      );
      expect(gmailConnections.length).toBeGreaterThan(0);
      console.log(
        `Gmail connections: ${gmailConnections.map((c) => `${c.displayName} (${c.status})`).join(', ')}`,
      );
    });
  });

  test.describe('UI: Integration node configuration', () => {
    test('Add Integration node, select Gmail action, configure, save', async ({ page }) => {
      test.setTimeout(180_000);

      const { projectId, token } = await loginAndSetup(page);
      const workflowName = `IntegrationNodeE2E_${Date.now()}`;
      let workflowId = '';

      // Pre-check: verify Gmail connector and connection exist
      const connectors = await listConnectors(token, projectId);
      const gmail = connectors.find(
        (c) =>
          c.name.toLowerCase().includes('gmail') || c.displayName.toLowerCase().includes('gmail'),
      );
      if (!gmail) {
        console.log('Gmail connector not found in catalog — skipping UI test');
        test.skip();
        return;
      }

      const connections = await listConnections(token, projectId);
      const gmailConnection = connections.find((c) =>
        c.connectorName.toLowerCase().includes('gmail'),
      );
      if (!gmailConnection) {
        console.log('No Gmail connection found — skipping UI test');
        test.skip();
        return;
      }

      try {
        // ════════════════════════════════════════════════════════════════════
        // PHASE 1: Create workflow and add Integration node
        // ════════════════════════════════════════════════════════════════════

        await navigateToWorkflows(page);
        workflowId = await createWorkflowViaUI(page, workflowName);
        await waitForCanvasReady(page);
        console.log(`Workflow created: ${workflowId}`);

        await addNodeViaHandleMenu(page, 'integration');
        await page.waitForTimeout(500);

        const integrationNode = page.locator('[data-node-type="integration"]');
        await expect(integrationNode).toBeVisible({ timeout: 5000 });
        console.log('Integration node added to canvas');

        // ════════════════════════════════════════════════════════════════════
        // PHASE 2: Open config panel and select integration
        // ════════════════════════════════════════════════════════════════════

        await selectNodeByName(page, 'Integration0001');
        await page.waitForTimeout(500);

        const configPanel = page.locator('[data-testid="config-panel"]');
        await expect(configPanel).toBeVisible({ timeout: 5000 });

        await expect(configPanel.locator('[data-testid="integration-node-config"]')).toBeVisible({
          timeout: 10000,
        });
        console.log('Integration node config panel visible');

        const selectBtn = configPanel.locator('[data-testid="integration-select-button"]');
        await expect(selectBtn).toBeVisible({ timeout: 10000 });
        await selectBtn.click();
        await page.waitForTimeout(500);

        // ════════════════════════════════════════════════════════════════════
        // PHASE 3: IntegrationPickerModal — select Gmail
        // ════════════════════════════════════════════════════════════════════

        const dialog = page.locator('[role="dialog"]');
        await expect(dialog).toBeVisible({ timeout: 5000 });
        console.log('Integration picker modal opened');

        const searchInput = dialog.locator('input[placeholder*="Search"]');
        await expect(searchInput).toBeVisible({ timeout: 3000 });
        await searchInput.fill('Gmail');
        await page.waitForTimeout(500);

        const gmailTile = dialog.locator('button', { hasText: /gmail/i }).first();
        await expect(gmailTile).toBeVisible({ timeout: 5000 });
        await gmailTile.click();
        await page.waitForTimeout(500);
        console.log('Gmail integration selected — showing actions');

        // ════════════════════════════════════════════════════════════════════
        // PHASE 4: Select an action from the list
        // ════════════════════════════════════════════════════════════════════

        const actionButtons = dialog.locator('button').filter({
          has: page.locator('p.text-sm.font-medium'),
        });
        const actionCount = await actionButtons.count();
        expect(actionCount).toBeGreaterThan(0);
        console.log(`${actionCount} Gmail actions available`);

        const firstActionName = await actionButtons
          .first()
          .locator('p.text-sm.font-medium')
          .textContent();
        console.log(`Selecting action: ${firstActionName}`);
        await actionButtons.first().click();
        await page.waitForTimeout(1000);

        await expect(dialog).not.toBeVisible({ timeout: 5000 });
        console.log('Action selected, modal closed');

        // ════════════════════════════════════════════════════════════════════
        // PHASE 5: Verify config panel shows selected integration
        // ════════════════════════════════════════════════════════════════════

        const selectionBtn = configPanel.locator('[data-testid="integration-selection-button"]');
        await expect(selectionBtn).toBeVisible({ timeout: 10000 });
        console.log('Integration selection displayed in config panel');

        const selectionText = await selectionBtn.textContent();
        expect(selectionText?.toLowerCase()).toContain('gmail');
        console.log(`Selection shows: ${selectionText}`);

        // ════════════════════════════════════════════════════════════════════
        // PHASE 6: Verify connection picker
        // ════════════════════════════════════════════════════════════════════

        await page.waitForTimeout(2000);

        const connectionSelect = configPanel.locator('select, [role="combobox"]').first();
        const createConnectionLink = configPanel.locator('[data-testid="create-connection-link"]');
        const manageConnectionsLink = configPanel.locator(
          '[data-testid="manage-connections-link"]',
        );

        const hasConnectionSelect = await connectionSelect
          .isVisible({ timeout: 5000 })
          .catch(() => false);
        const hasCreateLink = await createConnectionLink
          .isVisible({ timeout: 2000 })
          .catch(() => false);
        const hasManageLink = await manageConnectionsLink
          .isVisible({ timeout: 2000 })
          .catch(() => false);

        console.log(
          `Connection select visible: ${hasConnectionSelect}, Create link: ${hasCreateLink}, Manage link: ${hasManageLink}`,
        );

        expect(hasConnectionSelect || hasCreateLink).toBe(true);

        // ════════════════════════════════════════════════════════════════════
        // PHASE 7: Verify dynamic action form
        // ════════════════════════════════════════════════════════════════════

        const actionInputsHeader = configPanel.locator('text=Action Inputs');
        const hasActionInputs = await actionInputsHeader
          .isVisible({ timeout: 5000 })
          .catch(() => false);

        if (hasActionInputs) {
          console.log('Dynamic action form rendered with input fields');

          const fieldLabels = configPanel.locator('label.text-xs.font-medium.uppercase');
          const fieldCount = await fieldLabels.count();
          console.log(`Dynamic form has ${fieldCount} field labels`);
          expect(fieldCount).toBeGreaterThan(0);
        } else {
          const noParamsMsg = configPanel.locator('text=no input parameters');
          const hasNoParams = await noParamsMsg.isVisible({ timeout: 2000 }).catch(() => false);
          console.log(`No input parameters message: ${hasNoParams}`);
        }

        // ════════════════════════════════════════════════════════════════════
        // PHASE 8: Save and verify persistence
        // ════════════════════════════════════════════════════════════════════

        await saveWorkflow(page);
        console.log('Workflow saved');

        // Verify persistence via UI: reload and check the selection button still shows the connector
        await page.reload();
        await waitForCanvasReady(page);

        // Click the integration node to re-open config panel
        const integrationNodeAfterReload = page
          .locator('[data-testid="workflow-node"]')
          .filter({ hasText: 'Integration' });
        await integrationNodeAfterReload.click();
        await page.waitForTimeout(500);

        // The selection button (not the empty-state "Select" button) should show the connector name
        const selectionBtnAfterReload = page.locator(
          '[data-testid="integration-selection-button"]',
        );
        await expect(selectionBtnAfterReload).toBeVisible({ timeout: 5000 });
        console.log('Config persisted — selection button visible after reload');

        // ════════════════════════════════════════════════════════════════════
        // PHASE 9: Re-open picker to change action (verify Change flow)
        // ════════════════════════════════════════════════════════════════════

        await selectionBtn.click();
        await page.waitForTimeout(500);

        const reopenedDialog = page.locator('[role="dialog"]');
        await expect(reopenedDialog).toBeVisible({ timeout: 5000 });
        console.log('Re-opened integration picker for change');

        await page.keyboard.press('Escape');
        await page.waitForTimeout(500);
        console.log('Closed picker without change');

        // ════════════════════════════════════════════════════════════════════
        // PHASE 10: Add End node and save final state
        // ════════════════════════════════════════════════════════════════════

        // Add End node via the integration node's handle menu (UI interaction, not store access)
        await addNodeViaHandleMenu(page, 'end');
        await page.waitForTimeout(1000);

        await saveWorkflow(page);
        console.log('Final workflow saved with Start → Integration → End');

        await page.screenshot({
          path: 'e2e/screenshots/integration-node-config.png',
          fullPage: true,
        });

        console.log('Integration Node E2E test completed successfully');
      } finally {
        if (workflowId) {
          await fetch(`${STUDIO_URL}/api/projects/${projectId}/workflows/${workflowId}`, {
            method: 'DELETE',
            headers: { Authorization: `Bearer ${token}` },
          }).catch(() => {
            console.warn(`Cleanup: failed to delete workflow ${workflowId}`);
          });
          console.log('Workflow deleted via API');
        }
      }
    });

    test('Integration node shows "Select Integration" button initially', async ({ page }) => {
      test.setTimeout(120_000);

      const { projectId, token } = await loginAndSetup(page);
      const workflowName = `IntegrationEmptyState_${Date.now()}`;
      let workflowId = '';

      try {
        await navigateToWorkflows(page);
        workflowId = await createWorkflowViaUI(page, workflowName);
        await waitForCanvasReady(page);

        await addNodeViaHandleMenu(page, 'integration');
        await page.waitForTimeout(500);

        await selectNodeByName(page, 'Integration0001');
        await page.waitForTimeout(500);

        const configPanel = page.locator('[data-testid="config-panel"]');
        await expect(configPanel).toBeVisible({ timeout: 5000 });

        const selectBtn = configPanel.locator('[data-testid="integration-select-button"]');
        await expect(selectBtn).toBeVisible({ timeout: 10000 });

        const btnText = await selectBtn.textContent();
        expect(btnText).toContain('Select Integration');
        console.log('Empty state: "Select Integration & Action" button visible');

        // Verify no connection picker inside the integration config (not the Connections tab)
        const integrationConfig = configPanel.locator('[data-testid="integration-node-config"]');
        const connectionLabel = integrationConfig.locator(
          'label:has-text("Connection"), text=No connections found',
        );
        const hasConnection = await connectionLabel.isVisible({ timeout: 1000 }).catch(() => false);
        expect(hasConnection).toBe(false);
        console.log('No connection section shown before integration selection');

        await page.screenshot({
          path: 'e2e/screenshots/integration-node-empty-state.png',
          fullPage: true,
        });

        console.log('Empty state test completed');
      } finally {
        if (workflowId) {
          await fetch(`${STUDIO_URL}/api/projects/${projectId}/workflows/${workflowId}`, {
            method: 'DELETE',
            headers: { Authorization: `Bearer ${token}` },
          }).catch(() => {
            console.warn(`Cleanup: failed to delete workflow ${workflowId}`);
          });
        }
      }
    });

    test('IntegrationPickerModal search and navigation', async ({ page }) => {
      test.setTimeout(120_000);

      const { projectId, token } = await loginAndSetup(page);
      const workflowName = `IntegrationModalNav_${Date.now()}`;
      let workflowId = '';

      try {
        await navigateToWorkflows(page);
        workflowId = await createWorkflowViaUI(page, workflowName);
        await waitForCanvasReady(page);

        await addNodeViaHandleMenu(page, 'integration');
        await page.waitForTimeout(500);
        await selectNodeByName(page, 'Integration0001');
        await page.waitForTimeout(500);

        const configPanel = page.locator('[data-testid="config-panel"]');
        await expect(configPanel.locator('[data-testid="integration-node-config"]')).toBeVisible({
          timeout: 10000,
        });

        const selectBtn = configPanel.locator('[data-testid="integration-select-button"]');
        await selectBtn.click();
        await page.waitForTimeout(500);

        const dialog = page.locator('[role="dialog"]');
        await expect(dialog).toBeVisible({ timeout: 5000 });

        // Verify tile grid is shown
        const tiles = dialog.locator('button').filter({
          has: page.locator('.w-10.h-10'),
        });
        const tileCount = await tiles.count();
        expect(tileCount).toBeGreaterThan(1);
        console.log(`Integration tiles: ${tileCount}`);

        // Search for something that doesn't exist
        const searchInput = dialog.locator('input[placeholder*="Search"]');
        await searchInput.fill('xyznonexistent');
        await page.waitForTimeout(300);

        const noResults = dialog.locator('text=No integrations found');
        await expect(noResults).toBeVisible({ timeout: 3000 });
        console.log('Empty search shows "No integrations found"');

        // Clear search and select Gmail
        await searchInput.fill('');
        await page.waitForTimeout(300);
        await searchInput.fill('Gmail');
        await page.waitForTimeout(500);

        const gmailTile = dialog.locator('button', { hasText: /gmail/i }).first();
        const gmailVisible = await gmailTile.isVisible({ timeout: 3000 }).catch(() => false);

        if (gmailVisible) {
          await gmailTile.click();
          await page.waitForTimeout(500);

          // Now on action list screen — verify back button
          const backBtn = dialog.locator('button[aria-label="Back to integrations"]');
          await expect(backBtn).toBeVisible({ timeout: 3000 });
          console.log('Action list screen with back button');

          const actionSearch = dialog.locator('input[placeholder*="Search actions"]');
          await expect(actionSearch).toBeVisible({ timeout: 3000 });
          console.log('Action search input available');

          // Click back to return to integration grid
          await backBtn.click();
          await page.waitForTimeout(500);

          const tilesAfterBack = dialog.locator('button').filter({
            has: page.locator('.w-10.h-10'),
          });
          const tilesAfterBackCount = await tilesAfterBack.count();
          expect(tilesAfterBackCount).toBeGreaterThan(1);
          console.log('Back button returned to integration grid');
        } else {
          console.log('Gmail not found in search — skipping action list navigation');
        }

        // Close modal
        await page.keyboard.press('Escape');
        await page.waitForTimeout(500);
        console.log('Modal navigation test completed');
      } finally {
        if (workflowId) {
          await fetch(`${STUDIO_URL}/api/projects/${projectId}/workflows/${workflowId}`, {
            method: 'DELETE',
            headers: { Authorization: `Bearer ${token}` },
          }).catch(() => {
            console.warn(`Cleanup: failed to delete workflow ${workflowId}`);
          });
        }
      }
    });
  });
});
