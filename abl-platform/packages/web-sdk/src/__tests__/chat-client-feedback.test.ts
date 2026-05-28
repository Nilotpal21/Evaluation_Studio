/**
 * ChatClient.submitFeedback / feedback.ack transport tests (ABLP-1068).
 *
 * Exercises the public SDK surface — submitFeedback() promise contract,
 * `feedbackAck` event emission, the pending registry behaviour, and the
 * DefaultTransport-compatible feedback.ack envelope shape.
 *
 * Uses the same MockTransport pattern as `chat-client-transport.test.ts`
 * (no `vi.mock` of SDK internals).
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import { ChatClient } from '../chat/ChatClient.js';
import { TypedEventEmitter } from '../core/EventEmitter.js';
import type {
  TransportServerMessage,
  TransportClientMessage,
  TransportError,
} from '../transport/types.js';

class MockTransport extends TypedEventEmitter<{
  message: TransportServerMessage;
  connected: void;
  disconnected: string | undefined;
  error: TransportError;
}> {
  private connected = true;
  capabilities = {
    supportsThoughts: true,
    supportsHandoff: true,
    supportsFileUpload: false,
    supportsVoice: false,
  };
  sentMessages: TransportClientMessage[] = [];

  isConnected(): boolean {
    return this.connected;
  }

  setConnected(c: boolean): void {
    this.connected = c;
  }

  getSessionId(): string | null {
    return 'sess-1';
  }

  getActiveLiveSessionId(): string | null {
    return null;
  }

  connect(): Promise<void> {
    return Promise.resolve();
  }

  disconnect(): void {
    /* noop */
  }

  send(msg: TransportClientMessage): void {
    this.sentMessages.push(msg);
  }

  simulateMessage(message: TransportServerMessage): void {
    this.emit('message', message);
  }
}

