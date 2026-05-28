import { beforeEach, describe, expect, it } from 'vitest';

import { dispatchEnvelope } from '../event-dispatcher';
import { useArchUIStore } from '../store';
import type { ArchSSEEvent, LiveArchEvent } from '../types';
import { useArchAIStore } from '../../store/arch-ai-store';

/**
 * Phase 3 / Task 3.2 — Verifies that the UI event dispatcher routes the
 * `integration_suggestion_card` widget variant into the chat message stream
 * via appendKbCardMessage, mirroring the existing handling for
 * `connector_status_card` and friends.
 */
describe('event-dispatcher: integration_suggestion_card', () => {
  beforeEach(() => {
    useArchUIStore.getState().clear();
    useArchAIStore.getState().reset();
  });

  it('appends an integration_suggestion_card kbCard onto an assistant message', () => {
    // Seed an assistant message so appendKbCardMessage attaches the card to
    // the latest assistant turn.
    useArchUIStore.setState((s) => ({
      messages: [
        ...s.messages,
        {
          id: 'assistant_msg_1',
          role: 'assistant' as const,
          content: 'before card',
          timestamp: new Date().toISOString(),
        },
      ],
    }));

    const env: LiveArchEvent = {
      eventId: 'evt_int_card_01',
      schemaVersion: 2,
      sessionId: 'sess_test',
      turnId: 'turn_test',
      seq: 0,
      timestamp: 1730000000000,
      type: 'artifact_updated',
      update: {
        artifact: 'widget',
        variant: 'integration_suggestion_card',
        payload: {
          title: 'Connect Slack',
          rationale: 'Your agent needs to post messages to channels.',
          providerOptions: [],
        },
      },
    } as unknown as LiveArchEvent;

    dispatchEnvelope(env, useArchUIStore.getState());

    const { messages } = useArchUIStore.getState();
    const assistantMessage = messages.find((m) => m.id === 'assistant_msg_1');
    expect(assistantMessage).toBeDefined();
    expect(assistantMessage?.kbCards).toBeDefined();
    expect(assistantMessage?.kbCards?.length).toBe(1);
    expect(assistantMessage?.kbCards?.[0]?.type).toBe('integration_suggestion_card');
    expect(assistantMessage?.kbCards?.[0]).toMatchObject({
      type: 'integration_suggestion_card',
      title: 'Connect Slack',
      rationale: 'Your agent needs to post messages to channels.',
    });
  });
});

describe('event-dispatcher: plan lifecycle events', () => {
  beforeEach(() => {
    useArchUIStore.getState().clear();
    useArchAIStore.getState().reset();
  });

  it('upserts the plan tab from a granular plan lifecycle event', () => {
    const env: LiveArchEvent = {
      eventId: 'evt_plan_01',
      schemaVersion: 2,
      sessionId: 'sess_test',
      turnId: 'turn_test',
      seq: 0,
      timestamp: 1730000000000,
      type: 'plan_approved',
      planId: 'plan_123',
      status: 'approved',
      payload: {
        id: 'plan_123',
        projectId: 'project_123',
        status: 'approved',
        title: 'Fix delegate flow',
        goal: 'Improve delegate handling after reading the related agents.',
        summary: 'The plan is approved and ready for authoring.',
        affectedAgents: ['TriageAgent', 'DelegateAgent'],
        createdAt: '2026-05-10T00:00:00.000Z',
        updatedAt: '2026-05-10T00:00:00.000Z',
      },
    } as unknown as LiveArchEvent;

    dispatchEnvelope(env, useArchUIStore.getState());

    const store = useArchAIStore.getState();
    expect(store.artifactTabs).toHaveLength(1);
    expect(store.activeTabId).toBe(store.artifactTabs[0].id);
    expect(store.artifactTabs[0]).toMatchObject({
      type: 'plan',
      label: 'Plan',
      data: expect.objectContaining({
        id: 'plan_123',
        status: 'approved',
      }),
    });
  });
});

/**
 * Specialist transition narration is gated by 3 conditions in the
 * dispatcher's raw 'specialist' arm (event-dispatcher.ts ~lines 291-303):
 *   - prevSpecialist must exist and have a name (no narration on first turn)
 *   - prevSpecialist.name !== nextSpecialist.name (no narration when same)
 *   - At least one assistant message must already be in `messages`
 *
 * These tests pin all four corner cases so a refactor cannot silently
 * regress the UX (either spamming the user with "Switching to X" on every
 * turn or dropping it entirely).
 *
 * The dispatcher reads/writes via the real Zustand store — no platform
 * mocks needed (per CLAUDE.md "Test Architecture").
 */
