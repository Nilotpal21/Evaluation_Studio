/**
 * Model Hub Tenant Isolation E2E Tests
 *
 * Verifies that tenant models are properly isolated — one tenant
 * cannot read, update, or delete another tenant's models.
 *
 * Routes under test:
 *   GET    /api/tenants/:tenantId/models/:id — cross-tenant 404
 *   PATCH  /api/tenants/:tenantId/models/:id — cross-tenant 404
 *   DELETE /api/tenants/:tenantId/models/:id — cross-tenant 404
 *
 * Run with: npx vitest run --config vitest.e2e.config.ts src/__tests__/model-hub-isolation.e2e.test.ts
 */

import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import authRouter from '../routes/auth.js';
import platformAdminTenantsRouter from '../routes/platform-admin-tenants.js';
import platformAdminModelsRouter from '../routes/platform-admin-models.js';
import tenantModelsRouter from '../routes/tenant-models.js';
import { startRuntimeApiHarness, type RuntimeApiHarness } from './helpers/runtime-api-harness.js';
import {
  addMember,
  authHeaders,
  bootstrapProject,
  devLogin,
  provisionTenantModel,
  requestJson,
  type BootstrapProjectResult,
} from './helpers/channel-e2e-bootstrap.js';

// ─── Test Suite ──────────────────────────────────────────────────────────────

describe('Model Hub Tenant Isolation E2E', () => {
  let harness: RuntimeApiHarness;
  let tenantA: BootstrapProjectResult;
  let tenantB: BootstrapProjectResult;
  /** Regular tenant ADMIN tokens — NOT super admin. Critical for isolation tests. */
  let tenantAAdminToken: string;
  let tenantBAdminToken: string;
  let tenantAModelId: string;

  beforeAll(async () => {
    harness = await startRuntimeApiHarness((app) => {
      app.use('/api/auth', authRouter);
      app.use('/api/platform/admin/tenants', platformAdminTenantsRouter);
      app.use('/api/platform/admin/tenant-models', platformAdminModelsRouter);
      app.use('/api/tenants/:tenantId/models', tenantModelsRouter);
    });

    // Bootstrap two separate tenants.
    // Note: each bootstrapProject call overwrites super admins, so the last
    // user (tenantB) becomes the sole super admin. Use tenantB.token for
    // platform admin operations (provisioning).
    tenantA = await bootstrapProject(
      harness,
      'mh-iso-a@test.com',
      'mh-iso-tenant-a',
      'mh-iso-proj-a',
    );
    tenantB = await bootstrapProject(
      harness,
      'mh-iso-b@test.com',
      'mh-iso-tenant-b',
      'mh-iso-proj-b',
    );

    // Create regular tenant ADMIN users (not super admins) for isolation assertions.
    // Super admin could bypass tenant isolation — these tests MUST use regular users.
    // devLogin first to create user in DB, then addMember, then devLogin again for token with tenantId.
    await devLogin(harness, 'mh-iso-admin-a@test.com');
    await addMember(harness, tenantB.token, tenantA.tenantId, 'mh-iso-admin-a@test.com', 'ADMIN');
    const adminALogin = await devLogin(harness, 'mh-iso-admin-a@test.com');
    tenantAAdminToken = adminALogin.accessToken;

    await devLogin(harness, 'mh-iso-admin-b@test.com');
    await addMember(harness, tenantB.token, tenantB.tenantId, 'mh-iso-admin-b@test.com', 'ADMIN');
    const adminBLogin = await devLogin(harness, 'mh-iso-admin-b@test.com');
    tenantBAdminToken = adminBLogin.accessToken;

    // Provision a model for tenant A (using tenantB.token — the current super admin)
    const model = await provisionTenantModel(harness, tenantB.token, {
      targetTenantId: tenantA.tenantId,
      displayName: 'Tenant A Model',
      integrationType: 'easy',
      modelId: 'gpt-4o-mini',
      provider: 'openai',
      tier: 'fast',
      isDefault: true,
      connection: {
        credentialName: 'A Cred',
        apiKey: 'sk-test-a-key-12345',
      },
    });
    tenantAModelId = model.id;
  }, 30_000);

  afterAll(async () => {
    await harness?.close();
  }, 15_000);

  // ─── Cross-Tenant Isolation ─────────────────────────────────────────────

  test('tenant B cannot GET tenant A model — returns 404 (not 403)', async () => {
    const res = await requestJson<{ success: boolean }>(
      harness,
      `/api/tenants/${tenantB.tenantId}/models/${tenantAModelId}`,
      { headers: authHeaders(tenantBAdminToken) },
    );

    // Cross-tenant access returns 404 to avoid leaking resource existence
    expect(res.status).toBe(404);
  });

  test('tenant B cannot PATCH tenant A model — returns 404', async () => {
    const res = await requestJson<{ success: boolean }>(
      harness,
      `/api/tenants/${tenantB.tenantId}/models/${tenantAModelId}`,
      {
        method: 'PATCH',
        headers: authHeaders(tenantBAdminToken),
        body: { temperature: 0.1 },
      },
    );

    expect(res.status).toBe(404);
  });

  test('tenant B cannot DELETE tenant A model — returns 404', async () => {
    const res = await requestJson<{ success: boolean }>(
      harness,
      `/api/tenants/${tenantB.tenantId}/models/${tenantAModelId}`,
      {
        method: 'DELETE',
        headers: authHeaders(tenantBAdminToken),
      },
    );

    expect(res.status).toBe(404);
  });

  test('tenant A model list does not appear in tenant B list', async () => {
    const res = await requestJson<{ success: boolean; models: Array<{ id: string }> }>(
      harness,
      `/api/tenants/${tenantB.tenantId}/models`,
      { headers: authHeaders(tenantBAdminToken) },
    );

    expect(res.status).toBe(200);
    const ids = res.body.models.map((m) => m.id);
    expect(ids).not.toContain(tenantAModelId);
  });

  test('tenant A can still access their own model', async () => {
    const res = await requestJson<{ success: boolean; model: { id: string } }>(
      harness,
      `/api/tenants/${tenantA.tenantId}/models/${tenantAModelId}`,
      { headers: authHeaders(tenantAAdminToken) },
    );

    expect(res.status).toBe(200);
    expect(res.body.model.id).toBe(tenantAModelId);
  });
});
