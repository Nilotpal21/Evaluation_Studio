import { describe, expect, it } from 'vitest';
import type { AgentIR } from '@abl/compiler/platform/ir/schema.js';
import type { ToolCall } from '../../services/llm/session-llm-client.js';
import type { RuntimeSession } from '../../services/execution/types.js';
import {
  bridgeSupervisorToolCallToDetectedIntent,
  SUPERVISOR_TOOL_CALL_INTENT_SUMMARY,
} from '../../services/pipeline/intent-bridge.js';
import {
  applyResolvedMultiIntentPlan,
  buildSupervisorRoutingToolFanOutPlan,
  resolveDetectedMultiIntentPlan,
} from '../../services/execution/multi-intent/multi-intent-router.js';
import type { DetectedMultiIntentResult } from '../../services/execution/multi-intent/multi-intent-types.js';

function buildSupervisorIr(): AgentIR {
  return {
    ir_version: '1.0',
    metadata: {
      name: 'LeaveRouteSupervisor',
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
      name: 'LeaveRouteSupervisor',
      goal: 'Route leave requests',
      persona: '',
    },
    tools: [],
    gather: { fields: [], mode: 'conversational', strategy: 'progressive' },
    memory: { enabled: false },
    constraints: { rules: [] },
    coordination: {
      handoffs: [
        { to: 'LeaveApplicationChild', condition: 'true', return: true },
        { to: 'LeaveBalanceChild', condition: 'true', return: true },
      ],
      delegates: [],
    },
    completion: { conditions: [] },
    error_handling: { handlers: [], default_action: 'respond' },
    intent_handling: {
      multi_intent: {
        enabled: true,
        strategy: 'disambiguate',
        max_intents: 3,
        confidence_threshold: 0.6,
        queue_max_age_ms: 600_000,
      },
    },
  } as AgentIR;
}

function buildRuntimeSession(agentIR: AgentIR): RuntimeSession {
  return {
    id: 'session-ablp-930-integration',
    tenantId: 'tenant-ablp-930',
    projectId: 'project-ablp-930',
    agentName: agentIR.metadata.name,
    agentIR,
    compilationOutput: null,
    conversationHistory: [],
    state: { gatherProgress: {}, conversationPhase: 'active', context: {} },
    data: { values: {}, gatheredKeys: new Set<string>() },
    isComplete: false,
    isEscalated: false,
    handoffStack: [agentIR.metadata.name],
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

describe('supervisor tool-call routing integration', () => {
  it('preserves the explicit supervisor tool target across intent bridge and router boundaries', () => {
    const agentIR = buildSupervisorIr();
    const session = buildRuntimeSession(agentIR);
    const userMessage = 'I want to apply for leave';
    const pollutedSupervisorMessage = 'Transfer user to agent LeaveBalanceChild';
    const detected = bridgeSupervisorToolCallToDetectedIntent({
      target: 'LeaveApplicationChild',
      message: pollutedSupervisorMessage,
      userMessage,
    });

    expect(detected).toMatchObject({
      intent: 'LeaveApplicationChild',
      target: { kind: 'agent', ref: 'LeaveApplicationChild', label: 'LeaveApplicationChild' },
      summary: SUPERVISOR_TOOL_CALL_INTENT_SUMMARY,
      source: 'tool_call',
      context: {
        supervisorRoutingMessage: pollutedSupervisorMessage,
      },
    });

    const multiIntent: DetectedMultiIntentResult = {
      primary: detected!,
      alternatives: [
        {
          intent: 'leave_balance',
          target: { kind: 'agent', ref: 'LeaveBalanceChild', label: 'LeaveBalanceChild' },
          category: 'leave_balance',
          summary: 'leave balance',
          confidence: 0.98,
          source: 'pipeline',
        },
      ],
      relationships: {
        type: 'ambiguous',
        reasoning: 'A polluted supervisor message mentions another leave route',
      },
    };
    const traceEvents: Array<{ type: string; data: Record<string, unknown> }> = [];

    const plan = resolveDetectedMultiIntentPlan({
      sessionId: session.id,
      agentName: session.agentName,
      agentIR,
      detected: multiIntent,
      userMessage,
      onTraceEvent: (event) => traceEvents.push(event),
    });
    const dispatch = applyResolvedMultiIntentPlan({
      session,
      plan,
      onTraceEvent: (event) => traceEvents.push(event),
    });

    expect(plan.strategy).toBe('parallel');
    expect(plan.source).toBe('tool_call');
    expect(plan.alternatives).toEqual([]);
    expect(dispatch.fanOutTasks).toEqual([
      {
        target: 'LeaveApplicationChild',
        intent: userMessage,
        context: {
          supervisorRoutingMessage: pollutedSupervisorMessage,
        },
      },
    ]);
    expect(session.waitingForInput).toBeUndefined();
    expect(session.intentQueue?.pending ?? []).toEqual([]);
    expect(traceEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'decision',
          data: expect.objectContaining({
            type: 'multi_intent_plan_built',
            source: 'tool_call',
            strategy: 'parallel',
            targetCount: 1,
          }),
        }),
      ]),
    );
  });

  it('rejects malformed routing tool calls instead of deriving a target from message text', () => {
    const invalidToolCalls: ToolCall[] = [
      {
        id: 'tool-1',
        name: '__handoff__',
        input: {
          target: '',
          message: 'Transfer user to agent LeaveBalanceChild',
        },
      },
      {
        id: 'tool-2',
        name: 'lookup_leave_policy',
        input: {
          message: 'Transfer user to agent LeaveApplicationChild',
        },
      },
    ];

    const plan = buildSupervisorRoutingToolFanOutPlan({
      sessionId: 'session-ablp-930-integration',
      agentName: 'LeaveRouteSupervisor',
      toolCalls: invalidToolCalls,
      userMessage: 'I want to apply for leave',
    });

    expect(plan).toBeNull();
  });

  it('keeps the supervisor tool-name target when malformed tool input points at a sibling', () => {
    const expectedSupervisorTarget = 'LeaveApplicationChild';
    const toolCalls: ToolCall[] = [
      {
        id: 'tool-1',
        name: `handoff_to_${expectedSupervisorTarget}`,
        input: {
          target: '',
          message: 'Transfer user to agent LeaveBalanceChild',
        },
      },
      {
        id: 'tool-2',
        name: `handoff_to_${expectedSupervisorTarget}`,
        input: {
          target: 'LeaveBalanceChild',
          message: 'Check LeaveBalanceChild after LeaveApplicationChild',
        },
      },
    ];

    const plan = buildSupervisorRoutingToolFanOutPlan({
      sessionId: 'session-ablp-930-integration',
      agentName: 'LeaveRouteSupervisor',
      toolCalls,
      userMessage: 'I want to apply for leave',
    });

    expect(plan).not.toBeNull();
    expect(plan?.source).toBe('tool_call');
    expect(plan?.fanOutTasks?.map((task) => task.target)).toEqual([
      expectedSupervisorTarget,
      expectedSupervisorTarget,
    ]);
    expect(plan?.fanOutTasks).toEqual([
      {
        target: expectedSupervisorTarget,
        intent: 'I want to apply for leave',
        context: {
          supervisorRoutingMessage: 'Transfer user to agent LeaveBalanceChild',
        },
      },
      {
        target: expectedSupervisorTarget,
        intent: 'I want to apply for leave',
        context: {
          supervisorRoutingMessage: 'Check LeaveBalanceChild after LeaveApplicationChild',
        },
      },
    ]);
  });
});
