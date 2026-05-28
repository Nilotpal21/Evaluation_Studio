/**
 * System Tests: POST /callbacks/:executionId/:stepId against real MongoDB.
 *
 * Closes GAP-B — the async webhook callback endpoint is the primary
 * external integration surface for async workflow resumption, yet had
 * no HTTP E2E. Handler-level unit tests mock `executionModel`, so they
 * can't catch raw-body capture, positional $-operator updates, or
 * tenant-scoped step queries against a real Mongoose document.
 *
 * This suite exercises the callback router end-to-end with supertest
 * against a real `WorkflowExecution` model backed by MongoMemoryServer.
 * Only the Restate client and the decrypt function are stubbed — the
 * route handler, HMAC verification, replay-protection window, raw-body
 * capture, and the positional update all run for real.
 */

import crypto from 'crypto';
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import express, { type Request, type Response, type NextFunction } from 'express';
import request from 'supertest';
import {
  setupTestMongo,
  teardownTestMongo,
  clearCollections,
  requireMongo,
} from './helpers/setup-mongo.js';
import { WorkflowExecution } from '@agent-platform/database/models';
import { createCallbackRouter } from '../routes/workflow-callbacks.js';
import { CALLBACK_REPLAY_TOLERANCE_MS } from '../constants.js';

const TENANT_ID = 't-cb-1';
const PROJECT_ID = 'p-cb-1';
const WORKFLOW_ID = 'wf-cb-1';
const STEP_ID = 'step-webhook-1';
// In production `callbackSecret` is encrypted; the test uses a plain value
// and a passthrough decrypt stub so the hmac check runs for real against
// the same value.
const CALLBACK_SECRET = 'shared-test-secret';

interface ResolveCallbackCall {
  executionId: string;
  stepId: string;
  payload: unknown;
}

function makeRestateStub(throwOnResolve = false): {
  client: { resolveCallback: (e: string, s: string, p: unknown) => Promise<void> };
  calls: ResolveCallbackCall[];
} {
  const calls: ResolveCallbackCall[] = [];
  return {
    client: {
      resolveCallback: async (executionId, stepId, payload) => {
        if (throwOnResolve) throw new Error('restate ingress unreachable');
        calls.push({ executionId, stepId, payload });
      },
    },
    calls,
  };
}

function buildApp(restateClient: ReturnType<typeof makeRestateStub>['client']): express.Express {
  const app = express();
  // Raw-body capture — callback HMAC check reads (req as any).rawBody.
  // Mirror workflow-engine/src/index.ts's body parser.
  const captureRawBody = (req: Request, _res: Response, buf: Buffer): void => {
    (req as unknown as { rawBody: Buffer }).rawBody = buf;
  };
  app.use(express.json({ limit: '1mb', verify: captureRawBody }));
  app.use(
    '/api/v1/workflows/callbacks',
    createCallbackRouter({
      executionModel: WorkflowExecution as any,
      restateClient,
      // Passthrough decrypt — the seeded callbackSecret is stored plain in
      // the test, so HMAC is computed against the same value the route reads.
      decryptSecret: async (ciphertext: string, _tenantId: string) => ciphertext,
    }),
  );
  // Fallback JSON error handler for any route-handler throws
  app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
    res.status(500).json({ error: err.message });
  });
  return app;
}

async function seedExecution(overrides?: {
  stepStatus?: string;
  /** When true, the step is seeded WITHOUT a callbackSecret. Default: secret set. */
  omitCallbackSecret?: boolean;
}): Promise<string> {
  const executionId = crypto.randomUUID();
  const stepDoc: Record<string, unknown> = {
    nodeId: STEP_ID,
    nodeType: 'async_webhook',
    nodeName: 'Webhook',
    status: overrides?.stepStatus ?? 'waiting_callback',
  };
  if (!overrides?.omitCallbackSecret) {
    stepDoc.callbackSecret = CALLBACK_SECRET;
  }
  await WorkflowExecution.create({
    _id: executionId,
    tenantId: TENANT_ID,
    projectId: PROJECT_ID,
    workflowId: WORKFLOW_ID,
    status: 'running',
    triggerType: 'webhook',
    triggerPayload: {},
    nodeExecutions: [stepDoc],
    startedAt: new Date(),
  });
  return executionId;
}

