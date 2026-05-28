/**
 * LLM Trace Cost Attribution + Rollup
 *
 * Two responsibilities, both for COST analytics only — not for the
 * customer-facing AI-disclosure contract:
 *
 *  1. `classifyLlmTraceForCostAttribution(eventData)` — the wider sibling
 *     of `classifyLlmTraceForDisclosure` (in response-provenance.ts).
 *     It treats many more runtime-emitted `purpose` / `operationType` /
 *     `context` strings as "internal_only" so cost rollups attribute
 *     platform-overhead LLM spend (routing, guardrails, eval judges,
 *     classification, …) correctly.
 *
 *  2. `rollupAgentTokenCost(traceEvents)` — pure aggregator that walks
 *     `llm_call` trace events, extracts tokens from the multiple shapes
 *     emitters use, prices via `estimateCost`, and returns total /
 *     customer-visible / per-model breakdowns.
 *
 * DO NOT use this classifier for AI-disclosure metadata. The disclosure
 * contract (kind: 'llm' | 'scripted' | 'mixed', disclaimerRequired) MUST
 * use `classifyLlmTraceForDisclosure` (alias `classifyLlmTraceVisibility`)
 * from `response-provenance.ts`. The two taxonomies are intentionally
 * different sizes — disclosure is narrow (compliance contract), cost
 * attribution is wide (analytics accuracy).
 *
 * Used by:
 * - packages/pipeline-engine (eval conversation cost rollup)
 * - Future: runtime cost analytics, session cost tracking, cost dashboard
 */

import { estimateCost } from './model-pricing.js';

// ── Visibility Classification (cost-attribution taxonomy) ─────────────

/**
 * Visibility for cost-attribution purposes. Three-state to match the
 * disclosure classifier's vocabulary for ergonomic interchange, but the
 * semantics here are narrower in scope: "did this LLM call contribute
 * to the customer-facing response, or was it platform overhead?"
 */
export type LlmTraceVisibility = 'ignored' | 'internal_only' | 'customer_visible';

// Module-level static lookup tables — not runtime caches. No MAX_SIZE /
// TTL needed because content is fixed at module load and never mutated.
//
// These sets are intentionally WIDER than the disclosure taxonomy in
// `response-provenance.ts`. They aim to attribute every platform-overhead
// LLM call (routing decisions, guardrail evaluation, classification, eval
// judges, validation, summarization, etc.) as `internal_only` so the
// `customerVisibleCost` rollup only sums actual response-generation cost.
const INTERNAL_ONLY_PURPOSES_FOR_COST = new Set([
  'entity_extraction',
  'field_validation',
  'gather_extraction',
  'extraction_attempt',
  'extraction_fallback',
  'extraction_strategy_resolved',
  'kb_search',
  'intent_classification',
  'guardrail_check',
  'guardrail_reask',
  'guardrail_fix',
  'completion_check',
  'engine_decision',
  'routing',
  'handoff_condition_check',
  'eval_judge',
  'eval_persona',
  'scoring',
  'classification',
]);
const INTERNAL_ONLY_OPERATION_TYPES_FOR_COST = new Set([
  'extraction',
  'kb_classify',
  'kb_classify_vocab',
  'validation',
  'tool_selection',
  'summarization',
  'coordination',
]);
const INTERNAL_ONLY_RESPONSE_CONTRIBUTION = 'internal_only';
const CUSTOMER_VISIBLE_RESPONSE_CONTRIBUTION = 'customer_visible';
const IGNORED_RESPONSE_CONTRIBUTIONS = new Set(['none', 'simulated']);
const FALLBACK_MODEL_ID = 'fallback (no API key)';

/**
 * Classify an LLM call for COST ATTRIBUTION. Do NOT use for disclosure
 * metadata — use `classifyLlmTraceForDisclosure` from response-provenance.ts
 * for that.
 *
 * Priority: simulated/fallback (ignored) → responseContribution → purpose
 * → operationType → context → default customer_visible.
 */
export function classifyLlmTraceForCostAttribution(
  eventData: Record<string, unknown>,
): LlmTraceVisibility {
  if (eventData.simulated === true || eventData.model === FALLBACK_MODEL_ID) {
    return 'ignored';
  }

  const responseContribution =
    typeof eventData.responseContribution === 'string' ? eventData.responseContribution : undefined;
  if (responseContribution === INTERNAL_ONLY_RESPONSE_CONTRIBUTION) {
    return 'internal_only';
  }
  if (responseContribution === CUSTOMER_VISIBLE_RESPONSE_CONTRIBUTION) {
    return 'customer_visible';
  }
  if (responseContribution && IGNORED_RESPONSE_CONTRIBUTIONS.has(responseContribution)) {
    return 'ignored';
  }

  const purpose = typeof eventData.purpose === 'string' ? eventData.purpose : undefined;
  if (purpose && INTERNAL_ONLY_PURPOSES_FOR_COST.has(purpose)) {
    return 'internal_only';
  }

  const operationType =
    typeof eventData.operationType === 'string' ? eventData.operationType : undefined;
  if (operationType && INTERNAL_ONLY_OPERATION_TYPES_FOR_COST.has(operationType)) {
    return 'internal_only';
  }

  // Cost-attribution fallback: some emitters use `context` as a free-form
  // classification hint when purpose/operationType aren't set. Treat it as
  // a fallback for the same internal-only lookup. (Not present in the
  // disclosure classifier on purpose — disclosure is more conservative.)
  const context = typeof eventData.context === 'string' ? eventData.context : undefined;
  if (
    context &&
    (INTERNAL_ONLY_PURPOSES_FOR_COST.has(context) ||
      INTERNAL_ONLY_OPERATION_TYPES_FOR_COST.has(context))
  ) {
    return 'internal_only';
  }

  return 'customer_visible';
}

