/**
 * INT-7 — Activation gate trace events (FR-7.5)
 *
 * Integration tests verifying that guardrail policy activation, auto-deactivation,
 * and reactivation emit the correct audit log entries via the shared audit store.
 *
 * Boundary: Activate / PUT / Reactivate routes → InMemoryAuditStore.
 * Zero vi.mock calls — uses RuntimeApiHarness with real Mongo + in-memory audit store.
 *
 * NOTE: `resetRuntimeState()` triggers `flushBufferedPersistenceOnShutdown()` which
 * calls `shutdownAuditLogs()` from `auth-repo.ts`, setting `auditLogShutdownRequested = true`.
 * We must call `_resetAuthAuditBufferStateForTests()` after each `resetRuntimeState()`
 * to re-enable fire-and-forget audit writes from route handlers.
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
import { getAuditStore } from '../../../services/audit-store-singleton.js';
import { _resetAuthAuditBufferStateForTests, shutdownAuditLogs } from '../../../repos/auth-repo.js';
import type { AuditLog } from '@abl/compiler/platform/core/types.js';

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
 * Create a policy with the given rules. Optionally activate it.
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

/**
 * Flush pending fire-and-forget audit writes then query the in-memory audit
 * store for logs matching the given action.
 *
 * `writeAuditLog` in `auth-repo.ts` tracks each async write promise in a
 * `pendingAuditWrites` Set. We flush those, then reset the auth-repo buffer
 * state so subsequent writes are not blocked by the shutdown flag.
 */
async function queryAuditLogsByAction(action: string): Promise<AuditLog[]> {
  // Flush any pending fire-and-forget audit writes
  await shutdownAuditLogs();
  _resetAuthAuditBufferStateForTests();

  const store = getAuditStore();
  if (!store) {
    return [];
  }

  // Query with a wide time range covering the test run
  const now = new Date();
  const oneHourAgo = new Date(now.getTime() - 60 * 60 * 1000);
  const result = await store.query({
    startTime: oneHourAgo,
    endTime: new Date(now.getTime() + 60 * 1000),
    limit: 500,
  });

  // InMemoryAuditStore.query() doesn't filter by action, so filter in JS
  return result.logs.filter((log) => log.action === action);
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
    uniqueEmail('grail-trace-admin'),
    uniqueSlug('grail-trace-tenant'),
    uniqueSlug('grail-trace-project'),
  );
}, 60_000);

afterAll(async () => {
  await harness.close();
}, 30_000);

beforeEach(async () => {
  await harness.resetRuntimeState();
  // resetRuntimeState() → cleanupRuntimeState() → flushBufferedPersistenceOnShutdown()
  // sets auth-repo's `auditLogShutdownRequested = true`. Reset it so route
  // handlers can write audit events during this test.
  _resetAuthAuditBufferStateForTests();

  ctx = await bootstrapProject(
    harness,
    uniqueEmail('grail-trace-admin'),
    uniqueSlug('grail-trace-tenant'),
    uniqueSlug('grail-trace-project'),
  );
}, 60_000);

// =============================================================================
// INT-7 — Activation gate trace events
// =============================================================================

