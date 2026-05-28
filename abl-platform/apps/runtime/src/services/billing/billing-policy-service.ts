import { createLogger } from '@abl/compiler/platform';
import type { Plan } from '@agent-platform/config';
import type {
  BillingAddonMode,
  BillingMaterializationBasis,
  IBillingAddonPolicy,
  IBillingInteractionThreshold,
  IBillingMaterializationPolicy,
  IBillingUnitPolicy,
  IBillingUnitPolicyOverrides,
} from '@agent-platform/database/models';

const log = createLogger('billing-policy-service');

const VALID_PLANS: ReadonlySet<Plan> = new Set(['FREE', 'TEAM', 'BUSINESS', 'ENTERPRISE']);

export const DEFAULT_BILLING_UNIT_POLICY: IBillingUnitPolicy = {
  intervalMinutes: 15,
  excludedChannels: ['web_debug'],
  excludedSessionTypes: [],
  excludeProactiveWithoutUserInteraction: true,
  interactionThreshold: {
    minUserMessages: 1,
    minInteractiveTurns: 1,
    minEngagedSeconds: 0,
  },
  addons: {
    llm: {
      mode: 'per_call',
      bucketSize: null,
    },
    tool: {
      mode: 'per_call',
      bucketSize: null,
    },
  },
  materialization: {
    basis: 'time_window',
    timeWindowMinutes: 60,
    completedSessionsCount: null,
  },
};

export const PLAN_BILLING_UNIT_POLICIES: Record<Plan, IBillingUnitPolicy> = {
  FREE: cloneBillingUnitPolicy(DEFAULT_BILLING_UNIT_POLICY),
  TEAM: cloneBillingUnitPolicy(DEFAULT_BILLING_UNIT_POLICY),
  BUSINESS: cloneBillingUnitPolicy(DEFAULT_BILLING_UNIT_POLICY),
  ENTERPRISE: cloneBillingUnitPolicy(DEFAULT_BILLING_UNIT_POLICY),
};

export interface ResolvedBillingPolicy {
  tenantId: string;
  planTier: Plan;
  planDefaults: IBillingUnitPolicy;
  overrides: IBillingUnitPolicyOverrides | null;
  policy: IBillingUnitPolicy;
}

function toPlanTier(value: string | undefined | null): Plan {
  if (value && VALID_PLANS.has(value as Plan)) {
    return value as Plan;
  }

  return 'FREE';
}

function cloneInteractionThreshold(
  value: IBillingInteractionThreshold,
): IBillingInteractionThreshold {
  return {
    minUserMessages: value.minUserMessages,
    minInteractiveTurns: value.minInteractiveTurns,
    minEngagedSeconds: value.minEngagedSeconds,
  };
}

function cloneAddonPolicy(value: IBillingAddonPolicy): IBillingAddonPolicy {
  return {
    mode: value.mode,
    bucketSize: value.bucketSize,
  };
}

function cloneMaterializationPolicy(
  value: IBillingMaterializationPolicy,
): IBillingMaterializationPolicy {
  return {
    basis: value.basis,
    timeWindowMinutes: value.timeWindowMinutes,
    completedSessionsCount: value.completedSessionsCount,
  };
}

export function cloneBillingUnitPolicy(value: IBillingUnitPolicy): IBillingUnitPolicy {
  return {
    intervalMinutes: value.intervalMinutes,
    excludedChannels: [...value.excludedChannels],
    excludedSessionTypes: [...value.excludedSessionTypes],
    excludeProactiveWithoutUserInteraction: value.excludeProactiveWithoutUserInteraction,
    interactionThreshold: cloneInteractionThreshold(value.interactionThreshold),
    addons: {
      llm: cloneAddonPolicy(value.addons.llm),
      tool: cloneAddonPolicy(value.addons.tool),
    },
    materialization: cloneMaterializationPolicy(value.materialization),
  };
}

