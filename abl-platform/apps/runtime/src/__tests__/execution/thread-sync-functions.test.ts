import { describe, it, expect } from 'vitest';
import {
  getActiveThread,
  createThread,
  createInitialThread,
  syncThreadToSession,
} from '../../services/execution/types.js';
import type { RuntimeSession, AgentThread } from '../../services/execution/types.js';
import type { AgentIR, RichContentIR } from '@abl/compiler';

// =============================================================================
// HELPERS
// =============================================================================

function createMockAgentIR(overrides?: Partial<AgentIR>): AgentIR {
  return {
    name: 'test-agent',
    execution: { mode: 'scripted' },
    ...overrides,
  } as AgentIR;
}

function createMockSession(overrides?: Partial<RuntimeSession>): RuntimeSession {
  return {
    id: 'session-1',
    agentName: 'root-agent',
    agentIR: createMockAgentIR(),
    compilationOutput: null,
    conversationHistory: [],
    state: {
      gatherProgress: {},
      conversationPhase: 'start',
      context: {},
    },
    data: {
      values: {},
      gatheredKeys: new Set(),
    },
    isComplete: false,
    isEscalated: false,
    handoffStack: [],
    threads: [],
    activeThreadIndex: 0,
    threadStack: [],
    initialized: false,
    storeVersion: 0,
    createdAt: new Date(),
    lastActivityAt: new Date(),
    ...overrides,
  };
}

// =============================================================================
// TESTS
// =============================================================================

describe('syncThreadToSession', () => {
  it('should copy all session fields from active thread', () => {
    const threadState = {
      gatherProgress: { field1: 'done' },
      conversationPhase: 'gathering',
      context: { key: 'val' },
    };
    const threadData = {
      values: { name: 'Alice' },
      gatheredKeys: new Set(['name']),
    };
    const threadHistory = [{ role: 'user', content: 'hello' }];
    const threadRichContent: RichContentIR = {
      carousel: {
        cards: [{ title: 'Savings' }],
      },
    };

    const thread: AgentThread = {
      agentName: 'child-agent',
      agentIR: createMockAgentIR({ name: 'child-agent' }),
      conversationHistory: threadHistory,
      state: threadState,
      data: threadData,
      startedAt: Date.now(),
      returnExpected: false,
      status: 'active',
      currentFlowStep: 'step-2',
      waitingForInput: ['email'],
      pendingResponse: 'Please provide your email.',
      pendingRichContent: threadRichContent,
    };

    const session = createMockSession({
      threads: [thread],
      activeThreadIndex: 0,
    });

    syncThreadToSession(session);

    expect(session.agentName).toBe('child-agent');
    expect(session.agentIR).toBe(thread.agentIR);
    expect(session.conversationHistory).toBe(threadHistory);
    expect(session.state).toBe(threadState);
    expect(session.data).toBe(threadData);
    expect(session.currentFlowStep).toBe('step-2');
    expect(session.waitingForInput).toEqual(['email']);
    expect(session.pendingResponse).toBe('Please provide your email.');
    expect(session.pendingRichContent).toEqual(threadRichContent);
  });

  it('should handle missing active thread gracefully', () => {
    const session = createMockSession({
      threads: [],
      activeThreadIndex: 999,
    });

    // Should not throw
    expect(() => syncThreadToSession(session)).not.toThrow();
  });

  it('should sync escalation status from thread', () => {
    const thread: AgentThread = {
      agentName: 'escalating-agent',
      agentIR: null,
      conversationHistory: [],
      state: { gatherProgress: {}, conversationPhase: 'start', context: {} },
      data: { values: {}, gatheredKeys: new Set() },
      startedAt: Date.now(),
      returnExpected: false,
      status: 'escalated',
    };

    const session = createMockSession({
      threads: [thread],
      activeThreadIndex: 0,
      isEscalated: false,
    });

    syncThreadToSession(session);

    expect(session.isEscalated).toBe(true);
  });

  it('should sync completion status from thread', () => {
    const thread: AgentThread = {
      agentName: 'done-agent',
      agentIR: null,
      conversationHistory: [],
      state: { gatherProgress: {}, conversationPhase: 'start', context: {} },
      data: { values: {}, gatheredKeys: new Set() },
      startedAt: Date.now(),
      returnExpected: false,
      status: 'completed',
    };

    const session = createMockSession({
      threads: [thread],
      activeThreadIndex: 0,
      isComplete: false,
    });

    syncThreadToSession(session);

    expect(session.isComplete).toBe(true);
  });

  it('should create reference equality for data and conversationHistory', () => {
    const threadHistory = [{ role: 'assistant', content: 'hi' }];
    const threadData = {
      values: { x: 1 },
      gatheredKeys: new Set(['x']),
    };

    const thread: AgentThread = {
      agentName: 'ref-agent',
      agentIR: null,
      conversationHistory: threadHistory,
      state: { gatherProgress: {}, conversationPhase: 'start', context: {} },
      data: threadData,
      startedAt: Date.now(),
      returnExpected: false,
      status: 'active',
    };

    const session = createMockSession({
      threads: [thread],
      activeThreadIndex: 0,
    });

    syncThreadToSession(session);

    // Same reference, not a copy
    expect(session.data).toBe(thread.data);
    expect(session.conversationHistory).toBe(thread.conversationHistory);
  });

  it('should overwrite session.waitingForInput with thread value (including undefined)', () => {
    const thread: AgentThread = {
      agentName: 'no-wait-agent',
      agentIR: null,
      conversationHistory: [],
      state: { gatherProgress: {}, conversationPhase: 'start', context: {} },
      data: { values: {}, gatheredKeys: new Set() },
      startedAt: Date.now(),
      returnExpected: false,
      status: 'active',
      waitingForInput: undefined,
    };

    const session = createMockSession({
      threads: [thread],
      activeThreadIndex: 0,
      waitingForInput: ['name', 'email'],
    });

    expect(session.waitingForInput).toEqual(['name', 'email']);

    syncThreadToSession(session);

    expect(session.waitingForInput).toBeUndefined();
  });
});

