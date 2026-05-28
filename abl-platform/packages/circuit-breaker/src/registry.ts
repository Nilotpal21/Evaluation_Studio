/**
 * CircuitBreakerRegistry
 *
 * Manages a hierarchy of circuit breakers:
 *   tenant → app → llm_provider → tool_service
 *
 * Provides factory methods that return the correct breaker for a given
 * level and key, with support for per-tenant config overrides.
 *
 * Usage:
 *   const registry = new CircuitBreakerRegistry(redis);
 *
 *   // Get a tenant breaker
 *   await registry.tenant('acme-corp').execute(() => processRequest());
 *
 *   // Get an app breaker
 *   await registry.app('acme-corp', 'app-123').execute(() => processRequest());
 *
 *   // Get an LLM provider breaker
 *   await registry.llmProvider('acme-corp', 'anthropic').execute(() => callLLM());
 *
 *   // Get a tool service breaker
 *   await registry.toolService('acme-corp', 'hotel-search').execute(() => callTool());
 *
 *   // Check before executing (for gateways that need to check without calling)
 *   const state = await registry.tenant('acme-corp').checkState('acme-corp');
 */

import { scanKeys, type RedisClient } from '@agent-platform/redis';
import { RedisCircuitBreaker } from './redis-circuit-breaker.js';
import {
  type BreakerLevel,
  type BreakerState,
  type CircuitBreakerConfig,
  type BreakerEventListener,
  BREAKER_DEFAULTS,
} from './types.js';

export interface TenantBreakerOverride {
  tenantId: string;
  level: BreakerLevel;
  config: Partial<CircuitBreakerConfig>;
}

export class CircuitBreakerRegistry {
  private readonly redis: RedisClient;
  private readonly breakers: Map<BreakerLevel, RedisCircuitBreaker> = new Map();
  private readonly tenantBreakers: Map<string, RedisCircuitBreaker> = new Map();
  private readonly globalListeners: BreakerEventListener[] = [];
  private readonly overrides: Map<string, Partial<CircuitBreakerConfig>> = new Map();

  constructor(
    redis: RedisClient,
    options?: {
      /** Override default configs per level */
      defaults?: Partial<Record<BreakerLevel, Partial<CircuitBreakerConfig>>>;
      /** Per-tenant config overrides */
      tenantOverrides?: TenantBreakerOverride[];
    },
  ) {
    this.redis = redis;

    // Create default breakers for each level
    const levels: BreakerLevel[] = ['tenant', 'app', 'llm_provider', 'tool_service'];
    for (const level of levels) {
      const config = options?.defaults?.[level];
      const breaker = new RedisCircuitBreaker(redis, level, config);
      this.breakers.set(level, breaker);
    }

    // Store per-tenant overrides
    if (options?.tenantOverrides) {
      for (const override of options.tenantOverrides) {
        const overrideKey = `${override.level}:${override.tenantId}`;
        this.overrides.set(overrideKey, override.config);
      }
    }
  }

  // ── Level-Specific Accessors ─────────────────────────────

  /**
   * Get or create a tenant-level circuit breaker.
   * Key: {tenantId}
   */
  tenant(tenantId: string): BreakerHandle {
    const breaker = this.getBreakerForTenant('tenant', tenantId);
    return new BreakerHandle(breaker, tenantId);
  }

  /**
   * Get or create an app-level circuit breaker.
   * Key: {tenantId}:{appId}
   */
  app(tenantId: string, appId: string): BreakerHandle {
    const breaker = this.getBreakerForTenant('app', tenantId);
    return new BreakerHandle(breaker, `${tenantId}:${appId}`);
  }

  /**
   * Get or create an LLM provider circuit breaker.
   * Key: {tenantId}:{provider}
   */
  llmProvider(tenantId: string, provider: string): BreakerHandle {
    const breaker = this.getBreakerForTenant('llm_provider', tenantId);
    return new BreakerHandle(breaker, `${tenantId}:${provider}`);
  }

  /**
   * Get or create a tool/service circuit breaker.
   * Key: {tenantId}:{serviceName}
   */
  toolService(tenantId: string, serviceName: string): BreakerHandle {
    const breaker = this.getBreakerForTenant('tool_service', tenantId);
    return new BreakerHandle(breaker, `${tenantId}:${serviceName}`);
  }

  // ── Bulk Operations ──────────────────────────────────────

  /**
   * Get the health of all breakers for a tenant.
   * Useful for dashboard/monitoring endpoints.
   */
  async getTenantHealth(tenantId: string): Promise<TenantHealth> {
    const tenantBreaker = this.getBreakerForTenant('tenant', tenantId);
    const tenantMetrics = await tenantBreaker.getMetrics(tenantId);

    // Scan for all app-level breakers for this tenant
    const appKeys = await this.scanBreakerKeys('app', tenantId);
    const appMetrics = await Promise.all(
      appKeys.map(async (appKey) => ({
        key: appKey,
        metrics: await this.getBreakerForTenant('app', tenantId).getMetrics(appKey),
      })),
    );

    const llmKeys = await this.scanBreakerKeys('llm_provider', tenantId);
    const llmMetrics = await Promise.all(
      llmKeys.map(async (llmKey) => ({
        key: llmKey,
        metrics: await this.getBreakerForTenant('llm_provider', tenantId).getMetrics(llmKey),
      })),
    );

    const toolKeys = await this.scanBreakerKeys('tool_service', tenantId);
    const toolMetrics = await Promise.all(
      toolKeys.map(async (toolKey) => ({
        key: toolKey,
        metrics: await this.getBreakerForTenant('tool_service', tenantId).getMetrics(toolKey),
      })),
    );

    return {
      tenantId,
      tenant: tenantMetrics,
      apps: appMetrics,
      llmProviders: llmMetrics,
      toolServices: toolMetrics,
      hasOpenCircuits:
        tenantMetrics.state === 'OPEN' ||
        appMetrics.some((m) => m.metrics.state === 'OPEN') ||
        llmMetrics.some((m) => m.metrics.state === 'OPEN') ||
        toolMetrics.some((m) => m.metrics.state === 'OPEN'),
    };
  }