// ── Cost Rollup ───────────────────────────────────────────────────────

/**
 * Result of rolling up token costs from trace events.
 */
export interface TokenCostRollup {
  /** Total cost across all attributable LLM calls (dollars). Excludes
   *  `ignored` calls (simulated runs, fallback model). */
  totalCost: number;
  /** Cost of customer-visible LLM calls only (dollars). */
  customerVisibleCost: number;
  /** Cost broken down by model ID. */
  costByModel: Record<string, number>;
  /** Total input tokens across attributable calls. */
  totalInputTokens: number;
  /** Total output tokens across attributable calls. */
  totalOutputTokens: number;
}

/**
 * Minimal trace event shape required for cost rollup.
 * Compatible with both the canonical TraceEvent and the relaxed eval TraceEvent.
 */
export interface TraceEventForCostRollup {
  type: string;
  data: Record<string, unknown>;
}

/**
 * Extract input token count from trace event data.
 * The runtime emits tokens in multiple shapes depending on the emitter:
 *  - `tokensIn` (reasoning-executor, flow-step-executor flat fields)
 *  - `inputTokens` (canonical field name)
 *  - `tokenUsage.input` (trace-manager-adapter nested object)
 *  - `usage.inputTokens` (LLM provider response shape)
 */
function extractInputTokens(data: Record<string, unknown>): number {
  if (typeof data.tokensIn === 'number') return data.tokensIn;
  if (typeof data.inputTokens === 'number') return data.inputTokens;
  if (data.tokenUsage && typeof data.tokenUsage === 'object') {
    const usage = data.tokenUsage as Record<string, unknown>;
    if (typeof usage.input === 'number') return usage.input;
  }
  if (data.usage && typeof data.usage === 'object') {
    const usage = data.usage as Record<string, unknown>;
    if (typeof usage.inputTokens === 'number') return usage.inputTokens;
  }
  return 0;
}

/** Same multi-shape handling as extractInputTokens. */
function extractOutputTokens(data: Record<string, unknown>): number {
  if (typeof data.tokensOut === 'number') return data.tokensOut;
  if (typeof data.outputTokens === 'number') return data.outputTokens;
  if (data.tokenUsage && typeof data.tokenUsage === 'object') {
    const usage = data.tokenUsage as Record<string, unknown>;
    if (typeof usage.output === 'number') return usage.output;
  }
  if (data.usage && typeof data.usage === 'object') {
    const usage = data.usage as Record<string, unknown>;
    if (typeof usage.outputTokens === 'number') return usage.outputTokens;
  }
  return 0;
}

export function rollupAgentTokenCost(traceEvents: TraceEventForCostRollup[]): TokenCostRollup {
  const result: TokenCostRollup = {
    totalCost: 0,
    customerVisibleCost: 0,
    costByModel: {},
    totalInputTokens: 0,
    totalOutputTokens: 0,
  };

  for (const event of traceEvents) {
    if (event.type !== 'llm_call') continue;

    const data = event.data;
    if (!data) continue;

    // Use the cost-attribution classifier specifically — NOT the disclosure
    // one. The wider taxonomy is the point: a routing/guardrail LLM call
    // should attribute to internal cost, not customer-visible cost, even
    // though it remains customer_visible for AI-disclosure purposes.
    const visibility = classifyLlmTraceForCostAttribution(data);
    if (visibility === 'ignored') continue;

    const model = typeof data.model === 'string' ? data.model : 'unknown';
    const inputTokens = extractInputTokens(data);
    const outputTokens = extractOutputTokens(data);

    if (inputTokens === 0 && outputTokens === 0) continue;

    const cost = estimateCost(model, inputTokens, outputTokens);

    result.totalCost += cost;
    result.totalInputTokens += inputTokens;
    result.totalOutputTokens += outputTokens;
    result.costByModel[model] = (result.costByModel[model] ?? 0) + cost;

    if (visibility === 'customer_visible') {
      result.customerVisibleCost += cost;
    }
  }

  return result;
}
