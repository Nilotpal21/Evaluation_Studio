/**
 * GET    /api/projects/:id/agents/:agentId - Get agent detail
 * PATCH  /api/projects/:id/agents/:agentId - Update agent
 * DELETE /api/projects/:id/agents/:agentId - Remove agent
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { AGENT_NAME_MAX_LENGTH, AGENT_NAME_PATTERN } from '@agent-platform/shared';
import { AppError } from '@agent-platform/shared/errors';
import {
  updateAgent,
  removeAgentFromProject,
  updateProject as updateProjectConfig,
} from '@/services/project-service';
import { findProjectAgent } from '@/repos/project-repo';
import { logAuditEvent, AuditActions } from '@/services/audit-service';
import { requireAuth, isAuthError } from '@/lib/auth';
import { requireProjectAccess, isAccessError } from '@/lib/project-access';
import { checkAgentPermission } from '@/lib/agent-permission';
import { refreshPersistedStudioProjectAgentDraftMetadata } from '@/lib/abl/project-agent-draft-metadata';
import { resolvePromptLibraryRefOnDocument } from '@agent-platform/shared/prompts';

const updateAgentSchema = z.object({
  name: z
    .string()
    .min(1)
    .max(AGENT_NAME_MAX_LENGTH)
    .regex(
      AGENT_NAME_PATTERN,
      'Agent name must start with a letter and contain only letters, numbers, and underscores',
    )
    .optional(),
  agentPath: z.never().optional(),
  description: z.string().max(500).optional(),
  systemPromptLibraryRef: z
    .object({
      promptId: z.string().min(1),
      versionId: z.string().min(1),
      resolvedHash: z.string().min(1).optional(),
    })
    .passthrough()
    .nullable()
    .optional(),
});

type RouteParams = { params: Promise<{ id: string; agentId: string }> };

export async function GET(request: NextRequest, { params }: RouteParams) {
  const user = await requireAuth(request);
  if (isAuthError(user)) return user;

  const { id: projectId, agentId: agentName } = await params;

  const access = await requireProjectAccess(projectId, user);
  if (isAccessError(access)) return access;

  try {
    // agentId param is actually the agent name from the URL
    const agent = await findProjectAgent(
      projectId,
      decodeURIComponent(agentName),
      access.project.tenantId,
    );
    if (!agent) {
      return NextResponse.json({ error: 'Agent not found' }, { status: 404 });
    }

    return NextResponse.json({ agent });
  } catch (error) {
    console.error('[Projects] Get agent error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

export async function PATCH(request: NextRequest, { params }: RouteParams) {
  const user = await requireAuth(request);
  if (isAuthError(user)) return user;

  const { id, agentId } = await params;
  const agentName = decodeURIComponent(agentId);

  const access = await requireProjectAccess(id, user);
  if (isAccessError(access)) return access;

  const perm = await checkAgentPermission(id, agentName, user, access.project, 'edit');
  if (!perm.allowed)
    return perm.response ?? NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  const body = await request.json();
  const result = updateAgentSchema.safeParse(body);

  if (!result.success) {
    return NextResponse.json(
      { error: 'Invalid request', details: result.error.issues },
      { status: 400 },
    );
  }

  try {
    const existing = await findProjectAgent(id, agentName, access.project.tenantId);
    if (!existing) {
      return NextResponse.json({ error: 'Agent not found' }, { status: 404 });
    }

    const updateInput = { ...result.data };
    const promptRefChanged = Object.prototype.hasOwnProperty.call(
      updateInput,
      'systemPromptLibraryRef',
    );

    if (updateInput.systemPromptLibraryRef) {
      const documentWithRef = {
        systemPromptLibraryRef: { ...updateInput.systemPromptLibraryRef },
      };
      await resolvePromptLibraryRefOnDocument(documentWithRef, {
        tenantId: access.project.tenantId,
        projectId: id,
      });
      updateInput.systemPromptLibraryRef = {
        ...updateInput.systemPromptLibraryRef,
        ...(documentWithRef.systemPromptLibraryRef.resolvedHash
          ? { resolvedHash: documentWithRef.systemPromptLibraryRef.resolvedHash }
          : {}),
      };
    }

    const agent = await updateAgent(existing.id, updateInput, access.project.tenantId);
    if (promptRefChanged) {
      await refreshPersistedStudioProjectAgentDraftMetadata({
        projectId: id,
        tenantId: access.project.tenantId,
      });
    }

    await logAuditEvent({
      userId: user.id,
      tenantId: access.project.tenantId,
      action: AuditActions.AGENT_UPDATED,
      ip: request.headers.get('x-forwarded-for') || undefined,
      userAgent: request.headers.get('user-agent') || undefined,
      metadata: {
        projectId: id,
        resourceType: 'agent',
        resourceId: agent.id,
        agentId: agent.id,
        previousAgentName: existing.name,
        agentName: agent.name,
        changes: result.data,
      },
    });

    return NextResponse.json(agent);
  } catch (error) {
    if (error instanceof AppError) {
      return NextResponse.json(
        { error: error.message, code: error.code },
        { status: error.statusCode },
      );
    }
    console.error('[Projects] Update agent error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

export async function DELETE(request: NextRequest, { params }: RouteParams) {
  const user = await requireAuth(request);
  if (isAuthError(user)) return user;

  const { id, agentId } = await params;
  const agentName = decodeURIComponent(agentId);

  const access = await requireProjectAccess(id, user);
  if (isAccessError(access)) return access;

  const perm = await checkAgentPermission(id, agentName, user, access.project, 'delete');
  if (!perm.allowed)
    return perm.response ?? NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  try {
    const existing = await findProjectAgent(id, agentName, access.project.tenantId);
    if (!existing) {
      return NextResponse.json({ error: 'Agent not found' }, { status: 404 });
    }

    if (access.project.entryAgentName === existing.name) {
      await updateProjectConfig(id, { entryAgentName: null }, access.project.tenantId);
    }

    await removeAgentFromProject(existing.id, access.project.tenantId);

    await logAuditEvent({
      userId: user.id,
      tenantId: access.project.tenantId,
      action: AuditActions.AGENT_REMOVED,
      ip: request.headers.get('x-forwarded-for') || undefined,
      userAgent: request.headers.get('user-agent') || undefined,
      metadata: {
        projectId: id,
        resourceType: 'agent',
        resourceId: existing.id,
        agentId: existing.id,
        agentName,
      },
    });

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('[Projects] Remove agent error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
