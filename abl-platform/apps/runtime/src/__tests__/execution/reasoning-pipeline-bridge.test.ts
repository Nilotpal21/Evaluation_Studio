/**
 * Integration tests for the pipeline intent bridge wiring in the reasoning executor.
 *
 * These tests verify the composition of pure bridge functions as wired by the
 * reasoning executor, without instantiating a real ReasoningExecutor. They confirm that:
 *   1. bridgeIntentsToSessionState populates session state correctly
 *   2. resolveTieredAction acts on that state to produce the right tier
 *   3. bridgeToMultiIntentResult maps to multi-intent dispatch
 *   4. resolvePipelineConfig merges agent → project → defaults correctly
 *   5. Tool hiding from guided actions filters the right tools
 *
 * Updated for the inline-orchestrated pipeline: the executor now calls classify(),
 * resolveRouting(), bridgeIntentsToSessionState(), resolveTieredAction(), etc.
 * individually instead of a single runPipeline() call.
 */

import { describe, it, expect } from 'vitest';
import {
  bridgeIntentsToSessionState,
  bridgeToDetectedMultiIntent,
  bridgeToMultiIntentResult,
} from '../../services/pipeline/intent-bridge.js';
import { resolveDetectedMultiIntentPlan } from '../../services/execution/multi-intent/multi-intent-router.js';
import { resolveTieredAction } from '../../services/pipeline/tiered-resolver.js';
import { resolvePipelineConfig } from '../../services/pipeline/config.js';
import type { AgentIR } from '@abl/compiler';
import type {
  ClassifierResult,
  RoutingMatch,
  ClassifiedIntent,
  IntentBridgeConfig,
  PipelineIntentState,
} from '../../services/pipeline/types.js';
import type { ToolDefinition } from '@abl/compiler/platform/llm/types.js';

// =============================================================================
// HELPERS
// =============================================================================

const DEFAULT_INTENT_BRIDGE_CONFIG: IntentBridgeConfig = {
  enabled: true,
  programmaticThreshold: 0.85,
  guidedThreshold: 0.5,
  outOfScopeDecline: true,
  multiIntentSignal: true,
};

function makeAgentIR(opts: {
  limitations?: string[];
  routing?: Array<{ to: string; when: string }>;
  handoffs?: Array<{ to: string; when: string }>;
  messages?: Record<string, string>;
}): AgentIR {
  return {
    ir_version: '1.0',
    metadata: { name: 'TestAgent', version: '1.0', description: '' },
    execution: { hints: {} as any, timeouts: {} as any },
    identity: {
      goal: '',
      persona: '',
      limitations: opts.limitations ?? [],
      system_prompt: {} as any,
    },
    tools: [],
    gather: { fields: [] } as any,
    memory: {} as any,
    constraints: { rules: [] } as any,
    coordination: {
      delegates: [],
      handoffs: (opts.handoffs ?? []).map((h) => ({
        to: h.to,
        when: h.when,
        context: { pass: [], summary: '' },
        return: false,
      })),
    },
    completion: {} as any,
    error_handling: {} as any,
    messages: (opts.messages ?? {}) as any,
    routing: opts.routing
      ? {
          rules: opts.routing.map((r, i) => ({
            to: r.to,
            when: r.when,
            description: '',
            priority: i + 1,
          })),
          default_agent: 'Fallback',
          intent_classification: { use_llm: true, categories: [], min_confidence: 0.5 },
        }
      : undefined,
  } as AgentIR;
}

/**
 * Create a ClassifierResult with intents using the new `category` field.
 * `category` is the intent category (e.g. "product_search"), or null for out-of-scope.
 */
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

/**
 * Build RoutingMatch[] from classifier intents and a target mapping.
 * Each intent is matched to a target using the provided map (category → target).
 * Intents with category=null or unmapped categories get target=null.
 */
