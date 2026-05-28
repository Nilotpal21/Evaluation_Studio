/**
 * Circuit Breaker Integration for Provider Registry
 *
 * Wraps provider execution with circuit breaker protection to prevent cascading failures.
 *
 * ## Features
 *
 * - Per-provider circuit breaker configuration
 * - Automatic fallback to alternative providers when circuit opens
 * - CloudWatch metrics for monitoring
 * - Provider-specific failure thresholds
 *
 * ## Usage
 *
 * ```typescript
 * const registry = new ProviderRegistryWithCircuitBreaker(redisClient);
 *
 * // Execute with circuit breaker protection
 * const result = await registry.executeWithProtection({
 *   tenantId: 'tenant-123',
 *   stageType: 'extraction',
 *   providerId: 'docling',
 *   input: documentBuffer,
 *   config: { model: 'v2' },
 * });
 * ```
 *
 * Reference: docs/searchai/pipelines/design/backend/03-CIRCUIT-BREAKER-IMPLEMENTATION.md
 */

import type { PipelineStageProvider } from './types.js';
import type { SearchPipelineStageType } from '@agent-platform/database';
import { ProviderRegistry } from './provider-registry.js';
import { ProviderExecutionError, ProviderNotFoundError } from './types.js';
import {
  RedisCircuitBreaker,
  type CircuitBreakerConfig,
  CircuitOpenError,
} from '@agent-platform/circuit-breaker';
import type { RedisClient } from '@agent-platform/redis';
import { createLogger } from '@abl/compiler/platform';

const logger = createLogger('provider-circuit-breaker');

// ─── Circuit Breaker Configuration ───────────────────────────────────────

/**
 * Provider-specific circuit breaker defaults.
 *
 * Different providers have different reliability characteristics:
 * - Docling: Heavy model, longer timeouts, higher failure threshold
 * - OpenAI: External API, network sensitive, lower threshold
 * - BGE-M3: Local embedding, medium threshold
 */
const PROVIDER_BREAKER_DEFAULTS: Record<string, Partial<CircuitBreakerConfig>> = {
  // Docling extraction - model loading can fail, allow more retries
  docling: {
    failureThreshold: 10,
    successThreshold: 5,
    resetTimeout: 120000, // 2 minutes
  },

  // OpenAI - external API, network sensitive
  'openai-embeddings': {
    failureThreshold: 3,
    successThreshold: 2,
    resetTimeout: 60000, // 1 minute
  },

  // BGE-M3 - local embedding service
  'bge-m3': {
    failureThreshold: 5,
    successThreshold: 3,
    resetTimeout: 90000, // 90 seconds
  },

  // Default for all other providers
  default: {
    failureThreshold: 5,
    successThreshold: 2,
    resetTimeout: 60000, // 1 minute
  },
};

// ─── Types ───────────────────────────────────────────────────────────────

/**
 * Parameters for protected provider execution.
 */
export interface ProtectedExecutionParams<TInput = unknown, TConfig = unknown> {
  /** Tenant ID for multi-tenancy isolation */
  tenantId: string;
  /** Stage type (extraction, enrichment, etc.) */
  stageType: SearchPipelineStageType;
  /** Provider ID to execute */
  providerId: string;
  /** Input data */
  input: TInput;
  /** Provider configuration */
  config: TConfig;
  /** Optional fallback provider IDs (tried in order if primary fails) */
  fallbackProviders?: string[];
}

/**
 * Result of protected provider execution.
 */
export interface ProtectedExecutionResult<TOutput = unknown> {
  /** Whether execution succeeded */
  success: boolean;
  /** Output data (if success) */
  output?: TOutput;
  /** Error message (if failure) */
  error?: string;
  /** Provider that was actually used (may be fallback) */
  providerId: string;
  /** Whether circuit breaker was triggered */
  circuitOpen: boolean;
  /** Whether a fallback provider was used */
  usedFallback: boolean;
}

// ─── Provider Registry with Circuit Breaker ──────────────────────────────

/**
 * Provider registry with circuit breaker protection.
 *
 * Wraps ProviderRegistry with per-provider circuit breakers to prevent cascading failures.
 */
export class ProviderRegistryWithCircuitBreaker {
  private readonly registry: ProviderRegistry;
  private readonly redis: RedisClient;
  private readonly breakers = new Map<string, RedisCircuitBreaker>();
  private static readonly MAX_BREAKERS = 500;

  constructor(redis: RedisClient) {
    this.registry = ProviderRegistry.getInstance();
    this.redis = redis;
  }

  /**
   * Get or create circuit breaker for a provider.
   *
   * Circuit breaker key format: `provider:{tenantId}:{providerId}`
   *
   * @param tenantId - Tenant ID
   * @param providerId - Provider ID
   * @returns Circuit breaker instance
   */
  private getCircuitBreaker(tenantId: string, providerId: string): RedisCircuitBreaker {
    const key = `${tenantId}:${providerId}`;

    if (!this.breakers.has(key)) {
      // Get provider-specific config or default
      const providerConfig =
        PROVIDER_BREAKER_DEFAULTS[providerId] || PROVIDER_BREAKER_DEFAULTS.default;

      const breaker = new RedisCircuitBreaker(
        this.redis,
        'tool_service', // Use tool_service level for provider circuits
        providerConfig,
      );

      // Evict oldest entry if at capacity
      if (this.breakers.size >= ProviderRegistryWithCircuitBreaker.MAX_BREAKERS) {
        const oldest = this.breakers.keys().next().value;
        if (oldest !== undefined) this.breakers.delete(oldest);
      }
      this.breakers.set(key, breaker);
    }

    return this.breakers.get(key)!;
  }

