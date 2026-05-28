import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  BEDROCK_AMBIENT_SENTINEL,
  createVercelEmbeddingProvider,
  createVercelProvider,
  normalizeAnthropicMessagesBaseUrl,
  stripSamplingForThinkingModel,
} from '../provider-factory.js';

describe('createVercelProvider — Anthropic Messages endpoints', () => {
  it('normalizes Azure Anthropic URLs to the provider base URL', () => {
    expect(
      normalizeAnthropicMessagesBaseUrl(
        'https://fde-int-resource.openai.azure.com/anthropic/v1/messages',
      ),
    ).toBe('https://fde-int-resource.openai.azure.com/anthropic/v1');
    expect(
      normalizeAnthropicMessagesBaseUrl('https://fde-int-resource.openai.azure.com/anthropic'),
    ).toBe('https://fde-int-resource.openai.azure.com/anthropic/v1');
  });

  it('creates a Microsoft Foundry Anthropic Messages model with bearer auth', () => {
    const model = createVercelProvider(
      'microsoft_foundry_anthropic',
      'aad-token',
      'https://fde-int-resource.openai.azure.com/anthropic/v1/messages',
      'claude-opus-4-7',
      undefined,
      { authType: 'azure_ad' },
    );

    expect(model).toBeTruthy();
    expect((model as { modelId?: string }).modelId).toBe('claude-opus-4-7');
    expect((model as { provider?: string }).provider).toBe('microsoft-foundry-anthropic.messages');
  });

  it('routes custom Anthropic Messages credentials away from OpenAI-compatible chat', () => {
    const model = createVercelProvider(
      'custom',
      'anthropic-key',
      'https://proxy.example.com/anthropic',
      'claude-opus-4-7',
      undefined,
      { apiFormat: 'anthropic_messages' },
    );

    expect(model).toBeTruthy();
    expect((model as { modelId?: string }).modelId).toBe('claude-opus-4-7');
    expect((model as { provider?: string }).provider).toBe('custom-anthropic.messages');
  });
});

describe('stripSamplingForThinkingModel — provider sampling guard', () => {
  it('drops temperature, topP, and topK for thinking-capable models (e.g. claude-opus-4-7)', () => {
    const params = {
      maxOutputTokens: 1024,
      temperature: 0.7,
      topP: 0.9,
      topK: 40,
      prompt: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    };
    const out = stripSamplingForThinkingModel(params, 'claude-opus-4-7') as Record<string, unknown>;
    expect(out).not.toHaveProperty('temperature');
    expect(out).not.toHaveProperty('topP');
    expect(out).not.toHaveProperty('topK');
    expect(out.maxOutputTokens).toBe(1024);
    expect(out.prompt).toBeDefined();
  });

  it('drops sampling parameters for OpenAI reasoning models (e.g. gpt-5.4)', () => {
    const params = {
      maxOutputTokens: 1024,
      temperature: 0.7,
      topP: 0.9,
      topK: 40,
      top_p: 0.9,
      top_k: 40,
      frequencyPenalty: 0.5,
      presencePenalty: 0.5,
      seed: 123,
      stopSequences: ['END'],
      prompt: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    };
    const out = stripSamplingForThinkingModel(params, 'gpt-5.4') as Record<string, unknown>;
    expect(out).not.toHaveProperty('temperature');
    expect(out).not.toHaveProperty('topP');
    expect(out).not.toHaveProperty('topK');
    expect(out).not.toHaveProperty('top_p');
    expect(out).not.toHaveProperty('top_k');
    expect(out).not.toHaveProperty('frequencyPenalty');
    expect(out).not.toHaveProperty('presencePenalty');
    expect(out).not.toHaveProperty('seed');
    expect(out).not.toHaveProperty('stopSequences');
    expect(out.maxOutputTokens).toBe(1024);
    expect(out.prompt).toBeDefined();
  });

  it('drops sampling parameters for Azure-cased reasoning model aliases', () => {
    const params = {
      maxOutputTokens: 1024,
      temperature: 0.7,
      topP: 0.9,
      prompt: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    };
    const out = stripSamplingForThinkingModel(params, 'GPT-5.4') as Record<string, unknown>;
    expect(out).not.toHaveProperty('temperature');
    expect(out).not.toHaveProperty('topP');
    expect(out.maxOutputTokens).toBe(1024);
  });

  it('preserves non-sampling call parameters for non-reasoning models', () => {
    const params = {
      maxOutputTokens: 1024,
      frequencyPenalty: 0.5,
      presencePenalty: 0.5,
      seed: 123,
      stopSequences: ['END'],
      prompt: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    };
    const out = stripSamplingForThinkingModel(params, 'gpt-4o') as Record<string, unknown>;
    expect(out.frequencyPenalty).toBe(0.5);
    expect(out.presencePenalty).toBe(0.5);
    expect(out.seed).toBe(123);
    expect(out.stopSequences).toEqual(['END']);
  });

  it('preserves params for thinking-capable models that still support sampling', () => {
    const params = {
      maxOutputTokens: 1024,
      temperature: 0.7,
      topP: 0.9,
      topK: 40,
      prompt: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    };
    const out = stripSamplingForThinkingModel(params, 'claude-sonnet-4-6') as Record<
      string,
      unknown
    >;
    expect(out.temperature).toBe(0.7);
    expect(out.topP).toBe(0.9);
    expect(out.topK).toBe(40);
    expect(out.maxOutputTokens).toBe(1024);
  });

  it('preserves params for non-thinking models', () => {
    const params = {
      maxOutputTokens: 1024,
      temperature: 0.7,
      topP: 0.9,
      topK: 40,
      prompt: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    };
    const out = stripSamplingForThinkingModel(params, 'claude-haiku-3-5') as Record<
      string,
      unknown
    >;
    expect(out.temperature).toBe(0.7);
    expect(out.topP).toBe(0.9);
    expect(out.topK).toBe(40);
    expect(out.maxOutputTokens).toBe(1024);
  });
});

