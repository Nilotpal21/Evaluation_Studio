import { describe, expect, it } from 'vitest';
import { parseAgentBasedABL } from '@abl/core';
import { compileABLtoIR } from '@abl/compiler';
import {
  extractSourceArchitectureContractFromText,
  synthesizeTopologyFromSourceContract,
  validateTopologyAgainstSourceContract,
  type SourceArchitectureContract,
} from '@agent-platform/arch-ai/blueprint';
import { computeArchitecturePlans } from '@agent-platform/arch-ai/planning';
import { assembleAblAgent } from '@/lib/arch-ai/scaffold/assembler';
import { scaffoldAblAgent } from '@/lib/arch-ai/scaffold/scaffold-generator';
import type {
  AblSkeleton,
  AgentSpecInput,
  CreativeContent,
  DomainContextInput,
  TopologyOutput,
} from '@/lib/arch-ai/scaffold/types';
import { renderManagedBehaviorProfileDocumentsForTopology } from '@/lib/arch-ai/managed-behavior-profiles';
import { buildScaffoldWorkerDomainInput } from '@/lib/arch-ai/scaffold/domain-input';

const VOLTMART_GOLDEN_SOP = `
# VoltMart Support SOP

Entry agent: \`Alex\`
Channels: Web Chat, Voice

## Agents

| Agent | Role |
|-------|------|
| Alex | Customer-facing VoltMart support supervisor and router. |
| PolicyAdvisor | Internal silent policy advisor for deciding eligible replacement, refund, or goodwill options; customer must not hear this specialist. |
| FulfillmentSpecialist | Internal silent fulfillment action specialist invoked only after the customer has chosen and confirmed one replacement, refund, or goodwill action. |
| HumanEscalation | Human escalation representative for urgent or frustrated customers. |

## Universal Rules

- Use plain language, avoid jargon, and never expose internal policy codes or forbidden phrases.
- Lead with empathy when the customer is frustrated, upset, angry, or has negative sentiment.
- Do not claim a replacement, refund, or credit succeeded until a tool result confirms it.

## Channel Rules

- Voice responses max 42 words, keep messages short, expand abbreviations, and never spell out email addresses unless asked.
- Web Chat responses max 80 words.

## Customer Experience

- Perceived persona name: Alex
- Welcome: "Hi, how can I help?"
- Use one continuous VoltMart voice; do not announce internal delegates.

## Alex

### Tools

- \`get_order\`

## PolicyAdvisor

### Tools

- \`search_policies\`

## FulfillmentSpecialist

### Tools

- \`create_replacement\`
- \`issue_refund\`
- \`apply_goodwill_credit\`

## HumanEscalation

### Tools

- \`create_support_ticket\`
- \`notify_human_queue\`

## Tool Catalog

| Tool | Signature | Description | Call When | Do Not Call When |
|------|-----------|-------------|-----------|------------------|
| \`get_order\` | \`get_order(order_id: string, customer_id: string) -> { order_id: string, status: string, items: object[], ship_to: object, carrier: string, tracking_number: string, last_scan: string, last_scan_at: string, promised_delivery_date: string, payment_status: string }\` | Fetch the current order, shipment, and payment state. | customer asks about an order; supervisor needs fresh order context before policy or fulfillment | already have a fresh get_order result for the same order this turn |
| \`search_policies\` | \`search_policies(policy_topic: string, order_status: string) -> { policy_summary: string, eligible: boolean, allowed_actions: string[] }\` | Search VoltMart policy rules for a specific order scenario. | customer asks for resolution options; supervisor needs to confirm a resolution is allowed | a policy result for the same topic and order state is already available this turn |
| \`create_replacement\` | \`create_replacement(order_id: string, customer_id: string, replacement_sku: string) -> { replacement_id: string, status: string, promised_delivery_date: string }\` | Create a replacement shipment after conversational consent. | customer has confirmed they want the replacement | customer only asked about options; refund or credit was selected instead |
| \`issue_refund\` | \`issue_refund(order_id: string, refund_amount: number, reason: string) -> { refund_id: string, status: string, refund_eta: string }\` | Issue a refund after conversational consent. | customer has confirmed they want the refund | customer only asked about options; replacement or credit was selected instead |
| \`apply_goodwill_credit\` | \`apply_goodwill_credit(order_id: string, credit_amount: number, reason: string) -> { credit_id: string, status: string, amount: number }\` | Apply an approved goodwill credit after conversational consent. | customer has confirmed they want the goodwill credit | customer only asked about options; replacement or refund was selected instead |
| \`create_support_ticket\` | \`create_support_ticket(order_id: string, customer_id: string, reason: string) -> { ticket_id: string, status: string }\` | Create a human support ticket. | escalation is required | normal self-service resolution is still available |
| \`notify_human_queue\` | \`notify_human_queue(ticket_id: string, priority: string) -> { queued: boolean, eta_minutes: number }\` | Notify the human support queue. | a support ticket was created for escalation | no ticket exists |

## Scenario Fixtures

| Scenario | Channel | User Message | Expected Outcome | Tool Responses |
|----------|---------|--------------|------------------|----------------|
| Replacement request | Voice | My blender arrived cracked. Can you replace order VM-48217-A? | Create replacement after order lookup and conversational consent. | get_order({"order_id":"VM-48217-A","customer_id":"CUST-442"}): {"order_id":"VM-48217-A","status":"damaged_delivered","items":[{"sku":"BLEND-9","qty":1}],"ship_to":{"postal_code":"94107"},"carrier":"UPS","tracking_number":"1Z999","last_scan":"Delivered damaged","last_scan_at":"2026-05-16T18:12:00Z","promised_delivery_date":"2026-05-15","payment_status":"paid"}; create_replacement input={"order_id":"VM-48217-A","customer_id":"CUST-442","replacement_sku":"BLEND-9"} => {"replacement_id":"RPL-7001","status":"created","promised_delivery_date":"2026-05-20"} |
| Refund request | Web Chat | I want a refund for VM-48218-B because it never arrived. | Issue refund after eligibility and customer confirmation. | search_policies({"policy_topic":"refund","order_status":"lost_in_transit"}): {"policy_summary":"Refund is allowed after carrier loss scan.","eligible":true,"allowed_actions":["refund"]}; issue_refund input={"order_id":"VM-48218-B","refund_amount":89.99,"reason":"lost_in_transit"} => {"refund_id":"RF-9001","status":"issued","refund_eta":"3 business days"} |
`;

