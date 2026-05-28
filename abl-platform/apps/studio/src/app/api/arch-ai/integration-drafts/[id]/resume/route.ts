/**
 * POST /api/arch-ai/integration-drafts/:id/resume — Cross-page handoff target.
 *
 * When the user clicks "Resume" on an integration card in the artifact panel
 * we run server-side:
 *  1. Set the chat session pointer (`metadata.activeIntegrationDraftId`) so
 *     subsequent specialist turns operate on this draft.
 *  2. Re-validate the draft against current platform state (no LLM round-trip)
 *     so the assistant's first message can show up-to-date drift / pending steps.
 *
 * Returns the normalized draft + revalidation result. The caller injects the
 * payload into the chat as the assistant's first message after navigation.
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireTenantAuth, isAuthError } from '@/lib/auth';
import { requireProjectAccess, isAccessError } from '@/lib/project-access';
import { actionJson, errorJson, handleApiError, ErrorCode } from '@/lib/api-response';
import { normalizeDraft, setSessionDraftPointer } from '@/lib/arch-ai/integration-draft-service';
import { executeIntegrationOps } from '@/lib/arch-ai/tools/integration-ops';

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const auth = await requireTenantAuth(request);
    if (isAuthError(auth)) return auth;
    const { id } = await params;

    const { ArchIntegrationDraft } = await import('@agent-platform/database/models');
    const draft = await ArchIntegrationDraft.findOne({
      _id: id,
      tenantId: auth.tenantId,
    }).lean();

    if (!draft) {
      return errorJson('Not found', 404, ErrorCode.NOT_FOUND);
    }

    const draftRecord = draft as { _id: string; projectId: string };
    const access = await requireProjectAccess(draftRecord.projectId, auth);
    if (isAccessError(access)) return access;

    let body: unknown = null;
    try {
      body = await request.json();
    } catch {
      body = null;
    }
    const sessionId =
      body && typeof body === 'object' && 'sessionId' in body
        ? (body as { sessionId?: unknown }).sessionId
        : undefined;

    if (typeof sessionId !== 'string' || sessionId.length === 0) {
      return errorJson('sessionId required', 400, ErrorCode.VALIDATION_ERROR);
    }

    await setSessionDraftPointer({
      tenantId: auth.tenantId,
      projectId: draftRecord.projectId,
      userId: auth.id,
      sessionId,
      draftId: String(draftRecord._id),
    });

    const authHeader = request.headers.get('authorization') ?? '';
    const authToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : authHeader;

    const revalidationResult = await executeIntegrationOps(
      { action: 'revalidate', draftId: String(draftRecord._id) },
      {
        projectId: draftRecord.projectId,
        sessionId,
        user: {
          tenantId: auth.tenantId,
          userId: auth.id,
          permissions: auth.permissions ?? [],
        },
        authToken,
      },
    );

    if (!revalidationResult.success) {
      const err = revalidationResult.error;
      const status = err?.code === 'FORBIDDEN' ? 403 : 400;
      return NextResponse.json(
        {
          success: false,
          error: err ?? { code: 'REVALIDATE_FAILED', message: 'Revalidation failed' },
        },
        { status },
      );
    }

    // Re-fetch the draft so we return the post-revalidation state (revalidate may
    // mutate status / pendingSteps).
    const refreshed = await ArchIntegrationDraft.findOne({
      _id: id,
      tenantId: auth.tenantId,
      projectId: draftRecord.projectId,
    }).lean();

    return actionJson({
      draft: normalizeDraft((refreshed ?? draft) as never),
      revalidation: revalidationResult.data,
    });
  } catch (err: unknown) {
    return handleApiError(err, 'arch-ai');
  }
}
