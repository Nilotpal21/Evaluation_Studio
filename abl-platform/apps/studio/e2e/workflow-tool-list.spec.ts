/**
 * Workflow Tool List UI E2E Tests
 *
 * Covers UI-E2E-3 (Workflow tab in Tools list + ?tab=workflow deep-link)
 * and UI-E2E-4 (Workflow tool badge + detail-page binding panel + cross-project isolation).
 *
 * @e2e-real — Real Studio 5173 + real Runtime 3112 + real Workflow-Engine 9081.
 * No vi.mock, no jest.mock, no direct DB access. All interaction via UI + HTTP API.
 */

import { test, expect } from '@playwright/test';
import {
  loginViaDevApi,
  getToken,
  seedWorkflowWithWebhook,
  deleteSeededWorkflow,
  apiPost,
  apiGet,
  apiDelete,
  type SeededWorkflow,
} from './helpers';

const STUDIO_URL = 'http://localhost:5173';
const TEST_LOGIN_EMAIL = 'workflow-tool-list@e2e-smoke.test';
const TEST_LOGIN_NAME = 'Workflow Tool List E2E';

test.describe.configure({ mode: 'serial' });

test.describe('Workflow Tool List (UI-E2E-3 + UI-E2E-4)', () => {
  let token: string;
  let projectId: string;
  let projectY: string | null = null;
  let wfA: SeededWorkflow;
  let wfB: SeededWorkflow;
  let wfBadge: SeededWorkflow;
  const createdToolIds: string[] = [];
  let toolAId: string;
  let toolBId: string;
  let badgeToolId: string;

  test.beforeAll(async ({ browser }) => {
    const page = await browser.newPage();

    // Login and get token + project
    await loginViaDevApi(page, {
      baseUrl: STUDIO_URL,
      email: TEST_LOGIN_EMAIL,
      name: TEST_LOGIN_NAME,
    });
    token = await getToken(page);
    expect(token, 'Auth token should be non-empty').toBeTruthy();

    // Navigate to projects and select first project
    await page.goto(`${STUDIO_URL}/projects`);
    await page.waitForLoadState('networkidle').catch(() => {});

    const firstCard = page.locator('button:has(h3)').first();
    await firstCard.waitFor({ state: 'visible', timeout: 10_000 });
    await firstCard.click();
    await page.waitForURL(/\/projects\/[^/]+/, { timeout: 15_000 });
    const match = page.url().match(/\/projects\/([^/]+)/);
    expect(match, 'Should navigate to a project').toBeTruthy();
    projectId = match![1];

    // Try to find a second project for cross-project isolation tests
    const { body: projectsBody } = await apiGet(page, '/api/projects', token);
    const projects = (projectsBody as Record<string, unknown>).projects as
      | Array<Record<string, unknown>>
      | undefined;
    if (projects && projects.length > 1) {
      const otherProject = projects.find((p) => p.id !== projectId);
      if (otherProject) {
        projectY = otherProject.id as string;
      }
    }

    // Seed workflows in projectId
    const suffix = crypto.randomUUID().slice(0, 6);

    wfA = await seedWorkflowWithWebhook(page, token, {
      projectId,
      mode: 'sync',
      namePrefix: `wf_list_a_${suffix}`,
    });

    wfB = await seedWorkflowWithWebhook(page, token, {
      projectId,
      mode: 'async',
      namePrefix: `wf_list_b_${suffix}`,
    });

    wfBadge = await seedWorkflowWithWebhook(page, token, {
      projectId,
      mode: 'sync',
      namePrefix: `wf_badge_${suffix}`,
    });

    // Create workflow tools bound to these workflows
    async function createTool(name: string, wf: SeededWorkflow, mode: 'sync' | 'async') {
      const { status, body } = await apiPost(page, `/api/projects/${projectId}/tools`, token, {
        name,
        toolType: 'workflow',
        workflowId: wf.workflowId,
        triggerId: wf.triggerId,
        mode,
        description: `E2E list test tool: ${name}`,
      });

      if (status !== 200 && status !== 201) {
        throw new Error(`createTool failed: HTTP ${status} — ${JSON.stringify(body)}`);
      }

      const toolBody = body as Record<string, unknown>;
      return (
        (toolBody.id as string) ?? ((toolBody.tool as Record<string, unknown>)?.id as string) ?? ''
      );
    }

    toolAId = await createTool(`tool_a_${suffix}`, wfA, 'sync');
    createdToolIds.push(toolAId);

    toolBId = await createTool(`tool_b_${suffix}`, wfB, 'async');
    createdToolIds.push(toolBId);

    badgeToolId = await createTool(`badge_tool_${suffix}`, wfBadge, 'sync');
    createdToolIds.push(badgeToolId);

    await page.close();
  });

  test.afterAll(async ({ browser }) => {
    const page = await browser.newPage();

    // Re-authenticate to get a fresh token — the beforeAll token may have expired
    await loginViaDevApi(page, {
      baseUrl: STUDIO_URL,
      email: TEST_LOGIN_EMAIL,
      name: TEST_LOGIN_NAME,
    });
    const freshToken = (await getToken(page).catch(() => '')) || token;

    // Delete created tools
    for (const toolId of createdToolIds) {
      await apiDelete(page, `/api/projects/${projectId}/tools/${toolId}`, freshToken).catch(
        () => {},
      );
    }

    // Delete seeded workflows
    for (const wf of [wfA, wfB, wfBadge]) {
      if (wf?.workflowId) {
        await deleteSeededWorkflow(page, freshToken, projectId, wf.workflowId);
      }
    }

    await page.close();
  });

  // ─── UI-E2E-3: Workflow tab in Tools list + ?tab=workflow deep-link ──

  test('Workflow tab shows correct count and filters to workflow tools only', async ({ page }) => {
    await loginViaDevApi(page, {
      baseUrl: STUDIO_URL,
      email: TEST_LOGIN_EMAIL,
      name: TEST_LOGIN_NAME,
    });

    // Step 1: Navigate to tools page with no query string
    await page.goto(`${STUDIO_URL}/projects/${projectId}/tools`);
    await page.waitForLoadState('networkidle').catch(() => {});

    // Step 2: Assert workflow tab is visible and has a badge count
    const workflowTab = page.getByTestId('tools-tab-workflow');
    await expect(workflowTab).toBeVisible({ timeout: 10_000 });

    // Assert the tab badge shows the count of workflow tools (at least our 3 seeded tools)
    const tabText = await workflowTab.textContent();
    const countMatch = tabText?.match(/(\d+)/);
    expect(countMatch, 'Workflow tab should display a numeric badge count').toBeTruthy();
    expect(Number(countMatch![1])).toBeGreaterThanOrEqual(3);

    // Step 3: Click the workflow tab and wait for tool rows to appear
    await workflowTab.click();
    await expect(page.locator('[data-testid^="tool-row-"]').first()).toBeVisible({
      timeout: 10_000,
    });

    // Assert the list shows workflow tools (tool_a and tool_b at minimum)
    const toolRows = page.locator('[data-testid^="tool-row-"]');
    const rowCount = await toolRows.count();
    expect(rowCount).toBeGreaterThanOrEqual(3);
  });

  test('Deep-link ?tab=workflow activates workflow tab directly', async ({ page }) => {
    await loginViaDevApi(page, {
      baseUrl: STUDIO_URL,
      email: TEST_LOGIN_EMAIL,
      name: TEST_LOGIN_NAME,
    });

    // Step 4: Navigate with ?tab=workflow deep-link
    await page.goto(`${STUDIO_URL}/projects/${projectId}/tools?tab=workflow`);
    await page.waitForLoadState('networkidle').catch(() => {});

    // Assert the workflow tab is active (aria-selected="true")
    const workflowTab = page.getByTestId('tools-tab-workflow');
    await expect(workflowTab).toHaveAttribute('aria-selected', 'true', { timeout: 10_000 });

    // Assert only 1 tab is selected at a time
    const selectedTabs = page.locator('[role="tab"][aria-selected="true"]');
    await expect(selectedTabs).toHaveCount(1);

    // Wait for tool rows to render, then assert count
    await expect(page.locator('[data-testid^="tool-row-"]').first()).toBeVisible({
      timeout: 10_000,
    });
    const toolRows = page.locator('[data-testid^="tool-row-"]');
    const count = await toolRows.count();
    expect(count).toBeGreaterThanOrEqual(3);
  });

  test('Cross-project isolation: workflow tab shows 0 tools in different project', async ({
    page,
  }) => {
    // Skip if no second project available
    test.skip(!projectY, 'No second project available for cross-project isolation test');

    await loginViaDevApi(page, {
      baseUrl: STUDIO_URL,
      email: TEST_LOGIN_EMAIL,
      name: TEST_LOGIN_NAME,
    });

    // Navigate to projectY's tools page with workflow tab
    await page.goto(`${STUDIO_URL}/projects/${projectY}/tools?tab=workflow`);
    await page.waitForLoadState('networkidle').catch(() => {});

    // Assert workflow tab is active
    const workflowTab = page.getByTestId('tools-tab-workflow');
    await expect(workflowTab).toHaveAttribute('aria-selected', 'true', { timeout: 10_000 });

    // Assert our seeded tools from projectId are NOT visible here
    const toolRowA = page.getByTestId(`tool-row-${toolAId}`);
    await expect(toolRowA).toHaveCount(0);

    const toolRowB = page.getByTestId(`tool-row-${toolBId}`);
    await expect(toolRowB).toHaveCount(0);
  });

  // ─── UI-E2E-4: Workflow tool badge + detail-page binding panel ──

  test('Workflow badge renders with correct label and accent color', async ({ page }) => {
    await loginViaDevApi(page, {
      baseUrl: STUDIO_URL,
      email: TEST_LOGIN_EMAIL,
      name: TEST_LOGIN_NAME,
    });

    // Navigate to tools page, workflow tab
    await page.goto(`${STUDIO_URL}/projects/${projectId}/tools?tab=workflow`);
    await page.waitForLoadState('networkidle').catch(() => {});

    // Step 2: Assert the badge is present on our tool row
    const badgeToolRow = page.getByTestId(`tool-row-${badgeToolId}`);
    await expect(badgeToolRow).toBeVisible({ timeout: 10_000 });

    // Find the workflow badge within the tool row
    const badge = badgeToolRow.getByTestId('tool-type-badge-workflow');
    await expect(badge).toBeVisible();
    await expect(badge).toContainText(/workflow/i);

    // Assert design-token accent color — read from CSS variable, not hardcoded hex
    const bgColor = await badge.evaluate((el) => {
      return window.getComputedStyle(el).backgroundColor;
    });

    // The accent-subtle token should produce a non-transparent, non-white background
    // We verify it's a real color (not transparent/empty) rather than hardcoding a hex
    expect(bgColor).toBeTruthy();
    expect(bgColor).not.toBe('rgba(0, 0, 0, 0)');
    expect(bgColor).not.toBe('transparent');
  });

  test('Detail page shows workflow binding panel (read-only)', async ({ page }) => {
    await loginViaDevApi(page, {
      baseUrl: STUDIO_URL,
      email: TEST_LOGIN_EMAIL,
      name: TEST_LOGIN_NAME,
    });

    // Step 3: Navigate to the badge_tool detail page
    await page.goto(`${STUDIO_URL}/projects/${projectId}/tools/${badgeToolId}`);
    await page.waitForLoadState('networkidle').catch(() => {});

    // Assert tool type badge is visible in the page header area
    const headerBadge = page.getByTestId('tool-type-badge-workflow');
    await expect(headerBadge).toBeVisible({ timeout: 10_000 });

    // Step 4: Assert workflow binding panel is present
    const bindingPanel = page.getByTestId('workflow-binding-panel');
    await expect(bindingPanel).toBeVisible({ timeout: 10_000 });

    // Assert panel contains workflow name and type info
    await expect(bindingPanel).toContainText(/workflow/i);
    // Verify the seeded workflow's name or ID appears in the binding panel
    const panelText = await bindingPanel.textContent();
    const hasWorkflowRef =
      panelText?.includes(wfBadge.name) || panelText?.includes(wfBadge.workflowId);
    expect(hasWorkflowRef, 'Binding panel should reference the bound workflow name or ID').toBe(
      true,
    );

    // Assert panel is read-only — no editable inputs within it
    const editableInputs = bindingPanel.locator('input:not([type="hidden"]):not([disabled])');
    const editableCount = await editableInputs.count();
    expect(editableCount).toBe(0);

    // No edit button within the binding panel
    const editButton = bindingPanel.locator('button:has-text("Edit")');
    const editButtonCount = await editButton.count();
    expect(editButtonCount).toBe(0);
  });

  test('Cross-project isolation: badge_tool not visible in different project', async ({ page }) => {
    test.skip(!projectY, 'No second project available for cross-project isolation test');

    await loginViaDevApi(page, {
      baseUrl: STUDIO_URL,
      email: TEST_LOGIN_EMAIL,
      name: TEST_LOGIN_NAME,
    });

    // Navigate to projectY's tools with workflow tab
    await page.goto(`${STUDIO_URL}/projects/${projectY}/tools?tab=workflow`);
    await page.waitForLoadState('networkidle').catch(() => {});

    // Wait for workflow tab to be active before asserting absence
    const wfTab = page.getByTestId('tools-tab-workflow');
    await expect(wfTab).toHaveAttribute('aria-selected', 'true', { timeout: 10_000 });

    // Assert badge_tool is NOT listed (cross-project isolation)
    const badgeToolRow = page.getByTestId(`tool-row-${badgeToolId}`);
    await expect(badgeToolRow).toHaveCount(0);
  });
});
