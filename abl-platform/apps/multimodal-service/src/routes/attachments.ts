/**
 * Attachment Internal API Routes
 *
 * Internal REST endpoints called by the runtime via MultimodalServiceClient.
 * NOT public-facing. Auth is via X-Tenant-Id / X-Project-Id headers set by
 * the calling service.
 *
 * All queries are tenant-scoped: findOne({ _id, tenantId }), never findById().
 * Cross-tenant access returns 404 (not 403) to avoid leaking resource existence.
 *
 * Response format: { success: true, data } or { success: false, error: { code, message } }
 */

import { Router, type Request, type Response, type NextFunction } from 'express';
import { Readable } from 'stream';
import { pipeline } from 'stream/promises';
import multer from 'multer';
import { z } from 'zod';
import { createLogger } from '@abl/compiler/platform';
import type { AttachmentConfig } from '@agent-platform/shared';
import type { AttachmentService } from '../services/multimodal-service.js';
import type { UploadRateLimiter } from '../security/upload-rate-limiter.js';

const log = createLogger('multimodal-routes');

// =============================================================================
// CONSTANTS
// =============================================================================

/** Default presigned URL expiry in seconds (15 minutes). */
const DEFAULT_SIGNED_URL_EXPIRY_SECONDS = 900;

/** Maximum file size for multer (50 MB). Actual validation done by AttachmentService. */
const MULTER_MAX_FILE_SIZE = 50 * 1024 * 1024;

const DEFAULT_ATTACHMENT_CONFIG: AttachmentConfig = {
  enabled: true,
  maxFileSizeBytes: MULTER_MAX_FILE_SIZE,
  maxAttachmentsPerMessage: 10,
  maxAttachmentsPerSession: 100,
  maxTotalStorageBytesPerTenant: 10 * 1024 * 1024 * 1024,
  allowedCategories: ['image', 'document', 'audio', 'video'],
  retentionDays: { image: 90, document: 90, audio: 90, video: 90 },
  allowedMimeTypes: [
    'image/png',
    'image/jpeg',
    'image/gif',
    'image/webp',
    'application/pdf',
    'text/markdown',
    'text/plain',
    'audio/mpeg',
    'audio/wav',
    'video/mp4',
  ],
  quotas: { maxUploadsPerMinute: 60, maxConcurrentProcessingJobs: 10 },
};

// =============================================================================
// TYPES
// =============================================================================

/** Extended request with tenant context from internal auth middleware. */
export interface InternalRequest extends Request {
  tenantId: string;
  projectId: string;
}

function isAttachmentConfig(value: unknown): value is AttachmentConfig {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseAttachmentConfig(rawConfig: unknown): AttachmentConfig | undefined {
  if (rawConfig === undefined || rawConfig === null || rawConfig === '') {
    return undefined;
  }

  if (isAttachmentConfig(rawConfig)) {
    return rawConfig;
  }

  if (typeof rawConfig !== 'string') {
    throw new Error('INVALID_CONFIG');
  }

  try {
    const parsed = JSON.parse(rawConfig) as unknown;

    if (isAttachmentConfig(parsed)) {
      return parsed;
    }
  } catch {
    // Invalid JSON is handled by the caller so we can return a 400 boundary error.
  }

  throw new Error('INVALID_CONFIG');
}

// =============================================================================
// INTERNAL AUTH MIDDLEWARE
// =============================================================================

/**
 * Extracts X-Tenant-Id and X-Project-Id headers set by the calling service
 * (runtime). Returns 401 if X-Tenant-Id is missing.
 *
 * NOTE: This is an INTERNAL service-to-service endpoint — not client-facing.
 * The X-Tenant-Id header is set by runtime from its authenticated tenant context,
 * not forwarded from the client. This is acceptable for internal service mesh.
 */
export function requireInternalAuth(req: Request, res: Response, next: NextFunction): void {
  const tenantId = req.headers['x-tenant-id'];
  const projectId = req.headers['x-project-id'];

  if (!tenantId || typeof tenantId !== 'string') {
    res.status(401).json({
      success: false,
      error: { code: 'UNAUTHORIZED', message: 'Missing X-Tenant-Id header' },
    });
    return;
  }

  (req as InternalRequest).tenantId = tenantId;
  (req as InternalRequest).projectId = typeof projectId === 'string' ? projectId : '';

  next();
}

// =============================================================================
// MULTER CONFIG
// =============================================================================

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MULTER_MAX_FILE_SIZE },
});

