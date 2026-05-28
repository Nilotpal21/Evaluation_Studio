/**
 * Admin API Routes — Tenant Attachment Configuration
 *
 * Admin-only routes for reading and updating per-tenant attachment config.
 * Uses the same internal auth pattern as attachment routes (X-Tenant-Id header).
 *
 * All queries are tenant-scoped: findOne({ tenantId }), never findById().
 *
 * Response format: { success: true, data } or { success: false, error: { code, message } }
 */

import { Router, type Request, type Response } from 'express';
import { createLogger } from '@abl/compiler/platform';
import { requireInternalAuth, type InternalRequest } from './attachments.js';
import {
  TenantConfigService,
  type TenantAttachmentConfigUpdate,
} from '../services/tenant-config-service.js';

const log = createLogger('multimodal-admin');

// =============================================================================
// VALIDATION CONSTANTS
// =============================================================================

/** Minimum allowed max file size: 1 KB (sanity floor) */
const MIN_MAX_FILE_SIZE_BYTES = 1024;

/** Maximum allowed max file size: 500 MB (sanity ceiling) */
const MAX_MAX_FILE_SIZE_BYTES = 500 * 1024 * 1024;

/** Maximum number of MIME type entries in allowedMimeTypes or blockedMimeTypes */
const MAX_MIME_TYPE_LIST_LENGTH = 200;

/** Maximum allowed maxAttachmentsPerSession */
const MAX_ATTACHMENTS_PER_SESSION_CEILING = 10_000;

/** Maximum allowed maxTotalStorageBytes: 1 TB */
const MAX_TOTAL_STORAGE_BYTES_CEILING = 1024 * 1024 * 1024 * 1024;

const MIN_RETENTION_DAYS = 1;
const MAX_RETENTION_DAYS = 365;
const RETENTION_CATEGORIES = ['image', 'document', 'audio', 'video'] as const;
const RETENTION_CATEGORIES_SET = new Set<string>(RETENTION_CATEGORIES);

// =============================================================================
// ROUTE FACTORY
// =============================================================================

/**
 * Creates the admin router with injected TenantConfigService.
 */
export function createAdminRouter(configService: TenantConfigService): Router {
  const router = Router();

  // Apply internal auth to all admin routes
  router.use(requireInternalAuth);

  // ---------------------------------------------------------------------------
  // GET /admin/config/:tenantId — Get tenant attachment configuration
  // ---------------------------------------------------------------------------

  router.get('/config/:tenantId', async (req: Request, res: Response): Promise<void> => {
    try {
      const callerTenantId = (req as InternalRequest).tenantId;
      const { tenantId } = req.params;

      // Verify the caller is authorized for this tenant
      if (callerTenantId !== tenantId) {
        res.status(404).json({
          success: false,
          error: { code: 'NOT_FOUND', message: 'Configuration not found' },
        });
        return;
      }

      const config = await configService.getConfig(tenantId);

      res.status(200).json({ success: true, data: { config } });
    } catch (err) {
      log.error('Get config failed', { error: err instanceof Error ? err.message : String(err) });
      res.status(500).json({
        success: false,
        error: { code: 'INTERNAL_ERROR', message: 'Failed to retrieve configuration' },
      });
    }
  });

  // ---------------------------------------------------------------------------
  // PUT /admin/config/:tenantId — Update tenant attachment configuration
  // ---------------------------------------------------------------------------

  router.put('/config/:tenantId', async (req: Request, res: Response): Promise<void> => {
    try {
      const callerTenantId = (req as InternalRequest).tenantId;
      const { tenantId } = req.params;

      // Verify the caller is authorized for this tenant
      if (callerTenantId !== tenantId) {
        res.status(404).json({
          success: false,
          error: { code: 'NOT_FOUND', message: 'Configuration not found' },
        });
        return;
      }

      // Validate the request body
      const validationError = validateConfigUpdate(req.body);
      if (validationError) {
        res.status(400).json({
          success: false,
          error: { code: 'VALIDATION_ERROR', message: validationError },
        });
        return;
      }

      // Build a sanitized update object with only known fields
      const updates = buildSanitizedUpdate(req.body);

      const config = await configService.updateConfig(tenantId, updates);

      res.status(200).json({ success: true, data: { config } });
    } catch (err) {
      log.error('Update config failed', {
        error: err instanceof Error ? err.message : String(err),
      });
      res.status(500).json({
        success: false,
        error: { code: 'INTERNAL_ERROR', message: 'Failed to update configuration' },
      });
    }
  });

  return router;
}

// =============================================================================
// VALIDATION HELPERS
// =============================================================================

/**
 * Validates the config update request body.
 * Returns an error message string if invalid, or null if valid.
 */
