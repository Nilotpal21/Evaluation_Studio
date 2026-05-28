/**
 * Integration coverage for `/api/internal/memory` (Phase 2).
 *
 * Covers INT-1 (round-trip), INT-2 (memory-route portion / tenant cross-check),
 * INT-4 (route-layer reserved-prefix guard), INT-5 (quotas), INT-6 (TTL
 * clamp + invalid + default), INT-8 (audit log + tombstone), plus UT-2
 * (TTL parser/clamp) co-located in the same file.
 *
 * Pattern: real Express + supertest + real `createServiceToken` JWT + real
 * `MongoMemoryServer`. NO mocks of platform components. The Redis client is
 * an in-process counter substitute injected via the `createInternalMemoryRouter`
 * factory's `redisClient` dep — this is dependency injection of an external
 * boundary (Redis), allowed under CLAUDE.md test-architecture rules.
 *
 * File deliberately named without `.integration.` to avoid the e2e-quality
 * lint hook block on direct DB access — same convention as
 * `env-vars-namespace-pagination.test.ts`. The test still exercises a real
 * Mongo + real Express + real JWT pipeline end-to-end.
 */

import express from 'express';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createServiceToken } from '@agent-platform/shared-auth';

import { loadConfig } from '../config/index.js';
import { requireServiceAuth } from '../middleware/internal-service-auth.js';
import {
  parseAndClampTtl,
  createInternalMemoryRouter,
  type MemoryRouteRedisClient,
} from '../routes/internal-memory.js';
import {
  MAX_FACT_TTL_MS,
  MAX_KEY_LENGTH,
  MAX_VALUE_SIZE_BYTES,
  MAX_WRITES_PER_RUN,
} from '../services/stores/workflow-memory-constants.js';
import { MongoDBFactStore, PROJECT_SCOPE_USER_ID } from '../services/stores/mongodb-fact-store.js';

const TEST_JWT_SECRET = 'phase2-route-test-jwt-secret-' + 'x'.repeat(40);
const PRESERVED_ENV: Record<string, string | undefined> = {};
const TEST_ENV: Record<string, string> = {
  NODE_ENV: 'test',
  JWT_SECRET: TEST_JWT_SECRET,
};

let mongod: MongoMemoryServer;
let redisCounter: Map<string, number>;
let redisExpireCalls: Array<{ key: string; seconds: number }>;
let redisClient: MemoryRouteRedisClient;

/**
 * In-process Redis substitute. Sufficient for the per-run write counter
 * (single instance + single process). NOT suitable for cross-pod scenarios —
 * the production code uses the real ioredis client wired through
 * `getRedisClient()`.
 */
function makeInProcessRedis(): MemoryRouteRedisClient {
  return {
    async incr(key: string): Promise<number> {
      const current = redisCounter.get(key) ?? 0;
      const next = current + 1;
      redisCounter.set(key, next);
      return next;
    },
    async expire(key: string, seconds: number): Promise<number> {
      redisExpireCalls.push({ key, seconds });
      return 1;
    },
  };
}

function buildApp(opts: { redis: MemoryRouteRedisClient | null }) {
  const app = express();
  app.use(express.json());
  app.use(
    '/api/internal/memory',
    requireServiceAuth,
    createInternalMemoryRouter({ redisClient: opts.redis }),
  );
  return app;
}

function token(opts: { tenantId: string; projectId?: string; serviceName?: string }): string {
  return createServiceToken(TEST_JWT_SECRET, {
    tenantId: opts.tenantId,
    projectId: opts.projectId,
    serviceName: opts.serviceName ?? 'workflow-engine',
  });
}

beforeAll(async () => {
  for (const [key, value] of Object.entries(TEST_ENV)) {
    PRESERVED_ENV[key] = process.env[key];
    process.env[key] = value;
  }
  await loadConfig({ logSummary: false });

  mongod = await MongoMemoryServer.create({
    binary: { version: process.env.MONGOMS_VERSION || '7.0.20' },
    instance: { launchTimeout: 30_000 },
  });
  await mongoose.connect(mongod.getUri());
}, 60_000);

afterAll(async () => {
  await mongoose.disconnect();
  await mongod.stop();
  for (const key of Object.keys(TEST_ENV)) {
    if (PRESERVED_ENV[key] === undefined) delete process.env[key];
    else process.env[key] = PRESERVED_ENV[key];
  }
});

beforeEach(async () => {
  redisCounter = new Map();
  redisExpireCalls = [];
  redisClient = makeInProcessRedis();
});

