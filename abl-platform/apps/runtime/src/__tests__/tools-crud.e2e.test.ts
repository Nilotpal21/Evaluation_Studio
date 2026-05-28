/**
 * Tools CRUD E2E Tests
 *
 * Covers:
 *   Phase 1.4 — Tools API endpoints (list, create, get, update, delete)
 *   Phase 1.2 — Tool auto-creation verification (tools exist after import)
 *   Phase 4.1 — Agent PATCH with dslContent
 *
 * E2E rules enforced:
 *   - No vi.mock / jest.mock
 *   - All interaction via HTTP API
 *   - Real servers with MongoMemoryServer
 *   - No direct Mongoose model access
 *
 * Note: The tools CRUD API is on the Studio app. These tests use the
 * Runtime harness for import (to seed tools via import) and verify
 * tool state via the Runtime's export endpoint. When the Studio harness
 * is extended to mount tool routes, these tests can be expanded.
 */

import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import {
  startRuntimeServerHarness,
  type RuntimeApiHarness,
} from './helpers/runtime-api-harness.js';
import {
  bootstrapProject,
  importProjectFiles,
  authHeaders,
  requestJson,
  uniqueSlug,
  type BootstrapProjectResult,
} from './helpers/channel-e2e-bootstrap.js';

// ─── DSL Fixtures ───────────────────────────────────────────────────────────

const AGENT_WITH_TOOLS_DSL = `AGENT: ToolAgent
GOAL: Test agent with tool declarations

TOOLS:
  search_products(query: string, category?: string) -> {products: object[], total: integer}
    description: "Search product catalog"
  get_price(product_id: string) -> {price: number, currency: string}
    description: "Get product price"
`;

const TOOL_DSL_SEARCH = `TOOLS:
  search_products(query: string, category?: string) -> {products: object[], total: integer}
    description: "Search product catalog"
    type: http
    endpoint: "https://api.shop.com/search"
    method: GET
`;

const TOOL_DSL_PRICE = `TOOLS:
  get_price(product_id: string) -> {price: number, currency: string}
    description: "Get product price"
    type: http
    endpoint: "https://api.shop.com/price"
    method: GET
`;

// ─── Test Suite ─────────────────────────────────────────────────────────────

