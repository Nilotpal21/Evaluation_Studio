import type {
  AgentIR,
  IntentHandlingConfig,
  MultiIntentStrategy,
} from '@abl/compiler/platform/ir/schema.js';
import type { IntentRelationship, MultiIntentResult } from '@abl/compiler/platform/nlu/types.js';
import type { AgentExecutionType } from '../multi-intent-strategy.js';
import type { FanOutTask } from '../types.js';

/** Platform-level defaults for multi-intent handling (lowest priority in config resolution). */
export const MULTI_INTENT_PLATFORM_DEFAULTS: Required<
  NonNullable<IntentHandlingConfig['multi_intent']>
> = {
  enabled: true,
  strategy: 'primary_queue' as MultiIntentStrategy,
  max_intents: 3,
  confidence_threshold: 0.6,
  queue_max_age_ms: 600_000,
};

export type MultiIntentSource = 'pipeline' | 'reasoning' | 'flow' | 'legacy' | 'tool_call';

export interface MultiIntentTarget {
  kind: 'agent' | 'flow_step';
  ref: string;
  label: string;
}

export interface DetectedIntent {
  /** Human-readable label for prompts, traces, and queue UX. */
  intent: string;
  /** Executable target preserved separately from the display label. */
  target: MultiIntentTarget | null;
  /** Optional classifier/DSL category metadata for observability and analytics. */
  category: string | null;
  /**
   * Concise natural-language description of the intent.
   *
   * Contract: source=tool_call intents represent a completed supervisor routing
   * decision; downstream code MUST NOT keyword-scan their summary/text to derive
   * a different agent target.
   */
  summary: string;
  /** Confidence score for ordering and thresholding. */
  confidence: number;
  /**
   * Which subsystem produced this intent. source=tool_call means the supervisor
   * has already selected the target.
   */
  source: MultiIntentSource;
  /** Optional routing context that should follow the fan-out task. */
  context?: Record<string, unknown>;
}

export interface DetectedMultiIntentResult {
  primary: DetectedIntent;
  alternatives: DetectedIntent[];
  relationships: IntentRelationship;
}

export interface PendingIntentSeed {
  intent: string;
  confidence: number;
  original_message: string;
  label?: string;
  category?: string | null;
  summary?: string;
  source?: MultiIntentSource;
  target?: MultiIntentTarget | null;
  /** Flow step where the intent was originally detected */
  sourceStep?: string;
}

export interface MultiIntentDisambiguationChoice {
  label: string;
  intent: string;
  target: MultiIntentTarget | null;
  category: string | null;
  summary: string;
  confidence: number;
  source: MultiIntentSource;
  /** Flow step where the intent was originally detected */
  sourceStep?: string;
}

export interface ResolvedMultiIntentPlan {
  strategy: MultiIntentStrategy;
  primary: DetectedIntent;
  alternatives: DetectedIntent[];
  relationship: IntentRelationship;
  source: MultiIntentSource;
  maxIntents: number;
  fanOutTasks?: FanOutTask[];
  queueEntries?: PendingIntentSeed[];
  disambiguationChoices?: MultiIntentDisambiguationChoice[];
  disambiguationMessage?: string;
  executionPlan?: Array<{ intent: string; confidence: number }>;
}

/**
 * Result of multi-intent dispatch.
 * Captures what the routing executor decided and provides context for callers.
 */
export interface MultiIntentDispatchResult {
  strategy: MultiIntentStrategy;
  primaryIntent: string;
  queued: boolean;
  disambiguationMessage?: string;
  fanOutTasks?: Array<Pick<FanOutTask, 'target' | 'intent' | 'context'>>;
  executionPlan?: Array<{ intent: string; confidence: number }>;
}

/**
 * Resolve effective multi-intent config with precedence chain:
 *   1. agent-level (DSL): agentIR.intent_handling?.multi_intent
 *   2. project-level (DB): agentIR.project_runtime_config?.multi_intent
 *   3. platform fallback: MULTI_INTENT_PLATFORM_DEFAULTS
 */
export function resolveMultiIntentConfig(
  agentIR: AgentIR,
): Required<NonNullable<IntentHandlingConfig['multi_intent']>> {
  const agentLevel = agentIR.intent_handling?.multi_intent;
  const projectLevel = agentIR.project_runtime_config?.multi_intent;

  return {
    ...MULTI_INTENT_PLATFORM_DEFAULTS,
    ...(projectLevel ?? {}),
    ...(agentLevel ?? {}),
  };
}

/**
 * Derive the agent execution type from the AgentIR for strategy resolution.
 *
 * Resolution order:
 *  1. supervisor — metadata.type === 'supervisor'
 *  2. scripted   — agent has a flow section (flow-based execution)
 *  3. fallback   — execution.mode (backward compat with older IR that still carries mode)
 *  4. default    — 'reasoning'
 */
export function resolveAgentExecutionType(agentIR: AgentIR): AgentExecutionType {
  if (agentIR.metadata.type === 'supervisor') {
    return 'supervisor';
  }
  if (agentIR.flow) {
    return 'scripted';
  }
  if (agentIR.execution?.mode === 'scripted' || agentIR.execution?.mode === 'reasoning') {
    return agentIR.execution.mode;
  }
  return 'reasoning';
}

export function humanizeIntentLabel(value: string): string {
  return value.replace(/_/g, ' ').trim();
}

export function resolveExecutableTarget(intent: Pick<DetectedIntent, 'intent' | 'target'>): string {
  return intent.target?.ref ?? intent.intent;
}

export function resolveIntentDisplayLabel(
  intent: Pick<DetectedIntent, 'intent' | 'summary' | 'category' | 'target'>,
): string {
  const label =
    intent.intent ||
    intent.summary ||
    intent.category ||
    intent.target?.label ||
    intent.target?.ref ||
    '';
  return label.trim();
}

function legacyIntentToDetected(
  intent: MultiIntentResult['primary'],
  source: MultiIntentSource,
): DetectedIntent {
  const label = intent.intent || '';
  const target =
    label.trim().length > 0
      ? {
          kind: 'agent' as const,
          ref: label,
          label,
        }
      : null;

  return {
    intent: label,
    target,
    category: null,
    summary: label,
    confidence: intent.confidence,
    source,
  };
}

export function fromLegacyMultiIntentResult(
  multiResult: MultiIntentResult,
  source: MultiIntentSource = 'legacy',
): DetectedMultiIntentResult {
  return {
    primary: legacyIntentToDetected(multiResult.primary, source),
    alternatives: multiResult.alternatives.map((intent) => legacyIntentToDetected(intent, source)),
    relationships: multiResult.relationships,
  };
}
