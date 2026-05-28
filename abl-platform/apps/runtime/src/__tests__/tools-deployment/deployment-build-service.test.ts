import { beforeEach, describe, expect, test, vi } from 'vitest';
import { gunzipSync } from 'node:zlib';

const mockProjectModuleDependencyCountDocuments = vi.fn();
const mockProjectModuleDependencyFind = vi.fn();
const mockModuleReleaseFindOne = vi.fn();
const mockDeploymentModuleSnapshotCreate = vi.fn();
const mockProjectFindOne = vi.fn();
const mockLoadConfigVariablesMap = vi.fn();
const mockResolveSelector = vi.fn();
const mockMaterializeModuleToolDefinition = vi.fn();

function leanQuery<T>(resolver: () => T) {
  return { lean: resolver };
}

function prerequisiteFind() {
  return {
    select: () => ({
      lean: async () => [],
    }),
  };
}

vi.mock('@agent-platform/database/models', () => ({
  ProjectModuleDependency: {
    countDocuments: (...args: unknown[]) => mockProjectModuleDependencyCountDocuments(...args),
    find: (...args: unknown[]) => leanQuery(() => mockProjectModuleDependencyFind(...args)),
  },
  ModuleRelease: {
    findOne: (...args: unknown[]) => leanQuery(() => mockModuleReleaseFindOne(...args)),
  },
  DeploymentModuleSnapshot: {
    create: (...args: unknown[]) => mockDeploymentModuleSnapshotCreate(...args),
  },
  Project: {
    findOne: (...args: unknown[]) => leanQuery(() => mockProjectFindOne(...args)),
  },
  EnvironmentVariable: {
    find: prerequisiteFind,
  },
  MCPServerConfig: {
    find: prerequisiteFind,
  },
  ConnectorConnection: {
    find: prerequisiteFind,
  },
  ToolSecret: {
    find: prerequisiteFind,
  },
}));

vi.mock('../../repos/project-repo.js', () => ({
  loadConfigVariablesMap: (...args: unknown[]) => mockLoadConfigVariablesMap(...args),
}));

vi.mock('@agent-platform/project-io', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  resolveSelector: (...args: unknown[]) => mockResolveSelector(...args),
  materializeModuleToolDefinition: (...args: unknown[]) =>
    mockMaterializeModuleToolDefinition(...args),
}));

import { buildDeploymentModuleSnapshot } from '../../services/modules/deployment-build-service.js';

describe('buildDeploymentModuleSnapshot', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockProjectModuleDependencyCountDocuments.mockResolvedValue(1);
    mockProjectModuleDependencyFind.mockResolvedValue([
      {
        alias: 'dep',
        moduleProjectId: 'module-project-1',
        selector: { type: 'version', value: '1.0.0' },
        configOverrides: {},
      },
    ]);
    mockProjectFindOne.mockResolvedValue({
      _id: 'consumer-project-1',
      tenantId: 'tenant-1',
      moduleDependencyVersion: 0,
    });
    mockLoadConfigVariablesMap.mockResolvedValue({});
    mockResolveSelector.mockResolvedValue({
      releaseId: 'release-1',
      version: '1.0.0',
    });
    mockDeploymentModuleSnapshotCreate.mockResolvedValue({ _id: 'snapshot-1' });
  });

  test('preserves release-locked project runtime config when artifact sources recompile', async () => {
    const releaseRuntimeConfig = {
      multi_intent: {
        enabled: true,
        strategy: 'sequential',
        max_intents: 3,
      },
      correction_detection: 'llm',
    };
    mockModuleReleaseFindOne.mockResolvedValue({
      version: '1.0.0',
      contract: {},
      artifact: {
        agents: {
          module_agent: {
            dslContent: 'AGENT: module_agent\nGOAL: "Help users"',
            sourceHash: 'source-hash-1',
          },
        },
        tools: {},
      },
      compiledIR: {
        module_agent: {
          metadata: {
            name: 'module_agent',
            type: 'agent',
          },
          identity: {
            name: 'module_agent',
            goal: 'Help users',
          },
          project_runtime_config: releaseRuntimeConfig,
        },
      },
    });

    const result = await buildDeploymentModuleSnapshot(
      'tenant-1',
      'consumer-project-1',
      'deployment-1',
      0,
      new Set(),
    );

    expect(result?.success).toBe(true);
    expect(mockDeploymentModuleSnapshotCreate).toHaveBeenCalledTimes(1);
    const snapshotDoc = mockDeploymentModuleSnapshotCreate.mock.calls[0][0] as {
      compressedPayload: Buffer;
    };
    const payload = JSON.parse(
      gunzipSync(snapshotDoc.compressedPayload).toString('utf8'),
    ) as Record<
      string,
      {
        dep__module_agent: {
          ir: {
            project_runtime_config?: unknown;
          };
        };
      }
    >;

    expect(payload.mountedAgents.dep__module_agent.ir.project_runtime_config).toEqual(
      releaseRuntimeConfig,
    );
  });
});
