import { describe, expect, it } from 'vitest';

import { validateGeneratedBuildSession } from '@/lib/arch-ai/build-orchestrator';

describe('Arch BUILD pre-export validation', () => {
  it('compiles source-specific behavior profile references when profile files are supplied', async () => {
    const result = await validateGeneratedBuildSession({
      topology: {
        agents: [
          {
            name: 'Alex',
            role: 'support supervisor',
            executionMode: 'hybrid',
          },
        ],
        edges: [],
      },
      agentFiles: {
        Alex: {
          content: `SUPERVISOR: Alex
GOAL: "Help customers"
PERSONA: |
  VoltMart support voice.

USE BEHAVIOR_PROFILE: voltmart_voice

GUARDRAILS:
  content_safety:
    enabled: true
`,
        },
      },
      behaviorProfileFiles: {
        voltmart_voice: {
          content: `BEHAVIOR_PROFILE: voltmart_voice
PRIORITY: 20
WHEN: channel.name == "voice"

INSTRUCTIONS: |
  Keep responses short and natural for voice.
`,
        },
      },
    });

    const alex = result.results.find((entry) => entry.agentName === 'Alex');
    expect(alex?.errors.join('\n')).not.toContain('PROFILE_NOT_FOUND');
    expect(alex?.status).not.toBe('error');
  });

  it('blocks silent delegates that gather from customers and scripted decision flows', async () => {
    const result = await validateGeneratedBuildSession({
      topology: {
        agents: [
          {
            name: 'Alex',
            role: 'support supervisor',
            executionMode: 'hybrid',
          },
          {
            name: 'PolicyAdvisor',
            role: 'internal policy advisor',
            executionMode: 'reasoning',
          },
        ],
        edges: [
          {
            from: 'Alex',
            to: 'PolicyAdvisor',
            type: 'delegate',
            experienceMode: 'silent_delegate',
          },
        ],
      },
      agentFiles: {
        Alex: {
          content: `SUPERVISOR: Alex
GOAL: "Route customer requests"
PERSONA: |
  Customer-facing support supervisor.

HANDOFF:
  - TO: PolicyAdvisor
    WHEN: true
    EXPERIENCE_MODE: silent_delegate
    RETURN: true
`,
        },
        PolicyAdvisor: {
          content: `AGENT: PolicyAdvisor
GOAL: "Advise on policy eligibility"
PERSONA: |
  Internal policy advisor.

TOOLS:
  search_policies(query: string) -> { summary: string }
    description: "Search policies."
    side_effects: false
    confirm: never

GATHER:
  order_number:
    type: string
    required: true
    prompt: "What is your order number?"

FLOW:
  steps:
    - call_search_policies
    - finalize
  call_search_policies:
    REASONING: false
    CALL: search_policies
      WITH:
        query: order_number
      AS: searchPoliciesResult
    ON_SUCCESS:
      THEN: finalize
  finalize:
    REASONING: false
    THEN: COMPLETE

COMPLETE:
  - WHEN: order_number != null
    RESPOND: ""
`,
        },
      },
    });

    const alex = result.results.find((entry) => entry.agentName === 'Alex');
    const policyAdvisor = result.results.find((entry) => entry.agentName === 'PolicyAdvisor');

    expect(alex?.status).toBe('error');
    expect(alex?.errors.join('\n')).toContain('catch-all HANDOFF WHEN true');
    expect(policyAdvisor?.status).toBe('error');
    expect(policyAdvisor?.errors.join('\n')).toContain(
      'silent_delegate agents must not emit customer-facing GATHER',
    );
    expect(policyAdvisor?.errors.join('\n')).toContain(
      'decision/reasoning agents with FLOW must include a REASONING: true step',
    );
  });

  it('blocks deterministic flows that chain side-effecting tools', async () => {
    const result = await validateGeneratedBuildSession({
      topology: {
        agents: [
          {
            name: 'FulfillmentSpecialist',
            role: 'fulfillment specialist',
            executionMode: 'hybrid',
          },
        ],
        edges: [],
      },
      agentFiles: {
        FulfillmentSpecialist: {
          content: `AGENT: FulfillmentSpecialist
GOAL: "Execute fulfillment actions"
PERSONA: |
  Internal fulfillment specialist.

TOOLS:
  create_replacement(order_id: string) -> { success: boolean }
    description: "Create replacement."
    side_effects: true
    confirm: never
  issue_refund(order_id: string) -> { success: boolean }
    description: "Issue refund."
    side_effects: true
    confirm: never

FLOW:
  steps:
    - call_create_replacement
    - call_issue_refund
    - finalize
  call_create_replacement:
    REASONING: false
    CALL: create_replacement
      WITH:
        order_id: order_id
      AS: createReplacementResult
    ON_SUCCESS:
      THEN: call_issue_refund
  call_issue_refund:
    REASONING: false
    CALL: issue_refund
      WITH:
        order_id: order_id
      AS: issueRefundResult
    ON_SUCCESS:
      THEN: finalize
  finalize:
    REASONING: false
    THEN: COMPLETE

COMPLETE:
  - WHEN: true
    RESPOND: ""
`,
        },
      },
    });

    const fulfillment = result.results.find((entry) => entry.agentName === 'FulfillmentSpecialist');

    expect(fulfillment?.status).toBe('error');
    expect(fulfillment?.errors.join('\n')).toContain(
      'FLOW sequentially calls multiple side-effect tools',
    );
  });

  it('blocks projects that compile but would fail runtime routing/readiness', async () => {
    const result = await validateGeneratedBuildSession({
      topology: {
        agents: [
          {
            name: 'AlexSupportSupervisor',
            role: 'support supervisor',
            executionMode: 'hybrid',
          },
          {
            name: 'PolicyAdvisor',
            role: 'policy advisor',
            executionMode: 'reasoning',
          },
        ],
        edges: [
          {
            from: 'AlexSupportSupervisor',
            to: 'PolicyAdvisor',
            type: 'delegate',
            experienceMode: 'silent_delegate',
          },
        ],
      },
      agentFiles: {
        AlexSupportSupervisor: {
          content: `SUPERVISOR: AlexSupportSupervisor
GOAL: "Route customer support requests"
PERSONA: |
  Customer-facing support supervisor.

ON_START:
  RESPOND: "Hi, how can I help?"

HANDOFF:
  - TO: PolicyAdvisor
    WHEN: routing_intent == "policy_eligibility_review" AND (intent.category == "policy_eligibility_review")
    RETURN: true

GATHER:
  routing_intent:
    type: string
    required: true
    prompt: "What do you need help with?"

GUARDRAILS:
  content_safety:
    kind: input
    tier: 1
    check: "Block harmful content"
    action: block
    threshold: 0.8
`,
        },
        PolicyAdvisor: {
          content: `AGENT: PolicyAdvisor
GOAL: "Classify policy eligibility"
PERSONA: |
  Internal policy specialist.

FLOW:
  steps:
    - reason_with_tools
  reason_with_tools:
    REASONING: true
    THEN: COMPLETE

COMPLETE:
  - WHEN: true
    RESPOND: ""

GUARDRAILS:
  content_safety:
    kind: input
    tier: 1
    check: "Block harmful content"
    action: block
    threshold: 0.8
`,
        },
      },
    });

    const supervisor = result.results.find((entry) => entry.agentName === 'AlexSupportSupervisor');
    const policyAdvisor = result.results.find((entry) => entry.agentName === 'PolicyAdvisor');

    expect(supervisor?.status).toBe('error');
    expect(supervisor?.errors.join('\n')).toContain('uses routing_intent as a classifier value');
    expect(policyAdvisor?.status).toBe('error');
    expect(policyAdvisor?.errors.join('\n')).toContain('unconditional silent COMPLETE');
  });
});
