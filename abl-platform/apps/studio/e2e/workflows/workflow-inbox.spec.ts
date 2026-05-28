/**
 * Workflow Inbox E2E — UI shell coverage
 *
 * Covers the Unified Inbox page structure: empty state rendering, filter-bar
 * controls, and type-pill switching. Interacts only via the UI — no direct
 * DB access, no component mocks.
 *
 * Out of scope for this spec (documented gap in agents.md):
 *   - Live approval / human-task lifecycle (create suspended task, resolve
 *     via UI, observe workflow resume). That flow requires Restate +
 *     workflow-engine suspension wiring and is blocked on a stable dev-stack
 *     setup where we can reliably produce a pending durable promise.
 *
 * This spec's job is to make the Inbox page structurally stable: if a future
 * refactor breaks the empty state, filter pills, or mailbox toggle, CI fails.
 */

import { test, expect, type Page } from '@playwright/test';
import { loginAndSetup } from './helpers';

const STUDIO_URL = 'http://localhost:5173';

/**
 * Navigate to the Inbox page from the project sidebar. Falls back to a
 * direct URL if the sidebar button is not visible (layout variant).
 */
async function navigateToInbox(page: Page, projectId: string): Promise<void> {
  const sidebarBtn = page
    .locator(
      'aside button:has-text("Inbox"), [role="complementary"] button:has-text("Inbox"), nav button:has-text("Inbox")',
    )
    .first();
  if (await sidebarBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
    await sidebarBtn.click();
  } else {
    await page.goto(`${STUDIO_URL}/projects/${projectId}/inbox`);
  }
  await page.waitForLoadState('networkidle');
  // Page wrapper is the deterministic anchor — wait on it instead of a sleep.
  await expect(page.getByTestId('unified-inbox-page')).toBeVisible({ timeout: 15_000 });
}

test.describe('Workflow Inbox — UI shell', () => {
  test('renders the empty state when no pending tasks exist', async ({ page }) => {
    const { projectId } = await loginAndSetup(page);
    await navigateToInbox(page, projectId);

    // The page reliably renders one of three states: loading → then either
    // empty or list. For the default E2E account we expect empty.
    const empty = page.getByTestId('unified-inbox-empty');
    const list = page.getByTestId('unified-inbox-list');

    // Wait for the loading skeleton to resolve into one of the two terminal
    // states. If the account happens to have tasks, we still pass — the
    // empty-state assertion below is conditional.
    await expect(empty.or(list)).toBeVisible({ timeout: 15_000 });

    if (await empty.isVisible().catch(() => false)) {
      await expect(empty).toContainText('No tasks');
      await expect(empty).toContainText('workflow tasks');
    } else {
      // Non-empty account — assert the list is scoped to real task cards.
      await expect(list.getByTestId('human-task-card').first()).toBeVisible();
    }
  });

  test('filter bar exposes Workflow / Agent mailbox toggle and the type-pill sub-filters', async ({
    page,
  }) => {
    const { projectId } = await loginAndSetup(page);
    await navigateToInbox(page, projectId);

    const filterBar = page.getByTestId('unified-inbox-filter-bar');
    await expect(filterBar).toBeVisible();

    // Default mailbox is workflow, default type is "all".
    await expect(filterBar).toHaveAttribute('data-active-mailbox', 'workflow');
    await expect(filterBar).toHaveAttribute('data-active-type', 'all');

    // Workflow mailbox type pills: All, Approvals, Data Entry.
    await expect(page.getByTestId('inbox-type-filter-all')).toBeVisible();
    await expect(page.getByTestId('inbox-type-filter-approval')).toBeVisible();
    await expect(page.getByTestId('inbox-type-filter-data_entry')).toBeVisible();
  });

  test('clicking a type pill switches the active filter and updates the data-active flag', async ({
    page,
  }) => {
    const { projectId } = await loginAndSetup(page);
    await navigateToInbox(page, projectId);

    const filterBar = page.getByTestId('unified-inbox-filter-bar');
    const allPill = page.getByTestId('inbox-type-filter-all');
    const approvalPill = page.getByTestId('inbox-type-filter-approval');

    // Initial state: "all" is active.
    await expect(allPill).toHaveAttribute('data-active', 'true');
    await expect(approvalPill).toHaveAttribute('data-active', 'false');

    await approvalPill.click();

    await expect(approvalPill).toHaveAttribute('data-active', 'true');
    await expect(allPill).toHaveAttribute('data-active', 'false');
    await expect(filterBar).toHaveAttribute('data-active-type', 'approval');
  });

  test('switching to the Agent mailbox reveals the agent-specific type pills and resets the active type to "all"', async ({
    page,
  }) => {
    const { projectId } = await loginAndSetup(page);
    await navigateToInbox(page, projectId);

    // Pre-condition: change the workflow type filter so the "reset on mailbox
    // change" behaviour is observable.
    await page.getByTestId('inbox-type-filter-approval').click();
    await expect(page.getByTestId('unified-inbox-filter-bar')).toHaveAttribute(
      'data-active-type',
      'approval',
    );

    // The mailbox switcher is the SegmentedControl — target the Agent option
    // by its visible label (controlled by the sidebar component, not a testid).
    const agentBtn = page
      .getByTestId('unified-inbox-filter-bar')
      .locator('button', { hasText: 'Agent' });
    await agentBtn.click();

    await expect(page.getByTestId('unified-inbox-filter-bar')).toHaveAttribute(
      'data-active-mailbox',
      'agent',
    );
    // Active type should reset to 'all' after mailbox change.
    await expect(page.getByTestId('unified-inbox-filter-bar')).toHaveAttribute(
      'data-active-type',
      'all',
    );

    // Agent-only type pill should be present; workflow-only pills should not be.
    await expect(page.getByTestId('inbox-type-filter-escalation')).toBeVisible();
    await expect(page.getByTestId('inbox-type-filter-approval')).toHaveCount(0);
    await expect(page.getByTestId('inbox-type-filter-data_entry')).toHaveCount(0);
  });
});
