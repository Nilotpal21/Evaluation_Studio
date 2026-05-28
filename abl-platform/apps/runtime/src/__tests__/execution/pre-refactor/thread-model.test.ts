/**
 * Pre-Refactor Test: Thread Model
 *
 * Covers thread creation, isolation, switching, stack operations,
 * and data mapping between parent and child threads during handoffs.
 *
 * These are unit tests for the thread helper functions plus integration
 * tests verifying thread behavior through the RuntimeExecutor.
 */

import { describe, test, expect, beforeEach } from 'vitest';
import {
  RuntimeExecutor,
  compileToResolvedAgent,
  getActiveThread,
} from '../../../services/runtime-executor';
import {
  createThread,
  createInitialThread,
  syncThreadToSession,
} from '../../../services/execution/types';
import { createTraceCollector, filterTraces } from '../../helpers/history-validation';
import { injectMockClient } from './helpers/mock-llm-client';

// =============================================================================
// FIXTURES
// =============================================================================

const SUPERVISOR_DSL = `
SUPERVISOR: Router

GOAL: "Route to the right agent"
PERSONA: "Router"

HANDOFF:
  - TO: Worker_A
    WHEN: intent.category == "work_a"
    CONTEXT:
      pass: [user_name]
    RETURN: true
    ON_RETURN:
      MAP:
        result_data: work_result

  - TO: Worker_B
    WHEN: intent.category == "work_b"
    RETURN: false
`;

const WORKER_A_DSL = `
AGENT: Worker_A

GOAL: "Do work A"

FLOW:
  entry_point: work
  steps:
    - work

work:
  SET: work_result = "task_a_completed"
  RESPOND: "Work A done!"
  THEN: COMPLETE
`;

const WORKER_B_DSL = `
AGENT: Worker_B

GOAL: "Do work B"

FLOW:
  entry_point: work
  steps:
    - work

work:
  SET: work_result = "task_b_completed"
  RESPOND: "Work B done!"
  THEN: COMPLETE
`;

// =============================================================================
// UNIT TESTS — Thread Helper Functions
// =============================================================================

