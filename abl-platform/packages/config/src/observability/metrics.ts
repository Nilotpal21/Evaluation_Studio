/**
 * Configuration system metric definitions.
 * These are type definitions only — actual metric emission depends on
 * the observability provider (Prometheus, OTEL, etc.) configured by each app.
 */

export interface ConfigMetricEmitter {
  /** Increment counter when config drift is detected */
  incrementDriftDetected(labels: { service: string; environment: string }): void;

  /** Record reload duration */
  observeReloadDuration(
    durationMs: number,
    labels: { service: string; status: 'success' | 'failure' },
  ): void;

  /** Set secret expiry gauge */
  setSecretExpiry(expirySeconds: number, labels: { service: string; secretName: string }): void;

  /** Increment validation error counter */
  incrementValidationErrors(labels: {
    service: string;
    environment: string;
    checkType: string;
  }): void;

  /** Set config health gauge (1 = healthy, 0 = unhealthy) */
  setHealthStatus(status: number, labels: { service: string; check: string }): void;

  /** Set vault cache age */
  setVaultCacheAge(ageSeconds: number, labels: { service: string }): void;

  /** Increment degraded mode entries */
  incrementDegradedMode(labels: { service: string; reason: string }): void;
}

/**
 * Metric name constants for consistent naming across services.
 */
export const CONFIG_METRICS = {
  DRIFT_DETECTED: 'config_drift_detected_total',
  RELOAD_DURATION: 'config_reload_duration_seconds',
  SECRET_EXPIRY: 'config_secret_expiry_seconds',
  VALIDATION_ERRORS: 'config_validation_errors_total',
  HEALTH_STATUS: 'config_health_status',
  VAULT_CACHE_AGE: 'config_vault_cache_age_seconds',
  DEGRADED_MODE: 'config_degraded_mode_total',
  STARTUP_VALIDATION_FAILURES: 'startup_validation_failures_total',
} as const;

/**
 * No-op metric emitter for environments without observability.
 */
export class NoopMetricEmitter implements ConfigMetricEmitter {
  incrementDriftDetected(): void {}
  observeReloadDuration(): void {}
  setSecretExpiry(): void {}
  incrementValidationErrors(): void {}
  setHealthStatus(): void {}
  setVaultCacheAge(): void {}
  incrementDegradedMode(): void {}
}
