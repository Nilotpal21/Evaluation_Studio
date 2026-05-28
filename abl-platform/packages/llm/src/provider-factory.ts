/**
 * Vercel AI SDK Provider Factory
 *
 * Standalone function that creates a Vercel AI SDK LanguageModel
 * from provider type, API key, and model ID. Extracted from
 * SessionLLMClient so both Runtime and SearchAI can use it.
 *
 * Maps platform provider names (anthropic, openai, google, azure, etc.)
 * to Vercel AI SDK provider factories.
 */

import type { EmbeddingModel, LanguageModel, LanguageModelMiddleware } from 'ai';
import { wrapLanguageModel } from 'ai';
import { createAnthropic } from '@ai-sdk/anthropic';
import { createOpenAI } from '@ai-sdk/openai';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { createVertex } from '@ai-sdk/google-vertex';
import { createAzure } from '@ai-sdk/azure';
import { createCohere } from '@ai-sdk/cohere';
import { createAmazonBedrock } from '@ai-sdk/amazon-bedrock';
import { modelSupportsResponsesApi } from '@abl/compiler/platform/llm/model-registry.js';
import {
  getHyperParameters,
  getModelCapabilities,
  getModelRegistryEntry,
  getModelRegistryKey,
  stripLeadingPlatformModelProviderPrefix,
} from '@abl/compiler/platform/llm/model-capabilities.js';

// Lazy-loaded ai/test module for mock LLM provider (benchmark-only).
// Loaded eagerly at module init via top-level await (ESM). No env var gate —
// the module is lightweight and only used when a TenantModel has provider "mock".
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _MockLanguageModelV3: any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _simulateReadableStream: any;
try {
  const aiTest = await import('ai/test');
  _MockLanguageModelV3 = aiTest.MockLanguageModelV3;
  _simulateReadableStream = aiTest.simulateReadableStream;
} catch {
  // ai/test not available — mock provider will throw a clear error on use
}

/**
 * Sentinel value stored in `encryptedApiKey` for Bedrock IAM role (ambient) connections.
 * No real AWS credentials are stored — the platform's IAM role is used at inference time.
 */
export const BEDROCK_AMBIENT_SENTINEL = '__iam_role__';

// Lazy-loaded AWS credential provider chain for Bedrock ambient credentials (IRSA / ECS / EC2).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _fromNodeProviderChain: ((opts?: any) => any) | undefined;
// Lazy-loaded STS-based temporary credentials provider for cross-account AssumeRole.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _fromTemporaryCredentials: ((opts?: any) => any) | undefined;
try {
  const credProviders = await import('@aws-sdk/credential-providers');
  _fromNodeProviderChain = credProviders.fromNodeProviderChain;
  _fromTemporaryCredentials = credProviders.fromTemporaryCredentials;
} catch {
  // @aws-sdk/credential-providers not available — ambient Bedrock creds will throw on use
}

interface BedrockAuthConfig {
  region?: string;
  accessKeyId?: string;
  secretAccessKey?: string;
  sessionToken?: string;
  useAmbientCredentials?: boolean;
  roleArn?: string;
  stsEndpoint?: string;
  resourceArn?: string;
  bedrockEndpoint?: string;
  customHeaders?: Record<string, string>;
}

const ANTHROPIC_MESSAGES_API_FORMAT = 'anthropic_messages';
const MICROSOFT_FOUNDRY_ANTHROPIC_PROVIDER_NAME = 'microsoft-foundry-anthropic.messages';
const CUSTOM_ANTHROPIC_PROVIDER_NAME = 'custom-anthropic.messages';

function isAnthropicMessagesFormat(authConfig?: Record<string, unknown>): boolean {
  return authConfig?.apiFormat === ANTHROPIC_MESSAGES_API_FORMAT;
}

function readStringRecord(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }
  const headers: Record<string, string> = {};
  for (const [key, rawValue] of Object.entries(value)) {
    if (typeof rawValue === 'string') {
      headers[key] = rawValue;
    }
  }
  return headers;
}

