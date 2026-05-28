/**
 * Embedding Provider Resolver Initialization
 *
 * Creates and configures EmbeddingProviderResolver for the runtime.
 * Resolves per-KB embedding providers from pipeline activeEmbeddingConfig.
 */

import { EmbeddingProviderResolver } from '@agent-platform/search-ai-internal/embedding';
import type {
  EmbeddingConfigSource,
  EmbeddingCredentialSource,
} from '@agent-platform/search-ai-internal/embedding';
import { resolveTenantPlaintextValue } from '@agent-platform/database';
import { getLazyModel } from '../../db/index.js';
import { createLogger } from '@abl/compiler/platform';

const logger = createLogger('embedding-provider-resolver');

/**
 * Get active embedding config from a knowledge base's pipeline.
 * Uses the same pattern as embedding-worker: query pipeline by knowledgeBaseId.
 *
 * @param searchIndexId - SearchIndex._id (passed as kbId)
 * @param tenantId - Tenant ID
 */
async function getPipelineConfig(
  searchIndexId: string,
  tenantId: string,
): Promise<EmbeddingConfigSource> {
  logger.info('getPipelineConfig called', { searchIndexId, tenantId });

  const KnowledgeBase = getLazyModel('KnowledgeBase');
  const SearchPipelineDefinition = getLazyModel('SearchPipelineDefinition');

  logger.info('Models resolved', {
    hasKB: !!KnowledgeBase,
    hasPipeline: !!SearchPipelineDefinition,
  });

  // Step 1: Resolve KB ID from searchIndexId
  const kb = await KnowledgeBase.findOne({ searchIndexId, tenantId }).select('_id').lean();

  if (!kb) {
    logger.error('KB not found', { searchIndexId, tenantId });
    throw new Error(`KB not found for searchIndexId: ${searchIndexId}`);
  }

  const knowledgeBaseId = (kb as any)._id as string;
  logger.info('KB resolved', { knowledgeBaseId, searchIndexId });

  // Step 2: Query pipeline by knowledgeBaseId (same as embedding-worker)
  const pipeline = await SearchPipelineDefinition.findOne({
    tenantId,
    knowledgeBaseId,
    status: 'active',
  }).lean();

  if (!pipeline || !(pipeline as any).activeEmbeddingConfig) {
    logger.error('Pipeline not found or no activeEmbeddingConfig', {
      knowledgeBaseId,
      hasPipeline: !!pipeline,
      hasConfig: !!(pipeline as any)?.activeEmbeddingConfig,
    });
    throw new Error(`No active embedding config for KB ${knowledgeBaseId}`);
  }

  const config = (pipeline as any).activeEmbeddingConfig;
  logger.info('Pipeline config resolved successfully', {
    knowledgeBaseId,
    provider: config.provider,
    model: config.model,
    dimensions: config.dimensions,
    hasProviderConfig: !!config.providerConfig,
    pipelineBaseUrl: config.providerConfig?.baseUrl ?? 'NOT SET',
    envFallback: process.env.EMBEDDING_API_URL ?? 'NOT SET',
  });

  return {
    provider: config.provider,
    model: config.model,
    dimensions: config.dimensions,
    providerConfig: config.providerConfig,
  };
}

/**
 * Resolve embedding credentials for a provider and tenant
 */
async function resolveCredentials(
  provider: string,
  tenantId: string,
): Promise<EmbeddingCredentialSource> {
  const PROVIDERS_REQUIRING_CREDENTIALS = new Set(['openai', 'cohere', 'azure']);
  const ENV_VAR_MAP: Record<string, string> = {
    openai: 'OPENAI_API_KEY',
    cohere: 'COHERE_API_KEY',
    azure: 'AZURE_OPENAI_API_KEY',
  };

  // Self-hosted providers don't need credentials
  if (!PROVIDERS_REQUIRING_CREDENTIALS.has(provider)) {
    return { apiKey: '', source: 'none' };
  }

  // Try LLMCredential collection
  try {
    const LLMCredential = getLazyModel('LLMCredential');
    const credential = await LLMCredential.findOne({
      tenantId,
      provider,
      isActive: true,
    }).sort({ isDefault: -1, updatedAt: -1 });

    if (credential && (credential as any).encryptedApiKey) {
      const apiKey = await resolveTenantPlaintextValue(
        (credential as { encryptedApiKey?: string | null }).encryptedApiKey ?? null,
        tenantId,
        {
          decryptionFailed: Boolean(
            (credential as { _decryptionFailed?: boolean })._decryptionFailed,
          ),
        },
      );

      if (apiKey) {
        logger.debug('Resolved credential from LLMCredential', { tenantId, provider });
        return {
          apiKey,
          source: 'llm-credential',
        };
      }
    }
  } catch (error) {
    logger.warn('Failed to query LLMCredential', {
      tenantId,
      provider,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  // Fallback to environment variable
  const envVar = ENV_VAR_MAP[provider];
  if (envVar && process.env[envVar]) {
    logger.debug('Resolved credential from env var', { tenantId, provider, envVar });
    return { apiKey: process.env[envVar]!, source: 'env-var' };
  }

  logger.warn('No credentials found', { tenantId, provider });
  return { apiKey: '', source: 'none' };
}

/**
 * Create the global EmbeddingProviderResolver instance
 */
export function createEmbeddingProviderResolver(): EmbeddingProviderResolver {
  const baseUrlFallback = process.env.EMBEDDING_API_URL || process.env.EMBEDDING_BASE_URL;

  logger.info('Creating EmbeddingProviderResolver', {
    baseUrlFallback:
      baseUrlFallback ?? 'NONE — self-hosted providers will default to localhost:8000',
    EMBEDDING_API_URL: process.env.EMBEDDING_API_URL ?? 'NOT SET',
    EMBEDDING_BASE_URL: process.env.EMBEDDING_BASE_URL ?? 'NOT SET',
  });

  return new EmbeddingProviderResolver(getPipelineConfig, resolveCredentials, {
    maxCacheSize: 100,
    cacheTtlMs: 60 * 1000, // 60 seconds — short TTL as safety net; publish also invalidates cache directly
    baseUrlFallback,
  });
}
