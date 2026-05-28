/**
 * WebSocket Tenant-Based Rate Limiting Tests
 *
 * Verifies that WSConnectionRateLimiter correctly scopes rate limit buckets
 * by tenant+IP when a tenantId is provided, while maintaining backward
 * compatibility for IP-only mode (pre-auth flood protection).
 */

import { describe, test, expect, beforeEach, vi, afterEach } from 'vitest';

// Mock dependencies required by sdk-handler.ts module
vi.mock('@abl/compiler/platform', () => ({
  createLogger: vi.fn().mockReturnValue({
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

vi.mock('../../services/runtime-executor.js', () => ({
  getRuntimeExecutor: vi.fn(),
  compileToResolvedAgent: vi.fn(),
  resolveProjectTools: vi.fn(),
}));

vi.mock('../../services/llm/llm-queue.js', () => ({
  enqueueLLMRequest: vi.fn(),
  BackpressureError: class extends Error {},
  isLLMQueueEnabled: vi.fn().mockReturnValue(false),
}));

vi.mock('../../db/index.js', () => ({
  isDatabaseAvailable: vi.fn().mockReturnValue(false),
}));

vi.mock('../../services/stores/store-factory.js', () => ({
  getStores: vi.fn().mockReturnValue({
    traceStore: { addEvent: vi.fn() },
    sessionStore: { get: vi.fn(), set: vi.fn() },
  }),
}));

vi.mock('../../services/message-persistence-queue.js', () => ({
  persistMessage: vi.fn(),
  persistMessageRecord: vi.fn(),
  persistTurnMetrics: vi.fn(),
  flushMessageQueue: vi.fn(),
}));

vi.mock('../../repos/project-repo.js', () => ({
  findProjectAgentForProject: vi.fn(async () => null),
  findProjectWithAgents: vi.fn(),
}));

vi.mock('../../services/deployment-resolver.js', () => ({
  DeploymentResolver: vi.fn(),
}));

vi.mock('../../services/session/session-service.js', () => ({
  getSessionService: vi.fn().mockReturnValue({
    store: { get: vi.fn(), set: vi.fn() },
  }),
}));

vi.mock('../../services/trace-store.js', () => ({
  getTraceStore: vi.fn().mockReturnValue({ addEvent: vi.fn() }),
}));

vi.mock('../../server.js', () => ({
  app: { get: vi.fn() },
}));

vi.mock('../../config/index.js', () => ({
  getConfig: vi.fn().mockReturnValue({ jwt: { secret: 'test' } }),
}));

vi.mock('../../middleware/auth.js', () => ({
  SDK_TOKEN_ISSUER: 'test-issuer',
  SDK_TOKEN_AUDIENCE: 'test-audience',
}));

vi.mock('../../observability/metrics.js', () => ({
  recordWsRateLimitRejection: vi.fn(),
}));

vi.mock('../../middleware/rate-limiter.js', () => ({
  checkSessionMessageRate: vi.fn().mockReturnValue(true),
}));

vi.mock('../../observability/voice-trace.js', () => ({
  startVoiceTurn: vi.fn(),
  getActiveVoiceTurn: vi.fn(),
  startSTTPhase: vi.fn(),
  completeSTTPhase: vi.fn(),
  startLLMPhase: vi.fn(),
  completeLLMPhase: vi.fn(),
  startTTSPhase: vi.fn(),
  recordTTSFirstChunk: vi.fn(),
  completeTTSPhase: vi.fn(),
  completeVoiceTurn: vi.fn(),
  failVoiceTurn: vi.fn(),
  createTimingReportEvent: vi.fn(),
}));

// Import the class under test after mocks
import { WSConnectionRateLimiter } from '../../websocket/sdk-handler.js';

describe('WSConnectionRateLimiter', () => {
  let limiter: WSConnectionRateLimiter;

  beforeEach(() => {
    vi.useFakeTimers();
    // Create a limiter with a low limit for easy testing
    limiter = new WSConnectionRateLimiter(3);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // ---------------------------------------------------------------------------
  // IP-only mode (backward compatibility)
  // ---------------------------------------------------------------------------

  describe('IP-only mode (no tenantId)', () => {
    test('allows connections under the limit', () => {
      expect(limiter.check('10.0.0.1')).toBe(true);
      expect(limiter.check('10.0.0.1')).toBe(true);
      expect(limiter.check('10.0.0.1')).toBe(true);
    });

    test('rejects connections over the limit', () => {
      expect(limiter.check('10.0.0.1')).toBe(true);
      expect(limiter.check('10.0.0.1')).toBe(true);
      expect(limiter.check('10.0.0.1')).toBe(true);
      // 4th attempt exceeds the limit of 3
      expect(limiter.check('10.0.0.1')).toBe(false);
    });

    test('different IPs have independent limits', () => {
      // Exhaust limit for IP 1
      limiter.check('10.0.0.1');
      limiter.check('10.0.0.1');
      limiter.check('10.0.0.1');
      expect(limiter.check('10.0.0.1')).toBe(false);

      // IP 2 should still be allowed
      expect(limiter.check('10.0.0.2')).toBe(true);
    });

    test('resets window after 1 minute', () => {
      // Exhaust limit
      limiter.check('10.0.0.1');
      limiter.check('10.0.0.1');
      limiter.check('10.0.0.1');
      expect(limiter.check('10.0.0.1')).toBe(false);

      // Advance time past the 60-second window
      vi.advanceTimersByTime(60_001);

      // Should be allowed again
      expect(limiter.check('10.0.0.1')).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  // Tenant+IP mode (new behavior)
  // ---------------------------------------------------------------------------

  describe('tenant+IP mode', () => {
    test('allows connections under the per-tenant limit', () => {
      expect(limiter.check('10.0.0.1', 'tenant-A')).toBe(true);
      expect(limiter.check('10.0.0.1', 'tenant-A')).toBe(true);
      expect(limiter.check('10.0.0.1', 'tenant-A')).toBe(true);
    });

    test('rejects connections over the per-tenant limit', () => {
      limiter.check('10.0.0.1', 'tenant-A');
      limiter.check('10.0.0.1', 'tenant-A');
      limiter.check('10.0.0.1', 'tenant-A');
      // 4th attempt for tenant-A exceeds the limit of 3
      expect(limiter.check('10.0.0.1', 'tenant-A')).toBe(false);
    });

    test('two tenants on the same IP get independent buckets', () => {
      // Exhaust limit for tenant-A on shared IP
      limiter.check('10.0.0.1', 'tenant-A');
      limiter.check('10.0.0.1', 'tenant-A');
      limiter.check('10.0.0.1', 'tenant-A');
      expect(limiter.check('10.0.0.1', 'tenant-A')).toBe(false);

      // tenant-B on the SAME IP should still be allowed — separate bucket
      expect(limiter.check('10.0.0.1', 'tenant-B')).toBe(true);
      expect(limiter.check('10.0.0.1', 'tenant-B')).toBe(true);
      expect(limiter.check('10.0.0.1', 'tenant-B')).toBe(true);

      // tenant-B should also be rate limited after 3
      expect(limiter.check('10.0.0.1', 'tenant-B')).toBe(false);
    });

    test('same tenant on different IPs get independent buckets', () => {
      // Exhaust limit for tenant-A on IP 1
      limiter.check('10.0.0.1', 'tenant-A');
      limiter.check('10.0.0.1', 'tenant-A');
      limiter.check('10.0.0.1', 'tenant-A');
      expect(limiter.check('10.0.0.1', 'tenant-A')).toBe(false);

      // Same tenant on different IP should still be allowed
      expect(limiter.check('10.0.0.2', 'tenant-A')).toBe(true);
    });

    test('tenant+IP bucket is independent from IP-only bucket', () => {
      // Check with IP only (pre-auth)
      limiter.check('10.0.0.1');
      limiter.check('10.0.0.1');

      // Check with tenant+IP (post-auth) — should be a separate bucket
      // and not count against the IP-only bucket's total
      expect(limiter.check('10.0.0.1', 'tenant-A')).toBe(true);
      expect(limiter.check('10.0.0.1', 'tenant-A')).toBe(true);
      expect(limiter.check('10.0.0.1', 'tenant-A')).toBe(true);

      // tenant-A bucket now exhausted
      expect(limiter.check('10.0.0.1', 'tenant-A')).toBe(false);

      // IP-only bucket should still have 1 left (2 used out of 3)
      expect(limiter.check('10.0.0.1')).toBe(true);
      // Now IP-only bucket exhausted (3 out of 3)
      expect(limiter.check('10.0.0.1')).toBe(false);
    });

    test('resets tenant+IP window after 1 minute', () => {
      // Exhaust tenant-A limit
      limiter.check('10.0.0.1', 'tenant-A');
      limiter.check('10.0.0.1', 'tenant-A');
      limiter.check('10.0.0.1', 'tenant-A');
      expect(limiter.check('10.0.0.1', 'tenant-A')).toBe(false);

      // Advance time past the 60-second window
      vi.advanceTimersByTime(60_001);

      // Should be allowed again
      expect(limiter.check('10.0.0.1', 'tenant-A')).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  // Edge cases
  // ---------------------------------------------------------------------------

  describe('edge cases', () => {
    test('empty tenantId is treated as no tenantId (IP-only key)', () => {
      // Empty string is falsy, so should use IP-only key
      limiter.check('10.0.0.1', '');
      limiter.check('10.0.0.1');
      // Both should count against the same IP-only bucket (2 out of 3)
      expect(limiter.check('10.0.0.1')).toBe(true);
      // 4th total check should exceed limit
      expect(limiter.check('10.0.0.1')).toBe(false);
    });

    test('exactly at limit is still allowed', () => {
      // limit is 3
      expect(limiter.check('10.0.0.1', 'tenant-A')).toBe(true); // 1
      expect(limiter.check('10.0.0.1', 'tenant-A')).toBe(true); // 2
      expect(limiter.check('10.0.0.1', 'tenant-A')).toBe(true); // 3 — at limit
    });

    test('one over limit is rejected', () => {
      limiter.check('10.0.0.1', 'tenant-A'); // 1
      limiter.check('10.0.0.1', 'tenant-A'); // 2
      limiter.check('10.0.0.1', 'tenant-A'); // 3
      expect(limiter.check('10.0.0.1', 'tenant-A')).toBe(false); // 4
    });

    test('many tenants on the same IP are all independent', () => {
      const tenantIds = ['t1', 't2', 't3', 't4', 't5'];
      for (const tid of tenantIds) {
        // Each tenant should be able to use their full limit
        expect(limiter.check('10.0.0.1', tid)).toBe(true);
        expect(limiter.check('10.0.0.1', tid)).toBe(true);
        expect(limiter.check('10.0.0.1', tid)).toBe(true);
        // And then be rate limited
        expect(limiter.check('10.0.0.1', tid)).toBe(false);
      }
    });
  });
});
