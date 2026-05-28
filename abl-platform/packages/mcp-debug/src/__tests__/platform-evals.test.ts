import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  platformEvalPersonas,
  platformEvalRuns,
  platformEvalScenarios,
} from '../tools/platform-evals.js';
import type { DebugContext } from '../tools/index.js';
import { requestStudioJson } from '../utils/studio-api.js';

vi.mock('../utils/studio-api.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../utils/studio-api.js')>();
  return {
    ...actual,
    requestStudioJson: vi.fn(),
    formatStudioFailure: (
      path: string,
      result: { status: number; statusText: string; body: unknown },
      method = 'POST',
    ) =>
      JSON.stringify({
        success: false,
        error: `${method} ${path} failed: ${result.status} ${result.statusText}`,
        body: result.body,
      }),
  };
});

const requestStudioJsonMock = vi.mocked(requestStudioJson);

const ctx = {
  httpClient: {
    getBaseUrl: () => 'http://localhost:3112',
    getAuthToken: () => 'token-123',
  },
} as unknown as DebugContext;

beforeEach(() => {
  requestStudioJsonMock.mockReset();
  requestStudioJsonMock.mockResolvedValue({ ok: true, body: { success: true } });
});

describe('platform eval tools', () => {
  it('builds eval run compare queries from structured runIds', async () => {
    const raw = await platformEvalRuns(
      {
        action: 'compare',
        projectId: 'proj_123',
        runIds: ['run-a', 'run-b'],
      },
      ctx,
    );

    expect(JSON.parse(raw)).toMatchObject({ success: true });
    expect(requestStudioJsonMock).toHaveBeenCalledWith(
      ctx,
      expect.objectContaining({
        method: 'GET',
        path: '/api/projects/proj_123/evals/runs/compare?runIds=run-a%2Crun-b',
      }),
    );
  });

  it('rejects eval run compare without exactly two run IDs before calling Studio', async () => {
    const raw = await platformEvalRuns(
      {
        action: 'compare',
        projectId: 'proj_123',
        runIds: ['run-a'],
      },
      ctx,
    );

    expect(JSON.parse(raw)).toMatchObject({
      success: false,
      error: 'runIds must contain exactly two run IDs for compare.',
    });
    expect(requestStudioJsonMock).not.toHaveBeenCalled();
  });

  it('rejects blank eval run compare IDs before calling Studio', async () => {
    const raw = await platformEvalRuns(
      {
        action: 'compare',
        projectId: 'proj_123',
        runIds: ['run-a', '   '],
      },
      ctx,
    );

    expect(JSON.parse(raw)).toMatchObject({
      success: false,
      error: 'runIds must contain exactly two run IDs for compare.',
    });
    expect(requestStudioJsonMock).not.toHaveBeenCalled();
  });

  it('exposes AI persona and scenario generation endpoints for repair loops', async () => {
    await platformEvalPersonas(
      {
        action: 'generate',
        projectId: 'proj_123',
        body: { count: 2, focusAreas: ['handoff'] },
      },
      ctx,
    );
    await platformEvalScenarios(
      {
        action: 'generate',
        projectId: 'proj_123',
        body: { count: 2, personaIds: ['persona-a'] },
      },
      ctx,
    );

    expect(requestStudioJsonMock).toHaveBeenNthCalledWith(
      1,
      ctx,
      expect.objectContaining({
        method: 'POST',
        path: '/api/projects/proj_123/evals/generate/personas',
        body: { count: 2, focusAreas: ['handoff'] },
      }),
    );
    expect(requestStudioJsonMock).toHaveBeenNthCalledWith(
      2,
      ctx,
      expect.objectContaining({
        method: 'POST',
        path: '/api/projects/proj_123/evals/generate/scenarios',
        body: { count: 2, personaIds: ['persona-a'] },
      }),
    );
  });

  it('exposes eval preflight and quick-run workflow endpoints', async () => {
    await platformEvalRuns({ action: 'preflight', projectId: 'proj_123' }, ctx);
    await platformEvalRuns(
      { action: 'quick', projectId: 'proj_123', body: { name: 'Smoke eval' } },
      ctx,
    );

    expect(requestStudioJsonMock).toHaveBeenNthCalledWith(
      1,
      ctx,
      expect.objectContaining({
        method: 'POST',
        path: '/api/projects/proj_123/evals/preflight',
        body: {},
      }),
    );
    expect(requestStudioJsonMock).toHaveBeenNthCalledWith(
      2,
      ctx,
      expect.objectContaining({
        method: 'POST',
        path: '/api/projects/proj_123/evals/quick',
        body: { name: 'Smoke eval' },
      }),
    );
  });

  it('sanitizes raw preflight diagnostics returned by older Studio deployments', async () => {
    requestStudioJsonMock.mockResolvedValueOnce({
      ok: true,
      body: {
        success: true,
        result: {
          overall: 'warn',
          timestamp: '2026-05-21T00:00:00.000Z',
          checks: [
            {
              name: 'runtime_reachable',
              status: 'pass',
              message: 'Runtime at http://runtime:3112 is healthy',
              durationMs: 4.4,
            },
            {
              name: 'clickhouse',
              status: 'pass',
              message: 'ClickHouse eval_conversations table accessible',
              durationMs: 5,
            },
            {
              name: 'llm_credentials',
              status: 'fail',
              code: 'MISSING_PROVIDER_KEY',
              message: 'No OpenAI credential found for tenant tenant-1',
              durationMs: 6,
            },
            {
              name: 'runtime_auth',
              status: 'warn',
              message: 'Could not verify Runtime auth: JWT_SECRET mismatch',
              durationMs: 7,
            },
          ],
        },
      },
    });

    const raw = await platformEvalRuns({ action: 'preflight', projectId: 'proj_123' }, ctx);
    const body = JSON.parse(raw);

    expect(body).toMatchObject({
      success: true,
      data: {
        success: true,
        result: {
          overall: 'warn',
          checks: [
            {
              name: 'agent_service_connectivity',
              status: 'pass',
              message: 'Agent service is reachable.',
              durationMs: 4,
            },
            {
              name: 'results_storage',
              status: 'pass',
              message: 'Eval results storage is ready.',
              durationMs: 5,
            },
            {
              name: 'model_credentials',
              status: 'fail',
              message: 'Model credentials need attention before evals can run.',
              durationMs: 6,
            },
            {
              name: 'agent_service_authorization',
              status: 'warn',
              message: 'Agent service authorization should be reviewed before evals run.',
              durationMs: 7,
            },
          ],
        },
      },
    });

    const serializedBody = raw.toLowerCase();
    for (const leakedToken of [
      'clickhouse',
      'eval_conversations',
      'runtime_reachable',
      'runtime_auth',
      'llm_credentials',
      'jwt_secret',
      'tenant-1',
      'openai',
    ]) {
      expect(serializedBody).not.toContain(leakedToken);
    }
  });

  it('exposes eval run case drill-down with diagnostic filters', async () => {
    await platformEvalRuns(
      {
        action: 'cases',
        projectId: 'proj_123',
        runId: 'run-1',
        query: {
          view: 'diagnostic',
          failedOnly: true,
          evaluatorId: 'eval-1',
        },
      },
      ctx,
    );

    expect(requestStudioJsonMock).toHaveBeenCalledWith(
      ctx,
      expect.objectContaining({
        method: 'GET',
        path: '/api/projects/proj_123/evals/runs/run-1/cases?view=diagnostic&failedOnly=true&evaluatorId=eval-1',
      }),
    );
  });
});
