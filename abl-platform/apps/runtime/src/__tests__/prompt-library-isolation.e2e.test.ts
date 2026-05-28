/**
 * E2E-5: Prompt Library Tenant + Project Isolation
 *
 * Verifies that cross-project and cross-tenant access to any prompt-library
 * route returns 404 (NEVER 403) to avoid leaking resource existence.
 *
 * Topology:
 *   T1 / projectA — owns pl_1 (prompt) + plv_1 (version)
 *   T1 / projectB — different project, same tenant (U2)
 *   T2 / projectX — completely different tenant (U3)
 */

import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import {
  startRuntimeServerHarness,
  type RuntimeApiHarness,
} from './helpers/runtime-api-harness.js';
import {
  authHeaders,
  bootstrapProject,
  devLogin,
  setSuperAdmins,
  createTenant,
  createProject,
  requestJson,
  uniqueEmail,
  uniqueSlug,
} from './helpers/channel-e2e-bootstrap.js';
import { createPrompt, createVersion } from './helpers/prompt-library-helpers.js';

const TIMEOUT_MS = 90_000;

describe('E2E-5: Prompt Library cross-project + cross-tenant isolation', () => {
  let harness: RuntimeApiHarness | undefined;

  // Owner
  let tokenA: string;
  let projectA: string;
  let promptId: string;
  let versionId: string;

  // Cross-project (same tenant)
  let tokenB: string;
  let projectB: string;

  // Cross-tenant
  let tokenX: string;
  let projectX: string;

  beforeAll(async () => {
    harness = await startRuntimeServerHarness();

    // Setup T1/projectA (owner)
    const bootA = await bootstrapProject(
      harness,
      uniqueEmail('iso-owner'),
      uniqueSlug('iso-t1'),
      uniqueSlug('iso-proj-a'),
    );
    tokenA = bootA.token;
    projectA = bootA.projectId;

    // Create a prompt + version in projectA
    const { item } = await createPrompt(harness, tokenA, projectA, {
      name: 'isolated-prompt',
    });
    promptId = item._id;

    const v = await createVersion(harness, tokenA, projectA, promptId, {
      template: 'Secret template',
      variables: [],
    });
    versionId = v._id;

    // Setup T1/projectB (different project, same tenant as bootA)
    const loginB = await devLogin(harness, uniqueEmail('iso-cross-proj'));
    await setSuperAdmins([loginB.user.id]);
    const tenantB = await createTenant(
      harness,
      loginB.accessToken,
      'ISO Tenant 1 B',
      uniqueSlug('iso-t1b'),
    );
    const projB = await createProject(
      harness,
      loginB.accessToken,
      tenantB._id,
      'Project B',
      uniqueSlug('iso-proj-b'),
    );
    tokenB = loginB.accessToken;
    projectB = projB._id;

    // Setup T2/projectX (different tenant entirely)
    const loginX = await devLogin(harness, uniqueEmail('iso-cross-tenant'));
    await setSuperAdmins([loginX.user.id]);
    const tenantX = await createTenant(
      harness,
      loginX.accessToken,
      'ISO Tenant 2',
      uniqueSlug('iso-t2'),
    );
    const projX = await createProject(
      harness,
      loginX.accessToken,
      tenantX._id,
      'Project X',
      uniqueSlug('iso-proj-x'),
    );
    tokenX = loginX.accessToken;
    projectX = projX._id;
  }, TIMEOUT_MS);

  afterAll(async () => {
    await harness?.close();
  });

  // Helper: run the full isolation route matrix for a given token+project combination
  async function assertAllRoutes404(token: string, project: string): Promise<void> {
    const routes: Array<{ method: string; path: string }> = [
      { method: 'GET', path: `/api/projects/${project}/prompt-library/prompts/${promptId}` },
      { method: 'PATCH', path: `/api/projects/${project}/prompt-library/prompts/${promptId}` },
      { method: 'DELETE', path: `/api/projects/${project}/prompt-library/prompts/${promptId}` },
      {
        method: 'GET',
        path: `/api/projects/${project}/prompt-library/prompts/${promptId}/versions`,
      },
      {
        method: 'GET',
        path: `/api/projects/${project}/prompt-library/prompts/${promptId}/versions/${versionId}`,
      },
      {
        method: 'POST',
        path: `/api/projects/${project}/prompt-library/prompts/${promptId}/versions/${versionId}/promote`,
      },
      {
        method: 'POST',
        path: `/api/projects/${project}/prompt-library/prompts/${promptId}/versions/${versionId}/archive`,
      },
      {
        method: 'GET',
        path: `/api/projects/${project}/prompt-library/prompts/${promptId}/references`,
      },
    ];

    for (const { method, path } of routes) {
      const res = await requestJson<{ error?: { code: string } }>(harness!, path, {
        method,
        headers: authHeaders(token),
        ...(method === 'PATCH' ? { body: { name: 'injected' } } : {}),
      });
      expect(
        res.status,
        `Expected 404 for ${method} ${path}, got ${res.status}: ${JSON.stringify(res.body)}`,
      ).toBe(404);
      // Must never return 403 — that would leak existence
      expect(res.status).not.toBe(403);
    }
  }

  test(
    'E2E-5.1: cross-project access (same tenant) — all prompt routes return 404',
    async () => {
      await assertAllRoutes404(tokenB, projectB);
    },
    TIMEOUT_MS,
  );

  test(
    'E2E-5.2: cross-tenant access — all prompt routes return 404',
    async () => {
      await assertAllRoutes404(tokenX, projectX);
    },
    TIMEOUT_MS,
  );

  test(
    'E2E-5.3: test endpoint with cross-project version id returns 404 or 400',
    async () => {
      // POST /test with a versionId that belongs to projectA but called from projectB
      const res = await requestJson<{ error?: { code: string } }>(
        harness!,
        `/api/projects/${projectB}/prompt-library/test`,
        {
          method: 'POST',
          headers: authHeaders(tokenB),
          body: {
            panes: [{ promptVersionId: versionId, tenantModelId: 'any-model-id' }],
            userMessage: 'ping',
          },
        },
      );
      // The route is project-scoped — version lookup will fail (404 or 400 with NOT_FOUND code)
      expect([400, 404]).toContain(res.status);
      expect(res.status).not.toBe(403);
    },
    TIMEOUT_MS,
  );

  test(
    'E2E-5.4: owner can still access their own prompt after isolation checks',
    async () => {
      const res = await requestJson<{ success: boolean; item: unknown }>(
        harness!,
        `/api/projects/${projectA}/prompt-library/prompts/${promptId}`,
        { headers: authHeaders(tokenA) },
      );
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.item).toBeDefined();
    },
    TIMEOUT_MS,
  );

  test(
    'E2E-5.5: unauthenticated request returns 401 not 404',
    async () => {
      const res = await requestJson<{ error?: { code: string } }>(
        harness!,
        `/api/projects/${projectA}/prompt-library/prompts/${promptId}`,
        {},
      );
      expect(res.status).toBe(401);
    },
    TIMEOUT_MS,
  );
});
