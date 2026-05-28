/**
 * Tests for HMAC enforcement in the callback router (H-8).
 *
 * Verifies that:
 * - When a callbackSecret is configured, requests without a signature are rejected (401)
 * - When a callbackSecret is configured, invalid signatures are rejected (401)
 * - When a callbackSecret is configured, valid signatures are accepted (200)
 * - When secret decryption fails, the request returns 503 (not silently passed)
 * - When no callbackSecret is configured, unsigned callbacks are allowed
 * - Signatures with sha256= prefix are accepted
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import crypto from 'crypto';
import { createCallbackRouter, type CallbackRouterDeps } from '../routes/callbacks.js';

function buildApp(deps: CallbackRouterDeps) {
  const app = express();
  app.use(express.json());
  app.use('/callbacks', createCallbackRouter(deps));
  return app;
}

const CALLBACK_ID = 'cb-test-123';
const SUSPENSION_ID = 'susp-test-456';
const SESSION_ID = 'sess-test-789';
const TENANT_ID = 'tenant-test';
// The callback router only invokes decryptSecret when the stored secret matches
// the DEK envelope wire format (base64 dekIdLen + dekId + iv + authTag +
// ciphertext, ≥40 bytes, printable dekId). Synthesize a DEK-shaped string so
// the route routes through decryptSecret() in test like it would in prod.
const CALLBACK_SECRET = Buffer.concat([
  Buffer.from([8]), // dekIdLen
  Buffer.from('test-dek'), // dekId (printable ASCII)
  Buffer.from('a'.repeat(12)), // iv (12 bytes)
  Buffer.from('b'.repeat(16)), // authTag (16 bytes)
  Buffer.from('encrypted-callback-secret-payload'),
]).toString('base64');
const DECRYPTED_SECRET = 'my-super-secret-key';

function makeEntry() {
  return {
    callbackId: CALLBACK_ID,
    suspensionId: SUSPENSION_ID,
    sessionId: SESSION_ID,
    tenantId: TENANT_ID,
    expiresAt: Date.now() + 60_000,
  };
}

function signBody(body: unknown, secret: string): string {
  return crypto.createHmac('sha256', secret).update(JSON.stringify(body)).digest('hex');
}

describe('Callback HMAC enforcement', () => {
  let mockDeps: CallbackRouterDeps;

  beforeEach(() => {
    mockDeps = {
      callbackRegistry: {
        claim: vi.fn().mockResolvedValue(makeEntry()),
        register: vi.fn().mockResolvedValue(undefined),
      } as any,
      suspensionStore: {
        load: vi.fn().mockResolvedValue({
          suspensionId: SUSPENSION_ID,
          sessionId: SESSION_ID,
          tenantId: TENANT_ID,
          callbackSecret: CALLBACK_SECRET,
          status: 'suspended',
          expiresAt: new Date(Date.now() + 60_000),
        }),
        loadByCallbackId: vi.fn().mockResolvedValue(null),
      } as any,
      resumptionQueue: {
        add: vi.fn().mockResolvedValue(undefined),
      },
      decryptSecret: vi.fn().mockResolvedValue(DECRYPTED_SECRET),
    };
  });

  it('rejects callback when secret is configured but signature header is missing', async () => {
    const app = buildApp(mockDeps);
    const body = { result: 'done' };

    const res = await request(app).post(`/callbacks/${CALLBACK_ID}`).send(body);

    expect(res.status).toBe(401);
    expect(res.body.success).toBe(false);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
  });

  it('rejects callback when signature is present but incorrect', async () => {
    const app = buildApp(mockDeps);
    const body = { result: 'done' };

    const res = await request(app)
      .post(`/callbacks/${CALLBACK_ID}`)
      .set(
        'x-callback-signature',
        'sha256=0000000000000000000000000000000000000000000000000000000000000000',
      )
      .send(body);

    expect(res.status).toBe(401);
    expect(res.body.success).toBe(false);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
  });

  it('accepts callback when signature is valid HMAC-SHA256', async () => {
    const app = buildApp(mockDeps);
    const body = { result: 'done' };
    const sig = signBody(body, DECRYPTED_SECRET);

    const res = await request(app)
      .post(`/callbacks/${CALLBACK_ID}`)
      .set('x-callback-signature', `sha256=${sig}`)
      .send(body);

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it('returns 503 when secret decryption fails (DB error)', async () => {
    (mockDeps.decryptSecret as any).mockRejectedValue(new Error('Decryption service unavailable'));
    const app = buildApp(mockDeps);
    const body = { result: 'done' };

    const res = await request(app)
      .post(`/callbacks/${CALLBACK_ID}`)
      .set('x-callback-signature', 'sha256=abc123')
      .send(body);

    expect(res.status).toBe(503);
    expect(res.body.success).toBe(false);
    expect(res.body.error.code).toBe('SERVICE_UNAVAILABLE');
  });

  it('allows callback when no secret is configured (unsigned callbacks)', async () => {
    (mockDeps.suspensionStore.load as any).mockResolvedValue({
      suspensionId: SUSPENSION_ID,
      sessionId: SESSION_ID,
      tenantId: TENANT_ID,
      callbackSecret: null, // no secret configured
      status: 'suspended',
      expiresAt: new Date(Date.now() + 60_000),
    });

    const app = buildApp(mockDeps);
    const body = { result: 'done' };

    const res = await request(app).post(`/callbacks/${CALLBACK_ID}`).send(body);

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it('accepts signature with sha256= prefix format', async () => {
    const app = buildApp(mockDeps);
    const body = { result: 'done' };
    const sig = signBody(body, DECRYPTED_SECRET);

    const res = await request(app)
      .post(`/callbacks/${CALLBACK_ID}`)
      .set('x-callback-signature', `sha256=${sig}`)
      .send(body);

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it('accepts signature without sha256= prefix', async () => {
    const app = buildApp(mockDeps);
    const body = { result: 'done' };
    const sig = signBody(body, DECRYPTED_SECRET);

    const res = await request(app)
      .post(`/callbacks/${CALLBACK_ID}`)
      .set('x-callback-signature', sig)
      .send(body);

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });
});
