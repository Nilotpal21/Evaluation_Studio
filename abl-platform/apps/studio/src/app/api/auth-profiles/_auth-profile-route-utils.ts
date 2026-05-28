import { errorJson, ErrorCode } from '@/lib/api-response';
import { StudioPermission } from '@/lib/permissions';
import {
  buildAuthProfileOAuthProviderKey,
  getAuthProfileMigrationState,
} from '@agent-platform/shared/services/auth-profile';
import type { AuthProfileStatus, IAuthProfile } from '@agent-platform/database/models';
import crypto from 'node:crypto';

interface AuthProfileActor {
  id: string;
  permissions?: string[];
}

type OAuthAppIdentifier = { _id: string } | { name: string };

const OAUTH_ALLOWED_ORIGINS_ENV = 'STUDIO_OAUTH_ALLOWED_ORIGINS';
export const TENANT_SHARED_OAUTH_PRINCIPAL_ID = '__tenant__';

/**
 * Sentinel projectId historically used to route workspace-level bridge
 * ConnectorConnections through project-scoped helpers. ABLP-619 removed
 * the active call sites in favor of dedicated `/api/admin/...` endpoints,
 * but the constant is kept exported because external consumers (older
 * client bundles, integration tests) may still import it. Treat as
 * deprecated — new code should not reference it.
 *
 * @deprecated Use the dedicated `/api/admin/auth-profiles/...` endpoints.
 */
export const WORKSPACE_BRIDGE_PROJECT_ID = '_workspace';

function hasDecryptPermission(actor: AuthProfileActor): boolean {
  return actor.permissions?.includes(StudioPermission.AUTH_PROFILE_DECRYPT) === true;
}

export function isAuthProfileExpired(profile: Pick<IAuthProfile, 'expiresAt'>): boolean {
  if (!profile.expiresAt) {
    return false;
  }

  const expiresAt =
    profile.expiresAt instanceof Date ? profile.expiresAt : new Date(profile.expiresAt);
  return !Number.isNaN(expiresAt.getTime()) && expiresAt.getTime() <= Date.now();
}

export function canReadAuthProfile(profile: IAuthProfile, actor: AuthProfileActor): boolean {
  return (
    profile.visibility !== 'personal' ||
    profile.createdBy === actor.id ||
    hasDecryptPermission(actor)
  );
}

export function canWriteAuthProfile(profile: IAuthProfile, actor: AuthProfileActor): boolean {
  return (
    profile.visibility !== 'personal' ||
    profile.createdBy === actor.id ||
    hasDecryptPermission(actor)
  );
}

export function canUseAuthProfile(profile: IAuthProfile, actor: AuthProfileActor): boolean {
  return profile.visibility !== 'personal' || profile.createdBy === actor.id;
}

export function buildAuthProfileVisibilityFilter(userId: string): Record<string, unknown> {
  return {
    $or: [{ visibility: 'shared' }, { visibility: 'personal', createdBy: userId }],
  };
}

export function buildAuthProfileOAuthGrantFilter(profileId: string): Record<string, unknown> {
  return {
    provider: buildAuthProfileOAuthGrantProvider(profileId),
    revokedAt: null,
  };
}

export function buildAuthProfileOAuthGrantProvider(profileId: string): string {
  return buildAuthProfileOAuthProviderKey(profileId);
}

export function buildVisibleOAuthGrantUserFilter(userId: string): Record<string, unknown> {
  return {
    userId: {
      $in: [TENANT_SHARED_OAUTH_PRINCIPAL_ID, userId],
    },
  };
}

export function formatOAuthGrantConsumerName(grantUserId: string, currentUserId: string): string {
  if (grantUserId === TENANT_SHARED_OAUTH_PRINCIPAL_ID) {
    return 'Tenant OAuth grant';
  }

  if (grantUserId === currentUserId) {
    return 'Your OAuth grant';
  }

  return `OAuth grant for ${grantUserId}`;
}

export function ensureReadableAuthProfile(
  profile: IAuthProfile,
  actor: AuthProfileActor,
): ReturnType<typeof errorJson> | null {
  if (canReadAuthProfile(profile, actor)) {
    return null;
  }

  return errorJson('Auth profile not found', 404, ErrorCode.NOT_FOUND);
}

