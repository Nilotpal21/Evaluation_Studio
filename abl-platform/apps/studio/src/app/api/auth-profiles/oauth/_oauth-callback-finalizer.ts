import type { NextRequest } from 'next/server';
import { parseTokenResponse } from '@agent-platform/connectors/oauth/parse-token-response';
import { createLogger } from '@abl/compiler/platform/logger.js';
import { ensureDb } from '@/lib/ensure-db';
import {
  buildProjectOAuthAppLookupFilter,
  buildTenantOAuthAppLookupFilter,
  ensureUsableOAuthAppProfile,
  resolveOAuthCallbackOrigin,
} from '@/app/api/auth-profiles/_auth-profile-route-utils';
import {
  AUTH_PROFILE_OAUTH_CSRF_COOKIE,
  consumeOAuthState,
  verifyOAuthStateBindings,
  type OAuthStatePayload,
} from '@/app/api/auth-profiles/oauth/_oauth-state-service';
import { emitOAuthAuditEvent, mapIdpError } from '@/app/api/auth-profiles/oauth/_oauth-audit';
import {
  buildAuthProfileOAuthProviderKey,
  emitAuthProfileAuditEvent,
} from '@agent-platform/shared/services/auth-profile';
import { assertNotReservedPrincipal } from '@agent-platform/shared-auth-profile/reserved-principals';
import type { IAuthProfile, IEndUserOAuthToken } from '@agent-platform/database/models';

const TENANT_SHARED_OAUTH_PRINCIPAL_ID = '__tenant__';
const log = createLogger('auth-profile-oauth-callback-finalizer');

export interface OAuthGrantCallbackResult {
  id: string;
  authProfileId: string;
  authProfileRef?: string;
  provider: string;
  principalScope: 'user' | 'tenant';
  principalId: string;
  storage: 'oauth_grant_store';
  scope: string;
  expiresAt: string | null;
  refreshTokenStored: boolean;
}

export type OAuthCallbackFinalizationResult =
  | {
      success: true;
      status: 201;
      data: OAuthGrantCallbackResult;
      stateData: OAuthStatePayload;
    }
  | {
      success: false;
      status: number;
      code: string;
      message: string;
      stateData?: OAuthStatePayload;
    };

export interface FinalizeAuthProfileOAuthCallbackParams {
  request: NextRequest;
  code: string;
  state: string;
  expectedScope?: 'project' | 'workspace';
  requireCsrfCookie?: boolean;
  authenticatedContext?: {
    tenantId: string;
    userId: string;
    projectId: string | null;
    scope: 'project' | 'workspace';
  };
}

export interface AbandonAuthProfileOAuthCallbackParams {
  request: NextRequest;
  state: string;
  errorCode: string;
  message: string;
}

function failure(
  status: number,
  code: string,
  message: string,
  stateData?: OAuthStatePayload,
  diagnostics: Record<string, unknown> = {},
): OAuthCallbackFinalizationResult {
  log.warn('Auth profile OAuth callback finalization failed', {
    status,
    code,
    message,
    ...(stateData
      ? {
          tenantId: stateData.tenantId,
          userId: stateData.userId,
          projectId: stateData.projectId,
          authProfileId: stateData.authProfileId,
          callbackScope: stateData.scope,
          authProfileScope: stateData.authProfileScope,
          authProfileVisibility: stateData.authProfileVisibility,
          targetVisibility: stateData.targetVisibility,
          hasCodeVerifier: Boolean(stateData.codeVerifier),
          hasConnectionConfig: Boolean(
            stateData.connectionConfig && Object.keys(stateData.connectionConfig).length > 0,
          ),
        }
      : {}),
    ...diagnostics,
  });
  return { success: false, status, code, message, ...(stateData ? { stateData } : {}) };
}

function resolveAuthProfileScope(scope: IAuthProfile['scope'] | undefined): 'tenant' | 'project' {
  return scope === 'tenant' ? 'tenant' : 'project';
}

