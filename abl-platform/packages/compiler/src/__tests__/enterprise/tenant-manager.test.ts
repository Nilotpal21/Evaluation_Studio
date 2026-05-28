/**
 * NLU Tenant Manager Tests
 *
 * Tests engine creation/caching, LRU eviction, config overrides,
 * tenant operations, cache/metrics access, and hook building.
 */
import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { NLUTenantManager } from '../../platform/nlu/enterprise/tenant-manager.js';
import { NLUResultCache } from '../../platform/nlu/enterprise/nlu-cache.js';
import type { NLUConfig } from '../../platform/nlu/config.js';
import type { NLUAuditPort } from '../../platform/nlu/enterprise/interfaces.js';

// Mock NLUEngine to avoid real LLM client requirements
vi.mock('../../platform/nlu/engine.js', () => ({
  NLUEngine: {
    fromLLMClient: vi.fn(() => ({
      // minimal mock engine
      _mockEngine: true,
    })),
  },
}));

// =============================================================================
// HELPERS
// =============================================================================

function makeConfig(overrides?: Partial<NLUConfig>): NLUConfig {
  return {
    fastModel: 'default',
    confidenceThreshold: 0.7,
    enableFallbacks: true,
    environment: 'production',
    cache: { enabled: true, ttlMs: 60_000, intentTtlMs: 60_000, entityTtlMs: 30_000 },
    piiRedaction: { enabled: false, redactInput: true, redactOutput: false },
    circuitBreaker: { enabled: true, failureThreshold: 5, resetTimeoutMs: 30_000 },
    audit: { enabled: false, logPredictions: false },
    rateLimiting: { enabled: false, maxCallsPerMinute: 1000 },
    ...overrides,
  };
}

function makeLLMClient() {
  return vi.fn() as any; // Minimal mock — NLUEngine.fromLLMClient is mocked
}

// =============================================================================
// TESTS
// =============================================================================

