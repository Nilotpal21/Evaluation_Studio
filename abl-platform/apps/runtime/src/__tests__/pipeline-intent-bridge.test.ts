/**
 * Tests for pipeline intent bridge — pure functions that map classifier output
 * + routing matches to session state and multi-intent types.
 */

import { describe, it, expect } from 'vitest';
import {
  bridgeSupervisorToolCallToDetectedIntent,
  bridgeIntentsToSessionState,
  bridgeToDetectedMultiIntent,
  bridgeToMultiIntentResult,
  inferIntentRelationship,
  resolveHighConfidenceMultiIntentMode,
  SUPERVISOR_TOOL_CALL_INTENT_SUMMARY,
} from '../services/pipeline/intent-bridge.js';
import { fromLegacyMultiIntentResult } from '../services/execution/multi-intent/multi-intent-types.js';
import { buildSupervisorRoutingToolFanOutPlan } from '../services/execution/multi-intent/multi-intent-router.js';
import type { ToolCall } from '../services/llm/session-llm-client.js';
import type {
  ClassifierResult,
  ClassifiedIntent,
  RoutingMatch,
} from '../services/pipeline/types.js';

// =============================================================================
// HELPERS
// =============================================================================

function makeClassifierResult(
  intents: Array<{ category: string | null; confidence: number; summary: string }>,
): ClassifierResult {
  return {
    intents: intents.map((i) => ({
      category: i.category,
      confidence: i.confidence,
      summary: i.summary,
    })),
  };
}

function makeRoutingMatch(intent: ClassifiedIntent, target: string | null): RoutingMatch {
  return {
    intent,
    target,
    ...(target
      ? {
          matchedRule: {
            to: target,
            when: `intent.category == "${intent.category}"`,
            priority: 1,
          },
        }
      : {}),
  };
}

function makeRoutingMatches(
  classifierResult: ClassifierResult,
  targetMap: Record<string, string | null>,
): RoutingMatch[] {
  return classifierResult.intents.map((intent) => {
    const target = intent.category !== null ? (targetMap[intent.category] ?? null) : null;
    return makeRoutingMatch(intent, target);
  });
}

// =============================================================================
// bridgeIntentsToSessionState
// =============================================================================

describe('bridgeIntentsToSessionState', () => {
  it('TC-IB-10: known category with routing match → correct category, target, confidence', () => {
    const cr = makeClassifierResult([
      { category: 'product_search', confidence: 0.9, summary: 'product search' },
    ]);
    const matches = makeRoutingMatches(cr, { product_search: 'Advisor_Agent' });

    const state = bridgeIntentsToSessionState(cr, matches);

    expect(state.category).toBe('product_search');
    expect(state.confidence).toBe(0.9);
    expect(state.out_of_scope).toBe(false);
    expect(state.target).toBe('Advisor_Agent');
    expect(state.summary).toBe('product search');
    expect(state.intent_count).toBe(1);
  });

  it('TC-IB-11: null category → out of scope', () => {
    const cr = makeClassifierResult([
      { category: null, confidence: 0.95, summary: 'flight booking' },
    ]);
    const matches = makeRoutingMatches(cr, {});

    const state = bridgeIntentsToSessionState(cr, matches);

    expect(state.category).toBeNull();
    expect(state.confidence).toBe(0.95);
    expect(state.out_of_scope).toBe(true);
    expect(state.target).toBeNull();
    expect(state.summary).toBe('flight booking');
    expect(state.intent_count).toBe(1);
  });

  it('TC-IB-12: multi-intent picks highest confidence as primary', () => {
    const cr = makeClassifierResult([
      { category: 'product_search', confidence: 0.8, summary: 'product' },
      { category: 'store_policy', confidence: 0.6, summary: 'policy' },
    ]);
    const matches = makeRoutingMatches(cr, {
      product_search: 'Advisor_Agent',
      store_policy: 'Store_Policy_Agent',
    });

    const state = bridgeIntentsToSessionState(cr, matches);

    expect(state.category).toBe('product_search');
    expect(state.confidence).toBe(0.8);
    expect(state.out_of_scope).toBe(false);
    expect(state.target).toBe('Advisor_Agent');
    expect(state.intent_count).toBe(2);
  });

  it('TC-IB-13: valid category but no routing match → category correct, target null', () => {
    const cr = makeClassifierResult([
      { category: 'billing', confidence: 0.7, summary: 'billing inquiry' },
    ]);
    // No routing match for billing — pass empty target map
    const matches = makeRoutingMatches(cr, {});

    const state = bridgeIntentsToSessionState(cr, matches);

    expect(state.category).toBe('billing');
    expect(state.out_of_scope).toBe(false);
    expect(state.target).toBeNull();
    expect(state.confidence).toBe(0.7);
  });

  it('TC-IB-14: empty intents → zero state', () => {
    const cr = makeClassifierResult([]);

    const state = bridgeIntentsToSessionState(cr, []);

    expect(state.category).toBeNull();
    expect(state.confidence).toBe(0);
    expect(state.out_of_scope).toBe(false);
    expect(state.target).toBeNull();
    expect(state.summary).toBe('');
    expect(state.intent_count).toBe(0);
  });
});

