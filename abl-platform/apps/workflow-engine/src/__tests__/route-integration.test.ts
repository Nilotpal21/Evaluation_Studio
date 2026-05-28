/**
 * Route Integration Tests
 *
 * Verifies Studio HTTP requests → Express routes → model operations → responses.
 * All 6 route modules are tested with injected mock dependencies.
 *
 * Real: Express router, request validation, tenant isolation, response structure.
 * Mocked: Mongoose models, RestateClient, EncryptionService, ConnectorRegistry.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import crypto from 'crypto';
import {
  createWorkflowExecutionRouter,
  type WorkflowExecutionRouteDeps,
} from '../routes/workflow-executions.js';
import { createCallbackRouter, type CallbackRouteDeps } from '../routes/workflow-callbacks.js';
import { createApprovalRouter, type ApprovalRouteDeps } from '../routes/workflow-approvals.js';
import { createConnectionRouter, type ConnectionRouteDeps } from '../routes/connections.js';
import type { ConnectionRecord } from '@agent-platform/connectors/services';
import {
  createNotificationRuleRouter,
  type NotificationRuleDeps,
} from '../routes/notification-rules.js';

// ---------------------------------------------------------------------------
// Shared Test Setup
// ---------------------------------------------------------------------------

function injectTenantContext(app: express.Express): void {
  app.use((req: any, _res, next) => {
    req.tenantContext = { tenantId: 't1', userId: 'user-1' };
    next();
  });
}

// ---------------------------------------------------------------------------
// Suite 1: Workflow Execution Routes
// ---------------------------------------------------------------------------

describe('Workflow Execution Routes', () => {
  function makeExecDeps(
    overrides: Partial<WorkflowExecutionRouteDeps> = {},
  ): WorkflowExecutionRouteDeps {
    return {
      executionModel: {
        find: vi.fn().mockReturnValue({
          sort: vi.fn().mockReturnValue({
            limit: vi.fn().mockReturnValue({
              lean: vi
                .fn()
                .mockResolvedValue([{ _id: 'exec-1', status: 'completed', workflowId: 'wf-1' }]),
            }),
          }),
        }),
        findOne: vi.fn().mockResolvedValue({
          _id: 'exec-1',
          status: 'running',
          tenantId: 't1',
          projectId: 'p1',
          workflowId: 'wf-1',
          steps: [],
        }),
        findOneAndUpdate: vi.fn().mockResolvedValue({ _id: 'exec-1', status: 'cancelled' }),
      },
      workflowModel: {
        findOne: vi.fn().mockResolvedValue({
          _id: 'wf-1',
          name: 'My Workflow',
          steps: [{ id: 's1', type: 'http' }],
        }),
      },
      restateClient: {
        startWorkflow: vi.fn().mockResolvedValue(undefined),
        startLegacyWorkflow: vi.fn().mockResolvedValue(undefined),
        cancelWorkflow: vi.fn().mockResolvedValue(undefined),
        cancelLegacyWorkflow: vi.fn().mockResolvedValue(undefined),
      },
      persistence: {
        createExecution: vi.fn().mockResolvedValue(undefined),
      },
      publisher: {
        publish: vi.fn().mockResolvedValue(undefined),
      },
      ...overrides,
    };
  }

  function createExecApp(deps: WorkflowExecutionRouteDeps): express.Express {
    const app = express();
    app.use(express.json());
    injectTenantContext(app);
    app.use(
      '/api/projects/:projectId/workflows/:workflowId/executions',
      createWorkflowExecutionRouter(deps),
    );
    return app;
  }

  let deps: WorkflowExecutionRouteDeps;
  let app: express.Express;

  beforeEach(() => {
    deps = makeExecDeps();
    app = createExecApp(deps);
  });

  it('POST /execute creates execution and calls Restate', async () => {
    const res = await request(app)
      .post('/api/projects/p1/workflows/wf-1/executions/execute')
      .send({ payload: { key: 'value' } });

    expect(res.status).toBe(202);
    expect(res.body.success).toBe(true);
    expect(res.body.executionId).toBeDefined();

    // Verify workflow lookup with tenant scoping
    expect(deps.workflowModel.findOne).toHaveBeenCalledWith({
      _id: 'wf-1',
      tenantId: 't1',
      projectId: 'p1',
    });

    // Relay-race: full payload in createExecution; Restate gets lean input.
    expect(deps.persistence.createExecution).toHaveBeenCalledWith(
      expect.objectContaining({
        workflowId: 'wf-1',
        tenantId: 't1',
        projectId: 'p1',
        triggerType: 'studio',
      }),
    );
    expect(deps.restateClient.startWorkflow).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ tenantId: 't1', projectId: 'p1' }),
    );
  });

  it('POST /execute returns 404 for unknown workflow', async () => {
    deps.workflowModel.findOne = vi.fn().mockResolvedValue(null);
    app = createExecApp(deps);

    const res = await request(app)
      .post('/api/projects/p1/workflows/wf-unknown/executions/execute')
      .send({});

    expect(res.status).toBe(404);
    expect(res.body.error).toEqual({
      code: 'WORKFLOW_NOT_FOUND',
      message: 'Workflow not found',
    });
  });

  it('GET / lists executions with tenant scoping', async () => {
    const res = await request(app).get('/api/projects/p1/workflows/wf-1/executions');

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toHaveLength(1);

    expect(deps.executionModel.find).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: 't1', projectId: 'p1', workflowId: 'wf-1' }),
    );
  });

  it('GET /:executionId returns single execution', async () => {
    const res = await request(app).get('/api/projects/p1/workflows/wf-1/executions/exec-1');

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);

    expect(deps.executionModel.findOne).toHaveBeenCalledWith({
      _id: 'exec-1',
      tenantId: 't1',
      projectId: 'p1',
      workflowId: 'wf-1',
    });
  });

  it('POST /:executionId/cancel rejects non-cancellable status', async () => {
    deps.executionModel.findOne = vi.fn().mockResolvedValue({
      _id: 'exec-1',
      status: 'completed',
      tenantId: 't1',
    });
    app = createExecApp(deps);

    const res = await request(app).post('/api/projects/p1/workflows/wf-1/executions/exec-1/cancel');

    expect(res.status).toBe(409);
    expect(res.body.error).toEqual({
      code: 'EXECUTION_NOT_CANCELLABLE',
      message: expect.stringContaining('Cannot cancel'),
    });
  });

  it('cross-tenant execution access returns 404', async () => {
    deps.executionModel.findOne = vi.fn().mockResolvedValue(null);
    app = createExecApp(deps);

    const res = await request(app).get('/api/projects/p1/workflows/wf-1/executions/exec-other');

    expect(res.status).toBe(404);
    expect(res.body.error).toEqual({
      code: 'EXECUTION_NOT_FOUND',
      message: 'Execution not found',
    });
  });
});

// ---------------------------------------------------------------------------
// Suite 2: Callback Routes
// ---------------------------------------------------------------------------

describe('Callback Routes', () => {
  const CALLBACK_SECRET = 'decrypted-secret';
  const ENCRYPTED_SECRET = 'encrypted-secret';

  /** Sign a JSON body with HMAC-SHA256, including timestamp in signed content (epoch seconds) */
  function signBody(body: unknown, timestamp: string): string {
    const raw = JSON.stringify(body);
    const signedContent = `${timestamp}.${raw}`;
    const hmac = crypto
      .createHmac('sha256', CALLBACK_SECRET)
      .update(Buffer.from(signedContent))
      .digest('hex');
    return `sha256=${hmac}`;
  }

  function makeCallbackDeps(overrides: Partial<CallbackRouteDeps> = {}): CallbackRouteDeps {
    return {
      executionModel: {
        findOne: vi.fn().mockResolvedValue({
          _id: 'exec-1',
          tenantId: 't1',
          projectId: 'p1',
          workflowId: 'wf-1',
          status: 'running',
          context: {
            steps: {
              'Webhook Step': {
                status: 'waiting_callback',
                stepId: 'step-1',
                callbackSecret: ENCRYPTED_SECRET,
              },
            },
          },
        }),
      },
      restateClient: {
        resolveCallback: vi.fn().mockResolvedValue(undefined),
      },
      decryptSecret: vi.fn().mockResolvedValue(CALLBACK_SECRET),
      ...overrides,
    };
  }

  function createCallbackApp(deps: CallbackRouteDeps): express.Express {
    const app = express();
    app.use(
      express.json({
        verify: (_req, _res, buf) => {
          (_req as any).rawBody = buf;
        },
      }),
    );
    app.use('/callbacks', createCallbackRouter(deps));
    return app;
  }

  let deps: CallbackRouteDeps;
  let app: express.Express;

  beforeEach(() => {
    deps = makeCallbackDeps();
    app = createCallbackApp(deps);
  });

  it('POST /callbacks/:executionId/:stepId resolves callback', async () => {
    const body = { result: 'success', data: { amount: 100 } };
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const signature = signBody(body, timestamp);

    const res = await request(app)
      .post('/callbacks/exec-1/step-1')
      .set('x-callback-signature', signature)
      .set('x-callback-timestamp', timestamp)
      .send(body);

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);

    // Restate resolves the durable promise; the workflow handler updates context.steps
    expect(deps.restateClient.resolveCallback).toHaveBeenCalledWith('exec-1', 'step-1', body);
  });

  it('expired timestamp returns 401', async () => {
    const oldTimestamp = Math.floor((Date.now() - 600_000) / 1000).toString(); // 10 minutes ago
    const body = { data: 'late' };
    const signature = signBody(body, oldTimestamp);

    const res = await request(app)
      .post('/callbacks/exec-1/step-1')
      .set('x-callback-signature', signature)
      .set('x-callback-timestamp', oldTimestamp)
      .send(body);

    expect(res.status).toBe(401);
    expect(res.body.error).toBe('Timestamp out of tolerance');
  });

  it('step not in waiting_callback returns 409', async () => {
    deps.executionModel.findOne = vi.fn().mockResolvedValue({
      _id: 'exec-1',
      tenantId: 't1',
      projectId: 'p1',
      workflowId: 'wf-1',
      status: 'running',
      context: {
        steps: {
          'Webhook Step': {
            status: 'completed',
            stepId: 'step-1',
            callbackSecret: ENCRYPTED_SECRET,
          },
        },
      },
    });
    app = createCallbackApp(deps);

    const res = await request(app).post('/callbacks/exec-1/step-1').send({ data: 'too late' });

    expect(res.status).toBe(409);
    expect(res.body.error).toContain('not waiting for callback');
  });

  it('unknown execution returns 404', async () => {
    deps.executionModel.findOne = vi.fn().mockResolvedValue(null);
    app = createCallbackApp(deps);

    const res = await request(app).post('/callbacks/exec-unknown/step-1').send({ data: 'nope' });

    expect(res.status).toBe(404);
  });

  it('Restate unavailable returns 503', async () => {
    deps.restateClient.resolveCallback = vi.fn().mockRejectedValue(new Error('Connection refused'));
    app = createCallbackApp(deps);

    const body = { data: 'retry' };
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const signature = signBody(body, timestamp);

    const res = await request(app)
      .post('/callbacks/exec-1/step-1')
      .set('x-callback-signature', signature)
      .set('x-callback-timestamp', timestamp)
      .send(body);

    expect(res.status).toBe(503);
    expect(res.body.error).toBe('Workflow engine unavailable');
  });
});

