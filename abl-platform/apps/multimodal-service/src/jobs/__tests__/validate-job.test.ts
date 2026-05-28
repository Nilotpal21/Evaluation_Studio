import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Readable } from 'stream';
import type { Job } from 'bullmq';
import type { StorageProvider } from '@agent-platform/shared';
import type { ValidateJobData } from '../queues.js';

// =============================================================================
// MOCK: Mongoose Attachment model
// =============================================================================

const mockFindOne = vi.fn();
const mockFindOneAndUpdate = vi.fn();

vi.mock('@agent-platform/database', () => ({
  Attachment: {
    findOne: (...args: unknown[]) => {
      const result = mockFindOne(...args);
      return { lean: () => result };
    },
    findOneAndUpdate: mockFindOneAndUpdate,
  },
}));

// =============================================================================
// MOCK: mime-validator
// =============================================================================

const mockValidateMime = vi.fn();
const mockMimeToCategory = vi.fn();

vi.mock('../../security/mime-validator.js', () => ({
  validateMime: (...args: unknown[]) => mockValidateMime(...args),
  mimeToCategory: (...args: unknown[]) => mockMimeToCategory(...args),
}));

// =============================================================================
// HELPERS
// =============================================================================

function makeStorageProvider(overrides?: Partial<StorageProvider>): StorageProvider {
  return {
    name: 'test-storage',
    upload: vi.fn(),
    download: vi.fn().mockResolvedValue({
      body: Readable.from([Buffer.from('PNG-magic-bytes-plus-extra-data')]),
      contentType: 'image/png',
      sizeBytes: 30,
    }),
    getSignedUrl: vi.fn(),
    delete: vi.fn(),
    deleteMany: vi.fn(),
    exists: vi.fn(),
    copy: vi.fn(),
    healthCheck: vi.fn(),
    ...overrides,
  };
}

function makeProcessQueue() {
  return { add: vi.fn().mockResolvedValue(undefined) };
}

function makeJob(data: ValidateJobData): Job<ValidateJobData> {
  return { data } as Job<ValidateJobData>;
}

function makeAttachmentDoc(overrides?: Record<string, unknown>) {
  return {
    _id: 'att-001',
    tenantId: 'tenant-1',
    originalFilename: 'photo.png',
    mimeType: 'image/png',
    category: 'image',
    sizeBytes: 1024,
    storageKey: 'tenant-1/project-1/session-1/att-001/original',
    scanStatus: 'clean',
    ...overrides,
  };
}

// =============================================================================
// TESTS
// =============================================================================