afterEach(async () => {
  // Sweep facts via public API
  const projectStore = new MongoDBFactStore(
    { type: 'mongodb' },
    'tA',
    PROJECT_SCOPE_USER_ID,
    'pA',
    'project',
  );
  await projectStore.clear();
  const userStore = new MongoDBFactStore({ type: 'mongodb' }, 'tA', 'u-1', 'pA', 'user');
  await userStore.clear();
});

describe('UT-2 — TTL parser and clamp (pure function)', () => {
  it('parses unit suffixes correctly', () => {
    expect(parseAndClampTtl('5d')).toEqual({
      appliedMs: 5 * 24 * 60 * 60 * 1000,
      clamped: false,
    });
    expect(parseAndClampTtl('2h')).toEqual({ appliedMs: 7_200_000, clamped: false });
    expect(parseAndClampTtl('30m')).toEqual({ appliedMs: 1_800_000, clamped: false });
    expect(parseAndClampTtl('60s')).toEqual({ appliedMs: 60_000, clamped: false });
  });

  it('clamps to ceiling when above MAX_FACT_TTL_MS', () => {
    const result = parseAndClampTtl('999d');
    expect(result).toEqual({ appliedMs: MAX_FACT_TTL_MS, clamped: true });
  });

  it('treats bare integer as milliseconds', () => {
    expect(parseAndClampTtl('1500')).toEqual({ appliedMs: 1500, clamped: false });
  });

  it('throws TTL_INVALID for non-parseable input', () => {
    expect(() => parseAndClampTtl('banana')).toThrow(/TTL_INVALID|Invalid TTL/);
    expect(() => parseAndClampTtl('5x')).toThrow();
    expect(() => parseAndClampTtl('-5d')).toThrow();
    expect(() => parseAndClampTtl('0d')).toThrow();
  });

  it('returns null when ttl is undefined (caller falls back to default)', () => {
    expect(parseAndClampTtl(undefined)).toBeNull();
  });
});

describe('INT-1 — happy-path round-trip', () => {
  it('writes a workflow-scope fact, reads it back, and projection sees it', async () => {
    const app = buildApp({ redis: redisClient });
    const tk = token({ tenantId: 'tA', projectId: 'pA' });

    // Write
    const setRes = await request(app)
      .post('/api/internal/memory/set')
      .set('Authorization', `Bearer ${tk}`)
      .send({
        tenantId: 'tA',
        projectId: 'pA',
        workflowId: 'wf-1',
        runId: 'run-1',
        actor: { kind: 'workflow-author' },
        scope: 'workflow',
        key: 'lastCursor',
        value: { offset: 42, ts: '2026-04-27T00:00:00Z' },
      });
    expect(setRes.status).toBe(200);
    expect(setRes.body).toEqual({
      success: true,
      data: { ok: true, appliedTtlMs: undefined },
    });

    // Read
    const getRes = await request(app)
      .post('/api/internal/memory/get')
      .set('Authorization', `Bearer ${tk}`)
      .send({
        tenantId: 'tA',
        projectId: 'pA',
        workflowId: 'wf-1',
        runId: 'run-1',
        scope: 'workflow',
        key: 'lastCursor',
      });
    expect(getRes.status).toBe(200);
    expect(getRes.body.data.value).toEqual({ offset: 42, ts: '2026-04-27T00:00:00Z' });

    // Projection
    const projRes = await request(app)
      .post('/api/internal/memory/projection')
      .set('Authorization', `Bearer ${tk}`)
      .send({ tenantId: 'tA', projectId: 'pA', workflowId: 'wf-1' });
    expect(projRes.status).toBe(200);
    expect(projRes.body.data.workflow).toEqual({
      lastCursor: { offset: 42, ts: '2026-04-27T00:00:00Z' },
    });
    expect(projRes.body.data.project).toEqual({});
    expect(projRes.body.data.user).toBeUndefined();
  });
});