function makeRoutingMatches(
  classifierResult: ClassifierResult,
  targetMap: Record<string, string>,
  rules?: Array<{ to: string; when: string }>,
): RoutingMatch[] {
  return classifierResult.intents.map((intent) => {
    const target = (intent.category && targetMap[intent.category]) || null;
    const matchedRule = target ? rules?.find((r) => r.to === target) : undefined;
    return {
      intent,
      target,
      matchedRule: matchedRule
        ? {
            to: matchedRule.to,
            when: matchedRule.when,
            priority: (rules?.indexOf(matchedRule) ?? 0) + 1,
          }
        : undefined,
    };
  });
}

function makeTool(name: string): ToolDefinition {
  return {
    name,
    description: `Tool: ${name}`,
    input_schema: { type: 'object', properties: {}, required: [] },
  };
}

// =============================================================================
// TC-INT-01: Pipeline -> Intent Bridge -> Session State Populated
// =============================================================================

describe('TC-INT-01: Pipeline -> Intent Bridge -> Session State Populated', () => {
  it('populates PipelineIntentState with correct category, confidence, out_of_scope, and target', () => {
    const classifierResult = makeClassifierResult([
      { category: 'product_search', confidence: 0.82, summary: 'product search' },
    ]);
    const routingRules = [
      { to: 'Advisor_Agent', when: 'intent.category == "product_search"' },
      { to: 'Store_Policy_Agent', when: 'intent.category == "store_policy"' },
    ];
    const routingMatches = makeRoutingMatches(
      classifierResult,
      { product_search: 'Advisor_Agent', store_policy: 'Store_Policy_Agent' },
      routingRules,
    );

    const intentState = bridgeIntentsToSessionState(classifierResult, routingMatches);

    expect(intentState.category).toBe('product_search');
    expect(intentState.confidence).toBe(0.82);
    expect(intentState.out_of_scope).toBe(false);
    expect(intentState.target).toBe('Advisor_Agent');
    expect(intentState.summary).toBe('product search');
    expect(intentState.intent_count).toBe(1);
  });

  it('session.data.values.intent is accessible for WHEN condition evaluation', () => {
    const classifierResult = makeClassifierResult([
      { category: 'product_search', confidence: 0.82, summary: 'product search' },
    ]);
    const routingRules = [{ to: 'Advisor_Agent', when: 'intent.category == "product_search"' }];
    const routingMatches = makeRoutingMatches(
      classifierResult,
      { product_search: 'Advisor_Agent' },
      routingRules,
    );

    const intentState = bridgeIntentsToSessionState(classifierResult, routingMatches);

    // Simulate what the reasoning executor does: assign to session.data.values.intent
    const session = {
      data: { values: { intent: null as PipelineIntentState | null } },
    };
    session.data.values.intent = intentState;

    // Verify the session state shape matches what WHEN condition evaluators expect
    expect(session.data.values.intent.category).toBe('product_search');
    expect(session.data.values.intent.confidence).toBe(0.82);
    expect(session.data.values.intent.out_of_scope).toBe(false);
    expect(session.data.values.intent.target).toBe('Advisor_Agent');
  });
});

// =============================================================================
// TC-INT-02: Pipeline -> Out-of-Scope Decline Flow (Tier 1)
// =============================================================================

