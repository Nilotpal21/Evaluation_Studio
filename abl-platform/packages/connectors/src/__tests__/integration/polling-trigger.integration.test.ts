/**
 * Integration Test: Polling Trigger Processing Chain (INT-4)
 *
 * Tests the end-to-end polling trigger pipeline:
 * processPollingJob() → load registration → resolve connector →
 * call trigger.run() → deduplicate → dispatch workflow → update cursor.
 *
 * Uses:
 * - MongoMemoryServer for real TriggerRegistration persistence ($inc, $set)
 * - In-memory KeyValueStore for cursor persistence and deduplication
 * - Spy RestateIngressClient to record workflow dispatches
 * - In-memory TriggerQueue for registerPollingTrigger/deregisterPollingTrigger
 * - Real ConnectorRegistry with a custom polling connector
 *
 * No vi.mock() — external services are implemented as lightweight
 * in-memory doubles via dependency injection.
 */

import { describe, it, expect, beforeAll, afterEach, afterAll } from 'vitest';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import {
  processPollingJob,
  registerPollingTrigger,
  type PollingSchedulerDeps,
} from '../../triggers/polling-scheduler.js';
import { ConnectorRegistry } from '../../registry.js';
import type {
  TriggerRegistration,
  TriggerRegistrationModel,
  TriggerQueue,
  TriggerJobData,
  WorkflowTriggerInput,
} from '../../triggers/types.js';
import type { Connector, KeyValueStore, TriggerRunContext } from '../../types.js';
import {
  DEFAULT_POLLING_INTERVAL_MS,
  TRIGGER_AUTO_PAUSE_THRESHOLD,
} from '../../triggers/constants.js';

// ─── Constants ──────────────────────────────────────────────────────────────

const TENANT_ID = 'tenant-poll-1';
const PROJECT_ID = 'project-poll-1';
const WORKFLOW_ID = 'wf-poll-1';
const CONNECTION_ID = 'conn-poll-1';
const CONNECTOR_NAME = 'polling-test-connector';
const TRIGGER_NAME = 'poll_items';

const MONGO_VERSION = process.env.MONGOMS_VERSION || '7.0.20';
const MONGO_LAUNCH_TIMEOUT_MS = 30_000;

// ─── Mongoose Schema for TriggerRegistration ────────────────────────────────

const triggerRegistrationSchema = new mongoose.Schema(
  {
    _id: { type: String, required: true },
    tenantId: { type: String, required: true, index: true },
    projectId: { type: String, required: true, index: true },
    workflowId: { type: String, required: true },
    connectorName: { type: String, required: true },
    triggerName: { type: String, required: true },
    connectionId: { type: String, required: true },
    triggerType: { type: String, enum: ['webhook', 'cron', 'event'], required: true },
    status: { type: String, enum: ['active', 'paused', 'error'], default: 'active' },
    config: { type: mongoose.Schema.Types.Mixed, default: {} },
    webhookSecret: { type: String },
    pollingIntervalMs: { type: Number },
    consecutiveErrors: { type: Number, default: 0 },
    lastFiredAt: { type: Date },
    lastErrorAt: { type: Date },
  },
  { collection: 'trigger_registrations_poll_test', _id: false },
);

// ─── Mongoose Model Adapter for TriggerRegistrationModel ────────────────────

/**
 * Adapts a real Mongoose model to the TriggerRegistrationModel DI interface.
 * Supports $inc, $set, and the { new: true } option for findOneAndUpdate.
 */
function createRegistrationModelAdapter(
  model: mongoose.Model<mongoose.Document>,
): TriggerRegistrationModel {
  return {
    async findOne(filter: Record<string, unknown>): Promise<TriggerRegistration | null> {
      const doc = await model.findOne(filter).lean().exec();
      return doc as unknown as TriggerRegistration | null;
    },
    async findOneAndUpdate(
      filter: Record<string, unknown>,
      update: Record<string, unknown>,
      options?: Record<string, unknown>,
    ): Promise<TriggerRegistration | null> {
      // Mongoose 9.x deprecates { new: true } in favor of { returnDocument: 'after' }
      const mongooseOptions: Record<string, unknown> = { ...options };
      if (mongooseOptions.new === true) {
        delete mongooseOptions.new;
        mongooseOptions.returnDocument = 'after';
      } else {
        delete mongooseOptions.new;
        mongooseOptions.returnDocument = 'before';
      }
      const result = await model.findOneAndUpdate(filter, update, mongooseOptions).lean().exec();
      return result as unknown as TriggerRegistration | null;
    },
  };
}

// ─── In-Memory KeyValueStore ────────────────────────────────────────────────

