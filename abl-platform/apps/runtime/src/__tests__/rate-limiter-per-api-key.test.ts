/**
 * Per-API-Key Rate Limiting Tests (Fix 1)
 *
 * Tests that API key requests get an additional sub-limit (tenant limit / 5,
 * minimum 10) so one misbehaving key can't starve others in the same tenant.
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks — must be declared before importing the module under test
// ---------------------------------------------------------------------------

const mockCheck = vi.fn();

vi.mock('../services/resilience/hybrid-rate-limiter.js', () => ({
  getHybridRateLimiter: () => ({ check: mockCheck }),
}));

vi.mock('../services/tenant-config.js', () => ({
  getTenantConfigService: () => ({
    getConfigAsync: vi.fn().mockRejectedValue(new Error('No MongoDB in test')),
    getProjectConfig: vi.fn().mockRejectedValue(new Error('No MongoDB in test')),
  }),
}));

vi.mock('../services/redis/redis-client.js', () => ({
  getRedisClient: () => null,
  getRedisHandle: () => null,
  isRedisAvailable: () => false,
}));

import { tenantRateLimit } from '../middleware/rate-limiter';

// =============================================================================
// HELPERS
// =============================================================================

let seq = 0;

function createMockReq(overrides = {}) {
  seq++;
  return {
    tenantContext: { tenantId: `tenant-${seq}-${Date.now()}` },
    ip: '127.0.0.1',
    params: {},
    ...overrides,
  } as any;
}

function createMockRes() {
  const res: any = {
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
    set: vi.fn(),
  };
  return res;
}

// =============================================================================
// TESTS
// =============================================================================

describe('Per-API-Key Rate Limiting (Fix 1)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // -------------------------------------------------------------------------
  // Positive Tests
  // -------------------------------------------------------------------------

  describe('positive: API key requests within per-key limit', () => {
    test('API key request passes when both per-key and tenant checks allow', async () => {
      mockCheck.mockResolvedValue({ allowed: true, remaining: 5, resetMs: 30000 });

      const middleware = tenantRateLimit('request', { requestsPerMinute: 100 });
      const req = createMockReq({
        tenantContext: {
          tenantId: 'tenant-apikey-1',
          authType: 'api_key',
          apiKeyId: 'key-uuid-1',
        },
      });
      const res = createMockRes();
      const next = vi.fn();

      await middleware(req, res, next);

      expect(next).toHaveBeenCalledTimes(1);
      expect(res.status).not.toHaveBeenCalled();
    });

    test('per-key limit is Math.floor(tenantLimit / 5), minimum 10', async () => {
      mockCheck.mockResolvedValue({ allowed: true, remaining: 10, resetMs: 30000 });

      const middleware = tenantRateLimit('request', { requestsPerMinute: 100 });
      const req = createMockReq({
        tenantContext: {
          tenantId: 'tenant-apikey-2',
          authType: 'api_key',
          apiKeyId: 'key-uuid-2',
        },
      });
      const res = createMockRes();
      const next = vi.fn();

      await middleware(req, res, next);

      // First call: per-key check with limit = Math.max(10, floor(100/5)) = 20
      expect(mockCheck).toHaveBeenCalledWith('apiKey:key-uuid-2', 'request', 20);
      // Second call: tenant check
      expect(mockCheck).toHaveBeenCalledWith('tenant:tenant-apikey-2', 'request', 100);
    });

    test('per-key limit never goes below 10 even for low tenant limits', async () => {
      mockCheck.mockResolvedValue({ allowed: true, remaining: 5, resetMs: 30000 });

      const middleware = tenantRateLimit('request', { requestsPerMinute: 20 });
      const req = createMockReq({
        tenantContext: {
          tenantId: 'tenant-apikey-3',
          authType: 'api_key',
          apiKeyId: 'key-uuid-3',
        },
      });
      const res = createMockRes();
      const next = vi.fn();

      await middleware(req, res, next);

      // floor(20/5) = 4, but minimum is 10
      expect(mockCheck).toHaveBeenCalledWith('apiKey:key-uuid-3', 'request', 10);
    });

    test('per-key check happens BEFORE tenant check', async () => {
      const callOrder: string[] = [];
      mockCheck.mockImplementation(async (key: string) => {
        callOrder.push(key.startsWith('apiKey:') ? 'per-key' : 'tenant');
        return { allowed: true, remaining: 10, resetMs: 30000 };
      });

      const middleware = tenantRateLimit('request', { requestsPerMinute: 100 });
      const req = createMockReq({
        tenantContext: {
          tenantId: 'tenant-apikey-4',
          authType: 'api_key',
          apiKeyId: 'key-uuid-4',
        },
      });
      const res = createMockRes();
      const next = vi.fn();

      await middleware(req, res, next);

      expect(callOrder).toEqual(['per-key', 'tenant']);
    });
  });

  // -------------------------------------------------------------------------
  // Negative Tests
  // -------------------------------------------------------------------------

  describe('negative: API key exceeds per-key limit', () => {
    test('returns 429 when per-key limit exceeded, even if tenant has capacity', async () => {
      // Per-key check fails, tenant check would succeed
      mockCheck.mockImplementation(async (key: string) => {
        if (key.startsWith('apiKey:')) {
          return { allowed: false, remaining: 0, resetMs: 45000 };
        }
        return { allowed: true, remaining: 50, resetMs: 30000 };
      });

      const middleware = tenantRateLimit('request', { requestsPerMinute: 100 });
      const req = createMockReq({
        tenantContext: {
          tenantId: 'tenant-apikey-5',
          authType: 'api_key',
          apiKeyId: 'key-uuid-5',
        },
      });
      const res = createMockRes();
      const next = vi.fn();

      await middleware(req, res, next);

      expect(next).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(429);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: 'API key rate limit exceeded',
          operation: 'request',
          limit: 20, // floor(100/5)
        }),
      );
      expect(res.set).toHaveBeenCalledWith('Retry-After', expect.any(String));
    });

    test('429 response includes correct rate limit headers for per-key limit', async () => {
      mockCheck.mockImplementation(async (key: string) => {
        if (key.startsWith('apiKey:')) {
          return { allowed: false, remaining: 0, resetMs: 45000 };
        }
        return { allowed: true, remaining: 50, resetMs: 30000 };
      });

      const middleware = tenantRateLimit('request', { requestsPerMinute: 100 });
      const req = createMockReq({
        tenantContext: {
          tenantId: 'tenant-apikey-6',
          authType: 'api_key',
          apiKeyId: 'key-uuid-6',
        },
      });
      const res = createMockRes();
      const next = vi.fn();

      await middleware(req, res, next);

      expect(res.set).toHaveBeenCalledWith('X-RateLimit-Limit', '20');
      expect(res.set).toHaveBeenCalledWith('X-RateLimit-Remaining', '0');
      expect(res.set).toHaveBeenCalledWith('X-RateLimit-Reset', expect.any(String));
      expect(res.set).toHaveBeenCalledWith('Retry-After', expect.any(String));
    });

    test('tenant-level check is not called when per-key check fails', async () => {
      mockCheck.mockImplementation(async (key: string) => {
        if (key.startsWith('apiKey:')) {
          return { allowed: false, remaining: 0, resetMs: 30000 };
        }
        return { allowed: true, remaining: 50, resetMs: 30000 };
      });

      const middleware = tenantRateLimit('request', { requestsPerMinute: 100 });
      const req = createMockReq({
        tenantContext: {
          tenantId: 'tenant-apikey-7',
          authType: 'api_key',
          apiKeyId: 'key-uuid-7',
        },
      });
      const res = createMockRes();
      const next = vi.fn();

      await middleware(req, res, next);

      // Only one call: the per-key check. Tenant check should NOT be called.
      expect(mockCheck).toHaveBeenCalledTimes(1);
      expect(mockCheck).toHaveBeenCalledWith('apiKey:key-uuid-7', 'request', 20);
    });
  });

  // -------------------------------------------------------------------------
  // Non-API-key requests
  // -------------------------------------------------------------------------

  describe('non-API-key requests are unaffected', () => {
    test('JWT request skips per-key check entirely', async () => {
      mockCheck.mockResolvedValue({ allowed: true, remaining: 10, resetMs: 30000 });

      const middleware = tenantRateLimit('request', { requestsPerMinute: 100 });
      const req = createMockReq({
        tenantContext: {
          tenantId: 'tenant-jwt-1',
          authType: 'jwt',
        },
      });
      const res = createMockRes();
      const next = vi.fn();

      await middleware(req, res, next);

      // Only one call: tenant check. No per-key check.
      expect(mockCheck).toHaveBeenCalledTimes(1);
      expect(mockCheck).toHaveBeenCalledWith('tenant:tenant-jwt-1', 'request', 100);
      expect(next).toHaveBeenCalledTimes(1);
    });

    test('SDK auth request skips per-key check', async () => {
      mockCheck.mockResolvedValue({ allowed: true, remaining: 10, resetMs: 30000 });

      const middleware = tenantRateLimit('request', { requestsPerMinute: 100 });
      const req = createMockReq({
        tenantContext: {
          tenantId: 'tenant-sdk-1',
          authType: 'sdk_session',
        },
      });
      const res = createMockRes();
      const next = vi.fn();

      await middleware(req, res, next);

      expect(mockCheck).toHaveBeenCalledTimes(1);
      expect(next).toHaveBeenCalledTimes(1);
    });

    test('API key auth without apiKeyId skips per-key check', async () => {
      mockCheck.mockResolvedValue({ allowed: true, remaining: 10, resetMs: 30000 });

      const middleware = tenantRateLimit('request', { requestsPerMinute: 100 });
      const req = createMockReq({
        tenantContext: {
          tenantId: 'tenant-nokey-1',
          authType: 'api_key',
          // apiKeyId is missing
        },
      });
      const res = createMockRes();
      const next = vi.fn();

      await middleware(req, res, next);

      expect(mockCheck).toHaveBeenCalledTimes(1);
      expect(next).toHaveBeenCalledTimes(1);
    });

    test('request with no tenantContext uses IP-based key', async () => {
      mockCheck.mockResolvedValue({ allowed: true, remaining: 10, resetMs: 30000 });

      const middleware = tenantRateLimit('request', { requestsPerMinute: 100 });
      const req = createMockReq({
        tenantContext: undefined,
        ip: '192.168.1.1',
      });
      const res = createMockRes();
      const next = vi.fn();

      await middleware(req, res, next);

      expect(mockCheck).toHaveBeenCalledTimes(1);
      expect(mockCheck).toHaveBeenCalledWith('ip:192.168.1.1', 'request', 100);
      expect(next).toHaveBeenCalledTimes(1);
    });
  });

  // -------------------------------------------------------------------------
  // Edge cases
  // -------------------------------------------------------------------------

  describe('edge cases', () => {
    test('per-key limit applies to tool_call operations', async () => {
      mockCheck.mockResolvedValue({ allowed: true, remaining: 10, resetMs: 30000 });

      const middleware = tenantRateLimit('tool_call', { toolCallsPerMinute: 200 });
      const req = createMockReq({
        tenantContext: {
          tenantId: 'tenant-apikey-op',
          authType: 'api_key',
          apiKeyId: 'key-uuid-op',
        },
      });
      const res = createMockRes();
      const next = vi.fn();

      await middleware(req, res, next);

      // Per-key: floor(200/5) = 40
      expect(mockCheck).toHaveBeenCalledWith('apiKey:key-uuid-op', 'tool_call', 40);
    });

    test('per-key limit applies to session operations (concurrentSessions)', async () => {
      mockCheck.mockResolvedValue({ allowed: true, remaining: 10, resetMs: 30000 });

      // concurrentSessions defaults to 50 (DEFAULT_LIMITS)
      const middleware = tenantRateLimit('session', { concurrentSessions: 50 });
      const req = createMockReq({
        tenantContext: {
          tenantId: 'tenant-apikey-session',
          authType: 'api_key',
          apiKeyId: 'key-uuid-session',
        },
      });
      const res = createMockRes();
      const next = vi.fn();

      await middleware(req, res, next);

      // Per-key: floor(50/5) = 10
      expect(mockCheck).toHaveBeenCalledWith('apiKey:key-uuid-session', 'session', 10);
      // Tenant check with full limit
      expect(mockCheck).toHaveBeenCalledWith('tenant:tenant-apikey-session', 'session', 50);
    });

    test('per-key limit applies to llm_tokens operations', async () => {
      mockCheck.mockResolvedValue({ allowed: true, remaining: 10, resetMs: 30000 });

      const middleware = tenantRateLimit('llm_tokens', { tokensPerMinute: 100000 });
      const req = createMockReq({
        tenantContext: {
          tenantId: 'tenant-apikey-tokens',
          authType: 'api_key',
          apiKeyId: 'key-uuid-tokens',
        },
      });
      const res = createMockRes();
      const next = vi.fn();

      await middleware(req, res, next);

      // Per-key: floor(100000/5) = 20000
      expect(mockCheck).toHaveBeenCalledWith('apiKey:key-uuid-tokens', 'llm_tokens', 20000);
      // Tenant check with full limit
      expect(mockCheck).toHaveBeenCalledWith('tenant:tenant-apikey-tokens', 'llm_tokens', 100000);
    });

    test('per-key limit applies to session_message operations', async () => {
      mockCheck.mockResolvedValue({ allowed: true, remaining: 10, resetMs: 30000 });

      const middleware = tenantRateLimit('session_message', { requestsPerMinute: 100 });
      const req = createMockReq({
        tenantContext: {
          tenantId: 'tenant-apikey-msg',
          authType: 'api_key',
          apiKeyId: 'key-uuid-msg',
        },
      });
      const res = createMockRes();
      const next = vi.fn();

      await middleware(req, res, next);

      // session_message maps to requestsPerMinute -> floor(100/5) = 20
      expect(mockCheck).toHaveBeenCalledWith('apiKey:key-uuid-msg', 'session_message', 20);
    });

    test('unlimited (-1) limit skips both per-key and tenant checks', async () => {
      const middleware = tenantRateLimit('request', { requestsPerMinute: -1 });
      const req = createMockReq({
        tenantContext: {
          tenantId: 'tenant-unlimited',
          authType: 'api_key',
          apiKeyId: 'key-uuid-unlimited',
        },
      });
      const res = createMockRes();
      const next = vi.fn();

      await middleware(req, res, next);

      expect(mockCheck).not.toHaveBeenCalled();
      expect(next).toHaveBeenCalledTimes(1);
    });
  });
});
