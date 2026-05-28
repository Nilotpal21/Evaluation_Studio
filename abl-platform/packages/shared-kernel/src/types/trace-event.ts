/**
 * Canonical TraceEvent types for the ABL platform.
 *
 * All packages and apps should import TraceEvent and TraceEventType from
 * @agent-platform/shared-kernel rather than defining local copies.
 * Local modules may extend BaseTraceEvent with storage/display fields
 * (e.g. id, sessionId, tenantId) via interface extension.
 */
import type {
  ExtendedTraceEventType,
  TraceEventType as CanonicalTraceEventType,
} from '../constants/trace-event-registry.js';

export type TraceEventType = CanonicalTraceEventType;
export type { ExtendedTraceEventType };

export interface TraceEvent {
  type: TraceEventType;
  timestamp: Date;
  durationMs?: number;
  /** Canonical event-specific payload. Legacy emitters may still flatten fields at the top level. */
  data: Record<string, unknown>;
  /** HLC timestamp string for cross-pod ordering (sortable) */
  sequence?: string;
  /** Agent context — which agent emitted this event */
  agentName?: string;
  /** Span hierarchy — unique span identifier */
  spanId?: string;
  /** Span hierarchy — parent span identifier */
  parentSpanId?: string;
  /** User turn or inbound message correlation, when available */
  turnId?: string;
  /** Runtime execution context ID for fan-out/fan-in correlation */
  executionId?: string;
  /** Parent execution context ID for nested runtime work */
  parentExecutionId?: string;
  /** Agent lifecycle run ID shared by enter, decision, tool, and exit events */
  agentRunId?: string;
  /** Decision span ID for atomic runtime decisions */
  decisionId?: string;
  /** Parent decision span ID for nested decisions */
  parentDecisionId?: string;
  /** Immediate cause event ID for reconstructing runtime call stacks */
  causeEventId?: string;
  /** High-level runtime phase used for trace grouping */
  phase?: string;
  /** Machine-readable reason or outcome code for the event */
  reasonCode?: string;
  /** Module provenance — alias used by the consumer project */
  moduleAlias?: string;
  /** Module provenance — originating module project ID */
  moduleProjectId?: string;
  /** Module provenance — immutable release ID */
  moduleReleaseId?: string;
  /** Module provenance — original agent name inside the module */
  sourceAgentName?: string;
}
