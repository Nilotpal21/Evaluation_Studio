import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('server-only', () => ({}));

const {
  mockRequireAuth,
  mockIsAuthError,
  mockRequireProjectAccess,
  mockIsAccessError,
  mockValidatePostImport,
  mockEnvironmentVariableFind,
  mockConnectorConnectionFind,
  mockMcpServerConfigFind,
  mockGuardrailPolicyFind,
  mockGuardrailPolicyDistinct,
  mockTenantGuardrailProviderConfigFind,
  mockAuthProfileFind,
  mockProjectAgentFind,
  mockProjectToolFind,
  mockProjectConfigVariableFind,
} = vi.hoisted(() => ({
  mockRequireAuth: vi.fn(),
  mockIsAuthError: vi.fn(() => false),
  mockRequireProjectAccess: vi.fn(),
  mockIsAccessError: vi.fn(() => false),
  mockValidatePostImport: vi.fn(),
  mockEnvironmentVariableFind: vi.fn(),
  mockConnectorConnectionFind: vi.fn(),
  mockMcpServerConfigFind: vi.fn(),
  mockGuardrailPolicyFind: vi.fn(),
  mockGuardrailPolicyDistinct: vi.fn(),
  mockTenantGuardrailProviderConfigFind: vi.fn(),
  mockAuthProfileFind: vi.fn(),
  mockProjectAgentFind: vi.fn(),
  mockProjectToolFind: vi.fn(),
  mockProjectConfigVariableFind: vi.fn(),
}));

vi.mock('@/lib/auth', () => ({
  requireAuth: mockRequireAuth,
  isAuthError: mockIsAuthError,
}));

vi.mock('@/lib/project-access', () => ({
  requireProjectAccess: mockRequireProjectAccess,
  isAccessError: mockIsAccessError,
}));

vi.mock('@/lib/permission-resolver', () => ({
  hasPermission: vi.fn(() => true),
}));

vi.mock('@/lib/feature-resolver', () => ({
  isFeatureEnabled: vi.fn().mockResolvedValue(true),
}));

vi.mock('@abl/compiler/platform', () => ({
  createLogger: vi.fn(() => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  })),
}));

vi.mock('@agent-platform/project-io/import', () => ({
  validatePostImport: (...args: unknown[]) => mockValidatePostImport(...args),
}));

function chain<T>(rows: T[]) {
  return {
    select: vi.fn(() => ({ lean: vi.fn(async () => rows) })),
    lean: vi.fn(() => ({ select: vi.fn(async () => rows) })),
  };
}

vi.mock('@agent-platform/database/models', () => ({
  EnvironmentVariable: {
    find: (...args: unknown[]) => mockEnvironmentVariableFind(...args),
  },
  ConnectorConnection: {
    find: (...args: unknown[]) => mockConnectorConnectionFind(...args),
  },
  MCPServerConfig: {
    find: (...args: unknown[]) => mockMcpServerConfigFind(...args),
  },
  GuardrailPolicy: {
    find: (...args: unknown[]) => mockGuardrailPolicyFind(...args),
    distinct: (...args: unknown[]) => mockGuardrailPolicyDistinct(...args),
  },
  TenantGuardrailProviderConfig: {
    find: (...args: unknown[]) => mockTenantGuardrailProviderConfigFind(...args),
  },
  AuthProfile: {
    find: (...args: unknown[]) => mockAuthProfileFind(...args),
  },
  ProjectAgent: {
    find: (...args: unknown[]) => mockProjectAgentFind(...args),
  },
  ProjectTool: {
    find: (...args: unknown[]) => mockProjectToolFind(...args),
  },
  ProjectConfigVariable: {
    find: (...args: unknown[]) => mockProjectConfigVariableFind(...args),
  },
}));

import { GET } from '../../app/api/projects/[id]/import/doctor/route';

const TENANT_ID = 'tenant-1';
const PROJECT_ID = 'project-1';

