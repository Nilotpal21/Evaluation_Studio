/**
 * Core PlatformEvent type.
 *
 * This is the envelope for all events flowing through the system.
 * The `data` field is typed per event_type via the EventRegistry.
 */

import type { EventCategory } from '../interfaces/types.js';

export interface PlatformEvent {
  /** Unique event ID (ULID) */
  event_id: string;

  /** Event type (dotted notation: "session.started", "llm.call.completed", etc.) */
  event_type: string;

  /** Event category for filtering and indexing */
  category: EventCategory;

  /** Tenant ID (multi-tenancy isolation) */
  tenant_id: string;

  /** Project ID (workspace scoping) */
  project_id: string;

  /** Session ID (for session-scoped events) */
  session_id?: string;

  /** Trace ID (for request tracing and debugging) */
  trace_id?: string;

  /** Span ID (for trace consolidation — identifies a single span within a trace) */
  span_id?: string;

  /** Parent span ID (for trace consolidation — links child spans to parents) */
  parent_span_id?: string;

  /** Turn/message correlation ID for causal trace filtering */
  turn_id?: string;

  /** Execution correlation ID for fan-out and workflow trace filtering */
  execution_id?: string;

  /** Parent execution correlation ID */
  parent_execution_id?: string;

  /** Agent lifecycle run ID shared across enter/decision/tool/exit events */
  agent_run_id?: string;

  /** Decision span ID for atomic runtime decisions */
  decision_id?: string;

  /** Parent decision span ID for nested decisions */
  parent_decision_id?: string;

  /** Immediate cause event ID for reconstructing runtime call stacks */
  cause_event_id?: string;

  /** High-level runtime phase used for trace grouping */
  phase?: string;

  /** Machine-readable reason or outcome code for the event */
  reason_code?: string;

  /** Agent name (for agent-related events) */
  agent_name?: string;

  /** Deployment ID (for tracking which deployment generated the event) */
  deployment_id?: string;

  /** Session purpose/source tag used for analytics isolation */
  known_source?: 'production' | 'eval' | 'synthetic';

  /** Deployment/runtime environment (dev, staging, production, or project-defined environment) */
  environment?: string;

  /** Channel type (web, voice, sms, etc.) */
  channel?: string;

  /** Actor ID (user/contact who triggered the event) */
  actor_id?: string;

  /** Actor type (user, contact, system, agent) */
  actor_type?: 'user' | 'contact' | 'system' | 'agent';

  /** Event timestamp (UTC) */
  timestamp: Date;

  /** Duration in milliseconds (for operation events) */
  duration_ms?: number;

  /** Error flag (for error events) */
  has_error?: boolean;

  /** Error message (if has_error=true) */
  error_message?: string;

  /** Error type/code (if has_error=true) */
  error_type?: string;

  /**
   * Event-specific data payload.
   * Validated against event_type's Zod schema in EventRegistry.
   * Stored as JSON in ClickHouse, typed at application layer.
   */
  data: Record<string, unknown>;

  /** Metadata (tags, labels, custom fields) */
  metadata?: Record<string, unknown>;
}

/**
 * Event envelope for registry validation.
 * Returned by EventRegistry after validation.
 */
export interface ValidatedEvent {
  event: PlatformEvent;
  schema_version: string;
  contains_pii: boolean;
}
