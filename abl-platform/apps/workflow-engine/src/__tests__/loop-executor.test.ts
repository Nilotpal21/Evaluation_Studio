import { describe, it, expect } from 'vitest';
import { executeLoop, resolveLoopItems, type LoopStep } from '../executors/loop-executor.js';
import type { WorkflowContextData } from '../context/expression-resolver.js';

function makeCtx(overrides?: Partial<WorkflowContextData>): WorkflowContextData {
  return {
    trigger: {
      type: 'webhook',
      payload: {
        items: ['apple', 'banana', 'cherry'],
        nested: { ids: [1, 2, 3, 4, 5] },
      },
    },
    workflow: { id: 'wf-1', name: 'loop-flow', executionId: 'exec-1' },
    tenant: { tenantId: 't1', projectId: 'p1' },
    steps: {},
    vars: {},
    ...overrides,
  };
}

describe('executeLoop', () => {
  it('iterates over array from trigger payload', () => {
    const ctx = makeCtx();
    const step: LoopStep = {
      id: 'loop-1',
      type: 'loop',
      config: { collection: '{{trigger.payload.items}}', itemVariable: 'item' },
    };

    const result = executeLoop(step, ctx);

    expect(result.iterations).toBe(3);
    expect(resolveLoopItems(step, ctx)).toEqual(['apple', 'banana', 'cherry']);
    expect(ctx.vars.item).toBeUndefined();
    expect(ctx.vars.item_index).toBeUndefined();
    expect(ctx.vars.item_count).toBeUndefined();
  });

  it('throws when collection does not resolve to an array', () => {
    const ctx = makeCtx({
      trigger: { type: 'webhook', payload: { notAnArray: 'hello' } },
    });
    const step: LoopStep = {
      id: 'loop-2',
      type: 'loop',
      config: { collection: '{{trigger.payload.notAnArray}}', itemVariable: 'item' },
    };

    expect(() => executeLoop(step, ctx)).toThrow('Loop collection did not resolve to an array');
  });

  it('returns 0 iterations for empty array', () => {
    const ctx = makeCtx({
      trigger: { type: 'webhook', payload: { items: [] } },
    });
    const step: LoopStep = {
      id: 'loop-3',
      type: 'loop',
      config: { collection: '{{trigger.payload.items}}', itemVariable: 'item' },
    };

    const result = executeLoop(step, ctx);

    expect(result.iterations).toBe(0);
    expect(resolveLoopItems(step, ctx)).toEqual([]);
    // vars should not be set for empty collection
    expect(ctx.vars.item).toBeUndefined();
    expect(ctx.vars.item_index).toBeUndefined();
    expect(ctx.vars.item_count).toBeUndefined();
  });

  it('caps the collection at maxIterations', () => {
    const ctx = makeCtx();
    const step: LoopStep = {
      id: 'loop-4',
      type: 'loop',
      config: {
        collection: '{{trigger.payload.nested.ids}}',
        itemVariable: 'id',
        maxIterations: 3,
      },
    };

    const result = executeLoop(step, ctx);

    expect(result.iterations).toBe(3);
    expect(resolveLoopItems(step, ctx)).toEqual([1, 2, 3]);
    expect(ctx.vars.id).toBeUndefined();
    expect(ctx.vars.id_index).toBeUndefined();
    expect(ctx.vars.id_count).toBeUndefined();
  });

  it('does not leak itemVariable, itemVariable_index, and itemVariable_count into parent ctx.vars', () => {
    const ctx = makeCtx({
      trigger: { type: 'webhook', payload: { items: [{ name: 'a' }, { name: 'b' }] } },
    });
    const step: LoopStep = {
      id: 'loop-5',
      type: 'loop',
      config: { collection: '{{trigger.payload.items}}', itemVariable: 'current' },
    };

    executeLoop(step, ctx);

    expect(ctx.vars.current).toBeUndefined();
    expect(ctx.vars.current_index).toBeUndefined();
    expect(ctx.vars.current_count).toBeUndefined();
  });

  it('uses default maxIterations of 1000', () => {
    const largeArray = Array.from({ length: 1500 }, (_, i) => i);
    const ctx = makeCtx({
      trigger: { type: 'webhook', payload: { items: largeArray } },
    });
    const step: LoopStep = {
      id: 'loop-6',
      type: 'loop',
      config: { collection: '{{trigger.payload.items}}', itemVariable: 'n' },
    };

    const result = executeLoop(step, ctx);

    expect(result.iterations).toBe(1000);
    expect(resolveLoopItems(step, ctx)).toHaveLength(1000);
    expect(ctx.vars.n).toBeUndefined();
    expect(ctx.vars.n_index).toBeUndefined();
    expect(ctx.vars.n_count).toBeUndefined();
  });

  it('throws when expression resolves to undefined', () => {
    const ctx = makeCtx();
    const step: LoopStep = {
      id: 'loop-7',
      type: 'loop',
      config: { collection: '{{trigger.payload.nonexistent}}', itemVariable: 'item' },
    };

    expect(() => executeLoop(step, ctx)).toThrow('Loop collection did not resolve to an array');
  });
});
