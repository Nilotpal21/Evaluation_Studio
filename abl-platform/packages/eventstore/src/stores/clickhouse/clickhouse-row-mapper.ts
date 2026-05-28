/**
 * ClickHouse row mapper - converts between PlatformEvent and ClickHouse rows.
 *
 * Responsibilities:
 * - Convert TypeScript types to ClickHouse column types
 * - Serialize JSON data field
 * - Handle optional fields with defaults
 * - Convert Date to DateTime64(3)
 */

import type { PlatformEvent } from '../../schema/platform-event.js';
import { toClickHouseDateTime } from '@agent-platform/database/clickhouse';

/**
 * ClickHouse row type - matches platform_events table schema exactly.
 */
export interface ClickHouseEventRow {
  tenant_id: string;
  project_id: string;
  event_id: string;
  event_type: string;
  category: string;
  timestamp: string; // DateTime64(3) formatted as "YYYY-MM-DD HH:MM:SS.mmm"
  session_id: string;
  trace_id: string;
  span_id: string;
  parent_span_id: string;
  turn_id: string;
  execution_id: string;
  parent_execution_id: string;
  agent_run_id: string;
  decision_id: string;
  parent_decision_id: string;
  cause_event_id: string;
  phase: string;
  reason_code: string;
  agent_name: string;
  deployment_id: string;
  known_source: 'production' | 'eval' | 'synthetic';
  environment: string;
  channel: string;
  actor_id: string;
  actor_type: string;
  duration_ms: number;
  has_error: number; // 0 or 1 (UInt8)
  error_message: string;
  error_type: string;
  data: string; // JSON serialized
  metadata: string; // JSON serialized
  custom_dimensions: Record<string, string>; // Map(String, String) — ClickHouse accepts JSON object
}

export class ClickHouseRowMapper {
  /**
   * Convert PlatformEvent to ClickHouse row for insertion.
   */
  toRow(event: PlatformEvent): ClickHouseEventRow {
    return {
      tenant_id: event.tenant_id,
      project_id: event.project_id,
      event_id: event.event_id,
      event_type: event.event_type,
      category: event.category,
      // ClickHouse DateTime64(3) in JSONEachRow mode expects "YYYY-MM-DD HH:MM:SS.mmm"
      // (no trailing Z). JavaScript Date.toISOString() produces "...Z" which fails.
      timestamp: toClickHouseDateTime(event.timestamp),
      session_id: event.session_id ?? '',
      trace_id: event.trace_id ?? '',
      span_id: event.span_id ?? '',
      parent_span_id: event.parent_span_id ?? '',
      turn_id: event.turn_id ?? '',
      execution_id: event.execution_id ?? '',
      parent_execution_id: event.parent_execution_id ?? '',
      agent_run_id: event.agent_run_id ?? '',
      decision_id: event.decision_id ?? '',
      parent_decision_id: event.parent_decision_id ?? '',
      cause_event_id: event.cause_event_id ?? '',
      phase: event.phase ?? '',
      reason_code: event.reason_code ?? '',
      agent_name: event.agent_name ?? '',
      deployment_id: event.deployment_id ?? '',
      known_source: this.extractKnownSource(event),
      environment: event.environment ?? '',
      channel: event.channel ?? '',
      actor_id: event.actor_id ?? '',
      actor_type: event.actor_type ?? '',
      duration_ms: event.duration_ms ?? 0,
      has_error: event.has_error ? 1 : 0,
      error_message: event.error_message ?? '',
      error_type: event.error_type ?? '',
      data: JSON.stringify(event.data),
      metadata: event.metadata ? JSON.stringify(event.metadata) : '{}',
      custom_dimensions: this.extractCustomDimensions(event),
    };
  }

  /**
   * Convert ClickHouse row to PlatformEvent.
   */
  fromRow(row: ClickHouseEventRow): PlatformEvent {
    const event: PlatformEvent = {
      tenant_id: row.tenant_id,
      project_id: row.project_id,
      event_id: row.event_id,
      event_type: row.event_type,
      category: row.category as PlatformEvent['category'],
      timestamp: new Date(row.timestamp),
      data: JSON.parse(row.data),
    };

    // Optional fields - only include if not empty/default
    if (row.session_id) event.session_id = row.session_id;
    if (row.trace_id) event.trace_id = row.trace_id;
    if (row.span_id) event.span_id = row.span_id;
    if (row.parent_span_id) event.parent_span_id = row.parent_span_id;
    if (row.turn_id) event.turn_id = row.turn_id;
    if (row.execution_id) event.execution_id = row.execution_id;
    if (row.parent_execution_id) event.parent_execution_id = row.parent_execution_id;
    if (row.agent_run_id) event.agent_run_id = row.agent_run_id;
    if (row.decision_id) event.decision_id = row.decision_id;
    if (row.parent_decision_id) event.parent_decision_id = row.parent_decision_id;
    if (row.cause_event_id) event.cause_event_id = row.cause_event_id;
    if (row.phase) event.phase = row.phase;
    if (row.reason_code) event.reason_code = row.reason_code;
    if (row.agent_name) event.agent_name = row.agent_name;
    if (row.deployment_id) event.deployment_id = row.deployment_id;
    event.known_source = this.normalizeKnownSource(row.known_source);
    if (row.environment) event.environment = row.environment;
    if (row.channel) event.channel = row.channel;
    if (row.actor_id) event.actor_id = row.actor_id;
    if (row.actor_type) event.actor_type = row.actor_type as PlatformEvent['actor_type'];
    if (row.duration_ms) event.duration_ms = row.duration_ms;
    if (row.has_error) {
      event.has_error = true;
      if (row.error_message) event.error_message = row.error_message;
      if (row.error_type) event.error_type = row.error_type;
    }
    if (row.metadata && row.metadata !== '{}') {
      event.metadata = JSON.parse(row.metadata);
    }

    // Reconstruct custom_dimensions into metadata
    if (
      row.custom_dimensions &&
      typeof row.custom_dimensions === 'object' &&
      Object.keys(row.custom_dimensions).length > 0
    ) {
      event.metadata = {
        ...(event.metadata || {}),
        custom_dimensions: row.custom_dimensions,
      };
    }

    return event;
  }

  /**
   * Convert batch of events to rows.
   */
  toRows(events: PlatformEvent[]): ClickHouseEventRow[] {
    return events.map((event) => this.toRow(event));
  }

  /**
   * Convert batch of rows to events.
   */
  fromRows(rows: ClickHouseEventRow[]): PlatformEvent[] {
    return rows.map((row) => this.fromRow(row));
  }

  /**
   * Extract custom_dimensions from PlatformEvent metadata for the dedicated Map column.
   */
  private extractCustomDimensions(event: PlatformEvent): Record<string, string> {
    const meta = event.metadata as Record<string, unknown> | undefined;
    const dims = meta?.custom_dimensions;
    if (dims && typeof dims === 'object' && !Array.isArray(dims)) {
      return dims as Record<string, string>;
    }
    return {};
  }

  private extractKnownSource(event: PlatformEvent): 'production' | 'eval' | 'synthetic' {
    if (event.known_source) {
      return this.normalizeKnownSource(event.known_source);
    }

    const knownSource = this.extractCustomDimensions(event).known_source;
    return this.normalizeKnownSource(knownSource);
  }

  private normalizeKnownSource(value: unknown): 'production' | 'eval' | 'synthetic' {
    return value === 'eval' || value === 'synthetic' || value === 'production'
      ? value
      : 'production';
  }

  // DateTime64 formatting now uses centralized toClickHouseDateTime from @agent-platform/database
}
