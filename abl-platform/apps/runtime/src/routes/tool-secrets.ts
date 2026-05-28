/**
 * Tool Secrets Admin CRUD Route
 *
 * Manages per-tool, per-environment encrypted credentials.
 * All routes require authenticated tenant context + RBAC permissions.
 *
 * Actions: create, list, rotate, delete.
 * Secrets are encrypted with tenant-scoped AES-256-GCM keys.
 */

import { Router, type Router as RouterType } from 'express';
import { createOpenAPIRouter } from '@agent-platform/openapi/express';
import { runtimeRegistry } from '../openapi/registry.js';
import { z } from 'zod';
import { authMiddleware } from '../middleware/auth.js';
import { requireProjectPermission } from '../middleware/rbac.js';
import { getCurrentRequestId } from '@agent-platform/shared-observability';
import { createLogger } from '@abl/compiler/platform';
import {
  createToolSecret,
  findToolSecrets,
  countToolSecrets,
  findToolSecretById,
  updateToolSecret,
  deleteToolSecret,
} from '@agent-platform/shared/repos';
import { writeAuditLog } from '../repos/auth-repo.js';
import { tenantRateLimit } from '../middleware/rate-limiter.js';
import { isTenantEncryptionReady } from '@agent-platform/shared/encryption';

const log = createLogger('tool-secrets-route');

const openapi = createOpenAPIRouter(runtimeRegistry, {
  basePath: '/api/tool-secrets',
  tags: ['Tool Secrets'],
});
const router: RouterType = openapi.router;

/** Maximum allowed length for secret values (S8) */
const MAX_SECRET_VALUE_LENGTH = 16384; // 16KB
/** Maximum allowed length for field names */
const MAX_FIELD_LENGTH = 256;

// All tool secret routes require authentication + rate limiting
router.use(authMiddleware);
router.use(tenantRateLimit('request'));

/**
 * POST /api/tool-secrets
 * Create a new tool secret
 */
openapi.route(
  'post',
  '/',
  {
    summary: 'Create a new tool secret',
    description:
      'Create a new encrypted tool secret for a specific tool and environment. Requires credential:write permission.',
    body: z.object({
      projectId: z.string().describe('Project ID'),
      toolName: z.string().max(MAX_FIELD_LENGTH).describe('Tool name'),
      secretKey: z.string().max(MAX_FIELD_LENGTH).describe('Secret key/name'),
      value: z.string().max(MAX_SECRET_VALUE_LENGTH).describe('Secret value'),
      environment: z.string().optional().describe('Environment (default: dev)'),
      expiresAt: z.string().optional().describe('ISO 8601 expiration timestamp'),
    }),
    response: z.object({
      success: z.boolean(),
      secret: z.object({
        id: z.string(),
        toolName: z.string(),
        secretKey: z.string(),
        environment: z.string(),
        version: z.number(),
        expiresAt: z.string().nullable(),
        createdAt: z.string(),
      }),
    }),
    successStatus: 201,
  },
  async (req, res) => {
    const requestId = getCurrentRequestId();
    try {
      if (!req.tenantContext) {
        res.status(401).json({ success: false, error: 'Authentication required' });
        return;
      }

      if (!isTenantEncryptionReady()) {
        res.status(503).json({
          success: false,
          error: 'Tenant DEK encryption is not initialized. Cannot store secrets.',
        });
        return;
      }

      const { projectId, toolName, secretKey, value, environment, expiresAt } = req.body;

      // Project-level RBAC: verify membership + credential:write permission
      if (!(await requireProjectPermission(req, res, 'credential:write', projectId))) return;

      const tenantId = req.tenantContext.tenantId;
      const userId = req.tenantContext.userId;

      if (!projectId || !toolName || !secretKey || !value) {
        res.status(400).json({
          success: false,
          error: 'Missing required fields: projectId, toolName, secretKey, value',
        });
        return;
      }

      // S8: Input length limits
      if (typeof value !== 'string' || value.length > MAX_SECRET_VALUE_LENGTH) {
        res.status(400).json({
          success: false,
          error: `Secret value exceeds maximum length of ${MAX_SECRET_VALUE_LENGTH} characters`,
        });
        return;
      }
      if (
        String(toolName).length > MAX_FIELD_LENGTH ||
        String(secretKey).length > MAX_FIELD_LENGTH
      ) {
        res.status(400).json({
          success: false,
          error: `Field names must not exceed ${MAX_FIELD_LENGTH} characters`,
        });
        return;
      }

      // Plugin encrypts encryptedValue transparently in pre-save hook
      const secret = await createToolSecret({
        tenantId,
        projectId,
        toolName,
        secretKey,
        encryptedValue: value,
        environment: environment ?? 'dev',
        expiresAt: expiresAt ? new Date(expiresAt) : null,
        createdBy: userId,
      });

      // CL5: success logging + CL2: requestId
      log.info('Tool secret created', { toolName, secretKey, tenantId, requestId });
      // E3/CL1: audit log
      writeAuditLog({
        action: 'tool-secret:create',
        tenantId,
        userId,
        metadata: { toolName, secretKey, environment: environment ?? 'dev', requestId },
      });

      res.status(201).json({
        success: true,
        secret: {
          id: secret.id,
          toolName: secret.toolName,
          secretKey: secret.secretKey,
          environment: secret.environment,
          version: secret.version,
          expiresAt: secret.expiresAt,
          createdAt: secret.createdAt,
        },
      });
    } catch (error: any) {
      if (error?.code === 11000) {
        res.status(409).json({
          success: false,
          error: 'Secret already exists for this tool/key/environment combination',
        });
        return;
      }
      log.error('Failed to create tool secret', { error: error?.message, requestId });
      res.status(500).json({ success: false, error: 'Failed to create tool secret' });
    }
  },
);