describe('TC-INT-02: Pipeline -> Out-of-Scope Decline Flow (Tier 1)', () => {
  it('bridges to out_of_scope state, then resolves Tier 1 decline with message', () => {
    const classifierResult = makeClassifierResult([
      { category: null, confidence: 0.92, summary: 'flight booking request' },
    ]);
    const agentIR = makeAgentIR({
      limitations: ['Cannot book flights', 'Cannot make reservations'],
      routing: [
        { to: 'Advisor_Agent', when: 'intent.category == "product_search"' },
        { to: 'Store_Policy_Agent', when: 'intent.category == "store_policy"' },
      ],
    });

    // category=null means no routing rule can match → empty routing matches
    const routingMatches: RoutingMatch[] = classifierResult.intents.map((intent) => ({
      intent,
      target: null,
    }));

    // Step 1: Intent bridge marks out_of_scope
    const intentState = bridgeIntentsToSessionState(classifierResult, routingMatches);
    expect(intentState.out_of_scope).toBe(true);
    expect(intentState.target).toBeNull();
    expect(intentState.confidence).toBe(0.92);

    // Step 2: Tiered resolver produces Tier 1 decline
    const tieredAction = resolveTieredAction(
      classifierResult,
      routingMatches,
      DEFAULT_INTENT_BRIDGE_CONFIG,
      agentIR,
    );

    expect(tieredAction.tier).toBe(1);
    expect(tieredAction.action).toBe('decline_out_of_scope');
    if (tieredAction.action === 'decline_out_of_scope') {
      expect(tieredAction.message).toBeTruthy();
      expect(tieredAction.message.length).toBeGreaterThan(10);
    }
  });

  it('uses custom out_of_scope message from agentIR when set', () => {
    const customMessage = 'Sorry, I can only help with store-related questions.';
    const agentIR = makeAgentIR({
      limitations: ['Cannot book flights'],
      messages: { out_of_scope: customMessage },
    });
    const classifierResult = makeClassifierResult([
      { category: null, confidence: 0.92, summary: 'flight booking' },
    ]);
    const routingMatches: RoutingMatch[] = classifierResult.intents.map((intent) => ({
      intent,
      target: null,
    }));

    const action = resolveTieredAction(
      classifierResult,
      routingMatches,
      DEFAULT_INTENT_BRIDGE_CONFIG,
      agentIR,
    );

    expect(action.tier).toBe(1);
    expect(action.action).toBe('decline_out_of_scope');
    if (action.action === 'decline_out_of_scope') {
      expect(action.message).toBe(customMessage);
    }
  });
});

// =============================================================================
// TC-INT-03: Pipeline -> Multi-Intent -> bridgeToMultiIntentResult
// =============================================================================

