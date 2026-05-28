import { describe, test, expect, vi, beforeEach } from 'vitest';
import { ChatClient } from '../chat/ChatClient.js';
import { TypedEventEmitter } from '../core/EventEmitter.js';
import type { TransportServerMessage } from '../transport/types.js';

/**
 * MockTransport for ChatClient testing.
 * Implements the subset of SDKTransport used by ChatClient.
 */
class MockTransport extends TypedEventEmitter<{
  message: TransportServerMessage;
  connected: void;
  disconnected: string | undefined;
  error: { code: string; message: string; recoverable: boolean };
}> {
  private connected = true;
  private sessionId = 'test-session-456';
  capabilities = {
    supportsThoughts: true,
    supportsHandoff: true,
    supportsFileUpload: true,
    supportsVoice: true,
  };
  sent: unknown[] = [];

  isConnected(): boolean {
    return this.connected;
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

  send(msg: unknown): void {
    this.sent.push(msg);
  }

  simulateMessage(message: TransportServerMessage): void {
    this.emit('message', message);
  }
}

describe('ChatClient status event handling', () => {
  let transport: MockTransport;
  let chatClient: ChatClient;

  beforeEach(() => {
    transport = new MockTransport();
    chatClient = new ChatClient(transport as any, undefined, false);
  });

  test('4-U7: status_update message emits statusUpdate event', () => {
    const handler = vi.fn();
    chatClient.on('statusUpdate', handler);

    transport.simulateMessage({
      type: 'status_update',
      text: 'Searching for products...',
      operation: 'tool_call',
    });

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith({
      text: 'Searching for products...',
      operation: 'tool_call',
    });
  });

  test('4-U8: status_clear message emits statusClear event', () => {
    const handler = vi.fn();
    chatClient.on('statusClear', handler);

    transport.simulateMessage({
      type: 'status_clear',
    });

    expect(handler).toHaveBeenCalledTimes(1);
  });

  test('4-U9: embedding app receives status via on()', () => {
    const updates: Array<{ text: string; operation: string }> = [];
    let cleared = false;

    chatClient.on('statusUpdate', (data) => {
      updates.push(data);
    });
    chatClient.on('statusClear', () => {
      cleared = true;
    });

    // Send a status update
    transport.simulateMessage({
      type: 'status_update',
      text: 'Looking that up...',
      operation: 'reasoning',
    });

    // Send another
    transport.simulateMessage({
      type: 'status_update',
      text: 'Running calculations...',
      operation: 'tool_call',
    });

    // Clear
    transport.simulateMessage({
      type: 'status_clear',
    });

    expect(updates).toHaveLength(2);
    expect(updates[0]).toEqual({ text: 'Looking that up...', operation: 'reasoning' });
    expect(updates[1]).toEqual({ text: 'Running calculations...', operation: 'tool_call' });
    expect(cleared).toBe(true);
  });

  test('status events replace the typing indicator without entering message history', () => {
    const messageHandler = vi.fn();
    const statusHandler = vi.fn();
    const typingHandler = vi.fn();

    chatClient.on('message', messageHandler);
    chatClient.on('statusUpdate', statusHandler);
    chatClient.on('typing', typingHandler);

    // Normal response_start still works
    transport.simulateMessage({ type: 'response_start', messageId: 'msg-1' });
    expect(typingHandler).toHaveBeenCalledWith({ isTyping: true });

    // Status update mid-stream
    transport.simulateMessage({
      type: 'status_update',
      text: 'Checking...',
      operation: 'general',
    });
    expect(statusHandler).toHaveBeenCalledTimes(1);
    expect(typingHandler).toHaveBeenCalledWith({ isTyping: false });

    // Normal response_end still works
    transport.simulateMessage({
      type: 'response_end',
      messageId: 'msg-1',
      content: 'Here is your answer.',
    });
    expect(messageHandler).toHaveBeenCalledTimes(1);
    expect(typingHandler).toHaveBeenCalledWith({ isTyping: false });
  });

  test('response_start does not clear an active status indicator', () => {
    const statusHandler = vi.fn();
    const clearHandler = vi.fn();
    const typingHandler = vi.fn();

    chatClient.on('statusUpdate', statusHandler);
    chatClient.on('statusClear', clearHandler);
    chatClient.on('typing', typingHandler);

    transport.simulateMessage({
      type: 'status_update',
      text: 'Checking warranty details...',
      operation: 'http_async',
    });
    transport.simulateMessage({ type: 'response_start', messageId: 'msg-status-bridge' });

    expect(statusHandler).toHaveBeenCalledWith({
      text: 'Checking warranty details...',
      operation: 'http_async',
    });
    expect(clearHandler).not.toHaveBeenCalled();
    expect(typingHandler).not.toHaveBeenCalled();

    transport.simulateMessage({
      type: 'response_end',
      messageId: 'msg-status-bridge',
      content: 'Your warranty is active.',
    });

    expect(clearHandler).toHaveBeenCalledTimes(1);
  });

  test('terminal error messages clear status activity so the next response can show typing', () => {
    const clearHandler = vi.fn();
    const typingHandler = vi.fn();

    chatClient.on('statusClear', clearHandler);
    chatClient.on('typing', typingHandler);

    transport.simulateMessage({
      type: 'status_update',
      text: 'Checking warranty details...',
      operation: 'http_async',
    });
    transport.simulateMessage({
      type: 'error',
      content: "I'm having trouble completing that request. Please try again.",
      metadata: {
        errorCode: 'provider_error',
        severity: 'error',
      },
    });

    expect(clearHandler).toHaveBeenCalledTimes(1);

    transport.simulateMessage({ type: 'response_start', messageId: 'msg-after-error' });

    expect(typingHandler).toHaveBeenCalledWith({ isTyping: true });
  });

  test('typed interrupts keep local typed metadata and send the typed interrupt protocol', () => {
    const messageHandler = vi.fn();
    const sentHandler = vi.fn();
    chatClient.on('message', messageHandler);
    chatClient.on('messageSent', sentHandler);

    chatClient.sendTypedInterrupt('stop and use typed input');

    expect(messageHandler).toHaveBeenCalledWith(
      expect.objectContaining({
        role: 'user',
        content: 'stop and use typed input',
        sourceChannel: 'text',
        inputMode: 'typed',
      }),
    );
    expect(sentHandler).toHaveBeenCalledWith({ messageId: expect.any(String) });
    expect(transport.sent).toEqual([
      {
        type: 'typed_interrupt',
        messageId: expect.any(String),
        text: 'stop and use typed input',
        sessionId: 'test-session-456',
      },
    ]);
  });

  test('structured response_end after status preserves final rich payload fields', () => {
    const messageHandler = vi.fn();
    const statusHandler = vi.fn();
    chatClient.on('message', messageHandler);
    chatClient.on('statusUpdate', statusHandler);

    transport.simulateMessage({
      type: 'status_update',
      text: 'Checking account status...',
      operation: 'tool_call',
    });
    transport.simulateMessage({
      type: 'response_chunk',
      messageId: 'msg-structured',
      content: 'partial text',
    });
    transport.simulateMessage({
      type: 'response_end',
      messageId: 'msg-structured',
      content: '',
      voiceConfig: { plain_text: 'Here is the account status.' },
      richContent: { markdown: '**Account active**' },
      actions: {
        elements: [{ id: 'refresh', type: 'button', label: 'Refresh' }],
      },
      metadata: { locale: 'en-US' },
    });

    expect(statusHandler).toHaveBeenCalledWith({
      text: 'Checking account status...',
      operation: 'tool_call',
    });
    expect(messageHandler).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'msg-structured',
        role: 'assistant',
        content: 'Here is the account status.',
        voiceConfig: expect.objectContaining({
          plain_text: 'Here is the account status.',
          plainText: 'Here is the account status.',
        }),
        richContent: { markdown: '**Account active**' },
        actions: expect.objectContaining({
          elements: [expect.objectContaining({ id: 'refresh', type: 'button', label: 'Refresh' })],
        }),
        metadata: { locale: 'en-US' },
      }),
    );
  });
});
