import { describe, expect, it } from 'vitest';
import type { AgentIR } from '@abl/compiler/platform/ir/schema.js';
import type { ToolCall } from '../../services/llm/session-llm-client.js';
import type { RuntimeSession } from '../../services/execution/types.js';
import type { DetectedMultiIntentResult } from '../../services/execution/multi-intent/multi-intent-types.js';
import {
  applyResolvedMultiIntentPlan,
  buildSupervisorRoutingToolFanOutPlan,
  resolveDetectedMultiIntentPlan,
} from '../../services/execution/multi-intent/multi-intent-router.js';

function buildAgentIR(overrides: Partial<AgentIR> = {}): AgentIR {
  return {
    ir_version: '1.0',
    metadata: {
      name: 'test_agent',
      version: '1.0.0',
      type: 'supervisor',
      compiled_at: new Date().toISOString(),
      source_hash: 'test-hash',
      compiler_version: '1.0.0',
    },
    execution: {
      mode: 'reasoning',
      max_turns: 10,
      max_tool_iterations: 5,
    },
    identity: {
      name: 'Test Agent',
      goal: 'Help users',
      persona: '',
    },
    tools: [],
    gather: { fields: [], mode: 'conversational', strategy: 'progressive' },
    memory: { enabled: false },
    constraints: { rules: [] },
    coordination: { handoffs: [], delegates: [] },
    completion: { conditions: [] },
    error_handling: { handlers: [], default_action: 'respond' },
    ...overrides,
  } as AgentIR;
}

function buildSession(agentIR: AgentIR): RuntimeSession {
  return {
    id: 'session-router-test',
    tenantId: 'tenant-router-test',
    projectId: 'project-router-test',
    agentName: agentIR.metadata.name,
    agentIR,
    compilationOutput: null,
    conversationHistory: [],
    state: { gatherProgress: {}, conversationPhase: 'active', context: {} },
    data: { values: {}, gatheredKeys: new Set<string>() },
    isComplete: false,
    isEscalated: false,
    handoffStack: [],
    initialized: true,
    threads: [
      {
        agentName: agentIR.metadata.name,
        agentIR: null,
        status: 'active',
        conversationHistory: [],
        data: { values: {}, gatheredKeys: new Set<string>() },
        state: {},
      },
    ],
    activeThreadIndex: 0,
    threadStack: [],
    createdAt: new Date(),
    lastActivityAt: new Date(),
    storeVersion: 0,
  } as unknown as RuntimeSession;
}

function buildDetectedMultiIntent(
  overrides: Partial<DetectedMultiIntentResult> = {},
): DetectedMultiIntentResult {
  return {
    primary: {
      intent: 'check my bill',
      target: { kind: 'agent', ref: 'Billing_Agent', label: 'Billing_Agent' },
      category: 'billing',
      summary: 'check my bill',
      confidence: 0.92,
      source: 'pipeline',
    },
    alternatives: [
      {
        intent: 'track my shipment',
        target: { kind: 'agent', ref: 'Shipping_Agent', label: 'Shipping_Agent' },
        category: 'shipping',
        summary: 'track my shipment',
        confidence: 0.81,
        source: 'pipeline',
      },
    ],
    relationships: {
      type: 'independent',
      reasoning: 'Different specialists handle billing and shipping',
    },
    ...overrides,
  };
}

