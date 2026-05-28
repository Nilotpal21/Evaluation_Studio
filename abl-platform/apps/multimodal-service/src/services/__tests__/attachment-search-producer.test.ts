import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { IAttachment } from '@agent-platform/database';
import type { SearchAIClient, IngestDocumentResult } from '@agent-platform/search-ai-sdk';
import type { SearchIndexResolver } from '../attachment-search-producer.js';

// =============================================================================
// MOCK: Mongoose Attachment model
// =============================================================================

const mockFindOneAndUpdate = vi.fn();

vi.mock('@agent-platform/database', () => ({
  Attachment: {
    findOneAndUpdate: mockFindOneAndUpdate,
  },
}));

// =============================================================================
// HELPERS
// =============================================================================

function makeAttachment(overrides?: Partial<IAttachment>): IAttachment {
  return {
    _id: 'att-001',
    tenantId: 'tenant-1',
    projectId: 'project-1',
    sessionId: 'session-1',
    messageId: null,
    originalFilename: 'report.pdf',
    mimeType: 'application/pdf',
    detectedMimeType: null,
    category: 'document',
    sizeBytes: 5000,
    contentHash: 'abc123',
    storageProvider: 's3',
    storageKey: 'tenant-1/project-1/session-1/att-001/original',
    storageBucket: 'attachments',
    encrypted: false,
    encryptionKeyVersion: 0,
    processingMode: 'full',
    scanStatus: 'clean',
    scanEngine: 'clamav',
    scannedAt: new Date(),
    hasPII: false,
    piiDetections: [],
    exifStripped: false,
    processingStatus: 'completed',
    processedContent: 'Extracted document text content',
    processedContentHash: 'hash123',
    processingError: null,
    processingEngine: 'tika',
    processedAt: new Date(),
    resizedStorageKey: null,
    resizedSizeBytes: null,
    thumbnailStorageKey: null,
    frameStorageKeys: [],
    imageDescription: null,
    imageDescriptionModel: null,
    searchIndexId: null,
    searchDocumentId: null,
    embeddingStatus: 'pending',
    embeddedAt: null,
    retryCount: 0,
    expiresAt: new Date('2026-04-01T00:00:00Z'),
    createdAt: new Date(),
    updatedAt: new Date(),
    _v: 1,
    ...overrides,
  };
}

function makeSearchClient(overrides?: Partial<SearchAIClient>): SearchAIClient {
  return {
    ingestDocument: vi.fn().mockResolvedValue({
      documentId: 'doc-001',
      title: 'report.pdf',
      chunkCount: 3,
    } satisfies IngestDocumentResult),
    ...overrides,
  } as unknown as SearchAIClient;
}

function makeIndexResolver(overrides?: Partial<SearchIndexResolver>): SearchIndexResolver {
  return {
    resolveForProject: vi.fn().mockResolvedValue('idx-001'),
    ...overrides,
  };
}

// =============================================================================
// TESTS
// =============================================================================

