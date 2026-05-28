/**
 * Event Processor — Interaction grouping and classification tests
 *
 * Tests the core logic that transforms flat ExtendedTraceEvent[]
 * into grouped Interaction[] with step classification.
 *
 * @vitest-environment happy-dom
 */

import { describe, it, expect, beforeEach } from 'vitest';
import type { ExtendedTraceEvent } from '../types';
import {
  processEventsToInteractions,
  type ProcessedInteractions,
} from '../components/observatory/interactions/event-processor';
import type { ToolCallStepItem } from '../components/observatory/interactions/types';

// =============================================================================
// HELPERS
// =============================================================================

let eventId = 0;
let baseTime: number;

beforeEach(() => {
  eventId = 0;
  baseTime = new Date('2026-03-31T10:00:00Z').getTime();
});

function makeEvent(
  type: string,
  offsetMs: number,
  overrides?: Partial<ExtendedTraceEvent>,
): ExtendedTraceEvent {
  eventId++;
  return {
    id: `evt-${eventId}`,
    type: type as ExtendedTraceEvent['type'],
    timestamp: new Date(baseTime + offsetMs),
    durationMs: overrides?.durationMs,
    traceId: 'trace-1',
    spanId: `span-${eventId}`,
    sessionId: 'sess-1',
    agentName: overrides?.agentName ?? 'test-agent',
    stepName: overrides?.stepName,
    data: overrides?.data ?? {},
    metadata: overrides?.metadata,
  };
}

// =============================================================================
// TESTS — INTERACTION GROUPING
// =============================================================================

