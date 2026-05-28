/**
 * POST /api/auth-profiles/bulk — Bulk actions on tenant-scoped auth profiles
 *
 * Supports: delete, revoke, activate
 * Each profile is verified for tenant ownership individually.
 * Delete checks for consumers per-profile (cascade protection).
 */

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { withRouteHandler } from '@/lib/route-handler';
import { StudioPermission } from '@/lib/permissions';
import { errorJson, ErrorCode } from '@/lib/api-response';
import { ensureDb } from '@/lib/ensure-db';
import { hasPermission } from '@/lib/permission-resolver';
import { executeBulkAction, loadModelMap, type BulkResult } from '../_bulk-handler';
import { canWriteAuthProfile } from '../_auth-profile-route-utils';
import type { IAuthProfile } from '@agent-platform/database/models';

// ─── Request Schema ─────────────────────────────────────────────────────

const BulkActionSchema = z.object({
  action: z.enum(['delete', 'revoke', 'activate']),
  profileIds: z.array(z.string().min(1)).min(1).max(50),
});

type BulkActionInput = z.infer<typeof BulkActionSchema>;

// ─── POST — Bulk action ─────────────────────────────────────────────────

export const POST = withRouteHandler<BulkActionInput>(
  {
    permissions: [StudioPermission.AUTH_PROFILE_WRITE, StudioPermission.AUTH_PROFILE_DELETE],
    bodySchema: BulkActionSchema as any,
  },
  async ({ body, tenantId, user }) => {
    await ensureDb();

    const { action, profileIds } = body;

    if (!profileIds || profileIds.length === 0) {
      return errorJson('At least 1 profile required', 400, ErrorCode.VALIDATION_ERROR);
    }
    if (profileIds.length > 50) {
      return errorJson('Maximum 50 profiles per request', 400, ErrorCode.VALIDATION_ERROR);
    }

    // Per-action permission check: delete requires DELETE, revoke/activate require WRITE
    const requiredPermission =
      action === 'delete'
        ? StudioPermission.AUTH_PROFILE_DELETE
        : StudioPermission.AUTH_PROFILE_WRITE;
    if (!hasPermission(user.permissions, requiredPermission)) {
      return errorJson(
        `Forbidden: ${action} requires ${requiredPermission} permission`,
        403,
        ErrorCode.FORBIDDEN,
      );
    }

    const models = await loadModelMap();
    const AuthProfile = models.AuthProfile;
    const isAdmin = user.permissions?.includes(StudioPermission.AUTH_PROFILE_DECRYPT) === true;

    const results: BulkResult[] = [];

    for (const profileId of profileIds) {
      try {
        // Verify tenant ownership
        const profile = await AuthProfile.findOne({
          _id: profileId,
          tenantId,
          projectId: null,
          scope: 'tenant',
        }).lean();

        if (!profile) {
          results.push({ id: profileId, status: 'error', error: 'Profile not found' });
          continue;
        }

        if (!canWriteAuthProfile(profile as IAuthProfile, user)) {
          results.push({ id: profileId, status: 'error', error: 'Profile not found' });
          continue;
        }

        const result = await executeBulkAction({
          action,
          profileId,
          profile: profile as Record<string, unknown>,
          tenantId,
          userId: user.id,
          isAdmin,
          workspaceOnly: true,
          ownershipFilter: { _id: profileId, tenantId, projectId: null, scope: 'tenant' },
          modelMap: models,
          AuthProfile,
        });
        results.push(result);
      } catch (err) {
        results.push({
          id: profileId,
          status: 'error',
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    return NextResponse.json({
      success: true,
      data: { results },
    });
  },
);
