/**
 * Unit tests for the Aggregate Restate activity service.
 *
 * Tests all aggregation operations (count, sum, avg, min, max, collect),
 * empty dataset handling, and missing config validation.
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

describe('AggregateService', () => {
  test('returns fail when source is missing from config', async () => {
    const { aggregateService } = await import('../pipeline/services/aggregate.service.js');
    const execute = getExecute(aggregateService);

    const ctx = createMockContext();
    const input = makeInput({
      config: {
        operations: [{ field: 'score', op: 'sum', as: 'totalScore' }],
      },
    });

    const result = await execute(ctx, input);

    expect(result.status).toBe('fail');
    expect(result.data.error).toContain("'source' and 'operations'");
  });

  test('returns fail when operations is missing from config', async () => {
    const { aggregateService } = await import('../pipeline/services/aggregate.service.js');
    const execute = getExecute(aggregateService);

    const ctx = createMockContext();
    const input = makeInput({
      config: { source: 'nodeOutputs.step1.data.items' },
    });

    const result = await execute(ctx, input);

    expect(result.status).toBe('fail');
    expect(result.data.error).toContain("'source' and 'operations'");
  });

  test('returns fail when source path does not resolve to an array', async () => {
    const { aggregateService } = await import('../pipeline/services/aggregate.service.js');
    const execute = getExecute(aggregateService);

    const ctx = createMockContext();
    const input = makeInput({
      config: {
        source: 'nodeOutputs.step1.data.single',
        operations: [{ field: 'score', op: 'sum', as: 'totalScore' }],
      },
      previousSteps: { step1: { status: 'success', data: { single: 'not-an-array' } } },
    });

    const result = await execute(ctx, input);

    expect(result.status).toBe('fail');
    expect(result.data.error).toContain('did not resolve to an array');
  });

  test('computes sum correctly', async () => {
    const { aggregateService } = await import('../pipeline/services/aggregate.service.js');
    const execute = getExecute(aggregateService);

    const ctx = createMockContext();
    const input = makeInput({
      config: {
        source: 'nodeOutputs.step1.data.items',
        operations: [{ field: 'score', op: 'sum', as: 'totalScore' }],
      },
      previousSteps: {
        step1: {
          status: 'success',
          data: {
            items: [{ score: 10 }, { score: 20 }, { score: 30 }],
          },
        },
      },
    });

    const result = await execute(ctx, input);

    expect(result.status).toBe('success');
    expect(result.data.totalScore).toBe(60);
    expect(result.data.sourceCount).toBe(3);
  });

  test('computes count correctly', async () => {
    const { aggregateService } = await import('../pipeline/services/aggregate.service.js');
    const execute = getExecute(aggregateService);

    const ctx = createMockContext();
    const input = makeInput({
      config: {
        source: 'nodeOutputs.step1.data.items',
        operations: [{ field: 'score', op: 'count', as: 'total' }],
      },
      previousSteps: {
        step1: {
          status: 'success',
          data: {
            items: [{ score: 10 }, { score: 20 }, { score: 30 }, { score: 40 }],
          },
        },
      },
    });

    const result = await execute(ctx, input);

    expect(result.status).toBe('success');
    expect(result.data.total).toBe(4);
  });

  test('computes avg correctly', async () => {
    const { aggregateService } = await import('../pipeline/services/aggregate.service.js');
    const execute = getExecute(aggregateService);

    const ctx = createMockContext();
    const input = makeInput({
      config: {
        source: 'nodeOutputs.step1.data.items',
        operations: [{ field: 'score', op: 'avg', as: 'avgScore' }],
      },
      previousSteps: {
        step1: {
          status: 'success',
          data: {
            items: [{ score: 10 }, { score: 20 }, { score: 30 }],
          },
        },
      },
    });

    const result = await execute(ctx, input);

    expect(result.status).toBe('success');
    expect(result.data.avgScore).toBe(20);
  });

  test('computes min and max correctly', async () => {
    const { aggregateService } = await import('../pipeline/services/aggregate.service.js');
    const execute = getExecute(aggregateService);

    const ctx = createMockContext();
    const input = makeInput({
      config: {
        source: 'nodeOutputs.step1.data.items',
        operations: [
          { field: 'score', op: 'min', as: 'minScore' },
          { field: 'score', op: 'max', as: 'maxScore' },
        ],
      },
      previousSteps: {
        step1: {
          status: 'success',
          data: {
            items: [{ score: 10 }, { score: 5 }, { score: 30 }, { score: 15 }],
          },
        },
      },
    });

    const result = await execute(ctx, input);

    expect(result.status).toBe('success');
    expect(result.data.minScore).toBe(5);
    expect(result.data.maxScore).toBe(30);
  });

  test('computes collect correctly', async () => {
    const { aggregateService } = await import('../pipeline/services/aggregate.service.js');
    const execute = getExecute(aggregateService);

    const ctx = createMockContext();
    const input = makeInput({
      config: {
        source: 'nodeOutputs.step1.data.items',
        operations: [{ field: 'name', op: 'collect', as: 'names' }],
      },
      previousSteps: {
        step1: {
          status: 'success',
          data: {
            items: [{ name: 'Alice' }, { name: 'Bob' }, { name: 'Carol' }],
          },
        },
      },
    });

    const result = await execute(ctx, input);

    expect(result.status).toBe('success');
    expect(result.data.names).toEqual(['Alice', 'Bob', 'Carol']);
  });

  test('handles all operations in a single call', async () => {
    const { aggregateService } = await import('../pipeline/services/aggregate.service.js');
    const execute = getExecute(aggregateService);

    const ctx = createMockContext();
    const input = makeInput({
      config: {
        source: 'nodeOutputs.step1.data.items',
        operations: [
          { field: 'score', op: 'sum', as: 'totalScore' },
          { field: 'score', op: 'count', as: 'itemCount' },
          { field: 'score', op: 'avg', as: 'avgScore' },
          { field: 'score', op: 'min', as: 'minScore' },
          { field: 'score', op: 'max', as: 'maxScore' },
          { field: 'name', op: 'collect', as: 'allNames' },
        ],
      },
      previousSteps: {
        step1: {
          status: 'success',
          data: {
            items: [
              { name: 'a', score: 10 },
              { name: 'b', score: 20 },
              { name: 'c', score: 30 },
            ],
          },
        },
      },
    });

    const result = await execute(ctx, input);

    expect(result.status).toBe('success');
    expect(result.data.totalScore).toBe(60);
    expect(result.data.itemCount).toBe(3);
    expect(result.data.avgScore).toBe(20);
    expect(result.data.minScore).toBe(10);
    expect(result.data.maxScore).toBe(30);
    expect(result.data.allNames).toEqual(['a', 'b', 'c']);
    expect(result.data.sourceCount).toBe(3);
  });

  test('handles empty dataset — returns 0/null for numeric operations', async () => {
    const { aggregateService } = await import('../pipeline/services/aggregate.service.js');
    const execute = getExecute(aggregateService);

    const ctx = createMockContext();
    const input = makeInput({
      config: {
        source: 'nodeOutputs.step1.data.items',
        operations: [
          { field: 'score', op: 'sum', as: 'totalScore' },
          { field: 'score', op: 'count', as: 'itemCount' },
          { field: 'score', op: 'avg', as: 'avgScore' },
          { field: 'score', op: 'min', as: 'minScore' },
          { field: 'score', op: 'max', as: 'maxScore' },
          { field: 'score', op: 'collect', as: 'all' },
        ],
      },
      previousSteps: {
        step1: { status: 'success', data: { items: [] } },
      },
    });

    const result = await execute(ctx, input);

    expect(result.status).toBe('success');
    expect(result.data.totalScore).toBe(0);
    expect(result.data.itemCount).toBe(0);
    expect(result.data.avgScore).toBe(0);
    expect(result.data.minScore).toBeNull();
    expect(result.data.maxScore).toBeNull();
    expect(result.data.all).toEqual([]);
    expect(result.data.sourceCount).toBe(0);
  });
});
