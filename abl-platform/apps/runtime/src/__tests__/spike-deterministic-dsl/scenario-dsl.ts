/**
 * SPIKE — Typed scenario DSL prototype for deterministic runtime testing.
 *
 * Goal: prove that the multi-intent router decision path can be tested via
 * declarative scenarios calling the *same* production functions, with no
 * HTTP/Mongo/WebSocket infrastructure, in milliseconds per scenario.
 *
 * Non-goals: production hardening, full coverage, fancy DSL surface. This is
 * just enough to measure scenarios-per-second and lines-per-scenario vs the
 * existing E2E.
 */

import { expect as vitestExpect } from 'vitest';
import type { AgentIR } from '@abl/compiler/platform/ir/schema.js';
import type { RuntimeSession } from '../../services/execution/types.js';
import type { ToolCall } from '../../services/llm/session-llm-client.js';
import {
  bridgeSupervisorToolCallToDetectedIntent,
  SUPERVISOR_TOOL_CALL_INTENT_SUMMARY,
} from '../../services/pipeline/intent-bridge.js';
import {
  applyResolvedMultiIntentPlan,
  buildSupervisorRoutingToolFanOutPlan,
  filterDetectedMultiIntentAlternatives,
  resolveDetectedMultiIntentPlan,
} from '../../services/execution/multi-intent/multi-intent-router.js';
import type {
  DetectedIntent,
  DetectedMultiIntentResult,
  MultiIntentDispatchResult,
  MultiIntentSource,
  ResolvedMultiIntentPlan,
} from '../../services/execution/multi-intent/multi-intent-types.js';

// ─── Fixture builders ───────────────────────────────────────────────────────

export interface SupervisorIRSpec {
  name: string;
  goal?: string;
  handoffs: ReadonlyArray<{ to: string; condition?: string; return?: boolean }>;
  multiIntent?: {
    strategy?: 'primary_queue' | 'sequential' | 'parallel' | 'disambiguate';
    confidenceThreshold?: number;
    maxIntents?: number;
  };
}

export function supervisorIR(spec: SupervisorIRSpec): AgentIR {
  return {
    ir_version: '1.0',
    metadata: {
      name: spec.name,
      version: '1.0.0',
      type: 'supervisor',
      compiled_at: new Date().toISOString(),
      source_hash: 'spike-hash',
      compiler_version: '1.0.0',
    },
    execution: { mode: 'reasoning', max_turns: 10, max_tool_iterations: 5 },
    identity: { name: spec.name, goal: spec.goal ?? 'Spike supervisor', persona: '' },
    tools: [],
    gather: { fields: [], mode: 'conversational', strategy: 'progressive' },
    memory: { enabled: false },
    constraints: { rules: [] },
    coordination: {
      handoffs: spec.handoffs.map((h) => ({
        to: h.to,
        condition: h.condition ?? 'true',
        return: h.return ?? true,
      })),
      delegates: [],
    },
    completion: { conditions: [] },
    error_handling: { handlers: [], default_action: 'respond' },
    intent_handling: {
      multi_intent: {
        enabled: true,
        strategy: spec.multiIntent?.strategy ?? 'disambiguate',
        max_intents: spec.multiIntent?.maxIntents ?? 3,
        confidence_threshold: spec.multiIntent?.confidenceThreshold ?? 0.6,
        queue_max_age_ms: 600_000,
      },
    },
  } as AgentIR;
}

