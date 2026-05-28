/**
 * Auth Profile Audit Event Emitter
 *
 * Single emit point for the 10 domain-level audit event types surfaced
 * in the per-profile Activity tab. Writes to the `auth_profile_audit_events`
 * collection (NOT the generic `audit_logs` collection).
 *
 * Naming-namespace note: the existing constant
 *   `packages/database/src/auth-profile/audit-events.ts > AUTH_PROFILE_AUDIT_EVENTS`
 * uses SCREAMING_SNAKE_CASE event names (e.g. 'AUTH_PROFILE_TOKEN_REFRESHED') and writes to the
 * generic `audit_logs` collection via the auditTrailPlugin. The new emitter below writes to the
 * NEW `auth_profile_audit_events` collection with snake_case verb names. The two namespaces are
 * deliberately disjoint:
 *   - AUTH_PROFILE_AUDIT_EVENTS  -> audit-trail plugin -> audit_logs (system-level CRUD trail)
 *   - AuthProfileAuditEventType  -> new emitter        -> auth_profile_audit_events (domain Activity tab)
 * Implementers MUST NOT cross-emit; the existing CRUD plugin captures CRUD writes automatically and
 * the new emitter is reserved for ABLP-913 lifecycle events surfaced in the per-profile Activity tab.
 */

import { createLogger } from '@agent-platform/shared-observability';

const log = createLogger('auth-profile-audit-emitter');

// ─── Types ────────────────────────────────────────────────────────────

export type AuthProfileAuditEventType =
  | 'authorized'
  | 'authorize_failed'
  | 'token_refreshed'
  | 'token_refresh_failed'
  | 'profile_revoked'
  | 'tokens_revoked'
  | 'profile_updated'
  | 'sensitive_field_changed'
  | 'profile_deleted'
  | 'scope_insufficient_detected';

export interface AuthProfileAuditEventInput {
  tenantId: string;
  projectId: string | null;
  profileId: string;
  eventType: AuthProfileAuditEventType;
  actorUserId: string | null;
  actorContext: {
    source: 'profile' | 'integration_node' | 'tool_config' | 'session_init' | 'system';
    requestId?: string;
    sessionId?: string;
  };
  eventPayload: Record<string, unknown>;
}

// ─── Idempotency Dedupe Map ───────────────────────────────────────────

interface DedupeEntry {
  createdAt: number;
}

const DEDUPE_TTL_MS = 60_000; // 60 seconds
const DEDUPE_MAX_SIZE = 1_000;

const dedupeMap = new Map<string, DedupeEntry>();

function buildDedupeKey(
  tenantId: string,
  profileId: string,
  eventType: string,
  requestId: string,
): string {
  return `${tenantId}:${profileId}:${eventType}:${requestId}`;
}

function evictExpiredEntries(): void {
  const now = Date.now();
  for (const [key, entry] of dedupeMap) {
    if (now - entry.createdAt > DEDUPE_TTL_MS) {
      dedupeMap.delete(key);
    }
  }
}

function evictOldestIfFull(): void {
  if (dedupeMap.size < DEDUPE_MAX_SIZE) return;

  // Evict expired first
  evictExpiredEntries();

  // If still full, evict the oldest entry
  if (dedupeMap.size >= DEDUPE_MAX_SIZE) {
    const firstKey = dedupeMap.keys().next().value;
    if (firstKey !== undefined) {
      dedupeMap.delete(firstKey);
    }
  }
}

function isDuplicate(
  tenantId: string,
  profileId: string,
  eventType: string,
  requestId: string | undefined,
): boolean {
  if (!requestId) return false;

  const key = buildDedupeKey(tenantId, profileId, eventType, requestId);
  const existing = dedupeMap.get(key);

  if (existing && Date.now() - existing.createdAt <= DEDUPE_TTL_MS) {
    return true;
  }

  return false;
}

function recordEmission(
  tenantId: string,
  profileId: string,
  eventType: string,
  requestId: string | undefined,
): void {
  if (!requestId) return;

  evictOldestIfFull();
  const key = buildDedupeKey(tenantId, profileId, eventType, requestId);
  dedupeMap.set(key, { createdAt: Date.now() });
}

// ─── Emitter ──────────────────────────────────────────────────────────

/**
 * Injectable dependencies for the audit event emitter.
 * When omitted, the emitter uses the default dynamic import from
 * `@agent-platform/database/models`.
 */
export interface AuditEventEmitterDeps {
  create(doc: Record<string, unknown>): Promise<unknown>;
}

/**
 * Emit a domain-level audit event for an auth profile lifecycle action.
 * Writes to `auth_profile_audit_events` collection.
 *
 * When `actorContext.requestId` is present, the emitter deduplicates events
 * within a 60-second window using a bounded in-memory Map (max 1000 entries).
 *
 * @param input  The audit event input
 * @param deps   Optional DI — pass `{ create }` to avoid the dynamic import
 */
export async function emitAuthProfileAuditEvent(
  input: AuthProfileAuditEventInput,
  deps?: AuditEventEmitterDeps,
): Promise<void> {
  const { tenantId, profileId, eventType, actorContext } = input;

  // Idempotency check
  if (isDuplicate(tenantId, profileId, eventType, actorContext.requestId)) {
    log.info('auth_profile_audit_event_deduplicated', {
      tenantId,
      profileId,
      eventType,
      requestId: actorContext.requestId,
    });
    return;
  }

  try {
    let create: (doc: Record<string, unknown>) => Promise<unknown>;
    if (deps) {
      create = deps.create;
    } else {
      const { AuthProfileAuditEvent } = await import('@agent-platform/database/models');
      create = (doc) =>
        (
          AuthProfileAuditEvent as {
            create(doc: Record<string, unknown>): Promise<unknown>;
          }
        ).create(doc);
    }

    await create({
      tenantId: input.tenantId,
      projectId: input.projectId,
      profileId: input.profileId,
      eventType: input.eventType,
      actorUserId: input.actorUserId,
      actorContext: input.actorContext,
      eventPayload: input.eventPayload,
    });

    // Record in dedupe map after successful write
    recordEmission(tenantId, profileId, eventType, actorContext.requestId);

    log.info('auth_profile_audit_event_emitted', {
      tenantId,
      profileId,
      eventType,
      actorUserId: input.actorUserId,
      source: actorContext.source,
    });
  } catch (err) {
    // Audit events are non-critical — log and continue
    log.error('auth_profile_audit_event_write_failed', {
      tenantId,
      profileId,
      eventType,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Reset the dedupe map. Exposed for testing only.
 * @internal
 */
export function _resetDedupeMap(): void {
  dedupeMap.clear();
}
