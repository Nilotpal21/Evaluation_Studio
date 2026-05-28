/**
 * WebSocket Events Tests
 *
 * Covers parseClientMessage (all 13 message types + error cases),
 * serializeServerMessage, and all ServerMessages factory methods.
 */

import { describe, test, expect } from 'vitest';
import {
  parseClientMessage,
  serializeServerMessage,
  ServerMessages,
} from '../../websocket/events.js';

// =============================================================================
// parseClientMessage
// =============================================================================

describe('parseClientMessage', () => {
  // ---------------------------------------------------------------------------
  // Invalid inputs
  // ---------------------------------------------------------------------------

  describe('invalid inputs', () => {
    test('returns null for invalid JSON', () => {
      expect(parseClientMessage('not json')).toBeNull();
    });

    test('returns null for empty string', () => {
      expect(parseClientMessage('')).toBeNull();
    });

    test('returns null for missing type field', () => {
      expect(parseClientMessage(JSON.stringify({ sessionId: 's1' }))).toBeNull();
    });

    test('returns null for unknown message type', () => {
      expect(parseClientMessage(JSON.stringify({ type: 'unknown_type' }))).toBeNull();
    });

    test('returns null for application-level ping messages', () => {
      expect(parseClientMessage(JSON.stringify({ type: 'ping' }))).toBeNull();
    });

    test('returns null for null input parsed as JSON', () => {
      expect(parseClientMessage('null')).toBeNull();
    });

    test('returns null for array input', () => {
      expect(parseClientMessage('[]')).toBeNull();
    });
  });

  // ---------------------------------------------------------------------------
  // load_agent
  // ---------------------------------------------------------------------------

  describe('load_agent', () => {
    test('parses valid load_agent with required fields', () => {
      const msg = parseClientMessage(
        JSON.stringify({
          type: 'load_agent',
          agentPath: 'hotel-booking/booking_agent',
          projectId: 'proj_1',
        }),
      );
      expect(msg).toEqual({
        type: 'load_agent',
        agentPath: 'hotel-booking/booking_agent',
        projectId: 'proj_1',
        deploymentId: undefined,
        environment: undefined,
        versionId: undefined,
      });
    });

    test('parses load_agent with all optional fields', () => {
      const msg = parseClientMessage(
        JSON.stringify({
          type: 'load_agent',
          agentPath: 'domain/agent',
          projectId: 'proj_1',
          deploymentId: 'dep_1',
          environment: 'staging',
          versionId: 'v2',
        }),
      );
      expect(msg).toEqual({
        type: 'load_agent',
        agentPath: 'domain/agent',
        projectId: 'proj_1',
        deploymentId: 'dep_1',
        environment: 'staging',
        versionId: 'v2',
      });
    });

    test('returns null when agentPath is missing', () => {
      expect(
        parseClientMessage(JSON.stringify({ type: 'load_agent', projectId: 'proj_1' })),
      ).toBeNull();
    });

    test('returns null when projectId is missing', () => {
      expect(
        parseClientMessage(
          JSON.stringify({ type: 'load_agent', agentPath: 'hotel-booking/booking_agent' }),
        ),
      ).toBeNull();
    });

    test('returns null when agentPath is not a string', () => {
      expect(
        parseClientMessage(
          JSON.stringify({ type: 'load_agent', agentPath: 123, projectId: 'proj_1' }),
        ),
      ).toBeNull();
    });

    test('returns null when projectId is not a string', () => {
      expect(
        parseClientMessage(JSON.stringify({ type: 'load_agent', agentPath: 'a/b', projectId: 42 })),
      ).toBeNull();
    });

    test('ignores non-string optional fields when projectId is valid', () => {
      const msg = parseClientMessage(
        JSON.stringify({
          type: 'load_agent',
          agentPath: 'a/b',
          projectId: 'proj_1',
          deploymentId: true,
        }),
      );
      expect(msg!.type).toBe('load_agent');
      if (msg!.type === 'load_agent') {
        expect(msg!.projectId).toBe('proj_1');
        expect(msg!.deploymentId).toBeUndefined();
      }
    });
  });

  // ---------------------------------------------------------------------------
  // send_message
  // ---------------------------------------------------------------------------

  describe('send_message', () => {
    test('parses valid send_message', () => {
      const msg = parseClientMessage(
        JSON.stringify({
          type: 'send_message',
          sessionId: 'sess_1',
          text: 'Hello world',
        }),
      );
      expect(msg).toEqual({
        type: 'send_message',
        sessionId: 'sess_1',
        text: 'Hello world',
      });
    });

    test('returns null when sessionId is missing', () => {
      expect(parseClientMessage(JSON.stringify({ type: 'send_message', text: 'hi' }))).toBeNull();
    });

    test('returns null when text is missing', () => {
      expect(
        parseClientMessage(JSON.stringify({ type: 'send_message', sessionId: 's1' })),
      ).toBeNull();
    });

    test('returns null when sessionId is not a string', () => {
      expect(
        parseClientMessage(JSON.stringify({ type: 'send_message', sessionId: 123, text: 'hi' })),
      ).toBeNull();
    });
  });

  // ---------------------------------------------------------------------------
  // ensure_session_persisted
  // ---------------------------------------------------------------------------

  describe('ensure_session_persisted', () => {
    test('parses valid ensure_session_persisted', () => {
      const msg = parseClientMessage(
        JSON.stringify({
          type: 'ensure_session_persisted',
          sessionId: 'sess_1',
          requestId: 'req_1',
        }),
      );
      expect(msg).toEqual({
        type: 'ensure_session_persisted',
        sessionId: 'sess_1',
        requestId: 'req_1',
      });
    });

    test('returns null when requestId is missing', () => {
      expect(
        parseClientMessage(
          JSON.stringify({ type: 'ensure_session_persisted', sessionId: 'sess_1' }),
        ),
      ).toBeNull();
    });
  });

  // ---------------------------------------------------------------------------
  // run_test
  // ---------------------------------------------------------------------------

  describe('run_test', () => {
    test('parses valid run_test', () => {
      const msg = parseClientMessage(
        JSON.stringify({
          type: 'run_test',
          sessionId: 's1',
          testId: 't1',
        }),
      );
      expect(msg).toEqual({ type: 'run_test', sessionId: 's1', testId: 't1' });
    });

    test('returns null when testId is missing', () => {
      expect(parseClientMessage(JSON.stringify({ type: 'run_test', sessionId: 's1' }))).toBeNull();
    });

    test('returns null when sessionId is missing', () => {
      expect(parseClientMessage(JSON.stringify({ type: 'run_test', testId: 't1' }))).toBeNull();
    });
  });

  // ---------------------------------------------------------------------------
  // get_state
  // ---------------------------------------------------------------------------

  describe('get_state', () => {
    test('parses valid get_state', () => {
      const msg = parseClientMessage(JSON.stringify({ type: 'get_state', sessionId: 's1' }));
      expect(msg).toEqual({ type: 'get_state', sessionId: 's1' });
    });

    test('returns null when sessionId is missing', () => {
      expect(parseClientMessage(JSON.stringify({ type: 'get_state' }))).toBeNull();
    });
  });

  // ---------------------------------------------------------------------------
  // subscribe_session / unsubscribe_session
  // ---------------------------------------------------------------------------

  describe('subscribe_session', () => {
    test('parses valid subscribe_session', () => {
      const msg = parseClientMessage(
        JSON.stringify({ type: 'subscribe_session', sessionId: 's1' }),
      );
      expect(msg).toEqual({ type: 'subscribe_session', sessionId: 's1' });
    });

    test('returns null when sessionId is missing', () => {
      expect(parseClientMessage(JSON.stringify({ type: 'subscribe_session' }))).toBeNull();
    });
  });

  describe('unsubscribe_session', () => {
    test('parses valid unsubscribe_session', () => {
      const msg = parseClientMessage(
        JSON.stringify({ type: 'unsubscribe_session', sessionId: 's1' }),
      );
      expect(msg).toEqual({ type: 'unsubscribe_session', sessionId: 's1' });
    });

    test('returns null when sessionId is missing', () => {
      expect(parseClientMessage(JSON.stringify({ type: 'unsubscribe_session' }))).toBeNull();
    });
  });

  // ---------------------------------------------------------------------------
  // resume_session
  // ---------------------------------------------------------------------------

  describe('resume_session', () => {
    test('parses valid resume_session', () => {
      const msg = parseClientMessage(
        JSON.stringify({
          type: 'resume_session',
          sessionId: 's1',
          lastSeenTraceEventId: 'evt-99',
        }),
      );
      expect(msg).toEqual({
        type: 'resume_session',
        sessionId: 's1',
        lastSeenTraceEventId: 'evt-99',
      });
    });

    test('returns null when sessionId is missing', () => {
      expect(parseClientMessage(JSON.stringify({ type: 'resume_session' }))).toBeNull();
    });
  });

  // ---------------------------------------------------------------------------
  // list_sessions
  // ---------------------------------------------------------------------------

  describe('list_sessions', () => {
    test('parses valid list_sessions (no required fields)', () => {
      const msg = parseClientMessage(JSON.stringify({ type: 'list_sessions' }));
      expect(msg).toEqual({ type: 'list_sessions' });
    });
  });

  // ---------------------------------------------------------------------------
  // load_agent_with_context
  // ---------------------------------------------------------------------------

  describe('load_agent_with_context', () => {
    test('parses valid load_agent_with_context', () => {
      const msg = parseClientMessage(
        JSON.stringify({
          type: 'load_agent_with_context',
          agentPath: 'domain/agent',
          projectId: 'proj_1',
          context: { user: 'Alice' },
        }),
      );
      expect(msg).toEqual({
        type: 'load_agent_with_context',
        agentPath: 'domain/agent',
        projectId: 'proj_1',
        context: { user: 'Alice' },
      });
    });

    test('parses with projectId', () => {
      const msg = parseClientMessage(
        JSON.stringify({
          type: 'load_agent_with_context',
          agentPath: 'domain/agent',
          context: { key: 'val' },
          projectId: 'proj_1',
        }),
      );
      if (msg && msg.type === 'load_agent_with_context') {
        expect(msg.projectId).toBe('proj_1');
      }
    });

    test('returns null when agentPath is missing', () => {
      expect(
        parseClientMessage(
          JSON.stringify({
            type: 'load_agent_with_context',
            projectId: 'proj_1',
            context: { key: 'val' },
          }),
        ),
      ).toBeNull();
    });

    test('returns null when projectId is missing', () => {
      expect(
        parseClientMessage(
          JSON.stringify({
            type: 'load_agent_with_context',
            agentPath: 'a/b',
            context: { key: 'val' },
          }),
        ),
      ).toBeNull();
    });

    test('returns null when context is missing', () => {
      expect(
        parseClientMessage(
          JSON.stringify({
            type: 'load_agent_with_context',
            agentPath: 'a/b',
            projectId: 'proj_1',
          }),
        ),
      ).toBeNull();
    });

    test('returns null when context is not an object', () => {
      expect(
        parseClientMessage(
          JSON.stringify({
            type: 'load_agent_with_context',
            agentPath: 'a/b',
            projectId: 'proj_1',
            context: 'string',
          }),
        ),
      ).toBeNull();
    });
  });

  // ---------------------------------------------------------------------------
  // inject_context
  // ---------------------------------------------------------------------------

  describe('inject_context', () => {
    test('parses valid inject_context', () => {
      const msg = parseClientMessage(
        JSON.stringify({
          type: 'inject_context',
          sessionId: 's1',
          injection: { key: 'val' },
        }),
      );
      expect(msg).toEqual({
        type: 'inject_context',
        sessionId: 's1',
        injection: { key: 'val' },
      });
    });

    test('returns null when injection is missing', () => {
      expect(
        parseClientMessage(
          JSON.stringify({
            type: 'inject_context',
            sessionId: 's1',
          }),
        ),
      ).toBeNull();
    });

    test('returns null when injection is not an object', () => {
      expect(
        parseClientMessage(
          JSON.stringify({
            type: 'inject_context',
            sessionId: 's1',
            injection: 'not an object',
          }),
        ),
      ).toBeNull();
    });
  });

  // ---------------------------------------------------------------------------
  // set_tool_mocks
  // ---------------------------------------------------------------------------

  describe('set_tool_mocks', () => {
    test('parses valid set_tool_mocks', () => {
      const mocks = [{ name: 'search', response: { results: [] } }];
      const msg = parseClientMessage(
        JSON.stringify({
          type: 'set_tool_mocks',
          sessionId: 's1',
          mocks,
        }),
      );
      expect(msg).toEqual({ type: 'set_tool_mocks', sessionId: 's1', mocks });
    });

    test('returns null when mocks is not an array', () => {
      expect(
        parseClientMessage(
          JSON.stringify({
            type: 'set_tool_mocks',
            sessionId: 's1',
            mocks: 'not array',
          }),
        ),
      ).toBeNull();
    });

    test('returns null when sessionId is missing', () => {
      expect(
        parseClientMessage(
          JSON.stringify({
            type: 'set_tool_mocks',
            mocks: [],
          }),
        ),
      ).toBeNull();
    });
  });

  // ---------------------------------------------------------------------------
  // clear_tool_mocks
  // ---------------------------------------------------------------------------

  describe('clear_tool_mocks', () => {
    test('parses valid clear_tool_mocks', () => {
      const msg = parseClientMessage(JSON.stringify({ type: 'clear_tool_mocks', sessionId: 's1' }));
      expect(msg).toEqual({ type: 'clear_tool_mocks', sessionId: 's1' });
    });

    test('returns null when sessionId is missing', () => {
      expect(parseClientMessage(JSON.stringify({ type: 'clear_tool_mocks' }))).toBeNull();
    });
  });

  // ---------------------------------------------------------------------------
  // consent_satisfy
  // ---------------------------------------------------------------------------

  describe('consent_satisfy', () => {
    test('parses valid consent_satisfy with requirementKey', () => {
      const msg = parseClientMessage(
        JSON.stringify({
          type: 'consent_satisfy',
          sessionId: 's1',
          authProfileRef: 'google-creds',
          requirementKey: 'profile:123|mode:per_user',
        }),
      );
      expect(msg).toEqual({
        type: 'consent_satisfy',
        sessionId: 's1',
        authProfileRef: 'google-creds',
        requirementKey: 'profile:123|mode:per_user',
      });
    });

    test('parses valid consent_satisfy without requirementKey', () => {
      const msg = parseClientMessage(
        JSON.stringify({
          type: 'consent_satisfy',
          sessionId: 's1',
          authProfileRef: 'google-creds',
        }),
      );
      expect(msg).toEqual({
        type: 'consent_satisfy',
        sessionId: 's1',
        authProfileRef: 'google-creds',
      });
    });

    test('returns null when authProfileRef is missing', () => {
      expect(
        parseClientMessage(
          JSON.stringify({
            type: 'consent_satisfy',
            sessionId: 's1',
          }),
        ),
      ).toBeNull();
    });
  });
});

