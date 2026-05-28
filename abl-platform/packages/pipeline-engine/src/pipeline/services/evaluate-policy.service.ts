/**
 * EvaluatePolicy — Restate activity service for rule-based policy evaluation.
 *
 * Evaluates inline policy rules against step outputs and pipeline input.
 * Each rule specifies a condition (expression), operator, and expected value.
 *
 * Returns PASS / WARN / FAIL based on violation severities:
 * - FAIL: any critical violation
 * - WARN: only warning/info violations
 * - PASS: all rules satisfied
 */
import * as restate from '@restatedev/restate-sdk';
import { resolveExpression } from '../expression-evaluator.js';
import type { PipelineStepContext, StepOutput } from '../types.js';

interface PolicyRule {
  name: string;
  /** Expression path to resolve (e.g. 'steps.score-toxicity.output.score') */
  field?: string;
  /** @deprecated Use `field` instead */
  condition?: string;
  operator: 'eq' | 'neq' | 'gt' | 'lt' | 'gte' | 'lte';
  expected: string | number | boolean;
  severity?: 'critical' | 'warning' | 'info';
}

interface Violation {
  rule: string;
  actual: unknown;
  expected: unknown;
  severity: string;
}

function applyPolicyOperator(
  op: string,
  actual: unknown,
  expected: string | number | boolean,
): boolean {
  if (typeof expected === 'number') {
    const numActual = Number(actual);
    if (isNaN(numActual)) return false;
    switch (op) {
      case 'gt':
        return numActual > expected;
      case 'lt':
        return numActual < expected;
      case 'eq':
        return numActual === expected;
      case 'neq':
        return numActual !== expected;
      case 'gte':
        return numActual >= expected;
      case 'lte':
        return numActual <= expected;
      default:
        return false;
    }
  }
  // String/boolean comparison
  switch (op) {
    case 'eq':
      return String(actual) === String(expected);
    case 'neq':
      return String(actual) !== String(expected);
    default:
      return false;
  }
}

export const evaluatePolicyService = restate.service({
  name: 'EvaluatePolicy',
  handlers: {
    execute: async (ctx: restate.Context, input: PipelineStepContext): Promise<StepOutput> => {
      const startTime = Date.now();
      const policyId = input.config.policyId as string;

      if (!policyId) {
        return {
          status: 'fail',
          data: { error: "EvaluatePolicy requires 'policyId' in config" },
          durationMs: Date.now() - startTime,
        };
      }

      try {
        const rules = input.config.rules as PolicyRule[] | undefined;

        const result = await ctx.run('evaluate-policy', async () => {
          if (!rules || !Array.isArray(rules) || rules.length === 0) {
            return {
              status: 'PASS' as const,
              policyId,
              summary: { passed: 0, failed: 0, warnings: 0, total: 0 },
              violations: [] as Violation[],
            };
          }

          const violations: Violation[] = [];
          let passed = 0;
          let failed = 0;
          let warnings = 0;

          for (const rule of rules) {
            const expression = rule.field ?? rule.condition;
            if (!expression) {
              violations.push({
                rule: rule.name,
                actual: undefined,
                expected: rule.expected,
                severity: rule.severity ?? 'warning',
              });
              failed++;
              if ((rule.severity ?? 'warning') === 'warning') warnings++;
              continue;
            }
            const actual = resolveExpression(expression, input.previousSteps, input.pipelineInput);
            const meets = applyPolicyOperator(rule.operator, actual, rule.expected);

            if (meets) {
              passed++;
            } else {
              const severity = rule.severity ?? 'warning';
              violations.push({
                rule: rule.name,
                actual,
                expected: rule.expected,
                severity,
              });
              failed++;
              if (severity === 'warning') warnings++;
            }
          }

          const hasCritical = violations.some((v) => v.severity === 'critical');
          const status = hasCritical ? 'FAIL' : failed > 0 ? 'WARN' : 'PASS';

          return {
            status,
            policyId,
            summary: { passed, failed, warnings, total: rules.length },
            violations,
          };
        });

        return {
          status: 'success',
          data: result,
          durationMs: Date.now() - startTime,
        };
      } catch (error) {
        return {
          status: 'fail',
          data: {
            error: error instanceof Error ? error.message : String(error),
          },
          durationMs: Date.now() - startTime,
        };
      }
    },
  },
});

/** Export the type for use by other Restate services calling this one. */
export type EvaluatePolicyService = typeof evaluatePolicyService;
