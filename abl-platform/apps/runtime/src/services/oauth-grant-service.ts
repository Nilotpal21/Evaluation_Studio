import { createLogger } from '@abl/compiler/platform';
import type { NormalizedEndUserOAuthToken } from '@agent-platform/shared';
import { findEndUserOAuthTokens } from '@agent-platform/shared/repos';
import {
  AUTH_PROFILE_OAUTH_PROVIDER_PREFIX,
  buildAuthProfileOAuthProviderKey,
  parseAuthProfileOAuthProviderKey,
} from '@agent-platform/shared/services/auth-profile';
import type { IAuthProfile } from '@agent-platform/database/models';
import { resolveByName, type AuthProfileCredentials } from './auth-profile-resolver.js';
import { getToolOAuthService } from './tool-oauth-service-singleton.js';

const log = createLogger('oauth-grant-service');

const LEGACY_TOKEN_PROVIDER_PREFIX = 'oauth2-token:';

interface LegacyOAuthTokenProfileDocument extends Pick<
  IAuthProfile,
  | '_id'
  | 'name'
  | 'tenantId'
  | 'authType'
  | 'config'
  | 'status'
  | 'visibility'
  | 'createdBy'
  | 'linkedAppProfileId'
  | 'createdAt'
  | 'updatedAt'
> {}

interface AuthProfileMetadata {
  id: string;
  name: string;
  status: string;
}

export interface ResolveOAuthGrantAccessTokenParams {
  tenantId: string;
  authProfileRef: string;
  projectId?: string;
  environment?: string;
  userId?: string;
  lookupScope: 'user' | 'tenant';
  authScope: 'session' | 'user' | 'tenant';
  scopes?: string[];
  resolvedProfile?: AuthProfileCredentials | null;
}

export interface ResolvedOAuthGrantAccessToken {
  accessToken: string;
  authType: 'oauth2_app';
  source: 'oauth_grant_store';
  profileId: string;
  profileName: string;
  provider: string;
}

export interface OAuthGrantTokenSummary {
  provider: string;
  expiresAt?: string;
  metadata?: Record<string, unknown>;
}

export interface ListOAuthGrantTokensResult {
  tokens: OAuthGrantTokenSummary[];
  total: number;
}

interface OAuthGrantTokenSummaryWithSort extends OAuthGrantTokenSummary {
  priority: 0 | 1;
  sortTimestamp: number;
}

function normalizeScopes(scopes?: string[]): string[] {
  if (!Array.isArray(scopes)) {
    return [];
  }

  return Array.from(
    new Set(
      scopes
        .filter((scope): scope is string => typeof scope === 'string')
        .map((scope) => scope.trim())
        .filter((scope) => scope.length > 0),
    ),
  );
}

function toIsoString(value: unknown): string | undefined {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return value.toISOString();
  }

  if (typeof value !== 'string' || value.trim().length === 0) {
    return undefined;
  }

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return undefined;
  }

  return parsed.toISOString();
}

function toTimestamp(value: unknown): number {
  const isoValue = toIsoString(value);
  if (!isoValue) {
    return 0;
  }

  return new Date(isoValue).getTime();
}

function buildLegacyTokenFallbackProvider(profileId: string): string {
  return `${LEGACY_TOKEN_PROVIDER_PREFIX}${profileId}`;
}

export function buildActiveAuthProfileOAuthGrantFilter(params: {
  tenantId: string;
  profileId: string;
}): Record<string, unknown> {
  return {
    tenantId: params.tenantId,
    provider: buildAuthProfileOAuthProviderKey(params.profileId),
    revokedAt: null,
  };
}

/**
 * Outcomes of a grant-store diagnosis. Used by `resolveToolAuth` to decide
 * which specific error to throw when token resolution fails — distinguishing
 * "never authorized" from "authorized but token expired with no refresh
 * token" from "refresh attempted and failed".
 */
export type GrantStoreDiagnosis =
  | 'no_grant'
  | 'expired_no_refresh_token'
  | 'expired_with_refresh_token'
  | 'has_active_grant';

const REFRESH_BUFFER_MS = 60_000;