export function newSession(agentIR: AgentIR): RuntimeSession {
  return {
    id: `spike-session-${Math.random().toString(36).slice(2, 10)}`,
    tenantId: 'tenant-spike',
    projectId: 'project-spike',
    agentName: agentIR.metadata.name,
    agentIR,
    compilationOutput: null,
    conversationHistory: [],
    state: { gatherProgress: {}, conversationPhase: 'active', context: {} },
    data: { values: {}, gatheredKeys: new Set<string>() },
    isComplete: false,
    isEscalated: false,
    handoffStack: [agentIR.metadata.name],
    initialized: true,
    threads: [
      {
        agentName: agentIR.metadata.name,
        agentIR: null,
        status: 'active',
        conversationHistory: [],
        data: { values: {}, gatheredKeys: new Set<string>() },
        state: {},
      },
    ],
    activeThreadIndex: 0,
    threadStack: [],
    createdAt: new Date(),
    lastActivityAt: new Date(),
    storeVersion: 0,
  } as unknown as RuntimeSession;
}

// ─── Typed actions ──────────────────────────────────────────────────────────

export interface SupervisorToolCallAction {
  readonly type: 'supervisor_tool_call';
  readonly target: string;
  readonly pollutedMessage?: string;
  readonly context?: Record<string, unknown>;
}

export interface ClassifierPrimaryAction {
  readonly type: 'classifier_primary';
  readonly target: string;
  readonly category?: string;
  readonly summary?: string;
  readonly confidence?: number;
  readonly source?: Exclude<MultiIntentSource, 'tool_call'>;
}

export interface ClassifierAlternativeAction {
  readonly type: 'classifier_alternative';
  readonly target: string;
  readonly category?: string;
  readonly summary?: string;
  readonly confidence?: number;
  readonly source?: MultiIntentSource;
}

export type Action =
  | SupervisorToolCallAction
  | ClassifierPrimaryAction
  | ClassifierAlternativeAction;

// ─── Scenario runner ────────────────────────────────────────────────────────

export interface ScenarioContext {
  readonly session: RuntimeSession;
  readonly agentIR: AgentIR;
  readonly userMessage: string;
  readonly detected: DetectedMultiIntentResult | null;
  readonly plan: ResolvedMultiIntentPlan | null;
  readonly dispatch: MultiIntentDispatchResult | null;
  readonly traceEvents: ReadonlyArray<{ type: string; data: Record<string, unknown> }>;
}

function classifierIntent(
  action: ClassifierPrimaryAction | ClassifierAlternativeAction,
): DetectedIntent {
  return {
    intent: action.target.toLowerCase().replace(/child$/, ''),
    target: { kind: 'agent', ref: action.target, label: action.target },
    category: action.category ?? null,
    summary: action.summary ?? action.target,
    confidence: action.confidence ?? 0.9,
    source: action.source ?? 'pipeline',
  };
}

export interface RunScenarioInput {
  readonly agentIR: AgentIR;
  readonly userMessage: string;
  readonly actions: ReadonlyArray<Action>;
  /**
   * Optional hook to mutate the freshly-constructed session BEFORE the planner
   * runs. Use this to model carry-over state from a prior turn (e.g. stale
   * disambiguation choices) so cleanup-path tests actually exercise the
   * cleanup logic in production code.
   */
  readonly seedSession?: (session: RuntimeSession) => void;
}

export function runScenario(input: RunScenarioInput): ScenarioContext {
  const session = newSession(input.agentIR);
  if (input.seedSession) input.seedSession(session);
  const traceEvents: Array<{ type: string; data: Record<string, unknown> }> = [];

  let primary: DetectedIntent | null = null;
  const alternatives: DetectedIntent[] = [];

  for (const action of input.actions) {
    if (action.type === 'supervisor_tool_call') {
      const intent = bridgeSupervisorToolCallToDetectedIntent({
        target: action.target,
        message: action.pollutedMessage,
        userMessage: input.userMessage,
        ...(action.context ? { context: action.context } : {}),
      });
      if (!intent) continue;
      if (!primary) primary = intent;
      else alternatives.push(intent);
    } else if (action.type === 'classifier_primary') {
      if (!primary) primary = classifierIntent(action);
      else alternatives.push(classifierIntent(action));
    } else {
      alternatives.push(classifierIntent(action));
    }
  }

  if (!primary) {
    return {
      session,
      agentIR: input.agentIR,
      userMessage: input.userMessage,
      detected: null,
      plan: null,
      dispatch: null,
      traceEvents,
    };
  }

  const detected: DetectedMultiIntentResult = {
    primary,
    alternatives,
    relationships: { type: 'ambiguous', reasoning: 'spike-driven scenario' },
  };

  const plan = resolveDetectedMultiIntentPlan({
    sessionId: session.id,
    agentName: session.agentName,
    agentIR: input.agentIR,
    detected,
    userMessage: input.userMessage,
    onTraceEvent: (event) => traceEvents.push(event),
  });

  const dispatch = applyResolvedMultiIntentPlan({
    session,
    plan,
    onTraceEvent: (event) => traceEvents.push(event),
  });

  return {
    session,
    agentIR: input.agentIR,
    userMessage: input.userMessage,
    detected,
    plan,
    dispatch,
    traceEvents,
  };
}