describe('event-dispatcher: specialist transition narration', () => {
  beforeEach(() => {
    useArchUIStore.getState().clear();
    // Force phase to a chat-mode value (not BUILD/CREATE) so the dispatcher
    // takes the message-creation branch and the narration check runs.
    useArchUIStore.setState({ phase: 'INTERVIEW' });
  });

  function specialistEvent(name: string, icon = 'network'): ArchSSEEvent {
    return { type: 'specialist', name, icon };
  }

  function seedAssistantMessage(): void {
    useArchUIStore.setState((s) => ({
      messages: [
        ...s.messages,
        {
          id: 'assistant_msg_seed',
          role: 'assistant' as const,
          content: 'prior assistant output',
          timestamp: new Date().toISOString(),
        },
      ],
    }));
  }

  it('appends a status message when specialist changes AND a prior assistant message exists', () => {
    seedAssistantMessage();
    // Step 1: set the initial specialist (no narration on first set).
    useArchUIStore.setState({
      currentSpecialist: { name: 'project-manager', icon: 'clipboard' },
    });

    // Step 2: dispatch a change to a different specialist.
    dispatchEnvelope(
      specialistEvent('integration-methodologist', 'plug'),
      useArchUIStore.getState(),
    );

    const { statusMessages } = useArchUIStore.getState();
    expect(statusMessages).toHaveLength(1);
    expect(statusMessages[0].type).toBe('info');
    // Display label resolves "integration-methodologist" -> "Integration Methodologist"
    // and reason resolves to "tool/connection setup" — see SPECIALIST_DISPLAY
    // and transitionReason() in event-dispatcher.ts.
    expect(statusMessages[0].text).toContain('Integration Methodologist');
    expect(statusMessages[0].text).toContain('tool/connection setup');
  });

  it('does NOT append a status message when the specialist is unchanged', () => {
    seedAssistantMessage();
    useArchUIStore.setState({
      currentSpecialist: { name: 'integration-methodologist', icon: 'plug' },
    });

    dispatchEnvelope(
      specialistEvent('integration-methodologist', 'plug'),
      useArchUIStore.getState(),
    );

    expect(useArchUIStore.getState().statusMessages).toHaveLength(0);
  });

  it('does NOT append a status message when no assistant message has been rendered yet', () => {
    // Note: no seedAssistantMessage() call here.
    useArchUIStore.setState({
      currentSpecialist: { name: 'project-manager', icon: 'clipboard' },
    });

    dispatchEnvelope(
      specialistEvent('integration-methodologist', 'plug'),
      useArchUIStore.getState(),
    );

    expect(useArchUIStore.getState().statusMessages).toHaveLength(0);
  });

  it('does NOT append a status message on the first specialist event (no prevSpecialist)', () => {
    seedAssistantMessage();
    // Defensive: ensure currentSpecialist starts unset.
    useArchUIStore.setState({ currentSpecialist: null });

    dispatchEnvelope(
      specialistEvent('integration-methodologist', 'plug'),
      useArchUIStore.getState(),
    );

    // The specialist arm should still set state, but no narration.
    expect(useArchUIStore.getState().statusMessages).toHaveLength(0);
    expect(useArchUIStore.getState().currentSpecialist).toEqual({
      name: 'integration-methodologist',
      icon: 'plug',
    });
  });
});

/**
 * Regression for the IN_PROJECT "blank chat after health check" bug.
 *
 * Real PM2 sequence captured 2026-05-12 (requestId=6d9dd700):
 *   seq=1 turn_started
 *   seq=2 tool_call        ← non-widget tool emitted BEFORE any text_delta
 *   seq=3 tool_result
 *   seq=4 status
 *   seq=5..329 text_delta × 325   ← entire markdown response
 *   seq=330 artifact_updated
 *   seq=331 turn_committed
 *   seq=332 turn_ended
 *
 * Pre-fix: the raw-SSE `tool_call` handler cleared `currentMsgId` (treating
 * every internal tool as a turn terminator), then the v4 `text_delta` handler
 * silently dropped every subsequent delta (`if (!s.currentMsgId) return {}`),
 * leaving the assistant message with empty content and a non-renderable
 * toolCall. The chat appeared blank even though 325 deltas arrived.
 *
 * Post-fix: non-widget tool_calls attach to the streaming message without
 * clearing currentMsgId, and text_delta self-heals via ensureAssistantMessage.
 * The final message contains the full concatenated text.
 */
