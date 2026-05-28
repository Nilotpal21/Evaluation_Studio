/**
 * Citation Download Route — Public Endpoint
 *
 * Serves document downloads for citation links embedded in search results.
 * Uses the same storage-agnostic pattern as document-download.ts:
 *   JWT token contains documentId → look up sourceUrl from MongoDB → downloadDocumentContent()
 *
 * This approach works regardless of storage backend (S3, local, MinIO, HTTP)
 * and is multi-pod safe because it reads from shared MongoDB, not from
 * any path embedded in the token.
 *
 * Authentication is via a purpose-scoped JWT (citation token), NOT bearer auth.
 * Mounted BEFORE authMiddleware in server.ts.
 */

import { Router } from 'express';
import { z } from 'zod';
import path from 'path';
import rateLimit from 'express-rate-limit';
import { createLogger } from '@abl/compiler/platform';
import { verifyCitationToken, AuthError } from '@agent-platform/shared-auth';
import {
  validateTenantOwnership,
  checkClickLimit,
  CitationError,
} from '../services/citation-token.service.js';
import { downloadDocumentContent } from '../services/ingestion/download-document.js';
import { getLazyModel } from '../db/index.js';
import type { ISearchDocument } from '@agent-platform/database';
import type { RedisClient } from '@agent-platform/redis';

const log = createLogger('citation-download');
const SearchDocument = getLazyModel<ISearchDocument>('SearchDocument');

const tokenParamSchema = z.object({
  token: z.string().min(1),
});

const citationLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (_req, res) => {
    res.status(429).json({
      success: false,
      error: { code: 'RATE_LIMITED', message: 'Too many requests. Try again later.' },
    });
  },
});

// ─── Content-type map ─────────────────────────────────────────────────────────
const CONTENT_TYPES: Record<string, string> = {
  '.pdf': 'application/pdf',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.txt': 'text/plain',
  '.html': 'text/html',
  '.htm': 'text/html',
  '.csv': 'text/csv',
  '.json': 'application/json',
  '.md': 'text/markdown',
  '.xls': 'application/vnd.ms-excel',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.ppt': 'application/vnd.ms-powerpoint',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
};

export interface CitationStorageDeps {
  getRedis: () => RedisClient;
}

