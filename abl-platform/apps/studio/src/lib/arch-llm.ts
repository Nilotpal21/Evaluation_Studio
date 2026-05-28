/**
 * Arch LLM Client
 *
 * Shared LLM client for Arch AI assistant server-side routes.
 * Uses Vercel AI SDK via @agent-platform/llm (same as runtime SessionLLMClient).
 *
 * Resolution order:
 *   1a. Model Hub credential (tenantModelId → TenantModel → LLMCredential)
 *   1b. Tenant's own API key (from ArchWorkspaceConfig, decrypted by encryption plugin)
 *   2.  Platform env key (ANTHROPIC_API_KEY / OPENAI_API_KEY / GEMINI_API_KEY)
 *   3.  Structured error (no key available)
 */

import { generateText } from 'ai';
import { z } from 'zod';
import { createVercelProvider as createVercelModel } from '@agent-platform/llm';
import { createLogger } from '@abl/compiler/platform/logger.js';
import { resolveWithGracePeriod } from '@agent-platform/shared/services/auth-profile';
import { resolveTenantPlaintextValue } from '@agent-platform/database';

const log = createLogger('arch-llm');
import type {
  LLMProvider,
  LLMProviderType,
  Message,
  CompletionOptions,
  CompletionResult,
  ToolCompletionOptions,
  ToolCompletionResult,
  ToolDefinition,
  StreamEvent,
} from '@abl/compiler/platform/llm/types.js';
import { LLMClient, getDefaultModel } from '@abl/compiler/platform/llm/provider.js';
import { inferModelProviderFromId } from '@abl/compiler/platform/llm/model-capabilities.js';
import {
  ensureConnected,
  ArchWorkspaceConfig,
  TenantModel,
  LLMCredential,
} from '@agent-platform/database/models';

// =============================================================================
// CONFIGURATION
// =============================================================================

/** Model used for Arch chat and generation. Overridable via env. */
const ARCH_CHAT_MODEL = process.env.ARCH_CHAT_MODEL || 'claude-sonnet-4-6';

/** Model used for structured generation (topology, ABL). Overridable via env. */
const ARCH_GENERATE_MODEL = process.env.ARCH_GENERATE_MODEL || 'claude-sonnet-4-6';

/** Max tokens for chat responses */
const ARCH_CHAT_MAX_TOKENS = 2048;

/** Max tokens for generation (topology, agents — can be large) */
const ARCH_GENERATE_MAX_TOKENS = 8192;

/** Request timeout in ms */
const ARCH_TIMEOUT_MS = 60_000;

/**
 * Remap known legacy/invalid Anthropic model IDs to their current equivalents.
 */
const LEGACY_MODEL_MAP: Record<string, string> = {
  'claude-sonnet-4-20250514': 'claude-sonnet-4-6',
  'claude-sonnet-4-5-20250929': 'claude-sonnet-4-6',
  'claude-haiku-4-20250514': 'claude-haiku-4-5-20251001',
  'claude-opus-4-20250514': 'claude-opus-4-7',
  'claude-opus-4-5-20250929': 'claude-opus-4-7',
  'claude-opus-4-6': 'claude-opus-4-7',
};

export function normalizeModelId(modelId: string): string {
  return LEGACY_MODEL_MAP[modelId] ?? modelId;
}

/** Provider to environment variable mapping */
const PROVIDER_KEY_MAP: Record<string, string[]> = {
  anthropic: ['ANTHROPIC_API_KEY'],
  openai: ['OPENAI_API_KEY'],
  google: ['GEMINI_API_KEY', 'GOOGLE_API_KEY'],
  gemini: ['GEMINI_API_KEY', 'GOOGLE_API_KEY'],
};

const AUTO_PLATFORM_PROVIDER_ORDER = ['anthropic', 'openai', 'google'] as const;

type ArchResolutionSource = 'tenant' | 'platform' | 'none';

export type ArchRequestedSource =
  | 'platform'
  | 'model_hub'
  | 'direct_api_key'
  | 'auth_profile'
  | 'auto';

export type ArchResolutionPath =
  | 'platform'
  | 'auto_platform'
  | 'model_hub'
  | 'auto_model_hub'
  | 'direct_api_key'
  | 'auth_profile'
  | 'none';

interface ArchRuntimeSettings {
  provider: string;
  model: string;
  maxTokensChat: number;
  maxTokensGenerate: number;
  temperature: number;
  lastValidatedAt: string | null;
}

interface SuccessfulArchTarget {
  source: Exclude<ArchResolutionSource, 'none'>;
  resolutionPath: Exclude<ArchResolutionPath, 'none'>;
  provider: string;
  model: string;
  apiKey: string;
  baseUrl?: string;
  useResponsesApi?: boolean | null;
  authConfig?: Record<string, unknown>;
}

interface ArchTargetAttempt {
  target: SuccessfulArchTarget | null;
  error?: string;
}

interface TenantModelConnectionCandidate {
  isPrimary?: boolean;
  isActive?: boolean;
  credentialId?: string;
  authProfileId?: string | null;
}

interface ResolvedArchCredential {
  apiKey: string;
  baseUrl?: string;
  authConfig?: Record<string, unknown>;
}

interface DecryptionAwareRecord {
  _decryptionFailed?: boolean;
}

