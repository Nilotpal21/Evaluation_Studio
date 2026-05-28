/**
 * Circuit Breaker Registry Singleton
 *
 * Provides a lazily-initialized Redis-backed CircuitBreakerRegistry
 * for the MappingSuggestionService. Separated into its own module
 * to support clean mocking in tests.
 */

import {
  CircuitBreakerRegistry,
  type BreakerState,
  type BreakerEvent,
} from '@agent-platform/circuit-breaker';
import { resolveRedisOptionsFromEnv, createRedisConnection } from '@agent-platform/redis';
import { createLogger } from '@abl/compiler/platform';
import type { RedisClient } from '@agent-platform/redis';

const logger = createLogger('mapping-suggestion');

let _registry: CircuitBreakerRegistry | null = null;
let _redisHandle: { client: RedisClient; disconnect: () => Promise<void> } | null = null;

/** Reset timeout for open circuit (5 minutes) */
const CIRCUIT_RESET_TIMEOUT = 300_000;

/**
 * Get or create the CircuitBreakerRegistry singleton.
 * Lazily initializes Redis connection on first call.
 */
export function getCircuitBreakerRegistry(): CircuitBreakerRegistry | null {
  if (_registry) return _registry;

  const redisOpts = resolveRedisOptionsFromEnv();
  if (!redisOpts) {
    logger.warn('Redis not available, circuit breaker operating without Redis backing');
    return null;
  }

  try {
    const handle = createRedisConnection(redisOpts);
    _redisHandle = { client: handle.client, disconnect: handle.disconnect };

    _registry = new CircuitBreakerRegistry(handle.client, {
      defaults: {
        llm_provider: {
          failureThreshold: 3,
          resetTimeout: CIRCUIT_RESET_TIMEOUT,
          successThreshold: 2,
          monitorWindow: 30_000,
          halfOpenMaxConcurrent: 1,
          failureRateThreshold: 30,
          minimumRequestCount: 3,
        },
      },
    });

    // Register event listener for state change logging and TraceEvents
    _registry.onEvent((event: BreakerEvent) => {
      if ('from' in event && 'to' in event) {
        // BreakerStateChangeEvent
        const stateChangeEvent = event as {
          from: BreakerState;
          to: BreakerState;
          key: string;
          failureCount: number;
          totalCount: number;
          failureRate: number;
        };

        const keyParts = stateChangeEvent.key.split(':');
        const tenantId = keyParts[0] || 'unknown';
        const provider = keyParts[1] || 'unknown';

        if (stateChangeEvent.to === 'OPEN') {
          logger.warn('LLM circuit breaker opened', {
            provider,
            tenantId,
            from: stateChangeEvent.from,
            to: stateChangeEvent.to,
            failureCount: stateChangeEvent.failureCount,
            resetTimeout: CIRCUIT_RESET_TIMEOUT,
          });

          // Emit TraceEvent for circuit breaker opened
          // TODO: Wire TraceStore when pattern is established (see schema-discovery-worker.ts)
          logger.info('TraceEvent: llm_circuit_breaker_opened', {
            event: 'llm_circuit_breaker_opened',
            provider,
            tenantId,
            failureCount: stateChangeEvent.failureCount,
            resetTime: Date.now() + CIRCUIT_RESET_TIMEOUT,
          });
        } else if (stateChangeEvent.to === 'HALF_OPEN') {
          logger.info('LLM circuit breaker half-open', {
            provider,
            tenantId,
            from: stateChangeEvent.from,
            to: stateChangeEvent.to,
          });
        } else if (stateChangeEvent.to === 'CLOSED') {
          logger.info('LLM circuit breaker closed', {
            provider,
            tenantId,
            from: stateChangeEvent.from,
            to: stateChangeEvent.to,
          });
        }
      }
    });

    return _registry;
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.error('Failed to initialize circuit breaker registry', { error: errorMessage });
    return null;
  }
}
