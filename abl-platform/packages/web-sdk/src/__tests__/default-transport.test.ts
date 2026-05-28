/**
 * DefaultTransport Tests (INT-1)
 *
 * Tests DefaultTransport delegates to MockSessionManager.
 * Verifies event translation: WSServerMessage → TransportServerMessage.
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';
import { DefaultTransport } from '../transport/DefaultTransport.js';
import { TypedEventEmitter } from '../core/EventEmitter.js';
import type { WSServerMessage } from '../core/types.js';
import type { TransportServerMessage, TransportError } from '../transport/types.js';

/**
 * Mock SessionManager for DefaultTransport testing.
 */
class MockSessionManager extends TypedEventEmitter<{
  connected: void;
  disconnected: void;
  message: WSServerMessage;
  error: { error: Error };
}> {
  private connected = false;
  private sessionId: string | null = null;
  private showActivityUpdates = true;
  connectCalled = false;
  disconnectCalled = false;
  sentMessages: unknown[] = [];

  async connect(): Promise<void> {
    this.connectCalled = true;
    this.connected = true;
    this.sessionId = 'test-session-dt';
    this.emit('connected', undefined);
  }

  disconnect(): void {
    this.disconnectCalled = true;
    this.connected = false;
    this.sessionId = null;
  }

  isConnected(): boolean {
    return this.connected;
  }

  getSessionId(): string | null {
    return this.sessionId;
  }

  getScope(): { showActivityUpdates: boolean } {
    return { showActivityUpdates: this.showActivityUpdates };
  }

  setShowActivityUpdates(value: boolean): void {
    this.showActivityUpdates = value;
  }

  send(msg: unknown): void {
    this.sentMessages.push(msg);
  }

  // Test helper to simulate a raw WS message
  simulateMessage(message: WSServerMessage): void {
    this.emit('message', message);
  }

  simulateError(error: Error): void {
    this.emit('error', { error });
  }

  simulateDisconnected(): void {
    this.emit('disconnected', undefined);
  }
}

describe('DefaultTransport delegation', () => {
  let sm: MockSessionManager;
  let transport: DefaultTransport;

  beforeEach(() => {
    sm = new MockSessionManager();
    transport = new DefaultTransport(sm as any);
  });

  test('connect() delegates to sessionManager.connect()', async () => {
    await transport.connect();
    expect(sm.connectCalled).toBe(true);
  });

  test('disconnect() delegates to sessionManager.disconnect()', () => {
    transport.disconnect();
    expect(sm.disconnectCalled).toBe(true);
  });

  test('isConnected() delegates to sessionManager.isConnected()', async () => {
    expect(transport.isConnected()).toBe(false);
    await sm.connect();
    expect(transport.isConnected()).toBe(true);
  });

  test('getSessionId() delegates to sessionManager.getSessionId()', async () => {
    expect(transport.getSessionId()).toBeNull();
    await sm.connect();
    expect(transport.getSessionId()).toBe('test-session-dt');
  });

  test('send() delegates to sessionManager.send() with spread message', () => {
    transport.send({ type: 'chat_message', text: 'Hello' });
    expect(sm.sentMessages).toHaveLength(1);
    expect(sm.sentMessages[0]).toEqual({ type: 'chat_message', text: 'Hello' });
  });

  test('capabilities are all true for default transport', () => {
    expect(transport.capabilities).toEqual({
      supportsThoughts: true,
      supportsHandoff: true,
      supportsFileUpload: true,
      supportsVoice: true,
    });
  });
});

describe('DefaultTransport lifecycle event translation', () => {
  let sm: MockSessionManager;
  let transport: DefaultTransport;

  beforeEach(() => {
    sm = new MockSessionManager();
    transport = new DefaultTransport(sm as any);
  });

  test('SessionManager connected → transport connected event', () => {
    const handler = vi.fn();
    transport.on('connected', handler);

    sm.emit('connected', undefined);

    expect(handler).toHaveBeenCalledTimes(1);
  });

  test('SessionManager disconnected → transport disconnected event', () => {
    const handler = vi.fn();
    transport.on('disconnected', handler);

    sm.simulateDisconnected();

    expect(handler).toHaveBeenCalledTimes(1);
  });

  test('SessionManager error → transport error event', () => {
    const handler = vi.fn<(err: TransportError) => void>();
    transport.on('error', handler);

    sm.simulateError(new Error('WebSocket error'));

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith({
      code: 'SESSION_ERROR',
      message: 'WebSocket error',
      recoverable: true,
    });
  });
});

