import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';

const mockRequireProjectAccess = vi.fn();
const mockFetch = vi.fn();

vi.mock('@/lib/auth', () => ({
  formatUserLabel: (user: { id: string; email?: string | null; name?: string | null }) =>
    user.name || user.email || user.id,
}));

vi.mock('@/lib/project-access', () => ({
  requireProjectAccess: (...args: unknown[]) => mockRequireProjectAccess(...args),
  isAccessError: (result: unknown) => result instanceof NextResponse,
}));

vi.mock('@/lib/route-handler', () => ({
  withRouteHandler:
    (_options: unknown, handler: Function) =>
    async (request: NextRequest, ctx: { params: Promise<Record<string, string>> }) => {
      const params = await ctx.params;
      return handler({
        request,
        user: {
          id: 'user-1',
          email: 'user@example.com',
          tenantId: 'tenant-1',
          permissions: [],
        },
        tenantId: 'tenant-1',
        params,
        body: await request.json(),
      });
    },
}));

function makeRequest(body: unknown): NextRequest {
  return new NextRequest('http://localhost:3000/api/pipelines/builtin:friction-detection/test', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Bearer studio-token',
    },
  });
}

describe('pipeline test route', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('fetch', mockFetch);
    mockRequireProjectAccess.mockResolvedValue({
      project: { id: 'project-1', tenantId: 'tenant-1' },
    });
  });

  it('starts a manual run through Restate and returns the runId', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ runId: 'run-123' }),
    });

    const { POST } = await import('@/app/api/pipelines/[pipelineId]/test/route');
    const response = await POST(
      makeRequest({
        projectId: 'project-1',
        triggerId: 'batch',
        data: { sessionId: 'sess-1' },
      }),
      {
        params: Promise.resolve({ pipelineId: 'builtin:friction-detection' }),
      },
    );
    const body = await response.json();

    expect(mockRequireProjectAccess).toHaveBeenCalledWith(
      'project-1',
      expect.objectContaining({ id: 'user-1', tenantId: 'tenant-1' }),
    );
    expect(mockFetch).toHaveBeenCalledWith(
      'http://localhost:8091/PipelineTrigger/triggerManual',
      expect.objectContaining({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          pipelineId: 'builtin:friction-detection',
          tenantId: 'tenant-1',
          projectId: 'project-1',
          triggeredBy: 'user@example.com',
          triggerId: 'batch',
          data: { sessionId: 'sess-1' },
        }),
      }),
    );
    expect(response.status).toBe(202);
    expect(body).toEqual({ success: true, runId: 'run-123' });
  });

  it('maps inactive trigger failures to a validation response', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      text: async () => 'TRIGGER_NOT_ACTIVE',
    });

    const { POST } = await import('@/app/api/pipelines/[pipelineId]/test/route');
    const response = await POST(
      makeRequest({
        projectId: 'project-1',
        triggerId: 'batch',
        data: { sessionId: 'sess-1' },
      }),
      {
        params: Promise.resolve({ pipelineId: 'builtin:friction-detection' }),
      },
    );
    const body = await response.json();

    expect(response.status).toBe(409);
    expect(body).toEqual({
      success: false,
      errors: [{ msg: 'Trigger is not active', code: 'VALIDATION_ERROR' }],
    });
  });

  it('rejects oversized trigger payloads before calling Restate', async () => {
    const largeMessage = 'x'.repeat(256 * 1024 + 1);
    const { POST } = await import('@/app/api/pipelines/[pipelineId]/test/route');
    const response = await POST(
      makeRequest({
        projectId: 'project-1',
        triggerId: 'batch',
        data: { message: largeMessage },
      }),
      {
        params: Promise.resolve({ pipelineId: 'builtin:friction-detection' }),
      },
    );
    const body = await response.json();

    expect(mockFetch).not.toHaveBeenCalled();
    expect(response.status).toBe(413);
    expect(body).toEqual({
      success: false,
      errors: [{ msg: 'Input exceeds 256 KB', code: 'VALIDATION_ERROR' }],
    });
  });
});