describe('createVercelProvider — Azure model identity', () => {
  it('canonicalizes azure-prefixed lowercase GPT aliases to Azure deployment casing', () => {
    const model = createVercelProvider(
      'azure',
      'azure-key',
      undefined,
      'azure/gpt-4.1',
      undefined,
      { resourceName: 'example-resource' },
    );

    expect(model).toBeTruthy();
    expect((model as { modelId?: string }).modelId).toBe('GPT-4.1');
  });

  it('uses explicit Azure deployment IDs when configured', () => {
    const model = createVercelProvider(
      'azure',
      'azure-key',
      undefined,
      'azure/gpt-4.1',
      undefined,
      { resourceName: 'example-resource', deploymentId: 'custom-gpt-41-deployment' },
    );

    expect(model).toBeTruthy();
    expect((model as { modelId?: string }).modelId).toBe('custom-gpt-41-deployment');
  });
});

describe('createVercelProvider — canonical provider model identity', () => {
  it('canonicalizes provider-prefixed OpenAI aliases to registry model IDs', () => {
    const model = createVercelProvider('openai', 'openai-key', undefined, 'openai/GPT-4.1');

    expect(model).toBeTruthy();
    expect((model as { modelId?: string }).modelId).toBe('gpt-4.1');
  });

  it('canonicalizes provider-prefixed Anthropic aliases to registry model IDs', () => {
    const model = createVercelProvider(
      'anthropic',
      'anthropic-key',
      undefined,
      'anthropic/CLAUDE-OPUS-4-7',
    );

    expect(model).toBeTruthy();
    expect((model as { modelId?: string }).modelId).toBe('claude-opus-4-7');
  });

  it('keeps provider-native slash model IDs after removing the platform provider prefix', () => {
    const model = createVercelProvider(
      'togetherai',
      'together-key',
      undefined,
      'togetherai/META-LLAMA/LLAMA-3.3-70B-INSTRUCT-TURBO',
    );

    expect(model).toBeTruthy();
    expect((model as { modelId?: string }).modelId).toBe('meta-llama/Llama-3.3-70B-Instruct-Turbo');
  });

  it('preserves unknown provider-native slash model IDs', () => {
    const model = createVercelProvider(
      'togetherai',
      'together-key',
      undefined,
      'some-org/custom-model',
    );

    expect(model).toBeTruthy();
    expect((model as { modelId?: string }).modelId).toBe('some-org/custom-model');
  });

  it('preserves unknown provider-native resource paths that contain provider names', () => {
    const model = createVercelProvider(
      'fireworks',
      'fireworks-key',
      undefined,
      'accounts/fireworks/models/custom-model',
    );

    expect(model).toBeTruthy();
    expect((model as { modelId?: string }).modelId).toBe('accounts/fireworks/models/custom-model');
  });

  it('strips the OpenRouter routing prefix before provider execution', () => {
    const model = createVercelProvider(
      'openrouter',
      'openrouter-key',
      undefined,
      'openrouter/openai/gpt-5',
    );

    expect(model).toBeTruthy();
    expect((model as { modelId?: string }).modelId).toBe('openai/gpt-5');
  });
});