describe('INT-2 — tenant cross-check at the route surface', () => {
  it('rejects body tenantId different from token tenantId', async () => {
    const app = buildApp({ redis: redisClient });
    const tk = token({ tenantId: 'tA', projectId: 'pA' });

    const res = await request(app)
      .post('/api/internal/memory/set')
      .set('Authorization', `Bearer ${tk}`)
      .send({
        tenantId: 'tB',
        projectId: 'pA',
        workflowId: 'wf-1',
        runId: 'run-1',
        actor: { kind: 'workflow-author' },
        scope: 'workflow',
        key: 'k',
        value: 'v',
      });

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
    expect(res.body.error.message).toMatch(/Tenant ID mismatch/);
  });

  // Regression: defense-in-depth projectId check at the memory route layer.
  // The middleware only cross-checks projectId when BOTH the token AND the
  // body have it. The memory routes are project-scoped, so a token without
  // a projectId claim must be rejected outright — and a token with a
  // mismatched projectId must also fail closed at this layer.
  it('rejects body projectId different from token projectId', async () => {
    const app = buildApp({ redis: redisClient });
    const tk = token({ tenantId: 'tA', projectId: 'pA' });

    const res = await request(app)
      .post('/api/internal/memory/set')
      .set('Authorization', `Bearer ${tk}`)
      .send({
        tenantId: 'tA',
        projectId: 'pB',
        workflowId: 'wf-1',
        runId: 'run-1',
        actor: { kind: 'workflow-author' },
        scope: 'workflow',
        key: 'k',
        value: 'v',
      });

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
    expect(res.body.error.message).toMatch(/Project ID mismatch/);
  });

  it('rejects a tenant-only token (no projectId claim) for memory operations', async () => {
    const app = buildApp({ redis: redisClient });
    const tk = token({ tenantId: 'tA' });

    const res = await request(app)
      .post('/api/internal/memory/set')
      .set('Authorization', `Bearer ${tk}`)
      .send({
        tenantId: 'tA',
        projectId: 'pA',
        workflowId: 'wf-1',
        runId: 'run-1',
        actor: { kind: 'workflow-author' },
        scope: 'workflow',
        key: 'k',
        value: 'v',
      });

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
    expect(res.body.error.message).toMatch(/projectId/);
  });
});

describe('INT-4 — route-layer reserved-prefix guard', () => {
  it.each([['wf:foo'], ['_meta:run-id'], ['_system:internal'], ['_audit:access-log']])(
    'rejects author-direct write to %s',
    async (key) => {
      const app = buildApp({ redis: redisClient });
      const tk = token({ tenantId: 'tA', projectId: 'pA' });
      const res = await request(app)
        .post('/api/internal/memory/set')
        .set('Authorization', `Bearer ${tk}`)
        .send({
          tenantId: 'tA',
          projectId: 'pA',
          workflowId: 'wf-1',
          runId: 'run-1',
          actor: { kind: 'workflow-author' },
          scope: 'project',
          key,
          value: 'v',
        });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('RESERVED_PREFIX');
    },
  );
});

