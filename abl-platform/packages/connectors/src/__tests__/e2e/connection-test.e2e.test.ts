/**
 * E2E Test: Connection Test Lifecycle
 *
 * Tests the connection test functionality using real MongoDB (MongoMemoryServer),
 * real ConnectorRegistry, and auth profile resolution via a test implementation.
 * Connections are pure binding records — credential resolution is delegated to
 * the auth profile system.
 *
 * No mocks of codebase components. The test connector's test_connection action
 * uses a real HTTP server to simulate success/failure.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import http from 'http';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import {
  ConnectionService,
  ConnectionServiceError,
  type ConnectionModel,
  type AuthProfileResolverLike,
} from '../../services/connection-service.js';
import { ConnectorRegistry } from '../../registry.js';
import type { Connector, ActionContext } from '../../types.js';

// ─── MongoDB Setup ──────────────────────────────────────────────────────────

let mongod: MongoMemoryServer | undefined;
let mongoAvailable = false;

const connectionSchema = new mongoose.Schema(
  {
    _id: { type: String, required: true },
    tenantId: { type: String, required: true, index: true },
    projectId: { type: String, required: true, index: true },
    connectorName: { type: String, required: true },
    displayName: { type: String, required: true },
    scope: { type: String, enum: ['tenant', 'user'], default: 'tenant' },
    userId: { type: String },
    authProfileId: { type: String, required: true },
    status: { type: String, enum: ['active', 'expired', 'revoked'], default: 'active' },
    createdAt: { type: Date, default: Date.now },
    updatedAt: { type: Date, default: Date.now },
  },
  { collection: 'connector_connections_test', _id: false },
);

connectionSchema.index({ tenantId: 1, projectId: 1 });

let ConnModel: mongoose.Model<mongoose.Document>;

// ─── Mongoose Model Adapter ────────────────────────────────────────────────

function createModelAdapter(model: mongoose.Model<mongoose.Document>): ConnectionModel {
  return {
    find(filter: Record<string, unknown>) {
      return {
        sort(sortSpec: Record<string, unknown>) {
          return {
            async lean() {
              return model.find(filter).sort(sortSpec).lean().exec();
            },
          };
        },
      };
    },
    findOne(filter: Record<string, unknown>) {
      return {
        async lean() {
          return model.findOne(filter).lean().exec();
        },
      };
    },
    async create(data: Record<string, unknown>) {
      const doc = await model.create(data);
      return doc.toObject();
    },
    async findOneAndUpdate(
      filter: Record<string, unknown>,
      update: Record<string, unknown>,
      options?: Record<string, unknown>,
    ) {
      return model
        .findOneAndUpdate(filter, update, { ...options, new: true })
        .lean()
        .exec();
    },
    async findOneAndDelete(filter: Record<string, unknown>) {
      return model.findOneAndDelete(filter).lean().exec();
    },
  };
}

// ─── Mock External Test Server ──────────────────────────────────────────────

let testServer: http.Server;
let testServerPort: number;
let testServerShouldFail = false;

function startTestServer(): Promise<void> {
  return new Promise((resolve) => {
    testServer = http.createServer((req, res) => {
      if (testServerShouldFail) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Service unavailable' }));
      } else {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      }
    });

    testServer.listen(0, () => {
      const addr = testServer.address();
      testServerPort = typeof addr === 'object' && addr !== null ? addr.port : 0;
      resolve();
    });
  });
}

function stopTestServer(): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!testServer) {
      resolve();
      return;
    }
    testServer.close((err) => {
      if (err) reject(err);
      else resolve();
    });
  });
}

// ─── Test Connector with test_connection Action ─────────────────────────────

function makeTestableConnector(): Connector {
  return {
    name: 'testable-connector',
    displayName: 'Testable Connector',
    version: '1.0.0',
    description: 'A connector with a test_connection action for E2E testing',
    auth: { type: 'api_key' },
    triggers: [],
    actions: [
      {
        name: 'test_connection',
        displayName: 'Test Connection',
        description: 'Tests the connection by calling the external service',
        props: [],
        async run(ctx: ActionContext): Promise<unknown> {
          // Make a real HTTP request to the test server
          const apiKey = ctx.auth.apiKey as string | undefined;
          const baseUrl = ctx.auth.baseUrl as string | undefined;

          if (!baseUrl) {
            throw new Error('Missing baseUrl in credentials');
          }

          const response = await fetch(`${baseUrl}/health`, {
            headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
          });

          if (!response.ok) {
            throw new Error(`Connection test failed: HTTP ${response.status}`);
          }

          return { ok: true };
        },
      },
    ],
  };
}

function makeNoTestConnector(): Connector {
  return {
    name: 'no-test-connector',
    displayName: 'No Test Connector',
    version: '1.0.0',
    description: 'A connector without a test_connection action',
    auth: { type: 'none' },
    triggers: [],
    actions: [],
  };
}

// ─── Auth Profile Resolver (test implementation for external dependency) ────

/** Stores credentials keyed by authProfileId for test purposes */
const authProfileCredentials: Record<string, Record<string, unknown>> = {};

