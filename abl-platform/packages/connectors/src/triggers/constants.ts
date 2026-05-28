/**
 * Trigger Engine Constants
 *
 * Named constants for trigger processing — no magic numbers.
 */

/** Deduplication window for webhook event IDs (ms) — 5 minutes */
export const WEBHOOK_DEDUP_WINDOW_MS = 5 * 60 * 1000;

/** Maximum age of a webhook event before it's considered a replay (ms) — 5 minutes */
export const WEBHOOK_REPLAY_TOLERANCE_MS = 5 * 60 * 1000;

/** Number of consecutive errors before a trigger is auto-paused */
export const TRIGGER_AUTO_PAUSE_THRESHOLD = 10;

/**
 * Default polling interval (ms) — 30 seconds.
 *
 * Connector-backed triggers are presented as "events" in the Studio, so the
 * default cadence has to feel near-instant. 30s is within Gmail's per-user
 * quota (`messages.list` costs 5 units; 250 units/user/sec ceiling) and well
 * below the API's own indexing lag for new mail. Connectors with different
 * freshness targets can override via `CONNECTOR_POLLING_DEFAULTS_MS` in
 * `polling-defaults.ts` or via the piece's declared `pollingIntervalMs`.
 */
export const DEFAULT_POLLING_INTERVAL_MS = 30 * 1000;

/**
 * Minimum allowed polling interval (ms) — 10 seconds.
 *
 * `clampInterval()` in `polling-scheduler.ts` enforces this floor against
 * any user-supplied or piece-supplied value. 10s leaves headroom for
 * latency-sensitive connectors without enabling pathological sub-second
 * polling that burns OAuth quota for no freshness gain (most connector
 * APIs have 5-10s indexing lag anyway).
 */
export const MIN_POLLING_INTERVAL_MS = 10 * 1000;

/** Maximum allowed polling interval (ms) — 24 hours */
export const MAX_POLLING_INTERVAL_MS = 24 * 60 * 60 * 1000;

/** Retention period for WebhookDelivery documents (days) — 30 days default */
export const WEBHOOK_DELIVERY_RETENTION_DAYS = 30;

/** Timeout for design-time test runs (testSample / testAction) — 30 seconds */
export const DESIGN_TIME_TEST_TIMEOUT_MS = 30_000;

/** Maximum JSON-serialized size of a stored sample payload (64 KB) */
export const MAX_SAMPLE_PAYLOAD_BYTES = 65_536;