describe('createValidateWorker', () => {
  let storageProvider: ReturnType<typeof makeStorageProvider>;
  let processQueue: ReturnType<typeof makeProcessQueue>;
  let createValidateWorker: typeof import('../validate-job.js').createValidateWorker;

  beforeEach(async () => {
    vi.clearAllMocks();

    mockFindOne.mockResolvedValue(null);
    mockFindOneAndUpdate.mockResolvedValue(null);
    mockValidateMime.mockResolvedValue({ valid: true, detectedMimeType: 'image/png' });
    mockMimeToCategory.mockReturnValue('image');

    storageProvider = makeStorageProvider();
    processQueue = makeProcessQueue();

    const mod = await import('../validate-job.js');
    createValidateWorker = mod.createValidateWorker;
  });

  // ---------------------------------------------------------------------------
  // Valid MIME: updates detectedMimeType, enqueues process job
  // ---------------------------------------------------------------------------

  it('updates detectedMimeType and enqueues process job for valid MIME', async () => {
    const attachment = makeAttachmentDoc();
    mockFindOne.mockResolvedValue(attachment);
    mockValidateMime.mockResolvedValue({ valid: true, detectedMimeType: 'image/png' });
    mockMimeToCategory.mockReturnValue('image');

    const processor = createValidateWorker({ storageProvider, processQueue });
    await processor(makeJob({ attachmentId: 'att-001', tenantId: 'tenant-1' }));

    // Should look up attachment with tenant-scoped query
    expect(mockFindOne).toHaveBeenCalledWith({ _id: 'att-001', tenantId: 'tenant-1' });

    // Should download from storage
    expect(storageProvider.download).toHaveBeenCalledWith(
      'tenant-1/project-1/session-1/att-001/original',
    );

    // Should validate MIME with the buffer and declared type
    expect(mockValidateMime).toHaveBeenCalledWith(expect.any(Buffer), 'image/png');

    // Should update detectedMimeType
    expect(mockFindOneAndUpdate).toHaveBeenCalledWith(
      { _id: 'att-001', tenantId: 'tenant-1' },
      {
        $set: {
          detectedMimeType: 'image/png',
        },
      },
    );

    // Should enqueue process job with category
    expect(processQueue.add).toHaveBeenCalledWith('attachment-process', {
      attachmentId: 'att-001',
      tenantId: 'tenant-1',
      category: 'image',
    });
  });

  // ---------------------------------------------------------------------------
  // Valid MIME with different detected type (same category)
  // ---------------------------------------------------------------------------

  it('enqueues process job with detected category when MIME is valid', async () => {
    const attachment = makeAttachmentDoc({ mimeType: 'image/jpeg' });
    mockFindOne.mockResolvedValue(attachment);
    mockValidateMime.mockResolvedValue({ valid: true, detectedMimeType: 'image/webp' });
    mockMimeToCategory.mockReturnValue('image');

    const processor = createValidateWorker({ storageProvider, processQueue });
    await processor(makeJob({ attachmentId: 'att-001', tenantId: 'tenant-1' }));

    // Should update with detected MIME
    expect(mockFindOneAndUpdate).toHaveBeenCalledWith(
      { _id: 'att-001', tenantId: 'tenant-1' },
      {
        $set: {
          detectedMimeType: 'image/webp',
        },
      },
    );

    // Should enqueue with the detected category
    expect(processQueue.add).toHaveBeenCalledWith('attachment-process', {
      attachmentId: 'att-001',
      tenantId: 'tenant-1',
      category: 'image',
    });
  });

  // ---------------------------------------------------------------------------
  // Invalid MIME: marks failed, does NOT enqueue process job
  // ---------------------------------------------------------------------------

  it('marks processing as failed and stops pipeline for invalid MIME', async () => {
    const attachment = makeAttachmentDoc({ mimeType: 'image/png' });
    mockFindOne.mockResolvedValue(attachment);
    mockValidateMime.mockResolvedValue({
      valid: false,
      detectedMimeType: 'application/x-executable',
    });

    const processor = createValidateWorker({ storageProvider, processQueue });
    await processor(makeJob({ attachmentId: 'att-001', tenantId: 'tenant-1' }));

    // Should update detectedMimeType
    expect(mockFindOneAndUpdate).toHaveBeenCalledWith(
      { _id: 'att-001', tenantId: 'tenant-1' },
      {
        $set: {
          detectedMimeType: 'application/x-executable',
        },
      },
    );

    // Should mark processing as failed with mismatch reason
    expect(mockFindOneAndUpdate).toHaveBeenCalledWith(
      { _id: 'att-001', tenantId: 'tenant-1' },
      {
        $set: {
          processingStatus: 'failed',
          processingError: 'MIME mismatch: declared image/png, detected application/x-executable',
        },
      },
    );

    // Should NOT enqueue process job
    expect(processQueue.add).not.toHaveBeenCalled();
  });

  // ---------------------------------------------------------------------------
  // Unknown MIME: marks failed
  // ---------------------------------------------------------------------------

  it('marks processing as failed when detected MIME is unknown', async () => {
    const attachment = makeAttachmentDoc({ mimeType: 'image/png' });
    mockFindOne.mockResolvedValue(attachment);
    mockValidateMime.mockResolvedValue({ valid: false, detectedMimeType: 'unknown' });

    const processor = createValidateWorker({ storageProvider, processQueue });
    await processor(makeJob({ attachmentId: 'att-001', tenantId: 'tenant-1' }));

    // Should mark processing as failed
    expect(mockFindOneAndUpdate).toHaveBeenCalledWith(
      { _id: 'att-001', tenantId: 'tenant-1' },
      {
        $set: {
          processingStatus: 'failed',
          processingError: 'MIME mismatch: declared image/png, detected unknown',
        },
      },
    );

    // Should NOT enqueue process job
    expect(processQueue.add).not.toHaveBeenCalled();
  });

  // ---------------------------------------------------------------------------
  // Attachment not found: handles gracefully
  // ---------------------------------------------------------------------------

  it('handles attachment not found gracefully without throwing', async () => {
    mockFindOne.mockResolvedValue(null);

    const processor = createValidateWorker({ storageProvider, processQueue });
    await processor(makeJob({ attachmentId: 'att-999', tenantId: 'tenant-1' }));

    // Should not attempt download, validate, or update
    expect(storageProvider.download).not.toHaveBeenCalled();
    expect(mockValidateMime).not.toHaveBeenCalled();
    expect(mockFindOneAndUpdate).not.toHaveBeenCalled();
    expect(processQueue.add).not.toHaveBeenCalled();
  });

  // ---------------------------------------------------------------------------
  // Download error: marks failed
  // ---------------------------------------------------------------------------

  it('marks processing as failed when download throws', async () => {
    const attachment = makeAttachmentDoc();
    mockFindOne.mockResolvedValue(attachment);
    (storageProvider.download as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error('S3 download failed'),
    );

    const processor = createValidateWorker({ storageProvider, processQueue });
    await processor(makeJob({ attachmentId: 'att-001', tenantId: 'tenant-1' }));

    // Should mark processing as failed
    expect(mockFindOneAndUpdate).toHaveBeenCalledWith(
      { _id: 'att-001', tenantId: 'tenant-1' },
      {
        $set: {
          processingStatus: 'failed',
          processingError: 'S3 download failed',
        },
      },
    );

    // Should NOT enqueue process job
    expect(processQueue.add).not.toHaveBeenCalled();
  });

  // ---------------------------------------------------------------------------
  // validateMime throws: marks failed
  // ---------------------------------------------------------------------------

  it('marks processing as failed when validateMime throws', async () => {
    const attachment = makeAttachmentDoc();
    mockFindOne.mockResolvedValue(attachment);
    mockValidateMime.mockRejectedValue(new Error('file-type detection failed'));

    const processor = createValidateWorker({ storageProvider, processQueue });
    await processor(makeJob({ attachmentId: 'att-001', tenantId: 'tenant-1' }));

    // Should mark processing as failed
    expect(mockFindOneAndUpdate).toHaveBeenCalledWith(
      { _id: 'att-001', tenantId: 'tenant-1' },
      {
        $set: {
          processingStatus: 'failed',
          processingError: 'file-type detection failed',
        },
      },
    );

    // Should NOT enqueue process job
    expect(processQueue.add).not.toHaveBeenCalled();
  });

  // ---------------------------------------------------------------------------
  // Tenant isolation: uses tenant-scoped queries
  // ---------------------------------------------------------------------------

  it('uses tenant-scoped queries for all DB operations', async () => {
    const attachment = makeAttachmentDoc({ tenantId: 'tenant-3' });
    mockFindOne.mockResolvedValue(attachment);
    mockValidateMime.mockResolvedValue({ valid: true, detectedMimeType: 'image/png' });
    mockMimeToCategory.mockReturnValue('image');

    const processor = createValidateWorker({ storageProvider, processQueue });
    await processor(makeJob({ attachmentId: 'att-001', tenantId: 'tenant-3' }));

    // findOne includes tenantId
    expect(mockFindOne).toHaveBeenCalledWith({ _id: 'att-001', tenantId: 'tenant-3' });

    // findOneAndUpdate includes tenantId
    expect(mockFindOneAndUpdate).toHaveBeenCalledWith(
      { _id: 'att-001', tenantId: 'tenant-3' },
      expect.any(Object),
    );

    // Enqueued job carries tenantId
    expect(processQueue.add).toHaveBeenCalledWith('attachment-process', {
      attachmentId: 'att-001',
      tenantId: 'tenant-3',
      category: 'image',
    });
  });

  // ---------------------------------------------------------------------------
  // Falls back to attachment category when mimeToCategory returns null
  // ---------------------------------------------------------------------------

  it('falls back to attachment category when mimeToCategory returns null', async () => {
    const attachment = makeAttachmentDoc({ category: 'document' });
    mockFindOne.mockResolvedValue(attachment);
    mockValidateMime.mockResolvedValue({
      valid: true,
      detectedMimeType: 'application/octet-stream',
    });
    mockMimeToCategory.mockReturnValue(null);

    const processor = createValidateWorker({ storageProvider, processQueue });
    await processor(makeJob({ attachmentId: 'att-001', tenantId: 'tenant-1' }));

    // Should enqueue with the fallback category from the attachment record
    expect(processQueue.add).toHaveBeenCalledWith('attachment-process', {
      attachmentId: 'att-001',
      tenantId: 'tenant-1',
      category: 'document',
    });
  });
});
