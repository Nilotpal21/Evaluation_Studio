import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createApprovalRouter, type ApprovalRouteDeps } from '../routes/workflow-approvals.js';

function makeExecution(overrides: Record<string, unknown> = {}) {
  return {
    _id: 'exec-1',
    tenantId: 't1',
    projectId: 'p1',
    workflowId: 'wf-1',
    workflowName: 'Test Workflow',
    status: 'running',
    context: {
      steps: {
        'Get Approval': {
          nodeType: 'approval',
          status: 'waiting_approval',
          stepId: 'step-1',
          startedAt: new Date().toISOString(),
        },
        'Next Step': { nodeType: 'api', status: 'pending', stepId: 'step-2' },
      },
    },
    startedAt: new Date(),
    ...overrides,
  };
}

function makeDeps(overrides: Partial<ApprovalRouteDeps> = {}): ApprovalRouteDeps {
  return {
    executionModel: {
      findOne: vi.fn().mockResolvedValue(makeExecution()),
    },
    restateClient: {
      resolveApproval: vi.fn().mockResolvedValue(undefined),
    },
    humanTaskStore: {
      findBySource: vi.fn().mockResolvedValue(null),
      updateTaskStatus: vi.fn().mockResolvedValue(null),
    },
    ...overrides,
  };
}

function createApp(deps: ApprovalRouteDeps, opts: { withTenant?: boolean } = {}) {
  const app = express();
  app.use(express.json());
  if (opts.withTenant !== false) {
    app.use((req: any, _res, next) => {
      req.tenantContext = { tenantId: 't1', userId: 'user-1' };
      next();
    });
  }
  app.use('/api/projects/:projectId/approvals', createApprovalRouter(deps));
  return app;
}

