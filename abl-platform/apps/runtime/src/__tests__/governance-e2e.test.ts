/**
 * Governance E2E Tests — Real ClickHouse Integration
 *
 * Exercises /status, /audit, and override endpoints with live local ClickHouse.
 * No mocks. Assertions stay on the public HTTP API, while analytics fixtures
 * are inserted directly into ClickHouse until Runtime exposes a public ingest
 * path for quality evaluation rows.
 *
 * Prerequisites:
 *   docker-compose up abl-clickhouse  (localhost:8124)
 *
 * Run:
 *   pnpm vitest run --config vitest.integration.config.ts src/__tests__/governance-e2e.test.ts
 */

import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import {
  startRuntimeServerHarness,
  type RuntimeApiHarness,
} from './helpers/runtime-api-harness.js';
import {
  bootstrapProject,
  setSuperAdmins,
  requestJson,
  uniqueEmail,
  uniqueSlug,
  authHeaders,
} from './helpers/channel-e2e-bootstrap.js';
import { z } from 'zod';

const CLICKHOUSE_URL_CANDIDATES = [
  'http://abl_admin:abl_dev_password@localhost:8124',
  'http://abl_admin:abl_dev_password@127.0.0.1:8124',
  'http://abl_admin:abl_dev_password@[::1]:8124',
] as const;
const TIMEOUT_MS = 120_000;

async function resolveClickHouseUrl(): Promise<string | null> {
  for (const candidate of CLICKHOUSE_URL_CANDIDATES) {
    try {
      const pingUrl = new URL(candidate);
      pingUrl.pathname = '/ping';
      pingUrl.search = '';
      const response = await fetch(pingUrl, { signal: AbortSignal.timeout(1_500) });
      if (response.ok) {
        return candidate;
      }
    } catch {
      // Try the next candidate.
    }
  }

  return null;
}

const CLICKHOUSE_URL = await resolveClickHouseUrl();

// ─── Contract Schemas ────────────────────────────────────────────────────────

const ErrorSchema = z.object({
  success: z.literal(false),
  error: z.object({ code: z.string(), message: z.string() }),
});

const StatusResponseSchema = z.object({
  success: z.literal(true),
  data: z.object({
    period: z.string(),
    policies: z.array(z.object({ _id: z.string(), name: z.string(), status: z.string() })),
    agents: z.array(
      z.object({
        agentName: z.string(),
        overallStatus: z.enum(['PASS', 'WARN', 'FAIL', 'NOT_EVALUATED']),
        rules: z.array(
          z.object({
            pipelineType: z.string(),
            metric: z.string(),
            status: z.enum(['PASS', 'FAIL', 'NOT_EVALUATED']),
            metricValue: z.number().nullable(),
            threshold: z.number(),
            severity: z.string(),
          }),
        ),
      }),
    ),
    summary: z.object({
      pass: z.number(),
      warn: z.number(),
      fail: z.number(),
      unavailable: z.number(),
    }),
  }),
});

const AuditEventSchema = z.object({
  eventRef: z.string(),
  timestamp: z.string(),
  pipelineType: z.string(),
  metric: z.string(),
  agentName: z.string(),
  agentVersion: z.string().optional(),
  threshold: z.number(),
  thresholdAtTime: z.number(),
  actualValue: z.number(),
  severity: z.string(),
  eventType: z.enum(['breach', 'recovery']),
  overrideId: z.string().optional(),
  reviewStatus: z.enum(['pending', 'approved', 'rejected']).optional(),
});

const AuditResponseSchema = z.object({
  success: z.literal(true),
  data: z.object({
    events: z.array(AuditEventSchema),
    total: z.number(),
    page: z.number(),
    limit: z.number(),
  }),
});

// ─── ClickHouse Helpers ──────────────────────────────────────────────────────

async function getChClient() {
  const { getClickHouseClient } = await import('@agent-platform/database/clickhouse');
  return getClickHouseClient();
}

