import { describe, expect, it } from 'vitest';

import {
  extractBuildTopology,
  inferAgentRequirementHints,
  shouldUseDeterministicScaffold,
} from '@/lib/arch-ai/build-requirement-inference';

describe('build requirement inference', () => {
  it('preserves rich locked-topology metadata for BUILD workers', () => {
    const topology = extractBuildTopology({
      metadata: {
        lockedTopology: {
          agents: [
            {
              name: 'BillingResolutionAgent',
              role: 'Resolves billing disputes',
              executionMode: 'hybrid',
              description: 'Handles invoices, refunds, and payment corrections.',
              tools: ['lookup_invoice', { name: 'issue_refund' }],
              gatherFields: ['invoice_id', { name: 'billing_issue_summary' }],
              suggestedConstructs: ['FLOW', 'MEMORY'],
              flowStepSeeds: ['collect_billing_context', { name: 'confirm_resolution_path' }],
            },
          ],
          edges: [
            {
              from: 'Triage',
              to: 'BillingResolutionAgent',
              type: 'transfer',
              experienceMode: 'shared_voice_handoff',
              condition: 'billing or refund issue',
              expectReturn: true,
            },
          ],
          entryPoint: 'Triage',
        },
      },
    } as never);

    expect(topology.entryPoint).toBe('Triage');
    expect(topology.agents).toEqual([
      {
        name: 'BillingResolutionAgent',
        role: 'Resolves billing disputes',
        executionMode: 'hybrid',
        description: 'Handles invoices, refunds, and payment corrections.',
        tools: ['lookup_invoice', 'issue_refund'],
        gatherFields: ['invoice_id', 'billing_issue_summary'],
        suggestedConstructs: ['FLOW', 'MEMORY'],
        flowStepSeeds: ['collect_billing_context', 'confirm_resolution_path'],
      },
    ]);
    expect(topology.edges).toEqual([
      {
        from: 'Triage',
        to: 'BillingResolutionAgent',
        type: 'transfer',
        experienceMode: 'shared_voice_handoff',
        condition: 'billing or refund issue',
        expectReturn: true,
      },
    ]);
  });

  it('infers project-aware gather fields and flow seeds when topology is sparse', () => {
    const hints = inferAgentRequirementHints({
      agent: {
        name: 'BillingResolutionAgent',
        role: 'Resolve billing disputes and refunds',
        executionMode: 'hybrid',
        description: 'Investigates payment failures and fixes invoice problems.',
      },
      topology: {
        agents: [
          {
            name: 'Triage',
            role: 'Routes requests',
            executionMode: 'reasoning',
          },
          {
            name: 'BillingResolutionAgent',
            role: 'Resolve billing disputes and refunds',
            executionMode: 'hybrid',
          },
        ],
        edges: [
          {
            from: 'Triage',
            to: 'BillingResolutionAgent',
            type: 'delegate',
            condition: 'billing issue',
            expectReturn: true,
          },
        ],
        entryPoint: 'Triage',
      },
      specification: {
        projectName: 'CommerceCare',
        description: 'Customer support for invoices, refunds, and payment failures.',
        channels: ['Web Chat'],
        conversationNotes: [
          {
            category: 'compliance',
            label: 'PCI-DSS',
            detail: 'Protect cardholder workflows.',
          },
          {
            category: 'sla',
            label: 'Urgent billing queue',
            detail: 'Resolve payment issues quickly.',
          },
        ],
      },
      domain: {
        domain: 'CommerceCare: Customer support for invoices, refunds, and payment failures.',
        channels: ['Web Chat'],
        compliance: ['PCI-DSS'],
        integrations: ['Stripe'],
        tone: 'helpful',
      },
    });

    expect(hints.gatherFieldSource).toBe('inferred');
    expect(hints.gatherFields).toEqual([
      'invoice_id',
      'billing_issue_summary',
      'desired_outcome',
      'urgency_level',
    ]);
    expect(hints.flowStepSource).toBe('inferred');
    expect(hints.flowStepSeeds).toEqual([
      'collect_billing_context',
      'review_billing_request',
      'confirm_resolution_path',
      'deliver_resolution',
    ]);
  });

  it('uses scaffold as the construct-safe baseline for FLOW-heavy or tool-backed agents', () => {
    expect(
      shouldUseDeterministicScaffold({
        plan: undefined,
        agent: { name: 'NoPlanAgent' },
      }),
    ).toEqual({
      allowed: false,
      reason: 'missing_architecture_plan',
    });

    expect(
      shouldUseDeterministicScaffold({
        plan: {
          agentName: 'BillingResolutionAgent',
          archetype: 'specialist',
          keyword: 'AGENT',
          isEntry: false,
          gather: {
            required: true,
            reason: 'Needs structured state',
            suggestedFields: ['invoice_id'],
          },
          complete: {
            required: true,
            reason: 'Must return to supervisor',
          },
          flow: {
            recommended: true,
            reason: 'Hybrid workflow',
            executionMode: 'hybrid',
          },
          complexity: {
            selectedExecutionMode: 'hybrid',
            level: 'complex',
            reason: 'Tool-backed ordered workflow',
            signals: ['tool_backed', 'ordered_business_process'],
          },
          handoffs: {
            targets: [],
            needsCatchAll: false,
            catchAllTarget: undefined,
          },
          allowedPassFields: [],
          blocked: [],
          localTopology: {
            agents: [
              {
                name: 'BillingResolutionAgent',
                role: 'Resolve billing disputes',
                executionMode: 'hybrid',
              },
            ],
            edges: [],
          },
        },
        agent: {
          name: 'BillingResolutionAgent',
          executionMode: 'hybrid',
          flowStepSeeds: ['collect_billing_context', 'deliver_resolution'],
        },
      }),
    ).toEqual({
      allowed: true,
      reason: 'eligible_construct_safe_baseline',
    });

    expect(
      shouldUseDeterministicScaffold({
        plan: {
          agentName: 'FAQAgent',
          archetype: 'specialist',
          keyword: 'AGENT',
          isEntry: false,
          gather: {
            required: false,
            reason: 'No structured state needed',
            suggestedFields: [],
          },
          complete: {
            required: false,
            reason: 'Can answer directly',
          },
          flow: {
            recommended: false,
            reason: 'Reasoning mode',
            executionMode: 'reasoning',
          },
          complexity: {
            selectedExecutionMode: 'reasoning',
            level: 'simple',
            reason: 'Direct reasoning FAQ',
            signals: ['single_agent'],
          },
          handoffs: {
            targets: [],
            needsCatchAll: false,
            catchAllTarget: undefined,
          },
          allowedPassFields: [],
          blocked: [],
          localTopology: {
            agents: [{ name: 'FAQAgent', role: 'Answers FAQs', executionMode: 'reasoning' }],
            edges: [],
          },
        },
        agent: {
          name: 'FAQAgent',
          executionMode: 'reasoning',
        },
      }),
    ).toEqual({
      allowed: true,
      reason: 'eligible',
    });

    expect(
      shouldUseDeterministicScaffold({
        plan: {
          agentName: 'LegacyHybridFAQ',
          archetype: 'specialist',
          keyword: 'AGENT',
          isEntry: false,
          gather: {
            required: false,
            reason: 'No structured state needed',
            suggestedFields: [],
          },
          complete: {
            required: false,
            reason: 'Can answer directly',
          },
          flow: {
            recommended: false,
            reason: 'Planner selected reasoning despite stale topology mode',
            executionMode: 'reasoning',
          },
          complexity: {
            selectedExecutionMode: 'reasoning',
            level: 'simple',
            reason: 'Simple FAQ should use reasoning',
            signals: ['single_agent'],
          },
          handoffs: {
            targets: [],
            needsCatchAll: false,
            catchAllTarget: undefined,
          },
          allowedPassFields: [],
          blocked: [],
          localTopology: {
            agents: [
              {
                name: 'LegacyHybridFAQ',
                role: 'Answers FAQs',
                executionMode: 'hybrid',
              },
            ],
            edges: [],
          },
        },
        agent: {
          name: 'LegacyHybridFAQ',
          executionMode: 'hybrid',
        },
      }),
    ).toEqual({
      allowed: true,
      reason: 'eligible',
    });
  });
});
