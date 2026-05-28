/**
 * LLM Configuration Resolver
 *
 * Resolves complete LLM configuration using inheritance hierarchy:
 * 1. SearchIndex.llmConfig.useCases.{useCase} (per-index feature config)
 * 2. USE_CASE_DEFAULTS (smart defaults when not specified)
 * 3. TenantLLMPolicy + LLMCredential (tenant credentials, budgets, rate limits)
 * 4. Global env vars (ANTHROPIC_API_KEY, etc.) - CREDENTIALS ONLY, useful for dev/testing
 *
 * Important: Feature configuration (enabled, modelTier, maxTokens) is ONLY from
 * per-index config. No global env var fallback for features (prevents dev/prod drift).
 */

import { getModel } from '../../db/index.js';
import { resolveTenantPlaintextValue } from '@agent-platform/database';
import { WorkerLLMClient } from '@agent-platform/llm';
import {
  DEFAULT_LLM_ALLOWED_PROVIDERS,
  mergeDefaultLlmAllowedProviders,
} from '@agent-platform/shared-kernel/llm-provider-identity';
import { getUseCaseDefaults, getUseCaseDefaultParams, getAvailableUseCases } from './defaults.js';
import {
  resolveTenantModelWithFallback,
  hasTenantModelsConfigured,
  type TierResolutionResult,
} from './tenant-model-adapter.js';
import type {
  EnhancedResolvedUseCaseConfig,
  EnhancedResolvedIndexLLMConfig,
  FeatureStatus,
  FeatureResolution,
  ActionRequired,
} from './types.js';
import { getUseCaseMetadata } from './metadata.js';
import { createLogger } from '@abl/compiler/platform';

// ─── Interfaces ──────────────────────────────────────────────────────────

export interface ResolvedUseCaseConfig {
  enabled: boolean;
  modelTier: 'fast' | 'balanced' | 'powerful';
  model: string; // Resolved from tier + provider (e.g., 'claude-haiku-4-5-20251001')
  provider: string; // 'anthropic', 'openai', 'gemini'
  apiKey: string; // Decrypted API key from tenant credentials
  [key: string]: any; // Use case-specific fields
}

export interface ResolvedIndexLLMConfig {
  // Tenant-level (from platform)
  tenantId: string;
  provider: string;
  apiKey: string; // Decrypted
  monthlyTokenBudget: number;
  dailyTokenBudget: number;
  maxRequestsPerMinute: number;
  allowedProviders: string[];

  // Index-level
  indexId: string;
  embeddingModel: string;
  embeddingDimensions: number;

  // Resolved use cases
  useCases: Record<string, ResolvedUseCaseConfig>;
}

// ─── Resolver ────────────────────────────────────────────────────────────

/**
 * Resolve complete LLM configuration for an index
 *
 * This is the main entry point for workers to get LLM config.
 * Handles all inheritance and fallback logic.
 *
 * @param tenantId - Tenant ID
 * @param indexId - SearchIndex ID
 * @returns Fully resolved configuration with all use cases
 */
