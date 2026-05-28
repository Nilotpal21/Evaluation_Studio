/**
 * System E2E: Connector Polling Chain
 *
 * Drives the full Studio → register → BullMQ → poll → fire → Restate chain
 * that broke when commit 27f03ee221 deleted the connector-delegation branch
 * in TriggerEngine.register() and wasn't caught for 2+ weeks.
 *
 * What's real:
 *   - MongoMemoryServer (real Mongoose schemas, real $inc/$set persistence)
 *   - Redis via docker-compose (BullMQ repeatable jobs need real streams)
 *   - workflow-engine TriggerEngine (the service Studio calls through)
 *   - connectors TriggerEngine (delegated to for connector-backed triggers)
 *   - BullMQ Queue + Worker (repeatable polling at a 1-second cadence)
 *   - Inline polling-style test-connector (returns configurable items)
 *
 * What's stubbed:
 *   - RestateIngressClient — vi.fn() spy (Restate is an external boundary)
 *   - Auth resolver — returns an empty creds object (no connection table)
 *
 * Scenarios:
 *   S1. Happy path — register → worker fires → Restate receives startWorkflow
 *   S2. Register-time delegation — connector path is taken, not the cron
 *       scheduler path (guards against the Gmail regression)
 *   S3. Pause/resume — pause stops Restate calls; resume re-wires delivery
 *   S4. Boot-time rehydrate — seeded active connector triggers get their
 *       BullMQ jobs re-enqueued on workflow-engine boot
 *
 * Runs under `pnpm test:system`. Skipped when Redis or Mongo are unavailable
 * so the tier remains runnable without docker-compose.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { Queue, Worker } from 'bullmq';
import { Redis } from 'ioredis';
import { scanKeys } from '@agent-platform/redis';
import crypto from 'crypto';
import {
  ConnectorRegistry,
  TriggerEngine as ConnectorTriggerEngine,
  processPollingJob,
  type WorkflowTriggerInput,
} from '@agent-platform/connectors';
import { TriggerRegistration } from '@agent-platform/database/models';
import { TriggerEngine } from '../services/trigger-engine.js';
import { rehydrateConnectorTriggers } from '../services/connector-trigger-rehydrator.js';

// ─── Constants ─────────────────────────────────────────────────────────────

const TENANT_ID = 'tenant-e2e-polling';
const PROJECT_ID = 'project-e2e-polling';
const WORKFLOW_ID = 'wf-e2e-polling';
const CONNECTION_ID = 'conn-e2e-polling';
const CONNECTOR_NAME = 'e2e-polling-connector';
const TRIGGER_NAME = 'poll_new_items';

/** Fast polling cadence so the Worker fires within the test timeout. */
const POLLING_INTERVAL_MS = 1_000;

/** Polling scheduler clamps to MIN_POLLING_INTERVAL_MS (10s today). */
const EFFECTIVE_POLLING_INTERVAL_MS = 10_000;

const DEFAULT_REDIS_URL = 'redis://:localdev@127.0.0.1:6380';

// ─── Fixtures ──────────────────────────────────────────────────────────────

/** Items the test connector emits per run. Mutable so tests can stage new items. */
let stagedItems: Array<Record<string, unknown>> = [];

function buildRegistry(): ConnectorRegistry {
  const registry = new ConnectorRegistry();
  registry.register({
    name: CONNECTOR_NAME,
    displayName: 'E2E Polling Connector',
    version: '1.0.0',
    description: 'Inline connector for the polling E2E test',
    auth: { type: 'none' as const },
    actions: [],
    triggers: [
      {
        name: TRIGGER_NAME,
        displayName: 'Poll New Items',
        description: 'Emits staged items on each run',
        triggerType: 'cron' as const,
        props: [],
        pollingIntervalMs: POLLING_INTERVAL_MS,
        async run() {
          // Snapshot + clear staged items so the same items aren't re-emitted
          // (matches the cursor-advance behaviour of real polling connectors).
          const snap = stagedItems;
          stagedItems = [];
          return snap;
        },
      } as any,
    ],
  } as any);
  return registry;
}

// ─── Harness ───────────────────────────────────────────────────────────────

