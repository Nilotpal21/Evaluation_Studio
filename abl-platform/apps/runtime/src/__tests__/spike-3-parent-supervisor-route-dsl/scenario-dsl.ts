/**
 * SPIKE 3 — Typed scenario DSL for detectParentSupervisorRoute pure decision functions.
 *
 * Goal: prove that the deterministic-core pattern extends from already-pure
 * subsystems (router — ABLP-938) to I/O-coupled orchestration code by
 * exercising the two pure functions extracted from
 * `flow-step-executor.detectParentSupervisorRoute`:
 *
 *   - evaluateParentSupervisorRoutePrecheck (gate logic; no I/O)
 *   - evaluateParentSupervisorRouteAfterClassifier (post-classifier decision;
 *     handles all 4 ClassifierOutcome kinds)
 *
 * Production and tests both call these functions. There is no parallel
 * implementation. Trace effects are returned as data; tests assert on them.
 */

import { expect as vitestExpect } from 'vitest';
import type { AgentIR, IntentCategory, RoutingRule } from '@abl/compiler/platform/ir/schema.js';
import type { ClassifiedIntent } from '../../services/pipeline/index.js';
import {
  evaluateParentSupervisorRoutePrecheck,
  evaluateParentSupervisorRouteAfterClassifier,
  type ParentSupervisorRoutePrecheckInput,
  type ParentSupervisorRoutePrecheckProceed,
  type ParentSupervisorRoutePrecheckResult,
  type ClassifierOutcome,
  type ParentSupervisorRouteAfterClassifierInput,
  type ParentSupervisorRouteAfterClassifierResult,
} from '../../services/execution/flow-step-executor.js';

// ─── Type-level exhaustiveness check for ClassifierOutcome kinds ──────────────
//
// Per the design doc: every discriminated-union state consumed by a pure
// function gets a scenario. The `satisfies` clause turns a missing kind into
// a compile error.
export const CLASSIFIER_OUTCOME_SCENARIO_INDEX = {
  not_attempted: 'S_NOT_ATTEMPTED',
  model_unavailable: 'S_MODEL_UNAVAILABLE',
  failed: 'S_FAILED',
  classified: 'S_CLASSIFIED', // covered by multiple sub-scenarios
} as const satisfies Record<ClassifierOutcome['kind'], string>;

// ─── Fixture builders ─────────────────────────────────────────────────────────

export interface SupervisorIRSpec {
  name: string;
  goal?: string;
  categories: ReadonlyArray<string | IntentCategory>;
  rules: ReadonlyArray<{
    to: string;
    when: string;
    priority?: number;
    description?: string;
    return?: boolean;
  }>;
  lexicalFallback?: 'never' | 'when_unavailable' | 'always';
  minConfidence?: number;
}

export function supervisorIR(spec: SupervisorIRSpec): AgentIR {
  const categories: IntentCategory[] = spec.categories.map((c) =>
    typeof c === 'string' ? { name: c } : c,
  );
  return {
    ir_version: '1.0',
    metadata: {
      name: spec.name,
      version: '1.0.0',
      type: 'supervisor',
      compiled_at: new Date().toISOString(),
      source_hash: 'spike-3-hash',
      compiler_version: '1.0.0',
    },
    execution: { mode: 'reasoning', max_turns: 10, max_tool_iterations: 5 },
    identity: {
      name: spec.name,
      goal: spec.goal ?? 'Spike 3 supervisor',
      persona: '',
    },
    tools: [],
    gather: { fields: [], mode: 'conversational', strategy: 'progressive' },
    memory: { enabled: false },
    constraints: { rules: [] },
    coordination: {
      handoffs: spec.rules.map((r) => ({
        to: r.to,
        condition: r.when,
        return: r.return ?? true,
      })),
      delegates: [],
    },
    completion: { conditions: [] },
    error_handling: { handlers: [], default_action: 'respond' },
    routing: {
      rules: spec.rules.map((r, idx) => ({
        to: r.to,
        when: r.when,
        priority: r.priority ?? idx + 1,
        description: r.description ?? `route to ${r.to}`,
      })),
      default_agent: spec.rules[0]?.to ?? '',
      intent_classification: {
        categories,
        min_confidence: spec.minConfidence ?? 0.7,
        source: 'explicit',
        ...(spec.lexicalFallback ? { lexical_fallback: spec.lexicalFallback } : {}),
      },
    },
  } as unknown as AgentIR;
}

/** Build a classifier intent fixture. */
export function classifiedIntent(spec: {
  category: string;
  confidence?: number;
  summary?: string;
}): ClassifiedIntent {
  return {
    category: spec.category,
    confidence: spec.confidence ?? 0.95,
    summary: spec.summary ?? `intent for ${spec.category}`,
  };
}

// ─── Runners ──────────────────────────────────────────────────────────────────

export function runPrecheck(
  input: Partial<ParentSupervisorRoutePrecheckInput> & {
    parentIR: AgentIR | null;
    currentMessage: string;
  },
): ParentSupervisorRoutePrecheckResult {
  return evaluateParentSupervisorRoutePrecheck({
    suppressParentSupervisorRoute: input.suppressParentSupervisorRoute ?? false,
    activeThreadReturnExpected: input.activeThreadReturnExpected ?? true,
    threadStackLength: input.threadStackLength ?? 1,
    parentIR: input.parentIR,
    currentMessage: input.currentMessage,
  });
}

