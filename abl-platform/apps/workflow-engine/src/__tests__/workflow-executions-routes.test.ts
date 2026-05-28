import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import {
  createWorkflowExecutionRouter,
  type WorkflowExecutionRouteDeps,
} from '../routes/workflow-executions.js';

// Deterministic encryption stub — matches the `cipher:<plaintext>` shape used
// by the runtime workflow-version tests. Lets assertions prove that the
// ciphertext was produced by the route's encrypt boundary and not leaked as
// plaintext through the Restate input.
const testEncryptSecret = async (plaintext: string): Promise<string> => `cipher:${plaintext}`;

function makeDeps(overrides: Partial<WorkflowExecutionRouteDeps> = {}): WorkflowExecutionRouteDeps {
  return {
    executionModel: {
      find: vi.fn().mockReturnValue({
        sort: vi.fn().mockReturnValue({
          limit: vi.fn().mockReturnValue({
            lean: vi.fn().mockResolvedValue([
              { _id: 'exec-1', status: 'completed' },
              { _id: 'exec-2', status: 'running' },
            ]),
          }),
        }),
      }),
      findOne: vi.fn().mockResolvedValue({ _id: 'exec-1', status: 'running' }),
      findOneAndUpdate: vi.fn().mockResolvedValue({ _id: 'exec-1', status: 'cancelled' }),
    },
    workflowModel: {
      findOne: vi.fn().mockResolvedValue({ _id: 'wf-1', name: 'test-flow', steps: [] }),
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
    humanTaskModel: {
      updateMany: vi.fn().mockResolvedValue(undefined),
    },
    encryptSecret: testEncryptSecret,
    ...overrides,
  };
}

function createApp(deps: WorkflowExecutionRouteDeps, opts: { withTenant?: boolean } = {}) {
  const app = express();
  app.use(express.json());
  if (opts.withTenant !== false) {
    // Inject fake tenant context
    app.use((req: any, _res, next) => {
      req.tenantContext = { tenantId: 't1', userId: 'user-1' };
      next();
    });
  }
  app.use(
    '/api/projects/:projectId/workflows/:workflowId/executions',
    createWorkflowExecutionRouter(deps),
  );
  return app;
}

describe('Workflow Execution Routes', () => {
  let deps: WorkflowExecutionRouteDeps;
  let app: express.Express;

  beforeEach(() => {
    deps = makeDeps();
    app = createApp(deps);
  });

  describe('GET /executions', () => {
    it('returns executions scoped by tenant+project+workflow', async () => {
      const res = await request(app).get('/api/projects/p1/workflows/wf-1/executions');
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data).toHaveLength(2);
      expect(deps.executionModel.find).toHaveBeenCalledWith(
        expect.objectContaining({ tenantId: 't1', projectId: 'p1', workflowId: 'wf-1' }),
      );
    });

    it('filters by status when provided', async () => {
      const res = await request(app).get(
        '/api/projects/p1/workflows/wf-1/executions?status=running',
      );
      expect(res.status).toBe(200);
      expect(deps.executionModel.find).toHaveBeenCalledWith(
        expect.objectContaining({ status: 'running' }),
      );
    });
  });

  describe('GET /executions/:executionId', () => {
    it('returns execution detail', async () => {
      const res = await request(app).get('/api/projects/p1/workflows/wf-1/executions/exec-1');
      expect(res.status).toBe(200);
      expect(res.body.data.id).toBe('exec-1');
    });

    it('returns 404 for unknown execution', async () => {
      deps.executionModel.findOne = vi.fn().mockResolvedValue(null);
      app = createApp(deps);
      const res = await request(app).get('/api/projects/p1/workflows/wf-1/executions/nonexistent');
      expect(res.status).toBe(404);
    });

    it('does not expose encryptedCallbackSecret or callbackSecret in triggerMetadata', async () => {
      deps.executionModel.findOne = vi.fn().mockResolvedValue({
        _id: 'exec-secret',
        tenantId: 't1',
        projectId: 'p1',
        workflowId: 'wf-1',
        status: 'waiting_callback',
        triggerMetadata: {
          callbackUrl: 'https://example.com/webhook',
          encryptedCallbackSecret: 'cipher:sensitive-secret',
          callbackSecret: 'plaintext-secret',
        },
      });
      app = createApp(deps);

      const res = await request(app).get('/api/projects/p1/workflows/wf-1/executions/exec-secret');
      expect(res.status).toBe(200);

      const meta = res.body.data.triggerMetadata ?? {};
      expect(meta.encryptedCallbackSecret).toBeUndefined();
      expect(meta.callbackSecret).toBeUndefined();
      // callbackUrl is safe to expose
      expect(meta.callbackUrl).toBe('https://example.com/webhook');
    });

    it('projects context.steps including start/end boundary records + mappingErrors', async () => {
      // Regression guard: context.steps is the single source of truth for all
      // step data — pin the full field set to catch future field omissions
      // before they reach the Debug panel / Raw JSON / Monitor tab.
      deps.executionModel.findOne = vi.fn().mockResolvedValue({
        _id: 'exec-boundary',
        tenantId: 't1',
        projectId: 'p1',
        workflowId: 'wf-1',
        status: 'failed',
        context: {
          steps: {
            start: {
              stepId: 'start',
              nodeType: 'start',
              status: 'completed',
              input: { email: 'a@b', amount: '100' },
              output: { email: 'a@b', amount: 100 },
              durationMs: 1,
              metrics: { processingTimeMs: 1 },
              mappingErrors: [],
            },
            end: {
              stepId: 'end',
              nodeType: 'end',
              status: 'failed',
              input: [{ name: 'total', expression: 'not-a-number', type: 'number' }],
              output: { _status: 0, total: null },
              error: { code: 'OUTPUT_MAPPING_FAILED', message: '1 of 1 output mappings failed' },
              mappingErrors: [
                {
                  name: 'total',
                  expression: 'not-a-number',
                  expected: 'number',
                  got: 'string',
                  error: 'Output mapping "total" type mismatch: expected number, got string',
                },
              ],
              durationMs: 2,
              metrics: { processingTimeMs: 2 },
            },
          },
        },
      });
      app = createApp(deps);

      const res = await request(app).get(
        '/api/projects/p1/workflows/wf-1/executions/exec-boundary',
      );
      expect(res.status).toBe(200);

      const contextSteps = res.body.data.context.steps;
      expect(Object.keys(contextSteps)).toHaveLength(2);
      // No top-level steps[] array — context.steps is the single source of truth
      expect(res.body.data.steps).toBeUndefined();
      // Start boundary record present
      expect(contextSteps.start).toEqual(
        expect.objectContaining({
          stepId: 'start',
          nodeType: 'start',
          status: 'completed',
          output: { email: 'a@b', amount: 100 },
        }),
      );
      // End boundary record present — this is the bug the user reported
      // ("end not in steps"). Keep this assertion tight.
      expect(contextSteps.end).toEqual(
        expect.objectContaining({
          stepId: 'end',
          nodeType: 'end',
          status: 'failed',
        }),
      );
      // mappingErrors projected (was silently dropped before the fix)
      expect(contextSteps.end.mappingErrors).toEqual([
        {
          name: 'total',
          expression: 'not-a-number',
          expected: 'number',
          got: 'string',
          error: 'Output mapping "total" type mismatch: expected number, got string',
        },
      ]);
    });
  });

  describe('POST /executions/execute', () => {
    it('starts a manual workflow execution', async () => {
      const res = await request(app)
        .post('/api/projects/p1/workflows/wf-1/executions/execute')
        .send({ payload: { key: 'value' } });
      expect(res.status).toBe(202);
      expect(res.body.executionId).toBeDefined();
      // Relay-race: full payload stored via createExecution; Restate gets lean input.
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

    it('uses the selected workflow version definition when workflowVersionId is provided', async () => {
      deps.workflowModel.findOne = vi.fn().mockResolvedValue({
        _id: 'wf-1',
        name: 'versioned-flow',
        steps: [{ id: 'working-copy-step', name: 'Working Copy Step' }],
        nodes: [
          {
            id: 'working-start',
            nodeType: 'start',
            name: 'Start',
          },
        ],
        edges: [],
      });
      deps.workflowVersionModel = {
        findOne: vi.fn().mockResolvedValue({
          _id: 'wfv-1',
          workflowId: 'wf-1',
          version: 'v2',
          definition: {
            nodes: [
              {
                id: 'version-start',
                nodeType: 'start',
                name: 'Start',
              },
              {
                id: 'version-end',
                nodeType: 'end',
                name: 'End',
                config: {
                  outputMappings: [
                    {
                      name: 'answer',
                      expression: '{{steps.http-1.output.body}}',
                    },
                  ],
                },
              },
            ],
            edges: [
              {
                id: 'edge-1',
                source: 'version-start',
                target: 'version-end',
              },
            ],
          },
        }),
        find: vi.fn().mockReturnValue({ lean: vi.fn().mockResolvedValue([]) }),
      };
      app = createApp(deps);

      const res = await request(app)
        .post('/api/projects/p1/workflows/wf-1/executions/execute')
        .send({ workflowVersionId: 'wfv-1' });

      expect(res.status).toBe(202);
      expect(deps.persistence.createExecution).toHaveBeenCalledWith(
        expect.objectContaining({ workflowVersionId: 'wfv-1', workflowVersion: 'v2' }),
      );
      expect(deps.restateClient.startWorkflow).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ tenantId: 't1', projectId: 'p1' }),
      );
    });

    it('strips callbackUrl from manual (JWT) requests and preserves canvas output mappings', async () => {
      deps.workflowModel.findOne = vi.fn().mockResolvedValue({
        _id: 'wf-1',
        name: 'canvas-flow',
        nodes: [
          {
            id: 'start-1',
            nodeType: 'start',
            name: 'Start',
          },
          {
            id: 'end-1',
            nodeType: 'end',
            name: 'End',
            config: {
              outputMappings: [
                {
                  name: 'result',
                  expression: '{{steps.http-1.output.body}}',
                },
              ],
            },
          },
        ],
        edges: [
          {
            id: 'edge-1',
            source: 'start-1',
            target: 'end-1',
          },
        ],
      });
      app = createApp(deps);

      const res = await request(app)
        .post('/api/projects/p1/workflows/wf-1/executions/execute')
        .send({
          // triggerType defaults to 'studio' — the JWT/studio UI path.
          triggerMetadata: {
            callbackUrl: 'https://attacker.invalid/callback',
            accessToken: 'should-also-be-stripped',
            initiatedBy: 'studio-user',
          },
        });

      expect(res.status).toBe(202);
      // callbackUrl and accessToken stripped; only safe fields forwarded.
      expect(deps.persistence.createExecution).toHaveBeenCalledWith(
        expect.objectContaining({ triggerMetadata: { initiatedBy: 'studio-user' } }),
      );
      expect(deps.restateClient.startWorkflow).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ tenantId: 't1', projectId: 'p1' }),
      );
    });

    it('preserves callbackUrl for API-key (triggerType=webhook) callers and encrypts accessToken before Restate receives it', async () => {
      // API-key callers authenticate upstream and are trusted to set a callback.
      // SSRF protection is enforced at delivery time in callback-delivery-worker.
      // The bearer token is swapped plaintext → ciphertext at this trust
      // boundary so every downstream hop carries only `encryptedAccessToken`.
      const res = await request(app)
        .post('/api/projects/p1/workflows/wf-1/executions/execute')
        .send({
          triggerType: 'webhook',
          triggerMetadata: {
            callbackUrl: 'https://caller.example.com/hook',
            accessToken: 'bearer-token-xyz',
            apiKeyId: 'key-1',
          },
        });

      expect(res.status).toBe(202);
      // Relay-race: triggerMetadata (with encrypted token) stored via createExecution.
      expect(deps.persistence.createExecution).toHaveBeenCalledWith(
        expect.objectContaining({
          triggerType: 'webhook',
          triggerMetadata: expect.objectContaining({
            callbackUrl: 'https://caller.example.com/hook',
            encryptedAccessToken: 'cipher:bearer-token-xyz',
            apiKeyId: 'key-1',
          }),
        }),
      );
      // Plaintext must not survive past the /execute boundary
      const createArgs = (deps.persistence.createExecution as ReturnType<typeof vi.fn>).mock
        .calls[0][0] as { triggerMetadata: Record<string, unknown> };
      expect(createArgs.triggerMetadata.accessToken).toBeUndefined();
    });

    it('encrypts callbackSecret before Restate receives it', async () => {
      const res = await request(app)
        .post('/api/projects/p1/workflows/wf-1/executions/execute')
        .send({
          triggerType: 'agent',
          triggerMetadata: {
            callbackUrl: 'https://caller.example.com/hook',
            callbackSecret: 'callback-secret-xyz',
          },
        });

      expect(res.status).toBe(202);
      expect(deps.persistence.createExecution).toHaveBeenCalledWith(
        expect.objectContaining({
          triggerMetadata: expect.objectContaining({
            callbackUrl: 'https://caller.example.com/hook',
            encryptedCallbackSecret: 'cipher:callback-secret-xyz',
          }),
        }),
      );
      const createArgs2 = (deps.persistence.createExecution as ReturnType<typeof vi.fn>).mock
        .calls[0][0] as { triggerMetadata: Record<string, unknown> };
      expect(createArgs2.triggerMetadata.callbackSecret).toBeUndefined();
    });

    it('preserves callbackUrl for cron-triggered (triggerType=cron) callers', async () => {
      const res = await request(app)
        .post('/api/projects/p1/workflows/wf-1/executions/execute')
        .send({
          triggerType: 'cron',
          triggerMetadata: {
            callbackUrl: 'https://caller.example.com/hook',
          },
        });

      expect(res.status).toBe(202);
      expect(deps.persistence.createExecution).toHaveBeenCalledWith(
        expect.objectContaining({
          triggerMetadata: expect.objectContaining({
            callbackUrl: 'https://caller.example.com/hook',
          }),
        }),
      );
    });

    it('returns 404 when workflow not found', async () => {
      deps.workflowModel.findOne = vi.fn().mockResolvedValue(null);
      app = createApp(deps);
      const res = await request(app)
        .post('/api/projects/p1/workflows/wf-1/executions/execute')
        .send({});
      expect(res.status).toBe(404);
    });

    it('returns 502 RESTATE_START_FAILED when restateClient.startWorkflow throws', async () => {
      deps.restateClient.startWorkflow = vi
        .fn()
        .mockRejectedValue(new Error('restate ingress unreachable'));
      app = createApp(deps);
      const res = await request(app)
        .post('/api/projects/p1/workflows/wf-1/executions/execute')
        .send({});
      expect(res.status).toBe(502);
      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe('RELAY_START_FAILED');
      expect(res.body.error.message).toContain('restate ingress unreachable');
    });

    describe('version resolution', () => {
      const versionedCanvas = {
        nodes: [
          { id: 'start-1', nodeType: 'start', name: 'Start' },
          {
            id: 'end-1',
            nodeType: 'end',
            name: 'End',
            config: {
              outputMappings: [{ name: 'result', expression: '{{trigger.payload.key}}' }],
            },
          },
        ],
        edges: [{ id: 'edge-1', source: 'start-1', target: 'end-1' }],
      };

      it('uses the pinned version canvas when workflowVersionId is provided', async () => {
        const versionFindOne = vi.fn().mockResolvedValue({
          _id: 'wv-123',
          workflowId: 'wf-1',
          version: '1.4.2',
          state: 'inactive',
          definition: versionedCanvas,
        });
        deps.workflowVersionModel = {
          findOne: versionFindOne,
          find: vi.fn().mockReturnValue({ lean: vi.fn().mockResolvedValue([]) }),
        };
        app = createApp(deps);

        const res = await request(app)
          .post('/api/projects/p1/workflows/wf-1/executions/execute')
          .send({ workflowVersionId: 'wv-123', payload: {} });

        expect(res.status).toBe(202);
        expect(versionFindOne).toHaveBeenCalledWith(
          expect.objectContaining({
            _id: 'wv-123',
            workflowId: 'wf-1',
            tenantId: 't1',
            projectId: 'p1',
            deleted: { $ne: true },
          }),
        );
        expect(deps.persistence.createExecution).toHaveBeenCalledWith(
          expect.objectContaining({ workflowVersionId: 'wv-123', workflowVersion: '1.4.2' }),
        );
        expect(deps.restateClient.startWorkflow).toHaveBeenCalledWith(
          expect.any(String),
          expect.objectContaining({ tenantId: 't1', projectId: 'p1' }),
        );
      });

      it('returns 404 WORKFLOW_VERSION_NOT_FOUND when the pinned version is missing', async () => {
        deps.workflowVersionModel = {
          findOne: vi.fn().mockResolvedValue(null),
          find: vi.fn().mockReturnValue({ lean: vi.fn().mockResolvedValue([]) }),
        };
        app = createApp(deps);

        const res = await request(app)
          .post('/api/projects/p1/workflows/wf-1/executions/execute')
          .send({ workflowVersionId: 'wv-missing' });

        expect(res.status).toBe(404);
        expect(res.body.success).toBe(false);
        expect(res.body.error.code).toBe('WORKFLOW_VERSION_NOT_FOUND');
        expect(deps.restateClient.startWorkflow).not.toHaveBeenCalled();
      });

      it('defaults to the active version when no workflowVersionId is provided', async () => {
        const activeDoc = {
          _id: 'wv-active',
          workflowId: 'wf-1',
          version: '2.0.0',
          state: 'active',
          definition: versionedCanvas,
        };
        const versionFind = vi.fn().mockReturnValue({
          lean: vi.fn().mockResolvedValue([activeDoc]),
        });
        // findOne returns null on the draft lookup so working-copy resolution
        // falls through to the canvas / default-version branch.
        deps.workflowVersionModel = {
          findOne: vi.fn().mockResolvedValue(null),
          find: versionFind,
        };
        app = createApp(deps);

        // Non-studio caller — studio always uses the working copy / draft
        // (so devs can test unpublished edits), while webhook / API-key
        // callers resolve the highest published active version. The
        // semver-desc default fires only on this branch (see route handler
        // workflow-executions.ts: `else if (triggerType !== 'studio')`).
        const res = await request(app)
          .post('/api/projects/p1/workflows/wf-1/executions/execute')
          .send({ payload: {}, triggerType: 'webhook' });

        expect(res.status).toBe(202);
        expect(versionFind).toHaveBeenCalledWith(
          expect.objectContaining({
            workflowId: 'wf-1',
            tenantId: 't1',
            projectId: 'p1',
            state: 'active',
            deleted: { $ne: true },
            version: { $ne: 'draft' },
          }),
        );
        expect(deps.persistence.createExecution).toHaveBeenCalledWith(
          expect.objectContaining({ workflowVersionId: 'wv-active', workflowVersion: '2.0.0' }),
        );
        expect(deps.restateClient.startWorkflow).toHaveBeenCalledWith(
          expect.any(String),
          expect.objectContaining({ tenantId: 't1', projectId: 'p1' }),
        );
      });

      it('falls back to the workflow draft when no active version exists', async () => {
        deps.workflowModel.findOne = vi.fn().mockResolvedValue({
          _id: 'wf-1',
          name: 'draft-flow',
          nodes: versionedCanvas.nodes,
          edges: versionedCanvas.edges,
        });
        deps.workflowVersionModel = {
          findOne: vi.fn().mockResolvedValue(null),
          find: vi.fn().mockReturnValue({ lean: vi.fn().mockResolvedValue([]) }),
        };
        app = createApp(deps);

        const res = await request(app)
          .post('/api/projects/p1/workflows/wf-1/executions/execute')
          .send({ payload: {} });

        expect(res.status).toBe(202);
        const createCall = (deps.persistence.createExecution as any).mock.calls[0][0];
        expect(createCall.workflowVersionId).toBeUndefined();
        expect(createCall.workflowVersion).toBeUndefined();
      });
    });

    describe('input validation preflight', () => {
      // The canvas start node declares inputVariables; the route must reject
      // malformed payloads with a 400 before touching Restate. This is a UX
      // optimization — the handler still re-runs validation as the canonical
      // check so webhook/cron/agent triggers that bypass this route are
      // covered by handler-side validation only.
      function makeDepsWithDeclaredInputs() {
        const d = makeDeps();
        d.workflowModel.findOne = vi.fn().mockResolvedValue({
          _id: 'wf-1',
          name: 'with-inputs',
          nodes: [
            {
              id: 'start-1',
              nodeType: 'start',
              name: 'Start',
              config: {
                inputVariables: [
                  { name: 'email', type: 'string', required: true },
                  { name: 'amount', type: 'number', required: true },
                ],
              },
            },
            { id: 'end-1', nodeType: 'end', name: 'End', config: {} },
          ],
          edges: [{ id: 'e1', source: 'start-1', target: 'end-1' }],
        });
        return d;
      }

      it('returns 400 INPUT_VALIDATION_FAILED when a required field is missing', async () => {
        const d = makeDepsWithDeclaredInputs();
        const a = createApp(d);

        const res = await request(a)
          .post('/api/projects/p1/workflows/wf-1/executions/execute')
          .send({ payload: { amount: '100' } }); // missing email

        expect(res.status).toBe(400);
        expect(res.body).toEqual({
          success: false,
          error: expect.objectContaining({
            code: 'INPUT_VALIDATION_FAILED',
            message: expect.stringContaining('1 input field'),
            fields: [{ name: 'email', reason: 'REQUIRED' }],
          }),
        });
        // Restate was NOT called — preflight short-circuited before startWorkflow
        expect(d.restateClient.startWorkflow).not.toHaveBeenCalled();
      });

      it('returns 400 with per-field TYPE_MISMATCH on coercion failure', async () => {
        const d = makeDepsWithDeclaredInputs();
        const a = createApp(d);

        const res = await request(a)
          .post('/api/projects/p1/workflows/wf-1/executions/execute')
          .send({ payload: { email: 'a@b', amount: 'not-a-number' } });

        expect(res.status).toBe(400);
        expect(res.body.error.code).toBe('INPUT_VALIDATION_FAILED');
        expect(res.body.error.fields).toEqual([
          { name: 'amount', reason: 'TYPE_MISMATCH', expected: 'number', got: 'string' },
        ]);
        expect(d.restateClient.startWorkflow).not.toHaveBeenCalled();
      });

      it('returns 202 and forwards coerced payload semantics when validation passes', async () => {
        const d = makeDepsWithDeclaredInputs();
        const a = createApp(d);

        const res = await request(a)
          .post('/api/projects/p1/workflows/wf-1/executions/execute')
          .send({ payload: { email: 'a@b', amount: '100' } });

        expect(res.status).toBe(202);
        expect(d.restateClient.startWorkflow).toHaveBeenCalledTimes(1);
        // Relay-race: payload stored in createExecution; Restate gets lean input.
        const createCallArgs = (d.persistence!.createExecution as ReturnType<typeof vi.fn>).mock
          .calls[0][0] as { triggerPayload: unknown };
        expect(createCallArgs.triggerPayload).toEqual({ email: 'a@b', amount: '100' });
      });

      it('accepts any payload when no startInputVariables are declared (pass-through)', async () => {
        // Default makeDeps returns a workflow with empty `steps` and no nodes —
        // so startInputVariables defaults to []. Any payload should pass preflight.
        const res = await request(app)
          .post('/api/projects/p1/workflows/wf-1/executions/execute')
          .send({ payload: { random: 'data' } });

        expect(res.status).toBe(202);
        expect(deps.restateClient.startWorkflow).toHaveBeenCalled();
      });
    });
  });

  describe('POST /executions/:executionId/cancel', () => {
    it('cancels a running execution', async () => {
      // inputSnapshot marks this as a relay-race execution — uses cancelWorkflow.
      deps.executionModel.findOne = vi
        .fn()
        .mockResolvedValue({ _id: 'exec-1', status: 'running', inputSnapshot: {} });
      app = createApp(deps);
      const res = await request(app).post(
        '/api/projects/p1/workflows/wf-1/executions/exec-1/cancel',
      );
      expect(res.status).toBe(200);
      expect(res.body.message).toBe('Execution cancelled');
      expect(deps.restateClient.cancelWorkflow).toHaveBeenCalledWith('exec-1', 't1', 'p1');
      expect(deps.publisher.publish).toHaveBeenCalled();
    });

    it('returns 404 for unknown execution', async () => {
      deps.executionModel.findOne = vi.fn().mockResolvedValue(null);
      app = createApp(deps);
      const res = await request(app).post(
        '/api/projects/p1/workflows/wf-1/executions/nonexistent/cancel',
      );
      expect(res.status).toBe(404);
    });

    it('returns 409 for already completed execution', async () => {
      deps.executionModel.findOne = vi
        .fn()
        .mockResolvedValue({ _id: 'exec-1', status: 'completed' });
      app = createApp(deps);
      const res = await request(app).post(
        '/api/projects/p1/workflows/wf-1/executions/exec-1/cancel',
      );
      expect(res.status).toBe(409);
    });

    it('returns 400 when tenant context is missing', async () => {
      const appNoTenant = createApp(deps, { withTenant: false });
      const res = await request(appNoTenant).post(
        '/api/projects/p1/workflows/wf-1/executions/exec-1/cancel',
      );
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('MISSING_PARAMETERS');
      expect(deps.executionModel.findOne).not.toHaveBeenCalled();
    });

    it('still cancels in DB even when restateClient.cancelWorkflow throws', async () => {
      // Restate unavailable — the user's intent to cancel must still persist.
      deps.restateClient.cancelWorkflow = vi.fn().mockRejectedValue(new Error('restate down'));
      app = createApp(deps);
      const res = await request(app).post(
        '/api/projects/p1/workflows/wf-1/executions/exec-1/cancel',
      );
      expect(res.status).toBe(200);
      expect(res.body.message).toBe('Execution cancelled');
      expect(deps.executionModel.findOneAndUpdate).toHaveBeenCalled();
      expect(deps.publisher.publish).toHaveBeenCalled();
    });

    it('cancels executions waiting for human input with project-scoped updates', async () => {
      deps.executionModel.findOne = vi
        .fn()
        .mockResolvedValue({ _id: 'exec-1', status: 'waiting_human' });
      app = createApp(deps);

      const res = await request(app).post(
        '/api/projects/p1/workflows/wf-1/executions/exec-1/cancel',
      );

      expect(res.status).toBe(200);
      expect(deps.executionModel.findOneAndUpdate).toHaveBeenCalledWith(
        expect.objectContaining({
          _id: 'exec-1',
          tenantId: 't1',
          projectId: 'p1',
        }),
        // Aggregation pipeline array: [{ $set: status/cancelledAt/completedAt }, { $set: context.steps }]
        expect.arrayContaining([
          expect.objectContaining({
            $set: expect.objectContaining({ status: 'cancelled' }),
          }),
        ]),
      );
      expect(deps.humanTaskModel?.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          'source.executionId': 'exec-1',
          tenantId: 't1',
          projectId: 'p1',
        }),
        expect.any(Object),
      );
    });
  });
});