/**
 * Diagnose the state of a grant-store entry for a profile + principal pair.
 * Used after a failed `resolveOAuthGrantAccessToken` call to decide which
 * specific user-facing error to surface.
 *
 * Returns `'has_active_grant'` if a usable grant exists (callers should rarely
 * see this since they only diagnose on failure — but it's possible if the
 * grant became valid between the failed token resolve and this diagnosis,
 * e.g. an OAuth callback racing with a workflow run).
 */
export async function diagnoseGrantStoreState(params: {
  tenantId: string;
  profileId: string;
  principalId: string;
}): Promise<GrantStoreDiagnosis> {
  const { EndUserOAuthToken } = await import('@agent-platform/database/models');
  const grant = await (
    EndUserOAuthToken as unknown as {
      findOne(filter: Record<string, unknown>): {
        select(fields: string): { lean(): Promise<unknown> };
      };
    }
  )
    .findOne({
      tenantId: params.tenantId,
      provider: buildAuthProfileOAuthProviderKey(params.profileId),
      userId: params.principalId,
      revokedAt: null,
    })
    .select('encryptedAccessToken encryptedRefreshToken expiresAt')
    .lean();

  if (!grant || typeof grant !== 'object') return 'no_grant';
  const g = grant as {
    encryptedAccessToken?: unknown;
    encryptedRefreshToken?: unknown;
    expiresAt?: Date | string | null;
  };

  if (typeof g.encryptedAccessToken !== 'string' || g.encryptedAccessToken.trim().length === 0) {
    return 'no_grant';
  }

  const expiresAtMs =
    g.expiresAt instanceof Date
      ? g.expiresAt.getTime()
      : typeof g.expiresAt === 'string'
        ? new Date(g.expiresAt).getTime()
        : NaN;
  const isExpired = Number.isFinite(expiresAtMs) && expiresAtMs < Date.now() + REFRESH_BUFFER_MS;

  if (!isExpired) return 'has_active_grant';

  const hasRefreshToken =
    typeof g.encryptedRefreshToken === 'string' && g.encryptedRefreshToken.trim().length > 0;

  return hasRefreshToken ? 'expired_with_refresh_token' : 'expired_no_refresh_token';
}

async function resolveGrantStoreAccessToken(
  params: ResolveOAuthGrantAccessTokenParams,
  profile: AuthProfileCredentials,
): Promise<ResolvedOAuthGrantAccessToken | null> {
  const oauthService = getToolOAuthService();
  if (!oauthService) {
    return null;
  }

  if (params.lookupScope === 'user' && !params.userId) {
    return null;
  }

  const grantPrincipalId = params.lookupScope === 'tenant' ? '__tenant__' : params.userId!;

  const providerRef = params.authProfileRef;
  const preferAuthProfile = !providerRef.startsWith(AUTH_PROFILE_OAUTH_PROVIDER_PREFIX);

  const accessToken = await oauthService.getAccessToken(
    params.tenantId,
    grantPrincipalId,
    providerRef,
    {
      projectId: params.projectId,
      environment: params.environment,
      scopes: params.scopes,
      lookupScope: params.lookupScope,
      preferAuthProfile,
      authScope: params.authScope,
    },
  );

  if (!accessToken) {
    return null;
  }

  return {
    accessToken,
    authType: 'oauth2_app',
    source: 'oauth_grant_store',
    profileId: profile.profileId,
    profileName: profile.name ?? params.authProfileRef,
    provider: buildAuthProfileOAuthProviderKey(profile.profileId),
  };
}

export async function resolveOAuthGrantAccessToken(
  params: ResolveOAuthGrantAccessTokenParams,
): Promise<ResolvedOAuthGrantAccessToken | null> {
  const profile =
    params.resolvedProfile === undefined
      ? await resolveByName(
          params.authProfileRef,
          params.tenantId,
          params.environment,
          params.projectId,
          params.lookupScope === 'tenant' ? undefined : params.userId,
        )
      : params.resolvedProfile;

  if (!profile) {
    return null;
  }

  if (profile.authType !== 'oauth2_app') {
    log.info('Skipping legacy oauth2_token auth profile during OAuth grant resolution', {
      tenantId: params.tenantId,
      authProfileRef: params.authProfileRef,
      profileId: profile.profileId,
      authType: profile.authType,
    });
    return null;
  }

  return resolveGrantStoreAccessToken(params, profile);
}