function withoutAuthHeaders(headers: Record<string, string>): Record<string, string> {
  const sanitized: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    const normalized = key.toLowerCase();
    if (normalized === 'authorization' || normalized === 'x-api-key') {
      continue;
    }
    sanitized[key] = value;
  }
  return sanitized;
}

function hasEntries(record: Record<string, string>): boolean {
  return Object.keys(record).length > 0;
}

function readNonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function normalizeProviderForRegistry(providerType: string): string {
  const normalized = providerType.trim().toLowerCase();
  switch (normalized) {
    case 'gemini':
      return 'google';
    case 'vertex':
    case 'vertex_ai':
      return 'google_vertex';
    case 'together':
      return 'togetherai';
    default:
      return normalized;
  }
}

function getProviderRegistryKey(modelId: string, providerHint: string): string | null {
  const key = getModelRegistryKey(modelId);
  if (!key) {
    return null;
  }

  const entry = getModelRegistryEntry(key);
  return entry?.provider.toLowerCase() === providerHint ? key : null;
}

function stripRegistryProviderPrefix(modelId: string, providerHint: string): string {
  const prefix = `${providerHint}/`;
  return modelId.toLowerCase().startsWith(prefix) ? modelId.slice(prefix.length) : modelId;
}

function resolveProviderModelIdentity(
  providerType: string,
  modelId: string,
): {
  providerModelId: string;
  capabilityModelId: string;
} {
  const cleanModelId = stripLeadingPlatformModelProviderPrefix(modelId);
  const providerHint = normalizeProviderForRegistry(providerType);
  const registryKey =
    getProviderRegistryKey(`${providerHint}/${cleanModelId}`, providerHint) ??
    getProviderRegistryKey(modelId, providerHint);

  const providerModelId = registryKey
    ? stripRegistryProviderPrefix(registryKey, providerHint)
    : cleanModelId;

  return {
    providerModelId,
    capabilityModelId: registryKey ?? providerModelId,
  };
}

function resolveAzureModelIdentity(modelId: string): {
  deploymentName: string;
  capabilityModelId: string;
} {
  const { providerModelId, capabilityModelId } = resolveProviderModelIdentity('azure', modelId);

  return {
    deploymentName: providerModelId,
    capabilityModelId,
  };
}

export function normalizeAnthropicMessagesBaseUrl(baseUrl: string | undefined): string | undefined {
  const trimmed = baseUrl?.trim().replace(/\/+$/, '');
  if (!trimmed) {
    return undefined;
  }
  if (trimmed.endsWith('/messages')) {
    return trimmed.slice(0, -'/messages'.length);
  }
  if (trimmed.endsWith('/v1')) {
    return trimmed;
  }
  if (trimmed.endsWith('/anthropic')) {
    return `${trimmed}/v1`;
  }
  return trimmed;
}

/**
 * Drop sampling parameters that reasoning/sampling-disabled models reject (e.g.
 * `gpt-5.4` and `claude-opus-4-7`, which 400 on `temperature`, `top_p`, or
 * `top_k` if any are present).
 *
 * Applied at the shared provider boundary so every Runtime, Pipeline, SearchAI,
 * and Studio call site can pass resolved config unchanged.
 *
 * Exported for unit testing; not part of the public surface.
 */
export function stripSamplingForThinkingModel<T extends Record<string, unknown>>(
  params: T,
  modelId: string,
): T {
  const capabilities = getModelCapabilities(modelId);
  const shouldStripSampling =
    capabilities.isReasoningModel || capabilities.temperatureDisabled || capabilities.topPDisabled;
  const {
    temperature: _temperature,
    topP: _topP,
    topK: _topK,
    top_p: _top_p,
    top_k: _top_k,
    ...samplingRest
  } = params;
  const paramsWithoutSampling = shouldStripSampling ? samplingRest : params;

  if (!shouldStripSampling || !getModelRegistryEntry(modelId)) {
    return paramsWithoutSampling as T;
  }

  const supportedParams = collectSupportedCallParameters(modelId);
  const {
    frequencyPenalty: _frequencyPenalty,
    presencePenalty: _presencePenalty,
    seed: _seed,
    stopSequences: _stopSequences,
    ...rest
  } = paramsWithoutSampling;

  return {
    ...rest,
    ...(supportedParams.has('frequencyPenalty') && _frequencyPenalty !== undefined
      ? { frequencyPenalty: _frequencyPenalty }
      : {}),
    ...(supportedParams.has('presencePenalty') && _presencePenalty !== undefined
      ? { presencePenalty: _presencePenalty }
      : {}),
    ...(supportedParams.has('seed') && _seed !== undefined ? { seed: _seed } : {}),
    ...(supportedParams.has('stopSequences') && _stopSequences !== undefined
      ? { stopSequences: _stopSequences }
      : {}),
  } as T;
}

