import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockValidateProjectToolBindingsForSave = vi.fn();
const mockCreateProjectTool = vi.fn();
const mockUpdateProjectTool = vi.fn();
const mockFindProjectToolByName = vi.fn();
const mockCountProjectToolsByProject = vi.fn();
const mockDeleteProjectTool = vi.fn();
const mockIsCodeToolsEnabled = vi.fn();
const mockValidateUrlWithPlaceholders = vi.fn();
const mockLogAuditEvent = vi.fn();
const mockRefreshProjectAgentDraftMetadataForToolMutation = vi.fn();
const mockGetOrCreateDefaultVariableNamespaceIds = vi.fn();
const mockSyncActiveDraftFromTool = vi.fn();
const mockCreateLogger = vi.fn().mockReturnValue({
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
});

vi.mock('@abl/compiler/platform', () => ({
  createLogger: (...args: unknown[]) => mockCreateLogger(...args),
}));

vi.mock('@agent-platform/shared/repos', () => ({
  createProjectTool: (...args: unknown[]) => mockCreateProjectTool(...args),
  updateProjectTool: (...args: unknown[]) => mockUpdateProjectTool(...args),
  findProjectToolByName: (...args: unknown[]) => mockFindProjectToolByName(...args),
  countProjectToolsByProject: (...args: unknown[]) => mockCountProjectToolsByProject(...args),
  deleteProjectTool: (...args: unknown[]) => mockDeleteProjectTool(...args),
}));

vi.mock('@/lib/project-tool-binding-validation', () => ({
  validateProjectToolBindingsForSave: (...args: unknown[]) =>
    mockValidateProjectToolBindingsForSave(...args),
}));

vi.mock('@/lib/resolve-and-validate-url', () => ({
  validateUrlWithPlaceholders: (...args: unknown[]) => mockValidateUrlWithPlaceholders(...args),
}));

vi.mock('@/lib/feature-gates', () => ({
  isCodeToolsEnabled: (...args: unknown[]) => mockIsCodeToolsEnabled(...args),
}));

vi.mock('@/services/audit-service', () => ({
  AuditActions: {
    TOOL_CREATED: 'tool.created',
    TOOL_UPDATED: 'tool.updated',
    TOOL_DELETED: 'tool.deleted',
  },
  logAuditEvent: (...args: unknown[]) => mockLogAuditEvent(...args),
}));

vi.mock('@/lib/project-tool-draft-invalidation', () => ({
  refreshProjectAgentDraftMetadataForToolMutation: (...args: unknown[]) =>
    mockRefreshProjectAgentDraftMetadataForToolMutation(...args),
}));

vi.mock('@/lib/default-variable-namespace', () => ({
  getOrCreateDefaultVariableNamespaceIds: (...args: unknown[]) =>
    mockGetOrCreateDefaultVariableNamespaceIds(...args),
}));

vi.mock('@/lib/arch-ai/integration-draft-service', () => ({
  syncActiveDraftFromTool: (...args: unknown[]) => mockSyncActiveDraftFromTool(...args),
}));

vi.mock('@/lib/tool-test-endpoint-service', () => ({
  generateToolTestEndpointCapabilities: vi.fn(() => ({
    urls: { invokeUrl: 'https://example.test/tool', specUrl: 'https://example.test/spec' },
    invokeCapability: 'invoke',
    specCapability: 'spec',
  })),
  upsertToolTestEndpoint: vi.fn(),
}));