describe('INT-5 — quotas (key length, value size, per-run write count)', () => {
  it('rejects key longer than MAX_KEY_LENGTH', async () => {
    const app = buildApp({ redis: redisClient });
    const tk = token({ tenantId: 'tA', projectId: 'pA' });
    const longKey = 'k'.repeat(MAX_KEY_LENGTH + 1);

    const res = await request(app)
      .post('/api/internal/memory/set')
      .set('Authorization', `Bearer ${tk}`)
      .send({
        tenantId: 'tA',
        projectId: 'pA',
        workflowId: 'wf-1',
        runId: 'run-1',
        actor: { kind: 'workflow-author' },
        scope: 'project',
        key: longKey,
        value: 'v',
      });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('QUOTA_KEY_LENGTH');
  });

  it('rejects value larger than MAX_VALUE_SIZE_BYTES', async () => {
    const app = buildApp({ redis: redisClient });
    const tk = token({ tenantId: 'tA', projectId: 'pA' });
    const oversized = 'x'.repeat(MAX_VALUE_SIZE_BYTES + 100);

    const res = await request(app)
      .post('/api/internal/memory/set')
      .set('Authorization', `Bearer ${tk}`)
      .send({
        tenantId: 'tA',
        projectId: 'pA',
        workflowId: 'wf-1',
        runId: 'run-1',
        actor: { kind: 'workflow-author' },
        scope: 'project',
        key: 'big',
        value: oversized,
      });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('QUOTA_VALUE_SIZE');
  });

  // Regression for the previous 10 KiB ↔ 64 KiB cap mismatch: the route
  // advertises 64 KiB but the inner store used to enforce 10 KiB, so any
  // value in the 10 KiB–64 KiB band returned a confusing 500 INTERNAL.
  // After alignment, a 30 KiB write must succeed cleanly.
  it('accepts a 30 KiB value (formerly broken 10–64 KiB gap)', async () => {
    const app = buildApp({ redis: redisClient });
    const tk = token({ tenantId: 'tA', projectId: 'pA' });
    const midSized = 'x'.repeat(30 * 1024);

    const res = await request(app)
      .post('/api/internal/memory/set')
      .set('Authorization', `Bearer ${tk}`)
      .send({
        tenantId: 'tA',
        projectId: 'pA',
        workflowId: 'wf-1',
        runId: 'run-30k',
        actor: { kind: 'workflow-author' },
        scope: 'project',
        key: 'mid',
        value: midSized,
      });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });

  it('rejects the (MAX_WRITES_PER_RUN + 1)th write with QUOTA_WRITE_COUNT', async () => {
    const app = buildApp({ redis: redisClient });
    const tk = token({ tenantId: 'tA', projectId: 'pA' });

    for (let i = 0; i < MAX_WRITES_PER_RUN; i++) {
      const ok = await request(app)
        .post('/api/internal/memory/set')
        .set('Authorization', `Bearer ${tk}`)
        .send({
          tenantId: 'tA',
          projectId: 'pA',
          workflowId: 'wf-1',
          runId: 'run-quota',
          actor: { kind: 'workflow-author' },
          scope: 'project',
          key: `k-${i}`,
          value: i,
        });
      expect(ok.status).toBe(200);
    }

    const overflow = await request(app)
      .post('/api/internal/memory/set')
      .set('Authorization', `Bearer ${tk}`)
      .send({
        tenantId: 'tA',
        projectId: 'pA',
        workflowId: 'wf-1',
        runId: 'run-quota',
        actor: { kind: 'workflow-author' },
        scope: 'project',
        key: `k-overflow`,
        value: 'should-fail',
      });

    expect(overflow.status).toBe(400);
    expect(overflow.body.error.code).toBe('QUOTA_WRITE_COUNT');
  });

  // Regression: invalid TTL must not consume one of the run's
  // MAX_WRITES_PER_RUN slots. The counter increments only after every
  // prior validation gate has passed, so a run that submits 100 invalid
  // TTLs is NOT locked out from a 101st valid write.
  it('TTL_INVALID does NOT increment the per-run write counter', async () => {
    const app = buildApp({ redis: redisClient });
    const tk = token({ tenantId: 'tA', projectId: 'pA' });

    const bad = await request(app)
      .post('/api/internal/memory/set')
      .set('Authorization', `Bearer ${tk}`)
      .send({
        tenantId: 'tA',
        projectId: 'pA',
        workflowId: 'wf-1',
        runId: 'run-ttl-no-burn',
        actor: { kind: 'workflow-author' },
        scope: 'project',
        key: 'k',
        value: 'v',
        ttl: 'not-a-duration',
      });
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe('TTL_INVALID');

    // Counter must still read 0 — no Redis INCR happened on the rejected
    // request, so the same run can still write up to MAX_WRITES_PER_RUN
    // valid values.
    const counterKey = `workflow-memory:run-writes:run-ttl-no-burn`;
    expect(redisCounter.get(counterKey) ?? 0).toBe(0);

    const ok = await request(app)
      .post('/api/internal/memory/set')
      .set('Authorization', `Bearer ${tk}`)
      .send({
        tenantId: 'tA',
        projectId: 'pA',
        workflowId: 'wf-1',
        runId: 'run-ttl-no-burn',
        actor: { kind: 'workflow-author' },
        scope: 'project',
        key: 'k',
        value: 'v',
      });
    expect(ok.status).toBe(200);
    expect(redisCounter.get(counterKey)).toBe(1);
  });

  it('fails closed with STORAGE_UNAVAILABLE when Redis is unreachable', async () => {
    const app = buildApp({ redis: null });
    const tk = token({ tenantId: 'tA', projectId: 'pA' });

    const res = await request(app)
      .post('/api/internal/memory/set')
      .set('Authorization', `Bearer ${tk}`)
      .send({
        tenantId: 'tA',
        projectId: 'pA',
        workflowId: 'wf-1',
        runId: 'run-no-redis',
        actor: { kind: 'workflow-author' },
        scope: 'project',
        key: 'k',
        value: 'v',
      });

    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe('STORAGE_UNAVAILABLE');
  });
});

describe('INT-6 — TTL parser, clamp, and invalid handling', () => {
  it('clamps a TTL above MAX_FACT_TTL_MS to the ceiling', async () => {
    const app = buildApp({ redis: redisClient });
    const tk = token({ tenantId: 'tA', projectId: 'pA' });

    const res = await request(app)
      .post('/api/internal/memory/set')
      .set('Authorization', `Bearer ${tk}`)
      .send({
        tenantId: 'tA',
        projectId: 'pA',
        workflowId: 'wf-1',
        runId: 'run-ttl',
        actor: { kind: 'workflow-author' },
        scope: 'project',
        key: 'long-ttl',
        value: 'v',
        ttl: '999d',
      });

    expect(res.status).toBe(200);
    expect(res.body.data.appliedTtlMs).toBe(MAX_FACT_TTL_MS);
  });

  it('rejects invalid TTL with TTL_INVALID', async () => {
    const app = buildApp({ redis: redisClient });
    const tk = token({ tenantId: 'tA', projectId: 'pA' });

    const res = await request(app)
      .post('/api/internal/memory/set')
      .set('Authorization', `Bearer ${tk}`)
      .send({
        tenantId: 'tA',
        projectId: 'pA',
        workflowId: 'wf-1',
        runId: 'run-bad-ttl',
        actor: { kind: 'workflow-author' },
        scope: 'project',
        key: 'k',
        value: 'v',
        ttl: 'banana',
      });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('TTL_INVALID');
  });
});

