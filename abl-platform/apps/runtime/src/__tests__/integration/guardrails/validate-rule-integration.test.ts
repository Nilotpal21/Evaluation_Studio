/**
 * INT-1 — Route handler uses shared validateRule() (FR-8.2 symmetry, T-SH-2)
 *
 * Integration test proving that the POST /api/projects/:projectId/guardrail-policies
 * route handler calls the shared `validateRule()` module to:
 *   - Reject SDB rules with invalid actionMessage (empty, null-byte, over-length)
 *   - Persist the sanitized (HTML-stripped) actionMessage, never the raw input
 *   - Accept valid SDB rules
 *   - Accept non-SDB rules without actionMessage
 *
 * Boundary: Runtime route handler ↔ shared validateRule() ↔ Studio-form round-trip.
 *
 * 6 cases via it.each. Zero vi.mock calls. HTTP-only interaction.
 */

import { describe, expect, it, beforeAll, afterAll } from 'vitest';
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
  rules: Array<{
    guardrailName: string;
    actionMessage?: string;
    [key: string]: unknown;
  }>;
  [key: string]: unknown;
}

interface SuccessResponse {
  success: boolean;
  data: PolicyData;
}

interface ErrorResponse {
  success: boolean;
  error?: { code: string; message: string };
}

// ---------------------------------------------------------------------------
// Shared harness
// ---------------------------------------------------------------------------

const TIMEOUT_MS = 90_000;

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

/** Build a complete SDB rule with the given actionMessage override. */
function makeSdbRule(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    guardrailName: `sdb_rule_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    override: 'define',
    kind: 'input',
    provider: 'builtin_pii',
    category: 'pii',
    threshold: 0.8,
    action: 'block',
    enabled: true,
    presetKey: 'sensitive_data_block',
    entities: ['ssn'],
    actionMessage: 'Default block message',
    ...overrides,
  };
}

/** Build a non-SDB rule (no presetKey). */
function makeNonSdbRule(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    guardrailName: `generic_rule_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    override: 'define',
    kind: 'input',
    provider: 'builtin_pii',
    category: 'pii',
    threshold: 0.8,
    action: 'block',
    enabled: true,
    ...overrides,
  };
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
    uniqueEmail('grail-val-admin'),
    uniqueSlug('grail-val-tenant'),
    uniqueSlug('grail-val-project'),
  );
}, TIMEOUT_MS);

afterAll(async () => {
  await harness.close();
}, 30_000);

// ---------------------------------------------------------------------------
// INT-1 — Route handler uses shared validateRule() (FR-8.2)
// ---------------------------------------------------------------------------

let uniqueCounter = 0;

describe('INT-1 — Route handler uses shared validateRule() (FR-8.2)', () => {
  it.each([
    {
      name: 'POST rejects SDB rule with empty actionMessage',
      buildBody: () => ({
        name: `policy-empty-msg-${++uniqueCounter}`,
        rules: [makeSdbRule({ actionMessage: '' })],
        settings: BASE_SETTINGS,
      }),
      expectStatus: 400,
      expectCode: 'RULE_INCOMPLETE',
    },
    {
      name: 'POST rejects SDB rule with null-byte actionMessage',
      buildBody: () => ({
        name: `policy-null-byte-${++uniqueCounter}`,
        rules: [makeSdbRule({ actionMessage: 'foo\x00bar' })],
        settings: BASE_SETTINGS,
      }),
      expectStatus: 400,
      expectCode: 'RULE_INCOMPLETE',
    },
    {
      name: 'POST rejects SDB rule with >500-char actionMessage',
      buildBody: () => ({
        name: `policy-long-msg-${++uniqueCounter}`,
        rules: [makeSdbRule({ actionMessage: 'x'.repeat(501) })],
        settings: BASE_SETTINGS,
      }),
      expectStatus: 400,
      expectCode: 'RULE_INCOMPLETE',
    },
    {
      name: 'POST persists sanitized actionMessage (HTML stripped)',
      buildBody: () => ({
        name: `policy-html-strip-${++uniqueCounter}`,
        rules: [makeSdbRule({ actionMessage: '<script>alert(1)</script>Hello' })],
        settings: BASE_SETTINGS,
      }),
      expectStatus: 201,
      expectCode: undefined,
    },
    {
      name: 'POST accepts SDB rule with valid actionMessage',
      buildBody: () => ({
        name: `policy-valid-sdb-${++uniqueCounter}`,
        rules: [makeSdbRule({ actionMessage: 'PII detected, message blocked.' })],
        settings: BASE_SETTINGS,
      }),
      expectStatus: 201,
      expectCode: undefined,
    },
    {
      name: 'POST accepts non-SDB rule WITHOUT actionMessage (presetKey absent)',
      buildBody: () => ({
        name: `policy-non-sdb-${++uniqueCounter}`,
        rules: [makeNonSdbRule()],
        settings: BASE_SETTINGS,
      }),
      expectStatus: 201,
      expectCode: undefined,
    },
  ])(
    '$name',
    async ({ buildBody, expectStatus, expectCode }) => {
      const body = buildBody();
      const res = await requestJson<SuccessResponse & ErrorResponse>(harness, policyUrl(), {
        method: 'POST',
        headers: authHeaders(ctx.token),
        body,
      });

      expect(res.status).toBe(expectStatus);

      if (expectCode) {
        expect(res.body.success).toBe(false);
        expect((res.body as ErrorResponse).error?.code).toBe(expectCode);
      } else {
        expect(res.body.success).toBe(true);
      }
    },
    30_000,
  );

  // ─── Dedicated assertion for HTML-sanitized persistence (case 4) ──────
  it('persisted actionMessage is HTML-stripped (R7-F4)', async () => {
    const policyName = `policy-html-verify-${++uniqueCounter}`;
    const createRes = await requestJson<SuccessResponse>(harness, policyUrl(), {
      method: 'POST',
      headers: authHeaders(ctx.token),
      body: {
        name: policyName,
        rules: [makeSdbRule({ actionMessage: '<b>Bold</b> and <script>evil</script>clean' })],
        settings: BASE_SETTINGS,
      },
    });

    expect(createRes.status).toBe(201);
    expect(createRes.body.success).toBe(true);

    // GET the policy back and verify persisted actionMessage
    const policyId = createRes.body.data._id;
    const getRes = await requestJson<SuccessResponse>(harness, policyUrl(`/${policyId}`), {
      method: 'GET',
      headers: authHeaders(ctx.token),
    });

    expect(getRes.status).toBe(200);
    expect(getRes.body.success).toBe(true);

    const persistedRule = getRes.body.data.rules[0];
    expect(persistedRule).toBeDefined();
    // sanitize-html strips all tags; text content is preserved
    expect(persistedRule.actionMessage).not.toContain('<script>');
    expect(persistedRule.actionMessage).not.toContain('<b>');
    expect(persistedRule.actionMessage).toContain('Bold');
    expect(persistedRule.actionMessage).toContain('clean');
  }, 30_000);
});
