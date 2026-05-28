import { describe, expect, it } from 'vitest';
import {
  UltravoxTranscriptAccumulator,
  buildProviderAwareLlmVerbPayload,
  buildProviderToolErrorMessage,
  buildProviderToolResponseMessage,
  getS2SProviderFamily,
  getS2STraceProviderName,
  translateProviderEventToRealtimeEvents,
  type PromptToolDefinition,
} from '../services/voice/korevg/s2s-provider-adapter.js';

const PROMPT_TOOLS: PromptToolDefinition[] = [
  {
    name: 'lookup_booking',
    description: 'Look up an existing booking',
    input_schema: {
      type: 'object',
      properties: {
        confirmationCode: {
          type: 'string',
          description: 'Customer booking code',
        },
      },
      required: ['confirmationCode'],
    },
  },
];

describe('s2s-provider-adapter', () => {
  it('maps current ABL providers to the expected runtime families', () => {
    expect(getS2SProviderFamily('s2s:openai')).toBe('openai');
    expect(getS2SProviderFamily('s2s:microsoft')).toBe('openai');
    expect(getS2SProviderFamily('s2s:deepgram')).toBe('voiceagent');
    expect(getS2SProviderFamily('s2s:elevenlabs')).toBe('elevenlabs');
    expect(getS2SProviderFamily('s2s:ultravox')).toBe('ultravox');
    expect(getS2STraceProviderName('s2s:deepgram')).toBe('deepgram');
    expect(getS2STraceProviderName('s2s:microsoft')).toBe('azure_openai');
  });

  it('builds ElevenLabs payloads with conversation overrides', () => {
    const payload = buildProviderAwareLlmVerbPayload({
      provider: 's2s:elevenlabs',
      apiKey: 'eleven-key',
      instructions: 'You are a helpful reservations specialist.',
      s2sConfig: {
        agentId: 'agent_123',
        voice: '21m00Tcm4TlvDq8ikWAM',
        temperature: 0.6,
      },
      openAITools: [],
      promptTools: [],
      greetingMessage: 'Hi, thanks for calling.',
    });

    expect(payload.vendor).toBe('elevenlabs');
    expect(payload.auth).toMatchObject({
      agent_id: 'agent_123',
      api_key: 'eleven-key',
    });
    expect(payload.llmOptions).toMatchObject({
      conversation_initiation_client_data: {
        conversation_config_override: {
          agent: {
            prompt: { prompt: 'You are a helpful reservations specialist.' },
            first_message: 'Hi, thanks for calling.',
          },
          tts: {
            voice_id: '21m00Tcm4TlvDq8ikWAM',
          },
        },
      },
    });
  });

  it('builds Ultravox payloads with client tools and websocket data messages', () => {
    const payload = buildProviderAwareLlmVerbPayload({
      provider: 's2s:ultravox',
      apiKey: 'uv-key',
      instructions: 'Help callers book hotels.',
      s2sConfig: {
        agentId: 'agent_456',
        model: 'fixie-ai/ultravox-v0.7',
        temperature: 0.4,
      },
      openAITools: [],
      promptTools: PROMPT_TOOLS,
      greetingMessage: 'Hello from Ultravox.',
    });

    expect(payload.vendor).toBe('ultravox');
    expect(payload.toolHook).toBe('/llm-tool');
    expect(payload.auth).toMatchObject({
      apiKey: 'uv-key',
      agent_id: 'agent_456',
    });
    expect(payload.llmOptions).toMatchObject({
      systemPrompt: 'Help callers book hotels.',
      medium: {
        serverWebSocket: {
          inputSampleRate: 8000,
          outputSampleRate: 8000,
          dataMessages: {
            transcript: true,
            clientToolInvocation: true,
            userStartedSpeaking: true,
          },
        },
      },
      firstSpeakerSettings: {
        agent: {
          text: 'Hello from Ultravox.',
        },
      },
    });
    expect((payload.llmOptions.selectedTools as Array<Record<string, unknown>>)[0]).toMatchObject({
      temporaryTool: {
        modelToolName: 'lookup_booking',
      },
    });
  });

  it('builds Deepgram Voice Agent payloads with prompt, think config, and functions', () => {
    const payload = buildProviderAwareLlmVerbPayload({
      provider: 's2s:deepgram',
      apiKey: 'dg-key',
      instructions: 'Help callers change reservations.',
      s2sConfig: {
        voice: 'aura-asteria-en',
        thinkProviderType: 'open_ai',
        thinkModel: 'gpt-4o-mini',
        listenModel: 'nova-3',
      },
      openAITools: [],
      promptTools: PROMPT_TOOLS,
      greetingMessage: 'Thanks for calling reservations.',
    });

    expect(payload.vendor).toBe('deepgram');
    expect(payload.toolHook).toBe('/llm-tool');
    expect(payload.llmOptions).toMatchObject({
      Settings: {
        type: 'Settings',
        agent: {
          listen: {
            provider: {
              type: 'deepgram',
              model: 'nova-3',
            },
          },
          think: {
            provider: {
              type: 'open_ai',
              model: 'gpt-4o-mini',
            },
            prompt: 'Help callers change reservations.',
          },
          speak: {
            provider: {
              type: 'deepgram',
              model: 'aura-asteria-en',
            },
          },
          greeting: 'Thanks for calling reservations.',
        },
      },
    });
    expect(
      (
        payload.llmOptions.Settings as {
          agent: { think: { functions: Array<Record<string, unknown>> } };
        }
      ).agent.think.functions,
    ).toHaveLength(1);
  });

  it('builds provider-specific tool result envelopes', () => {
    expect(
      buildProviderToolResponseMessage({
        provider: 's2s:elevenlabs',
        callId: 'call-1',
        toolName: 'lookup_booking',
        result: { reservation: 'ABC123' },
      }),
    ).toMatchObject({
      type: 'client_tool_result',
      tool_call_id: 'call-1',
      is_error: false,
    });

    expect(
      buildProviderToolResponseMessage({
        provider: 's2s:ultravox',
        callId: 'call-2',
        toolName: 'lookup_booking',
        result: { reservation: 'ABC123' },
      }),
    ).toMatchObject({
      type: 'client_tool_result',
      invocationId: 'call-2',
      responseType: 'tool-response',
    });

    expect(
      buildProviderToolErrorMessage({
        provider: 's2s:deepgram',
        callId: 'call-3',
        toolName: 'lookup_booking',
        errorMessage: 'lookup failed',
      }),
    ).toMatchObject({
      type: 'FunctionCallResponse',
      id: 'call-3',
      name: 'lookup_booking',
      content: 'lookup failed',
    });
  });

  it('translates ElevenLabs transcripts into the internal realtime event shape', () => {
    const accumulator = new UltravoxTranscriptAccumulator();

    expect(
      translateProviderEventToRealtimeEvents(
        's2s:elevenlabs',
        {
          type: 'user_transcript',
          user_transcription_event: {
            user_transcript: 'I need to reschedule my trip.',
          },
        },
        accumulator,
      ),
    ).toEqual([
      {
        type: 'conversation.item.input_audio_transcription.completed',
        transcript: 'I need to reschedule my trip.',
      },
    ]);

    expect(
      translateProviderEventToRealtimeEvents(
        's2s:elevenlabs',
        {
          type: 'agent_response',
          agent_response_event: {
            agent_response: 'I can help with that.',
          },
        },
        accumulator,
      ),
    ).toEqual([
      { type: 'response.audio_transcript.delta' },
      { type: 'response.audio_transcript.done', transcript: 'I can help with that.' },
    ]);
  });

  it('translates Deepgram ConversationText events into the internal realtime event shape', () => {
    const accumulator = new UltravoxTranscriptAccumulator();

    expect(
      translateProviderEventToRealtimeEvents(
        's2s:deepgram',
        {
          type: 'ConversationText',
          role: 'user',
          content: 'Can you find my booking?',
        },
        accumulator,
      ),
    ).toEqual([
      {
        type: 'conversation.item.input_audio_transcription.completed',
        transcript: 'Can you find my booking?',
      },
    ]);

    expect(
      translateProviderEventToRealtimeEvents(
        's2s:deepgram',
        {
          type: 'ConversationText',
          role: 'assistant',
          content: 'Absolutely, let me check.',
        },
        accumulator,
      ),
    ).toEqual([
      { type: 'response.audio_transcript.delta' },
      { type: 'response.audio_transcript.done', transcript: 'Absolutely, let me check.' },
    ]);
  });

  it('accumulates Ultravox transcript deltas until the final transcript arrives', () => {
    const accumulator = new UltravoxTranscriptAccumulator();

    expect(
      translateProviderEventToRealtimeEvents(
        's2s:ultravox',
        {
          type: 'transcript',
          role: 'assistant',
          delta: 'Hello',
          final: false,
          ordinal: 1,
        },
        accumulator,
      ),
    ).toEqual([{ type: 'response.audio_transcript.delta' }]);

    expect(
      translateProviderEventToRealtimeEvents(
        's2s:ultravox',
        {
          type: 'transcript',
          role: 'assistant',
          delta: ', how can I help?',
          final: true,
          ordinal: 1,
        },
        accumulator,
      ),
    ).toEqual([
      { type: 'response.audio_transcript.delta' },
      { type: 'response.audio_transcript.done', transcript: 'Hello, how can I help?' },
    ]);

    expect(
      translateProviderEventToRealtimeEvents(
        's2s:ultravox',
        {
          type: 'userStartedSpeaking',
        },
        accumulator,
      ),
    ).toEqual([{ type: 'conversation.item.truncated' }]);
  });
});
