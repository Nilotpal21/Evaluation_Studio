/**
 * Guardrail Pipeline Orchestrator — tiered evaluation with early termination.
 *
 * Orchestrates guardrail evaluation across three tiers:
 *   Tier 1 (local): CEL-based checks — fast, deterministic, zero cost
 *   Tier 2 (model): Model-based safety classifiers — provider registry dispatch
 *   Tier 3 (llm):   LLM-based natural language checks — injected LLM function
 *
 * Execution flow:
 *   1. Filter guardrails by kind (input, output, tool_input, tool_output, handoff)
 *   2. Group by tier and sort each group by priority (lower = first)
 *   3. Evaluate Tier 1 — if any terminal action (block/escalate), stop early
 *   4. Evaluate Tier 2 — if any terminal action, stop early
 *   5. Evaluate Tier 3 — LLM-based checks via injected function
 *
 * Early termination ensures expensive higher-tier checks are skipped when
 * a cheap local check already blocks the content.
 */

import type { Guardrail, GuardrailAction, GuardrailKind } from '../ir/schema.js';
import { buildGuardrailCelContext } from '../constructs/guardrail-context.js';
import type { GuardrailContext, GuardrailPipelineResult, GuardrailViolation } from './types.js';
import { addViolation, createEmptyPipelineResult, isTerminalAction } from './types.js';
import { Tier1Evaluator } from './tier1-evaluator.js';
import { Tier2Evaluator } from './tier2-evaluator.js';
import { Tier3Evaluator } from './tier3-evaluator.js';
import type { LLMEvalFunction } from './tier3-evaluator.js';
import type { GuardrailProviderRegistry } from './provider-registry.js';
import { applyActions } from './action-applier.js';
import { createLogger } from '../logger.js';
import type { PIIRecognizerRegistry } from '../security/pii-recognizer-registry.js';

const log = createLogger('guardrail-pipeline');

const VALID_ACTION_TYPES = new Set<string>([
  'block',
  'warn',
  'redact',
  'fix',
  'reask',
  'filter',
  'escalate',
]);

function isValidGuardrailAction(action: unknown): action is GuardrailAction {
  if (!action || typeof action !== 'object') return false;
  const a = action as Record<string, unknown>;
  return typeof a.type === 'string' && VALID_ACTION_TYPES.has(a.type);
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function getStringField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === 'string' ? value : undefined;
}

