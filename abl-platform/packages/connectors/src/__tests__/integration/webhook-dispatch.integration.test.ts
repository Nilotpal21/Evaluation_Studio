/**
 * Integration Test: Webhook Dispatch Chain (INT-3 + INT-7)
 *
 * Tests the full webhook handler processing chain:
 *   handleWebhook() -> signature verification -> dedup -> workflow dispatch
 *   -> health tracking -> auto-pause
 *
 * Uses MongoMemoryServer for real TriggerRegistration persistence (the handler
 * uses MongoDB $inc and $set operators for consecutive error tracking).
 * Redis and RestateIngressClient are in-memory implementations injected via DI
 * (these are external infrastructure — OK to implement in-memory for integration tests).
 *
 * No vi.mock() — this is an integration test.
 */

import crypto from 'crypto';
import { describe, it, expect, beforeAll, afterEach, afterAll } from 'vitest';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import {
  handleWebhook,
  type WebhookRequest,
  type WebhookHandlerDeps,
  type TriggerRegistration,
  type TriggerRegistrationModel,
  type TriggerRedisClient,
  type RestateIngressClient,
  type DecryptSecretFn,
  type WorkflowTriggerInput,
  TRIGGER_AUTO_PAUSE_THRESHOLD,
  WEBHOOK_REPLAY_TOLERANCE_MS,
} from '../../triggers/index.js';
import { ConnectorRegistry } from '../../registry.js';
import { registerTestConnector } from '../fixtures/test-connector.js';

// ─── Constants ──────────────────────────────────────────────────────────────

const TENANT_ID = 'tenant-webhook-test';
const PROJECT_ID = 'project-webhook-test';
const WORKFLOW_ID = 'workflow-001';
const CONNECTION_ID = 'conn-001';
const CONNECTOR_NAME = 'test-connector';
const TRIGGER_NAME = 'on_event';

const MONGO_VERSION = process.env.MONGOMS_VERSION || '7.0.20';
const MONGO_LAUNCH_TIMEOUT_MS = 30_000;

/** Plaintext secret used for webhook HMAC verification */
const WEBHOOK_SECRET_PLAINTEXT = 'test-webhook-secret-key';

// ─── Encryption ─────────────────────────────────────────────────────────────

const ENCRYPTION_KEY = crypto.scryptSync('webhook-test-passphrase', 'webhook-test-salt', 32);

async function encryptSecret(plaintext: string, _tenantId: string): Promise<string> {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', ENCRYPTION_KEY, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return `${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted.toString('hex')}`;
}

const decryptSecret: DecryptSecretFn = async (
  ciphertext: string,
  _tenantId: string,
): Promise<string> => {
  const parts = ciphertext.split(':');
  if (parts.length !== 3) {
    throw new Error('Invalid ciphertext format');
  }
  const [ivHex, authTagHex, encHex] = parts;
  const iv = Buffer.from(ivHex, 'hex');
  const authTag = Buffer.from(authTagHex, 'hex');
  const encrypted = Buffer.from(encHex, 'hex');
  const decipher = crypto.createDecipheriv('aes-256-gcm', ENCRYPTION_KEY, iv);
  decipher.setAuthTag(authTag);
  const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
  return decrypted.toString('utf8');
};

// ─── Mongoose Schema for TriggerRegistration ────────────────────────────────

const triggerRegistrationSchema = new mongoose.Schema(
  {
    _id: { type: String, required: true },
    tenantId: { type: String, required: true, index: true },
    projectId: { type: String, required: true },
    workflowId: { type: String, required: true },
    connectorName: { type: String, required: true },
    triggerName: { type: String, required: true },
    connectionId: { type: String, required: true },
    triggerType: {
      type: String,
      enum: ['webhook', 'cron', 'event'],
      required: true,
    },
    status: {
      type: String,
      enum: ['active', 'paused', 'error'],
      default: 'active',
    },
    config: { type: mongoose.Schema.Types.Mixed, default: {} },
    webhookSecret: { type: String },
    cronExpression: { type: String },
    pollingIntervalMs: { type: Number },
    consecutiveErrors: { type: Number, default: 0 },
    lastFiredAt: { type: Date },
    lastErrorAt: { type: Date },
  },
  { collection: 'trigger_registrations', _id: false },
);