export async function resolveIndexLLMConfig(
  tenantId: string,
  indexId: string,
): Promise<ResolvedIndexLLMConfig> {
  // 1. Load tenant LLM policy (budgets, rate limits, allowed providers)
  const tenantPolicy = await loadTenantLLMPolicy(tenantId);

  // 2. Load tenant LLM credentials (provider, API key)
  const credential = await loadTenantLLMCredential(tenantId);

  // 3. Load SearchIndex (embedding config + optional llmConfig)
  const SearchIndex = getModel('SearchIndex');
  const index = await SearchIndex.findOne({ _id: indexId });
  if (!index) {
    throw new Error(`SearchIndex not found: ${indexId}`);
  }

  if (index.tenantId !== tenantId) {
    throw new Error(
      `SearchIndex ${indexId} does not belong to tenant ${tenantId}. ` +
        `This is a security violation - tenant isolation broken!`,
    );
  }

  // 4. If no API key, return config with all LLM use cases disabled.
  // Non-LLM features (embedding, config-gated workers) still proceed.
  if (!credential.apiKey) {
    const useCases: Record<string, ResolvedUseCaseConfig> = {};
    for (const useCase of getAvailableUseCases()) {
      const defaultParams = getUseCaseDefaultParams(useCase);
      useCases[useCase] = {
        ...defaultParams,
        enabled: false,
        modelTier: defaultParams.modelTier ?? 'fast',
        model: '',
        provider: credential.provider,
        apiKey: '',
      };
    }

    return {
      tenantId,
      provider: credential.provider,
      apiKey: '',
      monthlyTokenBudget: tenantPolicy.monthlyTokenBudget,
      dailyTokenBudget: tenantPolicy.dailyTokenBudget,
      maxRequestsPerMinute: tenantPolicy.maxRequestsPerMinute,
      allowedProviders: tenantPolicy.allowedProviders,
      indexId,
      embeddingModel: index.embeddingModel,
      embeddingDimensions: index.embeddingDimensions,
      useCases,
    };
  }

  // 5. Create LLMClient to resolve model tiers
  const llmClient = new WorkerLLMClient(
    credential.provider,
    credential.apiKey,
    'default', // Model ID not used for tier resolution
  );

  // 6. Resolve each use case
  const useCases: Record<string, ResolvedUseCaseConfig> = {};

  for (const useCase of getAvailableUseCases()) {
    useCases[useCase] = resolveUseCaseConfig(
      useCase,
      index.llmConfig,
      credential.provider,
      llmClient,
      credential.apiKey,
    );
  }

  return {
    // Tenant-level
    tenantId,
    provider: credential.provider,
    apiKey: credential.apiKey,
    monthlyTokenBudget: tenantPolicy.monthlyTokenBudget,
    dailyTokenBudget: tenantPolicy.dailyTokenBudget,
    maxRequestsPerMinute: tenantPolicy.maxRequestsPerMinute,
    allowedProviders: tenantPolicy.allowedProviders,

    // Index-level
    indexId,
    embeddingModel: index.embeddingModel,
    embeddingDimensions: index.embeddingDimensions,

    // Resolved use cases
    useCases,
  };
}

/**
 * Resolve configuration for a single use case
 *
 * Inheritance order:
 * 1. Index override (if set)
 * 2. Smart defaults
 * 3. Provider from tenant
 *
 * @param useCase - Use case name
 * @param indexLLMConfig - Optional index-level LLM config
 * @param provider - Tenant's LLM provider
 * @param llmClient - LLMClient for tier resolution
 * @param apiKey - Decrypted API key from tenant credentials
 * @returns Resolved use case configuration
 */
function resolveUseCaseConfig(
  useCase: string,
  indexLLMConfig: any,
  provider: string,
  llmClient: WorkerLLMClient,
  apiKey: string,
): ResolvedUseCaseConfig {
  // 1. Get smart defaults for this use case
  const defaults = getUseCaseDefaults(useCase);
  const defaultParams = getUseCaseDefaultParams(useCase);

  // 2. Get index-level override (if exists)
  // Convert to plain object if it's a Mongoose subdocument
  const indexOverride = indexLLMConfig?.useCases?.[useCase]
    ? typeof indexLLMConfig.useCases[useCase].toObject === 'function'
      ? indexLLMConfig.useCases[useCase].toObject()
      : indexLLMConfig.useCases[useCase]
    : undefined;

  // 3. Check global enabled flag
  const globalEnabled = indexLLMConfig?.enabled ?? true; // Default: enabled

  // 4. Resolve each field with inheritance
  const enabled = indexOverride?.enabled ?? defaultParams.enabled;
  const modelTier = indexOverride?.modelTier ?? defaultParams.modelTier;

  // If globally disabled or use case disabled, return disabled config
  if (!globalEnabled || !enabled) {
    return {
      ...defaultParams, // Include default params for completeness
      ...indexOverride, // Include any overrides
      enabled: false, // Force disabled (must come after spreads)
      modelTier,
      model: llmClient.getModelForTier(modelTier),
      provider,
      apiKey, // Include apiKey for consistency (even when disabled)
    };
  }

  // 5. Resolve tier to actual model
  const model = llmClient.getModelForTier(modelTier);

  // 6. Merge default params with index overrides
  const resolvedConfig: ResolvedUseCaseConfig = {
    enabled: true,
    modelTier,
    model,
    provider,
    apiKey, // Include decrypted API key in each use case
    ...defaultParams, // Start with defaults
    ...indexOverride, // Override with index config
  };

  return resolvedConfig;
}

// ─── Enhanced Resolver (Platform tenant_models Integration) ─────────────

const log = createLogger('llm-config-resolver');

