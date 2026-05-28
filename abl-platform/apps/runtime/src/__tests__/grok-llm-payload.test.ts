import { describe, expect, it } from 'vitest';
import type { S2SSessionConfig } from '../services/voice/s2s/types.js';
import {
  buildGrokLlmVerbPayload,
  type GrokLlmVerbPayload,
} from '../services/voice/korevg/grok-llm-payload.js';
import type { RealtimeLlmToolDefinition } from '../services/voice/korevg/realtime-llm-payload.js';

describe('buildGrokLlmVerbPayload', () => {
  it('persists instructions into session_update and wraps greeting in response_create', () => {
    const instructions = 'Stay in role as customer support.';
    const s2sConfig: S2SSessionConfig = {
      model: 'grok-2-1212',
      voice: 'ara',
      temperature: 1.0,
      threshold: 0.5,
      prefixPadding: 300,
      silenceDuration: 500,
    };

    const payload = buildGrokLlmVerbPayload({
      apiKey: 'xai-test-key',
      instructions,
      s2sConfig,
      tools: [],
    });

    // session_update gets raw instructions
    expect(payload.llmOptions.session_update.instructions).toBe(instructions);
    // response_create wraps the greeting text
    expect(payload.llmOptions.response_create.instructions).toContain('Say:');
  });

  it('uses correct Grok-specific vendor and event types', () => {
    const instructions = 'Test instructions.';
    const s2sConfig: S2SSessionConfig = {};

    const payload = buildGrokLlmVerbPayload({
      apiKey: 'xai-test-key',
      instructions,
      s2sConfig,
      tools: [],
    });

    expect(payload.vendor).toBe('grok');
    expect(payload.verb).toBe('llm');
    expect(payload.events).toContain('response.done');
    expect(payload.events).toContain('response.output_audio_transcript.*'); // Grok-specific
    expect(payload.events).toContain('conversation.item.input_audio_transcription.completed');
  });

  it('applies correct defaults for model, voice, VAD parameters, and temperature', () => {
    const instructions = 'Test instructions.';
    const s2sConfig: S2SSessionConfig = {};

    const payload = buildGrokLlmVerbPayload({
      apiKey: 'xai-test-key',
      instructions,
      s2sConfig,
      tools: [],
    });

    expect(payload.model).toBe('grok-2-1212');
    expect(payload.llmOptions.session_update.voice).toBe('ara');
    expect(payload.llmOptions.session_update.temperature).toBe(0.8);
    expect(payload.llmOptions.session_update.turn_detection.threshold).toBe(0.5);
    expect(payload.llmOptions.session_update.turn_detection.silence_duration_ms).toBe(500);
    expect(payload.llmOptions.response_create.temperature).toBe(0.8);
  });

  it('keeps tool configuration only when tools are present', () => {
    const instructions = 'Use the provided tools.';
    const s2sConfig: S2SSessionConfig = {};
    const tools: RealtimeLlmToolDefinition[] = [
      {
        type: 'function',
        name: 'lookup_order',
        description: 'Lookup an order by id',
        parameters: {
          type: 'object',
          properties: {
            orderId: {
              type: 'string',
              description: 'Order identifier',
            },
          },
          required: ['orderId'],
        },
      },
    ];

    const withTools = buildGrokLlmVerbPayload({
      apiKey: 'xai-test-key',
      instructions,
      s2sConfig,
      tools,
    });
    const withoutTools = buildGrokLlmVerbPayload({
      apiKey: 'xai-test-key',
      instructions,
      s2sConfig,
      tools: [],
    });

    expect(withTools.toolHook).toBe('/llm-event');
    expect(withTools.llmOptions.session_update.tools).toEqual(tools);
    expect(withTools.llmOptions.session_update.tool_choice).toBe('auto');

    expect(withoutTools.toolHook).toBe('/llm-event');
    expect(withoutTools.llmOptions.session_update.tools).toBeUndefined();
    expect(withoutTools.llmOptions.session_update.tool_choice).toBeUndefined();
  });

  it('respects custom VAD thresholds and silence durations from config', () => {
    const instructions = 'Test instructions.';
    const s2sConfig: S2SSessionConfig = {
      threshold: 0.8,
      silenceDuration: 1000,
      prefixPadding: 500,
    };

    const payload = buildGrokLlmVerbPayload({
      apiKey: 'xai-test-key',
      instructions,
      s2sConfig,
      tools: [],
    });

    expect(payload.llmOptions.session_update.turn_detection.threshold).toBe(0.8);
    expect(payload.llmOptions.session_update.turn_detection.silence_duration_ms).toBe(1000);
    expect(payload.llmOptions.session_update.turn_detection.prefix_padding_ms).toBe(500);
  });

  it('preserves valid zero-valued numeric settings', () => {
    const payload = buildGrokLlmVerbPayload({
      apiKey: 'xai-test-key',
      instructions: 'Test instructions.',
      s2sConfig: {
        temperature: 0,
        threshold: 0,
        prefixPadding: 0,
        silenceDuration: 0,
      },
      tools: [],
    });

    expect(payload.llmOptions.session_update.temperature).toBe(0);
    expect(payload.llmOptions.response_create.temperature).toBe(0);
    expect(payload.llmOptions.session_update.turn_detection.threshold).toBe(0);
    expect(payload.llmOptions.session_update.turn_detection.prefix_padding_ms).toBe(0);
    expect(payload.llmOptions.session_update.turn_detection.silence_duration_ms).toBe(0);
  });

  it('includes organizationId when provided in config', () => {
    const instructions = 'Test instructions.';
    const s2sConfig: S2SSessionConfig = {
      organizationId: 'org-12345',
    };

    const payload = buildGrokLlmVerbPayload({
      apiKey: 'xai-test-key',
      instructions,
      s2sConfig,
      tools: [],
    });

    expect(payload.auth.organizationId).toBe('org-12345');
  });

  it('omits organizationId when not provided in config', () => {
    const instructions = 'Test instructions.';
    const s2sConfig: S2SSessionConfig = {};

    const payload = buildGrokLlmVerbPayload({
      apiKey: 'xai-test-key',
      instructions,
      s2sConfig,
      tools: [],
    });

    expect(payload.auth.organizationId).toBeUndefined();
  });

  it('uses pcm16 audio format for Grok realtime', () => {
    const instructions = 'Test instructions.';
    const s2sConfig: S2SSessionConfig = {};

    const payload = buildGrokLlmVerbPayload({
      apiKey: 'xai-test-key',
      instructions,
      s2sConfig,
      tools: [],
    });

    expect(payload.llmOptions.session_update.output_audio_format).toBe('pcm16');
  });

  it('includes modalities in both session_update and response_create', () => {
    const instructions = 'Test instructions.';
    const s2sConfig: S2SSessionConfig = {};

    const payload = buildGrokLlmVerbPayload({
      apiKey: 'xai-test-key',
      instructions,
      s2sConfig,
      tools: [],
    });

    expect(payload.llmOptions.session_update.modalities).toEqual(['text', 'audio']);
    expect(payload.llmOptions.response_create.modalities).toEqual(['text', 'audio']);
  });

  it('forwards custom temperature from config to both session_update and response_create', () => {
    const instructions = 'Test instructions.';
    const s2sConfig: S2SSessionConfig = {
      temperature: 1.2,
    };

    const payload = buildGrokLlmVerbPayload({
      apiKey: 'xai-test-key',
      instructions,
      s2sConfig,
      tools: [],
    });

    expect(payload.llmOptions.session_update.temperature).toBe(1.2);
    expect(payload.llmOptions.response_create.temperature).toBe(1.2);
  });

  it('uses a short silent handoff restart instruction instead of the full system prompt when no handoff context is available', () => {
    const instructions = 'Very long system prompt that should stay in session_update only.';
    const s2sConfig: S2SSessionConfig = {};

    const payload = buildGrokLlmVerbPayload({
      apiKey: 'xai-test-key',
      instructions,
      s2sConfig,
      tools: [],
      includeResponseCreate: false,
    });

    expect(payload.llmOptions.session_update.instructions).toBe(instructions);
    expect(payload.llmOptions.response_create.instructions).not.toBe(instructions);
    expect(payload.llmOptions.response_create.instructions).toContain('Speak immediately.');
    expect(payload.llmOptions.response_create.instructions).toContain(
      "Continue naturally from the caller's current request",
    );
    expect(payload.llmOptions.response_create.instructions).not.toMatch(
      /\btransfer|transferred|handoff\b/i,
    );
  });

  it('uses an explicit silent speak-now instruction for handoff context so grok responds without waiting', () => {
    const instructions = 'You are Sales_Agent.';
    const s2sConfig: S2SSessionConfig = {};
    const handoffContext =
      'The customer previously said: book a hotel in Goa for two nights and prefers a beach area.';

    const payload = buildGrokLlmVerbPayload({
      apiKey: 'xai-test-key',
      instructions,
      s2sConfig,
      tools: [],
      includeResponseCreate: false,
      handoffContext,
    });

    expect(payload.llmOptions.response_create.instructions).toContain('Speak immediately.');
    expect(payload.llmOptions.response_create.instructions).toContain(
      'Do not wait for the caller to speak first.',
    );
    expect(payload.llmOptions.response_create.instructions).toContain(
      'Continue naturally from this context',
    );
    expect(payload.llmOptions.response_create.instructions).toContain(
      'book a hotel in Goa for two nights',
    );
    expect(payload.llmOptions.response_create.instructions).not.toMatch(
      /\btransfer|transferred|handoff\b/i,
    );
  });

  it('honors explicit internal handoff speech policy for Grok response.create', () => {
    const payload = buildGrokLlmVerbPayload({
      apiKey: 'xai-test-key',
      instructions: 'You are Sales_Agent.',
      s2sConfig: {},
      tools: [],
      includeResponseCreate: false,
      handoffContext: 'The customer previously said: book a hotel in Goa.',
      internalHandoffSpeech: 'brief',
    });

    expect(payload.llmOptions.response_create.instructions).toContain('Briefly acknowledge');
    expect(payload.llmOptions.response_create.instructions).toContain('right specialist');
    expect(payload.llmOptions.response_create.instructions).toContain('book a hotel in Goa');
  });
});
