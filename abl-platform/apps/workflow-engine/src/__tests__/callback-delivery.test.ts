import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock bullmq before importing CallbackDeliveryWorker
const mockQueueAdd = vi.fn().mockResolvedValue({ id: 'job-1' });
const mockQueueClose = vi.fn().mockResolvedValue(undefined);

const mockWorkerClose = vi.fn().mockResolvedValue(undefined);
let workerProcessor: ((job: unknown) => Promise<void>) | null = null;
const mockWorkerOn = vi.fn();

vi.mock('bullmq', () => {
  function MockQueue() {
    return {
      add: mockQueueAdd,
      close: mockQueueClose,
    };
  }
  function MockWorker(_name: string, processor: (job: unknown) => Promise<void>) {
    workerProcessor = processor;
    return {
      close: mockWorkerClose,
      on: mockWorkerOn,
    };
  }
  return { Queue: MockQueue, Worker: MockWorker };
});

// Mock the security functions — use inline fns to avoid hoisting issues
vi.mock('@agent-platform/shared-kernel/security', () => ({
  buildSignatureHeaders: vi.fn().mockReturnValue({
    'x-webhook-signature': 'sha256=abc123',
    'x-webhook-timestamp': '1234567890',
  }),
}));

vi.mock('@agent-platform/shared-kernel/security/safe-fetch', () => ({
  SSRFError: class SSRFError extends Error {
    constructor(message: string) {
      super(message);
      this.name = 'SSRFError';
    }
  },
  assertUrlSafeForFetch: vi.fn(),
  safeFetch: vi.fn(),
}));

// Mock the WorkflowExecution model — use inline fn
vi.mock('@agent-platform/database/models', () => ({
  WorkflowExecution: {
    findOneAndUpdate: vi.fn().mockResolvedValue(null),
  },
}));

// Import after mocks are set up
import {
  CallbackDeliveryWorker,
  type CallbackDeliveryDeps,
  type CallbackJobData,
} from '../services/callback-delivery-worker.js';
import type {
  BullMQConnectionPair,
  RedisClient,
  RedisConnectionHandle,
} from '@agent-platform/redis';
import { buildSignatureHeaders } from '@agent-platform/shared-kernel/security';
import {
  assertUrlSafeForFetch,
  safeFetch,
} from '@agent-platform/shared-kernel/security/safe-fetch';
import { WorkflowExecution } from '@agent-platform/database/models';

const mockBuildSignatureHeaders = vi.mocked(buildSignatureHeaders);
const mockAssertUrlSafeForFetch = vi.mocked(assertUrlSafeForFetch);
const mockSafeFetch = vi.mocked(safeFetch);
const mockFindOneAndUpdate = vi.mocked(WorkflowExecution.findOneAndUpdate);

function makeMockRedis() {
  return {
    duplicate: vi.fn().mockReturnValue({
      disconnect: vi.fn(),
    }),
  } as unknown as import('ioredis').Redis;
}

function fakePair(handle: RedisConnectionHandle): BullMQConnectionPair {
  return {
    queueConnection: handle.duplicate({ maxRetriesPerRequest: null }) as unknown as RedisClient,
    workerConnection: handle.duplicate({ maxRetriesPerRequest: null }) as unknown as RedisClient,
    disconnect: () => {},
  };
}

function makeDeps(overrides: Partial<CallbackDeliveryDeps> = {}): CallbackDeliveryDeps {
  return {
    webhookSecret: vi.fn().mockResolvedValue('test-secret-key'),
    // Matches the `cipher:<plaintext>` stub used by the /execute route test;
    // here we run the inverse so a job carrying ciphertext yields the bearer
    // token the caller originally supplied.
    decryptSecret: vi.fn().mockImplementation(async (ciphertext: string, _tenantId: string) => {
      return ciphertext.startsWith('cipher:') ? ciphertext.slice('cipher:'.length) : ciphertext;
    }),
    createBullMQPairFn: fakePair,
    ...overrides,
  };
}

function makeJobData(overrides: Partial<CallbackJobData> = {}): CallbackJobData {
  return {
    executionId: 'exec-1',
    tenantId: 't1',
    callbackUrl: 'https://example.com/webhook',
    payload: {
      traceId: 'trace-1',
      status: 'completed',
      result: { output: 'done' },
    },
    ...overrides,
  };
}

