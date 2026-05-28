/**
 * MongoDB Base Model & Base Document Tests
 *
 * Tests for: BaseModel CRUD, soft delete, pagination, BaseDocument fields,
 * UUID v7 generation, and schema helpers.
 *
 * Pure-logic tests always run. MongoDB-dependent tests gracefully skip.
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import mongoose from 'mongoose';
import type { Model } from 'mongoose';
import {
  setupTestMongo,
  teardownTestMongo,
  clearCollections,
  isMongoReady,
} from './helpers/setup-mongo.js';

import { BaseModel } from '../mongo/base-model.js';
import {
  uuidv7,
  applyBaseSchema,
  applySoftDeleteSchema,
  applyTenantSchema,
  baseSchemaFields,
  softDeleteSchemaFields,
  tenantSchemaFields,
  type BaseDocument,
} from '../mongo/base-document.js';

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

interface TestDoc extends BaseDocument {
  tenantId?: string;
  name: string;
  status: string;
  deletedAt?: Date | null;
}

interface TestInput {
  tenantId?: string;
  name: string;
  status?: string;
}
interface TestUpdate {
  name?: string;
  status?: string;
}

class TestModelService extends BaseModel<TestDoc, TestInput, TestUpdate> {
  constructor(model: Model<TestDoc>, collectionName: string) {
    super(model, collectionName, { slowQueryMs: 60_000 });
  }
}

function createTestModelAndService() {
  const name = uniqueModelName('BaseModelTest');
  const schema = new mongoose.Schema(
    {
      _id: { type: String, default: uuidv7 },
      _v: { type: Number, default: 1 },
      tenantId: { type: String, default: 'tenant-1' },
      name: { type: String, required: true },
      status: { type: String, default: 'active' },
      deletedAt: { type: Date, default: null },
    },
    { timestamps: true },
  );
  const model = mongoose.model<TestDoc>(name, schema);
  return { model, service: new TestModelService(model, name) };
}

// =============================================================================
// BASE DOCUMENT (pure logic)
// =============================================================================

describe('BaseDocument', () => {
  describe('uuidv7', () => {
    test('generates valid UUID v7 format', () => {
      const id = uuidv7();
      expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    });

    test('generates unique IDs', () => {
      const ids = new Set(Array.from({ length: 100 }, () => uuidv7()));
      expect(ids.size).toBe(100);
    });

    test('IDs are time-sortable', async () => {
      const id1 = uuidv7();
      await new Promise((r) => setTimeout(r, 2));
      const id2 = uuidv7();
      expect(id2 >= id1).toBe(true);
    });

    test('has version 7 marker', () => {
      const parts = uuidv7().split('-');
      expect(parts[2][0]).toBe('7');
    });

    test('has correct variant bits', () => {
      const parts = uuidv7().split('-');
      expect(['8', '9', 'a', 'b']).toContain(parts[3][0]);
    });
  });

  describe('schema field helpers', () => {
    test('baseSchemaFields has _id and _v', () => {
      expect(baseSchemaFields).toHaveProperty('_id');
      expect(baseSchemaFields).toHaveProperty('_v');
    });

    test('softDeleteSchemaFields has deletedAt', () => {
      expect(softDeleteSchemaFields).toHaveProperty('deletedAt');
    });

    test('tenantSchemaFields has tenantId', () => {
      expect(tenantSchemaFields).toHaveProperty('tenantId');
    });

    test('applyBaseSchema adds _id and _v', () => {
      const schema = new mongoose.Schema({ name: String });
      applyBaseSchema(schema);
      const paths = Object.keys(schema.paths);
      expect(paths).toContain('_id');
      expect(paths).toContain('_v');
    });

    test('applySoftDeleteSchema adds deletedAt', () => {
      const schema = new mongoose.Schema({ name: String });
      applySoftDeleteSchema(schema);
      expect(Object.keys(schema.paths)).toContain('deletedAt');
    });

    test('applyTenantSchema adds tenantId', () => {
      const schema = new mongoose.Schema({ name: String });
      applyTenantSchema(schema);
      expect(Object.keys(schema.paths)).toContain('tenantId');
    });
  });

  describe('documents created with base schema (MongoDB)', () => {
    test('auto-generates _id as UUID v7', async () => {
      if (!isMongoReady()) return;
      const name = uniqueModelName('BaseDocTest');
      const schema = new mongoose.Schema(
        { _id: { type: String, default: uuidv7 }, _v: { type: Number, default: 1 }, name: String },
        { timestamps: true },
      );
      const TestModel = mongoose.model(name, schema);
      const doc = await TestModel.create({ name: 'test' });
      expect(doc._id).toMatch(/^[0-9a-f]{8}-/);
      expect(doc._v).toBe(1);
      expect(doc.createdAt).toBeDefined();
      expect(doc.updatedAt).toBeDefined();
    });
  });
});

// =============================================================================
// BASE MODEL CRUD (MongoDB)
// =============================================================================

describe('BaseModel', () => {
  describe('create', () => {
    test('creates a document and returns it', async () => {
      if (!isMongoReady()) return;
      const { service } = createTestModelAndService();
      const doc = await service.create({ name: 'Alice', status: 'active' });
      expect(doc).toBeDefined();
      expect(doc._id).toBeDefined();
      expect(doc.name).toBe('Alice');
      expect(doc.status).toBe('active');
    });

    test('auto-generates _id', async () => {
      if (!isMongoReady()) return;
      const { service } = createTestModelAndService();
      const doc = await service.create({ name: 'Bob' });
      expect(doc._id).toMatch(/^[0-9a-f]{8}-/);
    });
  });

  describe('createMany', () => {
    test('creates multiple documents', async () => {
      if (!isMongoReady()) return;
      const { service } = createTestModelAndService();
      const docs = await service.createMany([{ name: 'A' }, { name: 'B' }, { name: 'C' }]);
      expect(docs).toHaveLength(3);
      expect(docs.map((d) => d.name)).toEqual(['A', 'B', 'C']);
    });
  });

  describe('findById', () => {
    test('finds a document by ID', async () => {
      if (!isMongoReady()) return;
      const { service } = createTestModelAndService();
      const created = await service.create({ name: 'FindMe' });
      const found = await service.findById(created._id);
      expect(found).toBeDefined();
      expect(found!.name).toBe('FindMe');
    });

    test('returns null for non-existent ID', async () => {
      if (!isMongoReady()) return;
      const { service } = createTestModelAndService();
      expect(await service.findById(uuidv7())).toBeNull();
    });
  });

  describe('findOneScoped', () => {
    test('finds a document by ID and tenantId', async () => {
      if (!isMongoReady()) return;
      const { service } = createTestModelAndService();
      const created = await service.create({ tenantId: 'tenant-1', name: 'Scoped' });
      const found = await service.findOneScoped({ _id: created._id, tenantId: 'tenant-1' } as any);
      expect(found).toBeDefined();
      expect(found!.name).toBe('Scoped');
      expect(found!.tenantId).toBe('tenant-1');
    });

    test('returns null when tenantId does not match', async () => {
      if (!isMongoReady()) return;
      const { service } = createTestModelAndService();
      const created = await service.create({ tenantId: 'tenant-1', name: 'Scoped' });
      expect(
        await service.findOneScoped({ _id: created._id, tenantId: 'tenant-2' } as any),
      ).toBeNull();
    });
  });

  describe('findOne', () => {
    test('finds a document by filter', async () => {
      if (!isMongoReady()) return;
      const { service } = createTestModelAndService();
      await service.create({ name: 'Unique', status: 'special' });
      const found = await service.findOne({ status: 'special' } as any);
      expect(found).toBeDefined();
      expect(found!.name).toBe('Unique');
    });

    test('returns null when no match', async () => {
      if (!isMongoReady()) return;
      const { service } = createTestModelAndService();
      expect(await service.findOne({ name: 'nonexistent' } as any)).toBeNull();
    });
  });

  describe('find', () => {
    test('finds all matching documents', async () => {
      if (!isMongoReady()) return;
      const { service } = createTestModelAndService();
      await service.createMany([
        { name: 'A', status: 'active' },
        { name: 'B', status: 'active' },
        { name: 'C', status: 'inactive' },
      ]);
      const results = await service.find({ status: 'active' } as any);
      expect(results).toHaveLength(2);
    });

    test('excludes soft-deleted documents by default', async () => {
      if (!isMongoReady()) return;
      const { service, model } = createTestModelAndService();
      const doc = await service.create({ name: 'ToDelete', status: 'active' });
      await model.findByIdAndUpdate(doc._id, { $set: { deletedAt: new Date() } });
      const results = await service.find({} as any);
      expect(results.every((r) => r.name !== 'ToDelete')).toBe(true);
    });

    test('includes soft-deleted when requested', async () => {
      if (!isMongoReady()) return;
      const { service, model } = createTestModelAndService();
      await service.create({ name: 'Regular', status: 'active' });
      const deleted = await service.create({ name: 'Deleted', status: 'active' });
      await model.findByIdAndUpdate(deleted._id, { $set: { deletedAt: new Date() } });
      const results = await service.find({} as any, { includeSoftDeleted: true });
      expect(results).toHaveLength(2);
    });
  });

  describe('updateById', () => {
    test('updates and returns the document', async () => {
      if (!isMongoReady()) return;
      const { service } = createTestModelAndService();
      const doc = await service.create({ name: 'Before' });
      const updated = await service.updateById(doc._id, { name: 'After' });
      expect(updated!.name).toBe('After');
    });

    test('returns null for non-existent ID', async () => {
      if (!isMongoReady()) return;
      const { service } = createTestModelAndService();
      expect(await service.updateById(uuidv7(), { name: 'Nothing' })).toBeNull();
    });
  });

  describe('updateMany', () => {
    test('updates multiple documents and returns count', async () => {
      if (!isMongoReady()) return;
      const { service } = createTestModelAndService();
      await service.createMany([
        { name: 'A', status: 'old' },
        { name: 'B', status: 'old' },
        { name: 'C', status: 'new' },
      ]);
      const count = await service.updateMany({ status: 'old' } as any, { status: 'updated' });
      expect(count).toBe(2);
    });
  });

  describe('deleteById', () => {
    test('deletes a document and returns true', async () => {
      if (!isMongoReady()) return;
      const { service } = createTestModelAndService();
      const doc = await service.create({ name: 'ToDelete' });
      expect(await service.deleteById(doc._id)).toBe(true);
      expect(await service.findById(doc._id)).toBeNull();
    });

    test('returns false for non-existent ID', async () => {
      if (!isMongoReady()) return;
      const { service } = createTestModelAndService();
      expect(await service.deleteById(uuidv7())).toBe(false);
    });
  });

  describe('softDelete', () => {
    test('sets deletedAt timestamp', async () => {
      if (!isMongoReady()) return;
      const { service } = createTestModelAndService();
      const doc = await service.create({ name: 'SoftDel' });
      const result = await service.softDelete(doc._id);
      expect(result!.deletedAt).toBeDefined();
      expect(result!.deletedAt).not.toBeNull();
    });

    test('soft-deleted docs are excluded from find', async () => {
      if (!isMongoReady()) return;
      const { service } = createTestModelAndService();
      const doc = await service.create({ name: 'Hidden' });
      await service.softDelete(doc._id);
      expect(await service.findOne({ name: 'Hidden' } as any)).toBeNull();
    });
  });

  describe('restore', () => {
    test('clears deletedAt', async () => {
      if (!isMongoReady()) return;
      const { service } = createTestModelAndService();
      const doc = await service.create({ name: 'Restore' });
      await service.softDelete(doc._id);
      const restored = await service.restore(doc._id);
      expect(restored!.deletedAt).toBeNull();
    });

    test('restored doc appears in find', async () => {
      if (!isMongoReady()) return;
      const { service } = createTestModelAndService();
      const doc = await service.create({ name: 'BackAgain' });
      await service.softDelete(doc._id);
      await service.restore(doc._id);
      expect(await service.findOne({ name: 'BackAgain' } as any)).toBeDefined();
    });
  });

  describe('paginate', () => {
    test('returns paginated results', async () => {
      if (!isMongoReady()) return;
      const { service } = createTestModelAndService();
      await service.createMany(
        Array.from({ length: 15 }, (_, i) => ({ name: `item-${String(i).padStart(2, '0')}` })),
      );
      const result = await service.paginate({} as any, { page: 1, limit: 10 });
      expect(result.data).toHaveLength(10);
      expect(result.total).toBe(15);
      expect(result.totalPages).toBe(2);
      expect(result.hasNext).toBe(true);
      expect(result.hasPrev).toBe(false);
    });

    test('handles second page', async () => {
      if (!isMongoReady()) return;
      const { service } = createTestModelAndService();
      await service.createMany(Array.from({ length: 15 }, (_, i) => ({ name: `item-${i}` })));
      const result = await service.paginate({} as any, { page: 2, limit: 10 });
      expect(result.data).toHaveLength(5);
      expect(result.hasNext).toBe(false);
      expect(result.hasPrev).toBe(true);
    });

    test('handles empty collection', async () => {
      if (!isMongoReady()) return;
      const { service } = createTestModelAndService();
      const result = await service.paginate({} as any, { page: 1, limit: 10 });
      expect(result.data).toHaveLength(0);
      expect(result.total).toBe(0);
    });
  });

  describe('cursorPaginate', () => {
    test('returns cursor-paginated results', async () => {
      if (!isMongoReady()) return;
      const { service } = createTestModelAndService();
      await service.createMany(Array.from({ length: 5 }, (_, i) => ({ name: `cursor-${i}` })));
      const result = await service.cursorPaginate({} as any, { limit: 3 });
      expect(result.data).toHaveLength(3);
      expect(result.hasMore).toBe(true);
      expect(result.nextCursor).toBeDefined();
    });

    test('second page using cursor', async () => {
      if (!isMongoReady()) return;
      const { service } = createTestModelAndService();
      await service.createMany(Array.from({ length: 5 }, (_, i) => ({ name: `cursor-${i}` })));
      const page1 = await service.cursorPaginate({} as any, { limit: 3 });
      const page2 = await service.cursorPaginate({} as any, {
        limit: 3,
        cursor: page1.nextCursor!,
      });
      expect(page2.data).toHaveLength(2);
      expect(page2.hasMore).toBe(false);
    });
  });

  describe('count', () => {
    test('returns document count', async () => {
      if (!isMongoReady()) return;
      const { service } = createTestModelAndService();
      await service.createMany([{ name: 'A' }, { name: 'B' }, { name: 'C' }]);
      expect(await service.count({} as any)).toBe(3);
    });

    test('excludes soft-deleted by default', async () => {
      if (!isMongoReady()) return;
      const { service } = createTestModelAndService();
      const docs = await service.createMany([{ name: 'A' }, { name: 'B' }]);
      await service.softDelete(docs[0]._id);
      expect(await service.count({} as any)).toBe(1);
    });
  });

  describe('exists', () => {
    test('returns true when document exists', async () => {
      if (!isMongoReady()) return;
      const { service } = createTestModelAndService();
      await service.create({ name: 'Exists' });
      expect(await service.exists({ name: 'Exists' } as any)).toBe(true);
    });

    test('returns false when document does not exist', async () => {
      if (!isMongoReady()) return;
      const { service } = createTestModelAndService();
      expect(await service.exists({ name: 'Nope' } as any)).toBe(false);
    });
  });

  describe('distinct', () => {
    test('returns distinct field values', async () => {
      if (!isMongoReady()) return;
      const { service } = createTestModelAndService();
      await service.createMany([
        { name: 'A', status: 'active' },
        { name: 'B', status: 'active' },
        { name: 'C', status: 'inactive' },
      ]);
      const statuses = await service.distinct<string>('status');
      expect(statuses.sort()).toEqual(['active', 'inactive']);
    });
  });

  describe('upsert', () => {
    test('creates new document if not found', async () => {
      if (!isMongoReady()) return;
      const { service } = createTestModelAndService();
      const doc = await service.upsert({ name: 'NewDoc' } as any, {
        name: 'NewDoc',
        status: 'created',
      });
      expect(doc.name).toBe('NewDoc');
      expect(doc.status).toBe('created');
    });

    test('updates existing document if found', async () => {
      if (!isMongoReady()) return;
      const { service } = createTestModelAndService();
      await service.create({ name: 'Existing', status: 'old' });
      const doc = await service.upsert({ name: 'Existing' } as any, {
        name: 'Existing',
        status: 'updated',
      });
      expect(doc.status).toBe('updated');
    });
  });

  describe('aggregate', () => {
    test('runs an aggregation pipeline', async () => {
      if (!isMongoReady()) return;
      const { service } = createTestModelAndService();
      await service.createMany([
        { name: 'A', status: 'active' },
        { name: 'B', status: 'active' },
        { name: 'C', status: 'inactive' },
      ]);
      const result = await service.aggregate<{ _id: string; count: number }>([
        { $group: { _id: '$status', count: { $sum: 1 } } },
        { $sort: { _id: 1 } },
      ]);
      expect(result).toHaveLength(2);
      expect(result.find((r) => r._id === 'active')?.count).toBe(2);
    });
  });

  describe('error handling', () => {
    test('wraps validation errors', async () => {
      if (!isMongoReady()) return;
      const { service } = createTestModelAndService();
      await expect(service.create({ status: 'no-name' } as any)).rejects.toThrow();
    });
  });
});

// =============================================================================
// CONNECTION
// =============================================================================

describe('MongoConnectionManager', () => {
  test('mongoose connection is active during tests', () => {
    if (!isMongoReady()) return;
    expect(mongoose.connection.readyState).toBe(1);
  });
});
