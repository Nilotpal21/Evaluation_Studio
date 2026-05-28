import { describe, expect, it } from 'vitest';
import { parseAgentBasedABL } from '@abl/core';
import { compileABLtoIR, validateIR } from '@abl/compiler';
import type { AgentArchitecturePlan } from '@agent-platform/arch-ai/planning/types';
import type { DomainContextInput } from '@/lib/arch-ai/scaffold/types';
import { assembleAblAgent } from '@/lib/arch-ai/scaffold/assembler';
import { validateScaffoldConstructPlan } from '@/lib/arch-ai/scaffold/construct-plan';
import { scaffoldAblAgent } from '@/lib/arch-ai/scaffold/scaffold-generator';
import { validateGatherAsk, validateHandoffWhen } from '@/lib/arch-ai/scaffold/slot-validators';
import { renderManagedBehaviorProfileDocumentsForTopology } from '@/lib/arch-ai/managed-behavior-profiles';

const baseDomain: DomainContextInput = {
  domain: 'Order Support',
  channels: ['web'],
  compliance: [],
  integrations: [],
  tone: 'professional',
};

function parseGeneratedAgent(name: string, yaml: string) {
  const parsed = parseAgentBasedABL(yaml);
  expect(parsed.errors, name).toEqual([]);
  expect(parsed.document, name).toBeTruthy();
  return parsed.document!;
}

function expectGeneratedAgentsCompile(agents: ReadonlyArray<{ name: string; yaml: string }>): void {
  const documents = agents.map((agent) => parseGeneratedAgent(agent.name, agent.yaml));
  const compiled = compileABLtoIR(documents, { mode: 'preview' });
  expect(compiled.errors ?? [], agents.map((agent) => agent.name).join(', ')).toEqual([]);
}

function buildPlan(gatherFields: string[]): AgentArchitecturePlan {
  return {
    agentName: 'OrderStatusAgent',
    archetype: 'specialist',
    keyword: 'AGENT',
    isEntry: false,
    gather: {
      required: gatherFields.length > 0,
      reason:
        gatherFields.length > 0
          ? 'Structured inputs are needed before the agent can return.'
          : 'The agent can answer directly without collecting structured inputs.',
      suggestedFields: gatherFields,
    },
    complete: {
      required: true,
      reason: 'The supervisor expects control to return after the specialist finishes.',
    },
    flow: {
      recommended: false,
      reason: 'Reasoning specialist',
      executionMode: 'reasoning',
    },
    complexity: {
      selectedExecutionMode: 'reasoning',
      level: gatherFields.length > 0 ? 'structured' : 'simple',
      reason: 'Specialist can use reasoning with optional structured gather.',
      signals: gatherFields.length > 0 ? ['return_contract'] : ['single_agent'],
    },
    handoffs: {
      targets: [],
      needsCatchAll: false,
      catchAllTarget: undefined,
    },
    allowedPassFields: [],
    blocked: [],
    localTopology: {
      agents: [{ name: 'OrderStatusAgent', role: 'Order specialist', executionMode: 'reasoning' }],
      edges: [],
    },
  };
}