async function insertQualityRows(
  tenantId: string,
  projectId: string,
  rows: { overallScore: number; agentName: string; sessionId: string }[],
): Promise<void> {
  const ch = await getChClient();
  const now = new Date().toISOString().replace('T', ' ').slice(0, 23);
  await ch.insert({
    table: 'abl_platform.quality_evaluations',
    values: rows.map((r) => ({
      tenant_id: tenantId,
      project_id: projectId,
      session_id: r.sessionId,
      session_started_at: now,
      processed_at: now,
      agent_name: r.agentName,
      agent_version: 'v1',
      channel: 'web',
      overall_score: r.overallScore,
      helpfulness: r.overallScore,
      accuracy: r.overallScore,
      professionalism: 0.5,
      instruction_following: 0.5,
      custom_dimensions: '{}',
      flagged: r.overallScore < 0.7 ? 1 : 0,
      flag_reasons: [],
      reasoning: '',
      model_id: 'gpt-4',
      config_version: 1,
      pipeline_version: '1.0.0',
    })),
    format: 'JSONEachRow',
  });
  // Allow async_insert buffer to flush (client default: busy_timeout_ms = 200)
  await new Promise((resolve) => setTimeout(resolve, 400));
}

async function deleteQualityRows(tenantId: string, projectId: string): Promise<void> {
  try {
    const ch = await getChClient();
    await ch.query({
      query: `ALTER TABLE abl_platform.quality_evaluations DELETE WHERE tenant_id = {tId:String} AND project_id = {pId:String}`,
      query_params: { tId: tenantId, pId: projectId },
    });
  } catch {
    // Fire-and-forget: ClickHouse DELETE is an async mutation; non-blocking for cleanup
  }
}

async function createPolicy(
  harness: RuntimeApiHarness,
  token: string,
  projectId: string,
  name: string,
  rules: object[],
  status = 'enabled',
): Promise<string> {
  const res = await requestJson<{ success: true; data: { _id: string } }>(
    harness,
    `/api/projects/${projectId}/governance/policies`,
    {
      method: 'POST',
      headers: authHeaders(token),
      body: { name, rules, status },
    },
  );
  if (res.status !== 201) {
    throw new Error(`createPolicy failed (${res.status}): ${JSON.stringify(res.body)}`);
  }
  return res.body.data._id;
}

// ─── Test Suite ──────────────────────────────────────────────────────────────

