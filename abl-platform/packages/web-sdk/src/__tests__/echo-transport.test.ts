/**
 * EchoTransport Test
 *
 * Validates that the SDKTransport interface is implementable by third-party
 * consumers. Creates a simple EchoTransport that echoes messages back,
 * demonstrating the full contract.
 */

import { describe, it, expect, vi } from 'vitest';
import type {
  SDKTransport,
  TransportCapabilities,
  TransportClientMessage,
  TransportServerMessage,
  TransportError,
} from '../transport/types.js';

// ---------------------------------------------------------------------------
// EchoTransport — a minimal SDKTransport implementation for testing
// ---------------------------------------------------------------------------

class EchoTransport implements SDKTransport {
  private connected = false;
  private currentSessionId: string | null = null;
  private messageCount = 0;

  private messageHandlers = new Set<(msg: TransportServerMessage) => void>();
  private connectedHandlers = new Set<() => void>();
  private disconnectedHandlers = new Set<(reason?: string) => void>();
  private errorHandlers = new Set<(error: TransportError) => void>();

  capabilities: TransportCapabilities = {
    supportsThoughts: false,
    supportsHandoff: false,
    supportsFileUpload: false,
    supportsVoice: false,
  };

  async connect(): Promise<void> {
    this.connected = true;
    this.currentSessionId = `echo-session-${Date.now()}`;
    for (const handler of this.connectedHandlers) {
      handler();
    }
  }

  disconnect(): void {
    this.connected = false;
    for (const handler of this.disconnectedHandlers) {
      handler('manual_disconnect');
    }
    this.currentSessionId = null;
  }

  isConnected(): boolean {
    return this.connected;
  }

  send(message: TransportClientMessage): void {
    if (!this.connected) return;

    if (message.type === 'chat_message') {
      this.messageCount++;
      const messageId = `echo-${this.messageCount}`;

      // Emit response_start
      this.emitMessage({ type: 'response_start', messageId });

      // Emit response_end with echoed content
      this.emitMessage({
        type: 'response_end',
        messageId,
        content: `Echo: ${message.text}`,
      });
    }
  }

  on(event: 'message', handler: (msg: TransportServerMessage) => void): () => void;
  on(event: 'connected', handler: () => void): () => void;
  on(event: 'disconnected', handler: (reason?: string) => void): () => void;
  on(event: 'error', handler: (error: TransportError) => void): () => void;
  on(
    event: string,
    handler:
      | ((msg: TransportServerMessage) => void)
      | (() => void)
      | ((reason?: string) => void)
      | ((error: TransportError) => void),
  ): () => void {
    switch (event) {
      case 'message':
        this.messageHandlers.add(handler as (msg: TransportServerMessage) => void);
        return () => {
          this.messageHandlers.delete(handler as (msg: TransportServerMessage) => void);
        };
      case 'connected':
        this.connectedHandlers.add(handler as () => void);
        return () => {
          this.connectedHandlers.delete(handler as () => void);
        };
      case 'disconnected':
        this.disconnectedHandlers.add(handler as (reason?: string) => void);
        return () => {
          this.disconnectedHandlers.delete(handler as (reason?: string) => void);
        };
      case 'error':
        this.errorHandlers.add(handler as (error: TransportError) => void);
        return () => {
          this.errorHandlers.delete(handler as (error: TransportError) => void);
        };
      default:
        return () => {};
    }
  }

  getSessionId(): string | null {
    return this.currentSessionId;
  }

  // Helper to emit messages to subscribers
  private emitMessage(msg: TransportServerMessage): void {
    for (const handler of this.messageHandlers) {
      handler(msg);
    }
  }

