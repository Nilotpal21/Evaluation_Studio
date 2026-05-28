import { describe, expect, it } from 'vitest';
import { collectGeneratedAgentReadinessErrors } from '@/lib/arch-ai/build-readiness-gates';

describe('build-readiness-gates', () => {
  it('allows ON_START when the agent still has executable first-request routing', () => {
    const errors = collectGeneratedAgentReadinessErrors({
      content: `SUPERVISOR: Alex
GOAL: "Route support requests"
PERSONA: "Helpful support supervisor"

ON_START:
  RESPOND: "Hi, how can I help?"

HANDOFF:
  - TO: PolicyAdvisor
    WHEN: intent.category == "policy"
    RETURN: true
  - TO: HumanEscalation
    WHEN: true
    RETURN: false
`,
    });

    expect(errors).toEqual([]);
  });

  it('allows supervisors to use a local fallback response instead of a catch-all handoff', () => {
    const errors = collectGeneratedAgentReadinessErrors({
      content: `SUPERVISOR: Alex
GOAL: "Route support requests"
PERSONA: "Helpful support supervisor"

HANDOFF:
  - TO: PolicyAdvisor
    WHEN: intent.category == "policy"
    RETURN: true

COMPLETE:
  - WHEN: true
    RESPOND: "I need one more detail before I route this. Is this about an order policy, fulfillment, or escalation?"
`,
    });

    expect(errors).toEqual([]);
  });

  it('allows finite supervisor routes without promoting missing catch-all warnings to hard blockers', () => {
    const errors = collectGeneratedAgentReadinessErrors({
      content: `SUPERVISOR: TravelDesk
GOAL: "Route travel requests"
PERSONA: "Travel routing supervisor"

HANDOFF:
  - TO: BookingManager
    WHEN: intent.category == "booking"
    RETURN: true
  - TO: RefundProcessor
    WHEN: intent.category == "refund"
    RETURN: true
`,
    });

    expect(errors).toEqual([]);
  });

  it('allows routing intent presence guards with intent-category routing', () => {
    const errors = collectGeneratedAgentReadinessErrors({
      content: `SUPERVISOR: Alex
GOAL: "Route support requests"
PERSONA: "Helpful support supervisor"

HANDOFF:
  - TO: PolicyAdvisor
    WHEN: routing_intent != null AND (intent.category == "policy")
    RETURN: true
`,
    });

    expect(errors).toEqual([]);
  });

  it('blocks using routing intent as a second classifier with intent-category routing', () => {
    const errors = collectGeneratedAgentReadinessErrors({
      content: `SUPERVISOR: Alex
GOAL: "Route support requests"
PERSONA: "Helpful support supervisor"

HANDOFF:
  - TO: PolicyAdvisor
    WHEN: routing_intent == "policy" AND (intent.category == "policy")
    RETURN: true
`,
    });

    expect(errors).toEqual([expect.stringContaining('uses routing_intent as a classifier value')]);
  });

  it('allows state-driven silent completion for return-to-parent agents', () => {
    const errors = collectGeneratedAgentReadinessErrors({
      content: `AGENT: PolicyAdvisor
GOAL: "Compute policy eligibility and return structured state"
PERSONA: "Internal policy specialist"

GATHER:
  eligible_options:
    type: list
    required: true
    prompt: "Which policy options are eligible?"
  recommendation:
    type: string
    required: true
    prompt: "What option should Alex recommend?"

COMPLETE:
  - WHEN: eligible_options != null AND recommendation != null
    RESPOND: ""
`,
    });

    expect(errors).toEqual([]);
  });

  it('allows silent completion after flow produced structured return state', () => {
    const errors = collectGeneratedAgentReadinessErrors({
      content: `AGENT: PolicyAdvisor
GOAL: "Compute policy eligibility and return structured state"
PERSONA: "Internal policy specialist"

FLOW:
  steps:
    - compute_policy
  compute_policy:
    REASONING: false
    SET:
      eligible_options: ["refund", "replacement"]
      recommendation: "replacement"
    THEN: COMPLETE

COMPLETE:
  - WHEN: true
    RESPOND: ""
`,
    });

    expect(errors).toEqual([]);
  });

  it('allows silent completion after flow gathers return state', () => {
    const errors = collectGeneratedAgentReadinessErrors({
      content: `AGENT: PolicyAdvisor
GOAL: "Collect policy details and return them"
PERSONA: "Internal policy specialist"

FLOW:
  steps:
    - collect_policy_context
  collect_policy_context:
    REASONING: true
    GATHER:
      - order_status: required
      - issue_type: required
    THEN: COMPLETE

COMPLETE:
  - WHEN: true
    RESPOND: ""
`,
    });

    expect(errors).toEqual([]);
  });

  it('allows silent completion after the agent already answered in flow', () => {
    const errors = collectGeneratedAgentReadinessErrors({
      content: `AGENT: FulfillmentSpecialist
GOAL: "Execute fulfillment actions"
PERSONA: "Customer-facing fulfillment specialist"

FLOW:
  steps:
    - confirm_result
  confirm_result:
    RESPOND: "Your replacement has been created and will arrive tomorrow."
    THEN: COMPLETE

COMPLETE:
  - WHEN: true
    RESPOND: ""
`,
    });

    expect(errors).toEqual([]);
  });

  it('blocks reasoning-only unconditional silent completion with no output evidence', () => {
    const errors = collectGeneratedAgentReadinessErrors({
      content: `AGENT: PolicyAdvisor
GOAL: "Classify policy eligibility"
PERSONA: "Internal policy specialist"

FLOW:
  steps:
    - reason_about_policy
  reason_about_policy:
    REASONING: true
    THEN: COMPLETE

COMPLETE:
  - WHEN: true
    RESPOND: ""
`,
    });

    expect(errors).toEqual([expect.stringContaining('unconditional silent COMPLETE')]);
  });

  it('blocks unconditional silent completion when the agent never answered elsewhere', () => {
    const errors = collectGeneratedAgentReadinessErrors({
      content: `AGENT: PolicyAdvisor
GOAL: "Classify policy eligibility"
PERSONA: "Internal policy specialist"

COMPLETE:
  - WHEN: true
    RESPOND: ""
`,
    });

    expect(errors).toEqual([expect.stringContaining('unconditional silent COMPLETE')]);
  });
});
