/**
 * Platform Admin — Tenant Config Override Routes
 *
 * System admins view resolved configuration and manage per-tenant / per-project
 * quota overrides.  Writes target the Subscription model's `tenantQuotas` and
 * nested `projectQuotas` subdocuments.
 *
 * Key rules:
 * - All routes require `requirePlatformAdmin()` — only super-admins
 * - `tenantId` comes from the URL path — admin operates outside any tenant
 * - Every mutation invalidates the Redis config cache
 * - Every mutation writes an audit log with `platform-admin:` prefix
 *
 * Mount: /api/platform/admin/tenant-config
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
import { getTenantConfigService, PLAN_LIMITS } from '../services/tenant-config.js';
import type { TenantLimits } from '../services/tenant-config.js';

const log = createLogger('platform-admin-config');
const router: ReturnType<typeof Router> = Router();

// ─── Middleware ────────────────────────────────────────────────────────────

router.use(platformAdminAuthMiddleware);
router.use(tenantRateLimit('request'));
router.use(requirePlatformAdmin());
router.use(requirePlatformAdminIp(() => getConfig().security.platformAdminAllowedIps));

// ─── Validation ───────────────────────────────────────────────────────────

/** All keys of TenantLimits — used to validate override payloads. */
const VALID_LIMIT_KEYS = new Set<string>(Object.keys(PLAN_LIMITS.FREE));

/**
 * Zod schema for limit overrides.
 * Every field is optional but must be numeric if provided.
 */
const limitOverridesSchema = z
  .record(z.string(), z.number({ invalid_type_error: 'Override values must be numeric' }))
  .refine(
    (data) => Object.keys(data).every((key) => VALID_LIMIT_KEYS.has(key)),
    (data) => {
      const invalid = Object.keys(data).filter((key) => !VALID_LIMIT_KEYS.has(key));
      return { message: `Unknown limit keys: ${invalid.join(', ')}` };
    },
  );

// ─── Constants ────────────────────────────────────────────────────────────

/** Default page size for list endpoints */
const PAGINATION_DEFAULT_LIMIT = 25;

/** Maximum page size for list endpoints */
const PAGINATION_MAX_LIMIT = 100;

// ─── Helpers ──────────────────────────────────────────────────────────────

/** Parse pagination params with sensible defaults and caps. */
function parsePagination(query: Record<string, unknown>): {
  page: number;
  limit: number;
  skip: number;
} {
  const page = Math.max(1, parseInt(String(query.page ?? '1'), 10) || 1);
  const limit = Math.min(
    PAGINATION_MAX_LIMIT,
    Math.max(
      1,
      parseInt(String(query.limit ?? String(PAGINATION_DEFAULT_LIMIT)), 10) ||
        PAGINATION_DEFAULT_LIMIT,
    ),
  );
  const skip = (page - 1) * limit;
  return { page, limit, skip };
}

// ─── GET /plans — All plan defaults ──────────────────────────────────────

router.get('/plans', async (_req, res) => {
  const requestId = getCurrentRequestId();
  try {
    const configService = getTenantConfigService();
    const plans = configService.getAllPlanDefaults();
    res.json({ success: true, plans });
  } catch (error: any) {
    log.error('Failed to get plan defaults', { error: error?.message, requestId });
    res.status(500).json({ success: false, error: 'Failed to get plan defaults' });
  }
});

// ─── GET / — List tenant configs ─────────────────────────────────────────

