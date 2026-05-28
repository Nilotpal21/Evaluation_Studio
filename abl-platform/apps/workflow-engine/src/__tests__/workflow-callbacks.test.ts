import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import {
  buildSignatureHeaders,
  computeWebhookSignature,
} from '@agent-platform/shared-kernel/security';
import { createCallbackRouter, type CallbackRouteDeps } from '../routes/workflow-callbacks.js';

const TEST_SECRET = 'test-secret';
const ENCRYPTED_SECRET = 'encrypted-test-secret';

function signTimestampedPayload(body: unknown): Record<string, string> {
  return buildSignatureHeaders(TEST_SECRET, JSON.stringify(body));
}

function makeExecution(overrides: Record<string, unknown> = {}) {
  return {
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
        'Another Step': { status: 'completed', stepId: 'step-2' },
      },
    },
    ...overrides,
  };
}

function makeDeps(overrides: Partial<CallbackRouteDeps> = {}): CallbackRouteDeps {
  return {
    executionModel: {
      findOne: vi.fn().mockResolvedValue(makeExecution()),
    },
    restateClient: {
      resolveCallback: vi.fn().mockResolvedValue(undefined),
    },
    decryptSecret: vi.fn().mockResolvedValue(TEST_SECRET),
    ...overrides,
  };
}

/** Create an Express app that captures rawBody (mirroring production middleware) */
function createApp(deps: CallbackRouteDeps) {
  const app = express();
  app.use(
    express.json({
      verify: (_req, _res, buf) => {
        (_req as any).rawBody = buf;
      },
    }),
  );
  app.use('/api/v1/workflows/callbacks', createCallbackRouter(deps));
  return app;
}

