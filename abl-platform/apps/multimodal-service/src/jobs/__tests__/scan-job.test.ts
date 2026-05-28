import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Readable } from 'stream';
import type { Job } from 'bullmq';
import type { StorageProvider, ScanProvider } from '@agent-platform/shared';
import type { ScanJobData } from '../queues.js';

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
// HELPERS
// =============================================================================

function makeStorageProvider(overrides?: Partial<StorageProvider>): StorageProvider {
  return {
    name: 'test-storage',
    upload: vi.fn(),
    download: vi.fn().mockResolvedValue({
      body: Readable.from([Buffer.from('file-content')]),
      contentType: 'image/png',
      sizeBytes: 12,
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

function makeScanProvider(overrides?: Partial<ScanProvider>): ScanProvider {
  return {
    name: 'test-scanner',
    scan: vi.fn().mockResolvedValue({
      status: 'clean',
      engine: 'test-scanner',
      scannedAt: new Date('2026-01-15T00:00:00Z'),
    }),
    healthCheck: vi.fn(),
    ...overrides,
  };
}

function makeValidateQueue() {
  return { add: vi.fn().mockResolvedValue(undefined) };
}

function makeJob(data: ScanJobData): Job<ScanJobData> {
  return { data } as Job<ScanJobData>;
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
    scanStatus: 'pending',
    ...overrides,
  };
}

// =============================================================================
// TESTS
// =============================================================================

describe('createScanWorker', () => {
  let storageProvider: ReturnType<typeof makeStorageProvider>;
  let scanProvider: ReturnType<typeof makeScanProvider>;
  let validateQueue: ReturnType<typeof makeValidateQueue>;
  let createScanWorker: typeof import('../scan-job.js').createScanWorker;

  beforeEach(async () => {
    vi.clearAllMocks();

    mockFindOne.mockResolvedValue(null);
    mockFindOneAndUpdate.mockResolvedValue(null);

    storageProvider = makeStorageProvider();
    scanProvider = makeScanProvider();
    validateQueue = makeValidateQueue();

    const mod = await import('../scan-job.js');
    createScanWorker = mod.createScanWorker;
  });

  // ---------------------------------------------------------------------------
  // Clean file: updates scanStatus to 'clean', enqueues validate job
  // ---------------------------------------------------------------------------

  it('updates scanStatus to clean and enqueues validate job for clean files', async () => {
    const attachment = makeAttachmentDoc();
    mockFindOne.mockResolvedValue(attachment);
    (scanProvider.scan as ReturnType<typeof vi.fn>).mockResolvedValue({
      status: 'clean',
      engine: 'test-scanner',
      scannedAt: new Date('2026-01-15T00:00:00Z'),
    });

    const processor = createScanWorker({ storageProvider, scanProvider, validateQueue });
    await processor(makeJob({ attachmentId: 'att-001', tenantId: 'tenant-1' }));

    // Should look up attachment with tenant-scoped query
    expect(mockFindOne).toHaveBeenCalledWith({ _id: 'att-001', tenantId: 'tenant-1' });

    // Should download from storage using the attachment's storageKey
    expect(storageProvider.download).toHaveBeenCalledWith(
      'tenant-1/project-1/session-1/att-001/original',
    );

    // Should scan the file
    expect(scanProvider.scan).toHaveBeenCalledWith({
      fileStream: expect.anything(),
      filename: 'photo.png',
      sizeBytes: 12,
    });

    // Should update scanStatus to 'clean'
    expect(mockFindOneAndUpdate).toHaveBeenCalledWith(
      { _id: 'att-001', tenantId: 'tenant-1' },
      {
        $set: {
          scanStatus: 'clean',
          scanEngine: 'test-scanner',
          scannedAt: new Date('2026-01-15T00:00:00Z'),
        },
      },
    );

    // Should enqueue validate job
    expect(validateQueue.add).toHaveBeenCalledWith('attachment-validate', {
      attachmentId: 'att-001',
      tenantId: 'tenant-1',
    });
  });

  // ---------------------------------------------------------------------------
  // Infected file: updates scanStatus to 'infected', does NOT enqueue next job
  // ---------------------------------------------------------------------------

  it('updates scanStatus to infected and stops pipeline for infected files', async () => {
    const attachment = makeAttachmentDoc();
    mockFindOne.mockResolvedValue(attachment);
    (scanProvider.scan as ReturnType<typeof vi.fn>).mockResolvedValue({
      status: 'infected',
      engine: 'test-scanner',
      threats: ['Eicar-Test-Signature'],
      scannedAt: new Date('2026-01-15T00:00:00Z'),
    });

    const processor = createScanWorker({ storageProvider, scanProvider, validateQueue });
    await processor(makeJob({ attachmentId: 'att-001', tenantId: 'tenant-1' }));

    // Should update scanStatus to 'infected'
    expect(mockFindOneAndUpdate).toHaveBeenCalledWith(
      { _id: 'att-001', tenantId: 'tenant-1' },
      {
        $set: {
          scanStatus: 'infected',
          scanEngine: 'test-scanner',
          scannedAt: new Date('2026-01-15T00:00:00Z'),
        },
      },
    );

    // Should NOT enqueue validate job
    expect(validateQueue.add).not.toHaveBeenCalled();
  });

  // ---------------------------------------------------------------------------
  // Scanner error: updates scanStatus to 'error'
  // ---------------------------------------------------------------------------

  it('updates scanStatus to error when scanner returns error status', async () => {
    const attachment = makeAttachmentDoc();
    mockFindOne.mockResolvedValue(attachment);
    (scanProvider.scan as ReturnType<typeof vi.fn>).mockResolvedValue({
      status: 'error',
      engine: 'test-scanner',
      scannedAt: new Date('2026-01-15T00:00:00Z'),
    });

    const processor = createScanWorker({ storageProvider, scanProvider, validateQueue });
    await processor(makeJob({ attachmentId: 'att-001', tenantId: 'tenant-1' }));

    // Should update scanStatus to 'error'
    expect(mockFindOneAndUpdate).toHaveBeenCalledWith(
      { _id: 'att-001', tenantId: 'tenant-1' },
      {
        $set: {
          scanStatus: 'error',
          scanEngine: 'test-scanner',
          scannedAt: new Date('2026-01-15T00:00:00Z'),
        },
      },
    );

    // Should NOT enqueue validate job
    expect(validateQueue.add).not.toHaveBeenCalled();
  });

  // ---------------------------------------------------------------------------
  // Scanner throws: updates scanStatus to 'error'
  // ---------------------------------------------------------------------------

  it('updates scanStatus to error when scanner throws an exception', async () => {
    const attachment = makeAttachmentDoc();
    mockFindOne.mockResolvedValue(attachment);
    (scanProvider.scan as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error('ClamAV daemon unreachable'),
    );

    const processor = createScanWorker({ storageProvider, scanProvider, validateQueue });
    await processor(makeJob({ attachmentId: 'att-001', tenantId: 'tenant-1' }));

    // Should update scanStatus to 'error' via the catch block
    expect(mockFindOneAndUpdate).toHaveBeenCalledWith(
      { _id: 'att-001', tenantId: 'tenant-1' },
      {
        $set: {
          scanStatus: 'error',
          scanEngine: 'test-scanner',
          scannedAt: expect.any(Date),
        },
      },
    );

    // Should NOT enqueue validate job
    expect(validateQueue.add).not.toHaveBeenCalled();
  });

  // ---------------------------------------------------------------------------
  // Download error: updates scanStatus to 'error'
  // ---------------------------------------------------------------------------

  it('updates scanStatus to error when download fails', async () => {
    const attachment = makeAttachmentDoc();
    mockFindOne.mockResolvedValue(attachment);
    (storageProvider.download as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error('S3 download failed'),
    );

    const processor = createScanWorker({ storageProvider, scanProvider, validateQueue });
    await processor(makeJob({ attachmentId: 'att-001', tenantId: 'tenant-1' }));

    // Should update scanStatus to 'error' via the catch block
    expect(mockFindOneAndUpdate).toHaveBeenCalledWith(
      { _id: 'att-001', tenantId: 'tenant-1' },
      {
        $set: {
          scanStatus: 'error',
          scanEngine: 'test-scanner',
          scannedAt: expect.any(Date),
        },
      },
    );

    // Should NOT enqueue validate job
    expect(validateQueue.add).not.toHaveBeenCalled();
  });

  // ---------------------------------------------------------------------------
  // Attachment not found: handles gracefully
  // ---------------------------------------------------------------------------

  it('handles attachment not found gracefully without throwing', async () => {
    mockFindOne.mockResolvedValue(null);

    const processor = createScanWorker({ storageProvider, scanProvider, validateQueue });
    await processor(makeJob({ attachmentId: 'att-999', tenantId: 'tenant-1' }));

    // Should not attempt download, scan, or update
    expect(storageProvider.download).not.toHaveBeenCalled();
    expect(scanProvider.scan).not.toHaveBeenCalled();
    expect(mockFindOneAndUpdate).not.toHaveBeenCalled();
    expect(validateQueue.add).not.toHaveBeenCalled();
  });

  // ---------------------------------------------------------------------------
  // Tenant isolation: uses tenant-scoped queries
  // ---------------------------------------------------------------------------

  it('uses tenant-scoped queries for all DB operations', async () => {
    const attachment = makeAttachmentDoc({ tenantId: 'tenant-2' });
    mockFindOne.mockResolvedValue(attachment);
    (scanProvider.scan as ReturnType<typeof vi.fn>).mockResolvedValue({
      status: 'clean',
      engine: 'test-scanner',
      scannedAt: new Date('2026-01-15T00:00:00Z'),
    });

    const processor = createScanWorker({ storageProvider, scanProvider, validateQueue });
    await processor(makeJob({ attachmentId: 'att-001', tenantId: 'tenant-2' }));

    // findOne includes tenantId
    expect(mockFindOne).toHaveBeenCalledWith({ _id: 'att-001', tenantId: 'tenant-2' });

    // findOneAndUpdate includes tenantId
    expect(mockFindOneAndUpdate).toHaveBeenCalledWith(
      { _id: 'att-001', tenantId: 'tenant-2' },
      expect.any(Object),
    );

    // Enqueued job carries tenantId
    expect(validateQueue.add).toHaveBeenCalledWith('attachment-validate', {
      attachmentId: 'att-001',
      tenantId: 'tenant-2',
    });
  });
});