function createAuthProfileResolver(): AuthProfileResolverLike {
  return {
    async resolve(opts: { authProfileId: string }) {
      return authProfileCredentials[opts.authProfileId] ?? {};
    },
  };
}

// ─── Setup / Teardown ───────────────────────────────────────────────────────

beforeAll(async () => {
  try {
    mongod = await MongoMemoryServer.create();
    const uri = mongod.getUri();
    await mongoose.connect(uri);
    await mongoose.connection.asPromise();
    ConnModel = mongoose.model('ConnectorConnectionTest', connectionSchema);
    await mongoose.connection.syncIndexes();
    mongoAvailable = true;
  } catch (err) {
    mongoAvailable = false;
    console.warn(
      '[E2E] MongoMemoryServer unavailable -- tests will be skipped',
      err instanceof Error ? err.message : String(err),
    );
  }

  await startTestServer();
}, 30_000);

afterAll(async () => {
  await stopTestServer();
  if (mongoose.connection.readyState !== 0) {
    await mongoose.disconnect();
  }
  if (mongod) {
    await mongod.stop();
  }
});

beforeEach(async () => {
  if (!mongoAvailable) return;
  testServerShouldFail = false;
  // Clear auth profile credentials
  for (const key of Object.keys(authProfileCredentials)) {
    delete authProfileCredentials[key];
  }
  const collections = mongoose.connection.collections;
  for (const key in collections) {
    await collections[key].deleteMany({});
  }
});

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('E2E: Connection Test Lifecycle', () => {
  function createService(connectors?: Connector[]): ConnectionService {
    const registry = new ConnectorRegistry();
    for (const c of connectors ?? [makeTestableConnector(), makeNoTestConnector()]) {
      registry.register(c);
    }

    return new ConnectionService({
      connectionModel: createModelAdapter(ConnModel),
      registry,
      authProfileResolver: createAuthProfileResolver(),
    });
  }

  // ── 1. Successful test → status stays active ──────────────────────────

  it('successful connection test returns success and keeps status active', async ({ skip }) => {
    if (!mongoAvailable) skip('MongoMemoryServer unavailable');

    const svc = createService();
    testServerShouldFail = false;

    // Set up auth profile credentials
    authProfileCredentials['ap-test'] = {
      apiKey: 'test-key',
      baseUrl: `http://localhost:${testServerPort}`,
    };

    // Create connection binding
    const created = await svc.create('tenant-1', 'project-1', {
      connectorName: 'testable-connector',
      displayName: 'Active Connection',
      authProfileId: 'ap-test',
    });

    // Run test
    const result = await svc.test('tenant-1', 'project-1', created._id);

    expect(result.success).toBe(true);
    expect(result.latencyMs).toBeGreaterThan(0);
    expect(result.error).toBeUndefined();

    // Verify status is still active
    const fetched = await svc.getById('tenant-1', 'project-1', created._id);
    expect(fetched!.status).toBe('active');
  });

  // ── 2. Failed test → status changes to expired ────────────────────────

  it('failed connection test returns failure and changes status to expired', async ({ skip }) => {
    if (!mongoAvailable) skip('MongoMemoryServer unavailable');

    const svc = createService();

    // Set up auth profile credentials
    authProfileCredentials['ap-fail'] = {
      apiKey: 'test-key',
      baseUrl: `http://localhost:${testServerPort}`,
    };

    // Create an active connection
    const created = await svc.create('tenant-1', 'project-1', {
      connectorName: 'testable-connector',
      displayName: 'Will Expire',
      authProfileId: 'ap-fail',
    });

    // Verify initial status is active
    const beforeTest = await svc.getById('tenant-1', 'project-1', created._id);
    expect(beforeTest!.status).toBe('active');

    // Make the external server fail
    testServerShouldFail = true;

    // Run test — should fail
    const result = await svc.test('tenant-1', 'project-1', created._id);

    expect(result.success).toBe(false);
    expect(result.latencyMs).toBeGreaterThan(0);
    expect(result.error).toBeDefined();

    // Verify status changed to expired
    const afterTest = await svc.getById('tenant-1', 'project-1', created._id);
    expect(afterTest!.status).toBe('expired');
  });

  // ── 3. Test on expired connection → success restores to active ────────

  it('successful test on expired connection restores status to active', async ({ skip }) => {
    if (!mongoAvailable) skip('MongoMemoryServer unavailable');

    const svc = createService();

    // Set up auth profile credentials
    authProfileCredentials['ap-restore'] = {
      apiKey: 'test-key',
      baseUrl: `http://localhost:${testServerPort}`,
    };

    // Create connection
    const created = await svc.create('tenant-1', 'project-1', {
      connectorName: 'testable-connector',
      displayName: 'Was Expired',
      authProfileId: 'ap-restore',
    });

    // Force status to expired via update
    await svc.update('tenant-1', 'project-1', created._id, { status: 'expired' });
    const expired = await svc.getById('tenant-1', 'project-1', created._id);
    expect(expired!.status).toBe('expired');

    // Run successful test
    testServerShouldFail = false;
    const result = await svc.test('tenant-1', 'project-1', created._id);

    expect(result.success).toBe(true);

    // Verify status restored to active
    const restored = await svc.getById('tenant-1', 'project-1', created._id);
    expect(restored!.status).toBe('active');
  });

  // ── 4. Nonexistent connection → NOT_FOUND error ───────────────────────

  it('throws NOT_FOUND for nonexistent connection', async ({ skip }) => {
    if (!mongoAvailable) skip('MongoMemoryServer unavailable');

    const svc = createService();

    try {
      await svc.test('tenant-1', 'project-1', 'nonexistent-id');
      expect.fail('Should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(ConnectionServiceError);
      expect((err as ConnectionServiceError).code).toBe('NOT_FOUND');
      expect((err as ConnectionServiceError).message).toBe('Connection not found');
    }
  });

  // ── 5. Cross-tenant → NOT_FOUND error (tenant isolation) ─────────────

  it('throws NOT_FOUND when testing cross-tenant connection', async ({ skip }) => {
    if (!mongoAvailable) skip('MongoMemoryServer unavailable');

    const svc = createService();

    // Set up auth profile credentials
    authProfileCredentials['ap-tenant-iso'] = {
      apiKey: 'test-key',
      baseUrl: `http://localhost:${testServerPort}`,
    };

    // Create connection for tenant-1
    const created = await svc.create('tenant-1', 'project-1', {
      connectorName: 'testable-connector',
      displayName: 'Tenant 1 Only',
      authProfileId: 'ap-tenant-iso',
    });

    // Try to test from tenant-2
    try {
      await svc.test('tenant-2', 'project-1', created._id);
      expect.fail('Should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(ConnectionServiceError);
      expect((err as ConnectionServiceError).code).toBe('NOT_FOUND');
    }

    // Verify original connection is still active (unchanged)
    const original = await svc.getById('tenant-1', 'project-1', created._id);
    expect(original!.status).toBe('active');
  });

  // ── 6. Cross-project → NOT_FOUND error (project isolation) ────────────

  it('throws NOT_FOUND when testing cross-project connection', async ({ skip }) => {
    if (!mongoAvailable) skip('MongoMemoryServer unavailable');

    const svc = createService();

    // Set up auth profile credentials
    authProfileCredentials['ap-proj-iso'] = {
      apiKey: 'test-key',
      baseUrl: `http://localhost:${testServerPort}`,
    };

    // Create connection for project-1
    const created = await svc.create('tenant-1', 'project-1', {
      connectorName: 'testable-connector',
      displayName: 'Project 1 Only',
      authProfileId: 'ap-proj-iso',
    });

    // Try to test from project-2
    try {
      await svc.test('tenant-1', 'project-2', created._id);
      expect.fail('Should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(ConnectionServiceError);
      expect((err as ConnectionServiceError).code).toBe('NOT_FOUND');
    }
  });

  // ── 7. Connector without test_connection action → success ─────────────

  it('returns success for connector without test_connection action', async ({ skip }) => {
    if (!mongoAvailable) skip('MongoMemoryServer unavailable');

    const svc = createService();

    authProfileCredentials['ap-no-test'] = {};

    // Create connection with no-test connector
    const created = await svc.create('tenant-1', 'project-1', {
      connectorName: 'no-test-connector',
      displayName: 'No Test Action',
      authProfileId: 'ap-no-test',
    });

    const result = await svc.test('tenant-1', 'project-1', created._id);
    expect(result.success).toBe(true);
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
  });

  // ── 8. Latency measurement is non-zero for real HTTP test ─────────────

  it('measures non-zero latency for real HTTP connection test', async ({ skip }) => {
    if (!mongoAvailable) skip('MongoMemoryServer unavailable');

    const svc = createService();
    testServerShouldFail = false;

    authProfileCredentials['ap-latency'] = {
      apiKey: 'test-key',
      baseUrl: `http://localhost:${testServerPort}`,
    };

    const created = await svc.create('tenant-1', 'project-1', {
      connectorName: 'testable-connector',
      displayName: 'Latency Test',
      authProfileId: 'ap-latency',
    });

    const result = await svc.test('tenant-1', 'project-1', created._id);
    expect(result.success).toBe(true);
    expect(result.latencyMs).toBeGreaterThan(0);
    // Latency should be reasonable (< 5 seconds for a local HTTP call)
    expect(result.latencyMs).toBeLessThan(5000);
  });

  // ── 9. Connection with bad credentials → test fails gracefully ────────

  it('test fails gracefully with bad credentials (unreachable server)', async ({ skip }) => {
    if (!mongoAvailable) skip('MongoMemoryServer unavailable');

    const svc = createService();

    authProfileCredentials['ap-bad'] = {
      apiKey: 'bad-key',
      baseUrl: 'http://localhost:1',
    };

    // Create connection pointing to a non-existent server
    const created = await svc.create('tenant-1', 'project-1', {
      connectorName: 'testable-connector',
      displayName: 'Bad Credentials',
      authProfileId: 'ap-bad',
    });

    const result = await svc.test('tenant-1', 'project-1', created._id);
    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);

    // Status should have changed to expired
    const fetched = await svc.getById('tenant-1', 'project-1', created._id);
    expect(fetched!.status).toBe('expired');
  });
});
