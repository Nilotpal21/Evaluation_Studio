/**
 * INT-9 — Action message HTML strip + length + null-byte rejection (FR-6.9, T3+T9)
 *
 * Integration test proving the guardrail-policies route handler rejects
 * malicious / malformed `actionMessage` values and that persisted values are
 * always the sanitized form.
 *
 * 7 cases:
 *   1. Plain text         → 201 — persisted unchanged
 *   2. XSS script tag     → 201 — persisted as '' (sanitize-html strips script content)
 *   3. HTML bold tag       → 201 — persisted as 'Bold' (tags stripped, text preserved)
 *   4. Over 500 chars      → 400 RULE_INCOMPLETE
 *   5. Null byte           → 400 RULE_INCOMPLETE
 *   6. Newlines            → 201 — newlines preserved
 *   7. UTF-8 multi-byte    → 201 — persisted unchanged
 *
 * Boundary: Runtime POST route ↔ validateRule() sanitization (T-SH-1) ↔ persistence.
 * Pattern: RuntimeApiHarness, real MongoMemoryServer, HTTP-only, zero vi.mock.
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
 * Build a Sensitive Data Block rule with the given actionMessage.
 * SDB rules trigger strict server-side validation via validateRule(),
 * which enforces actionMessage sanitization, length, and null-byte checks.
 */
function sdbRule(actionMessage: string, nameSuffix = ''): Record<string, unknown> {
  return {
    guardrailName: `sdb_rule${nameSuffix}`,
    override: 'define',
    kind: 'input',
    provider: 'builtin_pii',
    category: 'pii',
    threshold: 0.8,
    action: 'block',
    enabled: true,
    presetKey: 'sensitive_data_block',
    entities: ['ssn'],
    actionMessage,
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
    uniqueEmail('grail-sanitize-admin'),
    uniqueSlug('grail-sanitize-tenant'),
    uniqueSlug('grail-sanitize-project'),
  );
}, 60_000);

afterAll(async () => {
  await harness.close();
}, 30_000);

beforeEach(async () => {
  await harness.resetRuntimeState();
  ctx = await bootstrapProject(
    harness,
    uniqueEmail('grail-sanitize-admin'),
    uniqueSlug('grail-sanitize-tenant'),
    uniqueSlug('grail-sanitize-project'),
  );
}, 60_000);

// =============================================================================
// INT-9 — Action message sanitization (FR-6.9, T3+T9)
// =============================================================================

