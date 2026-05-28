/**
 * PII Pattern CRUD Route
 *
 * Manages project-scoped PII detection patterns: regex patterns,
 * redaction strategies, consumer access rules, and pattern testing.
 *
 * Mount: /api/projects/:projectId/pii-patterns
 */

import { Router, type RequestHandler, type Router as RouterType } from 'express';
import { authMiddleware } from '../middleware/auth.js';
import { tenantRateLimit } from '../middleware/rate-limiter.js';
import { getCurrentRequestId } from '@agent-platform/shared-observability';
import { createLogger } from '@abl/compiler/platform';
import { writeAuditLog } from '../repos/auth-repo.js';
import { requireProjectPermission } from '../middleware/rbac.js';
import * as piiPatternRepo from '../repos/pii-pattern-repo.js';
import {
  isBuiltinPIIType,
  normalizePatternConsumerAccess,
  normalizePatternPayloadForStorage,
  validatePattern,
  testPattern,
} from '../services/pii/pattern-service.js';
import { bumpPIIConfigEpoch } from '../services/pii/pii-epoch.js';

const log = createLogger('pii-patterns-route');

const router: RouterType = Router({ mergeParams: true });

// All routes require authentication + rate limiting
router.use(authMiddleware);
router.use(tenantRateLimit('request'));

// =============================================================================
// HELPERS
// =============================================================================

function getTenantId(req: any): string | null {
  const contextTenantId = req.tenantContext?.tenantId;
  if (!contextTenantId) return null;
  return contextTenantId;
}

function getProjectId(req: any): string | null {
  const projectId = req.params.projectId;
  if (!projectId || typeof projectId !== 'string') return null;
  return projectId;
}

function requirePiiPatternProjectPermission(permission: string): RequestHandler {
  return (req, res, next) => {
    void requireProjectPermission(req, res, permission)
      .then((allowed) => {
        if (allowed) next();
      })
      .catch(next);
  };
}

/** Fields that cannot be set/overridden by the client */
const PROTECTED_FIELDS = new Set([
  'tenantId',
  'projectId',
  '_id',
  '_v',
  'createdAt',
  'updatedAt',
  'createdBy',
]);

/**
 * Strip protected fields from a request body before passing to create/update.
 */
function sanitizeBody(body: Record<string, unknown>): Record<string, unknown> {
  const sanitized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(body)) {
    if (!PROTECTED_FIELDS.has(key)) {
      sanitized[key] = value;
    }
  }
  return sanitized;
}

// =============================================================================
// LIST — GET /
// =============================================================================

router.get('/', requirePiiPatternProjectPermission('pii-pattern:read'), async (req: any, res) => {
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

    const projectId = getProjectId(req);
    if (!projectId) {
      res.status(400).json({
        success: false,
        error: { code: 'VALIDATION_ERROR', message: 'Missing projectId' },
      });
      return;
    }

    const patterns = await piiPatternRepo.findAll(tenantId, projectId);
    res.json({ success: true, data: patterns });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error('Failed to list PII patterns', { error: message, requestId });
    res.status(500).json({
      success: false,
      error: { code: 'INTERNAL_ERROR', message: 'Failed to list PII patterns' },
    });
  }
});

// =============================================================================
// CREATE — POST /
// =============================================================================