export function ensureWritableAuthProfile(
  profile: IAuthProfile,
  actor: AuthProfileActor,
): ReturnType<typeof errorJson> | null {
  if (canWriteAuthProfile(profile, actor)) {
    return null;
  }

  return errorJson('Auth profile not found', 404, ErrorCode.NOT_FOUND);
}

export function ensureMutableAuthProfile(
  profile: IAuthProfile,
  actor: AuthProfileActor,
): ReturnType<typeof errorJson> | null {
  const writeError = ensureWritableAuthProfile(profile, actor);
  if (writeError) {
    return writeError;
  }

  const migration = getAuthProfileMigrationState(profile);
  if (migration) {
    return errorJson(migration.message, 400, ErrorCode.VALIDATION_ERROR);
  }

  return null;
}

export function ensureUsableAuthProfile(
  profile: IAuthProfile,
  actor: AuthProfileActor,
): ReturnType<typeof errorJson> | null {
  if (canUseAuthProfile(profile, actor)) {
    return null;
  }

  return errorJson('Auth profile not found', 404, ErrorCode.NOT_FOUND);
}

export function ensureUsableOAuthAppProfile(
  profile: IAuthProfile,
  actor: AuthProfileActor,
  options: { allowRevoked?: boolean } = {},
): ReturnType<typeof errorJson> | null {
  if (profile.authType !== 'oauth2_app') {
    return errorJson(
      'linkedAppProfileId must reference an oauth2_app profile.',
      400,
      ErrorCode.VALIDATION_ERROR,
    );
  }

  if (!canUseAuthProfile(profile, actor)) {
    return errorJson('OAuth app profile not found', 404, ErrorCode.NOT_FOUND);
  }

  // `allowRevoked` is set only from the OAuth initiate routes so a user can
  // re-authorize a previously revoked profile. Runtime / user-consent paths
  // keep the strict gate so revoked profiles cannot be silently used.
  const allowedStatuses: AuthProfileStatus[] = options.allowRevoked
    ? ['active', 'pending_authorization', 'revoked']
    : ['active', 'pending_authorization'];
  if (!allowedStatuses.includes(profile.status)) {
    return errorJson(
      'OAuth app profile must be active before it can be used.',
      400,
      ErrorCode.VALIDATION_ERROR,
    );
  }

  if (isAuthProfileExpired(profile)) {
    return errorJson(
      'OAuth app profile has expired and must be renewed before use.',
      400,
      ErrorCode.VALIDATION_ERROR,
    );
  }

  return null;
}

export function parseAuthProfileSecrets(
  profile: Pick<IAuthProfile, 'encryptedSecrets'>,
): Record<string, unknown> {
  if (!profile.encryptedSecrets) {
    return {};
  }

  if (typeof profile.encryptedSecrets !== 'string') {
    return profile.encryptedSecrets as unknown as Record<string, unknown>;
  }

  return JSON.parse(profile.encryptedSecrets) as Record<string, unknown>;
}

function buildAllowedOAuthStatuses(allowRevoked?: boolean): AuthProfileStatus[] {
  return allowRevoked
    ? ['active', 'pending_authorization', 'revoked']
    : ['active', 'pending_authorization'];
}

export function buildProjectOAuthAppLookupFilter(params: {
  tenantId: string;
  projectId: string;
  userId: string;
  identifier: OAuthAppIdentifier;
  /** Set to true from the OAuth initiate routes so revoked profiles can be re-authorized. */
  allowRevoked?: boolean;
}): Record<string, unknown> {
  return {
    ...params.identifier,
    tenantId: params.tenantId,
    authType: 'oauth2_app',
    status: { $in: buildAllowedOAuthStatuses(params.allowRevoked) },
    $or: [
      { projectId: params.projectId, visibility: 'shared' },
      {
        projectId: params.projectId,
        visibility: 'personal',
        createdBy: params.userId,
      },
      {
        projectId: null,
        scope: 'tenant',
        visibility: 'shared',
      },
      {
        projectId: null,
        scope: 'tenant',
        visibility: 'personal',
        createdBy: params.userId,
      },
    ],
  };
}

