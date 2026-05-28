import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  mockCreateLogger,
  mockCreateProject,
  mockProjectExistsByName,
  mockAddAgentToProject,
  mockUpdateProject,
  mockDetectEntryAgent,
  mockArchSessionUpdateOne,
  mockCreateProjectTool,
  mockDeleteProjectTool,
  mockFindProjectToolByName,
  mockCountProjectToolsByProject,
  mockUpdateProjectTool,
  mockValidateUrlWithPlaceholders,
  mockIsCodeToolsEnabled,
  mockLogAuditEvent,
  mockGenerateToolTestEndpointCapabilities,
  mockUpsertToolTestEndpoint,
  mockVariableNamespaceFindOne,
  mockVariableNamespaceCreate,
  mockProjectConfigVariableFindOneAndUpdate,
  mockProjectConfigVariableDeleteMany,
  mockChannelConnectionUpdateOne,
  mockEnsureDb,
  mockJournalAppendAndEmit,
  mockRefreshProjectAgentDraftMetadataForToolMutation,
} = vi.hoisted(() => ({
  mockCreateLogger: vi.fn().mockReturnValue({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
  mockCreateProject: vi.fn(),
  mockProjectExistsByName: vi.fn(),
  mockAddAgentToProject: vi.fn(),
  mockUpdateProject: vi.fn(),
  mockDetectEntryAgent: vi.fn(),
  mockArchSessionUpdateOne: vi.fn(),
  mockCreateProjectTool: vi.fn(),
  mockDeleteProjectTool: vi.fn(),
  mockFindProjectToolByName: vi.fn(),
  mockCountProjectToolsByProject: vi.fn(),
  mockUpdateProjectTool: vi.fn(),
  mockValidateUrlWithPlaceholders: vi.fn(),
  mockIsCodeToolsEnabled: vi.fn(),
  mockLogAuditEvent: vi.fn(),
  mockGenerateToolTestEndpointCapabilities: vi.fn(),
  mockUpsertToolTestEndpoint: vi.fn(),
  mockVariableNamespaceFindOne: vi.fn(),
  mockVariableNamespaceCreate: vi.fn(),
  mockProjectConfigVariableFindOneAndUpdate: vi.fn(),
  mockProjectConfigVariableDeleteMany: vi.fn(),
  mockChannelConnectionUpdateOne: vi.fn(),
  mockEnsureDb: vi.fn().mockResolvedValue(undefined),
  mockJournalAppendAndEmit: vi.fn(),
  mockRefreshProjectAgentDraftMetadataForToolMutation: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@abl/compiler/platform', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@abl/compiler/platform')>();
  return {
    ...actual,
    createLogger: (...args: unknown[]) => mockCreateLogger(...args),
  };
});

vi.mock('@agent-platform/arch-ai/constructs', () => ({
  renderMissingMemoryWarning: () => 'Missing MEMORY section — add at minimum one session variable',
  renderSupervisorCatchAllHandoffWarning: () => 'Missing catch-all HANDOFF rule',
}));

vi.mock('@agent-platform/arch-ai/guardrails', () => ({
  renderMissingGuardrailsWarning: () => 'Missing GUARDRAILS section',
}));

vi.mock('@/services/project-service', () => ({
  createProject: (...args: unknown[]) => mockCreateProject(...args),
  projectExistsByName: (...args: unknown[]) => mockProjectExistsByName(...args),
  addAgentToProject: (...args: unknown[]) => mockAddAgentToProject(...args),
  updateProject: (...args: unknown[]) => mockUpdateProject(...args),
}));

vi.mock('@/lib/arch-ai/project-entry-agent', () => ({
  detectEntryAgent: (...args: unknown[]) => mockDetectEntryAgent(...args),
}));

vi.mock('@/lib/arch-ai/helpers/stream-helpers', () => ({
  journalAppendAndEmit: (...args: unknown[]) => mockJournalAppendAndEmit(...args),
}));

vi.mock('@/lib/arch-ai/request-timing', () => ({
  logArchTimeline: vi.fn(),
}));

vi.mock('@agent-platform/arch-ai/models', () => ({
  ArchSessionModel: {
    updateOne: (...args: unknown[]) => mockArchSessionUpdateOne(...args),
  },
}));

vi.mock('@agent-platform/shared/repos', () => ({
  createProjectTool: (...args: unknown[]) => mockCreateProjectTool(...args),
  deleteProjectTool: (...args: unknown[]) => mockDeleteProjectTool(...args),
  findProjectToolByName: (...args: unknown[]) => mockFindProjectToolByName(...args),
  countProjectToolsByProject: (...args: unknown[]) => mockCountProjectToolsByProject(...args),
  updateProjectTool: (...args: unknown[]) => mockUpdateProjectTool(...args),
}));

vi.mock('@/lib/resolve-and-validate-url', () => ({
  validateUrlWithPlaceholders: (...args: unknown[]) => mockValidateUrlWithPlaceholders(...args),
}));

vi.mock('@/lib/feature-gates', () => ({
  isCodeToolsEnabled: (...args: unknown[]) => mockIsCodeToolsEnabled(...args),
}));

vi.mock('@/services/audit-service', () => ({
  logAuditEvent: (...args: unknown[]) => mockLogAuditEvent(...args),
  AuditActions: {
    TOOL_CREATED: 'tool.created',
    TOOL_UPDATED: 'tool.updated',
  },
}));

vi.mock('@/lib/tool-test-endpoint-service', () => ({
  generateToolTestEndpointCapabilities: (...args: unknown[]) =>
    mockGenerateToolTestEndpointCapabilities(...args),
  upsertToolTestEndpoint: (...args: unknown[]) => mockUpsertToolTestEndpoint(...args),
}));

vi.mock('@/lib/project-tool-draft-invalidation', () => ({
  refreshProjectAgentDraftMetadataForToolMutation: (...args: unknown[]) =>
    mockRefreshProjectAgentDraftMetadataForToolMutation(...args),
}));

vi.mock('@agent-platform/database/models', () => ({
  Project: {
    db: {
      db: {
        collection: vi.fn(() => ({
          updateOne: (...args: unknown[]) => mockChannelConnectionUpdateOne(...args),
        })),
      },
    },
  },
  VariableNamespace: {
    findOne: (...args: unknown[]) => mockVariableNamespaceFindOne(...args),
    create: (...args: unknown[]) => mockVariableNamespaceCreate(...args),
  },
  ProjectConfigVariable: {
    findOneAndUpdate: (...args: unknown[]) => mockProjectConfigVariableFindOneAndUpdate(...args),
    deleteMany: (...args: unknown[]) => mockProjectConfigVariableDeleteMany(...args),
  },
}));

vi.mock('@/lib/ensure-db', () => ({
  ensureDb: (...args: unknown[]) => mockEnsureDb(...args),
}));

import { finalizeProject } from '@/lib/arch-ai/processors/finalize-project';
import { synthesizeOnboardingBootstrapTools } from '@/lib/arch-ai/tool-bootstrap-synthesizer';
import { upsertBootstrapHttpTool } from '@/lib/tool-creation-service';

function makeLeanQuery<T>(value: T) {
  return {
    lean: vi.fn().mockResolvedValue(value),
  };
}

function makeBootstrapContract() {
  return {
    name: 'lookup_customer',
    description: 'Lookup a customer by identifier',
    parameters: [
      {
        name: 'customer_id',
        type: 'string',
        required: true,
        description: 'Customer identifier',
      },
    ],
    returnType: '{id: string, status: string}',
  };
}

function makeSession() {
  return {
    id: 'sess-1',
    tenantId: 'tenant-1',
    userId: 'user-1',
    state: 'ACTIVE',
    metadata: {
      phase: 'BUILD',
      mode: 'ONBOARDING',
      specification: {
        projectName: 'Support Suite',
        description: 'Bootstrapped support workflow',
        channels: [],
        language: 'English',
      },
      pendingInteraction: null,
      messages: [],
      files: {
        lead_agent: {
          content: `AGENT: LeadAgent
GOAL: Help customers

TOOLS:
  lookup_customer(customer_id: string) -> {id: string, status: string}
    description: "Lookup customer"
  search_orders(query: string) -> {results: object[]}
    description: "Search orders"
  sync_crm(record_id: string) -> {success: boolean}
    description: "Sync CRM"
`,
        },
        followup_agent: {
          content: `AGENT: FollowupAgent
GOAL: Send follow-up messages

TOOLS:
  send_followup(customer_id: string) -> {sent: boolean}
    description: "Send a follow-up"
`,
        },
      },
      toolDsls: {
        sync_crm: `sync_crm(record_id: string) -> {success: boolean}
  description: "Sync CRM"
  type: sandbox
  runtime: "javascript"
  code: |
    return { success: true };`,
      },
    },
    createdAt: '2026-04-21T00:00:00.000Z',
    updatedAt: '2026-04-21T00:00:00.000Z',
  };
}

function makeSourceContractWithScenarioFixtures() {
  return {
    sourceFiles: ['voltmart-sop.md'],
    declaredAgents: [
      {
        name: 'LeadAgent',
        role: 'Route support requests',
        tools: ['lookup_customer', 'search_orders'],
        memoryVariables: [],
        limitations: [],
        provenance: { fileName: 'voltmart-sop.md', section: 'Agents' },
      },
    ],
    channels: ['Voice'],
    requiredMcpServers: [],
    sharedMemoryVariables: [],
    universalRules: [],
    guardrails: [],
    tools: [],
    scenarioFixtures: [
      {
        name: 'VIP lookup',
        channel: 'Voice',
        userMessage: 'Can you check customer CUST-442 and order VM-48217-A?',
        expectedOutcome: 'Find the VIP customer record.',
        toolFixtures: [
          {
            toolName: 'lookup_customer',
            sampleInput: { customer_id: 'CUST-442' },
            response: 'vip_customer_found',
          },
          {
            toolName: 'search_orders',
            response: '{"results":[{"status":"damaged_delivered"}]}',
          },
        ],
        provenance: { fileName: 'voltmart-sop.md', section: 'Scenario fixtures' },
      },
    ],
    optionalExternalAgents: [],
    confidence: 0.95,
  };
}

function makeSourceContractWithNestedScenarioFixture() {
  return {
    ...makeSourceContractWithScenarioFixtures(),
    scenarioFixtures: [
      {
        name: 'Damaged replacement',
        channel: 'Voice',
        userMessage:
          'Customer CUST-442 says order VM-48217-A arrived damaged. Email dana@example.com and send replacement SKU-77 with a $25 goodwill credit.',
        expectedOutcome: 'Replacement order is created for the damaged delivered order.',
        toolFixtures: [
          {
            toolName: 'create_replacement',
            sampleInput: {
              request: {
                order: {
                  replacement_sku: 'SKU-77-EXPRESS',
                },
              },
            },
            response: '{"replacement_id":"REP-991","status":"created"}',
          },
        ],
        provenance: { fileName: 'voltmart-sop.md', section: 'Scenario fixtures' },
      },
    ],
  };
}

describe('tool bootstrap synthesizer', () => {
  it('falls back to agent contracts when explicit DSL cannot be bootstrapped', () => {
    const session = makeSession();

    const result = synthesizeOnboardingBootstrapTools({
      toolDsls: session.metadata.toolDsls,
      agentFiles: session.metadata.files,
    });

    expect(result.tools.map((tool) => tool.contract.name)).toEqual([
      'lookup_customer',
      'search_orders',
      'sync_crm',
      'send_followup',
    ]);
    expect(result.unsupported).toEqual([]);
    expect(result.extractionErrors).toEqual([]);
    expect(result.tools[2]?.contract.parameters[0]?.description).toBe(
      'Input record id for sync_crm.',
    );

    expect(result.tools[0]?.sampleInput).toMatchObject({
      customer_id: expect.any(String),
    });
    expect(result.tools[0]?.staticResponse).toMatchObject({
      id: 'lookup_customer_001',
      status: 'ready',
    });
    expect(result.tools[1]?.staticResponse).toMatchObject({
      results: [expect.objectContaining({ status: 'ready' })],
    });
  });

  it('uses source-contract scenario fixtures for bootstrapped static responses and inputs', () => {
    const session = makeSession();

    const result = synthesizeOnboardingBootstrapTools({
      toolDsls: session.metadata.toolDsls,
      agentFiles: session.metadata.files,
      sourceContract: makeSourceContractWithScenarioFixtures(),
    });

    const lookupCustomer = result.tools.find((tool) => tool.contract.name === 'lookup_customer');
    const searchOrders = result.tools.find((tool) => tool.contract.name === 'search_orders');

    expect(lookupCustomer?.staticResponse).toMatchObject({
      id: 'lookup_customer_001',
      status: 'vip_customer_found',
    });
    expect(lookupCustomer?.sampleInput).toMatchObject({
      customer_id: 'CUST-442',
    });
    expect(searchOrders?.sampleInput).toMatchObject({
      query: 'Can you check customer CUST-442 and order VM-48217-A?',
    });
    expect(searchOrders?.staticResponse).toEqual({
      results: [{ status: 'damaged_delivered' }],
    });
  });

  it('unions repeated source fixtures for the same bootstrapped tool response', () => {
    const session = makeSession();

    const result = synthesizeOnboardingBootstrapTools({
      toolDsls: session.metadata.toolDsls,
      agentFiles: session.metadata.files,
      sourceContract: {
        ...makeSourceContractWithScenarioFixtures(),
        scenarioFixtures: [
          {
            name: 'VIP lookup',
            channel: 'Voice',
            userMessage: 'Can you check customer CUST-442?',
            toolFixtures: [
              {
                toolName: 'lookup_customer',
                sampleInput: { customer_id: 'CUST-442' },
                response: '{"id":"CUST-442","status":"vip_customer_found"}',
              },
            ],
            provenance: { fileName: 'voltmart-sop.md', section: 'Scenario fixtures' },
          },
          {
            name: 'Account risk lookup',
            channel: 'Web Chat',
            userMessage: 'Can you check customer CUST-777?',
            toolFixtures: [
              {
                toolName: 'lookup_customer',
                sampleInput: { customer_id: 'CUST-777' },
                response: '{"risk_level":"high","preferred_channel":"voice"}',
              },
            ],
            provenance: { fileName: 'voltmart-sop.md', section: 'Scenario fixtures' },
          },
        ],
      },
    });

    const lookupCustomer = result.tools.find((tool) => tool.contract.name === 'lookup_customer');

    expect(lookupCustomer?.sampleInput).toMatchObject({
      customer_id: 'CUST-442',
    });
    expect(lookupCustomer?.staticResponse).toEqual({
      id: 'CUST-442',
      status: 'vip_customer_found',
      risk_level: 'high',
      preferred_channel: 'voice',
    });
  });

  it('matches namespaced source fixtures to normalized bootstrap tool names', () => {
    const result = synthesizeOnboardingBootstrapTools({
      toolDsls: {
        claims_core_get_status: `claims_core_get_status(claim_id: string) -> {status: string}
  description: "Lookup claim status"
  type: http
  endpoint: "https://example.invalid/claims"
  method: POST`,
      },
      agentFiles: {},
      sourceContract: {
        ...makeSourceContractWithScenarioFixtures(),
        scenarioFixtures: [
          {
            name: 'Claim lookup',
            channel: 'Web Chat',
            userMessage: 'Can you check claim CLM-123?',
            toolFixtures: [
              {
                toolName: 'claims_core.get_status',
                sampleInput: { claim_id: 'CLM-123' },
                response: '{"status":"pending_review"}',
              },
            ],
            provenance: { fileName: 'claims-sop.md', section: 'Scenario fixtures' },
          },
        ],
      },
    });

    const claimStatus = result.tools.find(
      (tool) => tool.contract.name === 'claims_core_get_status',
    );

    expect(claimStatus?.sampleInput).toMatchObject({
      claim_id: 'CLM-123',
    });
    expect(claimStatus?.staticResponse).toEqual({
      status: 'pending_review',
    });
  });

  it('builds nested source-grounded sample inputs from object schemas', () => {
    const requestSchema = JSON.stringify({
      customer: {
        type: 'object',
        properties: {
          customer_id: { type: 'string' },
          email: { type: 'string' },
        },
      },
      order: {
        type: 'object',
        properties: {
          order_id: { type: 'string' },
          replacement_sku: { type: 'string' },
          reason: { type: 'string', enum: ['late', 'damaged', 'missing'] },
          goodwill_credit_amount: { type: 'number' },
        },
      },
      notify_customer: { type: 'boolean', default: true },
    });

    const result = synthesizeOnboardingBootstrapTools({
      toolDsls: {
        create_replacement: `create_replacement(request: object) -> {replacement_id: string, status: string}
  description: "Create replacement order"
  type: http
  endpoint: "https://example.invalid/replacements"
  method: POST
  params:
    request:
      description: "Replacement request payload"
      schema: ${JSON.stringify(requestSchema)}`,
      },
      agentFiles: {},
      sourceContract: makeSourceContractWithNestedScenarioFixture(),
    });

    const replacement = result.tools.find((tool) => tool.contract.name === 'create_replacement');

    expect(replacement?.sampleInput).toEqual({
      request: {
        customer: {
          customer_id: 'CUST-442',
          email: 'dana@example.com',
        },
        order: {
          order_id: 'VM-48217-A',
          replacement_sku: 'SKU-77-EXPRESS',
          reason: 'damaged',
          goodwill_credit_amount: 25,
        },
        notify_customer: true,
      },
    });
    expect(replacement?.staticResponse).toEqual({
      replacement_id: 'REP-991',
      status: 'created',
    });
  });

  it('folds flat source fixture inputs into object body parameters', () => {
    const requestSchema = JSON.stringify({
      type: 'object',
      properties: {
        order_id: { type: 'string' },
        customer_id: { type: 'string' },
        refund_amount: { type: 'number' },
      },
    });

    const result = synthesizeOnboardingBootstrapTools({
      toolDsls: {
        issue_refund: `issue_refund(request: object) -> {refund_id: string, status: string}
  description: "Issue refund"
  type: http
  endpoint: "https://example.invalid/refunds"
  method: POST
  params:
    request:
      description: "Refund request payload"
      schema: ${JSON.stringify(requestSchema)}`,
      },
      agentFiles: {},
      sourceContract: {
        ...makeSourceContractWithScenarioFixtures(),
        scenarioFixtures: [
          {
            name: 'Refund request',
            channel: 'Web Chat',
            userMessage: 'I want a refund for order VM-48219-C.',
            expectedOutcome: 'Refund is issued after consent.',
            toolFixtures: [
              {
                toolName: 'issue_refund',
                sampleInput: {
                  order_id: 'VM-48219-C',
                  customer_id: 'CUST-442',
                  refund_amount: 89.99,
                },
                response: '{"refund_id":"RF-9001","status":"issued"}',
              },
            ],
            provenance: { fileName: 'voltmart-sop.md', section: 'Scenario fixtures' },
          },
        ],
      },
    });

    const refund = result.tools.find((tool) => tool.contract.name === 'issue_refund');

    expect(refund?.sampleInput).toEqual({
      request: {
        order_id: 'VM-48219-C',
        customer_id: 'CUST-442',
        refund_amount: 89.99,
      },
    });
    expect(refund?.staticResponse).toEqual({
      refund_id: 'RF-9001',
      status: 'issued',
    });
  });

  it('selects object-body fixtures by schema fields before folding flat inputs', () => {
    const requestSchema = JSON.stringify({
      type: 'object',
      properties: {
        order_id: { type: 'string' },
        customer_id: { type: 'string' },
        refund_amount: { type: 'number' },
      },
    });

    const result = synthesizeOnboardingBootstrapTools({
      toolDsls: {
        issue_refund: `issue_refund(request: object) -> {refund_id: string, status: string}
  description: "Issue refund"
  type: http
  endpoint: "https://example.invalid/refunds"
  method: POST
  params:
    request:
      description: "Refund request payload"
      schema: ${JSON.stringify(requestSchema)}`,
      },
      agentFiles: {},
      sourceContract: {
        ...makeSourceContractWithScenarioFixtures(),
        scenarioFixtures: [
          {
            name: 'Weak refund fixture',
            channel: 'Web Chat',
            userMessage: 'I need help with my refund.',
            expectedOutcome: 'Generic refund support.',
            toolFixtures: [
              {
                toolName: 'issue_refund',
                sampleInput: { unrelated: 'ignore-me' },
                response: '{"refund_id":"RF-WRONG","status":"ignored"}',
              },
            ],
            provenance: { fileName: 'voltmart-sop.md', section: 'Scenario fixtures' },
          },
          {
            name: 'Specific refund fixture',
            channel: 'Web Chat',
            userMessage: 'I want a refund for order VM-48219-C.',
            expectedOutcome: 'Refund is issued after consent.',
            toolFixtures: [
              {
                toolName: 'issue_refund',
                sampleInput: {
                  order_id: 'VM-48219-C',
                  customer_id: 'CUST-442',
                  refund_amount: 89.99,
                },
                response: '{"refund_id":"RF-9001","status":"issued"}',
              },
            ],
            provenance: { fileName: 'voltmart-sop.md', section: 'Scenario fixtures' },
          },
        ],
      },
    });

    const refund = result.tools.find((tool) => tool.contract.name === 'issue_refund');

    expect(refund?.sampleInput).toEqual({
      request: {
        order_id: 'VM-48219-C',
        customer_id: 'CUST-442',
        refund_amount: 89.99,
      },
    });
    expect(refund?.staticResponse).toEqual({
      refund_id: 'RF-9001',
      status: 'issued',
    });
  });

  it('keeps selected fixture response fields when weaker fixtures appear later', () => {
    const requestSchema = JSON.stringify({
      type: 'object',
      properties: {
        order_id: { type: 'string' },
        customer_id: { type: 'string' },
        refund_amount: { type: 'number' },
      },
    });

    const result = synthesizeOnboardingBootstrapTools({
      toolDsls: {
        issue_refund: `issue_refund(request: object) -> {refund_id: string, status: string, audit_id: string}
  description: "Issue refund"
  type: http
  endpoint: "https://example.invalid/refunds"
  method: POST
  params:
    request:
      description: "Refund request payload"
      schema: ${JSON.stringify(requestSchema)}`,
      },
      agentFiles: {},
      sourceContract: {
        ...makeSourceContractWithScenarioFixtures(),
        scenarioFixtures: [
          {
            name: 'Specific refund fixture',
            channel: 'Web Chat',
            userMessage: 'I want a refund for order VM-48219-C.',
            expectedOutcome: 'Refund is issued after consent.',
            toolFixtures: [
              {
                toolName: 'issue_refund',
                sampleInput: {
                  order_id: 'VM-48219-C',
                  customer_id: 'CUST-442',
                  refund_amount: 89.99,
                },
                response: '{"refund_id":"RF-9001","status":"issued"}',
              },
            ],
            provenance: { fileName: 'voltmart-sop.md', section: 'Scenario fixtures' },
          },
          {
            name: 'Weak refund fixture',
            channel: 'Web Chat',
            userMessage: 'I need help with my refund.',
            expectedOutcome: 'Generic refund support.',
            toolFixtures: [
              {
                toolName: 'issue_refund',
                sampleInput: { unrelated: 'ignore-me' },
                response: '{"refund_id":"RF-WRONG","status":"ignored","audit_id":"AUD-1"}',
              },
            ],
            provenance: { fileName: 'voltmart-sop.md', section: 'Scenario fixtures' },
          },
        ],
      },
    });

    const refund = result.tools.find((tool) => tool.contract.name === 'issue_refund');

    expect(refund?.staticResponse).toEqual({
      audit_id: 'AUD-1',
      refund_id: 'RF-9001',
      status: 'issued',
    });
  });

  it('does not fold flat fixture fields that are real top-level parameters', () => {
    const requestSchema = JSON.stringify({
      type: 'object',
      properties: {
        refund_amount: { type: 'number' },
        reason: { type: 'string' },
      },
    });

    const result = synthesizeOnboardingBootstrapTools({
      toolDsls: {
        issue_refund: `issue_refund(request: object, order_id: string) -> {refund_id: string, status: string}
  description: "Issue refund"
  type: http
  endpoint: "https://example.invalid/refunds"
  method: POST
  params:
    request:
      description: "Refund request payload"
      schema: ${JSON.stringify(requestSchema)}
    order_id:
      description: "Order identifier"`,
      },
      agentFiles: {},
      sourceContract: {
        ...makeSourceContractWithScenarioFixtures(),
        scenarioFixtures: [
          {
            name: 'Refund request',
            channel: 'Web Chat',
            userMessage: 'I want a refund for order VM-48219-C.',
            expectedOutcome: 'Refund is issued after consent.',
            toolFixtures: [
              {
                toolName: 'issue_refund',
                sampleInput: {
                  order_id: 'VM-48219-C',
                  refund_amount: 89.99,
                  reason: 'lost_in_transit',
                },
                response: '{"refund_id":"RF-9001","status":"issued"}',
              },
            ],
            provenance: { fileName: 'voltmart-sop.md', section: 'Scenario fixtures' },
          },
        ],
      },
    });

    const refund = result.tools.find((tool) => tool.contract.name === 'issue_refund');

    expect(refund?.sampleInput).toEqual({
      request: {
        refund_amount: 89.99,
        reason: 'lost_in_transit',
      },
      order_id: 'VM-48219-C',
    });
  });

  it('folds flat source fixture inputs into nested array object body parameters', () => {
    const requestSchema = JSON.stringify({
      type: 'object',
      properties: {
        order_id: { type: 'string' },
        items: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              sku: { type: 'string' },
              quantity: { type: 'number' },
            },
          },
        },
      },
    });

    const result = synthesizeOnboardingBootstrapTools({
      toolDsls: {
        create_replacement: `create_replacement(request: object) -> {replacement_id: string, status: string}
  description: "Create replacement"
  type: http
  endpoint: "https://example.invalid/replacements"
  method: POST
  params:
    request:
      description: "Replacement request payload"
      schema: ${JSON.stringify(requestSchema)}`,
      },
      agentFiles: {},
      sourceContract: {
        ...makeSourceContractWithScenarioFixtures(),
        scenarioFixtures: [
          {
            name: 'Replacement request',
            channel: 'Web Chat',
            userMessage: 'I need a replacement for order VM-48217-A.',
            expectedOutcome: 'Replacement is created after consent.',
            toolFixtures: [
              {
                toolName: 'create_replacement',
                sampleInput: {
                  order_id: 'VM-48217-A',
                  sku: 'HP-900',
                  quantity: 1,
                },
                response: '{"replacement_id":"REP-9001","status":"created"}',
              },
            ],
            provenance: { fileName: 'voltmart-sop.md', section: 'Scenario fixtures' },
          },
        ],
      },
    });

    const replacement = result.tools.find((tool) => tool.contract.name === 'create_replacement');

    expect(replacement?.sampleInput).toEqual({
      request: {
        order_id: 'VM-48217-A',
        items: [{ sku: 'HP-900', quantity: 1 }],
      },
    });
  });

  it('folds dotted source fixture inputs into object body parameters', () => {
    const requestSchema = JSON.stringify({
      type: 'object',
      properties: {
        order_id: { type: 'string' },
        customer_id: { type: 'string' },
        refund_amount: { type: 'number' },
      },
    });

    const result = synthesizeOnboardingBootstrapTools({
      toolDsls: {
        issue_refund: `issue_refund(request: object) -> {refund_id: string, status: string}
  description: "Issue refund"
  type: http
  endpoint: "https://example.invalid/refunds"
  method: POST
  params:
    request:
      description: "Refund request payload"
      schema: ${JSON.stringify(requestSchema)}`,
      },
      agentFiles: {},
      sourceContract: {
        ...makeSourceContractWithScenarioFixtures(),
        scenarioFixtures: [
          {
            name: 'Weak refund fixture',
            channel: 'Web Chat',
            userMessage: 'I need help with my refund.',
            expectedOutcome: 'Generic refund support.',
            toolFixtures: [
              {
                toolName: 'issue_refund',
                sampleInput: { unrelated: 'ignore-me' },
                response: '{"refund_id":"RF-WRONG","status":"ignored"}',
              },
            ],
            provenance: { fileName: 'voltmart-sop.md', section: 'Scenario fixtures' },
          },
          {
            name: 'Dotted refund fixture',
            channel: 'Web Chat',
            userMessage: 'I want a refund for order VM-48219-C.',
            expectedOutcome: 'Refund is issued after consent.',
            toolFixtures: [
              {
                toolName: 'issue_refund',
                sampleInput: {
                  'request.order_id': 'VM-48219-C',
                  'request.customer_id': 'CUST-442',
                  'request.refund_amount': 89.99,
                },
                response: '{"refund_id":"RF-9001","status":"issued"}',
              },
            ],
            provenance: { fileName: 'voltmart-sop.md', section: 'Scenario fixtures' },
          },
        ],
      },
    });

    const refund = result.tools.find((tool) => tool.contract.name === 'issue_refund');

    expect(refund?.sampleInput).toEqual({
      request: {
        order_id: 'VM-48219-C',
        customer_id: 'CUST-442',
        refund_amount: 89.99,
      },
    });
    expect(refund?.staticResponse).toEqual({
      refund_id: 'RF-9001',
      status: 'issued',
    });
  });

  it('folds dotted source fixture inputs into nested array object body parameters', () => {
    const requestSchema = JSON.stringify({
      type: 'object',
      properties: {
        order_id: { type: 'string' },
        items: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              sku: { type: 'string' },
              quantity: { type: 'number' },
            },
          },
        },
      },
    });

    const result = synthesizeOnboardingBootstrapTools({
      toolDsls: {
        create_replacement: `create_replacement(request: object) -> {replacement_id: string, status: string}
  description: "Create replacement"
  type: http
  endpoint: "https://example.invalid/replacements"
  method: POST
  params:
    request:
      description: "Replacement request payload"
      schema: ${JSON.stringify(requestSchema)}`,
      },
      agentFiles: {},
      sourceContract: {
        ...makeSourceContractWithScenarioFixtures(),
        scenarioFixtures: [
          {
            name: 'Replacement request',
            channel: 'Web Chat',
            userMessage: 'I need a replacement for order VM-48217-A.',
            expectedOutcome: 'Replacement is created after consent.',
            toolFixtures: [
              {
                toolName: 'create_replacement',
                sampleInput: {
                  'request.order_id': 'VM-48217-A',
                  'items[].sku': 'HP-900',
                  'items[].quantity': 1,
                },
                response: '{"replacement_id":"REP-9001","status":"created"}',
              },
            ],
            provenance: { fileName: 'voltmart-sop.md', section: 'Scenario fixtures' },
          },
        ],
      },
    });

    const replacement = result.tools.find((tool) => tool.contract.name === 'create_replacement');

    expect(replacement?.sampleInput).toEqual({
      request: {
        order_id: 'VM-48217-A',
        items: [{ sku: 'HP-900', quantity: 1 }],
      },
    });
  });
});