function collectSupportedCallParameters(modelId: string): Set<string> {
  const supported = new Set<string>();
  const visit = (params: ReturnType<typeof getHyperParameters>): void => {
    for (const param of params) {
      switch (param.name) {
        case 'frequencyPenalty':
        case 'frequency_penalty':
          supported.add('frequencyPenalty');
          break;
        case 'presencePenalty':
        case 'presence_penalty':
          supported.add('presencePenalty');
          break;
        case 'seed':
          supported.add('seed');
          break;
        case 'stop':
        case 'stopSequences':
        case 'stop_sequences':
          supported.add('stopSequences');
          break;
        default:
          break;
      }
      switch (param.unifiedParam) {
        case 'frequencyPenalty':
        case 'frequency_penalty':
          supported.add('frequencyPenalty');
          break;
        case 'presencePenalty':
        case 'presence_penalty':
          supported.add('presencePenalty');
          break;
        case 'seed':
          supported.add('seed');
          break;
        case 'stop':
        case 'stopSequences':
        case 'stop_sequences':
          supported.add('stopSequences');
          break;
        default:
          break;
      }
      visit(param.options ?? []);
      visit(param.hyperParameters ?? []);
    }
  };
  visit(getHyperParameters(modelId));
  return supported;
}

function createUnsupportedSamplingMiddleware(modelIdOverride?: string): LanguageModelMiddleware {
  return {
    specificationVersion: 'v3',
    transformParams: async ({ params, model }) =>
      stripSamplingForThinkingModel(params, modelIdOverride ?? model.modelId),
  };
}

function guardUnsupportedSamplingParameters(
  model: LanguageModel,
  modelIdOverride?: string,
): LanguageModel {
  return wrapLanguageModel({
    model: model as Parameters<typeof wrapLanguageModel>[0]['model'],
    middleware: createUnsupportedSamplingMiddleware(modelIdOverride),
  });
}

function createAnthropicMessagesProvider(opts: {
  providerName: string;
  apiKey: string;
  baseUrl: string | undefined;
  modelId: string;
  authConfig?: Record<string, unknown>;
}): LanguageModel {
  const normalizedBaseUrl = normalizeAnthropicMessagesBaseUrl(opts.baseUrl);
  if (!normalizedBaseUrl) {
    throw new Error('Anthropic Messages provider requires an endpoint URL');
  }

  const authType = String(opts.authConfig?.authType || '').toLowerCase();
  const useBearerAuth =
    authType === 'azure_ad' ||
    authType === 'bearer' ||
    opts.authConfig?.useBearerAuth === true ||
    opts.authConfig?.authScheme === 'bearer';
  const headers = withoutAuthHeaders(readStringRecord(opts.authConfig?.headers));
  const anthropicVersion =
    typeof opts.authConfig?.anthropicVersion === 'string'
      ? opts.authConfig.anthropicVersion
      : undefined;

  const providerFactory = createAnthropic({
    baseURL: normalizedBaseUrl,
    name: opts.providerName,
    ...(useBearerAuth ? { authToken: opts.apiKey } : { apiKey: opts.apiKey }),
    headers: {
      ...(anthropicVersion ? { 'anthropic-version': anthropicVersion } : {}),
      ...headers,
    },
  });
  const model = providerFactory(opts.modelId);
  return guardUnsupportedSamplingParameters(model, opts.modelId);
}

