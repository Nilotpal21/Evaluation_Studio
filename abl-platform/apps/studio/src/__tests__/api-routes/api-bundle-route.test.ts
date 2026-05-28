import { beforeEach, describe, expect, it, vi } from 'vitest';
import JSZip from 'jszip';
import { NextRequest, NextResponse } from 'next/server';

const mockRequireAuth = vi.fn();
const mockIsAuthError = vi.fn(() => false);
vi.mock('@/lib/auth', () => ({
  requireAuth: (...args: unknown[]) => mockRequireAuth(...args),
  isAuthError: (...args: unknown[]) => mockIsAuthError(...args),
}));

vi.mock('@/services/auth-service', () => ({
  verifyAccessToken: vi.fn(),
}));

vi.mock('@/repos/auth-repo', () => ({
  findUserById: vi.fn(),
}));

const mockRequireProjectAccess = vi.fn();
const mockIsAccessError = vi.fn(() => false);
vi.mock('@/lib/project-access', () => ({
  requireProjectAccess: (...args: unknown[]) => mockRequireProjectAccess(...args),
  isAccessError: (...args: unknown[]) => mockIsAccessError(...args),
}));

const mockProjectAgentFind = vi.fn();
const mockProjectToolFind = vi.fn();
const mockProjectConfigVariableFind = vi.fn();
const mockConnectorConfigFind = vi.fn();
const mockMCPServerConfigFind = vi.fn();
const mockProjectRuntimeConfigFindOne = vi.fn();
const mockProjectLLMConfigFindOne = vi.fn();
const mockValidateProjectRuntimeConfigWrite = vi.fn();
const mockGetProjectExportReadinessIssues = vi.fn();
const mockBuildInvalidProjectExportPayload = vi.fn((issues: unknown[]) => ({
  success: false,
  error: {
    code: 'INVALID_AGENT_DRAFT',
    message:
      'Export blocked because the project working copy has validation errors. Fix the draft or runtime config diagnostics before exporting or syncing.',
  },
  issues,
}));

vi.mock('@agent-platform/database/models', () => ({
  ProjectAgent: {
    find: (...args: unknown[]) => mockProjectAgentFind(...args),
  },
  ProjectTool: {
    find: (...args: unknown[]) => mockProjectToolFind(...args),
  },
  ProjectConfigVariable: {
    find: (...args: unknown[]) => mockProjectConfigVariableFind(...args),
  },
  ConnectorConfig: {
    find: (...args: unknown[]) => mockConnectorConfigFind(...args),
  },
  MCPServerConfig: {
    find: (...args: unknown[]) => mockMCPServerConfigFind(...args),
  },
  ProjectRuntimeConfig: {
    findOne: (...args: unknown[]) => ({
      lean: () => mockProjectRuntimeConfigFindOne(...args),
    }),
  },
  ProjectLLMConfig: {
    findOne: (...args: unknown[]) => ({
      lean: () => mockProjectLLMConfigFindOne(...args),
    }),
  },
}));

vi.mock('@agent-platform/project-io/import', () => ({
  validateProjectRuntimeConfigWrite: (...args: unknown[]) =>
    mockValidateProjectRuntimeConfigWrite(...args),
}));

vi.mock('@/lib/project-agent-export-readiness', () => ({
  getProjectExportReadinessIssues: (...args: unknown[]) =>
    mockGetProjectExportReadinessIssues(...args),
  buildInvalidProjectExportPayload: (...args: unknown[]) =>
    mockBuildInvalidProjectExportPayload(...args),
}));

const mockExportProjectV2 = vi.fn();
const mockResolveLayers = vi.fn();
const mockResolveLayersForToolDependencies = vi.fn((layers: unknown) => layers);
const mockScanProjectEnvVars = vi.fn();
const mockExtractProfileManifestEntries = vi.fn();
const mockBuildExportProvisioningRequirements = vi.fn(() => ({
  requiredEnvVars: [],
  requiredAuthProfiles: [],
  requiredConnectors: [],
  requiredMcpServers: [],
}));
vi.mock('@agent-platform/project-io/export', () => ({
  exportProjectV2: (...args: unknown[]) => mockExportProjectV2(...args),
  resolveLayers: (...args: unknown[]) => mockResolveLayers(...args),
  resolveLayersForToolDependencies: (...args: unknown[]) =>
    mockResolveLayersForToolDependencies(...args),
  scanProjectEnvVars: (...args: unknown[]) => mockScanProjectEnvVars(...args),
  extractProfileManifestEntries: (...args: unknown[]) => mockExtractProfileManifestEntries(...args),
  buildExportProvisioningRequirements: (...args: unknown[]) =>
    mockBuildExportProvisioningRequirements(...args),
}));

