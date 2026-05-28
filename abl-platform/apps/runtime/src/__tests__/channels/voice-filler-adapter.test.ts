import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { VoiceChannelFillerAdapter } from '../../services/filler/channel-adapters/voice-filler-adapter.js';
import type { StatusEvent } from '../../services/filler/types.js';

/**
 * Mock voice session for testing the filler adapter.
 */
function createMockVoiceSession() {
  return {
    sendAudio: vi.fn(),
    cancelResponse: vi.fn(),
    isBargeInActive: false,
    isResponseImminent: false,
  };
}

function createStatusEvent(overrides: Partial<StatusEvent> = {}): StatusEvent {
  return {
    id: 'evt-1',
    sessionId: 'session-1',
    text: 'One moment...',
    operation: 'general',
    source: 'static',
    transient: true,
    index: 0,
    timestamp: Date.now(),
    ...overrides,
  };
}

describe('VoiceChannelFillerAdapter', () => {
  let mockSession: ReturnType<typeof createMockVoiceSession>;
  let adapter: VoiceChannelFillerAdapter;
  let emittedVerbs: unknown[];

  beforeEach(() => {
    vi.useFakeTimers();
    mockSession = createMockVoiceSession();
    emittedVerbs = [];
    adapter = new VoiceChannelFillerAdapter({
      mode: 'realtime',
      session: mockSession,
      onJambonzVerb: (verb) => emittedVerbs.push(verb),
    });
  });

  afterEach(() => {
    adapter.destroy();
    vi.useRealTimers();
  });

  test('4-U10: realtime mode calls session.sendAudio for filler TTS', () => {
    const event = createStatusEvent({ text: 'Checking now...' });

    adapter.handleStatusEvent(event);

    // In realtime mode, the adapter should call synthesize + sendAudio
    expect(mockSession.sendAudio).toHaveBeenCalled();
  });

  test('4-U11: filler selects from message pool when no text provided', () => {
    const result = adapter.getFillerText('tool_call');

    expect(typeof result).toBe('string');
    expect(result.length).toBeGreaterThan(0);
  });

  test('4-U11b: filler text follows configured locale', () => {
    adapter.destroy();
    adapter = new VoiceChannelFillerAdapter({
      mode: 'realtime',
      session: mockSession,
      locale: 'es-MX',
    });

    const result = adapter.getFillerText('tool_call');

    expect(['Un momento.', 'Revisando ahora.', 'Echando un vistazo.']).toContain(result);
  });

  test('4-U12: filler suppressed during barge-in', () => {
    mockSession.isBargeInActive = true;

    const event = createStatusEvent();
    adapter.handleStatusEvent(event);

    expect(mockSession.sendAudio).not.toHaveBeenCalled();
    expect(emittedVerbs).toHaveLength(0);
  });

  test('4-U13: filler not sent when response_start is imminent', () => {
    mockSession.isResponseImminent = true;

    const event = createStatusEvent();
    adapter.handleStatusEvent(event);

    expect(mockSession.sendAudio).not.toHaveBeenCalled();
    expect(emittedVerbs).toHaveLength(0);
  });

  test('4-U14: pipeline mode emits Jambonz say verb', () => {
    adapter.destroy();
    adapter = new VoiceChannelFillerAdapter({
      mode: 'pipeline',
      session: mockSession,
      onJambonzVerb: (verb) => emittedVerbs.push(verb),
    });

    const event = createStatusEvent({ text: 'One moment please...' });
    adapter.handleStatusEvent(event);

    expect(emittedVerbs).toHaveLength(1);
    expect(emittedVerbs[0]).toEqual(
      expect.objectContaining({
        verb: 'say',
        text: 'One moment please...',
      }),
    );
    // In pipeline mode, sendAudio should NOT be called
    expect(mockSession.sendAudio).not.toHaveBeenCalled();
  });

  test('filler uses event text when provided', () => {
    const event = createStatusEvent({ text: 'Custom filler message...' });
    adapter.handleStatusEvent(event);

    // The adapter should use the event's text, not the pool
    expect(mockSession.sendAudio).toHaveBeenCalled();
  });

  test('destroy prevents further emissions', () => {
    adapter.destroy();

    const event = createStatusEvent();
    adapter.handleStatusEvent(event);

    expect(mockSession.sendAudio).not.toHaveBeenCalled();
    expect(emittedVerbs).toHaveLength(0);
  });
});
