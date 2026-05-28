import { describe, expect, it } from 'vitest';
import type { S2SSessionConfig } from '../services/voice/s2s/types.js';
import {
  buildRealtimeLlmVerbPayload,
  type RealtimeLlmToolDefinition,
} from '../services/voice/korevg/realtime-llm-payload.js';

describe('buildRealtimeLlmVerbPayload', () => {
  it('persists instructions into both response_create and session_update', () => {
    const instructions = 'Stay in role as customer support.';
    const s2sConfig: S2SSessionConfig = {
      model: 'gpt-realtime-1.5',
      voice: 'cedar',
      temperature: 0.7,
      threshold: 0.6,
      prefixPadding: 250,
      silenceDuration: 800,
    };

    const payload = buildRealtimeLlmVerbPayload({
      apiKey: 'test-key',
      instructions,
      s2sConfig,
      tools: [],
    });

    expect(payload.llmOptions.response_create).toMatchObject({
      instructions,
      voice: 'cedar',
      temperature: 0.7,
    });
    expect(payload.llmOptions.session_update.instructions).toBe(instructions);
    expect(payload.llmOptions.session_update.voice).toBe('cedar');
  });

  it('normalizes OpenAI realtime temperature to the provider-supported range', () => {
    const belowMinimum = buildRealtimeLlmVerbPayload({
      apiKey: 'test-key',
      instructions: 'Stay focused.',
      s2sConfig: { temperature: 0.1 },
      tools: [],
    });
    const aboveMaximum = buildRealtimeLlmVerbPayload({
      apiKey: 'test-key',
      instructions: 'Stay focused.',
      s2sConfig: { temperature: 1.8 },
      tools: [],
    });
    const missingTemperature = buildRealtimeLlmVerbPayload({
      apiKey: 'test-key',
      instructions: 'Stay focused.',
      s2sConfig: {},
      tools: [],
    });

    expect(belowMinimum.llmOptions.response_create).toMatchObject({ temperature: 0.6 });
    expect(aboveMaximum.llmOptions.response_create).toMatchObject({ temperature: 1.2 });
    expect(missingTemperature.llmOptions.response_create).toMatchObject({ temperature: 0.8 });
  });

  it('preserves explicit zero VAD values from stored OpenAI realtime config', () => {
    const payload = buildRealtimeLlmVerbPayload({
      apiKey: 'test-key',
      instructions: 'Stay focused.',
      s2sConfig: {
        threshold: 0,
        prefixPadding: 0,
        silenceDuration: 0,
      },
      tools: [],
    });

    expect(payload.llmOptions.session_update.turn_detection.threshold).toBe(0);
    expect(payload.llmOptions.session_update.turn_detection.prefix_padding_ms).toBe(0);
    expect(payload.llmOptions.session_update.turn_detection.silence_duration_ms).toBe(0);
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

    const withTools = buildRealtimeLlmVerbPayload({
      apiKey: 'test-key',
      instructions,
      s2sConfig,
      tools,
    });
    const withoutTools = buildRealtimeLlmVerbPayload({
      apiKey: 'test-key',
      instructions,
      s2sConfig,
      tools: [],
    });

    expect(withTools.toolHook).toBe('/llm-tool');
    expect(withTools.llmOptions.session_update.tools).toEqual(tools);
    expect(withTools.llmOptions.session_update.tool_choice).toBe('auto');

    expect(withoutTools.toolHook).toBeUndefined();
    expect(withoutTools.llmOptions.session_update.tools).toBeUndefined();
    expect(withoutTools.llmOptions.session_update.tool_choice).toBeUndefined();
  });

  it('subscribes to completed function-call arguments for OpenAI tool calls', () => {
    const payload = buildRealtimeLlmVerbPayload({
      apiKey: 'test-key',
      instructions: 'Route with tools.',
      s2sConfig: {},
      tools: [],
    });

    expect(payload.events).toContain('response.function_call_arguments.done');
  });

  it('subscribes to response lifecycle events for S2S debugging', () => {
    const payload = buildRealtimeLlmVerbPayload({
      apiKey: 'test-key',
      instructions: 'Route with tools.',
      s2sConfig: {},
      tools: [],
    });

    expect(payload.events).toEqual(
      expect.arrayContaining([
        'session.updated',
        'response.created',
        'response.done',
        'response.output_item.done',
        'response.audio.done',
      ]),
    );
  });

  it('defaults response_create voice to marin when no explicit voice is configured', () => {
    const payload = buildRealtimeLlmVerbPayload({
      apiKey: 'test-key',
      instructions: 'Greet the caller.',
      s2sConfig: {},
      tools: [],
    });

    expect(payload.llmOptions.response_create).toMatchObject({ voice: 'marin' });
    expect(payload.llmOptions.session_update.voice).toBe('marin');
  });

  it('builds Azure OpenAI realtime as KoreVG microsoft vendor with host and preview path', () => {
    const payload = buildRealtimeLlmVerbPayload({
      apiKey: 'azure-key',
      instructions: 'Greet the caller.',
      s2sConfig: {
        provider: 's2s:microsoft',
        resourceHost: 'https://my-resource.openai.azure.com/',
        deploymentName: 'gpt-realtime-2',
        apiVersion: '2025-04-01-preview',
      },
      tools: [],
    });

    expect(payload.vendor).toBe('microsoft');
    expect(payload.model).toBe('gpt-realtime-1.5');
    expect(payload.connectOptions).toEqual({
      host: 'my-resource.openai.azure.com',
      path: 'openai/realtime?api-version=2025-04-01-preview&deployment=gpt-realtime-2&api-key=azure-key',
    });
  });

  it('keeps the Azure deployment name as the KoreVG model label for non-preview paths', () => {
    const payload = buildRealtimeLlmVerbPayload({
      apiKey: 'azure-key',
      instructions: 'Greet the caller.',
      s2sConfig: {
        provider: 's2s:microsoft',
        resourceHost: 'https://my-resource.openai.azure.com/',
        deploymentName: 'gpt-realtime-2',
        path: 'openai/v1/realtime?model=gpt-realtime-2',
        apiVersion: '2025-08-28',
      },
      tools: [],
    });

    expect(payload.vendor).toBe('microsoft');
    expect(payload.model).toBe('gpt-realtime-2');
    expect(payload.connectOptions).toEqual({
      host: 'my-resource.openai.azure.com',
      path: 'openai/v1/realtime?model=gpt-realtime-2&api-key=azure-key',
    });
  });

  it('does not duplicate Azure OpenAI realtime api-key when an explicit path already has one', () => {
    const payload = buildRealtimeLlmVerbPayload({
      apiKey: 'azure-key',
      instructions: 'Greet the caller.',
      s2sConfig: {
        provider: 's2s:microsoft',
        resourceHost: 'https://my-resource.openai.azure.com/',
        deploymentName: 'gpt-realtime-2',
        path: 'openai/realtime?api-version=2025-04-01-preview&deployment=gpt-realtime-2&api-key=existing-key',
      },
      tools: [],
    });

    expect(payload.connectOptions?.path).toBe(
      'openai/realtime?api-version=2025-04-01-preview&deployment=gpt-realtime-2&api-key=existing-key',
    );
  });

  it('fails closed when Azure OpenAI realtime has no resource host', () => {
    expect(() =>
      buildRealtimeLlmVerbPayload({
        apiKey: 'azure-key',
        instructions: 'Greet the caller.',
        s2sConfig: {
          provider: 's2s:microsoft',
          deploymentName: 'gpt-realtime-deployment',
        },
        tools: [],
      }),
    ).toThrow('Azure OpenAI Realtime requires resourceHost');
  });
});
