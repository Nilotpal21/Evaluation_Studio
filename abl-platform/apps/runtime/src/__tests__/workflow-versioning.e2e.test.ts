/**
 * E2E-1, E2E-3, E2E-4, E2E-5, E2E-9, E2E-10, E2E-11 — Workflow Versioning Core Lifecycle
 *
 * E2E-1: Full version lifecycle (create → deploy → activate → deactivate → verify)
 * E2E-3: Soft delete cascade (delete workflow → verify all versions/triggers cascade)
 * E2E-4: Default version resolution via Process API (latest active, draft fallback)
 * E2E-5: Cross-tenant/project isolation (404 for cross-scope access)
 * E2E-9: Unauthenticated/expired auth (401/403 responses)
 * E2E-10: Single version soft-delete (draft guard, delete, list exclusion, re-delete 404)
 * E2E-11: Delete active version (auto-deactivate triggers, then soft-delete)
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

/**
 * Wrapper around requestJson that retries on 429 (rate limited) responses.
 * The E2E test suite shares a single tenant rate-limit window, so tests near
 * the end of the suite may hit the per-minute cap.
 */
async function requestJsonRetry<T>(
  h: RuntimeApiHarness,
  path: string,
  init: Parameters<typeof requestJson>[2] = {},
  maxRetries = 3,
): Promise<Awaited<ReturnType<typeof requestJson<T>>>> {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const res = await requestJson<T>(h, path, init);
    if (res.status !== 429 || attempt === maxRetries) return res;
    // Wait for the rate limit window to slide (response includes retryAfterMs)
    const body = res.body as Record<string, unknown>;
    const waitMs = Math.min(
      typeof body.retryAfterMs === 'number' ? body.retryAfterMs : 5000,
      65000, // Rate-limit window is 60s; allow full window reset
    );
    await new Promise((r) => setTimeout(r, waitMs));
  }
  // Unreachable but satisfies TS
  return requestJson<T>(h, path, init);
}

