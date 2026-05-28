import { beforeEach, describe, expect, test, vi } from 'vitest';
import type { ToolExecutor } from '@abl/compiler';
import { RuntimeExecutor, compileToResolvedAgent } from '../../services/runtime-executor.js';

const REALTIME_TOOL_AGENT = `
AGENT: RealtimeToolAgent

GOAL: "Test realtime tool dispatch"

PERSONA: "Helpful assistant"

TOOLS:
  lookup_weather(city: string) -> { forecast: string }
    description: "Look up the forecast for a city"
`;

const REALTIME_PARENT_AGENT = `
AGENT: SupervisorAgent

GOAL: "Coordinate specialist agents"

PERSONA: "Supervisor assistant"
`;

const REALTIME_PARENT_TOOL_AGENT = `
AGENT: SupervisorAgent

GOAL: "Coordinate specialist agents"

PERSONA: "Supervisor assistant"

TOOLS:
  list_appointments(account_number: string) -> { status: string }
    description: "List customer appointments"
`;

const REALTIME_HANDOFF_SUPERVISOR = `
SUPERVISOR: VoiceSupervisor

GOAL: "Route realtime voice users to the right specialist"

PERSONA: "Voice routing assistant"

HANDOFF:
  - TO: Sales_Agent
    WHEN: intent.category == "sales"
    RETURN: false
`;

const REALTIME_HANDOFF_CHILD = `
AGENT: Sales_Agent

GOAL: "Help users with sales questions"

PERSONA: "Sales specialist"
`;

