/**
 * S2: Suggestion card for unbound TOOLS.
 *
 * Real Playwright E2E. No platform mocks. Requires:
 *   - Studio + runtime + Mongo + Redis
 *   - Project + agent with unbound TOOLS in DSL (e.g., post_slack_message
 *     declared but no integration backing it)
 *
 * Scenario:
 *   1. Open Arch overlay on a project that has an agent with unbound TOOLS
 *   2. Expect IntegrationSuggestionCard to render automatically
 *   3. Click the provider button (e.g., "Set up Slack")
 *   4. Verify start_integration prefill triggers — input pre-populated and
 *      a SecretInput / OAuthLaunch widget renders next
 *
 * @e2e-real
 */

import { expect, test } from '@playwright/test';
import { loginViaDevApi } from '../helpers/auth';
import { env } from '../helpers/env';

const BASE_URL = env.baseUrl;

// TODO(ABLP-162): Pending fixtures:
//   - apps/studio/e2e/fixtures/integration-project.ts (seed agent w/ unbound TOOLS)
//   - data-widget="IntegrationSuggestionCard" + per-provider buttons
test.skip(true, 'TODO(ABLP-162): pending integration-project fixture w/ unbound TOOLS seeding');

test.describe('Arch integrations — Suggestion card (S2)', () => {
  test('renders suggestion for unbound TOOLS and triggers start_integration prefill on click', async ({
    page,
  }) => {
    const project = { id: 'TODO-project-id' };

    await loginViaDevApi(page, {
      baseUrl: BASE_URL,
      email: `arch-int-suggest-${Date.now()}@e2e-smoke.test`,
      name: 'Arch Integrations E2E',
      landingPath: '/projects',
    });

    // Project pre-seeded with agent containing:
    //   TOOLS: post_slack_message(channel: string, text: string) -> { ok: boolean }
    // and NO matching integration draft.

    await page.goto(`/projects/${project.id}`);
    await page.click('[data-testid="arch-toggle"]');

    // Suggestion card should auto-render based on unbound-TOOLS detection.
    const suggestion = page.locator('[data-widget="IntegrationSuggestionCard"]');
    await expect(suggestion).toBeVisible({ timeout: 30_000 });
    await expect(suggestion).toContainText(/post_slack_message|Slack/i);

    // Click the Slack provider button.
    await suggestion.locator('[data-provider="slack"] button').click();

    // The Arch input should be prefilled with a start_integration prompt and a
    // widget should render (auth gate).
    await expect(page.locator('[data-testid="arch-input"]')).toHaveValue(/slack/i, {
      timeout: 5_000,
    });
    await expect(
      page.locator('[data-widget="SecretInput"], [data-widget="OAuthLaunch"]'),
    ).toBeVisible({ timeout: 30_000 });
  });
});
