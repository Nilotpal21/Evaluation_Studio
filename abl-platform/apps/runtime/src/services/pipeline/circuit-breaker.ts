/**
 * Pipeline Circuit Breaker
 *
 * Lightweight in-memory circuit breaker for the pipeline LLM calls.
 * Opens after consecutive failures to avoid adding 10s+ latency per turn
 * when the pipeline model is down.
 *
 * Scoped per tenant to prevent cross-tenant interference.
 * Auto-resets after a configurable timeout.
 */

import { createLogger } from '@abl/compiler/platform';

const log = createLogger('pipeline-circuit-breaker');

interface BreakerState {
  consecutiveFailures: number;
  isOpen: boolean;
  openedAt: number;
}

/** Max in-memory breaker entries (prevent unbounded growth) */
const MAX_BREAKERS = 500;

/** Consecutive failures before opening the circuit */
const FAILURE_THRESHOLD = 3;

/** Time in ms to keep circuit open before allowing a probe */
const RESET_TIMEOUT_MS = 60_000;

/** Map of tenant → breaker state */
const breakers = new Map<string, BreakerState>();

function getBreaker(tenantId: string): BreakerState {
  let state = breakers.get(tenantId);
  if (state) {
    // Refresh position for LRU eviction
    breakers.delete(tenantId);
    breakers.set(tenantId, state);
    return state;
  }
  // Evict oldest if at capacity
  if (breakers.size >= MAX_BREAKERS) {
    const oldest = breakers.keys().next().value;
    if (oldest) breakers.delete(oldest);
  }
  state = { consecutiveFailures: 0, isOpen: false, openedAt: 0 };
  breakers.set(tenantId, state);
  return state;
}

/**
 * Check if the pipeline circuit is open for this tenant.
 * If the reset timeout has elapsed, transition to half-open (allow one probe).
 */
export function isPipelineCircuitOpen(tenantId: string): boolean {
  const state = getBreaker(tenantId);
  if (!state.isOpen) return false;

  // Check if reset timeout has elapsed → allow a probe
  if (Date.now() - state.openedAt >= RESET_TIMEOUT_MS) {
    log.info('pipeline circuit half-open, allowing probe', { tenantId });
    state.isOpen = false;
    state.consecutiveFailures = FAILURE_THRESHOLD - 1; // One more failure re-opens
    return false;
  }

  return true;
}

/**
 * Record a pipeline success. Resets the failure counter.
 */
export function recordPipelineSuccess(tenantId: string): void {
  const state = getBreaker(tenantId);
  state.consecutiveFailures = 0;
  state.isOpen = false;
}

/**
 * Record a pipeline failure. Opens the circuit after FAILURE_THRESHOLD consecutive failures.
 */
export function recordPipelineFailure(tenantId: string): void {
  const state = getBreaker(tenantId);
  state.consecutiveFailures++;

  if (state.consecutiveFailures >= FAILURE_THRESHOLD && !state.isOpen) {
    state.isOpen = true;
    state.openedAt = Date.now();
    log.warn('pipeline circuit breaker opened', {
      tenantId,
      consecutiveFailures: state.consecutiveFailures,
      resetTimeoutMs: RESET_TIMEOUT_MS,
    });
  }
}

/**
 * Reset the circuit breaker for a tenant (e.g., when config changes).
 * Exported for testing.
 */
export function resetPipelineCircuit(tenantId: string): void {
  breakers.delete(tenantId);
}

/** Clear all breakers. For testing only. */
export function _clearAllBreakers(): void {
  breakers.clear();
}
