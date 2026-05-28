/**
 * SearchAI Circuit Breaker
 *
 * Wraps SearchAI service calls with the HybridCircuitBreakerRegistry.
 * Opens the circuit on repeated SearchAI failures to prevent cascading latency
 * when the SearchAI service is down or degraded.
 *
 * Circuit states:
 *   CLOSED    -> Normal operation, SearchAI calls pass through
 *   OPEN      -> SearchAI calls fail-fast, no HTTP attempt
 *   HALF_OPEN -> Test probe: allow one call through to check recovery
 */

import { createLogger } from '@abl/compiler/platform';

const log = createLogger('search-ai-circuit-breaker');

// =============================================================================
// SEARCH-AI CIRCUIT BREAKER WRAPPER
// =============================================================================

export class SearchAICircuitBreaker {
  private readonly breakerName: string;
  private readonly tenantId: string;

  constructor(tenantId: string) {
    this.tenantId = tenantId;
    this.breakerName = `search-ai:${tenantId}`;
  }

  /**
   * Execute a SearchAI operation through the circuit breaker.
   * Fails fast when the circuit is open (service known to be down).
   */
  async execute<T>(operation: string, fn: () => Promise<T>): Promise<T> {
    const start = Date.now();

    try {
      const { getCircuitBreakerRegistry } = await import('../resilience/hybrid-cb-registry.js');
      const registry = getCircuitBreakerRegistry();
      const breaker = registry.getBreaker(this.breakerName, this.tenantId);

      // Check if circuit is open (fail-fast)
      if (breaker.isOpen()) {
        log.warn('Search-AI circuit breaker is open, failing fast', {
          tenantId: this.tenantId,
          operation,
        });
        throw new Error(`Search-AI circuit breaker is open for tenant ${this.tenantId}`);
      }

      const result = await fn();
      await breaker.recordSuccess();

      log.debug('Search-AI operation succeeded', {
        operation,
        tenantId: this.tenantId,
        durationMs: Date.now() - start,
      });

      return result;
    } catch (err) {
      // Record failure if we have a breaker reference
      try {
        const { getCircuitBreakerRegistry } = await import('../resilience/hybrid-cb-registry.js');
        const registry = getCircuitBreakerRegistry();
        const breaker = registry.getBreaker(this.breakerName, this.tenantId);
        await breaker.recordFailure(err instanceof Error ? err : new Error(String(err)));
      } catch (breakerErr) {
        log.warn('Failed to persist circuit breaker state', {
          breakerName: this.breakerName,
          error: breakerErr instanceof Error ? breakerErr.message : String(breakerErr),
        });
        const { recordCBPersistenceFailure } = await import('../../observability/metrics.js');
        recordCBPersistenceFailure('search-ai', 'record_failure');
      }

      log.warn('Search-AI operation failed', {
        operation,
        tenantId: this.tenantId,
        durationMs: Date.now() - start,
        error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
  }
}
