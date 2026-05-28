import { describe, expect, it } from 'vitest';

import {
  buildAgentSystemPrompt,
  type AgentGenerationContext,
} from '@/lib/arch-ai/handbook-reference';

describe('buildAgentSystemPrompt', () => {
  it('teaches runtime-safe conditions without stale placeholders', () => {
    const context: AgentGenerationContext = {
      agentSpec: {
        name: 'Triage',
        role: 'supervisor',
        executionMode: 'reasoning',
        isEntry: true,
      },
      topology: {
        agents: [
          { name: 'Triage', role: 'supervisor', executionMode: 'reasoning' },
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
            expectReturn: true,
          },
        ],
      },
      domain: {
        domain: 'Billing support',
        channels: ['web'],
        compliance: [],
        integrations: [],
        tone: 'helpful',
      },
      plan: {
        agentName: 'Triage',
        archetype: 'supervisor',
        keyword: 'SUPERVISOR',
        isEntry: true,
        gather: { required: false, reason: 'Supervisors route, not gather', suggestedFields: [] },
        complete: { required: false, reason: 'Supervisors route indefinitely' },
        flow: {
          recommended: false,
          reason: 'Reasoning supervisor',
          executionMode: 'reasoning',
        },
        complexity: {
          selectedExecutionMode: 'reasoning',
          level: 'structured',
          reason: 'Supervisor routes by intent without deterministic flow.',
          signals: ['supervisor_routing'],
        },
        handoffs: {
          targets: [
            {
              to: 'BillingResolutionAgent',
              edgeType: 'delegate',
              returnExpected: true,
              condition: undefined,
            },
          ],
          needsCatchAll: true,
          catchAllTarget: 'BillingResolutionAgent',
        },
        allowedPassFields: [],
        blocked: [],
        localTopology: {
          agents: [
            { name: 'Triage', role: 'supervisor', executionMode: 'reasoning' },
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
              returnExpected: true,
            },
          ],
        },
      },
    };

    const prompt = buildAgentSystemPrompt(context);

    expect(prompt).toContain('## Runtime Expression Contract');
    expect(prompt).toContain('## Final Runtime Shape Contract');
    expect(prompt).toContain('compilation as necessary but not sufficient');
    expect(prompt).toContain('Entry behavior may use `ON_START`');
    expect(prompt).toContain('Use one routing-state vocabulary per supervisor');
    expect(prompt).toContain('first real user request should be processed');
    expect(prompt).toContain('Terminal paths must not produce an empty customer experience');
    expect(prompt).toContain(
      '(status == "active" OR priority == "high") AND approval_needed == true',
    );
    expect(prompt).toContain('intent.category == "billing"');
    expect(prompt).toContain('delegate INPUT mappings');
    expect(prompt).toContain('Complexity Decision');
    expect(prompt).not.toContain('WHEN: "matching intent"');
    expect(prompt).not.toContain('WHEN: "<infer from agent role>"');
    expect(prompt).not.toContain('intent matches BillingResolutionAgent');
    expect(prompt).not.toContain('Do not worry about boilerplate');
  });

  it('describes return-path completion as runtime state evaluation, not LLM judgment', () => {
    const context: AgentGenerationContext = {
      agentSpec: {
        name: 'BillingResolutionAgent',
        role: 'specialist',
        executionMode: 'reasoning',
        isEntry: false,
      },
      topology: {
        agents: [
          { name: 'Triage', role: 'supervisor', executionMode: 'reasoning' },
          {
            name: 'BillingResolutionAgent',
            role: 'specialist',
            executionMode: 'reasoning',
          },
          {
            name: 'ScriptedLookupAgent',
            role: 'lookup specialist',
            executionMode: 'scripted',
          },
        ],
        edges: [
          {
            from: 'Triage',
            to: 'BillingResolutionAgent',
            type: 'handoff',
            expectReturn: true,
          },
          {
            from: 'Triage',
            to: 'ScriptedLookupAgent',
            type: 'handoff',
            expectReturn: true,
          },
        ],
      },
      domain: {
        domain: 'Billing support',
        channels: ['web'],
        compliance: [],
        integrations: [],
        tone: 'helpful',
      },
      plan: {
        agentName: 'BillingResolutionAgent',
        archetype: 'specialist',
        keyword: 'AGENT',
        isEntry: false,
        gather: {
          required: true,
          reason:
            'Delegate target with RETURN: true from Triage — GATHER fields drive structured progress toward COMPLETE conditions',
          suggestedFields: ['invoice_id', 'resolution_confirmed'],
        },
        complete: {
          required: true,
          reason:
            'Return contract: Triage expects control to return — COMPLETE conditions signal when to return',
        },
        flow: {
          recommended: false,
          reason:
            'Reasoning mode uses GATHER + tool loop — FLOW is not needed unless deterministic steps are required',
          executionMode: 'reasoning',
        },
        complexity: {
          selectedExecutionMode: 'reasoning',
          level: 'structured',
          reason: 'Delegate target can complete through reasoning and GATHER.',
          signals: ['return_contract'],
        },
        handoffs: {
          targets: [],
          needsCatchAll: false,
          catchAllTarget: undefined,
        },
        allowedPassFields: ['invoice_id'],
        blocked: [],
        localTopology: {
          agents: [
            { name: 'Triage', role: 'supervisor', executionMode: 'reasoning' },
            {
              name: 'BillingResolutionAgent',
              role: 'specialist',
              executionMode: 'reasoning',
            },
          ],
          edges: [
            {
              from: 'Triage',
              to: 'BillingResolutionAgent',
              type: 'delegate',
              returnExpected: true,
            },
          ],
        },
      },
    };

    const prompt = buildAgentSystemPrompt(context);

    expect(prompt).toContain('COMPLETE is runtime-evaluated against session state');
    expect(prompt).toContain('Do not use natural-language phrases like "issue resolved"');
    expect(prompt).toContain('Use RESPOND: "" for explicit silent completion');
    expect(prompt).toContain('Do not omit RESPOND');
    expect(prompt).toContain('issue_summary != null AND resolution_confirmed == true');
    expect(prompt).toContain('Do NOT add a HANDOFF back to the caller to simulate return');
    expect(prompt).toContain('RESPOND: ""');
    expect(prompt).toContain('history: auto');
    expect(prompt).toContain('strict summary-only transfer');
    expect(prompt).toContain('ON_RETURN.map');
    expect(prompt).toContain(
      'RETURN: true already default-merges child gathered fields back to the parent by same name.',
    );
    expect(prompt).toContain(
      'Only use ON_RETURN.map keys that the child agent actually gathers or populates before it returns.',
    );
    expect(prompt).toContain('Topology field seeds that may become valid CONTEXT.pass candidates');
    expect(prompt).not.toContain('can evaluate via LLM but less reliable');
    expect(prompt).not.toContain('REASON: "Collected the issue details');
    expect(prompt).not.toContain('GATHER:\n  fields:');
  });

  it('renders structured retry metadata for the next worker attempt', () => {
    const context: AgentGenerationContext = {
      agentSpec: {
        name: 'BillingResolutionAgent',
        role: 'specialist',
        executionMode: 'reasoning',
        isEntry: false,
      },
      topology: {
        agents: [
          { name: 'Triage', role: 'supervisor', executionMode: 'reasoning' },
          {
            name: 'BillingResolutionAgent',
            role: 'specialist',
            executionMode: 'reasoning',
          },
        ],
        edges: [
          {
            from: 'Triage',
            to: 'BillingResolutionAgent',
            type: 'handoff',
            expectReturn: true,
          },
        ],
      },
      domain: {
        domain: 'Billing support',
        channels: ['web'],
        compliance: [],
        integrations: [],
        tone: 'helpful',
      },
      retryFeedback: {
        attempt: 2,
        errors: ['[CO-02] COMPLETE references undeclared state.'],
        warnings: ['[QG-01] Agent has no GUARDRAILS.'],
        hint: 'Use declared session variables only.',
        diagnosticCodes: ['CO-02', 'QG-01'],
        retryReason: 'Previous retry failed because completion state was undeclared.',
      },
    };

    const prompt = buildAgentSystemPrompt(context);

    expect(prompt).toContain('## Previous Build Validation Feedback');
    expect(prompt).toContain('This is retry attempt 2.');
    expect(prompt).toContain('failed build validation');
    expect(prompt).toContain('runtime-readiness contract feedback');
    expect(prompt).toContain('Diagnostic codes:');
    expect(prompt).toContain('CO-02, QG-01');
    expect(prompt).toContain('Retry policy note:');
    expect(prompt).toContain('Previous retry failed because completion state was undeclared.');
    expect(prompt).not.toContain('The previous ABL did not compile cleanly');
  });

  it('surfaces shared-voice handoff experience for target generation', () => {
    const context: AgentGenerationContext = {
      agentSpec: {
        name: 'OrdersResolutionAgent',
        role: 'orders specialist',
        executionMode: 'reasoning',
        isEntry: false,
      },
      topology: {
        agents: [
          { name: 'Triage', role: 'supervisor', executionMode: 'reasoning' },
          {
            name: 'OrdersResolutionAgent',
            role: 'orders specialist',
            executionMode: 'reasoning',
          },
        ],
        edges: [
          {
            from: 'Triage',
            to: 'OrdersResolutionAgent',
            type: 'transfer',
            experienceMode: 'shared_voice_handoff',
            condition: 'routing_intent == "order_status"',
            expectReturn: false,
          },
        ],
      },
      domain: {
        domain: 'VoltMart support',
        channels: ['web', 'voice'],
        compliance: [],
        integrations: [],
        tone: 'warm',
      },
    };

    const prompt = buildAgentSystemPrompt(context);

    expect(prompt).toContain('## Shared Voice Continuity — CRITICAL');
    expect(prompt).toContain('shared_voice_handoff traffic from: Triage');
    expect(prompt).toContain('USE BEHAVIOR_PROFILE: shared_voice_handoff');
    expect(prompt).toContain(
      'Triage → OrdersResolutionAgent [transfer, experienceMode: shared_voice_handoff',
    );
    expect(prompt).toContain('routing_intent == "order_status"');
    expect(prompt).toContain('Do not re-introduce yourself');
  });

  it('surfaces topology-derived child return-field seeds for returnable handoffs', () => {
    const context: AgentGenerationContext = {
      agentSpec: {
        name: 'Triage',
        role: 'supervisor',
        executionMode: 'reasoning',
        isEntry: true,
      },
      topology: {
        agents: [
          { name: 'Triage', role: 'supervisor', executionMode: 'reasoning' },
          {
            name: 'BillingResolutionAgent',
            role: 'specialist',
            executionMode: 'reasoning',
          },
        ],
        edges: [
          {
            from: 'Triage',
            to: 'BillingResolutionAgent',
            type: 'handoff',
            expectReturn: true,
          },
        ],
      },
      domain: {
        domain: 'Billing support',
        channels: ['web'],
        compliance: [],
        integrations: [],
        tone: 'helpful',
      },
      plan: {
        agentName: 'Triage',
        archetype: 'supervisor',
        keyword: 'SUPERVISOR',
        isEntry: true,
        gather: {
          required: false,
          reason: 'Supervisors route, not gather',
          suggestedFields: [],
        },
        complete: {
          required: false,
          reason: 'Supervisors route indefinitely — no COMPLETE needed',
        },
        flow: {
          recommended: false,
          reason:
            'Reasoning mode uses GATHER + tool loop — FLOW is not needed unless deterministic steps are required',
          executionMode: 'reasoning',
        },
        complexity: {
          selectedExecutionMode: 'reasoning',
          level: 'structured',
          reason: 'Supervisor routes by intent.',
          signals: ['supervisor_routing'],
        },
        handoffs: {
          targets: [
            {
              to: 'BillingResolutionAgent',
              edgeType: 'delegate',
              returnExpected: true,
              condition: 'billing issue',
              returnFieldSeeds: ['invoice_id', 'resolution_confirmed'],
              historyHint: {
                suggestedHistory: 'auto',
                autoSummaryEligible: true,
                summaryRecommended: true,
                summaryFocusFields: [],
                summaryTemplateSeed:
                  "Summarize the user's request, why BillingResolutionAgent is being invoked, and the most relevant context already known to Triage.",
                reason:
                  'BillingResolutionAgent uses reasoning execution. If you author CONTEXT.summary, keep history: auto; runtime can resolve it to summary_only for this target when summary is present and otherwise falls back to bounded raw history.',
              },
              returnContractHint: {
                defaultMergedFields: ['invoice_id', 'resolution_confirmed'],
                reason:
                  "Supervisors usually only need explicit ON_RETURN.map when they want renamed parent fields or non-gather child outputs. Runtime default return already merges BillingResolutionAgent's gathered fields back to the parent by same name (invoice_id, resolution_confirmed). Use ON_RETURN.map only when the parent needs renamed fields, selective mapping, or non-gather child outputs.",
              },
            },
            {
              to: 'ScriptedLookupAgent',
              edgeType: 'delegate',
              returnExpected: true,
              condition: 'lookup issue',
              returnFieldSeeds: ['lookup_topic'],
              historyHint: {
                suggestedHistory: 'auto',
                autoSummaryEligible: false,
                summaryRecommended: true,
                summaryFocusFields: [],
                summaryTemplateSeed:
                  "Summarize the user's request, why ScriptedLookupAgent is being invoked, and the most relevant context already known to Triage.",
                reason:
                  'ScriptedLookupAgent is scripted. If you author CONTEXT.summary, keep history: auto (or bounded last_n); runtime auto falls back to bounded raw history for scripted targets instead of summary_only.',
              },
              returnContractHint: {
                defaultMergedFields: ['lookup_topic'],
                reason:
                  "Supervisors usually only need explicit ON_RETURN.map when they want renamed parent fields or non-gather child outputs. Runtime default return already merges ScriptedLookupAgent's gathered fields back to the parent by same name (lookup_topic). Use ON_RETURN.map only when the parent needs renamed fields, selective mapping, or non-gather child outputs.",
              },
            },
          ],
          needsCatchAll: true,
          catchAllTarget: 'BillingResolutionAgent',
        },
        allowedPassFields: [],
        blocked: [],
        localTopology: {
          agents: [
            { name: 'Triage', role: 'supervisor', executionMode: 'reasoning' },
            {
              name: 'BillingResolutionAgent',
              role: 'specialist',
              executionMode: 'reasoning',
            },
            {
              name: 'ScriptedLookupAgent',
              role: 'lookup specialist',
              executionMode: 'scripted',
            },
          ],
          edges: [
            {
              from: 'Triage',
              to: 'BillingResolutionAgent',
              type: 'delegate',
              returnExpected: true,
            },
            {
              from: 'Triage',
              to: 'ScriptedLookupAgent',
              type: 'delegate',
              returnExpected: true,
            },
          ],
        },
      },
    };

    const prompt = buildAgentSystemPrompt(context);

    expect(prompt).toContain('### Summary Hints');
    expect(prompt).toContain('BillingResolutionAgent: author CONTEXT.summary');
    expect(prompt).toContain('### Default Return Fields');
    expect(prompt).toContain('- BillingResolutionAgent: invoice_id, resolution_confirmed');
    expect(prompt).toContain('### Handoff History Hints');
    expect(prompt).toContain('BillingResolutionAgent: prefer history: auto');
    expect(prompt).toContain('resolve it to summary_only for this target');
    expect(prompt).toContain('ScriptedLookupAgent: prefer history: auto');
    expect(prompt).toContain('falls back to bounded raw history for scripted targets');
    expect(prompt).toContain('### Return Contract Hints');
    expect(prompt).toContain('default return already merges BillingResolutionAgent');
  });

  it('surfaces inferred gather hints and flow outline for structured agents', () => {
    const context: AgentGenerationContext = {
      agentSpec: {
        name: 'BillingResolutionAgent',
        role: 'Resolve billing disputes and refunds',
        executionMode: 'hybrid',
        description: 'Investigates payment failures and fixes invoice problems.',
        gatherFields: ['invoice_id', 'billing_issue_summary', 'desired_outcome'],
        gatherFieldSource: 'inferred',
        flowStepSeeds: [
          'collect_billing_context',
          'review_billing_request',
          'confirm_resolution_path',
          'deliver_resolution',
        ],
        flowStepSource: 'inferred',
        isEntry: false,
      },
      topology: {
        agents: [
          { name: 'Triage', role: 'supervisor', executionMode: 'reasoning' },
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
            expectReturn: true,
          },
        ],
      },
      domain: {
        domain: 'CommerceCare billing support',
        channels: ['web'],
        compliance: ['PCI-DSS'],
        integrations: ['Stripe'],
        tone: 'helpful',
      },
    };

    const prompt = buildAgentSystemPrompt(context);

    expect(prompt).toContain('## Requirement-Derived Gather Hints');
    expect(prompt).toContain('invoice_id');
    expect(prompt).toContain('billing_issue_summary');
    expect(prompt).toContain('Do not collapse back to generic placeholders');
    expect(prompt).toContain('## Suggested Flow Outline');
    expect(prompt).toContain('collect_billing_context');
    expect(prompt).toContain('review_billing_request');
    expect(prompt).toContain('confirm_resolution_path');
    expect(prompt).toContain(
      'Suggested Flow Steps: collect_billing_context -> review_billing_request',
    );
    expect(prompt).toContain('FLOW must reflect the real business journey for this project');
  });
});