export interface ArchEffectiveResolution extends ArchRuntimeSettings {
  source: ArchResolutionSource;
  resolutionPath: ArchResolutionPath;
  requestedSource: ArchRequestedSource;
  usedFallback: boolean;
  provider: string;
  model: string;
  apiKey: string | null;
  baseUrl?: string;
  useResponsesApi?: boolean | null;
  authConfig?: Record<string, unknown>;
  error?: string;
}

function normalizeProvider(provider: string | null | undefined, modelId?: string | null): string {
  const raw = (provider ?? inferModelProviderFromId(modelId) ?? 'anthropic').toLowerCase();
  return raw === 'gemini' ? 'google' : raw;
}

function resolveModelTargetProvider(
  provider: string | null | undefined,
  modelId: string | null | undefined,
  fallbackProvider: string,
): string {
  if (provider?.trim()) {
    return normalizeProvider(provider, modelId);
  }

  const inferredProvider = inferModelProviderFromId(modelId);
  return inferredProvider ? normalizeProvider(inferredProvider, modelId) : fallbackProvider;
}

function isUsableSecret(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length >= 10 && !value.includes(':');
}

function sanitizeEndpoint(endpoint: unknown): string | undefined {
  if (typeof endpoint !== 'string') return undefined;

  const raw = endpoint.trim();
  if (!raw) return undefined;

  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      return undefined;
    }
    return parsed.toString();
  } catch {
    return undefined;
  }
}

function isAzureOpenAIEndpoint(endpoint: string | undefined): boolean {
  if (!endpoint) return false;

  try {
    const host = new URL(endpoint).hostname.toLowerCase();
    return host === 'openai.azure.com' || host.endsWith('.openai.azure.com');
  } catch {
    return false;
  }
}

function extractAuthProfileEndpoint(config: unknown): string | undefined {
  if (!config || typeof config !== 'object') return undefined;

  const authConfig = config as Record<string, unknown>;
  return (
    sanitizeEndpoint(authConfig.endpoint) ??
    sanitizeEndpoint(authConfig.baseUrl) ??
    sanitizeEndpoint(authConfig.endpointUrl)
  );
}

function hasConnectionCredential(connection: TenantModelConnectionCandidate): boolean {
  return Boolean(connection.credentialId || connection.authProfileId);
}

function selectActiveConnection(connections: TenantModelConnectionCandidate[] | null) {
  if (!connections?.length) return null;

  return (
    connections.find((c) => c.isPrimary && c.isActive && hasConnectionCredential(c)) ??
    connections.find((c) => c.isActive && hasConnectionCredential(c)) ??
    connections.find((c) => hasConnectionCredential(c)) ??
    null
  );
}

