/**
 * Eval Circuit Breaker Registration
 *
 * Registers 3 circuit breakers for eval pipeline resilience:
 * - eval-persona-llm: Wraps persona simulation LLM calls
 * - eval-judge-llm: Wraps judge LLM calls
 * - eval-agent-executor: Wraps in-process/HTTP agent execution
 *
 * Uses the platform CircuitBreakerRegistry from @agent-platform/circuit-breaker.
 * Falls back gracefully when Redis is unavailable (circuit breakers are no-ops).
 */

import { createLogger } from '@abl/compiler/platform';
import { CircuitOpenError } from '@agent-platform/circuit-breaker';
import { evalMetrics } from './eval-metrics.js';

const log = createLogger('eval-circuit-breakers');

// ── Breaker Configuration ───────────────────────────────────────────

export interface EvalBreakerConfig {
  failureThreshold: number;
  successThreshold: number;
  resetTimeoutMs: number;
  windowMs: number;
}

export const EVAL_BREAKER_CONFIGS: Record<string, EvalBreakerConfig> = {
  'eval-persona-llm': {
    failureThreshold: 5,
    successThreshold: 3,
    resetTimeoutMs: 30_000,
    windowMs: 60_000,
  },
  'eval-judge-llm': {
    failureThreshold: 5,
    successThreshold: 3,
    resetTimeoutMs: 30_000,
    windowMs: 60_000,
  },
  'eval-agent-executor': {
    failureThreshold: 3,
    successThreshold: 2,
    resetTimeoutMs: 15_000,
    windowMs: 60_000,
  },
};

// ── In-Memory Circuit Breaker (standalone, no Redis dependency) ─────

type BreakerState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

const MAX_RECENT_ERRORS = 10;

export interface BreakerErrorEntry {
  timestamp: string;
  message: string;
  statusCode?: number;
}

interface BreakerInstance {
  state: BreakerState;
  failures: number[];
  successes: number;
  openedAt: number;
  config: EvalBreakerConfig;
  recentErrors: BreakerErrorEntry[];
  openedReason: string;
}

const breakers = new Map<string, BreakerInstance>();

function getBreaker(name: string): BreakerInstance {
  let breaker = breakers.get(name);
  if (!breaker) {
    const config = EVAL_BREAKER_CONFIGS[name];
    if (!config) throw new Error(`Unknown eval breaker: ${name}`);
    breaker = {
      state: 'CLOSED',
      failures: [],
      successes: 0,
      openedAt: 0,
      config,
      recentErrors: [],
      openedReason: '',
    };
    breakers.set(name, breaker);
  }
  return breaker;
}

/** Extract HTTP status code from error messages like "Runtime API 401: ...". */
function extractHttpStatus(error: unknown): number | undefined {
  const msg = error instanceof Error ? error.message : String(error);
  const match = msg.match(/\b([1-5]\d{2})\b/);
  return match ? parseInt(match[1], 10) : undefined;
}

function pruneWindow(breaker: BreakerInstance): void {
  const cutoff = Date.now() - breaker.config.windowMs;
  breaker.failures = breaker.failures.filter((t) => t > cutoff);
}

function openBreaker(
  breaker: BreakerInstance,
  breakerName: string,
  openedAt: number,
  openedReason: string,
): void {
  breaker.state = 'OPEN';
  breaker.openedAt = openedAt;
  breaker.successes = 0;
  breaker.openedReason = openedReason;

  log.warn('Eval circuit breaker opened', {
    breakerName,
    failureCount: breaker.failures.length,
    windowMs: breaker.config.windowMs,
    openedReason: breaker.openedReason,
  });
  evalMetrics.circuitBreakerOpened.add(1, { breaker: breakerName });
}

/**
 * Execute a function wrapped in a circuit breaker.
 * Throws if the circuit is OPEN and reset timeout hasn't elapsed.
 */