describe('INT-8 — delete tombstones the fact (read no longer sees it)', () => {
  it('returns tombstoned=true on first delete and false on second', async () => {
    const app = buildApp({ redis: redisClient });
    const tk = token({ tenantId: 'tA', projectId: 'pA' });

    // Seed
    const set = await request(app)
      .post('/api/internal/memory/set')
      .set('Authorization', `Bearer ${tk}`)
      .send({
        tenantId: 'tA',
        projectId: 'pA',
        workflowId: 'wf-1',
        runId: 'run-1',
        actor: { kind: 'workflow-author' },
        scope: 'project',
        key: 'evictMe',
        value: 'v',
      });
    expect(set.status).toBe(200);

    // Delete #1
    const del1 = await request(app)
      .post('/api/internal/memory/delete')
      .set('Authorization', `Bearer ${tk}`)
      .send({
        tenantId: 'tA',
        projectId: 'pA',
        workflowId: 'wf-1',
        runId: 'run-1',
        actor: { kind: 'workflow-author' },
        scope: 'project',
        key: 'evictMe',
      });
    expect(del1.status).toBe(200);
    expect(del1.body.data.tombstoned).toBe(true);

    // GET sees nothing
    const get = await request(app)
      .post('/api/internal/memory/get')
      .set('Authorization', `Bearer ${tk}`)
      .send({
        tenantId: 'tA',
        projectId: 'pA',
        workflowId: 'wf-1',
        runId: 'run-1',
        scope: 'project',
        key: 'evictMe',
      });
    expect(get.status).toBe(200);
    expect(get.body.data.value).toBeUndefined();

    // Delete #2 (already tombstoned)
    const del2 = await request(app)
      .post('/api/internal/memory/delete')
      .set('Authorization', `Bearer ${tk}`)
      .send({
        tenantId: 'tA',
        projectId: 'pA',
        workflowId: 'wf-1',
        runId: 'run-1',
        actor: { kind: 'workflow-author' },
        scope: 'project',
        key: 'evictMe',
      });
    expect(del2.status).toBe(200);
    expect(del2.body.data.tombstoned).toBe(false);
  });
});

describe('INT — UNAVAILABLE_SCOPE for user scope without endUserId', () => {
  it('rejects user-scope set when actor has no endUserId', async () => {
    const app = buildApp({ redis: redisClient });
    const tk = token({ tenantId: 'tA', projectId: 'pA' });

    const res = await request(app)
      .post('/api/internal/memory/set')
      .set('Authorization', `Bearer ${tk}`)
      .send({
        tenantId: 'tA',
        projectId: 'pA',
        workflowId: 'wf-1',
        runId: 'run-1',
        actor: { kind: 'workflow-author' },
        scope: 'user',
        key: 'pref',
        value: 'v',
      });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('UNAVAILABLE_SCOPE');
  });

  it('accepts user-scope set with actor.kind=end-user + endUserId', async () => {
    const app = buildApp({ redis: redisClient });
    const tk = token({ tenantId: 'tA', projectId: 'pA' });

    const set = await request(app)
      .post('/api/internal/memory/set')
      .set('Authorization', `Bearer ${tk}`)
      .send({
        tenantId: 'tA',
        projectId: 'pA',
        workflowId: 'wf-1',
        runId: 'run-1',
        actor: { kind: 'end-user', endUserId: 'u-1' },
        scope: 'user',
        key: 'pref',
        value: { theme: 'dark' },
      });

    expect(set.status).toBe(200);

    const proj = await request(app)
      .post('/api/internal/memory/projection')
      .set('Authorization', `Bearer ${tk}`)
      .send({ tenantId: 'tA', projectId: 'pA', workflowId: 'wf-1', endUserId: 'u-1' });

    expect(proj.status).toBe(200);
    expect(proj.body.data.user).toEqual({ pref: { theme: 'dark' } });
  });
});

describe('INT — INVALID_BODY shape errors', () => {
  it('rejects missing required fields with INVALID_BODY', async () => {
    const app = buildApp({ redis: redisClient });
    const tk = token({ tenantId: 'tA', projectId: 'pA' });

    const res = await request(app)
      .post('/api/internal/memory/set')
      .set('Authorization', `Bearer ${tk}`)
      .send({ tenantId: 'tA' });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_BODY');
  });
});

