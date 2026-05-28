import {
  setupTestMongo,
  teardownTestMongo,
  clearCollections,
  isMongoReady,
} from './helpers/setup-mongo.js';
import { HandlerTemplate, type IHandlerTemplate } from '../models/handler-template.model.js';

beforeAll(async () => {
  await setupTestMongo();
});

afterAll(async () => {
  await teardownTestMongo();
});

beforeEach(async () => {
  await clearCollections();
});

const validTemplate = (): Partial<IHandlerTemplate> => ({
  tenantId: 'tenant-1',
  domain: 'example.com',
  urlPattern: '/articles/*',
  fingerprint: 'abc123def456',
  handler: {
    urlPattern: '/articles/*',
    description: 'Extract article content',
    steps: [
      {
        action: 'navigate',
        description: 'Go to the page',
      },
      {
        action: 'extract',
        selector: '.article-body',
        description: 'Extract article body',
      },
    ],
    extractionSelectors: {
      title: 'h1.title',
      content: '.article-body',
      metadata: { author: '.author-name' },
    },
  },
  trainedOn: ['https://example.com/articles/1', 'https://example.com/articles/2'],
  lastUsedAt: new Date(),
});

describe('HandlerTemplate', () => {
  it('sets default fields on instantiation', () => {
    const doc = new HandlerTemplate(validTemplate());
    expect(doc._id).toBeDefined();
    expect(doc.tenantId).toBe('tenant-1');
    expect(doc.domain).toBe('example.com');
    expect(doc.urlPattern).toBe('/articles/*');
    expect(doc.fingerprint).toBe('abc123def456');
    expect(doc.successCount).toBe(0);
    expect(doc.failureCount).toBe(0);
    expect(doc.confidence).toBe(0);
    expect(doc.trainedOn).toHaveLength(2);
  });

  it('has all required fields in schema', () => {
    const paths = HandlerTemplate.schema.paths;
    expect(paths._id).toBeDefined();
    expect(paths.tenantId).toBeDefined();
    expect(paths.domain).toBeDefined();
    expect(paths.urlPattern).toBeDefined();
    expect(paths.fingerprint).toBeDefined();
    expect(paths.handler).toBeDefined();
    expect(paths.trainedOn).toBeDefined();
    expect(paths.successCount).toBeDefined();
    expect(paths.failureCount).toBeDefined();
    expect(paths.confidence).toBeDefined();
    expect(paths.lastUsedAt).toBeDefined();
    expect(paths.createdAt).toBeDefined();
    expect(paths.updatedAt).toBeDefined();
  });

  it('requires tenantId', () => {
    const data = validTemplate();
    delete (data as any).tenantId;
    const err = new HandlerTemplate(data).validateSync();
    expect(err).toBeDefined();
    expect(err!.errors.tenantId).toBeDefined();
  });

  it('requires domain', () => {
    const data = validTemplate();
    delete (data as any).domain;
    const err = new HandlerTemplate(data).validateSync();
    expect(err).toBeDefined();
    expect(err!.errors.domain).toBeDefined();
  });

  it('requires urlPattern', () => {
    const data = validTemplate();
    delete (data as any).urlPattern;
    const err = new HandlerTemplate(data).validateSync();
    expect(err).toBeDefined();
    expect(err!.errors.urlPattern).toBeDefined();
  });

  it('requires fingerprint', () => {
    const data = validTemplate();
    delete (data as any).fingerprint;
    const err = new HandlerTemplate(data).validateSync();
    expect(err).toBeDefined();
    expect(err!.errors.fingerprint).toBeDefined();
  });

  it('requires handler', () => {
    const data = validTemplate();
    delete (data as any).handler;
    const err = new HandlerTemplate(data).validateSync();
    expect(err).toBeDefined();
    expect(err!.errors.handler).toBeDefined();
  });

  it('requires lastUsedAt', () => {
    const data = validTemplate();
    delete (data as any).lastUsedAt;
    const err = new HandlerTemplate(data).validateSync();
    expect(err).toBeDefined();
    expect(err!.errors.lastUsedAt).toBeDefined();
  });

  it('defaults successCount to 0', () => {
    const doc = new HandlerTemplate(validTemplate());
    expect(doc.successCount).toBe(0);
  });

  it('defaults failureCount to 0', () => {
    const doc = new HandlerTemplate(validTemplate());
    expect(doc.failureCount).toBe(0);
  });

  it('defaults confidence to 0', () => {
    const doc = new HandlerTemplate(validTemplate());
    expect(doc.confidence).toBe(0);
  });

  it('defaults trainedOn to empty array', () => {
    const data = validTemplate();
    delete (data as any).trainedOn;
    const doc = new HandlerTemplate(data);
    expect(doc.trainedOn).toEqual([]);
  });

  it('enforces confidence min 0 max 1', () => {
    const data = validTemplate();
    data.confidence = 1.5;
    const err = new HandlerTemplate(data).validateSync();
    expect(err).toBeDefined();
    expect(err!.errors.confidence).toBeDefined();

    data.confidence = -0.1;
    const err2 = new HandlerTemplate(data).validateSync();
    expect(err2).toBeDefined();
    expect(err2!.errors.confidence).toBeDefined();
  });

  it('uses collection name handler_templates', () => {
    expect(HandlerTemplate.collection.collectionName).toBe('handler_templates');
  });

  describe('indexes', () => {
    it('has unique compound index on tenantId+domain+fingerprint', () => {
      const indexes = HandlerTemplate.schema.indexes();
      const uniqueIndex = indexes.find(
        ([fields, opts]) =>
          (opts as any)?.unique === true &&
          (fields as any).tenantId === 1 &&
          (fields as any).domain === 1 &&
          (fields as any).fingerprint === 1,
      );
      expect(uniqueIndex).toBeDefined();
    });

    it('has domain query index on tenantId+domain', () => {
      const indexes = HandlerTemplate.schema.indexes();
      const domainIndex = indexes.find(
        ([fields, opts]) =>
          !(opts as any)?.unique &&
          (fields as any).tenantId === 1 &&
          (fields as any).domain === 1 &&
          (fields as any).fingerprint === undefined,
      );
      expect(domainIndex).toBeDefined();
    });

    it('has TTL index on lastUsedAt with 90 days expiry', () => {
      const indexes = HandlerTemplate.schema.indexes();
      const ttlIndex = indexes.find(
        ([fields, opts]) =>
          (fields as any).lastUsedAt === 1 &&
          (opts as any)?.expireAfterSeconds === 90 * 24 * 60 * 60,
      );
      expect(ttlIndex).toBeDefined();
    });
  });

  describe('persistence', () => {
    it('saves and retrieves a document', async () => {
      if (!isMongoReady()) return;

      const doc = new HandlerTemplate(validTemplate());
      await doc.save();

      const found = await HandlerTemplate.findOne({
        _id: doc._id,
        tenantId: 'tenant-1',
      }).lean();
      expect(found).toBeDefined();
      expect(found!.domain).toBe('example.com');
      expect(found!.fingerprint).toBe('abc123def456');
      expect(found!.handler.steps).toHaveLength(2);
      expect(found!.handler.extractionSelectors.content).toBe('.article-body');
      expect(found!.successCount).toBe(0);
      expect(found!.failureCount).toBe(0);
      expect(found!.confidence).toBe(0);
    });

    it('enforces unique compound index on tenantId+domain+fingerprint', async () => {
      if (!isMongoReady()) return;

      const data = validTemplate();
      await new HandlerTemplate(data).save();

      await expect(new HandlerTemplate(data).save()).rejects.toThrow(/duplicate key/i);
    });
  });
});