function requireSourceContract(): SourceArchitectureContract {
  const contract = extractSourceArchitectureContractFromText(
    VOLTMART_GOLDEN_SOP,
    'voltmart-golden-sop.md',
  );

  expect(contract).not.toBeNull();
  return contract!;
}

function buildDomain(contract: SourceArchitectureContract): DomainContextInput {
  return {
    domain: 'VoltMart support: order status, policy eligibility, fulfillment, and escalation.',
    channels: contract.channels,
    compliance: [],
    integrations: [],
    tone: 'warm, clear, concise',
    universalRules: contract.universalRules,
    channelRules: contract.channelRules?.map((rule) => ({
      channel: rule.channel,
      ...(rule.responseMaxWords !== undefined ? { responseMaxWords: rule.responseMaxWords } : {}),
      ...(rule.abbreviationPolicy ? { abbreviationPolicy: rule.abbreviationPolicy } : {}),
      ...(rule.toolLatencyBridge !== undefined
        ? { toolLatencyBridge: rule.toolLatencyBridge }
        : {}),
      rules: [...rule.rules],
    })),
    sourceTools: contract.tools.map((tool) => ({
      name: tool.name,
      ...(tool.signature ? { signature: tool.signature } : {}),
      ...(tool.description ? { description: tool.description } : {}),
      ...(tool.callWhen?.length ? { callWhen: [...tool.callWhen] } : {}),
      ...(tool.doNotCallWhen?.length ? { doNotCallWhen: [...tool.doNotCallWhen] } : {}),
    })),
    sourceToolFixtures: contract.scenarioFixtures?.flatMap((fixture) =>
      fixture.toolFixtures.map((toolFixture) => ({
        toolName: toolFixture.toolName,
        sampleInput: toolFixture.sampleInput,
        response: toolFixture.response,
      })),
    ),
    consentPolicies: contract.consentPolicies?.map((policy) => ({
      ...(policy.toolName ? { toolName: policy.toolName } : {}),
      action: policy.action,
      mode: policy.mode,
      requiredIn: policy.requiredIn,
      scopeFields: [...policy.scopeFields],
      fallback: policy.fallback,
    })),
  };
}

