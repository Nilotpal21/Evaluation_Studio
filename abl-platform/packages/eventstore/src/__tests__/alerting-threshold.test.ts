import { describe, it, expect } from 'vitest';
import {
  checkThreshold,
  resolveAlertState,
  evaluateRule,
  shouldNotify,
  windowToMs,
} from '../alerting/threshold-evaluator.js';
import type { AlertRule, MetricValue } from '../alerting/interfaces.js';

// =============================================================================
// checkThreshold
// =============================================================================

describe('checkThreshold', () => {
  it('gt: true when value > threshold', () => {
    expect(checkThreshold(10, 'gt', 5)).toBe(true);
    expect(checkThreshold(5, 'gt', 5)).toBe(false);
    expect(checkThreshold(3, 'gt', 5)).toBe(false);
  });

  it('gte: true when value >= threshold', () => {
    expect(checkThreshold(10, 'gte', 5)).toBe(true);
    expect(checkThreshold(5, 'gte', 5)).toBe(true);
    expect(checkThreshold(3, 'gte', 5)).toBe(false);
  });

  it('lt: true when value < threshold', () => {
    expect(checkThreshold(3, 'lt', 5)).toBe(true);
    expect(checkThreshold(5, 'lt', 5)).toBe(false);
    expect(checkThreshold(10, 'lt', 5)).toBe(false);
  });

  it('lte: true when value <= threshold', () => {
    expect(checkThreshold(3, 'lte', 5)).toBe(true);
    expect(checkThreshold(5, 'lte', 5)).toBe(true);
    expect(checkThreshold(10, 'lte', 5)).toBe(false);
  });

  it('eq: true when value === threshold', () => {
    expect(checkThreshold(5, 'eq', 5)).toBe(true);
    expect(checkThreshold(4, 'eq', 5)).toBe(false);
  });

  it('neq: true when value !== threshold', () => {
    expect(checkThreshold(4, 'neq', 5)).toBe(true);
    expect(checkThreshold(5, 'neq', 5)).toBe(false);
  });

  it('handles floating point values', () => {
    expect(checkThreshold(0.95, 'gt', 0.9)).toBe(true);
    expect(checkThreshold(0.5, 'lt', 0.75)).toBe(true);
  });

  it('handles zero', () => {
    expect(checkThreshold(0, 'eq', 0)).toBe(true);
    expect(checkThreshold(0, 'gt', 0)).toBe(false);
  });

  it('handles negative values', () => {
    expect(checkThreshold(-1, 'lt', 0)).toBe(true);
    expect(checkThreshold(-5, 'gt', -10)).toBe(true);
  });
});

// =============================================================================
// resolveAlertState
// =============================================================================

describe('resolveAlertState', () => {
  it('returns firing when breached', () => {
    expect(resolveAlertState(true, 'ok')).toBe('firing');
    expect(resolveAlertState(true, 'firing')).toBe('firing');
    expect(resolveAlertState(true, 'resolved')).toBe('firing');
  });

  it('returns resolved when not breached and was firing', () => {
    expect(resolveAlertState(false, 'firing')).toBe('resolved');
  });

  it('returns ok when not breached and was not firing', () => {
    expect(resolveAlertState(false, 'ok')).toBe('ok');
    expect(resolveAlertState(false, 'resolved')).toBe('ok');
    expect(resolveAlertState(false, 'acknowledged')).toBe('ok');
  });
});

// =============================================================================
// evaluateRule
// =============================================================================

