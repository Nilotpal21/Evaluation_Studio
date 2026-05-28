/**
 * Auth Profile Resolver for Search-AI
 *
 * Provides auth profile credential resolution for the Search-AI service.
 * Used by tenant-model-adapter and embedding-credentials for dual-read
 * whenever auth profile data is configured.
 *
 * This module centralizes the auth profile integration so that all
 * Search-AI workers that resolve credentials through these adapters
 * automatically inherit the dual-read behavior.
 */

import { createLogger } from '@abl/compiler/platform';
import { resolveWithGracePeriod } from '@agent-platform/shared/services/auth-profile';

const log = createLogger('auth-profile-resolver');

export interface AuthProfileCredentialResult {
  apiKey: string;
}

export interface EmbeddingAuthProfileResult {
  apiKey: string;
  source: 'auth-profile';
}

/**
 * Resolve a credential via Auth Profile for a given authProfileId.
 *
 * Used by tenant-model-adapter when a TenantModel connection has authProfileId.
 * Queries the AuthProfile collection, decrypts secrets, and returns the API key.
 *
 * Contract:
 * - Not found / inactive / expired / no API key: returns null (with warn log)
 * - System error (DB failure, decryption failure): throws (propagated to caller)
 *
 * @param params.authProfileId - The auth profile ID to resolve
 * @param params.tenantId - The tenant ID for isolation
 * @returns The resolved credential with API key, or null if not found/inactive/empty
 */
export async function resolveAuthProfileCredential(params: {
  authProfileId: string;
  tenantId: string;
}): Promise<AuthProfileCredentialResult | null> {
  const { authProfileId, tenantId } = params;

  log.debug('Resolving auth profile credential', { authProfileId, tenantId });

  // Import dynamically to avoid circular dependency at module load
  const { AuthProfile } = await import('@agent-platform/database/models');

  const profile = await (AuthProfile as any).findOne({
    _id: authProfileId,
    tenantId,
    status: 'active',
    $or: [{ expiresAt: null }, { expiresAt: { $gt: new Date() } }],
  });

  if (!profile) {
    log.warn('Auth profile not found or inactive', { authProfileId, tenantId });
    return null;
  }

  // Fire-and-forget: update lastUsedAt (debounced — skip if updated within 5 minutes)
  const LAST_USED_DEBOUNCE_MS = 5 * 60 * 1000;
  if (!profile.lastUsedAt || Date.now() - profile.lastUsedAt.getTime() > LAST_USED_DEBOUNCE_MS) {
    (AuthProfile as any)
      .updateOne({ _id: profile._id, tenantId }, { $set: { lastUsedAt: new Date() } })
      .catch((err: unknown) => {
        log.warn('Failed to update auth profile lastUsedAt', {
          profileId: profile._id,
          error: err instanceof Error ? err.message : String(err),
        });
      });
  }

  // The Mongoose encryption plugin has already decrypted encryptedSecrets and
  // previousEncryptedSecrets. resolveWithGracePeriod handles JSON.parse with
  // grace period fallback during key rotation.
  const secrets = await resolveWithGracePeriod(
    {
      encryptedSecrets: String(profile.encryptedSecrets ?? ''),
      previousEncryptedSecrets: profile.previousEncryptedSecrets
        ? String(profile.previousEncryptedSecrets)
        : undefined,
      rotationGracePeriodMs: profile.rotationGracePeriodMs as number | undefined,
      updatedAt: profile.updatedAt as Date,
    },
    async (value: string) => value,
  );

  const apiKey = String(secrets?.apiKey ?? secrets?.accessToken ?? '');

  if (!apiKey) {
    log.warn('Auth profile has no API key or access token', { authProfileId, tenantId });
    return null;
  }

  log.debug('Auth profile credential resolved', { authProfileId, tenantId });
  return { apiKey };
}

/**
 * Resolve an auth profile by name and tenant.
 *
 * Used when a profile is referenced by name rather than ID. Applies the
 * canonical FR-10 tenant-scope filter — `{ tenantId, $or: [{ projectId },
 * { projectId: null }] }` when a `projectId` is supplied — and prefers
 * project-scoped profiles over workspace-fallback rows of the same name.
 * Supports optional environment-specific resolution with null-env fallback.
 *
 * @param name - The profile name to resolve
 * @param tenantId - The tenant ID for isolation
 * @param environment - Optional environment for env-specific profiles
 * @param projectId - Optional project scope; workspace-null rows shadow when absent
 * @returns The resolved credential with API key, or null if not found/inactive/empty
 */