// =============================================================================
// bridgeToDetectedMultiIntent
// =============================================================================

describe('bridgeToDetectedMultiIntent', () => {
  it('single intent → returns null', () => {
    const cr = makeClassifierResult([
      { category: 'product_search', confidence: 0.9, summary: 'product search' },
    ]);
    const matches = makeRoutingMatches(cr, { product_search: 'Advisor_Agent' });

    expect(bridgeToDetectedMultiIntent(cr, matches)).toBeNull();
  });

  it('two intents → returns DetectedMultiIntentResult with correct targets', () => {
    const cr = makeClassifierResult([
      { category: 'product_search', confidence: 0.8, summary: 'product search' },
      { category: 'store_policy', confidence: 0.6, summary: 'return policy' },
    ]);
    const matches = makeRoutingMatches(cr, {
      product_search: 'Advisor_Agent',
      store_policy: 'Store_Policy_Agent',
    });

    const result = bridgeToDetectedMultiIntent(cr, matches);

    expect(result).not.toBeNull();
    expect(result!.primary.intent).toBe('product search');
    expect(result!.primary.target).toEqual({
      kind: 'agent',
      ref: 'Advisor_Agent',
      label: 'Advisor_Agent',
    });
    expect(result!.primary.category).toBe('product_search');
    expect(result!.primary.confidence).toBe(0.8);
    expect(result!.primary.source).toBe('pipeline');
    expect(result!.alternatives).toHaveLength(1);
    expect(result!.alternatives[0].intent).toBe('return policy');
    expect(result!.alternatives[0].target).toEqual({
      kind: 'agent',
      ref: 'Store_Policy_Agent',
      label: 'Store_Policy_Agent',
    });
  });

  it('dependent classifier relationship preserves classifier intent order for sequential execution', () => {
    const cr = makeClassifierResult([
      { category: 'product_search', confidence: 0.8, summary: 'show red dresses' },
      { category: 'store_policy', confidence: 0.95, summary: 'return policy for the cheapest one' },
    ]);
    cr.relationship = {
      type: 'dependent',
      reasoning: 'FAQ depends on product search result',
    };
    const matches = makeRoutingMatches(cr, {
      product_search: 'ProductAgent',
      store_policy: 'FAQAgent',
    });

    const result = bridgeToDetectedMultiIntent(
      cr,
      matches,
      'show me red dresses and the return policy for the cheapest one',
    );

    expect(result).not.toBeNull();
    expect(result!.relationships.type).toBe('dependent');
    expect(result!.primary.target?.ref).toBe('ProductAgent');
    expect(result!.alternatives[0].target?.ref).toBe('FAQAgent');
  });
});

