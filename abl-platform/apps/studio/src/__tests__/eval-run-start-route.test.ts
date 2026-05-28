import { beforeEach, describe, expect, test, vi } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';

const mockRequireTenantAuth = vi.fn();
const mockIsAuthError = vi.fn();
const mockRequireProjectAccess = vi.fn();
const mockIsAccessError = vi.fn();
const mockFindEvalSetById = vi.fn();
const mockHandleApiError = vi.fn();
const mockEnsureDb = vi.fn();
const mockEvalRunFindOneAndUpdate = vi.fn();
const mockEvalRunFindOne = vi.fn();
const mockGetRestateIngressUrl = vi.fn();
const mockFetch = vi.fn();

vi.mock('@/lib/auth', () => ({
  requireTenantAuth: (...args: unknown[]) => mockRequireTenantAuth(...args),
  isAuthError: (...args: unknown[]) => mockIsAuthError(...args),
  formatUserLabel: vi.fn(() => 'Test User'),
}));

vi.mock('@/lib/project-access', () => ({
  requireProjectAccess: (...args: unknown[]) => mockRequireProjectAccess(...args),
  isAccessError: (...args: unknown[]) => mockIsAccessError(...args),
}));

vi.mock('@/repos/eval-repo', () => ({
  findEvalSetById: (...args: unknown[]) => mockFindEvalSetById(...args),
}));

vi.mock('@/lib/api-response', () => ({
  handleApiError: (...args: unknown[]) => mockHandleApiError(...args),
}));

vi.mock('@/lib/restate-url', () => ({
  getRestateIngressUrl: (...args: unknown[]) => mockGetRestateIngressUrl(...args),
}));

vi.mock('@/lib/ensure-db', () => ({
  ensureDb: (...args: unknown[]) => mockEnsureDb(...args),
}));

vi.mock('@agent-platform/database/models', () => ({
  EvalRun: {
    findOneAndUpdate: (...args: unknown[]) => mockEvalRunFindOneAndUpdate(...args),
    findOne: (...args: unknown[]) => mockEvalRunFindOne(...args),
  },
}));

