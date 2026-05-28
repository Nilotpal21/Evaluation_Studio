/**
 * Tenant Model Adapter
 *
 * Adapts Runtime's tenant model resolution for use in SearchAI.
 * Provides unified credential resolution using platform's tenant_models + llm_credentials.
 */

import type { ResolvedTenantModel } from './types.js';
import type { ITenantModel, ILLMCredential } from '@agent-platform/database/models';
import { resolveTenantPlaintextValue } from '@agent-platform/database';
import { getModel } from '../../db/index.js';
import { createLogger } from '@abl/compiler/platform';
import {
  AuthProfileError,
  dualReadCredentials,
} from '@agent-platform/shared/services/auth-profile';
import { resolveAuthProfileCredential } from '../../services/auth-profile-resolver.js';

const log = createLogger('tenant-model-adapter');
const SEARCH_AI_RESOLVER_CONSUMER = 'SearchAIResolver';
type TenantModelConnection = ITenantModel['connections'][number];

interface TenantModelResolutionContext {
  tenantId: string;
  tenantModelId: string;
  modelId: string | null;
  displayName: string;
  tier: string;
}

function buildResolutionLogContext(
  context: TenantModelResolutionContext,
): Record<string, string | null> {
  return {
    tenantId: context.tenantId,
    tenantModelId: context.tenantModelId,
    modelId: context.modelId,
    displayName: context.displayName,
    tier: context.tier,
  };
}

function createAuthProfileResolutionError(authProfileId: string): AuthProfileError {
  return new AuthProfileError(
    'AUTH_PROFILE_CREDENTIAL_RESOLUTION_FAILED',
    `Auth profile ${authProfileId} for ${SEARCH_AI_RESOLVER_CONSUMER} did not resolve credentials; refusing legacy fallback.`,
    500,
  );
}