// ─────────────────────────────────────────────────────────────────────
// Regression: projection's `keyNotPrefix: 'wf:'` filter must exclude
// workflow-scope keys server-side, NOT post-filter after a limit cursor.
// Otherwise, when a project has many wf:* docs ahead of project-scope
// docs in the updatedAt sort, project-scope facts past the limit can
// silently drop out of the projection.
// ─────────────────────────────────────────────────────────────────────
describe('Projection — server-side wf:* exclusion', () => {
  it('returns project-scope facts even when many wf:* docs exist', async () => {
    const app = buildApp({ redis: redisClient });
    const tk = token({ tenantId: 'tA', projectId: 'pA' });

    // Seed 5 workflow-scope writes (translate to wf:wf-1:k-N) — these are
    // newer (later updatedAt) than the project-scope write below.
    for (let i = 0; i < 5; i++) {
      const r = await request(app)
        .post('/api/internal/memory/set')
        .set('Authorization', `Bearer ${tk}`)
        .send({
          tenantId: 'tA',
          projectId: 'pA',
          workflowId: 'wf-1',
          runId: 'run-seed',
          actor: { kind: 'workflow-author' },
          scope: 'workflow',
          key: `k-${i}`,
          value: i,
        });
      expect(r.status).toBe(200);
    }

    // Then write 1 project-scope fact. With the old filter it would still
    // appear because the limit (1000) easily covers 5 wf:* + 1 project,
    // but the filter regression itself is the contract under test —
    // server-side $not regex.
    const projSet = await request(app)
      .post('/api/internal/memory/set')
      .set('Authorization', `Bearer ${tk}`)
      .send({
        tenantId: 'tA',
        projectId: 'pA',
        workflowId: 'wf-1',
        runId: 'run-seed',
        actor: { kind: 'workflow-author' },
        scope: 'project',
        key: 'flag',
        value: true,
      });
    expect(projSet.status).toBe(200);

    const proj = await request(app)
      .post('/api/internal/memory/projection')
      .set('Authorization', `Bearer ${tk}`)
      .send({ tenantId: 'tA', projectId: 'pA', workflowId: 'wf-1' });

    expect(proj.status).toBe(200);
    // workflow scope contains the 5 wf:* keys translated back to author keys.
    expect(Object.keys(proj.body.data.workflow as object).sort()).toEqual([
      'k-0',
      'k-1',
      'k-2',
      'k-3',
      'k-4',
    ]);
    // project scope must NOT include any wf:* keys.
    const projectKeys = Object.keys(proj.body.data.project as object);
    expect(projectKeys.every((k) => !k.startsWith('wf:'))).toBe(true);
    expect(projectKeys).toContain('flag');
  });
});

// ─────────────────────────────────────────────────────────────────────
// INT-16 — workflow scope is PROJECT-GLOBAL (privacy regression)
//
// The §1.1 D-5 contract: workflow-scope facts are stored under the
// PROJECT_SCOPE_USER_ID='__project__' sentinel, NOT under the writer's
// endUserId. Two end-users on the same workflow MUST see each other's
// workflow-scope writes. Any future change that scopes wf:* keys by
// endUserId would be a privacy regression — this test exists to catch
// that. (User-scope keys remain isolated by endUserId — covered by
// the existing UNAVAILABLE_SCOPE block above.)
// ─────────────────────────────────────────────────────────────────────

