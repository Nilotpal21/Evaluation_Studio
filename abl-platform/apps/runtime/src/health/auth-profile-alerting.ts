/**
 * AuthProfile Alert Evaluator
 *
 * Monitors auth profile operational health across four alert dimensions:
 * - TOKEN_REFRESH_FAILED: consecutive refresh failures per profile
 * - DECRYPTION_FAILED: immediate alert on any decryption failure (key rotation issue)
 * - PROFILE_EXPIRY_WARNING: profiles approaching their expiry date
 * - HIGH_ERROR_RATE: auth profile resolution failure rate over a sliding window
 */
import { createLogger } from '@abl/compiler/platform';

const log = createLogger('auth-profile-alerting');

// ─── Thresholds ────────────────────────────────────────────────────────────

/** Alert after this many consecutive refresh failures for the same profile. */
const CONSECUTIVE_REFRESH_FAILURE_THRESHOLD = 3;

/** Alert when resolution failure rate exceeds this percentage within the window. */
const RESOLUTION_FAILURE_THRESHOLD_PERCENT = 5;

/** Sliding window for error rate calculation. */
const WINDOW_MS = 5 * 60 * 1000; // 5 minutes

/** Alert this many days before a profile's expiresAt date. */
const EXPIRY_WARNING_DAYS = 7;

/** Alert when revoke-user-tokens events exceed this count within 1 minute. */
const REVOKE_USER_TOKENS_PER_MINUTE_THRESHOLD = 10;

/** Alert when scope-insufficient detections exceed this count within 1 hour. */
const SCOPE_INSUFFICIENT_PER_HOUR_THRESHOLD = 5;

/** 1-minute window for revoke-user-tokens counting. */
const REVOKE_WINDOW_MS = 60 * 1000;

/** 1-hour window for scope-insufficient counting. */
const SCOPE_WINDOW_MS = 60 * 60 * 1000;

const MS_PER_DAY = 86_400_000;

// ─── Types ─────────────────────────────────────────────────────────────────

export type AlertSinkFn = (
  level: 'critical' | 'warning' | 'info',
  code: string,
  message: string,
  meta?: Record<string, unknown>,
) => void;

export interface ProfileExpiryInfo {
  profileId: string;
  tenantId: string;
  expiresAt: Date;
}

// ─── Alert Codes ───────────────────────────────────────────────────────────

export const AUTH_PROFILE_ALERT_CODES = {
  TOKEN_REFRESH_FAILED: 'AUTH_PROFILE_TOKEN_REFRESH_FAILED',
  DECRYPTION_FAILED: 'AUTH_PROFILE_DECRYPTION_FAILED',
  PROFILE_EXPIRY_WARNING: 'AUTH_PROFILE_EXPIRY_WARNING',
  HIGH_ERROR_RATE: 'AUTH_PROFILE_HIGH_ERROR_RATE',
  REVOKE_USER_TOKENS_SPIKE: 'AUTH_PROFILE_REVOKE_USER_TOKENS_SPIKE',
  SCOPE_INSUFFICIENT_SPIKE: 'AUTH_PROFILE_SCOPE_INSUFFICIENT_SPIKE',
} as const;

// ─── Evaluator ─────────────────────────────────────────────────────────────

export class AuthProfileAlertEvaluator {
  private decryptionFailures = 0;
  private refreshAttempts: { success: boolean; timestamp: number }[] = [];
  private consecutiveRefreshFailures: Map<string, number> = new Map();
  private resolutionAttempts: { success: boolean; timestamp: number }[] = [];
  private revokeUserTokensEvents: { timestamp: number }[] = [];
  private scopeInsufficientEvents: { timestamp: number }[] = [];
  private readonly sink: AlertSinkFn;

  constructor(sink: AlertSinkFn) {
    this.sink = sink;
  }

  // ── Recorders ──────────────────────────────────────────────────────────

  /** Record a decryption failure. Alert fires immediately on next evaluate(). */
  recordDecryptionFailure(meta?: { profileId?: string; tenantId?: string }): void {
    this.decryptionFailures++;
    log.error('Decryption failure recorded', {
      count: this.decryptionFailures,
      ...meta,
    });
  }

  /** Record a token refresh attempt for a specific profile. */
  recordRefreshAttempt(profileId: string, success: boolean): void {
    this.refreshAttempts.push({ success, timestamp: Date.now() });

    if (success) {
      this.consecutiveRefreshFailures.delete(profileId);
    } else {
      const current = this.consecutiveRefreshFailures.get(profileId) ?? 0;
      const newCount = current + 1;
      this.consecutiveRefreshFailures.set(profileId, newCount);

      if (newCount >= CONSECUTIVE_REFRESH_FAILURE_THRESHOLD) {
        this.sink(
          'warning',
          AUTH_PROFILE_ALERT_CODES.TOKEN_REFRESH_FAILED,
          `Token refresh failed ${newCount} consecutive times for profile ${profileId}`,
          { profileId, consecutiveFailures: newCount },
        );
      }
    }

    // Bound the map to prevent unbounded growth
    if (this.consecutiveRefreshFailures.size > 10_000) {
      const entries = [...this.consecutiveRefreshFailures.entries()];
      this.consecutiveRefreshFailures = new Map(entries.slice(-5_000));
    }
  }

  /** Record an auth profile resolution attempt (success or failure). */
  recordResolutionAttempt(success: boolean): void {
    this.resolutionAttempts.push({ success, timestamp: Date.now() });
  }

