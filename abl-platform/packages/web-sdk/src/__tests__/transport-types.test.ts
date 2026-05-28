/**
 * Transport Types Tests (UT-1)
 *
 * Verifies SDKTransport interface contract — mock implementation satisfies
 * the interface, TransportServerMessage union covers all 9 types.
 */

import { describe, test, expect, expectTypeOf, vi } from 'vitest';
import type {
  SDKTransport,
  TransportCapabilities,
  TransportClientMessage,
  TransportServerMessage,
  TransportError,
} from '../transport/types.js';

/**
 * A mock SDKTransport implementation that satisfies the interface.
 * This test verifies the interface is implementable and the types
 * constrain the message shapes correctly.
 */
class MockSDKTransport implements SDKTransport {
  capabilities: TransportCapabilities = {
    supportsThoughts: true,
    supportsHandoff: true,
    supportsFileUpload: false,
    supportsVoice: false,
  };

  private connected = false;
  private sessionId: string | null = null;
  private messageHandlers: Array<(msg: TransportServerMessage) => void> = [];
  sentMessages: TransportClientMessage[] = [];

  async connect(): Promise<void> {
    this.connected = true;
    this.sessionId = 'mock-session-1';
  }

  disconnect(): void {
    this.connected = false;
    this.sessionId = null;
  }

  isConnected(): boolean {
    return this.connected;
  }

  send(message: TransportClientMessage): void {
    this.sentMessages.push(message);
  }

  on(event: 'message', handler: (msg: TransportServerMessage) => void): () => void;
  on(event: 'connected', handler: () => void): () => void;
  on(event: 'disconnected', handler: (reason?: string) => void): () => void;
  on(event: 'error', handler: (error: TransportError) => void): () => void;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  on(event: string, handler: (...args: any[]) => void): () => void {
    if (event === 'message') {
      this.messageHandlers.push(handler as (msg: TransportServerMessage) => void);
    }
    return () => {
      if (event === 'message') {
        const idx = this.messageHandlers.indexOf(handler as (msg: TransportServerMessage) => void);
        if (idx >= 0) this.messageHandlers.splice(idx, 1);
      }
    };
  }

  getSessionId(): string | null {
    return this.sessionId;
  }

  // Test helper
  simulateMessage(msg: TransportServerMessage): void {
    for (const handler of this.messageHandlers) {
      handler(msg);
    }
  }
}

describe('SDKTransport interface contract', () => {
  test('mock implementation satisfies SDKTransport interface', async () => {
    const transport: SDKTransport = new MockSDKTransport();

    expect(transport.isConnected()).toBe(false);
    expect(transport.getSessionId()).toBeNull();

    await transport.connect();
    expect(transport.isConnected()).toBe(true);
    expect(transport.getSessionId()).toBe('mock-session-1');

    transport.disconnect();
    expect(transport.isConnected()).toBe(false);
  });

  test('capabilities are accessible', () => {
    const transport: SDKTransport = new MockSDKTransport();

    expect(transport.capabilities.supportsThoughts).toBe(true);
    expect(transport.capabilities.supportsHandoff).toBe(true);
    expect(transport.capabilities.supportsFileUpload).toBe(false);
    expect(transport.capabilities.supportsVoice).toBe(false);
  });

  test('send accepts all 4 TransportClientMessage variants', () => {
    const transport = new MockSDKTransport();

    transport.send({
      type: 'chat_message',
      text: 'Hello',
      messageId: 'msg-chat-1',
      metadata: { locale: 'en-US', context: { plan: 'pro' } },
    });
    transport.send({ type: 'action_submit', actionId: 'btn-1', value: 'yes' });
    transport.send({ type: 'auth_response', toolCallId: 'tc-1', status: 'completed' });
    transport.send({
      type: 'typed_interrupt',
      text: 'Quick note',
      messageId: 'msg-1',
      sessionId: 'sess-1',
    });

    expect(transport.sentMessages).toHaveLength(4);
    expect(transport.sentMessages[0].type).toBe('chat_message');
    expect(
      transport.sentMessages[0].type === 'chat_message'
        ? {
            messageId: transport.sentMessages[0].messageId,
            metadata: transport.sentMessages[0].metadata,
          }
        : undefined,
    ).toEqual({
      messageId: 'msg-chat-1',
      metadata: { locale: 'en-US', context: { plan: 'pro' } },
    });
    expect(transport.sentMessages[1].type).toBe('action_submit');
    expect(transport.sentMessages[2].type).toBe('auth_response');
    expect(transport.sentMessages[3].type).toBe('typed_interrupt');
  });

  test('on(message) handler receives TransportServerMessage and returns unsubscribe', () => {
    const transport = new MockSDKTransport();
    const handler = vi.fn();

    const unsubscribe = transport.on('message', handler);

    transport.simulateMessage({ type: 'response_start', messageId: 'msg-1' });
    expect(handler).toHaveBeenCalledTimes(1);

    unsubscribe();

    transport.simulateMessage({ type: 'response_start', messageId: 'msg-2' });
    expect(handler).toHaveBeenCalledTimes(1); // no additional call
  });
});

