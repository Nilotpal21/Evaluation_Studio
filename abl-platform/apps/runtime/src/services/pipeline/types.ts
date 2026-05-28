/**
 * Pipeline Module Types
 *
 * Types for the opt-in classification and tool filtering pipeline
 * that runs before the reasoning loop.
 */

import type { ToolDefinition } from '@abl/compiler/platform/llm/types.js';
import type { IntentRelationship } from '@abl/compiler/platform/nlu/types.js';

// =============================================================================
// CONFIGURATION
// =============================================================================

/** Intent bridge configuration — controls how pipeline classifier output guides reasoning */
export interface IntentBridgeConfig {
  /** Whether intent bridging is active (default: true when pipeline enabled) */
  enabled: boolean;
  /** Confidence threshold for Tier 1 programmatic actions (default: 0.85) */
  programmaticThreshold: number;
  /** Confidence threshold for Tier 2 guided actions (default: 0.5) */
  guidedThreshold: number;
  /** Programmatic decline when target=null + high confidence (default: true) */
  outOfScopeDecline: boolean;
  /** Inject multi-intent hint into system prompt (default: true) */
  multiIntentSignal: boolean;
}

/** Pipeline configuration — resolved from agent IR → project config → defaults */
export interface PipelineConfig {
  enabled: boolean;
  mode: 'parallel' | 'sequential';
  /** Model source: 'default' uses resolveLanguageModel('tool_selection'), 'tenant' uses a specific TenantModel */
  modelSource: 'default' | 'tenant';
  /** TenantModel ID — required when modelSource is 'tenant' */
  tenantModelId?: string;
  shortCircuit: {
    enabled: boolean;
    confidenceThreshold: number;
  };
  toolFilter: {
    enabled: boolean;
    maxTools: number;
  };
  keywordVeto: {
    enabled: boolean;
    keywords: string[];
  };
  intentBridge: IntentBridgeConfig;
}

/** Default pipeline configuration */
export const DEFAULT_PIPELINE_CONFIG: PipelineConfig = {
  enabled: false,
  mode: 'parallel',
  modelSource: 'default',
  shortCircuit: {
    enabled: true,
    confidenceThreshold: 0.85,
  },
  toolFilter: {
    enabled: true,
    maxTools: 6,
  },
  keywordVeto: {
    enabled: true,
    keywords: [],
  },
  intentBridge: {
    enabled: true,
    programmaticThreshold: 0.85,
    guidedThreshold: 0.5,
    outOfScopeDecline: true,
    multiIntentSignal: true,
  },
};

// =============================================================================
// INTENT BRIDGE STATE
// =============================================================================

/** Intent state populated by the intent bridge into session.data.values.intent */
export interface PipelineIntentState {
  /** Resolved intent category from WHEN condition reverse map (null if unknown) */
  category: string | null;
  /** Classifier confidence score */
  confidence: number;
  /** True when target is null and confidence is high — indicates out-of-scope */
  out_of_scope: boolean;
  /** Target agent name from classifier (null for in-agent or out-of-scope) */
  target: string | null;
  /** Brief description of the detected intent */
  summary: string;
  /** Number of intents detected in the message */
  intent_count: number;
}

/** Guided hints passed to the reasoning loop in Tier 2 */
export interface GuidedHints {
  /** Tool names to remove from the LLM's tool set (classifier says irrelevant) */
  hiddenTools: string[];
  /** Soft routing guidance for system prompt */
  routingHint?: string;
  /** Multi-intent signal when 2+ intents detected but sub-threshold for fan-out */
  multiIntentSignal?: {
    intents: Array<{
      category: string | null;
      target: string | null;
      summary: string;
      confidence: number;
    }>;
    suggestedAction: 'sequential_handoff' | 'address_primary' | 'ask_clarification';
  };
}

/** Tiered action — discriminated union of possible intent bridge outcomes */
export type TieredAction =
  | { tier: 1; action: 'short_circuit'; target: string; message: string }
  | { tier: 1; action: 'fan_out'; targets: Array<{ target: string; intent: string }> }
  | { tier: 1; action: 'decline_out_of_scope'; message: string }
  | { tier: 2; action: 'guided'; hints: GuidedHints }
  | { tier: 3; action: 'autonomous'; reason: string };

