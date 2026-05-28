/**
 * PUT /api/projects/:id/agents/:agentId/dsl
 *
 * Save working copy DSL content for an agent (by name).
 * Note: agentId here is actually the agent's `name` (matches frontend URL routing).
 */

import { NextRequest, NextResponse } from 'next/server';
import { createLogger } from '@abl/compiler/platform/logger.js';
import { requireAuth, isAuthError } from '@/lib/auth';
import { requireProjectAccess, isAccessError } from '@/lib/project-access';
import { findProjectAgent, updateProjectAgent } from '@/repos/project-repo';
import { AuditActions, logAuditEvent } from '@/services/audit-service';
import {
  buildDslSaveDiagnostics,
  diagnosticsToStudioDslRecords,
  type DslSaveDiagnostics,
  validateDslDraft,
} from '@/lib/abl/draft-validation';
import { validateProjectAgentDraftDeclaredName } from '@agent-platform/project-io/project-agent-draft-metadata';

type RouteParams = { params: Promise<{ id: string; agentId: string }> };
const log = createLogger('api:projects:agent-dsl');

export async function PUT(request: NextRequest, { params }: RouteParams) {
  const user = await requireAuth(request);
  if (isAuthError(user)) return user;

  const { id: projectId, agentId: agentName } = await params;

  const access = await requireProjectAccess(projectId, user);
  if (isAccessError(access)) return access;

  let body: { dslContent?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const { dslContent } = body;
  if (typeof dslContent !== 'string' || !dslContent.trim()) {
    return NextResponse.json({ error: 'dslContent is required' }, { status: 400 });
  }

  try {
    const agent = await findProjectAgent(projectId, agentName, access.project.tenantId);
    if (!agent) {
      return NextResponse.json({ error: 'Agent not found' }, { status: 404 });
    }

    const declaredNameValidation = validateProjectAgentDraftDeclaredName({
      recordName: agent.name ?? agentName,
      dslContent,
    });
    if (!declaredNameValidation.ok) {
      return NextResponse.json(
        {
          error: declaredNameValidation.message,
          code: declaredNameValidation.code,
          recordName: declaredNameValidation.recordName,
          declaredName: declaredNameValidation.declaredName,
        },
        { status: 409 },
      );
    }

    let diagnostics: DslSaveDiagnostics;
    try {
      diagnostics = await validateDslDraft({
        agentName,
        dslContent,
        projectId,
        tenantId: access.project.tenantId,
      });
    } catch (error) {
      log.warn('DSL save validation failed; preserving draft', {
        projectId,
        agentName,
        error: error instanceof Error ? error.message : String(error),
      });
      diagnostics = buildDslSaveDiagnostics(
        [
          `Draft saved, but validation could not complete: ${
            error instanceof Error ? error.message : String(error)
          }`,
        ],
        [],
      );
    }
    const updated = await updateProjectAgent(
      agent.id,
      {
        dslContent,
        lastEditedBy: user.id,
        lastEditedAt: new Date(),
        dslValidationStatus: diagnostics.status,
        dslDiagnostics: diagnosticsToStudioDslRecords(diagnostics),
      },
      access.project.tenantId,
    );
    if (!updated) {
      return NextResponse.json({ error: 'Agent not found' }, { status: 404 });
    }

    await logAuditEvent({
      userId: user.id,
      tenantId: access.project.tenantId,
      action: AuditActions.AGENT_DSL_UPDATED,
      ip: request.headers.get('x-forwarded-for') || undefined,
      userAgent: request.headers.get('user-agent') || undefined,
      metadata: {
        projectId,
        resourceType: 'agent',
        resourceId: agent.id,
        agentId: agent.id,
        agentName: agent.name ?? agentName,
        validationStatus: diagnostics.status,
        errorCount: diagnostics.errors.length,
        warningCount: diagnostics.warnings.length,
        sourceHash: updated.sourceHash ?? null,
      },
    });

    return NextResponse.json({
      success: true,
      sourceHash: updated.sourceHash ?? null,
      diagnostics,
      updatedAt: updated.updatedAt ?? new Date().toISOString(),
    });
  } catch (error) {
    log.error('DSL save failed', {
      projectId,
      agentName,
      error: error instanceof Error ? error.message : String(error),
    });
    return NextResponse.json({ error: 'Failed to save ABL' }, { status: 500 });
  }
}
