/**
 * Fan-Out (Multi-Intent) Tests
 *
 * Tests for the __fan_out__ system tool that dispatches multi-intent
 * messages to multiple specialist agents and synthesizes results.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';

vi.mock('../services/execution/memory-integration.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../services/execution/memory-integration.js')>();
  return {
    ...actual,
    executeRecallForAgentEvent: vi.fn().mockResolvedValue(undefined),
  };
});

import {
  RuntimeExecutor,
  compileToResolvedAgent,
  createThread,
  getActiveThread,
  syncThreadToSession,
  buildTools,
  buildSystemPrompt,
  deduplicateFanOutTasks,
  formatFanOutToolResult,
  type RuntimeSession,
  type FanOutResult,
  type SubTaskResult,
} from '../services/runtime-executor';
import { SYSTEM_TOOL_FAN_OUT } from '@abl/compiler';
import { executeRecallForAgentEvent } from '../services/execution/memory-integration.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create executor + register agents + create supervisor session. Returns all three. */
function setupSupervisorSession(
  executor: RuntimeExecutor,
  agents: string[] = ['Flight_Agent', 'Hotel_Agent'],
) {
  if (agents.includes('Flight_Agent')) executor.registerAgent('Flight_Agent', flightAgentDsl);
  if (agents.includes('Hotel_Agent')) executor.registerAgent('Hotel_Agent', hotelAgentDsl);
  if (agents.includes('Car_Agent')) executor.registerAgent('Car_Agent', carAgentDsl);
  const session = executor.createSessionFromResolved(
    compileToResolvedAgent([supervisorDsl], 'Travel_Router'),
  );
  return session;
}

/** Stub executeMessage + wireLLMClient so no real LLM calls are made. */
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

// ---------------------------------------------------------------------------
// DSL Fixtures
// ---------------------------------------------------------------------------

const flightAgentDsl = `
AGENT: Flight_Agent

GOAL: "Help with flight changes"
PERSONA: "Flight specialist"
`;

const hotelAgentDsl = `
AGENT: Hotel_Agent

GOAL: "Help with hotel bookings"
PERSONA: "Hotel specialist"
`;

const carAgentDsl = `
AGENT: Car_Agent

GOAL: "Help with car rentals"
PERSONA: "Car rental specialist"
`;

const supervisorWithToolsDsl = `
SUPERVISOR: Travel_Router
MODE: reasoning
GOAL: "Route travel requests"

TOOLS:
  search_flights(origin: string, destination: string) -> object
    description: "Search for available flights"
  get_weather(city: string) -> object
    description: "Get weather forecast"

HANDOFF:
  - TO: Flight_Agent
    WHEN: intent contains "flight"
    CONTEXT:
      summary: "Flight request"
  - TO: Hotel_Agent
    WHEN: intent contains "hotel"
    CONTEXT:
      summary: "Hotel request"
`;

const supervisorDsl = `
SUPERVISOR: Travel_Router

GOAL: "Route travel requests to specialists"

HANDOFF:
  - TO: Flight_Agent
    WHEN: intent contains "flight"
    CONTEXT:
      summary: "Flight request"

  - TO: Hotel_Agent
    WHEN: intent contains "hotel"
    CONTEXT:
      summary: "Hotel request"

  - TO: Car_Agent
    WHEN: intent contains "car"
    CONTEXT:
      summary: "Car rental request"
`;

// ===========================================================================

