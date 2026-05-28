/**
 * MongoDB Plugin Tests
 *
 * Tests for: audit-trail, tenant-isolation, encryption, lean-id, slow-query plugins
 *
 * Pure-logic tests always run. MongoDB-dependent tests gracefully skip if
 * MongoMemoryServer is not available in the environment.
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import mongoose from 'mongoose';
import {
  setupTestMongo,
  teardownTestMongo,
  clearCollections,
  isMongoReady,
  initTestDEKFacade,
} from './helpers/setup-mongo.js';

import {
  auditTrailPlugin,
  withAuditActor,
  getCurrentAuditActor,
  setAuditHandler,
  type AuditActorContext,
} from '../mongo/plugins/audit-trail.plugin.js';

import {
  tenantIsolationPlugin,
  withTenantContext,
  getCurrentTenantContext,
  withSuperAdminContext,
} from '../mongo/plugins/tenant-isolation.plugin.js';

import { encryptionPlugin, setMasterKey } from '../mongo/plugins/encryption.plugin.js';

import { leanIdPlugin } from '../mongo/plugins/lean-id.plugin.js';

import {
  slowQueryPlugin,
  setSlowQueryThreshold,
  setSlowQueryLogHandler,
} from '../mongo/plugins/slow-query.plugin.js';

import { uuidv7 } from '../mongo/base-document.js';

// =============================================================================
// SETUP / TEARDOWN
// =============================================================================

beforeAll(async () => {
  await setupTestMongo();
});

afterAll(async () => {
  await teardownTestMongo();
});

beforeEach(async () => {
  await clearCollections();
});

// =============================================================================
// HELPERS
// =============================================================================

let modelCounter = 0;
function uniqueModelName(prefix: string): string {
  return `${prefix}_${++modelCounter}_${Date.now()}`;
}

// =============================================================================
// PURE LOGIC TESTS (no MongoDB required)
// =============================================================================

describe('Plugin pure logic', () => {
  describe('audit actor context', () => {
    test('getCurrentAuditActor returns undefined outside context', () => {
      expect(getCurrentAuditActor()).toBeUndefined();
    });

    test('withAuditActor provides actor in context', () => {
      const actor: AuditActorContext = {
        userId: 'user-1',
        email: 'test@example.com',
        ip: '10.0.0.1',
      };
      withAuditActor(actor, () => {
        expect(getCurrentAuditActor()).toEqual(actor);
      });
    });

    test('audit actor context is scoped and cleaned up', () => {
      const actor: AuditActorContext = { userId: 'scoped-user' };
      withAuditActor(actor, () => {
        expect(getCurrentAuditActor()?.userId).toBe('scoped-user');
      });
      expect(getCurrentAuditActor()).toBeUndefined();
    });
  });

  describe('tenant context', () => {
    test('getCurrentTenantContext returns undefined outside context', () => {
      expect(getCurrentTenantContext()).toBeUndefined();
    });

    test('withTenantContext provides tenantId', () => {
      withTenantContext({ tenantId: 'tenant-1' }, () => {
        expect(getCurrentTenantContext()?.tenantId).toBe('tenant-1');
      });
    });

    test('withSuperAdminContext sets isSuperAdmin', () => {
      withSuperAdminContext(() => {
        expect(getCurrentTenantContext()?.isSuperAdmin).toBe(true);
      });
    });

    test('tenant context is scoped and cleaned up', () => {
      withTenantContext({ tenantId: 'scoped' }, () => {
        expect(getCurrentTenantContext()?.tenantId).toBe('scoped');
      });
      expect(getCurrentTenantContext()).toBeUndefined();
    });
  });

  describe('encryption key validation', () => {
    test('setMasterKey rejects invalid key length', () => {
      expect(() => setMasterKey('short-key')).toThrow(
        'ENCRYPTION_MASTER_KEY must be exactly 64 hex characters',
      );
    });

    test('setMasterKey accepts valid 64-char hex key', () => {
      expect(() => setMasterKey('a'.repeat(64))).not.toThrow();
    });
  });

  describe('slow query configuration', () => {
    test('setSlowQueryThreshold does not throw', () => {
      expect(() => setSlowQueryThreshold(500)).not.toThrow();
      setSlowQueryThreshold(200);
    });

    test('setSlowQueryLogHandler accepts custom handler', () => {
      const handler = vi.fn();
      expect(() => setSlowQueryLogHandler(handler)).not.toThrow();
    });
  });

  describe('setAuditHandler', () => {
    afterEach(() => setAuditHandler(null));

    test('accepts a custom handler function', () => {
      expect(() => setAuditHandler(vi.fn())).not.toThrow();
    });

    test('accepts null to clear the registered handler', () => {
      expect(() => setAuditHandler(null)).not.toThrow();
    });
  });
});

// =============================================================================
// MONGODB-DEPENDENT TESTS
// =============================================================================

describe('auditTrailPlugin (MongoDB)', () => {
  let TestModel: mongoose.Model<any>;
  const auditEntries: any[] = [];

  beforeEach(() => {
    if (!isMongoReady()) return;
    auditEntries.length = 0;
    setAuditHandler((entry) => {
      auditEntries.push(entry);
    });

    const name = uniqueModelName('AuditTest');
    const schema = new mongoose.Schema(
      { _id: { type: String, default: uuidv7 }, name: String, email: String, tenantId: String },
      { timestamps: true },
    );
    schema.plugin(auditTrailPlugin);
    TestModel = mongoose.model(name, schema);
  });

  afterEach(() => setAuditHandler(null));

  test('records a create audit entry on save', async () => {
    if (!isMongoReady()) return;
    const doc = await TestModel.create({ name: 'Alice', tenantId: 't1' });
    await new Promise((r) => setTimeout(r, 50));
    const entry = auditEntries.find((e) => e.operation === 'create');
    expect(entry).toBeDefined();
    expect(entry.documentId).toBe(doc._id);
    expect(entry.tenantId).toBe('t1');
  });

  test('records an update audit entry on findOneAndUpdate', async () => {
    if (!isMongoReady()) return;
    const doc = await TestModel.create({ name: 'Bob', tenantId: 't1' });
    await new Promise((r) => setTimeout(r, 50));
    auditEntries.length = 0;
    await TestModel.findOneAndUpdate({ _id: doc._id }, { $set: { name: 'Bobby' } }, { new: true });
    await new Promise((r) => setTimeout(r, 50));
    const entry = auditEntries.find((e) => e.operation === 'update');
    expect(entry).toBeDefined();
    expect(entry.documentId).toBe(doc._id);
  });

  test('records a delete audit entry on findOneAndDelete', async () => {
    if (!isMongoReady()) return;
    const doc = await TestModel.create({ name: 'Charlie', tenantId: 't1' });
    await new Promise((r) => setTimeout(r, 50));
    auditEntries.length = 0;
    await TestModel.findOneAndDelete({ _id: doc._id });
    await new Promise((r) => setTimeout(r, 50));
    const entry = auditEntries.find((e) => e.operation === 'delete');
    expect(entry).toBeDefined();
    expect(entry.documentId).toBe(doc._id);
  });

  test('captures actor context from withAuditActor', async () => {
    if (!isMongoReady()) return;
    const actor: AuditActorContext = {
      userId: 'user-123',
      email: 'alice@example.com',
      ip: '127.0.0.1',
    };
    await withAuditActor(actor, async () => {
      await TestModel.create({ name: 'Alice', tenantId: 't1' });
      await new Promise((r) => setTimeout(r, 50));
    });
    const entry = auditEntries.find((e) => e.operation === 'create');
    expect(entry).toBeDefined();
    expect(entry.actor?.userId).toBe('user-123');
    expect(entry.actor?.email).toBe('alice@example.com');
  });

  test('does not throw when custom handler throws', async () => {
    if (!isMongoReady()) return;
    setAuditHandler(() => {
      throw new Error('audit handler failure');
    });
    await expect(TestModel.create({ name: 'DoNotFail', tenantId: 't1' })).resolves.toBeDefined();
  });

  test('does not throw when no audit handler is registered', async () => {
    if (!isMongoReady()) return;
    setAuditHandler(null);
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockReturnValue(true);

    await expect(TestModel.create({ name: 'WarnOnly', tenantId: 't1' })).resolves.toBeDefined();
    await new Promise((r) => setTimeout(r, 50));

    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringContaining('No audit handler registered for auditTrailPlugin'),
    );

    stderrSpy.mockRestore();
  });
});

describe('tenantIsolationPlugin (MongoDB)', () => {
  let TestModel: mongoose.Model<any>;

  beforeEach(async () => {
    if (!isMongoReady()) return;
    const name = uniqueModelName('TenantTest');
    const schema = new mongoose.Schema({
      _id: { type: String, default: uuidv7 },
      name: String,
      tenantId: { type: String, required: true, index: true },
    });
    schema.plugin(tenantIsolationPlugin);
    TestModel = mongoose.model(name, schema);
    await TestModel.create([
      { name: 'A1', tenantId: 'tenant-1' },
      { name: 'A2', tenantId: 'tenant-1' },
      { name: 'B1', tenantId: 'tenant-2' },
    ]);
  });

  test('auto-filters queries by tenantId', async () => {
    if (!isMongoReady()) return;
    const results = await withTenantContext({ tenantId: 'tenant-1' }, async () =>
      TestModel.find({}).lean(),
    );
    expect(results).toHaveLength(2);
    expect(results.every((r: any) => r.tenantId === 'tenant-1')).toBe(true);
  });

  test('tenants are isolated from each other', async () => {
    if (!isMongoReady()) return;
    const t1 = await withTenantContext({ tenantId: 'tenant-1' }, async () =>
      TestModel.find({}).lean(),
    );
    const t2 = await withTenantContext({ tenantId: 'tenant-2' }, async () =>
      TestModel.find({}).lean(),
    );
    expect(t1).toHaveLength(2);
    expect(t2).toHaveLength(1);
  });

  test('auto-sets tenantId on new documents', async () => {
    if (!isMongoReady()) return;
    const doc = await withTenantContext({ tenantId: 'tenant-3' }, async () =>
      TestModel.create({ name: 'C1' }),
    );
    expect(doc.tenantId).toBe('tenant-3');
  });

  test('super admin bypasses tenant isolation', async () => {
    if (!isMongoReady()) return;
    const results = await withSuperAdminContext(async () => TestModel.find({}).lean());
    expect(results).toHaveLength(3);
  });

  test('findOne is tenant-scoped', async () => {
    if (!isMongoReady()) return;
    const result = await withTenantContext({ tenantId: 'tenant-2' }, async () =>
      TestModel.findOne({ name: 'A1' }).lean(),
    );
    expect(result).toBeNull();
  });

  test('countDocuments is tenant-scoped', async () => {
    if (!isMongoReady()) return;
    const count = await withTenantContext({ tenantId: 'tenant-1' }, async () =>
      TestModel.countDocuments({}),
    );
    expect(count).toBe(2);
  });

  test('updateMany is tenant-scoped', async () => {
    if (!isMongoReady()) return;
    await withTenantContext({ tenantId: 'tenant-1' }, async () =>
      TestModel.updateMany({}, { $set: { name: 'Updated' } }),
    );
    const allDocs = await withSuperAdminContext(async () => TestModel.find({}).lean());
    const updated = allDocs.filter((d: any) => d.name === 'Updated');
    expect(updated).toHaveLength(2);
    expect(updated.every((d: any) => d.tenantId === 'tenant-1')).toBe(true);
  });

  test('deleteMany is tenant-scoped', async () => {
    if (!isMongoReady()) return;
    await withTenantContext({ tenantId: 'tenant-1' }, async () => TestModel.deleteMany({}));
    const remaining = await withSuperAdminContext(async () => TestModel.find({}).lean());
    expect(remaining).toHaveLength(1);
    expect(remaining[0].tenantId).toBe('tenant-2');
  });
});

describe('encryptionPlugin (MongoDB)', () => {
  let TestModel: mongoose.Model<any>;
  const TEST_MASTER_KEY = 'a'.repeat(64);

  beforeEach(async () => {
    if (!isMongoReady()) return;
    await initTestDEKFacade(TEST_MASTER_KEY);
    const name = uniqueModelName('EncryptTest');
    const schema = new mongoose.Schema({
      _id: { type: String, default: uuidv7 },
      tenantId: String,
      apiKey: String,
      secret: String,
      publicField: String,
    });
    schema.plugin(encryptionPlugin, { fieldsToEncrypt: ['apiKey', 'secret'] });
    TestModel = mongoose.model(name, schema);
  });

  test('encrypts fields on save', async () => {
    if (!isMongoReady()) return;
    const doc = await TestModel.create({
      tenantId: 'tenant-1',
      apiKey: 'my-api-key-123',
      secret: 'super-secret',
      publicField: 'visible',
    });
    const raw = await TestModel.collection.findOne({ _id: doc._id });
    expect(raw).toBeDefined();
    expect(raw!.apiKey).not.toBe('my-api-key-123');
    expect(raw!.secret).not.toBe('super-secret');
    expect(raw!.publicField).toBe('visible');
    expect(raw!.ire).toBeUndefined();
  });

  test('decrypts fields on findOne', async () => {
    if (!isMongoReady()) return;
    await TestModel.create({
      tenantId: 'tenant-1',
      apiKey: 'my-api-key-123',
      secret: 'super-secret',
      publicField: 'visible',
    });
    const found = await TestModel.findOne({ publicField: 'visible' });
    expect(found).toBeDefined();
    expect(found!.apiKey).toBe('my-api-key-123');
    expect(found!.secret).toBe('super-secret');
  });

  test('decrypts fields on find (multiple docs)', async () => {
    if (!isMongoReady()) return;
    await TestModel.create([
      { tenantId: 'tenant-1', apiKey: 'key-1', secret: 'sec-1', publicField: 'a' },
      { tenantId: 'tenant-1', apiKey: 'key-2', secret: 'sec-2', publicField: 'b' },
    ]);
    const found = await TestModel.find({}).sort({ publicField: 1 });
    expect(found).toHaveLength(2);
    expect(found[0].apiKey).toBe('key-1');
    expect(found[1].apiKey).toBe('key-2');
  });

  test('handles null/undefined encrypted fields gracefully', async () => {
    if (!isMongoReady()) return;
    const doc = await TestModel.create({ tenantId: 'tenant-1', publicField: 'no-secrets' });
    const found = await TestModel.findOne({ _id: doc._id });
    expect(found).toBeDefined();
    expect(found!.publicField).toBe('no-secrets');
    expect(found!.apiKey).toBeUndefined();
  });

  test('decrypts after findOneAndUpdate', async () => {
    if (!isMongoReady()) return;
    const doc = await TestModel.create({
      tenantId: 'tenant-1',
      apiKey: 'original',
      secret: 'sec',
      publicField: 'test',
    });
    const updated = await TestModel.findOneAndUpdate(
      { _id: doc._id },
      { $set: { publicField: 'updated' } },
      { new: true },
    );
    expect(updated).toBeDefined();
    expect(updated!.publicField).toBe('updated');
  });
});

describe('leanIdPlugin (MongoDB)', () => {
  let TestModel: mongoose.Model<any>;

  beforeEach(() => {
    if (!isMongoReady()) return;
    const name = uniqueModelName('LeanIdTest');
    const schema = new mongoose.Schema({ _id: { type: String, default: uuidv7 }, name: String });
    schema.plugin(leanIdPlugin);
    TestModel = mongoose.model(name, schema);
  });

  test('adds id field to lean find results', async () => {
    if (!isMongoReady()) return;
    await TestModel.create({ name: 'Alice' });
    const results = await TestModel.find({}).lean();
    expect(results).toHaveLength(1);
    expect(results[0].id).toBe(results[0]._id);
  });

  test('adds id field to lean findOne results', async () => {
    if (!isMongoReady()) return;
    await TestModel.create({ name: 'Bob' });
    const result = await TestModel.findOne({ name: 'Bob' }).lean();
    expect(result).toBeDefined();
    expect(result!.id).toBe(result!._id);
  });

  test('non-lean results already have id virtual', async () => {
    if (!isMongoReady()) return;
    const doc = await TestModel.create({ name: 'Charlie' });
    const result = await TestModel.findOne({ _id: doc._id });
    expect(result!.id).toBeDefined();
  });

  test('handles null findOne result gracefully', async () => {
    if (!isMongoReady()) return;
    const result = await TestModel.findOne({ name: 'nope' }).lean();
    expect(result).toBeNull();
  });

  test('handles empty find results', async () => {
    if (!isMongoReady()) return;
    const results = await TestModel.find({ name: 'nope' }).lean();
    expect(results).toHaveLength(0);
  });

  test('works with findOneAndUpdate lean', async () => {
    if (!isMongoReady()) return;
    const doc = await TestModel.create({ name: 'Delta' });
    const updated = await TestModel.findOneAndUpdate(
      { _id: doc._id },
      { $set: { name: 'Updated' } },
      { new: true },
    ).lean();
    expect(updated!.id).toBe(updated!._id);
  });

  test('works with findOneAndDelete lean', async () => {
    if (!isMongoReady()) return;
    const doc = await TestModel.create({ name: 'Echo' });
    const deleted = await TestModel.findOneAndDelete({ _id: doc._id }).lean();
    expect(deleted!.id).toBe(deleted!._id);
  });
});

describe('slowQueryPlugin (MongoDB)', () => {
  let TestModel: mongoose.Model<any>;
  const slowQueryLogs: any[] = [];

  beforeEach(() => {
    if (!isMongoReady()) return;
    slowQueryLogs.length = 0;
    setSlowQueryLogHandler((log) => {
      slowQueryLogs.push(log);
    });
    setSlowQueryThreshold(0);
    const name = uniqueModelName('SlowQueryTest');
    const schema = new mongoose.Schema({ _id: { type: String, default: uuidv7 }, name: String });
    schema.plugin(slowQueryPlugin);
    TestModel = mongoose.model(name, schema);
  });

  afterEach(() => setSlowQueryThreshold(200));

  test('logs slow queries exceeding threshold', async () => {
    if (!isMongoReady()) return;
    await TestModel.create({ name: 'test' });
    await TestModel.find({});
    await new Promise((r) => setTimeout(r, 50));
    const findLog = slowQueryLogs.find((l) => l.operation === 'find');
    expect(findLog).toBeDefined();
    expect(findLog.durationMs).toBeGreaterThanOrEqual(0);
  });

  test('does not log fast queries when threshold is high', async () => {
    if (!isMongoReady()) return;
    setSlowQueryThreshold(60_000);
    slowQueryLogs.length = 0;
    await TestModel.create({ name: 'fast' });
    await TestModel.find({});
    await new Promise((r) => setTimeout(r, 50));
    expect(slowQueryLogs.find((l) => l.operation === 'find')).toBeUndefined();
  });

  test('logs slow save operations', async () => {
    if (!isMongoReady()) return;
    await TestModel.create({ name: 'save-test' });
    await new Promise((r) => setTimeout(r, 50));
    expect(slowQueryLogs.find((l) => l.operation === 'save')).toBeDefined();
  });

  test('logs findOne operations', async () => {
    if (!isMongoReady()) return;
    await TestModel.create({ name: 'fone' });
    slowQueryLogs.length = 0;
    await TestModel.findOne({ name: 'fone' });
    await new Promise((r) => setTimeout(r, 50));
    expect(slowQueryLogs.find((l) => l.operation === 'findOne')).toBeDefined();
  });
});
