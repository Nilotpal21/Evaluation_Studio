/**
 * Connector Connections CRUD Route (Project-Scoped)
 *
 * Thin Express route handlers that delegate to ConnectionService from
 * @agent-platform/connectors. Provides HTTP API for managing connector
 * connections with encrypted credential storage.
 *
 * GET    /api/projects/:projectId/connections          List connections
 * POST   /api/projects/:projectId/connections          Create connection
 * POST   /api/projects/:projectId/connections/:id/test Test connection
 * GET    /api/projects/:projectId/connections/:id       Get connection
 * PUT    /api/projects/:projectId/connections/:id       Update connection
 * DELETE /api/projects/:projectId/connections/:id       Delete connection
 */

import { Router, type Request, type Response, type Router as RouterType } from 'express';
import { z } from 'zod';
import { requireProjectScope } from '@agent-platform/shared-auth';
import { authMiddleware } from '../middleware/auth.js';
import { tenantRateLimit } from '../middleware/rate-limiter.js';
import { requireProjectPermission } from '../middleware/rbac.js';
import { createLogger } from '@abl/compiler/platform';

const log = createLogger('connections-route');

// ─── Validation Schemas ──────────────────────────────────────────────────

const CreateConnectionSchema = z.object({
  connectorName: z.string().min(1),
  displayName: z.string().min(1),
  authProfileId: z.string().min(1),
  metadata: z.record(z.unknown()).optional(),
  scope: z.enum(['tenant', 'user']).optional(),
});

const UpdateConnectionSchema = z.object({
  displayName: z.string().min(1).optional(),
  authProfileId: z.string().min(1).optional(),
  metadata: z.record(z.unknown()).nullable().optional(),
  status: z.enum(['active', 'expired', 'revoked']).optional(),
});

const IdParamSchema = z.object({
  projectId: z.string().min(1),
  id: z.string().min(1),
});

const ProjectParamSchema = z.object({
  projectId: z.string().min(1),
});

// ─── Lazy Service Initialization ─────────────────────────────────────────

type ConnectionServiceType = import('@agent-platform/connectors').ConnectionService;

let _connectionService: ConnectionServiceType | null = null;

