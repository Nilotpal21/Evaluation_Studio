/**
 * PII Entities Route — lists the enabled PII entity types for a project.
 *
 * Mount: /api/projects/:projectId/pii-entities
 *
 * Reads the project's PII configuration (enabled recognizer packs) and
 * returns the entity catalog entries for those packs via the compiler's
 * `listEnabledPIIEntities`.
 */

import { Router, type Router as RouterType } from 'express';
import { z } from 'zod';
import { createLogger, listEnabledPIIEntities } from '@abl/compiler/platform';
import { getCurrentRequestId } from '@agent-platform/shared-observability';
import { authMiddleware } from '../middleware/auth.js';
import { tenantRateLimit } from '../middleware/rate-limiter.js';
import { getRouteScopeContext, requireRouteScopePermission } from './guardrail-helpers.js';
import { getProjectPIIConfig } from '../services/pii/project-pii-config.js';

const log = createLogger('pii-entities-route');

const ParamsSchema = z.object({ projectId: z.string().min(1) });

const router: RouterType = Router({ mergeParams: true });

// All routes require authentication + rate limiting
router.use(authMiddleware);
router.use(tenantRateLimit('request'));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getTenantId(req: any): string | null {
  const contextTenantId = req.tenantContext?.tenantId;
  if (!contextTenantId) return null;
  return contextTenantId;
}

// ---------------------------------------------------------------------------
// LIST — GET /
// ---------------------------------------------------------------------------

router.get('/', async (req: any, res) => {
  const requestId = getCurrentRequestId();
  try {
    const tenantId = getTenantId(req);
    if (!tenantId) {
      res.status(403).json({
        success: false,
        error: { code: 'TENANT_ACCESS_DENIED', message: 'Tenant access denied' },
      });
      return;
    }

    const params = ParamsSchema.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({
        success: false,
        error: { code: 'INVALID_PARAMS', message: 'Missing or invalid projectId' },
      });
      return;
    }

    const context = getRouteScopeContext(req);
    const allowed = await requireRouteScopePermission(req, res, context, 'pii-pattern:read');
    if (!allowed) return;

    const cfg = await getProjectPIIConfig({
      tenantId,
      projectId: params.data.projectId,
    });
    const entities = listEnabledPIIEntities(cfg.enabledPacks);

    res.json({ success: true, data: { entities } });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error('Failed to list PII entities', { error: message, requestId });
    res.status(500).json({
      success: false,
      error: { code: 'INTERNAL_ERROR', message: 'Failed to list PII entities' },
    });
  }
});

export default router;
