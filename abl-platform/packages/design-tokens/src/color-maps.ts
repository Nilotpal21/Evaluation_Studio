/**
 * Centralized Domain → Semantic Intent Mappings
 *
 * This module maps domain-specific concepts (statuses, event types,
 * pipeline stages, etc.) to SemanticIntents. This is the SINGLE place
 * where "healthy = green" or "llm event = blue" is decided.
 *
 * Components should NEVER hardcode color decisions. Instead:
 *   1. Look up the domain value in the appropriate map
 *   2. Get the SemanticIntent
 *   3. Use getIntentStyles() or getBadgeIntentStyles() to get classes
 *
 * Adding a new domain mapping:
 *   1. Define the domain value type (string literal union)
 *   2. Create a Record<DomainValue, SemanticIntent> map
 *   3. Export a typed lookup function with a fallback intent
 */

import type { SemanticIntent } from './intents';

// =============================================================================
// STATUS MAPPINGS — health, lifecycle, circuit breaker states
// =============================================================================

/** Health/operational status → intent */
const STATUS_INTENT_MAP: Record<string, SemanticIntent> = {
  // Positive / operational
  healthy: 'success',
  active: 'success',
  running: 'success',
  connected: 'success',
  online: 'success',
  enabled: 'success',
  completed: 'success',
  resolved: 'success',
  published: 'success',
  deployed: 'success',
  synced: 'success',

  // Warning / transitional
  degraded: 'warning',
  'half-open': 'warning',
  deploying: 'warning',
  pending: 'warning',
  syncing: 'warning',
  draft: 'warning',
  stale: 'warning',
  expiring: 'warning',
  escalated: 'warning',

  // Error / critical
  down: 'error',
  suspended: 'error',
  failed: 'error',
  error: 'error',
  disconnected: 'error',
  disabled: 'error',
  expired: 'error',
  blocked: 'error',
  rejected: 'error',

  // Info / actionable
  open: 'info',
  'in-progress': 'info',
  processing: 'info',
  queued: 'info',

  // Neutral / inactive
  unknown: 'neutral',
  archived: 'neutral',
  closed: 'neutral',
  inactive: 'neutral',
  idle: 'neutral',
  abandoned: 'muted',
};

/**
 * Resolve any status string to a SemanticIntent.
 * Falls back to 'neutral' for unknown statuses.
 */
export function statusIntent(status: string): SemanticIntent {
  return STATUS_INTENT_MAP[status.toLowerCase()] ?? 'neutral';
}

// =============================================================================
// TRACE EVENT TYPE MAPPINGS — runtime observability events
// =============================================================================

/** Trace event type → intent */
const TRACE_EVENT_INTENT_MAP: Record<string, SemanticIntent> = {
  // LLM / inference (accent — the primary action)
  'llm.call': 'accent',
  'llm.response': 'accent',
  llm_call: 'accent',
  inference_start: 'accent',
  inference_complete: 'accent',
  inference_error: 'accent',
  inference_stream_start: 'accent',
  inference_stream_chunk: 'accent',
  inference_stream_end: 'accent',

  // Tool calls (orange — secondary action)
  'tool.call': 'orange',
  'tool.result': 'orange',
  tool_call: 'orange',
  tool_result: 'orange',

  // Agent lifecycle (success — completed actions)
  'agent.start': 'success',
  'agent.end': 'success',
  agent_enter: 'success',
  agent_exit: 'success',
  agent_response: 'success',

  // Handoff / routing (info — routing context)
  'agent.handoff': 'info',
  handoff: 'info',
  handoff_progress: 'info',
  agent_switch: 'info',

  // Errors (error — critical)
  error: 'error',
  'system.error': 'error',
  constraint_violation: 'error',
  digression: 'error',

  // Decisions (purple — reasoning)
  decision: 'purple',
  'agent.decision': 'purple',
  step_thought: 'purple',

  // Guardrails (error/warning)
  guardrail_check: 'error',
  guardrail_violation: 'error',
  guardrail_warning: 'warning',

  // Delegates (purple)
  delegate_start: 'purple',
  delegate_complete: 'purple',
  'agent.delegated': 'purple',

  // Flow (accent)
  flow_step_enter: 'accent',
  flow_step_exit: 'accent',
  flow_transition: 'accent',

  // Warnings
  warning: 'warning',
  constraint_check: 'warning',
  completion_check: 'warning',
};

/**
 * Resolve a trace event type to a SemanticIntent.
 * Falls back to 'muted' for unknown event types.
 */
export function traceEventIntent(eventType: string): SemanticIntent {
  return TRACE_EVENT_INTENT_MAP[eventType] ?? 'muted';
}

// =============================================================================
// PIPELINE STAGE MAPPINGS — search-ai and workflow pipeline stages
// =============================================================================

