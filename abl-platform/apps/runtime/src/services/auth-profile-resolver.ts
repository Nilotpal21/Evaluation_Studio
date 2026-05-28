/**
 * Auth Profile Resolver (Runtime)
 *
 * Lightweight helper for resolving credentials from an AuthProfile record.
 * Used by all consumers that need dual-read (auth profile + legacy fallback).
 *
 * Pattern: query AuthProfile by _id + tenantId, extract secrets.
 * During key rotation, falls back to previousEncryptedSecrets via grace period.
 * Reusable across all 12+ consumers being wired for auth profile dual-read.
 */

import { createLogger } from '@abl/compiler/platform';
import {
  AuthProfileError,
  resolveWithGracePeriod,
  validateResolvedOAuth2TokenLinkedApp,
} from '@agent-platform/shared/services/auth-profile';
import type { IAuthProfile } from '@agent-platform/database/models';
import {
  AuthProfileCache,
  computeScopeHash,
  type CK1KeyParts,
} from './auth-profile/auth-profile-cache.js';

const log = createLogger('auth-profile-resolver');
const authProfileCache = new AuthProfileCache();

const LAST_USED_DEBOUNCE_MS = 5 * 60 * 1000;

export interface AuthProfileCredentials {
  profileId: string;
  name?: string;
  authType: string;
  /**
   * Monotonic version (Phase 0.4 field). Required by downstream caches that
   * adopt the CK-1 key shape — `oauth2_client_credentials` token cache,
   * MCP CC cache. Falls back to 1 for legacy rows that predate the backfill.
   */
  profileVersion: number;
  projectId?: string | null;
  environment?: string | null;
  visibility?: string;
  createdBy?: string;
  linkedAppProfileId?: string;
  /** 'shared' | 'per_user' — surfaced for FR-9 workflow-context rejection. */
  connectionMode?: 'shared' | 'per_user';
  /** 'preconfigured' | 'user_token' | 'jit' | 'preflight' — surfaced for FR-9 workflow-context rejection. */
  usageMode?: 'preconfigured' | 'user_token' | 'jit' | 'preflight';
  config: Record<string, unknown>;
  secrets: Record<string, unknown>;
}

export interface AuthProfileLookupMetadata {
  profileId: string;
  name?: string;
  authType: string;
  projectId?: string | null;
  environment?: string | null;
  visibility?: string;
  createdBy?: string;
}

interface AuthProfileLookupScope {
  projectId?: string;
  environment?: string;
  userId?: string;
}

type AuthProfileDocument = Pick<
  IAuthProfile,
  | '_id'
  | 'name'
  | 'tenantId'
  | 'projectId'
  | 'environment'
  | 'visibility'
  | 'createdBy'
  | 'scope'
  | 'authType'
  | 'config'
  | 'encryptedSecrets'
  | 'linkedAppProfileId'
  | 'previousEncryptedSecrets'
  | 'rotationGracePeriodMs'
  | 'updatedAt'
  | 'expiresAt'
  | 'lastUsedAt'
  | 'connectionMode'
  | 'usageMode'
> & { profileVersion?: number };

export function getAuthProfileCache(): AuthProfileCache {
  return authProfileCache;
}

function extractScopesFromConfig(config: Record<string, unknown> | undefined): string[] {
  if (!config) return [];
  const raw =
    (config as { scopes?: unknown; scope?: unknown }).scopes ??
    (config as { scopes?: unknown; scope?: unknown }).scope;
  if (Array.isArray(raw)) return raw.filter((s): s is string => typeof s === 'string');
  if (typeof raw === 'string') {
    return raw
      .split(/[\s,]+/)
      .map((s) => s.trim())
      .filter(Boolean);
  }
  return [];
}

function buildCk1KeyParts(profile: AuthProfileDocument, tenantId: string): CK1KeyParts {
  const scopes = extractScopesFromConfig(profile.config as Record<string, unknown> | undefined);
  return {
    tenantId,
    authType: profile.authType ?? 'api_key',
    profileId: String(profile._id),
    profileVersion: profile.profileVersion ?? 1,
    scopeHash: scopes.length > 0 ? computeScopeHash(scopes) : '',
  };
}

