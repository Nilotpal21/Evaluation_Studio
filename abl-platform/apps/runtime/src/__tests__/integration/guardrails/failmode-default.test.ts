/**
 * INT-10 — `failMode` schema default flip (FR-5.4)
 *
 * Proves that the 3-site flip (schema L214 + route normalizer L206 +
 * DEFAULT_POLICY_SETTINGS L141) all default to `'open'`.
 *
 * Boundary: Runtime POST/PUT route ↔ schema default ↔ persistence.
 *
 * Test infrastructure: RuntimeApiHarness + real MongoMemoryServer.
 * HTTP-only interaction. Zero vi.mock calls.
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
  settings: {
    failMode: string;
    timeouts: { local: number; model: number; llm: number };
    streaming: Record<string, unknown>;
    [key: string]: unknown;
  };
  rules: Array<Record<string, unknown>>;
  [key: string]: unknown;
}

interface SuccessResponse {
  success: boolean;
  data: PolicyData;
  autoDeactivated?: boolean;
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

/** Full settings object used when an explicit settings is needed. */
const FULL_SETTINGS = {
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

/** Minimal valid rule payload for creating a policy. */
const VALID_RULE = {
  guardrailName: 'content_safety',
  override: 'threshold',
  threshold: 0.9,
};

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
    uniqueEmail('failmode-admin'),
    uniqueSlug('failmode-tenant'),
    uniqueSlug('failmode-project'),
  );
}, 60_000);

afterAll(async () => {
  await harness.close();
}, 30_000);

beforeEach(async () => {
  await harness.resetRuntimeState();
  ctx = await bootstrapProject(
    harness,
    uniqueEmail('failmode-admin'),
    uniqueSlug('failmode-tenant'),
    uniqueSlug('failmode-project'),
  );
}, 60_000);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** GET a single policy by id and return the data. */
async function getPolicy(policyId: string): Promise<PolicyData> {
  const res = await requestJson<SuccessResponse>(harness, policyUrl(`/${policyId}`), {
    method: 'GET',
    headers: authHeaders(ctx.token),
  });
  expect(res.status, `GET policy ${policyId}: ${JSON.stringify(res.body)}`).toBe(200);
  expect(res.body.success).toBe(true);
  return res.body.data;
}

// =============================================================================
// INT-10 — failMode schema default flip
// =============================================================================