describe('DefaultTransport message translation', () => {
  let sm: MockSessionManager;
  let transport: DefaultTransport;
  let received: TransportServerMessage[];

  beforeEach(() => {
    sm = new MockSessionManager();
    transport = new DefaultTransport(sm as any);
    received = [];
    transport.on('message', (msg) => received.push(msg));
  });

  test('response_start translates messageId', () => {
    sm.simulateMessage({ type: 'response_start', messageId: 'msg-1' });

    expect(received).toHaveLength(1);
    expect(received[0]).toEqual({ type: 'response_start', messageId: 'msg-1' });
  });

  test('response_chunk translates chunk → content', () => {
    sm.simulateMessage({ type: 'response_chunk', chunk: 'Hello ', messageId: 'msg-1' });

    expect(received).toHaveLength(1);
    expect(received[0]).toEqual({
      type: 'response_chunk',
      content: 'Hello ',
      messageId: 'msg-1',
    });
  });

  test('response_end translates fullText → content', () => {
    sm.simulateMessage({
      type: 'response_end',
      messageId: 'msg-1',
      fullText: 'Hello world',
      voiceConfig: { plain_text: 'Hello world for voice' },
      richContent: { markdown: '**bold**' },
      sourceChannel: 'text',
    });

    expect(received).toHaveLength(1);
    const msg = received[0];
    expect(msg.type).toBe('response_end');
    if (msg.type === 'response_end') {
      expect(msg.content).toBe('Hello world');
      expect(msg.messageId).toBe('msg-1');
      expect(msg.voiceConfig).toEqual({
        plain_text: 'Hello world for voice',
        plainText: 'Hello world for voice',
      });
      expect(msg.richContent).toEqual({ markdown: '**bold**' });
      expect(msg.sourceChannel).toBe('text');
    }
  });

  test('response_end falls back to text when fullText is missing', () => {
    sm.simulateMessage({
      type: 'response_end',
      messageId: 'msg-2',
      text: 'Fallback text',
    });

    expect(received).toHaveLength(1);
    if (received[0].type === 'response_end') {
      expect(received[0].content).toBe('Fallback text');
    }
  });

  test('response_end preserves contentEnvelope and normalizes legacy SDK-visible fields', () => {
    sm.simulateMessage({
      type: 'response_end',
      messageId: 'msg-envelope',
      contentEnvelope: {
        version: 'assistant.contentEnvelope/v2',
        text: 'Envelope text',
        richContent: {
          type: 'card',
          title: 'Envelope card',
          body: 'Rendered from the content envelope.',
        },
        actions: [{ id: 'open', label: 'Open', payload: { id: '123' } }],
        voiceConfig: { plainText: 'Envelope voice text' },
        localization: { locale: 'en-US' },
        metadata: { source: 'transport-test' },
      },
    });

    expect(received).toHaveLength(1);
    const msg = received[0];
    expect(msg.type).toBe('response_end');
    if (msg.type === 'response_end') {
      expect(msg.content).toBe('Envelope text');
      expect(msg.contentEnvelope?.version).toBe('assistant.contentEnvelope/v2');
      expect(msg.richContent?.markdown).toContain('Envelope card');
      expect(msg.actions?.elements[0]).toEqual({
        id: 'open',
        type: 'button',
        label: 'Open',
        value: JSON.stringify({ id: '123' }),
      });
      expect(msg.voiceConfig?.plain_text).toBe('Envelope voice text');
      expect(msg.metadata?.localization).toEqual({ locale: 'en-US' });
    }
  });

  test('response_end preserves top-level localization in metadata and contentEnvelope', () => {
    const localization = {
      locale: 'en-US',
      source: 'template',
      bundleId: 'support-responses',
    };

    sm.simulateMessage({
      type: 'response_end',
      messageId: 'msg-localized',
      fullText: 'Localized answer',
      metadata: { traceIds: ['trace-1'] },
      localization,
    });

    expect(received).toHaveLength(1);
    const msg = received[0];
    expect(msg.type).toBe('response_end');
    if (msg.type === 'response_end') {
      expect(msg.content).toBe('Localized answer');
      expect(msg.localization).toEqual(localization);
      expect(msg.contentEnvelope?.localization).toEqual(localization);
      expect(msg.metadata).toEqual({
        traceIds: ['trace-1'],
        localization,
      });
    }
  });

  test('response_end preserves canonical select and input action fields', () => {
    sm.simulateMessage({
      type: 'response_end',
      messageId: 'msg-actions',
      fullText: 'Choose a city',
      actions: {
        elements: [
          {
            id: 'city',
            type: 'select',
            label: 'City',
            description: 'Pick a destination',
            options: [{ id: 'nyc', label: 'NYC', description: 'New York' }],
            required: true,
          },
          {
            id: 'email',
            type: 'input',
            label: 'Email',
            input_type: 'email',
            placeholder: 'you@example.com',
            required: true,
          },
        ],
        submit_label: 'Submit',
        submit_id: 'submit-form',
      },
    });

    expect(received).toHaveLength(1);
    const msg = received[0];
    expect(msg.type).toBe('response_end');
    if (msg.type === 'response_end') {
      expect(msg.actions).toEqual({
        elements: [
          {
            id: 'city',
            type: 'select',
            label: 'City',
            description: 'Pick a destination',
            options: [{ id: 'nyc', label: 'NYC', description: 'New York' }],
            required: true,
          },
          {
            id: 'email',
            type: 'input',
            label: 'Email',
            input_type: 'email',
            placeholder: 'you@example.com',
            required: true,
          },
        ],
        submit_label: 'Submit',
        submit_id: 'submit-form',
      });
    }
  });

  test('auth_challenge maps all contract fields', () => {
    sm.simulateMessage({
      type: 'auth_challenge',
      code: 'AUTH_JIT_REQUIRED',
      sessionId: 'sess-1',
      toolCallId: 'tc-1',
      authType: 'oauth2',
      authUrl: 'https://auth.example.com',
      profileId: 'prof-1',
      profileName: 'Google',
      prompt: 'Authorize',
      timeoutMs: 60000,
    });

    expect(received).toHaveLength(1);
    const msg = received[0];
    if (msg.type === 'auth_challenge') {
      expect(msg.code).toBe('AUTH_JIT_REQUIRED');
      expect(msg.sessionId).toBe('sess-1');
      expect(msg.toolCallId).toBe('tc-1');
      expect(msg.authType).toBe('oauth2');
      expect(msg.authUrl).toBe('https://auth.example.com');
      expect(msg.profileId).toBe('prof-1');
      expect(msg.profileName).toBe('Google');
      expect(msg.prompt).toBe('Authorize');
      expect(msg.timeoutMs).toBe(60000);
    }
  });

  test('error translates error field → content', () => {
    sm.simulateMessage({
      type: 'error',
      error: 'Something broke',
    });

    expect(received).toHaveLength(1);
    if (received[0].type === 'error') {
      expect(received[0].content).toBe('Something broke');
      expect(received[0].metadata.severity).toBe('error');
    }
  });

  test('status_update maps text and operation', () => {
    sm.simulateMessage({
      type: 'status_update',
      text: 'Searching...',
      operation: 'tool_call',
    });

    expect(received).toHaveLength(1);
    expect(received[0]).toEqual({
      type: 'status_update',
      text: 'Searching...',
      operation: 'tool_call',
    });
  });

  test('suppresses activity messages when the session scope disables them', () => {
    sm.setShowActivityUpdates(false);

    sm.simulateMessage({
      type: 'thought',
      thought: 'I should search for this',
      toolName: 'search',
      agentName: 'helper',
    });
    sm.simulateMessage({
      type: 'status_update',
      text: 'Searching...',
      operation: 'tool_call',
    });

    expect(received).toHaveLength(0);
  });

  test('status_clear passes through', () => {
    sm.simulateMessage({ type: 'status_clear' });

    expect(received).toHaveLength(1);
    expect(received[0]).toEqual({ type: 'status_clear' });
  });

  test('tool_warnings translates warning list', () => {
    sm.simulateMessage({
      type: 'tool_warnings',
      sessionId: 'sess-1',
      warnings: ['Slack token missing', 'CRM connector offline'],
    });

    expect(received).toHaveLength(1);
    expect(received[0]).toEqual({
      type: 'tool_warnings',
      sessionId: 'sess-1',
      warnings: ['Slack token missing', 'CRM connector offline'],
    });
  });

  test('session_health translates health entries', () => {
    sm.simulateMessage({
      type: 'session_health',
      sessionId: 'sess-1',
      health: [
        {
          category: 'llm',
          severity: 'error',
          code: 'LLM_WIRING_FAILED',
          message: 'No model available',
        },
      ],
    });

    expect(received).toHaveLength(1);
    expect(received[0]).toEqual({
      type: 'session_health',
      sessionId: 'sess-1',
      health: [
        {
          category: 'llm',
          severity: 'error',
          code: 'LLM_WIRING_FAILED',
          message: 'No model available',
        },
      ],
    });
  });

  test('auth_required translates pending/satisfied requirements', () => {
    sm.simulateMessage({
      type: 'auth_required',
      code: 'AUTH_PREFLIGHT_REQUIRED',
      sessionId: 'sess-1',
      pending: [
        {
          connector: 'google_drive',
          authProfileRef: 'Google Drive',
          connectionMode: 'per_user',
        },
      ],
      satisfied: [],
    });

    expect(received).toHaveLength(1);
    expect(received[0]).toEqual({
      type: 'auth_required',
      code: 'AUTH_PREFLIGHT_REQUIRED',
      sessionId: 'sess-1',
      pending: [
        {
          connector: 'google_drive',
          authProfileRef: 'Google Drive',
          connectionMode: 'per_user',
        },
      ],
      satisfied: [],
    });
  });

  test('message_queued translates queue reason', () => {
    sm.simulateMessage({
      type: 'message_queued',
      code: 'AUTH_PREFLIGHT_REQUIRED',
      sessionId: 'sess-1',
      reason: 'auth_gate_active',
    });

    expect(received).toHaveLength(1);
    expect(received[0]).toEqual({
      type: 'message_queued',
      code: 'AUTH_PREFLIGHT_REQUIRED',
      sessionId: 'sess-1',
      reason: 'auth_gate_active',
    });
  });

  test('thought translates content and metadata', () => {
    sm.simulateMessage({
      type: 'thought',
      thought: 'I should search for this',
      toolName: 'search',
      agent: 'main-assistant',
    });

    expect(received).toHaveLength(1);
    if (received[0].type === 'thought') {
      expect(received[0].content).toBe('I should search for this');
      expect(received[0].metadata.toolName).toBe('search');
      expect(received[0].metadata.agentName).toBe('main-assistant');
    }
  });

  test('nested trace_event tool_thought translates to thought with traceIds', () => {
    sm.simulateMessage({
      type: 'trace_event',
      sessionId: 'sess-1',
      event: {
        id: 'trace-1',
        type: 'tool_thought',
        data: {
          thought: 'I should search for this',
          toolName: 'search',
          agentName: 'main-assistant',
        },
      },
    });

    expect(received).toHaveLength(1);
    if (received[0].type === 'thought') {
      expect(received[0].content).toBe('I should search for this');
      expect(received[0].metadata.toolName).toBe('search');
      expect(received[0].metadata.agentName).toBe('main-assistant');
      expect(received[0].metadata.traceIds).toEqual(['trace-1']);
    }
  });

  test('flattened legacy trace_event tool_thought still translates to thought', () => {
    sm.simulateMessage({
      type: 'trace_event',
      sessionId: 'sess-1',
      eventType: 'tool_thought',
      id: 'trace-legacy-1',
      thought: 'Legacy thought payload',
      toolName: 'search',
      agentName: 'main-assistant',
    });

    expect(received).toHaveLength(1);
    if (received[0].type === 'thought') {
      expect(received[0].content).toBe('Legacy thought payload');
      expect(received[0].metadata.toolName).toBe('search');
      expect(received[0].metadata.agentName).toBe('main-assistant');
      expect(received[0].metadata.traceIds).toEqual(['trace-legacy-1']);
    }
  });

  test('handoff translates from/to agents', () => {
    sm.simulateMessage({
      type: 'handoff',
      fromAgent: 'triage',
      toAgent: 'specialist',
    });

    expect(received).toHaveLength(1);
    if (received[0].type === 'handoff') {
      expect(received[0].metadata.handoffFrom).toBe('triage');
      expect(received[0].metadata.handoffTo).toBe('specialist');
    }
  });

  test('nested trace_event handoff translates metadata and traceIds', () => {
    sm.simulateMessage({
      type: 'trace_event',
      sessionId: 'sess-1',
      event: {
        id: 'trace-2',
        type: 'handoff',
        data: {
          from: 'triage',
          to: 'specialist',
        },
      },
    });

    expect(received).toHaveLength(1);
    if (received[0].type === 'handoff') {
      expect(received[0].metadata.handoffFrom).toBe('triage');
      expect(received[0].metadata.handoffTo).toBe('specialist');
      expect(received[0].metadata.traceIds).toEqual(['trace-2']);
    }
  });

  test('flattened legacy trace_event handoff still translates metadata', () => {
    sm.simulateMessage({
      type: 'trace_event',
      sessionId: 'sess-1',
      eventType: 'handoff',
      id: 'trace-legacy-2',
      from: 'triage',
      to: 'specialist',
    });

    expect(received).toHaveLength(1);
    if (received[0].type === 'handoff') {
      expect(received[0].metadata.handoffFrom).toBe('triage');
      expect(received[0].metadata.handoffTo).toBe('specialist');
      expect(received[0].metadata.traceIds).toEqual(['trace-legacy-2']);
    }
  });

  test('nested trace_event error translates content and traceIds', () => {
    sm.simulateMessage({
      type: 'trace_event',
      sessionId: 'sess-1',
      event: {
        id: 'trace-3',
        type: 'error',
        data: {
          message: 'Tool execution failed',
          code: 'TOOL_FAILURE',
        },
      },
    });

    expect(received).toHaveLength(1);
    if (received[0].type === 'error') {
      expect(received[0].content).toBe('Tool execution failed');
      expect(received[0].metadata.errorCode).toBe('TOOL_FAILURE');
      expect(received[0].metadata.traceIds).toEqual(['trace-3']);
    }
  });

  test('flattened legacy trace_event error still translates content', () => {
    sm.simulateMessage({
      type: 'trace_event',
      sessionId: 'sess-1',
      eventType: 'error',
      id: 'trace-legacy-3',
      message: 'Legacy tool failure',
      code: 'TOOL_FAILURE',
    });

    expect(received).toHaveLength(1);
    if (received[0].type === 'error') {
      expect(received[0].content).toBe('Legacy tool failure');
      expect(received[0].metadata.errorCode).toBe('TOOL_FAILURE');
      expect(received[0].metadata.traceIds).toEqual(['trace-legacy-3']);
    }
  });

  test('nested trace_event status_update translates text and operation', () => {
    sm.simulateMessage({
      type: 'trace_event',
      sessionId: 'sess-1',
      event: {
        id: 'trace-4',
        type: 'status_update',
        data: {
          text: 'Searching...',
          operation: 'tool_call',
        },
      },
    });

    expect(received).toHaveLength(1);
    expect(received[0]).toEqual({
      type: 'status_update',
      text: 'Searching...',
      operation: 'tool_call',
    });
  });

  test('nested trace_event status_clear translates to status_clear', () => {
    sm.simulateMessage({
      type: 'trace_event',
      sessionId: 'sess-1',
      event: {
        id: 'trace-5',
        type: 'status_clear',
      },
    });

    expect(received).toHaveLength(1);
    expect(received[0]).toEqual({ type: 'status_clear' });
  });

  test('flattened legacy trace_event status_update still translates text and operation', () => {
    sm.simulateMessage({
      type: 'trace_event',
      sessionId: 'sess-1',
      eventType: 'status_update',
      id: 'trace-legacy-4',
      text: 'Searching...',
      operation: 'tool_call',
    });

    expect(received).toHaveLength(1);
    expect(received[0]).toEqual({
      type: 'status_update',
      text: 'Searching...',
      operation: 'tool_call',
    });
  });

  test('flattened legacy trace_event status_clear still translates to status_clear', () => {
    sm.simulateMessage({
      type: 'trace_event',
      sessionId: 'sess-1',
      eventType: 'status_clear',
      id: 'trace-legacy-5',
    });

    expect(received).toHaveLength(1);
    expect(received[0]).toEqual({ type: 'status_clear' });
  });

  test('unknown and internal message types are silently ignored', () => {
    sm.simulateMessage({ type: 'unknown_type' });
    sm.simulateMessage({ type: 'session_start', sessionId: 'x' });

    expect(received).toHaveLength(0);
  });

  test('on() returns unsubscribe function', () => {
    const handler = vi.fn();
    const unsubscribe = transport.on('message', handler);

    sm.simulateMessage({ type: 'status_clear' });
    expect(handler).toHaveBeenCalledTimes(1);

    unsubscribe();

    sm.simulateMessage({ type: 'status_clear' });
    expect(handler).toHaveBeenCalledTimes(1); // no additional call
  });
});
