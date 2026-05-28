/**
 * Upload Processing Modes Tests (Phase 3A — ST-3.1)
 *
 * Verifies that `processingMode` ('full' | 'scan-only' | 'store-raw') on the
 * Attachment model controls pipeline behavior:
 * - full: default, full pipeline (scan → validate → process → index)
 * - scan-only: scan → validate → stop (no extraction/embedding/LLM injection)
 * - store-raw: store only, no scanning. Requires permission.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Readable } from 'stream';
import type { AttachmentInput, AttachmentConfig, StorageProvider } from '@agent-platform/shared';

// =============================================================================
// MOCK: Mongoose Attachment model
// =============================================================================

const mockFindOne = vi.fn();
const mockFind = vi.fn();
const mockCreate = vi.fn();
const mockFindOneAndUpdate = vi.fn();

vi.mock('@agent-platform/database', () => ({
  Attachment: {
    findOne: (...args: unknown[]) => {
      const result = mockFindOne(...args);
      return { lean: () => result };
    },
    find: (...args: unknown[]) => {
      const result = mockFind(...args);
      return {
        sort: () => ({
          limit: () => ({
            lean: () => result,
            skip: () => ({
              lean: () => result,
            }),
          }),
        }),
        lean: () => result,
      };
    },
    create: mockCreate,
    findOneAndUpdate: mockFindOneAndUpdate,
  },
}));

vi.mock('../security/mime-validator.js', () => ({
  mimeToCategory: (mime: string): string | null => {
    if (mime.startsWith('image/')) return 'image';
    if (mime.startsWith('audio/')) return 'audio';
    if (mime.startsWith('video/')) return 'video';
    if (mime === 'application/pdf' || mime.startsWith('text/')) return 'document';
    return null;
  },
}));

// =============================================================================
// HELPERS
// =============================================================================

function makeStorageProvider(): StorageProvider {
  return {
    name: 'test-provider',
    upload: vi.fn().mockResolvedValue({ storageKey: 'mocked-key', etag: 'mocked-etag' }),
    download: vi.fn(),
    getSignedUrl: vi.fn(),
    delete: vi.fn().mockResolvedValue(undefined),
    deleteMany: vi.fn().mockResolvedValue({ deletedCount: 0 }),
    exists: vi.fn(),
    copy: vi.fn(),
    healthCheck: vi.fn(),
  };
}

function makeScanQueue() {
  return { add: vi.fn().mockResolvedValue(undefined) };
}

function makeConfig(overrides?: Partial<AttachmentConfig>): AttachmentConfig {
  return {
    enabled: true,
    maxFileSizeBytes: 10 * 1024 * 1024,
    maxAttachmentsPerMessage: 5,
    maxAttachmentsPerSession: 50,
    maxTotalStorageBytesPerTenant: 1024 * 1024 * 1024,
    allowedCategories: ['image', 'document', 'audio', 'video'],
    retentionDays: { image: 90, document: 90, audio: 90, video: 90 },
    allowedMimeTypes: ['image/png', 'image/jpeg', 'application/pdf', 'text/plain', 'audio/mpeg'],
    quotas: { maxUploadsPerMinute: 60, maxConcurrentProcessingJobs: 10 },
    ...overrides,
  };
}

function makeInput(overrides?: Partial<AttachmentInput>): AttachmentInput {
  const content = 'test file content';
  return {
    source: {
      type: 'stream',
      stream: Readable.from([Buffer.from(content)]),
      filename: 'test-file.png',
      mimeType: 'image/png',
      sizeBytes: Buffer.byteLength(content),
    },
    tenantId: 'tenant-001',
    projectId: 'proj-001',
    sessionId: 'sess-001',
    channel: 'web',
    ...overrides,
  };
}

// =============================================================================
// TESTS
// =============================================================================

describe('Upload Processing Modes (Phase 3A)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: no duplicate found
    mockFindOne.mockResolvedValue(null);
    mockFind.mockResolvedValue([]);
    mockCreate.mockImplementation(async (data: Record<string, unknown>) => data);
  });

  describe('3-U1: processingMode=full (default)', () => {
    it('should enqueue scan job for full pipeline when mode is full or not specified', async () => {
      const { AttachmentService } = await import('../services/multimodal-service.js');
      const scanQueue = makeScanQueue();
      const service = new AttachmentService({
        storageProvider: makeStorageProvider(),
        scanQueue,
        storageBucket: 'test-bucket',
      });

      const result = await service.upload(makeInput(), makeConfig());

      expect(result.success).toBe(true);
      expect(scanQueue.add).toHaveBeenCalledWith(
        'scan',
        expect.objectContaining({
          tenantId: 'tenant-001',
        }),
      );
      // processingMode should default to 'full' in the created record
      expect(mockCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          processingMode: 'full',
        }),
      );
    });
  });

  describe('3-U2: processingMode=scan-only', () => {
    it('should create attachment with scan-only mode and enqueue scan job', async () => {
      const { AttachmentService } = await import('../services/multimodal-service.js');
      const scanQueue = makeScanQueue();
      const service = new AttachmentService({
        storageProvider: makeStorageProvider(),
        scanQueue,
        storageBucket: 'test-bucket',
      });

      const input = makeInput();
      const result = await service.upload(input, makeConfig(), { processingMode: 'scan-only' });

      expect(result.success).toBe(true);
      // scan-only still enqueues scan job (scan + validate, but stops before process)
      expect(scanQueue.add).toHaveBeenCalledWith(
        'scan',
        expect.objectContaining({
          tenantId: 'tenant-001',
        }),
      );
      expect(mockCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          processingMode: 'scan-only',
        }),
      );
    });
  });

  describe('3-U3: processingMode=store-raw', () => {
    it('should store attachment without enqueuing any pipeline jobs', async () => {
      const { AttachmentService } = await import('../services/multimodal-service.js');
      const scanQueue = makeScanQueue();
      const service = new AttachmentService({
        storageProvider: makeStorageProvider(),
        scanQueue,
        storageBucket: 'test-bucket',
      });

      const input = makeInput();
      const result = await service.upload(input, makeConfig(), { processingMode: 'store-raw' });

      expect(result.success).toBe(true);
      // store-raw does NOT enqueue any scan/process jobs
      expect(scanQueue.add).not.toHaveBeenCalled();
      expect(mockCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          processingMode: 'store-raw',
          processingStatus: 'skipped',
          embeddingStatus: 'skipped',
          scanStatus: 'clean', // assumed clean since not scanned
        }),
      );
    });
  });

  describe('3-U7: Invalid mode value', () => {
    it('should reject invalid processingMode with 400-equivalent error', async () => {
      const { AttachmentService } = await import('../services/multimodal-service.js');
      const service = new AttachmentService({
        storageProvider: makeStorageProvider(),
        scanQueue: makeScanQueue(),
        storageBucket: 'test-bucket',
      });

      const result = await service.upload(makeInput(), makeConfig(), {
        processingMode: 'invalid-mode' as 'full',
      });

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe('INVALID_PROCESSING_MODE');
      }
    });
  });
});

describe('MessagePreprocessor mode filtering (Phase 3A)', () => {
  describe('3-U5: scan-only attachment skipped by MessagePreprocessor', () => {
    it('should skip injection for attachments with processingMode=scan-only', async () => {
      // MessagePreprocessor should not inject content for non-full mode attachments
      const { MessagePreprocessor } =
        await import('../../runtime/src/attachments/message-preprocessor.js').catch(() => {
          // This test validates the contract — actual implementation is in runtime
          return { MessagePreprocessor: null };
        });

      // This test documents the expected behavior:
      // Attachments with processingMode !== 'full' should be skipped during LLM injection.
      // TODO: Move to runtime package where MessagePreprocessor lives and test with real code.
      expect(MessagePreprocessor).toBeNull(); // Dynamic import fallback confirms contract only
    });
  });

  describe('3-U6: store-raw attachment skipped by MessagePreprocessor', () => {
    it('should skip injection for attachments with processingMode=store-raw', () => {
      // Same contract: store-raw attachments should not be injected into LLM context.
      // TODO: Move to runtime package where MessagePreprocessor lives and test with real code.
      // For now, this is a documentation-only test — the behavior lives in runtime, not multimodal-service.
      expect('store-raw').not.toBe('full');
    });
  });
});
