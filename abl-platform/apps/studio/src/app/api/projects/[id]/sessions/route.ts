/**
 * GET /api/projects/:id/sessions - List sessions in project
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { withOpenAPI } from '@agent-platform/openapi/nextjs';
import { getProjectSessions } from '@/services/project-service';
import { requireAuth, isAuthError } from '@/lib/auth';
import { isProjectPermissionError, requireProjectPermission } from '@/lib/project-permission';
import { createLogger } from '@abl/compiler/platform/logger.js';

const log = createLogger('sessions-route');

const pathParamsSchema = z.object({
  id: z.string(),
});

const queryParamsSchema = z.object({
  limit: z.string().optional().default('50'),
  offset: z.string().optional().default('0'),
});

const sessionItemSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  agentId: z.string().nullable().optional(),
  userId: z.string().nullable().optional(),
  channelId: z.string().nullable().optional(),
  startedAt: z.string().datetime(),
  lastActivityAt: z.string().datetime(),
  status: z.string(),
  metadata: z.record(z.unknown()).nullable().optional(),
});

const listSessionsResponseSchema = z.object({
  sessions: z.array(sessionItemSchema),
});

type RouteParams = { params: Promise<{ id: string }> };

async function getHandler(request: NextRequest, { params }: RouteParams) {
  const user = await requireAuth(request);
  if (isAuthError(user)) return user;

  const { id } = await params;

  const access = await requireProjectPermission(id, user, 'session:read');
  if (isProjectPermissionError(access)) return access;

  const limit = Math.min(parseInt(request.nextUrl.searchParams.get('limit') || '50'), 100);
  const offset = parseInt(request.nextUrl.searchParams.get('offset') || '0');

  try {
    const sessions = await getProjectSessions(id, {
      limit,
      offset,
      tenantId: access.project.tenantId,
      userId: user.id,
      isAdmin: user.role === 'ADMIN' || user.role === 'OWNER',
    });
    return NextResponse.json({ sessions });
  } catch (error) {
    log.error('List sessions error', {
      projectId: id,
      error: error instanceof Error ? error.message : String(error),
    });
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

export const GET = withOpenAPI(
  {
    summary: 'List project sessions',
    description: 'Retrieve paginated list of sessions for a specific project.',
    params: pathParamsSchema,
    query: queryParamsSchema,
    response: listSessionsResponseSchema,
    successStatus: 200,
    auth: true,
  },
  getHandler as any,
);