describe('INT-9 — Action message HTML strip + length + null-byte rejection (FR-6.9)', () => {
  // ─── Case 1: Plain text — persisted unchanged ────────────────────────────

  test('case 1: plain text actionMessage is persisted unchanged', async () => {
    const actionMessage = 'Hello world';

    const createRes = await requestJson<SuccessResponse & ErrorResponse>(harness, policyUrl(), {
      method: 'POST',
      headers: authHeaders(ctx.token),
      body: {
        name: 'plain-text-policy',
        rules: [sdbRule(actionMessage)],
        settings: BASE_SETTINGS,
      },
    });

    expect(createRes.status).toBe(201);
    expect(createRes.body.success).toBe(true);

    // Round-trip: GET and verify persisted value
    const getRes = await requestJson<SuccessResponse>(
      harness,
      policyUrl(`/${createRes.body.data._id}`),
      {
        method: 'GET',
        headers: authHeaders(ctx.token),
      },
    );

    expect(getRes.status).toBe(200);
    const persistedRule = getRes.body.data.rules[0];
    expect(persistedRule.actionMessage).toBe('Hello world');
  });

  // ─── Case 2: XSS script tag — sanitized to empty string ─────────────────

  test('case 2: XSS script tag is sanitized to empty string', async () => {
    const actionMessage = '<script>alert(1)</script>';

    const createRes = await requestJson<SuccessResponse & ErrorResponse>(harness, policyUrl(), {
      method: 'POST',
      headers: authHeaders(ctx.token),
      body: {
        name: 'xss-policy',
        rules: [sdbRule(actionMessage)],
        settings: BASE_SETTINGS,
      },
    });

    // sanitize-html strips <script> and its content entirely → ''
    // The route accepts the request (sanitization succeeds, empty string is valid)
    expect(createRes.status).toBe(201);
    expect(createRes.body.success).toBe(true);

    const getRes = await requestJson<SuccessResponse>(
      harness,
      policyUrl(`/${createRes.body.data._id}`),
      {
        method: 'GET',
        headers: authHeaders(ctx.token),
      },
    );

    expect(getRes.status).toBe(200);
    const persistedRule = getRes.body.data.rules[0];
    expect(persistedRule.actionMessage).toBe('');
  });

  // ─── Case 3: HTML bold tag — tags stripped, text preserved ───────────────

  test('case 3: HTML bold tag is stripped, text content preserved', async () => {
    const actionMessage = '<b>Bold</b>';

    const createRes = await requestJson<SuccessResponse & ErrorResponse>(harness, policyUrl(), {
      method: 'POST',
      headers: authHeaders(ctx.token),
      body: {
        name: 'html-strip-policy',
        rules: [sdbRule(actionMessage)],
        settings: BASE_SETTINGS,
      },
    });

    expect(createRes.status).toBe(201);
    expect(createRes.body.success).toBe(true);

    const getRes = await requestJson<SuccessResponse>(
      harness,
      policyUrl(`/${createRes.body.data._id}`),
      {
        method: 'GET',
        headers: authHeaders(ctx.token),
      },
    );

    expect(getRes.status).toBe(200);
    const persistedRule = getRes.body.data.rules[0];
    expect(persistedRule.actionMessage).toBe('Bold');
  });

  // ─── Case 4: Over 500 chars — rejected with RULE_INCOMPLETE ─────────────

  test('case 4: actionMessage exceeding 500 chars is rejected with RULE_INCOMPLETE', async () => {
    const actionMessage = 'x'.repeat(501);

    const createRes = await requestJson<ErrorResponse>(harness, policyUrl(), {
      method: 'POST',
      headers: authHeaders(ctx.token),
      body: {
        name: 'overlength-policy',
        rules: [sdbRule(actionMessage)],
        settings: BASE_SETTINGS,
      },
    });

    expect(createRes.status).toBe(400);
    expect(createRes.body.success).toBe(false);
    expect(createRes.body.error?.code).toBe('RULE_INCOMPLETE');
    expect(createRes.body.error?.message).toContain('actionMessage');
  });

  // ─── Case 5: Null byte — rejected with RULE_INCOMPLETE ──────────────────

  test('case 5: null byte in actionMessage is rejected with RULE_INCOMPLETE', async () => {
    const actionMessage = 'Hello\x00World';

    const createRes = await requestJson<ErrorResponse>(harness, policyUrl(), {
      method: 'POST',
      headers: authHeaders(ctx.token),
      body: {
        name: 'null-byte-policy',
        rules: [sdbRule(actionMessage)],
        settings: BASE_SETTINGS,
      },
    });

    expect(createRes.status).toBe(400);
    expect(createRes.body.success).toBe(false);
    expect(createRes.body.error?.code).toBe('RULE_INCOMPLETE');
    expect(createRes.body.error?.message).toContain('actionMessage');
  });

  // ─── Case 6: Newlines — preserved (FR-6.9 permits whitespace) ───────────

  test('case 6: newlines in actionMessage are preserved', async () => {
    const actionMessage = 'Hello\nMultiline\nMessage';

    const createRes = await requestJson<SuccessResponse & ErrorResponse>(harness, policyUrl(), {
      method: 'POST',
      headers: authHeaders(ctx.token),
      body: {
        name: 'newline-policy',
        rules: [sdbRule(actionMessage)],
        settings: BASE_SETTINGS,
      },
    });

    expect(createRes.status).toBe(201);
    expect(createRes.body.success).toBe(true);

    const getRes = await requestJson<SuccessResponse>(
      harness,
      policyUrl(`/${createRes.body.data._id}`),
      {
        method: 'GET',
        headers: authHeaders(ctx.token),
      },
    );

    expect(getRes.status).toBe(200);
    const persistedRule = getRes.body.data.rules[0];
    expect(persistedRule.actionMessage).toBe('Hello\nMultiline\nMessage');
  });

  // ─── Case 7: UTF-8 multi-byte — persisted unchanged ─────────────────────

  test('case 7: UTF-8 multi-byte actionMessage is persisted unchanged', async () => {
    const actionMessage = 'Hello 你好 مرحبا';

    const createRes = await requestJson<SuccessResponse & ErrorResponse>(harness, policyUrl(), {
      method: 'POST',
      headers: authHeaders(ctx.token),
      body: {
        name: 'utf8-policy',
        rules: [sdbRule(actionMessage)],
        settings: BASE_SETTINGS,
      },
    });

    expect(createRes.status).toBe(201);
    expect(createRes.body.success).toBe(true);

    const getRes = await requestJson<SuccessResponse>(
      harness,
      policyUrl(`/${createRes.body.data._id}`),
      {
        method: 'GET',
        headers: authHeaders(ctx.token),
      },
    );

    expect(getRes.status).toBe(200);
    const persistedRule = getRes.body.data.rules[0];
    expect(persistedRule.actionMessage).toBe('Hello 你好 مرحبا');
  });
});
