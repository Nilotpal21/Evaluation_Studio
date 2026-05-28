// apps/studio/src/__tests__/buildAgentTree.test.ts
import { describe, it, expect } from 'vitest';
import { buildAgentTree } from '../lib/buildAgentTree';
import type { TraceEvent, SessionMessage } from '../types';

function makeEvent(overrides: Partial<TraceEvent> & { type: string }): TraceEvent {
  return {
    id: `evt-${Math.random().toString(36).slice(2, 8)}`,
    sessionId: 'sess-1',
    timestamp: new Date('2026-03-11T10:00:00Z'),
    data: {},
    ...overrides,
  } as TraceEvent;
}

function makeMsg(role: 'user' | 'assistant', content: string, ts: string): SessionMessage {
  return {
    id: `msg-${Math.random().toString(36).slice(2, 8)}`,
    role,
    content,
    timestamp: new Date(ts),
    traceIds: [],
  };
}

describe('buildAgentTree', () => {
  it('creates agent nodes as top-level entries', () => {
    const events = [
      makeEvent({
        type: 'agent_enter',
        agentName: 'Travel_Agent',
        data: { agentName: 'Travel_Agent' },
        timestamp: new Date('2026-03-11T10:00:01Z'),
      }),
      makeEvent({
        type: 'llm_call',
        agentName: 'Travel_Agent',
        data: { agentName: 'Travel_Agent', model: 'gpt-4o', tokensIn: 100, tokensOut: 50 },
        timestamp: new Date('2026-03-11T10:00:02Z'),
      }),
      makeEvent({
        type: 'agent_exit',
        agentName: 'Travel_Agent',
        data: { agentName: 'Travel_Agent' },
        timestamp: new Date('2026-03-11T10:00:03Z'),
      }),
    ];
    const tree = buildAgentTree([], events);

    expect(tree.length).toBe(1);
    expect(tree[0].type).toBe('agent');
    expect(tree[0].label).toBe('Travel_Agent');
    expect(tree[0].children.length).toBe(1); // llm_call
    expect(tree[0].children[0].label).toBe('LLM → gpt-4o');
  });

  it('inserts user messages as separators between agents', () => {
    const messages = [makeMsg('user', 'Book a flight', '2026-03-11T10:00:00Z')];
    const events = [
      makeEvent({
        type: 'agent_enter',
        data: { agentName: 'Agent_A' },
        timestamp: new Date('2026-03-11T10:00:01Z'),
      }),
      makeEvent({
        type: 'agent_exit',
        data: { agentName: 'Agent_A' },
        timestamp: new Date('2026-03-11T10:00:02Z'),
      }),
    ];
    const tree = buildAgentTree(messages, events);

    // Should have user separator before agent
    const types = tree.map((n) => n.type);
    expect(types).toContain('user_input');
    expect(types).toContain('agent');
  });

  it('orders each chat turn as user input, execution flow, then agent response', () => {
    const messages = [
      makeMsg('user', 'What is my flight status?', '2026-03-11T10:00:10Z'),
      makeMsg(
        'assistant',
        'I can check that. Please provide your booking reference.',
        '2026-03-11T10:00:20Z',
      ),
    ];
    const events = [
      makeEvent({
        type: 'agent_enter',
        agentName: 'SkyMateRouter',
        data: { agentName: 'SkyMateRouter' },
        timestamp: new Date('2026-03-11T10:00:09Z'),
      }),
      makeEvent({
        type: 'decision',
        agentName: 'SkyMateRouter',
        data: { agentName: 'SkyMateRouter', toAgent: 'FlightInfoSpecialist' },
        timestamp: new Date('2026-03-11T10:00:11Z'),
      }),
      makeEvent({
        type: 'agent_exit',
        agentName: 'SkyMateRouter',
        data: { agentName: 'SkyMateRouter' },
        timestamp: new Date('2026-03-11T10:00:12Z'),
      }),
    ];

    const tree = buildAgentTree(messages, events);

    expect(tree.map((node) => node.type)).toEqual(['user_input', 'agent', 'agent_response']);
    expect(tree[0].data?.content).toBe('What is my flight status?');
    expect(tree[1].label).toBe('SkyMateRouter');
    expect(tree[1].children[0].type).toBe('decision');
    expect(tree[2].data?.content).toBe('I can check that. Please provide your booking reference.');
  });

  it('deduplicates repeated assistant messages in the session tree', () => {
    const messages = [
      makeMsg(
        'assistant',
        'Thank you for calling Cigna; how can I help you today?',
        '2026-03-11T10:00:00Z',
      ),
      makeMsg(
        'assistant',
        'Thank you for calling Cigna; how can I help you today?',
        '2026-03-11T10:00:00.250Z',
      ),
      makeMsg('user', 'I want to place order', '2026-03-11T10:00:01Z'),
    ];

    const tree = buildAgentTree(messages, []);

    const assistantNodes = tree.filter((node) => node.type === 'agent_response');
    expect(assistantNodes).toHaveLength(1);
    expect(assistantNodes[0].data?.content).toBe(
      'Thank you for calling Cigna; how can I help you today?',
    );
  });

  it('merges near-simultaneous assistant fragments in the session tree', () => {
    const messages = [
      makeMsg('user', 'I want to place order', '2026-03-11T10:00:00Z'),
      makeMsg('assistant', 'Let me verify your identity to get started.', '2026-03-11T10:00:01Z'),
      makeMsg(
        'assistant',
        "I can't continue because this step's requirements were not met. Please try again.",
        '2026-03-11T10:00:01.500Z',
      ),
    ];

    const tree = buildAgentTree(messages, []);

    const assistantNodes = tree.filter((node) => node.type === 'agent_response');
    expect(assistantNodes).toHaveLength(1);
    expect(assistantNodes[0].data?.content).toBe(
      "Let me verify your identity to get started. I can't continue because this step's requirements were not met. Please try again.",
    );
    expect(assistantNodes[0].data?.mergedMessageCount).toBe(2);
  });

  it('does not merge near-simultaneous assistant messages from different agents', () => {
    const routerMessage = makeMsg('assistant', 'Routing you now.', '2026-03-11T10:00:01Z');
    routerMessage.metadata = { agentName: 'CignaRouter' };
    const specialistMessage = makeMsg(
      'assistant',
      'Let me verify your identity to get started.',
      '2026-03-11T10:00:01.250Z',
    );
    specialistMessage.metadata = { agentName: 'CAIAuth_Specialist' };

    const tree = buildAgentTree([routerMessage, specialistMessage], []);

    expect(tree.filter((node) => node.type === 'agent_response')).toHaveLength(2);
  });

  it('collapses consecutive constraint_check events', () => {
    const events = [
      makeEvent({
        type: 'agent_enter',
        agentName: 'Agent_A',
        data: { agentName: 'Agent_A' },
        timestamp: new Date('2026-03-11T10:00:01Z'),
      }),
      makeEvent({
        type: 'constraint_check',
        agentName: 'Agent_A',
        data: { agentName: 'Agent_A', constraint: 'c1', passed: true },
        timestamp: new Date('2026-03-11T10:00:02Z'),
      }),
      makeEvent({
        type: 'constraint_check',
        agentName: 'Agent_A',
        data: { agentName: 'Agent_A', constraint: 'c2', passed: true },
        timestamp: new Date('2026-03-11T10:00:03Z'),
      }),
      makeEvent({
        type: 'constraint_check',
        agentName: 'Agent_A',
        data: { agentName: 'Agent_A', constraint: 'c3', passed: false },
        timestamp: new Date('2026-03-11T10:00:04Z'),
      }),
      makeEvent({
        type: 'agent_exit',
        agentName: 'Agent_A',
        data: { agentName: 'Agent_A' },
        timestamp: new Date('2026-03-11T10:00:05Z'),
      }),
    ];
    const tree = buildAgentTree([], events);

    const agentChildren = tree[0].children;
    expect(agentChildren.length).toBe(1); // collapsed group
    expect(agentChildren[0].type).toBe('constraint_check');
    expect(agentChildren[0].label).toMatch(/constraints \(3\)/);
    expect(agentChildren[0].label).toContain('✗'); // one failed
    expect(agentChildren[0].children.length).toBe(3); // expandable
  });

  it('replaces raw IDs with fallback labels', () => {
    const events = [
      makeEvent({
        type: 'agent_enter',
        data: { agentName: 'f160636b4e1e3bcee2f2bfb2:29e4086b8fc5dd0' },
        timestamp: new Date('2026-03-11T10:00:01Z'),
      }),
      makeEvent({
        type: 'agent_exit',
        data: { agentName: 'f160636b4e1e3bcee2f2bfb2:29e4086b8fc5dd0' },
        timestamp: new Date('2026-03-11T10:00:02Z'),
      }),
    ];
    const tree = buildAgentTree([], events, 'Fallback_Agent');

    expect(tree[0].label).toBe('Fallback_Agent');
  });

  it('labels LLM calls with "LLM → model" not bare model name', () => {
    const events = [
      makeEvent({
        type: 'agent_enter',
        agentName: 'A',
        data: { agentName: 'A' },
        timestamp: new Date('2026-03-11T10:00:01Z'),
      }),
      makeEvent({
        type: 'llm_call',
        agentName: 'A',
        data: { agentName: 'A', model: 'gpt-4o' },
        timestamp: new Date('2026-03-11T10:00:02Z'),
      }),
      makeEvent({
        type: 'agent_exit',
        agentName: 'A',
        data: { agentName: 'A' },
        timestamp: new Date('2026-03-11T10:00:03Z'),
      }),
    ];
    const tree = buildAgentTree([], events);
    expect(tree[0].children[0].label).toBe('LLM → gpt-4o');
  });

  it('propagates span ids onto agent and child event nodes', () => {
    const events = [
      makeEvent({
        id: 'agent-enter',
        type: 'agent_enter',
        agentName: 'A',
        spanId: 'agent-span',
        data: { agentName: 'A' },
        timestamp: new Date('2026-03-11T10:00:01Z'),
      }),
      makeEvent({
        id: 'llm-call',
        type: 'llm_call',
        agentName: 'A',
        spanId: 'llm-span',
        data: { agentName: 'A', model: 'gpt-4o' },
        timestamp: new Date('2026-03-11T10:00:02Z'),
      }),
      makeEvent({
        id: 'agent-exit',
        type: 'agent_exit',
        agentName: 'A',
        spanId: 'agent-span',
        data: { agentName: 'A' },
        timestamp: new Date('2026-03-11T10:00:03Z'),
      }),
    ];

    const tree = buildAgentTree([], events);

    expect(tree[0].spanId).toBe('agent-span');
    expect(tree[0].children[0].spanId).toBe('llm-span');
  });

  it('attaches snake_case agent and tool payloads to the correct child span', () => {
    const events = [
      makeEvent({
        id: 'agent-enter',
        type: 'agent_enter',
        spanId: 'agent-span',
        data: { agent_name: 'Supervisor_Agent' },
        timestamp: new Date('2026-03-11T10:00:01Z'),
      }),
      makeEvent({
        id: 'tool-call',
        type: 'tool_call',
        spanId: 'tool-span',
        data: { agent_name: 'Supervisor_Agent', tool_name: 'knowledge_base_lookup' },
        timestamp: new Date('2026-03-11T10:00:02Z'),
      }),
      makeEvent({
        id: 'agent-exit',
        type: 'agent_exit',
        spanId: 'agent-span',
        data: { agent_name: 'Supervisor_Agent' },
        timestamp: new Date('2026-03-11T10:00:03Z'),
      }),
    ];

    const tree = buildAgentTree([], events);

    expect(tree).toHaveLength(1);
    expect(tree[0].label).toBe('Supervisor_Agent');
    expect(tree[0].children).toHaveLength(1);
    expect(tree[0].children[0].label).toBe('tool: knowledge_base_lookup');
    expect(tree[0].children[0].detail).toBe('knowledge_base_lookup');
  });

  it('handles handoff between agents', () => {
    const events = [
      makeEvent({
        type: 'agent_enter',
        agentName: 'Supervisor',
        data: { agentName: 'Supervisor' },
        timestamp: new Date('2026-03-11T10:00:01Z'),
      }),
      {
        ...makeEvent({
          type: 'tool_call',
          data: { toolName: '__handoff__', input: { target: 'Worker' } },
          timestamp: new Date('2026-03-11T10:00:02Z'),
        }),
        agentName: 'Supervisor',
      },
      makeEvent({
        type: 'tool_call',
        agentName: 'Supervisor',
        data: { agentName: 'Supervisor', toolName: '__handoff__', input: { target: 'Worker' } },
        timestamp: new Date('2026-03-11T10:00:02Z'),
      }),
      makeEvent({
        type: 'agent_exit',
        agentName: 'Supervisor',
        data: { agentName: 'Supervisor' },
        timestamp: new Date('2026-03-11T10:00:03Z'),
      }),
      makeEvent({
        type: 'agent_enter',
        agentName: 'Worker',
        data: { agentName: 'Worker' },
        timestamp: new Date('2026-03-11T10:00:04Z'),
      }),
      makeEvent({
        type: 'agent_exit',
        agentName: 'Worker',
        data: { agentName: 'Worker' },
        timestamp: new Date('2026-03-11T10:00:05Z'),
      }),
    ];
    const tree = buildAgentTree([], events);
    expect(tree.length).toBe(2);
    expect(tree[0].label).toBe('Supervisor');
    expect(tree[1].label).toBe('Worker');
  });

  it('attaches pre-agent attachment events to the next agent span', () => {
    const events = [
      makeEvent({
        id: 'attachment-download',
        type: 'attachment_process',
        data: { stage: 'download', filename: 'receipt.png' },
        timestamp: new Date('2026-03-11T10:00:00.950Z'),
      }),
      makeEvent({
        id: 'user-message',
        type: 'user_message',
        agentName: 'SlackTestAgent',
        data: { agentName: 'SlackTestAgent', message: 'what is this' },
        timestamp: new Date('2026-03-11T10:00:01.000Z'),
      }),
      makeEvent({
        id: 'agent-enter',
        type: 'agent_enter',
        agentName: 'SlackTestAgent',
        spanId: 'agent-span',
        data: { agentName: 'SlackTestAgent' },
        timestamp: new Date('2026-03-11T10:00:01.010Z'),
      }),
      makeEvent({
        id: 'agent-exit',
        type: 'agent_exit',
        agentName: 'SlackTestAgent',
        spanId: 'agent-span',
        data: { agentName: 'SlackTestAgent' },
        timestamp: new Date('2026-03-11T10:00:02.000Z'),
      }),
    ];

    const tree = buildAgentTree([], events);

    expect(tree).toHaveLength(1);
    expect(tree[0].label).toBe('SlackTestAgent');
    expect(tree[0].children[0].type).toBe('attachment_process');
    expect(tree[0].children[0].label).toBe('Attachment Fetch: receipt.png');
  });

  it('builds a voice execution tree for S2S sessions without agent enter/exit spans', () => {
    const events = [
      makeEvent({
        id: 'voice-session-start',
        type: 'voice_session_start',
        sessionId: 'voice-session-1',
        agentName: 'LastMinute_Supervisor',
        data: { callSid: 'CA123' },
        timestamp: new Date('2026-03-25T11:00:00Z'),
      }),
      makeEvent({
        id: 'voice-stt-1',
        type: 'voice_stt',
        sessionId: 'voice-session-1',
        agentName: 'LastMinute_Supervisor',
        durationMs: 320,
        data: { turn: 1, provider: 'openai' },
        timestamp: new Date('2026-03-25T11:00:05Z'),
      }),
      makeEvent({
        id: 'voice-tts-1',
        type: 'voice_tts',
        sessionId: 'voice-session-1',
        agentName: 'LastMinute_Supervisor',
        durationMs: 210,
        data: { turn: 1, provider: 'openai' },
        timestamp: new Date('2026-03-25T11:00:06Z'),
      }),
      makeEvent({
        id: 'voice-tool-1',
        type: 'voice_realtime_tool_call',
        sessionId: 'voice-session-1',
        agentName: 'LastMinute_Supervisor',
        durationMs: 95,
        data: { turn: 1, toolName: 'search_flights', provider: 's2s:openai' },
        timestamp: new Date('2026-03-25T11:00:06.500Z'),
      }),
      makeEvent({
        id: 'voice-turn-1',
        type: 'voice_turn',
        sessionId: 'voice-session-1',
        agentName: 'LastMinute_Supervisor',
        durationMs: 1300,
        data: { turn: 1, userInput: 'book paris', assistantResponse: 'sure' },
        timestamp: new Date('2026-03-25T11:00:07Z'),
      }),
      makeEvent({
        id: 'voice-session-end',
        type: 'voice_session_end',
        sessionId: 'voice-session-1',
        agentName: 'LastMinute_Supervisor',
        data: {},
        timestamp: new Date('2026-03-25T11:01:00Z'),
      }),
    ];

    const tree = buildAgentTree([], events);

    expect(tree).toHaveLength(1);
    expect(tree[0].type).toBe('voice_session_start');
    expect(tree[0].label).toBe('Voice Session');

    const turnNode = tree[0].children.find((node) => node.type === 'voice_turn');
    expect(turnNode).toBeDefined();
    expect(turnNode?.label).toBe('Turn 1');
    expect(turnNode?.spanId).toBe('voice-turn:voice-session-1:1');
    expect(turnNode?.children.map((child) => child.type)).toEqual([
      'voice_stt',
      'voice_tts',
      'voice_realtime_tool_call',
    ]);
    expect(turnNode?.children[2]?.label).toBe('Tool Call: search_flights');

    const sessionEndNode = tree[0].children.find((node) => node.type === 'voice_session_end');
    expect(sessionEndNode).toBeDefined();
  });

  it('renders realtime voice orphan traces between persisted user and assistant messages', () => {
    const messages = [
      makeMsg('user', 'What is my flight status?', '2026-03-25T11:00:05Z'),
      makeMsg('assistant', 'Please provide your booking reference.', '2026-03-25T11:00:10Z'),
    ];
    const events = [
      makeEvent({
        id: 'voice-stt-1',
        type: 'voice_stt',
        sessionId: 'voice-session-1',
        agentName: 'SkymateRouter',
        data: { turn: 1, provider: 'openai', transcript: 'What is my flight status?' },
        timestamp: new Date('2026-03-25T11:00:05.100Z'),
      }),
      makeEvent({
        id: 'realtime-llm-1',
        type: 'llm_call',
        sessionId: 'voice-session-1',
        agentName: 'SkymateRouter',
        durationMs: 2500,
        data: {
          agentName: 'SkymateRouter',
          model: 'gpt-realtime-1.5',
          modality: 'realtime_voice',
          usage: { inputTokens: 120, outputTokens: 45 },
        },
        timestamp: new Date('2026-03-25T11:00:06Z'),
      }),
      makeEvent({
        id: 'voice-tts-1',
        type: 'voice_tts',
        sessionId: 'voice-session-1',
        agentName: 'SkymateRouter',
        data: { turn: 1, provider: 'openai' },
        timestamp: new Date('2026-03-25T11:00:09Z'),
      }),
    ];

    const tree = buildAgentTree(messages, events, 'SkymateRouter');

    expect(tree.map((node) => node.type)).toEqual(['user_input', 'agent', 'agent_response']);
    expect(tree[1].label).toBe('SkymateRouter');
    expect(tree[1].data?.reason).toBe('orphan_trace_events');
    expect(tree[1].children.map((child) => child.type)).toEqual([
      'voice_stt',
      'llm_call',
      'voice_tts',
    ]);
    expect(tree[1].children[1].label).toBe('LLM → gpt-realtime-1.5');
  });
});
