import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import mongoose from 'mongoose';
import { decodeSharedAuditRecord } from '../../../compiler/src/platform/stores/shared-audit-codec.ts';
import {
  auditTrailPlugin,
  setAuditHandler,
  withAuditActor,
  type AuditActorContext,
} from '../mongo/plugins/audit-trail.plugin.js';
import {
  clearCollections,
  isMongoReady,
  setupTestMongo,
  teardownTestMongo,
} from './helpers/setup-mongo.js';

let modelCounter = 0;

function uniqueModelName(prefix: string): string {
  return `${prefix}_${++modelCounter}_${Date.now()}`;
}

beforeAll(async () => {
  await setupTestMongo();
});

afterAll(async () => {
  await teardownTestMongo();
});

beforeEach(async () => {
  await clearCollections();
});

describe('audit trail actor propagation', () => {
  const capturedEntries: Array<Record<string, unknown>> = [];

  beforeEach(() => {
    capturedEntries.length = 0;
    setAuditHandler((entry) => {
      capturedEntries.push(entry as Record<string, unknown>);
    });
  });

  afterEach(() => {
    setAuditHandler(null);
  });

  test('captures actor context for plugin-backed writes in supported paths', async () => {
    if (!isMongoReady()) return;

    const schema = new mongoose.Schema(
      {
        _id: String,
        tenantId: String,
        name: String,
      },
      { timestamps: true },
    );
    schema.plugin(auditTrailPlugin);

    const TestModel = mongoose.model(uniqueModelName('AuditActorPropagation'), schema);
    const actor: AuditActorContext = {
      userId: 'user-123',
      email: 'user@example.com',
      ip: '10.0.0.1',
      userAgent: 'vitest',
    };

    await withAuditActor(actor, async () => {
      await TestModel.create({ _id: 'doc-1', tenantId: 'tenant-1', name: 'Alpha' });
      await new Promise((resolve) => setTimeout(resolve, 25));
    });

    expect(capturedEntries).toContainEqual(
      expect.objectContaining({
        source: 'mongoose-plugin',
        schemaVersion: 1,
        collectionName: TestModel.collection.name,
        documentId: 'doc-1',
        operation: 'create',
        tenantId: 'tenant-1',
        actor: expect.objectContaining({
          userId: 'user-123',
          email: 'user@example.com',
          ip: '10.0.0.1',
          userAgent: 'vitest',
        }),
      }),
    );
  });

  test('missing actor context degrades safely without throwing', async () => {
    if (!isMongoReady()) return;

    const schema = new mongoose.Schema(
      {
        _id: String,
        tenantId: String,
        name: String,
      },
      { timestamps: true },
    );
    schema.plugin(auditTrailPlugin);

    const TestModel = mongoose.model(uniqueModelName('AuditActorMissing'), schema);

    await expect(
      TestModel.create({ _id: 'doc-2', tenantId: 'tenant-2', name: 'Beta' }),
    ).resolves.toBeDefined();
    await new Promise((resolve) => setTimeout(resolve, 25));

    expect(capturedEntries).toContainEqual(
      expect.objectContaining({
        source: 'mongoose-plugin',
        schemaVersion: 1,
        documentId: 'doc-2',
        actor: undefined,
      }),
    );
  });

  test('plugin rows remain classifiable by the shared codec', () => {
    const decoded = decodeSharedAuditRecord({
      _id: 'plugin-row-1',
      source: 'mongoose-plugin',
      schemaVersion: 1,
      tenantId: 'tenant-3',
      collectionName: 'tool_secrets',
      documentId: 'secret-1',
      operation: 'update',
      userId: 'user-9',
      email: 'user9@example.com',
      ip: '10.0.0.9',
      changes: { name: 'updated' },
    });

    expect(decoded.kind).toBe('mongoose-plugin');
    expect(decoded.envelope).toMatchObject({
      source: 'mongoose-plugin',
      tenantId: 'tenant-3',
      eventType: 'mongoose.update',
      action: 'update',
      actorId: 'user-9',
      resourceType: 'tool_secrets',
      resourceId: 'secret-1',
    });
  });
});
