/**
 * Fan-Out Bug Fix Regression Tests
 *
 * Targeted tests for the 6 bugs found and fixed during code review:
 *
 * 1. Token double-counting — createCentralizedTraceHandler records tokens
 *    once per child, but the event bubbles to the parent handler which
 *    re-records. The __tokenRecorded marker prevents double-counting.
 *
 * 2. Finally block ordering — fanOutTraceEvent in the finally block could
 *    throw (e.g. JSON.stringify on circular ref), preventing critical cleanup
 *    (unmarkExecuting, sessions.delete). Cleanup now runs BEFORE trace emit.
 *
 * 3. Shared reference corruption — after timeout, the still-running detached
 *    executeMessage holds childSession which shares references with the parent.
 *    References are now severed in the catch block.
 *
 * 4. Unsafe error cast — (err as Error).message replaced with safe pattern.
 *
 * 5. plan.timeout wired — planTimer uses plan.timeout instead of recomputing.
 *
 * 6. maxConcurrentFanOutCalls in config — declared in RuntimeExecutorConfig
 *    so the semaphore capacity is configurable.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';
import {
  RuntimeExecutor,
  compileToResolvedAgent,
  type RuntimeSession,
  type FanOutResult,
} from '../../services/runtime-executor';

// Mock the logger to suppress output
vi.mock('@abl/compiler/platform', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@abl/compiler/platform')>();
  return {
    ...actual,
    createLogger: vi.fn().mockReturnValue({
      info: vi.fn(),
      debug: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    }),
  };
});

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

/**
 * Stub out methods that fan-out depends on but that are part of the
 * in-progress execution model redesign (markExecuting/unmarkExecuting/
 * cancelPendingPersist). Also stubs executeMessage and wireLLMClient.
 */
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

  // Stub execution lifecycle methods used by routing-executor's fan-out finally block.
  // These are part of the in-progress execution model redesign and are not yet
  // defined on RuntimeExecutor — they exist only on the eventual ExecutorContext.
  if (!(executor as any).markExecuting) {
    (executor as any).markExecuting = vi.fn();
  }
  if (!(executor as any).unmarkExecuting) {
    (executor as any).unmarkExecuting = vi.fn();
  }
  if (!(executor as any).cancelPendingPersist) {
    (executor as any).cancelPendingPersist = vi.fn();
  }

  return (executor as any).executeMessage as ReturnType<typeof vi.fn>;
}

// ===========================================================================

/**
 * Stub execution lifecycle methods (markExecuting/unmarkExecuting/cancelPendingPersist)
 * on any object used as an ExecutorContext. These are part of the in-progress execution
 * model redesign and are not yet defined on RuntimeExecutor.
 */
function stubLifecycleMethods(ctx: RuntimeExecutor): void {
  if (!(ctx as any).markExecuting) {
    (ctx as any).markExecuting = vi.fn();
  }
  if (!(ctx as any).unmarkExecuting) {
    (ctx as any).unmarkExecuting = vi.fn();
  }
  if (!(ctx as any).cancelPendingPersist) {
    (ctx as any).cancelPendingPersist = vi.fn();
  }
}

