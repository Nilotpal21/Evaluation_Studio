/**
 * Shared E2E helpers for workflow canvas tests.
 */

import { type Page, expect } from '@playwright/test';

const STUDIO_URL = 'http://localhost:5173';

/**
 * Login via Dev Login, navigate to first project.
 * Returns { projectId, token }.
 */
export async function loginAndSetup(page: Page): Promise<{ projectId: string; token: string }> {
  // Use @e2e-smoke.test email to bypass rate limiting (see dev-login route.ts)
  const E2E_EMAIL = 'workflow-canvas@e2e-smoke.test';

  // Login via API (bypasses rate limit) and set auth state in the browser
  await page.goto(`${STUDIO_URL}/auth/login`);
  await page.waitForLoadState('networkidle');

  // Perform dev-login via API call inside the browser context
  const loginResult = await page.evaluate(async (email: string) => {
    const resp = await fetch('/api/auth/dev-login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ email, name: 'E2E Test User' }),
    });
    return resp.json();
  }, E2E_EMAIL);

  const token = (loginResult as { accessToken: string }).accessToken;
  if (!token) {
    throw new Error(`Dev login failed: ${JSON.stringify(loginResult)}`);
  }

  // The dev-login API sets an httpOnly refresh_token cookie via credentials: 'same-origin'.
  // On page load, initializeAuth() reads this cookie to obtain an access token.
  // Navigate to root — the app auto-authenticates via the refresh cookie.
  await page.goto(`${STUDIO_URL}/`);
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(3000);

  // Click first project — locate h3 heading (project name) and click its ancestor button
  const firstProjectHeading = page.locator('main h3').first();
  await expect(firstProjectHeading).toBeVisible({ timeout: 20000 });
  await firstProjectHeading.click();
  await page.locator('text=Workflows').first().waitFor({ state: 'visible', timeout: 15000 });
  await page.waitForTimeout(1000);

  const url = page.url();
  const m = url.match(/\/projects\/([^/]+)/);
  if (!m) throw new Error(`No project ID in URL: ${url}`);

  return { projectId: m[1], token };
}

/**
 * Navigate to the Workflows list page.
 */
export async function navigateToWorkflows(page: Page): Promise<void> {
  // Use the sidebar nav button (role=complementary) to avoid breadcrumb ambiguity
  const sidebarBtn = page
    .locator(
      'aside button:has-text("Workflows"), [role="complementary"] button:has-text("Workflows")',
    )
    .first();
  if (await sidebarBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
    await sidebarBtn.click();
  } else {
    // Fallback to any nav Workflows link
    await page.locator('nav >> text=Workflows').first().click();
  }
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(1000);
}

/**
 * Create a new workflow via UI and navigate to its canvas.
 * Returns the workflow ID from the URL.
 */
export async function createWorkflowViaUI(
  page: Page,
  name: string,
  description?: string,
): Promise<string> {
  // Click New Workflow button (use first() since empty state may show a second one)
  const newBtn = page.locator('button:has-text("New Workflow")').first();
  await expect(newBtn).toBeVisible({ timeout: 10000 });
  await newBtn.click();

  // Wait for dialog
  await expect(
    page.locator('h2:has-text("Create Workflow"), h3:has-text("Create Workflow")'),
  ).toBeVisible({ timeout: 5000 });

  // Fill name
  const nameInput = page.locator('input[placeholder*="Order"]');
  await expect(nameInput).toBeVisible({ timeout: 5000 });
  await nameInput.fill(name);

  // Fill description if provided
  if (description) {
    const descInput = page.locator('textarea[placeholder*="description" i]');
    if (await descInput.isVisible({ timeout: 1000 }).catch(() => false)) {
      await descInput.fill(description);
    }
  }

  // Click the Create Workflow submit button in the dialog
  const dialog = page.locator('[role="dialog"]');
  const createBtn = dialog.locator('button:has-text("Create Workflow")');
  await createBtn.click();

  // Wait for navigation to canvas page (workflow creation can be slow)
  await page.waitForURL(/\/workflows\/[^/]+$/, { timeout: 30000 });
  await page.waitForTimeout(1000);

  // Extract workflow ID from URL
  const detailUrl = page.url();
  const workflowId = detailUrl.match(/\/workflows\/([^/]+)$/)?.[1];
  if (!workflowId) throw new Error(`No workflow ID in URL: ${detailUrl}`);

  return workflowId;
}

/**
 * Navigate to the Flow tab and wait for the workflow canvas to be ready.
 */
export async function waitForCanvasReady(page: Page): Promise<void> {
  // Click the Flow tab (canvas is embedded in Flow tab)
  // Use role="tab" to avoid matching sidebar "Workflows" button (has-text substring)
  const flowTab = page.locator('[role="tab"]:has-text("Flow")').first();
  await expect(flowTab).toBeVisible({ timeout: 10000 });
  await flowTab.click();
  await page.waitForTimeout(1000);

  await expect(page.locator('[data-testid="workflow-canvas-page"]')).toBeVisible({
    timeout: 15000,
  });
  // Wait for either canvas or loading to finish
  await page
    .locator('[data-testid="workflow-canvas"]')
    .waitFor({ state: 'visible', timeout: 15000 });
}

/**
 * Add a node via the handle plus menu on a source node.
 * By default, adds from the Start node's on_success handle.
 * The handle plus menu auto-creates an edge from source → new node.
 *
 * @param sourceSelector - CSS selector for the source node (default: Start node)
 * @param handleId - The handle ID to click the plus button on (default: 'on_success')
 */