export function createCitationDownloadRouter(deps: CitationStorageDeps): Router {
  const router = Router();
  router.use(citationLimiter);

  const secret = process.env.CITATION_SIGNING_SECRET || process.env.JWT_SECRET || '';

  router.get('/:token', async (req, res) => {
    try {
      // Validate token param
      const params = tokenParamSchema.safeParse(req.params);
      if (!params.success) {
        return res.status(400).json({
          success: false,
          error: { code: 'INVALID_TOKEN', message: 'Missing or invalid token parameter' },
        });
      }

      // Verify JWT
      const payload = verifyCitationToken(params.data.token, secret);

      // Validate tenant ownership using sourceKey from token
      validateTenantOwnership(payload.tenantId, payload.sourceKey);

      // Check click limits for click-limited mode
      if (payload.linkMode === 'click_limited' && payload.maxClicks) {
        const redis = deps.getRedis();
        await checkClickLimit(redis, payload.jti, payload.maxClicks, payload.exp);
      }

      // ─── Look up document from MongoDB (same pattern as document-download.ts) ───
      // This is the industry-ready approach: token has documentId, we look up
      // the current sourceUrl from MongoDB. Works regardless of storage backend
      // and survives storage migrations (local → S3) without reindexing.
      const document = await SearchDocument.findOne({
        _id: payload.documentId,
        tenantId: payload.tenantId,
      }).lean();

      if (!document) {
        return res.status(404).json({
          success: false,
          error: { code: 'NOT_FOUND', message: 'Citation document not found' },
        });
      }

      if (!document.sourceUrl) {
        return res.status(404).json({
          success: false,
          error: { code: 'NOT_FOUND', message: 'Document has no source file' },
        });
      }

      log.info('Citation download', {
        documentId: payload.documentId,
        indexId: payload.indexId,
        linkMode: payload.linkMode,
        sourceUrl: document.sourceUrl,
      });

      // Determine content type and filename from document record
      const fileName =
        document.originalReference || document.name || `document-${payload.documentId}`;
      const ext = path.extname(fileName).toLowerCase();
      const contentType = document.contentType || CONTENT_TYPES[ext] || 'application/octet-stream';

      // ─── Serve the file ─────────────────────────────────────────────────────
      // For local files: use res.sendFile() which supports Accept-Ranges (byte
      // range requests). Chrome's PDF viewer REQUIRES range support to display
      // inline — without it, Chrome downloads instead of displaying.
      // For S3/HTTP files: download to buffer and send (no local path available).
      const sourceUrl = document.sourceUrl;

      if (sourceUrl.startsWith('/uploads/') || sourceUrl.startsWith('file://')) {
        // Local file — resolve absolute path and use sendFile for range support
        const { getConfig } = await import('../config/index.js');
        const config = getConfig();
        let filePath: string;

        if (sourceUrl.startsWith('file://')) {
          filePath = sourceUrl.slice('file://'.length);
        } else {
          const basePath = path.resolve(config.storage.basePath || './uploads');
          const relativePath = sourceUrl.substring('/uploads/'.length);
          filePath = path.join(basePath, relativePath);
        }

        // Security: path traversal guard
        const resolvedBase = path.resolve(config.storage.basePath || './uploads');
        const resolvedFile = path.resolve(filePath);
        if (!resolvedFile.startsWith(resolvedBase)) {
          return res.status(404).json({
            success: false,
            error: { code: 'NOT_FOUND', message: 'Citation not found' },
          });
        }

        res.setHeader('Content-Type', contentType);
        res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(fileName)}"`);
        return res.sendFile(resolvedFile, (err) => {
          if (err && !res.headersSent) {
            log.error('Citation local file send error', {
              error: err instanceof Error ? err.message : String(err),
              filePath: resolvedFile,
            });
            res.status(404).json({
              success: false,
              error: { code: 'NOT_FOUND', message: 'Citation document not found' },
            });
          }
        });
      }

      // S3 or HTTP — download to buffer and send
      const fileBuffer = await downloadDocumentContent(sourceUrl);
      res.setHeader('Content-Type', contentType);
      res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(fileName)}"`);
      res.setHeader('Content-Length', fileBuffer.length);
      return res.send(fileBuffer);
    } catch (error) {
      if (error instanceof AuthError) {
        if (error.code === 'EXPIRED_TOKEN') {
          return res.status(410).json({
            success: false,
            error: { code: 'CITATION_EXPIRED', message: 'Citation link has expired' },
          });
        }
        return res.status(400).json({
          success: false,
          error: { code: 'INVALID_TOKEN', message: 'Malformed or invalid citation token' },
        });
      }
      if (error instanceof CitationError) {
        if (error.code === 'CITATION_EXHAUSTED') {
          return res.status(410).json({
            success: false,
            error: { code: 'CITATION_EXHAUSTED', message: 'Maximum clicks reached' },
          });
        }
        if (error.code === 'CITATION_EXPIRED') {
          return res.status(410).json({
            success: false,
            error: { code: 'CITATION_EXPIRED', message: 'Citation link has expired' },
          });
        }
        if (error.code === 'TENANT_VIOLATION') {
          // Return 404 — don't leak tenant violation info
          return res.status(404).json({
            success: false,
            error: { code: 'NOT_FOUND', message: 'Citation not found' },
          });
        }
      }

      const msg = error instanceof Error ? error.message : String(error);
      log.error('Citation download error', { error: msg });
      return res.status(500).json({
        success: false,
        error: { code: 'DOWNLOAD_ERROR', message: 'Failed to generate download URL' },
      });
    }
  });

  return router;
}
