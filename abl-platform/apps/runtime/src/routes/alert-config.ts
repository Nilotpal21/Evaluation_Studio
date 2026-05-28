/**
 * Alert Configuration Routes
 *
 * Tenant-scoped alert configuration CRUD for usage thresholds,
 * credit-low warnings, health degradation, and feature limits.
 *
 * Mount: /api/tenants/:tenantId/alerts
 */

import { Router, type Request, type Response, type Router as RouterType } from 'express';
import { authMiddleware } from '../middleware/auth.js';
import { tenantRateLimit } from '../middleware/rate-limiter.js';
import { requirePermission } from '@agent-platform/shared-auth';
import { createLogger } from '@abl/compiler/platform';
import { writeAuditLog } from '../repos/auth-repo.js';
import { assertAllowedCallbackUrl } from '../channels/security/callback-url-policy.js';

const log = createLogger('alert-config-route');

const router: RouterType = Router({ mergeParams: true });

router.use(authMiddleware);
router.use(tenantRateLimit('request'));

// ─── Helpers ────────────────────────────────────────────────────────────────

const VALID_TYPES = ['usage_threshold', 'credit_low', 'health_degraded', 'feature_limit'] as const;
const VALID_CHANNELS = ['webhook', 'email'] as const;

function getTenantId(req: Request): string | null {
  const contextTenantId = (req as any).tenantContext?.tenantId;
  if (!contextTenantId) return null;

  const paramTenantId = req.params.tenantId;
  if (paramTenantId && paramTenantId !== contextTenantId) {
    return null;
  }

  return contextTenantId;
}

function getUserId(req: Request): string | null {
  return (req as any).user?.userId ?? (req as any).user?.id ?? null;
}

// ─── GET / — List alert configs ─────────────────────────────────────────────

router.get('/', requirePermission('credential:read'), async (req: Request, res: Response) => {
  try {
    const tenantId = getTenantId(req);
    if (!tenantId) {
      res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Not found' } });
      return;
    }

    const { AlertConfig } = await import('@agent-platform/database/models');
    const configs = await AlertConfig.find({ tenantId }).lean().exec();

    res.json({ success: true, configs });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    log.error('Failed to list alert configs', { error: message });
    res.status(500).json({
      success: false,
      error: { code: 'INTERNAL_ERROR', message: 'Failed to list alert configs' },
    });
  }
});

// ─── POST / — Create alert config ──────────────────────────────────────────

router.post('/', requirePermission('credential:manage'), async (req: Request, res: Response) => {
  try {
    const tenantId = getTenantId(req);
    if (!tenantId) {
      res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Not found' } });
      return;
    }

    const { type, threshold, channel, target, enabled, cooldownMinutes } = req.body;

    // Validate required fields
    if (!type || !VALID_TYPES.includes(type)) {
      res.status(400).json({
        success: false,
        error: {
          code: 'VALIDATION_ERROR',
          message: `Invalid type. Must be one of: ${VALID_TYPES.join(', ')}`,
        },
      });
      return;
    }
    if (typeof threshold !== 'number' || threshold < 0 || threshold > 100) {
      res.status(400).json({
        success: false,
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Threshold must be a number between 0 and 100',
        },
      });
      return;
    }
    if (!channel || !VALID_CHANNELS.includes(channel)) {
      res.status(400).json({
        success: false,
        error: {
          code: 'VALIDATION_ERROR',
          message: `Invalid channel. Must be one of: ${VALID_CHANNELS.join(', ')}`,
        },
      });
      return;
    }
    if (!target || typeof target !== 'string' || !target.trim()) {
      res.status(400).json({
        success: false,
        error: { code: 'VALIDATION_ERROR', message: 'Target is required' },
      });
      return;
    }

    // SSRF protection: validate webhook URLs before persisting
    if (channel === 'webhook') {
      try {
        const isProduction = process.env.NODE_ENV === 'production';
        await assertAllowedCallbackUrl(target.trim(), isProduction);
      } catch {
        res.status(400).json({
          success: false,
          error: { code: 'INVALID_URL', message: 'Webhook URL is not allowed' },
        });
        return;
      }
    }

    const { AlertConfig } = await import('@agent-platform/database/models');

    const config = await AlertConfig.create({
      tenantId,
      type,
      threshold,
      channel,
      target: target.trim(),
      enabled: enabled !== false,
      cooldownMinutes:
        typeof cooldownMinutes === 'number' && cooldownMinutes > 0 ? cooldownMinutes : 60,
    });

    const userId = getUserId(req);
    writeAuditLog({
      action: 'alert_config.created',
      userId,
      tenantId,
      metadata: { alertConfigId: config._id, type, channel },
    });

    log.info('Alert config created', { alertConfigId: config._id, tenantId, type });
    res.status(201).json({ success: true, config: config.toObject() });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    log.error('Failed to create alert config', { error: message });
    res.status(500).json({
      success: false,
      error: { code: 'INTERNAL_ERROR', message: 'Failed to create alert config' },
    });
  }
});

// ─── PATCH /:id — Update alert config ──────────────────────────────────────

