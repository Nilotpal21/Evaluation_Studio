/**
 * Attachment download router — token-gated, no auth middleware required.
 *
 * Extracted from index.ts so it can be tested independently and mounted
 * unconditionally (no Redis dependency).
 */

import express, { type Request, type Response } from 'express';
import { createLogger } from '@abl/compiler/platform';
import { verifyAttachmentToken } from '../lib/attachment-token.js';
import type { FileStorage } from '../storage/storage-factory.js';

const log = createLogger('workflow-engine:attachments');

// Allowlist of MIME types we'll happily send back inline. Everything outside
// this list — including text/html, image/svg+xml, application/xml — is rewritten
// to application/octet-stream so the browser saves the file instead of rendering
// it. Files still download correctly; only the rendering mode changes.
// This protects against an attacker who has obtained a valid attachment URL
// from flipping `m=application/pdf` to `m=text/html` and triggering script
// execution against attacker-influenced content.
export const SAFE_INLINE_MIME_TYPES = new Set([
  'application/pdf',
  'application/octet-stream',
  'application/json',
  'application/zip',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'text/plain',
  'text/csv',
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'audio/mpeg',
  'audio/wav',
  'audio/ogg',
  'video/mp4',
  'video/webm',
]);

export function sanitizeInlineMimeType(mimeType: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9.+-]*\/[A-Za-z0-9][A-Za-z0-9.+-]*$/.test(mimeType)) {
    return 'application/octet-stream';
  }
  return SAFE_INLINE_MIME_TYPES.has(mimeType.toLowerCase()) ? mimeType : 'application/octet-stream';
}

export function sanitizeAttachmentFilename(fileName: string): string {
  const sanitized = fileName
    .replace(/[\r\n"]/g, '_')
    .replace(/[^A-Za-z0-9._ -]/g, '_')
    .trim()
    .slice(0, 180);

  return sanitized || 'attachment';
}

/**
 * Create an Express router that serves attachment downloads.
 *
 * GET /:id?token=<hmac>&f=<filename>&m=<mimetype>
 *
 * Verifies the HMAC token (timing-safe), checks expiry, asserts key/tenant
 * prefix consistency, then streams the bytes from the provided storage backend.
 * No DB lookup needed — the storage key is embedded in the signed token payload.
 *
 * Mount as: app.use('/attachments', createAttachmentsRouter(storage))
 */
export function createAttachmentsRouter(storage: FileStorage): express.Router {
  const router = express.Router();

  router.get('/:id', async (req: Request, res: Response) => {
    const token = typeof req.query.token === 'string' ? req.query.token : '';
    const fileNameQ = typeof req.query.f === 'string' ? req.query.f : 'attachment';
    const mimeTypeQ = typeof req.query.m === 'string' ? req.query.m : 'application/octet-stream';

    if (!token) {
      res.status(401).json({ success: false, error: 'Missing token' });
      return;
    }

    const payload = verifyAttachmentToken(token);
    if (!payload) {
      res.status(403).json({ success: false, error: 'Invalid or expired token' });
      return;
    }

    let buf: Buffer;
    try {
      buf = await storage.download(payload.k);
    } catch (err) {
      log.warn('attachment-not-found', {
        key: payload.k,
        err: err instanceof Error ? err.message : String(err),
      });
      res.status(404).json({ success: false, error: 'Attachment not found' });
      return;
    }

    res.setHeader('Content-Type', sanitizeInlineMimeType(mimeTypeQ));
    res.setHeader(
      'Content-Disposition',
      `inline; filename="${encodeURIComponent(sanitizeAttachmentFilename(fileNameQ))}"`,
    );
    res.setHeader('Content-Length', buf.length);
    res.setHeader('Cache-Control', 'private, max-age=3600');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    // nosemgrep: javascript.express.security.audit.xss.direct-response-write.direct-response-write -- Attachment bytes are served with sanitized headers, private cache, nosniff, and HMAC-verified token.
    res.end(buf);
  });

  return router;
}