describe('event-dispatcher: tool-first LLM keeps text_delta streaming', () => {
  beforeEach(() => {
    useArchUIStore.getState().clear();
    useArchAIStore.getState().reset();
    useArchUIStore.setState({ phase: 'INTERVIEW' });
  });

  function envelope(seq: number, type: string, body: Record<string, unknown>): LiveArchEvent {
    return {
      eventId: `evt_${seq}`,
      schemaVersion: 2,
      sessionId: 'sess_test',
      turnId: 'turn_test',
      seq,
      timestamp: 1730000000000 + seq,
      type,
      ...body,
    } as unknown as LiveArchEvent;
  }

  it('preserves the full streamed response when tool_call arrives before any text', () => {
    // seq=1 turn_started (v4 envelope creates the streaming assistant bubble)
    dispatchEnvelope(
      envelope(1, 'turn_started', {
        specialist: 'in-project-architect',
        userMessageId: 'user_msg_1',
      }),
      useArchUIStore.getState(),
    );

    // seq=2 tool_call (raw SSE — no envelope; matches what the route emits
    // from the engine's onToolCall callback for non-widget internal tools)
    const toolCallEvent: ArchSSEEvent = {
      type: 'tool_call',
      toolCallId: 'tc_health_1',
      toolName: 'health_check',
      input: { projectId: 'proj_1' },
    };
    dispatchEnvelope(toolCallEvent as unknown as LiveArchEvent, useArchUIStore.getState());

    // seq=3 tool_result (raw SSE)
    const toolResultEvent: ArchSSEEvent = {
      type: 'tool_result',
      toolCallId: 'tc_health_1',
      toolName: 'health_check',
      result: { overall: 'Critical', errors: 10 },
      isError: false,
    };
    dispatchEnvelope(toolResultEvent as unknown as LiveArchEvent, useArchUIStore.getState());

    // seq=4..N text_delta (v4 envelope) — the markdown response after the tool
    const deltas = ['## Health ', 'check ', 'result\n\n', '- **Overall:** Critical'];
    deltas.forEach((delta, i) => {
      dispatchEnvelope(
        envelope(4 + i, 'text_delta', { delta, specialist: 'in-project-architect' }),
        useArchUIStore.getState(),
      );
    });

    // seq=N+1 turn_ended
    dispatchEnvelope(
      envelope(4 + deltas.length, 'turn_ended', { reason: 'natural', suggestions: [] }),
      useArchUIStore.getState(),
    );

    const { messages } = useArchUIStore.getState();
    const assistant = messages.find((m) => m.role === 'assistant');
    expect(assistant).toBeDefined();
    // The full markdown response must be intact, not silently dropped after
    // the tool_call cleared currentMsgId pre-fix.
    expect(assistant?.content).toBe('## Health check result\n\n- **Overall:** Critical');
    expect(assistant?.toolCall?.toolCallId).toBe('tc_health_1');
    expect(assistant?.toolCall?.toolName).toBe('health_check');
    expect(assistant?.toolCall?.result).toEqual({ overall: 'Critical', errors: 10 });
  });

  it('text_delta self-heals when currentMsgId was cleared by an earlier handler', () => {
    // Seed: simulate state where currentMsgId is null (e.g., a previous
    // handler cleared it) but a specialist context exists. text_delta must
    // create a fresh streaming message rather than silently no-op.
    useArchUIStore.setState({
      currentMsgId: null,
      currentSpecialist: { name: 'in-project-architect', icon: 'bot' },
      phase: 'INTERVIEW',
    });

    dispatchEnvelope(
      envelope(1, 'text_delta', { delta: 'Hello world' }),
      useArchUIStore.getState(),
    );

    const { messages, currentMsgId } = useArchUIStore.getState();
    expect(currentMsgId).not.toBeNull();
    expect(messages).toHaveLength(1);
    expect(messages[0]?.role).toBe('assistant');
    expect(messages[0]?.content).toBe('Hello world');
    expect(messages[0]?.isStreaming).toBe(true);
  });

  it('non-widget tool_call attaches to the streaming message without ending the turn', () => {
    dispatchEnvelope(
      envelope(1, 'turn_started', {
        specialist: 'in-project-architect',
        userMessageId: 'user_msg_1',
      }),
      useArchUIStore.getState(),
    );
    const msgIdBefore = useArchUIStore.getState().currentMsgId;
    expect(msgIdBefore).not.toBeNull();

    const toolCallEvent: ArchSSEEvent = {
      type: 'tool_call',
      toolCallId: 'tc_propose_1',
      toolName: 'propose_modification',
      input: {},
    };
    dispatchEnvelope(toolCallEvent as unknown as LiveArchEvent, useArchUIStore.getState());

    const stateAfter = useArchUIStore.getState();
    // Streaming must continue: currentMsgId must point to the SAME message
    // (not be cleared) so subsequent text_delta lands in the same bubble.
    expect(stateAfter.currentMsgId).toBe(msgIdBefore);
    const msg = stateAfter.messages.find((m) => m.id === msgIdBefore);
    expect(msg?.toolCall?.toolName).toBe('propose_modification');
  });
});

