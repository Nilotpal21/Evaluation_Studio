/**
 * POST /api/projects/:pid/auth-profiles/:profileId/revoke
 *
 * Revokes an auth profile (sets status to 'revoked').
 * Emits profile_revoked audit event and publishes Redis invalidation.
 */

import { NextResponse } from 'next/server';
import { withRouteHandler } from '@/lib/route-handler';
import { StudioPermission } from '@/lib/permissions';
import { errorJson, ErrorCode } from '@/lib/api-response';
import { ensureDb } from '@/lib/ensure-db';
import { createLogger } from '@abl/compiler/platform/logger.js';
import type { IAuthProfile } from '@agent-platform/database/models';
import { ensureMutableAuthProfile } from '@/app/api/auth-profiles/_auth-profile-route-utils';

const log = createLogger('revoke-auth-profile-route');

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
      const tenantLevel = await AuthProfile.findOne({
        _id: profileId,
        tenantId,
        projectId: null,
        scope: 'tenant',
      }).lean();
      if (tenantLevel) {
        return NextResponse.json(
          {
            success: false,
            error: {
              code: 'FORBIDDEN',
              message:
                'This is a workspace-level auth profile. Revoke it at Settings > Auth Profiles.',
            },
          },
          { status: 403 },
        );
      }
      return errorJson('Auth profile not found', 404, ErrorCode.NOT_FOUND);
    }

    const writeError = ensureMutableAuthProfile(profile as IAuthProfile, user);
    if (writeError) {
      return writeError;
    }

    // ABLP-1123: parity with workspace revoke — reject double-revoke explicitly
    // so a duplicate API call doesn't fire extra audit events / Redis pubs /
    // token updateMany no-ops.
    if (profile.status === 'revoked') {
      return errorJson('Auth profile is already revoked', 400, ErrorCode.VALIDATION_ERROR);
    }

    profile.status = 'revoked';
    await profile.save();

    // Stamp `revokedAt` on every per-user OAuth grant for this profile so the
    // workflow engine's grant resolver (which filters on `revokedAt: null`)
    // stops handing out cached tokens. Without this, revoke only flips the
    // AuthProfile status — which the engine doesn't check — and workflows
    // keep running with the cached/refreshed access token.
    try {
      const { EndUserOAuthToken } = await import('@agent-platform/database/models');
      const { revokeEndUserTokensForProfile } =
        await import('@agent-platform/shared/services/auth-profile');
      const { modifiedCount } = await revokeEndUserTokensForProfile(
        { tenantId, profileId },
        { tokenModel: EndUserOAuthToken as never },
      );
      log.info('Revoked end-user OAuth grants on profile revoke', {
        profileId,
        tenantId,
        modifiedCount,
      });
    } catch (err) {
      log.error('Failed to revoke end-user OAuth grants on profile revoke', {
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
        projectId,
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
        await publishAuthProfileInvalidate({ profileId, tenantId, projectId }, redis);
      }
    } catch (err) {
      log.warn('Failed to publish auth-profile invalidation on revoke', {
        profileId,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    const doc = profile.toObject() as IAuthProfile;
    const { encryptedSecrets, previousEncryptedSecrets, ...safe } = doc;
    return NextResponse.json({ success: true, data: { ...safe, id: safe._id } });
  },
);
