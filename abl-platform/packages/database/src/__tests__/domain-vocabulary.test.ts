import {
  setupTestMongo,
  teardownTestMongo,
  clearCollections,
  isMongoReady,
} from './helpers/setup-mongo.js';
import { DomainVocabulary } from '../models/domain-vocabulary.model.js';

beforeAll(async () => {
  await setupTestMongo();
});

afterAll(async () => {
  await teardownTestMongo();
});

beforeEach(async () => {
  await clearCollections();
});

// ─── DomainVocabulary Model ─────────────────────────────────────────────────

describe('DomainVocabulary', () => {
  const validVocabulary = () => ({
    tenantId: 'tenant-1',
    projectKnowledgeBaseId: 'kb-1',
    version: 1,
    status: 'draft',
    entries: [],
  });

  const validEntry = () => ({
    term: 'priority',
    aliases: ['issue priority', 'ticket priority', 'pri'],
    description: 'Priority level of issues',
    fieldRef: 'issue_priority',
    capabilities: {
      canFilter: true,
      canDisplay: true,
      canAggregate: true,
      canSort: true,
    },
    relatedFields: {
      displayWith: ['summary', 'assignee', 'status'],
      aggregateWith: ['status', 'assignee'],
    },
    enabled: true,
    generatedBy: 'auto',
  });

  it('sets default fields on instantiation', () => {
    const vocab = new DomainVocabulary(validVocabulary());
    expect(vocab._id).toBeDefined();
    expect(vocab.tenantId).toBe('tenant-1');
    expect(vocab.projectKnowledgeBaseId).toBe('kb-1');
    expect(vocab.version).toBe(1);
    expect(vocab.status).toBe('draft');
    expect(vocab.entries).toEqual([]);
    expect(vocab._v).toBe(1);
  });

  it('sets timestamps on save', async (ctx) => {
    if (!isMongoReady()) return ctx.skip();
    const vocab = await DomainVocabulary.create(validVocabulary());
    expect(vocab.createdAt).toBeInstanceOf(Date);
    expect(vocab.updatedAt).toBeInstanceOf(Date);
  });

  it('requires tenantId', () => {
    const data = { ...validVocabulary() };
    delete data.tenantId;
    const doc = new DomainVocabulary(data);
    const err = doc.validateSync();
    expect(err).toBeDefined();
    expect(err!.errors.tenantId).toBeDefined();
  });

  it('requires projectKnowledgeBaseId', () => {
    const data = { ...validVocabulary() };
    delete data.projectKnowledgeBaseId;
    const doc = new DomainVocabulary(data);
    const err = doc.validateSync();
    expect(err).toBeDefined();
    expect(err!.errors.projectKnowledgeBaseId).toBeDefined();
  });

  it('validates status enum values', () => {
    const data = { ...validVocabulary(), status: 'invalid' };
    const doc = new DomainVocabulary(data);
    const err = doc.validateSync();
    expect(err).toBeDefined();
    expect(err!.errors.status).toBeDefined();
  });

  it('accepts valid status values', () => {
    const statuses = ['draft', 'active', 'inactive'];
    statuses.forEach((status) => {
      const doc = new DomainVocabulary({ ...validVocabulary(), status });
      const err = doc.validateSync();
      expect(err).toBeUndefined();
      expect(doc.status).toBe(status);
    });
  });

  it('defaults status to draft', () => {
    const data = { ...validVocabulary() };
    delete data.status;
    const doc = new DomainVocabulary(data);
    expect(doc.status).toBe('draft');
  });

  it('defaults version to 1', () => {
    const data = { ...validVocabulary() };
    delete data.version;
    const doc = new DomainVocabulary(data);
    expect(doc.version).toBe(1);
  });

  it('defaults entries to empty array', () => {
    const data = { ...validVocabulary() };
    delete data.entries;
    const doc = new DomainVocabulary(data);
    expect(doc.entries).toEqual([]);
  });

  describe('VocabularyEntry subdocument', () => {
    it('requires term', () => {
      const entry = { ...validEntry() };
      delete entry.term;
      const doc = new DomainVocabulary({
        ...validVocabulary(),
        entries: [entry],
      });
      const err = doc.validateSync();
      expect(err).toBeDefined();
      expect(err!.errors['entries.0.term']).toBeDefined();
    });

    it('requires fieldRef', () => {
      const entry = { ...validEntry() };
      delete entry.fieldRef;
      const doc = new DomainVocabulary({
        ...validVocabulary(),
        entries: [entry],
      });
      const err = doc.validateSync();
      expect(err).toBeDefined();
      expect(err!.errors['entries.0.fieldRef']).toBeDefined();
    });

    it('requires capabilities object', () => {
      const entry = { ...validEntry() };
      delete entry.capabilities;
      const doc = new DomainVocabulary({
        ...validVocabulary(),
        entries: [entry],
      });
      const err = doc.validateSync();
      expect(err).toBeDefined();
    });

    it('requires all capability fields', () => {
      const capabilityFields = ['canFilter', 'canDisplay', 'canAggregate', 'canSort'];
      capabilityFields.forEach((field) => {
        const entry = { ...validEntry() };
        delete entry.capabilities[field];
        const doc = new DomainVocabulary({
          ...validVocabulary(),
          entries: [entry],
        });
        const err = doc.validateSync();
        expect(err).toBeDefined();
      });
    });

    it('requires generatedBy', () => {
      const entry = { ...validEntry() };
      delete entry.generatedBy;
      const doc = new DomainVocabulary({
        ...validVocabulary(),
        entries: [entry],
      });
      const err = doc.validateSync();
      expect(err).toBeDefined();
      expect(err!.errors['entries.0.generatedBy']).toBeDefined();
    });

    it('validates generatedBy enum values', () => {
      const entry = { ...validEntry(), generatedBy: 'invalid' };
      const doc = new DomainVocabulary({
        ...validVocabulary(),
        entries: [entry],
      });
      const err = doc.validateSync();
      expect(err).toBeDefined();
      expect(err!.errors['entries.0.generatedBy']).toBeDefined();
    });

    it('defaults aliases to empty array', () => {
      const entry = { ...validEntry() };
      delete entry.aliases;
      const doc = new DomainVocabulary({
        ...validVocabulary(),
        entries: [entry],
      });
      expect(doc.entries[0].aliases).toEqual([]);
    });

    it('defaults relatedFields.displayWith to empty array', () => {
      const entry = { ...validEntry() };
      delete entry.relatedFields.displayWith;
      const doc = new DomainVocabulary({
        ...validVocabulary(),
        entries: [entry],
      });
      expect(doc.entries[0].relatedFields.displayWith).toEqual([]);
    });

    it('defaults relatedFields.aggregateWith to empty array', () => {
      const entry = { ...validEntry() };
      delete entry.relatedFields.aggregateWith;
      const doc = new DomainVocabulary({
        ...validVocabulary(),
        entries: [entry],
      });
      expect(doc.entries[0].relatedFields.aggregateWith).toEqual([]);
    });

    it('defaults enabled to true', () => {
      const entry = { ...validEntry() };
      delete entry.enabled;
      const doc = new DomainVocabulary({
        ...validVocabulary(),
        entries: [entry],
      });
      expect(doc.entries[0].enabled).toBe(true);
    });

    it('accepts optional confidence field', () => {
      const entry = { ...validEntry(), confidence: 0.92 };
      const doc = new DomainVocabulary({
        ...validVocabulary(),
        entries: [entry],
      });
      const err = doc.validateSync();
      expect(err).toBeUndefined();
      expect(doc.entries[0].confidence).toBe(0.92);
    });

    it('accepts optional description field', () => {
      const entry = { ...validEntry(), description: 'Test description' };
      const doc = new DomainVocabulary({
        ...validVocabulary(),
        entries: [entry],
      });
      const err = doc.validateSync();
      expect(err).toBeUndefined();
      expect(doc.entries[0].description).toBe('Test description');
    });

    it('stores multiple entries correctly', () => {
      const entry1 = { ...validEntry(), term: 'priority' };
      const entry2 = { ...validEntry(), term: 'status' };
      const doc = new DomainVocabulary({
        ...validVocabulary(),
        entries: [entry1, entry2],
      });
      const err = doc.validateSync();
      expect(err).toBeUndefined();
      expect(doc.entries).toHaveLength(2);
      expect(doc.entries[0].term).toBe('priority');
      expect(doc.entries[1].term).toBe('status');
    });

    it('stores capabilities correctly', () => {
      const entry = {
        ...validEntry(),
        capabilities: {
          canFilter: true,
          canDisplay: false,
          canAggregate: true,
          canSort: false,
        },
      };
      const doc = new DomainVocabulary({
        ...validVocabulary(),
        entries: [entry],
      });
      const err = doc.validateSync();
      expect(err).toBeUndefined();
      expect(doc.entries[0].capabilities.canFilter).toBe(true);
      expect(doc.entries[0].capabilities.canDisplay).toBe(false);
      expect(doc.entries[0].capabilities.canAggregate).toBe(true);
      expect(doc.entries[0].capabilities.canSort).toBe(false);
    });

    it('stores relatedFields correctly', () => {
      const entry = {
        ...validEntry(),
        relatedFields: {
          displayWith: ['field1', 'field2', 'field3'],
          aggregateWith: ['field4', 'field5'],
        },
      };
      const doc = new DomainVocabulary({
        ...validVocabulary(),
        entries: [entry],
      });
      const err = doc.validateSync();
      expect(err).toBeUndefined();
      expect(doc.entries[0].relatedFields.displayWith).toEqual(['field1', 'field2', 'field3']);
      expect(doc.entries[0].relatedFields.aggregateWith).toEqual(['field4', 'field5']);
    });
  });

  describe('tenantIsolationPlugin', () => {
    it('allows queries with explicit tenantId', async (ctx) => {
      if (!isMongoReady()) return ctx.skip();
      const vocab = await DomainVocabulary.create(validVocabulary());

      // Query with tenantId should succeed
      const found = await DomainVocabulary.findOne({ _id: vocab._id, tenantId: 'tenant-1' });
      expect(found).toBeDefined();
      expect(found!._id).toBe(vocab._id);
    });

    it('allows find queries with explicit tenantId', async (ctx) => {
      if (!isMongoReady()) return ctx.skip();
      await DomainVocabulary.create(validVocabulary());

      // Query with tenantId should succeed
      const found = await DomainVocabulary.find({
        tenantId: 'tenant-1',
        projectKnowledgeBaseId: 'kb-1',
      });
      expect(found).toHaveLength(1);
    });

    it('isolates vocabularies by tenant', async (ctx) => {
      if (!isMongoReady()) return ctx.skip();

      // Create vocabulary for tenant-1
      await DomainVocabulary.create({ ...validVocabulary(), tenantId: 'tenant-1' });

      // Create vocabulary for tenant-2
      await DomainVocabulary.create({
        ...validVocabulary(),
        tenantId: 'tenant-2',
        projectKnowledgeBaseId: 'kb-2',
      });

      // Query for tenant-1 should only return tenant-1 docs
      const tenant1Docs = await DomainVocabulary.find({ tenantId: 'tenant-1' });
      expect(tenant1Docs).toHaveLength(1);
      expect(tenant1Docs[0].tenantId).toBe('tenant-1');

      // Query for tenant-2 should only return tenant-2 docs
      const tenant2Docs = await DomainVocabulary.find({ tenantId: 'tenant-2' });
      expect(tenant2Docs).toHaveLength(1);
      expect(tenant2Docs[0].tenantId).toBe('tenant-2');
    });
  });

  describe('indexes', () => {
    it('enforces unique index on projectKnowledgeBaseId + version', async (ctx) => {
      if (!isMongoReady()) return ctx.skip();

      // Create first vocabulary
      await DomainVocabulary.create({ ...validVocabulary(), version: 1 });

      // Attempt to create duplicate should fail
      await expect(DomainVocabulary.create({ ...validVocabulary(), version: 1 })).rejects.toThrow();

      // Creating with different version should succeed
      const vocab2 = await DomainVocabulary.create({ ...validVocabulary(), version: 2 });
      expect(vocab2.version).toBe(2);
    });

    it('allows multiple vocabularies for different projectKnowledgeBases', async (ctx) => {
      if (!isMongoReady()) return ctx.skip();

      // Create vocabulary for kb-1
      const vocab1 = await DomainVocabulary.create({
        ...validVocabulary(),
        projectKnowledgeBaseId: 'kb-1',
      });

      // Create vocabulary for kb-2 (should succeed)
      const vocab2 = await DomainVocabulary.create({
        ...validVocabulary(),
        projectKnowledgeBaseId: 'kb-2',
      });

      expect(vocab1.projectKnowledgeBaseId).toBe('kb-1');
      expect(vocab2.projectKnowledgeBaseId).toBe('kb-2');
    });
  });
});
