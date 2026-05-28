import { describe, expect, it, vi } from 'vitest';
import type { AgentIR } from '@abl/compiler';
import {
  activateAgentExecutionContext,
  agentNeedsLLMWiring,
  deriveActivationAuthContext,
} from '../../services/execution/agent-activation-context.js';
import type {
  ActivationAuthContext,
  AgentThread,
  RuntimeSession,
} from '../../services/execution/types.js';

function makeAgentIR(name: string, overrides: Partial<AgentIR> = {}): AgentIR {
  return {
    ir_version: '1.0',
    metadata: { name, version: '1.0', type: 'agent' },
    identity: { role: `${name} role` },
    coordination: {},
    tools: [],
    ...overrides,
  } as AgentIR;
}

function makeThread(
  agentName: string,
  agentIR: AgentIR,
  overrides: Partial<AgentThread> = {},
): AgentThread {
  return {
    agentName,
    agentIR,
    conversationHistory: [],
    state: {
      gatherProgress: {},
      conversationPhase: 'active',
      context: {},
    },
    data: {
      values: {},
      gatheredKeys: new Set<string>(),
    },
    startedAt: Date.now(),
    returnExpected: false,
    status: 'active',
    ...overrides,
  };
}

function makeSession(overrides: Partial<RuntimeSession> = {}): RuntimeSession {
  const parentIR = makeAgentIR('Supervisor_Agent');
  const childIR = makeAgentIR('Billing_Agent');
  const parentThread = makeThread('Supervisor_Agent', parentIR, {
    activationAuthContext: {
      tenantId: 'tenant-1',
      projectId: 'project-1',
      userId: 'user-1',
      authToken: 'auth-token-1',
      authScope: 'user',
      callerContext: {
        channel: 'sdk_websocket',
        authScope: 'user',
      } as any,
    },
  });
  const childThread = makeThread('Billing_Agent', childIR, { status: 'waiting' });

  return {
    id: 'session-1',
    agentName: 'Supervisor_Agent',
    agentIR: parentIR,
    compilationOutput: {
      agents: {
        Supervisor_Agent: parentIR,
        Billing_Agent: childIR,
      },
    } as any,
    conversationHistory: [],
    state: {
      gatherProgress: {},
      conversationPhase: 'active',
      context: {},
    },
    data: {
      values: {},
      gatheredKeys: new Set<string>(),
    },
    isComplete: false,
    isEscalated: false,
    handoffStack: [],
    delegateStack: [],
    initialized: true,
    threads: [parentThread, childThread],
    activeThreadIndex: 0,
    threadStack: [],
    tenantId: 'tenant-1',
    projectId: 'project-1',
    userId: 'user-1',
    authToken: 'auth-token-1',
    callerContext: {
      channel: 'sdk_websocket',
      authScope: 'user',
    } as any,
    _activationAuthContext: parentThread.activationAuthContext,
    _effectiveConfig: {
      additionalInstructions: ['stale parent instruction'],
      additionalConstraints: [],
      tools: [],
      activeProfileNames: ['parent-profile'],
    },
    _activeProfileNames: ['parent-profile'],
    resolvedEnableThinking: true,
    resolvedThinkingBudget: 256,
    resolvedThoughtDescription: 'parent thought',
    resolvedCompactionThreshold: 4096,
    resolvedModelId: 'parent-model',
    createdAt: new Date(),
    lastActivityAt: new Date(),
    storeVersion: 0,
    ...overrides,
  } as RuntimeSession;
}

function makeWiring() {
  return {
    wireToolExecutor: vi.fn(
      (
        session: RuntimeSession,
        _compilationOutput: RuntimeSession['compilationOutput'],
        authToken?: string,
        tenantId?: string,
        projectId?: string,
      ) => {
        session.toolExecutor = {
          execute: vi.fn(),
          executeParallel: vi.fn(),
        } as any;
        session.authToken = authToken;
        session.tenantId = tenantId;
        session.projectId = projectId;
      },
    ),
    wireLLMClient: vi.fn(async (session: RuntimeSession, agentIR: AgentIR) => {
      session.llmClient = { agentName: agentIR.metadata.name } as any;
    }),
  };
}

