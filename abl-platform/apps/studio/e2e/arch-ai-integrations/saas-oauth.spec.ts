/**
 * S1: SaaS OAuth — Slack end-to-end via Arch overlay.
 *
 * Real Playwright E2E. No platform mocks. Requires:
 *   - Studio + runtime + Mongo + Redis running
 *   - Mock OAuth provider fixture (TODO(ABLP-162): not yet implemented)
 *   - Project + agent seeding helper (TODO(ABLP-162): integration-aware seed helper)
 *
 * Scenario:
 *   1. Open Arch overlay on a project page
 *   2. Type "Hook up Slack so ops_agent can post into #ops"
 *   3. SecretInput widget renders → fill clientSecret → submit
 *   4. OAuthLaunch widget renders → click → mock provider auto-consents
 *   5. SingleSelect widget renders → pick channel #ops (C123)
 *   6. DiffCard renders → Approve
 *   7. Test result card shows pass
 *   8. Integration tab shows complete card with Slack draft
 *
 * @e2e-real
 */

import { expect, test } from '@playwright/test';
import { loginViaDevApi } from '../helpers/auth';
import { env } from '../helpers/env';

const BASE_URL = env.baseUrl;

// TODO(ABLP-162): Remove this skip once the following fixtures land:
//   - apps/studio/e2e/fixtures/mock-oauth-provider.ts (start/stop slack OAuth simulator)
//   - apps/studio/e2e/fixtures/integration-project.ts (seed project + agent w/ unbound TOOLS)
//   - data-testid="arch-toggle" / "arch-input" / "arch-send" wired in ArchOverlay
//   - data-widget="SecretInput|OAuthLaunch|SingleSelect|DiffCard" attributes on widgets
//   - data-result="pass" on TestResultCard
//   - data-tab="integration" + data-draft-status="complete" on integration tab
test.skip(true, 'TODO(ABLP-162): pending mock OAuth provider fixture + arch overlay testid wiring');

test.describe('Arch integrations — Slack OAuth (S1)', () => {
  test('completes Slack OAuth integration end-to-end via Arch overlay', async ({ page }) => {
    // --- Setup: seed project + agent, start mock OAuth provider ---
    // TODO(ABLP-162): replace with real fixtures
    const project = {
      id: 'TODO-project-id',
      createAgent: async (_args: { name: string; dsl: string }) => {
        /* fixture seed */
      },
    };
    const mockOAuthProvider = {
      start: async (_args: { provider: string; scopes: string[] }) => {
        /* fixture */
      },
      stop: async () => {
        /* fixture */
      },
    };

    await loginViaDevApi(page, {
      baseUrl: BASE_URL,
      email: `arch-int-slack-${Date.now()}@e2e-smoke.test`,
      name: 'Arch Integrations E2E',
      landingPath: '/projects',
    });

    await project.createAgent({
      name: 'ops_agent',
      dsl: 'GOAL: handle ops tasks\nTOOLS: post_slack_message(channel: string, text: string) -> { ok: boolean }',
    });

    await mockOAuthProvider.start({
      provider: 'slack',
      scopes: ['chat:write'],
    });

    try {
      // --- Open Arch overlay ---
      await page.goto(`/projects/${project.id}`);
      await page.click('[data-testid="arch-toggle"]');

      // --- Send the integration prompt ---
      await page.fill(
        '[data-testid="arch-input"]',
        'Hook up Slack so ops_agent can post into #ops',
      );
      await page.click('[data-testid="arch-send"]');

      // --- SecretInput: clientSecret ---
      await expect(page.locator('[data-widget="SecretInput"]')).toBeVisible({ timeout: 30_000 });
      await page.fill('[data-widget="SecretInput"] input', 'mock-client-secret');
      await page.click('[data-widget="SecretInput"] button[type="submit"]');

      // --- OAuthLaunch: click Connect; mock provider auto-resolves consent ---
      await expect(page.locator('[data-widget="OAuthLaunch"]')).toBeVisible({ timeout: 30_000 });
      await page.click('[data-widget="OAuthLaunch"] button');

      // --- SingleSelect: channel ---
      await expect(page.locator('[data-widget="SingleSelect"]')).toBeVisible({ timeout: 30_000 });
      await page.click('[data-widget="SingleSelect"] [data-value="C123"]'); // #ops

      // --- DiffCard: review wiring → Approve ---
      await expect(page.locator('[data-widget="DiffCard"]')).toBeVisible({ timeout: 30_000 });
      await page.click('[data-widget="DiffCard"] button:has-text("Approve")');

      // --- Tool test pass ---
      await expect(page.locator('[data-result="pass"]')).toBeVisible({ timeout: 30_000 });

      // --- Integration tab shows complete card with all 4 status pills ---
      await page.click('[data-tab="integration"]');
      const card = page.locator('[data-draft-status="complete"]');
      await expect(card).toContainText('Slack');
      await expect(card.locator('[data-pill="auth"]')).toHaveAttribute('data-state', 'ok');
      await expect(card.locator('[data-pill="tools"]')).toHaveAttribute('data-state', 'ok');
      await expect(card.locator('[data-pill="wiring"]')).toHaveAttribute('data-state', 'ok');
      await expect(card.locator('[data-pill="test"]')).toHaveAttribute('data-state', 'ok');
    } finally {
      await mockOAuthProvider.stop();
    }
  });
});