/** Everything the suite wires up — kept in one struct so teardown is trivial. */
interface Harness {
  registry: ConnectorRegistry;
  pollingQueue: Queue;
  cronQueue: Queue;
  worker: Worker;
  connectorTriggerEngine: ConnectorTriggerEngine;
  triggerEngine: TriggerEngine;
  restateSpy: { calls: Array<{ executionId: string; input: WorkflowTriggerInput }> };
  redisClient: Redis;
  sharedConnections: Redis[];
}

async function buildHarness(): Promise<Harness> {
  const redisUrl = process.env.REDIS_URL || DEFAULT_REDIS_URL;
  const redisClient = new Redis(redisUrl, { maxRetriesPerRequest: null });
  // Force connect so we fail fast if Redis is unavailable.
  await redisClient.ping();

  // Nuke any BullMQ keys left behind by prior test runs or crashed harnesses.
  // This is the only reliable way to make the suite deterministic — BullMQ's
  // repeatable scheduler stores delayed-job metadata that survives obliterate
  // when the queue instance that wrote it is gone.
  // Use scanKeys (cluster-safe) instead of KEYS command
  const stalePolling: string[] = [];
  for await (const k of scanKeys(redisClient, 'bull:connector-polling:*')) stalePolling.push(k);
  const staleCron: string[] = [];
  for await (const k of scanKeys(redisClient, 'bull:connector-cron:*')) staleCron.push(k);
  // Per-key DEL for cluster compatibility (multi-key DEL requires same slot)
  if (stalePolling.length > 0) await Promise.all(stalePolling.map((k) => redisClient.del(k)));
  if (staleCron.length > 0) await Promise.all(staleCron.map((k) => redisClient.del(k)));

  const sharedConnections: Redis[] = [];
  const queueConnection = redisClient.duplicate({ maxRetriesPerRequest: null });
  const cronQueueConnection = redisClient.duplicate({ maxRetriesPerRequest: null });
  const workerConnection = redisClient.duplicate({ maxRetriesPerRequest: null });
  sharedConnections.push(queueConnection, cronQueueConnection, workerConnection);

  const pollingQueue = new Queue('connector-polling', { connection: queueConnection });
  const cronQueue = new Queue('connector-cron', { connection: cronQueueConnection });

  // Restate spy — records calls, never throws.
  const restateSpy: Harness['restateSpy'] = { calls: [] };

  const registry = buildRegistry();

  // In-memory KV store for dedup / cursor state (external infra surface).
  const storeFactory = (connectionId: string) => {
    const bag = new Map<string, unknown>();
    return {
      async get<T>(key: string): Promise<T | undefined> {
        return bag.get(`${connectionId}:${key}`) as T | undefined;
      },
      async set(key: string, value: unknown): Promise<void> {
        bag.set(`${connectionId}:${key}`, value);
      },
      async delete(key: string): Promise<void> {
        bag.delete(`${connectionId}:${key}`);
      },
    };
  };

  const connectorTriggerEngine = new ConnectorTriggerEngine({
    registry,
    registrationModel: TriggerRegistration as any,
    restateClient: {
      startWorkflow: async (executionId, input) => {
        restateSpy.calls.push({ executionId, input });
      },
    } as any,
    redis: redisClient as any,
    pollingQueue: pollingQueue as any,
    cronQueue: cronQueue as any,
    decryptSecret: async (ct: string) => ct,
    storeFactory,
  });

  // Real BullMQ Worker — drains jobs through processPollingJob.
  const worker = new Worker(
    'connector-polling',
    async (job) => {
      await processPollingJob(job.data as any, {
        registry,
        registrationModel: TriggerRegistration as any,
        restateClient: {
          startWorkflow: async (executionId, input) => {
            restateSpy.calls.push({ executionId, input });
          },
        } as any,
        queue: pollingQueue as any,
        storeFactory,
        workflowResolver: {
          async resolve() {
            return { workflowName: 'E2E Polling Workflow', steps: [] };
          },
        },
      });
    },
    { connection: workerConnection, concurrency: 1 },
  );
  // Await 'ready' so we know the worker is actually listening before the
  // first test enqueues a job.
  await new Promise<void>((resolve, reject) => {
    const readyTimer = setTimeout(
      () => reject(new Error('worker did not become ready within 10s')),
      10_000,
    );
    worker.once('ready', () => {
      clearTimeout(readyTimer);
      resolve();
    });
    worker.once('error', (err) => {
      clearTimeout(readyTimer);
      reject(err);
    });
  });

  const triggerEngine = new TriggerEngine({
    triggerModel: TriggerRegistration as any,
    workflowModel: {
      // Minimal stub — register()/resume() call findOneAndUpdate to sync the
      // embedded triggers array, but the chain under test doesn't need it.
      findOne: async () => null,
      findOneAndUpdate: async () => null,
    } as any,
    restateClient: {
      startWorkflow: async () => {},
    },
    connectorTriggerEngine: connectorTriggerEngine as any,
  });

  return {
    registry,
    pollingQueue,
    cronQueue,
    worker,
    connectorTriggerEngine,
    triggerEngine,
    restateSpy,
    redisClient,
    sharedConnections,
  };
}