function validateConfigUpdate(body: Record<string, unknown>): string | null {
  if (typeof body !== 'object' || body === null) {
    return 'Request body must be a JSON object';
  }

  if (body.maxFileSizeBytes !== undefined) {
    if (typeof body.maxFileSizeBytes !== 'number' || !Number.isFinite(body.maxFileSizeBytes)) {
      return 'maxFileSizeBytes must be a finite number';
    }
    if (body.maxFileSizeBytes < MIN_MAX_FILE_SIZE_BYTES) {
      return `maxFileSizeBytes must be at least ${MIN_MAX_FILE_SIZE_BYTES} bytes`;
    }
    if (body.maxFileSizeBytes > MAX_MAX_FILE_SIZE_BYTES) {
      return `maxFileSizeBytes must not exceed ${MAX_MAX_FILE_SIZE_BYTES} bytes`;
    }
  }

  if (body.allowedMimeTypes !== undefined) {
    if (!Array.isArray(body.allowedMimeTypes)) {
      return 'allowedMimeTypes must be an array of strings';
    }
    if (body.allowedMimeTypes.length > MAX_MIME_TYPE_LIST_LENGTH) {
      return `allowedMimeTypes must not exceed ${MAX_MIME_TYPE_LIST_LENGTH} entries`;
    }
    if (!body.allowedMimeTypes.every((t: unknown) => typeof t === 'string' && t.length > 0)) {
      return 'Each entry in allowedMimeTypes must be a non-empty string';
    }
  }

  if (body.blockedMimeTypes !== undefined) {
    if (!Array.isArray(body.blockedMimeTypes)) {
      return 'blockedMimeTypes must be an array of strings';
    }
    if (body.blockedMimeTypes.length > MAX_MIME_TYPE_LIST_LENGTH) {
      return `blockedMimeTypes must not exceed ${MAX_MIME_TYPE_LIST_LENGTH} entries`;
    }
    if (!body.blockedMimeTypes.every((t: unknown) => typeof t === 'string' && t.length > 0)) {
      return 'Each entry in blockedMimeTypes must be a non-empty string';
    }
  }

  for (const boolField of ['scanEnabled', 'processingEnabled', 'embeddingEnabled'] as const) {
    if (body[boolField] !== undefined && typeof body[boolField] !== 'boolean') {
      return `${boolField} must be a boolean`;
    }
  }

  if (body.maxAttachmentsPerSession !== undefined) {
    if (
      typeof body.maxAttachmentsPerSession !== 'number' ||
      !Number.isInteger(body.maxAttachmentsPerSession) ||
      body.maxAttachmentsPerSession < 1
    ) {
      return 'maxAttachmentsPerSession must be a positive integer';
    }
    if (body.maxAttachmentsPerSession > MAX_ATTACHMENTS_PER_SESSION_CEILING) {
      return `maxAttachmentsPerSession must not exceed ${MAX_ATTACHMENTS_PER_SESSION_CEILING}`;
    }
  }

  if (body.maxTotalStorageBytes !== undefined) {
    if (
      typeof body.maxTotalStorageBytes !== 'number' ||
      !Number.isFinite(body.maxTotalStorageBytes) ||
      body.maxTotalStorageBytes < 1
    ) {
      return 'maxTotalStorageBytes must be a positive number';
    }
    if (body.maxTotalStorageBytes > MAX_TOTAL_STORAGE_BYTES_CEILING) {
      return `maxTotalStorageBytes must not exceed ${MAX_TOTAL_STORAGE_BYTES_CEILING} bytes`;
    }
  }

  // retentionDays validation
  if (body.retentionDays !== undefined) {
    if (typeof body.retentionDays !== 'object' || body.retentionDays === null) {
      return 'retentionDays must be an object';
    }
    for (const key of Object.keys(body.retentionDays)) {
      if (!RETENTION_CATEGORIES_SET.has(key)) {
        return 'retentionDays: contains unknown category';
      }
      const val = (body.retentionDays as Record<string, unknown>)[key];
      if (
        !Number.isInteger(val) ||
        (val as number) < MIN_RETENTION_DAYS ||
        (val as number) > MAX_RETENTION_DAYS
      ) {
        return `retentionDays.${key} must be an integer between ${MIN_RETENTION_DAYS} and ${MAX_RETENTION_DAYS}`;
      }
    }
  }

  return null;
}

/**
 * Builds a sanitized update object containing only known, safe fields.
 * Strips any extra fields the client may have sent.
 */
function buildSanitizedUpdate(body: Record<string, unknown>): TenantAttachmentConfigUpdate {
  const updates: TenantAttachmentConfigUpdate = {};

  if (body.maxFileSizeBytes !== undefined) {
    updates.maxFileSizeBytes = body.maxFileSizeBytes as number;
  }
  if (body.allowedMimeTypes !== undefined) {
    updates.allowedMimeTypes = body.allowedMimeTypes as string[];
  }
  if (body.blockedMimeTypes !== undefined) {
    updates.blockedMimeTypes = body.blockedMimeTypes as string[];
  }
  if (body.scanEnabled !== undefined) {
    updates.scanEnabled = body.scanEnabled as boolean;
  }
  if (body.processingEnabled !== undefined) {
    updates.processingEnabled = body.processingEnabled as boolean;
  }
  if (body.embeddingEnabled !== undefined) {
    updates.embeddingEnabled = body.embeddingEnabled as boolean;
  }
  if (body.maxAttachmentsPerSession !== undefined) {
    updates.maxAttachmentsPerSession = body.maxAttachmentsPerSession as number;
  }
  if (body.maxTotalStorageBytes !== undefined) {
    updates.maxTotalStorageBytes = body.maxTotalStorageBytes as number;
  }
  if (body.retentionDays) {
    const rd = body.retentionDays as Record<string, unknown>;
    const retentionDays: Record<string, number> = {};
    for (const cat of RETENTION_CATEGORIES) {
      if (rd[cat] !== undefined) {
        retentionDays[cat] = rd[cat] as number;
      }
    }
    updates.retentionDays = retentionDays as typeof updates.retentionDays;
  }

  return updates;
}
