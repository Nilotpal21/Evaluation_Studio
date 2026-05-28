/**
 * Document Upload — ConnectorId Resolution Tests
 *
 * Verifies that the upload handler looks up ConnectorConfig by sourceId
 * and sets connectorId on the created SearchDocument.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Hoisted Mocks ──────────────────────────────────────────────────────────

const { mockSearchIndex, mockSearchSource, mockSearchDocument, mockConnectorConfig } = vi.hoisted(
  () => ({
    mockSearchIndex: {
      findOne: vi.fn(),
    },
    mockSearchSource: {
      findOne: vi.fn(),
      findOneAndUpdate: vi.fn(),
    },
    mockSearchDocument: {
      findOne: vi.fn(),
      create: vi.fn(),
    },
    mockConnectorConfig: {
      findOne: vi.fn(),
      findOneAndUpdate: vi.fn().mockResolvedValue({}),
    },
  }),
);

vi.mock('../../db/index.js', () => ({
  getLazyModel: vi.fn((modelName: string) => {
    if (modelName === 'SearchIndex') return mockSearchIndex;
    if (modelName === 'SearchSource') return mockSearchSource;
    if (modelName === 'SearchDocument') return mockSearchDocument;
    if (modelName === 'ConnectorConfig') return mockConnectorConfig;
    return {};
  }),
}));

// Mock tenant context
vi.mock('@agent-platform/database/mongo', () => ({
  withTenantContext: vi.fn((_ctx: unknown, fn: () => Promise<void>) => fn()),
}));

// Mock search-ai-sdk
vi.mock('@agent-platform/search-ai-sdk', () => ({
  QUEUE_DOCLING_EXTRACTION: 'docling-extraction',
  QUEUE_EXTRACTION: 'extraction',
  DocumentStatus: { PENDING: 'pending' },
  SourceStatus: { PENDING: 'pending', ACTIVE: 'active' },
}));

// Mock shared worker utilities (createQueue)
const mockExtractionQueue = {
  add: vi.fn().mockResolvedValue({}),
  close: vi.fn().mockResolvedValue({}),
};
vi.mock('../../workers/shared.js', () => ({
  createQueue: vi.fn(() => mockExtractionQueue),
  getRedisConnection: vi.fn(() => ({})),
  workerLog: vi.fn(),
  workerError: vi.fn(),
}));

// Mock storage
vi.mock('../../storage/storage-factory.js', () => ({
  createFileStorage: vi.fn(() => ({
    provider: 'local',
    upload: vi.fn().mockResolvedValue({ url: 'file:///tmp/test.pdf' }),
  })),
  generateStorageKey: vi.fn(() => 'documents/tenant-1/idx-1/test.pdf'),
}));

// Mock config
vi.mock('../../config/index.js', () => ({
  getConfig: vi.fn(() => ({
    storage: { provider: 'local', localPath: '/tmp' },
  })),
}));

// Mock fs/promises (handler uses fs.readFile for disk-stored uploads and fs.unlink for cleanup)
vi.mock('fs/promises', () => ({
  readFile: vi.fn().mockResolvedValue(Buffer.from('test-content')),
  unlink: vi.fn().mockResolvedValue(undefined),
}));

// Mock fs (handler uses fs.existsSync and fs.mkdirSync for temp dir)
// Must include `default` so that `import fs from 'fs'` resolves correctly in ESM.
vi.mock('fs', () => {
  const fsMock = {
    existsSync: vi.fn().mockReturnValue(true),
    mkdirSync: vi.fn(),
  };
  return { default: fsMock, ...fsMock };
});

// Mock multer (not needed for handler-level test)
vi.mock('multer', () => {
  const memoryStorage = vi.fn();
  const diskStorage = vi.fn(() => ({}));
  const multerFn: any = vi.fn(() => ({ single: vi.fn(() => vi.fn()) }));
  multerFn.memoryStorage = memoryStorage;
  multerFn.diskStorage = diskStorage;
  return { default: multerFn };
});

import documentUploadRouter from '../document-upload.js';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function getPostHandler() {
  const stack = (documentUploadRouter as any).stack;
  const postLayer = stack.find(
    (layer: any) =>
      layer.route?.methods?.post && layer.route?.path === '/:indexId/sources/:sourceId/documents',
  );
  if (!postLayer) throw new Error('POST documents route not found');
  // The async handler is the last in the stack (after multer middleware + error handler)
  const handlers = postLayer.route.stack;
  return handlers[handlers.length - 1].handle;
}

function createMockReq(overrides: Record<string, any> = {}): any {
  return {
    params: { indexId: 'idx-1', sourceId: 'src-1' },
    body: {},
    query: {},
    headers: { 'content-type': 'multipart/form-data' },
    tenantContext: { tenantId: 'tenant-1' },
    file: {
      originalname: 'test.pdf',
      mimetype: 'application/pdf',
      size: 1024,
      path: '/tmp/uploads/temp/test.pdf',
      buffer: Buffer.from('test-content'),
    },
    ...overrides,
  };
}

function createMockRes(): any {
  const res: any = {};
  res.status = vi.fn().mockReturnValue(res);
  res.json = vi.fn().mockReturnValue(res);
  return res;
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('Document Upload — connectorId resolution', () => {
  let handler: (...args: any[]) => Promise<void>;

  beforeEach(() => {
    vi.clearAllMocks();
    handler = getPostHandler();

    // Index exists
    mockSearchIndex.findOne.mockReturnValue({
      lean: vi.fn().mockResolvedValue({ _id: 'idx-1', tenantId: 'tenant-1' }),
    });

    // Source exists
    mockSearchSource.findOne.mockReturnValue({
      lean: vi.fn().mockResolvedValue({
        _id: 'src-1',
        indexId: 'idx-1',
        tenantId: 'tenant-1',
        status: 'active',
      }),
    });
    mockSearchSource.findOneAndUpdate.mockResolvedValue({});

    // No duplicate document
    mockSearchDocument.findOne.mockReturnValue({
      lean: vi.fn().mockResolvedValue(null),
    });

    // Document creation
    mockSearchDocument.create.mockResolvedValue({
      _id: 'doc-1',
      tenantId: 'tenant-1',
      indexId: 'idx-1',
      sourceId: 'src-1',
      connectorId: 'cc-1',
      originalReference: 'test.pdf',
      contentType: 'application/pdf',
      contentSizeBytes: 1024,
      status: 'pending',
      sourceMetadata: {},
      createdAt: new Date(),
    });
  });

  it('should set connectorId from ConnectorConfig lookup', async () => {
    mockConnectorConfig.findOne.mockReturnValue({
      lean: vi.fn().mockResolvedValue({ _id: 'cc-1', tenantId: 'tenant-1', sourceId: 'src-1' }),
    });

    const req = createMockReq();
    const res = createMockRes();
    const next = vi.fn();

    await handler(req, res, next);

    expect(mockSearchDocument.create).toHaveBeenCalledWith(
      expect.objectContaining({
        connectorId: 'cc-1',
      }),
    );
  });

  it('should set connectorId=null when no ConnectorConfig exists', async () => {
    mockConnectorConfig.findOne.mockReturnValue({
      lean: vi.fn().mockResolvedValue(null),
    });

    // Adjust create mock for null connectorId
    mockSearchDocument.create.mockResolvedValue({
      _id: 'doc-1',
      tenantId: 'tenant-1',
      indexId: 'idx-1',
      sourceId: 'src-1',
      connectorId: null,
      originalReference: 'test.pdf',
      contentType: 'application/pdf',
      contentSizeBytes: 1024,
      status: 'pending',
      sourceMetadata: {},
      createdAt: new Date(),
    });

    const req = createMockReq();
    const res = createMockRes();
    const next = vi.fn();

    await handler(req, res, next);

    expect(mockSearchDocument.create).toHaveBeenCalledWith(
      expect.objectContaining({
        connectorId: null,
      }),
    );
  });
});
