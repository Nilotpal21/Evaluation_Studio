import { describe, it, expect } from 'vitest';
import { evaluateCondition, type ConditionStep } from '../executors/condition-executor.js';
import type { WorkflowContextData } from '../context/expression-resolver.js';

const ctx: WorkflowContextData = {
  trigger: {
    type: 'webhook',
    payload: { amount: 150, priority: 'high', active: true },
  },
  workflow: { id: 'wf-1', name: 'order-flow', executionId: 'exec-1' },
  tenant: { tenantId: 't1', projectId: 'p1' },
  steps: {
    'check-stock': {
      output: { inStock: true, quantity: 10 },
      status: 'completed',
    },
    'check-fraud': {
      output: { flagged: false },
      status: 'completed',
    },
    start: {
      input: { postId: 1 },
      output: { postId: 1 },
      status: 'completed',
    },
  },
  vars: { approved: false },
};

describe('evaluateCondition', () => {
  it('returns thenSteps when expression is truthy', () => {
    const step: ConditionStep = {
      id: 'cond-1',
      type: 'condition',
      expression: '{{steps.check-stock.output.inStock}}',
      thenSteps: ['step-a', 'step-b'],
      elseSteps: ['step-c'],
    };

    const result = evaluateCondition(step, ctx);
    expect(result.conditionMet).toBe(true);
    expect(result.nextSteps).toEqual(['step-a', 'step-b']);
  });

  it('returns elseSteps when expression is falsy', () => {
    const step: ConditionStep = {
      id: 'cond-2',
      type: 'condition',
      expression: '{{steps.check-fraud.output.flagged}}',
      thenSteps: ['block-order'],
      elseSteps: ['continue-order'],
    };

    const result = evaluateCondition(step, ctx);
    expect(result.conditionMet).toBe(false);
    expect(result.nextSteps).toEqual(['continue-order']);
  });

  it('returns empty array when condition is falsy and no elseSteps', () => {
    const step: ConditionStep = {
      id: 'cond-3',
      type: 'condition',
      expression: '{{vars.approved}}',
      thenSteps: ['notify-manager'],
    };

    const result = evaluateCondition(step, ctx);
    expect(result.conditionMet).toBe(false);
    expect(result.nextSteps).toEqual([]);
  });

  it('treats non-zero numbers as truthy', () => {
    const step: ConditionStep = {
      id: 'cond-4',
      type: 'condition',
      expression: '{{trigger.payload.amount}}',
      thenSteps: ['process'],
      elseSteps: ['skip'],
    };

    const result = evaluateCondition(step, ctx);
    expect(result.conditionMet).toBe(true);
    expect(result.nextSteps).toEqual(['process']);
  });

  it('treats non-empty strings as truthy', () => {
    const step: ConditionStep = {
      id: 'cond-5',
      type: 'condition',
      expression: '{{trigger.payload.priority}}',
      thenSteps: ['escalate'],
      elseSteps: ['normal'],
    };

    const result = evaluateCondition(step, ctx);
    expect(result.conditionMet).toBe(true);
    expect(result.nextSteps).toEqual(['escalate']);
  });

  it('treats undefined paths as falsy', () => {
    const step: ConditionStep = {
      id: 'cond-6',
      type: 'condition',
      expression: '{{steps.nonexistent.output.value}}',
      thenSteps: ['exists'],
      elseSteps: ['missing'],
    };

    const result = evaluateCondition(step, ctx);
    expect(result.conditionMet).toBe(false);
    expect(result.nextSteps).toEqual(['missing']);
  });

  describe('operator expressions', () => {
    it('evaluates greater_than correctly (true case)', () => {
      const step: ConditionStep = {
        id: 'cond-op-1',
        type: 'condition',
        expression: '{{trigger.payload.amount}} greater_than 100',
        thenSteps: ['high'],
        elseSteps: ['low'],
      };

      const result = evaluateCondition(step, ctx);
      expect(result.conditionMet).toBe(true);
      expect(result.branchTaken).toBe('then');
    });

    it('evaluates greater_than correctly (false case)', () => {
      const step: ConditionStep = {
        id: 'cond-op-2',
        type: 'condition',
        expression: '{{trigger.payload.amount}} greater_than 200',
        thenSteps: ['high'],
        elseSteps: ['low'],
      };

      const result = evaluateCondition(step, ctx);
      expect(result.conditionMet).toBe(false);
      expect(result.branchTaken).toBe('else');
    });

    it('evaluates less_than correctly', () => {
      const step: ConditionStep = {
        id: 'cond-op-3',
        type: 'condition',
        expression: '{{steps.check-stock.output.quantity}} less_than 5',
        thenSteps: ['reorder'],
        elseSteps: ['ok'],
      };

      const result = evaluateCondition(step, ctx);
      expect(result.conditionMet).toBe(false);
      expect(result.nextSteps).toEqual(['ok']);
    });

    it('evaluates equals correctly', () => {
      const step: ConditionStep = {
        id: 'cond-op-4',
        type: 'condition',
        expression: '{{trigger.payload.priority}} equals high',
        thenSteps: ['urgent'],
        elseSteps: ['normal'],
      };

      const result = evaluateCondition(step, ctx);
      expect(result.conditionMet).toBe(true);
      expect(result.nextSteps).toEqual(['urgent']);
    });

    it('evaluates not_equals correctly', () => {
      const step: ConditionStep = {
        id: 'cond-op-5',
        type: 'condition',
        expression: '{{trigger.payload.priority}} not_equals low',
        thenSteps: ['proceed'],
        elseSteps: ['wait'],
      };

      const result = evaluateCondition(step, ctx);
      expect(result.conditionMet).toBe(true);
    });

    it('evaluates contains correctly', () => {
      const step: ConditionStep = {
        id: 'cond-op-6',
        type: 'condition',
        expression: '{{trigger.payload.priority}} contains igh',
        thenSteps: ['found'],
        elseSteps: ['not-found'],
      };

      const result = evaluateCondition(step, ctx);
      expect(result.conditionMet).toBe(true);
    });

    it('evaluates not_contains correctly', () => {
      const step: ConditionStep = {
        id: 'cond-op-7',
        type: 'condition',
        expression: '{{trigger.payload.priority}} not_contains xyz',
        thenSteps: ['ok'],
        elseSteps: ['bad'],
      };

      const result = evaluateCondition(step, ctx);
      expect(result.conditionMet).toBe(true);
    });

    it('evaluates is_empty for null/undefined', () => {
      const step: ConditionStep = {
        id: 'cond-op-8',
        type: 'condition',
        expression: '{{steps.nonexistent.output.value}} is_empty',
        thenSteps: ['empty'],
        elseSteps: ['has-value'],
      };

      const result = evaluateCondition(step, ctx);
      expect(result.conditionMet).toBe(true);
    });

    it('evaluates is_not_empty for existing values', () => {
      const step: ConditionStep = {
        id: 'cond-op-9',
        type: 'condition',
        expression: '{{trigger.payload.priority}} is_not_empty',
        thenSteps: ['has-value'],
        elseSteps: ['empty'],
      };

      const result = evaluateCondition(step, ctx);
      expect(result.conditionMet).toBe(true);
    });

    it('evaluates matches_regex correctly', () => {
      const step: ConditionStep = {
        id: 'cond-op-10',
        type: 'condition',
        expression: '{{trigger.payload.priority}} matches_regex ^h.*h$',
        thenSteps: ['match'],
        elseSteps: ['no-match'],
      };

      const result = evaluateCondition(step, ctx);
      expect(result.conditionMet).toBe(true);
    });

    it('handles undefined field value in greater_than (NaN comparison)', () => {
      const step: ConditionStep = {
        id: 'cond-op-11',
        type: 'condition',
        expression: '{{steps.nonexistent.output.value}} greater_than 2',
        thenSteps: ['yes'],
        elseSteps: ['no'],
      };

      const result = evaluateCondition(step, ctx);
      expect(result.conditionMet).toBe(false);
      expect(result.branchTaken).toBe('else');
    });

    it('resolves context.steps.start.input by explicit path', () => {
      const step: ConditionStep = {
        id: 'cond-op-12',
        type: 'condition',
        expression: '{{context.steps.start.input.postId}} greater_than 2',
        thenSteps: ['yes'],
        elseSteps: ['no'],
      };

      const result = evaluateCondition(step, ctx);
      // postId is 1, which is NOT > 2
      expect(result.conditionMet).toBe(false);
      expect(result.branchTaken).toBe('else');
      expect(result.traces[0].resolvedValue).toBe(1);
    });

    it('returns traces with resolved field value for operator expressions', () => {
      const step: ConditionStep = {
        id: 'cond-op-13',
        type: 'condition',
        expression: '{{trigger.payload.amount}} greater_than 100',
        thenSteps: ['yes'],
        elseSteps: ['no'],
      };

      const result = evaluateCondition(step, ctx);
      expect(result.traces).toHaveLength(1);
      expect(result.traces[0].expression).toBe('{{trigger.payload.amount}}');
      expect(result.traces[0].resolvedValue).toBe(150);
    });
  });
});