describe('event-dispatcher: duplicate pending confirmations', () => {
  beforeEach(() => {
    useArchUIStore.getState().clear();
    useArchAIStore.getState().reset();
    useArchUIStore.setState({ phase: 'IN_PROJECT' });
  });

  function envelope(seq: number, type: string, body: Record<string, unknown>): LiveArchEvent {
    return {
      eventId: `evt_dup_${seq}`,
      schemaVersion: 2,
      sessionId: 'sess_test',
      turnId: `turn_dup_${Math.floor(seq / 10)}`,
      seq,
      timestamp: 1730000000000 + seq,
      type,
      ...body,
    } as unknown as LiveArchEvent;
  }

  const confirmationPayload = {
    widgetType: 'Confirmation',
    question: 'Approve this plan so I can prepare the actual agent diffs?',
    confirmLabel: 'Approve Plan',
    denyLabel: 'Revise Plan',
  };

  function dispatchPlanConfirmationTurn(seqBase: number, toolCallId: string): void {
    dispatchEnvelope(
      envelope(seqBase, 'turn_started', {
        specialist: 'in-project-architect',
        userMessageId: `user_${seqBase}`,
      }),
      useArchUIStore.getState(),
    );
    dispatchEnvelope(
      envelope(seqBase + 1, 'text_delta', {
        delta:
          'I prepared a fix plan for the health issues. Approve this plan so I can prepare the actual agent diffs?',
        specialist: 'in-project-architect',
      }),
      useArchUIStore.getState(),
    );
    dispatchEnvelope(
      envelope(seqBase + 2, 'interactive_tool', {
        tool: 'ask_user',
        toolCallId,
        kind: 'tool',
        payload: confirmationPayload,
      }),
      useArchUIStore.getState(),
    );
  }

  it('does not render the same unanswered ask_user confirmation twice', () => {
    dispatchPlanConfirmationTurn(10, 'ask_plan_1');
    dispatchPlanConfirmationTurn(20, 'ask_plan_2');

    const { messages, currentMsgId, state } = useArchUIStore.getState();
    const confirmationMessages = messages.filter(
      (message) =>
        message.toolCall?.toolName === 'ask_user' &&
        (message.toolCall.input as Record<string, unknown>).confirmLabel === 'Approve Plan',
    );

    expect(state).toBe('widget_pending');
    expect(currentMsgId).toBeNull();
    expect(confirmationMessages).toHaveLength(1);
    expect(messages).toHaveLength(1);
    expect(messages[0]?.content).toContain('I prepared a fix plan');
  });

  it('ignores duplicate durable replay events from a second SSE subscription', () => {
    const firstTurnStarted = envelope(10, 'turn_started', {
      specialist: 'in-project-architect',
      userMessageId: 'user_10',
    });
    const firstTextDelta = envelope(11, 'text_delta', {
      delta: 'I prepared a fix plan.',
      specialist: 'in-project-architect',
    });
    const firstInteractiveTool = envelope(12, 'interactive_tool', {
      tool: 'ask_user',
      toolCallId: 'ask_plan_1',
      kind: 'tool',
      payload: confirmationPayload,
    });

    dispatchEnvelope(firstTurnStarted, useArchUIStore.getState());
    dispatchEnvelope(firstTextDelta, useArchUIStore.getState());
    dispatchEnvelope(firstInteractiveTool, useArchUIStore.getState());

    dispatchEnvelope(
      { ...firstTurnStarted, eventId: 'evt_dup_replay_10b' },
      useArchUIStore.getState(),
    );
    dispatchEnvelope(
      { ...firstTextDelta, eventId: 'evt_dup_replay_11b' },
      useArchUIStore.getState(),
    );
    dispatchEnvelope(
      { ...firstInteractiveTool, eventId: 'evt_dup_replay_12b' },
      useArchUIStore.getState(),
    );

    const { messages, seenSeqByTurn } = useArchUIStore.getState();
    expect(seenSeqByTurn.get('turn_dup_1')).toBe(12);
    expect(messages).toHaveLength(1);
    expect(messages[0]?.content).toBe('I prepared a fix plan.');
    expect(messages[0]?.toolCall?.toolCallId).toBe('ask_plan_1');
  });
});