vi.mock('@agent-platform/project-io', () => ({
  behaviorProfileConfigKeyToName: (key: string) =>
    key.startsWith('profile:') ? key.slice('profile:'.length) : null,
}));

const mockBuildAssemblerMap = vi.fn();
vi.mock('@/lib/export-assemblers', () => ({
  buildAssemblerMap: (...args: unknown[]) => mockBuildAssemblerMap(...args),
}));

vi.mock('@abl/compiler/platform', () => ({
  createLogger: () => ({
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
  }),
}));

const mockFetch = vi.fn();

function makeChainable(data: unknown[]) {
  return {
    select: vi.fn().mockReturnValue({ lean: vi.fn().mockResolvedValue(data) }),
    lean: vi.fn().mockResolvedValue(data),
  };
}

function makeRequest(url: string): NextRequest {
  return new NextRequest(new URL(url, 'http://localhost:3000'), {
    headers: {
      Authorization: 'Bearer test-token',
    },
  });
}

describe('GET /api/projects/[id]/bundle', () => {
  const testUser = {
    id: 'user-1',
    tenantId: 'tenant-1',
    email: 'test@example.com',
  };
  const routeContext = { params: Promise.resolve({ id: 'project-1' }) };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('fetch', mockFetch);

    mockRequireAuth.mockResolvedValue(testUser);
    mockIsAuthError.mockReturnValue(false);
    mockRequireProjectAccess.mockResolvedValue({
      project: {
        id: 'project-1',
        tenantId: 'tenant-1',
        slug: 'support-ops',
        name: 'Support Ops',
        description: 'Support automation project',
        entryAgentName: 'support_agent',
      },
    });
    mockIsAccessError.mockReturnValue(false);
    mockProjectAgentFind.mockReturnValue(
      makeChainable([
        {
          name: 'support_agent',
          dslContent: 'AGENT support_agent',
          description: 'Primary agent',
          ownerId: 'user-1',
          ownerTeamId: null,
          systemPromptLibraryRef: {
            promptId: 'prompt-1',
            versionId: 'version-1',
            resolvedHash: 'hash-1',
          },
        },
      ]),
    );
    mockProjectToolFind.mockReturnValue(
      makeChainable([
        {
          name: 'search_docs',
          dslContent: 'TOOL search_docs',
        },
      ]),
    );
    mockProjectConfigVariableFind.mockReturnValue(
      makeChainable([
        {
          key: 'profile:voice_vip',
          value: 'BEHAVIOR_PROFILE voice_vip',
        },
      ]),
    );
    mockConnectorConfigFind.mockReturnValue(makeChainable([]));
    mockMCPServerConfigFind.mockReturnValue(makeChainable([]));
    mockProjectRuntimeConfigFindOne.mockResolvedValue(null);
    mockProjectLLMConfigFindOne.mockResolvedValue(null);
    mockValidateProjectRuntimeConfigWrite.mockResolvedValue({ valid: true, data: {} });
    mockGetProjectExportReadinessIssues.mockResolvedValue([]);
    mockResolveLayers.mockReturnValue(['core']);
    mockBuildAssemblerMap.mockReturnValue(new Map());
    mockScanProjectEnvVars.mockReturnValue([]);
    mockExtractProfileManifestEntries.mockReturnValue([
      {
        name: 'voice_vip',
        file: 'behavior_profiles/voice_vip.behavior_profile.abl',
        sha256: 'sha-voice-vip',
        attached_agents: [],
      },
    ]);
    mockExportProjectV2.mockResolvedValue({
      success: true,
      manifest: { format_version: '2.0', project_name: 'support-ops' },
      lockfile: { version: '1.0' },
      files: new Map([
        ['agents/support_agent.agent.yaml', 'agent: support_agent'],
        ['tools/search_docs.tools.abl', 'TOOL search_docs'],
        ['behavior_profiles/voice_vip.behavior_profile.abl', 'BEHAVIOR_PROFILE voice_vip'],
        ['locales/es/support_agent.json', '{"goodbye":"Adios"}'],
        ['project.json', '{"format_version":"2.0"}'],
        ['abl.lock', '{"version":"1.0"}'],
      ]),
      warnings: [],
    });
  });

  it('streams canonical exported files for agents, tools, profiles, and locales', async () => {
    const { GET } = await import('@/app/api/projects/[id]/bundle/route');
    const response = await GET(makeRequest('/api/projects/project-1/bundle'), routeContext);

    expect(response.status).toBe(200);
    expect(mockExportProjectV2).toHaveBeenCalledTimes(1);

    const zipBuffer = await response.arrayBuffer();
    const zip = await JSZip.loadAsync(zipBuffer);
    expect(await zip.file('agents/support_agent.agent.yaml')?.async('string')).toBe(
      'agent: support_agent',
    );
    expect(await zip.file('tools/search_docs.tools.abl')?.async('string')).toBe('TOOL search_docs');
    expect(
      await zip.file('behavior_profiles/voice_vip.behavior_profile.abl')?.async('string'),
    ).toBe('BEHAVIOR_PROFILE voice_vip');
    expect(await zip.file('locales/es/support_agent.json')?.async('string')).toBe(
      '{"goodbye":"Adios"}',
    );
    expect(await zip.file('project.json')?.async('string')).toBe('{"format_version":"2.0"}');
  });

  it('short-circuits auth failures before exporting project data', async () => {
    const authError = NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    mockRequireAuth.mockResolvedValue(authError);
    mockIsAuthError.mockReturnValue(true);

    const { GET } = await import('@/app/api/projects/[id]/bundle/route');
    const response = await GET(makeRequest('/api/projects/project-1/bundle'), routeContext);

    expect(response.status).toBe(401);
    expect(mockExportProjectV2).not.toHaveBeenCalled();
  });

  it('blocks bundle generation when a saved draft has validation errors', async () => {
    mockGetProjectExportReadinessIssues.mockResolvedValue([
      {
        kind: 'agent_draft',
        agentName: 'support_agent',
        diagnostics: [{ severity: 'error', message: 'Invalid flow step', source: 'studio-save' }],
      },
    ]);
    mockProjectAgentFind.mockReturnValue(
      makeChainable([
        {
          name: 'support_agent',
          dslContent: 'AGENT support_agent\nBROKEN',
          description: 'Primary agent',
          ownerId: 'user-1',
          ownerTeamId: null,
          dslValidationStatus: 'error',
          dslDiagnostics: [
            { severity: 'error', message: 'Invalid flow step', source: 'studio-save' },
          ],
        },
      ]),
    );

    const { GET } = await import('@/app/api/projects/[id]/bundle/route');
    const response = await GET(makeRequest('/api/projects/project-1/bundle'), routeContext);

    expect(response.status).toBe(409);
    expect(mockExportProjectV2).not.toHaveBeenCalled();
    const body = await response.json();
    expect(body.error.code).toBe('INVALID_AGENT_DRAFT');
    expect(body.issues[0].agentName).toBe('support_agent');
    expect(body.issues[0].kind).toBe('agent_draft');
  });

  it('blocks bundle generation when runtime config is invalid', async () => {
    mockGetProjectExportReadinessIssues.mockResolvedValue([
      {
        kind: 'runtime_config',
        diagnostics: [
          {
            severity: 'error',
            message: 'Runtime filler promptRef must reference an active project prompt version',
            source: 'export-runtime-config-readiness',
          },
        ],
      },
    ]);
    mockProjectRuntimeConfigFindOne.mockResolvedValue({
      filler: {
        enabled: true,
        promptRef: { promptId: 'prompt-1', versionId: 'archived-version' },
      },
      tenantId: 'tenant-1',
      projectId: 'project-1',
    });
    mockValidateProjectRuntimeConfigWrite.mockResolvedValue({
      valid: false,
      code: 'RUNTIME_CONFIG_PROMPT_REF_INVALID',
      status: 400,
      message: 'Runtime filler promptRef must reference an active project prompt version',
    });

    const { GET } = await import('@/app/api/projects/[id]/bundle/route');
    const response = await GET(makeRequest('/api/projects/project-1/bundle'), routeContext);

    expect(response.status).toBe(409);
    expect(mockExportProjectV2).not.toHaveBeenCalled();
    const body = await response.json();
    expect(body.error.code).toBe('INVALID_AGENT_DRAFT');
    expect(body.issues).toEqual([
      {
        kind: 'runtime_config',
        diagnostics: [
          {
            severity: 'error',
            message: 'Runtime filler promptRef must reference an active project prompt version',
            source: 'export-runtime-config-readiness',
          },
        ],
      },
    ]);
  });
});