/**
 * GET /api/tool-secrets
 * List tool secrets with optional filtering and pagination
 */
openapi.route(
  'get',
  '/',
  {
    summary: 'List tool secrets',
    description:
      'List tool secrets with optional filtering by toolName and environment. Metadata only, no secret values returned. Query params: projectId (required), toolName, environment, page, limit.',
    response: z.object({
      success: z.boolean(),
      secrets: z.array(
        z.object({
          id: z.string(),
          toolName: z.string(),
          secretKey: z.string(),
          environment: z.string(),
          version: z.number(),
          expiresAt: z.string().nullable(),
          rotatedAt: z.string().nullable(),
          createdBy: z.string(),
          createdAt: z.string(),
          updatedAt: z.string(),
          expiryWarning: z.enum(['expired', 'expiring_soon']).optional(),
        }),
      ),
      pagination: z.object({
        page: z.number(),
        limit: z.number(),
        total: z.number(),
        totalPages: z.number(),
      }),
    }),
  },
  async (req, res) => {
    const requestId = getCurrentRequestId();
    try {
      if (!req.tenantContext) {
        res.status(401).json({ success: false, error: 'Authentication required' });
        return;
      }

      const { projectId, toolName, environment } = req.query;

      if (!projectId) {
        res.status(400).json({ success: false, error: 'Missing required query: projectId' });
        return;
      }

      // Project-level RBAC: verify membership + credential:read permission
      if (!(await requireProjectPermission(req, res, 'credential:read', String(projectId)))) return;

      const tenantId = req.tenantContext.tenantId;

      const where = {
        tenantId,
        projectId: String(projectId),
        ...(toolName ? { toolName: String(toolName) } : {}),
        ...(environment ? { environment: String(environment) } : {}),
      };

      // U2: pagination
      const page = Math.max(1, parseInt(String(req.query.page ?? '1'), 10) || 1);
      const limit = Math.min(100, Math.max(1, parseInt(String(req.query.limit ?? '25'), 10) || 25));
      const skip = (page - 1) * limit;

      const [secrets, total] = await Promise.all([
        findToolSecrets(where, {
          select: {
            id: true,
            toolName: true,
            secretKey: true,
            environment: true,
            version: true,
            expiresAt: true,
            rotatedAt: true,
            createdBy: true,
            createdAt: true,
            updatedAt: true,
          },
          skip,
          take: limit,
        }),
        countToolSecrets(where),
      ]);

      // E6: Add expiry warnings
      const now = new Date();
      const warningThresholdMs = 30 * 24 * 60 * 60 * 1000; // 30 days
      const enriched = secrets.map((s: any) => ({
        ...s,
        expiryWarning:
          s.expiresAt && new Date(s.expiresAt).getTime() - now.getTime() < warningThresholdMs
            ? new Date(s.expiresAt) < now
              ? 'expired'
              : 'expiring_soon'
            : undefined,
      }));

      log.info('Listed tool secrets', { tenantId, count: secrets.length, requestId });

      res.json({
        success: true,
        secrets: enriched,
        pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
      });
    } catch (error: any) {
      log.error('Failed to list tool secrets', { error: error?.message, requestId });
      res.status(500).json({ success: false, error: 'Failed to list tool secrets' });
    }
  },
);

/**
 * POST /api/tool-secrets/:id/rotate
 * Rotate a tool secret to a new version
 */