describe('TC-INT-03: Pipeline -> Multi-Intent -> bridgeToMultiIntentResult', () => {
  it('two intents targeting different agents produce guided + multi-intent dispatch', () => {
    const classifierResult = makeClassifierResult([
      { category: 'product_search', confidence: 0.75, summary: 'product search' },
      { category: 'store_policy', confidence: 0.65, summary: 'return policy' },
    ]);
    classifierResult.relationship = {
      type: 'independent',
      reasoning: 'Classifier determined the intents can execute independently',
    };
    const routingRules = [
      { to: 'Advisor_Agent', when: 'intent.category == "product_search"' },
      { to: 'Store_Policy_Agent', when: 'intent.category == "store_policy"' },
    ];
    const routingMatches = makeRoutingMatches(
      classifierResult,
      { product_search: 'Advisor_Agent', store_policy: 'Store_Policy_Agent' },
      routingRules,
    );
    const agentIR = makeAgentIR({ routing: routingRules });
    agentIR.metadata = {
      ...agentIR.metadata,
      type: 'supervisor',
    } as AgentIR['metadata'];
    agentIR.intent_handling = {
      multi_intent: {
        enabled: true,
        strategy: 'parallel',
        max_intents: 3,
        confidence_threshold: 0.6,
        queue_max_age_ms: 600_000,
      },
    } as AgentIR['intent_handling'];

    // Step 1: Intent bridge detects 2 intents
    const intentState = bridgeIntentsToSessionState(classifierResult, routingMatches);
    expect(intentState.intent_count).toBe(2);
    expect(intentState.category).toBe('product_search'); // primary (highest confidence)

    // Step 2: Tiered resolver produces Tier 2 guided with multiIntentSignal
    const tieredAction = resolveTieredAction(
      classifierResult,
      routingMatches,
      DEFAULT_INTENT_BRIDGE_CONFIG,
      agentIR,
    );

    expect(tieredAction.tier).toBe(2);
    expect(tieredAction.action).toBe('guided');
    if (tieredAction.action === 'guided') {
      expect(tieredAction.hints.multiIntentSignal).toBeDefined();
      expect(tieredAction.hints.multiIntentSignal!.intents).toHaveLength(2);
      expect(tieredAction.hints.multiIntentSignal!.suggestedAction).toBe('sequential_handoff');
    }

    // Step 3a: target-preserving bridge keeps executable targets
    const detected = bridgeToDetectedMultiIntent(classifierResult, routingMatches);
    expect(detected).not.toBeNull();
    expect(detected!.primary.intent).toBe('product search');
    expect(detected!.primary.target).toEqual({
      kind: 'agent',
      ref: 'Advisor_Agent',
      label: 'Advisor_Agent',
    });
    expect(detected!.primary.category).toBe('product_search');
    expect(detected!.alternatives[0].intent).toBe('return policy');
    expect(detected!.alternatives[0].target).toEqual({
      kind: 'agent',
      ref: 'Store_Policy_Agent',
      label: 'Store_Policy_Agent',
    });
    expect(detected!.relationships.type).toBe('independent');

    const resolvedPlan = resolveDetectedMultiIntentPlan({
      sessionId: 'session-guided-bridge',
      agentName: 'Supervisor_Agent',
      agentIR,
      detected: detected!,
      userMessage: 'Show me red sneakers and what is your return policy?',
    });
    expect(resolvedPlan.strategy).toBe('parallel');
    expect(resolvedPlan.fanOutTasks).toEqual([
      { target: 'Advisor_Agent', intent: 'product search' },
      { target: 'Store_Policy_Agent', intent: 'return policy' },
    ]);

    // Step 3b: legacy bridge still produces a valid MultiIntentResult
    const multiResult = bridgeToMultiIntentResult(classifierResult, routingMatches);
    expect(multiResult).not.toBeNull();
    expect(multiResult!.primary.intent).toBe('product_search');
    expect(multiResult!.primary.confidence).toBe(0.75);
    expect(multiResult!.alternatives).toHaveLength(1);
    expect(multiResult!.alternatives[0].intent).toBe('store_policy');
    expect(multiResult!.alternatives[0].confidence).toBe(0.65);
    expect(multiResult!.relationships.type).toBe('independent');
  });

  it('single intent returns null from bridgeToMultiIntentResult', () => {
    const classifierResult = makeClassifierResult([
      { category: 'product_search', confidence: 0.8, summary: 'product search' },
    ]);
    const routingMatches = makeRoutingMatches(classifierResult, {
      product_search: 'Advisor_Agent',
    });

    const detected = bridgeToDetectedMultiIntent(classifierResult, routingMatches);
    expect(detected).toBeNull();

    const multiResult = bridgeToMultiIntentResult(classifierResult, routingMatches);
    expect(multiResult).toBeNull();
  });
});

// =============================================================================
// TC-INT-04: Pipeline Failure -> Tier 3 Fallback
// =============================================================================

