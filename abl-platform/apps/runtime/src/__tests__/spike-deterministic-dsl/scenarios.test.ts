/**
 * SPIKE — ABLP-930 scenarios expressed via the typed scenario DSL.
 *
 * Each scenario calls the SAME production functions used by the runtime
 * (no parallel implementation, no mocks of platform code). The harness is
 * in-memory; no HTTP, no Mongo, no LLM, no WebSocket.
 *
 * Reference: the existing 582-line E2E covers the same handoff invariants
 * via real HTTP + MongoMemoryServer + mock LLM server (~22-24s per case).
 */

import { describe, it } from 'vitest';
import {
  runScenario,
  runMultiToolCallFanOut,
  runWithThresholdFilter,
  supervisorIR,
  expect,
  expectDeterministic,
} from './scenario-dsl.js';
import type { DetectedIntent } from '../../services/execution/multi-intent/multi-intent-types.js';

const LEAVE_SUPERVISOR = supervisorIR({
  name: 'LeaveSupervisor',
  goal: 'Route leave requests to the correct specialist',
  handoffs: [
    { to: 'LeaveApplicationChild', return: true },
    { to: 'LeaveBalanceChild', return: true },
  ],
  multiIntent: { strategy: 'disambiguate', confidenceThreshold: 0.6, maxIntents: 3 },
});

const PRIMARY_QUEUE_SUPERVISOR = supervisorIR({
  name: 'OrderSupervisor',
  handoffs: [
    { to: 'BillingChild', return: true },
    { to: 'ShippingChild', return: true },
  ],
  multiIntent: { strategy: 'primary_queue', maxIntents: 3 },
});

