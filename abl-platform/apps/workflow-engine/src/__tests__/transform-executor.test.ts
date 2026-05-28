import { describe, it, expect } from 'vitest';
import { executeTransform, type TransformStep } from '../executors/transform-executor.js';
import type { WorkflowContextData } from '../context/expression-resolver.js';

function makeCtx(overrides?: Partial<WorkflowContextData>): WorkflowContextData {
  return {
    trigger: {
      type: 'webhook',
      payload: { orderId: 'ORD-123', amount: 99.5, customer: { name: 'Alice' } },
    },
    workflow: { id: 'wf-1', name: 'transform-flow', executionId: 'exec-1' },
    tenant: { tenantId: 't1', projectId: 'p1' },
    steps: {
      'fetch-order': {
        output: { total: 250, currency: 'USD', items: ['a', 'b'] },
        status: 'completed',
      },
    },
    vars: { discount: 10 },
    ...overrides,
  };
}

// Contract for `executeTransform` (post-ABLP-2 #7 replay-safety fix):
//
//   • Returns `{ value, outputVariable }`.
//   • Does NOT mutate `ctx.vars` — the step runs inside `restateCtx.run()`
//     in `dispatchWithRetry`, so a direct mutation would not be journaled.
//     The authoritative re-apply happens in `workflow-handler.ts` once the
//     ctx.run() block resolves, covering first-run and replay identically.
//
// These tests pin the returned value shape; they deliberately do NOT assert
// on `ctx.vars.*` — that is the handler's responsibility and has its own
// coverage in `workflow-handler.test.ts`.
describe('executeTransform', () => {
  it('resolves expression and returns { value, outputVariable }', () => {
    const ctx = makeCtx();
    const step: TransformStep = {
      id: 'tx-1',
      type: 'transform',
      config: {
        inputExpression: '{{trigger.payload.orderId}}',
        outputVariable: 'extractedOrderId',
      },
    };

    const result = executeTransform(step, ctx);

    expect(result.value).toBe('ORD-123');
    expect(result.outputVariable).toBe('extractedOrderId');
    // Replay-safety invariant: executor must NOT write ctx.vars directly.
    expect(ctx.vars.extractedOrderId).toBeUndefined();
  });

  it('works with trigger payload expressions', () => {
    const ctx = makeCtx();
    const step: TransformStep = {
      id: 'tx-2',
      type: 'transform',
      config: {
        inputExpression: '{{trigger.payload.customer.name}}',
        outputVariable: 'customerName',
      },
    };

    const result = executeTransform(step, ctx);

    expect(result.value).toBe('Alice');
    expect(result.outputVariable).toBe('customerName');
  });

  it('works with step output expressions', () => {
    const ctx = makeCtx();
    const step: TransformStep = {
      id: 'tx-3',
      type: 'transform',
      config: {
        inputExpression: '{{steps.fetch-order.output.total}}',
        outputVariable: 'orderTotal',
      },
    };

    const result = executeTransform(step, ctx);

    expect(result.value).toBe(250);
    expect(result.outputVariable).toBe('orderTotal');
  });

  it('returns a resolved primitive value ready for handler re-apply', () => {
    const ctx = makeCtx();
    const step: TransformStep = {
      id: 'tx-4',
      type: 'transform',
      config: {
        inputExpression: '{{trigger.payload.amount}}',
        outputVariable: 'rawAmount',
      },
    };

    const result = executeTransform(step, ctx);

    expect(result.value).toBe(99.5);
    expect(result.outputVariable).toBe('rawAmount');
  });

  it('preserves object types from expressions', () => {
    const ctx = makeCtx();
    const step: TransformStep = {
      id: 'tx-5',
      type: 'transform',
      config: {
        inputExpression: '{{trigger.payload.customer}}',
        outputVariable: 'customerObj',
      },
    };

    const result = executeTransform(step, ctx);

    expect(result.value).toEqual({ name: 'Alice' });
    expect(result.outputVariable).toBe('customerObj');
  });

  it('preserves array types from expressions', () => {
    const ctx = makeCtx();
    const step: TransformStep = {
      id: 'tx-6',
      type: 'transform',
      config: {
        inputExpression: '{{steps.fetch-order.output.items}}',
        outputVariable: 'orderItems',
      },
    };

    const result = executeTransform(step, ctx);

    expect(result.value).toEqual(['a', 'b']);
    expect(result.outputVariable).toBe('orderItems');
  });

  it('resolves undefined for missing paths', () => {
    const ctx = makeCtx();
    const step: TransformStep = {
      id: 'tx-7',
      type: 'transform',
      config: {
        inputExpression: '{{trigger.payload.nonexistent}}',
        outputVariable: 'missing',
      },
    };

    const result = executeTransform(step, ctx);

    expect(result.value).toBeUndefined();
    expect(result.outputVariable).toBe('missing');
  });
});
