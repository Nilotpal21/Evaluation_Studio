/**
 * POST /api/projects/:pid/auth-profiles/oauth/user-consent
 *
 * Initiates end-user OAuth consent flow (runtime context).
 */

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { withRouteHandler } from '@/lib/route-handler';
import { StudioPermission } from '@/lib/permissions';
import { errorJson, ErrorCode } from '@/lib/api-response';
import { ensureDb } from '@/lib/ensure-db';
import {
  buildPkceChallenge,
  buildProjectOAuthAppLookupFilter,
  ensureUsableOAuthAppProfile,
  OAUTH_RESERVED_PARAMS,
  resolveOAuthCallbackOrigin,
} from '@/app/api/auth-profiles/_auth-profile-route-utils';
import {
  createOAuthState,
  setOAuthCsrfCookie,
} from '@/app/api/auth-profiles/oauth/_oauth-state-service';
import { emitOAuthAuditEvent } from '@/app/api/auth-profiles/oauth/_oauth-audit';
import type { IAuthProfile } from '@agent-platform/database/models';

const UserConsentSchema = z.object({
  connectorName: z.string().min(1),
  sessionId: z.string().min(1),
  authProfileId: z.string().min(1),
});

type UserConsentInput = z.infer<typeof UserConsentSchema>;

export const POST = withRouteHandler<UserConsentInput>(
  {
    requireProject: true,
    permissions: StudioPermission.AUTH_PROFILE_WRITE,
    bodySchema: UserConsentSchema,
    rateLimit: { limit: 20, windowMs: 60_000, scope: 'user' },
  },
  async ({ body, user, params, tenantId, request }) => {
    await ensureDb();
    const { AuthProfile } = await import('@agent-platform/database/models');
    const projectId = params.id;

    // Load the oauth2_app profile
    const appProfile = await AuthProfile.findOne(
      buildProjectOAuthAppLookupFilter({
        tenantId,
        projectId,
        userId: user.id,
        identifier: { _id: body.authProfileId },
      }),
    );

    if (!appProfile) {
      return errorJson('OAuth app profile not found', 404, ErrorCode.NOT_FOUND);
    }

    const appProfileError = ensureUsableOAuthAppProfile(appProfile as IAuthProfile, user);
    if (appProfileError) {
      return appProfileError;
    }

    const config = appProfile.config as Record<string, unknown>;
    // encryption plugin auto-decrypts on findOne() (no .lean())
    let secrets: Record<string, string>;
    try {
      secrets = JSON.parse(appProfile.encryptedSecrets);
    } catch {
      return errorJson('Failed to decrypt OAuth app credentials', 500, ErrorCode.INTERNAL_ERROR);
    }

    // Reject unresolved connection-config template variables (FR-5 error path)
    const { extractConnectionConfigFields } = await import('@/lib/connection-config-utils');
    const unresolvedFields = extractConnectionConfigFields([
      String(config.authorizationUrl ?? ''),
      String(config.tokenUrl ?? ''),
    ]);
    if (unresolvedFields.length > 0) {
      return errorJson(
        `Unresolved template variables in OAuth URL: ${unresolvedFields.join(', ')}. Provide connectionConfig values.`,
        400,
        ErrorCode.VALIDATION_ERROR,
      );
    }

    // Build authorization URL
    const authorizationUrl = config.authorizationUrl;
    if (typeof authorizationUrl !== 'string' || authorizationUrl.length === 0) {
      return errorJson(
        'OAuth app profile is missing authorizationUrl',
        400,
        ErrorCode.VALIDATION_ERROR,
      );
    }

    const { validateUrlForSSRF } = await import('@agent-platform/shared/security');
    const { getDevSSRFOptions } = await import('@agent-platform/shared-kernel/security');
    const ssrfCheck = validateUrlForSSRF(authorizationUrl, getDevSSRFOptions());
    if (!ssrfCheck.safe) {
      return errorJson(
        'authorizationUrl blocked by SSRF protection',
        400,
        ErrorCode.VALIDATION_ERROR,
      );
    }

    const authUrl = new URL(authorizationUrl);
    authUrl.searchParams.set('client_id', secrets.clientId);
    const requestOrigin = resolveOAuthCallbackOrigin(request);
    if (!requestOrigin) {
      return errorJson(
        'OAuth callback origin is not configured for this deployment',
        500,
        ErrorCode.INTERNAL_ERROR,
      );
    }
    const redirectUri = `${requestOrigin}/oauth/auth-profile-callback`;
    authUrl.searchParams.set('redirect_uri', redirectUri);
    authUrl.searchParams.set('response_type', 'code');

    if ((config.defaultScopes as string[])?.length) {
      const separator = (config.scopeSeparator as string) ?? ' ';
      authUrl.searchParams.set('scope', (config.defaultScopes as string[]).join(separator));
    }

    const pkce = buildPkceChallenge(config);
    if (pkce.codeChallenge && pkce.codeChallengeMethod) {
      authUrl.searchParams.set('code_challenge', pkce.codeChallenge);
      authUrl.searchParams.set('code_challenge_method', pkce.codeChallengeMethod);
    }

    // Merge authorizationParams from profile config (e.g., access_type=offline, prompt=consent)
    const authorizationParams = config.authorizationParams as Record<string, string> | undefined;
    if (authorizationParams && typeof authorizationParams === 'object') {
      for (const [key, value] of Object.entries(authorizationParams)) {
        // Skip reserved OAuth params — defense-in-depth against injection and code reordering
        if (OAUTH_RESERVED_PARAMS.has(key)) continue;
        if (!authUrl.searchParams.has(key)) {
          authUrl.searchParams.set(key, value);
        }
      }
    }

    // Store state in Redis
    const { getRedisClient } = await import('@/lib/redis-client');
    const redis = getRedisClient();
    if (!redis) {
      return NextResponse.json(
        {
          success: false,
          error: {
            code: 'SERVICE_UNAVAILABLE',
            message: 'OAuth state storage unavailable — please try again',
          },
        },
        { status: 503 },
      );
    }

    const defaultScopes = Array.isArray(config.defaultScopes)
      ? config.defaultScopes.filter((scope): scope is string => typeof scope === 'string')
      : [];
    const resolvedAppScope = (appProfile as IAuthProfile).scope === 'tenant' ? 'tenant' : 'project';
    const resolvedAppVisibility =
      (appProfile as IAuthProfile).visibility === 'personal' ? 'personal' : 'shared';
    const { state, csrfNonce } = await createOAuthState(redis, {
      tenantId,
      projectId,
      userId: user.id,
      authProfileId: body.authProfileId,
      authProfileScope: resolvedAppScope,
      authProfileVisibility: resolvedAppVisibility,
      sessionId: body.sessionId,
      connectorName: body.connectorName,
      scopes: defaultScopes,
      isUserConsent: true,
      targetVisibility: 'personal',
      redirectUri,
      scope: 'project',
      ...(pkce.codeVerifier ? { codeVerifier: pkce.codeVerifier } : {}),
    });
    authUrl.searchParams.set('state', state);

    void emitOAuthAuditEvent({
      kind: 'initiated',
      tenantId,
      userId: user.id,
      profileId: body.authProfileId,
      scope: 'project',
      projectId,
    });

    const response = NextResponse.json({
      success: true,
      data: {
        authUrl: authUrl.toString(),
        state,
        sessionId: body.sessionId,
      },
    });
    setOAuthCsrfCookie(response, csrfNonce);
    return response;
  },
);