async function resolveArchAuthProfileCredentialTarget(
  tenantId: string,
  authProfileId: string,
): Promise<ResolvedArchCredential | null> {
  const { AuthProfile } = await import('@agent-platform/database/models');
  const now = new Date();
  const profile = await (
    AuthProfile as {
      findOne: (query: Record<string, unknown>) => Promise<{
        encryptedSecrets?: string | null;
        previousEncryptedSecrets?: string | null;
        rotationGracePeriodMs?: number | null;
        updatedAt: Date;
        config?: Record<string, unknown> | null;
      } | null>;
    }
  ).findOne({
    _id: authProfileId,
    tenantId,
    status: 'active',
    $or: [{ expiresAt: null }, { expiresAt: { $gt: now } }],
  });

  if (!profile) {
    return null;
  }

  if (!profile.encryptedSecrets) {
    return null;
  }

  let secrets: Record<string, unknown>;
  try {
    secrets = await resolveWithGracePeriod(
      {
        encryptedSecrets: String(profile.encryptedSecrets),
        previousEncryptedSecrets: profile.previousEncryptedSecrets
          ? String(profile.previousEncryptedSecrets)
          : undefined,
        rotationGracePeriodMs: profile.rotationGracePeriodMs ?? undefined,
        updatedAt: profile.updatedAt,
      },
      async (value: string) => value,
    );
  } catch (err) {
    log.warn('Arch auth profile credentials unavailable after decryption', {
      tenantId,
      authProfileId,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }

  const apiKey =
    (secrets.apiKey as string | undefined) ?? (secrets.accessToken as string | undefined);
  if (!isUsableSecret(apiKey)) {
    return null;
  }

  return {
    apiKey,
    baseUrl: extractAuthProfileEndpoint(profile.config),
  };
}

function getPlatformApiKey(provider: string): { apiKey: string; envVar: string } | null {
  const envVars = PROVIDER_KEY_MAP[provider] ?? [];
  for (const envVar of envVars) {
    const value = process.env[envVar];
    if (isUsableSecret(value)) {
      return { apiKey: value, envVar };
    }
  }
  return null;
}

function getPlatformEnvHint(provider: string): string {
  const envVars = PROVIDER_KEY_MAP[provider] ?? [];
  if (envVars.length === 0) return 'a supported platform API key';
  return envVars.join(' or ');
}

function resolveModelForProvider(provider: string, preferredModelId?: string | null): string {
  const normalizedPreferred = preferredModelId ? normalizeModelId(preferredModelId) : null;
  const inferredProvider = normalizeProvider(undefined, normalizedPreferred);
  if (normalizedPreferred && inferredProvider === provider) {
    return normalizedPreferred;
  }

  const providerForDefaults = provider === 'google_vertex' ? 'vertex' : provider;
  try {
    return normalizeModelId(getDefaultModel(providerForDefaults, 'balanced'));
  } catch {
    return normalizedPreferred ?? ARCH_CHAT_MODEL;
  }
}

function validateTarget(
  providerType: string,
  apiKey: string,
  modelId: string,
  baseUrl?: string,
): string | null {
  try {
    createArchProvider(providerType, apiKey, modelId, baseUrl);
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : 'Failed to create LLM client';
  }
}

function buildSuccessfulTarget(params: SuccessfulArchTarget): ArchTargetAttempt {
  const provider = normalizeProvider(params.provider, params.model);
  const model = normalizeModelId(params.model);
  const baseUrl = sanitizeEndpoint(params.baseUrl);

  if (provider === 'openai' && isAzureOpenAIEndpoint(baseUrl)) {
    return {
      target: null,
      error: 'Azure OpenAI endpoints must use the Azure provider configuration.',
    };
  }

  const validationError = validateTarget(provider, params.apiKey, model, baseUrl);
  if (validationError) {
    return { target: null, error: validationError };
  }

  const { baseUrl: _rawBaseUrl, ...targetParams } = params;
  return {
    target: {
      ...targetParams,
      provider,
      model,
      ...(baseUrl ? { baseUrl } : {}),
    },
  };
}

function buildRuntimeSettings(
  config: {
    provider?: string | null;
    modelId?: string | null;
    maxTokensChat?: number | null;
    maxTokensGenerate?: number | null;
    temperature?: number | null;
    lastValidatedAt?: Date | null;
  } | null,
): ArchRuntimeSettings {
  const model = normalizeModelId(config?.modelId ?? ARCH_CHAT_MODEL);
  return {
    provider: normalizeProvider(config?.provider, model),
    model,
    maxTokensChat: config?.maxTokensChat ?? ARCH_CHAT_MAX_TOKENS,
    maxTokensGenerate: config?.maxTokensGenerate ?? ARCH_GENERATE_MAX_TOKENS,
    temperature: config?.temperature ?? 0.7,
    lastValidatedAt: config?.lastValidatedAt ? config.lastValidatedAt.toISOString() : null,
  };
}

function finalizeSuccessfulResolution(
  target: SuccessfulArchTarget,
  settings: ArchRuntimeSettings,
  requestedSource: ArchRequestedSource,
): ArchEffectiveResolution {
  return {
    ...settings,
    source: target.source,
    resolutionPath: target.resolutionPath,
    requestedSource,
    usedFallback: requestedSource !== 'auto' && target.resolutionPath !== requestedSource,
    provider: target.provider,
    model: target.model,
    apiKey: target.apiKey,
    ...(target.baseUrl ? { baseUrl: target.baseUrl } : {}),
    ...(target.useResponsesApi != null ? { useResponsesApi: target.useResponsesApi } : {}),
    ...(target.authConfig ? { authConfig: target.authConfig } : {}),
  };
}

function finalizeFailedResolution(
  settings: ArchRuntimeSettings,
  requestedSource: ArchRequestedSource,
  error: string,
): ArchEffectiveResolution {
  return {
    ...settings,
    source: 'none',
    resolutionPath: 'none',
    requestedSource,
    usedFallback: false,
    provider: settings.provider,
    model: settings.model,
    apiKey: null,
    error,
  };
}

function buildNoResolutionError(
  requestedSource: ArchRequestedSource,
  attemptedErrors: string[],
): string {
  const firstFailure = attemptedErrors.find(
    (error) => typeof error === 'string' && error.length > 0,
  );
  const setupGuidance =
    'Choose a Model Hub model, add a direct API key, or configure platform credits in Admin > Arch.';

  if (firstFailure) {
    return `${firstFailure} ${setupGuidance}`;
  }

  switch (requestedSource) {
    case 'platform':
      return `Arch could not use the saved Platform Credits selection. ${setupGuidance}`;
    case 'model_hub':
      return `Arch could not use the saved Model Hub selection. ${setupGuidance}`;
    case 'direct_api_key':
      return `Arch could not use the saved direct API key. ${setupGuidance}`;
    case 'auth_profile':
      return `Arch could not use the saved auth profile. ${setupGuidance}`;
    default:
      return `Arch could not find a usable model automatically. ${setupGuidance}`;
  }
}

function shouldRefuseAutomaticFallback(requestedSource: ArchRequestedSource): boolean {
  return requestedSource !== 'auto';
}

async function attemptTenantModelTarget(
  tenantId: string,
  tenantModel: {
    provider?: string | null;
    modelId?: string | null;
    useResponsesApi?: boolean | null;
    connections?: TenantModelConnectionCandidate[];
  } | null,
  fallbackProvider: string,
  fallbackModel: string,
  resolutionPath: SuccessfulArchTarget['resolutionPath'],
): Promise<ArchTargetAttempt> {
  if (!tenantModel) {
    return { target: null, error: 'No usable Model Hub model was found for Arch.' };
  }

  const connection = selectActiveConnection(tenantModel.connections ?? null);
  if (!connection) {
    return { target: null, error: 'The selected Model Hub model has no active credential.' };
  }

  const tenantModelUseResponsesApi = tenantModel.useResponsesApi ?? undefined;

  if (connection.authProfileId) {
    const resolvedAuthProfile = await resolveArchAuthProfileCredentialTarget(
      tenantId,
      connection.authProfileId,
    );
    if (!resolvedAuthProfile) {
      return {
        target: null,
        error: `Auth profile ${connection.authProfileId} for Arch did not resolve credentials; refusing legacy fallback.`,
      };
    }

    return buildSuccessfulTarget({
      source: 'tenant',
      resolutionPath,
      provider: resolveModelTargetProvider(
        tenantModel.provider,
        tenantModel.modelId,
        fallbackProvider,
      ),
      model: normalizeModelId(tenantModel.modelId ?? fallbackModel),
      apiKey: resolvedAuthProfile.apiKey,
      baseUrl: resolvedAuthProfile.baseUrl,
      authConfig: resolvedAuthProfile.authConfig,
      useResponsesApi: tenantModelUseResponsesApi,
    });
  }

  if (!connection.credentialId) {
    return { target: null, error: 'The selected Model Hub model has no active credential.' };
  }

  const credential = await LLMCredential.findOne({
    _id: connection.credentialId,
    tenantId,
    isActive: true,
  });

  if (!credential) {
    return { target: null, error: 'The selected Model Hub credential is missing or inactive.' };
  }

  const decryptionFailed = Boolean((credential as DecryptionAwareRecord)._decryptionFailed);

  let apiKey: string | null;
  let baseUrl: string | null;
  try {
    apiKey = await resolveTenantPlaintextValue(credential.encryptedApiKey ?? null, tenantId, {
      decryptionFailed,
    });
    baseUrl = await resolveTenantPlaintextValue(credential.encryptedEndpoint ?? null, tenantId, {
      decryptionFailed,
    });
  } catch (err) {
    log.warn('Arch Model Hub credential unavailable after decryption', {
      tenantId,
      credentialId: connection.credentialId,
      error: err instanceof Error ? err.message : String(err),
    });
    return { target: null, error: 'The selected Model Hub credential could not be decrypted.' };
  }

  if (!isUsableSecret(apiKey)) {
    return { target: null, error: 'The selected Model Hub credential could not be decrypted.' };
  }

  const credAuthConfig =
    credential.authConfig && typeof credential.authConfig === 'object'
      ? (credential.authConfig as Record<string, unknown>)
      : undefined;

  return buildSuccessfulTarget({
    source: 'tenant',
    resolutionPath,
    provider: resolveModelTargetProvider(
      tenantModel.provider,
      tenantModel.modelId,
      fallbackProvider,
    ),
    model: normalizeModelId(tenantModel.modelId ?? fallbackModel),
    apiKey,
    baseUrl: sanitizeEndpoint(baseUrl),
    useResponsesApi: tenantModelUseResponsesApi,
    authConfig: credAuthConfig,
  });
}

async function attemptSpecificTenantModel(
  tenantId: string,
  tenantModelId: string,
  fallbackProvider: string,
  fallbackModel: string,
  resolutionPath: SuccessfulArchTarget['resolutionPath'],
): Promise<ArchTargetAttempt> {
  const tenantModel = await TenantModel.findOne({
    _id: tenantModelId,
    tenantId,
    isActive: true,
  });

  if (!tenantModel) {
    return { target: null, error: 'The saved Model Hub model is missing or inactive.' };
  }

  return attemptTenantModelTarget(
    tenantId,
    tenantModel,
    fallbackProvider,
    fallbackModel,
    resolutionPath,
  );
}

async function attemptAutoTenantModel(
  tenantId: string,
  fallbackProvider: string,
  fallbackModel: string,
): Promise<ArchTargetAttempt> {
  const filters = [
    {
      tenantId,
      isDefault: true,
      isActive: true,
      inferenceEnabled: true,
      supportsTools: true,
      connections: {
        $elemMatch: {
          isActive: true,
          $or: [
            { credentialId: { $exists: true, $nin: [null, ''] } },
            { authProfileId: { $exists: true, $nin: [null, ''] } },
          ],
        },
      },
    },
    {
      tenantId,
      isDefault: true,
      isActive: true,
      inferenceEnabled: true,
      connections: {
        $elemMatch: {
          isActive: true,
          $or: [
            { credentialId: { $exists: true, $nin: [null, ''] } },
            { authProfileId: { $exists: true, $nin: [null, ''] } },
          ],
        },
      },
    },
    {
      tenantId,
      isActive: true,
      inferenceEnabled: true,
      supportsTools: true,
      connections: {
        $elemMatch: {
          isActive: true,
          $or: [
            { credentialId: { $exists: true, $nin: [null, ''] } },
            { authProfileId: { $exists: true, $nin: [null, ''] } },
          ],
        },
      },
    },
    {
      tenantId,
      isActive: true,
      inferenceEnabled: true,
      connections: {
        $elemMatch: {
          isActive: true,
          $or: [
            { credentialId: { $exists: true, $nin: [null, ''] } },
            { authProfileId: { $exists: true, $nin: [null, ''] } },
          ],
        },
      },
    },
  ];

  for (const filter of filters) {
    // Every entry in `filters` above is constructed with { tenantId, ... } —
    // the rule can't see through array iteration.
    // eslint-disable-next-line studio-tenant/no-unscoped-mongoose-query
    const tenantModel = await TenantModel.findOne(filter);
    if (tenantModel) {
      return attemptTenantModelTarget(
        tenantId,
        tenantModel,
        fallbackProvider,
        fallbackModel,
        'auto_model_hub',
      );
    }
  }

  return { target: null, error: 'No active Model Hub model is ready for Arch.' };
}

async function attemptAuthProfileTarget(
  tenantId: string,
  authProfileId: string,
  provider: string,
  model: string,
): Promise<ArchTargetAttempt> {
  const resolvedAuthProfile = await resolveArchAuthProfileCredentialTarget(tenantId, authProfileId);
  if (!resolvedAuthProfile) {
    return {
      target: null,
      error: `Auth profile ${authProfileId} was not found, expired, or does not contain usable credentials.`,
    };
  }

  return buildSuccessfulTarget({
    source: 'tenant',
    resolutionPath: 'auth_profile',
    provider,
    model,
    apiKey: resolvedAuthProfile.apiKey,
    baseUrl: resolvedAuthProfile.baseUrl,
  });
}

async function attemptDirectApiKeyTarget(
  tenantId: string,
  config: {
    encryptedApiKey?: string | null;
    encryptedEndpoint?: string | null;
  } | null,
  provider: string,
  model: string,
  resolutionPath: SuccessfulArchTarget['resolutionPath'],
): Promise<ArchTargetAttempt> {
  if (!config?.encryptedApiKey) {
    return { target: null, error: 'No direct API key is configured for Arch.' };
  }

  const decryptionFailed = Boolean((config as DecryptionAwareRecord)._decryptionFailed);

  let apiKey: string | null;
  let baseUrl: string | null;
  try {
    apiKey = await resolveTenantPlaintextValue(config.encryptedApiKey, tenantId, {
      decryptionFailed,
    });
    baseUrl = await resolveTenantPlaintextValue(config.encryptedEndpoint ?? null, tenantId, {
      decryptionFailed,
    });
  } catch (err) {
    log.warn('Arch direct API key unavailable after decryption', {
      tenantId,
      error: err instanceof Error ? err.message : String(err),
    });
    return { target: null, error: 'The saved direct API key could not be decrypted.' };
  }

  if (!isUsableSecret(apiKey)) {
    return { target: null, error: 'The saved direct API key could not be decrypted.' };
  }

  return buildSuccessfulTarget({
    source: 'tenant',
    resolutionPath,
    provider,
    model,
    apiKey,
    baseUrl: sanitizeEndpoint(baseUrl),
  });
}

function attemptPlatformTarget(
  provider: string,
  model: string,
  resolutionPath: SuccessfulArchTarget['resolutionPath'],
): ArchTargetAttempt {
  const platformCredential = getPlatformApiKey(provider);
  if (!platformCredential) {
    return {
      target: null,
      error: `Platform credits are not available for ${provider}. Set ${getPlatformEnvHint(provider)}.`,
    };
  }

  return buildSuccessfulTarget({
    source: 'platform',
    resolutionPath,
    provider,
    model,
    apiKey: platformCredential.apiKey,
  });
}

function attemptAutoPlatformTarget(preferredModel?: string | null): ArchTargetAttempt {
  const preferredProvider = normalizeProvider(undefined, preferredModel);
  const orderedProviders = [preferredProvider, ...AUTO_PLATFORM_PROVIDER_ORDER].filter(
    (value, index, array): value is string => value.length > 0 && array.indexOf(value) === index,
  );

  const errors: string[] = [];
  let foundPlatformCredential = false;
  for (const provider of orderedProviders) {
    const platformCredential = getPlatformApiKey(provider);
    if (!platformCredential) continue;
    foundPlatformCredential = true;

    const model = resolveModelForProvider(provider, preferredModel);
    const attempt = buildSuccessfulTarget({
      source: 'platform',
      resolutionPath: 'auto_platform',
      provider,
      model,
      apiKey: platformCredential.apiKey,
    });
    if (attempt.target) {
      return attempt;
    }
    if (attempt.error) {
      errors.push(attempt.error);
    }
  }

  return {
    target: null,
    error:
      errors[0] ??
      (foundPlatformCredential
        ? undefined
        : 'No platform API key is configured. Set ANTHROPIC_API_KEY, OPENAI_API_KEY, or GEMINI_API_KEY.'),
  };
}

// =============================================================================
// VERCEL AI SDK PROVIDER ADAPTER
// =============================================================================

/**
 * Convert ToolDefinition[] to Vercel AI SDK tool format with Zod schemas.
 * Mirrors runtime's convertTools() + jsonSchemaToZod() from vercel-ai-adapters.ts.
 * Vercel AI SDK requires Zod schemas, not raw JSON Schema objects.
 */
function convertToolsForVercel(
  tools: ToolDefinition[],
): Record<string, { description: string; inputSchema: z.ZodType }> {
  const result: Record<string, { description: string; inputSchema: z.ZodType }> = {};
  for (const tool of tools) {
    result[tool.name] = {
      description: tool.description,
      inputSchema: jsonSchemaToZod(tool.input_schema),
    };
  }
  return result;
}

/** Convert JSON Schema to Zod schema (same as runtime vercel-ai-adapters.ts) */
function jsonSchemaToZod(schema: any): z.ZodType {
  if (!schema || !schema.type) return z.object({});

  if (schema.type === 'object') {
    const shape: Record<string, z.ZodType> = {};
    for (const [key, propSchema] of Object.entries(schema.properties || {})) {
      let fieldSchema = jsonSchemaToZod(propSchema);
      if (!schema.required?.includes(key)) {
        fieldSchema = fieldSchema.optional();
      }
      shape[key] = fieldSchema;
    }
    return z.object(shape);
  }

  if (schema.type === 'string') {
    if (schema.enum) return z.enum(schema.enum as [string, ...string[]]);
    let s = z.string();
    if (schema.description) s = s.describe(schema.description);
    return s;
  }

  if (schema.type === 'number' || schema.type === 'integer') {
    let n = schema.type === 'integer' ? z.number().int() : z.number();
    if (schema.minimum !== undefined) n = n.min(schema.minimum);
    if (schema.maximum !== undefined) n = n.max(schema.maximum);
    if (schema.description) n = n.describe(schema.description);
    return n;
  }

  if (schema.type === 'boolean') {
    let b = z.boolean();
    if (schema.description) b = b.describe(schema.description);
    return b;
  }

  if (schema.type === 'array') {
    return z.array(jsonSchemaToZod(schema.items));
  }

  return z.any();
}

/**
 * Creates an LLMProvider backed by Vercel AI SDK via @agent-platform/llm.
 * Supports all providers (anthropic, openai, gemini, azure, litellm, cohere, etc.)
 * — same factory as SessionLLMClient in the runtime.
 */
function createArchProvider(
  providerType: string,
  apiKey: string,
  modelId: string,
  baseUrl?: string,
  useResponsesApi?: boolean,
  authConfig?: Record<string, unknown>,
): LLMProvider {
  const model = createVercelModel(
    providerType,
    apiKey,
    baseUrl,
    modelId,
    useResponsesApi,
    authConfig,
  );

  return {
    name: providerType as LLMProviderType,

    async complete(
      systemPrompt: string,
      messages: Message[],
      options: CompletionOptions,
    ): Promise<CompletionResult> {
      const startMs = Date.now();
      const result = await generateText({
        model,
        system: systemPrompt,
        messages: messages.map((m) => ({
          role: m.role as 'user' | 'assistant',
          content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content),
        })),
        maxOutputTokens: options.maxTokens,
        temperature: options.temperature,
        abortSignal: options.timeoutMs ? AbortSignal.timeout(options.timeoutMs) : undefined,
      });
      return {
        text: result.text,
        stopReason: result.finishReason as CompletionResult['stopReason'],
        model: modelId,
        latencyMs: Date.now() - startMs,
        usage: {
          inputTokens: result.usage?.inputTokens ?? 0,
          outputTokens: result.usage?.outputTokens ?? 0,
          totalTokens: (result.usage?.inputTokens ?? 0) + (result.usage?.outputTokens ?? 0),
        },
      };
    },

    async completeWithTools(
      systemPrompt: string,
      messages: Message[],
      options: ToolCompletionOptions,
    ): Promise<ToolCompletionResult> {
      const tools = options.tools ? convertToolsForVercel(options.tools) : undefined;

      const startMs = Date.now();
      const result = await generateText({
        model,
        system: systemPrompt,
        messages: messages.map((m) => ({
          role: m.role as 'user' | 'assistant',
          content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content),
        })),
        tools,
        maxOutputTokens: options.maxTokens,
        abortSignal: options.timeoutMs ? AbortSignal.timeout(options.timeoutMs) : undefined,
      });

      const toolCalls = (result.toolCalls ?? []).map((tc: any) => ({
        id: tc.toolCallId ?? `call_${Date.now()}`,
        name: tc.toolName,
        input: (tc.args ?? tc.input ?? {}) as Record<string, unknown>,
      }));

      return {
        text: result.text ?? '',
        stopReason:
          result.finishReason === 'tool-calls'
            ? 'tool_use'
            : (result.finishReason as ToolCompletionResult['stopReason']),
        toolCalls,
        model: modelId,
        latencyMs: Date.now() - startMs,
        usage: {
          inputTokens: result.usage?.inputTokens ?? 0,
          outputTokens: result.usage?.outputTokens ?? 0,
          totalTokens: (result.usage?.inputTokens ?? 0) + (result.usage?.outputTokens ?? 0),
        },
      };
    },

    async *streamComplete(
      systemPrompt: string,
      messages: Message[],
      options: CompletionOptions,
    ): AsyncIterable<StreamEvent> {
      const result = await this.complete(systemPrompt, messages, options);
      yield { type: 'text_delta', text: result.text } as StreamEvent;
    },

    async *streamCompleteWithTools(
      systemPrompt: string,
      messages: Message[],
      options: ToolCompletionOptions,
    ): AsyncIterable<StreamEvent> {
      const result = await this.completeWithTools(systemPrompt, messages, options);
      yield { type: 'text_delta', text: result.text } as StreamEvent;
    },

    getModelForTier() {
      return modelId;
    },

    supportsFeature() {
      return true;
    },
  };
}

