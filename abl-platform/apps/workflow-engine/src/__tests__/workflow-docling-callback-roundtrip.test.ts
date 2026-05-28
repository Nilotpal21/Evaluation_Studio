/**
 * Workflow-docling callback round-trip — HMAC mandatory + replay-window
 * (LLD Phase 1 Task 1.7 + Exit Criterion).
 *
 * Mounts the real `createCallbackRouter` against a stubbed
 * `executionModel` / `restateClient` / `decryptSecret`, then drives it with
 * HTTP requests carrying the platform-standard `x-webhook-*` headers the
 * search-ai callback poster emits. Verifies:
 *
 *   - Happy path: valid HMAC + step.status === 'waiting_callback' → 200
 *   - Missing signature header → 401
 *   - Wrong signature value → 401
 *   - Wrong step status → 409 (late callback after engine timeout — the
 *     Round 7 race the Phase 1 LLD calls out explicitly)
 *   - Unknown execution → 404 (no information leak about which step exists)
 *
 * No `vi.mock` of platform packages — the route's dependencies are injected
 * via `createCallbackRouter(deps)` (CLAUDE.md test-architecture rules).
 */

import { afterAll, beforeAll, beforeEach as vBeforeEach, describe, expect, it } from 'vitest';
import express from 'express';
import type { Request, Response, NextFunction } from 'express';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { buildSignatureHeaders } from '@agent-platform/shared-kernel/security';
import { createCallbackRouter } from '../routes/workflow-callbacks.js';

type StepEntry = {
  status: string;
  stepId: string;
  callbackSecret?: string;
};

interface FakeExecution {
  _id: string;
  tenantId: string;
  context: { steps: Record<string, StepEntry> };
}

// Mutable test state, replaced per test
let executions: Map<string, FakeExecution> = new Map();
let resolveCallbackCalls: Array<{ executionId: string; stepId: string; payload: unknown }> = [];

const executionModel = {
  findOne: (filter: Record<string, unknown>): Promise<FakeExecution | null> => {
    const id = filter._id as string;
    return Promise.resolve(executions.get(id) ?? null);
  },
} as unknown as Parameters<typeof createCallbackRouter>[0]['executionModel'];

const restateClient = {
  resolveCallback: async (executionId: string, stepId: string, payload: unknown) => {
    resolveCallbackCalls.push({ executionId, stepId, payload });
  },
} as unknown as Parameters<typeof createCallbackRouter>[0]['restateClient'];

const decryptSecret = async (encrypted: string, _tenantId: string): Promise<string> => {
  // Test stub: ciphertext is a prefix-wrapped passthrough — the production
  // decryptor goes through the tenant-encryption-facade. Here we just strip
  // the prefix to recover the plaintext deposited at setup time.
  if (!encrypted.startsWith('enc::')) throw new Error('Bad ciphertext shape');
  return encrypted.slice('enc::'.length);
};

let server: http.Server;
let baseUrl: string;

beforeAll(async () => {
  const app = express();

  // Capture raw body BEFORE express.json — the route reads `req.rawBody` for
  // HMAC verification (matches workflow-callbacks.ts's expectation).
  app.use((req: Request, _res: Response, next: NextFunction) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const raw = Buffer.concat(chunks);
      (req as unknown as { rawBody: Buffer }).rawBody = raw;
      try {
        req.body = raw.length > 0 ? JSON.parse(raw.toString('utf8')) : {};
      } catch {
        req.body = {};
      }
      next();
    });
  });

  app.use(
    '/api/v1/workflows/callbacks',
    createCallbackRouter({ executionModel, restateClient, decryptSecret }),
  );

  server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const addr = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((err) => (err ? reject(err) : resolve())),
  );
});

vBeforeEach(() => {
  executions = new Map();
  resolveCallbackCalls = [];
});

function seedExecution(
  executionId: string,
  stepId: string,
  status: string,
  plaintextSecret: string,
): void {
  executions.set(executionId, {
    _id: executionId,
    tenantId: 't-test',
    context: {
      steps: {
        [stepId]: {
          stepId,
          status,
          callbackSecret: `enc::${plaintextSecret}`,
        },
      },
    },
  });
}

async function postCallback(
  executionId: string,
  stepId: string,
  body: unknown,
  headers: Record<string, string>,
): Promise<{ status: number; bodyText: string }> {
  const url = `${baseUrl}/api/v1/workflows/callbacks/${executionId}/${stepId}`;
  const bodyText = typeof body === 'string' ? body : JSON.stringify(body);
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: bodyText,
  });
  return { status: response.status, bodyText: await response.text() };
}

