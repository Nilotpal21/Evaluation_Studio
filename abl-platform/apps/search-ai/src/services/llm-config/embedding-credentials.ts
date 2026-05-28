/**
 * Embedding Credential Resolution — Unified
 *
 * Single resolution chain for ALL embedding providers (openai, azure, cohere, etc.).
 * No special-casing per provider — same lookup path for everyone.
 *
 * Resolution chain (tried in order, first match wins):
 * 1. TenantModel connections — Admin → Models with active connection credential
 * 2. LLMCredential direct — per-tenant encrypted keys (legacy, still supported)
 * 3. Auth Profile — if configured for provider/tenant
 * 4. Environment variable — dev/testing fallback only
 *
 * TenantModel is the primary path because that's where users configure
 * credentials through the Admin UI. All providers go through the same logic.
 *
 * Reference: docs/searchai/pipelines/design/backend/04-CONFIGURABLE-EMBEDDING-PROVIDERS.md
 */

import { getModel } from '../../db/index.js';
import { resolveTenantPlaintextValue } from '@agent-platform/database';
import { createLogger } from '@abl/compiler/platform';
import { resolveEmbeddingAuthProfile } from '../../services/auth-profile-resolver.js';

const logger = createLogger('embedding-credentials');

// ─── Types ───────────────────────────────────────────────────────────────

export interface EmbeddingCredentialResult {
  /** Resolved API key (empty string if not found) */
  apiKey: string;
  /** Source of the credential */
  source: 'tenant-model' | 'llm-credential' | 'auth-profile' | 'env-var' | 'none';
  /** Provider-specific auth config (e.g. Azure resourceName, deploymentId, apiVersion) */
  authConfig?: Record<string, unknown>;
}

// ─── Providers that need credentials ─────────────────────────────────────

/** Static list of providers that require API credentials. */
const PROVIDERS_REQUIRING_CREDENTIALS: readonly string[] = ['openai', 'cohere', 'azure'] as const;

/** Environment variable fallback map (dev/testing only). */
const ENV_VAR_MAP: Record<string, string> = {
  openai: 'OPENAI_API_KEY',
  cohere: 'COHERE_API_KEY',
  azure: 'AZURE_OPENAI_API_KEY',
};

// ─── Auth Config Resolution ─────────────────────────────────────────────

/**
 * Resolve authConfig from a credential field.
 *
 * The authConfig field can be stored as:
 * 1. Plain JSON string: '{"resourceName":"...", "deploymentId":"...", "apiVersion":"..."}'
 * 2. Encrypted string: 'EFNLVGpPYWhX...' (needs decryption first, then JSON parse)
 * 3. Object (already parsed by Mongoose)
 * 4. null/undefined
 *
 * Returns parsed config object or undefined.
 */
async function resolveAuthConfig(
  rawAuthConfig: unknown,
  tenantId: string,
  credentialId: string,
): Promise<Record<string, unknown> | undefined> {
  if (!rawAuthConfig) return undefined;

  // Already an object (Mongoose parsed it)
  if (typeof rawAuthConfig === 'object' && rawAuthConfig !== null) {
    return rawAuthConfig as Record<string, unknown>;
  }

  if (typeof rawAuthConfig !== 'string') return undefined;

  // Try 1: Plain JSON string
  try {
    const parsed = JSON.parse(rawAuthConfig);
    if (typeof parsed === 'object' && parsed !== null) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // Not valid JSON — might be encrypted
  }

  // Try 2: Encrypted string — decrypt then parse
  try {
    const decrypted = await resolveTenantPlaintextValue(rawAuthConfig, tenantId, {
      decryptionFailed: false,
    });
    if (decrypted) {
      try {
        const parsed = JSON.parse(decrypted);
        if (typeof parsed === 'object' && parsed !== null) {
          return parsed as Record<string, unknown>;
        }
      } catch {
        logger.warn('Decrypted authConfig is not valid JSON', { credentialId });
      }
    }
  } catch {
    logger.warn('Failed to decrypt authConfig', { credentialId });
  }

  return undefined;
}

// ─── Resolution ──────────────────────────────────────────────────────────

/**
 * Check whether an embedding provider requires API credentials.
 *
 * BGE-M3 (self-hosted) and custom endpoints do not require credentials.
 */
export function embeddingProviderRequiresCredentials(provider: string): boolean {
  return PROVIDERS_REQUIRING_CREDENTIALS.includes(provider);
}

/**
 * Resolve embedding credentials for a provider and tenant.
 *
 * Unified resolution — same path for openai, azure, cohere, or any future provider.
 * Self-hosted/custom providers skip resolution entirely.
 */
