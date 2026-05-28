/**
 * Tool Resilience Factory
 *
 * Implements ResilienceFactory wrapping HybridCircuitBreakerRegistry.
 * Provides tool-scoped circuit breakers with `tool:` prefix namespace
 * and in-memory rate limiters.
 */

import type { ResilienceFactory, ICircuitBreaker, IRateLimiter } from '@abl/compiler/platform';
import {
  getCircuitBreakerRegistry,
  type HybridCircuitBreakerRegistry,
} from './hybrid-cb-registry.js';
import { getHybridRateLimiter } from './hybrid-rate-limiter.js';

/**
 * Adapter: wraps HybridRateLimiter (Redis+memory) into the IRateLimiter interface.
 * Uses `check()` under the hood — waits for the reset window if rate limited.
 *
 * The tenant+tool combination is encoded into a composite tenantId key so the
 * underlying HybridRateLimiter (which uses `rl:{tenantId}:{operation}`) produces
 * a unique Redis key per tool per tenant.
 */
class HybridRateLimiterAdapter implements IRateLimiter {
  /** Composite key: `{tenantId}:tool:{name}` — ensures per-tool isolation */
  private readonly compositeKey: string;
  private readonly requestsPerMinute: number;

  constructor(tenantId: string, toolName: string, requestsPerMinute: number) {
    // URL-encode components to prevent key collisions from names containing ':'
    this.compositeKey = `${encodeURIComponent(tenantId)}:tool:${encodeURIComponent(toolName)}`;
    this.requestsPerMinute = requestsPerMinute;
  }

  async acquire(): Promise<void> {
    const limiter = getHybridRateLimiter();
    const result = await limiter.check(this.compositeKey, 'tool_call', this.requestsPerMinute);

    if (!result.allowed && result.resetMs > 0) {
      // Wait for the rate limit window to reset, capped at 10s
      const waitMs = Math.min(result.resetMs, 10_000);
      await new Promise((resolve) => setTimeout(resolve, waitMs));

      // Re-check after sleep — another caller may have consumed the window
      const recheck = await limiter.check(this.compositeKey, 'tool_call', this.requestsPerMinute);
      if (!recheck.allowed) {
        throw new Error(
          `Rate limit exceeded for ${this.compositeKey} (${this.requestsPerMinute}/min)`,
        );
      }
    }
  }
}

/**
 * Adapter: wraps HybridCircuitBreakerRegistry's CircuitBreaker to ICircuitBreaker.
 * The runtime's CircuitBreaker has async recordSuccess/recordFailure which is
 * compatible with ICircuitBreaker's `void | Promise<void>`.
 */
class CircuitBreakerAdapter implements ICircuitBreaker {
  constructor(private breaker: ReturnType<HybridCircuitBreakerRegistry['getBreaker']>) {}

  isOpen(): boolean | Promise<boolean> {
    return this.breaker.isOpen();
  }

  recordSuccess(): void | Promise<void> {
    return this.breaker.recordSuccess();
  }

  recordFailure(): void | Promise<void> {
    return this.breaker.recordFailure();
  }

  getState(): ('closed' | 'open' | 'half-open') | Promise<'closed' | 'open' | 'half-open'> {
    return this.breaker.getState();
  }
}

/**
 * Create a ResilienceFactory backed by HybridCircuitBreakerRegistry.
 * Circuit breakers use `tool:{name}` prefix for namespace separation.
 */
export function createToolResilienceFactory(tenantId?: string): ResilienceFactory {
  const registry = getCircuitBreakerRegistry();

  return {
    createCircuitBreaker(
      name: string,
      config: { threshold: number; resetMs: number },
    ): ICircuitBreaker {
      const prefixedName = tenantId ? `tool:${tenantId}:${name}` : `tool:${name}`;
      const breaker = registry.getBreaker(prefixedName, tenantId);
      return new CircuitBreakerAdapter(breaker);
    },

    createRateLimiter(name: string, requestsPerMinute: number): IRateLimiter {
      return new HybridRateLimiterAdapter(tenantId ?? '_no_tenant_', name, requestsPerMinute);
    },
  };
}
