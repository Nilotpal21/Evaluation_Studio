/**
 * GET /api/projects/:pid/auth-profiles/:profileId/audit-events
 *
 * Paginated query of domain-level audit events for the per-profile Activity tab.
 * Query params:
 *   - eventType: optional filter (must match one of 10 event types)
 *   - cursor: ISO date string for cursor-based pagination
 *   - limit: default 50, max 100
 */

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { withRouteHandler } from '@/lib/route-handler';
import { StudioPermission } from '@/lib/permissions';
import { errorJson, ErrorCode } from '@/lib/api-response';
import { ensureDb } from '@/lib/ensure-db';
import type { IAuthProfile } from '@agent-platform/database/models';
import { ensureReadableAuthProfile } from '@/app/api/auth-profiles/_auth-profile-route-utils';
import {
  AUTH_PROFILE_AUDIT_EVENT_TYPES,
  type IAuthProfileAuditEvent,
} from '@agent-platform/database/models';

const VALID_EVENT_TYPES = AUTH_PROFILE_AUDIT_EVENT_TYPES;

const QuerySchema = z.object({
  eventType: z
    .string()
    .refine((val) => VALID_EVENT_TYPES.includes(val as (typeof VALID_EVENT_TYPES)[number]), {
      message: 'Invalid eventType',
    })
    .optional(),
  cursor: z.string().min(1).optional(),
  limit: z
    .string()
    .optional()
    .transform((val) => {
      if (val === undefined || val === null || val === '') return 50;
      const n = Number(val);
      if (Number.isNaN(n) || n < 1) return 50;
      return Math.min(n, 100);
    }),
});

export const GET = withRouteHandler(
  { requireProject: true, permissions: StudioPermission.AUTH_PROFILE_READ },
  async ({ request, params, tenantId, user }) => {
    await ensureDb();

    const url = new URL(request.url);
    const queryResult = QuerySchema.safeParse({
      eventType: url.searchParams.get('eventType') ?? undefined,
      cursor: url.searchParams.get('cursor') ?? undefined,
      limit: url.searchParams.get('limit') ?? undefined,
    });

    if (!queryResult.success) {
      return errorJson('Invalid query parameters', 400, ErrorCode.VALIDATION_ERROR);
    }

    const { eventType, cursor, limit } = queryResult.data;
    const { id: projectId, profileId } = params;

    const { AuthProfile, AuthProfileAuditEvent } = await import('@agent-platform/database/models');

    // Verify profile exists and is accessible
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

    // Build query filter
    const filter: Record<string, unknown> = {
      tenantId,
      projectId,
      profileId,
    };

    if (eventType) {
      filter.eventType = eventType;
    }

    if (cursor) {
      const cursorDate = new Date(cursor);
      if (!Number.isNaN(cursorDate.getTime())) {
        filter.createdAt = { $lt: cursorDate };
      }
    }

    // Fetch limit + 1 to determine if there are more results
    const events = await (
      AuthProfileAuditEvent as {
        find(filter: Record<string, unknown>): {
          sort(s: Record<string, number>): {
            limit(n: number): {
              lean(): Promise<IAuthProfileAuditEvent[]>;
            };
          };
        };
      }
    )
      .find(filter)
      .sort({ createdAt: -1 })
      .limit(limit + 1)
      .lean();

    const hasMore = events.length > limit;
    const pageEvents = hasMore ? events.slice(0, limit) : events;
    const nextCursor =
      hasMore && pageEvents.length > 0
        ? pageEvents[pageEvents.length - 1].createdAt.toISOString()
        : null;

    return NextResponse.json({
      success: true,
      data: {
        events: pageEvents,
        nextCursor,
      },
    });
  },
);
