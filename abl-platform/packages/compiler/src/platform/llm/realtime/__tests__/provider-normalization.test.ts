import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

vi.mock('../../../logger.js', () => ({
  createLogger: vi.fn().mockReturnValue({
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

import { GeminiLiveSession } from '../gemini-live.js';
import { OpenAIRealtimeSession } from '../openai-realtime.js';
import type { NormalizedVoiceEvent, RealtimeToolCall, RealtimeTranscript } from '../types.js';
import { UltravoxRealtimeSession } from '../ultravox-realtime.js';

const nativeFetch = globalThis.fetch;

function collectNormalizedEvents(session: {
  on(event: 'onNormalizedEvent', handler: (event: NormalizedVoiceEvent) => void): void;
}) {
  const events: NormalizedVoiceEvent[] = [];
  session.on('onNormalizedEvent', (event) => events.push(event));
  return events;
}

describe('realtime provider normalization', () => {
  beforeEach(() => {
    globalThis.fetch = nativeFetch;
  });

  afterEach(() => {
    globalThis.fetch = nativeFetch;
    vi.restoreAllMocks();
  });

  test('OpenAI emits normalized transcript, tool, interruption, and turn-complete events', () => {
    const session = new OpenAIRealtimeSession();
    const normalizedEvents = collectNormalizedEvents(session);
    const transcripts: RealtimeTranscript[] = [];
    const toolCalls: RealtimeToolCall[] = [];
    const turnEnds: Array<Record<string, unknown>> = [];
    const interrupted = vi.fn();

    session.on('onTranscript', (transcript) => transcripts.push(transcript));
    session.on('onToolCall', (toolCall) => toolCalls.push(toolCall));
    session.on('onTurnEnd', (usage) => turnEnds.push(usage as Record<string, unknown>));
    session.on('onInterrupted', interrupted);

    const routeServerEvent = (session as any).routeServerEvent.bind(session);
    routeServerEvent({
      type: 'conversation.item.input_audio_transcription.delta',
      delta: 'hel',
    });
    routeServerEvent({
      type: 'response.audio_transcript.delta',
      delta: 'hello',
    });
    routeServerEvent({
      type: 'response.audio_transcript.done',
      transcript: 'hello there',
    });
    routeServerEvent({
      type: 'conversation.item.input_audio_transcription.completed',
      transcript: 'hi there',
    });
    routeServerEvent({
      type: 'response.function_call_arguments.done',
      call_id: 'call-1',
      name: 'lookup_weather',
      arguments: '{"city":"SF"}',
    });
    routeServerEvent({ type: 'input_audio_buffer.speech_started' });
    routeServerEvent({
      type: 'response.done',
      response: {
        usage: {
          input_tokens: 3,
          output_tokens: 5,
          total_tokens: 8,
        },
      },
    });

    expect(session.getCapabilityProfile().capabilities.supportsPromptRefresh).toBe(true);
    expect(transcripts).toEqual([
      { text: 'hello', role: 'assistant', isFinal: false },
      { text: 'hello there', role: 'assistant', isFinal: true },
      { text: 'hi there', role: 'user', isFinal: true },
    ]);
    expect(toolCalls).toEqual([
      {
        callId: 'call-1',
        name: 'lookup_weather',
        arguments: '{"city":"SF"}',
      },
    ]);
    expect(turnEnds).toEqual([
      {
        inputTokens: 3,
        outputTokens: 5,
        totalTokens: 8,
      },
    ]);
    expect(interrupted).toHaveBeenCalledTimes(1);
    expect(normalizedEvents.map((event) => event.type)).toEqual([
      'user_transcript_partial',
      'assistant_transcript_partial',
      'assistant_transcript_final',
      'user_transcript_final',
      'tool_call_requested',
      'turn_interrupted',
      'turn_completed',
    ]);
  });

  test('Gemini emits normalized assistant/tool/interruption events and keeps legacy callbacks', () => {
    const session = new GeminiLiveSession();
    const normalizedEvents = collectNormalizedEvents(session);
    const transcripts: RealtimeTranscript[] = [];
    const toolCalls: RealtimeToolCall[] = [];
    const turnEnds: Array<Record<string, unknown>> = [];
    const interrupted = vi.fn();

    session.on('onTranscript', (transcript) => transcripts.push(transcript));
    session.on('onToolCall', (toolCall) => toolCalls.push(toolCall));
    session.on('onTurnEnd', (usage) => turnEnds.push(usage as Record<string, unknown>));
    session.on('onInterrupted', interrupted);

    const routeServerEvent = (session as any).routeServerEvent.bind(session);
    routeServerEvent({
      serverContent: {
        modelTurn: { parts: [{ text: 'partial reply' }] },
        turnComplete: false,
      },
    });
    routeServerEvent({
      toolCall: {
        functionCalls: [
          {
            id: 'call-2',
            name: 'lookup_account',
            args: { accountId: 'acct-1' },
          },
        ],
      },
    });
    routeServerEvent({
      serverContent: {
        modelTurn: { parts: [{ text: 'final reply' }] },
        turnComplete: true,
        interrupted: true,
      },
    });

    expect(session.getCapabilityProfile().capabilities.supportsToolResultInjection).toBe(true);
    expect(session.getCapabilityProfile().capabilities.supportsPromptRefresh).toBe(false);
    expect(transcripts).toEqual([
      { text: 'partial reply', role: 'assistant', isFinal: false },
      { text: 'final reply', role: 'assistant', isFinal: true },
    ]);
    expect(toolCalls).toEqual([
      {
        callId: 'call-2',
        name: 'lookup_account',
        arguments: '{"accountId":"acct-1"}',
      },
    ]);
    expect(turnEnds).toEqual([{}]);
    expect(interrupted).toHaveBeenCalledTimes(1);
    expect(normalizedEvents.map((event) => event.type)).toEqual([
      'assistant_transcript_partial',
      'tool_call_requested',
      'assistant_transcript_final',
      'turn_completed',
      'turn_interrupted',
    ]);
  });

  test('Ultravox exposes immutable capability metadata and emits deterministic terminal lifecycle events', async () => {
    const session = new UltravoxRealtimeSession();
    const normalizedEvents = collectNormalizedEvents(session);
    const errors: Error[] = [];

    session.on('onError', (error) => errors.push(error));

    expect(session.getCapabilityProfile().capabilities.supportsToolRefresh).toBe(false);
    expect(session.getCapabilityProfile().capabilities.supportsToolResultInjection).toBe(false);

    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock as typeof fetch;

    (session as any).config = {
      apiKey: 'test-key',
      model: 'fixie-ai/ultravox',
      systemPrompt: 'System prompt',
    };
    (session as any).callId = 'call-ok';

    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        callId: 'call-ok',
        status: 'ended',
        ended: '2026-04-22T05:30:00.000Z',
      }),
    });

    await (session as any).pollCallStatus('https://api.ultravox.ai/api');

    (session as any).config = {
      apiKey: 'test-key',
      model: 'fixie-ai/ultravox',
      systemPrompt: 'System prompt',
    };
    (session as any).callId = 'call-error';

    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        callId: 'call-error',
        status: 'error',
        errorMessage: 'remote failure',
      }),
    });

    await (session as any).pollCallStatus('https://api.ultravox.ai/api');

    expect(errors).toHaveLength(1);
    expect(errors[0]?.message).toBe('remote failure');
    expect(normalizedEvents.map((event) => event.type)).toEqual([
      'turn_completed',
      'provider_error',
    ]);
    expect(normalizedEvents[0]).toMatchObject({
      type: 'turn_completed',
      providerType: 'ultravox',
      payload: {
        status: 'ended',
        partialLifecycle: true,
      },
    });
    expect(normalizedEvents[1]).toMatchObject({
      type: 'provider_error',
      providerType: 'ultravox',
      payload: {
        status: 'error',
        message: 'remote failure',
      },
    });
  });
});