describe('scaffold generation', () => {
  it('validates handoff WHEN values as runtime-actionable conditions', () => {
    expect(validateHandoffWhen('matching intent').ok).toBe(true);
    expect(validateHandoffWhen('<infer from agent role>').ok).toBe(true);
    expect(validateHandoffWhen('user asks about billing charges or invoice disputes').ok).toBe(
      true,
    );
    expect(validateHandoffWhen('intent.category == "billing"').ok).toBe(true);
    expect(
      validateHandoffWhen(
        '(account_status == "past_due" OR invoice_id != null) AND wants_billing_help == true',
      ).ok,
    ).toBe(true);
  });

  it('rejects generic scaffold gather prompts', () => {
    expect(validateGatherAsk('{{question_to_collect_this_field}}').ok).toBe(false);
    expect(validateGatherAsk('Can you provide the details?').ok).toBe(false);
    expect(validateGatherAsk('What order number should I use to look up this delivery?').ok).toBe(
      true,
    );
  });

  it('keeps deterministic ON_START greetings domain-neutral for non-support domains', () => {
    const chatScaffold = scaffoldAblAgent(
      { ...buildPlan([]), agentName: 'FitnessCoachAgent' },
      {
        agents: [{ name: 'FitnessCoachAgent', role: 'Fitness coach', executionMode: 'reasoning' }],
        edges: [],
        entryPoint: 'FitnessCoachAgent',
      },
      {
        name: 'FitnessCoachAgent',
        role: 'Fitness coach',
        executionMode: 'reasoning',
        isEntry: true,
      },
      {
        ...baseDomain,
        domain: 'Fitness Coaching',
        channels: ['web'],
      },
    );
    const voiceScaffold = scaffoldAblAgent(
      { ...buildPlan([]), agentName: 'FitnessCoachAgent' },
      {
        agents: [{ name: 'FitnessCoachAgent', role: 'Fitness coach', executionMode: 'reasoning' }],
        edges: [],
        entryPoint: 'FitnessCoachAgent',
      },
      {
        name: 'FitnessCoachAgent',
        role: 'Fitness coach',
        executionMode: 'reasoning',
        isEntry: true,
      },
      {
        ...baseDomain,
        domain: 'Fitness Coaching',
        channels: ['voice'],
      },
    );

    expect(chatScaffold.skeleton.onStartRespond).toBe('Hi. What can I help with?');
    expect(voiceScaffold.skeleton.onStartRespond).toBe('Hi, how can I help?');
    expect(chatScaffold.skeleton.onStartRespond).not.toMatch(/\bsupport\b/i);
    expect(voiceScaffold.skeleton.onStartRespond).not.toMatch(/\bsupport\b/i);
  });

  it('attaches shared voice behavior profile references to scaffolded handoff targets', () => {
    const topology = {
      agents: [
        { name: 'LeadRouter', role: 'Lead router', executionMode: 'reasoning' as const },
        { name: 'OrdersAgent', role: 'Orders specialist', executionMode: 'reasoning' as const },
      ],
      edges: [
        {
          from: 'LeadRouter',
          to: 'OrdersAgent',
          type: 'transfer' as const,
          experienceMode: 'shared_voice_handoff' as const,
          expectReturn: true,
        },
      ],
      entryPoint: 'LeadRouter',
    };
    const scaffold = scaffoldAblAgent(
      { ...buildPlan([]), agentName: 'OrdersAgent' },
      topology,
      {
        name: 'OrdersAgent',
        role: 'Orders specialist',
        executionMode: 'reasoning',
        isEntry: false,
      },
      baseDomain,
    );

    expect(scaffold.skeleton.behaviorProfileUses).toEqual(['shared_voice_handoff']);

    const { yaml } = assembleAblAgent(scaffold.skeleton, {
      goal: 'Resolve order status and replacement requests.',
      persona:
        'You continue the existing conversation and resolve order issues clearly and calmly.',
    });
    const documents = [
      parseGeneratedAgent('OrdersAgent', yaml),
      ...renderManagedBehaviorProfileDocumentsForTopology(topology, baseDomain).map((profile) => {
        const parsed = parseAgentBasedABL(profile);
        expect(parsed.errors).toEqual([]);
        return parsed.document!;
      }),
    ];
    const compiled = compileABLtoIR(documents, { mode: 'preview' });

    expect(yaml).toContain('USE BEHAVIOR_PROFILE: shared_voice_handoff');
    expect(compiled.errors ?? []).toEqual([]);
    expect(compiled.agents.OrdersAgent.behavior_profiles?.map((profile) => profile.name)).toEqual([
      'shared_voice_handoff',
    ]);
  });

  it('preserves handoff experience mode when assembling scaffolded routers', () => {
    const topology = {
      agents: [
        { name: 'LeadRouter', role: 'Lead router', executionMode: 'reasoning' as const },
        { name: 'OrdersAgent', role: 'Orders specialist', executionMode: 'reasoning' as const },
      ],
      edges: [
        {
          from: 'LeadRouter',
          to: 'OrdersAgent',
          type: 'transfer' as const,
          experienceMode: 'shared_voice_handoff' as const,
          expectReturn: true,
        },
      ],
      entryPoint: 'LeadRouter',
    };
    const scaffold = scaffoldAblAgent(
      {
        ...buildPlan([]),
        agentName: 'LeadRouter',
        archetype: 'supervisor',
        keyword: 'SUPERVISOR',
        isEntry: true,
        handoffs: {
          targets: [
            {
              to: 'OrdersAgent',
              edgeType: 'transfer',
              experienceMode: 'shared_voice_handoff',
              returnExpected: true,
              condition: 'orders help',
            },
          ],
          needsCatchAll: false,
          catchAllTarget: undefined,
        },
      },
      topology,
      {
        name: 'LeadRouter',
        role: 'Lead router',
        executionMode: 'reasoning',
        isEntry: true,
      },
      baseDomain,
    );

    const { yaml } = assembleAblAgent(scaffold.skeleton, {
      goal: 'Route customers to the right order specialist.',
      persona: 'You route order support requests clearly.',
      'gather.routing_intent.ask': 'What can I help with?',
      'handoff.0.when': 'intent.category == "orders"',
    });

    expect(yaml).toContain('EXPERIENCE_MODE: shared_voice_handoff');
    expect(yaml).toContain('RETURN: true');
  });

  it('surfaces runtime-aligned history hints in supervisor scaffold prompts', () => {
    const scaffold = scaffoldAblAgent(
      {
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
          reason: 'Reasoning supervisor',
          executionMode: 'reasoning',
        },
        complexity: {
          selectedExecutionMode: 'reasoning',
          level: 'structured',
          reason: 'Supervisor routes by intent categories.',
          signals: ['supervisor_routing'],
        },
        handoffs: {
          targets: [
            {
              to: 'BillingResolutionAgent',
              edgeType: 'delegate',
              returnExpected: true,
              condition: 'billing issue',
              returnFieldSeeds: ['invoice_id'],
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
                defaultMergedFields: ['invoice_id'],
                reason:
                  "Supervisors usually only need explicit ON_RETURN.map when they want renamed parent fields or non-gather child outputs. Runtime default return already merges BillingResolutionAgent's gathered fields back to the parent by same name (invoice_id). Use ON_RETURN.map only when the parent needs renamed fields, selective mapping, or non-gather child outputs.",
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
            { name: 'Triage', role: 'Triage supervisor', executionMode: 'reasoning' },
            {
              name: 'BillingResolutionAgent',
              role: 'Billing specialist',
              executionMode: 'reasoning',
            },
            {
              name: 'ScriptedLookupAgent',
              role: 'Lookup specialist',
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
            { from: 'Triage', to: 'ScriptedLookupAgent', type: 'delegate', returnExpected: true },
          ],
        },
      },
      {
        agents: [
          {
            name: 'Triage',
            role: 'Triage supervisor',
            executionMode: 'reasoning',
            description: 'Routes support issues.',
          },
          {
            name: 'BillingResolutionAgent',
            role: 'Billing specialist',
            executionMode: 'reasoning',
          },
          {
            name: 'ScriptedLookupAgent',
            role: 'Lookup specialist',
            executionMode: 'scripted',
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
      },
      {
        name: 'Triage',
        role: 'Triage supervisor',
        executionMode: 'reasoning',
        description: 'Routes support issues.',
        isEntry: true,
      },
      baseDomain,
    );

    expect(scaffold.skeleton.runtimePattern).toBe('router');
    expect(scaffold.prompt).toContain('Runtime-aligned continuity hints');
    expect(scaffold.prompt).toContain('Runtime-aligned summary hints');
    expect(scaffold.prompt).toContain('author CONTEXT.summary');
    expect(scaffold.prompt).toContain('BillingResolutionAgent: prefer history: auto');
    expect(scaffold.prompt).toContain('resolve it to summary_only for this target');
    expect(scaffold.prompt).toContain('ScriptedLookupAgent: prefer history: auto');
    expect(scaffold.prompt).toContain('falls back to bounded raw history for scripted targets');
    expect(scaffold.prompt).toContain('default-merge back to the parent by same name');
    expect(scaffold.prompt).toContain('Runtime-aligned return-contract hints');
    expect(scaffold.prompt).toContain('Use runtime-actionable WHEN expressions');
    expect(scaffold.prompt).toContain('intent.category == "billing"');
    expect(scaffold.prompt).toContain('Do not write plain-English WHEN values');
  });

  it('normalizes bare supervisor handoff labels to intent category expressions', () => {
    const scaffold = scaffoldAblAgent(
      {
        agentName: 'LeadRouter',
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
          reason: 'Reasoning supervisor',
          executionMode: 'reasoning',
        },
        complexity: {
          selectedExecutionMode: 'reasoning',
          level: 'structured',
          reason: 'Supervisor routes by intent categories.',
          signals: ['supervisor_routing'],
        },
        handoffs: {
          targets: [
            {
              to: 'SalesHandoffAgent',
              edgeType: 'delegate',
              returnExpected: true,
              condition: undefined,
            },
          ],
          needsCatchAll: true,
          catchAllTarget: 'SalesHandoffAgent',
        },
        allowedPassFields: [],
        blocked: [],
        localTopology: {
          agents: [
            { name: 'LeadRouter', role: 'Lead router', executionMode: 'reasoning' },
            {
              name: 'SalesHandoffAgent',
              role: 'Sales handoff',
              executionMode: 'reasoning',
            },
          ],
          edges: [
            { from: 'LeadRouter', to: 'SalesHandoffAgent', type: 'delegate', returnExpected: true },
          ],
        },
      },
      {
        agents: [
          { name: 'LeadRouter', role: 'Lead router', executionMode: 'reasoning' },
          { name: 'SalesHandoffAgent', role: 'Sales handoff', executionMode: 'reasoning' },
        ],
        edges: [
          { from: 'LeadRouter', to: 'SalesHandoffAgent', type: 'delegate', expectReturn: true },
        ],
        entryPoint: 'LeadRouter',
      },
      {
        name: 'LeadRouter',
        role: 'Lead router',
        executionMode: 'reasoning',
        isEntry: true,
      },
      baseDomain,
    );

    expect(scaffold.skeleton.runtimePattern).toBe('router');
    const { yaml } = assembleAblAgent(scaffold.skeleton, {
      goal: 'Route inbound leads to the correct next step based on visitor intent.',
      persona:
        'You are a concise lead-routing assistant. You greet visitors warmly, classify their intent, and hand off to the correct next step while keeping the conversation focused and professional.',
      'gather.routing_intent.ask': 'What can I help route for you today?',
      'handoff.0.when': 'sales_inquiry',
    });

    expect(yaml).toContain('ON_START:');
    expect(yaml).toContain('RESPOND: "Hi. What can I help with?"');
    expect(yaml).toContain('WHEN: routing_intent != null AND (intent.category == "sales_inquiry")');
    expect(yaml).toContain('WHEN: routing_intent != null');
    parseGeneratedAgent('LeadRouter', yaml);
  });

  it('normalizes invented supervisor state variables to intent categories before compile', () => {
    const scaffold = scaffoldAblAgent(
      {
        agentName: 'VoiceDisputeRouter',
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
          reason: 'Reasoning supervisor',
          executionMode: 'reasoning',
        },
        complexity: {
          selectedExecutionMode: 'reasoning',
          level: 'structured',
          reason: 'Supervisor routes by intent categories.',
          signals: ['supervisor_routing'],
        },
        handoffs: {
          targets: [
            {
              to: 'DisputePolicyAgent',
              edgeType: 'delegate',
              returnExpected: true,
              condition: undefined,
            },
          ],
          needsCatchAll: true,
          catchAllTarget: 'DisputePolicyAgent',
        },
        allowedPassFields: [],
        blocked: [],
        localTopology: {
          agents: [
            {
              name: 'VoiceDisputeRouter',
              role: 'Voice dispute router',
              executionMode: 'reasoning',
            },
            {
              name: 'DisputePolicyAgent',
              role: 'Dispute policy specialist',
              executionMode: 'reasoning',
            },
          ],
          edges: [
            {
              from: 'VoiceDisputeRouter',
              to: 'DisputePolicyAgent',
              type: 'delegate',
              returnExpected: true,
            },
          ],
        },
      },
      {
        agents: [
          {
            name: 'VoiceDisputeRouter',
            role: 'Voice dispute router',
            executionMode: 'reasoning',
          },
          {
            name: 'DisputePolicyAgent',
            role: 'Dispute policy specialist',
            executionMode: 'reasoning',
          },
        ],
        edges: [
          {
            from: 'VoiceDisputeRouter',
            to: 'DisputePolicyAgent',
            type: 'delegate',
            expectReturn: true,
          },
        ],
        entryPoint: 'VoiceDisputeRouter',
      },
      {
        name: 'VoiceDisputeRouter',
        role: 'Voice dispute router',
        executionMode: 'reasoning',
        isEntry: true,
      },
      baseDomain,
    );

    expect(scaffold.skeleton.runtimePattern).toBe('router');
    const { yaml } = assembleAblAgent(scaffold.skeleton, {
      goal: 'Route billing dispute callers to the right dispute support path.',
      persona:
        'You are a careful voice dispute router. You classify the caller request and send it to the right specialist while keeping the interaction concise.',
      'gather.routing_intent.ask': 'What billing dispute path should I route this caller to?',
      'handoff.0.when': 'pci_safe_ == true',
    });

    expect(yaml).toContain('WHEN: routing_intent != null AND (intent.category == "pci_safe")');
    expect(yaml).not.toContain('pci_safe_ == true');
  });

  it('normalizes supervisor state-like conditions to intent categories', () => {
    const scaffold = scaffoldAblAgent(
      {
        agentName: 'ClaimsRouter',
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
          recommended: true,
          reason: 'Hybrid router can use deterministic scaffold for safe routing',
          executionMode: 'hybrid',
        },
        complexity: {
          selectedExecutionMode: 'hybrid',
          level: 'complex',
          reason: 'Tool-backed route normalization',
          signals: ['tool_backed'],
        },
        handoffs: {
          targets: [
            {
              to: 'ClaimFilingSpecialist',
              edgeType: 'delegate',
              returnExpected: true,
              condition: 'claim_intent == "file_new_claim"',
            },
          ],
          needsCatchAll: true,
          catchAllTarget: 'ClaimFilingSpecialist',
        },
        allowedPassFields: [],
        blocked: [],
        localTopology: {
          agents: [
            { name: 'ClaimsRouter', role: 'Claims router', executionMode: 'hybrid' },
            {
              name: 'ClaimFilingSpecialist',
              role: 'Claim filing',
              executionMode: 'hybrid',
            },
          ],
          edges: [
            {
              from: 'ClaimsRouter',
              to: 'ClaimFilingSpecialist',
              type: 'delegate',
              expectReturn: true,
            },
          ],
        },
      },
      {
        agents: [
          { name: 'ClaimsRouter', role: 'Claims router', executionMode: 'hybrid' },
          { name: 'ClaimFilingSpecialist', role: 'Claim filing', executionMode: 'hybrid' },
        ],
        edges: [
          {
            from: 'ClaimsRouter',
            to: 'ClaimFilingSpecialist',
            type: 'delegate',
            expectReturn: true,
          },
        ],
        entryPoint: 'ClaimsRouter',
      },
      {
        name: 'ClaimsRouter',
        role: 'Claims router',
        executionMode: 'hybrid',
        isEntry: true,
      },
      baseDomain,
    );

    const { yaml } = assembleAblAgent(scaffold.skeleton, {
      goal: 'Route insurance claim requests to the correct claim specialist.',
      persona:
        'You are a concise insurance claims router. You identify the user intent and route claims to the right specialist.',
      'gather.routing_intent.ask': 'What claim support outcome should I route for you?',
      'handoff.0.when': 'claim_intent == "file_new_claim"',
    });

    expect(yaml).toContain(
      'WHEN: routing_intent != null AND (intent.category == "file_new_claim")',
    );
    expect(yaml).not.toContain('name: claim_intent');
  });

  it('code-owns completion for no-input specialist agents', () => {
    const scaffold = scaffoldAblAgent(
      buildPlan([]),
      {
        agents: [
          {
            name: 'OrderStatusAgent',
            role: 'Order specialist',
            executionMode: 'reasoning',
            description: 'Handles direct order status questions.',
          },
        ],
        edges: [],
        entryPoint: 'OrderStatusAgent',
      },
      {
        name: 'OrderStatusAgent',
        role: 'Order specialist',
        executionMode: 'reasoning',
        description: 'Handles direct order status questions.',
        gatherFields: [],
        isEntry: false,
      },
      baseDomain,
    );

    const parse = scaffold.creativeSchema.safeParse({
      goal: 'Handle direct order status questions and provide concise answers to the user.',
      persona:
        'You are a calm order support specialist. You answer directly, explain status clearly, keep next steps concise, and avoid asking for extra details unless the user explicitly introduces a new issue.',
    });

    expect(parse.success).toBe(true);
    if (!parse.success) {
      throw parse.error;
    }

    const { yaml } = assembleAblAgent(scaffold.skeleton, parse.data);

    expect(yaml).toContain('COMPLETE:');
    expect(yaml).toContain('WHEN: true AND true');
    expect(yaml).toContain('RESPOND: ""');
    expect(yaml).not.toContain('REASON:');
  });

  it('emits code-owned completion WHEN when gather fields exist', () => {
    const scaffold = scaffoldAblAgent(
      buildPlan(['order_number']),
      {
        agents: [
          {
            name: 'OrderStatusAgent',
            role: 'Order specialist',
            executionMode: 'reasoning',
            description: 'Tracks orders.',
          },
        ],
        edges: [],
        entryPoint: 'OrderStatusAgent',
      },
      {
        name: 'OrderStatusAgent',
        role: 'Order specialist',
        executionMode: 'reasoning',
        description: 'Tracks orders.',
        gatherFields: ['order_number'],
        isEntry: false,
      },
      baseDomain,
    );

    const parse = scaffold.creativeSchema.safeParse({
      goal: 'Track the customer order and return once the relevant lookup details are available.',
      persona:
        'You are a focused order tracking specialist. You collect the exact identifier needed for order lookup, confirm what you found, and keep the user informed without adding unrelated steps.',
      gather: {
        'order_number.ask': 'What is the order number you want me to check?',
      },
    });

    expect(parse.success).toBe(true);
    if (!parse.success) {
      throw parse.error;
    }

    const creative = {
      goal: parse.data.goal,
      persona: parse.data.persona,
      'gather.order_number.ask': parse.data.gather['order_number.ask'],
    };
    const { yaml } = assembleAblAgent(scaffold.skeleton, creative);

    expect(yaml).toContain('WHEN: order_number != null');
    expect(yaml).toContain('RESPOND: ""');
    expect(yaml).not.toContain('REASON:');
  });

  it('emits deterministic tool contracts for tool-backed scaffold agents', () => {
    const scaffold = scaffoldAblAgent(
      buildPlan(['claim_number']),
      {
        agents: [
          {
            name: 'OrderStatusAgent',
            role: 'Order specialist',
            executionMode: 'hybrid',
            description: 'Checks status using a backend tool.',
          },
        ],
        edges: [],
        entryPoint: 'OrderStatusAgent',
      },
      {
        name: 'OrderStatusAgent',
        role: 'Order specialist',
        executionMode: 'hybrid',
        description: 'Checks status using a backend tool.',
        tools: ['claims_core.get_status'],
        gatherFields: ['claim_number'],
        isEntry: false,
      },
      baseDomain,
    );

    expect(scaffold.skeleton.runtimePattern).toBe('tool_worker');
    const { yaml } = assembleAblAgent(scaffold.skeleton, {
      goal: 'Check claim status using available claim details and return once the status is ready.',
      persona:
        'You are a careful claim status specialist. You collect the exact claim reference, use available backend contracts when configured, and explain status updates clearly without exposing internal system details.',
      'gather.claim_number.ask': 'What claim number should I use to check the current status?',
    });

    expect(yaml).toContain('TOOLS:');
    expect(yaml).toContain(
      'claims_core_get_status(request: string) -> { summary: string, confidence: number }',
    );
    expect(yaml).toContain('Call when the agent needs fresh claims core get status information');
    expect(yaml).toContain('parameters:\n      request:');
    expect(yaml).toContain('description: "Request value for the claims core get status workflow."');
    expect(yaml).toContain('side_effects: false');
    expect(yaml).toContain('confirm: never');
    expect(yaml).toContain('FLOW:');
    expect(yaml).toContain('CALL: claims_core_get_status');
    expect(yaml).toContain('WITH:\n        request: claim_number');
    expect(yaml).toContain('AS: claimsCoreGetStatusResult');
    expect(yaml).toContain('ON_RESULT:');
    expect(yaml).toContain('- ELSE:');
    expect(yaml).toContain(
      'SET: claims_core_get_status_result_summary = claimsCoreGetStatusResult.summary',
    );
    expect(yaml).toContain(
      'SET: claims_core_get_status_result_confidence = claimsCoreGetStatusResult.confidence',
    );
    expect(yaml).toContain('ON_FAILURE:');
    expect(yaml).toContain('THEN: finalize');
    expect(yaml).toContain('  finalize:');
    expect(yaml).toContain('THEN: COMPLETE');

    const document = parseGeneratedAgent('OrderStatusAgent', yaml);
    const compiled = compileABLtoIR([document], { mode: 'preview' });
    const ir = compiled.agents.OrderStatusAgent;
    expect(validateIR(ir, [ir]).filter((d) => d.code === 'ORPHANED_STEP')).toEqual([]);
    expect(validateIR(ir, [ir]).filter((d) => d.code === 'MISSING_PARAM_DESCRIPTION')).toEqual([]);

    const validation = validateScaffoldConstructPlan({
      skeleton: scaffold.skeleton,
      creative: {
        goal: 'Check claim status using available claim details and return once the status is ready.',
        persona:
          'You are a careful claim status specialist. You collect the exact claim reference, use available backend contracts when configured, and explain status updates clearly without exposing internal system details.',
        'gather.claim_number.ask': 'What claim number should I use to check the current status?',
      },
      executionMode: 'hybrid',
      agentNames: ['OrderStatusAgent'],
    });

    expect(validation.valid).toBe(true);
    expect(validation.plan.toolCalls).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          tool: 'claims_core_get_status',
          with: { request: 'claim_number' },
          as: 'claimsCoreGetStatusResult',
          resultFieldsUsed: [
            'claimsCoreGetStatusResult.summary',
            'claimsCoreGetStatusResult.confidence',
          ],
        }),
      ]),
    );
    expect(validation.plan.flow.map((step) => step.name)).toEqual([
      'call_claims_core_get_status',
      'finalize',
    ]);
  });

  it('keeps read-only classifier tools out of confirmation gates while preserving action confirmations', () => {
    const classifierScaffold = scaffoldAblAgent(
      {
        agentName: 'CarrierCareRouter',
        archetype: 'specialist',
        keyword: 'AGENT',
        isEntry: false,
        gather: {
          required: true,
          reason: 'The agent needs the dispute request before routing.',
          suggestedFields: ['request_text'],
        },
        complete: {
          required: true,
          reason: 'The supervisor expects control to return after classification.',
        },
        flow: {
          recommended: true,
          reason: 'Tool-backed classification.',
          executionMode: 'hybrid',
        },
        complexity: {
          selectedExecutionMode: 'hybrid',
          level: 'structured',
          reason: 'Tool-backed classification.',
          signals: ['return_contract'],
        },
        handoffs: {
          targets: [],
          needsCatchAll: false,
        },
        allowedPassFields: [],
        blocked: [],
        localTopology: {
          agents: [
            {
              name: 'CarrierCareRouter',
              role: 'Carrier care router',
              executionMode: 'hybrid',
            },
          ],
          edges: [],
        },
      },
      {
        agents: [
          {
            name: 'CarrierCareRouter',
            role: 'Carrier care router',
            executionMode: 'hybrid',
          },
        ],
        edges: [],
        entryPoint: 'CarrierCareRouter',
      },
      {
        name: 'CarrierCareRouter',
        role: 'Carrier care router',
        executionMode: 'hybrid',
        tools: ['classify_dispute_type'],
        gatherFields: ['request_text'],
        isEntry: false,
      },
      baseDomain,
    );

    const { yaml: classifierYaml } = assembleAblAgent(classifierScaffold.skeleton, {
      goal: 'Classify the support request and return the routing signal.',
      persona:
        'You are a precise router that classifies customer requests without taking external action.',
      'gather.request_text.ask': 'What kind of billing or identity issue do you need help with?',
    });

    expect(classifierYaml).toContain(
      'classify_dispute_type(text: string) -> { summary: string, confidence: number }',
    );
    expect(classifierYaml).toContain('side_effects: false');
    expect(classifierYaml).toContain('confirm: never');

    const actionScaffold = scaffoldAblAgent(
      {
        ...buildPlan(['customer_id']),
        agentName: 'CallbackScheduler',
        complexity: {
          selectedExecutionMode: 'hybrid',
          level: 'structured',
          reason: 'Schedules customer callbacks.',
          signals: ['return_contract'],
        },
        localTopology: {
          agents: [
            {
              name: 'CallbackScheduler',
              role: 'Callback scheduler',
              executionMode: 'hybrid',
            },
          ],
          edges: [],
        },
      },
      {
        agents: [
          {
            name: 'CallbackScheduler',
            role: 'Callback scheduler',
            executionMode: 'hybrid',
          },
        ],
        edges: [],
        entryPoint: 'CallbackScheduler',
      },
      {
        name: 'CallbackScheduler',
        role: 'Callback scheduler',
        executionMode: 'hybrid',
        tools: ['schedule_supervisor_callback'],
        gatherFields: ['customer_id'],
        isEntry: false,
      },
      baseDomain,
    );

    const { yaml: actionYaml } = assembleAblAgent(actionScaffold.skeleton, {
      goal: 'Schedule a supervisor callback when the customer needs follow-up.',
      persona:
        'You are a careful scheduling specialist that confirms details before creating a callback.',
      'gather.customer_id.ask': 'What customer ID should I use for the callback request?',
    });

    expect(actionYaml).toContain('schedule_supervisor_callback(');
    expect(actionYaml).toContain('side_effects: true');
    expect(actionYaml).toContain('confirm: when_side_effects');
  });

  it('emits distinct runtime handoff conditions for pipeline stages with multiple exits', () => {
    const scaffold = scaffoldAblAgent(
      {
        agentName: 'BillingHistoryVerifier',
        archetype: 'pipeline_stage',
        keyword: 'AGENT',
        isEntry: false,
        gather: {
          required: true,
          reason: 'The stage needs account details before branching.',
          suggestedFields: ['account_id', 'auth_status'],
        },
        complete: {
          required: true,
          reason: 'The parent expects a silent return once the stage is done.',
        },
        flow: {
          recommended: true,
          reason: 'Structured verification stage with downstream branches.',
          executionMode: 'hybrid',
        },
        complexity: {
          selectedExecutionMode: 'hybrid',
          level: 'structured',
          reason: 'Tool-backed branching stage.',
          signals: ['pipeline_stage', 'return_contract'],
        },
        handoffs: {
          targets: [
            {
              to: 'DisputeResolutionSpecialist',
              edgeType: 'delegate',
              returnExpected: true,
              condition: 'auth_status == true',
            },
            {
              to: 'HumanEscalationDesk',
              edgeType: 'escalate',
              returnExpected: true,
              condition: 'auth_status != true',
            },
          ],
          needsCatchAll: false,
        },
        allowedPassFields: [],
        blocked: [],
        localTopology: {
          agents: [
            {
              name: 'BillingHistoryVerifier',
              role: 'Billing history verifier',
              executionMode: 'hybrid',
            },
            {
              name: 'DisputeResolutionSpecialist',
              role: 'Dispute resolution',
              executionMode: 'hybrid',
            },
            {
              name: 'HumanEscalationDesk',
              role: 'Human escalation',
              executionMode: 'scripted',
            },
          ],
          edges: [],
        },
      },
      {
        agents: [
          {
            name: 'BillingHistoryVerifier',
            role: 'Billing history verifier',
            executionMode: 'hybrid',
          },
        ],
        edges: [],
        entryPoint: 'BillingHistoryVerifier',
      },
      {
        name: 'BillingHistoryVerifier',
        role: 'Billing history verifier',
        executionMode: 'hybrid',
        gatherFields: ['account_id', 'auth_status'],
        isEntry: false,
      },
      baseDomain,
    );

    const { yaml } = assembleAblAgent(scaffold.skeleton, {
      goal: 'Verify billing history and route the case to the right next owner.',
      persona:
        'You are a precise billing verifier. You collect account details, check the facts, and route each case to the right downstream owner without over-asking.',
      'gather.account_id.ask': 'What account ID should I use to verify the billing history?',
      'gather.auth_status.ask': 'Has the account authentication step passed?',
    });

    expect(yaml).toContain('WHEN: auth_status == true');
    expect(yaml).toContain('WHEN: auth_status != true');
    expect(yaml.match(/WHEN: true/g)).toBeNull();
  });

  it('keeps fallback pipeline handoff categories distinct for inverse topology hints', () => {
    const scaffold = scaffoldAblAgent(
      {
        agentName: 'AdjusterRoutingAgent',
        archetype: 'pipeline_stage',
        keyword: 'AGENT',
        isEntry: false,
        gather: {
          required: true,
          reason: 'The stage needs claim details before branching.',
          suggestedFields: ['claim_id'],
        },
        complete: {
          required: true,
          reason: 'The parent expects a silent return once the stage is done.',
        },
        flow: {
          recommended: true,
          reason: 'Structured assignment stage with downstream branches.',
          executionMode: 'scripted',
        },
        complexity: {
          selectedExecutionMode: 'scripted',
          level: 'structured',
          reason: 'Tool-backed branching stage.',
          signals: ['pipeline_stage', 'return_contract'],
        },
        handoffs: {
          targets: [
            {
              to: 'PayoutNotificationAgent',
              edgeType: 'delegate',
              returnExpected: true,
              condition: 'assignment_status == "assigned"',
            },
            {
              to: 'HumanEscalationAgent',
              edgeType: 'escalate',
              returnExpected: false,
              condition: 'assignment_status != "assigned"',
            },
          ],
          needsCatchAll: false,
        },
        allowedPassFields: [],
        blocked: [],
        localTopology: {
          agents: [
            {
              name: 'AdjusterRoutingAgent',
              role: 'Adjuster routing',
              executionMode: 'scripted',
            },
            {
              name: 'PayoutNotificationAgent',
              role: 'Payout notification',
              executionMode: 'scripted',
            },
            {
              name: 'HumanEscalationAgent',
              role: 'Human escalation',
              executionMode: 'scripted',
            },
          ],
          edges: [],
        },
      },
      {
        agents: [
          {
            name: 'AdjusterRoutingAgent',
            role: 'Adjuster routing',
            executionMode: 'scripted',
          },
        ],
        edges: [],
        entryPoint: 'AdjusterRoutingAgent',
      },
      {
        name: 'AdjusterRoutingAgent',
        role: 'Adjuster routing',
        executionMode: 'scripted',
        gatherFields: ['claim_id'],
        isEntry: false,
      },
      baseDomain,
    );

    const { yaml } = assembleAblAgent(scaffold.skeleton, {
      goal: 'Assign claims to the right adjuster queue and route the outcome.',
      persona:
        'You are a precise adjuster routing specialist. You collect the claim reference, complete assignment work, and route the outcome without inventing claim facts.',
      'gather.claim_id.ask': 'What claim ID should I use for adjuster routing?',
    });

    expect(yaml).toContain('WHEN: intent.category == "assigned"');
    expect(yaml).toContain('WHEN: intent.category == "not_assigned"');
  });

  it('uses transaction runtime patterns for side-effecting tool workflows', () => {
    const scaffold = scaffoldAblAgent(
      buildPlan(['order_number']),
      {
        agents: [
          {
            name: 'OrderStatusAgent',
            role: 'Refund transaction specialist',
            executionMode: 'hybrid',
            description: 'Submits approved refunds using a backend workflow.',
          },
        ],
        edges: [],
        entryPoint: 'OrderStatusAgent',
      },
      {
        name: 'OrderStatusAgent',
        role: 'Refund transaction specialist',
        executionMode: 'hybrid',
        description: 'Submits approved refunds using a backend workflow.',
        tools: ['refunds.submit_refund'],
        gatherFields: ['order_number'],
        isEntry: false,
      },
      baseDomain,
    );

    expect(scaffold.skeleton.runtimePattern).toBe('transaction');
    const { yaml } = assembleAblAgent(scaffold.skeleton, {
      goal: 'Submit eligible refunds after validating the required order details.',
      persona:
        'You are a careful refunds specialist. You validate required details, use configured refund tools only when appropriate, and explain outcomes without exposing internal implementation details.',
      'gather.order_number.ask': 'What order number should I use for the refund request?',
    });

    expect(yaml).toContain(
      'refunds_submit_refund(order_id: string, reason: string) -> { success: boolean, refund_id: string, refund_eta: string }',
    );
    expect(yaml).toContain('Call when the customer has chosen or approved');
    expect(yaml).toContain('side_effects: true');
    expect(yaml).toContain('confirm: when_side_effects');
    expect(yaml).toContain('REASONING: true');
    expect(yaml).toContain('THEN: COMPLETE');
    expect(yaml).not.toContain('reason: order_number');
    expectGeneratedAgentsCompile([{ name: 'OrderStatusAgent', yaml }]);
  });

  it('uses escalation runtime patterns for human handoff specialists', () => {
    const scaffold = scaffoldAblAgent(
      buildPlan(['case_summary']),
      {
        agents: [
          {
            name: 'OrderStatusAgent',
            role: 'Human escalation specialist',
            executionMode: 'hybrid',
            description: 'Packages support exceptions for human review.',
          },
        ],
        edges: [],
        entryPoint: 'OrderStatusAgent',
      },
      {
        name: 'OrderStatusAgent',
        role: 'Human escalation specialist',
        executionMode: 'hybrid',
        description: 'Packages support exceptions for human review.',
        gatherFields: ['case_summary'],
        isEntry: false,
      },
      baseDomain,
    );

    expect(scaffold.skeleton.runtimePattern).toBe('escalation');
    const validation = validateScaffoldConstructPlan({
      skeleton: scaffold.skeleton,
      creative: {
        goal: 'Package exception cases for human support review.',
        persona:
          'You are a calm escalation specialist. You summarize the issue, preserve the key facts, and prepare human reviewers with clear next steps.',
        'gather.case_summary.ask': 'What should I include in the human escalation summary?',
      },
      executionMode: 'hybrid',
      agentNames: ['OrderStatusAgent'],
    });

    expect(validation.valid).toBe(true);
    expect(validation.plan.rationale).toContain('Runtime pattern: escalation.');
  });

  it('normalizes supervisor state-like routing hints instead of declaring unpopulated state', () => {
    const scaffold = scaffoldAblAgent(
      {
        agentName: 'ClaimsRouter',
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
          recommended: true,
          reason: 'Hybrid router can use deterministic scaffold for safe routing',
          executionMode: 'hybrid',
        },
        complexity: {
          selectedExecutionMode: 'hybrid',
          level: 'complex',
          reason: 'Tool-backed route normalization',
          signals: ['tool_backed'],
        },
        handoffs: {
          targets: [
            {
              to: 'ClaimFilingSpecialist',
              edgeType: 'delegate',
              returnExpected: true,
              condition: 'claim_intent == "file_new_claim" AND consent_to_process_pii == true',
            },
          ],
          needsCatchAll: true,
          catchAllTarget: 'ClaimFilingSpecialist',
        },
        allowedPassFields: [],
        blocked: [],
        localTopology: {
          agents: [
            { name: 'ClaimsRouter', role: 'Claims router', executionMode: 'hybrid' },
            {
              name: 'ClaimFilingSpecialist',
              role: 'Claim filing',
              executionMode: 'hybrid',
            },
          ],
          edges: [
            {
              from: 'ClaimsRouter',
              to: 'ClaimFilingSpecialist',
              type: 'delegate',
              expectReturn: true,
            },
          ],
        },
      },
      {
        agents: [
          { name: 'ClaimsRouter', role: 'Claims router', executionMode: 'hybrid' },
          { name: 'ClaimFilingSpecialist', role: 'Claim filing', executionMode: 'hybrid' },
        ],
        edges: [
          {
            from: 'ClaimsRouter',
            to: 'ClaimFilingSpecialist',
            type: 'delegate',
            expectReturn: true,
          },
        ],
        entryPoint: 'ClaimsRouter',
      },
      {
        name: 'ClaimsRouter',
        role: 'Claims router',
        executionMode: 'hybrid',
        tools: ['claims_core.lookup'],
        isEntry: true,
      },
      baseDomain,
    );

    const { yaml } = assembleAblAgent(scaffold.skeleton, {
      goal: 'Route insurance claim requests to the correct claim specialist.',
      persona:
        'You are a concise insurance claims router. You identify the user intent, keep personal information handling minimal, and send each request to the right specialist while staying calm and precise.',
      'gather.routing_intent.ask': 'What claim support outcome should I route for you?',
      'handoff.0.when': 'claim_intent == "file_new_claim" AND consent_to_process_pii == true',
    });

    expect(yaml).toContain(
      'claims_core_lookup(request: string) -> { summary: string, confidence: number }',
    );
    expect(yaml).toContain(
      'WHEN: routing_intent != null AND (intent.category == "file_new_claim")',
    );
    expect(yaml).not.toContain('name: claim_intent');
    expect(yaml).not.toContain('name: consent_to_process_pii');
    expect(yaml).not.toContain('FLOW:');

    const validation = validateScaffoldConstructPlan({
      skeleton: scaffold.skeleton,
      creative: {
        goal: 'Route insurance claim requests to the correct claim specialist.',
        persona:
          'You are a concise insurance claims router. You identify the user intent, keep personal information handling minimal, and send each request to the right specialist while staying calm and precise.',
        'gather.routing_intent.ask': 'What claim support outcome should I route for you?',
        'handoff.0.when': 'claim_intent == "file_new_claim" AND consent_to_process_pii == true',
      },
      executionMode: 'hybrid',
      agentNames: ['ClaimsRouter', 'ClaimFilingSpecialist'],
    });

    expect(validation.valid).toBe(true);
    expect(validation.plan.tools).toHaveLength(1);
    expect(validation.plan.toolCalls).toEqual([]);
    expect(validation.plan.flow).toEqual([]);
    expectGeneratedAgentsCompile([
      { name: 'ClaimsRouter', yaml },
      {
        name: 'ClaimFilingSpecialist',
        yaml: [
          'AGENT: ClaimFilingSpecialist',
          'GOAL: "Handle claim filing requests."',
          'PERSONA: |',
          '  You are a claim filing specialist.',
          'COMPLETE:',
          '  - WHEN: true',
          '    RESPOND: ""',
          'MEMORY:',
          '  session:',
          '    - name: claim_id',
          '      type: string',
          '      initial_value: null',
        ].join('\n'),
      },
    ]);
  });

  it('validates scaffold output as a runtime construct plan before compile', () => {
    const scaffold = scaffoldAblAgent(
      buildPlan(['order_number']),
      {
        agents: [
          {
            name: 'OrderStatusAgent',
            role: 'Order specialist',
            executionMode: 'reasoning',
          },
        ],
        edges: [],
        entryPoint: 'OrderStatusAgent',
      },
      {
        name: 'OrderStatusAgent',
        role: 'Order specialist',
        executionMode: 'reasoning',
        gatherFields: ['order_number'],
        isEntry: false,
      },
      baseDomain,
    );

    const validation = validateScaffoldConstructPlan({
      skeleton: scaffold.skeleton,
      creative: {
        goal: 'Track a customer order and return once required order details are present.',
        persona:
          'You are a precise order support specialist. You ask only for the order reference needed, keep the user informed, and return cleanly when the required detail is available.',
        'gather.order_number.ask': 'What order number should I use to check the shipment status?',
      },
      executionMode: 'reasoning',
      agentNames: ['OrderStatusAgent'],
    });

    expect(validation.valid).toBe(true);
    expect(validation.issues).toEqual([]);
    expect(validation.plan.gathers).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: 'order_number' })]),
    );
    expect(validation.plan.completion[0]?.when).toBe('order_number != null');
  });

  it('ignores user-provided completion slots because scaffold completion is code-owned', () => {
    const scaffold = scaffoldAblAgent(
      buildPlan(['order_number']),
      {
        agents: [
          {
            name: 'OrderStatusAgent',
            role: 'Order specialist',
            executionMode: 'reasoning',
          },
        ],
        edges: [],
        entryPoint: 'OrderStatusAgent',
      },
      {
        name: 'OrderStatusAgent',
        role: 'Order specialist',
        executionMode: 'reasoning',
        gatherFields: ['order_number'],
        isEntry: false,
      },
      baseDomain,
    );

    const validation = validateScaffoldConstructPlan({
      skeleton: scaffold.skeleton,
      creative: {
        goal: 'Track a customer order and return once required order details are present.',
        persona:
          'You are a precise order support specialist. You ask only for the order reference needed, keep the user informed, and return cleanly when the required detail is available.',
        'gather.order_number.ask': 'What order number should I use to check the shipment status?',
        'complete.0.when': 'tracking_status != null',
      },
      executionMode: 'reasoning',
      agentNames: ['OrderStatusAgent'],
    });

    expect(validation.valid).toBe(true);
    expect(validation.issues).toEqual([]);
    expect(validation.plan.completion[0]?.when).toBe('order_number != null');
  });
});
