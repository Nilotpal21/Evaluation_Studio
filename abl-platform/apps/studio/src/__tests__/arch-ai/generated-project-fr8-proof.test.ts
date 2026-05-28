import { describe, expect, it } from 'vitest';
import { parseAgentBasedABL } from '@abl/core';
import { compileABLtoIR } from '@abl/compiler';
import {
  extractSourceArchitectureContractFromText,
  renderProjectFromBlueprint,
  synthesizeTopologyFromSourceContract,
  validateBlueprintV2Output,
  validateTopologyAgainstSourceContract,
  type BlueprintV2Output,
  type SourceArchitectureContract,
} from '@agent-platform/arch-ai/blueprint';
import { synthesizeOnboardingBootstrapTools } from '@/lib/arch-ai/tool-bootstrap-synthesizer';

const VOLTMART_FR8_SOP = `
# VoltMart Customer Support SOP

Entry agent: \`Reception_Agent\`
Channels: Voice, Web Chat, WhatsApp

## Agents

| Agent | Role |
|-------|------|
| Reception_Agent | Customer-facing router for orders, billing, and escalation. |
| Orders_Agent | Customer-facing order specialist that creates replacements and refunds. |
| Billing_Agent | Customer-facing billing specialist where the customer hears an explicit transfer. |
| Policy_Advisor_Agent | Internal policy advisory agent for eligibility analysis; customer must not hear this specialist. |
| Human_Escalation_Agent | Human escalation representative for frustrated customers. |

## Customer Experience

- Perceived persona name: Alex
- Welcome: "Hi, this is Alex at VoltMart. How can I help?"
- Use a single continuous voice across Reception and Orders so the customer does not hear a new specialist introduction.
- Voice welcome max 16 words.
- Chat welcome max 28 words.

## Channel Rules

- Voice responses max 42 words and expand abbreviations for voice.
- Voice must give a short status bridge while tools are running.
- WhatsApp requires templates for outbound follow-up.
- Web Chat responses max 80 words.

## Orders_Agent

Tools: \`get_order\`, \`create_replacement\`, \`issue_refund\`.

## Billing_Agent

Tools: \`apply_goodwill_credit\`.

## Policy_Advisor_Agent

Tools: \`search_policies\`.

## Consent Policy

- For write actions, use conversation consent when the customer asks for the specific outcome.
- Block if consent is missing or scoped to a different action.

## Tool Catalog

| Tool | Signature | Description | Call When | Do Not Call When |
|------|-----------|-------------|-----------|------------------|
| \`get_order\` | \`get_order(order_id: string, customer_id: string) -> {status: string, eligible_options: string, order_total: number}\` | Fetch order status and available remedies. | order context is missing or stale | fresh order context is already available |
| \`search_policies\` | \`search_policies(policy_topic: string, order_status: string) -> {policy_summary: string, eligible: boolean}\` | Search policy rules for an order scenario. | policy eligibility is unknown | policy result for this order status is already available |
| \`create_replacement\` | \`create_replacement(order_id: string, customer_id: string, replacement_sku: string) -> {replacement_id: string, status: string}\` | Create a replacement shipment. | replacement consent is scoped to this order | refund or credit was selected instead |
| \`issue_refund\` | \`issue_refund(order_id: string, refund_amount: number) -> {refund_id: string, status: string}\` | Issue a refund for an approved return. | refund consent is scoped to this order | refund consent is missing or replacement was selected |
| \`apply_goodwill_credit\` | \`apply_goodwill_credit(order_id: string, credit_amount: number, reason: string) -> {credit_id: string, status: string}\` | Apply a capped goodwill credit. | goodwill credit is eligible and under cap | credit amount exceeds the goodwill cap |

## Scenario Fixtures

| Scenario | Channel | User Message | Expected Outcome | Tool Responses |
|----------|---------|--------------|------------------|----------------|
| Replacement request | Voice | My blender arrived cracked. Can you replace order VM-48217-A? | Create replacement after order lookup and specific consent. | get_order({"order_id":"VM-48217-A","customer_id":"CUST-442"}): {"status":"damaged_delivered","eligible_options":"replacement,refund","order_total":89.99}; create_replacement input={"order_id":"VM-48217-A","customer_id":"CUST-442","replacement_sku":"BLEND-9"} => {"replacement_id":"RPL-7001","status":"created"} |
| Refund request | Web Chat | I want a refund for order VM-48219-C. | Issue refund after eligibility and specific refund consent. | issue_refund input={"order_id":"VM-48219-C","refund_amount":89.99} => {"refund_id":"RF-9001","status":"issued"} |
| Goodwill credit | Web Chat | The courier missed the delivery window for VM-48218-B. | Apply goodwill credit below the cap. | search_policies({"policy_topic":"goodwill credit","order_status":"late_delivery"}): {"policy_summary":"Goodwill credit allowed up to 15 dollars.","eligible":true}; apply_goodwill_credit input={"order_id":"VM-48218-B","credit_amount":15,"reason":"late_delivery"} => {"credit_id":"CR-15","status":"applied"} |
`;

