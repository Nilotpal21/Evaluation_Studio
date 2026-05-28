/**
 * Chat Client Integration Tests (I-4.5 to I-4.7)
 *
 * Tests real ChatClient with mock transport.
 * Validates status_update and status_clear event handling via the embedding app on() API.
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';
import { ChatClient } from '../chat/ChatClient.js';
import { TypedEventEmitter } from '../core/EventEmitter.js';
import type { StatusUpdateEventData } from '../core/types.js';
import type { TransportServerMessage } from '../transport/types.js';

/**
 * MockTransport for ChatClient testing.
 */
class MockTransport extends TypedEventEmitter<{
  message: TransportServerMessage;
  connected: void;
  disconnected: string | undefined;
  error: { code: string; message: string; recoverable: boolean };
}> {
  private connected = true;
  private sessionId = 'test-session-chat-integration';
  capabilities = {
    supportsThoughts: true,
    supportsHandoff: true,
    supportsFileUpload: true,
    supportsVoice: true,
  };

  isConnected(): boolean {
    return this.connected;
  }

  setConnected(connected: boolean): void {
    this.connected = connected;
  }

  getSessionId(): string | null {
    return this.sessionId;
  }

  connect(): Promise<void> {
    return Promise.resolve();
  }

  disconnect(): void {
    // noop
  }

  send(_msg: unknown): void {
    // noop
  }

  simulateMessage(message: TransportServerMessage): void {
    this.emit('message', message);
  }
}

describe('Chat Client Integration (I-4.5 to I-4.7)', () => {
  let transport: MockTransport;
  let chatClient: ChatClient;

  beforeEach(() => {
    transport = new MockTransport();
    chatClient = new ChatClient(transport as any, undefined, false);
  });

  // ===========================================================================
  // I-4.5: status_update message → event emitted
  // ===========================================================================

  test('I-4.5: status_update message emits statusUpdate event', () => {
    const handler = vi.fn();
    chatClient.on('statusUpdate', handler);

    transport.simulateMessage({
      type: 'status_update',
      text: 'Analyzing your question...',
      operation: 'reasoning',
    });

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith({
      text: 'Analyzing your question...',
      operation: 'reasoning',
    });

    // Send a second one to verify repeated events work
    transport.simulateMessage({
      type: 'status_update',
      text: 'Calling tool...',
      operation: 'tool_call',
    });

    expect(handler).toHaveBeenCalledTimes(2);
    expect(handler).toHaveBeenCalledWith({
      text: 'Calling tool...',
      operation: 'tool_call',
    });
  });

  // ===========================================================================
  // I-4.6: status_clear message → event emitted
  // ===========================================================================

  test('I-4.6: status_clear message emits statusClear event', () => {
    const handler = vi.fn();
    chatClient.on('statusClear', handler);

    // Send status_update first, then clear
    transport.simulateMessage({
      type: 'status_update',
      text: 'Working...',
      operation: 'general',
    });

    transport.simulateMessage({
      type: 'status_clear',
    });

    expect(handler).toHaveBeenCalledTimes(1);
  });

  // ===========================================================================
  // I-4.7: Status events accessible via embedding app on()
  // ===========================================================================

  test('I-4.7: embedding app receives status events via on() listeners', () => {
    const updates: StatusUpdateEventData[] = [];
    let clearCount = 0;

    // Simulate an embedding app registering listeners
    chatClient.on('statusUpdate', (data) => {
      updates.push(data);
    });
    chatClient.on('statusClear', () => {
      clearCount++;
    });

    // Simulate a full agent response cycle with interleaved status events
    transport.simulateMessage({ type: 'response_start', messageId: 'msg-1' });

    transport.simulateMessage({
      type: 'status_update',
      text: 'Thinking about your request...',
      operation: 'reasoning',
    });

    transport.simulateMessage({
      type: 'status_update',
      text: 'Searching the knowledge base...',
      operation: 'tool_call',
    });

    transport.simulateMessage({
      type: 'status_clear',
    });

    transport.simulateMessage({
      type: 'response_end',
      messageId: 'msg-1',
      content: 'Here is the answer.',
    });

    // All status events should have been received
    expect(updates).toHaveLength(2);
    expect(updates[0]).toEqual({
      text: 'Thinking about your request...',
      operation: 'reasoning',
    });
    expect(updates[1]).toEqual({
      text: 'Searching the knowledge base...',
      operation: 'tool_call',
    });
    expect(clearCount).toBe(1);

    // Normal message flow should also have worked
    const messages = chatClient.getMessages();
    expect(messages).toHaveLength(1);
    expect(messages[0].content).toBe('Here is the answer.');
  });

  test('status listeners still receive updates after transport reconnect when the client stays mounted', () => {
    const updates: StatusUpdateEventData[] = [];
    let clearCount = 0;

    chatClient.on('statusUpdate', (data) => {
      updates.push(data);
    });
    chatClient.on('statusClear', () => {
      clearCount++;
    });

    transport.simulateMessage({
      type: 'status_update',
      text: 'Before reconnect',
      operation: 'reasoning',
    });

    transport.setConnected(false);
    transport.emit('disconnected', 'temporary_network_issue');
    transport.setConnected(true);
    transport.emit('connected', undefined as unknown as void);

    transport.simulateMessage({
      type: 'status_update',
      text: 'After reconnect',
      operation: 'tool_call',
    });
    transport.simulateMessage({ type: 'status_clear' });

    expect(updates).toEqual([
      { text: 'Before reconnect', operation: 'reasoning' },
      { text: 'After reconnect', operation: 'tool_call' },
    ]);
    expect(clearCount).toBe(1);
  });
});
