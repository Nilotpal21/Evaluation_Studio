import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Job } from 'bullmq';
import type { IndexJobData } from '../queues.js';
import type { SearchProducerDep } from '../index-job.js';
import type { IngestOutcome } from '../../services/attachment-search-producer.js';

// =============================================================================
// MOCK: Mongoose Attachment model
// =============================================================================

const mockFindOne = vi.fn();

vi.mock('@agent-platform/database', () => ({
  Attachment: {
    findOne: (...args: unknown[]) => {
      const result = mockFindOne(...args);
      return { lean: () => result };
    },
  },
}));

// =============================================================================
// HELPERS
// =============================================================================

function makeSearchProducer(
  ingestResult?: IngestOutcome,
): SearchProducerDep & { ingest: ReturnType<typeof vi.fn> } {
  return {
    ingest: vi.fn().mockResolvedValue(
      ingestResult ?? {
        success: true,
        documentId: 'doc-001',
        chunkCount: 5,
      },
    ),
  };
}

function makeJob(data: IndexJobData): Job<IndexJobData> {
  return { data } as Job<IndexJobData>;
}

function makeAttachmentDoc(overrides?: Record<string, unknown>) {
  return {
    _id: 'att-001',
    tenantId: 'tenant-1',
    projectId: 'project-1',
    sessionId: 'session-1',
    originalFilename: 'report.pdf',
    mimeType: 'application/pdf',
    category: 'document',
    sizeBytes: 5000,
    storageKey: 'tenant-1/project-1/session-1/att-001/original',
    scanStatus: 'clean',
    processingStatus: 'completed',
    processedContent: 'Extracted document text content',
    processedContentHash: 'abc123',
    embeddingStatus: 'pending',
    ...overrides,
  };
}

// =============================================================================
// TESTS
// =============================================================================

