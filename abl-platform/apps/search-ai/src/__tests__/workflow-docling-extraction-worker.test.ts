/**
 * Workflow-docling extraction worker — end-to-end round-trip integration test
 * (LLD Phase 1 Task 1.8 + Exit Criterion).
 *
 * Exercises the full `processExtractionOnly` pipeline against:
 *   1. A real out-of-process Docling fixture (`docling-fixture.ts`) serving
 *      `POST /extract` over HTTP.
 *   2. A real Express callback receiver that runs the platform
 *      `verifyWebhookSignature` to validate the worker's HMAC headers — the
 *      same helper the production `workflow-callbacks.ts` route uses.
 *
 * No `vi.mock()` of `@agent-platform/*` or `@abl/*` packages. The "Job"
 * fabricated here is a plain object — BullMQ never enters the picture
 * because `processExtractionOnly` does not depend on the BullMQ runtime
 * (the worker's only role is to invoke this function with the dequeued
 * data; here we simulate that directly).
 *
 * The test covers:
 *   - SSRF re-validation at the worker boundary
 *   - Inbound stream → Docling fixture → response parse
 *   - Normalization into the canonical ExtractionEnvelope shape
 *   - Inline-cap enforcement (over-budget envelope → failure callback)
 *   - HMAC-signed callback POST verified end-to-end against the real
 *     `verifyWebhookSignature` helper
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import express from 'express';
import type { Request, Response } from 'express';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { verifyWebhookSignature } from '@agent-platform/shared-kernel/security';
import type { Job } from 'bullmq';
import type { WorkflowDoclingExtractionJobData } from '@agent-platform/search-ai-sdk';
import { startDoclingFixture, type DoclingFixtureHandle } from './fixtures/docling-fixture.js';
import { processExtractionOnly } from '../workers/branches/extraction-only.js';

interface ReceivedCallback {
  status: number;
  bodyText: string;
  parsedBody: unknown;
  signatureValid: boolean;
  headers: Record<string, string | string[] | undefined>;
}

interface CallbackReceiverHandle {
  url: string;
  received: ReceivedCallback[];
  close: () => Promise<void>;
}

async function startCallbackReceiver(
  resolveSecret: (executionId: string, stepId: string) => string,
): Promise<CallbackReceiverHandle> {
  const app = express();
  const received: ReceivedCallback[] = [];

  // Capture raw body for HMAC verification (the production callback route
  // does the same — `verifyWebhookSignature` requires the exact transmitted
  // bytes, not the parsed JSON).
  app.use(
    express.raw({
      type: () => true,
      limit: '100mb',
    }),
  );

  app.post('/api/v1/workflows/callbacks/:executionId/:stepId', (req: Request, res: Response) => {
    const { executionId, stepId } = req.params;
    const rawBody: Buffer = req.body;
    const bodyText = rawBody.toString('utf8');

    const signature =
      (req.headers['x-webhook-signature'] as string | undefined) ??
      (req.headers['x-callback-signature'] as string | undefined);
    const timestamp =
      (req.headers['x-webhook-timestamp'] as string | undefined) ??
      (req.headers['x-callback-timestamp'] as string | undefined);

    let signatureValid = false;
    if (signature && timestamp) {
      const secret = resolveSecret(executionId, stepId);
      signatureValid = verifyWebhookSignature(secret, bodyText, signature, timestamp, 300);
    }

    received.push({
      status: 200,
      bodyText,
      parsedBody: JSON.parse(bodyText) as unknown,
      signatureValid,
      headers: { ...req.headers },
    });

    res.status(200).json({ ok: true });
  });

  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const addr = server.address() as AddressInfo;
  const url = `http://127.0.0.1:${addr.port}`;

  return {
    url,
    received,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}

function buildJob(
  overrides: Partial<WorkflowDoclingExtractionJobData> = {},
): Job<WorkflowDoclingExtractionJobData> {
  const data: WorkflowDoclingExtractionJobData = {
    mode: 'extraction-only',
    sourceUrl: 'https://example.com/doc.pdf',
    tenantId: 't-test',
    projectId: 'p-test',
    workflowExecutionId: 'exec-test',
    stepId: 'step-extract',
    callbackId: 'step-extract',
    callbackUrl: 'http://placeholder/api/v1/workflows/callbacks/exec-test/step-extract',
    callbackSecret: 'whsec_test_round_trip_secret',
    options: { extractImages: true, extractTables: true, ocrEnabled: true },
    ...overrides,
  };
  // Minimal Job shape the processor uses — id, data, queueName. The
  // `BullMQ.Job` interface has many other fields but `processExtractionOnly`
  // only reads these three.
  return {
    id: 'job-test',
    data,
    queueName: 'workflow-docling-extraction',
  } as Job<WorkflowDoclingExtractionJobData>;
}

let docling: DoclingFixtureHandle;
let originalDoclingUrl: string | undefined;
let originalAllowedHosts: string | undefined;

beforeAll(async () => {
  docling = await startDoclingFixture();
  originalDoclingUrl = process.env.DOCLING_SERVICE_URL;
  process.env.DOCLING_SERVICE_URL = docling.url;
  // Allow loopback for the test fixture. Production deployments leave this
  // env unset and `assertUrlSafeForSSRF` blocks 127.0.0.1 / RFC1918 by default.
  originalAllowedHosts = process.env.SSRF_ALLOWED_HOSTNAMES;
  process.env.SSRF_ALLOWED_HOSTNAMES = '127.0.0.1,localhost';
});

afterAll(async () => {
  await docling.close();
  if (originalDoclingUrl === undefined) delete process.env.DOCLING_SERVICE_URL;
  else process.env.DOCLING_SERVICE_URL = originalDoclingUrl;
  if (originalAllowedHosts === undefined) delete process.env.SSRF_ALLOWED_HOSTNAMES;
  else process.env.SSRF_ALLOWED_HOSTNAMES = originalAllowedHosts;
});

afterEach(() => {
  docling.reset();
});

describe('processExtractionOnly — round-trip', () => {
  it('streams URL → Docling → normalizes → HMAC-signed callback', async () => {
    // The Docling fixture serves itself as a public URL. We point the
    // inbound `sourceUrl` at the fixture's `/info` endpoint (it returns a
    // small JSON blob that `safeFetch` will happily fetch).
    const fixtureUrl = `${docling.url}/info`;

    const callbacks = await startCallbackReceiver(() => 'whsec_test_round_trip_secret');
    try {
      const job = buildJob({
        sourceUrl: fixtureUrl,
        callbackUrl: `${callbacks.url}/api/v1/workflows/callbacks/exec-test/step-extract`,
      });

      await processExtractionOnly(job);

      expect(callbacks.received).toHaveLength(1);
      const callback = callbacks.received[0]!;
      expect(callback.signatureValid).toBe(true);

      const parsed = callback.parsedBody as { status: string; envelope?: Record<string, unknown> };
      expect(parsed.status).toBe('success');
      expect(parsed.envelope).toBeDefined();
      // TODO Phase 2: replace these manual property assertions with
      // `ExtractionEnvelopeSchema.parse(parsed.envelope)` once the canonical
      // Zod schema lands at `packages/connectors/src/native/extraction-envelope.ts`.
      const envelope = parsed.envelope!;
      expect(envelope.schemaVersion).toBe(1);
      expect(envelope.provider).toBe('docling');
      expect(envelope.sourceUrl).toBe(fixtureUrl);

      // Docling was actually invoked
      expect(docling.callCount).toBe(1);
    } finally {
      await callbacks.close();
    }
  });

  it('rejects SSRF-blocked URLs before any Docling call', async () => {
    const callbacks = await startCallbackReceiver(() => 'whsec_test_round_trip_secret');
    try {
      const job = buildJob({
        sourceUrl: 'http://169.254.169.254/latest/meta-data/',
        callbackUrl: `${callbacks.url}/api/v1/workflows/callbacks/exec-test/step-extract`,
      });

      await processExtractionOnly(job);

      expect(docling.callCount).toBe(0);
      expect(callbacks.received).toHaveLength(1);
      const parsed = callbacks.received[0]!.parsedBody as {
        status: string;
        error?: { code: string; message: string };
      };
      expect(parsed.status).toBe('failed');
      expect(parsed.error?.code).toBe('SSRF_BLOCKED');
      // Sanitization: the error message must NOT echo the metadata IP back.
      expect(parsed.error?.message).not.toMatch(/169\.254\.169\.254/);
    } finally {
      await callbacks.close();
    }
  });

  it('returns EXTRACTION_TOO_LARGE when the envelope exceeds the inline cap', async () => {
    const callbacks = await startCallbackReceiver(() => 'whsec_test_round_trip_secret');
    const originalCap = process.env.DOCLING_WORKFLOW_INLINE_CAP_BYTES;
    process.env.DOCLING_WORKFLOW_INLINE_CAP_BYTES = '100'; // 100 bytes — anything will exceed it

    try {
      const fixtureUrl = `${docling.url}/info`;
      const job = buildJob({
        sourceUrl: fixtureUrl,
        callbackUrl: `${callbacks.url}/api/v1/workflows/callbacks/exec-test/step-extract`,
      });

      await processExtractionOnly(job);

      expect(callbacks.received).toHaveLength(1);
      const parsed = callbacks.received[0]!.parsedBody as {
        status: string;
        error?: { code: string };
      };
      expect(parsed.status).toBe('failed');
      expect(parsed.error?.code).toBe('EXTRACTION_TOO_LARGE');
    } finally {
      if (originalCap === undefined) delete process.env.DOCLING_WORKFLOW_INLINE_CAP_BYTES;
      else process.env.DOCLING_WORKFLOW_INLINE_CAP_BYTES = originalCap;
      await callbacks.close();
    }
  });

  it('callback POST headers carry the platform-standard x-webhook-* names', async () => {
    const callbacks = await startCallbackReceiver(() => 'whsec_test_round_trip_secret');
    try {
      const fixtureUrl = `${docling.url}/info`;
      const job = buildJob({
        sourceUrl: fixtureUrl,
        callbackUrl: `${callbacks.url}/api/v1/workflows/callbacks/exec-test/step-extract`,
      });

      await processExtractionOnly(job);

      const callback = callbacks.received[0]!;
      expect(callback.headers['x-webhook-signature']).toBeDefined();
      expect(callback.headers['x-webhook-timestamp']).toBeDefined();
      expect(callback.headers['x-webhook-id']).toBeDefined();
    } finally {
      await callbacks.close();
    }
  });

  it('signature rejection: callback receiver verifies with wrong secret → invalid', async () => {
    // Receiver uses the wrong secret — assert that signature validation fails
    // (proves the poster signs correctly: a mismatch is detected, not silently
    // accepted).
    const callbacks = await startCallbackReceiver(() => 'whsec_DIFFERENT_secret');
    try {
      const fixtureUrl = `${docling.url}/info`;
      const job = buildJob({
        sourceUrl: fixtureUrl,
        callbackUrl: `${callbacks.url}/api/v1/workflows/callbacks/exec-test/step-extract`,
      });

      await processExtractionOnly(job);

      expect(callbacks.received).toHaveLength(1);
      expect(callbacks.received[0]!.signatureValid).toBe(false);
    } finally {
      await callbacks.close();
    }
  });
});
