/**
 * POST /api/arch-ai/sessions/:id/archive — Archive a session
 * Contract 1: Response { ok: true }
 */

import { NextRequest } from 'next/server';
import { createLogger } from '@abl/compiler/platform/logger.js';
import { requireTenantAuth, isAuthError } from '@/lib/auth';
import { successJson, errorJson, handleApiError } from '@/lib/api-response';
import { ArchJournal } from '@agent-platform/database/models';
import {
  SessionService,
  JournalService,
  SessionNotFoundError,
  SessionArchivedError,
  InvalidTransitionError,
} from '@agent-platform/arch-ai';
import { ArchSessionModel } from '@agent-platform/arch-ai/models';

const log = createLogger('api:arch-ai:sessions:[id]:archive');

const sessionService = new SessionService(ArchSessionModel);
const journalService = new JournalService(ArchJournal);

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const auth = await requireTenantAuth(request);
    if (isAuthError(auth)) return auth;
    const { id } = await params;

    const ctx = { tenantId: auth.tenantId, userId: auth.id };

    await sessionService.archive(ctx, id);
    await journalService.archiveSession(ctx, id);

    log.info('Session archived', { sessionId: id, userId: auth.id });

    return successJson('ok', true);
  } catch (err: unknown) {
    if (err instanceof SessionNotFoundError) {
      return errorJson('Session not found', 404, 'SESSION_NOT_FOUND');
    }
    if (err instanceof SessionArchivedError) {
      return errorJson('Session is already archived', 409, 'SESSION_ARCHIVED');
    }
    if (err instanceof InvalidTransitionError) {
      return errorJson('Cannot archive session in current state', 409, 'INVALID_TRANSITION');
    }
    return handleApiError(err, 'arch-ai');
  }
}
