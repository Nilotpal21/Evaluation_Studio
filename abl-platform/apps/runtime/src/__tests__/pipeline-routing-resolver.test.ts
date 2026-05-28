import { describe, it, expect } from 'vitest';
import { resolveRouting } from '../services/pipeline/routing-resolver.js';
import type { ClassifiedIntent, RoutingMatch } from '../services/pipeline/types.js';
import type { RoutingRule } from '@abl/compiler/platform/ir/schema.js';

function makeIntent(category: string | null, confidence = 0.9, summary = 'test'): ClassifiedIntent {
  return { category, confidence, summary };
}

function makeRule(to: string, when: string, priority = 1): RoutingRule {
  return { to, when, description: `Route to ${to}`, priority };
}

describe('resolveRouting', () => {
  it('TC-RR-01 single intent matches single rule', () => {
    const intents = [makeIntent('billing')];
    const rules = [makeRule('Billing_Agent', 'intent.category == "billing"')];
    const matches = resolveRouting(intents, rules, {});
    expect(matches).toHaveLength(1);
    expect(matches[0].target).toBe('Billing_Agent');
    expect(matches[0].intent.category).toBe('billing');
  });

  it('TC-RR-02 no matching rule returns null target', () => {
    const intents = [makeIntent('billing')];
    const rules = [makeRule('Setup_Agent', 'intent.category == "setup"')];
    const matches = resolveRouting(intents, rules, {});
    expect(matches).toHaveLength(1);
    expect(matches[0].target).toBeNull();
  });

  it('TC-RR-03 multiple rules — first match by priority wins', () => {
    const intents = [makeIntent('billing')];
    const rules = [
      makeRule('General_Agent', 'intent.category == "billing"', 2),
      makeRule('Priority_Agent', 'intent.category == "billing"', 1),
    ];
    const matches = resolveRouting(intents, rules, {});
    expect(matches[0].target).toBe('Priority_Agent');
  });

  it('TC-RR-04 OR condition in WHEN matches', () => {
    const intents = [makeIntent('setup')];
    const rules = [
      makeRule('Device_Agent', 'intent.category == "device_issue" || intent.category == "setup"'),
    ];
    const matches = resolveRouting(intents, rules, {});
    expect(matches[0].target).toBe('Device_Agent');
  });

  it('TC-RR-05 AND condition with missing non-intent var — null injection, condition fails', () => {
    const intents = [makeIntent('billing')];
    const rules = [
      makeRule('Premium_Agent', 'intent.category == "billing" && user.tier == "premium"'),
    ];
    const matches = resolveRouting(intents, rules, {});
    expect(matches[0].target).toBeNull();
  });

  it('TC-RR-06 AND condition with non-intent var present — evaluates fully', () => {
    const intents = [makeIntent('billing')];
    const rules = [
      makeRule('Premium_Agent', 'intent.category == "billing" && user.tier == "premium"'),
    ];
    const sessionValues = { user: { tier: 'premium' } };
    const matches = resolveRouting(intents, rules, sessionValues);
    expect(matches[0].target).toBe('Premium_Agent');
  });

  it('TC-RR-07 same category routes to different targets based on session state', () => {
    const intents = [makeIntent('billing')];
    const rules = [
      makeRule('Premium_Agent', 'intent.category == "billing" && user.tier == "premium"', 1),
      makeRule('Standard_Agent', 'intent.category == "billing" && user.tier == "standard"', 2),
    ];
    const sessionValues = { user: { tier: 'standard' } };
    const matches = resolveRouting(intents, rules, sessionValues);
    expect(matches[0].target).toBe('Standard_Agent');
  });

  it('TC-RR-08 multi-intent — each intent evaluated independently', () => {
    const intents = [makeIntent('billing', 0.9), makeIntent('setup', 0.85)];
    const rules = [
      makeRule('Billing_Agent', 'intent.category == "billing"'),
      makeRule('Setup_Agent', 'intent.category == "setup"'),
    ];
    const matches = resolveRouting(intents, rules, {});
    expect(matches).toHaveLength(2);
    expect(matches[0].target).toBe('Billing_Agent');
    expect(matches[1].target).toBe('Setup_Agent');
  });

  it('TC-RR-09 null category intent — no routing match', () => {
    const intents = [makeIntent(null)];
    const rules = [makeRule('Agent_A', 'intent.category == "billing"')];
    const matches = resolveRouting(intents, rules, {});
    expect(matches[0].target).toBeNull();
  });

  it('TC-RR-10 fallback rule with when: "true" matches when nothing else does', () => {
    const intents = [makeIntent('unknown_category')];
    const rules = [
      makeRule('Specific_Agent', 'intent.category == "billing"', 1),
      makeRule('Fallback_Agent', 'true', 99),
    ];
    const matches = resolveRouting(intents, rules, {});
    expect(matches[0].target).toBe('Fallback_Agent');
  });

  it('TC-RR-11 empty rules array — all intents get null target', () => {
    const intents = [makeIntent('billing')];
    const matches = resolveRouting(intents, [], {});
    expect(matches).toHaveLength(1);
    expect(matches[0].target).toBeNull();
  });

  it('TC-RR-12 trace events emitted', () => {
    const intents = [makeIntent('billing')];
    const rules = [makeRule('Billing_Agent', 'intent.category == "billing"')];
    const traceEvents: Array<{ type: string; data: Record<string, unknown> }> = [];
    resolveRouting(intents, rules, {}, (e) => traceEvents.push(e));
    expect(traceEvents.length).toBeGreaterThan(0);
    expect(traceEvents.some((e) => e.type === 'pipeline_routing_resolve')).toBe(true);
  });

  it('TC-RR-13 relational comparison with missing variable does NOT match (null < 80 guard)', () => {
    const intents = [makeIntent('network_issue')];
    const rules = [
      makeRule('Network_Agent', 'intent.category == "network_issue" && battery_health_pct < 80'),
    ];
    // battery_health_pct is NOT in session values -- should NOT match
    const matches = resolveRouting(intents, rules, {});
    expect(matches[0].target).toBeNull();
  });

  it('TC-RR-14 relational comparison with present variable still matches correctly', () => {
    const intents = [makeIntent('network_issue')];
    const rules = [
      makeRule('Network_Agent', 'intent.category == "network_issue" && battery_health_pct < 80'),
    ];
    const sessionValues = { battery_health_pct: 45 };
    const matches = resolveRouting(intents, rules, sessionValues);
    expect(matches[0].target).toBe('Network_Agent');
  });

  it('TC-RR-15 relational comparison with value above threshold does not match', () => {
    const intents = [makeIntent('network_issue')];
    const rules = [
      makeRule('Network_Agent', 'intent.category == "network_issue" && battery_health_pct < 80'),
    ];
    const sessionValues = { battery_health_pct: 95 };
    const matches = resolveRouting(intents, rules, sessionValues);
    expect(matches[0].target).toBeNull();
  });
});
