/**
 * Unit tests for the Filter Restate activity service.
 *
 * Tests expression filtering (string equality, numeric comparison),
 * empty array handling, and missing config validation.
 */
import { describe, test, expect } from 'vitest';
import type { PipelineStepContext, StepOutput } from '../pipeline/types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createMockContext(): any {
  return {
    run: async (_label: string, fn: () => any) => fn(),
  };
}

function makeInput(overrides: Partial<PipelineStepContext> = {}): PipelineStepContext {
  return {
    tenantId: 'tenant-1',
    projectId: 'project-1',
    config: {},
    previousSteps: {},
    pipelineInput: {},
    ...overrides,
  };
}

function getExecute(svc: any): (ctx: any, input: PipelineStepContext) => Promise<StepOutput> {
  return (svc as any).service.execute;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('FilterService', () => {
  test('returns fail when source is missing from config', async () => {
    const { filterService } = await import('../pipeline/services/filter.service.js');
    const execute = getExecute(filterService);

    const ctx = createMockContext();
    const input = makeInput({
      config: { expression: "item.status == 'active'" },
    });

    const result = await execute(ctx, input);

    expect(result.status).toBe('fail');
    expect(result.data.error).toContain("'source' and 'expression'");
  });

  test('returns fail when expression is missing from config', async () => {
    const { filterService } = await import('../pipeline/services/filter.service.js');
    const execute = getExecute(filterService);

    const ctx = createMockContext();
    const input = makeInput({
      config: { source: 'nodeOutputs.step1.data.items' },
    });

    const result = await execute(ctx, input);

    expect(result.status).toBe('fail');
    expect(result.data.error).toContain("'source' and 'expression'");
  });

  test('returns fail when source path does not resolve to an array', async () => {
    const { filterService } = await import('../pipeline/services/filter.service.js');
    const execute = getExecute(filterService);

    const ctx = createMockContext();
    const input = makeInput({
      config: { source: 'nodeOutputs.step1.data.count', expression: 'item > 0' },
      previousSteps: { step1: { status: 'success', data: { count: 42 } } },
    });

    const result = await execute(ctx, input);

    expect(result.status).toBe('fail');
    expect(result.data.error).toContain('did not resolve to an array');
  });

  test('filters items by string equality expression', async () => {
    const { filterService } = await import('../pipeline/services/filter.service.js');
    const execute = getExecute(filterService);

    const ctx = createMockContext();
    const input = makeInput({
      config: {
        source: 'nodeOutputs.step1.data.items',
        expression: "item.status == 'active'",
      },
      previousSteps: {
        step1: {
          status: 'success',
          data: {
            items: [
              { id: 1, status: 'active' },
              { id: 2, status: 'inactive' },
              { id: 3, status: 'active' },
              { id: 4, status: 'archived' },
            ],
          },
        },
      },
    });

    const result = await execute(ctx, input);

    expect(result.status).toBe('success');
    expect(result.data.items).toHaveLength(2);
    expect(result.data.items).toEqual([
      { id: 1, status: 'active' },
      { id: 3, status: 'active' },
    ]);
    expect(result.data.count).toBe(2);
    expect(result.data.originalCount).toBe(4);
  });

  test('filters items by numeric comparison (item.score > 0.5)', async () => {
    const { filterService } = await import('../pipeline/services/filter.service.js');
    const execute = getExecute(filterService);

    const ctx = createMockContext();
    const input = makeInput({
      config: {
        source: 'nodeOutputs.eval.data.results',
        expression: 'item.score > 0.5',
      },
      previousSteps: {
        eval: {
          status: 'success',
          data: {
            results: [
              { name: 'a', score: 0.8 },
              { name: 'b', score: 0.3 },
              { name: 'c', score: 0.6 },
              { name: 'd', score: 0.1 },
            ],
          },
        },
      },
    });

    const result = await execute(ctx, input);

    expect(result.status).toBe('success');
    expect(result.data.items).toHaveLength(2);
    expect(result.data.items).toEqual([
      { name: 'a', score: 0.8 },
      { name: 'c', score: 0.6 },
    ]);
  });

  test('handles empty array — returns empty result with success', async () => {
    const { filterService } = await import('../pipeline/services/filter.service.js');
    const execute = getExecute(filterService);

    const ctx = createMockContext();
    const input = makeInput({
      config: {
        source: 'nodeOutputs.step1.data.items',
        expression: "item.status == 'active'",
      },
      previousSteps: {
        step1: { status: 'success', data: { items: [] } },
      },
    });

    const result = await execute(ctx, input);

    expect(result.status).toBe('success');
    expect(result.data.items).toEqual([]);
    expect(result.data.count).toBe(0);
    expect(result.data.originalCount).toBe(0);
  });

  test('filters with != operator', async () => {
    const { filterService } = await import('../pipeline/services/filter.service.js');
    const execute = getExecute(filterService);

    const ctx = createMockContext();
    const input = makeInput({
      config: {
        source: 'nodeOutputs.step1.data.items',
        expression: "item.role != 'admin'",
      },
      previousSteps: {
        step1: {
          status: 'success',
          data: {
            items: [
              { name: 'Alice', role: 'admin' },
              { name: 'Bob', role: 'user' },
              { name: 'Carol', role: 'user' },
            ],
          },
        },
      },
    });

    const result = await execute(ctx, input);

    expect(result.status).toBe('success');
    expect(result.data.items).toHaveLength(2);
    expect(result.data.items[0].name).toBe('Bob');
    expect(result.data.items[1].name).toBe('Carol');
  });

  test.each(['!=', '==', '>=', '<=', '>', '<'])(
    'treats operator-like literal %s as quoted string data for == filters',
    async (operatorLiteral) => {
      const { filterService } = await import('../pipeline/services/filter.service.js');
      const execute = getExecute(filterService);

      const ctx = createMockContext();
      const input = makeInput({
        config: {
          source: 'nodeOutputs.step1.data.items',
          expression: `item.label == '${operatorLiteral}'`,
        },
        previousSteps: {
          step1: {
            status: 'success',
            data: {
              items: [
                { id: 'match', label: operatorLiteral },
                { id: 'other', label: 'plain-text' },
              ],
            },
          },
        },
      });

      const result = await execute(ctx, input);

      expect(result.status).toBe('success');
      expect(result.data.items).toEqual([{ id: 'match', label: operatorLiteral }]);
      expect(result.data.count).toBe(1);
      expect(result.data.originalCount).toBe(2);
    },
  );

  test('filters with <= operator when the quoted literal contains == text', async () => {
    const { filterService } = await import('../pipeline/services/filter.service.js');
    const execute = getExecute(filterService);

    const ctx = createMockContext();
    const input = makeInput({
      config: {
        source: 'nodeOutputs.step1.data.items',
        expression: "item.label <= 'zz == marker'",
      },
      previousSteps: {
        step1: {
          status: 'success',
          data: {
            items: [{ label: 'alpha' }, { label: 'zz == marker' }, { label: 'zzz' }],
          },
        },
      },
    });

    const result = await execute(ctx, input);

    expect(result.status).toBe('success');
    expect(result.data.items).toEqual([{ label: 'alpha' }, { label: 'zz == marker' }]);
    expect(result.data.count).toBe(2);
    expect(result.data.originalCount).toBe(3);
  });

  test('filters with >= operator', async () => {
    const { filterService } = await import('../pipeline/services/filter.service.js');
    const execute = getExecute(filterService);

    const ctx = createMockContext();
    const input = makeInput({
      config: {
        source: 'input.scores',
        expression: 'item.value >= 5',
      },
      pipelineInput: {
        scores: [{ value: 3 }, { value: 5 }, { value: 7 }, { value: 1 }],
      },
    });

    const result = await execute(ctx, input);

    expect(result.status).toBe('success');
    expect(result.data.items).toHaveLength(2);
    expect(result.data.items).toEqual([{ value: 5 }, { value: 7 }]);
  });

  test('resolves source from pipelineInput (input.*)', async () => {
    const { filterService } = await import('../pipeline/services/filter.service.js');
    const execute = getExecute(filterService);

    const ctx = createMockContext();
    const input = makeInput({
      config: {
        source: 'input.users',
        expression: 'item.active == true',
      },
      pipelineInput: {
        users: [
          { name: 'Alice', active: true },
          { name: 'Bob', active: false },
        ],
      },
    });

    const result = await execute(ctx, input);

    expect(result.status).toBe('success');
    expect(result.data.items).toHaveLength(1);
    expect(result.data.items[0].name).toBe('Alice');
  });
});