/**
 * Enhanced LLM configuration resolver using platform tenant_models
 *
 * This replaces the old LLMCredential-based approach with unified platform
 * model resolution. Returns enhanced configs with status tracking, resolution
 * metadata, and actionable guidance.
 *
 * Features:
 * - Uses tenant_models + llm_credentials (same as Runtime)
 * - Automatic tier fallback (fast→balanced→powerful)
 * - Status tracking (active/pending/fallback/disabled)
 * - Actionable guidance for missing config
 * - Cost estimates per feature
 *
 * @param tenantId - Tenant ID
 * @param indexId - SearchIndex ID
 * @returns Enhanced configuration with status and metadata
 */
export async function resolveEnhancedIndexLLMConfig(
  tenantId: string,
  indexId: string,
): Promise<EnhancedResolvedIndexLLMConfig> {
  try {
    // 1. Load SearchIndex
    const SearchIndex = getModel('SearchIndex');
    const index = await SearchIndex.findOne({ _id: indexId });
    if (!index) {
      throw new Error(`SearchIndex not found: ${indexId}`);
    }

    if (index.tenantId !== tenantId) {
      throw new Error(
        `SearchIndex ${indexId} does not belong to tenant ${tenantId}. ` +
          `Tenant isolation violation!`,
      );
    }

    // 2. Load tenant policy (budgets, rate limits)
    const tenantPolicy = await loadTenantLLMPolicy(tenantId);

    // 3. Check if tenant has any models configured
    const hasModels = await hasTenantModelsConfigured(tenantId);

    // 4. Resolve each use case with enhanced metadata
    const useCases: Record<string, EnhancedResolvedUseCaseConfig> = {};

    for (const useCase of getAvailableUseCases()) {
      useCases[useCase] = await resolveUseCaseWithMetadata(
        tenantId,
        useCase,
        index.llmConfig,
        hasModels,
      );
    }

    return {
      tenantId,
      indexId,
      enabled: index.llmConfig?.enabled ?? true,
      embeddingModel: index.embeddingModel,
      embeddingDimensions: index.embeddingDimensions,
      useCases,
      policy: {
        monthlyTokenBudget: tenantPolicy.monthlyTokenBudget,
        dailyTokenBudget: tenantPolicy.dailyTokenBudget,
        maxRequestsPerMinute: tenantPolicy.maxRequestsPerMinute,
        allowedProviders: tenantPolicy.allowedProviders,
      },
    };
  } catch (error) {
    log.error('Failed to resolve enhanced LLM config', { tenantId, indexId, error });
    throw error;
  }
}

/**
 * Resolve a single use case with full status tracking and metadata
 *
 * Handles all resolution scenarios:
 * - Active: Model found and configured
 * - Pending: No model configured yet
 * - Disabled: User explicitly disabled
 * - Fallback: Using different tier due to unavailability
 *
 * @param tenantId - Tenant ID
 * @param useCase - Use case name
 * @param indexLLMConfig - Index-level LLM config
 * @param hasModels - Whether tenant has any models configured
 * @returns Enhanced use case config with status and metadata
 */
