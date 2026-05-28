/**
 * Tier 1 Local Evaluator — CEL-based guardrail evaluation engine.
 *
 * Evaluates Tier 1 (local) guardrails using the ABL CEL environment.
 * All checks run in parallel via Promise.all. CEL expressions that
 * return `true` indicate a violation; `false` means the check passed.
 *
 * Error handling: CEL evaluation errors are treated as pass (fail-open)
 * because a malformed expression should not block user input. Errors are
 * logged for debugging.
 */

import { ablCelEnvironment, getAblCelEnvironment } from '../constructs/cel-functions.js';
import { createLogger } from '../logger.js';
import type { Guardrail } from '../ir/schema.js';
import type { GuardrailViolation, GuardrailPipelineResult } from './types.js';
import { createEmptyPipelineResult, addViolation } from './types.js';
import { guardrailMessage, GuardrailErrorCode } from './messages.js';
import { resolveAction } from './severity-resolver.js';
import type { PIIRecognizerRegistry } from '../security/pii-recognizer-registry.js';

/**
 * Tier 1 CEL checks are binary (true = violation, false = pass) — they do
 * not score severity, so we treat every Tier 1 violation as `high` when
 * resolving the action. Authors who need per-severity branching should
 * use a Tier 2 model-based check that produces a scored severity.
 */
const TIER1_SEVERITY = 'high' as const;

const log = createLogger('tier1-evaluator');

export class Tier1Evaluator {
  private env = ablCelEnvironment;

  /**
   * Evaluate an array of Tier 1 guardrails against the given CEL context.
   *
   * All guardrails are evaluated in parallel. A CEL check returning `true`
   * means the guardrail was triggered (violation detected). A `false` or
   * falsy return means the content passed the check.
   *
   * @param guardrails - Array of Tier 1 guardrails with `check` CEL expressions
   * @param celContext - Context variables available to CEL expressions (e.g. `input`, `output`)
   * @returns Pipeline result with violations, warnings, and metrics
   */
  async evaluate(
    guardrails: Guardrail[],
    celContext: Record<string, unknown>,
    options?: {
      failMode?: 'open' | 'closed';
      timeoutMs?: number;
      piiRecognizerRegistry?: PIIRecognizerRegistry;
    },
  ): Promise<GuardrailPipelineResult> {
    const result = createEmptyPipelineResult();
    // Track all latencies including passed checks for accurate max calculation
    const allCheckLatencies: number[] = [];
    const env = options?.piiRecognizerRegistry
      ? getAblCelEnvironment({ piiRecognizerRegistry: options.piiRecognizerRegistry })
      : this.env;

    const evaluations = guardrails.map(async (guardrail) => {
      const start = performance.now();
      try {
        const checkResult = env.evaluate(guardrail.check!, celContext);
        const latencyMs = performance.now() - start;
        allCheckLatencies.push(latencyMs);

        result.metrics.totalChecks++;

        if (typeof options?.timeoutMs === 'number' && latencyMs > options.timeoutMs) {
          if (options.failMode === 'closed') {
            const violation: GuardrailViolation = {
              name: guardrail.name,
              kind: guardrail.kind,
              tier: 'local',
              action: 'block',
              severity: 'high',
              message: guardrailMessage(GuardrailErrorCode.EVAL_FAILED),
              priority: guardrail.priority,
              latencyMs,
            };
            addViolation(result, violation);
          } else {
            result.metrics.passed++;
          }

          log.warn('CEL evaluation timed out for guardrail', {
            guardrailName: guardrail.name,
            timeoutMs: options.timeoutMs,
            latencyMs,
            failMode: options?.failMode ?? 'open',
          });
          return;
        }

        if (checkResult === true) {
          const resolved = resolveAction(guardrail, TIER1_SEVERITY);
          const violation: GuardrailViolation = {
            name: guardrail.name,
            kind: guardrail.kind,
            tier: 'local',
            action: resolved.type,
            resolvedAction: resolved,
            severity: TIER1_SEVERITY,
            message: resolved.message ?? guardrail.action.message ?? guardrail.description,
            priority: guardrail.priority,
            latencyMs,
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
            tier: 'local',
            action: 'block',
            severity: 'high',
            message: guardrailMessage(GuardrailErrorCode.EVAL_FAILED),
            priority: guardrail.priority,
            latencyMs,
          };
          addViolation(result, violation);
          log.warn('CEL evaluation failed for guardrail, blocking (failMode=closed)', {
            guardrailName: guardrail.name,
            check: guardrail.check,
            error: err instanceof Error ? err.message : String(err),
            latencyMs,
          });
        } else {
          result.metrics.passed++;
          log.warn('CEL evaluation failed for guardrail, treating as pass', {
            guardrailName: guardrail.name,
            check: guardrail.check,
            error: err instanceof Error ? err.message : String(err),
            latencyMs,
          });
        }
      }
    });

    await Promise.all(evaluations);

    // Tier 1 runs in parallel so total latency is the max of ALL checks (including passed)
    result.metrics.tier1LatencyMs =
      allCheckLatencies.length > 0 ? Math.max(...allCheckLatencies) : 0;
    result.metrics.totalLatencyMs = result.metrics.tier1LatencyMs;

    return result;
  }
}
