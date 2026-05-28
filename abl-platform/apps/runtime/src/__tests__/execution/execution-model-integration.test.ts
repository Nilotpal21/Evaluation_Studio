/**
 * Execution Model Integration Tests
 *
 * Verifies the packages/execution primitives work end-to-end:
 * - InProcessExecutionRuntime dispatches units in parallel
 * - CountingSemaphore limits concurrency
 * - createChildSession produces isolated sessions
 * - createExecutionId generates unique IDs
 */

import { describe, test, expect } from 'vitest';
import {
  InProcessExecutionRuntime,
  CountingSemaphore,
  createChildSession,
  createExecutionId,
} from '@agent-platform/execution';
import type { ExecutionPlan, ExecutionUnit, ExecutionUnitResult } from '@agent-platform/execution';

describe('Execution Model Integration', () => {
  test('parallel execution with semaphore-limited concurrency', async () => {
    const runtime = new InProcessExecutionRuntime();
    const semaphore = new CountingSemaphore(2);

    let maxConcurrent = 0;
    let currentConcurrent = 0;

    const plan: ExecutionPlan = {
      type: 'parallel',
      units: Array.from({ length: 5 }, (_, i) => ({
        agentName: `Agent_${i}`,
        message: `task ${i}`,
        timeout: 5000,
      })),
      timeout: 10000,
      onPartialFailure: 'continue',
    };

    const executeUnit = async (
      unit: ExecutionUnit,
      _signal: AbortSignal,
    ): Promise<ExecutionUnitResult> => {
      await semaphore.acquire();
      currentConcurrent++;
      maxConcurrent = Math.max(maxConcurrent, currentConcurrent);
      await new Promise((r) => setTimeout(r, 30));
      currentConcurrent--;
      semaphore.release();

      return {
        agentName: unit.agentName,
        status: 'completed',
        response: `${unit.agentName} done`,
        durationMs: 30,
      };
    };

    const results = await runtime.execute(plan, executeUnit, AbortSignal.timeout(10000));

    expect(results).toHaveLength(5);
    expect(results.every((r) => r.status === 'completed')).toBe(true);
    expect(maxConcurrent).toBeLessThanOrEqual(2);
  });

  test('createChildSession produces isolated session with shared identity', () => {
    const parent = {
      id: 'sess-1',
      agentName: 'Supervisor',
      agentIR: { metadata: { name: 'Supervisor' } },
      conversationHistory: [{ role: 'user', content: 'hello' }],
      state: { gatherProgress: {}, conversationPhase: 'start', context: {} },
      data: { values: {}, gatheredKeys: new Set<string>() },
      isComplete: false,
      isEscalated: false,
      tenantId: 'tenant-1',
      threads: [
        {
          agentName: 'Supervisor',
          agentIR: { metadata: { name: 'Supervisor' } },
          conversationHistory: [{ role: 'user', content: 'hello' }],
          state: { gatherProgress: {}, conversationPhase: 'start', context: {} },
          data: { values: {}, gatheredKeys: new Set<string>() },
          status: 'active',
        },
        {
          agentName: 'Child',
          agentIR: { metadata: { name: 'Child' } },
          conversationHistory: [],
          state: { gatherProgress: {}, conversationPhase: 'start', context: {} },
          data: { values: { _fan_out_child: true }, gatheredKeys: new Set<string>() },
          status: 'active',
        },
      ],
      activeThreadIndex: 0,
    };

    const child = createChildSession(parent, 1);

    // Mutable fields point to child thread
    expect(child.agentName).toBe('Child');
    expect(child.data).toBe(parent.threads[1].data);

    // Identity shared from parent
    expect(child.tenantId).toBe('tenant-1');
    expect(child.id).toBe('sess-1');

    // Mutating child top-level doesn't affect parent
    child.agentName = 'Modified';
    expect(parent.agentName).toBe('Supervisor');

    // But data is same reference — mutations visible through both
    const childData = child.data as { values: Record<string, unknown>; gatheredKeys: Set<string> };
    childData.values.newKey = 'newValue';
    const threadData = parent.threads[1].data as { values: Record<string, unknown> };
    expect(threadData.values.newKey).toBe('newValue');
  });

  test('executionIds are unique', () => {
    const ids = new Set(Array.from({ length: 1000 }, () => createExecutionId()));
    expect(ids.size).toBe(1000);
  });
});