/** Pipeline stage type → intent */
const PIPELINE_STAGE_INTENT_MAP: Record<string, SemanticIntent> = {
  // Input / extraction (info — data intake)
  extraction: 'info',
  input: 'info',
  source: 'info',
  ingestion: 'info',

  // Transformation (info — data processing)
  transformation: 'info',
  processing: 'info',
  enrichment: 'info',

  // Generation / LLM (purple — AI/LLM)
  generation: 'warning',
  llm: 'purple',
  inference: 'purple',
  ai: 'purple',

  // Output (success — completed output)
  output: 'success',
  response: 'success',
  result: 'success',
  delivery: 'success',

  // Validation / quality (warning — attention needed)
  validation: 'warning',
  quality: 'warning',
  review: 'warning',

  // Custom / external (orange — extensions)
  custom: 'orange',
  external: 'orange',
  webhook: 'orange',
  plugin: 'orange',

  // Error handling (error)
  error: 'error',
  fallback: 'error',
  retry: 'error',

  // Filter / routing (accent)
  filter: 'accent',
  routing: 'accent',
  conditional: 'accent',
};

/**
 * Resolve a pipeline stage type to a SemanticIntent.
 * Falls back to 'neutral' for unknown stage types.
 */
export function pipelineStageIntent(stageType: string): SemanticIntent {
  return PIPELINE_STAGE_INTENT_MAP[stageType.toLowerCase()] ?? 'neutral';
}

// =============================================================================
// PIPELINE NODE TYPE MAPPINGS — visual pipeline editor nodes
// =============================================================================

/** Pipeline node type → intent */
const PIPELINE_NODE_INTENT_MAP: Record<string, SemanticIntent> = {
  llm: 'info',
  prompt: 'info',
  model: 'info',
  output: 'success',
  response: 'success',
  tool: 'orange',
  action: 'orange',
  function: 'orange',
  error: 'error',
  fallback: 'error',
  group: 'info',
  container: 'info',
  trigger: 'warning',
  start: 'warning',
  condition: 'accent',
  router: 'accent',
  transform: 'purple',
};

/**
 * Resolve a pipeline node type to a SemanticIntent.
 * Falls back to 'neutral' for unknown node types.
 */
export function pipelineNodeIntent(nodeType: string): SemanticIntent {
  return PIPELINE_NODE_INTENT_MAP[nodeType.toLowerCase()] ?? 'neutral';
}

// =============================================================================
// FEATURE TIER MAPPINGS — admin feature flags
// =============================================================================

/** Feature tier → intent */
const FEATURE_TIER_INTENT_MAP: Record<string, SemanticIntent> = {
  core: 'success',
  standard: 'info',
  advanced: 'purple',
  premium: 'warning',
  enterprise: 'accent',
  experimental: 'orange',
  deprecated: 'neutral',
};

/**
 * Resolve a feature tier to a SemanticIntent.
 * Falls back to 'neutral' for unknown tiers.
 */
export function featureTierIntent(tier: string): SemanticIntent {
  return FEATURE_TIER_INTENT_MAP[tier.toLowerCase()] ?? 'neutral';
}

// =============================================================================
// SEVERITY MAPPINGS — log levels, guardrail severity, etc.
// =============================================================================

/** Severity level → intent */
const SEVERITY_INTENT_MAP: Record<string, SemanticIntent> = {
  critical: 'error',
  error: 'error',
  high: 'error',
  warn: 'warning',
  warning: 'warning',
  medium: 'warning',
  info: 'info',
  low: 'info',
  debug: 'muted',
  trace: 'muted',
};

/**
 * Resolve a severity level to a SemanticIntent.
 * Falls back to 'muted' for unknown severities.
 */
export function severityIntent(severity: string): SemanticIntent {
  return SEVERITY_INTENT_MAP[severity.toLowerCase()] ?? 'muted';
}

// =============================================================================
// TREND DIRECTION MAPPINGS — KPI cards, metrics
// =============================================================================

/**
 * Resolve a trend direction to a SemanticIntent.
 * Positive trends are success, negative are error, flat is muted.
 */
export function trendIntent(
  direction: 'up' | 'down' | 'flat' | 'positive' | 'negative' | 'neutral',
): SemanticIntent {
  switch (direction) {
    case 'up':
    case 'positive':
      return 'success';
    case 'down':
    case 'negative':
      return 'error';
    case 'flat':
    case 'neutral':
    default:
      return 'muted';
  }
}

// =============================================================================
// CONNECTOR TYPE MAPPINGS — deterministic color from name
// =============================================================================

/**
 * Available intents for connector avatar coloring.
 * Excludes 'muted' and 'neutral' to ensure visual distinction.
 */
const CONNECTOR_PALETTE: SemanticIntent[] = [
  'accent',
  'success',
  'warning',
  'error',
  'info',
  'purple',
  'orange',
];

/**
 * Deterministic intent assignment from a connector name.
 * Uses a simple hash to ensure the same name always gets the same color,
 * while distributing colors evenly across the palette.
 */
export function connectorIntent(name: string): SemanticIntent {
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = (hash * 31 + name.charCodeAt(i)) | 0;
  }
  return CONNECTOR_PALETTE[Math.abs(hash) % CONNECTOR_PALETTE.length];
}
