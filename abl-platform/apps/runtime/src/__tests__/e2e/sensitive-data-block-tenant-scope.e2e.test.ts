/**
 * E2E-9 — Tenant-scoped policy inheritance with Sensitive Data Block (User Story #5)
 *
 * Proves that:
 *   1. A tenant-scoped SDB policy can be created via the top-level
 *      `/api/guardrail-policies` mount.
 *   2. The tenant-scoped policy can be activated via POST /:id/activate.
 *   3. The GuardrailPolicyResolver correctly merges tenant-scoped rules
 *      into a project context (projects inherit tenant-scoped guardrails).
 *   4. A project-scoped SDB policy with different entities coexists —
 *      project rules override tenant rules for same guardrailName, while
 *      differently-named rules merge additively.
 *   5. Tenant-scoped policy lifecycle (activate, PUT, reactivate) all work
 *      via the top-level mount.
 *
 * Zero vi.mock calls. HTTP-only via RuntimeApiHarness. Real MongoMemoryServer.
 */

import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import authRouter from '../../routes/auth.js';
import platformAdminTenantsRouter from '../../routes/platform-admin-tenants.js';
import guardrailPolicyRouter from '../../routes/guardrail-policies.js';
import { startRuntimeApiHarness, type RuntimeApiHarness } from '../helpers/runtime-api-harness.js';
import {
  authHeaders,
  bootstrapProject,
  requestJson,
  uniqueEmail,
  uniqueSlug,
  type BootstrapProjectResult,
} from '../helpers/channel-e2e-bootstrap.js';
import { GuardrailPolicyResolver } from '../../services/guardrails/policy-resolver.js';
import type { PolicyData as ResolverPolicyData } from '../../services/guardrails/policy-resolver.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface PolicyData {
  _id: string;
  name: string;
  isActive: boolean;
  status: string;
  scope: { type: string; projectId?: string };
  rules: Array<{
    guardrailName: string;
    enabled?: boolean;
    entities?: string[];
    presetKey?: string;
    actionMessage?: string;
    [key: string]: unknown;
  }>;
  settings: Record<string, unknown>;
  [key: string]: unknown;
}

interface SuccessResponse {
  success: boolean;
  data: PolicyData;
}

interface ListResponse {
  success: boolean;
  data: PolicyData[];
}

interface ErrorResponse {
  success: boolean;
  error?: { code: string; message: string };
}

// ---------------------------------------------------------------------------
// Shared harness
// ---------------------------------------------------------------------------

let harness: RuntimeApiHarness;
let ctx: BootstrapProjectResult;

const BASE_SETTINGS = {
  failMode: 'open' as const,
  timeouts: { local: 100, model: 3000, llm: 10000 },
  streaming: {
    enabled: false,
    defaultInterval: 'sentence' as const,
    chunkSize: 1,
    maxLatencyMs: 500,
    earlyTermination: true,
  },
};

/** Tenant-scoped SDB rule targeting SSN entities. */
function tenantSdbRule(): Record<string, unknown> {
  return {
    guardrailName: 'sdb_tenant_ssn',
    override: 'define',
    kind: 'input',
    provider: 'builtin_pii',
    category: 'pii',
    threshold: 0.8,
    action: 'block',
    enabled: true,
    presetKey: 'sensitive_data_block',
    entities: ['ssn'],
    actionMessage: 'Tenant policy: SSN blocked.',
  };
}

/** Project-scoped SDB rule targeting email entities (different from tenant). */
function projectSdbRule(): Record<string, unknown> {
  return {
    guardrailName: 'sdb_project_email',
    override: 'define',
    kind: 'input',
    provider: 'builtin_pii',
    category: 'pii',
    threshold: 0.7,
    action: 'block',
    enabled: true,
    presetKey: 'sensitive_data_block',
    entities: ['email'],
    actionMessage: 'Project policy: email blocked.',
  };
}

function tenantPolicyUrl(suffix = ''): string {
  return `/api/guardrail-policies${suffix}`;
}

