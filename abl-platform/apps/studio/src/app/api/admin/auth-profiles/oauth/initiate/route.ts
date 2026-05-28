/**
 * POST /api/admin/auth-profiles/oauth/initiate
 *
 * Workspace-scoped (tenant-only) OAuth initiate. Mirrors the project initiate
 * route but resolves profiles via the tenant-only lookup helper and omits
 * `projectId` from the Redis state payload.
 *
 * Added in ABLP-619 to remove the `projectId="_workspace"` sentinel previously
 * shipped through the project initiate route.
 */

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { withRouteHandler } from '@/lib/route-handler';
import { StudioPermission } from '@/lib/permissions';
import { errorJson, ErrorCode } from '@/lib/api-response';
import { ensureDb } from '@/lib/ensure-db';
import {
  buildPkceChallenge,
  buildTenantOAuthAppLookupFilter,
  ensureUsableOAuthAppProfile,
  OAUTH_RESERVED_PARAMS,
  resolveOAuthCallbackOrigin,
} from '@/app/api/auth-profiles/_auth-profile-route-utils';
import {
  createOAuthState,
  setOAuthCsrfCookie,
} from '@/app/api/auth-profiles/oauth/_oauth-state-service';
import type { IAuthProfile } from '@agent-platform/database/models';

const TEMPLATE_REGEX = /\$\{connectionConfig\.(\w+)\}/g;

function resolveWithFallback(url: string, config: Record<string, string>): string {
  return url.replace(TEMPLATE_REGEX, (match, key) => config[key] ?? match);
}

const InitiateSchema = z
  .object({
    connectorName: z.string().optional(),
    authProfileId: z.string().min(1).optional(),
    authProfileRef: z.string().min(1).optional(),
    environment: z.string().min(1).nullable().optional(),
    isUserConsent: z.boolean().optional(),
    connectionConfig: z.record(z.string()).optional(),
  })
  .strict()
  .refine((value) => !!value.authProfileId || !!value.authProfileRef, {
    message: 'Either authProfileId or authProfileRef is required',
    path: ['authProfileId'],
  })
  .refine((value) => !(value.authProfileId && value.authProfileRef), {
    message: 'Provide either authProfileId or authProfileRef, not both',
    path: ['authProfileId'],
  });

type InitiateInput = z.infer<typeof InitiateSchema>;

export const POST = withRouteHandler<InitiateInput>(
  {
    permissions: StudioPermission.AUTH_PROFILE_WRITE,
    bodySchema: InitiateSchema,
    rateLimit: { limit: 20, windowMs: 60_000, scope: 'user' },
  },
  async ({ body, user, tenantId, request }) => {
    await ensureDb();
    const { AuthProfile } = await import('@agent-platform/database/models');

    const appProfile = body.authProfileId
      ? await AuthProfile.findOne(
          buildTenantOAuthAppLookupFilter({
            tenantId,
            userId: user.id,
            identifier: { _id: body.authProfileId },
            allowRevoked: true,
          }),
        )
      : await AuthProfile.findOne(
          buildTenantOAuthAppLookupFilter({
            tenantId,
            userId: user.id,
            identifier: { name: body.authProfileRef as string },
            allowRevoked: true,
          }),
        );

    if (!appProfile) {
      return errorJson('OAuth app profile not found', 404, ErrorCode.NOT_FOUND);
    }

    const appProfileError = ensureUsableOAuthAppProfile(appProfile as IAuthProfile, user, {
      allowRevoked: true,
    });
    if (appProfileError) {
      return appProfileError;
    }

    const config = appProfile.config as Record<string, unknown>;

    const { extractConnectionConfigFields } = await import('@/lib/connection-config-utils');
    const providedConfig = body.connectionConfig ?? {};
    const resolvedAuthorizationUrl = resolveWithFallback(
      String(config.authorizationUrl ?? ''),
      providedConfig,
    );
    const resolvedTokenUrl = resolveWithFallback(String(config.tokenUrl ?? ''), providedConfig);

    const unresolvedFields = extractConnectionConfigFields([
      resolvedAuthorizationUrl,
      resolvedTokenUrl,
    ]);
    if (unresolvedFields.length > 0) {
      return errorJson(
        `Unresolved template variables in OAuth URL: ${unresolvedFields.join(', ')}. Provide connectionConfig values.`,
        400,
        ErrorCode.VALIDATION_ERROR,
      );
    }

    const authorizationUrl = resolvedAuthorizationUrl;
    if (typeof authorizationUrl !== 'string') {
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
    let secrets: Record<string, string>;
    try {
      secrets = JSON.parse(appProfile.encryptedSecrets);
    } catch {
      return errorJson('Failed to decrypt OAuth app credentials', 500, ErrorCode.INTERNAL_ERROR);
    }

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

    const authorizationParams = config.authorizationParams as Record<string, string> | undefined;
    if (authorizationParams && typeof authorizationParams === 'object') {
      for (const [key, value] of Object.entries(authorizationParams)) {
        if (OAUTH_RESERVED_PARAMS.has(key)) continue;
        if (!authUrl.searchParams.has(key)) {
          authUrl.searchParams.set(key, value);
        }
      }
    }

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
    const resolvedAppVisibility =
      (appProfile as IAuthProfile).visibility === 'personal' ? 'personal' : 'shared';
    const targetVisibility =
      body.isUserConsent === true ||
      (appProfile as IAuthProfile).connectionMode === 'per_user' ||
      resolvedAppVisibility === 'personal'
        ? 'personal'
        : 'shared';
    const { state, csrfNonce } = await createOAuthState(redis, {
      tenantId,
      projectId: null,
      userId: user.id,
      authProfileId: String(appProfile._id),
      authProfileRef: body.authProfileRef ?? appProfile.name,
      environment: body.environment ?? (appProfile as IAuthProfile).environment ?? null,
      authProfileScope: 'tenant',
      authProfileVisibility: resolvedAppVisibility,
      scopes: defaultScopes,
      isUserConsent: targetVisibility === 'personal',
      targetVisibility,
      redirectUri,
      scope: 'workspace',
      ...((body.connectorName ?? (appProfile as IAuthProfile).connector)
        ? { connectorName: body.connectorName ?? (appProfile as IAuthProfile).connector }
        : {}),
      ...(pkce.codeVerifier ? { codeVerifier: pkce.codeVerifier } : {}),
      ...(Object.keys(providedConfig).length > 0 ? { connectionConfig: providedConfig } : {}),
    });

    authUrl.searchParams.set('state', state);

    const response = NextResponse.json({
      success: true,
      data: { authUrl: authUrl.toString(), state },
    });
    setOAuthCsrfCookie(response, csrfNonce);
    return response;
  },
);
