/**
 * Governance Policies — Contract Integration Tests
 *
 * Verifies that every response shape from the governance policies API
 * parses through the corresponding Zod contract schema without throwing.
 *
 * Real Express server, real MongoDB (MongoMemoryServer).
 * No ClickHouse needed — policy CRUD is MongoDB-only.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import {
  startRuntimeServerHarness,
  type RuntimeApiHarness,
} from '../helpers/runtime-api-harness.js';
import {
  bootstrapProject,
  requestJson,
  uniqueEmail,
  uniqueSlug,
  authHeaders,
} from '../helpers/channel-e2e-bootstrap.js';
import { z } from 'zod';

const TIMEOUT_MS = 90_000;

// Minimal contract schemas (subset of governance-contracts.ts)
const PolicyItemSchema = z.object({
  _id: z.string(),
  tenantId: z.string(),
  projectId: z.string(),
  name: z.string(),
  status: z.enum(['enabled', 'disabled']),
  rules: z.array(
    z.object({
      pipelineType: z.string(),
      metric: z.string(),
      operator: z.enum(['gt', 'gte', 'lt', 'lte', 'eq']),
      threshold: z.number(),
      severity: z.enum(['critical', 'warning', 'info']),
    }),
  ),
  version: z.number(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

const PoliciesListSchema = z.object({ success: z.literal(true), data: z.array(PolicyItemSchema) });
const PolicySingleSchema = z.object({ success: z.literal(true), data: PolicyItemSchema });
const ErrorSchema = z.object({
  success: z.literal(false),
  error: z.object({ code: z.string(), message: z.string() }),
});

const VALID_RULE = {
  pipelineType: 'quality_evaluation',
  metric: 'overall_score', // must match METRIC_REGISTRY['quality_evaluation']
  operator: 'gte',
  threshold: 0.8,
  severity: 'critical',
};

describe('Governance Policies Contract', () => {
  let harness: RuntimeApiHarness | undefined;
  let token: string;
  let projectId: string;

  beforeAll(async () => {
    harness = await startRuntimeServerHarness(
      {},
      {
        autoIndex: true,
        mongoDatabase: uniqueSlug('gov-contract-db'),
        requireAsyncInfra: false,
      },
    );
    const result = await bootstrapProject(
      harness,
      uniqueEmail('gov-contract'),
      uniqueSlug('gov-tenant'),
      uniqueSlug('gov-project'),
    );
    token = result.token;
    projectId = result.projectId;
  }, TIMEOUT_MS);

  afterAll(async () => {
    await harness?.close();
  }, 30_000);

  test('GET /governance/policies — empty list — response matches PoliciesListSchema', async () => {
    const res = await requestJson<unknown>(
      harness!,
      `/api/projects/${projectId}/governance/policies`,
      {
        headers: authHeaders(token),
      },
    );
    expect(res.status).toBe(200);
    const parsed = PoliciesListSchema.safeParse(res.body);
    expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
    if (parsed.success) {
      expect(parsed.data.data).toHaveLength(0);
    }
  });

  test('POST /governance/policies — created — response matches PolicySingleSchema', async () => {
    const res = await requestJson<unknown>(
      harness!,
      `/api/projects/${projectId}/governance/policies`,
      {
        method: 'POST',
        headers: authHeaders(token),
        body: { name: 'Contract Test Policy', rules: [VALID_RULE], status: 'enabled' },
      },
    );
    expect(res.status).toBe(201);
    const parsed = PolicySingleSchema.safeParse(res.body);
    expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
  });

  test('POST /governance/policies — duplicate name — 409 error matches ErrorSchema', async () => {
    await requestJson<unknown>(harness!, `/api/projects/${projectId}/governance/policies`, {
      method: 'POST',
      headers: authHeaders(token),
      body: { name: 'Duplicate Policy', rules: [VALID_RULE] },
    });
    const res = await requestJson<unknown>(
      harness!,
      `/api/projects/${projectId}/governance/policies`,
      {
        method: 'POST',
        headers: authHeaders(token),
        body: { name: 'Duplicate Policy', rules: [VALID_RULE] },
      },
    );
    expect(res.status).toBe(409);
    const parsed = ErrorSchema.safeParse(res.body);
    expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
  });

  test('POST /governance/policies — validation error — 400 error matches ErrorSchema', async () => {
    const res = await requestJson<unknown>(
      harness!,
      `/api/projects/${projectId}/governance/policies`,
      {
        method: 'POST',
        headers: authHeaders(token),
        body: { name: '', rules: [] }, // empty name + empty rules
      },
    );
    expect(res.status).toBe(400);
    const parsed = ErrorSchema.safeParse(res.body);
    expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
    if (parsed.success) {
      expect(parsed.data.error.code).toBe('GOVERNANCE_VALIDATION_ERROR');
    }
  });

  test('GET /governance/policies/:id — exists — response matches PolicySingleSchema', async () => {
    const createRes = await requestJson<{ success: true; data: { _id: string } }>(
      harness!,
      `/api/projects/${projectId}/governance/policies`,
      {
        method: 'POST',
        headers: authHeaders(token),
        body: { name: uniqueSlug('get-by-id'), rules: [VALID_RULE] },
      },
    );
    const policyId = createRes.body.data._id;

    const res = await requestJson<unknown>(
      harness!,
      `/api/projects/${projectId}/governance/policies/${policyId}`,
      { headers: authHeaders(token) },
    );
    expect(res.status).toBe(200);
    const parsed = PolicySingleSchema.safeParse(res.body);
    expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
  });

  test('GET /governance/policies/:id — not found — 404 error matches ErrorSchema', async () => {
    const res = await requestJson<unknown>(
      harness!,
      `/api/projects/${projectId}/governance/policies/000000000000000000000001`,
      { headers: authHeaders(token) },
    );
    expect(res.status).toBe(404);
    const parsed = ErrorSchema.safeParse(res.body);
    expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
  });

  test('PUT /governance/policies/:id — updated — response matches PolicySingleSchema', async () => {
    const createRes = await requestJson<{ success: true; data: { _id: string; version: number } }>(
      harness!,
      `/api/projects/${projectId}/governance/policies`,
      {
        method: 'POST',
        headers: authHeaders(token),
        body: { name: uniqueSlug('put-policy'), rules: [VALID_RULE] },
      },
    );
    const { _id: policyId, version } = createRes.body.data;

    const res = await requestJson<unknown>(
      harness!,
      `/api/projects/${projectId}/governance/policies/${policyId}`,
      {
        method: 'PUT',
        headers: authHeaders(token),
        body: {
          name: uniqueSlug('put-policy-updated'),
          rules: [{ ...VALID_RULE, threshold: 0.9 }],
          version,
        },
      },
    );
    expect(res.status).toBe(200);
    const parsed = PolicySingleSchema.safeParse(res.body);
    expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
  });

  test('PUT /governance/policies/:id — duplicate name — 409 error matches ErrorSchema', async () => {
    const firstName = uniqueSlug('put-duplicate-a');
    const secondName = uniqueSlug('put-duplicate-b');

    const firstRes = await requestJson<{ success: true; data: { _id: string } }>(
      harness!,
      `/api/projects/${projectId}/governance/policies`,
      {
        method: 'POST',
        headers: authHeaders(token),
        body: { name: firstName, rules: [VALID_RULE] },
      },
    );
    expect(firstRes.status).toBe(201);

    const secondRes = await requestJson<{ success: true; data: { _id: string; version: number } }>(
      harness!,
      `/api/projects/${projectId}/governance/policies`,
      {
        method: 'POST',
        headers: authHeaders(token),
        body: { name: secondName, rules: [VALID_RULE] },
      },
    );
    expect(secondRes.status).toBe(201);

    const res = await requestJson<unknown>(
      harness!,
      `/api/projects/${projectId}/governance/policies/${secondRes.body.data._id}`,
      {
        method: 'PUT',
        headers: authHeaders(token),
        body: {
          name: firstName,
          rules: [VALID_RULE],
          version: secondRes.body.data.version,
        },
      },
    );
    expect(res.status).toBe(409);
    const parsed = ErrorSchema.safeParse(res.body);
    expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
    if (parsed.success) {
      expect(parsed.data.error.code).toBe('GOVERNANCE_POLICY_EXISTS');
    }
  });

  test('DELETE /governance/policies/:id — no content (204)', async () => {
    const createRes = await requestJson<{ success: true; data: { _id: string } }>(
      harness!,
      `/api/projects/${projectId}/governance/policies`,
      {
        method: 'POST',
        headers: authHeaders(token),
        body: { name: uniqueSlug('delete-policy'), rules: [VALID_RULE] },
      },
    );
    const policyId = createRes.body.data._id;

    const res = await requestJson<unknown>(
      harness!,
      `/api/projects/${projectId}/governance/policies/${policyId}`,
      { method: 'DELETE', headers: authHeaders(token) },
    );
    expect(res.status).toBe(204);
  });

  test('GET /governance/status — no policies — response matches GovernanceStatusResponseSchema', async () => {
    const StatusResponseSchema = z.object({
      success: z.literal(true),
      data: z.object({
        period: z.string(),
        policies: z.array(z.object({ _id: z.string(), name: z.string(), status: z.string() })),
        agents: z.array(z.any()),
        summary: z.object({
          pass: z.number(),
          warn: z.number(),
          fail: z.number(),
          unavailable: z.number(),
        }),
      }),
    });

    const res = await requestJson<unknown>(
      harness!,
      `/api/projects/${projectId}/governance/status?period=7d`,
      { headers: authHeaders(token) },
    );
    expect(res.status).toBe(200);
    const parsed = StatusResponseSchema.safeParse(res.body);
    expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
    if (parsed.success) {
      expect(parsed.data.data.period).toBe('7d');
    }
  });

  test('GET /governance/audit — no policies — returns empty page matching AuditResponseSchema', async () => {
    const AuditResponseSchema = z.object({
      success: z.literal(true),
      data: z.object({
        events: z.array(z.any()),
        total: z.number(),
        page: z.number(),
        limit: z.number(),
      }),
    });

    const res = await requestJson<unknown>(
      harness!,
      `/api/projects/${projectId}/governance/audit?period=7d&page=1&limit=20`,
      { headers: authHeaders(token) },
    );
    expect(res.status).toBe(200);
    const parsed = AuditResponseSchema.safeParse(res.body);
    expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
    if (parsed.success) {
      expect(parsed.data.data.events).toHaveLength(0);
      expect(parsed.data.data.total).toBe(0);
    }
  });

  test('GET /governance/frameworks — returns 3 frameworks with valid contract shape', async () => {
    const FrameworksResponseSchema = z.object({
      success: z.literal(true),
      data: z.object({
        frameworks: z.array(
          z.object({
            id: z.enum(['SOC2', 'GDPR', 'EU_AI_ACT']),
            label: z.string(),
            controls: z.array(
              z.object({
                controlId: z.string(),
                requirement: z.string(),
                status: z.enum(['PASS', 'FAIL', 'WARN', 'NOT_EVALUATED']),
                evidence: z.string(),
              }),
            ),
          }),
        ),
      }),
    });

    const res = await requestJson<unknown>(
      harness!,
      `/api/projects/${projectId}/governance/frameworks?period=7d`,
      { headers: authHeaders(token) },
    );
    expect(res.status).toBe(200);
    const parsed = FrameworksResponseSchema.safeParse(res.body);
    expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
    if (parsed.success) {
      expect(parsed.data.data.frameworks).toHaveLength(3);
      // All controls have non-empty evidence
      for (const fw of parsed.data.data.frameworks) {
        for (const ctrl of fw.controls) {
          expect(ctrl.evidence).toBeTruthy();
        }
      }
      // SOC2 framework must be present with its controls
      const soc2 = parsed.data.data.frameworks.find((f) => f.id === 'SOC2');
      expect(soc2).toBeDefined();
      expect(soc2!.controls.length).toBeGreaterThan(0);
    }
  });

  test('Cross-tenant isolation: GET /governance/status returns 404 for wrong project', async () => {
    const res = await requestJson<unknown>(
      harness!,
      `/api/projects/000000000000000000000099/governance/status?period=7d`,
      { headers: authHeaders(token) },
    );
    // 403 or 404 — access denied without leaking existence
    expect([403, 404]).toContain(res.status);
  });
});