describe('inferIntentRelationship', () => {
  it('uses classifier-provided relationship before fallback heuristics', () => {
    const cr = makeClassifierResult([
      { category: 'product_search', confidence: 0.9, summary: 'find dresses' },
      { category: 'store_policy', confidence: 0.9, summary: 'return policy' },
    ]);
    cr.relationship = { type: 'independent', reasoning: 'classifier said independent' };
    const matches = makeRoutingMatches(cr, {
      product_search: 'ProductAgent',
      store_policy: 'FAQAgent',
    });

    expect(
      inferIntentRelationship(
        cr,
        matches,
        'show me dresses and the return policy for the cheapest one',
      ),
    ).toEqual({ type: 'independent', reasoning: 'classifier said independent' });
  });

  it('fails closed to ambiguous cross-target relationship when classifier omits relationship', () => {
    const cr = makeClassifierResult([
      { category: 'product_search', confidence: 0.9, summary: 'show red dresses' },
      { category: 'store_policy', confidence: 0.9, summary: 'return policy for the cheapest one' },
    ]);
    const matches = makeRoutingMatches(cr, {
      product_search: 'ProductAgent',
      store_policy: 'FAQAgent',
    });

    const relationship = inferIntentRelationship(
      cr,
      matches,
      'show me red dresses and the return policy for the cheapest one',
    );

    expect(relationship.type).toBe('ambiguous');
    expect(relationship.reasoning).toContain('Classifier did not provide');
  });

  it('requires explicit classifier relationship before cross-target intents are parallel-eligible', () => {
    const cr = makeClassifierResult([
      { category: 'product_search', confidence: 0.9, summary: 'shoes under 500' },
      { category: 'store_policy', confidence: 0.9, summary: 'return policy' },
    ]);
    const matches = makeRoutingMatches(cr, {
      product_search: 'ProductAgent',
      store_policy: 'FAQAgent',
    });

    expect(inferIntentRelationship(cr, matches, 'shoes under 500 and return policy').type).toBe(
      'ambiguous',
    );
  });
});

describe('resolveHighConfidenceMultiIntentMode', () => {
  it('routes independent high-confidence multi-intent to parallel mode', () => {
    const cr = makeClassifierResult([
      { category: 'product_search', confidence: 0.93, summary: 'buy shirt' },
      { category: 'automobile', confidence: 0.91, summary: 'buy car' },
    ]);
    cr.relationship = { type: 'independent', reasoning: 'separate purchases' };
    const matches = makeRoutingMatches(cr, {
      product_search: 'ProductAgent',
      automobile: 'AutomobileAgent',
    });

    expect(
      resolveHighConfidenceMultiIntentMode({
        classifierResult: cr,
        routingMatches: matches,
        shortCircuitEnabled: true,
        confidenceThreshold: 0.85,
      }).mode,
    ).toBe('parallel');
  });

  it('routes dependent high-confidence multi-intent to sequential mode', () => {
    const cr = makeClassifierResult([
      { category: 'product_search', confidence: 0.93, summary: 'show red dresses' },
      { category: 'store_policy', confidence: 0.91, summary: 'return policy for it' },
    ]);
    cr.relationship = { type: 'dependent', reasoning: 'FAQ depends on product result' };
    const matches = makeRoutingMatches(cr, {
      product_search: 'ProductAgent',
      store_policy: 'FAQAgent',
    });

    expect(
      resolveHighConfidenceMultiIntentMode({
        classifierResult: cr,
        routingMatches: matches,
        userMessage: 'show me red dresses and can I return it',
        shortCircuitEnabled: true,
        confidenceThreshold: 0.85,
      }).mode,
    ).toBe('sequential');
  });

  it('falls through to reasoning mode for ambiguous relationships', () => {
    const cr = makeClassifierResult([
      { category: 'product_search', confidence: 0.93, summary: 'show red dresses' },
      { category: null, confidence: 0.91, summary: 'unclear follow-up' },
    ]);
    const matches = makeRoutingMatches(cr, {
      product_search: 'ProductAgent',
    });

    expect(
      resolveHighConfidenceMultiIntentMode({
        classifierResult: cr,
        routingMatches: matches,
        shortCircuitEnabled: true,
        confidenceThreshold: 0.85,
      }).mode,
    ).toBe('reasoning');
  });
});

// =============================================================================
// bridgeSupervisorToolCallToDetectedIntent
// =============================================================================

