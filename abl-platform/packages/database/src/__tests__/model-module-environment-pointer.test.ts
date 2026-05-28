import {
  setupTestMongo,
  teardownTestMongo,
  clearCollections,
  isMongoReady,
} from './helpers/setup-mongo.js';
import { ModuleEnvironmentPointer } from '../models/module-environment-pointer.model.js';

beforeAll(async () => {
  await setupTestMongo();
});

afterAll(async () => {
  await teardownTestMongo();
});

beforeEach(async () => {
  await clearCollections();
});

// ─── Helpers ─────────────────────────────────────────────────────────────────

const validPointer = () => ({
  tenantId: 'tenant-1',
  moduleProjectId: 'mod-proj-1',
  environment: 'production' as const,
  moduleReleaseId: 'release-1',
  updatedBy: 'user-1',
});

// ─── ModuleEnvironmentPointer Model ──────────────────────────────────────────

describe('ModuleEnvironmentPointer', () => {
  // ── Validation tests (no DB needed) ─────────────────────────────────────

  it('requires tenantId', () => {
    const data = validPointer();
    delete (data as any).tenantId;
    const doc = new ModuleEnvironmentPointer(data);
    const err = doc.validateSync();
    expect(err).toBeDefined();
    expect(err!.errors.tenantId).toBeDefined();
  });

  it('requires moduleProjectId', () => {
    const data = validPointer();
    delete (data as any).moduleProjectId;
    const doc = new ModuleEnvironmentPointer(data);
    const err = doc.validateSync();
    expect(err).toBeDefined();
    expect(err!.errors.moduleProjectId).toBeDefined();
  });

  it('requires environment', () => {
    const data = validPointer();
    delete (data as any).environment;
    const doc = new ModuleEnvironmentPointer(data);
    const err = doc.validateSync();
    expect(err).toBeDefined();
    expect(err!.errors.environment).toBeDefined();
  });

  it('requires moduleReleaseId', () => {
    const data = validPointer();
    delete (data as any).moduleReleaseId;
    const doc = new ModuleEnvironmentPointer(data);
    const err = doc.validateSync();
    expect(err).toBeDefined();
    expect(err!.errors.moduleReleaseId).toBeDefined();
  });

  it('requires updatedBy', () => {
    const data = validPointer();
    delete (data as any).updatedBy;
    const doc = new ModuleEnvironmentPointer(data);
    const err = doc.validateSync();
    expect(err).toBeDefined();
    expect(err!.errors.updatedBy).toBeDefined();
  });

  it('accepts valid environment values (dev, staging, production)', () => {
    const envs = ['dev', 'staging', 'production'] as const;
    for (const env of envs) {
      const doc = new ModuleEnvironmentPointer({ ...validPointer(), environment: env });
      const err = doc.validateSync();
      expect(err).toBeUndefined();
      expect(doc.environment).toBe(env);
    }
  });

  it('rejects invalid environment values', () => {
    const doc = new ModuleEnvironmentPointer({
      ...validPointer(),
      environment: 'invalid',
    });
    const err = doc.validateSync();
    expect(err).toBeDefined();
    expect(err!.errors.environment).toBeDefined();
  });

  // ── Default value tests (no DB needed) ──────────────────────────────────

  it('sets default fields on construction', () => {
    const doc = new ModuleEnvironmentPointer(validPointer());
    expect(doc._id).toBeDefined();
    expect(doc._id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(doc.tenantId).toBe('tenant-1');
    expect(doc.moduleProjectId).toBe('mod-proj-1');
    expect(doc.environment).toBe('production');
    expect(doc.moduleReleaseId).toBe('release-1');
    expect(doc.updatedBy).toBe('user-1');
    expect(doc.revision).toBe(1);
  });

  it('defaults revision to 1', () => {
    const doc = new ModuleEnvironmentPointer(validPointer());
    expect(doc.revision).toBe(1);
  });

  // ── DB-dependent tests ──────────────────────────────────────────────────

  it('enforces unique (tenantId, moduleProjectId, environment)', async (ctx) => {
    if (!isMongoReady()) return ctx.skip();
    await ModuleEnvironmentPointer.create(validPointer());
    await expect(ModuleEnvironmentPointer.create(validPointer())).rejects.toThrow(/duplicate key/i);
  });

  it('allows different environments for same moduleProjectId', async (ctx) => {
    if (!isMongoReady()) return ctx.skip();
    await ModuleEnvironmentPointer.create(validPointer());
    const pointer2 = { ...validPointer(), environment: 'staging' as const };
    const created = await ModuleEnvironmentPointer.create(pointer2);
    expect(created.environment).toBe('staging');
  });

  it('revision can be incremented', async (ctx) => {
    if (!isMongoReady()) return ctx.skip();
    const pointer = await ModuleEnvironmentPointer.create(validPointer());
    expect(pointer.revision).toBe(1);

    await ModuleEnvironmentPointer.findOneAndUpdate(
      { _id: pointer._id, tenantId: 'tenant-1' },
      { $set: { moduleReleaseId: 'release-2', revision: 2 } },
    );

    const updated = await ModuleEnvironmentPointer.findOne({
      _id: pointer._id,
      tenantId: 'tenant-1',
    });
    expect(updated!.revision).toBe(2);
  });

  it('optimistic concurrency: findOneAndUpdate with revision returns null on mismatch', async (ctx) => {
    if (!isMongoReady()) return ctx.skip();
    const pointer = await ModuleEnvironmentPointer.create(validPointer());

    // Try to update with wrong revision (2 instead of 1)
    const result = await ModuleEnvironmentPointer.findOneAndUpdate(
      { _id: pointer._id, tenantId: 'tenant-1', revision: 999 },
      { $set: { moduleReleaseId: 'release-3', revision: 1000 } },
      { new: true },
    );

    expect(result).toBeNull();

    // Original unchanged
    const unchanged = await ModuleEnvironmentPointer.findOne({
      _id: pointer._id,
      tenantId: 'tenant-1',
    });
    expect(unchanged!.revision).toBe(1);
    expect(unchanged!.moduleReleaseId).toBe('release-1');
  });

  it('persists with updatedAt timestamp', async (ctx) => {
    if (!isMongoReady()) return ctx.skip();
    const pointer = await ModuleEnvironmentPointer.create(validPointer());
    expect(pointer.updatedAt).toBeInstanceOf(Date);
  });
});
