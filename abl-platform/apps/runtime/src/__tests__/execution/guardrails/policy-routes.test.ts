/**
 * Guardrail Policy CRUD Route Tests
 *
 * Exercises all guardrail-policies endpoints via HTTP against a real Express
 * app backed by MongoMemoryServer. No vi.mock() — uses RuntimeApiHarness
 * with real auth (dev-login JWT), real feature-gate, and real MongoDB.
 *
 * Endpoints under test:
 *   GET    /api/projects/:projectId/guardrail-policies
 *   POST   /api/projects/:projectId/guardrail-policies
 *   GET    /api/projects/:projectId/guardrail-policies/:id
 *   PUT    /api/projects/:projectId/guardrail-policies/:id
 *   POST   /api/projects/:projectId/guardrail-policies/:id/activate
 *   DELETE /api/projects/:projectId/guardrail-policies/:id
 */

import crypto from 'crypto';
import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { ApiKey, GuardrailPolicy } from '@agent-platform/database/models';
import authRouter from '../../../routes/auth.js';
import platformAdminTenantsRouter from '../../../routes/platform-admin-tenants.js';
import guardrailPolicyRouter from '../../../routes/guardrail-policies.js';
import {
  startRuntimeApiHarness,
  type RuntimeApiHarness,
} from '../../helpers/runtime-api-harness.js';
import {
  authHeaders,
  bootstrapProject,
  createProject,
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

describe('Guardrail Policy CRUD Routes (E2E)', () => {
  let harness: RuntimeApiHarness;
  let ctx: BootstrapProjectResult;

  function policyUrl(suffix = ''): string {
    return `/api/projects/${ctx.projectId}/guardrail-policies${suffix}`;
  }

  function tenantPolicyUrl(suffix = ''): string {
    return `/api/guardrail-policies${suffix}`;
  }

  const validCreatePayload = {
    name: 'safety-policy',
    rules: [
      {
        guardrailName: 'content_safety',
        override: 'threshold' as const,
        threshold: 0.9,
      },
    ],
    settings: {
      failMode: 'open',
      timeouts: { local: 100, model: 3000, llm: 10000 },
      streaming: {
        enabled: false,
        defaultInterval: 'sentence',
        chunkSize: 1,
        maxLatencyMs: 500,
        earlyTermination: true,
      },
    },
    caching: {
      enabled: false,
      exactMatch: false,
      semanticMatch: false,
      semanticThreshold: 0.95,
      defaultTtlSeconds: 3600,
    },
    budget: {
      monthlyLimitUsd: 100,
      currentSpendUsd: 0,
      overspendAction: 'alert_only',
    },
  };

  beforeAll(async () => {
    harness = await startRuntimeApiHarness((app) => {
      app.use('/api/auth', authRouter);
      app.use('/api/platform/admin/tenants', platformAdminTenantsRouter);
      app.use('/api/guardrail-policies', guardrailPolicyRouter);
      app.use('/api/projects/:projectId/guardrail-policies', guardrailPolicyRouter);
    });

    ctx = await bootstrapProject(
      harness,
      uniqueEmail('grail-pol'),
      uniqueSlug('tenant-grail-pol'),
      uniqueSlug('proj-grail-pol'),
    );
  }, 60_000);

  afterAll(async () => {
    await harness.close();
  }, 30_000);

  beforeEach(async () => {
    await GuardrailPolicy.deleteMany({});
  });

  // Helper to create a policy via the API and return the response data
  async function createPolicyViaApi(
    overrides: Record<string, unknown> = {},
  ): Promise<{ status: number; body: SuccessResponse<any> & ErrorResponse }> {
    const res = await requestJson<SuccessResponse<any> & ErrorResponse>(harness, policyUrl(), {
      method: 'POST',
      headers: authHeaders(ctx.token),
      body: { ...validCreatePayload, ...overrides },
    });
    return res;
  }

  async function createTenantPolicyViaApi(
    overrides: Record<string, unknown> = {},
  ): Promise<{ status: number; body: SuccessResponse<any> & ErrorResponse }> {
    const res = await requestJson<SuccessResponse<any> & ErrorResponse>(
      harness,
      tenantPolicyUrl(),
      {
        method: 'POST',
        headers: authHeaders(ctx.token),
        body: {
          name: 'tenant-safety-policy',
          rules: validCreatePayload.rules,
          settings: validCreatePayload.settings,
          ...overrides,
        },
      },
    );
    return res;
  }

  // =============================================================================
  // LIST — GET /
  // =============================================================================

  describe('GET /api/projects/:projectId/guardrail-policies', () => {
    test('returns all policies for the project', async () => {
      // Seed two policies
      await createPolicyViaApi({ name: 'policy-a' });
      await createPolicyViaApi({ name: 'policy-b' });

      const res = await requestJson<SuccessResponse<any[]>>(harness, policyUrl(), {
        method: 'GET',
        headers: authHeaders(ctx.token),
      });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data).toHaveLength(2);
    });

    test('returns empty array when no policies exist', async () => {
      const res = await requestJson<SuccessResponse<any[]>>(harness, policyUrl(), {
        method: 'GET',
        headers: authHeaders(ctx.token),
      });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data).toHaveLength(0);
    });

    test('tenant+project isolation — policies from another project are not returned', async () => {
      // Create a policy directly in DB for a different project but same tenant
      await GuardrailPolicy.create({
        tenantId: ctx.tenantId,
        name: 'other-project-policy',
        scope: { type: 'project', projectId: 'other-project-id' },
        settings: validCreatePayload.settings,
        caching: validCreatePayload.caching,
        budget: validCreatePayload.budget,
      });

      // Create one in our project
      await createPolicyViaApi({ name: 'my-project-policy' });

      const res = await requestJson<SuccessResponse<any[]>>(harness, policyUrl(), {
        method: 'GET',
        headers: authHeaders(ctx.token),
      });

      expect(res.status).toBe(200);
      expect(res.body.data).toHaveLength(1);
      expect(res.body.data[0].name).toBe('my-project-policy');
    });

    test('returns non-leaky 404 for API keys scoped to a different project', async () => {
      const secondProjectSlug = uniqueSlug('proj-grail-pol-api-key-scope');
      const secondProject = await createProject(
        harness,
        ctx.token,
        ctx.tenantId,
        `${secondProjectSlug} Name`,
        secondProjectSlug,
      );
      const rawKey = `abl_test_${uniqueSlug('guardrail-policy-key')}`;
      await ApiKey.create({
        tenantId: ctx.tenantId,
        name: 'guardrail policy read key',
        clientId: uniqueSlug('guardrail-policy-client'),
        keyHash: crypto.createHash('sha256').update(rawKey).digest('hex'),
        prefix: rawKey.substring(0, 8),
        scopes: ['guardrail:read'],
        projectIds: [secondProject._id],
        environments: [],
        createdBy: ctx.userId,
      });

      const res = await requestJson<ErrorResponse>(harness, policyUrl(), {
        method: 'GET',
        headers: authHeaders(rawKey),
      });

      expect(res.status).toBe(404);
      expect(res.body.success).toBe(false);
      expect(res.body.error?.code).toBe('PROJECT_SCOPE_MISMATCH');
    });
  });

  describe('Tenant-scoped routes', () => {
    test('creates tenant-scoped policies without requiring a projectId', async () => {
      const res = await createTenantPolicyViaApi({
        name: 'tenant-policy',
        status: 'active',
      });

      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
      expect(res.body.data.scope.type).toBe('tenant');
      expect(res.body.data.status).toBe('active');
    });

    test('lists only tenant-scoped policies on the tenant route', async () => {
      await createTenantPolicyViaApi({ name: 'tenant-policy-a' });
      await createPolicyViaApi({ name: 'project-policy-a' });

      const res = await requestJson<SuccessResponse<any[]>>(harness, tenantPolicyUrl(), {
        method: 'GET',
        headers: authHeaders(ctx.token),
      });

      expect(res.status).toBe(200);
      expect(res.body.data).toHaveLength(1);
      expect(res.body.data[0].scope.type).toBe('tenant');
      expect(res.body.data[0].name).toBe('tenant-policy-a');
    });

    test('gets and updates tenant-scoped policies through the tenant route', async () => {
      const created = await createTenantPolicyViaApi({ name: 'tenant-edit-policy' });

      const update = await requestJson<SuccessResponse<any> & ErrorResponse>(
        harness,
        tenantPolicyUrl(`/${created.body.data._id}`),
        {
          method: 'PUT',
          headers: authHeaders(ctx.token),
          body: {
            description: 'tenant policy description',
            status: 'archived',
          },
        },
      );

      const get = await requestJson<SuccessResponse<any>>(
        harness,
        tenantPolicyUrl(`/${created.body.data._id}`),
        {
          method: 'GET',
          headers: authHeaders(ctx.token),
        },
      );

      expect(update.status).toBe(200);
      expect(update.body.data.status).toBe('archived');
      expect(get.status).toBe(200);
      expect(get.body.data.description).toBe('tenant policy description');
      expect(get.body.data.scope.type).toBe('tenant');
    });
  });

  // =============================================================================
  // CREATE — POST /
  // =============================================================================

  describe('POST /api/projects/:projectId/guardrail-policies', () => {
    test('creates a new policy with tenantId and project scope injected', async () => {
      const res = await createPolicyViaApi();

      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
      expect(res.body.data).toBeDefined();
      expect(res.body.data.tenantId).toBe(ctx.tenantId);
      expect(res.body.data.scope.type).toBe('project');
      expect(res.body.data.scope.projectId).toBe(ctx.projectId);
      expect(res.body.data.name).toBe('safety-policy');
    });

    test('creates draft policies as inactive by default', async () => {
      const res = await createPolicyViaApi();

      expect(res.status).toBe(201);
      expect(res.body.data.status).toBe('draft');
      expect(res.body.data.isActive).toBe(false);
    });

    test('derives activity from status instead of trusting client-supplied isActive', async () => {
      const res = await createPolicyViaApi({
        name: 'draft-client-active',
        status: 'draft',
        isActive: true,
      });

      expect(res.status).toBe(201);
      expect(res.body.data.status).toBe('draft');
      expect(res.body.data.isActive).toBe(false);
    });

    test('returns 400 for missing required fields', async () => {
      const res = await requestJson<ErrorResponse>(harness, policyUrl(), {
        method: 'POST',
        headers: authHeaders(ctx.token),
        body: {},
      });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error?.code).toBe('VALIDATION_ERROR');
    });

    test('returns 409 on duplicate name within same tenant+scope', async () => {
      await createPolicyViaApi({ name: 'unique-policy' });
      const res = await createPolicyViaApi({ name: 'unique-policy' });

      expect(res.status).toBe(409);
      expect(res.body.success).toBe(false);
      expect(res.body.error?.code).toBe('DUPLICATE');
    });

    test('allows the same policy name in different projects within the same tenant', async () => {
      const secondProjectSlug = uniqueSlug('proj-grail-pol-peer');
      const secondProject = await createProject(
        harness,
        ctx.token,
        ctx.tenantId,
        `${secondProjectSlug} Name`,
        secondProjectSlug,
      );

      const first = await createPolicyViaApi({ name: 'shared-name' });
      const second = await requestJson<SuccessResponse<any> & ErrorResponse>(
        harness,
        `/api/projects/${secondProject._id}/guardrail-policies`,
        {
          method: 'POST',
          headers: authHeaders(ctx.token),
          body: {
            ...validCreatePayload,
            name: 'shared-name',
          },
        },
      );

      expect(first.status).toBe(201);
      expect(second.status).toBe(201);
      expect(second.body.data.scope.projectId).toBe(secondProject._id);
    });

    test('allows the same agent-scoped policy name for different agents in the same project', async () => {
      const first = await createPolicyViaApi({
        name: 'shared-agent-policy',
        scopeType: 'agent',
        agentDefId: 'agent-a',
        caching: undefined,
        budget: undefined,
      });
      const second = await createPolicyViaApi({
        name: 'shared-agent-policy',
        scopeType: 'agent',
        agentDefId: 'agent-b',
        caching: undefined,
        budget: undefined,
      });

      expect(first.status).toBe(201);
      expect(second.status).toBe(201);
      expect(second.body.data.scope.agentDefId).toBe('agent-b');
    });

    test('prevents tenantId and scope from being overridden in body', async () => {
      const res = await requestJson<SuccessResponse<any>>(harness, policyUrl(), {
        method: 'POST',
        headers: authHeaders(ctx.token),
        body: {
          ...validCreatePayload,
          tenantId: 'malicious-tenant',
          scope: { type: 'tenant' },
        },
      });

      expect(res.status).toBe(201);
      // tenantId should come from auth context, scope should be project-scoped
      expect(res.body.data.tenantId).toBe(ctx.tenantId);
      expect(res.body.data.scope.type).toBe('project');
      expect(res.body.data.scope.projectId).toBe(ctx.projectId);
    });

    test('rejects unsupported provider credential overrides that runtime cannot consume', async () => {
      const res = await createPolicyViaApi({
        providerOverrides: [
          {
            providerName: 'custom-api',
            apiKeyCredentialId: 'cred-1',
          },
        ],
      });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error?.code).toBe('VALIDATION_ERROR');
    });

    test('preserves provider override defaultCategory across create and get', async () => {
      const create = await createPolicyViaApi({
        providerOverrides: [
          {
            providerName: 'custom-api',
            endpoint: 'https://guardrails.example.com/eval',
            defaultCategory: 'self_harm',
            defaultThreshold: 0.85,
            costPerEvalUsd: 0.25,
            isActive: true,
          },
        ],
      });

      expect(create.status).toBe(201);
      expect(create.body.data.providerOverrides).toEqual([
        expect.objectContaining({
          providerName: 'custom-api',
          defaultCategory: 'self_harm',
          defaultThreshold: 0.85,
        }),
      ]);

      const get = await requestJson<SuccessResponse<any>>(
        harness,
        policyUrl(`/${create.body.data._id}`),
        {
          method: 'GET',
          headers: authHeaders(ctx.token),
        },
      );

      expect(get.status).toBe(200);
      expect(get.body.data.providerOverrides).toEqual([
        expect.objectContaining({
          providerName: 'custom-api',
          defaultCategory: 'self_harm',
          defaultThreshold: 0.85,
        }),
      ]);
    });

    test('rejects out-of-range provider override numeric controls', async () => {
      const threshold = await createPolicyViaApi({
        providerOverrides: [
          {
            providerName: 'custom-api',
            defaultThreshold: 2,
          },
        ],
      });
      const cost = await createPolicyViaApi({
        name: 'negative-cost-policy',
        providerOverrides: [
          {
            providerName: 'custom-api',
            costPerEvalUsd: -0.01,
          },
        ],
      });

      expect(threshold.status).toBe(400);
      expect(threshold.body.success).toBe(false);
      expect(threshold.body.error?.code).toBe('VALIDATION_ERROR');
      expect(cost.status).toBe(400);
      expect(cost.body.success).toBe(false);
      expect(cost.body.error?.code).toBe('VALIDATION_ERROR');
    });

    test('rejects out-of-range rule thresholds', async () => {
      const res = await createPolicyViaApi({
        rules: [
          {
            guardrailName: 'content_safety',
            override: 'threshold',
            threshold: 1.1,
          },
        ],
      });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error?.code).toBe('VALIDATION_ERROR');
    });

    test('rejects semantic caching until a semantic cache implementation exists', async () => {
      const res = await createPolicyViaApi({
        caching: {
          ...validCreatePayload.caching,
          enabled: true,
          semanticMatch: true,
        },
      });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error?.code).toBe('VALIDATION_ERROR');
    });

    test('rejects non-positive policy timing controls on create', async () => {
      const res = await createPolicyViaApi({
        settings: {
          ...validCreatePayload.settings,
          timeouts: {
            ...validCreatePayload.settings.timeouts,
            local: 0,
          },
        },
      });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error?.code).toBe('VALIDATION_ERROR');
    });

    test('rejects incomplete webhook configuration', async () => {
      const res = await createPolicyViaApi({
        settings: {
          ...validCreatePayload.settings,
          webhookUrl: 'https://hooks.example.com/guardrails',
        },
      });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error?.code).toBe('VALIDATION_ERROR');
    });

    test('rejects operational controls on agent-scoped policy creates', async () => {
      const res = await createPolicyViaApi({
        name: 'agent-operational-controls',
        scopeType: 'agent',
        agentDefId: 'agent-a',
        caching: validCreatePayload.caching,
        budget: validCreatePayload.budget,
        settings: {
          ...validCreatePayload.settings,
          webhookUrl: 'https://hooks.example.com/guardrails',
          webhookSecret: 'whsec_test',
        },
      });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error?.code).toBe('VALIDATION_ERROR');
    });

    test('rejects operational controls on tenant-scoped policy creates', async () => {
      const res = await createTenantPolicyViaApi({
        name: 'tenant-operational-controls',
        caching: validCreatePayload.caching,
        budget: validCreatePayload.budget,
        settings: {
          ...validCreatePayload.settings,
          webhookUrl: 'https://hooks.example.com/guardrails',
          webhookSecret: 'whsec_test',
        },
      });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error?.code).toBe('VALIDATION_ERROR');
    });

    test('creating an active policy deactivates the previous active sibling', async () => {
      const first = await createPolicyViaApi({ name: 'first-active', status: 'active' });
      const second = await createPolicyViaApi({ name: 'second-active', status: 'active' });

      expect(first.status).toBe(201);
      expect(second.status).toBe(201);
      expect(second.body.data.status).toBe('active');
      expect(second.body.data.isActive).toBe(true);

      const refreshedFirst = await requestJson<SuccessResponse<any>>(
        harness,
        policyUrl(`/${first.body.data._id}`),
        {
          method: 'GET',
          headers: authHeaders(ctx.token),
        },
      );

      expect(refreshedFirst.status).toBe(200);
      expect(refreshedFirst.body.data.status).toBe('draft');
      expect(refreshedFirst.body.data.isActive).toBe(false);
    });

    test('creating an active agent policy keeps the active project baseline intact', async () => {
      const baseline = await createPolicyViaApi({ name: 'project-baseline', status: 'active' });
      const agentOverride = await createPolicyViaApi({
        name: 'agent-override',
        status: 'active',
        scopeType: 'agent',
        agentDefId: 'agent-a',
        caching: undefined,
        budget: undefined,
      });

      expect(baseline.status).toBe(201);
      expect(agentOverride.status).toBe(201);
      expect(agentOverride.body.data.scope.type).toBe('agent');
      expect(agentOverride.body.data.isActive).toBe(true);

      const refreshedBaseline = await requestJson<SuccessResponse<any>>(
        harness,
        policyUrl(`/${baseline.body.data._id}`),
        {
          method: 'GET',
          headers: authHeaders(ctx.token),
        },
      );

      expect(refreshedBaseline.status).toBe(200);
      expect(refreshedBaseline.body.data.status).toBe('active');
      expect(refreshedBaseline.body.data.isActive).toBe(true);
    });
  });

  // =============================================================================
  // GET BY ID — GET /:id
  // =============================================================================

  describe('GET /api/projects/:projectId/guardrail-policies/:id', () => {
    test('returns policy by id with tenant+project isolation', async () => {
      const created = await createPolicyViaApi();
      const policyId = created.body.data._id;

      const res = await requestJson<SuccessResponse<any>>(harness, policyUrl(`/${policyId}`), {
        method: 'GET',
        headers: authHeaders(ctx.token),
      });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data._id).toBe(policyId);
    });

    test('returns 404 for non-existent policy', async () => {
      const res = await requestJson<ErrorResponse>(harness, policyUrl('/nonexistent-id'), {
        method: 'GET',
        headers: authHeaders(ctx.token),
      });

      expect(res.status).toBe(404);
      expect(res.body.success).toBe(false);
      expect(res.body.error?.code).toBe('NOT_FOUND');
    });

    test('returns 404 for policy from another project (project isolation)', async () => {
      // Insert a policy directly for a different project
      const foreignPolicy = await GuardrailPolicy.create({
        tenantId: ctx.tenantId,
        name: 'foreign-policy',
        scope: { type: 'project', projectId: 'another-project' },
        settings: validCreatePayload.settings,
        caching: validCreatePayload.caching,
        budget: validCreatePayload.budget,
      });

      const res = await requestJson<ErrorResponse>(harness, policyUrl(`/${foreignPolicy._id}`), {
        method: 'GET',
        headers: authHeaders(ctx.token),
      });

      expect(res.status).toBe(404);
      expect(res.body.success).toBe(false);
    });

    test('normalizes legacy draft policies with isActive=true as inactive in the response', async () => {
      const legacy = await GuardrailPolicy.create({
        tenantId: ctx.tenantId,
        name: 'legacy-draft',
        isActive: true,
        status: 'draft',
        scope: { type: 'project', projectId: ctx.projectId },
        rules: [],
        settings: validCreatePayload.settings,
        caching: validCreatePayload.caching,
        budget: validCreatePayload.budget,
      });

      const res = await requestJson<SuccessResponse<any>>(harness, policyUrl(`/${legacy._id}`), {
        method: 'GET',
        headers: authHeaders(ctx.token),
      });

      expect(res.status).toBe(200);
      expect(res.body.data.status).toBe('draft');
      expect(res.body.data.isActive).toBe(false);
    });

    test('returns live project budget spend instead of stale persisted currentSpendUsd', async () => {
      const policy = await GuardrailPolicy.create({
        tenantId: ctx.tenantId,
        name: 'stale-budget-policy',
        status: 'active',
        isActive: true,
        scope: { type: 'project', projectId: ctx.projectId },
        rules: [],
        settings: validCreatePayload.settings,
        caching: validCreatePayload.caching,
        budget: {
          monthlyLimitUsd: 100,
          currentSpendUsd: 77,
          overspendAction: 'alert_only',
        },
      });

      const res = await requestJson<SuccessResponse<any>>(harness, policyUrl(`/${policy._id}`), {
        method: 'GET',
        headers: authHeaders(ctx.token),
      });

      expect(res.status).toBe(200);
      expect(res.body.data.budget.monthlyLimitUsd).toBe(100);
      expect(res.body.data.budget.currentSpendUsd).toBe(0);
    });
  });

  // =============================================================================
  // UPDATE — PUT /:id
  // =============================================================================

  describe('PUT /api/projects/:projectId/guardrail-policies/:id', () => {
    test('updates policy with tenant+project isolation', async () => {
      const created = await createPolicyViaApi();
      const policyId = created.body.data._id;

      const res = await requestJson<SuccessResponse<any>>(harness, policyUrl(`/${policyId}`), {
        method: 'PUT',
        headers: authHeaders(ctx.token),
        body: { name: 'updated-name' },
      });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.name).toBe('updated-name');
    });

    test('returns 404 for non-existent policy', async () => {
      const res = await requestJson<ErrorResponse>(harness, policyUrl('/nonexistent-id'), {
        method: 'PUT',
        headers: authHeaders(ctx.token),
        body: { name: 'updated' },
      });

      expect(res.status).toBe(404);
      expect(res.body.success).toBe(false);
    });

    test('prevents tenantId and scope from being overridden in body', async () => {
      const created = await createPolicyViaApi();
      const policyId = created.body.data._id;

      const res = await requestJson<SuccessResponse<any>>(harness, policyUrl(`/${policyId}`), {
        method: 'PUT',
        headers: authHeaders(ctx.token),
        body: {
          tenantId: 'malicious-tenant',
          scope: { type: 'tenant' },
          name: 'ok-name',
        },
      });

      expect(res.status).toBe(200);
      // Verify the update didn't change tenantId or scope
      expect(res.body.data.tenantId).toBe(ctx.tenantId);
      expect(res.body.data.scope.type).toBe('project');
      expect(res.body.data.scope.projectId).toBe(ctx.projectId);
    });

    test('moving a policy back to draft clears isActive even when the client sends true', async () => {
      const created = await createPolicyViaApi({ name: 'active-then-draft', status: 'active' });
      const policyId = created.body.data._id;

      const res = await requestJson<SuccessResponse<any>>(harness, policyUrl(`/${policyId}`), {
        method: 'PUT',
        headers: authHeaders(ctx.token),
        body: {
          status: 'draft',
          isActive: true,
        },
      });

      expect(res.status).toBe(200);
      expect(res.body.data.status).toBe('draft');
      expect(res.body.data.isActive).toBe(false);
    });

    test('updating a policy to active deactivates the previous active sibling', async () => {
      const first = await createPolicyViaApi({ name: 'existing-active', status: 'active' });
      const second = await createPolicyViaApi({ name: 'draft-policy', status: 'draft' });

      const update = await requestJson<SuccessResponse<any>>(
        harness,
        policyUrl(`/${second.body.data._id}`),
        {
          method: 'PUT',
          headers: authHeaders(ctx.token),
          body: { status: 'active' },
        },
      );

      expect(update.status).toBe(200);
      expect(update.body.data.status).toBe('active');
      expect(update.body.data.isActive).toBe(true);

      const refreshedFirst = await requestJson<SuccessResponse<any>>(
        harness,
        policyUrl(`/${first.body.data._id}`),
        {
          method: 'GET',
          headers: authHeaders(ctx.token),
        },
      );

      expect(refreshedFirst.status).toBe(200);
      expect(refreshedFirst.body.data.status).toBe('draft');
      expect(refreshedFirst.body.data.isActive).toBe(false);
    });

    test('partial settings updates merge nested fields instead of replacing them', async () => {
      const created = await createPolicyViaApi({
        name: 'settings-merge-policy',
        settings: {
          failMode: 'closed',
          timeouts: { local: 11, model: 22, llm: 33 },
          streaming: {
            enabled: true,
            defaultInterval: 'chunk_size',
            chunkSize: 64,
            maxLatencyMs: 777,
            earlyTermination: false,
          },
        },
      });

      const update = await requestJson<SuccessResponse<any>>(
        harness,
        policyUrl(`/${created.body.data._id}`),
        {
          method: 'PUT',
          headers: authHeaders(ctx.token),
          body: {
            settings: {
              failMode: 'open',
            },
          },
        },
      );

      expect(update.status).toBe(200);
      expect(update.body.data.settings.failMode).toBe('open');
      expect(update.body.data.settings.timeouts).toEqual({ local: 11, model: 22, llm: 33 });
      expect(update.body.data.settings.streaming).toEqual({
        enabled: true,
        defaultInterval: 'chunk_size',
        chunkSize: 64,
        maxLatencyMs: 777,
        earlyTermination: false,
      });
    });

    test('partial caching updates preserve unspecified fields', async () => {
      const created = await createPolicyViaApi({
        name: 'caching-merge-policy',
        caching: {
          enabled: true,
          exactMatch: false,
          semanticMatch: false,
          semanticThreshold: 0.91,
          defaultTtlSeconds: 123,
        },
      });

      const update = await requestJson<SuccessResponse<any>>(
        harness,
        policyUrl(`/${created.body.data._id}`),
        {
          method: 'PUT',
          headers: authHeaders(ctx.token),
          body: {
            caching: {
              enabled: false,
            },
          },
        },
      );

      expect(update.status).toBe(200);
      expect(update.body.data.caching).toEqual({
        enabled: false,
        exactMatch: false,
        semanticMatch: false,
        semanticThreshold: 0.91,
        defaultTtlSeconds: 123,
      });
    });

    test('partial budget updates preserve overspend policy and ignore client currentSpendUsd', async () => {
      const created = await createPolicyViaApi({
        name: 'budget-merge-policy',
        budget: {
          monthlyLimitUsd: 100,
          currentSpendUsd: 0,
          overspendAction: 'disable_model_checks',
        },
      });

      const update = await requestJson<SuccessResponse<any>>(
        harness,
        policyUrl(`/${created.body.data._id}`),
        {
          method: 'PUT',
          headers: authHeaders(ctx.token),
          body: {
            budget: {
              monthlyLimitUsd: 25,
              currentSpendUsd: 9999,
            },
          },
        },
      );

      expect(update.status).toBe(200);
      expect(update.body.data.budget).toEqual({
        monthlyLimitUsd: 25,
        currentSpendUsd: 0,
        overspendAction: 'disable_model_checks',
      });
    });

    test('rejects non-positive budget limits on update', async () => {
      const created = await createPolicyViaApi({ name: 'bad-budget-update' });

      const update = await requestJson<SuccessResponse<any> & ErrorResponse>(
        harness,
        policyUrl(`/${created.body.data._id}`),
        {
          method: 'PUT',
          headers: authHeaders(ctx.token),
          body: {
            budget: {
              monthlyLimitUsd: 0,
            },
          },
        },
      );

      expect(update.status).toBe(400);
      expect(update.body.success).toBe(false);
      expect(update.body.error?.code).toBe('VALIDATION_ERROR');
    });

    test('rejects operational controls when updating an agent-scoped policy', async () => {
      const created = await createPolicyViaApi({
        name: 'agent-update-operational-controls',
        scopeType: 'agent',
        agentDefId: 'agent-a',
        caching: undefined,
        budget: undefined,
      });

      const update = await requestJson<SuccessResponse<any> & ErrorResponse>(
        harness,
        policyUrl(`/${created.body.data._id}`),
        {
          method: 'PUT',
          headers: authHeaders(ctx.token),
          body: {
            budget: validCreatePayload.budget,
            settings: {
              ...validCreatePayload.settings,
              webhookUrl: 'https://hooks.example.com/guardrails',
              webhookSecret: 'whsec_test',
            },
          },
        },
      );

      expect(update.status).toBe(400);
      expect(update.body.success).toBe(false);
      expect(update.body.error?.code).toBe('VALIDATION_ERROR');
    });
  });

  // =============================================================================
  // ACTIVATE — POST /:id/activate
  // =============================================================================

  describe('POST /api/projects/:projectId/guardrail-policies/:id/activate', () => {
    test('activates policy and deactivates others in the same project', async () => {
      // Create two policies
      const first = await createPolicyViaApi({ name: 'first-policy' });
      const second = await createPolicyViaApi({ name: 'second-policy' });

      // Activate the first one
      const activateFirst = await requestJson<SuccessResponse<any>>(
        harness,
        policyUrl(`/${first.body.data._id}/activate`),
        {
          method: 'POST',
          headers: authHeaders(ctx.token),
        },
      );

      expect(activateFirst.status).toBe(200);
      expect(activateFirst.body.data.status).toBe('active');
      expect(activateFirst.body.data.isActive).toBe(true);

      // Now activate the second one
      const activateSecond = await requestJson<SuccessResponse<any>>(
        harness,
        policyUrl(`/${second.body.data._id}/activate`),
        {
          method: 'POST',
          headers: authHeaders(ctx.token),
        },
      );

      expect(activateSecond.status).toBe(200);
      expect(activateSecond.body.data.status).toBe('active');

      // Verify the first one is now deactivated
      const firstRefresh = await requestJson<SuccessResponse<any>>(
        harness,
        policyUrl(`/${first.body.data._id}`),
        {
          method: 'GET',
          headers: authHeaders(ctx.token),
        },
      );

      expect(firstRefresh.body.data.status).toBe('draft');
      expect(firstRefresh.body.data.isActive).toBe(false);
    });

    test('activating an agent policy only deactivates active siblings for that same agent', async () => {
      const agentAFirst = await createPolicyViaApi({
        name: 'agent-a-first',
        status: 'active',
        scopeType: 'agent',
        agentDefId: 'agent-a',
        caching: undefined,
        budget: undefined,
      });
      const agentBActive = await createPolicyViaApi({
        name: 'agent-b-active',
        status: 'active',
        scopeType: 'agent',
        agentDefId: 'agent-b',
        caching: undefined,
        budget: undefined,
      });
      const agentASecond = await createPolicyViaApi({
        name: 'agent-a-second',
        scopeType: 'agent',
        agentDefId: 'agent-a',
        caching: undefined,
        budget: undefined,
      });

      const activateAgentASecond = await requestJson<SuccessResponse<any>>(
        harness,
        policyUrl(`/${agentASecond.body.data._id}/activate`),
        {
          method: 'POST',
          headers: authHeaders(ctx.token),
        },
      );

      expect(activateAgentASecond.status).toBe(200);
      expect(activateAgentASecond.body.data.status).toBe('active');
      expect(activateAgentASecond.body.data.scope.agentDefId).toBe('agent-a');

      const refreshedAgentAFirst = await requestJson<SuccessResponse<any>>(
        harness,
        policyUrl(`/${agentAFirst.body.data._id}`),
        {
          method: 'GET',
          headers: authHeaders(ctx.token),
        },
      );
      const refreshedAgentB = await requestJson<SuccessResponse<any>>(
        harness,
        policyUrl(`/${agentBActive.body.data._id}`),
        {
          method: 'GET',
          headers: authHeaders(ctx.token),
        },
      );

      expect(refreshedAgentAFirst.body.data.status).toBe('draft');
      expect(refreshedAgentAFirst.body.data.isActive).toBe(false);
      expect(refreshedAgentB.body.data.status).toBe('active');
      expect(refreshedAgentB.body.data.isActive).toBe(true);
    });

    test('returns 404 if policy does not exist', async () => {
      const res = await requestJson<ErrorResponse>(harness, policyUrl('/nonexistent-id/activate'), {
        method: 'POST',
        headers: authHeaders(ctx.token),
      });

      expect(res.status).toBe(404);
      expect(res.body.success).toBe(false);
      expect(res.body.error?.code).toBe('NOT_FOUND');
    });

    test('activation cleans up legacy draft siblings that still have isActive=true', async () => {
      const legacy = await GuardrailPolicy.create({
        tenantId: ctx.tenantId,
        name: 'legacy-stale-active',
        isActive: true,
        status: 'draft',
        scope: { type: 'project', projectId: ctx.projectId },
        rules: [],
        settings: validCreatePayload.settings,
        caching: validCreatePayload.caching,
        budget: validCreatePayload.budget,
      });
      const target = await createPolicyViaApi({ name: 'activation-target' });

      const activate = await requestJson<SuccessResponse<any>>(
        harness,
        policyUrl(`/${target.body.data._id}/activate`),
        {
          method: 'POST',
          headers: authHeaders(ctx.token),
        },
      );

      expect(activate.status).toBe(200);

      const refreshedLegacy = await GuardrailPolicy.findOne({
        _id: legacy._id,
        tenantId: ctx.tenantId,
      }).lean();
      expect(refreshedLegacy?.status).toBe('draft');
      expect(refreshedLegacy?.isActive).toBe(false);
    });
  });

  // =============================================================================
  // DELETE — DELETE /:id
  // =============================================================================

  describe('DELETE /api/projects/:projectId/guardrail-policies/:id', () => {
    test('deletes policy with tenant+project isolation', async () => {
      const created = await createPolicyViaApi();
      const policyId = created.body.data._id;

      const res = await requestJson<SuccessResponse<{ id: string }>>(
        harness,
        policyUrl(`/${policyId}`),
        {
          method: 'DELETE',
          headers: authHeaders(ctx.token),
        },
      );

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.id).toBe(policyId);

      // Verify it is really gone
      const verify = await requestJson<ErrorResponse>(harness, policyUrl(`/${policyId}`), {
        method: 'GET',
        headers: authHeaders(ctx.token),
      });
      expect(verify.status).toBe(404);
    });

    test('returns 404 for non-existent policy', async () => {
      const res = await requestJson<ErrorResponse>(harness, policyUrl('/nonexistent-id'), {
        method: 'DELETE',
        headers: authHeaders(ctx.token),
      });

      expect(res.status).toBe(404);
      expect(res.body.success).toBe(false);
    });
  });

  // =============================================================================
  // FIELD PERSISTENCE & SCOPE ROUTING — regression locks for data-flow bugs
  // =============================================================================

  describe('Field persistence and scope routing', () => {
    test('description is stored and returned via the API (Bug 3)', async () => {
      const res = await createPolicyViaApi({ description: 'a human-readable description' });

      expect(res.status).toBe(201);
      expect(res.body.data.description).toBe('a human-readable description');

      // Verify it persists on GET
      const fetched = await requestJson<SuccessResponse<any>>(
        harness,
        policyUrl(`/${res.body.data._id}`),
        { method: 'GET', headers: authHeaders(ctx.token) },
      );
      expect(fetched.body.data.description).toBe('a human-readable description');
    });

    test('scopeType=agent + agentDefId creates an agent-scoped policy (Bug 1)', async () => {
      const res = await createPolicyViaApi({
        name: 'agent-scoped-policy',
        scopeType: 'agent',
        agentDefId: 'agent-def-abc',
        caching: undefined,
        budget: undefined,
      });

      expect(res.status).toBe(201);
      expect(res.body.data.scope.type).toBe('agent');
      expect(res.body.data.scope.agentDefId).toBe('agent-def-abc');
      expect(res.body.data.scope.projectId).toBe(ctx.projectId);
    });

    test('scopeType=agent without agentDefId returns 400 (Bug 1 validation)', async () => {
      const res = await createPolicyViaApi({
        name: 'bad-agent-scope',
        scopeType: 'agent',
        caching: undefined,
        budget: undefined,
      });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
    });

    test('malformed define rules without an executable check are dropped before persistence', async () => {
      const res = await createPolicyViaApi({
        name: 'define-rule-policy',
        rules: [
          {
            guardrailName: 'pii_detector',
            override: 'define',
            kind: 'input',
            threshold: 0.8,
          },
        ],
      });

      expect(res.status).toBe(201);
      expect(res.body.data.rules).toEqual([]);
    });

    test('form kind:both expansion — two separate rules (input + output) are stored (Bug 4)', async () => {
      // The Studio form expands kind:'both' into two rules before POSTing.
      // This test locks that both rules survive the round-trip.
      const res = await createPolicyViaApi({
        name: 'both-kind-policy',
        rules: [
          { guardrailName: 'toxicity', override: 'threshold', kind: 'input', threshold: 0.7 },
          { guardrailName: 'toxicity', override: 'threshold', kind: 'output', threshold: 0.7 },
        ],
      });

      expect(res.status).toBe(201);
      expect(res.body.data.rules).toHaveLength(2);
      const kinds = res.body.data.rules.map((r: { kind: string }) => r.kind).sort();
      expect(kinds).toEqual(['input', 'output']);
    });
  });

  // =============================================================================
  // TENANT + PROJECT ISOLATION — Cross-cutting concerns
  // =============================================================================

  describe('Tenant + Project Isolation', () => {
    test('all queries are scoped to the authenticated tenant and project', async () => {
      // Create a policy via API (ensures correct tenant/project)
      const created = await createPolicyViaApi({ name: 'isolation-test' });
      const policyId = created.body.data._id;
      expect(created.body.data.tenantId).toBe(ctx.tenantId);
      expect(created.body.data.scope.projectId).toBe(ctx.projectId);

      // LIST — only returns policies for this project
      const list = await requestJson<SuccessResponse<any[]>>(harness, policyUrl(), {
        method: 'GET',
        headers: authHeaders(ctx.token),
      });
      expect(list.body.data).toHaveLength(1);
      expect(list.body.data[0].tenantId).toBe(ctx.tenantId);

      // GET by ID — returns the correct policy
      const get = await requestJson<SuccessResponse<any>>(harness, policyUrl(`/${policyId}`), {
        method: 'GET',
        headers: authHeaders(ctx.token),
      });
      expect(get.body.data.tenantId).toBe(ctx.tenantId);
      expect(get.body.data.scope.projectId).toBe(ctx.projectId);

      // UPDATE — scoped to tenant+project
      const update = await requestJson<SuccessResponse<any>>(harness, policyUrl(`/${policyId}`), {
        method: 'PUT',
        headers: authHeaders(ctx.token),
        body: { name: 'isolation-updated' },
      });
      expect(update.body.data.tenantId).toBe(ctx.tenantId);
      expect(update.body.data.scope.projectId).toBe(ctx.projectId);
    });
  });
});
