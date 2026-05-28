import { beforeEach, describe, expect, test, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

const {
  mockRequireProjectPermission,
  mockFind,
  mockCountDocuments,
  mockAggregate,
  mockFindOne,
  mockFindOneAndUpdate,
  mockWorkflowExecutionFindOne,
  mockUpdateOne,
} = vi.hoisted(() => ({
  mockRequireProjectPermission: vi.fn(),
  mockFind: vi.fn(),
  mockCountDocuments: vi.fn(),
  mockAggregate: vi.fn(),
  mockFindOne: vi.fn(),
  mockFindOneAndUpdate: vi.fn(),
  mockWorkflowExecutionFindOne: vi.fn(),
  mockUpdateOne: vi.fn(),
}));

vi.mock('../middleware/rbac.js', () => ({
  requirePermissionInline: vi.fn(),
  requireProjectPermission: (...args: unknown[]) => mockRequireProjectPermission(...args),
}));

vi.mock('@abl/compiler/platform', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

vi.mock('@agent-platform/database/models', () => ({
  HumanTask: {
    find: (...args: unknown[]) => mockFind(...args),
    countDocuments: (...args: unknown[]) => mockCountDocuments(...args),
    aggregate: (...args: unknown[]) => mockAggregate(...args),
    findOne: (...args: unknown[]) => mockFindOne(...args),
    findOneAndUpdate: (...args: unknown[]) => mockFindOneAndUpdate(...args),
  },
  WorkflowExecution: {
    findOne: (...args: unknown[]) => mockWorkflowExecutionFindOne(...args),
    updateOne: (...args: unknown[]) => mockUpdateOne(...args),
  },
}));

import { createHumanTaskRouter, type HumanTaskRouteDeps } from '../routes/human-tasks.js';

function buildFindChain(result: unknown[]) {
  return {
    sort: vi.fn().mockReturnValue({
      skip: vi.fn().mockReturnValue({
        limit: vi.fn().mockReturnValue({
          lean: vi.fn().mockResolvedValue(result),
        }),
      }),
    }),
  };
}

function buildLeanResult(result: unknown) {
  return {
    lean: vi.fn().mockResolvedValue(result),
  };
}

function createApp(role = 'MEMBER', deps: HumanTaskRouteDeps = {}) {
  const app = express();
  app.use(express.json());
  app.use((req: any, _res, next) => {
    req.tenantContext = {
      tenantId: 't1',
      projectId: 'p1',
      userId: 'user-1',
      role,
    };
    next();
  });
  app.use('/api/projects/:projectId/human-tasks', createHumanTaskRouter(deps));
  return app;
}

describe('Human Task Routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    mockRequireProjectPermission.mockResolvedValue(true);
    mockFind.mockReturnValue(buildFindChain([]));
    mockCountDocuments.mockResolvedValue(0);
    mockAggregate.mockResolvedValue([]);
    mockFindOne.mockReturnValue(buildLeanResult(null));
    mockFindOneAndUpdate.mockReturnValue(buildLeanResult(null));
    mockWorkflowExecutionFindOne.mockReturnValue(buildLeanResult(null));
    mockUpdateOne.mockResolvedValue({ matchedCount: 1, modifiedCount: 1 });
  });

  test('scopes list counts to the same visible inbox tasks as the main query', async () => {
    const app = createApp();

    mockAggregate
      .mockResolvedValueOnce([{ _id: 'workflow_human_task', count: 2 }])
      .mockResolvedValueOnce([{ _id: 'operations', count: 2 }]);

    const res = await request(app).get('/api/projects/p1/human-tasks');

    expect(res.status).toBe(200);
    expect(mockFind).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: 't1',
        projectId: 'p1',
        $or: [
          { assignedTo: 'user-1' },
          { claimedBy: 'user-1' },
          { assignedTo: { $exists: false } },
          { assignedTo: null },
          { assignedTo: { $size: 0 } },
        ],
      }),
    );

    const typeMatch = mockAggregate.mock.calls[0][0][0].$match;
    expect(typeMatch).toEqual(
      expect.objectContaining({
        tenantId: 't1',
        projectId: 'p1',
        status: { $in: ['pending', 'assigned', 'in_progress'] },
        $or: [
          { assignedTo: 'user-1' },
          { claimedBy: 'user-1' },
          { assignedTo: { $exists: false } },
          { assignedTo: null },
          { assignedTo: { $size: 0 } },
        ],
      }),
    );

    const mailboxMatch = mockAggregate.mock.calls[1][0][0].$match;
    expect(mailboxMatch).toEqual(
      expect.objectContaining({
        tenantId: 't1',
        projectId: 'p1',
        status: { $in: ['pending', 'assigned', 'in_progress'] },
        $or: [
          { assignedTo: 'user-1' },
          { claimedBy: 'user-1' },
          { assignedTo: { $exists: false } },
          { assignedTo: null },
          { assignedTo: { $size: 0 } },
        ],
      }),
    );
  });

  test('uses the hybrid workflow page total instead of a Mongo-only count', async () => {
    const hybridReader = {
      listWorkflowTasksPage: vi.fn().mockResolvedValue({
        rows: [{ _id: 'task-hybrid', source: 'ch' }],
        total: 42,
      }),
    };
    const app = createApp('MEMBER', {
      workflowHybridReader: () => hybridReader,
    });

    mockAggregate
      .mockResolvedValueOnce([{ _id: 'workflow_human_task', count: 2 }])
      .mockResolvedValueOnce([{ _id: 'workflow', count: 2 }]);

    const res = await request(app).get(
      '/api/projects/p1/human-tasks?mailbox=workflow&status=completed',
    );

    expect(res.status).toBe(200);
    expect(hybridReader.listWorkflowTasksPage).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: 't1',
        projectId: 'p1',
        statuses: ['completed'],
        visibility: { kind: 'user_or_open_pool', userId: 'user-1' },
      }),
    );
    expect(mockCountDocuments).not.toHaveBeenCalled();
    expect(res.body.data).toEqual([{ _id: 'task-hybrid', source: 'ch' }]);
    expect(res.body.total).toBe(42);
  });

  test('claims tasks with a project-scoped workflow execution update', async () => {
    const app = createApp();

    mockFindOneAndUpdate.mockReturnValue(
      buildLeanResult({
        _id: 'task-1',
        status: 'in_progress',
        source: {
          executionId: 'exec-1',
          stepId: 'node-1',
        },
      }),
    );
    mockWorkflowExecutionFindOne.mockReturnValue(
      buildLeanResult({
        context: {
          steps: {
            approval_step: { stepId: 'node-1' },
          },
        },
      }),
    );

    const res = await request(app).post('/api/projects/p1/human-tasks/task-1/claim');

    expect(res.status).toBe(200);
    expect(mockWorkflowExecutionFindOne).toHaveBeenCalledWith(
      { _id: 'exec-1', tenantId: 't1', projectId: 'p1' },
      { 'context.steps': 1 },
    );
    await vi.waitFor(() =>
      expect(mockUpdateOne).toHaveBeenCalledWith(
        {
          _id: 'exec-1',
          tenantId: 't1',
          projectId: 'p1',
        },
        { $set: { 'context.steps.approval_step.input.assignTo': 'user-1' } },
      ),
    );
  });

  test('resolves escalations with project-scoped source context', async () => {
    const resolveEscalation = vi.fn().mockResolvedValue({ success: true });
    const app = createApp('MEMBER', { resolveEscalation });

    mockFindOne.mockReturnValue(
      buildLeanResult({
        _id: 'task-1',
        tenantId: 't1',
        projectId: 'p1',
        status: 'in_progress',
        fields: [],
        source: {
          type: 'agent_escalation',
          sessionId: 'session-1',
        },
      }),
    );
    mockFindOneAndUpdate.mockReturnValue(
      buildLeanResult({
        _id: 'task-1',
        status: 'completed',
      }),
    );

    const res = await request(app)
      .post('/api/projects/p1/human-tasks/task-1/resolve')
      .send({ notes: 'Resolved by agent' });

    expect(res.status).toBe(200);
    expect(resolveEscalation).toHaveBeenCalledWith(
      'session-1',
      {
        respondedBy: 'user-1',
        message: 'Resolved by agent',
      },
      expect.objectContaining({
        tenantId: 't1',
        projectId: 'p1',
      }),
    );
  });
});
