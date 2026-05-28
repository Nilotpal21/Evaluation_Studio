/**
 * Eval Per-Tenant Rate Limiter
 *
 * Prevents a single tenant from monopolizing LLM capacity across
 * concurrent eval runs. Three dimensions of control:
 * - maxConcurrentRuns: Simultaneous eval runs per tenant
 * - maxConcurrentConversations: Total conversations across all runs
 * - maxLLMCallsPerMinute: Rate limit on judge + persona LLM calls
 *
 * Uses in-memory counters (no Redis dependency for pipeline engine).
 * Counters auto-cleanup after 2 minutes of inactivity.
 */

import { createLogger } from '@abl/compiler/platform';
import { evalMetrics } from './eval-metrics.js';

const log = createLogger('eval-rate-limiter');

// ── Tier-Based Limits ───────────────────────────────────────────────

export interface TenantEvalLimits {
  maxConcurrentRuns: number;
  maxConcurrentConversations: number;
  maxLLMCallsPerMinute: number;
}

const TIER_LIMITS: Record<string, TenantEvalLimits> = {
  free: { maxConcurrentRuns: 1, maxConcurrentConversations: 3, maxLLMCallsPerMinute: 10 },
  team: { maxConcurrentRuns: 2, maxConcurrentConversations: 10, maxLLMCallsPerMinute: 30 },
  business: { maxConcurrentRuns: 3, maxConcurrentConversations: 20, maxLLMCallsPerMinute: 60 },
  enterprise: { maxConcurrentRuns: 5, maxConcurrentConversations: 50, maxLLMCallsPerMinute: 120 },
};

const DEFAULT_TIER = 'business';

// ── Internal State ──────────────────────────────────────────────────

interface TenantCounters {
  runs: number;
  conversations: number;
  llmCalls: number[]; // timestamps of recent calls (sliding window)
  lastActivity: number;
}

const tenantCounters = new Map<string, TenantCounters>();

/** Auto-cleanup interval: remove idle tenants every 2 minutes. */
const CLEANUP_INTERVAL_MS = 120_000;
const IDLE_TIMEOUT_MS = 120_000;
const LLM_WINDOW_MS = 60_000;

/** Max entries to prevent unbounded growth. */
const MAX_TENANT_ENTRIES = 1000;

let cleanupTimer: ReturnType<typeof setInterval> | null = null;

function ensureCleanupTimer(): void {
  if (cleanupTimer) return;
  cleanupTimer = setInterval(() => {
    const now = Date.now();
    for (const [tenantId, counters] of tenantCounters) {
      if (
        now - counters.lastActivity > IDLE_TIMEOUT_MS &&
        counters.runs === 0 &&
        counters.conversations === 0
      ) {
        tenantCounters.delete(tenantId);
      }
    }
    if (tenantCounters.size === 0 && cleanupTimer) {
      clearInterval(cleanupTimer);
      cleanupTimer = null;
    }
  }, CLEANUP_INTERVAL_MS);
  // Allow process to exit even if timer is active
  if (cleanupTimer && typeof cleanupTimer === 'object' && 'unref' in cleanupTimer) {
    cleanupTimer.unref();
  }
}

function getCounters(tenantId: string): TenantCounters {
  let counters = tenantCounters.get(tenantId);
  if (!counters) {
    if (tenantCounters.size >= MAX_TENANT_ENTRIES) {
      // Evict oldest idle tenant
      let oldestKey: string | null = null;
      let oldestTime = Infinity;
      for (const [key, val] of tenantCounters) {
        if (val.lastActivity < oldestTime && val.runs === 0) {
          oldestTime = val.lastActivity;
          oldestKey = key;
        }
      }
      if (oldestKey) tenantCounters.delete(oldestKey);
    }
    counters = { runs: 0, conversations: 0, llmCalls: [], lastActivity: Date.now() };
    tenantCounters.set(tenantId, counters);
    ensureCleanupTimer();
  }
  return counters;
}

function pruneLLMWindow(counters: TenantCounters): void {
  const cutoff = Date.now() - LLM_WINDOW_MS;
  counters.llmCalls = counters.llmCalls.filter((t) => t > cutoff);
}

function getLimits(tier?: string): TenantEvalLimits {
  return TIER_LIMITS[tier ?? DEFAULT_TIER] ?? TIER_LIMITS[DEFAULT_TIER];
}

