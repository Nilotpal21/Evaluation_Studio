/**
 * Arch service helpers still used by the legacy `/api/arch/*` configuration
 * endpoints that remain alongside the current Arch v3 experience.
 */

import { createLogger } from '@abl/compiler/platform/logger.js';
import { resolveArchEffectiveResolution, normalizeModelId } from '@/lib/arch-llm';
import { ensureConnected, ArchWorkspaceConfig, TenantModel } from '@agent-platform/database/models';

const log = createLogger('arch-service');

/** Timeout for API key validation requests (ms) */
const VALIDATION_TIMEOUT_MS = 10_000;

/** Curated recommended model IDs */
const ARCH_RECOMMENDED_IDS = new Set([
  'claude-sonnet-4-6',
  'claude-opus-4-7',
  'gpt-4o',
  'o1',
  'gemini-2.5-pro',
]);

/** Providers that are exclusively realtime/voice */
const REALTIME_ONLY_PROVIDERS = new Set(['ultravox']);

/** Config status result */
export interface ArchStatusResult {
  configured: boolean;
  model: string | null;
  provider: string | null;
  source: 'tenant' | 'platform' | 'none';
  resolutionPath?:
    | 'platform'
    | 'auto_platform'
    | 'model_hub'
    | 'auto_model_hub'
    | 'direct_api_key'
    | 'auth_profile'
    | 'none';
  requestedSource?: 'platform' | 'model_hub' | 'direct_api_key' | 'auth_profile' | 'auto';
  usedFallback?: boolean;
  lastValidatedAt: string | null;
  error: string | null;
}

/** Validate-key result */
export interface ArchValidateKeyResult {
  valid: boolean | null;
  message: string;
}

export interface ArchConfigData {
  modelId?: string;
  provider?: string;
  tenantModelId?: string | null;
  authProfileId?: string | null;
  usePlatformCredits?: boolean;
  maxTokensChat?: number;
  maxTokensGenerate?: number;
  temperature?: number;
  rateLimitRpm?: number;
  rateLimitRph?: number;
  systemPromptOverride?: string;
  authType?: string;
  customHeaders?: Record<string, string> | null;
  hyperParameters?: Record<string, unknown>;
  lastValidatedAt?: string | null;
  _v?: number;
  hasApiKey?: boolean;
  hasEndpoint?: boolean;
  isActive?: boolean;
  createdAt?: unknown;
  updatedAt?: unknown;
}

type ArchCredentialSource = 'model_hub' | 'auth_profile' | 'platform' | 'direct_api_key' | null;

function inferUpdatedCredentialSource(data: {
  tenantModelId?: string | null;
  authProfileId?: string | null;
  usePlatformCredits?: boolean;
  apiKey?: string;
}): ArchCredentialSource {
  if (data.tenantModelId) return 'model_hub';
  if (data.authProfileId) return 'auth_profile';
  if (data.usePlatformCredits === true) return 'platform';
  if (data.usePlatformCredits === false || data.apiKey !== undefined) return 'direct_api_key';
  return null;
}

function applyCredentialSourceCleanup(
  updateFields: {
    tenantModelId?: string | null;
    authProfileId?: string | null;
    usePlatformCredits?: boolean;
  },
  credentialSource: ArchCredentialSource,
): void {
  switch (credentialSource) {
    case 'model_hub':
      updateFields.authProfileId = null;
      updateFields.usePlatformCredits = false;
      return;
    case 'auth_profile':
      updateFields.tenantModelId = null;
      updateFields.usePlatformCredits = false;
      return;
    case 'platform':
      updateFields.tenantModelId = null;
      updateFields.authProfileId = null;
      return;
    case 'direct_api_key':
      updateFields.tenantModelId = null;
      updateFields.authProfileId = null;
      updateFields.usePlatformCredits = false;
      return;
    default:
      return;
  }
}

function shouldClearDirectCredentialFields(credentialSource: ArchCredentialSource): boolean {
  return (
    credentialSource === 'model_hub' ||
    credentialSource === 'auth_profile' ||
    credentialSource === 'platform'
  );
}

/**
 * Validate an API key against a provider's endpoint.
 */