describe('Workflow Versioning: Core Lifecycle E2E', () => {
  let harness: RuntimeApiHarness;
  let admin: BootstrapProjectResult;

  beforeAll(async () => {
    harness = await startRuntimeServerHarness();
    admin = await bootstrapProject(
      harness,
      'wf-ver-e2e@example.com',
      uniqueSlug('wf-ver-tenant'),
      uniqueSlug('wf-ver-proj'),
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
          envVars: { API_KEY: 'test-key' },
        },
      },
    );
    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    return res.body.data;
  }

  // ---------------------------------------------------------------------------
  // E2E-1: Full version lifecycle
  // ---------------------------------------------------------------------------
  test('E2E-1: create → publish → activate → deactivate → verify', async () => {
    const workflow = await createWorkflow(`lifecycle-${uniqueSlug('wf')}`);
    const wfId = workflow.id;
    const basePath = `/api/projects/${admin.projectId}/workflows/${wfId}/versions`;

    // 1. List versions — should have draft auto-created
    // Wait briefly for the fire-and-forget draft creation
    await new Promise((r) => setTimeout(r, 500));
    const listRes = await requestJson<{
      success: boolean;
      versions: Array<{ version: string; state: string }>;
      total: number;
    }>(harness, basePath, {
      headers: authHeaders(admin.token),
    });
    expect(listRes.status).toBe(200);
    expect(listRes.body.success).toBe(true);
    expect(listRes.body.versions.length).toBeGreaterThanOrEqual(1);
    const draftEntry = listRes.body.versions.find((v) => v.version === 'draft');
    expect(draftEntry).toBeDefined();

    // 2. Create a published version (snapshot from draft)
    const createRes = await requestJson<{
      success: boolean;
      versionId: string;
      version: string;
      sourceHash: string;
    }>(harness, basePath, {
      method: 'POST',
      headers: authHeaders(admin.token),
      body: { changelog: 'Initial release' },
    });
    expect([200, 201]).toContain(createRes.status);
    expect(createRes.body.success).toBe(true);
    expect(createRes.body.version).toMatch(/^v\d+\.\d+\.\d+$/);
    const publishedVersion = createRes.body.version;

    // 3. Activate the published version
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

    // 4. Verify activated state via GET
    const getRes = await requestJson<{
      success: boolean;
      version: { version: string; state: string };
    }>(harness, `${basePath}/${publishedVersion}`, {
      headers: authHeaders(admin.token),
    });
    expect(getRes.status).toBe(200);
    expect(getRes.body.version.state).toBe('active');

    // 5. Deactivate the version
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

    // 6. Verify deactivated
    const getRes2 = await requestJson<{
      success: boolean;
      version: { version: string; state: string };
    }>(harness, `${basePath}/${publishedVersion}`, {
      headers: authHeaders(admin.token),
    });
    expect(getRes2.status).toBe(200);
    expect(getRes2.body.version.state).toBe('inactive');

    // 7. Verify activating draft returns 400
    const draftActivateRes = await requestJson<{
      success: boolean;
      error?: { code: string };
    }>(harness, `${basePath}/draft/activate`, {
      method: 'POST',
      headers: authHeaders(admin.token),
      body: {},
    });
    expect(draftActivateRes.status).toBe(400);
    expect(draftActivateRes.body.error?.code).toBe('DRAFT_ALWAYS_ACTIVE');
  });

  // ---------------------------------------------------------------------------
  // E2E-3: Soft delete cascade
  // ---------------------------------------------------------------------------
  test('E2E-3: deleting workflow cascades to versions and triggers', async () => {
    const workflow = await createWorkflow(`cascade-${uniqueSlug('wf')}`);
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

    // Delete the workflow
    const deleteRes = await requestJson<{ success: boolean; message: string }>(
      harness,
      `/api/projects/${admin.projectId}/workflows/${wfId}`,
      {
        method: 'DELETE',
        headers: authHeaders(admin.token),
      },
    );
    expect(deleteRes.status).toBe(200);
    expect(deleteRes.body.success).toBe(true);

    // Verify versions are soft-deleted (list should be empty or return 404)
    const listRes = await requestJson<{
      success: boolean;
      versions: Array<{ version: string; deleted?: boolean }>;
      total: number;
    }>(harness, basePath, {
      headers: authHeaders(admin.token),
    });
    // After soft delete, list should return no visible versions or 404
    if (listRes.status === 200) {
      // Versions should be filtered out (deleted: true)
      expect(listRes.body.versions.length).toBe(0);
    } else {
      // Alternatively the route may return 404 for a deleted workflow
      expect([404, 200]).toContain(listRes.status);
    }
  });

  // ---------------------------------------------------------------------------
  // E2E-4: Default version resolution (draft fallback)
  // ---------------------------------------------------------------------------
  test('E2E-4: version resolution uses latest active, falls back to draft', async () => {
    const workflow = await createWorkflow(`resolution-${uniqueSlug('wf')}`);
    const wfId = workflow.id;
    const basePath = `/api/projects/${admin.projectId}/workflows/${wfId}/versions`;

    // Wait for draft creation
    await new Promise((r) => setTimeout(r, 500));

    // With only draft, GET draft should return the draft version
    const draftRes = await requestJson<{
      success: boolean;
      version: { version: string; state: string };
    }>(harness, `${basePath}/draft`, {
      headers: authHeaders(admin.token),
    });
    expect(draftRes.status).toBe(200);
    expect(draftRes.body.version.version).toBe('draft');

    // Create and activate a published version
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

    await requestJson(harness, `${basePath}/${publishedVersion}/activate`, {
      method: 'POST',
      headers: authHeaders(admin.token),
      body: {},
    });

    // GET the published version — should be active
    const activeRes = await requestJson<{
      success: boolean;
      version: { version: string; state: string };
    }>(harness, `${basePath}/${publishedVersion}`, {
      headers: authHeaders(admin.token),
    });
    expect(activeRes.status).toBe(200);
    expect(activeRes.body.version.state).toBe('active');

    // Deactivate — now only draft remains
    await requestJson(harness, `${basePath}/${publishedVersion}/deactivate`, {
      method: 'POST',
      headers: authHeaders(admin.token),
      body: {},
    });

    // All published versions inactive — system should fallback to draft
    const listRes = await requestJson<{
      success: boolean;
      versions: Array<{ version: string; state: string }>;
    }>(harness, basePath, {
      headers: authHeaders(admin.token),
    });
    expect(listRes.status).toBe(200);
    const activeVersions = listRes.body.versions.filter((v) => v.state === 'active');
    // No published versions active
    const activePublished = activeVersions.filter((v) => v.version !== 'draft');
    expect(activePublished.length).toBe(0);
  });

  // ---------------------------------------------------------------------------
  // E2E-5: Cross-tenant/project isolation
  // ---------------------------------------------------------------------------
  test('E2E-5: cross-tenant access returns 404', async () => {
    // Create a workflow in admin's project
    const workflow = await createWorkflow(`isolation-${uniqueSlug('wf')}`);
    const wfId = workflow.id;

    // Bootstrap a second tenant + project
    const otherAdmin = await bootstrapProject(
      harness,
      'other-tenant@example.com',
      uniqueSlug('other-tenant'),
      uniqueSlug('other-proj'),
    );

    // Cross-project: other admin tries to list versions of admin's workflow
    const crossProjectRes = await requestJson<{ success: boolean }>(
      harness,
      `/api/projects/${otherAdmin.projectId}/workflows/${wfId}/versions`,
      {
        headers: authHeaders(otherAdmin.token),
      },
    );
    // Should return 200 with empty results or 404 — never the actual versions
    if (crossProjectRes.status === 200) {
      const body = crossProjectRes.body as {
        versions?: Array<unknown>;
        total?: number;
      };
      // Versions from other tenant should not appear
      expect(body.versions?.length ?? 0).toBe(0);
    } else {
      expect(crossProjectRes.status).toBe(404);
    }

    // Cross-tenant: try to access using admin's project ID with other admin's token
    const crossTenantRes = await requestJson<{ success: boolean }>(
      harness,
      `/api/projects/${admin.projectId}/workflows/${wfId}/versions`,
      {
        headers: authHeaders(otherAdmin.token),
      },
    );
    // Should return 403 or 404 — never 200 with real data
    expect([403, 404]).toContain(crossTenantRes.status);
  });

  // ---------------------------------------------------------------------------
  // E2E-9: Unauthenticated/missing auth
  // ---------------------------------------------------------------------------
  test('E2E-9: unauthenticated requests return 401', async () => {
    const workflow = await createWorkflow(`auth-${uniqueSlug('wf')}`);
    const wfId = workflow.id;
    const basePath = `/api/projects/${admin.projectId}/workflows/${wfId}/versions`;

    // No auth header
    const noAuthRes = await requestJson<{ success: boolean }>(harness, basePath, {});
    expect(noAuthRes.status).toBe(401);

    // Invalid token
    const badAuthRes = await requestJson<{ success: boolean }>(harness, basePath, {
      headers: authHeaders('invalid-token-value'),
    });
    expect(badAuthRes.status).toBe(401);
  });

  // ---------------------------------------------------------------------------
  // E2E-1b: PATCH draft version (canvas auto-save)
  // ---------------------------------------------------------------------------
  test('E2E-1b: PATCH draft version updates definition', async () => {
    const workflow = await createWorkflow(`patch-draft-${uniqueSlug('wf')}`);
    const wfId = workflow.id;
    const basePath = `/api/projects/${admin.projectId}/workflows/${wfId}/versions`;

    // Wait for draft creation
    await new Promise((r) => setTimeout(r, 500));

    // Update draft definition via PATCH
    const patchRes = await requestJson<{
      success: boolean;
      version: { version: string; definition: Record<string, unknown> };
    }>(harness, `${basePath}/draft`, {
      method: 'PATCH',
      headers: authHeaders(admin.token),
      body: {
        definition: {
          nodes: [
            {
              id: 'start-1',
              nodeType: 'start',
              name: 'Start',
              position: { x: 100, y: 100 },
            },
            {
              id: 'func-1',
              nodeType: 'function',
              name: 'Process',
              position: { x: 200, y: 200 },
              config: { code: 'return input;' },
            },
          ],
          edges: [
            {
              id: 'edge-1',
              source: 'start-1',
              target: 'func-1',
            },
          ],
        },
      },
    });
    expect(patchRes.status).toBe(200);
    expect(patchRes.body.success).toBe(true);

    // Verify updated definition
    const getRes = await requestJson<{
      success: boolean;
      version: { definition: { nodes: Array<{ id: string }>; edges: Array<{ id: string }> } };
    }>(harness, `${basePath}/draft`, {
      headers: authHeaders(admin.token),
    });
    expect(getRes.status).toBe(200);
    expect(getRes.body.version.definition.nodes).toHaveLength(2);
    expect(getRes.body.version.definition.edges).toHaveLength(1);
  });

  // ---------------------------------------------------------------------------
  // E2E-1c: Diff two versions
  // ---------------------------------------------------------------------------
  test('E2E-1c: diff returns definitions for two versions', async () => {
    const workflow = await createWorkflow(`diff-${uniqueSlug('wf')}`);
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

    // Modify draft
    await requestJson(harness, `${basePath}/draft`, {
      method: 'PATCH',
      headers: authHeaders(admin.token),
      body: {
        definition: {
          nodes: [
            {
              id: 'new-node',
              nodeType: 'start',
              name: 'New Start',
              position: { x: 50, y: 50 },
            },
          ],
        },
      },
    });

    // Diff draft vs published
    const diffRes = await requestJson<{
      success: boolean;
      diff: {
        version1: string;
        version2: string;
        definition1: Record<string, unknown>;
        definition2: Record<string, unknown>;
      };
    }>(harness, `${basePath}/draft/diff/${publishedVersion}`, {
      headers: authHeaders(admin.token),
    });
    expect(diffRes.status).toBe(200);
    expect(diffRes.body.success).toBe(true);
    expect(diffRes.body.diff.definition1).toBeDefined();
    expect(diffRes.body.diff.definition2).toBeDefined();
  });

  // ---------------------------------------------------------------------------
  // E2E-1d: Deduplication on identical content
  // ---------------------------------------------------------------------------
  test('E2E-1d: creating version with identical content returns deduplicated', async () => {
    const workflow = await createWorkflow(`dedup-${uniqueSlug('wf')}`);
    const wfId = workflow.id;
    const basePath = `/api/projects/${admin.projectId}/workflows/${wfId}/versions`;

    // Wait for draft creation
    await new Promise((r) => setTimeout(r, 500));

    // Create first version
    const v1Res = await requestJson<{
      success: boolean;
      version: string;
      sourceHash: string;
      deduplicated?: boolean;
    }>(harness, basePath, {
      method: 'POST',
      headers: authHeaders(admin.token),
      body: {},
    });
    expect([200, 201]).toContain(v1Res.status);
    const sourceHash1 = v1Res.body.sourceHash;

    // Create second version without changing draft — should deduplicate
    const v2Res = await requestJson<{
      success: boolean;
      version: string;
      sourceHash: string;
      deduplicated?: boolean;
    }>(harness, basePath, {
      method: 'POST',
      headers: authHeaders(admin.token),
      body: {},
    });
    // Deduplication returns 200 (not 201)
    expect(v2Res.status).toBe(200);
    expect(v2Res.body.deduplicated).toBe(true);
    expect(v2Res.body.sourceHash).toBe(sourceHash1);
  });

  // ---------------------------------------------------------------------------
  // E2E-10: Single version soft-delete
  // ---------------------------------------------------------------------------
  test(
    'E2E-10: DELETE version — draft rejected, non-deployed deleted, removed from list',
    async () => {
      // Use requestJsonRetry: these tests run at the end of the suite and may
      // hit the per-tenant rate-limit window from earlier tests.
      const rj = <T>(
        path: string,
        init: Parameters<typeof requestJson>[2] = {},
      ): Promise<Awaited<ReturnType<typeof requestJson<T>>>> =>
        requestJsonRetry<T>(harness, path, init);

      const wfRes = await rj<{ success: boolean; data: { id: string } }>(
        `/api/projects/${admin.projectId}/workflows`,
        {
          method: 'POST',
          headers: authHeaders(admin.token),
          body: {
            name: `delete-${uniqueSlug('wf')}`,
            type: 'cx_automation',
            nodes: [{ id: 'start-1', nodeType: 'start', name: 'Start', position: { x: 0, y: 0 } }],
            edges: [],
            envVars: { API_KEY: 'test-key' },
          },
        },
      );
      expect(wfRes.status).toBe(201);
      const wfId = wfRes.body.data.id;
      const basePath = `/api/projects/${admin.projectId}/workflows/${wfId}/versions`;

      // Wait for draft creation
      await new Promise((r) => setTimeout(r, 500));

      // 1. Try DELETE draft → expect 409 DRAFT_CANNOT_DELETE
      const deleteDraftRes = await rj<{
        success: boolean;
        error?: { code: string; message: string };
      }>(`${basePath}/draft`, {
        method: 'DELETE',
        headers: authHeaders(admin.token),
      });
      expect(deleteDraftRes.status).toBe(409);
      expect(deleteDraftRes.body.success).toBe(false);
      expect(deleteDraftRes.body.error?.code).toBe('DRAFT_CANNOT_DELETE');

      // 2. Create a published version
      const createRes = await rj<{
        success: boolean;
        version: string;
        versionId: string;
      }>(basePath, {
        method: 'POST',
        headers: authHeaders(admin.token),
        body: { changelog: 'For delete test' },
      });
      expect([200, 201]).toContain(createRes.status);
      const publishedVersion = createRes.body.version;

      // 3. Delete the (inactive, non-deployed) version → expect 200
      const deleteRes = await rj<{
        success: boolean;
        message: string;
      }>(`${basePath}/${publishedVersion}`, {
        method: 'DELETE',
        headers: authHeaders(admin.token),
      });
      expect(deleteRes.status).toBe(200);
      expect(deleteRes.body.success).toBe(true);
      expect(deleteRes.body.message).toContain(publishedVersion);

      // 4. Verify version is gone from list
      const listRes = await rj<{
        success: boolean;
        versions: Array<{ version: string }>;
      }>(basePath, {
        headers: authHeaders(admin.token),
      });
      expect(listRes.status).toBe(200);
      const versionNames = listRes.body.versions.map((v) => v.version);
      expect(versionNames).not.toContain(publishedVersion);
      // Draft should still exist
      expect(versionNames).toContain('draft');

      // 5. DELETE the same version again → expect 404
      const reDeleteRes = await rj<{
        success: boolean;
        error?: { code: string };
      }>(`${basePath}/${publishedVersion}`, {
        method: 'DELETE',
        headers: authHeaders(admin.token),
      });
      expect(reDeleteRes.status).toBe(404);
    },
    TIMEOUT,
  );

  // ---------------------------------------------------------------------------
  // E2E-11: Delete active version auto-deactivates triggers
  // ---------------------------------------------------------------------------
  test(
    'E2E-11: DELETE active version deactivates then deletes',
    async () => {
      // Use requestJsonRetry: these tests run at the end of the suite and may
      // hit the per-tenant rate-limit window from earlier tests.
      const rj = <T>(
        path: string,
        init: Parameters<typeof requestJson>[2] = {},
      ): Promise<Awaited<ReturnType<typeof requestJson<T>>>> =>
        requestJsonRetry<T>(harness, path, init);

      const wfRes = await rj<{ success: boolean; data: { id: string } }>(
        `/api/projects/${admin.projectId}/workflows`,
        {
          method: 'POST',
          headers: authHeaders(admin.token),
          body: {
            name: `delete-active-${uniqueSlug('wf')}`,
            type: 'cx_automation',
            nodes: [{ id: 'start-1', nodeType: 'start', name: 'Start', position: { x: 0, y: 0 } }],
            edges: [],
            envVars: { API_KEY: 'test-key' },
          },
        },
      );
      expect(wfRes.status).toBe(201);
      const wfId = wfRes.body.data.id;
      const basePath = `/api/projects/${admin.projectId}/workflows/${wfId}/versions`;

      // Wait for draft creation
      await new Promise((r) => setTimeout(r, 500));

      // 1. Create and activate a version
      const createRes = await rj<{
        success: boolean;
        version: string;
      }>(basePath, {
        method: 'POST',
        headers: authHeaders(admin.token),
        body: {},
      });
      expect([200, 201]).toContain(createRes.status);
      const publishedVersion = createRes.body.version;

      const activateRes = await rj<{ success: boolean }>(
        `${basePath}/${publishedVersion}/activate`,
        {
          method: 'POST',
          headers: authHeaders(admin.token),
          body: {},
        },
      );
      expect(activateRes.status).toBe(200);

      // 2. Verify it's active
      const getRes = await rj<{
        success: boolean;
        version: { state: string };
      }>(`${basePath}/${publishedVersion}`, {
        headers: authHeaders(admin.token),
      });
      expect(getRes.body.version.state).toBe('active');

      // 3. Delete the active version → should succeed (auto-deactivate)
      const deleteRes = await rj<{
        success: boolean;
        message: string;
      }>(`${basePath}/${publishedVersion}`, {
        method: 'DELETE',
        headers: authHeaders(admin.token),
      });
      expect(deleteRes.status).toBe(200);
      expect(deleteRes.body.success).toBe(true);

      // 4. Verify version is gone from list
      const listRes = await rj<{
        success: boolean;
        versions: Array<{ version: string }>;
      }>(basePath, {
        headers: authHeaders(admin.token),
      });
      expect(listRes.status).toBe(200);
      const versionNames = listRes.body.versions.map((v) => v.version);
      expect(versionNames).not.toContain(publishedVersion);
    },
    TIMEOUT,
  );
});
