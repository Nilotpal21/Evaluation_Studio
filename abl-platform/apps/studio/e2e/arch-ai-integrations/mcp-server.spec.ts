/**
 * S7: MCP server integration with cache invalidation verification.
 *
 * Real Playwright E2E. No platform mocks. Requires:
 *   - Studio + runtime + Mongo + Redis
 *   - Mock MCP server fixture (stdio or sse) exposing 2-3 sample tools
 *
 * Scenario:
 *   1. Configure an MCP server via Arch overlay
 *   2. Tools imported and shown for selection
 *   3. Approve wiring
 *   4. CRITICAL: open a NEW agent runtime session and verify the new MCP tools
 *      are available within seconds (NOT 5 minutes). This proves the
 *      cache-invalidation hook from Phase 0 works correctly.
 *
 * @e2e-real
 */

import { expect, test } from '@playwright/test';
import { loginViaDevApi } from '../helpers/auth';
import { env } from '../helpers/env';

const BASE_URL = env.baseUrl;
const MCP_INVALIDATION_BUDGET_MS = 10_000; // must be < 60s; cache TTL was 5min before fix

// TODO(ABLP-162): Pending fixtures:
//   - apps/studio/e2e/fixtures/mock-mcp-server.ts (start/stop, exposes echo/add tools)
//   - apps/studio/e2e/fixtures/integration-project.ts
//   - data-widget="McpServerForm" + ToolMultiSelect testids
test.skip(true, 'TODO(ABLP-162): pending mock MCP server fixture');

test.describe('Arch integrations — MCP server (S7)', () => {
  test('configures MCP server, imports tools, wires; new session sees tools within seconds', async ({
    page,
    request,
  }) => {
    const project = { id: 'TODO-project-id' };
    const mockMcp = {
      url: 'http://localhost:0/mcp', // TODO(ABLP-162)
      tools: ['mcp_echo', 'mcp_add'],
      start: async () => {
        /* fixture */
      },
      stop: async () => {
        /* fixture */
      },
    };

    await loginViaDevApi(page, {
      baseUrl: BASE_URL,
      email: `arch-int-mcp-${Date.now()}@e2e-smoke.test`,
      name: 'Arch Integrations E2E',
      landingPath: '/projects',
    });

    await mockMcp.start();
    try {
      await page.goto(`/projects/${project.id}`);
      await page.click('[data-testid="arch-toggle"]');

      await page.fill(
        '[data-testid="arch-input"]',
        `Set up MCP server at ${mockMcp.url} and import its tools`,
      );
      await page.click('[data-testid="arch-send"]');

      // McpServerForm widget
      await expect(page.locator('[data-widget="McpServerForm"]')).toBeVisible({ timeout: 30_000 });
      await page.fill('[data-widget="McpServerForm"] input[name="url"]', mockMcp.url);
      await page.click('[data-widget="McpServerForm"] button[type="submit"]');

      // Tools imported — multi-select
      await expect(page.locator('[data-widget="ToolMultiSelect"]')).toBeVisible({
        timeout: 30_000,
      });
      for (const t of mockMcp.tools) {
        await page.click(`[data-widget="ToolMultiSelect"] [data-tool="${t}"]`);
      }
      await page.click('[data-widget="ToolMultiSelect"] button:has-text("Add Selected")');

      // Approve wiring
      await expect(page.locator('[data-widget="DiffCard"]')).toBeVisible({ timeout: 30_000 });
      await page.click('[data-widget="DiffCard"] button:has-text("Approve")');

      // --- CACHE INVALIDATION CHECK ---
      // Spin up a NEW runtime session immediately. The new session should see
      // the MCP server tools without waiting for the old 5-minute cache TTL.
      const startedAt = Date.now();
      // TODO(ABLP-162): replace with real runtime session start helper
      const sessionResp = await request.post(`${env.runtimeUrl}/api/sessions`, {
        data: { projectId: project.id, agentName: 'ops_agent' },
      });
      expect(sessionResp.ok()).toBeTruthy();
      const session = await sessionResp.json();

      // Poll for the new tools to appear in the session's tool catalog.
      let foundAll = false;
      while (Date.now() - startedAt < MCP_INVALIDATION_BUDGET_MS) {
        const toolsResp = await request.get(`${env.runtimeUrl}/api/sessions/${session.id}/tools`);
        if (toolsResp.ok()) {
          const tools = (await toolsResp.json()) as Array<{ name: string }>;
          const names = new Set(tools.map((t) => t.name));
          if (mockMcp.tools.every((t) => names.has(t))) {
            foundAll = true;
            break;
          }
        }
        await page.waitForTimeout(500);
      }
      expect(
        foundAll,
        `MCP tools must be visible to new sessions within ${MCP_INVALIDATION_BUDGET_MS}ms (cache invalidation regression check)`,
      ).toBe(true);
    } finally {
      await mockMcp.stop();
    }
  });
});
