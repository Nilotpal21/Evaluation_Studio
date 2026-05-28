import { describe, test, expect, vi } from 'vitest';
import { InProcessExecutionRuntime } from '../in-process-runtime.js';
import type { ExecutionPlan, ExecutionUnit, ExecutionUnitResult } from '../types.js';

function makeUnit(name: string, timeout = 5000): ExecutionUnit {
  return { agentName: name, message: 'test', timeout };
}

function makeResult(
  name: string,
  overrides: Partial<ExecutionUnitResult> = {},
): ExecutionUnitResult {
  return {
    agentName: name,
    status: 'completed',
    response: `${name} done`,
    durationMs: 10,
    ...overrides,
  };
}

describe('InProcessExecutionRuntime', () => {
  test('parallel plan executes all units concurrently', async () => {
    const runtime = new InProcessExecutionRuntime();
    const plan: ExecutionPlan = {
      type: 'parallel',
      units: [makeUnit('A'), makeUnit('B'), makeUnit('C')],
      timeout: 10000,
      onPartialFailure: 'continue',
    };
    const executionOrder: string[] = [];
    const executeUnit = vi.fn(async (unit: ExecutionUnit) => {
      executionOrder.push(`start:${unit.agentName}`);
      await new Promise((r) => setTimeout(r, 50));
      executionOrder.push(`end:${unit.agentName}`);
      return makeResult(unit.agentName);
    });
    const results = await runtime.execute(plan, executeUnit, AbortSignal.timeout(10000));
    expect(results).toHaveLength(3);
    expect(results.every((r) => r.status === 'completed')).toBe(true);
    const startIndices = executionOrder.filter((e) => e.startsWith('start:')).map((_, i) => i);
    const firstEnd = executionOrder.findIndex((e) => e.startsWith('end:'));
    expect(startIndices.every((i) => i < firstEnd)).toBe(true);
  });

  test('parallel plan with continue strategy tolerates partial failure', async () => {
    const runtime = new InProcessExecutionRuntime();
    const plan: ExecutionPlan = {
      type: 'parallel',
      units: [makeUnit('A'), makeUnit('B')],
      timeout: 10000,
      onPartialFailure: 'continue',
    };
    const executeUnit = vi.fn(async (unit: ExecutionUnit) => {
      if (unit.agentName === 'B') throw new Error('B failed');
      return makeResult(unit.agentName);
    });
    const results = await runtime.execute(plan, executeUnit, AbortSignal.timeout(10000));
    expect(results).toHaveLength(2);
    expect(results.find((r) => r.agentName === 'A')?.status).toBe('completed');
    expect(results.find((r) => r.agentName === 'B')?.status).toBe('error');
  });

  test('sequential plan executes units in order', async () => {
    const runtime = new InProcessExecutionRuntime();
    const plan: ExecutionPlan = {
      type: 'sequential',
      units: [makeUnit('A'), makeUnit('B')],
      timeout: 10000,
      onPartialFailure: 'fail-all',
    };
    const executionOrder: string[] = [];
    const executeUnit = vi.fn(async (unit: ExecutionUnit) => {
      executionOrder.push(unit.agentName);
      return makeResult(unit.agentName);
    });
    const results = await runtime.execute(plan, executeUnit, AbortSignal.timeout(10000));
    expect(results).toHaveLength(2);
    expect(executionOrder).toEqual(['A', 'B']);
  });

  test('sequential plan with fail-all stops on first failure', async () => {
    const runtime = new InProcessExecutionRuntime();
    const plan: ExecutionPlan = {
      type: 'sequential',
      units: [makeUnit('A'), makeUnit('B'), makeUnit('C')],
      timeout: 10000,
      onPartialFailure: 'fail-all',
    };
    const executeUnit = vi.fn(async (unit: ExecutionUnit) => {
      if (unit.agentName === 'B') throw new Error('B failed');
      return makeResult(unit.agentName);
    });
    const results = await runtime.execute(plan, executeUnit, AbortSignal.timeout(10000));
    expect(results).toHaveLength(2);
    expect(results[0].status).toBe('completed');
    expect(results[1].status).toBe('error');
    expect(executeUnit).toHaveBeenCalledTimes(2);
  });

  test('single plan executes one unit', async () => {
    const runtime = new InProcessExecutionRuntime();
    const plan: ExecutionPlan = {
      type: 'single',
      units: [makeUnit('A')],
      timeout: 10000,
      onPartialFailure: 'fail-all',
    };
    const executeUnit = vi.fn(async () => makeResult('A'));
    const results = await runtime.execute(plan, executeUnit, AbortSignal.timeout(10000));
    expect(results).toHaveLength(1);
    expect(results[0].status).toBe('completed');
  });

  test('per-unit timeout produces timeout result', async () => {
    const runtime = new InProcessExecutionRuntime();
    const plan: ExecutionPlan = {
      type: 'parallel',
      units: [makeUnit('A', 50)],
      timeout: 10000,
      onPartialFailure: 'continue',
    };
    const executeUnit = vi.fn(async (_unit: ExecutionUnit, signal: AbortSignal) => {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, 5000);
        signal.addEventListener('abort', () => {
          clearTimeout(timer);
          reject(new Error('Aborted'));
        });
      });
      return makeResult('A');
    });
    const results = await runtime.execute(plan, executeUnit, AbortSignal.timeout(10000));
    expect(results).toHaveLength(1);
    expect(results[0].status).toBe('timeout');
  });

  test('parent signal cancellation aborts all children', async () => {
    const runtime = new InProcessExecutionRuntime();
    const plan: ExecutionPlan = {
      type: 'parallel',
      units: [makeUnit('A'), makeUnit('B')],
      timeout: 10000,
      onPartialFailure: 'continue',
    };
    const parentController = new AbortController();
    const executeUnit = vi.fn(async (unit: ExecutionUnit, signal: AbortSignal) => {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, 5000);
        signal.addEventListener('abort', () => {
          clearTimeout(timer);
          reject(new Error('Aborted'));
        });
      });
      return makeResult(unit.agentName);
    });
    setTimeout(() => parentController.abort(), 50);
    const results = await runtime.execute(plan, executeUnit, parentController.signal);
    expect(results.every((r) => r.status === 'cancelled' || r.status === 'timeout')).toBe(true);
  });

  test('cancel-remaining aborts siblings on first failure', async () => {
    const runtime = new InProcessExecutionRuntime();
    const plan: ExecutionPlan = {
      type: 'parallel',
      units: [makeUnit('A'), makeUnit('B')],
      timeout: 10000,
      onPartialFailure: 'cancel-remaining',
    };
    const executeUnit = vi.fn(async (unit: ExecutionUnit, signal: AbortSignal) => {
      if (unit.agentName === 'A') throw new Error('A failed immediately');
      await new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, 5000);
        signal.addEventListener('abort', () => {
          clearTimeout(timer);
          reject(new Error('Cancelled'));
        });
      });
      return makeResult(unit.agentName);
    });
    const results = await runtime.execute(plan, executeUnit, AbortSignal.timeout(10000));
    expect(results.find((r) => r.agentName === 'A')?.status).toBe('error');
    expect(results.find((r) => r.agentName === 'B')?.status).toBe('cancelled');
  });
});
