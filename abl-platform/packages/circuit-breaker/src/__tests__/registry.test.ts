/**
 * CircuitBreakerRegistry Tests
 *
 * Tests the hierarchical registry that manages breakers at
 * tenant, app, llm_provider, and tool_service levels.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

let mockRedisRef: {
  evalScript: (n: string, k: string[], a: string[]) => Promise<unknown>;
  scan: (
    cursor: string,
    m: string,
    p: string,
    c: string,
    count: number,
  ) => Promise<[string, string[]]>;
} | null = null;
vi.mock('@agent-platform/redis', async () => {
  const actual =
    await vi.importActual<typeof import('@agent-platform/redis')>('@agent-platform/redis');
  return {
    ...actual,
    runLuaScript: async (
      _client: unknown,
      script: { name: string; numberOfKeys: number },
      keys: string[],
      args: ReadonlyArray<string | number>,
    ) => {
      if (!mockRedisRef) throw new Error('mockRedisRef not set');
      return mockRedisRef.evalScript(script.name, keys, args.map(String));
    },
    // Route the cluster-aware scanKeys back through the mock's `scan` —
    // the mock returns all matches in a single page.
    scanKeys: async function* (_client: unknown, pattern: string): AsyncIterable<string> {
      if (!mockRedisRef) return;
      const [, batch] = await mockRedisRef.scan('0', 'MATCH', pattern, 'COUNT', 100);
      for (const key of batch) yield key;
    },
  };
});

import { CircuitBreakerRegistry } from '../registry.js';
import { CircuitOpenError } from '../types.js';
import { createMockRedis, type MockRedis } from './helpers/mock-redis.js';

const FAST_CONFIG = {
  failureThreshold: 2,
  successThreshold: 1,
  resetTimeout: 500,
  monitorWindow: 3000,
  halfOpenMaxConcurrent: 1,
  failureRateThreshold: 50,
  minimumRequestCount: 3,
};

describe('CircuitBreakerRegistry', () => {
  let redis: MockRedis;
  let registry: CircuitBreakerRegistry;

  beforeEach(() => {
    redis = createMockRedis();
    mockRedisRef = redis;
    registry = new CircuitBreakerRegistry(redis as any, {
      defaults: {
        tenant: FAST_CONFIG,
        app: FAST_CONFIG,
        llm_provider: FAST_CONFIG,
        tool_service: FAST_CONFIG,
      },
    });
  });

  // ── Level-Specific Breakers ──────────────────────────────

  describe('tenant breaker', () => {
    it('should execute through tenant breaker', async () => {
      const result = await registry.tenant('acme').execute(async () => 'ok');
      expect(result).toBe('ok');
    });

    it('should open tenant breaker after failures', async () => {
      const fail = async () => {
        throw new Error('down');
      };

      for (let i = 0; i < 2; i++) {
        await expect(registry.tenant('acme').execute(fail)).rejects.toThrow('down');
      }

      await expect(registry.tenant('acme').execute(async () => 'nope')).rejects.toThrow(
        CircuitOpenError,
      );
    });
  });

  describe('app breaker', () => {
    it('should isolate apps within a tenant', async () => {
      const fail = async () => {
        throw new Error('down');
      };

      // Break app-1
      for (let i = 0; i < 2; i++) {
        await expect(registry.app('acme', 'app-1').execute(fail)).rejects.toThrow('down');
      }

      // app-1 should be open
      await expect(registry.app('acme', 'app-1').execute(async () => 'nope')).rejects.toThrow(
        CircuitOpenError,
      );

      // app-2 should still work
      const result = await registry.app('acme', 'app-2').execute(async () => 'fine');
      expect(result).toBe('fine');
    });
  });

  describe('llm provider breaker', () => {
    it('should isolate providers within a tenant', async () => {
      const fail = async () => {
        throw new Error('rate limited');
      };

      // Break anthropic
      for (let i = 0; i < 2; i++) {
        await expect(registry.llmProvider('acme', 'anthropic').execute(fail)).rejects.toThrow(
          'rate limited',
        );
      }

      // anthropic should be open
      await expect(
        registry.llmProvider('acme', 'anthropic').execute(async () => 'nope'),
      ).rejects.toThrow(CircuitOpenError);

      // openai should still work
      const result = await registry
        .llmProvider('acme', 'openai')
        .execute(async () => 'fallback works');
      expect(result).toBe('fallback works');
    });
  });

  describe('tool service breaker', () => {
    it('should isolate tool services', async () => {
      const fail = async () => {
        throw new Error('timeout');
      };

      // Break hotel-search
      for (let i = 0; i < 2; i++) {
        await expect(registry.toolService('acme', 'hotel-search').execute(fail)).rejects.toThrow(
          'timeout',
        );
      }

      // hotel-search should be open
      await expect(
        registry.toolService('acme', 'hotel-search').execute(async () => 'nope'),
      ).rejects.toThrow(CircuitOpenError);

      // flight-search should still work
      const result = await registry
        .toolService('acme', 'flight-search')
        .execute(async () => 'flights ok');
      expect(result).toBe('flights ok');
    });
  });

  // ── Cross-Tenant Isolation ───────────────────────────────

  describe('cross-tenant isolation', () => {
    it('should isolate tenants completely', async () => {
      const fail = async () => {
        throw new Error('down');
      };

      // Break tenant-a
      for (let i = 0; i < 2; i++) {
        await expect(registry.tenant('tenant-a').execute(fail)).rejects.toThrow();
      }

      // tenant-a is broken
      await expect(registry.tenant('tenant-a').execute(async () => 'nope')).rejects.toThrow(
        CircuitOpenError,
      );

      // tenant-b is fine
      const result = await registry.tenant('tenant-b').execute(async () => 'isolated');
      expect(result).toBe('isolated');
    });
  });

  // ── Per-Tenant Overrides ─────────────────────────────────

  describe('tenant config overrides', () => {
    it('should apply per-tenant config overrides', async () => {
      const registryWithOverride = new CircuitBreakerRegistry(redis as any, {
        defaults: {
          tenant: FAST_CONFIG,
          app: FAST_CONFIG,
          llm_provider: FAST_CONFIG,
          tool_service: FAST_CONFIG,
        },
        tenantOverrides: [
          {
            tenantId: 'enterprise-co',
            level: 'tenant',
            config: {
              failureThreshold: 100, // Much higher threshold
            },
          },
        ],
      });

      const fail = async () => {
        throw new Error('down');
      };

      // 2 failures should NOT open enterprise-co (threshold=100)
      for (let i = 0; i < 2; i++) {
        await expect(registryWithOverride.tenant('enterprise-co').execute(fail)).rejects.toThrow(
          'down',
        );
      }

      // Should still be accessible (not open)
      const state = await registryWithOverride.tenant('enterprise-co').getState();
      expect(state).toBe('CLOSED');
    });

    it('should allow runtime config override', async () => {
      registry.setTenantOverride('special-co', 'tenant', {
        failureThreshold: 100,
      });

      const fail = async () => {
        throw new Error('down');
      };

      // 2 failures should NOT open special-co (override threshold=100)
      for (let i = 0; i < 2; i++) {
        await expect(registry.tenant('special-co').execute(fail)).rejects.toThrow('down');
      }

      const state = await registry.tenant('special-co').getState();
      expect(state).toBe('CLOSED');
    });
  });

  // ── Force Reset ──────────────────────────────────────────

  describe('force reset tenant', () => {
    it('should force reset all breakers for a tenant', async () => {
      const fail = async () => {
        throw new Error('down');
      };

      // Break multiple levels for acme
      for (let i = 0; i < 2; i++) {
        await expect(registry.tenant('acme').execute(fail)).rejects.toThrow();
        await expect(registry.app('acme', 'app-1').execute(fail)).rejects.toThrow();
      }

      // Both should be open
      await expect(registry.tenant('acme').execute(async () => 'no')).rejects.toThrow(
        CircuitOpenError,
      );
      await expect(registry.app('acme', 'app-1').execute(async () => 'no')).rejects.toThrow(
        CircuitOpenError,
      );

      // Force reset everything
      await registry.forceResetTenant('acme', 'CLOSED');

      // Both should work again
      const r1 = await registry.tenant('acme').execute(async () => 'back');
      expect(r1).toBe('back');

      const r2 = await registry.app('acme', 'app-1').execute(async () => 'back');
      expect(r2).toBe('back');
    });
  });

  // ── Global Events ────────────────────────────────────────

  describe('global events', () => {
    it('should emit events from all breaker levels', async () => {
      const events: any[] = [];
      registry.onEvent((event) => events.push(event));

      await registry.tenant('acme').execute(async () => 'ok');
      await registry.app('acme', 'app-1').execute(async () => 'ok');

      expect(events.length).toBeGreaterThan(0);
    });
  });
});