// =============================================================================
// CLASSIFIER RESULTS
// =============================================================================

/** Single detected intent from the classifier */
export interface ClassifiedIntent {
  /** Intent category name, or null for out-of-scope */
  category: string | null;
  /** Confidence score 0.0-1.0 */
  confidence: number;
  /** Brief description of the intent */
  summary: string;
  /** Scope-aware out-of-scope flag — set by classifier when AgentScopeContext is provided */
  out_of_scope?: boolean;
}

/** Full classifier output */
export interface ClassifierResult {
  intents: ClassifiedIntent[];
  /** Relationship between multiple detected intents, when known */
  relationship?: IntentRelationship;
}

/** Result of system-side WHEN evaluation for a classified intent */
export interface RoutingMatch {
  /** The classified intent that was evaluated */
  intent: ClassifiedIntent;
  /** The matched routing target (agent name), or null if no rule matched */
  target: string | null;
  /** The routing rule that matched, if any */
  matchedRule?: {
    to: string;
    when: string;
    priority: number;
  };
}

// =============================================================================
// TOOL FILTER RESULTS
// =============================================================================

/** Tool filter output */
export interface ToolFilterResult {
  /** Filtered tool names selected by the pipeline model */
  selectedTools: string[];
  /** Whether the filter fell back to the full tool set */
  fellBack: boolean;
}

// =============================================================================
// PIPELINE RESULT
// =============================================================================

/** Result of a full pipeline run */
export interface PipelineResult {
  /** If true, skip the reasoning loop and route directly */
  shortCircuit: boolean;
  /** Handoff input for short-circuit routing (target, message, context) */
  handoffInput?: {
    target: string;
    message: string;
    context?: Record<string, unknown>;
  };
  /** Fan-out targets for multi-intent short-circuit (bypasses supervisor entirely) */
  fanOutTargets?: Array<{
    target: string;
    intent: string;
    context?: Record<string, unknown>;
  }>;
  /** Filtered tools to use in the reasoning loop (undefined = use all) */
  filteredTools?: ToolDefinition[];
  /** Classifier result for trace/observability */
  classifierResult?: ClassifierResult;
  /** Tool filter result for trace/observability */
  toolFilterResult?: ToolFilterResult;
}

// =============================================================================
// TRACE EVENTS
// =============================================================================

export type PipelineTraceEvent =
  | {
      type: 'pipeline_classify';
      data: {
        intents: ClassifiedIntent[];
        model: string;
        latencyMs: number;
      };
    }
  | {
      type: 'pipeline_filter';
      data: {
        originalToolCount: number;
        filteredTools: string[];
        model: string;
        latencyMs: number;
      };
    }
  | {
      type: 'pipeline_short_circuit';
      data: {
        target: string;
        confidence: number;
        intentSummary: string;
      };
    }
  | {
      type: 'pipeline_keyword_veto';
      data: {
        matchedKeywords: string[];
        vetoedTarget: string;
      };
    }
  | {
      type: 'pipeline_multi_intent';
      data: {
        intentCount: number;
        targets: (string | null)[];
        mergedTools: string[];
      };
    }
  | {
      type: 'pipeline_multi_intent_short_circuit';
      data: {
        targets: string[];
        intents: string[];
        confidences: number[];
      };
    }
  | {
      type: 'pipeline_intent_bridge';
      data: {
        intentState: PipelineIntentState;
        tier: number;
      };
    }
  | {
      type: 'pipeline_tiered_action';
      data: {
        tier: number;
        action: string;
        details: Record<string, unknown>;
      };
    }
  | {
      type: 'pipeline_out_of_scope_decline';
      data: {
        message: string;
        confidence: number;
        summary: string;
      };
    };

import type { TraceEvent as BaseTraceEvent } from '@agent-platform/shared-kernel';

/** Trace event shape used across the runtime — relaxes type to string for pipeline events */
export type TraceEvent = Omit<BaseTraceEvent, 'type' | 'timestamp'> & {
  type: string;
  data: Record<string, unknown>;
};

/** Callback for emitting pipeline trace events */
export type OnTraceEvent = (event: TraceEvent | PipelineTraceEvent) => void;
