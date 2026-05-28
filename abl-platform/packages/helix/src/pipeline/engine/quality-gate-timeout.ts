/**
 * Quality-gate timeout resolution and timeout-event factory.
 *
 * Pure helpers extracted verbatim from `pipeline-engine.ts`:
 *
 *   - `resolveReservedQualityGateTimeoutMs(gate, remainingTimeoutMs)` —
 *     returns the portion of the remaining stage timeout reserved for the
 *     named quality gate, or undefined when no reservation applies.
 *   - `resolveQualityGateTimeoutMs(gate, stageDeadlineAt, reservedTimeoutMs)` —
 *     the effective quality-gate timeout, preferring explicit reservations,
 *     then the gate's own configured timeout, then the remaining stage
 *     timeout derived from `stageDeadlineAt`.
 *   - `createTimeoutEvent(scope, actor, message, timeoutMs, elapsedMs, details)`
 *     — factory for a structured timeout-event record stamped with `now()`.
 *
 * No engine state, no I/O. Behavior unchanged.
 */
import type { QualityGateConfig, TimeoutEvent } from '../../types.js';
import { getRemainingTimeoutMs, now } from '../stage-execution-shared.js';

export function resolveReservedQualityGateTimeoutMs(
  gate: QualityGateConfig | undefined,
  remainingTimeoutMs?: number,
): number | undefined {
  // With no stage deadlines, remainingTimeoutMs is undefined and no
  // reservation is needed — quality gates run without time pressure.
  if (!gate || remainingTimeoutMs == null) {
    return undefined;
  }

  if (gate.timeoutMs != null && gate.timeoutMs > 0) {
    return Math.min(gate.timeoutMs, remainingTimeoutMs);
  }

  return undefined;
}

export function resolveQualityGateTimeoutMs(
  gate: QualityGateConfig,
  stageDeadlineAt?: number,
  reservedTimeoutMs?: number,
): number | undefined {
  const remainingTimeoutMs = getRemainingTimeoutMs(stageDeadlineAt);
  if (remainingTimeoutMs == null) {
    return reservedTimeoutMs ?? gate.timeoutMs;
  }

  if (reservedTimeoutMs != null) {
    return Math.min(reservedTimeoutMs, remainingTimeoutMs);
  }

  if (gate.timeoutMs != null && gate.timeoutMs > 0) {
    return Math.min(gate.timeoutMs, remainingTimeoutMs);
  }

  return remainingTimeoutMs;
}

export function createTimeoutEvent(
  scope: TimeoutEvent['scope'],
  actor: string,
  message: string,
  timeoutMs?: number,
  elapsedMs?: number,
  details?: Record<string, unknown>,
): TimeoutEvent {
  return {
    scope,
    actor,
    message,
    recordedAt: now(),
    timeoutMs,
    elapsedMs,
    details,
  };
}
