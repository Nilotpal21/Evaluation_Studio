/**
 * GET /api/arch-ai/sessions/:id/journal — Get journal entries
 * Contract 1: Query { phase?, type? }, Response { entries: JournalEntry[] }
 */

import { NextRequest } from 'next/server';
import { createLogger } from '@abl/compiler/platform/logger.js';
import { requireTenantAuth, isAuthError } from '@/lib/auth';
import { requireProjectAccess, isAccessError } from '@/lib/project-access';
import { successJson, handleApiError } from '@/lib/api-response';
import { ArchJournal } from '@agent-platform/database/models';
import { JournalService } from '@agent-platform/arch-ai';
import type { JournalEntryType } from '@agent-platform/arch-ai';

const log = createLogger('api:arch-ai:sessions:[id]:journal');

const journalService = new JournalService(ArchJournal);

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const auth = await requireTenantAuth(request);
    if (isAuthError(auth)) return auth;
    const { id } = await params;

    const url = new URL(request.url);
    const phase = url.searchParams.get('phase') ?? undefined;
    const type = (url.searchParams.get('type') as JournalEntryType) ?? undefined;
    const projectId = url.searchParams.get('projectId') ?? undefined;

    // Project-scoped queries require project membership verification.
    // journalService.query drops userId when projectId is provided, so we
    // must verify the caller has access to the project before querying.
    if (projectId) {
      const access = await requireProjectAccess(projectId, auth);
      if (isAccessError(access)) return access;
    }

    // If projectId was passed, `requireProjectAccess` above already ran — pass
    // `unsafeProjectScope` to unlock the project-wide query path in JournalService.
    // Without projectId, the query falls back to the user-scoped path automatically.
    const entries = await journalService.query(
      { tenantId: auth.tenantId, userId: auth.id },
      projectId
        ? { sessionId: id, projectId, phase, type, unsafeProjectScope: true }
        : { sessionId: id, phase, type },
    );

    return successJson('entries', entries);
  } catch (err: unknown) {
    return handleApiError(err, 'arch-ai');
  }
}
