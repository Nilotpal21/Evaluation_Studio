import { describe, expect, it } from 'vitest';

import { buildSkeleton, processGeneratedABL } from '../../generation/abl-pipeline.js';
import { renderDefaultContentSafetyGuardrail } from '../../knowledge/guardrail-contract.js';
import { DEFAULT_ARCH_MODEL_POLICY_DEFAULTS } from '../../model-policy.js';

const DEFAULT_CONTENT_SAFETY_GUARDRAIL = renderDefaultContentSafetyGuardrail();
const CANNED_CUSTOMER_PHRASES = [
  'I can help with that.',
  'Let me check on that.',
  'Done.',
  'What information should I use to continue?',
];
const INTERNAL_CUSTOMER_FACING_TERMS =
  /\b(tool|workflow|step|routing|classify|escalate|specialist|context|retry)\b/i;

function extractCustomerFacingPromptAndResponseText(yaml: string): string[] {
  return Array.from(yaml.matchAll(/^\s*(?:prompt|RESPOND):\s*(["'])(.*?)\1\s*$/gm), (match) =>
    match[2].trim(),
  );
}

describe('abl-pipeline skeletons', () => {
  it('gives delegate specialists a compiler-safe gather and completion path', () => {
    const yaml = buildSkeleton({
      name: 'BillingResolutionAgent',
      type: 'specialist',
      role: 'specialist',
      handoffSources: ['TriageAgent'],
    });

    expect(yaml).toContain('GATHER:\n  gathered_detail:');
    expect(yaml).toContain('WHEN: gathered_detail != null');
    expect(yaml).toContain('RESPOND: ""');
    expect(yaml).not.toContain('GATHER:\n  fields:');
    expect(yaml).not.toContain('{{completion_condition_based_on_gathered_data}}');
    expect(yaml).not.toContain('{{reason_for_completion}}');
    expect(yaml).not.toContain('REASON:');
  });

  it('keeps scripted and hybrid skeleton responses free of canned filler', () => {
    const scriptedYaml = buildSkeleton({
      name: 'OnboardingFlowAgent',
      type: 'scripted',
      role: 'onboarding',
    });
    const hybridYaml = buildSkeleton({
      name: 'OrderResolutionAgent',
      type: 'hybrid',
      role: 'orders',
    });

    for (const yaml of [scriptedYaml, hybridYaml]) {
      const customerFacingText = extractCustomerFacingPromptAndResponseText(yaml);
      expect(customerFacingText).toContain('');
      for (const phrase of CANNED_CUSTOMER_PHRASES) {
        expect(customerFacingText).not.toContain(phrase);
      }
    }
  });

  it('does not put internal vocabulary in customer-facing skeleton prompts or responses', () => {
    const skeletons = [
      buildSkeleton({
        name: 'BillingResolutionAgent',
        type: 'specialist',
        role: 'billing',
        handoffSources: ['TriageAgent'],
      }),
      buildSkeleton({
        name: 'ScriptedSupportAgent',
        type: 'scripted',
        role: 'support',
      }),
      buildSkeleton({
        name: 'HybridSupportAgent',
        type: 'hybrid',
        role: 'support',
        handoffSources: ['TriageAgent'],
      }),
    ];

    for (const yaml of skeletons) {
      const customerFacingText = extractCustomerFacingPromptAndResponseText(yaml);
      expect(customerFacingText.length).toBeGreaterThan(0);
      for (const text of customerFacingText) {
        expect(CANNED_CUSTOMER_PHRASES).not.toContain(text);
        expect(text).not.toMatch(INTERNAL_CUSTOMER_FACING_TERMS);
      }
    }
  });

  it('emits supervisor handoff conditions as raw runtime expressions', () => {
    const yaml = buildSkeleton({
      name: 'TriageAgent',
      type: 'supervisor',
      role: 'router',
      handoffTargets: [{ name: 'BillingResolutionAgent', returnExpected: true }],
    });

    expect(yaml).toContain('WHEN: intent.category == "billing_resolution"');
    expect(yaml).toContain('WHEN: true');
    expect(yaml).not.toContain('WHEN: "matching intent"');
    expect(yaml).not.toContain('WHEN: "intent.category');
  });

  it('preserves topology experience mode hints in deterministic supervisor skeletons', () => {
    const yaml = buildSkeleton({
      name: 'TriageAgent',
      type: 'supervisor',
      role: 'router',
      handoffTargets: [
        {
          name: 'OrdersAgent',
          returnExpected: true,
          experienceMode: 'shared_voice_handoff',
        },
      ],
    });

    expect(yaml).toContain('EXPERIENCE_MODE: shared_voice_handoff');
    expect(yaml).toContain('RETURN: true');
  });

  it('defaults generated support skeletons to a non-reasoning tool-capable model', () => {
    const yaml = buildSkeleton({
      name: 'OrderResolutionAgent',
      type: 'specialist',
      role: 'orders support',
    });

    expect(yaml).toContain(
      `EXECUTION:\n  model: ${DEFAULT_ARCH_MODEL_POLICY_DEFAULTS.fastToolCapable}`,
    );
    expect(yaml).not.toContain(`model: ${DEFAULT_ARCH_MODEL_POLICY_DEFAULTS.reasoning}`);
  });

  it('keeps optional model policy as intent instead of selecting a reasoning model', () => {
    const yaml = buildSkeleton({
      name: 'ResearchAgent',
      type: 'specialist',
      role: 'research',
      modelPolicy: {
        agentType: 'research',
      },
    });

    expect(yaml).toContain(
      `EXECUTION:\n  model: ${DEFAULT_ARCH_MODEL_POLICY_DEFAULTS.fastToolCapable}`,
    );
    expect(yaml).not.toContain(`model: ${DEFAULT_ARCH_MODEL_POLICY_DEFAULTS.research}`);
  });

  it('accepts caller-supplied model defaults for skeleton generation', () => {
    const yaml = buildSkeleton(
      {
        name: 'OrderResolutionAgent',
        type: 'specialist',
        role: 'orders support',
      },
      {
        modelDefaults: {
          fastToolCapable: 'tenant-fast-support-model',
        },
      },
    );

    expect(yaml).toContain('EXECUTION:\n  model: tenant-fast-support-model');
  });

  it('adds consent-aware confirmation metadata for side-effecting skeleton tools', () => {
    const yaml = buildSkeleton({
      name: 'OrderResolutionAgent',
      type: 'specialist',
      role: 'orders',
      tools: [
        {
          name: 'create_replacement',
          description: 'Create an expedited replacement order.',
          signature:
            'create_replacement(order_id: string, customer_id: string) -> { replacement_id: string }',
        },
      ],
    });

    expect(yaml).toContain('side_effects: true');
    expect(yaml).toContain('confirm: when_side_effects');
    expect(yaml).toContain('immutable: [order_id, customer_id]');
    expect(yaml).toContain('consent_required_in: conversation');
    expect(yaml).toContain('consent_scope: [order_id, customer_id]');
    expect(yaml).toContain('consent_action: "replacement"');
    expect(yaml).toContain('consent_fallback: explicit_prompt');
  });

  it('keeps read-only skeleton tools free of consent prompts', () => {
    const yaml = buildSkeleton({
      name: 'OrderLookupAgent',
      type: 'specialist',
      role: 'orders',
      tools: [
        {
          name: 'get_order',
          description: 'Look up order details before creating replacement options.',
          signature: 'get_order(order_id: string) -> { status: string }',
        },
      ],
    });

    expect(yaml).not.toContain('side_effects: true');
    expect(yaml).not.toContain('confirm: when_side_effects');
    expect(yaml).not.toContain('consent_required_in: conversation');
  });

  it('does not append a placeholder COMPLETE block to scripted agents', () => {
    const yaml = buildSkeleton({
      name: 'OnboardingFlowAgent',
      type: 'scripted',
      role: 'specialist',
    });

    expect(yaml).toContain('THEN: COMPLETE');
    expect(yaml).not.toContain('{{completion_condition_based_on_gathered_data}}');
    expect(yaml).not.toMatch(/^\s*COMPLETE\s*:/m);
  });

  it('normalizes whole-quoted WHEN expressions before persistence', () => {
    const result = processGeneratedABL(
      `AGENT: BillingResolutionAgent
GOAL: "Resolve billing"
PERSONA: |
  Helpful.
MEMORY:
  session:
    - name: invoice_id
      type: string
${DEFAULT_CONTENT_SAFETY_GUARDRAIL}
GATHER:
  invoice_id:
    type: string
    required: true
    prompt: "Invoice?"
COMPLETE:
  - WHEN: "invoice_id != null AND status == \\"ready\\""
    RESPOND: ""
`,
      {
        name: 'BillingResolutionAgent',
        type: 'specialist',
        role: 'billing',
      },
    );

    expect(result.yaml).toContain('WHEN: invoice_id != null AND status == "ready"');
    expect(result.yaml).not.toContain('WHEN: "invoice_id != null');
  });

  it('flags object-shaped FLOW CALL blocks that the parser ignores', () => {
    const result = processGeneratedABL(
      `AGENT: IncidentAgent
GOAL: "Intake incidents"
PERSONA: |
  Helpful.
MEMORY:
  session:
    - name: triage_category
      type: string
${DEFAULT_CONTENT_SAFETY_GUARDRAIL}
TOOLS:
  extract_incident_signals(text: string) -> { category: string }
    description: "Extract incident signals."
FLOW:
  steps:
    - analyze
  analyze:
    REASONING: false
    CALL:
      tool: extract_incident_signals
      args:
        text: "{{issue_summary}}"
      save:
        triage_category: category
    THEN: COMPLETE
`,
      {
        name: 'IncidentAgent',
        type: 'hybrid',
        role: 'incident intake',
      },
    );

    expect(result.skipped).toEqual(
      expect.arrayContaining([expect.stringContaining('Unsupported FLOW CALL object shape')]),
    );
  });
});
