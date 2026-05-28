/**
 * Facade-specific feature gate for the agent_assist feature.
 *
 * Unlike the general `requireFeature` middleware (which returns 403 and fails
 * open on DB errors), this wrapper:
 *   - Returns 404 APP_NOT_FOUND when the feature is off (existence-disclosure invariant)
 *   - Fails CLOSED (404) on DB errors
 *
 * Resolution order mirrors requireFeature:
 *   1. Active deals for the tenant's organization → deal.features[]
 *   2. Active subscription plan defaults → PLAN_FEATURES[planTier]
 *   3. If neither grants the feature → 404
 */

import type { Request, Response, NextFunction, RequestHandler } from 'express';
import { createLogger } from '@abl/compiler/platform';
import { PLAN_FEATURES } from '@agent-platform/shared-kernel';

const log = createLogger('agent-assist:feature-gate');

/** Sanitized 404 that matches the cross-tenant and binding-not-found responses. */
function send404(res: Response): void {
  res.status(404).json({
    success: false,
    error: { code: 'APP_NOT_FOUND', message: 'Agent Assist app not found.' },
  });
}

export interface FeatureGateDeps {
  /** Override for testing — resolves whether the feature is granted for a tenant. */
  resolveFeature?: (tenantId: string, orgId: string | undefined) => Promise<boolean>;
  /** Override for testing — resolves whether project-level agent assist is enabled. */
  resolveProjectEnabled?: (tenantId: string, projectId: string) => Promise<boolean | null>;
}

/**
 * Check if a feature name appears in the flat array of deal features.
 * Uses linear scan — deal feature arrays are small (typically < 20 elements).
 */
function hasDealFeature(deals: Record<string, unknown>[], featureName: string): boolean {
  for (const d of deals) {
    const features = d.features;
    if (Array.isArray(features)) {
      for (const f of features) {
        if (f === featureName) return true;
      }
    }
  }
  return false;
}

/**
 * Resolve whether a feature is granted to a tenant via Deal grants or plan tier.
 * Extracted as a pure-ish async function so it can be DI-overridden in tests.
 */
async function defaultResolveFeature(
  tenantId: string,
  contextOrgId: string | undefined,
): Promise<boolean> {
  const { Deal, Subscription, Tenant } = await import('@agent-platform/database/models');

  // Resolve organization ID
  let organizationId = contextOrgId;
  if (!organizationId) {
    try {
      const tenant = await Tenant.findOne({ _id: tenantId }).lean().exec();
      if (tenant && (tenant as Record<string, unknown>).organizationId) {
        organizationId = (tenant as Record<string, unknown>).organizationId as string;
      }
    } catch (err) {
      // Falling through to organizationId = tenantId hides genuine org-level
      // deal grants when the tenant lookup hiccups; keep the fallback for
      // resilience but surface the failure so it does not stay invisible.
      log.warn('Facade feature gate — tenant org lookup failed; falling back to tenantId', {
        tenantId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    if (!organizationId) organizationId = tenantId;
  }

  // 1. Check active deals
  const deals = await Deal.find({ organizationId, status: 'active' }).lean().exec();
  if (hasDealFeature(deals as Record<string, unknown>[], 'agent_assist')) return true;

  // 2. Check subscription plan tier
  const subscription = await Subscription.findOne({ tenantId, status: 'active' }).lean().exec();
  const planTier = (subscription as Record<string, unknown> | null)?.planTier || 'FREE';
  const planFeatures = PLAN_FEATURES[planTier as keyof typeof PLAN_FEATURES] || [];
  if (planFeatures.includes('agent_assist')) return true;

  return false;
}

/**
 * Check whether the project-level Agent Assist setting is enabled.
 *
 * Returns:
 *   - true  → project explicitly enabled
 *   - false → project explicitly disabled
 *   - null  → no settings doc (legacy/env-seeded binding — fail-open at project level)
 */
export async function resolveProjectAgentAssistEnabled(
  tenantId: string,
  projectId: string,
): Promise<boolean | null> {
  const { ProjectAgentAssistSettings } = await import('@agent-platform/database/models');
  const doc = await ProjectAgentAssistSettings.findOne({ tenantId, projectId }).lean();
  if (!doc) return null; // No doc → fail-open for legacy bindings
  return (doc as Record<string, unknown>).enabled === true;
}

/**
 * Create the facade feature gate middleware.
 * Returns 404 when feature is off or on DB error (fail-closed).
 *
 * Gate logic:
 *   1. Tenant must have agent_assist granted (via Deal or plan)
 *   2. If a ProjectAgentAssistSettings doc exists for (tenantId, projectId),
 *      it must be enabled. If no doc exists, fail-open (legacy bindings).
 *
 * NOTE: projectId is derived from appId in the URL params (since appId === projectId
 * for new bindings). For legacy bindings where appId !== projectId, the project-level
 * check passes (fail-open) because no ProjectAgentAssistSettings doc will exist for
 * those appIds.
 */
export function requireFacadeFeature(deps?: FeatureGateDeps): RequestHandler {
  const resolve = deps?.resolveFeature ?? defaultResolveFeature;
  const resolveProject = deps?.resolveProjectEnabled ?? resolveProjectAgentAssistEnabled;

  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const tenantId = (req as Request & { tenantContext?: Record<string, unknown> }).tenantContext
        ?.tenantId;
      if (typeof tenantId !== 'string' || !tenantId) {
        send404(res);
        return;
      }

      const orgId = (req as Request & { tenantContext?: Record<string, unknown> }).tenantContext
        ?.orgId as string | undefined;

      const granted = await resolve(tenantId, orgId);
      if (!granted) {
        log.info('Facade feature gate denied — agent_assist not granted', { tenantId });
        send404(res);
        return;
      }

      // Project-level check: appId from URL is the projectId for new bindings
      const appId = req.params.appId;
      if (typeof appId === 'string' && appId.length > 0) {
        const projectEnabled = await resolveProject(tenantId, appId);
        if (projectEnabled === false) {
          log.info('Facade feature gate denied — project agent assist disabled', {
            tenantId,
            projectId: appId,
          });
          send404(res);
          return;
        }
        // projectEnabled === null → no doc, fail-open (legacy)
        // projectEnabled === true → project enabled, continue
      }

      next();
    } catch (err) {
      // Fail CLOSED — return 404 on any error
      log.warn('Facade feature gate check failed — fail closed', {
        error: err instanceof Error ? err.message : String(err),
      });
      send404(res);
    }
  };
}