describe('CallbackDeliveryWorker — INT-4: Callback delivery with HMAC', () => {
  let deps: CallbackDeliveryDeps;
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    vi.clearAllMocks();
    workerProcessor = null;
    deps = makeDeps();

    originalFetch = globalThis.fetch;
    mockSafeFetch.mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
    } as Response);

    // Re-setup mock return values after clearAllMocks
    mockAssertUrlSafeForFetch.mockResolvedValue(undefined);
    mockSafeFetch.mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
    } as Response);
    mockAssertUrlSafeForFetch.mockImplementation(() => {
      /* no-op — URL is safe */
      return Promise.resolve();
    });
    mockBuildSignatureHeaders.mockReturnValue({
      'x-webhook-signature': 'sha256=abc123',
      'x-webhook-timestamp': '1234567890',
    });

    // eslint-disable-next-line no-new -- side-effect: initializes worker
    new CallbackDeliveryWorker(makeMockRedis(), deps);
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('initializes worker and captures processor function', () => {
    expect(workerProcessor).not.toBeNull();
  });

  describe('successful callback delivery', () => {
    it('performs SSRF check, signs payload with HMAC, and delivers via HTTP POST', async () => {
      const jobData = makeJobData();
      const mockJob = { id: 'job-1', data: jobData, attemptsMade: 0 };

      await workerProcessor!(mockJob);

      // 1. SSRF check was performed
      expect(mockAssertUrlSafeForFetch).toHaveBeenCalledWith('https://example.com/webhook');

      // 2. Webhook secret was fetched for tenant (second arg is optional `source`, undefined here)
      expect(deps.webhookSecret).toHaveBeenCalledWith('t1', undefined);

      // 3. HMAC signature headers were built
      expect(mockBuildSignatureHeaders).toHaveBeenCalledWith(
        'test-secret-key',
        JSON.stringify(jobData.payload),
      );

      // 4. HTTP POST was made with signed payload
      expect(mockSafeFetch).toHaveBeenCalledWith(
        'https://example.com/webhook',
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({
            'Content-Type': 'application/json',
            'x-webhook-signature': 'sha256=abc123',
            'x-webhook-timestamp': '1234567890',
          }),
          body: JSON.stringify(jobData.payload),
        }),
      );

      // 5. Execution document was updated with callback status
      expect(mockFindOneAndUpdate).toHaveBeenCalledWith(
        { _id: 'exec-1', tenantId: 't1' },
        { $set: { 'triggerMetadata.callbackStatus': 'delivered' } },
      );
    });

    it('includes error payload in callback when present', async () => {
      const jobData = makeJobData({
        payload: {
          traceId: 'trace-2',
          status: 'failed',
          error: {
            code: 'STEP_FAILED',
            message: 'HTTP step returned 500',
          },
        },
      });
      const mockJob = { id: 'job-2', data: jobData, attemptsMade: 0 };

      await workerProcessor!(mockJob);

      expect(mockSafeFetch).toHaveBeenCalledWith(
        'https://example.com/webhook',
        expect.objectContaining({
          body: JSON.stringify(jobData.payload),
        }),
      );
    });

    it('decrypts encryptedAccessToken and adds Authorization: Bearer header', async () => {
      // Caller supplied `bearer-token-xyz`; the /execute route stored it
      // as `cipher:bearer-token-xyz`. The worker decrypts and emits the
      // plaintext bearer only in the outbound header.
      const jobData = makeJobData({ encryptedAccessToken: 'cipher:test-bearer-token' });
      const mockJob = { id: 'job-auth', data: jobData, attemptsMade: 0 };

      await workerProcessor!(mockJob);

      expect(deps.decryptSecret).toHaveBeenCalledWith('cipher:test-bearer-token', 't1');
      expect(mockSafeFetch).toHaveBeenCalledWith(
        'https://example.com/webhook',
        expect.objectContaining({
          headers: expect.objectContaining({
            Authorization: 'Bearer test-bearer-token',
            'x-webhook-signature': 'sha256=abc123',
          }),
        }),
      );
    });

    it('uses encryptedCallbackSecret for per-request HMAC signing', async () => {
      const jobData = makeJobData({ encryptedCallbackSecret: 'cipher:per-step-secret' });
      const mockJob = { id: 'job-callback-secret', data: jobData, attemptsMade: 0 };

      await workerProcessor!(mockJob);

      expect(deps.decryptSecret).toHaveBeenCalledWith('cipher:per-step-secret', 't1');
      expect(deps.webhookSecret).not.toHaveBeenCalled();
      expect(mockBuildSignatureHeaders).toHaveBeenCalledWith(
        'per-step-secret',
        JSON.stringify(jobData.payload),
      );
    });

    it('omits Authorization header when encryptedAccessToken is absent', async () => {
      const jobData = makeJobData();
      const mockJob = { id: 'job-no-auth', data: jobData, attemptsMade: 0 };

      await workerProcessor!(mockJob);

      expect(deps.decryptSecret).not.toHaveBeenCalled();
      const fetchCall = mockSafeFetch.mock.calls[0];
      const sentHeaders = fetchCall[1].headers as Record<string, string>;
      expect(sentHeaders.Authorization).toBeUndefined();
    });
  });

  describe('SSRF protection', () => {
    it('blocks delivery and returns without throwing when URL fails SSRF check', async () => {
      mockAssertUrlSafeForFetch.mockRejectedValueOnce(
        new Error('URL resolves to private IP range'),
      );

      const jobData = makeJobData({
        callbackUrl: 'http://169.254.169.254/latest/meta-data/',
      });
      const mockJob = { id: 'job-3', data: jobData, attemptsMade: 0 };

      // Should NOT throw — SSRF rejection is permanent (no retry)
      await expect(workerProcessor!(mockJob)).resolves.toBeUndefined();

      // safeFetch should not have been called
      expect(mockSafeFetch).not.toHaveBeenCalled();

      // execution document should not have been updated
      expect(mockFindOneAndUpdate).not.toHaveBeenCalled();
    });
  });

  describe('HTTP failure handling', () => {
    it('throws when HTTP response is not ok to trigger BullMQ retry', async () => {
      mockSafeFetch.mockResolvedValue({
        ok: false,
        status: 503,
        statusText: 'Service Unavailable',
      } as Response);

      const jobData = makeJobData();
      const mockJob = { id: 'job-4', data: jobData, attemptsMade: 1 };

      await expect(workerProcessor!(mockJob)).rejects.toThrow(
        'Callback delivery failed: HTTP 503 Service Unavailable',
      );

      // execution document should not have been updated on failure
      expect(mockFindOneAndUpdate).not.toHaveBeenCalled();
    });
  });

  describe('queue configuration', () => {
    it('registers worker failed event listener', () => {
      expect(mockWorkerOn).toHaveBeenCalledWith('failed', expect.any(Function));
    });
  });
});
