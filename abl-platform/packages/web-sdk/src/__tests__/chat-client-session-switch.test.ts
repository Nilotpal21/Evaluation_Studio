/**
 * Regression coverage for ChatClient session boundaries in transport mode.
 *
 * Studio session switches now preserve the transport connection and replace
 * history through ChatClient.replaceTranscript(). Real transport disconnects
 * still clear session-scoped UI state.
 */

import { describe, test, expect } from 'vitest';
import { ChatClient } from '../chat/ChatClient.js';
import { TypedEventEmitter } from '../core/EventEmitter.js';
import type {
  TransportServerMessage,
  TransportClientMessage,
  TransportError,
} from '../transport/types.js';

/**
 * MockTransport that exposes simulateDisconnect() and simulateConnect()
 * to mimic the session-switch lifecycle in useStudioTransport.
 *
 * This is a mock of the SDKTransport INTERFACE (the external boundary),
 * NOT a platform component. ChatClient is the real component under test.
 */
class MockTransport extends TypedEventEmitter<{
  message: TransportServerMessage;
  connected: void;
  disconnected: string | undefined;
  error: TransportError;
}> {
  private connected = true;
  private sessionId: string | null = 'session-1';
  capabilities = {
    supportsThoughts: true,
    supportsHandoff: true,
    supportsFileUpload: true,
    supportsVoice: true,
  };
  sentMessages: TransportClientMessage[] = [];

  isConnected(): boolean {
    return this.connected;
  }

  getSessionId(): string | null {
    return this.sessionId;
  }

  setSessionId(id: string | null): void {
    this.sessionId = id;
  }

  connect(): Promise<void> {
    this.connected = true;
    return Promise.resolve();
  }

  disconnect(): void {
    this.connected = false;
  }

  send(msg: TransportClientMessage): void {
    this.sentMessages.push(msg);
  }

  simulateMessage(message: TransportServerMessage): void {
    this.emit('message', message);
  }

  /** Simulate what useStudioTransport does on session switch. */
  simulateSessionSwitch(newSessionId: string): void {
    this.sessionId = newSessionId;
    this.emit('connected', undefined);
  }

  simulateDisconnect(reason?: string): void {
    this.connected = false;
    this.emit('disconnected', reason);
  }
}

describe('ChatClient session switch state', () => {
  test('subscribes to "disconnected" so real transport drops can clear local state', () => {
    const transport = new MockTransport();
    const chatClient = new ChatClient(transport as any, undefined, false);

    const disconnectedListenerCount = transport.listenerCount('disconnected');
    expect(disconnectedListenerCount).toBeGreaterThanOrEqual(1);

    chatClient.dispose();
  });

  test('clears local messages after transport emits "disconnected" for session_switch', () => {
    const transport = new MockTransport();
    const chatClient = new ChatClient(transport as any, undefined, false);

    // Receive messages in session 1
    transport.simulateMessage({
      type: 'response_end',
      messageId: 'session1-msg-1',
      content: 'Hello from session 1',
    });
    transport.simulateMessage({
      type: 'response_end',
      messageId: 'session1-msg-2',
      content: 'Another message from session 1',
    });
    expect(chatClient.getMessages()).toHaveLength(2);

    // Disconnect (session switch)
    transport.simulateDisconnect('session_switch');

    expect(chatClient.getMessages()).toEqual([]);

    chatClient.dispose();
  });

  test('session switches preserve transport state until the host replaces the transcript', () => {
    const transport = new MockTransport();
    const chatClient = new ChatClient(transport as any, undefined, false);

    // --- Session 1 ---
    transport.simulateMessage({
      type: 'response_end',
      messageId: 's1-msg-1',
      content: 'Response in session 1',
    });
    expect(chatClient.getMessages()).toHaveLength(1);

    // --- Session switch ---
    transport.simulateSessionSwitch('session-2');

    expect(chatClient.getMessages()).toHaveLength(1);
    expect(chatClient.getMessages()[0].content).toBe('Response in session 1');

    chatClient.replaceTranscript([
      {
        id: 's2-msg-1',
        sessionId: 'session-2',
        role: 'assistant',
        content: 'Response in session 2',
        channel: 'text',
        sourceChannel: 'text',
        inputMode: 'system',
        sequence: 0,
        timestamp: new Date('2026-04-23T04:00:00.000Z'),
        final: true,
      },
    ]);

    const messages = chatClient.getMessages();
    expect(messages).toHaveLength(1);
    expect(messages[0].content).toBe('Response in session 2');

    chatClient.dispose();
  });

  test('replaceTranscript resets typing state without requiring a disconnect', () => {
    const transport = new MockTransport();
    const chatClient = new ChatClient(transport as any, undefined, false);
    const typingStates: boolean[] = [];

    chatClient.on('typing', ({ isTyping }) => {
      typingStates.push(isTyping);
    });

    transport.simulateMessage({ type: 'response_start', messageId: 'stream-1' });
    expect(chatClient.getIsTyping()).toBe(true);

    chatClient.replaceTranscript([
      {
        id: 'snapshot-1',
        sessionId: 'session-2',
        role: 'assistant',
        content: 'Recovered session',
        channel: 'text',
        sourceChannel: 'text',
        inputMode: 'system',
        sequence: 0,
        timestamp: new Date('2026-04-23T04:05:00.000Z'),
        final: true,
      },
    ]);

    expect(chatClient.getIsTyping()).toBe(false);
    expect(typingStates).toEqual([true, false]);
    expect(chatClient.getMessages().map((message) => message.id)).toEqual(['snapshot-1']);

    chatClient.dispose();
  });

  test('disconnect while typing emits typing=false and resets typing state', () => {
    const transport = new MockTransport();
    const chatClient = new ChatClient(transport as any, undefined, false);
    const typingStates: boolean[] = [];

    chatClient.on('typing', ({ isTyping }) => {
      typingStates.push(isTyping);
    });

    transport.simulateMessage({ type: 'response_start', messageId: 'stream-1' });
    expect(chatClient.getIsTyping()).toBe(true);

    transport.simulateDisconnect('session_switch');

    expect(chatClient.getIsTyping()).toBe(false);
    expect(typingStates).toEqual([true, false]);

    chatClient.dispose();
  });

  test('clearMessages() still supports manual history resets', () => {
    const transport = new MockTransport();
    const chatClient = new ChatClient(transport as any, undefined, false);

    // Receive a message
    transport.simulateMessage({
      type: 'response_end',
      messageId: 'msg-1',
      content: 'Hello',
    });
    expect(chatClient.getMessages()).toHaveLength(1);

    chatClient.clearMessages();
    expect(chatClient.getMessages()).toHaveLength(0);

    chatClient.dispose();
  });
});