describe.skipIf(!CLICKHOUSE_URL)('Governance E2E — ClickHouse Integration', () => {
  let harness: RuntimeApiHarness | undefined;

  // Isolated contexts per scenario group
  let mvCtx: { token: string; tenantId: string; projectId: string; userId: string };
  let passCtx: { token: string; tenantId: string; projectId: string; userId: string };
  let failCtx: { token: string; tenantId: string; projectId: string; userId: string };
  let overrideCtx: { token: string; tenantId: string; projectId: string; userId: string };

  beforeAll(async () => {
    process.env.CLICKHOUSE_URL = CLICKHOUSE_URL!;

    harness = await startRuntimeServerHarness({ requireAsyncInfra: false });

    // Bootstrap sequentially; each call sets its own user as super admin.
    // Restore all users as super admin after all bootstraps complete.
    mvCtx = await bootstrapProject(
      harness,
      uniqueEmail('gov-mv'),
      uniqueSlug('gov-mv-t'),
      uniqueSlug('gov-mv-p'),
    );
    passCtx = await bootstrapProject(
      harness,
      uniqueEmail('gov-pass'),
      uniqueSlug('gov-pass-t'),
      uniqueSlug('gov-pass-p'),
    );
    failCtx = await bootstrapProject(
      harness,
      uniqueEmail('gov-fail'),
      uniqueSlug('gov-fail-t'),
      uniqueSlug('gov-fail-p'),
    );
    overrideCtx = await bootstrapProject(
      harness,
      uniqueEmail('gov-ovr'),
      uniqueSlug('gov-ovr-t'),
      uniqueSlug('gov-ovr-p'),
    );
    await setSuperAdmins([mvCtx.userId, passCtx.userId, failCtx.userId, overrideCtx.userId]);

    // Seed ClickHouse: good scores (avg ~0.9 → PASS threshold 0.8)
    await insertQualityRows(passCtx.tenantId, passCtx.projectId, [
      { overallScore: 0.9, agentName: 'test-agent', sessionId: 'pass-sess-1' },
      { overallScore: 0.92, agentName: 'test-agent', sessionId: 'pass-sess-2' },
      { overallScore: 0.88, agentName: 'test-agent', sessionId: 'pass-sess-3' },
    ]);

    // Seed ClickHouse: bad scores (avg ~0.55 → FAIL threshold 0.8)
    await insertQualityRows(failCtx.tenantId, failCtx.projectId, [
      { overallScore: 0.5, agentName: 'test-agent', sessionId: 'fail-sess-1' },
      { overallScore: 0.6, agentName: 'test-agent', sessionId: 'fail-sess-2' },
      { overallScore: 0.55, agentName: 'test-agent', sessionId: 'fail-sess-3' },
    ]);

    // Seed ClickHouse: breach scores for override context
    await insertQualityRows(overrideCtx.tenantId, overrideCtx.projectId, [
      { overallScore: 0.3, agentName: 'breach-agent', sessionId: 'ovr-sess-1' },
      { overallScore: 0.35, agentName: 'breach-agent', sessionId: 'ovr-sess-2' },
    ]);

    // Create enabled policies so routes hit ClickHouse
    await createPolicy(harness, passCtx.token, passCtx.projectId, 'Pass Policy', [
      {
        pipelineType: 'quality_evaluation',
        metric: 'overall_score',
        operator: 'gte',
        threshold: 0.8,
        severity: 'critical',
      },
    ]);
    await createPolicy(harness, failCtx.token, failCtx.projectId, 'Fail Policy', [
      {
        pipelineType: 'quality_evaluation',
        metric: 'overall_score',
        operator: 'gte',
        threshold: 0.8,
        severity: 'critical',
      },
    ]);
    await createPolicy(harness, overrideCtx.token, overrideCtx.projectId, 'Override Policy', [
      {
        pipelineType: 'quality_evaluation',
        metric: 'overall_score',
        operator: 'gte',
        threshold: 0.8,
        severity: 'critical',
      },
    ]);
  }, TIMEOUT_MS);

  afterAll(async () => {
    await Promise.allSettled([
      deleteQualityRows(passCtx?.tenantId, passCtx?.projectId),
      deleteQualityRows(failCtx?.tenantId, failCtx?.projectId),
      deleteQualityRows(overrideCtx?.tenantId, overrideCtx?.projectId),
    ]);
    await harness?.close();
  }, 60_000);

  // ─── 1. Metric Validation ───────────────────────────────────────────────────

  describe('Metric validation against METRIC_REGISTRY', () => {
    test('POST /policies with metric not in METRIC_REGISTRY returns 400', async () => {
      const res = await requestJson<unknown>(
        harness!,
        `/api/projects/${mvCtx.projectId}/governance/policies`,
        {
          method: 'POST',
          headers: authHeaders(mvCtx.token),
          body: {
            name: uniqueSlug('invalid-metric'),
            rules: [
              {
                pipelineType: 'quality_evaluation',
                metric: 'nonexistent_score',
                operator: 'gte',
                threshold: 0.8,
                severity: 'critical',
              },
            ],
          },
        },
      );
      expect(res.status).toBe(400);
      const parsed = ErrorSchema.safeParse(res.body);
      expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
      if (parsed.success) {
        expect(parsed.data.error.code).toBe('GOVERNANCE_VALIDATION_ERROR');
        expect(parsed.data.error.message).toContain('nonexistent_score');
      }
    });

    test('POST /policies with unknown pipelineType returns 400', async () => {
      const res = await requestJson<unknown>(
        harness!,
        `/api/projects/${mvCtx.projectId}/governance/policies`,
        {
          method: 'POST',
          headers: authHeaders(mvCtx.token),
          body: {
            name: uniqueSlug('invalid-pt'),
            rules: [
              {
                pipelineType: 'not_a_real_pipeline',
                metric: 'overall_score',
                operator: 'gte',
                threshold: 0.8,
                severity: 'critical',
              },
            ],
          },
        },
      );
      expect(res.status).toBe(400);
      const parsed = ErrorSchema.safeParse(res.body);
      expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
    });
  });

  // ─── 2. Status — PASS ───────────────────────────────────────────────────────

  describe('Status — avg score above threshold → PASS', () => {
    test('GET /status returns PASS when avg overall_score (0.9) ≥ threshold (0.8)', async () => {
      const res = await requestJson<unknown>(
        harness!,
        `/api/projects/${passCtx.projectId}/governance/status?period=7d`,
        { headers: authHeaders(passCtx.token) },
      );
      expect(res.status).toBe(200);
      const parsed = StatusResponseSchema.safeParse(res.body);
      expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
      if (!parsed.success) return;

      expect(parsed.data.data.policies).toHaveLength(1);
      expect(parsed.data.data.agents.length).toBeGreaterThan(0);

      const agent = parsed.data.data.agents[0];
      expect(agent.overallStatus).toBe('PASS');

      const rule = agent.rules.find((r) => r.metric === 'overall_score');
      expect(rule?.status).toBe('PASS');
      expect(rule?.metricValue).toBeGreaterThanOrEqual(0.8);

      expect(parsed.data.data.summary.pass).toBe(1);
      expect(parsed.data.data.summary.fail).toBe(0);
      expect(parsed.data.data.summary.unavailable).toBe(0);
    });

    test('GET /status period=30d still returns PASS (data within 30 days)', async () => {
      const res = await requestJson<unknown>(
        harness!,
        `/api/projects/${passCtx.projectId}/governance/status?period=30d`,
        { headers: authHeaders(passCtx.token) },
      );
      expect(res.status).toBe(200);
      const parsed = StatusResponseSchema.safeParse(res.body);
      expect(parsed.success).toBe(true);
      if (parsed.success) {
        expect(parsed.data.data.data?.period ?? (parsed.data.data as any).period).toBe('30d');
        expect(parsed.data.data.agents[0]?.overallStatus).toBe('PASS');
      }
    });
  });

  // ─── 3. Status — FAIL ───────────────────────────────────────────────────────

  describe('Status — avg score below threshold → FAIL', () => {
    test('GET /status returns FAIL when avg overall_score (0.55) < threshold (0.8)', async () => {
      const res = await requestJson<unknown>(
        harness!,
        `/api/projects/${failCtx.projectId}/governance/status?period=7d`,
        { headers: authHeaders(failCtx.token) },
      );
      expect(res.status).toBe(200);
      const parsed = StatusResponseSchema.safeParse(res.body);
      expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
      if (!parsed.success) return;

      const agent = parsed.data.data.agents[0];
      expect(agent.overallStatus).toBe('FAIL');

      const rule = agent.rules.find((r) => r.metric === 'overall_score');
      expect(rule?.status).toBe('FAIL');
      expect(rule?.metricValue).toBeLessThan(0.8);

      expect(parsed.data.data.summary.fail).toBe(1);
      expect(parsed.data.data.summary.pass).toBe(0);
    });
  });

  // ─── 4. Status — NOT_EVALUATED ──────────────────────────────────────────────

  describe('Status — policy exists but no ClickHouse data → NOT_EVALUATED', () => {
    let noDataPolicyId: string;

    beforeAll(async () => {
      noDataPolicyId = await createPolicy(
        harness!,
        mvCtx.token,
        mvCtx.projectId,
        uniqueSlug('no-data-policy'),
        [
          {
            pipelineType: 'quality_evaluation',
            metric: 'overall_score',
            operator: 'gte',
            threshold: 0.8,
            severity: 'critical',
          },
        ],
      );
    }, TIMEOUT_MS);

    afterAll(async () => {
      await requestJson(
        harness!,
        `/api/projects/${mvCtx.projectId}/governance/policies/${noDataPolicyId}`,
        { method: 'DELETE', headers: authHeaders(mvCtx.token) },
      );
    });

    test('GET /status returns NOT_EVALUATED when no ClickHouse rows exist for project', async () => {
      const res = await requestJson<unknown>(
        harness!,
        `/api/projects/${mvCtx.projectId}/governance/status?period=7d`,
        { headers: authHeaders(mvCtx.token) },
      );
      expect(res.status).toBe(200);
      const parsed = StatusResponseSchema.safeParse(res.body);
      expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
      if (!parsed.success) return;

      const agent = parsed.data.data.agents[0];
      expect(agent.overallStatus).toBe('NOT_EVALUATED');
      const rule = agent.rules.find((r) => r.metric === 'overall_score');
      expect(rule?.status).toBe('NOT_EVALUATED');
      expect(rule?.metricValue).toBeNull();
      expect(parsed.data.data.summary.unavailable).toBe(1);
    });
  });

  // ─── 5. Audit — Breach Events ───────────────────────────────────────────────

  describe('Audit — breach events from ClickHouse', () => {
    test('GET /audit returns breach events when scores breach threshold', async () => {
      const res = await requestJson<unknown>(
        harness!,
        `/api/projects/${failCtx.projectId}/governance/audit?period=7d&page=1&limit=50`,
        { headers: authHeaders(failCtx.token) },
      );
      expect(res.status).toBe(200);
      const parsed = AuditResponseSchema.safeParse(res.body);
      expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
      if (!parsed.success) return;

      expect(parsed.data.data.events.length).toBeGreaterThanOrEqual(3);
      expect(parsed.data.data.total).toBeGreaterThanOrEqual(3);

      const evt = parsed.data.data.events[0];
      expect(evt.pipelineType).toBe('quality_evaluation');
      expect(evt.metric).toBe('overall_score');
      expect(evt.eventType).toBe('breach');
      expect(evt.threshold).toBe(0.8);
      expect(evt.actualValue).toBeLessThan(0.8);
      expect(evt.severity).toBe('critical');
      expect(evt.agentName).toBe('test-agent');
    });

    test('GET /audit with pipelineType=quality_evaluation filter returns only quality events', async () => {
      const res = await requestJson<unknown>(
        harness!,
        `/api/projects/${failCtx.projectId}/governance/audit?period=7d&pipelineType=quality_evaluation`,
        { headers: authHeaders(failCtx.token) },
      );
      expect(res.status).toBe(200);
      const parsed = AuditResponseSchema.safeParse(res.body);
      expect(parsed.success).toBe(true);
      if (!parsed.success) return;
      expect(parsed.data.data.events.length).toBeGreaterThan(0);
      for (const evt of parsed.data.data.events) {
        expect(evt.pipelineType).toBe('quality_evaluation');
      }
    });

    test('GET /audit with non-matching pipelineType returns empty', async () => {
      const res = await requestJson<unknown>(
        harness!,
        `/api/projects/${failCtx.projectId}/governance/audit?period=7d&pipelineType=hallucination_detection`,
        { headers: authHeaders(failCtx.token) },
      );
      expect(res.status).toBe(200);
      const parsed = AuditResponseSchema.safeParse(res.body);
      expect(parsed.success).toBe(true);
      if (parsed.success) {
        expect(parsed.data.data.events).toHaveLength(0);
        expect(parsed.data.data.total).toBe(0);
      }
    });

    test('GET /audit returns no breach events when all scores pass threshold (PASS project)', async () => {
      const res = await requestJson<unknown>(
        harness!,
        `/api/projects/${passCtx.projectId}/governance/audit?period=7d`,
        { headers: authHeaders(passCtx.token) },
      );
      expect(res.status).toBe(200);
      const parsed = AuditResponseSchema.safeParse(res.body);
      expect(parsed.success).toBe(true);
      if (parsed.success) {
        expect(parsed.data.data.events).toHaveLength(0);
        expect(parsed.data.data.total).toBe(0);
      }
    });

    test('GET /audit eventRef contains pipelineType, agentName, metric, and timestamp', async () => {
      const res = await requestJson<{
        success: true;
        data: { events: Array<{ eventRef: string; agentName: string }> };
      }>(harness!, `/api/projects/${failCtx.projectId}/governance/audit?period=7d&limit=1`, {
        headers: authHeaders(failCtx.token),
      });
      expect(res.status).toBe(200);
      const evt = res.body.data.events[0];
      expect(evt.eventRef).toMatch(/^quality_evaluation:/);
      expect(evt.eventRef).toContain(':overall_score:');
      expect(evt.agentName).toBe('test-agent');
    });
  });

  // ─── 6. Override ────────────────────────────────────────────────────────────

  describe('Override — create, dedup, and reflect in audit', () => {
    let firstEventRef: string;

    beforeAll(async () => {
      const auditRes = await requestJson<{
        success: true;
        data: { events: Array<{ eventRef: string }> };
      }>(harness!, `/api/projects/${overrideCtx.projectId}/governance/audit?period=7d&limit=1`, {
        headers: authHeaders(overrideCtx.token),
      });
      expect(auditRes.status).toBe(200);
      const events = auditRes.body.data?.events ?? [];
      if (events.length === 0) {
        throw new Error(
          'Override test setup: no breach events found — ClickHouse seed may not have flushed',
        );
      }
      firstEventRef = events[0].eventRef;
    }, TIMEOUT_MS);

    test('POST /audit/:eventRef/override creates override and returns 201', async () => {
      const encoded = encodeURIComponent(firstEventRef);
      const res = await requestJson<unknown>(
        harness!,
        `/api/projects/${overrideCtx.projectId}/governance/audit/${encoded}/override`,
        {
          method: 'POST',
          headers: authHeaders(overrideCtx.token),
          body: {
            justification: 'Acknowledged — one-time anomaly during maintenance window',
            originalSeverity: 'critical',
            policyVersion: 1,
          },
        },
      );
      expect(res.status).toBe(201);
      const parsed = z
        .object({ success: z.literal(true), data: z.object({ _id: z.string() }) })
        .safeParse(res.body);
      expect(parsed.success, JSON.stringify((res.body as any)?.error)).toBe(true);
    });

    test('GET /audit shows overrideId on the overridden event', async () => {
      const res = await requestJson<{
        success: true;
        data: { events: Array<{ eventRef: string; overrideId?: string }> };
      }>(harness!, `/api/projects/${overrideCtx.projectId}/governance/audit?period=7d`, {
        headers: authHeaders(overrideCtx.token),
      });
      expect(res.status).toBe(200);
      const event = res.body.data.events.find((e) => e.eventRef === firstEventRef);
      expect(event).toBeDefined();
      expect(event?.overrideId).toBeTruthy();
    });

    test('POST /audit/:eventRef/override duplicate returns 409', async () => {
      const encoded = encodeURIComponent(firstEventRef);
      const res = await requestJson<unknown>(
        harness!,
        `/api/projects/${overrideCtx.projectId}/governance/audit/${encoded}/override`,
        {
          method: 'POST',
          headers: authHeaders(overrideCtx.token),
          body: {
            justification: 'Duplicate attempt',
            originalSeverity: 'critical',
            policyVersion: 1,
          },
        },
      );
      expect(res.status).toBe(409);
      const parsed = ErrorSchema.safeParse(res.body);
      expect(parsed.success).toBe(true);
      if (parsed.success) {
        expect(parsed.data.error.code).toBe('GOVERNANCE_OVERRIDE_EXISTS');
      }
    });
  });

  // ─── 7. Cross-Tenant Isolation ──────────────────────────────────────────────

  describe('Cross-tenant isolation', () => {
    test('GET /status using another tenant token returns 403 or 404', async () => {
      // passCtx.token (tenant A) tries to access failCtx.projectId (tenant B)
      const res = await requestJson<unknown>(
        harness!,
        `/api/projects/${failCtx.projectId}/governance/status?period=7d`,
        { headers: authHeaders(passCtx.token) },
      );
      expect([403, 404]).toContain(res.status);
    });

    test('GET /audit using another tenant token returns 403 or 404', async () => {
      const res = await requestJson<unknown>(
        harness!,
        `/api/projects/${failCtx.projectId}/governance/audit?period=7d`,
        { headers: authHeaders(passCtx.token) },
      );
      expect([403, 404]).toContain(res.status);
    });

    test('POST /policies using another tenant token returns 403 or 404', async () => {
      const res = await requestJson<unknown>(
        harness!,
        `/api/projects/${failCtx.projectId}/governance/policies`,
        {
          method: 'POST',
          headers: authHeaders(passCtx.token),
          body: {
            name: 'Injection Attempt',
            rules: [
              {
                pipelineType: 'quality_evaluation',
                metric: 'overall_score',
                operator: 'gte',
                threshold: 0.8,
                severity: 'critical',
              },
            ],
          },
        },
      );
      expect([403, 404]).toContain(res.status);
    });
  });
});