// ─── Model Adapter (wraps Mongoose to satisfy TriggerRegistrationModel) ─────

function createTriggerRegistrationModelAdapter(
  model: mongoose.Model<mongoose.Document>,
): TriggerRegistrationModel {
  return {
    async findOne(filter: Record<string, unknown>): Promise<TriggerRegistration | null> {
      const doc = await model.findOne(filter).lean().exec();
      return doc as TriggerRegistration | null;
    },
    async findOneAndUpdate(
      filter: Record<string, unknown>,
      update: Record<string, unknown>,
      options?: Record<string, unknown>,
    ): Promise<TriggerRegistration | null> {
      const result = await model
        .findOneAndUpdate(filter, update, { ...options, returnDocument: 'after' })
        .lean()
        .exec();
      return result as TriggerRegistration | null;
    },
  };
}

// ─── In-Memory Redis (supports NX for dedup) ───────────────────────────────

function createInMemoryRedis(): TriggerRedisClient & { clear(): void } {
  const store = new Map<string, { value: string; expiresAt: number }>();

  return {
    async set(
      key: string,
      value: string,
      _mode: string,
      duration: number,
      flag: string,
    ): Promise<string | null> {
      // Clean expired entries
      const now = Date.now();
      for (const [k, v] of store.entries()) {
        if (v.expiresAt <= now) {
          store.delete(k);
        }
      }

      if (flag === 'NX' && store.has(key)) {
        return null; // Key already exists — dedup hit
      }
      store.set(key, { value, expiresAt: now + duration });
      return 'OK';
    },

    clear() {
      store.clear();
    },
  };
}

// ─── Spy Restate Client ────────────────────────────────────────────────────

interface SpyRestateClient extends RestateIngressClient {
  calls: Array<{ executionId: string; input: WorkflowTriggerInput }>;
  shouldThrow: boolean;
}

function createSpyRestateClient(): SpyRestateClient {
  const client: SpyRestateClient = {
    calls: [],
    shouldThrow: false,
    async startWorkflow(executionId: string, input: WorkflowTriggerInput): Promise<void> {
      if (client.shouldThrow) {
        throw new Error('Workflow engine unavailable');
      }
      client.calls.push({ executionId, input });
    },
  };
  return client;
}

// ─── MongoDB Setup / Teardown ──────────────────────────────────────────────

let mongod: MongoMemoryServer | undefined;
let mongoConnection: mongoose.Connection | undefined;
let TriggerRegModel: mongoose.Model<mongoose.Document>;
let registrationModel: TriggerRegistrationModel;
let mongoAvailable = false;

beforeAll(async () => {
  try {
    mongod = await MongoMemoryServer.create({
      binary: { version: MONGO_VERSION },
      instance: { launchTimeout: MONGO_LAUNCH_TIMEOUT_MS },
    });
    const uri = mongod.getUri();
    mongoConnection = mongoose.createConnection(uri);
    await mongoConnection.asPromise();
    TriggerRegModel = mongoConnection.model(
      'TriggerRegistration',
      triggerRegistrationSchema,
    ) as unknown as mongoose.Model<mongoose.Document>;
    registrationModel = createTriggerRegistrationModelAdapter(TriggerRegModel);
    mongoAvailable = true;
  } catch (err) {
    mongoAvailable = false;
    console.warn(
      '[INT] MongoMemoryServer unavailable -- tests will be skipped',
      err instanceof Error ? err.message : String(err),
    );
  }
}, 30_000);

afterEach(async () => {
  if (mongoAvailable && mongoConnection?.db) {
    const collections = await mongoConnection.db.listCollections().toArray();
    for (const coll of collections) {
      await mongoConnection.db.collection(coll.name).deleteMany({});
    }
  }
});