describe('Workflow Approval Routes', () => {
  let deps: ApprovalRouteDeps;
  let app: express.Express;

  beforeEach(() => {
    deps = makeDeps();
    app = createApp(deps);
  });

  describe('POST /:workflowId/executions/:executionId/steps/:stepId/approve', () => {
    it('approves a waiting step', async () => {
      const res = await request(app)
        .post('/api/projects/p1/approvals/wf-1/executions/exec-1/steps/step-1/approve')
        .send({ decision: 'approve', reason: 'Looks good' });

      expect(res.status).toBe(200);
      expect(res.body.decision).toBe('approve');
      expect(deps.restateClient.resolveApproval).toHaveBeenCalledWith('exec-1', 'step-1', {
        approved: true,
        decidedBy: 'user-1',
        reason: 'Looks good',
      });
    });

    it('rejects a waiting step', async () => {
      const res = await request(app)
        .post('/api/projects/p1/approvals/wf-1/executions/exec-1/steps/step-1/approve')
        .send({ decision: 'reject', reason: 'Too expensive' });

      expect(res.status).toBe(200);
      expect(res.body.decision).toBe('reject');
      expect(deps.restateClient.resolveApproval).toHaveBeenCalledWith('exec-1', 'step-1', {
        approved: false,
        decidedBy: 'user-1',
        reason: 'Too expensive',
      });
    });

    it('returns 400 for invalid decision', async () => {
      const res = await request(app)
        .post('/api/projects/p1/approvals/wf-1/executions/exec-1/steps/step-1/approve')
        .send({ decision: 'maybe' });
      expect(res.status).toBe(400);
    });

    it('returns 400 for missing decision', async () => {
      const res = await request(app)
        .post('/api/projects/p1/approvals/wf-1/executions/exec-1/steps/step-1/approve')
        .send({});
      expect(res.status).toBe(400);
    });

    it('returns 404 for unknown execution', async () => {
      deps.executionModel.findOne = vi.fn().mockResolvedValue(null);
      app = createApp(deps);
      const res = await request(app)
        .post('/api/projects/p1/approvals/wf-1/executions/nonexistent/steps/step-1/approve')
        .send({ decision: 'approve' });
      expect(res.status).toBe(404);
    });

    it('returns 400 when tenant context is missing', async () => {
      const appNoTenant = createApp(deps, { withTenant: false });
      const res = await request(appNoTenant)
        .post('/api/projects/p1/approvals/wf-1/executions/exec-1/steps/step-1/approve')
        .send({ decision: 'approve' });
      expect(res.status).toBe(400);
      expect(deps.restateClient.resolveApproval).not.toHaveBeenCalled();
    });

    it('returns 404 when stepId is not in the execution', async () => {
      deps.executionModel.findOne = vi.fn().mockResolvedValue(
        makeExecution({
          context: {
            steps: {
              'Some Other Step': {
                nodeType: 'approval',
                status: 'waiting_approval',
                stepId: 'some-other-step',
              },
            },
          },
        }),
      );
      app = createApp(deps);
      const res = await request(app)
        .post('/api/projects/p1/approvals/wf-1/executions/exec-1/steps/step-1/approve')
        .send({ decision: 'approve' });
      expect(res.status).toBe(404);
      expect(res.body.error).toMatch(/Step not found/i);
    });

    it('returns 409 when step is not waiting for approval', async () => {
      deps.executionModel.findOne = vi.fn().mockResolvedValue(
        makeExecution({
          context: {
            steps: {
              'Get Approval': { nodeType: 'approval', status: 'completed', stepId: 'step-1' },
            },
          },
        }),
      );
      app = createApp(deps);
      const res = await request(app)
        .post('/api/projects/p1/approvals/wf-1/executions/exec-1/steps/step-1/approve')
        .send({ decision: 'approve' });
      expect(res.status).toBe(409);
    });

    it('returns 503 when Restate is unavailable', async () => {
      deps.restateClient.resolveApproval = vi
        .fn()
        .mockRejectedValue(new Error('Connection refused'));
      app = createApp(deps);
      const res = await request(app)
        .post('/api/projects/p1/approvals/wf-1/executions/exec-1/steps/step-1/approve')
        .send({ decision: 'approve' });
      expect(res.status).toBe(503);
    });

    it('resolves approval via Restate (workflow handler updates context.steps)', async () => {
      const res = await request(app)
        .post('/api/projects/p1/approvals/wf-1/executions/exec-1/steps/step-1/approve')
        .send({ decision: 'approve' });

      expect(res.status).toBe(200);
      expect(deps.restateClient.resolveApproval).toHaveBeenCalledWith(
        'exec-1',
        'step-1',
        expect.objectContaining({ approved: true, decidedBy: 'user-1' }),
      );
    });

    it('syncs mirrored HumanTask record when approval is resolved', async () => {
      const findBySource = vi.fn().mockResolvedValue({ _id: 'task-1', projectId: 'p1' });
      const updateTaskStatus = vi.fn().mockResolvedValue(null);
      deps.humanTaskStore = { findBySource, updateTaskStatus };
      app = createApp(deps);

      const res = await request(app)
        .post('/api/projects/p1/approvals/wf-1/executions/exec-1/steps/step-1/approve')
        .send({ decision: 'approve', reason: 'Looks good' });

      expect(res.status).toBe(200);
      expect(findBySource).toHaveBeenCalledWith('t1', 'p1', 'workflow_approval', {
        executionId: 'exec-1',
        stepId: 'step-1',
      });
      expect(updateTaskStatus).toHaveBeenCalledWith(
        'task-1',
        't1',
        'p1',
        'completed',
        expect.objectContaining({
          response: expect.objectContaining({
            respondedBy: 'user-1',
            notes: 'Looks good',
            decision: 'approve',
          }),
        }),
      );
    });

    it('does not fail the approval when HumanTask sync throws', async () => {
      deps.humanTaskStore = {
        findBySource: vi.fn().mockRejectedValue(new Error('DB down')),
        updateTaskStatus: vi.fn(),
      };
      app = createApp(deps);

      const res = await request(app)
        .post('/api/projects/p1/approvals/wf-1/executions/exec-1/steps/step-1/approve')
        .send({ decision: 'approve' });

      expect(res.status).toBe(200);
      expect(res.body.decision).toBe('approve');
    });
  });
});