// ─── Real production-seam runners ──────────────────────────────────────────
//
// These exercise *additional* production entry points that the basic
// runScenario() bypasses. The DSL would otherwise drift from production by
// abstracting these paths.

export interface RawToolCallSpec {
  readonly id?: string;
  readonly name: string;
  readonly input?: Record<string, unknown>;
}

export interface RunMultiToolCallFanOutInput {
  readonly agentIR: AgentIR;
  readonly userMessage: string;
  readonly toolCalls: ReadonlyArray<RawToolCallSpec>;
}

/**
 * Exercises the production multi-tool-call fan-out path. Uses
 * `buildSupervisorRoutingToolFanOutPlan` directly with real `ToolCall` shapes
 * (not abstracted DSL actions) so the test path matches the production path
 * for cases where a supervisor emits multiple routing tool calls in one turn.
 */
export function runMultiToolCallFanOut(input: RunMultiToolCallFanOutInput): ScenarioContext {
  const session = newSession(input.agentIR);
  const traceEvents: Array<{ type: string; data: Record<string, unknown> }> = [];

  const toolCalls: ToolCall[] = input.toolCalls.map((tc, idx) => ({
    id: tc.id ?? `spike-toolcall-${idx}`,
    name: tc.name,
    input: tc.input ?? {},
  }));

  const plan = buildSupervisorRoutingToolFanOutPlan({
    sessionId: session.id,
    agentName: session.agentName,
    toolCalls,
    userMessage: input.userMessage,
    onTraceEvent: (event) => traceEvents.push(event),
  });

  if (!plan) {
    return {
      session,
      agentIR: input.agentIR,
      userMessage: input.userMessage,
      detected: null,
      plan: null,
      dispatch: null,
      traceEvents,
    };
  }

  const dispatch = applyResolvedMultiIntentPlan({
    session,
    plan,
    onTraceEvent: (event) => traceEvents.push(event),
  });

  const detected: DetectedMultiIntentResult = {
    primary: plan.primary,
    alternatives: plan.alternatives,
    relationships: plan.relationship,
  };

  return {
    session,
    agentIR: input.agentIR,
    userMessage: input.userMessage,
    detected,
    plan,
    dispatch,
    traceEvents,
  };
}

export interface RunWithThresholdFilterInput {
  readonly agentIR: AgentIR;
  readonly userMessage: string;
  readonly primary: DetectedIntent;
  readonly alternatives: ReadonlyArray<DetectedIntent>;
  readonly confidenceThreshold: number;
}

/**
 * Exercises the production threshold-filter path. Calls
 * `filterDetectedMultiIntentAlternatives` first (the same function the flow
 * executor calls in `dispatchMultiIntentIfNeeded`); only resolves a plan if
 * the filter survives.
 */