// =============================================================================
// serializeServerMessage
// =============================================================================

describe('serializeServerMessage', () => {
  test('serializes a message to JSON string', () => {
    const msg = { type: 'error' as const, message: 'Something went wrong' };
    const serialized = serializeServerMessage(msg);
    expect(JSON.parse(serialized)).toEqual(msg);
  });

  test('round-trips complex messages', () => {
    const msg = ServerMessages.responseEnd('s1', 'm1', 'Full text response');
    const serialized = serializeServerMessage(msg);
    const parsed = JSON.parse(serialized);
    expect(parsed.type).toBe('response_end');
    expect(parsed.sessionId).toBe('s1');
    expect(parsed.fullText).toBe('Full text response');
  });
});

// =============================================================================
// ServerMessages factory methods
// =============================================================================

describe('ServerMessages', () => {
  test('agentLoaded creates correct message', () => {
    const agent = { name: 'TestAgent', mode: 'scripted' } as any;
    const msg = ServerMessages.agentLoaded('s1', agent);
    expect(msg).toEqual({ type: 'agent_loaded', sessionId: 's1', agent });
  });

  test('agentLoadError creates correct message', () => {
    const msg = ServerMessages.agentLoadError('Agent not found');
    expect(msg).toEqual({ type: 'agent_load_error', error: 'Agent not found' });
  });

  test('responseStart creates correct message', () => {
    const msg = ServerMessages.responseStart('s1', 'm1');
    expect(msg).toEqual({ type: 'response_start', sessionId: 's1', messageId: 'm1' });
  });

  test('responseStart includes executionId when provided', () => {
    const msg = ServerMessages.responseStart('s1', 'm1', 'exec-1');
    expect(msg).toEqual({
      type: 'response_start',
      sessionId: 's1',
      messageId: 'm1',
      executionId: 'exec-1',
    });
  });

  test('responseChunk creates correct message', () => {
    const msg = ServerMessages.responseChunk('s1', 'm1', 'Hello');
    expect(msg).toEqual({
      type: 'response_chunk',
      sessionId: 's1',
      messageId: 'm1',
      chunk: 'Hello',
    });
  });

  test('responseEnd creates correct message with required fields', () => {
    const msg = ServerMessages.responseEnd('s1', 'm1', 'Full response text');
    expect(msg.type).toBe('response_end');
    if (msg.type === 'response_end') {
      expect(msg.sessionId).toBe('s1');
      expect(msg.messageId).toBe('m1');
      expect(msg.fullText).toBe('Full response text');
      expect(msg.voiceConfig).toBeUndefined();
      expect(msg.richContent).toBeUndefined();
      expect(msg.actions).toBeUndefined();
    }
  });

  test('responseEnd includes executionId when provided', () => {
    const msg = ServerMessages.responseEnd(
      's1',
      'm1',
      'Full response text',
      undefined,
      undefined,
      undefined,
      'exec-1',
    );
    expect(msg.type).toBe('response_end');
    if (msg.type === 'response_end') {
      expect(msg.executionId).toBe('exec-1');
    }
  });

  test('statusUpdate includes executionId when provided', () => {
    const msg = ServerMessages.statusUpdate('s1', 'Thinking', 'llm', 1, 'exec-1');
    expect(msg).toEqual({
      type: 'status_update',
      sessionId: 's1',
      text: 'Thinking',
      operation: 'llm',
      transient: true,
      index: 1,
      executionId: 'exec-1',
    });
  });

  test('responseEnd includes optional voiceConfig, richContent, actions, localization', () => {
    const voice = { model: 'voice-1' } as any;
    const rich = { type: 'card', title: 'Test' } as any;
    const actions = { buttons: [] } as any;
    const localization = {
      domain: 'project' as const,
      locale: 'en-US',
      messageKey: 'assistant.card',
      catalogId: 'catalog-v1',
    };
    const msg = ServerMessages.responseEnd(
      's1',
      'm1',
      'text',
      voice,
      rich,
      actions,
      undefined,
      undefined,
      localization,
    );
    if (msg.type === 'response_end') {
      expect(msg.voiceConfig).toEqual(voice);
      expect(msg.richContent).toEqual(rich);
      expect(msg.actions).toEqual(actions);
      expect(msg.localization).toEqual(localization);
    }
  });

  test('responseEnd includes metadata when provided', () => {
    const metadata = {
      isLlmGenerated: true,
      responseProvenance: {
        schemaVersion: 1,
        kind: 'llm',
        disclaimerRequired: true,
        usedLlmInternally: true,
      },
    };
    const msg = ServerMessages.responseEnd(
      's1',
      'm1',
      'text',
      undefined,
      undefined,
      undefined,
      'exec-1',
      metadata,
    );
    if (msg.type === 'response_end') {
      expect(msg.executionId).toBe('exec-1');
      expect(msg.metadata).toEqual(metadata);
    }
  });

  test('traceEvent creates correct message', () => {
    const event = { id: 'e1', type: 'tool_call', data: {} } as any;
    const msg = ServerMessages.traceEvent('s1', event);
    expect(msg).toEqual({ type: 'trace_event', sessionId: 's1', event });
  });

  test('stateUpdate creates correct message', () => {
    const state = { step: 'ask', values: {} } as any;
    const updates = { step: 'done' } as any;
    const msg = ServerMessages.stateUpdate('s1', state, updates);
    expect(msg).toEqual({ type: 'state_update', sessionId: 's1', state, updates });
  });

  test('actionTaken creates correct message', () => {
    const action = { type: 'complete' } as any;
    const msg = ServerMessages.actionTaken('s1', action);
    expect(msg).toEqual({ type: 'action_taken', sessionId: 's1', action });
  });

  test('sessionPersisted creates correct message', () => {
    const msg = ServerMessages.sessionPersisted('s1', 'req-1', true);
    expect(msg).toEqual({
      type: 'session_persisted',
      sessionId: 's1',
      requestId: 'req-1',
      persisted: true,
    });
  });

  test('sessionPersistFailed creates correct message', () => {
    const error = { code: 'SESSION_NOT_FOUND', message: 'Session not found' };
    const msg = ServerMessages.sessionPersistFailed('s1', 'req-1', error);
    expect(msg).toEqual({
      type: 'session_persist_failed',
      sessionId: 's1',
      requestId: 'req-1',
      error,
    });
  });

  test('error creates correct message', () => {
    const msg = ServerMessages.error('Something failed');
    expect(msg).toEqual({ type: 'error', message: 'Something failed' });
  });

  test('info creates correct message', () => {
    const msg = ServerMessages.info('Connected', true);
    expect(msg).toEqual({ type: 'info', message: 'Connected', configured: true });
  });

  test('sessionResumed creates correct message', () => {
    const state = { step: 'ask' } as any;
    const history = [{ role: 'user', content: 'hi' }];
    const agent = {
      id: 'agent-1',
      name: 'Agent 1',
      type: 'agent' as const,
      mode: 'reasoning' as const,
      toolCount: 0,
      gatherFieldCount: 0,
      isSupervisor: false,
      dsl: '',
    };
    const msg = ServerMessages.sessionResumed('s1', state, history, agent);
    expect(msg).toEqual({
      type: 'session_resumed',
      sessionId: 's1',
      state,
      conversationHistory: history,
      agent,
    });
  });

  test('contextInjected creates correct message', () => {
    const msg = ServerMessages.contextInjected('s1', { key: 'val' });
    expect(msg).toEqual({
      type: 'context_injected',
      sessionId: 's1',
      updatedValues: { key: 'val' },
    });
  });

  test('toolMockSet creates correct message', () => {
    const msg = ServerMessages.toolMockSet('s1', 3);
    expect(msg).toEqual({ type: 'tool_mock_set', sessionId: 's1', mockCount: 3 });
  });

  test('contextInjectionError creates correct message', () => {
    const error = { code: 'INVALID_FIELD', message: 'Field not found' };
    const msg = ServerMessages.contextInjectionError('s1', error);
    expect(msg).toEqual({ type: 'context_injection_error', sessionId: 's1', error });
  });
});