/**
 * Create an LLMClient from provider type, API key, model ID, and optional base URL.
 * Passes an LLMProvider directly to LLMClient (bypasses deprecated createProvider).
 */
function createArchLLMClient(
  providerType: string,
  apiKey: string,
  modelId: string,
  baseUrl?: string,
  useResponsesApi?: boolean,
  authConfig?: Record<string, unknown>,
): LLMClient {
  const provider = createArchProvider(
    providerType,
    apiKey,
    modelId,
    baseUrl,
    useResponsesApi,
    authConfig,
  );
  return new LLMClient(provider);
}

// =============================================================================
// PER-TENANT RESOLUTION
// =============================================================================

/**
 * Resolve the effective Arch model source for a tenant. Status and execution
 * both use this helper so onboarding and runtime stay in sync.
 */
export async function resolveArchEffectiveResolution(
  tenantId: string,
): Promise<ArchEffectiveResolution> {
  try {
    await ensureConnected();
    const config = await ArchWorkspaceConfig.findOne({ tenantId, isActive: true });
    const settings = buildRuntimeSettings(config);

    const requestedSource: ArchRequestedSource = config?.tenantModelId
      ? 'model_hub'
      : config?.authProfileId
        ? 'auth_profile'
        : config?.usePlatformCredits
          ? 'platform'
          : config?.encryptedApiKey
            ? 'direct_api_key'
            : config
              ? 'direct_api_key'
              : 'auto';

    const attemptedErrors: string[] = [];

    if (config?.tenantModelId) {
      const attempt = await attemptSpecificTenantModel(
        tenantId,
        config.tenantModelId,
        settings.provider,
        settings.model,
        'model_hub',
      );
      if (attempt.target) {
        return finalizeSuccessfulResolution(attempt.target, settings, requestedSource);
      }
      if (attempt.error) {
        attemptedErrors.push(attempt.error);
      }
    } else if (config?.authProfileId) {
      const attempt = await attemptAuthProfileTarget(
        tenantId,
        config.authProfileId,
        settings.provider,
        settings.model,
      );
      if (attempt.target) {
        return finalizeSuccessfulResolution(attempt.target, settings, requestedSource);
      }
      if (attempt.error) {
        attemptedErrors.push(attempt.error);
      }
    } else if (config?.usePlatformCredits) {
      const attempt = attemptPlatformTarget(
        settings.provider,
        resolveModelForProvider(settings.provider, config.modelId ?? settings.model),
        'platform',
      );
      if (attempt.target) {
        return finalizeSuccessfulResolution(attempt.target, settings, requestedSource);
      }
      if (attempt.error) {
        attemptedErrors.push(attempt.error);
      }
    } else if (config?.encryptedApiKey) {
      const attempt = await attemptDirectApiKeyTarget(
        tenantId,
        config,
        settings.provider,
        settings.model,
        'direct_api_key',
      );
      if (attempt.target) {
        return finalizeSuccessfulResolution(attempt.target, settings, requestedSource);
      }
      if (attempt.error) {
        attemptedErrors.push(attempt.error);
      }
    } else if (config) {
      attemptedErrors.push('No direct API key is configured for Arch.');
    }

    if (shouldRefuseAutomaticFallback(requestedSource)) {
      log.warn('Arch model resolution explicit source failed; refusing automatic fallback', {
        tenantId,
        requestedSource,
        provider: settings.provider,
        model: settings.model,
        firstError: attemptedErrors[0],
      });
      return finalizeFailedResolution(
        settings,
        requestedSource,
        buildNoResolutionError(requestedSource, attemptedErrors),
      );
    }

    const autoPlatformAttempt = attemptAutoPlatformTarget(settings.model);
    if (autoPlatformAttempt.target) {
      return finalizeSuccessfulResolution(autoPlatformAttempt.target, settings, requestedSource);
    }
    if (autoPlatformAttempt.error) {
      attemptedErrors.push(autoPlatformAttempt.error);
    }

    const autoTenantModelAttempt = await attemptAutoTenantModel(
      tenantId,
      settings.provider,
      settings.model,
    );
    if (autoTenantModelAttempt.target) {
      return finalizeSuccessfulResolution(autoTenantModelAttempt.target, settings, requestedSource);
    }
    if (autoTenantModelAttempt.error) {
      attemptedErrors.push(autoTenantModelAttempt.error);
    }

    if (config?.encryptedApiKey && requestedSource !== 'direct_api_key') {
      const directKeyFallback = await attemptDirectApiKeyTarget(
        tenantId,
        config,
        settings.provider,
        settings.model,
        'direct_api_key',
      );
      if (directKeyFallback.target) {
        return finalizeSuccessfulResolution(directKeyFallback.target, settings, requestedSource);
      }
      if (directKeyFallback.error) {
        attemptedErrors.push(directKeyFallback.error);
      }
    }

    return finalizeFailedResolution(
      settings,
      requestedSource,
      buildNoResolutionError(requestedSource, attemptedErrors),
    );
  } catch (err) {
    log.error('Effective Arch resolution failed', {
      error: err instanceof Error ? err.message : String(err),
    });
    return finalizeFailedResolution(
      buildRuntimeSettings(null),
      'auto',
      'Failed to load Arch configuration.',
    );
  }
}

