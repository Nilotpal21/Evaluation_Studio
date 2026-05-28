/**
 * STR Writer — Flush STR entries to ClickHouse
 *
 * Converts STREntry records from the ring buffer into ClickHouse rows
 * matching the spatial_trace_records schema. Writes are fire-and-forget
 * to avoid blocking the hot path. Flush failures are reported back to
 * the STRBuffer circuit breaker.
 */

import { createLogger } from '../logger.js';
import type { STREntry } from './str-buffer.js';
import { getVersionVector, type VersionVector } from './version-vector.js';

const log = createLogger('str-writer');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Row shape matching the spatial_trace_records ClickHouse table */
export interface SpatialTraceRow {
  tenant_id: string;
  project_id: string;
  trace_id: string;
  span_id: string;
  parent_span_id: string;
  sti_path: string;
  session_id: string;
  agent_name: string;
  deployment_id: string;
  config_hash: string;
  started_at: string; // ISO 8601 DateTime64
  ended_at: string;
  duration_ms: number;
  has_error: number; // UInt8
  error_type: string;
  error_message: string;
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  model_id: string;
  provider: string;
  tool_name: string;
  attributes: string; // JSON string
}

/** Minimal writer interface — compatible with BufferedClickHouseWriter.insert() */
export interface RowWriter {
  insert(row: SpatialTraceRow): void;
}

/** Context provided at flush time to enrich STR entries with session metadata */
export interface FlushContext {
  tenantId: string;
  projectId: string;
  traceId: string;
  sessionId?: string;
  agentName?: string;
  configHash?: string;
}

/** Callbacks for circuit breaker feedback */
export interface FlushCallbacks {
  onSuccess(): void;
  onFailure(): void;
}

// ---------------------------------------------------------------------------
// STRWriter
// ---------------------------------------------------------------------------

export class STRWriter {
  private readonly writer: RowWriter;

  constructor(writer: RowWriter) {
    this.writer = writer;
  }

  /**
   * Convert STR entries to ClickHouse rows and insert them.
   * Fire-and-forget — never throws. Reports success/failure via callbacks.
   */
  flush(entries: STREntry[], context: FlushContext, callbacks?: FlushCallbacks): void {
    try {
      if (entries.length === 0) {
        callbacks?.onSuccess();
        return;
      }

      const version = getVersionVector();
      const rows = entries.map((entry) => this.toRow(entry, context, version));

      for (const row of rows) {
        this.writer.insert(row);
      }

      callbacks?.onSuccess();
    } catch (err) {
      log.warn('STR flush failed', {
        traceId: context.traceId,
        entryCount: entries.length,
        error: err instanceof Error ? err.message : String(err),
      });
      callbacks?.onFailure();
    }
  }

  /**
   * Convert a single STR entry to a ClickHouse row.
   */
  private toRow(entry: STREntry, context: FlushContext, version: VersionVector): SpatialTraceRow {
    const startedAt = new Date(entry.timestamp);
    const durationMs = Math.round(entry.durationUs / 1000);
    const endedAt = new Date(entry.timestamp + durationMs);

    return {
      tenant_id: context.tenantId,
      project_id: context.projectId,
      trace_id: context.traceId,
      span_id: '',
      parent_span_id: '',
      sti_path: entry.path,
      session_id: context.sessionId ?? '',
      agent_name: context.agentName ?? '',
      deployment_id: version.deployId,
      config_hash: context.configHash ?? '',
      started_at: startedAt.toISOString(),
      ended_at: endedAt.toISOString(),
      duration_ms: durationMs,
      has_error: entry.outcome === 'error' ? 1 : 0,
      error_type: '',
      error_message: '',
      input_tokens: 0,
      output_tokens: 0,
      total_tokens: 0,
      model_id: '',
      provider: '',
      tool_name: '',
      attributes: JSON.stringify({
        depth: entry.depth,
        outcome: entry.outcome,
        code_version: version.codeVersion,
        ir_schema_version: version.irSchemaVersion,
      }),
    };
  }
}
