/**
 * Session Conversation Sync Tests
 *
 * Covers:
 * - MemorySessionStore: save() persists conversationHistory (Finding 1)
 * - MemorySessionStore: getConversationHistory(limit=1) off-by-one (Finding 6)
 * - MemorySessionStore: trimConversation(maxMessages=1) off-by-one (Finding 6)
 * - addMessage double-push prevention with aliased arrays (Finding 4)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MemorySessionStore } from '../../services/session/memory-session-store.js';
import {
  RuntimeExecutor,
  getActiveThread,
  createInitialThread,
} from '../../services/runtime-executor.js';
import { createThread } from '../../services/execution/types.js';
import type { SessionData, HydratedSession } from '../../services/session/types.js';
import type { AgentIR, CompilationOutput } from '@abl/compiler';

interface MockCreateSessionParams {
  id: string;
  agentName: string;
  agentIR: AgentIR | null;
  compilationOutput: CompilationOutput | null;
  handoffStack?: string[];
  initialContext?: Record<string, unknown>;
  isFlowMode?: boolean;
  entryPoint?: string;
  tenantId?: string;
  projectId?: string;
  authToken?: string;
  userId?: string;
  deploymentId?: string;
  environment?: string;
  agentVersions?: Record<string, number>;
  callerContext?: SessionData['callerContext'];
  maxAgeSeconds?: number;
  idleSeconds?: number;
}

// =============================================================================
// FIXTURES
// =============================================================================

function createMockSessionData(overrides: Partial<SessionData> = {}): SessionData {
  return {
    id: 'sess-1',
    agentName: 'test-agent',
    irSourceHash: 'hash-1',
    compilationHash: null,
    conversationHistory: [
      { role: 'system', content: 'You are a helpful assistant.' },
      { role: 'user', content: 'Hello' },
      { role: 'assistant', content: 'Hi!' },
    ],
    state: { gatherProgress: {}, conversationPhase: 'active', context: {} },
    dataValues: {},
    dataGatheredKeys: [],
    version: 1,
    isComplete: false,
    isEscalated: false,
    handoffStack: [],
    delegateStack: [],
    initialized: false,
    createdAt: Date.now(),
    lastActivityAt: Date.now(),
    threads: [],
    activeThreadIndex: 0,
    threadStack: [],
    ...overrides,
  };
}

function createMockAgentIR(name = 'test-agent'): AgentIR {
  return {
    metadata: { name, version: '1.0', description: 'Test agent' },
    execution: { mode: 'reasoning' },
    tools: [],
    messages: {},
  } as AgentIR;
}

function createMockHydratedSession(overrides: Partial<HydratedSession> = {}): HydratedSession {
  const agentIR = createMockAgentIR();

  return {
    ...createMockSessionData(),
    agentIR,
    compilationOutput: {
      agents: { [agentIR.metadata.name]: agentIR },
      entry_agent: agentIR.metadata.name,
    } as CompilationOutput,
    ...overrides,
  };
}

function createMockCreatedSession(params: MockCreateSessionParams): HydratedSession {
  return createMockHydratedSession({
    id: params.id,
    agentName: params.agentName,
    agentIR: params.agentIR,
    compilationOutput: params.compilationOutput,
    handoffStack: params.handoffStack || [params.agentName],
    currentFlowStep: params.isFlowMode ? params.entryPoint : undefined,
    dataValues: params.initialContext || { session: { channel: 'digital' } },
    tenantId: params.tenantId,
    projectId: params.projectId,
    authToken: params.authToken,
    userId: params.userId,
    deploymentId: params.deploymentId,
    environment: params.environment,
    agentVersions: params.agentVersions,
    callerContext: params.callerContext,
    maxAgeSeconds: params.maxAgeSeconds,
    idleSeconds: params.idleSeconds,
    version: 0,
    conversationHistory: [],
  });
}

// =============================================================================
// MEMORY SESSION STORE — save() CONVERSATION SYNC (Finding 1)
// =============================================================================

describe('MemorySessionStore conversation sync', () => {
  let store: MemorySessionStore;

  beforeEach(() => {
    store = new MemorySessionStore();
  });

  it('save() persists conversationHistory changes', async () => {
    const session = createMockSessionData();
    await store.create(session);

    // Mutate conversation and save
    const updated = { ...session, version: 2 };
    updated.conversationHistory = [
      ...session.conversationHistory,
      { role: 'user', content: 'How are you?' },
      { role: 'assistant', content: 'Fine!' },
    ];

    const saved = await store.save(updated);
    expect(saved).toBe(true);

    // load() should return the updated conversation
    const loaded = await store.load('sess-1');
    expect(loaded).not.toBeNull();
    expect(loaded!.conversationHistory).toHaveLength(5);
    expect(loaded!.conversationHistory[3]).toEqual({ role: 'user', content: 'How are you?' });
    expect(loaded!.conversationHistory[4]).toEqual({ role: 'assistant', content: 'Fine!' });
  });

  it('load() returns updated conversation after save()', async () => {
    const session = createMockSessionData();
    await store.create(session);

    // First load returns original
    const first = await store.load('sess-1');
    expect(first!.conversationHistory).toHaveLength(3);

    // Save with new messages
    const updated = {
      ...session,
      version: 2,
      conversationHistory: [{ role: 'user', content: 'Only this' }],
    };
    await store.save(updated);

    // Second load returns new conversation
    const second = await store.load('sess-1');
    expect(second!.conversationHistory).toHaveLength(1);
    expect(second!.conversationHistory[0]).toEqual({ role: 'user', content: 'Only this' });
  });
});

// =============================================================================
// MEMORY SESSION STORE — WINDOWING OFF-BY-ONE (Finding 6)
// =============================================================================

describe('MemorySessionStore conversation windowing', () => {
  let store: MemorySessionStore;

  beforeEach(async () => {
    store = new MemorySessionStore();
    const session = createMockSessionData({
      conversationHistory: [
        { role: 'system', content: 'System prompt' },
        { role: 'user', content: 'msg1' },
        { role: 'assistant', content: 'reply1' },
        { role: 'user', content: 'msg2' },
        { role: 'assistant', content: 'reply2' },
      ],
    });
    await store.create(session);
  });

  it('getConversationHistory(limit=1) returns only the first message', async () => {
    const result = await store.getConversationHistory('sess-1', 1);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({ role: 'system', content: 'System prompt' });
  });

  it('getConversationHistory(limit=2) returns first + last message', async () => {
    const result = await store.getConversationHistory('sess-1', 2);
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({ role: 'system', content: 'System prompt' });
    expect(result[1]).toEqual({ role: 'assistant', content: 'reply2' });
  });

  it('getConversationHistory(limit=3) returns first + last 2 messages', async () => {
    const result = await store.getConversationHistory('sess-1', 3);
    expect(result).toHaveLength(3);
    expect(result[0]).toEqual({ role: 'system', content: 'System prompt' });
    expect(result[1]).toEqual({ role: 'user', content: 'msg2' });
    expect(result[2]).toEqual({ role: 'assistant', content: 'reply2' });
  });

  it('getConversationHistory() without limit returns all messages', async () => {
    const result = await store.getConversationHistory('sess-1');
    expect(result).toHaveLength(5);
  });

  it('trimConversation(maxMessages=1) keeps only the first message', async () => {
    await store.trimConversation('sess-1', 1);
    const result = await store.getConversationHistory('sess-1');
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({ role: 'system', content: 'System prompt' });
  });

  it('trimConversation(maxMessages=2) keeps first + last message', async () => {
    await store.trimConversation('sess-1', 2);
    const result = await store.getConversationHistory('sess-1');
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({ role: 'system', content: 'System prompt' });
    expect(result[1]).toEqual({ role: 'assistant', content: 'reply2' });
  });
});

// =============================================================================
// addMessage DOUBLE-PUSH PREVENTION (Finding 4)
// =============================================================================

describe('addMessage double-push prevention', () => {
  let executor: RuntimeExecutor;
  let mockSessionService: any;

  beforeEach(() => {
    vi.clearAllMocks();
    executor = new RuntimeExecutor();

    mockSessionService = {
      loadSession: vi.fn(),
      createSession: vi.fn(async (params: MockCreateSessionParams) =>
        createMockCreatedSession(params),
      ),
      saveSession: vi.fn(),
      store: {
        load: vi.fn(async () => null),
      },
      deleteSession: vi.fn(),
      appendToConversation: vi.fn(),
      cacheAgentIR: vi.fn().mockResolvedValue('hash'),
      resolveAgentIR: vi.fn(),
      cacheCompilationOutput: vi.fn().mockResolvedValue('hash'),
      setAgentRegistry: vi.fn(),
      getAgentRegistry: vi.fn(),
      acquireLock: vi.fn().mockResolvedValue(true),
      releaseLock: vi.fn(),
      getConfig: vi.fn().mockReturnValue({ store: 'memory' }),
      computeIRHash: vi.fn().mockReturnValue('hash'),
      computeCompilationHash: vi.fn().mockReturnValue('hash'),
    };

    executor.setSessionService(mockSessionService);
  });

  it('addMessage with aliased thread/session does not double-push', () => {
    // Create a session using createSessionFromResolved (which calls createInitialThread)
    const agentIR = createMockAgentIR();
    const resolved = {
      agents: { 'test-agent': agentIR },
      entryAgent: 'test-agent',
      compilationOutput: {
        agents: { 'test-agent': agentIR },
        entry_agent: 'test-agent',
      } as CompilationOutput,
      versionInfo: { deploymentId: undefined, environment: undefined, versions: {} },
    };

    const session = executor.createSessionFromResolved(resolved, {
      channelType: 'digital',
    });

    // Verify initial thread is aliased to session
    const thread = getActiveThread(session);
    expect(thread).toBeDefined();
    expect(thread.conversationHistory).toBe(session.conversationHistory);

    // Add a message
    executor.addMessage(session.id, 'user', 'Hello');

    // Should have exactly 1 message, not 2
    expect(session.conversationHistory).toHaveLength(1);
    expect(thread.conversationHistory).toHaveLength(1);
    expect(session.conversationHistory[0]).toEqual({ role: 'user', content: 'Hello' });
  });

  it('addMessage with no active thread pushes to session directly', () => {
    // Manually create a session in the executor with no threads
    const agentIR = createMockAgentIR();
    const resolved = {
      agents: { 'test-agent': agentIR },
      entryAgent: 'test-agent',
      compilationOutput: {
        agents: { 'test-agent': agentIR },
        entry_agent: 'test-agent',
      } as CompilationOutput,
      versionInfo: { deploymentId: undefined, environment: undefined, versions: {} },
    };

    const session = executor.createSessionFromResolved(resolved, {
      channelType: 'digital',
    });

    // Force clear threads to simulate edge case
    session.threads = [];

    executor.addMessage(session.id, 'user', 'Hello');

    // Should push to session directly
    expect(session.conversationHistory).toHaveLength(1);
    expect(session.conversationHistory[0]).toEqual({ role: 'user', content: 'Hello' });
  });

  it('message count matches expected after multiple addMessage calls', () => {
    const agentIR = createMockAgentIR();
    const resolved = {
      agents: { 'test-agent': agentIR },
      entryAgent: 'test-agent',
      compilationOutput: {
        agents: { 'test-agent': agentIR },
        entry_agent: 'test-agent',
      } as CompilationOutput,
      versionInfo: { deploymentId: undefined, environment: undefined, versions: {} },
    };

    const session = executor.createSessionFromResolved(resolved, {
      channelType: 'digital',
    });

    executor.addMessage(session.id, 'user', 'Hello');
    executor.addMessage(session.id, 'assistant', 'Hi!');
    executor.addMessage(session.id, 'user', 'How are you?');

    expect(session.conversationHistory).toHaveLength(3);
    expect(getActiveThread(session).conversationHistory).toHaveLength(3);
  });
});

// =============================================================================
// MEMORY SESSION STORE — appendMessages EDGE CASES
// =============================================================================

describe('MemorySessionStore appendMessages edge cases', () => {
  let store: MemorySessionStore;

  beforeEach(() => {
    store = new MemorySessionStore();
  });

  it('appendMessages to unknown session should not crash', async () => {
    // Calling appendMessages for a session that was never created should
    // silently drop the messages (with a console.warn) — not throw.
    await expect(
      store.appendMessages('nonexistent-session', [{ role: 'user', content: 'Hello' }]),
    ).resolves.toBeUndefined();
  });

  it('appendMessages to valid session should append all messages', async () => {
    const session = createMockSessionData({ id: 'append-test' });
    await store.create(session);

    const newMessages = [
      { role: 'user' as const, content: 'msg1' },
      { role: 'assistant' as const, content: 'reply1' },
      { role: 'user' as const, content: 'msg2' },
    ];
    await store.appendMessages('append-test', newMessages);

    const history = await store.getConversationHistory('append-test');
    // Original 3 from createMockSessionData + 3 new = 6
    expect(history).toHaveLength(6);
    expect(history[3]).toEqual({ role: 'user', content: 'msg1' });
    expect(history[4]).toEqual({ role: 'assistant', content: 'reply1' });
    expect(history[5]).toEqual({ role: 'user', content: 'msg2' });
  });
});

// =============================================================================
// MEMORY SESSION STORE — VERSION CONFLICT IN save()
// =============================================================================

describe('MemorySessionStore version conflict in save()', () => {
  let store: MemorySessionStore;

  beforeEach(() => {
    store = new MemorySessionStore();
  });

  it('save should return false on version conflict', async () => {
    const session = createMockSessionData({ id: 'conflict-test', version: 0 });
    await store.create(session);

    // First save: version=1 means expected existing = 0, which matches → succeeds
    const first = await store.save({ ...session, version: 1 });
    expect(first).toBe(true);

    // Second save with version=1 again: expected existing = 0,
    // but store now has version 1 → conflict → returns false
    const second = await store.save({ ...session, version: 1 });
    expect(second).toBe(false);
  });

  it('save should return false when session does not exist', async () => {
    const session = createMockSessionData({ id: 'ghost-session', version: 1 });
    // Never called store.create(), so the session doesn't exist
    const result = await store.save(session);
    expect(result).toBe(false);
  });
});

// =============================================================================
// MEMORY SESSION STORE — DELETE CASCADING CLEANUP
// =============================================================================

describe('MemorySessionStore delete cascading cleanup', () => {
  let store: MemorySessionStore;

  beforeEach(() => {
    store = new MemorySessionStore();
  });

  it('delete should remove session, conversation, and related data', async () => {
    const session = createMockSessionData({ id: 'delete-test' });
    await store.create(session);

    // Add extra data
    await store.appendMessages('delete-test', [{ role: 'user', content: 'extra' }]);
    await store.setAgentRegistry('delete-test', { 'test-agent': 'hash-1' });

    // Verify data exists before delete
    expect(await store.load('delete-test')).not.toBeNull();
    expect(await store.getConversationHistory('delete-test')).toHaveLength(4);
    expect(await store.getAgentRegistry('delete-test')).not.toBeNull();

    // Delete
    await store.delete('delete-test');

    // All data should be gone
    expect(await store.load('delete-test')).toBeNull();
    expect(await store.getConversationHistory('delete-test')).toHaveLength(0);
    expect(await store.getAgentRegistry('delete-test')).toBeNull();
  });
});

// =============================================================================
// MEMORY SESSION STORE — trimConversation EDGE CASES
// =============================================================================

describe('MemorySessionStore trimConversation edge cases', () => {
  let store: MemorySessionStore;

  beforeEach(() => {
    store = new MemorySessionStore();
  });

  it('trimConversation on empty conversation should be safe', async () => {
    const session = createMockSessionData({
      id: 'trim-empty',
      conversationHistory: [],
    });
    await store.create(session);

    // Should not throw on empty conversation
    await expect(store.trimConversation('trim-empty', 5)).resolves.toBeUndefined();

    const history = await store.getConversationHistory('trim-empty');
    expect(history).toHaveLength(0);
  });

  it('trimConversation when message count <= maxMessages should not trim', async () => {
    const session = createMockSessionData({
      id: 'trim-noop',
      conversationHistory: [
        { role: 'system', content: 'System prompt' },
        { role: 'user', content: 'Hello' },
        { role: 'assistant', content: 'Hi!' },
      ],
    });
    await store.create(session);

    // maxMessages=5 is greater than the 3 messages — nothing should be trimmed
    await store.trimConversation('trim-noop', 5);

    const history = await store.getConversationHistory('trim-noop');
    expect(history).toHaveLength(3);
    expect(history[0]).toEqual({ role: 'system', content: 'System prompt' });
    expect(history[1]).toEqual({ role: 'user', content: 'Hello' });
    expect(history[2]).toEqual({ role: 'assistant', content: 'Hi!' });
  });
});

// =============================================================================
// MEMORY SESSION STORE — getConversationHistory EDGE CASES
// =============================================================================

describe('MemorySessionStore getConversationHistory edge cases', () => {
  let store: MemorySessionStore;

  beforeEach(async () => {
    store = new MemorySessionStore();
    const session = createMockSessionData({
      id: 'history-edge',
      conversationHistory: [
        { role: 'system', content: 'System prompt' },
        { role: 'user', content: 'msg1' },
        { role: 'assistant', content: 'reply1' },
      ],
    });
    await store.create(session);
  });

  it('getConversationHistory with limit=0 should return all messages', async () => {
    // limit=0 is falsy, so windowing should not apply
    const result = await store.getConversationHistory('history-edge', 0);
    expect(result).toHaveLength(3);
    expect(result[0]).toEqual({ role: 'system', content: 'System prompt' });
    expect(result[1]).toEqual({ role: 'user', content: 'msg1' });
    expect(result[2]).toEqual({ role: 'assistant', content: 'reply1' });
  });

  it('getConversationHistory when count < limit should return all messages', async () => {
    // 3 messages with limit=10 — all 3 should be returned
    const result = await store.getConversationHistory('history-edge', 10);
    expect(result).toHaveLength(3);
    expect(result[0]).toEqual({ role: 'system', content: 'System prompt' });
    expect(result[1]).toEqual({ role: 'user', content: 'msg1' });
    expect(result[2]).toEqual({ role: 'assistant', content: 'reply1' });
  });

  it('getConversationHistory for unknown session returns empty array', async () => {
    const result = await store.getConversationHistory('no-such-session');
    expect(result).toEqual([]);
    expect(result).toHaveLength(0);
  });
});

// =============================================================================
// createThread (NON-ALIASED) + addMessage BEHAVIOR
// =============================================================================

describe('createThread (non-aliased) + addMessage behavior', () => {
  let executor: RuntimeExecutor;
  let mockSessionService: any;

  beforeEach(() => {
    vi.clearAllMocks();
    executor = new RuntimeExecutor();

    mockSessionService = {
      loadSession: vi.fn(),
      createSession: vi.fn(async (params: MockCreateSessionParams) =>
        createMockCreatedSession(params),
      ),
      saveSession: vi.fn(),
      store: {
        load: vi.fn(async () => null),
      },
      deleteSession: vi.fn(),
      appendToConversation: vi.fn(),
      cacheAgentIR: vi.fn().mockResolvedValue('hash'),
      resolveAgentIR: vi.fn(),
      cacheCompilationOutput: vi.fn().mockResolvedValue('hash'),
      setAgentRegistry: vi.fn(),
      getAgentRegistry: vi.fn(),
      acquireLock: vi.fn().mockResolvedValue(true),
      releaseLock: vi.fn(),
      getConfig: vi.fn().mockReturnValue({ store: 'memory' }),
      computeIRHash: vi.fn().mockReturnValue('hash'),
      computeCompilationHash: vi.fn().mockReturnValue('hash'),
    };

    executor.setSessionService(mockSessionService);
  });

  it('createThread creates independent conversation history (not aliased to session)', () => {
    const agentIR = createMockAgentIR();
    const childAgentIR = createMockAgentIR('child-agent');
    const resolved = {
      agents: { 'test-agent': agentIR },
      entryAgent: 'test-agent',
      compilationOutput: {
        agents: { 'test-agent': agentIR },
        entry_agent: 'test-agent',
      } as CompilationOutput,
      versionInfo: { deploymentId: undefined, environment: undefined, versions: {} },
    };

    // Create the session (initial thread is aliased to session.conversationHistory)
    const session = executor.createSessionFromResolved(resolved, {
      channelType: 'digital',
    });

    // Add a message to the session's initial thread
    executor.addMessage(session.id, 'user', 'Hello from main');
    expect(session.conversationHistory).toHaveLength(1);

    // Create a child thread via createThread — this creates a NEW array,
    // not aliased to session.conversationHistory
    const childThread = createThread(session, 'child-agent', childAgentIR, {
      handoffFrom: 'test-agent',
    });

    // Push to child thread's conversationHistory should NOT affect session.conversationHistory
    childThread.conversationHistory.push({ role: 'user', content: 'Hello from child' });

    // Session still has only the original message
    expect(session.conversationHistory).toHaveLength(1);
    expect(session.conversationHistory[0]).toEqual({
      role: 'user',
      content: 'Hello from main',
    });

    // Child thread has its own independent message
    expect(childThread.conversationHistory).toHaveLength(1);
    expect(childThread.conversationHistory[0]).toEqual({
      role: 'user',
      content: 'Hello from child',
    });

    // Verify they are different array references
    expect(childThread.conversationHistory).not.toBe(session.conversationHistory);
  });
});

// =============================================================================
// MEMORY SESSION STORE — replaceConversation (Gap 1)
// =============================================================================

describe('MemorySessionStore replaceConversation', () => {
  let store: MemorySessionStore;

  beforeEach(async () => {
    store = new MemorySessionStore();
    const session = createMockSessionData({
      conversationHistory: [
        { role: 'system', content: 'System prompt' },
        { role: 'user', content: 'msg1' },
        { role: 'assistant', content: 'reply1' },
      ],
    });
    await store.create(session);
  });

  it('replaces entire conversation history', async () => {
    const newConversation = [{ role: 'system', content: 'New system prompt' }];
    await store.replaceConversation('sess-1', newConversation);

    const history = await store.getConversationHistory('sess-1');
    expect(history).toHaveLength(1);
    expect(history[0]).toEqual({ role: 'system', content: 'New system prompt' });
  });

  it('replaces with empty array (session reset)', async () => {
    await store.replaceConversation('sess-1', []);

    const history = await store.getConversationHistory('sess-1');
    expect(history).toHaveLength(0);
  });

  it('does not throw for unknown session', async () => {
    await expect(
      store.replaceConversation('nonexistent', [{ role: 'user', content: 'hello' }]),
    ).resolves.toBeUndefined();
  });

  it('replaced conversation is independent from input array', async () => {
    const input = [{ role: 'user', content: 'hello' }];
    await store.replaceConversation('sess-1', input);

    // Mutating input should not affect stored conversation
    input.push({ role: 'assistant', content: 'hi' });

    const history = await store.getConversationHistory('sess-1');
    expect(history).toHaveLength(1);
  });
});
