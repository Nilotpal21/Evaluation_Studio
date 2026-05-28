/**
 * GET/PATCH /api/tenant/retention
 *
 * Read and update the current tenant's eval retention contract.
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { requireTenantAuth, isAuthError } from '@/lib/auth';
import { errorJson, ErrorCode, handleApiError } from '@/lib/api-response';
import {
  WORKSPACE_PERMISSIONS,
  requireWorkspacePermission,
  requireWorkspaceRole,
} from '@/lib/workspace-permission';
import { ensureDb } from '@/lib/ensure-db';
import { Tenant } from '@agent-platform/database/models';
import {
  DEFAULT_EVAL_RETENTION,
  resolveEvalRetentionContract,
  type TenantSettingsWithEvalRetention,
} from '@agent-platform/database';
import {
  EVAL_RETENTION_MAX_TTL_DAYS,
  EVAL_RETENTION_MIN_TTL_DAYS,
} from '@agent-platform/database/constants/eval-limits';

const ttlField = z.number().int().min(EVAL_RETENTION_MIN_TTL_DAYS).max(EVAL_RETENTION_MAX_TTL_DAYS);

const updateRetentionSchema = z
  .object({
    evalConversationsTtlDays: ttlField.optional(),
    evalScoresTtlDays: ttlField.optional(),
    productionScoresTtlDays: ttlField.optional(),
    syntheticTtlDays: ttlField.optional(),
    hardDeleteExpiredRuns: z.boolean().optional(),
    scrubPiiOnStore: z.boolean().optional(),
  })
  .strict();

async function loadTenantSettings(tenantId: string): Promise<TenantSettingsWithEvalRetention> {
  await ensureDb();
  const tenant = await Tenant.findOne({ _id: tenantId }).select('settings').lean();
  if (!tenant) {
    throw Object.assign(new Error('Not found'), { statusCode: 404 });
  }
  return (tenant.settings ?? {}) as TenantSettingsWithEvalRetention;
}

export async function GET(request: NextRequest) {
  try {
    const user = await requireTenantAuth(request);
    if (isAuthError(user)) return user;

    const workspaceAccess = await requireWorkspacePermission(
      user.tenantId,
      user,
      WORKSPACE_PERMISSIONS.READ,
      {
        denyBehavior: 'not_found',
        tenantStatuses: ['active'],
        memberStatuses: ['active'],
      },
    );
    if (workspaceAccess instanceof NextResponse) return workspaceAccess;

    const settings = await loadTenantSettings(user.tenantId);
    return NextResponse.json({
      success: true,
      data: {
        defaults: DEFAULT_EVAL_RETENTION,
        effective: resolveEvalRetentionContract(settings),
      },
    });
  } catch (error) {
    return handleApiError(error, 'TenantRetention.GET');
  }
}

export async function PATCH(request: NextRequest) {
  try {
    const user = await requireTenantAuth(request);
    if (isAuthError(user)) return user;

    const workspaceAccess = await requireWorkspaceRole(user.tenantId, user, 'OWNER', {
      denyBehavior: 'forbidden',
      tenantStatuses: ['active'],
      memberStatuses: ['active'],
    });
    if (workspaceAccess instanceof NextResponse) return workspaceAccess;

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return errorJson('Invalid JSON body', 400, ErrorCode.VALIDATION_ERROR);
    }

    const parsed = updateRetentionSchema.safeParse(body);
    if (!parsed.success) {
      const messages = parsed.error.issues.map((issue) => {
        const prefix = issue.path.length ? `${issue.path.join('.')}: ` : '';
        return `${prefix}${issue.message}`;
      });
      return errorJson(messages, 400, ErrorCode.VALIDATION_ERROR);
    }

    const currentSettings = await loadTenantSettings(user.tenantId);
    const nextSettings: TenantSettingsWithEvalRetention = {
      ...currentSettings,
      evalRetention: {
        ...(currentSettings.evalRetention ?? {}),
        ...parsed.data,
      },
    };

    let effective: ReturnType<typeof resolveEvalRetentionContract>;
    try {
      effective = resolveEvalRetentionContract(nextSettings);
    } catch (validationError) {
      return errorJson(
        validationError instanceof Error ? validationError.message : String(validationError),
        400,
        ErrorCode.VALIDATION_ERROR,
      );
    }
    await Tenant.findOneAndUpdate(
      { _id: user.tenantId },
      { $set: { settings: nextSettings } },
      { runValidators: true },
    );

    return NextResponse.json({
      success: true,
      data: {
        defaults: DEFAULT_EVAL_RETENTION,
        effective,
      },
    });
  } catch (error) {
    return handleApiError(error, 'TenantRetention.PATCH');
  }
}
