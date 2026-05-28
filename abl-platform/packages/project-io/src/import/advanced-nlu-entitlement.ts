import { PLAN_FEATURES } from '@agent-platform/shared-kernel';
import { createLogger } from '@abl/compiler/platform/logger.js';

const log = createLogger('advanced-nlu-entitlement');

export const ADVANCED_NLU_FEATURE = 'advanced_nlu';

export interface AdvancedNluEntitlementOptions {
  ensureReady?: () => Promise<void>;
}

export interface AdvancedNluEntitlementResult {
  allowed: boolean;
  source: 'deal' | 'subscription' | 'none' | 'error';
}

async function resolveOrganizationId(tenantId: string): Promise<string> {
  try {
    const { Tenant } = await import('@agent-platform/database/models');
    const tenant = await Tenant.findOne({ _id: tenantId }).lean().exec();
    const organizationId = (tenant as Record<string, unknown> | null)?.organizationId;
    if (typeof organizationId === 'string' && organizationId.trim().length > 0) {
      return organizationId;
    }
  } catch (error) {
    log.warn('Advanced NLU organization lookup failed; falling back to tenant id', {
      tenantId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
  return tenantId;
}

export async function resolveAdvancedNluEntitlement(
  tenantId: string,
  options: AdvancedNluEntitlementOptions = {},
): Promise<AdvancedNluEntitlementResult> {
  try {
    await options.ensureReady?.();

    const { Deal, Subscription } = await import('@agent-platform/database/models');
    const organizationId = await resolveOrganizationId(tenantId);
    const deals = await Deal.find({ organizationId, status: 'active' }).lean().exec();
    const dealFeatures = new Set(
      deals.flatMap((deal: Record<string, unknown>) =>
        Array.isArray(deal.features) ? (deal.features as string[]) : [],
      ),
    );

    if (dealFeatures.has(ADVANCED_NLU_FEATURE)) {
      return { allowed: true, source: 'deal' };
    }

    const subscription = await Subscription.findOne({ tenantId, status: 'active' })
      .sort({ createdAt: -1 })
      .lean()
      .exec();
    const planTier =
      ((subscription as Record<string, unknown> | null)?.planTier as string | undefined) ?? 'FREE';
    const planFeatures = PLAN_FEATURES[planTier] ?? [];

    return {
      allowed: planFeatures.includes(ADVANCED_NLU_FEATURE),
      source: 'subscription',
    };
  } catch (error) {
    log.error('Advanced NLU entitlement resolution failed; failing closed', {
      tenantId,
      error: error instanceof Error ? error.message : String(error),
    });
    return { allowed: false, source: 'error' };
  }
}