  // Helper to emit errors (for testing)
  emitError(error: TransportError): void {
    for (const handler of this.errorHandlers) {
      handler(error);
    }
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('EchoTransport (SDKTransport third-party implementation)', () => {
  it('implements the full SDKTransport interface', () => {
    const transport: SDKTransport = new EchoTransport();

    // Verify all interface members exist
    expect(transport.connect).toBeInstanceOf(Function);
    expect(transport.disconnect).toBeInstanceOf(Function);
    expect(transport.isConnected).toBeInstanceOf(Function);
    expect(transport.send).toBeInstanceOf(Function);
    expect(transport.on).toBeInstanceOf(Function);
    expect(transport.getSessionId).toBeInstanceOf(Function);
    expect(transport.capabilities).toBeDefined();
  });

  it('reports not connected initially', () => {
    const transport = new EchoTransport();
    expect(transport.isConnected()).toBe(false);
    expect(transport.getSessionId()).toBeNull();
  });

  it('connects and generates a session ID', async () => {
    const transport = new EchoTransport();
    const onConnected = vi.fn();
    transport.on('connected', onConnected);

    await transport.connect();

    expect(transport.isConnected()).toBe(true);
    expect(transport.getSessionId()).toBeTruthy();
    expect(onConnected).toHaveBeenCalledTimes(1);
  });

  it('disconnects and clears session ID', async () => {
    const transport = new EchoTransport();
    const onDisconnected = vi.fn();
    transport.on('disconnected', onDisconnected);

    await transport.connect();
    transport.disconnect();

    expect(transport.isConnected()).toBe(false);
    expect(transport.getSessionId()).toBeNull();
    expect(onDisconnected).toHaveBeenCalledWith('manual_disconnect');
  });

  it('echoes chat messages back as response_start + response_end', async () => {
    const transport = new EchoTransport();
    const messages: TransportServerMessage[] = [];

    transport.on('message', (msg) => messages.push(msg));
    await transport.connect();

    transport.send({ type: 'chat_message', text: 'Hello world' });

    expect(messages).toHaveLength(2);
    expect(messages[0]).toEqual({
      type: 'response_start',
      messageId: 'echo-1',
    });
    expect(messages[1]).toEqual({
      type: 'response_end',
      messageId: 'echo-1',
      content: 'Echo: Hello world',
    });
  });

  it('ignores send when not connected', () => {
    const transport = new EchoTransport();
    const messages: TransportServerMessage[] = [];
    transport.on('message', (msg) => messages.push(msg));

    transport.send({ type: 'chat_message', text: 'Should not echo' });

    expect(messages).toHaveLength(0);
  });

  it('supports unsubscribe via returned function', async () => {
    const transport = new EchoTransport();
    const messages: TransportServerMessage[] = [];

    const unsub = transport.on('message', (msg) => messages.push(msg));
    await transport.connect();

    transport.send({ type: 'chat_message', text: 'First' });
    expect(messages).toHaveLength(2);

    unsub();

    transport.send({ type: 'chat_message', text: 'Second' });
    // Still 2 — unsubscribed
    expect(messages).toHaveLength(2);
  });

  it('increments message IDs across multiple sends', async () => {
    const transport = new EchoTransport();
    const messages: TransportServerMessage[] = [];

    transport.on('message', (msg) => messages.push(msg));
    await transport.connect();

    transport.send({ type: 'chat_message', text: 'First' });
    transport.send({ type: 'chat_message', text: 'Second' });

    expect(messages).toHaveLength(4);
    // First message pair
    expect((messages[0] as { messageId: string }).messageId).toBe('echo-1');
    expect((messages[1] as { messageId: string }).messageId).toBe('echo-1');
    // Second message pair
    expect((messages[2] as { messageId: string }).messageId).toBe('echo-2');
    expect((messages[3] as { messageId: string }).messageId).toBe('echo-2');
  });

  it('emits error events', async () => {
    const transport = new EchoTransport();
    const errors: TransportError[] = [];

    transport.on('error', (err) => errors.push(err));
    await transport.connect();

    transport.emitError({
      code: 'TEST_ERROR',
      message: 'Something went wrong',
      recoverable: true,
    });

    expect(errors).toHaveLength(1);
    expect(errors[0]).toEqual({
      code: 'TEST_ERROR',
      message: 'Something went wrong',
      recoverable: true,
    });
  });

  it('reports correct capabilities', () => {
    const transport = new EchoTransport();
    expect(transport.capabilities).toEqual({
      supportsThoughts: false,
      supportsHandoff: false,
      supportsFileUpload: false,
      supportsVoice: false,
    });
  });
});
