import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Mock } from 'vitest';
import type { Job } from 'bullmq';
import type { StorageProvider } from '@agent-platform/shared';
import type { AttachmentSearchProducer } from '../../services/attachment-search-producer.js';
import type { CleanupEvent } from '../cleanup-job.js';
import type { CleanupJobData } from '../queues.js';

// =============================================================================
// MOCK: Mongoose Attachment model
// =============================================================================

const mockFindOne = vi.fn();
const mockDeleteOne = vi.fn();

vi.mock('@agent-platform/database', () => ({
  Attachment: {
    findOne: (...args: unknown[]) => {
      const result = mockFindOne(...args);
      return { lean: () => result };
    },
    deleteOne: mockDeleteOne,
  },
}));

vi.mock('../queues.js', () => ({
  workerLog: vi.fn(),
  workerError: vi.fn(),
}));

// =============================================================================
// HELPERS
// =============================================================================

function makeStorageProvider(overrides?: Partial<StorageProvider>): StorageProvider {
  return {
    name: 'test-storage',
    upload: vi.fn(),
    download: vi.fn(),
    getSignedUrl: vi.fn(),
    delete: vi.fn().mockResolvedValue(undefined),
    deleteMany: vi.fn(),
    exists: vi.fn(),
    copy: vi.fn(),
    healthCheck: vi.fn(),
    ...overrides,
  };
}

function makeSearchProducer(
  overrides?: Partial<AttachmentSearchProducer>,
): AttachmentSearchProducer {
  return {
    ingest: vi.fn(),
    remove: vi.fn().mockResolvedValue({ success: true }),
    ...overrides,
  } as unknown as AttachmentSearchProducer;
}

function makeJob(data: CleanupJobData): Job<CleanupJobData> {
  return { data } as Job<CleanupJobData>;
}

function makeAttachmentDoc(overrides?: Record<string, unknown>) {
  return {
    _id: 'att-001',
    tenantId: 'tenant-1',
    sessionId: 'session-1',
    projectId: 'project-1',
    storageKey: 'tenant-1/project-1/session-1/att-001/original',
    resizedStorageKey: null,
    thumbnailStorageKey: null,
    searchIndexId: null,
    searchDocumentId: null,
    originalFilename: 'photo.png',
    mimeType: 'image/png',
    category: 'image',
    sizeBytes: 1024,
    ...overrides,
  };
}

// =============================================================================
// TESTS
// =============================================================================