describe('Workflow Callback Routes', () => {
  let deps: CallbackRouteDeps;
  let app: express.Express;
  const originalNodeEnv = process.env.NODE_ENV;

  beforeEach(() => {
    process.env.NODE_ENV = originalNodeEnv;
    deps = makeDeps();
    app = createApp(deps);
  });

  afterEach(() => {
    process.env.NODE_ENV = originalNodeEnv;
  });

  it('resolves callback for a waiting step', async () => {
    const body = { result: 'success', data: { orderId: '123' } };
    const headers = signTimestampedPayload(body);

    const res = await request(app)
      .post('/api/v1/workflows/callbacks/exec-1/step-1')
      .set('x-callback-signature', headers['x-webhook-signature'])
      .set('x-callback-timestamp', headers['x-webhook-timestamp'])
      .send(body);

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(deps.restateClient.resolveCallback).toHaveBeenCalledWith('exec-1', 'step-1', body);
  });

  it('accepts x-webhook-* headers for workflow-tool async_push callbacks', async () => {
    const body = { executionId: 'child-exec-1', status: 'completed', output: { ok: true } };
    const headers = signTimestampedPayload(body);

    const res = await request(app)
      .post('/api/v1/workflows/callbacks/exec-1/step-1')
      .set('x-webhook-signature', headers['x-webhook-signature'])
      .set('x-webhook-timestamp', headers['x-webhook-timestamp'])
      .send(body);

    expect(res.status).toBe(200);
    expect(deps.restateClient.resolveCallback).toHaveBeenCalledWith('exec-1', 'step-1', body);
  });

  it('returns 404 when execution not found', async () => {
    deps.executionModel.findOne = vi.fn().mockResolvedValue(null);
    app = createApp(deps);

    const res = await request(app).post('/api/v1/workflows/callbacks/nonexistent/step-1').send({});
    expect(res.status).toBe(404);
  });

  it('returns 404 when step not found', async () => {
    const res = await request(app).post('/api/v1/workflows/callbacks/exec-1/nonexistent').send({});
    expect(res.status).toBe(404);
  });

  it('returns 409 when step is not waiting for callback', async () => {
    const res = await request(app).post('/api/v1/workflows/callbacks/exec-1/step-2').send({});
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('Step is not waiting for callback');
  });

  it('returns 503 when Restate is unavailable', async () => {
    deps.restateClient.resolveCallback = vi.fn().mockRejectedValue(new Error('Connection refused'));
    app = createApp(deps);

    const body = { data: 'retry' };
    const headers = signTimestampedPayload(body);

    const res = await request(app)
      .post('/api/v1/workflows/callbacks/exec-1/step-1')
      .set('x-callback-signature', headers['x-webhook-signature'])
      .set('x-callback-timestamp', headers['x-webhook-timestamp'])
      .send(body);

    expect(res.status).toBe(503);
  });

  it('returns 401 when signature header is present but invalid', async () => {
    const body = { result: 'success' };
    // Compute a signature with the WRONG secret so the HMAC mismatches.
    const wrongHmac = computeWebhookSignature(
      'not-the-real-secret',
      JSON.stringify(body),
      Math.floor(Date.now() / 1000).toString(),
    );
    const res = await request(app)
      .post('/api/v1/workflows/callbacks/exec-1/step-1')
      .set('x-callback-signature', `sha256=${wrongHmac}`)
      .set('x-callback-timestamp', Math.floor(Date.now() / 1000).toString())
      .send(body);
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('Invalid signature');
    expect(deps.restateClient.resolveCallback).not.toHaveBeenCalled();
  });

  it('allows production callbacks from private source IPs (internal worker pods)', async () => {
    // workflow-callbacks is an internal route consumed by worker pods (search-ai, ADI poller, etc.)
    // whose source IPs are always private (Docker bridge 172.x.x.x, K8s pod 10.x.x.x).
    // rejectBlockedWebhookSource is intentionally NOT applied here — auth is HMAC only.
    process.env.NODE_ENV = 'production';
    const body = { result: 'success' };
    const headers = signTimestampedPayload(body);

    const res = await request(app)
      .post('/api/v1/workflows/callbacks/exec-1/step-1')
      .set('x-forwarded-for', '10.0.0.5')
      .set('x-callback-signature', headers['x-webhook-signature'])
      .set('x-callback-timestamp', headers['x-webhook-timestamp'])
      .send(body);

    expect(res.status).not.toBe(403);
  });

  it('returns 401 when signature is not valid hex', async () => {
    const body = { result: 'success' };
    const res = await request(app)
      .post('/api/v1/workflows/callbacks/exec-1/step-1')
      .set('x-callback-signature', 'sha256=zzznothexzzz')
      .set('x-callback-timestamp', Math.floor(Date.now() / 1000).toString())
      .send(body);
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('Invalid signature');
    expect(deps.restateClient.resolveCallback).not.toHaveBeenCalled();
  });

  it('returns 401 when x-callback-timestamp header is missing', async () => {
    const body = { result: 'success' };
    const headers = signTimestampedPayload(body);
    const res = await request(app)
      .post('/api/v1/workflows/callbacks/exec-1/step-1')
      .set('x-callback-signature', headers['x-webhook-signature'])
      // Deliberately omitted: x-callback-timestamp
      .send(body);
    expect(res.status).toBe(401);
    expect(res.body.error).toMatch(/timestamp/i);
    expect(deps.restateClient.resolveCallback).not.toHaveBeenCalled();
  });

  it('resolves callback via Restate and returns ok (step metadata updated by workflow handler)', async () => {
    const body = { result: 'done' };
    const headers = signTimestampedPayload(body);

    const res = await request(app)
      .post('/api/v1/workflows/callbacks/exec-1/step-1')
      .set('x-callback-signature', headers['x-webhook-signature'])
      .set('x-callback-timestamp', headers['x-webhook-timestamp'])
      .send(body);

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    // Restate resolves the durable promise; the workflow handler then updates context.steps
    expect(deps.restateClient.resolveCallback).toHaveBeenCalledWith('exec-1', 'step-1', body);
  });
});