/**
 * In-memory KeyValueStore that supports TTL.
 * Used for cursor persistence and deduplication (replaces Redis in integration tests).
 */
class InMemoryKeyValueStore implements KeyValueStore {
  private data = new Map<string, { value: unknown; expiresAt?: number }>();

  async get<T = unknown>(key: string): Promise<T | undefined> {
    const entry = this.data.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt !== undefined && Date.now() > entry.expiresAt) {
      this.data.delete(key);
      return undefined;
    }
    return entry.value as T;
  }

  async set(key: string, value: unknown, ttlMs?: number): Promise<void> {
    this.data.set(key, {
      value,
      expiresAt: ttlMs !== undefined ? Date.now() + ttlMs : undefined,
    });
  }

  async delete(key: string): Promise<void> {
    this.data.delete(key);
  }

  clear(): void {
    this.data.clear();
  }
}

// ─── Spy RestateIngressClient ───────────────────────────────────────────────

/**
 * Records workflow dispatches for assertion.
 * Restate is external infrastructure — not a codebase mock.
 */
class SpyRestateClient {
  readonly invocations: Array<{ executionId: string; input: WorkflowTriggerInput }> = [];

  async startWorkflow(executionId: string, input: WorkflowTriggerInput): Promise<void> {
    this.invocations.push({ executionId, input });
  }

  clear(): void {
    this.invocations.length = 0;
  }
}

// ─── In-Memory TriggerQueue ─────────────────────────────────────────────────

/**
 * Records queue.add() and queue.removeRepeatable() calls for assertion.
 * BullMQ is external infrastructure — not a codebase mock.
 */
class InMemoryTriggerQueue implements TriggerQueue {
  readonly addCalls: Array<{
    name: string;
    data: Record<string, unknown>;
    options?: { repeat?: { every?: number; cron?: string }; jobId?: string };
  }> = [];

  readonly removeCalls: Array<{
    name: string;
    options: { every?: number; cron?: string; jobId?: string };
  }> = [];

  async add(
    name: string,
    data: Record<string, unknown>,
    options?: { repeat?: { every?: number; cron?: string }; jobId?: string },
  ): Promise<void> {
    this.addCalls.push({ name, data, options });
  }

  async removeRepeatable(
    name: string,
    options: { every?: number; cron?: string; jobId?: string },
  ): Promise<void> {
    this.removeCalls.push({ name, options });
  }

  clear(): void {
    this.addCalls.length = 0;
    this.removeCalls.length = 0;
  }
}

// ─── Test Polling Connector ─────────────────────────────────────────────────

/**
 * Configurable polling connector for testing.
 * pollItems and runError can be changed between test invocations.
 */
let pollItems: unknown[] = [];
let runError: Error | null = null;
let lastRunCtx: TriggerRunContext | null = null;

const pollingConnector: Connector = {
  name: CONNECTOR_NAME,
  displayName: 'Polling Test',
  version: '1.0.0',
  description: 'Test connector with polling trigger',
  auth: { type: 'none' },
  triggers: [
    {
      name: TRIGGER_NAME,
      displayName: 'Poll Items',
      description: 'Returns configurable items for polling',
      triggerType: 'cron',
      props: [],
      async run(ctx: TriggerRunContext): Promise<unknown[]> {
        lastRunCtx = ctx;
        if (runError) throw runError;
        return pollItems;
      },
      async onEnable(): Promise<void> {
        // no-op
      },
      async onDisable(): Promise<void> {
        // no-op
      },
    },
  ],
  actions: [],
};

// ─── MongoDB Setup / Teardown ───────────────────────────────────────────────

let mongod: MongoMemoryServer | undefined;
let connection: mongoose.Connection | undefined;
let registrationModel: TriggerRegistrationModel;
let rawModel: mongoose.Model<mongoose.Document>;
let mongoAvailable = false;

beforeAll(async () => {
  try {
    mongod = await MongoMemoryServer.create({
      binary: { version: MONGO_VERSION },
      instance: { launchTimeout: MONGO_LAUNCH_TIMEOUT_MS },
    });
    const mongoUri = mongod.getUri();
    connection = mongoose.createConnection(mongoUri);
    await connection.asPromise();

    rawModel = connection.model(
      'TriggerRegistrationPollTest',
      triggerRegistrationSchema,
    ) as unknown as mongoose.Model<mongoose.Document>;
    registrationModel = createRegistrationModelAdapter(rawModel);
    mongoAvailable = true;
  } catch {
    mongoAvailable = false;
  }
}, 30_000);