describe('createCleanupWorker', () => {
  let storageProvider: ReturnType<typeof makeStorageProvider>;
  let searchProducer: ReturnType<typeof makeSearchProducer>;
  let onCleanupComplete: Mock<(event: CleanupEvent) => void>;
  let createCleanupWorker: typeof import('../cleanup-job.js').createCleanupWorker;

  beforeEach(async () => {
    vi.clearAllMocks();

    mockFindOne.mockResolvedValue(null);
    mockDeleteOne.mockResolvedValue({ deletedCount: 1 });

    storageProvider = makeStorageProvider();
    searchProducer = makeSearchProducer();
    onCleanupComplete = vi.fn();

    const mod = await import('../cleanup-job.js');
    createCleanupWorker = mod.createCleanupWorker;
  });

  // ---------------------------------------------------------------------------
  // 1. Loads attachment with tenant-scoped query
  // ---------------------------------------------------------------------------

  it('loads attachment with tenant-scoped query (findOne with _id AND tenantId)', async () => {
    const attachment = makeAttachmentDoc();
    mockFindOne.mockResolvedValue(attachment);

    const processor = createCleanupWorker({ storageProvider, searchProducer, onCleanupComplete });
    await processor(makeJob({ attachmentId: 'att-001', tenantId: 'tenant-1', reason: 'expired' }));

    expect(mockFindOne).toHaveBeenCalledWith({ _id: 'att-001', tenantId: 'tenant-1' });
  });

  // ---------------------------------------------------------------------------
  // 2. Returns early when attachment not found
  // ---------------------------------------------------------------------------

  it('returns early when attachment not found without performing any cleanup', async () => {
    mockFindOne.mockResolvedValue(null);

    const processor = createCleanupWorker({ storageProvider, searchProducer, onCleanupComplete });
    await processor(makeJob({ attachmentId: 'att-999', tenantId: 'tenant-1', reason: 'expired' }));

    expect(searchProducer.remove).not.toHaveBeenCalled();
    expect(storageProvider.delete).not.toHaveBeenCalled();
    expect(onCleanupComplete).not.toHaveBeenCalled();
    expect(mockDeleteOne).not.toHaveBeenCalled();
  });

  // ---------------------------------------------------------------------------
  // 3. Calls searchProducer.remove() when attachment has searchIndexId
  // ---------------------------------------------------------------------------

  it('calls searchProducer.remove() when attachment has searchIndexId', async () => {
    const attachment = makeAttachmentDoc({ searchIndexId: 'idx-100' });
    mockFindOne.mockResolvedValue(attachment);

    const processor = createCleanupWorker({ storageProvider, searchProducer, onCleanupComplete });
    await processor(makeJob({ attachmentId: 'att-001', tenantId: 'tenant-1', reason: 'infected' }));

    expect(searchProducer.remove).toHaveBeenCalledWith(attachment);
  });

  // ---------------------------------------------------------------------------
  // 4. Calls searchProducer.remove() when attachment has searchDocumentId
  // ---------------------------------------------------------------------------

  it('calls searchProducer.remove() when attachment has searchDocumentId', async () => {
    const attachment = makeAttachmentDoc({ searchDocumentId: 'doc-200' });
    mockFindOne.mockResolvedValue(attachment);

    const processor = createCleanupWorker({ storageProvider, searchProducer, onCleanupComplete });
    await processor(
      makeJob({ attachmentId: 'att-001', tenantId: 'tenant-1', reason: 'session_deleted' }),
    );

    expect(searchProducer.remove).toHaveBeenCalledWith(attachment);
  });

  // ---------------------------------------------------------------------------
  // 5. Skips search cleanup when no search fields
  // ---------------------------------------------------------------------------

  it('skips search cleanup when attachment has no searchIndexId or searchDocumentId', async () => {
    const attachment = makeAttachmentDoc({ searchIndexId: null, searchDocumentId: null });
    mockFindOne.mockResolvedValue(attachment);

    const processor = createCleanupWorker({ storageProvider, searchProducer, onCleanupComplete });
    await processor(makeJob({ attachmentId: 'att-001', tenantId: 'tenant-1', reason: 'expired' }));

    expect(searchProducer.remove).not.toHaveBeenCalled();
  });

  // ---------------------------------------------------------------------------
  // 6. Deletes original storage key
  // ---------------------------------------------------------------------------

  it('deletes the original storage key', async () => {
    const attachment = makeAttachmentDoc();
    mockFindOne.mockResolvedValue(attachment);

    const processor = createCleanupWorker({ storageProvider, searchProducer, onCleanupComplete });
    await processor(makeJob({ attachmentId: 'att-001', tenantId: 'tenant-1', reason: 'expired' }));

    expect(storageProvider.delete).toHaveBeenCalledWith(
      'tenant-1/project-1/session-1/att-001/original',
    );
  });

  // ---------------------------------------------------------------------------
  // 7. Deletes resized storage key when present
  // ---------------------------------------------------------------------------

  it('deletes resized storage key when present', async () => {
    const attachment = makeAttachmentDoc({
      resizedStorageKey: 'tenant-1/project-1/session-1/att-001/resized',
    });
    mockFindOne.mockResolvedValue(attachment);

    const processor = createCleanupWorker({ storageProvider, searchProducer, onCleanupComplete });
    await processor(makeJob({ attachmentId: 'att-001', tenantId: 'tenant-1', reason: 'expired' }));

    expect(storageProvider.delete).toHaveBeenCalledWith(
      'tenant-1/project-1/session-1/att-001/resized',
    );
  });

  // ---------------------------------------------------------------------------
  // 8. Deletes thumbnail storage key when present
  // ---------------------------------------------------------------------------

  it('deletes thumbnail storage key when present', async () => {
    const attachment = makeAttachmentDoc({
      thumbnailStorageKey: 'tenant-1/project-1/session-1/att-001/thumb',
    });
    mockFindOne.mockResolvedValue(attachment);

    const processor = createCleanupWorker({ storageProvider, searchProducer, onCleanupComplete });
    await processor(makeJob({ attachmentId: 'att-001', tenantId: 'tenant-1', reason: 'expired' }));

    expect(storageProvider.delete).toHaveBeenCalledWith(
      'tenant-1/project-1/session-1/att-001/thumb',
    );
  });

  // ---------------------------------------------------------------------------
  // 9. Skips optional storage keys when null
  // ---------------------------------------------------------------------------

  it('skips resized and thumbnail storage keys when they are null', async () => {
    const attachment = makeAttachmentDoc({
      resizedStorageKey: null,
      thumbnailStorageKey: null,
    });
    mockFindOne.mockResolvedValue(attachment);

    const processor = createCleanupWorker({ storageProvider, searchProducer, onCleanupComplete });
    await processor(makeJob({ attachmentId: 'att-001', tenantId: 'tenant-1', reason: 'expired' }));

    // Should only delete the original key (1 call)
    expect(storageProvider.delete).toHaveBeenCalledTimes(1);
    expect(storageProvider.delete).toHaveBeenCalledWith(
      'tenant-1/project-1/session-1/att-001/original',
    );
  });

  // ---------------------------------------------------------------------------
  // 10. Calls onCleanupComplete with correct storageKeysDeleted count
  // ---------------------------------------------------------------------------

  it('reports storageKeysDeleted = 1 when only original key exists', async () => {
    const attachment = makeAttachmentDoc({
      resizedStorageKey: null,
      thumbnailStorageKey: null,
    });
    mockFindOne.mockResolvedValue(attachment);

    const processor = createCleanupWorker({ storageProvider, searchProducer, onCleanupComplete });
    await processor(makeJob({ attachmentId: 'att-001', tenantId: 'tenant-1', reason: 'expired' }));

    expect(onCleanupComplete).toHaveBeenCalledWith(
      expect.objectContaining({ storageKeysDeleted: 1 }),
    );
  });

  it('reports storageKeysDeleted = 3 when all storage keys exist', async () => {
    const attachment = makeAttachmentDoc({
      resizedStorageKey: 'tenant-1/project-1/session-1/att-001/resized',
      thumbnailStorageKey: 'tenant-1/project-1/session-1/att-001/thumb',
    });
    mockFindOne.mockResolvedValue(attachment);

    const processor = createCleanupWorker({ storageProvider, searchProducer, onCleanupComplete });
    await processor(makeJob({ attachmentId: 'att-001', tenantId: 'tenant-1', reason: 'expired' }));

    expect(onCleanupComplete).toHaveBeenCalledWith(
      expect.objectContaining({ storageKeysDeleted: 3 }),
    );
  });

  it('reports storageKeysDeleted = 2 when resized key exists but thumbnail does not', async () => {
    const attachment = makeAttachmentDoc({
      resizedStorageKey: 'tenant-1/project-1/session-1/att-001/resized',
      thumbnailStorageKey: null,
    });
    mockFindOne.mockResolvedValue(attachment);

    const processor = createCleanupWorker({ storageProvider, searchProducer, onCleanupComplete });
    await processor(makeJob({ attachmentId: 'att-001', tenantId: 'tenant-1', reason: 'expired' }));

    expect(onCleanupComplete).toHaveBeenCalledWith(
      expect.objectContaining({ storageKeysDeleted: 2 }),
    );
  });

  // ---------------------------------------------------------------------------
  // 11. Calls onCleanupComplete with correct event data
  // ---------------------------------------------------------------------------

  it('calls onCleanupComplete with correct event data', async () => {
    const attachment = makeAttachmentDoc({
      sessionId: 'session-42',
      resizedStorageKey: 'some/resized/key',
    });
    mockFindOne.mockResolvedValue(attachment);

    const processor = createCleanupWorker({ storageProvider, searchProducer, onCleanupComplete });
    await processor(
      makeJob({ attachmentId: 'att-001', tenantId: 'tenant-1', reason: 'gdpr_erasure' }),
    );

    expect(onCleanupComplete).toHaveBeenCalledWith({
      attachmentId: 'att-001',
      tenantId: 'tenant-1',
      sessionId: 'session-42',
      reason: 'gdpr_erasure',
      storageKeysDeleted: 2,
    });
  });

  // ---------------------------------------------------------------------------
  // 12. Does NOT call onCleanupComplete when callback not provided
  // ---------------------------------------------------------------------------

  it('does not call onCleanupComplete when callback is not provided', async () => {
    const attachment = makeAttachmentDoc();
    mockFindOne.mockResolvedValue(attachment);

    // Create worker WITHOUT onCleanupComplete
    const processor = createCleanupWorker({ storageProvider, searchProducer });
    await processor(makeJob({ attachmentId: 'att-001', tenantId: 'tenant-1', reason: 'expired' }));

    // Should not throw and should complete successfully
    // Verify the rest of the pipeline still runs
    expect(storageProvider.delete).toHaveBeenCalled();
    expect(mockDeleteOne).toHaveBeenCalled();
  });

  // ---------------------------------------------------------------------------
  // 13. Deletes DB record with tenant-scoped query
  // ---------------------------------------------------------------------------

  it('deletes DB record with tenant-scoped query (_id AND tenantId)', async () => {
    const attachment = makeAttachmentDoc();
    mockFindOne.mockResolvedValue(attachment);

    const processor = createCleanupWorker({ storageProvider, searchProducer, onCleanupComplete });
    await processor(makeJob({ attachmentId: 'att-001', tenantId: 'tenant-1', reason: 'expired' }));

    expect(mockDeleteOne).toHaveBeenCalledWith({ _id: 'att-001', tenantId: 'tenant-1' });
  });

  // ---------------------------------------------------------------------------
  // 14. Continues processing when search cleanup fails
  // ---------------------------------------------------------------------------

  it('continues processing when search cleanup fails', async () => {
    const attachment = makeAttachmentDoc({ searchIndexId: 'idx-100', searchDocumentId: 'doc-200' });
    mockFindOne.mockResolvedValue(attachment);
    (searchProducer.remove as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error('Search service unavailable'),
    );

    const processor = createCleanupWorker({ storageProvider, searchProducer, onCleanupComplete });
    await processor(makeJob({ attachmentId: 'att-001', tenantId: 'tenant-1', reason: 'expired' }));

    // Storage cleanup should still happen
    expect(storageProvider.delete).toHaveBeenCalledWith(
      'tenant-1/project-1/session-1/att-001/original',
    );

    // Cleanup event should still fire
    expect(onCleanupComplete).toHaveBeenCalled();

    // DB record should still be deleted
    expect(mockDeleteOne).toHaveBeenCalledWith({ _id: 'att-001', tenantId: 'tenant-1' });
  });

  // ---------------------------------------------------------------------------
  // 15. Continues processing when storage cleanup fails
  // ---------------------------------------------------------------------------

  it('continues processing when storage cleanup fails', async () => {
    const attachment = makeAttachmentDoc({
      resizedStorageKey: 'tenant-1/project-1/session-1/att-001/resized',
    });
    mockFindOne.mockResolvedValue(attachment);
    (storageProvider.delete as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error('S3 delete failed'),
    );

    const processor = createCleanupWorker({ storageProvider, searchProducer, onCleanupComplete });
    await processor(makeJob({ attachmentId: 'att-001', tenantId: 'tenant-1', reason: 'expired' }));

    // Cleanup event should still fire
    expect(onCleanupComplete).toHaveBeenCalled();

    // DB record should still be deleted
    expect(mockDeleteOne).toHaveBeenCalledWith({ _id: 'att-001', tenantId: 'tenant-1' });
  });
});
