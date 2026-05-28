import { describe, it, expect } from 'vitest';
import {
  buildOpenAILlmVerb,
  buildGoogleLlmVerb,
} from '../services/voice/korevg/s2s-llm-verb-builder.js';

const MOCK_TOOLS = [
  {
    type: 'function',
    name: 'get_weather',
    description: 'Get current weather',
    parameters: {
      type: 'object',
      properties: { city: { type: 'string', description: 'City name' } },
      required: ['city'],
    },
  },
];

describe('S2S LLM Verb Builders', () => {
  // ===========================================================================
  // OpenAI
  // ===========================================================================
  describe('buildOpenAILlmVerb', () => {
    it('builds a valid OpenAI llm verb with defaults', () => {
      const verb = buildOpenAILlmVerb({
        model: '',
        apiKey: 'sk-test',
        instructions: 'You are a helpful assistant.',
        voice: '',
        tools: [],
        temperature: 0,
        threshold: 0,
        prefixPadding: 0,
        silenceDuration: 0,
      });

      expect(verb.verb).toBe('llm');
      expect(verb.vendor).toBe('openai');
      expect(verb.model).toBe('gpt-realtime-1.5');
      expect(verb.auth.apiKey).toBe('sk-test');
      expect(verb.eventHook).toBe('/llm-event');
      expect(verb.toolHook).toBeUndefined();

      const opts = verb.llmOptions as any;
      expect(opts.response_create.modalities).toEqual(['text', 'audio']);
      expect(opts.response_create.instructions).toBe('You are a helpful assistant.');
      expect(opts.response_create.voice).toBe('marin');
      expect(opts.session_update.voice).toBe('marin');
      expect(opts.session_update.output_audio_format).toBe('pcm16');
      expect(opts.session_update.turn_detection.type).toBe('server_vad');
      expect(opts.session_update.turn_detection.threshold).toBe(0);
      expect(opts.session_update.turn_detection.prefix_padding_ms).toBe(0);
      expect(opts.session_update.turn_detection.silence_duration_ms).toBe(0);
    });

    it('uses provided model and voice', () => {
      const verb = buildOpenAILlmVerb({
        model: 'gpt-realtime-2.0',
        apiKey: 'sk-test',
        instructions: 'test',
        voice: 'alloy',
        tools: [],
        temperature: 0.7,
        threshold: 0.7,
        prefixPadding: 500,
        silenceDuration: 1000,
      });

      expect(verb.model).toBe('gpt-realtime-2.0');
      const opts = verb.llmOptions as any;
      expect(opts.response_create.voice).toBe('alloy');
      expect(opts.session_update.voice).toBe('alloy');
      expect(opts.response_create.temperature).toBe(0.7);
      expect(opts.session_update.turn_detection.threshold).toBe(0.7);
      expect(opts.session_update.turn_detection.prefix_padding_ms).toBe(500);
      expect(opts.session_update.turn_detection.silence_duration_ms).toBe(1000);
    });

    it('normalizes temperature to the OpenAI Realtime supported range', () => {
      const belowMinimum = buildOpenAILlmVerb({
        model: 'gpt-realtime-1.5',
        apiKey: 'sk-test',
        instructions: 'test',
        voice: 'marin',
        tools: [],
        temperature: 0.1,
        threshold: 0.5,
        prefixPadding: 300,
        silenceDuration: 700,
      });
      const aboveMaximum = buildOpenAILlmVerb({
        model: 'gpt-realtime-1.5',
        apiKey: 'sk-test',
        instructions: 'test',
        voice: 'marin',
        tools: [],
        temperature: 1.8,
        threshold: 0.5,
        prefixPadding: 300,
        silenceDuration: 700,
      });

      expect((belowMinimum.llmOptions as any).response_create.temperature).toBe(0.6);
      expect((aboveMaximum.llmOptions as any).response_create.temperature).toBe(1.2);
    });

    it('includes tools and toolHook when tools are provided', () => {
      const verb = buildOpenAILlmVerb({
        model: 'gpt-realtime-1.5',
        apiKey: 'sk-test',
        instructions: 'test',
        voice: 'marin',
        tools: MOCK_TOOLS,
        temperature: 0.8,
        threshold: 0.5,
        prefixPadding: 300,
        silenceDuration: 700,
      });

      expect(verb.toolHook).toBe('/llm-tool');
      const opts = verb.llmOptions as any;
      expect(opts.session_update.tools).toEqual(MOCK_TOOLS);
      expect(opts.session_update.tool_choice).toBe('auto');
    });

    it('omits tools fields when tools array is empty', () => {
      const verb = buildOpenAILlmVerb({
        model: 'gpt-realtime-1.5',
        apiKey: 'sk-test',
        instructions: 'test',
        voice: 'marin',
        tools: [],
        temperature: 0.8,
        threshold: 0.5,
        prefixPadding: 300,
        silenceDuration: 700,
      });

      expect(verb.toolHook).toBeUndefined();
      const opts = verb.llmOptions as any;
      expect(opts.session_update.tools).toBeUndefined();
      expect(opts.session_update.tool_choice).toBeUndefined();
    });

    it('includes instructions in both response_create and session_update', () => {
      const verb = buildOpenAILlmVerb({
        model: 'gpt-realtime-1.5',
        apiKey: 'sk-test',
        instructions: 'Be concise.',
        voice: 'marin',
        tools: [],
        temperature: 0.8,
        threshold: 0.5,
        prefixPadding: 300,
        silenceDuration: 700,
      });

      const opts = verb.llmOptions as any;
      expect(opts.response_create.instructions).toBe('Be concise.');
      expect(opts.response_create.voice).toBe('marin');
      expect(opts.session_update.instructions).toBe('Be concise.');
    });

    it('subscribes to OpenAI-specific events', () => {
      const verb = buildOpenAILlmVerb({
        model: 'gpt-realtime-1.5',
        apiKey: 'sk-test',
        instructions: 'test',
        voice: 'marin',
        tools: [],
        temperature: 0.8,
        threshold: 0.5,
        prefixPadding: 300,
        silenceDuration: 700,
      });

      expect(verb.events).toContain('conversation.item.*');
      expect(verb.events).toContain('response.audio_transcript.delta');
      expect(verb.events).toContain('response.audio_transcript.done');
      expect(verb.events).toContain('input_audio_buffer.committed');
    });
  });

  // ===========================================================================
  // Google
  // ===========================================================================
  describe('buildGoogleLlmVerb', () => {
    it('builds a valid Google llm verb with defaults', () => {
      const verb = buildGoogleLlmVerb({
        model: '',
        apiKey: 'AIza-test',
        instructions: 'You are a helpful assistant.',
        voice: '',
        tools: [],
        temperature: 0,
      });

      expect(verb.verb).toBe('llm');
      expect(verb.vendor).toBe('google');
      expect(verb.model).toBe('models/gemini-3.1-flash-live-preview');
      expect(verb.auth.apiKey).toBe('AIza-test');
      expect(verb.eventHook).toBe('/llm-event');
      expect(verb.toolHook).toBeUndefined();
      expect(verb.events).toEqual(['error', 'session.created', 'session.updated', 'llm_event']);

      const setup = (verb.llmOptions as any).setup;
      expect(setup.generationConfig.responseModalities).toEqual(['AUDIO', 'TEXT']);
      expect(setup.generationConfig.speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName).toBe(
        'Puck',
      );
      expect(setup.systemInstruction.parts[0].text).toContain('You are a helpful assistant.');
      expect(setup.systemInstruction.parts[0].text).toContain('runtime_instructions');
      expect(setup.generationConfig.temperature).toBe(0);
      expect(setup.tools).toBeUndefined();
    });

    it('uses provided model and voice', () => {
      const verb = buildGoogleLlmVerb({
        model: 'gemini-2.0-flash-live-001',
        apiKey: 'AIza-test',
        instructions: 'test',
        voice: 'Kore',
        tools: [],
        temperature: 1.2,
      });

      expect(verb.model).toBe('models/gemini-2.0-flash-live-001');
      const setup = (verb.llmOptions as any).setup;
      expect(setup.generationConfig.speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName).toBe(
        'Kore',
      );
      expect(setup.generationConfig.temperature).toBe(1.2);
    });

    it('maps Gemini Live automatic activity detection settings', () => {
      const verb = buildGoogleLlmVerb({
        model: 'gemini-3.1-flash-live-preview',
        apiKey: 'AIza-test',
        instructions: 'test',
        voice: 'Puck',
        tools: [],
        temperature: 0.8,
        startSensitivity: 'START_SENSITIVITY_HIGH',
        endSensitivity: 'END_SENSITIVITY_LOW',
        prefixPadding: 250,
        silenceDuration: 900,
      });

      const setup = (verb.llmOptions as any).setup;
      expect(setup.realtimeInputConfig.automaticActivityDetection).toEqual({
        startOfSpeechSensitivity: 'START_SENSITIVITY_HIGH',
        endOfSpeechSensitivity: 'END_SENSITIVITY_LOW',
        prefixPaddingMs: 250,
        silenceDurationMs: 900,
      });
    });

    it('omits Gemini Live activity detection config when only defaults are present', () => {
      const verb = buildGoogleLlmVerb({
        model: 'gemini-3.1-flash-live-preview',
        apiKey: 'AIza-test',
        instructions: 'test',
        voice: 'Puck',
        tools: [],
        temperature: 0.8,
        startSensitivity: 'START_SENSITIVITY_UNSPECIFIED',
        endSensitivity: 'END_SENSITIVITY_UNSPECIFIED',
      });

      const setup = (verb.llmOptions as any).setup;
      expect(setup.realtimeInputConfig).toBeUndefined();
    });

    it('includes tools as functionDeclarations when tools are provided', () => {
      const verb = buildGoogleLlmVerb({
        model: 'gemini-3.1-flash-live-preview',
        apiKey: 'AIza-test',
        instructions: 'test',
        voice: 'Puck',
        tools: MOCK_TOOLS,
        temperature: 0.8,
      });

      expect(verb.toolHook).toBe('/llm-tool');
      const setup = (verb.llmOptions as any).setup;
      expect(setup.tools).toHaveLength(1);
      expect(setup.tools[0].functionDeclarations).toHaveLength(1);
      expect(setup.tools[0].functionDeclarations[0].name).toBe('get_weather');
      expect(setup.tools[0].functionDeclarations[0].description).toBe('Get current weather');
      expect(setup.tools[0].functionDeclarations[0].parameters).toEqual(MOCK_TOOLS[0].parameters);
    });

    it('omits tools when tools array is empty', () => {
      const verb = buildGoogleLlmVerb({
        model: 'gemini-3.1-flash-live-preview',
        apiKey: 'AIza-test',
        instructions: 'test',
        voice: 'Puck',
        tools: [],
        temperature: 0.8,
      });

      expect(verb.toolHook).toBeUndefined();
      const setup = (verb.llmOptions as any).setup;
      expect(setup.tools).toBeUndefined();
    });

    it('uses systemInstruction.parts format for instructions', () => {
      const verb = buildGoogleLlmVerb({
        model: 'gemini-3.1-flash-live-preview',
        apiKey: 'AIza-test',
        instructions: 'Be a customer service agent.',
        voice: 'Puck',
        tools: [],
        temperature: 0.8,
      });

      const setup = (verb.llmOptions as any).setup;
      expect(setup.systemInstruction.parts[0].text).toContain('Be a customer service agent.');
      expect(setup.systemInstruction.parts[0].text).toContain('runtime_instructions');
    });

    it('tells Google to use startup tool runtime instructions when greeting is enabled', () => {
      const verb = buildGoogleLlmVerb({
        model: 'gemini-3.1-flash-live-preview',
        apiKey: 'AIza-test',
        instructions: 'Be a customer service agent.',
        voice: 'Puck',
        tools: [],
        temperature: 0.8,
        greetingMessage: 'Hello there!',
      });

      const setup = (verb.llmOptions as any).setup;
      expect(setup.systemInstruction.parts[0].text).toContain('runtime_instructions');
      expect(setup.systemInstruction.parts[0].text).toContain('Speak the "text" field exactly');
      expect(setup.systemInstruction.parts[0].text).toContain(
        'caller-facing speech for that tool turn',
      );
      expect(setup.tools[0].functionDeclarations[0].name).toBe('get_greeting');
    });

    it('tells Google to honor runtime instructions from any tool result', () => {
      const verb = buildGoogleLlmVerb({
        model: 'gemini-3.1-flash-live-preview',
        apiKey: 'AIza-test',
        instructions: 'Be a customer service agent.',
        voice: 'Puck',
        tools: [],
        temperature: 0.8,
      });

      const setup = (verb.llmOptions as any).setup;
      expect(setup.systemInstruction.parts[0].text).toContain('runtime_instructions');
      expect(setup.systemInstruction.parts[0].text).toContain(
        'caller-facing speech for that tool turn',
      );
      expect(setup.systemInstruction.parts[0].text).toContain('continue_current_turn');
      expect(setup.systemInstruction.parts[0].text).toContain('Do not announce the transfer');
    });

    it('subscribes to session lifecycle and llm_event for Google S2S compatibility', () => {
      const verb = buildGoogleLlmVerb({
        model: 'gemini-3.1-flash-live-preview',
        apiKey: 'AIza-test',
        instructions: 'test',
        voice: 'Puck',
        tools: [],
        temperature: 0.8,
      });

      expect(verb.events).toEqual(['error', 'session.created', 'session.updated', 'llm_event']);
    });
  });

  // ===========================================================================
  // Cross-provider
  // ===========================================================================
  describe('cross-provider consistency', () => {
    it('both providers produce the same base structure', () => {
      const openai = buildOpenAILlmVerb({
        model: 'gpt-realtime-1.5',
        apiKey: 'sk-test',
        instructions: 'test',
        voice: 'marin',
        tools: [],
        temperature: 0.8,
        threshold: 0.5,
        prefixPadding: 300,
        silenceDuration: 700,
      });

      const google = buildGoogleLlmVerb({
        model: 'gemini-3.1-flash-live-preview',
        apiKey: 'AIza-test',
        instructions: 'test',
        voice: 'Puck',
        tools: [],
        temperature: 0.8,
      });

      // Same verb type
      expect(openai.verb).toBe('llm');
      expect(google.verb).toBe('llm');

      // Same hook paths
      expect(openai.eventHook).toBe(google.eventHook);

      // Different vendors
      expect(openai.vendor).toBe('openai');
      expect(google.vendor).toBe('google');

      // Both have llmOptions
      expect(openai.llmOptions).toBeDefined();
      expect(google.llmOptions).toBeDefined();

      // OpenAI has session_update, Google has setup
      expect((openai.llmOptions as any).session_update).toBeDefined();
      expect((google.llmOptions as any).setup).toBeDefined();
      expect((openai.llmOptions as any).setup).toBeUndefined();
      expect((google.llmOptions as any).session_update).toBeUndefined();
    });
  });
});
