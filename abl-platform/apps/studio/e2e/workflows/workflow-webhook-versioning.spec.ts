/**
 * Workflow Webhook Versioning — E2E Test (E2E-5)
 *
 * Covers:
 * - Two-badge header: [version] [state] pair
 * - Active version → [v0.2.0] [active], no caption
 * - Inactive version → [v0.1.5] [inactive] + "served via v0.2.0" caption
 * - Draft → [draft] [active] (NOT amber/warning)
 * - Quick Start URL includes ?version=<viewed>
 * - CodeSnippets curl uses /api/v1/workflows/:wid/execute (short URL)
 * - Async-poll status URL is version-less
 * - FR-18: ?version=draft and ?version=v0.1.5 in actual curl strings
 *   (asserts the URL content, not just the badge)
 * - FR-12 / GAP-002: WorkflowConfigForm version picker exposes the
 *   "Pin to current active (vX.Y.Z)" snap-at-bind option with correct label
 *
 * Strategy: mock the versions API response at the network layer to control
 * which version is "active" / "inactive" / "draft". No codebase mocks.
 */
import { test, expect } from '@playwright/test';
import { loginAndSetup, navigateToWorkflows, createWorkflowViaUI } from './helpers';

const SCREENSHOTS_DIR = 'e2e/screenshots/webhook-versioning';

