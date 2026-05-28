/**
 * S3: Revalidate after editing auth profile via Connections page.
 *
 * Real Playwright E2E. No platform mocks. Requires:
 *   - Studio + runtime + Mongo + Redis
 *   - Mock OAuth provider OR seeded auth profile
 *
 * Scenario:
 *   1. Start an integration via Arch overlay
 *   2. Leave it parked at status=needs_input (auth not complete)
 *   3. Navigate to Connections page → edit the auth profile (fill missing field)
 *   4. Return to Arch overlay → click "Resume"
 *   5. Verify the revalidate output progresses past the auth gate
 *
 * @e2e-real
 */

import { expect, test } from '@playwright/test';
import { loginViaDevApi } from '../helpers/auth';
import { env } from '../helpers/env';

const BASE_URL = env.baseUrl;

// TODO(ABLP-162): Pending fixtures:
//   - apps/studio/e2e/fixtures/integration-project.ts
//   - apps/studio/e2e/fixtures/mock-oauth-provider.ts
//   - data-testid="connections-nav" + auth-profile editor testids
//   - data-draft-status="needs_input" / "in_progress" + Resume button
test.skip(true, 'TODO(ABLP-162): pending integration-project fixture + connections page testids');

test.describe('Arch integrations — Revalidate after profile edit (S3)', () => {
  test('parks at needs_input, edits auth profile, resumes, revalidates past auth gate', async ({
    page,
  }) => {
    const project = { id: 'TODO-project-id' };

    await loginViaDevApi(page, {
      baseUrl: BASE_URL,
      email: `arch-int-reval-${Date.now()}@e2e-smoke.test`,
      name: 'Arch Integrations E2E',
      landingPath: '/projects',
    });

    // --- Start the integration ---
    await page.goto(`/projects/${project.id}`);
    await page.click('[data-testid="arch-toggle"]');
    await page.fill('[data-testid="arch-input"]', 'Hook up Slack so ops_agent can post into #ops');
    await page.click('[data-testid="arch-send"]');

    // SecretInput appears — submit a placeholder that will fail validation
    await expect(page.locator('[data-widget="SecretInput"]')).toBeVisible({ timeout: 30_000 });
    await page.fill('[data-widget="SecretInput"] input', '');
    // Skip the input by closing overlay — leaves draft at needs_input
    await page.click('[data-testid="arch-close"]');

    // Confirm Integration tab shows needs_input
    await page.click('[data-tab="integration"]');
    await expect(page.locator('[data-draft-status="needs_input"]')).toBeVisible({
      timeout: 15_000,
    });

    // --- Navigate to Connections page, edit the auth profile ---
    await page.click('[data-testid="connections-nav"]');
    await page.waitForURL(/connections/);
    const profileRow = page.locator('[data-auth-profile-name="Slack"]').first();
    await profileRow.click();
    await page.fill('[data-testid="auth-profile-client-secret"]', 'real-client-secret-now');
    await page.click('[data-testid="auth-profile-save"]');
    await expect(page.locator('[data-toast="success"]')).toBeVisible({ timeout: 10_000 });

    // --- Return to Arch overlay → Resume ---
    await page.goto(`/projects/${project.id}`);
    await page.click('[data-testid="arch-toggle"]');
    await page.click('[data-tab="integration"]');
    await page.click('[data-draft-status="needs_input"] button:has-text("Resume")');

    // Revalidate output should progress past the auth gate
    await expect(page.locator('[data-revalidate-output]')).toBeVisible({ timeout: 30_000 });
    await expect(page.locator('[data-revalidate-output]')).toContainText(/auth.*ok/i);
    await expect(page.locator('[data-draft-status="needs_input"]')).toHaveCount(0, {
      timeout: 30_000,
    });
  });
});