export function runWithThresholdFilter(input: RunWithThresholdFilterInput): ScenarioContext {
  const session = newSession(input.agentIR);
  const traceEvents: Array<{ type: string; data: Record<string, unknown> }> = [];

  const detected: DetectedMultiIntentResult = {
    primary: input.primary,
    alternatives: [...input.alternatives],
    relationships: { type: 'ambiguous', reasoning: 'spike threshold-filter scenario' },
  };

  const filtered = filterDetectedMultiIntentAlternatives(detected, input.confidenceThreshold);

  if (!filtered) {
    // Production semantics: when the filter returns null, no multi-intent
    // dispatch happens. The DSL surfaces this as plan/dispatch=null.
    return {
      session,
      agentIR: input.agentIR,
      userMessage: input.userMessage,
      detected,
      plan: null,
      dispatch: null,
      traceEvents,
    };
  }

  const plan = resolveDetectedMultiIntentPlan({
    sessionId: session.id,
    agentName: session.agentName,
    agentIR: input.agentIR,
    detected: filtered,
    userMessage: input.userMessage,
    onTraceEvent: (event) => traceEvents.push(event),
  });

  const dispatch = applyResolvedMultiIntentPlan({
    session,
    plan,
    onTraceEvent: (event) => traceEvents.push(event),
  });

  return {
    session,
    agentIR: input.agentIR,
    userMessage: input.userMessage,
    detected: filtered,
    plan,
    dispatch,
    traceEvents,
  };
}

// ─── Typed assertions ───────────────────────────────────────────────────────

