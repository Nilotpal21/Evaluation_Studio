import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import crypto from 'crypto';
import {
  GuardrailWebhookDelivery,
  type WebhookConfig,
  type WebhookDeliveryResult,
} from '../../../services/guardrails/webhook';

// ---------------------------------------------------------------------------
// Mock fetch globally
// ---------------------------------------------------------------------------

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

const WEBHOOK_URL = 'https://hooks.example.com/guardrails';
const WEBHOOK_SECRET = 'test-secret-key-for-hmac';

function makeConfig(overrides?: Partial<WebhookConfig>): WebhookConfig {
  return {
    url: WEBHOOK_URL,
    secret: WEBHOOK_SECRET,
    ...overrides,
  };
}

function makeEvent(
  overrides?: Partial<{ type: string; timestamp: number; data: Record<string, unknown> }>,
) {
  return {
    type: 'guardrail_violation',
    timestamp: Date.now(),
    data: { guardrailName: 'pii_check', kind: 'input', action: 'block' },
    ...overrides,
  };
}

function makeOkResponse(): Response {
  return new Response(null, { status: 200, statusText: 'OK' });
}

function makeErrorResponse(status: number): Response {
  return new Response(null, { status, statusText: `Error ${status}` });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('GuardrailWebhookDelivery', () => {
  let webhook: GuardrailWebhookDelivery;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0); // remove jitter so delays are deterministic (baseDelay * 0.75)
    mockFetch.mockReset();
    webhook = new GuardrailWebhookDelivery(makeConfig());
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  // -----------------------------------------------------------------------
  // 1. Sign payload with HMAC-SHA256
  // -----------------------------------------------------------------------
  it('should sign payload with HMAC-SHA256', () => {
    const payload = '{"type":"guardrail_violation","data":{}}';

    const signature = webhook.sign(payload);

    // Verify against Node's crypto directly
    const expected = crypto.createHmac('sha256', WEBHOOK_SECRET).update(payload).digest('hex');

    expect(signature).toBe(expected);
    expect(signature).toMatch(/^[0-9a-f]{64}$/);
  });

  // -----------------------------------------------------------------------
  // 2. Deliver successfully on first attempt
  // -----------------------------------------------------------------------
  it('should deliver successfully on first attempt', async () => {
    mockFetch.mockResolvedValueOnce(makeOkResponse());

    const event = makeEvent();
    const result = await webhook.deliver(event);

    expect(result.success).toBe(true);
    expect(result.statusCode).toBe(200);
    expect(result.attempts).toBe(1);
    expect(result.error).toBeUndefined();

    // Verify fetch was called once
    expect(mockFetch).toHaveBeenCalledTimes(1);

    // Verify the request details
    const [url, options] = mockFetch.mock.calls[0];
    expect(url).toBe(WEBHOOK_URL);
    expect(options.method).toBe('POST');
    expect(options.headers['Content-Type']).toBe('application/json');
    expect(options.headers['X-Guardrail-Event']).toBe('guardrail_violation');
    expect(JSON.parse(options.body)).toEqual(event);
  });

  // -----------------------------------------------------------------------
  // 3. Retry on 5xx errors up to 3 times
  // -----------------------------------------------------------------------
  it('should retry on 5xx errors up to MAX_RETRIES', async () => {
    mockFetch
      .mockResolvedValueOnce(makeErrorResponse(500))
      .mockResolvedValueOnce(makeErrorResponse(502))
      .mockResolvedValueOnce(makeErrorResponse(503))
      .mockResolvedValueOnce(makeOkResponse());

    const event = makeEvent();

    // We need to advance timers during the retry delays
    const deliveryPromise = webhook.deliver(event);

    // Advance past first retry delay (1000ms)
    await vi.advanceTimersByTimeAsync(1000);
    // Advance past second retry delay (4000ms)
    await vi.advanceTimersByTimeAsync(4000);
    // Advance past third retry delay (16000ms)
    await vi.advanceTimersByTimeAsync(16000);

    const result = await deliveryPromise;

    expect(result.success).toBe(true);
    expect(result.attempts).toBe(4); // 1 initial + 3 retries
    expect(mockFetch).toHaveBeenCalledTimes(4);
  });

  // -----------------------------------------------------------------------
  // 4. Do not retry on 4xx errors (except 429)
  // -----------------------------------------------------------------------
  it('should not retry on 4xx errors (except 429)', async () => {
    mockFetch.mockResolvedValueOnce(makeErrorResponse(400));

    const result = await webhook.deliver(makeEvent());

    expect(result.success).toBe(false);
    expect(result.statusCode).toBe(400);
    expect(result.attempts).toBe(1);
    expect(result.error).toBe('HTTP 400');
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('should not retry on 403', async () => {
    mockFetch.mockResolvedValueOnce(makeErrorResponse(403));

    const result = await webhook.deliver(makeEvent());

    expect(result.success).toBe(false);
    expect(result.statusCode).toBe(403);
    expect(result.attempts).toBe(1);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('should not retry on 404', async () => {
    mockFetch.mockResolvedValueOnce(makeErrorResponse(404));

    const result = await webhook.deliver(makeEvent());

    expect(result.success).toBe(false);
    expect(result.statusCode).toBe(404);
    expect(result.attempts).toBe(1);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  // -----------------------------------------------------------------------
  // 5. Retry on 429 (rate limited)
  // -----------------------------------------------------------------------
  it('should retry on 429 (rate limited)', async () => {
    mockFetch.mockResolvedValueOnce(makeErrorResponse(429)).mockResolvedValueOnce(makeOkResponse());

    const deliveryPromise = webhook.deliver(makeEvent());

    // Advance past first retry delay (1000ms)
    await vi.advanceTimersByTimeAsync(1000);

    const result = await deliveryPromise;

    expect(result.success).toBe(true);
    expect(result.attempts).toBe(2);
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  // -----------------------------------------------------------------------
  // 6. Timeout after 10 seconds
  // -----------------------------------------------------------------------
  it('should timeout after 10 seconds per attempt', async () => {
    // Simulate a fetch that never resolves by aborting
    mockFetch.mockImplementation(
      (_url: string, options: { signal: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          options.signal.addEventListener('abort', () => {
            reject(new DOMException('The operation was aborted', 'AbortError'));
          });
        }),
    );

    const deliveryPromise = webhook.deliver(makeEvent());

    // Advance past timeout for initial attempt (10s)
    await vi.advanceTimersByTimeAsync(10000);
    // Advance past retry delay 1 (1s) + timeout (10s)
    await vi.advanceTimersByTimeAsync(11000);
    // Advance past retry delay 2 (4s) + timeout (10s)
    await vi.advanceTimersByTimeAsync(14000);
    // Advance past retry delay 3 (16s) + timeout (10s)
    await vi.advanceTimersByTimeAsync(26000);

    const result = await deliveryPromise;

    expect(result.success).toBe(false);
    expect(result.error).toContain('aborted');
    expect(result.attempts).toBe(4);
  });

  // -----------------------------------------------------------------------
  // 7. Filter events based on config
  // -----------------------------------------------------------------------
  it('should filter events based on config', async () => {
    const filteredWebhook = new GuardrailWebhookDelivery(
      makeConfig({ events: ['guardrail_violation', 'guardrail_pipeline_error'] }),
    );

    // Should not deliver guardrail_check (not in filter list)
    const result = await filteredWebhook.deliver(makeEvent({ type: 'guardrail_check' }));

    expect(result.success).toBe(true);
    expect(result.attempts).toBe(0); // skipped delivery
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('should deliver events that match the filter', async () => {
    mockFetch.mockResolvedValueOnce(makeOkResponse());

    const filteredWebhook = new GuardrailWebhookDelivery(
      makeConfig({ events: ['guardrail_violation', 'guardrail_pipeline_error'] }),
    );

    const result = await filteredWebhook.deliver(makeEvent({ type: 'guardrail_violation' }));

    expect(result.success).toBe(true);
    expect(result.attempts).toBe(1);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  // -----------------------------------------------------------------------
  // 8. Deliver all events when no filter configured
  // -----------------------------------------------------------------------
  it('should deliver all events when no filter configured', async () => {
    mockFetch.mockResolvedValue(makeOkResponse());

    const noFilterWebhook = new GuardrailWebhookDelivery(makeConfig());

    await noFilterWebhook.deliver(makeEvent({ type: 'guardrail_check' }));
    await noFilterWebhook.deliver(makeEvent({ type: 'guardrail_violation' }));
    await noFilterWebhook.deliver(makeEvent({ type: 'guardrail_pipeline_complete' }));

    expect(mockFetch).toHaveBeenCalledTimes(3);
  });

  it('should deliver all events when events filter is empty array', async () => {
    mockFetch.mockResolvedValue(makeOkResponse());

    const emptyFilterWebhook = new GuardrailWebhookDelivery(makeConfig({ events: [] }));

    await emptyFilterWebhook.deliver(makeEvent({ type: 'guardrail_check' }));
    await emptyFilterWebhook.deliver(makeEvent({ type: 'guardrail_violation' }));

    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  // -----------------------------------------------------------------------
  // 9. Include signature and event type headers
  // -----------------------------------------------------------------------
  it('should include X-Guardrail-Signature and X-Guardrail-Event headers', async () => {
    mockFetch.mockResolvedValueOnce(makeOkResponse());

    const event = makeEvent();
    await webhook.deliver(event);

    const [, options] = mockFetch.mock.calls[0];
    const payload = JSON.stringify(event);
    const expectedSignature = crypto
      .createHmac('sha256', WEBHOOK_SECRET)
      .update(payload)
      .digest('hex');

    expect(options.headers['X-Guardrail-Signature']).toBe(expectedSignature);
    expect(options.headers['X-Guardrail-Event']).toBe('guardrail_violation');
  });

  // -----------------------------------------------------------------------
  // 10. Return failure after max retries
  // -----------------------------------------------------------------------
  it('should return failure after max retries exceeded', async () => {
    mockFetch
      .mockResolvedValueOnce(makeErrorResponse(500))
      .mockResolvedValueOnce(makeErrorResponse(500))
      .mockResolvedValueOnce(makeErrorResponse(500))
      .mockResolvedValueOnce(makeErrorResponse(500));

    const deliveryPromise = webhook.deliver(makeEvent());

    // Advance timers for all retry delays
    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(4000);
    await vi.advanceTimersByTimeAsync(16000);

    const result = await deliveryPromise;

    expect(result.success).toBe(false);
    expect(result.attempts).toBe(4); // initial + 3 retries
    expect(mockFetch).toHaveBeenCalledTimes(4);
  });

  // -----------------------------------------------------------------------
  // 11. Handle network errors with retry
  // -----------------------------------------------------------------------
  it('should retry on network errors', async () => {
    mockFetch
      .mockRejectedValueOnce(new Error('Network error'))
      .mockResolvedValueOnce(makeOkResponse());

    const deliveryPromise = webhook.deliver(makeEvent());

    // Advance past retry delay (1000ms)
    await vi.advanceTimersByTimeAsync(1000);

    const result = await deliveryPromise;

    expect(result.success).toBe(true);
    expect(result.attempts).toBe(2);
  });

  // -----------------------------------------------------------------------
  // 12. Return error message on final failure
  // -----------------------------------------------------------------------
  it('should return error message on final network failure', async () => {
    mockFetch.mockRejectedValue(new Error('DNS resolution failed'));

    const deliveryPromise = webhook.deliver(makeEvent());

    // Advance through all retries
    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(4000);
    await vi.advanceTimersByTimeAsync(16000);

    const result = await deliveryPromise;

    expect(result.success).toBe(false);
    expect(result.error).toBe('DNS resolution failed');
    expect(result.attempts).toBe(4);
  });

  // -----------------------------------------------------------------------
  // 13. shouldDeliver method
  // -----------------------------------------------------------------------
  describe('shouldDeliver', () => {
    it('should return true when no events filter configured', () => {
      expect(webhook.shouldDeliver('guardrail_check')).toBe(true);
      expect(webhook.shouldDeliver('guardrail_violation')).toBe(true);
      expect(webhook.shouldDeliver('anything')).toBe(true);
    });

    it('should return true when events filter is empty', () => {
      const emptyFilter = new GuardrailWebhookDelivery(makeConfig({ events: [] }));
      expect(emptyFilter.shouldDeliver('guardrail_check')).toBe(true);
    });

    it('should return true for matching events', () => {
      const filtered = new GuardrailWebhookDelivery(
        makeConfig({ events: ['guardrail_violation'] }),
      );
      expect(filtered.shouldDeliver('guardrail_violation')).toBe(true);
    });

    it('should return false for non-matching events', () => {
      const filtered = new GuardrailWebhookDelivery(
        makeConfig({ events: ['guardrail_violation'] }),
      );
      expect(filtered.shouldDeliver('guardrail_check')).toBe(false);
    });
  });

  // -----------------------------------------------------------------------
  // 14. Signature verification round-trip
  // -----------------------------------------------------------------------
  it('should produce a verifiable HMAC-SHA256 signature', () => {
    const event = makeEvent();
    const payload = JSON.stringify(event);
    const signature = webhook.sign(payload);

    // Verify the signature matches re-computing it
    const verify = crypto.createHmac('sha256', WEBHOOK_SECRET).update(payload).digest('hex');

    expect(signature).toBe(verify);

    // Different secret should produce different signature
    const otherWebhook = new GuardrailWebhookDelivery(makeConfig({ secret: 'different-secret' }));
    const otherSig = otherWebhook.sign(payload);
    expect(otherSig).not.toBe(signature);
  });
});