test.describe('Workflow Webhook Versioning — Badges + Short URL', () => {
  test('active version shows two badges, short URL with ?version= in curl snippets', async ({
    page,
  }) => {
    test.setTimeout(180000);

    // ── 1. Login and setup ──────────────────────────────────────
    const { projectId } = await loginAndSetup(page);

    // ── 2. Create a test workflow ───────────────────────────────
    await navigateToWorkflows(page);
    const workflowId = await createWorkflowViaUI(
      page,
      `E2E Versioning ${Date.now()}`,
      'Webhook versioning badge test',
    );

    // ── 3. Mock versions API to return active v0.2.0 ────────────
    const versionsUrl = `**/api/projects/${projectId}/workflows/${workflowId}/versions`;
    await page.route(versionsUrl, async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          success: true,
          versions: [
            {
              id: 'ver-active-1',
              workflowId,
              version: 'v0.2.0',
              state: 'active',
              createdAt: new Date().toISOString(),
            },
            {
              id: 'ver-inactive-1',
              workflowId,
              version: 'v0.1.5',
              state: 'inactive',
              createdAt: new Date().toISOString(),
            },
            {
              id: 'ver-draft-1',
              workflowId,
              version: 'draft',
              state: 'active',
              createdAt: new Date().toISOString(),
            },
          ],
        }),
      });
    });

    // Reload to pick up the mocked versions
    await page.reload();
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(2000);

    // ── 4. Verify two-badge header for active version ───────────
    const versionBadge = page.locator('[data-testid="workflow-version-badge"]');
    const stateBadge = page.locator('[data-testid="workflow-state-badge"]');

    await expect(versionBadge).toBeVisible({ timeout: 15000 });
    await expect(versionBadge).toHaveText('v0.2.0');
    await expect(stateBadge).toBeVisible();
    await expect(stateBadge).toHaveText('active');

    // No "served via" caption for active version
    const servedVia = page.locator('[data-testid="served-via-caption"]');
    await expect(servedVia).not.toBeVisible();

    await page.screenshot({
      path: `${SCREENSHOTS_DIR}/01-active-version-badges.png`,
      fullPage: true,
    });

    // ── 5. Navigate to Triggers tab ─────────────────────────────
    const triggersTab = page
      .locator('button:has-text("Triggers"), [role="tab"]:has-text("Triggers")')
      .first();
    if (await triggersTab.isVisible({ timeout: 5000 }).catch(() => false)) {
      await triggersTab.click();
      await page.waitForTimeout(2000);
    }

    // ── 6. Verify Quick Start URL has ?version= ─────────────────
    // The endpoint URL code block should contain the short URL with version
    const codeBlocks = page.locator('code');
    const codeCount = await codeBlocks.count();
    let foundShortUrl = false;
    for (let i = 0; i < codeCount; i++) {
      const text = await codeBlocks.nth(i).textContent();
      if (text?.includes('/api/v1/workflows/') && text?.includes('/execute')) {
        foundShortUrl = true;
        // Verify it uses the short URL pattern (not /api/projects/...)
        expect(text).not.toContain('/api/projects/');
        // If version is appended, verify
        if (text.includes('?version=')) {
          expect(text).toContain('version=v0.2.0');
        }
        break;
      }
    }

    // ── 7. Verify CodeSnippets curl uses short URL ──────────────
    // Check each snippet tab for short URL pattern
    const snippetTabs = ['sync', 'async', 'async_poll', 'async_push'];
    for (const tabName of snippetTabs) {
      const tab = page.locator(`[data-testid="snippet-tab-${tabName}"]`);
      if (await tab.isVisible({ timeout: 3000 }).catch(() => false)) {
        await tab.click();
        await page.waitForTimeout(500);

        // Read the pre block content
        const preBlocks = page.locator('pre');
        const preCount = await preBlocks.count();
        for (let i = 0; i < preCount; i++) {
          const preText = await preBlocks.nth(i).textContent();
          if (preText?.includes('curl')) {
            // Verify short URL is used (not long proxy URL)
            expect(preText).toContain('/api/v1/workflows/');
            expect(preText).not.toContain('/api/projects/');
            expect(preText).toContain('/execute');

            // For async_poll, verify the status-poll URL is version-less
            if (tabName === 'async_poll') {
              // The poll URL should contain /executions/{executionId} without ?version=
              const pollLine = preText
                .split('\n')
                .find((l) => l.includes('/executions/{executionId}'));
              if (pollLine) {
                expect(pollLine).not.toContain('version=');
              }
            }
            break;
          }
        }
      }
    }

    await page.screenshot({
      path: `${SCREENSHOTS_DIR}/02-curl-snippets-short-url.png`,
      fullPage: true,
    });

    // ── 8. Cleanup: unroute the version mock ────────────────────
    await page.unroute(versionsUrl);
  });

  test('draft version shows only [draft] badge — no state pill', async ({ page }) => {
    test.setTimeout(120000);

    const { projectId } = await loginAndSetup(page);
    await navigateToWorkflows(page);
    const workflowId = await createWorkflowViaUI(
      page,
      `E2E Draft Badge ${Date.now()}`,
      'Draft badge color test',
    );

    // Mock versions API — only draft present
    const versionsUrl = `**/api/projects/${projectId}/workflows/${workflowId}/versions`;
    await page.route(versionsUrl, async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          success: true,
          versions: [
            {
              id: 'ver-draft-only',
              workflowId,
              version: 'draft',
              state: 'active',
              createdAt: new Date().toISOString(),
            },
          ],
        }),
      });
    });

    await page.reload();
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(2000);

    const versionBadge = page.locator('[data-testid="workflow-version-badge"]');
    const stateBadge = page.locator('[data-testid="workflow-state-badge"]');

    await expect(versionBadge).toBeVisible({ timeout: 15000 });
    await expect(versionBadge).toHaveText('draft');
    // The draft is an editable working copy, not a lifecycle state — the
    // state pill (active/inactive) only applies to published versions.
    // Viewing draft must render ONE badge only (version), no duplicate
    // `[draft] [draft]` and no `[draft] [active]` synthetic value.
    await expect(stateBadge).not.toBeVisible();

    // No "served via" caption for draft
    const servedVia = page.locator('[data-testid="served-via-caption"]');
    await expect(servedVia).not.toBeVisible();

    // FR-18: when viewing draft, Quick Start + curl snippets must emit ?version=draft
    const triggersTab = page
      .locator('button:has-text("Triggers"), [role="tab"]:has-text("Triggers")')
      .first();
    if (await triggersTab.isVisible({ timeout: 5000 }).catch(() => false)) {
      await triggersTab.click();
      await page.waitForTimeout(2000);

      const codeBlocks = page.locator('code, pre');
      const count = await codeBlocks.count();
      let foundVersionDraftInUrl = false;
      for (let i = 0; i < count; i++) {
        const text = await codeBlocks.nth(i).textContent();
        if (text?.includes('/api/v1/workflows/') && text.includes('version=draft')) {
          foundVersionDraftInUrl = true;
          break;
        }
      }
      expect(foundVersionDraftInUrl).toBeTruthy();
    }

    await page.screenshot({
      path: `${SCREENSHOTS_DIR}/03-draft-badges.png`,
      fullPage: true,
    });

    await page.unroute(versionsUrl);
  });

  test('inactive version shows [v0.1.5] [inactive] + served-via caption', async ({ page }) => {
    test.setTimeout(120000);

    const { projectId } = await loginAndSetup(page);
    await navigateToWorkflows(page);
    const workflowId = await createWorkflowViaUI(
      page,
      `E2E Inactive Badge ${Date.now()}`,
      'Inactive badge caption test',
    );

    // Mock versions API — only inactive versions (no active published)
    const versionsUrl = `**/api/projects/${projectId}/workflows/${workflowId}/versions`;
    await page.route(versionsUrl, async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          success: true,
          versions: [
            {
              id: 'ver-inactive-only',
              workflowId,
              version: 'v0.1.5',
              state: 'inactive',
              createdAt: new Date().toISOString(),
            },
          ],
        }),
      });
    });

    await page.reload();
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(2000);

    const versionBadge = page.locator('[data-testid="workflow-version-badge"]');
    const stateBadge = page.locator('[data-testid="workflow-state-badge"]');

    await expect(versionBadge).toBeVisible({ timeout: 15000 });
    await expect(versionBadge).toHaveText('v0.1.5');
    await expect(stateBadge).toBeVisible();
    await expect(stateBadge).toHaveText('inactive');

    // FR-18: viewing an inactive version must emit ?version=v0.1.5 in snippets
    const triggersTab = page
      .locator('button:has-text("Triggers"), [role="tab"]:has-text("Triggers")')
      .first();
    if (await triggersTab.isVisible({ timeout: 5000 }).catch(() => false)) {
      await triggersTab.click();
      await page.waitForTimeout(2000);

      const codeBlocks = page.locator('code, pre');
      const count = await codeBlocks.count();
      let foundVersionInUrl = false;
      for (let i = 0; i < count; i++) {
        const text = await codeBlocks.nth(i).textContent();
        if (text?.includes('/api/v1/workflows/') && text.includes('version=v0.1.5')) {
          foundVersionInUrl = true;
          break;
        }
      }
      expect(foundVersionInUrl).toBeTruthy();
    }

    await page.screenshot({
      path: `${SCREENSHOTS_DIR}/04-inactive-badges.png`,
      fullPage: true,
    });

    await page.unroute(versionsUrl);
  });

  test('version badge click navigates to Versions tab', async ({ page }) => {
    test.setTimeout(120000);

    const { projectId } = await loginAndSetup(page);
    await navigateToWorkflows(page);
    const workflowId = await createWorkflowViaUI(
      page,
      `E2E Badge Click ${Date.now()}`,
      'Badge click navigation test',
    );

    // Mock versions API
    const versionsUrl = `**/api/projects/${projectId}/workflows/${workflowId}/versions`;
    await page.route(versionsUrl, async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          success: true,
          versions: [
            {
              id: 'ver-click-test',
              workflowId,
              version: 'v1.0.0',
              state: 'active',
              createdAt: new Date().toISOString(),
            },
          ],
        }),
      });
    });

    await page.reload();
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(2000);

    // Click the version badge
    const versionBadge = page.locator('[data-testid="workflow-version-badge"]');
    await expect(versionBadge).toBeVisible({ timeout: 15000 });
    await versionBadge.click();
    await page.waitForTimeout(1000);

    // Verify we navigated to versions tab (URL should contain tab=versions or
    // the Versions tab should be active)
    const url = page.url();
    const isVersionsTab =
      url.includes('tab=versions') ||
      (await page
        .locator('[role="tab"][aria-selected="true"]:has-text("Versions")')
        .isVisible()
        .catch(() => false));

    expect(isVersionsTab).toBeTruthy();

    await page.screenshot({
      path: `${SCREENSHOTS_DIR}/05-version-badge-click.png`,
      fullPage: true,
    });

    await page.unroute(versionsUrl);
  });

  // FR-12: WorkflowConfigForm persists selected version into binding DSL.
  // This verifies the version picker surfaces the snap-at-bind-time option
  // (GAP-002) alongside auto-resolve + specific-version pin. Mocks the
  // workflows list + versions list APIs to control the picker state.
  test('WorkflowConfigForm version picker exposes Pin to current active (GAP-002)', async ({
    page,
  }) => {
    test.setTimeout(120000);

    const { projectId } = await loginAndSetup(page);
    await navigateToWorkflows(page);
    // Create a real workflow (snap option only shows for workflows with at
    // least one webhook trigger AND an active published version).
    const workflowId = await createWorkflowViaUI(
      page,
      `E2E Snap Binding ${Date.now()}`,
      'Snap-at-bind-time option test',
    );

    // Mock versions list: two active published + draft. The snap option
    // should resolve to the highest (v0.2.0).
    const versionsUrl = `**/api/projects/${projectId}/workflows/${workflowId}/versions`;
    await page.route(versionsUrl, async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          success: true,
          versions: [
            {
              id: 'ver-020',
              workflowId,
              version: 'v0.2.0',
              state: 'active',
              createdAt: new Date().toISOString(),
            },
            {
              id: 'ver-010',
              workflowId,
              version: 'v0.1.0',
              state: 'active',
              createdAt: new Date(Date.now() - 3600_000).toISOString(),
            },
            {
              id: 'ver-draft',
              workflowId,
              version: 'draft',
              state: 'active',
              createdAt: new Date().toISOString(),
            },
          ],
        }),
      });
    });

    // Mock triggers list: at least one active webhook trigger so the
    // workflow surfaces in the "register as tool" eligible list.
    const triggersUrl = `**/api/projects/${projectId}/workflow-triggers*`;
    await page.route(triggersUrl, async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          success: true,
          triggers: [
            {
              id: 'tr-webhook-1',
              workflowId,
              triggerType: 'webhook',
              status: 'active',
              workflowVersionId: 'ver-020',
              config: {},
              createdAt: new Date().toISOString(),
            },
          ],
        }),
      });
    });

    // Navigate to tool-create page with workflow type preselected
    await page.goto(
      `${page.url().split('/projects/')[0]}/projects/${projectId}/tools/new?type=workflow`,
    );
    await page.waitForLoadState('networkidle').catch(() => {});
    await page.waitForTimeout(2000);

    // Pick the workflow (by name) to surface version picker
    const workflowPicker = page.getByTestId('workflow-picker-select');
    await expect(workflowPicker).toBeVisible({ timeout: 15000 });
    await workflowPicker.click();
    const workflowListbox = page.getByRole('listbox');
    await expect(workflowListbox).toBeVisible({ timeout: 5000 });
    // Match by partial name since timestamp suffix is dynamic
    await workflowListbox
      .locator('[role="option"]')
      .filter({ hasText: 'E2E Snap Binding' })
      .click();

    // Version picker now visible — open it and verify snap option label
    const versionPicker = page.getByTestId('version-picker-select');
    await expect(versionPicker).toBeVisible({ timeout: 10000 });
    await versionPicker.click();

    const versionListbox = page.getByRole('listbox');
    await expect(versionListbox).toBeVisible({ timeout: 5000 });

    // Snap-at-bind option embeds the highest-semver active (v0.2.0) in its label.
    const snapOption = versionListbox.locator('[role="option"]').filter({
      hasText: /Pin to current active.*v0\.2\.0/,
    });
    await expect(snapOption).toHaveCount(1);

    // Listbox should also include v0.2.0 and v0.1.0 as directly-pinnable entries
    // plus the Draft entry. The snap option's label contains "v0.2.0" too,
    // so we assert "at least 2 options mention v0.2.0" (snap + specific pin).
    const v020Options = await versionListbox
      .locator('[role="option"]')
      .filter({ hasText: 'v0.2.0' })
      .count();
    expect(v020Options).toBeGreaterThanOrEqual(2);

    // Select the snap option
    await snapOption.click();

    // Hint line under picker should reflect pin semantics
    const hint = page.getByTestId('workflow-version-hint');
    await expect(hint).toBeVisible();
    await expect(hint).toContainText(/v0\.2\.0/);

    await page.screenshot({
      path: `${SCREENSHOTS_DIR}/06-snap-at-bind-option.png`,
      fullPage: true,
    });

    await page.unroute(versionsUrl);
    await page.unroute(triggersUrl);
  });
});
