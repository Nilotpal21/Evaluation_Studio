/**
 * POST /api/arch-ai/message — Send message to coordinator, get SSE stream back
 * Contract 1 (api-index): Request MessageRequest, Response ReadableStream (SSE)
 * Contract 13 (execution-model): Coordinator → SpecialistExecutor → LLM Client
 */

import { randomUUID } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';

// Force dynamic rendering — prevents Next.js from buffering the SSE stream.
// Without this, the ReadableStream response is buffered and the client
// receives all events at once after the stream closes, causing the chat
// to appear frozen during streaming.
// Next.js route segment config must use a literal value, not a shared constant.
export const maxDuration = 300; // seconds - matches ARCH_AI_TIMEOUTS.ROUTE_MAX_DURATION
export const dynamic = 'force-dynamic';
import { createLogger } from '@abl/compiler/platform/logger.js';
import { requireTenantAuth, isAuthError } from '@/lib/auth';
import { requireProjectAccess, isAccessError } from '@/lib/project-access';
import {
  isProjectPermissionError,
  resolveEffectiveProjectScopedPermissions,
  resolveProjectPermissionContext,
} from '@/lib/project-permission';
import { errorJson } from '@/lib/api-response';
import {
  MessageRequestSchema,
  AuditLogEmitter,
  SessionNotFoundError,
  SessionBusyError,
  InvalidTransitionError,
  redactAuditPayloadContent,
} from '@agent-platform/arch-ai';
import {
  acquireTurnLock,
  releaseTurnLock,
  startRenewalLoop,
} from '@agent-platform/arch-ai/session';
import { createSSEStream } from '@/lib/arch-ai/sse-stream';
import { fileStoreService, sessionService } from '@/lib/arch-ai/message-services';
import { ARCH_AI_BUILD, ARCH_AI_TIMEOUTS } from '@/lib/arch-ai/constants';
import { createObservedArchStream } from '@/lib/arch-ai/stream-observer';
import { logArchTimeline } from '@/lib/arch-ai/request-timing';
import { getStudioArchAuditPipelineWriter } from '@/lib/arch-audit-pipeline-writer';
import { validateArchFileRefsReady } from '@/lib/arch-ai/attachment-readiness';
import {
  isAbortError,
  isTimeoutAbort,
  createAbortSignal,
  transitionSessionToIdle,
  closeAndResetIfActive,
} from '@/lib/arch-ai/helpers/session-helpers';
import { getRedisClient } from '@/lib/redis-client';
import type { MessageRequest } from '@agent-platform/arch-ai';
import { processInProjectMessage } from '@/lib/arch-ai/processors/process-in-project';
import { processMessage } from '@agent-platform/arch-ai';
import { studioProcessMessageDeps } from '@/lib/arch-ai/processors/process-message-deps';

const log = createLogger('api:arch-ai:message');

