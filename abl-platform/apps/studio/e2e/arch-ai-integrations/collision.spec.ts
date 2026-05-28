/**
 * Multi-user shared-profile collision (S6).
 *
 * Real Playwright E2E. No platform mocks. Requires:
 *   - Studio + runtime + Mongo + Redis
 *   - Two browser contexts on the same tenant (user A + user B)
 *   - Mock OAuth provider OR seedable shared auth profile
 *
 * Scenario:
 *   1. User A creates a "Slack OAuth App" shared auth profile via Arch
 *   2. User B starts a Slack integration in a separate project (same tenant)
 *      and attempts to name their profile "Slack OAuth App" too
 *   3. Backend returns PROFILE_NAME_COLLISION
 *   4. Recovery widget renders with reuse-or-rename actions
 *   5. User B picks "Reuse" → existing profile is bound; integration progresses
 *
 * @e2e-real
 */

import { expect, test } from '@playwright/test';
import { loginViaDevApi } from '../helpers/auth';
import { env } from '../helpers/env';

const BASE_URL = env.baseUrl;

// TODO(ABLP-162): Pending fixtures:
//   - apps/studio/e2e/fixtures/shared-tenant.ts (two users in one tenant)
//   - apps/studio/e2e/fixtures/mock-oauth-provider.ts
//   - data-widget="ProfileNameCollisionRecovery" with reuse/rename buttons
test.skip(
  true,
  'TODO(ABLP-162): pending shared-tenant fixture + collision recovery widget testids',
);

test.describe('Arch integrations — Profile name collision (multi-user)', () => {
  test('user B sees PROFILE_NAME_COLLISION recovery and can reuse the existing profile', async ({
    browser,
  }) => {
    // --- Two contexts in the same tenant ---
    const ctxA = await browser.newContext();
    const ctxB = await browser.newContext();
    const pageA = await ctxA.newPage();
    const pageB = await ctxB.newPage();

    const tenantNonce = `collision-${Date.now().toString(36)}`;
    // TODO(ABLP-162): both users must be provisioned into the SAME tenant.
    const userA = `${tenantNonce}-userA@e2e-smoke.test`;
    const userB = `${tenantNonce}-userB@e2e-smoke.test`;

    const projectA = { id: 'TODO-projectA-id' };
    const projectB = { id: 'TODO-projectB-id' };
    const PROFILE_NAME = 'Slack OAuth App';

    try {
      await loginViaDevApi(pageA, {
        baseUrl: BASE_URL,
        email: userA,
        name: 'User A',
        landingPath: '/projects',
      });

      // --- User A creates the shared auth profile ---
      await pageA.goto(`/projects/${projectA.id}`);
      await pageA.click('[data-testid="arch-toggle"]');
      await pageA.fill(
        '[data-testid="arch-input"]',
        `Hook up Slack; name profile "${PROFILE_NAME}" shared`,
      );
      await pageA.click('[data-testid="arch-send"]');
      await expect(pageA.locator('[data-widget="SecretInput"]')).toBeVisible({ timeout: 30_000 });
      await pageA.fill('[data-widget="SecretInput"] input', 'mock-client-secret');
      await pageA.click('[data-widget="SecretInput"] button[type="submit"]');
      await expect(pageA.locator('[data-widget="OAuthLaunch"]')).toBeVisible({ timeout: 30_000 });
      await pageA.click('[data-widget="OAuthLaunch"] button');

      // --- User B attempts the same profile name ---
      await loginViaDevApi(pageB, {
        baseUrl: BASE_URL,
        email: userB,
        name: 'User B',
        landingPath: '/projects',
      });
      await pageB.goto(`/projects/${projectB.id}`);
      await pageB.click('[data-testid="arch-toggle"]');
      await pageB.fill(
        '[data-testid="arch-input"]',
        `Hook up Slack; name profile "${PROFILE_NAME}" shared`,
      );
      await pageB.click('[data-testid="arch-send"]');

      // Collision recovery widget renders
      const recovery = pageB.locator('[data-widget="ProfileNameCollisionRecovery"]');
      await expect(recovery).toBeVisible({ timeout: 30_000 });
      await expect(recovery).toContainText(PROFILE_NAME);
      await expect(recovery.locator('button:has-text("Reuse")')).toBeVisible();
      await expect(recovery.locator('button:has-text("Rename")')).toBeVisible();

      // Click Reuse — integration should progress
      await recovery.locator('button:has-text("Reuse")').click();

      // Next gate (e.g., channel select) should appear since auth is reused
      await expect(
        pageB.locator(
          '[data-widget="OAuthLaunch"], [data-widget="SingleSelect"], [data-widget="DiffCard"]',
        ),
      ).toBeVisible({ timeout: 30_000 });
    } finally {
      await ctxA.close();
      await ctxB.close();
    }
  });
});
