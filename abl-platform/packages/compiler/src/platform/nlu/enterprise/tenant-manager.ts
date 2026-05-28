/**
 * NLU Tenant Manager
 *
 * Manages per-tenant NLUEngine instances with LRU eviction.
 * Each tenant gets its own config overrides, cache keys, and metrics.
 */

import type { LLMClient } from '../../constructs/types.js';
import type { NLUConfig } from '../config.js';
import type { PipelineHooks } from '../pipeline.js';
import type { NLUMetricsCollector } from '../types.js';
import type { NLUEnterprisePorts } from './interfaces.js';
import { NLUEngine } from '../engine.js';
import { NLUResultCache } from './nlu-cache.js';
import { NLUCircuitBreaker } from './circuit-breaker.js';
import { createPIIGuardHook } from './pii-guard.js';
import { createAuditHook } from './nlu-audit.js';
import { InMemoryMetricsCollector } from '../metrics.js';

// =============================================================================
// LRU ENTRY
// =============================================================================

interface TenantEntry {
  engine: NLUEngine;
  config: NLUConfig;
  metrics: InMemoryMetricsCollector;
  cache: NLUResultCache;
  hooks: PipelineHooks;
  lastAccessTime: number;
}

// =============================================================================
// TENANT MANAGER
// =============================================================================

export class NLUTenantManager {
  private tenants = new Map<string, TenantEntry>();
  private tenantOverrides = new Map<string, Partial<NLUConfig>>();
  private globalConfig: NLUConfig;
  private maxTenants: number;
  private ports: NLUEnterprisePorts;

  constructor(
    globalConfig: NLUConfig,
    options?: {
      maxTenants?: number;
      ports?: NLUEnterprisePorts;
    },
  ) {
    this.globalConfig = globalConfig;
    this.maxTenants = options?.maxTenants ?? 100;
    this.ports = options?.ports ?? {};
  }

  /**
   * Get or create an NLU engine for a tenant.
   */
  getEngine(tenantId: string, llmClient: LLMClient): NLUEngine {
    const existing = this.tenants.get(tenantId);
    if (existing) {
      existing.lastAccessTime = Date.now();
      return existing.engine;
    }

    // Build tenant-specific config
    const tenantConfig = this.buildTenantConfig(tenantId);

    // Create tenant-scoped components
    const metrics = new InMemoryMetricsCollector();
    const cache = new NLUResultCache(tenantConfig.cache, {
      tenantId,
      encryption: this.ports.encryption,
    });
    const circuitBreaker = new NLUCircuitBreaker(tenantConfig.circuitBreaker);

    // Build hooks
    const hooks = this.buildHooks(tenantId, tenantConfig, cache, circuitBreaker);

    // Create engine
    const engine = NLUEngine.fromLLMClient(llmClient);

    const entry: TenantEntry = {
      engine,
      config: tenantConfig,
      metrics,
      cache,
      hooks,
      lastAccessTime: Date.now(),
    };

    this.tenants.set(tenantId, entry);

    // Evict LRU if over limit
    if (this.tenants.size > this.maxTenants) {
      this.evictLRU();
    }

    return engine;
  }

  /**
   * Set config overrides for a specific tenant.
   * Takes effect on next getEngine call.
   */
  setTenantOverride(tenantId: string, overrides: Partial<NLUConfig>): void {
    this.tenantOverrides.set(tenantId, overrides);
    // Invalidate existing engine so it gets recreated with new config
    this.tenants.delete(tenantId);
  }

  /**
   * Get the pipeline hooks for a tenant (for use with NLUTaskPipeline).
   */
  getHooks(tenantId: string): PipelineHooks | undefined {
    return this.tenants.get(tenantId)?.hooks;
  }

  /**
   * Get metrics collector for a specific tenant.
   */
  getMetricsForTenant(tenantId: string): NLUMetricsCollector | undefined {
    return this.tenants.get(tenantId)?.metrics;
  }

  /**
   * Get cache for a specific tenant.
   */
  getCacheForTenant(tenantId: string): NLUResultCache | undefined {
    return this.tenants.get(tenantId)?.cache;
  }

  /**
   * Invalidate cache for a tenant.
   */
  invalidateTenantCache(tenantId: string): void {
    this.tenants.get(tenantId)?.cache.invalidateAll();
  }

  /**
   * Remove a tenant's engine and resources.
   */
  removeTenant(tenantId: string): void {
    this.tenants.delete(tenantId);
    this.tenantOverrides.delete(tenantId);
  }

  /**
   * Get all active tenant IDs.
   */
  getActiveTenants(): string[] {
    return [...this.tenants.keys()];
  }

  /**
   * Get the number of active tenants.
   */
  get size(): number {
    return this.tenants.size;
  }

  // =========================================================================
  // PRIVATE
  // =========================================================================

  private buildTenantConfig(tenantId: string): NLUConfig {
    const overrides = this.tenantOverrides.get(tenantId);
    if (!overrides) return { ...this.globalConfig };

    // Shallow merge top-level, deep merge nested objects
    const config = { ...this.globalConfig };
    for (const [key, value] of Object.entries(overrides)) {
      if (
        value !== undefined &&
        typeof value === 'object' &&
        value !== null &&
        !Array.isArray(value)
      ) {
        (config as Record<string, unknown>)[key] = {
          ...((config as Record<string, unknown>)[key] as object),
          ...value,
        };
      } else if (value !== undefined) {
        (config as Record<string, unknown>)[key] = value;
      }
    }
    return config;
  }

  private buildHooks(
    tenantId: string,
    config: NLUConfig,
    cache: NLUResultCache,
    circuitBreaker: NLUCircuitBreaker,
  ): PipelineHooks {
    const hooks: PipelineHooks = {};

    // PII guard
    if (config.piiRedaction.enabled) {
      hooks.beforeExecute = createPIIGuardHook(config);
    }

    // Cache
    if (config.cache.enabled) {
      hooks.checkCache = (ctx, task) => cache.checkCache(ctx, task);
      hooks.storeCache = (ctx, task, result) => cache.storeCache(ctx, task, result);
    }

    // Circuit breaker
    if (config.circuitBreaker.enabled) {
      hooks.wrapLLMCall = <T>(layerName: string, fn: () => Promise<T>) =>
        circuitBreaker.wrapLLMCall(layerName, fn);
    }

    // Audit
    if (config.audit.enabled && this.ports.audit) {
      hooks.afterExecute = createAuditHook(config, this.ports.audit, tenantId);
    }

    return hooks;
  }

  private evictLRU(): void {
    let oldestKey: string | null = null;
    let oldestTime = Infinity;

    for (const [key, entry] of this.tenants) {
      if (entry.lastAccessTime < oldestTime) {
        oldestTime = entry.lastAccessTime;
        oldestKey = key;
      }
    }

    if (oldestKey) {
      this.tenants.delete(oldestKey);
    }
  }
}
