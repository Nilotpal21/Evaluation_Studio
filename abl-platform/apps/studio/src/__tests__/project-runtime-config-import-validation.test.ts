import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockModelConfigDistinct = vi.fn();
const mockTenantModelDistinct = vi.fn();
const mockTenantModelFind = vi.fn();
const mockPromptLibraryVersionFindOne = vi.fn();
const mockEnsureDb = vi.fn();
const mockDealFind = vi.fn();
const mockSubscriptionFindOne = vi.fn();
const mockTenantFindOne = vi.fn();

vi.mock('@agent-platform/database/models', () => ({
  Deal: {
    find: (...args: unknown[]) => ({
      lean: () => ({
        exec: () => mockDealFind(...args),
      }),
    }),
  },
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
  Subscription: {
    findOne: (...args: unknown[]) => ({
      sort: () => ({
        lean: () => ({
          exec: () => mockSubscriptionFindOne(...args),
        }),
      }),
    }),
  },
  Tenant: {
    findOne: (...args: unknown[]) => ({
      lean: () => ({
        exec: () => mockTenantFindOne(...args),
      }),
    }),
  },
}));

vi.mock('@/lib/ensure-db', () => ({
  ensureDb: (...args: unknown[]) => mockEnsureDb(...args),
}));

import {
  createProjectRuntimeConfigSaveValidatorForFiles,
  validateProjectRuntimeConfigForSave,
} from '@/lib/project-runtime-config-import-validation';

describe('validateProjectRuntimeConfigForSave', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockModelConfigDistinct.mockResolvedValue([]);
    mockTenantModelDistinct.mockResolvedValue([]);
    mockTenantModelFind.mockResolvedValue([]);
    mockPromptLibraryVersionFindOne.mockResolvedValue(null);
    mockEnsureDb.mockResolvedValue(undefined);
    mockDealFind.mockResolvedValue([]);
    mockSubscriptionFindOne.mockResolvedValue({ planTier: 'ENTERPRISE' });
    mockTenantFindOne.mockResolvedValue(null);
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

    const result = await validateProjectRuntimeConfigForSave({
      tenantId: 'tenant-destination',
      projectId: 'project-1',
      sourceFile: 'config/runtime-config.json',
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

    expect(result.data?.pipeline).toMatchObject({
      modelSource: 'tenant',
      tenantModelId: 'tm-destination-pipeline',
    });
    expect(result.data?.filler).toMatchObject({
      modelSource: 'tenant',
      tenantModelId: 'tm-destination-filler',
    });
    expect(result.data?.pipeline).not.toHaveProperty('tenantModelRef');
    expect(result.data?.filler).not.toHaveProperty('tenantModelRef');
    expect(mockTenantModelFind).toHaveBeenNthCalledWith(1, {
      tenantId: 'tenant-destination',
      provider: 'openai',
      modelId: 'gpt-4o-realtime-preview-2025-06-03',
      isActive: true,
      inferenceEnabled: { $ne: false },
    });
    expect(mockTenantModelFind).toHaveBeenNthCalledWith(2, {
      tenantId: 'tenant-destination',
      provider: 'openai',
      modelId: 'gpt-4o-mini',
      isActive: true,
      inferenceEnabled: { $ne: false },
    });
  });

  it('validates project model filler refs by tenant and project scope', async () => {
    mockModelConfigDistinct.mockResolvedValue(['gpt-4o-mini']);

    const result = await validateProjectRuntimeConfigForSave({
      tenantId: 'tenant-1',
      projectId: 'project-1',
      sourceFile: 'config/runtime-config.json',
      data: {
        filler: {
          modelSource: 'project',
          modelId: 'gpt-4o-mini',
        },
      },
    });

    expect(result.valid).toBe(true);
    expect(mockModelConfigDistinct).toHaveBeenCalledWith('modelId', {
      modelId: { $in: ['gpt-4o-mini'] },
      projectId: 'project-1',
      tenantId: 'tenant-1',
    });
  });

  it('rejects advanced NLU imports when the tenant entitlement is disabled', async () => {
    mockSubscriptionFindOne.mockResolvedValueOnce({ planTier: 'TEAM' });

    const result = await validateProjectRuntimeConfigForSave({
      tenantId: 'tenant-1',
      projectId: 'project-1',
      sourceFile: 'config/runtime-config.json',
      data: {
        extraction: {
          nlu_provider: 'advanced',
          advanced_sidecar_url: 'https://advanced-nlu.example.com',
        },
      },
    });

    expect(result).toMatchObject({
      valid: false,
      status: 403,
      code: 'PLAN_FEATURE_UNAVAILABLE',
      message: 'Advanced NLU provider requires an Enterprise plan',
    });
    expect(mockDealFind).toHaveBeenCalledWith({
      organizationId: 'tenant-1',
      status: 'active',
    });
    expect(mockSubscriptionFindOne).toHaveBeenCalledWith({
      tenantId: 'tenant-1',
      status: 'active',
    });
  });

  it('accepts self-contained imported prompt bundles through the snapshot-aware validator factory', async () => {
    const validator = createProjectRuntimeConfigSaveValidatorForFiles(
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

    const result = await validator({
      tenantId: 'tenant-1',
      projectId: 'project-1',
      sourceFile: 'config/runtime-config.json',
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

    expect(result.valid).toBe(true);
    expect(mockPromptLibraryVersionFindOne).not.toHaveBeenCalled();
  });

  it('accepts runtime project model refs from project model configs in the same archive', async () => {
    mockModelConfigDistinct.mockResolvedValue([]);

    const validator = createProjectRuntimeConfigSaveValidatorForFiles(
      new Map([
        [
          'config/project-model-configs/GPT-4.1 Nano.model-config.json',
          JSON.stringify({
            name: 'GPT-4.1 Nano',
            modelId: 'gpt-4.1-nano-2025-04-14',
          }),
        ],
      ]),
    );

    const result = await validator({
      tenantId: 'tenant-1',
      projectId: 'project-1',
      sourceFile: 'config/runtime-config.json',
      data: {
        filler: {
          enabled: true,
          modelSource: 'project',
          modelId: 'gpt-4.1-nano-2025-04-14',
        },
      },
    });

    expect(result.valid).toBe(true);
    expect(mockModelConfigDistinct).toHaveBeenCalledWith('modelId', {
      modelId: { $in: ['gpt-4.1-nano-2025-04-14'] },
      projectId: 'project-1',
      tenantId: 'tenant-1',
    });
  });
});
