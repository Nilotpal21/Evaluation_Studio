/**
 * E2E-6 — Workflow Version Deployment
 *
 * E2E-6: Deploy workflow version via creation + activation lifecycle,
 *        verifying the version snapshot and state transitions.
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
  uniqueSlug,
  type BootstrapProjectResult,
} from './helpers/channel-e2e-bootstrap.js';

const TIMEOUT = 120_000;

describe('Workflow Versioning: Deployment E2E', () => {
  let harness: RuntimeApiHarness;
  let admin: BootstrapProjectResult;

  beforeAll(async () => {
    harness = await startRuntimeServerHarness();
    admin = await bootstrapProject(
      harness,
      'wf-deploy-e2e@example.com',
      uniqueSlug('wf-deploy-tenant'),
      uniqueSlug('wf-deploy-proj'),
    );
  }, TIMEOUT);

  afterAll(async () => {
    await harness.close();
  }, TIMEOUT);

  // ---------------------------------------------------------------------------
  // Helper: Create a workflow via the API
  // ---------------------------------------------------------------------------
  async function createWorkflow(name: string) {
    const res = await requestJson<{ success: boolean; data: { id: string } }>(
      harness,
      `/api/projects/${admin.projectId}/workflows`,
      {
        method: 'POST',
        headers: authHeaders(admin.token),
        body: {
          name,
          type: 'cx_automation',
          nodes: [
            {
              id: 'start-1',
              nodeType: 'start',
              name: 'Start',
              position: { x: 0, y: 0 },
            },
            {
              id: 'end-1',
              nodeType: 'end',
              name: 'End',
              position: { x: 200, y: 0 },
            },
          ],
          edges: [
            {
              id: 'edge-1',
              source: 'start-1',
              target: 'end-1',
            },
          ],
          envVars: { DEPLOY_ENV: 'staging' },
          inputSchema: { type: 'object', properties: { query: { type: 'string' } } },
          outputSchema: { type: 'object', properties: { result: { type: 'string' } } },
        },
      },
    );
    expect(res.status).toBe(201);
    return res.body.data;
  }

  // ---------------------------------------------------------------------------
  // E2E-6: Full deployment lifecycle — snapshot, activate, verify frozen state
  // ---------------------------------------------------------------------------
  test('E2E-6: deploy workflow version snapshots draft and activates', async () => {
    const workflow = await createWorkflow(`deploy-${uniqueSlug('wf')}`);
    const wfId = workflow.id;
    const basePath = `/api/projects/${admin.projectId}/workflows/${wfId}/versions`;

    // Wait for draft creation
    await new Promise((r) => setTimeout(r, 500));

    // Verify draft exists with the definition from workflow creation
    const draftRes = await requestJson<{
      success: boolean;
      version: {
        version: string;
        definition: {
          nodes: Array<{ id: string }>;
          edges: Array<{ id: string }>;
          envVars: Record<string, string>;
          inputSchema: Record<string, unknown> | null;
          outputSchema: Record<string, unknown> | null;
        };
      };
    }>(harness, `${basePath}/draft`, {
      headers: authHeaders(admin.token),
    });
    expect(draftRes.status).toBe(200);
    expect(draftRes.body.version.version).toBe('draft');

    // Step 1: Create a published version (snapshots draft)
    const createRes = await requestJson<{
      success: boolean;
      versionId: string;
      version: string;
      sourceHash: string;
    }>(harness, basePath, {
      method: 'POST',
      headers: authHeaders(admin.token),
      body: { changelog: 'Initial deployment' },
    });
    expect([200, 201]).toContain(createRes.status);
    expect(createRes.body.success).toBe(true);
    const publishedVersion = createRes.body.version;
    expect(publishedVersion).toMatch(/^v\d+\.\d+\.\d+$/);

    // Step 2: Verify the published version has the snapshotted definition
    const versionRes = await requestJson<{
      success: boolean;
      version: {
        version: string;
        state: string;
        sourceHash: string;
        definition: {
          nodes: Array<{ id: string; nodeType: string }>;
          edges: Array<{ id: string }>;
          envVars: Record<string, string>;
        };
      };
    }>(harness, `${basePath}/${publishedVersion}`, {
      headers: authHeaders(admin.token),
    });
    expect(versionRes.status).toBe(200);
    expect(versionRes.body.version.state).toBe('inactive');
    expect(versionRes.body.version.definition.nodes).toHaveLength(2);
    expect(versionRes.body.version.definition.edges).toHaveLength(1);

    // Step 3: Activate the version
    const activateRes = await requestJson<{
      success: boolean;
      version: { state: string };
    }>(harness, `${basePath}/${publishedVersion}/activate`, {
      method: 'POST',
      headers: authHeaders(admin.token),
      body: {},
    });
    expect(activateRes.status).toBe(200);
    expect(activateRes.body.success).toBe(true);

    // Step 4: Verify the version is now active
    const activeRes = await requestJson<{
      success: boolean;
      version: { version: string; state: string };
    }>(harness, `${basePath}/${publishedVersion}`, {
      headers: authHeaders(admin.token),
    });
    expect(activeRes.status).toBe(200);
    expect(activeRes.body.version.state).toBe('active');

    // Step 5: Verify definition fields are frozen — PATCH nodes should fail
    const frozenPatchRes = await requestJson<{
      success: boolean;
      error?: { code: string };
    }>(harness, `${basePath}/${publishedVersion}`, {
      method: 'PATCH',
      headers: authHeaders(admin.token),
      body: {
        definition: {
          nodes: [
            {
              id: 'injected',
              nodeType: 'hack',
              name: 'Injected',
              position: { x: 0, y: 0 },
            },
          ],
        },
      },
    });
    expect(frozenPatchRes.status).toBe(400);
    expect(frozenPatchRes.body.error?.code).toBe('FIELD_FROZEN');

    // Step 6: Modify the draft (original is unaffected)
    const draftPatchRes = await requestJson<{
      success: boolean;
      version: Record<string, unknown>;
    }>(harness, `${basePath}/draft`, {
      method: 'PATCH',
      headers: authHeaders(admin.token),
      body: {
        definition: {
          nodes: [
            {
              id: 'new-start',
              nodeType: 'start',
              name: 'New Start',
              position: { x: 50, y: 50 },
            },
          ],
          edges: [],
        },
      },
    });
    expect(draftPatchRes.status).toBe(200);

    // Step 7: The published version still has original definition
    const unchangedRes = await requestJson<{
      success: boolean;
      version: {
        definition: { nodes: Array<{ id: string }> };
      };
    }>(harness, `${basePath}/${publishedVersion}`, {
      headers: authHeaders(admin.token),
    });
    expect(unchangedRes.status).toBe(200);
    expect(unchangedRes.body.version.definition.nodes).toHaveLength(2);
    expect(unchangedRes.body.version.definition.nodes.map((n) => n.id).sort()).toEqual([
      'end-1',
      'start-1',
    ]);
  });

  // ---------------------------------------------------------------------------
  // E2E-6b: Version list pagination
  // ---------------------------------------------------------------------------
  test('E2E-6b: list versions respects pagination params', async () => {
    const workflow = await createWorkflow(`paginate-${uniqueSlug('wf')}`);
    const wfId = workflow.id;
    const basePath = `/api/projects/${admin.projectId}/workflows/${wfId}/versions`;

    // Wait for draft creation
    await new Promise((r) => setTimeout(r, 500));

    // Create multiple versions with different definitions
    for (let i = 0; i < 3; i++) {
      // Modify draft each time
      await requestJson(harness, `${basePath}/draft`, {
        method: 'PATCH',
        headers: authHeaders(admin.token),
        body: {
          definition: {
            nodes: [
              {
                id: `node-${i}`,
                nodeType: 'start',
                name: `Node ${i}`,
                position: { x: i * 100, y: 0 },
              },
            ],
          },
        },
      });
      await requestJson(harness, basePath, {
        method: 'POST',
        headers: authHeaders(admin.token),
        body: { changelog: `Version ${i + 1}` },
      });
    }

    // List with limit=2
    const page1 = await requestJson<{
      success: boolean;
      versions: Array<{ version: string }>;
      total: number;
      hasMore: boolean;
      limit: number;
      offset: number;
    }>(harness, `${basePath}?limit=2&offset=0`, {
      headers: authHeaders(admin.token),
    });
    expect(page1.status).toBe(200);
    expect(page1.body.versions.length).toBeLessThanOrEqual(2);
    expect(page1.body.limit).toBe(2);
    expect(page1.body.offset).toBe(0);
    // total includes draft + 3 published = 4
    expect(page1.body.total).toBeGreaterThanOrEqual(4);
    expect(page1.body.hasMore).toBe(true);

    // Page 2
    const page2 = await requestJson<{
      success: boolean;
      versions: Array<{ version: string }>;
      hasMore: boolean;
      offset: number;
    }>(harness, `${basePath}?limit=2&offset=2`, {
      headers: authHeaders(admin.token),
    });
    expect(page2.status).toBe(200);
    expect(page2.body.versions.length).toBeGreaterThanOrEqual(1);
    expect(page2.body.offset).toBe(2);
  });
});
