/**
 * Tests for pipeline tiered resolver — determines which action tier to apply
 * based on pipeline classifier output and intent bridge config.
 */

import { describe, it, expect } from 'vitest';
import { resolveTieredAction } from '../services/pipeline/tiered-resolver.js';
import type { AgentIR } from '@abl/compiler';
import type {
  ClassifierResult,
  RoutingMatch,
  ClassifiedIntent,
  IntentBridgeConfig,
} from '../services/pipeline/types.js';

// =============================================================================
// HELPERS
// =============================================================================

const DEFAULT_CONFIG: IntentBridgeConfig = {
  enabled: true,
  programmaticThreshold: 0.85,
  guidedThreshold: 0.5,
  outOfScopeDecline: true,
  multiIntentSignal: true,
};

function makeAgentIR(opts: {
  limitations?: string[];
  routing?: Array<{ to: string }>;
  handoffs?: Array<{ to: string; when: string }>;
}): AgentIR {
  return {
    ir_version: '1.0',
    metadata: { name: 'TestAgent', version: '1.0', description: '' },
    execution: { hints: {} as any, timeouts: {} as any },
    identity: {
      goal: '',
      persona: '',
      limitations: opts.limitations ?? ['Cannot book flights'],
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
    messages: {} as any,
    routing: opts.routing
      ? {
          rules: opts.routing.map((r, i) => ({
            to: r.to,
            when: '',
            description: '',
            priority: i + 1,
          })),
          default_agent: 'Fallback',
          intent_classification: {
            categories: [],
            min_confidence: 0.5,
            source: 'inferred' as const,
          },
        }
      : undefined,
  } as AgentIR;
}

function makeClassifierResult(
  intents: Array<{
    category: string | null;
    confidence: number;
    summary: string;
    out_of_scope?: boolean;
  }>,
): ClassifierResult {
  return {
    intents: intents.map((i) => ({
      category: i.category,
      confidence: i.confidence,
      summary: i.summary,
      out_of_scope: i.out_of_scope,
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

// =============================================================================
// Tier 1: Programmatic Actions
// =============================================================================

describe('Tier 1: Programmatic Actions', () => {
  it('TC-TR-01: null category, high confidence, with limitations → decline_out_of_scope', () => {
    const cr = makeClassifierResult([
      { category: null, confidence: 0.92, summary: 'flight booking' },
    ]);
    const routingMatches: RoutingMatch[] = [];
    const ir = makeAgentIR({ limitations: ['Cannot book flights'] });
    const action = resolveTieredAction(cr, routingMatches, DEFAULT_CONFIG, ir);
    expect(action.tier).toBe(1);
    expect(action.action).toBe('decline_out_of_scope');
    if (action.action === 'decline_out_of_scope') {
      expect(action.message.length).toBeGreaterThan(10);
    }
  });

  it('TC-TR-02: null category, confidence < programmaticThreshold → NOT tier 1', () => {
    const cr = makeClassifierResult([{ category: null, confidence: 0.6, summary: 'booking' }]);
    const routingMatches: RoutingMatch[] = [];
    const ir = makeAgentIR({ limitations: ['Cannot book flights'] });
    const action = resolveTieredAction(cr, routingMatches, DEFAULT_CONFIG, ir);
    expect(action.tier).not.toBe(1);
  });

  it('TC-TR-03: null category, high confidence, outOfScopeDecline disabled → NOT tier 1', () => {
    const cr = makeClassifierResult([{ category: null, confidence: 0.92, summary: 'booking' }]);
    const routingMatches: RoutingMatch[] = [];
    const ir = makeAgentIR({ limitations: ['Cannot book flights'] });
    const config = { ...DEFAULT_CONFIG, outOfScopeDecline: false };
    const action = resolveTieredAction(cr, routingMatches, config, ir);
    // Should be tier 2 (guided) since confidence >= guidedThreshold
    expect(action.action).not.toBe('decline_out_of_scope');
  });

  it('TC-TR-04: agent without limitations → outOfScopeDecline does not trigger', () => {
    const cr = makeClassifierResult([{ category: null, confidence: 0.95, summary: 'booking' }]);
    const routingMatches: RoutingMatch[] = [];
    const ir = makeAgentIR({ limitations: [] });
    const action = resolveTieredAction(cr, routingMatches, DEFAULT_CONFIG, ir);
    expect(action.action).not.toBe('decline_out_of_scope');
  });

  it('TC-TR-05: confidence exactly at programmaticThreshold triggers Tier 1', () => {
    const cr = makeClassifierResult([
      { category: null, confidence: 0.85, summary: 'out of scope' },
    ]);
    const routingMatches: RoutingMatch[] = [];
    const ir = makeAgentIR({ limitations: ['Cannot do X'] });
    const action = resolveTieredAction(cr, routingMatches, DEFAULT_CONFIG, ir);
    expect(action.tier).toBe(1);
    expect(action.action).toBe('decline_out_of_scope');
  });

  it('TC-TR-06: null category but out_of_scope=false → NOT decline (in-scope uncategorized)', () => {
    const cr = makeClassifierResult([
      { category: null, confidence: 0.92, summary: 'What options do I have?', out_of_scope: false },
    ]);
    const routingMatches: RoutingMatch[] = [];
    const ir = makeAgentIR({ limitations: ['Cannot book flights'] });
    const action = resolveTieredAction(cr, routingMatches, DEFAULT_CONFIG, ir);
    // Should NOT decline — classifier explicitly says in-scope
    expect(action.action).not.toBe('decline_out_of_scope');
  });

  it('TC-TR-07: null category with out_of_scope=true → decline', () => {
    const cr = makeClassifierResult([
      { category: null, confidence: 0.92, summary: 'Book me a flight', out_of_scope: true },
    ]);
    const routingMatches: RoutingMatch[] = [];
    const ir = makeAgentIR({ limitations: ['Cannot book flights'] });
    const action = resolveTieredAction(cr, routingMatches, DEFAULT_CONFIG, ir);
    expect(action.tier).toBe(1);
    expect(action.action).toBe('decline_out_of_scope');
  });

  it('uses the localized message resolver for out-of-scope declines', () => {
    const cr = makeClassifierResult([
      { category: null, confidence: 0.92, summary: 'Book me a flight', out_of_scope: true },
    ]);
    const routingMatches: RoutingMatch[] = [];
    const ir = makeAgentIR({ limitations: ['Cannot book flights'] });

    const action = resolveTieredAction(
      cr,
      routingMatches,
      DEFAULT_CONFIG,
      ir,
      (messageKey, fallbackMessage) =>
        messageKey === 'out_of_scope' ? 'Localized decline.' : (fallbackMessage ?? ''),
    );

    expect(action.tier).toBe(1);
    expect(action.action).toBe('decline_out_of_scope');
    if (action.action === 'decline_out_of_scope') {
      expect(action.message).toBe('Localized decline.');
    }
  });

  it('TC-TR-08: null category with out_of_scope undefined (legacy) → decline (backward compat)', () => {
    const cr = makeClassifierResult([
      { category: null, confidence: 0.92, summary: 'flight booking' },
    ]);
    const routingMatches: RoutingMatch[] = [];
    const ir = makeAgentIR({ limitations: ['Cannot book flights'] });
    const action = resolveTieredAction(cr, routingMatches, DEFAULT_CONFIG, ir);
    // Legacy behavior: out_of_scope not set, category is null → treat as out-of-scope
    expect(action.tier).toBe(1);
    expect(action.action).toBe('decline_out_of_scope');
  });
});

// =============================================================================
// Tier 2: Guided Actions
// =============================================================================

describe('Tier 2: Guided Actions', () => {
  it('TC-TR-10: single intent, confidence in guided range → guided', () => {
    const cr = makeClassifierResult([
      { category: 'product_search', confidence: 0.7, summary: 'product search' },
    ]);
    const intent = cr.intents[0];
    const routingMatches = [makeRoutingMatch(intent, 'Advisor_Agent')];
    const ir = makeAgentIR({
      routing: [{ to: 'Advisor_Agent' }, { to: 'Store_Policy_Agent' }],
    });
    const action = resolveTieredAction(cr, routingMatches, DEFAULT_CONFIG, ir);
    expect(action.tier).toBe(2);
    expect(action.action).toBe('guided');
    if (action.action === 'guided') {
      expect(action.hints.routingHint).toContain('Advisor_Agent');
    }
  });

  it('TC-TR-11: guided mode hides tools for non-matching targets', () => {
    const cr = makeClassifierResult([
      { category: 'product_search', confidence: 0.7, summary: 'product search' },
    ]);
    const intent = cr.intents[0];
    const routingMatches = [makeRoutingMatch(intent, 'Advisor_Agent')];
    const ir = makeAgentIR({
      routing: [{ to: 'Advisor_Agent' }, { to: 'Store_Policy_Agent' }],
    });
    const action = resolveTieredAction(cr, routingMatches, DEFAULT_CONFIG, ir);
    expect(action.tier).toBe(2);
    if (action.action === 'guided') {
      expect(action.hints.hiddenTools).toContain('handoff_to_Store_Policy_Agent');
      expect(action.hints.hiddenTools).not.toContain('handoff_to_Advisor_Agent');
    }
  });

  it('TC-TR-12: multi-intent, all >= guidedThreshold → guided with multiIntentSignal', () => {
    const cr = makeClassifierResult([
      { category: 'product_search', confidence: 0.7, summary: 'product' },
      { category: 'store_policy', confidence: 0.6, summary: 'policy' },
    ]);
    const routingMatches = [
      makeRoutingMatch(cr.intents[0], 'Advisor_Agent'),
      makeRoutingMatch(cr.intents[1], 'Store_Policy_Agent'),
    ];
    const ir = makeAgentIR({
      routing: [{ to: 'Advisor_Agent' }, { to: 'Store_Policy_Agent' }],
    });
    const action = resolveTieredAction(cr, routingMatches, DEFAULT_CONFIG, ir);
    expect(action.tier).toBe(2);
    if (action.action === 'guided') {
      expect(action.hints.multiIntentSignal).toBeDefined();
      expect(action.hints.multiIntentSignal!.intents).toHaveLength(2);
      expect(action.hints.multiIntentSignal!.suggestedAction).toBe('sequential_handoff');
    }
  });

  it('TC-TR-13: multiIntentSignal disabled → no signal', () => {
    const cr = makeClassifierResult([
      { category: 'product_search', confidence: 0.7, summary: 'product' },
      { category: 'store_policy', confidence: 0.6, summary: 'policy' },
    ]);
    const routingMatches = [
      makeRoutingMatch(cr.intents[0], 'Advisor_Agent'),
      makeRoutingMatch(cr.intents[1], 'Store_Policy_Agent'),
    ];
    const ir = makeAgentIR({
      routing: [{ to: 'Advisor_Agent' }, { to: 'Store_Policy_Agent' }],
    });
    const config = { ...DEFAULT_CONFIG, multiIntentSignal: false };
    const action = resolveTieredAction(cr, routingMatches, config, ir);
    expect(action.tier).toBe(2);
    if (action.action === 'guided') {
      expect(action.hints.multiIntentSignal).toBeUndefined();
    }
  });

  it('TC-TR-14: confidence exactly at guidedThreshold triggers Tier 2', () => {
    const cr = makeClassifierResult([
      { category: 'product_search', confidence: 0.5, summary: 'product' },
    ]);
    const intent = cr.intents[0];
    const routingMatches = [makeRoutingMatch(intent, 'Advisor_Agent')];
    const ir = makeAgentIR({
      routing: [{ to: 'Advisor_Agent' }],
    });
    const action = resolveTieredAction(cr, routingMatches, DEFAULT_CONFIG, ir);
    expect(action.tier).toBe(2);
    expect(action.action).toBe('guided');
  });

  it('TC-TR-15: same-target multi-intent suggests address_primary', () => {
    const cr = makeClassifierResult([
      { category: 'product_search', confidence: 0.7, summary: 'search shoes' },
      { category: 'price_compare', confidence: 0.6, summary: 'compare prices' },
    ]);
    const routingMatches = [
      makeRoutingMatch(cr.intents[0], 'Advisor_Agent'),
      makeRoutingMatch(cr.intents[1], 'Advisor_Agent'),
    ];
    const ir = makeAgentIR({
      routing: [{ to: 'Advisor_Agent' }],
    });
    const action = resolveTieredAction(cr, routingMatches, DEFAULT_CONFIG, ir);
    expect(action.tier).toBe(2);
    expect(action.action).toBe('guided');
    if (action.action === 'guided') {
      expect(action.hints.multiIntentSignal?.suggestedAction).toBe('address_primary');
    }
  });

  it('TC-TR-17: escalation handoff tools are never hidden', () => {
    const cr = makeClassifierResult([
      { category: 'product_search', confidence: 0.7, summary: 'product' },
    ]);
    const intent = cr.intents[0];
    const routingMatches = [makeRoutingMatch(intent, 'Advisor_Agent')];
    const ir = makeAgentIR({
      routing: [{ to: 'Advisor_Agent' }, { to: 'Store_Policy_Agent' }],
      handoffs: [{ to: 'Escalation_Agent', when: 'intent.category == "escalate"' }],
    });
    const action = resolveTieredAction(cr, routingMatches, DEFAULT_CONFIG, ir);
    expect(action.tier).toBe(2);
    if (action.action === 'guided') {
      expect(action.hints.hiddenTools).toContain('handoff_to_Store_Policy_Agent');
      expect(action.hints.hiddenTools).not.toContain('handoff_to_Escalation_Agent');
    }
  });

  it('TC-TR-16: coordination handoffs are included in hidden tools', () => {
    const cr = makeClassifierResult([
      { category: 'product_search', confidence: 0.7, summary: 'product' },
    ]);
    const intent = cr.intents[0];
    const routingMatches = [makeRoutingMatch(intent, 'Advisor_Agent')];
    const ir = makeAgentIR({
      handoffs: [{ to: 'Store_Policy_Agent', when: 'intent.category == "store_policy"' }],
    });
    const action = resolveTieredAction(cr, routingMatches, DEFAULT_CONFIG, ir);
    expect(action.tier).toBe(2);
    if (action.action === 'guided') {
      expect(action.hints.hiddenTools).toContain('handoff_to_Store_Policy_Agent');
    }
  });

  it('TC-TR-18: multi-intent with same category+confidence but different summary matches correctly', () => {
    const cr = makeClassifierResult([
      { category: 'billing', confidence: 0.7, summary: 'check balance' },
      { category: 'billing', confidence: 0.7, summary: 'dispute charge' },
    ]);
    const routingMatches = [
      makeRoutingMatch(cr.intents[0], 'Balance_Agent'),
      makeRoutingMatch(cr.intents[1], 'Dispute_Agent'),
    ];
    const ir = makeAgentIR({
      routing: [{ to: 'Balance_Agent' }, { to: 'Dispute_Agent' }],
    });
    const action = resolveTieredAction(cr, routingMatches, DEFAULT_CONFIG, ir);
    expect(action.tier).toBe(2);
    if (action.action === 'guided') {
      const signal = action.hints.multiIntentSignal;
      expect(signal).toBeDefined();
      // Each intent should resolve to its correct target via reference identity
      expect(signal!.intents[0].target).toBe('Balance_Agent');
      expect(signal!.intents[1].target).toBe('Dispute_Agent');
    }
  });
});

// =============================================================================
// Tier 3: Autonomous
// =============================================================================

describe('Tier 3: Autonomous', () => {
  it('TC-TR-20: confidence < guidedThreshold → autonomous', () => {
    const cr = makeClassifierResult([
      { category: 'vague', confidence: 0.3, summary: 'vague query' },
    ]);
    const routingMatches: RoutingMatch[] = [];
    const ir = makeAgentIR({});
    const action = resolveTieredAction(cr, routingMatches, DEFAULT_CONFIG, ir);
    expect(action.tier).toBe(3);
    expect(action.action).toBe('autonomous');
    if (action.action === 'autonomous') {
      expect(action.reason).toContain('low confidence');
    }
  });

  it('TC-TR-21: no classifier result → autonomous', () => {
    const ir = makeAgentIR({});
    const action = resolveTieredAction(undefined, [], DEFAULT_CONFIG, ir);
    expect(action.tier).toBe(3);
    expect(action.action).toBe('autonomous');
    if (action.action === 'autonomous') {
      expect(action.reason).toContain('no classifier result');
    }
  });

  it('TC-TR-22: empty intents → autonomous', () => {
    const cr: ClassifierResult = { intents: [] };
    const ir = makeAgentIR({});
    const action = resolveTieredAction(cr, [], DEFAULT_CONFIG, ir);
    expect(action.tier).toBe(3);
    expect(action.action).toBe('autonomous');
    if (action.action === 'autonomous') {
      expect(action.reason).toContain('empty intents');
    }
  });
});