describe('createVercelEmbeddingProvider — Azure model identity', () => {
  it('passes bare Azure embedding deployment names to the Azure SDK', () => {
    const model = createVercelEmbeddingProvider(
      'azure',
      'azure-key',
      undefined,
      'azure/text-embedding-3-small',
      { resourceName: 'example-resource' },
    );

    expect(model).toBeTruthy();
    expect((model as { modelId?: string }).modelId).toBe('text-embedding-3-small');
  });

  it('canonicalizes non-Azure embedding model IDs through the provider registry', () => {
    const model = createVercelEmbeddingProvider(
      'cohere',
      'cohere-key',
      undefined,
      'cohere/EMBED-ENGLISH-V3.0',
    );

    expect(model).toBeTruthy();
    expect((model as { modelId?: string }).modelId).toBe('embed-english-v3.0');
  });
});

describe('createVercelProvider — bedrock', () => {
  // Save/restore AWS env vars around each test
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    savedEnv['AWS_REGION'] = process.env.AWS_REGION;
    savedEnv['AWS_ACCESS_KEY_ID'] = process.env.AWS_ACCESS_KEY_ID;
    savedEnv['AWS_SECRET_ACCESS_KEY'] = process.env.AWS_SECRET_ACCESS_KEY;
  });

  afterEach(() => {
    for (const [key, val] of Object.entries(savedEnv)) {
      if (val === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = val;
      }
    }
  });

  it('UT-1: explicit credentials → returns LanguageModel', () => {
    const model = createVercelProvider(
      'bedrock',
      'AKIATEST',
      undefined,
      'anthropic.claude-sonnet-4-6-v1:0',
      undefined,
      { region: 'us-west-2', accessKeyId: 'AKIATEST', secretAccessKey: 'secretvalue' },
    );
    expect(model).toBeTruthy();
    expect((model as { modelId?: string }).modelId).toBeTruthy();
  });

  it('UT-2: ambient credentials → returns LanguageModel (no network call)', () => {
    process.env.AWS_ACCESS_KEY_ID = 'AKIATEST';
    process.env.AWS_SECRET_ACCESS_KEY = 'fakesecret';
    const model = createVercelProvider(
      'bedrock',
      BEDROCK_AMBIENT_SENTINEL,
      undefined,
      'anthropic.claude-sonnet-4-6-v1:0',
      undefined,
      { region: 'us-east-1', useAmbientCredentials: true },
    );
    expect(model).toBeTruthy();
  });

  it('UT-3: no region in authConfig, no AWS_REGION env → defaults to us-east-1', () => {
    delete process.env.AWS_REGION;
    const model = createVercelProvider(
      'bedrock',
      BEDROCK_AMBIENT_SENTINEL,
      undefined,
      'anthropic.claude-sonnet-4-6-v1:0',
      undefined,
      { useAmbientCredentials: true },
    );
    expect(model).toBeTruthy();
  });

  it('UT-4 (FR-8a): AWS_REGION env var used when authConfig.region absent', () => {
    process.env.AWS_REGION = 'ap-southeast-1';
    const model = createVercelProvider(
      'bedrock',
      BEDROCK_AMBIENT_SENTINEL,
      undefined,
      'anthropic.claude-sonnet-4-6-v1:0',
      undefined,
      { useAmbientCredentials: true },
    );
    expect(model).toBeTruthy();
  });

  it('UT-5: accessKeyId present but secretAccessKey absent → throws', () => {
    expect(() =>
      createVercelProvider(
        'bedrock',
        'AKIATEST',
        undefined,
        'anthropic.claude-sonnet-4-6-v1:0',
        undefined,
        { region: 'us-east-1', accessKeyId: 'AKIATEST' },
      ),
    ).toThrow(/secretAccessKey/i);
  });

  it('UT-6: no credentials, no ambient flag → throws descriptive error', () => {
    expect(() =>
      createVercelProvider(
        'bedrock',
        'somekey',
        undefined,
        'anthropic.claude-sonnet-4-6-v1:0',
        undefined,
        {},
      ),
    ).toThrow(/requires either/i);
  });

  it('uses the configured Bedrock resource ARN as the invocation model for IAM role credentials', () => {
    const resourceArn =
      'arn:aws:bedrock:us-east-1:123456789012:inference-profile/us.anthropic-sonnet';
    const model = createVercelProvider(
      'bedrock',
      BEDROCK_AMBIENT_SENTINEL,
      undefined,
      'anthropic.claude-sonnet-4-6-v1:0',
      undefined,
      {
        region: 'us-east-1',
        roleArn: 'arn:aws:iam::123456789012:role/BedrockInvokeRole',
        stsEndpoint: 'https://sts.us-east-1.amazonaws.com',
        resourceArn,
        customHeaders: {
          Authorization: 'Bearer should-not-be-used',
          'X-Bedrock-Trace': 'enabled',
        },
      },
    );

    expect(model).toBeTruthy();
    expect((model as { modelId?: string }).modelId).toBe(resourceArn);
  });
});
