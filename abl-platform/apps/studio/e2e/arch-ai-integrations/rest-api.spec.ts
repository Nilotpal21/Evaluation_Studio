/**
 * S5: REST API integration via cURL paste.
 *
 * Real Playwright E2E. No platform mocks. Requires:
 *   - Studio + runtime + Mongo + Redis
 *   - Mock REST endpoint reachable from runtime (e.g., httpbin-style test server)
 *
 * Scenario:
 *   1. Open Arch overlay on a project page
 *   2. Paste a cURL command for a bearer-protected REST endpoint
 *   3. CurlPasteWidget parses → confirms method/URL/auth scheme
 *   4. SecretInput renders for bearer token → fill + submit
 *   5. Tool created (DiffCard shows tool def)
 *   6. Approve → tool wired into selected agent
 *   7. Test result card shows pass against the live mock endpoint
 *
 * @e2e-real
 */

import { expect, test } from '@playwright/test';
import { loginViaDevApi } from '../helpers/auth';
import { env } from '../helpers/env';

const BASE_URL = env.baseUrl;

// TODO(ABLP-162): Pending fixtures:
//   - apps/studio/e2e/fixtures/mock-rest-endpoint.ts (bearer-protected echo server)
//   - apps/studio/e2e/fixtures/integration-project.ts
//   - data-widget="CurlPasteWidget" with input + parse confirmation
test.skip(true, 'TODO(ABLP-162): pending mock REST endpoint fixture + curl paste widget testids');

test.describe('Arch integrations — REST API via cURL (S5)', () => {
  test('parses cURL, captures bearer token, creates tool, wires + tests', async ({ page }) => {
    const project = { id: 'TODO-project-id' };
    const mockRest = {
      url: 'http://localhost:0/api/echo', // TODO(ABLP-162): from fixture
      bearer: 'mock-bearer-token-xyz',
      start: async () => {
        /* fixture */
      },
      stop: async () => {
        /* fixture */
      },
    };

    await loginViaDevApi(page, {
      baseUrl: BASE_URL,
      email: `arch-int-rest-${Date.now()}@e2e-smoke.test`,
      name: 'Arch Integrations E2E',
      landingPath: '/projects',
    });

    await mockRest.start();
    try {
      await page.goto(`/projects/${project.id}`);
      await page.click('[data-testid="arch-toggle"]');

      const curlCmd = `curl -X POST ${mockRest.url} -H "Authorization: Bearer <token>" -H "Content-Type: application/json" -d '{"message":"hello"}'`;
      await page.fill('[data-testid="arch-input"]', `Add a tool from this cURL:\n${curlCmd}`);
      await page.click('[data-testid="arch-send"]');

      // CurlPasteWidget confirms parse
      await expect(page.locator('[data-widget="CurlPasteWidget"]')).toBeVisible({
        timeout: 30_000,
      });
      await expect(page.locator('[data-widget="CurlPasteWidget"]')).toContainText('POST');
      await expect(page.locator('[data-widget="CurlPasteWidget"]')).toContainText(mockRest.url);
      await page.click('[data-widget="CurlPasteWidget"] button:has-text("Confirm")');

      // SecretInput for bearer
      await expect(page.locator('[data-widget="SecretInput"]')).toBeVisible({ timeout: 30_000 });
      await page.fill('[data-widget="SecretInput"] input', mockRest.bearer);
      await page.click('[data-widget="SecretInput"] button[type="submit"]');

      // Tool created — DiffCard shows the tool
      await expect(page.locator('[data-widget="DiffCard"]')).toBeVisible({ timeout: 30_000 });
      await expect(page.locator('[data-widget="DiffCard"]')).toContainText('echo');
      await page.click('[data-widget="DiffCard"] button:has-text("Approve")');

      // Test against live mock endpoint
      await expect(page.locator('[data-result="pass"]')).toBeVisible({ timeout: 30_000 });

      // Integration tab shows complete card
      await page.click('[data-tab="integration"]');
      await expect(page.locator('[data-draft-status="complete"]')).toContainText(/REST|echo/i);
    } finally {
      await mockRest.stop();
    }
  });
});
