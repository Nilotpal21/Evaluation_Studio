import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const mockRequireAuth = vi.fn();
const mockRequireProjectAccess = vi.fn();
const mockImportOperationFindOne = vi.fn();

function makeEmptyEvalModel() {
  return {
    deleteMany: vi.fn(),
    find: vi.fn(() => ({ lean: vi.fn().mockResolvedValue([]) })),
    insertMany: vi.fn(),
  };
}

vi.mock('@/lib/auth', () => ({
  requireAuth: (...args: unknown[]) => mockRequireAuth(...args),
  isAuthError: vi.fn(() => false),
}));

vi.mock('@/services/auth-service', () => ({
  verifyAccessToken: vi.fn(),
}));

vi.mock('@/repos/auth-repo', () => ({
  findUserById: vi.fn(),
}));

vi.mock('@/lib/ensure-db', () => ({
  ensureDb: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@/lib/project-access', () => ({
  requireProjectAccess: (...args: unknown[]) => mockRequireProjectAccess(...args),
  isAccessError: vi.fn(() => false),
}));

vi.mock('@/lib/permission-resolver', () => ({
  hasPermission: vi.fn(() => true),
  hasAnyPermission: vi.fn(() => true),
  resolveStudioPermissions: vi.fn().mockResolvedValue(['project:read']),
}));

vi.mock('@agent-platform/database/models', () => ({
  ensureConnected: vi.fn().mockResolvedValue(undefined),
  COMPLETED_OPERATION_TTL_SECONDS: 30 * 24 * 3600,
  ImportOperation: {
    findOne: (...args: unknown[]) => ({ lean: () => mockImportOperationFindOne(...args) }),
    create: vi.fn(),
  },
  EvalEvaluator: makeEmptyEvalModel(),
  EvalPersona: makeEmptyEvalModel(),
  EvalScenario: makeEmptyEvalModel(),
  EvalSet: makeEmptyEvalModel(),
  ProjectAgent: {
    find: vi.fn(),
    insertMany: vi.fn(),
    bulkWrite: vi.fn(),
    deleteMany: vi.fn(),
  },
  ProjectTool: {
    find: vi.fn(),
    insertMany: vi.fn(),
    bulkWrite: vi.fn(),
    deleteMany: vi.fn(),
  },
  Project: {
    findOne: vi.fn(),
    findOneAndUpdate: vi.fn(),
  },
}));

function makeRequest(operationId?: string): NextRequest {
  const url = new URL('http://localhost:3000/api/projects/proj-1/import/status');
  if (operationId) {
    url.searchParams.set('operationId', operationId);
  }

  return new NextRequest(url, {
    method: 'GET',
  });
}

const routeParams = { params: Promise.resolve({ id: 'proj-1' }) };

beforeEach(() => {
  vi.clearAllMocks();
  mockRequireAuth.mockResolvedValue({
    id: 'user-1',
    email: 'test@test.com',
    name: 'Test User',
    tenantId: 'tenant-1',
    permissions: ['*:*'],
  });
  mockRequireProjectAccess.mockResolvedValue({
    project: {
      id: 'proj-1',
      _id: 'proj-1',
      name: 'Test Project',
      slug: 'test-project',
      ownerId: 'user-1',
      tenantId: 'tenant-1',
    },
  });
});

describe('GET /api/projects/[id]/import/status', () => {
  it('returns 400 when operationId is missing', async () => {
    const mod = await import('@/app/api/projects/[id]/import/status/route');
    const response = await mod.GET(makeRequest(), routeParams);
    const body = await response.json();

    expect({ status: response.status, body }).toEqual({
      status: 400,
      body: {
        success: false,
        error: { code: 'MISSING_PARAM', message: 'operationId is required' },
      },
    });
    expect(mockImportOperationFindOne).not.toHaveBeenCalled();
  });

  it('returns 404 when the operation does not exist for the project and tenant', async () => {
    mockImportOperationFindOne.mockResolvedValue(null);

    const mod = await import('@/app/api/projects/[id]/import/status/route');
    const response = await mod.GET(makeRequest('missing-op'), routeParams);
    const body = await response.json();

    expect({ status: response.status, body }).toEqual({
      status: 404,
      body: {
        success: false,
        error: { code: 'NOT_FOUND', message: 'Import operation not found' },
      },
    });
    expect(mockImportOperationFindOne).toHaveBeenCalledWith({
      _id: 'missing-op',
      projectId: 'proj-1',
      tenantId: 'tenant-1',
    });
  });

  it('returns the shared operation status payload on success', async () => {
    mockImportOperationFindOne.mockResolvedValue({
      _id: 'import-op-1',
      status: 'completed',
      layers: { core: { status: 'activated' } },
      error: { phase: 'staging', layer: 'core', message: 'Recovered' },
      createdAt: '2026-04-01T09:00:00.000Z',
      updatedAt: '2026-04-01T09:05:00.000Z',
    });

    const mod = await import('@/app/api/projects/[id]/import/status/route');
    const response = await mod.GET(makeRequest('import-op-1'), routeParams);
    const body = await response.json();

    expect({ status: response.status, body }).toEqual({
      status: 200,
      body: {
        success: true,
        data: {
          operationId: 'import-op-1',
          status: 'completed',
          layers: { core: { status: 'activated' } },
          error: { phase: 'staging', layer: 'core', message: 'Recovered' },
          createdAt: '2026-04-01T09:00:00.000Z',
          updatedAt: '2026-04-01T09:05:00.000Z',
        },
      },
    });
  });
});