describe('agent activation context', () => {
  it('derives auth context from the active thread first', () => {
    const session = makeSession({
      _activationAuthContext: {
        tenantId: 'tenant-fallback',
        projectId: 'project-fallback',
        userId: 'fallback-user',
      },
    });

    const context = deriveActivationAuthContext(session);

    expect(context.tenantId).toBe('tenant-1');
    expect(context.projectId).toBe('project-1');
    expect(context.userId).toBe('user-1');
    expect(context.authScope).toBe('user');
  });

  it('activates a delegate child, captures parent auth context, and rewires tools plus LLM', async () => {
    const session = makeSession();
    const wiring = makeWiring();
    const targetThread = session.threads[1];
    const traces: Array<{ type: string; data: Record<string, unknown> }> = [];

    await activateAgentExecutionContext({
      session,
      targetAgentName: 'Billing_Agent',
      targetIR: targetThread.agentIR as AgentIR,
      targetThread,
      authMode: 'delegate',
      llmWiring: wiring as any,
      onTraceEvent: (event) => traces.push(event),
    });

    expect(session.activeThreadIndex).toBe(1);
    expect(session.agentName).toBe('Billing_Agent');
    expect(session.state.activeAgent?.name).toBe('Billing_Agent');
    expect(session._effectiveConfig).toBeUndefined();
    expect(session._activeProfileNames).toBeUndefined();
    expect(session.resolvedModelId).toBeUndefined();
    expect(session.toolExecutor).toBeDefined();
    expect(session.llmClient).toEqual({ agentName: 'Billing_Agent' });
    expect(wiring.wireToolExecutor).toHaveBeenCalledWith(
      session,
      session.compilationOutput,
      'auth-token-1',
      'tenant-1',
      'project-1',
    );
    expect(wiring.wireLLMClient).toHaveBeenCalledWith(
      session,
      targetThread.agentIR,
      'tenant-1',
      'project-1',
      'user-1',
    );

    const parentThread = session.threads[0];
    expect(parentThread.activationAuthContext).toEqual(
      expect.objectContaining({
        tenantId: 'tenant-1',
        projectId: 'project-1',
        userId: 'user-1',
      }),
    );
    expect(targetThread.activationAuthContext).toEqual(
      expect.objectContaining({
        delegatedBy: ['session-1'],
        tenantId: 'tenant-1',
        projectId: 'project-1',
      }),
    );
    expect(traces).toContainEqual(
      expect.objectContaining({
        type: 'agent_activation',
        data: expect.objectContaining({
          agentName: 'Billing_Agent',
          authMode: 'delegate',
          delegatedDepth: 1,
        }),
      }),
    );
  });

  it('preserves the previous thread llm client when activating a different thread', async () => {
    const parentClient = { agentName: 'Supervisor_Agent', connection: 'mock-parent' } as any;
    const session = makeSession({
      llmClient: parentClient,
    });
    const wiring = makeWiring();
    const parentThread = session.threads[0];
    const targetThread = session.threads[1];

    await activateAgentExecutionContext({
      session,
      targetAgentName: 'Billing_Agent',
      targetIR: targetThread.agentIR as AgentIR,
      targetThread,
      authMode: 'handoff',
      llmWiring: wiring as any,
    });

    expect(parentThread.llmClient).toBe(parentClient);
    expect(session.llmClient).toEqual({ agentName: 'Billing_Agent' });
    expect(session.llmClient).not.toBe(parentClient);
    expect(targetThread.llmClient).toEqual({ agentName: 'Billing_Agent' });
  });

  it('restores an explicit parent auth context without extending the delegate chain again', async () => {
    const session = makeSession({ activeThreadIndex: 1 });
    const wiring = makeWiring();
    const parentThread = session.threads[0];
    const explicitParentContext: ActivationAuthContext = {
      tenantId: 'tenant-1',
      projectId: 'project-1',
      userId: 'user-1',
      authToken: 'auth-token-1',
      authScope: 'user',
      delegatedBy: ['root-session'],
    };
    parentThread.activationAuthContext = explicitParentContext;
    session._activationAuthContext = {
      ...explicitParentContext,
      delegatedBy: ['root-session', 'session-1'],
    };

    await activateAgentExecutionContext({
      session,
      targetAgentName: 'Supervisor_Agent',
      targetIR: parentThread.agentIR as AgentIR,
      targetThread: parentThread,
      authMode: 'delegate',
      authContext: explicitParentContext,
      llmWiring: wiring as any,
    });

    expect(session.activeThreadIndex).toBe(0);
    expect(session._activationAuthContext?.delegatedBy).toEqual(['root-session']);
  });

  it('creates isolated fan-out branch auth state', async () => {
    const session = makeSession();
    const wiring = makeWiring();
    const firstChild = session.threads[1];
    const secondChild = makeThread('Returns_Agent', makeAgentIR('Returns_Agent'), {
      status: 'waiting',
    });
    session.threads.push(secondChild);

    await activateAgentExecutionContext({
      session,
      targetAgentName: 'Billing_Agent',
      targetIR: firstChild.agentIR as AgentIR,
      targetThread: firstChild,
      authMode: 'fan_out',
      childSessionId: 'session-1__fanout__billing',
      llmWiring: wiring as any,
    });
    const firstContext = firstChild.activationAuthContext!;

    await activateAgentExecutionContext({
      session,
      targetAgentName: 'Returns_Agent',
      targetIR: secondChild.agentIR as AgentIR,
      targetThread: secondChild,
      authMode: 'fan_out',
      childSessionId: 'session-1__fanout__returns',
      llmWiring: wiring as any,
    });
    const secondContext = secondChild.activationAuthContext!;

    expect(firstContext.branchAgentName).toBe('Billing_Agent');
    expect(secondContext.branchAgentName).toBe('Returns_Agent');
    expect(firstContext.branchCredentialCache).toBeDefined();
    expect(secondContext.branchCredentialCache).toBeDefined();
    expect(firstContext.branchCredentialCache).not.toBe(secondContext.branchCredentialCache);
  });

  it('skips and clears LLM state for pure scripted agents when requested', async () => {
    const flowIR = makeAgentIR('Flow_Agent', {
      flow: {
        entry_point: 'start',
        steps: ['start'],
        definitions: {
          start: {
            type: 'respond',
            message: 'hello',
          },
        },
      },
    });
    const thread = makeThread('Flow_Agent', flowIR, { status: 'waiting' });
    const session = makeSession({
      threads: [makeSession().threads[0], thread],
      llmClient: { agentName: 'stale-parent' } as any,
    });
    const wiring = makeWiring();

    await activateAgentExecutionContext({
      session,
      targetAgentName: 'Flow_Agent',
      targetIR: flowIR,
      targetThread: thread,
      authMode: 'handoff',
      wireLLMClient: false,
      llmWiring: wiring as any,
    });

    expect(session.llmClient).toBeUndefined();
    expect(thread.llmClient).toBeUndefined();
    expect(wiring.wireLLMClient).not.toHaveBeenCalled();
  });
});

describe('agentNeedsLLMWiring', () => {
  it('returns false for pure scripted flow agents', () => {
    const ir = makeAgentIR('Flow_Agent', {
      flow: {
        entry_point: 'start',
        steps: ['start'],
        definitions: {
          start: {
            type: 'respond',
            message: 'hello',
          },
        },
      },
    });

    expect(agentNeedsLLMWiring(ir)).toBe(false);
  });

  it('returns true when a flow contains a reasoning zone step', () => {
    const ir = makeAgentIR('Hybrid_Agent', {
      flow: {
        entry_point: 'start',
        steps: ['start'],
        definitions: {
          start: {
            type: 'call',
            tool: 'lookup',
            reasoning_zone: {
              enabled: true,
            },
          },
        },
      },
    });

    expect(agentNeedsLLMWiring(ir)).toBe(true);
  });
});
