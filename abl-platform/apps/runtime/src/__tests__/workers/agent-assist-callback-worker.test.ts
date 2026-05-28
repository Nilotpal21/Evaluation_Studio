/**
 * Unit tests for agent-assist-callback-worker (processCallbackJob).
 *
 * Tests the pure `processCallbackJob` function via DI — no vi.mock, no BullMQ.
 * External HTTP delivery is injected via `deliverPayload`.
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';
import {
  processCallbackJob,
  type AgentAssistCallbackJob,
  type CallbackWorkerDeps,
  type ProcessJobContext,
  type DeliveryResult,
} from '../../workers/agent-assist-callback-worker.js';
import type { V1ExecuteResponse } from '../../services/agent-assist/types.js';
import { SIGNATURE_HEADER } from '../../services/agent-assist/callback-signer.js';

// ─── Test fixtures ──────────────────────────────────────────────────────

function makeJob(overrides?: Partial<AgentAssistCallbackJob>): AgentAssistCallbackJob {
  return {
    messageId: 'msg-123',
    runId: 'run-123',
    tenantId: 'tenant-1',
    projectId: 'project-1',
    appId: 'aa-test',
    envName: 'dev',
    bindingId: 'binding-1',
    callbackUrl: 'https://example.com/callback',
    binding: {
      deploymentId: null,
      apiKeyId: 'api-key-1',
      runtimeBaseUrl: null,
    },
    input: {
      executionInput: {
        userMessage: 'Hello',
        sessionReference: 'ref-1',
      },
      source: 'agent-assist-v1',
      metadata: { locale: 'en-US' },
      userReference: 'user-1',
      callerUserId: 'caller-user-1',
      callerApiKeyId: 'api-key-1',
    },
    ...overrides,
  };
}

function makeEnvelope(): V1ExecuteResponse {
  return {
    messageId: 'msg_1',
    output: [{ type: 'text', content: 'Response text' }],
    sessionInfo: {
      sessionId: 'session-1',
      runId: 'run-123',
      status: 'completed',
      appId: 'aa-test',
    },
  };
}

function makeDeliveryResult(overrides?: Partial<DeliveryResult>): DeliveryResult {
  return {
    ok: true,
    status: 200,
    elapsedMs: 50,
    ...overrides,
  };
}

// ─── Tests ──────────────────────────────────────────────────────────────

describe('processCallbackJob', () => {
  let dlqEntries: unknown[];
  let dlqQueue: ProcessJobContext['dlqQueue'];
  let deliverPayload: ReturnType<typeof vi.fn>;
  let executeTurnAndBuildEnvelope: ReturnType<typeof vi.fn>;
  let deps: CallbackWorkerDeps;
  let ctx: ProcessJobContext;

  beforeEach(() => {
    dlqEntries = [];
    dlqQueue = {
      add: vi.fn(async (_name: string, data: unknown) => {
        dlqEntries.push(data);
      }),
    };
    deliverPayload =
      vi.fn<
        (
          url: string,
          body: string,
          headers: Record<string, string>,
          options: ProcessJobContext['urlValidationOptions'],
        ) => Promise<DeliveryResult>
      >();
    executeTurnAndBuildEnvelope =
      vi.fn<(job: AgentAssistCallbackJob) => Promise<V1ExecuteResponse>>();

    deps = {
      executeTurnAndBuildEnvelope,
      deliverPayload,
    };

    ctx = {
      deps,
      dlqQueue,
      urlValidationOptions: {},
    };
  });

  it('successful delivery — calls deliver with signed header', async () => {
    executeTurnAndBuildEnvelope.mockResolvedValue(makeEnvelope());
    deliverPayload.mockResolvedValue(makeDeliveryResult());

    // Set signing secret for this test
    const originalEnv = process.env.AGENT_ASSIST_CALLBACK_SIGNING_SECRET;
    process.env.AGENT_ASSIST_CALLBACK_SIGNING_SECRET = 'test-secret';

    try {
      await processCallbackJob(makeJob(), 0, 5, ctx);

      expect(deliverPayload).toHaveBeenCalledOnce();
      const [url, _body, headers] = deliverPayload.mock.calls[0];
      expect(url).toBe('https://example.com/callback');
      expect(headers['Content-Type']).toBe('application/json');
      expect(headers['User-Agent']).toBe('ABL-Agent-Assist-Compat/1');
      expect(headers['X-ABL-Run-Id']).toBe('run-123');
      expect(headers['X-ABL-Event']).toBe('agentic.callback.complete');
      expect(headers[SIGNATURE_HEADER]).toMatch(/^t=\d+,v1=[a-f0-9]{64}$/);
      expect(deliverPayload.mock.calls[0][3]).toEqual({});

      // No DLQ entries
      expect(dlqEntries).toHaveLength(0);
    } finally {
      if (originalEnv === undefined) {
        delete process.env.AGENT_ASSIST_CALLBACK_SIGNING_SECRET;
      } else {
        process.env.AGENT_ASSIST_CALLBACK_SIGNING_SECRET = originalEnv;
      }
    }
  });

  it('successful delivery — no signature when no secret configured', async () => {
    executeTurnAndBuildEnvelope.mockResolvedValue(makeEnvelope());
    deliverPayload.mockResolvedValue(makeDeliveryResult());

    const originalEnv = process.env.AGENT_ASSIST_CALLBACK_SIGNING_SECRET;
    delete process.env.AGENT_ASSIST_CALLBACK_SIGNING_SECRET;

    try {
      await processCallbackJob(makeJob(), 0, 5, ctx);

      const [, , headers] = deliverPayload.mock.calls[0];
      expect(headers[SIGNATURE_HEADER]).toBeUndefined();
    } finally {
      if (originalEnv !== undefined) {
        process.env.AGENT_ASSIST_CALLBACK_SIGNING_SECRET = originalEnv;
      }
    }
  });

  it('retryable failure (500) — throws to let BullMQ retry', async () => {
    executeTurnAndBuildEnvelope.mockResolvedValue(makeEnvelope());
    deliverPayload.mockResolvedValue(makeDeliveryResult({ ok: false, status: 500 }));

    await expect(processCallbackJob(makeJob(), 0, 5, ctx)).rejects.toThrow(
      'Callback delivery failed (retryable)',
    );

    // Not yet in DLQ (still has retries)
    expect(dlqEntries).toHaveLength(0);
  });

  it('terminal failure (400) — moves to DLQ immediately', async () => {
    executeTurnAndBuildEnvelope.mockResolvedValue(makeEnvelope());
    deliverPayload.mockResolvedValue(makeDeliveryResult({ ok: false, status: 400 }));

    // Should NOT throw — terminal failures are handled, not retried
    await processCallbackJob(makeJob(), 0, 5, ctx);

    expect(dlqEntries).toHaveLength(1);
    const entry = dlqEntries[0] as { lastError: { code: string } };
    expect(entry.lastError.code).toBe('TERMINAL_HTTP_ERROR');
  });

  it('408 is retryable (not terminal)', async () => {
    executeTurnAndBuildEnvelope.mockResolvedValue(makeEnvelope());
    deliverPayload.mockResolvedValue(makeDeliveryResult({ ok: false, status: 408 }));

    await expect(processCallbackJob(makeJob(), 0, 5, ctx)).rejects.toThrow('retryable');
    expect(dlqEntries).toHaveLength(0);
  });

  it('429 is retryable (not terminal)', async () => {
    executeTurnAndBuildEnvelope.mockResolvedValue(makeEnvelope());
    deliverPayload.mockResolvedValue(makeDeliveryResult({ ok: false, status: 429 }));

    await expect(processCallbackJob(makeJob(), 0, 5, ctx)).rejects.toThrow('retryable');
    expect(dlqEntries).toHaveLength(0);
  });

  it('exhausted retries (last attempt with 500) — moves to DLQ', async () => {
    executeTurnAndBuildEnvelope.mockResolvedValue(makeEnvelope());
    deliverPayload.mockResolvedValue(makeDeliveryResult({ ok: false, status: 500 }));

    // attemptsMade = 4, maxAttempts = 5 → this is the last attempt
    await processCallbackJob(makeJob(), 4, 5, ctx);

    expect(dlqEntries).toHaveLength(1);
    const entry = dlqEntries[0] as { lastError: { code: string }; attempts: number };
    expect(entry.lastError.code).toBe('RETRIES_EXHAUSTED');
    expect(entry.attempts).toBe(5);
  });

  it('callback URL re-validation blocks loopback IPs', async () => {
    const job = makeJob({ callbackUrl: 'https://127.0.0.1/callback' });
    executeTurnAndBuildEnvelope.mockResolvedValue(makeEnvelope());

    await processCallbackJob(job, 0, 5, ctx);

    // Should go to DLQ (terminal — invalid URL)
    expect(dlqEntries).toHaveLength(1);
    const entry = dlqEntries[0] as { lastError: { code: string } };
    expect(entry.lastError.code).toBe('INVALID_CALLBACK_URL');

    // Execution should NOT have been called
    expect(executeTurnAndBuildEnvelope).not.toHaveBeenCalled();
    expect(deliverPayload).not.toHaveBeenCalled();
  });

  it('callback URL re-validation blocks RFC1918', async () => {
    const job = makeJob({ callbackUrl: 'https://10.0.0.1/callback' });
    await processCallbackJob(job, 0, 5, ctx);

    expect(dlqEntries).toHaveLength(1);
    expect(executeTurnAndBuildEnvelope).not.toHaveBeenCalled();
  });

  it('callback URL re-validation blocks internal DNS deny-list', async () => {
    const localCtx: ProcessJobContext = {
      ...ctx,
      urlValidationOptions: {
        internalDnsDenyList: ['evil.internal'],
      },
    };
    const job = makeJob({ callbackUrl: 'https://evil.internal/callback' });

    await processCallbackJob(job, 0, 5, localCtx);

    expect(dlqEntries).toHaveLength(1);
    const entry = dlqEntries[0] as { lastError: { message: string } };
    expect(entry.lastError.message).toContain('Internal hostname');
  });

  it('execution failure on last attempt — moves to DLQ', async () => {
    executeTurnAndBuildEnvelope.mockRejectedValue(new Error('Model not available'));

    await processCallbackJob(makeJob(), 4, 5, ctx);

    expect(dlqEntries).toHaveLength(1);
    const entry = dlqEntries[0] as { lastError: { code: string; message: string } };
    expect(entry.lastError.code).toBe('EXECUTION_FAILED');
    expect(entry.lastError.message).toContain('Model not available');
  });

  it('execution failure with retries remaining — throws for retry', async () => {
    executeTurnAndBuildEnvelope.mockRejectedValue(new Error('Temporary'));

    await expect(processCallbackJob(makeJob(), 0, 5, ctx)).rejects.toThrow(
      'Execution failed (retryable)',
    );

    expect(dlqEntries).toHaveLength(0);
  });

  it('network error (status 0) is retryable', async () => {
    executeTurnAndBuildEnvelope.mockResolvedValue(makeEnvelope());
    deliverPayload.mockResolvedValue(
      makeDeliveryResult({
        ok: false,
        status: 0,
        errorMessage: 'fetch failed',
      }),
    );

    await expect(processCallbackJob(makeJob(), 0, 5, ctx)).rejects.toThrow('retryable');
    expect(dlqEntries).toHaveLength(0);
  });

  it('timeout error is retryable', async () => {
    executeTurnAndBuildEnvelope.mockResolvedValue(makeEnvelope());
    deliverPayload.mockResolvedValue(
      makeDeliveryResult({
        ok: false,
        status: 0,
        errorMessage: 'Callback delivery timed out',
      }),
    );

    await expect(processCallbackJob(makeJob(), 0, 5, ctx)).rejects.toThrow('retryable');
  });
});