describe('ChatClient.submitFeedback', () => {
  let transport: MockTransport;
  let chat: ChatClient;

  beforeEach(() => {
    transport = new MockTransport();
    chat = new ChatClient(transport);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  test('sends a feedback.submit with the documented payload shape', async () => {
    const promise = chat.submitFeedback({
      messageId: 'm-1',
      ratingType: 'thumbs',
      ratingValue: 0,
      feedbackText: 'Missed the question',
      actionRenderId: 'render-1',
    });
    expect(transport.sentMessages).toHaveLength(1);
    const sent = transport.sentMessages[0];
    expect(sent).toEqual({
      type: 'feedback.submit',
      messageId: 'm-1',
      ratingType: 'thumbs',
      ratingValue: 0,
      feedbackText: 'Missed the question',
      actionRenderId: 'render-1',
    });
    // Resolve the promise so vitest doesn't whine about a pending one.
    transport.simulateMessage({
      type: 'feedback.ack',
      messageId: 'm-1',
      success: true,
      feedbackId: 'fb-1',
      actionRenderId: 'render-1',
    });
    await expect(promise).resolves.toEqual({ feedbackId: 'fb-1' });
  });

  test('resolves with feedbackId when the runtime acks success', async () => {
    const promise = chat.submitFeedback({
      messageId: 'm-1',
      ratingType: 'thumbs',
      ratingValue: 1,
    });
    transport.simulateMessage({
      type: 'feedback.ack',
      messageId: 'm-1',
      success: true,
      feedbackId: 'fb-success',
    });
    await expect(promise).resolves.toEqual({ feedbackId: 'fb-success' });
  });

  test('rejects with the runtime error code on a failure ack', async () => {
    const promise = chat.submitFeedback({
      messageId: 'm-1',
      ratingType: 'thumbs',
      ratingValue: 0,
    });
    transport.simulateMessage({
      type: 'feedback.ack',
      messageId: 'm-1',
      success: false,
      error: { code: 'INVALID_TARGET', message: 'no such message' },
    });
    await expect(promise).rejects.toMatchObject({
      code: 'INVALID_TARGET',
      message: 'no such message',
    });
  });

  test('rejects with FEEDBACK_TIMEOUT when no ack arrives within timeout', async () => {
    vi.useFakeTimers();
    const promise = chat.submitFeedback({
      messageId: 'm-1',
      ratingType: 'thumbs',
      ratingValue: 0,
      timeoutMs: 1000,
    });
    vi.advanceTimersByTime(1000);
    await expect(promise).rejects.toMatchObject({ code: 'FEEDBACK_TIMEOUT' });
  });

  test('rejects with FEEDBACK_PENDING when a second submit overlaps with the first key', async () => {
    const first = chat.submitFeedback({
      messageId: 'm-1',
      ratingType: 'thumbs',
      ratingValue: 0,
    });
    const second = chat.submitFeedback({
      messageId: 'm-1',
      ratingType: 'thumbs',
      ratingValue: 1,
    });
    await expect(second).rejects.toMatchObject({ code: 'FEEDBACK_PENDING' });
    // First still resolves after an ack — pending registry was not corrupted.
    transport.simulateMessage({
      type: 'feedback.ack',
      messageId: 'm-1',
      success: true,
      feedbackId: 'fb-1',
    });
    await expect(first).resolves.toEqual({ feedbackId: 'fb-1' });
  });

  test('different actionRenderId values do not collide in the pending registry', async () => {
    const a = chat.submitFeedback({
      messageId: 'm-1',
      ratingType: 'thumbs',
      ratingValue: 1,
      actionRenderId: 'r-1',
    });
    const b = chat.submitFeedback({
      messageId: 'm-1',
      ratingType: 'thumbs',
      ratingValue: 0,
      actionRenderId: 'r-2',
    });
    transport.simulateMessage({
      type: 'feedback.ack',
      messageId: 'm-1',
      success: true,
      feedbackId: 'fb-a',
      actionRenderId: 'r-1',
    });
    transport.simulateMessage({
      type: 'feedback.ack',
      messageId: 'm-1',
      success: true,
      feedbackId: 'fb-b',
      actionRenderId: 'r-2',
    });
    await expect(a).resolves.toEqual({ feedbackId: 'fb-a' });
    await expect(b).resolves.toEqual({ feedbackId: 'fb-b' });
  });

  test('rejects with NOT_CONNECTED when transport is offline', async () => {
    transport.setConnected(false);
    await expect(
      chat.submitFeedback({ messageId: 'm-1', ratingType: 'thumbs', ratingValue: 0 }),
    ).rejects.toMatchObject({ code: 'NOT_CONNECTED' });
    expect(transport.sentMessages).toHaveLength(0);
  });

  test('emits feedbackAck event for both success and failure acks (non-promise observers)', async () => {
    const events: Array<{ messageId: string; success: boolean; feedbackId?: string }> = [];
    chat.on('feedbackAck', (ev) => events.push(ev));

    const okPromise = chat.submitFeedback({
      messageId: 'm-1',
      ratingType: 'thumbs',
      ratingValue: 1,
    });
    transport.simulateMessage({
      type: 'feedback.ack',
      messageId: 'm-1',
      success: true,
      feedbackId: 'fb-1',
    });
    await okPromise;

    const failPromise = chat.submitFeedback({
      messageId: 'm-2',
      ratingType: 'thumbs',
      ratingValue: 0,
    });
    transport.simulateMessage({
      type: 'feedback.ack',
      messageId: 'm-2',
      success: false,
      error: { code: 'DUPLICATE_FEEDBACK', message: 'dup' },
    });
    await expect(failPromise).rejects.toBeDefined();

    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({ messageId: 'm-1', success: true, feedbackId: 'fb-1' });
    expect(events[1]).toMatchObject({ messageId: 'm-2', success: false });
  });

  test('still emits feedbackAck for unsolicited acks (no pending promise)', () => {
    const events: Array<{ messageId: string; success: boolean }> = [];
    chat.on('feedbackAck', (ev) => events.push(ev));
    transport.simulateMessage({
      type: 'feedback.ack',
      messageId: 'unknown',
      success: true,
      feedbackId: 'fb-x',
    });
    expect(events).toHaveLength(1);
  });
});