async function getConnectionService(): Promise<ConnectionServiceType | null> {
  if (_connectionService) return _connectionService;

  try {
    const { ConnectionService } = await import('@agent-platform/connectors');
    const { createAuthProfileResolver } = await import('@agent-platform/connectors/services');
    const { getConnectorRegistry } = await import('../services/connector-registry-singleton.js');
    const { decryptForTenantAuto, isTenantEncryptionReady } =
      await import('@agent-platform/shared/encryption');
    const { AuthProfile, ConnectorConnection } = await import('@agent-platform/database/models');

    const registry = getConnectorRegistry();
    if (!registry) {
      log.warn('Connector registry not initialized — connection routes unavailable');
      return null;
    }

    if (!isTenantEncryptionReady()) {
      log.warn('Tenant DEK encryption not ready — connection routes unavailable');
      return null;
    }
    // Wrap Mongoose model to return POJOs via .lean()/.toObject()
    const connectionModel = {
      // Wrapper — projectId is in the filter passed by ConnectionService callers
      find(filter: Record<string, unknown>) {
        const q = ConnectorConnection.find(filter);
        return {
          sort(sortOpts: Record<string, number>) {
            return { lean: () => q.sort(sortOpts).lean() };
          },
          lean: () => q.lean(),
        };
      },
      findOne(filter: Record<string, unknown>) {
        return { lean: () => ConnectorConnection.findOne(filter).lean() };
      },
      async create(data: Record<string, unknown>) {
        const doc = await ConnectorConnection.create(data);
        return doc.toObject();
      },
      async findOneAndUpdate(
        filter: Record<string, unknown>,
        update: Record<string, unknown>,
        options?: Record<string, unknown>,
      ) {
        return ConnectorConnection.findOneAndUpdate(filter, update, {
          ...options,
          new: true,
        }).lean();
      },
      async findOneAndDelete(filter: Record<string, unknown>) {
        return ConnectorConnection.findOneAndDelete(filter).lean();
      },
    };

    const authProfileResolver = createAuthProfileResolver({
      authProfileModel: AuthProfile as any,
      decrypt: (ciphertext, tenantId) => decryptForTenantAuto(ciphertext, tenantId),
    });

    _connectionService = new ConnectionService({
      connectionModel,
      authProfileResolver,
      registry,
    });

    return _connectionService;
  } catch (err) {
    log.warn('Failed to create ConnectionService', {
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/** Reset singleton — used by tests to inject a fresh service instance. */
export function resetConnectionService(): void {
  _connectionService = null;
}

/** Override the singleton — used by tests that provide their own ConnectionService. */
export function setConnectionService(svc: ConnectionServiceType): void {
  _connectionService = svc;
}

// ─── Router ──────────────────────────────────────────────────────────────

const router: RouterType = Router({ mergeParams: true });

router.use(authMiddleware);
router.use(requireProjectScope('projectId'));
router.use(tenantRateLimit('request'));

// ─── Helpers ─────────────────────────────────────────────────────────────

function requireTenantId(req: Request, res: Response): string | null {
  const tenantId = req.tenantContext?.tenantId;
  if (!tenantId) {
    res.status(401).json({
      success: false,
      error: { code: 'UNAUTHORIZED', message: 'Missing tenant context' },
    });
    return null;
  }
  return tenantId;
}

function getUserId(req: Request): string | undefined {
  return req.tenantContext?.userId || undefined;
}

// ─── Routes ──────────────────────────────────────────────────────────────

// POST /  — Create connection
router.post('/', async (req: Request, res: Response) => {
  try {
    if (!(await requireProjectPermission(req, res, 'connection:write'))) return;

    const params = ProjectParamSchema.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({
        success: false,
        error: { code: 'VALIDATION_ERROR', message: params.error.message },
      });
      return;
    }

    const body = CreateConnectionSchema.safeParse(req.body);
    if (!body.success) {
      res.status(400).json({
        success: false,
        error: { code: 'VALIDATION_ERROR', message: body.error.message },
      });
      return;
    }

    const svc = await getConnectionService();
    if (!svc) {
      res.status(503).json({
        success: false,
        error: { code: 'SERVICE_UNAVAILABLE', message: 'Connection service not available' },
      });
      return;
    }

    const tenantId = requireTenantId(req, res);
    if (!tenantId) return;
    const userId = getUserId(req);
    const connection = await svc.create(tenantId, params.data.projectId, body.data, userId);
    res.status(201).json({ success: true, data: connection });
  } catch (err: unknown) {
    handleServiceError(err, res);
  }
});

// GET /  — List connections
router.get('/', async (req: Request, res: Response) => {
  try {
    if (!(await requireProjectPermission(req, res, 'connection:read'))) return;

    const params = ProjectParamSchema.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({
        success: false,
        error: { code: 'VALIDATION_ERROR', message: params.error.message },
      });
      return;
    }

    const svc = await getConnectionService();
    if (!svc) {
      res.status(503).json({
        success: false,
        error: { code: 'SERVICE_UNAVAILABLE', message: 'Connection service not available' },
      });
      return;
    }

    const tenantId = requireTenantId(req, res);
    if (!tenantId) return;
    const userId = getUserId(req);
    const connections = await svc.list(tenantId, params.data.projectId, userId);
    res.json({ success: true, data: connections });
  } catch (err: unknown) {
    handleServiceError(err, res);
  }
});

// POST /:id/test  — Test connection (MUST be before /:id to prevent param capture)
router.post('/:id/test', async (req: Request, res: Response) => {
  try {
    if (!(await requireProjectPermission(req, res, 'connection:read'))) return;

    const params = IdParamSchema.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({
        success: false,
        error: { code: 'VALIDATION_ERROR', message: params.error.message },
      });
      return;
    }

    const svc = await getConnectionService();
    if (!svc) {
      res.status(503).json({
        success: false,
        error: { code: 'SERVICE_UNAVAILABLE', message: 'Connection service not available' },
      });
      return;
    }

    const tenantId = requireTenantId(req, res);
    if (!tenantId) return;
    const result = await svc.test(tenantId, params.data.projectId, params.data.id);
    res.json({ success: true, data: result });
  } catch (err: unknown) {
    handleServiceError(err, res);
  }
});

// GET /:id  — Get connection by ID
router.get('/:id', async (req: Request, res: Response) => {
  try {
    if (!(await requireProjectPermission(req, res, 'connection:read'))) return;

    const params = IdParamSchema.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({
        success: false,
        error: { code: 'VALIDATION_ERROR', message: params.error.message },
      });
      return;
    }

    const svc = await getConnectionService();
    if (!svc) {
      res.status(503).json({
        success: false,
        error: { code: 'SERVICE_UNAVAILABLE', message: 'Connection service not available' },
      });
      return;
    }

    const tenantId = requireTenantId(req, res);
    if (!tenantId) return;
    const connection = await svc.getById(tenantId, params.data.projectId, params.data.id);
    if (!connection) {
      res.status(404).json({
        success: false,
        error: { code: 'NOT_FOUND', message: 'Connection not found' },
      });
      return;
    }
    res.json({ success: true, data: connection });
  } catch (err: unknown) {
    handleServiceError(err, res);
  }
});

