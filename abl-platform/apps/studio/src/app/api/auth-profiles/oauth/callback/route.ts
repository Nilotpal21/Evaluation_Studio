import { NextResponse } from 'next/server';
import { z } from 'zod';
import { withRouteHandler } from '@/lib/route-handler';
import { StudioPermission } from '@/lib/permissions';
import { errorJson, ErrorCode } from '@/lib/api-response';
import { clearOAuthCsrfCookie } from '@/app/api/auth-profiles/oauth/_oauth-state-service';
import { finalizeAuthProfileOAuthCallback } from '@/app/api/auth-profiles/oauth/_oauth-callback-finalizer';

const CallbackSchema = z
  .object({
    code: z.string().min(1),
    state: z.string().min(1),
    displayName: z.string().max(255).optional(),
  })
  .strict();

type CallbackInput = z.infer<typeof CallbackSchema>;

function isWorkspaceOAuthEnabled(): boolean {
  const flag = process.env.WORKSPACE_OAUTH_ENABLED;
  if (!flag) {
    return true;
  }
  return flag.toLowerCase() !== 'false';
}

export const POST = withRouteHandler<CallbackInput>(
  {
    permissions: StudioPermission.AUTH_PROFILE_WRITE,
    bodySchema: CallbackSchema,
    rateLimit: { limit: 10, windowMs: 60_000, scope: 'user' },
  },
  async ({ body, user, tenantId, request }) => {
    if (!isWorkspaceOAuthEnabled()) {
      return errorJson('Not found', 404, ErrorCode.NOT_FOUND);
    }

    const result = await finalizeAuthProfileOAuthCallback({
      request,
      code: body.code,
      state: body.state,
      expectedScope: 'workspace',
      authenticatedContext: {
        tenantId,
        userId: user.id,
        projectId: null,
        scope: 'workspace',
      },
    });

    if (!result.success) {
      return errorJson(result.message, result.status, result.code);
    }

    const response = NextResponse.json({ success: true, data: result.data }, { status: 201 });
    clearOAuthCsrfCookie(response);
    return response;
  },
);
