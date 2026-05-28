import { describe, test, expect } from 'vitest';
import { denormalizeSteps } from '../routes/workflow-helpers.js';

describe('denormalizeSteps', () => {
  test('unwraps config into top-level fields for connector_action', () => {
    const steps = [
      {
        id: 'step-1',
        name: 'Call Salesforce',
        type: 'connector_action',
        config: { connector: 'salesforce', action: 'getRecord', params: '{"id":"123"}' },
        position: 0,
      },
    ];
    const result = denormalizeSteps(steps);
    expect(result[0]).toEqual({
      id: 'step-1',
      name: 'Call Salesforce',
      type: 'connector_action',
      connector: 'salesforce',
      action: 'getRecord',
      params: '{"id":"123"}',
      position: 0,
    });
  });

  test('unwraps config for delay step', () => {
    const steps = [
      { id: 's2', name: 'Wait', type: 'delay', config: { duration: '30s' }, position: 1 },
    ];
    const result = denormalizeSteps(steps);
    expect(result[0].duration).toBe('30s');
    expect(result[0].config).toBeUndefined();
  });

  test('unwraps config for condition step', () => {
    const steps = [
      {
        id: 's3',
        name: 'Check',
        type: 'condition',
        config: { expression: 'ctx.amount > 100', thenSteps: ['s4'], elseSteps: ['s5'] },
        position: 2,
      },
    ];
    const result = denormalizeSteps(steps);
    expect(result[0].expression).toBe('ctx.amount > 100');
    expect(result[0].thenSteps).toEqual(['s4']);
  });

  test('unwraps config for http step', () => {
    const steps = [
      {
        id: 's4',
        name: 'Fetch',
        type: 'http',
        config: {
          method: 'POST',
          url: 'https://api.example.com',
          headers: { 'Content-Type': 'application/json' },
          body: '{}',
        },
        position: 3,
      },
    ];
    const result = denormalizeSteps(steps);
    expect(result[0].method).toBe('POST');
    expect(result[0].url).toBe('https://api.example.com');
  });

  test('passes through already-flat steps unchanged', () => {
    const steps = [{ id: 's5', name: 'Wait', type: 'delay', duration: '10s', position: 0 }];
    const result = denormalizeSteps(steps);
    expect(result[0]).toEqual(steps[0]);
  });

  test('preserves loop step config wrapper (exception)', () => {
    const steps = [
      {
        id: 's6',
        name: 'Loop',
        type: 'loop',
        config: { collection: 'items', itemVariable: 'item', maxIterations: 100 },
        position: 0,
      },
    ];
    const result = denormalizeSteps(steps);
    expect(result[0].config).toEqual({
      collection: 'items',
      itemVariable: 'item',
      maxIterations: 100,
    });
  });

  test('preserves transform step config wrapper (exception)', () => {
    const steps = [
      {
        id: 's7',
        name: 'Transform',
        type: 'transform',
        config: { inputExpression: 'ctx.data', outputVariable: 'result' },
        position: 0,
      },
    ];
    const result = denormalizeSteps(steps);
    expect(result[0].config).toEqual({ inputExpression: 'ctx.data', outputVariable: 'result' });
  });

  test('handles empty steps array', () => {
    expect(denormalizeSteps([])).toEqual([]);
  });

  test('handles undefined steps', () => {
    expect(denormalizeSteps(undefined)).toEqual([]);
  });
});
