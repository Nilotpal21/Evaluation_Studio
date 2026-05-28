/**
 * Per-connector polling interval overrides (ms).
 *
 * Resolution chain at register time (see `ConnectorTriggerEngine.registerTrigger`):
 *
 *   1. `input.pollingIntervalMs`                   — per-trigger instance, set by caller
 *   2. `trigger.pollingIntervalMs`                 — declared on the connector piece
 *   3. `CONNECTOR_POLLING_DEFAULTS_MS[connector]`  — this map (platform override)
 *   4. `DEFAULT_POLLING_INTERVAL_MS`               — global fallback (30s)
 *
 * Use this map when the product freshness target for a connector differs
 * from the piece author's choice and you want the override in one place
 * rather than forking the piece. Entries are still clamped to
 * `[MIN_POLLING_INTERVAL_MS, MAX_POLLING_INTERVAL_MS]` in `polling-scheduler.ts`.
 *
 * Currently empty — the 30s global default is right for every connector
 * wired today (Gmail, Slack, Jira, etc. all declare no intervalMs on their
 * Activepieces pieces, so they inherit the default). Add a row here when a
 * specific connector needs a slower cadence (e.g. a batch analytics API
 * with strict rate limits) or a faster one (e.g. a real-time chat adapter).
 */
export const CONNECTOR_POLLING_DEFAULTS_MS: Record<string, number> = {};
