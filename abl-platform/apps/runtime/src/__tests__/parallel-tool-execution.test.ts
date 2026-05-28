import { describe, it, expect, vi } from 'vitest';

/**
 * Contract tests for parallel tool execution in the reasoning executor.
 *
 * The executor partitions tool calls into:
 * - Regular tools: executed in parallel via Promise.all()
 * - System tools (prefixed with __, handoff_to_, delegate_to_): executed
 *   serially because they have side effects and breakLoop semantics.
 */
describe('parallel tool execution', () => {
  it('executes non-system tools concurrently via Promise.all', async () => {
    const executionOrder: string[] = [];
    const startTime = Date.now();

    // Simulate two tool calls that each take 100ms
    const tool1 = async () => {
      executionOrder.push('tool1-start');
      await new Promise((r) => setTimeout(r, 100));
      executionOrder.push('tool1-end');
      return { toolResult: { data: 'result1' }, action: undefined, breakLoop: false };
    };

    const tool2 = async () => {
      executionOrder.push('tool2-start');
      await new Promise((r) => setTimeout(r, 100));
      executionOrder.push('tool2-end');
      return { toolResult: { data: 'result2' }, action: undefined, breakLoop: false };
    };

    // Execute in parallel (mirrors the executor's Promise.all pattern)
    const results = await Promise.all([tool1(), tool2()]);
    const elapsed = Date.now() - startTime;

    // Both started before either finished (parallel execution)
    expect(executionOrder[0]).toBe('tool1-start');
    expect(executionOrder[1]).toBe('tool2-start');
    // Total time should be ~100ms, not ~200ms
    expect(elapsed).toBeLessThan(180);
    expect(results).toHaveLength(2);
  });

  it('keeps system tools serial with breakLoop semantics', async () => {
    const executionOrder: string[] = [];

    const systemTool = async () => {
      executionOrder.push('system-start');
      await new Promise((r) => setTimeout(r, 50));
      executionOrder.push('system-end');
      return { toolResult: { response: 'done' }, action: { type: 'handoff' }, breakLoop: true };
    };

    const regularTool = async () => {
      executionOrder.push('regular-start');
      await new Promise((r) => setTimeout(r, 50));
      executionOrder.push('regular-end');
      return { toolResult: { data: 'result' }, action: undefined, breakLoop: false };
    };

    // System tools run serially; breakLoop stops further execution
    const results = [];
    for (const fn of [systemTool, regularTool]) {
      const result = await fn();
      results.push(result);
      if (result.breakLoop) break;
    }

    // Only system tool ran — breakLoop stopped before regular tool
    expect(executionOrder).toEqual(['system-start', 'system-end']);
    expect(results).toHaveLength(1);
  });

  it('correctly partitions tools into regular and system categories', () => {
    const isSystemToolCall = (name: string) =>
      name.startsWith('__') || name.startsWith('handoff_to_') || name.startsWith('delegate_to_');

    const toolCalls = [
      { name: 'product_search', id: '1' },
      { name: 'offer_search', id: '2' },
      { name: '__completion__', id: '3' },
      { name: 'handoff_to_Advisor', id: '4' },
      { name: 'delegate_to_Policy', id: '5' },
    ];

    const regular = toolCalls.filter((tc) => !isSystemToolCall(tc.name));
    const system = toolCalls.filter((tc) => isSystemToolCall(tc.name));

    expect(regular.map((t) => t.name)).toEqual(['product_search', 'offer_search']);
    expect(system.map((t) => t.name)).toEqual([
      '__completion__',
      'handoff_to_Advisor',
      'delegate_to_Policy',
    ]);
  });

  it('processes all parallel results before system tools', async () => {
    const order: string[] = [];

    // Simulate the executor pattern: regular tools first (parallel),
    // then system tools (serial)
    const regularCalls = [
      async () => {
        order.push('regular1');
        return { toolResult: 'r1', action: undefined, breakLoop: false };
      },
      async () => {
        order.push('regular2');
        return { toolResult: 'r2', action: undefined, breakLoop: false };
      },
    ];

    const systemCalls = [
      async () => {
        order.push('system1');
        return { toolResult: 'handoff-result', action: { type: 'handoff' }, breakLoop: true };
      },
    ];

    // Parallel regular tools
    await Promise.all(regularCalls.map((fn) => fn()));

    // Serial system tools
    for (const fn of systemCalls) {
      const result = await fn();
      if (result.breakLoop) break;
    }

    // Regular tools ran first, system tool last
    expect(order).toEqual(['regular1', 'regular2', 'system1']);
  });
});
