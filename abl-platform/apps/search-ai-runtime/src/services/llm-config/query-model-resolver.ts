/**
 * Query Model Resolver
 *
 * Resolves tenant models for the query pipeline by querying TenantModel
 * and LLMCredential collections directly via Mongoose.
 *
 * Mirrors the resolution logic from search-ai's tenant-model-adapter.ts
 * but uses the runtime's own Mongoose connection.
 */

import type { Model } from 'mongoose';
import type { ITenantModel, ILLMCredential } from '@agent-platform/database/models';
import { resolveTenantPlaintextValue } from '@agent-platform/database';
import { getLazyModel } from '../../db/index.js';
import { createLogger } from '@abl/compiler/platform';

const log = createLogger('query-model-resolver');

export interface ResolvedTenantModel {
  modelId: string;
  provider: string;
  displayName: string;
  tier: 'fast' | 'balanced' | 'powerful';
  apiKey: string;
  supportsTools?: boolean;
  supportsVision?: boolean;
  supportsStreaming?: boolean;
}

interface TierResolutionResult {
  model: ResolvedTenantModel | null;
  actualTier: string;
  reason: 'default_tier' | 'fallback' | 'no_model_available';
  fallbackChain?: string[];
}

const TIER_FALLBACK_CHAINS: Record<string, string[]> = {
  fast: ['balanced', 'powerful'],
  balanced: ['fast', 'powerful'],
  powerful: ['balanced', 'fast'],
};

/**
 * Resolve a specific tenant model by ID with credential decryption.
 */
export async function resolveTenantModelById(
  tenantId: string,
  tenantModelId: string,
): Promise<ResolvedTenantModel | null> {
  try {
    const TenantModel = getLazyModel<ITenantModel>('TenantModel');
    const LLMCredential = getLazyModel<ILLMCredential>('LLMCredential');

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

    return resolveModelCredential(model, tenantId, LLMCredential);
  } catch (error) {
    log.error('Error resolving tenant model by ID', { tenantId, tenantModelId, error });
    return null;
  }
}

/**
 * Resolve a tenant model by tier with automatic fallback.
 */
export async function resolveTenantModelWithFallback(
  tenantId: string,
  requestedTier: 'fast' | 'balanced' | 'powerful',
): Promise<TierResolutionResult> {
  const TenantModel = getLazyModel<ITenantModel>('TenantModel');
  const LLMCredential = getLazyModel<ILLMCredential>('LLMCredential');

  // Try requested tier
  let model = await findModelForTier(TenantModel, LLMCredential, tenantId, requestedTier);
  if (model) {
    return { model, actualTier: requestedTier, reason: 'default_tier' };
  }

  // Try fallback tiers
  const fallbackChain = TIER_FALLBACK_CHAINS[requestedTier] || [];
  for (const fallbackTier of fallbackChain) {
    model = await findModelForTier(
      TenantModel,
      LLMCredential,
      tenantId,
      fallbackTier as 'fast' | 'balanced' | 'powerful',
    );
    if (model) {
      return { model, actualTier: fallbackTier, reason: 'fallback', fallbackChain };
    }
  }

  return { model: null, actualTier: requestedTier, reason: 'no_model_available', fallbackChain };
}

async function findModelForTier(
  TenantModel: Model<ITenantModel>,
  LLMCredential: Model<ILLMCredential>,
  tenantId: string,
  tier: 'fast' | 'balanced' | 'powerful',
): Promise<ResolvedTenantModel | null> {
  const model = await TenantModel.findOne({
    tenantId,
    tier,
    isActive: true,
    inferenceEnabled: true,
  }).sort({ isDefault: -1, updatedAt: -1 });

  if (!model) return null;

  return resolveModelCredential(model, tenantId, LLMCredential);
}

async function resolveModelCredential(
  model: ITenantModel,
  tenantId: string,
  LLMCredential: Model<ILLMCredential>,
): Promise<ResolvedTenantModel | null> {
  const connection = (model as any).connections?.find((c: any) => c.isPrimary && c.isActive);
  if (!connection?.credentialId) {
    log.warn(`Model ${model.displayName} has no primary connection`, { tenantId });
    return null;
  }

  // No .lean() — encryption plugin decrypts in post-find hook
  const credential = await LLMCredential.findOne({
    _id: connection.credentialId,
    tenantId,
  });

  if (!credential?.encryptedApiKey) {
    log.warn(`No API key for model ${model.displayName}`, { tenantId });
    return null;
  }

  let apiKey: string | null = null;
  try {
    apiKey = await resolveTenantPlaintextValue(credential.encryptedApiKey, tenantId, {
      decryptionFailed: Boolean(
        (credential as ILLMCredential & { _decryptionFailed?: boolean })._decryptionFailed,
      ),
    });
  } catch (error) {
    log.warn(`Credential API key unavailable after decryption for model ${model.displayName}`, {
      tenantId,
      credentialId: connection.credentialId,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }

  if (!apiKey) {
    log.warn(`No API key for model ${model.displayName}`, { tenantId });
    return null;
  }

  return {
    modelId: model.modelId!,
    provider: model.provider!,
    displayName: model.displayName,
    tier: model.tier as 'fast' | 'balanced' | 'powerful',
    apiKey,
    supportsTools: model.supportsTools,
    supportsVision: model.supportsVision,
    supportsStreaming: model.supportsStreaming,
  };
}
