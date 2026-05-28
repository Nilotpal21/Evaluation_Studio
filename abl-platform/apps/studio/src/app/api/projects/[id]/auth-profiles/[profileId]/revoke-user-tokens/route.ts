/**
 * POST /api/projects/:pid/auth-profiles/:profileId/revoke-user-tokens
 *
 * Deletes matching EndUserOAuthToken rows by {tenantId, profileId[, userId]}.
 * Profile stays active; encryptedSecrets unchanged.
 * Emits 'tokens_revoked' audit event and publishes Redis invalidation.
 */

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { withRouteHandler } from '@/lib/route-handler';
import { StudioPermission } from '@/lib/permissions';
import { errorJson, ErrorCode } from '@/lib/api-response';
import { ensureDb } from '@/lib/ensure-db';
import { createLogger } from '@abl/compiler/platform/logger.js';
import type { IAuthProfile } from '@agent-platform/database/models';
import { ensureMutableAuthProfile } from '@/app/api/auth-profiles/_auth-profile-route-utils';

const log = createLogger('revoke-user-tokens-route');

const QuerySchema = z.object({
  userId: z.string().min(1).optional(),
});

export const POST = withRouteHandler(
  { requireProject: true, permissions: StudioPermission.AUTH_PROFILE_WRITE },
  async ({ request, params, tenantId, user }) => {
    await ensureDb();

    const url = new URL(request.url);
    const queryResult = QuerySchema.safeParse({
      userId: url.searchParams.get('userId') ?? undefined,
    });

    if (!queryResult.success) {
      return errorJson('Invalid query parameters', 400, ErrorCode.VALIDATION_ERROR);
    }

    const { userId } = queryResult.data;
    const { id: projectId, profileId } = params;

    const { AuthProfile, EndUserOAuthToken } = await import('@agent-platform/database/models');
    const { buildAuthProfileOAuthProviderKey } =
      await import('@agent-platform/shared/services/auth-profile');

    // Verify profile exists and is mutable
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

    // Build deletion filter.
    // projectId is intentionally omitted: `provider` is a deterministic key derived from
    // `profileId` (via buildAuthProfileOAuthProviderKey), making it globally unique within the
    // tenant. Tokens may carry a null projectId (e.g. migrated from pre-project-scope schema),
    // so filtering by projectId would silently miss them and leave stale active tokens behind.
    const provider = buildAuthProfileOAuthProviderKey(profileId);
    const deleteFilter: Record<string, unknown> = {
      tenantId,
      provider,
      revokedAt: null,
    };
    if (userId) {
      deleteFilter.userId = userId;
    }

    // Get affected users before deletion
    const affectedUserIds = await (
      EndUserOAuthToken as {
        distinct(field: string, filter: Record<string, unknown>): Promise<string[]>;
      }
    ).distinct('userId', deleteFilter);

    // Delete tokens
    const deleteResult = await (
      EndUserOAuthToken as {
        deleteMany(filter: Record<string, unknown>): Promise<{ deletedCount: number }>;
      }
    ).deleteMany(deleteFilter);

    const deletedCount = deleteResult.deletedCount ?? 0;

    // Emit audit event (fire-and-forget)
    try {
      const { emitAuthProfileAuditEvent } =
        await import('@agent-platform/shared/services/auth-profile');
      await emitAuthProfileAuditEvent({
        tenantId,
        projectId,
        profileId,
        eventType: 'tokens_revoked',
        actorUserId: user.id,
        actorContext: { source: 'profile' },
        eventPayload: {
          scope: userId ? 'single_user' : 'all_users',
          count: deletedCount,
          ...(userId ? { userId } : {}),
        },
      });
    } catch (err) {
      log.warn('Failed to emit tokens_revoked audit event', {
        profileId,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    // Publish Redis invalidation (fire-and-forget)
    try {
      const { getRedisClient } = await import('@/lib/redis-client');
      const redis = getRedisClient();
      if (redis) {
        const { publishAuthProfileInvalidate } =
          await import('@agent-platform/shared/services/auth-profile');
        await publishAuthProfileInvalidate({ profileId, tenantId, projectId }, redis);
      }
    } catch (err) {
      log.warn('Failed to publish auth-profile invalidation', {
        profileId,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    return NextResponse.json({
      success: true,
      data: {
        deletedCount,
        affectedUsers: affectedUserIds.length,
      },
    });
  },
);
