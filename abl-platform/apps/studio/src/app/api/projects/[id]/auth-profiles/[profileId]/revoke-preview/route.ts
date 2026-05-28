/**
 * GET /api/projects/:pid/auth-profiles/:profileId/revoke-preview
 *
 * Returns blast-radius payload for a revoke or delete operation.
 * Query params:
 *   - type: 'profile' | 'tokens' (required)
 *   - userId: optional user filter for token-level revoke
 */

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { withRouteHandler } from '@/lib/route-handler';
import { StudioPermission } from '@/lib/permissions';
import { errorJson, ErrorCode } from '@/lib/api-response';
import { ensureDb } from '@/lib/ensure-db';
import type { IAuthProfile } from '@agent-platform/database/models';
import { ensureReadableAuthProfile } from '@/app/api/auth-profiles/_auth-profile-route-utils';

const QuerySchema = z.object({
  type: z.enum(['profile', 'tokens']),
  userId: z.string().min(1).optional(),
});

export const GET = withRouteHandler(
  { requireProject: true, permissions: StudioPermission.AUTH_PROFILE_WRITE },
  async ({ request, params, tenantId, user }) => {
    await ensureDb();

    const url = new URL(request.url);
    const queryResult = QuerySchema.safeParse({
      type: url.searchParams.get('type'),
      userId: url.searchParams.get('userId') ?? undefined,
    });

    if (!queryResult.success) {
      return errorJson(
        'Query parameter "type" is required and must be "profile" or "tokens"',
        400,
        ErrorCode.VALIDATION_ERROR,
      );
    }

    const { type, userId } = queryResult.data;
    const { id: projectId, profileId } = params;

    const { AuthProfile } = await import('@agent-platform/database/models');

    // Verify profile exists within tenant + project scope
    const profile = await AuthProfile.findOne({
      _id: profileId,
      tenantId,
      $or: [{ projectId }, { projectId: null, scope: 'tenant' }],
    }).lean();

    if (!profile) {
      return errorJson('Auth profile not found', 404, ErrorCode.NOT_FOUND);
    }

    const readError = ensureReadableAuthProfile(profile as IAuthProfile, user);
    if (readError) {
      return readError;
    }

    const { aggregateBlastRadius } = await import('@agent-platform/shared/services/auth-profile');

    const payload = await aggregateBlastRadius(profileId, tenantId, projectId, {
      type,
      userId,
    });

    return NextResponse.json({
      success: true,
      data: payload,
    });
  },
);
