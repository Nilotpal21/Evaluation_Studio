import express, { type RequestHandler } from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createSimulateRouter } from '../simulate.js';
import type {
  compileToResolvedAgent,
  getRuntimeExecutor,
} from '../../services/runtime-executor.js';
import type { findProjectAgentsForProject } from '../../repos/project-repo.js';
import type { requireProjectPermission } from '../../middleware/rbac.js';
import type { getTraceStore } from '../../services/trace-store.js';

const requireProjectPermissionMock = vi.fn();
const findProjectAgentsForProjectMock = vi.fn();
const compileToResolvedAgentMock = vi.fn();
const createSessionFromResolvedMock = vi.fn();
const executeMessageMock = vi.fn();
const getSessionMock = vi.fn();
const endSessionMock = vi.fn();
const clearSessionMock = vi.fn();

const authMiddleware: RequestHandler = (req, _res, next) => {
  req.tenantContext = {
    tenantId: 'tenant-1',
    userId: 'user-1',
    role: 'ADMIN',
    permissions: ['session:execute'],
    authType: 'user',
    isSuperAdmin: false,
  };
  next();
};

const passThroughMiddleware: RequestHandler = (_req, _res, next) => next();

async function createTestApp() {
  const app = express();
  app.use(express.json());
  app.use(
    '/api/projects/:projectId/runtime/simulate',
    createSimulateRouter({
      authMiddleware,
      projectScopeMiddleware: passThroughMiddleware,
      rateLimitMiddleware: passThroughMiddleware,
      requireProjectPermission:
        requireProjectPermissionMock as unknown as typeof requireProjectPermission,
      findProjectAgentsForProject:
        findProjectAgentsForProjectMock as unknown as typeof findProjectAgentsForProject,
      compileToResolvedAgent:
        compileToResolvedAgentMock as unknown as typeof compileToResolvedAgent,
      getRuntimeExecutor: () =>
        ({
          createSessionFromResolved: createSessionFromResolvedMock,
          executeMessage: executeMessageMock,
          getSession: getSessionMock,
          endSession: endSessionMock,
        }) as unknown as ReturnType<typeof getRuntimeExecutor>,
      getTraceStore: () =>
        ({
          clearSession: clearSessionMock,
        }) as unknown as ReturnType<typeof getTraceStore>,
      createFactStore: () => ({ type: 'test-fact-store' }) as never,
    }),
  );
  return app;
}

async function createLiveExecutorTestApp() {
  const app = express();
  app.use(express.json());
  app.use(
    '/api/projects/:projectId/runtime/simulate',
    createSimulateRouter({
      authMiddleware,
      projectScopeMiddleware: passThroughMiddleware,
      rateLimitMiddleware: passThroughMiddleware,
      requireProjectPermission:
        requireProjectPermissionMock as unknown as typeof requireProjectPermission,
      findProjectAgentsForProject:
        findProjectAgentsForProjectMock as unknown as typeof findProjectAgentsForProject,
      getTraceStore: () =>
        ({
          clearSession: clearSessionMock,
        }) as unknown as ReturnType<typeof getTraceStore>,
    }),
  );
  return app;
}

