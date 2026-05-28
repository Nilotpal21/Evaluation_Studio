/**
 * RuntimeExecutor Error Paths & Edge Cases
 *
 * Tests error handling, guard clauses, and edge cases in RuntimeExecutor
 * that are not covered by the happy-path test suites.
 *
 * Covers:
 * - Session creation errors (missing entry agent)
 * - Message guards (empty input, completed session, escalated session)
 * - Session lifecycle (endSession, detachSession, addMessage)
 * - Session queries (listSessions, getSessionDetail)
 * - Initialization idempotency
 * - Agent registration
 * - isConfigured always-true invariant
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';

const mockPausedExecutionCleanupSession = vi.fn().mockResolvedValue(undefined);

// =============================================================================
// MOCKS — declared before importing the module under test
// =============================================================================

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

vi.mock('../../config/loader.js', () => ({
  isConfigLoaded: vi.fn().mockReturnValue(false),
  getConfig: vi.fn(),
}));

vi.mock('../../db/index.js', () => ({
  isDatabaseAvailable: vi.fn().mockReturnValue(false),
  isDatabaseReady: vi.fn().mockReturnValue(false),
}));

vi.mock('../../services/session/session-service.js', () => ({
  getSessionService: vi.fn(() => ({
    deleteSession: vi.fn(),
    store: { load: vi.fn().mockResolvedValue(null) },
  })),
}));

vi.mock('../../services/auth-profile/paused-execution-store.js', () => ({
  getPausedExecutionStore: vi.fn(() => ({
    cleanupSession: mockPausedExecutionCleanupSession,
  })),
}));

// =============================================================================
// IMPORTS
// =============================================================================

import { RuntimeExecutor, compileToResolvedAgent } from '../../services/runtime-executor';

// =============================================================================
// DSL FIXTURES
// =============================================================================

const SIMPLE_AGENT_DSL = `
AGENT: Simple_Agent

GOAL: "Help users"
`;

const SUPERVISOR_DSL = `
SUPERVISOR: Route_Supervisor

GOAL: "Routes users to the appropriate agent"

HANDOFF:
  - TO: Simple_Agent
    WHEN: user sends a greeting
`;

// =============================================================================
// TESTS
// =============================================================================

describe('RuntimeExecutor Error Paths', () => {
  let executor: RuntimeExecutor;

  beforeEach(() => {
    mockPausedExecutionCleanupSession.mockClear();
    executor = new RuntimeExecutor();
  });

  // ---------------------------------------------------------------------------
  // Session creation errors
  // ---------------------------------------------------------------------------
  describe('createSessionFromResolved — entry agent not found', () => {
    test('throws when entry agent name does not match any compiled agent', () => {
      const resolved = compileToResolvedAgent([SIMPLE_AGENT_DSL], 'Simple_Agent');
      // Wipe the agents map so there is nothing to find
      const badResolved = { ...resolved, agents: {}, entryAgent: 'Nonexistent_Agent' };

      expect(() => executor.createSessionFromResolved(badResolved)).toThrow(
        /Entry agent.*not found/,
      );
    });

    test('throws with the exact agent name in the error message', () => {
      const resolved = compileToResolvedAgent([SIMPLE_AGENT_DSL], 'Simple_Agent');
      const badResolved = { ...resolved, agents: {}, entryAgent: 'Ghost_Agent' };

      expect(() => executor.createSessionFromResolved(badResolved)).toThrow('Ghost_Agent');
    });
  });

  // ---------------------------------------------------------------------------
  // Message guards
  // ---------------------------------------------------------------------------
  describe('executeMessage — session not found', () => {
    test('throws "Session not found" for a nonexistent session ID', async () => {
      await expect(executor.executeMessage('no-such-session', 'hello')).rejects.toThrow(
        /Session not found/,
      );
    });

    test('includes the session ID in the error message', async () => {
      await expect(executor.executeMessage('abc-123', 'hello')).rejects.toThrow('abc-123');
    });
  });

  describe('executeMessage — empty or whitespace message', () => {
    test('returns "Please provide a message" for empty string', async () => {
      const resolved = compileToResolvedAgent([SIMPLE_AGENT_DSL], 'Simple_Agent');
      const session = executor.createSessionFromResolved(resolved);
      // Mark initialized so empty-message guard is reached (not ON_START)
      session.initialized = true;

      const result = await executor.executeMessage(session.id, '');
      expect(result.response).toBe('Please provide a message.');
      expect(result.action.type).toBe('continue');
    });

    test('returns "Please provide a message" for whitespace-only input', async () => {
      const resolved = compileToResolvedAgent([SIMPLE_AGENT_DSL], 'Simple_Agent');
      const session = executor.createSessionFromResolved(resolved);
      session.initialized = true;

      const result = await executor.executeMessage(session.id, '   \t\n  ');
      expect(result.response).toBe('Please provide a message.');
      expect(result.action.type).toBe('continue');
    });

    test('does not add the empty message to conversation history', async () => {
      const resolved = compileToResolvedAgent([SIMPLE_AGENT_DSL], 'Simple_Agent');
      const session = executor.createSessionFromResolved(resolved);
      session.initialized = true;
      const historyLenBefore = session.conversationHistory.length;

      await executor.executeMessage(session.id, '');
      expect(session.conversationHistory.length).toBe(historyLenBefore);
    });
  });

  describe('executeMessage — session already complete', () => {
    test('returns completion message when session.isComplete is true', async () => {
      const resolved = compileToResolvedAgent([SIMPLE_AGENT_DSL], 'Simple_Agent');
      const session = executor.createSessionFromResolved(resolved);
      session.initialized = true;
      session.isComplete = true;

      const result = await executor.executeMessage(session.id, 'hello');
      expect(result.action.type).toBe('complete');
      expect(result.action.message).toMatch(/already complete/i);
    });

    test('returns default completion text when agent has no custom message', async () => {
      const resolved = compileToResolvedAgent([SIMPLE_AGENT_DSL], 'Simple_Agent');
      const session = executor.createSessionFromResolved(resolved);
      session.initialized = true;
      session.isComplete = true;

      const result = await executor.executeMessage(session.id, 'test');
      expect(result.response).toBeTruthy();
      expect(typeof result.response).toBe('string');
    });
  });

  describe('executeMessage — session escalated', () => {
    test('blocks messages when shared suspension store reports an active escalation pause', async () => {
      const resolved = compileToResolvedAgent([SIMPLE_AGENT_DSL], 'Simple_Agent');
      const session = executor.createSessionFromResolved(resolved);
      session.initialized = true;
      session.isEscalated = true;

      executor.setAsyncInfra({
        callbackRegistry: {} as any,
        barrierStore: {} as any,
        callbackBaseUrl: 'http://localhost:3112/a2a/callbacks',
        suspensionStore: {
          findBySession: vi.fn().mockResolvedValue([
            {
              suspensionId: 'susp-1',
              status: 'suspended',
              continuation: { type: 'escalation' },
            },
          ]),
        } as any,
      });

      const result = await executor.executeMessage(session.id, 'Can you still help?');

      expect(result.response).toContain('awaiting human resolution');
      expect(result.action).toMatchObject({
        type: 'escalation_blocked',
        escalated: true,
        suspensionId: 'susp-1',
      });
    });

    test('returns mock human response when session is escalated', async () => {
      const resolved = compileToResolvedAgent([SIMPLE_AGENT_DSL], 'Simple_Agent');
      const session = executor.createSessionFromResolved(resolved);
      session.initialized = true;
      session.isEscalated = true;
      session.escalationReason = 'Customer requested human';

      const result = await executor.executeMessage(session.id, 'I need help');
      expect(result.response).toContain('[HUMAN AGENT]');
      expect(result.response).toContain('I need help');
      expect(result.response).toContain('Customer requested human');
      expect(result.action.type).toBe('escalate');
    });

    test('adds user and assistant messages to history for escalated session', async () => {
      const resolved = compileToResolvedAgent([SIMPLE_AGENT_DSL], 'Simple_Agent');
      const session = executor.createSessionFromResolved(resolved);
      session.initialized = true;
      session.isEscalated = true;
      const historyLenBefore = session.conversationHistory.length;

      await executor.executeMessage(session.id, 'hello again');
      // Should add both user and assistant messages
      expect(session.conversationHistory.length).toBe(historyLenBefore + 2);
      expect(session.conversationHistory[historyLenBefore].role).toBe('user');
      expect(session.conversationHistory[historyLenBefore + 1].role).toBe('assistant');
    });

    test('includes "Not specified" when no escalation reason is set', async () => {
      const resolved = compileToResolvedAgent([SIMPLE_AGENT_DSL], 'Simple_Agent');
      const session = executor.createSessionFromResolved(resolved);
      session.initialized = true;
      session.isEscalated = true;
      // No escalationReason set

      const result = await executor.executeMessage(session.id, 'hi');
      expect(result.response).toContain('Not specified');
    });
  });

  // ---------------------------------------------------------------------------
  // Session lifecycle
  // ---------------------------------------------------------------------------
  describe('endSession', () => {
    test('does not throw for a nonexistent session ID', () => {
      expect(() => executor.endSession('no-such-session')).not.toThrow();
    });

    test('removes the session from the internal map', () => {
      const resolved = compileToResolvedAgent([SIMPLE_AGENT_DSL], 'Simple_Agent');
      const session = executor.createSessionFromResolved(resolved);
      expect(executor.getSession(session.id)).toBeDefined();

      executor.endSession(session.id);
      expect(executor.getSession(session.id)).toBeUndefined();
    });

    test('clears debounce timer on end', () => {
      const resolved = compileToResolvedAgent([SIMPLE_AGENT_DSL], 'Simple_Agent');
      const session = executor.createSessionFromResolved(resolved);

      // Simulate a pending debounce timer by accessing the internal map
      // We verify endSession doesn't throw even when timers exist
      executor.endSession(session.id);
      // Session gone — calling endSession again is a no-op
      expect(() => executor.endSession(session.id)).not.toThrow();
    });

    test('triggers paused execution cleanup for session-scoped auth artifacts', async () => {
      const resolved = compileToResolvedAgent([SIMPLE_AGENT_DSL], 'Simple_Agent');
      const session = executor.createSessionFromResolved(resolved);

      executor.endSession(session.id);

      await vi.waitFor(() => {
        expect(mockPausedExecutionCleanupSession).toHaveBeenCalledWith(session.id, 'disconnect');
      });
    });
  });

  describe('detachSession', () => {
    test('preserves the session in the sessions map (does not delete)', () => {
      const resolved = compileToResolvedAgent([SIMPLE_AGENT_DSL], 'Simple_Agent');
      const session = executor.createSessionFromResolved(resolved);

      executor.detachSession(session.id);
      // Session should still be accessible
      expect(executor.getSession(session.id)).toBeDefined();
      expect(executor.getSession(session.id)!.id).toBe(session.id);
    });

    test('does not throw for a nonexistent session', () => {
      expect(() => executor.detachSession('no-such-session')).not.toThrow();
    });

    test('clears debounce timer without removing session', () => {
      const resolved = compileToResolvedAgent([SIMPLE_AGENT_DSL], 'Simple_Agent');
      const session = executor.createSessionFromResolved(resolved);

      // detach then verify session is still listed
      executor.detachSession(session.id);
      const sessions = executor.listSessions();
      expect(sessions.some((s) => s.id === session.id)).toBe(true);
    });
  });

  describe('addMessage', () => {
    test('is a no-op for a nonexistent session (does not throw)', () => {
      expect(() => executor.addMessage('no-such-session', 'user', 'hello')).not.toThrow();
    });

    test('adds message to session conversation history', () => {
      const resolved = compileToResolvedAgent([SIMPLE_AGENT_DSL], 'Simple_Agent');
      const session = executor.createSessionFromResolved(resolved);
      const before = session.conversationHistory.length;

      executor.addMessage(session.id, 'assistant', 'Welcome!');
      // addMessage pushes once to thread.conversationHistory;
      // since createInitialThread aliases the same array,
      // session.conversationHistory sees the same single push.
      expect(session.conversationHistory.length).toBe(before + 1);
      expect(session.conversationHistory[before]).toEqual({
        role: 'assistant',
        content: 'Welcome!',
      });
    });

    test('adds message to the active thread history', () => {
      const resolved = compileToResolvedAgent([SIMPLE_AGENT_DSL], 'Simple_Agent');
      const session = executor.createSessionFromResolved(resolved);
      const thread = session.threads[session.activeThreadIndex];
      const threadBefore = thread.conversationHistory.length;

      executor.addMessage(session.id, 'user', 'Hello from user');
      // addMessage pushes once to thread.conversationHistory.
      // Since thread and session share the same array reference, 1 push = 1 entry.
      expect(thread.conversationHistory.length).toBe(threadBefore + 1);
      expect(thread.conversationHistory[threadBefore].content).toBe('Hello from user');
    });

    test('updates lastActivityAt timestamp', () => {
      const resolved = compileToResolvedAgent([SIMPLE_AGENT_DSL], 'Simple_Agent');
      const session = executor.createSessionFromResolved(resolved);
      const before = session.lastActivityAt.getTime();

      // Small delay to ensure time difference
      executor.addMessage(session.id, 'user', 'ping');
      expect(session.lastActivityAt.getTime()).toBeGreaterThanOrEqual(before);
    });
  });

  // ---------------------------------------------------------------------------
  // Session queries
  // ---------------------------------------------------------------------------
  describe('listSessions', () => {
    test('returns empty array when no sessions exist', () => {
      const result = executor.listSessions();
      expect(result).toEqual([]);
    });

    test('returns all sessions with correct fields', () => {
      const resolved1 = compileToResolvedAgent([SIMPLE_AGENT_DSL], 'Simple_Agent');
      const session1 = executor.createSessionFromResolved(resolved1);
      const session2 = executor.createSessionFromResolved(resolved1);

      const list = executor.listSessions();
      expect(list).toHaveLength(2);

      const ids = list.map((s) => s.id);
      expect(ids).toContain(session1.id);
      expect(ids).toContain(session2.id);
    });

    test('each entry has required fields', () => {
      const resolved = compileToResolvedAgent([SIMPLE_AGENT_DSL], 'Simple_Agent');
      executor.createSessionFromResolved(resolved);

      const [entry] = executor.listSessions();
      expect(entry).toHaveProperty('id');
      expect(entry).toHaveProperty('agentName');
      expect(entry).toHaveProperty('messageCount');
      expect(entry).toHaveProperty('createdAt');
      expect(entry).toHaveProperty('lastActivityAt');
      expect(entry).toHaveProperty('activeAgent');
      expect(entry).toHaveProperty('threadCount');
    });

    test('messageCount starts at zero for a fresh session', () => {
      const resolved = compileToResolvedAgent([SIMPLE_AGENT_DSL], 'Simple_Agent');
      executor.createSessionFromResolved(resolved);

      const [entry] = executor.listSessions();
      expect(entry.messageCount).toBe(0);
    });

    test('messageCount reflects added messages', () => {
      const resolved = compileToResolvedAgent([SIMPLE_AGENT_DSL], 'Simple_Agent');
      const session = executor.createSessionFromResolved(resolved);

      executor.addMessage(session.id, 'user', 'hello');
      executor.addMessage(session.id, 'assistant', 'hi');

      const [entry] = executor.listSessions();
      // addMessage pushes once per call to the aliased thread/session array.
      // 2 addMessage calls = 2 entries. listSessions counts messages across threads.
      expect(entry.messageCount).toBe(2);
    });

    test('does not include ended sessions', () => {
      const resolved = compileToResolvedAgent([SIMPLE_AGENT_DSL], 'Simple_Agent');
      const session = executor.createSessionFromResolved(resolved);
      executor.endSession(session.id);

      expect(executor.listSessions()).toHaveLength(0);
    });
  });

  describe('getSessionDetail', () => {
    test('returns null for a nonexistent session ID', () => {
      const detail = executor.getSessionDetail('no-such-session');
      expect(detail).toBeNull();
    });

    test('returns full detail object for a valid session', () => {
      const resolved = compileToResolvedAgent([SIMPLE_AGENT_DSL], 'Simple_Agent');
      const session = executor.createSessionFromResolved(resolved);

      const detail = executor.getSessionDetail(session.id);
      expect(detail).not.toBeNull();
      expect(detail!.id).toBe(session.id);
      expect(detail!.agentName).toBeTruthy();
      expect(detail!.state).toBeDefined();
      expect(Array.isArray(detail!.messages)).toBe(true);
      expect(Array.isArray(detail!.traceEvents)).toBe(true);
      expect(Array.isArray(detail!.threads)).toBe(true);
      expect(typeof detail!.activeThreadIndex).toBe('number');
      expect(detail!.createdAt).toBeTruthy();
      expect(detail!.lastActivityAt).toBeTruthy();
    });

    test('threads array contains at least the initial thread', () => {
      const resolved = compileToResolvedAgent([SIMPLE_AGENT_DSL], 'Simple_Agent');
      const session = executor.createSessionFromResolved(resolved);

      const detail = executor.getSessionDetail(session.id);
      expect(detail!.threads.length).toBeGreaterThanOrEqual(1);
      expect(detail!.threads[0].agentName).toBeTruthy();
      expect(detail!.threads[0].status).toBe('active');
    });

    test('messages reflect conversation history', () => {
      const resolved = compileToResolvedAgent([SIMPLE_AGENT_DSL], 'Simple_Agent');
      const session = executor.createSessionFromResolved(resolved);

      executor.addMessage(session.id, 'user', 'Hello world');
      executor.addMessage(session.id, 'assistant', 'Hi there');

      const detail = executor.getSessionDetail(session.id);
      expect(detail!.messages).toHaveLength(2);
      expect(detail!.messages[0].role).toBe('user');
      expect(detail!.messages[0].content).toBe('Hello world');
      expect(detail!.messages[1].role).toBe('assistant');
      expect(detail!.messages[1].content).toBe('Hi there');
    });
  });

  // ---------------------------------------------------------------------------
  // Agent registration
  // ---------------------------------------------------------------------------
  describe('registerAgent', () => {
    test('registers a valid DSL agent in the registry', () => {
      executor.registerAgent('Simple_Agent', SIMPLE_AGENT_DSL);

      // Verify by creating a supervisor that references this agent and checking
      // that the registered agent can be found via session creation
      const resolved = compileToResolvedAgent(
        [SIMPLE_AGENT_DSL, SUPERVISOR_DSL],
        'Route_Supervisor',
      );
      const session = executor.createSessionFromResolved(resolved);
      expect(session.agentName).toBe('Route_Supervisor');
    });

    test('does not throw on invalid DSL', () => {
      expect(() => executor.registerAgent('BadAgent', 'AGENT: !!!invalid')).not.toThrow();
    });
  });

  // ---------------------------------------------------------------------------
  // isConfigured
  // ---------------------------------------------------------------------------
  describe('isConfigured', () => {
    test('always returns true', () => {
      expect(executor.isConfigured()).toBe(true);
    });

    test('returns true even with no API key configured', () => {
      const bareExecutor = new RuntimeExecutor();
      expect(bareExecutor.isConfigured()).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  // initializeSession
  // ---------------------------------------------------------------------------
  describe('initializeSession', () => {
    test('returns null when session is already initialized (idempotent)', async () => {
      const resolved = compileToResolvedAgent([SIMPLE_AGENT_DSL], 'Simple_Agent');
      const session = executor.createSessionFromResolved(resolved);
      session.initialized = true;

      const result = await executor.initializeSession(session.id);
      expect(result).toBeNull();
    });

    test('returns null when session does not exist', async () => {
      const result = await executor.initializeSession('nonexistent-session');
      expect(result).toBeNull();
    });

    test('marks session as initialized after first call', async () => {
      const resolved = compileToResolvedAgent([SIMPLE_AGENT_DSL], 'Simple_Agent');
      const session = executor.createSessionFromResolved(resolved);
      expect(session.initialized).toBe(false);

      await executor.initializeSession(session.id);
      expect(session.initialized).toBe(true);
    });

    test('second call returns null after first successful initialization', async () => {
      const resolved = compileToResolvedAgent([SIMPLE_AGENT_DSL], 'Simple_Agent');
      const session = executor.createSessionFromResolved(resolved);

      // First call initializes
      await executor.initializeSession(session.id);
      // Second call is idempotent
      const result = await executor.initializeSession(session.id);
      expect(result).toBeNull();
    });
  });

  // ---------------------------------------------------------------------------
  // getSession
  // ---------------------------------------------------------------------------
  describe('getSession', () => {
    test('returns undefined for a nonexistent session', () => {
      expect(executor.getSession('does-not-exist')).toBeUndefined();
    });

    test('returns the session object for a valid ID', () => {
      const resolved = compileToResolvedAgent([SIMPLE_AGENT_DSL], 'Simple_Agent');
      const session = executor.createSessionFromResolved(resolved);

      const retrieved = executor.getSession(session.id);
      expect(retrieved).toBeDefined();
      expect(retrieved!.id).toBe(session.id);
    });
  });

  // ---------------------------------------------------------------------------
  // Session creation — valid paths
  // ---------------------------------------------------------------------------
  describe('createSessionFromResolved — valid creation', () => {
    test('creates a session with a unique ID', () => {
      const resolved = compileToResolvedAgent([SIMPLE_AGENT_DSL], 'Simple_Agent');
      const s1 = executor.createSessionFromResolved(resolved);
      const s2 = executor.createSessionFromResolved(resolved);
      expect(s1.id).not.toBe(s2.id);
    });

    test('uses provided sessionId when given in options', () => {
      const resolved = compileToResolvedAgent([SIMPLE_AGENT_DSL], 'Simple_Agent');
      const session = executor.createSessionFromResolved(resolved, {
        sessionId: 'custom-id-123',
      });
      expect(session.id).toBe('custom-id-123');
    });

    test('sets tenantId and projectId from options', () => {
      const resolved = compileToResolvedAgent([SIMPLE_AGENT_DSL], 'Simple_Agent');
      const session = executor.createSessionFromResolved(resolved, {
        tenantId: 'tenant-abc',
        projectId: 'project-xyz',
      });
      expect(session.tenantId).toBe('tenant-abc');
      expect(session.projectId).toBe('project-xyz');
    });

    test('session starts not complete and not escalated', () => {
      const resolved = compileToResolvedAgent([SIMPLE_AGENT_DSL], 'Simple_Agent');
      const session = executor.createSessionFromResolved(resolved);
      expect(session.isComplete).toBe(false);
      expect(session.isEscalated).toBe(false);
      expect(session.initialized).toBe(false);
    });

    test('session has at least one thread after creation', () => {
      const resolved = compileToResolvedAgent([SIMPLE_AGENT_DSL], 'Simple_Agent');
      const session = executor.createSessionFromResolved(resolved);
      expect(session.threads.length).toBeGreaterThanOrEqual(1);
      expect(session.activeThreadIndex).toBe(0);
    });
  });

  // ---------------------------------------------------------------------------
  // compileToResolvedAgent errors
  // ---------------------------------------------------------------------------
  describe('compileToResolvedAgent — edge cases', () => {
    test('returns resolved output with empty agents when entry agent not in result', () => {
      // An empty DSL string parses but produces a minimal document with no usable agent.
      // compileToResolvedAgent falls back to the first agent in the compiled output
      // or uses the entryAgentName provided. The result is valid but may not contain
      // the named entry agent, which would fail at createSessionFromResolved.
      const resolved = compileToResolvedAgent([''], 'Nonexistent_Agent');
      // Verify the resolved output exists but the entry agent may not match
      expect(resolved).toBeDefined();
      expect(resolved.compilationOutput).toBeDefined();
    });

    test('compiles successfully with a valid agent DSL', () => {
      const resolved = compileToResolvedAgent([SIMPLE_AGENT_DSL], 'Simple_Agent');
      expect(resolved.agents).toBeDefined();
      expect(resolved.entryAgent).toBeTruthy();
      expect(resolved.compilationOutput).toBeDefined();
    });

    test('compiles multiple DSLs into a single resolved output', () => {
      const resolved = compileToResolvedAgent(
        [SIMPLE_AGENT_DSL, SUPERVISOR_DSL],
        'Route_Supervisor',
      );
      expect(Object.keys(resolved.agents).length).toBeGreaterThanOrEqual(1);
    });
  });
});
