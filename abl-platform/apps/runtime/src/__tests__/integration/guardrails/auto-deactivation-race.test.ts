/**
 * INT-4  — Auto-deactivation race condition (T6 threat, FR-7.4)
 * INT-12 — PUT lifecycle precedence (LLD R1-F9)
 * INT-13 — Reactivate sibling-deactivation (LLD R2-F1)
 *
 * Integration tests exercising guardrail policy auto-deactivation atomicity,
 * lifecycle precedence, and reactivate sibling-deactivation via the HTTP API
 * backed by real MongoMemoryServer. Zero vi.mock calls.
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'vitest';
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
  requestJson,
  uniqueEmail,
  uniqueSlug,
  type BootstrapProjectResult,
} from '../../helpers/channel-e2e-bootstrap.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface PolicyData {
  _id: string;
  name: string;
  isActive: boolean;
  status: string;
  rules: Array<{ guardrailName: string; enabled?: boolean; [key: string]: unknown }>;
  autoDeactivated?: boolean;
  [key: string]: unknown;
}

interface SuccessResponse {
  success: boolean;
  data: PolicyData;
  autoDeactivated?: boolean;
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

function policyUrl(suffix = ''): string {
  return `/api/projects/${ctx.projectId}/guardrail-policies${suffix}`;
}

/** Minimal valid settings required by POST. */
const BASE_SETTINGS = {
  failMode: 'open',
  timeouts: { local: 100, model: 3000, llm: 10000 },
  streaming: {
    enabled: false,
    defaultInterval: 'sentence',
    chunkSize: 1,
    maxLatencyMs: 500,
    earlyTermination: true,
  },
};

/**
 * Helper: create a policy with the given name and rules, then optionally
 * activate it. Returns the created (and optionally activated) policy.
 */
async function createPolicy(
  name: string,
  rules: Array<Record<string, unknown>>,
  activate = false,
): Promise<PolicyData> {
  const createRes = await requestJson<SuccessResponse>(harness, policyUrl(), {
    method: 'POST',
    headers: authHeaders(ctx.token),
    body: { name, rules, settings: BASE_SETTINGS },
  });
  expect(createRes.status, `create ${name}: ${JSON.stringify(createRes.body)}`).toBe(201);
  expect(createRes.body.success).toBe(true);

  const policy = createRes.body.data;

  if (activate) {
    const activateRes = await requestJson<SuccessResponse>(
      harness,
      policyUrl(`/${policy._id}/activate`),
      {
        method: 'POST',
        headers: authHeaders(ctx.token),
      },
    );
    expect(activateRes.status, `activate ${name}: ${JSON.stringify(activateRes.body)}`).toBe(200);
    expect(activateRes.body.success).toBe(true);
    return activateRes.body.data;
  }

  return policy;
}

