/**
 * Sanitization: tool-test failure messages must redact URL credentials and
 * stack lines from chat-displayed errors.
 *
 * Real Playwright E2E. No platform mocks. Requires:
 *   - Studio + runtime + Mongo + Redis
 *   - A REST integration where the runtime's outbound request will fail
 *     with an error message containing a credentialled URL like
 *     `https://user:secret@example.com/api` and a stack trace
 *
 * Scenario:
 *   1. Set up a REST integration whose test call will fail
 *   2. Force the failure mode (unreachable host, 500 from mock)
 *   3. Assert the chat-displayed error:
 *      - Does NOT contain the password segment of the URL
 *      - Does NOT contain stack frame lines (e.g., "at Function.x (...:42:7)")
 *      - DOES contain a high-level "test failed" message + a sanitized URL
 *
 * @e2e-real
 */

import { expect, test } from '@playwright/test';
import { loginViaDevApi } from '../helpers/auth';
import { env } from '../helpers/env';

const BASE_URL = env.baseUrl;

// TODO(ABLP-162): Pending fixtures:
//   - apps/studio/e2e/fixtures/mock-rest-endpoint.ts (configurable failure modes)
//   - apps/studio/e2e/fixtures/integration-project.ts
//   - data-result="fail" with a [data-error-message] child element
test.skip(true, 'TODO(ABLP-162): pending mock REST endpoint with failure-mode injection');

test.describe('Arch integrations — Error message sanitization', () => {
  test('redacts URL credentials and stack lines from chat-displayed test failure', async ({
    page,
  }) => {
    const project = { id: 'TODO-project-id' };
    const credentialledUrl = 'https://e2euser:supersecret@unreachable.invalid/api/echo';
    const mockRest = {
      url: credentialledUrl,
      forceFailure: 'unreachable' as const,
      start: async () => {
        /* fixture */
      },
      stop: async () => {
        /* fixture */
      },
    };

    await loginViaDevApi(page, {
      baseUrl: BASE_URL,
      email: `arch-int-sanitize-${Date.now()}@e2e-smoke.test`,
      name: 'Arch Integrations E2E',
      landingPath: '/projects',
    });

    await mockRest.start();
    try {
      await page.goto(`/projects/${project.id}`);
      await page.click('[data-testid="arch-toggle"]');

      const curlCmd = `curl -X GET ${credentialledUrl}`;
      await page.fill('[data-testid="arch-input"]', `Add a tool from this cURL:\n${curlCmd}`);
      await page.click('[data-testid="arch-send"]');

      // Walk through the gates rapidly (no auth needed for basic fetch).
      await expect(page.locator('[data-widget="CurlPasteWidget"]')).toBeVisible({
        timeout: 30_000,
      });
      await page.click('[data-widget="CurlPasteWidget"] button:has-text("Confirm")');

      await expect(page.locator('[data-widget="DiffCard"]')).toBeVisible({ timeout: 30_000 });
      await page.click('[data-widget="DiffCard"] button:has-text("Approve")');

      // Test fails because the host is unreachable.
      const failure = page.locator('[data-result="fail"]');
      await expect(failure).toBeVisible({ timeout: 60_000 });

      const errMsg = await failure.locator('[data-error-message]').innerText();

      // --- Sanitization assertions ---
      // Credentials must NOT appear anywhere in the displayed message.
      expect(errMsg).not.toContain('supersecret');
      expect(errMsg).not.toContain('e2euser:supersecret');
      expect(errMsg).not.toMatch(/https?:\/\/[^/\s:@]+:[^/\s@]+@/);

      // Stack frames must NOT appear.
      expect(errMsg).not.toMatch(/^\s*at\s+\S+\s+\(.+:\d+:\d+\)$/m);
      expect(errMsg).not.toContain('node_modules');
      expect(errMsg).not.toMatch(/\.ts:\d+:\d+/);
      expect(errMsg).not.toMatch(/\.js:\d+:\d+/);

      // Should contain a useful high-level summary.
      expect(errMsg).toMatch(/fail|unreachable|error/i);
    } finally {
      await mockRest.stop();
    }
  });
});