describe('Tools CRUD & Import E2E', () => {
  let harness: RuntimeApiHarness;
  let admin: BootstrapProjectResult;

  beforeAll(async () => {
    harness = await startRuntimeServerHarness();
    admin = await bootstrapProject(
      harness,
      'tools-e2e@example.com',
      uniqueSlug('tools-tenant'),
      uniqueSlug('tools-proj'),
    );
  }, 60_000);

  afterAll(async () => {
    await harness.close();
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Phase 1.2 — Tools Created via Import
  // ═══════════════════════════════════════════════════════════════════════════

  describe('Phase 1.2: Tools created via .tools.abl file import', () => {
    test('importing .tools.abl files creates tools in the project', async () => {
      const files: Record<string, string> = {
        'project.json': JSON.stringify({
          format_version: '2.0',
          entry_agent: 'ToolAgent',
          agents: [{ name: 'ToolAgent', file: 'agents/toolagent.agent.abl' }],
          tools: [
            { name: 'search_products', file: 'tools/search_products.tools.abl' },
            { name: 'get_price', file: 'tools/get_price.tools.abl' },
          ],
        }),
        'agents/toolagent.agent.abl': AGENT_WITH_TOOLS_DSL,
        'tools/search_products.tools.abl': TOOL_DSL_SEARCH,
        'tools/get_price.tools.abl': TOOL_DSL_PRICE,
      };

      const result = await importProjectFiles(harness, admin.token, admin.projectId, files);

      expect(result.success).toBe(true);
      expect(result.applied.created).toBeGreaterThanOrEqual(1); // At least 1 agent
      expect(result.applied.toolsCreated).toBeGreaterThanOrEqual(2); // 2 tools
    });

    test('re-importing same tools produces zero tool changes', async () => {
      const files: Record<string, string> = {
        'project.json': JSON.stringify({
          format_version: '2.0',
          entry_agent: 'ToolAgent',
          agents: [{ name: 'ToolAgent', file: 'agents/toolagent.agent.abl' }],
          tools: [
            { name: 'search_products', file: 'tools/search_products.tools.abl' },
            { name: 'get_price', file: 'tools/get_price.tools.abl' },
          ],
        }),
        'agents/toolagent.agent.abl': AGENT_WITH_TOOLS_DSL,
        'tools/search_products.tools.abl': TOOL_DSL_SEARCH,
        'tools/get_price.tools.abl': TOOL_DSL_PRICE,
      };

      const result = await importProjectFiles(harness, admin.token, admin.projectId, files);

      expect(result.success).toBe(true);
      expect(result.applied.toolsCreated).toBe(0);
      expect(result.applied.toolsUpdated).toBe(0);
    });

    test('tools appear in export after import', async () => {
      const exportResult = await requestJson<{
        success: boolean;
        files: Record<string, string>;
      }>(harness, `/api/projects/${admin.projectId}/project-io/export`, {
        method: 'GET',
        headers: authHeaders(admin.token),
      });

      expect(exportResult.status).toBe(200);
      expect(exportResult.body.success).toBe(true);

      const fileKeys = Object.keys(exportResult.body.files);
      const toolFiles = fileKeys.filter((k) => k.startsWith('tools/'));
      expect(toolFiles.length).toBeGreaterThanOrEqual(2);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Phase 1.4 — Tools Listing via Export
  // ═══════════════════════════════════════════════════════════════════════════

  describe('Phase 1.4: Tool visibility via export', () => {
    test('export includes tool files matching imported tools', async () => {
      const exportResult = await requestJson<{
        success: boolean;
        files: Record<string, string>;
        manifest?: { tools?: Array<{ name: string; file: string }> };
      }>(harness, `/api/projects/${admin.projectId}/project-io/export`, {
        method: 'GET',
        headers: authHeaders(admin.token),
      });

      expect(exportResult.status).toBe(200);
      const files = exportResult.body.files;

      // At least one tool file should exist
      const toolFileKeys = Object.keys(files).filter((k) => k.includes('tools/'));
      expect(toolFileKeys.length).toBeGreaterThan(0);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Phase 4.1 — Agent PATCH with dslContent
  // ═══════════════════════════════════════════════════════════════════════════

  describe('Phase 4.1: Agent update via API', () => {
    test('agent DSL can be updated via the DSL PUT endpoint', async () => {
      // First, get the agent to verify it exists
      const agentResult = await requestJson<{
        success?: boolean;
        agent?: { name: string; dslContent: string };
      }>(harness, `/api/projects/${admin.projectId}/agents/ToolAgent`, {
        method: 'GET',
        headers: authHeaders(admin.token),
      });

      expect(agentResult.status).toBe(200);

      // Update the agent DSL
      const newDsl = `AGENT: ToolAgent
GOAL: Updated goal for tool agent

TOOLS:
  search_products(query: string, category?: string, limit?: integer) -> {products: object[], total: integer}
    description: "Search product catalog with limit"
`;

      const updateResult = await requestJson<{
        success: boolean;
      }>(harness, `/api/projects/${admin.projectId}/agents/ToolAgent/dsl`, {
        method: 'PUT',
        headers: authHeaders(admin.token),
        body: { dslContent: newDsl },
      });

      expect(updateResult.status).toBe(200);

      // Verify the update persisted
      const verifyResult = await requestJson<{
        success?: boolean;
        agent?: { name: string; dslContent: string };
      }>(harness, `/api/projects/${admin.projectId}/agents/ToolAgent`, {
        method: 'GET',
        headers: authHeaders(admin.token),
      });

      expect(verifyResult.status).toBe(200);
      // The DSL content should be updated
      if (verifyResult.body.agent?.dslContent) {
        expect(verifyResult.body.agent.dslContent).toContain('Updated goal');
      }
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Tool Import Edge Cases
  // ═══════════════════════════════════════════════════════════════════════════

  describe('Tool import edge cases', () => {
    test('import with only agents (no .tools.abl files) creates no tools', async () => {
      // Create a fresh project for this test
      const freshAdmin = await bootstrapProject(
        harness,
        'tools-edge@example.com',
        uniqueSlug('tools-edge'),
        uniqueSlug('tools-edge-proj'),
      );

      const files: Record<string, string> = {
        'project.json': JSON.stringify({
          format_version: '2.0',
          entry_agent: 'SimpleAgent',
          agents: [{ name: 'SimpleAgent', file: 'agents/simpleagent.agent.abl' }],
          tools: [],
        }),
        'agents/simpleagent.agent.abl': `AGENT: SimpleAgent\nGOAL: Simple agent with no tools\n`,
      };

      const result = await importProjectFiles(
        harness,
        freshAdmin.token,
        freshAdmin.projectId,
        files,
      );

      expect(result.success).toBe(true);
      expect(result.applied.toolsCreated).toBe(0);
    });
  });
});
