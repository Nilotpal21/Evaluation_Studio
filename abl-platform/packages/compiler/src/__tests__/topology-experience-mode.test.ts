import { describe, expect, it } from 'vitest';
import { parseAgentBasedABL } from '@abl/core';
import { compileABLtoIR } from '../platform/ir/compiler.js';
import { extractAppStaticGraph } from '../platform/ir/app-graph-extractor.js';

function parseDsl(dsl: string) {
  const result = parseAgentBasedABL(dsl);
  expect(result.errors).toHaveLength(0);
  expect(result.document).toBeDefined();
  return result.document!;
}

describe('topology experience mode propagation', () => {
  it('preserves handoff and delegate experience modes through parser, IR, and app graph', () => {
    const supervisor = parseDsl(`
SUPERVISOR: Alex
GOAL: "Route customer requests"
PERSONA: "Customer-facing support assistant"

HANDOFF:
  - TO: Orders
    WHEN: routing_intent == "orders"
    EXPERIENCE_MODE: shared_voice_handoff
    CONTEXT:
      pass: [order_id]
      summary: "Customer needs order help"
    EXPECT_RETURN: false

DELEGATE:
  - AGENT: PolicyAdvisor
    WHEN: needs_policy == true
    EXPERIENCE_MODE: silent_delegate
    PURPOSE: "Check policy eligibility"
    INPUT: { order_id: order_id }
    RETURNS: { eligible: policy_eligible }
    USE_RESULT: policy_eligible
`);

    const orders = parseDsl(`
AGENT: Orders
GOAL: "Resolve order issues"
PERSONA: "Customer-facing order specialist"
`);

    const policy = parseDsl(`
AGENT: PolicyAdvisor
GOAL: "Advise on policy"
PERSONA: "Internal policy specialist"
`);

    const output = compileABLtoIR([supervisor, orders, policy]);
    const alex = output.agents.Alex;

    expect(alex.coordination.handoffs[0].experienceMode).toBe('shared_voice_handoff');
    expect(alex.coordination.delegates[0].experienceMode).toBe('silent_delegate');

    const appGraph = extractAppStaticGraph(output, 'support');
    expect(appGraph.app.connections).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          from: 'Alex',
          to: 'Orders',
          type: 'handoff',
          returns: false,
          experienceMode: 'shared_voice_handoff',
        }),
        expect.objectContaining({
          from: 'Alex',
          to: 'PolicyAdvisor',
          type: 'delegate',
          returns: true,
          experienceMode: 'silent_delegate',
        }),
      ]),
    );
  });
});
