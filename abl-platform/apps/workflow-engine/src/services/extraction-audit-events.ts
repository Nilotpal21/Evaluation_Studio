/**
 * Extraction audit-event emitter — Phase 4 task 4.7b / LLD §1 D-20.
 *
 * Every document-extraction attempt — success or pre-call rejection — emits
 * a structured audit event with the canonical envelope `{ actor, tenantId,
 * projectId, connector, action, sourceUrl, sizeBytes, durationMs, status }`.
 *
 * The default sink writes a structured log line via the platform logger;
 * downstream log-tailing audit ingest materializes the line into the
 * `audit_logs` Mongo collection. Tests inject an array-collector sink to
 * assert the emitted shape without going through the persistence layer.
 *
 * URL sanitization: `sourceUrl` is reduced to host-only (no path / query /
 * hash) at the boundary so URL-bound secrets (signed-URL tokens, query-param
 * API keys) never reach audit storage.
 */

import { createLogger } from '@abl/compiler/platform';

const log = createLogger('workflow-engine:extraction-audit');

/** Status codes recognized as terminal for an extraction audit event. */
export const EXTRACTION_AUDIT_REJECTION_CODES = new Set<string>([
  'SSRF_BLOCKED',
  'RATE_LIMITED',
  'QUOTA_EXCEEDED',
  'EXTRACTION_TOO_LARGE',
  'CIRCUIT_OPEN',
  'INTEGRATION_UNAVAILABLE',
  'UNSUPPORTED_CONTENT_TYPE',
  'FEATURE_DISABLED',
  'EXTRACTION_FAILED',
  'STEP_TIMEOUT',
]);

export interface ExtractionAuditEvent {
  /** Actor identity — userId for user-driven workflows, 'system:workflow' for scheduled runs. */
  actor: string;
  tenantId: string;
  projectId: string;
  /** Connector name (e.g. `docling`, `azure-document-intelligence`). */
  connector: string;
  /** Action name (e.g. `extract_document`). */
  action: string;
  /** Host-only URL (no path / query / hash). Empty string for non-URL sources. */
  sourceUrl: string;
  /** Serialized envelope size in bytes. 0 for pre-call rejections. */
  sizeBytes: number;
  /** End-to-end latency in milliseconds. 0 for pre-call rejections. */
  durationMs: number;
  /** Terminal status — `success` for completed extractions, otherwise the typed error code. */
  status: string;
}

export type ExtractionAuditSink = (event: ExtractionAuditEvent) => void;

/**
 * Default sink — writes a structured log line under the `extraction.audit`
 * action so the audit-ingest pipeline materializes it into `audit_logs`.
 * Fire-and-forget; never blocks the workflow.
 */
export const defaultExtractionAuditSink: ExtractionAuditSink = (event) => {
  log.info('extraction.audit', { ...event, audit: true });
};

/**
 * Reduce any URL string to host-only, stripping path / query / hash.
 * Returns the original string when it isn't a parseable URL (defensive
 * fallback for tests / malformed inputs). The empty string passes through
 * unchanged so callers can pass `''` for non-URL sources.
 */
export function toHostOnlyUrl(url: string): string {
  if (url === '') return '';
  try {
    const parsed = new URL(url);
    // host preserves any non-default port; protocol is preserved without path/query.
    return `${parsed.protocol}//${parsed.host}`;
  } catch {
    return url;
  }
}

export interface ExtractionAuditEmitterDeps {
  sink?: ExtractionAuditSink;
}

export class ExtractionAuditEmitter {
  private readonly sink: ExtractionAuditSink;

  constructor(deps: ExtractionAuditEmitterDeps = {}) {
    this.sink = deps.sink ?? defaultExtractionAuditSink;
  }

  emit(event: ExtractionAuditEvent): void {
    // Normalize sourceUrl to host-only at the boundary so all callers stay
    // honest about not leaking URL-bound secrets into audit storage.
    const sanitized: ExtractionAuditEvent = {
      ...event,
      sourceUrl: toHostOnlyUrl(event.sourceUrl),
    };
    try {
      this.sink(sanitized);
    } catch (err) {
      // Audit emission MUST NOT block or fail the workflow. Swallowing here is
      // intentional and logged at warn so the operator can spot misconfigured
      // sinks via the log stream.
      log.warn('extraction-audit sink threw — event dropped', {
        action: event.action,
        status: event.status,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}