function requireSourceContract(): SourceArchitectureContract {
  const contract = extractSourceArchitectureContractFromText(
    VOLTMART_FR8_SOP,
    'voltmart-fr8-sop.md',
  );

  expect(contract).not.toBeNull();
  return contract!;
}

function requireSignature(contract: SourceArchitectureContract, toolName: string): string {
  const signature = contract.tools.find((tool) => tool.name === toolName)?.signature;
  expect(signature, toolName).toBeTruthy();
  return signature!;
}

function makeTool(
  contract: SourceArchitectureContract,
  toolName: string,
  purpose: string,
  sideEffects = false,
): BlueprintV2Output['perAgent'][string]['tools'][number] {
  return {
    ref: toolName,
    purpose,
    signature: requireSignature(contract, toolName),
    description: purpose,
    sideEffects,
  };
}

function makeSparseTool(
  toolName: string,
  purpose: string,
  sideEffects = false,
): BlueprintV2Output['perAgent'][string]['tools'][number] {
  return {
    ref: toolName,
    purpose,
    sideEffects,
  };
}

function makeGeneratedVoltMartBlueprint(contract: SourceArchitectureContract): BlueprintV2Output {
  const synthesizedTopology = synthesizeTopologyFromSourceContract(contract);

  expect(synthesizedTopology).not.toBeNull();
  expect(validateTopologyAgainstSourceContract(synthesizedTopology!, contract)).toBeNull();

  return {
    version: '2.0',
    metadata: {
      schemaVersion: '2.0',
      projectName: 'VoltMart FR-8 Proof',
      generatedAt: '2026-05-17T00:00:00.000Z',
      authoringMode: 'llm_generated',
    },
    specification: {
      summary: 'Contract-driven VoltMart support with source-faithful specialists.',
      users: ['customer', 'operator'],
      channels: ['Voice', 'Web Chat', 'WhatsApp'],
      languages: ['English'],
      successCriteria: [
        'Preserve specialist topology from the uploaded SOP.',
        'Keep one perceived voice for order handoffs.',
        'Use source-grounded hosted Test API fixtures.',
      ],
      assumptions: ['VoltMart backend APIs are represented by hosted HTTP project tools.'],
    },
    topology: {
      pattern: 'hub_spoke',
      entryPoint: 'Reception_Agent',
      agents: synthesizedTopology!.agents.map((agent) => ({
        name: agent.name,
        role: agent.role,
        executionMode: agent.executionMode,
        description: agent.description,
      })),
      edges: [
        {
          from: 'Reception_Agent',
          to: 'Orders_Agent',
          type: 'transfer',
          experienceMode: 'shared_voice_handoff',
          condition: 'intent.category == "orders"',
          expectReturn: true,
        },
        {
          from: 'Reception_Agent',
          to: 'Billing_Agent',
          type: 'transfer',
          experienceMode: 'visible_handoff',
          condition: 'intent.category == "billing"',
          expectReturn: true,
        },
        {
          from: 'Reception_Agent',
          to: 'Policy_Advisor_Agent',
          type: 'delegate',
          experienceMode: 'silent_delegate',
          condition: 'policy_review_needed == true',
          expectReturn: true,
        },
        {
          from: 'Reception_Agent',
          to: 'Human_Escalation_Agent',
          type: 'escalate',
          experienceMode: 'human_escalation',
          condition: 'user_requests_human == true OR negative_sentiment == true',
          expectReturn: false,
        },
      ],
    },
    perAgent: {
      Reception_Agent: {
        role: 'Customer-facing router',
        goal: 'Understand the request and route to the correct VoltMart support path.',
        executionMode: 'hybrid',
        persona: {
          summary: 'You are Alex, the VoltMart support voice.',
          tone: ['warm', 'clear', 'concise'],
          limitations: ['Do not claim an order action succeeded until a tool result confirms it.'],
        },
        tools: [],
        gather: { fields: [] },
        memory: { session: ['customer_id', 'order_id', 'request_summary'], persistent: [] },
        constraints: [
          {
            label: 'replacement_or_refund',
            kind: 'require',
            condition: 'replacement_id == null OR refund_id == null',
            onFail: 'Offer one remedy at a time.',
          },
          {
            label: 'goodwill_cap',
            kind: 'limit',
            condition: 'credit_amount <= 15',
            onFail: 'Keep goodwill credits within the approved cap.',
          },
        ],
        guardrails: [],
        complete: { conditions: [{ when: 'customer_need_resolved == true' }] },
        handoffs: [
          {
            to: 'Orders_Agent',
            when: 'intent.category == "orders"',
            context: {
              pass: ['customer_id', 'order_id', 'request_summary'],
              summary: 'Continue order help in the same Alex voice.',
            },
            return: true,
          },
          {
            to: 'Billing_Agent',
            when: 'intent.category == "billing"',
            context: {
              pass: ['customer_id', 'order_id', 'request_summary'],
              summary: 'Tell the customer they are being connected to billing support.',
            },
            return: true,
          },
          {
            to: 'Policy_Advisor_Agent',
            when: 'policy_review_needed == true',
            context: {
              pass: ['order_id', 'order_status', 'request_summary'],
              summary: 'Check the policy silently before recommending a remedy.',
            },
            return: true,
          },
          {
            to: 'Human_Escalation_Agent',
            when: 'user_requests_human == true OR negative_sentiment == true',
            context: {
              pass: ['customer_id', 'order_id', 'request_summary'],
              summary: 'Escalate to a human representative.',
            },
            return: false,
          },
        ],
      },
      Orders_Agent: {
        role: 'Order specialist',
        goal: 'Resolve replacement and refund requests using order evidence and consent.',
        executionMode: 'reasoning',
        persona: {
          summary: 'Continue as Alex while resolving order remedies.',
          tone: ['warm', 'clear', 'concise'],
          limitations: ['Do not offer both replacement and refund for the same item.'],
        },
        tools: [
          makeTool(contract, 'get_order', 'Fetch order status and available remedies.'),
          makeTool(
            contract,
            'create_replacement',
            'Create a replacement after scoped consent.',
            true,
          ),
          makeSparseTool('issue_refund', 'Issue a refund after scoped consent.', true),
        ],
        gather: { fields: [] },
        memory: { session: ['customer_id', 'order_id'], persistent: [] },
        constraints: [
          {
            label: 'replacement_or_refund',
            kind: 'require',
            condition: 'replacement_id == null OR refund_id == null',
            onFail: 'Offer one remedy at a time.',
          },
        ],
        guardrails: [],
        complete: {
          conditions: [
            { when: 'replacement_id != null OR refund_id != null OR order_status != null' },
          ],
        },
        handoffs: [],
      },
      Billing_Agent: {
        role: 'Billing specialist',
        goal: 'Apply eligible goodwill credits while the customer hears the transfer.',
        executionMode: 'reasoning',
        persona: {
          summary: 'Resolve billing issues with a visible specialist transition.',
          tone: ['calm', 'precise'],
          limitations: ['Do not exceed the goodwill credit cap.'],
        },
        tools: [
          makeTool(
            contract,
            'apply_goodwill_credit',
            'Apply a capped goodwill credit after policy eligibility is known.',
            true,
          ),
        ],
        gather: { fields: [] },
        memory: { session: ['customer_id', 'order_id'], persistent: [] },
        constraints: [
          {
            label: 'goodwill_cap',
            kind: 'limit',
            condition: 'credit_amount <= 15',
            onFail: 'Keep goodwill credits within the approved cap.',
          },
        ],
        guardrails: [],
        complete: { conditions: [{ when: 'credit_id != null' }] },
        handoffs: [],
      },
      Policy_Advisor_Agent: {
        role: 'Internal policy advisor',
        goal: 'Advise on refund, replacement, and goodwill policy without speaking to the customer.',
        executionMode: 'reasoning',
        persona: {
          summary: 'Analyze policy quietly and return a concise recommendation.',
          tone: ['precise'],
          limitations: ['Do not produce customer-facing copy.'],
        },
        tools: [makeSparseTool('search_policies', 'Search policy rules for the scenario.')],
        gather: { fields: [] },
        memory: { session: ['order_id', 'order_status'], persistent: [] },
        constraints: [],
        guardrails: [],
        complete: { conditions: [{ when: 'policy_summary != null' }] },
        handoffs: [],
      },
      Human_Escalation_Agent: {
        role: 'Human escalation representative',
        goal: 'Receive escalated context for human follow-up.',
        executionMode: 'reasoning',
        persona: {
          summary: 'Prepare the handoff context for a human representative.',
          tone: ['empathetic'],
          limitations: ['Do not impersonate the human representative.'],
        },
        tools: [],
        gather: { fields: [] },
        memory: { session: ['customer_id', 'order_id', 'request_summary'], persistent: [] },
        constraints: [],
        guardrails: [],
        complete: { conditions: [{ when: 'escalation_ready == true' }] },
        handoffs: [],
      },
    },
    governance: {
      compliance: ['PII'],
      guardrails: [],
      policies: [
        {
          name: 'remedy_exclusivity',
          description: 'A customer receives replacement or refund for an item, not both.',
          enforcement: 'block',
        },
      ],
    },
    integrations: {
      tools: [
        {
          name: 'get_order',
          type: 'http',
          description: 'Fetch order status and remedies.',
          bootstrapDescriptor: {
            type: 'http',
            method: 'POST',
            url: '{{env.VOLTMART_API_BASE_URL}}/orders/get_order',
          },
        },
        {
          name: 'search_policies',
          type: 'http',
          description: 'Search order policy.',
          bootstrapDescriptor: {
            type: 'http',
            method: 'POST',
            url: '{{env.VOLTMART_API_BASE_URL}}/policies/search',
          },
        },
      ],
      apiSpecs: [],
    },
    buildOrder: [
      'Reception_Agent',
      'Orders_Agent',
      'Billing_Agent',
      'Policy_Advisor_Agent',
      'Human_Escalation_Agent',
    ],
  };
}

