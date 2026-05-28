/**
 * Tiered Resolver — Determines which action tier to apply based on pipeline classifier output.
 *
 * Pure function, no I/O. Called by the reasoning executor after the intent bridge
 * populates session state.
 *
 * Tiers:
 *   1 — Programmatic (confidence >= programmaticThreshold): deterministic actions
 *   2 — Guided (confidence >= guidedThreshold): LLM reasoning with hints
 *   3 — Autonomous (below thresholds or pipeline failure): full LLM reasoning
 */

import type { AgentIR } from '@abl/compiler';
import { DEFAULT_MESSAGES } from '@abl/compiler';
import type {
  ClassifierResult,
  RoutingMatch,
  IntentBridgeConfig,
  TieredAction,
  GuidedHints,
} from './types.js';
import { findRoutingMatch } from './intent-bridge.js';

/**
 * Resolve the tiered action for a pipeline result.
 *
 * This function does NOT handle existing short-circuit or fan-out actions
 * (those are handled before this function is called). It only handles:
 *   - Tier 1: Out-of-scope decline (category=null, high confidence)
 *   - Tier 2: Guided mode (medium confidence, tool hiding, multi-intent signals)
 *   - Tier 3: Autonomous (low confidence or missing data)
 */
export function resolveTieredAction(
  classifierResult: ClassifierResult | undefined,
  routingMatches: RoutingMatch[],
  config: IntentBridgeConfig,
  agentIR: AgentIR,
  resolveMessage?: (messageKey: string, fallbackMessage?: string) => string,
): TieredAction {
  // No classifier result → Tier 3
  if (!classifierResult || classifierResult.intents.length === 0) {
    return {
      tier: 3,
      action: 'autonomous',
      reason: classifierResult ? 'empty intents' : 'no classifier result',
    };
  }

  const intents = classifierResult.intents;
  const primary = intents.reduce((best, current) =>
    current.confidence > best.confidence ? current : best,
  );

  // ─── Tier 1: Programmatic Out-of-Scope Decline ─────────────────────────
  // Use the classifier's scope-aware out_of_scope flag when available.
  // Fall back to category === null for backward compatibility with classifiers
  // that don't set out_of_scope (legacy path).
  const isOutOfScope = primary.out_of_scope ?? primary.category === null;

  if (
    config.outOfScopeDecline &&
    isOutOfScope &&
    primary.confidence >= config.programmaticThreshold &&
    hasLimitations(agentIR)
  ) {
    const message = resolveOutOfScopeMessage(agentIR, resolveMessage);
    return {
      tier: 1,
      action: 'decline_out_of_scope',
      message,
    };
  }

  // ─── Tier 2: Guided Mode ──────────────────────────────────────────────

  if (primary.confidence >= config.guidedThreshold) {
    const hints: GuidedHints = {
      hiddenTools: resolveHiddenTools(routingMatches, agentIR),
    };

    // Add routing hint for single-intent guided mode
    const primaryMatch = findRoutingMatch(primary, routingMatches);
    if (intents.length === 1 && primaryMatch?.target) {
      hints.routingHint = `Pipeline classifier suggests routing to ${primaryMatch.target} (confidence: ${primary.confidence.toFixed(2)})`;
    }

    // Multi-intent signal
    if (
      config.multiIntentSignal &&
      intents.length >= 2 &&
      intents.every((i) => i.confidence >= config.guidedThreshold)
    ) {
      const matchedTargets = routingMatches.map((m) => m.target).filter(Boolean);
      const allDifferentTargets = new Set(matchedTargets).size > 1;

      hints.multiIntentSignal = {
        intents: intents.map((i) => {
          const match = findRoutingMatch(i, routingMatches);
          return {
            category: i.category,
            target: match?.target ?? null,
            summary: i.summary,
            confidence: i.confidence,
          };
        }),
        suggestedAction: allDifferentTargets ? 'sequential_handoff' : 'address_primary',
      };
    }

    return {
      tier: 2,
      action: 'guided',
      hints,
    };
  }

  // ─── Tier 3: Autonomous ───────────────────────────────────────────────

  return {
    tier: 3,
    action: 'autonomous',
    reason: `low confidence (${primary.confidence.toFixed(2)} < ${config.guidedThreshold})`,
  };
}

// =============================================================================
// HELPERS
// =============================================================================

/**
 * Check if the agent has a LIMITATIONS section (non-empty limitations array).
 * Out-of-scope decline only makes sense when the agent declares what it can't do.
 */
function hasLimitations(agentIR: AgentIR): boolean {
  return (agentIR.identity?.limitations?.length ?? 0) > 0;
}

/**
 * Resolve the out-of-scope decline message.
 * Uses agent's custom `out_of_scope` message if set, otherwise the platform default.
 */
function resolveOutOfScopeMessage(
  agentIR: AgentIR,
  resolveMessage?: (messageKey: string, fallbackMessage?: string) => string,
): string {
  return (
    resolveMessage?.(
      'out_of_scope',
      agentIR.messages?.out_of_scope ?? DEFAULT_MESSAGES.out_of_scope,
    ) ??
    agentIR.messages?.out_of_scope ??
    DEFAULT_MESSAGES.out_of_scope
  );
}

/**
 * Determine which handoff tools to hide based on routing match targets.
 *
 * If routing matches identified specific targets, hide handoff tools that point
 * to agents NOT in the matched target list.
 */
function resolveHiddenTools(routingMatches: RoutingMatch[], agentIR: AgentIR): string[] {
  const matchedTargets = new Set(routingMatches.map((m) => m.target).filter(Boolean) as string[]);

  // If no concrete targets identified, don't hide anything
  if (matchedTargets.size === 0) {
    return [];
  }

  const hidden: string[] = [];

  // Check routing rules (supervisor handoffs)
  if (agentIR.routing?.rules) {
    for (const rule of agentIR.routing.rules) {
      if (!matchedTargets.has(rule.to)) {
        // Never hide escalation handoff tools — they are safety-critical
        const isEscalation = rule.to.toLowerCase().includes('escalat');
        if (!isEscalation) {
          hidden.push(`handoff_to_${rule.to}`);
        }
      }
    }
  }

  // Check coordination handoffs (non-supervisor handoffs)
  if (agentIR.coordination?.handoffs) {
    for (const handoff of agentIR.coordination.handoffs) {
      if (!matchedTargets.has(handoff.to)) {
        // Never hide escalation handoff tools — they are safety-critical
        const isEscalation = handoff.to.toLowerCase().includes('escalat');
        if (!isEscalation) {
          hidden.push(`handoff_to_${handoff.to}`);
        }
      }
    }
  }

  return hidden;
}
