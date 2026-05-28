/**
 * Progress heartbeat helpers — decide when to persist a progress event
 * and resolve the heartbeat interval from config.
 *
 * Extracted verbatim from `pipeline-engine.ts`. Behavior is unchanged.
 */
import type { ProgressEvent } from '../../types.js';

export const DEFAULT_PROGRESS_HEARTBEAT_MS = 15_000;

export function shouldPersistProgressHeartbeat(event: ProgressEvent): boolean {
  return event.type === 'stage-progress' || event.type === 'model-stream';
}

export function resolveProgressHeartbeatMs(configuredIntervalMs: number | undefined): number {
  if (configuredIntervalMs == null) {
    return DEFAULT_PROGRESS_HEARTBEAT_MS;
  }

  return Math.max(0, configuredIntervalMs);
}