function buildCreative(skeleton: AblSkeleton, topology: TopologyOutput): CreativeContent {
  const creative: CreativeContent = {
    goal: `Handle the ${skeleton.agentName} responsibility for VoltMart support using the provided contract, source fixtures, and topology without exposing internal mechanics.`,
    persona:
      skeleton.agentName === 'Alex'
        ? 'You are Alex, VoltMart support. You sound warm, direct, and practical while routing work through the right internal specialists and only quoting confirmed tool outcomes.'
        : `You are ${skeleton.agentName}, an internal VoltMart specialist. Return structured, customer-safe facts to Alex and do not speak as a separate customer-facing agent.`,
  };

  for (const handoff of skeleton.handoffs) {
    if (handoff.whenSlot === null) continue;
    const condition = topology.edges.find(
      (edge) => edge.from === skeleton.agentName && edge.to === handoff.to,
    )?.condition;
    creative[handoff.whenSlot] = normalizeGeneratedCondition(condition ?? handoff.to);
  }

  for (const gather of skeleton.gatherFields) {
    creative[gather.askSlot] =
      gather.name === 'routing_intent'
        ? 'What can I help with for this VoltMart order?'
        : `What ${gather.name.replace(/_/g, ' ')} should I use for this VoltMart request?`;
  }

  return creative;
}

function normalizeGeneratedCondition(condition: string): string {
  const normalized = condition
    .replace(/\bpolicyadvisor_needed\b/i, 'routing_intent == "resolution_options_needed"')
    .replace(
      /\bfulfillmentspecialist_needed\b/i,
      'routing_intent == "fulfillment_action_confirmed"',
    )
    .replace(/\bhumanescalation\b/i, 'human_escalation');
  if (/routing_intent\s*==/.test(normalized)) {
    return normalized.replace(/\s*==\s*true\b/i, '');
  }
  if (/user_requests_human|negative_sentiment/.test(normalized)) {
    return 'routing_intent == "human_escalation"';
  }
  return `routing_intent == "${condition
    .replace(/Agent$/i, '')
    .replace(/[^A-Za-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toLowerCase()}"`;
}

function buildVoltMartGoldenAgents() {
  const contract = requireSourceContract();
  const topology = synthesizeTopologyFromSourceContract(contract);

  expect(topology).not.toBeNull();
  expect(validateTopologyAgainstSourceContract(topology!, contract)).toBeNull();

  const domain = buildDomain(contract);
  const { plans } = computeArchitecturePlans(topology!);
  const generated = new Map<string, string>();

  for (const agent of topology!.agents) {
    const plan = plans.get(agent.name);
    expect(plan, agent.name).toBeTruthy();
    const spec: AgentSpecInput = {
      name: agent.name,
      role: agent.role,
      executionMode: plan!.complexity.selectedExecutionMode,
      ...(agent.description ? { description: agent.description } : {}),
      ...(agent.tools ? { tools: agent.tools } : {}),
      ...(agent.gatherFields ? { gatherFields: agent.gatherFields } : {}),
      isEntry: topology!.entryPoint === agent.name,
    };
    const scaffold = scaffoldAblAgent(plan!, topology!, spec, domain);
    const { yaml } = assembleAblAgent(
      scaffold.skeleton,
      buildCreative(scaffold.skeleton, topology!),
    );
    generated.set(agent.name, yaml);
  }

  return {
    contract,
    topology: topology!,
    domain,
    generated,
    profiles: renderManagedBehaviorProfileDocumentsForTopology(topology, domain),
  };
}

