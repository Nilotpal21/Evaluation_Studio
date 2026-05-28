/**
 * Routing Resolver — System-side WHEN evaluation for pipeline-classified intents.
 *
 * Takes classifier output (categories) and evaluates routing rules using the
 * existing CEL evaluator. This replaces the LLM's interpretation of WHEN conditions
 * with deterministic system-side evaluation.
 *
 * Pure function except for optional trace event emission.
 */

import type { RoutingRule } from '@abl/compiler/platform/ir/schema.js';
import { extractVariableReferences } from '@abl/compiler';
import { nullSafeEvaluateCondition } from './null-safe-eval.js';
import { createLogger } from '@abl/compiler/platform';
import type { ClassifiedIntent, RoutingMatch, OnTraceEvent } from './types.js';
import type { ClassifierMode } from './classifier.js';
import type {
  GatherInterruptCandidateSurface,
  GatherInterruptPolicyApplied,
} from '@agent-platform/shared-kernel';

const log = createLogger('pipeline:routing-resolver');

export type GatherInterruptLexicalFallbackReason = 'semantic_rejection' | 'unavailable';

export function resolveGatherInterruptLexicalFallbackPolicy(
  policy?: GatherInterruptPolicyApplied,
): GatherInterruptPolicyApplied {
  return policy ?? 'when_unavailable';
}

export function shouldAllowGatherInterruptLexicalFallback(
  policy: GatherInterruptPolicyApplied,
  reason: GatherInterruptLexicalFallbackReason,
): boolean {
  if (policy === 'always') {
    return true;
  }

  if (policy === 'never') {
    return false;
  }

  return reason === 'unavailable';
}

export interface GatherInterruptRoutingMetadata {
  candidateSurface: GatherInterruptCandidateSurface;
  policyApplied: GatherInterruptPolicyApplied;
}

export interface RoutingTargetScopeOptions {
  tenantId?: string;
  projectId?: string;
  isTargetInScope: (target: string) => boolean;
}

export interface ResolveRoutingOptions {
  classifierMode?: ClassifierMode;
  gatherInterrupt?: GatherInterruptRoutingMetadata;
  targetScope?: RoutingTargetScopeOptions;
}

export interface ResolvedRoutingMatch extends RoutingMatch {
  gatherInterrupt?: GatherInterruptRoutingMetadata;
}

/**
 * Enrich a context so that every dotted-path variable referenced in the
 * expression has a resolvable value — injecting `null` for missing nested
 * keys on existing objects, and creating stub objects for entirely absent
 * roots that are referenced via dotted paths.
 *
 * Prevents CEL "No such key" errors while preserving valid null-testing
 * semantics (IS NOT SET, == null, || short-circuit).
 *
 * Returns a shallow copy with cloned root objects where needed.
 */
function enrichContextForNestedPaths(
  expression: string,
  context: Record<string, unknown>,
): Record<string, unknown> {
  const vars = extractVariableReferences(expression);
  const dottedVars = vars.filter((v) => v.includes('.'));
  if (dottedVars.length === 0) return context;

  const enriched = { ...context };
  const clonedRoots = new Set<string>();

  for (const v of dottedVars) {
    const parts = v.split('.');
    const root = parts[0];

    if (!(root in enriched) || enriched[root] == null) {
      enriched[root] = {};
      clonedRoots.add(root);
    } else if (!clonedRoots.has(root) && typeof enriched[root] === 'object') {
      enriched[root] = { ...(enriched[root] as Record<string, unknown>) };
      clonedRoots.add(root);
    }

    let cur: unknown = enriched[root];
    for (let i = 1; i < parts.length; i++) {
      if (cur == null || typeof cur !== 'object') break;
      const obj = cur as Record<string, unknown>;
      if (i === parts.length - 1) {
        if (!(parts[i] in obj)) {
          obj[parts[i]] = null;
        }
      } else {
        if (!(parts[i] in obj)) {
          obj[parts[i]] = {};
        }
        cur = obj[parts[i]];
      }
    }
  }

  return enriched;
}

