/**
 * INT-3 — Isolate-side memory ops via real `RuntimeMemoryClient` and real
 * runtime memory route. Verifies the full Phase 4 chain:
 *
 *    function-node script
 *        → memory.workflow.set(...)              [in-isolate global]
 *        → _memorySet.applySyncPromise(...)      [host ivm.Reference]
 *        → RuntimeMemoryClient.set(...)          [HTTP client]
 *        → POST /api/internal/memory/set         [real route]
 *        → MongoDBFactStore.set(...)             [real Mongo via MongoMemoryServer]
 *
 * INT-12 — Retry idempotency: setting the same key twice with the same value
 * is a no-op from the author's POV (last write wins; no state corruption).
 *
 * Filename without `.integration.` to match the convention in
 * `runtime-memory-client-http.test.ts` and `internal-memory-route.test.ts` —
 * the tests use real Mongo + real Express but interact only via the public
 * surfaces (`MongoDBFactStore.clear()` for cleanup, HTTP for assertions).
 */

import express from 'express';
import { createServer, type Server } from 'node:http';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { loadConfig } from '../../../runtime/src/config/index.js';
import { requireServiceAuth } from '../../../runtime/src/middleware/internal-service-auth.js';
import {
  createInternalMemoryRouter,
  type MemoryRouteRedisClient,
} from '../../../runtime/src/routes/internal-memory.js';
import {
  MongoDBFactStore,
  PROJECT_SCOPE_USER_ID,
} from '../../../runtime/src/services/stores/mongodb-fact-store.js';

import { RuntimeMemoryClient } from '../clients/runtime-memory-client.js';
import {
  executeFunctionStep,
  type FunctionExecutorDeps,
  type FunctionStep,
} from '../executors/function-executor.js';
import type { WorkflowContextData } from '../context/expression-resolver.js';

const TEST_JWT_SECRET = 'iso-mem-' + 'x'.repeat(56);
const PRESERVED_ENV: Record<string, string | undefined> = {};
const TEST_ENV: Record<string, string> = {
  NODE_ENV: 'test',
  JWT_SECRET: TEST_JWT_SECRET,
};

let mongod: MongoMemoryServer;
let server: Server;
let baseUrl: string;
let redisCounter: Map<string, number>;
let memoryClient: RuntimeMemoryClient;

function makeInProcessRedis(): MemoryRouteRedisClient {
  return {
    async incr(key: string): Promise<number> {
      const next = (redisCounter.get(key) ?? 0) + 1;
      redisCounter.set(key, next);
      return next;
    },
    async expire(): Promise<number> {
      return 1;
    },
  };
}

function makeCtx(overrides?: Partial<WorkflowContextData>): WorkflowContextData {
  return {
    trigger: { type: 'studio', payload: {} },
    workflow: { id: 'wf-iso-1', name: 'iso-test', executionId: 'exec-iso-1' },
    tenant: { tenantId: 'tenant-iso', projectId: 'project-iso' },
    steps: {},
    vars: {},
    memory: { workflow: {}, project: {}, user: undefined },
    ...overrides,
  };
}

function makeStep(code: string): FunctionStep {
  return { id: 'fn-iso', type: 'function', config: { code, timeout: 10 } };
}

function depsFor(actorEndUserId?: string): FunctionExecutorDeps {
  return {
    memoryClient,
    runId: 'exec-iso-1',
    actor: actorEndUserId
      ? { kind: 'end-user', endUserId: actorEndUserId }
      : { kind: 'workflow-author' },
  };
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

  redisCounter = new Map();
  const app = express();
  app.use(express.json({ limit: '10mb' }));
  app.use(
    '/api/internal/memory',
    requireServiceAuth,
    createInternalMemoryRouter({ redisClient: makeInProcessRedis() }),
  );

  server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('failed to bind integration server');
  }
  baseUrl = `http://127.0.0.1:${address.port}`;

  memoryClient = new RuntimeMemoryClient({
    baseUrl,
    serviceTokenSecret: TEST_JWT_SECRET,
    // Production default is 5 s (MEMORY_OP_TIMEOUT_MS). The INT-3 path here
    // boots a real V8 isolate, real Express, real MongoDB on every test, and
    // routinely exceeds 5 s on a loaded laptop or CI runner cold-starting
    // mongodb-memory-server. Per-call timeout still applies — we just give
    // the cold-start round-trip enough headroom that an unrelated 16-package
    // pre-push run doesn't trip the AbortSignal.
    defaultTimeoutMs: 30_000,
  });
}, 60_000);

