import { describe, expect, it } from 'vitest';
import {
  extractSourceArchitectureContractFromFiles,
  extractSourceArchitectureContractFromText,
  getSourceArchitectureContractFromMetadata,
  renderSourceArchitectureContractPrompt,
  synthesizeTopologyFromSourceContract,
  validateTopologyAgainstSourceContract,
} from '../../blueprint/source-architecture-contract.js';

const MERCURY_SOP_EXCERPT = `
# Mercury Bank SOP

Project slug: mercury-bank
Entry agent: \`Banking_Supervisor\`
Channels: Web, Voice, WhatsApp
Required MCP server: Mercury Banking Server

## 1.1 Agents in the system

| # | Agent | Role |
|---|-------|------|
| 1 | Banking_Supervisor | Top-level greeter and intent router. Identifies the customer and hands off to specialists. |
| 2 | Account_Info_Agent | Balances, transactions, change of address, contact number updates. |
| 3 | Credit_Card_Payment_Agent | Outstanding dues, billing history, payment history, making credit-card payments. |
| 4 | Credit_Card_Application_Agent | Applying for a new credit card, checking application status. |
| 5 | Money_Transfer_Agent | Transfers between own accounts, transfers to beneficiaries, transfer history, cancelling scheduled transfers. |
| 6 | Dispute_Complaint_Agent | Filing transaction disputes, filing complaints, checking status of either. |
| 7 | Loan_Application_Agent | Applying for personal/auto/home-equity loans, eligibility, viewing existing loans. |
| 8 | Human_Escalation_Agent | Empathetic handoff to a human representative. |

## Universal session state
- Store \`customer_id\` once at the start.
- Specialists read it; never ask more than once.

## 4. Credit_Card_Payment_Agent
### 4.7 Tools
\`get_credit_card_accounts\`, \`get_checking_accounts\`, \`get_credit_card_summary\`, \`initiate_payment\`.

### 4.8 Memory
- Session: \`customer_id\`

## 10. Tool Catalog

All tools below are exposed by the **Mercury Banking Server** MCP.

| Tool | Signature | Description |
|------|-----------|-------------|
| \`get_checking_accounts\` | \`(customer_id) -> {accounts:[]}\` | All checking accounts and balances for a customer. |
| \`initiate_payment\` | \`(account_id, amount) -> {success, confirmation_number}\` | Pay a credit-card bill. |
`;

const VOLTMART_CX_EXCERPT = `
# VoltMart Customer Support SOP

Entry agent: \`Reception_Agent\`
Channels: Voice, Web Chat, WhatsApp

## Agents

| Agent | Role |
|-------|------|
| Reception_Agent | Customer-facing router for returns, refunds, and order questions. |
| Orders_Agent | Customer-facing order specialist that creates replacements and refunds. |
| Policy_Advisor_Agent | Internal policy advisory agent for eligibility analysis and policy synthesis; customer must not hear this specialist. |

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

## Consent Policy

- For write actions, use conversation consent when the customer asks for the specific outcome.
- Block if consent is missing or scoped to a different action.

## Tool Catalog

| Tool | Signature | Description |
|------|-----------|-------------|
| \`get_order\` | \`get_order(order_id: string, customer_id: string) -> {status: string}\` | Fetch order status. |
| \`create_replacement\` | \`create_replacement(order_id: string, customer_id: string, replacement_sku: string) -> {replacement_id: string}\` | Create a replacement shipment. |
| \`issue_refund\` | \`issue_refund(order_id: string, refund_amount: number) -> {refund_id: string}\` | Issue a refund for an approved return. |

## Scenario Fixtures

| Scenario | Channel | User Message | Expected Outcome | Tool Responses |
|----------|---------|--------------|------------------|----------------|
| Replacement request | Voice | My blender arrived cracked. Can you replace it? | Create replacement after order lookup and specific consent. | get_order({"order_id":"VM-48217-A","customer_id":"CUST-442"}): damaged_delivered; create_replacement input={"order_id":"VM-48217-A","customer_id":"CUST-442","replacement_sku":"BLEND-9"} => replacement_created |
| Refund request | Web Chat | I want a refund for order A123. | Refund path requires scoped refund consent. | get_order: delivered; issue_refund: refund_created |
`;

