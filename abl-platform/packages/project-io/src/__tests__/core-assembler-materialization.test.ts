import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockProjectAgentFind = vi.fn();
const mockProjectToolFind = vi.fn();
const mockProjectSettingsFindOne = vi.fn();
const mockProjectRuntimeConfigFindOne = vi.fn();
const mockProjectLLMConfigFindOne = vi.fn();
const mockProjectFindOne = vi.fn();
const mockModelConfigFind = vi.fn();
const mockModelConfigCountDocuments = vi.fn();
const mockAgentModelConfigFind = vi.fn();
const mockEnvironmentVariableFind = vi.fn();
const mockProjectConfigVariableFind = vi.fn();
const mockMCPServerConfigFind = vi.fn();
const mockProjectAgentCountDocuments = vi.fn();
const mockProjectToolCountDocuments = vi.fn();
const mockProjectConfigVariableCountDocuments = vi.fn();
const mockMCPServerConfigCountDocuments = vi.fn();
const mockMaterializeProjectAgentExports = vi.fn();

vi.mock('@agent-platform/database', () => ({
  ProjectAgent: {
    find: (...args: unknown[]) => ({
      lean: () => ({
        select: () => mockProjectAgentFind(...args),
      }),
    }),
    countDocuments: (...args: unknown[]) => mockProjectAgentCountDocuments(...args),
  },
  ProjectTool: {
    find: (...args: unknown[]) => ({
      lean: () => ({
        select: () => mockProjectToolFind(...args),
      }),
    }),
    countDocuments: (...args: unknown[]) => mockProjectToolCountDocuments(...args),
  },
  ProjectSettings: {
    findOne: (...args: unknown[]) => ({
      lean: () => ({
        select: () => mockProjectSettingsFindOne(...args),
      }),
    }),
  },
  ProjectRuntimeConfig: {
    findOne: (...args: unknown[]) => ({
      lean: () => ({
        select: () => mockProjectRuntimeConfigFindOne(...args),
      }),
    }),
  },
  ProjectLLMConfig: {
    findOne: (...args: unknown[]) => ({
      lean: () => ({
        select: () => mockProjectLLMConfigFindOne(...args),
      }),
    }),
  },
  Project: {
    findOne: (...args: unknown[]) => ({ lean: () => mockProjectFindOne(...args) }),
  },
  ModelConfig: {
    find: (...args: unknown[]) => ({
      lean: () => ({
        select: () => mockModelConfigFind(...args),
      }),
    }),
    countDocuments: (...args: unknown[]) => mockModelConfigCountDocuments(...args),
  },
  AgentModelConfig: {
    find: (...args: unknown[]) => ({
      lean: () => ({
        select: () => mockAgentModelConfigFind(...args),
      }),
    }),
  },
  EnvironmentVariable: {
    find: (...args: unknown[]) => ({
      lean: () => ({
        select: () => mockEnvironmentVariableFind(...args),
      }),
    }),
  },
  ProjectConfigVariable: {
    find: (...args: unknown[]) => ({
      lean: () => ({
        select: () => mockProjectConfigVariableFind(...args),
      }),
    }),
    countDocuments: (...args: unknown[]) => mockProjectConfigVariableCountDocuments(...args),
  },
  MCPServerConfig: {
    find: (...args: unknown[]) => ({
      lean: () => ({
        select: () => mockMCPServerConfigFind(...args),
      }),
    }),
    countDocuments: (...args: unknown[]) => mockMCPServerConfigCountDocuments(...args),
  },
}));

vi.mock('../export/agent-export-materializer.js', () => ({
  materializeAgentExport: vi.fn(),
  materializeProjectAgentExports: (...args: unknown[]) =>
    mockMaterializeProjectAgentExports(...args),
}));