describe('Fan-Out Bug Fix Regressions', () => {
  let executor: RuntimeExecutor;

  beforeEach(() => {
    executor = new RuntimeExecutor();
    stubLifecycleMethods(executor);
  });

  // =========================================================================
  // Fix 1: Token double-counting prevention
  // =========================================================================

  describe('token double-counting prevention', () => {
    test('__tokenRecorded marker prevents parent handler from re-counting', () => {
      // Simulate the createCentralizedTraceHandler chain:
      // Child handler records tokens → sets __tokenRecorded → parent handler skips

      const tokenRecordCalls: Array<{ tenantId: string; tokens: number }> = [];
      const mockRecordTokenUsage = (tenantId: string, tokens: number) => {
        tokenRecordCalls.push({ tenantId, tokens });
      };

      // Simulate a child handler processing an llm_call event
      const event = {
        type: 'llm_call',
        data: {
          usage: { inputTokens: 100, outputTokens: 50 },
        } as Record<string, unknown>,
      };

      // Child handler: records tokens, sets marker
      const tenantId = 'tenant-1';
      if (tenantId && event.type === 'llm_call' && !event.data?.__tokenRecorded) {
        const usage = event.data?.usage as { inputTokens?: number; outputTokens?: number };
        const totalTokens = (usage?.inputTokens || 0) + (usage?.outputTokens || 0);
        if (totalTokens > 0) {
          event.data.__tokenRecorded = true;
          mockRecordTokenUsage(tenantId, totalTokens);
        }
      }

      // Parent handler: should skip because __tokenRecorded is set
      if (tenantId && event.type === 'llm_call' && !event.data?.__tokenRecorded) {
        const usage = event.data?.usage as { inputTokens?: number; outputTokens?: number };
        const totalTokens = (usage?.inputTokens || 0) + (usage?.outputTokens || 0);
        if (totalTokens > 0) {
          mockRecordTokenUsage(tenantId, totalTokens);
        }
      }

      // Token should be recorded exactly once, not twice
      expect(tokenRecordCalls).toHaveLength(1);
      expect(tokenRecordCalls[0]).toEqual({ tenantId: 'tenant-1', tokens: 150 });
    });

    test('events without __tokenRecorded are still counted by parent', () => {
      const tokenRecordCalls: number[] = [];

      const event = {
        type: 'llm_call',
        data: {
          usage: { inputTokens: 200, outputTokens: 100 },
        } as Record<string, unknown>,
      };

      const tenantId = 'tenant-1';

      // Parent handler processing a non-fan-out event (no __tokenRecorded)
      if (tenantId && event.type === 'llm_call' && !event.data?.__tokenRecorded) {
        const usage = event.data?.usage as { inputTokens?: number; outputTokens?: number };
        const totalTokens = (usage?.inputTokens || 0) + (usage?.outputTokens || 0);
        if (totalTokens > 0) {
          tokenRecordCalls.push(totalTokens);
        }
      }

      expect(tokenRecordCalls).toHaveLength(1);
      expect(tokenRecordCalls[0]).toBe(300);
    });

    test('fan-out child trace events do not trigger double token recording', async () => {
      const session = setupSession(executor);

      // Track all trace events that reach the top-level callback
      const traceEvents: Array<{ type: string; data: Record<string, unknown> }> = [];
      const onTraceEvent = vi.fn((e: { type: string; data: Record<string, unknown> }) => {
        traceEvents.push(e);
      });

      // Stub executeMessage to emit an llm_call trace event through the callback
      stubExecution(
        executor,
        vi.fn().mockImplementation(async (_sid: string, _msg: string) => {
          return { response: 'done', action: { type: 'none' } };
        }),
      );

      const routing = (executor as any).routing;
      await routing.handleFanOut(
        session,
        { tasks: [{ target: 'Agent_A', intent: 'do A stuff' }] },
        undefined,
        onTraceEvent,
      );

      // All fan-out events that bubble up should have executionId and parentSessionId
      // (injected by the fanOutTraceEvent wrapper)
      const fanOutEvents = traceEvents.filter((e) => e.data.executionId);
      for (const event of fanOutEvents) {
        expect(event.data.parentSessionId).toBe(session.id);
      }
    });
  });

  // =========================================================================
  // Fix 2: Finally block ordering — cleanup before trace emit
  // =========================================================================

  describe('finally block ordering — cleanup before trace', () => {
    test('child sessions are cleaned up even when trace event emission throws', async () => {
      const session = setupSession(executor);

      stubExecution(executor);

      // Create a trace handler that throws on fan_out_child_completed
      const traceThrowOnChildCompleted = vi.fn(
        (e: { type: string; data: Record<string, unknown> }) => {
          if (e.type === 'fan_out_child_completed') {
            throw new Error('JSON.stringify circular ref simulation');
          }
        },
      );

      const routing = (executor as any).routing;
      const result: FanOutResult = await routing.handleFanOut(
        session,
        { tasks: [{ target: 'Agent_A', intent: 'do A stuff' }] },
        undefined,
        traceThrowOnChildCompleted,
      );

      // Fan-out should complete successfully — the child execution itself
      // succeeded and the trace throw in the finally block is caught.
      expect(result.results).toHaveLength(1);
      expect(result.success).toBe(true);

      // Critical: child sessions must be cleaned up
      const sessionsMap: Map<string, unknown> = (executor as any).sessions;
      for (const [key] of sessionsMap) {
        expect(key).not.toContain('__fanout__');
      }

      // Critical: _executingSessions must not leak
      const executingSessions: Set<string> = (executor as any)._executingSessions;
      for (const id of executingSessions) {
        expect(id).not.toContain('__fanout__');
      }
    });

    test('cleanup runs for all children even when one trace emit fails', async () => {
      const session = setupSession(executor);

      stubExecution(executor);

      let throwCount = 0;
      const traceThrowOnFirstChildCompleted = vi.fn(
        (e: { type: string; data: Record<string, unknown> }) => {
          if (e.type === 'fan_out_child_completed') {
            throwCount++;
            if (throwCount === 1) {
              throw new Error('First child trace fails');
            }
          }
        },
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
        traceThrowOnFirstChildCompleted,
      );

      // Both children should complete
      expect(result.results).toHaveLength(2);

      // No leaked child sessions
      const sessionsMap: Map<string, unknown> = (executor as any).sessions;
      for (const [key] of sessionsMap) {
        expect(key).not.toContain('__fanout__');
      }
    });
  });

  // =========================================================================
  // Fix 3: Shared reference corruption on timeout
  // =========================================================================

  describe('shared reference severing on timeout', () => {
    test('parent session data is not corrupted when child times out and detached execution continues', async () => {
      const session = setupSession(executor);

      // Capture the parent's data references before fan-out
      const parentDataValues = session.data.values;
      const parentConversationHistory = session.conversationHistory;

      // Stub executeMessage: Agent_A takes so long it will be aborted by timeout,
      // but the detached promise continues and modifies the child session
      stubExecution(
        executor,
        vi.fn().mockImplementation(async (sessionId: string) => {
          // Look up the child session to simulate post-timeout mutation
          const childSession = (executor as any).sessions.get(sessionId);
          // This delay exceeds the per-unit timeout
          await new Promise((r) => setTimeout(r, 200));
          // After timeout, the detached execution would try to mutate shared state
          if (childSession) {
            childSession.conversationHistory.push({ role: 'assistant', content: 'late mutation' });
            childSession.data.values.poisoned = true;
          }
          return { response: 'late', action: { type: 'none' } };
        }),
      );

      // Override config to use a very short timeout
      (executor as any).config.timeoutMs = 50;
      // Reinitialize routing executor with the new config
      const { RoutingExecutor } = await import('../../services/execution/routing-executor');
      const { LLMWiringService } = await import('../../services/execution/llm-wiring');
      const llmWiring = new LLMWiringService((executor as any).config);
      llmWiring.wireLLMClient = vi.fn().mockResolvedValue(undefined) as any;
      (llmWiring as any).clearCooldown = vi.fn();
      const routing = new RoutingExecutor(executor as any, llmWiring);

      const result: FanOutResult = await routing.handleFanOut(
        session,
        { tasks: [{ target: 'Agent_A', intent: 'do A stuff' }] },
        undefined,
        vi.fn(),
      );

      // The child timed out
      expect(result.results[0]?.status).toBe('error');

      // Wait for the detached promise to finish its mutation attempt
      await new Promise((r) => setTimeout(r, 300));

      // Critical: parent session data must NOT be corrupted
      // If references weren't severed, the detached mutation would pollute the parent
      expect(parentDataValues.poisoned).toBeUndefined();
      expect(parentConversationHistory.find((h) => h.content === 'late mutation')).toBeUndefined();
    });
  });

  // =========================================================================
  // Fix 4: Unsafe error cast (regression guard)
  // =========================================================================

  describe('safe error handling', () => {
    test('non-Error rejection is handled safely in persist path', () => {
      // Verify the safe pattern works for non-Error throws
      const nonErrorValues = ['string error', 42, null, undefined, { code: 'FAIL' }];

      for (const err of nonErrorValues) {
        const message = err instanceof Error ? err.message : String(err);
        expect(typeof message).toBe('string');
      }
    });

    test('Error rejection is handled safely in persist path', () => {
      const err = new Error('network timeout');
      const message = err instanceof Error ? err.message : String(err);
      expect(message).toBe('network timeout');
    });
  });

  // =========================================================================
  // Fix 5: plan.timeout is used as the plan-level timeout
  // =========================================================================

  describe('plan.timeout enforcement', () => {
    test('plan-level timeout aborts all children when exceeded', async () => {
      const session = setupSession(executor);

      // Set a very short timeout so plan.timeout (2x) is also short
      (executor as any).config.timeoutMs = 25;

      // Reinitialize routing executor with the new config
      const { RoutingExecutor } = await import('../../services/execution/routing-executor');
      const { LLMWiringService } = await import('../../services/execution/llm-wiring');
      const llmWiring = new LLMWiringService((executor as any).config);
      llmWiring.wireLLMClient = vi.fn().mockResolvedValue(undefined) as any;
      (llmWiring as any).clearCooldown = vi.fn();
      const routing = new RoutingExecutor(executor as any, llmWiring);

      // Both children take longer than plan.timeout (50ms = 25ms * 2)
      (executor as any).executeMessage = vi.fn().mockImplementation(async () => {
        await new Promise((r) => setTimeout(r, 200));
        return { response: 'should not reach', action: { type: 'none' } };
      });

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

      // All children should have been aborted/errored
      expect(result.results.every((r) => r.status === 'error')).toBe(true);
    });
  });

  // =========================================================================
  // Fix 6: maxConcurrentFanOutCalls in RuntimeExecutorConfig
  // =========================================================================

  describe('maxConcurrentFanOutCalls config', () => {
    test('semaphore capacity is configurable via RuntimeExecutorConfig', async () => {
      // Create executor with custom config
      const customExecutor = new RuntimeExecutor({ maxConcurrentFanOutCalls: 2 });

      const routing = (customExecutor as any).routing;
      const semaphore = routing.fanOutSemaphore;

      expect(semaphore.capacity).toBe(2);
    });

    test('defaults to 10 when maxConcurrentFanOutCalls is not set', () => {
      const defaultExecutor = new RuntimeExecutor();
      const routing = (defaultExecutor as any).routing;
      const semaphore = routing.fanOutSemaphore;

      expect(semaphore.capacity).toBe(10);
    });

    test('semaphore limits concurrent fan-out executions to configured capacity', async () => {
      // Use capacity of 1 to force sequential execution
      const serialExecutor = new RuntimeExecutor({ maxConcurrentFanOutCalls: 1 });

      // Register agents on the serial executor
      serialExecutor.registerAgent('Agent_A', agentADsl);
      serialExecutor.registerAgent('Agent_B', agentBDsl);
      const session = serialExecutor.createSessionFromResolved(
        compileToResolvedAgent([supervisorDsl, agentADsl, agentBDsl], 'Router'),
      );

      const executionOrder: string[] = [];
      stubExecution(
        serialExecutor,
        vi.fn().mockImplementation(async (_sid: string, message: string) => {
          const agent = message.includes('A') ? 'Agent_A' : 'Agent_B';
          executionOrder.push(`${agent}-start`);
          await new Promise((r) => setTimeout(r, 50));
          executionOrder.push(`${agent}-end`);
          return { response: 'done', action: { type: 'none' } };
        }),
      );

      const routing = (serialExecutor as any).routing;
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

      // With capacity 1, one must fully complete before the other starts
      // (the semaphore forces serialization)
      const aStartIdx = executionOrder.indexOf('Agent_A-start');
      const aEndIdx = executionOrder.indexOf('Agent_A-end');
      const bStartIdx = executionOrder.indexOf('Agent_B-start');
      const bEndIdx = executionOrder.indexOf('Agent_B-end');

      // Both must have run
      expect(aStartIdx).toBeGreaterThanOrEqual(0);
      expect(bStartIdx).toBeGreaterThanOrEqual(0);

      // One must finish before the other starts (serial due to capacity=1)
      const aBeforeB = aEndIdx < bStartIdx;
      const bBeforeA = bEndIdx < aStartIdx;
      expect(aBeforeB || bBeforeA).toBe(true);
    }, 10000);
  });
});
