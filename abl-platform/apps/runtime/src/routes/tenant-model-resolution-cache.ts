/**
 * Tenant Model Resolution Cache Route
 *
 * Tenant-scoped control-plane endpoint used by Studio after direct project
 * model-config writes. Studio and Runtime may run in separate pods, so direct
 * DB writes must notify Runtime explicitly instead of relying on local imports.
 *
 * Mount: /api/tenants/:tenantId/model-resolution-cache
 */

import { type Router as RouterType } from 'express';
import { createOpenAPIRouter } from '@agent-platform/openapi/express';
import { runtimeRegistry } from '../openapi/registry.js';
import { z } from 'zod';
import { authMiddleware } from '../middleware/auth.js';
import { tenantRateLimit } from '../middleware/rate-limiter.js';
import { requirePermission } from '@agent-platform/shared-auth';
import { createLogger } from '@abl/compiler/platform';
import { writeAuditLog } from '../repos/auth-repo.js';
import { invalidateModelResolutionCaches } from '../services/llm/model-cache-invalidation.js';

const log = createLogger('tenant-model-resolution-cache-route');

const openapi = createOpenAPIRouter(runtimeRegistry, {
  basePath: '/api/tenants/:tenantId/model-resolution-cache',
  tags: ['Tenant Model Resolution Cache'],
});
const router: RouterType = openapi.router;

router.use(authMiddleware);
router.use(tenantRateLimit('request'));

function getTenantId(req: any): string | null {
  const contextTenantId = req.tenantContext?.tenantId;
  if (!contextTenantId) return null;

  const paramTenantId = req.params.tenantId;
  if (paramTenantId && paramTenantId !== contextTenantId) {
    return null;
  }

  return contextTenantId;
}

openapi.route(
  'post',
  '/invalidate',
  {
    summary: 'Invalidate tenant model-resolution caches',
    description: 'Clears model-resolution caches for a tenant after model configuration changes.',
    params: z.object({ tenantId: z.string().min(1) }),
    response: z.object({ success: z.literal(true) }),
  },
  requirePermission('model_config:write'),
  async (req, res) => {
    try {
      const tenantId = getTenantId(req);
      const userId = req.tenantContext?.userId;
      if (!tenantId) {
        res.status(403).json({ success: false, error: 'Tenant access denied' });
        return;
      }

      invalidateModelResolutionCaches(tenantId);
      writeAuditLog({
        action: 'model-resolution-cache:invalidate',
        tenantId,
        userId,
        metadata: { reason: 'project-model-config-change' },
      });

      log.info('Tenant model-resolution cache invalidated', { tenantId });
      res.json({ success: true });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      log.error('Failed to invalidate tenant model-resolution cache', { error: message });
      res.status(500).json({ success: false, error: 'Failed to invalidate cache' });
    }
  },
);

export default openapi.router;