function getNumberField(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function getSeverityField(
  record: Record<string, unknown>,
  key: string,
): GuardrailViolation['severity'] | undefined {
  const value = record[key];
  return value === 'safe' ||
    value === 'low' ||
    value === 'medium' ||
    value === 'high' ||
    value === 'critical'
    ? value
    : undefined;
}

function getCachedViolationPayload(
  value: unknown,
  fallbackAction?: GuardrailAction['type'],
): CachedTier2ViolationPayload | null {
  if (!isObjectRecord(value)) {
    return null;
  }

  const actionValue = getStringField(value, 'action') ?? fallbackAction;
  if (!actionValue || !VALID_ACTION_TYPES.has(actionValue)) {
    return null;
  }
  const action = actionValue as GuardrailAction['type'];

  return {
    action,
    resolvedAction: isValidGuardrailAction(value.resolvedAction) ? value.resolvedAction : undefined,
    severity: getSeverityField(value, 'severity'),
    score: getNumberField(value, 'score'),
    threshold: getNumberField(value, 'threshold'),
    category: getStringField(value, 'category'),
    label: getStringField(value, 'label'),
    message: getStringField(value, 'message'),
    explanation: getStringField(value, 'explanation'),
    priority: getNumberField(value, 'priority'),
    provider: getStringField(value, 'provider'),
  };
}

function getLegacyCachedViolation(
  cached: Record<string, unknown>,
  key: 'violations' | 'warnings',
  guard: Guardrail,
): CachedTier2ViolationPayload | null {
  const collection = cached[key];
  if (!Array.isArray(collection)) {
    return null;
  }

  const matchingEntry = collection.find((entry) => {
    if (!isObjectRecord(entry)) {
      return false;
    }

    const cachedName = getStringField(entry, 'name');
    return cachedName === guard.name || (collection.length === 1 && !cachedName);
  });

  return getCachedViolationPayload(matchingEntry, key === 'warnings' ? 'warn' : guard.action.type);
}

function normalizeCachedTier2Outcome(
  cached: unknown,
  guard: Guardrail,
): CachedTier2GuardOutcome | null {
  if (!isObjectRecord(cached)) {
    return null;
  }

  const directAction = getStringField(cached, 'action');
  const directPayload = getCachedViolationPayload(cached, guard.action.type);

  if (
    (cached.outcome === 'pass' || cached.outcome === 'warning' || cached.outcome === 'violation') &&
    typeof cached.passed === 'boolean'
  ) {
    if (cached.outcome === 'pass') {
      return { passed: true, outcome: 'pass', cachedAt: getNumberField(cached, 'cachedAt') };
    }

    const violation = getCachedViolationPayload(
      cached.violation,
      (directAction as GuardrailAction['type'] | undefined) ?? guard.action.type,
    );
    if (!violation) {
      return null;
    }

    return {
      passed: cached.passed,
      outcome: cached.outcome,
      violation,
      cachedAt: getNumberField(cached, 'cachedAt'),
    };
  }

  const legacyViolation = getLegacyCachedViolation(cached, 'violations', guard);
  if (legacyViolation) {
    return {
      passed: false,
      outcome: 'violation',
      violation: legacyViolation,
      cachedAt: getNumberField(cached, 'cachedAt'),
    };
  }

  const legacyWarning = getLegacyCachedViolation(cached, 'warnings', guard);
  if (legacyWarning) {
    return {
      passed: true,
      outcome: 'warning',
      violation: legacyWarning,
      cachedAt: getNumberField(cached, 'cachedAt'),
    };
  }

  if (directPayload) {
    const directOutcome =
      directPayload.action === 'warn'
        ? 'warning'
        : cached.outcome === 'violation'
          ? 'violation'
          : cached.passed === true
            ? 'warning'
            : 'violation';
    return {
      passed: directOutcome !== 'violation',
      outcome: directOutcome,
      violation: directPayload,
      cachedAt: getNumberField(cached, 'cachedAt'),
    };
  }

  if (cached.passed === true) {
    return { passed: true, outcome: 'pass', cachedAt: getNumberField(cached, 'cachedAt') };
  }

  return null;
}

function buildCachedTier2GuardOutcome(
  guard: Guardrail,
  result: GuardrailPipelineResult,
): CachedTier2GuardOutcome {
  const violation = result.violations.find((entry) => entry.name === guard.name);
  if (violation) {
    return {
      passed: false,
      outcome: 'violation',
      violation: {
        action: violation.action,
        resolvedAction: violation.resolvedAction,
        severity: violation.severity,
        score: violation.score,
        threshold: violation.threshold,
        category: violation.category,
        label: violation.label,
        message: violation.message,
        explanation: violation.explanation,
        priority: violation.priority,
        provider: violation.provider,
      },
      cachedAt: Date.now(),
    };
  }

  const warning = result.warnings.find((entry) => entry.name === guard.name);
  if (warning) {
    return {
      passed: true,
      outcome: 'warning',
      violation: {
        action: warning.action,
        resolvedAction: warning.resolvedAction,
        severity: warning.severity,
        score: warning.score,
        threshold: warning.threshold,
        category: warning.category,
        label: warning.label,
        message: warning.message,
        explanation: warning.explanation,
        priority: warning.priority,
        provider: warning.provider,
      },
      cachedAt: Date.now(),
    };
  }

  return {
    passed: true,
    outcome: 'pass',
    cachedAt: Date.now(),
  };
}

function replayCachedTier2Outcome(
  result: GuardrailPipelineResult,
  guard: Guardrail,
  cachedOutcome: CachedTier2GuardOutcome,
): void {
  result.metrics.totalChecks++;

  if (cachedOutcome.outcome === 'pass') {
    result.metrics.passed++;
    return;
  }

  const cachedViolation = cachedOutcome.violation;
  if (!cachedViolation) {
    result.metrics.passed++;
    return;
  }

  const resolvedAction =
    cachedViolation.resolvedAction && isValidGuardrailAction(cachedViolation.resolvedAction)
      ? cachedViolation.resolvedAction
      : {
          ...guard.action,
          type: cachedViolation.action,
          ...(cachedViolation.message !== undefined ? { message: cachedViolation.message } : {}),
        };

  const violation: GuardrailViolation = {
    name: guard.name,
    kind: guard.kind,
    tier: 'model',
    action: cachedViolation.action,
    resolvedAction,
    severity: cachedViolation.severity ?? (cachedOutcome.outcome === 'warning' ? 'medium' : 'high'),
    score: cachedViolation.score,
    threshold: cachedViolation.threshold ?? guard.threshold,
    category: cachedViolation.category,
    label: cachedViolation.label,
    message: cachedViolation.message ?? resolvedAction.message ?? guard.description,
    explanation: cachedViolation.explanation,
    priority: cachedViolation.priority ?? guard.priority,
    latencyMs: 0,
    provider: cachedViolation.provider ?? guard.provider,
  };

  addViolation(result, violation);
}

async function runBestEffortPipelineSideEffect(
  sideEffect: string,
  fn: () => Promise<void>,
): Promise<void> {
  try {
    await fn();
  } catch (error) {
    log.warn('Guardrail pipeline side effect failed', {
      sideEffect,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * Policy overrides resolved from MongoDB at runtime.
 *
 * When provided, these overrides are merged with IR-compiled guardrails:
 *   - `disabledGuardrails` removes guardrails by name before evaluation
 *   - `ruleOverrides` patches threshold or action on specific guardrails
 *   - `settings` provides pipeline-wide configuration (failMode)
 */
export interface PipelinePolicy {
  disabledGuardrails?: string[];
  ruleOverrides?: Array<{
    guardrailName: string;
    override: 'threshold' | 'action' | 'severity_actions';
    threshold?: number;
    action?: GuardrailAction;
    severityActions?: Record<string, GuardrailAction>;
  }>;
  providerOverrides?: Array<{
    providerName: string;
    endpoint?: string;
    defaultCategory?: string;
    defaultThreshold?: number;
    costPerEvalUsd?: number;
    /** When false, the provider is treated as unregistered (failMode applies). */
    isActive?: boolean;
    circuitBreaker?: {
      failureThreshold?: number;
      resetTimeoutMs?: number;
      failMode?: 'open' | 'closed';
    };
    retry?: { maxRetries?: number; backoffBaseMs?: number };
  }>;
  settings?: {
    failMode?: 'open' | 'closed';
    timeouts?: {
      local?: number;
      model?: number;
      llm?: number;
    };
  };
  caching?: {
    enabled?: boolean;
    exactMatch?: boolean;
    defaultTtlSeconds?: number;
  };
  budget?: {
    monthlyLimitUsd: number;
    overspendAction: 'downgrade' | 'disable_model_checks' | 'alert_only';
  };
  webhook?: {
    url: string;
    secret: string;
  };
  /** Guardrails defined by DB policies (not in agent DSL). Merged with DSL guardrails at evaluation time. */
  additionalGuardrails?: Guardrail[];
  /** Constitutional AI principles injected as Tier 3 LLM prompt prefix. */
  constitution?: Array<{
    principle: string;
    weight: number;
    examples?: string[];
  }>;
}

interface CachedTier2ViolationPayload {
  action: GuardrailAction['type'];
  resolvedAction?: GuardrailAction;
  severity?: GuardrailViolation['severity'];
  score?: number;
  threshold?: number;
  category?: string;
  label?: string;
  message?: string;
  explanation?: string;
  priority?: number;
  provider?: string;
}

interface CachedTier2GuardOutcome {
  passed: boolean;
  outcome: 'pass' | 'warning' | 'violation';
  violation?: CachedTier2ViolationPayload;
  cachedAt?: number;
}

// ---------------------------------------------------------------------------
// Port interfaces — dependency-injected from runtime, no runtime imports here
// ---------------------------------------------------------------------------

/**
 * Cache port for guardrail evaluation result deduplication.
 * Only Tier 1 (local) and Tier 2 (model) results are cached.
 * Tier 3 (llm) results are context-dependent and never cached.
 */
export interface GuardrailCachePort {
  get(guardrailName: string, content: string, tier: string): Promise<unknown | null>;
  set(guardrailName: string, content: string, tier: string, result: unknown): Promise<void>;
}

/**
 * Cost checker port for budget enforcement.
 * Allows the pipeline to skip expensive tiers when budget is exceeded.
 */
export interface CostCheckerPort {
  checkBudget(): Promise<{
    exceeded: boolean;
    action: 'downgrade' | 'disable_model_checks' | 'alert_only' | 'none';
  }>;
  recordCost(costUsd: number): Promise<void>;
}

/**
 * Webhook port for fire-and-forget event delivery.
 */
export interface WebhookPort {
  deliver(event: { type: string; timestamp: number; data: Record<string, unknown> }): Promise<void>;
}

export class GuardrailPipelineImpl {
  private tier1 = new Tier1Evaluator();
  private tier2: Tier2Evaluator;
  private tier3: Tier3Evaluator;
  private cache?: GuardrailCachePort;
  private costChecker?: CostCheckerPort;
  private webhook?: WebhookPort;
  private piiRecognizerRegistry?: PIIRecognizerRegistry;

  constructor(
    registry?: GuardrailProviderRegistry,
    llmEval?: LLMEvalFunction,
    options?: {
      cache?: GuardrailCachePort;
      costChecker?: CostCheckerPort;
      webhook?: WebhookPort;
      piiRecognizerRegistry?: PIIRecognizerRegistry;
    },
  ) {
    this.tier2 = new Tier2Evaluator(registry);
    this.tier3 = new Tier3Evaluator(llmEval);
    this.cache = options?.cache;
    this.costChecker = options?.costChecker;
    this.webhook = options?.webhook;
    this.piiRecognizerRegistry = options?.piiRecognizerRegistry;
  }

  /**
   * Execute the guardrail pipeline for the given content and kind.
   *
   * @param guardrails - All guardrails defined for the agent
   * @param content - The content to evaluate (user input, agent output, etc.)
   * @param kind - Which guardrail kind to evaluate
   * @param context - Additional context for CEL variables
   * @param onTraceEvent - Optional callback for trace event emission
   * @param policy - Optional runtime policy overrides from MongoDB
   * @returns Pipeline result with violations, warnings, and metrics
   */
  async execute(
    guardrails: Guardrail[],
    content: string,
    kind: GuardrailKind,
    context: GuardrailContext,
    onTraceEvent?: (event: unknown) => void,
    policy?: PipelinePolicy,
  ): Promise<GuardrailPipelineResult> {
    // 1. Merge policy-defined additional guardrails with DSL guardrails
    const allGuardrails = [...guardrails, ...(policy?.additionalGuardrails ?? [])];

    // 1a. Filter by kind
    let applicable = allGuardrails.filter((g) => g.kind === kind);

    // 1b. Apply policy: remove disabled guardrails
    if (policy?.disabledGuardrails?.length) {
      const disabledSet = new Set(policy.disabledGuardrails);
      const beforeCount = applicable.length;
      applicable = applicable.filter((g) => !disabledSet.has(g.name));
      if (applicable.length < beforeCount) {
        log.debug('Policy disabled guardrails', {
          disabled: policy.disabledGuardrails,
          removedCount: beforeCount - applicable.length,
        });
      }
    }

    // 1c. Apply policy: rule overrides (threshold, action)
    if (policy?.ruleOverrides?.length) {
      const overrideMap = new Map(policy.ruleOverrides!.map((o) => [o.guardrailName, o]));
      applicable = applicable.map((g) => {
        const override = overrideMap.get(g.name);
        if (!override) return g;

        const patched = { ...g };
        if (override.override === 'threshold' && override.threshold !== undefined) {
          patched.threshold = override.threshold;
          log.debug('Policy overrode threshold', {
            guardrailName: g.name,
            originalThreshold: g.threshold,
            newThreshold: override.threshold,
          });
        }
        if (override.override === 'action' && override.action) {
          if (isValidGuardrailAction(override.action)) {
            patched.action = override.action;
            log.debug('Policy overrode action', {
              guardrailName: g.name,
              originalAction: g.action.type,
              newAction: patched.action.type,
            });
          } else {
            log.warn('Policy action override rejected: invalid action shape', {
              guardrailName: g.name,
              action: override.action,
            });
          }
        }
        if (override.override === 'severity_actions' && override.severityActions) {
          // severity_actions maps severity levels to actions, e.g. { high: { type: 'block' }, low: { type: 'warn' } }
          // Validate each entry before applying
          const validated: Record<string, GuardrailAction> = {};
          for (const [severity, action] of Object.entries(override.severityActions)) {
            if (isValidGuardrailAction(action)) {
              validated[severity] = action;
            } else {
              log.warn('Policy severity_actions entry rejected: invalid action shape', {
                guardrailName: g.name,
                severity,
                action,
              });
            }
          }
          if (Object.keys(validated).length > 0) {
            patched.severityActions = validated;
            log.debug('Policy overrode severity_actions', {
              guardrailName: g.name,
              severityLevels: Object.keys(validated),
            });
          }
        }
        return patched;
      });
    }

    if (applicable.length === 0) {
      return createEmptyPipelineResult();
    }

    // 2. Group by tier, sort each group by priority (lower = first)
    const tier1Guards = applicable
      .filter((g) => g.tier === 'local')
      .sort((a, b) => a.priority - b.priority);
    const tier2Guards = applicable
      .filter((g) => g.tier === 'model')
      .sort((a, b) => a.priority - b.priority);
    const tier3Guards = applicable
      .filter((g) => g.tier === 'llm')
      .sort((a, b) => a.priority - b.priority);

    // 3. Build CEL context from content and guardrail context
    const celContext = buildGuardrailCelContext(kind, {
      content,
      agentGoal: context.agentGoal,
      toolName: context.toolName,
      toolParameters: context.toolParameters,
      toolResult: context.toolResult,
      toolSuccess: context.toolSuccess,
      toolDurationMs: context.toolDurationMs,
      sourceAgent: context.sourceAgent,
      targetAgent: context.targetAgent,
      handoffContext: context.handoffContext,
      handoffReason: context.handoffReason,
    });
    const piiRecognizerRegistry = context.piiRecognizerRegistry ?? this.piiRecognizerRegistry;

    // Extract failMode from policy settings
    const failMode = policy?.settings?.failMode ?? 'open';
    const timeouts = policy?.settings?.timeouts;

    log.debug('Pipeline executing', {
      kind,
      tier1Count: tier1Guards.length,
      tier2Count: tier2Guards.length,
      tier3Count: tier3Guards.length,
      failMode,
      timeouts,
    });

    // Build action context map up-front so early returns can still apply content-modifying actions
    const actionContexts = new Map(applicable.map((g) => [g.name, g.action]));

    // 4. Execute Tier 1 (local CEL checks)
    const result = await this.tier1.evaluate(tier1Guards, celContext, {
      failMode,
      timeoutMs: timeouts?.local,
      piiRecognizerRegistry,
    });

    // 5. Early termination: if Tier 1 produced a terminal action (block/escalate), stop
    if (!result.passed && result.violations.some((v) => isTerminalAction(v.action))) {
      try {
        applyActions(result, content, actionContexts, { piiRecognizerRegistry });
      } catch {
        /* best-effort */
      }
      log.debug('Tier 1 produced terminal violation, skipping higher tiers', {
        primaryViolation: result.primaryViolation?.name,
      });
      return result;
    }

    // 5a. Budget check — may skip tier2/tier3 if budget exceeded
    let skipTier2 = false;
    let skipTier3 = false;
    if (this.costChecker) {
      try {
        const budget = await this.costChecker.checkBudget();
        if (budget.exceeded) {
          if (budget.action === 'disable_model_checks') {
            skipTier2 = true;
            skipTier3 = true;
            log.debug('Budget exceeded, disabling model checks (tier2 + tier3)');
          } else if (budget.action === 'downgrade') {
            skipTier3 = true;
            log.debug('Budget exceeded, downgrading (skipping tier3)');
          }
        }
      } catch (err) {
        log.warn('Budget check failed, proceeding without budget enforcement', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // 5b. Filter out Tier 2 guardrails whose provider has isActive === false
    const inactiveProviders = new Set(
      (policy?.providerOverrides ?? [])
        .filter((o) => o.isActive === false)
        .map((o) => o.providerName),
    );
    const activeTier2Guards =
      inactiveProviders.size > 0
        ? tier2Guards.filter((g) => !g.provider || !inactiveProviders.has(g.provider))
        : tier2Guards;
    if (inactiveProviders.size > 0 && activeTier2Guards.length < tier2Guards.length) {
      log.debug('Filtered inactive providers from Tier 2', {
        inactiveProviders: [...inactiveProviders],
        removedCount: tier2Guards.length - activeTier2Guards.length,
      });
    }

    // 6. Tier 2 (model-based) — evaluate via provider registry
    if (activeTier2Guards.length > 0 && !skipTier2) {
      // 6a. Check cache for each tier2 guard before evaluation
      const uncachedTier2Guards: typeof activeTier2Guards = [];
      const cachedTier2Outcomes: Array<{
        guard: (typeof activeTier2Guards)[number];
        outcome: CachedTier2GuardOutcome;
      }> = [];
      if (this.cache) {
        for (const guard of activeTier2Guards) {
          try {
            const cached = await this.cache.get(guard.name, content, 'model');
            const cachedOutcome = normalizeCachedTier2Outcome(cached, guard);
            if (cachedOutcome) {
              result.metrics.cacheHits++;
              cachedTier2Outcomes.push({ guard, outcome: cachedOutcome });
              log.debug('Cache hit for tier2 guard', { guardrailName: guard.name });
            } else {
              result.metrics.cacheMisses++;
              uncachedTier2Guards.push(guard);
            }
          } catch {
            result.metrics.cacheMisses++;
            uncachedTier2Guards.push(guard);
          }
        }
      } else {
        uncachedTier2Guards.push(...activeTier2Guards);
      }

      for (const cachedEntry of cachedTier2Outcomes) {
        replayCachedTier2Outcome(result, cachedEntry.guard, cachedEntry.outcome);
      }

      if (uncachedTier2Guards.length > 0) {
        const tier2Result = await this.tier2.evaluate(
          uncachedTier2Guards,
          content,
          {
            recentMessages: context.recentMessages,
            piiRecognizerRegistry,
          },
          {
            failMode,
            piiRecognizerRegistry,
            providerOverrides: policy?.providerOverrides,
            timeoutMs: timeouts?.model,
          },
        );

        // 6b. Store tier2 results in cache
        if (this.cache) {
          for (const guard of uncachedTier2Guards) {
            try {
              await this.cache.set(
                guard.name,
                content,
                'model',
                buildCachedTier2GuardOutcome(guard, tier2Result),
              );
            } catch {
              /* best-effort */
            }
          }
        }

        // Merge Tier 2 results into main result
        result.violations.push(...tier2Result.violations);
        result.warnings.push(...tier2Result.warnings);
        result.metrics.totalChecks += tier2Result.metrics.totalChecks;
        result.metrics.passed += tier2Result.metrics.passed;
        result.metrics.failed += tier2Result.metrics.failed;
        result.metrics.warnings += tier2Result.metrics.warnings;
        result.metrics.tier2LatencyMs = tier2Result.metrics.tier2LatencyMs;
        result.metrics.totalLatencyMs += tier2Result.metrics.tier2LatencyMs;
        result.metrics.costUsd += tier2Result.metrics.costUsd;

        // Update passed status
        if (!tier2Result.passed) {
          result.passed = false;
        }

        // Update primary violation if Tier 2 found a higher-priority one
        if (tier2Result.primaryViolation) {
          if (
            !result.primaryViolation ||
            tier2Result.primaryViolation.priority < result.primaryViolation.priority
          ) {
            result.primaryViolation = tier2Result.primaryViolation;
          }
        }
      }

      // Early termination check for Tier 2
      if (!result.passed && result.violations.some((v) => isTerminalAction(v.action))) {
        try {
          applyActions(result, content, actionContexts, { piiRecognizerRegistry });
        } catch {
          /* best-effort */
        }
        log.debug('Tier 2 produced terminal violation, skipping Tier 3', {
          primaryViolation: result.primaryViolation?.name,
        });
        // Record cost before returning
        if (this.costChecker && result.metrics.costUsd > 0) {
          void runBestEffortPipelineSideEffect('record guardrail evaluation cost', () =>
            this.costChecker!.recordCost(result.metrics.costUsd),
          );
        }
        return result;
      }
    }

    // 7. Tier 3 (LLM-based) — evaluate via injected LLM function (never cached)
    if (tier3Guards.length > 0 && !skipTier3) {
      // Truncate content before sending to LLM to bound cost and latency
      const MAX_TIER3_CONTENT_LENGTH = 10_000;
      const tier3Content =
        content.length > MAX_TIER3_CONTENT_LENGTH
          ? content.slice(0, MAX_TIER3_CONTENT_LENGTH) + '\n[... truncated for safety evaluation]'
          : content;

      const tier3Result = await this.tier3.evaluate(
        tier3Guards,
        tier3Content,
        {
          recentMessages: context.recentMessages,
        },
        {
          failMode,
          constitution: policy?.constitution,
          timeoutMs: timeouts?.llm,
        },
      );

      // Merge Tier 3 results into main result
      result.violations.push(...tier3Result.violations);
      result.warnings.push(...tier3Result.warnings);
      result.metrics.totalChecks += tier3Result.metrics.totalChecks;
      result.metrics.passed += tier3Result.metrics.passed;
      result.metrics.failed += tier3Result.metrics.failed;
      result.metrics.warnings += tier3Result.metrics.warnings;
      result.metrics.tier3LatencyMs = tier3Result.metrics.tier3LatencyMs;
      result.metrics.totalLatencyMs += tier3Result.metrics.tier3LatencyMs;
      result.metrics.costUsd += tier3Result.metrics.costUsd;

      // Update passed status
      if (!tier3Result.passed) {
        result.passed = false;
      }

      // Update primary violation if Tier 3 found a higher-priority one
      if (tier3Result.primaryViolation) {
        if (
          !result.primaryViolation ||
          tier3Result.primaryViolation.priority < result.primaryViolation.priority
        ) {
          result.primaryViolation = tier3Result.primaryViolation;
        }
      }
    }

    // 8. Apply non-terminal content-modifying actions (redact, fix, filter)
    try {
      applyActions(result, content, actionContexts, { piiRecognizerRegistry });
    } catch (err) {
      log.warn('Failed to apply guardrail actions, returning result without modifications', {
        error: err instanceof Error ? err.message : String(err),
      });
    }

    // 9. Record cost for budget tracking
    if (this.costChecker && result.metrics.costUsd > 0) {
      void runBestEffortPipelineSideEffect('record guardrail evaluation cost', () =>
        this.costChecker!.recordCost(result.metrics.costUsd),
      );
    }

    // 10. Fire webhook for warn violations (fire-and-forget)
    if (this.webhook && result.warnings.length > 0) {
      void runBestEffortPipelineSideEffect('deliver guardrail warning webhook', () =>
        this.webhook!.deliver({
          type: 'guardrail.warn',
          timestamp: Date.now(),
          data: {
            warnings: result.warnings.map((w) => ({
              name: w.name,
              kind: w.kind,
              tier: w.tier,
              message: w.message,
              severity: w.severity,
            })),
          },
        }),
      );
    }

    return result;
  }
}
