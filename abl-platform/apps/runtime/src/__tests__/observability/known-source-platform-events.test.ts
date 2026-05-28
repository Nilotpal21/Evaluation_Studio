import { describe, expect, it, vi } from 'vitest';
import type { EventStoreServices } from '@abl/eventstore';
import { emitToEventStore } from '../../services/trace/emit-to-eventstore.js';
import {
  RUNTIME_ATOMIC_PLATFORM_EVENT_TYPE,
  RUNTIME_TRACE_TYPE_DATA_KEY,
  RUNTIME_TRACE_UNMAPPED_DATA_KEY,
} from '../../services/trace-event-types.js';

function makeEventStore() {
  const emit = vi.fn();
  return {
    eventStore: { emitter: { emit } } as unknown as EventStoreServices,
    emit,
  };
}

describe('known_source platform event propagation', () => {
  it.each(['eval', 'synthetic', 'production'] as const)(
    'emits mapped trace events with known_source=%s',
    (knownSource) => {
      const { eventStore, emit } = makeEventStore();

      emitToEventStore({
        eventStore,
        knownSource,
        event: {
          id: `evt-${knownSource}`,
          type: 'user_message',
          sessionId: `session-${knownSource}`,
          tenantId: 'tenant-1',
          projectId: 'project-1',
          timestamp: new Date('2026-05-11T00:00:00.000Z'),
          data: { messageId: `message-${knownSource}` },
        },
      });

      expect(emit).toHaveBeenCalledWith(
        expect.objectContaining({
          event_type: 'message.user.received',
          known_source: knownSource,
          session_id: `session-${knownSource}`,
        }),
      );
    },
  );

  it('defaults mapped trace events to production', () => {
    const { eventStore, emit } = makeEventStore();

    emitToEventStore({
      eventStore,
      event: {
        id: 'evt-default',
        type: 'agent_response',
        sessionId: 'session-default',
        tenantId: 'tenant-1',
        projectId: 'project-1',
        timestamp: new Date('2026-05-11T00:00:00.000Z'),
        data: { messageId: 'message-default' },
      },
    });

    expect(emit).toHaveBeenCalledWith(
      expect.objectContaining({
        event_type: 'message.agent.sent',
        known_source: 'production',
      }),
    );
  });

  it('marks mapped transfer failure events as errors when they use errorCode/errorMessage fields', () => {
    const { eventStore, emit } = makeEventStore();

    emitToEventStore({
      eventStore,
      event: {
        id: 'evt-transfer-failed',
        type: 'agent_transfer.transfer_failed',
        sessionId: 'session-transfer',
        tenantId: 'tenant-1',
        projectId: 'project-1',
        timestamp: new Date('2026-05-11T00:00:00.000Z'),
        data: {
          provider: 'smartassist',
          channel: 'chat',
          errorCode: 'NO_AGENTS_AVAILABLE',
          errorMessage: 'No agents are available',
        },
      },
    });

    expect(emit).toHaveBeenCalledWith(
      expect.objectContaining({
        event_type: 'agent.transfer.failed',
        has_error: true,
        error_type: 'NO_AGENTS_AVAILABLE',
        error_message: 'No agents are available',
      }),
    );
  });

  it('emits unmapped runtime events through the durable generic runtime envelope', () => {
    const { eventStore, emit } = makeEventStore();

    emitToEventStore({
      eventStore,
      event: {
        id: 'evt-completion-check',
        type: 'completion_check',
        sessionId: 'session-completion',
        tenantId: 'tenant-1',
        projectId: 'project-1',
        timestamp: new Date('2026-05-11T00:00:00.000Z'),
        data: { result: 'complete' },
      },
    });

    expect(emit).toHaveBeenCalledWith(
      expect.objectContaining({
        event_type: RUNTIME_ATOMIC_PLATFORM_EVENT_TYPE,
        category: 'system',
        known_source: 'production',
        data: expect.objectContaining({
          result: 'complete',
          [RUNTIME_TRACE_TYPE_DATA_KEY]: 'completion_check',
          [RUNTIME_TRACE_UNMAPPED_DATA_KEY]: true,
        }),
        metadata: expect.objectContaining({
          runtime_trace_type: 'completion_check',
          runtime_trace_unmapped: true,
        }),
      }),
    );
  });

  it('emits causal trace metadata and durable data for historical replay', () => {
    const { eventStore, emit } = makeEventStore();

    emitToEventStore({
      eventStore,
      event: {
        id: 'evt-causal',
        type: 'completion_check',
        sessionId: 'session-causal',
        tenantId: 'tenant-1',
        projectId: 'project-1',
        timestamp: new Date('2026-05-11T00:00:00.000Z'),
        spanId: 'evt-causal',
        parentSpanId: 'evt-agent-enter',
        agentRunId: 'session-causal:agent:1',
        decisionId: 'evt-causal',
        causeEventId: 'evt-agent-enter',
        phase: 'decision',
        reasonCode: 'completion_check',
        data: { result: 'complete' },
      },
    });

    expect(emit).toHaveBeenCalledWith(
      expect.objectContaining({
        span_id: 'evt-causal',
        parent_span_id: 'evt-agent-enter',
        data: expect.objectContaining({
          result: 'complete',
          agentRunId: 'session-causal:agent:1',
          decisionId: 'evt-causal',
          causeEventId: 'evt-agent-enter',
          causal: expect.objectContaining({
            agentRunId: 'session-causal:agent:1',
            decisionId: 'evt-causal',
            causeEventId: 'evt-agent-enter',
            phase: 'decision',
            reasonCode: 'completion_check',
          }),
        }),
        metadata: expect.objectContaining({
          causal: expect.objectContaining({
            agentRunId: 'session-causal:agent:1',
            decisionId: 'evt-causal',
            causeEventId: 'evt-agent-enter',
            phase: 'decision',
            reasonCode: 'completion_check',
          }),
        }),
      }),
    );
  });
});
