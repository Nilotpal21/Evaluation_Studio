import { createLogger } from '@abl/compiler/platform/logger.js';
import { checkToolPermission, type ToolPermissionContext } from '../guards';

const log = createLogger('arch-ai:trace-query');

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

// ─── Types ────────────────────────────────────────────────────────────────

export interface TraceQueryInput {
  agentName?: string;
  sessionId?: string;
  eventType?: string;
  eventTypes?: string[];
  severity?: 'debug' | 'info' | 'warn' | 'error';
  since?: string;
  until?: string;
  limit?: number;
  includeData?: boolean;
}

export interface ArchTraceEvent {
  id: string;
  type: string;
  agentName: string;
  timestamp: string;
  durationMs?: number;
  traceId?: string;
  spanId?: string;
  parentSpanId?: string;
  sessionId?: string;
  stepName?: string;
  severity?: string;
  error?: string;
  tags?: string[];
  data?: unknown;
}

interface TraceQueryResult {
  success: boolean;
  data?: { count: number; events: ArchTraceEvent[] };
  error?: { code: string; message: string };
}

// ─── Raw Document Shape (MongoDB) ─────────────────────────────────────────

export interface RawTraceDoc {
  _id?: unknown;
  type?: string;
  agentName?: string;
  timestamp?: string | Date;
  duration?: number;
  durationMs?: number;
  traceId?: string;
  spanId?: string;
  parentSpanId?: string;
  sessionId?: string;
  stepName?: string;
  metadata?: {
    severity?: string;
    tags?: string[];
    [key: string]: unknown;
  };
  error?: string;
  data?: unknown;
  [key: string]: unknown;
}

// ─── Pure Functions ───────────────────────────────────────────────────────

/**
 * Build a MongoDB filter object from the query input.
 * Always scopes by projectId and tenantId for tenant isolation.
 */
export function buildTraceFilter(
  projectId: string,
  tenantId: string,
  input: TraceQueryInput,
): Record<string, unknown> {
  const filter: Record<string, unknown> = { projectId, tenantId };

  if (input.agentName) {
    filter.agentName = input.agentName;
  }

  if (input.sessionId) {
    filter.sessionId = input.sessionId;
  }

  if (input.eventType && input.eventTypes && input.eventTypes.length > 0) {
    // Both provided — merge into $in
    const allTypes = new Set([input.eventType, ...input.eventTypes]);
    filter.type = { $in: [...allTypes] };
  } else if (input.eventTypes && input.eventTypes.length > 0) {
    filter.type = { $in: input.eventTypes };
  } else if (input.eventType) {
    filter.type = input.eventType;
  }

  if (input.severity) {
    filter['metadata.severity'] = input.severity;
  }

  if (input.since || input.until) {
    const timestampFilter: Record<string, Date> = {};
    if (input.since) {
      timestampFilter.$gte = new Date(input.since);
    }
    if (input.until) {
      timestampFilter.$lte = new Date(input.until);
    }
    filter.timestamp = timestampFilter;
  }

  return filter;
}

/**
 * Shape raw MongoDB documents into structured TraceEvent objects.
 * Handles missing optional fields gracefully — only includes them when present.
 */
export function shapeTraceResponse(docs: RawTraceDoc[], includeData?: boolean): ArchTraceEvent[] {
  return docs.map((doc) => {
    const event: ArchTraceEvent = {
      id: String(doc._id ?? ''),
      type: doc.type ?? 'unknown',
      agentName: doc.agentName ?? 'unknown',
      timestamp:
        doc.timestamp instanceof Date ? doc.timestamp.toISOString() : String(doc.timestamp ?? ''),
    };

    // Optional fields — only include when present
    const durationMs = doc.durationMs ?? doc.duration;
    if (durationMs !== undefined && durationMs !== null) {
      event.durationMs = durationMs;
    }

    if (doc.traceId) event.traceId = doc.traceId;
    if (doc.spanId) event.spanId = doc.spanId;
    if (doc.parentSpanId) event.parentSpanId = doc.parentSpanId;
    if (doc.sessionId) event.sessionId = doc.sessionId;
    if (doc.stepName) event.stepName = doc.stepName;

    // Metadata fields
    if (doc.metadata?.severity) event.severity = doc.metadata.severity;
    if (doc.error) event.error = doc.error;
    if (doc.metadata?.tags && Array.isArray(doc.metadata.tags)) {
      event.tags = doc.metadata.tags;
    }

    // Data payload — only when explicitly requested
    if (includeData && doc.data !== undefined) {
      event.data = doc.data;
    }

    return event;
  });
}

// ─── Executor ─────────────────────────────────────────────────────────────

/**
 * Execute a trace query against the trace_events collection.
 * Uses permission check via guards, builds filter from input,
 * and projects fields based on includeData flag.
 */
export async function executeTraceQuery(
  input: TraceQueryInput,
  ctx: ToolPermissionContext,
): Promise<TraceQueryResult> {
  const { projectId, user } = ctx;
  const tenantId = user.tenantId;

  const perm = await checkToolPermission('analyze', 'query_traces', ctx);
  if (!perm.allowed) {
    return {
      success: false,
      error: { code: 'FORBIDDEN', message: perm.error ?? 'Permission denied' },
    };
  }

  try {
    const mongoose = (await import('mongoose')).default;
    const db = mongoose.connection.db;
    if (!db) {
      return {
        success: false,
        error: { code: 'DB_NOT_CONNECTED', message: 'Database not connected' },
      };
    }

    const filter = buildTraceFilter(projectId, tenantId, input);
    const limit = Math.min(Math.max(input.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT);

    // Build projection — exclude data field unless explicitly requested
    const projection: Record<string, 0 | 1> = {};
    if (!input.includeData) {
      projection.data = 0;
    }

    const docs = await db
      .collection('trace_events')
      .find(filter, { projection })
      .sort({ timestamp: -1 })
      .limit(limit)
      .toArray();

    const events = shapeTraceResponse(docs as unknown as RawTraceDoc[], input.includeData);

    return {
      success: true,
      data: { count: events.length, events },
    };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    log.error('Trace query failed', { projectId, error: message });
    return {
      success: false,
      error: { code: 'QUERY_TRACES_ERROR', message },
    };
  }
}