export async function addNodeViaHandleMenu(
  page: Page,
  nodeType: string,
  sourceSelector = '[data-testid="workflow-node-start"]',
  handleId = 'on_success',
): Promise<void> {
  const sourceNode = page.locator(sourceSelector).first();
  await expect(sourceNode).toBeVisible({ timeout: 5000 });

  // Hover to reveal the plus button (opacity-0 → opacity-100 on group-hover)
  await sourceNode.hover();
  await page.waitForTimeout(300);

  // Click the plus button for the specified handle
  const plusBtn = sourceNode.locator(`[data-testid="handle-plus-${handleId}"]`);
  await expect(plusBtn).toBeVisible({ timeout: 3000 });
  await plusBtn.click();

  // Wait for the popover menu and select the node type
  await expect(page.locator('[data-testid="handle-plus-menu"]')).toBeVisible({ timeout: 3000 });
  // Use evaluate to click — the popover renders via Portal and may extend beyond
  // the browser viewport. Playwright's regular click fails with "outside viewport"
  // but HTMLElement.click() triggers React's event system correctly.
  await page.evaluate((nt: string) => {
    const el = document.querySelector(`[data-testid="plus-menu-${nt}"]`) as HTMLElement;
    if (el) el.click();
  }, nodeType);
  await page.waitForTimeout(500);
}

/**
 * Select a node on the canvas by its data-node-name attribute.
 * Opens the config panel for the selected node.
 */
export async function selectNodeByName(page: Page, nodeName: string): Promise<void> {
  // Use the Zustand store to select the node — avoids viewport issues
  // with L-to-R layout where nodes may be off-screen
  await page.evaluate((name: string) => {
    const store = (window as any).__zustandStores?.workflowCanvas;
    if (!store) return;
    const state = store.getState();
    const node = state.nodes.find((n: any) => n.data.label === name);
    if (node) {
      state.selectNode(node.id);
      state.setConfigPanelOpen(true);
    }
  }, nodeName);
  await page.waitForTimeout(500);
}

/**
 * Select a node by its data-testid (e.g., "workflow-node-start").
 */
export async function selectNodeByTestId(page: Page, testId: string): Promise<void> {
  const node = page.locator(`[data-testid="${testId}"]`);
  await expect(node).toBeVisible({ timeout: 5000 });
  // force: true because canvas nodes may overlap in XY Flow
  await node.click({ force: true });
  await page.waitForTimeout(300);
}

/**
 * Wait for the auto-save to complete.
 * The canvas uses a 2s debounced auto-save. This helper waits for
 * the "Saved" indicator to appear in the toolbar.
 */
export async function saveWorkflow(page: Page) {
  // Wait for auto-save debounce (2s) + save round-trip
  await page.waitForTimeout(3500);
  // Verify "Saved" status appears in toolbar
  const savedIndicator = page.locator('[data-testid="canvas-toolbar"] >> text=Saved');
  await expect(savedIndicator).toBeVisible({ timeout: 10000 });
}

/**
 * Run a workflow by clicking Run.
 *
 * If the Start node has input variables, the Run dialog opens for filling inputs.
 * If no input variables exist, execution starts directly (no dialog).
 */
export async function runWorkflow(page: Page, inputs?: Record<string, string>) {
  await page.locator('[data-testid="toolbar-run-btn"]').click();

  // Check if the Run dialog appears (only when input variables exist)
  const dialogVisible = await page
    .locator('[data-testid="run-dialog"]')
    .isVisible({ timeout: 2000 })
    .catch(() => false);

  if (dialogVisible && inputs) {
    for (const [name, value] of Object.entries(inputs)) {
      const input = page.locator(`[data-testid="run-input-${name}"]`);
      await input.fill(value);
    }
    await page.locator('[data-testid="run-execute-btn"]').click();
  } else if (dialogVisible) {
    // Dialog open but no inputs to fill — just click Run
    await page.locator('[data-testid="run-execute-btn"]').click();
  }
  // If no dialog, execution started directly — nothing more to do
}

/**
 * Wait for the execution debug panel to appear.
 */
export async function waitForDebugPanel(page: Page) {
  await page.waitForSelector('[data-testid="execution-debug-panel"]', { timeout: 10000 });
}

/**
 * Delete a workflow from the list page by clicking the delete button on its card.
 */
export async function deleteWorkflowFromList(page: Page, workflowName: string) {
  // Find the card container that contains the workflow name
  // Try role="button" first, then fallback to any element containing the name
  let card = page.locator('[role="button"]', { hasText: workflowName }).first();
  const isCardVisible = await card.isVisible({ timeout: 5000 }).catch(() => false);
  if (!isCardVisible) {
    // Fallback: find any clickable card-like element
    card = page
      .locator('div', { hasText: workflowName })
      .filter({ has: page.locator('[data-testid="workflow-delete-btn"]') })
      .first();
  }
  await expect(card).toBeVisible({ timeout: 10000 });
  await card.hover();
  // The delete button appears on hover within the card
  const deleteBtn = card.locator('[data-testid="workflow-delete-btn"]');
  await expect(deleteBtn).toBeVisible({ timeout: 3000 });
  await deleteBtn.click();
  // Confirm deletion in the dialog
  await page.waitForTimeout(500);
  const confirmBtn = page.locator('[role="dialog"] button:has-text("Delete")');
  await expect(confirmBtn).toBeVisible({ timeout: 3000 });
  await confirmBtn.click();
  await page.waitForTimeout(1000);
}
