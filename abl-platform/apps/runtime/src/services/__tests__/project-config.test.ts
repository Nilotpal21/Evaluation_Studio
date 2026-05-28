/**
 * Project-Level Config Override Tests
 *
 * Validates:
 * - getProjectConfig() returns tenant config when no project overrides exist
 * - getProjectConfig() merges project-specific limit overrides
 * - getProjectConfig() validates numeric types from DB (ignores non-numeric)
 * - getProjectConfig() handles DB failure gracefully (falls back to tenant config)
 * - loadProjectOverrides() finds correct project quota within tenant quotas
 * - loadProjectOverrides() returns null for unknown project
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { TenantConfigService, PLAN_LIMITS, type TenantConfig } from '../tenant-config.js';

// =============================================================================
// MOCKS
// =============================================================================

// Mock Redis — return null (cache miss) so getConfigAsync falls through to loadFromDB
vi.mock('../redis/redis-client.js', () => ({
  getRedisClient: vi.fn(() => null),
  getRedisHandle: () => null,
}));

vi.mock('../../db/index.js', () => ({
  isDatabaseReady: vi.fn(() => true),
}));

// Mock Subscription model — controlled per-test via mockSubscriptionFindOne
const mockSubscriptionFindOne = vi.fn();

// Mock Tenant model — return null (no tenant overrides) by default
const mockTenantFindOne = vi.fn();

vi.mock('@agent-platform/database/models', () => ({
  Subscription: {
    findOne: (...args: unknown[]) => {
      const result = mockSubscriptionFindOne(...args);
      return {
        lean: () => ({
          exec: () => Promise.resolve(result),
        }),
      };
    },
  },
  Tenant: {
    findOne: (...args: unknown[]) => {
      const result = mockTenantFindOne(...args);
      return {
        lean: () => ({
          exec: () => Promise.resolve(result),
        }),
      };
    },
  },
}));

// =============================================================================
// FIXTURES
// =============================================================================

const TENANT_ID = 'tenant-t1';
const PROJECT_ID = 'project-p1';
const OTHER_PROJECT_ID = 'project-p2';

/** Subscription with project-level quota overrides */
function makeSubscriptionWithProjectQuotas(
  projectOverrides: Record<string, unknown>,
  projectId = PROJECT_ID,
) {
  return {
    _id: 'sub-1',
    tenantId: TENANT_ID,
    planTier: 'TEAM',
    status: 'active',
    tenantQuotas: [
      {
        tenantId: TENANT_ID,
        allocatedLimits: null, // No tenant-level quota override
        projectQuotas: [
          {
            projectId,
            allocatedLimits: projectOverrides,
            overageBehavior: 'throttle',
            createdAt: new Date(),
            updatedAt: new Date(),
          },
        ],
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ],
  };
}

/** Subscription with NO project quotas */
function makeSubscriptionNoProjectQuotas() {
  return {
    _id: 'sub-1',
    tenantId: TENANT_ID,
    planTier: 'TEAM',
    status: 'active',
    tenantQuotas: [
      {
        tenantId: TENANT_ID,
        allocatedLimits: null,
        projectQuotas: [],
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ],
  };
}

// =============================================================================
// TESTS
// =============================================================================

describe('TenantConfigService.getProjectConfig()', () => {
  let svc: TenantConfigService;

  beforeEach(() => {
    svc = new TenantConfigService();
    mockSubscriptionFindOne.mockReset();
    mockTenantFindOne.mockReset();
    // Default: return TEAM plan subscription with no project overrides
    mockSubscriptionFindOne.mockReturnValue(makeSubscriptionNoProjectQuotas());
    mockTenantFindOne.mockReturnValue(null);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns tenant config when no project overrides exist', async () => {
    const config = await svc.getProjectConfig(TENANT_ID, PROJECT_ID);

    expect(config.tenantId).toBe(TENANT_ID);
    expect(config.plan).toBe('TEAM');
    // Limits should match TEAM plan defaults (no project overrides)
    expect(config.limits.requestsPerMinute).toBe(PLAN_LIMITS.TEAM.requestsPerMinute);
    expect(config.limits.maxConcurrentSessions).toBe(PLAN_LIMITS.TEAM.maxConcurrentSessions);
    expect(config.limits.tokensPerMinute).toBe(PLAN_LIMITS.TEAM.tokensPerMinute);
  });

  it('merges project-specific limit overrides on top of tenant config', async () => {
    mockSubscriptionFindOne.mockReturnValue(
      makeSubscriptionWithProjectQuotas({
        requestsPerMinute: 500,
        maxConcurrentSessions: 10,
      }),
    );

    const config = await svc.getProjectConfig(TENANT_ID, PROJECT_ID);

    // Overridden values
    expect(config.limits.requestsPerMinute).toBe(500);
    expect(config.limits.maxConcurrentSessions).toBe(10);
    // Non-overridden values stay at TEAM defaults
    expect(config.limits.tokensPerMinute).toBe(PLAN_LIMITS.TEAM.tokensPerMinute);
    expect(config.limits.maxAgentsPerProject).toBe(PLAN_LIMITS.TEAM.maxAgentsPerProject);
  });

  it('validates numeric types from DB — ignores non-numeric values', async () => {
    mockSubscriptionFindOne.mockReturnValue(
      makeSubscriptionWithProjectQuotas({
        requestsPerMinute: 999, // valid
        tokensPerMinute: 'not-a-number', // invalid string
        maxConcurrentSessions: null, // invalid null
        maxAgentsPerProject: true, // invalid boolean
        maxProjectsPerOrg: NaN, // invalid NaN
        maxServiceTimeoutMs: Infinity, // invalid Infinity
        sessionRetentionDays: 60, // valid
      }),
    );

    const config = await svc.getProjectConfig(TENANT_ID, PROJECT_ID);

    // Only valid numeric values applied
    expect(config.limits.requestsPerMinute).toBe(999);
    expect(config.limits.sessionRetentionDays).toBe(60);
    // Invalid values left at TEAM defaults
    expect(config.limits.tokensPerMinute).toBe(PLAN_LIMITS.TEAM.tokensPerMinute);
    expect(config.limits.maxConcurrentSessions).toBe(PLAN_LIMITS.TEAM.maxConcurrentSessions);
    expect(config.limits.maxAgentsPerProject).toBe(PLAN_LIMITS.TEAM.maxAgentsPerProject);
    expect(config.limits.maxProjectsPerOrg).toBe(PLAN_LIMITS.TEAM.maxProjectsPerOrg);
    expect(config.limits.maxServiceTimeoutMs).toBe(PLAN_LIMITS.TEAM.maxServiceTimeoutMs);
  });

  it('ignores keys not present in PLAN_LIMITS.FREE reference', async () => {
    mockSubscriptionFindOne.mockReturnValue(
      makeSubscriptionWithProjectQuotas({
        requestsPerMinute: 999, // valid key
        bogusField: 42, // not a valid limit key
        anotherFake: 100, // not a valid limit key
      }),
    );

    const config = await svc.getProjectConfig(TENANT_ID, PROJECT_ID);

    expect(config.limits.requestsPerMinute).toBe(999);
    // Bogus keys should not appear on config.limits
    expect((config.limits as unknown as Record<string, unknown>)['bogusField']).toBeUndefined();
    expect((config.limits as unknown as Record<string, unknown>)['anotherFake']).toBeUndefined();
  });

  it('handles DB failure gracefully — falls back to tenant config', async () => {
    // First call for getConfigAsync (loadFromDB) will throw
    mockSubscriptionFindOne.mockImplementation(() => {
      throw new Error('MongoDB connection lost');
    });

    // Should not throw — falls back to TEAM defaults (fail-open in loadFromDB)
    const config = await svc.getProjectConfig(TENANT_ID, PROJECT_ID);

    expect(config.tenantId).toBe(TENANT_ID);
    expect(config.plan).toBe('TEAM');
    expect(config.limits).toEqual(PLAN_LIMITS.TEAM);
  });

  it('returns null overrides for unknown project ID', async () => {
    mockSubscriptionFindOne.mockReturnValue(
      makeSubscriptionWithProjectQuotas({ requestsPerMinute: 999 }, 'some-other-project'),
    );

    const config = await svc.getProjectConfig(TENANT_ID, PROJECT_ID);

    // No matching project quota → tenant defaults apply
    expect(config.limits.requestsPerMinute).toBe(PLAN_LIMITS.TEAM.requestsPerMinute);
  });

  it('finds the correct project quota within multiple tenant quotas', async () => {
    mockSubscriptionFindOne.mockReturnValue({
      _id: 'sub-1',
      tenantId: TENANT_ID,
      planTier: 'BUSINESS',
      status: 'active',
      tenantQuotas: [
        {
          tenantId: 'other-tenant',
          allocatedLimits: null,
          projectQuotas: [
            {
              projectId: PROJECT_ID,
              allocatedLimits: { requestsPerMinute: 111 },
            },
          ],
        },
        {
          tenantId: TENANT_ID,
          allocatedLimits: null,
          projectQuotas: [
            {
              projectId: OTHER_PROJECT_ID,
              allocatedLimits: { requestsPerMinute: 222 },
            },
            {
              projectId: PROJECT_ID,
              allocatedLimits: { requestsPerMinute: 333, maxConcurrentSessions: 25 },
            },
          ],
        },
      ],
    });

    const config = await svc.getProjectConfig(TENANT_ID, PROJECT_ID);

    // Should pick the quota from TENANT_ID's entry, for PROJECT_ID
    expect(config.limits.requestsPerMinute).toBe(333);
    expect(config.limits.maxConcurrentSessions).toBe(25);
    // Other BUSINESS defaults remain
    expect(config.limits.tokensPerMinute).toBe(PLAN_LIMITS.BUSINESS.tokensPerMinute);
  });

  it('handles subscription with no tenantQuotas array', async () => {
    mockSubscriptionFindOne.mockReturnValue({
      _id: 'sub-1',
      tenantId: TENANT_ID,
      planTier: 'TEAM',
      status: 'active',
      tenantQuotas: null,
    });

    const config = await svc.getProjectConfig(TENANT_ID, PROJECT_ID);

    // Falls back to TEAM defaults
    expect(config.plan).toBe('TEAM');
    expect(config.limits.requestsPerMinute).toBe(PLAN_LIMITS.TEAM.requestsPerMinute);
  });

  it('handles allocatedLimits being a non-object value', async () => {
    mockSubscriptionFindOne.mockReturnValue({
      _id: 'sub-1',
      tenantId: TENANT_ID,
      planTier: 'TEAM',
      status: 'active',
      tenantQuotas: [
        {
          tenantId: TENANT_ID,
          allocatedLimits: null,
          projectQuotas: [
            {
              projectId: PROJECT_ID,
              allocatedLimits: 'invalid-string', // non-object
            },
          ],
        },
      ],
    });

    const config = await svc.getProjectConfig(TENANT_ID, PROJECT_ID);

    // Non-object allocatedLimits → no overrides applied
    expect(config.limits.requestsPerMinute).toBe(PLAN_LIMITS.TEAM.requestsPerMinute);
  });

  it('project override can set unlimited (-1)', async () => {
    mockSubscriptionFindOne.mockReturnValue(
      makeSubscriptionWithProjectQuotas({
        maxConcurrentSessions: -1,
        tokensPerMinute: -1,
      }),
    );

    const config = await svc.getProjectConfig(TENANT_ID, PROJECT_ID);

    expect(config.limits.maxConcurrentSessions).toBe(-1);
    expect(config.limits.tokensPerMinute).toBe(-1);
  });
});
