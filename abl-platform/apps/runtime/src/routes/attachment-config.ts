/**
 * Project Attachment Config Route
 *
 * Per-project attachment configuration (file limits, MIME types, PII policy).
 * Mounted at /api/projects/:projectId/attachment-config
 *
 * GET  / — Get resolved config (project → tenant → defaults)
 * PUT  / — Upsert project-level overrides
 */

import { type Router as RouterType } from 'express';
import { createOpenAPIRouter, getValidatedRequestData } from '@agent-platform/openapi/express';
import { z } from 'zod';
import { ProjectAttachmentConfig } from '@agent-platform/database';
import { authMiddleware } from '../middleware/auth.js';
import { requireProjectPermission } from '../middleware/rbac.js';
import { requireProjectScope } from '@agent-platform/shared-auth';
import { tenantRateLimit } from '../middleware/rate-limiter.js';
import { createLogger } from '@abl/compiler/platform';
import { resolveAttachmentConfig } from '../attachments/attachment-config-resolver.js';
import { runtimeRegistry } from '../openapi/registry.js';

const log = createLogger('attachment-config-route');
const openapi = createOpenAPIRouter(runtimeRegistry, {
  basePath: '/api/projects/:projectId/attachment-config',
  tags: ['Attachment Config'],
  validateRequests: true,
  wrapAsyncHandlers: true,
  onValidationError: (_error, _req, res) => {
    res.status(400).json({
      success: false,
      error: {
        code: 'VALIDATION_ERROR',
        message: 'Invalid attachment config',
      },
    });
  },
});
const router: RouterType = openapi.router;

router.use(authMiddleware);
router.use(requireProjectScope('projectId'));
router.use(tenantRateLimit('request'));

// =============================================================================
// SCHEMAS
// =============================================================================

/** 500 MB upper bound — no single file larger than this is reasonable */
const MAX_FILE_SIZE_BYTES = 500 * 1024 * 1024;

/** MIME type format: type/subtype where subtype may contain letters, digits, dots, hyphens, plus signs, or wildcard */
const MIME_TYPE_REGEX = /^[a-z]+\/([\w.+-]+|\*)$/;

const attachmentConfigUpdateSchema = z.object({
  enabled: z.boolean().nullable().optional(),
  maxFileSizeBytes: z.number().int().min(0).max(MAX_FILE_SIZE_BYTES).nullable().optional(),
  allowedMimeTypes: z
    .array(z.string().min(1).regex(MIME_TYPE_REGEX, 'Invalid MIME type format'))
    .max(50)
    .nullable()
    .optional(),
  piiPolicy: z.enum(['redact', 'block', 'allow']).nullable().optional(),
  defaultProcessingMode: z.enum(['full', 'metadata_only', 'skip']).nullable().optional(),
});

const attachmentConfigParamsSchema = z.object({
  projectId: z.string().min(1).describe('Project ID'),
});

const attachmentConfigResolvedSchema = z.object({
  enabled: z.boolean(),
  maxFileSizeBytes: z.number().int(),
  maxFilesPerSession: z.number().int(),
  allowedMimeTypes: z.array(z.string()),
  piiPolicy: z.enum(['redact', 'block', 'allow']),
  defaultProcessingMode: z.enum(['full', 'metadata_only', 'skip']),
});

const attachmentConfigResponseSchema = z.object({
  success: z.literal(true),
  data: z.object({
    resolved: attachmentConfigResolvedSchema,
    projectOverrides: attachmentConfigUpdateSchema.nullable(),
  }),
});

// =============================================================================
// GET / — Get resolved config
// =============================================================================

openapi.route(
  'get',
  '/',
  {
    summary: 'Get resolved attachment config',
    description:
      'Fetch the resolved attachment configuration for a project, including project overrides and inherited defaults.',
    params: attachmentConfigParamsSchema,
    response: attachmentConfigResponseSchema,
  },
  async (req, res) => {
    try {
      if (!(await requireProjectPermission(req, res, 'attachment:read'))) return;

      const validatedParams = getValidatedRequestData(res)?.params as
        | z.infer<typeof attachmentConfigParamsSchema>
        | undefined;
      const projectId = validatedParams?.projectId ?? req.params.projectId;
      const tenantId = req.tenantContext?.tenantId;

      if (!tenantId) {
        res.status(401).json({
          success: false,
          error: { code: 'AUTH_REQUIRED', message: 'Tenant context required' },
        });
        return;
      }

      const resolved = await resolveAttachmentConfig(tenantId, projectId);

      // Also fetch the raw project config so the UI can show what's overridden
      const projectConfig = await ProjectAttachmentConfig.findOne({
        projectId,
        tenantId,
      }).lean();

      res.json({
        success: true,
        data: {
          resolved,
          projectOverrides: projectConfig
            ? {
                enabled: projectConfig.enabled,
                maxFileSizeBytes: projectConfig.maxFileSizeBytes,
                allowedMimeTypes: projectConfig.allowedMimeTypes,
                piiPolicy: projectConfig.piiPolicy,
                defaultProcessingMode: projectConfig.defaultProcessingMode,
              }
            : null,
        },
      });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      log.error('Failed to get attachment config', { error: message });
      res.status(500).json({
        success: false,
        error: { code: 'INTERNAL_ERROR', message: 'Failed to get attachment config' },
      });
    }
  },
);

// =============================================================================
// PUT / — Upsert project-level overrides
// =============================================================================

openapi.route(
  'put',
  '/',
  {
    summary: 'Update project attachment config',
    description: 'Upsert project-scoped attachment configuration overrides for the given project.',
    params: attachmentConfigParamsSchema,
    body: attachmentConfigUpdateSchema,
    response: attachmentConfigResponseSchema,
  },
  async (req, res) => {
    try {
      if (!(await requireProjectPermission(req, res, 'attachment:write'))) return;

      const validatedParams = getValidatedRequestData(res)?.params as
        | z.infer<typeof attachmentConfigParamsSchema>
        | undefined;
      const validatedBody = getValidatedRequestData(res)?.body as
        | z.infer<typeof attachmentConfigUpdateSchema>
        | undefined;
      const projectId = validatedParams?.projectId ?? req.params.projectId;
      const tenantId = req.tenantContext?.tenantId;

      if (!tenantId) {
        res.status(401).json({
          success: false,
          error: { code: 'AUTH_REQUIRED', message: 'Tenant context required' },
        });
        return;
      }

      const updates = validatedBody ?? {};

      const config = await ProjectAttachmentConfig.findOneAndUpdate(
        { projectId, tenantId },
        { $set: { ...updates, projectId, tenantId } },
        { new: true, upsert: true, lean: true },
      );

      log.info('Project attachment config updated', { projectId, tenantId });

      // Return the resolved config after the update
      const resolved = await resolveAttachmentConfig(tenantId, projectId);

      res.json({
        success: true,
        data: {
          resolved,
          projectOverrides: config
            ? {
                enabled: config.enabled,
                maxFileSizeBytes: config.maxFileSizeBytes,
                allowedMimeTypes: config.allowedMimeTypes,
                piiPolicy: config.piiPolicy,
                defaultProcessingMode: config.defaultProcessingMode,
              }
            : null,
        },
      });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      log.error('Failed to update attachment config', { error: message });
      res.status(500).json({
        success: false,
        error: { code: 'INTERNAL_ERROR', message: 'Failed to update attachment config' },
      });
    }
  },
);

export default router;