/**
 * Create a Vercel AI SDK LanguageModel for a given provider.
 *
 * @param providerType - Provider name (anthropic, openai, google, azure, etc.)
 * @param apiKey - Decrypted API key
 * @param baseUrl - Optional custom base URL (only pass when explicitly configured)
 * @param modelId - Full model ID (may include provider prefix like "openai/gpt-4o")
 * @param useResponsesApi - Override for OpenAI Responses API (true/false/undefined=auto)
 * @param authConfig - Provider-specific auth config (e.g., Azure resourceName, apiVersion)
 * @returns Vercel AI SDK LanguageModel
 */
export function createVercelProvider(
  providerType: string,
  apiKey: string,
  baseUrl: string | undefined,
  modelId: string,
  useResponsesApi?: boolean,
  authConfig?: Record<string, unknown>,
): LanguageModel {
  // Strip provider prefix from model ID for direct provider calls
  const cleanModelId = stripLeadingPlatformModelProviderPrefix(modelId);
  const { providerModelId, capabilityModelId } = resolveProviderModelIdentity(
    providerType,
    modelId,
  );

  switch (providerType) {
    case 'anthropic': {
      const providerFactory = createAnthropic({ apiKey, baseURL: baseUrl });
      return guardUnsupportedSamplingParameters(
        providerFactory(providerModelId),
        capabilityModelId,
      );
    }

    case 'microsoft_foundry_anthropic': {
      return createAnthropicMessagesProvider({
        providerName: MICROSOFT_FOUNDRY_ANTHROPIC_PROVIDER_NAME,
        apiKey,
        baseUrl,
        modelId: cleanModelId,
        authConfig,
      });
    }

    case 'openai': {
      const customHeaders = readStringRecord(authConfig?.headers);
      const providerFactory = createOpenAI({
        apiKey,
        baseURL: baseUrl,
        ...(hasEntries(customHeaders) ? { headers: customHeaders } : {}),
      });
      // Responses API decision:
      //   true  → forced on (DB override)
      //   false → forced off (DB override)
      //   null/undefined → auto-detect from MODEL_REGISTRY
      const shouldUseResponsesApi =
        useResponsesApi !== false &&
        (useResponsesApi === true || modelSupportsResponsesApi(capabilityModelId));
      if (shouldUseResponsesApi) {
        return guardUnsupportedSamplingParameters(
          providerFactory(providerModelId),
          capabilityModelId,
        );
      }
      return guardUnsupportedSamplingParameters(
        providerFactory.chat(providerModelId),
        capabilityModelId,
      );
    }

    case 'google':
    case 'gemini': {
      const providerFactory = createGoogleGenerativeAI({ apiKey, baseURL: baseUrl });
      return guardUnsupportedSamplingParameters(
        providerFactory(providerModelId),
        capabilityModelId,
      );
    }

    case 'vertex':
    case 'vertex_ai':
    case 'google_vertex': {
      const providerFactory = createVertex({ project: 'default', location: 'us-central1' });
      return guardUnsupportedSamplingParameters(
        providerFactory(providerModelId),
        capabilityModelId,
      );
    }

    case 'azure': {
      const resourceName = readNonEmptyString(authConfig?.resourceName);
      const AZURE_DEFAULT_API_VERSION = '2024-10-21';
      const apiVersion = readNonEmptyString(authConfig?.apiVersion) || AZURE_DEFAULT_API_VERSION;
      const deploymentId = readNonEmptyString(authConfig?.deploymentId);
      const { deploymentName, capabilityModelId } = resolveAzureModelIdentity(modelId);
      const azureOpts: Record<string, unknown> = {
        apiKey,
        apiVersion,
        useDeploymentBasedUrls: true,
      };
      if (resourceName) {
        azureOpts.resourceName = resourceName;
      } else if (baseUrl) {
        azureOpts.baseURL = baseUrl;
      }
      const providerFactory = createAzure(azureOpts as Parameters<typeof createAzure>[0]);
      return guardUnsupportedSamplingParameters(
        providerFactory.chat(deploymentId ?? deploymentName),
        capabilityModelId,
      );
    }

    case 'cohere': {
      const providerFactory = createCohere({ apiKey, baseURL: baseUrl });
      return guardUnsupportedSamplingParameters(
        providerFactory(providerModelId),
        capabilityModelId,
      );
    }

    // --- OpenAI-compatible providers (each has its own base URL) ---
    case 'groq': {
      const providerFactory = createOpenAI({
        apiKey,
        baseURL: baseUrl || 'https://api.groq.com/openai/v1',
      });
      return guardUnsupportedSamplingParameters(
        providerFactory.chat(providerModelId),
        capabilityModelId,
      );
    }

    case 'mistral': {
      const providerFactory = createOpenAI({
        apiKey,
        baseURL: baseUrl || 'https://api.mistral.ai/v1',
      });
      return guardUnsupportedSamplingParameters(
        providerFactory.chat(providerModelId),
        capabilityModelId,
      );
    }

    case 'fireworks': {
      const providerFactory = createOpenAI({
        apiKey,
        baseURL: baseUrl || 'https://api.fireworks.ai/inference/v1',
      });
      return guardUnsupportedSamplingParameters(
        providerFactory.chat(providerModelId),
        capabilityModelId,
      );
    }

    case 'togetherai':
    case 'together': {
      const providerFactory = createOpenAI({
        apiKey,
        baseURL: baseUrl || 'https://api.together.xyz/v1',
      });
      return guardUnsupportedSamplingParameters(
        providerFactory.chat(providerModelId),
        capabilityModelId,
      );
    }

    case 'perplexity': {
      const providerFactory = createOpenAI({
        apiKey,
        baseURL: baseUrl || 'https://api.perplexity.ai',
      });
      return guardUnsupportedSamplingParameters(
        providerFactory.chat(providerModelId),
        capabilityModelId,
      );
    }

    case 'deepseek': {
      const providerFactory = createOpenAI({
        apiKey,
        baseURL: baseUrl || 'https://api.deepseek.com/v1',
      });
      return guardUnsupportedSamplingParameters(
        providerFactory.chat(providerModelId),
        capabilityModelId,
      );
    }

    case 'xai': {
      const providerFactory = createOpenAI({
        apiKey,
        baseURL: baseUrl || 'https://api.x.ai/v1',
      });
      return guardUnsupportedSamplingParameters(
        providerFactory.chat(providerModelId),
        capabilityModelId,
      );
    }

    case 'openrouter': {
      const providerFactory = createOpenAI({
        apiKey,
        baseURL: baseUrl || 'https://openrouter.ai/api/v1',
      });
      return guardUnsupportedSamplingParameters(
        providerFactory.chat(providerModelId),
        capabilityModelId,
      );
    }

    case 'litellm': {
      // LiteLLM proxy via OpenAI-compatible interface — keep provider/model prefix
      const providerFactory = createOpenAI({ apiKey, baseURL: baseUrl });
      return guardUnsupportedSamplingParameters(providerFactory(modelId), modelId);
    }

    case 'custom': {
      if (isAnthropicMessagesFormat(authConfig)) {
        return createAnthropicMessagesProvider({
          providerName: CUSTOM_ANTHROPIC_PROVIDER_NAME,
          apiKey,
          baseUrl,
          modelId: cleanModelId,
          authConfig,
        });
      }
      const providerFactory = createOpenAI({ apiKey, baseURL: baseUrl });
      return guardUnsupportedSamplingParameters(providerFactory.chat(modelId), modelId);
    }

    case 'mock': {
      // Mock LLM provider — returns canned responses without real LLM calls.
      // Uses a timer-based delay (setTimeout) for a configurable wait that keeps
      // the Node.js event loop completely free to process other requests.
      if (!_MockLanguageModelV3 || !_simulateReadableStream) {
        throw new Error(
          'Mock LLM provider not available. Ensure the "ai" package includes "ai/test".',
        );
      }
      // MOCK_LLM_DELAY: "1000" for constant 1000ms, "1000-1500" for random range
      const delayEnv = process.env.MOCK_LLM_DELAY || '1000';
      const delayParts = delayEnv.split('-').map(Number);
      const MOCK_DELAY_MIN_MS = delayParts[0] || 1000;
      const MOCK_DELAY_MAX_MS = delayParts[1] || MOCK_DELAY_MIN_MS;

      /** Off-event-loop wait using a timer-based delay.
       *  Previous implementation used fetch-and-abort to httpbin.org/delay/10
       *  which created a new HTTPS connection per call (DNS + TCP + TLS handshake
       *  = ~180ms of CPU-intensive work on the event loop). setTimeout is truly
       *  non-blocking — the timer fires from libuv with zero event loop cost. */
      const offloadDelay = (delayMs: number): Promise<void> =>
        new Promise((resolve) => setTimeout(resolve, delayMs));

      const getDelayMs = (): number =>
        MOCK_DELAY_MIN_MS === MOCK_DELAY_MAX_MS
          ? MOCK_DELAY_MIN_MS
          : MOCK_DELAY_MIN_MS +
            Math.floor(Math.random() * (MOCK_DELAY_MAX_MS - MOCK_DELAY_MIN_MS + 1));

      return guardUnsupportedSamplingParameters(
        new _MockLanguageModelV3({
          provider: 'mock',
          modelId: cleanModelId,
          doGenerate: async () => {
            await offloadDelay(getDelayMs());
            return {
              content: [{ type: 'text', text: 'This is a mock LLM response.', id: 'mock-1' }],
              finishReason: { type: 'stop', rawType: 'stop' },
              usage: { inputTokens: { total: 10 }, outputTokens: { total: 8 } },
              warnings: [],
            };
          },
          doStream: async () => {
            await offloadDelay(getDelayMs());
            return {
              stream: _simulateReadableStream({
                chunks: [
                  { type: 'text-start', id: 'mock-1' },
                  { type: 'text-delta', id: 'mock-1', delta: 'This is a mock LLM response.' },
                  { type: 'text-end', id: 'mock-1' },
                  {
                    type: 'finish',
                    finishReason: { type: 'stop', rawType: 'stop' },
                    usage: { inputTokens: { total: 10 }, outputTokens: { total: 8 } },
                  },
                ],
                initialDelayInMs: null,
                chunkDelayInMs: null,
              }),
            };
          },
        }) as unknown as LanguageModel,
        cleanModelId,
      );
    }

    case 'bedrock': {
      const bedrockAuth = authConfig as BedrockAuthConfig | undefined;
      const region = bedrockAuth?.region || process.env.AWS_REGION || 'us-east-1';
      const bedrockCustomHeaders = withoutAuthHeaders(readStringRecord(bedrockAuth?.customHeaders));

      // IAM Role ARN path — cross-account STS AssumeRole to get temporary credentials.
      // The platform calls STS AssumeRole with the provided ARN to obtain short-lived
      // credentials scoped to the target account's Bedrock permissions.
      if (bedrockAuth?.roleArn) {
        if (!_fromTemporaryCredentials) {
          throw new Error(
            'Bedrock IAM Role ARN requires @aws-sdk/credential-providers. ' +
              'Ensure the package is installed in packages/llm.',
          );
        }
        const stsClientConfig: Record<string, unknown> = { region };
        if (bedrockAuth.stsEndpoint) {
          stsClientConfig.endpoint = bedrockAuth.stsEndpoint;
        }
        const tempCredProvider = _fromTemporaryCredentials({
          params: {
            RoleArn: bedrockAuth.roleArn,
            RoleSessionName: `abl-bedrock-${Date.now()}`,
            DurationSeconds: 3600,
          },
          clientConfig: stsClientConfig,
        });
        const providerFactory = createAmazonBedrock({
          region,
          credentialProvider: () => tempCredProvider(),
          ...(bedrockAuth.bedrockEndpoint ? { baseURL: bedrockAuth.bedrockEndpoint } : {}),
          ...(hasEntries(bedrockCustomHeaders) ? { headers: bedrockCustomHeaders } : {}),
        });
        const effectiveModelId = bedrockAuth.resourceArn || providerModelId;
        return guardUnsupportedSamplingParameters(
          providerFactory(effectiveModelId),
          capabilityModelId,
        );
      }

      // Ambient credentials path (IRSA / ECS Task Role / EC2 Instance Profile).
      if (bedrockAuth?.useAmbientCredentials === true) {
        if (!_fromNodeProviderChain) {
          throw new Error(
            'Bedrock ambient credentials require @aws-sdk/credential-providers. ' +
              'Ensure the package is installed in packages/llm.',
          );
        }
        const credChain = _fromNodeProviderChain!({ clientConfig: { region } });
        const providerFactory = createAmazonBedrock({
          region,
          credentialProvider: () => credChain(),
        });
        return guardUnsupportedSamplingParameters(
          providerFactory(providerModelId),
          capabilityModelId,
        );
      }

      // Explicit credentials path
      if (bedrockAuth?.accessKeyId && bedrockAuth?.secretAccessKey) {
        const providerFactory = createAmazonBedrock({
          region,
          accessKeyId: bedrockAuth.accessKeyId,
          secretAccessKey: bedrockAuth.secretAccessKey,
          ...(bedrockAuth.sessionToken ? { sessionToken: bedrockAuth.sessionToken } : {}),
        });
        return guardUnsupportedSamplingParameters(
          providerFactory(providerModelId),
          capabilityModelId,
        );
      }

      // Partial credentials — fail fast with a descriptive error
      if (bedrockAuth?.accessKeyId && !bedrockAuth?.secretAccessKey) {
        throw new Error(
          'Bedrock credential is missing secretAccessKey. ' +
            'Provide both accessKeyId and secretAccessKey for explicit credential mode.',
        );
      }

      throw new Error(
        'Bedrock credential requires either explicit AWS credentials ' +
          '(accessKeyId + secretAccessKey), a roleArn for STS AssumeRole, ' +
          'or useAmbientCredentials: true for platform IAM role mode.',
      );
    }

    default: {
      // Fallback: OpenAI-compatible with custom baseUrl
      const providerFactory = createOpenAI({ apiKey, baseURL: baseUrl });
      return guardUnsupportedSamplingParameters(providerFactory.chat(modelId), modelId);
    }
  }
}

