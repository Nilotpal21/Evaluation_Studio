import { beforeEach, describe, expect, it, vi } from 'vitest';
import { loadProjectToolsAsIR } from '../tools/load-project-tools-as-ir.js';

const mockProjectToolFind = vi.fn();
const mockWorkflowFindOne = vi.fn();
const mockWorkflowVersionFindOne = vi.fn();
const mockTriggerRegistrationFindOne = vi.fn();
const mockSearchIndexFindOne = vi.fn();

vi.mock('@agent-platform/database/models', () => ({
  ProjectTool: {
    find: (...args: unknown[]) => mockProjectToolFind(...args),
  },
  Workflow: {
    findOne: (...args: unknown[]) => mockWorkflowFindOne(...args),
  },
  WorkflowVersion: {
    findOne: (...args: unknown[]) => mockWorkflowVersionFindOne(...args),
  },
  TriggerRegistration: {
    findOne: (...args: unknown[]) => mockTriggerRegistrationFindOne(...args),
  },
  SearchIndex: {
    findOne: (...args: unknown[]) => mockSearchIndexFindOne(...args),
  },
}));

describe('loadProjectToolsAsIR', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSearchIndexFindOne.mockReturnValue({
      lean: () =>
        Promise.resolve({
          _id: 'idx-docs',
          tenantId: 'tenant-1',
          projectId: 'proj-1',
        }),
    });
  });

  it('preserves workflow_version pins and derives parameters from the pinned version definition', async () => {
    mockProjectToolFind.mockReturnValue({
      lean: () =>
        Promise.resolve([
          {
            name: 'run_orders',
            toolType: 'workflow',
            description: 'Run orders workflow',
            dslContent: [
              'run_orders() -> object',
              '  description: "Run orders workflow"',
              '  type: workflow',
              '  workflow_id: wf-1',
              '  workflow_version: v1.2.3',
              '  trigger_id: tr-webhook',
            ].join('\n'),
          },
        ]),
    });
    mockWorkflowFindOne.mockReturnValue({
      lean: () =>
        Promise.resolve({
          _id: 'wf-1',
          tenantId: 'tenant-1',
          projectId: 'proj-1',
          status: 'active',
          nodes: [],
          triggers: [],
        }),
    });
    mockWorkflowVersionFindOne.mockReturnValue({
      lean: () =>
        Promise.resolve({
          _id: 'ver-1',
          workflowId: 'wf-1',
          version: 'v1.2.3',
          definition: {
            nodes: [
              {
                nodeType: 'start',
                config: {
                  inputVariables: [
                    {
                      name: 'orderId',
                      type: 'string',
                      required: true,
                      description: 'Order identifier',
                    },
                  ],
                },
              },
            ],
            edges: [],
          },
        }),
    });
    mockTriggerRegistrationFindOne.mockReturnValue({
      lean: () =>
        Promise.resolve({
          _id: 'tr-webhook',
          tenantId: 'tenant-1',
          projectId: 'proj-1',
          workflowId: 'wf-1',
          triggerType: 'webhook',
          status: 'active',
          config: {},
        }),
    });

    const result = await loadProjectToolsAsIR('tenant-1', 'proj-1', new Set(['run_orders']));

    expect(mockProjectToolFind).toHaveBeenCalledWith({
      tenantId: 'tenant-1',
      projectId: 'proj-1',
      name: { $in: ['run_orders'] },
    });
    expect(result.tools).toHaveLength(1);
    expect(result.tools[0].workflow_binding).toMatchObject({
      workflowId: 'wf-1',
      workflowVersion: 'v1.2.3',
      triggerId: 'tr-webhook',
      mode: 'sync',
    });
    expect(result.tools[0].parameters).toEqual([
      {
        name: 'orderId',
        type: 'string',
        required: true,
        description: 'Order identifier',
      },
    ]);
  });

  it('uses workflow version inputSchema when it differs from start-node inputVariables', async () => {
    mockProjectToolFind.mockReturnValue({
      lean: () =>
        Promise.resolve([
          {
            name: 'run_loan',
            toolType: 'workflow',
            description: 'Run loan workflow',
            dslContent: [
              'run_loan(customer_id: string) -> object',
              '  description: "Run loan workflow"',
              '  type: workflow',
              '  workflow_id: wf-1',
              '  workflow_version: v2',
              '  trigger_id: tr-webhook',
            ].join('\n'),
          },
        ]),
    });
    mockWorkflowFindOne.mockReturnValue({
      lean: () =>
        Promise.resolve({
          _id: 'wf-1',
          tenantId: 'tenant-1',
          projectId: 'proj-1',
          status: 'active',
          nodes: [],
          triggers: [],
        }),
    });
    mockWorkflowVersionFindOne.mockReturnValue({
      lean: () =>
        Promise.resolve({
          _id: 'ver-2',
          workflowId: 'wf-1',
          version: 'v2',
          definition: {
            inputSchema: {
              type: 'object',
              required: ['application_id'],
              properties: {
                application_id: {
                  type: 'string',
                  description: 'Loan application identifier',
                },
                requested_amount: {
                  type: 'number',
                  description: 'Requested loan amount',
                },
              },
            },
            nodes: [
              {
                nodeType: 'start',
                config: {
                  inputVariables: [
                    {
                      name: 'customer_id',
                      type: 'string',
                      required: true,
                      description: 'Legacy start-node variable',
                    },
                  ],
                },
              },
            ],
            edges: [],
          },
        }),
    });
    mockTriggerRegistrationFindOne.mockReturnValue({
      lean: () =>
        Promise.resolve({
          _id: 'tr-webhook',
          tenantId: 'tenant-1',
          projectId: 'proj-1',
          workflowId: 'wf-1',
          triggerType: 'webhook',
          status: 'active',
          config: {},
        }),
    });

    const result = await loadProjectToolsAsIR('tenant-1', 'proj-1', new Set(['run_loan']));

    expect(result.tools[0].parameters).toEqual([
      {
        name: 'application_id',
        type: 'string',
        required: true,
        description: 'Loan application identifier',
      },
      {
        name: 'requested_amount',
        type: 'number',
        required: false,
        description: 'Requested loan amount',
      },
    ]);
    expect(result.tools[0].derivedParameterSchema).toEqual({
      type: 'object',
      required: ['application_id'],
      properties: {
        application_id: {
          type: 'string',
          description: 'Loan application identifier',
        },
        requested_amount: {
          type: 'number',
          description: 'Requested loan amount',
        },
      },
    });
  });

  it('maps auth_profile metadata into IR for workflow tool execution', async () => {
    mockProjectToolFind.mockReturnValue({
      lean: () =>
        Promise.resolve([
          {
            name: 'get_messages',
            toolType: 'http',
            description: 'Get Gmail messages',
            dslContent: [
              'get_messages() -> object',
              '  description: "Get Gmail messages"',
              '  type: http',
              '  endpoint: "https://gmail.googleapis.com/gmail/v1/users/me/messages"',
              '  method: GET',
              '  auth_profile: OAuth_AuthProfile',
              '  auth: oauth2_client',
              '  auth_jit: true',
              '  connection: shared',
              '  consent: preflight',
            ].join('\n'),
          },
        ]),
    });

    const result = await loadProjectToolsAsIR('tenant-1', 'proj-1', new Set(['get_messages']));

    expect(result.tools).toHaveLength(1);
    expect(result.tools[0]).toMatchObject({
      name: 'get_messages',
      tool_type: 'http',
      auth_profile_ref: 'OAuth_AuthProfile',
      jit_auth: true,
      connection_mode: 'shared',
      consent_mode: 'preflight',
      hints: expect.objectContaining({ requires_auth: true }),
    });
  });

  it('fails closed when workflow DSL references a workflow that no longer exists', async () => {
    mockProjectToolFind.mockReturnValue({
      lean: () =>
        Promise.resolve([
          {
            name: 'run_missing',
            toolType: 'workflow',
            description: 'Run missing workflow',
            dslContent: [
              'run_missing() -> object',
              '  description: "Run missing workflow"',
              '  type: workflow',
              '  workflow_id: wf-missing',
              '  trigger_id: tr-webhook',
            ].join('\n'),
          },
        ]),
    });
    mockWorkflowFindOne.mockReturnValue({
      lean: () => Promise.resolve(null),
    });
    mockWorkflowVersionFindOne.mockReturnValue({
      lean: () => Promise.resolve(null),
    });
    mockTriggerRegistrationFindOne.mockReturnValue({
      lean: () => Promise.resolve(null),
    });

    await expect(
      loadProjectToolsAsIR('tenant-1', 'proj-1', new Set(['run_missing'])),
    ).rejects.toThrow('Workflow not found');
  });

  it('fails closed instead of building an empty SearchAI binding for invalid persisted DSL', async () => {
    mockProjectToolFind.mockReturnValue({
      lean: () =>
        Promise.resolve([
          {
            name: 'search_docs',
            toolType: 'searchai',
            description: 'Search docs',
            dslContent: [
              'search_docs(query: string) -> object',
              '  description: "Search docs"',
              '  type: searchai',
              '  tenant_id: tenant-1',
            ].join('\n'),
          },
        ]),
    });

    await expect(
      loadProjectToolsAsIR('tenant-1', 'proj-1', new Set(['search_docs'])),
    ).rejects.toThrow('SearchAI tool requires index_id property');
  });

  it('fails closed when SearchAI DSL references an index outside the project', async () => {
    mockProjectToolFind.mockReturnValue({
      lean: () =>
        Promise.resolve([
          {
            name: 'search_docs',
            toolType: 'searchai',
            description: 'Search docs',
            dslContent: [
              'search_docs(query: string) -> object',
              '  description: "Search docs"',
              '  type: searchai',
              '  index_id: "idx-foreign"',
              '  tenant_id: "tenant-1"',
            ].join('\n'),
          },
        ]),
    });
    mockSearchIndexFindOne.mockReturnValueOnce({
      lean: () => Promise.resolve(null),
    });

    await expect(
      loadProjectToolsAsIR('tenant-1', 'proj-1', new Set(['search_docs'])),
    ).rejects.toThrow('SearchAI index not found in project');
    expect(mockSearchIndexFindOne).toHaveBeenCalledWith({
      _id: 'idx-foreign',
      tenantId: 'tenant-1',
      projectId: 'proj-1',
    });
  });

  it('preserves MCP server identity, headers, and namespace scope through runtime IR loading', async () => {
    mockProjectToolFind.mockReturnValue({
      lean: () =>
        Promise.resolve([
          {
            name: 'lookup_customer',
            toolType: 'mcp',
            description: 'Look up a customer through MCP',
            variableNamespaceIds: ['ns-tools', 'ns-region'],
            dslContent: [
              'lookup_customer(customerId: string) -> object',
              '  description: "Look up a customer through MCP"',
              '  type: mcp',
              '  server: "crm-mcp"',
              '  server_tool: "customers.lookup"',
              '  transport_type: streamable_http',
              '  headers:',
              '    X-Tenant-Region: "{{config.REGION}}"',
              '    X-Static: "stable"',
            ].join('\n'),
          },
        ]),
    });

    const result = await loadProjectToolsAsIR('tenant-1', 'proj-1', new Set(['lookup_customer']));

    expect(result.tools).toHaveLength(1);
    expect(result.tools[0]).toMatchObject({
      name: 'lookup_customer',
      tool_type: 'mcp',
      variable_namespace_ids: ['ns-tools', 'ns-region'],
      mcp_binding: {
        server: 'crm-mcp',
        tool: 'customers.lookup',
        headers: {
          'X-Tenant-Region': '{{config.REGION}}',
          'X-Static': 'stable',
        },
      },
    });
  });
});
