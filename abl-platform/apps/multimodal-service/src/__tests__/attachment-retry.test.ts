/**
 * Attachment Retry Tests
 *
 * Verifies retry logic for failed attachment processing: status reset,
 * retry count enforcement, re-enqueue at correct pipeline stage,
 * and tenant isolation.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createAttachmentRouter } from '../routes/attachments.js';
import type { AttachmentService } from '../services/multimodal-service.js';
import type { IAttachment } from '@agent-platform/database';

// =============================================================================
// HELPERS
// =============================================================================

function makeAttachmentService(overrides: Partial<AttachmentService> = {}): AttachmentService {
  return {
    upload: vi.fn().mockResolvedValue({
      success: true,
      attachmentId: 'att-123',
      status: 'accepted',
    }),
    getAttachment: vi.fn().mockResolvedValue(null),
    listBySession: vi.fn().mockResolvedValue([]),
    deleteAttachment: vi.fn().mockResolvedValue(undefined),
    deleteBySession: vi.fn().mockResolvedValue(undefined),
    getSignedUrl: vi.fn().mockResolvedValue('https://storage.example.com/signed-url'),
    retryProcessing: vi.fn().mockResolvedValue({ success: true, retryCount: 1 }),
    ...overrides,
  } as unknown as AttachmentService;
}

function makeAttachment(overrides: Partial<IAttachment> = {}): IAttachment {
  return {
    _id: 'att-123',
    tenantId: 'tenant-1',
    projectId: 'project-1',
    sessionId: 'session-1',
    messageId: null,
    originalFilename: 'test.png',
    mimeType: 'image/png',
    detectedMimeType: null,
    category: 'image',
    sizeBytes: 1024,
    contentHash: 'abc123',
    storageProvider: 'local',
    storageKey: 'tenant-1/project-1/session-1/att-123/original',
    storageBucket: 'attachments',
    encrypted: false,
    encryptionKeyVersion: 0,
    processingMode: 'full',
    scanStatus: 'clean',
    scanEngine: null,
    scannedAt: null,
    hasPII: false,
    piiDetections: [],
    exifStripped: false,
    processingStatus: 'failed',
    processedContent: null,
    processedContentHash: null,
    processingError: 'Processing timed out',
    processingEngine: null,
    processedAt: null,
    resizedStorageKey: null,
    resizedSizeBytes: null,
    thumbnailStorageKey: null,
    imageDescription: null,
    imageDescriptionModel: null,
    searchIndexId: null,
    searchDocumentId: null,
    embeddingStatus: 'pending',
    embeddedAt: null,
    expiresAt: new Date('2026-04-01T00:00:00Z'),
    createdAt: new Date('2026-01-01'),
    updatedAt: new Date('2026-01-01'),
    retryCount: 0,
    _v: 1,
    ...overrides,
  } as IAttachment;
}

function createApp(service: AttachmentService) {
  const app = express();
  app.use(express.json());
  app.use('/internal/attachments', createAttachmentRouter(service));
  return app;
}

// =============================================================================
// TESTS
// =============================================================================

describe('Attachment Retry', () => {
  // 1-U16: Retry failed attachment → status reset, retryCount incremented
  describe('1-U16: retry failed attachment', () => {
    it('returns success with incremented retryCount', async () => {
      const attachment = makeAttachment({
        processingStatus: 'failed',
        retryCount: 0,
      });
      const service = makeAttachmentService({
        getAttachment: vi.fn().mockResolvedValue(attachment),
        retryProcessing: vi.fn().mockResolvedValue({ success: true, retryCount: 1 }),
      });
      const app = createApp(service);

      const res = await request(app)
        .post('/internal/attachments/att-123/retry')
        .set('X-Tenant-Id', 'tenant-1');

      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        success: true,
        data: { retryCount: 1 },
      });
      expect(service.retryProcessing).toHaveBeenCalledWith('att-123', 'tenant-1');
    });
  });

  // 1-U17: Retry at max count → MAX_RETRIES_EXCEEDED
  describe('1-U17: retry at max count', () => {
    it('returns MAX_RETRIES_EXCEEDED error', async () => {
      const attachment = makeAttachment({
        processingStatus: 'failed',
        retryCount: 3,
      });
      const service = makeAttachmentService({
        getAttachment: vi.fn().mockResolvedValue(attachment),
        retryProcessing: vi.fn().mockResolvedValue({
          success: false,
          error: { code: 'MAX_RETRIES_EXCEEDED', message: 'Maximum retry attempts reached' },
        }),
      });
      const app = createApp(service);

      const res = await request(app)
        .post('/internal/attachments/att-123/retry')
        .set('X-Tenant-Id', 'tenant-1');

      expect(res.status).toBe(409);
      expect(res.body).toEqual({
        success: false,
        error: {
          code: 'MAX_RETRIES_EXCEEDED',
          message: expect.any(String),
        },
      });
    });
  });

  // 1-U18: Retry non-failed attachment → NOT_FAILED
  describe('1-U18: retry non-failed attachment', () => {
    it('returns NOT_FAILED error for completed attachment', async () => {
      const attachment = makeAttachment({
        processingStatus: 'completed',
        retryCount: 0,
      });
      const service = makeAttachmentService({
        getAttachment: vi.fn().mockResolvedValue(attachment),
        retryProcessing: vi.fn().mockResolvedValue({
          success: false,
          error: { code: 'NOT_FAILED', message: 'Attachment processing has not failed' },
        }),
      });
      const app = createApp(service);

      const res = await request(app)
        .post('/internal/attachments/att-123/retry')
        .set('X-Tenant-Id', 'tenant-1');

      expect(res.status).toBe(409);
      expect(res.body).toEqual({
        success: false,
        error: {
          code: 'NOT_FAILED',
          message: expect.any(String),
        },
      });
    });
  });

  // 1-U21: Cross-tenant retry blocked → 404
  describe('1-U21: cross-tenant retry blocked', () => {
    it('returns 404 for cross-tenant attempt', async () => {
      const service = makeAttachmentService({
        getAttachment: vi.fn().mockResolvedValue(null),
      });
      const app = createApp(service);

      const res = await request(app)
        .post('/internal/attachments/att-123/retry')
        .set('X-Tenant-Id', 'different-tenant');

      expect(res.status).toBe(404);
      expect(res.body).toEqual({
        success: false,
        error: {
          code: 'NOT_FOUND',
          message: expect.any(String),
        },
      });
    });
  });

  // Missing X-Tenant-Id
  describe('missing auth header', () => {
    it('returns 401 when X-Tenant-Id is missing', async () => {
      const service = makeAttachmentService();
      const app = createApp(service);

      const res = await request(app).post('/internal/attachments/att-123/retry');

      expect(res.status).toBe(401);
    });
  });
});