export async function resolveEmbeddingCredentials(
  provider: string,
  tenantId: string,
  /** Optional: the embedding model name (e.g. 'text-embedding-3-small').
   *  When provided, looks up the exact TenantModel by modelId first,
   *  ensuring the correct credential + authConfig is returned instead of
   *  picking up a chat model's credential. */
  modelId?: string,
): Promise<EmbeddingCredentialResult> {
  // Self-hosted or custom providers don't need credentials
  if (!embeddingProviderRequiresCredentials(provider)) {
    return { apiKey: '', source: 'none' };
  }

  // ─── 1. TenantModel connections (Admin → Models) — primary path ─────────
  // Resolution priority:
  //   a) Exact modelId match (when caller provides the embedding model name)
  //   b) Embedding-capable models (capabilities/modelId regex/tier)
  //   c) Any active model of this provider (fallback)
  //
  // Without this priority, Azure chat models (e.g. gpt-5.4-mini) get picked up
  // instead of embedding models (text-embedding-3-small), because findOne()
  // returns the first match by creation order. This causes deployment ID mismatches.
  try {
    const TenantModel = getModel('TenantModel');
    const LLMCredential = getModel('LLMCredential');

    const baseFilter = {
      tenantId,
      provider,
      isActive: true,
      'connections.isActive': true,
      'connections.credentialId': { $ne: null },
    };

    let tenantModel: any = null;

    // Priority 1: Exact modelId match — strongest isolation
    if (modelId) {
      tenantModel = await TenantModel.findOne({
        ...baseFilter,
        modelId,
      }).lean();
    }

    // Priority 2: Find a TenantModel explicitly marked as an embedding model
    if (!tenantModel) {
      tenantModel = await TenantModel.findOne({
        ...baseFilter,
        $or: [
          { capabilities: 'embedding' },
          { modelId: { $regex: /embed/i } },
          { tier: 'embedding' },
        ],
      }).lean();
    }

    // Priority 3: Fall back to any active model of this provider
    if (!tenantModel) {
      tenantModel = await TenantModel.findOne(baseFilter).lean();
    }

    if (tenantModel) {
      const connections = (tenantModel as any).connections || [];
      // Prefer primary connection, fall back to any active one with a credential
      const conn =
        connections.find((c: any) => c.isPrimary && c.isActive && c.credentialId) ||
        connections.find((c: any) => c.isActive && c.credentialId);

      if (conn?.credentialId) {
        const credential = await LLMCredential.findOne({
          _id: conn.credentialId,
          tenantId,
        });

        if (credential?.encryptedApiKey) {
          const apiKey = await resolveTenantPlaintextValue(credential.encryptedApiKey, tenantId, {
            decryptionFailed: Boolean(
              (credential as { _decryptionFailed?: boolean })._decryptionFailed,
            ),
          });

          if (apiKey) {
            // Parse authConfig for provider-specific settings (Azure: resourceName, deploymentId, apiVersion)
            // authConfig may be: plain JSON string, encrypted string, or object
            const authConfig = await resolveAuthConfig(
              (credential as any).authConfig,
              tenantId,
              String(conn.credentialId),
            );

            logger.debug('Embedding credential resolved from TenantModel connection', {
              tenantId,
              provider,
              tenantModelId: String((tenantModel as any)._id),
              hasAuthConfig: !!authConfig,
            });
            return { apiKey, source: 'tenant-model', authConfig };
          }
        }
      }
    }
  } catch (error) {
    logger.warn('Failed to resolve embedding credential from TenantModel', {
      tenantId,
      provider,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  // ─── 2. LLMCredential direct (legacy per-tenant storage) ────────────────
  try {
    const LLMCredential = getModel('LLMCredential');
    const credential = await LLMCredential.findOne({
      tenantId,
      provider,
      isActive: true,
    }).sort({ isDefault: -1, updatedAt: -1 });

    if (credential?.encryptedApiKey) {
      const apiKey = await resolveTenantPlaintextValue(credential.encryptedApiKey, tenantId, {
        decryptionFailed: Boolean(
          (credential as { _decryptionFailed?: boolean })._decryptionFailed,
        ),
      });

      if (apiKey) {
        // Parse authConfig for provider-specific settings
        // authConfig may be: plain JSON string, encrypted string, or object
        const authConfig = await resolveAuthConfig(
          (credential as any).authConfig,
          tenantId,
          String(credential._id),
        );

        logger.debug('Embedding credential resolved from LLMCredential', {
          tenantId,
          provider,
          hasAuthConfig: !!authConfig,
        });
        return { apiKey, source: 'llm-credential', authConfig };
      }
    }
  } catch (error) {
    logger.warn('Failed to query LLMCredential for embedding', {
      tenantId,
      provider,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  // ─── 3. Auth Profile ────────────────────────────────────────────────────
  try {
    const profileResult = await resolveEmbeddingAuthProfile(provider, tenantId);
    if (profileResult) {
      return { apiKey: profileResult.apiKey, source: 'auth-profile' };
    }
  } catch (error) {
    logger.warn('Auth profile embedding resolution failed', {
      tenantId,
      provider,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  // ─── 4. Environment variable (dev/testing fallback only) ────────────────
  const envVar = ENV_VAR_MAP[provider];
  if (envVar) {
    const apiKey = process.env[envVar];
    if (apiKey) {
      logger.debug('Embedding credential resolved from env var', {
        tenantId,
        provider,
        envVar,
      });
      return { apiKey, source: 'env-var' };
    }
  }

  // ─── 5. Not found ──────────────────────────────────────────────────────
  logger.warn('No embedding credentials found', { tenantId, provider });
  return { apiKey: '', source: 'none' };
}

/**
 * Check if embedding credentials are available for a provider and tenant.
 *
 * Uses the same unified resolution chain — no special-casing.
 * Returns true for providers that don't need credentials (bge-m3, custom).
 */
export async function hasEmbeddingCredentials(
  provider: string,
  tenantId: string,
): Promise<boolean> {
  if (!embeddingProviderRequiresCredentials(provider)) {
    return true;
  }

  const result = await resolveEmbeddingCredentials(provider, tenantId);
  return result.apiKey.length > 0;
}
