/**
 * Channel Trace Utilities
 *
 * Lightweight helpers for emitting trace events from HTTP/WS channel handlers
 * that don't have a full TraceEmitter instance (WS-backed).
 */

import crypto from 'crypto';
import { createLogger } from '@abl/compiler/platform';
import { getCurrentTraceId } from '@abl/compiler/platform/observability';
import { getEventStore } from './eventstore-singleton.js';
import { getSharedSTRBuffer } from '@agent-platform/shared-observability/sti';
import { getSTRWriter } from './tracing/str-writer-singleton.js';
import { getTraceStore } from './trace-store.js';
import { emitToEventStore } from './trace/emit-to-eventstore.js';
import type { RuntimeSession } from './execution/types.js';
import type { TraceEventType, TraceEventWithId } from '../types/index.js';

const log = createLogger('channel-trace');

export interface SyntheticChannelTraceEvent {
  type: string;
  data: Record<string, unknown>;
}

/**
 * Persist a synthetic trace event for channel-managed outcomes such as
 * auth-preflight blocks or transport-level timeout/error fallbacks.
 */
export function recordSyntheticTraceEvent(params: {
  sessionId?: string;
  session?: Pick<RuntimeSession, 'tracer' | 'knownSource'>;
  tenantId?: string;
  projectId?: string;
  traceId?: string;
  agentName?: string;
  knownSource?: 'production' | 'eval' | 'synthetic';
  event?: SyntheticChannelTraceEvent;
}): void {
  if (!params.event) {
    return;
  }

  try {
    if (params.session?.tracer) {
      params.session.tracer.emit({
        type: params.event.type,
        data: params.event.data,
      });
      return;
    }

    if (!params.sessionId) {
      return;
    }

    const storedTraceEvent: TraceEventWithId = {
      id: crypto.randomUUID(),
      sessionId: params.sessionId,
      type: params.event.type as TraceEventType,
      timestamp: new Date(),
      data: params.event.data,
      ...(params.traceId && { traceId: params.traceId }),
    };
    getTraceStore().addEvent(params.sessionId, storedTraceEvent);

    const eventStore = getEventStore();
    if (eventStore && params.tenantId) {
      emitToEventStore({
        eventStore,
        event: {
          id: storedTraceEvent.id,
          type: params.event.type,
          sessionId: params.sessionId,
          traceId: params.traceId,
          tenantId: params.tenantId,
          projectId: params.projectId,
          agentName: params.agentName,
          timestamp: storedTraceEvent.timestamp,
          durationMs:
            typeof params.event.data.durationMs === 'number' ? params.event.data.durationMs : 0,
          spanId: storedTraceEvent.id,
          data: params.event.data,
        },
        knownSource: params.knownSource ?? params.session?.knownSource,
      });
    }
  } catch (err) {
    log.warn('Failed to record synthetic channel trace event', {
      sessionId: params.sessionId,
      eventType: params.event.type,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Emit a `channel_response_sent` trace event after a channel handler sends its response.
 * This marks the exit boundary of a request and is used for STI flush triggers in Phase 4.
 *
 * Fires to EventStore (ClickHouse) only — no WebSocket emission needed for HTTP channels.
 */
export function emitChannelResponseSent(
  sessionId: string,
  channel: string,
  durationMs: number,
  opts?: {
    tenantId?: string;
    projectId?: string;
    traceId?: string;
    configHash?: string;
    knownSource?: 'production' | 'eval' | 'synthetic';
  },
): void {
  try {
    const eventStore = getEventStore();
    if (!eventStore) return;

    const traceId = opts?.traceId || getCurrentTraceId();

    eventStore.emitter.emit({
      event_id: crypto.randomUUID(),
      event_type: 'channel.response.sent',
      category: 'channel',
      tenant_id: opts?.tenantId ?? '',
      project_id: opts?.projectId ?? '',
      session_id: sessionId,
      known_source: opts?.knownSource ?? 'production',
      timestamp: new Date(),
      duration_ms: durationMs,
      has_error: false,
      data: {
        channel,
        channel_type: channel,
        channelType: channel,
        latency_ms: durationMs,
        latencyMs: durationMs,
        status: 'sent',
        ...(opts?.configHash && { config_hash: opts.configHash }),
      },
      ...(traceId && { trace_id: traceId }),
    });

    // STI flush trigger: drain the per-trace STR buffer and write to ClickHouse.
    // Fire-and-forget — never block the channel response.
    if (traceId) {
      try {
        const buffer = getSharedSTRBuffer();
        const entries = buffer.flush(traceId);
        const strWriter = getSTRWriter();
        if (strWriter && entries.length > 0) {
          strWriter.flush(
            entries,
            {
              tenantId: opts?.tenantId ?? '',
              projectId: opts?.projectId ?? '',
              traceId,
              sessionId,
            },
            {
              onSuccess: () => buffer.reportFlushSuccess(),
              onFailure: () => buffer.reportFlushFailure(),
            },
          );
        }
      } catch {
        // STR flush is best-effort — never block channel response
      }
    }
  } catch (err) {
    log.warn('Failed to emit channel_response_sent', {
      sessionId,
      channel,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