function resolveAuthProfileVisibility(
  visibility: IAuthProfile['visibility'] | undefined,
): 'shared' | 'personal' {
  return visibility === 'personal' ? 'personal' : 'shared';
}

function resolveConnectionTemplate(value: string, config: Record<string, string>): string {
  return value.replace(/\$\{connectionConfig\.(\w+)\}/g, (match, key) => config[key] ?? match);
}

async function upsertOAuthGrant(params: {
  EndUserOAuthToken: {
    findOne(filter: Record<string, unknown>): PromiseLike<
      | (IEndUserOAuthToken & {
          save: () => Promise<unknown>;
        })
      | null
    >;
    create(input: Record<string, unknown>): Promise<unknown>;
  };
  tenantId: string;
  projectId: string | null;
  profileId: string;
  principalId: string;
  provider: string;
  accessToken: string;
  refreshToken?: string | null;
  scope: string;
  expiresAt: Date | null;
}): Promise<void> {
  const now = new Date();
  const existing = await params.EndUserOAuthToken.findOne({
    tenantId: params.tenantId,
    projectId: params.projectId,
    userId: params.principalId,
    provider: params.provider,
  });

  if (existing) {
    existing.encryptedAccessToken = params.accessToken;
    existing.encryptedRefreshToken = params.refreshToken ?? null;
    existing.scope = params.scope;
    existing.expiresAt = params.expiresAt;
    existing.refreshedAt = now;
    existing.consentedAt = now;
    existing.revokedAt = null;
    existing.providerUserId = existing.providerUserId || params.principalId;
    await existing.save();
    return;
  }

  await params.EndUserOAuthToken.create({
    tenantId: params.tenantId,
    projectId: params.projectId,
    profileId: params.profileId,
    userId: params.principalId,
    provider: params.provider,
    providerUserId: params.principalId,
    encryptedAccessToken: params.accessToken,
    encryptedRefreshToken: params.refreshToken ?? null,
    scope: params.scope,
    expiresAt: params.expiresAt,
    refreshedAt: now,
    consentedAt: now,
    revokedAt: null,
    lastUsedAt: null,
  });
}

