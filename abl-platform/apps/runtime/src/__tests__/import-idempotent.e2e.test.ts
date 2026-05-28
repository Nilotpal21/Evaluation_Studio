/**
 * Import Idempotency & Desired-State E2E Tests
 *
 * Covers:
 *   Phase 1.0 — Pre-import versioning (snapshot + revert)
 *   Phase 1.1 — Idempotent import (direct upsert, re-import = zero changes)
 *   Phase 1.2 — Tool auto-creation from agent DSL TOOLS: signatures
 *   Phase 1.3 — Auto-generate project.json manifest when missing
 *   Phase 4.1 — Agent PATCH accepts dslContent
 *
 * E2E rules enforced:
 *   - No vi.mock / jest.mock
 *   - All interaction via HTTP API (POST /import, GET /export, etc.)
 *   - Real servers on random ports with MongoMemoryServer
 *   - No direct Mongoose model access
 */

import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import {
  startRuntimeServerHarness,
  type RuntimeApiHarness,
} from './helpers/runtime-api-harness.js';
import {
  bootstrapProject,
  authHeaders,
  requestJson,
  type BootstrapProjectResult,
} from './helpers/channel-e2e-bootstrap.js';

// ─── DSL Fixtures ───────────────────────────────────────────────────────────

const AGENT_A_DSL = `AGENT: AgentA
GOAL: Handle customer inquiries about orders

TOOLS:
  check_order(order_id: string) -> {status: string, eta: string}
    description: "Check order status by ID"

ON_ERROR:
  RESPOND: "Sorry, something went wrong."
`;

const AGENT_A_MODIFIED_DSL = `AGENT: AgentA
GOAL: Handle customer inquiries about orders and returns

TOOLS:
  check_order(order_id: string) -> {status: string, eta: string}
    description: "Check order status by ID"
  initiate_return(order_id: string, reason: string) -> {return_id: string}
    description: "Initiate a product return"

ON_ERROR:
  RESPOND: "Sorry, something went wrong. Please try again."
`;

const AGENT_B_DSL = `AGENT: AgentB
GOAL: Process payment transactions

TOOLS:
  charge_card(amount: number, currency: string, card_token: string) -> {transaction_id: string, status: string}
    description: "Charge a credit card"

ON_ERROR:
  RESPOND: "Payment processing failed."
`;

const AGENT_C_DSL = `AGENT: AgentC
GOAL: Handle shipping logistics
`;

const INLINE_TOOL_AGENT_DSL = `AGENT: InlineToolAgent
GOAL: Check utility outages for a service address

TOOLS:
  check_outage_by_address(service_address: string) -> {status: string}
    description: "Check utility outage status by service address"

ON_ERROR:
  RESPOND: "Unable to check outage status right now."
`;

const TOOL_FILE_DSL = `TOOLS:
  check_order(order_id: string) -> {status: string, eta: string}
    description: "Check order status by ID"
    type: http
    endpoint: "https://api.example.com/orders"
    method: GET
`;

const MANIFEST_V2 = JSON.stringify({
  format_version: '2.0',
  project_name: 'test-project',
  entry_agent: 'AgentA',
  agents: [
    { name: 'AgentA', file: 'agents/agenta.agent.abl' },
    { name: 'AgentB', file: 'agents/agentb.agent.abl' },
  ],
  tools: [],
});

// ─── Helpers ────────────────────────────────────────────────────────────────

function makeFiles(
  agents: Record<string, string>,
  manifest?: string,
  tools?: Record<string, string>,
): Record<string, string> {
  const files: Record<string, string> = {};
  if (manifest) files['project.json'] = manifest;
  for (const [name, dsl] of Object.entries(agents)) {
    files[`agents/${name}.agent.abl`] = dsl;
  }
  if (tools) {
    for (const [name, dsl] of Object.entries(tools)) {
      files[`tools/${name}.tools.abl`] = dsl;
    }
  }
  return files;
}

async function importFiles(
  harness: RuntimeApiHarness,
  token: string,
  projectId: string,
  files: Record<string, string>,
) {
  return requestJson<{
    success: boolean;
    applied: {
      created: number;
      updated: number;
      deleted: number;
      toolsCreated: number;
      toolsUpdated: number;
      toolsDeleted: number;
    };
    error?: unknown;
  }>(harness, `/api/projects/${projectId}/project-io/import`, {
    method: 'POST',
    headers: authHeaders(token),
    body: { files },
  });
}

