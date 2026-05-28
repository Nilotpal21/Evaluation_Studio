import { describe, test, expect } from 'vitest';
import {
  createChildSession,
  createChildSessionForDelegate,
  createChildSessionForFanOut,
  createExecutionId,
} from '../child-session.js';

function makeSession() {
  return {
    id: 'sess-1',
    agentName: 'Supervisor',
    agentIR: { metadata: { name: 'Supervisor' } },
    compilationOutput: null,
    conversationHistory: [{ role: 'user', content: 'hello' }],
    state: { gatherProgress: {}, conversationPhase: 'start', context: {} },
    data: { values: { existing: 'value' }, gatheredKeys: new Set<string>() },
    executionTreeValues: { 'workflow.auth_token': 'shared-token' },
    isComplete: false,
    isEscalated: false,
    handoffStack: ['Supervisor'],
    delegateStack: ['Supervisor'],
    handoffReturnInfo: { Worker_Agent: true },
    intentQueue: { items: ['queued-intent'] },
    _pinnedIntent: 'billing',
    pendingContentBlocks: [{ type: 'text', text: 'pending' }],
    currentAttachmentIds: ['att-1'],
    _activationAuthContext: {
      tenantId: 'tenant-1',
      projectId: 'proj-1',
      userId: 'user-1',
    },
    tenantId: 'tenant-1',
    projectId: 'proj-1',
    userId: 'user-1',
    channelType: 'sdk_websocket',
    callerContext: { customerId: 'c1' },
    toolExecutor: { execute: async () => ({}) },
    factStore: undefined,
    llmClient: { chat: async () => ({}) },
    initialized: true,
    threads: [
      {
        agentName: 'Supervisor',
        agentIR: { metadata: { name: 'Supervisor' } },
        conversationHistory: [{ role: 'user', content: 'hello' }],
        state: { gatherProgress: {}, conversationPhase: 'start', context: {} },
        data: { values: {}, gatheredKeys: new Set<string>() },
        activationAuthContext: {
          tenantId: 'tenant-1',
          projectId: 'proj-1',
          userId: 'user-1',
        },
        startedAt: Date.now(),
        returnExpected: false,
        status: 'active' as const,
      },
      {
        agentName: 'ChildAgent',
        agentIR: { metadata: { name: 'ChildAgent' } },
        conversationHistory: [],
        state: { gatherProgress: {}, conversationPhase: 'start', context: {} },
        data: { values: { _fan_out_child: true }, gatheredKeys: new Set<string>() },
        activationAuthContext: {
          tenantId: 'tenant-1',
          projectId: 'proj-1',
          userId: 'user-1',
          branchAgentName: 'ChildAgent',
        },
        startedAt: Date.now(),
        returnExpected: false,
        status: 'active' as const,
      },
    ],
    activeThreadIndex: 0,
    threadStack: [],
    createdAt: new Date(),
    lastActivityAt: new Date(),
    storeVersion: 1,
  };
}

