import {
  setupTestMongo,
  teardownTestMongo,
  clearCollections,
  isMongoReady,
} from './helpers/setup-mongo.js';
import { CapabilityRegistry } from '../models/capability-registry.model.js';

beforeAll(async () => {
  await setupTestMongo();
});

afterAll(async () => {
  await teardownTestMongo();
});

beforeEach(async () => {
  await clearCollections();
});

// ─── CapabilityRegistry Model ───────────────────────────────────────────────

describe('CapabilityRegistry', () => {
  const validCapability = () => ({
    tenantId: 'global',
    name: 'count',
    type: 'aggregation',
    description: 'Count the number of records',
    supportedFieldTypes: ['number', 'text'],
    triggerKeywords: ['count', 'total', 'number of'],
    examples: ['count bugs by status', 'total tickets'],
    enabled: true,
    metadata: {
      version: 1,
      createdBy: 'system',
    },
  });

  it('sets default fields on instantiation', () => {
    const capability = new CapabilityRegistry(validCapability());
    expect(capability._id).toBeDefined();
    expect(capability.tenantId).toBe('global');
    expect(capability.name).toBe('count');
    expect(capability.type).toBe('aggregation');
    expect(capability.enabled).toBe(true);
    expect(capability.metadata.version).toBe(1);
    expect(capability.metadata.createdBy).toBe('system');
  });

  it('sets timestamps on save', async (ctx) => {
    if (!isMongoReady()) return ctx.skip();
    const capability = await CapabilityRegistry.create(validCapability());
    expect(capability.createdAt).toBeInstanceOf(Date);
    expect(capability.updatedAt).toBeInstanceOf(Date);
  });

  it('defaults tenantId to global when not provided', () => {
    const data = { ...validCapability() };
    delete data.tenantId;
    const doc = new CapabilityRegistry(data);
    // tenantId has a default value of 'global'
    expect(doc.tenantId).toBe('global');
  });

  it('accepts custom tenantId', () => {
    const data = { ...validCapability(), tenantId: 'tenant-1' };
    const doc = new CapabilityRegistry(data);
    const err = doc.validateSync();
    expect(err).toBeUndefined();
    expect(doc.tenantId).toBe('tenant-1');
  });

  it('requires name', () => {
    const data = { ...validCapability() };
    delete data.name;
    const doc = new CapabilityRegistry(data);
    const err = doc.validateSync();
    expect(err).toBeDefined();
    expect(err!.errors.name).toBeDefined();
  });

  it('validates name max length (50)', () => {
    const data = { ...validCapability(), name: 'a'.repeat(51) };
    const doc = new CapabilityRegistry(data);
    const err = doc.validateSync();
    expect(err).toBeDefined();
    expect(err!.errors.name).toBeDefined();
  });

  it('requires type', () => {
    const data = { ...validCapability() };
    delete data.type;
    const doc = new CapabilityRegistry(data);
    const err = doc.validateSync();
    expect(err).toBeDefined();
    expect(err!.errors.type).toBeDefined();
  });

  it('validates type enum values', () => {
    const data = { ...validCapability(), type: 'invalid' };
    const doc = new CapabilityRegistry(data);
    const err = doc.validateSync();
    expect(err).toBeDefined();
    expect(err!.errors.type).toBeDefined();
  });

  it('accepts valid type values', () => {
    const types = ['aggregation', 'operator', 'sort'];
    types.forEach((type) => {
      const doc = new CapabilityRegistry({ ...validCapability(), type });
      const err = doc.validateSync();
      expect(err).toBeUndefined();
      expect(doc.type).toBe(type);
    });
  });

  it('requires description', () => {
    const data = { ...validCapability() };
    delete data.description;
    const doc = new CapabilityRegistry(data);
    const err = doc.validateSync();
    expect(err).toBeDefined();
    expect(err!.errors.description).toBeDefined();
  });

  it('validates description max length (500)', () => {
    const data = { ...validCapability(), description: 'a'.repeat(501) };
    const doc = new CapabilityRegistry(data);
    const err = doc.validateSync();
    expect(err).toBeDefined();
    expect(err!.errors.description).toBeDefined();
  });

  it('requires supportedFieldTypes', () => {
    const data = { ...validCapability() };
    delete data.supportedFieldTypes;
    const doc = new CapabilityRegistry(data);
    const err = doc.validateSync();
    expect(err).toBeDefined();
    expect(err!.errors.supportedFieldTypes).toBeDefined();
  });

  it('validates supportedFieldTypes is not empty', () => {
    const data = { ...validCapability(), supportedFieldTypes: [] };
    const doc = new CapabilityRegistry(data);
    const err = doc.validateSync();
    expect(err).toBeDefined();
    expect(err!.errors.supportedFieldTypes).toBeDefined();
  });

  it('accepts multiple supported field types', () => {
    const data = { ...validCapability(), supportedFieldTypes: ['number', 'text', 'date'] };
    const doc = new CapabilityRegistry(data);
    const err = doc.validateSync();
    expect(err).toBeUndefined();
    expect(doc.supportedFieldTypes).toHaveLength(3);
  });

  it('requires triggerKeywords', () => {
    const data = { ...validCapability() };
    delete data.triggerKeywords;
    const doc = new CapabilityRegistry(data);
    const err = doc.validateSync();
    expect(err).toBeDefined();
    expect(err!.errors.triggerKeywords).toBeDefined();
  });

  it('validates triggerKeywords is not empty', () => {
    const data = { ...validCapability(), triggerKeywords: [] };
    const doc = new CapabilityRegistry(data);
    const err = doc.validateSync();
    expect(err).toBeDefined();
    expect(err!.errors.triggerKeywords).toBeDefined();
  });

  it('accepts multiple trigger keywords', () => {
    const data = {
      ...validCapability(),
      triggerKeywords: ['count', 'total', 'number of', 'how many'],
    };
    const doc = new CapabilityRegistry(data);
    const err = doc.validateSync();
    expect(err).toBeUndefined();
    expect(doc.triggerKeywords).toHaveLength(4);
  });

  it('requires examples', () => {
    const data = { ...validCapability() };
    delete data.examples;
    const doc = new CapabilityRegistry(data);
    const err = doc.validateSync();
    expect(err).toBeDefined();
    expect(err!.errors.examples).toBeDefined();
  });

  it('validates examples is not empty', () => {
    const data = { ...validCapability(), examples: [] };
    const doc = new CapabilityRegistry(data);
    const err = doc.validateSync();
    expect(err).toBeDefined();
    expect(err!.errors.examples).toBeDefined();
  });

  it('accepts multiple examples', () => {
    const data = {
      ...validCapability(),
      examples: ['count bugs by status', 'total tickets', 'number of issues'],
    };
    const doc = new CapabilityRegistry(data);
    const err = doc.validateSync();
    expect(err).toBeUndefined();
    expect(doc.examples).toHaveLength(3);
  });

  it('defaults enabled to true', () => {
    const data = { ...validCapability() };
    delete data.enabled;
    const doc = new CapabilityRegistry(data);
    expect(doc.enabled).toBe(true);
  });

  it('accepts enabled as false', () => {
    const data = { ...validCapability(), enabled: false };
    const doc = new CapabilityRegistry(data);
    expect(doc.enabled).toBe(false);
  });

  it('defaults metadata.version to 1', () => {
    const data = { ...validCapability() };
    delete data.metadata.version;
    const doc = new CapabilityRegistry({ ...data, metadata: { createdBy: 'system' } });
    expect(doc.metadata.version).toBe(1);
  });

  it('defaults metadata.createdBy to system', () => {
    const data = { ...validCapability() };
    delete data.metadata.createdBy;
    const doc = new CapabilityRegistry({ ...data, metadata: { version: 1 } });
    expect(doc.metadata.createdBy).toBe('system');
  });

  it('validates metadata.createdBy enum values', () => {
    const data = {
      ...validCapability(),
      metadata: { version: 1, createdBy: 'invalid' },
    };
    const doc = new CapabilityRegistry(data);
    const err = doc.validateSync();
    expect(err).toBeDefined();
    expect(err!.errors['metadata.createdBy']).toBeDefined();
  });

  it('accepts valid metadata.createdBy values', () => {
    const creators = ['system', 'admin'];
    creators.forEach((createdBy) => {
      const data = {
        ...validCapability(),
        metadata: { version: 1, createdBy },
      };
      const doc = new CapabilityRegistry(data);
      const err = doc.validateSync();
      expect(err).toBeUndefined();
      expect(doc.metadata.createdBy).toBe(createdBy);
    });
  });

  describe('tenantIsolationPlugin', () => {
    it('allows queries with explicit tenantId', async (ctx) => {
      if (!isMongoReady()) return ctx.skip();
      const capability = await CapabilityRegistry.create(validCapability());

      // Query with tenantId should succeed
      const found = await CapabilityRegistry.findOne({ _id: capability._id, tenantId: 'global' });
      expect(found).toBeDefined();
      expect(found!._id).toBe(capability._id);
    });

    it('allows find queries with explicit tenantId', async (ctx) => {
      if (!isMongoReady()) return ctx.skip();
      await CapabilityRegistry.create(validCapability());

      // Query with tenantId should succeed
      const found = await CapabilityRegistry.find({ tenantId: 'global', name: 'count' });
      expect(found).toHaveLength(1);
    });

    it('isolates capabilities by tenant', async (ctx) => {
      if (!isMongoReady()) return ctx.skip();

      // Create capability for global tenant
      await CapabilityRegistry.create({ ...validCapability(), tenantId: 'global' });

      // Create capability for tenant-1
      await CapabilityRegistry.create({ ...validCapability(), tenantId: 'tenant-1', name: 'sum' });

      // Query for global should only return global docs
      const globalDocs = await CapabilityRegistry.find({ tenantId: 'global' });
      expect(globalDocs).toHaveLength(1);
      expect(globalDocs[0].tenantId).toBe('global');

      // Query for tenant-1 should only return tenant-1 docs
      const tenant1Docs = await CapabilityRegistry.find({ tenantId: 'tenant-1' });
      expect(tenant1Docs).toHaveLength(1);
      expect(tenant1Docs[0].tenantId).toBe('tenant-1');
    });
  });

  describe('indexes', () => {
    it('enforces unique index on tenantId + name', async (ctx) => {
      if (!isMongoReady()) return ctx.skip();

      // Create first capability
      await CapabilityRegistry.create({ ...validCapability(), name: 'count' });

      // Attempt to create duplicate should fail
      await expect(
        CapabilityRegistry.create({ ...validCapability(), name: 'count' }),
      ).rejects.toThrow();
    });

    it('allows same name for different tenants', async (ctx) => {
      if (!isMongoReady()) return ctx.skip();

      // Create capability for global tenant
      const cap1 = await CapabilityRegistry.create({ ...validCapability(), tenantId: 'global' });

      // Create capability with same name for tenant-1 (should succeed)
      const cap2 = await CapabilityRegistry.create({ ...validCapability(), tenantId: 'tenant-1' });

      expect(cap1.name).toBe(cap2.name);
      expect(cap1.tenantId).toBe('global');
      expect(cap2.tenantId).toBe('tenant-1');
    });

    it('allows querying capabilities by type', async (ctx) => {
      if (!isMongoReady()) return ctx.skip();

      // Create capabilities of different types
      await CapabilityRegistry.create({ ...validCapability(), type: 'aggregation', name: 'count' });
      await CapabilityRegistry.create({ ...validCapability(), type: 'operator', name: 'equals' });
      await CapabilityRegistry.create({ ...validCapability(), type: 'sort', name: 'ascending' });

      // Query by type
      const aggregations = await CapabilityRegistry.find({
        tenantId: 'global',
        type: 'aggregation',
      });
      expect(aggregations).toHaveLength(1);
      expect(aggregations[0].name).toBe('count');
    });

    it('allows querying enabled capabilities', async (ctx) => {
      if (!isMongoReady()) return ctx.skip();

      // Create enabled and disabled capabilities
      await CapabilityRegistry.create({ ...validCapability(), enabled: true, name: 'count' });
      await CapabilityRegistry.create({ ...validCapability(), enabled: false, name: 'sum' });

      // Query enabled capabilities
      const enabled = await CapabilityRegistry.find({ tenantId: 'global', enabled: true });
      expect(enabled).toHaveLength(1);
      expect(enabled[0].name).toBe('count');
    });
  });
});