describe('TC-INT-04: Pipeline Failure -> Tier 3 Fallback', () => {
  it('no classifierResult prevents intent bridge from running and falls to Tier 3', () => {
    const classifierResult: ClassifierResult | undefined = undefined;
    const agentIR = makeAgentIR({
      limitations: ['Cannot book flights'],
      routing: [{ to: 'Advisor_Agent', when: 'intent.category == "product_search"' }],
    });

    // Simulate the reasoning executor guard: classifierResult && ...
    const shouldBridge = !!(classifierResult && DEFAULT_INTENT_BRIDGE_CONFIG.enabled);
    expect(shouldBridge).toBe(false);

    // Tiered resolver handles missing classifier gracefully
    const tieredAction = resolveTieredAction(
      classifierResult,
      [],
      DEFAULT_INTENT_BRIDGE_CONFIG,
      agentIR,
    );

    expect(tieredAction.tier).toBe(3);
    expect(tieredAction.action).toBe('autonomous');
    if (tieredAction.action === 'autonomous') {
      expect(tieredAction.reason).toContain('no classifier result');
    }
  });

  it('empty intents array also falls to Tier 3', () => {
    const classifierResult: ClassifierResult = { intents: [] };
    const agentIR = makeAgentIR({});

    // Intent bridge produces zero-state
    const intentState = bridgeIntentsToSessionState(classifierResult, []);
    expect(intentState.intent_count).toBe(0);
    expect(intentState.confidence).toBe(0);

    // Tiered resolver gives Tier 3
    const tieredAction = resolveTieredAction(
      classifierResult,
      [],
      DEFAULT_INTENT_BRIDGE_CONFIG,
      agentIR,
    );
    expect(tieredAction.tier).toBe(3);
    expect(tieredAction.action).toBe('autonomous');
    if (tieredAction.action === 'autonomous') {
      expect(tieredAction.reason).toContain('empty intents');
    }
  });

  it('no session state mutation when classifier is absent', () => {
    const classifierResult: ClassifierResult | undefined = undefined;
    const session = {
      data: { values: { intent: undefined as PipelineIntentState | undefined } },
    };

    // Replicate the guard from reasoning-executor.ts
    if (classifierResult && DEFAULT_INTENT_BRIDGE_CONFIG.enabled) {
      session.data.values.intent = bridgeIntentsToSessionState(classifierResult, []);
    }

    // Session state should remain untouched
    expect(session.data.values.intent).toBeUndefined();
  });
});

// =============================================================================
// TC-INT-05: Config Resolution Integration
// =============================================================================

describe('TC-INT-05: Config Resolution Integration', () => {
  it('agent-level intentBridge overrides project-level', () => {
    const agentExecution = {
      pipeline: {
        enabled: true,
        intentBridge: {
          outOfScopeDecline: true,
        },
      },
      hints: {} as any,
      timeouts: {} as any,
    };
    const projectPipeline = {
      enabled: true,
      intentBridge: {
        outOfScopeDecline: false,
        guidedThreshold: 0.6,
      },
    };

    const config = resolvePipelineConfig(agentExecution, projectPipeline);

    // Agent wins on outOfScopeDecline
    expect(config.intentBridge.outOfScopeDecline).toBe(true);
    // Project fills guidedThreshold (agent didn't set it)
    expect(config.intentBridge.guidedThreshold).toBe(0.6);
  });

  it('project fills gaps, defaults fill the rest', () => {
    const agentExecution = {
      pipeline: {
        enabled: true,
      },
      hints: {} as any,
      timeouts: {} as any,
    };
    const projectPipeline = {
      intentBridge: {
        guidedThreshold: 0.6,
      },
    };

    const config = resolvePipelineConfig(agentExecution, projectPipeline);

    // Project fills guidedThreshold
    expect(config.intentBridge.guidedThreshold).toBe(0.6);
    // Defaults fill programmaticThreshold (neither agent nor project set it)
    expect(config.intentBridge.programmaticThreshold).toBe(0.85);
    // Defaults fill outOfScopeDecline
    expect(config.intentBridge.outOfScopeDecline).toBe(true);
    // Defaults fill multiIntentSignal
    expect(config.intentBridge.multiIntentSignal).toBe(true);
    // Defaults fill enabled
    expect(config.intentBridge.enabled).toBe(true);
  });

  it('all defaults when no overrides provided', () => {
    const config = resolvePipelineConfig(undefined, undefined);

    expect(config.enabled).toBe(false); // pipeline disabled by default
    expect(config.intentBridge.enabled).toBe(true);
    expect(config.intentBridge.programmaticThreshold).toBe(0.85);
    expect(config.intentBridge.guidedThreshold).toBe(0.5);
    expect(config.intentBridge.outOfScopeDecline).toBe(true);
    expect(config.intentBridge.multiIntentSignal).toBe(true);
  });

  it('resolved config feeds correctly into resolveTieredAction', () => {
    // Custom thresholds: lower programmatic, higher guided
    const agentExecution = {
      pipeline: {
        enabled: true,
        intentBridge: {
          programmaticThreshold: 0.7,
          guidedThreshold: 0.4,
        },
      },
      hints: {} as any,
      timeouts: {} as any,
    };
    const config = resolvePipelineConfig(agentExecution, undefined);

    const agentIR = makeAgentIR({ limitations: ['Cannot book flights'] });
    const classifierResult = makeClassifierResult([
      { category: null, confidence: 0.72, summary: 'flight booking' },
    ]);
    const routingMatches: RoutingMatch[] = classifierResult.intents.map((intent) => ({
      intent,
      target: null,
    }));

    // With lowered programmaticThreshold of 0.7, confidence 0.72 triggers Tier 1 decline
    const action = resolveTieredAction(
      classifierResult,
      routingMatches,
      config.intentBridge,
      agentIR,
    );
    expect(action.tier).toBe(1);
    expect(action.action).toBe('decline_out_of_scope');
  });
});

