import { describe, expect, it } from 'vitest';
import { eventRegistry } from '@abl/eventstore/schema';
import {
  PLATFORM_TO_TRACE_ALIASES,
  TRACE_TO_PLATFORM_TYPE,
} from '../../services/trace-event-types.js';

const mappedPlatformEventTypes = [
  ...new Set([...Object.values(TRACE_TO_PLATFORM_TYPE), ...Object.keys(PLATFORM_TO_TRACE_ALIASES)]),
].sort();

describe('runtime trace events align with EventStore schemas', () => {
  it('registers every mapped platform event type in EventStore', () => {
    const unregisteredEventTypes = mappedPlatformEventTypes.filter(
      (eventType) => !eventRegistry.has(eventType),
    );

    expect(unregisteredEventTypes).toEqual([]);
  });

  it('maps runtime retry traces to the EventStore retry schema', () => {
    expect(TRACE_TO_PLATFORM_TYPE.tool_call_retry).toBe('tool.call.retried');
    expect(eventRegistry.has('tool.call.retried')).toBe(true);
  });

  it('validates runtime ABL parity trace payloads against EventStore schemas', () => {
    const examples: Array<{ eventType: string; data: Record<string, unknown> }> = [
      {
        eventType: 'agent.escalation.triggered',
        data: {
          reason: 'billing escalation',
          priority: 'high',
          agent: 'SupportAgent',
          humanTaskId: 'task-1',
          hasAgentTransfer: true,
          hasItsmConnector: false,
          isPaused: true,
          sessionId: 'session-1',
        },
      },
      {
        eventType: 'agent.escalation.resolved',
        data: {
          humanTaskId: 'task-1',
          decision: 'approved',
          action: 'continue',
          respondedBy: 'user-1',
          sessionId: 'session-1',
        },
      },
      {
        eventType: 'agent.escalation.itsm_created',
        data: {
          connectorAction: 'servicenow_create_incident',
          humanTaskId: 'task-1',
          ticketId: 'INC-1',
          ticketUrl: 'https://tickets.example.test/INC-1',
          sessionId: 'session-1',
        },
      },
      {
        eventType: 'agent.hook.executed',
        data: {
          hookType: 'before_turn',
          actionsExecuted: ['CALL', 'SET'],
          durationMs: 42,
          success: true,
        },
      },
      {
        eventType: 'agent.error.handled',
        data: {
          errorType: 'validation_error',
          subtype: 'max_retries_exceeded',
          message: 'Field failed validation',
          action: 'continue',
          handler: 'validation_error',
          field: 'email',
          agent: 'SupportAgent',
        },
      },
      {
        eventType: 'agent.profile.applied',
        data: {
          turnCount: 2,
          previousProfiles: [],
          activeProfiles: ['mobile_support'],
          toolsAdded: 1,
          toolsHidden: 0,
          hasVoiceOverride: false,
          agent: 'SupportAgent',
        },
      },
      {
        eventType: 'agent.voice.config_resolved',
        data: {
          provider: 'elevenlabs',
          voiceId: 'aria',
          source: 'agent_ir',
        },
      },
      {
        eventType: 'flow.action_handler.executed',
        data: {
          actionId: 'confirm_order',
          source: 'agent',
          hasSet: true,
          hasRespond: true,
          hasTransition: false,
          step: 'confirm',
          agent: 'SupportAgent',
        },
      },
    ];

    for (const { eventType, data } of examples) {
      const result = eventRegistry.validate({ event_type: eventType, data });
      expect(result.errors, eventType).toBeUndefined();
      expect(result.valid, eventType).toBe(true);
    }
  });
});