// ── Public API ──────────────────────────────────────────────────────

/**
 * Attempt to acquire a run slot. Returns true if allowed.
 */
export function acquireRunSlot(tenantId: string, tier?: string): boolean {
  const counters = getCounters(tenantId);
  const limits = getLimits(tier);
  counters.lastActivity = Date.now();

  if (counters.runs >= limits.maxConcurrentRuns) {
    log.warn('Eval rate limit: max concurrent runs reached', {
      tenantId,
      current: counters.runs,
      max: limits.maxConcurrentRuns,
    });
    evalMetrics.rateLimitRejections.add(1, { tenant_id: tenantId, limit_type: 'runs' });
    return false;
  }

  counters.runs++;
  evalMetrics.rateLimitQueueDepth.add(1, { tenant_id: tenantId, resource: 'runs' });
  return true;
}

/**
 * Release a run slot when run completes or fails.
 */
export function releaseRunSlot(tenantId: string): void {
  const counters = tenantCounters.get(tenantId);
  if (counters && counters.runs > 0) {
    counters.runs--;
    counters.lastActivity = Date.now();
    evalMetrics.rateLimitQueueDepth.add(-1, { tenant_id: tenantId, resource: 'runs' });
  }
}

/**
 * Attempt to acquire a conversation slot. Returns true if allowed.
 */
export function acquireConversationSlot(tenantId: string, tier?: string): boolean {
  const counters = getCounters(tenantId);
  const limits = getLimits(tier);
  counters.lastActivity = Date.now();

  if (counters.conversations >= limits.maxConcurrentConversations) {
    log.warn('Eval rate limit: max concurrent conversations reached', {
      tenantId,
      current: counters.conversations,
      max: limits.maxConcurrentConversations,
    });
    evalMetrics.rateLimitRejections.add(1, { tenant_id: tenantId, limit_type: 'conversations' });
    return false;
  }

  counters.conversations++;
  evalMetrics.rateLimitQueueDepth.add(1, { tenant_id: tenantId, resource: 'conversations' });
  return true;
}

/**
 * Release a conversation slot.
 */
export function releaseConversationSlot(tenantId: string): void {
  const counters = tenantCounters.get(tenantId);
  if (counters && counters.conversations > 0) {
    counters.conversations--;
    counters.lastActivity = Date.now();
    evalMetrics.rateLimitQueueDepth.add(-1, { tenant_id: tenantId, resource: 'conversations' });
  }
}

/**
 * Check if an LLM call is allowed under the per-minute rate limit.
 * Records the call if allowed. Returns true if allowed.
 */
export function checkLLMRateLimit(tenantId: string, tier?: string): boolean {
  const counters = getCounters(tenantId);
  const limits = getLimits(tier);
  counters.lastActivity = Date.now();
  pruneLLMWindow(counters);

  if (counters.llmCalls.length >= limits.maxLLMCallsPerMinute) {
    log.warn('Eval rate limit: LLM calls per minute exceeded', {
      tenantId,
      current: counters.llmCalls.length,
      max: limits.maxLLMCallsPerMinute,
    });
    evalMetrics.rateLimitRejections.add(1, { tenant_id: tenantId, limit_type: 'llm_calls' });
    return false;
  }

  counters.llmCalls.push(Date.now());
  return true;
}

/**
 * Get current usage for a tenant (for health/admin endpoints).
 */
export function getTenantEvalUsage(
  tenantId: string,
  tier?: string,
): {
  limits: TenantEvalLimits;
  current: { runs: number; conversations: number; llmCallsPerMinute: number };
} {
  const counters = tenantCounters.get(tenantId);
  const limits = getLimits(tier);

  if (!counters) {
    return {
      limits,
      current: { runs: 0, conversations: 0, llmCallsPerMinute: 0 },
    };
  }

  pruneLLMWindow(counters);
  return {
    limits,
    current: {
      runs: counters.runs,
      conversations: counters.conversations,
      llmCallsPerMinute: counters.llmCalls.length,
    },
  };
}

/**
 * Shutdown: clear all counters and stop cleanup timer.
 */
export function shutdownEvalRateLimiter(): void {
  tenantCounters.clear();
  if (cleanupTimer) {
    clearInterval(cleanupTimer);
    cleanupTimer = null;
  }
}
