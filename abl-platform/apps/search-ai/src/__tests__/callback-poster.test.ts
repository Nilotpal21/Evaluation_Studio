/**
 * Unit test: `postCallback` HMAC + backoff semantics (LLD Phase 1 Task 1.7).
 *
 * The poster signs the payload with `buildSignatureHeaders` from
 * `@agent-platform/shared-kernel/security` and posts to the workflow-engine
 * callback route. We inject a stub `fetch` rather than spinning up a real
 * server — the wire shape and retry classification are pure semantics.
 *
 * No `vi.mock()` of platform packages — the poster takes `fetchImpl` as a
 * dependency injection point (CLAUDE.md test-architecture rules).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { postCallback } from '../workers/callback-poster.js';
import { verifyWebhookSignature } from '@agent-platform/shared-kernel/security';

describe('postCallback', () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  it('signs the body with the platform HMAC and reports success on 200', async () => {
    let observedHeaders: Record<string, string> | undefined;
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      observedHeaders = Object.fromEntries(new Headers(init?.headers).entries());
      return new Response('{"ok":true}', { status: 200 });
    });

    const body = JSON.stringify({ status: 'success', envelope: { schemaVersion: 1 } });
    const secret = 'whsec_test_secret_abc';
    const outcome = await postCallback({
      url: 'http://workflow-engine.local/api/v1/workflows/callbacks/exec-1/step-1',
      secret,
      body,
      tenantId: 't-1',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(outcome.ok).toBe(true);
    expect(outcome.status).toBe(200);
    expect(outcome.attempts).toBe(1);
    expect(observedHeaders?.['x-webhook-signature']).toBeTruthy();
    expect(observedHeaders?.['x-webhook-timestamp']).toBeTruthy();
    expect(observedHeaders?.['content-type']).toBe('application/json');

    // Verify the signature using the same helper the callback route uses
    const valid = verifyWebhookSignature(
      secret,
      body,
      observedHeaders!['x-webhook-signature']!,
      observedHeaders!['x-webhook-timestamp']!,
    );
    expect(valid).toBe(true);
  });

  it('treats HTTP 404 as terminal and does not retry', async () => {
    const fetchImpl = vi.fn(async () => new Response('{"error":"not found"}', { status: 404 }));

    const outcome = await postCallback({
      url: 'http://x/y',
      secret: 'whsec_x',
      body: '{}',
      tenantId: 't-1',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(outcome.ok).toBe(false);
    expect(outcome.status).toBe(404);
    expect(outcome.attempts).toBe(1);
    expect(outcome.errorClass).toBe('CALLBACK_NOT_FOUND');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('classifies HTTP 409 as STEP_NOT_WAITING (late callback after engine timeout)', async () => {
    const fetchImpl = vi.fn(
      async () => new Response('{"error":"step not waiting"}', { status: 409 }),
    );

    const outcome = await postCallback({
      url: 'http://x/y',
      secret: 'whsec_x',
      body: '{}',
      tenantId: 't-1',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(outcome.ok).toBe(false);
    expect(outcome.errorClass).toBe('STEP_NOT_WAITING');
    expect(outcome.attempts).toBe(1);
  });

  it('classifies HTTP 401 as SIGNATURE_INVALID (no retry — auth refused)', async () => {
    const fetchImpl = vi.fn(async () => new Response('{"error":"unauthorized"}', { status: 401 }));

    const outcome = await postCallback({
      url: 'http://x/y',
      secret: 'whsec_x',
      body: '{}',
      tenantId: 't-1',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(outcome.ok).toBe(false);
    expect(outcome.errorClass).toBe('SIGNATURE_INVALID');
    expect(outcome.attempts).toBe(1);
  });

  // Round-7 callback-poster split — the callback route emits a `code` field on
  // 401 (TIMESTAMP_EXPIRED / TIMESTAMP_MISSING / SIGNATURE_MISSING /
  // SIGNATURE_INVALID) so the poster can distinguish clock skew from authentic
  // HMAC failures in the failures metric `error_class` dimension.
  it.each([
    ['TIMESTAMP_EXPIRED', 'TIMESTAMP_EXPIRED'],
    ['TIMESTAMP_MISSING', 'TIMESTAMP_MISSING'],
    ['SIGNATURE_MISSING', 'SIGNATURE_MISSING'],
    ['CALLBACK_SECRET_MISSING', 'SIGNATURE_INVALID'], // unknown codes fall back to legacy bucket
  ])('classifies 401 with route code %s as error_class %s', async (routeCode, expectedClass) => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify({ error: 'rejected', code: routeCode }), { status: 401 }),
    );

    const outcome = await postCallback({
      url: 'http://x/y',
      secret: 'whsec_x',
      body: '{}',
      tenantId: 't-1',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(outcome.ok).toBe(false);
    expect(outcome.errorClass).toBe(expectedClass);
  });

  it('falls back to SIGNATURE_INVALID when 401 body is not JSON (route-code unreadable)', async () => {
    const fetchImpl = vi.fn(async () => new Response('plain-text-body-no-json', { status: 401 }));

    const outcome = await postCallback({
      url: 'http://x/y',
      secret: 'whsec_x',
      body: '{}',
      tenantId: 't-1',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(outcome.errorClass).toBe('SIGNATURE_INVALID');
  });

  it('exhausts attempts on persistent 5xx and returns EXHAUSTED', async () => {
    const fetchImpl = vi.fn(async () => new Response('{"error":"oops"}', { status: 503 }));

    // Speed up the test by stubbing setTimeout to invoke immediately
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const promise = postCallback({
        url: 'http://x/y',
        secret: 'whsec_x',
        body: '{}',
        tenantId: 't-1',
        fetchImpl: fetchImpl as unknown as typeof fetch,
      });
      await vi.runAllTimersAsync();
      const outcome = await promise;

      expect(outcome.ok).toBe(false);
      expect(outcome.attempts).toBe(5);
      expect(outcome.errorClass).toBe('SERVER_ERROR');
      expect(fetchImpl).toHaveBeenCalledTimes(5);
    } finally {
      vi.useRealTimers();
    }
  });
});
