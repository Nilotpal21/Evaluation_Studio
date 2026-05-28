/**
 * Platform Admin — Agentic Compat Binding Management Routes
 *
 * CRUD endpoints for managing AgentAssistBinding documents that map
 * legacy Kore.ai Agent Assist V1 app identifiers to platform agent
 * configurations (project, deployment, API key).
 *
 * All routes require `platformAdminAuthMiddleware` + `requirePlatformAdmin()`.
 * Tenant scoping is enforced via path parameter `:tenantId` and repo-level
 * `tenantIsolationPlugin` (belt-and-braces).
 *
 * Mount: /api/platform/admin/agent-assist
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
import {
  type AgentAssistBindingResolver,
  AgentAssistBindingDuplicateError,
  AgentAssistBindingNotFoundError,
  createAgentAssistBindingRepo,
} from '../repos/agent-assist-binding-repo.js';
import {
  ADMIN_BINDING_IMMUTABLE_FIELDS,
  attemptedImmutableFields,
  lookupBindingByPk,
  parsePagination,
} from '../services/agent-assist/binding-route-helpers.js';

const log = createLogger('platform-admin-agent-assist');

// ─── Validation ───────────────────────────────────────────────────────────

const createBindingSchema = z
  .object({
    projectId: z.string().min(1),
    appId: z.string().min(1),
    environment: z.string().min(1),
    deploymentId: z.string().min(1).nullable().optional(),
    apiKeyId: z.string().min(1).nullable().optional(),
    displayName: z.string().min(1).nullable().optional(),
    runtimeBaseUrl: z.string().url().nullable().optional(),
  })
  .strict();

const updateBindingSchema = z
  .object({
    projectId: z.string().min(1).optional(),
    deploymentId: z.string().min(1).nullable().optional(),
    apiKeyId: z.string().min(1).nullable().optional(),
    displayName: z.string().min(1).nullable().optional(),
    runtimeBaseUrl: z.string().url().nullable().optional(),
  })
  .strict();

// ─── Factory ──────────────────────────────────────────────────────────────

export interface PlatformAdminAgentAssistDeps {
  repo?: AgentAssistBindingResolver;
}

export function createPlatformAdminAgentAssistRouter(
  deps?: PlatformAdminAgentAssistDeps,
): ReturnType<typeof Router> {
  const router: ReturnType<typeof Router> = Router();
  const repo = deps?.repo ?? createAgentAssistBindingRepo();

  // ─── Middleware ────────────────────────────────────────────────────────
  router.use(platformAdminAuthMiddleware);
  router.use(tenantRateLimit('request'));
  router.use(requirePlatformAdmin());
  router.use(requirePlatformAdminIp(() => getConfig().security.platformAdminAllowedIps));

  // ─── GET /tenants/:tenantId/bindings — List bindings ──────────────────

  router.get('/tenants/:tenantId/bindings', async (req, res) => {
    const requestId = getCurrentRequestId();
    try {
      const { tenantId } = req.params;
      const { page, limit, skip } = parsePagination(req.query as Record<string, unknown>);
      const rawProjectId = (req.query as Record<string, unknown>).projectId;
      const projectId =
        typeof rawProjectId === 'string' && rawProjectId.trim().length > 0
          ? rawProjectId.trim()
          : undefined;

      const result = await repo.list({ tenantId }, { offset: skip, limit, projectId });

      res.json({
        success: true,
        data: {
          items: result.items,
          pagination: {
            page,
            limit,
            total: result.total,
            totalPages: Math.ceil(result.total / limit),
          },
        },
      });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      log.error('Failed to list agentic compat bindings', { error: message, requestId });
      res.status(500).json({
        success: false,
        error: { code: 'INTERNAL_ERROR', message: 'Failed to list bindings' },
      });
    }
  });

  // ─── POST /tenants/:tenantId/bindings — Create binding ────────────────

  router.post('/tenants/:tenantId/bindings', async (req, res) => {
    const requestId = getCurrentRequestId();
    try {
      const { tenantId } = req.params;
      const parsed = createBindingSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({
          success: false,
          error: { code: 'VALIDATION_ERROR', message: 'Invalid binding data' },
          details: parsed.error.issues,
        });
        return;
      }

      const adminUserId = req.tenantContext?.userId ?? 'unknown';
      const binding = await repo.create({ tenantId, actor: adminUserId }, parsed.data);

      log.info('Agentic compat binding created', {
        bindingId: binding._id,
        tenantId,
        adminUserId,
        requestId,
      });
      writeAuditLog({
        action: 'platform-admin:compat-binding-create',
        userId: adminUserId,
        tenantId,
        metadata: { bindingId: binding._id, appId: parsed.data.appId, requestId },
      });

      res.status(201).json({ success: true, data: binding });
    } catch (error: unknown) {
      if (error instanceof AgentAssistBindingDuplicateError) {
        res.status(409).json({
          success: false,
          error: {
            code: 'BINDING_DUPLICATE',
            message: 'Binding already exists for this tenant, appId, and environment',
          },
        });
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      log.error('Failed to create agentic compat binding', { error: message, requestId });
      res.status(500).json({
        success: false,
        error: { code: 'INTERNAL_ERROR', message: 'Failed to create binding' },
      });
    }
  });

  // ─── GET /tenants/:tenantId/bindings/:bindingId — Get binding ─────────

  router.get('/tenants/:tenantId/bindings/:bindingId', async (req, res) => {
    const requestId = getCurrentRequestId();
    try {
      const { tenantId, bindingId } = req.params;
      const binding = await lookupBindingByPk(repo, { tenantId }, bindingId);

      if (!binding) {
        res.status(404).json({
          success: false,
          error: { code: 'BINDING_NOT_FOUND', message: 'Binding not found' },
        });
        return;
      }

      res.json({ success: true, data: binding });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      log.error('Failed to get agentic compat binding', { error: message, requestId });
      res.status(500).json({
        success: false,
        error: { code: 'INTERNAL_ERROR', message: 'Failed to get binding' },
      });
    }
  });

  // ─── PATCH /tenants/:tenantId/bindings/:bindingId — Update binding ────

  router.patch('/tenants/:tenantId/bindings/:bindingId', async (req, res) => {
    const requestId = getCurrentRequestId();
    try {
      const { tenantId, bindingId } = req.params;
      const immutableFields = attemptedImmutableFields(req.body, ADMIN_BINDING_IMMUTABLE_FIELDS);
      if (immutableFields.length > 0) {
        res.status(400).json({
          success: false,
          error: {
            code: 'IMMUTABLE_FIELD_CHANGE',
            message: `Immutable binding fields cannot be changed: ${immutableFields.join(', ')}`,
          },
        });
        return;
      }
      const parsed = updateBindingSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({
          success: false,
          error: { code: 'VALIDATION_ERROR', message: 'Invalid update data' },
          details: parsed.error.issues,
        });
        return;
      }

      const adminUserId = req.tenantContext?.userId ?? 'unknown';
      const binding = await repo.update({ tenantId, actor: adminUserId }, bindingId, parsed.data);

      log.info('Agentic compat binding updated', {
        bindingId,
        tenantId,
        adminUserId,
        requestId,
      });
      writeAuditLog({
        action: 'platform-admin:compat-binding-update',
        userId: adminUserId,
        tenantId,
        metadata: { bindingId, updates: Object.keys(parsed.data), requestId },
      });

      res.json({ success: true, data: binding });
    } catch (error: unknown) {
      if (error instanceof AgentAssistBindingNotFoundError) {
        res.status(404).json({
          success: false,
          error: { code: 'BINDING_NOT_FOUND', message: 'Binding not found' },
        });
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      log.error('Failed to update agentic compat binding', { error: message, requestId });
      res.status(500).json({
        success: false,
        error: { code: 'INTERNAL_ERROR', message: 'Failed to update binding' },
      });
    }
  });

  // ─── POST /tenants/:tenantId/bindings/:bindingId/disable — Disable ────

  router.post('/tenants/:tenantId/bindings/:bindingId/disable', async (req, res) => {
    const requestId = getCurrentRequestId();
    try {
      const { tenantId, bindingId } = req.params;
      const adminUserId = req.tenantContext?.userId ?? 'unknown';

      const binding = await repo.setStatus({ tenantId, actor: adminUserId }, bindingId, 'disabled');

      log.info('Agentic compat binding disabled', {
        bindingId,
        tenantId,
        adminUserId,
        requestId,
      });
      writeAuditLog({
        action: 'platform-admin:compat-binding-disable',
        userId: adminUserId,
        tenantId,
        metadata: { bindingId, requestId },
      });

      res.json({ success: true, data: binding });
    } catch (error: unknown) {
      if (error instanceof AgentAssistBindingNotFoundError) {
        res.status(404).json({
          success: false,
          error: { code: 'BINDING_NOT_FOUND', message: 'Binding not found' },
        });
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      log.error('Failed to disable agentic compat binding', { error: message, requestId });
      res.status(500).json({
        success: false,
        error: { code: 'INTERNAL_ERROR', message: 'Failed to disable binding' },
      });
    }
  });

  // ─── POST /tenants/:tenantId/bindings/:bindingId/enable — Enable ──────

  router.post('/tenants/:tenantId/bindings/:bindingId/enable', async (req, res) => {
    const requestId = getCurrentRequestId();
    try {
      const { tenantId, bindingId } = req.params;
      const adminUserId = req.tenantContext?.userId ?? 'unknown';

      const binding = await repo.setStatus({ tenantId, actor: adminUserId }, bindingId, 'active');

      log.info('Agentic compat binding enabled', {
        bindingId,
        tenantId,
        adminUserId,
        requestId,
      });
      writeAuditLog({
        action: 'platform-admin:compat-binding-enable',
        userId: adminUserId,
        tenantId,
        metadata: { bindingId, requestId },
      });

      res.json({ success: true, data: binding });
    } catch (error: unknown) {
      if (error instanceof AgentAssistBindingNotFoundError) {
        res.status(404).json({
          success: false,
          error: { code: 'BINDING_NOT_FOUND', message: 'Binding not found' },
        });
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      log.error('Failed to enable agentic compat binding', { error: message, requestId });
      res.status(500).json({
        success: false,
        error: { code: 'INTERNAL_ERROR', message: 'Failed to enable binding' },
      });
    }
  });

  // ─── DELETE /tenants/:tenantId/bindings/:bindingId — Delete ───────────

  router.delete('/tenants/:tenantId/bindings/:bindingId', async (req, res) => {
    const requestId = getCurrentRequestId();
    try {
      const { tenantId, bindingId } = req.params;
      const adminUserId = req.tenantContext?.userId ?? 'unknown';
      const existing = await repo.findByIdForTenant({ tenantId }, bindingId);
      if (!existing) {
        throw new AgentAssistBindingNotFoundError(bindingId);
      }
      if (existing.apiKeyId) {
        const { ApiKey } = await import('@agent-platform/database/models');
        await ApiKey.findOneAndUpdate(
          { _id: existing.apiKeyId, tenantId },
          { $set: { revokedAt: new Date() } },
        );
      }

      await repo.remove({ tenantId, actor: adminUserId }, bindingId);

      log.info('Agentic compat binding deleted', {
        bindingId,
        tenantId,
        adminUserId,
        requestId,
      });
      writeAuditLog({
        action: 'platform-admin:compat-binding-delete',
        userId: adminUserId,
        tenantId,
        metadata: { bindingId, requestId },
      });

      res.json({ success: true, data: { deleted: true } });
    } catch (error: unknown) {
      if (error instanceof AgentAssistBindingNotFoundError) {
        res.status(404).json({
          success: false,
          error: { code: 'BINDING_NOT_FOUND', message: 'Binding not found' },
        });
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      log.error('Failed to delete agentic compat binding', { error: message, requestId });
      res.status(500).json({
        success: false,
        error: { code: 'INTERNAL_ERROR', message: 'Failed to delete binding' },
      });
    }
  });

  return router;
}

const defaultRouter: ReturnType<typeof Router> = createPlatformAdminAgentAssistRouter();
export default defaultRouter;
