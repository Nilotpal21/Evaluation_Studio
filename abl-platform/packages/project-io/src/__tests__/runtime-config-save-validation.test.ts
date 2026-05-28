import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockModelConfigDistinct = vi.fn();
const mockTenantModelDistinct = vi.fn();
const mockTenantModelFind = vi.fn();
const mockPromptLibraryVersionFindOne = vi.fn();

vi.mock('@agent-platform/database/models', () => ({
  ModelConfig: {
    distinct: (...args: unknown[]) => mockModelConfigDistinct(...args),
  },
  TenantModel: {
    distinct: (...args: unknown[]) => mockTenantModelDistinct(...args),
    find: (...args: unknown[]) => ({
      lean: () => mockTenantModelFind(...args),
    }),
  },
  PromptLibraryVersion: {
    findOne: (...args: unknown[]) => ({
      lean: () => mockPromptLibraryVersionFindOne(...args),
    }),
  },
}));

import {
  collectImportedProjectModelIds,
  collectImportedPromptVersionSnapshots,
  validateProjectRuntimeConfigWrite,
} from '../import/runtime-config-save-validation.js';

describe('validateProjectRuntimeConfigWrite', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockModelConfigDistinct.mockResolvedValue([]);
    mockTenantModelDistinct.mockResolvedValue([]);
    mockTenantModelFind.mockResolvedValue([]);
    mockPromptLibraryVersionFindOne.mockResolvedValue(null);
  });

  it('rejects advanced NLU configs without a sidecar URL during import validation', async () => {
    const result = await validateProjectRuntimeConfigWrite({
      tenantId: 'tenant-1',
      projectId: 'project-1',
      data: {
        extraction: {
          nlu_provider: 'advanced',
        },
      },
    });

    expect(result).toEqual({
      valid: false,
      status: 400,
      code: 'RUNTIME_CONFIG_ADVANCED_NLU_URL_REQUIRED',
      message: 'advanced_sidecar_url is required when nlu_provider is advanced',
    });
  });

  it('rejects runtime operation-tier overrides that route text operations to voice models', async () => {
    const result = await validateProjectRuntimeConfigWrite({
      tenantId: 'tenant-1',
      projectId: 'project-1',
      data: {
        operationTierOverrides: {
          response_gen: 'voice',
        },
      },
    });

    expect(result).toEqual({
      valid: false,
      status: 400,
      code: 'RUNTIME_CONFIG_OPERATION_TIERS_INVALID',
      message: expect.stringContaining('response_gen=voice'),
    });
  });

  it('accepts realtime voice operation-tier overrides during runtime config validation', async () => {
    const result = await validateProjectRuntimeConfigWrite({
      tenantId: 'tenant-1',
      projectId: 'project-1',
      data: {
        operationTierOverrides: {
          realtime_voice: 'voice',
        },
      },
    });

    expect(result).toEqual({
      valid: true,
      data: {
        operationTierOverrides: {
          realtime_voice: 'voice',
        },
      },
    });
  });

  it('strips top-level import staging metadata before runtime config schema validation', async () => {
    const result = await validateProjectRuntimeConfigWrite({
      tenantId: 'tenant-1',
      projectId: 'project-1',
      data: {
        projectId: 'project-1',
        tenantId: 'tenant-1',
        createdBy: 'user-1',
        sourceFile: 'config/runtime-config.json',
        _v: 0,
        operationTierOverrides: {
          realtime_voice: 'voice',
        },
      },
    });

    expect(result).toEqual({
      valid: true,
      data: {
        operationTierOverrides: {
          realtime_voice: 'voice',
        },
      },
    });
  });

  it('rebinding portable runtime tenant model refs to destination tenant model ids', async () => {
    mockTenantModelFind
      .mockResolvedValueOnce([
        {
          _id: 'tm-destination-pipeline',
          provider: 'openai',
          modelId: 'gpt-4o-realtime-preview-2025-06-03',
          tier: 'voice',
          capabilities: ['text', 'realtime_voice'],
        },
      ])
      .mockResolvedValueOnce([
        {
          _id: 'tm-destination-filler',
          provider: 'openai',
          modelId: 'gpt-4o-mini',
          tier: 'fast',
          capabilities: ['text'],
        },
      ]);
    mockTenantModelDistinct.mockResolvedValue(['tm-destination-pipeline', 'tm-destination-filler']);

    const result = await validateProjectRuntimeConfigWrite({
      tenantId: 'tenant-destination',
      projectId: 'project-1',
      data: {
        pipeline: {
          enabled: true,
          modelSource: 'tenant',
          tenantModelRef: {
            provider: 'openai',
            modelId: 'gpt-4o-realtime-preview-2025-06-03',
            tier: 'voice',
            capabilities: ['text', 'realtime_voice'],
          },
        },
        filler: {
          enabled: true,
          modelSource: 'tenant',
          tenantModelRef: {
            provider: 'openai',
            modelId: 'gpt-4o-mini',
            tier: 'fast',
            capabilities: ['text'],
          },
        },
      },
    });

    expect(result.valid).toBe(true);
    if (!result.valid) return;

    expect(result.data.pipeline).toMatchObject({
      modelSource: 'tenant',
      tenantModelId: 'tm-destination-pipeline',
    });
    expect(result.data.filler).toMatchObject({
      modelSource: 'tenant',
      tenantModelId: 'tm-destination-filler',
    });
    expect(result.data.pipeline).not.toHaveProperty('tenantModelRef');
    expect(result.data.filler).not.toHaveProperty('tenantModelRef');
  });

  it('accepts runtime-config prompt refs that are satisfied by imported prompt bundles', async () => {
    const importedPromptVersions = collectImportedPromptVersionSnapshots(
      new Map([
        [
          'prompts/support.prompt.json',
          JSON.stringify({
            promptId: 'prompt-1',
            name: 'support',
            tags: [],
            status: 'active',
            nextVersionNumber: 2,
            versions: [
              {
                versionId: 'version-1',
                versionNumber: 1,
                template: 'Hello {{user}}',
                variables: ['user'],
                status: 'active',
                sourceHash: 'hash-1',
              },
            ],
          }),
        ],
      ]),
    );

    const result = await validateProjectRuntimeConfigWrite({
      tenantId: 'tenant-1',
      projectId: 'project-1',
      data: {
        filler: {
          enabled: true,
          modelSource: 'system',
          promptRef: {
            promptId: 'prompt-1',
            versionId: 'version-1',
          },
        },
      },
      importedPromptVersions,
    });

    expect(result.valid).toBe(true);
    expect(mockPromptLibraryVersionFindOne).not.toHaveBeenCalled();
  });

  it('collects prompt refs from root-wrapped archives before runtime config validation', async () => {
    const importedPromptVersions = collectImportedPromptVersionSnapshots(
      new Map([
        [
          'mercury-bank/prompts/support.prompt.json',
          JSON.stringify({
            promptId: 'prompt-1',
            name: 'support',
            tags: [],
            status: 'active',
            nextVersionNumber: 2,
            versions: [
              {
                versionId: 'version-1',
                versionNumber: 1,
                template: 'Hello {{user}}',
                variables: ['user'],
                status: 'active',
                sourceHash: 'hash-1',
              },
            ],
          }),
        ],
        ['mercury-bank/config/runtime-config.json', JSON.stringify({})],
      ]),
    );

    const result = await validateProjectRuntimeConfigWrite({
      tenantId: 'tenant-1',
      projectId: 'project-1',
      data: {
        filler: {
          enabled: true,
          modelSource: 'system',
          promptRef: {
            promptId: 'prompt-1',
            versionId: 'version-1',
          },
        },
      },
      importedPromptVersions,
    });

    expect(result.valid).toBe(true);
    expect(mockPromptLibraryVersionFindOne).not.toHaveBeenCalled();
  });

  it('validates project model refs against the destination tenant project model pool', async () => {
    mockModelConfigDistinct.mockResolvedValue(['gpt-4o-mini']);

    const result = await validateProjectRuntimeConfigWrite({
      tenantId: 'tenant-destination',
      projectId: 'project-1',
      data: {
        filler: {
          enabled: true,
          modelSource: 'project',
          modelId: 'gpt-4o-mini',
        },
      },
    });

    expect(result.valid).toBe(true);
    expect(mockModelConfigDistinct).toHaveBeenCalledWith('modelId', {
      modelId: { $in: ['gpt-4o-mini'] },
      projectId: 'project-1',
      tenantId: 'tenant-destination',
    });
  });

  it('accepts project model refs that are staged in the same import archive', async () => {
    mockModelConfigDistinct.mockResolvedValue([]);

    const result = await validateProjectRuntimeConfigWrite({
      tenantId: 'tenant-destination',
      projectId: 'project-1',
      data: {
        filler: {
          enabled: true,
          modelSource: 'project',
          modelId: 'gpt-4.1-nano-2025-04-14',
        },
      },
      importedProjectModelIds: new Set(['gpt-4.1-nano-2025-04-14']),
    });

    expect(result.valid).toBe(true);
    expect(mockModelConfigDistinct).toHaveBeenCalledWith('modelId', {
      modelId: { $in: ['gpt-4.1-nano-2025-04-14'] },
      projectId: 'project-1',
      tenantId: 'tenant-destination',
    });
  });

  it('collects project model ids from project model config archive files', () => {
    const modelIds = collectImportedProjectModelIds(
      new Map([
        [
          'config/project-model-configs/GPT-4.1 Nano.model-config.json',
          JSON.stringify({
            name: 'GPT-4.1 Nano',
            modelId: 'gpt-4.1-nano-2025-04-14',
          }),
        ],
        ['config/runtime-config.json', JSON.stringify({ filler: { modelId: 'ignored' } })],
      ]),
    );

    expect([...modelIds]).toEqual(['gpt-4.1-nano-2025-04-14']);
  });

  it('collects project model ids from root-wrapped archive files', () => {
    const modelIds = collectImportedProjectModelIds(
      new Map([
        ['mercury-bank/config/runtime-config.json', JSON.stringify({})],
        [
          'mercury-bank/config/project-model-configs/GPT-4.1 Nano.model-config.json',
          JSON.stringify({
            name: 'GPT-4.1 Nano',
            modelId: 'gpt-4.1-nano-2025-04-14',
          }),
        ],
      ]),
    );

    expect([...modelIds]).toEqual(['gpt-4.1-nano-2025-04-14']);
  });

  it('rejects archived runtime-config prompt refs from imported prompt bundles', async () => {
    const importedPromptVersions = collectImportedPromptVersionSnapshots(
      new Map([
        [
          'prompts/support.prompt.json',
          JSON.stringify({
            promptId: 'prompt-1',
            name: 'support',
            tags: [],
            status: 'active',
            nextVersionNumber: 2,
            versions: [
              {
                versionId: 'version-1',
                versionNumber: 1,
                template: 'Hello {{user}}',
                variables: ['user'],
                status: 'archived',
                sourceHash: 'hash-1',
              },
            ],
          }),
        ],
      ]),
    );

    const result = await validateProjectRuntimeConfigWrite({
      tenantId: 'tenant-1',
      projectId: 'project-1',
      data: {
        filler: {
          enabled: true,
          modelSource: 'system',
          promptRef: {
            promptId: 'prompt-1',
            versionId: 'version-1',
          },
        },
      },
      importedPromptVersions,
    });

    expect(result).toEqual({
      valid: false,
      status: 400,
      code: 'RUNTIME_CONFIG_PROMPT_VERSION_NOT_FOUND',
      message: 'Selected prompt version must belong to this project and be available',
    });
  });

  it('rejects archived runtime-config prompt refs from the destination project', async () => {
    mockPromptLibraryVersionFindOne.mockResolvedValue({
      _id: 'version-1',
      promptId: 'prompt-1',
      status: 'archived',
    });

    const result = await validateProjectRuntimeConfigWrite({
      tenantId: 'tenant-1',
      projectId: 'project-1',
      data: {
        filler: {
          enabled: true,
          modelSource: 'system',
          promptRef: {
            promptId: 'prompt-1',
            versionId: 'version-1',
          },
        },
      },
    });

    expect(result).toEqual({
      valid: false,
      status: 400,
      code: 'RUNTIME_CONFIG_PROMPT_VERSION_NOT_FOUND',
      message: 'Selected prompt version must belong to this project and be available',
    });
  });
});