describe('upsertBootstrapHttpTool', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    mockValidateUrlWithPlaceholders.mockResolvedValue({ safe: true });
    mockIsCodeToolsEnabled.mockResolvedValue(true);
    mockLogAuditEvent.mockResolvedValue(undefined);
    mockCountProjectToolsByProject.mockResolvedValue(0);
    mockVariableNamespaceFindOne.mockReturnValue(makeLeanQuery({ _id: 'ns-default' }));
    mockVariableNamespaceCreate.mockResolvedValue({
      toObject: () => ({ _id: 'ns-default' }),
    });
    mockDeleteProjectTool.mockResolvedValue(true);
  });

  it('creates a new HTTP tool with the generated Studio Test API invoke URL', async () => {
    const contract = makeBootstrapContract();

    mockFindProjectToolByName.mockResolvedValue(null);
    mockGenerateToolTestEndpointCapabilities.mockReturnValue({
      invokeCapability: 'tti_bootstrap_1',
      specCapability: 'tts_bootstrap_1',
      urls: {
        invokeUrl: 'https://studio.example.com/api/public/tool-test/tti_bootstrap_1',
        specUrl:
          'https://studio.example.com/api/public/tool-test/specs/tts_bootstrap_1/openapi.json',
      },
    });
    mockCreateProjectTool.mockImplementation(async (data: Record<string, unknown>) => ({
      id: 'tool-1',
      ...data,
      createdBy: data.createdBy,
      lastEditedBy: null,
      _v: 1,
      createdAt: '2026-04-21T00:00:00.000Z',
      updatedAt: '2026-04-21T00:00:00.000Z',
    }));
    mockUpsertToolTestEndpoint.mockResolvedValue({
      endpoint: { _id: 'endpoint-1' },
      urls: {
        invokeUrl: 'https://studio.example.com/api/public/tool-test/tti_bootstrap_1',
        specUrl:
          'https://studio.example.com/api/public/tool-test/specs/tts_bootstrap_1/openapi.json',
      },
    });

    const result = await upsertBootstrapHttpTool({
      tenantId: 'tenant-1',
      projectId: 'project-1',
      contract,
      staticResponse: { id: 'lookup_customer_001', status: 'ready' },
      sampleInput: { customer_id: 'test-id-001' },
      actorId: 'user-1',
    });

    expect(result.created).toBe(true);
    expect(mockCreateProjectTool).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: 'tenant-1',
        projectId: 'project-1',
        name: 'lookup_customer',
        toolType: 'http',
        variableNamespaceIds: ['ns-default'],
      }),
    );
    expect(mockCreateProjectTool.mock.calls[0]?.[0]?.dslContent).toContain(
      'endpoint: "https://studio.example.com/api/public/tool-test/tti_bootstrap_1"',
    );
    expect(mockCreateProjectTool.mock.calls[0]?.[0]?.dslContent).toContain('  headers:');
    expect(mockCreateProjectTool.mock.calls[0]?.[0]?.dslContent).toContain(
      '    Origin: "https://studio.example.com"',
    );
    expect(mockUpsertToolTestEndpoint).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: 'tenant-1',
        projectId: 'project-1',
        projectToolId: 'tool-1',
        invokeCapability: 'tti_bootstrap_1',
        specCapability: 'tts_bootstrap_1',
      }),
    );
    expect(mockRefreshProjectAgentDraftMetadataForToolMutation).toHaveBeenCalledWith({
      projectId: 'project-1',
      tenantId: 'tenant-1',
    });
  });

  it('updates an existing tool instead of creating a duplicate tool record', async () => {
    const contract = makeBootstrapContract();

    mockFindProjectToolByName.mockResolvedValue({
      id: 'tool-existing',
      tenantId: 'tenant-1',
      projectId: 'project-1',
      name: 'lookup_customer',
      slug: 'lookup_customer',
      toolType: 'http',
      description: 'Old description',
      dslContent: 'lookup_customer(customer_id: string) -> object',
      sourceHash: 'a'.repeat(64),
      variableNamespaceIds: ['ns-default'],
      createdBy: 'seed-user',
      lastEditedBy: null,
      _v: 1,
      createdAt: '2026-04-21T00:00:00.000Z',
      updatedAt: '2026-04-21T00:00:00.000Z',
    });
    mockUpsertToolTestEndpoint.mockResolvedValue({
      endpoint: { _id: 'endpoint-existing' },
      urls: {
        invokeUrl: 'https://studio.example.com/api/public/tool-test/tti_existing',
        specUrl: 'https://studio.example.com/api/public/tool-test/specs/tts_existing/openapi.json',
      },
    });
    mockUpdateProjectTool.mockResolvedValue({
      id: 'tool-existing',
      name: 'lookup_customer',
      toolType: 'http',
    });

    const result = await upsertBootstrapHttpTool({
      tenantId: 'tenant-1',
      projectId: 'project-1',
      contract,
      staticResponse: { id: 'lookup_customer_001', status: 'ready' },
      sampleInput: { customer_id: 'test-id-001' },
      actorId: 'user-1',
    });

    expect(result.created).toBe(false);
    expect(mockCreateProjectTool).not.toHaveBeenCalled();
    expect(mockUpdateProjectTool).toHaveBeenCalledWith(
      'tool-existing',
      'tenant-1',
      'project-1',
      expect.objectContaining({
        description: 'Lookup a customer by identifier',
        lastEditedBy: 'user-1',
      }),
    );
    expect(mockUpdateProjectTool.mock.calls[0]?.[3]?.dslContent).toContain(
      'endpoint: "https://studio.example.com/api/public/tool-test/tti_existing"',
    );
    expect(mockUpdateProjectTool.mock.calls[0]?.[3]?.dslContent).toContain('  headers:');
    expect(mockUpdateProjectTool.mock.calls[0]?.[3]?.dslContent).toContain(
      '    Origin: "https://studio.example.com"',
    );
    expect(mockRefreshProjectAgentDraftMetadataForToolMutation).toHaveBeenCalledWith({
      projectId: 'project-1',
      tenantId: 'tenant-1',
    });
  });
});

