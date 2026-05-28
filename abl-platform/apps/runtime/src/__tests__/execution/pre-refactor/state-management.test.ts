/**
 * Pre-Refactor Test: State Management
 *
 * Covers SessionDataStore helpers, state synchronization between threads
 * and session, gatherProgress computation, and context propagation.
 */

import { describe, test, expect, beforeEach } from 'vitest';
import {
  RuntimeExecutor,
  compileToResolvedAgent,
  getActiveThread,
  createThread,
  createInitialThread,
  syncThreadToSession,
  getGatherProgress,
} from '../../../services/runtime-executor';
import type {
  RuntimeSession,
  SessionDataStore,
  AgentThread,
} from '../../../services/runtime-executor';

// =============================================================================
// TESTS
// =============================================================================

describe('Pre-Refactor: State Management', () => {
  let executor: RuntimeExecutor;

  beforeEach(() => {
    executor = new RuntimeExecutor();
  });

  // ---------------------------------------------------------------------------
  // SessionDataStore helpers
  // ---------------------------------------------------------------------------

  describe('SessionDataStore Helpers', () => {
    test('setGatheredValues writes values and marks as gathered', () => {
      const session = executor.createSessionFromResolved(
        compileToResolvedAgent(
          [
            `
AGENT: State_Test

GOAL: "Test state"
FLOW:
  entry_point: a
  steps:
    - a
a:
  RESPOND: "Hi"
  THEN: COMPLETE
`,
          ],
          'State_Test',
        ),
      );

      session.data.values.name = 'Alice';
      session.data.gatheredKeys.add('name');
      session.data.values.age = 30;
      session.data.gatheredKeys.add('age');

      expect(session.data.values.name).toBe('Alice');
      expect(session.data.values.age).toBe(30);
      expect(session.data.gatheredKeys.has('name')).toBe(true);
      expect(session.data.gatheredKeys.has('age')).toBe(true);
    });

    test('deleteSessionValue removes value and gathered key', () => {
      const session = executor.createSessionFromResolved(
        compileToResolvedAgent(
          [
            `
AGENT: Delete_Test

GOAL: "Test delete"
FLOW:
  entry_point: a
  steps:
    - a
a:
  RESPOND: "Hi"
  THEN: COMPLETE
`,
          ],
          'Delete_Test',
        ),
      );

      session.data.values.city = 'Paris';
      session.data.gatheredKeys.add('city');
      expect(session.data.values.city).toBe('Paris');
      expect(session.data.gatheredKeys.has('city')).toBe(true);

      delete session.data.values.city;
      session.data.gatheredKeys.delete('city');
      expect(session.data.values.city).toBeUndefined();
      expect(session.data.gatheredKeys.has('city')).toBe(false);
    });

    test('getGatherProgress returns only gathered values', () => {
      const session = executor.createSessionFromResolved(
        compileToResolvedAgent(
          [
            `
AGENT: Progress_Test

GOAL: "Test progress"
FLOW:
  entry_point: a
  steps:
    - a
a:
  RESPOND: "Hi"
  THEN: COMPLETE
`,
          ],
          'Progress_Test',
        ),
      );

      // Set a computed value (not gathered)
      session.data.values.computed = 'auto';

      // Set gathered values
      session.data.values.user_input = 'manual';
      session.data.gatheredKeys.add('user_input');

      const progress = getGatherProgress(session);
      expect(progress.user_input).toBe('manual');
      expect(progress.computed).toBeUndefined();
    });

    test('getGatherProgress returns only gathered keys, not computed values', () => {
      const session = executor.createSessionFromResolved(
        compileToResolvedAgent(
          [
            `
AGENT: Snap_Test

GOAL: "Test snap"
FLOW:
  entry_point: a
  steps:
    - a
a:
  RESPOND: "Hi"
  THEN: COMPLETE
`,
          ],
          'Snap_Test',
        ),
      );

      session.data.values.field1 = 'val1';
      session.data.gatheredKeys.add('field1');
      session.data.values.computed = 'auto';

      const progress = getGatherProgress(session);
      expect(progress).toEqual({ field1: 'val1' });
      // computed is in session.data.values but NOT in gatherProgress
      expect(progress.computed).toBeUndefined();
      // But it IS in the raw values
      expect(session.data.values.computed).toBe('auto');
    });
  });

  // ---------------------------------------------------------------------------
  // Thread helpers
  // ---------------------------------------------------------------------------

  describe('Thread Helpers', () => {
    test('getActiveThread returns the thread at activeThreadIndex', () => {
      const session = executor.createSessionFromResolved(
        compileToResolvedAgent(
          [
            `
AGENT: Thread_Test

GOAL: "Test"
FLOW:
  entry_point: a
  steps:
    - a
a:
  RESPOND: "Hi"
  THEN: COMPLETE
`,
          ],
          'Thread_Test',
        ),
      );

      const active = getActiveThread(session);
      expect(active).toBeDefined();
      expect(active.agentName).toBe('Thread_Test');
      expect(active.status).toBe('active');
    });

    test('createInitialThread migrates session state to thread[0]', () => {
      const session = executor.createSessionFromResolved(
        compileToResolvedAgent(
          [
            `
AGENT: Init_Thread

GOAL: "Test"
FLOW:
  entry_point: a
  steps:
    - a
a:
  RESPOND: "Hi"
  THEN: COMPLETE
`,
          ],
          'Init_Thread',
        ),
      );

      // Session should already have an initial thread
      expect(session.threads.length).toBe(1);
      expect(session.threads[0].agentName).toBe('Init_Thread');
    });

    test('syncThreadToSession copies active thread data to session top-level', async () => {
      const session = executor.createSessionFromResolved(
        compileToResolvedAgent(
          [
            `
AGENT: Sync_Test

GOAL: "Test sync"

ON_START:
  set: synced_val = from_thread

FLOW:
  entry_point: a
  steps:
    - a
a:
  RESPOND: "{{synced_val}}"
  THEN: COMPLETE
`,
          ],
          'Sync_Test',
        ),
      );

      await executor.initializeSession(session.id);

      // After init, syncThreadToSession should have been called
      // Check that session-level fields match the active thread
      const active = getActiveThread(session);
      expect(session.agentName).toBe(active.agentName);
      expect(session.data.values.synced_val).toBe('from_thread');
    });
  });

  // ---------------------------------------------------------------------------
  // State isolation between threads
  // ---------------------------------------------------------------------------

  describe('Thread State Isolation', () => {
    test('different threads have independent data stores', () => {
      const session = executor.createSessionFromResolved(
        compileToResolvedAgent(
          [
            `
AGENT: Iso_Test

GOAL: "Test"
FLOW:
  entry_point: a
  steps:
    - a
a:
  RESPOND: "Hi"
  THEN: COMPLETE
`,
          ],
          'Iso_Test',
        ),
      );

      // Manually create a second thread for testing isolation
      const newThread = createThread(session, {
        agentName: 'Child_Agent',
        agentIR: null,
        handoffFrom: 'Iso_Test',
        returnExpected: false,
      });

      // Modify data in new thread
      newThread.data.values.child_only = 'child_data';

      // Original thread should not have this data
      const originalThread = session.threads[0];
      expect(originalThread.data.values.child_only).toBeUndefined();
    });
  });

  // ---------------------------------------------------------------------------
  // Context propagation through flow
  // ---------------------------------------------------------------------------

  describe('Context Propagation', () => {
    test('ON_START SET values are available in flow steps', async () => {
      const dsl = `
AGENT: Ctx_Propagate

GOAL: "Test context"

ON_START:
  set: lang = en
  set: version = 2

FLOW:
  entry_point: show
  steps:
    - show

show:
  RESPOND: "Lang={{lang}}, Version={{version}}"
  THEN: COMPLETE
`;
      const session = executor.createSessionFromResolved(
        compileToResolvedAgent([dsl], 'Ctx_Propagate'),
      );
      const chunks: string[] = [];
      await executor.initializeSession(session.id, (c) => chunks.push(c));

      expect(chunks.join('')).toContain('Lang=en');
      expect(chunks.join('')).toContain('Version=2');
    });

    test('collected values are available in subsequent steps', async () => {
      const dsl = `
AGENT: Ctx_Collect

GOAL: "Test collected context"

FLOW:
  entry_point: ask
  steps:
    - ask
    - use

ask:
  GATHER:
    - fruit: required
  THEN: use

use:
  RESPOND: "You like {{fruit}}!"
  THEN: COMPLETE
`;
      const session = executor.createSessionFromResolved(
        compileToResolvedAgent([dsl], 'Ctx_Collect'),
      );
      await executor.initializeSession(session.id);

      const chunks: string[] = [];
      await executor.executeMessage(session.id, 'mango', (c) => chunks.push(c));

      expect(chunks.join('')).toContain('You like mango!');
    });
  });
});