describe('RuntimeExecutor.executeRealtimeToolCall', () => {
  let executor: RuntimeExecutor;

  beforeEach(() => {
    executor = new RuntimeExecutor();
  });

  test('strips observability-only fields before invoking realtime regular tools', async () => {
    const session = executor.createSessionFromResolved(
      compileToResolvedAgent([REALTIME_TOOL_AGENT], 'RealtimeToolAgent'),
    );
    const execute = vi.fn().mockResolvedValue({ forecast: 'sunny' });
    const toolExecutor: ToolExecutor = {
      execute,
      executeParallel: vi.fn(),
    };
    session.toolExecutor = toolExecutor;

    const result = await executor.executeRealtimeToolCall(session.id, 'lookup_weather', {
      city: 'Dubai',
      thought: 'I should fetch the weather first.',
      reason: 'Need the forecast before replying.',
    });

    expect(execute).toHaveBeenCalledWith(
      'lookup_weather',
      expect.objectContaining({ city: 'Dubai' }),
      30000,
    );
    const [, toolParams] = execute.mock.calls[0] as [string, Record<string, unknown>, number];
    expect(toolParams.reason).toBeUndefined();
    expect(toolParams.thought).toBeUndefined();
    expect(result).toMatchObject({
      result: { forecast: 'sunny' },
      activeAgentName: 'RealtimeToolAgent',
    });
  });

  test('dispatches realtime __escalate__ through routing instead of the tool executor', async () => {
    const session = executor.createSessionFromResolved(
      compileToResolvedAgent([REALTIME_TOOL_AGENT], 'RealtimeToolAgent'),
    );
    const execute = vi.fn();
    const toolExecutor: ToolExecutor = {
      execute,
      executeParallel: vi.fn(),
    };
    session.toolExecutor = toolExecutor;

    const handleEscalate = vi.fn().mockResolvedValue({
      success: true,
      message: 'A human agent is joining.',
    });
    (
      executor as unknown as {
        routing: { handleEscalate: typeof handleEscalate };
      }
    ).routing.handleEscalate = handleEscalate;

    const result = await executor.executeRealtimeToolCall(session.id, '__escalate__', {
      reason: 'Need a human handoff',
      priority: 'high',
      thought: 'Escalate now.',
    });

    expect(handleEscalate).toHaveBeenCalledWith(
      session,
      {
        reason: 'Need a human handoff',
        priority: 'high',
      },
      undefined,
    );
    expect(execute).not.toHaveBeenCalled();
    expect(result.result).toEqual({
      success: true,
      message: 'A human agent is joining.',
    });
  });

  test('dispatches realtime __return_to_parent__ through parent restoration instead of blocking it', async () => {
    const supervisorResolved = compileToResolvedAgent([REALTIME_PARENT_AGENT], 'SupervisorAgent');
    const childResolved = compileToResolvedAgent([REALTIME_TOOL_AGENT], 'RealtimeToolAgent');
    const session = executor.createSessionFromResolved(supervisorResolved);
    const childSession = executor.createSessionFromResolved(childResolved);

    session.threads[0].status = 'waiting';
    session.threads.push(childSession.threads[0]);
    session.activeThreadIndex = 1;
    session.threadStack = [0];
    session.handoffStack = ['SupervisorAgent'];
    session.agentName = 'RealtimeToolAgent';
    session.agentIR = childSession.agentIR;
    session.threads[1].status = 'active';
    session.threads[1].returnExpected = true;
    session.threads[1].handoffFrom = 'SupervisorAgent';

    const executeToolCall = vi.fn().mockImplementation((runtimeSession: typeof session) => {
      const activeThread = runtimeSession.threads[runtimeSession.activeThreadIndex];
      activeThread.status = 'waiting';
      activeThread.data.values._forwarded_message = 'resume with supervisor';

      return Promise.resolve({
        toolResult: {
          success: true,
          forwardedMessage: 'resume with supervisor',
        },
        action: {
          type: 'return_to_parent',
          forwardedMessage: 'resume with supervisor',
        },
      });
    });
    (
      executor as unknown as {
        reasoning: { executeToolCall: typeof executeToolCall };
      }
    ).reasoning.executeToolCall = executeToolCall;

    const result = await executor.executeRealtimeToolCall(session.id, '__return_to_parent__', {
      message: 'resume with supervisor',
    });

    expect(executeToolCall).toHaveBeenCalled();
    expect(result).toMatchObject({
      result: {
        success: true,
        forwardedMessage: 'resume with supervisor',
      },
      activeAgentName: 'SupervisorAgent',
    });
    expect(session.activeThreadIndex).toBe(0);
    expect(session.threadStack).toEqual([]);
    expect(session.handoffStack).toEqual([]);
  });

  test('runs ON_RETURN resume_intent after realtime __return_to_parent__ restores the parent', async () => {
    const supervisorResolved = compileToResolvedAgent([REALTIME_PARENT_AGENT], 'SupervisorAgent');
    const childResolved = compileToResolvedAgent([REALTIME_TOOL_AGENT], 'RealtimeToolAgent');
    const session = executor.createSessionFromResolved(supervisorResolved);
    const childSession = executor.createSessionFromResolved(childResolved);

    session.threads[0].agentIR = {
      ...session.threads[0].agentIR!,
      coordination: {
        handoffs: [
          {
            to: 'RealtimeToolAgent',
            on_return: { action: 'resume_intent' },
          },
        ],
      },
    };
    session.threads[0].status = 'waiting';
    session.threads.push(childSession.threads[0]);
    session.activeThreadIndex = 1;
    session.threadStack = [0];
    session.handoffStack = ['RealtimeToolAgent'];
    session.agentName = 'RealtimeToolAgent';
    session.agentIR = childSession.agentIR;
    session.threads[1].status = 'active';
    session.threads[1].returnExpected = true;
    session.threads[1].handoffFrom = 'SupervisorAgent';

    const executeToolCall = vi.fn().mockImplementation((runtimeSession: typeof session) => {
      const activeThread = runtimeSession.threads[runtimeSession.activeThreadIndex];
      activeThread.status = 'waiting';
      activeThread.data.values._forwarded_message = 'summarize email with subject Profile QA';

      return Promise.resolve({
        toolResult: {
          success: true,
          forwardedMessage: 'summarize email with subject Profile QA',
        },
        action: {
          type: 'return_to_parent',
          forwardedMessage: 'summarize email with subject Profile QA',
        },
      });
    });
    (
      executor as unknown as {
        reasoning: { executeToolCall: typeof executeToolCall };
      }
    ).reasoning.executeToolCall = executeToolCall;
    const executeMessage = vi.spyOn(executor, 'executeMessage').mockResolvedValue({
      response: 'Profile QA email summary',
      action: { type: 'continue' },
    });

    const result = await executor.executeRealtimeToolCall(session.id, '__return_to_parent__', {
      message: 'summarize email with subject Profile QA',
    });

    expect(executeToolCall).toHaveBeenCalled();
    expect(executeMessage).toHaveBeenCalledWith(
      session.id,
      'summarize email with subject Profile QA',
      undefined,
      undefined,
      { resumeIntentReplay: true, messageSource: 'resume', sourceAgent: 'RealtimeToolAgent' },
    );
    expect(result).toMatchObject({
      result: 'Profile QA email summary',
      activeAgentName: 'SupervisorAgent',
    });
    expect(session.activeThreadIndex).toBe(0);
    expect(session.threadStack).toEqual([]);
    expect(session.handoffStack).toEqual([]);
  });

  test('runs ON_RETURN resume_intent after realtime child completion restores the parent', async () => {
    const supervisorResolved = compileToResolvedAgent([REALTIME_PARENT_AGENT], 'SupervisorAgent');
    const childResolved = compileToResolvedAgent([REALTIME_TOOL_AGENT], 'RealtimeToolAgent');
    const session = executor.createSessionFromResolved(supervisorResolved);
    const childSession = executor.createSessionFromResolved(childResolved);

    session.threads[0].agentIR = {
      ...session.threads[0].agentIR!,
      coordination: {
        handoffs: [
          {
            to: 'RealtimeToolAgent',
            on_return: { action: 'resume_intent' },
          },
        ],
      },
    };
    session.threads[0].conversationHistory.push({
      role: 'user',
      content: 'give me weather report of Hyderabad',
    });
    session.threads[0].status = 'waiting';
    session.threads.push(childSession.threads[0]);
    session.activeThreadIndex = 1;
    session.threadStack = [0];
    session.handoffStack = ['RealtimeToolAgent'];
    session.agentName = 'RealtimeToolAgent';
    session.agentIR = childSession.agentIR;
    session.threads[1].status = 'active';
    session.threads[1].returnExpected = true;
    session.threads[1].handoffFrom = 'SupervisorAgent';

    const executeMessage = vi.spyOn(executor, 'executeMessage').mockResolvedValue({
      response: 'Supervisor is ready for the next request',
      action: { type: 'continue' },
    });

    const result = await executor.executeRealtimeToolCall(session.id, '__complete__', {
      message: 'Weather report for Hyderabad',
    });

    expect(executeMessage).toHaveBeenCalledWith(
      session.id,
      'give me weather report of Hyderabad',
      undefined,
      undefined,
      { resumeIntentReplay: true, messageSource: 'resume', sourceAgent: 'RealtimeToolAgent' },
    );
    expect(result).toMatchObject({
      result: 'Weather report for Hyderabad\nSupervisor is ready for the next request',
      activeAgentName: 'SupervisorAgent',
    });
    expect(session.activeThreadIndex).toBe(0);
    expect(session.threadStack).toEqual([]);
    expect(session.handoffStack).toEqual([]);
  });

  test('initializes Google realtime sessions before executing the first tool call', async () => {
    const session = executor.createSessionFromResolved(
      compileToResolvedAgent([REALTIME_TOOL_AGENT], 'RealtimeToolAgent'),
    );
    session.initialized = false;
    session.data.values.session = { s2sProvider: 's2s:google' };

    const initializeSession = vi
      .spyOn(executor, 'initializeSession')
      .mockImplementation(async (sessionId) => {
        expect(sessionId).toBe(session.id);
        session.initialized = true;
        return {
          response: '',
          action: { type: 'continue' as const },
        };
      });

    const executeToolCall = vi.fn().mockResolvedValue({
      toolResult: { forecast: 'sunny' },
      action: undefined,
    });
    (
      executor as unknown as {
        reasoning: { executeToolCall: typeof executeToolCall };
      }
    ).reasoning.executeToolCall = executeToolCall;

    const result = await executor.executeRealtimeToolCall(session.id, 'lookup_weather', {
      city: 'Dubai',
    });

    expect(initializeSession).toHaveBeenCalledWith(session.id, expect.any(Function), undefined);
    expect(executeToolCall).toHaveBeenCalled();
    expect(result).toMatchObject({
      result: { forecast: 'sunny' },
      activeAgentName: 'RealtimeToolAgent',
    });
  });

  test('does not auto-initialize non-Google realtime sessions before tool execution', async () => {
    const session = executor.createSessionFromResolved(
      compileToResolvedAgent([REALTIME_TOOL_AGENT], 'RealtimeToolAgent'),
    );
    session.initialized = false;
    session.data.values.session = { s2sProvider: 's2s:openai' };

    const initializeSession = vi.spyOn(executor, 'initializeSession');
    const executeToolCall = vi.fn().mockResolvedValue({
      toolResult: { forecast: 'sunny' },
      action: undefined,
    });
    (
      executor as unknown as {
        reasoning: { executeToolCall: typeof executeToolCall };
      }
    ).reasoning.executeToolCall = executeToolCall;

    const result = await executor.executeRealtimeToolCall(session.id, 'lookup_weather', {
      city: 'Dubai',
    });

    expect(initializeSession).not.toHaveBeenCalled();
    expect(executeToolCall).toHaveBeenCalled();
    expect(result).toMatchObject({
      result: { forecast: 'sunny' },
      activeAgentName: 'RealtimeToolAgent',
    });
  });

  test('keeps OpenAI realtime handoff tool calls on the live voice transport', async () => {
    const session = executor.createSessionFromResolved(
      compileToResolvedAgent(
        [REALTIME_HANDOFF_SUPERVISOR, REALTIME_HANDOFF_CHILD],
        'VoiceSupervisor',
      ),
      { channelType: 'voice' },
    );
    session.data.values.session = {
      ...(session.data.values.session as Record<string, unknown>),
      channel: 'voice',
      s2sProvider: 's2s:openai',
    };
    session.threads[0].conversationHistory.push({
      role: 'user',
      content: 'I need help with sales',
    });

    const executeMessage = vi.spyOn(executor, 'executeMessage').mockResolvedValue({
      response: 'child model should not run',
      action: { type: 'continue' },
    });

    const result = await executor.executeRealtimeToolCall(session.id, 'handoff_to_Sales_Agent', {
      message: 'I need help with sales',
    });

    expect(executeMessage).not.toHaveBeenCalled();
    expect(result.activeAgentName).toBe('Sales_Agent');
    expect(result.result).toMatchObject({ success: true });
    expect((result.result as Record<string, unknown>).response).toBeUndefined();
    expect(session.agentName).toBe('Sales_Agent');
    expect(session.activeThreadIndex).toBe(1);
    expect(session.threads[0].status).toBe('completed');
    expect(session.threads[1].status).toBe('active');
  });

  test('executes stale Google realtime tool calls via the declaring ancestor thread and restores child context', async () => {
    const supervisorResolved = compileToResolvedAgent(
      [REALTIME_PARENT_TOOL_AGENT, REALTIME_TOOL_AGENT],
      'SupervisorAgent',
    );
    const childResolved = compileToResolvedAgent(
      [REALTIME_PARENT_TOOL_AGENT, REALTIME_TOOL_AGENT],
      'RealtimeToolAgent',
    );

    const session = executor.createSessionFromResolved(supervisorResolved);
    const childSession = executor.createSessionFromResolved(childResolved);
    session.initialized = true;

    session.threads[0].status = 'waiting';
    session.threads[0].data.values.session = { s2sProvider: 's2s:google' };
    childSession.threads[0].status = 'active';
    childSession.threads[0].data.values.session = { s2sProvider: 's2s:google' };
    session.threads.push(childSession.threads[0]);
    session.activeThreadIndex = 1;
    session.threadStack = [0];
    session.handoffStack = ['SupervisorAgent'];
    session.agentName = 'RealtimeToolAgent';
    session.agentIR = childSession.agentIR;
    session.data = childSession.threads[0].data;
    session.state = childSession.threads[0].state;
    session.conversationHistory = childSession.threads[0].conversationHistory;

    const wireToolExecutor = vi
      .spyOn(
        (executor as unknown as { llmWiring: { wireToolExecutor: (...args: unknown[]) => void } })
          .llmWiring,
        'wireToolExecutor',
      )
      .mockImplementation(() => {});

    const executeToolCall = vi
      .fn()
      .mockImplementation((runtimeSession: typeof session, toolCall) => {
        expect(runtimeSession.activeThreadIndex).toBe(0);
        expect(runtimeSession.agentName).toBe('SupervisorAgent');
        expect(toolCall.name).toBe('list_appointments');

        return Promise.resolve({
          toolResult: { status: 'ok' },
          action: undefined,
        });
      });
    (
      executor as unknown as {
        reasoning: { executeToolCall: typeof executeToolCall };
      }
    ).reasoning.executeToolCall = executeToolCall;

    const result = await executor.executeRealtimeToolCall(session.id, 'list_appointments', {
      account_number: '8141400430178306',
    });

    expect(executeToolCall).toHaveBeenCalledTimes(1);
    expect(wireToolExecutor).toHaveBeenCalledTimes(2);
    expect(session.activeThreadIndex).toBe(1);
    expect(session.agentName).toBe('RealtimeToolAgent');
    expect(result).toMatchObject({
      result: { status: 'ok' },
      activeAgentName: 'RealtimeToolAgent',
    });
  });

  test('executes stale Google realtime tool calls via parentThreadIndex after permanent handoff', async () => {
    const supervisorResolved = compileToResolvedAgent(
      [REALTIME_PARENT_TOOL_AGENT, REALTIME_TOOL_AGENT],
      'SupervisorAgent',
    );
    const childResolved = compileToResolvedAgent(
      [REALTIME_PARENT_TOOL_AGENT, REALTIME_TOOL_AGENT],
      'RealtimeToolAgent',
    );

    const session = executor.createSessionFromResolved(supervisorResolved);
    const childSession = executor.createSessionFromResolved(childResolved);
    session.initialized = true;

    session.threads[0].status = 'completed';
    session.threads[0].data.values.session = { s2sProvider: 's2s:google' };
    childSession.threads[0].status = 'active';
    childSession.threads[0].parentThreadIndex = 0;
    childSession.threads[0].data.values.session = { s2sProvider: 's2s:google' };
    session.threads.push(childSession.threads[0]);
    session.activeThreadIndex = 1;
    session.threadStack = [];
    session.handoffStack = ['SupervisorAgent'];
    session.agentName = 'RealtimeToolAgent';
    session.agentIR = childSession.agentIR;
    session.data = childSession.threads[0].data;
    session.state = childSession.threads[0].state;
    session.conversationHistory = childSession.threads[0].conversationHistory;

    const wireToolExecutor = vi
      .spyOn(
        (executor as unknown as { llmWiring: { wireToolExecutor: (...args: unknown[]) => void } })
          .llmWiring,
        'wireToolExecutor',
      )
      .mockImplementation(() => {});

    const executeToolCall = vi
      .fn()
      .mockImplementation((runtimeSession: typeof session, toolCall) => {
        expect(runtimeSession.activeThreadIndex).toBe(0);
        expect(runtimeSession.agentName).toBe('SupervisorAgent');
        expect(toolCall.name).toBe('list_appointments');

        return Promise.resolve({
          toolResult: { status: 'ok' },
          action: undefined,
        });
      });
    (
      executor as unknown as {
        reasoning: { executeToolCall: typeof executeToolCall };
      }
    ).reasoning.executeToolCall = executeToolCall;

    const result = await executor.executeRealtimeToolCall(session.id, 'list_appointments', {
      account_number: '8141400430178306',
    });

    expect(executeToolCall).toHaveBeenCalledTimes(1);
    expect(wireToolExecutor).toHaveBeenCalledTimes(2);
    expect(session.activeThreadIndex).toBe(1);
    expect(session.agentName).toBe('RealtimeToolAgent');
    expect(result).toMatchObject({
      result: { status: 'ok' },
      activeAgentName: 'RealtimeToolAgent',
    });
  });

  test('does not reroute stale Google realtime tools through unrelated sibling threads', async () => {
    const supervisorResolved = compileToResolvedAgent([REALTIME_PARENT_AGENT], 'SupervisorAgent');
    const siblingResolved = compileToResolvedAgent([REALTIME_PARENT_TOOL_AGENT], 'SupervisorAgent');
    const childResolved = compileToResolvedAgent([REALTIME_TOOL_AGENT], 'RealtimeToolAgent');

    const session = executor.createSessionFromResolved(supervisorResolved);
    const siblingSession = executor.createSessionFromResolved(siblingResolved);
    const childSession = executor.createSessionFromResolved(childResolved);
    session.initialized = true;

    session.threads[0].status = 'waiting';
    session.threads[0].data.values.session = { s2sProvider: 's2s:google' };
    siblingSession.threads[0].status = 'waiting';
    siblingSession.threads[0].data.values.session = { s2sProvider: 's2s:google' };
    childSession.threads[0].status = 'active';
    childSession.threads[0].data.values.session = { s2sProvider: 's2s:google' };
    session.threads.push(siblingSession.threads[0], childSession.threads[0]);
    session.activeThreadIndex = 2;
    session.threadStack = [0];
    session.agentName = 'RealtimeToolAgent';
    session.agentIR = childSession.agentIR;
    session.data = childSession.threads[0].data;
    session.state = childSession.threads[0].state;
    session.conversationHistory = childSession.threads[0].conversationHistory;

    const wireToolExecutor = vi
      .spyOn(
        (executor as unknown as { llmWiring: { wireToolExecutor: (...args: unknown[]) => void } })
          .llmWiring,
        'wireToolExecutor',
      )
      .mockImplementation(() => {});

    const executeToolCall = vi
      .fn()
      .mockImplementation((runtimeSession: typeof session, toolCall) => {
        expect(runtimeSession.activeThreadIndex).toBe(2);
        expect(runtimeSession.agentName).toBe('RealtimeToolAgent');
        expect(toolCall.name).toBe('list_appointments');

        return Promise.resolve({
          toolResult: { status: 'active-thread' },
          action: undefined,
        });
      });
    (
      executor as unknown as {
        reasoning: { executeToolCall: typeof executeToolCall };
      }
    ).reasoning.executeToolCall = executeToolCall;

    const result = await executor.executeRealtimeToolCall(session.id, 'list_appointments', {
      account_number: '8141400430178306',
    });

    expect(executeToolCall).toHaveBeenCalledTimes(1);
    expect(wireToolExecutor).not.toHaveBeenCalled();
    expect(session.activeThreadIndex).toBe(2);
    expect(session.agentName).toBe('RealtimeToolAgent');
    expect(result).toMatchObject({
      result: { status: 'active-thread' },
      activeAgentName: 'RealtimeToolAgent',
    });
  });
});
