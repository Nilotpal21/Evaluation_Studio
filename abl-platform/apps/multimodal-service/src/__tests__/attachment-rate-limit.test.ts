/**
 * Multimodal Upload Rate Limiter Wiring Tests (Fix 5)
 *
 * Tests that the UploadRateLimiter is properly wired into the attachment
 * routes via createAttachmentRouter():
 * - Upload succeeds when rate limiter allows
 * - Upload returns 429 when rate limiter denies
 * - Upload works when no rate limiter provided (passthrough)
 * - Per-tenant isolation in rate limiting
 * - Rate limit response format matches expected schema
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createAttachmentRouter } from '../routes/attachments.js';
import type { UploadRateLimiter } from '../security/upload-rate-limiter.js';
import type { AttachmentService } from '../services/multimodal-service.js';

// =============================================================================
// HELPERS
// =============================================================================

/** Creates a minimal mock AttachmentService that returns success */
function createMockAttachmentService(): AttachmentService {
  return {
    upload: vi.fn().mockResolvedValue({
      success: true,
      attachmentId: 'att-123',
      status: 'uploaded',
    }),
    getAttachment: vi.fn(),
    listBySession: vi.fn(),
    deleteAttachment: vi.fn(),
    deleteBySession: vi.fn(),
    getSignedUrl: vi.fn(),
  } as any;
}

/** Creates a mock UploadRateLimiter */
function createMockRateLimiter(consumeFn: any): UploadRateLimiter {
  return { consume: consumeFn } as any;
}

/** Creates an Express app with the attachment router mounted */
function createApp(
  attachmentService: AttachmentService,
  uploadRateLimiter?: UploadRateLimiter,
): express.Express {
  const app = express();
  app.use(express.json());
  const router = createAttachmentRouter(attachmentService, uploadRateLimiter);
  app.use('/internal/attachments', router);
  return app;
}

// =============================================================================
// TESTS
// =============================================================================

