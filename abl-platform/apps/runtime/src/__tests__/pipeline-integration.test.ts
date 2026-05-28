/**
 * Pipeline integration test — exercises classify → route → bridge → tier
 * as a composed flow with realistic ABL supervisor config.
 *
 * Uses real pure functions (no mocks). The only thing not exercised is the
 * actual LLM call — classifier output is provided directly.
 */

import { describe, it, expect } from 'vitest';
import { resolveRouting } from '../services/pipeline/routing-resolver.js';
import {
  bridgeIntentsToSessionState,
  bridgeToMultiIntentResult,
} from '../services/pipeline/intent-bridge.js';
import { resolveTieredAction } from '../services/pipeline/tiered-resolver.js';
import type { AgentIR } from '@abl/compiler';
import type { ClassifierResult, IntentBridgeConfig } from '../services/pipeline/types.js';
import type { RoutingRule } from '@abl/compiler/platform/ir/schema.js';

const DEFAULT_BRIDGE_CONFIG: IntentBridgeConfig = {
  enabled: true,
  programmaticThreshold: 0.85,
  guidedThreshold: 0.5,
  outOfScopeDecline: true,
  multiIntentSignal: true,
};

const TELCO_RULES: RoutingRule[] = [
  {
    to: 'Network_Optimization',
    when: 'intent.category == "network_issue"',
    description: '',
    priority: 1,
  },
  { to: 'Billing_Agent', when: 'intent.category == "billing"', description: '', priority: 2 },
  {
    to: 'CX_Agent',
    when: 'intent.category == "customer_experience"',
    description: '',
    priority: 3,
  },
  { to: 'Fallback_Agent', when: 'true', description: '', priority: 99 },
];

const TELCO_IR: AgentIR = {
  ir_version: '1.0',
  metadata: { name: 'Telco_Supervisor', version: '1.0', description: '' },
  execution: { hints: {} as any, timeouts: {} as any },
  identity: {
    goal: 'Route telco customer requests',
    persona: 'Telco supervisor',
    limitations: ['Cannot process payments directly'],
    system_prompt: {} as any,
  },
  tools: [],
  gather: { fields: [] } as any,
  memory: {} as any,
  constraints: { rules: [] } as any,
  coordination: { delegates: [], handoffs: [] },
  completion: {} as any,
  error_handling: {} as any,
  messages: {} as any,
  routing: {
    rules: TELCO_RULES,
    default_agent: 'Fallback_Agent',
    intent_classification: { categories: [], min_confidence: 0.5, source: 'inferred' as const },
  },
} as AgentIR;

describe('Pipeline Integration: classify → route → bridge → tier', () => {
  it('single in-scope intent flows through to guided tier with correct routing', () => {
    const classifierResult: ClassifierResult = {
      intents: [
        { category: 'billing', confidence: 0.78, summary: 'Customer asking about charges' },
      ],
    };

    const routingMatches = resolveRouting(classifierResult.intents, TELCO_RULES, {});
    expect(routingMatches[0].target).toBe('Billing_Agent');

    const intentState = bridgeIntentsToSessionState(classifierResult, routingMatches);
    expect(intentState.category).toBe('billing');
    expect(intentState.target).toBe('Billing_Agent');
    expect(intentState.out_of_scope).toBe(false);

    const action = resolveTieredAction(
      classifierResult,
      routingMatches,
      DEFAULT_BRIDGE_CONFIG,
      TELCO_IR,
    );
    expect(action.tier).toBe(2);
    expect(action.action).toBe('guided');
  });

  it('out-of-scope intent with scope flag results in Tier 1 decline', () => {
    const classifierResult: ClassifierResult = {
      intents: [
        { category: null, confidence: 0.92, summary: 'Book me a flight', out_of_scope: true },
      ],
    };

    const routingMatches = resolveRouting(classifierResult.intents, TELCO_RULES, {});
    expect(routingMatches[0].target).toBe('Fallback_Agent');

    const intentState = bridgeIntentsToSessionState(classifierResult, routingMatches);
    expect(intentState.out_of_scope).toBe(true);

    const action = resolveTieredAction(
      classifierResult,
      routingMatches,
      DEFAULT_BRIDGE_CONFIG,
      TELCO_IR,
    );
    expect(action.tier).toBe(1);
    expect(action.action).toBe('decline_out_of_scope');
  });

  it('in-scope uncategorized intent does NOT decline (C3 regression)', () => {
    const classifierResult: ClassifierResult = {
      intents: [
        {
          category: null,
          confidence: 0.88,
          summary: 'What can you help me with?',
          out_of_scope: false,
        },
      ],
    };

    const routingMatches = resolveRouting(classifierResult.intents, TELCO_RULES, {});

    const intentState = bridgeIntentsToSessionState(classifierResult, routingMatches);
    expect(intentState.out_of_scope).toBe(false);

    const action = resolveTieredAction(
      classifierResult,
      routingMatches,
      DEFAULT_BRIDGE_CONFIG,
      TELCO_IR,
    );
    expect(action.action).not.toBe('decline_out_of_scope');
  });

  it('multi-intent with different targets produces sequential_handoff signal', () => {
    const classifierResult: ClassifierResult = {
      intents: [
        { category: 'billing', confidence: 0.75, summary: 'Check my bill' },
        { category: 'network_issue', confidence: 0.65, summary: 'WiFi is slow' },
      ],
    };

    const routingMatches = resolveRouting(classifierResult.intents, TELCO_RULES, {});
    expect(routingMatches[0].target).toBe('Billing_Agent');
    expect(routingMatches[1].target).toBe('Network_Optimization');

    const multiIntent = bridgeToMultiIntentResult(classifierResult, routingMatches);
    expect(multiIntent).not.toBeNull();
    expect(multiIntent!.primary.intent).toBe('billing');

    const action = resolveTieredAction(
      classifierResult,
      routingMatches,
      DEFAULT_BRIDGE_CONFIG,
      TELCO_IR,
    );
    expect(action.tier).toBe(2);
    if (action.action === 'guided') {
      expect(action.hints.multiIntentSignal?.suggestedAction).toBe('sequential_handoff');
    }
  });

  it('low confidence falls through to Tier 3 autonomous', () => {
    const classifierResult: ClassifierResult = {
      intents: [{ category: 'vague', confidence: 0.3, summary: 'Something weird happened' }],
    };

    const routingMatches = resolveRouting(classifierResult.intents, TELCO_RULES, {});

    const action = resolveTieredAction(
      classifierResult,
      routingMatches,
      DEFAULT_BRIDGE_CONFIG,
      TELCO_IR,
    );
    expect(action.tier).toBe(3);
    expect(action.action).toBe('autonomous');
  });

  it('relational WHEN condition with missing session var does NOT misroute (C2 regression)', () => {
    const classifierResult: ClassifierResult = {
      intents: [{ category: 'network_issue', confidence: 0.85, summary: 'Network slow' }],
    };

    const rulesWithRelational: RoutingRule[] = [
      {
        to: 'Critical_Network_Agent',
        when: 'intent.category == "network_issue" && signal_strength < 30',
        description: '',
        priority: 1,
      },
      {
        to: 'Network_Optimization',
        when: 'intent.category == "network_issue"',
        description: '',
        priority: 2,
      },
    ];

    // signal_strength NOT in session — should NOT match the relational rule
    const routingMatches = resolveRouting(classifierResult.intents, rulesWithRelational, {});
    expect(routingMatches[0].target).toBe('Network_Optimization');
  });
});
