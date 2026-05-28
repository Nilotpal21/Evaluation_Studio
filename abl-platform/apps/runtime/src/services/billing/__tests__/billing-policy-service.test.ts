import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockSubscriptionFindOne = vi.fn();
const mockSubscriptionFindOneAndUpdate = vi.fn();

vi.mock('@agent-platform/database/models', () => ({
  Subscription: {
    findOne: (...args: unknown[]) => mockSubscriptionFindOne(...args),
    findOneAndUpdate: (...args: unknown[]) => mockSubscriptionFindOneAndUpdate(...args),
  },
}));

import {
  BillingPolicyService,
  DEFAULT_BILLING_UNIT_POLICY,
  PLAN_BILLING_UNIT_POLICIES,
  cloneBillingUnitPolicy,
  hasBillingUnitPolicyOverrideValues,
  mergeBillingUnitPolicy,
} from '../billing-policy-service.js';

function chainable(resolvedValue: unknown) {
  return {
    lean: vi.fn().mockReturnThis(),
    exec: vi.fn().mockResolvedValue(resolvedValue),
  };
}

describe('BillingPolicyService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns plan-aware defaults without sharing object references', () => {
    const service = new BillingPolicyService();
    const all = service.getAllPlanDefaults();

    expect(all.FREE).toEqual(DEFAULT_BILLING_UNIT_POLICY);
    expect(all.TEAM).toEqual(DEFAULT_BILLING_UNIT_POLICY);
    expect(all.BUSINESS).toEqual(DEFAULT_BILLING_UNIT_POLICY);
    expect(all.ENTERPRISE).toEqual(DEFAULT_BILLING_UNIT_POLICY);

    all.FREE.excludedChannels.push('debug-shadow');
    expect(PLAN_BILLING_UNIT_POLICIES.FREE.excludedChannels).toEqual(['web_debug']);
  });

  it('merges nested billing-unit overrides additively', () => {
    const merged = mergeBillingUnitPolicy(cloneBillingUnitPolicy(DEFAULT_BILLING_UNIT_POLICY), {
      excludedChannels: [],
      interactionThreshold: {
        minEngagedSeconds: 45,
      },
      addons: {
        tool: {
          mode: 'bucketed',
          bucketSize: 10,
        },
      },
      materialization: {
        basis: 'completed_sessions',
        completedSessionsCount: 25,
        timeWindowMinutes: null,
      },
    });

    expect(merged.intervalMinutes).toBe(15);
    expect(merged.excludedChannels).toEqual([]);
    expect(merged.interactionThreshold).toEqual({
      minUserMessages: 1,
      minInteractiveTurns: 1,
      minEngagedSeconds: 45,
    });
    expect(merged.addons.tool).toEqual({
      mode: 'bucketed',
      bucketSize: 10,
    });
    expect(merged.materialization).toEqual({
      basis: 'completed_sessions',
      completedSessionsCount: 25,
      timeWindowMinutes: null,
    });
  });

  it('treats explicit empty-array overrides as meaningful updates', () => {
    expect(hasBillingUnitPolicyOverrideValues({ excludedChannels: [] })).toBe(true);
    expect(hasBillingUnitPolicyOverrideValues({})).toBe(false);
    expect(
      hasBillingUnitPolicyOverrideValues({
        interactionThreshold: {
          minUserMessages: undefined,
        },
      }),
    ).toBe(false);
  });

  it('resolves tenant policy from active subscription plan and overrides', async () => {
    const service = new BillingPolicyService();
    mockSubscriptionFindOne.mockReturnValue(
      chainable({
        tenantId: 'tenant-1',
        planTier: 'BUSINESS',
        billingUnitPolicyOverrides: {
          intervalMinutes: 30,
          addons: {
            llm: {
              mode: 'bucketed',
              bucketSize: 50,
            },
          },
        },
      }),
    );

    const resolved = await service.getResolvedPolicy('tenant-1');

    expect(mockSubscriptionFindOne).toHaveBeenCalledWith(
      { tenantId: 'tenant-1', status: 'active' },
      { tenantId: 1, planTier: 1, billingUnitPolicyOverrides: 1 },
    );
    expect(resolved?.planTier).toBe('BUSINESS');
    expect(resolved?.planDefaults.intervalMinutes).toBe(15);
    expect(resolved?.overrides).toEqual({
      intervalMinutes: 30,
      addons: {
        llm: {
          mode: 'bucketed',
          bucketSize: 50,
        },
      },
    });
    expect(resolved?.policy.intervalMinutes).toBe(30);
    expect(resolved?.policy.addons.llm).toEqual({
      mode: 'bucketed',
      bucketSize: 50,
    });
    expect(resolved?.policy.addons.tool).toEqual({
      mode: 'per_call',
      bucketSize: null,
    });
  });

  it('returns null when no active subscription exists', async () => {
    const service = new BillingPolicyService();
    mockSubscriptionFindOne.mockReturnValue(chainable(null));

    await expect(service.getResolvedPolicy('tenant-missing')).resolves.toBeNull();
  });
});
