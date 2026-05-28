/**
 * Unit tests for the human-task-resolution route.
 *
 * POST /executions/:executionId/steps/:stepId/resolve
 *
 * Covers:
 *   - happy path resolves Restate promise + syncs MongoDB HumanTask
 *   - 400 on missing tenant/project params, 401 on missing userId
 *   - 404 on missing execution or unknown step
 *   - 409 when step is not in 'waiting_human_task' status
 *   - 503 when Restate resolution fails
 *   - identity spoofing: client-supplied respondedBy is ignored; authenticated
 *     userId is used (warn logged, but still 200)
 *   - HumanTask sync failure is swallowed (200 still returned)
 *   - HumanTask not found after resolve — logs warn but still 200
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import {
  createHumanTaskResolutionRouter,
  type HumanTaskResolutionRouteDeps,
} from '../routes/human-task-resolution.js';

function makeDeps(
  overrides: Partial<HumanTaskResolutionRouteDeps> = {},
): HumanTaskResolutionRouteDeps {
  return {
    executionModel: {
      findOne: vi.fn().mockResolvedValue({
        _id: 'exec-1',
        tenantId: 't1',
        projectId: 'p1',
        context: {
          steps: {
            'Task Step': { stepId: 'step-1', status: 'waiting_human_task' },
            'Other Step': { stepId: 'step-other', status: 'completed' },
          },
        },
      }),
    },
    restateClient: {
      resolveHumanTask: vi.fn().mockResolvedValue(undefined),
    },
    humanTaskStore: {
      findBySource: vi.fn().mockResolvedValue({ _id: 'task-1', projectId: 'p1' }),
      updateTaskStatus: vi.fn().mockResolvedValue(undefined),
    },
    ...overrides,
  };
}

function createApp(
  deps: HumanTaskResolutionRouteDeps,
  options: { tenantId?: string | null; userId?: string | null } = {},
) {
  const app = express();
  app.use(express.json());
  const tenantId = options.tenantId === undefined ? 't1' : options.tenantId;
  const userId = options.userId === undefined ? 'user-1' : options.userId;
  app.use((req: any, _res, next) => {
    if (tenantId !== null || userId !== null) {
      req.tenantContext = {
        ...(tenantId !== null ? { tenantId } : {}),
        ...(userId !== null ? { userId } : {}),
      };
    }
    next();
  });
  app.use('/api/projects/:projectId/human-tasks', createHumanTaskResolutionRouter(deps));
  return app;
}

const URL = '/api/projects/p1/human-tasks/executions/exec-1/steps/step-1/resolve';

describe('Human Task Resolution Route', () => {
  let deps: HumanTaskResolutionRouteDeps;

  beforeEach(() => {
    deps = makeDeps();
  });

  it('resolves a waiting_human_task step end-to-end', async () => {
    const app = createApp(deps);
    const res = await request(app)
      .post(URL)
      .send({
        fields: { approved: true },
        notes: 'looks good',
        decision: 'approved',
      });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.executionId).toBe('exec-1');
    expect(res.body.stepId).toBe('step-1');

    expect(deps.restateClient.resolveHumanTask).toHaveBeenCalledWith(
      'exec-1',
      'step-1',
      expect.objectContaining({
        respondedBy: 'user-1',
        fields: { approved: true },
        notes: 'looks good',
        decision: 'approved',
      }),
    );
    expect(deps.humanTaskStore.findBySource).toHaveBeenCalledWith(
      't1',
      'p1',
      'workflow_human_task',
      {
        executionId: 'exec-1',
        stepId: 'step-1',
      },
    );
    expect(deps.humanTaskStore.updateTaskStatus).toHaveBeenCalledWith(
      'task-1',
      't1',
      'p1',
      'completed',
      expect.objectContaining({
        response: expect.objectContaining({
          respondedBy: 'user-1',
          fields: { approved: true },
          notes: 'looks good',
          decision: 'approved',
          respondedAt: expect.any(Date),
        }),
      }),
    );
  });

  it('uses provided respondedAt as resolvedAt Date in HumanTask sync', async () => {
    const app = createApp(deps);
    await request(app).post(URL).send({
      fields: {},
      respondedAt: '2026-04-01T10:00:00.000Z',
    });
    expect(deps.humanTaskStore.updateTaskStatus).toHaveBeenCalledWith(
      'task-1',
      't1',
      'p1',
      'completed',
      expect.objectContaining({
        response: expect.objectContaining({
          respondedAt: new Date('2026-04-01T10:00:00.000Z'),
        }),
      }),
    );
  });

  it('defaults fields to {} when body has none', async () => {
    const app = createApp(deps);
    const res = await request(app).post(URL).send({});
    expect(res.status).toBe(200);
    expect(deps.restateClient.resolveHumanTask).toHaveBeenCalledWith(
      'exec-1',
      'step-1',
      expect.objectContaining({ fields: {} }),
    );
  });

  it('ignores client-supplied respondedBy and uses authenticated userId', async () => {
    const app = createApp(deps);
    const res = await request(app).post(URL).send({
      fields: {},
      respondedBy: 'attacker',
    });
    expect(res.status).toBe(200);
    expect(deps.restateClient.resolveHumanTask).toHaveBeenCalledWith(
      'exec-1',
      'step-1',
      expect.objectContaining({ respondedBy: 'user-1' }),
    );
  });

  it('returns 400 when tenant context missing', async () => {
    const app = createApp(deps, { tenantId: null });
    const res = await request(app).post(URL).send({ fields: {} });
    expect(res.status).toBe(400);
  });

  it('returns 401 when userId missing', async () => {
    const app = createApp(deps, { userId: null });
    const res = await request(app).post(URL).send({ fields: {} });
    expect(res.status).toBe(401);
    expect(deps.restateClient.resolveHumanTask).not.toHaveBeenCalled();
  });

  it('returns 404 when execution not found', async () => {
    deps = makeDeps({
      executionModel: { findOne: vi.fn().mockResolvedValue(null) },
    });
    const app = createApp(deps);
    const res = await request(app).post(URL).send({ fields: {} });
    expect(res.status).toBe(404);
    expect(deps.restateClient.resolveHumanTask).not.toHaveBeenCalled();
  });

  it('returns 404 when step not in execution', async () => {
    deps = makeDeps({
      executionModel: {
        findOne: vi.fn().mockResolvedValue({
          _id: 'exec-1',
          tenantId: 't1',
          projectId: 'p1',
          context: {
            steps: {
              'Other Step': { stepId: 'another-step', status: 'waiting_human_task' },
            },
          },
        }),
      },
    });
    const app = createApp(deps);
    const res = await request(app).post(URL).send({ fields: {} });
    expect(res.status).toBe(404);
    expect(deps.restateClient.resolveHumanTask).not.toHaveBeenCalled();
  });

  it('returns 409 when step is not waiting_human_task', async () => {
    deps = makeDeps({
      executionModel: {
        findOne: vi.fn().mockResolvedValue({
          _id: 'exec-1',
          tenantId: 't1',
          projectId: 'p1',
          context: {
            steps: {
              'Task Step': { stepId: 'step-1', status: 'completed' },
            },
          },
        }),
      },
    });
    const app = createApp(deps);
    const res = await request(app).post(URL).send({ fields: {} });
    expect(res.status).toBe(409);
    expect(deps.restateClient.resolveHumanTask).not.toHaveBeenCalled();
  });

  it('returns 503 when Restate resolve fails', async () => {
    deps = makeDeps({
      restateClient: {
        resolveHumanTask: vi.fn().mockRejectedValue(new Error('restate unreachable')),
      },
    });
    const app = createApp(deps);
    const res = await request(app).post(URL).send({ fields: {} });
    expect(res.status).toBe(503);
    // Sync should not have been attempted when Restate fails
    expect(deps.humanTaskStore.findBySource).not.toHaveBeenCalled();
  });

  it('still returns 200 when HumanTask sync fails (logs and swallows)', async () => {
    deps = makeDeps({
      humanTaskStore: {
        findBySource: vi.fn().mockRejectedValue(new Error('mongo down')),
        updateTaskStatus: vi.fn().mockResolvedValue(undefined),
      },
    });
    const app = createApp(deps);
    const res = await request(app).post(URL).send({ fields: {} });
    expect(res.status).toBe(200);
  });

  it('still returns 200 when no HumanTask doc matches (logs warn)', async () => {
    deps = makeDeps({
      humanTaskStore: {
        findBySource: vi.fn().mockResolvedValue(null),
        updateTaskStatus: vi.fn().mockResolvedValue(undefined),
      },
    });
    const app = createApp(deps);
    const res = await request(app).post(URL).send({ fields: {} });
    expect(res.status).toBe(200);
    expect(deps.humanTaskStore.updateTaskStatus).not.toHaveBeenCalled();
  });
});
