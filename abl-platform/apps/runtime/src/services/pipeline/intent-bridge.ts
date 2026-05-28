/**
 * Intent Bridge — Maps pipeline classifier output to session state and multi-intent types.
 *
 * Pure functions, no I/O. The reasoning executor calls these after the pipeline
 * classifier runs and the routing resolver evaluates WHEN conditions, to populate
 * session.data.values.intent and (optionally) produce a DetectedMultiIntentResult
 * for the existing handleMultiIntent() infrastructure.
 *
 * Since the classifier now returns categories directly and the routing resolver
 * provides targets, the old reverse-map from targets to categories
 * (buildTargetCategoryMap / extractCategoriesFromWhen) is no longer needed.
 */

import type {
  ClassifierResult,
  ClassifiedIntent,
  RoutingMatch,
  PipelineIntentState,
} from './types.js';
import type { MultiIntentResult, IntentRelationship } from '@abl/compiler/platform/nlu/types.js';
import type {
  DetectedIntent,
  DetectedMultiIntentResult,
} from '../execution/multi-intent/multi-intent-types.js';

export const SUPERVISOR_TOOL_CALL_INTENT_SUMMARY = 'supervisor_tool_call';

type HighConfidenceMultiIntentMode = 'parallel' | 'sequential' | 'reasoning';

// =============================================================================
// CLASSIFIER + ROUTING → SESSION STATE BRIDGE
// =============================================================================

/**
 * Map classifier output + routing matches to a PipelineIntentState for
 * session.data.values.intent.
 *
 * Uses the primary intent (highest confidence) from the classifier result.
 * The routing resolver has already evaluated WHEN conditions and resolved
 * targets — we just look up the match for the primary intent.
 */
export function bridgeIntentsToSessionState(
  classifierResult: ClassifierResult,
  routingMatches: RoutingMatch[],
): PipelineIntentState {
  const intents = classifierResult.intents;

  if (intents.length === 0) {
    return {
      category: null,
      confidence: 0,
      out_of_scope: false,
      target: null,
      summary: '',
      intent_count: 0,
    };
  }

  // Pick primary intent (highest confidence)
  const primary = intents.reduce((best, current) =>
    current.confidence > best.confidence ? current : best,
  );

  // Find the routing match for the primary intent
  const match = findRoutingMatch(primary, routingMatches);

  return {
    category: primary.category,
    confidence: primary.confidence,
    // Use classifier's scope-aware out_of_scope when available (set when
    // AgentScopeContext was provided), otherwise fall back to category === null
    out_of_scope: primary.out_of_scope ?? primary.category === null,
    target: match?.target ?? null,
    summary: primary.summary,
    intent_count: intents.length,
  };
}

// =============================================================================
// CLASSIFIER + ROUTING → MULTI-INTENT RESULT BRIDGE
// =============================================================================

/**
 * Bridge classifier + routing matches to a DetectedMultiIntentResult for the
 * multi-intent dispatch infrastructure.
 *
 * Returns null for single-intent results (no multi-intent dispatch needed).
 */
export function bridgeToDetectedMultiIntent(
  classifierResult: ClassifierResult,
  routingMatches: RoutingMatch[],
  userMessage?: string,
): DetectedMultiIntentResult | null {
  const intents = classifierResult.intents;

  if (intents.length < 2) {
    return null;
  }

  const relationship = inferIntentRelationship(classifierResult, routingMatches, userMessage);
  const ordered =
    relationship.type === 'dependent'
      ? [...intents]
      : [...intents].sort((a, b) => b.confidence - a.confidence);

  return {
    primary: toDetectedIntent(ordered[0], routingMatches),
    alternatives: ordered.slice(1).map((intent) => toDetectedIntent(intent, routingMatches)),
    relationships: relationship,
  };
}

/**
 * Map classifier intents to the existing MultiIntentResult type used by
 * routing-executor.handleMultiIntent().
 *
 * Returns null for single-intent results (no multi-intent dispatch needed).
 */
export function bridgeToMultiIntentResult(
  classifierResult: ClassifierResult,
  routingMatches: RoutingMatch[],
  userMessage?: string,
): MultiIntentResult | null {
  const intents = classifierResult.intents;

  if (intents.length < 2) {
    return null;
  }

  const relationship = inferIntentRelationship(classifierResult, routingMatches, userMessage);
  // Dependent intent order is semantic execution order. Independent intents can
  // keep confidence ordering because no result dependency exists.
  const ordered =
    relationship.type === 'dependent'
      ? [...intents]
      : [...intents].sort((a, b) => b.confidence - a.confidence);
  const primary = ordered[0];
  const alternatives = ordered.slice(1);

  return {
    primary: {
      intent: resolveIntentName(primary, routingMatches),
      confidence: primary.confidence,
      source: 'fast' as const,
    },
    alternatives: alternatives.map((alt) => ({
      intent: resolveIntentName(alt, routingMatches),
      confidence: alt.confidence,
      source: 'fast' as const,
    })),
    relationships: relationship,
  };
}