describe('evaluateRule', () => {
  const baseRule: AlertRule = {
    id: 'rule-1',
    tenantId: 'tenant-a',
    projectId: 'project-a',
    name: 'High Error Rate',
    enabled: true,
    metric: 'error_rate',
    operator: 'gt',
    threshold: 0.1,
    window: { value: 1, unit: 'hours' },
    severity: 'critical',
    cooldownSeconds: 300,
    channels: [],
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  const makeMetricValue = (value: number): MetricValue => ({
    value,
    sampleCount: 100,
    windowStart: new Date(Date.now() - 3600000),
    windowEnd: new Date(),
  });

  it('detects breach when metric exceeds threshold', () => {
    const result = evaluateRule(baseRule, makeMetricValue(0.15), 'ok');
    expect(result.breached).toBe(true);
    expect(result.state).toBe('firing');
    expect(result.metricValue).toBe(0.15);
    expect(result.threshold).toBe(0.1);
  });

  it('detects no breach when metric is below threshold', () => {
    const result = evaluateRule(baseRule, makeMetricValue(0.05), 'ok');
    expect(result.breached).toBe(false);
    expect(result.state).toBe('ok');
  });

  it('transitions from firing to resolved', () => {
    const result = evaluateRule(baseRule, makeMetricValue(0.05), 'firing');
    expect(result.breached).toBe(false);
    expect(result.state).toBe('resolved');
    expect(result.previousState).toBe('firing');
  });

  it('includes rule and tenant context', () => {
    const result = evaluateRule(baseRule, makeMetricValue(0.2), 'ok');
    expect(result.ruleId).toBe('rule-1');
    expect(result.tenantId).toBe('tenant-a');
    expect(result.projectId).toBe('project-a');
    expect(result.operator).toBe('gt');
  });

  it('sets evaluatedAt timestamp', () => {
    const before = Date.now();
    const result = evaluateRule(baseRule, makeMetricValue(0.2), 'ok');
    expect(result.evaluatedAt.getTime()).toBeGreaterThanOrEqual(before);
  });
});

// =============================================================================
// shouldNotify
// =============================================================================

describe('shouldNotify', () => {
  it('notifies on ok → firing', () => {
    expect(
      shouldNotify({
        ruleId: 'r1',
        tenantId: 't',
        projectId: 'p',
        breached: true,
        metricValue: 1,
        threshold: 0.5,
        operator: 'gt',
        state: 'firing',
        previousState: 'ok',
        evaluatedAt: new Date(),
      }),
    ).toBe(true);
  });

  it('notifies on resolved → firing', () => {
    expect(
      shouldNotify({
        ruleId: 'r1',
        tenantId: 't',
        projectId: 'p',
        breached: true,
        metricValue: 1,
        threshold: 0.5,
        operator: 'gt',
        state: 'firing',
        previousState: 'resolved',
        evaluatedAt: new Date(),
      }),
    ).toBe(true);
  });

  it('notifies on firing → resolved', () => {
    expect(
      shouldNotify({
        ruleId: 'r1',
        tenantId: 't',
        projectId: 'p',
        breached: false,
        metricValue: 0.1,
        threshold: 0.5,
        operator: 'gt',
        state: 'resolved',
        previousState: 'firing',
        evaluatedAt: new Date(),
      }),
    ).toBe(true);
  });

  it('does NOT notify when still firing (no state change)', () => {
    expect(
      shouldNotify({
        ruleId: 'r1',
        tenantId: 't',
        projectId: 'p',
        breached: true,
        metricValue: 1,
        threshold: 0.5,
        operator: 'gt',
        state: 'firing',
        previousState: 'firing',
        evaluatedAt: new Date(),
      }),
    ).toBe(false);
  });

  it('does NOT notify when still ok', () => {
    expect(
      shouldNotify({
        ruleId: 'r1',
        tenantId: 't',
        projectId: 'p',
        breached: false,
        metricValue: 0.1,
        threshold: 0.5,
        operator: 'gt',
        state: 'ok',
        previousState: 'ok',
        evaluatedAt: new Date(),
      }),
    ).toBe(false);
  });

  it('does NOT notify on resolved → ok', () => {
    expect(
      shouldNotify({
        ruleId: 'r1',
        tenantId: 't',
        projectId: 'p',
        breached: false,
        metricValue: 0.1,
        threshold: 0.5,
        operator: 'gt',
        state: 'ok',
        previousState: 'resolved',
        evaluatedAt: new Date(),
      }),
    ).toBe(false);
  });
});

// =============================================================================
// windowToMs
// =============================================================================

describe('windowToMs', () => {
  it('converts minutes to milliseconds', () => {
    expect(windowToMs({ value: 5, unit: 'minutes' })).toBe(5 * 60 * 1000);
  });

  it('converts hours to milliseconds', () => {
    expect(windowToMs({ value: 2, unit: 'hours' })).toBe(2 * 60 * 60 * 1000);
  });

  it('converts days to milliseconds', () => {
    expect(windowToMs({ value: 1, unit: 'days' })).toBe(24 * 60 * 60 * 1000);
  });
});