  /**
   * Execute provider with circuit breaker protection.
   *
   * Algorithm:
   * 1. Check primary provider circuit breaker state
   * 2. If OPEN, try fallback providers (if configured)
   * 3. Execute provider through circuit breaker
   * 4. On success, return result
   * 5. On failure, try next fallback provider
   * 6. If all providers fail, return error
   *
   * @param params - Execution parameters
   * @returns Execution result
   *
   * @example
   * ```typescript
   * const result = await registry.executeWithProtection({
   *   tenantId: 'tenant-123',
   *   stageType: 'extraction',
   *   providerId: 'docling',
   *   input: { buffer, metadata },
   *   config: { model: 'v2' },
   *   fallbackProviders: ['tesseract-ocr'], // Fallback if Docling fails
   * });
   *
   * if (result.success) {
   *   console.log('Extracted text:', result.output);
   *   if (result.usedFallback) {
   *     console.log('Used fallback provider:', result.providerId);
   *   }
   * }
   * ```
   */
  async executeWithProtection<TInput = unknown, TOutput = unknown, TConfig = unknown>(
    params: ProtectedExecutionParams<TInput, TConfig>,
  ): Promise<ProtectedExecutionResult<TOutput>> {
    const { tenantId, stageType, providerId, input, config, fallbackProviders = [] } = params;

    const startTime = Date.now();
    const providersToTry = [providerId, ...fallbackProviders];

    logger.info('Starting protected provider execution', {
      tenantId,
      stageType,
      providerId,
      fallbackProviders,
    });

    // Try each provider in order (primary first, then fallbacks)
    for (let i = 0; i < providersToTry.length; i++) {
      const currentProviderId = providersToTry[i];
      const isUsingFallback = i > 0;

      try {
        // Get provider
        const provider = this.registry.get(stageType, currentProviderId);

        if (!provider) {
          logger.warn('Provider not found, trying next', {
            tenantId,
            stageType,
            providerId: currentProviderId,
          });
          continue;
        }

        // Get circuit breaker for this provider
        const breaker = this.getCircuitBreaker(tenantId, currentProviderId);

        // Execute with circuit breaker protection
        // Key includes tenantId for per-tenant isolation
        const breakerKey = `${tenantId}:${currentProviderId}`;
        const output = await breaker.execute(breakerKey, async () => {
          return await provider.execute(input, config);
        });

        const duration = Date.now() - startTime;

        logger.info('Protected execution succeeded', {
          tenantId,
          stageType,
          providerId: currentProviderId,
          usedFallback: isUsingFallback,
          duration,
        });

        return {
          success: true,
          output: output as TOutput,
          providerId: currentProviderId,
          circuitOpen: false,
          usedFallback: isUsingFallback,
        };
      } catch (error) {
        const duration = Date.now() - startTime;
        const isCircuitOpen = error instanceof CircuitOpenError;

        logger.warn('Provider execution failed', {
          tenantId,
          stageType,
          providerId: currentProviderId,
          error: error instanceof Error ? error.message : String(error),
          circuitOpen: isCircuitOpen,
          hasMoreFallbacks: i < providersToTry.length - 1,
          duration,
        });

        // If this is the last provider, return error
        if (i === providersToTry.length - 1) {
          return {
            success: false,
            error: error instanceof Error ? error.message : String(error),
            providerId: currentProviderId,
            circuitOpen: isCircuitOpen,
            usedFallback: isUsingFallback,
          };
        }

        // Otherwise, continue to next fallback provider
        logger.info('Trying fallback provider', {
          tenantId,
          stageType,
          nextProviderId: providersToTry[i + 1],
        });
      }
    }

    // Should never reach here (loop always returns), but TypeScript needs it
    return {
      success: false,
      error: 'No providers available',
      providerId,
      circuitOpen: false,
      usedFallback: false,
    };
  }

  /**
   * Get circuit breaker state for a provider.
   *
   * @param tenantId - Tenant ID
   * @param providerId - Provider ID
   * @returns Circuit breaker state
   */
  async getCircuitState(
    tenantId: string,
    providerId: string,
  ): Promise<'CLOSED' | 'OPEN' | 'HALF_OPEN'> {
    const breaker = this.getCircuitBreaker(tenantId, providerId);
    const key = `${tenantId}:${providerId}`;
    return await breaker.getState(key);
  }

  /**
   * Manually reset circuit breaker for a provider.
   *
   * Use this for manual intervention when a provider is back online.
   *
   * @param tenantId - Tenant ID
   * @param providerId - Provider ID
   */
  async resetCircuit(tenantId: string, providerId: string): Promise<void> {
    const breaker = this.getCircuitBreaker(tenantId, providerId);
    const key = `${tenantId}:${providerId}`;
    await breaker.forceReset(key, 'CLOSED');

    logger.info('Circuit breaker manually reset', {
      tenantId,
      providerId,
    });
  }

  /**
   * Get underlying provider registry (for registration, listing, etc.).
   *
   * @returns ProviderRegistry instance
   */
  getRegistry(): ProviderRegistry {
    return this.registry;
  }
}