function cloneBillingUnitPolicyOverrides(
  value: IBillingUnitPolicyOverrides | null | undefined,
): IBillingUnitPolicyOverrides | null {
  if (!value) {
    return null;
  }

  return {
    intervalMinutes: value.intervalMinutes,
    excludedChannels: value.excludedChannels ? [...value.excludedChannels] : undefined,
    excludedSessionTypes: value.excludedSessionTypes ? [...value.excludedSessionTypes] : undefined,
    excludeProactiveWithoutUserInteraction: value.excludeProactiveWithoutUserInteraction,
    interactionThreshold: value.interactionThreshold
      ? {
          minUserMessages: value.interactionThreshold.minUserMessages,
          minInteractiveTurns: value.interactionThreshold.minInteractiveTurns,
          minEngagedSeconds: value.interactionThreshold.minEngagedSeconds,
        }
      : undefined,
    addons: value.addons
      ? {
          llm: value.addons.llm
            ? {
                mode: value.addons.llm.mode,
                bucketSize: value.addons.llm.bucketSize,
              }
            : undefined,
          tool: value.addons.tool
            ? {
                mode: value.addons.tool.mode,
                bucketSize: value.addons.tool.bucketSize,
              }
            : undefined,
        }
      : undefined,
    materialization: value.materialization
      ? {
          basis: value.materialization.basis,
          timeWindowMinutes: value.materialization.timeWindowMinutes,
          completedSessionsCount: value.materialization.completedSessionsCount,
        }
      : undefined,
  };
}

function stripUndefinedDeep(value: unknown): unknown {
  if (Array.isArray(value)) {
    return [...value];
  }

  if (!value || typeof value !== 'object') {
    return value;
  }

  const normalized: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (entry === undefined) {
      continue;
    }

    const nextValue = stripUndefinedDeep(entry);
    if (nextValue === undefined) {
      continue;
    }

    if (
      nextValue &&
      typeof nextValue === 'object' &&
      !Array.isArray(nextValue) &&
      Object.keys(nextValue as Record<string, unknown>).length === 0
    ) {
      continue;
    }

    normalized[key] = nextValue;
  }

  return normalized;
}

function hasOwnDefinedValues(value: Record<string, unknown> | null | undefined): boolean {
  if (!value) {
    return false;
  }

  for (const entry of Object.values(value)) {
    if (Array.isArray(entry)) {
      return true;
    }
    if (entry && typeof entry === 'object') {
      if (hasOwnDefinedValues(entry as Record<string, unknown>)) {
        return true;
      }
      continue;
    }
    if (entry !== undefined) {
      return true;
    }
  }

  return false;
}

export function hasBillingUnitPolicyOverrideValues(
  value: IBillingUnitPolicyOverrides | null | undefined,
): boolean {
  return hasOwnDefinedValues(value as Record<string, unknown> | null | undefined);
}

export function mergeBillingUnitPolicy(
  defaults: IBillingUnitPolicy,
  overrides: IBillingUnitPolicyOverrides | null | undefined,
): IBillingUnitPolicy {
  const merged = cloneBillingUnitPolicy(defaults);

  if (!overrides) {
    return merged;
  }

  if (typeof overrides.intervalMinutes === 'number') {
    merged.intervalMinutes = overrides.intervalMinutes;
  }

  if (Array.isArray(overrides.excludedChannels)) {
    merged.excludedChannels = [...overrides.excludedChannels];
  }

  if (Array.isArray(overrides.excludedSessionTypes)) {
    merged.excludedSessionTypes = [...overrides.excludedSessionTypes];
  }

  if (typeof overrides.excludeProactiveWithoutUserInteraction === 'boolean') {
    merged.excludeProactiveWithoutUserInteraction =
      overrides.excludeProactiveWithoutUserInteraction;
  }

  if (overrides.interactionThreshold) {
    merged.interactionThreshold = {
      minUserMessages:
        overrides.interactionThreshold.minUserMessages ??
        merged.interactionThreshold.minUserMessages,
      minInteractiveTurns:
        overrides.interactionThreshold.minInteractiveTurns ??
        merged.interactionThreshold.minInteractiveTurns,
      minEngagedSeconds:
        overrides.interactionThreshold.minEngagedSeconds ??
        merged.interactionThreshold.minEngagedSeconds,
    };
  }

  if (overrides.addons?.llm) {
    merged.addons.llm = mergeAddonPolicy(merged.addons.llm, overrides.addons.llm);
  }

  if (overrides.addons?.tool) {
    merged.addons.tool = mergeAddonPolicy(merged.addons.tool, overrides.addons.tool);
  }

  if (overrides.materialization) {
    merged.materialization = {
      basis: overrides.materialization.basis ?? merged.materialization.basis,
      timeWindowMinutes:
        overrides.materialization.timeWindowMinutes !== undefined
          ? overrides.materialization.timeWindowMinutes
          : merged.materialization.timeWindowMinutes,
      completedSessionsCount:
        overrides.materialization.completedSessionsCount !== undefined
          ? overrides.materialization.completedSessionsCount
          : merged.materialization.completedSessionsCount,
    };
  }

  return merged;
}

