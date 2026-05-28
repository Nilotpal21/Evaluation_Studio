import { describe, it, expect } from 'vitest';
import type {
  GuardrailPipelineResult,
  GuardrailViolation,
  GuardrailContext,
} from '../../platform/guardrails/types';
import {
  createEmptyPipelineResult,
  addViolation,
  isTerminalAction,
} from '../../platform/guardrails/types';

describe('Pipeline types', () => {
  it('should create an empty passing result', () => {
    const result = createEmptyPipelineResult();
    expect(result.passed).toBe(true);
    expect(result.violations).toHaveLength(0);
    expect(result.warnings).toHaveLength(0);
  });

  it('should add a violation and mark as failed', () => {
    const result = createEmptyPipelineResult();
    const violation: GuardrailViolation = {
      name: 'pii_check',
      kind: 'input',
      tier: 'local',
      action: 'block',
      severity: 'high',
      message: 'PII detected',
      priority: 1,
      latencyMs: 0.5,
    };
    addViolation(result, violation);
    expect(result.passed).toBe(false);
    expect(result.violations).toHaveLength(1);
    expect(result.primaryViolation).toBe(violation);
  });

  it('should add a warning without failing', () => {
    const result = createEmptyPipelineResult();
    const warning: GuardrailViolation = {
      name: 'soft_check',
      kind: 'output',
      tier: 'local',
      action: 'warn',
      severity: 'low',
      message: 'Might be off-topic',
      priority: 10,
      latencyMs: 0.1,
    };
    addViolation(result, warning);
    expect(result.passed).toBe(true);
    expect(result.warnings).toHaveLength(1);
    expect(result.violations).toHaveLength(0);
  });

  it('should identify terminal actions', () => {
    expect(isTerminalAction('block')).toBe(true);
    expect(isTerminalAction('escalate')).toBe(true);
    expect(isTerminalAction('warn')).toBe(false);
    expect(isTerminalAction('redact')).toBe(false);
    expect(isTerminalAction('fix')).toBe(false);
    expect(isTerminalAction('filter')).toBe(false);
    expect(isTerminalAction('reask')).toBe(true);
  });

  it('should track primary violation by priority', () => {
    const result = createEmptyPipelineResult();
    addViolation(result, {
      name: 'low_pri',
      kind: 'input',
      tier: 'local',
      action: 'block',
      severity: 'high',
      message: 'Low pri',
      priority: 10,
      latencyMs: 0,
    });
    addViolation(result, {
      name: 'high_pri',
      kind: 'input',
      tier: 'local',
      action: 'block',
      severity: 'high',
      message: 'High pri',
      priority: 1,
      latencyMs: 0,
    });
    expect(result.primaryViolation?.name).toBe('high_pri');
  });
});