export async function withCircuitBreaker<T>(breakerName: string, fn: () => Promise<T>): Promise<T> {
  const breaker = getBreaker(breakerName);
  const now = Date.now();

  // Check state
  if (breaker.state === 'OPEN') {
    if (now - breaker.openedAt >= breaker.config.resetTimeoutMs) {
      breaker.state = 'HALF_OPEN';
      breaker.successes = 0;
      log.info('Eval circuit breaker transitioning to HALF_OPEN', { breakerName });
    } else {
      throw new EvalCircuitOpenError(breakerName);
    }
  }

  try {
    const result = await fn();

    // Record success
    if (breaker.state === 'HALF_OPEN') {
      breaker.successes++;
      if (breaker.successes >= breaker.config.successThreshold) {
        breaker.state = 'CLOSED';
        breaker.failures = [];
        breaker.successes = 0;
        log.info('Eval circuit breaker closed', { breakerName });
      }
    }

    return result;
  } catch (error) {
    // Record failure + error context
    const errorMsg = error instanceof Error ? error.message : String(error);
    breaker.failures.push(now);
    pruneWindow(breaker);

    // Push to ring buffer (cap at MAX_RECENT_ERRORS)
    breaker.recentErrors.push({
      timestamp: new Date(now).toISOString(),
      message: errorMsg,
      statusCode: extractHttpStatus(error),
    });
    if (breaker.recentErrors.length > MAX_RECENT_ERRORS) {
      breaker.recentErrors.shift();
    }

    const shouldOpen =
      breaker.state === 'HALF_OPEN' || breaker.failures.length >= breaker.config.failureThreshold;

    if (shouldOpen) {
      openBreaker(breaker, breakerName, now, errorMsg);
    }

    throw error;
  }
}

/**
 * Check if a breaker is currently open (without attempting execution).
 */
export function isBreakerOpen(breakerName: string): boolean {
  const breaker = breakers.get(breakerName);
  if (!breaker) return false;
  if (breaker.state !== 'OPEN') return false;
  // Check if reset timeout has elapsed
  return Date.now() - breaker.openedAt < breaker.config.resetTimeoutMs;
}

/**
 * Get current state of all eval breakers (for health/admin endpoints).
 */
export function getEvalBreakerStates(): Record<
  string,
  {
    state: BreakerState;
    failures: number;
    lastFailure: string | null;
    openedReason: string;
    recentErrors: BreakerErrorEntry[];
  }
> {
  const result: Record<
    string,
    {
      state: BreakerState;
      failures: number;
      lastFailure: string | null;
      openedReason: string;
      recentErrors: BreakerErrorEntry[];
    }
  > = {};
  for (const [name] of Object.entries(EVAL_BREAKER_CONFIGS)) {
    const breaker = breakers.get(name);
    if (breaker) {
      pruneWindow(breaker);
      result[name] = {
        state: breaker.state,
        failures: breaker.failures.length,
        lastFailure:
          breaker.failures.length > 0
            ? new Date(breaker.failures[breaker.failures.length - 1]).toISOString()
            : null,
        openedReason: breaker.openedReason,
        recentErrors: [...breaker.recentErrors],
      };
    } else {
      result[name] = {
        state: 'CLOSED',
        failures: 0,
        lastFailure: null,
        openedReason: '',
        recentErrors: [],
      };
    }
  }
  return result;
}

/**
 * Force-reset a breaker (for admin/ops emergency use).
 */
export function forceResetBreaker(breakerName: string): void {
  const breaker = breakers.get(breakerName);
  if (breaker) {
    breaker.state = 'CLOSED';
    breaker.failures = [];
    breaker.successes = 0;
    breaker.openedAt = 0;
    breaker.recentErrors = [];
    breaker.openedReason = '';
    log.info('Eval circuit breaker force-reset', { breakerName });
  }
}

/**
 * Error thrown when attempting to call through an open circuit.
 */
export class EvalCircuitOpenError extends CircuitOpenError {
  public readonly breakerName: string;
  public readonly openedReason: string;
  public readonly recentErrors: BreakerErrorEntry[];

  constructor(breakerName: string) {
    const breaker = breakers.get(breakerName);
    const reason = breaker?.openedReason ?? 'unknown';
    const recentErrs = breaker?.recentErrors ?? [];
    const resetTimeoutMs = breaker?.config.resetTimeoutMs ?? 30_000;
    super('app', breakerName, resetTimeoutMs);
    this.name = 'EvalCircuitOpenError';
    this.breakerName = breakerName;
    this.openedReason = reason;
    this.recentErrors = [...recentErrs];
    // Override parent message to preserve eval-specific format
    const suffix = reason !== 'unknown' ? ` — Opened because: ${reason}` : '';
    this.message = `Eval circuit breaker '${breakerName}' is OPEN${suffix}`;
  }
}
