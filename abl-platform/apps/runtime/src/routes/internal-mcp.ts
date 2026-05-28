/**
 * Internal MCP Cache-Bust Route
 *
 * Cluster-internal endpoint used by Studio after direct project MCP-server
 * writes (mcp_server_ops:create | update | delete). Studio and Runtime may run
 * in separate pods, so direct DB writes must notify Runtime explicitly instead
 * of relying on local imports.
 *
 * Mount: /api/internal/mcp/* (gated by `requireServiceAuth`).
 *
 * The middleware verifies the bearer service token, populates
 * `req.serviceToken`, and cross-checks `tenantId` / `projectId` claims against
 * the request body. We additionally call `rejectIfTokenMismatch` to require an
 * explicit `projectId` claim on the token (defense-in-depth).
 *
 * NOTE (Task 1.8): The Studio helper that calls this endpoint will be wired
 * from `mcp_server_ops` mutation handlers in Task 1.8 of the ABLP-162 plan;
 * this commit only hardens the route + helper auth contract.
 */

import { Router, type Request, type Response } from 'express';
import { createLogger } from '@abl/compiler/platform';
import type { RuntimeMcpClientProvider } from '../services/mcp/runtime-mcp-provider.js';
import {
  rejectIfTokenMismatch,
  type InternalServiceRequest,
} from '../middleware/internal-service-auth.js';

const log = createLogger('internal-mcp-route');

/**
 * Register the internal MCP cache-bust routes on the supplied router.
 *
 * Accepts the provider as a parameter so the route handler closes over the
 * exact instance the runtime is using — no module-level singleton lookup at
 * request time.
 */
export function registerInternalMcpRoutes(
  router: Router,
  provider: RuntimeMcpClientProvider,
): void {
  router.post('/reset-project-init', (req: Request, res: Response) => {
    const body = (req.body ?? {}) as { tenantId?: unknown; projectId?: unknown };
    const { tenantId, projectId } = body;

    if (typeof tenantId !== 'string' || tenantId.length === 0) {
      res.status(400).json({
        success: false,
        error: { code: 'BAD_REQUEST', message: 'tenantId required' },
      });
      return;
    }
    if (typeof projectId !== 'string' || projectId.length === 0) {
      res.status(400).json({
        success: false,
        error: { code: 'BAD_REQUEST', message: 'projectId required' },
      });
      return;
    }

    // Defense-in-depth: require the service token to carry a projectId claim
    // and to match both tenantId and projectId from the body. The base
    // middleware (`requireServiceAuth`) already cross-checks tenantId/projectId
    // when both sides have them, but only this helper enforces that the token
    // actually carries a projectId — preventing tenant-scoped tokens from
    // invalidating per-project caches.
    const serviceToken = (req as InternalServiceRequest).serviceToken;
    const tokenError = rejectIfTokenMismatch(serviceToken, { tenantId, projectId });
    if (tokenError) {
      res.status(403).json({
        success: false,
        error: tokenError,
      });
      return;
    }

    provider.resetProjectInit(tenantId, projectId);
    log.info('MCP project-init cache reset by Studio invalidation hook', {
      tenantId,
      projectId,
    });
    res.json({ success: true });
  });
}
