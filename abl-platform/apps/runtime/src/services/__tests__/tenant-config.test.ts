/**
 * TenantConfigService Tests
 *
 * Validates:
 * - getConfig() returns correct plan defaults for each tier
 * - setOverrides() applies in-memory overrides on top of plan defaults
 * - resolveEffectiveLimits() merges project overrides correctly
 * - resolveEffectiveLimits() returns tenant limits unchanged when no overrides
 * - ENTERPRISE returns unlimited (-1) values
 * - Security config has correct sessionMaxAgeSeconds per plan
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  TenantConfigService,
  PLAN_LIMITS,
  type Plan,
  type TenantLimits,
  type TenantSecurityConfig,
} from '../tenant-config.js';

vi.mock('../../db/index.js', () => ({
  isDatabaseReady: vi.fn(() => true),
}));

// =============================================================================
// FIXTURES
// =============================================================================

const ALL_PLANS: Plan[] = ['FREE', 'TEAM', 'BUSINESS', 'ENTERPRISE'];

function createService(): TenantConfigService {
  return new TenantConfigService();
}

// =============================================================================
// getConfig() — plan defaults
// =============================================================================

describe('TenantConfigService.getConfig()', () => {
  let svc: TenantConfigService;

  beforeEach(() => {
    svc = createService();
  });

  it.each(ALL_PLANS)('returns correct plan defaults for %s', (plan) => {
    const config = svc.getConfig('tenant-1', plan);

    expect(config.tenantId).toBe('tenant-1');
    expect(config.plan).toBe(plan);
    expect(config.limits).toEqual(PLAN_LIMITS[plan]);
    // Features and security are also populated
    expect(config.features).toBeDefined();
    expect(config.security).toBeDefined();
  });

  it('returns independent copies (mutations do not affect defaults)', () => {
    const a = svc.getConfig('t1', 'FREE');
    const b = svc.getConfig('t2', 'FREE');

    a.limits.maxConcurrentSessions = 999;
    expect(b.limits.maxConcurrentSessions).toBe(PLAN_LIMITS.FREE.maxConcurrentSessions);
  });

  it('includes all expected limit fields', () => {
    const config = svc.getConfig('t1', 'FREE');
    const expectedKeys: (keyof TenantLimits)[] = [
      'maxConcurrentSessions',
      'maxServiceTimeoutMs',
      'maxResponseBodyBytes',
      'maxConcurrentServiceCalls',
      'maxPendingTimers',
      'maxAgentsPerProject',
      'maxEventTypesPerApp',
      'maxProjectsPerOrg',
      'requestsPerMinute',
      'tokensPerMinute',
      'toolCallsPerMinute',
      'messagesPerMonth',
      'traceRetentionDays',
      'sessionRetentionDays',
      'auditLogRetentionDays',
      'messageRetentionDays',
    ];
    for (const key of expectedKeys) {
      expect(config.limits).toHaveProperty(key);
      expect(typeof config.limits[key]).toBe('number');
    }
  });
});

// =============================================================================
// setOverrides() — in-memory overrides
// =============================================================================

describe('TenantConfigService.setOverrides()', () => {
  let svc: TenantConfigService;

  beforeEach(() => {
    svc = createService();
  });

  it('applies limit overrides on top of plan defaults', () => {
    svc.setOverrides('t1', {
      limits: { maxConcurrentSessions: 100 } as TenantLimits,
    });

    const config = svc.getConfig('t1', 'FREE');
    expect(config.limits.maxConcurrentSessions).toBe(100);
    // Other limits remain at FREE defaults
    expect(config.limits.requestsPerMinute).toBe(PLAN_LIMITS.FREE.requestsPerMinute);
  });

  it('applies feature overrides on top of plan defaults', () => {
    svc.setOverrides('t1', {
      features: { ssoEnabled: true } as any,
    });

    const config = svc.getConfig('t1', 'FREE');
    expect(config.features.ssoEnabled).toBe(true);
    // Other features remain at FREE defaults
    expect(config.features.customModels).toBe(false);
  });

  it('applies security overrides on top of plan defaults', () => {
    svc.setOverrides('t1', {
      security: { requireMfa: true } as any,
    });

    const config = svc.getConfig('t1', 'FREE');
    expect(config.security.requireMfa).toBe(true);
  });

  it('does not affect other tenants', () => {
    svc.setOverrides('t1', {
      limits: { maxConcurrentSessions: 999 } as TenantLimits,
    });

    const t2Config = svc.getConfig('t2', 'FREE');
    expect(t2Config.limits.maxConcurrentSessions).toBe(PLAN_LIMITS.FREE.maxConcurrentSessions);
  });

  it('clearOverrides removes tenant overrides', () => {
    svc.setOverrides('t1', {
      limits: { maxConcurrentSessions: 999 } as TenantLimits,
    });
    svc.clearOverrides('t1');

    const config = svc.getConfig('t1', 'FREE');
    expect(config.limits.maxConcurrentSessions).toBe(PLAN_LIMITS.FREE.maxConcurrentSessions);
  });
});

// =============================================================================
// resolveEffectiveLimits() — project-level overrides
// =============================================================================

describe('TenantConfigService.resolveEffectiveLimits()', () => {
  let svc: TenantConfigService;

  beforeEach(() => {
    svc = createService();
  });

  it('returns tenant limits unchanged when no project overrides', () => {
    const tenantLimits = { ...PLAN_LIMITS.TEAM };
    const result = svc.resolveEffectiveLimits(tenantLimits);

    expect(result).toBe(tenantLimits); // same reference — no copy needed
  });

  it('returns tenant limits unchanged when project overrides is null', () => {
    const tenantLimits = { ...PLAN_LIMITS.TEAM };
    const result = svc.resolveEffectiveLimits(tenantLimits, null);

    expect(result).toBe(tenantLimits);
  });

  it('returns tenant limits unchanged when project overrides is undefined', () => {
    const tenantLimits = { ...PLAN_LIMITS.TEAM };
    const result = svc.resolveEffectiveLimits(tenantLimits, undefined);

    expect(result).toBe(tenantLimits);
  });

  it('merges project overrides on top of tenant limits', () => {
    const tenantLimits = { ...PLAN_LIMITS.BUSINESS };
    const projectOverrides: Partial<TenantLimits> = {
      maxConcurrentSessions: 100,
      requestsPerMinute: 200,
    };

    const result = svc.resolveEffectiveLimits(tenantLimits, projectOverrides);

    expect(result.maxConcurrentSessions).toBe(100);
    expect(result.requestsPerMinute).toBe(200);
    // Other fields remain from tenant limits
    expect(result.maxServiceTimeoutMs).toBe(PLAN_LIMITS.BUSINESS.maxServiceTimeoutMs);
    expect(result.tokensPerMinute).toBe(PLAN_LIMITS.BUSINESS.tokensPerMinute);
  });

  it('does not mutate the original tenant limits', () => {
    const tenantLimits = { ...PLAN_LIMITS.TEAM };
    const original = { ...tenantLimits };

    svc.resolveEffectiveLimits(tenantLimits, { maxConcurrentSessions: 999 });

    expect(tenantLimits).toEqual(original);
  });

  it('project override can set a field to unlimited (-1)', () => {
    const tenantLimits = { ...PLAN_LIMITS.FREE };
    const result = svc.resolveEffectiveLimits(tenantLimits, {
      maxConcurrentSessions: -1,
    });

    expect(result.maxConcurrentSessions).toBe(-1);
  });
});

// =============================================================================
// ENTERPRISE plan — unlimited values
// =============================================================================

describe('ENTERPRISE plan unlimited values', () => {
  let svc: TenantConfigService;

  beforeEach(() => {
    svc = createService();
  });

  it('returns -1 (unlimited) for session, agent, project, token, tool call, and message limits', () => {
    const config = svc.getConfig('enterprise-tenant', 'ENTERPRISE');

    expect(config.limits.maxConcurrentSessions).toBe(-1);
    expect(config.limits.maxAgentsPerProject).toBe(-1);
    expect(config.limits.maxProjectsPerOrg).toBe(-1);
    expect(config.limits.tokensPerMinute).toBe(-1);
    expect(config.limits.toolCallsPerMinute).toBe(-1);
    expect(config.limits.messagesPerMonth).toBe(-1);
  });

  it('checkLimit returns true for any value when limit is -1', () => {
    expect(svc.checkLimit(999_999, -1)).toBe(true);
    expect(svc.checkLimit(0, -1)).toBe(true);
  });

  it('checkLimit returns false when value exceeds a finite limit', () => {
    expect(svc.checkLimit(6, 5)).toBe(false);
  });

  it('checkLimit returns true when value is at or below limit', () => {
    expect(svc.checkLimit(5, 5)).toBe(true);
    expect(svc.checkLimit(4, 5)).toBe(true);
  });

  it('ENTERPRISE features are all enabled', () => {
    const config = svc.getConfig('ent-tenant', 'ENTERPRISE');

    expect(config.features.customModels).toBe(true);
    expect(config.features.ssoEnabled).toBe(true);
    expect(config.features.mfaEnabled).toBe(true);
    expect(config.features.auditLogExport).toBe(true);
    expect(config.features.dataResidency).toBe(true);
    expect(config.features.customDomains).toBe(true);
    expect(config.features.prioritySupport).toBe(true);
    expect(config.features.advancedAnalytics).toBe(true);
  });
});

// =============================================================================
// Security config — sessionMaxAgeSeconds per plan
// =============================================================================

describe('Security config sessionMaxAgeSeconds', () => {
  let svc: TenantConfigService;

  beforeEach(() => {
    svc = createService();
  });

  it('FREE plan has 1-hour session max age', () => {
    const config = svc.getConfig('t', 'FREE');
    expect(config.security.sessionMaxAgeSeconds).toBe(3_600);
  });

  it('TEAM plan has 8-hour session max age', () => {
    const config = svc.getConfig('t', 'TEAM');
    expect(config.security.sessionMaxAgeSeconds).toBe(28_800);
  });

  it('BUSINESS plan has 8-hour session max age', () => {
    const config = svc.getConfig('t', 'BUSINESS');
    expect(config.security.sessionMaxAgeSeconds).toBe(28_800);
  });

  it('ENTERPRISE plan has 24-hour session max age', () => {
    const config = svc.getConfig('t', 'ENTERPRISE');
    expect(config.security.sessionMaxAgeSeconds).toBe(86_400);
  });

  it('FREE requires no MFA, BUSINESS and ENTERPRISE require MFA', () => {
    expect(svc.getConfig('t', 'FREE').security.requireMfa).toBe(false);
    expect(svc.getConfig('t', 'TEAM').security.requireMfa).toBe(false);
    expect(svc.getConfig('t', 'BUSINESS').security.requireMfa).toBe(true);
    expect(svc.getConfig('t', 'ENTERPRISE').security.requireMfa).toBe(true);
  });
});

// =============================================================================
// getPlanDefaults / getAllPlanDefaults
// =============================================================================

describe('getPlanDefaults / getAllPlanDefaults', () => {
  let svc: TenantConfigService;

  beforeEach(() => {
    svc = createService();
  });

  it('getPlanDefaults returns limits and features for a plan', () => {
    const defaults = svc.getPlanDefaults('TEAM');
    expect(defaults.limits).toEqual(PLAN_LIMITS.TEAM);
    expect(defaults.features).toBeDefined();
  });

  it('getAllPlanDefaults returns all four plans', () => {
    const all = svc.getAllPlanDefaults();
    expect(Object.keys(all)).toEqual(['FREE', 'TEAM', 'BUSINESS', 'ENTERPRISE']);
    expect(all.FREE.limits).toEqual(PLAN_LIMITS.FREE);
    expect(all.ENTERPRISE.limits).toEqual(PLAN_LIMITS.ENTERPRISE);
  });
});

// =============================================================================
// sessionIdleSeconds per plan
// =============================================================================

describe('Security config sessionIdleSeconds', () => {
  let svc: TenantConfigService;

  beforeEach(() => {
    svc = createService();
  });

  it.each([
    ['FREE', 600],
    ['TEAM', 1_800],
    ['BUSINESS', 3_600],
    ['ENTERPRISE', 7_200],
  ] as [Plan, number][])('%s plan returns sessionIdleSeconds=%d', (plan, expected) => {
    const config = svc.getConfig('t', plan);
    expect(config.security.sessionIdleSeconds).toBe(expected);
  });
});

// =============================================================================
// messageRetentionDays per plan
// =============================================================================

describe('Limits messageRetentionDays', () => {
  let svc: TenantConfigService;

  beforeEach(() => {
    svc = createService();
  });

  it.each([
    ['FREE', 30],
    ['TEAM', 90],
    ['BUSINESS', 365],
    ['ENTERPRISE', 730],
  ] as [Plan, number][])('%s plan returns messageRetentionDays=%d', (plan, expected) => {
    const config = svc.getConfig('t', plan);
    expect(config.limits.messageRetentionDays).toBe(expected);
  });
});

// =============================================================================
// scrubPII per plan
// =============================================================================

describe('Security config scrubPII', () => {
  let svc: TenantConfigService;

  beforeEach(() => {
    svc = createService();
  });

  it('BUSINESS plan returns scrubPII=true regardless of env', () => {
    const config = svc.getConfig('t', 'BUSINESS');
    expect(config.security.scrubPII).toBe(true);
  });

  it('ENTERPRISE plan returns scrubPII=true regardless of env', () => {
    const config = svc.getConfig('t', 'ENTERPRISE');
    expect(config.security.scrubPII).toBe(true);
  });

  // FREE/TEAM scrubPII depends on ENABLE_STRICT_PII_MODE env var,
  // which is evaluated at module load time. In test env it's typically unset.
  it('FREE plan returns scrubPII=false when env not set', () => {
    const config = svc.getConfig('t', 'FREE');
    // In test environment, ENABLE_STRICT_PII_MODE is not set
    expect(config.security.scrubPII).toBe(false);
  });
});

// =============================================================================
// resolveProjectMessageRetention() — project-level messageRetentionDays
// =============================================================================

// Mock @agent-platform/database/models for Project lookups
vi.mock('@agent-platform/database/models', () => ({
  Project: {
    findOne: vi.fn().mockReturnThis(),
    lean: vi.fn().mockReturnThis(),
    exec: vi.fn().mockResolvedValue(null),
  },
  Subscription: {
    findOne: vi.fn().mockReturnThis(),
    lean: vi.fn().mockReturnThis(),
    exec: vi.fn().mockResolvedValue(null),
  },
  Tenant: {
    findOne: vi.fn().mockReturnThis(),
    lean: vi.fn().mockReturnThis(),
    exec: vi.fn().mockResolvedValue(null),
  },
}));

// Mock Redis client to avoid real connections
vi.mock('../redis/redis-client.js', () => ({
  getRedisClient: vi.fn().mockReturnValue(null),
  getRedisHandle: () => null,
}));

describe('TenantConfigService.resolveProjectMessageRetention()', () => {
  let svc: TenantConfigService;

  beforeEach(async () => {
    svc = new TenantConfigService();
    vi.clearAllMocks();

    // Re-import to get the mocked module references
    const dbModels = await import('@agent-platform/database/models');

    // Default: Subscription returns BUSINESS plan, Project returns null
    const mockSubscription = {
      findOne: vi.fn().mockReturnValue({
        lean: vi.fn().mockReturnValue({
          exec: vi.fn().mockResolvedValue({
            planTier: 'BUSINESS',
            tenantQuotas: [],
          }),
        }),
      }),
    };
    const mockTenant = {
      findOne: vi.fn().mockReturnValue({
        lean: vi.fn().mockReturnValue({
          exec: vi.fn().mockResolvedValue(null),
        }),
      }),
    };
    const mockProject = {
      findOne: vi.fn().mockReturnValue({
        lean: vi.fn().mockReturnValue({
          exec: vi.fn().mockResolvedValue(null),
        }),
      }),
    };

    Object.assign(dbModels, {
      Subscription: mockSubscription,
      Tenant: mockTenant,
      Project: mockProject,
    });
  });

  it('project override of 7 days on BUSINESS plan uses 7', async () => {
    const dbModels = await import('@agent-platform/database/models');

    // Project has messageRetentionDays = 7
    (dbModels as any).Project.findOne = vi.fn().mockReturnValue({
      lean: vi.fn().mockReturnValue({
        exec: vi.fn().mockResolvedValue({ messageRetentionDays: 7 }),
      }),
    });

    const result = await svc.resolveProjectMessageRetention('tenant-biz', 'project-1');

    // BUSINESS plan max is 365, project wants 7 → Math.min(7, 365) = 7
    expect(result).toBe(7);
  });

  it('project override of 999 days is capped to BUSINESS plan max (365)', async () => {
    const dbModels = await import('@agent-platform/database/models');

    // Project has messageRetentionDays = 999
    (dbModels as any).Project.findOne = vi.fn().mockReturnValue({
      lean: vi.fn().mockReturnValue({
        exec: vi.fn().mockResolvedValue({ messageRetentionDays: 999 }),
      }),
    });

    const result = await svc.resolveProjectMessageRetention('tenant-biz', 'project-2');

    // BUSINESS plan max is 365, project wants 999 → Math.min(999, 365) = 365
    expect(result).toBe(365);
  });

  it('missing project override falls through (returns null)', async () => {
    const dbModels = await import('@agent-platform/database/models');

    // Project has no messageRetentionDays (null)
    (dbModels as any).Project.findOne = vi.fn().mockReturnValue({
      lean: vi.fn().mockReturnValue({
        exec: vi.fn().mockResolvedValue({ messageRetentionDays: null }),
      }),
    });

    const result = await svc.resolveProjectMessageRetention('tenant-biz', 'project-3');

    // No override → null, caller should use plan default
    expect(result).toBeNull();
  });
});
