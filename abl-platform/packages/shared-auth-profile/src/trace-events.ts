/**
 * Auth Profile Trace Events
 *
 * Emits TraceEvent-compatible events for auth profile operations.
 * Used by the auth profile service layer to provide traceability
 * for credential resolution, token refresh, and OAuth flows.
 */
import { createLogger } from '@agent-platform/shared-observability';

const log = createLogger('auth-profile-trace');

export interface AuthProfileTraceEvent {
  eventType: string;
  profileId: string;
  tenantId: string;
  authType?: string;
  timestamp: string;
  metadata?: Record<string, unknown>;
}

/**
 * Emit a trace event for an auth profile operation.
 * Uses structured logging as the trace sink (TraceStore integration deferred to Phase 2).
 */
export function emitAuthProfileTraceEvent(event: AuthProfileTraceEvent): void {
  log.info(event.eventType, {
    profileId: event.profileId,
    tenantId: event.tenantId,
    authType: event.authType,
    timestamp: event.timestamp,
    ...event.metadata,
  });
}

/** Pre-defined event types for auth profile operations */
export const AUTH_PROFILE_TRACE_EVENTS = {
  // ── Resolution lifecycle ────────────────────────────────────────────────
  RESOLVE_START: 'auth_profile.resolve_start',
  RESOLVE_SUCCESS: 'auth_profile.resolve_success',
  RESOLVE_FALLBACK: 'auth_profile.resolve_fallback',
  RESOLVE_ERROR: 'auth_profile.resolve_error',

  // ── Token refresh lifecycle ─────────────────────────────────────────────
  REFRESH_START: 'auth_profile.refresh_start',
  REFRESH_SUCCESS: 'auth_profile.refresh_success',
  REFRESH_ERROR: 'auth_profile.refresh_error',

  // ── Credential operations ───────────────────────────────────────────────
  CREDENTIAL_RESOLVED: 'auth_profile.credential_resolved',
  CREDENTIAL_CACHED: 'auth_profile.credential_cached',
  CREDENTIAL_CACHE_HIT: 'auth_profile.credential_cache_hit',

  // ── Token refresh (legacy aliases) ──────────────────────────────────────
  TOKEN_REFRESH_STARTED: 'auth_profile.token_refresh_started',
  TOKEN_REFRESH_COMPLETED: 'auth_profile.token_refresh_completed',
  TOKEN_REFRESH_FAILED: 'auth_profile.token_refresh_failed',

  // ── OAuth flows ─────────────────────────────────────────────────────────
  OAUTH_FLOW_INITIATED: 'auth_profile.oauth_flow_initiated',
  OAUTH_FLOW_COMPLETED: 'auth_profile.oauth_flow_completed',
  OAUTH_FLOW_FAILED: 'auth_profile.oauth_flow_failed',
  CLIENT_CREDENTIALS_EXCHANGED: 'auth_profile.client_credentials_exchanged',

  // ── Session Init ────────────────────────────────────────────────────────
  SESSION_SCAN_COMPLETED: 'auth_profile.session_init.scan_completed',
  SESSION_PRECONFIGURED_RESOLVED: 'auth_profile.session_init.preconfigured_resolved',
  SESSION_REFRESH_FAILED: 'auth_profile.session_init.refresh_failed',
  SESSION_PREFLIGHT_DEGRADED: 'auth_profile.session_init.preflight_degraded',

  // ── Cache ──────────────────────────────────────────────────────────────
  CACHE_INVALIDATED: 'auth_profile.cache_invalidated',

  // ── Scope ──────────────────────────────────────────────────────────────
  SCOPE_INSUFFICIENT: 'auth_profile.scope_insufficient',

  // ── Validation ──────────────────────────────────────────────────────────
  VALIDATION_SUCCEEDED: 'auth_profile.validation_succeeded',
  VALIDATION_FAILED: 'auth_profile.validation_failed',

  // ── Authorize-at-creation (ABLP-619) ───────────────────────────────────
  AUTHORIZED: 'auth_profile.authorized',
  AUTHORIZE_FAILED: 'auth_profile.authorize_failed',
} as const;