router.get('/', async (req, res) => {
  const requestId = getCurrentRequestId();
  try {
    const tenantIdFilter = req.query.tenantId as string | undefined;

    // If a specific tenantId is provided, return its resolved config
    if (tenantIdFilter) {
      const configService = getTenantConfigService();
      const config = await configService.getConfigAsync(tenantIdFilter);
      res.json({
        success: true,
        configs: [config],
        pagination: { page: 1, limit: 1, total: 1, totalPages: 1 },
      });
      return;
    }

    // List tenants with active subscriptions that have overrides
    const { Subscription } = await import('@agent-platform/database/models');
    const { page, limit, skip } = parsePagination(req.query as Record<string, unknown>);

    const filter = {
      status: 'active',
      'tenantQuotas.0': { $exists: true },
    };

    const [subscriptions, total] = await Promise.all([
      Subscription.find(filter, { tenantId: 1, planTier: 1, tenantQuotas: 1 })
        .sort({ updatedAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean()
        .exec(),
      Subscription.countDocuments(filter).exec(),
    ]);

    const configs = subscriptions.map((sub: any) => {
      const tenantQuota = sub.tenantQuotas?.find((q: any) => q.tenantId === sub.tenantId);
      return {
        tenantId: sub.tenantId,
        planTier: sub.planTier,
        hasOverrides: !!(
          tenantQuota?.allocatedLimits &&
          typeof tenantQuota.allocatedLimits === 'object' &&
          Object.keys(tenantQuota.allocatedLimits).length > 0
        ),
        projectQuotaCount: tenantQuota?.projectQuotas?.length ?? 0,
      };
    });

    res.json({
      success: true,
      configs,
      pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
    });
  } catch (error: any) {
    log.error('Failed to list tenant configs', { error: error?.message, requestId });
    res.status(500).json({ success: false, error: 'Failed to list tenant configs' });
  }
});

// ─── GET /:tenantId — Resolved config for specific tenant ────────────────

router.get('/:tenantId', async (req, res) => {
  const requestId = getCurrentRequestId();
  try {
    const { tenantId } = req.params;
    const configService = getTenantConfigService();
    const config = await configService.getConfigAsync(tenantId);

    // Also fetch raw subscription overrides so admin can compare
    const { Subscription } = await import('@agent-platform/database/models');
    const subscription = await Subscription.findOne(
      { tenantId, status: 'active' },
      { planTier: 1, tenantQuotas: 1 },
    )
      .lean()
      .exec();

    const tenantQuota = subscription?.tenantQuotas?.find((q: any) => q.tenantId === tenantId);

    const planDefaults = configService.getPlanDefaults(config.plan);
    const overrides = tenantQuota?.allocatedLimits ?? {};

    res.json({
      success: true,
      config,
      planDefaults,
      overrides,
    });
  } catch (error: any) {
    log.error('Failed to get tenant config', { error: error?.message, requestId });
    res.status(500).json({ success: false, error: 'Failed to get tenant config' });
  }
});

// ─── PUT /:tenantId/overrides — Set tenant-level limit overrides ─────────

router.put('/:tenantId/overrides', async (req, res) => {
  const requestId = getCurrentRequestId();
  try {
    const { tenantId } = req.params;
    const parsed = limitOverridesSchema.safeParse(req.body);
    if (!parsed.success) {
      res
        .status(400)
        .json({ success: false, error: 'Invalid request', details: parsed.error.issues });
      return;
    }

    const validatedOverrides = parsed.data;
    if (Object.keys(validatedOverrides).length === 0) {
      res.status(400).json({ success: false, error: 'No overrides provided' });
      return;
    }

    const { Subscription } = await import('@agent-platform/database/models');
    const adminUserId = req.tenantContext!.userId;

    // Try to update existing tenantQuota entry
    let result = await Subscription.findOneAndUpdate(
      {
        tenantId,
        status: 'active',
        'tenantQuotas.tenantId': tenantId,
      },
      {
        $set: { 'tenantQuotas.$.allocatedLimits': validatedOverrides },
      },
      { new: true },
    ).exec();

    // If no matching tenantQuota entry exists, atomically push a new one.
    // The query guard `'tenantQuotas.tenantId': { $ne: tenantId }` prevents
    // duplicate entries when concurrent requests race on the same tenant.
    if (!result) {
      const now = new Date();
      result = await Subscription.findOneAndUpdate(
        {
          tenantId,
          status: 'active',
          'tenantQuotas.tenantId': { $ne: tenantId },
        },
        {
          $push: {
            tenantQuotas: {
              id: `tq-${tenantId}-${Date.now()}`,
              tenantId,
              allocatedLimits: validatedOverrides,
              burstAllowed: false,
              projectQuotas: [],
              createdAt: now,
              updatedAt: now,
            },
          },
        },
        { new: true },
      ).exec();

      // If still null, either no subscription exists or a concurrent request
      // already created the entry. Try the $set update one more time.
      if (!result) {
        result = await Subscription.findOneAndUpdate(
          {
            tenantId,
            status: 'active',
            'tenantQuotas.tenantId': tenantId,
          },
          {
            $set: { 'tenantQuotas.$.allocatedLimits': validatedOverrides },
          },
          { new: true },
        ).exec();
      }

      if (!result) {
        res.status(404).json({ success: false, error: 'No active subscription found for tenant' });
        return;
      }
    }

    // Invalidate Redis cache
    const configService = getTenantConfigService();
    await configService.invalidateCache(tenantId);

    log.info('Tenant config overrides updated', { tenantId, adminUserId, requestId });
    writeAuditLog({
      action: 'platform-admin:set-tenant-overrides',
      userId: adminUserId,
      tenantId,
      metadata: { overrideKeys: Object.keys(validatedOverrides), requestId },
    });

    // Return the updated resolved config
    const config = await configService.getConfigAsync(tenantId);
    res.json({ success: true, config, overrides: validatedOverrides });
  } catch (error: any) {
    log.error('Failed to set tenant config overrides', { error: error?.message, requestId });
    res.status(500).json({ success: false, error: 'Failed to set tenant config overrides' });
  }
});

// ─── DELETE /:tenantId/overrides — Clear tenant overrides ────────────────

router.delete('/:tenantId/overrides', async (req, res) => {
  const requestId = getCurrentRequestId();
  try {
    const { tenantId } = req.params;
    const { Subscription } = await import('@agent-platform/database/models');
    const adminUserId = req.tenantContext!.userId;

    const result = await Subscription.findOneAndUpdate(
      {
        tenantId,
        status: 'active',
        'tenantQuotas.tenantId': tenantId,
      },
      {
        $set: { 'tenantQuotas.$.allocatedLimits': {} },
      },
      { new: true },
    ).exec();

    if (!result) {
      res
        .status(404)
        .json({ success: false, error: 'No active subscription or tenant quota found' });
      return;
    }

    // Invalidate Redis cache
    const configService = getTenantConfigService();
    await configService.invalidateCache(tenantId);

    log.info('Tenant config overrides cleared', { tenantId, adminUserId, requestId });
    writeAuditLog({
      action: 'platform-admin:clear-tenant-overrides',
      userId: adminUserId,
      tenantId,
      metadata: { requestId },
    });

    res.json({ success: true, message: 'Tenant overrides cleared' });
  } catch (error: any) {
    log.error('Failed to clear tenant config overrides', { error: error?.message, requestId });
    res.status(500).json({ success: false, error: 'Failed to clear tenant config overrides' });
  }
});

// ─── PUT /:tenantId/projects/:projectId/overrides — Set project overrides ─

router.put('/:tenantId/projects/:projectId/overrides', async (req, res) => {
  const requestId = getCurrentRequestId();
  try {
    const { tenantId, projectId } = req.params;
    const parsed = limitOverridesSchema.safeParse(req.body);
    if (!parsed.success) {
      res
        .status(400)
        .json({ success: false, error: 'Invalid request', details: parsed.error.issues });
      return;
    }

    const validatedOverrides = parsed.data;
    if (Object.keys(validatedOverrides).length === 0) {
      res.status(400).json({ success: false, error: 'No overrides provided' });
      return;
    }

    const { Subscription } = await import('@agent-platform/database/models');
    const adminUserId = req.tenantContext!.userId;

    // Ensure the subscription and tenantQuota exist
    const subscription = await Subscription.findOne({
      tenantId,
      status: 'active',
      'tenantQuotas.tenantId': tenantId,
    }).exec();

    if (!subscription) {
      res
        .status(404)
        .json({ success: false, error: 'No active subscription or tenant quota found' });
      return;
    }

    const tenantQuota = subscription.tenantQuotas?.find((q: any) => q.tenantId === tenantId);

    if (!tenantQuota) {
      res.status(404).json({ success: false, error: 'No tenant quota found' });
      return;
    }

    const now = new Date();

    // Check if projectQuota already exists
    const existingProjectQuota = tenantQuota.projectQuotas?.find(
      (pq: any) => pq.projectId === projectId,
    );

    let updateResult;
    if (existingProjectQuota) {
      // Update existing project quota using arrayFilters for nested array
      updateResult = await Subscription.findOneAndUpdate(
        { _id: subscription._id, tenantId, status: 'active' },
        {
          $set: {
            'tenantQuotas.$[tq].projectQuotas.$[pq].allocatedLimits': validatedOverrides,
            'tenantQuotas.$[tq].projectQuotas.$[pq].updatedAt': now,
          },
        },
        {
          arrayFilters: [{ 'tq.tenantId': tenantId }, { 'pq.projectId': projectId }],
          new: true,
        },
      ).exec();
    } else {
      // Push new project quota entry
      updateResult = await Subscription.findOneAndUpdate(
        { _id: subscription._id, status: 'active', 'tenantQuotas.tenantId': tenantId },
        {
          $push: {
            'tenantQuotas.$.projectQuotas': {
              id: `pq-${projectId}-${Date.now()}`,
              projectId,
              allocatedLimits: validatedOverrides,
              overageBehavior: 'throttle',
              createdAt: now,
              updatedAt: now,
            },
          },
        },
        { new: true },
      ).exec();
    }

    if (!updateResult) {
      res.status(500).json({ success: false, error: 'Failed to update project overrides' });
      return;
    }

    // Invalidate Redis cache
    const configService = getTenantConfigService();
    await configService.invalidateCache(tenantId);

    log.info('Project config overrides updated', { tenantId, projectId, adminUserId, requestId });
    writeAuditLog({
      action: 'platform-admin:set-project-overrides',
      userId: adminUserId,
      tenantId,
      metadata: { projectId, overrideKeys: Object.keys(validatedOverrides), requestId },
    });

    res.json({ success: true, projectId, overrides: validatedOverrides });
  } catch (error: any) {
    log.error('Failed to set project config overrides', { error: error?.message, requestId });
    res.status(500).json({ success: false, error: 'Failed to set project config overrides' });
  }
});

// ─── DELETE /:tenantId/projects/:projectId/overrides — Clear project overrides ─

router.delete('/:tenantId/projects/:projectId/overrides', async (req, res) => {
  const requestId = getCurrentRequestId();
  try {
    const { tenantId, projectId } = req.params;
    const { Subscription } = await import('@agent-platform/database/models');
    const adminUserId = req.tenantContext!.userId;

    // Remove the project quota entry using $pull on the positional operator
    const result = await Subscription.findOneAndUpdate(
      { tenantId, status: 'active', 'tenantQuotas.tenantId': tenantId },
      {
        $pull: {
          'tenantQuotas.$.projectQuotas': { projectId },
        },
      },
      { new: true },
    ).exec();

    if (!result) {
      res
        .status(404)
        .json({ success: false, error: 'No active subscription or tenant quota found' });
      return;
    }

    // Invalidate Redis cache
    const configService = getTenantConfigService();
    await configService.invalidateCache(tenantId);

    log.info('Project config overrides cleared', { tenantId, projectId, adminUserId, requestId });
    writeAuditLog({
      action: 'platform-admin:clear-project-overrides',
      userId: adminUserId,
      tenantId,
      metadata: { projectId, requestId },
    });

    res.json({ success: true, message: 'Project overrides cleared' });
  } catch (error: any) {
    log.error('Failed to clear project config overrides', { error: error?.message, requestId });
    res.status(500).json({ success: false, error: 'Failed to clear project config overrides' });
  }
});

export default router;
