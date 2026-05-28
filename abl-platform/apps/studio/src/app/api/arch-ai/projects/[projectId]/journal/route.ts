/**
 * GET /api/arch-ai/projects/:projectId/journal — Project-scoped journal entries.
 *
 * Unlike the session-scoped route (/sessions/:id/journal), this route does NOT
 * require a sessionId. It returns all journal entries linked to the project,
 * regardless of which session created them. This is the correct endpoint for the
 * in-project JournalPanel, which mounts before a session exists.
 */

import { NextRequest } from 'next/server';
import { requireTenantAuth, isAuthError } from '@/lib/auth';
import { requireProjectAccess, isAccessError } from '@/lib/project-access';
import { successJson, handleApiError } from '@/lib/api-response';
import { ArchJournal } from '@agent-platform/database/models';
import { JournalService } from '@agent-platform/arch-ai';
import type { JournalEntryType } from '@agent-platform/arch-ai';

const journalService = new JournalService(ArchJournal);

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ projectId: string }> },
) {
  try {
    const auth = await requireTenantAuth(request);
    if (isAuthError(auth)) return auth;
    const { projectId } = await params;

    const access = await requireProjectAccess(projectId, auth);
    if (isAccessError(access)) return access;

    const url = new URL(request.url);
    const phase = url.searchParams.get('phase') ?? undefined;
    const type = (url.searchParams.get('type') as JournalEntryType) ?? undefined;

    // `requireProjectAccess` above verified membership; pass `unsafeProjectScope`
    // to unlock the project-wide query path in JournalService.
    const entries = await journalService.query(
      { tenantId: auth.tenantId, userId: auth.id },
      { projectId, phase, type, unsafeProjectScope: true },
    );

    return successJson('entries', entries);
  } catch (err: unknown) {
    return handleApiError(err, 'arch-ai');
  }
}