describe('Pre-Refactor: Thread Model', () => {
  let executor: RuntimeExecutor;

  beforeEach(() => {
    executor = new RuntimeExecutor();
  });

  // ---------------------------------------------------------------------------
  // Thread creation (unit)
  // ---------------------------------------------------------------------------

  describe('createThread', () => {
    test('creates thread with correct agentName and independent data store', () => {
      const session = executor.createSessionFromResolved(
        compileToResolvedAgent([WORKER_A_DSL], 'Worker_A'),
      );

      const thread = createThread(session, 'Child_Agent', null);

      expect(thread.agentName).toBe('Child_Agent');
      expect(thread.data.values).toMatchObject({ session_id: session.id });
      expect(thread.data.gatheredKeys).toBeInstanceOf(Set);
      expect(thread.data.gatheredKeys.size).toBe(0);
      expect(thread.conversationHistory).toEqual([]);
      expect(thread.status).toBe('active');
    });

    test('createThread with initialData populates values', () => {
      const session = executor.createSessionFromResolved(
        compileToResolvedAgent([WORKER_A_DSL], 'Worker_A'),
      );

      const thread = createThread(session, 'Child_Agent', null, {
        initialData: { user_name: 'Alice', preference: 'luxury' },
      });

      expect(thread.data.values.user_name).toBe('Alice');
      expect(thread.data.values.preference).toBe('luxury');
    });

    test('createThread appends to session.threads', () => {
      const session = executor.createSessionFromResolved(
        compileToResolvedAgent([WORKER_A_DSL], 'Worker_A'),
      );
      const initialCount = session.threads.length;

      createThread(session, 'Child_1', null);
      createThread(session, 'Child_2', null);

      expect(session.threads.length).toBe(initialCount + 2);
      expect(session.threads[initialCount].agentName).toBe('Child_1');
      expect(session.threads[initialCount + 1].agentName).toBe('Child_2');
    });

    test('createThread records handoff metadata', () => {
      const session = executor.createSessionFromResolved(
        compileToResolvedAgent([WORKER_A_DSL], 'Worker_A'),
      );

      const thread = createThread(session, 'Child', null, {
        handoffFrom: 'Router',
        handoffContext: { summary: 'User needs work' },
        returnExpected: true,
      });

      expect(thread.handoffFrom).toBe('Router');
      expect(thread.handoffContext).toEqual({ summary: 'User needs work' });
      expect(thread.returnExpected).toBe(true);
    });

    test('createThread carries forward _metadata from parent session', () => {
      const session = executor.createSessionFromResolved(
        compileToResolvedAgent([WORKER_A_DSL], 'Worker_A'),
        { metadata: { sessionToken: 'jwt-abc', userProfile: { name: 'Alice' } } },
      );

      // Verify _metadata exists on the parent session
      expect(session.data.values._metadata).toEqual({
        sessionToken: 'jwt-abc',
        userProfile: { name: 'Alice' },
      });

      // Simulate handoff — createThread should carry _metadata forward
      const thread = createThread(session, 'Child_Agent', null, {
        handoffFrom: 'Worker_A',
        handoffContext: { summary: 'delegating' },
      });

      expect(thread.data.values._metadata).toEqual({
        sessionToken: 'jwt-abc',
        userProfile: { name: 'Alice' },
      });
    });

    test('createThread without _metadata on parent does not inject it', () => {
      const session = executor.createSessionFromResolved(
        compileToResolvedAgent([WORKER_A_DSL], 'Worker_A'),
      );

      expect(session.data.values._metadata).toBeUndefined();

      const thread = createThread(session, 'Child_Agent', null);
      expect(thread.data.values._metadata).toBeUndefined();
    });
  });

  // ---------------------------------------------------------------------------
  // Initial thread creation
  // ---------------------------------------------------------------------------

  describe('createInitialThread', () => {
    test('migrates session state to thread[0]', () => {
      const session = executor.createSessionFromResolved(
        compileToResolvedAgent([WORKER_A_DSL], 'Worker_A'),
      );

      // Session should already have a thread from createSessionFromResolved
      expect(session.threads.length).toBeGreaterThanOrEqual(1);
      expect(session.threads[0].agentName).toBe('Worker_A');
      expect(session.activeThreadIndex).toBe(0);
    });

    test('createInitialThread is idempotent', () => {
      const session = executor.createSessionFromResolved(
        compileToResolvedAgent([WORKER_A_DSL], 'Worker_A'),
      );

      const countBefore = session.threads.length;
      createInitialThread(session);

      // Should not add duplicate threads
      expect(session.threads.length).toBe(countBefore);
    });
  });

  // ---------------------------------------------------------------------------
  // getActiveThread
  // ---------------------------------------------------------------------------

  describe('getActiveThread', () => {
    test('returns thread at activeThreadIndex', () => {
      const session = executor.createSessionFromResolved(
        compileToResolvedAgent([WORKER_A_DSL], 'Worker_A'),
      );

      const active = getActiveThread(session);
      expect(active).toBe(session.threads[session.activeThreadIndex]);
      expect(active.agentName).toBe('Worker_A');
    });

    test('returns correct thread after index change', () => {
      const session = executor.createSessionFromResolved(
        compileToResolvedAgent([WORKER_A_DSL], 'Worker_A'),
      );

      createThread(session, 'Child_Agent', null);
      session.activeThreadIndex = 1;

      const active = getActiveThread(session);
      expect(active.agentName).toBe('Child_Agent');
    });
  });

  // ---------------------------------------------------------------------------
  // syncThreadToSession
  // ---------------------------------------------------------------------------

  describe('syncThreadToSession', () => {
    test('copies active thread state to session top-level', () => {
      const session = executor.createSessionFromResolved(
        compileToResolvedAgent([WORKER_A_DSL], 'Worker_A'),
      );

      // Create a child thread and switch to it
      const child = createThread(session, 'Child_Agent', null, {
        initialData: { child_key: 'child_value' },
      });
      child.conversationHistory.push({ role: 'user', content: 'hello from child' });
      session.activeThreadIndex = session.threads.length - 1;

      syncThreadToSession(session);

      // Session top-level should now reflect child thread
      expect(session.agentName).toBe('Child_Agent');
      expect(session.data.values.child_key).toBe('child_value');
    });
  });

  // ---------------------------------------------------------------------------
  // Thread data isolation
  // ---------------------------------------------------------------------------

  describe('Thread Data Isolation', () => {
    test('different threads have independent data stores', () => {
      const session = executor.createSessionFromResolved(
        compileToResolvedAgent([WORKER_A_DSL], 'Worker_A'),
      );

      const thread0 = session.threads[0];
      const thread1 = createThread(session, 'Worker_B', null);

      // Modify thread0 data
      thread0.data.values.key_a = 'value_a';
      thread0.data.gatheredKeys.add('key_a');

      // Modify thread1 data
      thread1.data.values.key_b = 'value_b';
      thread1.data.gatheredKeys.add('key_b');

      // Data should be independent
      expect(thread0.data.values.key_b).toBeUndefined();
      expect(thread1.data.values.key_a).toBeUndefined();
      expect(thread0.data.gatheredKeys.has('key_b')).toBe(false);
      expect(thread1.data.gatheredKeys.has('key_a')).toBe(false);
    });

    test('different threads have independent conversation histories', () => {
      const session = executor.createSessionFromResolved(
        compileToResolvedAgent([WORKER_A_DSL], 'Worker_A'),
      );

      const thread1 = createThread(session, 'Worker_B', null);

      // Add messages to thread1 only
      thread1.conversationHistory.push({ role: 'user', content: 'thread1 message' });

      // Thread0 should not have thread1's messages (if they're separate arrays)
      const thread0History = session.threads[0].conversationHistory;
      const hasThread1Msg = thread0History.some(
        (m: { content: string }) => m.content === 'thread1 message',
      );
      // New threads created via createThread have their own arrays
      expect(hasThread1Msg).toBe(false);
    });
  });

  // ---------------------------------------------------------------------------
  // Integration: Handoff thread creation through executor
  // ---------------------------------------------------------------------------

  describe('Handoff Thread Creation (Integration)', () => {
    test('handoff to Worker_A creates child thread with PASS data', async () => {
      const mockClient = injectMockClient(executor);
      let callCount = 0;
      mockClient.setResponseHandler(() => {
        callCount++;
        if (callCount === 1) {
          return {
            text: 'Routing to worker A.',
            toolCalls: [{ id: 'c1', name: '__handoff__', input: { target: 'Worker_A' } }],
            stopReason: 'tool_use',
            rawContent: [
              { type: 'text', text: 'Routing to worker A.' },
              { type: 'tool_use', id: 'c1', name: '__handoff__', input: { target: 'Worker_A' } },
            ],
          };
        }
        return {
          text: 'Done.',
          toolCalls: [],
          stopReason: 'end_turn',
          rawContent: [{ type: 'text', text: 'Done.' }],
        };
      });

      const session = executor.createSessionFromResolved(
        compileToResolvedAgent([SUPERVISOR_DSL, WORKER_A_DSL, WORKER_B_DSL], 'Router'),
      );

      // Set user_name in parent context before handoff
      session.data.values.user_name = 'TestUser';

      const tc = createTraceCollector();
      await executor.executeMessage(session.id, 'do work a', undefined, tc.callback);

      // Worker_A thread should exist
      const workerThread = session.threads.find((t) => t.agentName === 'Worker_A');
      expect(workerThread).toBeDefined();

      // PASS should have propagated user_name
      expect(workerThread!.data.values.user_name).toBe('TestUser');

      // Handoff trace should exist
      const handoffTraces = filterTraces(tc.traces, 'handoff');
      expect(handoffTraces.length).toBeGreaterThanOrEqual(1);
    });

    test('parent thread state unchanged by child thread execution', async () => {
      const mockClient = injectMockClient(executor);
      let callCount = 0;
      mockClient.setResponseHandler(() => {
        callCount++;
        if (callCount === 1) {
          return {
            text: 'Routing.',
            toolCalls: [{ id: 'c1', name: '__handoff__', input: { target: 'Worker_A' } }],
            stopReason: 'tool_use',
            rawContent: [
              { type: 'text', text: 'Routing.' },
              { type: 'tool_use', id: 'c1', name: '__handoff__', input: { target: 'Worker_A' } },
            ],
          };
        }
        return {
          text: 'Done.',
          toolCalls: [],
          stopReason: 'end_turn',
          rawContent: [{ type: 'text', text: 'Done.' }],
        };
      });

      const session = executor.createSessionFromResolved(
        compileToResolvedAgent([SUPERVISOR_DSL, WORKER_A_DSL, WORKER_B_DSL], 'Router'),
      );

      // Set parent data before handoff
      session.data.values.parent_key = 'parent_value';

      await executor.executeMessage(session.id, 'do work a');

      // Parent thread (Router) should still have parent_key
      const routerThread = session.threads.find((t) => t.agentName === 'Router');
      expect(routerThread).toBeDefined();
      expect(routerThread!.data.values.parent_key).toBe('parent_value');

      // Worker thread SHOULD have parent_key — session metadata now propagates
      // from parent to child thread during handoff (lowest priority, overridden
      // by LLM context and PASS fields).
      const workerThread = session.threads.find((t) => t.agentName === 'Worker_A');
      if (workerThread) {
        expect(workerThread.data.values.parent_key).toBe('parent_value');
      }
    });
  });
});
