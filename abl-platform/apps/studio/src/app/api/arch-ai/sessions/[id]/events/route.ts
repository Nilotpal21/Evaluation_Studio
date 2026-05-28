/**
 * GET /api/arch-ai/sessions/:id/events — SSE reconnect endpoint.
 *
 * Reads durable events from the Redis ring buffer since lastSeenSeq and streams
 * them as SSE frames. Emits a `snapshot_required` frame when the caller's
 * cursor is behind the buffer's retention window; the client then falls back
 * to GET /sessions/current.
 *
 * Source of truth: docs/superpowers/specs/2026-04-18-arch-v4-design.md §9.3
 *                  docs/superpowers/specs/2026-04-19-arch-v4-session-fix-design.md Task 8
 */

import { NextRequest } from 'next/server';
import { createLogger } from '@abl/compiler/platform/logger.js';
import { requireTenantAuth, isAuthError } from '@/lib/auth';
import { errorJson } from '@/lib/api-response';
import { getRedisClient, isRedisAvailable } from '@/lib/redis-client';
import {
  createRingBuffer,
  type RingBufferClient,
  type RingBufferEvent,
} from '@agent-platform/arch-ai/session';
import { SessionService } from '@agent-platform/arch-ai';
import { ArchSessionModel } from '@agent-platform/arch-ai/models';

export const runtime = 'nodejs';

const log = createLogger('api:arch-ai:sessions:[id]:events');

const sessionService = new SessionService(ArchSessionModel);

function sseFrame(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const auth = await requireTenantAuth(request);
    if (isAuthError(auth)) return auth;

    const { id: sessionId } = await params;
    const url = new URL(request.url);
    const lastSeenSeq = Number(url.searchParams.get('lastSeenSeq') ?? '-1');

    if (!sessionId || sessionId.trim().length === 0) {
      return errorJson('Session ID is required', 400, 'INVALID_INPUT');
    }
    if (!Number.isFinite(lastSeenSeq)) {
      return errorJson('lastSeenSeq must be a number', 400, 'INVALID_INPUT');
    }

    // Ownership check — 404 not 403 to avoid leaking existence.
    const ctx = { tenantId: auth.tenantId, userId: auth.id };
    const session = await sessionService.getById(ctx, sessionId);
    if (!session) {
      return errorJson('Session not found', 404, 'SESSION_NOT_FOUND');
    }

    const encoder = new TextEncoder();
    const redis = getRedisClient();
    const redisUp = isRedisAvailable() && redis != null;

    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        try {
          controller.enqueue(encoder.encode(': connected\n\n'));

          if (!redisUp) {
            // Redis unavailable — signal snapshot required so the client falls back.
            controller.enqueue(
              encoder.encode(sseFrame('snapshot_required', { reason: 'redis_unavailable' })),
            );
            return;
          }

          const rb = createRingBuffer({
            redis: redis as unknown as RingBufferClient,
            sizeLimit: 1000,
            ttlSeconds: 3600,
          });
          const result = await rb.readSince(sessionId, lastSeenSeq);

          if (result === 'SNAPSHOT_REQUIRED') {
            controller.enqueue(encoder.encode(sseFrame('snapshot_required', { lastSeenSeq })));
            return;
          }

          for (const e of result as RingBufferEvent[]) {
            controller.enqueue(encoder.encode(sseFrame(e.kind, e.payload)));
          }
        } catch (err: unknown) {
          log.error('SSE events stream error', {
            sessionId,
            error: err instanceof Error ? err.message : String(err),
          });
          controller.enqueue(encoder.encode(sseFrame('error', { code: 'EVENTS_STREAM_ERROR' })));
        } finally {
          controller.close();
        }
      },
    });

    log.info('SSE events stream opened', {
      sessionId,
      lastSeenSeq,
      userId: auth.id,
      tenantId: auth.tenantId,
    });

    return new Response(stream, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      },
    });
  } catch (err: unknown) {
    log.error('SSE events route error', {
      error: err instanceof Error ? err.message : String(err),
    });
    return errorJson('An unexpected error occurred', 500, 'INTERNAL_ERROR');
  }
}