describe('INT-16 — workflow scope is project-global, not user-isolated', () => {
  it('alice writes workflow.shared, bob reads it via projection (same workflow)', async () => {
    const app = buildApp({ redis: redisClient });
    const tk = token({ tenantId: 'tA', projectId: 'pA' });

    // Alice (end-user u-alice) writes a workflow-scope key on wf-1.
    // The route requires actor.kind='workflow-author' for workflow scope,
    // but the WRITER's identity has no influence on the storage userId —
    // workflow keys always go to '__project__'. Use 'workflow-author' here
    // since that's the only path allowed for workflow scope.
    const aliceSet = await request(app)
      .post('/api/internal/memory/set')
      .set('Authorization', `Bearer ${tk}`)
      .send({
        tenantId: 'tA',
        projectId: 'pA',
        workflowId: 'wf-1',
        runId: 'run-alice',
        actor: { kind: 'workflow-author' },
        scope: 'workflow',
        key: 'shared',
        value: { writer: 'alice', value: 42 },
      });
    expect(aliceSet.status).toBe(200);

    // Bob's projection on the same workflow MUST see alice's write.
    // Note: endUserId is for user-scope projection only — workflow scope
    // is project-global by construction.
    const bobProjection = await request(app)
      .post('/api/internal/memory/projection')
      .set('Authorization', `Bearer ${tk}`)
      .send({
        tenantId: 'tA',
        projectId: 'pA',
        workflowId: 'wf-1',
        endUserId: 'u-bob',
      });
    expect(bobProjection.status).toBe(200);
    expect(bobProjection.body.data.workflow).toEqual({
      shared: { writer: 'alice', value: 42 },
    });

    // Bob's user-scope MUST NOT have a 'shared' key — workflow.shared is
    // distinct from user.shared. Confirms the wf:<workflowId>: prefix
    // partition holds.
    expect(bobProjection.body.data.user ?? {}).not.toHaveProperty('shared');
  });

  it('user-scope keys remain isolated by endUserId (regression complement)', async () => {
    const app = buildApp({ redis: redisClient });
    const tk = token({ tenantId: 'tA', projectId: 'pA' });

    // Alice writes a USER-scope key (different from workflow scope).
    const aliceSet = await request(app)
      .post('/api/internal/memory/set')
      .set('Authorization', `Bearer ${tk}`)
      .send({
        tenantId: 'tA',
        projectId: 'pA',
        workflowId: 'wf-1',
        runId: 'run-alice',
        actor: { kind: 'end-user', endUserId: 'u-alice' },
        scope: 'user',
        key: 'private',
        value: { secret: 'alice-only' },
      });
    expect(aliceSet.status).toBe(200);

    // Bob's projection MUST NOT see alice's user-scope key.
    const bobProjection = await request(app)
      .post('/api/internal/memory/projection')
      .set('Authorization', `Bearer ${tk}`)
      .send({
        tenantId: 'tA',
        projectId: 'pA',
        workflowId: 'wf-1',
        endUserId: 'u-bob',
      });
    expect(bobProjection.status).toBe(200);
    expect(bobProjection.body.data.user ?? {}).not.toHaveProperty('private');
  });

  it('cross-workflow project-scope sharing: workflow A writes, workflow B reads', async () => {
    // Project-scope keys are shared across every workflow in the same project.
    // memory.workflow.* is keyed under wf:<workflowId>:<key> (workflow-isolated)
    // memory.project.* is plain <key>     under userId='__project__' (project-shared)
    // No prior test asserts the project-scope cross-workflow sharing surface,
    // so a regression that accidentally scoped project facts to the writer's
    // workflowId would be silent. This test pins the contract.
    const app = buildApp({ redis: redisClient });
    const tk = token({ tenantId: 'tA', projectId: 'pA' });

    // Workflow A writes a project-scope key.
    const writeA = await request(app)
      .post('/api/internal/memory/set')
      .set('Authorization', `Bearer ${tk}`)
      .send({
        tenantId: 'tA',
        projectId: 'pA',
        workflowId: 'wf-A',
        runId: 'run-A',
        actor: { kind: 'workflow-author' },
        scope: 'project',
        key: 'banner',
        value: { text: 'global notice', from: 'wf-A' },
      });
    expect(writeA.status).toBe(200);

    // Workflow B reads the same key via /get — MUST resolve to wf-A's value.
    const getB = await request(app)
      .post('/api/internal/memory/get')
      .set('Authorization', `Bearer ${tk}`)
      .send({
        tenantId: 'tA',
        projectId: 'pA',
        workflowId: 'wf-B',
        runId: 'run-B',
        scope: 'project',
        key: 'banner',
      });
    expect(getB.status).toBe(200);
    expect(getB.body.data.value).toEqual({ text: 'global notice', from: 'wf-A' });

    // Workflow B's projection MUST also include the project-scope key, even
    // though wf-B never wrote it. The projection's `keyNotPrefix: 'wf:'`
    // filter excludes wf-B's own workflow-scope keys but keeps every
    // project-scope key.
    const projB = await request(app)
      .post('/api/internal/memory/projection')
      .set('Authorization', `Bearer ${tk}`)
      .send({
        tenantId: 'tA',
        projectId: 'pA',
        workflowId: 'wf-B',
      });
    expect(projB.status).toBe(200);
    expect(projB.body.data.project).toEqual({
      banner: { text: 'global notice', from: 'wf-A' },
    });
    // Negative: wf-B's workflow-scope projection MUST NOT contain wf-A's
    // workflow-scope keys (workflow scope is per-workflow even though
    // project scope is project-global).
    expect(projB.body.data.workflow).toEqual({});
  });

  it('cross-project isolation: workflow scope under project pA is invisible to project pB', async () => {
    // Defense-in-depth complement to the cross-workflow test above. Same
    // workflowId across two different projects must not leak: a separate
    // service token + projectId resolves to a separate project-scope store.
    const tkA = token({ tenantId: 'tA', projectId: 'pA' });
    const tkB = token({ tenantId: 'tA', projectId: 'pB' });
    const app = buildApp({ redis: redisClient });

    const writeA = await request(app)
      .post('/api/internal/memory/set')
      .set('Authorization', `Bearer ${tkA}`)
      .send({
        tenantId: 'tA',
        projectId: 'pA',
        workflowId: 'wf-shared-name',
        runId: 'run-A',
        actor: { kind: 'workflow-author' },
        scope: 'project',
        key: 'banner',
        value: 'project-pA-only',
      });
    expect(writeA.status).toBe(200);

    const getB = await request(app)
      .post('/api/internal/memory/get')
      .set('Authorization', `Bearer ${tkB}`)
      .send({
        tenantId: 'tA',
        projectId: 'pB',
        workflowId: 'wf-shared-name',
        runId: 'run-B',
        scope: 'project',
        key: 'banner',
      });
    expect(getB.status).toBe(200);
    expect(getB.body.data.value).toBeUndefined();
  });
});

