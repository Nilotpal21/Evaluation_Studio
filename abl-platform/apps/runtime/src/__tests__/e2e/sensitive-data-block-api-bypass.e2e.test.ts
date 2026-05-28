/**
 * E2E-11 — Direct API bypass: invalid rule enable (T4 threat)
 * E2E-12 — Direct API bypass: XSS in actionMessage (T3 threat)
 *
 * Proves that server-side validation rejects malformed SDB rules regardless
 * of whether the request comes from Studio or raw API calls (curl-like).
 *
 * E2E-11:
 *   - `enabled: true` + `entities: []` → 400 RULE_INCOMPLETE
 *   - `enabled: true` + missing `actionMessage` → 400 RULE_INCOMPLETE
 *   - Raw POST bypassing Studio form → same enforcement
 *
 * E2E-12:
 *   - `actionMessage: '<script>alert(1)</script>'` → 201, persisted as ''
 *   - `actionMessage: '<img src=x onerror=alert(1)>'` → 201, img tag removed
 *   - Block response uses sanitized version, never the original script
 *
 * Zero vi.mock calls. HTTP-only via RuntimeApiHarness. Real MongoMemoryServer.
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'vitest';
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

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface PolicyData {
  _id: string;
  name: string;
  rules: Array<{
    guardrailName: string;
    actionMessage?: string;
    entities?: string[];
    enabled?: boolean;
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

let uniqueCounter = 0;

/**
 * Build a SDB rule with the given overrides. By default produces a valid
 * SDB rule to make it easy to test single-field mutations.
 */
function sdbRule(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    guardrailName: `sdb_bypass_${++uniqueCounter}`,
    override: 'define',
    kind: 'input',
    provider: 'builtin_pii',
    category: 'pii',
    threshold: 0.8,
    action: 'block',
    enabled: true,
    presetKey: 'sensitive_data_block',
    entities: ['ssn'],
    actionMessage: 'Default message for bypass test',
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
    uniqueEmail('sdb-bypass-admin'),
    uniqueSlug('sdb-bypass-tenant'),
    uniqueSlug('sdb-bypass-project'),
  );
}, 120_000);

afterAll(async () => {
  await harness.close();
}, 30_000);

beforeEach(async () => {
  await harness.resetRuntimeState();
  ctx = await bootstrapProject(
    harness,
    uniqueEmail('sdb-bypass-admin'),
    uniqueSlug('sdb-bypass-tenant'),
    uniqueSlug('sdb-bypass-project'),
  );
}, 60_000);

// =============================================================================
// E2E-11 — Direct API bypass: invalid rule enable (T4 threat)
// =============================================================================

describe('E2E-11 — Direct API bypass: invalid SDB rule enable', () => {
  test('SDB rule with enabled:true but empty entities array returns 400 RULE_INCOMPLETE', async () => {
    const res = await requestJson<ErrorResponse>(harness, policyUrl(), {
      method: 'POST',
      headers: authHeaders(ctx.token),
      body: {
        name: 'bypass-empty-entities',
        rules: [
          sdbRule({
            entities: [],
            enabled: true,
          }),
        ],
        settings: BASE_SETTINGS,
      },
    });

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.error?.code).toBe('RULE_INCOMPLETE');
    expect(res.body.error?.message).toBeDefined();
  });

  test('SDB rule with enabled:true but missing actionMessage returns 400 RULE_INCOMPLETE', async () => {
    const rule = sdbRule({ enabled: true });
    delete rule.actionMessage;

    const res = await requestJson<ErrorResponse>(harness, policyUrl(), {
      method: 'POST',
      headers: authHeaders(ctx.token),
      body: {
        name: 'bypass-missing-actionmsg',
        rules: [rule],
        settings: BASE_SETTINGS,
      },
    });

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.error?.code).toBe('RULE_INCOMPLETE');
  });

  test('raw POST bypassing Studio form gets same server-side validation', async () => {
    // Simulate a curl-like POST with deliberately minimal / malformed SDB payload
    const res = await requestJson<ErrorResponse>(harness, policyUrl(), {
      method: 'POST',
      headers: authHeaders(ctx.token),
      body: {
        name: 'bypass-raw-curl',
        rules: [
          {
            guardrailName: 'raw_sdb_rule',
            override: 'define',
            kind: 'input',
            provider: 'builtin_pii',
            category: 'pii',
            threshold: 0.8,
            action: 'block',
            enabled: true,
            presetKey: 'sensitive_data_block',
            entities: [], // empty — invalid for SDB
            // actionMessage intentionally missing
          },
        ],
        settings: BASE_SETTINGS,
      },
    });

    // Server-side validation catches malformed SDB rules regardless of origin
    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.error?.code).toBe('RULE_INCOMPLETE');
  });

  test('SDB rule with enabled:true and valid payload succeeds (control case)', async () => {
    const res = await requestJson<SuccessResponse>(harness, policyUrl(), {
      method: 'POST',
      headers: authHeaders(ctx.token),
      body: {
        name: 'bypass-valid-control',
        rules: [sdbRule()],
        settings: BASE_SETTINGS,
      },
    });

    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.data.rules).toHaveLength(1);
    expect(res.body.data.rules[0].entities).toEqual(['ssn']);
    expect(res.body.data.rules[0].actionMessage).toBe('Default message for bypass test');
  });
});

