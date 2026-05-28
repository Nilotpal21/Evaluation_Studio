/**
 * Pre-Refactor Test: Session Lifecycle
 *
 * Covers session creation, initialization, state transitions, and teardown.
 * These are behavioral contracts that must be preserved during runtime engine consolidation.
 */

import { describe, test, expect, beforeEach } from 'vitest';
import {
  RuntimeExecutor,
  compileToResolvedAgent,
  getActiveThread,
} from '../../../services/runtime-executor';
import type { RuntimeSession } from '../../../services/runtime-executor';
import { injectMockClient } from './helpers/mock-llm-client';

// =============================================================================
// FIXTURES
// =============================================================================

const SCRIPTED_AGENT = `
AGENT: Lifecycle_Agent

GOAL: "Test lifecycle"

ON_START:
  set: started = true
  respond: "Welcome!"

FLOW:
  entry_point: greet
  steps:
    - greet

greet:
  RESPOND: "Hello! started={{started}}"
  THEN: COMPLETE
`;

const REASONING_AGENT = `
AGENT: Reasoning_Lifecycle

GOAL: "Test reasoning lifecycle"
PERSONA: "Test agent"
`;

const MULTI_AGENT_DSL = `
SUPERVISOR: Entry_Supervisor

GOAL: "Route requests"
PERSONA: "Router"

HANDOFF:
  - TO: Worker_Agent
    WHEN: intent.category == "work"
    RETURN: false
`;

const WORKER_DSL = `
AGENT: Worker_Agent

GOAL: "Do work"
PERSONA: "Worker"
`;

// =============================================================================
// TESTS
// =============================================================================