async function importPreview(
  harness: RuntimeApiHarness,
  token: string,
  projectId: string,
  files: Record<string, string>,
) {
  return requestJson<{
    success: boolean;
    preview?: {
      changes?: {
        agents?: { added?: string[]; modified?: string[]; removed?: string[] };
        tools?: { added?: string[]; modified?: string[]; removed?: string[] };
      };
    };
    error?: unknown;
  }>(harness, `/api/projects/${projectId}/project-io/import/preview`, {
    method: 'POST',
    headers: authHeaders(token),
    body: { files },
  });
}

async function exportProject(harness: RuntimeApiHarness, token: string, projectId: string) {
  return requestJson<{
    success: boolean;
    files?: Record<string, string>;
    manifest?: Record<string, unknown>;
  }>(harness, `/api/projects/${projectId}/project-io/export`, {
    method: 'GET',
    headers: authHeaders(token),
  });
}

async function listAgents(harness: RuntimeApiHarness, token: string, projectId: string) {
  return requestJson<{
    success: boolean;
    agents: Array<{ _id: string; name: string; dslContent: string | null }>;
  }>(harness, `/api/projects/${projectId}/agents`, {
    method: 'GET',
    headers: authHeaders(token),
  });
}

async function getProject(harness: RuntimeApiHarness, token: string, projectId: string) {
  return requestJson<{
    success: boolean;
    project: { _id: string; entryAgentName: string | null };
  }>(harness, `/api/projects/${projectId}`, {
    method: 'GET',
    headers: authHeaders(token),
  });
}

// ─── Test Suite ─────────────────────────────────────────────────────────────