afterAll(async () => {
  if (mongoConnection) {
    await mongoConnection.close();
  }
  if (mongod) {
    await mongod.stop();
  }
});

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Skip helper — call at the top of each test */
function skipIfNoMongo(ctx: { skip: (reason: string) => void }): void {
  if (!mongoAvailable) ctx.skip('MongoMemoryServer unavailable');
}

/** Create a ConnectorRegistry with the test-connector registered */
function createRegistry(): ConnectorRegistry {
  const registry = new ConnectorRegistry();
  registerTestConnector(registry);
  return registry;
}

/** Create a TriggerRegistration document in MongoDB */
async function seedRegistration(
  overrides: Partial<TriggerRegistration> = {},
): Promise<TriggerRegistration> {
  const defaults: TriggerRegistration = {
    _id: crypto.randomUUID(),
    tenantId: TENANT_ID,
    projectId: PROJECT_ID,
    workflowId: WORKFLOW_ID,
    connectorName: CONNECTOR_NAME,
    triggerName: TRIGGER_NAME,
    connectionId: CONNECTION_ID,
    triggerType: 'webhook',
    status: 'active',
    config: {},
    consecutiveErrors: 0,
  };
  const data = { ...defaults, ...overrides };
  await TriggerRegModel.create(data);
  return data;
}

/**
 * Compute HMAC-SHA256 signature for the test-connector's verify function.
 *
 * The test-connector's verify reads `ctx.auth.apiKey` for the HMAC key.
 * The webhook handler passes `{ secret: decryptedWebhookSecret }` as the auth
 * object, so `apiKey` is undefined and the verify function falls back to
 * using an empty string as the HMAC key: `String(ctx.auth.apiKey ?? '')`.
 *
 * Therefore we compute the signature with an empty string key to match.
 */
function computeTestConnectorSignature(rawBody: Buffer): string {
  return crypto.createHmac('sha256', '').update(rawBody).digest('hex');
}

/** Build a WebhookRequest with sensible defaults */
function buildWebhookRequest(
  registrationId: string,
  body: Record<string, unknown>,
  extraHeaders: Record<string, string> = {},
): WebhookRequest {
  const rawBody = Buffer.from(JSON.stringify(body));
  const signature = computeTestConnectorSignature(rawBody);
  return {
    params: { connectorName: CONNECTOR_NAME, registrationId },
    headers: {
      'content-type': 'application/json',
      'x-signature-256': signature,
      ...extraHeaders,
    },
    body,
    rawBody,
  };
}

/** Build deps for the webhook handler */
function buildDeps(overrides: Partial<WebhookHandlerDeps> = {}): WebhookHandlerDeps {
  return {
    registry: createRegistry(),
    registrationModel,
    redis: createInMemoryRedis(),
    restateClient: createSpyRestateClient(),
    decryptSecret,
    ...overrides,
  };
}

