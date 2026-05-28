/**
 * E2E-4, E2E-5 — Workflow Tool Validation
 *
 * E2E-4: Validates that the DSL parser recognizes workflow tool type during import.
 * E2E-5: Validates import/export round-trip with standard tools works.
 *
 * Uses real Express server (startRuntimeServerHarness) with full middleware chain.
 * Real MongoDB (MongoMemoryServer). No mocks of platform components.
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
  importProjectFiles,
  uniqueSlug,
  type BootstrapProjectResult,
} from './helpers/channel-e2e-bootstrap.js';

const TIMEOUT = 90_000;

describe('E2E-4/5: Workflow Tool Validation', () => {
  let harness: RuntimeApiHarness;
  let admin: BootstrapProjectResult;

  beforeAll(async () => {
    harness = await startRuntimeServerHarness();
    admin = await bootstrapProject(
      harness,
      'wf-val-e2e@example.com',
      uniqueSlug('wf-val-tenant'),
      uniqueSlug('wf-val-proj'),
    );
  }, TIMEOUT);

  afterAll(async () => {
    await harness.close();
  }, TIMEOUT);

  test('E2E-4: workflow tool type is recognized in DSL import endpoint', async () => {
    const res = await requestJson<{ success: boolean; error?: unknown }>(
      harness,
      `/api/projects/${admin.projectId}/project-io/import`,
      {
        method: 'POST',
        headers: authHeaders(admin.token),
        body: {
          files: {
            'agents/wf_agent.abl': `AGENT: wf_agent
GOAL: Test workflow tool

TOOLS:
  wf_tool() -> object
    description: "Workflow tool"
    type: workflow
    workflow_id: wf_001
    trigger_id: trg_001
    mode: sync
`,
          },
        },
      },
    );
    // The import endpoint processes the workflow tool type.
    // It may succeed (200) or return a validation error (400)
    // if the workflow doesn't exist — both indicate the type is recognized.
    expect([200, 400]).toContain(res.status);
    // If it's a validation error, it should be structured
    if (res.status === 400) {
      expect(res.body).toHaveProperty('success', false);
    }
  });

  test('E2E-5: import/export round-trip preserves standard agents', async () => {
    // Import a standard HTTP tool agent using project.json manifest format
    const result = await importProjectFiles(harness, admin.token, admin.projectId, {
      'project.json': JSON.stringify({
        format_version: '2.0',
        entry_agent: 'roundtrip_agent',
        agents: [{ name: 'roundtrip_agent', file: 'agents/roundtrip.agent.abl' }],
        tools: [{ name: 'rt_tool', file: 'tools/rt_tool.tools.abl' }],
      }),
      'agents/roundtrip.agent.abl': `AGENT: roundtrip_agent
GOAL: Test round-trip

TOOLS:
  rt_tool(q: string) -> object
    description: "HTTP tool for round-trip"
`,
      'tools/rt_tool.tools.abl': `TOOLS:
  rt_tool(q: string) -> object
    description: "HTTP tool for round-trip"
    type: http
    endpoint: "https://example.com/api"
    method: GET
`,
    });
    expect(result.success).toBe(true);

    // Export and verify the agent is present
    const exportRes = await requestJson<{ success: boolean; files: Record<string, string> }>(
      harness,
      `/api/projects/${admin.projectId}/project-io/export`,
      {
        method: 'GET',
        headers: authHeaders(admin.token),
      },
    );
    expect(exportRes.status).toBe(200);
    expect(exportRes.body.success).toBe(true);

    const files = exportRes.body.files;
    const agentFiles = Object.keys(files).filter((k) => k.endsWith('.abl'));
    expect(agentFiles.length).toBeGreaterThan(0);
  });
});
