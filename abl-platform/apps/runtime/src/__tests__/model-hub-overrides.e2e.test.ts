/**
 * Model Hub Overrides E2E Tests
 *
 * Tests model configuration overrides: tier defaults, inference toggle,
 * and provisioned model field restrictions.
 *
 * Routes under test:
 *   POST   /api/platform/admin/tenant-models           — provision with tier
 *   PATCH  /api/tenants/:tenantId/models/:id           — update config
 *   POST   /api/tenants/:tenantId/models/:id/inference — toggle inference
 *
 * Run with: npx vitest run --config vitest.e2e.config.ts src/__tests__/model-hub-overrides.e2e.test.ts
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

describe('Model Hub Overrides E2E', () => {
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

    ctx = await bootstrapProject(harness, 'mh-ovr@test.com', 'mh-ovr-tenant', 'mh-ovr-project');
    superAdminToken = ctx.token;

    // Create a regular tenant ADMIN (not super admin) for tenant-scoped operations.
    // devLogin first to create the user in DB, then addMember, then devLogin again
    // to get a token that includes the tenantId claim from the membership.
    await devLogin(harness, 'mh-ovr-admin@test.com');
    await addMember(harness, superAdminToken, ctx.tenantId, 'mh-ovr-admin@test.com', 'ADMIN');
    const adminLogin = await devLogin(harness, 'mh-ovr-admin@test.com');
    tenantAdminToken = adminLogin.accessToken;
  }, 30_000);

  afterAll(async () => {
    await harness?.close();
  }, 15_000);

  // ─── Tier Defaults ──────────────────────────────────────────────────────

  test('provisions models with different tiers', async () => {
    const fastModel = await provisionTenantModel(harness, superAdminToken, {
      targetTenantId: ctx.tenantId,
      displayName: 'Fast Tier Model',
      integrationType: 'easy',
      modelId: 'gpt-4o-mini',
      provider: 'openai',
      tier: 'fast',
      isDefault: true,
      connection: {
        credentialName: 'Fast Cred',
        apiKey: 'sk-test-fast-key',
      },
    });

    const powerModel = await provisionTenantModel(harness, superAdminToken, {
      targetTenantId: ctx.tenantId,
      displayName: 'Power Tier Model',
      integrationType: 'easy',
      modelId: 'gpt-4o',
      provider: 'openai',
      tier: 'powerful',
      isDefault: true,
      connection: {
        credentialName: 'Power Cred',
        apiKey: 'sk-test-power-key',
      },
    });

    expect(fastModel.tier).toBe('fast');
    expect(powerModel.tier).toBe('powerful');
  });

  test('platform provisioning preserves dynamic execution parameters', async () => {
    const model = await provisionTenantModel(harness, superAdminToken, {
      targetTenantId: ctx.tenantId,
      displayName: 'Provisioned Dynamic Params Model',
      integrationType: 'easy',
      modelId: 'claude-opus-4-7',
      provider: 'anthropic',
      tier: 'powerful',
      hyperParameters: { enableThinking: true, thinkingBudget: 4096 },
      useResponsesApi: false,
      useStreaming: false,
      capabilities: ['text', 'tools', 'streaming'],
      connection: {
        credentialName: 'Provisioned Dynamic Params Cred',
        apiKey: 'sk-test-provisioned-dynamic-key',
      },
    });

    expect(model.hyperParameters).toEqual({ enableThinking: true, thinkingBudget: 4096 });
    expect(model.useResponsesApi).toBe(false);
    expect(model.useStreaming).toBe(false);
  });

  // ─── Inference Toggle ───────────────────────────────────────────────────

  test('toggles inference enabled/disabled', async () => {
    const model = await provisionTenantModel(harness, superAdminToken, {
      targetTenantId: ctx.tenantId,
      displayName: 'Toggle Test Model',
      integrationType: 'easy',
      modelId: 'gpt-4o-mini',
      provider: 'openai',
      tier: 'fast',
      connection: {
        credentialName: 'Toggle Cred',
        apiKey: 'sk-test-toggle-key',
      },
    });

    // Disable inference
    const disableRes = await requestJson<{ success: boolean }>(
      harness,
      `/api/tenants/${ctx.tenantId}/models/${model.id}/toggle-inference`,
      {
        method: 'POST',
        headers: authHeaders(tenantAdminToken),
        body: { inferenceEnabled: false },
      },
    );

    expect(disableRes.status).toBe(200);
    expect(disableRes.body.success).toBe(true);

    // Re-enable inference
    const enableRes = await requestJson<{ success: boolean }>(
      harness,
      `/api/tenants/${ctx.tenantId}/models/${model.id}/toggle-inference`,
      {
        method: 'POST',
        headers: authHeaders(tenantAdminToken),
        body: { inferenceEnabled: true },
      },
    );

    expect(enableRes.status).toBe(200);
    expect(enableRes.body.success).toBe(true);
  });

  // ─── Provisioned Model Restrictions ─────────────────────────────────────

  test('platform-provisioned model blocks restricted field updates', async () => {
    const model = await provisionTenantModel(harness, superAdminToken, {
      targetTenantId: ctx.tenantId,
      displayName: 'Restricted Model',
      integrationType: 'easy',
      modelId: 'gpt-4o-mini',
      provider: 'openai',
      tier: 'fast',
      connection: {
        credentialName: 'Restricted Cred',
        apiKey: 'sk-test-restricted-key',
      },
    });

    // Attempt to change the provider (blocked on provisioned models)
    const res = await requestJson<{ success: boolean; error: string }>(
      harness,
      `/api/tenants/${ctx.tenantId}/models/${model.id}`,
      {
        method: 'PATCH',
        headers: authHeaders(tenantAdminToken),
        body: { provider: 'anthropic' },
      },
    );

    expect(res.status).toBe(403);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toContain('platform-provisioned');
  });

  test('platform-provisioned model allows temperature and maxTokens', async () => {
    const model = await provisionTenantModel(harness, superAdminToken, {
      targetTenantId: ctx.tenantId,
      displayName: 'Allowed Fields Model',
      integrationType: 'easy',
      modelId: 'gpt-4o-mini',
      provider: 'openai',
      tier: 'fast',
      connection: {
        credentialName: 'Allowed Cred',
        apiKey: 'sk-test-allowed-key',
      },
    });

    const res = await requestJson<{ success: boolean }>(
      harness,
      `/api/tenants/${ctx.tenantId}/models/${model.id}`,
      {
        method: 'PATCH',
        headers: authHeaders(tenantAdminToken),
        body: { temperature: 0.5, maxTokens: 1024 },
      },
    );

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });

  test('platform-provisioned model allows dynamic runtime hyperparameters', async () => {
    const model = await provisionTenantModel(harness, superAdminToken, {
      targetTenantId: ctx.tenantId,
      displayName: 'Dynamic Params Model',
      integrationType: 'easy',
      modelId: 'claude-opus-4-7',
      provider: 'anthropic',
      tier: 'powerful',
      connection: {
        credentialName: 'Dynamic Params Cred',
        apiKey: 'sk-test-dynamic-key',
      },
    });

    const res = await requestJson<{
      success: boolean;
      model: { hyperParameters?: Record<string, unknown>; supportsStreaming?: boolean };
    }>(harness, `/api/tenants/${ctx.tenantId}/models/${model.id}`, {
      method: 'PATCH',
      headers: authHeaders(tenantAdminToken),
      body: {
        hyperParameters: { enableThinking: true, thinkingBudget: 4096 },
        supportsStreaming: true,
        capabilities: ['text', 'tools', 'streaming'],
      },
    });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.model.hyperParameters).toEqual({
      enableThinking: true,
      thinkingBudget: 4096,
    });
    expect(res.body.model.supportsStreaming).toBe(true);
  });

  // ─── Default Model Uniqueness ───────────────────────────────────────────

  test('lists all provisioned models including tier and isDefault', async () => {
    const listRes = await requestJson<{
      success: boolean;
      models: Array<{ id: string; tier: string; isDefault: boolean; displayName: string }>;
    }>(harness, `/api/tenants/${ctx.tenantId}/models`, {
      headers: authHeaders(tenantAdminToken),
    });

    expect(listRes.status).toBe(200);
    expect(listRes.body.success).toBe(true);
    // Should contain at least the models provisioned in earlier tests
    expect(listRes.body.models.length).toBeGreaterThanOrEqual(1);

    // Verify tier and isDefault fields are present on all models
    for (const model of listRes.body.models) {
      expect(typeof model.tier).toBe('string');
      expect(typeof model.isDefault).toBe('boolean');
    }
  });
});
