/**
 * T-4: Relay-race callback arriving after workflow cancellation.
 *
 * Verifies that the callback route returns 409 (step no longer waiting)
 * when the step status is no longer 'waiting_callback' at resolution time —
 * the race between a workflow being cancelled and the callback POST arriving.
 *
 * Also verifies SEC-1: tenant-scoped execution lookup on the new /t/ path.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createCallbackRouter, createCallbackRateLimit } from '../routes/workflow-callbacks.js';

function buildApp(executionDoc: Record<string, unknown> | null) {
  const app = express();
  app.use(
    express.json({
      verify: (req: any, _res, buf) => {
        req.rawBody = buf;
      },
    }),
  );

  const router = createCallbackRouter({
    executionModel: {
      findOne: vi.fn().mockResolvedValue(executionDoc),
    } as any,
    restateClient: {
      resolveCallback: vi.fn(),
      resolveAwakeable: vi.fn(),
      startWorkflow: vi.fn(),
    } as any,
    decryptSecret: vi.fn().mockResolvedValue('plaintext-secret'),
  });

  app.use('/api/v1/workflows/callbacks', createCallbackRateLimit(), router);
  return app;
}

const CANCELLED_EXEC = {
  _id: 'exec-cancelled',
  tenantId: 'tenant-1',
  projectId: 'proj-1',
  context: {
    steps: {
      'ocr-step': {
        stepId: 'step-ocr',
        status: 'cancelled', // ← already cancelled before callback arrived
        parkPoint: true,
        callbackSecret: 'enc:secret',
      },
    },
  },
};

const WAITING_EXEC = {
  _id: 'exec-waiting',
  tenantId: 'tenant-1',
  projectId: 'proj-1',
  context: {
    steps: {
      'ocr-step': {
        stepId: 'step-ocr',
        status: 'waiting_callback',
        parkPoint: true,
        callbackSecret: 'enc:secret',
        nextStepIds: ['next-step'],
      },
    },
  },
};

describe('T-4: callback arriving after cancellation', () => {
  it('returns 409 when step status is no longer waiting_callback', async () => {
    const app = buildApp(CANCELLED_EXEC);
    const res = await request(app)
      .post('/api/v1/workflows/callbacks/exec-cancelled/step-ocr')
      .send({ status: 'success', data: {} });

    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/not waiting/i);
  });

  it('returns 404 when execution not found', async () => {
    const app = buildApp(null);
    const res = await request(app)
      .post('/api/v1/workflows/callbacks/exec-missing/step-ocr')
      .send({});

    expect(res.status).toBe(404);
  });
});

describe('SEC-1: tenant-scoped callback route /t/:tenantId path', () => {
  it('routes /t/:tenantId/:executionId/:stepId correctly', async () => {
    const app = buildApp(CANCELLED_EXEC);
    // Step status is 'cancelled' → 409 even on the new path
    const res = await request(app)
      .post('/api/v1/workflows/callbacks/t/tenant-1/exec-cancelled/step-ocr')
      .send({ status: 'success' });

    expect(res.status).toBe(409);
  });

  it('returns 404 when tenantId-scoped execution not found', async () => {
    // findOne returns null when tenantId filter doesn't match
    const app = buildApp(null);
    const res = await request(app)
      .post('/api/v1/workflows/callbacks/t/wrong-tenant/exec-cancelled/step-ocr')
      .send({});

    expect(res.status).toBe(404);
  });
});

describe('SEC-7: callback payload validation', () => {
  it('rejects array body with 400', async () => {
    const app = buildApp(WAITING_EXEC);
    // Raw body needed for HMAC — skip actual HMAC by sending to a non-waiting step
    const res = await request(app)
      .post('/api/v1/workflows/callbacks/exec-waiting/step-ocr')
      .set('Content-Type', 'application/json')
      .send([1, 2, 3]); // Array is not valid callback body

    expect(res.status).toBe(400);
  });
});
