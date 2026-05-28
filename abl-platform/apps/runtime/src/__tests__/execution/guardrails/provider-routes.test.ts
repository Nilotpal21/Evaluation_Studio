/**
 * Guardrail Provider Config CRUD Route Tests
 *
 * Exercises all guardrail-providers endpoints via HTTP against a real Express
 * app backed by MongoMemoryServer. No vi.mock() — uses RuntimeApiHarness
 * with real auth (dev-login JWT), real feature-gate, and real MongoDB.
 *
 * Endpoints under test:
 *   GET    /api/tenants/:tenantId/guardrail-providers
 *   POST   /api/tenants/:tenantId/guardrail-providers
 *   GET    /api/tenants/:tenantId/guardrail-providers/:id
 *   PUT    /api/tenants/:tenantId/guardrail-providers/:id
 *   DELETE /api/tenants/:tenantId/guardrail-providers/:id
 *   POST   /api/tenants/:tenantId/guardrail-providers/:id/test
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import nock from 'nock';
import { AuthProfile, TenantGuardrailProviderConfig } from '@agent-platform/database/models';
import authRouter from '../../../routes/auth.js';
import platformAdminTenantsRouter from '../../../routes/platform-admin-tenants.js';
import guardrailProviderRouter from '../../../routes/guardrail-providers.js';
import {
  startRuntimeApiHarness,
  type RuntimeApiHarness,
} from '../../helpers/runtime-api-harness.js';
import {
  authHeaders,
  bootstrapProject,
  requestJson,
  setSuperAdmins,
  uniqueEmail,
  uniqueSlug,
  type BootstrapProjectResult,
} from '../../helpers/channel-e2e-bootstrap.js';

// =============================================================================
// TYPES
// =============================================================================

interface SuccessResponse<T> {
  success: boolean;
  data: T;
}

interface ErrorResponse {
  success: boolean;
  error?: { code: string; message: string };
}

// =============================================================================
// SUITE
// =============================================================================

describe('Guardrail Provider Config CRUD Routes (E2E)', () => {
  let harness: RuntimeApiHarness;
  let ctx: BootstrapProjectResult;

  function providerUrl(suffix = ''): string {
    return `/api/tenants/${ctx.tenantId}/guardrail-providers${suffix}`;
  }

  const validPayload = {
    name: 'my-guard',
    displayName: 'My Custom HTTP Guard',
    adapterType: 'custom_http' as const,
    endpoint: 'http://guardrail-svc:8000/v1',
    model: 'content-safety-v1',
    hosting: 'self_hosted' as const,
    defaultCategory: 'content_safety',
    defaultThreshold: 0.8,
    supportedCategories: ['content_safety', 'pii'],
    circuitBreaker: { failureThreshold: 5, resetTimeoutMs: 30000, failMode: 'open' },
    retry: { maxRetries: 2, backoffBaseMs: 500 },
    costPerEvalUsd: 0,
  };

  beforeAll(async () => {
    harness = await startRuntimeApiHarness((app) => {
      app.use('/api/auth', authRouter);
      app.use('/api/platform/admin/tenants', platformAdminTenantsRouter);
      app.use('/api/tenants/:tenantId/guardrail-providers', guardrailProviderRouter);
    });

    ctx = await bootstrapProject(
      harness,
      uniqueEmail('grail-prov'),
      uniqueSlug('tenant-grail-prov'),
      uniqueSlug('proj-grail-prov'),
    );
  }, 60_000);

  afterAll(async () => {
    await harness.close();
  }, 30_000);

  beforeEach(async () => {
    await TenantGuardrailProviderConfig.deleteMany({});
    await AuthProfile.deleteMany({});
  });

  afterEach(() => {
    nock.cleanAll();
  });

  // Helper to create a provider via the API
  async function createProviderViaApi(
    overrides: Record<string, unknown> = {},
  ): Promise<{ status: number; body: SuccessResponse<any> & ErrorResponse }> {
    const res = await requestJson<SuccessResponse<any> & ErrorResponse>(harness, providerUrl(), {
      method: 'POST',
      headers: authHeaders(ctx.token),
      body: { ...validPayload, ...overrides },
    });
    return res;
  }

  // =============================================================================
  // LIST — GET /
  // =============================================================================

  describe('GET /api/tenants/:tenantId/guardrail-providers', () => {
    test('returns all providers for the tenant', async () => {
      await createProviderViaApi({ name: 'provider-a' });
      await createProviderViaApi({ name: 'provider-b' });

      const res = await requestJson<SuccessResponse<any[]>>(harness, providerUrl(), {
        method: 'GET',
        headers: authHeaders(ctx.token),
      });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data).toHaveLength(2);
    });

    test('returns empty array when no providers exist', async () => {
      const res = await requestJson<SuccessResponse<any[]>>(harness, providerUrl(), {
        method: 'GET',
        headers: authHeaders(ctx.token),
      });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data).toHaveLength(0);
    });

    test('tenant isolation — providers from another tenant are not returned', async () => {
      // Insert a provider directly for a different tenant
      await TenantGuardrailProviderConfig.create({
        ...validPayload,
        name: 'foreign-provider',
        tenantId: 'other-tenant-id',
      });

      // Create one for our tenant
      await createProviderViaApi({ name: 'my-provider' });

      const res = await requestJson<SuccessResponse<any[]>>(harness, providerUrl(), {
        method: 'GET',
        headers: authHeaders(ctx.token),
      });

      expect(res.status).toBe(200);
      expect(res.body.data).toHaveLength(1);
      expect(res.body.data[0].name).toBe('my-provider');
    });
  });

  // =============================================================================
  // CREATE — POST /
  // =============================================================================

  describe('POST /api/tenants/:tenantId/guardrail-providers', () => {
    test('creates a new provider config with tenantId injected from auth', async () => {
      const res = await createProviderViaApi();

      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
      expect(res.body.data).toBeDefined();
      expect(res.body.data.tenantId).toBe(ctx.tenantId);
      expect(res.body.data.name).toBe('my-guard');
    });

    test('accepts openai_moderation as an implemented adapter type', async () => {
      const profile = await AuthProfile.create({
        name: 'Tenant OpenAI Key',
        tenantId: ctx.tenantId,
        projectId: null,
        scope: 'tenant',
        visibility: 'shared',
        connectionMode: 'shared',
        createdBy: ctx.userId,
        authType: 'api_key',
        config: {},
        encryptedSecrets: '{}',
        encryptionKeyVersion: 1,
        status: 'active',
      });

      const res = await createProviderViaApi({
        name: 'openai-mod',
        adapterType: 'openai_moderation',
        endpoint: 'https://api.openai.com/v1/moderations',
        model: 'omni-moderation-latest',
        authProfileId: String(profile._id),
      });

      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
    });

    test('rejects active openai_moderation providers without executable credentials', async () => {
      const res = await createProviderViaApi({
        name: 'openai-no-key',
        adapterType: 'openai_moderation',
        endpoint: 'https://api.openai.com/v1/moderations',
        model: 'omni-moderation-latest',
      });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error?.code).toBe('VALIDATION_ERROR');
    });

    test.each([
      ['defaultThreshold above 1', { defaultThreshold: 2 }],
      ['defaultThreshold below 0', { defaultThreshold: -0.01 }],
      ['negative costPerEvalUsd', { costPerEvalUsd: -0.01 }],
      ['zero circuit breaker failure threshold', { circuitBreaker: { failureThreshold: 0 } }],
      ['negative circuit breaker reset timeout', { circuitBreaker: { resetTimeoutMs: -1 } }],
      ['negative retry count', { retry: { maxRetries: -1 } }],
      ['negative retry backoff', { retry: { backoffBaseMs: -1 } }],
    ])('rejects provider numeric controls outside runtime-safe bounds: %s', async (_name, body) => {
      const res = await createProviderViaApi({
        name: `numeric-${String(_name).replace(/\W+/g, '-')}`,
        ...body,
      });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error?.code).toBe('VALIDATION_ERROR');
    });

    test('normalizes legacy Studio resilience fields before persisting', async () => {
      const res = await createProviderViaApi({
        name: 'legacy-shape',
        circuitBreaker: { maxFailures: 7, resetTimeout: 45000 },
        retry: { maxRetries: 4, backoff: 'exponential' },
      });

      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
      expect(res.body.data.circuitBreaker).toEqual(
        expect.objectContaining({
          failureThreshold: 7,
          resetTimeoutMs: 45000,
        }),
      );
      expect(res.body.data.circuitBreaker).not.toHaveProperty('maxFailures');
      expect(res.body.data.circuitBreaker).not.toHaveProperty('resetTimeout');
      expect(res.body.data.retry).toEqual(
        expect.objectContaining({
          maxRetries: 4,
          backoffBaseMs: 1000,
        }),
      );
      expect(res.body.data.retry).not.toHaveProperty('backoff');
    });

    test('rejects raw API keys instead of accepting and silently dropping them', async () => {
      const res = await createProviderViaApi({
        name: 'raw-key-provider',
        apiKey: 'sk-raw-secret',
      });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error?.code).toBe('VALIDATION_ERROR');
    });

    test('rejects project-scoped auth profiles for tenant-level provider configs', async () => {
      const profile = await AuthProfile.create({
        name: 'Project OpenAI Key',
        tenantId: ctx.tenantId,
        projectId: ctx.projectId,
        scope: 'project',
        visibility: 'shared',
        connectionMode: 'shared',
        createdBy: ctx.userId,
        authType: 'api_key',
        config: {},
        encryptedSecrets: '{}',
        encryptionKeyVersion: 1,
        status: 'active',
      });

      const res = await createProviderViaApi({
        name: 'project-profile-provider',
        authProfileId: profile._id,
      });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error?.code).toBe('VALIDATION_ERROR');
    });

    test('accepts active tenant-scoped shared auth profiles for tenant-level provider configs', async () => {
      const profile = await AuthProfile.create({
        name: 'Tenant OpenAI Key',
        tenantId: ctx.tenantId,
        projectId: null,
        scope: 'tenant',
        visibility: 'shared',
        connectionMode: 'shared',
        createdBy: ctx.userId,
        authType: 'api_key',
        config: {},
        encryptedSecrets: '{}',
        encryptionKeyVersion: 1,
        status: 'active',
      });

      const res = await createProviderViaApi({
        name: 'tenant-profile-provider',
        authProfileId: profile._id,
      });

      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
      expect(res.body.data.authProfileId).toBe(profile._id);
    });

    test('rejects adapter types that are not wired at runtime', async () => {
      const res = await createProviderViaApi({
        name: 'compat-guard',
        adapterType: 'openai_compatible',
      });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error?.code).toBe('ADAPTER_NOT_IMPLEMENTED');
    });

    test('rejects builtin_pii because the built-in provider is not tenant-configurable', async () => {
      const res = await createProviderViaApi({
        name: 'pii-guard',
        adapterType: 'builtin_pii',
      });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error?.code).toBe('ADAPTER_NOT_IMPLEMENTED');
    });

    test('returns 400 for missing required fields', async () => {
      const res = await requestJson<ErrorResponse>(harness, providerUrl(), {
        method: 'POST',
        headers: authHeaders(ctx.token),
        body: {},
      });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
    });

    test('returns 409 on duplicate name within same tenant', async () => {
      await createProviderViaApi({ name: 'dup-name' });
      const res = await createProviderViaApi({ name: 'dup-name' });

      expect(res.status).toBe(409);
      expect(res.body.success).toBe(false);
    });
  });

  // =============================================================================
  // GET BY ID — GET /:id
  // =============================================================================

  describe('GET /api/tenants/:tenantId/guardrail-providers/:id', () => {
    test('returns provider with tenant isolation', async () => {
      const created = await createProviderViaApi();
      const providerId = created.body.data._id;

      const res = await requestJson<SuccessResponse<any>>(harness, providerUrl(`/${providerId}`), {
        method: 'GET',
        headers: authHeaders(ctx.token),
      });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data._id).toBe(providerId);
      expect(res.body.data.tenantId).toBe(ctx.tenantId);
    });

    test('returns 404 for non-existent provider', async () => {
      const res = await requestJson<ErrorResponse>(harness, providerUrl('/nonexistent-id'), {
        method: 'GET',
        headers: authHeaders(ctx.token),
      });

      expect(res.status).toBe(404);
      expect(res.body.success).toBe(false);
      expect(res.body.error?.code).toBe('NOT_FOUND');
    });

    test('returns 404 for provider from another tenant (tenant isolation)', async () => {
      const foreignProvider = await TenantGuardrailProviderConfig.create({
        ...validPayload,
        name: 'foreign-prov',
        tenantId: 'other-tenant-id',
      });

      const res = await requestJson<ErrorResponse>(
        harness,
        providerUrl(`/${foreignProvider._id}`),
        {
          method: 'GET',
          headers: authHeaders(ctx.token),
        },
      );

      expect(res.status).toBe(404);
      expect(res.body.success).toBe(false);
    });
  });

  // =============================================================================
  // UPDATE — PUT /:id
  // =============================================================================

  describe('PUT /api/tenants/:tenantId/guardrail-providers/:id', () => {
    test('updates provider with tenant isolation', async () => {
      const created = await createProviderViaApi();
      const providerId = created.body.data._id;

      const res = await requestJson<SuccessResponse<any>>(harness, providerUrl(`/${providerId}`), {
        method: 'PUT',
        headers: authHeaders(ctx.token),
        body: { displayName: 'Updated Name' },
      });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.displayName).toBe('Updated Name');
    });

    test('returns 404 for non-existent provider', async () => {
      const res = await requestJson<ErrorResponse>(harness, providerUrl('/nonexistent-id'), {
        method: 'PUT',
        headers: authHeaders(ctx.token),
        body: { displayName: 'Updated' },
      });

      expect(res.status).toBe(404);
      expect(res.body.success).toBe(false);
    });

    test('prevents tenantId from being overridden in body', async () => {
      const created = await createProviderViaApi();
      const providerId = created.body.data._id;

      const res = await requestJson<SuccessResponse<any>>(harness, providerUrl(`/${providerId}`), {
        method: 'PUT',
        headers: authHeaders(ctx.token),
        body: { tenantId: 'malicious-tenant', displayName: 'Hacked' },
      });

      expect(res.status).toBe(200);
      // tenantId should remain unchanged
      expect(res.body.data.tenantId).toBe(ctx.tenantId);
      expect(res.body.data.displayName).toBe('Hacked');
    });

    test('rejects raw API keys on update instead of accepting and silently dropping them', async () => {
      const created = await createProviderViaApi();
      const providerId = created.body.data._id;

      const res = await requestJson<ErrorResponse>(harness, providerUrl(`/${providerId}`), {
        method: 'PUT',
        headers: authHeaders(ctx.token),
        body: { apiKey: 'sk-raw-secret' },
      });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error?.code).toBe('VALIDATION_ERROR');
    });

    test('rejects personal auth profiles on update because tenant providers are shared runtime config', async () => {
      const created = await createProviderViaApi();
      const providerId = created.body.data._id;
      const profile = await AuthProfile.create({
        name: 'Personal OpenAI Key',
        tenantId: ctx.tenantId,
        projectId: null,
        scope: 'tenant',
        visibility: 'personal',
        connectionMode: 'shared',
        createdBy: ctx.userId,
        authType: 'api_key',
        config: {},
        encryptedSecrets: '{}',
        encryptionKeyVersion: 1,
        status: 'active',
      });

      const res = await requestJson<ErrorResponse>(harness, providerUrl(`/${providerId}`), {
        method: 'PUT',
        headers: authHeaders(ctx.token),
        body: { authProfileId: profile._id },
      });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error?.code).toBe('VALIDATION_ERROR');
    });

    test('rejects invalid resilience controls on update', async () => {
      const created = await createProviderViaApi({ name: 'bad-resilience-update' });

      const res = await requestJson<ErrorResponse>(
        harness,
        providerUrl(`/${created.body.data._id}`),
        {
          method: 'PUT',
          headers: authHeaders(ctx.token),
          body: {
            circuitBreaker: {
              failureThreshold: -1,
            },
          },
        },
      );

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error?.code).toBe('VALIDATION_ERROR');
    });

    test('rejects activating an existing openai_moderation provider that still has no executable credentials', async () => {
      const provider = await TenantGuardrailProviderConfig.create({
        ...validPayload,
        name: 'inactive-openai-no-auth',
        tenantId: ctx.tenantId,
        adapterType: 'openai_moderation',
        endpoint: 'https://api.openai.com/v1/moderations',
        model: 'omni-moderation-latest',
        isActive: false,
      });

      const res = await requestJson<ErrorResponse>(harness, providerUrl(`/${provider._id}`), {
        method: 'PUT',
        headers: authHeaders(ctx.token),
        body: { isActive: true },
      });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error?.code).toBe('VALIDATION_ERROR');
    });

    test('rejects clearing authProfileId when the effective openai_moderation provider remains active', async () => {
      const profile = await AuthProfile.create({
        name: 'Tenant OpenAI Key',
        tenantId: ctx.tenantId,
        projectId: null,
        scope: 'tenant',
        visibility: 'shared',
        connectionMode: 'shared',
        createdBy: ctx.userId,
        authType: 'api_key',
        config: {},
        encryptedSecrets: '{}',
        encryptionKeyVersion: 1,
        status: 'active',
      });
      const created = await createProviderViaApi({
        name: 'active-openai-with-auth',
        adapterType: 'openai_moderation',
        endpoint: 'https://api.openai.com/v1/moderations',
        model: 'omni-moderation-latest',
        authProfileId: String(profile._id),
      });
      const providerId = created.body.data._id;

      const res = await requestJson<ErrorResponse>(harness, providerUrl(`/${providerId}`), {
        method: 'PUT',
        headers: authHeaders(ctx.token),
        body: { authProfileId: null },
      });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error?.code).toBe('VALIDATION_ERROR');
    });

    test.each([
      ['defaultThreshold above 1', { defaultThreshold: 2 }],
      ['defaultThreshold below 0', { defaultThreshold: -0.01 }],
      ['negative costPerEvalUsd', { costPerEvalUsd: -0.01 }],
    ])(
      'rejects provider numeric control updates outside runtime-safe bounds: %s',
      async (_name, body) => {
        const created = await createProviderViaApi({
          name: `update-numeric-${String(_name).replace(/\W+/g, '-')}`,
        });
        const providerId = created.body.data._id;

        const res = await requestJson<ErrorResponse>(harness, providerUrl(`/${providerId}`), {
          method: 'PUT',
          headers: authHeaders(ctx.token),
          body,
        });

        expect(res.status).toBe(400);
        expect(res.body.success).toBe(false);
        expect(res.body.error?.code).toBe('VALIDATION_ERROR');
      },
    );
  });

  // =============================================================================
  // DELETE — DELETE /:id
  // =============================================================================

  describe('DELETE /api/tenants/:tenantId/guardrail-providers/:id', () => {
    test('deletes provider with tenant isolation', async () => {
      const created = await createProviderViaApi();
      const providerId = created.body.data._id;

      const res = await requestJson<SuccessResponse<{ deleted: boolean }>>(
        harness,
        providerUrl(`/${providerId}`),
        {
          method: 'DELETE',
          headers: authHeaders(ctx.token),
        },
      );

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.deleted).toBe(true);

      // Verify it is really gone
      const verify = await requestJson<ErrorResponse>(harness, providerUrl(`/${providerId}`), {
        method: 'GET',
        headers: authHeaders(ctx.token),
      });
      expect(verify.status).toBe(404);
    });

    test('returns 404 for non-existent provider', async () => {
      const res = await requestJson<ErrorResponse>(harness, providerUrl('/nonexistent-id'), {
        method: 'DELETE',
        headers: authHeaders(ctx.token),
      });

      expect(res.status).toBe(404);
      expect(res.body.success).toBe(false);
    });
  });

  // =============================================================================
  // TEST — POST /:id/test
  // =============================================================================

  describe('POST /api/tenants/:tenantId/guardrail-providers/:id/test', () => {
    test('returns test result for active provider', async () => {
      const created = await createProviderViaApi();
      const providerId = created.body.data._id;

      const res = await requestJson<SuccessResponse<any>>(
        harness,
        providerUrl(`/${providerId}/test`),
        {
          method: 'POST',
          headers: authHeaders(ctx.token),
          body: { text: 'Hello, how are you?' },
        },
      );

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.providerId).toBe(providerId);
      expect(res.body.data.status).toBeDefined();
    });

    test('executes the configured provider and returns the evaluation result', async () => {
      const providerScope = nock('https://guardrails.example.com')
        .post('/evaluate', { text: 'I might hurt myself' })
        .reply(
          200,
          {
            score: 0.73,
            label: 'self-harm',
            explanation: 'Provider evaluated the sample text',
          },
          { 'content-type': 'application/json' },
        );

      const created = await createProviderViaApi({
        name: 'runtime-test-provider',
        endpoint: 'https://guardrails.example.com/evaluate',
        defaultCategory: 'self_harm',
        customMapping: {
          requestTemplate: '{"text": "{{content}}"}',
          responseScorePath: 'score',
          responseLabelPath: 'label',
          responseExplanationPath: 'explanation',
        },
      });
      const providerId = created.body.data._id;

      const res = await requestJson<SuccessResponse<any>>(
        harness,
        providerUrl(`/${providerId}/test`),
        {
          method: 'POST',
          headers: authHeaders(ctx.token),
          body: { text: 'I might hurt myself' },
        },
      );

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(providerScope.isDone()).toBe(true);
      expect(res.body.data).toEqual(
        expect.objectContaining({
          providerId,
          providerName: 'runtime-test-provider',
          adapterType: 'custom_http',
          status: 'healthy',
          category: 'self_harm',
          score: 0.73,
          severity: 'high',
          label: 'self-harm',
          explanation: 'Provider evaluated the sample text',
        }),
      );
    });

    test('reports provider test as unhealthy when fail-open masks an unavailable provider', async () => {
      const providerScope = nock('https://guardrails.example.com')
        .post('/down', { text: 'please evaluate this' })
        .reply(503, { error: 'service unavailable' }, { 'content-type': 'application/json' });

      const created = await createProviderViaApi({
        name: 'unavailable-provider',
        endpoint: 'https://guardrails.example.com/down',
        defaultCategory: 'toxicity',
        customMapping: {
          requestTemplate: '{"text": "{{content}}"}',
          responseScorePath: 'score',
        },
        circuitBreaker: { failureThreshold: 5, resetTimeoutMs: 30000, failMode: 'open' },
      });
      const providerId = created.body.data._id;

      const res = await requestJson<SuccessResponse<any>>(
        harness,
        providerUrl(`/${providerId}/test`),
        {
          method: 'POST',
          headers: authHeaders(ctx.token),
          body: { text: 'please evaluate this' },
        },
      );

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(providerScope.isDone()).toBe(true);
      expect(res.body.data).toEqual(
        expect.objectContaining({
          providerId,
          providerName: 'unavailable-provider',
          status: 'unhealthy',
          score: 0,
          severity: 'safe',
        }),
      );
    });

    test('returns 404 for non-existent provider', async () => {
      const res = await requestJson<ErrorResponse>(harness, providerUrl('/nonexistent-id/test'), {
        method: 'POST',
        headers: authHeaders(ctx.token),
        body: { text: 'test' },
      });

      expect(res.status).toBe(404);
      expect(res.body.success).toBe(false);
    });

    test('returns 400 if text is missing', async () => {
      const created = await createProviderViaApi();
      const providerId = created.body.data._id;

      const res = await requestJson<ErrorResponse>(harness, providerUrl(`/${providerId}/test`), {
        method: 'POST',
        headers: authHeaders(ctx.token),
        body: {},
      });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
    });
  });

  // =============================================================================
  // TENANT ISOLATION — Cross-cutting concerns
  // =============================================================================

  describe('Tenant Isolation', () => {
    test('all queries are scoped to the authenticated tenant', async () => {
      // Create a provider via API (ensures correct tenant)
      const created = await createProviderViaApi({ name: 'isolation-test' });
      const providerId = created.body.data._id;
      expect(created.body.data.tenantId).toBe(ctx.tenantId);

      // LIST — only returns providers for this tenant
      const list = await requestJson<SuccessResponse<any[]>>(harness, providerUrl(), {
        method: 'GET',
        headers: authHeaders(ctx.token),
      });
      expect(list.body.data).toHaveLength(1);
      expect(list.body.data[0].tenantId).toBe(ctx.tenantId);

      // GET by ID — returns the correct provider
      const get = await requestJson<SuccessResponse<any>>(harness, providerUrl(`/${providerId}`), {
        method: 'GET',
        headers: authHeaders(ctx.token),
      });
      expect(get.body.data.tenantId).toBe(ctx.tenantId);

      // DELETE — scoped to tenant
      const del = await requestJson<SuccessResponse<{ deleted: boolean }>>(
        harness,
        providerUrl(`/${providerId}`),
        {
          method: 'DELETE',
          headers: authHeaders(ctx.token),
        },
      );
      expect(del.body.data.deleted).toBe(true);
    });
  });
});