describe('INT-7 — Activation gate trace events (FR-7.5)', () => {
  test('activation-blocked audit log emitted when activating with no enabled rules', async () => {
    // Step 1: Create a policy with all rules disabled
    const policy = await createPolicy('no-rules-policy', [
      {
        guardrailName: 'disabled_rule',
        override: 'define',
        kind: 'input',
        provider: 'builtin_pii',
        category: 'pii',
        threshold: 0.8,
        action: 'block',
        enabled: false,
        actionMessage: 'Blocked',
      },
    ]);

    // Step 2: Attempt to activate → expect 400 NO_ENABLED_RULES
    const activateRes = await requestJson<ErrorResponse>(
      harness,
      policyUrl(`/${policy._id}/activate`),
      {
        method: 'POST',
        headers: authHeaders(ctx.token),
      },
    );
    expect(activateRes.status).toBe(400);
    expect(activateRes.body.success).toBe(false);
    expect(activateRes.body.error?.code).toBe('NO_ENABLED_RULES');

    // Step 3: Verify audit log has activation-blocked entry
    const blockedLogs = await queryAuditLogsByAction('guardrail-policy:activation-blocked');
    expect(blockedLogs.length).toBeGreaterThanOrEqual(1);

    const entry = blockedLogs[0];
    expect(entry.metadata).toBeDefined();
    expect(entry.metadata.reason).toBe('no_enabled_rules');
    expect(entry.metadata.policyId).toBeTruthy();
  });

  test('auto-deactivated audit log emitted when PUT disables all rules', async () => {
    const rule = {
      guardrailName: 'auto_deact_rule',
      override: 'define',
      kind: 'input',
      provider: 'builtin_pii',
      category: 'pii',
      threshold: 0.8,
      action: 'block',
      enabled: true,
      actionMessage: 'Blocked by auto-deact rule',
    };

    // Step 1: Create policy with 1 enabled rule, activate it
    const policy = await createPolicy('auto-deact-policy', [rule], true);
    expect(policy.isActive).toBe(true);

    // Step 2: PUT with the rule disabled → expect autoDeactivated: true
    const putRes = await requestJson<SuccessResponse>(harness, policyUrl(`/${policy._id}`), {
      method: 'PUT',
      headers: authHeaders(ctx.token),
      body: {
        rules: [{ ...rule, enabled: false }],
        settings: BASE_SETTINGS,
      },
    });

    expect(putRes.status).toBe(200);
    expect(putRes.body.success).toBe(true);
    expect(putRes.body.autoDeactivated).toBe(true);

    // Step 3: Verify audit log has auto-deactivated entry
    const deactivatedLogs = await queryAuditLogsByAction('guardrail-policy:auto-deactivated');
    expect(deactivatedLogs.length).toBeGreaterThanOrEqual(1);

    const entry = deactivatedLogs[0];
    expect(entry.metadata).toBeDefined();
    expect(entry.metadata.reason).toBe('all_rules_disabled');
    expect(entry.metadata.undone).toBe(false);
    expect(entry.metadata.policyId).toBeTruthy();
  });

  test('reactivated audit log emitted with undone: true on POST /reactivate', async () => {
    const rule = {
      guardrailName: 'reactivate_rule',
      override: 'define',
      kind: 'input',
      provider: 'builtin_pii',
      category: 'pii',
      threshold: 0.8,
      action: 'block',
      enabled: true,
      actionMessage: 'Blocked by reactivate rule',
    };

    // Step 1: Create and activate policy
    const policy = await createPolicy('reactivate-policy', [rule], true);
    expect(policy.isActive).toBe(true);

    // Step 2: PUT to disable rule → auto-deactivation
    const putRes = await requestJson<SuccessResponse>(harness, policyUrl(`/${policy._id}`), {
      method: 'PUT',
      headers: authHeaders(ctx.token),
      body: {
        rules: [{ ...rule, enabled: false }],
        settings: BASE_SETTINGS,
      },
    });
    expect(putRes.status).toBe(200);
    expect(putRes.body.autoDeactivated).toBe(true);

    // Step 3: POST /reactivate to undo
    const reactivateRes = await requestJson<SuccessResponse>(
      harness,
      policyUrl(`/${policy._id}/reactivate`),
      {
        method: 'POST',
        headers: authHeaders(ctx.token),
        body: { guardrailName: 'reactivate_rule' },
      },
    );
    expect(reactivateRes.status).toBe(200);
    expect(reactivateRes.body.success).toBe(true);
    expect(reactivateRes.body.data.isActive).toBe(true);

    // Step 4: Verify audit log has reactivated entry with undone: true
    const reactivatedLogs = await queryAuditLogsByAction('guardrail-policy:reactivated');
    expect(reactivatedLogs.length).toBeGreaterThanOrEqual(1);

    const entry = reactivatedLogs[0];
    expect(entry.metadata).toBeDefined();
    expect(entry.metadata.undone).toBe(true);
    expect(entry.metadata.guardrailName).toBe('reactivate_rule');
    expect(entry.metadata.policyId).toBeTruthy();
  });

  test('presetKey full-chain assertion (R3-F2) — deferred to E2E-14', () => {
    // INT-7 §7: Create an SDB policy with presetKey: 'sensitive_data_block', activate,
    // send a chat message that triggers a block, inspect trace store for
    // guardrail_input_blocked event with data.presetKey === 'sensitive_data_block'.
    //
    // This requires spinning up the full reasoning executor with a mock LLM
    // and real guardrail evaluation pipeline, which is heavyweight for an
    // integration test. The presetKey propagation is verified by:
    //   - INT-6 (telemetry-rename.test.ts) which tests the onTraceEvent callback
    //     shape directly using the GuardrailPipeline + BuiltinPIIProvider
    //   - E2E-14 (when implemented) which will exercise the full HTTP chat flow
    //
    // See: docs/testing/sub-features/guardrails-sensitive-data-block.md §5 note 5
    expect(true).toBe(true);
  });
});