async function resolveUseCaseWithMetadata(
  tenantId: string,
  useCase: string,
  indexLLMConfig: any,
  hasModels: boolean,
): Promise<EnhancedResolvedUseCaseConfig> {
  // Get metadata and defaults
  const metadata = getUseCaseMetadata(useCase);
  const defaultParams = getUseCaseDefaultParams(useCase);

  // Get index-level override
  const indexOverride = indexLLMConfig?.useCases?.[useCase]
    ? typeof indexLLMConfig.useCases[useCase].toObject === 'function'
      ? indexLLMConfig.useCases[useCase].toObject()
      : indexLLMConfig.useCases[useCase]
    : undefined;

  // Resolve enabled state
  const globalEnabled = indexLLMConfig?.enabled ?? true;
  const useCaseEnabled = indexOverride?.enabled ?? metadata.defaultEnabled;
  const enabled = globalEnabled && useCaseEnabled;

  // If user explicitly disabled, return disabled status
  if (!enabled) {
    return {
      useCase,
      status: 'disabled',
      enabled: false,
      modelTier: indexOverride?.modelTier ?? metadata.defaultTier,
      resolution: {
        reason: 'user_disabled',
        attemptedTier: metadata.defaultTier,
        message: 'Feature disabled by user',
      },
      ...defaultParams,
      ...indexOverride,
    };
  }

  // Feature is enabled - resolve model
  const requestedTier = indexOverride?.modelTier ?? metadata.defaultTier;

  // If a specific model is pinned for this use case, resolve it directly
  if (indexOverride?.preferredModelId) {
    const { resolveTenantModelById } = await import('./tenant-model-adapter.js');
    const pinnedModel = await resolveTenantModelById(tenantId, indexOverride.preferredModelId);
    if (pinnedModel) {
      return {
        useCase,
        status: 'active',
        enabled: true,
        modelTier: pinnedModel.tier as 'fast' | 'balanced' | 'powerful',
        model: {
          modelId: pinnedModel.modelId,
          provider: pinnedModel.provider,
          tier: pinnedModel.tier,
          displayName: pinnedModel.displayName,
        },
        provider: pinnedModel.provider,
        apiKey: pinnedModel.apiKey,
        endpointUrl: pinnedModel.endpointUrl ?? null,
        resolution: {
          reason: 'pinned',
          attemptedTier: requestedTier,
          message: `Using pinned model (${pinnedModel.displayName})`,
        },
        ...defaultParams,
        ...indexOverride,
      };
    }
    // Pinned model not found — fall through to tier-based resolution
  }

  // If no models configured at all, return pending status
  if (!hasModels) {
    return {
      useCase,
      status: 'pending',
      enabled: true,
      modelTier: requestedTier,
      resolution: {
        reason: 'no_model_available',
        attemptedTier: requestedTier,
        message: `No LLM models configured for tenant. Feature enabled but waiting for model configuration.`,
      },
      actionRequired: {
        action: 'configure_model',
        message: `Configure a ${requestedTier} tier model to enable ${metadata.displayName}`,
        ctaText: 'Configure Models',
        ctaLink: '/admin/models',
      },
      ...defaultParams,
      ...indexOverride,
    };
  }

  // Resolve model with automatic fallback
  const resolution = await resolveTenantModelWithFallback(tenantId, requestedTier);

  // No model found even with fallbacks
  if (!resolution.model) {
    return {
      useCase,
      status: 'pending',
      enabled: true,
      modelTier: requestedTier,
      resolution: {
        reason: 'no_model_available',
        attemptedTier: requestedTier,
        fallbackChain: resolution.fallbackChain,
        message: `No ${requestedTier} tier model configured. Tried fallbacks: ${resolution.fallbackChain?.join(', ') || 'none'}`,
      },
      actionRequired: {
        action: 'configure_model',
        message: `Configure a ${requestedTier} tier model (or ${resolution.fallbackChain?.[0]} as fallback) to enable ${metadata.displayName}`,
        ctaText: 'Configure Models',
        ctaLink: '/admin/models',
      },
      ...defaultParams,
      ...indexOverride,
    };
  }

  // Model found - determine status
  const status: FeatureStatus = resolution.reason === 'fallback' ? 'fallback' : 'active';

  const resolutionMetadata: FeatureResolution = {
    reason: resolution.reason,
    attemptedTier: requestedTier,
    fallbackChain: resolution.fallbackChain,
    message:
      resolution.reason === 'fallback'
        ? `Using ${resolution.actualTier} tier model (${resolution.model.displayName}) as fallback for ${requestedTier} tier`
        : `Using ${resolution.actualTier} tier model (${resolution.model.displayName})`,
  };

  return {
    useCase,
    status,
    enabled: true,
    modelTier: requestedTier,
    model: {
      modelId: resolution.model.modelId,
      provider: resolution.model.provider,
      tier: resolution.model.tier,
      displayName: resolution.model.displayName,
    },
    provider: resolution.model.provider,
    apiKey: resolution.model.apiKey,
    endpointUrl: resolution.model.endpointUrl || null,
    resolution: resolutionMetadata,
    ...defaultParams,
    ...indexOverride,
  };
}

// ─── Helper Functions ────────────────────────────────────────────────────

/**
 * Load tenant LLM policy (budgets, rate limits)
 *
 * Creates default policy if not exists.
 */
function normalizeTenantLLMPolicy(policy: any) {
  const policyObject =
    policy && typeof policy.toObject === 'function' ? policy.toObject() : (policy ?? {});
  const allowedProviders = Array.isArray(policyObject.allowedProviders)
    ? policyObject.allowedProviders.filter((provider: unknown): provider is string => {
        return typeof provider === 'string';
      })
    : undefined;

  return {
    ...policyObject,
    allowedProviders: mergeDefaultLlmAllowedProviders(allowedProviders),
  };
}

