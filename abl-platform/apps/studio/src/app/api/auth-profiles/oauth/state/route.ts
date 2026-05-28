import { NextResponse } from 'next/server';
import { z } from 'zod';
import { withRouteHandler } from '@/lib/route-handler';
import { StudioPermission } from '@/lib/permissions';
import { errorJson, ErrorCode } from '@/lib/api-response';
import { resolveOAuthCallbackOrigin } from '@/app/api/auth-profiles/_auth-profile-route-utils';
import {
  AUTH_PROFILE_OAUTH_CSRF_COOKIE,
  peekOAuthState,
  verifyOAuthStateBindings,
} from '@/app/api/auth-profiles/oauth/_oauth-state-service';

const QuerySchema = z.object({
  state: z.string().regex(/^[a-f0-9]{64}$/),
});

interface OAuthStateResolution {
  scope: 'project' | 'workspace';
  projectId: string | null;
}

export const GET = withRouteHandler(
  {
    permissions: StudioPermission.AUTH_PROFILE_WRITE,
    rateLimit: { limit: 30, windowMs: 60_000, scope: 'user' },
  },
  async ({ request, user, tenantId }) => {
    const parsedQuery = QuerySchema.safeParse({
      state: request.nextUrl.searchParams.get('state') ?? '',
    });
    if (!parsedQuery.success) {
      return errorJson('Invalid state format', 400, ErrorCode.VALIDATION_ERROR);
    }

    const { getRedisClient } = await import('@/lib/redis-client');
    const redis = getRedisClient();
    if (!redis) {
      return errorJson('Redis unavailable', 500, ErrorCode.INTERNAL_ERROR);
    }

    const stateData = await peekOAuthState(redis, parsedQuery.data.state);
    if (!stateData) {
      return errorJson('Invalid or expired OAuth state', 400, 'INVALID_STATE');
    }

    const callbackOrigin = resolveOAuthCallbackOrigin(request);
    if (!callbackOrigin) {
      return errorJson(
        'OAuth callback origin is not configured for this deployment',
        500,
        ErrorCode.INTERNAL_ERROR,
      );
    }

    const bindingFailure = verifyOAuthStateBindings({
      state: stateData,
      tenantId,
      userId: user.id,
      scope: stateData.scope,
      projectId: stateData.projectId,
      csrfNonce: request.cookies.get(AUTH_PROFILE_OAUTH_CSRF_COOKIE)?.value,
      redirectUri: `${callbackOrigin}/oauth/auth-profile-callback`,
    });
    if (bindingFailure) {
      return errorJson(bindingFailure.message, 400, 'INVALID_STATE');
    }

    if (stateData.scope === 'project' && !stateData.projectId) {
      return errorJson('OAuth state project mismatch', 400, 'INVALID_STATE');
    }

    const response: OAuthStateResolution = {
      scope: stateData.scope,
      projectId: stateData.projectId,
    };

    return NextResponse.json({
      success: true,
      data: response,
    });
  },
);
