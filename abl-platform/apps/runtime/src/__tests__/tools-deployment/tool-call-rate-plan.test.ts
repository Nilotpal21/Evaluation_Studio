/**
 * Tool Call Rate Limit — Plan-Based Tests
 *
 * Verifies that toolCallsPerMinute varies by tenant plan tier:
 *   FREE: 50, TEAM: 200, BUSINESS: 500, ENTERPRISE: -1 (unlimited)
 *
 * Tests cover:
 * - getTenantRateLimits returns correct toolCallsPerMinute per plan
 * - Plan differentiation: different plans get different limits
 * - ENTERPRISE unlimited (-1) is propagated correctly
 * - PLAN_LIMITS source-of-truth has correct values per tier
 * - Fallback to DEFAULT_LIMITS on config failure still works
 *
 * Unit-level tests — no Redis or MongoDB required.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks — must be declared before importing the module under test
// ---------------------------------------------------------------------------

const mockGetConfigAsync = vi.fn();
const mockGetProjectConfig = vi.fn();
const mockFindLLMPolicyOrDefaults = vi.fn();

vi.mock('../../services/tenant-config.js', async () => {
  const actual = await vi.importActual<typeof import('../../services/tenant-config.js')>(
    '../../services/tenant-config.js',
  );
  return {
    ...actual,
    getTenantConfigService: () => ({
      getConfigAsync: mockGetConfigAsync,
      getProjectConfig: mockGetProjectConfig,
    }),
  };
});

// Mock HybridRateLimiter — avoid Redis/memory limiter initialisation
vi.mock('../../services/resilience/hybrid-rate-limiter.js', () => ({
  getHybridRateLimiter: () => ({
    check: vi.fn().mockResolvedValue({ allowed: true, remaining: 100, resetMs: 60000 }),
    peek: vi.fn().mockReturnValue(0),
  }),
}));

// Mock Redis client — force in-memory fallback
vi.mock('../../services/redis/redis-client.js', () => ({
  getRedisClient: () => null,
  getRedisHandle: () => null,
}));

// Mock tenant LLM policy repo — these tests validate plan config behavior only.
vi.mock('../../repos/tenant-llm-policy-repo.js', () => ({
  findLLMPolicyOrDefaults: mockFindLLMPolicyOrDefaults,
}));

// Import after mocks
import { getTenantRateLimits } from '../../middleware/rate-limiter.js';
import { PLAN_LIMITS, type TenantConfig } from '../../services/tenant-config.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildTenantConfig(
  tenantId: string,
  plan: 'FREE' | 'TEAM' | 'BUSINESS' | 'ENTERPRISE',
): TenantConfig {
  return {
    tenantId,
    plan,
    limits: { ...PLAN_LIMITS[plan] },
    features: {} as TenantConfig['features'],
    security: {} as TenantConfig['security'],
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Tool call rate limit — plan-based (Gap 11)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFindLLMPolicyOrDefaults.mockResolvedValue({ maxRequestsPerMinute: 0 });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // -------------------------------------------------------------------------
  // PLAN_LIMITS source-of-truth values
  // -------------------------------------------------------------------------

  describe('PLAN_LIMITS contains correct toolCallsPerMinute per tier', () => {
    it('FREE plan: 50 tool calls per minute', () => {
      expect(PLAN_LIMITS.FREE.toolCallsPerMinute).toBe(50);
    });

    it('TEAM plan: 200 tool calls per minute', () => {
      expect(PLAN_LIMITS.TEAM.toolCallsPerMinute).toBe(200);
    });

    it('BUSINESS plan: 500 tool calls per minute', () => {
      expect(PLAN_LIMITS.BUSINESS.toolCallsPerMinute).toBe(500);
    });

    it('ENTERPRISE plan: -1 (unlimited) tool calls per minute', () => {
      expect(PLAN_LIMITS.ENTERPRISE.toolCallsPerMinute).toBe(-1);
    });
  });

  // -------------------------------------------------------------------------
  // getTenantRateLimits — plan-based toolCallsPerMinute
  // -------------------------------------------------------------------------

  describe('getTenantRateLimits reads toolCallsPerMinute from plan config', () => {
    it('FREE tenant gets toolCallsPerMinute=50', async () => {
      mockGetConfigAsync.mockResolvedValue(buildTenantConfig('t-free', 'FREE'));

      const result = await getTenantRateLimits('t-free');
      expect(result.toolCallsPerMinute).toBe(50);
    });

    it('TEAM tenant gets toolCallsPerMinute=200', async () => {
      mockGetConfigAsync.mockResolvedValue(buildTenantConfig('t-team', 'TEAM'));

      const result = await getTenantRateLimits('t-team');
      expect(result.toolCallsPerMinute).toBe(200);
    });

    it('BUSINESS tenant gets toolCallsPerMinute=500', async () => {
      mockGetConfigAsync.mockResolvedValue(buildTenantConfig('t-biz', 'BUSINESS'));

      const result = await getTenantRateLimits('t-biz');
      expect(result.toolCallsPerMinute).toBe(500);
    });

    it('ENTERPRISE tenant gets toolCallsPerMinute=-1 (unlimited)', async () => {
      mockGetConfigAsync.mockResolvedValue(buildTenantConfig('t-ent', 'ENTERPRISE'));

      const result = await getTenantRateLimits('t-ent');
      expect(result.toolCallsPerMinute).toBe(-1);
    });
  });

  // -------------------------------------------------------------------------
  // Plan differentiation — proves limits vary, not hardcoded
  // -------------------------------------------------------------------------

  describe('plan differentiation', () => {
    it('FREE and ENTERPRISE have different toolCallsPerMinute', async () => {
      mockGetConfigAsync.mockResolvedValueOnce(buildTenantConfig('t-free', 'FREE'));
      const freeResult = await getTenantRateLimits('t-free');

      mockGetConfigAsync.mockResolvedValueOnce(buildTenantConfig('t-ent', 'ENTERPRISE'));
      const entResult = await getTenantRateLimits('t-ent');

      expect(freeResult.toolCallsPerMinute).not.toBe(entResult.toolCallsPerMinute);
      expect(freeResult.toolCallsPerMinute).toBe(50);
      expect(entResult.toolCallsPerMinute).toBe(-1);
    });

    it('all four plans produce distinct toolCallsPerMinute values', async () => {
      const plans = ['FREE', 'TEAM', 'BUSINESS', 'ENTERPRISE'] as const;
      const values: number[] = [];

      for (const plan of plans) {
        mockGetConfigAsync.mockResolvedValueOnce(buildTenantConfig(`t-${plan}`, plan));
        const result = await getTenantRateLimits(`t-${plan}`);
        values.push(result.toolCallsPerMinute);
      }

      // All four values should be unique
      expect(new Set(values).size).toBe(4);
      expect(values).toEqual([50, 200, 500, -1]);
    });

    it('toolCallsPerMinute increases with plan tier (excluding unlimited)', async () => {
      const finitePlans = ['FREE', 'TEAM', 'BUSINESS'] as const;
      const values: number[] = [];

      for (const plan of finitePlans) {
        mockGetConfigAsync.mockResolvedValueOnce(buildTenantConfig(`t-${plan}`, plan));
        const result = await getTenantRateLimits(`t-${plan}`);
        values.push(result.toolCallsPerMinute);
      }

      // Each tier has a higher limit than the one below
      expect(values[0]).toBeLessThan(values[1]);
      expect(values[1]).toBeLessThan(values[2]);
    });
  });

  // -------------------------------------------------------------------------
  // Fallback on config failure
  // -------------------------------------------------------------------------

  describe('fallback on config failure', () => {
    it('falls back to DEFAULT_LIMITS.toolCallsPerMinute (200) when config load fails', async () => {
      mockGetConfigAsync.mockRejectedValue(new Error('DB unavailable'));

      const result = await getTenantRateLimits('t-broken');

      // DEFAULT_LIMITS.toolCallsPerMinute is 200 (the platform safety net)
      expect(result.toolCallsPerMinute).toBe(200);
    });
  });

  // -------------------------------------------------------------------------
  // Project-level overrides are respected
  // -------------------------------------------------------------------------

  describe('project-level overrides', () => {
    it('uses project config when projectId is provided', async () => {
      // Project config overrides toolCallsPerMinute to a custom value
      const projectConfig = buildTenantConfig('t-biz', 'BUSINESS');
      projectConfig.limits.toolCallsPerMinute = 300; // custom project override
      mockGetProjectConfig.mockResolvedValue(projectConfig);

      const result = await getTenantRateLimits('t-biz', 'proj-1');

      expect(mockGetProjectConfig).toHaveBeenCalledWith('t-biz', 'proj-1');
      expect(result.toolCallsPerMinute).toBe(300);
    });
  });
});