describe('workflow-callbacks route — HMAC + status semantics', () => {
  it('accepts a properly-signed callback when step is waiting_callback (200)', async () => {
    const secret = 'whsec_correct_secret';
    seedExecution('exec-200', 'step-extract', 'waiting_callback', secret);

    const body = JSON.stringify({ status: 'success', envelope: { schemaVersion: 1 } });
    const headers = buildSignatureHeaders(secret, body);

    const resp = await postCallback('exec-200', 'step-extract', body, headers);
    expect(resp.status).toBe(200);
    expect(resolveCallbackCalls).toHaveLength(1);
    expect(resolveCallbackCalls[0]?.stepId).toBe('step-extract');
  });

  it('rejects callback with missing signature header (401)', async () => {
    seedExecution('exec-missing-sig', 'step-extract', 'waiting_callback', 'whsec_x');

    const resp = await postCallback(
      'exec-missing-sig',
      'step-extract',
      { status: 'success' },
      {}, // no signature
    );
    expect(resp.status).toBe(401);
    expect(resolveCallbackCalls).toHaveLength(0);
  });

  it('rejects callback with wrong signature value (401)', async () => {
    seedExecution('exec-bad-sig', 'step-extract', 'waiting_callback', 'whsec_correct');

    const body = '{"status":"success"}';
    // Sign with the WRONG secret
    const headers = buildSignatureHeaders('whsec_DIFFERENT', body);

    const resp = await postCallback('exec-bad-sig', 'step-extract', body, headers);
    expect(resp.status).toBe(401);
    expect(resolveCallbackCalls).toHaveLength(0);
  });

  it('rejects late callback after engine timeout — step no longer waiting (409)', async () => {
    // Engine already timed out and marked the step `failed` — worker callback
    // arrives late. The Round 7 race: route must respond 409, not crash, not
    // resolve the (already-resolved) Restate promise.
    seedExecution('exec-late', 'step-extract', 'failed', 'whsec_late_test');

    const body = '{"status":"success","envelope":{}}';
    const headers = buildSignatureHeaders('whsec_late_test', body);

    const resp = await postCallback('exec-late', 'step-extract', body, headers);
    expect(resp.status).toBe(409);
    expect(resolveCallbackCalls).toHaveLength(0);
  });

  it('returns 404 for unknown execution (no information leak)', async () => {
    // Do NOT seed — execution id is unknown.
    const body = '{"status":"success"}';
    const headers = buildSignatureHeaders('whsec_x', body);

    const resp = await postCallback('exec-nope', 'step-extract', body, headers);
    expect(resp.status).toBe(404);
    expect(resolveCallbackCalls).toHaveLength(0);
  });

  it('rejects callback with stale timestamp outside replay window (401)', async () => {
    const secret = 'whsec_stale_test';
    seedExecution('exec-stale', 'step-extract', 'waiting_callback', secret);

    const body = '{"status":"success","envelope":{"schemaVersion":1}}';

    // Compute a signature with a timestamp 10 minutes in the past — beyond
    // the default `CALLBACK_REPLAY_TOLERANCE_MS` (300s) the route enforces.
    // We sign the stale timestamp correctly so the only thing that should
    // fail is the replay-window check.
    const staleTs = String(Math.floor(Date.now() / 1000) - 600);
    const { createHmac } = await import('node:crypto');
    const rawSecret = secret.startsWith('whsec_') ? secret.slice('whsec_'.length) : secret;
    const signedContent = `${staleTs}.${body}`;
    const signature = createHmac('sha256', rawSecret).update(signedContent, 'utf8').digest('hex');

    const headers = {
      'x-webhook-signature': signature,
      'x-webhook-timestamp': staleTs,
      'x-webhook-id': 'test-replay-id',
    };

    const resp = await postCallback('exec-stale', 'step-extract', body, headers);
    expect(resp.status).toBe(401);
    expect(resolveCallbackCalls).toHaveLength(0);
  });

  it('accepts the platform x-webhook-* header names (LLD task 1.7 — Round 6 fix)', async () => {
    const secret = 'whsec_naming_test';
    seedExecution('exec-naming', 'step-extract', 'waiting_callback', secret);

    const body = '{"status":"success","envelope":{"schemaVersion":1}}';
    const platformHeaders = buildSignatureHeaders(secret, body);
    // These should all be `x-webhook-*` per the platform helper.
    expect(platformHeaders['x-webhook-signature']).toBeDefined();
    expect(platformHeaders['x-webhook-timestamp']).toBeDefined();

    const resp = await postCallback('exec-naming', 'step-extract', body, platformHeaders);
    expect(resp.status).toBe(200);
  });
});