/**
 * Evaluate routing rules against classified intents using the CEL evaluator.
 *
 * For each intent, rules are evaluated in priority order (lowest number = highest priority).
 * The first matching rule wins. If no rule matches, the intent gets a null target.
 *
 * Session values are merged into the evaluation context alongside the intent,
 * enabling rules like `intent.category == "billing" && user.tier == "premium"`.
 *
 * @param intents - Classified intents from the pipeline classifier
 * @param rules - Routing rules with WHEN conditions from the supervisor IR
 * @param sessionValues - Additional context values (session state, user info, etc.)
 * @param onTraceEvent - Optional callback for emitting pipeline trace events
 * @returns One RoutingMatch per intent, in the same order as the input intents
 */
export function resolveRouting(
  intents: ClassifiedIntent[],
  rules: RoutingRule[],
  sessionValues: Record<string, unknown>,
  onTraceEvent?: OnTraceEvent,
  options?: ResolveRoutingOptions,
): ResolvedRoutingMatch[] {
  const sortedRules = [...rules].sort(
    (a, b) => (a.priority ?? Infinity) - (b.priority ?? Infinity),
  );
  const results: ResolvedRoutingMatch[] = [];

  for (const intent of intents) {
    const evalContext: Record<string, unknown> = {
      ...sessionValues,
      intent: {
        category: intent.category,
        confidence: intent.confidence,
      },
    };

    let matched = false;

    for (const rule of sortedRules) {
      if (!rule.when) continue;

      // Enrich context so dotted-path variables have null instead of missing
      // keys. Prevents CEL "No such key" errors while preserving
      // IS NOT SET / == null / || semantics.
      const enrichedContext = enrichContextForNestedPaths(rule.when, evalContext);

      try {
        const conditionMet = nullSafeEvaluateCondition(rule.when, enrichedContext);

        if (conditionMet) {
          if (options?.targetScope) {
            const { tenantId, projectId, isTargetInScope } = options.targetScope;
            if (!tenantId || !projectId) {
              log.warn('routing match rejected due to missing scope envelope', {
                category: intent.category,
                target: rule.to,
                hasTenantId: Boolean(tenantId),
                hasProjectId: Boolean(projectId),
              });
              continue;
            }

            if (!isTargetInScope(rule.to)) {
              log.warn('routing match rejected by target scope validation', {
                category: intent.category,
                target: rule.to,
                tenantId,
                projectId,
              });
              continue;
            }
          }

          results.push({
            intent,
            target: rule.to,
            matchedRule: { to: rule.to, when: rule.when, priority: rule.priority },
            ...(options?.gatherInterrupt ? { gatherInterrupt: options.gatherInterrupt } : {}),
          });
          matched = true;

          log.debug('Routing match found', {
            category: intent.category,
            target: rule.to,
            rule: rule.when,
            priority: rule.priority,
          });
          break;
        }
      } catch (err) {
        log.warn('Rule evaluation failed, skipping', {
          rule: rule.when,
          target: rule.to,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    if (!matched) {
      results.push({
        intent,
        target: null,
        ...(options?.gatherInterrupt ? { gatherInterrupt: options.gatherInterrupt } : {}),
      });
    }
  }

  if (onTraceEvent) {
    onTraceEvent({
      type: 'pipeline_routing_resolve',
      data: {
        intentCount: intents.length,
        classifierMode: options?.classifierMode ?? 'global',
        ...(options?.gatherInterrupt
          ? {
              candidateSurface: options.gatherInterrupt.candidateSurface,
              policyApplied: options.gatherInterrupt.policyApplied,
            }
          : {}),
        matches: results.map((m) => ({
          category: m.intent.category,
          target: m.target,
          matchedRule: m.matchedRule?.when ?? null,
          priority: m.matchedRule?.priority ?? null,
        })),
      },
    });
  }

  return results;
}
