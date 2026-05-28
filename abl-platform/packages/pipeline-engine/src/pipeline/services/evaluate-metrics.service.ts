/**
 * EvaluateMetrics — Restate activity service for threshold-based metric evaluation.
 *
 * Supports two config formats:
 * - Legacy: metrics: string[] → records metric names with default pass
 * - Structured: metrics: MetricRule[] → evaluates expressions against thresholds
 *
 * MetricRule shape:
 *   { name, field (expression), operator (gt|lt|eq|gte|lte), threshold, weight? }
 */
import * as restate from '@restatedev/restate-sdk';
import { resolveExpression } from '../expression-evaluator.js';
import type { PipelineStepContext, StepOutput } from '../types.js';

interface MetricRule {
  name: string;
  field: string;
  operator: 'gt' | 'lt' | 'eq' | 'gte' | 'lte';
  threshold: number;
  weight?: number;
}

interface MetricResult {
  value: number;
  passed: boolean;
  score: number;
}

function applyOperator(op: string, value: number, threshold: number): boolean {
  if (isNaN(value)) return false;
  switch (op) {
    case 'gt':
      return value > threshold;
    case 'lt':
      return value < threshold;
    case 'eq':
      return value === threshold;
    case 'gte':
      return value >= threshold;
    case 'lte':
      return value <= threshold;
    default:
      return false;
  }
}

export const evaluateMetricsService = restate.service({
  name: 'EvaluateMetrics',
  handlers: {
    execute: async (ctx: restate.Context, input: PipelineStepContext): Promise<StepOutput> => {
      const startTime = Date.now();
      const metrics = input.config.metrics as (string | MetricRule)[];

      if (!metrics || !Array.isArray(metrics) || metrics.length === 0) {
        return {
          status: 'fail',
          data: {
            error: "EvaluateMetrics requires a non-empty 'metrics' array in config",
          },
          durationMs: Date.now() - startTime,
        };
      }

      try {
        const result = await ctx.run('evaluate-metrics', async () => {
          const scores: Record<string, MetricResult> = {};
          let totalWeight = 0;
          let weightedSum = 0;

          for (const metric of metrics) {
            if (typeof metric === 'string') {
              // Legacy string format — record name, default pass
              scores[metric] = { value: 0, passed: true, score: 1.0 };
              totalWeight += 1;
              weightedSum += 1;
              continue;
            }

            const rule = metric as MetricRule;
            const resolved = resolveExpression(
              rule.field,
              input.previousSteps,
              input.pipelineInput,
            );
            const numericValue = Number(resolved);
            const passed = applyOperator(rule.operator, numericValue, rule.threshold);
            const score = passed ? 1.0 : 0.0;
            const weight = rule.weight ?? 1.0;

            scores[rule.name] = { value: numericValue, passed, score };
            totalWeight += weight;
            weightedSum += score * weight;
          }

          const overallScore = totalWeight > 0 ? weightedSum / totalWeight : 0;
          return { scores, overallScore };
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
export type EvaluateMetricsService = typeof evaluateMetricsService;
