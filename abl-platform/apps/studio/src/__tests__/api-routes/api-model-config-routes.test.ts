import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

const {
  mockRequireAuth,
  mockIsAuthError,
  mockFindUserTenantMemberships,
  mockFindModelConfigs,
  mockCreateModelConfig,
  mockFindProjects,
  mockFindModelConfigByIdAndTenant,
  mockUpdateModelConfig,
  mockDeleteModelConfig,
  mockFindProjectByIdAndTenant,
  mockClearDefaultModelConfigs,
  mockLogAuditEvent,
  mockLogError,
  mockEnsureDb,
  mockAuthProfileFindOne,
  mockLLMCredentialFindOne,
  mockTenantModelFindOne,
  mockEvalEvaluatorUpdateMany,
  mockNotifyRuntimeModelConfigChanged,
} = vi.hoisted(() => ({
  mockRequireAuth: vi.fn(),
  mockIsAuthError: vi.fn(() => false),
  mockFindUserTenantMemberships: vi.fn(),
  mockFindModelConfigs: vi.fn(),
  mockCreateModelConfig: vi.fn(),
  mockFindProjects: vi.fn(),
  mockFindModelConfigByIdAndTenant: vi.fn(),
  mockUpdateModelConfig: vi.fn(),
  mockDeleteModelConfig: vi.fn(),
  mockFindProjectByIdAndTenant: vi.fn(),
  mockClearDefaultModelConfigs: vi.fn(),
  mockLogAuditEvent: vi.fn(),
  mockLogError: vi.fn(),
  mockEnsureDb: vi.fn(),
  mockAuthProfileFindOne: vi.fn(),
  mockLLMCredentialFindOne: vi.fn(),
  mockTenantModelFindOne: vi.fn(),
  mockEvalEvaluatorUpdateMany: vi.fn(),
  mockNotifyRuntimeModelConfigChanged: vi.fn(),
}));

vi.mock('@/lib/auth', () => ({
  requireAuth: mockRequireAuth,
  isAuthError: mockIsAuthError,
}));

vi.mock('@/repos/auth-repo', () => ({
  findUserTenantMemberships: mockFindUserTenantMemberships,
}));

vi.mock('@/repos/project-repo', () => ({
  findModelConfigs: mockFindModelConfigs,
  createModelConfig: mockCreateModelConfig,
  findProjects: mockFindProjects,
  findModelConfigByIdAndTenant: mockFindModelConfigByIdAndTenant,
  updateModelConfig: mockUpdateModelConfig,
  deleteModelConfig: mockDeleteModelConfig,
  findProjectByIdAndTenant: mockFindProjectByIdAndTenant,
  clearDefaultModelConfigs: mockClearDefaultModelConfigs,
}));

vi.mock('@/services/audit-service', () => ({
  logAuditEvent: mockLogAuditEvent,
  AuditActions: {
    MODEL_CONFIG_CREATED: 'MODEL_CONFIG_CREATED',
    MODEL_CONFIG_UPDATED: 'MODEL_CONFIG_UPDATED',
    MODEL_CONFIG_DELETED: 'MODEL_CONFIG_DELETED',
  },
}));

vi.mock('@agent-platform/openapi/nextjs', () => ({
  withOpenAPI: (_schema: unknown, handler: (...args: unknown[]) => unknown) => handler,
}));

vi.mock('@abl/compiler/platform', () => ({
  createLogger: () => ({ error: mockLogError }),
}));

vi.mock('@/lib/ensure-db', () => ({
  ensureDb: mockEnsureDb,
}));

vi.mock('@agent-platform/database/models', () => ({
  AuthProfile: { findOne: mockAuthProfileFindOne },
  LLMCredential: { findOne: mockLLMCredentialFindOne },
  TenantModel: { findOne: mockTenantModelFindOne },
  EvalEvaluator: { updateMany: mockEvalEvaluatorUpdateMany },
}));

vi.mock('@/lib/runtime-model-cache-invalidation', () => ({
  notifyRuntimeModelConfigChanged: mockNotifyRuntimeModelConfigChanged,
}));