describe('tool-creation-service binding validation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFindProjectToolByName.mockResolvedValue(null);
    mockCountProjectToolsByProject.mockResolvedValue(0);
    mockCreateProjectTool.mockResolvedValue({
      id: 'tool-1',
      name: 'run_flow',
      toolType: 'workflow',
      dslContent: '',
      variableNamespaceIds: [],
    });
    mockUpdateProjectTool.mockResolvedValue({
      id: 'tool-1',
      name: 'search_docs',
      toolType: 'searchai',
      dslContent: '',
      variableNamespaceIds: [],
    });
    mockValidateUrlWithPlaceholders.mockResolvedValue({ safe: true });
    mockIsCodeToolsEnabled.mockResolvedValue(true);
    mockLogAuditEvent.mockResolvedValue(undefined);
    mockRefreshProjectAgentDraftMetadataForToolMutation.mockResolvedValue(undefined);
    mockGetOrCreateDefaultVariableNamespaceIds.mockResolvedValue(['ns-default']);
    mockSyncActiveDraftFromTool.mockResolvedValue(undefined);
    mockValidateProjectToolBindingsForSave.mockResolvedValue({ valid: true });
  });

  it('rejects raw workflow DSL before persistence when binding validation fails', async () => {
    mockValidateProjectToolBindingsForSave.mockResolvedValueOnce({
      valid: false,
      status: 404,
      code: 'WORKFLOW_NOT_FOUND',
      message: 'Workflow not found',
    });

    const { createToolFromDsl } = await import('@/lib/tool-creation-service');

    await expect(
      createToolFromDsl({
        tenantId: 'tenant-1',
        projectId: 'project-1',
        toolName: 'run_flow',
        createdBy: 'user-1',
        dslContent: [
          'run_flow(payload: object) -> object',
          '  type: workflow',
          '  workflow_id: wf-missing',
          '  trigger_id: tr-flow',
        ].join('\n'),
      }),
    ).rejects.toMatchObject({
      code: 'WORKFLOW_NOT_FOUND',
      message: 'Workflow not found',
    });

    expect(mockValidateProjectToolBindingsForSave).toHaveBeenCalledWith({
      tenantId: 'tenant-1',
      projectId: 'project-1',
      toolType: 'workflow',
      dslContent: expect.stringContaining('workflow_id: wf-missing'),
    });
    expect(mockCreateProjectTool).not.toHaveBeenCalled();
  });

  it('rejects structured SearchAI updates before persistence when binding validation fails', async () => {
    mockValidateProjectToolBindingsForSave.mockResolvedValueOnce({
      valid: false,
      status: 404,
      code: 'SEARCHAI_INDEX_NOT_FOUND',
      message: 'SearchAI index not found in project',
    });

    const { updateToolViaService } = await import('@/lib/tool-creation-service');

    await expect(
      updateToolViaService({
        tenantId: 'tenant-1',
        projectId: 'project-1',
        toolId: 'tool-1',
        updatedBy: 'user-1',
        formData: {
          name: 'search_docs',
          toolType: 'searchai',
          description: 'Search docs',
          parameters: [{ name: 'query', type: 'string', description: 'Query', required: true }],
          returnType: 'object',
          indexId: 'idx-foreign',
          tenantId: 'tenant-1',
        },
      }),
    ).rejects.toMatchObject({
      code: 'SEARCHAI_INDEX_NOT_FOUND',
      message: 'SearchAI index not found in project',
    });

    expect(mockValidateProjectToolBindingsForSave).toHaveBeenCalledWith({
      tenantId: 'tenant-1',
      projectId: 'project-1',
      toolType: 'searchai',
      dslContent: expect.stringContaining('index_id: idx-foreign'),
    });
    expect(mockUpdateProjectTool).not.toHaveBeenCalled();
  });

  it('rejects ArchAI explicit SearchAI index creation before persistence when binding validation fails', async () => {
    mockValidateProjectToolBindingsForSave.mockResolvedValueOnce({
      valid: false,
      status: 404,
      code: 'SEARCHAI_INDEX_NOT_FOUND',
      message: 'SearchAI index not found in project',
    });

    const { executeToolsOps } = await import('@/lib/arch-ai/tools/tools-ops');

    const result = await executeToolsOps(
      {
        action: 'create',
        toolName: 'search_docs',
        config: {
          type: 'searchai',
          indexId: 'idx-foreign',
          description: 'Search docs',
        },
      },
      {
        projectId: 'project-1',
        user: {
          tenantId: 'tenant-1',
          userId: 'user-1',
          permissions: ['tool:write'],
        },
      },
    );

    expect(result).toEqual({
      success: false,
      error: {
        code: 'SEARCHAI_INDEX_NOT_FOUND',
        message: 'SearchAI index not found in project',
      },
    });
    expect(mockValidateProjectToolBindingsForSave).toHaveBeenCalledWith({
      tenantId: 'tenant-1',
      projectId: 'project-1',
      toolType: 'searchai',
      dslContent: expect.stringContaining('index_id: idx-foreign'),
    });
    expect(mockCreateProjectTool).not.toHaveBeenCalled();
  });

  it('assigns the default variable namespace when ArchAI creates a SearchAI tool', async () => {
    mockCreateProjectTool.mockResolvedValueOnce({
      id: 'tool-1',
      name: 'search_docs',
      toolType: 'searchai',
      dslContent: 'search_docs(query: string) -> object\n  type: searchai',
      variableNamespaceIds: ['ns-default'],
    });

    const { executeToolsOps } = await import('@/lib/arch-ai/tools/tools-ops');

    const result = await executeToolsOps(
      {
        action: 'create',
        toolName: 'search_docs',
        config: {
          type: 'searchai',
          indexId: 'idx-refunds',
          description: 'Search docs',
        },
      },
      {
        projectId: 'project-1',
        user: {
          tenantId: 'tenant-1',
          userId: 'user-1',
          permissions: ['tool:write'],
        },
      },
    );

    expect(result.success).toBe(true);
    expect(mockGetOrCreateDefaultVariableNamespaceIds).toHaveBeenCalledWith({
      tenantId: 'tenant-1',
      projectId: 'project-1',
      createdBy: 'user-1',
    });
    expect(mockCreateProjectTool).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: 'tenant-1',
        projectId: 'project-1',
        toolType: 'searchai',
        variableNamespaceIds: ['ns-default'],
      }),
    );
  });
});
