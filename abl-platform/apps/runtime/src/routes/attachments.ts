/**
 * Attachments API Routes (Project + Session Scoped)
 *
 * POST   /api/projects/:projectId/sessions/:sessionId/attachments          Upload attachment
 * GET    /api/projects/:projectId/sessions/:sessionId/attachments          List attachments
 * GET    /api/projects/:projectId/sessions/:sessionId/attachments/:attachmentId        Get detail
 * GET    /api/projects/:projectId/sessions/:sessionId/attachments/:attachmentId/url    Download URL
 * GET    /api/projects/:projectId/sessions/:sessionId/attachments/:attachmentId/status Processing status
 * DELETE /api/projects/:projectId/sessions/:sessionId/attachments/:attachmentId        Delete
 */

import { Router, type Request, type Response, type Router as RouterType } from 'express';
import { Readable } from 'stream';
import Busboy from 'busboy';
import type { IAttachment } from '@agent-platform/database';
import { authMiddleware } from '../middleware/auth.js';
import { requireProjectPermission } from '../middleware/rbac.js';
import {
  requireProjectScope,
  createRequireSessionOwnership,
  type CallerContext,
} from '@agent-platform/shared-auth';
import { getCurrentTenantId } from '@agent-platform/shared-auth/middleware';
import { tenantRateLimit } from '../middleware/rate-limiter.js';
import { MultimodalServiceClient } from '../attachments/multimodal-service-client.js';
import { resolveAttachmentConfig } from '../attachments/attachment-config-resolver.js';
import {
  buildMultimodalUploadConfig,
  mimeTypeMatchesAllowed,
  normalizeUploadMimeType,
} from '../attachments/multimodal-upload-config.js';
import { findSessionById } from '../repos/session-repo.js';
import { buildStoredSessionAccessSource } from '../services/identity/stored-session-access-source.js';
import { buildStoredSessionCallerContext } from '../services/identity/stored-session-caller-context.js';
import { createLogger } from '@abl/compiler/platform';

// ─── Constants ────────────────────────────────────────────────────────────────

/** Maximum upload size in bytes (20 MB). */
const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;

const log = createLogger('attachments-routes');

// ─── Router Setup ─────────────────────────────────────────────────────────────

const router: RouterType = Router({ mergeParams: true });

// All attachment routes require authentication + rate limiting + project scope validation
router.use(authMiddleware);
router.use(tenantRateLimit('request'));
router.use(requireProjectScope('projectId'));

// Session ownership:
// - SDK users can only access attachments in sessions they own.
// - Studio sessions are project-owned; non-admin platform members rely on project RBAC.
// - Public/channel sessions still require end-user ownership checks for SDK callers.
// - Admins and API keys rely on RBAC + project scope.
const requireSessionOwnership = createRequireSessionOwnership({
  findSession: async (sessionId: string, tenantId: string) => {
    const session = await findSessionById(sessionId, tenantId);
    if (!session) return null;
    const callerContext: CallerContext | undefined = buildStoredSessionCallerContext(
      session,
      tenantId,
    );
    return {
      callerContext,
      ownerUserId: session.initiatedById ?? undefined,
      source: buildStoredSessionAccessSource(session),
    };
  },
});
// Apply ownership check to all attachment routes (sessionId is always in the path)
router.use(requireSessionOwnership);

// ─── Helpers ──────────────────────────────────────────────────────────────────

function getClient(): MultimodalServiceClient {
  return new MultimodalServiceClient();
}

interface PublicAttachmentDto {
  id: string;
  _id: string;
  filename: string;
  originalFilename: string;
  mimeType: string;
  detectedMimeType: string | null;
  category: IAttachment['category'];
  sizeBytes: number;
  messageId: string | null;
  scanStatus: IAttachment['scanStatus'];
  processingStatus: IAttachment['processingStatus'];
  embeddingStatus: IAttachment['embeddingStatus'];
  createdAt: Date;
  updatedAt: Date;
  expiresAt: Date | null;
}

function serializeAttachment(attachment: IAttachment): PublicAttachmentDto {
  return {
    id: attachment._id,
    _id: attachment._id,
    filename: attachment.originalFilename,
    originalFilename: attachment.originalFilename,
    mimeType: attachment.mimeType,
    detectedMimeType: attachment.detectedMimeType,
    category: attachment.category,
    sizeBytes: attachment.sizeBytes,
    messageId: attachment.messageId,
    scanStatus: attachment.scanStatus,
    processingStatus: attachment.processingStatus,
    embeddingStatus: attachment.embeddingStatus,
    createdAt: attachment.createdAt,
    updatedAt: attachment.updatedAt,
    expiresAt: attachment.expiresAt,
  };
}

