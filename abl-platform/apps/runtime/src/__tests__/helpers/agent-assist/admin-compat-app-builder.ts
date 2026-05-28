/**
 * Express app builder for admin agent-assist binding route tests.
 *
 * Creates a lightweight Express app that mirrors the admin CRUD route
 * handler logic with a DI repo and stub auth middleware.
 * Used by both unit tests (fake repo) and integration tests (real Mongo repo).
 */

import express, { type Request, type Response, type NextFunction } from 'express';
import {
  type AgentAssistBindingResolver,
  AgentAssistBindingDuplicateError,
  AgentAssistBindingNotFoundError,
} from '../../../repos/agent-assist-binding-repo.js';
import { createInMemoryApiKeyStore, type ApiKeyStore } from './project-compat-app-builder.js';

const IMMUTABLE_BINDING_FIELDS = ['tenantId', 'appId', 'environment'] as const;

function attemptedImmutableFields(body: unknown): string[] {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return [];
  }
  const payload = body as Record<string, unknown>;
  return IMMUTABLE_BINDING_FIELDS.filter((field) => field in payload);
}

/**
 * Build an Express app with the given binding repo.
 * Auth is stubbed (always super_admin).
 */
export function buildAdminCompatApp(
  repo: AgentAssistBindingResolver,
  options?: { apiKeyStore?: ApiKeyStore },
): express.Express {
  const app = express();
  app.use(express.json());
  const apiKeyStore = options?.apiKeyStore ?? createInMemoryApiKeyStore();

  const stubAuth = (req: Request, _res: Response, next: NextFunction): void => {
    (req as Request & { tenantContext?: Record<string, unknown> }).tenantContext = {
      tenantId: 'T1',
      userId: 'admin-1',
      role: 'super_admin',
      authType: 'jwt',
    };
    next();
  };

  app.use(stubAuth);

  // List
  app.get('/tenants/:tenantId/bindings', async (req, res) => {
    try {
      const page = Math.max(1, parseInt(String(req.query.page ?? '1'), 10) || 1);
      const limit = Math.min(100, Math.max(1, parseInt(String(req.query.limit ?? '25'), 10) || 25));
      const skip = (page - 1) * limit;

      const result = await repo.list({ tenantId: req.params.tenantId }, { offset: skip, limit });
      res.json({
        success: true,
        data: {
          items: result.items,
          pagination: { page, limit, total: result.total },
        },
      });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      res.status(500).json({ success: false, error: { code: 'INTERNAL_ERROR', message } });
    }
  });

  // Create
  app.post('/tenants/:tenantId/bindings', async (req, res) => {
    try {
      const binding = await repo.create(
        {
          tenantId: req.params.tenantId,
          actor: req.tenantContext?.userId ?? 'unknown',
        },
        req.body,
      );
      res.status(201).json({ success: true, data: binding });
    } catch (error: unknown) {
      if (error instanceof AgentAssistBindingDuplicateError) {
        res.status(409).json({
          success: false,
          error: { code: 'BINDING_DUPLICATE', message: 'Duplicate binding' },
        });
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      res.status(500).json({ success: false, error: { code: 'INTERNAL_ERROR', message } });
    }
  });

  // Get by _id + tenantId (uses findOne internally, not Mongoose findById)
  app.get('/tenants/:tenantId/bindings/:bindingId', async (req, res) => {
    try {
      const lookupByPk = repo['findByIdForTenant'].bind(repo);
      const binding = await lookupByPk({ tenantId: req.params.tenantId }, req.params.bindingId);
      if (!binding) {
        res.status(404).json({
          success: false,
          error: { code: 'BINDING_NOT_FOUND', message: 'Not found' },
        });
        return;
      }
      res.json({ success: true, data: binding });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      res.status(500).json({ success: false, error: { code: 'INTERNAL_ERROR', message } });
    }
  });

  // Update
  app.patch('/tenants/:tenantId/bindings/:bindingId', async (req, res) => {
    try {
      const immutableFields = attemptedImmutableFields(req.body);
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
      const binding = await repo.update(
        {
          tenantId: req.params.tenantId,
          actor: req.tenantContext?.userId ?? 'unknown',
        },
        req.params.bindingId,
        req.body,
      );
      res.json({ success: true, data: binding });
    } catch (error: unknown) {
      if (error instanceof AgentAssistBindingNotFoundError) {
        res.status(404).json({
          success: false,
          error: { code: 'BINDING_NOT_FOUND', message: 'Not found' },
        });
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      res.status(500).json({ success: false, error: { code: 'INTERNAL_ERROR', message } });
    }
  });

  // Disable
  app.post('/tenants/:tenantId/bindings/:bindingId/disable', async (req, res) => {
    try {
      const binding = await repo.setStatus(
        {
          tenantId: req.params.tenantId,
          actor: req.tenantContext?.userId ?? 'unknown',
        },
        req.params.bindingId,
        'disabled',
      );
      res.json({ success: true, data: binding });
    } catch (error: unknown) {
      if (error instanceof AgentAssistBindingNotFoundError) {
        res.status(404).json({
          success: false,
          error: { code: 'BINDING_NOT_FOUND', message: 'Not found' },
        });
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      res.status(500).json({ success: false, error: { code: 'INTERNAL_ERROR', message } });
    }
  });

  // Enable
  app.post('/tenants/:tenantId/bindings/:bindingId/enable', async (req, res) => {
    try {
      const binding = await repo.setStatus(
        {
          tenantId: req.params.tenantId,
          actor: req.tenantContext?.userId ?? 'unknown',
        },
        req.params.bindingId,
        'active',
      );
      res.json({ success: true, data: binding });
    } catch (error: unknown) {
      if (error instanceof AgentAssistBindingNotFoundError) {
        res.status(404).json({
          success: false,
          error: { code: 'BINDING_NOT_FOUND', message: 'Not found' },
        });
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      res.status(500).json({ success: false, error: { code: 'INTERNAL_ERROR', message } });
    }
  });

  // Delete
  app.delete('/tenants/:tenantId/bindings/:bindingId', async (req, res) => {
    try {
      const lookupByPk = repo['findByIdForTenant'].bind(repo);
      const existing = await lookupByPk({ tenantId: req.params.tenantId }, req.params.bindingId);
      if (!existing) {
        throw new AgentAssistBindingNotFoundError(req.params.bindingId);
      }
      if (existing.apiKeyId) {
        await apiKeyStore.revoke(existing.apiKeyId, req.params.tenantId);
      }
      await repo.remove(
        {
          tenantId: req.params.tenantId,
          actor: req.tenantContext?.userId ?? 'unknown',
        },
        req.params.bindingId,
      );
      res.json({ success: true, data: { deleted: true } });
    } catch (error: unknown) {
      if (error instanceof AgentAssistBindingNotFoundError) {
        res.status(404).json({
          success: false,
          error: { code: 'BINDING_NOT_FOUND', message: 'Not found' },
        });
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      res.status(500).json({ success: false, error: { code: 'INTERNAL_ERROR', message } });
    }
  });

  return app;
}