describe('FR-8 generated project proof', () => {
  it('renders a source-contract project with grounded fixtures and no generic customer filler', () => {
    const contract = requireSourceContract();
    const blueprint = makeGeneratedVoltMartBlueprint(contract);
    const validationIssues = validateBlueprintV2Output(blueprint);

    expect(contract.tools.map((tool) => tool.name)).toEqual(
      expect.arrayContaining([
        'get_order',
        'search_policies',
        'create_replacement',
        'issue_refund',
        'apply_goodwill_credit',
      ]),
    );
    expect(contract.scenarioFixtures?.flatMap((fixture) => fixture.toolFixtures)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          toolName: 'get_order',
          sampleInput: { order_id: 'VM-48217-A', customer_id: 'CUST-442' },
        }),
        expect.objectContaining({
          toolName: 'issue_refund',
          sampleInput: { order_id: 'VM-48219-C', refund_amount: 89.99 },
        }),
        expect.objectContaining({
          toolName: 'apply_goodwill_credit',
          sampleInput: { order_id: 'VM-48218-B', credit_amount: 15, reason: 'late_delivery' },
        }),
      ]),
    );
    expect(contract.tools.find((tool) => tool.name === 'search_policies')).toMatchObject({
      callWhen: ['policy eligibility is unknown'],
      doNotCallWhen: ['policy result for this order status is already available'],
    });
    expect(contract.tools.find((tool) => tool.name === 'issue_refund')).toMatchObject({
      callWhen: ['refund consent is scoped to this order'],
      doNotCallWhen: ['refund consent is missing or replacement was selected'],
    });

    const sparseRefundTool = blueprint.perAgent.Orders_Agent.tools.find(
      (tool) => tool.ref === 'issue_refund',
    );
    const sparsePolicyTool = blueprint.perAgent.Policy_Advisor_Agent.tools.find(
      (tool) => tool.ref === 'search_policies',
    );

    expect(sparseRefundTool).toMatchObject({ ref: 'issue_refund', sideEffects: true });
    expect(sparseRefundTool).not.toHaveProperty('signature');
    expect(sparsePolicyTool).toMatchObject({ ref: 'search_policies' });
    expect(sparsePolicyTool).not.toHaveProperty('signature');
    expect(validationIssues).toEqual([]);
    expect(blueprint.topology.edges.map((edge) => edge.experienceMode)).toEqual(
      expect.arrayContaining([
        'shared_voice_handoff',
        'visible_handoff',
        'silent_delegate',
        'human_escalation',
      ]),
    );

    const rendered = renderProjectFromBlueprint(blueprint, { sourceContract: contract });
    const renderedByName = new Map(rendered.agents.map((agent) => [agent.name, agent.dslContent]));
    const receptionDsl = renderedByName.get('Reception_Agent') ?? '';
    const ordersDsl = renderedByName.get('Orders_Agent') ?? '';
    const billingDsl = renderedByName.get('Billing_Agent') ?? '';
    const policyDsl = renderedByName.get('Policy_Advisor_Agent') ?? '';
    const allAgentDsl = rendered.agents.map((agent) => agent.dslContent).join('\n\n');

    expect(receptionDsl).toContain('EXPERIENCE_MODE: shared_voice_handoff');
    expect(receptionDsl).toContain('EXPERIENCE_MODE: visible_handoff');
    expect(receptionDsl).toContain('EXPERIENCE_MODE: silent_delegate');
    expect(ordersDsl).toContain('USE BEHAVIOR_PROFILE: shared_voice_handoff');
    expect(billingDsl).not.toContain('USE BEHAVIOR_PROFILE: shared_voice_handoff');
    expect(policyDsl).not.toContain('USE BEHAVIOR_PROFILE: shared_voice_handoff');
    expect(policyDsl).not.toContain('USE BEHAVIOR_PROFILE:');
    expect(ordersDsl).toContain('Call when refund consent is scoped to this order');
    expect(ordersDsl).toContain('Do not call when refund consent is missing');
    expect(policyDsl).toContain('Call when policy eligibility is unknown');
    expect(policyDsl).toContain(
      'Do not call when policy result for this order status is already available',
    );
    const sharedVoiceProfile = rendered.behaviorProfiles.find(
      (profile) => profile.name === 'shared_voice_handoff',
    );

    expect(rendered.behaviorProfiles.map((profile) => profile.name)).toEqual(
      expect.arrayContaining(['shared_voice_handoff']),
    );
    expect(sharedVoiceProfile?.dslContent).toContain(
      "Continue the customer's existing conversation in the same brand voice.",
    );

    for (const requiredTool of [
      'get_order(order_id: string, customer_id: string)',
      'search_policies(policy_topic: string, order_status: string)',
      'create_replacement(order_id: string, customer_id: string, replacement_sku: string)',
      'issue_refund(order_id: string, refund_amount: number)',
      'apply_goodwill_credit(order_id: string, credit_amount: number, reason: string)',
    ]) {
      expect(allAgentDsl).toContain(requiredTool);
    }

    expect(allAgentDsl).not.toMatch(/\b\w+\(input: string\)/);
    expect(allAgentDsl).not.toMatch(
      /\b(?:consult|delegate|handoff|transfer)_to_(?:orders|billing|policy|fulfillment|human)\b/i,
    );
    expect(allAgentDsl).not.toMatch(
      /\b(?:conversation_complete|gathered_detail|placeholder|sample response|I have completed)\b/i,
    );

    const parsedDocuments = [
      ...rendered.agents.map((agent) => {
        const parsed = parseAgentBasedABL(agent.dslContent);
        expect(parsed.errors, agent.name).toEqual([]);
        expect(parsed.document, agent.name).toBeTruthy();
        return parsed.document!;
      }),
      ...rendered.behaviorProfiles.map((profile) => {
        const parsed = parseAgentBasedABL(profile.dslContent);
        expect(parsed.errors, profile.name).toEqual([]);
        expect(parsed.document, profile.name).toBeTruthy();
        return parsed.document!;
      }),
    ];
    const compiled = compileABLtoIR(parsedDocuments, { mode: 'preview' });

    expect(compiled.errors ?? []).toEqual([]);
    expect(compiled.agents.Orders_Agent.behavior_profiles?.map((profile) => profile.name)).toEqual(
      expect.arrayContaining(['shared_voice_handoff']),
    );

    const bootstrap = synthesizeOnboardingBootstrapTools({
      agentFiles: Object.fromEntries(
        rendered.agents.map((agent) => [agent.name, { content: agent.dslContent }]),
      ),
      sourceContract: contract,
    });

    expect(bootstrap.extractionErrors).toEqual([]);
    expect(bootstrap.unsupported).toEqual([]);

    const getOrder = bootstrap.tools.find((tool) => tool.contract.name === 'get_order');
    const replacement = bootstrap.tools.find((tool) => tool.contract.name === 'create_replacement');
    const refund = bootstrap.tools.find((tool) => tool.contract.name === 'issue_refund');
    const policySearch = bootstrap.tools.find((tool) => tool.contract.name === 'search_policies');
    const goodwillCredit = bootstrap.tools.find(
      (tool) => tool.contract.name === 'apply_goodwill_credit',
    );

    expect(bootstrap.tools.map((tool) => tool.contract.name)).toEqual(
      expect.arrayContaining([
        'get_order',
        'search_policies',
        'create_replacement',
        'issue_refund',
        'apply_goodwill_credit',
      ]),
    );
    expect(getOrder?.sampleInput).toMatchObject({
      order_id: 'VM-48217-A',
      customer_id: 'CUST-442',
    });
    expect(getOrder?.staticResponse).toEqual({
      status: 'damaged_delivered',
      eligible_options: 'replacement,refund',
      order_total: 89.99,
    });
    expect(replacement?.staticResponse).toEqual({
      replacement_id: 'RPL-7001',
      status: 'created',
    });
    expect(refund?.sampleInput).toMatchObject({
      order_id: 'VM-48219-C',
      refund_amount: 89.99,
    });
    expect(refund?.staticResponse).toEqual({
      refund_id: 'RF-9001',
      status: 'issued',
    });
    expect(policySearch?.sampleInput).toMatchObject({
      policy_topic: 'goodwill credit',
      order_status: 'late_delivery',
    });
    expect(policySearch?.staticResponse).toEqual({
      policy_summary: 'Goodwill credit allowed up to 15 dollars.',
      eligible: true,
    });
    expect(goodwillCredit?.staticResponse).toEqual({
      credit_id: 'CR-15',
      status: 'applied',
    });
  });
});
