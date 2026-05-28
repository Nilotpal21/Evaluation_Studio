/**
 * Tier 2 Model-Based Evaluator — Guardrail evaluation via model providers.
 *
 * Evaluates Tier 2 (model) guardrails by dispatching to registered providers
 * through the GuardrailProviderRegistry with circuit breaker protection.
 * All checks run in parallel via Promise.all.
 *
 * Key behaviors:
 * - Parallel execution: all Tier 2 guardrails evaluate concurrently
 * - Fail-open: provider errors are treated as pass (safe)
 * - Severity-based action mapping: per-severity action overrides
 * - Cost tracking: accumulates costPerEvalUsd from providers
 * - Score-to-severity: uses scoreToSeverity() when provider doesn't return severity
 */

import { GuardrailProviderRegistry } from './provider-registry.js';
import type { GuardrailEvalRequest, ProviderRuntimeConfig } from './provider.js';
import { scoreToSeverity } from './provider.js';
import type { Guardrail } from '../ir/schema.js';
import type { GuardrailViolation, GuardrailPipelineResult } from './types.js';
import { createEmptyPipelineResult, addViolation } from './types.js';
import { createLogger } from '../logger.js';
import { guardrailMessage, GuardrailErrorCode } from './messages.js';
import { resolveAction } from './severity-resolver.js';
import type { PIIRecognizerRegistry } from '../security/pii-recognizer-registry.js';

const log = createLogger('tier2-evaluator');

/** Default score threshold when guardrail does not specify one */
const DEFAULT_THRESHOLD = 0.5;