/**
 * Resolve credentials from an AuthProfile record by ID.
 *
 * Contract:
 * - Not found / inactive / expired: returns null (with warn log)
 * - System error (DB failure, decryption failure): throws (propagated to caller)
 *
 * During key rotation, the Mongoose plugin decrypts encryptedSecrets using
 * decryptForTenantWithFallback (tries current key, then previous keys).
 * If that still fails, resolveWithGracePeriod falls back to previousEncryptedSecrets
 * within the configured grace window.
 */
export async function resolveAuthProfileCredentials(
  authProfileId: string,
  tenantId: string,
): Promise<AuthProfileCredentials | null> {
  const { AuthProfile } = await import('@agent-platform/database/models');
  const now = new Date();
  const profile = (await (AuthProfile as any).findOne({
    _id: authProfileId,
    tenantId,
    status: 'active',
    enabled: { $ne: false },
    $or: [{ expiresAt: null }, { expiresAt: { $gt: now } }],
  })) as AuthProfileDocument | null;

  if (!profile) {
    log.warn('Auth profile not found, inactive, or disabled', { authProfileId, tenantId });
    return null;
  }

  // Revalidate linked OAuth apps before using cache so legacy oauth2_token
  // records fail closed when callers still resolve them explicitly by id.
  if (!(await isResolvableOAuth2TokenProfile(profile))) {
    return null;
  }

  const ck1 = buildCk1KeyParts(profile, tenantId);
  const validation = {
    updatedAt: profile.updatedAt,
    expiresAt: profile.expiresAt ?? null,
  };
  const cached = authProfileCache.get(ck1, validation);
  if (cached) {
    await updateLastUsedAtIfNeeded(profile);
    return cached;
  }

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

  // The Mongoose plugin has already decrypted encryptedSecrets and previousEncryptedSecrets.
  // resolveWithGracePeriod handles JSON.parse with grace period fallback:
  //   1. Try JSON.parse(encryptedSecrets) — the primary (already decrypted by plugin)
  //   2. If that fails AND previousEncryptedSecrets exists AND within grace window,
  //      try JSON.parse(previousEncryptedSecrets)
  const resolved = await buildResolvedCredentials(profile);
  authProfileCache.set(ck1, resolved, undefined, validation);
  return resolved;
}

/**
 * FR-10 canonical projectId filter: a single `$or` covering project-scoped
 * + workspace-null + legacy missing-field rows. Workspace fallback semantics
 * are encoded once in the query — JS-side shadowing then prefers a project
 * row over a workspace row of the same name.
 */
function buildProjectIdFilter(projectId?: string): Record<string, unknown> {
  if (projectId) {
    return {
      $or: [{ projectId }, { projectId: null }, { projectId: { $exists: false } }],
    };
  }
  return {
    $or: [{ projectId: null }, { projectId: { $exists: false } }],
  };
}

function getEnvVisibilityCandidates(params: { environment?: string; userId?: string }): Array<{
  environmentFilter: Record<string, unknown>;
  visibilityFilter: Record<string, unknown>;
}> {
  const environmentFilters = params.environment
    ? [
        { environment: params.environment },
        { environment: null },
        { environment: { $exists: false } },
      ]
    : [{ environment: null }, { environment: { $exists: false } }];
  const visibilityFilters = params.userId
    ? [{ visibility: 'personal', createdBy: params.userId }, { visibility: 'shared' }]
    : [{ visibility: 'shared' }];

  const candidates: Array<{
    environmentFilter: Record<string, unknown>;
    visibilityFilter: Record<string, unknown>;
  }> = [];

  for (const environmentFilter of environmentFilters) {
    for (const visibilityFilter of visibilityFilters) {
      candidates.push({ environmentFilter, visibilityFilter });
    }
  }

  return candidates;
}