describe('TransportServerMessage union covers the transport-facing message variants', () => {
  test('response_start', () => {
    const msg: TransportServerMessage = { type: 'response_start', messageId: 'msg-1' };
    expect(msg.type).toBe('response_start');
  });

  test('response_chunk', () => {
    const msg: TransportServerMessage = {
      type: 'response_chunk',
      content: 'Hello',
      messageId: 'msg-1',
    };
    expect(msg.type).toBe('response_chunk');
  });

  test('response_end', () => {
    const msg: TransportServerMessage = {
      type: 'response_end',
      messageId: 'msg-1',
      content: 'Full text',
      sourceChannel: 'text',
      metadata: {
        isLlmGenerated: true,
        responseProvenance: {
          schemaVersion: 1,
          kind: 'llm',
          disclaimerRequired: true,
          usedLlmInternally: true,
        },
      },
    };
    expect(msg.type).toBe('response_end');
    if (msg.type === 'response_end') {
      expect(msg.content).toBe('Full text');
      expect(msg.sourceChannel).toBe('text');
      expect(msg.metadata?.responseProvenance?.kind).toBe('llm');
    }
  });

  test('thought', () => {
    const msg: TransportServerMessage = {
      type: 'thought',
      content: 'I think...',
      metadata: { toolName: 'search', agentName: 'assistant' },
    };
    expect(msg.type).toBe('thought');
  });

  test('handoff', () => {
    const msg: TransportServerMessage = {
      type: 'handoff',
      metadata: { handoffFrom: 'agent-a', handoffTo: 'agent-b' },
    };
    expect(msg.type).toBe('handoff');
  });

  test('error', () => {
    const msg: TransportServerMessage = {
      type: 'error',
      content: 'Something went wrong',
      metadata: { errorCode: 'TIMEOUT', severity: 'error' },
    };
    expect(msg.type).toBe('error');
  });

  test('auth_challenge with all 8 fields', () => {
    const msg: TransportServerMessage = {
      type: 'auth_challenge',
      sessionId: 'sess-1',
      toolCallId: 'tc-1',
      authType: 'oauth2',
      authUrl: 'https://auth.example.com',
      profileId: 'prof-1',
      profileName: 'Google',
      prompt: 'Please authorize',
      timeoutMs: 60000,
    };
    expect(msg.type).toBe('auth_challenge');
    if (msg.type === 'auth_challenge') {
      expect(msg.sessionId).toBe('sess-1');
      expect(msg.toolCallId).toBe('tc-1');
      expect(msg.authType).toBe('oauth2');
      expect(msg.authUrl).toBe('https://auth.example.com');
      expect(msg.profileId).toBe('prof-1');
      expect(msg.profileName).toBe('Google');
      expect(msg.prompt).toBe('Please authorize');
      expect(msg.timeoutMs).toBe(60000);
    }
  });

  test('status_update', () => {
    const msg: TransportServerMessage = {
      type: 'status_update',
      text: 'Searching...',
      operation: 'tool_call',
    };
    expect(msg.type).toBe('status_update');
  });

  test('status_clear', () => {
    const msg: TransportServerMessage = { type: 'status_clear' };
    expect(msg.type).toBe('status_clear');
  });

  test('omnichannel websocket messages stay on SessionManager, not TransportServerMessage', () => {
    type LiveSessionJoinedTransport = Extract<
      TransportServerMessage,
      { type: 'live_session_joined' }
    >;
    type TranscriptItemTransport = Extract<TransportServerMessage, { type: 'transcript_item' }>;

    expectTypeOf<LiveSessionJoinedTransport>().toBeNever();
    expectTypeOf<TranscriptItemTransport>().toBeNever();
  });
});

describe('TransportError interface', () => {
  test('has code, message, and recoverable fields', () => {
    const error: TransportError = {
      code: 'CONN_LOST',
      message: 'Connection lost',
      recoverable: true,
    };
    expect(error.code).toBe('CONN_LOST');
    expect(error.message).toBe('Connection lost');
    expect(error.recoverable).toBe(true);
  });
});
