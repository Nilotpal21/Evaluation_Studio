import {
  setupTestMongo,
  teardownTestMongo,
  clearCollections,
  isMongoReady,
} from './helpers/setup-mongo.js';
import { Attachment } from '../models/attachment.model.js';

beforeAll(async () => {
  await setupTestMongo();
});

afterAll(async () => {
  await teardownTestMongo();
});

beforeEach(async () => {
  await clearCollections();
});

// ─── Attachment Model ─────────────────────────────────────────────────────

const validAttachment = () => ({
  tenantId: 'tenant-1',
  projectId: 'proj-1',
  sessionId: 'sess-1',
  originalFilename: 'report.pdf',
  mimeType: 'application/pdf',
  category: 'document' as const,
  sizeBytes: 1024,
  storageProvider: 's3',
  storageKey: 'tenant-1/proj-1/sess-1/att-1/original',
  storageBucket: 'attachments',
});

describe('Attachment Model', () => {
  it('sets default fields on instantiation', () => {
    const doc = new Attachment(validAttachment());

    expect(doc._id).toBeDefined();
    expect(doc.tenantId).toBe('tenant-1');
    expect(doc.projectId).toBe('proj-1');
    expect(doc.sessionId).toBe('sess-1');
    expect(doc.originalFilename).toBe('report.pdf');
    expect(doc.mimeType).toBe('application/pdf');
    expect(doc.category).toBe('document');
    expect(doc.sizeBytes).toBe(1024);

    // Optional fields default to null
    expect(doc.detectedMimeType).toBeNull();
    expect(doc.contentHash).toBeNull();
    expect(doc.storageProvider).toBe('s3');
    expect(doc.storageKey).toBe('tenant-1/proj-1/sess-1/att-1/original');
    expect(doc.storageBucket).toBe('attachments');

    // Defaults
    expect(doc.messageId).toBeNull();
    expect(doc.encrypted).toBe(true);
    expect(doc.encryptionKeyVersion).toBe(0);
    expect(doc.scanStatus).toBe('pending');
    expect(doc.scanEngine).toBeNull();
    expect(doc.scannedAt).toBeNull();
    expect(doc.hasPII).toBe(false);
    expect(doc.exifStripped).toBe(false);
    expect(doc.processingStatus).toBe('pending');
    expect(doc.processedContent).toBeNull();
    expect(doc.processedContentHash).toBeNull();
    expect(doc.processingError).toBeNull();
    expect(doc.processingEngine).toBeNull();
    expect(doc.processedAt).toBeNull();
    expect(doc.resizedStorageKey).toBeNull();
    expect(doc.resizedSizeBytes).toBeNull();
    expect(doc.thumbnailStorageKey).toBeNull();
    expect(doc.imageDescription).toBeNull();
    expect(doc.imageDescriptionModel).toBeNull();
    expect(doc.searchIndexId).toBeNull();
    expect(doc.searchDocumentId).toBeNull();
    expect(doc.embeddingStatus).toBe('pending');
    expect(doc.embeddedAt).toBeNull();
    expect(doc.expiresAt).toBeNull();
    expect(doc._v).toBe(1);
  });

  it('requires tenantId', () => {
    const data = validAttachment();
    delete (data as any).tenantId;
    const err = new Attachment(data).validateSync();
    expect(err).toBeDefined();
    expect(err!.errors.tenantId).toBeDefined();
  });

  it('requires projectId', () => {
    const data = validAttachment();
    delete (data as any).projectId;
    const err = new Attachment(data).validateSync();
    expect(err).toBeDefined();
    expect(err!.errors.projectId).toBeDefined();
  });

  it('requires sessionId', () => {
    const data = validAttachment();
    delete (data as any).sessionId;
    const err = new Attachment(data).validateSync();
    expect(err).toBeDefined();
    expect(err!.errors.sessionId).toBeDefined();
  });

  it('requires originalFilename', () => {
    const data = validAttachment();
    delete (data as any).originalFilename;
    const err = new Attachment(data).validateSync();
    expect(err).toBeDefined();
    expect(err!.errors.originalFilename).toBeDefined();
  });

  it('requires mimeType', () => {
    const data = validAttachment();
    delete (data as any).mimeType;
    const err = new Attachment(data).validateSync();
    expect(err).toBeDefined();
    expect(err!.errors.mimeType).toBeDefined();
  });

  it('requires sizeBytes', () => {
    const data = validAttachment();
    delete (data as any).sizeBytes;
    const err = new Attachment(data).validateSync();
    expect(err).toBeDefined();
    expect(err!.errors.sizeBytes).toBeDefined();
  });

  it('rejects sizeBytes less than 1', () => {
    const doc = new Attachment({ ...validAttachment(), sizeBytes: 0 });
    const err = doc.validateSync();
    expect(err).toBeDefined();
    expect(err!.errors.sizeBytes).toBeDefined();
  });

  it('requires storageProvider', () => {
    const data = validAttachment();
    delete (data as any).storageProvider;
    const err = new Attachment(data).validateSync();
    expect(err).toBeDefined();
    expect(err!.errors.storageProvider).toBeDefined();
  });

  it('requires storageKey', () => {
    const data = validAttachment();
    delete (data as any).storageKey;
    const err = new Attachment(data).validateSync();
    expect(err).toBeDefined();
    expect(err!.errors.storageKey).toBeDefined();
  });

  it('requires storageBucket', () => {
    const data = validAttachment();
    delete (data as any).storageBucket;
    const err = new Attachment(data).validateSync();
    expect(err).toBeDefined();
    expect(err!.errors.storageBucket).toBeDefined();
  });

  it('validates category enum', () => {
    const doc = new Attachment({
      ...validAttachment(),
      category: 'invalid_category',
    });
    const err = doc.validateSync();
    expect(err).toBeDefined();
    expect(err!.errors.category).toBeDefined();
  });

  it('validates scanStatus enum', () => {
    const doc = new Attachment({
      ...validAttachment(),
      scanStatus: 'invalid_status',
    });
    const err = doc.validateSync();
    expect(err).toBeDefined();
    expect(err!.errors.scanStatus).toBeDefined();
  });

  it('validates processingStatus enum', () => {
    const doc = new Attachment({
      ...validAttachment(),
      processingStatus: 'invalid_status',
    });
    const err = doc.validateSync();
    expect(err).toBeDefined();
    expect(err!.errors.processingStatus).toBeDefined();
  });

  it('validates embeddingStatus enum', () => {
    const doc = new Attachment({
      ...validAttachment(),
      embeddingStatus: 'invalid_status',
    });
    const err = doc.validateSync();
    expect(err).toBeDefined();
    expect(err!.errors.embeddingStatus).toBeDefined();
  });

  it('accepts valid category values', () => {
    for (const category of ['image', 'document', 'audio', 'video']) {
      const doc = new Attachment({ ...validAttachment(), category });
      const err = doc.validateSync();
      expect(err).toBeUndefined();
    }
  });

  it('generates a UUID v7 _id by default', () => {
    const doc = new Attachment(validAttachment());
    expect(doc._id).toBeDefined();
    expect(typeof doc._id).toBe('string');
    // UUID v7 format: 8-4-4-4-12 hex chars with version 7 and variant bits
    expect(doc._id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });

  it('persists and retrieves from MongoDB', async (ctx) => {
    if (!isMongoReady()) return ctx.skip();
    const doc = await Attachment.create(validAttachment());

    expect(doc._id).toBeDefined();
    expect(doc.tenantId).toBe('tenant-1');
    expect(doc.scanStatus).toBe('pending');
    expect(doc.processingStatus).toBe('pending');
    expect(doc.embeddingStatus).toBe('pending');
    expect(doc.encrypted).toBe(true);
    expect(doc.hasPII).toBe(false);
    expect(doc.exifStripped).toBe(false);
    expect(doc._v).toBe(1);
    expect(doc.createdAt).toBeInstanceOf(Date);
    expect(doc.updatedAt).toBeInstanceOf(Date);
  });

  it('sets TTL index via expiresAt', async (ctx) => {
    if (!isMongoReady()) return ctx.skip();
    const futureDate = new Date(Date.now() + 86400000);
    const doc = await Attachment.create({
      ...validAttachment(),
      expiresAt: futureDate,
    });
    expect(doc.expiresAt).toBeInstanceOf(Date);
    expect(doc.expiresAt!.getTime()).toBe(futureDate.getTime());
  });

  it('rejects create with missing required fields when connected', async (ctx) => {
    if (!isMongoReady()) return ctx.skip();
    await expect(Attachment.create({ tenantId: 'tenant-1' })).rejects.toThrow();
  });
});
