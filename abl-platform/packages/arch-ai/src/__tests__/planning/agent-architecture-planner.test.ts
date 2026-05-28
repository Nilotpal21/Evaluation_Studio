import { describe, expect, it } from 'vitest';

import { computeArchitecturePlans } from '../../planning/agent-architecture-planner.js';

describe('computeArchitecturePlans', () => {
  it('keeps simple entry responders on reasoning complexity', () => {
    const result = computeArchitecturePlans({
      agents: [
        {
          name: 'BakeryFAQAgent',
          role: 'FAQ responder',
          executionMode: 'hybrid',
          description: 'Answers common bakery questions and captures basic interest.',
          gatherFields: ['customer_question'],
        },
      ],
      edges: [],
      entryPoint: 'BakeryFAQAgent',
    });

    const plan = result.plans.get('BakeryFAQAgent');

    expect(plan?.complexity.selectedExecutionMode).toBe('reasoning');
    expect(plan?.complexity.level).toBe('simple');
    expect(plan?.complexity.signals).toContain('single_agent');
    expect(plan?.flow.recommended).toBe(false);
    expect(plan?.complete.required).toBe(true);
    expect(plan?.complete.reason).toContain('conversations do not run indefinitely');
  });

  it('leans into hybrid flow for complex ordered scenarios', () => {
    const result = computeArchitecturePlans({
      agents: [
        {
          name: 'LoanOnboardingAgent',
          role: 'multi-step onboarding and identity verification specialist',
          executionMode: 'reasoning',
          description:
            'Collects application data, verifies identity, calls eligibility tools, branches on approval, and escalates complex exceptions.',
          tools: ['verify_identity', 'check_eligibility'],
          gatherFields: ['full_name', 'date_of_birth', 'loan_amount', 'income', 'approval_choice'],
        },
      ],
      edges: [],
      entryPoint: 'LoanOnboardingAgent',
    });

    const plan = result.plans.get('LoanOnboardingAgent');

    expect(plan?.complexity.selectedExecutionMode).toBe('hybrid');
    expect(plan?.complexity.level).toBe('complex');
    expect(plan?.complexity.signals).toEqual(
      expect.arrayContaining(['many_gather_fields', 'tool_backed', 'ordered_business_process']),
    );
    expect(plan?.flow.recommended).toBe(true);
  });

  it('keeps an entry responder with only escalation edges out of supervisor scaffolding', () => {
    const result = computeArchitecturePlans({
      agents: [
        {
          name: 'BakeryFAQAgent',
          role: 'FAQ responder and lead capture',
          executionMode: 'hybrid',
          gatherFields: ['lead_name', 'lead_phone'],
        },
        {
          name: 'HumanHandoff',
          role: 'Human escalation target',
          executionMode: 'scripted',
          gatherFields: [],
        },
      ],
      edges: [
        {
          from: 'BakeryFAQAgent',
          to: 'HumanHandoff',
          type: 'escalate',
          expectReturn: false,
          condition: 'needs human help',
        },
      ],
      entryPoint: 'BakeryFAQAgent',
    });

    const bakeryPlan = result.plans.get('BakeryFAQAgent');

    expect(bakeryPlan?.archetype).toBe('specialist');
    expect(bakeryPlan?.keyword).toBe('AGENT');
    expect(bakeryPlan?.handoffs.needsCatchAll).toBe(false);
    expect(bakeryPlan?.handoffs.catchAllTarget).toBeUndefined();

    const humanPlan = result.plans.get('HumanHandoff');
    expect(humanPlan?.complete.required).toBe(true);
    expect(humanPlan?.complete.reason).toContain('conversations do not run indefinitely');
  });

  it('derives child return-field seeds from target gather fields for returnable handoffs', () => {
    const result = computeArchitecturePlans({
      agents: [
        {
          name: 'Triage',
          role: 'supervisor',
          executionMode: 'reasoning',
          gatherFields: [],
        },
        {
          name: 'BillingResolutionAgent',
          role: 'billing specialist',
          executionMode: 'reasoning',
          gatherFields: ['invoice_id', 'resolution_confirmed'],
        },
      ],
      edges: [
        {
          from: 'Triage',
          to: 'BillingResolutionAgent',
          type: 'transfer',
          experienceMode: 'shared_voice_handoff',
          expectReturn: true,
          condition: 'billing issue',
        },
      ],
      entryPoint: 'Triage',
    });

    const triagePlan = result.plans.get('Triage');

    expect(triagePlan?.handoffs.targets).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          to: 'BillingResolutionAgent',
          experienceMode: 'shared_voice_handoff',
          returnExpected: true,
          returnFieldSeeds: ['invoice_id', 'resolution_confirmed'],
        }),
      ]),
    );
    expect(triagePlan?.localTopology.edges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          to: 'BillingResolutionAgent',
          experienceMode: 'shared_voice_handoff',
        }),
      ]),
    );
  });

  it('routes supervisor catch-alls to customer-facing transfer handoffs', () => {
    const result = computeArchitecturePlans({
      agents: [
        {
          name: 'Triage',
          role: 'customer-facing supervisor',
          executionMode: 'hybrid',
        },
        {
          name: 'BillingResolutionAgent',
          role: 'billing specialist',
          executionMode: 'reasoning',
        },
      ],
      edges: [
        {
          from: 'Triage',
          to: 'BillingResolutionAgent',
          type: 'transfer',
          experienceMode: 'shared_voice_handoff',
          expectReturn: true,
          condition: 'billing issue',
        },
      ],
      entryPoint: 'Triage',
    });

    const triagePlan = result.plans.get('Triage');

    expect(triagePlan?.archetype).toBe('supervisor');
    expect(triagePlan?.handoffs.needsCatchAll).toBe(true);
    expect(triagePlan?.handoffs.catchAllTarget).toBe('BillingResolutionAgent');
  });

  it('does not treat delegate edges with customer-facing experience hints as catch-all compatible', () => {
    const result = computeArchitecturePlans({
      agents: [
        {
          name: 'Triage',
          role: 'customer-facing supervisor',
          executionMode: 'hybrid',
        },
        {
          name: 'BillingResolutionAgent',
          role: 'billing specialist',
          executionMode: 'reasoning',
        },
      ],
      edges: [
        {
          from: 'Triage',
          to: 'BillingResolutionAgent',
          type: 'delegate',
          experienceMode: 'shared_voice_handoff',
          expectReturn: true,
          condition: 'billing issue',
        },
      ],
      entryPoint: 'Triage',
    });

    const triagePlan = result.plans.get('Triage');

    expect(triagePlan?.archetype).toBe('supervisor');
    expect(triagePlan?.handoffs.needsCatchAll).toBe(false);
    expect(triagePlan?.handoffs.catchAllTarget).toBeUndefined();
  });

  it('does not route supervisor catch-alls to silent delegate targets', () => {
    const result = computeArchitecturePlans({
      agents: [
        {
          name: 'Alex',
          role: 'customer-facing support supervisor',
          executionMode: 'hybrid',
        },
        {
          name: 'PolicyAdvisor',
          role: 'internal policy advisor',
          executionMode: 'reasoning',
          tools: ['search_policies'],
        },
        {
          name: 'FulfillmentSpecialist',
          role: 'internal fulfillment specialist',
          executionMode: 'reasoning',
          tools: ['create_replacement', 'issue_refund'],
        },
        {
          name: 'HumanEscalation',
          role: 'human escalation representative',
          executionMode: 'hybrid',
        },
      ],
      edges: [
        {
          from: 'Alex',
          to: 'PolicyAdvisor',
          type: 'delegate',
          experienceMode: 'silent_delegate',
          expectReturn: true,
          condition: 'policy_needed == true',
        },
        {
          from: 'Alex',
          to: 'FulfillmentSpecialist',
          type: 'delegate',
          experienceMode: 'silent_delegate',
          expectReturn: true,
          condition: 'fulfillment_action_confirmed == true',
        },
        {
          from: 'Alex',
          to: 'HumanEscalation',
          type: 'escalate',
          experienceMode: 'human_escalation',
          expectReturn: false,
          condition: 'user_requests_human == true',
        },
      ],
      entryPoint: 'Alex',
    });

    const alexPlan = result.plans.get('Alex');

    expect(alexPlan?.archetype).toBe('supervisor');
    expect(alexPlan?.handoffs.needsCatchAll).toBe(false);
    expect(alexPlan?.handoffs.catchAllTarget).toBeUndefined();
  });

  it('keeps non-entry triage agents with outgoing delegates as pipeline stages', () => {
    const result = computeArchitecturePlans({
      agents: [
        {
          name: 'CareTriageRouter',
          role: 'entry intake router',
          executionMode: 'hybrid',
          gatherFields: [],
        },
        {
          name: 'ProtocolTriageAgent',
          role: 'clinical protocol triage specialist',
          executionMode: 'hybrid',
          gatherFields: ['symptoms', 'consent_confirmed'],
        },
        {
          name: 'AppointmentBookingAgent',
          role: 'appointment booking specialist',
          executionMode: 'scripted',
          gatherFields: ['appointment_date'],
        },
        {
          name: 'HumanEscalationAgent',
          role: 'human escalation specialist',
          executionMode: 'scripted',
          gatherFields: ['case_summary'],
        },
      ],
      edges: [
        {
          from: 'CareTriageRouter',
          to: 'ProtocolTriageAgent',
          type: 'delegate',
          expectReturn: true,
        },
        {
          from: 'ProtocolTriageAgent',
          to: 'AppointmentBookingAgent',
          type: 'delegate',
          expectReturn: true,
        },
        {
          from: 'ProtocolTriageAgent',
          to: 'HumanEscalationAgent',
          type: 'escalate',
          expectReturn: false,
        },
      ],
      entryPoint: 'CareTriageRouter',
    });

    const protocolPlan = result.plans.get('ProtocolTriageAgent');

    expect(protocolPlan?.archetype).toBe('pipeline_stage');
    expect(protocolPlan?.keyword).toBe('AGENT');
  });

  it('keeps returnable child agents with outgoing escalation as pipeline stages', () => {
    const result = computeArchitecturePlans({
      agents: [
        {
          name: 'VoiceDisputeRouter',
          role: 'voice dispute router',
          executionMode: 'hybrid',
          gatherFields: [],
        },
        {
          name: 'BillingDisputeResolution',
          role: 'billing dispute resolution specialist',
          executionMode: 'hybrid',
          gatherFields: ['customer_account_id', 'disputed_amount'],
        },
        {
          name: 'SupervisorCallbackEscalation',
          role: 'supervisor callback escalation',
          executionMode: 'scripted',
          gatherFields: ['callback_phone'],
        },
      ],
      edges: [
        {
          from: 'VoiceDisputeRouter',
          to: 'BillingDisputeResolution',
          type: 'delegate',
          expectReturn: true,
        },
        {
          from: 'BillingDisputeResolution',
          to: 'SupervisorCallbackEscalation',
          type: 'escalate',
          expectReturn: false,
        },
      ],
      entryPoint: 'VoiceDisputeRouter',
    });

    const billingPlan = result.plans.get('BillingDisputeResolution');

    expect(billingPlan?.archetype).toBe('pipeline_stage');
    expect(billingPlan?.keyword).toBe('AGENT');
    expect(billingPlan?.handoffs.targets).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          to: 'SupervisorCallbackEscalation',
          edgeType: 'escalate',
          returnExpected: false,
        }),
      ]),
    );
  });

  it('derives runtime-aligned history hints from target execution mode', () => {
    const result = computeArchitecturePlans({
      agents: [
        {
          name: 'Triage',
          role: 'supervisor',
          executionMode: 'reasoning',
          gatherFields: [],
        },
        {
          name: 'BillingResolutionAgent',
          role: 'billing specialist',
          executionMode: 'reasoning',
          gatherFields: ['invoice_id'],
        },
        {
          name: 'ScriptedLookupAgent',
          role: 'lookup specialist',
          executionMode: 'scripted',
          gatherFields: ['lookup_topic'],
        },
      ],
      edges: [
        {
          from: 'Triage',
          to: 'BillingResolutionAgent',
          type: 'delegate',
          expectReturn: true,
        },
        {
          from: 'Triage',
          to: 'ScriptedLookupAgent',
          type: 'delegate',
          expectReturn: true,
        },
      ],
      entryPoint: 'Triage',
    });

    const triagePlan = result.plans.get('Triage');
    const reasoningTarget = triagePlan?.handoffs.targets.find(
      (target) => target.to === 'BillingResolutionAgent',
    );
    const scriptedTarget = triagePlan?.handoffs.targets.find(
      (target) => target.to === 'ScriptedLookupAgent',
    );

    expect(reasoningTarget?.historyHint).toEqual(
      expect.objectContaining({
        suggestedHistory: 'auto',
        autoSummaryEligible: true,
        summaryRecommended: true,
        summaryFocusFields: [],
      }),
    );
    expect(reasoningTarget?.historyHint?.reason).toContain('resolve it to summary_only');
    expect(reasoningTarget?.historyHint?.summaryTemplateSeed).toContain(
      "Summarize the user's request",
    );
    expect(reasoningTarget?.returnContractHint?.reason).toContain(
      'default return already merges BillingResolutionAgent',
    );

    expect(scriptedTarget?.historyHint).toEqual(
      expect.objectContaining({
        suggestedHistory: 'auto',
        autoSummaryEligible: false,
        summaryRecommended: true,
      }),
    );
    expect(scriptedTarget?.historyHint?.reason).toContain('falls back to bounded raw history');
    expect(scriptedTarget?.returnContractHint?.reason).toContain(
      'default return already merges ScriptedLookupAgent',
    );
  });
});