function mergeAddonPolicy(
  defaults: IBillingAddonPolicy,
  overrides: Partial<IBillingAddonPolicy>,
): IBillingAddonPolicy {
  return {
    mode: (overrides.mode ?? defaults.mode) as BillingAddonMode,
    bucketSize: overrides.bucketSize !== undefined ? overrides.bucketSize : defaults.bucketSize,
  };
}

function normalizePolicyOverrides(value: IBillingUnitPolicyOverrides): IBillingUnitPolicyOverrides {
  const cloned = cloneBillingUnitPolicyOverrides(value) ?? {};
  return (stripUndefinedDeep(cloned) as IBillingUnitPolicyOverrides) ?? {};
}

export class BillingPolicyService {
  getAllPlanDefaults(): Record<Plan, IBillingUnitPolicy> {
    return {
      FREE: cloneBillingUnitPolicy(PLAN_BILLING_UNIT_POLICIES.FREE),
      TEAM: cloneBillingUnitPolicy(PLAN_BILLING_UNIT_POLICIES.TEAM),
      BUSINESS: cloneBillingUnitPolicy(PLAN_BILLING_UNIT_POLICIES.BUSINESS),
      ENTERPRISE: cloneBillingUnitPolicy(PLAN_BILLING_UNIT_POLICIES.ENTERPRISE),
    };
  }

  getPlanDefaults(planTier: string | null | undefined): IBillingUnitPolicy {
    const normalizedPlanTier = toPlanTier(planTier);
    return cloneBillingUnitPolicy(PLAN_BILLING_UNIT_POLICIES[normalizedPlanTier]);
  }

  async getResolvedPolicy(tenantId: string): Promise<ResolvedBillingPolicy | null> {
    const { Subscription } = await import('@agent-platform/database/models');
    const subscription = await Subscription.findOne(
      { tenantId, status: 'active' },
      { tenantId: 1, planTier: 1, billingUnitPolicyOverrides: 1 },
    )
      .lean()
      .exec();

    if (!subscription) {
      return null;
    }

    const planTier = toPlanTier(subscription.planTier);
    const planDefaults = this.getPlanDefaults(planTier);
    const overrides = cloneBillingUnitPolicyOverrides(subscription.billingUnitPolicyOverrides);

    return {
      tenantId,
      planTier,
      planDefaults: cloneBillingUnitPolicy(planDefaults),
      overrides,
      policy: mergeBillingUnitPolicy(planDefaults, overrides),
    };
  }

  async updateTenantOverrides(
    tenantId: string,
    overrides: IBillingUnitPolicyOverrides,
  ): Promise<ResolvedBillingPolicy | null> {
    const { Subscription } = await import('@agent-platform/database/models');
    const normalizedOverrides = normalizePolicyOverrides(overrides);
    const result = await Subscription.findOneAndUpdate(
      { tenantId, status: 'active' },
      { $set: { billingUnitPolicyOverrides: normalizedOverrides } },
      { new: true },
    )
      .lean()
      .exec();

    if (!result) {
      return null;
    }

    log.info('Billing unit policy overrides updated', {
      tenantId,
      overrideKeys: Object.keys(normalizedOverrides),
    });

    return this.getResolvedPolicy(tenantId);
  }

  async clearTenantOverrides(tenantId: string): Promise<ResolvedBillingPolicy | null> {
    const { Subscription } = await import('@agent-platform/database/models');
    const result = await Subscription.findOneAndUpdate(
      { tenantId, status: 'active' },
      { $unset: { billingUnitPolicyOverrides: 1 } },
      { new: true },
    )
      .lean()
      .exec();

    if (!result) {
      return null;
    }

    log.info('Billing unit policy overrides cleared', { tenantId });
    return this.getResolvedPolicy(tenantId);
  }
}

export const BILLING_MATERIALIZATION_BASIS_VALUES: BillingMaterializationBasis[] = [
  'time_window',
  'completed_sessions',
];

export const BILLING_ADDON_MODE_VALUES: BillingAddonMode[] = ['off', 'per_call', 'bucketed'];
