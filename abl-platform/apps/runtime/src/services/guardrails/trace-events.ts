/**
 * Guardrail trace event types and factory functions.
 *
 * All guardrail execution emits structured trace events via the session's
 * onTraceEvent callback. These factories produce typed, timestamped events
 * for every guardrail concern: checks, violations, warnings, fixes, reasks,
 * pipeline completions, cost tracking, circuit breakers, caching, provider
 * errors, and tool/handoff blocking.
 */

import { createLogger } from '@abl/compiler/platform';

const log = createLogger('guardrail-trace');

// ---------------------------------------------------------------------------
// Event types
// ---------------------------------------------------------------------------

/**
 * All guardrail trace event types.
 * Canonical source: @agent-platform/shared-kernel
 */
export type { GuardrailTraceEventType } from '@agent-platform/shared-kernel';
import type { GuardrailTraceEventType } from '@agent-platform/shared-kernel';

export interface GuardrailTraceEvent {
  type: GuardrailTraceEventType;
  timestamp: number;
  data: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Factory functions
// ---------------------------------------------------------------------------

/** Individual guardrail check result (pass or fail) */
export function traceGuardrailCheck(data: {
  guardrailName: string;
  kind: string;
  tier: string;
  passed: boolean;
  score?: number;
  threshold?: number;
  latencyMs: number;
  agent?: string;
}): GuardrailTraceEvent {
  return { type: 'guardrail_check', timestamp: Date.now(), data };
}

/** Guardrail violation — a check failed and triggered an action */
export function traceGuardrailViolation(data: {
  guardrailName: string;
  kind: string;
  tier: string;
  action: string;
  severity: string;
  message: string;
  score?: number;
  provider?: string;
  agent?: string;
}): GuardrailTraceEvent {
  return { type: 'guardrail_violation', timestamp: Date.now(), data };
}

/** Guardrail warning — a check raised a non-blocking concern */
export function traceGuardrailWarning(data: {
  guardrailName: string;
  kind: string;
  message: string;
  agent?: string;
}): GuardrailTraceEvent {
  return { type: 'guardrail_warning', timestamp: Date.now(), data };
}

/** Guardrail fix — content was automatically modified to pass */
export function traceGuardrailFix(data: {
  guardrailName: string;
  kind: string;
  strategy: string;
  originalLength: number;
  modifiedLength: number;
  agent?: string;
}): GuardrailTraceEvent {
  return { type: 'guardrail_fix', timestamp: Date.now(), data };
}

/** Guardrail re-ask — content was rejected and the LLM was asked to retry */
export function traceGuardrailReask(data: {
  guardrailName: string;
  kind: string;
  reaskCount: number;
  maxReasks: number;
  agent?: string;
}): GuardrailTraceEvent {
  return { type: 'guardrail_reask', timestamp: Date.now(), data };
}

/** Pipeline completed — summary of all checks in a single pipeline run */
export function tracePipelineComplete(data: {
  kind: string;
  totalChecks: number;
  passed: number;
  failed: number;
  warnings: number;
  totalLatencyMs: number;
  costUsd: number;
  cacheHits: number;
  cacheMisses: number;
  agent?: string;
}): GuardrailTraceEvent {
  return { type: 'guardrail_pipeline_complete', timestamp: Date.now(), data };
}

/** Cost tracking event — records spend and budget status */
export function traceGuardrailCost(data: {
  tenantId: string;
  projectId: string;
  costUsd: number;
  currentSpendUsd: number;
  budgetUsd?: number;
  budgetExceeded: boolean;
}): GuardrailTraceEvent {
  return { type: 'guardrail_cost', timestamp: Date.now(), data };
}

/** Circuit breaker state change for a guardrail provider */
export function traceCircuitBreaker(data: {
  provider: string;
  state: string;
  consecutiveFailures?: number;
}): GuardrailTraceEvent {
  return { type: 'guardrail_circuit_breaker', timestamp: Date.now(), data };
}

/** Cache hit — guardrail result served from cache */
export function traceCacheHit(data: {
  guardrailName: string;
  tier: string;
  key: string;
}): GuardrailTraceEvent {
  return { type: 'guardrail_cache_hit', timestamp: Date.now(), data };
}

/** Cache miss — guardrail result not in cache, will evaluate */
export function traceCacheMiss(data: {
  guardrailName: string;
  tier: string;
  key: string;
}): GuardrailTraceEvent {
  return { type: 'guardrail_cache_miss', timestamp: Date.now(), data };
}

/** Provider error — a guardrail provider failed to respond */
export function traceProviderError(data: {
  provider: string;
  error: string;
  guardrailName: string;
}): GuardrailTraceEvent {
  return { type: 'guardrail_provider_error', timestamp: Date.now(), data };
}

/** Tool call blocked by a guardrail */
export function traceToolBlocked(data: {
  toolName: string;
  guardrailName: string;
  reason: string;
  agent?: string;
}): GuardrailTraceEvent {
  return { type: 'guardrail_tool_blocked', timestamp: Date.now(), data };
}

/** Tool output blocked by a guardrail */
export function traceToolOutputBlocked(data: {
  toolName: string;
  guardrailName: string;
  reason: string;
  agent?: string;
}): GuardrailTraceEvent {
  return { type: 'guardrail_tool_output_blocked', timestamp: Date.now(), data };
}

/** Handoff blocked by a guardrail */
export function traceHandoffBlocked(data: {
  fromAgent: string;
  toAgent: string;
  guardrailName: string;
  reason: string;
}): GuardrailTraceEvent {
  return { type: 'guardrail_handoff_blocked', timestamp: Date.now(), data };
}

/** Pipeline-level error — the guardrail pipeline itself failed */
export function tracePipelineError(data: {
  kind: string;
  error: string;
  guardrailName?: string;
  agent?: string;
  toolName?: string;
}): GuardrailTraceEvent {
  return { type: 'guardrail_pipeline_error', timestamp: Date.now(), data };
}