describe('runtime simulation route', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    requireProjectPermissionMock.mockResolvedValue(true);
    compileToResolvedAgentMock.mockReturnValue({ name: 'RefundAgent' });
    createSessionFromResolvedMock.mockReturnValue({ id: 'sim-session-1' });
    executeMessageMock.mockResolvedValue({
      response: 'Refund started',
      action: { type: 'complete' },
    });
    getSessionMock.mockReturnValue({ isComplete: true });
  });

  it('rejects body-level projectId and keeps simulation project scoped to the route', async () => {
    const app = await createTestApp();

    const res = await request(app)
      .post('/api/projects/project-1/runtime/simulate')
      .send({
        projectId: 'project-2',
        agentId: 'RefundAgent',
        scriptedUserTurns: ['refund please'],
      });

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({
      success: false,
      error: { code: 'INVALID_SIMULATION_REQUEST' },
    });
    expect(findProjectAgentsForProjectMock).not.toHaveBeenCalled();
  });

  it('creates an ephemeral simulation session and streams SSE without production persistence', async () => {
    findProjectAgentsForProjectMock.mockResolvedValue([
      {
        name: 'RefundAgent',
        agentPath: 'support/RefundAgent',
        dslContent: 'AGENT: RefundAgent\nGOAL: "Refunds"',
      },
    ]);
    const app = await createTestApp();

    const res = await request(app)
      .post('/api/projects/project-1/runtime/simulate')
      .send({
        agentId: 'RefundAgent',
        dslOverride: 'AGENT: RefundAgent\nGOAL: "Dirty refunds"',
        scriptedUserTurns: ['refund please'],
        mockedToolResponses: {
          lookup_order: { success: true, data: { orderId: 'ord-1' } },
        },
        options: { scenarioId: 'scenario-1' },
      });

    expect(res.status).toBe(200);
    expect(res.text).toContain('event: started');
    expect(res.text).toContain('event: turn');
    expect(res.text).toContain('event: complete');
    expect(findProjectAgentsForProjectMock).toHaveBeenCalledWith('project-1', {
      tenantId: 'tenant-1',
      includeDSLContent: true,
    });
    expect(compileToResolvedAgentMock).toHaveBeenCalledWith(
      ['AGENT: RefundAgent\nGOAL: "Dirty refunds"'],
      'RefundAgent',
    );
    expect(createSessionFromResolvedMock).toHaveBeenCalledWith(
      { name: 'RefundAgent' },
      expect.objectContaining({
        tenantId: 'tenant-1',
        projectId: 'project-1',
        userId: 'user-1',
        channelType: 'simulation',
        ephemeralExecution: { kind: 'simulation', scenarioId: 'scenario-1' },
      }),
    );
    expect(endSessionMock).toHaveBeenCalledWith(expect.stringMatching(/^sim_/));
    expect(clearSessionMock).toHaveBeenCalledWith(expect.stringMatching(/^sim_/));
  });

  it('applies dslOverride only to the target agent while preserving sibling DSLs', async () => {
    findProjectAgentsForProjectMock.mockResolvedValue([
      {
        name: 'Router',
        agentPath: 'support/Router',
        dslContent: 'SUPERVISOR: Router\nGOAL: "Route support"',
      },
      {
        name: 'RefundAgent',
        agentPath: 'support/RefundAgent',
        dslContent: 'AGENT: RefundAgent\nGOAL: "Persisted refunds"',
      },
    ]);
    const app = await createTestApp();

    const res = await request(app)
      .post('/api/projects/project-1/runtime/simulate')
      .send({
        agentId: 'RefundAgent',
        dslOverride: 'AGENT: RefundAgent\nGOAL: "Dirty refunds"',
        scriptedUserTurns: ['refund please'],
      });

    expect(res.status).toBe(200);
    expect(compileToResolvedAgentMock).toHaveBeenCalledWith(
      ['SUPERVISOR: Router\nGOAL: "Route support"', 'AGENT: RefundAgent\nGOAL: "Dirty refunds"'],
      'RefundAgent',
    );
  });

  it('returns an HTTP failure when compilation fails before the SSE stream starts', async () => {
    findProjectAgentsForProjectMock.mockResolvedValue([
      {
        name: 'RefundAgent',
        agentPath: 'support/RefundAgent',
        dslContent: 'AGENT: RefundAgent\nGOAL: "Refunds"',
      },
    ]);
    compileToResolvedAgentMock.mockImplementation(() => {
      throw new Error('compile failed');
    });
    const app = await createTestApp();

    const res = await request(app)
      .post('/api/projects/project-1/runtime/simulate')
      .send({
        agentId: 'RefundAgent',
        scriptedUserTurns: ['refund please'],
      });

    expect(res.status).toBe(500);
    expect(res.body).toMatchObject({
      success: false,
      error: { code: 'SIMULATION_FAILED' },
    });
    expect(res.text).not.toContain('event: error');
    expect(endSessionMock).not.toHaveBeenCalled();
  });

  it('executes the simulate route through the real compiler and runtime executor', async () => {
    findProjectAgentsForProjectMock.mockResolvedValue([
      {
        name: 'RefundAgent',
        agentPath: 'support/RefundAgent',
        dslContent: `AGENT: RefundAgent
GOAL: "Run deterministic simulation"
PERSONA: "Helpful"
FLOW:
  start:
    REASONING: false
    RESPOND: "Simulation complete"
    COMPLETE: true
`,
      },
    ]);
    const app = await createLiveExecutorTestApp();

    const res = await request(app)
      .post('/api/projects/project-1/runtime/simulate')
      .send({
        agentId: 'RefundAgent',
        scriptedUserTurns: ['start'],
      });

    expect(res.status).toBe(200);
    expect(res.text).toContain('event: started');
    expect(res.text).toContain('event: turn');
    expect(res.text).toContain('Simulation complete');
    expect(res.text).toContain('event: complete');
    expect(compileToResolvedAgentMock).not.toHaveBeenCalled();
    expect(createSessionFromResolvedMock).not.toHaveBeenCalled();
    expect(executeMessageMock).not.toHaveBeenCalled();
    expect(endSessionMock).not.toHaveBeenCalled();
    expect(clearSessionMock).toHaveBeenCalledWith(expect.stringMatching(/^sim_/));
  });
});