/** Helper: GET a single policy by id. */
async function getPolicy(policyId: string): Promise<PolicyData> {
  const res = await requestJson<SuccessResponse>(harness, policyUrl(`/${policyId}`), {
    method: 'GET',
    headers: authHeaders(ctx.token),
  });
  expect(res.status, `GET policy ${policyId}: ${JSON.stringify(res.body)}`).toBe(200);
  expect(res.body.success).toBe(true);
  return res.body.data;
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeAll(async () => {
  harness = await startRuntimeApiHarness((app) => {
    app.use('/api/auth', authRouter);
    app.use('/api/platform/admin/tenants', platformAdminTenantsRouter);
    app.use('/api/projects/:projectId/guardrail-policies', guardrailPolicyRouter);
  });

  ctx = await bootstrapProject(
    harness,
    uniqueEmail('grail-race-admin'),
    uniqueSlug('grail-race-tenant'),
    uniqueSlug('grail-race-project'),
  );
}, 60_000);

afterAll(async () => {
  await harness.close();
}, 30_000);

beforeEach(async () => {
  await harness.resetRuntimeState();
  // Re-bootstrap project after DB wipe so subsequent creates succeed.
  ctx = await bootstrapProject(
    harness,
    uniqueEmail('grail-race-admin'),
    uniqueSlug('grail-race-tenant'),
    uniqueSlug('grail-race-project'),
  );
}, 60_000);

// =============================================================================
// INT-4 — Auto-deactivation race condition
// =============================================================================

describe('INT-4 — Auto-deactivation race condition (T6 threat, FR-7.4)', () => {
  test('concurrent PUTs disabling different rules yield coherent state', async () => {
    // Create a policy with 2 enabled rules and activate it
    const rule1 = {
      guardrailName: 'rule_one',
      override: 'define',
      kind: 'input',
      provider: 'builtin_pii',
      category: 'pii',
      threshold: 0.8,
      action: 'block',
      enabled: true,
      actionMessage: 'Blocked by rule one',
    };
    const rule2 = {
      guardrailName: 'rule_two',
      override: 'define',
      kind: 'input',
      provider: 'builtin_pii',
      category: 'pii',
      threshold: 0.8,
      action: 'block',
      enabled: true,
      actionMessage: 'Blocked by rule two',
    };

    const policy = await createPolicy('race-policy', [rule1, rule2], true);
    const policyId = policy._id;

    // Verify starting state: active, both rules enabled
    expect(policy.isActive).toBe(true);
    expect(policy.rules).toHaveLength(2);
    expect(policy.rules.every((r) => r.enabled !== false)).toBe(true);

    // Issue two concurrent PUTs:
    //   PUT-A: disables rule1, keeps rule2 enabled
    //   PUT-B: disables rule2, keeps rule1 enabled
    const [resA, resB] = await Promise.all([
      requestJson<SuccessResponse>(harness, policyUrl(`/${policyId}`), {
        method: 'PUT',
        headers: authHeaders(ctx.token),
        body: {
          rules: [
            { ...rule1, enabled: false },
            { ...rule2, enabled: true },
          ],
          settings: BASE_SETTINGS,
        },
      }),
      requestJson<SuccessResponse>(harness, policyUrl(`/${policyId}`), {
        method: 'PUT',
        headers: authHeaders(ctx.token),
        body: {
          rules: [
            { ...rule1, enabled: true },
            { ...rule2, enabled: false },
          ],
          settings: BASE_SETTINGS,
        },
      }),
    ]);

    // Both requests should succeed
    expect(resA.status).toBe(200);
    expect(resB.status).toBe(200);

    // Fetch final state
    const final = await getPolicy(policyId);
    const enabledRules = final.rules.filter((r) => r.enabled !== false);
    const allDisabled = enabledRules.length === 0;

    // INVARIANT: no observable state where isActive === true && all rules disabled
    if (allDisabled) {
      expect(final.isActive).toBe(false);
      expect(final.status).toBe('draft');

      // At least one response must have reported autoDeactivated: true
      const anyAutoDeactivated =
        resA.body.autoDeactivated === true || resB.body.autoDeactivated === true;
      expect(anyAutoDeactivated).toBe(true);
    } else {
      // Last-writer-wins: exactly one rule is enabled, state is coherent.
      // The policy may or may not be active depending on which PUT landed last.
      // Either way, the invariant holds because there IS an enabled rule.
      expect(enabledRules.length).toBeGreaterThanOrEqual(1);
    }
  });
});

// =============================================================================
// INT-12 — PUT lifecycle precedence
// =============================================================================

describe('INT-12 — PUT lifecycle precedence (LLD R1-F9)', () => {
  test('auto-deactivation overrides client-supplied status: active', async () => {
    const rule = {
      guardrailName: 'lifecycle_rule',
      override: 'define',
      kind: 'input',
      provider: 'builtin_pii',
      category: 'pii',
      threshold: 0.8,
      action: 'block',
      enabled: true,
      actionMessage: 'Blocked by lifecycle rule',
    };

    // Create policy with 1 enabled rule and activate it
    const policy = await createPolicy('lifecycle-policy', [rule], true);
    const policyId = policy._id;

    expect(policy.isActive).toBe(true);
    expect(policy.status).toBe('active');

    // PUT with status: 'active' BUT all rules disabled — auto-deactivation must win
    const putRes = await requestJson<SuccessResponse>(harness, policyUrl(`/${policyId}`), {
      method: 'PUT',
      headers: authHeaders(ctx.token),
      body: {
        status: 'active',
        rules: [{ ...rule, enabled: false }],
        settings: BASE_SETTINGS,
      },
    });

    expect(putRes.status).toBe(200);
    expect(putRes.body.success).toBe(true);

    // Step 1 assertion: response includes autoDeactivated: true
    expect(putRes.body.autoDeactivated).toBe(true);

    // Step 2: GET to confirm persisted state
    const final = await getPolicy(policyId);
    expect(final.isActive).toBe(false);
    expect(final.status).toBe('draft');
  });
});

// =============================================================================
// INT-13 — Reactivate sibling-deactivation
// =============================================================================

describe('INT-13 — Reactivate sibling-deactivation (LLD R2-F1)', () => {
  test('reactivate preserves single-active-policy invariant', async () => {
    const ruleA = {
      guardrailName: 'rule_alpha',
      override: 'define',
      kind: 'input',
      provider: 'builtin_pii',
      category: 'pii',
      threshold: 0.8,
      action: 'block',
      enabled: true,
      actionMessage: 'Blocked by alpha',
    };

    const ruleB = {
      guardrailName: 'rule_beta',
      override: 'define',
      kind: 'input',
      provider: 'builtin_pii',
      category: 'pii',
      threshold: 0.8,
      action: 'block',
      enabled: true,
      actionMessage: 'Blocked by beta',
    };

    // Create policies A and B in the same project
    const policyA = await createPolicy('sibling-policy-a', [ruleA]);
    const policyB = await createPolicy('sibling-policy-b', [ruleB]);

    // Step 1: Activate A
    const activateARes = await requestJson<SuccessResponse>(
      harness,
      policyUrl(`/${policyA._id}/activate`),
      {
        method: 'POST',
        headers: authHeaders(ctx.token),
      },
    );
    expect(activateARes.status).toBe(200);
    expect(activateARes.body.data.isActive).toBe(true);

    // Step 2: Activate B — should deactivate A (sibling deactivation)
    const activateBRes = await requestJson<SuccessResponse>(
      harness,
      policyUrl(`/${policyB._id}/activate`),
      {
        method: 'POST',
        headers: authHeaders(ctx.token),
      },
    );
    expect(activateBRes.status).toBe(200);
    expect(activateBRes.body.data.isActive).toBe(true);

    // Confirm A is now inactive
    const afterBActivate = await getPolicy(policyA._id);
    expect(afterBActivate.isActive).toBe(false);

    // Step 3: Reactivate A
    const reactivateRes = await requestJson<SuccessResponse>(
      harness,
      policyUrl(`/${policyA._id}/reactivate`),
      {
        method: 'POST',
        headers: authHeaders(ctx.token),
        body: { guardrailName: 'rule_alpha' },
      },
    );
    expect(reactivateRes.status).toBe(200);
    expect(reactivateRes.body.success).toBe(true);

    // Step 4: Verify final state — A active, B inactive
    const finalA = await getPolicy(policyA._id);
    const finalB = await getPolicy(policyB._id);

    expect(finalA.isActive).toBe(true);
    expect(finalA.status).toBe('active');
    expect(finalB.isActive).toBe(false);

    // Single-active invariant: exactly one policy is active in the project
    const activeCount = [finalA, finalB].filter((p) => p.isActive).length;
    expect(activeCount).toBe(1);
  });
});