  /**
   * Force-reset all breakers for a tenant. Emergency use only.
   */
  async forceResetTenant(tenantId: string, targetState: BreakerState): Promise<void> {
    const levels: BreakerLevel[] = ['tenant', 'app', 'llm_provider', 'tool_service'];

    for (const level of levels) {
      const breaker = this.getBreakerForTenant(level, tenantId);
      const keys = await this.scanBreakerKeys(level, tenantId);

      // Reset tenant-level key
      if (level === 'tenant') {
        await breaker.forceReset(tenantId, targetState);
      }

      // Reset all sub-keys for this tenant
      for (const key of keys) {
        await breaker.forceReset(key, targetState);
      }
    }
  }

  /**
   * Subscribe to events from ALL breakers in the registry.
   */
  onEvent(listener: BreakerEventListener): () => void {
    this.globalListeners.push(listener);

    // Subscribe to all existing breakers
    const unsubscribers: (() => void)[] = [];
    for (const breaker of this.breakers.values()) {
      unsubscribers.push(breaker.onEvent(listener));
    }
    for (const breaker of this.tenantBreakers.values()) {
      unsubscribers.push(breaker.onEvent(listener));
    }

    return () => {
      const idx = this.globalListeners.indexOf(listener);
      if (idx !== -1) this.globalListeners.splice(idx, 1);
      for (const unsub of unsubscribers) unsub();
    };
  }

  /**
   * Set a per-tenant config override at runtime.
   */
  setTenantOverride(
    tenantId: string,
    level: BreakerLevel,
    config: Partial<CircuitBreakerConfig>,
  ): void {
    const overrideKey = `${level}:${tenantId}`;
    this.overrides.set(overrideKey, config);
    // Invalidate cached breaker so it's recreated with new config
    this.tenantBreakers.delete(overrideKey);
  }

  // ── Internal ─────────────────────────────────────────────

  private getBreakerForTenant(level: BreakerLevel, tenantId: string): RedisCircuitBreaker {
    const overrideKey = `${level}:${tenantId}`;

    // Check if tenant has a custom override
    const override = this.overrides.get(overrideKey);
    if (override) {
      // Return or create a tenant-specific breaker
      let breaker = this.tenantBreakers.get(overrideKey);
      if (!breaker) {
        breaker = new RedisCircuitBreaker(this.redis, level, override);
        // Subscribe global listeners
        for (const listener of this.globalListeners) {
          breaker.onEvent(listener);
        }
        this.tenantBreakers.set(overrideKey, breaker);
      }
      return breaker;
    }

    // Return the default breaker for this level
    return this.breakers.get(level)!;
  }

  private async scanBreakerKeys(level: BreakerLevel, tenantId: string): Promise<string[]> {
    // Keys are hash-tagged as `breaker:{level:key}:state`. The `*` inside the
    // tag braces matches any sub-key beginning with `${tenantId}` (e.g.
    // `tenantId` for tenant-level, `tenantId:appId` for app-level, etc).
    const pattern = `breaker:{${level}:${tenantId}*}:state`;
    const keys: string[] = [];

    for await (const key of scanKeys(this.redis, pattern, 100)) {
      // Format: breaker:{level:key}:state — strip the wrapping braces and
      // the `${level}:` prefix to recover the breaker key.
      const tagOpen = key.indexOf('{');
      const tagClose = key.indexOf('}');
      if (tagOpen === -1 || tagClose === -1 || tagClose <= tagOpen) continue;
      const inside = key.slice(tagOpen + 1, tagClose);
      const levelPrefix = `${level}:`;
      if (!inside.startsWith(levelPrefix)) continue;
      keys.push(inside.slice(levelPrefix.length));
    }

    return keys;
  }
}

/**
 * BreakerHandle
 *
 * A convenience wrapper that binds a breaker to a specific key.
 * Avoids passing the key to every method call.
 */
export class BreakerHandle {
  constructor(
    private readonly breaker: RedisCircuitBreaker,
    private readonly key: string,
  ) {}

  async execute<T>(fn: () => Promise<T>): Promise<T> {
    return this.breaker.execute(this.key, fn);
  }

  async checkState() {
    return this.breaker.checkState(this.key);
  }

  async getState() {
    return this.breaker.getState(this.key);
  }

  async getMetrics() {
    return this.breaker.getMetrics(this.key);
  }

  async forceReset(targetState: BreakerState) {
    return this.breaker.forceReset(this.key, targetState);
  }
}

// ── Types ────────────────────────────────────────────────────

export interface TenantHealth {
  tenantId: string;
  tenant: Awaited<ReturnType<RedisCircuitBreaker['getMetrics']>>;
  apps: Array<{
    key: string;
    metrics: Awaited<ReturnType<RedisCircuitBreaker['getMetrics']>>;
  }>;
  llmProviders: Array<{
    key: string;
    metrics: Awaited<ReturnType<RedisCircuitBreaker['getMetrics']>>;
  }>;
  toolServices: Array<{
    key: string;
    metrics: Awaited<ReturnType<RedisCircuitBreaker['getMetrics']>>;
  }>;
  hasOpenCircuits: boolean;
}
