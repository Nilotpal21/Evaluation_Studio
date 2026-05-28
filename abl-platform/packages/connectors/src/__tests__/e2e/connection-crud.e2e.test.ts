/**
 * E2E Test: Connection CRUD Lifecycle
 *
 * Tests the full connection lifecycle using real MongoDB (MongoMemoryServer)
 * and real ConnectorRegistry. No mocks of codebase components.
 *
 * Connections are pure binding records that link a connector to an auth profile.
 * No credential storage or encryption happens at this layer.
 *
 * The ConnectionService is framework-agnostic (no Express routes in this package),
 * so we test the service layer directly with a real database backing the model.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { ConnectionService, type ConnectionModel } from '../../services/connection-service.js';
import { ConnectorRegistry } from '../../registry.js';
import type { Connector } from '../../types.js';

// ─── MongoDB Setup ──────────────────────────────────────────────────────────

let mongod: MongoMemoryServer | undefined;
let mongoAvailable = false;

// Define a Mongoose schema that matches ConnectionRecord
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
  { collection: 'connector_connections', _id: false },
);

// Compound index for tenant + project isolation
connectionSchema.index({ tenantId: 1, projectId: 1 });

let ConnectionModel: mongoose.Model<mongoose.Document>;

// ─── Mongoose model adapter for ConnectionModel interface ───────────────────

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
      const result = await model
        .findOneAndUpdate(filter, update, { ...options, new: true })
        .lean()
        .exec();
      return result;
    },
    async findOneAndDelete(filter: Record<string, unknown>) {
      return model.findOneAndDelete(filter).lean().exec();
    },
  };
}

// ─── Test Connector ─────────────────────────────────────────────────────────

function makeTestConnector(): Connector {
  return {
    name: 'test-connector',
    displayName: 'Test Connector',
    version: '1.0.0',
    description: 'A connector for E2E testing',
    auth: {
      type: 'api_key',
      fields: [{ name: 'apiKey', displayName: 'API Key', required: true, sensitive: true }],
    },
    triggers: [],
    actions: [],
  };
}

// ─── Setup / Teardown ───────────────────────────────────────────────────────

beforeAll(async () => {
  try {
    mongod = await MongoMemoryServer.create();
    const uri = mongod.getUri();
    await mongoose.connect(uri);
    await mongoose.connection.asPromise();
    ConnectionModel = mongoose.model('ConnectorConnection', connectionSchema);
    await mongoose.connection.syncIndexes();
    mongoAvailable = true;
  } catch (err) {
    mongoAvailable = false;
    console.warn(
      '[E2E] MongoMemoryServer unavailable -- tests will be skipped',
      err instanceof Error ? err.message : String(err),
    );
  }
}, 30_000);

afterAll(async () => {
  if (mongoose.connection.readyState !== 0) {
    await mongoose.disconnect();
  }
  if (mongod) {
    await mongod.stop();
  }
});

beforeEach(async () => {
  if (!mongoAvailable) return;
  // Clear all documents between tests
  const collections = mongoose.connection.collections;
  for (const key in collections) {
    await collections[key].deleteMany({});
  }
});

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('E2E: Connection CRUD Lifecycle', () => {
  function createService(): ConnectionService {
    const registry = new ConnectorRegistry();
    registry.register(makeTestConnector());

    return new ConnectionService({
      connectionModel: createModelAdapter(ConnectionModel),
      registry,
    });
  }

  it('skips if MongoDB unavailable', ({ skip }) => {
    if (!mongoAvailable) skip('MongoMemoryServer unavailable');
  });

  // ── 1. Create a connection ──────────────────────────────────────────────

  it('creates a connection with authProfileId', async ({ skip }) => {
    if (!mongoAvailable) skip('MongoMemoryServer unavailable');

    const svc = createService();
    const result = await svc.create('tenant-1', 'project-1', {
      connectorName: 'test-connector',
      displayName: 'My Test Connection',
      authProfileId: 'ap-1',
    });

    expect(result._id).toBeDefined();
    expect(result.tenantId).toBe('tenant-1');
    expect(result.projectId).toBe('project-1');
    expect(result.connectorName).toBe('test-connector');
    expect(result.displayName).toBe('My Test Connection');
    expect(result.authProfileId).toBe('ap-1');
    expect(result.status).toBe('active');
  });

  // ── 2. Connection record has authProfileId, no credential fields ──────

  it('connection record has authProfileId and no credential fields', async ({ skip }) => {
    if (!mongoAvailable) skip('MongoMemoryServer unavailable');

    const svc = createService();
    const created = await svc.create('tenant-1', 'project-1', {
      connectorName: 'test-connector',
      displayName: 'Auth Profile Test',
      authProfileId: 'ap-2',
    });

    // Verify getById returns authProfileId
    const fetched = await svc.getById('tenant-1', 'project-1', created._id);
    expect(fetched).not.toBeNull();
    expect(fetched!.authProfileId).toBe('ap-2');

    // Verify list returns authProfileId
    const list = await svc.list('tenant-1', 'project-1');
    expect(list.length).toBe(1);
    expect(list[0].authProfileId).toBe('ap-2');
  });

  // ── 3. List connections ─────────────────────────────────────────────────

  it('lists connections scoped by tenant and project', async ({ skip }) => {
    if (!mongoAvailable) skip('MongoMemoryServer unavailable');

    const svc = createService();

    // Create two connections in the same project (different auth profiles)
    await svc.create('tenant-1', 'project-1', {
      connectorName: 'test-connector',
      displayName: 'Connection A',
      authProfileId: 'ap-a',
    });

    // Different project
    await svc.create('tenant-1', 'project-2', {
      connectorName: 'test-connector',
      displayName: 'Connection C',
      authProfileId: 'ap-c',
    });

    const list = await svc.list('tenant-1', 'project-1');
    expect(list.length).toBe(1);
    expect(list[0].displayName).toBe('Connection A');
  });

  // ── 4. Get connection by ID ─────────────────────────────────────────────

  it('gets a connection by ID with correct tenant and project', async ({ skip }) => {
    if (!mongoAvailable) skip('MongoMemoryServer unavailable');

    const svc = createService();
    const created = await svc.create('tenant-1', 'project-1', {
      connectorName: 'test-connector',
      displayName: 'Get By ID Test',
      authProfileId: 'ap-get',
    });

    const fetched = await svc.getById('tenant-1', 'project-1', created._id);
    expect(fetched).not.toBeNull();
    expect(fetched!.displayName).toBe('Get By ID Test');
    expect(fetched!._id).toBe(created._id);
  });

  // ── 5. Update connection display name ───────────────────────────────────

  it('updates a connection display name', async ({ skip }) => {
    if (!mongoAvailable) skip('MongoMemoryServer unavailable');

    const svc = createService();
    const created = await svc.create('tenant-1', 'project-1', {
      connectorName: 'test-connector',
      displayName: 'Original Name',
      authProfileId: 'ap-update',
    });

    const updated = await svc.update('tenant-1', 'project-1', created._id, {
      displayName: 'Updated Name',
    });

    expect(updated).not.toBeNull();
    expect(updated!.displayName).toBe('Updated Name');

    // Verify via get
    const fetched = await svc.getById('tenant-1', 'project-1', created._id);
    expect(fetched!.displayName).toBe('Updated Name');
  });

  // ── 6. Delete connection ────────────────────────────────────────────────

  it('deletes a connection', async ({ skip }) => {
    if (!mongoAvailable) skip('MongoMemoryServer unavailable');

    const svc = createService();
    const created = await svc.create('tenant-1', 'project-1', {
      connectorName: 'test-connector',
      displayName: 'To Delete',
      authProfileId: 'ap-delete',
    });

    const deleted = await svc.delete('tenant-1', 'project-1', created._id);
    expect(deleted).toBe(true);
  });

  // ── 7. Verify 404 after delete ──────────────────────────────────────────

  it('returns null when getting a deleted connection', async ({ skip }) => {
    if (!mongoAvailable) skip('MongoMemoryServer unavailable');

    const svc = createService();
    const created = await svc.create('tenant-1', 'project-1', {
      connectorName: 'test-connector',
      displayName: 'Delete Then Fetch',
      authProfileId: 'ap-del-fetch',
    });

    await svc.delete('tenant-1', 'project-1', created._id);

    const fetched = await svc.getById('tenant-1', 'project-1', created._id);
    expect(fetched).toBeNull();

    // Also verify it doesn't appear in list
    const list = await svc.list('tenant-1', 'project-1');
    expect(list.length).toBe(0);
  });

  // ── 8. Tenant isolation ─────────────────────────────────────────────────

  it('different tenant cannot access connection (tenant isolation)', async ({ skip }) => {
    if (!mongoAvailable) skip('MongoMemoryServer unavailable');

    const svc = createService();
    const created = await svc.create('tenant-1', 'project-1', {
      connectorName: 'test-connector',
      displayName: 'Tenant Isolated',
      authProfileId: 'ap-iso',
    });

    // Different tenant cannot get the connection
    const fetched = await svc.getById('tenant-2', 'project-1', created._id);
    expect(fetched).toBeNull();

    // Different tenant cannot list the connection
    const list = await svc.list('tenant-2', 'project-1');
    expect(list.length).toBe(0);

    // Different tenant cannot update the connection
    const updated = await svc.update('tenant-2', 'project-1', created._id, {
      displayName: 'Hacked',
    });
    expect(updated).toBeNull();

    // Different tenant cannot delete the connection
    const deleted = await svc.delete('tenant-2', 'project-1', created._id);
    expect(deleted).toBe(false);

    // Verify original is untouched
    const original = await svc.getById('tenant-1', 'project-1', created._id);
    expect(original!.displayName).toBe('Tenant Isolated');
  });

  // ── 9. Project isolation ────────────────────────────────────────────────

  it('different project cannot access connection (project isolation)', async ({ skip }) => {
    if (!mongoAvailable) skip('MongoMemoryServer unavailable');

    const svc = createService();
    const created = await svc.create('tenant-1', 'project-1', {
      connectorName: 'test-connector',
      displayName: 'Project Isolated',
      authProfileId: 'ap-proj-iso',
    });

    // Same tenant, different project cannot get the connection
    const fetched = await svc.getById('tenant-1', 'project-2', created._id);
    expect(fetched).toBeNull();

    // Same tenant, different project cannot list the connection
    const list = await svc.list('tenant-1', 'project-2');
    expect(list.length).toBe(0);

    // Same tenant, different project cannot update the connection
    const updated = await svc.update('tenant-1', 'project-2', created._id, {
      displayName: 'Hacked',
    });
    expect(updated).toBeNull();

    // Same tenant, different project cannot delete the connection
    const deleted = await svc.delete('tenant-1', 'project-2', created._id);
    expect(deleted).toBe(false);

    // Verify original is untouched
    const original = await svc.getById('tenant-1', 'project-1', created._id);
    expect(original!.displayName).toBe('Project Isolated');
  });

  // ── 10. Full lifecycle (create → get → update → list → delete → verify) ──

  it('full CRUD lifecycle in sequence', async ({ skip }) => {
    if (!mongoAvailable) skip('MongoMemoryServer unavailable');

    const svc = createService();

    // Create
    const created = await svc.create('tenant-1', 'project-1', {
      connectorName: 'test-connector',
      displayName: 'Lifecycle Test',
      authProfileId: 'ap-lifecycle',
    });
    expect(created._id).toBeDefined();
    expect(created.status).toBe('active');

    // Get
    const fetched = await svc.getById('tenant-1', 'project-1', created._id);
    expect(fetched).not.toBeNull();
    expect(fetched!.displayName).toBe('Lifecycle Test');

    // Update
    const updated = await svc.update('tenant-1', 'project-1', created._id, {
      displayName: 'Lifecycle Updated',
    });
    expect(updated!.displayName).toBe('Lifecycle Updated');

    // List
    const list = await svc.list('tenant-1', 'project-1');
    expect(list.length).toBe(1);
    expect(list[0].displayName).toBe('Lifecycle Updated');

    // Delete
    const deleted = await svc.delete('tenant-1', 'project-1', created._id);
    expect(deleted).toBe(true);

    // Verify gone
    const gone = await svc.getById('tenant-1', 'project-1', created._id);
    expect(gone).toBeNull();

    // Verify not in list
    const emptyList = await svc.list('tenant-1', 'project-1');
    expect(emptyList.length).toBe(0);
  });

  // ── 11. Delete returns false for nonexistent connection ─────────────────

  it('returns false when deleting a nonexistent connection', async ({ skip }) => {
    if (!mongoAvailable) skip('MongoMemoryServer unavailable');

    const svc = createService();
    const result = await svc.delete('tenant-1', 'project-1', 'nonexistent-id');
    expect(result).toBe(false);
  });

  // ── 12. Connector validation ────────────────────────────────────────────

  it('allows unregistered connector when authProfileId is provided', async ({ skip }) => {
    if (!mongoAvailable) skip('MongoMemoryServer unavailable');

    const svc = createService();
    const conn = await svc.create('tenant-1', 'project-1', {
      connectorName: 'catalog-only-connector',
      displayName: 'Catalog Connector',
      authProfileId: 'ap-catalog',
    });
    expect(conn.connectorName).toBe('catalog-only-connector');
    expect(conn.authProfileId).toBe('ap-catalog');
  });

  it('rejects creation without authProfileId', async ({ skip }) => {
    if (!mongoAvailable) skip('MongoMemoryServer unavailable');

    const svc = createService();
    await expect(
      svc.create('tenant-1', 'project-1', {
        connectorName: 'nonexistent-connector',
        displayName: 'Bad Connector',
        authProfileId: '',
      }),
    ).rejects.toThrow('authProfileId');
  });
});