// =============================================================================
// TC-INT-06: End-to-End Data Flow — Guided Tier Hidden Tools Applied
// =============================================================================

describe('TC-INT-06: End-to-End Data Flow — Guided Tier Hidden Tools Applied', () => {
  it('hides non-matching handoff tools while preserving matched ones', () => {
    const routingRules = [
      { to: 'Advisor_Agent', when: 'intent.category == "product_search"' },
      { to: 'Store_Policy_Agent', when: 'intent.category == "store_policy"' },
    ];
    const agentIR = makeAgentIR({ routing: routingRules });

    // Step 1: Classifier identifies single category
    const classifierResult = makeClassifierResult([
      { category: 'product_search', confidence: 0.7, summary: 'product search' },
    ]);
    const routingMatches = makeRoutingMatches(
      classifierResult,
      { product_search: 'Advisor_Agent', store_policy: 'Store_Policy_Agent' },
      routingRules,
    );

    // Step 2: Bridge populates session state
    const intentState = bridgeIntentsToSessionState(classifierResult, routingMatches);
    expect(intentState.target).toBe('Advisor_Agent');

    // Step 3: Tiered resolver gives guided action with hidden tools
    const tieredAction = resolveTieredAction(
      classifierResult,
      routingMatches,
      DEFAULT_INTENT_BRIDGE_CONFIG,
      agentIR,
    );
    expect(tieredAction.tier).toBe(2);
    expect(tieredAction.action).toBe('guided');

    if (tieredAction.action === 'guided') {
      expect(tieredAction.hints.hiddenTools).toContain('handoff_to_Store_Policy_Agent');
      expect(tieredAction.hints.hiddenTools).not.toContain('handoff_to_Advisor_Agent');

      // Step 4: Apply hidden tools filter (same logic as reasoning-executor)
      const allTools: ToolDefinition[] = [
        makeTool('search_products'),
        makeTool('handoff_to_Advisor_Agent'),
        makeTool('handoff_to_Store_Policy_Agent'),
        makeTool('get_inventory'),
      ];

      const hidden = new Set(tieredAction.hints.hiddenTools);
      const filteredTools = allTools.filter((t) => !hidden.has(t.name));

      expect(filteredTools.map((t) => t.name)).toEqual([
        'search_products',
        'handoff_to_Advisor_Agent',
        'get_inventory',
      ]);
      expect(filteredTools.map((t) => t.name)).not.toContain('handoff_to_Store_Policy_Agent');
    }
  });

  it('escalation handoff tools are never hidden even when not in classifier targets', () => {
    const routingRules = [
      { to: 'Advisor_Agent', when: 'intent.category == "product_search"' },
      { to: 'Store_Policy_Agent', when: 'intent.category == "store_policy"' },
    ];
    const agentIR = makeAgentIR({
      routing: routingRules,
      handoffs: [{ to: 'Escalation_Agent', when: 'intent.category == "escalate"' }],
    });

    const classifierResult = makeClassifierResult([
      { category: 'product_search', confidence: 0.7, summary: 'product search' },
    ]);
    const routingMatches = makeRoutingMatches(
      classifierResult,
      { product_search: 'Advisor_Agent' },
      routingRules,
    );

    const tieredAction = resolveTieredAction(
      classifierResult,
      routingMatches,
      DEFAULT_INTENT_BRIDGE_CONFIG,
      agentIR,
    );

    if (tieredAction.action === 'guided') {
      expect(tieredAction.hints.hiddenTools).toContain('handoff_to_Store_Policy_Agent');
      expect(tieredAction.hints.hiddenTools).not.toContain('handoff_to_Escalation_Agent');
      expect(tieredAction.hints.hiddenTools).not.toContain('handoff_to_Advisor_Agent');

      // Apply filter — escalation tool must survive
      const allTools: ToolDefinition[] = [
        makeTool('handoff_to_Advisor_Agent'),
        makeTool('handoff_to_Store_Policy_Agent'),
        makeTool('handoff_to_Escalation_Agent'),
      ];
      const hidden = new Set(tieredAction.hints.hiddenTools);
      const filteredTools = allTools.filter((t) => !hidden.has(t.name));

      expect(filteredTools.map((t) => t.name)).toContain('handoff_to_Escalation_Agent');
      expect(filteredTools.map((t) => t.name)).toContain('handoff_to_Advisor_Agent');
      expect(filteredTools.map((t) => t.name)).not.toContain('handoff_to_Store_Policy_Agent');
    }
  });

  it('guided action includes routing hint for single-intent case', () => {
    const routingRules = [{ to: 'Advisor_Agent', when: 'intent.category == "product_search"' }];
    const agentIR = makeAgentIR({ routing: routingRules });
    const classifierResult = makeClassifierResult([
      { category: 'product_search', confidence: 0.7, summary: 'product search' },
    ]);
    const routingMatches = makeRoutingMatches(
      classifierResult,
      { product_search: 'Advisor_Agent' },
      routingRules,
    );

    const tieredAction = resolveTieredAction(
      classifierResult,
      routingMatches,
      DEFAULT_INTENT_BRIDGE_CONFIG,
      agentIR,
    );

    expect(tieredAction.tier).toBe(2);
    if (tieredAction.action === 'guided') {
      expect(tieredAction.hints.routingHint).toBeDefined();
      expect(tieredAction.hints.routingHint).toContain('Advisor_Agent');
      expect(tieredAction.hints.routingHint).toContain('0.70');
    }
  });
});

