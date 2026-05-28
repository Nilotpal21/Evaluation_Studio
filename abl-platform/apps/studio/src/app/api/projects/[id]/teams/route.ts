/**
 * GET  /api/projects/:id/teams — List teams for tenant
 * POST /api/projects/:id/teams — Create team
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireAuth, isAuthError } from '@/lib/auth';
import { requireProjectAccess, isAccessError } from '@/lib/project-access';
import { ensureConnected, Team, Project } from '@agent-platform/database/models';

type RouteParams = { params: Promise<{ id: string }> };

export async function GET(request: NextRequest, { params }: RouteParams) {
  const user = await requireAuth(request);
  if (isAuthError(user)) return user;

  const { id: projectId } = await params;
  const access = await requireProjectAccess(projectId, user);
  if (isAccessError(access)) return access;

  try {
    await ensureConnected();

    const project = await Project.findOne({ _id: projectId, tenantId: user.tenantId }).lean();
    if (!project) {
      return NextResponse.json({ error: 'Project not found' }, { status: 404 });
    }

    const teams = await Team.find({ tenantId: user.tenantId }).lean();
    return NextResponse.json({ teams });
  } catch (error) {
    console.error('[Teams GET] Error:', error);
    return NextResponse.json({ error: 'Failed to list teams' }, { status: 500 });
  }
}

export async function POST(request: NextRequest, { params }: RouteParams) {
  const user = await requireAuth(request);
  if (isAuthError(user)) return user;

  const { id: projectId } = await params;
  const access = await requireProjectAccess(projectId, user);
  if (isAccessError(access)) return access;

  let body: { name: string; slug: string; description?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  if (!body.name || !body.slug) {
    return NextResponse.json({ error: 'name and slug are required' }, { status: 400 });
  }

  try {
    await ensureConnected();

    const project = await Project.findOne({ _id: projectId, tenantId: user.tenantId }).lean();
    if (!project) {
      return NextResponse.json({ error: 'Project not found' }, { status: 404 });
    }

    const team = await Team.create({
      tenantId: user.tenantId,
      name: body.name,
      slug: body.slug,
      description: body.description ?? null,
      members: [{ userId: user.id, role: 'lead', addedBy: user.id, addedAt: new Date() }],
    });

    return NextResponse.json({ team }, { status: 201 });
  } catch (error: unknown) {
    if (error instanceof Error && 'code' in error && (error as { code?: number }).code === 11000) {
      return NextResponse.json(
        { error: 'Team with this name or slug already exists' },
        { status: 409 },
      );
    }
    console.error('[Teams POST] Error:', error);
    return NextResponse.json({ error: 'Failed to create team' }, { status: 500 });
  }
}
