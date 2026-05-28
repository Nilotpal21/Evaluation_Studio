/**
 * Realtime Voice Provider Registry + Adapter Unit Tests
 *
 * Tests the provider registry (register/retrieve/create) and all adapter
 * implementations (OpenAI Realtime, Gemini Live, Ultravox) at the unit level.
 * Only the WebSocket transport is mocked — all other logic is real.
 */

import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../platform/logger.js', () => ({
  createLogger: vi.fn().mockReturnValue({
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

import {
  registerRealtimeProvider,
  getRealtimeProviderFactory,
  createRealtimeSession,
  getRegisteredRealtimeProviders,
} from '../platform/llm/realtime/provider.js';
import { OpenAIRealtimeSession } from '../platform/llm/realtime/openai-realtime.js';
import { GeminiLiveSession } from '../platform/llm/realtime/gemini-live.js';
import { UltravoxRealtimeSession } from '../platform/llm/realtime/ultravox-realtime.js';
import type {
  RealtimeVoiceSession,
  RealtimeVoiceSessionEvents,
  RealtimeSessionConfig,
  RealtimeUsageMetrics,
} from '../platform/llm/realtime/types.js';

// =============================================================================
// HELPERS
// =============================================================================

// Capture native fetch before any test replaces it
const nativeFetch = globalThis.fetch;

function createMockWs() {
  return {
    readyState: 1, // OPEN
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

// =============================================================================
// REGISTRY TESTS
// =============================================================================

describe('Realtime Provider Registry', () => {
  test('registerRealtimeProvider stores a factory', () => {
    const factory = () => new OpenAIRealtimeSession();
    registerRealtimeProvider('openai_realtime', factory);
    expect(getRealtimeProviderFactory('openai_realtime')).toBe(factory);
  });

  test('overwriting a factory replaces the previous one', () => {
    const factoryA = () => new OpenAIRealtimeSession();
    const factoryB = () => new OpenAIRealtimeSession();
    registerRealtimeProvider('openai_realtime', factoryA);
    registerRealtimeProvider('openai_realtime', factoryB);
    expect(getRealtimeProviderFactory('openai_realtime')).toBe(factoryB);
  });

  test('getRealtimeProviderFactory returns undefined for unknown type', () => {
    expect(getRealtimeProviderFactory('unknown_type' as any)).toBeUndefined();
  });

  test('createRealtimeSession returns an instance from the factory', () => {
    registerRealtimeProvider('openai_realtime', () => new OpenAIRealtimeSession());
    const session = createRealtimeSession('openai_realtime');
    expect(session).toBeInstanceOf(OpenAIRealtimeSession);
    expect(session.providerType).toBe('openai_realtime');
  });

  test('createRealtimeSession throws for unknown provider with available list', () => {
    registerRealtimeProvider('openai_realtime', () => new OpenAIRealtimeSession());
    registerRealtimeProvider('gemini_live', () => new GeminiLiveSession());

    expect(() => createRealtimeSession('nonexistent' as any)).toThrow(
      /Unknown realtime provider: nonexistent/,
    );
    expect(() => createRealtimeSession('nonexistent' as any)).toThrow(/Available providers:/);
  });

  test('getRegisteredRealtimeProviders reflects registered types', () => {
    registerRealtimeProvider('openai_realtime', () => new OpenAIRealtimeSession());
    registerRealtimeProvider('gemini_live', () => new GeminiLiveSession());
    registerRealtimeProvider('ultravox', () => new UltravoxRealtimeSession());
    const providers = getRegisteredRealtimeProviders();
    expect(providers).toContain('openai_realtime');
    expect(providers).toContain('gemini_live');
    expect(providers).toContain('ultravox');
  });

  test('createRealtimeSession returns UltravoxRealtimeSession for ultravox', () => {
    registerRealtimeProvider('ultravox', () => new UltravoxRealtimeSession());
    const session = createRealtimeSession('ultravox');
    expect(session).toBeInstanceOf(UltravoxRealtimeSession);
    expect(session.providerType).toBe('ultravox');
  });
});

// =============================================================================
// OPENAI REALTIME SESSION TESTS
// =============================================================================

describe('OpenAIRealtimeSession', () => {
  let session: OpenAIRealtimeSession;

  beforeEach(() => {
    session = new OpenAIRealtimeSession();
  });

  describe('initial state', () => {
    test('providerType is openai_realtime', () => {
      expect(session.providerType).toBe('openai_realtime');
    });

    test('connectionState is disconnected', () => {
      expect(session.connectionState).toBe('disconnected');
    });

    test('usage metrics are zero', () => {
      const metrics = session.getUsageMetrics();
      expect(metrics.inputTokens).toBe(0);
      expect(metrics.outputTokens).toBe(0);
      expect(metrics.totalTokens).toBe(0);
      expect(metrics.turnCount).toBe(0);
      expect(metrics.audioDurationInMs).toBe(0);
      expect(metrics.audioDurationOutMs).toBe(0);
      expect(metrics.connectionDurationMs).toBe(0);
    });
  });

  describe('no-ops when disconnected', () => {
    test('sendAudio does nothing when disconnected', () => {
      expect(() => session.sendAudio(Buffer.from('audio'))).not.toThrow();
    });

    test('commitAudioBuffer does nothing when disconnected', () => {
      expect(() => session.commitAudioBuffer()).not.toThrow();
    });

    test('cancelResponse does nothing when disconnected', () => {
      expect(() => session.cancelResponse()).not.toThrow();
    });

    test('submitToolResult does nothing when disconnected', () => {
      expect(() => session.submitToolResult('call-1', '{"result":"ok"}')).not.toThrow();
    });

    test('updateSystemPrompt does nothing when disconnected', () => {
      expect(() => session.updateSystemPrompt('New prompt')).not.toThrow();
    });

    test('updateTools does nothing when disconnected', () => {
      expect(() => session.updateTools([])).not.toThrow();
    });
  });

  describe('event handler registration', () => {
    test('on/off registers and removes handlers', () => {
      const handler = vi.fn();
      session.on('onAudio', handler);

      // Trigger via internal emit to verify registration
      const ws = createMockWs();
      wireSession(session, ws);
      (session as any).emit('onAudio', Buffer.from('test'));
      expect(handler).toHaveBeenCalledWith(Buffer.from('test'));

      session.off('onAudio', handler);
      handler.mockClear();
      (session as any).emit('onAudio', Buffer.from('test2'));
      expect(handler).not.toHaveBeenCalled();
    });

    test('multiple handlers for same event', () => {
      const handlerA = vi.fn();
      const handlerB = vi.fn();
      session.on('onTranscript', handlerA);
      session.on('onTranscript', handlerB);

      const transcript = { text: 'hello', role: 'user' as const, isFinal: true };
      (session as any).emit('onTranscript', transcript);
      expect(handlerA).toHaveBeenCalledWith(transcript);
      expect(handlerB).toHaveBeenCalledWith(transcript);
    });
  });

  describe('getUsageMetrics', () => {
    test('returns a snapshot (not a reference)', () => {
      const m1 = session.getUsageMetrics();
      const m2 = session.getUsageMetrics();
      expect(m1).not.toBe(m2);
      expect(m1).toEqual(m2);
    });
  });

  describe('sending events when connected', () => {
    let ws: ReturnType<typeof createMockWs>;

    beforeEach(() => {
      ws = createMockWs();
      wireSession(session, ws);
    });

    test('sendAudio sends base64-encoded audio', () => {
      const audio = Buffer.from('hello-audio');
      session.sendAudio(audio);
      expect(ws.send).toHaveBeenCalledTimes(1);
      const sent = JSON.parse(ws.send.mock.calls[0][0]);
      expect(sent.type).toBe('input_audio_buffer.append');
      expect(sent.audio).toBe(audio.toString('base64'));
    });

    test('commitAudioBuffer sends commit event', () => {
      session.commitAudioBuffer();
      expect(ws.send).toHaveBeenCalledTimes(1);
      const sent = JSON.parse(ws.send.mock.calls[0][0]);
      expect(sent.type).toBe('input_audio_buffer.commit');
    });

    test('cancelResponse sends cancel event', () => {
      session.cancelResponse();
      expect(ws.send).toHaveBeenCalledTimes(1);
      const sent = JSON.parse(ws.send.mock.calls[0][0]);
      expect(sent.type).toBe('response.cancel');
    });

    test('submitToolResult sends conversation item and response create', () => {
      session.submitToolResult('call-123', '{"value": 42}');
      expect(ws.send).toHaveBeenCalledTimes(2);

      const item = JSON.parse(ws.send.mock.calls[0][0]);
      expect(item.type).toBe('conversation.item.create');
      expect(item.item.type).toBe('function_call_output');
      expect(item.item.call_id).toBe('call-123');
      expect(item.item.output).toBe('{"value": 42}');

      const responseCreate = JSON.parse(ws.send.mock.calls[1][0]);
      expect(responseCreate.type).toBe('response.create');
    });

    test('updateSystemPrompt sends session.update with instructions', () => {
      session.updateSystemPrompt('New system prompt');
      expect(ws.send).toHaveBeenCalledTimes(1);
      const sent = JSON.parse(ws.send.mock.calls[0][0]);
      expect(sent.type).toBe('session.update');
      expect(sent.session.instructions).toBe('New system prompt');
    });

    test('updateTools sends session.update with tool definitions', () => {
      session.updateTools([
        {
          name: 'get_weather',
          description: 'Get weather',
          input_schema: { type: 'object', properties: {} },
        },
      ]);
      expect(ws.send).toHaveBeenCalledTimes(1);
      const sent = JSON.parse(ws.send.mock.calls[0][0]);
      expect(sent.type).toBe('session.update');
      expect(sent.session.tools).toHaveLength(1);
      expect(sent.session.tools[0].type).toBe('function');
      expect(sent.session.tools[0].name).toBe('get_weather');
    });

    test('sendEvent skipped when ws.readyState is not OPEN', () => {
      ws.readyState = 3; // CLOSED
      session.sendAudio(Buffer.from('data'));
      expect(ws.send).not.toHaveBeenCalled();
    });
  });

  describe('server event handling', () => {
    let ws: ReturnType<typeof createMockWs>;

    beforeEach(() => {
      ws = createMockWs();
      wireSession(session, ws);
    });

    test('response.audio.delta emits onAudio with buffer', () => {
      const handler = vi.fn();
      session.on('onAudio', handler);
      const audioData = Buffer.from('test-audio').toString('base64');
      (session as any).handleMessage({
        toString: () => JSON.stringify({ type: 'response.audio.delta', delta: audioData }),
      });
      expect(handler).toHaveBeenCalledTimes(1);
      expect(handler.mock.calls[0][0]).toBeInstanceOf(Buffer);
    });

    test('response.audio_transcript.delta emits partial transcript', () => {
      const handler = vi.fn();
      session.on('onTranscript', handler);
      (session as any).handleMessage({
        toString: () => JSON.stringify({ type: 'response.audio_transcript.delta', delta: 'hel' }),
      });
      expect(handler).toHaveBeenCalledWith({ text: 'hel', role: 'assistant', isFinal: false });
    });

    test('response.audio_transcript.done emits final transcript', () => {
      const handler = vi.fn();
      session.on('onTranscript', handler);
      (session as any).handleMessage({
        toString: () =>
          JSON.stringify({ type: 'response.audio_transcript.done', transcript: 'hello world' }),
      });
      expect(handler).toHaveBeenCalledWith({
        text: 'hello world',
        role: 'assistant',
        isFinal: true,
      });
    });

    test('input_audio_transcription.completed emits user transcript', () => {
      const handler = vi.fn();
      session.on('onTranscript', handler);
      (session as any).handleMessage({
        toString: () =>
          JSON.stringify({
            type: 'conversation.item.input_audio_transcription.completed',
            transcript: 'user said this',
          }),
      });
      expect(handler).toHaveBeenCalledWith({ text: 'user said this', role: 'user', isFinal: true });
    });

    test('response.function_call_arguments.done emits onToolCall', () => {
      const handler = vi.fn();
      session.on('onToolCall', handler);
      (session as any).handleMessage({
        toString: () =>
          JSON.stringify({
            type: 'response.function_call_arguments.done',
            call_id: 'call-1',
            name: 'get_weather',
            arguments: '{"city":"SF"}',
          }),
      });
      expect(handler).toHaveBeenCalledWith({
        callId: 'call-1',
        name: 'get_weather',
        arguments: '{"city":"SF"}',
      });
    });

    test('response.done emits onTurnEnd with usage', () => {
      const handler = vi.fn();
      session.on('onTurnEnd', handler);
      (session as any).handleMessage({
        toString: () =>
          JSON.stringify({
            type: 'response.done',
            response: { usage: { input_tokens: 100, output_tokens: 50, total_tokens: 150 } },
          }),
      });
      expect(handler).toHaveBeenCalledWith({
        inputTokens: 100,
        outputTokens: 50,
        totalTokens: 150,
      });
    });

    test('response.done accumulates usage metrics', () => {
      (session as any).handleMessage({
        toString: () =>
          JSON.stringify({
            type: 'response.done',
            response: { usage: { input_tokens: 100, output_tokens: 50, total_tokens: 150 } },
          }),
      });
      (session as any).handleMessage({
        toString: () =>
          JSON.stringify({
            type: 'response.done',
            response: { usage: { input_tokens: 200, output_tokens: 100, total_tokens: 300 } },
          }),
      });
      const metrics = session.getUsageMetrics();
      expect(metrics.inputTokens).toBe(300);
      expect(metrics.outputTokens).toBe(150);
      expect(metrics.totalTokens).toBe(450);
      expect(metrics.turnCount).toBe(2);
    });

    test('input_audio_buffer.speech_started emits onInterrupted', () => {
      const handler = vi.fn();
      session.on('onInterrupted', handler);
      (session as any).handleMessage({
        toString: () => JSON.stringify({ type: 'input_audio_buffer.speech_started' }),
      });
      expect(handler).toHaveBeenCalledTimes(1);
    });

    test('error event emits onError', () => {
      const handler = vi.fn();
      session.on('onError', handler);
      (session as any).handleMessage({
        toString: () =>
          JSON.stringify({
            type: 'error',
            error: { message: 'rate_limit_exceeded', type: 'rate_limit', code: '429' },
          }),
      });
      expect(handler).toHaveBeenCalledTimes(1);
      expect(handler.mock.calls[0][0]).toBeInstanceOf(Error);
      expect(handler.mock.calls[0][0].message).toBe('rate_limit_exceeded');
    });

    test('malformed JSON is handled gracefully', () => {
      expect(() => {
        (session as any).handleMessage({ toString: () => 'not-json{' });
      }).not.toThrow();
    });

    test('unknown event types are silently ignored', () => {
      expect(() => {
        (session as any).handleMessage({
          toString: () => JSON.stringify({ type: 'rate_limits.updated', data: {} }),
        });
      }).not.toThrow();
    });

    test('handler error is caught and does not propagate', () => {
      const badHandler = vi.fn().mockImplementation(() => {
        throw new Error('handler exploded');
      });
      session.on('onAudio', badHandler);

      expect(() => {
        (session as any).emit('onAudio', Buffer.from('test'));
      }).not.toThrow();
      expect(badHandler).toHaveBeenCalled();
    });
  });
});

// =============================================================================
// GEMINI LIVE SESSION TESTS
// =============================================================================

describe('GeminiLiveSession', () => {
  let session: GeminiLiveSession;

  beforeEach(() => {
    session = new GeminiLiveSession();
  });

  describe('initial state', () => {
    test('providerType is gemini_live', () => {
      expect(session.providerType).toBe('gemini_live');
    });

    test('connectionState is disconnected', () => {
      expect(session.connectionState).toBe('disconnected');
    });

    test('usage metrics are zero', () => {
      const metrics = session.getUsageMetrics();
      expect(metrics.inputTokens).toBe(0);
      expect(metrics.outputTokens).toBe(0);
      expect(metrics.turnCount).toBe(0);
    });
  });

  describe('audio gating by setupComplete', () => {
    test('sendAudio is no-op when setupComplete is false', () => {
      const ws = createMockWs();
      wireSession(session, ws);
      // setupComplete defaults to false
      session.sendAudio(Buffer.from('audio'));
      expect(ws.send).not.toHaveBeenCalled();
    });

    test('sendAudio works after setupComplete', () => {
      const ws = createMockWs();
      wireSession(session, ws);
      (session as any).setupComplete = true;
      session.sendAudio(Buffer.from('audio'));
      expect(ws.send).toHaveBeenCalledTimes(1);
      const sent = JSON.parse(ws.send.mock.calls[0][0]);
      expect(sent.realtimeInput.mediaChunks[0].mimeType).toBe('audio/pcm;rate=24000');
    });
  });

  describe('mid-session update limitations', () => {
    test('updateSystemPrompt logs warning but does not send', () => {
      const ws = createMockWs();
      wireSession(session, ws);
      session.updateSystemPrompt('new prompt');
      expect(ws.send).not.toHaveBeenCalled();
    });

    test('updateTools logs warning but does not send', () => {
      const ws = createMockWs();
      wireSession(session, ws);
      session.updateTools([
        { name: 'tool1', description: '', input_schema: { type: 'object', properties: {} } },
      ]);
      expect(ws.send).not.toHaveBeenCalled();
    });
  });

  describe('cancelResponse emits onInterrupted', () => {
    test('cancelResponse sends turnComplete and emits onInterrupted', () => {
      const ws = createMockWs();
      wireSession(session, ws);
      const handler = vi.fn();
      session.on('onInterrupted', handler);
      session.cancelResponse();
      expect(ws.send).toHaveBeenCalledTimes(1);
      const sent = JSON.parse(ws.send.mock.calls[0][0]);
      expect(sent.clientContent.turnComplete).toBe(true);
      expect(handler).toHaveBeenCalledTimes(1);
    });
  });

  describe('sending events when connected', () => {
    let ws: ReturnType<typeof createMockWs>;

    beforeEach(() => {
      ws = createMockWs();
      wireSession(session, ws);
    });

    test('commitAudioBuffer sends turnComplete', () => {
      session.commitAudioBuffer();
      expect(ws.send).toHaveBeenCalledTimes(1);
      const sent = JSON.parse(ws.send.mock.calls[0][0]);
      expect(sent.clientContent.turnComplete).toBe(true);
    });

    test('submitToolResult sends toolResponse', () => {
      session.submitToolResult('fn-1', '{"result":"ok"}');
      expect(ws.send).toHaveBeenCalledTimes(1);
      const sent = JSON.parse(ws.send.mock.calls[0][0]);
      expect(sent.toolResponse.functionResponses[0].id).toBe('fn-1');
      expect(sent.toolResponse.functionResponses[0].response.result).toBe('{"result":"ok"}');
    });
  });

  describe('server event handling', () => {
    let ws: ReturnType<typeof createMockWs>;

    beforeEach(() => {
      ws = createMockWs();
      wireSession(session, ws);
    });

    test('setupComplete event sets flag', () => {
      expect((session as any).setupComplete).toBe(false);
      (session as any).handleMessage({ toString: () => JSON.stringify({ setupComplete: true }) });
      expect((session as any).setupComplete).toBe(true);
    });

    test('serverContent with audio emits onAudio', () => {
      const handler = vi.fn();
      session.on('onAudio', handler);
      const audioData = Buffer.from('audio-data').toString('base64');
      (session as any).handleMessage({
        toString: () =>
          JSON.stringify({
            serverContent: {
              modelTurn: { parts: [{ inlineData: { data: audioData } }] },
            },
          }),
      });
      expect(handler).toHaveBeenCalledTimes(1);
      expect(handler.mock.calls[0][0]).toBeInstanceOf(Buffer);
    });

    test('serverContent with text emits onTranscript', () => {
      const handler = vi.fn();
      session.on('onTranscript', handler);
      (session as any).handleMessage({
        toString: () =>
          JSON.stringify({
            serverContent: {
              modelTurn: { parts: [{ text: 'hello there' }] },
            },
          }),
      });
      expect(handler).toHaveBeenCalledWith({
        text: 'hello there',
        role: 'assistant',
        isFinal: false,
      });
    });

    test('serverContent with turnComplete emits final transcript and onTurnEnd', () => {
      const transcriptHandler = vi.fn();
      const turnHandler = vi.fn();
      session.on('onTranscript', transcriptHandler);
      session.on('onTurnEnd', turnHandler);
      (session as any).handleMessage({
        toString: () =>
          JSON.stringify({
            serverContent: {
              modelTurn: { parts: [{ text: 'done talking' }] },
              turnComplete: true,
            },
          }),
      });
      expect(transcriptHandler).toHaveBeenCalledWith({
        text: 'done talking',
        role: 'assistant',
        isFinal: true,
      });
      expect(turnHandler).toHaveBeenCalledWith({});
    });

    test('serverContent.interrupted emits onInterrupted', () => {
      const handler = vi.fn();
      session.on('onInterrupted', handler);
      (session as any).handleMessage({
        toString: () =>
          JSON.stringify({
            serverContent: { interrupted: true },
          }),
      });
      expect(handler).toHaveBeenCalledTimes(1);
    });

    test('toolCall.functionCalls emits onToolCall', () => {
      const handler = vi.fn();
      session.on('onToolCall', handler);
      (session as any).handleMessage({
        toString: () =>
          JSON.stringify({
            toolCall: {
              functionCalls: [
                { id: 'fn-1', name: 'search', args: { query: 'hello' } },
                { name: 'lookup', args: { id: 42 } },
              ],
            },
          }),
      });
      expect(handler).toHaveBeenCalledTimes(2);
      expect(handler.mock.calls[0][0]).toEqual({
        callId: 'fn-1',
        name: 'search',
        arguments: '{"query":"hello"}',
      });
      // Second call uses name as fallback for id
      expect(handler.mock.calls[1][0].callId).toBe('lookup');
    });

    test('malformed JSON handled gracefully', () => {
      expect(() => {
        (session as any).handleMessage({ toString: () => '{invalid json}' });
      }).not.toThrow();
    });

    test('handler error is caught', () => {
      const badHandler = vi.fn(() => {
        throw new Error('boom');
      });
      session.on('onAudio', badHandler);
      expect(() => {
        (session as any).emit('onAudio', Buffer.from('test'));
      }).not.toThrow();
    });
  });
});

// =============================================================================
// ULTRAVOX REALTIME SESSION TESTS
// =============================================================================

const ULTRAVOX_API_KEY = process.env.ULTRAVOX_API_KEY;
const skipUltravox = !ULTRAVOX_API_KEY;
const describeUltravox = skipUltravox ? describe.skip : describe;

describe('UltravoxRealtimeSession', () => {
  let session: UltravoxRealtimeSession;

  beforeEach(() => {
    session = new UltravoxRealtimeSession();
  });

  describe('initial state', () => {
    test('providerType is ultravox', () => {
      expect(session.providerType).toBe('ultravox');
    });

    test('connectionState is disconnected', () => {
      expect(session.connectionState).toBe('disconnected');
    });

    test('usage metrics are zero', () => {
      const metrics = session.getUsageMetrics();
      expect(metrics.inputTokens).toBe(0);
      expect(metrics.outputTokens).toBe(0);
      expect(metrics.totalTokens).toBe(0);
      expect(metrics.turnCount).toBe(0);
      expect(metrics.audioDurationInMs).toBe(0);
      expect(metrics.audioDurationOutMs).toBe(0);
      expect(metrics.connectionDurationMs).toBe(0);
    });
  });

  describe('no-op audio methods (audio streams client-side)', () => {
    test('sendAudio does not throw', () => {
      expect(() => session.sendAudio(Buffer.from('audio'))).not.toThrow();
    });

    test('commitAudioBuffer does not throw', () => {
      expect(() => session.commitAudioBuffer()).not.toThrow();
    });

    test('cancelResponse does not throw', () => {
      expect(() => session.cancelResponse()).not.toThrow();
    });

    test('submitToolResult does not throw', () => {
      expect(() => session.submitToolResult('call-1', '{"result":"ok"}')).not.toThrow();
    });

    test('updateSystemPrompt does not throw', () => {
      expect(() => session.updateSystemPrompt('New prompt')).not.toThrow();
    });

    test('updateTools does not throw', () => {
      expect(() => session.updateTools([])).not.toThrow();
    });
  });

  describe('event handler registration', () => {
    test('on/off registers and removes handlers', () => {
      const handler = vi.fn();
      session.on('onJoinUrl', handler);

      (session as any).emit('onJoinUrl', 'wss://example.com/join');
      expect(handler).toHaveBeenCalledWith('wss://example.com/join');

      session.off('onJoinUrl', handler);
      handler.mockClear();
      (session as any).emit('onJoinUrl', 'wss://example.com/join2');
      expect(handler).not.toHaveBeenCalled();
    });

    test('multiple handlers for same event', () => {
      const handlerA = vi.fn();
      const handlerB = vi.fn();
      session.on('onConnectionStateChange', handlerA);
      session.on('onConnectionStateChange', handlerB);

      (session as any).emit('onConnectionStateChange', 'connected');
      expect(handlerA).toHaveBeenCalledWith('connected');
      expect(handlerB).toHaveBeenCalledWith('connected');
    });

    test('handler error is caught and does not propagate', () => {
      const badHandler = vi.fn().mockImplementation(() => {
        throw new Error('handler exploded');
      });
      session.on('onJoinUrl', badHandler);

      expect(() => {
        (session as any).emit('onJoinUrl', 'wss://example.com/join');
      }).not.toThrow();
      expect(badHandler).toHaveBeenCalled();
    });
  });

  describe('getUsageMetrics', () => {
    test('returns a snapshot (not a reference)', () => {
      const m1 = session.getUsageMetrics();
      const m2 = session.getUsageMetrics();
      expect(m1).not.toBe(m2);
      expect(m1).toEqual(m2);
    });
  });

  describe('buildCallPayload', () => {
    const baseConfig: RealtimeSessionConfig = {
      model: 'fixie-ai/ultravox',
      systemPrompt: 'You are a helpful assistant.',
      apiKey: 'test-key',
      voice: 'Mark-English',
      temperature: 0.7,
    };

    test('builds minimal payload with defaults', () => {
      const payload = (session as any).buildCallPayload(baseConfig);
      expect(payload.model).toBe('fixie-ai/ultravox');
      expect(payload.systemPrompt).toBe('You are a helpful assistant.');
      expect(payload.voice).toBe('Mark-English');
      expect(payload.temperature).toBe(0.7);
      expect(payload.joinTimeout).toBe('30s');
      expect(payload.maxDuration).toBe('3600s');
      expect(payload.recordingEnabled).toBe(false);
    });

    test('uses default voice when not specified', () => {
      const config = { ...baseConfig, voice: undefined };
      const payload = (session as any).buildCallPayload(config);
      expect(payload.voice).toBe('Tanya-English');
    });

    test('uses default temperature when not specified', () => {
      const config = { ...baseConfig, temperature: undefined };
      const payload = (session as any).buildCallPayload(config);
      expect(payload.temperature).toBe(0.5);
    });

    test('includes optional fields when provided', () => {
      const config: RealtimeSessionConfig = {
        ...baseConfig,
        languageHint: 'en',
        timeExceededMessage: 'Time is up!',
        recordingEnabled: true,
        joinTimeout: '60s',
        maxDuration: '1800s',
      };
      const payload = (session as any).buildCallPayload(config);
      expect(payload.languageHint).toBe('en');
      expect(payload.timeExceededMessage).toBe('Time is up!');
      expect(payload.recordingEnabled).toBe(true);
      expect(payload.joinTimeout).toBe('60s');
      expect(payload.maxDuration).toBe('1800s');
    });

    test('includes firstSpeakerSettings when firstSpeaker is set', () => {
      const config: RealtimeSessionConfig = {
        ...baseConfig,
        firstSpeaker: 'agent',
        firstSpeakerMessage: 'Hello!',
      };
      const payload = (session as any).buildCallPayload(config);
      expect(payload.firstSpeakerSettings).toBeDefined();
      expect(payload.firstSpeakerSettings.agent).toBeDefined();
    });

    test('includes vadSettings from turnDetection', () => {
      const config: RealtimeSessionConfig = {
        ...baseConfig,
        turnDetection: {
          type: 'server_vad',
          turnEndpointDelay: '500ms',
          minimumTurnDuration: '200ms',
          minimumInterruptionDuration: '100ms',
          frameActivationThreshold: 0.3,
        },
      };
      const payload = (session as any).buildCallPayload(config);
      expect(payload.vadSettings).toEqual({
        turnEndpointDelay: '500ms',
        minimumTurnDuration: '200ms',
        minimumInterruptionDuration: '100ms',
        frameActivationThreshold: 0.3,
      });
    });

    test('converts tools to Ultravox temporaryTool format', () => {
      const config: RealtimeSessionConfig = {
        ...baseConfig,
        tools: [
          {
            name: 'get_weather',
            description: 'Get the current weather',
            input_schema: {
              type: 'object',
              properties: {
                city: { type: 'string', description: 'City name' },
                units: { type: 'string', enum: ['celsius', 'fahrenheit'] },
              },
              required: ['city'],
            },
          },
        ],
      };
      const payload = (session as any).buildCallPayload(config);
      expect(payload.selectedTools).toHaveLength(1);

      const tool = payload.selectedTools[0];
      expect(tool.temporaryTool.modelToolName).toBe('get_weather');
      expect(tool.temporaryTool.description).toBe('Get the current weather');
      expect(tool.temporaryTool.dynamicParameters).toHaveLength(2);

      const cityParam = tool.temporaryTool.dynamicParameters.find((p: any) => p.name === 'city');
      expect(cityParam.location).toBe('PARAMETER_LOCATION_BODY');
      expect(cityParam.required).toBe(true);
      expect(cityParam.schema.type).toBe('string');

      const unitsParam = tool.temporaryTool.dynamicParameters.find((p: any) => p.name === 'units');
      expect(unitsParam.required).toBe(false);
    });

    test('omits selectedTools when tools array is empty', () => {
      const config: RealtimeSessionConfig = { ...baseConfig, tools: [] };
      const payload = (session as any).buildCallPayload(config);
      expect(payload.selectedTools).toBeUndefined();
    });

    test('includes inactivityMessages when inactivityMessage is set', () => {
      const config: RealtimeSessionConfig = {
        ...baseConfig,
        inactivityMessage: 'Are you still there?',
      };
      const payload = (session as any).buildCallPayload(config);
      expect(payload.inactivityMessages).toEqual([
        { duration: '30s', message: 'Are you still there?' },
      ]);
    });
  });

  describe('connect with mocked fetch', () => {
    let originalFetch: typeof globalThis.fetch;

    beforeEach(() => {
      originalFetch = globalThis.fetch;
    });

    afterEach(async () => {
      // Clean up polling timer
      await session.disconnect().catch(() => {});
      globalThis.fetch = originalFetch;
    });

    test('successful connect sets state to connected and emits onJoinUrl', async () => {
      const joinUrlHandler = vi.fn();
      const stateHandler = vi.fn();
      session.on('onJoinUrl', joinUrlHandler);
      session.on('onConnectionStateChange', stateHandler);

      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            callId: 'call-123',
            joinUrl: 'wss://ultravox.ai/join/abc',
            created: new Date().toISOString(),
          }),
      });

      await session.connect({
        model: 'fixie-ai/ultravox',
        systemPrompt: 'Test',
        apiKey: 'test-key',
      });

      expect(session.connectionState).toBe('connected');
      expect(joinUrlHandler).toHaveBeenCalledWith('wss://ultravox.ai/join/abc');
      expect(stateHandler).toHaveBeenCalledWith('connecting');
      expect(stateHandler).toHaveBeenCalledWith('connected');

      // Verify fetch was called with correct URL and headers
      expect(globalThis.fetch).toHaveBeenCalledWith(
        'https://api.ultravox.ai/api/calls',
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({
            'Content-Type': 'application/json',
            'X-API-Key': 'test-key',
          }),
        }),
      );
    });

    test('connect uses custom endpoint when provided', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            callId: 'call-456',
            joinUrl: 'wss://custom.ultravox.ai/join/xyz',
            created: new Date().toISOString(),
          }),
      });

      await session.connect({
        model: 'fixie-ai/ultravox',
        systemPrompt: 'Test',
        apiKey: 'test-key',
        endpoint: 'https://custom.ultravox.ai/api',
      });

      expect(globalThis.fetch).toHaveBeenCalledWith(
        'https://custom.ultravox.ai/api/calls',
        expect.any(Object),
      );
    });

    test('connect failure sets state to error and emits onError', async () => {
      const errorHandler = vi.fn();
      session.on('onError', errorHandler);

      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 401,
        text: () => Promise.resolve('Unauthorized'),
      });

      await expect(
        session.connect({
          model: 'fixie-ai/ultravox',
          systemPrompt: 'Test',
          apiKey: 'bad-key',
        }),
      ).rejects.toThrow('Ultravox API error 401: Unauthorized');

      expect(session.connectionState).toBe('error');
      expect(errorHandler).toHaveBeenCalledTimes(1);
      expect(errorHandler.mock.calls[0][0]).toBeInstanceOf(Error);
    });

    test('connect network failure sets state to error', async () => {
      const errorHandler = vi.fn();
      session.on('onError', errorHandler);

      globalThis.fetch = vi.fn().mockRejectedValue(new Error('Network error'));

      await expect(
        session.connect({
          model: 'fixie-ai/ultravox',
          systemPrompt: 'Test',
          apiKey: 'test-key',
        }),
      ).rejects.toThrow('Network error');

      expect(session.connectionState).toBe('error');
      expect(errorHandler).toHaveBeenCalledTimes(1);
    });
  });

  describe('disconnect with mocked fetch', () => {
    let originalFetch: typeof globalThis.fetch;

    beforeEach(() => {
      originalFetch = globalThis.fetch;
    });

    afterEach(() => {
      globalThis.fetch = originalFetch;
    });

    test('disconnect calls DELETE on the call endpoint', async () => {
      const fetchMock = vi.fn();
      globalThis.fetch = fetchMock;

      // First, connect
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            callId: 'call-to-delete',
            joinUrl: 'wss://ultravox.ai/join/abc',
            created: new Date().toISOString(),
          }),
      });

      await session.connect({
        model: 'fixie-ai/ultravox',
        systemPrompt: 'Test',
        apiKey: 'test-key',
      });

      // Now disconnect
      fetchMock.mockResolvedValueOnce({ ok: true });

      await session.disconnect();

      expect(session.connectionState).toBe('disconnected');

      // Second fetch call should be DELETE
      const deleteCall = fetchMock.mock.calls[1];
      expect(deleteCall[0]).toBe('https://api.ultravox.ai/api/calls/call-to-delete');
      expect(deleteCall[1].method).toBe('DELETE');
      expect(deleteCall[1].headers['X-API-Key']).toBe('test-key');
    });

    test('disconnect handles DELETE failure gracefully', async () => {
      const fetchMock = vi.fn();
      globalThis.fetch = fetchMock;

      // Connect
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            callId: 'call-xyz',
            joinUrl: 'wss://ultravox.ai/join/xyz',
            created: new Date().toISOString(),
          }),
      });

      await session.connect({
        model: 'fixie-ai/ultravox',
        systemPrompt: 'Test',
        apiKey: 'test-key',
      });

      // DELETE fails
      fetchMock.mockRejectedValueOnce(new Error('Network failure'));

      // Should not throw
      await expect(session.disconnect()).resolves.not.toThrow();
      expect(session.connectionState).toBe('disconnected');
    });

    test('disconnect without prior connect is safe', async () => {
      await expect(session.disconnect()).resolves.not.toThrow();
      expect(session.connectionState).toBe('disconnected');
    });
  });

  describe('status polling', () => {
    let originalFetch: typeof globalThis.fetch;

    beforeEach(() => {
      originalFetch = globalThis.fetch;
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
      globalThis.fetch = originalFetch;
    });

    test('status poll detects call ended and transitions to disconnected', async () => {
      const fetchMock = vi.fn();
      globalThis.fetch = fetchMock;

      // Connect
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            callId: 'poll-test',
            joinUrl: 'wss://ultravox.ai/join/poll',
            created: new Date().toISOString(),
          }),
      });

      await session.connect({
        model: 'fixie-ai/ultravox',
        systemPrompt: 'Test',
        apiKey: 'test-key',
      });

      expect(session.connectionState).toBe('connected');

      // Mock the status poll response — call ended normally
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ callId: 'poll-test', status: 'ended' }),
      });

      // Advance timers to trigger poll
      await vi.advanceTimersByTimeAsync(5000);

      expect(session.connectionState).toBe('disconnected');
    });

    test('status poll detects error status and emits onError', async () => {
      const fetchMock = vi.fn();
      globalThis.fetch = fetchMock;
      const errorHandler = vi.fn();

      // Connect
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            callId: 'error-test',
            joinUrl: 'wss://ultravox.ai/join/err',
            created: new Date().toISOString(),
          }),
      });

      await session.connect({
        model: 'fixie-ai/ultravox',
        systemPrompt: 'Test',
        apiKey: 'test-key',
      });

      session.on('onError', errorHandler);

      // Mock the status poll response — call ended with error
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            callId: 'error-test',
            status: 'error',
            errorMessage: 'Model overloaded',
          }),
      });

      await vi.advanceTimersByTimeAsync(5000);

      expect(session.connectionState).toBe('error');
      expect(errorHandler).toHaveBeenCalledTimes(1);
      expect(errorHandler.mock.calls[0][0].message).toBe('Model overloaded');
    });

    test('status poll failure does not crash', async () => {
      const fetchMock = vi.fn();
      globalThis.fetch = fetchMock;

      // Connect
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            callId: 'resilient-test',
            joinUrl: 'wss://ultravox.ai/join/res',
            created: new Date().toISOString(),
          }),
      });

      await session.connect({
        model: 'fixie-ai/ultravox',
        systemPrompt: 'Test',
        apiKey: 'test-key',
      });

      // Mock poll failure
      fetchMock.mockRejectedValueOnce(new Error('Network hiccup'));

      // Should not throw or change state
      await vi.advanceTimersByTimeAsync(5000);
      expect(session.connectionState).toBe('connected');

      // Clean up
      fetchMock.mockResolvedValueOnce({ ok: true });
      vi.useRealTimers();
      await session.disconnect();
    });
  });

  // ===========================================================================
  // Integration tests — only run when ULTRAVOX_API_KEY is available
  // ===========================================================================

  describeUltravox('integration (requires ULTRAVOX_API_KEY)', () => {
    // Use a dedicated session to avoid fetch mock leakage from unit tests
    let integrationSession: UltravoxRealtimeSession;

    beforeEach(() => {
      // Restore native fetch — unit tests replace globalThis.fetch with mocks
      globalThis.fetch = nativeFetch;
      integrationSession = new UltravoxRealtimeSession();
    });

    afterEach(async () => {
      await integrationSession.disconnect().catch(() => {});
    });

    test('connect to Ultravox API and receive joinUrl', async () => {
      const joinUrlHandler = vi.fn();
      const stateHandler = vi.fn();
      integrationSession.on('onJoinUrl', joinUrlHandler);
      integrationSession.on('onConnectionStateChange', stateHandler);

      await integrationSession.connect({
        model: 'fixie-ai/ultravox',
        systemPrompt: 'You are a test assistant. Say hello.',
        apiKey: ULTRAVOX_API_KEY!,
        voice: 'Tanya-English',
      });

      // Verify connection succeeded
      expect(integrationSession.connectionState).toBe('connected');

      // Verify joinUrl was emitted and is a valid WebSocket URL
      expect(joinUrlHandler).toHaveBeenCalledTimes(1);
      const joinUrl = joinUrlHandler.mock.calls[0][0] as string;
      expect(joinUrl).toMatch(/^wss?:\/\//);

      // Verify state transitions: connecting → connected
      expect(stateHandler).toHaveBeenCalledWith('connecting');
      expect(stateHandler).toHaveBeenCalledWith('connected');

      // Verify disconnect cleans up
      await integrationSession.disconnect();
      expect(integrationSession.connectionState).toBe('disconnected');
      expect(stateHandler).toHaveBeenCalledWith('disconnected');
    });

    test('connect with invalid API key returns 401', async () => {
      const errorHandler = vi.fn();
      integrationSession.on('onError', errorHandler);

      await expect(
        integrationSession.connect({
          model: 'fixie-ai/ultravox',
          systemPrompt: 'Test',
          apiKey: 'invalid-key-that-does-not-exist',
        }),
      ).rejects.toThrow(/Ultravox API error (401|403)/);

      expect(integrationSession.connectionState).toBe('error');
      expect(errorHandler).toHaveBeenCalledTimes(1);
    });
  });
});
