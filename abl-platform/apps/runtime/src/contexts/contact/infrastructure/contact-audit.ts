/**
 * Contact Audit Types
 *
 * Defines the audit event types and emitter port for contact operations.
 * Use cases accept an optional ContactAuditEmitter to emit structured audit
 * events for compliance (SOC 2, GDPR) without coupling to a specific
 * audit store implementation.
 *
 * The emitter is a port — callers provide the implementation (e.g. write
 * to ClickHouse, emit to an event bus, log to an audit store).
 */

// =============================================================================
// TYPES
// =============================================================================

/**
 * Discriminated set of audit actions for contact lifecycle events.
 */
export type ContactAuditAction =
  | 'contact.created'
  | 'contact.resolved'
  | 'contact.merged'
  | 'contact.self_merged'
  | 'contact.identity_added'
  | 'contact.session_linked'
  | 'contact.gdpr_erased';

/**
 * Structured audit event for a contact operation.
 * Contains enough context for compliance auditing without PII.
 */
export interface ContactAuditEvent {
  action: ContactAuditAction;
  tenantId: string;
  contactId: string;
  metadata?: Record<string, unknown>;
  timestamp: Date;
}

// =============================================================================
// PORT
// =============================================================================

/**
 * Port for emitting contact audit events.
 *
 * Implementations may write to ClickHouse, an event bus, a log store, etc.
 * Use cases call this fire-and-forget with `.catch()` so audit failures
 * never break the primary operation.
 */
export type ContactAuditEmitter = (event: ContactAuditEvent) => Promise<void>;