afterEach(async () => {
  if (mongoAvailable && connection?.db) {
    const collections = await connection.db.listCollections().toArray();
    for (const coll of collections) {
      await connection.db.collection(coll.name).deleteMany({});
    }
  }
  // Reset test connector state
  pollItems = [];
  runError = null;
  lastRunCtx = null;
});

afterAll(async () => {
  if (connection) await connection.close();
  if (mongod) await mongod.stop();
});

// ─── Helpers ────────────────────────────────────────────────────────────────

let regCounter = 0;

function makeRegistrationId(): string {
  regCounter++;
  return `reg-poll-${regCounter}`;
}

async function seedRegistration(
  overrides: Partial<TriggerRegistration> = {},
): Promise<TriggerRegistration> {
  const reg: TriggerRegistration = {
    _id: makeRegistrationId(),
    tenantId: TENANT_ID,
    projectId: PROJECT_ID,
    workflowId: WORKFLOW_ID,
    connectorName: CONNECTOR_NAME,
    triggerName: TRIGGER_NAME,
    connectionId: CONNECTION_ID,
    triggerType: 'cron',
    status: 'active',
    config: {},
    consecutiveErrors: 0,
    ...overrides,
  };
  await rawModel.create(reg);
  return reg;
}

function makeJobData(reg: TriggerRegistration): TriggerJobData {
  return {
    registrationId: reg._id,
    tenantId: reg.tenantId,
    projectId: reg.projectId,
    connectorName: reg.connectorName,
    triggerName: reg.triggerName,
    connectionId: reg.connectionId,
  };
}

