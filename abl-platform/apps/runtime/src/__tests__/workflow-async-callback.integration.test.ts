/**
 * Integration tests for the workflow async callback endpoint.
 *
 * Tests the full POST /api/internal/workflow-callback flow:
 * HMAC verification → Zod validation → Redis persist → session inject → WS broadcast.
 *
 * Uses supertest + express with a real WorkflowCallbackHandler (real Zod validation,
 * real HMAC verification via shared-kernel). Redis and message store are injected stubs.
 *
 * No mocks of platform components.
 */

import { describe, it, expect, vi, beforeAll } from 'vitest';
import express from 'express';
import request from 'supertest';
import { buildSignatureHeaders } from '@agent-platform/shared-kernel/security';
import { WorkflowCallbackHandler } from '../services/workflow/workflow-callback-handler.js';
import { createInternalCallbacksRouter } from '../routes/internal-callbacks.js';
import type { WorkflowCallbackHandlerConfig } from '../services/workflow/workflow-callback-handler.js';

const TEST_SECRET = 'test-internal-callback-secret-32chars!!';

// ─── Stubs ───────────────────────────────────────────────────────────────────

function createRedisStub() {
  return { set: vi.fn().mockResolvedValue('OK') as ReturnType<typeof vi.fn> };
}

function createMessageStoreStub() {
  return { addMessage: vi.fn().mockResolvedValue({ id: 'msg-1' }) };
}

function createWsManagerStub() {
  return { broadcastToSession: vi.fn().mockReturnValue(0) };
}

function validPayload() {
  return {
    executionId: 'exec-int-1',
    tenantId: 'tenant-1',
    projectId: 'proj-1',
    sessionId: 'session-1',
    workflowId: 'wf-1',
    workflowName: 'Integration Workflow',
    status: 'completed',
    output: { result: 42 },
    source: 'agent_tool' as const,
  };
}

// ─── App Factory ─────────────────────────────────────────────────────────────

