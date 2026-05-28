/**
 * Feature Gate Middleware
 *
 * Checks whether a given feature is available for the authenticated tenant.
 * Resolves features from active deals (by organizationId) and the tenant's
 * subscription plan defaults.
 *
 * Resolution order:
 *   1. Active deals for the tenant's organization → deal.features[]
 *   2. Active subscription plan defaults → PLAN_FEATURES[planTier]
 *   3. If neither grants the feature → 403 FEATURE_NOT_AVAILABLE
 *
 * Fail-open: if the gate check encounters an error, the request proceeds
 * to avoid blocking legitimate traffic on transient failures.
 */

import type { Request, Response, NextFunction } from 'express';
import { createLogger } from '@abl/compiler/platform';
import { PLAN_FEATURES } from '@agent-platform/shared-kernel';

export { PLAN_FEATURES };

const log = createLogger('feature-gate');

/**
 * Resolve the organizationId for a tenant.
 *
 * Prefers the orgId already on the auth context (set during auth resolution).
 * Falls back to looking up the Tenant document in the database, then to
 * using the tenantId itself as the organizationId.
 */
async function resolveOrganizationId(tenantId: string, contextOrgId?: string): Promise<string> {
  if (contextOrgId) return contextOrgId;

  try {
    const { Tenant } = await import('@agent-platform/database/models');
    const tenant = await Tenant.findOne({ _id: tenantId }).lean().exec();
    if (tenant && (tenant as any).organizationId) {
      return (tenant as any).organizationId;
    }
  } catch {
    // DB lookup failed — fall back to tenantId
  }

  return tenantId;
}

/**
 * Express middleware factory that gates a route behind a feature flag.
 *
 * **WARNING: This function fails OPEN on errors** — if the feature flag
 * check throws (e.g. DB outage), the request is allowed through. This is
 * appropriate for non-security-critical features (cosmetic flags, A/B tests).
 *
 * For security-critical features like reusable modules, use
 * {@link createModuleFeatureGate} instead, which fails CLOSED (returns 503).
 *
 * Must be placed AFTER authMiddleware in the middleware chain so that
 * req.tenantContext is populated.
 *
 * @see createModuleFeatureGate — fail-closed alternative for security-critical features
 */
export function requireFeature(featureName: string) {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      // Get tenantId from request context (set by authMiddleware)
      const tenantId = (req as any).tenantContext?.tenantId;
      if (!tenantId) {
        res.status(403).json({
          success: false,
          error: {
            code: 'FEATURE_NOT_AVAILABLE',
            message: 'No tenant context',
          },
        });
        return;
      }

      const { Deal, Subscription } = await import('@agent-platform/database/models');

      // Resolve the organization that owns this tenant — deals are scoped to orgs
      const organizationId = await resolveOrganizationId(
        tenantId,
        (req as any).tenantContext?.orgId,
      );

      // 1. Check active deals for the feature
      const deals = await Deal.find({
        organizationId,
        status: 'active',
      })
        .lean()
        .exec();

      const dealFeatures = new Set(deals.flatMap((d: any) => d.features || []));

      if (dealFeatures.has(featureName)) {
        next();
        return;
      }

      // 2. Fall back to subscription plan defaults
      const subscription = await Subscription.findOne({
        tenantId,
        status: 'active',
      })
        .lean()
        .exec();
      const planTier = (subscription as any)?.planTier || 'FREE';

      const planFeatures = PLAN_FEATURES[planTier] || [];
      if (planFeatures.includes(featureName)) {
        next();
        return;
      }

      // 3. Feature not available — reject
      log.info('Feature gate denied', { featureName, tenantId, planTier });
      res.status(403).json({
        success: false,
        error: {
          code: 'FEATURE_NOT_AVAILABLE',
          message: `Feature '${featureName}' is not available on your current plan`,
        },
      });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      log.error('Feature gate check failed', { featureName, error: message });
      // Fail open — don't block on gate check failures
      next();
    }
  };
}

/**
 * Fail-closed feature gate factory.
 *
 * Unlike requireFeature which fails open on errors, this middleware returns
 * 503 on any error to prevent unauthorized access to security-critical
 * features during outages.
 *
 * Usage:
 *   router.use(createFailClosedFeatureGate('omnichannel_session_continuity'));
 *   router.use(createModuleFeatureGate()); // backward-compatible, defaults to 'reusable_modules'
 */
export function createFailClosedFeatureGate(featureName: string) {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      const tenantId = (req as any).tenantContext?.tenantId;
      if (!tenantId) {
        res.status(403).json({
          success: false,
          error: {
            code: 'FEATURE_DISABLED',
            message: 'No tenant context',
          },
        });
        return;
      }

      const { Deal, Subscription } = await import('@agent-platform/database/models');

      const organizationId = await resolveOrganizationId(
        tenantId,
        (req as any).tenantContext?.orgId,
      );

      // 1. Check active deals for the feature
      const deals = await Deal.find({
        organizationId,
        status: 'active',
      })
        .lean()
        .exec();

      const dealFeatures = new Set(deals.flatMap((d: any) => d.features || []));

      if (dealFeatures.has(featureName)) {
        next();
        return;
      }

      // 2. Fall back to subscription plan defaults
      const subscription = await Subscription.findOne({
        tenantId,
        status: 'active',
      })
        .lean()
        .exec();
      const planTier = (subscription as any)?.planTier || 'FREE';

      const planFeatures = PLAN_FEATURES[planTier] || [];
      if (planFeatures.includes(featureName)) {
        next();
        return;
      }

      // 3. Feature not available — reject
      log.info('Fail-closed feature gate denied', { featureName, tenantId, planTier });
      res.status(403).json({
        success: false,
        error: {
          code: 'FEATURE_DISABLED',
          message: `Feature '${featureName}' is not available on your current plan`,
        },
      });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      log.error('Fail-closed feature gate check failed', {
        featureName,
        error: message,
      });
      // FAIL CLOSED — return 503, do NOT call next()
      res.status(503).json({
        success: false,
        error: {
          code: 'SERVICE_UNAVAILABLE',
          message: 'Feature check unavailable',
        },
      });
    }
  };
}

/**
 * Module-specific feature gate that fails CLOSED.
 * Backward-compatible wrapper around createFailClosedFeatureGate.
 *
 * Usage:
 *   router.use(createModuleFeatureGate());
 */
export function createModuleFeatureGate() {
  return createFailClosedFeatureGate('reusable_modules');
}