// =============================================================================
// E2E-12 — Direct API bypass: XSS in actionMessage (T3 threat)
// =============================================================================

describe('E2E-12 — Direct API bypass: XSS in actionMessage', () => {
  test('script tag in actionMessage is sanitized to empty string, not rejected', async () => {
    const createRes = await requestJson<SuccessResponse>(harness, policyUrl(), {
      method: 'POST',
      headers: authHeaders(ctx.token),
      body: {
        name: 'xss-script-tag',
        rules: [sdbRule({ actionMessage: '<script>alert(1)</script>' })],
        settings: BASE_SETTINGS,
      },
    });

    // sanitize-html strips <script> content entirely → empty string
    // Empty string after sanitization is acceptable (the field isn't "missing")
    expect(createRes.status).toBe(201);
    expect(createRes.body.success).toBe(true);

    // Round-trip: GET and verify persisted value is sanitized
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
    // Verify no trace of the script tag
    expect(JSON.stringify(getRes.body)).not.toContain('<script>');
    expect(JSON.stringify(getRes.body)).not.toContain('alert(1)');
  });

  test('img onerror XSS vector is removed, only alt-like text remains', async () => {
    const createRes = await requestJson<SuccessResponse>(harness, policyUrl(), {
      method: 'POST',
      headers: authHeaders(ctx.token),
      body: {
        name: 'xss-img-onerror',
        rules: [sdbRule({ actionMessage: '<img src=x onerror=alert(1)>' })],
        settings: BASE_SETTINGS,
      },
    });

    expect(createRes.status).toBe(201);
    expect(createRes.body.success).toBe(true);

    // Round-trip: GET and verify the img tag was removed
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
    // sanitize-html strips <img> entirely (it's not in the allowedTags list)
    expect(persistedRule.actionMessage).not.toContain('<img');
    expect(persistedRule.actionMessage).not.toContain('onerror');
    expect(persistedRule.actionMessage).not.toContain('alert');
  });

  test('mixed XSS with legitimate text preserves only the safe text', async () => {
    const createRes = await requestJson<SuccessResponse>(harness, policyUrl(), {
      method: 'POST',
      headers: authHeaders(ctx.token),
      body: {
        name: 'xss-mixed-content',
        rules: [
          sdbRule({
            actionMessage: 'Safe text <script>alert("xss")</script> more safe text',
          }),
        ],
        settings: BASE_SETTINGS,
      },
    });

    expect(createRes.status).toBe(201);

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
    // Script content removed but surrounding text preserved
    expect(persistedRule.actionMessage).toContain('Safe text');
    expect(persistedRule.actionMessage).toContain('more safe text');
    expect(persistedRule.actionMessage).not.toContain('<script>');
    expect(persistedRule.actionMessage).not.toContain('alert');
  });

  test('sanitized policy actionMessage is returned consistently on subsequent reads', async () => {
    const xssPayload = '<script>document.cookie</script>Legitimate warning';

    // Create with XSS payload
    const createRes = await requestJson<SuccessResponse>(harness, policyUrl(), {
      method: 'POST',
      headers: authHeaders(ctx.token),
      body: {
        name: 'xss-subsequent-reads',
        rules: [sdbRule({ actionMessage: xssPayload })],
        settings: BASE_SETTINGS,
      },
    });

    expect(createRes.status).toBe(201);
    const policyId = createRes.body.data._id;

    // Read #1
    const read1 = await requestJson<SuccessResponse>(harness, policyUrl(`/${policyId}`), {
      method: 'GET',
      headers: authHeaders(ctx.token),
    });

    // Read #2
    const read2 = await requestJson<SuccessResponse>(harness, policyUrl(`/${policyId}`), {
      method: 'GET',
      headers: authHeaders(ctx.token),
    });

    // Both reads return the same sanitized value
    expect(read1.body.data.rules[0].actionMessage).toBe(read2.body.data.rules[0].actionMessage);

    // The sanitized value never contains the script
    const sanitized = read1.body.data.rules[0].actionMessage ?? '';
    expect(sanitized).not.toContain('<script>');
    expect(sanitized).not.toContain('document.cookie');
    expect(sanitized).toContain('Legitimate warning');
  });

  test('event-handler XSS in non-script tags is also stripped', async () => {
    const createRes = await requestJson<SuccessResponse>(harness, policyUrl(), {
      method: 'POST',
      headers: authHeaders(ctx.token),
      body: {
        name: 'xss-event-handler',
        rules: [
          sdbRule({
            actionMessage: '<div onmouseover="alert(1)">Hover me</div>',
          }),
        ],
        settings: BASE_SETTINGS,
      },
    });

    expect(createRes.status).toBe(201);

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
    // div tag stripped, text content preserved
    expect(persistedRule.actionMessage).not.toContain('<div');
    expect(persistedRule.actionMessage).not.toContain('onmouseover');
    expect(persistedRule.actionMessage).toContain('Hover me');
  });
});