export async function hasOAuthGrantAccessToken(
  params: ResolveOAuthGrantAccessTokenParams,
): Promise<boolean> {
  const resolved = await resolveOAuthGrantAccessToken(params);
  return !!resolved;
}

async function loadAuthProfileMetadata(
  tenantId: string,
  authProfileIds: string[],
): Promise<Map<string, AuthProfileMetadata>> {
  if (authProfileIds.length === 0) {
    return new Map<string, AuthProfileMetadata>();
  }

  const { AuthProfile } = await import('@agent-platform/database/models');
  const docs = (await (
    AuthProfile as {
      find(filter: Record<string, unknown>): {
        select(fields: Record<string, number>): {
          lean(): Promise<Array<Pick<IAuthProfile, '_id' | 'name' | 'status'>>>;
        };
      };
    }
  )
    .find({
      tenantId,
      _id: { $in: authProfileIds },
    })
    .select({ _id: 1, name: 1, status: 1 })
    .lean()) as Array<Pick<IAuthProfile, '_id' | 'name' | 'status'>>;

  return new Map(
    docs.map((doc) => [
      String(doc._id),
      {
        id: String(doc._id),
        name: doc.name,
        status: doc.status,
      },
    ]),
  );
}

function choosePreferredSummary(
  current: OAuthGrantTokenSummaryWithSort | undefined,
  next: OAuthGrantTokenSummaryWithSort,
): OAuthGrantTokenSummaryWithSort {
  if (!current) {
    return next;
  }

  if (next.priority < current.priority) {
    return next;
  }

  if (next.priority === current.priority && next.sortTimestamp > current.sortTimestamp) {
    return next;
  }

  return current;
}

function buildDurableGrantSummary(
  token: NormalizedEndUserOAuthToken,
  metadataById: Map<string, AuthProfileMetadata>,
): OAuthGrantTokenSummaryWithSort | null {
  const provider = typeof token.provider === 'string' ? token.provider : '';
  if (!provider) {
    return null;
  }

  const authProfileId = parseAuthProfileOAuthProviderKey(provider);
  const authProfileMeta = authProfileId ? metadataById.get(authProfileId) : undefined;

  return {
    provider,
    priority: 0,
    sortTimestamp: Math.max(
      toTimestamp(token.consentedAt),
      toTimestamp(token.updatedAt),
      toTimestamp(token.createdAt),
    ),
    ...(toIsoString(token.expiresAt) ? { expiresAt: toIsoString(token.expiresAt) } : {}),
    metadata: {
      source: 'oauth_grant_store',
      ...(authProfileId ? { authProfileId } : {}),
      ...(authProfileMeta ? { authProfileName: authProfileMeta.name } : {}),
      ...(authProfileMeta ? { authProfileStatus: authProfileMeta.status } : {}),
    },
  };
}

function buildLegacyGrantSummary(
  profile: LegacyOAuthTokenProfileDocument,
  metadataById: Map<string, AuthProfileMetadata>,
): OAuthGrantTokenSummaryWithSort {
  const provider =
    typeof profile.linkedAppProfileId === 'string' && profile.linkedAppProfileId.length > 0
      ? buildAuthProfileOAuthProviderKey(profile.linkedAppProfileId)
      : buildLegacyTokenFallbackProvider(String(profile._id));
  const authProfileMeta =
    typeof profile.linkedAppProfileId === 'string'
      ? metadataById.get(profile.linkedAppProfileId)
      : undefined;
  const expiresAt =
    profile.config && typeof profile.config.expiresAt === 'string'
      ? toIsoString(profile.config.expiresAt)
      : undefined;

  return {
    provider,
    priority: 1,
    sortTimestamp: Math.max(toTimestamp(profile.updatedAt), toTimestamp(profile.createdAt)),
    ...(expiresAt ? { expiresAt } : {}),
    metadata: {
      source: 'legacy_oauth2_token_profile',
      legacyProfileId: String(profile._id),
      legacyProfileName: profile.name,
      ...(profile.linkedAppProfileId ? { authProfileId: profile.linkedAppProfileId } : {}),
      ...(authProfileMeta ? { authProfileName: authProfileMeta.name } : {}),
      ...(authProfileMeta ? { authProfileStatus: authProfileMeta.status } : {}),
    },
  };
}