async function loadScopedSession(
  req: Request,
  res: Response,
): Promise<{
  tenantId: string;
  projectId: string;
  sessionId: string;
} | null> {
  const tenantId = getCurrentTenantId();
  if (!tenantId) {
    res.status(401).json({
      success: false,
      error: { code: 'AUTH_REQUIRED', message: 'Tenant context required' },
    });
    return null;
  }

  const { projectId, sessionId } = req.params;
  const session = await findSessionById(sessionId, tenantId);
  if (!session || session.projectId !== projectId) {
    res.status(404).json({
      success: false,
      error: { code: 'NOT_FOUND', message: `Session not found: ${sessionId}` },
    });
    return null;
  }

  return { tenantId, projectId, sessionId };
}

async function loadScopedAttachment(
  req: Request,
  res: Response,
  client: MultimodalServiceClient,
): Promise<Awaited<ReturnType<MultimodalServiceClient['getAttachment']>>> {
  const scope = await loadScopedSession(req, res);
  if (!scope) {
    return null;
  }

  const { attachmentId } = req.params;
  const attachment = await client.getAttachment(attachmentId, scope.tenantId);

  if (
    !attachment ||
    attachment.projectId !== scope.projectId ||
    attachment.sessionId !== scope.sessionId
  ) {
    res.status(404).json({
      success: false,
      error: { code: 'NOT_FOUND', message: `Attachment not found: ${attachmentId}` },
    });
    return null;
  }

  return attachment;
}

// ─── POST / — Upload attachment ───────────────────────────────────────────────

/**
 * Accepts multipart/form-data with a `file` field.
 * Parses the multipart stream with Busboy, collects the file into a buffer,
 * then forwards it as a Readable to MultimodalServiceClient.upload().
 */
router.post('/', async (req: Request, res: Response) => {
  try {
    if (!(await requireProjectPermission(req, res, 'attachment:write'))) return;

    const scope = await loadScopedSession(req, res);
    if (!scope) {
      return;
    }
    const { tenantId, projectId, sessionId } = scope;

    // Resolve attachment config (project → tenant → defaults)
    const attachmentConfig = await resolveAttachmentConfig(tenantId, projectId);

    // Check if attachments are enabled for this project
    if (!attachmentConfig.enabled) {
      res.status(403).json({
        success: false,
        error: {
          code: 'ATTACHMENTS_DISABLED',
          message: 'Attachments are disabled for this project',
        },
      });
      return;
    }

    const contentType = req.headers['content-type'] || '';
    if (!contentType.includes('multipart/form-data')) {
      res.status(400).json({
        success: false,
        error: {
          code: 'INVALID_CONTENT_TYPE',
          message: 'Expected multipart/form-data with a "file" field',
        },
      });
      return;
    }

    // Parse the multipart request with Busboy
    const result = await parseMultipartUpload(req);

    if (!result.success) {
      res.status(400).json({
        success: false,
        error: result.error,
      });
      return;
    }

    const { buffer, filename } = result;
    const mimeType = normalizeUploadMimeType(filename, result.mimeType);

    // Validate file size against resolved config
    const maxSize = attachmentConfig.maxFileSizeBytes;
    if (buffer.length > maxSize) {
      res.status(413).json({
        success: false,
        error: {
          code: 'PAYLOAD_TOO_LARGE',
          message: `File exceeds maximum size of ${maxSize} bytes`,
        },
      });
      return;
    }

    // Validate MIME type against resolved config (empty = all allowed)
    if (
      attachmentConfig.allowedMimeTypes.length > 0 &&
      !mimeTypeMatchesAllowed(mimeType, attachmentConfig.allowedMimeTypes)
    ) {
      res.status(415).json({
        success: false,
        error: {
          code: 'UNSUPPORTED_MEDIA_TYPE',
          message: 'File type is not allowed for this project',
        },
      });
      return;
    }

    const stream = Readable.from(buffer);

    const client = getClient();
    const uploadResult = await client.upload({
      stream,
      filename,
      mimeType,
      sizeBytes: buffer.length,
      maxSizeBytes: maxSize,
      tenantId,
      projectId,
      sessionId,
      config: buildMultimodalUploadConfig(attachmentConfig),
    });

    if (!uploadResult.success) {
      res.status(502).json({
        success: false,
        error: uploadResult.error,
      });
      return;
    }

    res.status(201).json({
      success: true,
      attachmentId: uploadResult.attachmentId,
      status: uploadResult.status,
    });
  } catch (error) {
    log.error('Upload failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    res.status(500).json({
      success: false,
      error: { code: 'INTERNAL_ERROR', message: 'Failed to upload attachment' },
    });
  }
});

