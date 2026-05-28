/**
 * GET  /api/user/preferences - Fetch user preferences (pinned projects, etc.)
 * PATCH /api/user/preferences - Update user preferences
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { createLogger } from '@abl/compiler/platform/logger.js';
import { requireTenantAuth, isAuthError } from '@/lib/auth';
import { ensureDb } from '@/lib/ensure-db';
import {
  normalizeInsightsAnalyticsFilters,
  strictInsightsAnalyticsFiltersSchema,
} from '@/lib/preferences/insights-analytics-filters';

const logger = createLogger('api:user-preferences');

// ─── Validation ───────────────────────────────────────────────────────────

const MAX_PINNED = 20;

const patchSchema = z
  .object({
    pinnedProjectIds: z.array(z.string().min(1)).max(MAX_PINNED).optional(),
    insightsAnalyticsFilters: strictInsightsAnalyticsFiltersSchema.optional(),
  })
  .strict();

// ─── GET ──────────────────────────────────────────────────────────────────

export async function GET(request: NextRequest) {
  const user = await requireTenantAuth(request);
  if (isAuthError(user)) return user;

  try {
    await ensureDb();
    const { UserPreferences } = await import('@agent-platform/database/models');

    const doc = await UserPreferences.findOne({
      userId: user.id,
      tenantId: user.tenantId,
    }).lean();

    return NextResponse.json({
      success: true,
      data: {
        pinnedProjectIds: doc?.pinnedProjectIds ?? [],
        insightsAnalyticsFilters: normalizeInsightsAnalyticsFilters(doc?.insightsAnalyticsFilters),
      },
    });
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    logger.error('Failed to fetch user preferences', { error: msg });
    return NextResponse.json(
      { success: false, error: { code: 'INTERNAL_ERROR', message: 'Failed to fetch preferences' } },
      { status: 500 },
    );
  }
}

// ─── PATCH ────────────────────────────────────────────────────────────────

export async function PATCH(request: NextRequest) {
  const user = await requireTenantAuth(request);
  if (isAuthError(user)) return user;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { success: false, error: { code: 'INVALID_BODY', message: 'Invalid JSON body' } },
      { status: 400 },
    );
  }

  const parsed = patchSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      {
        success: false,
        error: {
          code: 'VALIDATION_ERROR',
          message: parsed.error.issues.map((i) => i.message).join('; '),
        },
      },
      { status: 400 },
    );
  }

  const update = parsed.data;

  try {
    await ensureDb();
    const { UserPreferences } = await import('@agent-platform/database/models');

    const doc = await UserPreferences.findOneAndUpdate(
      { userId: user.id, tenantId: user.tenantId },
      { $set: update },
      { upsert: true, new: true, lean: true },
    );

    return NextResponse.json({
      success: true,
      data: {
        pinnedProjectIds: doc?.pinnedProjectIds ?? [],
        insightsAnalyticsFilters: normalizeInsightsAnalyticsFilters(doc?.insightsAnalyticsFilters),
      },
    });
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    logger.error('Failed to update user preferences', { error: msg });
    return NextResponse.json(
      {
        success: false,
        error: { code: 'INTERNAL_ERROR', message: 'Failed to update preferences' },
      },
      { status: 500 },
    );
  }
}