// =============================================================================
// TC-INT-07: End-to-End — Confidence Clamping
// =============================================================================

describe('TC-INT-07: End-to-End — Confidence Clamping', () => {
  it('clamped confidence of 1.0 with category=null triggers Tier 1 decline', () => {
    const agentIR = makeAgentIR({
      limitations: ['Cannot book flights'],
      routing: [{ to: 'Advisor_Agent', when: 'intent.category == "product_search"' }],
    });

    // Upstream clamped to 1.0
    const classifierResult = makeClassifierResult([
      { category: null, confidence: 1.0, summary: 'definitely out of scope' },
    ]);
    const routingMatches: RoutingMatch[] = classifierResult.intents.map((intent) => ({
      intent,
      target: null,
    }));

    const intentState = bridgeIntentsToSessionState(classifierResult, routingMatches);
    expect(intentState.out_of_scope).toBe(true);
    expect(intentState.confidence).toBe(1.0);

    const action = resolveTieredAction(
      classifierResult,
      routingMatches,
      DEFAULT_INTENT_BRIDGE_CONFIG,
      agentIR,
    );

    expect(action.tier).toBe(1);
    expect(action.action).toBe('decline_out_of_scope');
  });

  it('confidence of exactly 0 triggers Tier 3 autonomous', () => {
    const agentIR = makeAgentIR({
      routing: [{ to: 'Advisor_Agent', when: 'intent.category == "product_search"' }],
    });

    const classifierResult = makeClassifierResult([
      { category: 'product_search', confidence: 0, summary: 'no clue' },
    ]);
    const routingMatches = makeRoutingMatches(classifierResult, {
      product_search: 'Advisor_Agent',
    });

    const intentState = bridgeIntentsToSessionState(classifierResult, routingMatches);
    expect(intentState.confidence).toBe(0);

    const action = resolveTieredAction(
      classifierResult,
      routingMatches,
      DEFAULT_INTENT_BRIDGE_CONFIG,
      agentIR,
    );

    expect(action.tier).toBe(3);
    expect(action.action).toBe('autonomous');
    if (action.action === 'autonomous') {
      expect(action.reason).toContain('low confidence');
    }
  });

  it('confidence just below guidedThreshold (0.49) is Tier 3, at threshold (0.5) is Tier 2', () => {
    const agentIR = makeAgentIR({
      routing: [{ to: 'Advisor_Agent', when: 'intent.category == "product_search"' }],
    });

    // Below guidedThreshold → Tier 3
    const belowClassifier = makeClassifierResult([
      { category: 'product_search', confidence: 0.49, summary: 'maybe product' },
    ]);
    const belowMatches = makeRoutingMatches(belowClassifier, {
      product_search: 'Advisor_Agent',
    });
    const belowAction = resolveTieredAction(
      belowClassifier,
      belowMatches,
      DEFAULT_INTENT_BRIDGE_CONFIG,
      agentIR,
    );
    expect(belowAction.tier).toBe(3);
    expect(belowAction.action).toBe('autonomous');

    // At guidedThreshold → Tier 2
    const atClassifier = makeClassifierResult([
      { category: 'product_search', confidence: 0.5, summary: 'product search' },
    ]);
    const atMatches = makeRoutingMatches(atClassifier, { product_search: 'Advisor_Agent' });
    const atAction = resolveTieredAction(
      atClassifier,
      atMatches,
      DEFAULT_INTENT_BRIDGE_CONFIG,
      agentIR,
    );
    expect(atAction.tier).toBe(2);
    expect(atAction.action).toBe('guided');
  });

  it('confidence just below programmaticThreshold (0.84) with null category is Tier 2, at threshold (0.85) is Tier 1', () => {
    const agentIR = makeAgentIR({
      limitations: ['Cannot do X'],
      routing: [{ to: 'Advisor_Agent', when: 'intent.category == "product_search"' }],
    });

    // Below programmaticThreshold with null category → Tier 2 (guided, since >= guidedThreshold)
    const belowClassifier = makeClassifierResult([
      { category: null, confidence: 0.84, summary: 'out of scope' },
    ]);
    const belowMatches: RoutingMatch[] = belowClassifier.intents.map((intent) => ({
      intent,
      target: null,
    }));
    const belowAction = resolveTieredAction(
      belowClassifier,
      belowMatches,
      DEFAULT_INTENT_BRIDGE_CONFIG,
      agentIR,
    );
    expect(belowAction.tier).toBe(2);
    expect(belowAction.action).toBe('guided');

    // At programmaticThreshold with null category → Tier 1 decline
    const atClassifier = makeClassifierResult([
      { category: null, confidence: 0.85, summary: 'out of scope' },
    ]);
    const atMatches: RoutingMatch[] = atClassifier.intents.map((intent) => ({
      intent,
      target: null,
    }));
    const atAction = resolveTieredAction(
      atClassifier,
      atMatches,
      DEFAULT_INTENT_BRIDGE_CONFIG,
      agentIR,
    );
    expect(atAction.tier).toBe(1);
    expect(atAction.action).toBe('decline_out_of_scope');
  });
});
