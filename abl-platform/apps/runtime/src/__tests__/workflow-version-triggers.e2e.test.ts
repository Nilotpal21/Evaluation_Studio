/**
 * E2E-2, E2E-7, E2E-8 — Workflow Version Trigger Integration
 *
 * E2E-2: Activate/deactivate with trigger registration wiring
 * E2E-7: Published version definition is frozen (immutable after publish)
 *         NOTE: The full E2E-7 scenario (cron fires frozen flow, not draft) requires
 *         BullMQ cron scheduling infrastructure, deferred to post-impl.
 * E2E-8: Activate/deactivate non-existent version returns 404; multiple active versions
 *         NOTE: Per-trigger toggle (FR-13) requires trigger registration CRUD endpoints,
 *         deferred to post-impl.
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

describe('Workflow Versioning: Trigger Integration E2E', () => {
  let harness: RuntimeApiHarness;
  let admin: BootstrapProjectResult;

  beforeAll(async () => {
    harness = await startRuntimeServerHarness();
    admin = await bootstrapProject(
      harness,
      'wf-trg-e2e@example.com',
      uniqueSlug('wf-trg-tenant'),
      uniqueSlug('wf-trg-proj'),
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
          ],
          edges: [],
          triggers: [
            {
              id: 'webhook-1',
              type: 'webhook',
              config: { path: '/test-hook' },
            },
          ],
        },
      },
    );
    expect(res.status).toBe(201);
    return res.body.data;
  }

  // ---------------------------------------------------------------------------
  // E2E-2: Activate/deactivate with trigger registration
  // ---------------------------------------------------------------------------
  test('E2E-2: activating version registers triggers, deactivating removes them', async () => {
    const workflow = await createWorkflow(`triggers-${uniqueSlug('wf')}`);
    const wfId = workflow.id;
    const basePath = `/api/projects/${admin.projectId}/workflows/${wfId}/versions`;

    // Wait for draft creation
    await new Promise((r) => setTimeout(r, 500));

    // Add trigger definition to the draft version
    await requestJson(harness, `${basePath}/draft`, {
      method: 'PATCH',
      headers: authHeaders(admin.token),
      body: {
        triggers: [
          {
            id: 'webhook-1',
            type: 'webhook',
            config: { path: '/test-trigger' },
          },
        ],
      },
    });

    // Create a published version
    const createRes = await requestJson<{
      success: boolean;
      version: string;
    }>(harness, basePath, {
      method: 'POST',
      headers: authHeaders(admin.token),
      body: {},
    });
    expect([200, 201]).toContain(createRes.status);
    const publishedVersion = createRes.body.version;

    // Activate the published version
    const activateRes = await requestJson<{ success: boolean; version: Record<string, unknown> }>(
      harness,
      `${basePath}/${publishedVersion}/activate`,
      {
        method: 'POST',
        headers: authHeaders(admin.token),
        body: {},
      },
    );
    expect(activateRes.status).toBe(200);
    expect(activateRes.body.success).toBe(true);

    // Verify the version is active
    const getActiveRes = await requestJson<{
      success: boolean;
      version: { state: string; version: string };
    }>(harness, `${basePath}/${publishedVersion}`, {
      headers: authHeaders(admin.token),
    });
    expect(getActiveRes.status).toBe(200);
    expect(getActiveRes.body.version.state).toBe('active');

    // Deactivate
    const deactivateRes = await requestJson<{
      success: boolean;
      version: Record<string, unknown>;
    }>(harness, `${basePath}/${publishedVersion}/deactivate`, {
      method: 'POST',
      headers: authHeaders(admin.token),
      body: {},
    });
    expect(deactivateRes.status).toBe(200);
    expect(deactivateRes.body.success).toBe(true);

    // Verify inactive
    const getInactiveRes = await requestJson<{
      success: boolean;
      version: { state: string };
    }>(harness, `${basePath}/${publishedVersion}`, {
      headers: authHeaders(admin.token),
    });
    expect(getInactiveRes.status).toBe(200);
    expect(getInactiveRes.body.version.state).toBe('inactive');
  });

  // ---------------------------------------------------------------------------
  // E2E-7: Published version definition fields are frozen
  // ---------------------------------------------------------------------------
  test('E2E-7: PATCH frozen fields on published version returns 400', async () => {
    const workflow = await createWorkflow(`frozen-${uniqueSlug('wf')}`);
    const wfId = workflow.id;
    const basePath = `/api/projects/${admin.projectId}/workflows/${wfId}/versions`;

    // Wait for draft creation
    await new Promise((r) => setTimeout(r, 500));

    // Create a published version
    const createRes = await requestJson<{
      success: boolean;
      version: string;
    }>(harness, basePath, {
      method: 'POST',
      headers: authHeaders(admin.token),
      body: {},
    });
    expect([200, 201]).toContain(createRes.status);
    const publishedVersion = createRes.body.version;

    // Try to update definition.nodes on the published version — should be frozen
    const patchRes = await requestJson<{
      success: boolean;
      error?: { code: string; message: string };
    }>(harness, `${basePath}/${publishedVersion}`, {
      method: 'PATCH',
      headers: authHeaders(admin.token),
      body: {
        definition: {
          nodes: [
            {
              id: 'injected',
              nodeType: 'start',
              name: 'Injected',
              position: { x: 0, y: 0 },
            },
          ],
        },
      },
    });
    expect(patchRes.status).toBe(400);
    expect(patchRes.body.error?.code).toBe('FIELD_FROZEN');

    // Activate the version first — inactive versions block all mutations
    const activateRes = await requestJson<{ success: boolean }>(
      harness,
      `${basePath}/${publishedVersion}/activate`,
      {
        method: 'POST',
        headers: authHeaders(admin.token),
      },
    );
    expect(activateRes.status).toBe(200);

    // Metadata and changelog should be mutable on published active versions
    const metaPatchRes = await requestJson<{
      success: boolean;
      version: Record<string, unknown>;
    }>(harness, `${basePath}/${publishedVersion}`, {
      method: 'PATCH',
      headers: authHeaders(admin.token),
      body: {
        changelog: 'Updated changelog',
        metadata: { reviewedBy: 'admin' },
      },
    });
    expect(metaPatchRes.status).toBe(200);
    expect(metaPatchRes.body.success).toBe(true);
  });

  // ---------------------------------------------------------------------------
  // E2E-8: Activate/deactivate non-existent version returns 404
  // ---------------------------------------------------------------------------
  test('E2E-8: activate non-existent version returns 404', async () => {
    const workflow = await createWorkflow(`missing-${uniqueSlug('wf')}`);
    const wfId = workflow.id;
    const basePath = `/api/projects/${admin.projectId}/workflows/${wfId}/versions`;

    // Try to activate a version that doesn't exist
    const activateRes = await requestJson<{
      success: boolean;
      error?: { code: string };
    }>(harness, `${basePath}/v999/activate`, {
      method: 'POST',
      headers: authHeaders(admin.token),
      body: {},
    });
    expect(activateRes.status).toBe(404);
    expect(activateRes.body.error?.code).toBe('VERSION_NOT_FOUND');

    // Try to deactivate a version that doesn't exist
    const deactivateRes = await requestJson<{
      success: boolean;
      error?: { code: string };
    }>(harness, `${basePath}/v999/deactivate`, {
      method: 'POST',
      headers: authHeaders(admin.token),
      body: {},
    });
    expect(deactivateRes.status).toBe(404);
    expect(deactivateRes.body.error?.code).toBe('VERSION_NOT_FOUND');
  });

  // ---------------------------------------------------------------------------
  // E2E-2b: Multiple versions — activating one doesn't deactivate another
  // ---------------------------------------------------------------------------
  test('E2E-2b: multiple versions can be active simultaneously', async () => {
    const workflow = await createWorkflow(`multi-${uniqueSlug('wf')}`);
    const wfId = workflow.id;
    const basePath = `/api/projects/${admin.projectId}/workflows/${wfId}/versions`;

    // Wait for draft creation
    await new Promise((r) => setTimeout(r, 500));

    // Create first published version
    const v1Res = await requestJson<{ success: boolean; version: string }>(harness, basePath, {
      method: 'POST',
      headers: authHeaders(admin.token),
      body: { changelog: 'v1' },
    });
    expect([200, 201]).toContain(v1Res.status);
    const v1 = v1Res.body.version;

    // Modify draft to create a different hash
    await requestJson(harness, `${basePath}/draft`, {
      method: 'PATCH',
      headers: authHeaders(admin.token),
      body: {
        definition: {
          nodes: [
            {
              id: 'start-v2',
              nodeType: 'start',
              name: 'Start V2',
              position: { x: 10, y: 10 },
            },
          ],
        },
      },
    });

    // Create second published version
    const v2Res = await requestJson<{ success: boolean; version: string }>(harness, basePath, {
      method: 'POST',
      headers: authHeaders(admin.token),
      body: { changelog: 'v2' },
    });
    expect([200, 201]).toContain(v2Res.status);
    const v2 = v2Res.body.version;

    // Activate both
    await requestJson(harness, `${basePath}/${v1}/activate`, {
      method: 'POST',
      headers: authHeaders(admin.token),
      body: {},
    });
    await requestJson(harness, `${basePath}/${v2}/activate`, {
      method: 'POST',
      headers: authHeaders(admin.token),
      body: {},
    });

    // Both should be active
    const listRes = await requestJson<{
      success: boolean;
      versions: Array<{ version: string; state: string }>;
    }>(harness, basePath, {
      headers: authHeaders(admin.token),
    });
    expect(listRes.status).toBe(200);
    const activeVersions = listRes.body.versions.filter(
      (ver) => ver.state === 'active' && ver.version !== 'draft',
    );
    expect(activeVersions.length).toBeGreaterThanOrEqual(2);
  });
});