router.post('/', requirePiiPatternProjectPermission('pii-pattern:write'), async (req: any, res) => {
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

    const projectId = getProjectId(req);
    if (!projectId) {
      res.status(400).json({
        success: false,
        error: { code: 'VALIDATION_ERROR', message: 'Missing projectId' },
      });
      return;
    }

    // Validate the pattern
    const validation = await validatePattern(req.body, tenantId, projectId);
    if (!validation.valid) {
      res.status(400).json({
        success: false,
        error: { code: 'VALIDATION_ERROR', message: validation.errors.join('; ') },
      });
      return;
    }

    const sanitized = normalizePatternPayloadForStorage(sanitizeBody(req.body));
    const userId = req.tenantContext?.userId;
    const isBuiltinOverride = sanitized.builtinOverride === true;

    // Built-in overrides upsert by (projectId, piiType). At most one override
    // exists per type by definition; concurrent POSTs converge on one record.
    if (isBuiltinOverride) {
      const piiType = sanitized.piiType as string | undefined;
      if (!piiType) {
        res.status(400).json({
          success: false,
          error: {
            code: 'VALIDATION_ERROR',
            message: 'piiType is required for built-in overrides',
          },
        });
        return;
      }
      const { pattern, created } = await piiPatternRepo.upsertBuiltinOverride(
        tenantId,
        projectId,
        piiType,
        { ...sanitized, createdBy: userId || 'unknown' },
      );
      await bumpPIIConfigEpoch(tenantId, projectId);

      log.info(created ? 'PII built-in override created' : 'PII built-in override updated', {
        tenantId,
        projectId,
        piiType,
        name: pattern.name,
        requestId,
      });
      writeAuditLog({
        action: created ? 'pii-pattern:create' : 'pii-pattern:update',
        tenantId,
        userId,
        metadata: {
          patternId: pattern._id,
          name: pattern.name,
          piiType,
          builtinOverride: true,
          projectId,
          requestId,
        },
      });

      res.status(created ? 201 : 200).json({ success: true, data: pattern });
      return;
    }

    // Custom patterns: standard create path.
    const pattern = await piiPatternRepo.create({
      ...sanitized,
      tenantId,
      projectId,
      createdBy: userId || 'unknown',
    });
    await bumpPIIConfigEpoch(tenantId, projectId);

    log.info('PII pattern created', { tenantId, projectId, name: pattern.name, requestId });
    writeAuditLog({
      action: 'pii-pattern:create',
      tenantId,
      userId,
      metadata: { patternId: pattern._id, name: pattern.name, projectId, requestId },
    });

    res.status(201).json({ success: true, data: pattern });
  } catch (err: any) {
    const message = err instanceof Error ? err.message : String(err);
    if (err?.code === 11000) {
      res.status(409).json({
        success: false,
        error: { code: 'DUPLICATE', message: 'A PII pattern with this name already exists' },
      });
      return;
    }
    log.error('Failed to create PII pattern', { error: message, requestId });
    res.status(500).json({
      success: false,
      error: { code: 'INTERNAL_ERROR', message: 'Failed to create PII pattern' },
    });
  }
});

// =============================================================================
// TEST — POST /test
// =============================================================================

router.post(
  '/test',
  requirePiiPatternProjectPermission('pii-pattern:read'),
  async (req: any, res) => {
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

      const { regex, text, validate, redaction, consumerAccess, defaultRenderMode, piiType } =
        req.body;

      const normalizedRegex = typeof regex === 'string' ? regex.trim() : '';
      const canPreviewWithRegex = normalizedRegex.length > 0;
      const canPreviewWithBuiltinRecognizer = isBuiltinPIIType(piiType);

      if (!canPreviewWithRegex && !canPreviewWithBuiltinRecognizer) {
        res.status(400).json({
          success: false,
          error: {
            code: 'VALIDATION_ERROR',
            message: 'Missing required field: regex or a supported built-in piiType',
          },
        });
        return;
      }

      if (!text || typeof text !== 'string') {
        res.status(400).json({
          success: false,
          error: { code: 'VALIDATION_ERROR', message: 'Missing required field: text' },
        });
        return;
      }

      if (canPreviewWithRegex) {
        try {
          new RegExp(normalizedRegex);
        } catch {
          res.status(400).json({
            success: false,
            error: { code: 'VALIDATION_ERROR', message: 'Invalid regex: failed to compile' },
          });
          return;
        }
      }

      const result = testPattern(
        canPreviewWithRegex ? normalizedRegex : undefined,
        text,
        validate,
        redaction,
        normalizePatternConsumerAccess(consumerAccess, defaultRenderMode),
        defaultRenderMode,
        piiType,
      );

      res.json({ success: true, data: result });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error('Failed to test PII pattern', { error: message, requestId });
      res.status(500).json({
        success: false,
        error: { code: 'INTERNAL_ERROR', message: 'Failed to test PII pattern' },
      });
    }
  },
);

// =============================================================================
// GET BY ID — GET /:patternId
// =============================================================================