export async function finalizeAuthProfileOAuthCallback({
  request,
  code,
  state,
  expectedScope,
  requireCsrfCookie = true,
  authenticatedContext,
}: FinalizeAuthProfileOAuthCallbackParams): Promise<OAuthCallbackFinalizationResult> {
  await ensureDb();

  if (!/^[a-f0-9]{64}$/.test(state)) {
    if (authenticatedContext) {
      void emitOAuthAuditEvent({
        kind: 'failed',
        tenantId: authenticatedContext.tenantId,
        userId: authenticatedContext.userId,
        scope: authenticatedContext.scope,
        projectId: authenticatedContext.projectId,
        reason: 'state_format_invalid',
      });
    }
    return failure(400, 'VALIDATION_ERROR', 'Invalid state format');
  }

  const { getRedisClient } = await import('@/lib/redis-client');
  const redis = getRedisClient();
  if (!redis) {
    return failure(500, 'INTERNAL_ERROR', 'Redis unavailable');
  }

  const stateData = await consumeOAuthState(redis, state);
  if (!stateData) {
    if (authenticatedContext) {
      void emitOAuthAuditEvent({
        kind: 'failed',
        tenantId: authenticatedContext.tenantId,
        userId: authenticatedContext.userId,
        scope: authenticatedContext.scope,
        projectId: authenticatedContext.projectId,
        reason: 'state_replay_or_expired',
      });
    }
    return failure(400, 'INVALID_STATE', 'Invalid or expired OAuth state');
  }

  const scope = expectedScope ?? stateData.scope;
  const tenantId = authenticatedContext?.tenantId ?? stateData.tenantId;
  const userId = authenticatedContext?.userId ?? stateData.userId;
  const projectId = authenticatedContext?.projectId ?? stateData.projectId;

  const callbackOrigin = resolveOAuthCallbackOrigin(request);
  if (!callbackOrigin) {
    return failure(
      500,
      'INTERNAL_ERROR',
      'OAuth callback origin is not configured for this deployment',
      stateData,
    );
  }

  const csrfNonce = requireCsrfCookie
    ? request.cookies.get(AUTH_PROFILE_OAUTH_CSRF_COOKIE)?.value
    : stateData.csrfNonce;
  const bindingFailure = verifyOAuthStateBindings({
    state: stateData,
    tenantId,
    userId,
    scope,
    projectId,
    csrfNonce,
    redirectUri: `${callbackOrigin}/oauth/auth-profile-callback`,
  });

  if (bindingFailure) {
    void emitOAuthAuditEvent({
      kind: 'failed',
      tenantId,
      userId,
      profileId: stateData.authProfileId,
      scope,
      projectId,
      reason: bindingFailure.reason,
    });
    return failure(400, 'INVALID_STATE', bindingFailure.message, stateData);
  }

  if (scope === 'project' && !projectId) {
    void emitOAuthAuditEvent({
      kind: 'failed',
      tenantId,
      userId,
      profileId: stateData.authProfileId,
      scope,
      projectId,
      reason: 'project_binding_mismatch',
    });
    return failure(400, 'INVALID_STATE', 'OAuth state project mismatch', stateData);
  }

  const { AuthProfile, EndUserOAuthToken } = await import('@agent-platform/database/models');
  const appProfile =
    scope === 'project'
      ? await AuthProfile.findOne(
          buildProjectOAuthAppLookupFilter({
            tenantId,
            projectId: projectId as string,
            userId,
            identifier: { _id: stateData.authProfileId },
            allowRevoked: true,
          }),
        )
      : await AuthProfile.findOne(
          buildTenantOAuthAppLookupFilter({
            tenantId,
            userId,
            identifier: { _id: stateData.authProfileId },
            allowRevoked: true,
          }),
        );

  if (!appProfile) {
    void emitOAuthAuditEvent({
      kind: 'failed',
      tenantId,
      userId,
      profileId: stateData.authProfileId,
      scope,
      projectId,
      reason: 'app_profile_not_found',
    });
    return failure(404, 'NOT_FOUND', 'OAuth app profile not found', stateData);
  }

  const actor = { id: userId };
  const appProfileError = ensureUsableOAuthAppProfile(appProfile as IAuthProfile, actor, {
    allowRevoked: true,
  });
  if (appProfileError) {
    void emitOAuthAuditEvent({
      kind: 'failed',
      tenantId,
      userId,
      profileId: stateData.authProfileId,
      scope,
      projectId,
      reason: 'app_profile_unusable',
    });
    return failure(
      appProfileError.status,
      'VALIDATION_ERROR',
      'OAuth app profile must be active before it can be used.',
      stateData,
    );
  }

  const typedProfile = appProfile as IAuthProfile;
  const actualAppScope = resolveAuthProfileScope(typedProfile.scope);
  const actualAppVisibility = resolveAuthProfileVisibility(typedProfile.visibility);

  if (stateData.authProfileScope && stateData.authProfileScope !== actualAppScope) {
    void emitOAuthAuditEvent({
      kind: 'failed',
      tenantId,
      userId,
      profileId: stateData.authProfileId,
      scope,
      projectId,
      reason: 'app_profile_scope_changed',
    });
    return failure(
      400,
      'INVALID_STATE',
      'OAuth app profile changed during authorization. Restart authorization.',
      stateData,
      {
        expectedAuthProfileScope: stateData.authProfileScope,
        actualAuthProfileScope: actualAppScope,
      },
    );
  }

  if (stateData.authProfileVisibility && stateData.authProfileVisibility !== actualAppVisibility) {
    void emitOAuthAuditEvent({
      kind: 'failed',
      tenantId,
      userId,
      profileId: stateData.authProfileId,
      scope,
      projectId,
      reason: 'app_profile_visibility_changed',
    });
    return failure(
      400,
      'INVALID_STATE',
      'OAuth app profile changed during authorization. Restart authorization.',
      stateData,
      {
        expectedAuthProfileVisibility: stateData.authProfileVisibility,
        actualAuthProfileVisibility: actualAppVisibility,
      },
    );
  }

  const resolvedAppScope = actualAppScope;
  const resolvedAppVisibility = actualAppVisibility;
  const targetVisibility =
    stateData.targetVisibility ??
    (stateData.isUserConsent === true || resolvedAppVisibility === 'personal'
      ? 'personal'
      : 'shared');

  let secrets: Record<string, string>;
  try {
    secrets = JSON.parse(typedProfile.encryptedSecrets);
  } catch {
    return failure(500, 'INTERNAL_ERROR', 'Failed to decrypt OAuth app credentials', stateData);
  }

  const appConfig = typedProfile.config as Record<string, unknown>;
  const tokenParams =
    appConfig.tokenParams && typeof appConfig.tokenParams === 'object'
      ? (appConfig.tokenParams as Record<string, string>)
      : {};

  const tokenBody = new URLSearchParams({
    ...tokenParams,
    grant_type: 'authorization_code',
    code,
    client_id: secrets.clientId,
    client_secret: secrets.clientSecret,
    redirect_uri: stateData.redirectUri,
  });

  if (appConfig.pkceRequired === true && !stateData.codeVerifier) {
    return failure(400, 'INVALID_STATE', 'OAuth state missing PKCE verifier', stateData);
  }

  if (stateData.codeVerifier) {
    tokenBody.set('code_verifier', stateData.codeVerifier);
  }

  const storedConnectionConfig =
    typeof stateData.connectionConfig === 'object' && stateData.connectionConfig !== null
      ? stateData.connectionConfig
      : {};
  const tokenUrl = resolveConnectionTemplate(
    String(appConfig.tokenUrl ?? ''),
    storedConnectionConfig,
  );
  if (tokenUrl.length === 0) {
    return failure(400, 'VALIDATION_ERROR', 'OAuth app profile is missing tokenUrl', stateData);
  }

  const { validateUrlForSSRF, getDevSSRFOptions } = await import('@agent-platform/shared/security');
  const ssrfCheck = validateUrlForSSRF(tokenUrl, getDevSSRFOptions());
  if (!ssrfCheck.safe) {
    return failure(400, 'VALIDATION_ERROR', 'tokenUrl blocked by SSRF protection', stateData);
  }

  const lockKey = `auth-profile:oauth-init-lock:${tenantId}:${stateData.authProfileId}`;

  try {
    const tokenRes = await fetch(tokenUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
      body: tokenBody,
      signal: AbortSignal.timeout(15_000),
    });

    if (!tokenRes.ok) {
      let idpErrorMapped = 'provider_error';
      try {
        const failureBody = await tokenRes.json();
        idpErrorMapped = mapIdpError(failureBody);
      } catch {
        idpErrorMapped = mapIdpError(null);
      }

      void emitOAuthAuditEvent({
        kind: 'failed',
        tenantId,
        userId,
        profileId: stateData.authProfileId,
        scope,
        projectId,
        reason: 'token_exchange_failed',
        idpErrorMapped,
      });
      return failure(
        502,
        'TOKEN_EXCHANGE_FAILED',
        'Token exchange failed with the OAuth provider',
        stateData,
      );
    }

    let tokens: Record<string, unknown>;
    try {
      tokens = await parseTokenResponse(tokenRes);
    } catch {
      void emitOAuthAuditEvent({
        kind: 'failed',
        tenantId,
        userId,
        profileId: stateData.authProfileId,
        scope,
        projectId,
        reason: 'token_response_malformed',
        idpErrorMapped: 'provider_error',
      });
      return failure(
        502,
        'TOKEN_EXCHANGE_FAILED',
        'OAuth provider returned malformed token response',
        stateData,
      );
    }

    if (typeof tokens.access_token !== 'string' || tokens.access_token.trim().length === 0) {
      void emitOAuthAuditEvent({
        kind: 'failed',
        tenantId,
        userId,
        profileId: stateData.authProfileId,
        scope,
        projectId,
        reason: 'token_missing_access_token',
        idpErrorMapped: 'provider_error',
      });
      return failure(
        502,
        'TOKEN_EXCHANGE_FAILED',
        'OAuth provider response did not include an access token',
        stateData,
      );
    }

    const requestedScopes = Array.isArray(stateData.scopes)
      ? stateData.scopes.filter(
          (requestedScope): requestedScope is string => typeof requestedScope === 'string',
        )
      : [];
    const resolvedScope =
      typeof tokens.scope === 'string' && tokens.scope.trim().length > 0
        ? tokens.scope.trim()
        : requestedScopes.join(' ');

    if (resolvedScope.length === 0) {
      return failure(
        502,
        'TOKEN_EXCHANGE_FAILED',
        'OAuth provider response did not include a usable scope value',
        stateData,
      );
    }

    const expiresAt =
      typeof tokens.expires_in === 'number'
        ? new Date(Date.now() + tokens.expires_in * 1000)
        : null;
    const principalScope = targetVisibility === 'shared' ? 'tenant' : 'user';
    const principalId = principalScope === 'tenant' ? TENANT_SHARED_OAUTH_PRINCIPAL_ID : userId;
    const provider = buildAuthProfileOAuthProviderKey(stateData.authProfileId);

    if (principalScope === 'user') {
      assertNotReservedPrincipal(principalId);
    }

    const trimmedRefreshToken =
      typeof tokens.refresh_token === 'string' ? tokens.refresh_token.trim() : '';
    const refreshTokenStored = trimmedRefreshToken.length > 0;

    await upsertOAuthGrant({
      EndUserOAuthToken,
      tenantId,
      projectId,
      profileId: stateData.authProfileId,
      principalId,
      provider,
      accessToken: tokens.access_token,
      refreshToken: refreshTokenStored ? trimmedRefreshToken : null,
      scope: resolvedScope,
      expiresAt,
    });

    try {
      const authProfileProjectId = resolvedAppScope === 'tenant' ? null : projectId;
      await AuthProfile.updateOne(
        {
          _id: stateData.authProfileId,
          tenantId,
          projectId: authProfileProjectId,
          scope: resolvedAppScope,
          status: { $in: ['pending_authorization', 'active', 'revoked'] },
        },
        {
          $set: {
            status: 'active',
            lastValidatedAt: new Date(),
            lastAuthorizedAt: new Date(),
            lastAuthorizedBy: userId,
          },
        },
      );
    } catch (updateErr) {
      // Compensate: remove the orphaned grant so the profile can be re-authorized cleanly.
      await (EndUserOAuthToken as any)
        .deleteOne({ tenantId, projectId, userId: principalId, provider })
        .catch((delErr: unknown) => {
          log.error('oauth_grant_compensation_failed', {
            tenantId,
            principalId,
            provider,
            error: delErr instanceof Error ? delErr.message : String(delErr),
          });
        });
      throw updateErr;
    }

    if (!refreshTokenStored) {
      log.warn('OAuth provider returned no refresh token — grant will not auto-renew', {
        tenantId,
        authProfileId: stateData.authProfileId,
        principalScope,
        scope,
        projectId,
      });
    }

    void emitOAuthAuditEvent({
      kind: 'completed',
      tenantId,
      userId,
      profileId: stateData.authProfileId,
      scope,
      projectId,
    });

    void emitAuthProfileAuditEvent({
      tenantId,
      projectId,
      profileId: stateData.authProfileId,
      eventType: 'authorized',
      actorUserId: userId,
      actorContext: { source: 'profile' },
      eventPayload: {
        principalScope,
        principalId,
        scope: resolvedScope,
      },
    }).catch((auditErr) => {
      log.warn('auth_profile_authorized_audit_event_failed', {
        tenantId,
        projectId,
        profileId: stateData.authProfileId,
        error: auditErr instanceof Error ? auditErr.message : String(auditErr),
      });
    });

    if (requestedScopes.length > 0) {
      const grantedScopeSet = new Set(resolvedScope.split(/\s+/).filter(Boolean));
      const missingScopes = requestedScopes.filter(
        (requestedScope) => !grantedScopeSet.has(requestedScope),
      );
      if (missingScopes.length > 0) {
        void emitAuthProfileAuditEvent({
          tenantId,
          projectId,
          profileId: stateData.authProfileId,
          eventType: 'scope_insufficient_detected',
          actorUserId: userId,
          actorContext: { source: 'profile' },
          eventPayload: {
            requestedScopes,
            grantedScopes: Array.from(grantedScopeSet),
            missingScopes,
          },
        }).catch((auditErr) => {
          log.warn('auth_profile_scope_insufficient_audit_event_failed', {
            tenantId,
            projectId,
            profileId: stateData.authProfileId,
            error: auditErr instanceof Error ? auditErr.message : String(auditErr),
          });
        });
      }
    }

    const result: OAuthGrantCallbackResult = {
      id: provider,
      authProfileId: stateData.authProfileId,
      ...(stateData.authProfileRef ? { authProfileRef: stateData.authProfileRef } : {}),
      provider,
      principalScope,
      principalId,
      storage: 'oauth_grant_store',
      scope: resolvedScope,
      expiresAt: expiresAt?.toISOString() ?? null,
      refreshTokenStored,
    };

    return { success: true, status: 201, data: result, stateData };
  } finally {
    try {
      await redis.del(lockKey);
    } catch (err) {
      log.warn('Failed to release OAuth init lock', {
        tenantId,
        projectId,
        authProfileId: stateData.authProfileId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

export async function abandonAuthProfileOAuthCallback({
  request,
  state,
  errorCode,
  message,
}: AbandonAuthProfileOAuthCallbackParams): Promise<OAuthCallbackFinalizationResult> {
  if (!/^[a-f0-9]{64}$/.test(state)) {
    return failure(400, 'VALIDATION_ERROR', 'Invalid state format');
  }

  const { getRedisClient } = await import('@/lib/redis-client');
  const redis = getRedisClient();
  if (!redis) {
    return failure(500, 'INTERNAL_ERROR', 'Redis unavailable');
  }

  const stateData = await consumeOAuthState(redis, state);
  if (!stateData) {
    return failure(400, 'INVALID_STATE', 'Invalid or expired OAuth state');
  }

  const callbackOrigin = resolveOAuthCallbackOrigin(request);
  if (!callbackOrigin) {
    return failure(
      500,
      'INTERNAL_ERROR',
      'OAuth callback origin is not configured for this deployment',
      stateData,
    );
  }

  const csrfNonce =
    request.cookies.get(AUTH_PROFILE_OAUTH_CSRF_COOKIE)?.value ?? stateData.csrfNonce;
  const bindingFailure = verifyOAuthStateBindings({
    state: stateData,
    tenantId: stateData.tenantId,
    userId: stateData.userId,
    scope: stateData.scope,
    projectId: stateData.projectId,
    csrfNonce,
    redirectUri: `${callbackOrigin}/oauth/auth-profile-callback`,
  });

  if (bindingFailure) {
    return failure(400, 'INVALID_STATE', bindingFailure.message, stateData);
  }

  void emitOAuthAuditEvent({
    kind: 'failed',
    tenantId: stateData.tenantId,
    userId: stateData.userId,
    profileId: stateData.authProfileId,
    scope: stateData.scope,
    projectId: stateData.projectId,
    reason: 'provider_authorization_failed',
    idpErrorMapped: mapIdpError(errorCode),
  });

  try {
    await redis.del(
      `auth-profile:oauth-init-lock:${stateData.tenantId}:${stateData.authProfileId}`,
    );
  } catch (err) {
    log.warn('Failed to release OAuth init lock after provider callback failure', {
      tenantId: stateData.tenantId,
      projectId: stateData.projectId,
      authProfileId: stateData.authProfileId,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  return failure(400, mapIdpError(errorCode), message, stateData);
}