export function buildTenantOAuthAppLookupFilter(params: {
  tenantId: string;
  userId: string;
  identifier: OAuthAppIdentifier;
  /** Set to true from the OAuth initiate routes so revoked profiles can be re-authorized. */
  allowRevoked?: boolean;
}): Record<string, unknown> {
  return {
    ...params.identifier,
    tenantId: params.tenantId,
    projectId: null,
    scope: 'tenant',
    authType: 'oauth2_app',
    status: { $in: buildAllowedOAuthStatuses(params.allowRevoked) },
    $or: [{ visibility: 'shared' }, { visibility: 'personal', createdBy: params.userId }],
  };
}

/** Map auth profile authType to ConnectorConnection authType enum */
export function mapAuthTypeForBridge(
  authType: string,
): 'oauth2' | 'api_key' | 'bearer' | 'custom' | 'none' {
  if (authType.startsWith('oauth2')) return 'oauth2';
  if (authType === 'api_key') return 'api_key';
  if (authType === 'bearer') return 'bearer';
  return 'custom';
}

/**
 * Standard OAuth parameters that MUST NOT be overwritten by authorizationParams.
 * Defense-in-depth: even if code is reordered, these params are always protected.
 */
export const OAUTH_RESERVED_PARAMS = new Set([
  'client_id',
  'redirect_uri',
  'response_type',
  'state',
  'code_challenge',
  'code_challenge_method',
  'scope',
]);

function normalizeOrigin(value: string | undefined): string | null {
  if (!value) {
    return null;
  }

  try {
    const parsed = new URL(value);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return null;
    }

    return parsed.origin !== 'null' ? parsed.origin : null;
  } catch {
    return null;
  }
}

function readAllowedOriginsFromEnv(): Set<string> {
  const allowed = new Set<string>();
  const configured = process.env[OAUTH_ALLOWED_ORIGINS_ENV];
  if (!configured) {
    return allowed;
  }

  for (const token of configured.split(',')) {
    const origin = normalizeOrigin(token.trim());
    if (origin) {
      allowed.add(origin);
    }
  }

  return allowed;
}

export function resolveOAuthCallbackOrigin(request: Request): string | null {
  const canonicalOrigin = normalizeOrigin(process.env.NEXT_PUBLIC_APP_URL);
  const requestOrigin = normalizeOrigin(new URL(request.url).origin);
  const allowedOrigins = readAllowedOriginsFromEnv();
  if (allowedOrigins.size > 0) {
    if (requestOrigin) {
      return allowedOrigins.has(requestOrigin) ? requestOrigin : null;
    }
    if (canonicalOrigin && allowedOrigins.has(canonicalOrigin)) {
      return canonicalOrigin;
    }
    return null;
  }

  // In local development we prefer the active request origin so OAuth popup
  // completion remains same-origin even when developers switch between
  // localhost, 127.0.0.1, or LAN hostnames.
  if (process.env.NODE_ENV === 'development' && requestOrigin) {
    return requestOrigin;
  }

  if (canonicalOrigin) {
    return canonicalOrigin;
  }

  if (!requestOrigin) {
    return null;
  }

  if (process.env.NODE_ENV !== 'production') {
    return requestOrigin;
  }

  return null;
}

/**
 * Build PKCE challenge parameters from profile config.
 * Returns empty object if PKCE is not required.
 */
export function buildPkceChallenge(config: Record<string, unknown>): {
  codeVerifier?: string;
  codeChallenge?: string;
  codeChallengeMethod?: 'S256' | 'plain';
} {
  if (config.pkceRequired !== true) {
    return {};
  }

  const codeChallengeMethod = config.pkceMethod === 'plain' ? 'plain' : 'S256';
  const codeVerifier = crypto.randomBytes(32).toString('base64url');
  const codeChallenge =
    codeChallengeMethod === 'plain'
      ? codeVerifier
      : crypto.createHash('sha256').update(codeVerifier).digest('base64url');

  return { codeVerifier, codeChallenge, codeChallengeMethod };
}
