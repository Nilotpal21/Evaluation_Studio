import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockProjectFindOne = vi.fn();
const mockProjectAgentFind = vi.fn();
const mockProjectToolFind = vi.fn();
const mockProjectConfigVariableFind = vi.fn();
const mockDeploymentFind = vi.fn();
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
  ensureConnected: vi.fn().mockResolvedValue(undefined),
  Project: {
    findOne: (...args: unknown[]) => mockProjectFindOne(...args),
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
  Deployment: {
    find: (...args: unknown[]) => mockDeploymentFind(...args),
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

const mockExportProjectV2 = vi.fn();
const mockBuildExportProvisioningRequirements = vi.fn();
const mockResolveLayers = vi.fn();
const mockResolveLayersForToolDependencies = vi.fn((layers: unknown) => layers);
const mockScanProjectEnvVars = vi.fn();
const mockExtractProfileManifestEntries = vi.fn();

vi.mock('@agent-platform/project-io/export', () => ({
  exportProjectV2: (...args: unknown[]) => mockExportProjectV2(...args),
  buildExportProvisioningRequirements: (...args: unknown[]) =>
    mockBuildExportProvisioningRequirements(...args),
  resolveLayers: (...args: unknown[]) => mockResolveLayers(...args),
  resolveLayersForToolDependencies: (...args: unknown[]) =>
    mockResolveLayersForToolDependencies(...args),
  scanProjectEnvVars: (...args: unknown[]) => mockScanProjectEnvVars(...args),
  extractProfileManifestEntries: (...args: unknown[]) => mockExtractProfileManifestEntries(...args),
}));

vi.mock('@agent-platform/project-io', () => ({
  behaviorProfileConfigKeyToName: (key: string) =>
    key.startsWith('profile:') ? key.slice('profile:'.length) : null,
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

const mockBuildAssemblerMap = vi.fn();
vi.mock('@/lib/export-assemblers', () => ({
  buildAssemblerMap: (...args: unknown[]) => mockBuildAssemblerMap(...args),
}));

vi.mock('@abl/compiler/platform', () => ({
  createLogger: vi.fn(() => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  })),
}));

function makeChainable(data: unknown[]) {
  return {
    select: vi.fn().mockReturnValue({ lean: vi.fn().mockResolvedValue(data) }),
    lean: vi.fn().mockResolvedValue(data),
  };
}

describe('processExportJob', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    mockProjectFindOne.mockReturnValue({
      lean: vi.fn().mockResolvedValue({
        name: 'Support Ops',
        slug: 'support-ops',
        description: 'Primary support project',
        entryAgentName: 'support_agent',
      }),
    });
    mockProjectAgentFind.mockReturnValue(
      makeChainable([
        {
          name: 'support_agent',
          description: 'Handles support cases',
          dslContent: 'AGENT support_agent',
          dslValidationStatus: 'valid',
          dslDiagnostics: [],
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
    mockProjectToolFind.mockReturnValue(makeChainable([]));
    mockProjectConfigVariableFind.mockReturnValue(
      makeChainable([
        {
          key: 'profile:voice_vip',
          value: 'BEHAVIOR_PROFILE voice_vip',
        },
      ]),
    );
    mockDeploymentFind.mockReturnValue(makeChainable([]));
    mockConnectorConfigFind.mockReturnValue(makeChainable([]));
    mockMCPServerConfigFind.mockReturnValue(makeChainable([]));
    mockProjectRuntimeConfigFindOne.mockResolvedValue(null);
    mockProjectLLMConfigFindOne.mockResolvedValue(null);
    mockValidateProjectRuntimeConfigWrite.mockResolvedValue({ valid: true, data: {} });
    mockGetProjectExportReadinessIssues.mockResolvedValue([]);

    mockResolveLayers.mockReturnValue(['core']);
    mockBuildExportProvisioningRequirements.mockReturnValue({
      requiredEnvVars: [],
      requiredAuthProfiles: [],
      requiredConnectors: [],
      requiredMcpServers: [],
    });
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
      manifest: { format_version: '2.0' },
      lockfile: { version: '1.0' },
      files: new Map([['project.json', '{"format_version":"2.0"}']]),
      warnings: [],
    });
  });

  it('preserves systemPromptLibraryRef in async export manifest metadata', async () => {
    const { processExportJob } = await import('@/services/export-job-processor');

    const result = await processExportJob(
      {
        projectId: 'project-1',
        tenantId: 'tenant-1',
        userId: 'user-1',
        format: 'zip',
        dslFormat: 'source',
        includeDeployments: false,
      },
      vi.fn(),
    );

    expect(result.success).toBe(true);
    expect(mockExportProjectV2).toHaveBeenCalledTimes(1);

    const [, , manifestMeta] = mockExportProjectV2.mock.calls[0] as [
      unknown,
      unknown,
      {
        agents: Array<{
          name: string;
          systemPromptLibraryRef?: {
            promptId: string;
            versionId: string;
            resolvedHash?: string;
          } | null;
        }>;
      },
    ];

    expect(manifestMeta.agents).toEqual([
      {
        name: 'support_agent',
        description: 'Handles support cases',
        ownerId: 'user-1',
        ownerTeamId: null,
        version: null,
        systemPromptLibraryRef: {
          promptId: 'prompt-1',
          versionId: 'version-1',
          resolvedHash: 'hash-1',
        },
      },
    ]);
  });

  it('blocks async export when a saved draft has validation errors', async () => {
    mockGetProjectExportReadinessIssues.mockResolvedValue([
      {
        kind: 'agent_draft',
        agentName: 'broken_agent',
        diagnostics: [
          { severity: 'error', message: 'Unknown handoff target', source: 'studio-save' },
        ],
      },
    ]);
    mockProjectAgentFind.mockReturnValue(
      makeChainable([
        {
          name: 'broken_agent',
          description: 'Invalid draft',
          dslContent: 'AGENT: broken_agent\nBROKEN',
          ownerId: 'user-1',
          ownerTeamId: null,
          dslValidationStatus: 'error',
          dslDiagnostics: [
            {
              severity: 'error',
              message: 'Unknown handoff target',
              source: 'studio-save',
            },
          ],
        },
      ]),
    );
    const { processExportJob } = await import('@/services/export-job-processor');

    const result = await processExportJob(
      {
        projectId: 'project-1',
        tenantId: 'tenant-1',
        userId: 'user-1',
        format: 'zip',
        dslFormat: 'source',
        includeDeployments: false,
      },
      vi.fn(),
    );

    expect(result).toMatchObject({
      success: false,
      error: {
        code: 'INVALID_AGENT_DRAFT',
      },
    });
    expect(result).toMatchObject({
      issues: [{ kind: 'agent_draft', agentName: 'broken_agent' }],
    });
    expect(mockExportProjectV2).not.toHaveBeenCalled();
  });

  it('blocks async export when runtime config is invalid', async () => {
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

    const { processExportJob } = await import('@/services/export-job-processor');

    const result = await processExportJob(
      {
        projectId: 'project-1',
        tenantId: 'tenant-1',
        userId: 'user-1',
        format: 'zip',
        dslFormat: 'source',
        includeDeployments: false,
      },
      vi.fn(),
    );

    expect(result).toMatchObject({
      success: false,
      error: {
        code: 'INVALID_AGENT_DRAFT',
      },
      issues: [
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
      ],
    });
    expect(mockExportProjectV2).not.toHaveBeenCalled();
  });
});