describe('INT-10 — failMode schema default flip (FR-5.4)', () => {
  // -------------------------------------------------------------------------
  // Case 1 (R2-F4 critical): POST with failMode omitted from settings → 'open'
  //
  // `settings` is a required field on POST, so we provide settings but omit
  // `failMode` within it. The route normalizer should default to 'open'.
  // -------------------------------------------------------------------------
  test('Case 1: POST with failMode omitted from settings defaults to open', async () => {
    // Provide settings WITHOUT failMode — only timeouts and streaming
    const settingsWithoutFailMode = {
      timeouts: { local: 100, model: 3000, llm: 10000 },
      streaming: {
        enabled: false,
        defaultInterval: 'sentence',
        chunkSize: 1,
        maxLatencyMs: 500,
        earlyTermination: true,
      },
    };

    const res = await requestJson<SuccessResponse>(harness, policyUrl(), {
      method: 'POST',
      headers: authHeaders(ctx.token),
      body: {
        name: 'no-failmode-policy',
        rules: [VALID_RULE],
        settings: settingsWithoutFailMode,
      },
    });

    expect(res.status, `POST response: ${JSON.stringify(res.body)}`).toBe(201);
    expect(res.body.success).toBe(true);

    // Verify via GET to confirm persistence, not just response normalization
    const policy = await getPolicy(res.body.data._id);
    expect(policy.settings.failMode).toBe('open');
  });

  // -------------------------------------------------------------------------
  // Case 2: POST with explicit failMode: 'closed' → persists 'closed'
  // -------------------------------------------------------------------------
  test('Case 2: POST with explicit failMode closed persists closed', async () => {
    const res = await requestJson<SuccessResponse>(harness, policyUrl(), {
      method: 'POST',
      headers: authHeaders(ctx.token),
      body: {
        name: 'closed-failmode-policy',
        rules: [VALID_RULE],
        settings: { ...FULL_SETTINGS, failMode: 'closed' },
      },
    });

    expect(res.status, `POST response: ${JSON.stringify(res.body)}`).toBe(201);
    expect(res.body.success).toBe(true);

    const policy = await getPolicy(res.body.data._id);
    expect(policy.settings.failMode).toBe('closed');
  });

  // -------------------------------------------------------------------------
  // Case 3: POST with explicit failMode: 'open' → persists 'open'
  // -------------------------------------------------------------------------
  test('Case 3: POST with explicit failMode open persists open', async () => {
    const res = await requestJson<SuccessResponse>(harness, policyUrl(), {
      method: 'POST',
      headers: authHeaders(ctx.token),
      body: {
        name: 'open-failmode-policy',
        rules: [VALID_RULE],
        settings: { ...FULL_SETTINGS, failMode: 'open' },
      },
    });

    expect(res.status, `POST response: ${JSON.stringify(res.body)}`).toBe(201);
    expect(res.body.success).toBe(true);

    const policy = await getPolicy(res.body.data._id);
    expect(policy.settings.failMode).toBe('open');
  });

  // -------------------------------------------------------------------------
  // Case 4: PUT with failMode omitted on existing policy → preserves original
  // -------------------------------------------------------------------------
  test('Case 4: PUT with failMode omitted preserves existing value', async () => {
    // Create with explicit 'closed'
    const createRes = await requestJson<SuccessResponse>(harness, policyUrl(), {
      method: 'POST',
      headers: authHeaders(ctx.token),
      body: {
        name: 'preserve-failmode-policy',
        rules: [VALID_RULE],
        settings: { ...FULL_SETTINGS, failMode: 'closed' },
      },
    });
    expect(createRes.status).toBe(201);
    const policyId = createRes.body.data._id;

    // PUT with an unrelated change — failMode NOT in settings
    const putRes = await requestJson<SuccessResponse & ErrorResponse>(
      harness,
      policyUrl(`/${policyId}`),
      {
        method: 'PUT',
        headers: authHeaders(ctx.token),
        body: {
          name: 'preserve-failmode-policy-renamed',
          rules: [VALID_RULE],
          // settings omitted entirely — must NOT reset failMode to default
        },
      },
    );
    expect(putRes.status, `PUT response: ${JSON.stringify(putRes.body)}`).toBe(200);
    expect(putRes.body.success).toBe(true);

    // GET to verify failMode is still 'closed'
    const policy = await getPolicy(policyId);
    expect(policy.settings.failMode).toBe('closed');
  });

  // -------------------------------------------------------------------------
  // Case 5: PUT with explicit failMode: 'open' flips existing 'closed'
  // -------------------------------------------------------------------------
  test('Case 5: PUT with explicit failMode open flips existing closed', async () => {
    // Create with 'closed'
    const createRes = await requestJson<SuccessResponse>(harness, policyUrl(), {
      method: 'POST',
      headers: authHeaders(ctx.token),
      body: {
        name: 'flip-failmode-policy',
        rules: [VALID_RULE],
        settings: { ...FULL_SETTINGS, failMode: 'closed' },
      },
    });
    expect(createRes.status).toBe(201);
    const policyId = createRes.body.data._id;

    // PUT with explicit 'open' in settings
    const putRes = await requestJson<SuccessResponse & ErrorResponse>(
      harness,
      policyUrl(`/${policyId}`),
      {
        method: 'PUT',
        headers: authHeaders(ctx.token),
        body: {
          name: 'flip-failmode-policy',
          rules: [VALID_RULE],
          settings: { ...FULL_SETTINGS, failMode: 'open' },
        },
      },
    );
    expect(putRes.status, `PUT response: ${JSON.stringify(putRes.body)}`).toBe(200);
    expect(putRes.body.success).toBe(true);

    const policy = await getPolicy(policyId);
    expect(policy.settings.failMode).toBe('open');
  });

  // -------------------------------------------------------------------------
  // Case 6: POST with settings: {} (empty) — normalizer fills defaults,
  //         failMode should be 'open' via DEFAULT_POLICY_SETTINGS
  // -------------------------------------------------------------------------
  test('Case 6: POST with empty settings object defaults failMode to open', async () => {
    const res = await requestJson<SuccessResponse>(harness, policyUrl(), {
      method: 'POST',
      headers: authHeaders(ctx.token),
      body: {
        name: 'empty-settings-policy',
        rules: [VALID_RULE],
        settings: {}, // empty settings — normalizer fills defaults
      },
    });

    expect(res.status, `POST response: ${JSON.stringify(res.body)}`).toBe(201);
    expect(res.body.success).toBe(true);

    const policy = await getPolicy(res.body.data._id);
    expect(policy.settings.failMode).toBe('open');
  });
});
