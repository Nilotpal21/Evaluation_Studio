import { describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const {
  mockRequireTenantAuth,
  mockRequireProjectAccess,
  mockPipelineDefinitionModel,
  mockPipelineSave,
  mockPipelineToObject,
  mockValidateGraphPipeline,
  mockValidateNodeModels,
  mockGetTemplate,
  mockGetNodeRegistry,
} = vi.hoisted(() => ({
  mockRequireTenantAuth: vi.fn(),
  mockRequireProjectAccess: vi.fn(),
  mockPipelineDefinitionModel: vi.fn(),
  mockPipelineSave: vi.fn(),
  mockPipelineToObject: vi.fn(),
  mockValidateGraphPipeline: vi.fn(),
  mockValidateNodeModels: vi.fn(),
  mockGetTemplate: vi.fn(),
  mockGetNodeRegistry: vi.fn(),
}));

vi.mock('@/lib/auth', () => ({
  requireTenantAuth: (...args: unknown[]) => mockRequireTenantAuth(...args),
  isAuthError: vi.fn(() => false),
  formatUserLabel: (user: { email?: string; id: string }) => user.email ?? user.id,
}));

vi.mock('@/lib/project-access', () => ({
  requireProjectAccess: (...args: unknown[]) => mockRequireProjectAccess(...args),
  isAccessError: vi.fn(() => false),
}));

vi.mock(
  '@agent-platform/pipeline-engine/schemas',
  () => ({
    PipelineDefinitionModel: mockPipelineDefinitionModel,
  }),
  { virtual: true },
);

vi.mock(
  '@agent-platform/pipeline-engine/validation',
  () => ({
    validateGraphPipeline: (...args: unknown[]) => mockValidateGraphPipeline(...args),
    validateNodeModels: (...args: unknown[]) => mockValidateNodeModels(...args),
  }),
  { virtual: true },
);

vi.mock(
  '@agent-platform/pipeline-engine/templates',
  () => ({
    getTemplate: (...args: unknown[]) => mockGetTemplate(...args),
  }),
  { virtual: true },
);

vi.mock('../../app/api/pipelines/_shared/registry', () => ({
  getNodeRegistry: (...args: unknown[]) => mockGetNodeRegistry(...args),
}));

import { POST } from '../../app/api/pipelines/templates/[templateId]/clone/route';
import { stampTemplateContractVersions } from '../../app/api/pipelines/_shared/stamp-template-contract-versions';

function makeCloneRequest() {
  return new NextRequest('http://localhost/api/pipelines/templates/quality-evaluator/clone', {
    method: 'POST',
    body: JSON.stringify({ projectId: 'project-1', name: 'Cloned Quality Pipeline' }),
  });
}

describe('stampTemplateContractVersions', () => {
  it('stamps known template nodes with the current node contract version', () => {
    const nodes = [
      { id: 'read', type: 'read-conversation', config: {} },
      { id: 'unknown', type: 'custom-node', config: {} },
    ];

    expect(stampTemplateContractVersions(nodes)).toEqual([
      { id: 'read', type: 'read-conversation', config: {}, contractVersion: 1 },
      { id: 'unknown', type: 'custom-node', config: {} },
    ]);
  });

  it('saves cloned templates with tenant, project, creator, and node contract versions', async () => {
    const template = {
      name: 'Quality Pipeline',
      description: 'Scores quality',
      supportedTriggers: [],
      defaultTriggerIds: [],
      nodes: [{ id: 'read', type: 'read-conversation', config: {}, transitions: [] }],
      entryNodeId: 'read',
      configSchema: { fields: [] },
    };
    mockRequireTenantAuth.mockResolvedValue({
      id: 'user-1',
      email: 'dev@example.com',
      tenantId: 'tenant-1',
    });
    mockRequireProjectAccess.mockResolvedValue({ project: { id: 'project-1' } });
    mockGetTemplate.mockResolvedValue(template);
    mockGetNodeRegistry.mockResolvedValue({});
    mockValidateGraphPipeline.mockReturnValue({ errors: [], warnings: [] });
    mockValidateNodeModels.mockResolvedValue([]);
    mockPipelineSave.mockResolvedValue(undefined);
    mockPipelineToObject.mockReturnValue({ _id: 'pipeline-1' });
    mockPipelineDefinitionModel.mockImplementation(function PipelineDefinitionModel(
      document: Record<string, unknown>,
    ) {
      return {
        save: mockPipelineSave,
        toObject: mockPipelineToObject,
        document,
      };
    });

    const response = await POST(makeCloneRequest(), {
      params: Promise.resolve({ templateId: 'quality-evaluator' }),
    });

    expect(response.status).toBe(201);
    expect(mockRequireProjectAccess).toHaveBeenCalledWith('project-1', {
      id: 'user-1',
      email: 'dev@example.com',
      tenantId: 'tenant-1',
    });
    expect(mockPipelineDefinitionModel).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: 'tenant-1',
        projectId: 'project-1',
        createdBy: 'dev@example.com',
        name: 'Cloned Quality Pipeline',
        nodes: [
          {
            id: 'read',
            type: 'read-conversation',
            config: {},
            transitions: [],
            contractVersion: 1,
          },
        ],
      }),
    );
    expect(mockPipelineSave).toHaveBeenCalledOnce();
  });
});