openapi.route(
  'post',
  '/:id/rotate',
  {
    summary: 'Rotate a tool secret',
    description:
      'Rotate a tool secret to a new version with a new value. Increments the version number and updates rotatedAt timestamp.',
    body: z.object({
      value: z.string().max(MAX_SECRET_VALUE_LENGTH).describe('New secret value'),
      expiresAt: z.string().optional().describe('ISO 8601 expiration timestamp'),
    }),
    response: z.object({
      success: z.boolean(),
      secret: z.object({
        id: z.string(),
        toolName: z.string(),
        secretKey: z.string(),
        environment: z.string(),
        version: z.number(),
        rotatedAt: z.string().nullable(),
      }),
    }),
  },
  async (req, res) => {
    const requestId = getCurrentRequestId();
    try {
      if (!req.tenantContext) {
        res.status(401).json({ success: false, error: 'Authentication required' });
        return;
      }

      if (!isTenantEncryptionReady()) {
        res.status(503).json({
          success: false,
          error: 'Tenant DEK encryption is not initialized. Cannot store secrets.',
        });
        return;
      }

      const tenantId = req.tenantContext.tenantId;
      const userId = req.tenantContext.userId;

      const existing = await findToolSecretById(req.params.id, tenantId);

      if (!existing) {
        res.status(404).json({ success: false, error: 'Tool secret not found' });
        return;
      }

      // Project-level RBAC: verify membership + credential:write permission
      if (!(await requireProjectPermission(req, res, 'credential:write', existing.projectId)))
        return;

      const { value, expiresAt } = req.body;
      if (!value) {
        res.status(400).json({ success: false, error: 'Missing required field: value' });
        return;
      }

      // S8: Input length limits
      if (typeof value !== 'string' || value.length > MAX_SECRET_VALUE_LENGTH) {
        res.status(400).json({
          success: false,
          error: `Secret value exceeds maximum length of ${MAX_SECRET_VALUE_LENGTH} characters`,
        });
        return;
      }

      // Plugin encrypts encryptedValue transparently in pre-save hook
      const existingExpiry = existing.expiresAt ? new Date(existing.expiresAt) : null;
      const updated = await updateToolSecret(req.params.id, tenantId, {
        encryptedValue: value,
        version: existing.version + 1,
        rotatedAt: new Date(),
        expiresAt: expiresAt ? new Date(expiresAt) : existingExpiry,
      });

      if (!updated) {
        res.status(404).json({ success: false, error: 'Tool secret not found after update' });
        return;
      }

      log.info('Tool secret rotated', {
        id: req.params.id,
        version: updated.version,
        tenantId,
        requestId,
      });
      writeAuditLog({
        action: 'tool-secret:rotate',
        tenantId,
        userId,
        metadata: {
          secretId: req.params.id,
          toolName: existing.toolName,
          secretKey: existing.secretKey,
          newVersion: updated.version,
          requestId,
        },
      });

      res.json({
        success: true,
        secret: {
          id: updated.id,
          toolName: updated.toolName,
          secretKey: updated.secretKey,
          environment: updated.environment,
          version: updated.version,
          rotatedAt: updated.rotatedAt,
        },
      });
    } catch (error: any) {
      log.error('Failed to rotate tool secret', { error: error?.message, requestId });
      res.status(500).json({ success: false, error: 'Failed to rotate tool secret' });
    }
  },
);

/**
 * DELETE /api/tool-secrets/:id
 * Delete a tool secret
 */
openapi.route(
  'delete',
  '/:id',
  {
    summary: 'Delete a tool secret',
    description: 'Permanently delete a tool secret. This action cannot be undone.',
    response: z.object({
      success: z.boolean(),
      deleted: z.string(),
    }),
  },
  async (req, res) => {
    const requestId = getCurrentRequestId();
    try {
      if (!req.tenantContext) {
        res.status(401).json({ success: false, error: 'Authentication required' });
        return;
      }

      const tenantId = req.tenantContext.tenantId;
      const userId = req.tenantContext.userId;

      const existing = await findToolSecretById(req.params.id, tenantId);

      if (!existing) {
        res.status(404).json({ success: false, error: 'Tool secret not found' });
        return;
      }

      // Project-level RBAC: verify membership + credential:delete permission
      if (!(await requireProjectPermission(req, res, 'credential:delete', existing.projectId)))
        return;

      await deleteToolSecret(req.params.id, tenantId);

      log.info('Tool secret deleted', { id: req.params.id, tenantId, requestId });
      writeAuditLog({
        action: 'tool-secret:delete',
        tenantId,
        userId,
        metadata: {
          secretId: req.params.id,
          toolName: existing.toolName,
          secretKey: existing.secretKey,
          requestId,
        },
      });

      res.json({ success: true, deleted: req.params.id });
    } catch (error: any) {
      log.error('Failed to delete tool secret', { error: error?.message, requestId });
      res.status(500).json({ success: false, error: 'Failed to delete tool secret' });
    }
  },
);

export default router;