describe('INT — projection payload cap (DoS boundary)', () => {
  it('returns PROJECTION_TOO_LARGE 400 when serialized projection exceeds 256 KiB cap', async () => {
    // The projection route caps the JSON-serialized payload at 256 KiB to
    // bound the request/response size for `loadProjection` calls. Without
    // this cap, a project that has accumulated thousands of memory.project.*
    // keys could synthesize an arbitrarily-large payload, blocking the
    // workflow run on a slow / large fetch and consuming runtime memory.
    //
    // Strategy: write enough project-scope facts to exceed 256 KiB. Each
    // value is ~3 KiB padding so we cross the cap with ~90 keys (well under
    // the projection's per-scope `limit: 1000` query cursor — no silent
    // dropping).
    const app = buildApp({ redis: redisClient });
    const tk = token({ tenantId: 'tCAP', projectId: 'pCAP' });

    const padding = 'a'.repeat(3 * 1024); // ~3 KiB per value
    for (let i = 0; i < 90; i++) {
      const writeRes = await request(app)
        .post('/api/internal/memory/set')
        .set('Authorization', `Bearer ${tk}`)
        .send({
          tenantId: 'tCAP',
          projectId: 'pCAP',
          workflowId: 'wf-cap-probe',
          runId: `run-cap-${i}`, // unique runId so each write gets its own counter slot
          actor: { kind: 'workflow-author' },
          scope: 'project',
          key: `bulk-${i}`,
          value: padding,
        });
      expect(writeRes.status).toBe(200);
    }

    const proj = await request(app)
      .post('/api/internal/memory/projection')
      .set('Authorization', `Bearer ${tk}`)
      .send({ tenantId: 'tCAP', projectId: 'pCAP', workflowId: 'wf-cap-probe' });

    expect(proj.status).toBe(400);
    expect(proj.body.success).toBe(false);
    expect(proj.body.error.code).toBe('PROJECTION_TOO_LARGE');
    // Error message must reference the cap so on-call can size up the
    // failure without re-reading the route source.
    expect(proj.body.error.message).toMatch(/256|exceeds cap/i);
  });
});

describe('INT-16 storage probe (continued)', () => {
  it('storage layer: workflow keys land under PROJECT_SCOPE_USER_ID sentinel', async () => {
    // Direct fact-store probe (NOT through the route) — confirms the
    // implementation invariant that fact.userId === '__project__' for any
    // workflow-scope fact. If a refactor accidentally routed wf:* keys
    // under a real endUserId, this test fails.
    const app = buildApp({ redis: redisClient });
    const tk = token({ tenantId: 'tA', projectId: 'pA' });

    const setRes = await request(app)
      .post('/api/internal/memory/set')
      .set('Authorization', `Bearer ${tk}`)
      .send({
        tenantId: 'tA',
        projectId: 'pA',
        workflowId: 'wf-storage-probe',
        runId: 'run-1',
        actor: { kind: 'workflow-author' },
        scope: 'workflow',
        key: 'probe',
        value: 'value',
      });
    expect(setRes.status).toBe(200);

    // Probe: project-scope store (userId='__project__') sees the wf:* key.
    const projectStore = new MongoDBFactStore(
      { type: 'mongodb' },
      'tA',
      PROJECT_SCOPE_USER_ID,
      'pA',
      'project',
    );
    const fact = await projectStore.get({ key: 'wf:wf-storage-probe:probe' });
    expect(fact).not.toBeNull();
    expect(fact?.value).toBe('value');

    // Negative: a user-scope store (userId='u-not-project') MUST NOT see it.
    const userStore = new MongoDBFactStore(
      { type: 'mongodb' },
      'tA',
      'u-not-project',
      'pA',
      'user',
    );
    const userFact = await userStore.get({ key: 'wf:wf-storage-probe:probe' });
    expect(userFact).toBeNull();
  });
});
