/**
 * Threshold Evaluator
 *
 * Core logic for comparing metric values against alert rule thresholds.
 * Pure functions — no I/O, no state, fully testable.
 */

import type {
  AlertRule,
  AlertEvaluation,
  AlertState,
  MetricValue,
  ThresholdOperator,
} from './interfaces.js';

/**
 * Check if a metric value breaches the threshold defined by a rule.
 */
export function checkThreshold(
  value: number,
  operator: ThresholdOperator,
  threshold: number,
): boolean {
  switch (operator) {
    case 'gt':
      return value > threshold;
    case 'gte':
      return value >= threshold;
    case 'lt':
      return value < threshold;
    case 'lte':
      return value <= threshold;
    case 'eq':
      return value === threshold;
    case 'neq':
      return value !== threshold;
    default:
      return false;
  }
}

/**
 * Determine the new alert state based on breach status and previous state.
 */
export function resolveAlertState(breached: boolean, previousState: AlertState): AlertState {
  if (breached) {
    return 'firing';
  }
  // Transition from firing → resolved
  if (previousState === 'firing') {
    return 'resolved';
  }
  return 'ok';
}

/**
 * Evaluate a single alert rule against a metric value.
 */
export function evaluateRule(
  rule: AlertRule,
  metricValue: MetricValue,
  previousState: AlertState,
): AlertEvaluation {
  const breached = checkThreshold(metricValue.value, rule.operator, rule.threshold);
  const newState = resolveAlertState(breached, previousState);

  return {
    ruleId: rule.id,
    tenantId: rule.tenantId,
    projectId: rule.projectId,
    breached,
    metricValue: metricValue.value,
    threshold: rule.threshold,
    operator: rule.operator,
    state: newState,
    previousState,
    evaluatedAt: new Date(),
  };
}

/**
 * Determine if an alert state transition should trigger a notification.
 * Only notifies on state changes: ok → firing, firing → resolved.
 */
export function shouldNotify(evaluation: AlertEvaluation): boolean {
  // Fire notification: transitioned to firing from non-firing
  if (evaluation.state === 'firing' && evaluation.previousState !== 'firing') {
    return true;
  }
  // Resolve notification: transitioned from firing to resolved
  if (evaluation.state === 'resolved' && evaluation.previousState === 'firing') {
    return true;
  }
  return false;
}

/**
 * Convert a window definition to milliseconds.
 */
export function windowToMs(window: { value: number; unit: 'minutes' | 'hours' | 'days' }): number {
  switch (window.unit) {
    case 'minutes':
      return window.value * 60 * 1000;
    case 'hours':
      return window.value * 60 * 60 * 1000;
    case 'days':
      return window.value * 24 * 60 * 60 * 1000;
    default:
      return window.value * 60 * 1000;
  }
}