vi.mock('@abl/compiler/platform', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

import { CoreAssembler } from '../export/layer-assemblers/core-assembler.js';

describe('CoreAssembler project-aware YAML materialization', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockProjectAgentFind.mockResolvedValue([
      {
        name: 'RouterAgent',
        description: 'Routes work',
        dslContent: 'AGENT: RouterAgent\nGOAL: "Route work"\n',
        systemPromptLibraryRef: {
          promptId: 'prompt-1',
          versionId: 'version-1',
        },
      },
      {
        name: 'SpecialistAgent',
        description: 'Does work',
        dslContent: 'AGENT: SpecialistAgent\nGOAL: "Do work"\n',
        systemPromptLibraryRef: null,
      },
    ]);
    mockProjectToolFind.mockResolvedValue([]);
    mockProjectSettingsFindOne.mockResolvedValue(null);
    mockProjectRuntimeConfigFindOne.mockResolvedValue({
      extraction: {
        strategy: 'hybrid',
      },
    });
    mockProjectLLMConfigFindOne.mockResolvedValue(null);
    mockProjectFindOne.mockResolvedValue({ _id: 'proj-1', tenantId: 'tenant-1' });
    mockModelConfigFind.mockResolvedValue([]);
    mockModelConfigCountDocuments.mockResolvedValue(0);
    mockAgentModelConfigFind.mockResolvedValue([]);
    mockEnvironmentVariableFind.mockResolvedValue([]);
    mockProjectConfigVariableFind.mockResolvedValue([
      {
        key: 'profile:voice_vip',
        value: 'BEHAVIOR_PROFILE: voice_vip\nPRIORITY: 10\nWHEN: true',
        description: null,
      },
    ]);
    mockMCPServerConfigFind.mockResolvedValue([]);
    mockProjectAgentCountDocuments.mockResolvedValue(2);
    mockProjectToolCountDocuments.mockResolvedValue(0);
    mockProjectConfigVariableCountDocuments.mockResolvedValue(1);
    mockMCPServerConfigCountDocuments.mockResolvedValue(0);
    mockMaterializeProjectAgentExports.mockResolvedValue(
      new Map([
        ['RouterAgent', { content: 'agent: RouterAgent\n', format: 'yaml', warnings: [] }],
        ['SpecialistAgent', { content: 'agent: SpecialistAgent\n', format: 'yaml', warnings: [] }],
      ]),
    );
  });

  it('passes full project context into project-aware YAML materialization', async () => {
    const assembler = new CoreAssembler();

    const result = await assembler.assemble({
      projectId: 'proj-1',
      tenantId: 'tenant-1',
      dslFormat: 'yaml',
    });

    expect(mockMaterializeProjectAgentExports).toHaveBeenCalledWith({
      projectId: 'proj-1',
      tenantId: 'tenant-1',
      agents: [
        {
          name: 'RouterAgent',
          dslContent: 'AGENT: RouterAgent\nGOAL: "Route work"\n',
          systemPromptLibraryRef: {
            promptId: 'prompt-1',
            versionId: 'version-1',
          },
        },
        {
          name: 'SpecialistAgent',
          dslContent: 'AGENT: SpecialistAgent\nGOAL: "Do work"\n',
          systemPromptLibraryRef: null,
        },
      ],
      configVariables: {
        'profile:voice_vip': 'BEHAVIOR_PROFILE: voice_vip\nPRIORITY: 10\nWHEN: true',
      },
      compilerOptions: expect.objectContaining({
        config_variables: {
          'profile:voice_vip': 'BEHAVIOR_PROFILE: voice_vip\nPRIORITY: 10\nWHEN: true',
        },
        project_runtime_config: expect.objectContaining({
          extraction_strategy: 'hybrid',
        }),
      }),
    });
    expect(result.files.get('agents/routeragent.agent.yaml')).toBe('agent: RouterAgent\n');
    expect(result.files.get('agents/specialistagent.agent.yaml')).toBe('agent: SpecialistAgent\n');
  });
});