describe('createChildSession', () => {
  test('child session has mutable fields from the child thread', () => {
    const parent = makeSession();
    const child = createChildSessionForFanOut(parent, 1);
    expect(child.agentName).toBe('ChildAgent');
    expect(child.conversationHistory).toBe(parent.threads[1].conversationHistory);
    expect(child.state).toBe(parent.threads[1].state);
    expect(child.data).toBe(parent.threads[1].data);
    expect(child.activeThreadIndex).toBe(1);
  });

  test('child session shares immutable identity from parent', () => {
    const parent = makeSession();
    const child = createChildSessionForFanOut(parent, 1);
    expect(child.id).toBe(parent.id);
    expect(child.tenantId).toBe(parent.tenantId);
    expect(child.projectId).toBe(parent.projectId);
    expect(child.callerContext).toBe(parent.callerContext);
    expect(child.channelType).toBe(parent.channelType);
    expect(child.compilationOutput).toBe(parent.compilationOutput);
    expect(child.toolExecutor).toBe(parent.toolExecutor);
  });

  test('child session keeps workflow-scoped executionTreeValues shared with the parent', () => {
    const parent = makeSession();
    const child = createChildSessionForFanOut(parent, 1);

    expect(child.executionTreeValues).toBe(parent.executionTreeValues);
    expect(child.executionTreeValues).toEqual({ 'workflow.auth_token': 'shared-token' });
  });

  test('child session has isComplete and isEscalated reset', () => {
    const parent = makeSession();
    parent.isComplete = true;
    parent.isEscalated = true;
    const child = createChildSessionForFanOut(parent, 1);
    expect(child.isComplete).toBe(false);
    expect(child.isEscalated).toBe(false);
  });

  test('child session clones threads array', () => {
    const parent = makeSession();
    const child = createChildSessionForFanOut(parent, 1);
    expect(child.threads).not.toBe(parent.threads);
    expect(child.threads).toEqual(parent.threads);
  });

  test('fan-out child session clears control-plane routing and intent state', () => {
    const parent = makeSession();
    const child = createChildSessionForFanOut(parent, 1);

    expect(child.handoffReturnInfo).toBeUndefined();
    expect(child.intentQueue).toBeUndefined();
    expect(child._pinnedIntent).toBeUndefined();
    expect(child.pendingContentBlocks).toBeUndefined();
    expect(child.currentAttachmentIds).toBeUndefined();
  });

  test('child session picks up activation auth context from the active thread', () => {
    const parent = makeSession();
    const child = createChildSessionForFanOut(parent, 1);

    expect(child._activationAuthContext).toEqual(
      expect.objectContaining({
        tenantId: 'tenant-1',
        projectId: 'proj-1',
        userId: 'user-1',
        branchAgentName: 'ChildAgent',
      }),
    );
  });

  test('default createChildSession alias uses safe fan-out sanitization', () => {
    const parent = makeSession();
    const child = createChildSession(parent, 1);

    expect(child.handoffReturnInfo).toBeUndefined();
    expect(child.intentQueue).toBeUndefined();
  });

  test('throws on invalid thread index', () => {
    const parent = makeSession();
    expect(() => createChildSession(parent, 99)).toThrow('Thread index 99 out of bounds');
  });

  test('delegate child session isolates the active thread state from the parent', () => {
    const parent = makeSession();
    const child = createChildSessionForDelegate(parent, 1);

    expect(child.threads[1]).not.toBe(parent.threads[1]);
    expect(child.conversationHistory).not.toBe(parent.threads[1].conversationHistory);
    expect(child.state).not.toBe(parent.threads[1].state);
    expect(child.data).not.toBe(parent.threads[1].data);

    child.conversationHistory.push({ role: 'assistant', content: 'delegated reply' });
    (child.state as { context: Record<string, unknown> }).context.result = 'captured';
    (child.data as { values: Record<string, unknown>; gatheredKeys: Set<string> }).values.result =
      'captured';
    (child.data as { values: Record<string, unknown>; gatheredKeys: Set<string> }).gatheredKeys.add(
      'result',
    );

    expect(parent.threads[1].conversationHistory).toEqual([]);
    expect(parent.threads[1].state).toEqual({
      gatherProgress: {},
      conversationPhase: 'start',
      context: {},
    });
    expect(parent.threads[1].data).toEqual({
      values: { _fan_out_child: true },
      gatheredKeys: new Set<string>(),
    });
  });

  test('delegate child session clones execution stacks', () => {
    const parent = makeSession();
    parent.handoffStack = ['Supervisor', 'ChildAgent'];
    parent.delegateStack = ['Supervisor', 'ChildAgent'];
    parent.threadStack = [0, 1];

    const child = createChildSessionForDelegate(parent, 1);

    expect(child.handoffStack).toEqual(parent.handoffStack);
    expect(child.handoffStack).not.toBe(parent.handoffStack);
    expect(child.delegateStack).toEqual(parent.delegateStack);
    expect(child.delegateStack).not.toBe(parent.delegateStack);
    expect(child.threadStack).toEqual(parent.threadStack);
    expect(child.threadStack).not.toBe(parent.threadStack);

    child.handoffStack?.push('DetachedAgent');
    child.delegateStack?.push('DetachedAgent');
    child.threadStack?.push(9);

    expect(parent.handoffStack).toEqual(['Supervisor', 'ChildAgent']);
    expect(parent.delegateStack).toEqual(['Supervisor', 'ChildAgent']);
    expect(parent.threadStack).toEqual([0, 1]);
  });
});

describe('createExecutionId', () => {
  test('returns a string with exec- prefix', () => {
    const id = createExecutionId();
    expect(id).toMatch(/^exec-/);
  });

  test('returns unique values', () => {
    const ids = new Set(Array.from({ length: 100 }, () => createExecutionId()));
    expect(ids.size).toBe(100);
  });
});
