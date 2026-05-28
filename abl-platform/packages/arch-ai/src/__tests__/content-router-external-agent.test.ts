/**
 * Content-router external-agent routing tests — Spec 1 Phase 4.8.
 *
 * Each of the 5 trigger phrases added in Phase 4.1 must route to the
 * `integration-methodologist` specialist with a non-null `matchedPattern`
 * captured for trace emission. Default fallthrough returns
 * `matchedPattern: null`.
 *
 * Trace span event emission (`routing_decision` on the turn span) is tested
 * separately at the engine layer — this file pins only the router contract.
 */

import { describe, expect, it } from 'vitest';

import { routeByContent } from '../coordinator/content-router.js';

describe('content-router — external-agent intent (Phase 4.8)', () => {
  const cases: Array<[string, string]> = [
    // 1. external|remote|partner|third.party agent
    ['I need to wire up an external agent for billing escalation', 'external'],
    ['register a remote agent for our partner', 'remote'],
    ['set up a partner agent', 'partner'],
    ['third-party agent integration', 'third.party'],

    // 2. connect to|with X agent
    ['connect to our salesforce agent', 'connect'],
    ['can you connect with the partner agent?', 'connect'],

    // 3. a2a handoff|integration|connection|endpoint
    // NOTE: phrases that also contain "debug", "failing", "broken" etc. would
    // route to diagnostician (those rules sit earlier in ROUTE_RULES). The
    // a2a-prefixed routing is verified with neutral verbs.
    ['help me set up an a2a handoff', 'a2a'],
    ['document the a2a integration approach', 'a2a'],
    ['walk me through the a2a connection flow', 'a2a'],

    // 4. register an external|remote agent
    ['register an external agent in the project', 'register'],
    ['register the remote agent', 'register'],

    // 5. agent card / agent-card
    ['fetch the agent card from /.well-known', 'agent.card'],
    ['preview the agent-card before registering', 'agent.card'],
  ];

  for (const [input, label] of cases) {
    it(`routes "${input}" (${label}) to integration-methodologist with matchedPattern`, () => {
      const decision = routeByContent(input);
      expect(decision.specialist).toBe('integration-methodologist');
      expect(decision.matchedPattern).toBeTruthy();
      expect(typeof decision.matchedPattern).toBe('string');
    });
  }

  it('default fallthrough returns matchedPattern: null when no rule matches', () => {
    // A bland, non-routable phrase that misses every rule AND the diagnostic fallback.
    const decision = routeByContent('hello there');
    expect(decision.specialist).toBe('abl-construct-expert');
    expect(decision.matchedPattern).toBeNull();
  });

  it('diagnostic fallback fires for "broken" but still records its source pattern', () => {
    const decision = routeByContent('something is broken');
    // "broken" matches the integration-methodologist's broad rules first?
    // No — there's no integration rule for "broken". This should hit either
    // the diagnostician keyword rule or the diagnostic fallback. Either way,
    // a non-null matchedPattern is captured.
    expect(decision.specialist).toBe('diagnostician');
    expect(decision.matchedPattern).toBeTruthy();
  });
});