describe('NLUTenantManager', () => {
  let nowSpy: ReturnType<typeof vi.spyOn>;
  let currentTime: number;

  beforeEach(() => {
    currentTime = 1000000;
    nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => currentTime);
  });

  afterEach(() => {
    nowSpy.mockRestore();
  });

  // =========================================================================
  // ENGINE CREATION
  // =========================================================================

  describe('engine creation', () => {
    test('getEngine creates engine on first call', () => {
      const manager = new NLUTenantManager(makeConfig());
      const engine = manager.getEngine('tenant-1', makeLLMClient());
      expect(engine).toBeDefined();
      expect(manager.size).toBe(1);
    });

    test('subsequent calls return same engine (cached)', () => {
      const manager = new NLUTenantManager(makeConfig());
      const llm = makeLLMClient();
      const engine1 = manager.getEngine('tenant-1', llm);
      currentTime += 100;
      const engine2 = manager.getEngine('tenant-1', llm);
      expect(engine1).toBe(engine2);
    });

    test('updates lastAccessTime on each access', () => {
      const manager = new NLUTenantManager(makeConfig(), { maxTenants: 3 });
      const llm = makeLLMClient();

      // Create three tenants
      manager.getEngine('t1', llm);
      currentTime += 100;
      manager.getEngine('t2', llm);
      currentTime += 100;
      manager.getEngine('t3', llm);

      // Access t1 again to update its lastAccessTime
      currentTime += 100;
      manager.getEngine('t1', llm);

      // Add 4th tenant — should evict t2 (oldest last access), not t1
      currentTime += 100;
      manager.getEngine('t4', llm);

      expect(manager.getActiveTenants()).toContain('t1');
      expect(manager.getActiveTenants()).not.toContain('t2');
      expect(manager.getActiveTenants()).toContain('t3');
      expect(manager.getActiveTenants()).toContain('t4');
    });
  });

  // =========================================================================
  // LRU EVICTION
  // =========================================================================

  describe('LRU eviction', () => {
    test('with maxTenants: 3, adding 4th tenant evicts oldest', () => {
      const manager = new NLUTenantManager(makeConfig(), { maxTenants: 3 });
      const llm = makeLLMClient();

      manager.getEngine('t1', llm);
      currentTime += 100;
      manager.getEngine('t2', llm);
      currentTime += 100;
      manager.getEngine('t3', llm);
      expect(manager.size).toBe(3);

      currentTime += 100;
      manager.getEngine('t4', llm);
      expect(manager.size).toBe(3);
      expect(manager.getActiveTenants()).not.toContain('t1');
    });

    test('access updates LRU order', () => {
      const manager = new NLUTenantManager(makeConfig(), { maxTenants: 3 });
      const llm = makeLLMClient();

      manager.getEngine('t1', llm);
      currentTime += 100;
      manager.getEngine('t2', llm);
      currentTime += 100;
      manager.getEngine('t3', llm);

      // Access t1 to make it most recently used
      currentTime += 100;
      manager.getEngine('t1', llm);

      // Add t4 — should evict t2 (now the oldest)
      currentTime += 100;
      manager.getEngine('t4', llm);

      expect(manager.getActiveTenants()).toContain('t1');
      expect(manager.getActiveTenants()).not.toContain('t2');
    });
  });

  // =========================================================================
  // CONFIG OVERRIDES
  // =========================================================================

  describe('config overrides', () => {
    test('setTenantOverride invalidates existing engine', () => {
      const manager = new NLUTenantManager(makeConfig());
      const llm = makeLLMClient();

      const engine1 = manager.getEngine('t1', llm);
      manager.setTenantOverride('t1', { fastModel: 'custom-model' });

      // Engine was invalidated, so next call creates a new one
      const engine2 = manager.getEngine('t1', llm);
      expect(engine2).not.toBe(engine1);
    });

    test('next getEngine creates new engine with merged config', () => {
      const manager = new NLUTenantManager(makeConfig());
      const llm = makeLLMClient();

      manager.setTenantOverride('t1', {
        cache: { enabled: false, ttlMs: 1000, intentTtlMs: 1000, entityTtlMs: 500 },
      });

      // Should succeed without error (engine created with merged config)
      const engine = manager.getEngine('t1', llm);
      expect(engine).toBeDefined();
    });
  });

  // =========================================================================
  // TENANT OPERATIONS
  // =========================================================================

  describe('tenant operations', () => {
    test('removeTenant deletes engine and overrides', () => {
      const manager = new NLUTenantManager(makeConfig());
      const llm = makeLLMClient();

      manager.getEngine('t1', llm);
      manager.setTenantOverride('t1', { fastModel: 'x' });

      manager.removeTenant('t1');
      expect(manager.size).toBe(0);
      expect(manager.getActiveTenants()).not.toContain('t1');

      // After remove, getting engine creates a fresh one (no override applied)
      const engine = manager.getEngine('t1', llm);
      expect(engine).toBeDefined();
    });

    test('getActiveTenants returns current tenant IDs', () => {
      const manager = new NLUTenantManager(makeConfig());
      const llm = makeLLMClient();

      manager.getEngine('alpha', llm);
      manager.getEngine('beta', llm);

      const tenants = manager.getActiveTenants();
      expect(tenants).toContain('alpha');
      expect(tenants).toContain('beta');
      expect(tenants).toHaveLength(2);
    });

    test('size getter returns correct count', () => {
      const manager = new NLUTenantManager(makeConfig());
      const llm = makeLLMClient();

      expect(manager.size).toBe(0);
      manager.getEngine('t1', llm);
      expect(manager.size).toBe(1);
      manager.getEngine('t2', llm);
      expect(manager.size).toBe(2);
      manager.removeTenant('t1');
      expect(manager.size).toBe(1);
    });
  });

  // =========================================================================
  // CACHE/METRICS ACCESS
  // =========================================================================

  describe('cache/metrics access', () => {
    test('getCacheForTenant returns cache for existing tenant', () => {
      const manager = new NLUTenantManager(makeConfig());
      manager.getEngine('t1', makeLLMClient());

      const cache = manager.getCacheForTenant('t1');
      expect(cache).toBeInstanceOf(NLUResultCache);
    });

    test('getMetricsForTenant returns metrics for existing tenant', () => {
      const manager = new NLUTenantManager(makeConfig());
      manager.getEngine('t1', makeLLMClient());

      const metrics = manager.getMetricsForTenant('t1');
      expect(metrics).toBeDefined();
      expect(typeof metrics!.recordPrediction).toBe('function');
    });

    test('getCacheForTenant returns undefined for unknown tenant', () => {
      const manager = new NLUTenantManager(makeConfig());
      expect(manager.getCacheForTenant('nonexistent')).toBeUndefined();
    });

    test('getMetricsForTenant returns undefined for unknown tenant', () => {
      const manager = new NLUTenantManager(makeConfig());
      expect(manager.getMetricsForTenant('nonexistent')).toBeUndefined();
    });
  });

  // =========================================================================
  // HOOK BUILDING
  // =========================================================================

  describe('hook building', () => {
    test('hooks include PII guard when piiRedaction.enabled', () => {
      const config = makeConfig({
        piiRedaction: { enabled: true, redactInput: true, redactOutput: false },
      });
      const manager = new NLUTenantManager(config);
      manager.getEngine('t1', makeLLMClient());

      const hooks = manager.getHooks('t1');
      expect(hooks?.beforeExecute).toBeDefined();
    });

    test('hooks include cache hooks when cache.enabled', () => {
      const config = makeConfig({
        cache: { enabled: true, ttlMs: 60_000, intentTtlMs: 60_000, entityTtlMs: 30_000 },
      });
      const manager = new NLUTenantManager(config);
      manager.getEngine('t1', makeLLMClient());

      const hooks = manager.getHooks('t1');
      expect(hooks?.checkCache).toBeDefined();
      expect(hooks?.storeCache).toBeDefined();
    });

    test('hooks include circuit breaker when circuitBreaker.enabled', () => {
      const config = makeConfig({
        circuitBreaker: { enabled: true, failureThreshold: 3, resetTimeoutMs: 5000 },
      });
      const manager = new NLUTenantManager(config);
      manager.getEngine('t1', makeLLMClient());

      const hooks = manager.getHooks('t1');
      expect(hooks?.wrapLLMCall).toBeDefined();
    });

    test('hooks include audit when audit.enabled AND audit port provided', () => {
      const auditPort: NLUAuditPort = {
        logPrediction: vi.fn(async () => {}),
      };
      const config = makeConfig({ audit: { enabled: true, logPredictions: true } });
      const manager = new NLUTenantManager(config, { ports: { audit: auditPort } });
      manager.getEngine('t1', makeLLMClient());

      const hooks = manager.getHooks('t1');
      expect(hooks?.afterExecute).toBeDefined();
    });

    test('hooks omit audit when audit.enabled but no audit port', () => {
      const config = makeConfig({ audit: { enabled: true, logPredictions: true } });
      const manager = new NLUTenantManager(config);
      manager.getEngine('t1', makeLLMClient());

      const hooks = manager.getHooks('t1');
      expect(hooks?.afterExecute).toBeUndefined();
    });

    test('hooks omit features when disabled', () => {
      const config = makeConfig({
        piiRedaction: { enabled: false, redactInput: true, redactOutput: false },
        cache: { enabled: false, ttlMs: 60_000, intentTtlMs: 60_000, entityTtlMs: 30_000 },
        circuitBreaker: { enabled: false, failureThreshold: 5, resetTimeoutMs: 30_000 },
        audit: { enabled: false, logPredictions: false },
      });
      const manager = new NLUTenantManager(config);
      manager.getEngine('t1', makeLLMClient());

      const hooks = manager.getHooks('t1');
      expect(hooks?.beforeExecute).toBeUndefined();
      expect(hooks?.checkCache).toBeUndefined();
      expect(hooks?.storeCache).toBeUndefined();
      expect(hooks?.wrapLLMCall).toBeUndefined();
      expect(hooks?.afterExecute).toBeUndefined();
    });
  });
});
