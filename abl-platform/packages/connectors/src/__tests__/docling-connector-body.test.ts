/**
 * Docling connector body — integration tests (LLD Phase 2 Task 2.3 + Round 3 H-1).
 *
 * Exercises `runExtractDocument` end-to-end with:
 *   - A real Express HEAD server (port 0) that the connector probes — no
 *     mocking of `safeFetch`. The connector reads `SSRF_ALLOWED_HOSTNAMES`
 *     so loopback addresses pass the SSRF re-check (same pattern as
 *     `apps/search-ai/src/__tests__/workflow-docling-extraction-worker.test.ts`).
 *   - Stub injections via the `CallbackContext` (no `vi.mock` of platform
 *     packages — CLAUDE.md test-architecture rules).
 *
 * Covers: happy path, SSRF rejection, unsupported MIME, oversized file,
 * rate-limit exhaustion, missing callbackContext, missing enqueue function.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { runExtractDocument, DoclingActionError } from '../native/docling/connector.js';
import { resetDoclingRateLimiter } from '../native/docling/rate-limiter.js';
import type { ActionContext, CallbackContext } from '../types.js';

interface HeadServerHandle {
  url: string;
  reset(): void;
  setContentType(value: string): void;
  setContentLength(value: number | null): void;
  setStatus(value: number): void;
  close(): Promise<void>;
}

async function startHeadServer(): Promise<HeadServerHandle> {
  let contentType = 'application/pdf';
  let contentLength: number | null = 1024;
  let status = 200;

  const server = http.createServer((req, res) => {
    const headers: Record<string, string> = { 'Content-Type': contentType };
    if (contentLength !== null) headers['Content-Length'] = String(contentLength);
    res.writeHead(status, headers);
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const addr = server.address() as AddressInfo;
  const url = `http://127.0.0.1:${addr.port}`;

  return {
    url,
    reset(): void {
      contentType = 'application/pdf';
      contentLength = 1024;
      status = 200;
    },
    setContentType(v) {
      contentType = v;
    },
    setContentLength(v) {
      contentLength = v;
    },
    setStatus(v) {
      status = v;
    },
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}

let head: HeadServerHandle;
let originalAllowedHosts: string | undefined;

beforeAll(async () => {
  head = await startHeadServer();
  originalAllowedHosts = process.env.SSRF_ALLOWED_HOSTNAMES;
  process.env.SSRF_ALLOWED_HOSTNAMES = '127.0.0.1,localhost';
});

afterAll(async () => {
  await head.close();
  if (originalAllowedHosts === undefined) delete process.env.SSRF_ALLOWED_HOSTNAMES;
  else process.env.SSRF_ALLOWED_HOSTNAMES = originalAllowedHosts;
});

beforeEach(() => {
  head.reset();
  resetDoclingRateLimiter();
});

afterEach(() => {
  vi.restoreAllMocks();
});

interface BuildCtxOptions {
  callbackContext?: Partial<CallbackContext> | null;
  params?: Partial<ActionContext['params']>;
}

function buildCtx(options: BuildCtxOptions = {}): ActionContext {
  const enqueue = vi.fn().mockResolvedValue({ jobId: 'job-1' });
  const encrypt = vi.fn().mockResolvedValue('whsec_enc::ciphertext');
  const urlBuilder = vi.fn(
    (executionId: string, stepId: string) =>
      `http://engine.local/callbacks/${executionId}/${stepId}`,
  );
  const baseCallbackCtx: CallbackContext = {
    callbackId: 'exec-1:step-1',
    callbackUrlBuilder: urlBuilder,
    encryptSecret: encrypt,
    enqueueWorkflowDoclingJob: enqueue,
    getSharedRedisClient: () => null,
  };
  const callbackContext =
    options.callbackContext === null
      ? undefined
      : { ...baseCallbackCtx, ...(options.callbackContext ?? {}) };

  const ctx: ActionContext = {
    auth: {},
    params: { fileUrl: `${head.url}/file`, ...(options.params ?? {}) },
    tenantId: 't-test',
    projectId: 'p-test',
    connectionScope: 'tenant',
    executionId: 'exec-1',
    store: {
      get: async () => undefined,
      set: async () => undefined,
      delete: async () => undefined,
    },
    workflowExecutionId: 'wf-exec-1',
    stepId: 'step-1',
    ...(callbackContext ? { callbackContext } : {}),
  };
  return ctx;
}

describe('runExtractDocument — connector body', () => {
  it('happy path: returns an AsyncParkingSentinel with the encrypted secret', async () => {
    const ctx = buildCtx();
    const result = await runExtractDocument(ctx);

    expect(result.__asyncParking).toBe(true);
    expect(result.callbackId).toBe('wf-exec-1:step-1');
    expect(result.callbackTimeoutMs).toBe(60_000);
    expect(result.encryptedCallbackSecret).toBe('whsec_enc::ciphertext');

    const enqueue = ctx.callbackContext!.enqueueWorkflowDoclingJob as ReturnType<typeof vi.fn>;
    expect(enqueue).toHaveBeenCalledTimes(1);
    const payload = enqueue.mock.calls[0]![0] as Record<string, unknown>;
    expect(payload.tenantId).toBe('t-test');
    expect(payload.projectId).toBe('p-test');
    expect(payload.workflowExecutionId).toBe('wf-exec-1');
    expect(payload.stepId).toBe('step-1');
    expect(payload.callbackUrl).toBe('http://engine.local/callbacks/wf-exec-1/step-1');
    expect(payload.callbackSecret).toMatch(/^[a-f0-9]{64}$/);
    expect(payload.mode).toBe('extraction-only');
  });

  it('rejects SSRF-blocked URLs before any side-effects (no HEAD probe, no enqueue)', async () => {
    // Disable the env allowlist so the loopback hardcap (and the metadata
    // endpoint) is enforced. SSRF check throws before HEAD probe runs.
    process.env.SSRF_ALLOWED_HOSTNAMES = '';
    try {
      const ctx = buildCtx({ params: { fileUrl: 'http://169.254.169.254/latest/meta-data/' } });
      await expect(runExtractDocument(ctx)).rejects.toMatchObject({
        name: 'DoclingActionError',
        code: 'SSRF_BLOCKED',
      });
      const enqueue = ctx.callbackContext!.enqueueWorkflowDoclingJob as ReturnType<typeof vi.fn>;
      expect(enqueue).not.toHaveBeenCalled();
    } finally {
      process.env.SSRF_ALLOWED_HOSTNAMES = '127.0.0.1,localhost';
    }
  });

  it('rejects unsupported MIME types from the HEAD probe', async () => {
    head.setContentType('text/css');
    const ctx = buildCtx();
    await expect(runExtractDocument(ctx)).rejects.toMatchObject({
      code: 'UNSUPPORTED_CONTENT_TYPE',
    });
  });

  it('rejects oversized files reported by Content-Length', async () => {
    // 600 MB — over the 500 MB hard cap default
    head.setContentLength(600 * 1024 * 1024);
    const ctx = buildCtx();
    await expect(runExtractDocument(ctx)).rejects.toMatchObject({
      code: 'EXTRACTION_TOO_LARGE',
    });
  });

  it('rejects when the tenant exhausts the per-minute rate limit', async () => {
    process.env.DOCLING_WORKFLOW_RATE_LIMIT_PER_MIN = '2';
    resetDoclingRateLimiter();
    try {
      const ctx1 = buildCtx();
      const ctx2 = buildCtx();
      const ctx3 = buildCtx();
      await runExtractDocument(ctx1);
      await runExtractDocument(ctx2);
      await expect(runExtractDocument(ctx3)).rejects.toMatchObject({ code: 'RATE_LIMITED' });
    } finally {
      delete process.env.DOCLING_WORKFLOW_RATE_LIMIT_PER_MIN;
      resetDoclingRateLimiter();
    }
  });

  it('throws INTEGRATION_UNAVAILABLE when callbackContext is missing', async () => {
    const ctx = buildCtx({ callbackContext: null });
    await expect(runExtractDocument(ctx)).rejects.toMatchObject({
      code: 'INTEGRATION_UNAVAILABLE',
    });
  });

  it('throws INTEGRATION_UNAVAILABLE when enqueueWorkflowDoclingJob is missing', async () => {
    const ctx = buildCtx({ callbackContext: { enqueueWorkflowDoclingJob: undefined } });
    await expect(runExtractDocument(ctx)).rejects.toMatchObject({
      code: 'INTEGRATION_UNAVAILABLE',
    });
  });

  it('rejects malformed params (non-URL fileUrl) before any side-effects', async () => {
    const ctx = buildCtx({ params: { fileUrl: 'not-a-valid-url' } });
    await expect(runExtractDocument(ctx)).rejects.toMatchObject({ code: 'INVALID_PARAMS' });
    const enqueue = ctx.callbackContext!.enqueueWorkflowDoclingJob as ReturnType<typeof vi.fn>;
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('honors the user-supplied timeout (clamped 5..1800) in the resulting sentinel', async () => {
    const ctx = buildCtx({ params: { timeout: 300 } });
    const result = await runExtractDocument(ctx);
    expect(result.callbackTimeoutMs).toBe(300_000);
  });
});
