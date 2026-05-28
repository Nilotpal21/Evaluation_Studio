/**
 * POST /api/arch-ai/sessions/:id/cancel — Cancel an in-progress session turn (NEW in v4)
 *
 * Signals the TurnEngine to abort the current generation pass for the given session
 * by setting cancelRequested: true on the session document. The TurnEngine polls
 * this flag at every tool boundary (engine-factory.ts cancelRequestedRead) and
 * emits turn_ended with reason:'canceled' when detected.
 *
 * The session remains accessible after cancel; the client can resume or send a new message.
 *
 * Source of truth: docs/superpowers/specs/2026-04-18-arch-v4-design.md
 */

import { NextRequest, NextResponse } from 'next/server';
import { createLogger } from '@abl/compiler/platform/logger.js';
import { requireTenantAuth, isAuthError } from '@/lib/auth';
import { errorJson } from '@/lib/api-response';
import { SessionService } from '@agent-platform/arch-ai';
import { ArchSessionModel } from '@agent-platform/arch-ai/models';

export const runtime = 'nodejs';

const log = createLogger('api:arch-ai:sessions:[id]:cancel');

const sessionService = new SessionService(ArchSessionModel);

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const auth = await requireTenantAuth(request);
    if (isAuthError(auth)) return auth;

    const { id: sessionId } = await params;

    if (!sessionId || typeof sessionId !== 'string' || sessionId.trim().length === 0) {
      return errorJson('Session ID is required', 400, 'INVALID_INPUT');
    }

    const ctx = { tenantId: auth.tenantId, userId: auth.id };

    // Verify session exists and belongs to this user.
    // getById scopes to (tenantId + userId) — returns null if not found or not owned.
    // Return 404 (not 403) to avoid leaking session existence to other users.
    const session = await sessionService.getById(ctx, sessionId);
    if (!session) {
      return errorJson('Session not found', 404, 'SESSION_NOT_FOUND');
    }

    // Set the cancelRequested flag. The TurnEngine polls this between tool iterations
    // and will emit turn_ended(reason:'canceled') on next detection, then clear the flag.
    // Non-op if the session is already ARCHIVED (turn has already ended).
    await sessionService.setCancelRequested(ctx, sessionId, true);

    log.info('Cancel requested', {
      sessionId,
      userId: auth.id,
      tenantId: auth.tenantId,
      sessionState: session.state,
    });

    return NextResponse.json({ ok: true });
  } catch (err: unknown) {
    log.error('Cancel route error', {
      error: err instanceof Error ? err.message : String(err),
    });
    return errorJson('An unexpected error occurred', 500, 'INTERNAL_ERROR');
  }
}
