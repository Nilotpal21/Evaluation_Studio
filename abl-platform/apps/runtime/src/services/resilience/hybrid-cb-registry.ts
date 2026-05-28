/**
 * Hybrid Circuit Breaker Registry
 *
 * Redis primary + in-memory fallback. Auto-recovery timer (30s ping).
 * Loads tenant-specific thresholds via TenantConfigService.
 */

import {
  CircuitBreaker,
  CircuitBreakerRegistry,
  InMemoryCircuitBreakerStore,
  type CircuitBreakerConfig,
  type CircuitBreakerStore,
} from './circuit-breaker.js';
import { RedisCircuitBreakerStoreAdapter } from './redis-cb-store-adapter.js';
import { getRedisClient, isRedisAvailable } from '../redis/redis-client.js';
import { getTenantCBConfig } from './tenant-cb-config.js';
import { setCircuitBreakerState } from '../../observability/metrics.js';
import { createLogger } from '@abl/compiler/platform';

const log = createLogger('hybrid-cb-registry');

/** Parse an integer from an env var, returning the fallback on missing/NaN */
function safeParseInt(val: string | undefined, fallback: number): number {
  if (!val) return fallback;
  const parsed = parseInt(val, 10);
  return Number.isNaN(parsed) ? fallback : parsed;
}

/** Redis recovery check interval in ms (default: 30 seconds) */
const CB_REDIS_RECOVERY_INTERVAL_MS = safeParseInt(
  process.env.CB_REDIS_RECOVERY_INTERVAL_MS,
  30_000,
);

let instance: HybridCircuitBreakerRegistry | null = null;

export class HybridCircuitBreakerRegistry {
  private redisStore: CircuitBreakerStore | null = null;
  private memoryStore: InMemoryCircuitBreakerStore;
  private registry: CircuitBreakerRegistry;
  private recoveryTimer: ReturnType<typeof setInterval> | null = null;
  private usingRedis = false;

  /** OTEL metrics listener — kept as field so it can be re-registered on recovery */
  private readonly metricsListener = (
    event: import('./circuit-breaker.js').CircuitBreakerEvent,
  ) => {
    const stateMap: Record<string, number> = {
      circuit_closed: 0,
      circuit_half_open: 1,
      circuit_opened: 2,
    };
    const numericState = stateMap[event.type];
    if (numericState !== undefined) {
      setCircuitBreakerState(event.breakerName, numericState);
    }
  };

  constructor() {
    this.memoryStore = new InMemoryCircuitBreakerStore();

    // Try Redis first
    const redis = getRedisClient();
    if (redis && isRedisAvailable()) {
      this.redisStore = new RedisCircuitBreakerStoreAdapter(redis);
      this.registry = new CircuitBreakerRegistry(this.redisStore);
      this.usingRedis = true;
      log.info('Using Redis-backed circuit breaker store');
    } else {
      this.registry = new CircuitBreakerRegistry(this.memoryStore);
      log.info('Using in-memory circuit breaker store (Redis unavailable)');
      this.startRecoveryTimer();
    }

    // Report circuit breaker state transitions to OTEL metrics
    this.registry.onAnyStateChange(this.metricsListener);
  }

  /**
   * Get or create a circuit breaker, optionally with tenant-specific thresholds.
   */
  getBreaker(name: string, tenantId?: string): CircuitBreaker {
    let config: Partial<CircuitBreakerConfig> & { name: string } = { name };

    if (tenantId) {
      const tenantConfig = getTenantCBConfig(tenantId);
      if (tenantConfig) {
        config = { ...config, ...tenantConfig };
      }
    }

    return this.registry.getBreaker(config);
  }

  /** Get the underlying registry for direct access */
  getRegistry(): CircuitBreakerRegistry {
    return this.registry;
  }

  /** Check if using Redis or in-memory */
  isUsingRedis(): boolean {
    return this.usingRedis;
  }

  /**
   * Auto-recovery: periodically check if Redis becomes available.
   * When it does, swap to Redis store.
   */
  private startRecoveryTimer(): void {
    if (this.recoveryTimer) return; // Already running

    this.recoveryTimer = setInterval(() => {
      const redis = getRedisClient();
      if (redis && isRedisAvailable()) {
        log.info('Redis recovered — switching to Redis store');
        this.redisStore = new RedisCircuitBreakerStoreAdapter(redis);
        this.registry = new CircuitBreakerRegistry(this.redisStore);
        // Re-register metrics listener on the new registry
        this.registry.onAnyStateChange(this.metricsListener);
        this.usingRedis = true;
        this.stopRecoveryTimer();
      }
    }, CB_REDIS_RECOVERY_INTERVAL_MS);
    this.recoveryTimer.unref();
  }

  private stopRecoveryTimer(): void {
    if (this.recoveryTimer) {
      clearInterval(this.recoveryTimer);
      this.recoveryTimer = null;
    }
  }

  /** Shutdown: stop recovery timer */
  shutdown(): void {
    this.stopRecoveryTimer();
  }
}

/**
 * Get the singleton hybrid circuit breaker registry.
 */
export function getCircuitBreakerRegistry(): HybridCircuitBreakerRegistry {
  if (!instance) {
    instance = new HybridCircuitBreakerRegistry();
  }
  return instance;
}

/**
 * Reset singleton (for testing).
 */
export function resetCircuitBreakerRegistry(): void {
  if (instance) {
    instance.shutdown();
    instance = null;
  }
}
