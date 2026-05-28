import { describe, it, expect } from 'vitest';
import type {
  GuardrailActionType,
  GuardrailAction,
  SeverityLevel,
} from '../../platform/ir/guardrail-action';

describe('GuardrailAction type system', () => {
  it('should define all 7 action types', () => {
    const actions: GuardrailActionType[] = [
      'block',
      'warn',
      'redact',
      'fix',
      'reask',
      'filter',
      'escalate',
    ];
    expect(actions).toHaveLength(7);
  });

  it('should define severity levels', () => {
    const levels: SeverityLevel[] = ['safe', 'low', 'medium', 'high', 'critical'];
    expect(levels).toHaveLength(5);
  });

  it('should accept a minimal GuardrailAction', () => {
    const action: GuardrailAction = { type: 'block' };
    expect(action.type).toBe('block');
    expect(action.message).toBeUndefined();
  });

  it('should accept a reask action with maxReasks', () => {
    const action: GuardrailAction = {
      type: 'reask',
      maxReasks: 3,
      message: 'Please rephrase',
    };
    expect(action.maxReasks).toBe(3);
  });

  it('should accept a fix action with strategy', () => {
    const action: GuardrailAction = {
      type: 'fix',
      fixStrategy: 'truncate',
    };
    expect(action.fixStrategy).toBe('truncate');
  });

  it('should accept a fix action with custom strategy and expression', () => {
    const action: GuardrailAction = {
      type: 'fix',
      fixStrategy: 'custom',
      fixExpression: 'abl.replace(input, "bad", "good")',
    };
    expect(action.fixStrategy).toBe('custom');
    expect(action.fixExpression).toBeDefined();
  });

  it('should accept a filter action with min length', () => {
    const action: GuardrailAction = {
      type: 'filter',
      filterMinLength: 10,
    };
    expect(action.filterMinLength).toBe(10);
  });
});