export async function POST(request: NextRequest) {
  let lockOwner: { redis: any; sessionId: string; workerId: string } | null = null;
  try {
    const requestStartedAt = Date.now();
    const auth = await requireTenantAuth(request);
    if (isAuthError(auth)) return auth;

    const body = await request.json();
    const parsed = MessageRequestSchema.safeParse(body);
    if (!parsed.success) {
      return errorJson(parsed.error.errors.map((e) => e.message).join(', '), 400, 'INVALID_INPUT');
    }

    const msg = parsed.data as MessageRequest;

    const ctx = { tenantId: auth.tenantId, userId: auth.id, permissions: auth.permissions };
    let activatedForThisRequest = false;

    // Load session
    let session = await sessionService.getById(ctx, msg.sessionId);
    if (!session) {
      return errorJson('Session not found', 404, 'SESSION_NOT_FOUND');
    }

    if (session.state === 'ARCHIVED') {
      return errorJson('Cannot operate on an archived session', 409, 'SESSION_ARCHIVED');
    }

    let pendingKindOnEntry = (
      session.metadata?.pendingInteraction as { kind?: string } | null | undefined
    )?.kind;
    const redis = getRedisClient();

    if (session.state === 'ACTIVE' && pendingKindOnEntry == null && redis) {
      try {
        const lockTtlMs = await redis.pttl(`arch:session:${session.id}:turn_lock`);
        if (lockTtlMs <= 0) {
          await transitionSessionToIdle(
            sessionService,
            ctx,
            session.id,
            'stale_active_without_turn_lock',
          );
          session = (await sessionService.getById(ctx, msg.sessionId)) ?? session;
          pendingKindOnEntry = (
            session.metadata?.pendingInteraction as { kind?: string } | null | undefined
          )?.kind;
          log.warn('arch_ai.session_recovered_stale_active_without_lock', {
            sessionId: session.id,
            userId: auth.id,
            messageType: msg.type,
            lockTtlMs,
          });
        }
      } catch (staleCheckErr: unknown) {
        log.warn('arch_ai.session_stale_active_check_failed', {
          sessionId: session.id,
          userId: auth.id,
          error: staleCheckErr instanceof Error ? staleCheckErr.message : String(staleCheckErr),
        });
      }
    }

    // The TurnEngine's interactive-tool path may leave the session in 'gate_pending'
    // (lowercase, written by buffer.patchSession) OR 'ACTIVE' (gate-free widget path).
    // Treat both as equivalent "session paused on widget" for the bypass check.
    const isInteractivePauseState =
      session.state === 'ACTIVE' ||
      session.state === 'GATE_PENDING' ||
      (session.state as string) === 'gate_pending';
    const isWidgetBypassMessage =
      isInteractivePauseState && pendingKindOnEntry === 'widget' && msg.type === 'message';
    const isProposalReviewBypassMessage =
      isInteractivePauseState &&
      pendingKindOnEntry === 'widget' &&
      msg.type === 'proposal_response' &&
      (session.metadata.pendingMutation != null ||
        session.metadata.pendingPlan?.status === 'proposed');

    // SESSION_BUSY guard: reject new user messages when session is already ACTIVE
    // or paused on an interactive tool (gate_pending / GATE_PENDING).
    // tool_answer and gate_response MUST pass through in all paused states.
    // 'create' MUST pass through too — the deterministic finalize-project path
    // is the equivalent of clicking "Create Project" in the browser, which the
    // browser allows even while a confirmation widget is pending. The handler
    // below clears any stale pendingInteraction before invoking finalizeProject.
    // isWidgetBypassMessage allows a plain 'message' to bypass a widget prompt.
    if (
      isInteractivePauseState &&
      msg.type !== 'tool_answer' &&
      msg.type !== 'gate_response' &&
      msg.type !== 'create' &&
      !isWidgetBypassMessage &&
      !isProposalReviewBypassMessage
    ) {
      // BUILD phase holds the session ACTIVE across many parallel streamText
      // workers. A user-visible "error" here is misleading — nothing is wrong,
      // Arch is just still building. Emit a distinct code (SESSION_BUILDING)
      // so the client can render a soft "still building…" banner instead of
      // the red SESSION_BUSY error.
      const buildStage = (session.metadata as { buildProgress?: { stage?: string } } | undefined)
        ?.buildProgress?.stage;
      if (buildStage === 'generating') {
        log.warn('arch_ai.session_building', { sessionId: session.id, userId: auth.id });
        return errorJson(
          'Arch is still building your agents — one moment.',
          409,
          'SESSION_BUILDING',
        );
      }
      log.warn('arch_ai.session_busy', { sessionId: session.id, userId: auth.id });
      throw new SessionBusyError();
    }

    if (msg.type === 'proposal_response' && session.metadata.mode !== 'IN_PROJECT') {
      return errorJson(
        'Proposal review actions are only supported in in-project mode.',
        400,
        'INVALID_MODE',
      );
    }

    // Verify caller has access to the session's project (cross-project auth gate)
    if (session.metadata.mode === 'IN_PROJECT' && session.metadata.projectId) {
      const access = await requireProjectAccess(session.metadata.projectId, auth);
      if (isAccessError(access)) return access;

      const projectPermissionContext = await resolveProjectPermissionContext(
        session.metadata.projectId,
        auth,
        { project: access.project },
      );
      if (isProjectPermissionError(projectPermissionContext)) return projectPermissionContext;

      ctx.permissions = resolveEffectiveProjectScopedPermissions(projectPermissionContext);
    }

    if (msg.type === 'message') {
      const attachmentReadiness = await validateArchFileRefsReady({
        fileStore: fileStoreService,
        ctx,
        sessionId: session.id,
        fileRefs: msg.fileRefs,
      });
      if (!attachmentReadiness.ok) {
        const { status, code, message } = attachmentReadiness.failure;
        return errorJson(message, status, code);
      }
    }

    // Transition IDLE → ACTIVE when starting a new unit of work.
    // 'create' is included because the Create Project handler needs the session
    // in ACTIVE state to perform the ACTIVE → COMPLETE → ARCHIVED transitions.
    // Without this, sessions left in IDLE after BUILD phase completion
    // fail with "Invalid transition: ACTIVE → COMPLETE".
    // tool_answer and gate_response are added so that a session that somehow
    // ended up IDLE (e.g. defensive idle reset after timeout) can still receive
    // an interactive response without a 409.
    //
    // The transitionState call is already atomic (findOneAndUpdate with
    // state:'IDLE' precondition). If another request moved the session to
    // ACTIVE first, it throws InvalidTransitionError — we re-throw as
    // SessionBusyError so the client gets the correct 409 SESSION_BUSY code.
    if (
      session.state === 'IDLE' &&
      (msg.type === 'message' ||
        msg.type === 'proposal_response' ||
        msg.type === 'create' ||
        msg.type === 'tool_answer' ||
        msg.type === 'gate_response')
    ) {
      try {
        await sessionService.transitionState(ctx, session.id, 'IDLE', 'ACTIVE');
        activatedForThisRequest = true;
      } catch (transitionErr: unknown) {
        if (transitionErr instanceof InvalidTransitionError) {
          throw new SessionBusyError();
        }
        throw transitionErr;
      }
    }

    const shouldResumeGateBypass =
      (session.state === 'GATE_PENDING' || (session.state as string) === 'gate_pending') &&
      msg.type === 'message';
    const shouldResumeInteractiveResponse =
      msg.type === 'tool_answer' || msg.type === 'gate_response';
    const shouldClearBypassedWidget =
      pendingKindOnEntry === 'widget' &&
      (msg.type === 'message' || msg.type === 'create' || msg.type === 'proposal_response');

    if (!redis) {
      if (activatedForThisRequest) {
        await transitionSessionToIdle(sessionService, ctx, session.id, 'redis_unavailable');
      }
      return errorJson('Service temporarily unavailable', 503, 'REDIS_UNAVAILABLE');
    }

    const workerId = `arch-ai-${randomUUID()}`;
    const lockResult = await acquireTurnLock(redis, session.id, workerId);
    if (!lockResult.acquired) {
      if (activatedForThisRequest) {
        await transitionSessionToIdle(sessionService, ctx, session.id, 'lock_contention');
      }
      return errorJson(
        'A response is already streaming for this session. Please wait.',
        409,
        'SESSION_BUSY',
      );
    }
    lockOwner = { redis, sessionId: session.id, workerId };

    // Do not mutate pendingInteraction until this request owns the session turn
    // lock. Otherwise a transient 409/lock contention can clear the persisted
    // widget while no handler runs, leaving reload with a stale chat card and no
    // server-side continuation context.
    if (shouldResumeGateBypass) {
      await sessionService.transitionStateAndClearPendingInteraction(
        ctx,
        session.id,
        'GATE_PENDING',
        'ACTIVE',
      );
    }

    // When an interactive-response arrives (tool_answer or gate_response),
    // reset the session back to ACTIVE and clear pendingInteraction atomically.
    //
    // The TurnEngine's interactive-tool path calls
    //   buffer.patchSession({ state: 'gate_pending' })    ← lowercase, legacy
    // before committing, so the session may be in 'gate_pending' (lowercase),
    // 'GATE_PENDING' (uppercase legacy), or 'ACTIVE' (gate-free widget path).
    // resumeFromInteractiveTool handles all three cases with a broad filter.
    if (shouldResumeInteractiveResponse) {
      await sessionService.resumeFromInteractiveTool(ctx, session.id);
    }

    // When user sends a new message while a widget (ask_user) prompt is still
    // pending, clear the widget so a reload doesn't resurrect the obsolete
    // prompt. 'create' (deterministic finalize) also clears the pending widget
    // so the post-creation completion card replaces the stale confirmation.
    if (shouldClearBypassedWidget) {
      await sessionService.setPendingInteraction(ctx, session.id, null);
    }

    // Create SSE stream
    const { stream, emit: rawEmit, emitRaw, close: rawClose } = createSSEStream();
    // Idempotent close guard — multiple error paths can race to close the stream
    // (e.g. client disconnect + LLM timeout + stream error). The underlying
    // ReadableStream controller throws on double-close, so we guard here.
    let streamClosed = false;
    const rawCloseGuard = () => {
      if (streamClosed) return;
      streamClosed = true;
      rawClose();
    };
    const auditSink =
      process.env.ARCH_AUDIT_LOG_ENABLED !== 'false'
        ? new AuditLogEmitter(
            { tenantId: auth.tenantId, userId: auth.id, sessionId: session.id },
            getStudioArchAuditPipelineWriter(),
          )
        : null;
    const clientRequestId = request.headers.get('x-arch-client-request-id')?.trim() || undefined;
    const streamObserver = createObservedArchStream({
      tenantId: auth.tenantId,
      userId: auth.id,
      sessionId: session.id,
      projectId: session.metadata.projectId,
      phase: session.metadata.phase,
      mode: session.metadata.mode,
      requestId: clientRequestId,
      startedAtMs: requestStartedAt,
      emit: rawEmit,
      close: rawCloseGuard,
      auditSink,
    });
    const requestId = streamObserver.requestId;
    const emit = streamObserver.emit;
    const close = streamObserver.close;

    // SSE heartbeat — keeps connection alive through proxies/load balancers.
    // Uses SSE comment format (`: heartbeat\n\n`) which is ignored by the parser.
    const heartbeatInterval = setInterval(() => {
      if (!streamClosed) {
        try {
          emitRaw(': heartbeat\n\n');
        } catch {
          clearInterval(heartbeatInterval);
        }
      } else {
        clearInterval(heartbeatInterval);
      }
    }, 15_000);

    // BUILD parallel gen needs a longer timeout (6 concurrent LLM calls)
    const isBuildPhase =
      session.metadata.phase === 'BUILD' && session.metadata.mode === 'ONBOARDING';
    const requestTimeoutMs = isBuildPhase
      ? ARCH_AI_BUILD.PARALLEL_GEN_TIMEOUT_MS
      : ARCH_AI_TIMEOUTS.TOOL_TOTAL_MS;
    const {
      signal: abortSignal,
      abort: abortStream,
      cleanup: cleanupAbortSignal,
    } = createAbortSignal(request.signal, requestTimeoutMs);
    const stopLockRenewal = startRenewalLoop(redis, session.id, workerId, () => {
      routeLog.warn('Arch AI turn lock lost during stream', {
        workerId,
        requestAborted: request.signal.aborted,
      });
      abortStream(new DOMException('worker_lost', 'AbortError'));
    });
    let clientDisconnected = false;

    // Route: IN_PROJECT uses multi-turn executor, ONBOARDING uses existing processMessage
    const isInProject = session.metadata.mode === 'IN_PROJECT';
    const routeLog = log.child({
      requestId,
      sessionId: session.id,
      phase: session.metadata.phase,
      mode: session.metadata.mode,
      messageType: msg.type,
    });
    logArchTimeline({
      timing: { requestId, requestStartedAt },
      log: routeLog.info.bind(routeLog),
      step: 'route_stream_opened',
      data: {
        pendingInteractionKind: pendingKindOnEntry ?? null,
        sessionState: session.state,
        clientRequestId: clientRequestId ?? null,
      },
    });
    if (isBuildPhase) {
      routeLog.info('Arch AI BUILD stream opened', {
        sessionState: session.state,
        pendingInteractionKind: pendingKindOnEntry ?? null,
        requestTimeoutMs,
      });
    }
    const handleClientAbort = () => {
      clientDisconnected = true;
      if (isBuildPhase) {
        routeLog.warn('Arch AI BUILD client disconnected during stream', {
          requestAborted: request.signal.aborted,
        });
      }
      void closeAndResetIfActive(sessionService, ctx, session.id, close, 'client_disconnect');
    };
    if (request.signal.aborted) {
      handleClientAbort();
    } else {
      request.signal.addEventListener('abort', handleClientAbort, { once: true });
    }

    // Capture user message as the first audit event for this request
    if (auditSink) {
      const textLength =
        msg.type === 'message'
          ? (msg.text ?? '').length
          : msg.type === 'tool_answer' && typeof msg.answer === 'string'
            ? msg.answer.length
            : msg.type === 'gate_response'
              ? (msg.feedback ?? '').length
              : 0;
      auditSink.emit({
        category: 'user_action',
        severity: 'info',
        summary: `User ${msg.type} received`,
        detail: { messageType: msg.type, textLength },
        phase: session.metadata.phase ?? undefined,
        projectId: session.metadata.projectId,
      });
      if (msg.type === 'message' && msg.text && msg.text.length > 0) {
        auditSink.emitPayload({
          eventId: requestId + '_user_input',
          payloadType: 'prompt',
          content: redactAuditPayloadContent(msg.text, { payloadType: 'prompt' }),
        });
      }
    }

    const messageTask = isInProject
      ? (() => {
          const authHeader = request.headers.get('authorization') ?? '';
          const userAuthToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : authHeader;
          return processInProjectMessage(
            ctx,
            session,
            msg,
            emit,
            close,
            userAuthToken,
            abortSignal,
            lockResult.fencingToken,
          );
        })()
      : (() => {
          const authHeader = request.headers.get('authorization') ?? '';
          const msgAuthToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : authHeader;
          return processMessage(
            ctx,
            session,
            msg,
            emit,
            close,
            abortSignal,
            msgAuthToken,
            {
              requestId,
              requestStartedAt,
            },
            lockResult.fencingToken,
            studioProcessMessageDeps,
          );
        })();

    void messageTask
      .catch(async (err: unknown) => {
        if (isAbortError(err, abortSignal)) {
          if (clientDisconnected || request.signal.aborted) {
            return;
          }

          if (isBuildPhase) {
            routeLog.warn('Arch AI BUILD stream aborted', {
              isTimeout: isTimeoutAbort(abortSignal),
              requestAborted: request.signal.aborted,
              abortReason:
                abortSignal.reason instanceof Error
                  ? abortSignal.reason.message
                  : String(abortSignal.reason ?? ''),
            });
          }
          logArchTimeline({
            timing: { requestId, requestStartedAt },
            log: routeLog.warn.bind(routeLog),
            step: 'route_stream_aborted',
            data: {
              isTimeout: isTimeoutAbort(abortSignal),
              requestAborted: request.signal.aborted,
              clientDisconnected,
            },
          });

          await transitionSessionToIdle(sessionService, ctx, session.id, 'request_timeout');
          emit({
            type: 'error',
            code: isTimeoutAbort(abortSignal) ? 'LLM_TIMEOUT' : 'STREAM_ABORTED',
            message: isTimeoutAbort(abortSignal)
              ? 'Arch AI timed out while generating a response. Please try again.'
              : 'The streaming request was interrupted.',
            retryable: true,
          });
          close();
          return;
        }

        const message = err instanceof Error ? err.message : String(err);
        await transitionSessionToIdle(
          sessionService,
          ctx,
          session.id,
          isInProject ? 'in_project_stream_error' : 'onboarding_stream_error',
        );
        routeLog.error(
          isInProject ? 'IN_PROJECT message processing failed' : 'Message processing failed',
          {
            error: message,
            clientDisconnected,
            requestAborted: request.signal.aborted,
          },
        );
        logArchTimeline({
          timing: { requestId, requestStartedAt },
          log: routeLog.error.bind(routeLog),
          step: 'route_stream_failed',
          data: {
            error: message,
            clientDisconnected,
            requestAborted: request.signal.aborted,
          },
        });
        emit({
          type: 'error',
          code: 'STREAM_ERROR',
          message: 'An unexpected error occurred. Please try again.',
          retryable: true,
        });
        close();
      })
      .finally(async () => {
        // Defensive: if session is still ACTIVE after stream ends, reset to IDLE.
        // This catches any error path that emitted an error event but forgot to
        // call transitionSessionToIdle, preventing permanently stuck sessions.
        try {
          const currentSession = await sessionService.getById(ctx, session.id);
          if (currentSession?.state === 'ACTIVE' && !currentSession?.metadata?.pendingInteraction) {
            await sessionService.transitionState(ctx, session.id, 'ACTIVE', 'IDLE');
            log.warn('arch_ai.session_defensive_idle', {
              sessionId: session.id,
              reason: 'finally_cleanup',
              phase: currentSession.metadata.phase,
              mode: currentSession.metadata.mode,
            });
          }
        } catch {
          // Best-effort — don't mask the original error
        }

        if (isBuildPhase) {
          routeLog.info('Arch AI BUILD stream cleanup complete', {
            streamClosed,
            clientDisconnected,
            requestAborted: request.signal.aborted,
          });
        }
        logArchTimeline({
          timing: { requestId, requestStartedAt },
          log: routeLog.info.bind(routeLog),
          step: 'route_stream_cleanup_complete',
          data: {
            streamClosed,
            clientDisconnected,
            requestAborted: request.signal.aborted,
          },
        });
        stopLockRenewal();
        if (lockOwner && lockOwner.sessionId === session.id && lockOwner.workerId === workerId) {
          try {
            await releaseTurnLock(lockOwner.redis, lockOwner.sessionId, lockOwner.workerId);
          } catch (lockErr: unknown) {
            routeLog.warn('Arch AI turn lock release failed', {
              error: lockErr instanceof Error ? lockErr.message : String(lockErr),
              workerId,
            });
          } finally {
            lockOwner = null;
          }
        }
        clearInterval(heartbeatInterval);
        request.signal.removeEventListener('abort', handleClientAbort);
        cleanupAbortSignal();
        try {
          await streamObserver.flush();
        } catch (auditErr: unknown) {
          routeLog.warn('Arch AI stream audit flush failed', {
            error: auditErr instanceof Error ? auditErr.message : String(auditErr),
          });
        }
      });

    return new NextResponse(stream as unknown as ReadableStream, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        'X-Arch-Request-ID': requestId,
      },
    });
  } catch (err: unknown) {
    if (err instanceof SessionNotFoundError) {
      return errorJson('Session not found', 404, 'SESSION_NOT_FOUND');
    }
    if (err instanceof SessionBusyError) {
      return errorJson(
        'A response is already streaming for this session. Please wait.',
        409,
        'SESSION_BUSY',
      );
    }
    if (err instanceof InvalidTransitionError) {
      // Thrown when a concurrent request already moved the session out of the
      // expected state (two browser tabs, mobile reconnect, auto-refresh race).
      // 409 Conflict is the correct HTTP semantics — the client should refresh
      // session state and retry rather than treat this as a 500.
      return errorJson(
        'Session state changed concurrently. Please refresh and retry.',
        409,
        'SESSION_STATE_CONFLICT',
      );
    }
    if (lockOwner) {
      try {
        await releaseTurnLock(lockOwner.redis, lockOwner.sessionId, lockOwner.workerId);
      } catch (lockErr: unknown) {
        log.warn('Arch AI turn lock release failed during route error cleanup', {
          error: lockErr instanceof Error ? lockErr.message : String(lockErr),
          sessionId: lockOwner.sessionId,
        });
      } finally {
        lockOwner = null;
      }
    }
    const message = err instanceof Error ? err.message : String(err);
    log.error('Message route error', { error: message });
    return errorJson('An unexpected error occurred. Please try again.', 500, 'STREAM_ERROR');
  }
}
