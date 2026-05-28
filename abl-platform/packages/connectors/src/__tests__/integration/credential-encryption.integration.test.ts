/**
 * Integration Test: Connection Binding Model (INT-4)
 *
 * Tests that ConnectionService correctly creates, queries, and manages
 * connection binding records. Connections are pure binding records that
 * link a connector to an auth profile — no credential storage or encryption
 * happens at this layer.
 *
 * No mocks of codebase components. Uses real ConnectionService with real MongoDB.
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
  { collection: 'connection_binding_test', _id: false },
);

connectionSchema.index({ tenantId: 1, projectId: 1 });
connectionSchema.index(
  { tenantId: 1, projectId: 1, connectorName: 1, authProfileId: 1 },
  { unique: true },
);

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

// ─── Test Connector ─────────────────────────────────────────────────────────

function makeTestConnector(name = 'binding-test-connector'): Connector {
  return {
    name,
    displayName: `${name} Display`,
    version: '1.0.0',
    description: 'A connector for binding integration testing',
    auth: { type: 'api_key' },
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
    ConnModel = mongoose.model('ConnectionBindingTest', connectionSchema);
    await mongoose.connection.syncIndexes();
    mongoAvailable = true;
  } catch (err) {
    mongoAvailable = false;
    console.warn(
      '[INT] MongoMemoryServer unavailable -- tests will be skipped',
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
  const collections = mongoose.connection.collections;
  for (const key in collections) {
    await collections[key].deleteMany({});
  }
});

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('Integration: Connection Binding Model (INT-4)', () => {
  function createService(): ConnectionService {
    const registry = new ConnectorRegistry();
    registry.register(makeTestConnector());
    registry.register(makeTestConnector('second-connector'));

    return new ConnectionService({
      connectionModel: createModelAdapter(ConnModel),
      registry,
    });
  }

  it('skips if MongoDB unavailable', ({ skip }) => {
    if (!mongoAvailable) skip('MongoMemoryServer unavailable');
  });

  it('stores authProfileId in the created connection record', async ({ skip }) => {
    if (!mongoAvailable) skip('MongoMemoryServer unavailable');

    const svc = createService();

    const created = await svc.create('tenant-1', 'project-1', {
      connectorName: 'binding-test-connector',
      displayName: 'Auth Profile Binding',
      authProfileId: 'ap-slack-oauth-123',
    });

    expect(created._id).toBeDefined();
    expect(created.authProfileId).toBe('ap-slack-oauth-123');

    const rawDoc = await ConnModel.findOne({ _id: created._id }).lean().exec();
    expect(rawDoc).not.toBeNull();
    const raw = rawDoc as unknown as { authProfileId: string };
    expect(raw.authProfileId).toBe('ap-slack-oauth-123');
  });

  it('getById returns connection with authProfileId', async ({ skip }) => {
    if (!mongoAvailable) skip('MongoMemoryServer unavailable');

    const svc = createService();

    const created = await svc.create('tenant-1', 'project-1', {
      connectorName: 'binding-test-connector',
      displayName: 'Retrievable Connection',
      authProfileId: 'ap-retrieve',
    });

    const fetched = await svc.getById('tenant-1', 'project-1', created._id);
    expect(fetched).not.toBeNull();
    expect(fetched!.authProfileId).toBe('ap-retrieve');
  });

  it('list returns connections with their authProfileId values', async ({ skip }) => {
    if (!mongoAvailable) skip('MongoMemoryServer unavailable');

    const svc = createService();

    await svc.create('tenant-1', 'project-1', {
      connectorName: 'binding-test-connector',
      displayName: 'Connection A',
      authProfileId: 'ap-a',
    });
    await svc.create('tenant-1', 'project-1', {
      connectorName: 'second-connector',
      displayName: 'Connection B',
      authProfileId: 'ap-b',
    });

    const list = await svc.list('tenant-1', 'project-1');
    expect(list).toHaveLength(2);

    const profileIds = list.map((c) => c.authProfileId).sort();
    expect(profileIds).toEqual(['ap-a', 'ap-b']);
  });

  it('update preserves authProfileId when updating other fields', async ({ skip }) => {
    if (!mongoAvailable) skip('MongoMemoryServer unavailable');

    const svc = createService();

    const created = await svc.create('tenant-1', 'project-1', {
      connectorName: 'binding-test-connector',
      displayName: 'Before Update',
      authProfileId: 'ap-preserved',
    });

    const updated = await svc.update('tenant-1', 'project-1', created._id, {
      displayName: 'After Update',
    });

    expect(updated).not.toBeNull();
    expect(updated!.displayName).toBe('After Update');

    const rawDoc = await ConnModel.findOne({ _id: created._id }).lean().exec();
    const raw = rawDoc as unknown as { authProfileId: string };
    expect(raw.authProfileId).toBe('ap-preserved');
  });

  it('different connectors can reference the same auth profile', async ({ skip }) => {
    if (!mongoAvailable) skip('MongoMemoryServer unavailable');

    const svc = createService();

    const conn1 = await svc.create('tenant-1', 'project-1', {
      connectorName: 'binding-test-connector',
      displayName: 'Connector 1',
      authProfileId: 'ap-shared',
    });

    const conn2 = await svc.create('tenant-1', 'project-1', {
      connectorName: 'second-connector',
      displayName: 'Connector 2',
      authProfileId: 'ap-shared',
    });

    expect(conn1.authProfileId).toBe('ap-shared');
    expect(conn2.authProfileId).toBe('ap-shared');
    expect(conn1._id).not.toBe(conn2._id);
  });

  it('rejects creation without authProfileId', async ({ skip }) => {
    if (!mongoAvailable) skip('MongoMemoryServer unavailable');

    const svc = createService();

    await expect(
      svc.create('tenant-1', 'project-1', {
        connectorName: 'binding-test-connector',
        displayName: 'No Auth Profile',
        authProfileId: '',
      }),
    ).rejects.toThrow('authProfileId');
  });

  it('deleted connection no longer appears in queries', async ({ skip }) => {
    if (!mongoAvailable) skip('MongoMemoryServer unavailable');

    const svc = createService();

    const created = await svc.create('tenant-1', 'project-1', {
      connectorName: 'binding-test-connector',
      displayName: 'To Delete',
      authProfileId: 'ap-delete',
    });

    const deleted = await svc.delete('tenant-1', 'project-1', created._id);
    expect(deleted).toBe(true);

    const fetched = await svc.getById('tenant-1', 'project-1', created._id);
    expect(fetched).toBeNull();
  });

  it('different tenants cannot access each others binding records', async ({ skip }) => {
    if (!mongoAvailable) skip('MongoMemoryServer unavailable');

    const svc = createService();

    const created = await svc.create('tenant-1', 'project-1', {
      connectorName: 'binding-test-connector',
      displayName: 'Tenant 1 Only',
      authProfileId: 'ap-tenant-1',
    });

    const fetched = await svc.getById('tenant-2', 'project-1', created._id);
    expect(fetched).toBeNull();

    const list = await svc.list('tenant-2', 'project-1');
    expect(list).toHaveLength(0);
  });

  it('connection record has no credential fields in raw DB', async ({ skip }) => {
    if (!mongoAvailable) skip('MongoMemoryServer unavailable');

    const svc = createService();

    const created = await svc.create('tenant-1', 'project-1', {
      connectorName: 'binding-test-connector',
      displayName: 'No Credentials',
      authProfileId: 'ap-clean',
    });

    const rawDoc = await ConnModel.findOne({ _id: created._id }).lean().exec();
    const raw = rawDoc as Record<string, unknown>;

    expect(raw).not.toHaveProperty('encryptedCredentials');
    expect(raw).not.toHaveProperty('encryptionKeyVersion');
    expect(raw).not.toHaveProperty('oauth2RefreshToken');
    expect(raw).not.toHaveProperty('oauth2TokenExpiresAt');
    expect(raw).not.toHaveProperty('oauth2ConnectionConfig');
    expect(raw).not.toHaveProperty('oauth2Provider');
    expect(raw).not.toHaveProperty('scopes');
    expect(raw).not.toHaveProperty('authType');

    expect(raw).toHaveProperty('authProfileId', 'ap-clean');
  });
});