// =============================================================================
// ROUTE FACTORY
// =============================================================================

/**
 * Creates the attachment router with injected dependencies.
 * The service instance is provided at startup so routes remain testable.
 */
export function createAttachmentRouter(
  attachmentService: AttachmentService,
  uploadRateLimiter?: UploadRateLimiter,
): Router {
  const router = Router();

  // Apply internal auth to all routes
  router.use(requireInternalAuth);

  // ---------------------------------------------------------------------------
  // POST /internal/attachments — Upload a new attachment
  // ---------------------------------------------------------------------------

  router.post(
    '/',
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- multer types conflict with @types/express v4
    upload.single('file') as any,
    async (req: Request, res: Response): Promise<void> => {
      try {
        const { tenantId, projectId } = req as InternalRequest;
        const file = req.file;

        if (!file) {
          res.status(400).json({
            success: false,
            error: { code: 'MISSING_FILE', message: 'No file provided in request' },
          });
          return;
        }

        const sessionId = req.body.sessionId as string | undefined;
        const messageId = req.body.messageId as string | undefined;
        const channel = (req.body.channel as string | undefined) ?? 'internal';
        let config: AttachmentConfig | undefined;

        if (!sessionId) {
          res.status(400).json({
            success: false,
            error: { code: 'MISSING_SESSION_ID', message: 'sessionId is required' },
          });
          return;
        }

        // Per-tenant upload rate limiting
        if (uploadRateLimiter) {
          const rateResult = await uploadRateLimiter.consume(tenantId);
          res.set('X-RateLimit-Limit', String(rateResult.limit));
          res.set('X-RateLimit-Remaining', String(rateResult.remainingPoints ?? 0));
          if (!rateResult.allowed) {
            res.set(
              'X-RateLimit-Reset',
              String(Math.ceil((Date.now() + (rateResult.retryAfterMs ?? 0)) / 1000)),
            );
            res.status(429).json({
              success: false,
              error: {
                code: 'RATE_LIMIT_EXCEEDED',
                message: 'Upload rate limit exceeded',
                retryAfterMs: rateResult.retryAfterMs,
              },
            });
            return;
          }
        }

        try {
          config = parseAttachmentConfig(req.body.config);
        } catch {
          res.status(400).json({
            success: false,
            error: { code: 'INVALID_CONFIG', message: 'config must be valid JSON' },
          });
          return;
        }

        // Build AttachmentInput from multer file (memory buffer -> stream)
        const result = await attachmentService.upload(
          {
            source: {
              type: 'stream',
              stream: Readable.from([file.buffer]),
              filename: file.originalname,
              mimeType: file.mimetype,
              sizeBytes: file.size,
            },
            tenantId,
            projectId: projectId || req.body.projectId || '',
            sessionId,
            messageId,
            channel,
          },
          // Config may arrive as JSON or as a parsed object depending on the caller.
          config ?? DEFAULT_ATTACHMENT_CONFIG,
        );

        if (!result.success) {
          res.status(400).json({ success: false, error: result.error });
          return;
        }

        res.status(201).json({
          success: true,
          data: { attachmentId: result.attachmentId, status: result.status },
        });
      } catch (err) {
        log.error('Upload failed', { error: err instanceof Error ? err.message : String(err) });
        res.status(500).json({
          success: false,
          error: { code: 'INTERNAL_ERROR', message: 'Upload failed' },
        });
      }
    },
  );

  // ---------------------------------------------------------------------------
  // GET /internal/attachments/session/:sessionId — List attachments for session
  // ---------------------------------------------------------------------------
  // NOTE: This route must be defined BEFORE /:attachmentId to avoid
  // "session" being captured as an attachmentId.

  router.get('/session/:sessionId', async (req: Request, res: Response): Promise<void> => {
    try {
      const { tenantId } = req as InternalRequest;
      const { sessionId } = req.params;

      const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : undefined;
      const offset = req.query.offset ? parseInt(req.query.offset as string, 10) : undefined;

      const attachments = await attachmentService.listBySession(sessionId!, tenantId, {
        limit,
        offset,
      });

      res.status(200).json({ success: true, data: { attachments } });
    } catch (err) {
      log.error('List by session failed', {
        error: err instanceof Error ? err.message : String(err),
      });
      res.status(500).json({
        success: false,
        error: { code: 'INTERNAL_ERROR', message: 'Failed to list attachments' },
      });
    }
  });

  // ---------------------------------------------------------------------------
  // DELETE /internal/attachments/session/:sessionId — Cascade delete session
  // ---------------------------------------------------------------------------

  router.delete('/session/:sessionId', async (req: Request, res: Response): Promise<void> => {
    try {
      const { tenantId } = req as InternalRequest;
      const { sessionId } = req.params;

      await attachmentService.deleteBySession(sessionId!, tenantId);

      res.status(204).send();
    } catch (err) {
      log.error('Delete by session failed', {
        error: err instanceof Error ? err.message : String(err),
      });
      res.status(500).json({
        success: false,
        error: { code: 'INTERNAL_ERROR', message: 'Failed to delete session attachments' },
      });
    }
  });

  // ---------------------------------------------------------------------------
  // POST /internal/attachments/:attachmentId/retry — Retry failed processing
  // ---------------------------------------------------------------------------
  // NOTE: This route must be defined BEFORE /:attachmentId GET to avoid
  // route matching issues with Express parameterized routes.

  router.post('/:attachmentId/retry', async (req: Request, res: Response): Promise<void> => {
    try {
      const { tenantId } = req as InternalRequest;
      const { attachmentId } = req.params;

      const attachment = await attachmentService.getAttachment(attachmentId!, tenantId);
      if (!attachment) {
        res.status(404).json({
          success: false,
          error: { code: 'NOT_FOUND', message: 'Attachment not found' },
        });
        return;
      }

      const result = await attachmentService.retryProcessing(attachmentId!, tenantId);

      if (!result.success) {
        res.status(409).json({
          success: false,
          error: result.error,
        });
        return;
      }

      res.status(200).json({
        success: true,
        data: { retryCount: result.retryCount },
      });
    } catch (err) {
      log.error('Retry failed', { error: err instanceof Error ? err.message : String(err) });
      res.status(500).json({
        success: false,
        error: { code: 'INTERNAL_ERROR', message: 'Retry failed' },
      });
    }
  });

  // ---------------------------------------------------------------------------
  // PATCH /internal/attachments/:attachmentId — Update attachment processing state
  // ---------------------------------------------------------------------------
  // Used by pipeline workers (scan-job, process-job, index-job) and test harnesses
  // to update attachment records after async processing completes.

  router.patch('/:attachmentId', async (req: Request, res: Response): Promise<void> => {
    try {
      const { tenantId } = req as InternalRequest;
      const { attachmentId } = req.params;

      const result = await attachmentService.updateAttachment(attachmentId!, tenantId, req.body);
      if (!result) {
        res.status(404).json({
          success: false,
          error: { code: 'NOT_FOUND', message: 'Attachment not found' },
        });
        return;
      }

      res.status(200).json({ success: true, data: { attachment: result } });
    } catch (err) {
      log.error('Update failed', { error: err instanceof Error ? err.message : String(err) });
      res.status(500).json({
        success: false,
        error: { code: 'INTERNAL_ERROR', message: 'Update failed' },
      });
    }
  });

  // ---------------------------------------------------------------------------
  // GET /internal/attachments/:attachmentId — Get attachment metadata
  // ---------------------------------------------------------------------------

  router.get('/:attachmentId', async (req: Request, res: Response): Promise<void> => {
    try {
      const { tenantId } = req as InternalRequest;
      const { attachmentId } = req.params;

      const attachment = await attachmentService.getAttachment(attachmentId!, tenantId);

      if (!attachment) {
        res.status(404).json({
          success: false,
          error: { code: 'NOT_FOUND', message: 'Attachment not found' },
        });
        return;
      }

      res.status(200).json({ success: true, data: { attachment } });
    } catch (err) {
      log.error('Get attachment failed', {
        error: err instanceof Error ? err.message : String(err),
      });
      res.status(500).json({
        success: false,
        error: { code: 'INTERNAL_ERROR', message: 'Failed to get attachment' },
      });
    }
  });

  // ---------------------------------------------------------------------------
  // GET /internal/attachments/:attachmentId/url — Get presigned download URL
  // ---------------------------------------------------------------------------

  router.get('/:attachmentId/url', async (req: Request, res: Response): Promise<void> => {
    try {
      const { tenantId } = req as InternalRequest;
      const { attachmentId } = req.params;

      const attachment = await attachmentService.getAttachment(attachmentId!, tenantId);

      if (!attachment) {
        res.status(404).json({
          success: false,
          error: { code: 'NOT_FOUND', message: 'Attachment not found' },
        });
        return;
      }

      const disposition =
        (req.query.disposition as 'inline' | 'attachment' | undefined) ?? 'inline';
      const expiresIn = req.query.expiresIn
        ? parseInt(req.query.expiresIn as string, 10)
        : DEFAULT_SIGNED_URL_EXPIRY_SECONDS;

      const url = await attachmentService.getSignedUrl(attachment.storageKey, {
        expiresInSeconds: expiresIn,
        disposition,
        filename: attachment.originalFilename,
      });

      res.status(200).json({ success: true, data: { url, expiresInSeconds: expiresIn } });
    } catch (err) {
      log.error('Get signed URL failed', {
        error: err instanceof Error ? err.message : String(err),
      });
      res.status(500).json({
        success: false,
        error: { code: 'INTERNAL_ERROR', message: 'Failed to generate download URL' },
      });
    }
  });

  // ---------------------------------------------------------------------------
  // GET /internal/attachments/:attachmentId/frames/:frameIndex — Serve video frame
  // ---------------------------------------------------------------------------
  // MUST be registered before /:attachmentId routes to avoid path capture

  router.get(
    '/:attachmentId/frames/:frameIndex',
    async (req: Request, res: Response): Promise<void> => {
      try {
        const { tenantId } = req as InternalRequest;
        const { attachmentId, frameIndex: frameIndexStr } = req.params;

        const parsed = z
          .object({
            frameIndex: z
              .string()
              .regex(/^\d+$/)
              .transform(Number)
              .pipe(z.number().int().min(0).max(9)),
          })
          .safeParse({ frameIndex: frameIndexStr });

        if (!parsed.success) {
          res.status(400).json({
            success: false,
            error: { code: 'INVALID_FRAME_INDEX', message: 'frameIndex must be 0-9' },
          });
          return;
        }

        const download = await attachmentService.downloadFrameContent(
          attachmentId!,
          tenantId,
          parsed.data.frameIndex,
        );

        if (!download) {
          res.status(404).json({
            success: false,
            error: { code: 'NOT_FOUND', message: 'Frame not found' },
          });
          return;
        }

        res.setHeader('Content-Type', download.contentType);
        res.setHeader('Content-Length', String(download.sizeBytes));
        res.setHeader('Cache-Control', 'private, max-age=3600');
        await pipeline(download.body, res);
      } catch (err) {
        log.error('Download frame failed', {
          error: err instanceof Error ? err.message : String(err),
        });
        if (!res.headersSent) {
          res.status(500).json({
            success: false,
            error: { code: 'INTERNAL_ERROR', message: 'Failed to download frame' },
          });
        } else {
          res.end();
        }
      }
    },
  );

  // ---------------------------------------------------------------------------
  // GET /internal/attachments/:attachmentId/content — Stream attachment bytes
  // ---------------------------------------------------------------------------

  router.get('/:attachmentId/content', async (req: Request, res: Response): Promise<void> => {
    try {
      const { tenantId } = req as InternalRequest;
      const { attachmentId } = req.params;

      const variant = (req.query.variant as string) || undefined;
      const download = await attachmentService.downloadAttachmentContent(attachmentId!, tenantId, {
        variant,
      });

      if (!download) {
        res.status(404).json({
          success: false,
          error: { code: 'NOT_FOUND', message: 'Attachment not found' },
        });
        return;
      }

      const safeFilename = download.attachment.originalFilename.replace(/["\\]/g, '_');

      res.setHeader('Content-Type', download.contentType);
      res.setHeader('Content-Length', String(download.sizeBytes));
      res.setHeader('Content-Disposition', `inline; filename="${safeFilename}"`);

      await pipeline(download.body, res);
    } catch (err) {
      log.error('Download content failed', {
        error: err instanceof Error ? err.message : String(err),
      });

      if (!res.headersSent) {
        res.status(500).json({
          success: false,
          error: { code: 'INTERNAL_ERROR', message: 'Failed to download attachment content' },
        });
      } else {
        res.end();
      }
    }
  });

  // ---------------------------------------------------------------------------
  // DELETE /internal/attachments/:attachmentId — Delete single attachment
  // ---------------------------------------------------------------------------

  router.delete('/:attachmentId', async (req: Request, res: Response): Promise<void> => {
    try {
      const { tenantId } = req as InternalRequest;
      const { attachmentId } = req.params;

      await attachmentService.deleteAttachment(attachmentId!, tenantId);

      res.status(204).send();
    } catch (err) {
      log.error('Delete attachment failed', {
        error: err instanceof Error ? err.message : String(err),
      });
      res.status(500).json({
        success: false,
        error: { code: 'INTERNAL_ERROR', message: 'Failed to delete attachment' },
      });
    }
  });

  // ---------------------------------------------------------------------------
  // GET /internal/attachments/:attachmentId/status — Get processing status
  // ---------------------------------------------------------------------------

  router.get('/:attachmentId/status', async (req: Request, res: Response): Promise<void> => {
    try {
      const { tenantId } = req as InternalRequest;
      const { attachmentId } = req.params;

      const attachment = await attachmentService.getAttachment(attachmentId!, tenantId);

      if (!attachment) {
        res.status(404).json({
          success: false,
          error: { code: 'NOT_FOUND', message: 'Attachment not found' },
        });
        return;
      }

      res.status(200).json({
        success: true,
        data: {
          attachmentId: attachment._id,
          scanStatus: attachment.scanStatus,
          processingStatus: attachment.processingStatus,
          embeddingStatus: attachment.embeddingStatus,
          processingError: attachment.processingError,
          scannedAt: attachment.scannedAt,
          processedAt: attachment.processedAt,
          embeddedAt: attachment.embeddedAt,
        },
      });
    } catch (err) {
      log.error('Get status failed', { error: err instanceof Error ? err.message : String(err) });
      res.status(500).json({
        success: false,
        error: { code: 'INTERNAL_ERROR', message: 'Failed to get attachment status' },
      });
    }
  });

  return router;
}
