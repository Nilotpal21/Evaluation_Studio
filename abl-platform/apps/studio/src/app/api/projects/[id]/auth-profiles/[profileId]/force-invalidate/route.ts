/**
 * POST /api/projects/:pid/auth-profiles/:profileId/force-invalidate
 *
 * Publishes a cache invalidation message via Redis pub/sub.
 * Always enabled (promoted to P0 per 2026-05-09 meeting delta).
 */

import { NextResponse } from 'next/server';
import { withRouteHandler } from '@/lib/route-handler';
import { StudioPermission } from '@/lib/permissions';
import { errorJson, ErrorCode } from '@/lib/api-response';
import { ensureDb } from '@/lib/ensure-db';
import { createLogger } from '@abl/compiler/platform/logger.js';
import type { IAuthProfile } from '@agent-platform/database/models';
import { ensureMutableAuthProfile } from '@/app/api/auth-profiles/_auth-profile-route-utils';

const log = createLogger('force-invalidate-route');

export const POST = withRouteHandler(
  { requireProject: true, permissions: StudioPermission.AUTH_PROFILE_WRITE },
  async ({ params, tenantId, user }) => {
    await ensureDb();
    const { AuthProfile } = await import('@agent-platform/database/models');
    const { id: projectId, profileId } = params;

    const profile = await AuthProfile.findOne({
      _id: profileId,
      tenantId,
      projectId,
    });

    if (!profile) {
      return errorJson('Auth profile not found', 404, ErrorCode.NOT_FOUND);
    }

    const writeError = ensureMutableAuthProfile(profile as IAuthProfile, user);
    if (writeError) {
      return writeError;
    }

    const { getRedisClient } = await import('@/lib/redis-client');
    const redis = getRedisClient();
    if (!redis) {
      return errorJson('Redis unavailable', 503, 'SERVICE_UNAVAILABLE');
    }

    try {
      const { publishAuthProfileInvalidate } =
        await import('@agent-platform/shared/services/auth-profile');
      const subscriberCount = await publishAuthProfileInvalidate(
        { profileId, tenantId, projectId },
        redis,
      );

      return NextResponse.json({
        success: true,
        data: {
          profileId,
          subscriberCount,
        },
      });
    } catch (err) {
      log.error('force_invalidate_publish_failed', {
        profileId,
        tenantId,
        error: err instanceof Error ? err.message : String(err),
      });
      return errorJson('Failed to publish invalidation', 500, ErrorCode.INTERNAL_ERROR);
    }
  },
);