function createTestApp(overrides: Partial<WorkflowCallbackHandlerConfig> = {}) {
  const redis = createRedisStub();
  const messageStore = createMessageStoreStub();
  const internalWs = createWsManagerStub();
  const sdkWs = createWsManagerStub();

  const handler = new WorkflowCallbackHandler({
    redis,
    messageStore,
    internalWsManager: internalWs as unknown as WorkflowCallbackHandlerConfig['internalWsManager'],
    sdkWsManager: sdkWs as unknown as WorkflowCallbackHandlerConfig['sdkWsManager'],
    internalSecret: TEST_SECRET,
    ...overrides,
  });

  const app = express();
  // Capture raw body for HMAC verification (mirrors production server.ts)
  app.use(
    express.json({
      verify: (req, _res, buf) => {
        (req as { rawBody?: Buffer }).rawBody = buf;
      },
    }),
  );
  app.use('/api/internal/workflow-callback', createInternalCallbacksRouter(handler));

  return { app, redis, messageStore, internalWs, sdkWs };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('POST /api/internal/workflow-callback', () => {
  // ── HMAC Verification ──

  it('returns 401 when HMAC headers are missing', async () => {
    const { app } = createTestApp();
    const res = await request(app).post('/api/internal/workflow-callback').send(validPayload());

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('HMAC_VERIFICATION_FAILED');
    expect(res.body.error.message).toContain('Missing signature');
  });

  it('returns 401 when HMAC signature is invalid', async () => {
    const { app } = createTestApp();
    const body = JSON.stringify(validPayload());
    const res = await request(app)
      .post('/api/internal/workflow-callback')
      .set('Content-Type', 'application/json')
      .set('x-webhook-signature', 'deadbeef')
      .set('x-webhook-timestamp', String(Math.floor(Date.now() / 1000)))
      .send(body);

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('HMAC_VERIFICATION_FAILED');
  });

  it('returns 401 when timestamp is stale (replay protection)', async () => {
    const { app } = createTestApp();
    const body = JSON.stringify(validPayload());
    const staleTimestamp = String(Math.floor(Date.now() / 1000) - 600); // 10 min ago
    const headers = buildSignatureHeaders(TEST_SECRET, body);
    // Override timestamp with stale one
    headers['x-webhook-timestamp'] = staleTimestamp;

    const res = await request(app)
      .post('/api/internal/workflow-callback')
      .set('Content-Type', 'application/json')
      .set('x-webhook-signature', headers['x-webhook-signature'])
      .set('x-webhook-timestamp', staleTimestamp)
      .send(body);

    expect(res.status).toBe(401);
  });

  // ── Payload Validation ──

  it('returns 400 for payload missing required fields', async () => {
    const { app } = createTestApp();
    const body = JSON.stringify({ executionId: 'exec-1' });
    const headers = buildSignatureHeaders(TEST_SECRET, body);

    const res = await request(app)
      .post('/api/internal/workflow-callback')
      .set('Content-Type', 'application/json')
      .set('x-webhook-signature', headers['x-webhook-signature'])
      .set('x-webhook-timestamp', headers['x-webhook-timestamp'])
      .send(body);

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('returns 400 for payload with wrong source', async () => {
    const { app } = createTestApp();
    const payload = { ...validPayload(), source: 'webhook' };
    const body = JSON.stringify(payload);
    const headers = buildSignatureHeaders(TEST_SECRET, body);

    const res = await request(app)
      .post('/api/internal/workflow-callback')
      .set('Content-Type', 'application/json')
      .set('x-webhook-signature', headers['x-webhook-signature'])
      .set('x-webhook-timestamp', headers['x-webhook-timestamp'])
      .send(body);

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  // ── Success Path ──

  it('returns 200 and processes valid callback', async () => {
    const { app, redis, messageStore, internalWs, sdkWs } = createTestApp();
    const body = JSON.stringify(validPayload());
    const headers = buildSignatureHeaders(TEST_SECRET, body);

    const res = await request(app)
      .post('/api/internal/workflow-callback')
      .set('Content-Type', 'application/json')
      .set('x-webhook-signature', headers['x-webhook-signature'])
      .set('x-webhook-timestamp', headers['x-webhook-timestamp'])
      .send(body);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.injected).toBe(true);

    // Verify Redis persistence
    expect(redis.set).toHaveBeenCalledTimes(1);
    const [key] = redis.set.mock.calls[0];
    expect(key).toBe('workflow:tenant-1:proj-1:async-result:exec-int-1');

    // Verify session message injection
    expect(messageStore.addMessage).toHaveBeenCalledTimes(1);
    const msgParams = messageStore.addMessage.mock.calls[0][0];
    expect(msgParams.sessionId).toBe('session-1');
    expect(msgParams.role).toBe('system');
    expect(msgParams.content).toContain('[Workflow Complete]');

    // Verify WS broadcast (includes tenantId for GAP-006 tenant filtering)
    expect(internalWs.broadcastToSession).toHaveBeenCalledWith(
      'session-1',
      'workflow.result',
      expect.objectContaining({ executionId: 'exec-int-1' }),
      'tenant-1',
    );
    expect(sdkWs.broadcastToSession).toHaveBeenCalledWith(
      'session-1',
      'workflow.result',
      expect.objectContaining({ executionId: 'exec-int-1' }),
      'tenant-1',
    );
  });

  it('returns 200 with injected=false when session is inactive', async () => {
    const messageStore = {
      addMessage: vi.fn().mockRejectedValue(new Error('Session not found')),
    };
    const { app } = createTestApp({ messageStore });
    const body = JSON.stringify(validPayload());
    const headers = buildSignatureHeaders(TEST_SECRET, body);

    const res = await request(app)
      .post('/api/internal/workflow-callback')
      .set('Content-Type', 'application/json')
      .set('x-webhook-signature', headers['x-webhook-signature'])
      .set('x-webhook-timestamp', headers['x-webhook-timestamp'])
      .send(body);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.injected).toBe(false);
  });

  // ── Failed Workflow ──

  it('processes failed workflow callback correctly', async () => {
    const { app, messageStore } = createTestApp();
    const payload = {
      ...validPayload(),
      status: 'failed',
      output: undefined,
      error: { code: 'STEP_TIMEOUT', message: 'HTTP step timed out' },
    };
    const body = JSON.stringify(payload);
    const headers = buildSignatureHeaders(TEST_SECRET, body);

    const res = await request(app)
      .post('/api/internal/workflow-callback')
      .set('Content-Type', 'application/json')
      .set('x-webhook-signature', headers['x-webhook-signature'])
      .set('x-webhook-timestamp', headers['x-webhook-timestamp'])
      .send(body);

    expect(res.status).toBe(200);
    const msgContent = messageStore.addMessage.mock.calls[0][0].content;
    expect(msgContent).toContain('[Workflow Failed]');
    expect(msgContent).toContain('STEP_TIMEOUT');
  });

  // ── Idempotency Dedup (GAP-005) ──

  it('returns success but skips injection on duplicate callback', async () => {
    const redis = { set: vi.fn().mockResolvedValue('OK') as ReturnType<typeof vi.fn> };
    const messageStore = createMessageStoreStub();
    const { app } = createTestApp({ redis, messageStore });

    const body = JSON.stringify(validPayload());
    const headers = buildSignatureHeaders(TEST_SECRET, body);

    // First callback succeeds
    const res1 = await request(app)
      .post('/api/internal/workflow-callback')
      .set('Content-Type', 'application/json')
      .set('x-webhook-signature', headers['x-webhook-signature'])
      .set('x-webhook-timestamp', headers['x-webhook-timestamp'])
      .send(body);

    expect(res1.status).toBe(200);
    expect(res1.body.injected).toBe(true);

    // Simulate SETNX returning null for duplicate
    redis.set.mockResolvedValue(null);

    // Re-sign because timestamp may differ
    const body2 = JSON.stringify(validPayload());
    const headers2 = buildSignatureHeaders(TEST_SECRET, body2);

    const res2 = await request(app)
      .post('/api/internal/workflow-callback')
      .set('Content-Type', 'application/json')
      .set('x-webhook-signature', headers2['x-webhook-signature'])
      .set('x-webhook-timestamp', headers2['x-webhook-timestamp'])
      .send(body2);

    expect(res2.status).toBe(200);
    expect(res2.body.success).toBe(true);
    expect(res2.body.injected).toBe(false);
    // Message store should only have been called once (first callback)
    expect(messageStore.addMessage).toHaveBeenCalledTimes(1);
  });
});