async function listLegacyOAuthTokenProfiles(params: {
  tenantId: string;
  userId: string;
}): Promise<LegacyOAuthTokenProfileDocument[]> {
  const { AuthProfile } = await import('@agent-platform/database/models');
  return (await (
    AuthProfile as {
      find(filter: Record<string, unknown>): {
        select(fields: Record<string, number>): {
          sort(sort: Record<string, 1 | -1>): {
            lean(): Promise<LegacyOAuthTokenProfileDocument[]>;
          };
        };
      };
    }
  )
    .find({
      tenantId: params.tenantId,
      authType: 'oauth2_token',
      createdBy: params.userId,
      status: 'active',
    })
    .select({
      _id: 1,
      name: 1,
      tenantId: 1,
      authType: 1,
      config: 1,
      status: 1,
      visibility: 1,
      createdBy: 1,
      linkedAppProfileId: 1,
      createdAt: 1,
      updatedAt: 1,
    })
    .sort({ updatedAt: -1, createdAt: -1 })
    .lean()) as LegacyOAuthTokenProfileDocument[];
}

export async function listOAuthGrantTokensForUser(params: {
  tenantId: string;
  userId: string;
  page: number;
  limit: number;
}): Promise<ListOAuthGrantTokensResult> {
  const [durableTokens, legacyProfiles] = await Promise.all([
    findEndUserOAuthTokens({ tenantId: params.tenantId, userId: params.userId }),
    listLegacyOAuthTokenProfiles({ tenantId: params.tenantId, userId: params.userId }),
  ]);

  const authProfileIds = Array.from(
    new Set(
      [
        ...durableTokens
          .map((token) =>
            typeof token.provider === 'string'
              ? parseAuthProfileOAuthProviderKey(token.provider)
              : null,
          )
          .filter((value): value is string => typeof value === 'string'),
        ...legacyProfiles
          .map((profile) =>
            typeof profile.linkedAppProfileId === 'string' ? profile.linkedAppProfileId : null,
          )
          .filter((value): value is string => typeof value === 'string'),
      ].filter((value): value is string => typeof value === 'string'),
    ),
  );
  const authProfileMetadata = await loadAuthProfileMetadata(params.tenantId, authProfileIds);

  const summaries = new Map<string, OAuthGrantTokenSummaryWithSort>();

  for (const token of durableTokens) {
    const summary = buildDurableGrantSummary(token, authProfileMetadata);
    if (!summary) {
      continue;
    }

    summaries.set(
      summary.provider,
      choosePreferredSummary(summaries.get(summary.provider), summary),
    );
  }

  for (const profile of legacyProfiles) {
    const summary = buildLegacyGrantSummary(profile, authProfileMetadata);
    summaries.set(
      summary.provider,
      choosePreferredSummary(summaries.get(summary.provider), summary),
    );
  }

  const ordered = Array.from(summaries.values())
    .sort((a, b) => b.sortTimestamp - a.sortTimestamp)
    .map(({ priority: _priority, sortTimestamp: _sortTimestamp, ...summary }) => summary);

  const skip = (params.page - 1) * params.limit;
  return {
    tokens: ordered.slice(skip, skip + params.limit),
    total: ordered.length,
  };
}

async function revokeDurableOAuthGrant(params: {
  tenantId: string;
  userId: string;
  provider: string;
}): Promise<void> {
  const oauthService = getToolOAuthService();
  if (oauthService) {
    await oauthService.revokeToken(params.tenantId, params.userId, params.provider);
    return;
  }

  const { EndUserOAuthToken } = await import('@agent-platform/database/models');
  await (
    EndUserOAuthToken as {
      updateMany(
        filter: Record<string, unknown>,
        update: Record<string, unknown>,
      ): Promise<unknown>;
    }
  ).updateMany(
    {
      tenantId: params.tenantId,
      userId: params.userId,
      provider: params.provider,
      revokedAt: null,
    },
    { $set: { revokedAt: new Date() } },
  );
}

export async function revokeOAuthGrantForUser(params: {
  tenantId: string;
  userId: string;
  provider: string;
}): Promise<void> {
  await revokeDurableOAuthGrant(params);
}