async function resolveLegacyCredentialApiKey(
  connection: TenantModelConnection,
  context: TenantModelResolutionContext,
): Promise<string | null> {
  if (!connection.credentialId) {
    log.warn(`No credentialId on connection for model ${context.displayName}`, {
      ...buildResolutionLogContext(context),
    });
    return null;
  }

  const LLMCredential = getModel<ILLMCredential>('LLMCredential');

  // No .lean() — the encryption plugin decrypts encryptedApiKey in a
  // post-find hook. .lean() skips hooks and returns the raw encrypted blob.
  const credential = await LLMCredential.findOne({
    _id: connection.credentialId,
    tenantId: context.tenantId,
  });

  if (!credential) {
    log.warn(`Credential not found for model ${context.displayName}`, {
      ...buildResolutionLogContext(context),
      credentialId: connection.credentialId,
    });
    return null;
  }

  try {
    return await resolveTenantPlaintextValue(credential.encryptedApiKey, context.tenantId, {
      decryptionFailed: Boolean(
        (credential as ILLMCredential & { _decryptionFailed?: boolean })._decryptionFailed,
      ),
    });
  } catch (error) {
    log.warn(`Credential API key unavailable after decryption for model ${context.displayName}`, {
      ...buildResolutionLogContext(context),
      credentialId: connection.credentialId,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

async function resolveConnectionApiKey(
  connection: TenantModelConnection,
  context: TenantModelResolutionContext,
): Promise<string | null> {
  try {
    const { source, credentials: apiKey } = await dualReadCredentials<string | null>({
      authProfileId: connection.authProfileId,
      tenantId: context.tenantId,
      resolve: async () => {
        const profileResult = await resolveAuthProfileCredential({
          authProfileId: connection.authProfileId!,
          tenantId: context.tenantId,
        });
        if (!profileResult) {
          throw createAuthProfileResolutionError(connection.authProfileId!);
        }
        return profileResult.apiKey;
      },
      legacyFallback: () => resolveLegacyCredentialApiKey(connection, context),
      consumer: SEARCH_AI_RESOLVER_CONSUMER,
    });

    if (source === 'auth-profile') {
      log.debug('Credential resolved via auth profile', {
        ...buildResolutionLogContext(context),
        authProfileId: connection.authProfileId,
      });
    }

    return apiKey;
  } catch (error) {
    if (connection.authProfileId) {
      log.warn('Auth profile resolution failed for SearchAI tenant model', {
        ...buildResolutionLogContext(context),
        authProfileId: connection.authProfileId,
        error: error instanceof Error ? error.message : String(error),
      });
    }

    throw error;
  }
}

// ─── Tenant Model Resolution ─────────────────────────────────────────────────

/**
 * Resolve a tenant model by tier with credential decryption
 *
 * @param tenantId - Tenant ID
 * @param tier - Model tier (fast/balanced/powerful)
 * @returns Resolved model with decrypted API key, or null if not found
 */
export async function resolveTenantModelForTier(
  tenantId: string,
  tier: 'fast' | 'balanced' | 'powerful',
): Promise<ResolvedTenantModel | null> {
  try {
    const TenantModel = getModel<ITenantModel>('TenantModel');

    // Find model with matching tier
    // No .lean() — keep consistent with LLMCredential query pattern below
    const model = await TenantModel.findOne({
      tenantId,
      tier,
      isActive: true,
      inferenceEnabled: true,
    }).sort({ isDefault: -1, updatedAt: -1 });

    if (!model) {
      log.debug(`No ${tier} tier model found for tenant`, { tenantId, tier });
      return null;
    }

    log.debug(`Found ${tier} tier model for tenant`, {
      tenantId,
      tier,
      modelId: model.modelId,
      displayName: model.displayName,
    });

    // Get primary connection
    const connection = model.connections?.find(
      (candidate) => candidate.isPrimary && candidate.isActive,
    );

    if (!connection) {
      log.warn(`Model ${model.displayName} has no primary connection`, {
        tenantId,
        modelId: model.modelId,
      });
      return null;
    }

    const apiKey = await resolveConnectionApiKey(connection, {
      tenantId,
      tenantModelId: model._id,
      modelId: model.modelId,
      displayName: model.displayName,
      tier: model.tier,
    });

    if (!apiKey) {
      log.warn(`No API key available for model ${model.displayName}`, {
        tenantId,
        modelId: model.modelId,
      });
      return null;
    }

    // Return resolved model
    return {
      modelId: model.modelId!,
      provider: model.provider!,
      displayName: model.displayName,
      tier: model.tier as 'fast' | 'balanced' | 'powerful',
      apiKey,
      endpointUrl: model.endpointUrl || model.customEndpoint || null,
      temperature: model.temperature,
      maxTokens: model.maxTokens,
      supportsTools: model.supportsTools,
      supportsVision: model.supportsVision,
      supportsStreaming: model.supportsStreaming,
    };
  } catch (error) {
    log.error(`Error resolving tenant model for tier ${tier}`, {
      tenantId,
      tier,
      error,
    });
    throw error;
  }
}

/**
 * Check if tenant has any models configured
 *
 * @param tenantId - Tenant ID
 * @returns True if tenant has at least one active model with credentials
 */
export async function hasTenantModelsConfigured(tenantId: string): Promise<boolean> {
  try {
    const TenantModel = getModel<ITenantModel>('TenantModel');

    const count = await TenantModel.countDocuments({
      tenantId,
      isActive: true,
      inferenceEnabled: true,
      'connections.0': { $exists: true }, // Has at least one connection
    });

    return count > 0;
  } catch (error) {
    log.error('Error checking if tenant has models configured', { tenantId, error });
    throw error;
  }
}

/**
 * Get all configured tiers for a tenant
 *
 * @param tenantId - Tenant ID
 * @returns Array of tiers that have models configured
 */
export async function getConfiguredTiers(
  tenantId: string,
): Promise<Array<'fast' | 'balanced' | 'powerful'>> {
  try {
    const TenantModel = getModel<ITenantModel>('TenantModel');

    const tenantModels = await TenantModel.find({
      tenantId,
      isActive: true,
      inferenceEnabled: true,
    }).select('tier');

    const tiers = new Set<'fast' | 'balanced' | 'powerful'>();
    for (const m of tenantModels) {
      if (m.tier) {
        tiers.add(m.tier as 'fast' | 'balanced' | 'powerful');
      }
    }

    return Array.from(tiers);
  } catch (error) {
    log.error('Error getting configured tiers', { tenantId, error });
    throw error;
  }
}

// ─── Direct Model Resolution ────────────────────────────────────────────────

/**
 * Resolve a specific tenant model by ID with credential decryption
 *
 * Used when a KB has a pinned model (queryLLMConfig.modelId is set).
 *
 * @param tenantId - Tenant ID
 * @param tenantModelId - TenantModel._id to resolve
 * @returns Resolved model with decrypted API key, or null if not found/inactive
 */
export async function resolveTenantModelById(
  tenantId: string,
  tenantModelId: string,
): Promise<ResolvedTenantModel | null> {
  try {
    const TenantModel = getModel<ITenantModel>('TenantModel');

    const model = await TenantModel.findOne({
      _id: tenantModelId,
      tenantId,
      isActive: true,
      inferenceEnabled: true,
    });

    if (!model) {
      log.debug('Pinned model not found or inactive', { tenantId, tenantModelId });
      return null;
    }

    // Get primary connection (same pattern as resolveTenantModelForTier)
    const connection = model.connections?.find(
      (candidate) => candidate.isPrimary && candidate.isActive,
    );
    if (!connection) {
      log.warn(`Pinned model ${model.displayName} has no primary connection`, {
        tenantId,
        tenantModelId,
      });
      return null;
    }

    const apiKey = await resolveConnectionApiKey(connection, {
      tenantId,
      tenantModelId: model._id,
      modelId: model.modelId,
      displayName: model.displayName,
      tier: model.tier,
    });

    if (!apiKey) {
      log.warn(`No API key for pinned model ${model.displayName}`, {
        tenantId,
        tenantModelId,
      });
      return null;
    }

    return {
      modelId: model.modelId!,
      provider: model.provider!,
      displayName: model.displayName,
      tier: model.tier as 'fast' | 'balanced' | 'powerful',
      apiKey,
      endpointUrl: model.endpointUrl || model.customEndpoint || null,
      temperature: model.temperature,
      maxTokens: model.maxTokens,
      supportsTools: model.supportsTools,
      supportsVision: model.supportsVision,
      supportsStreaming: model.supportsStreaming,
    };
  } catch (error) {
    log.error('Error resolving tenant model by ID', { tenantId, tenantModelId, error });
    throw error;
  }
}

// ─── Fallback Chain Resolution ───────────────────────────────────────────────

/**
 * Tier fallback chains - what to try if requested tier is unavailable
 */
const TIER_FALLBACK_CHAINS: Record<string, string[]> = {
  fast: ['balanced', 'powerful'], // Fast unavailable → try balanced → try powerful
  balanced: ['fast', 'powerful'], // Balanced unavailable → try fast → try powerful
  powerful: ['balanced', 'fast'], // Powerful unavailable → try balanced → try fast
};

export interface TierResolutionResult {
  /** Resolved model (null if no model found for any tier) */
  model: ResolvedTenantModel | null;

  /** Actual tier used (may differ from requested if fallback occurred) */
  actualTier: string;

  /** Resolution reason */
  reason: 'default_tier' | 'fallback' | 'no_model_available';

  /** Fallback chain that was tried (only if reason is 'fallback' or 'no_model_available') */
  fallbackChain?: string[];
}

/**
 * Resolve tenant model with automatic fallback to alternative tiers
 *
 * If requested tier is unavailable, tries fallback tiers in order.
 * This provides graceful degradation instead of hard failure.
 *
 * @param tenantId - Tenant ID
 * @param requestedTier - Desired tier
 * @returns Resolution result with model and metadata
 */
export async function resolveTenantModelWithFallback(
  tenantId: string,
  requestedTier: 'fast' | 'balanced' | 'powerful',
): Promise<TierResolutionResult> {
  // Try requested tier first
  let model = await resolveTenantModelForTier(tenantId, requestedTier);

  if (model) {
    log.debug(`Resolved ${requestedTier} tier model for tenant`, {
      tenantId,
      modelId: model.modelId,
    });

    return {
      model,
      actualTier: requestedTier,
      reason: 'default_tier',
    };
  }

  log.debug(`${requestedTier} tier model not available, trying fallbacks`, { tenantId });

  // Try fallback tiers
  const fallbackChain = TIER_FALLBACK_CHAINS[requestedTier] || [];

  for (const fallbackTier of fallbackChain) {
    model = await resolveTenantModelForTier(tenantId, fallbackTier as any);

    if (model) {
      log.info(`Using fallback ${fallbackTier} tier model for ${requestedTier} tier request`, {
        tenantId,
        requestedTier,
        actualTier: fallbackTier,
        modelId: model.modelId,
      });

      return {
        model,
        actualTier: fallbackTier,
        reason: 'fallback',
        fallbackChain,
      };
    }
  }

  // No model found at all
  log.warn(`No model available for tenant (requested ${requestedTier} tier, tried fallbacks)`, {
    tenantId,
    requestedTier,
    fallbackChain,
  });

  return {
    model: null,
    actualTier: requestedTier,
    reason: 'no_model_available',
    fallbackChain,
  };
}