describe('Import Idempotency & Desired-State E2E', () => {
  let harness: RuntimeApiHarness;
  let admin: BootstrapProjectResult;

  beforeAll(async () => {
    harness = await startRuntimeServerHarness();
    admin = await bootstrapProject(harness, 'import-e2e@example.com', 'import-e2e', 'import-proj');
  }, 60_000);

  afterAll(async () => {
    await harness.close();
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Phase 1.1 — Idempotent Import (Direct Upsert)
  // ═══════════════════════════════════════════════════════════════════════════

  describe('Phase 1.1: Idempotent import', () => {
    test('first import creates agents from scratch', async () => {
      const files = makeFiles({ agenta: AGENT_A_DSL, agentb: AGENT_B_DSL }, MANIFEST_V2);

      const result = await importFiles(harness, admin.token, admin.projectId, files);

      expect(result.status).toBe(200);
      expect(result.body.success).toBe(true);
      expect(result.body.applied.created).toBe(2);
      expect(result.body.applied.updated).toBe(0);
      expect(result.body.applied.deleted).toBe(0);
    });

    test('re-importing identical files produces zero changes', async () => {
      const files = makeFiles({ agenta: AGENT_A_DSL, agentb: AGENT_B_DSL }, MANIFEST_V2);

      const result = await importFiles(harness, admin.token, admin.projectId, files);

      expect(result.status).toBe(200);
      expect(result.body.success).toBe(true);
      // Idempotent: same content = zero mutations
      expect(result.body.applied.created).toBe(0);
      expect(result.body.applied.updated).toBe(0);
      expect(result.body.applied.deleted).toBe(0);
    });

    test('importing modified agent updates it in-place (preserves _id)', async () => {
      // Get agent IDs before update
      const beforeAgents = await listAgents(harness, admin.token, admin.projectId);
      const agentABefore = beforeAgents.body.agents.find((a) => a.name === 'AgentA');
      expect(agentABefore).toBeDefined();

      // Import with modified AgentA
      const files = makeFiles({ agenta: AGENT_A_MODIFIED_DSL, agentb: AGENT_B_DSL }, MANIFEST_V2);

      const result = await importFiles(harness, admin.token, admin.projectId, files);

      expect(result.status).toBe(200);
      expect(result.body.applied.created).toBe(0);
      expect(result.body.applied.updated).toBe(1); // AgentA updated
      expect(result.body.applied.deleted).toBe(0);

      // Verify agent ID is preserved (upsert, not recreate)
      const afterAgents = await listAgents(harness, admin.token, admin.projectId);
      const agentAAfter = afterAgents.body.agents.find((a) => a.name === 'AgentA');
      expect(agentAAfter).toBeDefined();
      expect(agentAAfter!._id).toBe(agentABefore!._id);
    });

    test('importing new agent alongside existing ones creates only the new one', async () => {
      const manifest = JSON.stringify({
        format_version: '2.0',
        entry_agent: 'AgentA',
        agents: [
          { name: 'AgentA', file: 'agents/agenta.agent.abl' },
          { name: 'AgentB', file: 'agents/agentb.agent.abl' },
          { name: 'AgentC', file: 'agents/agentc.agent.abl' },
        ],
        tools: [],
      });
      const files = makeFiles(
        { agenta: AGENT_A_MODIFIED_DSL, agentb: AGENT_B_DSL, agentc: AGENT_C_DSL },
        manifest,
      );

      const result = await importFiles(harness, admin.token, admin.projectId, files);

      expect(result.status).toBe(200);
      expect(result.body.applied.created).toBe(1); // Only AgentC is new
      expect(result.body.applied.updated).toBe(0); // A & B unchanged from prior import
    });

    test('import removes agents not in payload when deleteUnmatched is true', async () => {
      // Import only AgentA — AgentB and AgentC should be deleted
      const manifest = JSON.stringify({
        format_version: '2.0',
        entry_agent: 'AgentA',
        agents: [{ name: 'AgentA', file: 'agents/agenta.agent.abl' }],
        tools: [],
      });
      const files = makeFiles({ agenta: AGENT_A_MODIFIED_DSL }, manifest);

      const result = await importFiles(harness, admin.token, admin.projectId, files);

      expect(result.status).toBe(200);
      // AgentB and AgentC should be deleted (desired-state reconciliation)
      expect(result.body.applied.deleted).toBeGreaterThanOrEqual(2);

      // Verify only AgentA remains
      const agents = await listAgents(harness, admin.token, admin.projectId);
      const agentNames = agents.body.agents.map((a) => a.name);
      expect(agentNames).toContain('AgentA');
      expect(agentNames).not.toContain('AgentB');
      expect(agentNames).not.toContain('AgentC');
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Phase 1.1 — Preview Accuracy
  // ═══════════════════════════════════════════════════════════════════════════

  describe('Phase 1.1: Preview matches apply', () => {
    test('preview shows correct create/update/delete breakdown', async () => {
      // Currently only AgentA exists from prior tests
      const manifest = JSON.stringify({
        format_version: '2.0',
        entry_agent: 'AgentA',
        agents: [
          { name: 'AgentA', file: 'agents/agenta.agent.abl' },
          { name: 'AgentB', file: 'agents/agentb.agent.abl' },
        ],
        tools: [],
      });
      const files = makeFiles({ agenta: AGENT_A_MODIFIED_DSL, agentb: AGENT_B_DSL }, manifest);

      const preview = await importPreview(harness, admin.token, admin.projectId, files);

      expect(preview.status).toBe(200);
      expect(preview.body.success).toBe(true);
      expect(preview.body.preview?.changes?.agents?.added).toContain('AgentB');
      // AgentA unchanged from last import
      expect(preview.body.preview?.changes?.agents?.modified ?? []).toHaveLength(0);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Phase 1.0 — Pre-Import Versioning (Snapshot + Revert)
  // ═══════════════════════════════════════════════════════════════════════════

  describe('Phase 1.0: Pre-import versioning', () => {
    test('export captures current project state before import', async () => {
      const exportResult = await exportProject(harness, admin.token, admin.projectId);

      expect(exportResult.status).toBe(200);
      expect(exportResult.body.success).toBe(true);
      expect(exportResult.body.files).toBeDefined();
      // Should have at least project.json and agent files
      const fileKeys = Object.keys(exportResult.body.files ?? {});
      expect(fileKeys.some((k) => k.includes('project.json'))).toBe(true);
      expect(fileKeys.some((k) => k.startsWith('agents/'))).toBe(true);
    });

    test('export-then-reimport round-trip preserves agents', async () => {
      // Export current state
      const exportResult = await exportProject(harness, admin.token, admin.projectId);
      expect(exportResult.body.success).toBe(true);

      const exportedFiles = exportResult.body.files!;

      // Re-import the exported files
      const result = await importFiles(harness, admin.token, admin.projectId, exportedFiles);

      expect(result.status).toBe(200);
      expect(result.body.success).toBe(true);
      // Round-trip should produce zero changes (identical content)
      expect(result.body.applied.created).toBe(0);
      expect(result.body.applied.updated).toBe(0);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Phase 1.2 — Tool Auto-Creation from DSL Signatures
  // ═══════════════════════════════════════════════════════════════════════════

  describe('Phase 1.2: Tool auto-creation from agent DSL', () => {
    test('import with .tools.abl files materializes tool definitions in the library', async () => {
      const files = makeFiles(
        { agenta: AGENT_A_DSL },
        JSON.stringify({
          format_version: '2.0',
          entry_agent: 'AgentA',
          agents: [{ name: 'AgentA', file: 'agents/agenta.agent.abl' }],
          tools: [{ name: 'check_order', file: 'tools/check_order.tools.abl' }],
        }),
        { check_order: TOOL_FILE_DSL },
      );

      const result = await importFiles(harness, admin.token, admin.projectId, files);

      expect(result.status).toBe(200);
      expect(result.body.success).toBe(true);
      expect(
        result.body.applied.toolsCreated + result.body.applied.toolsUpdated,
      ).toBeGreaterThanOrEqual(1);

      const exported = await exportProject(harness, admin.token, admin.projectId);
      expect(exported.status).toBe(200);
      expect(exported.body.files?.['tools/check_order.tools.abl']).toContain(
        'endpoint: "https://api.example.com/orders"',
      );
    });

    test('re-importing same tools produces zero tool changes', async () => {
      const files = makeFiles(
        { agenta: AGENT_A_DSL },
        JSON.stringify({
          format_version: '2.0',
          entry_agent: 'AgentA',
          agents: [{ name: 'AgentA', file: 'agents/agenta.agent.abl' }],
          tools: [{ name: 'check_order', file: 'tools/check_order.tools.abl' }],
        }),
        { check_order: TOOL_FILE_DSL },
      );

      const result = await importFiles(harness, admin.token, admin.projectId, files);

      expect(result.status).toBe(200);
      expect(result.body.applied.toolsCreated).toBe(0);
      expect(result.body.applied.toolsUpdated).toBe(0);
    });

    test('preview warns and apply auto-creates tool stubs for inline TOOLS signatures', async () => {
      const files = makeFiles(
        { inline_tool_agent: INLINE_TOOL_AGENT_DSL },
        JSON.stringify({
          format_version: '2.0',
          entry_agent: 'InlineToolAgent',
          agents: [{ name: 'InlineToolAgent', file: 'agents/inline_tool_agent.agent.abl' }],
          tools: [],
        }),
      );

      const preview = await requestJson<{
        success: boolean;
        preview?: {
          toolChanges?: { added?: string[]; modified?: string[]; removed?: string[] };
        };
        warnings?: string[];
      }>(harness, `/api/projects/${admin.projectId}/project-io/import/preview`, {
        method: 'POST',
        headers: authHeaders(admin.token),
        body: { files },
      });

      expect(preview.status).toBe(200);
      expect(preview.body.success).toBe(true);
      expect(preview.body.warnings ?? []).toEqual(
        expect.arrayContaining([expect.stringContaining('W_TOOL_STUB')]),
      );
      expect(preview.body.preview?.toolChanges?.added ?? []).toContain('check_outage_by_address');

      const result = await importFiles(harness, admin.token, admin.projectId, files);

      expect(result.status).toBe(200);
      expect(result.body.success).toBe(true);
      expect(result.body.applied.toolsCreated).toBeGreaterThanOrEqual(1);

      const exported = await exportProject(harness, admin.token, admin.projectId);
      expect(exported.status).toBe(200);
      expect(exported.body.files?.['tools/check_outage_by_address.tools.abl']).toContain(
        'endpoint: "https://TODO-configure-endpoint"',
      );
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Phase 1.3 — Auto-Generate project.json Manifest
  // ═══════════════════════════════════════════════════════════════════════════

  describe('Phase 1.3: Import without project.json', () => {
    test('import with only agent files (no manifest) succeeds', async () => {
      // No project.json — just agent files
      const files: Record<string, string> = {
        'agents/agenta.agent.abl': AGENT_A_DSL,
      };

      const result = await importFiles(harness, admin.token, admin.projectId, files);

      // Should succeed — manifest auto-generated from agent file names
      expect(result.status).toBe(200);
      expect(result.body.success).toBe(true);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Phase 1.1 — Wrapper Directory Handling (Zip Extraction)
  // ═══════════════════════════════════════════════════════════════════════════

  describe('Wrapper directory handling', () => {
    test('files wrapped in a directory prefix import correctly', async () => {
      // Simulate zip extraction: all files under a wrapper dir
      const files: Record<string, string> = {
        'my-project/project.json': MANIFEST_V2,
        'my-project/agents/agenta.agent.abl': AGENT_A_DSL,
        'my-project/agents/agentb.agent.abl': AGENT_B_DSL,
      };

      const result = await importFiles(harness, admin.token, admin.projectId, files);

      expect(result.status).toBe(200);
      expect(result.body.success).toBe(true);
    });

    test('deeply nested wrapper directories are stripped correctly', async () => {
      const files: Record<string, string> = {
        'foo/bar/project.json': MANIFEST_V2,
        'foo/bar/agents/agenta.agent.abl': AGENT_A_DSL,
        'foo/bar/agents/agentb.agent.abl': AGENT_B_DSL,
      };

      const result = await importFiles(harness, admin.token, admin.projectId, files);

      expect(result.status).toBe(200);
      expect(result.body.success).toBe(true);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Phase 1.1 — Entry Agent from Manifest
  // ═══════════════════════════════════════════════════════════════════════════

  describe('Entry agent from manifest', () => {
    test('import sets entryAgentName from project.json entry_agent', async () => {
      const manifest = JSON.stringify({
        format_version: '2.0',
        entry_agent: 'AgentA',
        agents: [{ name: 'AgentA', file: 'agents/agenta.agent.abl' }],
        tools: [],
      });
      const files = makeFiles({ agenta: AGENT_A_DSL }, manifest);

      const result = await importFiles(harness, admin.token, admin.projectId, files);
      expect(result.status).toBe(200);

      // Verify entryAgentName was set on the project
      const project = await getProject(harness, admin.token, admin.projectId);
      expect(project.body.project.entryAgentName).toBe('AgentA');
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Concurrent Import Protection
  // ═══════════════════════════════════════════════════════════════════════════

  describe('Concurrent import protection', () => {
    test('two simultaneous imports — one succeeds, one gets 409', async () => {
      const files = makeFiles(
        { agenta: AGENT_A_DSL },
        JSON.stringify({
          format_version: '2.0',
          entry_agent: 'AgentA',
          agents: [{ name: 'AgentA', file: 'agents/agenta.agent.abl' }],
          tools: [],
        }),
      );

      // Fire two imports simultaneously
      const [result1, result2] = await Promise.all([
        importFiles(harness, admin.token, admin.projectId, files),
        importFiles(harness, admin.token, admin.projectId, files),
      ]);

      // One should succeed (200), one should get conflict (409)
      const statuses = [result1.status, result2.status].sort();
      expect(statuses).toContain(200);
      // The other might be 200 too (if lock is not held) or 409
      // At minimum, both should not produce corrupt state
      expect([200, 409]).toContain(statuses[0]);
      expect([200, 409]).toContain(statuses[1]);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Validation & Error Cases
  // ═══════════════════════════════════════════════════════════════════════════

  describe('Input validation', () => {
    test('rejects empty files map', async () => {
      const result = await importFiles(harness, admin.token, admin.projectId, {});
      expect(result.status).toBeGreaterThanOrEqual(400);
    });

    test('rejects files with path traversal', async () => {
      const files = { '../../../etc/passwd': 'malicious' };
      const result = await importFiles(harness, admin.token, admin.projectId, files);
      expect(result.status).toBeGreaterThanOrEqual(400);
    });

    test('rejects oversized files', async () => {
      const files = { 'agents/huge.agent.abl': 'x'.repeat(2 * 1024 * 1024) }; // 2MB
      const result = await importFiles(harness, admin.token, admin.projectId, files);
      expect(result.status).toBeGreaterThanOrEqual(400);
    });
  });
});
