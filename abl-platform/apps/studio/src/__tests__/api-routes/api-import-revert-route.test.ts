import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const {
  mockRevertStudioLayeredImportOperation,
  mockNotifyRuntimeModelConfigChanged,
  mockRevertCoreImportOperationV2,
  mockCreateStudioCoreImportApplyAdapter,
  mockCreateStudioCoreImportStore,
  mockValidateProjectToolBindingsForSave,
  mockCreateProjectRuntimeConfigSaveValidatorForFiles,
} = vi.hoisted(() => ({
  mockRevertStudioLayeredImportOperation: vi.fn(),
  mockNotifyRuntimeModelConfigChanged: vi.fn(),
  mockRevertCoreImportOperationV2: vi.fn(),
  mockCreateStudioCoreImportApplyAdapter: vi.fn(),
  mockCreateStudioCoreImportStore: vi.fn(),
  mockValidateProjectToolBindingsForSave: vi.fn(),
  mockCreateProjectRuntimeConfigSaveValidatorForFiles: vi.fn(),
}));

vi.mock('@abl/compiler/platform', () => ({
  createLogger: vi.fn(() => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  })),
}));

vi.mock('@/lib/route-handler', () => ({
  withRouteHandler:
    (_options: unknown, handler: (ctx: Record<string, unknown>) => Promise<Response>) =>
    async (request: NextRequest, routeCtx: { params: Promise<Record<string, string>> }) =>
      handler({
        request,
        user: { id: 'user-1', tenantId: 'tenant-1', permissions: ['project:*'] },
        params: await routeCtx.params,
        tenantId: 'tenant-1',
      }),
}));

vi.mock('@/lib/project-import/layered-import-support', () => ({
  revertStudioLayeredImportOperation: (...args: unknown[]) =>
    mockRevertStudioLayeredImportOperation(...args),
}));

vi.mock('@agent-platform/project-io/import', () => ({
  revertCoreImportOperationV2: (...args: unknown[]) => mockRevertCoreImportOperationV2(...args),
}));

vi.mock('@/lib/project-import/core-direct-apply-support', () => ({
  createStudioCoreImportApplyAdapter: (...args: unknown[]) =>
    mockCreateStudioCoreImportApplyAdapter(...args),
  createStudioCoreImportStore: (...args: unknown[]) => mockCreateStudioCoreImportStore(...args),
}));

vi.mock('@/lib/project-tool-binding-validation', () => ({
  validateProjectToolBindingsForSave: (...args: unknown[]) =>
    mockValidateProjectToolBindingsForSave(...args),
}));

vi.mock('@/lib/project-runtime-config-import-validation', () => ({
  createProjectRuntimeConfigSaveValidatorForFiles: (...args: unknown[]) =>
    mockCreateProjectRuntimeConfigSaveValidatorForFiles(...args),
}));

vi.mock('@/lib/runtime-model-cache-invalidation', () => ({
  notifyRuntimeModelConfigChanged: (...args: unknown[]) =>
    mockNotifyRuntimeModelConfigChanged(...args),
}));

function makeRequest(body: unknown, authorization?: string): NextRequest {
  return new NextRequest('http://studio.test/api/projects/proj-1/import/revert', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(authorization ? { authorization } : {}),
    },
    body: JSON.stringify(body),
  });
}

function routeCtx() {
  return { params: Promise.resolve({ id: 'proj-1' }) };
}

function layeredAppliedCounts(overrides: Record<string, number> = {}) {
  return {
    created: 0,
    updated: 2,
    deleted: 1,
    toolsCreated: 0,
    toolsUpdated: 1,
    toolsDeleted: 1,
    localesCreated: 0,
    localesUpdated: 0,
    localesDeleted: 0,
    profilesCreated: 0,
    profilesUpdated: 0,
    profilesDeleted: 0,
    modelPoliciesUpserted: 0,
    modelPoliciesDeleted: 0,
    ...overrides,
  };
}

