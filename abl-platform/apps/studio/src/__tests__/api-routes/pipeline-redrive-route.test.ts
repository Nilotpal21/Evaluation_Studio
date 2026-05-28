import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';
import { rateLimiter } from '../../lib/rate-limiter';
import { POST } from '../../app/api/pipelines/runs/[runId]/redrive/route';

const {
  mockRequireTenantAuth,
  mockRequireProjectAccess,
  mockPipelineRunFindOne,
  mockGetRestateIngressUrl,
} = vi.hoisted(() => ({
  mockRequireTenantAuth: vi.fn(),
  mockRequireProjectAccess: vi.fn(),
  mockPipelineRunFindOne: vi.fn(),
  mockGetRestateIngressUrl: vi.fn(),
}));

vi.mock('@/lib/auth', () => ({
  requireTenantAuth: (...args: unknown[]) => mockRequireTenantAuth(...args),
  isAuthError: (value: unknown) => value instanceof NextResponse,
  formatUserLabel: (user: { email?: string; id: string }) => user.email ?? user.id,
}));

vi.mock('@/lib/project-access', () => ({
  requireProjectAccess: (...args: unknown[]) => mockRequireProjectAccess(...args),
  isAccessError: (value: unknown) => value instanceof NextResponse,
}));

vi.mock('@/lib/restate-url', () => ({
  getRestateIngressUrl: () => mockGetRestateIngressUrl(),
}));

vi.mock('@agent-platform/pipeline-engine/schemas', () => ({
  PipelineRunRecordModel: {
    findOne: (...args: unknown[]) => mockPipelineRunFindOne(...args),
  },
}));

const user = {
  id: 'user-1',
  email: 'dev@example.com',
  tenantId: 'tenant-1',
};

const run = {
  runId: 'run-1',
  tenantId: 'tenant-1',
  projectId: 'project-1',
  pipelineId: 'pipeline-1',
  trigger: { triggerId: 'manual-1' },
  triggerInput: { message: 'retry me' },
};

function makeRequest(runId = 'run-1') {
  return new NextRequest(`http://localhost/api/pipelines/runs/${runId}/redrive`, {
    method: 'POST',
  });
}

function makeRouteCtx(runId = 'run-1') {
  return { params: Promise.resolve({ runId }) };
}

function mockRunLookup(value: typeof run | null = run) {
  mockPipelineRunFindOne.mockReturnValue({
    lean: vi.fn().mockResolvedValue(value),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  rateLimiter.clear();
  mockRequireTenantAuth.mockResolvedValue(user);
  mockRequireProjectAccess.mockResolvedValue({ project: { id: 'project-1' } });
  mockGetRestateIngressUrl.mockReturnValue('http://restate.test');
  mockRunLookup();
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue({ runId: 'new-run-1' }),
    }),
  );
});

describe('pipeline redrive route', () => {
  it('denies access when the run belongs to a project the user cannot access', async () => {
    mockRequireProjectAccess.mockResolvedValue(
      NextResponse.json(
        { success: false, errors: [{ msg: 'Not found', code: 'NOT_FOUND' }] },
        { status: 404 },
      ),
    );

    const response = await POST(makeRequest(), makeRouteCtx());

    expect(response.status).toBe(404);
    expect(mockPipelineRunFindOne).toHaveBeenCalledWith({
      runId: 'run-1',
      tenantId: 'tenant-1',
    });
    expect(mockRequireProjectAccess).toHaveBeenCalledWith('project-1', user);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('rate limits repeated redrive attempts before loading run data', async () => {
    for (let i = 0; i < 10; i += 1) {
      const response = await POST(makeRequest(), makeRouteCtx());
      expect(response.status).toBe(200);
    }

    const rateLimited = await POST(makeRequest(), makeRouteCtx());

    expect(rateLimited.status).toBe(429);
    expect(rateLimited.headers.get('Retry-After')).toBeTruthy();
    expect(mockPipelineRunFindOne).toHaveBeenCalledTimes(10);
  });
});
