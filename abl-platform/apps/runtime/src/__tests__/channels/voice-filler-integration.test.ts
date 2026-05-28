/**
 * Voice Filler Integration Tests (I-4.8 to I-4.11)
 *
 * Tests real VoiceChannelFillerAdapter with mock session objects.
 * Validates audio emission, barge-in suppression, response cancellation,
 * and message pool rotation.
 */

import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  VoiceChannelFillerAdapter,
  type VoiceFillerSession,
} from '../../services/filler/channel-adapters/voice-filler-adapter.js';
import type { StatusEvent } from '../../services/filler/types.js';

function createMockSession(): VoiceFillerSession {
  return {
    sendAudio: vi.fn(),
    cancelResponse: vi.fn(),
    isBargeInActive: false,
    isResponseImminent: false,
  };
}

function createStatusEvent(overrides: Partial<StatusEvent> = {}): StatusEvent {
  return {
    id: 'evt-' + Math.random().toString(36).slice(2, 8),
    sessionId: 'session-integration',
    text: 'One moment...',
    operation: 'general',
    source: 'static',
    transient: true,
    index: 0,
    timestamp: Date.now(),
    ...overrides,
  };
}

describe('Voice Filler Integration (I-4.8 to I-4.11)', () => {
  let mockSession: VoiceFillerSession;

  beforeEach(() => {
    vi.useFakeTimers();
    mockSession = createMockSession();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // ===========================================================================
  // I-4.8: Filler emits audio for realtime mode
  // ===========================================================================

  test('I-4.8: realtime mode filler calls session.sendAudio with audio payload', () => {
    const adapter = new VoiceChannelFillerAdapter({
      mode: 'realtime',
      session: mockSession,
    });

    const event = createStatusEvent({ text: 'Let me check on that...' });
    adapter.handleStatusEvent(event);

    // In realtime mode, adapter encodes text as UTF-8 buffer and sends via sendAudio
    expect(mockSession.sendAudio).toHaveBeenCalledTimes(1);

    // Verify the payload is a Buffer containing the filler text
    const sentPayload = (mockSession.sendAudio as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(Buffer.isBuffer(sentPayload)).toBe(true);
    expect(sentPayload.toString('utf-8')).toBe('Let me check on that...');

    adapter.destroy();
  });

  // ===========================================================================
  // I-4.9: Filler suppressed during barge-in
  // ===========================================================================

  test('I-4.9: filler is suppressed when barge-in is active', () => {
    const adapter = new VoiceChannelFillerAdapter({
      mode: 'realtime',
      session: mockSession,
    });

    // Activate barge-in
    mockSession.isBargeInActive = true;

    const event = createStatusEvent({ text: 'Working on that...' });
    adapter.handleStatusEvent(event);

    // No audio should be sent during barge-in
    expect(mockSession.sendAudio).not.toHaveBeenCalled();

    // Deactivate barge-in — filler should work again
    mockSession.isBargeInActive = false;

    adapter.handleStatusEvent(createStatusEvent({ text: 'Still looking...' }));
    expect(mockSession.sendAudio).toHaveBeenCalledTimes(1);

    adapter.destroy();
  });

  // ===========================================================================
  // I-4.10: Filler cancelled when response arrives quickly
  // ===========================================================================

  test('I-4.10: filler not delivered when response is imminent', () => {
    const emittedVerbs: unknown[] = [];
    const adapter = new VoiceChannelFillerAdapter({
      mode: 'realtime',
      session: mockSession,
      onJambonzVerb: (verb) => emittedVerbs.push(verb),
    });

    // Mark response as imminent (e.g., LLM response is about to arrive)
    mockSession.isResponseImminent = true;

    const event = createStatusEvent({ text: 'Let me look into that...' });
    adapter.handleStatusEvent(event);

    // Neither audio nor verbs should be emitted
    expect(mockSession.sendAudio).not.toHaveBeenCalled();
    expect(emittedVerbs).toHaveLength(0);

    adapter.destroy();
  });

  // ===========================================================================
  // I-4.11: Message pool rotation — different messages selected over 5 triggers
  // ===========================================================================

  test('I-4.11: message pool rotates different messages over multiple triggers', () => {
    const adapter = new VoiceChannelFillerAdapter({
      mode: 'realtime',
      session: mockSession,
    });

    // Call getFillerText multiple times for the same operation
    const messages: string[] = [];
    for (let i = 0; i < 10; i++) {
      const msg = adapter.getFillerText('tool_call');
      messages.push(msg);
    }

    // All messages should be non-empty strings
    expect(messages.every((m) => typeof m === 'string' && m.length > 0)).toBe(true);

    // With 4 messages in the tool_call pool, we should see at least 2 unique
    // messages across 10 draws (statistically near-certain)
    const uniqueMessages = new Set(messages);
    expect(uniqueMessages.size).toBeGreaterThanOrEqual(2);

    // Now verify rotation through handleStatusEvent — the adapter tracks recent
    // messages and avoids repetition
    const sentTexts: string[] = [];
    for (let i = 0; i < 5; i++) {
      const text = adapter.getFillerText('general');
      const event = createStatusEvent({ text });
      adapter.handleStatusEvent(event);
      sentTexts.push(text);
    }

    // Should have sent all 5
    expect(mockSession.sendAudio).toHaveBeenCalledTimes(5);

    // Verify at least some variety (the pool has 3 general messages)
    const uniqueSent = new Set(sentTexts);
    expect(uniqueSent.size).toBeGreaterThanOrEqual(2);

    adapter.destroy();
  });
});