describe('processEventsToInteractions', () => {
  describe('interaction grouping', () => {
    it('groups events into interactions split by user_message', () => {
      const events = [
        makeEvent('user_message', 0),
        makeEvent('llm_call', 100, { data: { model: 'gpt-4' } }),
        makeEvent('agent_response', 500),
        makeEvent('user_message', 1000),
        makeEvent('llm_call', 1100, { data: { model: 'gpt-4' } }),
        makeEvent('tool_call', 1300),
        makeEvent('agent_response', 1800),
      ];

      const result = processEventsToInteractions(events);

      expect(result.interactions).toHaveLength(2);
      expect(result.interactions[0].index).toBe(1);
      expect(result.interactions[1].index).toBe(2);
    });

    it('handles single interaction', () => {
      const events = [
        makeEvent('user_message', 0),
        makeEvent('llm_call', 100),
        makeEvent('agent_response', 500),
      ];

      const result = processEventsToInteractions(events);

      expect(result.interactions).toHaveLength(1);
      expect(result.interactions[0].index).toBe(1);
    });

    it('handles empty events array', () => {
      const result = processEventsToInteractions([]);

      expect(result.interactions).toHaveLength(0);
      expect(result.summary.interactionCount).toBe(0);
    });

    it('classifies thought and status runtime events as visible decision steps', () => {
      const events = [
        makeEvent('user_message', 0, { data: { content: 'Run the scripted flow' } }),
        makeEvent('step_thought', 10, {
          data: {
            stepName: 'collect_account',
            stepType: 'COLLECT',
            summary: 'Collecting account id',
          },
        }),
        makeEvent('tool_thought', 20, {
          data: {
            toolName: 'lookup_account',
            thought: 'Need account data before answering',
            reasoning: 'The user asked about account status',
          },
        }),
        makeEvent('status_update', 30, {
          data: {
            text: 'Checking account',
            operation: 'lookup_account',
            transient: true,
          },
        }),
        makeEvent('status_clear', 40, { data: {} }),
        makeEvent('agent_response', 100, { data: { content: 'Done' } }),
      ];

      const result = processEventsToInteractions(events);
      const decisionSteps = result.interactions[0].steps.filter((step) => step.type === 'decision');
      const decisionEventTypes = decisionSteps.flatMap((step) =>
        step.events.map((event) => event.type),
      );

      expect(decisionEventTypes).toEqual([
        'step_thought',
        'tool_thought',
        'status_update',
        'status_clear',
      ]);
      expect(decisionSteps[0].data.reason).toBe('Collecting account id');
    });

    it('carries active scripted flow step context onto nested LLM, tool, and decision steps', () => {
      const events = [
        makeEvent('user_message', 0, { data: { content: 'Apply for leave' } }),
        makeEvent('agent_enter', 5, {
          agentName: 'Leave_Application_Agent',
          data: { agentName: 'Leave_Application_Agent', mode: 'scripted' },
        }),
        makeEvent('flow_step_enter', 10, {
          agentName: 'Leave_Application_Agent',
          data: {
            agentName: 'Leave_Application_Agent',
            stepName: 'collect_leave_type',
            stepType: 'reasoning_zone',
            flowStepName: 'collect_leave_type',
            flowStepType: 'reasoning_zone',
            flowStepRunId: 'flow-step-1',
          },
        }),
        makeEvent('llm_call', 20, {
          agentName: 'Leave_Application_Agent',
          data: { model: 'gpt-4.1', tokensIn: 355, tokensOut: 104 },
        }),
        makeEvent('decision', 30, {
          agentName: 'Leave_Application_Agent',
          data: { decisionKind: 'guardrail_check', outcome: 'pass' },
        }),
        makeEvent('tool_call', 40, {
          agentName: 'Leave_Application_Agent',
          data: { toolName: 'get_leave_balance', success: true },
        }),
        makeEvent('flow_step_exit', 50, {
          agentName: 'Leave_Application_Agent',
          data: {
            agentName: 'Leave_Application_Agent',
            stepName: 'collect_leave_type',
            stepType: 'reasoning_zone',
            result: 'completed',
          },
        }),
      ];

      const result = processEventsToInteractions(events);
      const nestedSteps = result.interactions[0].steps.filter((step) =>
        ['llm_call', 'decision', 'tool_call'].includes(step.type),
      );

      expect(nestedSteps).toHaveLength(3);
      for (const step of nestedSteps) {
        expect(step.agentName).toBe('Leave_Application_Agent');
        expect(step.flowStepName).toBe('collect_leave_type');
        expect(step.flowStepType).toBe('reasoning_zone');
        expect(step.flowStepRunId).toBe('flow-step-1');
      }
    });

    it('does not merge adjacent same-agent tool calls across different flow steps', () => {
      const events = [
        makeEvent('user_message', 0, { data: { content: 'Run both steps' } }),
        makeEvent('flow_step_enter', 10, {
          agentName: 'Workflow_Agent',
          data: {
            agentName: 'Workflow_Agent',
            flowStepName: 'lookup_policy',
            flowStepType: 'call',
            flowStepRunId: 'flow-step-lookup',
          },
        }),
        makeEvent('tool_call', 20, {
          agentName: 'Workflow_Agent',
          data: { toolName: 'lookup_policy', success: true },
        }),
        makeEvent('flow_step_exit', 30, {
          agentName: 'Workflow_Agent',
          data: {
            agentName: 'Workflow_Agent',
            flowStepName: 'lookup_policy',
            flowStepRunId: 'flow-step-lookup',
          },
        }),
        makeEvent('flow_step_enter', 40, {
          agentName: 'Workflow_Agent',
          data: {
            agentName: 'Workflow_Agent',
            flowStepName: 'create_case',
            flowStepType: 'call',
            flowStepRunId: 'flow-step-create',
          },
        }),
        makeEvent('tool_call', 50, {
          agentName: 'Workflow_Agent',
          data: { toolName: 'create_case', success: true },
        }),
      ];

      const result = processEventsToInteractions(events);
      const toolSteps = result.interactions[0].steps.filter((step) => step.type === 'tool_call');

      expect(toolSteps).toHaveLength(2);
      expect(toolSteps[0].flowStepName).toBe('lookup_policy');
      expect(toolSteps[1].flowStepName).toBe('create_case');
      expect(toolSteps[0].data.toolCalls).toHaveLength(1);
      expect(toolSteps[1].data.toolCalls).toHaveLength(1);
    });

    it('clears active flow step context after a flow step exits', () => {
      const events = [
        makeEvent('user_message', 0, { data: { content: 'Run one step' } }),
        makeEvent('flow_step_enter', 10, {
          agentName: 'Workflow_Agent',
          data: {
            agentName: 'Workflow_Agent',
            flowStepName: 'lookup_policy',
            flowStepType: 'call',
            flowStepRunId: 'flow-step-lookup',
          },
        }),
        makeEvent('tool_call', 20, {
          agentName: 'Workflow_Agent',
          data: { toolName: 'lookup_policy', success: true },
        }),
        makeEvent('flow_step_exit', 30, {
          agentName: 'Workflow_Agent',
          data: {
            agentName: 'Workflow_Agent',
            flowStepName: 'lookup_policy',
            flowStepRunId: 'flow-step-lookup',
          },
        }),
        makeEvent('llm_call', 40, {
          agentName: 'Workflow_Agent',
          data: { model: 'gpt-4.1' },
        }),
      ];

      const result = processEventsToInteractions(events);
      const llmStep = result.interactions[0].steps.find((step) => step.type === 'llm_call');

      expect(llmStep?.flowStepName).toBeUndefined();
      expect(llmStep?.flowStepRunId).toBeUndefined();
    });

    it('assigns events before first user_message to interaction 1', () => {
      const events = [
        makeEvent('llm_call', 0, { data: { model: 'gpt-4' } }),
        makeEvent('agent_response', 200),
        makeEvent('user_message', 500),
        makeEvent('llm_call', 600),
      ];

      const result = processEventsToInteractions(events);

      expect(result.interactions.length).toBeGreaterThanOrEqual(1);
    });

    it('sorts events by timestamp before grouping', () => {
      const events = [
        makeEvent('agent_response', 500),
        makeEvent('user_message', 0),
        makeEvent('llm_call', 100),
      ];

      const result = processEventsToInteractions(events);

      expect(result.interactions).toHaveLength(1);
      expect(result.interactions[0].steps[0].type).toBe('user_input');
    });

    it('normalizes dotted user and llm event types before grouping and summary', () => {
      const events = [
        makeEvent('llm.call.completed', 100, {
          data: { usage: { inputTokens: 12, outputTokens: 8 } },
        }),
        makeEvent('message.user.received', 0, { data: { message: 'hello' } }),
        makeEvent('message.agent.sent', 200, { data: { message: 'done' } }),
      ];

      const result = processEventsToInteractions(events);

      expect(result.interactions).toHaveLength(1);
      expect(result.interactions[0].steps[0].type).toBe('user_input');
      expect(result.summary.llmCallCount).toBe(1);
    });

    it('does not show a between-interaction switch when a router enters before handing off', () => {
      const events = [
        makeEvent('agent_response', 0, {
          agentName: 'CignaRouter',
          data: { content: 'Thank you for calling Cigna.' },
        }),
        makeEvent('user_message', 1000, {
          agentName: 'CignaRouter',
          data: { content: 'I want to place order' },
        }),
        makeEvent('agent_enter', 1010, {
          agentName: 'CignaRouter',
          data: { agentName: 'CignaRouter', trigger: 'user_message' },
        }),
        makeEvent('agent.handoff', 1020, {
          agentName: 'CignaRouter',
          data: { from: 'CignaRouter', to: 'CAIAuth_Specialist' },
        }),
        makeEvent('agent_enter', 1030, {
          agentName: 'CAIAuth_Specialist',
          data: { agentName: 'CAIAuth_Specialist', trigger: 'handoff' },
        }),
        makeEvent('flow.step.entered', 1040, {
          agentName: 'CAIAuth_Specialist',
          data: { agentName: 'CAIAuth_Specialist', stepName: 'init' },
        }),
        makeEvent('flow.transition', 1050, {
          agentName: 'CAIAuth_Specialist',
          data: { agentName: 'CAIAuth_Specialist', from: 'init', to: 'ani_candidate_lookup' },
        }),
        makeEvent('agent_response', 1100, {
          agentName: 'CAIAuth_Specialist',
          data: { content: 'Let me verify your identity to get started.' },
        }),
      ];

      const result = processEventsToInteractions(events);

      expect(result.interactions).toHaveLength(2);
      expect(result.interactions[0].agentName).toBe('CignaRouter');
      expect(result.interactions[1].agentName).toBe('CAIAuth_Specialist');
      expect(result.interactions[1].entryAgentName).toBe('CignaRouter');
      expect(result.agentSwitches).toEqual([]);
    });

    it('deduplicates same lifecycle banner emitted twice by historical recursive sinks', () => {
      const events = [
        makeEvent('user_message', 0, {
          agentName: 'CignaRouter',
          data: { content: 'I want to place order' },
        }),
        makeEvent('agent_enter', 10, {
          agentName: 'CignaRouter',
          data: { agentName: 'CignaRouter', trigger: 'user_message' },
        }),
        makeEvent('agent_enter', 20, {
          agentName: 'CAIAuth_Specialist',
          data: { agentName: 'CAIAuth_Specialist', trigger: 'handoff' },
        }),
        makeEvent('agent_enter', 21, {
          agentName: 'CAIAuth_Specialist',
          data: { agentName: 'CAIAuth_Specialist', trigger: 'handoff' },
        }),
        makeEvent('agent_response', 100, {
          agentName: 'CAIAuth_Specialist',
          data: { content: 'Let me verify your identity to get started.' },
        }),
      ];

      const result = processEventsToInteractions(events);
      const childEnters = result.interactions[0].banners.filter(
        (banner) => banner.kind === 'agent_enter' && banner.agentName === 'CAIAuth_Specialist',
      );

      expect(childEnters).toHaveLength(1);
    });
  });

  // ===========================================================================
  // STEP CLASSIFICATION
  // ===========================================================================

  describe('step classification', () => {
    it('classifies user_message as user_input step', () => {
      const events = [
        makeEvent('user_message', 0, { data: { content: 'hello' } }),
        makeEvent('agent_response', 200),
      ];

      const result = processEventsToInteractions(events);
      const steps = result.interactions[0].steps;

      expect(steps.some((s) => s.type === 'user_input')).toBe(true);
    });

    it('classifies llm_call as llm_call step', () => {
      const events = [
        makeEvent('user_message', 0),
        makeEvent('llm_call', 100, {
          data: {
            model: 'gpt-4',
            usage: { inputTokens: 100, outputTokens: 50 },
          },
        }),
        makeEvent('agent_response', 500),
      ];

      const result = processEventsToInteractions(events);
      const steps = result.interactions[0].steps;

      expect(steps.some((s) => s.type === 'llm_call')).toBe(true);
    });

    it('classifies tool_call events as tool_call step', () => {
      const events = [
        makeEvent('user_message', 0),
        makeEvent('tool_call', 200, { data: { tool: 'get_balance' } }),
        makeEvent('tool_result', 400, { data: { result: '2450.00' } }),
        makeEvent('agent_response', 600),
      ];

      const result = processEventsToInteractions(events);
      const steps = result.interactions[0].steps;

      expect(steps.some((s) => s.type === 'tool_call')).toBe(true);
    });

    it('classifies realtime voice tool events as tool_call steps', () => {
      const events = [
        makeEvent('user_message', 0),
        makeEvent('voice.realtime.tool_call', 200, {
          data: {
            toolName: 'lookup_member',
            toolCallId: 'call-1',
            result: { status: 'active' },
            durationMs: 75,
          },
        }),
        makeEvent('agent_response', 500),
      ];

      const result = processEventsToInteractions(events);
      const toolStep = result.interactions[0].steps.find((step) => step.type === 'tool_call');
      const toolCalls = (toolStep?.data.toolCalls ?? []) as ToolCallStepItem[];

      expect(toolStep).toBeDefined();
      expect(toolCalls[0]?.tool).toBe('lookup_member');
      expect(result.summary.toolCallCount).toBe(1);
    });

    it('preserves parallel sibling tool calls inside one tool step', () => {
      const events = [
        makeEvent('user_message', 0),
        makeEvent('tool_call', 200, {
          spanId: 'span-tool-1',
          data: {
            tool: 'crm_lookup',
            input: { customerId: 'cust-123' },
            result: { name: 'Alice' },
            success: true,
            latencyMs: 94,
            url: 'https://internal.example.test/crm',
            method: 'GET',
          },
        }),
        makeEvent('tool_call', 240, {
          spanId: 'span-tool-2',
          data: {
            tool: 'balance_lookup',
            input: { accountId: 'acc-987' },
            result: { balance: 42 },
            success: true,
            latencyMs: 101,
            url: 'https://internal.example.test/balance',
            method: 'GET',
          },
        }),
        makeEvent('agent_response', 500),
      ];

      const result = processEventsToInteractions(events);
      const toolStep = result.interactions[0].steps.find((step) => step.type === 'tool_call');
      const toolCalls = (toolStep?.data.toolCalls ?? []) as ToolCallStepItem[];

      expect(toolStep).toBeDefined();
      expect(toolCalls).toHaveLength(2);
      expect(toolCalls.map((toolCall) => toolCall.tool)).toEqual(['crm_lookup', 'balance_lookup']);
      expect(toolCalls[0]?.result).toEqual({ name: 'Alice' });
      expect(toolCalls[1]?.result).toEqual({ balance: 42 });
    });

    it('merges tool_result payloads into the matching child tool call', () => {
      const events = [
        makeEvent('user_message', 0),
        makeEvent('tool_call', 200, {
          data: {
            tool: 'get_balance',
            input: { accountId: 'acc-123' },
            toolCallId: 'tc-1',
          },
        }),
        makeEvent('tool_result', 400, {
          data: {
            toolCallId: 'tc-1',
            result: '2450.00',
          },
        }),
        makeEvent('agent_response', 600),
      ];

      const result = processEventsToInteractions(events);
      const toolStep = result.interactions[0].steps.find((step) => step.type === 'tool_call');
      const toolCalls = (toolStep?.data.toolCalls ?? []) as ToolCallStepItem[];

      expect(toolStep).toBeDefined();
      expect(toolCalls).toHaveLength(1);
      expect(toolCalls[0]?.tool).toBe('get_balance');
      expect(toolCalls[0]?.result).toBe('2450.00');
      expect(toolCalls[0]?.eventIds).toHaveLength(2);
    });

    // ABLP-1094: Multiple same-name FLOW tool calls inside one step must fuse
    // each tool_call_start + completed tool_call + tool_result group by the
    // shared toolCallId. Without per-call ids the second result would orphan
    // and render as a separate card lower down (the Cigna staging report).
    it('fuses two same-name FLOW tool calls into separate sibling rows via toolCallId', () => {
      const events = [
        makeEvent('user_message', 0),
        makeEvent('tool_call_start', 100, {
          data: {
            toolCallId: 'tc-A',
            toolName: 'kb_search',
            tool: 'kb_search',
            input: { q: 'returns' },
            agent: 'support',
          },
        }),
        makeEvent('tool_call', 150, {
          data: {
            phase: 'complete',
            toolCallId: 'tc-A',
            toolName: 'kb_search',
            tool: 'kb_search',
            input: { q: 'returns' },
            output: { hits: ['policy-1'] },
            success: true,
            latencyMs: 50,
            agent: 'support',
          },
        }),
        makeEvent('tool_result', 151, {
          data: {
            toolCallId: 'tc-A',
            toolName: 'kb_search',
            tool: 'kb_search',
            result: { hits: ['policy-1'] },
          },
        }),
        makeEvent('tool_call_start', 200, {
          data: {
            toolCallId: 'tc-B',
            toolName: 'kb_search',
            tool: 'kb_search',
            input: { q: 'shipping' },
            agent: 'support',
          },
        }),
        makeEvent('tool_call', 250, {
          data: {
            phase: 'complete',
            toolCallId: 'tc-B',
            toolName: 'kb_search',
            tool: 'kb_search',
            input: { q: 'shipping' },
            output: { hits: ['policy-2'] },
            success: true,
            latencyMs: 50,
            agent: 'support',
          },
        }),
        makeEvent('tool_result', 251, {
          data: {
            toolCallId: 'tc-B',
            toolName: 'kb_search',
            tool: 'kb_search',
            result: { hits: ['policy-2'] },
          },
        }),
        makeEvent('agent_response', 400),
      ];

      const result = processEventsToInteractions(events);
      const toolStep = result.interactions[0].steps.find((step) => step.type === 'tool_call');
      const toolCalls = (toolStep?.data.toolCalls ?? []) as ToolCallStepItem[];

      expect(toolStep).toBeDefined();
      expect(toolCalls).toHaveLength(2);
      expect(toolCalls[0]?.tool).toBe('kb_search');
      expect(toolCalls[1]?.tool).toBe('kb_search');
      expect(toolCalls[0]?.input).toEqual({ q: 'returns' });
      expect(toolCalls[1]?.input).toEqual({ q: 'shipping' });
      expect(toolCalls[0]?.result).toEqual({ hits: ['policy-1'] });
      expect(toolCalls[1]?.result).toEqual({ hits: ['policy-2'] });
    });

    it('classifies guardrail events as guard steps', () => {
      const events = [
        makeEvent('user_message', 0),
        makeEvent('guardrail_check', 50, {
          data: { checkType: 'pii_scan', result: 'pass', confidence: 0.98 },
        }),
        makeEvent('llm_call', 100),
        makeEvent('agent_response', 500),
      ];

      const result = processEventsToInteractions(events);
      const steps = result.interactions[0].steps;

      expect(steps.some((s) => s.type === 'input_guard')).toBe(true);
    });

    it('classifies decision/handoff events as decision step', () => {
      const events = [
        makeEvent('user_message', 0),
        makeEvent('llm_call', 100),
        makeEvent('decision', 300, {
          data: { type: 'handoff', target: 'support-agent' },
        }),
      ];

      const result = processEventsToInteractions(events);
      const steps = result.interactions[0].steps;

      expect(steps.some((s) => s.type === 'decision')).toBe(true);
    });

    it('classifies delegated child input without splitting the parent interaction', () => {
      const events = [
        makeEvent('user_message', 0, {
          agentName: 'ContractTriage',
          data: { message: 'List expiring contracts' },
        }),
        makeEvent('delegate_start', 100, {
          agentName: 'ContractTriage',
          data: {
            sourceAgent: 'ContractTriage',
            targetAgent: 'DatabaseQueryAgent',
            fromAgent: 'ContractTriage',
            toAgent: 'DatabaseQueryAgent',
          },
        }),
        makeEvent('agent_enter', 120, {
          agentName: 'DatabaseQueryAgent',
          data: { agentName: 'DatabaseQueryAgent', trigger: 'delegate' },
        }),
        makeEvent('delegated_message', 130, {
          agentName: 'DatabaseQueryAgent',
          data: {
            message: 'Find contracts expiring this quarter',
            inputKind: 'delegated',
            sourceAgent: 'ContractTriage',
          },
        }),
        makeEvent('thread_return', 210, {
          agentName: 'ContractTriage',
          data: {
            fromAgent: 'DatabaseQueryAgent',
            toAgent: 'ContractTriage',
            targetAgent: 'ContractTriage',
            returnType: 'delegate',
          },
        }),
        makeEvent('agent_response', 300, {
          agentName: 'ContractTriage',
          data: { content: 'Done' },
        }),
      ];

      const result = processEventsToInteractions(events);
      const interaction = result.interactions[0];
      const delegatedInput = interaction.steps.find(
        (step) => step.type === 'user_input' && step.agentName === 'DatabaseQueryAgent',
      );

      expect(result.interactions).toHaveLength(1);
      expect(delegatedInput?.data).toMatchObject({
        content: 'Find contracts expiring this quarter',
        inputKind: 'delegated',
        sourceAgent: 'ContractTriage',
      });
      expect(interaction.banners.find((banner) => banner.kind === 'delegate_start')).toMatchObject({
        agentName: 'ContractTriage',
        targetAgent: 'DatabaseQueryAgent',
        parentAgent: 'ContractTriage',
      });
      expect(interaction.banners.find((banner) => banner.kind === 'thread_return')).toMatchObject({
        agentName: 'ContractTriage',
        targetAgent: 'ContractTriage',
        parentAgent: 'DatabaseQueryAgent',
      });
    });

    it('keeps lifecycle reason details for agent enter and exit banners', () => {
      const userMessage = makeEvent('user_message', 0, { data: { content: 'hi' } });
      const agentEnter = makeEvent('agent_enter', 20, {
        data: {
          agentName: 'AppointmentRouter',
          trigger: 'user_message',
          reasonCode: 'agent_enter_user_message',
          causal: {
            causeEventId: userMessage.id,
            agentRunId: 'run-1',
            phase: 'agent_lifecycle',
            reasonCode: 'agent_enter_user_message',
          },
        },
      });
      const agentResponse = makeEvent('agent_response', 500, {
        data: { content: 'How can I help?' },
      });
      const agentExit = makeEvent('agent_exit', 700, {
        data: {
          agentName: 'AppointmentRouter',
          result: 'completed',
          durationMs: 680,
          reasonCode: 'agent_exit_completed',
          causal: {
            causeEventId: agentResponse.id,
            agentRunId: 'run-1',
            phase: 'agent_lifecycle',
            reasonCode: 'agent_exit_completed',
          },
        },
      });

      const result = processEventsToInteractions([
        userMessage,
        agentEnter,
        agentResponse,
        agentExit,
      ]);
      const banners = result.interactions[0].banners;

      expect(banners).toHaveLength(2);
      expect(banners[0]).toMatchObject({
        kind: 'agent_enter',
        reason: 'Started after user input',
        trigger: 'user_message',
        reasonCode: 'agent_enter_user_message',
        causeEventId: userMessage.id,
        causeLabel: `user_message ${userMessage.id}`,
        agentRunId: 'run-1',
      });
      expect(banners[1]).toMatchObject({
        kind: 'agent_exit',
        reason: 'Exited after response completed',
        result: 'completed',
        reasonCode: 'agent_exit_completed',
        durationMs: 680,
        causeEventId: agentResponse.id,
      });
    });

    it('does not describe self-target agent exits as handoffs to the same agent', () => {
      const userMessage = makeEvent('user_message', 0, { data: { content: 'flight status' } });
      const agentResponse = makeEvent('agent_response', 650, {
        agentName: 'SkymateRouter',
        data: { content: 'Please provide your booking reference.' },
      });
      const agentExit = makeEvent('agent_exit', 700, {
        agentName: 'SkymateRouter',
        data: {
          agentName: 'SkymateRouter',
          targetAgent: 'SkymateRouter',
          result: 'handoff',
          reasonCode: 'agent_exit_handoff',
          causal: {
            causeEventId: agentResponse.id,
            agentRunId: 'run-router',
            phase: 'agent_lifecycle',
            reasonCode: 'agent_exit_handoff',
          },
        },
      });

      const result = processEventsToInteractions([userMessage, agentResponse, agentExit]);
      const exitBanner = result.interactions[0].banners.find(
        (banner) => banner.kind === 'agent_exit',
      );

      expect(exitBanner).toMatchObject({
        agentName: 'SkymateRouter',
        targetAgent: 'SkymateRouter',
        reason: 'Parent agent finished after handoff returned',
      });
    });

    it('summarizes thread returns as child-to-parent control flow', () => {
      const userMessage = makeEvent('user_message', 0, { data: { content: 'flight status' } });
      const threadReturn = makeEvent('thread_return', 700, {
        agentName: 'SkymateRouter',
        data: {
          from: 'FlightInfoSpecialist',
          to: 'SkymateRouter',
          causal: {
            causeEventId: userMessage.id,
            phase: 'runtime',
          },
        },
      });

      const result = processEventsToInteractions([userMessage, threadReturn]);
      const returnBanner = result.interactions[0].banners.find(
        (banner) => banner.kind === 'thread_return',
      );

      expect(returnBanner).toMatchObject({
        agentName: 'SkymateRouter',
        parentAgent: 'FlightInfoSpecialist',
        targetAgent: 'SkymateRouter',
        reason: 'FlightInfoSpecialist returned control to SkymateRouter',
      });
    });

    it('resolves lifecycle cause labels against the full session, not just the current interaction', () => {
      const firstUserMessage = makeEvent('user_message', 0, { data: { content: 'hi' } });
      const firstResponse = makeEvent('agent_response', 200, {
        data: { content: 'How can I help?' },
      });
      const secondUserMessage = makeEvent('user_message', 500, {
        data: { content: 'book appointment' },
      });
      const agentEnter = makeEvent('agent_enter', 520, {
        data: {
          agentName: 'BookingSpecialist',
          trigger: 'handoff',
          causal: {
            causeEventId: firstResponse.id,
            agentRunId: 'run-booking',
            phase: 'agent_lifecycle',
            reasonCode: 'agent_enter_handoff',
          },
        },
      });
      const finalResponse = makeEvent('agent_response', 700, {
        agentName: 'BookingSpecialist',
        data: { content: 'Please provide booking_reference' },
      });

      const result = processEventsToInteractions([
        firstUserMessage,
        firstResponse,
        secondUserMessage,
        agentEnter,
        finalResponse,
      ]);
      const secondInteractionBanner = result.interactions[1].banners.find(
        (banner) => banner.kind === 'agent_enter',
      );

      expect(secondInteractionBanner).toMatchObject({
        causeEventId: firstResponse.id,
        causeLabel: `agent_response ${firstResponse.id}`,
      });
    });

    it('keeps unresolved lifecycle cause ids out of user-facing labels', () => {
      const userMessage = makeEvent('user_message', 0, { data: { content: 'hi' } });
      const agentEnter = makeEvent('agent_enter', 20, {
        data: {
          agentName: 'AppointmentRouter',
          trigger: 'user_message',
          causal: {
            causeEventId: 'missing-cause-id',
            agentRunId: 'run-1',
            phase: 'agent_lifecycle',
            reasonCode: 'agent_enter_user_message',
          },
        },
      });
      const agentResponse = makeEvent('agent_response', 500, {
        data: { content: 'How can I help?' },
      });

      const result = processEventsToInteractions([userMessage, agentEnter, agentResponse]);
      const banner = result.interactions[0].banners.find(
        (interactionBanner) => interactionBanner.kind === 'agent_enter',
      );

      expect(banner).toMatchObject({
        causeEventId: 'missing-cause-id',
        reason: 'Started after user input',
      });
      expect(banner?.causeLabel).toBeUndefined();
    });

    it('classifies error events as error step', () => {
      const events = [
        makeEvent('user_message', 0),
        makeEvent('llm_call', 100),
        makeEvent('error', 200, { data: { message: 'timeout' } }),
      ];

      const result = processEventsToInteractions(events);
      const steps = result.interactions[0].steps;

      expect(steps.some((s) => s.type === 'error')).toBe(true);
    });

    it('merges scripted dsl_respond and final agent_response rows for the same delivered text', () => {
      const events = [
        makeEvent('user_message', 0, { data: { message: 'hi' } }),
        makeEvent('agent_enter', 20, { agentName: 'Onboarding_Welcome_Manager' }),
        makeEvent('step_thought', 100, {
          agentName: 'Onboarding_Welcome_Manager',
          data: { thought: 'Sending response' },
        }),
        makeEvent('dsl_respond', 150, {
          agentName: 'Onboarding_Welcome_Manager',
          data: {
            rendered:
              "Hello! Welcome to Boardwalk property management services. I'm here to assist you today.",
          },
        }),
        makeEvent('engine_decision', 200, {
          agentName: 'Onboarding_Welcome_Manager',
          data: { decision: 'forward_progressing_transition' },
        }),
        makeEvent('completion_check', 250, {
          agentName: 'Onboarding_Welcome_Manager',
          data: { result: false },
        }),
        makeEvent('agent_response', 300, {
          agentName: 'Onboarding_Welcome_Manager',
          data: {
            content:
              "Hello! Welcome to Boardwalk property management services. I'm here to assist you today.",
            isFinalForTurn: true,
          },
        }),
      ];

      const result = processEventsToInteractions(events);
      const responseSteps = result.interactions[0].steps.filter(
        (step) => step.type === 'agent_response',
      );

      expect(responseSteps).toHaveLength(1);
      expect(responseSteps[0].events.map((event) => event.type)).toEqual([
        'dsl_respond',
        'agent_response',
      ]);
      expect(responseSteps[0].data.mergedResponseEventCount).toBe(2);
    });
  });

  // ===========================================================================
  // INTERACTION STATUS
  // ===========================================================================

  describe('interaction status', () => {
    it('marks interaction as error when error events present', () => {
      const events = [
        makeEvent('user_message', 0),
        makeEvent('error', 100, { data: { message: 'fail' } }),
      ];

      const result = processEventsToInteractions(events);

      expect(result.interactions[0].status).toBe('error');
    });

    it('marks interaction as warning when warning events present', () => {
      const events = [
        makeEvent('user_message', 0),
        makeEvent('guardrail_warning', 100),
        makeEvent('agent_response', 200),
      ];

      const result = processEventsToInteractions(events);

      expect(result.interactions[0].status).toBe('warning');
    });

    it('marks interaction as ok when no error/warning events', () => {
      const events = [
        makeEvent('user_message', 0),
        makeEvent('llm_call', 100),
        makeEvent('agent_response', 500),
      ];

      const result = processEventsToInteractions(events);

      expect(result.interactions[0].status).toBe('ok');
    });
  });

  // ===========================================================================
  // SESSION SUMMARY
  // ===========================================================================

  describe('session summary', () => {
    it('counts interactions, agents, LLM calls, and tool calls', () => {
      const events = [
        makeEvent('user_message', 0),
        makeEvent('llm_call', 100, { data: { model: 'gpt-4' } }),
        makeEvent('tool_call', 200, { data: { tool: 'get_balance' } }),
        makeEvent('agent_response', 500),
        makeEvent('user_message', 1000, { agentName: 'support-agent' }),
        makeEvent('llm_call', 1100, {
          agentName: 'support-agent',
          data: { model: 'gpt-4' },
        }),
        makeEvent('agent_response', 1500, { agentName: 'support-agent' }),
      ];

      const result = processEventsToInteractions(events);

      expect(result.summary.interactionCount).toBe(2);
      expect(result.summary.llmCallCount).toBe(2);
      expect(result.summary.toolCallCount).toBe(1);
      expect(result.summary.agentCount).toBe(2);
    });

    it('does not count tool_call_start as a completed tool call', () => {
      const events = [
        makeEvent('user_message', 0),
        makeEvent('llm_call', 100),
        makeEvent('tool_call_start', 150, {
          data: { toolCallId: 'tc-1', toolName: 'get_balance' },
        }),
        makeEvent('tool_call', 300, {
          data: {
            phase: 'complete',
            toolCallId: 'tc-1',
            toolName: 'get_balance',
            success: true,
          },
        }),
        makeEvent('agent_response', 500),
      ];

      const result = processEventsToInteractions(events);
      const toolStep = result.interactions[0].steps.find((step) => step.type === 'tool_call');

      expect(result.summary.toolCallCount).toBe(1);
      expect(toolStep?.events.map((event) => event.type)).toEqual(['tool_call_start', 'tool_call']);
    });

    it('calculates total duration from first to last event', () => {
      const events = [makeEvent('user_message', 0), makeEvent('agent_response', 2400)];

      const result = processEventsToInteractions(events);

      expect(result.summary.totalDurationMs).toBe(2400);
    });
  });

  // ===========================================================================
  // AGENT PATH
  // ===========================================================================

  describe('agent path', () => {
    it('builds ordered list of unique agents', () => {
      const events = [
        makeEvent('user_message', 0, { agentName: 'billing-agent' }),
        makeEvent('llm_call', 100, { agentName: 'billing-agent' }),
        makeEvent('handoff', 500, { agentName: 'billing-agent' }),
        makeEvent('user_message', 1000, { agentName: 'support-agent' }),
        makeEvent('llm_call', 1100, { agentName: 'support-agent' }),
      ];

      const result = processEventsToInteractions(events);

      expect(result.agentPath).toHaveLength(2);
      expect(result.agentPath[0].agentName).toBe('billing-agent');
      expect(result.agentPath[1].agentName).toBe('support-agent');
    });
  });

  // ===========================================================================
  // AGENT SWITCHES
  // ===========================================================================

  describe('agent switches', () => {
    it('detects agent switch between interactions', () => {
      const events = [
        makeEvent('user_message', 0, { agentName: 'billing-agent' }),
        makeEvent('agent_response', 500, { agentName: 'billing-agent' }),
        makeEvent('user_message', 1000, { agentName: 'support-agent' }),
        makeEvent('agent_response', 1500, { agentName: 'support-agent' }),
      ];

      const result = processEventsToInteractions(events);

      expect(result.agentSwitches).toHaveLength(1);
      expect(result.agentSwitches[0].fromAgent).toBe('billing-agent');
      expect(result.agentSwitches[0].toAgent).toBe('support-agent');
      expect(result.agentSwitches[0].afterInteractionIndex).toBe(1);
    });

    it('returns empty when no agent change', () => {
      const events = [
        makeEvent('user_message', 0),
        makeEvent('agent_response', 500),
        makeEvent('user_message', 1000),
        makeEvent('agent_response', 1500),
      ];

      const result = processEventsToInteractions(events);

      expect(result.agentSwitches).toHaveLength(0);
    });
  });

  // ===========================================================================
  // AGENT MODE DETECTION
  // ===========================================================================

  describe('agent mode detection', () => {
    it('detects scripted mode from flow events', () => {
      const events = [
        makeEvent('user_message', 0),
        makeEvent('flow_step_enter', 50, { data: { step: 'greeting' } }),
        makeEvent('dsl_collect', 100),
        makeEvent('agent_response', 500),
      ];

      const result = processEventsToInteractions(events);

      expect(result.interactions[0].agentMode).toBe('scripted');
    });

    it('defaults to reasoning mode when no flow events', () => {
      const events = [
        makeEvent('user_message', 0),
        makeEvent('llm_call', 100),
        makeEvent('agent_response', 500),
      ];

      const result = processEventsToInteractions(events);

      expect(result.interactions[0].agentMode).toBe('reasoning');
    });
  });
});
