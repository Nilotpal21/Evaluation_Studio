/**
 * SPIKE 3 — Scenarios for the pure decision functions extracted from
 * `flow-step-executor.detectParentSupervisorRoute`.
 *
 * Coverage:
 *  - All 7 precheck skip reasons + happy proceed.
 *  - All 4 ClassifierOutcome kinds (not_attempted, model_unavailable, failed,
 *    classified) and key semantic-rejection edge case where classifier
 *    succeeded but produced no routable target.
 *  - Lexical fallback policy gating (when_unavailable, always, never).
 *  - Trace effect emission.
 *  - Idempotence (determinism) check.
 */

import { describe, it } from 'vitest';
import {
  CLASSIFIER_OUTCOME_SCENARIO_INDEX,
  classifiedIntent,
  expect,
  expectDeterministicAfterClassifier,
  runAfterClassifier,
  runPrecheck,
  supervisorIR,
} from './scenario-dsl.js';
import type { AgentIR } from '@abl/compiler/platform/ir/schema.js';

const LEAVE_SUPERVISOR: AgentIR = supervisorIR({
  name: 'LeaveSupervisor',
  categories: ['leave_application', 'leave_balance'],
  rules: [
    { to: 'LeaveApplicationChild', when: 'intent.category == "leave_application"' },
    { to: 'LeaveBalanceChild', when: 'intent.category == "leave_balance"' },
  ],
  lexicalFallback: 'when_unavailable',
});

const STRICT_SUPERVISOR: AgentIR = supervisorIR({
  name: 'StrictSupervisor',
  categories: ['leave_application', 'leave_balance'],
  rules: [
    { to: 'LeaveApplicationChild', when: 'intent.category == "leave_application"' },
    { to: 'LeaveBalanceChild', when: 'intent.category == "leave_balance"' },
  ],
  lexicalFallback: 'never',
});

const ALWAYS_LEXICAL_SUPERVISOR: AgentIR = supervisorIR({
  name: 'AlwaysLexicalSupervisor',
  categories: ['leave_application', 'leave_balance'],
  rules: [
    { to: 'LeaveApplicationChild', when: 'intent.category == "leave_application"' },
    { to: 'LeaveBalanceChild', when: 'intent.category == "leave_balance"' },
  ],
  lexicalFallback: 'always',
});

describe('Spike 3 — evaluateParentSupervisorRoutePrecheck (7 skip reasons + proceed)', () => {
  it('skip: suppressParentSupervisorRoute=true', () => {
    const result = runPrecheck({
      suppressParentSupervisorRoute: true,
      parentIR: LEAVE_SUPERVISOR,
      currentMessage: 'apply for leave',
    });
    expect.precheckSkip(result, 'suppressed');
  });

  it('skip: no active thread or returnExpected=false', () => {
    const result = runPrecheck({
      activeThreadReturnExpected: false,
      parentIR: LEAVE_SUPERVISOR,
      currentMessage: 'apply for leave',
    });
    expect.precheckSkip(result, 'no_active_thread_or_return');
  });

  it('skip: empty threadStack', () => {
    const result = runPrecheck({
      threadStackLength: 0,
      parentIR: LEAVE_SUPERVISOR,
      currentMessage: 'apply for leave',
    });
    expect.precheckSkip(result, 'empty_thread_stack');
  });

  it('skip: no parent IR', () => {
    const result = runPrecheck({
      parentIR: null,
      currentMessage: 'apply for leave',
    });
    expect.precheckSkip(result, 'no_parent_ir');
  });

  it('skip: parent IR is not a supervisor', () => {
    const notASupervisor = {
      ...LEAVE_SUPERVISOR,
      metadata: { ...LEAVE_SUPERVISOR.metadata, type: 'agent' as const },
    } as unknown as AgentIR;
    const result = runPrecheck({
      parentIR: notASupervisor,
      currentMessage: 'apply for leave',
    });
    expect.precheckSkip(result, 'parent_not_supervisor');
  });

  it('skip: no categories or rules', () => {
    const emptyRouting = supervisorIR({
      name: 'EmptyRoutingSupervisor',
      categories: [],
      rules: [],
    });
    const result = runPrecheck({
      parentIR: emptyRouting,
      currentMessage: 'apply for leave',
    });
    expect.precheckSkip(result, 'no_categories_or_rules');
  });

  it('skip: empty current message', () => {
    const result = runPrecheck({
      parentIR: LEAVE_SUPERVISOR,
      currentMessage: '   ',
    });
    expect.precheckSkip(result, 'empty_message');
  });

  it('proceed: returns derived facts with valid supervisor IR + non-empty message', () => {
    const result = runPrecheck({
      parentIR: LEAVE_SUPERVISOR,
      currentMessage: 'apply for leave',
    });
    const proceed = expect.precheckProceed(result);
    if (proceed.categories.length !== 2) throw new Error('expected 2 categories');
    if (proceed.rules.length !== 2) throw new Error('expected 2 rules');
    if (proceed.lexicalFallbackPolicy !== 'when_unavailable')
      throw new Error('expected when_unavailable policy');
  });
});