export interface AfterClassifierScenarioInput {
  parentIR: AgentIR;
  classifierOutcome: ClassifierOutcome;
  parentValues?: Record<string, unknown>;
  currentMessage: string;
}

export function runAfterClassifier(
  input: AfterClassifierScenarioInput,
): ParentSupervisorRouteAfterClassifierResult {
  const precheck = evaluateParentSupervisorRoutePrecheck({
    suppressParentSupervisorRoute: false,
    activeThreadReturnExpected: true,
    threadStackLength: 1,
    parentIR: input.parentIR,
    currentMessage: input.currentMessage,
  });
  if (precheck.kind !== 'proceed') {
    throw new Error(`Test setup error: precheck unexpectedly skipped (${precheck.reason})`);
  }
  return evaluateParentSupervisorRouteAfterClassifier({
    precheck,
    classifierOutcome: input.classifierOutcome,
    parentValues: input.parentValues ?? {},
    currentMessage: input.currentMessage,
  });
}

// ─── Typed expect helpers ────────────────────────────────────────────────────

export const expect = {
  precheckSkip(
    result: ParentSupervisorRoutePrecheckResult,
    reason: Extract<ParentSupervisorRoutePrecheckResult, { kind: 'skip' }>['reason'],
  ): void {
    vitestExpect(result.kind, JSON.stringify(result)).toBe('skip');
    if (result.kind === 'skip') {
      vitestExpect(result.reason).toBe(reason);
    }
  },
  precheckProceed(
    result: ParentSupervisorRoutePrecheckResult,
  ): ParentSupervisorRoutePrecheckProceed {
    vitestExpect(result.kind, JSON.stringify(result)).toBe('proceed');
    if (result.kind !== 'proceed') {
      throw new Error('expected proceed');
    }
    return result;
  },
  afterClassifierRoute(
    result: ParentSupervisorRouteAfterClassifierResult,
    target: string,
    detectionMode: 'pipeline' | 'lexical',
  ): void {
    vitestExpect(result.kind, JSON.stringify(result)).toBe('route');
    if (result.kind === 'route') {
      vitestExpect(result.route.target).toBe(target);
      vitestExpect(result.route.detectionMode).toBe(detectionMode);
    }
  },
  afterClassifierNoRoute(
    result: ParentSupervisorRouteAfterClassifierResult,
    reason: Extract<ParentSupervisorRouteAfterClassifierResult, { kind: 'no_route' }>['reason'],
  ): void {
    vitestExpect(result.kind, JSON.stringify(result)).toBe('no_route');
    if (result.kind === 'no_route') {
      vitestExpect(result.reason).toBe(reason);
    }
  },
  effectEmitted(result: ParentSupervisorRouteAfterClassifierResult, type: string): void {
    const found = result.effects.some((e) => e.type === type);
    vitestExpect(found, `expected effect type=${type} in ${JSON.stringify(result.effects)}`).toBe(
      true,
    );
  },
  /**
   * Assert a specific effect was emitted AND its payload contains the given
   * subset of fields (semantic check, not just presence). Catches the
   * design-doc anti-pattern of asserting count/order without payload.
   */
  effectWithPayload(
    result: ParentSupervisorRouteAfterClassifierResult,
    type: string,
    payloadSubset: Record<string, unknown>,
  ): void {
    const matching = result.effects.filter((e) => e.type === type);
    vitestExpect(
      matching.length,
      `expected at least one effect type=${type}, got ${result.effects.length} events`,
    ).toBeGreaterThan(0);
    const someMatch = matching.some((e) =>
      Object.entries(payloadSubset).every(([key, expected]) => {
        const actual = (e.data as Record<string, unknown>)[key];
        return JSON.stringify(actual) === JSON.stringify(expected);
      }),
    );
    vitestExpect(
      someMatch,
      `expected effect type=${type} with payload subset ${JSON.stringify(payloadSubset)} in ${JSON.stringify(matching)}`,
    ).toBe(true);
  },
  /**
   * Assert effects appear in the expected order (by `type`). Catches reordering
   * regressions where trace events still emit but in a sequence that breaks
   * downstream replay/analysis.
   */
  effectOrder(
    result: ParentSupervisorRouteAfterClassifierResult,
    expectedTypes: ReadonlyArray<string>,
  ): void {
    const actualTypes = result.effects.map((e) => e.type);
    let lastIndex = -1;
    for (const expected of expectedTypes) {
      const found = actualTypes.indexOf(expected, lastIndex + 1);
      vitestExpect(
        found,
        `expected effect ${expected} after index ${lastIndex} in [${actualTypes.join(', ')}]`,
      ).toBeGreaterThan(lastIndex);
      lastIndex = found;
    }
  },
};

// ─── Determinism helper ───────────────────────────────────────────────────────

export function expectDeterministicAfterClassifier(input: AfterClassifierScenarioInput): void {
  const a = runAfterClassifier(input);
  const b = runAfterClassifier(input);
  vitestExpect(a).toEqual(b);
}
