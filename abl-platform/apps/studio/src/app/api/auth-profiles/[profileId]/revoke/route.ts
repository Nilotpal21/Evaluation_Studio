/**
 * POST /api/auth-profiles/:profileId/revoke — Revoke a tenant-scoped auth profile
 */

import { NextResponse } from 'next/server';
import { withRouteHandler } from '@/lib/route-handler';
import { StudioPermission } from '@/lib/permissions';
import { errorJson, ErrorCode } from '@/lib/api-response';
import { ensureDb } from '@/lib/ensure-db';
import { createLogger } from '@abl/compiler/platform/logger.js';
import type { IAuthProfile } from '@agent-platform/database/models';
import { ensureMutableAuthProfile } from '../../_auth-profile-route-utils';

const log = createLogger('workspace-revoke-auth-profile-route');

export const POST = withRouteHandler(
  { permissions: StudioPermission.AUTH_PROFILE_WRITE },
  async ({ params, tenantId, user }) => {
    await ensureDb();
    const { AuthProfile } = await import('@agent-platform/database/models');
    const { profileId } = params;

    const profile = await AuthProfile.findOne({
      _id: profileId,
      tenantId,
      projectId: null,
      scope: 'tenant',
    });

    if (!profile) {
      return errorJson('Auth profile not found', 404, ErrorCode.NOT_FOUND);
    }

    const doc = profile as unknown as IAuthProfile & { save: () => Promise<unknown> };
    const writeError = ensureMutableAuthProfile(doc, user);
    if (writeError) {
      return writeError;
    }
    if (doc.status === 'revoked') {
      return errorJson('Auth profile is already revoked', 400, ErrorCode.VALIDATION_ERROR);
    }

    doc.status = 'revoked';
    await doc.save();

    // Stamp `revokedAt` on every per-user OAuth grant for this profile so the
    // workflow engine's grant resolver stops handing out cached tokens.
    try {
      const { EndUserOAuthToken } = await import('@agent-platform/database/models');
      const { revokeEndUserTokensForProfile } =
        await import('@agent-platform/shared/services/auth-profile');
      const { modifiedCount } = await revokeEndUserTokensForProfile(
        { tenantId, profileId },
        { tokenModel: EndUserOAuthToken as never },
      );
      log.info('Revoked end-user OAuth grants on workspace profile revoke', {
        profileId,
        tenantId,
        modifiedCount,
      });
    } catch (err) {
      log.error('Failed to revoke end-user OAuth grants on workspace profile revoke', {
        profileId,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    // Emit profile_revoked audit event (fire-and-forget)
    try {
      const { emitAuthProfileAuditEvent } =
        await import('@agent-platform/shared/services/auth-profile');
      await emitAuthProfileAuditEvent({
        tenantId,
        projectId: null,
        profileId,
        eventType: 'profile_revoked',
        actorUserId: user.id,
        actorContext: { source: 'profile' },
        eventPayload: {},
      });
    } catch (err) {
      log.warn('Failed to emit profile_revoked audit event', {
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
        await publishAuthProfileInvalidate({ profileId, tenantId, projectId: null }, redis);
      }
    } catch (err) {
      log.warn('Failed to publish auth-profile invalidation on workspace revoke', {
        profileId,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    return NextResponse.json({ success: true, data: { revoked: profileId } });
  },
);
