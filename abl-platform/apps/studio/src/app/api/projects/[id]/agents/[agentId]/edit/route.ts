/**
 * POST /api/projects/:id/agents/:agentId/edit
 *
 * Surgical section edits — modify specific ABL sections without rewriting the entire file.
 * Used by AI tools and the studio editor for targeted changes.
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireAuth, isAuthError } from '@/lib/auth';
import { requireProjectAccess, isAccessError } from '@/lib/project-access';
import { checkAgentPermission } from '@/lib/agent-permission';
import { ensureConnected, ProjectAgent } from '@agent-platform/database/models';
import { validateProjectAgentDraftDeclaredName } from '@agent-platform/project-io/project-agent-draft-metadata';
import { spliceSections } from '@agent-platform/project-io/diff';
import { diffABL } from '@agent-platform/project-io/diff';
import { createLogger } from '@abl/compiler/platform/logger.js';
import { diagnosticsToStudioDslRecords, validateDslDraft } from '@/lib/abl/draft-validation';
import { updateProjectAgent } from '@/repos/project-repo';

const log = createLogger('api:agents:edit');

type RouteParams = { params: Promise<{ id: string; agentId: string }> };
const INVALID_SECTION_EDIT_CODE = 'INVALID_SECTION_EDIT';
const INVALID_SECTION_EDIT_MESSAGE =
  'The visual editor could not save these changes because they produced invalid ABL. Open the ABL editor to review the generated content.';

function normalizeUpdatedAt(value: Date | string | null | undefined): string {
  if (typeof value === 'string') return value;
  if (value instanceof Date) return value.toISOString();
  return new Date().toISOString();
}

export async function POST(request: NextRequest, { params }: RouteParams) {
  const user = await requireAuth(request);
  if (isAuthError(user)) return user;

  const { id: projectId, agentId: agentName } = await params;
  const access = await requireProjectAccess(projectId, user);
  if (isAccessError(access)) return access;

  const perm = await checkAgentPermission(
    projectId,
    decodeURIComponent(agentName),
    user,
    access.project,
    'edit',
  );
  if (!perm.allowed)
    return perm.response ?? NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  const tenantId = access.project.tenantId;

  let body: {
    edits?: Array<{ section: string; content: string | null }>;
    persist?: boolean;
  };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  if (!body.edits || !Array.isArray(body.edits) || body.edits.length === 0) {
    return NextResponse.json({ error: 'edits array is required' }, { status: 400 });
  }

  const shouldPersist = body.persist !== false; // default true

  try {
    await ensureConnected();

    const agent = await ProjectAgent.findOne({ projectId, tenantId, name: agentName });
    if (!agent) {
      return NextResponse.json({ error: 'Agent not found' }, { status: 404 });
    }

    const originalContent = agent.dslContent ?? '';

    // Apply surgical edits
    const editedContent = spliceSections(
      originalContent,
      body.edits.map((e) => ({ section: e.section, content: e.content })),
    );

    const declaredNameValidation = validateProjectAgentDraftDeclaredName({
      recordName: agent.name ?? agentName,
      dslContent: editedContent,
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

    // Compute section-aware diff
    const diff = diffABL(originalContent, editedContent);

    let diagnostics;
    try {
      diagnostics = await validateDslDraft({
        agentName,
        dslContent: editedContent,
        projectId,
        tenantId,
      });
    } catch (error) {
      log.error('Surgical edit validation failed', {
        projectId,
        agentName,
        error: error instanceof Error ? error.message : String(error),
      });
      return NextResponse.json({ error: 'Failed to validate edits' }, { status: 500 });
    }

    if (diagnostics.status === 'error') {
      return NextResponse.json(
        {
          success: false,
          error: {
            code: INVALID_SECTION_EDIT_CODE,
            message: INVALID_SECTION_EDIT_MESSAGE,
          },
          errors: diagnostics.errors.map((message) => ({
            code: INVALID_SECTION_EDIT_CODE,
            msg: message,
          })),
          diagnostics,
        },
        { status: 422 },
      );
    }

    let updatedAt = normalizeUpdatedAt(agent.updatedAt);

    // Persist to database when requested (default)
    if (shouldPersist) {
      const updated = await updateProjectAgent(
        String(agent._id),
        {
          dslContent: editedContent,
          lastEditedBy: user.id,
          lastEditedAt: new Date(),
          dslValidationStatus: diagnostics.status,
          dslDiagnostics: diagnosticsToStudioDslRecords(diagnostics),
        },
        tenantId,
      );
      if (!updated) {
        return NextResponse.json({ error: 'Agent not found' }, { status: 404 });
      }
      updatedAt = normalizeUpdatedAt(updated?.updatedAt);
    }

    return NextResponse.json({
      success: true,
      dslContent: editedContent,
      diff,
      diagnostics,
      updatedAt,
    });
  } catch (error) {
    log.error('Surgical edit failed', {
      projectId,
      agentName,
      error: error instanceof Error ? error.message : String(error),
    });
    return NextResponse.json({ error: 'Failed to apply edits' }, { status: 500 });
  }
}
