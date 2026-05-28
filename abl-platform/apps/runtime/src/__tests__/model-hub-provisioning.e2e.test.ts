/**
 * Model Hub Provisioning E2E Tests
 *
 * Exercises the tenant model provisioning lifecycle through the real HTTP stack:
 * real Express server, real MongoDB (MongoMemoryServer), real middleware chain.
 *
 * Routes under test:
 *   POST   /api/platform/admin/tenant-models — provision model to tenant
 *   GET    /api/tenants/:tenantId/models     — list models for tenant
 *   GET    /api/tenants/:tenantId/models/:id — get single model
 *   PATCH  /api/tenants/:tenantId/models/:id — update model config
 *   DELETE /api/tenants/:tenantId/models/:id — delete model
 *
 * Run with: npx vitest run --config vitest.e2e.config.ts src/__tests__/model-hub-provisioning.e2e.test.ts
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

// ─── Types ───────────────────────────────────────────────────────────────────

interface TenantModelResponse {
  success: boolean;
  model: {
    id: string;
    displayName: string;
    provider: string;
    modelId: string;
    isActive: boolean;
    inferenceEnabled: boolean;
    tier: string;
    connections: Array<{
      id: string;
      isActive: boolean;
      isPrimary: boolean;
      healthStatus: string;
    }>;
  };
}

interface TenantModelListResponse {
  success: boolean;
  models: Array<{
    id: string;
    displayName: string;
    provider: string;
    modelId: string;
    isActive: boolean;
    tier: string;
  }>;
}

// ─── Test Suite ──────────────────────────────────────────────────────────────

describe('Model Hub Provisioning E2E', () => {
  let harness: RuntimeApiHarness;
  let ctx: BootstrapProjectResult;
  /** Super admin token — ONLY for platform admin operations (provisionTenantModel). */
  let superAdminToken: string;
  /** Regular tenant ADMIN token — for all tenant-scoped operations. */
  let tenantAdminToken: string;

  beforeAll(async () => {
    harness = await startRuntimeApiHarness((app) => {
      app.use('/api/auth', authRouter);
      app.use('/api/platform/admin/tenants', platformAdminTenantsRouter);
      app.use('/api/platform/admin/tenant-models', platformAdminModelsRouter);
      app.use('/api/tenants/:tenantId/models', tenantModelsRouter);
    });

    ctx = await bootstrapProject(harness, 'mh-prov@test.com', 'mh-prov-tenant', 'mh-prov-project');
    superAdminToken = ctx.token;

    // Create a regular tenant ADMIN (not super admin) for tenant-scoped operations.
    // devLogin first to create the user in DB, then addMember, then devLogin again
    // to get a token that includes the tenantId claim from the membership.
    await devLogin(harness, 'mh-prov-admin@test.com');
    await addMember(harness, superAdminToken, ctx.tenantId, 'mh-prov-admin@test.com', 'ADMIN');
    const adminLogin = await devLogin(harness, 'mh-prov-admin@test.com');
    tenantAdminToken = adminLogin.accessToken;
  }, 30_000);

  afterAll(async () => {
    await harness?.close();
  }, 15_000);

  // ─── Provisioning ───────────────────────────────────────────────────────

  test('provisions a model to a tenant via platform admin', async () => {
    const model = await provisionTenantModel(harness, superAdminToken, {
      targetTenantId: ctx.tenantId,
      displayName: 'GPT-4o Mini (Test)',
      integrationType: 'easy',
      modelId: 'gpt-4o-mini',
      provider: 'openai',
      tier: 'fast',
      isDefault: true,
      connection: {
        credentialName: 'Test Credential',
        apiKey: 'sk-test-fake-key-12345',
      },
    });

    expect(model.id).toBeDefined();
    expect(model.displayName).toBe('GPT-4o Mini (Test)');
    expect(model.provider).toBe('openai');
    expect(model.modelId).toBe('gpt-4o-mini');
    expect(model.isActive).toBe(true);
    expect(model.tier).toBe('fast');
  });

  // ─── Read Operations ────────────────────────────────────────────────────

  test('lists all models for a tenant', async () => {
    const res = await requestJson<TenantModelListResponse>(
      harness,
      `/api/tenants/${ctx.tenantId}/models`,
      { headers: authHeaders(tenantAdminToken) },
    );

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.models.length).toBeGreaterThanOrEqual(1);

    const model = res.body.models.find((m) => m.displayName === 'GPT-4o Mini (Test)');
    expect(model).toBeDefined();
    expect(model!.provider).toBe('openai');
  });

  test('gets a single model by ID', async () => {
    // First list to get the ID
    const listRes = await requestJson<TenantModelListResponse>(
      harness,
      `/api/tenants/${ctx.tenantId}/models`,
      { headers: authHeaders(tenantAdminToken) },
    );
    const modelId = listRes.body.models[0].id;

    const res = await requestJson<TenantModelResponse>(
      harness,
      `/api/tenants/${ctx.tenantId}/models/${modelId}`,
      { headers: authHeaders(tenantAdminToken) },
    );

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.model.id).toBe(modelId);
    expect(res.body.model.connections).toBeDefined();
  });

  // ─── Update Operations ──────────────────────────────────────────────────

  test('updates model temperature and maxTokens via PATCH', async () => {
    const listRes = await requestJson<TenantModelListResponse>(
      harness,
      `/api/tenants/${ctx.tenantId}/models`,
      { headers: authHeaders(tenantAdminToken) },
    );
    const modelId = listRes.body.models[0].id;

    const res = await requestJson<TenantModelResponse>(
      harness,
      `/api/tenants/${ctx.tenantId}/models/${modelId}`,
      {
        method: 'PATCH',
        headers: authHeaders(tenantAdminToken),
        body: { temperature: 0.7, maxTokens: 2048 },
      },
    );

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });

  // ─── Delete Operations ──────────────────────────────────────────────────

  test('deletes a tenant-created model', async () => {
    // Create via tenant route (not platform admin) so it has no provisionedBy guard
    const createRes = await requestJson<{ success: boolean; model: { id: string } }>(
      harness,
      `/api/tenants/${ctx.tenantId}/models`,
      {
        method: 'POST',
        headers: authHeaders(tenantAdminToken),
        body: {
          displayName: 'Temp Model for Delete',
          integrationType: 'easy',
          modelId: 'gpt-4o-mini',
          provider: 'openai',
          tier: 'fast',
        },
      },
    );

    expect(createRes.status).toBe(201);
    const tempModelId = createRes.body.model.id;

    const delRes = await requestJson<{ success: boolean; deleted: string }>(
      harness,
      `/api/tenants/${ctx.tenantId}/models/${tempModelId}`,
      {
        method: 'DELETE',
        headers: authHeaders(tenantAdminToken),
      },
    );

    expect(delRes.status).toBe(200);
    expect(delRes.body.success).toBe(true);
    expect(delRes.body.deleted).toBe(tempModelId);

    // Verify it's gone
    const getRes = await requestJson<TenantModelResponse>(
      harness,
      `/api/tenants/${ctx.tenantId}/models/${tempModelId}`,
      { headers: authHeaders(tenantAdminToken) },
    );
    expect(getRes.status).toBe(404);
  });

  test('returns 403 when deleting a platform-provisioned model', async () => {
    // Platform-provisioned models have provisionedBy set and cannot be deleted by tenant
    const platformModel = await provisionTenantModel(harness, superAdminToken, {
      targetTenantId: ctx.tenantId,
      displayName: 'Platform Protected Model',
      integrationType: 'easy',
      modelId: 'gpt-4o',
      provider: 'openai',
      tier: 'balanced',
      connection: {
        credentialName: 'Platform Cred',
        apiKey: 'sk-test-platform-key-12345',
      },
    });

    const delRes = await requestJson<{ success: boolean; error: string }>(
      harness,
      `/api/tenants/${ctx.tenantId}/models/${platformModel.id}`,
      {
        method: 'DELETE',
        headers: authHeaders(tenantAdminToken),
      },
    );

    expect(delRes.status).toBe(403);
    expect(delRes.body.success).toBe(false);
  });

  // ─── Error Cases ────────────────────────────────────────────────────────

  test('returns 404 for non-existent model', async () => {
    const res = await requestJson<{ success: boolean; error: string }>(
      harness,
      `/api/tenants/${ctx.tenantId}/models/nonexistent-id`,
      { headers: authHeaders(tenantAdminToken) },
    );

    expect(res.status).toBe(404);
    expect(res.body.success).toBe(false);
  });
});
