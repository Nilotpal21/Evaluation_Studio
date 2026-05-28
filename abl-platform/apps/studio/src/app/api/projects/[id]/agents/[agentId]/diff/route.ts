/**
 * POST /api/projects/:id/agents/:agentId/diff
 *
 * Compute ABL diff between two strings.
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireAuth, isAuthError } from '@/lib/auth';
import { requireProjectAccess, isAccessError } from '@/lib/project-access';
import { diffABL } from '@agent-platform/project-io/diff';

type RouteParams = { params: Promise<{ id: string; agentId: string }> };

export async function POST(request: NextRequest, { params }: RouteParams) {
  const user = await requireAuth(request);
  if (isAuthError(user)) return user;

  const { id: projectId } = await params;
  const access = await requireProjectAccess(projectId, user);
  if (isAccessError(access)) return access;

  let body: { before?: string; after?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  if (typeof body.before !== 'string' || typeof body.after !== 'string') {
    return NextResponse.json({ error: 'before and after strings are required' }, { status: 400 });
  }

  const diff = diffABL(body.before, body.after);
  return NextResponse.json({ diff });
}