vi.mock('@abl/compiler/platform', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

import { POST } from '@/app/api/projects/[id]/evals/runs/[runId]/start/route';

const authenticatedUser = {
  id: 'user-1',
  email: 'test@example.com',
  name: 'Test User',
  tenantId: 'tenant-1',
};

function makeRequest() {
  return new NextRequest('http://localhost:3000/api/projects/proj-1/evals/runs/run-1/start', {
    method: 'POST',
  });
}

function makeLeanQuery<T>(value: T) {
  return {
    lean: vi.fn(async () => value),
  };
}

describe('POST /api/projects/:id/evals/runs/:runId/start', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    mockRequireTenantAuth.mockResolvedValue(authenticatedUser);
    mockIsAuthError.mockReturnValue(false);
    mockRequireProjectAccess.mockResolvedValue({
      project: {
        id: 'proj-1',
        tenantId: 'tenant-1',
      },
    });
    mockIsAccessError.mockReturnValue(false);
    mockEnsureDb.mockResolvedValue(undefined);
    mockFindEvalSetById.mockResolvedValue({ _id: 'eval-set-1' });
    mockHandleApiError.mockImplementation((error: unknown) =>
      NextResponse.json(
        {
          success: false,
          error: error instanceof Error ? error.message : String(error),
        },
        { status: 500 },
      ),
    );
    mockGetRestateIngressUrl.mockReturnValue('http://localhost:8080');
    mockFetch.mockResolvedValue({
      ok: true,
      status: 202,
      text: vi.fn(async () => ''),
    });
    vi.stubGlobal('fetch', mockFetch);
  });

  test('starts a pending run, triggers Restate, and returns 202', async () => {
    mockEvalRunFindOneAndUpdate.mockReturnValueOnce(
      makeLeanQuery({
        _id: 'run-1',
        evalSetId: 'eval-set-1',
        status: 'running',
      }),
    );

    const response = await POST(makeRequest(), {
      params: Promise.resolve({ id: 'proj-1', runId: 'run-1' }),
    });
    const body = await response.json();

    expect(response.status).toBe(202);
    expect(body.success).toBe(true);
    expect(mockFetch).toHaveBeenCalledWith(
      'http://localhost:8080/EvalRunWorkflow/run-1/run/send',
      expect.objectContaining({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    expect(JSON.parse((mockFetch.mock.calls[0]?.[1] as RequestInit).body as string)).toEqual({
      tenantId: 'tenant-1',
      projectId: 'proj-1',
      runId: 'run-1',
      evalSetId: 'eval-set-1',
    });
  });

  test('returns 404 when the run is not found', async () => {
    mockEvalRunFindOneAndUpdate.mockReturnValueOnce(makeLeanQuery(null));
    mockEvalRunFindOne.mockReturnValueOnce(makeLeanQuery(null));

    const response = await POST(makeRequest(), {
      params: Promise.resolve({ id: 'proj-1', runId: 'run-1' }),
    });
    const body = await response.json();

    expect(response.status).toBe(404);
    expect(body).toEqual({ success: false, error: 'Not found' });
    expect(mockFetch).not.toHaveBeenCalled();
  });

  test('returns 409 when the run is not pending', async () => {
    mockEvalRunFindOneAndUpdate.mockReturnValueOnce(makeLeanQuery(null));
    mockEvalRunFindOne.mockReturnValueOnce(
      makeLeanQuery({
        _id: 'run-1',
        status: 'completed',
      }),
    );

    const response = await POST(makeRequest(), {
      params: Promise.resolve({ id: 'proj-1', runId: 'run-1' }),
    });
    const body = await response.json();

    expect(response.status).toBe(409);
    expect(body.success).toBe(false);
    expect(body.error).toContain("status 'completed'");
    expect(mockFetch).not.toHaveBeenCalled();
  });

  test('reverts the run to pending when the eval set no longer exists', async () => {
    mockEvalRunFindOneAndUpdate
      .mockReturnValueOnce(
        makeLeanQuery({
          _id: 'run-1',
          evalSetId: 'eval-set-missing',
          status: 'running',
        }),
      )
      .mockResolvedValueOnce({ acknowledged: true });
    mockFindEvalSetById.mockResolvedValueOnce(null);

    const response = await POST(makeRequest(), {
      params: Promise.resolve({ id: 'proj-1', runId: 'run-1' }),
    });
    const body = await response.json();

    expect(response.status).toBe(409);
    expect(body).toEqual({
      success: false,
      error: 'Eval set referenced by this run no longer exists',
    });
    expect(mockEvalRunFindOneAndUpdate).toHaveBeenNthCalledWith(
      2,
      { _id: 'run-1', tenantId: 'tenant-1', projectId: 'proj-1' },
      { $set: { status: 'pending', startedAt: null } },
    );
    expect(mockFetch).not.toHaveBeenCalled();
  });

  test('marks the run failed and delegates to handleApiError when Restate triggering fails', async () => {
    mockEvalRunFindOneAndUpdate
      .mockReturnValueOnce(
        makeLeanQuery({
          _id: 'run-1',
          evalSetId: 'eval-set-1',
          status: 'running',
        }),
      )
      .mockReturnValueOnce(Promise.resolve({ acknowledged: true }));
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 503,
      text: vi.fn(async () => 'unavailable'),
    });

    const response = await POST(makeRequest(), {
      params: Promise.resolve({ id: 'proj-1', runId: 'run-1' }),
    });
    const body = await response.json();

    expect(response.status).toBe(500);
    expect(body.success).toBe(false);
    expect(body.error).toContain('Restate trigger failed: 503');
    expect(mockEvalRunFindOneAndUpdate).toHaveBeenNthCalledWith(
      2,
      { _id: 'run-1', tenantId: 'tenant-1', projectId: 'proj-1' },
      { $set: { status: 'failed', completedAt: expect.any(Date) } },
    );
    expect(mockHandleApiError).toHaveBeenCalled();
  });

  test('marks the run failed when fetch itself throws a network error', async () => {
    mockEvalRunFindOneAndUpdate
      .mockReturnValueOnce(
        makeLeanQuery({
          _id: 'run-1',
          evalSetId: 'eval-set-1',
          status: 'running',
        }),
      )
      .mockReturnValueOnce(Promise.resolve({ acknowledged: true }));
    mockFetch.mockRejectedValueOnce(new TypeError('fetch failed'));

    const response = await POST(makeRequest(), {
      params: Promise.resolve({ id: 'proj-1', runId: 'run-1' }),
    });
    const body = await response.json();

    expect(response.status).toBe(500);
    expect(body.success).toBe(false);
    // Run must be reverted to 'failed' — not left stuck in 'running'
    expect(mockEvalRunFindOneAndUpdate).toHaveBeenNthCalledWith(
      2,
      { _id: 'run-1', tenantId: 'tenant-1', projectId: 'proj-1' },
      { $set: { status: 'failed', completedAt: expect.any(Date) } },
    );
    expect(mockHandleApiError).toHaveBeenCalled();
  });
});