/**
 * Result of resolving the Arch LLM client for a tenant.
 * Always returns structured data — never throws.
 */
export interface ArchLLMResolution {
  client: LLMClient | null;
  model: string;
  provider: string;
  maxTokensChat: number;
  maxTokensGenerate: number;
  temperature: number;
  source: ArchResolutionSource;
  resolutionPath: ArchResolutionPath;
  requestedSource: ArchRequestedSource;
  usedFallback: boolean;
  error?: string;
}

/**
 * Resolve the Arch LLM client for a given tenant.
 */
export async function resolveArchLLMClient(tenantId: string): Promise<ArchLLMResolution> {
  const resolution = await resolveArchEffectiveResolution(tenantId);
  if (!resolution.apiKey || !resolution.provider || !resolution.model) {
    return {
      client: null,
      model: resolution.model,
      provider: resolution.provider,
      maxTokensChat: resolution.maxTokensChat,
      maxTokensGenerate: resolution.maxTokensGenerate,
      temperature: resolution.temperature,
      source: resolution.source,
      resolutionPath: resolution.resolutionPath,
      requestedSource: resolution.requestedSource,
      usedFallback: resolution.usedFallback,
      error: resolution.error,
    };
  }

  try {
    const client = createArchLLMClient(
      resolution.provider,
      resolution.apiKey,
      resolution.model,
      resolution.baseUrl,
      resolution.useResponsesApi ?? undefined,
      resolution.authConfig,
    );
    return {
      client,
      model: resolution.model,
      provider: resolution.provider,
      maxTokensChat: resolution.maxTokensChat,
      maxTokensGenerate: resolution.maxTokensGenerate,
      temperature: resolution.temperature,
      source: resolution.source,
      resolutionPath: resolution.resolutionPath,
      requestedSource: resolution.requestedSource,
      usedFallback: resolution.usedFallback,
    };
  } catch (err) {
    const error = err instanceof Error ? err.message : 'Failed to create LLM client';
    log.error('Arch LLM client creation failed after resolution', { error });
    return {
      client: null,
      model: resolution.model,
      provider: resolution.provider,
      maxTokensChat: resolution.maxTokensChat,
      maxTokensGenerate: resolution.maxTokensGenerate,
      temperature: resolution.temperature,
      source: 'none',
      resolutionPath: 'none',
      requestedSource: resolution.requestedSource,
      usedFallback: resolution.usedFallback,
      error,
    };
  }
}

