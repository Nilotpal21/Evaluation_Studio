/**
 * GET  /api/projects/:id/agents - List agents in project
 * POST /api/projects/:id/agents - Add agent to project
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { getProjectAgents, addAgentToProject } from '@/services/project-service';
import { logAuditEvent, AuditActions } from '@/services/audit-service';
import { requireAuth, isAuthError } from '@/lib/auth';
import { isProjectPermissionError, requireProjectPermission } from '@/lib/project-permission';
import { AGENT_NAME_PATTERN, AGENT_NAME_MAX_LENGTH } from '@agent-platform/shared';

const addAgentSchema = z.object({
  name: z
    .string()
    .min(1)
    .max(AGENT_NAME_MAX_LENGTH)
    .regex(
      AGENT_NAME_PATTERN,
      'Agent name must start with a letter and contain only letters, digits, and underscores',
    ),
  agentPath: z.string().min(1).max(500).optional(),
  description: z.string().max(500).optional(),
});

type RouteParams = { params: Promise<{ id: string }> };

export async function GET(request: NextRequest, { params }: RouteParams) {
  const user = await requireAuth(request);
  if (isAuthError(user)) return user;

  const { id } = await params;

  const access = await requireProjectPermission(id, user, 'agent:read');
  if (isProjectPermissionError(access)) return access;

  try {
    const agents = await getProjectAgents(id, access.project.tenantId);
    return NextResponse.json({ agents });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('[Projects] List agents error:', error);
    return NextResponse.json({ error: `Failed to list agents: ${message}` }, { status: 500 });
  }
}

export async function POST(request: NextRequest, { params }: RouteParams) {
  const user = await requireAuth(request);
  if (isAuthError(user)) return user;

  const { id } = await params;

  const access = await requireProjectPermission(id, user, 'agent:create');
  if (isProjectPermissionError(access)) return access;

  const body = await request.json();
  const result = addAgentSchema.safeParse(body);

  if (!result.success) {
    return NextResponse.json(
      { error: 'Invalid request', details: result.error.issues },
      { status: 400 },
    );
  }

  let agent;
  try {
    agent = await addAgentToProject({
      projectId: id,
      tenantId: access.project.tenantId,
      ...result.data,
    });
  } catch (error: unknown) {
    if (error instanceof Error && 'code' in error && (error as { code?: number }).code === 11000) {
      return NextResponse.json(
        { error: 'Agent with this name already exists in project' },
        { status: 409 },
      );
    }
    const message = error instanceof Error ? error.message : String(error);
    console.error('[Projects] Add agent error:', error);
    return NextResponse.json({ error: `Failed to add agent: ${message}` }, { status: 500 });
  }

  // Audit logging is best-effort
  logAuditEvent({
    userId: user.id,
    tenantId: access.project.tenantId,
    action: AuditActions.AGENT_ADDED,
    ip: request.headers.get('x-forwarded-for') || undefined,
    userAgent: request.headers.get('user-agent') || undefined,
    metadata: {
      projectId: id,
      resourceType: 'agent',
      resourceId: agent.id,
      agentId: agent.id,
      agentName: agent.name,
    },
  }).catch((err) => console.error('[Projects] Audit log failed:', err));

  return NextResponse.json(agent, { status: 201 });
}
