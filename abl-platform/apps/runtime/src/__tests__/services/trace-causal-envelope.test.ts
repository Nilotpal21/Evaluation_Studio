import { describe, expect, it } from 'vitest';
import {
  attachRuntimeTraceCausalData,
  createRuntimeTraceCausalTracker,
  deriveRuntimeTracePhase,
} from '../../services/trace/causal-envelope.js';

const CAUSAL_TRACKER_TEST_OVERFLOW_AGENT_COUNT = 128;
const CAUSAL_TRACKER_TEST_PREFILL_AGENT_COUNT = CAUSAL_TRACKER_TEST_OVERFLOW_AGENT_COUNT - 1;

describe('runtime trace causal envelope', () => {
  it('links agent lifecycle events with a stable agentRunId and causeEventId chain', () => {
    const tracker = createRuntimeTraceCausalTracker();

    const enter = tracker.enrich({
      id: 'evt-enter',
      sessionId: 'session-1',
      type: 'agent_enter',
      agentName: 'Booking Agent',
      data: { agentName: 'Booking Agent' },
    });
    const decision = tracker.enrich({
      id: 'evt-decision',
      sessionId: 'session-1',
      type: 'completion_check',
      agentName: 'Booking Agent',
      data: {},
    });
    const exit = tracker.enrich({
      id: 'evt-exit',
      sessionId: 'session-1',
      type: 'agent_exit',
      agentName: 'Booking Agent',
      data: {},
    });

    expect(enter).toEqual(
      expect.objectContaining({
        agentRunId: 'session-1:Booking_Agent:1',
        phase: 'agent_lifecycle',
        reasonCode: 'agent_enter',
      }),
    );
    expect(decision).toEqual(
      expect.objectContaining({
        agentRunId: enter.agentRunId,
        causeEventId: 'evt-enter',
        decisionId: 'evt-decision',
        phase: 'decision',
        reasonCode: 'completion_check',
      }),
    );
    expect(exit).toEqual(
      expect.objectContaining({
        agentRunId: enter.agentRunId,
        causeEventId: 'evt-decision',
        phase: 'agent_lifecycle',
        reasonCode: 'agent_exit',
      }),
    );
  });

  it('preserves explicit causal fields from event payloads', () => {
    const tracker = createRuntimeTraceCausalTracker();

    const causal = tracker.enrich({
      id: 'evt-tool',
      sessionId: 'session-1',
      type: 'tool_call',
      agentName: 'Agent A',
      data: {
        turnId: 'turn-1',
        executionId: 'exec-1',
        parentExecutionId: 'exec-parent',
        agentRunId: 'agent-run-explicit',
        causeEventId: 'evt-cause',
        reasonCode: 'tool.completed',
      },
    });

    expect(causal).toEqual(
      expect.objectContaining({
        turnId: 'turn-1',
        executionId: 'exec-1',
        parentExecutionId: 'exec-parent',
        agentRunId: 'agent-run-explicit',
        causeEventId: 'evt-cause',
        phase: 'tool',
        reasonCode: 'tool.completed',
      }),
    );
  });

  it('keeps recently used agent run entries when the bounded tracker evicts older agents', () => {
    const tracker = createRuntimeTraceCausalTracker();

    const primaryEnter = tracker.enrich({
      id: 'evt-primary-enter',
      sessionId: 'session-1',
      type: 'agent_enter',
      agentName: 'Primary Agent',
      data: {},
    });

    for (let index = 0; index < CAUSAL_TRACKER_TEST_PREFILL_AGENT_COUNT; index += 1) {
      tracker.enrich({
        id: `evt-agent-${index}`,
        sessionId: 'session-1',
        type: 'agent_enter',
        agentName: `Overflow Agent ${index}`,
        data: {},
      });
    }

    tracker.enrich({
      id: 'evt-primary-decision',
      sessionId: 'session-1',
      type: 'completion_check',
      agentName: 'Primary Agent',
      data: {},
    });
    tracker.enrich({
      id: 'evt-overflow-agent',
      sessionId: 'session-1',
      type: 'agent_enter',
      agentName: 'Overflow Agent Final',
      data: {},
    });

    const primaryFollowup = tracker.enrich({
      id: 'evt-primary-followup',
      sessionId: 'session-1',
      type: 'completion_check',
      agentName: 'Primary Agent',
      data: {},
    });

    expect(primaryFollowup.agentRunId).toBe(primaryEnter.agentRunId);
  });

  it('attaches causal data without overwriting existing event-domain phase fields', () => {
    const data = attachRuntimeTraceCausalData(
      { phase: 'complete', toolName: 'lookup' },
      {
        agentRunId: 'agent-run-1',
        causeEventId: 'evt-prev',
        phase: 'tool',
        reasonCode: 'tool_call',
      },
    );

    expect(data).toEqual(
      expect.objectContaining({
        phase: 'complete',
        agentRunId: 'agent-run-1',
        causeEventId: 'evt-prev',
        reasonCode: 'tool_call',
        causal: expect.objectContaining({
          agentRunId: 'agent-run-1',
          causeEventId: 'evt-prev',
          phase: 'tool',
          reasonCode: 'tool_call',
        }),
      }),
    );
  });

  it('groups known runtime event families into stable phases', () => {
    expect(deriveRuntimeTracePhase('llm_call')).toBe('llm');
    expect(deriveRuntimeTracePhase('turn_start')).toBe('session');
    expect(deriveRuntimeTracePhase('turn_end')).toBe('session');
    expect(deriveRuntimeTracePhase('tool_call_start')).toBe('tool');
    expect(deriveRuntimeTracePhase('deterministic_routing')).toBe('decision');
    expect(deriveRuntimeTracePhase('routing_capabilities_resolved')).toBe('decision');
    expect(deriveRuntimeTracePhase('handoff_condition_check')).toBe('decision');
    expect(deriveRuntimeTracePhase('handoff_return_handler')).toBe('handoff');
    expect(deriveRuntimeTracePhase('resume_intent')).toBe('handoff');
    expect(deriveRuntimeTracePhase('thread_resume')).toBe('handoff');
    expect(deriveRuntimeTracePhase('return_to_parent')).toBe('handoff');
    expect(deriveRuntimeTracePhase('guardrail_check')).toBe('guardrail');
    expect(deriveRuntimeTracePhase('execution.failed')).toBe('error');
    expect(deriveRuntimeTracePhase('session_end')).toBe('session');
  });
});