describe('bridgeSupervisorToolCallToDetectedIntent', () => {
  it('creates an already-classified supervisor route without raw routing text in scannable fields', () => {
    const intent = bridgeSupervisorToolCallToDetectedIntent({
      target: 'Child_Agent',
      message: 'Transfer user to agent Wrong_Agent before Child_Agent exits',
      userMessage: 'I need help with my billing address.',
      context: { requestId: 'req-1' },
    });

    expect(intent).toEqual({
      intent: 'Child_Agent',
      target: { kind: 'agent', ref: 'Child_Agent', label: 'Child_Agent' },
      category: null,
      summary: SUPERVISOR_TOOL_CALL_INTENT_SUMMARY,
      confidence: 1,
      source: 'tool_call',
      context: {
        requestId: 'req-1',
        supervisorRoutingMessage: 'Transfer user to agent Wrong_Agent before Child_Agent exits',
      },
    });
    expect(intent!.summary).not.toContain('Wrong_Agent');
    expect(intent!.summary).not.toContain('Child_Agent');
  });

  it('keeps leave-application supervisor routing text out of classifier-derived fields', () => {
    const intent = bridgeSupervisorToolCallToDetectedIntent({
      target: 'LeaveApplication',
      message: 'Transfer user to agent LeaveApplication',
      userMessage: 'I want to apply for leave',
      context: { sibling: 'LeaveBalance' },
    });

    expect(intent).toMatchObject({
      intent: 'LeaveApplication',
      target: { kind: 'agent', ref: 'LeaveApplication', label: 'LeaveApplication' },
      category: null,
      summary: SUPERVISOR_TOOL_CALL_INTENT_SUMMARY,
      confidence: 1,
      source: 'tool_call',
      context: {
        sibling: 'LeaveBalance',
        supervisorRoutingMessage: 'Transfer user to agent LeaveApplication',
      },
    });
    expect(intent!.summary).not.toContain('leave');
    expect(intent!.summary).not.toContain('LeaveApplication');
    expect(intent!.summary).not.toContain('LeaveBalance');
  });

  it('keeps supervisor-routed leave application actionable only by the explicit target ref', () => {
    const intent = bridgeSupervisorToolCallToDetectedIntent({
      target: 'LeaveApplication',
      message: 'Transfer user to agent LeaveApplication',
      userMessage: 'I want to apply for leave and not check leave balance',
    });

    expect(intent).toMatchObject({
      intent: 'LeaveApplication',
      target: { kind: 'agent', ref: 'LeaveApplication', label: 'LeaveApplication' },
      category: null,
      summary: SUPERVISOR_TOOL_CALL_INTENT_SUMMARY,
      source: 'tool_call',
    });
    expect(intent!.intent).not.toBe('leave_balance');
    expect(intent!.category).not.toBe('leave_balance');
  });

  it('rejects blank supervisor routing targets', () => {
    expect(
      bridgeSupervisorToolCallToDetectedIntent({
        target: '   ',
        message: 'Transfer user to agent Billing_Agent',
        userMessage: 'I need help with billing.',
      }),
    ).toBeNull();
  });
});

describe('route intent producer source contract', () => {
  it('tags every exported route intent producer with an explicit source', () => {
    const cr = makeClassifierResult([
      { category: 'leave_application', confidence: 0.91, summary: 'apply for leave' },
      { category: 'leave_balance', confidence: 0.77, summary: 'check leave balance' },
    ]);
    const matches = makeRoutingMatches(cr, {
      leave_application: 'LeaveApplicationChild',
      leave_balance: 'LeaveBalanceChild',
    });

    const pipelineDetected = bridgeToDetectedMultiIntent(cr, matches);
    expect(pipelineDetected).not.toBeNull();
    expect([
      pipelineDetected!.primary.source,
      ...pipelineDetected!.alternatives.map((intent) => intent.source),
    ]).toEqual(['pipeline', 'pipeline']);

    const supervisorDetected = bridgeSupervisorToolCallToDetectedIntent({
      target: 'LeaveApplicationChild',
      message: 'Transfer user to agent LeaveBalanceChild after LeaveApplicationChild',
      userMessage: 'I want to apply for leave.',
    });
    expect(supervisorDetected?.source).toBe('tool_call');

    const toolCalls: ToolCall[] = [
      {
        id: 'tool-1',
        name: 'handoff_to_LeaveApplicationChild',
        input: { message: 'Transfer user to agent LeaveBalanceChild' },
      },
      {
        id: 'tool-2',
        name: 'handoff_to_LeaveBalanceChild',
        input: { message: 'Check leave balance after applying leave' },
      },
    ];
    const supervisorFanOut = buildSupervisorRoutingToolFanOutPlan({
      sessionId: 'session-source-contract',
      agentName: 'LeaveSupervisor',
      toolCalls,
      userMessage: 'I want to apply for leave and check leave balance.',
    });
    expect(supervisorFanOut).not.toBeNull();
    expect([
      supervisorFanOut!.source,
      supervisorFanOut!.primary.source,
      ...supervisorFanOut!.alternatives.map((intent) => intent.source),
    ]).toEqual(['tool_call', 'tool_call', 'tool_call']);

    const legacyDetected = fromLegacyMultiIntentResult({
      primary: { intent: 'LeaveApplicationChild', confidence: 0.9, source: 'fast' },
      alternatives: [{ intent: 'LeaveBalanceChild', confidence: 0.8, source: 'fast' }],
      relationships: {
        type: 'independent',
        reasoning: 'Legacy detector returned two routed intents',
      },
    });
    expect([
      legacyDetected.primary.source,
      ...legacyDetected.alternatives.map((intent) => intent.source),
    ]).toEqual(['legacy', 'legacy']);
  });
});