describe('multi-intent-router', () => {
  it('builds parallel plans with executable agent targets', () => {
    const agentIR = buildAgentIR({
      intent_handling: {
        multi_intent: {
          enabled: true,
          strategy: 'parallel',
          max_intents: 3,
          confidence_threshold: 0.6,
          queue_max_age_ms: 600_000,
        },
      },
    });
    const detected = buildDetectedMultiIntent();

    const plan = resolveDetectedMultiIntentPlan({
      sessionId: 'session-router-test',
      agentName: 'Supervisor_Agent',
      agentIR,
      detected,
      userMessage: 'Check my bill and track my shipment.',
    });

    expect(plan.strategy).toBe('parallel');
    expect(plan.fanOutTasks).toEqual([
      { target: 'Billing_Agent', intent: 'check my bill' },
      { target: 'Shipping_Agent', intent: 'track my shipment' },
    ]);
  });

  it('downgrades flow-step targets out of parallel plans', () => {
    const agentIR = buildAgentIR({
      intent_handling: {
        multi_intent: {
          enabled: true,
          strategy: 'parallel',
          max_intents: 3,
          confidence_threshold: 0.6,
          queue_max_age_ms: 600_000,
        },
      },
    });
    const detected = buildDetectedMultiIntent({
      alternatives: [
        {
          intent: 'check status',
          target: { kind: 'flow_step', ref: 'check_status', label: 'check status' },
          category: null,
          summary: 'check status',
          confidence: 0.8,
          source: 'flow',
        },
      ],
    });

    const plan = resolveDetectedMultiIntentPlan({
      sessionId: 'session-router-test',
      agentName: 'Supervisor_Agent',
      agentIR,
      detected,
      userMessage: 'Check my bill and check status.',
    });

    expect(plan.strategy).toBe('sequential');
    expect(plan.fanOutTasks).toBeUndefined();
    expect(plan.queueEntries?.[0]).toMatchObject({
      intent: 'check_status',
      label: 'check status',
      target: { kind: 'flow_step', ref: 'check_status', label: 'check status' },
    });
  });

  it('stores target-aware queue entries and structured disambiguation choices', () => {
    const agentIR = buildAgentIR({
      intent_handling: {
        multi_intent: {
          enabled: true,
          strategy: 'disambiguate',
          max_intents: 3,
          confidence_threshold: 0.6,
          queue_max_age_ms: 600_000,
        },
      },
    });
    const detected = buildDetectedMultiIntent({
      relationships: {
        type: 'ambiguous',
        reasoning: 'User needs to choose which request to handle first',
      },
    });
    const session = buildSession(agentIR);

    const plan = resolveDetectedMultiIntentPlan({
      sessionId: session.id,
      agentName: session.agentName,
      agentIR,
      detected,
      userMessage: 'Check my bill and track my shipment.',
    });
    const dispatch = applyResolvedMultiIntentPlan({ session, plan });

    expect(dispatch.strategy).toBe('disambiguate');
    expect(session.waitingForInput).toEqual(['_disambiguation_choice']);
    expect(session.intentQueue?.pending[0]).toMatchObject({
      intent: 'Billing_Agent',
      label: 'check my bill',
      target: { kind: 'agent', ref: 'Billing_Agent', label: 'Billing_Agent' },
    });
    expect(session.data.values._disambiguation_intents).toEqual([
      'check my bill',
      'track my shipment',
    ]);
    expect(session.data.values._disambiguation_choices).toEqual([
      {
        label: 'check my bill',
        intent: 'Billing_Agent',
        target: { kind: 'agent', ref: 'Billing_Agent', label: 'Billing_Agent' },
        category: 'billing',
        summary: 'check my bill',
        confidence: 0.92,
        source: 'pipeline',
      },
      {
        label: 'track my shipment',
        intent: 'Shipping_Agent',
        target: { kind: 'agent', ref: 'Shipping_Agent', label: 'Shipping_Agent' },
        category: 'shipping',
        summary: 'track my shipment',
        confidence: 0.81,
        source: 'pipeline',
      },
    ]);
  });

  it('uses the localized message resolver for disambiguation copy', () => {
    const agentIR = buildAgentIR({
      intent_handling: {
        multi_intent: {
          enabled: true,
          strategy: 'disambiguate',
          max_intents: 3,
          confidence_threshold: 0.6,
          queue_max_age_ms: 600_000,
        },
      },
    });
    const detected = buildDetectedMultiIntent({
      relationships: {
        type: 'ambiguous',
        reasoning: 'User needs to choose which request to handle first',
      },
    });

    const plan = resolveDetectedMultiIntentPlan({
      sessionId: 'session-router-test',
      agentName: 'Supervisor_Agent',
      agentIR,
      detected,
      userMessage: 'Check my bill and track my shipment.',
      resolveMessage: (messageKey, fallbackMessage) => {
        if (messageKey === 'multi_intent_disambiguate_header') {
          return 'Selecciona una opcion:';
        }
        if (messageKey === 'multi_intent_disambiguate_option') {
          return '{{index}}. {{intent}} ({{confidence}}%)';
        }
        return fallbackMessage ?? '';
      },
    });

    expect(plan.strategy).toBe('disambiguate');
    expect(plan.disambiguationMessage).toContain('Selecciona una opcion:');
    expect(plan.disambiguationMessage).toContain('1. check my bill (92%)');
    expect(plan.disambiguationMessage).toContain('2. track my shipment (81%)');
  });

  it('routes source=tool_call intents directly without scanning polluted summaries', () => {
    const agentIR = buildAgentIR({
      intent_handling: {
        multi_intent: {
          enabled: true,
          strategy: 'disambiguate',
          max_intents: 3,
          confidence_threshold: 0.6,
          queue_max_age_ms: 600_000,
        },
      },
    });
    const detected = buildDetectedMultiIntent({
      primary: {
        intent: 'LeaveApplication',
        target: { kind: 'agent', ref: 'LeaveApplication', label: 'LeaveApplication' },
        category: null,
        summary: 'Transfer user to agent LeaveBalance',
        confidence: 1,
        source: 'tool_call',
      },
      alternatives: [
        {
          intent: 'leave_balance',
          target: { kind: 'agent', ref: 'LeaveBalance', label: 'LeaveBalance' },
          category: 'leave_balance',
          summary: 'leave balance',
          confidence: 0.97,
          source: 'pipeline',
        },
      ],
    });

    const plan = resolveDetectedMultiIntentPlan({
      sessionId: 'session-router-test',
      agentName: 'Supervisor_Agent',
      agentIR,
      detected,
      userMessage: 'I want to apply for leave.',
    });

    expect(plan.strategy).toBe('parallel');
    expect(plan.alternatives).toEqual([]);
    expect(plan.queueEntries).toBeUndefined();
    expect(plan.disambiguationChoices).toBeUndefined();
    expect(plan.fanOutTasks).toEqual([
      {
        target: 'LeaveApplication',
        intent: 'I want to apply for leave.',
      },
    ]);
  });

  it('batches supervisor routing tool calls into a parallel fan-out plan', () => {
    const toolCalls: ToolCall[] = [
      {
        id: 'tool-1',
        name: 'handoff_to_Billing_Agent',
        input: {
          message: 'Check my bill',
        },
      },
      {
        id: 'tool-2',
        name: 'handoff_to_Shipping_Agent',
        input: {
          message: 'Track my shipment',
          context: { orderId: 'ord_123' },
        },
      },
    ];

    const plan = buildSupervisorRoutingToolFanOutPlan({
      sessionId: 'session-router-test',
      agentName: 'Supervisor_Agent',
      toolCalls,
      userMessage: 'Check my bill and track my shipment.',
    });

    expect(plan).not.toBeNull();
    expect(plan?.strategy).toBe('parallel');
    expect(plan?.fanOutTasks).toEqual([
      {
        target: 'Billing_Agent',
        intent: 'Check my bill and track my shipment.',
        context: { supervisorRoutingMessage: 'Check my bill' },
      },
      {
        target: 'Shipping_Agent',
        intent: 'Check my bill and track my shipment.',
        context: { orderId: 'ord_123', supervisorRoutingMessage: 'Track my shipment' },
      },
    ]);
    expect(plan?.primary).toMatchObject({
      intent: 'Billing_Agent',
      summary: 'supervisor_tool_call',
      source: 'tool_call',
    });
    expect(plan?.alternatives[0]).toMatchObject({
      intent: 'Shipping_Agent',
      summary: 'supervisor_tool_call',
      source: 'tool_call',
    });
  });

  it('does not copy supervisor routing utterances into source=tool_call intent text', () => {
    const toolCalls: ToolCall[] = [
      {
        id: 'tool-1',
        name: 'handoff_to_Billing_Agent',
        input: {
          message: 'Transfer user to agent Shipping_Agent',
        },
      },
      {
        id: 'tool-2',
        name: 'handoff_to_Support_Agent',
        input: {
          message: 'Transfer user to agent Billing_Agent',
        },
      },
    ];

    const plan = buildSupervisorRoutingToolFanOutPlan({
      sessionId: 'session-router-test',
      agentName: 'Supervisor_Agent',
      toolCalls,
      userMessage: 'I need help with account access.',
    });

    expect(plan).not.toBeNull();
    expect(plan?.primary.summary).toBe('supervisor_tool_call');
    expect(plan?.primary.intent).toBe('Billing_Agent');
    expect(plan?.alternatives[0].summary).toBe('supervisor_tool_call');
    expect(plan?.alternatives[0].intent).toBe('Support_Agent');
    expect(plan?.fanOutTasks).toEqual([
      {
        target: 'Billing_Agent',
        intent: 'I need help with account access.',
        context: { supervisorRoutingMessage: 'Transfer user to agent Shipping_Agent' },
      },
      {
        target: 'Support_Agent',
        intent: 'I need help with account access.',
        context: { supervisorRoutingMessage: 'Transfer user to agent Billing_Agent' },
      },
    ]);
  });
});
