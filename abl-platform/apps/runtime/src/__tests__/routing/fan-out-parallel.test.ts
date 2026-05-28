/**
 * Fan-Out Parallel Execution Tests
 *
 * Verifies that handleFanOut uses InProcessExecutionRuntime for parallel
 * execution of child agent tasks, including temporal overlap, partial
 * failure handling, parent session restoration, and executionId tracing.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';
import {
  RuntimeExecutor,
  compileToResolvedAgent,
  getActiveThread,
  type RuntimeSession,
  type FanOutResult,
  type SubTaskResult,
} from '../../services/runtime-executor';

// ---------------------------------------------------------------------------
// DSL Fixtures
// ---------------------------------------------------------------------------

const agentADsl = `
AGENT: Agent_A

GOAL: "Agent A"
PERSONA: "A"
`;

const agentBDsl = `
AGENT: Agent_B

GOAL: "Agent B"
PERSONA: "B"
`;

const supervisorDsl = `
SUPERVISOR: Router

GOAL: "Route requests"
HANDOFF:
  - TO: Agent_A
    WHEN: intent contains "a"
  - TO: Agent_B
    WHEN: intent contains "b"
`;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function setupSession(executor: RuntimeExecutor): RuntimeSession {
  executor.registerAgent('Agent_A', agentADsl);
  executor.registerAgent('Agent_B', agentBDsl);
  return executor.createSessionFromResolved(
    compileToResolvedAgent([supervisorDsl, agentADsl, agentBDsl], 'Router'),
  );
}

function stubExecution(
  executor: RuntimeExecutor,
  impl?: (
    sessionId: string,
    message: string,
  ) => Promise<{ response: string; action: { type: string } }>,
) {
  const defaultImpl = vi.fn().mockResolvedValue({
    response: 'Done',
    action: { type: 'none' },
  });
  (executor as any).executeMessage = impl ?? defaultImpl;
  (executor as any).llmWiring.wireLLMClient = vi.fn().mockResolvedValue(undefined);
  return (executor as any).executeMessage as ReturnType<typeof vi.fn>;
}

// ===========================================================================

describe('Parallel Fan-Out', () => {
  let executor: RuntimeExecutor;

  beforeEach(() => {
    executor = new RuntimeExecutor();
  });

  // =========================================================================
  // Parallel execution verification
  // =========================================================================

  test('fan-out children execute in parallel (not sequentially)', async () => {
    const session = setupSession(executor);

    const startTimes: Record<string, number> = {};
    const endTimes: Record<string, number> = {};

    stubExecution(
      executor,
      vi.fn().mockImplementation(async (_sid: string, message: string) => {
        const agent = message.includes('A') ? 'Agent_A' : 'Agent_B';
        startTimes[agent] = Date.now();
        await new Promise((r) => setTimeout(r, 100));
        endTimes[agent] = Date.now();
        return { response: `${agent} done`, action: { type: 'none' } };
      }),
    );

    const routing = (executor as any).routing;
    const result: FanOutResult = await routing.handleFanOut(
      session,
      {
        tasks: [
          { target: 'Agent_A', intent: 'do A stuff' },
          { target: 'Agent_B', intent: 'do B stuff' },
        ],
      },
      undefined,
      vi.fn(),
    );

    expect(result.success).toBe(true);
    expect(result.results).toHaveLength(2);

    // Both agents must have started — verify temporal overlap
    expect(startTimes.Agent_A).toBeDefined();
    expect(startTimes.Agent_B).toBeDefined();

    // Overlap = min(endA, endB) - max(startA, startB)
    // If sequential, overlap would be negative. If parallel, positive.
    const overlapMs =
      Math.min(endTimes.Agent_A, endTimes.Agent_B) -
      Math.max(startTimes.Agent_A, startTimes.Agent_B);
    expect(overlapMs).toBeGreaterThan(0);
  });

  // =========================================================================
  // Partial failure
  // =========================================================================

  test('fan-out continues on partial failure', async () => {
    const session = setupSession(executor);

    stubExecution(
      executor,
      vi.fn().mockImplementation(async (_sid: string, message: string) => {
        if (message.includes('A')) throw new Error('Agent_A crashed');
        return { response: 'B done', action: { type: 'none' } };
      }),
    );

    const routing = (executor as any).routing;
    const result: FanOutResult = await routing.handleFanOut(
      session,
      {
        tasks: [
          { target: 'Agent_A', intent: 'do A stuff' },
          { target: 'Agent_B', intent: 'do B stuff' },
        ],
      },
      undefined,
      vi.fn(),
    );

    expect(result.success).toBe(true);
    expect(result.failedCount).toBe(1);

    const agentAResult = result.results.find((r: SubTaskResult) => r.target === 'Agent_A');
    const agentBResult = result.results.find((r: SubTaskResult) => r.target === 'Agent_B');

    expect(agentAResult?.status).toBe('error');
    expect(agentAResult?.error).toContain('Agent_A crashed');
    expect(agentBResult?.status).toBe('completed');
    expect(agentBResult?.response).toBe('B done');
  });

  // =========================================================================
  // Parent session restoration
  // =========================================================================

  test('parent session is restored after fan-out', async () => {
    const session = setupSession(executor);
    const originalAgentName = session.agentName;
    const originalIndex = session.activeThreadIndex;

    stubExecution(executor);

    const routing = (executor as any).routing;
    await routing.handleFanOut(
      session,
      {
        tasks: [
          { target: 'Agent_A', intent: 'do A stuff' },
          { target: 'Agent_B', intent: 'do B stuff' },
        ],
      },
      undefined,
      vi.fn(),
    );

    expect(session.agentName).toBe(originalAgentName);
    expect(session.activeThreadIndex).toBe(originalIndex);
  });

  test('parent session is restored even after all-failed fan-out', async () => {
    const session = setupSession(executor);
    const originalAgentName = session.agentName;

    stubExecution(executor, vi.fn().mockRejectedValue(new Error('all fail')));

    const routing = (executor as any).routing;
    await routing.handleFanOut(
      session,
      {
        tasks: [
          { target: 'Agent_A', intent: 'do A stuff' },
          { target: 'Agent_B', intent: 'do B stuff' },
        ],
      },
      undefined,
      vi.fn(),
    );

    expect(session.agentName).toBe(originalAgentName);
  });

  // =========================================================================
  // Trace events with executionId
  // =========================================================================

  test('fan-out trace events include executionId', async () => {
    const session = setupSession(executor);

    stubExecution(executor);

    const traceEvents: Array<{ type: string; data: Record<string, unknown> }> = [];
    const onTraceEvent = vi.fn((e: { type: string; data: Record<string, unknown> }) =>
      traceEvents.push(e),
    );

    const routing = (executor as any).routing;
    await routing.handleFanOut(
      session,
      { tasks: [{ target: 'Agent_A', intent: 'do A stuff' }] },
      undefined,
      onTraceEvent,
    );

    const startEvent = traceEvents.find((e) => e.type === 'fan_out_start');
    expect(startEvent).toBeDefined();
    expect(startEvent?.data.executionId).toBeDefined();
    expect(typeof startEvent?.data.executionId).toBe('string');
    expect((startEvent?.data.executionId as string).startsWith('exec-')).toBe(true);

    const taskStartEvent = traceEvents.find((e) => e.type === 'fan_out_task_start');
    expect(taskStartEvent?.data.executionId).toBe(startEvent?.data.executionId);

    const taskCompleteEvent = traceEvents.find((e) => e.type === 'fan_out_task_complete');
    expect(taskCompleteEvent?.data.executionId).toBe(startEvent?.data.executionId);

    const completeEvent = traceEvents.find((e) => e.type === 'fan_out_complete');
    expect(completeEvent?.data.executionId).toBe(startEvent?.data.executionId);
  });

  // =========================================================================
  // Child session cleanup
  // =========================================================================

  test('child sessions are cleaned up from sessions map after fan-out', async () => {
    const session = setupSession(executor);

    stubExecution(executor);

    const routing = (executor as any).routing;
    await routing.handleFanOut(
      session,
      {
        tasks: [
          { target: 'Agent_A', intent: 'do A stuff' },
          { target: 'Agent_B', intent: 'do B stuff' },
        ],
      },
      undefined,
      vi.fn(),
    );

    // Verify no fanout child sessions remain in the map
    const sessionsMap: Map<string, unknown> = (executor as any).sessions;
    for (const [key] of sessionsMap) {
      expect(key).not.toContain('__fanout__');
    }
  });

  test('child sessions are cleaned up even on failure', async () => {
    const session = setupSession(executor);

    stubExecution(executor, vi.fn().mockRejectedValue(new Error('boom')));

    const routing = (executor as any).routing;
    await routing.handleFanOut(
      session,
      {
        tasks: [
          { target: 'Agent_A', intent: 'do A stuff' },
          { target: 'Agent_B', intent: 'do B stuff' },
        ],
      },
      undefined,
      vi.fn(),
    );

    const sessionsMap: Map<string, unknown> = (executor as any).sessions;
    for (const [key] of sessionsMap) {
      expect(key).not.toContain('__fanout__');
    }
  });

  // =========================================================================
  // Result ordering and data integrity
  // =========================================================================

  test('results contain correct gathered data per agent', async () => {
    const session = setupSession(executor);

    let callCount = 0;
    stubExecution(
      executor,
      vi.fn().mockImplementation(async () => {
        callCount++;
        return { response: `Result-${callCount}`, action: { type: 'none' } };
      }),
    );

    const routing = (executor as any).routing;
    const result: FanOutResult = await routing.handleFanOut(
      session,
      {
        tasks: [
          { target: 'Agent_A', intent: 'do A stuff' },
          { target: 'Agent_B', intent: 'do B stuff' },
        ],
      },
      undefined,
      vi.fn(),
    );

    expect(result.results).toHaveLength(2);
    // Both should be completed
    expect(result.results.every((r: SubTaskResult) => r.status === 'completed')).toBe(true);
    expect(result.success).toBe(true);
    expect(result.failedCount).toBe(0);
  });

  // =========================================================================
  // Per-child unique session IDs (race condition prevention)
  // =========================================================================

  test('each child uses a unique session ID in the sessions map', async () => {
    const session = setupSession(executor);

    const observedSessionIds: string[] = [];

    stubExecution(
      executor,
      vi.fn().mockImplementation(async (sessionId: string) => {
        observedSessionIds.push(sessionId);
        // Small delay to ensure parallel execution
        await new Promise((r) => setTimeout(r, 10));
        return { response: 'done', action: { type: 'none' } };
      }),
    );

    const routing = (executor as any).routing;
    await routing.handleFanOut(
      session,
      {
        tasks: [
          { target: 'Agent_A', intent: 'do A stuff' },
          { target: 'Agent_B', intent: 'do B stuff' },
        ],
      },
      undefined,
      vi.fn(),
    );

    // Each child must have used a distinct session ID
    expect(observedSessionIds).toHaveLength(2);
    expect(new Set(observedSessionIds).size).toBe(2);

    // Session IDs should contain the fanout marker
    for (const id of observedSessionIds) {
      expect(id).toContain('__fanout__');
    }
  });
});