export async function resolveByName(
  name: string,
  tenantId: string,
  environment?: string,
  projectId?: string,
): Promise<AuthProfileCredentialResult | null> {
  log.debug('Resolving auth profile by name', { name, tenantId, environment, projectId });

  const { AuthProfile } = await import('@agent-platform/database/models');

  const projectIdFilter = projectId
    ? {
        $or: [{ projectId }, { projectId: null }, { projectId: { $exists: false } }],
      }
    : { $or: [{ projectId: null }, { projectId: { $exists: false } }] };

  const buildFilter = (env: string | null) => ({
    name,
    tenantId,
    status: 'active',
    $and: [{ $or: [{ expiresAt: null }, { expiresAt: { $gt: new Date() } }] }, projectIdFilter],
    environment: env,
  });

  const pickShadowed = (rows: Record<string, unknown>[]): Record<string, unknown> | null => {
    if (rows.length === 0) return null;
    if (projectId) {
      const projectMatch = rows.find((p) => p.projectId === projectId);
      if (projectMatch) return projectMatch;
    }
    return rows.find((p) => p.projectId == null) ?? rows[0];
  };

  if (environment) {
    const envCursor = (AuthProfile as any).find(buildFilter(environment));
    const envRows = (await (typeof envCursor?.limit === 'function'
      ? envCursor.limit(2)
      : envCursor)) as Record<string, unknown>[] | null;
    const envProfile = pickShadowed(envRows ?? []);

    if (envProfile) {
      return extractApiKey(envProfile, name, tenantId);
    }

    log.debug('No env-specific profile, falling back to default', { name, tenantId, environment });
  }

  const cursor = (AuthProfile as any).find(buildFilter(null));
  const rows = (await (typeof cursor?.limit === 'function' ? cursor.limit(2) : cursor)) as
    | Record<string, unknown>[]
    | null;
  const profile = pickShadowed(rows ?? []);

  if (!profile) {
    log.warn('Auth profile not found by name', { name, tenantId, projectId });
    return null;
  }

  return extractApiKey(profile, name, tenantId);
}

/** Extract API key from a resolved profile's encryptedSecrets. */
async function extractApiKey(
  profile: Record<string, unknown>,
  name: string,
  tenantId: string,
): Promise<AuthProfileCredentialResult | null> {
  const secrets = await resolveWithGracePeriod(
    {
      encryptedSecrets: String(profile.encryptedSecrets ?? ''),
      previousEncryptedSecrets: profile.previousEncryptedSecrets
        ? String(profile.previousEncryptedSecrets)
        : undefined,
      rotationGracePeriodMs: profile.rotationGracePeriodMs as number | undefined,
      updatedAt: profile.updatedAt as Date,
    },
    async (value: string) => value,
  );

  const apiKey = String(secrets?.apiKey ?? secrets?.accessToken ?? '');
  if (!apiKey) {
    log.warn('Auth profile by name has no API key', { name, tenantId });
    return null;
  }

  // Fire-and-forget lastUsedAt update
  const LAST_USED_DEBOUNCE_MS = 5 * 60 * 1000;
  const lastUsedAt = profile.lastUsedAt as Date | null;
  if (!lastUsedAt || Date.now() - lastUsedAt.getTime() > LAST_USED_DEBOUNCE_MS) {
    import('@agent-platform/database/models').then(({ AuthProfile: AP }) => {
      (AP as any)
        .updateOne({ _id: profile._id, tenantId }, { $set: { lastUsedAt: new Date() } })
        .catch((err: unknown) => {
          log.warn('Failed to update auth profile lastUsedAt', {
            profileId: profile._id,
            error: err instanceof Error ? err.message : String(err),
          });
        });
    });
  }

  return { apiKey };
}

/**
 * Resolve embedding credentials via Auth Profile.
 *
 * Used by embedding-credentials whenever auth profile data is configured.
 * Looks for an auth profile associated with the provider for the tenant.
 *
 * @param provider - The embedding provider name (e.g., 'openai', 'cohere')
 * @param tenantId - The tenant ID
 * @returns The resolved credential or null if no matching profile found
 */
export async function resolveEmbeddingAuthProfile(
  provider: string,
  tenantId: string,
): Promise<EmbeddingAuthProfileResult | null> {
  log.debug('Resolving embedding auth profile', { provider, tenantId });

  try {
    const { AuthProfile } = await import('@agent-platform/database/models');

    // Find an active auth profile for this provider type
    const profile = await (AuthProfile as any).findOne({
      tenantId,
      'config.provider': provider,
      status: 'active',
      authType: { $in: ['api_key', 'bearer'] },
      $or: [{ expiresAt: null }, { expiresAt: { $gt: new Date() } }],
    });

    if (!profile) {
      log.debug('No embedding auth profile found', { provider, tenantId });
      return null;
    }

    // Fire-and-forget: update lastUsedAt (debounced — skip if updated within 5 minutes)
    const EMBED_LAST_USED_DEBOUNCE_MS = 5 * 60 * 1000;
    if (
      !profile.lastUsedAt ||
      Date.now() - profile.lastUsedAt.getTime() > EMBED_LAST_USED_DEBOUNCE_MS
    ) {
      (AuthProfile as any)
        .updateOne({ _id: profile._id, tenantId }, { $set: { lastUsedAt: new Date() } })
        .catch((err: unknown) => {
          log.warn('Failed to update auth profile lastUsedAt', {
            profileId: profile._id,
            error: err instanceof Error ? err.message : String(err),
          });
        });
    }

    const secrets = await resolveWithGracePeriod(
      {
        encryptedSecrets: String(profile.encryptedSecrets ?? ''),
        previousEncryptedSecrets: profile.previousEncryptedSecrets
          ? String(profile.previousEncryptedSecrets)
          : undefined,
        rotationGracePeriodMs: profile.rotationGracePeriodMs as number | undefined,
        updatedAt: profile.updatedAt as Date,
      },
      async (value: string) => value,
    );

    const apiKey = String(secrets?.apiKey ?? '');
    if (!apiKey) {
      log.warn('Embedding auth profile has no API key', {
        profileId: profile._id,
        provider,
        tenantId,
      });
      return null;
    }

    return { apiKey, source: 'auth-profile' };
  } catch (error) {
    log.warn('Failed to resolve embedding auth profile', {
      provider,
      tenantId,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}