describe('POST /api/projects/[id]/import/revert', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCreateStudioCoreImportApplyAdapter.mockReturnValue({ adapter: 'legacy-adapter' });
    mockCreateStudioCoreImportStore.mockReturnValue({ store: 'legacy-store' });
    mockValidateProjectToolBindingsForSave.mockResolvedValue({ ok: true });
    mockCreateProjectRuntimeConfigSaveValidatorForFiles.mockReturnValue(async () => ({ ok: true }));
    mockRevertCoreImportOperationV2.mockResolvedValue({
      success: true,
      operationId: 'legacy-revert-op-1',
      entryAgentName: 'support_agent',
      applied: layeredAppliedCounts(),
    });
    mockRevertStudioLayeredImportOperation.mockResolvedValue({
      success: true,
      operationId: 'import-op-layered-1',
      applied: layeredAppliedCounts(),
    });
  });

  it('delegates UI revert to layered rollback only', async () => {
    const mod = await import('@/app/api/projects/[id]/import/revert/route');
    const response = await mod.POST(
      makeRequest({ operationId: 'import-op-layered-1' }),
      routeCtx(),
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({
      success: true,
      operationId: 'import-op-layered-1',
      applied: layeredAppliedCounts(),
    });
    expect(mockRevertStudioLayeredImportOperation).toHaveBeenCalledWith({
      operationId: 'import-op-layered-1',
      projectId: 'proj-1',
      tenantId: 'tenant-1',
    });
    expect(mockRevertCoreImportOperationV2).not.toHaveBeenCalled();
  });

  it('falls back to legacy snapshot revert for pre-layered import operations', async () => {
    mockRevertStudioLayeredImportOperation.mockResolvedValue({
      success: false,
      status: 400,
      error: {
        code: 'OPERATION_NOT_LAYERED',
        message: 'Import operation has no layered records to revert',
      },
    });

    const mod = await import('@/app/api/projects/[id]/import/revert/route');
    const response = await mod.POST(makeRequest({ operationId: 'legacy-import-op-1' }), routeCtx());
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({
      success: true,
      operationId: 'legacy-revert-op-1',
      applied: layeredAppliedCounts(),
    });
    expect(mockCreateStudioCoreImportApplyAdapter).toHaveBeenCalledWith({
      projectId: 'proj-1',
      tenantId: 'tenant-1',
      userId: 'user-1',
    });
    expect(mockCreateStudioCoreImportStore).toHaveBeenCalledWith({
      projectId: 'proj-1',
      tenantId: 'tenant-1',
    });
    expect(mockRevertCoreImportOperationV2).toHaveBeenCalledWith(
      expect.objectContaining({
        operationId: 'legacy-import-op-1',
        adapter: { adapter: 'legacy-adapter' },
        store: { store: 'legacy-store' },
        planOptions: expect.objectContaining({
          projectId: 'proj-1',
          tenantId: 'tenant-1',
          userId: 'user-1',
          deleteUnmatched: true,
        }),
      }),
    );
  });

  it('notifies runtime cache invalidation when layered rollback changes model policies', async () => {
    mockRevertStudioLayeredImportOperation.mockResolvedValue({
      success: true,
      operationId: 'import-op-layered-1',
      applied: layeredAppliedCounts({ modelPoliciesUpserted: 1 }),
    });

    const mod = await import('@/app/api/projects/[id]/import/revert/route');
    const response = await mod.POST(
      makeRequest({ operationId: 'import-op-layered-1' }, 'Bearer studio-token'),
      routeCtx(),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      applied: { modelPoliciesUpserted: 1 },
    });
    expect(mockNotifyRuntimeModelConfigChanged).toHaveBeenCalledWith({
      tenantId: 'tenant-1',
      authorization: 'Bearer studio-token',
    });
    expect(mockRevertCoreImportOperationV2).not.toHaveBeenCalled();
  });

  it('returns layered rollback failures without falling back to legacy snapshot planning', async () => {
    mockRevertStudioLayeredImportOperation.mockResolvedValue({
      success: false,
      status: 409,
      error: {
        code: 'OPERATION_NOT_REVERSIBLE',
        message: 'Import operation is not in a reversible state',
      },
    });

    const mod = await import('@/app/api/projects/[id]/import/revert/route');
    const response = await mod.POST(
      makeRequest({ operationId: 'import-op-layered-1' }),
      routeCtx(),
    );
    const body = await response.json();

    expect(response.status).toBe(409);
    expect(body).toEqual({
      success: false,
      error: {
        code: 'OPERATION_NOT_REVERSIBLE',
        message: 'Import operation is not in a reversible state',
      },
    });
    expect(mockRevertCoreImportOperationV2).not.toHaveBeenCalled();
  });

  it('maps missing layered import operations to 404', async () => {
    mockRevertStudioLayeredImportOperation.mockResolvedValue({
      success: false,
      status: 404,
      error: {
        code: 'OPERATION_NOT_FOUND',
        message: 'Import operation not found',
      },
    });

    const mod = await import('@/app/api/projects/[id]/import/revert/route');
    const response = await mod.POST(makeRequest({ operationId: 'missing-op' }), routeCtx());
    const body = await response.json();

    expect(response.status).toBe(404);
    expect(body).toEqual({
      success: false,
      error: {
        code: 'OPERATION_NOT_FOUND',
        message: 'Import operation not found',
      },
    });
    expect(mockRevertCoreImportOperationV2).not.toHaveBeenCalled();
  });

  it('requires operationId before invoking rollback', async () => {
    const mod = await import('@/app/api/projects/[id]/import/revert/route');
    const response = await mod.POST(makeRequest({}), routeCtx());
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body).toEqual({
      success: false,
      error: {
        code: 'MISSING_OPERATION_ID',
        message: 'operationId is required',
      },
    });
    expect(mockRevertStudioLayeredImportOperation).not.toHaveBeenCalled();
    expect(mockRevertCoreImportOperationV2).not.toHaveBeenCalled();
  });
});