/** Read a registration directly from MongoDB for assertion */
async function readRegistration(id: string): Promise<TriggerRegistration | null> {
  const doc = await TriggerRegModel.findOne({ _id: id }).lean().exec();
  return doc as TriggerRegistration | null;
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('Webhook Dispatch Chain (INT-3 + INT-7)', () => {
  // ── INT-3: Webhook dispatch chain ────────────────────────────────────────

  describe('INT-3: Webhook dispatch chain', () => {
    it('valid webhook is processed successfully — workflow started, health updated', async (ctx) => {
      skipIfNoMongo(ctx);

      const encryptedSecret = await encryptSecret(WEBHOOK_SECRET_PLAINTEXT, TENANT_ID);
      const reg = await seedRegistration({ webhookSecret: encryptedSecret });

      const restateClient = createSpyRestateClient();
      const deps = buildDeps({ restateClient });
      const payload = { event: 'test.created', data: { id: 42 } };
      const req = buildWebhookRequest(reg._id, payload);

      const result = await handleWebhook(req, deps);

      // Assert 200 with ok and executionId
      expect(result.status).toBe(200);
      expect(result.body.ok).toBe(true);
      expect(result.body.executionId).toBeDefined();
      expect(typeof result.body.executionId).toBe('string');

      // Assert restateClient.startWorkflow was called with correct metadata
      expect(restateClient.calls).toHaveLength(1);
      const call = restateClient.calls[0];
      expect(call.input.workflowId).toBe(WORKFLOW_ID);
      expect(call.input.tenantId).toBe(TENANT_ID);
      expect(call.input.projectId).toBe(PROJECT_ID);
      expect(call.input.triggerType).toBe('event');
      expect(call.input.triggerMetadata).toMatchObject({
        connectorName: CONNECTOR_NAME,
        triggerName: TRIGGER_NAME,
        registrationId: reg._id,
      });

      // Assert lastFiredAt was updated and consecutiveErrors reset to 0
      const updated = await readRegistration(reg._id);
      expect(updated).not.toBeNull();
      expect(updated!.consecutiveErrors).toBe(0);
      expect(updated!.lastFiredAt).toBeDefined();
    });

    it('missing registration returns 404', async (ctx) => {
      skipIfNoMongo(ctx);

      const deps = buildDeps();
      const req = buildWebhookRequest('non-existent-id', { event: 'test' });

      const result = await handleWebhook(req, deps);

      expect(result.status).toBe(404);
      expect(result.body.error).toEqual({ code: 'NOT_FOUND', message: 'Not found' });
    });

    it('invalid HMAC signature returns 401', async (ctx) => {
      skipIfNoMongo(ctx);

      const encryptedSecret = await encryptSecret(WEBHOOK_SECRET_PLAINTEXT, TENANT_ID);
      const reg = await seedRegistration({ webhookSecret: encryptedSecret });

      const deps = buildDeps();
      const body = { event: 'test.signed' };
      const rawBody = Buffer.from(JSON.stringify(body));

      // Use a wrong signature (not matching the empty-key HMAC the test-connector expects)
      const wrongSignature = crypto.createHmac('sha256', 'wrong-key').update(rawBody).digest('hex');

      const req: WebhookRequest = {
        params: { connectorName: CONNECTOR_NAME, registrationId: reg._id },
        headers: {
          'content-type': 'application/json',
          'x-signature-256': wrongSignature,
        },
        body,
        rawBody,
      };

      const result = await handleWebhook(req, deps);

      expect(result.status).toBe(401);
      expect(result.body.error).toEqual({
        code: 'INVALID_SIGNATURE',
        message: 'Invalid signature',
      });
    });

    it('dedup: second call with same event ID returns deduplicated', async (ctx) => {
      skipIfNoMongo(ctx);

      const reg = await seedRegistration();
      const restateClient = createSpyRestateClient();
      const redis = createInMemoryRedis();
      const deps = buildDeps({ restateClient, redis });

      const eventId = crypto.randomUUID();
      const payload = { event: 'test.dedup' };
      const req = buildWebhookRequest(reg._id, payload, {
        'x-webhook-id': eventId,
      });

      // First call succeeds
      const result1 = await handleWebhook(req, deps);
      expect(result1.status).toBe(200);
      expect(result1.body.ok).toBe(true);
      expect(result1.body.deduplicated).toBeUndefined();

      // Second call with same event ID is deduplicated
      const result2 = await handleWebhook(req, deps);
      expect(result2.status).toBe(200);
      expect(result2.body.deduplicated).toBe(true);

      // Workflow should have been started only once
      expect(restateClient.calls).toHaveLength(1);
    });

    it('replay protection: stale timestamp returns 401', async (ctx) => {
      skipIfNoMongo(ctx);

      const reg = await seedRegistration();
      const deps = buildDeps();

      // Timestamp older than WEBHOOK_REPLAY_TOLERANCE_MS
      const staleTimestamp = new Date(
        Date.now() - WEBHOOK_REPLAY_TOLERANCE_MS - 60_000,
      ).toISOString();

      const payload = { event: 'test.replay' };
      const req = buildWebhookRequest(reg._id, payload, {
        'x-webhook-timestamp': staleTimestamp,
      });

      const result = await handleWebhook(req, deps);

      expect(result.status).toBe(401);
      expect(result.body.error).toEqual({ code: 'REPLAY_DETECTED', message: 'Replay detected' });
    });
  });

  // ── INT-7: Auto-pause after consecutive failures ─────────────────────────

  describe('INT-7: Auto-pause after consecutive failures', () => {
    it('workflow dispatch failure increments consecutiveErrors', async (ctx) => {
      skipIfNoMongo(ctx);

      const reg = await seedRegistration();
      const restateClient = createSpyRestateClient();
      restateClient.shouldThrow = true;
      const deps = buildDeps({ restateClient });

      const req = buildWebhookRequest(reg._id, { event: 'test.fail' });
      const result = await handleWebhook(req, deps);

      expect(result.status).toBe(503);
      expect(result.body.error).toEqual({
        code: 'SERVICE_UNAVAILABLE',
        message: 'Workflow engine unavailable',
      });

      // Verify consecutiveErrors incremented in DB
      const updated = await readRegistration(reg._id);
      expect(updated).not.toBeNull();
      expect(updated!.consecutiveErrors).toBe(1);
      expect(updated!.lastErrorAt).toBeDefined();
    });

    it(`${TRIGGER_AUTO_PAUSE_THRESHOLD} consecutive failures transitions trigger to error status`, async (ctx) => {
      skipIfNoMongo(ctx);

      const reg = await seedRegistration();
      const restateClient = createSpyRestateClient();
      restateClient.shouldThrow = true;
      const deps = buildDeps({ restateClient });

      // Fire the webhook TRIGGER_AUTO_PAUSE_THRESHOLD times
      for (let i = 0; i < TRIGGER_AUTO_PAUSE_THRESHOLD; i++) {
        const req = buildWebhookRequest(reg._id, { event: 'test.fail', attempt: i });
        const result = await handleWebhook(req, deps);
        expect(result.status).toBe(503);
      }

      // After threshold failures, status should be 'error'
      const updated = await readRegistration(reg._id);
      expect(updated).not.toBeNull();
      expect(updated!.status).toBe('error');
      expect(updated!.consecutiveErrors).toBeGreaterThanOrEqual(TRIGGER_AUTO_PAUSE_THRESHOLD);
    });

    it('trigger in error state returns 404 (handler queries status: active)', async (ctx) => {
      skipIfNoMongo(ctx);

      // Create a registration that is already in 'error' status
      const reg = await seedRegistration({ status: 'error', consecutiveErrors: 10 });
      const deps = buildDeps();

      const req = buildWebhookRequest(reg._id, { event: 'test.after-pause' });
      const result = await handleWebhook(req, deps);

      // The handler queries findOne with status: 'active', so 'error' returns null -> 404
      expect(result.status).toBe(404);
      expect(result.body.error).toEqual({ code: 'NOT_FOUND', message: 'Not found' });
    });

    it('successful dispatch after failures resets error counter', async (ctx) => {
      skipIfNoMongo(ctx);

      const reg = await seedRegistration();
      const restateClient = createSpyRestateClient();
      restateClient.shouldThrow = true;
      const deps = buildDeps({ restateClient });

      // Fail 5 times
      for (let i = 0; i < 5; i++) {
        const req = buildWebhookRequest(reg._id, { event: 'test.fail', attempt: i });
        await handleWebhook(req, deps);
      }

      // Verify errors accumulated
      const afterFailures = await readRegistration(reg._id);
      expect(afterFailures!.consecutiveErrors).toBe(5);

      // Now succeed
      restateClient.shouldThrow = false;
      const successReq = buildWebhookRequest(reg._id, { event: 'test.recover' });
      const result = await handleWebhook(successReq, deps);

      expect(result.status).toBe(200);
      expect(result.body.ok).toBe(true);

      // Verify consecutiveErrors reset to 0
      const afterRecovery = await readRegistration(reg._id);
      expect(afterRecovery!.consecutiveErrors).toBe(0);
      expect(afterRecovery!.lastFiredAt).toBeDefined();
    });
  });
});