describe('Multimodal Upload Rate Limiter Wiring (Fix 5)', () => {
  let mockService: AttachmentService;

  beforeEach(() => {
    vi.clearAllMocks();
    mockService = createMockAttachmentService();
  });

  // -------------------------------------------------------------------------
  // Positive: Upload allowed by rate limiter
  // -------------------------------------------------------------------------

  describe('positive: upload allowed', () => {
    test('upload succeeds when rate limiter allows', async () => {
      const consume = vi.fn().mockResolvedValue({
        allowed: true,
        remainingPoints: 49,
        limit: 50,
      });
      const limiter = createMockRateLimiter(consume);
      const app = createApp(mockService, limiter);

      const res = await request(app)
        .post('/internal/attachments')
        .set('X-Tenant-Id', 'tenant-allowed-1')
        .field('sessionId', 'session-1')
        .attach('file', Buffer.from('test content'), 'test.txt');

      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
      expect(res.body.data.attachmentId).toBe('att-123');
      expect(consume).toHaveBeenCalledWith('tenant-allowed-1');
    });

    test('rate limiter is called with the correct tenantId', async () => {
      const consume = vi.fn().mockResolvedValue({ allowed: true, remainingPoints: 10, limit: 50 });
      const limiter = createMockRateLimiter(consume);
      const app = createApp(mockService, limiter);

      await request(app)
        .post('/internal/attachments')
        .set('X-Tenant-Id', 'my-specific-tenant')
        .field('sessionId', 'session-1')
        .attach('file', Buffer.from('content'), 'doc.pdf');

      expect(consume).toHaveBeenCalledWith('my-specific-tenant');
    });
  });

  // -------------------------------------------------------------------------
  // Negative: Upload denied by rate limiter
  // -------------------------------------------------------------------------

  describe('negative: upload rate limited', () => {
    test('returns 429 when rate limiter denies', async () => {
      const consume = vi.fn().mockResolvedValue({
        allowed: false,
        retryAfterMs: 45000,
        remainingPoints: 0,
        limit: 50,
      });
      const limiter = createMockRateLimiter(consume);
      const app = createApp(mockService, limiter);

      const res = await request(app)
        .post('/internal/attachments')
        .set('X-Tenant-Id', 'tenant-denied-1')
        .field('sessionId', 'session-1')
        .attach('file', Buffer.from('test content'), 'test.txt');

      expect(res.status).toBe(429);
      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe('RATE_LIMIT_EXCEEDED');
      expect(res.body.error.message).toBe('Upload rate limit exceeded');
      expect(res.body.error.retryAfterMs).toBe(45000);
    });

    test('does not call attachmentService.upload() when rate limited', async () => {
      const consume = vi.fn().mockResolvedValue({
        allowed: false,
        retryAfterMs: 30000,
        remainingPoints: 0,
        limit: 50,
      });
      const limiter = createMockRateLimiter(consume);
      const app = createApp(mockService, limiter);

      await request(app)
        .post('/internal/attachments')
        .set('X-Tenant-Id', 'tenant-denied-2')
        .field('sessionId', 'session-1')
        .attach('file', Buffer.from('test content'), 'test.txt');

      expect(mockService.upload as any).not.toHaveBeenCalled();
    });

    test('429 response includes retryAfterMs in error body', async () => {
      const consume = vi.fn().mockResolvedValue({
        allowed: false,
        retryAfterMs: 12345,
        remainingPoints: 0,
        limit: 50,
      });
      const limiter = createMockRateLimiter(consume);
      const app = createApp(mockService, limiter);

      const res = await request(app)
        .post('/internal/attachments')
        .set('X-Tenant-Id', 'tenant-denied-3')
        .field('sessionId', 'session-1')
        .attach('file', Buffer.from('content'), 'file.txt');

      expect(res.body.error.retryAfterMs).toBe(12345);
    });

    test('429 response includes X-RateLimit-* headers', async () => {
      const consume = vi.fn().mockResolvedValue({
        allowed: false,
        retryAfterMs: 30000,
        remainingPoints: 0,
        limit: 50,
      });
      const limiter = createMockRateLimiter(consume);
      const app = createApp(mockService, limiter);

      const res = await request(app)
        .post('/internal/attachments')
        .set('X-Tenant-Id', 'tenant-headers-429')
        .field('sessionId', 'session-1')
        .attach('file', Buffer.from('content'), 'file.txt');

      expect(res.status).toBe(429);
      expect(res.headers['x-ratelimit-limit']).toBe('50');
      expect(res.headers['x-ratelimit-remaining']).toBe('0');
      expect(res.headers['x-ratelimit-reset']).toBeDefined();
    });
  });

  // -------------------------------------------------------------------------
  // Passthrough: no rate limiter provided
  // -------------------------------------------------------------------------

  describe('passthrough: no rate limiter', () => {
    test('upload succeeds when no rate limiter is provided', async () => {
      // No limiter parameter — undefined
      const app = createApp(mockService);

      const res = await request(app)
        .post('/internal/attachments')
        .set('X-Tenant-Id', 'tenant-no-limiter')
        .field('sessionId', 'session-1')
        .attach('file', Buffer.from('test content'), 'test.txt');

      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
    });

    test('attachmentService.upload() is called directly without rate check', async () => {
      const app = createApp(mockService);

      await request(app)
        .post('/internal/attachments')
        .set('X-Tenant-Id', 'tenant-direct')
        .field('sessionId', 'session-1')
        .attach('file', Buffer.from('content'), 'file.txt');

      expect(mockService.upload as any).toHaveBeenCalledTimes(1);
    });
  });

  // -------------------------------------------------------------------------
  // Per-tenant isolation
  // -------------------------------------------------------------------------

  describe('per-tenant isolation', () => {
    test('rate limiter receives each tenant ID independently', async () => {
      const consume = vi.fn().mockResolvedValue({ allowed: true, remainingPoints: 10, limit: 50 });
      const limiter = createMockRateLimiter(consume);
      const app = createApp(mockService, limiter);

      await request(app)
        .post('/internal/attachments')
        .set('X-Tenant-Id', 'tenant-iso-A')
        .field('sessionId', 'session-1')
        .attach('file', Buffer.from('content'), 'a.txt');

      await request(app)
        .post('/internal/attachments')
        .set('X-Tenant-Id', 'tenant-iso-B')
        .field('sessionId', 'session-1')
        .attach('file', Buffer.from('content'), 'b.txt');

      expect(consume).toHaveBeenCalledWith('tenant-iso-A');
      expect(consume).toHaveBeenCalledWith('tenant-iso-B');
      expect(consume).toHaveBeenCalledTimes(2);
    });

    test('one tenant rate limited does not affect another', async () => {
      const consume = vi.fn().mockImplementation(async (tenantId: string) => {
        if (tenantId === 'tenant-limited') {
          return { allowed: false, retryAfterMs: 30000, remainingPoints: 0, limit: 50 };
        }
        return { allowed: true, remainingPoints: 49, limit: 50 };
      });
      const limiter = createMockRateLimiter(consume);
      const app = createApp(mockService, limiter);

      // Tenant A is rate limited
      const resA = await request(app)
        .post('/internal/attachments')
        .set('X-Tenant-Id', 'tenant-limited')
        .field('sessionId', 'session-1')
        .attach('file', Buffer.from('content'), 'a.txt');

      expect(resA.status).toBe(429);

      // Tenant B should succeed
      const resB = await request(app)
        .post('/internal/attachments')
        .set('X-Tenant-Id', 'tenant-ok')
        .field('sessionId', 'session-1')
        .attach('file', Buffer.from('content'), 'b.txt');

      expect(resB.status).toBe(201);
    });
  });

  // -------------------------------------------------------------------------
  // Edge cases
  // -------------------------------------------------------------------------

  describe('edge cases', () => {
    test('rate check happens after file validation (missing file still returns 400)', async () => {
      const consume = vi.fn().mockResolvedValue({ allowed: true, remainingPoints: 49, limit: 50 });
      const limiter = createMockRateLimiter(consume);
      const app = createApp(mockService, limiter);

      // No file attached — should get 400 before rate check
      const res = await request(app)
        .post('/internal/attachments')
        .set('X-Tenant-Id', 'tenant-no-file')
        .field('sessionId', 'session-1');

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('MISSING_FILE');
    });

    test('missing sessionId returns 400 before rate check', async () => {
      const consume = vi.fn().mockResolvedValue({ allowed: true, remainingPoints: 49, limit: 50 });
      const limiter = createMockRateLimiter(consume);
      const app = createApp(mockService, limiter);

      const res = await request(app)
        .post('/internal/attachments')
        .set('X-Tenant-Id', 'tenant-no-session')
        .attach('file', Buffer.from('content'), 'file.txt');

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('MISSING_SESSION_ID');
    });

    test('missing X-Tenant-Id returns 401 before rate check', async () => {
      const consume = vi.fn();
      const limiter = createMockRateLimiter(consume);
      const app = createApp(mockService, limiter);

      const res = await request(app)
        .post('/internal/attachments')
        .field('sessionId', 'session-1')
        .attach('file', Buffer.from('content'), 'file.txt');

      expect(res.status).toBe(401);
      expect(consume).not.toHaveBeenCalled();
    });

    test('returns 500 when rate limiter consume() throws', async () => {
      const consume = vi.fn().mockRejectedValue(new Error('Redis connection lost'));
      const limiter = createMockRateLimiter(consume);
      const app = createApp(mockService, limiter);

      const res = await request(app)
        .post('/internal/attachments')
        .set('X-Tenant-Id', 'tenant-error')
        .field('sessionId', 'session-1')
        .attach('file', Buffer.from('content'), 'file.txt');

      expect(res.status).toBe(500);
      expect(res.body.error.code).toBe('INTERNAL_ERROR');
    });
  });
});