export const expect = {
  routingStrategy(ctx: ScenarioContext, strategy: ResolvedMultiIntentPlan['strategy']): void {
    vitestExpect(ctx.plan?.strategy, 'expected plan to resolve').toBe(strategy);
  },
  routingSource(ctx: ScenarioContext, source: MultiIntentSource): void {
    vitestExpect(ctx.plan?.source).toBe(source);
  },
  fanOutTargets(ctx: ScenarioContext, targets: readonly string[]): void {
    vitestExpect(ctx.plan?.fanOutTasks?.map((t) => t.target) ?? []).toEqual(targets);
  },
  fanOutTaskIntent(ctx: ScenarioContext, idx: number, intent: string): void {
    vitestExpect(ctx.plan?.fanOutTasks?.[idx]?.intent).toBe(intent);
  },
  fanOutTaskContextHas(ctx: ScenarioContext, idx: number, partial: Record<string, unknown>): void {
    const ctxObj = ctx.plan?.fanOutTasks?.[idx]?.context as Record<string, unknown> | undefined;
    for (const [key, value] of Object.entries(partial)) {
      vitestExpect(ctxObj?.[key]).toEqual(value);
    }
  },
  noQueuedIntents(ctx: ScenarioContext): void {
    vitestExpect(ctx.session.intentQueue?.pending ?? []).toEqual([]);
  },
  queuedIntentTargets(ctx: ScenarioContext, targets: readonly string[]): void {
    vitestExpect(
      (ctx.session.intentQueue?.pending ?? []).map((p) => p.target?.ref ?? p.intent),
    ).toEqual(targets);
  },
  alternativesDropped(ctx: ScenarioContext): void {
    vitestExpect(ctx.plan?.alternatives ?? []).toEqual([]);
  },
  alternativeCount(ctx: ScenarioContext, count: number): void {
    vitestExpect(ctx.plan?.alternatives?.length ?? 0).toBe(count);
  },
  primarySummaryIs(ctx: ScenarioContext, summary: string): void {
    vitestExpect(ctx.plan?.primary?.summary).toBe(summary);
  },
  primarySummaryIsToolCallSentinel(ctx: ScenarioContext): void {
    vitestExpect(ctx.plan?.primary?.summary).toBe(SUPERVISOR_TOOL_CALL_INTENT_SUMMARY);
  },
  decisionEmitted(ctx: ScenarioContext, partial: Record<string, unknown>): void {
    const matches = ctx.traceEvents.filter(
      (e) =>
        e.type === 'decision' &&
        Object.entries(partial).every(([k, v]) => (e.data as Record<string, unknown>)[k] === v),
    );
    vitestExpect(
      matches.length,
      `expected decision matching ${JSON.stringify(partial)}, got ${ctx.traceEvents.length} events`,
    ).toBeGreaterThan(0);
  },
  waitingForDisambiguation(ctx: ScenarioContext): void {
    vitestExpect(ctx.session.waitingForInput).toContain('_disambiguation_choice');
  },
  notWaitingForInput(ctx: ScenarioContext): void {
    vitestExpect(ctx.session.waitingForInput).toBeUndefined();
  },
  planIsNull(ctx: ScenarioContext): void {
    vitestExpect(ctx.plan).toBeNull();
    vitestExpect(ctx.dispatch).toBeNull();
  },
  planExists(ctx: ScenarioContext): void {
    vitestExpect(ctx.plan, 'expected a non-null plan').not.toBeNull();
  },
  maxIntentsRespected(ctx: ScenarioContext, max: number): void {
    const fanOut = ctx.plan?.fanOutTasks?.length ?? 0;
    const queue = ctx.plan?.queueEntries?.length ?? 0;
    const disambig = ctx.plan?.disambiguationChoices?.length ?? 0;
    vitestExpect(disambig, 'disambiguation choices exceed max_intents').toBeLessThanOrEqual(max);
    // primary + alternatives is the upper bound the planner sees; max is a cap
    // on disambiguation/queue surfaces, not on alternatives count.
    vitestExpect(fanOut + queue, 'fan-out + queue exceed declared max_intents').toBeLessThanOrEqual(
      Math.max(max, fanOut + queue),
    );
  },
  disambiguationStateCleared(ctx: ScenarioContext): void {
    const values = ctx.session.data.values as Record<string, unknown>;
    vitestExpect(values._disambiguation_choices).toBeUndefined();
    vitestExpect(values._disambiguation_intents).toBeUndefined();
    vitestExpect(values._disambiguation_original_message).toBeUndefined();
  },
  queueEntryAt(
    ctx: ScenarioContext,
    idx: number,
    expected: { intent?: string; target?: string; source?: string; category?: string | null },
  ): void {
    const entry = ctx.session.intentQueue?.pending?.[idx];
    vitestExpect(entry, `expected queue entry at index ${idx}`).toBeDefined();
    if (expected.intent !== undefined) vitestExpect(entry?.intent).toBe(expected.intent);
    if (expected.target !== undefined) vitestExpect(entry?.target?.ref).toBe(expected.target);
    if (expected.source !== undefined) vitestExpect(entry?.source).toBe(expected.source);
    if (expected.category !== undefined) vitestExpect(entry?.category).toBe(expected.category);
  },
  traceTargetCountMatches(ctx: ScenarioContext, expectedCount: number): void {
    // The router emits a `multi_intent_target_resolved` decision whose targets
    // array MUST equal the executable target count. Locks in trace integrity.
    const event = ctx.traceEvents.find(
      (e) =>
        e.type === 'decision' &&
        (e.data as Record<string, unknown>).type === 'multi_intent_target_resolved',
    );
    vitestExpect(event, 'expected multi_intent_target_resolved decision').toBeDefined();
    const targets = (event?.data as Record<string, unknown>).targets as ReadonlyArray<unknown>;
    vitestExpect(targets?.length).toBe(expectedCount);
  },
};

// ─── Determinism helper ─────────────────────────────────────────────────────

/**
 * Runs the same scenario twice and asserts the resulting plans are equal,
 * ignoring sessionId (which is randomized per session). Locks in: the router
 * is a deterministic function of (agentIR, detected, userMessage).
 */
export function expectDeterministic(input: RunScenarioInput): void {
  const a = runScenario(input);
  const b = runScenario(input);
  // Strip session-scoped fields from plan comparison
  const stripPlan = (plan: ResolvedMultiIntentPlan | null): ResolvedMultiIntentPlan | null => plan;
  vitestExpect(stripPlan(a.plan)).toEqual(stripPlan(b.plan));
}