export async function validateApiKey(
  provider: string,
  apiKey: string,
): Promise<ArchValidateKeyResult> {
  let valid: boolean | null = null;
  let message = '';

  try {
    if (provider === 'anthropic') {
      const response = await fetch('https://api.anthropic.com/v1/models', {
        method: 'GET',
        headers: {
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
        },
        signal: AbortSignal.timeout(VALIDATION_TIMEOUT_MS),
      });
      if (response.ok) {
        valid = true;
        message = 'API key is valid';
      } else if (response.status === 401) {
        valid = false;
        message = 'Invalid API key (authentication failed)';
      } else {
        valid = null;
        message = `Unable to determine validity (API returned ${response.status})`;
      }
    } else if (provider === 'openai') {
      const response = await fetch('https://api.openai.com/v1/models', {
        headers: { Authorization: `Bearer ${apiKey}` },
        signal: AbortSignal.timeout(VALIDATION_TIMEOUT_MS),
      });
      if (response.ok) {
        valid = true;
        message = 'API key is valid';
      } else if (response.status === 401) {
        valid = false;
        message = 'Invalid API key (authentication failed)';
      } else {
        valid = null;
        message = `Unable to determine validity (API returned ${response.status})`;
      }
    } else if (provider === 'gemini' || provider === 'google') {
      const response = await fetch(
        `https://generativelanguage.googleapis.com/v1/models?key=${encodeURIComponent(apiKey)}`,
        { signal: AbortSignal.timeout(VALIDATION_TIMEOUT_MS) },
      );
      if (response.ok) {
        valid = true;
        message = 'API key is valid';
      } else if (response.status === 400 || response.status === 403) {
        valid = false;
        message = 'Invalid API key (authentication failed)';
      } else {
        valid = null;
        message = `Unable to determine validity (API returned ${response.status})`;
      }
    } else {
      valid = null;
      message = `Automated validation not supported for provider '${provider}'`;
    }
  } catch (err) {
    valid = null;
    message = `Validation request failed: ${err instanceof Error ? err.message : String(err)}`;
  }

  return { valid, message };
}

export function getArchModels(
  modelRegistry: Record<
    string,
    {
      displayName: string;
      provider: string;
      supportsTools: boolean;
      contextWindow: number;
      maxOutputTokens: number;
      capabilities: unknown;
      hyperParameters: unknown;
      isReasoningModel?: boolean;
      supportsRealtimeVoice?: boolean;
    }
  >,
): { recommended: unknown[]; other: unknown[] } {
  const recommended: unknown[] = [];
  const other: unknown[] = [];

  for (const [modelId, entry] of Object.entries(modelRegistry)) {
    if (isRealtimeModel(modelId, entry)) continue;

    const isRecommended = ARCH_RECOMMENDED_IDS.has(modelId);
    const option = buildModelOption(modelId, entry, isRecommended);
    if (isRecommended) {
      recommended.push(option);
    } else {
      other.push(option);
    }
  }

  const recommendedOrder = [...ARCH_RECOMMENDED_IDS];
  recommended.sort(
    (a: any, b: any) => recommendedOrder.indexOf(a.modelId) - recommendedOrder.indexOf(b.modelId),
  );
  other.sort(
    (a: any, b: any) =>
      a.provider.localeCompare(b.provider) || a.displayName.localeCompare(b.displayName),
  );

  return { recommended, other };
}

/**
 * Get Arch AI status for a tenant.
 */
export async function getArchStatus(tenantId: string): Promise<ArchStatusResult> {
  const resolution = await resolveArchEffectiveResolution(tenantId);
  return {
    configured: resolution.source !== 'none',
    model: resolution.source === 'none' ? null : resolution.model,
    provider: resolution.source === 'none' ? null : resolution.provider,
    source: resolution.source,
    resolutionPath: resolution.resolutionPath,
    requestedSource: resolution.requestedSource,
    usedFallback: resolution.usedFallback,
    lastValidatedAt: resolution.lastValidatedAt,
    error: resolution.error ?? null,
  };
}

/**
 * Get the Arch workspace config for a tenant.
 */
export async function getArchConfig(tenantId: string): Promise<ArchConfigData | null> {
  await ensureConnected();
  const config = await ArchWorkspaceConfig.findOne({
    tenantId,
    isActive: true,
  });

  if (!config) return null;

  return {
    modelId: normalizeModelId(config.modelId),
    provider: config.provider,
    tenantModelId: config.tenantModelId,
    authProfileId: config.authProfileId,
    usePlatformCredits: config.usePlatformCredits,
    maxTokensChat: config.maxTokensChat,
    maxTokensGenerate: config.maxTokensGenerate,
    temperature: config.temperature,
    rateLimitRpm: config.rateLimitRpm,
    rateLimitRph: config.rateLimitRph,
    systemPromptOverride: config.systemPromptOverride,
    authType: config.authType,
    customHeaders: config.customHeaders,
    hyperParameters: config.hyperParameters,
    lastValidatedAt: config.lastValidatedAt,
    _v: config._v,
    hasApiKey: Boolean(config.encryptedApiKey),
    hasEndpoint: Boolean(config.encryptedEndpoint),
    isActive: config.isActive,
    createdAt: config.createdAt,
    updatedAt: config.updatedAt,
  };
}

/**
 * Update the Arch workspace config for a tenant.
 */