/**
 * Create a Vercel AI SDK EmbeddingModel for a given provider.
 *
 * Mirror of {@link createVercelProvider} for embedding-only validation /
 * inference paths. Connection-test code uses this when the registry marks
 * a model with the `textToEmbedding` capability so the test hits
 * `/embeddings` rather than `/chat/completions`.
 *
 * Only providers with embedding registry entries are supported here. Add a
 * branch when a new embedding provider is registered.
 */
export function createVercelEmbeddingProvider(
  providerType: string,
  apiKey: string,
  baseUrl: string | undefined,
  modelId: string,
  authConfig?: Record<string, unknown>,
): EmbeddingModel {
  const { providerModelId } = resolveProviderModelIdentity(providerType, modelId);

  switch (providerType) {
    case 'openai': {
      const providerFactory = createOpenAI({ apiKey, baseURL: baseUrl });
      return providerFactory.embedding(providerModelId);
    }

    case 'azure': {
      const resourceName = readNonEmptyString(authConfig?.resourceName);
      const AZURE_DEFAULT_API_VERSION = '2024-10-21';
      const apiVersion = readNonEmptyString(authConfig?.apiVersion) || AZURE_DEFAULT_API_VERSION;
      const deploymentId = readNonEmptyString(authConfig?.deploymentId);
      const { deploymentName } = resolveAzureModelIdentity(modelId);
      const azureOpts: Record<string, unknown> = {
        apiKey,
        apiVersion,
        useDeploymentBasedUrls: true,
      };
      if (resourceName) {
        azureOpts.resourceName = resourceName;
      } else if (baseUrl) {
        azureOpts.baseURL = baseUrl;
      }
      const providerFactory = createAzure(azureOpts as Parameters<typeof createAzure>[0]);
      return providerFactory.embedding(deploymentId ?? deploymentName);
    }

    case 'cohere': {
      const providerFactory = createCohere({ apiKey, baseURL: baseUrl });
      return providerFactory.embedding(providerModelId);
    }

    default:
      throw new Error(
        `Embedding provider not supported for connection validation: ${providerType}. ` +
          `Add a branch to createVercelEmbeddingProvider when registering a new embedding provider.`,
      );
  }
}