afterAll(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((err) => (err ? reject(err) : resolve())),
  );
  await mongoose.disconnect();
  await mongod.stop();
  for (const key of Object.keys(TEST_ENV)) {
    if (PRESERVED_ENV[key] === undefined) delete process.env[key];
    else process.env[key] = PRESERVED_ENV[key];
  }
});

beforeEach(async () => {
  redisCounter = new Map();
  const projectStore = new MongoDBFactStore(
    { type: 'mongodb' },
    'tenant-iso',
    PROJECT_SCOPE_USER_ID,
    'project-iso',
    'project',
  );
  await projectStore.clear();
});

describe('INT-3 — Function-node memory ops via real isolate + real route', () => {
  it('script: memory.workflow.set + memory.workflow.get round-trips through the runtime', async () => {
    const ctx = makeCtx();
    const step = makeStep(`
      memory.workflow.set('cursor', 'page-7');
      context.echo = memory.workflow.get('cursor');
    `);
    const result = await executeFunctionStep(step, ctx, depsFor());
    expect((result.output as Record<string, unknown>).echo).toBe('page-7');
    // The host-side projection was updated in-run too — visible to subsequent
    // steps via context.memory.workflow.cursor (FR-14).
    expect(ctx.memory?.workflow.cursor).toBe('page-7');
  });

  it('script: structured value (object) round-trips with type fidelity', async () => {
    const ctx = makeCtx();
    const step = makeStep(`
      memory.workflow.set('profile', { name: 'Alice', score: 42, tags: ['a', 'b'] });
      context.profile = memory.workflow.get('profile');
    `);
    const result = await executeFunctionStep(step, ctx, depsFor());
    const out = (result.output as Record<string, unknown>).profile as Record<string, unknown>;
    expect(out.name).toBe('Alice');
    expect(out.score).toBe(42);
    expect(out.tags).toEqual(['a', 'b']);
  });

  it('script: memory.workflow.delete tombstones — subsequent get returns undefined', async () => {
    const ctx = makeCtx();
    const step = makeStep(`
      memory.workflow.set('temp', 1);
      memory.workflow.delete('temp');
      context.afterDelete = memory.workflow.get('temp');
      context.afterDeleteType = typeof memory.workflow.get('temp');
    `);
    const result = await executeFunctionStep(step, ctx, depsFor());
    expect((result.output as Record<string, unknown>).afterDelete).toBeUndefined();
    expect((result.output as Record<string, unknown>).afterDeleteType).toBe('undefined');
  });

  it('script: project-scope set is visible to a fresh isolate (cross-run persistence)', async () => {
    const ctx1 = makeCtx();
    const writeStep = makeStep(`memory.project.set('banner', 'maintenance-window');`);
    await executeFunctionStep(writeStep, ctx1, depsFor());

    // Fresh ctx — confirms the value is read from the runtime, not in-memory.
    const ctx2 = makeCtx();
    const readStep = makeStep(`context.banner = memory.project.get('banner');`);
    const result = await executeFunctionStep(readStep, ctx2, depsFor());
    expect((result.output as Record<string, unknown>).banner).toBe('maintenance-window');
  });

  it('script: RESERVED_PREFIX from route propagates as throw inside isolate', async () => {
    const ctx = makeCtx();
    const step = makeStep(`
      try { memory.project.set('wf:hijack', 'pwned'); context.fail = 'NO_THROW'; }
      catch (e) { context.captured = String(e && e.message || e); }
    `);
    const result = await executeFunctionStep(step, ctx, depsFor());
    const out = result.output as Record<string, unknown>;
    expect(out.fail).toBeUndefined();
    expect(String(out.captured)).toContain('RESERVED_PREFIX');
  });

  it('script: user-scope op with end-user actor reads/writes per-user store', async () => {
    const ctx = makeCtx();
    const writeStep = makeStep(`memory.user.set('preferredLanguage', 'fr');`);
    await executeFunctionStep(writeStep, ctx, depsFor('user-iso-9'));

    const readStep = makeStep(`context.lang = memory.user.get('preferredLanguage');`);
    const ctx2 = makeCtx();
    const result = await executeFunctionStep(readStep, ctx2, depsFor('user-iso-9'));
    expect((result.output as Record<string, unknown>).lang).toBe('fr');

    // A different end-user does NOT see user-iso-9's value.
    const ctx3 = makeCtx();
    const isolatedRead = makeStep(`
      const v = memory.user.get('preferredLanguage');
      context.lang = v === undefined ? '__none__' : v;
    `);
    const result3 = await executeFunctionStep(isolatedRead, ctx3, depsFor('user-iso-other'));
    expect((result3.output as Record<string, unknown>).lang).toBe('__none__');
  });
});