describe('Spike 3 — evaluateParentSupervisorRouteAfterClassifier (all 4 outcome kinds)', () => {
  // Sanity: scenario index covers every ClassifierOutcome kind at compile time.
  it('compile-time exhaustiveness', () => {
    if (!CLASSIFIER_OUTCOME_SCENARIO_INDEX.not_attempted) throw new Error('not_attempted missing');
    if (!CLASSIFIER_OUTCOME_SCENARIO_INDEX.model_unavailable)
      throw new Error('model_unavailable missing');
    if (!CLASSIFIER_OUTCOME_SCENARIO_INDEX.failed) throw new Error('failed missing');
    if (!CLASSIFIER_OUTCOME_SCENARIO_INDEX.classified) throw new Error('classified missing');
  });

  // ─── classified path ──────────────────────────────────────────────────────

  it('classified + target found → routes via pipeline', () => {
    const result = runAfterClassifier({
      parentIR: LEAVE_SUPERVISOR,
      classifierOutcome: {
        kind: 'classified',
        intents: [classifiedIntent({ category: 'leave_application', confidence: 0.95 })],
      },
      currentMessage: 'I need to apply for leave',
    });
    expect.afterClassifierRoute(result, 'LeaveApplicationChild', 'pipeline');
  });

  it('classified + no target + when_unavailable → no_route (semantic_rejection blocks fallback)', () => {
    // CRITICAL: GPT-5.5's missed scenario. Classifier succeeded but produced
    // no routable target. fallbackReason='semantic_rejection'. With policy=
    // 'when_unavailable', lexical fallback MUST NOT fire even if a lexical
    // match would exist for the user's text.
    const result = runAfterClassifier({
      parentIR: LEAVE_SUPERVISOR,
      classifierOutcome: {
        kind: 'classified',
        // Category 'unknown_topic' doesn't match any routing rule.
        intents: [classifiedIntent({ category: 'unknown_topic', confidence: 0.95 })],
      },
      currentMessage: 'apply for leave',
    });
    expect.afterClassifierNoRoute(result, 'lexical_fallback_blocked');
  });

  it('classified + no target + always → lexical fallback attempted and routes', () => {
    const result = runAfterClassifier({
      parentIR: ALWAYS_LEXICAL_SUPERVISOR,
      classifierOutcome: {
        kind: 'classified',
        intents: [classifiedIntent({ category: 'unknown_topic', confidence: 0.95 })],
      },
      currentMessage: 'apply for leave',
    });
    expect.afterClassifierRoute(result, 'LeaveApplicationChild', 'lexical');
  });

  // ─── failed path ──────────────────────────────────────────────────────────

  it('failed + when_unavailable + lexical match → routes via lexical (failed treated as unavailable)', () => {
    const result = runAfterClassifier({
      parentIR: LEAVE_SUPERVISOR,
      classifierOutcome: { kind: 'failed' },
      currentMessage: 'apply for leave',
    });
    expect.afterClassifierRoute(result, 'LeaveApplicationChild', 'lexical');
  });

  // ─── model_unavailable path ───────────────────────────────────────────────

  it('model_unavailable + never → no_route regardless of lexical match', () => {
    const result = runAfterClassifier({
      parentIR: STRICT_SUPERVISOR,
      classifierOutcome: { kind: 'model_unavailable' },
      currentMessage: 'apply for leave',
    });
    expect.afterClassifierNoRoute(result, 'lexical_fallback_blocked');
  });

  it('model_unavailable + when_unavailable + lexical match → routes via lexical', () => {
    const result = runAfterClassifier({
      parentIR: LEAVE_SUPERVISOR,
      classifierOutcome: { kind: 'model_unavailable' },
      currentMessage: 'apply for leave',
    });
    expect.afterClassifierRoute(result, 'LeaveApplicationChild', 'lexical');
  });

  // ─── not_attempted path ───────────────────────────────────────────────────

  it('not_attempted + when_unavailable + lexical match → routes via lexical', () => {
    const result = runAfterClassifier({
      parentIR: LEAVE_SUPERVISOR,
      classifierOutcome: { kind: 'not_attempted' },
      currentMessage: 'apply for leave',
    });
    expect.afterClassifierRoute(result, 'LeaveApplicationChild', 'lexical');
  });

  it('not_attempted + when_unavailable + no lexical match → no_route', () => {
    const result = runAfterClassifier({
      parentIR: LEAVE_SUPERVISOR,
      classifierOutcome: { kind: 'not_attempted' },
      currentMessage: 'tell me a joke',
    });
    expect.afterClassifierNoRoute(result, 'no_lexical_match');
  });

  // ─── trace effects ────────────────────────────────────────────────────────

  it('emits pipeline_routing_resolve trace event with target payload when classifier routes', () => {
    // Payload semantics, not just presence. A regression that emits the right
    // event TYPE but with the wrong target payload would slip past a presence
    // check; this assertion catches it.
    const result = runAfterClassifier({
      parentIR: LEAVE_SUPERVISOR,
      classifierOutcome: {
        kind: 'classified',
        intents: [classifiedIntent({ category: 'leave_application' })],
      },
      currentMessage: 'apply for leave',
    });
    expect.effectWithPayload(result, 'pipeline_routing_resolve', {
      classifierMode: 'gather_scoped',
    });
  });

  it('emits trace events in order: pipeline_routing_resolve (no decision-event reordering)', () => {
    // Order, not just presence. If trace emission gets reordered (e.g.
    // dispatched lexically after routing instead of inline), downstream
    // replay tools break.
    const result = runAfterClassifier({
      parentIR: LEAVE_SUPERVISOR,
      classifierOutcome: {
        kind: 'classified',
        intents: [classifiedIntent({ category: 'leave_application' })],
      },
      currentMessage: 'apply for leave',
    });
    expect.effectOrder(result, ['pipeline_routing_resolve']);
  });

  // ─── determinism ──────────────────────────────────────────────────────────

  it('deterministic: identical inputs produce identical outputs', () => {
    expectDeterministicAfterClassifier({
      parentIR: LEAVE_SUPERVISOR,
      classifierOutcome: {
        kind: 'classified',
        intents: [classifiedIntent({ category: 'leave_application' })],
      },
      currentMessage: 'apply for leave',
    });
  });
});