function signBody(body: unknown, secret = CALLBACK_SECRET): string {
  const raw = JSON.stringify(body);
  return crypto.createHmac('sha256', secret).update(raw).digest('hex');
}

beforeAll(async () => {
  await setupTestMongo();
}, 60_000);

afterEach(async () => {
  await clearCollections();
  vi.restoreAllMocks();
});

afterAll(async () => {
  await teardownTestMongo();
});

describe('POST /callbacks/:executionId/:stepId — real MongoDB', () => {
  it('happy path: valid signature + timestamp → 200, resolves Restate, records payload on step', async ({
    skip,
  }) => {
    requireMongo(skip);
    const { client, calls } = makeRestateStub();
    const app = buildApp(client);
    const executionId = await seedExecution();

    const body = { result: 'ok', orderId: 'ord-123' };
    const signature = signBody(body);
    const timestamp = new Date().toISOString();

    const res = await request(app)
      .post(`/api/v1/workflows/callbacks/${executionId}/${STEP_ID}`)
      .set('x-callback-signature', `sha256=${signature}`)
      .set('x-callback-timestamp', timestamp)
      .send(body);

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0].executionId).toBe(executionId);
    expect(calls[0].stepId).toBe(STEP_ID);
    expect(calls[0].payload).toEqual(body);

    // Verify the positional update persisted callback data on the step.
    const doc = await WorkflowExecution.findOne({ _id: executionId }).lean();
    const step = doc!.nodeExecutions.find((s: any) => s.nodeId === STEP_ID);
    expect(step.callbackReceivedAt).toBeInstanceOf(Date);
    expect(step.callbackPayload).toEqual(body);
  });

  it('unknown executionId → 404 Not found', async ({ skip }) => {
    requireMongo(skip);
    const { client, calls } = makeRestateStub();
    const app = buildApp(client);
    // No execution seeded.

    const res = await request(app)
      .post(`/api/v1/workflows/callbacks/${crypto.randomUUID()}/${STEP_ID}`)
      .set('x-callback-signature', 'sha256=deadbeef')
      .set('x-callback-timestamp', new Date().toISOString())
      .send({});

    expect(res.status).toBe(404);
    expect(calls).toHaveLength(0);
  });

  it('unknown stepId on existing execution → 404', async ({ skip }) => {
    requireMongo(skip);
    const { client, calls } = makeRestateStub();
    const app = buildApp(client);
    const executionId = await seedExecution();

    const res = await request(app)
      .post(`/api/v1/workflows/callbacks/${executionId}/step-does-not-exist`)
      .set('x-callback-signature', 'sha256=deadbeef')
      .set('x-callback-timestamp', new Date().toISOString())
      .send({});

    expect(res.status).toBe(404);
    expect(calls).toHaveLength(0);
  });

  it('step not in waiting_callback status → 409 with the current status in error', async ({
    skip,
  }) => {
    requireMongo(skip);
    const { client, calls } = makeRestateStub();
    const app = buildApp(client);
    const executionId = await seedExecution({ stepStatus: 'completed' });

    const body = { any: 'thing' };
    const res = await request(app)
      .post(`/api/v1/workflows/callbacks/${executionId}/${STEP_ID}`)
      .set('x-callback-signature', `sha256=${signBody(body)}`)
      .set('x-callback-timestamp', new Date().toISOString())
      .send(body);

    expect(res.status).toBe(409);
    expect(String(res.body.error)).toContain("'completed'");
    expect(calls).toHaveLength(0);
  });

  it('step has no callbackSecret → 401 authentication not configured (never trust an unconfigured callback)', async ({
    skip,
  }) => {
    requireMongo(skip);
    const { client, calls } = makeRestateStub();
    const app = buildApp(client);
    const executionId = await seedExecution({ omitCallbackSecret: true });

    const res = await request(app)
      .post(`/api/v1/workflows/callbacks/${executionId}/${STEP_ID}`)
      .set('x-callback-signature', 'sha256=deadbeef')
      .set('x-callback-timestamp', new Date().toISOString())
      .send({});

    expect(res.status).toBe(401);
    expect(String(res.body.error)).toContain('authentication');
    expect(calls).toHaveLength(0);
  });

  it('missing x-callback-signature → 401', async ({ skip }) => {
    requireMongo(skip);
    const { client, calls } = makeRestateStub();
    const app = buildApp(client);
    const executionId = await seedExecution();

    const res = await request(app)
      .post(`/api/v1/workflows/callbacks/${executionId}/${STEP_ID}`)
      .set('x-callback-timestamp', new Date().toISOString())
      .send({});

    expect(res.status).toBe(401);
    expect(calls).toHaveLength(0);
  });

  it('invalid signature → 401 (HMAC mismatch rejected)', async ({ skip }) => {
    requireMongo(skip);
    const { client, calls } = makeRestateStub();
    const app = buildApp(client);
    const executionId = await seedExecution();

    const body = { result: 'ok' };
    const wrongSignature = signBody(body, 'wrong-secret');

    const res = await request(app)
      .post(`/api/v1/workflows/callbacks/${executionId}/${STEP_ID}`)
      .set('x-callback-signature', `sha256=${wrongSignature}`)
      .set('x-callback-timestamp', new Date().toISOString())
      .send(body);

    expect(res.status).toBe(401);
    expect(calls).toHaveLength(0);
  });

  it('malformed signature hex → 401', async ({ skip }) => {
    requireMongo(skip);
    const { client, calls } = makeRestateStub();
    const app = buildApp(client);
    const executionId = await seedExecution();

    const res = await request(app)
      .post(`/api/v1/workflows/callbacks/${executionId}/${STEP_ID}`)
      .set('x-callback-signature', 'sha256=ZZZ-not-hex-at-all')
      .set('x-callback-timestamp', new Date().toISOString())
      .send({ result: 'ok' });

    expect(res.status).toBe(401);
    expect(calls).toHaveLength(0);
  });

  it('missing x-callback-timestamp → 401', async ({ skip }) => {
    requireMongo(skip);
    const { client, calls } = makeRestateStub();
    const app = buildApp(client);
    const executionId = await seedExecution();

    const body = { result: 'ok' };
    const res = await request(app)
      .post(`/api/v1/workflows/callbacks/${executionId}/${STEP_ID}`)
      .set('x-callback-signature', `sha256=${signBody(body)}`)
      .send(body);

    expect(res.status).toBe(401);
    expect(String(res.body.error)).toContain('timestamp');
    expect(calls).toHaveLength(0);
  });

  it('replay: timestamp older than CALLBACK_REPLAY_TOLERANCE_MS → 401', async ({ skip }) => {
    requireMongo(skip);
    const { client, calls } = makeRestateStub();
    const app = buildApp(client);
    const executionId = await seedExecution();

    const body = { result: 'ok' };
    const staleTimestamp = new Date(
      Date.now() - CALLBACK_REPLAY_TOLERANCE_MS - 10_000,
    ).toISOString();

    const res = await request(app)
      .post(`/api/v1/workflows/callbacks/${executionId}/${STEP_ID}`)
      .set('x-callback-signature', `sha256=${signBody(body)}`)
      .set('x-callback-timestamp', staleTimestamp)
      .send(body);

    expect(res.status).toBe(401);
    expect(String(res.body.error)).toContain('Replay');
    expect(calls).toHaveLength(0);
  });

  it('Restate resolveCallback throws → 503 Workflow engine unavailable', async ({ skip }) => {
    requireMongo(skip);
    const { client } = makeRestateStub(/* throwOnResolve */ true);
    const app = buildApp(client);
    const executionId = await seedExecution();

    const body = { result: 'ok' };
    const res = await request(app)
      .post(`/api/v1/workflows/callbacks/${executionId}/${STEP_ID}`)
      .set('x-callback-signature', `sha256=${signBody(body)}`)
      .set('x-callback-timestamp', new Date().toISOString())
      .send(body);

    expect(res.status).toBe(503);
    // Step must NOT be marked received when Restate resolution failed.
    const doc = await WorkflowExecution.findOne({ _id: executionId }).lean();
    const step = doc!.nodeExecutions.find((s: any) => s.nodeId === STEP_ID);
    expect(step.callbackReceivedAt).toBeUndefined();
  });
});