function withTimeout<T>(promise: Promise<T>, timeoutMs?: number): Promise<T> {
  if (typeof timeoutMs !== 'number' || !Number.isFinite(timeoutMs)) {
    return promise;
  }

  return new Promise<T>((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error(`Guardrail evaluation timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    promise.then(
      (value) => {
        clearTimeout(timeout);
        resolve(value);
      },
      (error) => {
        clearTimeout(timeout);
        reject(error);
      },
    );
  });
}

interface Tier2ProviderOverride extends ProviderRuntimeConfig {
  providerName: string;
  isActive?: boolean;
}

function mergeProviderRuntimeConfig(
  base?: ProviderRuntimeConfig,
  override?: Tier2ProviderOverride,
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

export class Tier2Evaluator {
  private registry: GuardrailProviderRegistry;

  constructor(registry?: GuardrailProviderRegistry) {
    this.registry = registry ?? new GuardrailProviderRegistry();
  }

  /**
   * Evaluate an array of Tier 2 guardrails against the given content.
   *
   * All guardrails are evaluated in parallel. A provider returning a score
   * at or above the threshold indicates a violation. Severity determines the
   * action via severityActions mapping (falling back to the guardrail's default action).
   *
   * @param guardrails - Array of Tier 2 guardrails with `provider` references
   * @param content - The content to evaluate
   * @param context - Optional conversation context for contextual models
   * @returns Pipeline result with violations, warnings, and metrics
   */
  async evaluate(
    guardrails: Guardrail[],
    content: string,
    context?: {
      systemPrompt?: string;
      recentMessages?: Array<{ role: string; content: string }>;
      piiRecognizerRegistry?: PIIRecognizerRegistry;
    },
    options?: {
      failMode?: 'open' | 'closed';
      piiRecognizerRegistry?: PIIRecognizerRegistry;
      providerOverrides?: Tier2ProviderOverride[];
      timeoutMs?: number;
    },
  ): Promise<GuardrailPipelineResult> {
    const result = createEmptyPipelineResult();
    const allCheckLatencies: number[] = [];

    // Build lookup for provider overrides from policy
    const overrideMap = new Map((options?.providerOverrides ?? []).map((o) => [o.providerName, o]));

    const evaluations = guardrails.map(async (guardrail) => {
      const start = performance.now();
      try {
        if (!guardrail.provider) {
          log.warn('Tier 2 guardrail missing provider', { name: guardrail.name });
          result.metrics.totalChecks++;
          result.metrics.passed++;
          return;
        }

        const policyProviderOverride = guardrail.provider
          ? overrideMap.get(guardrail.provider)
          : undefined;
        if (policyProviderOverride?.isActive === false) {
          const latencyMs = performance.now() - start;
          allCheckLatencies.push(latencyMs);
          result.metrics.totalChecks++;

          if (options?.failMode === 'closed') {
            const violation: GuardrailViolation = {
              name: guardrail.name,
              kind: guardrail.kind,
              tier: 'model',
              action: guardrail.action.type === 'block' ? 'block' : guardrail.action.type,
              severity: 'high',
              score: 1.0,
              threshold: guardrail.threshold ?? DEFAULT_THRESHOLD,
              message:
                guardrail.action.message ??
                guardrailMessage(GuardrailErrorCode.PROVIDER_NOT_REGISTERED, {
                  provider: guardrail.provider,
                }),
              priority: guardrail.priority,
              latencyMs,
              provider: guardrail.provider,
              presetKey: guardrail.presetKey,
            };
            addViolation(result, violation);
            log.warn('Tier 2 provider disabled by policy override, blocking (failMode=closed)', {
              guardrailName: guardrail.name,
              provider: guardrail.provider,
            });
          } else {
            log.warn('Tier 2 provider disabled by policy override, treating as pass', {
              guardrailName: guardrail.name,
              provider: guardrail.provider,
            });
            result.metrics.passed++;
          }
          return;
        }
        const providerOverride = mergeProviderRuntimeConfig(
          this.registry.getRuntimeConfig(guardrail.provider),
          policyProviderOverride,
        );

        const request: GuardrailEvalRequest = {
          content,
          category: guardrail.category ?? providerOverride?.defaultCategory ?? 'general',
          context: {
            ...context,
            piiRecognizerRegistry: options?.piiRecognizerRegistry ?? context?.piiRecognizerRegistry,
            allowedEntityTypes: guardrail.entities,
          },
        };

        const evalResult = await withTimeout(
          this.registry.evaluate(guardrail.provider, request, {
            failMode: options?.failMode,
            providerOverride: providerOverride
              ? {
                  endpoint: providerOverride.endpoint,
                  circuitBreaker: providerOverride.circuitBreaker,
                  retry: providerOverride.retry,
                }
              : undefined,
          }),
          options?.timeoutMs,
        );
        const latencyMs = performance.now() - start;

        allCheckLatencies.push(latencyMs);
        result.metrics.totalChecks++;

        // Registry returns undefined for unregistered providers
        if (!evalResult) {
          if (options?.failMode === 'closed') {
            // Missing provider + failMode=closed → treat as violation (block)
            const violation: GuardrailViolation = {
              name: guardrail.name,
              kind: guardrail.kind,
              tier: 'model',
              action: guardrail.action.type === 'block' ? 'block' : guardrail.action.type,
              severity: 'high',
              score: 1.0,
              threshold: guardrail.threshold ?? DEFAULT_THRESHOLD,
              message:
                guardrail.action.message ??
                guardrailMessage(GuardrailErrorCode.PROVIDER_NOT_REGISTERED, {
                  provider: guardrail.provider ?? 'unknown',
                }),
              priority: guardrail.priority,
              latencyMs: performance.now() - start,
              presetKey: guardrail.presetKey,
            };
            addViolation(result, violation);
            log.warn('Tier 2 provider not registered, blocking (failMode=closed)', {
              guardrailName: guardrail.name,
              provider: guardrail.provider,
            });
          } else {
            log.warn('Tier 2 provider not registered, treating as pass (failMode=open)', {
              guardrailName: guardrail.name,
              provider: guardrail.provider,
            });
            result.metrics.passed++;
          }
          return;
        }

        // Track cost for successful evaluations
        const providerInstance = this.registry.get(guardrail.provider);
        if (providerOverride?.costPerEvalUsd !== undefined) {
          result.metrics.costUsd += providerOverride.costPerEvalUsd;
        } else if (providerInstance) {
          result.metrics.costUsd += providerInstance.costPerEvalUsd;
        }

        // Check against threshold
        const threshold =
          guardrail.threshold ?? providerOverride?.defaultThreshold ?? DEFAULT_THRESHOLD;
        if (evalResult.score >= threshold) {
          // Determine severity from score (use provider severity or compute from score)
          const severity = evalResult.severity || scoreToSeverity(evalResult.score);

          // Use severity-specific action if defined, otherwise default action
          const action = resolveAction(guardrail, severity);

          const violation: GuardrailViolation = {
            name: guardrail.name,
            kind: guardrail.kind,
            tier: 'model',
            action: action.type,
            resolvedAction: action,
            severity,
            score: evalResult.score,
            threshold,
            category: evalResult.category,
            label: evalResult.label,
            message: action.message ?? guardrail.description,
            explanation: evalResult.explanation,
            priority: guardrail.priority,
            latencyMs,
            provider: guardrail.provider,
            presetKey: guardrail.presetKey,
          };
          addViolation(result, violation);
        } else {
          result.metrics.passed++;
        }
      } catch (err) {
        const latencyMs = performance.now() - start;
        allCheckLatencies.push(latencyMs);
        result.metrics.totalChecks++;

        if (options?.failMode === 'closed') {
          const violation: GuardrailViolation = {
            name: guardrail.name,
            kind: guardrail.kind,
            tier: 'model',
            action: 'block',
            severity: 'high',
            message: guardrailMessage(GuardrailErrorCode.EVAL_FAILED),
            priority: guardrail.priority,
            latencyMs,
            provider: guardrail.provider,
            presetKey: guardrail.presetKey,
          };
          addViolation(result, violation);
          log.warn('Tier 2 evaluation failed for guardrail, blocking (failMode=closed)', {
            guardrailName: guardrail.name,
            provider: guardrail.provider,
            error: err instanceof Error ? err.message : String(err),
            latencyMs,
          });
        } else {
          result.metrics.passed++;
          log.warn('Tier 2 evaluation failed for guardrail, treating as pass', {
            guardrailName: guardrail.name,
            provider: guardrail.provider,
            error: err instanceof Error ? err.message : String(err),
            latencyMs,
          });
        }
      }
    });

    await Promise.all(evaluations);

    // Total latency is the max of ALL checks (parallel execution, including passed)
    result.metrics.tier2LatencyMs =
      allCheckLatencies.length > 0 ? Math.max(...allCheckLatencies) : 0;
    result.metrics.totalLatencyMs += result.metrics.tier2LatencyMs;

    return result;
  }
}