// =============================================================================
// bridgeToMultiIntentResult
// =============================================================================

describe('bridgeToMultiIntentResult', () => {
  it('TC-IB-20: single intent → returns null', () => {
    const cr = makeClassifierResult([
      { category: 'product_search', confidence: 0.9, summary: 'product search' },
    ]);
    const matches = makeRoutingMatches(cr, { product_search: 'Advisor_Agent' });

    expect(bridgeToMultiIntentResult(cr, matches)).toBeNull();
  });

  it('TC-IB-21: two intents, different targets → independent relationship', () => {
    const cr = makeClassifierResult([
      { category: 'product_search', confidence: 0.8, summary: 'product search' },
      { category: 'store_policy', confidence: 0.6, summary: 'policy query' },
    ]);
    cr.relationship = {
      type: 'independent',
      reasoning: 'Classifier determined these can run independently',
    };
    const matches = makeRoutingMatches(cr, {
      product_search: 'Advisor_Agent',
      store_policy: 'Store_Policy_Agent',
    });

    const result = bridgeToMultiIntentResult(cr, matches);

    expect(result).not.toBeNull();
    expect(result!.primary.intent).toBe('product_search');
    expect(result!.primary.confidence).toBe(0.8);
    expect(result!.alternatives).toHaveLength(1);
    expect(result!.alternatives[0].intent).toBe('store_policy');
    expect(result!.relationships.type).toBe('independent');
    expect(result!.relationships.reasoning).toBeTruthy();
  });

  it('TC-IB-22: two intents, same target → dependent relationship', () => {
    const cr = makeClassifierResult([
      { category: 'product_search', confidence: 0.8, summary: 'search shoes' },
      { category: 'offers', confidence: 0.6, summary: 'compare prices' },
    ]);
    const matches = makeRoutingMatches(cr, {
      product_search: 'Advisor_Agent',
      offers: 'Advisor_Agent',
    });

    const result = bridgeToMultiIntentResult(cr, matches);

    expect(result).not.toBeNull();
    expect(result!.relationships.type).toBe('dependent');
    expect(result!.relationships.reasoning).toContain('same agent');
  });

  it('TC-IB-23: two intents, one null target → ambiguous relationship', () => {
    const cr = makeClassifierResult([
      { category: 'product_search', confidence: 0.8, summary: 'search' },
      { category: null, confidence: 0.6, summary: 'unknown' },
    ]);
    const matches = makeRoutingMatches(cr, { product_search: 'Advisor_Agent' });

    const result = bridgeToMultiIntentResult(cr, matches);

    expect(result).not.toBeNull();
    expect(result!.relationships.type).toBe('ambiguous');
    expect(result!.relationships.reasoning).toContain('no routing target');
  });

  it('TC-IB-24: three intents → all mapped correctly', () => {
    const cr = makeClassifierResult([
      { category: 'product_search', confidence: 0.8, summary: 'product' },
      { category: 'store_policy', confidence: 0.7, summary: 'policy' },
      { category: null, confidence: 0.5, summary: 'out of scope' },
    ]);
    const matches = makeRoutingMatches(cr, {
      product_search: 'Advisor_Agent',
      store_policy: 'Store_Policy_Agent',
    });

    const result = bridgeToMultiIntentResult(cr, matches);

    expect(result).not.toBeNull();
    expect(result!.primary.confidence).toBe(0.8);
    expect(result!.alternatives).toHaveLength(2);
    expect(result!.relationships.type).toBe('ambiguous'); // has null target
  });
});
