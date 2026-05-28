/**
 * GET /api/arch-ai/sessions/current — Get current active session
 * Contract 1: Response { session: ArchSession } | null
 *
 * Query params:
 *   ?mode=ONBOARDING|IN_PROJECT — scope by session mode
 *   ?projectId=xxx             — scope IN_PROJECT sessions by project (requires mode=IN_PROJECT)
 *   ?threadId=xxx              — scope to a hidden client thread
 */

import { NextRequest } from 'next/server';
import { createLogger } from '@abl/compiler/platform/logger.js';
import { requireTenantAuth, isAuthError } from '@/lib/auth';
import { actionJson, errorJson, handleApiError } from '@/lib/api-response';
import { SessionService, buildResumeSnapshot } from '@agent-platform/arch-ai';
import { ArchSessionModel } from '@agent-platform/arch-ai/models';

const log = createLogger('api:arch-ai:sessions:current');

const sessionService = new SessionService(ArchSessionModel);

/**
 * ACTIVE sessions older than this are considered stuck and auto-archived on GET.
 * v4: 25 min — BUILD runs up to 20 min, so we need extra headroom (spec §11 Flow 4).
 */
const STUCK_ACTIVE_THRESHOLD_MS = 25 * 60 * 1000; // 1_500_000 ms

const VALID_MODES = ['ONBOARDING', 'IN_PROJECT'] as const;
type ArchMode = (typeof VALID_MODES)[number];
type SessionSurface = 'project' | 'agent-editor';

export async function GET(request: NextRequest) {
  try {
    const auth = await requireTenantAuth(request);
    if (isAuthError(auth)) return auth;

    const url = new URL(request.url);
    const modeParam = url.searchParams.get('mode');
    const projectIdParam = url.searchParams.get('projectId');
    const surfaceParam = url.searchParams.get('surface');
    const agentNameParam = url.searchParams.get('agentName');
    const threadIdParam = url.searchParams.get('threadId');

    // Validate mode if provided — reject invalid values
    let mode: ArchMode | undefined;
    if (modeParam) {
      if (!VALID_MODES.includes(modeParam as ArchMode)) {
        return errorJson(
          `Invalid mode: ${modeParam}. Must be ONBOARDING or IN_PROJECT`,
          400,
          'INVALID_INPUT',
        );
      }
      mode = modeParam as ArchMode;
    }

    // projectId only meaningful with mode=IN_PROJECT
    const projectId = mode === 'IN_PROJECT' ? (projectIdParam ?? undefined) : undefined;
    let scopeOptions:
      | { surface?: SessionSurface; agentName?: string; threadId?: string }
      | undefined;
    if (mode === 'IN_PROJECT' && surfaceParam) {
      if (surfaceParam !== 'project' && surfaceParam !== 'agent-editor') {
        return errorJson('Invalid surface', 400, 'INVALID_INPUT');
      }
      scopeOptions = { surface: surfaceParam, agentName: agentNameParam ?? undefined };
    }
    if (scopeOptions?.surface !== undefined && scopeOptions.surface !== 'project') {
      if (!scopeOptions.agentName) {
        return errorJson('agentName is required for agent-editor sessions', 400, 'INVALID_INPUT');
      }
    }
    if (scopeOptions?.surface !== 'agent-editor' && agentNameParam) {
      return errorJson('agentName is only valid for agent-editor sessions', 400, 'INVALID_INPUT');
    }
    if (threadIdParam !== null) {
      const threadId = threadIdParam.trim();
      if (threadId.length === 0) {
        return errorJson('threadId must not be empty', 400, 'INVALID_INPUT');
      }
      scopeOptions = { ...scopeOptions, threadId };
    }

    const ctx = { tenantId: auth.tenantId, userId: auth.id };
    let session = await sessionService.getCurrent(ctx, mode, projectId, scopeOptions);

    // Health check: auto-archive sessions stuck in ACTIVE for >25 minutes.
    // v4 uses 25 min to accommodate the BUILD phase (up to 20 min), per spec §11 Flow 4.
    // Complements the getOrCreate check (POST path) by also running on the
    // GET path, so polling clients self-heal stuck sessions without requiring
    // a new session creation attempt.
    if (session && session.state === 'ACTIVE') {
      const updatedAt = new Date(session.updatedAt).getTime();
      const activeAge = Date.now() - updatedAt;
      if (activeAge > STUCK_ACTIVE_THRESHOLD_MS) {
        const activeMinutes = Math.round(activeAge / 1000 / 60);
        log.warn('arch_ai.health_check_archived', {
          sessionId: session.id,
          activeMinutes,
        });
        try {
          await sessionService.transitionState(ctx, session.id, 'ACTIVE', 'ARCHIVED');
        } catch (err: unknown) {
          log.warn('Failed to archive stuck ACTIVE session during health check', {
            sessionId: session.id,
            error: err instanceof Error ? err.message : String(err),
          });
        }
        // Return null so the client starts fresh
        return actionJson({ session: null, resume: null });
      }
    }

    // GATE_PENDING cleanup: legacy sessions stuck in GATE_PENDING are
    // incompatible with the gate-free onboarding model. Auto-archive them
    // and return null so the client starts fresh.
    // Cast to string: GATE_PENDING was removed from SessionState type in
    // the gate-free redesign, but old DB records may still have this state.
    if (session && (session.state as string) === 'GATE_PENDING') {
      log.info('Auto-archiving GATE_PENDING session', { sessionId: session.id });
      try {
        // Direct GATE_PENDING→ARCHIVED (valid transition added for legacy cleanup)
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await sessionService.transitionState(ctx, session.id, session.state as any, 'ARCHIVED');
      } catch (err: unknown) {
        log.warn('Failed to archive GATE_PENDING session', {
          sessionId: session.id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
      return actionJson({ session: null, resume: null });
    }

    return actionJson({
      session,
      resume: session ? buildResumeSnapshot(session) : null,
    });
  } catch (err: unknown) {
    return handleApiError(err, 'arch-ai');
  }
}
