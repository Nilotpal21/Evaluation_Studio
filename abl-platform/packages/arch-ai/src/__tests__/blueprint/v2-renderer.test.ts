import { describe, expect, it } from 'vitest';
import { parseAgentBasedABL } from '@abl/core';
import { compileABLtoIR } from '@abl/compiler';

import {
  BLUEPRINT_BATTLE_TEST_FIXTURES,
  renderProjectFromBlueprint,
  validateBlueprintV2Output,
} from '../../blueprint/index.js';
import { DEFAULT_ARCH_MODEL_POLICY_DEFAULTS } from '../../model-policy.js';

describe('Blueprint v2 renderer', () => {
  it('validates and renders 10 battle-test blueprints into parseable, compilable projects', () => {
    expect(BLUEPRINT_BATTLE_TEST_FIXTURES).toHaveLength(10);

    for (const blueprint of BLUEPRINT_BATTLE_TEST_FIXTURES) {
      const issues = validateBlueprintV2Output(blueprint);
      expect(issues, blueprint.metadata.projectName).toEqual([]);

      const rendered = renderProjectFromBlueprint(blueprint);
      expect(rendered.agents).toHaveLength(blueprint.topology.agents.length);
      expect(rendered.entryAgentName).toBe(blueprint.topology.entryPoint);
      expect(rendered.markdown).toContain(`# ${blueprint.metadata.projectName} Blueprint`);
      expect(rendered.markdown.match(/^## \d+\./gm), blueprint.metadata.projectName).toHaveLength(
        17,
      );
      expect(rendered.markdown).toContain('## 17. Configuration Checklist');

      const profileDocuments = rendered.behaviorProfiles.map((profile) => {
        expect(profile.dslContent).toContain(`BEHAVIOR_PROFILE: ${profile.name}`);
        const parsed = parseAgentBasedABL(profile.dslContent);
        expect(parsed.errors, `${blueprint.metadata.projectName}:${profile.name}`).toEqual([]);
        expect(parsed.document, `${blueprint.metadata.projectName}:${profile.name}`).toBeTruthy();
        return parsed.document!;
      });

      const documents = rendered.agents.map((agent) => {
        expect(agent.dslContent).toContain(`AGENT: ${agent.name}`);
        expect(agent.dslContent).toContain(
          `EXECUTION:\n  model: ${DEFAULT_ARCH_MODEL_POLICY_DEFAULTS.fastToolCapable}`,
        );
        expect(agent.dslContent).toContain('COMPLETE:');
        expect(agent.dslContent).not.toMatch(/WHEN:\s*"[^"\n]*(?:==|!=|AND|OR|>|<)/);

        const parsed = parseAgentBasedABL(agent.dslContent);
        expect(parsed.errors, `${blueprint.metadata.projectName}:${agent.name}`).toEqual([]);
        expect(parsed.document, `${blueprint.metadata.projectName}:${agent.name}`).toBeTruthy();
        return parsed.document!;
      });

      const compiled = compileABLtoIR([...documents, ...profileDocuments], { mode: 'preview' });
      expect(compiled.errors ?? [], blueprint.metadata.projectName).toEqual([]);
      for (const agent of rendered.agents) {
        expect(
          compiled.agents[agent.name],
          `${blueprint.metadata.projectName}:${agent.name}`,
        ).toBeTruthy();
        expect(compiled.agents[agent.name].execution.model).toBe(
          DEFAULT_ARCH_MODEL_POLICY_DEFAULTS.fastToolCapable,
        );
      }
    }
  });

  it('keeps optional model policy as pass-through intent instead of selecting reasoning', () => {
    const blueprint = structuredClone(BLUEPRINT_BATTLE_TEST_FIXTURES[0]);
    const agentName = blueprint.topology.entryPoint;
    blueprint.perAgent[agentName]!.modelPolicy = {
      agentType: 'reasoning',
    };

    const rendered = renderProjectFromBlueprint(blueprint);
    const agent = rendered.agents.find((candidate) => candidate.name === agentName);

    expect(agent?.dslContent).toContain(
      `EXECUTION:\n  model: ${DEFAULT_ARCH_MODEL_POLICY_DEFAULTS.fastToolCapable}`,
    );

    const parsed = parseAgentBasedABL(agent!.dslContent);
    expect(parsed.errors).toEqual([]);
    const compiled = compileABLtoIR([parsed.document!], { mode: 'preview' });
    expect(compiled.agents[agentName].execution.model).toBe(
      DEFAULT_ARCH_MODEL_POLICY_DEFAULTS.fastToolCapable,
    );
  });

  it('uses blueprint model defaults before package defaults', () => {
    const blueprint = structuredClone(BLUEPRINT_BATTLE_TEST_FIXTURES[0]);
    const agentName = blueprint.topology.entryPoint;
    blueprint.modelDefaults = {
      fastToolCapable: 'tenant-fast-support-model',
      reasoning: 'tenant-reasoning-model',
      research: 'tenant-research-model',
    };

    const rendered = renderProjectFromBlueprint(blueprint);
    const agent = rendered.agents.find((candidate) => candidate.name === agentName);

    expect(agent?.dslContent).toContain('EXECUTION:\n  model: tenant-fast-support-model');
  });

  it('lets render options override blueprint model defaults', () => {
    const blueprint = structuredClone(BLUEPRINT_BATTLE_TEST_FIXTURES[0]);
    const agentName = blueprint.topology.entryPoint;
    blueprint.modelDefaults = {
      fastToolCapable: 'blueprint-fast-support-model',
    };

    const rendered = renderProjectFromBlueprint(blueprint, {
      modelDefaults: { fastToolCapable: 'caller-fast-support-model' },
    });
    const agent = rendered.agents.find((candidate) => candidate.name === agentName);

    expect(agent?.dslContent).toContain('EXECUTION:\n  model: caller-fast-support-model');
  });

  it('preserves an explicit blueprint model over inferred defaults', () => {
    const blueprint = structuredClone(BLUEPRINT_BATTLE_TEST_FIXTURES[0]);
    const agentName = blueprint.topology.entryPoint;
    blueprint.perAgent[agentName]!.model = 'anthropic/claude-sonnet-4-5-20250929';
    blueprint.perAgent[agentName]!.modelPolicy = {
      agentType: 'support',
      reasoningRequired: false,
      defaultModelClass: 'fast_tool_capable',
    };

    const rendered = renderProjectFromBlueprint(blueprint);
    const agent = rendered.agents.find((candidate) => candidate.name === agentName);

    expect(agent?.dslContent).toContain(
      'EXECUTION:\n  model: anthropic/claude-sonnet-4-5-20250929',
    );
  });

  it('renders consent-aware confirmation metadata for side-effecting tools', () => {
    const blueprint = structuredClone(BLUEPRINT_BATTLE_TEST_FIXTURES[0]);
    const agentName = blueprint.topology.entryPoint;
    blueprint.perAgent[agentName]!.tools = [
      {
        ref: 'issue_refund',
        purpose: 'Issue a customer refund after the customer chooses that option.',
        signature: 'issue_refund(order_id: string, refund_amount: number) -> { refund_id: string }',
        description: 'Issue an approved refund.',
        sideEffects: true,
      },
    ];

    const rendered = renderProjectFromBlueprint(blueprint);
    const agent = rendered.agents.find((candidate) => candidate.name === agentName);

    expect(agent?.dslContent).toContain('side_effects: true');
    expect(agent?.dslContent).toContain('confirm: when_side_effects');
    expect(agent?.dslContent).toContain('immutable: [order_id, refund_amount]');
    expect(agent?.dslContent).toContain('consent_required_in: conversation');
    expect(agent?.dslContent).toContain('consent_scope: [order_id, refund_amount]');
    expect(agent?.dslContent).toContain('consent_action: "refund"');
    expect(agent?.dslContent).toContain('consent_fallback: explicit_prompt');

    const parsed = parseAgentBasedABL(agent!.dslContent);
    expect(parsed.errors).toEqual([]);
    const compiled = compileABLtoIR([parsed.document!], { mode: 'preview' });
    const tool = compiled.agents[agentName].tools?.find(
      (candidate) => candidate.name === 'issue_refund',
    );

    expect(tool?.confirmation).toEqual({
      require: 'when_side_effects',
      immutable_params: ['order_id', 'refund_amount'],
      consent_required_in: 'conversation',
      consent_scope: ['order_id', 'refund_amount'],
      consent_action: 'refund',
      consent_fallback: 'explicit_prompt',
    });
  });

  it('uses source-contract consent policy when the blueprint omits tool confirmation', () => {
    const blueprint = structuredClone(BLUEPRINT_BATTLE_TEST_FIXTURES[0]);
    const agentName = blueprint.topology.entryPoint;
    blueprint.perAgent[agentName]!.tools = [
      {
        ref: 'create_replacement',
        purpose: 'Create an expedited replacement after the customer chooses it.',
        signature:
          'create_replacement(order_id: string, replacement_sku: string) -> { replacement_id: string }',
        description: 'Create the replacement shipment.',
        sideEffects: true,
      },
    ];

    const rendered = renderProjectFromBlueprint(blueprint, {
      sourceContract: {
        sourceFiles: ['voltmart-sop.md'],
        declaredAgents: [],
        channels: [],
        requiredMcpServers: [],
        sharedMemoryVariables: [],
        universalRules: [],
        guardrails: [],
        tools: [],
        consentPolicies: [
          {
            toolName: 'create_replacement',
            action: 'expedited replacement',
            mode: 'when_side_effects',
            requiredIn: 'conversation',
            scopeFields: ['order_id', 'replacement_sku'],
            fallback: 'block',
            provenance: { fileName: 'voltmart-sop.md', section: 'Resolution consent' },
          },
        ],
        optionalExternalAgents: [],
        confidence: 0.9,
      },
    });
    const agent = rendered.agents.find((candidate) => candidate.name === agentName);

    expect(agent?.dslContent).toContain('side_effects: true');
    expect(agent?.dslContent).toContain('confirm: when_side_effects');
    expect(agent?.dslContent).toContain('immutable: [order_id, replacement_sku]');
    expect(agent?.dslContent).toContain('consent_required_in: conversation');
    expect(agent?.dslContent).toContain('consent_scope: [order_id, replacement_sku]');
    expect(agent?.dslContent).toContain('consent_action: "expedited replacement"');
    expect(agent?.dslContent).toContain('consent_fallback: block');

    const parsed = parseAgentBasedABL(agent!.dslContent);
    expect(parsed.errors).toEqual([]);
    const compiled = compileABLtoIR([parsed.document!], { mode: 'preview' });
    const tool = compiled.agents[agentName].tools?.find(
      (candidate) => candidate.name === 'create_replacement',
    );

    expect(tool?.confirmation).toEqual({
      require: 'when_side_effects',
      immutable_params: ['order_id', 'replacement_sku'],
      consent_required_in: 'conversation',
      consent_scope: ['order_id', 'replacement_sku'],
      consent_action: 'expedited replacement',
      consent_fallback: 'block',
    });
  });

  it('uses source-contract tool signatures and call guidance when blueprint tools are sparse', () => {
    const blueprint = structuredClone(BLUEPRINT_BATTLE_TEST_FIXTURES[0]);
    const agentName = blueprint.topology.entryPoint;
    blueprint.perAgent[agentName]!.tools = [
      {
        ref: 'get_order',
        purpose: 'Look up order state before recommending resolution options.',
      },
    ];

    const rendered = renderProjectFromBlueprint(blueprint, {
      sourceContract: {
        sourceFiles: ['voltmart-sop.md'],
        declaredAgents: [],
        channels: [],
        requiredMcpServers: [],
        sharedMemoryVariables: [],
        universalRules: [],
        guardrails: [],
        tools: [
          {
            name: 'get_order',
            signature:
              'get_order(order_id: string, customer_id: string) -> { status: string, carrier: string }',
            description: 'Fetch the latest order state.',
            callWhen: [
              'customer asks about delivery status',
              'supervisor needs eligibility context',
            ],
            doNotCallWhen: ['a fresh order result already exists this turn'],
            provenance: { fileName: 'voltmart-sop.md', section: 'Tool Catalog' },
          },
        ],
        optionalExternalAgents: [],
        confidence: 0.9,
      },
    });
    const agent = rendered.agents.find((candidate) => candidate.name === agentName);

    expect(agent?.dslContent).toContain(
      'get_order(order_id: string, customer_id: string) -> { status: string, carrier: string }',
    );
    expect(agent?.dslContent).toContain(
      'description: "Fetch the latest order state. Call when customer asks about delivery status; supervisor needs eligibility context. Do not call when a fresh order result already exists this turn."',
    );

    const parsed = parseAgentBasedABL(agent!.dslContent);
    expect(parsed.errors).toEqual([]);
  });

  it('lets source-contract tool contracts replace generic blueprint placeholders', () => {
    const blueprint = structuredClone(BLUEPRINT_BATTLE_TEST_FIXTURES[0]);
    const agentName = blueprint.topology.entryPoint;
    blueprint.perAgent[agentName]!.tools = [
      {
        ref: 'get_order',
        purpose: 'Look up order state before recommending resolution options.',
        signature: 'get_order(input: string) -> { result: string }',
        description: 'Look up get order details and return a concise summary.',
      },
    ];

    const rendered = renderProjectFromBlueprint(blueprint, {
      sourceContract: {
        sourceFiles: ['voltmart-sop.md'],
        declaredAgents: [],
        channels: [],
        requiredMcpServers: [],
        sharedMemoryVariables: [],
        universalRules: [],
        guardrails: [],
        tools: [
          {
            name: 'get_order',
            signature:
              'get_order(order_id: string, customer_id: string) -> { order_id: string, status: string, carrier: string }',
            description: 'Fetch the latest order state.',
            callWhen: ['customer asks about delivery status'],
            doNotCallWhen: ['a fresh order result already exists this turn'],
            provenance: { fileName: 'voltmart-sop.md', section: 'Tool Catalog' },
          },
        ],
        optionalExternalAgents: [],
        confidence: 0.9,
      },
    });
    const agent = rendered.agents.find((candidate) => candidate.name === agentName);

    expect(agent?.dslContent).toContain(
      'get_order(order_id: string, customer_id: string) -> { order_id: string, status: string, carrier: string }',
    );
    expect(agent?.dslContent).toContain(
      'description: "Fetch the latest order state. Call when customer asks about delivery status. Do not call when a fresh order result already exists this turn."',
    );
    expect(agent?.dslContent).not.toContain('input: string');
    expect(agent?.dslContent).not.toContain('Look up get order details');
  });

  it('normalizes namespaced source-contract tool signatures for ABL emission', () => {
    const blueprint = structuredClone(BLUEPRINT_BATTLE_TEST_FIXTURES[0]);
    const agentName = blueprint.topology.entryPoint;
    blueprint.perAgent[agentName]!.tools = [
      {
        ref: 'claims_core.get_status',
        purpose: 'Fetch claim status from the claims core.',
      },
    ];

    const rendered = renderProjectFromBlueprint(blueprint, {
      sourceContract: {
        sourceFiles: ['claims-sop.md'],
        declaredAgents: [],
        channels: [],
        requiredMcpServers: [],
        sharedMemoryVariables: [],
        universalRules: [],
        guardrails: [],
        tools: [
          {
            name: 'claims_core.get_status',
            signature:
              'claims_core.get_status(claim_id: string, customer_id: string) -> { claim_id: string, status: string }',
            description: 'Fetch claim status from the claims core.',
            provenance: { fileName: 'claims-sop.md', section: 'Tool Catalog' },
          },
        ],
        optionalExternalAgents: [],
        confidence: 0.9,
      },
    });
    const agent = rendered.agents.find((candidate) => candidate.name === agentName);

    expect(agent?.dslContent).toContain(
      'claims_core_get_status(claim_id: string, customer_id: string) -> { claim_id: string, status: string }',
    );

    const parsed = parseAgentBasedABL(agent!.dslContent);
    expect(parsed.errors).toEqual([]);
  });

  it('keeps explicit blueprint confirmation ahead of source-contract consent policy', () => {
    const blueprint = structuredClone(BLUEPRINT_BATTLE_TEST_FIXTURES[0]);
    const agentName = blueprint.topology.entryPoint;
    blueprint.perAgent[agentName]!.tools = [
      {
        ref: 'issue_refund',
        purpose: 'Issue a refund after the customer chooses it.',
        signature: 'issue_refund(order_id: string, refund_amount: number) -> { refund_id: string }',
        description: 'Issue the refund.',
        sideEffects: true,
        confirmation: {
          require: 'never',
        },
      },
    ];

    const rendered = renderProjectFromBlueprint(blueprint, {
      sourceContract: {
        sourceFiles: ['voltmart-sop.md'],
        declaredAgents: [],
        channels: [],
        requiredMcpServers: [],
        sharedMemoryVariables: [],
        universalRules: [],
        guardrails: [],
        tools: [],
        consentPolicies: [
          {
            toolName: 'issue_refund',
            action: 'refund',
            mode: 'always',
            requiredIn: 'explicit_prompt',
            scopeFields: ['order_id', 'refund_amount'],
            fallback: 'block',
            provenance: { fileName: 'voltmart-sop.md' },
          },
        ],
        optionalExternalAgents: [],
        confidence: 0.9,
      },
    });
    const agent = rendered.agents.find((candidate) => candidate.name === agentName);

    expect(agent?.dslContent).toContain('confirm: never');
    expect(agent?.dslContent).not.toContain('consent_action: "refund"');
    expect(agent?.dslContent).not.toContain('consent_fallback: block');
  });

  it('does not mark read-only tools side-effecting when confirmation is explicitly disabled', () => {
    const blueprint = structuredClone(BLUEPRINT_BATTLE_TEST_FIXTURES[0]);
    const agentName = blueprint.topology.entryPoint;
    blueprint.perAgent[agentName]!.tools = [
      {
        ref: 'get_order',
        purpose: 'Look up order status before offering replacement or refund options.',
        signature: 'get_order(order_id: string) -> { status: string }',
        description: 'Fetch order status.',
        confirmation: { require: 'never' },
      },
    ];

    const rendered = renderProjectFromBlueprint(blueprint);
    const agent = rendered.agents.find((candidate) => candidate.name === agentName);

    expect(agent?.dslContent).toContain('confirm: never');
    expect(agent?.dslContent).not.toContain('side_effects: true');
    expect(agent?.dslContent).not.toContain('consent_required_in: conversation');
  });

  it('uses source consent policies as side-effect evidence for ambiguous write tools', () => {
    const blueprint = structuredClone(BLUEPRINT_BATTLE_TEST_FIXTURES[0]);
    const agentName = blueprint.topology.entryPoint;
    blueprint.perAgent[agentName]!.tools = [
      {
        ref: 'reserve_inventory',
        purpose: 'Reserve inventory after customer approval.',
        signature: 'reserve_inventory(order_id: string, sku: string) -> { reservation_id: string }',
        description: 'Reserve inventory.',
      },
    ];

    const rendered = renderProjectFromBlueprint(blueprint, {
      sourceContract: {
        sourceFiles: ['fulfillment-sop.md'],
        declaredAgents: [],
        channels: [],
        requiredMcpServers: [],
        sharedMemoryVariables: [],
        universalRules: [],
        guardrails: [],
        tools: [],
        consentPolicies: [
          {
            toolName: 'reserve_inventory',
            action: 'inventory reservation',
            mode: 'when_side_effects',
            requiredIn: 'explicit_prompt',
            scopeFields: ['order_id', 'sku'],
            fallback: 'block',
            provenance: { fileName: 'fulfillment-sop.md' },
          },
        ],
        optionalExternalAgents: [],
        confidence: 0.9,
      },
    });
    const agent = rendered.agents.find((candidate) => candidate.name === agentName);

    expect(agent?.dslContent).toContain('side_effects: true');
    expect(agent?.dslContent).toContain('confirm: when_side_effects');
    expect(agent?.dslContent).toContain('consent_required_in: explicit_prompt');
    expect(agent?.dslContent).toContain('consent_action: "inventory reservation"');
  });

  it('does not render relationship handoffs as duplicate tools', () => {
    const blueprint = structuredClone(BLUEPRINT_BATTLE_TEST_FIXTURES[0]);
    const agentName = blueprint.topology.entryPoint;
    blueprint.perAgent[agentName]!.tools = [
      {
        ref: 'consult_claim_intake',
        purpose: 'Consult the claim intake agent.',
        signature: 'consult_claim_intake(claim_id: string) -> { summary: string }',
        description: 'Duplicate relationship surface.',
      },
      {
        ref: 'delegate_to_fraud_review',
        purpose: 'Delegate to the fraud review agent.',
        signature: 'delegate_to_fraud_review(claim_id: string) -> { summary: string }',
        description: 'Duplicate relationship surface.',
      },
      {
        ref: 'lookup_claim',
        purpose: 'Look up claim status.',
        signature: 'lookup_claim(claim_id: string) -> { status: string }',
        description: 'Look up claim status.',
      },
    ];

    const rendered = renderProjectFromBlueprint(blueprint);
    const agent = rendered.agents.find((candidate) => candidate.name === agentName);

    expect(agent?.dslContent).not.toContain('consult_claim_intake');
    expect(agent?.dslContent).not.toContain('delegate_to_fraud_review');
    expect(agent?.dslContent).toContain('lookup_claim(claim_id: string)');
  });

  it('attaches shared-voice continuity as a behavior profile for customer-facing handoff targets', () => {
    const blueprint = structuredClone(BLUEPRINT_BATTLE_TEST_FIXTURES[0]);
    const edge = blueprint.topology.edges[0];

    expect(edge).toBeDefined();
    if (!edge) return;

    edge.experienceMode = 'shared_voice_handoff';
    const rendered = renderProjectFromBlueprint(blueprint);
    const target = rendered.agents.find((candidate) => candidate.name === edge.to);
    const source = rendered.agents.find((candidate) => candidate.name === edge.from);
    const profile = rendered.behaviorProfiles.find(
      (candidate) => candidate.name === 'shared_voice_handoff',
    );

    expect(target?.dslContent).toContain('USE BEHAVIOR_PROFILE: shared_voice_handoff');
    expect(source?.dslContent).not.toContain('USE BEHAVIOR_PROFILE: shared_voice_handoff');
    expect(source?.dslContent).toContain('EXPERIENCE_MODE: shared_voice_handoff');
    expect(profile?.dslContent).toContain(
      "Continue the customer's existing conversation in the same brand voice.",
    );
    expect(profile?.dslContent).toContain('Do not introduce yourself as a new person');
    expect(profile?.dslContent).toContain(
      'For voice, keep the first continuation short and natural.',
    );
    expect(profile?.dslContent).toContain(
      'Before longer lookups or actions, use one brief customer-facing bridge phrase; never mention tools, workflows, prompts, systems, or internal handoffs.',
    );
    expect(profile?.dslContent).toContain(
      'For messaging channels, keep replies concise and easy to scan.',
    );
    expect(profile?.dslContent).toContain(
      'Maintain this shared tone across agents: professional, clear.',
    );

    const parsedTarget = parseAgentBasedABL(target!.dslContent);
    expect(parsedTarget.errors).toEqual([]);
    const profileDocuments = rendered.behaviorProfiles.map((candidate) => {
      const parsedProfile = parseAgentBasedABL(candidate.dslContent);
      expect(parsedProfile.errors, candidate.name).toEqual([]);
      return parsedProfile.document!;
    });

    const compiled = compileABLtoIR([parsedTarget.document!, ...profileDocuments], {
      mode: 'preview',
    });
    expect(compiled.errors ?? []).toEqual([]);
    expect(compiled.agents[edge.to].behavior_profiles?.map((item) => item.name)).toContain(
      'shared_voice_handoff',
    );
  });

  it('uses source-contract channel rules when rendering shared-voice profiles', () => {
    const blueprint = structuredClone(BLUEPRINT_BATTLE_TEST_FIXTURES[0]);
    const edge = blueprint.topology.edges[0];

    expect(edge).toBeDefined();
    if (!edge) return;

    blueprint.specification.channels = [];
    edge.experienceMode = 'shared_voice_handoff';

    const rendered = renderProjectFromBlueprint(blueprint, {
      sourceContract: {
        sourceFiles: ['voltmart-sop.md'],
        declaredAgents: [],
        channels: ['Voice'],
        requiredMcpServers: [],
        sharedMemoryVariables: [],
        universalRules: [],
        guardrails: [],
        tools: [],
        channelRules: [
          {
            channel: 'Web Chat',
            responseMaxWords: 35,
            toolLatencyBridge: true,
            rules: ['Keep messages concise.'],
            provenance: { fileName: 'voltmart-sop.md', section: 'Channels' },
          },
        ],
        optionalExternalAgents: [],
        confidence: 0.9,
      },
    });
    const profile = rendered.behaviorProfiles.find(
      (candidate) => candidate.name === 'shared_voice_handoff',
    );

    expect(profile?.dslContent).toContain(
      'For voice, keep the first continuation short and natural.',
    );
    expect(profile?.dslContent).toContain(
      'For messaging channels, keep replies concise and easy to scan.',
    );
  });

  it('generates source-contract voice and empathy profiles for customer-facing agents', () => {
    const blueprint = structuredClone(BLUEPRINT_BATTLE_TEST_FIXTURES[0]);
    const rendered = renderProjectFromBlueprint(blueprint, {
      sourceContract: {
        sourceFiles: ['voltmart-sop.md'],
        declaredAgents: [],
        channels: ['Web Chat', 'Voice'],
        requiredMcpServers: [],
        sharedMemoryVariables: [],
        universalRules: [
          'Plain language only; avoid jargon and forbidden phrases.',
          'Lead with empathy when the customer is frustrated.',
        ],
        guardrails: [],
        tools: [],
        channelRules: [
          {
            channel: 'Voice',
            responseMaxWords: 30,
            abbreviationPolicy: 'expand_for_voice',
            rules: ['On voice, keep messages short and expand abbreviations.'],
            provenance: { fileName: 'voltmart-sop.md', section: 'Voice' },
          },
        ],
        optionalExternalAgents: [],
        confidence: 0.9,
      },
    });

    const entry = rendered.agents.find(
      (candidate) => candidate.name === blueprint.topology.entryPoint,
    );
    const profiles = new Map(rendered.behaviorProfiles.map((profile) => [profile.name, profile]));

    expect(entry?.dslContent).toContain('USE BEHAVIOR_PROFILE: plain_language');
    expect(entry?.dslContent).toContain('USE BEHAVIOR_PROFILE: voice_compact');
    expect(entry?.dslContent).toContain('USE BEHAVIOR_PROFILE: frustration_empathy');
    expect(profiles.get('plain_language')?.dslContent).toContain('avoid jargon');
    expect(profiles.get('voice_compact')?.dslContent).toContain('WHEN: channel.name == "voice"');
    expect(profiles.get('voice_compact')?.dslContent).toContain('MAX_RESPONSE_LENGTH: 210');
    expect(profiles.get('frustration_empathy')?.dslContent).toContain(
      'WHEN: interaction.sentiment_score < -0.3',
    );

    const profileDocuments = rendered.behaviorProfiles.map((profile) => {
      const parsed = parseAgentBasedABL(profile.dslContent);
      expect(parsed.errors, profile.name).toEqual([]);
      return parsed.document!;
    });
    const agentDocuments = rendered.agents.map((agent) => {
      const parsedAgent = parseAgentBasedABL(agent.dslContent);
      expect(parsedAgent.errors, agent.name).toEqual([]);
      return parsedAgent.document!;
    });
    const compiled = compileABLtoIR([...agentDocuments, ...profileDocuments], {
      mode: 'preview',
    });
    expect(compiled.errors ?? []).toEqual([]);
  });

  it('does not attach shared-voice behavior to explicit silent delegates', () => {
    const blueprint = structuredClone(BLUEPRINT_BATTLE_TEST_FIXTURES[0]);
    const edge = blueprint.topology.edges[0];

    expect(edge).toBeDefined();
    if (!edge) return;

    for (const topologyEdge of blueprint.topology.edges) {
      topologyEdge.type = 'delegate';
      topologyEdge.experienceMode = 'silent_delegate';
    }
    const rendered = renderProjectFromBlueprint(blueprint);
    const target = rendered.agents.find((candidate) => candidate.name === edge.to);

    expect(target?.dslContent).not.toContain('USE BEHAVIOR_PROFILE: shared_voice_handoff');
    expect(rendered.behaviorProfiles.map((profile) => profile.name)).not.toContain(
      'shared_voice_handoff',
    );
  });

  it('rejects mismatched handoff experience modes', () => {
    const blueprint = structuredClone(BLUEPRINT_BATTLE_TEST_FIXTURES[0]);
    const edge = blueprint.topology.edges[0];

    expect(edge).toBeDefined();
    if (!edge) return;

    edge.type = 'escalate';
    edge.experienceMode = 'shared_voice_handoff';

    const issues = validateBlueprintV2Output(blueprint);
    expect(issues.map((issue) => issue.code)).toContain('EDGE_EXPERIENCE_MODE_MISMATCH');
  });

  it('rejects shared voice experience on silent delegate topology edges', () => {
    const blueprint = structuredClone(BLUEPRINT_BATTLE_TEST_FIXTURES[0]);
    const edge = blueprint.topology.edges[0];

    expect(edge).toBeDefined();
    if (!edge) return;

    edge.type = 'delegate';
    edge.experienceMode = 'shared_voice_handoff';

    const issues = validateBlueprintV2Output(blueprint);
    expect(issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'EDGE_EXPERIENCE_MODE_MISMATCH',
          path: 'topology.edges.0.experienceMode',
        }),
      ]),
    );
  });

  it('warns when topology edges omit customer experience mode', () => {
    const blueprint = structuredClone(BLUEPRINT_BATTLE_TEST_FIXTURES[0]);
    const edge = blueprint.topology.edges[0];

    expect(edge).toBeDefined();
    if (!edge) return;

    delete edge.experienceMode;

    const issues = validateBlueprintV2Output(blueprint);
    expect(issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'EDGE_EXPERIENCE_MODE_MISSING',
          severity: 'warning',
          path: 'topology.edges.0.experienceMode',
        }),
      ]),
    );
  });

  it('does not render context-provided fields as customer-facing GATHER prompts', () => {
    const blueprint = structuredClone(BLUEPRINT_BATTLE_TEST_FIXTURES[0]);
    const edge = blueprint.topology.edges[0];

    expect(edge).toBeDefined();
    if (!edge) return;

    blueprint.perAgent[edge.from]!.handoffs = [
      {
        to: edge.to,
        when: 'intent.category == "claim"',
        context: {
          pass: ['order_id'],
          summary: 'Pass the known order identifier to the specialist.',
        },
        return: true,
      },
    ];
    blueprint.perAgent[edge.to]!.gather.fields = [
      {
        name: 'order_id',
        type: 'string',
        required: true,
        prompt: 'What is the order number?',
      },
      {
        name: 'resolution_choice',
        type: 'string',
        required: true,
        prompt: 'Which resolution would you prefer?',
      },
    ];

    const rendered = renderProjectFromBlueprint(blueprint);
    const agent = rendered.agents.find((candidate) => candidate.name === edge.to);

    expect(agent?.dslContent).not.toContain('order_id:');
    expect(agent?.dslContent).not.toContain('What is the order number?');
    expect(agent?.dslContent).toContain('resolution_choice:');
    expect(agent?.dslContent).toContain('Which resolution would you prefer?');
  });

  it('rejects non-http bootstrap descriptors and non-http tools without project-tool ids', () => {
    const blueprint = structuredClone(BLUEPRINT_BATTLE_TEST_FIXTURES[0]);
    blueprint.integrations.tools.push({
      name: 'bad_mcp_tool',
      type: 'mcp',
      description: 'Invalid MCP bootstrap',
      bootstrapDescriptor: {
        type: 'http',
        method: 'POST',
        url: '{{env.API_BASE_URL}}/bad',
      },
    });

    const issues = validateBlueprintV2Output(blueprint);
    expect(issues.map((issue) => issue.code)).toContain('NON_HTTP_BOOTSTRAP_UNSUPPORTED');
    expect(issues.map((issue) => issue.code)).toContain('NON_HTTP_TOOL_REF_REQUIRES_ID');
  });
});