import { GET as getModelConfigs, POST as postModelConfig } from '@/app/api/models/route';
import {
  DELETE as deleteModelConfig,
  PATCH as patchModelConfig,
} from '@/app/api/models/[id]/route';

const testUser = { id: 'user-1', tenantId: 'tenant-1' };

function makeRequest(url: string, body: unknown, method = 'POST') {
  return new NextRequest(new URL(url, 'http://localhost:3000'), {
    method,
    headers: {
      Authorization: 'Bearer test-token',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
}

function makeGetRequest(url: string) {
  return new NextRequest(new URL(url, 'http://localhost:3000'), {
    method: 'GET',
    headers: {
      Authorization: 'Bearer test-token',
    },
  });
}

describe('project model config routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRequireAuth.mockResolvedValue(testUser);
    mockIsAuthError.mockReturnValue(false);
    mockFindUserTenantMemberships.mockResolvedValue([{ tenantId: 'tenant-1' }]);
    mockFindModelConfigs.mockResolvedValue([]);
    mockFindProjects.mockResolvedValue([{ id: 'proj-1', tenantId: 'tenant-1' }]);
    mockCreateModelConfig.mockImplementation(async (body: Record<string, unknown>) => ({
      id: 'config-1',
      ...body,
    }));
    mockFindModelConfigByIdAndTenant.mockResolvedValue({
      id: 'config-1',
      projectId: 'proj-1',
      name: 'Existing Model',
    });
    mockFindProjectByIdAndTenant.mockResolvedValue({
      id: 'proj-1',
      name: 'Project 1',
      tenantId: 'tenant-1',
    });
    mockUpdateModelConfig.mockImplementation(
      async (id: string, updates: Record<string, unknown>) => ({
        id,
        projectId: 'proj-1',
        name: 'Existing Model',
        ...updates,
      }),
    );
    mockEnsureDb.mockResolvedValue(undefined);
    mockAuthProfileFindOne.mockResolvedValue(null);
    mockLLMCredentialFindOne.mockResolvedValue(null);
    mockTenantModelFindOne.mockReturnValue({ lean: () => Promise.resolve(null) });
    mockEvalEvaluatorUpdateMany.mockResolvedValue({ modifiedCount: 0 });
    mockNotifyRuntimeModelConfigChanged.mockResolvedValue(undefined);
  });

  it('GET /api/models scopes list queries to projects the caller can access', async () => {
    mockFindProjects.mockResolvedValue([
      { id: 'proj-1', tenantId: 'tenant-1' },
      { id: 'proj-2', tenantId: 'tenant-1' },
    ]);
    mockFindModelConfigs.mockResolvedValue([
      { id: 'config-1', projectId: 'proj-1', name: 'Model 1' },
      { id: 'config-2', projectId: 'proj-2', name: 'Model 2' },
    ]);

    const response = await getModelConfigs(makeGetRequest('/api/models'));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.models).toHaveLength(2);
    expect(mockFindModelConfigs).toHaveBeenCalledWith({
      scopedProjects: [
        { projectId: 'proj-1', tenantId: 'tenant-1' },
        { projectId: 'proj-2', tenantId: 'tenant-1' },
      ],
    });
  });

  it('GET /api/models returns an empty list for inaccessible explicit project ids', async () => {
    mockFindProjects.mockResolvedValue([]);

    const response = await getModelConfigs(makeGetRequest('/api/models?projectId=foreign-proj'));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.models).toEqual([]);
    expect(mockFindModelConfigs).not.toHaveBeenCalled();
  });

  it('POST /api/models accepts parenthesized catalog names', async () => {
    const name = 'GPT-4.1 (2025-04-14)';

    const response = await postModelConfig(
      makeRequest('/api/models', {
        projectId: 'proj-1',
        name,
        modelId: 'gpt-4.1-2025-04-14',
        provider: 'openai',
      }),
    );

    expect(response.status).toBe(201);
    expect(mockCreateModelConfig).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: 'proj-1',
        name,
        modelId: 'gpt-4.1-2025-04-14',
        provider: 'openai',
      }),
    );
  });

  it('POST /api/models verifies project access with the repository query shape', async () => {
    const response = await postModelConfig(
      makeRequest('/api/models', {
        projectId: 'proj-1',
        name: 'GPT-4o',
        modelId: 'gpt-4o',
        provider: 'openai',
      }),
    );

    expect(response.status).toBe(201);
    expect(mockFindProjects).toHaveBeenCalledWith({
      id: 'proj-1',
      OR: [{ ownerId: 'user-1' }, { tenantId: { in: ['tenant-1'] } }],
    });
  });

  it('POST /api/models derives a project model id from tenantModelId', async () => {
    mockTenantModelFindOne.mockReturnValue({
      lean: () =>
        Promise.resolve({
          _id: 'tm-api-1',
          tenantId: 'tenant-1',
          provider: 'custom',
          modelId: 'custom-runtime-model',
          isActive: true,
          inferenceEnabled: true,
        }),
    });

    const response = await postModelConfig(
      makeRequest('/api/models', {
        projectId: 'proj-1',
        name: 'Custom API Model',
        provider: 'custom',
        tenantModelId: 'tm-api-1',
      }),
    );

    expect(response.status).toBe(201);
    expect(mockCreateModelConfig).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: 'proj-1',
        name: 'Custom API Model',
        modelId: 'custom-runtime-model',
        provider: 'custom',
        tenantModelId: 'tm-api-1',
      }),
    );
    expect(mockTenantModelFindOne).toHaveBeenCalledWith(
      expect.objectContaining({
        _id: 'tm-api-1',
        tenantId: 'tenant-1',
        isActive: true,
      }),
    );
  });

  it('POST /api/models rejects tenant model refs outside the project tenant', async () => {
    const response = await postModelConfig(
      makeRequest('/api/models', {
        projectId: 'proj-1',
        name: 'Foreign Tenant Model',
        provider: 'custom',
        tenantModelId: 'tm-foreign',
      }),
    );
    const body = await response.json();

    expect(response.status).toBe(404);
    expect(body.error).toBe('Tenant model not found');
    expect(mockCreateModelConfig).not.toHaveBeenCalled();
    expect(mockTenantModelFindOne).toHaveBeenCalledWith(
      expect.objectContaining({
        _id: 'tm-foreign',
        tenantId: 'tenant-1',
      }),
    );
  });

  it('POST /api/models accepts voice tier for realtime catalog models', async () => {
    const response = await postModelConfig(
      makeRequest('/api/models', {
        projectId: 'proj-1',
        name: 'GPT-4o Realtime Preview (2025-06-03)',
        modelId: 'gpt-4o-realtime-preview-2025-06-03',
        provider: 'openai',
        tier: 'voice',
      }),
    );

    expect(response.status).toBe(201);
    expect(mockCreateModelConfig).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: 'proj-1',
        name: 'GPT-4o Realtime Preview (2025-06-03)',
        modelId: 'gpt-4o-realtime-preview-2025-06-03',
        provider: 'openai',
        tier: 'voice',
      }),
    );
    expect(mockNotifyRuntimeModelConfigChanged).toHaveBeenCalledWith({
      tenantId: 'tenant-1',
      authorization: 'Bearer test-token',
    });
  });

  it('POST /api/models preserves project runtime policy overrides', async () => {
    const response = await postModelConfig(
      makeRequest('/api/models', {
        projectId: 'proj-1',
        name: 'Realtime Voice Model',
        modelId: 'gpt-4o-realtime-preview-2025-06-03',
        provider: 'openai',
        tier: 'voice',
        useResponsesApi: true,
        useStreaming: false,
      }),
    );

    expect(response.status).toBe(201);
    expect(mockCreateModelConfig).toHaveBeenCalledWith(
      expect.objectContaining({
        useResponsesApi: true,
        useStreaming: false,
      }),
    );
  });

  it('POST /api/models rejects inaccessible auth profiles before persistence', async () => {
    const response = await postModelConfig(
      makeRequest('/api/models', {
        projectId: 'proj-1',
        name: 'GPT-4o',
        modelId: 'gpt-4o',
        provider: 'openai',
        authProfileId: 'profile-foreign',
      }),
    );
    const body = await response.json();

    expect(response.status).toBe(404);
    expect(body.error).toBe('Auth profile not found');
    expect(mockCreateModelConfig).not.toHaveBeenCalled();
    expect(mockAuthProfileFindOne).toHaveBeenCalledWith(
      expect.objectContaining({
        _id: 'profile-foreign',
        tenantId: 'tenant-1',
        status: 'active',
      }),
    );
  });

  it('PATCH /api/models/:id rejects names outside the shared validator', async () => {
    const response = await patchModelConfig(
      makeRequest('/api/models/config-1', { name: 'GPT/4.1' }, 'PATCH'),
      { params: Promise.resolve({ id: 'config-1' }) },
    );

    expect(response.status).toBe(400);
    expect(mockUpdateModelConfig).not.toHaveBeenCalled();
  });

  it('PATCH /api/models/:id accepts parenthesized catalog names', async () => {
    const name = 'GPT-4.1 (2025-04-14)';

    const response = await patchModelConfig(
      makeRequest('/api/models/config-1', { name }, 'PATCH'),
      { params: Promise.resolve({ id: 'config-1' }) },
    );

    expect(response.status).toBe(200);
    expect(mockUpdateModelConfig).toHaveBeenCalledWith('config-1', { name }, 'tenant-1');
  });

  it('PATCH /api/models/:id accepts voice tier updates', async () => {
    const response = await patchModelConfig(
      makeRequest('/api/models/config-1', { tier: 'voice' }, 'PATCH'),
      { params: Promise.resolve({ id: 'config-1' }) },
    );

    expect(response.status).toBe(200);
    expect(mockUpdateModelConfig).toHaveBeenCalledWith('config-1', { tier: 'voice' }, 'tenant-1');
    expect(mockNotifyRuntimeModelConfigChanged).toHaveBeenCalledWith({
      tenantId: 'tenant-1',
      authorization: 'Bearer test-token',
    });
  });

  it('PATCH /api/models/:id preserves project runtime policy overrides', async () => {
    const response = await patchModelConfig(
      makeRequest(
        '/api/models/config-1',
        {
          useResponsesApi: true,
          useStreaming: false,
        },
        'PATCH',
      ),
      { params: Promise.resolve({ id: 'config-1' }) },
    );

    expect(response.status).toBe(200);
    expect(mockUpdateModelConfig).toHaveBeenCalledWith(
      'config-1',
      {
        useResponsesApi: true,
        useStreaming: false,
      },
      'tenant-1',
    );
  });

  it('PATCH /api/models/:id normalizes tenant model refs before persistence', async () => {
    mockTenantModelFindOne.mockReturnValue({
      lean: () =>
        Promise.resolve({
          _id: 'tm-balanced',
          tenantId: 'tenant-1',
          provider: 'openai',
          modelId: 'gpt-4o-mini',
          isActive: true,
          inferenceEnabled: true,
        }),
    });

    const response = await patchModelConfig(
      makeRequest('/api/models/config-1', { tenantModelId: 'tm-balanced' }, 'PATCH'),
      { params: Promise.resolve({ id: 'config-1' }) },
    );

    expect(response.status).toBe(200);
    expect(mockUpdateModelConfig).toHaveBeenCalledWith(
      'config-1',
      {
        tenantModelId: 'tm-balanced',
        modelId: 'gpt-4o-mini',
        provider: 'openai',
      },
      'tenant-1',
    );
  });

  it('PATCH /api/models/:id rejects inaccessible legacy credentials before persistence', async () => {
    const response = await patchModelConfig(
      makeRequest('/api/models/config-1', { credentialId: 'cred-foreign' }, 'PATCH'),
      { params: Promise.resolve({ id: 'config-1' }) },
    );
    const body = await response.json();

    expect(response.status).toBe(404);
    expect(body.error).toBe('Credential not found');
    expect(mockUpdateModelConfig).not.toHaveBeenCalled();
    expect(mockLLMCredentialFindOne).toHaveBeenCalledWith(
      expect.objectContaining({
        _id: 'cred-foreign',
        tenantId: 'tenant-1',
        isActive: true,
      }),
    );
  });

  it('PATCH /api/models/:id revalidates existing credentials when provider changes', async () => {
    mockFindModelConfigByIdAndTenant.mockResolvedValue({
      id: 'config-1',
      projectId: 'proj-1',
      name: 'Existing Model',
      provider: 'openai',
      credentialId: 'cred-openai',
      authProfileId: null,
      tier: 'balanced',
    });
    mockLLMCredentialFindOne.mockResolvedValue({
      _id: 'cred-openai',
      tenantId: 'tenant-1',
      provider: 'openai',
      credentialScope: 'tenant',
      ownerId: 'tenant-1',
      isActive: true,
    });

    const response = await patchModelConfig(
      makeRequest('/api/models/config-1', { provider: 'anthropic' }, 'PATCH'),
      { params: Promise.resolve({ id: 'config-1' }) },
    );
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error).toBe('Credential provider does not match model provider');
    expect(mockUpdateModelConfig).not.toHaveBeenCalled();
    expect(mockLLMCredentialFindOne).toHaveBeenCalledWith(
      expect.objectContaining({
        _id: 'cred-openai',
        tenantId: 'tenant-1',
        isActive: true,
      }),
    );
  });

  it('PATCH /api/models/:id requires explicitly clearing authProfileId before setting credentialId', async () => {
    mockFindModelConfigByIdAndTenant.mockResolvedValue({
      id: 'config-1',
      projectId: 'proj-1',
      name: 'Existing Model',
      provider: 'openai',
      credentialId: null,
      authProfileId: 'profile-1',
      tier: 'balanced',
    });
    mockLLMCredentialFindOne.mockResolvedValue({
      _id: 'cred-openai',
      tenantId: 'tenant-1',
      provider: 'openai',
      credentialScope: 'tenant',
      ownerId: 'tenant-1',
      isActive: true,
    });

    const response = await patchModelConfig(
      makeRequest('/api/models/config-1', { credentialId: 'cred-openai' }, 'PATCH'),
      { params: Promise.resolve({ id: 'config-1' }) },
    );
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error).toBe('Clear authProfileId before setting credentialId');
    expect(mockUpdateModelConfig).not.toHaveBeenCalled();
  });

  it('PATCH /api/models/:id clears defaults only within the target tier', async () => {
    mockFindModelConfigByIdAndTenant.mockResolvedValue({
      id: 'config-1',
      projectId: 'proj-1',
      name: 'Voice Model',
      tier: 'voice',
    });

    const response = await patchModelConfig(
      makeRequest('/api/models/config-1', { isDefault: true }, 'PATCH'),
      { params: Promise.resolve({ id: 'config-1' }) },
    );

    expect(response.status).toBe(200);
    expect(mockClearDefaultModelConfigs).toHaveBeenCalledWith(
      'proj-1',
      'config-1',
      'voice',
      'tenant-1',
    );
    expect(mockUpdateModelConfig).toHaveBeenCalledWith('config-1', { isDefault: true }, 'tenant-1');
  });

  it('DELETE /api/models/:id notifies runtime cache invalidation after persistence', async () => {
    mockDeleteModelConfig.mockResolvedValue(undefined);

    const response = await deleteModelConfig(
      makeRequest('/api/models/config-1', undefined, 'DELETE'),
      { params: Promise.resolve({ id: 'config-1' }) },
    );

    expect(response.status).toBe(200);
    expect(mockDeleteModelConfig).toHaveBeenCalledWith('config-1', 'tenant-1');
    expect(mockNotifyRuntimeModelConfigChanged).toHaveBeenCalledWith({
      tenantId: 'tenant-1',
      authorization: 'Bearer test-token',
    });
  });
});