router.patch(
  '/:id',
  requirePermission('credential:manage'),
  async (req: Request, res: Response) => {
    try {
      const tenantId = getTenantId(req);
      if (!tenantId) {
        res
          .status(404)
          .json({ success: false, error: { code: 'NOT_FOUND', message: 'Not found' } });
        return;
      }

      const { id } = req.params;
      const updates: Record<string, unknown> = {};

      // Validate and pick allowed fields
      if (req.body.type !== undefined) {
        if (!VALID_TYPES.includes(req.body.type)) {
          res.status(400).json({
            success: false,
            error: {
              code: 'VALIDATION_ERROR',
              message: `Invalid type. Must be one of: ${VALID_TYPES.join(', ')}`,
            },
          });
          return;
        }
        updates.type = req.body.type;
      }
      if (req.body.threshold !== undefined) {
        if (
          typeof req.body.threshold !== 'number' ||
          req.body.threshold < 0 ||
          req.body.threshold > 100
        ) {
          res.status(400).json({
            success: false,
            error: {
              code: 'VALIDATION_ERROR',
              message: 'Threshold must be a number between 0 and 100',
            },
          });
          return;
        }
        updates.threshold = req.body.threshold;
      }
      if (req.body.channel !== undefined) {
        if (!VALID_CHANNELS.includes(req.body.channel)) {
          res.status(400).json({
            success: false,
            error: {
              code: 'VALIDATION_ERROR',
              message: `Invalid channel. Must be one of: ${VALID_CHANNELS.join(', ')}`,
            },
          });
          return;
        }
        updates.channel = req.body.channel;
      }
      if (req.body.target !== undefined) {
        if (typeof req.body.target !== 'string' || !req.body.target.trim()) {
          res.status(400).json({
            success: false,
            error: { code: 'VALIDATION_ERROR', message: 'Target must be a non-empty string' },
          });
          return;
        }
        // SSRF protection: validate webhook URLs on update
        const effectiveChannel = req.body.channel || 'webhook';
        if (effectiveChannel === 'webhook') {
          try {
            const isProduction = process.env.NODE_ENV === 'production';
            await assertAllowedCallbackUrl(req.body.target.trim(), isProduction);
          } catch {
            res.status(400).json({
              success: false,
              error: { code: 'INVALID_URL', message: 'Webhook URL is not allowed' },
            });
            return;
          }
        }
        updates.target = req.body.target.trim();
      }
      if (req.body.enabled !== undefined) {
        updates.enabled = Boolean(req.body.enabled);
      }
      if (req.body.cooldownMinutes !== undefined) {
        if (typeof req.body.cooldownMinutes !== 'number' || req.body.cooldownMinutes < 1) {
          res.status(400).json({
            success: false,
            error: {
              code: 'VALIDATION_ERROR',
              message: 'Cooldown minutes must be a positive number',
            },
          });
          return;
        }
        updates.cooldownMinutes = req.body.cooldownMinutes;
      }

      if (Object.keys(updates).length === 0) {
        res.status(400).json({
          success: false,
          error: { code: 'VALIDATION_ERROR', message: 'No valid fields to update' },
        });
        return;
      }

      const { AlertConfig } = await import('@agent-platform/database/models');

      // Scope update to tenant to prevent cross-tenant access
      const config = await AlertConfig.findOneAndUpdate(
        { _id: id, tenantId },
        { $set: updates },
        { new: true },
      )
        .lean()
        .exec();

      if (!config) {
        res.status(404).json({
          success: false,
          error: { code: 'NOT_FOUND', message: 'Alert config not found' },
        });
        return;
      }

      const userId = getUserId(req);
      writeAuditLog({
        action: 'alert_config.updated',
        userId,
        tenantId,
        metadata: { alertConfigId: id, updates },
      });

      log.info('Alert config updated', { alertConfigId: id, tenantId });
      res.json({ success: true, config });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      log.error('Failed to update alert config', { error: message });
      res.status(500).json({
        success: false,
        error: { code: 'INTERNAL_ERROR', message: 'Failed to update alert config' },
      });
    }
  },
);

// ─── DELETE /:id — Delete alert config ─────────────────────────────────────

router.delete(
  '/:id',
  requirePermission('credential:manage'),
  async (req: Request, res: Response) => {
    try {
      const tenantId = getTenantId(req);
      if (!tenantId) {
        res
          .status(404)
          .json({ success: false, error: { code: 'NOT_FOUND', message: 'Not found' } });
        return;
      }

      const { id } = req.params;

      const { AlertConfig } = await import('@agent-platform/database/models');

      // Scope delete to tenant to prevent cross-tenant access
      const result = await AlertConfig.findOneAndDelete({ _id: id, tenantId }).lean().exec();

      if (!result) {
        res.status(404).json({
          success: false,
          error: { code: 'NOT_FOUND', message: 'Alert config not found' },
        });
        return;
      }

      const userId = getUserId(req);
      writeAuditLog({
        action: 'alert_config.deleted',
        userId,
        tenantId,
        metadata: { alertConfigId: id },
      });

      log.info('Alert config deleted', { alertConfigId: id, tenantId });
      res.json({ success: true });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      log.error('Failed to delete alert config', { error: message });
      res.status(500).json({
        success: false,
        error: { code: 'INTERNAL_ERROR', message: 'Failed to delete alert config' },
      });
    }
  },
);

export default router;