describe('ABLP-930 spike — multi-intent router decision scenarios', () => {
  // ─── Tool-call routing — the original bug ─────────────────────────────────

  it('preserves tool_call target despite polluted supervisor message', () => {
    const ctx = runScenario({
      agentIR: LEAVE_SUPERVISOR,
      userMessage: 'I want to apply for leave and not check leave balance',
      actions: [
        {
          type: 'supervisor_tool_call',
          target: 'LeaveApplicationChild',
          pollutedMessage: 'Transfer user to agent LeaveBalanceChild',
        },
      ],
    });
    expect.routingStrategy(ctx, 'parallel');
    expect.routingSource(ctx, 'tool_call');
    expect.fanOutTargets(ctx, ['LeaveApplicationChild']);
    expect.fanOutTaskIntent(ctx, 0, 'I want to apply for leave and not check leave balance');
    expect.fanOutTaskContextHas(ctx, 0, {
      supervisorRoutingMessage: 'Transfer user to agent LeaveBalanceChild',
    });
    expect.primarySummaryIsToolCallSentinel(ctx);
    expect.noQueuedIntents(ctx);
  });

  it('drops conflicting classifier alternatives when primary is tool_call', () => {
    const ctx = runScenario({
      agentIR: LEAVE_SUPERVISOR,
      userMessage: 'I want to apply for leave',
      actions: [
        {
          type: 'supervisor_tool_call',
          target: 'LeaveApplicationChild',
          pollutedMessage: 'Transfer user to agent LeaveBalanceChild',
        },
        {
          type: 'classifier_alternative',
          target: 'LeaveBalanceChild',
          category: 'leave_balance',
          summary: 'leave balance',
          confidence: 0.98,
        },
      ],
    });
    expect.alternativesDropped(ctx);
    expect.fanOutTargets(ctx, ['LeaveApplicationChild']);
    expect.decisionEmitted(ctx, {
      type: 'multi_intent_plan_built',
      source: 'tool_call',
      strategy: 'parallel',
      targetCount: 1,
    });
  });

  it('forces parallel strategy for tool_call even when agent IR says disambiguate', () => {
    const ctx = runScenario({
      agentIR: LEAVE_SUPERVISOR,
      userMessage: 'apply for leave',
      actions: [{ type: 'supervisor_tool_call', target: 'LeaveApplicationChild' }],
    });
    expect.routingStrategy(ctx, 'parallel');
    expect.notWaitingForInput(ctx);
  });

  it('forces parallel strategy for tool_call even when agent IR says primary_queue', () => {
    const ctx = runScenario({
      agentIR: PRIMARY_QUEUE_SUPERVISOR,
      userMessage: 'pay my bill',
      actions: [{ type: 'supervisor_tool_call', target: 'BillingChild' }],
    });
    expect.routingStrategy(ctx, 'parallel');
    expect.noQueuedIntents(ctx);
  });

  it('preserves only tool_call alternatives, drops mixed-source alternatives', () => {
    const ctx = runScenario({
      agentIR: LEAVE_SUPERVISOR,
      userMessage: 'apply for leave',
      actions: [
        { type: 'supervisor_tool_call', target: 'LeaveApplicationChild' },
        // a fast classifier alt — should be dropped
        {
          type: 'classifier_alternative',
          target: 'LeaveBalanceChild',
          source: 'fast',
          confidence: 0.95,
        },
        // another tool_call alt — should be KEPT
        { type: 'supervisor_tool_call', target: 'LeaveBalanceChild' },
      ],
    });
    expect.alternativeCount(ctx, 1);
    expect.fanOutTargets(ctx, ['LeaveApplicationChild', 'LeaveBalanceChild']);
  });

  // ─── Classifier-only paths — must NOT regress ─────────────────────────────

  it('classifier-only multi-intent honors agent IR strategy (disambiguate)', () => {
    const ctx = runScenario({
      agentIR: LEAVE_SUPERVISOR,
      userMessage: 'apply for leave and check my balance',
      actions: [
        {
          type: 'classifier_primary',
          target: 'LeaveApplicationChild',
          category: 'leave_application',
          confidence: 0.95,
          source: 'pipeline',
        },
        {
          type: 'classifier_alternative',
          target: 'LeaveBalanceChild',
          category: 'leave_balance',
          confidence: 0.92,
          source: 'pipeline',
        },
      ],
    });
    expect.routingSource(ctx, 'pipeline');
    expect.routingStrategy(ctx, 'disambiguate');
    expect.waitingForDisambiguation(ctx);
  });

  it('classifier-only multi-intent honors agent IR strategy (primary_queue)', () => {
    const ctx = runScenario({
      agentIR: PRIMARY_QUEUE_SUPERVISOR,
      userMessage: 'pay my bill and ship my order',
      actions: [
        {
          type: 'classifier_primary',
          target: 'BillingChild',
          category: 'billing',
          confidence: 0.95,
        },
        {
          type: 'classifier_alternative',
          target: 'ShippingChild',
          category: 'shipping',
          confidence: 0.9,
        },
      ],
    });
    expect.routingSource(ctx, 'pipeline');
    expect.routingStrategy(ctx, 'primary_queue');
    expect.queuedIntentTargets(ctx, ['ShippingChild']);
  });

  it('classifier-only single intent fans out alone with primary_queue strategy', () => {
    const ctx = runScenario({
      agentIR: PRIMARY_QUEUE_SUPERVISOR,
      userMessage: 'pay my bill',
      actions: [
        {
          type: 'classifier_primary',
          target: 'BillingChild',
          category: 'billing',
          confidence: 0.95,
        },
      ],
    });
    expect.routingStrategy(ctx, 'primary_queue');
    expect.noQueuedIntents(ctx);
  });

  // ─── Edge cases — coverage that the existing E2E does NOT have ────────────

  it('tool_call with no polluted message uses raw user message in fan-out', () => {
    const ctx = runScenario({
      agentIR: LEAVE_SUPERVISOR,
      userMessage: 'I want to apply for leave',
      actions: [{ type: 'supervisor_tool_call', target: 'LeaveApplicationChild' }],
    });
    expect.fanOutTaskIntent(ctx, 0, 'I want to apply for leave');
  });

  it('tool_call with explicit context propagates context to fan-out task', () => {
    const ctx = runScenario({
      agentIR: LEAVE_SUPERVISOR,
      userMessage: 'apply for leave',
      actions: [
        {
          type: 'supervisor_tool_call',
          target: 'LeaveApplicationChild',
          context: { traceId: 'abc-123', priority: 'high' },
        },
      ],
    });
    expect.fanOutTaskContextHas(ctx, 0, { traceId: 'abc-123', priority: 'high' });
  });

  it('multi-target tool_call fans out via the real ToolCall production path', () => {
    // Goes through buildSupervisorRoutingToolFanOutPlan with real ToolCall shapes,
    // not the abstracted DSL action — this is the same code path production uses
    // when a supervisor LLM emits multiple routing tool calls in one turn.
    const ctx = runMultiToolCallFanOut({
      agentIR: PRIMARY_QUEUE_SUPERVISOR,
      userMessage: 'process billing and shipping',
      toolCalls: [
        { name: 'handoff_to_BillingChild', input: { message: 'process billing' } },
        { name: 'handoff_to_ShippingChild', input: { message: 'process shipping' } },
      ],
    });
    expect.routingStrategy(ctx, 'parallel');
    expect.routingSource(ctx, 'tool_call');
    expect.fanOutTargets(ctx, ['BillingChild', 'ShippingChild']);
    // Both fan-out tasks should carry the raw user message, not the per-call
    // routing message text — proves the source-aware contract holds for the
    // production fan-out builder, not just the resolveDetectedMultiIntentPlan path.
    expect.fanOutTaskIntent(ctx, 0, 'process billing and shipping');
    expect.fanOutTaskIntent(ctx, 1, 'process billing and shipping');
  });

  it('multi-target tool_call with target-pollution preserves tool-name targets', () => {
    // Real production case: supervisor emits handoff_to_X tool calls but the
    // input.target text mentions Y. The tool name MUST win.
    const ctx = runMultiToolCallFanOut({
      agentIR: PRIMARY_QUEUE_SUPERVISOR,
      userMessage: 'pay and ship',
      toolCalls: [
        {
          name: 'handoff_to_BillingChild',
          input: { target: '', message: 'Transfer user to agent ShippingChild' },
        },
        {
          name: 'handoff_to_ShippingChild',
          input: { target: 'BillingChild', message: 'Mentions BillingChild' },
        },
      ],
    });
    expect.fanOutTargets(ctx, ['BillingChild', 'ShippingChild']);
  });

  it('rejects malformed tool calls — no fan-out plan produced', () => {
    // Production behavior: __handoff__ with empty target and a non-routing
    // tool call that happens to mention an agent name in its message MUST NOT
    // synthesize a fan-out plan. This is the strengthened assertion GPT-5.5
    // flagged: not just "doesn't crash" but "returns null and routes nowhere".
    const ctx = runMultiToolCallFanOut({
      agentIR: PRIMARY_QUEUE_SUPERVISOR,
      userMessage: 'process my order',
      toolCalls: [
        { name: '__handoff__', input: { target: '', message: 'Transfer to BillingChild' } },
        { name: 'lookup_policy', input: { message: 'Transfer to ShippingChild' } },
      ],
    });
    expect.planIsNull(ctx);
  });

  it('emits multi_intent_target_resolved decision event for traceability', () => {
    const ctx = runScenario({
      agentIR: LEAVE_SUPERVISOR,
      userMessage: 'apply for leave',
      actions: [{ type: 'supervisor_tool_call', target: 'LeaveApplicationChild' }],
    });
    expect.decisionEmitted(ctx, {
      type: 'multi_intent_target_resolved',
      source: 'tool_call',
    });
  });

  // ─── Threshold filter — the actual production filter seam ──────────────────

  it('filterDetectedMultiIntentAlternatives drops sub-threshold alternatives', () => {
    // Calls the real filter function (the same one flow-step-executor uses
    // in dispatchMultiIntentIfNeeded). Confidence below threshold is dropped
    // before the planner ever runs.
    const primary: DetectedIntent = {
      intent: 'leave application',
      target: { kind: 'agent', ref: 'LeaveApplicationChild', label: 'LeaveApplicationChild' },
      category: 'leave_application',
      summary: 'apply for leave',
      confidence: 0.95,
      source: 'pipeline',
    };
    const lowConf: DetectedIntent = {
      intent: 'leave balance',
      target: { kind: 'agent', ref: 'LeaveBalanceChild', label: 'LeaveBalanceChild' },
      category: 'leave_balance',
      summary: 'leave balance',
      confidence: 0.4, // below the 0.6 threshold
      source: 'pipeline',
    };
    const ctx = runWithThresholdFilter({
      agentIR: LEAVE_SUPERVISOR,
      userMessage: 'apply for leave',
      primary,
      alternatives: [lowConf],
      confidenceThreshold: 0.6,
    });
    // Filter returns null when no qualifying alternatives → no multi-intent plan.
    expect.planIsNull(ctx);
  });

  it('filterDetectedMultiIntentAlternatives keeps above-threshold alternatives', () => {
    const primary: DetectedIntent = {
      intent: 'leave application',
      target: { kind: 'agent', ref: 'LeaveApplicationChild', label: 'LeaveApplicationChild' },
      category: 'leave_application',
      summary: 'apply for leave',
      confidence: 0.95,
      source: 'pipeline',
    };
    const highConf: DetectedIntent = {
      intent: 'leave balance',
      target: { kind: 'agent', ref: 'LeaveBalanceChild', label: 'LeaveBalanceChild' },
      category: 'leave_balance',
      summary: 'leave balance',
      confidence: 0.85, // above the 0.6 threshold
      source: 'pipeline',
    };
    const ctx = runWithThresholdFilter({
      agentIR: LEAVE_SUPERVISOR,
      userMessage: 'apply for leave and check balance',
      primary,
      alternatives: [highConf],
      confidenceThreshold: 0.6,
    });
    expect.planExists(ctx);
    expect.routingStrategy(ctx, 'disambiguate');
  });

  // ─── Universal router invariants — the regression contract ─────────────────

  it('invariant: tool_call primary always forces parallel regardless of agent IR', () => {
    // Already covered for disambiguate and primary_queue strategies above,
    // this scenario locks the contract by name.
    const ctx = runScenario({
      agentIR: LEAVE_SUPERVISOR, // configured for disambiguate
      userMessage: 'apply for leave',
      actions: [{ type: 'supervisor_tool_call', target: 'LeaveApplicationChild' }],
    });
    expect.routingStrategy(ctx, 'parallel');
  });

  it('invariant: tool_call fan-out clears stale _disambiguation_* values from prior turn', () => {
    // Pre-populate the session with stale state from a hypothetical prior turn.
    // The router MUST clear the _disambiguation_* fields when applying any plan
    // (see applyResolvedMultiIntentPlan top-of-function `delete` calls). If the
    // production cleanup logic is removed, this test fails.
    //
    // SCOPE NOTE: We also seed `waitingForInput` for prior-turn realism, but
    // the router does NOT reset waitingForInput on parallel/primary_queue/
    // sequential dispatch — that's the runtime lifecycle's responsibility
    // (see flow-step-executor.ts and runtime-executor.ts). Asserting
    // `waitingForInput` state from this scope would be a category error and
    // was intentionally removed after GPT-5.5 review flagged it as
    // false-confidence. A two-turn integration/wiring test is the right
    // place to assert lifecycle cleanup of waitingForInput.
    const ctx = runScenario({
      agentIR: LEAVE_SUPERVISOR,
      userMessage: 'apply for leave',
      actions: [{ type: 'supervisor_tool_call', target: 'LeaveApplicationChild' }],
      seedSession: (session) => {
        const values = session.data.values as Record<string, unknown>;
        values._disambiguation_choices = [
          {
            label: 'Stale choice',
            intent: 'stale',
            target: null,
            category: null,
            summary: 'stale',
            confidence: 0.5,
            source: 'pipeline',
          },
        ];
        values._disambiguation_intents = ['Stale choice'];
        values._disambiguation_original_message = 'prior turn message';
        // Realistic prior-turn carry-over; not asserted from this scope.
        session.waitingForInput = ['_disambiguation_choice'];
      },
    });
    expect.disambiguationStateCleared(ctx);
  });

  it('invariant: queue entries preserve source/category/target on primary_queue path', () => {
    const ctx = runScenario({
      agentIR: PRIMARY_QUEUE_SUPERVISOR,
      userMessage: 'pay and ship',
      actions: [
        {
          type: 'classifier_primary',
          target: 'BillingChild',
          category: 'billing',
          summary: 'pay bill',
          confidence: 0.95,
          source: 'pipeline',
        },
        {
          type: 'classifier_alternative',
          target: 'ShippingChild',
          category: 'shipping',
          summary: 'ship order',
          confidence: 0.9,
          source: 'pipeline',
        },
      ],
    });
    expect.queueEntryAt(ctx, 0, {
      target: 'ShippingChild',
      source: 'pipeline',
      category: 'shipping',
    });
  });

  it('invariant: trace target count equals executable target count', () => {
    // The multi_intent_target_resolved decision event carries a `targets`
    // array. Its length MUST match the number of executable targets the
    // planner saw — protects the trace contract from drift.
    const ctx = runScenario({
      agentIR: LEAVE_SUPERVISOR,
      userMessage: 'apply for leave',
      actions: [{ type: 'supervisor_tool_call', target: 'LeaveApplicationChild' }],
    });
    expect.traceTargetCountMatches(ctx, 1);
  });

  it('invariant: deterministic inputs produce deterministic plans (idempotent)', () => {
    // Locks in the pure-function property: identical inputs → identical plan,
    // ignoring sessionId. If anyone introduces hidden state into the planner,
    // this test fails.
    expectDeterministic({
      agentIR: LEAVE_SUPERVISOR,
      userMessage: 'apply for leave',
      actions: [
        {
          type: 'supervisor_tool_call',
          target: 'LeaveApplicationChild',
          pollutedMessage: 'Transfer user to agent LeaveBalanceChild',
        },
        {
          type: 'classifier_alternative',
          target: 'LeaveBalanceChild',
          category: 'leave_balance',
          confidence: 0.92,
        },
      ],
    });
  });

  it('invariant: max_intents caps disambiguation choices', () => {
    const supervisor = supervisorIR({
      name: 'CappedSupervisor',
      handoffs: [{ to: 'A' }, { to: 'B' }, { to: 'C' }, { to: 'D' }, { to: 'E' }],
      multiIntent: { strategy: 'disambiguate', maxIntents: 2, confidenceThreshold: 0.5 },
    });
    const ctx = runScenario({
      agentIR: supervisor,
      userMessage: 'do everything',
      actions: [
        { type: 'classifier_primary', target: 'A', category: 'a', confidence: 0.95 },
        { type: 'classifier_alternative', target: 'B', category: 'b', confidence: 0.9 },
        { type: 'classifier_alternative', target: 'C', category: 'c', confidence: 0.85 },
        { type: 'classifier_alternative', target: 'D', category: 'd', confidence: 0.8 },
      ],
    });
    expect.maxIntentsRespected(ctx, 2);
  });
});
