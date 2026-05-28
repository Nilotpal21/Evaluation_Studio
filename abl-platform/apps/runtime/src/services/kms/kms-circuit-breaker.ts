/**
 * KMS Circuit Breaker
 *
 * Wraps KMS provider calls with the existing HybridCircuitBreakerRegistry.
 * Opens the circuit on repeated KMS failures to prevent cascading latency.
 *
 * Circuit states:
 *   CLOSED  → Normal operation, KMS calls pass through
 *   OPEN    → KMS calls fail-fast, use fail-closed or graceful-degradation policy
 *   HALF_OPEN → Test probe: allow one call through to check recovery
 */

import { createLogger } from '@abl/compiler/platform';
import type { KMSProvider } from '@agent-platform/database/kms';

const log = createLogger('kms-circuit-breaker');

// =============================================================================
// KMS CIRCUIT BREAKER WRAPPER
// =============================================================================

export class KMSCircuitBreakerWrapper {
  private breakerName: string;

  constructor(
    private readonly provider: KMSProvider,
    private readonly tenantId: string,
  ) {
    this.breakerName = `kms:${provider.providerType}:${tenantId}`;
  }

  /**
   * Execute a KMS operation through the circuit breaker.
   */
  async execute<T>(operation: string, fn: () => Promise<T>): Promise<T> {
    const start = Date.now();

    try {
      const { getCircuitBreakerRegistry } = await import('../resilience/hybrid-cb-registry.js');
      const registry = getCircuitBreakerRegistry();
      const breaker = registry.getBreaker(this.breakerName, this.tenantId);

      // Check if circuit is open (fail-fast)
      if (breaker.isOpen()) {
        throw new Error(`KMS circuit breaker is open for ${this.breakerName}`);
      }

      const result = await fn();
      await breaker.recordSuccess();

      log.debug('KMS operation succeeded', {
        operation,
        provider: this.provider.providerType,
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
        recordCBPersistenceFailure('kms', 'record_failure');
      }

      log.warn('KMS operation failed', {
        operation,
        provider: this.provider.providerType,
        tenantId: this.tenantId,
        durationMs: Date.now() - start,
        error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
  }
}