// ─── GET / — List attachments for session ─────────────────────────────────────

router.get('/', async (req: Request, res: Response) => {
  try {
    if (!(await requireProjectPermission(req, res, 'attachment:read'))) return;

    const scope = await loadScopedSession(req, res);
    if (!scope) {
      return;
    }

    const { tenantId, sessionId } = scope;
    const limit = Math.min(parseInt(req.query.limit as string) || 50, 200);
    const offset = parseInt(req.query.offset as string) || 0;

    const client = getClient();
    const attachments = await client.listBySession(sessionId, tenantId, { limit, offset });

    res.json({
      success: true,
      data: {
        attachments: attachments.map(serializeAttachment),
        total: attachments.length,
      },
    });
  } catch (error) {
    log.error('List attachments failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    res.status(500).json({
      success: false,
      error: { code: 'INTERNAL_ERROR', message: 'Failed to list attachments' },
    });
  }
});

// ─── GET /:attachmentId — Get single attachment detail ────────────────────────

router.get('/:attachmentId', async (req: Request, res: Response) => {
  try {
    if (!(await requireProjectPermission(req, res, 'attachment:read'))) return;

    const client = getClient();
    const attachment = await loadScopedAttachment(req, res, client);
    if (!attachment) {
      return;
    }

    res.json({
      success: true,
      data: { attachment: serializeAttachment(attachment) },
    });
  } catch (error) {
    log.error('Get attachment failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    res.status(500).json({
      success: false,
      error: { code: 'INTERNAL_ERROR', message: 'Failed to get attachment' },
    });
  }
});

// ─── GET /:attachmentId/url — Get download URL ───────────────────────────────

router.get('/:attachmentId/url', async (req: Request, res: Response) => {
  try {
    if (!(await requireProjectPermission(req, res, 'attachment:read'))) return;

    const { attachmentId } = req.params;
    const disposition = (req.query.disposition as 'inline' | 'attachment') || undefined;
    const expiresIn = req.query.expiresIn ? parseInt(req.query.expiresIn as string) : undefined;

    const client = getClient();
    const attachment = await loadScopedAttachment(req, res, client);
    if (!attachment) {
      return;
    }
    const tenantId = getCurrentTenantId()!;
    const url = await client.getDownloadUrl(attachmentId, tenantId, { disposition, expiresIn });

    if (!url) {
      res.status(404).json({
        success: false,
        error: { code: 'NOT_FOUND', message: `Attachment not found: ${attachmentId}` },
      });
      return;
    }

    res.json({
      success: true,
      data: {
        url,
        expiresInSeconds: expiresIn ?? 3600,
      },
    });
  } catch (error) {
    log.error('Get download URL failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    res.status(500).json({
      success: false,
      error: { code: 'INTERNAL_ERROR', message: 'Failed to get download URL' },
    });
  }
});

// ─── POST /:attachmentId/retry — Retry failed processing ─────────────────────

router.post('/:attachmentId/retry', async (req: Request, res: Response) => {
  try {
    if (!(await requireProjectPermission(req, res, 'attachment:write'))) return;

    const client = getClient();
    const attachment = await loadScopedAttachment(req, res, client);
    if (!attachment) {
      return;
    }
    const tenantId = getCurrentTenantId()!;
    const result = await client.retry(attachment._id, tenantId);

    if (!result.success) {
      res.status(409).json({
        success: false,
        error: result.error,
      });
      return;
    }

    res.json({
      success: true,
      data: { retryCount: result.retryCount },
    });
  } catch (error) {
    log.error('Retry attachment failed', {
      error: error instanceof Error ? error.message : String(error),
      attachmentId: req.params.attachmentId,
      sessionId: req.params.sessionId,
    });
    res.status(500).json({
      success: false,
      error: { code: 'INTERNAL_ERROR', message: 'Failed to retry attachment processing' },
    });
  }
});