// PUT /:id  — Update connection
router.put('/:id', async (req: Request, res: Response) => {
  try {
    if (!(await requireProjectPermission(req, res, 'connection:write'))) return;

    const params = IdParamSchema.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({
        success: false,
        error: { code: 'VALIDATION_ERROR', message: params.error.message },
      });
      return;
    }

    const body = UpdateConnectionSchema.safeParse(req.body);
    if (!body.success) {
      res.status(400).json({
        success: false,
        error: { code: 'VALIDATION_ERROR', message: body.error.message },
      });
      return;
    }

    const svc = await getConnectionService();
    if (!svc) {
      res.status(503).json({
        success: false,
        error: { code: 'SERVICE_UNAVAILABLE', message: 'Connection service not available' },
      });
      return;
    }

    const tenantId = requireTenantId(req, res);
    if (!tenantId) return;
    const updated = await svc.update(tenantId, params.data.projectId, params.data.id, body.data);
    if (!updated) {
      res.status(404).json({
        success: false,
        error: { code: 'NOT_FOUND', message: 'Connection not found' },
      });
      return;
    }
    res.json({ success: true, data: updated });
  } catch (err: unknown) {
    handleServiceError(err, res);
  }
});

// DELETE /:id  — Delete connection
router.delete('/:id', async (req: Request, res: Response) => {
  try {
    if (!(await requireProjectPermission(req, res, 'connection:delete'))) return;

    const params = IdParamSchema.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({
        success: false,
        error: { code: 'VALIDATION_ERROR', message: params.error.message },
      });
      return;
    }

    const svc = await getConnectionService();
    if (!svc) {
      res.status(503).json({
        success: false,
        error: { code: 'SERVICE_UNAVAILABLE', message: 'Connection service not available' },
      });
      return;
    }

    const tenantId = requireTenantId(req, res);
    if (!tenantId) return;
    const deleted = await svc.delete(tenantId, params.data.projectId, params.data.id);
    if (!deleted) {
      res.status(404).json({
        success: false,
        error: { code: 'NOT_FOUND', message: 'Connection not found' },
      });
      return;
    }
    res.json({ success: true });
  } catch (err: unknown) {
    handleServiceError(err, res);
  }
});

// ─── Error Handling ──────────────────────────────────────────────────────

function handleServiceError(err: unknown, res: Response): void {
  // Check for ConnectionServiceError specifically (not system errors with `code`)
  if (err instanceof Error && err.name === 'ConnectionServiceError' && 'code' in err) {
    const serviceErr = err as Error & { code: string };
    const statusMap: Record<string, number> = {
      NOT_FOUND: 404,
      VALIDATION_ERROR: 400,
      UNKNOWN_CONNECTOR: 400,
      DECRYPT_FAILED: 500,
    };
    const status = statusMap[serviceErr.code] ?? 500;
    res.status(status).json({
      success: false,
      error: { code: serviceErr.code, message: serviceErr.message },
    });
    return;
  }

  log.error('Unexpected error in connections route', {
    error: err instanceof Error ? err.message : String(err),
  });
  res.status(500).json({
    success: false,
    error: { code: 'INTERNAL_ERROR', message: 'An unexpected error occurred' },
  });
}

export default router;