async function tearDownHarness(h: Harness | undefined): Promise<void> {
  if (!h) return;
  await h.worker.close();
  // Nuke queue contents so nothing leaks across tests — repeatables alone
  // don't clean up the delayed jobs the scheduler has already materialised.
  try {
    await h.pollingQueue.obliterate({ force: true });
  } catch {
    /* queue may already be closed */
  }
  try {
    await h.cronQueue.obliterate({ force: true });
  } catch {
    /* queue may already be closed */
  }
  await h.pollingQueue.close();
  await h.cronQueue.close();
  for (const c of h.sharedConnections) {
    c.disconnect();
  }
  h.redisClient.disconnect();
}

// ─── Test helpers ──────────────────────────────────────────────────────────

/** Wait until predicate returns true, polling every 100ms. */
async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  { timeoutMs = 15_000, reason = 'condition' }: { timeoutMs?: number; reason?: string } = {},
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await predicate()) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`waitFor timed out after ${timeoutMs}ms: ${reason}`);
}

async function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ─── MongoDB lifecycle ─────────────────────────────────────────────────────

let mongod: MongoMemoryServer | undefined;
let mongoAvailable = false;

beforeAll(async () => {
  try {
    mongod = await MongoMemoryServer.create();
    await mongoose.connect(mongod.getUri());
    await mongoose.connection.asPromise();
    mongoAvailable = true;
  } catch (err) {
    mongoAvailable = false;
    process.stderr.write(
      `[E2E] MongoMemoryServer unavailable — polling chain tests will skip: ${
        err instanceof Error ? err.message : String(err)
      }\n`,
    );
  }
}, 60_000);

afterAll(async () => {
  if (mongoose.connection.readyState !== 0) {
    await mongoose.disconnect();
  }
  if (mongod) {
    await mongod.stop();
  }
});

/** Probe Redis once so tests can skip when docker-compose isn't up. */
let redisAvailable = false;
beforeAll(async () => {
  const url = process.env.REDIS_URL || DEFAULT_REDIS_URL;
  const probe = new Redis(url, { maxRetriesPerRequest: 1, lazyConnect: true });
  try {
    await probe.connect();
    await probe.ping();
    redisAvailable = true;
  } catch (err) {
    redisAvailable = false;
    process.stderr.write(
      `[E2E] Redis unavailable at ${url} — polling chain tests will skip: ${
        err instanceof Error ? err.message : String(err)
      }\n`,
    );
  } finally {
    probe.disconnect();
  }
}, 15_000);

// ─── Per-test harness ──────────────────────────────────────────────────────

let harness: Harness | undefined;

afterEach(async () => {
  await tearDownHarness(harness);
  harness = undefined;
  stagedItems = [];
  // Clear Mongo between tests
  if (mongoAvailable && mongoose.connection.readyState === 1) {
    await TriggerRegistration.deleteMany({}).catch(() => {});
  }
  vi.restoreAllMocks();
});

function requireInfra(ctx: { skip: (reason?: string) => void }): boolean {
  if (!mongoAvailable) {
    ctx.skip('MongoMemoryServer unavailable');
    return false;
  }
  if (!redisAvailable) {
    ctx.skip('Redis unavailable (start with `docker compose up redis`)');
    return false;
  }
  return true;
}

// ─── Scenarios ─────────────────────────────────────────────────────────────

