/**
 * Guardrail Provider Registry
 *
 * Central registry that manages guardrail model providers by name
 * and applies circuit breaker protection to each provider.
 *
 * Features:
 * - Auto-registers the built-in PII provider on construction
 * - Register/unregister providers dynamically
 * - Per-provider circuit breaker prevents cascading failures
 * - Evaluate requests through providers with automatic fault tolerance
 *
 * This is the compiler-package implementation with in-memory circuit breakers.
 * The runtime package (Phase 4) will add Redis-backed state and
 * MongoDB config loading for distributed operation.
 */

import type {
  GuardrailModelProvider,
  GuardrailEvalRequest,
  GuardrailEvalResult,
  ProviderRuntimeConfig,
  RuntimeProviderOverride,
} from './provider.js';
import { isRuntimeOverrideableGuardrailProvider } from './provider.js';
import { CircuitBreaker } from './circuit-breaker.js';
import type { CircuitBreakerConfig } from './circuit-breaker.js';
import { BuiltinPIIProvider } from './providers/builtin-pii.js';
import { createLogger } from '../logger.js';

const log = createLogger('guardrail-provider-registry');

const MAX_REGISTRY_SIZE = 100;
const REGISTRY_TTL_MS = 5 * 60 * 1000; // 5 minutes for non-permanent providers

interface ProviderEntry {
  provider: GuardrailModelProvider;
  registeredAt: number;
  permanent?: boolean;
  runtimeConfig?: ProviderRuntimeConfig;
}

interface RegisterProviderOptions {
  permanent?: boolean;
  runtimeConfig?: ProviderRuntimeConfig;
}

function mergeProviderRuntimeConfig(
  base?: ProviderRuntimeConfig,
  override?: ProviderRuntimeConfig,
): ProviderRuntimeConfig | undefined {
  if (!base) return override;
  if (!override) return base;
  return {
    ...base,
    ...override,
    circuitBreaker:
      base.circuitBreaker || override.circuitBreaker
        ? { ...base.circuitBreaker, ...override.circuitBreaker }
        : undefined,
    retry: base.retry || override.retry ? { ...base.retry, ...override.retry } : undefined,
  };
}

async function waitForBackoff(delayMs: number): Promise<void> {
  if (delayMs <= 0) {
    return;
  }
  await new Promise((resolve) => setTimeout(resolve, delayMs));
}

export class GuardrailProviderRegistry {
  private readonly providers = new Map<string, ProviderEntry>();
  private readonly breakers = new Map<string, CircuitBreaker>();
  private readonly circuitBreakerConfig: Partial<CircuitBreakerConfig> | undefined;

  constructor(circuitBreakerConfig?: Partial<CircuitBreakerConfig>) {
    this.circuitBreakerConfig = circuitBreakerConfig;
    // Auto-register built-in PII provider as permanent (immune to TTL eviction)
    this.register(new BuiltinPIIProvider(), { permanent: true });
  }

  /** Register a provider. Creates a circuit breaker if one does not exist for this name. */
  register(provider: GuardrailModelProvider, options?: RegisterProviderOptions): void {
    // Evict oldest entry if at capacity (skip if updating existing)
    if (!this.providers.has(provider.name) && this.providers.size >= MAX_REGISTRY_SIZE) {
      const oldest = this.findOldestEntry();
      if (oldest) {
        this.unregister(oldest);
      }
    }
    const existing = this.providers.get(provider.name);
    this.providers.set(provider.name, {
      provider,
      registeredAt: Date.now(),
      permanent: options?.permanent ?? existing?.permanent ?? false,
      runtimeConfig: options?.runtimeConfig ?? existing?.runtimeConfig,
    });
    if (!this.breakers.has(provider.name)) {
      this.breakers.set(provider.name, new CircuitBreaker(this.circuitBreakerConfig));
    }
  }

  private findOldestEntry(): string | undefined {
    let oldestKey: string | undefined;
    let oldestTime = Infinity;
    for (const [key, entry] of this.providers) {
      if (!entry.permanent && entry.registeredAt < oldestTime) {
        oldestTime = entry.registeredAt;
        oldestKey = key;
      }
    }
    return oldestKey;
  }

  /** Unregister a provider and its circuit breaker. */
  unregister(name: string): void {
    this.providers.delete(name);
    this.breakers.delete(name);
  }

  /** Retrieve a provider by name. Returns undefined if not found or expired. */
  get(name: string): GuardrailModelProvider | undefined {
    const entry = this.providers.get(name);
    if (!entry) return undefined;
    if (!entry.permanent && Date.now() - entry.registeredAt > REGISTRY_TTL_MS) {
      this.unregister(name);
      return undefined;
    }
    return entry.provider;
  }

  /** Retrieve runtime defaults/resilience metadata registered with a provider. */
  getRuntimeConfig(name: string): ProviderRuntimeConfig | undefined {
    const provider = this.get(name);
    if (!provider) return undefined;
    return this.providers.get(name)?.runtimeConfig;
  }

  /** List all registered provider names (excluding expired). */
  listProviders(): string[] {
    const now = Date.now();
    const expired: string[] = [];
    const active: string[] = [];
    for (const [key, entry] of this.providers) {
      if (!entry.permanent && now - entry.registeredAt > REGISTRY_TTL_MS) {
        expired.push(key);
      } else {
        active.push(key);
      }
    }
    for (const key of expired) this.unregister(key);
    return active;
  }