describe('GET /api/projects/:id/import/doctor', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRequireAuth.mockResolvedValue({
      id: 'user-1',
      tenantId: TENANT_ID,
      permissions: ['project:*'],
    });
    mockRequireProjectAccess.mockResolvedValue({
      project: { _id: PROJECT_ID, tenantId: TENANT_ID, ownerId: 'user-1' },
    });
    mockProjectAgentFind.mockReturnValue(
      chain([
        {
          name: 'SupportAgent',
          dslContent: 'AGENT: SupportAgent\nAUTH: crm-auth\nUse {{env.OPENAI_KEY}}',
        },
      ]),
    );
    mockProjectToolFind.mockReturnValue(
      chain([
        {
          name: 'lookup_customer',
          dslContent:
            'TOOL: lookup_customer\nCONNECTOR: salesforce-prod\nMCP_SERVER: github-mcp\nurl: {{env.API_BASE_URL}}',
        },
      ]),
    );
    mockProjectConfigVariableFind.mockReturnValue(
      chain([
        {
          key: 'profile:support-tone',
          value: 'PROFILE: support-tone\nSTYLE: "{{env.PROFILE_TONE_KEY}}"',
        },
      ]),
    );
    mockEnvironmentVariableFind.mockReturnValue(
      chain([{ key: 'OPENAI_KEY', encryptedValue: 'enc-openai' }]),
    );
    mockConnectorConnectionFind.mockReturnValue(
      chain([{ displayName: 'salesforce-prod', connectorName: 'salesforce-prod' }]),
    );
    mockMcpServerConfigFind.mockReturnValue(
      chain([{ name: 'github-mcp', authType: 'bearer', encryptedAuthConfig: 'enc-auth' }]),
    );
    mockGuardrailPolicyFind.mockReturnValue(chain([]));
    mockGuardrailPolicyDistinct.mockResolvedValue([]);
    mockTenantGuardrailProviderConfigFind.mockReturnValue(chain([]));
    mockAuthProfileFind.mockReturnValue(chain([{ name: 'crm-auth', authType: 'oauth2_client' }]));
    mockValidatePostImport.mockImplementation(async (_input, db) => {
      await db.getProjectEnvVars(PROJECT_ID, TENANT_ID);
      await db.getProjectMCPServers(PROJECT_ID, TENANT_ID);
      await db.getProjectAuthProfiles(PROJECT_ID, TENANT_ID);
      return {
        status: 'ready',
        provisioning_required: {
          env_vars: [],
          connectors_needing_credentials: [],
          mcp_servers_needing_auth: [],
          auth_profiles: [],
        },
        warnings: [],
        layer_summary: {},
      };
    });
  });

  it('derives referenced provisioning requirements from project DSL and uses current DB fields', async () => {
    const request = new NextRequest(`http://studio.local/api/projects/${PROJECT_ID}/import/doctor`);

    const response = await GET(request, { params: Promise.resolve({ id: PROJECT_ID }) });

    expect(response.status).toBe(200);
    expect(mockValidatePostImport).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: PROJECT_ID,
        tenantId: TENANT_ID,
        importedLayers: ['core'],
        referencedEnvVars: ['API_BASE_URL', 'OPENAI_KEY', 'PROFILE_TONE_KEY'],
        referencedConnectors: ['salesforce-prod'],
        referencedMCPServers: ['github-mcp'],
        referencedAuthProfiles: ['crm-auth'],
        layerCounts: {
          core: { imported: 3, skipped: 0 },
        },
      }),
      expect.any(Object),
    );
    expect(mockProjectConfigVariableFind).toHaveBeenCalledWith({
      projectId: PROJECT_ID,
      tenantId: TENANT_ID,
      key: /^profile:/,
    });
    expect(mockEnvironmentVariableFind).toHaveBeenCalledWith({
      projectId: PROJECT_ID,
      tenantId: TENANT_ID,
      environment: { $in: ['dev', 'global'] },
    });
    expect(mockMcpServerConfigFind).toHaveBeenCalledWith({
      projectId: PROJECT_ID,
      tenantId: TENANT_ID,
    });
    expect(mockAuthProfileFind).toHaveBeenCalledWith({
      tenantId: TENANT_ID,
      status: 'active',
      $and: [
        {
          $or: [{ projectId: PROJECT_ID }, { projectId: null }, { projectId: { $exists: false } }],
        },
        {
          $or: [{ environment: 'dev' }, { environment: null }, { environment: { $exists: false } }],
        },
        { $or: [{ visibility: 'personal', createdBy: 'user-1' }, { visibility: 'shared' }] },
        { $or: [{ expiresAt: null }, { expiresAt: { $gt: expect.any(Date) } }] },
      ],
    });
  });

  it('adapts current guardrail policy provider fields for post-import validation', async () => {
    mockGuardrailPolicyFind.mockReturnValue(
      chain([
        {
          name: 'rich-policy',
          rules: [
            { guardrailName: 'input-check', provider: 'rule-provider' },
            { guardrailName: 'local-check', check: 'true' },
          ],
          providerOverrides: [{ providerName: 'override-provider' }],
        },
      ]),
    );
    mockTenantGuardrailProviderConfigFind.mockReturnValue(
      chain([{ name: 'rule-provider' }, { name: 'configured-provider' }]),
    );
    mockValidatePostImport.mockImplementation(async (_input, db) => {
      const policies = await db.getProjectGuardrails(PROJECT_ID, TENANT_ID);
      const providers = await db.getTenantGuardrailProviders(TENANT_ID);
      return {
        status: 'ready',
        provisioning_required: {
          env_vars: [],
          connectors_needing_credentials: [],
          mcp_servers_needing_auth: [],
          auth_profiles: [],
        },
        warnings: [],
        layer_summary: {},
        observed: { policies, providers },
      };
    });

    const request = new NextRequest(
      `http://studio.local/api/projects/${PROJECT_ID}/import/doctor?layers=guardrails`,
    );

    await GET(request, { params: Promise.resolve({ id: PROJECT_ID }) });

    const report = await mockValidatePostImport.mock.results[0].value;
    expect(report.observed.policies).toEqual([
      {
        name: 'rich-policy',
        providerNames: ['override-provider', 'rule-provider'],
      },
    ]);
    expect(report.observed.providers).toEqual([
      { providerName: 'rule-provider' },
      { providerName: 'configured-provider' },
    ]);
    expect(mockGuardrailPolicyFind).toHaveBeenCalledWith({
      tenantId: TENANT_ID,
      $or: [
        { 'scope.type': 'project', 'scope.projectId': PROJECT_ID },
        { 'scope.type': 'agent', 'scope.projectId': PROJECT_ID },
      ],
    });
    expect(mockTenantGuardrailProviderConfigFind).toHaveBeenCalledWith({
      tenantId: TENANT_ID,
      isActive: true,
    });
    expect(mockGuardrailPolicyDistinct).not.toHaveBeenCalled();
  });
});
