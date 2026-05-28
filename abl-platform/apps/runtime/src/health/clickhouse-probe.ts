/**
 * Active ClickHouse Health Probe
 *
 * Replaces the static `clickhouseReady` boolean with a periodic live probe
 * that runs `SELECT 1` against ClickHouse. The cached result is read by the
 * `/health` endpoint so load-balancer calls never trigger a DB round-trip.
 */

import { createLogger } from '@abl/compiler/platform';

const log = createLogger('clickhouse-probe');

export interface ClickHouseProbeResult {
  ok: boolean;
  latencyMs: number;
  error?: string;
}

/**
 * Actively probe ClickHouse by running `SELECT 1`.
 * Returns the probe result with latency and error info.
 */
export async function probeClickHouse(client: {
  ping: () => Promise<{ success: boolean; error?: Error }>;
}): Promise<ClickHouseProbeResult> {
  const start = performance.now();
  try {
    const result = await client.ping();
    if (!result.success) {
      const errorMsg = result.error?.message ?? 'ping failed';
      log.warn('ClickHouse health probe failed', { error: errorMsg });
      return {
        ok: false,
        latencyMs: Math.round(performance.now() - start),
        error: errorMsg,
      };
    }
    return { ok: true, latencyMs: Math.round(performance.now() - start) };
  } catch (err: unknown) {
    log.warn('ClickHouse health probe failed', {
      error: err instanceof Error ? err.message : String(err),
    });
    return {
      ok: false,
      latencyMs: Math.round(performance.now() - start),
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

// ---------------------------------------------------------------------------
// Cached periodic probe — avoids hitting ClickHouse on every /health request
// ---------------------------------------------------------------------------

const PROBE_INTERVAL_DEFAULT_MS = 30_000;

let lastProbeResult: ClickHouseProbeResult | null = null;
let probeTimer: ReturnType<typeof setInterval> | null = null;

/** Start a periodic background probe. Safe to call multiple times (no-ops on re-entry). */
export function startClickHouseProbe(client: {
  ping: () => Promise<{ success: boolean; error?: Error }>;
}): void {
  if (probeTimer !== null) return; // already running

  const intervalMs = parseInt(
    process.env.CLICKHOUSE_PROBE_INTERVAL_MS || String(PROBE_INTERVAL_DEFAULT_MS),
    10,
  );
  const safeInterval = Number.isNaN(intervalMs) ? PROBE_INTERVAL_DEFAULT_MS : intervalMs;

  // Fire the initial probe immediately (non-blocking)
  probeClickHouse(client).then((result) => {
    lastProbeResult = result;
  });

  // Periodic probe — unref so it doesn't keep the process alive during shutdown
  probeTimer = setInterval(async () => {
    lastProbeResult = await probeClickHouse(client);
  }, safeInterval);
  probeTimer.unref();

  log.info('ClickHouse health probe started', { intervalMs: safeInterval });
}

/** Stop the periodic probe. Safe to call even if not started. */
export function stopClickHouseProbe(): void {
  if (probeTimer !== null) {
    clearInterval(probeTimer);
    probeTimer = null;
  }
  lastProbeResult = null;
}

/**
 * Get the most recent cached probe result.
 * Returns `null` if the probe has never run (e.g. ClickHouse not configured).
 */
export function getLastProbeResult(): ClickHouseProbeResult | null {
  return lastProbeResult;
}
