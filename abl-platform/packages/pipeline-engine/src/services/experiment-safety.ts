/**
 * Experiment Safety Rule Evaluation — Pure Functions
 *
 * Evaluates safety rules against experiment metrics to detect breaches.
 * No side effects, no database calls — suitable for unit testing without mocks.
 */

import type { ExperimentSafetyRule } from '../schemas/experiment.schema.js';

// ─── Result Type ───────────────────────────────────────────────────────

export interface ExperimentSafetyCheckResult {
  metric: string;
  value: number;
  controlValue: number;
  threshold: number;
  passing: boolean;
  skipped: boolean;
  sampleSize: number;
  comparison: 'absolute' | 'relative_to_control';
}

// ─── Operator Evaluation ───────────────────────────────────────────────

function evaluateOperator(
  value: number,
  operator: 'lt' | 'gt' | 'lte' | 'gte',
  threshold: number,
): boolean {
  switch (operator) {
    case 'lt':
      return value < threshold;
    case 'gt':
      return value > threshold;
    case 'lte':
      return value <= threshold;
    case 'gte':
      return value >= threshold;
  }
}

// ─── Safety Rule Evaluation ────────────────────────────────────────────

/**
 * Evaluate a set of safety rules against experiment and control metrics.
 *
 * For each rule:
 * - If experiment sample size < rule.minSampleSize, the rule is skipped
 *   (passing=true, skipped=true) — not enough data to judge.
 * - For 'absolute' comparison, the experiment metric value is tested
 *   directly against the threshold using the rule's operator.
 * - For 'relative_to_control' comparison, the relative change
 *   (experiment - control) / control is tested against the threshold.
 *
 * Returns one result per rule in the same order as the input array.
 */
export function evaluateSafetyRules(
  safetyRules: ExperimentSafetyRule[],
  controlMetrics: Record<string, number>,
  experimentMetrics: Record<string, number>,
  sampleSizes: { control: number; experiment: number },
): ExperimentSafetyCheckResult[] {
  return safetyRules.map((rule) => {
    const experimentValue = experimentMetrics[rule.metric] ?? 0;
    const controlValue = controlMetrics[rule.metric] ?? 0;
    const sampleSize = sampleSizes.experiment;

    if (sampleSize < rule.minSampleSize) {
      return {
        metric: rule.metric,
        value: experimentValue,
        controlValue,
        threshold: rule.threshold,
        passing: true,
        skipped: true,
        sampleSize,
        comparison: rule.comparison,
      };
    }

    let testValue: number;
    if (rule.comparison === 'relative_to_control') {
      testValue = controlValue !== 0 ? (experimentValue - controlValue) / controlValue : 0;
    } else {
      testValue = experimentValue;
    }

    const passing = evaluateOperator(testValue, rule.operator, rule.threshold);
    return {
      metric: rule.metric,
      value: experimentValue,
      controlValue,
      threshold: rule.threshold,
      passing,
      skipped: false,
      sampleSize,
      comparison: rule.comparison,
    };
  });
}