  /** Record a revoke-user-tokens event. */
  recordRevokeUserTokens(): void {
    this.revokeUserTokensEvents.push({ timestamp: Date.now() });
  }

  /** Record a scope-insufficient detection event. */
  recordScopeInsufficient(): void {
    this.scopeInsufficientEvents.push({ timestamp: Date.now() });
  }

  /** Check profiles approaching expiry and emit warnings. */
  checkProfileExpiry(profiles: ProfileExpiryInfo[]): void {
    const now = Date.now();
    const warningThreshold = EXPIRY_WARNING_DAYS * MS_PER_DAY;

    for (const profile of profiles) {
      const msUntilExpiry = profile.expiresAt.getTime() - now;
      if (msUntilExpiry > 0 && msUntilExpiry <= warningThreshold) {
        const daysUntilExpiry = Math.ceil(msUntilExpiry / MS_PER_DAY);
        this.sink(
          'warning',
          AUTH_PROFILE_ALERT_CODES.PROFILE_EXPIRY_WARNING,
          `Auth profile ${profile.profileId} expires in ${daysUntilExpiry} day(s)`,
          {
            profileId: profile.profileId,
            tenantId: profile.tenantId,
            expiresAt: profile.expiresAt.toISOString(),
            daysUntilExpiry,
          },
        );
      }
    }
  }

  // ── Evaluate ───────────────────────────────────────────────────────────

  /** Run periodic evaluation of accumulated metrics. */
  evaluate(): void {
    // 1. Decryption: any failure is critical (immediate)
    if (this.decryptionFailures > 0) {
      this.sink(
        'critical',
        AUTH_PROFILE_ALERT_CODES.DECRYPTION_FAILED,
        `${this.decryptionFailures} decryption failure(s) detected — possible key rotation issue`,
        { count: this.decryptionFailures },
      );
    }

    // 2. Resolution error rate over sliding window
    const cutoff = Date.now() - WINDOW_MS;
    this.resolutionAttempts = this.resolutionAttempts.filter((a) => a.timestamp >= cutoff);

    const totalResolutions = this.resolutionAttempts.length;
    if (totalResolutions > 0) {
      const failures = this.resolutionAttempts.filter((a) => !a.success).length;
      const failureRate = (failures / totalResolutions) * 100;
      if (failureRate > RESOLUTION_FAILURE_THRESHOLD_PERCENT) {
        this.sink(
          'warning',
          AUTH_PROFILE_ALERT_CODES.HIGH_ERROR_RATE,
          `Auth profile resolution failure rate ${failureRate.toFixed(1)}% exceeds ${RESOLUTION_FAILURE_THRESHOLD_PERCENT}% threshold`,
          { failures, total: totalResolutions, windowMs: WINDOW_MS },
        );
      }
    }

    // 3. Refresh error rate (backward-compatible aggregate check)
    this.refreshAttempts = this.refreshAttempts.filter((a) => a.timestamp >= cutoff);

    const totalRefresh = this.refreshAttempts.length;
    if (totalRefresh > 0) {
      const refreshFailures = this.refreshAttempts.filter((a) => !a.success).length;
      const refreshFailureRate = (refreshFailures / totalRefresh) * 100;
      if (refreshFailureRate > RESOLUTION_FAILURE_THRESHOLD_PERCENT) {
        this.sink(
          'warning',
          'AUTH_PROFILE_TOKEN_REFRESH_DEGRADED',
          `Token refresh failure rate ${refreshFailureRate.toFixed(1)}% exceeds ${RESOLUTION_FAILURE_THRESHOLD_PERCENT}% threshold`,
          { failures: refreshFailures, total: totalRefresh, windowMs: WINDOW_MS },
        );
      }
    }

    // 4. Revoke-user-tokens per minute
    const revokeCutoff = Date.now() - REVOKE_WINDOW_MS;
    this.revokeUserTokensEvents = this.revokeUserTokensEvents.filter(
      (e) => e.timestamp >= revokeCutoff,
    );
    if (this.revokeUserTokensEvents.length > REVOKE_USER_TOKENS_PER_MINUTE_THRESHOLD) {
      this.sink(
        'warning',
        AUTH_PROFILE_ALERT_CODES.REVOKE_USER_TOKENS_SPIKE,
        `${this.revokeUserTokensEvents.length} revoke-user-tokens events in the last minute exceeds threshold of ${REVOKE_USER_TOKENS_PER_MINUTE_THRESHOLD}`,
        { count: this.revokeUserTokensEvents.length, windowMs: REVOKE_WINDOW_MS },
      );
    }

    // 5. Scope-insufficient per hour
    const scopeCutoff = Date.now() - SCOPE_WINDOW_MS;
    this.scopeInsufficientEvents = this.scopeInsufficientEvents.filter(
      (e) => e.timestamp >= scopeCutoff,
    );
    if (this.scopeInsufficientEvents.length > SCOPE_INSUFFICIENT_PER_HOUR_THRESHOLD) {
      this.sink(
        'warning',
        AUTH_PROFILE_ALERT_CODES.SCOPE_INSUFFICIENT_SPIKE,
        `${this.scopeInsufficientEvents.length} scope-insufficient detections in the last hour exceeds threshold of ${SCOPE_INSUFFICIENT_PER_HOUR_THRESHOLD}`,
        { count: this.scopeInsufficientEvents.length, windowMs: SCOPE_WINDOW_MS },
      );
    }

    // Reset decryption counter after evaluation
    this.decryptionFailures = 0;
  }
}