describe('createInitialThread', () => {
  it('should skip if threads already exist', () => {
    const existingThread: AgentThread = {
      agentName: 'existing',
      agentIR: null,
      conversationHistory: [],
      state: { gatherProgress: {}, conversationPhase: 'start', context: {} },
      data: { values: {}, gatheredKeys: new Set() },
      startedAt: Date.now(),
      returnExpected: false,
      status: 'active',
    };

    const session = createMockSession({
      threads: [existingThread],
    });

    createInitialThread(session);

    expect(session.threads).toHaveLength(1);
    expect(session.threads[0]).toBe(existingThread);
  });

  it('should create thread from top-level session fields', () => {
    const session = createMockSession({
      agentName: 'main-agent',
      currentFlowStep: 'greeting',
      waitingForInput: ['customer_name'],
      pendingResponse: 'Welcome!',
      threads: [],
    });

    createInitialThread(session);

    expect(session.threads).toHaveLength(1);
    const thread = session.threads[0];
    expect(thread.agentName).toBe('main-agent');
    expect(thread.currentFlowStep).toBe('greeting');
    expect(thread.waitingForInput).toEqual(['customer_name']);
    expect(thread.pendingResponse).toBe('Welcome!');
    expect(thread.status).toBe('active');
    expect(thread.returnExpected).toBe(false);
  });

  it('should alias conversationHistory (same reference)', () => {
    const history = [{ role: 'user', content: 'hi' }];
    const session = createMockSession({
      conversationHistory: history,
      threads: [],
    });

    createInitialThread(session);

    expect(session.threads[0].conversationHistory).toBe(session.conversationHistory);
  });

  it('should set activeThreadIndex=0 and threadStack=[]', () => {
    const session = createMockSession({
      activeThreadIndex: 5,
      threadStack: [1, 2],
      threads: [],
    });

    createInitialThread(session);

    expect(session.activeThreadIndex).toBe(0);
    expect(session.threadStack).toEqual([]);
  });
});

describe('createThread', () => {
  it('should create independent conversation history', () => {
    const session = createMockSession({
      conversationHistory: [{ role: 'user', content: 'existing' }],
    });

    const thread = createThread(session, 'new-agent', null);

    expect(thread.conversationHistory).not.toBe(session.conversationHistory);
    expect(thread.conversationHistory).toEqual([]);
  });

  it('should preserve handoff context from options', () => {
    const session = createMockSession();
    const handoffContext = { priority: 'high', source: 'supervisor' };

    const thread = createThread(session, 'target-agent', null, {
      handoffContext,
    });

    expect(thread.handoffContext).toEqual({ priority: 'high', source: 'supervisor' });
  });

  it('should deep-copy initialHistory (not alias)', () => {
    const session = createMockSession();
    const initialHistory: Array<{ role: string; content: string }> = [
      { role: 'user', content: 'original message' },
    ];

    const thread = createThread(session, 'copy-agent', null, {
      initialHistory,
    });

    // Modify the original array after thread creation
    initialHistory.push({ role: 'assistant', content: 'appended' });

    // Thread history should not be affected
    expect(thread.conversationHistory).toHaveLength(1);
    expect(thread.conversationHistory[0].content).toBe('original message');
  });

  it('should initialize with correct entry point from flow IR', () => {
    const session = createMockSession();
    const agentIR = createMockAgentIR({
      flow: {
        entry_point: 'step-1',
        steps: ['step-1', 'step-2'],
      },
    } as Partial<AgentIR>);

    const thread = createThread(session, 'flow-agent', agentIR);

    expect(thread.currentFlowStep).toBe('step-1');
  });
});
