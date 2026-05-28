import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  projectRuntimeConfigLean: vi.fn(),
  piiPatternLean: vi.fn(),
}));

vi.mock('@abl/compiler/platform', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@abl/compiler/platform')>();
  return {
    ...actual,
    createLogger: () => ({
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    }),
  };
});

vi.mock('mongoose', () => ({
  default: { connection: { readyState: 1 } },
  connection: { readyState: 1 },
}));

vi.mock('@agent-platform/database/models', () => ({
  ProjectRuntimeConfig: {
    findOne: vi.fn().mockReturnValue({
      lean: mocks.projectRuntimeConfigLean,
    }),
  },
  PIIPattern: {
    find: vi.fn().mockReturnValue({
      sort: vi.fn().mockReturnValue({
        lean: mocks.piiPatternLean,
      }),
    }),
  },
}));

const { renderPipelineReadValue, renderPipelineActionValue, resetPipelinePIIContextCacheForTest } =
  await import('../pipeline/services/pii-boundary.js');

describe('pipeline PII boundary', () => {
  beforeEach(() => {
    resetPipelinePIIContextCacheForTest();
    vi.clearAllMocks();
    mocks.projectRuntimeConfigLean.mockResolvedValue({
      pii_redaction: { enabled: true, redact_input: true, redact_output: true },
    });
    mocks.piiPatternLean.mockResolvedValue([]);
  });

  it('loads custom project patterns and forces pipeline read output to tokens', async () => {
    const contractId = '1940b87f-a6a5-44d7-89e4-ff7b9f9d40da';
    mocks.piiPatternLean.mockResolvedValue([
      {
        _id: 'pattern-1',
        name: 'Contract ID',
        piiType: 'custom',
        regex: '\\b[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\\b',
        enabled: true,
        defaultRenderMode: 'random',
        consumerAccess: [{ consumer: 'pipeline_read', renderMode: 'random' }],
        redaction: { type: 'random', randomConfig: { charset: 'numeric', length: 12 } },
      },
    ]);

    const rendered = await renderPipelineReadValue(`contract ${contractId}`, {
      tenantId: 'tenant-1',
      projectId: 'project-1',
      role: 'user',
    });

    expect(rendered).toMatch(/\{\{PII:custom_contract_id_pattern-1:[a-f0-9-]+\}\}/);
    expect(rendered).not.toContain(contractId);
  });

  it('redacts unresolved PII tokens before pipeline action sinks', async () => {
    const rendered = await renderPipelineActionValue(
      {
        body: 'contract {{PII:custom_contract_id:00000000-0000-0000-0000-000000000000}}',
        Authorization: 'Bearer secret-token',
      },
      {
        tenantId: 'tenant-1',
        projectId: 'project-1',
        role: 'assistant',
      },
    );

    expect(rendered.body).toBe('contract [REDACTED_CUSTOM_CONTRACT_ID]');
    expect(rendered.Authorization).toBe('[REDACTED]');
  });
});