// =============================================================================
// VERCEL AI SDK MODEL RESOLVER
// =============================================================================

export interface ArchVercelModelResolution {
  model: ReturnType<typeof createVercelModel> | null;
  modelId: string;
  provider: string;
  source: ArchResolutionSource;
  resolutionPath: ArchResolutionPath;
  requestedSource: ArchRequestedSource;
  usedFallback: boolean;
  error?: string;
}

/**
 * Resolve an Arch Vercel AI SDK LanguageModel for streamText/generateText.
 * Same credential resolution as resolveArchLLMClient but returns a LanguageModel
 * instead of an LLMClient.
 */
export async function resolveArchVercelModel(tenantId: string): Promise<ArchVercelModelResolution> {
  const resolution = await resolveArchEffectiveResolution(tenantId);
  if (!resolution.apiKey || !resolution.provider || !resolution.model) {
    return {
      model: null,
      modelId: resolution.model,
      provider: resolution.provider,
      source: resolution.source,
      resolutionPath: resolution.resolutionPath,
      requestedSource: resolution.requestedSource,
      usedFallback: resolution.usedFallback,
      error: resolution.error,
    };
  }

  try {
    return {
      model: createVercelModel(
        resolution.provider,
        resolution.apiKey,
        resolution.baseUrl,
        resolution.model,
        resolution.useResponsesApi ?? undefined,
        resolution.authConfig,
      ),
      modelId: resolution.model,
      provider: resolution.provider,
      source: resolution.source,
      resolutionPath: resolution.resolutionPath,
      requestedSource: resolution.requestedSource,
      usedFallback: resolution.usedFallback,
    };
  } catch (err) {
    const error = err instanceof Error ? err.message : 'Failed to create Vercel model';
    log.error('Arch Vercel model creation failed after resolution', {
      error,
      provider: resolution.provider,
      model: resolution.model,
      resolutionPath: resolution.resolutionPath,
    });
    return {
      model: null,
      modelId: resolution.model,
      provider: resolution.provider,
      source: 'none',
      resolutionPath: 'none',
      requestedSource: resolution.requestedSource,
      usedFallback: resolution.usedFallback,
      error: `Model configuration error: ${error}. Check your model settings in Arch configuration.`,
    };
  }
}

// =============================================================================
// EXPORTS
// =============================================================================

export {
  ARCH_CHAT_MODEL,
  ARCH_GENERATE_MODEL,
  ARCH_CHAT_MAX_TOKENS,
  ARCH_GENERATE_MAX_TOKENS,
  ARCH_TIMEOUT_MS,
};