describe('System E2E: connector polling chain', () => {
  /** S1 — Happy path: full register → poll → Restate chain fires. */
  it('register → BullMQ worker picks up job → Restate.startWorkflow is called', async (ctx) => {
    if (!requireInfra(ctx)) return;
    harness = await buildHarness();

    stagedItems = [{ id: 'item-1', payload: 'hello' }];

    const { registrationId } = await harness.triggerEngine.register({
      workflowId: WORKFLOW_ID,
      tenantId: TENANT_ID,
      projectId: PROJECT_ID,
      triggerType: 'event',
      config: {
        connectorName: CONNECTOR_NAME,
        triggerName: TRIGGER_NAME,
        connectionId: CONNECTION_ID,
        pollingIntervalMs: POLLING_INTERVAL_MS,
      },
    });

    expect(registrationId).toEqual(expect.any(String));

    // BullMQ's repeatable scheduler can take up to ~3 intervals on a cold
    // start before the first delayed job becomes ready (the repeat key is
    // materialised lazily, and the worker's first poll of `delayed` is only
    // scheduled after it reports `ready`). 4× the effective interval keeps
    // the test deterministic without introducing production changes.
    await waitFor(() => harness!.restateSpy.calls.length > 0, {
      timeoutMs: EFFECTIVE_POLLING_INTERVAL_MS * 4 + 5_000,
      reason: 'restate.startWorkflow was not called within four polling cycles',
    });

    const call = harness.restateSpy.calls[0];
    expect(call.input).toMatchObject({
      workflowId: WORKFLOW_ID,
      tenantId: TENANT_ID,
      projectId: PROJECT_ID,
      triggerType: 'event',
      triggerPayload: { id: 'item-1', payload: 'hello' },
      triggerMetadata: expect.objectContaining({
        connectorName: CONNECTOR_NAME,
        triggerName: TRIGGER_NAME,
        registrationId,
      }),
    });
  }, 60_000);

  /** S2 — Register-time delegation: connector path runs, cron scheduler does not. */
  it('register with config.connectorName delegates to connectorTriggerEngine (not cron scheduler)', async (ctx) => {
    if (!requireInfra(ctx)) return;
    harness = await buildHarness();

    const delegateSpy = vi.spyOn(harness.connectorTriggerEngine, 'registerTrigger');

    const { registrationId } = await harness.triggerEngine.register({
      workflowId: WORKFLOW_ID,
      tenantId: TENANT_ID,
      projectId: PROJECT_ID,
      triggerType: 'event',
      config: {
        connectorName: CONNECTOR_NAME,
        triggerName: TRIGGER_NAME,
        connectionId: CONNECTION_ID,
        pollingIntervalMs: POLLING_INTERVAL_MS,
      },
    });

    // Connector engine was called with the registration's core fields.
    expect(delegateSpy).toHaveBeenCalledOnce();
    expect(delegateSpy.mock.calls[0][0]).toMatchObject({
      registrationId,
      tenantId: TENANT_ID,
      projectId: PROJECT_ID,
      workflowId: WORKFLOW_ID,
      connectorName: CONNECTOR_NAME,
      triggerName: TRIGGER_NAME,
      connectionId: CONNECTION_ID,
      pollingIntervalMs: POLLING_INTERVAL_MS,
    });

    // Polling queue has exactly one repeatable (this registration).
    // BullMQ's getRepeatableJobs() shape doesn't expose the `jobId`, so we
    // assert on count + the repeat name — unique per queue in this test.
    const pollRepeatables = await harness.pollingQueue.getRepeatableJobs();
    expect(pollRepeatables).toHaveLength(1);
    expect(pollRepeatables[0]).toMatchObject({ name: 'poll-trigger' });

    // …and the cron queue was NOT touched (delegation took precedence over
    // the scheduler branch — this is the Gmail-regression guard).
    const cronRepeatables = await harness.cronQueue.getRepeatableJobs();
    expect(cronRepeatables).toHaveLength(0);
  }, 20_000);

  /** S3 — Pause flips status + keeps polling no-op; resume re-delegates and dispatch resumes. */
  it('pause flips status (paused fires are no-op); resume re-delegates + dispatch resumes', async (ctx) => {
    if (!requireInfra(ctx)) return;
    harness = await buildHarness();

    const delegateSpy = vi.spyOn(harness.connectorTriggerEngine, 'registerTrigger');

    const { registrationId } = await harness.triggerEngine.register({
      workflowId: WORKFLOW_ID,
      tenantId: TENANT_ID,
      projectId: PROJECT_ID,
      triggerType: 'event',
      config: {
        connectorName: CONNECTOR_NAME,
        triggerName: TRIGGER_NAME,
        connectionId: CONNECTION_ID,
        pollingIntervalMs: POLLING_INTERVAL_MS,
      },
    });

    // Register delegated once.
    expect(delegateSpy).toHaveBeenCalledTimes(1);

    // Pause immediately. Status flips; BullMQ repeatable stays (pause doesn't
    // deregister connector triggers today — processPollingJob's
    // status='active' filter is what prevents spurious fires).
    await harness.triggerEngine.pause(registrationId, TENANT_ID, PROJECT_ID);
    const pausedDoc = await TriggerRegistration.findOne({
      _id: registrationId,
      tenantId: TENANT_ID,
    }).lean();
    expect(pausedDoc?.status).toBe('paused');
    const pausedRepeatables = await harness.pollingQueue.getRepeatableJobs();
    expect(pausedRepeatables).toHaveLength(1);

    // While paused, stage items — processPollingJob will run but early-exit
    // on the status filter, so nothing dispatches.
    stagedItems = [{ id: 'during-pause' }];
    await sleep(EFFECTIVE_POLLING_INTERVAL_MS + 3_000);
    expect(harness.restateSpy.calls).toHaveLength(0);

    // Resume: status flips back to active and connectorTriggerEngine receives
    // a second registerTrigger call — idempotent via jobId, but the dispatch
    // path is now live again.
    await harness.triggerEngine.resume(registrationId, TENANT_ID, PROJECT_ID);
    const resumedDoc = await TriggerRegistration.findOne({
      _id: registrationId,
      tenantId: TENANT_ID,
    }).lean();
    expect(resumedDoc?.status).toBe('active');
    expect(delegateSpy).toHaveBeenCalledTimes(2);

    // Next poll cycle dispatches the newly-staged item. Wider window because
    // BullMQ's first-fire-after-status-flip can slip up to one interval.
    stagedItems = [{ id: 'after-resume' }];
    await waitFor(() => harness!.restateSpy.calls.length > 0, {
      timeoutMs: EFFECTIVE_POLLING_INTERVAL_MS * 3 + 5_000,
      reason: 'post-resume dispatch never happened',
    });

    const lastCall = harness.restateSpy.calls[harness.restateSpy.calls.length - 1];
    expect(lastCall.input.triggerPayload).toMatchObject({ id: 'after-resume' });
  }, 90_000);

  /** S4 — Rehydrate: pre-existing active connector triggers get their jobs re-enqueued on boot. */
  it('rehydrateConnectorTriggers re-enqueues BullMQ jobs for seeded active registrations', async (ctx) => {
    if (!requireInfra(ctx)) return;
    harness = await buildHarness();

    // Seed a registration directly (bypassing register()) to simulate a doc
    // that existed before the fix, or a Redis flush.
    const registrationId = crypto.randomUUID();
    await TriggerRegistration.create({
      _id: registrationId,
      tenantId: TENANT_ID,
      projectId: PROJECT_ID,
      workflowId: WORKFLOW_ID,
      triggerType: 'event',
      triggerName: TRIGGER_NAME,
      status: 'active',
      authProfileId: null,
      config: {
        connectorName: CONNECTOR_NAME,
        triggerName: TRIGGER_NAME,
        connectionId: CONNECTION_ID,
        pollingIntervalMs: POLLING_INTERVAL_MS,
      },
      consecutiveErrors: 0,
    });

    // Before rehydrate: no BullMQ repeatable for this registration.
    const beforeRepeatables = await harness.pollingQueue.getRepeatableJobs();
    expect(beforeRepeatables).toHaveLength(0);

    const result = await rehydrateConnectorTriggers({
      triggerModel: TriggerRegistration as any,
      connectorTriggerEngine: harness.connectorTriggerEngine as any,
    });
    expect(result).toEqual({ rehydrated: 1, skipped: 0, failed: 0 });

    // After rehydrate: repeatable exists, and the worker fires.
    const afterRepeatables = await harness.pollingQueue.getRepeatableJobs();
    expect(afterRepeatables).toHaveLength(1);

    stagedItems = [{ id: 'rehydrated-item' }];
    await waitFor(() => harness!.restateSpy.calls.length > 0, {
      timeoutMs: EFFECTIVE_POLLING_INTERVAL_MS * 4 + 5_000,
      reason: 'rehydrated trigger never fired',
    });

    expect(harness.restateSpy.calls[0].input.triggerPayload).toMatchObject({
      id: 'rehydrated-item',
    });
  }, 90_000);
});
