import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  mockVectorDelete,
  mockSearchDocument,
  mockSearchChunk,
  mockChunkQuestion,
  mockSearchIndex,
} = vi.hoisted(() => ({
  mockVectorDelete: vi.fn(),
  mockSearchDocument: {
    distinct: vi.fn(),
    findOneAndUpdate: vi.fn(),
    deleteOne: vi.fn(),
  },
  mockSearchChunk: {
    find: vi.fn(),
    deleteMany: vi.fn(),
  },
  mockChunkQuestion: {
    find: vi.fn(),
    deleteMany: vi.fn(),
  },
  mockSearchIndex: {
    findOne: vi.fn(),
  },
}));

vi.mock('@agent-platform/search-ai-internal', () => ({
  createVectorStore: vi.fn(() => ({
    delete: mockVectorDelete,
  })),
}));

vi.mock('@abl/compiler/platform', () => ({
  createLogger: vi.fn(() => ({
    debug: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  })),
}));

vi.mock('../../db/index.js', () => ({
  getLazyModel: vi.fn((modelName: string) => {
    if (modelName === 'SearchDocument') return mockSearchDocument;
    if (modelName === 'SearchChunk') return mockSearchChunk;
    if (modelName === 'ChunkQuestion') return mockChunkQuestion;
    if (modelName === 'SearchIndex') return mockSearchIndex;
    return {};
  }),
}));

const { deleteDocumentsWithVectorCleanup, deleteSourceDocuments } =
  await import('../document-cleanup.service.js');

describe('document cleanup index isolation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockVectorDelete.mockResolvedValue(undefined);
    mockSearchIndex.findOne.mockReturnValue({
      select: vi.fn().mockReturnValue({
        lean: vi.fn().mockResolvedValue({ activeVectorIndex: 'vector-index-1' }),
      }),
    });
    mockSearchChunk.find.mockReturnValue({
      select: vi.fn().mockReturnValue({
        lean: vi.fn().mockResolvedValue([{ _id: 'chunk-1' }]),
      }),
    });
    mockChunkQuestion.find.mockReturnValue({
      select: vi.fn().mockReturnValue({
        lean: vi.fn().mockResolvedValue([{ _id: 'question-1' }]),
      }),
    });
    mockSearchDocument.findOneAndUpdate.mockResolvedValue({});
    mockSearchDocument.deleteOne.mockResolvedValue({ deletedCount: 1 });
    mockSearchChunk.deleteMany.mockResolvedValue({ deletedCount: 1 });
    mockChunkQuestion.deleteMany.mockResolvedValue({ deletedCount: 1 });
  });

  it('scopes document, chunk, and pending-delete mutations to the target index', async () => {
    await deleteDocumentsWithVectorCleanup(['doc-1'], 'tenant-1', 'index-1');

    expect(mockSearchChunk.find).toHaveBeenCalledWith({
      documentId: 'doc-1',
      tenantId: 'tenant-1',
      indexId: 'index-1',
    });
    expect(mockSearchChunk.deleteMany).toHaveBeenCalledWith({
      documentId: 'doc-1',
      tenantId: 'tenant-1',
      indexId: 'index-1',
    });
    expect(mockSearchDocument.deleteOne).toHaveBeenCalledWith({
      _id: 'doc-1',
      tenantId: 'tenant-1',
      indexId: 'index-1',
    });
  });

  it('selects source documents by source, tenant, and index before vector cleanup', async () => {
    mockSearchDocument.distinct.mockResolvedValue(['doc-1']);

    await deleteSourceDocuments('source-1', 'tenant-1', 'index-1');

    expect(mockSearchDocument.distinct).toHaveBeenCalledWith('_id', {
      sourceId: 'source-1',
      tenantId: 'tenant-1',
      indexId: 'index-1',
    });
  });
});
