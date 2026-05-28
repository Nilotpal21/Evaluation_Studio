/**
 * Platform Admin — Tenant Attachment Config Proxy Routes
 *
 * Proxies attachment configuration requests to the multimodal-service's
 * admin router. Platform admins can view and update per-tenant attachment
 * settings (file size limits, MIME types, scan/processing/embedding toggles,
 * retention policies).
 *
 * Key rules:
 * - All routes require `requirePlatformAdmin()` — only super-admins
 * - `tenantId` comes from the query string `?tenantId=<id>`
 * - PUT mutations are audit-logged with `platform-admin:` prefix
 * - Request body is validated with Zod before proxying
 *
 * Mount: /api/platform/admin/tenant-attachment-config
 */

import { Router } from 'express';
import { z } from 'zod';
import { requirePlatformAdmin, requirePlatformAdminIp } from '@agent-platform/shared-auth';
import { getCurrentRequestId } from '@agent-platform/shared-observability';
import { createLogger } from '@abl/compiler/platform';
import { getConfig } from '../config/index.js';
import { platformAdminAuthMiddleware } from '../middleware/auth.js';
import { writeAuditLog } from '../repos/auth-repo.js';
import { tenantRateLimit } from '../middleware/rate-limiter.js';

const log = createLogger('platform-admin-attachment-config');
const router: ReturnType<typeof Router> = Router();

// ─── Middleware ────────────────────────────────────────────────────────────

router.use(platformAdminAuthMiddleware);
router.use(tenantRateLimit('request'));
router.use(requirePlatformAdmin());
router.use(requirePlatformAdminIp(() => getConfig().security.platformAdminAllowedIps));

// ─── Constants ────────────────────────────────────────────────────────────

const MULTIMODAL_SERVICE_URL =
  process.env.MULTIMODAL_SERVICE_URL || 'http://multimodal-service:3006';

/** Minimum allowed max file size: 1 KB */
const MIN_MAX_FILE_SIZE_BYTES = 1024;

/** Maximum allowed max file size: 500 MB */
const MAX_MAX_FILE_SIZE_BYTES = 500 * 1024 * 1024;

/** Maximum MIME type entries per list */
const MAX_MIME_TYPE_LIST_LENGTH = 200;

/** Maximum attachments per session ceiling */
const MAX_ATTACHMENTS_PER_SESSION_CEILING = 10_000;

/** Maximum total storage: 1 TB */
const MAX_TOTAL_STORAGE_BYTES_CEILING = 1024 * 1024 * 1024 * 1024;

const MIN_RETENTION_DAYS = 1;
const MAX_RETENTION_DAYS = 365;

// ─── Validation ───────────────────────────────────────────────────────────

const tenantIdSchema = z.string().min(1, 'tenantId is required');

const retentionDaysSchema = z
  .record(
    z.enum(['image', 'document', 'audio', 'video']),
    z.number().int().min(MIN_RETENTION_DAYS).max(MAX_RETENTION_DAYS),
  )
  .optional();

const attachmentConfigUpdateSchema = z
  .object({
    maxFileSizeBytes: z
      .number()
      .min(MIN_MAX_FILE_SIZE_BYTES)
      .max(MAX_MAX_FILE_SIZE_BYTES)
      .optional(),
    allowedMimeTypes: z.array(z.string().min(1)).max(MAX_MIME_TYPE_LIST_LENGTH).optional(),
    blockedMimeTypes: z.array(z.string().min(1)).max(MAX_MIME_TYPE_LIST_LENGTH).optional(),
    scanEnabled: z.boolean().optional(),
    processingEnabled: z.boolean().optional(),
    embeddingEnabled: z.boolean().optional(),
    maxAttachmentsPerSession: z
      .number()
      .int()
      .min(1)
      .max(MAX_ATTACHMENTS_PER_SESSION_CEILING)
      .optional(),
    maxTotalStorageBytes: z.number().min(1).max(MAX_TOTAL_STORAGE_BYTES_CEILING).optional(),
    retentionDays: retentionDaysSchema,
  })
  .strict();

// ─── Helpers ──────────────────────────────────────────────────────────────

/**
 * Proxy a request to the multimodal-service admin API.
 * Sets X-Tenant-Id header for internal auth.
 */
async function proxyToMultimodal(
  tenantId: string,
  method: 'GET' | 'PUT',
  body?: unknown,
): Promise<{ status: number; data: unknown }> {
  const url = `${MULTIMODAL_SERVICE_URL}/admin/config/${encodeURIComponent(tenantId)}`;

  const headers: Record<string, string> = {
    'X-Tenant-Id': tenantId,
    'Content-Type': 'application/json',
  };

  const fetchOptions: RequestInit = {
    method,
    headers,
    signal: AbortSignal.timeout(10_000),
  };

  if (method === 'PUT' && body !== undefined) {
    fetchOptions.body = JSON.stringify(body);
  }

  const res = await fetch(url, fetchOptions);
  const data = await res.json();
  return { status: res.status, data };
}

// ─── GET / — Get tenant attachment config ─────────────────────────────────

router.get('/', async (req, res) => {
  const requestId = getCurrentRequestId();
  try {
    const tenantIdParsed = tenantIdSchema.safeParse(req.query.tenantId);
    if (!tenantIdParsed.success) {
      res.status(400).json({
        success: false,
        error: { code: 'VALIDATION_ERROR', message: 'tenantId query parameter is required' },
      });
      return;
    }

    const tenantId = tenantIdParsed.data;
    const result = await proxyToMultimodal(tenantId, 'GET');

    res.status(result.status).json(result.data);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    log.error('Failed to proxy GET attachment config', { error: message, requestId });
    res.status(502).json({
      success: false,
      error: { code: 'PROXY_ERROR', message: 'Failed to connect to multimodal service' },
    });
  }
});

// ─── PUT / — Update tenant attachment config ──────────────────────────────

router.put('/', async (req, res) => {
  const requestId = getCurrentRequestId();
  try {
    const tenantIdParsed = tenantIdSchema.safeParse(req.query.tenantId);
    if (!tenantIdParsed.success) {
      res.status(400).json({
        success: false,
        error: { code: 'VALIDATION_ERROR', message: 'tenantId query parameter is required' },
      });
      return;
    }

    const tenantId = tenantIdParsed.data;

    // Validate request body
    const bodyParsed = attachmentConfigUpdateSchema.safeParse(req.body);
    if (!bodyParsed.success) {
      res.status(400).json({
        success: false,
        error: {
          code: 'VALIDATION_ERROR',
          message: bodyParsed.error.issues.map((i) => i.message).join('; '),
        },
      });
      return;
    }

    const result = await proxyToMultimodal(tenantId, 'PUT', bodyParsed.data);

    // Audit log on successful update
    if (result.status >= 200 && result.status < 300) {
      const adminUserId = req.tenantContext?.userId ?? 'unknown';
      writeAuditLog({
        action: 'platform-admin:update-attachment-config',
        userId: adminUserId,
        tenantId,
        metadata: {
          updatedFields: Object.keys(bodyParsed.data),
          requestId,
        },
      });
    }

    res.status(result.status).json(result.data);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    log.error('Failed to proxy PUT attachment config', { error: message, requestId });
    res.status(502).json({
      success: false,
      error: { code: 'PROXY_ERROR', message: 'Failed to connect to multimodal service' },
    });
  }
});

export default router;