function projectPolicyUrl(suffix = ''): string {
  return `/api/projects/${ctx.projectId}/guardrail-policies${suffix}`;
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeAll(async () => {
  harness = await startRuntimeApiHarness((app) => {
    app.use('/api/auth', authRouter);
    app.use('/api/platform/admin/tenants', platformAdminTenantsRouter);
    // Tenant-scoped mount (no :projectId)
    app.use('/api/guardrail-policies', guardrailPolicyRouter);
    // Project-scoped mount
    app.use('/api/projects/:projectId/guardrail-policies', guardrailPolicyRouter);
  });

  ctx = await bootstrapProject(
    harness,
    uniqueEmail('sdb-tenant-scope-admin'),
    uniqueSlug('sdb-tenant-scope'),
    uniqueSlug('sdb-tenant-scope-proj'),
  );
}, 120_000);

afterAll(async () => {
  await harness.close();
}, 30_000);

// =============================================================================
// E2E-9 — Tenant-scoped SDB policy creation, activation, inheritance
// =============================================================================

describe('E2E-9 — Tenant-scoped policy inheritance with SDB', () => {
  let tenantPolicyId: string;

  // ─── Step 1-2: Create + activate a tenant-scoped SDB policy ──────────────

  test('step 1: create tenant-scoped SDB policy via top-level mount', async () => {
    const res = await requestJson<SuccessResponse>(harness, tenantPolicyUrl(), {
      method: 'POST',
      headers: authHeaders(ctx.token),
      body: {
        name: 'tenant-sdb-policy',
        scopeType: 'tenant',
        rules: [tenantSdbRule()],
        settings: BASE_SETTINGS,
      },
    });

    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.data.scope.type).toBe('tenant');
    expect(res.body.data.rules).toHaveLength(1);
    expect(res.body.data.rules[0].entities).toEqual(['ssn']);
    expect(res.body.data.rules[0].presetKey).toBe('sensitive_data_block');

    tenantPolicyId = res.body.data._id;
  });

  test('step 2: activate tenant-scoped SDB policy', async () => {
    const res = await requestJson<SuccessResponse>(
      harness,
      tenantPolicyUrl(`/${tenantPolicyId}/activate`),
      {
        method: 'POST',
        headers: authHeaders(ctx.token),
      },
    );

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.isActive).toBe(true);
    expect(res.body.data.status).toBe('active');
  });

  // ─── Step 3: Verify resolver merges tenant-scoped rules into project ────

  test('step 3: GuardrailPolicyResolver inherits tenant policy into project context', async () => {
    // GET the tenant policy back to build resolver input
    const getRes = await requestJson<SuccessResponse>(
      harness,
      tenantPolicyUrl(`/${tenantPolicyId}`),
      {
        method: 'GET',
        headers: authHeaders(ctx.token),
      },
    );
    expect(getRes.status).toBe(200);

    const tenantPolicy = getRes.body.data;
    const resolver = new GuardrailPolicyResolver();

    // Simulate what the runtime does: provide tenant policies, no project policies
    const resolved = resolver.resolve({
      tenantId: ctx.tenantId,
      projectId: ctx.projectId,
      agentDefId: 'test-agent',
      agentGuardrails: [],
      tenantPolicies: [
        {
          name: tenantPolicy.name,
          rules: tenantPolicy.rules.map((r) => ({
            guardrailName: r.guardrailName,
            override: (r as Record<string, unknown>).override as string,
            kind: (r as Record<string, unknown>).kind as
              | 'input'
              | 'output'
              | 'tool_input'
              | 'tool_output'
              | 'handoff'
              | undefined,
            provider: (r as Record<string, unknown>).provider as string | undefined,
            category: (r as Record<string, unknown>).category as string | undefined,
            threshold: (r as Record<string, unknown>).threshold as number | undefined,
            enabled: r.enabled,
            entities: r.entities,
            presetKey: r.presetKey,
            actionMessage: r.actionMessage,
          })),
          settings: tenantPolicy.settings as ResolverPolicyData['settings'],
        },
      ],
      projectPolicies: [],
    });

    // The tenant SDB rule should be synthesized into a guardrail
    expect(resolved.guardrails).toHaveLength(1);
    expect(resolved.guardrails[0].name).toBe('sdb_tenant_ssn');
    expect(resolved.guardrails[0].entities).toEqual(['ssn']);
    expect(resolved.guardrails[0].presetKey).toBe('sensitive_data_block');
  });

  // ─── Step 4: Add a project-scoped SDB policy with different entities ─────

  test('step 4: project-scoped SDB policy coexists with tenant policy', async () => {
    // Create a project-scoped SDB policy with different guardrailName + entities
    const createRes = await requestJson<SuccessResponse>(harness, projectPolicyUrl(), {
      method: 'POST',
      headers: authHeaders(ctx.token),
      body: {
        name: 'project-sdb-policy',
        rules: [projectSdbRule()],
        settings: BASE_SETTINGS,
      },
    });

    expect(createRes.status).toBe(201);
    expect(createRes.body.data.scope.type).toBe('project');

    // Activate it
    const activateRes = await requestJson<SuccessResponse>(
      harness,
      projectPolicyUrl(`/${createRes.body.data._id}/activate`),
      {
        method: 'POST',
        headers: authHeaders(ctx.token),
      },
    );
    expect(activateRes.status).toBe(200);

    // Verify resolver merges both tenant + project policies
    const resolver = new GuardrailPolicyResolver();
    const resolved = resolver.resolve({
      tenantId: ctx.tenantId,
      projectId: ctx.projectId,
      agentDefId: 'test-agent',
      agentGuardrails: [],
      tenantPolicies: [
        {
          name: 'tenant-sdb-policy',
          rules: [
            {
              guardrailName: 'sdb_tenant_ssn',
              override: 'define' as const,
              kind: 'input' as const,
              provider: 'builtin_pii',
              category: 'pii',
              threshold: 0.8,
              enabled: true,
              entities: ['ssn'],
              presetKey: 'sensitive_data_block',
              actionMessage: 'Tenant policy: SSN blocked.',
            },
          ],
          settings: { failMode: 'open' as const },
        },
      ],
      projectPolicies: [
        {
          name: 'project-sdb-policy',
          rules: [
            {
              guardrailName: 'sdb_project_email',
              override: 'define' as const,
              kind: 'input' as const,
              provider: 'builtin_pii',
              category: 'pii',
              threshold: 0.7,
              enabled: true,
              entities: ['email'],
              presetKey: 'sensitive_data_block',
              actionMessage: 'Project policy: email blocked.',
            },
          ],
          settings: { failMode: 'open' as const },
        },
      ],
    });

    // Both rules have different guardrailNames so they merge additively
    expect(resolved.guardrails).toHaveLength(2);
    const names = resolved.guardrails.map((g) => g.name).sort();
    expect(names).toEqual(['sdb_project_email', 'sdb_tenant_ssn']);

    const ssnGuardrail = resolved.guardrails.find((g) => g.name === 'sdb_tenant_ssn');
    const emailGuardrail = resolved.guardrails.find((g) => g.name === 'sdb_project_email');
    expect(ssnGuardrail?.entities).toEqual(['ssn']);
    expect(emailGuardrail?.entities).toEqual(['email']);
  });

  // ─── Step 5: Project policy overrides tenant for same guardrailName ──────

  test('step 5: project SDB rule overrides tenant rule for same guardrailName', async () => {
    const resolver = new GuardrailPolicyResolver();
    const resolved = resolver.resolve({
      tenantId: ctx.tenantId,
      projectId: ctx.projectId,
      agentDefId: 'test-agent',
      agentGuardrails: [],
      tenantPolicies: [
        {
          name: 'tenant-sdb-policy',
          rules: [
            {
              guardrailName: 'sdb_shared_name',
              override: 'define' as const,
              kind: 'input' as const,
              provider: 'builtin_pii',
              category: 'pii',
              threshold: 0.8,
              enabled: true,
              entities: ['ssn'],
              presetKey: 'sensitive_data_block',
              actionMessage: 'Tenant: SSN',
            },
          ],
          settings: { failMode: 'open' as const },
        },
      ],
      projectPolicies: [
        {
          name: 'project-sdb-policy',
          rules: [
            {
              guardrailName: 'sdb_shared_name',
              override: 'define' as const,
              kind: 'input' as const,
              provider: 'builtin_pii',
              category: 'pii',
              threshold: 0.6,
              enabled: true,
              entities: ['email', 'phone'],
              presetKey: 'sensitive_data_block',
              actionMessage: 'Project: email+phone',
            },
          ],
          settings: { failMode: 'open' as const },
        },
      ],
    });

    // Same guardrailName → project replaces tenant's synthetic guardrail
    expect(resolved.guardrails).toHaveLength(1);
    expect(resolved.guardrails[0].name).toBe('sdb_shared_name');
    expect(resolved.guardrails[0].entities).toEqual(['email', 'phone']);
    expect(resolved.guardrails[0].threshold).toBe(0.6);
  });

  // ─── Step 6: Tenant-scoped policy lifecycle (PUT + reactivate) ──────────

  test('step 6a: PUT tenant-scoped policy updates rules', async () => {
    const res = await requestJson<SuccessResponse>(harness, tenantPolicyUrl(`/${tenantPolicyId}`), {
      method: 'PUT',
      headers: authHeaders(ctx.token),
      body: {
        name: 'tenant-sdb-policy-updated',
        rules: [
          {
            ...tenantSdbRule(),
            entities: ['ssn', 'credit_card'],
            actionMessage: 'Updated: SSN + CC blocked.',
          },
        ],
        settings: BASE_SETTINGS,
        status: 'active',
      },
    });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.name).toBe('tenant-sdb-policy-updated');
    expect(res.body.data.rules[0].entities).toEqual(['ssn', 'credit_card']);
    expect(res.body.data.rules[0].actionMessage).toBe('Updated: SSN + CC blocked.');
    expect(res.body.data.isActive).toBe(true);
  });

  test('step 6b: reactivate tenant-scoped policy after auto-deactivation', async () => {
    // First, disable all rules to trigger auto-deactivation
    const disableRes = await requestJson<SuccessResponse & { autoDeactivated?: boolean }>(
      harness,
      tenantPolicyUrl(`/${tenantPolicyId}`),
      {
        method: 'PUT',
        headers: authHeaders(ctx.token),
        body: {
          rules: [
            {
              ...tenantSdbRule(),
              enabled: false,
              entities: ['ssn', 'credit_card'],
              actionMessage: 'Updated: SSN + CC blocked.',
            },
          ],
          settings: BASE_SETTINGS,
          status: 'active',
        },
      },
    );

    expect(disableRes.status).toBe(200);
    // Auto-deactivation should trigger when all rules are disabled
    expect(disableRes.body.autoDeactivated).toBe(true);
    expect(disableRes.body.data.isActive).toBe(false);

    // Reactivate via the reactivate endpoint
    const reactivateRes = await requestJson<SuccessResponse>(
      harness,
      tenantPolicyUrl(`/${tenantPolicyId}/reactivate`),
      {
        method: 'POST',
        headers: authHeaders(ctx.token),
        body: { guardrailName: 'sdb_tenant_ssn' },
      },
    );

    expect(reactivateRes.status).toBe(200);
    expect(reactivateRes.body.success).toBe(true);
    expect(reactivateRes.body.data.isActive).toBe(true);
    expect(reactivateRes.body.data.status).toBe('active');

    // Verify the specific rule was re-enabled
    const reactivatedRule = reactivateRes.body.data.rules.find(
      (r) => r.guardrailName === 'sdb_tenant_ssn',
    );
    expect(reactivatedRule?.enabled).toBe(true);
  });

  // ─── Tenant policy visible from tenant-scoped list ───────────────────────

  test('tenant-scoped policy appears in top-level list', async () => {
    const res = await requestJson<ListResponse>(harness, tenantPolicyUrl(), {
      method: 'GET',
      headers: authHeaders(ctx.token),
    });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    const found = res.body.data.find((p) => p._id === tenantPolicyId);
    expect(found).toBeDefined();
    expect(found?.scope.type).toBe('tenant');
  });

  // ─── Tenant policy NOT visible from project-scoped list ──────────────────

  test('tenant-scoped policy does NOT appear in project-scoped list', async () => {
    const res = await requestJson<ListResponse>(harness, projectPolicyUrl(), {
      method: 'GET',
      headers: authHeaders(ctx.token),
    });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    const found = res.body.data.find((p) => p._id === tenantPolicyId);
    // Tenant-scoped policies have scope.type='tenant' and no scope.projectId,
    // so the project-scoped list filter (scope.projectId = ctx.projectId) excludes them.
    expect(found).toBeUndefined();
  });
});