describe('source architecture contract extraction', () => {
  it('preserves standalone behavior profile documents from source files', () => {
    const contract = extractSourceArchitectureContractFromText(
      `
BEHAVIOR_PROFILE: voltmart_voice
PRIORITY: 20
WHEN: channel.name == "voice"

INSTRUCTIONS: |
  Keep responses short and natural for voice.

BEHAVIOR_PROFILE: voltmart_voice_compact
PRIORITY: 30
WHEN: channel.name == "voice"

INSTRUCTIONS: |
  Ask for one thing at a time.
`,
      'behavior_profiles/voltmart_voice.behavior_profile.abl',
    );

    expect(contract).not.toBeNull();
    expect(contract?.behaviorProfiles?.map((profile) => profile.name)).toEqual([
      'voltmart_voice',
      'voltmart_voice_compact',
    ]);
    expect(contract?.behaviorProfiles?.[0]?.dslContent).toContain(
      'BEHAVIOR_PROFILE: voltmart_voice',
    );
    expect(contract?.behaviorProfiles?.[1]?.dslContent).toContain(
      'BEHAVIOR_PROFILE: voltmart_voice_compact',
    );
  });

  it('does not include following agent DSL in extracted behavior profile documents', () => {
    const contract = extractSourceArchitectureContractFromText(
      `
BEHAVIOR_PROFILE: voice_concise
PRIORITY: 10
WHEN: channel.name == "voice"

INSTRUCTIONS: |
  Keep responses short.

AGENT: Support_Agent
GOAL: "Help customers"
USE BEHAVIOR_PROFILE: voice_concise
`,
      'mixed-source.abl',
    );

    expect(contract?.behaviorProfiles?.[0]?.dslContent).toContain(
      'BEHAVIOR_PROFILE: voice_concise',
    );
    expect(contract?.behaviorProfiles?.[0]?.dslContent).not.toContain('AGENT: Support_Agent');
    expect(contract?.declaredAgents.map((agent) => agent.name)).toContain('Support_Agent');
  });

  it('captures explicit SOP agents, entrypoint, channels, MCP, memory, and tools', () => {
    const contract = extractSourceArchitectureContractFromText(
      MERCURY_SOP_EXCERPT,
      'mercury-bank-sop.md',
    );

    expect(contract).not.toBeNull();
    expect(contract?.entryAgent).toBe('Banking_Supervisor');
    expect(contract?.channels).toEqual(['Web', 'Voice', 'WhatsApp']);
    expect(contract?.requiredMcpServers).toContain('Mercury Banking Server');
    expect(contract?.declaredAgents.map((agent) => agent.name)).toEqual([
      'Banking_Supervisor',
      'Account_Info_Agent',
      'Credit_Card_Payment_Agent',
      'Credit_Card_Application_Agent',
      'Money_Transfer_Agent',
      'Dispute_Complaint_Agent',
      'Loan_Application_Agent',
      'Human_Escalation_Agent',
    ]);
    expect(contract?.sharedMemoryVariables).toContain('customer_id');
    expect(contract?.tools.map((tool) => tool.name)).toContain('initiate_payment');
    expect(
      contract?.declaredAgents.find((agent) => agent.name === 'Credit_Card_Payment_Agent')?.tools,
    ).toContain('get_credit_card_summary');
  });

  it('blocks collapsed topologies that drop source-declared agents', () => {
    const contract = extractSourceArchitectureContractFromText(
      MERCURY_SOP_EXCERPT,
      'mercury-bank-sop.md',
    );
    const collapsed = {
      entryPoint: 'Banking_Supervisor',
      agents: [
        {
          name: 'Banking_Supervisor',
          role: 'Router',
          executionMode: 'hybrid' as const,
          description: 'Routes banking requests.',
        },
        {
          name: 'BankingSpecialist',
          role: 'Generic banking specialist',
          executionMode: 'reasoning' as const,
          description: 'Handles all banking work.',
        },
      ],
      edges: [
        {
          from: 'Banking_Supervisor',
          to: 'BankingSpecialist',
          type: 'delegate' as const,
          condition: 'true',
        },
      ],
    };

    expect(validateTopologyAgainstSourceContract(collapsed, contract)).toContain(
      'uploaded source documents declare 8 agents',
    );
  });

  it('can synthesize a source-faithful topology from the SOP contract', () => {
    const contract = extractSourceArchitectureContractFromText(
      MERCURY_SOP_EXCERPT,
      'mercury-bank-sop.md',
    );
    const topology = synthesizeTopologyFromSourceContract(contract!);

    expect(topology?.entryPoint).toBe('Banking_Supervisor');
    expect(topology?.agents).toHaveLength(8);
    expect(topology?.agents.map((agent) => agent.name)).toContain('Human_Escalation_Agent');
    expect(topology?.edges.find((edge) => edge.to === 'Credit_Card_Payment_Agent')).toMatchObject({
      type: 'transfer',
      experienceMode: 'shared_voice_handoff',
    });
    expect(topology?.edges.find((edge) => edge.to === 'Human_Escalation_Agent')).toMatchObject({
      type: 'escalate',
      experienceMode: 'human_escalation',
    });
    expect(topology?.agents.find((agent) => agent.name === 'Banking_Supervisor')).toMatchObject({
      modelPolicy: {
        agentType: 'dispatcher',
        reasoningRequired: false,
        defaultModelClass: 'fast_tool_capable',
      },
    });
    expect(
      topology?.agents.find((agent) => agent.name === 'Credit_Card_Payment_Agent'),
    ).toMatchObject({
      modelPolicy: {
        agentType: 'support',
        reasoningRequired: false,
        defaultModelClass: 'fast_tool_capable',
      },
    });
    expect(
      topology?.agents.find((agent) => agent.name === 'Credit_Card_Payment_Agent')?.gatherFields,
    ).toBeUndefined();
    expect(validateTopologyAgainstSourceContract(topology!, contract)).toBeNull();
  });

  it('synthesizes internal advisory specialists as silent delegates', () => {
    const contract = extractSourceArchitectureContractFromText(
      `
# VoltMart SOP

Entry agent: \`Reception_Agent\`

| Agent | Role |
|-------|------|
| Reception_Agent | Customer-facing router for order and billing questions. |
| Orders_Agent | Customer-facing order specialist. |
| Policy_Advisor_Agent | Internal policy advisory agent for eligibility analysis; customer must not hear this specialist. |
`,
      'voltmart-sop.md',
    );

    const topology = synthesizeTopologyFromSourceContract(contract!);

    expect(topology?.edges.find((edge) => edge.to === 'Orders_Agent')).toMatchObject({
      type: 'transfer',
      experienceMode: 'shared_voice_handoff',
      expectReturn: true,
    });
    expect(topology?.edges.find((edge) => edge.to === 'Policy_Advisor_Agent')).toMatchObject({
      type: 'delegate',
      experienceMode: 'silent_delegate',
      expectReturn: true,
    });
    expect(validateTopologyAgainstSourceContract(topology!, contract)).toBeNull();
  });

  it('extracts VoltMart-like customer experience contract fields without concrete model IDs', () => {
    const contract = extractSourceArchitectureContractFromText(
      VOLTMART_CX_EXCERPT,
      'voltmart-cx-sop.md',
    );

    expect(contract).not.toBeNull();
    expect(contract?.welcomeShape).toMatchObject({
      personaName: 'Alex',
      openingLine: 'Hi, this is Alex at VoltMart. How can I help?',
      voiceMaxWords: 16,
      chatMaxWords: 28,
      continuity: 'single_perceived_agent',
    });
    expect(contract?.channelRules).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          channel: 'Voice',
          welcomeMaxWords: 18,
          responseMaxWords: 42,
          abbreviationPolicy: 'expand_for_voice',
          toolLatencyBridge: true,
        }),
        expect.objectContaining({
          channel: 'WhatsApp',
          requiresTemplate: true,
        }),
      ]),
    );
    expect(contract?.consentPolicies).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          toolName: 'create_replacement',
          action: 'replacement',
          mode: 'when_side_effects',
          requiredIn: 'conversation',
          scopeFields: ['order_id', 'customer_id', 'replacement_sku'],
          fallback: 'block',
        }),
        expect.objectContaining({
          toolName: 'issue_refund',
          action: 'refund',
          scopeFields: ['order_id', 'refund_amount'],
          fallback: 'block',
        }),
      ]),
    );
    expect(contract?.scenarioFixtures).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'Replacement request',
          channel: 'Voice',
          userMessage: 'My blender arrived cracked. Can you replace it?',
          expectedOutcome: 'Create replacement after order lookup and specific consent.',
          toolFixtures: expect.arrayContaining([
            {
              toolName: 'get_order',
              sampleInput: { order_id: 'VM-48217-A', customer_id: 'CUST-442' },
              response: 'damaged_delivered',
            },
            {
              toolName: 'create_replacement',
              sampleInput: {
                order_id: 'VM-48217-A',
                customer_id: 'CUST-442',
                replacement_sku: 'BLEND-9',
              },
              response: 'replacement_created',
            },
          ]),
        }),
      ]),
    );
    expect(
      contract?.declaredAgents.find((agent) => agent.name === 'Policy_Advisor_Agent')?.modelPolicy,
    ).toMatchObject({
      agentType: 'reasoning',
      reasoningRequired: true,
      defaultModelClass: 'reasoning',
    });

    const topology = synthesizeTopologyFromSourceContract(contract!);
    expect(topology?.agents.find((agent) => agent.name === 'Policy_Advisor_Agent')).toMatchObject({
      modelPolicy: {
        agentType: 'reasoning',
        reasoningRequired: true,
        defaultModelClass: 'reasoning',
      },
    });
    expect(JSON.stringify(contract)).not.toMatch(/\b(?:gpt|claude|gemini|o[134])-|anthropic\//i);
  });

  it('renders customer experience fields into the source contract prompt', () => {
    const contract = extractSourceArchitectureContractFromText(
      VOLTMART_CX_EXCERPT,
      'voltmart-cx-sop.md',
    );
    const prompt = renderSourceArchitectureContractPrompt(contract);

    expect(prompt).toContain('Welcome/customer experience:');
    expect(prompt).toContain('persona=Alex');
    expect(prompt).toContain('Channel rules:');
    expect(prompt).toContain('Consent policies:');
    expect(prompt).toContain('create_replacement: mode=when_side_effects');
    expect(prompt).toContain('Scenario fixtures:');
    expect(prompt).toContain('Replacement request (Voice)');
    expect(prompt).toContain('"reasoningRequired":true');
  });

  it('extracts and renders explicit tool call guidance from source catalog columns', () => {
    const contract = extractSourceArchitectureContractFromText(
      `
# VoltMart Tool Contract

| Agent | Role |
|-------|------|
| Reception_Agent | Customer support entry point. |

## Tool Catalog

| Tool | Signature | Description | Call When | Do Not Call When |
|------|-----------|-------------|-----------|------------------|
| \`get_order\` | \`get_order(order_id: string) -> {status: string}\` | Fetch current order state. | customer asks about order status; supervisor needs eligibility context | already have a fresh result this turn; no order_id is available |
| \`issue_refund\` | \`issue_refund(order_id: string, amount: number) -> {refund_id: string}\` | Issue the refund. | customer chose refund and consent is scoped to this order | customer is only asking for options |
`,
      'voltmart-tools.md',
    );

    expect(contract?.tools).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'get_order',
          callWhen: ['customer asks about order status', 'supervisor needs eligibility context'],
          doNotCallWhen: ['already have a fresh result this turn', 'no order_id is available'],
        }),
      ]),
    );

    const prompt = renderSourceArchitectureContractPrompt(contract);
    expect(prompt).toContain('Tool call guidance:');
    expect(prompt).toContain(
      'get_order: call_when=[customer asks about order status; supervisor needs eligibility context]',
    );
    expect(prompt).toContain(
      'do_not_call_when=[already have a fresh result this turn; no order_id is available]',
    );
  });

  it('preserves namespaced tool contracts and fixtures from source documents', () => {
    const contract = extractSourceArchitectureContractFromText(
      `
# Claims SOP

| Agent | Role |
|-------|------|
| Claims_Agent | Claims support entry point. |

## Claims_Agent

### Tools

- \`claims_core.get_status\`

## Tool Catalog

| Tool | Signature | Description | Call When | Do Not Call When |
|------|-----------|-------------|-----------|------------------|
| \`claims_core.get_status\` | \`claims_core_get_status(claim_id: string) -> {status: string}\` | Fetch claim status. | customer asks about a claim | already have a fresh claim result |

## Scenario Fixtures

| Scenario | User Message | Tool Responses |
|----------|--------------|----------------|
| Claim lookup | Check claim CLM-123. | claims_core.get_status({"claim_id":"CLM-123"}): {"status":"pending_review"} |
`,
      'claims-sop.md',
    );

    expect(contract?.declaredAgents[0]?.tools).toContain('claims_core.get_status');
    expect(contract?.tools).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'claims_core.get_status',
          signature: 'claims_core_get_status(claim_id: string) -> {status: string}',
          callWhen: ['customer asks about a claim'],
          doNotCallWhen: ['already have a fresh claim result'],
        }),
      ]),
    );
    expect(contract?.scenarioFixtures?.[0]?.toolFixtures).toEqual([
      {
        toolName: 'claims_core.get_status',
        sampleInput: { claim_id: 'CLM-123' },
        response: '{"status":"pending_review"}',
      },
    ]);
  });

  it('merges normalized and namespaced tool contracts as one logical tool', () => {
    const contract = extractSourceArchitectureContractFromFiles([
      {
        name: 'claims-catalog.md',
        content: `
# Claims Tools

| Tool | Signature | Description | Call When | Do Not Call When |
|------|-----------|-------------|-----------|------------------|
| \`claims_core.get_status\` | \`claims_core.get_status(claim_id: string) -> {status: string}\` | Fetch claim status. | customer asks about a claim | |
`,
      },
      {
        name: 'claims-fixtures.md',
        content: `
# Claims Tool Fixtures

| Tool | Signature | Description | Call When | Do Not Call When |
|------|-----------|-------------|-----------|------------------|
| \`claims_core_get_status\` | \`claims_core_get_status(claim_id: string, customer_id: string) -> {status: string, owner: string}\` | Fetch claim status with customer scope. | supervisor needs claim state | already have a fresh claim result |
`,
      },
    ]);

    expect(contract?.tools).toHaveLength(1);
    expect(contract?.tools[0]).toEqual(
      expect.objectContaining({
        name: 'claims_core.get_status',
        signature:
          'claims_core_get_status(claim_id: string, customer_id: string) -> {status: string, owner: string}',
        callWhen: ['customer asks about a claim', 'supervisor needs claim state'],
        doNotCallWhen: ['already have a fresh claim result'],
      }),
    );
  });

  it('keeps tool-only source contracts available when reading metadata', () => {
    const contract = getSourceArchitectureContractFromMetadata({
      sourceArchitectureContract: {
        sourceFiles: ['tool-only.md'],
        declaredAgents: [],
        channels: [],
        requiredMcpServers: [],
        sharedMemoryVariables: [],
        universalRules: [],
        guardrails: [],
        tools: [
          {
            name: 'get_order',
            signature: 'get_order(order_id: string) -> {status: string}',
            provenance: { fileName: 'tool-only.md' },
          },
        ],
        optionalExternalAgents: [],
        confidence: 0.8,
      },
    });

    expect(contract?.tools[0]?.name).toBe('get_order');
  });

  it('keeps legacy source contracts compatible when CX sections are absent', () => {
    const contract = extractSourceArchitectureContractFromText(
      `
# Legacy SOP

Entry agent: \`Legacy_Agent\`

| Agent | Role |
|-------|------|
| Legacy_Agent | Answers common support questions. |
`,
      'legacy-sop.md',
    );

    expect(contract).not.toBeNull();
    expect(contract?.welcomeShape).toBeUndefined();
    expect(contract?.channelRules).toEqual([]);
    expect(contract?.consentPolicies).toEqual([]);
    expect(contract?.scenarioFixtures).toEqual([]);
    expect(contract?.declaredAgents[0]?.modelPolicy).toMatchObject({
      agentType: 'dispatcher',
      reasoningRequired: false,
      defaultModelClass: 'fast_tool_capable',
    });
    expect(() => renderSourceArchitectureContractPrompt(contract)).not.toThrow();
  });
});
