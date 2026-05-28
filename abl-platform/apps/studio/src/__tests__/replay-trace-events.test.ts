import { afterEach, describe, expect, test } from 'vitest';
import {
  augmentSessionMessagesWithTraceEvents,
  hydrateSessionStoreFromDetail,
  replayTraceEventsIntoObservatory,
} from '../utils/replay-trace-events';
import { useObservatoryStore } from '../store/observatory-store';
import { useSessionStore } from '../store/session-store';
import type { TraceEvent } from '../types';

function makeEvent(overrides: Partial<TraceEvent> & { id: string; type: string }): TraceEvent {
  return {
    id: overrides.id,
    sessionId: 'session-1',
    timestamp: new Date('2026-04-05T06:42:39.000Z'),
    data: {},
    ...overrides,
  } as TraceEvent;
}

describe('replayTraceEventsIntoObservatory', () => {
  afterEach(() => {
    useObservatoryStore.getState().clearEvents();
    useObservatoryStore.getState().clearFlow();
    useObservatoryStore.getState().resetMetrics();
    useObservatoryStore.getState().clearLogs();
    useObservatoryStore.getState().clearSelection();
    useSessionStore.getState().clearSession();
  });

  test('replays pre-agent attachment events into the next agent span', () => {
    replayTraceEventsIntoObservatory(
      [
        makeEvent({
          id: 'attachment-download',
          type: 'attachment_process',
          timestamp: new Date('2026-04-05T06:42:39.497Z'),
          data: {
            stage: 'download',
            filename: 'test-slack-image.png',
          },
        }),
        makeEvent({
          id: 'attachment-upload',
          type: 'attachment_upload',
          timestamp: new Date('2026-04-05T06:42:39.525Z'),
          data: {
            stage: 'upload',
            filename: 'test-slack-image.png',
          },
        }),
        makeEvent({
          id: 'user-message',
          type: 'user_message',
          timestamp: new Date('2026-04-05T06:42:39.556Z'),
          agentName: 'SlackTestAgent',
          data: {
            message: 'whats this',
            agentName: 'SlackTestAgent',
          },
        }),
        makeEvent({
          id: 'agent-enter',
          type: 'agent_enter',
          timestamp: new Date('2026-04-05T06:42:39.556Z'),
          spanId: 'agent-span',
          agentName: 'SlackTestAgent',
          data: {
            agentName: 'SlackTestAgent',
          },
        }),
        makeEvent({
          id: 'agent-exit',
          type: 'agent_exit',
          timestamp: new Date('2026-04-05T06:42:40.556Z'),
          spanId: 'agent-span',
          agentName: 'SlackTestAgent',
          data: {
            agentName: 'SlackTestAgent',
          },
        }),
      ],
      'session-1',
    );

    const span = useObservatoryStore.getState().spans.get('agent-span');
    expect(span).toBeDefined();
    expect(span?.events.map((event) => event.type)).toContain('attachment_process');
    expect(span?.events.map((event) => event.type)).toContain('attachment_upload');
  });

  test('does not append duplicate debug logs for duplicate replayed trace IDs', () => {
    replayTraceEventsIntoObservatory(
      [
        makeEvent({
          id: 'llm-call',
          type: 'llm_call',
          data: { model: 'sonnet', agentName: 'BookingAgent' },
        }),
        makeEvent({
          id: 'llm-call',
          type: 'llm_call',
          data: { model: 'sonnet', agentName: 'BookingAgent' },
        }),
      ],
      'session-1',
    );

    expect(
      useObservatoryStore.getState().events.filter((event) => event.id === 'llm-call'),
    ).toHaveLength(1);
    expect(
      useObservatoryStore
        .getState()
        .logs.filter((log) => log.message === 'LLM call to sonnet (BookingAgent)'),
    ).toHaveLength(1);
  });

  test('formats delegation logs from canonical agent aliases', () => {
    replayTraceEventsIntoObservatory(
      [
        makeEvent({
          id: 'delegate-start',
          type: 'delegate_start',
          data: {
            sourceAgent: 'ContractTriage',
            targetAgent: 'DatabaseQueryAgent',
          },
        }),
        makeEvent({
          id: 'delegate-complete',
          type: 'delegate_complete',
          data: {
            fromAgent: 'ContractTriage',
            toAgent: 'DatabaseQueryAgent',
          },
        }),
      ],
      'session-1',
    );

    const messages = useObservatoryStore.getState().logs.map((log) => log.message);
    expect(messages).toContain('Delegating to: DatabaseQueryAgent');
    expect(messages).toContain('Delegation complete: DatabaseQueryAgent');
  });

  test('suppresses chat-only tool thoughts from replay debug logs', () => {
    replayTraceEventsIntoObservatory(
      [
        makeEvent({
          id: 'tool-thought',
          type: 'tool_thought',
          data: {
            toolName: 'delegate_to_DatabaseQueryAgent',
            thought: 'Routing decision already appears as a decision event.',
            visibility: 'chat_thought_only',
          },
        }),
      ],
      'session-1',
    );

    expect(useObservatoryStore.getState().logs.map((log) => log.message)).not.toContain(
      'Thought (delegate_to_DatabaseQueryAgent): Routing decision already appears as a decision event.',
    );
  });

  test('hydrateSessionStoreFromDetail preserves rawContent and contentEnvelope', () => {
    const contentEnvelope = {
      version: 2,
      format: 'message_envelope',
      text: 'Historical structured response.',
      blocks: [{ type: 'text' as const, text: 'Historical structured response.' }],
      richContent: { markdown: '**Historical structured response.**' },
    };

    hydrateSessionStoreFromDetail({
      id: 'session-structured',
      agentName: 'ReplayAgent',
      messages: [
        {
          id: 'message-1',
          role: 'assistant',
          content: 'Historical structured response.',
          rawContent: contentEnvelope.blocks,
          contentEnvelope,
          timestamp: new Date('2026-04-05T06:42:40.000Z'),
          traceIds: ['trace-1'],
        },
      ],
    });

    const [message] = useSessionStore.getState().messages;
    expect(message).toBeDefined();
    expect(message.rawContent).toEqual(contentEnvelope.blocks);
    expect(message.contentEnvelope).toEqual(contentEnvelope);
  });

  test('augmentSessionMessagesWithTraceEvents synthesizes structured message.agent responses', () => {
    const contentEnvelope = {
      version: 2,
      format: 'message_envelope',
      text: 'Choose an option.',
      blocks: [{ type: 'text' as const, text: 'Choose an option.' }],
      richContent: { markdown: '**Choose an option.**' },
      voiceConfig: { plain_text: 'Choose an option.' },
      actions: {
        elements: [{ id: 'yes', type: 'button' as const, label: 'Yes' }],
        submit_id: 'choice-submit',
      },
    };

    const messages = augmentSessionMessagesWithTraceEvents(
      [],
      [
        makeEvent({
          id: 'trace-user-1',
          type: 'user_message',
          timestamp: new Date('2026-04-05T06:42:39.000Z'),
          data: { message: 'show options' },
        }),
        makeEvent({
          id: 'trace-agent-1',
          type: 'message.agent.sent',
          timestamp: new Date('2026-04-05T06:42:40.000Z'),
          data: {
            content: 'Choose an option.',
            structuredContent: {
              richContent: contentEnvelope.richContent,
              voiceConfig: contentEnvelope.voiceConfig,
              actions: contentEnvelope.actions,
            },
            contentEnvelope,
            responseMetadata: {
              isLlmGenerated: false,
              responseProvenance: {
                schemaVersion: 1,
                sources: ['flow_static'],
              },
            },
          },
        }),
      ],
    );

    const assistant = messages.find((message) => message.role === 'assistant');
    expect(assistant).toMatchObject({
      id: 'trace-resp-trace-agent-1',
      content: 'Choose an option.',
      rawContent: contentEnvelope.blocks,
      contentEnvelope,
      metadata: {
        synthetic: true,
        isLlmGenerated: false,
        responseProvenance: {
          schemaVersion: 1,
          sources: ['flow_static'],
        },
      },
    });
  });

  test('augmentSessionMessagesWithTraceEvents ignores internal message.agent responses', () => {
    const messages = augmentSessionMessagesWithTraceEvents(
      [],
      [
        makeEvent({
          id: 'trace-user-1',
          type: 'user_message',
          timestamp: new Date('2026-04-05T06:42:39.000Z'),
          data: { message: 'check policy' },
        }),
        makeEvent({
          id: 'trace-agent-internal-top-level',
          type: 'message.agent.sent',
          timestamp: new Date('2026-04-05T06:42:40.000Z'),
          data: {
            content: 'Internal policy memo should not appear.',
            responseVisibility: 'internal',
          },
        }),
        makeEvent({
          id: 'trace-agent-internal-metadata',
          type: 'agent_response',
          timestamp: new Date('2026-04-05T06:42:41.000Z'),
          data: {
            content: 'Internal delegate answer should not appear.',
            responseMetadata: {
              coordination: { visibility: 'internal' },
            },
          },
        }),
      ],
    );

    expect(messages).toEqual([
      expect.objectContaining({
        role: 'user',
        content: 'check policy',
      }),
    ]);
  });

  test('augmentSessionMessagesWithTraceEvents upgrades partial envelopes from message.agent traces', () => {
    const partialEnvelope = {
      version: 2,
      format: 'message_envelope',
      text: 'Choose an option.',
    };
    const richerEnvelope = {
      version: 2,
      format: 'message_envelope',
      text: 'Choose an option.',
      richContent: { markdown: '**Choose an option.**' },
      actions: {
        elements: [{ id: 'yes', type: 'button' as const, label: 'Yes' }],
        submit_id: 'choice-submit',
      },
    };

    const messages = augmentSessionMessagesWithTraceEvents(
      [
        {
          id: 'message-1',
          role: 'assistant',
          content: 'Choose an option.',
          contentEnvelope: partialEnvelope,
          timestamp: new Date('2026-04-05T06:42:40.000Z'),
        },
      ],
      [
        makeEvent({
          id: 'trace-agent-1',
          type: 'message.agent.sent',
          timestamp: new Date('2026-04-05T06:42:40.000Z'),
          data: {
            content: 'Choose an option.',
            contentEnvelope: richerEnvelope,
          },
        }),
      ],
    );

    expect(messages[0].contentEnvelope).toEqual(richerEnvelope);
  });

  test('hydrateSessionStoreFromDetail preserves message metadata', () => {
    hydrateSessionStoreFromDetail({
      id: 'session-provenance',
      agentName: 'ReplayAgent',
      messages: [
        {
          id: 'message-1',
          role: 'assistant',
          content: 'Historical structured response.',
          metadata: {
            isLlmGenerated: false,
            responseProvenance: {
              schemaVersion: 1,
              kind: 'scripted',
              disclaimerRequired: false,
              usedLlmInternally: true,
            },
          },
          timestamp: new Date('2026-04-05T06:42:40.000Z'),
          traceIds: ['trace-1'],
        },
      ],
    });

    const [message] = useSessionStore.getState().messages;
    expect(message).toBeDefined();
    expect(message.metadata).toEqual({
      isLlmGenerated: false,
      responseProvenance: {
        schemaVersion: 1,
        kind: 'scripted',
        disclaimerRequired: false,
        usedLlmInternally: true,
      },
    });
  });

  test('hydrateSessionStoreFromDetail swaps sessions without an intermediate null sessionId', () => {
    useSessionStore.getState().restoreSession({
      sessionId: 'session-existing',
      agent: {
        id: 'agent-existing',
        name: 'ExistingAgent',
        type: 'agent',
        mode: 'reasoning',
        toolCount: 0,
        gatherFieldCount: 0,
        isSupervisor: false,
        dsl: '',
      },
      messages: [],
      state: null,
    });

    const seenSessionIds: Array<string | null> = [];
    const unsubscribe = useSessionStore.subscribe((state) => {
      seenSessionIds.push(state.sessionId);
    });

    hydrateSessionStoreFromDetail({
      id: 'session-historical',
      agentName: 'ReplayAgent',
      messages: [],
    });

    unsubscribe();

    expect(seenSessionIds).toEqual(['session-historical']);
    expect(useSessionStore.getState().sessionId).toBe('session-historical');
  });

  test('hydrateSessionStoreFromDetail trusts a full hydrated transcript over trace variants', () => {
    hydrateSessionStoreFromDetail(
      {
        id: 'session-complete',
        agentName: 'ReplayAgent',
        messages: [
          {
            id: 'msg-assistant-greeting',
            role: 'assistant',
            content: 'Thank you for calling Spectrum. How can I assist you today?',
            timestamp: new Date('2026-04-05T06:42:39.000Z'),
          },
          {
            id: 'msg-user-1',
            role: 'user',
            content: 'hi',
            timestamp: new Date('2026-04-05T06:42:40.000Z'),
          },
          {
            id: 'msg-assistant-1',
            role: 'assistant',
            content: 'Hello! How can I help you today?',
            timestamp: new Date('2026-04-05T06:42:41.000Z'),
          },
        ],
      },
      [
        makeEvent({
          id: 'trace-user-1',
          type: 'user_message',
          timestamp: new Date('2026-04-05T06:42:40.000Z'),
          data: { message: 'hi' },
        }),
        makeEvent({
          id: 'trace-dsl-greeting',
          type: 'dsl_respond',
          timestamp: new Date('2026-04-05T06:42:39.000Z'),
          data: { rendered: 'Thank you for calling Spectrum. How can I assist you today?' },
        }),
        makeEvent({
          id: 'trace-llm-variant',
          type: 'llm_call',
          timestamp: new Date('2026-04-05T06:42:42.000Z'),
          data: {
            response: 'Hello! How can I help you today? If you need any assistance, let me know.',
          },
        }),
      ],
    );

    expect(useSessionStore.getState().messages.map((message) => message.id)).toEqual([
      'msg-assistant-greeting',
      'msg-user-1',
      'msg-assistant-1',
    ]);
  });

  test('synthesizes customer-visible llm traces with provenance metadata', () => {
    const messages = augmentSessionMessagesWithTraceEvents(
      [],
      [
        makeEvent({
          id: 'trace-user-1',
          type: 'user_message',
          timestamp: new Date('2026-04-05T06:42:40.000Z'),
          data: { message: 'hi' },
        }),
        makeEvent({
          id: 'trace-llm-visible',
          type: 'llm_call',
          timestamp: new Date('2026-04-05T06:42:41.000Z'),
          data: {
            response: 'Hello from the model',
            operationType: 'response_gen',
            responseContribution: 'customer_visible',
          },
        }),
      ],
    );

    expect(messages).toEqual([
      expect.objectContaining({
        role: 'user',
        content: 'hi',
      }),
      expect.objectContaining({
        role: 'assistant',
        content: 'Hello from the model',
        metadata: {
          synthetic: true,
          isLlmGenerated: true,
          responseProvenance: {
            schemaVersion: 1,
            kind: 'llm',
            disclaimerRequired: true,
            usedLlmInternally: true,
          },
        },
      }),
    ]);
  });

  test('synthesizes customer-visible realtime voice llm traces from response transcript', () => {
    const messages = augmentSessionMessagesWithTraceEvents(
      [],
      [
        makeEvent({
          id: 'trace-user-voice',
          type: 'user_message',
          timestamp: new Date('2026-04-05T06:42:40.000Z'),
          data: { message: 'hello there' },
        }),
        makeEvent({
          id: 'trace-llm-voice',
          type: 'llm_call',
          timestamp: new Date('2026-04-05T06:42:41.000Z'),
          data: {
            modality: 'realtime_voice',
            channel: 'voice',
            responseContribution: 'customer_visible',
            response: {
              status: 'completed',
              responseId: 'resp-123',
              transcript: 'Hello from the voice agent',
            },
          },
        }),
      ],
    );

    expect(messages).toEqual([
      expect.objectContaining({
        role: 'user',
        content: 'hello there',
      }),
      expect.objectContaining({
        role: 'assistant',
        content: 'Hello from the voice agent',
        metadata: {
          synthetic: true,
          isLlmGenerated: true,
          responseProvenance: {
            schemaVersion: 1,
            kind: 'llm',
            disclaimerRequired: true,
            usedLlmInternally: true,
          },
        },
      }),
    ]);
  });

  test('enriches existing assistant messages with llm provenance metadata when counts already align', () => {
    const messages = augmentSessionMessagesWithTraceEvents(
      [
        {
          id: 'msg-user-1',
          role: 'user',
          content: 'hi',
          timestamp: new Date('2026-04-05T06:42:40.000Z'),
          traceIds: [],
        },
        {
          id: 'msg-assistant-1',
          role: 'assistant',
          content: 'Hello from the model',
          timestamp: new Date('2026-04-05T06:42:41.000Z'),
          traceIds: [],
        },
      ],
      [
        makeEvent({
          id: 'trace-user-1',
          type: 'user_message',
          timestamp: new Date('2026-04-05T06:42:40.000Z'),
          data: { message: 'hi' },
        }),
        makeEvent({
          id: 'trace-llm-visible',
          type: 'llm_call',
          timestamp: new Date('2026-04-05T06:42:41.000Z'),
          data: {
            response: 'Hello from the model',
            operationType: 'response_gen',
            responseContribution: 'customer_visible',
          },
        }),
      ],
    );

    expect(messages).toEqual([
      expect.objectContaining({
        id: 'msg-user-1',
        role: 'user',
        content: 'hi',
      }),
      expect.objectContaining({
        id: 'msg-assistant-1',
        role: 'assistant',
        content: 'Hello from the model',
        metadata: {
          isLlmGenerated: true,
          responseProvenance: {
            schemaVersion: 1,
            kind: 'llm',
            disclaimerRequired: true,
            usedLlmInternally: true,
          },
        },
      }),
    ]);
  });

  test('enriches existing assistant messages from structured llm trace responses', () => {
    const messages = augmentSessionMessagesWithTraceEvents(
      [
        {
          id: 'msg-user-1',
          role: 'user',
          content: 'hello there',
          timestamp: new Date('2026-04-05T06:42:40.000Z'),
          traceIds: [],
        },
        {
          id: 'msg-assistant-1',
          role: 'assistant',
          content: 'Hello from the voice agent',
          timestamp: new Date('2026-04-05T06:42:41.000Z'),
          traceIds: [],
        },
      ],
      [
        makeEvent({
          id: 'trace-user-voice',
          type: 'user_message',
          timestamp: new Date('2026-04-05T06:42:40.000Z'),
          data: { message: 'hello there' },
        }),
        makeEvent({
          id: 'trace-llm-voice',
          type: 'llm_call',
          timestamp: new Date('2026-04-05T06:42:41.000Z'),
          data: {
            modality: 'realtime_voice',
            channel: 'voice',
            responseContribution: 'customer_visible',
            response: {
              status: 'completed',
              responseId: 'resp-123',
              transcript: 'Hello from the voice agent',
            },
          },
        }),
      ],
    );

    expect(messages).toEqual([
      expect.objectContaining({
        id: 'msg-user-1',
        role: 'user',
        content: 'hello there',
      }),
      expect.objectContaining({
        id: 'msg-assistant-1',
        role: 'assistant',
        content: 'Hello from the voice agent',
        traceIds: ['trace-llm-voice'],
        metadata: {
          isLlmGenerated: true,
          responseProvenance: {
            schemaVersion: 1,
            kind: 'llm',
            disclaimerRequired: true,
            usedLlmInternally: true,
          },
        },
      }),
    ]);
  });

  test('does not synthesize assistant messages from internal-only llm traces', () => {
    const messages = augmentSessionMessagesWithTraceEvents(
      [],
      [
        makeEvent({
          id: 'trace-user-1',
          type: 'user_message',
          timestamp: new Date('2026-04-05T06:42:40.000Z'),
          data: { message: 'validate this' },
        }),
        makeEvent({
          id: 'trace-llm-internal',
          type: 'llm_call',
          timestamp: new Date('2026-04-05T06:42:41.000Z'),
          data: {
            response: 'internal classifier response',
            purpose: 'field_validation',
            responseContribution: 'internal_only',
          },
        }),
      ],
    );

    expect(messages).toEqual([
      expect.objectContaining({
        role: 'user',
        content: 'validate this',
      }),
    ]);
  });

  test('marks scripted trace responses as scripted even when llm was only used internally', () => {
    const messages = augmentSessionMessagesWithTraceEvents(
      [],
      [
        makeEvent({
          id: 'trace-user-1',
          type: 'user_message',
          timestamp: new Date('2026-04-05T06:42:40.000Z'),
          data: { message: 'check policy' },
        }),
        makeEvent({
          id: 'trace-llm-internal',
          type: 'llm_call',
          timestamp: new Date('2026-04-05T06:42:41.000Z'),
          data: {
            purpose: 'field_validation',
            responseContribution: 'internal_only',
          },
        }),
        makeEvent({
          id: 'trace-dsl-response',
          type: 'dsl_respond',
          timestamp: new Date('2026-04-05T06:42:42.000Z'),
          data: { rendered: 'Your policy is active.' },
        }),
      ],
    );

    expect(messages).toEqual([
      expect.objectContaining({
        role: 'user',
        content: 'check policy',
      }),
      expect.objectContaining({
        role: 'assistant',
        content: 'Your policy is active.',
        metadata: {
          synthetic: true,
          isLlmGenerated: false,
          responseProvenance: {
            schemaVersion: 1,
            kind: 'scripted',
            disclaimerRequired: false,
            usedLlmInternally: true,
          },
        },
      }),
    ]);
  });

  test('enriches existing scripted assistant messages when only trace metadata is missing', () => {
    const messages = augmentSessionMessagesWithTraceEvents(
      [
        {
          id: 'msg-user-1',
          role: 'user',
          content: 'check policy',
          timestamp: new Date('2026-04-05T06:42:40.000Z'),
          traceIds: [],
        },
        {
          id: 'msg-assistant-1',
          role: 'assistant',
          content: 'Your policy is active.',
          timestamp: new Date('2026-04-05T06:42:42.000Z'),
          traceIds: [],
        },
      ],
      [
        makeEvent({
          id: 'trace-user-1',
          type: 'user_message',
          timestamp: new Date('2026-04-05T06:42:40.000Z'),
          data: { message: 'check policy' },
        }),
        makeEvent({
          id: 'trace-llm-internal',
          type: 'llm_call',
          timestamp: new Date('2026-04-05T06:42:41.000Z'),
          data: {
            purpose: 'field_validation',
            responseContribution: 'internal_only',
          },
        }),
        makeEvent({
          id: 'trace-dsl-response',
          type: 'dsl_respond',
          timestamp: new Date('2026-04-05T06:42:42.000Z'),
          data: { rendered: 'Your policy is active.' },
        }),
      ],
    );

    expect(messages).toEqual([
      expect.objectContaining({
        id: 'msg-user-1',
        role: 'user',
        content: 'check policy',
      }),
      expect.objectContaining({
        id: 'msg-assistant-1',
        role: 'assistant',
        content: 'Your policy is active.',
        metadata: {
          isLlmGenerated: false,
          responseProvenance: {
            schemaVersion: 1,
            kind: 'scripted',
            disclaimerRequired: false,
            usedLlmInternally: true,
          },
        },
      }),
    ]);
  });
});