function expectParsesAndCompiles(documents: ReadonlyArray<{ name: string; content: string }>) {
  const parsedDocuments = documents.map((document) => {
    const parsed = parseAgentBasedABL(document.content);
    expect(parsed.errors, document.name).toEqual([]);
    expect(parsed.document, document.name).toBeTruthy();
    return parsed.document!;
  });
  const compiled = compileABLtoIR(parsedDocuments, { mode: 'preview' });
  expect(compiled.errors ?? [], documents.map((document) => document.name).join(', ')).toEqual([]);
}

describe('VoltMart golden Arch generation', () => {
  it('generates the golden topology-aware VoltMart ABL from the source contract', () => {
    const { generated, profiles } = buildVoltMartGoldenAgents();
    const alex = generated.get('Alex') ?? '';
    const policyAdvisor = generated.get('PolicyAdvisor') ?? '';
    const fulfillment = generated.get('FulfillmentSpecialist') ?? '';

    expectParsesAndCompiles([
      ...[...generated.entries()].map(([name, content]) => ({ name, content })),
      ...profiles.map((content) => ({
        name: content.match(/^BEHAVIOR_PROFILE:\s*(\S+)/m)?.[1] ?? 'profile',
        content,
      })),
    ]);

    expect(alex).toContain('USE BEHAVIOR_PROFILE: plain_language');
    expect(alex).toContain('USE BEHAVIOR_PROFILE: voice_compact');
    expect(alex).toContain('USE BEHAVIOR_PROFILE: frustration_empathy');
    expect(alex).toContain('get_order(order_id: string, customer_id: string)');
    expect(alex).toContain('tracking_number: string');
    expect(alex).not.toMatch(/TO:\s+FulfillmentSpecialist[\s\S]*?WHEN:\s+true/);

    expect(policyAdvisor).not.toContain('GATHER:');
    expect(policyAdvisor).toContain('REASONING: true');
    expect(policyAdvisor).not.toContain('REASONING: false');
    expect(policyAdvisor).toContain('search_policies(policy_topic: string, order_status: string)');
    expect(policyAdvisor).toContain('Call when customer asks for resolution options');
    expect(policyAdvisor).toContain('Do not call when a policy result');
    expect(policyAdvisor).not.toContain('policy_topic: input');
    expect(policyAdvisor).not.toMatch(/Could you|Can you provide|What .* should I use/i);

    expect(fulfillment).not.toContain('GATHER:');
    expect(fulfillment).toContain(
      'create_replacement(order_id: string, customer_id: string, replacement_sku: string)',
    );
    expect(fulfillment).toContain('issue_refund(order_id: string, refund_amount: number');
    expect(fulfillment).toContain('apply_goodwill_credit(order_id: string, credit_amount: number');
    expect(fulfillment).toContain('confirm: never');
    expect(fulfillment).toContain('REASONING: true');
    expect(fulfillment).not.toMatch(/CALL:\s+create_replacement[\s\S]*CALL:\s+issue_refund/);

    expect(profiles.join('\n')).toContain('BEHAVIOR_PROFILE: plain_language');
    expect(profiles.join('\n')).toContain('BEHAVIOR_PROFILE: voice_compact');
    expect(profiles.join('\n')).toContain('WHEN: interaction.sentiment_score < -0.3');
  });

  it('preserves source-contract fields when the parallel worker enters scaffold generation', () => {
    const { domain } = buildVoltMartGoldenAgents();
    const workerDomain = buildScaffoldWorkerDomainInput(domain);

    expect(workerDomain.universalRules).toEqual(domain.universalRules);
    expect(workerDomain.channelRules).toEqual(domain.channelRules);
    expect(workerDomain.sourceToolFixtures).toEqual(domain.sourceToolFixtures);
    expect(workerDomain.consentPolicies).toEqual(domain.consentPolicies);
    expect(workerDomain.sourceTools?.find((tool) => tool.name === 'get_order')).toMatchObject({
      signature: expect.stringContaining('tracking_number: string'),
      callWhen: expect.arrayContaining(['customer asks about an order']),
      doNotCallWhen: expect.arrayContaining([
        'already have a fresh get_order result for the same order this turn',
      ]),
    });
  });
});