describe('Fan-Out (Multi-Intent)', () => {
  let executor: RuntimeExecutor;

  beforeEach(() => {
    executor = new RuntimeExecutor();
    vi.mocked(executeRecallForAgentEvent).mockClear();
  });

  // =========================================================================
  // Constants
  // =========================================================================

  test('SYSTEM_TOOL_FAN_OUT equals __fan_out__', () => {
    expect(SYSTEM_TOOL_FAN_OUT).toBe('__fan_out__');
  });

  // =========================================================================
  // Tool injection
  // =========================================================================

  describe('Tool injection', () => {
    test('injects per-agent handoff tools when agent has handoff targets', () => {
      const session = setupSupervisorSession(executor);
      const tools = buildTools(session);

      const handoffFlight = tools.find((t: any) => t.name === 'handoff_to_Flight_Agent');
      const handoffHotel = tools.find((t: any) => t.name === 'handoff_to_Hotel_Agent');
      expect(handoffFlight).toBeDefined();
      expect(handoffHotel).toBeDefined();

      // Schema shape — each tool has reason + message required
      expect(handoffFlight.input_schema.properties).toHaveProperty('message');
      expect(handoffFlight.input_schema.properties).toHaveProperty('reason');
      expect(handoffFlight.input_schema.required).toContain('message');
      expect(handoffFlight.input_schema.required).toContain('reason');
    });

    test('does NOT inject generic __fan_out__ when agent has no handoff targets', () => {
      const session = executor.createSessionFromResolved(
        compileToResolvedAgent([flightAgentDsl], 'Flight_Agent'),
      );
      const tools = buildTools(session);
      expect(tools.find((t: any) => t.name === '__fan_out__')).toBeUndefined();
      expect(tools.find((t: any) => t.name.startsWith('handoff_to_'))).toBeUndefined();
    });

    test('each handoff target gets its own routing tool', () => {
      const session = setupSupervisorSession(executor, [
        'Flight_Agent',
        'Hotel_Agent',
        'Car_Agent',
      ]);
      const tools = buildTools(session);
      expect(tools.find((t: any) => t.name === 'handoff_to_Flight_Agent')).toBeDefined();
      expect(tools.find((t: any) => t.name === 'handoff_to_Hotel_Agent')).toBeDefined();
      expect(tools.find((t: any) => t.name === 'handoff_to_Car_Agent')).toBeDefined();
    });

    test('handoff_to_* tool includes required message property', () => {
      const session = setupSupervisorSession(executor);
      const tools = buildTools(session);
      const handoff = tools.find((t: any) => t.name === 'handoff_to_Flight_Agent');
      expect(handoff).toBeDefined();
      expect(handoff.input_schema.properties).toHaveProperty('message');
      expect(handoff.input_schema.properties.message.type).toBe('string');
      expect(handoff.input_schema.required).toContain('message');
    });
  });

  // =========================================================================
  // System prompt
  // =========================================================================

  describe('System prompt', () => {
    test('includes multi-intent routing instructions for supervisors', () => {
      const session = setupSupervisorSession(executor);
      const prompt = buildSystemPrompt(session);
      // Supervisor prompt instructs routing via per-agent tools
      expect(prompt).toContain('multiple distinct intents');
      expect(prompt).toContain('handoff_to_');
    });

    test('allows multiple routing tool calls per response for supervisors', () => {
      const session = setupSupervisorSession(executor);
      const prompt = buildSystemPrompt(session);
      // Multi-intent: supervisor CAN call multiple routing tools in one response
      expect(prompt).toContain('call multiple routing tools');
    });
  });

  // =========================================================================
  // Deduplication
  // =========================================================================

  describe('deduplicateFanOutTasks', () => {
    test('merges tasks with same target, concatenating intents', () => {
      const tasks = [
        { target: 'Flight_Agent', intent: 'Change my flight' },
        { target: 'Flight_Agent', intent: 'Check flight status' },
        { target: 'Hotel_Agent', intent: 'Book a hotel' },
      ];
      const result = deduplicateFanOutTasks(tasks);
      expect(result).toHaveLength(2);
      expect(result[0].intent).toBe('Change my flight; Check flight status');
      expect(result[1].target).toBe('Hotel_Agent');
    });

    test('merges contexts for duplicate targets', () => {
      const tasks = [
        { target: 'Flight_Agent', intent: 'a', context: { flightId: '123' } },
        { target: 'Flight_Agent', intent: 'b', context: { date: '2025-01-01' } },
      ];
      const result = deduplicateFanOutTasks(tasks);
      expect(result).toHaveLength(1);
      expect(result[0].context).toEqual({ flightId: '123', date: '2025-01-01' });
    });

    test('preserves unique targets unchanged', () => {
      const tasks = [
        { target: 'Flight_Agent', intent: 'a' },
        { target: 'Hotel_Agent', intent: 'b' },
        { target: 'Car_Agent', intent: 'c' },
      ];
      expect(deduplicateFanOutTasks(tasks)).toHaveLength(3);
    });
  });

  // =========================================================================
  // Validation
  // =========================================================================

  describe('handleFanOut — validation', () => {
    test('filters out self-referential tasks', async () => {
      const session = setupSupervisorSession(executor);
      const mock = stubExecution(executor);

      const result = await (executor as any).routing.handleFanOut(session, {
        tasks: [
          { target: 'Travel_Router', intent: 'Self reference' },
          { target: 'Flight_Agent', intent: 'Change flight' },
        ],
      });

      expect(result.results).toHaveLength(1);
      expect(result.results[0].target).toBe('Flight_Agent');
      expect(mock).toHaveBeenCalledTimes(1);
    });

    test('returns error results for unknown agents without blocking others', async () => {
      executor.registerAgent('Flight_Agent', flightAgentDsl);
      const session = executor.createSessionFromResolved(
        compileToResolvedAgent([supervisorDsl], 'Travel_Router'),
      );
      stubExecution(executor);

      const result = await (executor as any).routing.handleFanOut(session, {
        tasks: [
          { target: 'NonExistent', intent: 'Do something' },
          { target: 'Flight_Agent', intent: 'Change flight' },
        ],
      });

      expect(result.results).toHaveLength(2);
      const err = result.results.find((r: SubTaskResult) => r.target === 'NonExistent');
      expect(err?.status).toBe('error');
      expect(err?.error).toContain('Agent not found');
      expect(result.results.find((r: SubTaskResult) => r.target === 'Flight_Agent')?.status).toBe(
        'completed',
      );
    });

    test('returns success=false when all tasks are invalid', async () => {
      const session = executor.createSessionFromResolved(
        compileToResolvedAgent([supervisorDsl], 'Travel_Router'),
      );

      const result = await (executor as any).routing.handleFanOut(session, {
        tasks: [
          { target: 'Unknown_1', intent: 'Task 1' },
          { target: 'Unknown_2', intent: 'Task 2' },
        ],
      });

      expect(result.success).toBe(false);
      expect(result.failedCount).toBe(2);
      expect(result.results.every((r: SubTaskResult) => r.status === 'error')).toBe(true);
    });

    test('deduplicates before executing — merged tasks run once', async () => {
      const session = setupSupervisorSession(executor);
      const mock = stubExecution(executor);

      const result = await (executor as any).routing.handleFanOut(session, {
        tasks: [
          { target: 'Flight_Agent', intent: 'Change flight' },
          { target: 'Flight_Agent', intent: 'Check status' },
          { target: 'Hotel_Agent', intent: 'Book hotel' },
        ],
      });

      // Two executable tasks after dedup (Flight_Agent + Hotel_Agent)
      expect(result.results).toHaveLength(2);
      expect(mock).toHaveBeenCalledTimes(2);
      // The merged intent should be passed to executeMessage
      const firstCallMessage = mock.mock.calls[0][1];
      expect(firstCallMessage).toContain('Change flight');
      expect(firstCallMessage).toContain('Check status');
    });
  });

  // =========================================================================
  // Execution
  // =========================================================================

  describe('handleFanOut — execution', () => {
    test('executes multiple tasks and returns combined results', async () => {
      const session = setupSupervisorSession(executor);
      let callCount = 0;
      stubExecution(
        executor,
        vi.fn().mockImplementation(() => {
          callCount++;
          return Promise.resolve({ response: `Response ${callCount}`, action: { type: 'none' } });
        }),
      );

      const result: FanOutResult = await (executor as any).routing.handleFanOut(session, {
        tasks: [
          { target: 'Flight_Agent', intent: 'Change my flight' },
          { target: 'Hotel_Agent', intent: 'Book a hotel' },
        ],
      });

      expect(result.success).toBe(true);
      expect(result.failedCount).toBe(0);
      expect(result.results).toHaveLength(2);
      const flightResult = result.results.find((r: any) => r.target === 'Flight_Agent');
      const hotelResult = result.results.find((r: any) => r.target === 'Hotel_Agent');
      expect(flightResult).toMatchObject({ status: 'completed' });
      expect(hotelResult).toMatchObject({ status: 'completed' });
      // Both should have responses (order-independent)
      expect(flightResult.response).toBeDefined();
      expect(hotelResult.response).toBeDefined();
    });

    test('handles partial failure — continues after one task errors', async () => {
      const session = setupSupervisorSession(executor);
      let callCount = 0;
      stubExecution(
        executor,
        vi.fn().mockImplementation(() => {
          callCount++;
          if (callCount === 2) return Promise.reject(new Error('LLM rate limited'));
          return Promise.resolve({ response: 'Flight changed', action: { type: 'none' } });
        }),
      );

      const result: FanOutResult = await (executor as any).routing.handleFanOut(session, {
        tasks: [
          { target: 'Flight_Agent', intent: 'Change flight' },
          { target: 'Hotel_Agent', intent: 'Book hotel' },
        ],
      });

      expect(result.success).toBe(true);
      expect(result.failedCount).toBe(1);
      const completed = result.results.find((r: any) => r.status === 'completed');
      const errored = result.results.find((r: any) => r.status === 'error');
      expect(completed).toBeDefined();
      expect(errored).toBeDefined();
      expect(errored.error).toContain('LLM rate limited');
    });

    test('handles timeout via Promise.race', async () => {
      const session = setupSupervisorSession(executor);
      // Make first task succeed, second never resolve
      let callCount = 0;
      stubExecution(
        executor,
        vi.fn().mockImplementation(() => {
          callCount++;
          if (callCount === 2) return new Promise(() => {}); // hangs forever
          return Promise.resolve({ response: 'OK', action: { type: 'none' } });
        }),
      );

      // Use a short timeout for the test
      (executor as any).config.timeoutMs = 50;

      const result: FanOutResult = await (executor as any).routing.handleFanOut(session, {
        tasks: [
          { target: 'Flight_Agent', intent: 'Change flight' },
          { target: 'Hotel_Agent', intent: 'Book hotel' },
        ],
      });

      expect(result.success).toBe(true);
      const completedTimeout = result.results.find((r: any) => r.status === 'completed');
      const timedOut = result.results.find((r: any) => r.status === 'error');
      expect(completedTimeout).toBeDefined();
      expect(timedOut).toBeDefined();
      expect(timedOut.error).toContain('timed out');
    });
  });

  // =========================================================================
  // Result storage & conversation history
  // =========================================================================

  describe('Result storage', () => {
    test('stores _last_fan_out with all results in parent thread data', async () => {
      const session = setupSupervisorSession(executor);
      stubExecution(executor);

      await (executor as any).routing.handleFanOut(session, {
        tasks: [
          { target: 'Flight_Agent', intent: 'Change flight' },
          { target: 'Hotel_Agent', intent: 'Book hotel' },
        ],
      });

      const thread = getActiveThread(session);
      const lastFanOut = thread.data.values._last_fan_out as any;
      expect(lastFanOut).toBeDefined();
      expect(lastFanOut.timestamp).toBeGreaterThan(0);
      expect(lastFanOut.results).toHaveLength(2);
    });

    test('stores per-target results in data.values for programmatic access', async () => {
      const session = setupSupervisorSession(executor);
      let callCount = 0;
      stubExecution(
        executor,
        vi.fn().mockImplementation(() => {
          callCount++;
          return Promise.resolve({ response: `Result-${callCount}`, action: { type: 'none' } });
        }),
      );

      await (executor as any).routing.handleFanOut(session, {
        tasks: [
          { target: 'Flight_Agent', intent: 'Change flight' },
          { target: 'Hotel_Agent', intent: 'Book hotel' },
        ],
      });

      const thread = getActiveThread(session);
      expect(thread.data.values._fan_out_result_Flight_Agent).toBe('Result-1');
      expect(thread.data.values._fan_out_result_Hotel_Agent).toBe('Result-2');
    });

    test('stores success AND error results in context values (not conversation history)', async () => {
      const session = setupSupervisorSession(executor);
      let callCount = 0;
      stubExecution(
        executor,
        vi.fn().mockImplementation(() => {
          callCount++;
          if (callCount === 2) return Promise.reject(new Error('Service unavailable'));
          return Promise.resolve({ response: 'Flight changed', action: { type: 'none' } });
        }),
      );

      await (executor as any).routing.handleFanOut(session, {
        tasks: [
          { target: 'Flight_Agent', intent: 'Change flight' },
          { target: 'Hotel_Agent', intent: 'Book hotel' },
        ],
      });

      const thread = getActiveThread(session);

      // (A5) Results are stored in context values, not conversation history
      expect(thread.data.values._fan_out_result_Flight_Agent).toBe('Flight changed');
      expect(thread.data.values._fan_out_result_Hotel_Agent).toContain('Service unavailable');

      // Conversation history should NOT contain raw fan-out entries
      // (results flow back via tool result → LLM synthesis → assistant message)
      const fanOutHistory = thread.conversationHistory.filter(
        (m) => typeof m.content === 'string' && m.content.startsWith('['),
      );
      expect(fanOutHistory).toHaveLength(0);
    });
  });

  // =========================================================================
  // Session state restoration
  // =========================================================================

  describe('Session restoration', () => {
    test('restores session to parent agent after successful fan-out', async () => {
      const session = setupSupervisorSession(executor);
      const originalName = session.agentName;
      const originalIndex = session.activeThreadIndex;
      stubExecution(executor);

      await (executor as any).routing.handleFanOut(session, {
        tasks: [
          { target: 'Flight_Agent', intent: 'Change flight' },
          { target: 'Hotel_Agent', intent: 'Book hotel' },
        ],
      });

      expect(session.agentName).toBe(originalName);
      expect(session.activeThreadIndex).toBe(originalIndex);
    });

    test('restores session to parent agent after all-failed fan-out', async () => {
      const session = setupSupervisorSession(executor);
      const originalName = session.agentName;
      const originalIndex = session.activeThreadIndex;
      stubExecution(executor, vi.fn().mockRejectedValue(new Error('boom')));

      await (executor as any).routing.handleFanOut(session, {
        tasks: [
          { target: 'Flight_Agent', intent: 'a' },
          { target: 'Hotel_Agent', intent: 'b' },
        ],
      });

      expect(session.agentName).toBe(originalName);
      expect(session.activeThreadIndex).toBe(originalIndex);
    });
  });

  // =========================================================================
  // Thread lifecycle
  // =========================================================================

  describe('Thread lifecycle', () => {
    test('prunes completed child threads after fan-out (I1 fix)', async () => {
      const session = setupSupervisorSession(executor);
      const initialThreadCount = session.threads.length;
      stubExecution(executor);

      await (executor as any).routing.handleFanOut(session, {
        tasks: [
          { target: 'Flight_Agent', intent: 'Change flight' },
          { target: 'Hotel_Agent', intent: 'Book hotel' },
        ],
      });

      // Child threads are pruned after fan-out to prevent unbounded growth
      expect(session.threads.length).toBe(initialThreadCount);
    });

    test('prunes child threads even on error', async () => {
      const session = setupSupervisorSession(executor);
      const initialThreadCount = session.threads.length;
      stubExecution(executor, vi.fn().mockRejectedValue(new Error('boom')));

      await (executor as any).routing.handleFanOut(session, {
        tasks: [
          { target: 'Flight_Agent', intent: 'a' },
          { target: 'Hotel_Agent', intent: 'b' },
        ],
      });

      // Child threads are pruned after fan-out, even on error
      expect(session.threads.length).toBe(initialThreadCount);
    });

    test('passes intent as executeMessage input', async () => {
      const session = setupSupervisorSession(executor);
      const mock = stubExecution(executor);

      await (executor as any).routing.handleFanOut(session, {
        tasks: [
          { target: 'Flight_Agent', intent: 'Change my flight to Paris' },
          { target: 'Hotel_Agent', intent: 'Book a hotel in London' },
        ],
      });

      // (R17) Order-independent assertions — parallel execution may reorder calls
      const callMessages = mock.mock.calls.map((c: any[]) => c[1]);
      expect(callMessages).toContain('Change my flight to Paris');
      expect(callMessages).toContain('Book a hotel in London');
    });

    test('passes context as initialData to child thread', async () => {
      const session = setupSupervisorSession(executor);
      // Capture child session data before threads are pruned
      const capturedSessions: Array<{ id: string; data: any }> = [];
      stubExecution(
        executor,
        vi.fn().mockImplementation(async (sessionId: string) => {
          const childSession = (executor as any).sessions.get(sessionId);
          if (childSession) {
            capturedSessions.push({ id: sessionId, data: { ...childSession.data } });
          }
          return { response: 'Done', action: { type: 'none' } };
        }),
      );

      await (executor as any).routing.handleFanOut(session, {
        tasks: [
          { target: 'Flight_Agent', intent: 'Change flight', context: { bookingId: 'BK-123' } },
          { target: 'Hotel_Agent', intent: 'Book hotel' },
        ],
      });

      // Verify context was passed as initialData (captured during execution, before pruning)
      const flightCapture = capturedSessions.find((c) => c.id.includes('Flight_Agent'));
      expect(flightCapture).toBeDefined();
      expect(flightCapture!.data.values.bookingId).toBe('BK-123');
      expect(flightCapture!.data.values._fan_out_child).toBe(true);
    });
  });

  // =========================================================================
  // Trace events
  // =========================================================================

  describe('Trace events', () => {
    test('emits fan_out_start → task_start/task_complete × N → fan_out_complete', async () => {
      const session = setupSupervisorSession(executor);
      stubExecution(executor);

      const events: Array<{ type: string; data: Record<string, unknown> }> = [];
      const onTrace = (e: { type: string; data: Record<string, unknown> }) => events.push(e);

      await (executor as any).routing.handleFanOut(
        session,
        {
          tasks: [
            { target: 'Flight_Agent', intent: 'a' },
            { target: 'Hotel_Agent', intent: 'b' },
          ],
        },
        undefined,
        onTrace,
      );

      const types = events.map((e) => e.type);
      // Verify ordering: start, then task pairs, then complete
      expect(types.indexOf('fan_out_start')).toBe(0);
      expect(types.lastIndexOf('fan_out_complete')).toBe(types.length - 1);

      const startEvent = events.find((e) => e.type === 'fan_out_start')!;
      expect(startEvent.data.taskCount).toBe(2);
      expect(startEvent.data.targets).toEqual(['Flight_Agent', 'Hotel_Agent']);

      const completeEvent = events.find((e) => e.type === 'fan_out_complete')!;
      expect(completeEvent.data.completedCount).toBe(2);
      expect(completeEvent.data.failedCount).toBe(0);

      // Each task gets start + complete
      expect(types.filter((t) => t === 'fan_out_task_start')).toHaveLength(2);
      expect(types.filter((t) => t === 'fan_out_task_complete')).toHaveLength(2);

      // (R16) Verify executionId is present and consistent across all fan-out events
      const executionId = startEvent.data.executionId;
      expect(executionId).toBeDefined();
      expect(typeof executionId).toBe('string');
      const fanOutEvents = events.filter((e) => e.type.startsWith('fan_out_'));
      for (const e of fanOutEvents) {
        expect(e.data.executionId).toBe(executionId);
      }

      // (R16) Verify totalDurationMs is present in fan_out_complete
      expect(typeof completeEvent.data.totalDurationMs).toBe('number');
    });

    test('emits error status in fan_out_task_complete on failure', async () => {
      const session = setupSupervisorSession(executor);
      stubExecution(executor, vi.fn().mockRejectedValue(new Error('oops')));

      const events: Array<{ type: string; data: Record<string, unknown> }> = [];
      await (executor as any).routing.handleFanOut(
        session,
        {
          tasks: [
            { target: 'Flight_Agent', intent: 'a' },
            { target: 'Hotel_Agent', intent: 'b' },
          ],
        },
        undefined,
        (e: any) => events.push(e),
      );

      const taskCompletes = events.filter((e) => e.type === 'fan_out_task_complete');
      expect(taskCompletes).toHaveLength(2);
      expect(taskCompletes[0].data.status).toBe('error');
      expect(taskCompletes[0].data.error).toContain('oops');

      // (R16) executionId consistent even on error path
      const fanOutEvents = events.filter((e) => e.type.startsWith('fan_out_'));
      const executionId = fanOutEvents[0].data.executionId;
      expect(executionId).toBeDefined();
      for (const e of fanOutEvents) {
        expect(e.data.executionId).toBe(executionId);
      }

      // (R16) durationMs present on task_complete events
      for (const tc of taskCompletes) {
        expect(typeof tc.data.durationMs).toBe('number');
      }
    });
  });

  // =========================================================================
  // Recursive prevention
  // =========================================================================

  describe('Recursive prevention', () => {
    test('blocks fan-out from within a fan-out child thread (via _fan_out_child marker)', async () => {
      const session = setupSupervisorSession(executor);

      // Simulate being in a fan-out child thread by creating a thread with the marker
      const childThread = createThread(session, 'Flight_Agent', null, {
        handoffFrom: 'Travel_Router',
        initialData: { _fan_out_child: true },
      });
      session.activeThreadIndex = session.threads.length - 1;
      syncThreadToSession(session);

      const result = await (executor as any).reasoning.executeToolCall(session, {
        id: 'test-id',
        name: '__fan_out__',
        input: {
          tasks: [
            { target: 'Flight_Agent', intent: 'a' },
            { target: 'Hotel_Agent', intent: 'b' },
          ],
        },
      });

      expect(result.toolResult.success).toBe(false);
      expect(result.toolResult.error).toContain('Cannot fan-out from within a fan-out task');
      expect(result.breakLoop).toBeFalsy();
    });

    test('allows fan-out from a delegate child thread (not a fan-out child)', async () => {
      const session = setupSupervisorSession(executor);
      stubExecution(executor);

      // Simulate being in a delegate child (handoffFrom is set but NO _fan_out_child)
      const delegateThread = createThread(session, 'Travel_Router', session.agentIR, {
        handoffFrom: 'Some_Parent',
      });
      session.activeThreadIndex = session.threads.length - 1;
      syncThreadToSession(session);

      const result = await (executor as any).reasoning.executeToolCall(session, {
        id: 'test-id',
        name: '__fan_out__',
        input: {
          tasks: [
            { target: 'Flight_Agent', intent: 'a' },
            { target: 'Hotel_Agent', intent: 'b' },
          ],
        },
      });

      // Should NOT be blocked — delegate children can fan-out
      expect(result.toolResult.success).toBeDefined();
      expect(result.toolResult.error).toBeUndefined();
    });
  });

  // =========================================================================
  // executeToolCall integration
  // =========================================================================

  describe('executeToolCall integration', () => {
    test('does not break loop after fan-out (results go back to LLM for synthesis)', async () => {
      const session = setupSupervisorSession(executor);
      stubExecution(executor);

      const result = await (executor as any).reasoning.executeToolCall(session, {
        id: 'test-id',
        name: '__fan_out__',
        input: {
          tasks: [
            { target: 'Flight_Agent', intent: 'a' },
            { target: 'Hotel_Agent', intent: 'b' },
          ],
        },
      });

      expect(result.breakLoop).toBeFalsy();
      expect(result.action?.type).toBe('fan_out');
    });

    test('returns structured tool result with summary for LLM', async () => {
      const session = setupSupervisorSession(executor);
      let c = 0;
      stubExecution(
        executor,
        vi.fn().mockImplementation(() => {
          c++;
          if (c === 2) return Promise.reject(new Error('Service down'));
          return Promise.resolve({ response: 'Flight changed', action: { type: 'none' } });
        }),
      );

      const result = await (executor as any).reasoning.executeToolCall(session, {
        id: 'test-id',
        name: '__fan_out__',
        input: {
          tasks: [
            { target: 'Flight_Agent', intent: 'a' },
            { target: 'Hotel_Agent', intent: 'b' },
          ],
        },
      });

      const toolResult = result.toolResult;
      expect(toolResult.success).toBe(true);
      expect(toolResult.summary).toContain('1/2 tasks succeeded');
      expect(toolResult.summary).toContain('[Flight_Agent] SUCCESS');
      expect(toolResult.summary).toContain('[Hotel_Agent] FAILED');
      expect(toolResult.summary).toContain('Synthesis Instructions');
      expect(toolResult.results).toHaveLength(2);
    });
  });

  // =========================================================================
  // formatFanOutToolResult
  // =========================================================================

  describe('formatFanOutToolResult', () => {
    test('formats all-success result', () => {
      const fanOutResult: FanOutResult = {
        success: true,
        failedCount: 0,
        results: [
          { target: 'Flight_Agent', status: 'completed', response: 'Flight changed to Paris' },
          { target: 'Hotel_Agent', status: 'completed', response: 'Hotel booked in Paris' },
        ],
      };
      const formatted = formatFanOutToolResult(fanOutResult);
      expect(formatted.success).toBe(true);
      expect(formatted.summary).toContain('2/2 tasks succeeded');
      expect(formatted.summary).toContain('[Flight_Agent] SUCCESS: Flight changed to Paris');
      expect(formatted.summary).toContain('[Hotel_Agent] SUCCESS: Hotel booked in Paris');
      expect(formatted.summary).toContain('Synthesis Instructions');
      expect(formatted.summary).toContain('single cohesive response');
    });

    test('formats partial-failure result', () => {
      const fanOutResult: FanOutResult = {
        success: true,
        failedCount: 1,
        results: [
          { target: 'Flight_Agent', status: 'completed', response: 'Done' },
          { target: 'Hotel_Agent', status: 'error', error: 'Timeout' },
        ],
      };
      const formatted = formatFanOutToolResult(fanOutResult);
      expect(formatted.summary).toContain('1/2 tasks succeeded');
      expect(formatted.summary).toContain('[Hotel_Agent] FAILED: Timeout');
      expect(formatted.summary).toContain('failed tasks');
    });

    test('formats all-failure result', () => {
      const fanOutResult: FanOutResult = {
        success: false,
        failedCount: 2,
        results: [
          { target: 'A', status: 'error', error: 'err1' },
          { target: 'B', status: 'error', error: 'err2' },
        ],
      };
      const formatted = formatFanOutToolResult(fanOutResult);
      expect(formatted.success).toBe(false);
      expect(formatted.summary).toContain('0/2 tasks succeeded');
    });
  });

  // =========================================================================
  // A4: Concurrent fan-out guard
  // =========================================================================

  describe('Concurrent fan-out guard (A4)', () => {
    test('blocks second concurrent fan-out on same session', async () => {
      const session = setupSupervisorSession(executor);
      // Use short timeout so the in-flight fan-out doesn't hang for 60s
      (executor as any).config.timeoutMs = 100;

      const resolvers: Array<(v: { response: string; action: { type: string } }) => void> = [];
      stubExecution(
        executor,
        vi.fn().mockImplementation(
          () =>
            new Promise<{ response: string; action: { type: string } }>((r) => {
              resolvers.push(r);
            }),
        ),
      );

      // Start first fan-out (stays in-flight)
      const first = (executor as any).routing.handleFanOut(session, {
        tasks: [
          { target: 'Flight_Agent', intent: 'a' },
          { target: 'Hotel_Agent', intent: 'b' },
        ],
      });

      // Yield to let first call register in _activeFanOutSessions
      await new Promise((r) => setTimeout(r, 10));

      // Second call hits the guard
      const second = await (executor as any).routing.handleFanOut(session, {
        tasks: [{ target: 'Flight_Agent', intent: 'c' }],
      });
      expect(second.success).toBe(false);
      expect(second.results[0].target).toBe('_guard');
      expect(second.results[0].error).toContain('already in progress');

      // Release first call's children
      for (const resolve of resolvers) {
        resolve({ response: 'done', action: { type: 'none' } });
      }
      const firstResult = await first;
      expect(firstResult.success).toBe(true);
    });

    test('guard is released after completion — subsequent calls succeed', async () => {
      const session = setupSupervisorSession(executor);
      stubExecution(executor);

      // First call completes
      await (executor as any).routing.handleFanOut(session, {
        tasks: [
          { target: 'Flight_Agent', intent: 'a' },
          { target: 'Hotel_Agent', intent: 'b' },
        ],
      });

      // Second call should succeed (guard was released)
      const second = await (executor as any).routing.handleFanOut(session, {
        tasks: [
          { target: 'Flight_Agent', intent: 'c' },
          { target: 'Hotel_Agent', intent: 'd' },
        ],
      });
      expect(second.success).toBe(true);
    });

    test('guard is released even when all children fail', async () => {
      const session = setupSupervisorSession(executor);
      stubExecution(executor, vi.fn().mockRejectedValue(new Error('crash')));

      await (executor as any).routing.handleFanOut(session, {
        tasks: [
          { target: 'Flight_Agent', intent: 'a' },
          { target: 'Hotel_Agent', intent: 'b' },
        ],
      });

      // Guard released — next call should work
      stubExecution(executor);
      const second = await (executor as any).routing.handleFanOut(session, {
        tasks: [
          { target: 'Flight_Agent', intent: 'c' },
          { target: 'Hotel_Agent', intent: 'd' },
        ],
      });
      expect(second.success).toBe(true);
    });
  });

  // =========================================================================
  // A1: Child session lifecycle trace events
  // =========================================================================

  describe('Child session lifecycle trace events (A1)', () => {
    test('fires child lifecycle recall on the child session only', async () => {
      const session = setupSupervisorSession(executor);
      stubExecution(executor);

      await (executor as any).routing.handleFanOut(session, {
        tasks: [
          { target: 'Flight_Agent', intent: 'book flight' },
          { target: 'Hotel_Agent', intent: 'book hotel' },
        ],
      });

      const recallCalls = vi.mocked(executeRecallForAgentEvent).mock.calls;
      expect(recallCalls).toHaveLength(4);
      expect(
        recallCalls
          .filter(([, agentName]) => agentName === 'Flight_Agent')
          .map(([, , phase]) => String(phase)),
      ).toEqual(['before', 'after']);
      expect(
        recallCalls
          .filter(([, agentName]) => agentName === 'Hotel_Agent')
          .map(([, , phase]) => String(phase)),
      ).toEqual(['before', 'after']);

      for (const [recallSession, agentName] of recallCalls) {
        expect(recallSession.id).toContain('__fanout__');
        expect(recallSession.id).not.toBe(session.id);
        expect(recallSession.agentIR?.name ?? recallSession.agentName).toBe(agentName);
      }
    });

    test('emits fan_out_child_created for each child', async () => {
      const session = setupSupervisorSession(executor);
      stubExecution(executor);

      const events: Array<{ type: string; data: Record<string, unknown> }> = [];
      await (executor as any).routing.handleFanOut(
        session,
        {
          tasks: [
            { target: 'Flight_Agent', intent: 'book flight' },
            { target: 'Hotel_Agent', intent: 'book hotel' },
          ],
        },
        undefined,
        (e: any) => events.push(e),
      );

      const created = events.filter((e) => e.type === 'fan_out_child_created');
      expect(created).toHaveLength(2);

      // Each has childSessionId, agentName, intent
      for (const e of created) {
        expect(typeof e.data.childSessionId).toBe('string');
        expect(e.data.childSessionId as string).toContain('__fanout__');
        expect(e.data.agentName).toBeDefined();
        expect(e.data.intent).toBeDefined();
      }

      // Verify agent names match
      const agentNames = created.map((e) => e.data.agentName);
      expect(agentNames).toContain('Flight_Agent');
      expect(agentNames).toContain('Hotel_Agent');
    });

    test('emits fan_out_child_completed with status=completed on success', async () => {
      const session = setupSupervisorSession(executor);
      stubExecution(executor);

      const events: Array<{ type: string; data: Record<string, unknown> }> = [];
      await (executor as any).routing.handleFanOut(
        session,
        {
          tasks: [
            { target: 'Flight_Agent', intent: 'a' },
            { target: 'Hotel_Agent', intent: 'b' },
          ],
        },
        undefined,
        (e: any) => events.push(e),
      );

      const completed = events.filter((e) => e.type === 'fan_out_child_completed');
      expect(completed).toHaveLength(2);

      for (const e of completed) {
        expect(e.data.status).toBe('completed');
        expect(e.data.error).toBeUndefined();
        expect(typeof e.data.durationMs).toBe('number');
        expect(typeof e.data.childSessionId).toBe('string');
      }
    });

    test('emits fan_out_child_completed with status=error on failure', async () => {
      const session = setupSupervisorSession(executor);
      stubExecution(executor, vi.fn().mockRejectedValue(new Error('agent crashed')));

      const events: Array<{ type: string; data: Record<string, unknown> }> = [];
      await (executor as any).routing.handleFanOut(
        session,
        {
          tasks: [
            { target: 'Flight_Agent', intent: 'a' },
            { target: 'Hotel_Agent', intent: 'b' },
          ],
        },
        undefined,
        (e: any) => events.push(e),
      );

      const completed = events.filter((e) => e.type === 'fan_out_child_completed');
      expect(completed).toHaveLength(2);

      for (const e of completed) {
        expect(e.data.status).toBe('error');
        expect(e.data.error).toContain('agent crashed');
        expect(typeof e.data.durationMs).toBe('number');
      }

      const recallCalls = vi.mocked(executeRecallForAgentEvent).mock.calls;
      expect(recallCalls).toHaveLength(4);
      const afterCalls = recallCalls.filter(([, , phase]) => phase === 'after');
      expect(afterCalls).toHaveLength(2);
      for (const [recallSession] of afterCalls) {
        expect(recallSession.id).toContain('__fanout__');
        expect(recallSession.id).not.toBe(session.id);
      }
    });

    test('child_created fires before child_completed for each agent', async () => {
      const session = setupSupervisorSession(executor);
      stubExecution(executor);

      const events: Array<{ type: string; data: Record<string, unknown> }> = [];
      await (executor as any).routing.handleFanOut(
        session,
        {
          tasks: [
            { target: 'Flight_Agent', intent: 'a' },
            { target: 'Hotel_Agent', intent: 'b' },
          ],
        },
        undefined,
        (e: any) => events.push(e),
      );

      const types = events.map((e) => e.type);
      const firstCreated = types.indexOf('fan_out_child_created');
      const firstCompleted = types.indexOf('fan_out_child_completed');
      expect(firstCreated).toBeLessThan(firstCompleted);
    });
  });

  // =========================================================================
  // A2: wireToolExecutor per child
  // =========================================================================

  describe('wireToolExecutor per child (A2)', () => {
    test('rewires wireToolExecutor for each child even when the parent already has one', async () => {
      const session = setupSupervisorSession(executor);
      session.compilationOutput = { agents: {} } as any;
      const wireSpy = vi.spyOn((executor as any).llmWiring, 'wireToolExecutor');
      stubExecution(executor);

      await (executor as any).routing.handleFanOut(session, {
        tasks: [
          { target: 'Flight_Agent', intent: 'a' },
          { target: 'Hotel_Agent', intent: 'b' },
        ],
      });

      expect(wireSpy).toHaveBeenCalledTimes(2);
      for (const call of wireSpy.mock.calls) {
        const childSession = call[0] as any;
        expect(childSession.id).toContain('__fanout__');
      }
    });

    test('calls wireToolExecutor when child has no inherited toolExecutor', async () => {
      const session = setupSupervisorSession(executor);
      session.compilationOutput = { agents: {} } as any;
      // Remove the parent's toolExecutor so children won't inherit one
      delete (session as any).toolExecutor;
      const wireSpy = vi.spyOn((executor as any).llmWiring, 'wireToolExecutor');
      stubExecution(executor);

      await (executor as any).routing.handleFanOut(session, {
        tasks: [
          { target: 'Flight_Agent', intent: 'a' },
          { target: 'Hotel_Agent', intent: 'b' },
        ],
      });

      expect(wireSpy).toHaveBeenCalledTimes(2);
      // Each call receives a child session (not the parent)
      for (const call of wireSpy.mock.calls) {
        const childSession = call[0] as any;
        expect(childSession.id).toContain('__fanout__');
      }
    });

    test('still rewires each child when compilationOutput is absent', async () => {
      const session = setupSupervisorSession(executor);
      delete (session as any).compilationOutput;
      const wireSpy = vi.spyOn((executor as any).llmWiring, 'wireToolExecutor');
      stubExecution(executor);

      await (executor as any).routing.handleFanOut(session, {
        tasks: [
          { target: 'Flight_Agent', intent: 'a' },
          { target: 'Hotel_Agent', intent: 'b' },
        ],
      });

      expect(wireSpy).toHaveBeenCalledTimes(2);
    });
  });

  // =========================================================================
  // A3: clearCooldown per child
  // =========================================================================

  describe('clearCooldown per child (A3)', () => {
    test('calls clearCooldown for each child session on success', async () => {
      const session = setupSupervisorSession(executor);
      const clearSpy = vi.spyOn((executor as any).llmWiring, 'clearCooldown');
      stubExecution(executor);

      await (executor as any).routing.handleFanOut(session, {
        tasks: [
          { target: 'Flight_Agent', intent: 'a' },
          { target: 'Hotel_Agent', intent: 'b' },
        ],
      });

      expect(clearSpy).toHaveBeenCalledTimes(2);
      for (const call of clearSpy.mock.calls) {
        expect(call[0]).toContain('__fanout__');
      }
    });

    test('calls clearCooldown even when child execution fails', async () => {
      const session = setupSupervisorSession(executor);
      const clearSpy = vi.spyOn((executor as any).llmWiring, 'clearCooldown');
      stubExecution(executor, vi.fn().mockRejectedValue(new Error('crash')));

      await (executor as any).routing.handleFanOut(session, {
        tasks: [
          { target: 'Flight_Agent', intent: 'a' },
          { target: 'Hotel_Agent', intent: 'b' },
        ],
      });

      expect(clearSpy).toHaveBeenCalledTimes(2);
    });
  });

  // =========================================================================
  // Cleanup verification
  // =========================================================================

  describe('Cleanup verification', () => {
    test('child sessions are removed from sessions map after fan-out', async () => {
      const session = setupSupervisorSession(executor);
      stubExecution(executor);

      await (executor as any).routing.handleFanOut(session, {
        tasks: [
          { target: 'Flight_Agent', intent: 'a' },
          { target: 'Hotel_Agent', intent: 'b' },
        ],
      });

      // Only parent session should remain
      const sessionsMap = (executor as any).sessions as Map<string, unknown>;
      const fanOutSessions = [...sessionsMap.keys()].filter((k: string) =>
        k.includes('__fanout__'),
      );
      expect(fanOutSessions).toHaveLength(0);
    });

    test('child sessions are cleaned up even when execution fails', async () => {
      const session = setupSupervisorSession(executor);
      stubExecution(executor, vi.fn().mockRejectedValue(new Error('crash')));

      await (executor as any).routing.handleFanOut(session, {
        tasks: [
          { target: 'Flight_Agent', intent: 'a' },
          { target: 'Hotel_Agent', intent: 'b' },
        ],
      });

      const sessionsMap = (executor as any).sessions as Map<string, unknown>;
      const fanOutSessions = [...sessionsMap.keys()].filter((k: string) =>
        k.includes('__fanout__'),
      );
      expect(fanOutSessions).toHaveLength(0);
    });

    test('child threads are pruned from session.threads after fan-out', async () => {
      const session = setupSupervisorSession(executor);
      stubExecution(executor);
      const threadCountBefore = session.threads.length;

      await (executor as any).routing.handleFanOut(session, {
        tasks: [
          { target: 'Flight_Agent', intent: 'a' },
          { target: 'Hotel_Agent', intent: 'b' },
        ],
      });

      // Thread count should return to original (child threads pruned)
      expect(session.threads.length).toBe(threadCountBefore);
    });

    test('cancelPendingPersist and unmarkExecuting called for each child', async () => {
      const session = setupSupervisorSession(executor);
      const cancelSpy = vi.spyOn(executor as any, 'cancelPendingPersist');
      const unmarkSpy = vi.spyOn(executor as any, 'unmarkExecuting');
      stubExecution(executor);

      await (executor as any).routing.handleFanOut(session, {
        tasks: [
          { target: 'Flight_Agent', intent: 'a' },
          { target: 'Hotel_Agent', intent: 'b' },
        ],
      });

      expect(cancelSpy).toHaveBeenCalledTimes(2);
      expect(unmarkSpy).toHaveBeenCalledTimes(2);
      for (const call of cancelSpy.mock.calls) {
        expect(call[0]).toContain('__fanout__');
      }
    });

    test('onChunk is NOT forwarded to child executions', async () => {
      const session = setupSupervisorSession(executor);
      const onChunk = vi.fn();
      stubExecution(executor);

      await (executor as any).routing.handleFanOut(
        session,
        {
          tasks: [
            { target: 'Flight_Agent', intent: 'a' },
            { target: 'Hotel_Agent', intent: 'b' },
          ],
        },
        onChunk,
      );

      // onChunk should NOT be called during fan-out — children don't stream
      expect(onChunk).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // Edge cases
  // =========================================================================

  describe('Edge cases', () => {
    test('empty tasks array returns success=false with empty results', async () => {
      const session = setupSupervisorSession(executor);
      stubExecution(executor);

      const result = await (executor as any).routing.handleFanOut(session, {
        tasks: [],
      });

      expect(result.success).toBe(false);
      expect(result.results).toHaveLength(0);
      expect(result.failedCount).toBe(0);
    });

    test('_last_fan_out stores error message in response field for failed tasks', async () => {
      const session = setupSupervisorSession(executor);
      let callCount = 0;
      stubExecution(
        executor,
        vi.fn().mockImplementation(() => {
          callCount++;
          if (callCount === 2) return Promise.reject(new Error('Service down'));
          return Promise.resolve({ response: 'Flight OK', action: { type: 'none' } });
        }),
      );

      await (executor as any).routing.handleFanOut(session, {
        tasks: [
          { target: 'Flight_Agent', intent: 'a' },
          { target: 'Hotel_Agent', intent: 'b' },
        ],
      });

      const thread = getActiveThread(session);
      const lastFanOut = thread.data.values._last_fan_out as {
        results: Array<{ target: string; status: string; response: string }>;
      };

      // Success result
      const flightResult = lastFanOut.results.find((r) => r.target === 'Flight_Agent')!;
      expect(flightResult.status).toBe('completed');
      expect(flightResult.response).toBe('Flight OK');

      // Error result — error message stored in response field (not a separate error key)
      const hotelResult = lastFanOut.results.find((r) => r.target === 'Hotel_Agent')!;
      expect(hotelResult.status).toBe('error');
      expect(hotelResult.response).toContain('Service down');
    });

    test('A4 guard error is handled cleanly in executeToolCall (no _guard leak)', async () => {
      const session = setupSupervisorSession(executor);
      (executor as any).config.timeoutMs = 100;

      const resolvers: Array<(v: { response: string; action: { type: string } }) => void> = [];
      stubExecution(
        executor,
        vi.fn().mockImplementation(
          () =>
            new Promise<{ response: string; action: { type: string } }>((r) => {
              resolvers.push(r);
            }),
        ),
      );

      // Start first fan-out (stays in-flight)
      const firstPromise = (executor as any).routing.handleFanOut(session, {
        tasks: [
          { target: 'Flight_Agent', intent: 'a' },
          { target: 'Hotel_Agent', intent: 'b' },
        ],
      });
      await new Promise((r) => setTimeout(r, 10));

      // executeToolCall with a second fan-out should get a clean error (no _guard)
      const result = await (executor as any).reasoning.executeToolCall(session, {
        id: 'test-id',
        name: '__fan_out__',
        input: {
          tasks: [{ target: 'Flight_Agent', intent: 'c' }],
        },
      });

      expect(result.toolResult.success).toBe(false);
      expect(result.toolResult.error).toContain('already in progress');
      // _guard sentinel should NOT appear in the tool result
      expect(JSON.stringify(result.toolResult)).not.toContain('_guard');

      // Clean up
      for (const resolve of resolvers) {
        resolve({ response: 'done', action: { type: 'none' } });
      }
      await firstPromise;
    });
  });

  // =========================================================================
  // Mixed agent + tool fan-out
  // =========================================================================

  describe('mixed agent + tool fan-out', () => {
    test('tool-type tasks call toolExecutor.execute() directly, not child agent loop', async () => {
      executor.registerAgent('Flight_Agent', flightAgentDsl);
      executor.registerAgent('Hotel_Agent', hotelAgentDsl);
      const session = executor.createSessionFromResolved(
        compileToResolvedAgent([supervisorWithToolsDsl], 'Travel_Router'),
      );

      // Mock tool executor
      const mockToolExecutor = {
        execute: vi.fn().mockResolvedValue({ flights: [{ id: 1 }] }),
        executeParallel: vi.fn(),
      };
      (session as any).toolExecutor = mockToolExecutor;

      const routingExecutor = (executor as any).routing;
      const result: FanOutResult = await routingExecutor.handleFanOut(session, {
        tasks: [
          {
            type: 'tool',
            target: 'search_flights',
            intent: 'Search flights to Paris',
            params: { origin: 'NYC', destination: 'Paris' },
          },
          {
            type: 'tool',
            target: 'get_weather',
            intent: 'Get weather in Paris',
            params: { city: 'Paris' },
          },
        ],
      });

      expect(result.success).toBe(true);
      expect(result.results).toHaveLength(2);
      expect(result.results[0].status).toBe('completed');
      expect(result.results[1].status).toBe('completed');
      // Tool executor was called, not child agent loop
      expect(mockToolExecutor.execute).toHaveBeenCalledTimes(2);
      expect(mockToolExecutor.execute).toHaveBeenCalledWith(
        'search_flights',
        { origin: 'NYC', destination: 'Paris' },
        expect.any(Number),
      );
      expect(mockToolExecutor.execute).toHaveBeenCalledWith(
        'get_weather',
        { city: 'Paris' },
        expect.any(Number),
      );
    });

    test('mixed fan-out: tool tasks and agent tasks run together', async () => {
      executor.registerAgent('Flight_Agent', flightAgentDsl);
      executor.registerAgent('Hotel_Agent', hotelAgentDsl);
      const session = executor.createSessionFromResolved(
        compileToResolvedAgent([supervisorWithToolsDsl], 'Travel_Router'),
      );

      const mockToolExecutor = {
        execute: vi.fn().mockResolvedValue({ weather: 'sunny' }),
        executeParallel: vi.fn(),
      };
      (session as any).toolExecutor = mockToolExecutor;

      const execMock = stubExecution(executor);
      const routingExecutor = (executor as any).routing;

      const result: FanOutResult = await routingExecutor.handleFanOut(session, {
        tasks: [
          { type: 'tool', target: 'get_weather', intent: 'Get weather', params: { city: 'Paris' } },
          { type: 'agent', target: 'Flight_Agent', intent: 'Book a flight to Paris' },
        ],
      });

      expect(result.success).toBe(true);
      expect(result.results).toHaveLength(2);
      // Tool was called directly
      expect(mockToolExecutor.execute).toHaveBeenCalledTimes(1);
      // Agent went through child session
      expect(execMock).toHaveBeenCalledTimes(1);
    });

    test('backward compat: tasks without type default to agent', async () => {
      executor.registerAgent('Flight_Agent', flightAgentDsl);
      executor.registerAgent('Hotel_Agent', hotelAgentDsl);
      const session = setupSupervisorSession(executor);

      const execMock = stubExecution(executor);
      const routingExecutor = (executor as any).routing;

      const result: FanOutResult = await routingExecutor.handleFanOut(session, {
        tasks: [
          { target: 'Flight_Agent', intent: 'Search flights' },
          { target: 'Hotel_Agent', intent: 'Search hotels' },
        ],
      });

      expect(result.success).toBe(true);
      // Both treated as agent tasks (existing behavior)
      expect(execMock).toHaveBeenCalledTimes(2);
    });

    test('tool fan-out with tool execution error returns error result', async () => {
      executor.registerAgent('Flight_Agent', flightAgentDsl);
      executor.registerAgent('Hotel_Agent', hotelAgentDsl);
      const session = executor.createSessionFromResolved(
        compileToResolvedAgent([supervisorWithToolsDsl], 'Travel_Router'),
      );

      const mockToolExecutor = {
        execute: vi
          .fn()
          .mockResolvedValueOnce({ flights: [{ id: 1 }] })
          .mockRejectedValueOnce(new Error('Tool not found: nonexistent_tool')),
        executeParallel: vi.fn(),
      };
      (session as any).toolExecutor = mockToolExecutor;

      const routingExecutor = (executor as any).routing;
      const result: FanOutResult = await routingExecutor.handleFanOut(session, {
        tasks: [
          { type: 'tool', target: 'search_flights', intent: 'Search', params: {} },
          { type: 'tool', target: 'get_weather', intent: 'Get weather', params: {} },
        ],
      });

      // Partial success: one tool succeeds, one fails
      expect(result.success).toBe(true);
      expect(result.results.some((r: SubTaskResult) => r.status === 'completed')).toBe(true);
      expect(result.results.some((r: SubTaskResult) => r.status === 'error')).toBe(true);
    });

    test('buildTools includes supervisor own tools alongside per-agent handoff tools', () => {
      executor.registerAgent('Flight_Agent', flightAgentDsl);
      executor.registerAgent('Hotel_Agent', hotelAgentDsl);
      const session = executor.createSessionFromResolved(
        compileToResolvedAgent([supervisorWithToolsDsl], 'Travel_Router'),
      );

      const tools = buildTools(session);

      // Supervisor's own tools are present
      expect(tools.find((t: any) => t.name === 'search_flights')).toBeDefined();
      expect(tools.find((t: any) => t.name === 'get_weather')).toBeDefined();

      // Per-agent handoff tools are also present
      expect(tools.find((t: any) => t.name === 'handoff_to_Flight_Agent')).toBeDefined();
      expect(tools.find((t: any) => t.name === 'handoff_to_Hotel_Agent')).toBeDefined();
    });
  });
});
