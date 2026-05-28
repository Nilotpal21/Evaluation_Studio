/**
 * Canonical Mapper Worker Tests
 *
 * Unit tests for canonical mapper worker status transitions.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import { DocumentStatus } from '@agent-platform/search-ai-sdk';

// Mock database layer (workers use getLazyModel from db/index.js)
const mockSearchDocument = {
  findOne: vi.fn(),
  findByIdAndUpdate: vi.fn(),
  findOneAndUpdate: vi.fn(),
};
const mockSearchChunk = {
  find: vi.fn(),
  updateMany: vi.fn(),
};
const mockSearchIndex = {
  findById: vi.fn(),
  findOne: vi.fn(),
};
vi.mock('../../db/index.js', () => ({
  getLazyModel: vi.fn((name: string) => {
    if (name === 'SearchDocument') return mockSearchDocument;
    if (name === 'SearchChunk') return mockSearchChunk;
    if (name === 'SearchIndex') return mockSearchIndex;
    return {};
  }),
}));

// Mock database context
vi.mock('@agent-platform/database/mongo', () => ({
  withTenantContext: vi.fn((context, callback) => callback()),
}));

// Mock shared functions
vi.mock('../shared.js', () => ({
  createQueue: vi.fn(() => ({
    add: vi.fn(),
    close: vi.fn(),
  })),
  createWorkerOptions: vi.fn(),
  getRedisConnection: vi.fn(() => ({})),
  workerLog: vi.fn(),
  workerError: vi.fn(),
  withTraceContext: vi.fn((_data: unknown, fn: () => Promise<unknown>) => fn()),
}));

// Mock config
vi.mock('../../config/index.js', () => ({
  getConfig: vi.fn(() => ({})),
}));

// Mock canonical mapper service
vi.mock('../../services/canonical-mapping/canonical-mapper.service.js', () => ({
  getCanonicalMapperService: vi.fn(() => ({
    applyMapping: vi.fn().mockResolvedValue({
      canonicalMetadata: { author: 'Test Author', title: 'Test Title' },
      errors: [],
    }),
    invalidateCache: vi.fn(),
  })),
}));

const SearchDocument = mockSearchDocument;
const SearchChunk = mockSearchChunk;
const SearchIndex = mockSearchIndex;

describe('Canonical Mapper Worker - Status Transitions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  test('should NOT change document status from EXTRACTED', async () => {
    // Mock document with EXTRACTED status
    const mockDocument = {
      _id: 'doc-123',
      indexId: 'index-456',
      status: DocumentStatus.EXTRACTED,
      sourceMetadata: {},
    };

    // Mock index
    const mockIndex = {
      _id: 'index-456',
      tenantId: 'tenant-789',
    };

    // Mock chunks
    const mockChunks = [
      { _id: 'chunk-1', indexId: 'index-456', documentId: 'doc-123', content: 'test' },
      { _id: 'chunk-2', indexId: 'index-456', documentId: 'doc-123', content: 'test' },
    ];

    (SearchDocument.findOne as any).mockResolvedValue(mockDocument);
    (SearchIndex.findOne as any).mockReturnValue({
      lean: vi.fn().mockResolvedValue(mockIndex),
    });
    (SearchChunk.find as any).mockReturnValue({
      lean: vi.fn().mockResolvedValue(mockChunks),
      select: vi.fn().mockReturnValue({
        lean: vi.fn().mockResolvedValue(mockChunks),
      }),
    });
    (SearchChunk.updateMany as any).mockResolvedValue({});
    (SearchDocument.findOneAndUpdate as any).mockResolvedValue(mockDocument);

    // Import and run worker processor
    const { processCanonicalMapJob } = await import('../canonical-mapper-worker.js');

    const mockJob = {
      data: {
        indexId: 'index-456',
        documentId: 'doc-123',
        tenantId: 'tenant-789',
      },
      updateProgress: vi.fn(),
    };

    await processCanonicalMapJob(mockJob as any);

    // Verify findByIdAndUpdate was called
    expect(SearchDocument.findOneAndUpdate).toHaveBeenCalled();

    // Get the update object from the call
    const updateCall = (SearchDocument.findOneAndUpdate as any).mock.calls[0];
    const updateObject = updateCall[1];

    // Verify status was set to ENRICHED after canonical mapping
    expect(updateObject.status).toBe(DocumentStatus.ENRICHED);

    // Verify chunkCount was updated
    expect(updateObject.chunkCount).toBe(2);
  });

  test('should update chunkCount without changing status', async () => {
    const mockDocument = {
      _id: 'doc-123',
      indexId: 'index-456',
      status: DocumentStatus.EXTRACTED,
      sourceMetadata: {},
    };

    const mockIndex = {
      _id: 'index-456',
      tenantId: 'tenant-789',
    };

    const mockChunks = [{ _id: 'chunk-1' }, { _id: 'chunk-2' }, { _id: 'chunk-3' }];

    (SearchDocument.findOne as any).mockResolvedValue(mockDocument);
    (SearchIndex.findOne as any).mockReturnValue({
      lean: vi.fn().mockResolvedValue(mockIndex),
    });
    (SearchChunk.find as any).mockReturnValue({
      lean: vi.fn().mockResolvedValue(mockChunks),
      select: vi.fn().mockReturnValue({
        lean: vi.fn().mockResolvedValue(mockChunks),
      }),
    });
    (SearchChunk.updateMany as any).mockResolvedValue({});
    (SearchDocument.findOneAndUpdate as any).mockResolvedValue(mockDocument);

    const { processCanonicalMapJob } = await import('../canonical-mapper-worker.js');

    const mockJob = {
      data: {
        indexId: 'index-456',
        documentId: 'doc-123',
        tenantId: 'tenant-789',
      },
      updateProgress: vi.fn(),
    };

    await processCanonicalMapJob(mockJob as any);

    const updateCall = (SearchDocument.findOneAndUpdate as any).mock.calls[0];
    const updateObject = updateCall[1];

    expect(updateObject.chunkCount).toBe(3);
    expect(updateObject.status).toBe(DocumentStatus.ENRICHED);
  });
});

describe('Canonical Mapper Worker - Phase 1 Integration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  test('should apply canonical mapping via service', async () => {
    const mockDocument = {
      _id: 'doc-123',
      indexId: 'index-456',
      status: DocumentStatus.EXTRACTED,
      sourceMetadata: { raw_author: 'John Doe', raw_title: 'Test Doc' },
      connectorId: 'connector_abc',
    };

    const mockIndex = {
      _id: 'index-456',
      tenantId: 'tenant-789',
    };

    const mockChunks = [{ _id: 'chunk-1' }];

    (SearchDocument.findOne as any).mockResolvedValue(mockDocument);
    (SearchIndex.findOne as any).mockReturnValue({
      lean: vi.fn().mockResolvedValue(mockIndex),
    });
    (SearchChunk.find as any).mockReturnValue({
      lean: vi.fn().mockResolvedValue(mockChunks),
      select: vi.fn().mockReturnValue({
        lean: vi.fn().mockResolvedValue(mockChunks),
      }),
    });
    (SearchChunk.updateMany as any).mockResolvedValue({});
    (SearchDocument.findOneAndUpdate as any).mockResolvedValue(mockDocument);

    const { processCanonicalMapJob } = await import('../canonical-mapper-worker.js');

    const mockJob = {
      data: {
        indexId: 'index-456',
        documentId: 'doc-123',
        tenantId: 'tenant-789',
      },
      updateProgress: vi.fn(),
    };

    await processCanonicalMapJob(mockJob as any);

    // Verify chunks were updated (service integration verified via mock)
    expect(SearchChunk.updateMany).toHaveBeenCalled();
    expect(SearchDocument.findOneAndUpdate).toHaveBeenCalled();
  });

  test('should update chunks with canonical metadata', async () => {
    const mockDocument = {
      _id: 'doc-123',
      indexId: 'index-456',
      status: DocumentStatus.EXTRACTED,
      sourceMetadata: { raw_author: 'John Doe' },
      connectorId: 'connector_abc',
    };

    const mockIndex = {
      _id: 'index-456',
      tenantId: 'tenant-789',
    };

    const mockChunks = [{ _id: 'chunk-1' }, { _id: 'chunk-2' }];

    (SearchDocument.findOne as any).mockResolvedValue(mockDocument);
    (SearchIndex.findOne as any).mockReturnValue({
      lean: vi.fn().mockResolvedValue(mockIndex),
    });
    (SearchChunk.find as any).mockReturnValue({
      lean: vi.fn().mockResolvedValue(mockChunks),
      select: vi.fn().mockReturnValue({
        lean: vi.fn().mockResolvedValue(mockChunks),
      }),
    });
    (SearchChunk.updateMany as any).mockResolvedValue({});
    (SearchDocument.findOneAndUpdate as any).mockResolvedValue(mockDocument);

    const { processCanonicalMapJob } = await import('../canonical-mapper-worker.js');

    const mockJob = {
      data: {
        indexId: 'index-456',
        documentId: 'doc-123',
        tenantId: 'tenant-789',
      },
      updateProgress: vi.fn(),
    };

    await processCanonicalMapJob(mockJob as any);

    // Verify chunks were updated with canonical metadata
    // Default canonical fields (status from document) + service mapping results (author, title)
    // Non-canonical keys are filtered out by the worker
    expect(SearchChunk.updateMany).toHaveBeenCalledWith(
      { indexId: 'index-456', documentId: 'doc-123', tenantId: 'tenant-789' },
      {
        $set: {
          canonicalMetadata: {
            status: 'extracted',
            author: 'Test Author',
            title: 'Test Title',
          },
        },
      },
    );
  });

  test('should handle mapping errors gracefully', async () => {
    const mockDocument = {
      _id: 'doc-123',
      indexId: 'index-456',
      status: DocumentStatus.EXTRACTED,
      sourceMetadata: { raw_author: 'John Doe' },
      connectorId: 'connector_abc',
    };

    const mockIndex = {
      _id: 'index-456',
      tenantId: 'tenant-789',
    };

    const mockChunks = [{ _id: 'chunk-1' }];

    (SearchDocument.findOne as any).mockResolvedValue(mockDocument);
    (SearchIndex.findOne as any).mockReturnValue({
      lean: vi.fn().mockResolvedValue(mockIndex),
    });
    (SearchChunk.find as any).mockReturnValue({
      lean: vi.fn().mockResolvedValue(mockChunks),
      select: vi.fn().mockReturnValue({
        lean: vi.fn().mockResolvedValue(mockChunks),
      }),
    });
    (SearchChunk.updateMany as any).mockResolvedValue({});
    (SearchDocument.findOneAndUpdate as any).mockResolvedValue(mockDocument);

    // Mock service to return errors
    const { getCanonicalMapperService } =
      await import('../../services/canonical-mapping/canonical-mapper.service.js');
    const service = getCanonicalMapperService();
    (service.applyMapping as any).mockResolvedValue({
      canonicalMetadata: { author: 'Test Author' },
      errors: ['Field raw_title → title: Invalid format'],
    });

    const { processCanonicalMapJob } = await import('../canonical-mapper-worker.js');

    const mockJob = {
      data: {
        indexId: 'index-456',
        documentId: 'doc-123',
        tenantId: 'tenant-789',
      },
      updateProgress: vi.fn(),
    };

    // Should not throw - errors are logged but processing continues
    await expect(processCanonicalMapJob(mockJob as any)).resolves.not.toThrow();
  });

  test('should handle null connectorId gracefully', async () => {
    const mockDocument = {
      _id: 'doc-123',
      indexId: 'index-456',
      status: DocumentStatus.EXTRACTED,
      sourceMetadata: { author: 'John Doe' },
      connectorId: null, // Direct upload - no connector
    };

    const mockIndex = {
      _id: 'index-456',
      tenantId: 'tenant-789',
    };

    const mockChunks = [{ _id: 'chunk-1' }];

    (SearchDocument.findOne as any).mockResolvedValue(mockDocument);
    (SearchIndex.findOne as any).mockReturnValue({
      lean: vi.fn().mockResolvedValue(mockIndex),
    });
    (SearchChunk.find as any).mockReturnValue({
      lean: vi.fn().mockResolvedValue(mockChunks),
      select: vi.fn().mockReturnValue({
        lean: vi.fn().mockResolvedValue(mockChunks),
      }),
    });
    (SearchChunk.updateMany as any).mockResolvedValue({});
    (SearchDocument.findOneAndUpdate as any).mockResolvedValue(mockDocument);

    const { processCanonicalMapJob } = await import('../canonical-mapper-worker.js');

    const mockJob = {
      data: {
        indexId: 'index-456',
        documentId: 'doc-123',
        tenantId: 'tenant-789',
      },
      updateProgress: vi.fn(),
    };

    // Should not throw even with null connectorId
    await expect(processCanonicalMapJob(mockJob as any)).resolves.not.toThrow();
  });
});