router.get(
  '/:patternId',
  requirePiiPatternProjectPermission('pii-pattern:read'),
  async (req: any, res) => {
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

      const projectId = getProjectId(req);
      if (!projectId) {
        res.status(400).json({
          success: false,
          error: { code: 'VALIDATION_ERROR', message: 'Missing projectId' },
        });
        return;
      }

      const pattern = await piiPatternRepo.findScopedByPatternId(
        tenantId,
        projectId,
        req.params.patternId,
      );
      if (!pattern) {
        res.status(404).json({
          success: false,
          error: { code: 'NOT_FOUND', message: 'PII pattern not found' },
        });
        return;
      }

      res.json({ success: true, data: pattern });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error('Failed to get PII pattern', { error: message, requestId });
      res.status(500).json({
        success: false,
        error: { code: 'INTERNAL_ERROR', message: 'Failed to get PII pattern' },
      });
    }
  },
);

// =============================================================================
// UPDATE — PUT /:patternId
// =============================================================================

router.put(
  '/:patternId',
  requirePiiPatternProjectPermission('pii-pattern:write'),
  async (req: any, res) => {
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

      const projectId = getProjectId(req);
      if (!projectId) {
        res.status(400).json({
          success: false,
          error: { code: 'VALIDATION_ERROR', message: 'Missing projectId' },
        });
        return;
      }

      // Validate the pattern (exclude current ID from uniqueness check)
      const validation = await validatePattern(req.body, tenantId, projectId, req.params.patternId);
      if (!validation.valid) {
        res.status(400).json({
          success: false,
          error: { code: 'VALIDATION_ERROR', message: validation.errors.join('; ') },
        });
        return;
      }

      const sanitized = normalizePatternPayloadForStorage(sanitizeBody(req.body));
      const updated = await piiPatternRepo.update(
        tenantId,
        projectId,
        req.params.patternId,
        sanitized,
      );

      if (!updated) {
        res.status(404).json({
          success: false,
          error: { code: 'NOT_FOUND', message: 'PII pattern not found' },
        });
        return;
      }
      await bumpPIIConfigEpoch(tenantId, projectId);

      const userId = req.tenantContext?.userId;
      log.info('PII pattern updated', {
        tenantId,
        projectId,
        patternId: req.params.patternId,
        requestId,
      });
      writeAuditLog({
        action: 'pii-pattern:update',
        tenantId,
        userId,
        metadata: {
          patternId: req.params.patternId,
          fields: Object.keys(sanitized),
          projectId,
          requestId,
        },
      });

      res.json({ success: true, data: updated });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error('Failed to update PII pattern', { error: message, requestId });
      res.status(500).json({
        success: false,
        error: { code: 'INTERNAL_ERROR', message: 'Failed to update PII pattern' },
      });
    }
  },
);

// =============================================================================
// DELETE — DELETE /:patternId
// =============================================================================

router.delete(
  '/:patternId',
  requirePiiPatternProjectPermission('pii-pattern:write'),
  async (req: any, res) => {
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

      const projectId = getProjectId(req);
      if (!projectId) {
        res.status(400).json({
          success: false,
          error: { code: 'VALIDATION_ERROR', message: 'Missing projectId' },
        });
        return;
      }

      const deleted = await piiPatternRepo.remove(tenantId, projectId, req.params.patternId);
      if (!deleted) {
        res.status(404).json({
          success: false,
          error: { code: 'NOT_FOUND', message: 'PII pattern not found' },
        });
        return;
      }
      await bumpPIIConfigEpoch(tenantId, projectId);

      const userId = req.tenantContext?.userId;
      log.info('PII pattern deleted', {
        tenantId,
        projectId,
        patternId: req.params.patternId,
        requestId,
      });
      writeAuditLog({
        action: 'pii-pattern:delete',
        tenantId,
        userId,
        metadata: {
          patternId: req.params.patternId,
          name: deleted.name,
          projectId,
          requestId,
        },
      });

      res.json({ success: true, data: { id: req.params.patternId } });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error('Failed to delete PII pattern', { error: message, requestId });
      res.status(500).json({
        success: false,
        error: { code: 'INTERNAL_ERROR', message: 'Failed to delete PII pattern' },
      });
    }
  },
);

export default router;