describe('finalizeProject bootstrap flow', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    mockProjectExistsByName.mockResolvedValue(false);
    mockCreateProject.mockResolvedValue({ id: 'project-1', name: 'Support Suite' });
    mockAddAgentToProject.mockResolvedValue(undefined);
    mockUpdateProject.mockResolvedValue(undefined);
    mockDetectEntryAgent.mockReturnValue('lead_agent');
    mockArchSessionUpdateOne.mockResolvedValue({ matchedCount: 1, modifiedCount: 1 });
    mockValidateUrlWithPlaceholders.mockResolvedValue({ safe: true });
    mockIsCodeToolsEnabled.mockResolvedValue(true);
    mockLogAuditEvent.mockResolvedValue(undefined);
    mockCountProjectToolsByProject.mockResolvedValue(0);
    mockVariableNamespaceFindOne.mockReturnValue(makeLeanQuery({ _id: 'ns-default' }));
    mockVariableNamespaceCreate.mockResolvedValue({
      toObject: () => ({ _id: 'ns-default' }),
    });
    mockProjectConfigVariableFindOneAndUpdate.mockResolvedValue({});
    mockProjectConfigVariableDeleteMany.mockResolvedValue({ deletedCount: 0 });
    mockChannelConnectionUpdateOne.mockResolvedValue({ upsertedCount: 1, matchedCount: 0 });
    mockJournalAppendAndEmit.mockResolvedValue(undefined);

    let createdToolIndex = 0;
    mockFindProjectToolByName.mockResolvedValue(null);
    mockCreateProjectTool.mockImplementation(async (data: Record<string, unknown>) => {
      createdToolIndex += 1;
      return {
        id: `tool-${createdToolIndex}`,
        ...data,
        createdBy: data.createdBy,
        lastEditedBy: null,
        _v: 1,
        createdAt: '2026-04-21T00:00:00.000Z',
        updatedAt: '2026-04-21T00:00:00.000Z',
      };
    });

    let capabilityIndex = 0;
    mockGenerateToolTestEndpointCapabilities.mockImplementation(() => {
      capabilityIndex += 1;
      return {
        invokeCapability: `tti_bootstrap_${capabilityIndex}`,
        specCapability: `tts_bootstrap_${capabilityIndex}`,
        urls: {
          invokeUrl: `https://studio.example.com/api/public/tool-test/tti_bootstrap_${capabilityIndex}`,
          specUrl: `https://studio.example.com/api/public/tool-test/specs/tts_bootstrap_${capabilityIndex}/openapi.json`,
        },
      };
    });
    mockUpsertToolTestEndpoint.mockImplementation(async (input: Record<string, unknown>) => ({
      endpoint: { _id: `endpoint-${input.projectToolId as string}` },
      urls: {
        invokeUrl: `https://studio.example.com/api/public/tool-test/${input.invokeCapability as string}`,
        specUrl: `https://studio.example.com/api/public/tool-test/specs/${input.specCapability as string}/openapi.json`,
      },
    }));
  });

  it('creates runnable HTTP tools for supported contracts and agent-contract fallbacks', async () => {
    const session = makeSession();
    const emit = vi.fn();
    const close = vi.fn();
    const sessionService = {
      getById: vi.fn().mockResolvedValue(session),
      transitionState: vi.fn().mockResolvedValue(undefined),
    };
    const journalService = {
      linkToProject: vi.fn().mockResolvedValue(undefined),
      query: vi.fn().mockResolvedValue([]),
      archiveSession: vi.fn().mockResolvedValue(undefined),
    };
    const specDocumentService = {
      linkToProject: vi.fn().mockResolvedValue(undefined),
    };
    const projectMemoryService = {
      extractMemoriesFromSession: vi.fn().mockResolvedValue(undefined),
    };

    await finalizeProject(
      { tenantId: 'tenant-1', userId: 'user-1' },
      session as never,
      emit,
      close,
      {
        sessionService: sessionService as never,
        journalService: journalService as never,
        specDocumentService: specDocumentService as never,
        projectMemoryService: projectMemoryService as never,
      },
    );

    expect(mockCreateProjectTool).toHaveBeenCalledTimes(4);
    expect(mockCreateProjectTool.mock.calls.map((call) => call[0]?.name)).toEqual([
      'lookup_customer',
      'search_orders',
      'sync_crm',
      'send_followup',
    ]);
    expect(mockUpsertToolTestEndpoint).toHaveBeenCalledTimes(4);
    expect(mockAddAgentToProject).toHaveBeenCalledTimes(2);
    expect(mockUpdateProject).toHaveBeenCalledWith(
      'project-1',
      { entryAgentName: 'lead_agent' },
      'tenant-1',
    );
    expect(mockChannelConnectionUpdateOne).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: 'tenant-1',
        projectId: 'project-1',
        channelType: 'http_async',
        externalIdentifier: 'http_async:tenant-1:project-1',
      }),
      expect.objectContaining({
        $setOnInsert: expect.objectContaining({
          displayName: 'Arch Web Chat',
          config: expect.objectContaining({
            source: 'arch_ai_onboarding',
            entryAgentName: 'lead_agent',
          }),
        }),
        $set: expect.objectContaining({ status: 'active' }),
      }),
      { upsert: true },
    );

    const textDeltas = emit.mock.calls
      .map((call) => call[0])
      .filter((event): event is { type: string; delta?: string } => event?.type === 'text_delta');
    expect(textDeltas.some((event) => event.delta?.includes('sync_crm (sandbox)'))).toBe(false);

    expect(sessionService.transitionState).toHaveBeenNthCalledWith(
      1,
      { tenantId: 'tenant-1', userId: 'user-1' },
      'sess-1',
      'ACTIVE',
      'COMPLETE',
    );
    expect(sessionService.transitionState).toHaveBeenNthCalledWith(
      2,
      { tenantId: 'tenant-1', userId: 'user-1' },
      'sess-1',
      'COMPLETE',
      'ARCHIVED',
    );
  });

  it('seeds hosted tool-test fixtures from source-contract scenario data', async () => {
    const session = {
      ...makeSession(),
      metadata: {
        ...makeSession().metadata,
        sourceArchitectureContract: makeSourceContractWithScenarioFixtures(),
      },
    };
    const emit = vi.fn();
    const close = vi.fn();
    const sessionService = {
      getById: vi.fn().mockResolvedValue(session),
      transitionState: vi.fn().mockResolvedValue(undefined),
    };
    const journalService = {
      linkToProject: vi.fn().mockResolvedValue(undefined),
      query: vi.fn().mockResolvedValue([]),
      archiveSession: vi.fn().mockResolvedValue(undefined),
    };
    const specDocumentService = {
      linkToProject: vi.fn().mockResolvedValue(undefined),
    };
    const projectMemoryService = {
      extractMemoriesFromSession: vi.fn().mockResolvedValue(undefined),
    };

    await finalizeProject(
      { tenantId: 'tenant-1', userId: 'user-1' },
      session as never,
      emit,
      close,
      {
        sessionService: sessionService as never,
        journalService: journalService as never,
        specDocumentService: specDocumentService as never,
        projectMemoryService: projectMemoryService as never,
      },
    );

    const lookupEndpointInput = mockUpsertToolTestEndpoint.mock.calls
      .map((call) => call[0] as Record<string, unknown>)
      .find((input) => input.toolName === 'lookup_customer');
    const searchEndpointInput = mockUpsertToolTestEndpoint.mock.calls
      .map((call) => call[0] as Record<string, unknown>)
      .find((input) => input.toolName === 'search_orders');

    expect(lookupEndpointInput?.staticResponse).toMatchObject({
      id: 'lookup_customer_001',
      status: 'vip_customer_found',
    });
    expect(lookupEndpointInput?.sampleInput).toMatchObject({
      customer_id: 'CUST-442',
    });
    expect(searchEndpointInput?.staticResponse).toEqual({
      results: [{ status: 'damaged_delivered' }],
    });
    expect(searchEndpointInput?.sampleInput).toMatchObject({
      query: 'Can you check customer CUST-442 and order VM-48217-A?',
    });
  });

  it('does not emit quality warnings for tool-less specialists or unquoted supervisor catch-alls', async () => {
    const session = {
      ...makeSession(),
      metadata: {
        ...makeSession().metadata,
        files: {
          ClaimsRouter: {
            path: 'agents/ClaimsRouter.abl.yaml',
            content: `SUPERVISOR: ClaimsRouter
GOAL: "Route claims"
MEMORY:
  session:
    - name: claim_type
      type: string
      initial_value: null
HANDOFF:
  - TO: IntakeSpecialist
    WHEN: true
    RETURN: true
GUARDRAILS:
  content_safety:
    kind: input
    tier: 1
    check: "Block harmful content"
    action: block
    threshold: 0.8
`,
          },
          IntakeSpecialist: {
            path: 'agents/IntakeSpecialist.abl.yaml',
            content: `AGENT: IntakeSpecialist
GOAL: "Collect claim details"
MEMORY:
  session:
    - name: summary
      type: string
      initial_value: null
GATHER:
  summary:
    type: string
    required: true
    prompt: "What happened?"
FLOW:
  steps:
    - collect
  collect:
    RESPOND: "Thanks, I have the intake details."
    THEN: COMPLETE
COMPLETE:
  - WHEN: "summary != null"
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
        toolDsls: {},
      },
    };
    const emit = vi.fn();
    const close = vi.fn();
    const sessionService = {
      getById: vi.fn().mockResolvedValue(session),
      transitionState: vi.fn().mockResolvedValue(undefined),
    };
    const journalService = {
      linkToProject: vi.fn().mockResolvedValue(undefined),
      query: vi.fn().mockResolvedValue([]),
      archiveSession: vi.fn().mockResolvedValue(undefined),
    };
    const specDocumentService = {
      linkToProject: vi.fn().mockResolvedValue(undefined),
    };
    const projectMemoryService = {
      extractMemoriesFromSession: vi.fn().mockResolvedValue(undefined),
    };

    await finalizeProject(
      { tenantId: 'tenant-1', userId: 'user-1' },
      session as never,
      emit,
      close,
      {
        sessionService: sessionService as never,
        journalService: journalService as never,
        specDocumentService: specDocumentService as never,
        projectMemoryService: projectMemoryService as never,
      },
    );

    const qualityDeltas = emit.mock.calls
      .map((call) => call[0])
      .filter((event): event is { type: string; delta?: string } => event?.type === 'text_delta')
      .filter((event) => event.delta?.includes('Quality scan found'));

    expect(qualityDeltas).toEqual([]);
  });

  it('persists managed shared-voice behavior profiles during project creation', async () => {
    const session = {
      ...makeSession(),
      metadata: {
        ...makeSession().metadata,
        specification: {
          ...makeSession().metadata.specification,
          channels: ['Web Chat', 'Voice'],
        },
        topology: {
          agents: [
            { name: 'lead_agent', role: 'Lead router', executionMode: 'reasoning' },
            { name: 'followup_agent', role: 'Follow-up specialist', executionMode: 'reasoning' },
          ],
          edges: [
            {
              from: 'lead_agent',
              to: 'followup_agent',
              type: 'transfer',
              experienceMode: 'shared_voice_handoff',
            },
          ],
          entryPoint: 'lead_agent',
        },
      },
    };
    const emit = vi.fn();
    const close = vi.fn();
    const sessionService = {
      getById: vi.fn().mockResolvedValue(session),
      transitionState: vi.fn().mockResolvedValue(undefined),
    };
    const journalService = {
      linkToProject: vi.fn().mockResolvedValue(undefined),
      query: vi.fn().mockResolvedValue([]),
      archiveSession: vi.fn().mockResolvedValue(undefined),
    };
    const specDocumentService = {
      linkToProject: vi.fn().mockResolvedValue(undefined),
    };
    const projectMemoryService = {
      extractMemoriesFromSession: vi.fn().mockResolvedValue(undefined),
    };

    await finalizeProject(
      { tenantId: 'tenant-1', userId: 'user-1' },
      session as never,
      emit,
      close,
      {
        sessionService: sessionService as never,
        journalService: journalService as never,
        specDocumentService: specDocumentService as never,
        projectMemoryService: projectMemoryService as never,
      },
    );

    expect(mockProjectConfigVariableFindOneAndUpdate).toHaveBeenCalledWith(
      {
        tenantId: 'tenant-1',
        projectId: 'project-1',
        key: 'profile:shared_voice_handoff',
      },
      expect.objectContaining({
        $set: expect.objectContaining({
          value: expect.stringContaining('BEHAVIOR_PROFILE: shared_voice_handoff'),
        }),
        $setOnInsert: expect.objectContaining({
          tenantId: 'tenant-1',
          projectId: 'project-1',
          key: 'profile:shared_voice_handoff',
          createdBy: 'user-1',
        }),
      }),
      { upsert: true },
    );
    expect(mockProjectConfigVariableFindOneAndUpdate.mock.calls[0]?.[1]?.$set?.value).toContain(
      'For voice, keep the first continuation short and natural.',
    );
    expect(mockProjectConfigVariableFindOneAndUpdate.mock.invocationCallOrder[0]).toBeLessThan(
      mockAddAgentToProject.mock.invocationCallOrder[0],
    );
  });
});