  /**
   * Evaluate a request through a named provider with circuit breaker protection.
   *
   * Returns undefined if the provider is not registered.
   * Returns a safe fallback result if the circuit breaker is open or the provider throws.
   * On success, records success on the circuit breaker.
   * On failure, records failure on the circuit breaker and returns a safe fallback.
   */
  async evaluate(
    providerName: string,
    request: GuardrailEvalRequest,
    options?: {
      failMode?: 'open' | 'closed';
      providerOverride?: {
        endpoint?: string;
        circuitBreaker?: {
          failureThreshold?: number;
          resetTimeoutMs?: number;
          failMode?: 'open' | 'closed';
        };
        retry?: { maxRetries?: number; backoffBaseMs?: number };
      };
    },
  ): Promise<GuardrailEvalResult | undefined> {
    const provider = this.get(providerName);
    if (!provider) return undefined;

    // Apply circuit breaker overrides: replace the breaker if config differs
    const breaker = this.breakers.get(providerName);
    if (!breaker) return undefined;
    const effectiveProviderOverride = mergeProviderRuntimeConfig(
      this.getRuntimeConfig(providerName),
      options?.providerOverride,
    );
    const effectiveFailMode =
      options?.failMode ?? effectiveProviderOverride?.circuitBreaker?.failMode ?? 'open';
    if (effectiveProviderOverride?.circuitBreaker) {
      const cbOverride = effectiveProviderOverride.circuitBreaker;
      const needsUpdate =
        (cbOverride.failureThreshold !== undefined &&
          cbOverride.failureThreshold !== breaker.currentConfig.failureThreshold) ||
        (cbOverride.resetTimeoutMs !== undefined &&
          cbOverride.resetTimeoutMs !== breaker.currentConfig.resetTimeoutMs);
      if (needsUpdate) {
        const newBreaker = new CircuitBreaker({
          ...this.circuitBreakerConfig,
          ...cbOverride,
        });
        this.breakers.set(providerName, newBreaker);
        log.debug('Replaced circuit breaker with runtime provider config', {
          provider: providerName,
          failureThreshold: cbOverride.failureThreshold,
          resetTimeoutMs: cbOverride.resetTimeoutMs,
        });
      }
    }
    const activeBreaker = this.breakers.get(providerName)!;
    if (!activeBreaker.canExecute()) {
      log.warn('Circuit breaker open for provider, skipping evaluation', {
        provider: providerName,
        state: activeBreaker.state,
        failMode: effectiveFailMode,
      });
      if (effectiveFailMode === 'closed') {
        return {
          score: 1.0,
          severity: 'critical',
          category: request.category,
          latencyMs: 0,
          raw: { failedClosed: true, error: 'Provider unavailable' },
        };
      }
      return {
        score: 0.0,
        severity: 'safe',
        category: request.category,
        latencyMs: 0,
        raw: { failedOpen: true, error: 'Provider unavailable' },
      };
    }

    let effectiveProvider: GuardrailModelProvider = provider;
    const endpointOverride = effectiveProviderOverride?.endpoint;
    if (endpointOverride) {
      if (isRuntimeOverrideableGuardrailProvider(provider)) {
        effectiveProvider = provider.withRuntimeOverride({
          endpoint: endpointOverride,
        } satisfies RuntimeProviderOverride);
      } else {
        log.warn('Ignoring provider endpoint override for non-overrideable provider', {
          provider: providerName,
          endpoint: endpointOverride,
        });
      }
    }

    try {
      const retryConfig = effectiveProviderOverride?.retry;
      const maxRetries = Math.max(retryConfig?.maxRetries ?? 0, 0);
      const backoffBaseMs = Math.max(retryConfig?.backoffBaseMs ?? 0, 0);

      let result: GuardrailEvalResult | undefined;
      let lastError: unknown;
      for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
          result = await effectiveProvider.evaluate(request);
          break;
        } catch (err) {
          lastError = err;
          if (attempt >= maxRetries) {
            throw err;
          }
          await waitForBackoff(backoffBaseMs * 2 ** attempt);
        }
      }

      if (!result) {
        throw lastError ?? new Error('Provider evaluation failed');
      }

      activeBreaker.recordSuccess();
      return result;
    } catch (err: unknown) {
      activeBreaker.recordFailure();
      log.warn('Provider evaluation failed, circuit breaker updated', {
        provider: providerName,
        error: err instanceof Error ? err.message : String(err),
        state: activeBreaker.state,
        consecutiveFailures: activeBreaker.consecutiveFailures,
        failMode: effectiveFailMode,
      });
      if (effectiveFailMode === 'closed') {
        return {
          score: 1.0,
          severity: 'critical',
          category: request.category,
          latencyMs: 0,
          raw: { failedClosed: true, error: 'Provider unavailable' },
        };
      }
      return {
        score: 0.0,
        severity: 'safe',
        category: request.category,
        latencyMs: 0,
        raw: { failedOpen: true, error: 'Provider unavailable' },
      };
    }
  }
}
