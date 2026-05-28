import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const nativeFetch = globalThis.fetch.bind(globalThis);

async function startCallbackSink(): Promise<{
  callbackUrl: string;
  bodies: string[];
  close: () => Promise<void>;
}> {
  const bodies: string[] = [];
  const server = http.createServer((req, res) => {
    let body = '';

    req.on('data', (chunk: Buffer) => {
      body += chunk.toString('utf8');
    });
    req.on('end', () => {
      bodies.push(body);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.listen(0, '127.0.0.1', (error?: Error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });

  const address = server.address() as AddressInfo;

  return {
    callbackUrl: `http://127.0.0.1:${address.port}/webhook`,
    bodies,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      }),
  };
}

const mocks = vi.hoisted(() => ({
  workerProcessor: null as any,
  failedHandler: null as any,
  runWithTenantContext: vi.fn(async (_ctx: any, fn: any) => fn()),
  deliveryUpdateOne: vi.fn(),
  subscriptionUpdateOne: vi.fn(),
  subscriptionFindOne: vi.fn(),
  resolveAuthProfileCredentials: vi.fn(),
}));

vi.mock('bullmq', () => {
  class MockWorker {
    constructor(_name: string, processor: any) {
      mocks.workerProcessor = processor;
    }

    on(event: string, handler: any) {
      if (event === 'failed') {
        mocks.failedHandler = handler;
      }
    }

    close() {
      return Promise.resolve();
    }
  }

  return { Worker: MockWorker };
});

describe('delivery-worker failed-event handling', () => {
  afterEach(async () => {
    try {
      const { stopDeliveryWorker } = await import('../services/queues/delivery-worker.js');
      await stopDeliveryWorker();
    } catch {
      // Ignore module init/teardown failures in tests that never started the worker.
    }
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.workerProcessor = null;
    mocks.failedHandler = null;
    mocks.deliveryUpdateOne.mockResolvedValue({ modifiedCount: 1 });
    mocks.subscriptionUpdateOne.mockResolvedValue({ modifiedCount: 1 });
    mocks.subscriptionFindOne.mockReset();
    mocks.resolveAuthProfileCredentials.mockReset();
    mocks.decryptForTenantAuto.mockImplementation(async (value: string) => `decrypted:${value}`);
    mocks.isAlreadyEncrypted.mockReturnValue(false);
    mocks.assertAllowedCallbackUrl.mockResolvedValue(undefined);
    mocks.buildSignatureHeaders.mockReturnValue({
      'X-ABL-Timestamp': '123',
      'X-ABL-Signature': 'sig',
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        status: 200,
        text: async () => 'ok',
      })),
    );
  });

  it('marks terminal failed status only after retries are exhausted and tenant-scopes the update', async () => {
    const { startDeliveryWorker } = await import('../services/queues/delivery-worker.js');

    await startDeliveryWorker({ duplicate: () => ({ maxRetriesPerRequest: null }) });
    expect(typeof mocks.failedHandler).toBe('function');

    // Non-terminal failure: should not mark status as terminal failed yet.
    await mocks.failedHandler(
      {
        id: 'job-1',
        attemptsMade: 1,
        opts: { attempts: 5 },
        data: { tenantId: 'tenant-1', deliveryId: 'delivery-1' },
      },
      new Error('temporary error'),
    );
    expect(mocks.runWithTenantContext).not.toHaveBeenCalled();
    expect(mocks.deliveryUpdateOne).not.toHaveBeenCalled();

    // Terminal failure: should mark status failed with tenant-scoped where clause.
    await mocks.failedHandler(
      {
        id: 'job-1',
        attemptsMade: 5,
        opts: { attempts: 5 },
        data: { tenantId: 'tenant-1', deliveryId: 'delivery-1' },
      },
      new Error('permanent error'),
    );

    expect(mocks.runWithTenantContext).toHaveBeenCalledTimes(1);
    expect(mocks.deliveryUpdateOne).toHaveBeenCalledWith(
      { _id: 'delivery-1', tenantId: 'tenant-1' },
      expect.objectContaining({
        $set: expect.objectContaining({
          status: 'failed',
        }),
      }),
    );
  });

  it('uses plugin-decrypted webhook secrets without attempting a second decrypt', async () => {
    mocks.subscriptionFindOne.mockReturnValue({
      lean: vi.fn().mockResolvedValue({
        _id: 'sub-1',
        tenantId: 'tenant-1',
        status: 'active',
        callbackUrl: 'https://example.com/webhook',
        encryptedSecret: 'plain-secret',
        authProfileId: null,
      }),
    });

    const { startDeliveryWorker } = await import('../services/queues/delivery-worker.js');

    await startDeliveryWorker({ duplicate: () => ({ maxRetriesPerRequest: null }) });

    await mocks.workerProcessor({
      id: 'job-plain',
      attemptsMade: 0,
      data: {
        tenantId: 'tenant-1',
        deliveryId: 'delivery-1',
        subscriptionId: 'sub-1',
        payload: '{"ok":true}',
      },
    });

    expect(mocks.decryptForTenantAuto).not.toHaveBeenCalled();
    expect(mocks.buildSignatureHeaders).toHaveBeenCalledWith('plain-secret', '{"ok":true}');
    expect(fetch).toHaveBeenCalledWith(
      'https://example.com/webhook',
      expect.objectContaining({
        method: 'POST',
      }),
    );
  });

  it('decrypts stored ciphertext when the subscription secret still looks encrypted', async () => {
    mocks.subscriptionFindOne.mockReturnValue({
      lean: vi.fn().mockResolvedValue({
        _id: 'sub-2',
        tenantId: 'tenant-1',
        status: 'active',
        callbackUrl: 'https://example.com/webhook',
        encryptedSecret: 'legacy:ciphertext',
        authProfileId: null,
      }),
    });
    mocks.isAlreadyEncrypted.mockReturnValue(true);
    mocks.decryptForTenantAuto.mockResolvedValue('resolved-secret');

    const { startDeliveryWorker } = await import('../services/queues/delivery-worker.js');

    await startDeliveryWorker({ duplicate: () => ({ maxRetriesPerRequest: null }) });

    await mocks.workerProcessor({
      id: 'job-cipher',
      attemptsMade: 0,
      data: {
        tenantId: 'tenant-1',
        deliveryId: 'delivery-2',
        subscriptionId: 'sub-2',
        payload: '{"ok":true}',
      },
    });

    expect(mocks.decryptForTenantAuto).toHaveBeenCalledWith('legacy:ciphertext', 'tenant-1');
    expect(mocks.buildSignatureHeaders).toHaveBeenCalledWith('resolved-secret', '{"ok":true}');
  });

  it('uses auth profile webhook secret when authProfileId is configured', async () => {
    mocks.subscriptionFindOne.mockReturnValue({
      lean: vi.fn().mockResolvedValue({
        _id: 'sub-3',
        tenantId: 'tenant-1',
        status: 'active',
        callbackUrl: 'https://example.com/webhook',
        encryptedSecret: 'legacy:ciphertext',
        authProfileId: 'profile-1',
      }),
    });
    mocks.isAlreadyEncrypted.mockReturnValue(true);
    mocks.resolveAuthProfileCredentials.mockResolvedValue({
      profileId: 'profile-1',
      authType: 'api_key',
      config: {},
      secrets: { webhookSecret: 'profile-secret' },
    });

    const { startDeliveryWorker } = await import('../services/queues/delivery-worker.js');

    await startDeliveryWorker({ duplicate: () => ({ maxRetriesPerRequest: null }) });

    await mocks.workerProcessor({
      id: 'job-auth-profile',
      attemptsMade: 0,
      data: {
        tenantId: 'tenant-1',
        deliveryId: 'delivery-3',
        subscriptionId: 'sub-3',
        payload: '{"ok":true}',
      },
    });

    expect(mocks.resolveAuthProfileCredentials).toHaveBeenCalledWith('profile-1', 'tenant-1');
    expect(mocks.decryptForTenantAuto).not.toHaveBeenCalled();
    expect(mocks.buildSignatureHeaders).toHaveBeenCalledWith('profile-secret', '{"ok":true}');
  });

  it('posts HTTP Async status before final response when delivery jobs are processed in queue order', async () => {
    mocks.subscriptionFindOne.mockReturnValue({
      lean: vi.fn().mockResolvedValue({
        _id: 'sub-http-async',
        tenantId: 'tenant-1',
        status: 'active',
        callbackUrl: 'https://example.com/webhook',
        encryptedSecret: 'plain-secret',
        authProfileId: null,
      }),
    });

    const callbackBodies: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init?: RequestInit) => {
        callbackBodies.push(String(init?.body ?? ''));
        return {
          status: 200,
          text: async () => 'ok',
        };
      }),
    );

    const { startDeliveryWorker } = await import('../services/queues/delivery-worker.js');

    await startDeliveryWorker({ duplicate: () => ({ maxRetriesPerRequest: null }) });

    await mocks.workerProcessor({
      id: 'job-status',
      attemptsMade: 0,
      data: {
        tenantId: 'tenant-1',
        deliveryId: 'delivery-status',
        subscriptionId: 'sub-http-async',
        eventType: 'agent.status',
        payload: JSON.stringify({
          event: 'agent.status',
          message: "I'm still checking that.",
          metadata: {
            status_kind: 'continuity',
            continuity_kind: 'long_running_status',
          },
        }),
      },
    });

    await mocks.workerProcessor({
      id: 'job-response',
      attemptsMade: 0,
      data: {
        tenantId: 'tenant-1',
        deliveryId: 'delivery-response',
        subscriptionId: 'sub-http-async',
        eventType: 'agent.response',
        payload: JSON.stringify({
          event: 'agent.response',
          response: 'Your order is still moving.',
        }),
      },
    });

    expect(callbackBodies.map((body) => JSON.parse(body).event)).toEqual([
      'agent.status',
      'agent.response',
    ]);
    expect(JSON.parse(callbackBodies[0]!)).toMatchObject({
      message: "I'm still checking that.",
      metadata: {
        continuity_kind: 'long_running_status',
      },
    });
    expect(JSON.parse(callbackBodies[1]!)).toMatchObject({
      response: 'Your order is still moving.',
    });
    expect(mocks.deliveryUpdateOne).toHaveBeenCalledWith(
      { _id: 'delivery-status', tenantId: 'tenant-1' },
      expect.objectContaining({
        $set: expect.objectContaining({ status: 'delivered', httpStatus: 200 }),
      }),
    );
    expect(mocks.deliveryUpdateOne).toHaveBeenCalledWith(
      { _id: 'delivery-response', tenantId: 'tenant-1' },
      expect.objectContaining({
        $set: expect.objectContaining({ status: 'delivered', httpStatus: 200 }),
      }),
    );
  });

  it('posts HTTP Async status before the final response to a real callback sink without duplicating the final response', async () => {
    const sink = await startCallbackSink();
    vi.stubGlobal('fetch', nativeFetch);
    mocks.subscriptionFindOne.mockReturnValue({
      lean: vi.fn().mockResolvedValue({
        _id: 'sub-http-async-real-sink',
        tenantId: 'tenant-1',
        status: 'active',
        callbackUrl: sink.callbackUrl,
        encryptedSecret: 'plain-secret',
        authProfileId: null,
      }),
    });

    try {
      const { startDeliveryWorker } = await import('../services/queues/delivery-worker.js');

      await startDeliveryWorker({ duplicate: () => ({ maxRetriesPerRequest: null }) });

      const finalResponse = 'Your order is still moving.';

      await mocks.workerProcessor({
        id: 'job-status-real-sink',
        attemptsMade: 0,
        data: {
          tenantId: 'tenant-1',
          deliveryId: 'delivery-status-real-sink',
          subscriptionId: 'sub-http-async-real-sink',
          eventType: 'agent.status',
          payload: JSON.stringify({
            event: 'agent.status',
            status: 'in_progress',
            message: "I'm still checking that.",
            response: "I'm still checking that.",
            metadata: {
              status_kind: 'continuity',
              continuity_kind: 'long_running_status',
              visibility: 'customer_visible',
              source: 'runtime_topology',
            },
          }),
        },
      });

      await mocks.workerProcessor({
        id: 'job-response-real-sink',
        attemptsMade: 0,
        data: {
          tenantId: 'tenant-1',
          deliveryId: 'delivery-response-real-sink',
          subscriptionId: 'sub-http-async-real-sink',
          eventType: 'agent.response',
          payload: JSON.stringify({
            response: finalResponse,
            outcome: { status: 'ok', usedFallback: false },
            trace_context: {
              session_id: 'session-1',
              delivery: 'correlation_only',
            },
          }),
        },
      });

      expect(sink.bodies).toHaveLength(2);
      const [statusBody, responseBody] = sink.bodies.map((body) => JSON.parse(body));

      expect(statusBody).toMatchObject({
        event: 'agent.status',
        status: 'in_progress',
        message: "I'm still checking that.",
        metadata: {
          continuity_kind: 'long_running_status',
          visibility: 'customer_visible',
        },
      });
      expect(statusBody.response).not.toBe(finalResponse);
      expect(responseBody).toMatchObject({
        response: finalResponse,
        outcome: { status: 'ok', usedFallback: false },
      });
      expect(
        [statusBody, responseBody].filter((body) => body.response === finalResponse),
      ).toHaveLength(1);

      expect(mocks.deliveryUpdateOne).toHaveBeenCalledWith(
        { _id: 'delivery-status-real-sink', tenantId: 'tenant-1' },
        expect.objectContaining({
          $set: expect.objectContaining({ status: 'delivered', httpStatus: 200 }),
        }),
      );
      expect(mocks.deliveryUpdateOne).toHaveBeenCalledWith(
        { _id: 'delivery-response-real-sink', tenantId: 'tenant-1' },
        expect.objectContaining({
          $set: expect.objectContaining({ status: 'delivered', httpStatus: 200 }),
        }),
      );
    } finally {
      await sink.close();
    }
  });

  it('does not fall back to the legacy secret when auth profile resolution fails', async () => {
    mocks.subscriptionFindOne.mockReturnValue({
      lean: vi.fn().mockResolvedValue({
        _id: 'sub-4',
        tenantId: 'tenant-1',
        status: 'active',
        callbackUrl: 'https://example.com/webhook',
        encryptedSecret: 'legacy:ciphertext',
        authProfileId: 'profile-missing',
      }),
    });
    mocks.isAlreadyEncrypted.mockReturnValue(true);
    mocks.resolveAuthProfileCredentials.mockResolvedValue(null);

    const { startDeliveryWorker } = await import('../services/queues/delivery-worker.js');

    await startDeliveryWorker({ duplicate: () => ({ maxRetriesPerRequest: null }) });

    await expect(
      mocks.workerProcessor({
        id: 'job-auth-profile-fail',
        attemptsMade: 0,
        data: {
          tenantId: 'tenant-1',
          deliveryId: 'delivery-4',
          subscriptionId: 'sub-4',
          payload: '{"ok":true}',
        },
      }),
    ).rejects.toThrow(/cannot resolve webhook secret/);

    expect(mocks.decryptForTenantAuto).not.toHaveBeenCalled();
    expect(mocks.buildSignatureHeaders).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });
});
