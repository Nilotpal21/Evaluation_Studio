/**
 * Connection CRUD Routes
 *
 * Thin Express wrapper around the shared ConnectionService.
 *
 * GET    /                       List connections for the project
 * POST   /                       Create a new connection
 * GET    /:connectionId          Get connection detail
 * PUT    /:connectionId          Update a connection
 * DELETE /:connectionId          Delete a connection
 * POST   /:connectionId/test     Test a connection
 */

import { Router } from 'express';
import type { Request, Response } from 'express';
import { z } from 'zod';
import {
  ConnectionService,
  ConnectionServiceError,
  type ConnectionModel,
  type ConnectionServiceDeps,
  type AuthProfileResolverLike,
} from '@agent-platform/connectors/services';
import type { ConnectorRegistry } from '@agent-platform/connectors';
import { asyncHandler, requireTenantProject } from '../lib/route-helpers.js';

// ─── Re-export types for backward compatibility with tests ──────────────

export type { ConnectionModel, ConnectionServiceDeps };

export interface ConnectionRouteDeps {
  connectionModel: ConnectionModel;
  registry: ConnectorRegistry;
  authProfileResolver?: AuthProfileResolverLike;
}

// ─── Zod schemas ──────────────────────────────────────────────────────────

const createConnectionBodySchema = z.object({
  connectorName: z.string().min(1, 'connectorName is required'),
  displayName: z.string().min(1).optional(),
  name: z.string().min(1).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  scope: z.enum(['tenant', 'user']).optional(),
  authProfileId: z.string().min(1),
});

const updateConnectionBodySchema = z.object({
  authProfileId: z.string().min(1).optional(),
  displayName: z.string().min(1).optional(),
  name: z.string().min(1).optional(),
  metadata: z.record(z.string(), z.unknown()).nullable().optional(),
  status: z.enum(['active', 'expired', 'revoked']).optional(),
});

export function createConnectionRouter(deps: ConnectionRouteDeps): Router {
  // NOTE: Project-level permission checks (e.g. requireProjectPermission) are not
  // yet implemented in workflow-engine routes. Data isolation is enforced at the
  // ConnectionService layer via { tenantId, projectId } scoping on every query.
  const router = Router({ mergeParams: true });

  const svc = new ConnectionService({
    connectionModel: deps.connectionModel,
    registry: deps.registry,
    authProfileResolver: deps.authProfileResolver,
  });

  /** GET / — List connections */
  router.get(
    '/',
    asyncHandler(async (req: Request, res: Response) => {
      const ctx = requireTenantProject(req, res);
      if (!ctx) return;
      const { tenantId, projectId } = ctx;

      const data = await svc.list(tenantId, projectId);
      return res.json({ success: true, data });
    }),
  );

  /** POST / — Create a connection */
  router.post(
    '/',
    asyncHandler(async (req: Request, res: Response) => {
      const ctx = requireTenantProject(req, res);
      if (!ctx) return;
      const { tenantId, projectId } = ctx;

      const parsed = createConnectionBodySchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({
          success: false,
          error: parsed.error.issues.map((i) => i.message).join(', '),
        });
      }

      const { connectorName, displayName, name, metadata, scope, authProfileId } = parsed.data;
      const resolvedDisplayName = displayName || name;
      if (!resolvedDisplayName) {
        return res.status(400).json({
          success: false,
          error: 'displayName or name is required',
        });
      }

      const userId = (req as any).tenantContext?.userId;

      try {
        const data = await svc.create(
          tenantId,
          projectId,
          {
            connectorName,
            displayName: resolvedDisplayName,
            metadata,
            scope,
            authProfileId,
          },
          userId,
        );
        return res.status(201).json({ success: true, data });
      } catch (err) {
        if (err instanceof ConnectionServiceError) {
          return res.status(400).json({ success: false, error: err.message });
        }
        throw err;
      }
    }),
  );

  /** GET /:connectionId — Get connection detail */
  router.get(
    '/:connectionId',
    asyncHandler(async (req: Request, res: Response) => {
      const ctx = requireTenantProject(req, res, { requireParams: ['connectionId'] });
      if (!ctx) return;
      const { tenantId, projectId, connectionId } = ctx;

      const data = await svc.getById(tenantId, projectId, connectionId);
      if (!data) {
        return res.status(404).json({ success: false, error: 'Connection not found' });
      }

      return res.json({ success: true, data });
    }),
  );

  /** PUT /:connectionId — Update a connection */
  router.put(
    '/:connectionId',
    asyncHandler(async (req: Request, res: Response) => {
      const ctx = requireTenantProject(req, res, { requireParams: ['connectionId'] });
      if (!ctx) return;
      const { tenantId, projectId, connectionId } = ctx;

      const parsed = updateConnectionBodySchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({
          success: false,
          error: parsed.error.issues.map((i) => i.message).join(', '),
        });
      }

      const { authProfileId, displayName, metadata, name, status } = parsed.data;

      const data = await svc.update(tenantId, projectId, connectionId, {
        authProfileId,
        displayName: displayName || name,
        metadata,
        status,
      });

      if (!data) {
        return res.status(404).json({ success: false, error: 'Connection not found' });
      }

      return res.json({ success: true, data });
    }),
  );

  /** DELETE /:connectionId — Delete a connection */
  router.delete(
    '/:connectionId',
    asyncHandler(async (req: Request, res: Response) => {
      const ctx = requireTenantProject(req, res, { requireParams: ['connectionId'] });
      if (!ctx) return;
      const { tenantId, projectId, connectionId } = ctx;

      const deleted = await svc.delete(tenantId, projectId, connectionId);
      if (!deleted) {
        return res.status(404).json({ success: false, error: 'Connection not found' });
      }

      return res.json({ success: true });
    }),
  );

  /** POST /:connectionId/test — Test a connection */
  router.post(
    '/:connectionId/test',
    asyncHandler(async (req: Request, res: Response) => {
      const ctx = requireTenantProject(req, res, { requireParams: ['connectionId'] });
      if (!ctx) return;
      const { tenantId, projectId, connectionId } = ctx;

      try {
        const result = await svc.test(tenantId, projectId, connectionId);
        return res.json({ success: true, data: result });
      } catch (err) {
        if (err instanceof ConnectionServiceError && err.code === 'NOT_FOUND') {
          return res.status(404).json({ success: false, error: 'Connection not found' });
        }
        const message = err instanceof Error ? err.message : String(err);
        return res
          .status(502)
          .json({ success: false, error: `Connection test failed: ${message}` });
      }
    }),
  );

  return router;
}