describe('INT-12 — Retry idempotency', () => {
  it('two identical sets followed by a get reads the value once (no duplication)', async () => {
    // Per LLD §1 and §13.5: workflow function nodes are NOT inside Restate's
    // ctx.run() journal — but the runtime route MUST be idempotent enough
    // that retries don't produce duplicate records or corrupt reads.
    // MongoDBFactStore upserts; setting the same key twice is a write of the
    // current value. The `get` returns whatever the latest write was.
    const ctx = makeCtx();
    const step = makeStep(`
      memory.workflow.set('counter', 1);
      memory.workflow.set('counter', 1); // identical retry
      context.echoed = memory.workflow.get('counter');
    `);
    const result = await executeFunctionStep(step, ctx, depsFor());
    expect((result.output as Record<string, unknown>).echoed).toBe(1);
  });

  it('overlapping sets (same key, different values) — last writer wins', async () => {
    const ctx = makeCtx();
    const step = makeStep(`
      memory.workflow.set('rev', 'v1');
      memory.workflow.set('rev', 'v2');
      memory.workflow.set('rev', 'v3');
      context.final = memory.workflow.get('rev');
    `);
    const result = await executeFunctionStep(step, ctx, depsFor());
    expect((result.output as Record<string, unknown>).final).toBe('v3');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// GAP-018 closure (contract-level): exercise the agentSession ↔ actor.endUserId
// derivation that `step-dispatcher.ts` performs in production. The full chat
// → agent → workflow-tool E2E harness lives outside the workflow E2E surface
// (see GAP-018 in feature spec §16); these two tests close the contract gap
// at the runtime boundary where it actually matters: a script that reads
// `agentSession.endUserId` and calls `memory.user.set` must store the value
// under the SAME endUserId, AND a second script run with the same endUserId
// must be able to read it back. Cross-endUserId reads must remain isolated.
// Together with INT-13 (workflow-tool-executor-projection.test.ts — proves
// `triggerMetadata` enrichment) this proves the full chain.
// ─────────────────────────────────────────────────────────────────────────────

describe('INT-3 + INT-13 — agentSession ↔ memory.user actor derivation (GAP-018 contract)', () => {
  it('script reads agentSession.endUserId and memory.user.set persists under same endUserId', async () => {
    // Synthetic agentSession matching what `workflow-tool-executor.ts` would
    // build for an agent-bound workflow run: positive-list projection,
    // deep-frozen, with `endUserId` set to the contact ID. The dispatcher's
    // actor derivation rule (step-dispatcher.ts:298-300) makes
    // actor.endUserId === agentSession.endUserId for end-user runs.
    const contactId = 'contact-gap018-' + Math.random().toString(36).slice(2, 10);
    const ctx = makeCtx({
      agentSession: Object.freeze({
        sessionId: 'sess-gap018-1',
        agentName: 'concierge',
        channel: 'web',
        source: 'public' as const,
        endUserId: contactId,
      }),
    });

    // Function body reads its own endUserId via `context.agentSession`
    // (the deep-frozen positive-list projection), calls memory.user.set with
    // that as the implicit actor, then re-reads and exposes both for
    // assertion. Note: agentSession is reachable via `context.agentSession`,
    // NOT as a bare top-level global — that's the v1 contract per
    // function-executor.ts:481-499 where `context` is a Proxy over
    // `__baseData` and bare globals are NOT injected at script scope for
    // the agent objects (they are for `memory`, which has special handling).
    const writeStep = makeStep(`
      const ses = context.agentSession;
      const seenEndUserId = (ses && ses.endUserId) || null;
      memory.user.set('preferredLanguage', 'fr');
      const readBack = memory.user.get('preferredLanguage');
      context.seenEndUserId = seenEndUserId;
      context.readBack = readBack;
    `);

    const result = await executeFunctionStep(writeStep, ctx, depsFor(contactId));
    const output = result.output as Record<string, unknown>;

    // The script saw its own endUserId (proves agentSession is wired through
    // the WorkflowContextData → V8 isolate boundary).
    expect(output.seenEndUserId).toBe(contactId);

    // The same value the script wrote is readable in the same run (FR-14
    // in-run projection update). This also proves the route persisted under
    // the right endUserId — a second run below confirms cross-run.
    expect(output.readBack).toBe('fr');

    // Cross-run read with the SAME end-user actor sees the persisted value.
    // This is the actual cross-trigger / cross-run continuity at the
    // user-scope: a fresh isolate, same endUserId, no agentSession needed
    // (the route persists by `userId`, not by agentSession identity).
    const readCtx = makeCtx();
    const readStep = makeStep(`context.lang = memory.user.get('preferredLanguage');`);
    const readResult = await executeFunctionStep(readStep, readCtx, depsFor(contactId));
    expect((readResult.output as Record<string, unknown>).lang).toBe('fr');
  });

  it('workflow-as-tool nesting surrogate — both runs with same end-user see the same memory.user', async () => {
    // E2E-5 (workflow-as-tool nesting) requires the inner workflow to inherit
    // the OUTERMOST agent's endUserId — that propagation happens at the
    // runtime layer (workflow-tool-executor.ts builds agentSession for the
    // inner call from the outermost session). At the function-executor
    // boundary, what matters is: two sequential runs with the SAME actor
    // see the same memory.user.* state. This is the proof the nested run
    // would see, AS LONG AS the upstream propagation is intact (verified
    // separately by INT-13).
    const sharedEndUser = 'contact-nest-' + Math.random().toString(36).slice(2, 10);

    const outerWrite = makeStep(`memory.user.set('lastSeen', 'outer-wrote-this');`);
    await executeFunctionStep(outerWrite, makeCtx(), depsFor(sharedEndUser));

    const innerRead = makeStep(`context.lastSeen = memory.user.get('lastSeen');`);
    const innerResult = await executeFunctionStep(innerRead, makeCtx(), depsFor(sharedEndUser));
    expect((innerResult.output as Record<string, unknown>).lastSeen).toBe('outer-wrote-this');

    // A different end-user — simulating "workflow run from a DIFFERENT
    // chat session" — must NOT see the outer's lastSeen. This is the
    // negative-isolation half of the assertion.
    const otherEndUser = 'contact-nest-other-' + Math.random().toString(36).slice(2, 10);
    const otherRead = makeStep(`
      const v = memory.user.get('lastSeen');
      context.lastSeen = v === undefined ? '__none__' : v;
    `);
    const otherResult = await executeFunctionStep(otherRead, makeCtx(), depsFor(otherEndUser));
    expect((otherResult.output as Record<string, unknown>).lastSeen).toBe('__none__');
  });
});
