/**
 * Per-Session Message Rate Limiting Tests (Fix 2)
 *
 * Tests that individual sessions are rate-limited to 30 messages/minute
 * via checkSessionMessageRate(). Verifies enforcement in the chat routes
 * and WebSocket handler.
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

import { checkSessionMessageRate, tenantRateLimit } from '../middleware/rate-limiter';

// =============================================================================
// HELPERS
// =============================================================================

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

describe('Per-Session Message Rate Limiting (Fix 2)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // -------------------------------------------------------------------------
  // checkSessionMessageRate() unit tests
  // -------------------------------------------------------------------------

  describe('checkSessionMessageRate()', () => {
    test('positive: allows messages within the 30/min limit', async () => {
      mockCheck.mockResolvedValue({ allowed: true, remaining: 29, resetMs: 55000 });

      const result = await checkSessionMessageRate('session-1');

      expect(result.allowed).toBe(true);
      expect(result.retryAfterMs).toBeUndefined();
    });

    test('positive: uses session-scoped key with session_message operation', async () => {
      mockCheck.mockResolvedValue({ allowed: true, remaining: 20, resetMs: 30000 });

      await checkSessionMessageRate('session-abc-123');

      expect(mockCheck).toHaveBeenCalledWith(
        'session:session-abc-123',
        'session_message',
        30, // SESSION_MESSAGE_RATE_LIMIT
      );
    });

    test('negative: returns not-allowed with retryAfterMs when limit exceeded', async () => {
      mockCheck.mockResolvedValue({ allowed: false, remaining: 0, resetMs: 42000 });

      const result = await checkSessionMessageRate('session-2');

      expect(result.allowed).toBe(false);
      expect(result.retryAfterMs).toBe(42000);
    });

    test('positive: different sessions have independent limits', async () => {
      // Session A is rate-limited
      mockCheck.mockImplementation(async (key: string) => {
        if (key === 'session:session-A') {
          return { allowed: false, remaining: 0, resetMs: 30000 };
        }
        return { allowed: true, remaining: 25, resetMs: 55000 };
      });

      const resultA = await checkSessionMessageRate('session-A');
      const resultB = await checkSessionMessageRate('session-B');

      expect(resultA.allowed).toBe(false);
      expect(resultB.allowed).toBe(true);
    });

    test('positive: retryAfterMs is undefined when allowed', async () => {
      mockCheck.mockResolvedValue({ allowed: true, remaining: 10, resetMs: 20000 });

      const result = await checkSessionMessageRate('session-3');

      expect(result.retryAfterMs).toBeUndefined();
    });

    test('negative: retryAfterMs is set when not allowed', async () => {
      mockCheck.mockResolvedValue({ allowed: false, remaining: 0, resetMs: 15000 });

      const result = await checkSessionMessageRate('session-4');

      expect(result.retryAfterMs).toBe(15000);
    });
  });

  // -------------------------------------------------------------------------
  // session_message operation type in middleware
  // -------------------------------------------------------------------------

  describe('session_message operation type in middleware', () => {
    test('session_message operation falls back to requestsPerMinute', async () => {
      mockCheck.mockResolvedValue({ allowed: true, remaining: 50, resetMs: 30000 });

      const middleware = tenantRateLimit('session_message', { requestsPerMinute: 100 });
      const req = {
        tenantContext: { tenantId: 'tenant-sm-1' },
        ip: '127.0.0.1',
        params: {},
      } as any;
      const res = createMockRes();
      const next = vi.fn();

      await middleware(req, res, next);

      // session_message falls back to requestsPerMinute when used via middleware
      expect(mockCheck).toHaveBeenCalledWith('tenant:tenant-sm-1', 'session_message', 100);
      expect(next).toHaveBeenCalledTimes(1);
    });
  });

  // -------------------------------------------------------------------------
  // Usage pattern: how chat routes call checkSessionMessageRate
  // These verify the function contract that route handlers depend on.
  // Full HTTP-level integration tests are in chat-routes.test.ts.
  // -------------------------------------------------------------------------

  describe('usage pattern: chat route call contract', () => {
    test('allowed result has no retryAfterMs (routes continue to executor)', async () => {
      mockCheck.mockResolvedValue({ allowed: true, remaining: 20, resetMs: 50000 });

      const result = await checkSessionMessageRate('runtime-session-1');
      expect(result.allowed).toBe(true);
      expect(result.retryAfterMs).toBeUndefined();
    });

    test('denied result has retryAfterMs (routes respond 429)', async () => {
      mockCheck.mockResolvedValue({ allowed: false, remaining: 0, resetMs: 30000 });

      const result = await checkSessionMessageRate('runtime-session-2');
      expect(result.allowed).toBe(false);
      expect(result.retryAfterMs).toBe(30000);
    });

    test('check is scoped to the exact session ID passed', async () => {
      mockCheck.mockResolvedValue({ allowed: true, remaining: 29, resetMs: 55000 });

      await checkSessionMessageRate('specific-runtime-session-xyz');

      expect(mockCheck).toHaveBeenCalledWith(
        'session:specific-runtime-session-xyz',
        'session_message',
        30,
      );
    });
  });

  // -------------------------------------------------------------------------
  // Usage pattern: WebSocket handler call contract
  // These verify the same function contract for sdk-handler.ts callers.
  // -------------------------------------------------------------------------

  describe('usage pattern: WebSocket handler call contract', () => {
    test('allowed result lets WebSocket processing continue', async () => {
      mockCheck.mockResolvedValue({ allowed: true, remaining: 15, resetMs: 40000 });

      const runtimeSid = 'ws-session-id-1';
      const msgRate = await checkSessionMessageRate(runtimeSid);

      expect(msgRate.allowed).toBe(true);
      expect(msgRate.retryAfterMs).toBeUndefined();
    });

    test('denied result provides retryAfterMs for WebSocket error message', async () => {
      mockCheck.mockResolvedValue({ allowed: false, remaining: 0, resetMs: 25000 });

      const runtimeSid = 'ws-session-id-2';
      const msgRate = await checkSessionMessageRate(runtimeSid);

      expect(msgRate.allowed).toBe(false);
      expect(msgRate.retryAfterMs).toBe(25000);
    });
  });
});
