/**
 * GET    /api/arch-ai/sessions/:id — Get session by ID
 * DELETE /api/arch-ai/sessions/:id — Delete session with cascade
 * Contract 1 (api-index)
 */

import { NextRequest } from 'next/server';
import { createLogger } from '@abl/compiler/platform/logger.js';
import { requireTenantAuth, isAuthError } from '@/lib/auth';
import { actionJson, successJson, errorJson, handleApiError } from '@/lib/api-response';
import { ArchJournal, ArchSpecDocument } from '@agent-platform/database/models';
import mongoose from 'mongoose';
import {
  SessionService,
  JournalService,
  SessionNotFoundError,
  buildResumeSnapshot,
  SpecDocumentService,
} from '@agent-platform/arch-ai';
import { ArchSessionModel } from '@agent-platform/arch-ai/models';

const log = createLogger('api:arch-ai:sessions:[id]');

const sessionService = new SessionService(ArchSessionModel);
const journalService = new JournalService(ArchJournal);

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const auth = await requireTenantAuth(request);
    if (isAuthError(auth)) return auth;
    const { id } = await params;

    const session = await sessionService.getById({ tenantId: auth.tenantId, userId: auth.id }, id);

    if (!session) {
      return errorJson('Session not found', 404, 'SESSION_NOT_FOUND');
    }

    return actionJson({
      session,
      resume: buildResumeSnapshot(session),
    });
  } catch (err: unknown) {
    return handleApiError(err, 'arch-ai');
  }
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const auth = await requireTenantAuth(request);
    if (isAuthError(auth)) return auth;
    const { id } = await params;

    const ctx = { tenantId: auth.tenantId, userId: auth.id };

    // Cascade: delete journal entries first, then session
    await journalService.deleteSession(ctx, id);

    // Delete spec doc only if not yet linked to a project (D9)
    try {
      const specDocSvc = new SpecDocumentService(
        ArchSpecDocument,
        ArchSessionModel,
        mongoose.connection,
      );
      await specDocSvc.deleteBySessionIfUnlinked(ctx, id);
    } catch (err: unknown) {
      log.warn('Failed to delete spec document', {
        sessionId: id,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    await sessionService.delete(ctx, id);

    log.info('Session deleted with cascade', { sessionId: id, userId: auth.id });

    return successJson('ok', true);
  } catch (err: unknown) {
    if (err instanceof SessionNotFoundError) {
      return errorJson('Session not found', 404, 'SESSION_NOT_FOUND');
    }
    return handleApiError(err, 'arch-ai');
  }
}
