/**
 * Plan-Aware Rate Limiter Tests
 *
 * Verifies that the rate limiter reads tenant plan limits from
 * TenantConfigService and correctly handles:
 * - Mapping TenantConfig.limits to TenantRateLimitConfig
 * - FREE plan getting lower limits (60 req/min, 50K tokens/min)
 * - ENTERPRISE plan unlimited (-1) handling
 * - recordTokenUsage with unlimited tokens
 * - canStartSession with unlimited sessions
 * - Fallback to DEFAULT_LIMITS on config load failure
 *
 * Unit-level tests — no Redis or MongoDB required.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks — must be declared before importing the module under test
// ---------------------------------------------------------------------------

// Mock TenantConfigService.getConfigAsync
const mockGetConfigAsync = vi.fn();
const mockFindLLMPolicyOrDefaults = vi.fn();

vi.mock('../services/tenant-config.js', () => ({
  getTenantConfigService: () => ({
    getConfigAsync: mockGetConfigAsync,
  }),
}));

// Mock HybridRateLimiter — avoid Redis/memory limiter initialisation
const mockCheck = vi.fn();
const mockPeek = vi.fn();

vi.mock('../services/resilience/hybrid-rate-limiter.js', () => ({
  getHybridRateLimiter: () => ({
    check: mockCheck,
    peek: mockPeek,
  }),
}));

// Mock Redis client — force in-memory fallback for session counting
vi.mock('../services/redis/redis-client.js', () => ({
  getRedisClient: () => null,
  getRedisHandle: () => null,
}));

// Mock tenant LLM policy repo — these tests focus on plan-derived limits.
vi.mock('../repos/tenant-llm-policy-repo.js', () => ({
  findLLMPolicyOrDefaults: mockFindLLMPolicyOrDefaults,
}));

// Import after mocks are in place
import {
  getTenantRateLimits,
  recordTokenUsage,
  canStartSession,
  claimSessionSlot,
  getSessionCount,
  type TenantRateLimitConfig,
} from '../middleware/rate-limiter.js';
import type { TenantConfig } from '../services/tenant-config.js';

// ---------------------------------------------------------------------------
// Helpers — build a TenantConfig fixture for a given plan
// ---------------------------------------------------------------------------

function buildTenantConfig(
  tenantId: string,
  plan: 'FREE' | 'TEAM' | 'BUSINESS' | 'ENTERPRISE',
  overrides?: Partial<TenantConfig['limits']>,
): TenantConfig {
  const planLimits: Record<string, TenantConfig['limits']> = {
    FREE: {
      maxConcurrentSessions: 10,
      maxServiceTimeoutMs: 10_000,
      maxResponseBodyBytes: 524_288,
      maxConcurrentServiceCalls: 3,
      maxPendingTimers: 100,
      maxAgentsPerProject: 3,
      maxEventTypesPerApp: 10,
      maxProjectsPerOrg: 3,
      requestsPerMinute: 60,
      tokensPerMinute: 50_000,
      toolCallsPerMinute: 50,
      messagesPerMonth: 1_000,
      traceRetentionDays: 7,
      sessionRetentionDays: 7,
      auditLogRetentionDays: 30,
    },
    TEAM: {
      maxConcurrentSessions: 50,
      maxServiceTimeoutMs: 30_000,
      maxResponseBodyBytes: 2_097_152,
      maxConcurrentServiceCalls: 10,
      maxPendingTimers: 1_000,
      maxAgentsPerProject: 20,
      maxEventTypesPerApp: 50,
      maxProjectsPerOrg: 20,
      requestsPerMinute: 300,
      tokensPerMinute: 200_000,
      toolCallsPerMinute: 200,
      messagesPerMonth: 50_000,
      traceRetentionDays: 30,
      sessionRetentionDays: 30,
      auditLogRetentionDays: 90,
    },
    BUSINESS: {
      maxConcurrentSessions: 500,
      maxServiceTimeoutMs: 45_000,
      maxResponseBodyBytes: 5_242_880,
      maxConcurrentServiceCalls: 25,
      maxPendingTimers: 10_000,
      maxAgentsPerProject: 100,
      maxEventTypesPerApp: 100,
      maxProjectsPerOrg: 100,
      requestsPerMinute: 1_000,
      tokensPerMinute: 500_000,
      toolCallsPerMinute: 500,
      messagesPerMonth: 500_000,
      traceRetentionDays: 90,
      sessionRetentionDays: 90,
      auditLogRetentionDays: 365,
    },
    ENTERPRISE: {
      maxConcurrentSessions: -1,
      maxServiceTimeoutMs: 60_000,
      maxResponseBodyBytes: 10_485_760,
      maxConcurrentServiceCalls: 50,
      maxPendingTimers: 100_000,
      maxAgentsPerProject: -1,
      maxEventTypesPerApp: 200,
      maxProjectsPerOrg: -1,
      requestsPerMinute: -1,
      tokensPerMinute: -1,
      toolCallsPerMinute: -1,
      messagesPerMonth: -1,
      traceRetentionDays: 365,
      sessionRetentionDays: 365,
      auditLogRetentionDays: 2_555,
    },
  };

  return {
    tenantId,
    plan,
    limits: { ...planLimits[plan], ...overrides },
    features: {} as TenantConfig['features'],
    security: {} as TenantConfig['security'],
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Plan-aware rate limiting', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFindLLMPolicyOrDefaults.mockResolvedValue({ maxRequestsPerMinute: 0 });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  // -------------------------------------------------------------------------
  // getTenantRateLimits — mapping
  // -------------------------------------------------------------------------

  describe('getTenantRateLimits', () => {
    it('maps FREE plan limits to rate limiter config', async () => {
      const config = buildTenantConfig('tenant-free', 'FREE');
      mockGetConfigAsync.mockResolvedValue(config);

      const result = await getTenantRateLimits('tenant-free');

      expect(result).toEqual<TenantRateLimitConfig>({
        requestsPerMinute: 60,
        tokensPerMinute: 50_000,
        concurrentSessions: 10,
        toolCallsPerMinute: 50,
      });
    });

    it('maps TEAM plan limits to rate limiter config', async () => {
      const config = buildTenantConfig('tenant-team', 'TEAM');
      mockGetConfigAsync.mockResolvedValue(config);

      const result = await getTenantRateLimits('tenant-team');

      expect(result).toEqual<TenantRateLimitConfig>({
        requestsPerMinute: 300,
        tokensPerMinute: 200_000,
        concurrentSessions: 50,
        toolCallsPerMinute: 200,
      });
    });

    it('maps BUSINESS plan limits to rate limiter config', async () => {
      const config = buildTenantConfig('tenant-biz', 'BUSINESS');
      mockGetConfigAsync.mockResolvedValue(config);

      const result = await getTenantRateLimits('tenant-biz');

      expect(result).toEqual<TenantRateLimitConfig>({
        requestsPerMinute: 1_000,
        tokensPerMinute: 500_000,
        concurrentSessions: 500,
        toolCallsPerMinute: 500,
      });
    });

    it('maps ENTERPRISE plan limits with unlimited (-1) values', async () => {
      const config = buildTenantConfig('tenant-ent', 'ENTERPRISE');
      mockGetConfigAsync.mockResolvedValue(config);

      const result = await getTenantRateLimits('tenant-ent');

      expect(result).toEqual<TenantRateLimitConfig>({
        requestsPerMinute: -1,
        tokensPerMinute: -1,
        concurrentSessions: -1,
        toolCallsPerMinute: -1,
      });
    });

    it('falls back to DEFAULT_LIMITS when config load fails', async () => {
      mockGetConfigAsync.mockRejectedValue(new Error('Redis unavailable'));

      const result = await getTenantRateLimits('tenant-broken');

      expect(result).toEqual<TenantRateLimitConfig>({
        requestsPerMinute: 100,
        tokensPerMinute: 100_000,
        concurrentSessions: 50,
        toolCallsPerMinute: 200,
      });
    });

    it('reads toolCallsPerMinute from plan config, not a hardcoded default', async () => {
      // ENTERPRISE gets unlimited (-1), FREE gets 50 — proves it's plan-driven
      const entConfig = buildTenantConfig('tenant-ent', 'ENTERPRISE');
      mockGetConfigAsync.mockResolvedValue(entConfig);
      const entResult = await getTenantRateLimits('tenant-ent');
      expect(entResult.toolCallsPerMinute).toBe(-1);

      const freeConfig = buildTenantConfig('tenant-free', 'FREE');
      mockGetConfigAsync.mockResolvedValue(freeConfig);
      const freeResult = await getTenantRateLimits('tenant-free');
      expect(freeResult.toolCallsPerMinute).toBe(50);
    });
  });

  // -------------------------------------------------------------------------
  // recordTokenUsage — unlimited handling
  // -------------------------------------------------------------------------

  describe('recordTokenUsage', () => {
    it('returns allowed=true with Infinity remaining for unlimited (-1) tokens', async () => {
      const config = buildTenantConfig('tenant-ent', 'ENTERPRISE');
      mockGetConfigAsync.mockResolvedValue(config);

      const result = await recordTokenUsage('tenant-ent', 50_000);

      expect(result.allowed).toBe(true);
      expect(result.remaining).toBe(Infinity);
      // Should NOT have called the rate limiter
      expect(mockCheck).not.toHaveBeenCalled();
    });

    it('delegates to rate limiter with plan-based token limit for FREE plan', async () => {
      const config = buildTenantConfig('tenant-free', 'FREE');
      mockGetConfigAsync.mockResolvedValue(config);
      mockCheck.mockResolvedValue({ allowed: true, remaining: 45_000, resetMs: 50_000 });

      const result = await recordTokenUsage('tenant-free', 5_000);

      expect(result.allowed).toBe(true);
      expect(result.remaining).toBe(45_000);
      expect(mockCheck).toHaveBeenCalledWith(
        'tenant:tenant-free',
        'llm_tokens',
        50_000, // FREE plan: 50K tokens/min
        60000,
        5_000,
      );
    });

    it('returns blocked when token limit exceeded', async () => {
      const config = buildTenantConfig('tenant-free', 'FREE');
      mockGetConfigAsync.mockResolvedValue(config);
      mockCheck.mockResolvedValue({ allowed: false, remaining: 0, resetMs: 30_000 });

      const result = await recordTokenUsage('tenant-free', 60_000);

      expect(result.allowed).toBe(false);
      expect(result.remaining).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  // canStartSession — unlimited handling
  // -------------------------------------------------------------------------

  describe('claimSessionSlot', () => {
    it('reuses an existing session slot when the same session reconnects', async () => {
      const tid = `tenant-free-reclaim-${Date.now()}`;

      const firstClaim = await claimSessionSlot(tid, 'sdk-session-1', 1);
      const secondClaim = await claimSessionSlot(tid, 'sdk-session-1', 1);

      expect(firstClaim).toBe(1);
      expect(secondClaim).toBe(1);
    });

    it('expires stale in-memory fallback slots after the safety TTL', async () => {
      const startTime = new Date('2026-01-01T00:00:00.000Z');
      const fallbackTtlMs = 172_800_000;
      vi.useFakeTimers();
      vi.setSystemTime(startTime);

      const tid = `tenant-free-expiry-${startTime.getTime()}`;
      expect(await claimSessionSlot(tid, 'sdk-session-1', 1)).toBe(1);
      expect(await getSessionCount(tid)).toBe(1);

      vi.setSystemTime(new Date(startTime.getTime() + fallbackTtlMs + 1));

      expect(await getSessionCount(tid)).toBe(0);
      expect(await claimSessionSlot(tid, 'sdk-session-2', 1)).toBe(1);
    });
  });

  describe('canStartSession', () => {
    it('returns true for unlimited (-1) concurrent sessions', async () => {
      const config = buildTenantConfig('tenant-ent', 'ENTERPRISE');
      mockGetConfigAsync.mockResolvedValue(config);

      const result = await canStartSession('tenant-ent');

      expect(result).toBe(true);
    });

    it('returns true when under plan session limit', async () => {
      // Use unique tenant ID — in-memory session counts persist across tests
      const tid = `tenant-free-under-${Date.now()}`;
      const config = buildTenantConfig(tid, 'FREE');
      mockGetConfigAsync.mockResolvedValue(config);

      // Add 3 sessions via in-memory SET (FREE limit is 10)
      for (let i = 0; i < 3; i++) {
        await claimSessionSlot(tid, `test-session-${i}`);
      }

      const result = await canStartSession(tid);

      expect(result).toBe(true);
    });

    it('returns false when at plan session limit', async () => {
      const tid = `tenant-free-at-${Date.now()}`;
      const config = buildTenantConfig(tid, 'FREE');
      mockGetConfigAsync.mockResolvedValue(config);

      // Add 10 sessions (FREE limit is 10)
      for (let i = 0; i < 10; i++) {
        await claimSessionSlot(tid, `test-session-${i}`);
      }

      const result = await canStartSession(tid);

      expect(result).toBe(false);
    });

    it('returns false when over plan session limit', async () => {
      const tid = `tenant-free-over-${Date.now()}`;
      const config = buildTenantConfig(tid, 'FREE');
      mockGetConfigAsync.mockResolvedValue(config);

      // Add 11 sessions (over FREE limit of 10)
      for (let i = 0; i < 11; i++) {
        await claimSessionSlot(tid, `test-session-${i}`);
      }

      const result = await canStartSession(tid);

      expect(result).toBe(false);
    });
  });
});