describe('AttachmentSearchProducer', () => {
  let searchClient: ReturnType<typeof makeSearchClient>;
  let indexResolver: ReturnType<typeof makeIndexResolver>;
  let AttachmentSearchProducer: typeof import('../attachment-search-producer.js').AttachmentSearchProducer;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockFindOneAndUpdate.mockResolvedValue(null);

    searchClient = makeSearchClient();
    indexResolver = makeIndexResolver();

    const mod = await import('../attachment-search-producer.js');
    AttachmentSearchProducer = mod.AttachmentSearchProducer;
  });

  // ---------------------------------------------------------------------------
  // 1. Happy path: ingests document content into Search AI
  // ---------------------------------------------------------------------------

  it('ingests document content with correct call shape', async () => {
    const attachment = makeAttachment();
    const producer = new AttachmentSearchProducer({ searchClient, indexResolver });

    const result = await producer.ingest(attachment);

    // Should resolve the search index for the project
    expect(indexResolver.resolveForProject).toHaveBeenCalledWith('tenant-1', 'project-1');

    // Should call ingestDocument with the correct arguments
    expect(searchClient.ingestDocument).toHaveBeenCalledWith('idx-001', {
      title: 'report.pdf',
      rawText: 'Extracted document text content',
      sourceMetadata: {
        sourceType: 'attachment',
        attachmentId: 'att-001',
        tenantId: 'tenant-1',
        projectId: 'project-1',
        sessionId: 'session-1',
        category: 'document',
        mimeType: 'application/pdf',
        originalFilename: 'report.pdf',
      },
    });

    // Should return success with document details
    expect(result).toEqual({
      success: true,
      documentId: 'doc-001',
      chunkCount: 3,
    });
  });

  // ---------------------------------------------------------------------------
  // 2. Skips when no search index configured
  // ---------------------------------------------------------------------------

  it('skips when no search index configured for project', async () => {
    const attachment = makeAttachment();
    indexResolver = makeIndexResolver({
      resolveForProject: vi.fn().mockResolvedValue(null),
    });

    const producer = new AttachmentSearchProducer({ searchClient, indexResolver });
    const result = await producer.ingest(attachment);

    // Should NOT call ingestDocument
    expect(searchClient.ingestDocument).not.toHaveBeenCalled();

    // Should update embeddingStatus to 'skipped'
    expect(mockFindOneAndUpdate).toHaveBeenCalledWith(
      { _id: 'att-001', tenantId: 'tenant-1' },
      { $set: { embeddingStatus: 'skipped' } },
    );

    // Should return skipped result
    expect(result).toEqual({
      success: true,
      skipped: true,
      reason: 'no_search_index',
    });
  });

  // ---------------------------------------------------------------------------
  // 3. Skips when no processedContent and no imageDescription
  // ---------------------------------------------------------------------------

  it('skips when no processedContent and no imageDescription', async () => {
    const attachment = makeAttachment({
      processedContent: null,
      imageDescription: null,
    });

    const producer = new AttachmentSearchProducer({ searchClient, indexResolver });
    const result = await producer.ingest(attachment);

    // Should NOT call resolveForProject (early return)
    expect(indexResolver.resolveForProject).not.toHaveBeenCalled();

    // Should NOT call ingestDocument
    expect(searchClient.ingestDocument).not.toHaveBeenCalled();

    // Should update embeddingStatus to 'skipped'
    expect(mockFindOneAndUpdate).toHaveBeenCalledWith(
      { _id: 'att-001', tenantId: 'tenant-1' },
      { $set: { embeddingStatus: 'skipped' } },
    );

    // Should return skipped result
    expect(result).toEqual({
      success: true,
      skipped: true,
      reason: 'no_content',
    });
  });

  // ---------------------------------------------------------------------------
  // 4. Combines processedContent and imageDescription
  // ---------------------------------------------------------------------------

  it('combines processedContent and imageDescription with separator', async () => {
    const attachment = makeAttachment({
      processedContent: 'Document text content',
      imageDescription: 'A photo of a sunset over mountains',
    });

    const producer = new AttachmentSearchProducer({ searchClient, indexResolver });
    await producer.ingest(attachment);

    // Should combine both fields with double newline separator
    expect(searchClient.ingestDocument).toHaveBeenCalledWith(
      'idx-001',
      expect.objectContaining({
        rawText: 'Document text content\n\nA photo of a sunset over mountains',
      }),
    );
  });

  // ---------------------------------------------------------------------------
  // 5. Uses imageDescription alone when no processedContent
  // ---------------------------------------------------------------------------

  it('uses imageDescription alone when no processedContent', async () => {
    const attachment = makeAttachment({
      category: 'image',
      mimeType: 'image/png',
      originalFilename: 'photo.png',
      processedContent: null,
      imageDescription: 'A photo of a sunset over mountains',
    });

    const producer = new AttachmentSearchProducer({ searchClient, indexResolver });
    await producer.ingest(attachment);

    // Should use only imageDescription as rawText
    expect(searchClient.ingestDocument).toHaveBeenCalledWith(
      'idx-001',
      expect.objectContaining({
        rawText: 'A photo of a sunset over mountains',
      }),
    );
  });

  // ---------------------------------------------------------------------------
  // 6. Updates attachment with searchIndexId after indexing
  // ---------------------------------------------------------------------------

  it('updates attachment with searchIndexId and searchDocumentId after indexing', async () => {
    const attachment = makeAttachment();

    const producer = new AttachmentSearchProducer({ searchClient, indexResolver });
    await producer.ingest(attachment);

    // Should update to 'processing' before ingestion
    expect(mockFindOneAndUpdate).toHaveBeenCalledWith(
      { _id: 'att-001', tenantId: 'tenant-1' },
      { $set: { embeddingStatus: 'processing', searchIndexId: 'idx-001' } },
    );

    // Should update with final completed state after ingestion
    expect(mockFindOneAndUpdate).toHaveBeenCalledWith(
      { _id: 'att-001', tenantId: 'tenant-1' },
      {
        $set: {
          searchIndexId: 'idx-001',
          searchDocumentId: 'doc-001',
          embeddingStatus: 'completed',
          embeddedAt: expect.any(Date),
        },
      },
    );
  });

  // ---------------------------------------------------------------------------
  // 7. Handles ingestion errors gracefully
  // ---------------------------------------------------------------------------

  it('handles ingestion errors gracefully without throwing', async () => {
    const attachment = makeAttachment();
    searchClient = makeSearchClient({
      ingestDocument: vi
        .fn()
        .mockRejectedValue(new Error('Search API error: 503 Service Unavailable')),
    } as Partial<SearchAIClient>);

    const producer = new AttachmentSearchProducer({ searchClient, indexResolver });
    const result = await producer.ingest(attachment);

    // Should return structured error, not throw
    expect(result).toEqual({
      success: false,
      error: {
        code: 'INGESTION_FAILED',
        message: 'Search API error: 503 Service Unavailable',
      },
    });
  });

  // ---------------------------------------------------------------------------
  // 8. Updates embeddingStatus to 'failed' on error
  // ---------------------------------------------------------------------------

  it('updates embeddingStatus to failed on ingestion error', async () => {
    const attachment = makeAttachment();
    searchClient = makeSearchClient({
      ingestDocument: vi.fn().mockRejectedValue(new Error('Connection refused')),
    } as Partial<SearchAIClient>);

    const producer = new AttachmentSearchProducer({ searchClient, indexResolver });
    await producer.ingest(attachment);

    // Should update embeddingStatus to 'failed'
    expect(mockFindOneAndUpdate).toHaveBeenCalledWith(
      { _id: 'att-001', tenantId: 'tenant-1' },
      { $set: { embeddingStatus: 'failed', searchIndexId: 'idx-001' } },
    );
  });

  // ---------------------------------------------------------------------------
  // Tenant isolation: all DB operations use tenant-scoped queries
  // ---------------------------------------------------------------------------

  it('uses tenant-scoped queries for all DB operations', async () => {
    const attachment = makeAttachment({ tenantId: 'tenant-42' });
    indexResolver = makeIndexResolver({
      resolveForProject: vi.fn().mockResolvedValue('idx-042'),
    });

    const producer = new AttachmentSearchProducer({ searchClient, indexResolver });
    await producer.ingest(attachment);

    // Every findOneAndUpdate call must include tenantId in the filter
    for (const call of mockFindOneAndUpdate.mock.calls) {
      const filter = call[0] as Record<string, unknown>;
      expect(filter).toHaveProperty('tenantId', 'tenant-42');
      expect(filter).toHaveProperty('_id', 'att-001');
    }
  });
});