export function inferIntentRelationship(
  classifierResult: ClassifierResult,
  routingMatches: RoutingMatch[],
  _userMessage?: string,
): IntentRelationship {
  if (classifierResult.relationship) {
    return classifierResult.relationship;
  }

  const intents = classifierResult.intents;
  const targets = intents.map((i) => findRoutingMatch(i, routingMatches)?.target ?? null);
  const hasNull = targets.some((t) => t === null);

  if (hasNull) {
    return { type: 'ambiguous', reasoning: 'One or more intents have no routing target' };
  }

  // Ephemeral set — bounded by intents.length (max_intents config, default 3), no eviction needed
  const uniqueCount = targets.filter((t, i, arr) => arr.indexOf(t) === i).length;
  if (uniqueCount === 1) {
    return { type: 'dependent', reasoning: 'All intents target the same agent' };
  }

  return {
    type: 'ambiguous',
    reasoning: 'Classifier did not provide an intent relationship for cross-target intents',
  };
}

export function resolveHighConfidenceMultiIntentMode(input: {
  classifierResult: ClassifierResult;
  routingMatches: RoutingMatch[];
  userMessage?: string;
  shortCircuitEnabled: boolean;
  confidenceThreshold: number;
}): { mode: HighConfidenceMultiIntentMode; relationship?: IntentRelationship } {
  const { classifierResult, routingMatches } = input;

  if (
    !input.shortCircuitEnabled ||
    routingMatches.length < 2 ||
    routingMatches.some((match) => match.target === null) ||
    !classifierResult.intents.every((intent) => intent.confidence >= input.confidenceThreshold)
  ) {
    return { mode: 'reasoning' };
  }

  const relationship = inferIntentRelationship(classifierResult, routingMatches, input.userMessage);

  if (relationship.type === 'independent') {
    return { mode: 'parallel', relationship };
  }

  if (relationship.type === 'dependent') {
    return { mode: 'sequential', relationship };
  }

  return { mode: 'reasoning', relationship };
}

/**
 * Build a DetectedIntent from an explicit supervisor routing tool call.
 *
 * source=tool_call intents represent a completed supervisor routing decision;
 * downstream code MUST NOT keyword-scan their summary/text to derive a different
 * agent target. Keep the raw supervisor routing utterance out of intent/summary
 * and preserve it only as optional context for telemetry.
 */
export function bridgeSupervisorToolCallToDetectedIntent(input: {
  target: string;
  message?: string;
  userMessage: string;
  context?: Record<string, unknown>;
}): DetectedIntent | null {
  const target = input.target.trim();
  if (!target) {
    return null;
  }

  const routingMessage =
    typeof input.message === 'string' && input.message.trim()
      ? input.message.trim()
      : input.userMessage.trim();
  const context = {
    ...(input.context ?? {}),
    ...(routingMessage ? { supervisorRoutingMessage: routingMessage } : {}),
  };

  return {
    intent: target,
    target: { kind: 'agent', ref: target, label: target },
    category: null,
    summary: SUPERVISOR_TOOL_CALL_INTENT_SUMMARY,
    confidence: 1,
    source: 'tool_call',
    ...(Object.keys(context).length > 0 ? { context } : {}),
  };
}

// =============================================================================
// INTERNAL HELPERS
// =============================================================================

/**
 * Convert a classified intent + its routing match to a DetectedIntent.
 */
function toDetectedIntent(
  intent: ClassifiedIntent,
  routingMatches: RoutingMatch[],
): DetectedIntent {
  const match = findRoutingMatch(intent, routingMatches);
  const summary = intent.summary || intent.category || 'unknown';

  return {
    intent: summary,
    target: match?.target
      ? {
          kind: 'agent',
          ref: match.target,
          label: match.target,
        }
      : null,
    category: intent.category,
    summary,
    confidence: intent.confidence,
    source: 'pipeline',
  };
}

/**
 * Resolve an intent name from classifier output using the routing match.
 * Prefers category, falls back to the target name, then summary.
 */
function resolveIntentName(intent: ClassifiedIntent, routingMatches: RoutingMatch[]): string {
  if (intent.category) return intent.category;
  const match = findRoutingMatch(intent, routingMatches);
  if (match?.target) return match.target;
  return intent.summary || 'unknown';
}

/**
 * Find the routing match for a given classified intent.
 * Matches by reference identity first, then falls back to matching by
 * category + confidence + summary for resilience.
 */
export function findRoutingMatch(
  intent: ClassifiedIntent,
  routingMatches: RoutingMatch[],
): RoutingMatch | undefined {
  // Prefer reference identity
  const byRef = routingMatches.find((m) => m.intent === intent);
  if (byRef) return byRef;

  // Fallback: match by category + confidence + summary
  return routingMatches.find(
    (m) =>
      m.intent.category === intent.category &&
      m.intent.confidence === intent.confidence &&
      m.intent.summary === intent.summary,
  );
}