function getScopedLookupCandidates(params: AuthProfileLookupScope): Array<{
  scopeFilter: Record<string, unknown>;
  environmentFilter: Record<string, unknown>;
  visibilityFilter: Record<string, unknown>;
}> {
  const scopeFilters = params.projectId
    ? [{ projectId: params.projectId }, { projectId: null }, { projectId: { $exists: false } }]
    : [{ projectId: null }, { projectId: { $exists: false } }];
  const envVisibilityCandidates = getEnvVisibilityCandidates({
    environment: params.environment,
    userId: params.userId,
  });

  const candidates: Array<{
    scopeFilter: Record<string, unknown>;
    environmentFilter: Record<string, unknown>;
    visibilityFilter: Record<string, unknown>;
  }> = [];

  for (const scopeFilter of scopeFilters) {
    for (const { environmentFilter, visibilityFilter } of envVisibilityCandidates) {
      candidates.push({ scopeFilter, environmentFilter, visibilityFilter });
    }
  }

  return candidates;
}

/**
 * FR-10 shadow precedence: when both a project-scoped and a workspace-null
 * row match the same (name, env, visibility), the project row wins.
 */
function pickShadowedProfile(
  profiles: AuthProfileDocument[],
  projectId?: string,
): AuthProfileDocument | null {
  if (profiles.length === 0) return null;
  if (projectId) {
    const projectMatch = profiles.find((p) => p.projectId === projectId);
    if (projectMatch) return projectMatch;
  }
  const workspaceMatch = profiles.find((p) => p.projectId == null);
  return workspaceMatch ?? profiles[0];
}

function buildActiveProfileFilter(now: Date): Record<string, unknown> {
  return {
    status: 'active',
    enabled: { $ne: false },
    $or: [{ expiresAt: null }, { expiresAt: { $gt: now } }],
  };
}

async function findScopedAuthProfileByName(params: {
  name: string;
  tenantId: string;
  environment?: string;
  projectId?: string;
  userId?: string;
}): Promise<AuthProfileDocument | null> {
  const { AuthProfile } = await import('@agent-platform/database/models');
  const now = new Date();
  const candidates = getScopedLookupCandidates({
    projectId: params.projectId,
    environment: params.environment,
    userId: params.userId,
  });

  for (const { scopeFilter, environmentFilter, visibilityFilter } of candidates) {
    const query = (AuthProfile as any).findOne({
      name: params.name,
      tenantId: params.tenantId,
      ...buildActiveProfileFilter(now),
      ...scopeFilter,
      ...environmentFilter,
      ...visibilityFilter,
    });
    const profile = (
      typeof query?.lean === 'function' ? await query.lean() : await query
    ) as AuthProfileDocument | null;

    if (!profile) {
      continue;
    }

    if (profile.authType === 'oauth2_token') {
      log.info('Skipping legacy oauth2_token profile during name resolution', {
        profileId: profile._id,
        name: params.name,
        tenantId: params.tenantId,
      });
      continue;
    }

    return profile;
  }

  return null;
}

export async function findAuthProfileMetadataByName(
  name: string,
  tenantId: string,
  environment?: string,
  projectId?: string,
  userId?: string,
): Promise<AuthProfileLookupMetadata | null> {
  const profile = await findScopedAuthProfileByName({
    name,
    tenantId,
    environment,
    projectId,
    userId,
  });

  if (!profile) {
    log.warn('Auth profile not found by name', { name, tenantId, environment, projectId, userId });
    return null;
  }

  return {
    profileId: String(profile._id),
    name: profile.name,
    authType: profile.authType ?? 'api_key',
    projectId: profile.projectId ?? null,
    environment: profile.environment ?? null,
    visibility: profile.visibility,
    createdBy: profile.createdBy,
  };
}

async function updateLastUsedAtIfNeeded(profile: AuthProfileDocument): Promise<void> {
  if (!profile.lastUsedAt || Date.now() - profile.lastUsedAt.getTime() > LAST_USED_DEBOUNCE_MS) {
    const { AuthProfile } = await import('@agent-platform/database/models');
    (AuthProfile as any)
      .updateOne(
        { _id: profile._id, tenantId: profile.tenantId },
        { $set: { lastUsedAt: new Date() } },
      )
      .catch((err: unknown) => {
        log.warn('Failed to update auth profile lastUsedAt', {
          profileId: profile._id,
          error: err instanceof Error ? err.message : String(err),
        });
      });
  }
}

