/**
 * Realtime Event Routing Integration Tests
 *
 * Tests the full server event → callback pipeline for both adapters
 * (OpenAI Realtime and Gemini Live) without real WebSocket connections.
 * Uses internal access to inject mock ws and trigger handleMessage directly.
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';

vi.mock('../../platform/logger.js', () => ({
  createLogger: vi.fn().mockReturnValue({
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

import { OpenAIRealtimeSession } from '../platform/llm/realtime/openai-realtime.js';
import { GeminiLiveSession } from '../platform/llm/realtime/gemini-live.js';
import { UltravoxRealtimeSession } from '../platform/llm/realtime/ultravox-realtime.js';
import type {
  RealtimeTranscript,
  RealtimeToolCall,
  RealtimeUsageMetrics,
} from '../platform/llm/realtime/types.js';

// =============================================================================
// HELPERS
// =============================================================================

function createMockWs() {
  return {
    readyState: 1,
    send: vi.fn(),
    close: vi.fn(),
    once: vi.fn(),
    on: vi.fn(),
    removeAllListeners: vi.fn(),
  };
}

function wireSession(session: any, ws: ReturnType<typeof createMockWs>) {
  session.ws = ws;
  session._connectionState = 'connected';
}

function msg(data: any) {
  return { toString: () => JSON.stringify(data) };
}

// =============================================================================
// OPENAI FULL TURN
// =============================================================================

describe('OpenAI Realtime — full turn event routing', () => {
  let session: OpenAIRealtimeSession;
  let ws: ReturnType<typeof createMockWs>;

  beforeEach(() => {
    session = new OpenAIRealtimeSession();
    ws = createMockWs();
    wireSession(session, ws);
  });

  test('audio delta → onAudio with decoded buffer', () => {
    const audioHandler = vi.fn();
    session.on('onAudio', audioHandler);

    const audioData = Buffer.from('hello-audio').toString('base64');
    (session as any).handleMessage(msg({ type: 'response.audio.delta', delta: audioData }));

    expect(audioHandler).toHaveBeenCalledTimes(1);
    const received = audioHandler.mock.calls[0][0] as Buffer;
    expect(received.toString()).toBe('hello-audio');
  });

  test('transcript delta → onTranscript (partial)', () => {
    const transcriptHandler = vi.fn();
    session.on('onTranscript', transcriptHandler);

    (session as any).handleMessage(msg({ type: 'response.audio_transcript.delta', delta: 'Hel' }));

    expect(transcriptHandler).toHaveBeenCalledWith({
      text: 'Hel',
      role: 'assistant',
      isFinal: false,
    });
  });

  test('transcript done → onTranscript (final)', () => {
    const transcriptHandler = vi.fn();
    session.on('onTranscript', transcriptHandler);

    (session as any).handleMessage(
      msg({ type: 'response.audio_transcript.done', transcript: 'Hello, how can I help?' }),
    );

    expect(transcriptHandler).toHaveBeenCalledWith({
      text: 'Hello, how can I help?',
      role: 'assistant',
      isFinal: true,
    });
  });

  test('input audio transcription → onTranscript (user, final)', () => {
    const transcriptHandler = vi.fn();
    session.on('onTranscript', transcriptHandler);

    (session as any).handleMessage(
      msg({
        type: 'conversation.item.input_audio_transcription.completed',
        transcript: 'I want to book a flight',
      }),
    );

    expect(transcriptHandler).toHaveBeenCalledWith({
      text: 'I want to book a flight',
      role: 'user',
      isFinal: true,
    });
  });

  test('function_call → onToolCall', () => {
    const toolHandler = vi.fn();
    session.on('onToolCall', toolHandler);

    (session as any).handleMessage(
      msg({
        type: 'response.function_call_arguments.done',
        call_id: 'call-abc',
        name: 'search_flights',
        arguments: '{"origin":"SFO","destination":"NYC"}',
      }),
    );

    expect(toolHandler).toHaveBeenCalledWith({
      callId: 'call-abc',
      name: 'search_flights',
      arguments: '{"origin":"SFO","destination":"NYC"}',
    });
  });

  test('response.done → onTurnEnd with usage', () => {
    const turnHandler = vi.fn();
    session.on('onTurnEnd', turnHandler);

    (session as any).handleMessage(
      msg({
        type: 'response.done',
        response: {
          usage: { input_tokens: 200, output_tokens: 100, total_tokens: 300 },
        },
      }),
    );

    expect(turnHandler).toHaveBeenCalledWith({
      inputTokens: 200,
      outputTokens: 100,
      totalTokens: 300,
    });
  });

  test('speech_started → onInterrupted', () => {
    const interruptHandler = vi.fn();
    session.on('onInterrupted', interruptHandler);

    (session as any).handleMessage(msg({ type: 'input_audio_buffer.speech_started' }));

    expect(interruptHandler).toHaveBeenCalledTimes(1);
  });

  test('full turn sequence — audio + transcript + tool + response', () => {
    const audioHandler = vi.fn();
    const transcriptHandler = vi.fn();
    const toolHandler = vi.fn();
    const turnHandler = vi.fn();

    session.on('onAudio', audioHandler);
    session.on('onTranscript', transcriptHandler);
    session.on('onToolCall', toolHandler);
    session.on('onTurnEnd', turnHandler);

    // 1. Audio delta
    (session as any).handleMessage(
      msg({
        type: 'response.audio.delta',
        delta: Buffer.from('audio-chunk-1').toString('base64'),
      }),
    );

    // 2. Partial transcript
    (session as any).handleMessage(
      msg({
        type: 'response.audio_transcript.delta',
        delta: 'Let me check',
      }),
    );

    // 3. Function call
    (session as any).handleMessage(
      msg({
        type: 'response.function_call_arguments.done',
        call_id: 'c-1',
        name: 'search',
        arguments: '{"q":"test"}',
      }),
    );

    // 4. Final transcript
    (session as any).handleMessage(
      msg({
        type: 'response.audio_transcript.done',
        transcript: 'Let me check that for you.',
      }),
    );

    // 5. Response done
    (session as any).handleMessage(
      msg({
        type: 'response.done',
        response: { usage: { input_tokens: 50, output_tokens: 30, total_tokens: 80 } },
      }),
    );

    expect(audioHandler).toHaveBeenCalledTimes(1);
    expect(transcriptHandler).toHaveBeenCalledTimes(2); // delta + done
    expect(toolHandler).toHaveBeenCalledTimes(1);
    expect(turnHandler).toHaveBeenCalledTimes(1);
  });
});

// =============================================================================
// GEMINI LIVE FULL TURN
// =============================================================================

describe('Gemini Live — full turn event routing', () => {
  let session: GeminiLiveSession;
  let ws: ReturnType<typeof createMockWs>;

  beforeEach(() => {
    session = new GeminiLiveSession();
    ws = createMockWs();
    wireSession(session, ws);
  });

  test('setupComplete event sets flag', () => {
    expect((session as any).setupComplete).toBe(false);
    (session as any).handleMessage(msg({ setupComplete: true }));
    expect((session as any).setupComplete).toBe(true);
  });

  test('serverContent with audio → onAudio', () => {
    const audioHandler = vi.fn();
    session.on('onAudio', audioHandler);

    const audioData = Buffer.from('gemini-audio').toString('base64');
    (session as any).handleMessage(
      msg({
        serverContent: {
          modelTurn: { parts: [{ inlineData: { data: audioData } }] },
        },
      }),
    );

    expect(audioHandler).toHaveBeenCalledTimes(1);
    expect(audioHandler.mock.calls[0][0].toString()).toBe('gemini-audio');
  });

  test('serverContent with text → onTranscript', () => {
    const transcriptHandler = vi.fn();
    session.on('onTranscript', transcriptHandler);

    (session as any).handleMessage(
      msg({
        serverContent: {
          modelTurn: { parts: [{ text: 'Hello from Gemini' }] },
        },
      }),
    );

    expect(transcriptHandler).toHaveBeenCalledWith({
      text: 'Hello from Gemini',
      role: 'assistant',
      isFinal: false,
    });
  });

  test('serverContent with audio+text → both events', () => {
    const audioHandler = vi.fn();
    const transcriptHandler = vi.fn();
    session.on('onAudio', audioHandler);
    session.on('onTranscript', transcriptHandler);

    const audioData = Buffer.from('audio').toString('base64');
    (session as any).handleMessage(
      msg({
        serverContent: {
          modelTurn: {
            parts: [{ inlineData: { data: audioData } }, { text: 'Some text' }],
          },
        },
      }),
    );

    expect(audioHandler).toHaveBeenCalledTimes(1);
    expect(transcriptHandler).toHaveBeenCalledTimes(1);
  });

  test('turnComplete → onTurnEnd and final transcript', () => {
    const turnHandler = vi.fn();
    const transcriptHandler = vi.fn();
    session.on('onTurnEnd', turnHandler);
    session.on('onTranscript', transcriptHandler);

    (session as any).handleMessage(
      msg({
        serverContent: {
          modelTurn: { parts: [{ text: 'Goodbye' }] },
          turnComplete: true,
        },
      }),
    );

    expect(turnHandler).toHaveBeenCalledWith({});
    // Transcript should be final when turnComplete is true
    expect(transcriptHandler).toHaveBeenCalledWith({
      text: 'Goodbye',
      role: 'assistant',
      isFinal: true,
    });
  });

  test('content.interrupted → onInterrupted', () => {
    const interruptHandler = vi.fn();
    session.on('onInterrupted', interruptHandler);

    (session as any).handleMessage(
      msg({
        serverContent: { interrupted: true },
      }),
    );

    expect(interruptHandler).toHaveBeenCalledTimes(1);
  });

  test('toolCall.functionCalls → onToolCall for each function', () => {
    const toolHandler = vi.fn();
    session.on('onToolCall', toolHandler);

    (session as any).handleMessage(
      msg({
        toolCall: {
          functionCalls: [
            { id: 'fn-1', name: 'get_weather', args: { city: 'London' } },
            { name: 'get_time', args: { timezone: 'UTC' } },
          ],
        },
      }),
    );

    expect(toolHandler).toHaveBeenCalledTimes(2);
    expect(toolHandler.mock.calls[0][0]).toEqual({
      callId: 'fn-1',
      name: 'get_weather',
      arguments: '{"city":"London"}',
    });
    // Second call: name used as fallback for missing id
    expect(toolHandler.mock.calls[1][0].callId).toBe('get_time');
    expect(toolHandler.mock.calls[1][0].name).toBe('get_time');
  });

  test('turnComplete increments turn count in usage', () => {
    (session as any).handleMessage(
      msg({
        serverContent: { modelTurn: { parts: [] }, turnComplete: true },
      }),
    );
    (session as any).handleMessage(
      msg({
        serverContent: { modelTurn: { parts: [] }, turnComplete: true },
      }),
    );

    const metrics = session.getUsageMetrics();
    expect(metrics.turnCount).toBe(2);
  });
});

// =============================================================================
// ERROR RESILIENCE
// =============================================================================

describe('Error resilience', () => {
  test('OpenAI: malformed JSON does not throw', () => {
    const session = new OpenAIRealtimeSession();
    wireSession(session, createMockWs());
    expect(() => {
      (session as any).handleMessage({ toString: () => 'not{json' });
    }).not.toThrow();
  });

  test('Gemini: malformed JSON does not throw', () => {
    const session = new GeminiLiveSession();
    wireSession(session, createMockWs());
    expect(() => {
      (session as any).handleMessage({ toString: () => '{{bad' });
    }).not.toThrow();
  });

  test('OpenAI: handler error is caught', () => {
    const session = new OpenAIRealtimeSession();
    wireSession(session, createMockWs());

    const badHandler = vi.fn(() => {
      throw new Error('handler crash');
    });
    session.on('onInterrupted', badHandler);

    expect(() => {
      (session as any).handleMessage(msg({ type: 'input_audio_buffer.speech_started' }));
    }).not.toThrow();
    expect(badHandler).toHaveBeenCalled();
  });

  test('Gemini: handler error is caught', () => {
    const session = new GeminiLiveSession();
    wireSession(session, createMockWs());

    const badHandler = vi.fn(() => {
      throw new Error('handler crash');
    });
    session.on('onTurnEnd', badHandler);

    expect(() => {
      (session as any).handleMessage(
        msg({
          serverContent: { modelTurn: { parts: [] }, turnComplete: true },
        }),
      );
    }).not.toThrow();
    expect(badHandler).toHaveBeenCalled();
  });

  test('OpenAI: unknown events are silently ignored', () => {
    const session = new OpenAIRealtimeSession();
    wireSession(session, createMockWs());

    const errorHandler = vi.fn();
    session.on('onError', errorHandler);

    expect(() => {
      (session as any).handleMessage(msg({ type: 'rate_limits.updated', rate_limits: [] }));
    }).not.toThrow();
    expect(errorHandler).not.toHaveBeenCalled();
  });

  test('OpenAI: empty delta in audio event is handled', () => {
    const session = new OpenAIRealtimeSession();
    wireSession(session, createMockWs());

    const audioHandler = vi.fn();
    session.on('onAudio', audioHandler);

    (session as any).handleMessage(msg({ type: 'response.audio.delta', delta: '' }));
    expect(audioHandler).not.toHaveBeenCalled();
  });

  test('OpenAI: empty transcript in done event is handled', () => {
    const session = new OpenAIRealtimeSession();
    wireSession(session, createMockWs());

    const transcriptHandler = vi.fn();
    session.on('onTranscript', transcriptHandler);

    (session as any).handleMessage(msg({ type: 'response.audio_transcript.done', transcript: '' }));
    expect(transcriptHandler).not.toHaveBeenCalled();
  });

  test('Ultravox: handler error is caught', () => {
    const session = new UltravoxRealtimeSession();

    const badHandler = vi.fn(() => {
      throw new Error('handler crash');
    });
    session.on('onJoinUrl', badHandler);

    expect(() => {
      (session as any).emit('onJoinUrl', 'wss://example.com/join');
    }).not.toThrow();
    expect(badHandler).toHaveBeenCalled();
  });

  test('Ultravox: connection state change emits correctly', () => {
    const session = new UltravoxRealtimeSession();
    const stateHandler = vi.fn();
    session.on('onConnectionStateChange', stateHandler);

    (session as any).setConnectionState('connecting');
    expect(stateHandler).toHaveBeenCalledWith('connecting');

    (session as any).setConnectionState('connected');
    expect(stateHandler).toHaveBeenCalledWith('connected');

    // Same state should not re-emit
    stateHandler.mockClear();
    (session as any).setConnectionState('connected');
    expect(stateHandler).not.toHaveBeenCalled();
  });

  test('Ultravox: setConnectionState deduplicates', () => {
    const session = new UltravoxRealtimeSession();
    const handler = vi.fn();
    session.on('onConnectionStateChange', handler);

    (session as any).setConnectionState('connecting');
    (session as any).setConnectionState('connecting');
    (session as any).setConnectionState('connecting');

    expect(handler).toHaveBeenCalledTimes(1);
  });
});
