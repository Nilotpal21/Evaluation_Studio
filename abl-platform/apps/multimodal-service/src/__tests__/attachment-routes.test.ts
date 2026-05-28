import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { Readable } from 'stream';
import type { AttachmentConfig } from '@agent-platform/shared';
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
    downloadAttachmentContent: vi.fn().mockResolvedValue(null),
    listBySession: vi.fn().mockResolvedValue([]),
    deleteAttachment: vi.fn().mockResolvedValue(undefined),
    deleteBySession: vi.fn().mockResolvedValue(undefined),
    getSignedUrl: vi.fn().mockResolvedValue('https://storage.example.com/signed-url'),
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
    scanStatus: 'pending',
    scanEngine: null,
    scannedAt: null,
    hasPII: false,
    piiDetections: [],
    exifStripped: false,
    processingStatus: 'pending',
    processedContent: null,
    processedContentHash: null,
    processingError: null,
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
    retryCount: 0,
    expiresAt: new Date('2026-04-01T00:00:00Z'),
    createdAt: new Date('2026-01-01'),
    updatedAt: new Date('2026-01-01'),
    _v: 1,
    ...overrides,
  } as IAttachment;
}

function makeAttachmentConfig(overrides: Partial<AttachmentConfig> = {}): AttachmentConfig {
  return {
    enabled: true,
    maxFileSizeBytes: 5 * 1024 * 1024,
    maxAttachmentsPerMessage: 5,
    maxAttachmentsPerSession: 25,
    maxTotalStorageBytesPerTenant: 1024 * 1024 * 1024,
    allowedCategories: ['image', 'document'],
    retentionDays: { image: 30, document: 45, audio: 60, video: 90 },
    allowedMimeTypes: ['image/png', 'application/pdf'],
    quotas: { maxUploadsPerMinute: 30, maxConcurrentProcessingJobs: 5 },
    ...overrides,
  };
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

describe('Attachment Routes', () => {
  let service: ReturnType<typeof makeAttachmentService>;
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    service = makeAttachmentService();
    app = createApp(service);
  });

  // ===========================================================================
  // AUTH MIDDLEWARE
  // ===========================================================================

  describe('requireInternalAuth', () => {
    it('returns 401 when X-Tenant-Id header is missing', async () => {
      const res = await request(app).get('/internal/attachments/att-123');

      expect(res.status).toBe(401);
      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe('UNAUTHORIZED');
    });

    it('returns 401 when X-Tenant-Id header is empty', async () => {
      const res = await request(app).get('/internal/attachments/att-123').set('X-Tenant-Id', '');

      expect(res.status).toBe(401);
      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe('UNAUTHORIZED');
    });

    it('allows request when X-Tenant-Id is present', async () => {
      // getAttachment returns null -> 404, but not 401
      const res = await request(app)
        .get('/internal/attachments/att-123')
        .set('X-Tenant-Id', 'tenant-1');

      expect(res.status).toBe(404);
      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe('NOT_FOUND');
    });
  });

  // ===========================================================================
  // POST /internal/attachments — Upload
  // ===========================================================================

  describe('POST /internal/attachments', () => {
    it('returns 201 with attachmentId on successful upload', async () => {
      const res = await request(app)
        .post('/internal/attachments')
        .set('X-Tenant-Id', 'tenant-1')
        .set('X-Project-Id', 'project-1')
        .attach('file', Buffer.from('test file content'), {
          filename: 'test.png',
          contentType: 'image/png',
        })
        .field('sessionId', 'session-1')
        .field('channel', 'web');

      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
      expect(res.body.data.attachmentId).toBe('att-123');
      expect(res.body.data.status).toBe('accepted');
    });

    it('passes tenantId to AttachmentService.upload', async () => {
      await request(app)
        .post('/internal/attachments')
        .set('X-Tenant-Id', 'tenant-1')
        .set('X-Project-Id', 'project-1')
        .attach('file', Buffer.from('data'), {
          filename: 'test.png',
          contentType: 'image/png',
        })
        .field('sessionId', 'session-1');

      expect(service.upload).toHaveBeenCalledOnce();
      const [input] = (service.upload as ReturnType<typeof vi.fn>).mock.calls[0]!;
      expect(input.tenantId).toBe('tenant-1');
      expect(input.projectId).toBe('project-1');
      expect(input.sessionId).toBe('session-1');
    });

    it('parses stringified multipart config before calling AttachmentService.upload', async () => {
      const config = makeAttachmentConfig({
        enabled: false,
        maxAttachmentsPerMessage: 2,
      });

      await request(app)
        .post('/internal/attachments')
        .set('X-Tenant-Id', 'tenant-1')
        .set('X-Project-Id', 'project-1')
        .attach('file', Buffer.from('data'), {
          filename: 'test.png',
          contentType: 'image/png',
        })
        .field('sessionId', 'session-1')
        .field('config', JSON.stringify(config));

      expect(service.upload).toHaveBeenCalledOnce();
      const [, parsedConfig] = (service.upload as ReturnType<typeof vi.fn>).mock.calls[0]!;
      expect(parsedConfig).toEqual(config);
    });

    it('returns 400 when no file is attached', async () => {
      const res = await request(app)
        .post('/internal/attachments')
        .set('X-Tenant-Id', 'tenant-1')
        .field('sessionId', 'session-1');

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe('MISSING_FILE');
    });

    it('returns 400 when sessionId is missing', async () => {
      const res = await request(app)
        .post('/internal/attachments')
        .set('X-Tenant-Id', 'tenant-1')
        .attach('file', Buffer.from('data'), {
          filename: 'test.png',
          contentType: 'image/png',
        });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe('MISSING_SESSION_ID');
    });

    it('returns 400 when config is invalid JSON', async () => {
      const res = await request(app)
        .post('/internal/attachments')
        .set('X-Tenant-Id', 'tenant-1')
        .attach('file', Buffer.from('data'), {
          filename: 'test.png',
          contentType: 'image/png',
        })
        .field('sessionId', 'session-1')
        .field('config', '{"enabled":true');

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe('INVALID_CONFIG');
      expect(service.upload).not.toHaveBeenCalled();
    });

    it('returns 400 when AttachmentService rejects upload', async () => {
      service = makeAttachmentService({
        upload: vi.fn().mockResolvedValue({
          success: false,
          error: { code: 'FILE_TOO_LARGE', message: 'File too large' },
        }),
      } as Partial<AttachmentService>);
      app = createApp(service);

      const res = await request(app)
        .post('/internal/attachments')
        .set('X-Tenant-Id', 'tenant-1')
        .attach('file', Buffer.from('data'), {
          filename: 'big.png',
          contentType: 'image/png',
        })
        .field('sessionId', 'session-1');

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe('FILE_TOO_LARGE');
    });

    it('returns 401 without X-Tenant-Id', async () => {
      const res = await request(app)
        .post('/internal/attachments')
        .attach('file', Buffer.from('data'), {
          filename: 'test.png',
          contentType: 'image/png',
        })
        .field('sessionId', 'session-1');

      expect(res.status).toBe(401);
    });

    it('returns 500 when service throws', async () => {
      service = makeAttachmentService({
        upload: vi.fn().mockRejectedValue(new Error('Storage down')),
      } as Partial<AttachmentService>);
      app = createApp(service);

      const res = await request(app)
        .post('/internal/attachments')
        .set('X-Tenant-Id', 'tenant-1')
        .attach('file', Buffer.from('data'), {
          filename: 'test.png',
          contentType: 'image/png',
        })
        .field('sessionId', 'session-1');

      expect(res.status).toBe(500);
      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe('INTERNAL_ERROR');
    });
  });

  // ===========================================================================
  // GET /internal/attachments/:attachmentId — Get metadata
  // ===========================================================================

  describe('GET /internal/attachments/:attachmentId', () => {
    it('returns 200 with attachment metadata', async () => {
      const attachment = makeAttachment();
      service = makeAttachmentService({
        getAttachment: vi.fn().mockResolvedValue(attachment),
      } as Partial<AttachmentService>);
      app = createApp(service);

      const res = await request(app)
        .get('/internal/attachments/att-123')
        .set('X-Tenant-Id', 'tenant-1');

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.attachment._id).toBe('att-123');
      expect(res.body.data.attachment.mimeType).toBe('image/png');
    });

    it('passes tenantId to getAttachment for tenant isolation', async () => {
      await request(app).get('/internal/attachments/att-123').set('X-Tenant-Id', 'tenant-1');

      expect(service.getAttachment).toHaveBeenCalledWith('att-123', 'tenant-1');
    });

    it('returns 404 when attachment not found (tenant-scoped)', async () => {
      const res = await request(app)
        .get('/internal/attachments/att-999')
        .set('X-Tenant-Id', 'tenant-1');

      expect(res.status).toBe(404);
      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe('NOT_FOUND');
    });

    it('returns 404 for cross-tenant access (not 403)', async () => {
      // Service returns null for wrong tenant (query-level tenant isolation)
      service = makeAttachmentService({
        getAttachment: vi.fn().mockResolvedValue(null),
      } as Partial<AttachmentService>);
      app = createApp(service);

      const res = await request(app)
        .get('/internal/attachments/att-123')
        .set('X-Tenant-Id', 'tenant-2');

      // Must be 404, NOT 403 — don't leak resource existence
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('NOT_FOUND');

      // Verify query was tenant-scoped
      expect(service.getAttachment).toHaveBeenCalledWith('att-123', 'tenant-2');
    });

    it('returns 401 without auth', async () => {
      const res = await request(app).get('/internal/attachments/att-123');
      expect(res.status).toBe(401);
    });
  });

  // ===========================================================================
  // GET /internal/attachments/session/:sessionId — List by session
  // ===========================================================================

  describe('GET /internal/attachments/session/:sessionId', () => {
    it('returns 200 with attachment list', async () => {
      const attachments = [makeAttachment(), makeAttachment({ _id: 'att-456' })];
      service = makeAttachmentService({
        listBySession: vi.fn().mockResolvedValue(attachments),
      } as Partial<AttachmentService>);
      app = createApp(service);

      const res = await request(app)
        .get('/internal/attachments/session/session-1')
        .set('X-Tenant-Id', 'tenant-1');

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.attachments).toHaveLength(2);
    });

    it('passes tenantId and sessionId to service', async () => {
      await request(app)
        .get('/internal/attachments/session/session-1')
        .set('X-Tenant-Id', 'tenant-1');

      expect(service.listBySession).toHaveBeenCalledWith('session-1', 'tenant-1', {
        limit: undefined,
        offset: undefined,
      });
    });

    it('passes limit and offset query params', async () => {
      await request(app)
        .get('/internal/attachments/session/session-1?limit=10&offset=20')
        .set('X-Tenant-Id', 'tenant-1');

      expect(service.listBySession).toHaveBeenCalledWith('session-1', 'tenant-1', {
        limit: 10,
        offset: 20,
      });
    });

    it('returns 200 with empty list for unknown session', async () => {
      const res = await request(app)
        .get('/internal/attachments/session/unknown-session')
        .set('X-Tenant-Id', 'tenant-1');

      expect(res.status).toBe(200);
      expect(res.body.data.attachments).toEqual([]);
    });

    it('returns 401 without auth', async () => {
      const res = await request(app).get('/internal/attachments/session/session-1');
      expect(res.status).toBe(401);
    });
  });

  // ===========================================================================
  // GET /internal/attachments/:attachmentId/url — Presigned URL
  // ===========================================================================

  describe('GET /internal/attachments/:attachmentId/url', () => {
    it('returns 200 with presigned URL', async () => {
      const attachment = makeAttachment();
      service = makeAttachmentService({
        getAttachment: vi.fn().mockResolvedValue(attachment),
        getSignedUrl: vi.fn().mockResolvedValue('https://storage.example.com/signed'),
      } as Partial<AttachmentService>);
      app = createApp(service);

      const res = await request(app)
        .get('/internal/attachments/att-123/url')
        .set('X-Tenant-Id', 'tenant-1');

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.url).toBe('https://storage.example.com/signed');
      expect(res.body.data.expiresInSeconds).toBe(900); // default
    });

    it('passes disposition and expiresIn params', async () => {
      const attachment = makeAttachment();
      service = makeAttachmentService({
        getAttachment: vi.fn().mockResolvedValue(attachment),
        getSignedUrl: vi.fn().mockResolvedValue('https://storage.example.com/signed'),
      } as Partial<AttachmentService>);
      app = createApp(service);

      await request(app)
        .get('/internal/attachments/att-123/url?disposition=attachment&expiresIn=3600')
        .set('X-Tenant-Id', 'tenant-1');

      expect(service.getSignedUrl).toHaveBeenCalledWith(attachment.storageKey, {
        expiresInSeconds: 3600,
        disposition: 'attachment',
        filename: 'test.png',
      });
    });

    it('returns 404 when attachment not found', async () => {
      const res = await request(app)
        .get('/internal/attachments/att-999/url')
        .set('X-Tenant-Id', 'tenant-1');

      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('NOT_FOUND');
    });

    it('returns 404 for cross-tenant access (not 403)', async () => {
      // getAttachment returns null for wrong tenant
      const res = await request(app)
        .get('/internal/attachments/att-123/url')
        .set('X-Tenant-Id', 'tenant-2');

      expect(res.status).toBe(404);
    });

    it('returns 401 without auth', async () => {
      const res = await request(app).get('/internal/attachments/att-123/url');
      expect(res.status).toBe(401);
    });
  });

  // ===========================================================================
  // GET /internal/attachments/:attachmentId/content — Attachment bytes
  // ===========================================================================

  describe('GET /internal/attachments/:attachmentId/content', () => {
    it('streams attachment bytes with content headers', async () => {
      const attachment = makeAttachment();
      service = makeAttachmentService({
        downloadAttachmentContent: vi.fn().mockResolvedValue({
          attachment,
          body: Readable.from([Buffer.from('image-bytes')]),
          contentType: 'image/png',
          sizeBytes: 11,
        }),
      } as Partial<AttachmentService>);
      app = createApp(service);

      const res = await request(app)
        .get('/internal/attachments/att-123/content')
        .set('X-Tenant-Id', 'tenant-1');

      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toContain('image/png');
      expect(res.headers['content-length']).toBe('11');
      expect(res.headers['content-disposition']).toBe('inline; filename="test.png"');
      expect(Buffer.compare(res.body, Buffer.from('image-bytes'))).toBe(0);
    });

    it('passes tenantId to content download for tenant isolation', async () => {
      const attachment = makeAttachment();
      service = makeAttachmentService({
        downloadAttachmentContent: vi.fn().mockResolvedValue({
          attachment,
          body: Readable.from([Buffer.from('image-bytes')]),
          contentType: 'image/png',
          sizeBytes: 11,
        }),
      } as Partial<AttachmentService>);
      app = createApp(service);

      await request(app)
        .get('/internal/attachments/att-123/content')
        .set('X-Tenant-Id', 'tenant-1');

      expect(service.downloadAttachmentContent).toHaveBeenCalledWith('att-123', 'tenant-1', {
        variant: undefined,
      });
    });

    it('returns 404 when attachment content is not found', async () => {
      const res = await request(app)
        .get('/internal/attachments/att-999/content')
        .set('X-Tenant-Id', 'tenant-1');

      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('NOT_FOUND');
    });

    it('returns 401 without auth', async () => {
      const res = await request(app).get('/internal/attachments/att-123/content');
      expect(res.status).toBe(401);
    });
  });

  // ===========================================================================
  // DELETE /internal/attachments/:attachmentId — Delete single
  // ===========================================================================

  describe('DELETE /internal/attachments/:attachmentId', () => {
    it('returns 204 on successful delete', async () => {
      const res = await request(app)
        .delete('/internal/attachments/att-123')
        .set('X-Tenant-Id', 'tenant-1');

      expect(res.status).toBe(204);
      expect(res.body).toEqual({}); // no body on 204
    });

    it('passes tenantId to deleteAttachment', async () => {
      await request(app).delete('/internal/attachments/att-123').set('X-Tenant-Id', 'tenant-1');

      expect(service.deleteAttachment).toHaveBeenCalledWith('att-123', 'tenant-1');
    });

    it('returns 204 even when attachment does not exist (idempotent)', async () => {
      // deleteAttachment is a void function; it does nothing if not found
      const res = await request(app)
        .delete('/internal/attachments/att-999')
        .set('X-Tenant-Id', 'tenant-1');

      expect(res.status).toBe(204);
    });

    it('returns 401 without auth', async () => {
      const res = await request(app).delete('/internal/attachments/att-123');
      expect(res.status).toBe(401);
    });

    it('returns 500 when service throws', async () => {
      service = makeAttachmentService({
        deleteAttachment: vi.fn().mockRejectedValue(new Error('DB error')),
      } as Partial<AttachmentService>);
      app = createApp(service);

      const res = await request(app)
        .delete('/internal/attachments/att-123')
        .set('X-Tenant-Id', 'tenant-1');

      expect(res.status).toBe(500);
      expect(res.body.success).toBe(false);
    });
  });

  // ===========================================================================
  // DELETE /internal/attachments/session/:sessionId — Cascade delete
  // ===========================================================================

  describe('DELETE /internal/attachments/session/:sessionId', () => {
    it('returns 204 on successful cascade delete', async () => {
      const res = await request(app)
        .delete('/internal/attachments/session/session-1')
        .set('X-Tenant-Id', 'tenant-1');

      expect(res.status).toBe(204);
    });

    it('passes tenantId and sessionId to deleteBySession', async () => {
      await request(app)
        .delete('/internal/attachments/session/session-1')
        .set('X-Tenant-Id', 'tenant-1');

      expect(service.deleteBySession).toHaveBeenCalledWith('session-1', 'tenant-1');
    });

    it('returns 401 without auth', async () => {
      const res = await request(app).delete('/internal/attachments/session/session-1');
      expect(res.status).toBe(401);
    });
  });

  // ===========================================================================
  // GET /internal/attachments/:attachmentId/status — Processing status
  // ===========================================================================

  describe('GET /internal/attachments/:attachmentId/status', () => {
    it('returns 200 with status fields', async () => {
      const attachment = makeAttachment({
        scanStatus: 'clean',
        processingStatus: 'completed',
        embeddingStatus: 'pending',
        scannedAt: new Date('2026-01-01'),
        processedAt: new Date('2026-01-02'),
      });
      service = makeAttachmentService({
        getAttachment: vi.fn().mockResolvedValue(attachment),
      } as Partial<AttachmentService>);
      app = createApp(service);

      const res = await request(app)
        .get('/internal/attachments/att-123/status')
        .set('X-Tenant-Id', 'tenant-1');

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.attachmentId).toBe('att-123');
      expect(res.body.data.scanStatus).toBe('clean');
      expect(res.body.data.processingStatus).toBe('completed');
      expect(res.body.data.embeddingStatus).toBe('pending');
      expect(res.body.data.processingError).toBeNull();
    });

    it('returns 404 when attachment not found', async () => {
      const res = await request(app)
        .get('/internal/attachments/att-999/status')
        .set('X-Tenant-Id', 'tenant-1');

      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('NOT_FOUND');
    });

    it('returns 404 for cross-tenant access (not 403)', async () => {
      const res = await request(app)
        .get('/internal/attachments/att-123/status')
        .set('X-Tenant-Id', 'tenant-2');

      expect(res.status).toBe(404);
    });

    it('returns 401 without auth', async () => {
      const res = await request(app).get('/internal/attachments/att-123/status');
      expect(res.status).toBe(401);
    });
  });

  // ===========================================================================
  // TENANT ISOLATION (cross-cutting)
  // ===========================================================================

  describe('Tenant Isolation', () => {
    it('every endpoint scopes queries by tenantId from header', async () => {
      const attachment = makeAttachment({ tenantId: 'tenant-1' });
      service = makeAttachmentService({
        getAttachment: vi.fn().mockResolvedValue(attachment),
        listBySession: vi.fn().mockResolvedValue([attachment]),
      } as Partial<AttachmentService>);
      app = createApp(service);

      // GET by ID
      await request(app).get('/internal/attachments/att-123').set('X-Tenant-Id', 'tenant-1');
      expect(service.getAttachment).toHaveBeenCalledWith('att-123', 'tenant-1');

      // GET status
      await request(app).get('/internal/attachments/att-123/status').set('X-Tenant-Id', 'tenant-1');
      // getAttachment called again for status
      expect(service.getAttachment).toHaveBeenCalledTimes(2);

      // GET session list
      await request(app)
        .get('/internal/attachments/session/session-1')
        .set('X-Tenant-Id', 'tenant-1');
      expect(service.listBySession).toHaveBeenCalledWith(
        'session-1',
        'tenant-1',
        expect.anything(),
      );

      // DELETE by ID
      await request(app).delete('/internal/attachments/att-123').set('X-Tenant-Id', 'tenant-1');
      expect(service.deleteAttachment).toHaveBeenCalledWith('att-123', 'tenant-1');

      // DELETE session
      await request(app)
        .delete('/internal/attachments/session/session-1')
        .set('X-Tenant-Id', 'tenant-1');
      expect(service.deleteBySession).toHaveBeenCalledWith('session-1', 'tenant-1');
    });

    it('different tenant gets 404 for same attachment ID', async () => {
      // tenant-1 has attachment, tenant-2 does not
      service = makeAttachmentService({
        getAttachment: vi.fn().mockImplementation((_id: string, tenantId: string) => {
          if (tenantId === 'tenant-1') {
            return Promise.resolve(makeAttachment());
          }
          return Promise.resolve(null);
        }),
      } as Partial<AttachmentService>);
      app = createApp(service);

      // tenant-1 gets the attachment
      const res1 = await request(app)
        .get('/internal/attachments/att-123')
        .set('X-Tenant-Id', 'tenant-1');
      expect(res1.status).toBe(200);

      // tenant-2 gets 404 (not 403)
      const res2 = await request(app)
        .get('/internal/attachments/att-123')
        .set('X-Tenant-Id', 'tenant-2');
      expect(res2.status).toBe(404);
    });
  });
});