async function loadTenantLLMPolicy(tenantId: string) {
  const TenantLLMPolicy = getModel('TenantLLMPolicy');
  let policy = await TenantLLMPolicy.findOne({ tenantId });

  if (!policy) {
    console.warn(
      `[llm-config] No TenantLLMPolicy found for tenant ${tenantId}, creating default policy`,
    );

    policy = await TenantLLMPolicy.create({
      tenantId,
      allowedProviders: [...DEFAULT_LLM_ALLOWED_PROVIDERS],
      monthlyTokenBudget: 10_000_000, // 10M tokens/month
      dailyTokenBudget: 500_000, // 500K tokens/day
      maxRequestsPerMinute: 100,
      credentialPolicy: 'tenant',
      allowProjectCredentials: false,
      platformDemoEnabled: false,
    });
  }

  return normalizeTenantLLMPolicy(policy);
}

/**
 * Load tenant LLM credential (provider, API key)
 *
 * Falls back to global env vars (ANTHROPIC_API_KEY, etc.) for credentials only.
 * This is useful for dev/testing. Feature config is per-index only (no env fallback).
 */
async function loadTenantLLMCredential(
  tenantId: string,
): Promise<{ provider: string; apiKey: string }> {
  // 1. Check standalone LLMCredential collection (api integration)
  const LLMCredential = getModel('LLMCredential');
  const credential = await LLMCredential.findOne({
    tenantId,
    isActive: true,
    isDefault: true,
  });

  if (credential) {
    try {
      const apiKey = await resolveTenantPlaintextValue(credential.encryptedApiKey, tenantId, {
        decryptionFailed: Boolean(
          (credential as { _decryptionFailed?: boolean })._decryptionFailed,
        ),
      });

      return {
        provider: credential.provider,
        apiKey: apiKey ?? '',
      };
    } catch (error) {
      log.warn('LLMCredential API key unavailable after decryption; trying fallbacks', {
        tenantId,
        provider: credential.provider,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  // 2. Check TenantModel with embedded API key (easy integration)
  // The tenant may have configured a model with the API key stored directly
  // on the connection, without a separate LLMCredential document.
  const resolution = await resolveTenantModelWithFallback(tenantId, 'balanced');
  if (resolution?.model && resolution.model.apiKey) {
    console.log(
      `[llm-config] Using API key from TenantModel ${resolution.model.displayName} (${resolution.model.provider}) for tenant ${tenantId}`,
    );
    return {
      provider: resolution.model.provider,
      apiKey: resolution.model.apiKey,
    };
  }

  // 3. Fallback to global env vars for CREDENTIALS ONLY (useful for dev/testing)
  // Feature config (enabled, modelTier, maxTokens) is per-index only (no env fallback)
  console.warn(
    `[llm-config] No LLMCredential or TenantModel found for tenant ${tenantId}, falling back to env vars`,
  );

  const provider = process.env.DEFAULT_LLM_PROVIDER || 'anthropic';
  const apiKey = getAPIKeyFromEnv(provider);

  if (!apiKey) {
    console.warn(
      `[llm-config] No LLM credentials configured for tenant ${tenantId} and no global API key found. ` +
        `LLM-dependent features will be disabled. ` +
        `Configure tenant LLM credentials via platform admin or set ${provider.toUpperCase()}_API_KEY environment variable.`,
    );
    return { provider, apiKey: '' };
  }

  return { provider, apiKey };
}

/**
 * Get API key from environment variable
 */
function getAPIKeyFromEnv(provider: string): string | undefined {
  const envVars: Record<string, string[]> = {
    anthropic: ['ANTHROPIC_API_KEY'],
    openai: ['OPENAI_API_KEY'],
    google: ['GOOGLE_API_KEY', 'GEMINI_API_KEY'],
    gemini: ['GEMINI_API_KEY', 'GOOGLE_API_KEY'],
  };

  const candidates = envVars[provider];
  if (!candidates) {
    return undefined;
  }

  for (const envVar of candidates) {
    const value = process.env[envVar];
    if (value) {
      return value;
    }
  }

  return undefined;
}

// ─── Export for Testing ──────────────────────────────────────────────────

export const __testing = {
  resolveUseCaseConfig,
  resolveUseCaseWithMetadata,
  loadTenantLLMPolicy,
  loadTenantLLMCredential,
};

// ─── Re-exports ──────────────────────────────────────────────────────────

// Export enhanced types for consumers
export type {
  EnhancedResolvedUseCaseConfig,
  EnhancedResolvedIndexLLMConfig,
  FeatureStatus,
  FeatureResolution,
  ActionRequired,
} from './types.js';
