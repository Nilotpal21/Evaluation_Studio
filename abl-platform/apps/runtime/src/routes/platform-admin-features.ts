/**
 * Platform Admin — Feature Catalog & Tenant Feature Resolution
 *
 * Provides a static feature catalog and per-tenant feature resolution
 * based on active deals and subscription plan defaults.
 *
 * Key rules:
 * - Catalog endpoint requires `requirePlatformAdmin()` — only super-admins
 * - Tenant features endpoint also requires platform admin
 *
 * Mount: /api/platform/admin/features
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
import { PLAN_FEATURES } from '../middleware/feature-gate.js';

const log = createLogger('platform-admin-features');
const router: ReturnType<typeof Router> = Router();

// ─── Middleware ────────────────────────────────────────────────────────────

router.use(platformAdminAuthMiddleware);
router.use(tenantRateLimit('request'));
router.use(requirePlatformAdmin());
router.use(requirePlatformAdminIp(() => getConfig().security.platformAdminAllowedIps));

// ─── Feature Catalog ──────────────────────────────────────────────────────

const FEATURE_CATALOG: Record<string, { name: string; description: string; tier: string }> = {
  kms_byok: {
    name: 'KMS BYOK',
    description: 'Bring your own encryption keys',
    tier: 'ENTERPRISE',
  },
  custom_models: {
    name: 'Custom Models',
    description: 'Custom model provisioning',
    tier: 'BUSINESS',
  },
  audit_export: {
    name: 'Audit Export',
    description: 'Export audit logs',
    tier: 'BUSINESS',
  },
  voice_channels: {
    name: 'Voice Channels',
    description: 'Voice channel integration',
    tier: 'FREE',
  },
  advanced_analytics: {
    name: 'Advanced Analytics',
    description: 'Advanced analytics dashboard',
    tier: 'TEAM',
  },
  sso: {
    name: 'SSO',
    description: 'Single sign-on',
    tier: 'BUSINESS',
  },
  guardrails: {
    name: 'Guardrails',
    description: 'Content guardrails',
    tier: 'TEAM',
  },
  connectors: {
    name: 'Connectors',
    description: 'External connectors',
    tier: 'TEAM',
  },
  governance: {
    name: 'Governance',
    description: 'Compliance policies, governance status, audit timeline, and export reports',
    tier: 'ADD_ON',
  },
};

// PLAN_FEATURES imported from ../middleware/feature-gate.js (single source of truth)

// ─── GET /catalog — Feature catalog ───────────────────────────────────────

router.get('/catalog', (_req, res) => {
  res.json({ success: true, catalog: FEATURE_CATALOG });
});

// ─── GET /tenants/:tenantId/features — Resolved features for a tenant ─────

router.get('/tenants/:tenantId/features', async (req, res) => {
  try {
    const { tenantId } = req.params;
    const { Tenant, Deal, Subscription } = await import('@agent-platform/database/models');

    const tenant = await Tenant.findOne({ _id: tenantId }).lean().exec();
    if (!tenant) {
      res.status(404).json({
        success: false,
        error: { code: 'TENANT_NOT_FOUND', message: 'Tenant not found' },
      });
      return;
    }

    const organizationId = (tenant as any).organizationId || tenantId;

    // Get features from active deals
    const deals = await Deal.find({ organizationId, status: 'active' }).lean().exec();
    const dealFeatures = new Set(deals.flatMap((d: any) => d.features || []));

    // Get features from subscription plan defaults
    const subscription = await Subscription.findOne({
      tenantId,
      status: 'active',
    })
      .lean()
      .exec();
    const planTier = (subscription as any)?.planTier || 'FREE';
    const planFeatures = PLAN_FEATURES[planTier] || [];

    // Read entitlement overrides from subscription (feature:* and feature:deny:*)
    const entitlements: string[] = (subscription as any)?.entitlements ?? [];
    const grantedByEntitlement = new Set<string>();
    const deniedByEntitlement = new Set<string>();
    for (const ent of entitlements) {
      if (ent.startsWith('feature:deny:')) {
        deniedByEntitlement.add(ent.slice('feature:deny:'.length));
      } else if (ent.startsWith('feature:')) {
        grantedByEntitlement.add(ent.slice('feature:'.length));
      }
    }

    // Union all features: plan + deals + entitlement grants, minus entitlement denials
    const allFeatureNames = Object.keys(FEATURE_CATALOG);
    const features: Record<string, boolean> = {};
    for (const name of allFeatureNames) {
      if (deniedByEntitlement.has(name)) {
        features[name] = false;
      } else if (grantedByEntitlement.has(name)) {
        features[name] = true;
      } else {
        features[name] = dealFeatures.has(name) || planFeatures.includes(name);
      }
    }

    res.json({
      success: true,
      tenantId,
      planTier,
      features,
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    log.error('Failed to resolve tenant features', { error: message });
    res.status(500).json({
      success: false,
      error: { code: 'INTERNAL_ERROR', message: 'Failed to resolve tenant features' },
    });
  }
});

// ─── PATCH /tenants/:tenantId/features — Toggle a single feature override ────

const featureToggleSchema = z.object({
  featureId: z.string().min(1, 'featureId is required'),
  enabled: z.boolean({ required_error: 'enabled is required' }),
});

router.patch('/tenants/:tenantId/features', async (req, res) => {
  const requestId = getCurrentRequestId();
  try {
    const { tenantId } = req.params;
    const parsed = featureToggleSchema.safeParse(req.body);
    if (!parsed.success) {
      res
        .status(400)
        .json({ success: false, error: 'Invalid request', details: parsed.error.issues });
      return;
    }

    const { featureId, enabled } = parsed.data;

    // Validate featureId exists in catalog
    if (!FEATURE_CATALOG[featureId]) {
      res.status(400).json({
        success: false,
        error: { code: 'UNKNOWN_FEATURE', message: `Unknown feature: ${featureId}` },
      });
      return;
    }

    const { Subscription } = await import('@agent-platform/database/models');
    const adminUserId = req.tenantContext!.userId;

    // Find active subscription for this tenant
    const subscription = await Subscription.findOne({
      tenantId,
      status: 'active',
    }).exec();

    if (!subscription) {
      res.status(404).json({
        success: false,
        error: { code: 'NO_SUBSCRIPTION', message: 'No active subscription found for tenant' },
      });
      return;
    }

    // Use the entitlements array to store explicit feature overrides.
    // Entitlements prefixed with "feature:" are admin-toggled overrides.
    // Entitlements prefixed with "feature:deny:" are explicit deny overrides.
    const grantKey = `feature:${featureId}`;
    const denyKey = `feature:deny:${featureId}`;
    const currentEntitlements: string[] = subscription.entitlements ?? [];

    let updatedEntitlements: string[];

    if (enabled) {
      // Add the grant entitlement, remove any deny entitlement
      updatedEntitlements = currentEntitlements.filter((e) => e !== denyKey);
      if (!updatedEntitlements.includes(grantKey)) {
        updatedEntitlements.push(grantKey);
      }
    } else {
      // Add a deny entitlement, remove any grant entitlement
      updatedEntitlements = currentEntitlements.filter((e) => e !== grantKey);
      if (!updatedEntitlements.includes(denyKey)) {
        updatedEntitlements.push(denyKey);
      }
    }

    await Subscription.updateOne(
      { _id: subscription._id },
      { $set: { entitlements: updatedEntitlements } },
    ).exec();

    log.info('Tenant feature toggled', {
      tenantId,
      featureId,
      enabled,
      adminUserId,
      requestId,
    });
    writeAuditLog({
      action: 'platform-admin:toggle-tenant-feature',
      userId: adminUserId,
      tenantId,
      metadata: { featureId, enabled, requestId },
    });

    res.json({ success: true, featureId, enabled });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    log.error('Failed to toggle tenant feature', { error: message, requestId });
    res.status(500).json({
      success: false,
      error: { code: 'INTERNAL_ERROR', message: 'Failed to toggle tenant feature' },
    });
  }
});

export default router;