describe('createIndexWorker', () => {
  let searchProducer: ReturnType<typeof makeSearchProducer>;
  let createIndexWorker: typeof import('../index-job.js').createIndexWorker;

  beforeEach(async () => {
    vi.clearAllMocks();

    mockFindOne.mockResolvedValue(null);

    searchProducer = makeSearchProducer();

    const mod = await import('../index-job.js');
    createIndexWorker = mod.createIndexWorker;
  });

  // ---------------------------------------------------------------------------
  // Happy path: loads attachment, calls searchProducer.ingest(), logs success
  // ---------------------------------------------------------------------------

  it('loads attachment, calls searchProducer.ingest(), and logs success', async () => {
    const attachment = makeAttachmentDoc();
    mockFindOne.mockResolvedValue(attachment);

    const processor = createIndexWorker({ searchProducer });
    await processor(makeJob({ attachmentId: 'att-001', tenantId: 'tenant-1' }));

    // Should look up attachment with tenant-scoped query
    expect(mockFindOne).toHaveBeenCalledWith({ _id: 'att-001', tenantId: 'tenant-1' });

    // Should call searchProducer.ingest with the loaded attachment
    expect(searchProducer.ingest).toHaveBeenCalledWith(attachment);
  });

  // ---------------------------------------------------------------------------
  // Attachment not found: returns without throwing, logs warning
  // ---------------------------------------------------------------------------

  it('returns without throwing when attachment is not found', async () => {
    mockFindOne.mockResolvedValue(null);

    const processor = createIndexWorker({ searchProducer });
    await processor(makeJob({ attachmentId: 'att-999', tenantId: 'tenant-1' }));

    // Should look up attachment
    expect(mockFindOne).toHaveBeenCalledWith({ _id: 'att-999', tenantId: 'tenant-1' });

    // Should NOT call searchProducer.ingest
    expect(searchProducer.ingest).not.toHaveBeenCalled();
  });

  // ---------------------------------------------------------------------------
  // Attachment not yet processed: processingStatus !== 'completed', logs warning
  // ---------------------------------------------------------------------------

  it('skips indexing when attachment processingStatus is not completed', async () => {
    const attachment = makeAttachmentDoc({ processingStatus: 'processing' });
    mockFindOne.mockResolvedValue(attachment);

    const processor = createIndexWorker({ searchProducer });
    await processor(makeJob({ attachmentId: 'att-001', tenantId: 'tenant-1' }));

    // Should NOT call searchProducer.ingest
    expect(searchProducer.ingest).not.toHaveBeenCalled();
  });

  it('skips indexing when attachment processingStatus is pending', async () => {
    const attachment = makeAttachmentDoc({ processingStatus: 'pending' });
    mockFindOne.mockResolvedValue(attachment);

    const processor = createIndexWorker({ searchProducer });
    await processor(makeJob({ attachmentId: 'att-001', tenantId: 'tenant-1' }));

    expect(searchProducer.ingest).not.toHaveBeenCalled();
  });

  it('skips indexing when attachment processingStatus is failed', async () => {
    const attachment = makeAttachmentDoc({ processingStatus: 'failed' });
    mockFindOne.mockResolvedValue(attachment);

    const processor = createIndexWorker({ searchProducer });
    await processor(makeJob({ attachmentId: 'att-001', tenantId: 'tenant-1' }));

    expect(searchProducer.ingest).not.toHaveBeenCalled();
  });

  // ---------------------------------------------------------------------------
  // Search producer returns skipped: logs the skip reason
  // ---------------------------------------------------------------------------

  it('handles searchProducer returning a skipped outcome', async () => {
    const attachment = makeAttachmentDoc();
    mockFindOne.mockResolvedValue(attachment);

    const skippedProducer = makeSearchProducer({
      success: true,
      skipped: true,
      reason: 'no_content',
    });

    const processor = createIndexWorker({ searchProducer: skippedProducer });
    await processor(makeJob({ attachmentId: 'att-001', tenantId: 'tenant-1' }));

    // Should still call searchProducer.ingest
    expect(skippedProducer.ingest).toHaveBeenCalledWith(attachment);
  });

  it('handles searchProducer returning a skipped outcome with no_search_index reason', async () => {
    const attachment = makeAttachmentDoc();
    mockFindOne.mockResolvedValue(attachment);

    const skippedProducer = makeSearchProducer({
      success: true,
      skipped: true,
      reason: 'no_search_index',
    });

    const processor = createIndexWorker({ searchProducer: skippedProducer });
    await processor(makeJob({ attachmentId: 'att-001', tenantId: 'tenant-1' }));

    expect(skippedProducer.ingest).toHaveBeenCalledWith(attachment);
  });

  // ---------------------------------------------------------------------------
  // Search producer returns error: logs the error, does not throw
  // ---------------------------------------------------------------------------

  it('handles searchProducer returning an error outcome without throwing', async () => {
    const attachment = makeAttachmentDoc();
    mockFindOne.mockResolvedValue(attachment);

    const errorProducer = makeSearchProducer({
      success: false,
      error: { code: 'INGESTION_FAILED', message: 'Search AI service unavailable' },
    });

    const processor = createIndexWorker({ searchProducer: errorProducer });

    // Should not throw
    await expect(
      processor(makeJob({ attachmentId: 'att-001', tenantId: 'tenant-1' })),
    ).resolves.toBeUndefined();

    // Should still have called ingest
    expect(errorProducer.ingest).toHaveBeenCalledWith(attachment);
  });

  // ---------------------------------------------------------------------------
  // Unexpected error: exception thrown during processing, caught and logged
  // ---------------------------------------------------------------------------

  it('catches unexpected exceptions from searchProducer.ingest and does not throw', async () => {
    const attachment = makeAttachmentDoc();
    mockFindOne.mockResolvedValue(attachment);

    const throwingProducer = makeSearchProducer();
    (throwingProducer.ingest as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error('Unexpected connection reset'),
    );

    const processor = createIndexWorker({ searchProducer: throwingProducer });

    // Should not throw even when ingest throws
    await expect(
      processor(makeJob({ attachmentId: 'att-001', tenantId: 'tenant-1' })),
    ).resolves.toBeUndefined();
  });

  it('catches unexpected exceptions from DB lookup and does not throw', async () => {
    mockFindOne.mockRejectedValue(new Error('MongoDB connection refused'));

    const processor = createIndexWorker({ searchProducer });

    // Should not throw even when DB throws
    await expect(
      processor(makeJob({ attachmentId: 'att-001', tenantId: 'tenant-1' })),
    ).resolves.toBeUndefined();

    // Should NOT call searchProducer.ingest since DB lookup failed
    expect(searchProducer.ingest).not.toHaveBeenCalled();
  });

  // ---------------------------------------------------------------------------
  // Tenant isolation: all DB operations use tenantId
  // ---------------------------------------------------------------------------

  it('uses tenant-scoped queries for all DB operations', async () => {
    const attachment = makeAttachmentDoc({ tenantId: 'tenant-42' });
    mockFindOne.mockResolvedValue(attachment);

    const processor = createIndexWorker({ searchProducer });
    await processor(makeJob({ attachmentId: 'att-001', tenantId: 'tenant-42' }));

    // findOne includes tenantId
    expect(mockFindOne).toHaveBeenCalledWith({ _id: 'att-001', tenantId: 'tenant-42' });

    // searchProducer.ingest receives the full attachment (which carries tenantId)
    expect(searchProducer.ingest).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: 'tenant-42' }),
    );
  });

  // ---------------------------------------------------------------------------
  // Worker never throws: all error paths are handled gracefully
  // ---------------------------------------------------------------------------

  it('never throws regardless of the error scenario', async () => {
    // Scenario: non-Error throwable
    mockFindOne.mockRejectedValue('string error');

    const processor = createIndexWorker({ searchProducer });

    await expect(
      processor(makeJob({ attachmentId: 'att-001', tenantId: 'tenant-1' })),
    ).resolves.toBeUndefined();
  });
});