function makeDeps(overrides: Partial<PollingSchedulerDeps> = {}): PollingSchedulerDeps & {
  restateClient: SpyRestateClient;
  queue: InMemoryTriggerQueue;
  store: InMemoryKeyValueStore;
} {
  const registry = new ConnectorRegistry();
  registry.register(pollingConnector);

  const store = new InMemoryKeyValueStore();
  const restateClient = new SpyRestateClient();
  const queue = new InMemoryTriggerQueue();

  return {
    registry,
    registrationModel,
    restateClient,
    queue,
    storeFactory: () => store,
    store,
    ...overrides,
  };
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('INT-4: Polling Trigger Processing Chain', () => {
  it('skips if MongoDB unavailable', ({ skip }) => {
    if (!mongoAvailable) skip('MongoMemoryServer unavailable');
  });

  // ── 1. processPollingJob dispatches items to workflow ────────────────────

  it('dispatches each polling item as a separate workflow invocation', async ({ skip }) => {
    if (!mongoAvailable) skip('MongoMemoryServer unavailable');

    const reg = await seedRegistration();
    const deps = makeDeps();

    pollItems = [
      { id: 'item-1', name: 'First' },
      { id: 'item-2', name: 'Second' },
      { id: 'item-3', name: 'Third' },
    ];

    await processPollingJob(makeJobData(reg), deps);

    // Should invoke Restate 3 times — one per item
    expect(deps.restateClient.invocations).toHaveLength(3);

    // Verify each invocation carries the correct workflow metadata
    for (const inv of deps.restateClient.invocations) {
      expect(inv.executionId).toBeTruthy();
      expect(inv.input.workflowId).toBe(WORKFLOW_ID);
      expect(inv.input.tenantId).toBe(TENANT_ID);
      expect(inv.input.projectId).toBe(PROJECT_ID);
      // Connector-backed polling triggers fire as 'event' from the
      // user-visible perspective — the BullMQ polling cadence is an
      // internal delivery mechanism, not the trigger category.
      expect(inv.input.triggerType).toBe('event');
      expect(inv.input.triggerMetadata).toMatchObject({
        connectorName: CONNECTOR_NAME,
        triggerName: TRIGGER_NAME,
        registrationId: reg._id,
      });
    }

    // Verify payloads match the poll items
    expect(deps.restateClient.invocations[0].input.triggerPayload).toEqual({
      id: 'item-1',
      name: 'First',
    });
    expect(deps.restateClient.invocations[1].input.triggerPayload).toEqual({
      id: 'item-2',
      name: 'Second',
    });
    expect(deps.restateClient.invocations[2].input.triggerPayload).toEqual({
      id: 'item-3',
      name: 'Third',
    });

    // Verify lastFiredAt updated and consecutiveErrors reset in DB
    const updated = await registrationModel.findOne({
      _id: reg._id,
      tenantId: TENANT_ID,
    });
    expect(updated).not.toBeNull();
    expect(updated!.lastFiredAt).toBeDefined();
    expect(updated!.consecutiveErrors).toBe(0);
  });

  // ── 2. Cursor-based pagination ──────────────────────────────────────────

  it('persists cursor and uses it for subsequent polls', async ({ skip }) => {
    if (!mongoAvailable) skip('MongoMemoryServer unavailable');

    const reg = await seedRegistration();
    const deps = makeDeps();

    // First poll: return two items
    pollItems = [
      { id: 'item-1', cursor: 'cursor-1' },
      { id: 'item-2', cursor: 'cursor-2' },
    ];

    await processPollingJob(makeJobData(reg), deps);

    // Should have dispatched 2 workflows
    expect(deps.restateClient.invocations).toHaveLength(2);

    // Verify cursor was stored (last item becomes the cursor)
    const cursorValue = await deps.store.get(`cursor:${reg._id}`);
    expect(cursorValue).toEqual({ id: 'item-2', cursor: 'cursor-2' });

    // Clear invocations for next poll
    deps.restateClient.clear();

    // Second poll: return only a new item
    pollItems = [{ id: 'item-3', cursor: 'cursor-3' }];

    await processPollingJob(makeJobData(reg), deps);

    // Verify lastRunData was passed to trigger.run() (the stored cursor)
    expect(lastRunCtx).not.toBeNull();
    expect(lastRunCtx!.lastRunData).toEqual({ id: 'item-2', cursor: 'cursor-2' });

    // Only the new item should be dispatched
    expect(deps.restateClient.invocations).toHaveLength(1);
    expect(deps.restateClient.invocations[0].input.triggerPayload).toEqual({
      id: 'item-3',
      cursor: 'cursor-3',
    });

    // Cursor updated to latest
    const newCursor = await deps.store.get(`cursor:${reg._id}`);
    expect(newCursor).toEqual({ id: 'item-3', cursor: 'cursor-3' });
  });

  // ── 3. Deduplication by content hash ────────────────────────────────────

  it('deduplicates identical items within the same poll', async ({ skip }) => {
    if (!mongoAvailable) skip('MongoMemoryServer unavailable');

    const reg = await seedRegistration();
    const deps = makeDeps();

    // Return the same item twice in one poll
    const duplicateItem = { id: 'dup-1', data: 'same-content' };
    pollItems = [duplicateItem, duplicateItem];

    await processPollingJob(makeJobData(reg), deps);

    // Only 1 workflow should be dispatched (second is deduped)
    expect(deps.restateClient.invocations).toHaveLength(1);
    expect(deps.restateClient.invocations[0].input.triggerPayload).toEqual(duplicateItem);
  });

  it('deduplicates items across consecutive polls', async ({ skip }) => {
    if (!mongoAvailable) skip('MongoMemoryServer unavailable');

    const reg = await seedRegistration();
    const deps = makeDeps();

    const repeatedItem = { id: 'cross-poll-dup', value: 42 };

    // First poll: item is new
    pollItems = [repeatedItem];
    await processPollingJob(makeJobData(reg), deps);
    expect(deps.restateClient.invocations).toHaveLength(1);

    deps.restateClient.clear();

    // Second poll: same item returned again — should be deduped
    pollItems = [repeatedItem];
    await processPollingJob(makeJobData(reg), deps);
    expect(deps.restateClient.invocations).toHaveLength(0);
  });

  // ── 4. Missing registration skips gracefully ───────────────────────────

  it('skips gracefully when registration does not exist', async ({ skip }) => {
    if (!mongoAvailable) skip('MongoMemoryServer unavailable');

    const deps = makeDeps();

    const fakeJobData: TriggerJobData = {
      registrationId: 'non-existent-reg',
      tenantId: TENANT_ID,
      projectId: PROJECT_ID,
      connectorName: CONNECTOR_NAME,
      triggerName: TRIGGER_NAME,
      connectionId: CONNECTION_ID,
    };

    // Should not throw
    await processPollingJob(fakeJobData, deps);

    // No workflows dispatched
    expect(deps.restateClient.invocations).toHaveLength(0);
  });

  // ── 5. Paused registration skips ──────────────────────────────────────

  it('skips when registration status is not active', async ({ skip }) => {
    if (!mongoAvailable) skip('MongoMemoryServer unavailable');

    const reg = await seedRegistration({ status: 'paused' });
    const deps = makeDeps();

    pollItems = [{ id: 'should-not-dispatch' }];

    await processPollingJob(makeJobData(reg), deps);

    // No workflows dispatched — registration is paused
    expect(deps.restateClient.invocations).toHaveLength(0);
  });

  it('skips when registration status is error', async ({ skip }) => {
    if (!mongoAvailable) skip('MongoMemoryServer unavailable');

    const reg = await seedRegistration({ status: 'error' });
    const deps = makeDeps();

    pollItems = [{ id: 'should-not-dispatch' }];

    await processPollingJob(makeJobData(reg), deps);

    // No workflows dispatched — registration is in error state
    expect(deps.restateClient.invocations).toHaveLength(0);
  });

  // ── 6. Consecutive failures auto-pause ────────────────────────────────

  it('auto-pauses registration after TRIGGER_AUTO_PAUSE_THRESHOLD consecutive failures', async ({
    skip,
  }) => {
    if (!mongoAvailable) skip('MongoMemoryServer unavailable');

    const reg = await seedRegistration();
    const deps = makeDeps();

    // Make trigger.run() throw
    runError = new Error('External API unavailable');

    // Call processPollingJob TRIGGER_AUTO_PAUSE_THRESHOLD times
    for (let i = 0; i < TRIGGER_AUTO_PAUSE_THRESHOLD; i++) {
      await processPollingJob(makeJobData(reg), deps);
    }

    // Verify registration status changed to 'error' in the database
    const updated = await registrationModel.findOne({
      _id: reg._id,
      tenantId: TENANT_ID,
    });
    expect(updated).not.toBeNull();
    expect(updated!.status).toBe('error');
    expect(updated!.consecutiveErrors).toBe(TRIGGER_AUTO_PAUSE_THRESHOLD);
    expect(updated!.lastErrorAt).toBeDefined();

    // No workflows should have been dispatched (all calls threw)
    expect(deps.restateClient.invocations).toHaveLength(0);
  });

  it('resets consecutive errors on successful poll after failures', async ({ skip }) => {
    if (!mongoAvailable) skip('MongoMemoryServer unavailable');

    const reg = await seedRegistration();
    const deps = makeDeps();

    // Fail a few times (below threshold)
    runError = new Error('Temporary failure');
    const failCount = 3;
    for (let i = 0; i < failCount; i++) {
      await processPollingJob(makeJobData(reg), deps);
    }

    // Verify errors accumulated
    const afterFailures = await registrationModel.findOne({
      _id: reg._id,
      tenantId: TENANT_ID,
    });
    expect(afterFailures!.consecutiveErrors).toBe(failCount);

    // Now succeed
    runError = null;
    pollItems = [{ id: 'recovery-item' }];
    await processPollingJob(makeJobData(reg), deps);

    // consecutiveErrors should be reset to 0
    const afterSuccess = await registrationModel.findOne({
      _id: reg._id,
      tenantId: TENANT_ID,
    });
    expect(afterSuccess!.consecutiveErrors).toBe(0);
    expect(afterSuccess!.lastFiredAt).toBeDefined();

    // Workflow should have been dispatched
    expect(deps.restateClient.invocations).toHaveLength(1);
  });

  // ── 7. registerPollingTrigger adds BullMQ repeatable job ──────────────

  it('registerPollingTrigger adds a repeatable job with correct options', async ({ skip }) => {
    if (!mongoAvailable) skip('MongoMemoryServer unavailable');

    const deps = makeDeps();
    const reg = await seedRegistration({ pollingIntervalMs: 120_000 });

    await registerPollingTrigger(
      {
        _id: reg._id,
        tenantId: reg.tenantId,
        projectId: reg.projectId,
        connectorName: reg.connectorName,
        triggerName: reg.triggerName,
        connectionId: reg.connectionId,
        pollingIntervalMs: 120_000,
      },
      deps,
    );

    expect(deps.queue.addCalls).toHaveLength(1);
    const call = deps.queue.addCalls[0];
    expect(call.name).toBe('poll-trigger');
    expect(call.data).toMatchObject({
      registrationId: reg._id,
      tenantId: TENANT_ID,
      projectId: PROJECT_ID,
      connectorName: CONNECTOR_NAME,
      triggerName: TRIGGER_NAME,
      connectionId: CONNECTION_ID,
    });
    expect(call.options).toEqual({
      repeat: { every: 120_000 },
      jobId: `poll:${reg._id}`,
    });
  });

  it('registerPollingTrigger uses default interval when not specified', async ({ skip }) => {
    if (!mongoAvailable) skip('MongoMemoryServer unavailable');

    const deps = makeDeps();
    const reg = await seedRegistration();

    await registerPollingTrigger(
      {
        _id: reg._id,
        tenantId: reg.tenantId,
        projectId: reg.projectId,
        connectorName: reg.connectorName,
        triggerName: reg.triggerName,
        connectionId: reg.connectionId,
      },
      deps,
    );

    expect(deps.queue.addCalls).toHaveLength(1);
    expect(deps.queue.addCalls[0].options?.repeat?.every).toBe(DEFAULT_POLLING_INTERVAL_MS);
  });
});