// ---------------------------------------------------------------------------
// Suite 3: Approval Routes
// ---------------------------------------------------------------------------

describe('Approval Routes', () => {
  function makeApprovalDeps(overrides: Partial<ApprovalRouteDeps> = {}): ApprovalRouteDeps {
    return {
      executionModel: {
        findOne: vi.fn().mockResolvedValue({
          _id: 'exec-1',
          tenantId: 't1',
          projectId: 'p1',
          workflowId: 'wf-1',
          status: 'running',
          context: {
            steps: {
              'Manager Approval': {
                nodeType: 'approval',
                status: 'waiting_approval',
                stepId: 'step-1',
              },
            },
          },
        }),
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

  function createApprovalApp(deps: ApprovalRouteDeps): express.Express {
    const app = express();
    app.use(express.json());
    injectTenantContext(app);
    app.use('/api/projects/:projectId/approvals', createApprovalRouter(deps));
    return app;
  }

  let deps: ApprovalRouteDeps;
  let app: express.Express;

  beforeEach(() => {
    deps = makeApprovalDeps();
    app = createApprovalApp(deps);
  });

  it('POST approve resolves approval with correct decision', async () => {
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

  it('POST reject resolves rejection', async () => {
    const res = await request(app)
      .post('/api/projects/p1/approvals/wf-1/executions/exec-1/steps/step-1/approve')
      .send({ decision: 'reject', reason: 'Budget exceeded' });

    expect(res.status).toBe(200);
    expect(res.body.decision).toBe('reject');

    expect(deps.restateClient.resolveApproval).toHaveBeenCalledWith('exec-1', 'step-1', {
      approved: false,
      decidedBy: 'user-1',
      reason: 'Budget exceeded',
    });
  });

  it('step not in waiting_approval returns 409', async () => {
    deps.executionModel.findOne = vi.fn().mockResolvedValue({
      _id: 'exec-1',
      tenantId: 't1',
      projectId: 'p1',
      workflowId: 'wf-1',
      status: 'running',
      context: {
        steps: {
          'Manager Approval': { nodeType: 'approval', status: 'completed', stepId: 'step-1' },
        },
      },
    });
    app = createApprovalApp(deps);

    const res = await request(app)
      .post('/api/projects/p1/approvals/wf-1/executions/exec-1/steps/step-1/approve')
      .send({ decision: 'approve' });

    expect(res.status).toBe(409);
    expect(res.body.error).toContain('not waiting for approval');
  });

  it('decision forwarded to Restate (workflow handler updates context.steps)', async () => {
    const res = await request(app)
      .post('/api/projects/p1/approvals/wf-1/executions/exec-1/steps/step-1/approve')
      .send({ decision: 'approve', reason: 'LGTM' });

    expect(res.status).toBe(200);
    // Restate resolves the durable promise; the workflow handler writes the
    // approvalDecision into context.steps — no direct MongoDB write from this route.
    expect(deps.restateClient.resolveApproval).toHaveBeenCalledWith(
      'exec-1',
      'step-1',
      expect.objectContaining({
        approved: true,
        decidedBy: 'user-1',
        reason: 'LGTM',
      }),
    );
  });
});

// ---------------------------------------------------------------------------
// Suite 4: Connection Routes
// ---------------------------------------------------------------------------

describe('Connection Routes', () => {
  const sampleConnection: ConnectionRecord = {
    _id: 'conn-1',
    tenantId: 't1',
    projectId: 'p1',
    connectorName: 'slack',
    displayName: 'Slack Prod',
    scope: 'tenant',
    authProfileId: 'ap-1',
    status: 'active',
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  function makeConnDeps(overrides: Partial<ConnectionRouteDeps> = {}): ConnectionRouteDeps {
    return {
      connectionModel: {
        find: vi.fn().mockReturnValue({
          sort: vi.fn().mockReturnValue({
            lean: vi.fn().mockResolvedValue([sampleConnection]),
          }),
        }),
        findOne: vi.fn().mockReturnValue({ lean: vi.fn().mockResolvedValue(sampleConnection) }),
        create: vi.fn().mockImplementation(async (data: Record<string, unknown>) => ({
          ...sampleConnection,
          ...data,
        })),
        findOneAndUpdate: vi.fn().mockResolvedValue({ ...sampleConnection, name: 'Updated' }),
        findOneAndDelete: vi.fn().mockResolvedValue(sampleConnection),
      },
      registry: {
        has: vi.fn().mockReturnValue(true),
        get: vi.fn().mockReturnValue({
          name: 'slack',
          actions: [{ name: 'test_connection', run: vi.fn().mockResolvedValue({ ok: true }) }],
          triggers: [],
        }),
        listConnectors: vi.fn().mockReturnValue([]),
      } as any,
      authProfileResolver: {
        resolve: vi.fn().mockResolvedValue({ apiKey: 'sk-123' }),
      },
      ...overrides,
    };
  }

  function createConnApp(deps: ConnectionRouteDeps): express.Express {
    const app = express();
    app.use(express.json());
    injectTenantContext(app);
    app.use('/api/projects/:projectId/connections', createConnectionRouter(deps));
    return app;
  }

  let deps: ConnectionRouteDeps;
  let app: express.Express;

  beforeEach(() => {
    deps = makeConnDeps();
    app = createConnApp(deps);
  });

  it('POST / creates connection with authProfileId', async () => {
    const res = await request(app).post('/api/projects/p1/connections').send({
      connectorName: 'slack',
      displayName: 'New Slack',
      authProfileId: 'ap-1',
    });

    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    // ConnectionService.create upserts via findOneAndUpdate (ABLP-1015 made
    // the path idempotent against the auth-profiles bridge-row race).
    expect(deps.connectionModel.findOneAndUpdate).toHaveBeenCalledWith(
      { tenantId: 't1', projectId: 'p1', connectorName: 'slack', authProfileId: 'ap-1' },
      expect.objectContaining({
        $setOnInsert: expect.objectContaining({ scope: 'tenant', status: 'active' }),
        $set: expect.objectContaining({ displayName: 'New Slack' }),
      }),
      expect.objectContaining({ upsert: true, returnDocument: 'after' }),
    );
  });

  it('GET /:connectionId returns connection with authProfileId', async () => {
    const res = await request(app).get('/api/projects/p1/connections/conn-1');

    expect(res.status).toBe(200);
    expect(res.body.data.authProfileId).toBe('ap-1');
    expect(res.body.data.displayName).toBe('Slack Prod');
  });

  it('POST /:connectionId/test resolves auth via profile and tests', async () => {
    const res = await request(app).post('/api/projects/p1/connections/conn-1/test');

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.success).toBe(true);

    // Verify registry.get was called to find the connector's test action
    expect(deps.registry.get).toHaveBeenCalledWith(sampleConnection.connectorName);
  });

  it('PUT /:connectionId updates display name', async () => {
    const res = await request(app)
      .put('/api/projects/p1/connections/conn-1')
      .send({ displayName: 'Updated Name' });

    expect(res.status).toBe(200);

    expect(deps.connectionModel.findOneAndUpdate).toHaveBeenCalledWith(
      { _id: 'conn-1', tenantId: 't1', projectId: 'p1' },
      expect.objectContaining({
        $set: expect.objectContaining({ displayName: 'Updated Name' }),
      }),
      { returnDocument: 'after' },
    );
  });

  it('cross-tenant connection access returns 404', async () => {
    deps.connectionModel.findOne = vi
      .fn()
      .mockReturnValue({ lean: vi.fn().mockResolvedValue(null) });
    app = createConnApp(deps);

    const res = await request(app).get('/api/projects/p1/connections/conn-other-tenant');

    expect(res.status).toBe(404);
    expect(res.body.error).toBe('Connection not found');
  });
});

// ---------------------------------------------------------------------------
// Suite 5: Notification Rules Routes
// ---------------------------------------------------------------------------

describe('Notification Rules Routes', () => {
  function makeNotifDeps(overrides: Partial<NotificationRuleDeps> = {}): NotificationRuleDeps {
    return {
      workflowModel: {
        findOne: vi.fn().mockResolvedValue({
          _id: 'wf-1',
          tenantId: 't1',
          projectId: 'p1',
          notificationRules: [
            {
              _id: 'rule-1',
              name: 'On Failure',
              events: ['workflow.failed'],
              channel: { type: 'slack', connectionId: 'conn-1', target: '#alerts' },
              enabled: true,
            },
          ],
        }),
        findOneAndUpdate: vi.fn().mockResolvedValue({ _id: 'wf-1' }),
      },
      dispatcher: {
        sendTest: vi.fn().mockResolvedValue({ sent: true }),
      },
      ...overrides,
    };
  }

  function createNotifApp(deps: NotificationRuleDeps): express.Express {
    const app = express();
    app.use(express.json());
    injectTenantContext(app);
    app.use(
      '/api/projects/:projectId/workflows/:workflowId/notifications',
      createNotificationRuleRouter(deps),
    );
    return app;
  }

  let deps: NotificationRuleDeps;
  let app: express.Express;

  beforeEach(() => {
    deps = makeNotifDeps();
    app = createNotifApp(deps);
  });

  it('POST / creates rule on workflow with $push', async () => {
    const res = await request(app)
      .post('/api/projects/p1/workflows/wf-1/notifications')
      .send({
        name: 'On Complete',
        events: ['workflow.completed'],
        channel: { type: 'slack', connectionId: 'conn-1', target: '#general' },
      });

    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.data.name).toBe('On Complete');
    expect(res.body.data._id).toBeDefined();

    // Verify $push used on workflow model
    expect(deps.workflowModel.findOneAndUpdate).toHaveBeenCalledWith(
      { _id: 'wf-1', tenantId: 't1', projectId: 'p1' },
      {
        $push: {
          notificationRules: expect.objectContaining({
            name: 'On Complete',
            events: ['workflow.completed'],
            enabled: true,
          }),
        },
      },
      { new: true },
    );
  });

  it('DELETE /:ruleId removes rule with $pull', async () => {
    const res = await request(app).delete('/api/projects/p1/workflows/wf-1/notifications/rule-1');

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);

    expect(deps.workflowModel.findOneAndUpdate).toHaveBeenCalledWith(
      { _id: 'wf-1', tenantId: 't1', projectId: 'p1' },
      { $pull: { notificationRules: { _id: 'rule-1' } } },
      { new: true },
    );
  });

  it('POST /:ruleId/test dispatches test notification', async () => {
    const res = await request(app).post(
      '/api/projects/p1/workflows/wf-1/notifications/rule-1/test',
    );

    expect(res.status).toBe(200);
    expect(res.body.sent).toBe(true);

    expect(deps.dispatcher.sendTest).toHaveBeenCalledWith(
      expect.objectContaining({ _id: 'rule-1', name: 'On Failure' }),
      't1',
    );
  });

  it('POST / rejects invalid event names', async () => {
    const res = await request(app)
      .post('/api/projects/p1/workflows/wf-1/notifications')
      .send({
        name: 'Bad Events',
        events: ['invalid.event'],
        channel: { type: 'slack', connectionId: 'conn-1', target: '#alerts' },
      });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('Invalid events');
  });

  it('POST / rejects missing channel target', async () => {
    const res = await request(app)
      .post('/api/projects/p1/workflows/wf-1/notifications')
      .send({
        name: 'Bad Channel',
        events: ['workflow.started'],
        channel: { type: 'slack', connectionId: 'conn-1' },
      });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('channel.target');
  });

  it('GET / lists rules from workflow', async () => {
    const res = await request(app).get('/api/projects/p1/workflows/wf-1/notifications');

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].name).toBe('On Failure');
  });

  it('returns 404 for unknown workflow on rule creation', async () => {
    deps.workflowModel.findOneAndUpdate = vi.fn().mockResolvedValue(null);
    app = createNotifApp(deps);

    const res = await request(app)
      .post('/api/projects/p1/workflows/wf-unknown/notifications')
      .send({
        name: 'Test',
        events: ['workflow.started'],
        channel: { type: 'slack', connectionId: 'conn-1', target: '#ch' },
      });

    expect(res.status).toBe(404);
  });
});