async function buildResolvedCredentials(
  profile: AuthProfileDocument,
): Promise<AuthProfileCredentials> {
  const secrets = await resolveWithGracePeriod(
    {
      encryptedSecrets: profile.encryptedSecrets ?? '',
      previousEncryptedSecrets: profile.previousEncryptedSecrets,
      rotationGracePeriodMs: profile.rotationGracePeriodMs,
      updatedAt: profile.updatedAt,
    },
    async (value: string) => value,
  );

  return {
    profileId: String(profile._id),
    name: profile.name,
    authType: profile.authType ?? 'api_key',
    profileVersion: profile.profileVersion ?? 1,
    projectId: profile.projectId ?? null,
    environment: profile.environment ?? null,
    visibility: profile.visibility,
    createdBy: profile.createdBy,
    linkedAppProfileId: profile.linkedAppProfileId,
    connectionMode: profile.connectionMode,
    usageMode: profile.usageMode,
    config: profile.config ?? {},
    secrets,
  };
}

async function isResolvableOAuth2TokenProfile(profile: AuthProfileDocument): Promise<boolean> {
  if (profile.authType !== 'oauth2_token') {
    return true;
  }

  try {
    await validateResolvedOAuth2TokenLinkedApp({
      profileId: String(profile._id),
      tenantId: profile.tenantId,
      linkedAppProfileId: profile.linkedAppProfileId,
      scope: profile.scope,
      visibility: profile.visibility,
      projectId: profile.projectId ?? null,
      createdBy: profile.createdBy,
    });
    return true;
  } catch (err) {
    if (err instanceof AuthProfileError) {
      log.warn('OAuth token profile linked app is no longer valid', {
        profileId: profile._id,
        linkedAppProfileId: profile.linkedAppProfileId,
        error: err.message,
      });
      return false;
    }

    throw err;
  }
}

/**
 * Resolve credentials from an AuthProfile record by name.
 *
 * Lookup order:
 * 1. Exact match on (name, tenantId, status: active, environment)
 * 2. Fallback to environment: null (default/shared profile)
 * Returns null if no match found.
 */
export async function resolveByName(
  name: string,
  tenantId: string,
  environment?: string,
  projectId?: string,
  userId?: string,
): Promise<AuthProfileCredentials | null> {
  const { AuthProfile } = await import('@agent-platform/database/models');
  const now = new Date();
  const projectIdFilter = buildProjectIdFilter(projectId);
  const candidates = getEnvVisibilityCandidates({ environment, userId });

  for (const { environmentFilter, visibilityFilter } of candidates) {
    // FR-10: single query per (env, visibility) cell using `$or` for projectId.
    // The two `$or` clauses (active-window + projectId scope) compose under `$and`.
    const filter: Record<string, unknown> = {
      name,
      tenantId,
      status: 'active',
      $and: [{ $or: [{ expiresAt: null }, { expiresAt: { $gt: now } }] }, projectIdFilter],
      ...environmentFilter,
      ...visibilityFilter,
    };
    const cursor = (AuthProfile as any).find(filter);
    const profiles = (await (typeof cursor?.limit === 'function' ? cursor.limit(2) : cursor)) as
      | AuthProfileDocument[]
      | null;
    const profile = pickShadowedProfile(profiles ?? [], projectId);

    if (!profile) {
      continue;
    }

    if (profile.authType === 'oauth2_token') {
      log.info('Skipping legacy oauth2_token profile during name resolution', {
        profileId: profile._id,
        name,
        tenantId,
      });
      continue;
    }

    if (!(await isResolvableOAuth2TokenProfile(profile))) {
      continue;
    }

    const ck1 = buildCk1KeyParts(profile, tenantId);
    const cacheValidation = {
      updatedAt: profile.updatedAt,
      expiresAt: profile.expiresAt ?? null,
    };
    const cached = authProfileCache.get(ck1, cacheValidation);
    if (cached) {
      await updateLastUsedAtIfNeeded(profile);
      return cached;
    }

    await updateLastUsedAtIfNeeded(profile);
    const resolved = await buildResolvedCredentials(profile);
    authProfileCache.set(ck1, resolved, undefined, cacheValidation);
    return resolved;
  }

  log.warn('Auth profile not found by name', { name, tenantId, environment, projectId, userId });
  return null;
}