export async function updateArchConfig(
  tenantId: string,
  userId: string,
  data: {
    modelId?: string;
    provider?: string;
    usePlatformCredits?: boolean;
    maxTokensChat?: number;
    maxTokensGenerate?: number;
    temperature?: number;
    rateLimitRpm?: number;
    rateLimitRph?: number;
    apiKey?: string;
    endpoint?: string | null;
    authType?: 'api_key' | 'bearer' | 'custom';
    customHeaders?: Record<string, string> | null;
    hyperParameters?: Record<string, unknown>;
    tenantModelId?: string | null;
    authProfileId?: string | null;
    lastValidatedAt?: string | null;
  },
): Promise<
  | { success: true; data: ArchConfigData }
  | { success: false; error: { code: string; message: string }; status: number }
> {
  const { apiKey, endpoint, lastValidatedAt, ...updateFields } = data;
  const credentialSource = inferUpdatedCredentialSource(data);
  applyCredentialSourceCleanup(updateFields, credentialSource);

  if (updateFields.modelId) {
    updateFields.modelId = normalizeModelId(updateFields.modelId);
  }

  await ensureConnected();

  if (updateFields.tenantModelId) {
    const tenantModel = await TenantModel.findOne({
      _id: updateFields.tenantModelId,
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
    }).lean();
    if (!tenantModel) {
      return {
        success: false,
        error: {
          code: 'INVALID_REFERENCE',
          message: 'TenantModel not found',
        },
        status: 404,
      };
    }
  }

  let config = await ArchWorkspaceConfig.findOne({ tenantId });

  if (!config) {
    config = new ArchWorkspaceConfig({ tenantId, ...updateFields });
  } else {
    for (const [key, value] of Object.entries(updateFields)) {
      if (value !== undefined) {
        config.set(key, value);
      }
    }
  }

  if (apiKey !== undefined) {
    config.encryptedApiKey = apiKey;
  } else if (shouldClearDirectCredentialFields(credentialSource)) {
    config.encryptedApiKey = undefined;
  }

  if (endpoint !== undefined) {
    config.encryptedEndpoint = endpoint ?? undefined;
  } else if (shouldClearDirectCredentialFields(credentialSource)) {
    config.encryptedEndpoint = undefined;
  }

  if (lastValidatedAt !== undefined) {
    config.lastValidatedAt = lastValidatedAt ? new Date(lastValidatedAt) : null;
  }

  config.updatedBy = userId;
  config._v = (config._v ?? 0) + 1;

  await config.save();

  return {
    success: true,
    data: {
      modelId: normalizeModelId(config.modelId),
      provider: config.provider,
      tenantModelId: config.tenantModelId,
      authProfileId: config.authProfileId,
      usePlatformCredits: config.usePlatformCredits,
      maxTokensChat: config.maxTokensChat,
      maxTokensGenerate: config.maxTokensGenerate,
      temperature: config.temperature,
      authType: config.authType,
      hyperParameters: config.hyperParameters,
      lastValidatedAt: config.lastValidatedAt,
      _v: config._v,
      hasApiKey: Boolean(config.encryptedApiKey),
      hasEndpoint: Boolean(config.encryptedEndpoint),
    },
  };
}

function isRealtimeModel(
  modelId: string,
  entry: { supportsRealtimeVoice?: boolean; provider: string },
): boolean {
  if (entry.supportsRealtimeVoice) return true;
  if (REALTIME_ONLY_PROVIDERS.has(entry.provider)) return true;
  const lower = modelId.toLowerCase();
  if (lower.includes('realtime') || lower.includes('-live-') || lower.includes('-live ')) {
    return true;
  }
  return false;
}

function tierFromModel(
  modelId: string,
  entry: { isReasoningModel?: boolean },
): 'fast' | 'balanced' | 'powerful' {
  if (entry.isReasoningModel) return 'powerful';
  if (modelId.includes('mini') || modelId.includes('flash') || modelId.includes('haiku')) {
    return 'fast';
  }
  if (modelId.includes('opus') || modelId.includes('pro') || modelId.includes('o1')) {
    return 'powerful';
  }
  return 'balanced';
}

function buildModelOption(
  modelId: string,
  entry: {
    displayName: string;
    provider: string;
    supportsTools: boolean;
    contextWindow: number;
    maxOutputTokens: number;
    capabilities: unknown;
    hyperParameters: unknown;
    isReasoningModel?: boolean;
  },
  recommended: boolean,
) {
  return {
    modelId,
    displayName: entry.displayName,
    provider: entry.provider,
    tier: tierFromModel(modelId, entry),
    supportsTools: entry.supportsTools,
    recommended,
    contextWindow: entry.contextWindow,
    maxOutputTokens: entry.maxOutputTokens,
    capabilities: entry.capabilities,
    hyperParameters: entry.hyperParameters,
  };
}