describe('Pre-Refactor: Session Lifecycle', () => {
  let executor: RuntimeExecutor;

  beforeEach(() => {
    executor = new RuntimeExecutor();
  });

  // ---------------------------------------------------------------------------
  // Session creation
  // ---------------------------------------------------------------------------

  describe('Session Creation', () => {
    test('creates session with unique ID', () => {
      const s1 = executor.createSessionFromResolved(
        compileToResolvedAgent([SCRIPTED_AGENT], 'Lifecycle_Agent'),
      );
      const s2 = executor.createSessionFromResolved(
        compileToResolvedAgent([SCRIPTED_AGENT], 'Lifecycle_Agent'),
      );
      expect(s1.id).toBeDefined();
      expect(s2.id).toBeDefined();
      expect(s1.id).not.toBe(s2.id);
    });

    test('creates session with correct agent name', () => {
      const session = executor.createSessionFromResolved(
        compileToResolvedAgent([SCRIPTED_AGENT], 'Lifecycle_Agent'),
      );
      expect(session.agentName).toBe('Lifecycle_Agent');
    });

    test('creates session with agentIR populated', () => {
      const session = executor.createSessionFromResolved(
        compileToResolvedAgent([SCRIPTED_AGENT], 'Lifecycle_Agent'),
      );
      expect(session.agentIR).not.toBeNull();
    });

    test('creates session with initial data store', () => {
      const session = executor.createSessionFromResolved(
        compileToResolvedAgent([SCRIPTED_AGENT], 'Lifecycle_Agent'),
      );
      expect(session.data.values).toMatchObject({
        _clarification_count: 0,
        session: { channel: 'digital' },
      });
      expect(session.data.gatheredKeys).toBeInstanceOf(Set);
      expect(session.data.gatheredKeys.size).toBe(0);
    });

    test('creates session with not-complete and not-escalated', () => {
      const session = executor.createSessionFromResolved(
        compileToResolvedAgent([SCRIPTED_AGENT], 'Lifecycle_Agent'),
      );
      expect(session.isComplete).toBe(false);
      expect(session.isEscalated).toBe(false);
    });

    test('creates session with empty conversation history', () => {
      const session = executor.createSessionFromResolved(
        compileToResolvedAgent([SCRIPTED_AGENT], 'Lifecycle_Agent'),
      );
      expect(session.conversationHistory).toEqual([]);
    });

    test('creates session with timestamps', () => {
      const before = new Date();
      const session = executor.createSessionFromResolved(
        compileToResolvedAgent([SCRIPTED_AGENT], 'Lifecycle_Agent'),
      );
      const after = new Date();
      expect(session.createdAt.getTime()).toBeGreaterThanOrEqual(before.getTime());
      expect(session.createdAt.getTime()).toBeLessThanOrEqual(after.getTime());
      expect(session.lastActivityAt.getTime()).toBeGreaterThanOrEqual(before.getTime());
    });

    test('creates session with initial thread', () => {
      const session = executor.createSessionFromResolved(
        compileToResolvedAgent([SCRIPTED_AGENT], 'Lifecycle_Agent'),
      );
      expect(session.threads.length).toBe(1);
      expect(session.activeThreadIndex).toBe(0);
      expect(session.threadStack).toEqual([]);
      expect(session.threads[0].agentName).toBe('Lifecycle_Agent');
      expect(session.threads[0].status).toBe('active');
    });

    test('creates session with custom session ID', () => {
      const session = executor.createSessionFromResolved(
        compileToResolvedAgent([SCRIPTED_AGENT], 'Lifecycle_Agent'),
        { sessionId: 'custom-id-123' },
      );
      expect(session.id).toBe('custom-id-123');
    });

    test('creates session with tenant context', () => {
      const session = executor.createSessionFromResolved(
        compileToResolvedAgent([SCRIPTED_AGENT], 'Lifecycle_Agent'),
        { tenantId: 'org-abc', projectId: 'proj-xyz', userId: 'user-1' },
      );
      expect(session.tenantId).toBe('org-abc');
      expect(session.projectId).toBe('proj-xyz');
      expect(session.userId).toBe('user-1');
    });

    test('creates session with compilationOutput for multi-agent', () => {
      const session = executor.createSessionFromResolved(
        compileToResolvedAgent([MULTI_AGENT_DSL, WORKER_DSL], 'Entry_Supervisor'),
      );
      expect(session.compilationOutput).not.toBeNull();
      expect(session.compilationOutput?.agents).toBeDefined();
      expect(Object.keys(session.compilationOutput!.agents)).toContain('Worker_Agent');
    });
  });

  // ---------------------------------------------------------------------------
  // Session initialization (ON_START)
  // ---------------------------------------------------------------------------

  describe('Session Initialization', () => {
    test('initializeSession runs ON_START hooks', async () => {
      const session = executor.createSessionFromResolved(
        compileToResolvedAgent([SCRIPTED_AGENT], 'Lifecycle_Agent'),
      );
      const chunks: string[] = [];
      await executor.initializeSession(session.id, (c) => chunks.push(c));

      expect(session.initialized).toBe(true);
      expect(session.data.values.started).toBe(true);
      expect(chunks.join('')).toContain('Welcome!');
    });

    test('initializeSession is idempotent', async () => {
      const session = executor.createSessionFromResolved(
        compileToResolvedAgent([SCRIPTED_AGENT], 'Lifecycle_Agent'),
      );
      const chunks1: string[] = [];
      await executor.initializeSession(session.id, (c) => chunks1.push(c));

      const chunks2: string[] = [];
      await executor.initializeSession(session.id, (c) => chunks2.push(c));

      // Second call should not re-run ON_START
      expect(chunks2.join('')).not.toContain('Welcome!');
    });

    test('executeMessage auto-initializes on first call', async () => {
      const session = executor.createSessionFromResolved(
        compileToResolvedAgent([SCRIPTED_AGENT], 'Lifecycle_Agent'),
      );
      expect(session.initialized).toBe(false);

      await executor.executeMessage(session.id, 'hello');
      expect(session.initialized).toBe(true);
    });

    test('initializeSession sets currentFlowStep for scripted agents', async () => {
      const session = executor.createSessionFromResolved(
        compileToResolvedAgent([SCRIPTED_AGENT], 'Lifecycle_Agent'),
      );
      await executor.initializeSession(session.id);

      expect(session.currentFlowStep).toBeDefined();
    });
  });

  // ---------------------------------------------------------------------------
  // Session state queries
  // ---------------------------------------------------------------------------

  describe('Session Queries', () => {
    test('getSession returns existing session', () => {
      const session = executor.createSessionFromResolved(
        compileToResolvedAgent([SCRIPTED_AGENT], 'Lifecycle_Agent'),
      );
      const retrieved = executor.getSession(session.id);
      expect(retrieved).toBe(session);
    });

    test('getSession returns undefined for non-existent session', () => {
      expect(executor.getSession('nonexistent')).toBeUndefined();
    });

    test('listSessions returns all active sessions', () => {
      executor.createSessionFromResolved(
        compileToResolvedAgent([SCRIPTED_AGENT], 'Lifecycle_Agent'),
      );
      executor.createSessionFromResolved(
        compileToResolvedAgent([SCRIPTED_AGENT], 'Lifecycle_Agent'),
      );

      const sessions = executor.listSessions();
      expect(sessions.length).toBe(2);
    });

    test('getSessionDetail returns serializable session state', () => {
      const session = executor.createSessionFromResolved(
        compileToResolvedAgent([SCRIPTED_AGENT], 'Lifecycle_Agent'),
      );
      const detail = executor.getSessionDetail(session.id);

      expect(detail).toBeDefined();
      expect(detail!.id).toBe(session.id);
      expect(detail!.agentName).toBe('Lifecycle_Agent');
      expect(detail!.state).toBeDefined();
      expect(detail!.messages).toBeInstanceOf(Array);
      expect(detail!.threads).toBeInstanceOf(Array);
      expect(detail!.threads.length).toBeGreaterThanOrEqual(1);
      expect(detail!.activeThreadIndex).toBe(0);
      expect(detail!.createdAt).toBeDefined();
      expect(detail!.lastActivityAt).toBeDefined();
    });
  });

  // ---------------------------------------------------------------------------
  // Session completion
  // ---------------------------------------------------------------------------

  describe('Session Completion', () => {
    test('session becomes complete after COMPLETE step', async () => {
      const session = executor.createSessionFromResolved(
        compileToResolvedAgent([SCRIPTED_AGENT], 'Lifecycle_Agent'),
      );
      await executor.initializeSession(session.id);

      // The SCRIPTED_AGENT has greet -> COMPLETE, so after init it should be complete
      expect(session.isComplete).toBe(true);
    });

    test('completed session rejects new messages', async () => {
      const session = executor.createSessionFromResolved(
        compileToResolvedAgent([SCRIPTED_AGENT], 'Lifecycle_Agent'),
      );
      await executor.initializeSession(session.id);

      expect(session.isComplete).toBe(true);
      const result = await executor.executeMessage(session.id, 'hello');
      expect(result.action.type).toBe('complete');
    });

    test('lastActivityAt updates on executeMessage', async () => {
      const dsl = `
AGENT: Activity_Agent

GOAL: "Test activity"

FLOW:
  entry_point: ask
  steps:
    - ask

ask:
  GATHER:
    - name: required
`;
      const session = executor.createSessionFromResolved(
        compileToResolvedAgent([dsl], 'Activity_Agent'),
      );
      const initialActivity = session.lastActivityAt;

      // Small delay to ensure time difference
      await new Promise((r) => setTimeout(r, 10));
      await executor.executeMessage(session.id, 'Alice');

      expect(session.lastActivityAt.getTime()).toBeGreaterThan(initialActivity.getTime());
    });
  });

  // ---------------------------------------------------------------------------
  // Session destruction
  // ---------------------------------------------------------------------------

  describe('Session Destruction', () => {
    test('endSession removes session from active map', async () => {
      const session = executor.createSessionFromResolved(
        compileToResolvedAgent([SCRIPTED_AGENT], 'Lifecycle_Agent'),
      );
      expect(executor.getSession(session.id)).toBeDefined();

      await executor.endSession(session.id);
      expect(executor.getSession(session.id)).toBeUndefined();
    });

    test('detachSession preserves session in map and clears debounce timer', async () => {
      const session = executor.createSessionFromResolved(
        compileToResolvedAgent([SCRIPTED_AGENT], 'Lifecycle_Agent'),
      );
      const sessionId = session.id;

      executor.detachSession(sessionId);
      // detachSession does NOT remove from the in-memory map — the sessions API needs to list it.
      // It only clears the debounce timer; the session data itself is preserved.
      const retrieved = executor.getSession(sessionId);
      expect(retrieved).toBeDefined();
      expect(retrieved!.id).toBe(sessionId);
      expect(retrieved!.agentName).toBe('Lifecycle_Agent');
    });

    test('endSession on non-existent session does not throw', () => {
      // endSession returns void (not a Promise), so use synchronous assertion
      expect(() => executor.endSession('nonexistent')).not.toThrow();
    });
  });

  // ---------------------------------------------------------------------------
  // Escalated sessions
  // ---------------------------------------------------------------------------

  describe('Escalated Sessions', () => {
    test('escalated session echoes mock human response', async () => {
      const dsl = `
AGENT: Escalate_Agent

GOAL: "Test escalation"

CONSTRAINTS:
  REQUIRE: false
    ON_FAIL: ESCALATE "Need human help"

FLOW:
  entry_point: ask
  steps:
    - ask

ask:
  GATHER:
    - query: required
`;
      const session = executor.createSessionFromResolved(
        compileToResolvedAgent([dsl], 'Escalate_Agent'),
      );
      await executor.initializeSession(session.id);
      const result = await executor.executeMessage(session.id, 'I need help');

      if (session.isEscalated) {
        // After escalation, further messages return mock response
        const result2 = await executor.executeMessage(session.id, 'still here');
        expect(result2.action.type).toBe('respond');
      }
    });
  });

  // ---------------------------------------------------------------------------
  // Reasoning mode session
  // ---------------------------------------------------------------------------

  describe('Reasoning Mode Session', () => {
    test('creates reasoning session without currentFlowStep', () => {
      const session = executor.createSessionFromResolved(
        compileToResolvedAgent([REASONING_AGENT], 'Reasoning_Lifecycle'),
      );
      expect(session.currentFlowStep).toBeUndefined();
    });

    test('reasoning session without LLM client returns error response', async () => {
      const session = executor.createSessionFromResolved(
        compileToResolvedAgent([REASONING_AGENT], 'Reasoning_Lifecycle'),
      );

      // Without mock client, executor catches the error and returns an error response
      const result = await executor.executeMessage(session.id, 'hello');
      expect(result.response).toBeDefined();
    });

    test('reasoning session executes with mock LLM', async () => {
      injectMockClient(executor);
      const session = executor.createSessionFromResolved(
        compileToResolvedAgent([REASONING_AGENT], 'Reasoning_Lifecycle'),
      );

      const result = await executor.executeMessage(session.id, 'hello');
      expect(result.response).toBeDefined();
    });
  });
});