// ─── GET /:attachmentId/status — Get processing status ───────────────────────

router.get('/:attachmentId/status', async (req: Request, res: Response) => {
  try {
    if (!(await requireProjectPermission(req, res, 'attachment:read'))) return;

    const client = getClient();
    const attachment = await loadScopedAttachment(req, res, client);
    if (!attachment) {
      return;
    }

    res.json({
      success: true,
      data: {
        scanStatus: attachment.scanStatus,
        processingStatus: attachment.processingStatus,
        embeddingStatus: attachment.embeddingStatus,
      },
    });
  } catch (error) {
    log.error('Get attachment status failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    res.status(500).json({
      success: false,
      error: { code: 'INTERNAL_ERROR', message: 'Failed to get attachment status' },
    });
  }
});

// ─── DELETE /:attachmentId — Delete single attachment ─────────────────────────

router.delete('/:attachmentId', async (req: Request, res: Response) => {
  try {
    if (!(await requireProjectPermission(req, res, 'attachment:delete'))) return;

    const client = getClient();
    const attachment = await loadScopedAttachment(req, res, client);
    if (!attachment) {
      return;
    }
    const tenantId = getCurrentTenantId()!;
    const attachmentId = attachment._id;
    await client.deleteAttachment(attachmentId, tenantId);

    res.status(204).send();
  } catch (error) {
    log.error('Delete attachment failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    res.status(500).json({
      success: false,
      error: { code: 'INTERNAL_ERROR', message: 'Failed to delete attachment' },
    });
  }
});

// ─── Multipart Parsing Helper ─────────────────────────────────────────────────

interface ParsedUpload {
  success: true;
  buffer: Buffer;
  filename: string;
  mimeType: string;
}

interface ParsedUploadError {
  success: false;
  error: { code: string; message: string };
}

/**
 * Parse a multipart/form-data request using Busboy.
 * Extracts the first `file` field and collects it into a Buffer.
 * Rejects if no file field is found or the stream errors.
 */
function parseMultipartUpload(req: Request): Promise<ParsedUpload | ParsedUploadError> {
  return new Promise((resolve) => {
    let resolved = false;

    try {
      const bb = Busboy({
        headers: req.headers,
        limits: { fileSize: MAX_UPLOAD_BYTES, files: 1 },
      });

      bb.on(
        'file',
        (
          _fieldname: string,
          stream: Readable,
          info: { filename: string; encoding: string; mimeType: string },
        ) => {
          const { filename, mimeType } = info;
          const chunks: Buffer[] = [];

          stream.on('data', (chunk: Buffer) => {
            chunks.push(chunk);
          });

          stream.on('end', () => {
            if (!resolved) {
              resolved = true;
              resolve({
                success: true,
                buffer: Buffer.concat(chunks),
                filename: filename || 'upload',
                mimeType: mimeType || 'application/octet-stream',
              });
            }
          });

          stream.on('error', (err: Error) => {
            if (!resolved) {
              resolved = true;
              resolve({
                success: false,
                error: { code: 'STREAM_ERROR', message: err.message },
              });
            }
          });

          // Busboy emits 'limit' on the file stream when fileSize is exceeded
          stream.on('limit', () => {
            if (!resolved) {
              resolved = true;
              resolve({
                success: false,
                error: {
                  code: 'PAYLOAD_TOO_LARGE',
                  message: `File exceeds maximum size of ${MAX_UPLOAD_BYTES} bytes`,
                },
              });
            }
          });
        },
      );

      bb.on('error', (err: Error) => {
        if (!resolved) {
          resolved = true;
          resolve({
            success: false,
            error: { code: 'PARSE_ERROR', message: `Multipart parsing failed: ${err.message}` },
          });
        }
      });

      bb.on('close', () => {
        if (!resolved) {
          resolved = true;
          resolve({
            success: false,
            error: { code: 'MISSING_FILE', message: 'No "file" field found in multipart upload' },
          });
        }
      });

      req.pipe(bb);
    } catch (err) {
      if (!resolved) {
        resolved = true;
        resolve({
          success: false,
          error: {
            code: 'PARSE_ERROR',
            message: `Multipart parsing failed: ${err instanceof Error ? err.message : 'Unknown error'}`,
          },
        });
      }
    }
  });
}

export default router;
