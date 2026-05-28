import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Readable } from 'stream';

const mocks = vi.hoisted(() => ({
  workerProcessor: null as any,
  workerEvents: new Map<string, (...args: any[]) => any>(),
  deliveryQueue: null as any,
  queueAdd: vi.fn(),
  redisSet: vi.fn(),
  resolveConnectionById: vi.fn(),
  resolveSession: vi.fn(),
  executeMessage: vi.fn(),
  getSession: vi.fn(),
  rehydrateSession: vi.fn(),
  acquireSessionLock: vi.fn(),
  releaseSessionLock: vi.fn(),
  runWithTenantContext: vi.fn(async (_ctx: any, fn: any) => fn()),
  downloadTwilioMedia: vi.fn(),
  uploadAttachment: vi.fn(),
  transformOutput: vi.fn((text: string) => ({ kind: 'text', text })),
  sendResponse: vi.fn(),
  runtimeSession: {
    id: 'runtime-1',
    agentName: 'agent-1',
    userId: 'user-1',
    tenantId: 'tenant-1',
    projectId: 'project-1',
    compilationOutput: undefined,
    versionInfo: { environment: 'prod' },
  },
}));

vi.mock('@abl/compiler/platform', () => ({
  createLogger: vi.fn().mockReturnValue({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

vi.mock('@agent-platform/shared', () => ({
  runWithTenantContext: mocks.runWithTenantContext,
}));

vi.mock('../config/loader.js', () => ({
  isConfigLoaded: vi.fn(() => true),
  getConfig: vi.fn(() => ({
    redis: { enabled: true, url: 'redis://localhost:6379' },
  })),
}));

vi.mock('../services/queues/channel-queues.js', () => ({
  getDeliveryQueue: vi.fn(() => mocks.deliveryQueue),
}));

vi.mock('../services/redis/redis-client.js', () => ({
  getRedisClient: vi.fn(() => ({
    set: mocks.redisSet,
  })),
  getRedisHandle: vi.fn(() => ({ duplicate: vi.fn(() => ({ maxRetriesPerRequest: null })) })),
}));

vi.mock('../channels/connection-resolver.js', () => ({
  resolveConnectionById: mocks.resolveConnectionById,
}));

vi.mock('../channels/session-resolver.js', () => ({
  resolveSession: mocks.resolveSession,
}));

vi.mock('../services/runtime-executor.js', () => ({
  getRuntimeExecutor: vi.fn(() => ({
    executeMessage: mocks.executeMessage,
    getSession: mocks.getSession,
    rehydrateSession: mocks.rehydrateSession,
  })),
}));

vi.mock('../services/queues/session-lock.js', () => ({
  acquireSessionLock: mocks.acquireSessionLock,
  releaseSessionLock: mocks.releaseSessionLock,
}));

vi.mock('../channels/registry.js', () => ({
  getChannelRegistry: vi.fn(() => ({
    get: vi.fn((type: string) =>
      type === 'twilio_sms'
        ? {
            channelType: 'twilio_sms',
            transformOutput: mocks.transformOutput,
            sendResponse: mocks.sendResponse,
          }
        : undefined,
    ),
  })),
}));

vi.mock('../channels/adapters/twilio-sms-media-downloader.js', () => ({
  downloadTwilioMedia: mocks.downloadTwilioMedia,
}));

vi.mock('../attachments/multimodal-service-client.js', () => ({
  MultimodalServiceClient: class MockMultimodalServiceClient {
    upload = mocks.uploadAttachment;
  },
}));

vi.mock('bullmq', () => {
  class MockWorker {
    constructor(_name: string, processor: any) {
      mocks.workerProcessor = processor;
    }

    on(event: string, handler: any) {
      mocks.workerEvents.set(event, handler);
    }

    close() {
      return Promise.resolve();
    }
  }

  return { Worker: MockWorker };
});

describe('inbound-worker Twilio SMS/MMS flow', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    const { stopInboundWorker } = await import('../services/queues/inbound-worker.js');
    await stopInboundWorker();
    mocks.workerProcessor = null;
    mocks.workerEvents.clear();
    mocks.deliveryQueue = { add: mocks.queueAdd };
    mocks.redisSet.mockResolvedValue('OK');
    mocks.queueAdd.mockResolvedValue(undefined);
    mocks.resolveConnectionById.mockResolvedValue({
      id: 'conn-twilio-1',
      tenantId: 'tenant-1',
      projectId: 'project-1',
      agentId: 'agent-1',
      channelType: 'twilio_sms',
      externalIdentifier: '+15559876543',
      credentials: {
        account_sid: 'AC1234567890abcdef1234567890abcdef',
        auth_token: 'test_auth_token_secret_123',
      },
      config: {
        from_number: '+15559876543',
      },
      status: 'active',
    });
    mocks.resolveSession.mockResolvedValue({
      channelSessionId: 'channel-session-1',
      sessionId: 'runtime-1',
      isNew: false,
    });
    mocks.executeMessage.mockResolvedValue({
      response: 'Agent reply',
      metadata: {},
    });
    mocks.getSession.mockReturnValue(mocks.runtimeSession);
    mocks.rehydrateSession.mockResolvedValue(mocks.runtimeSession);
    mocks.acquireSessionLock.mockResolvedValue(true);
    mocks.releaseSessionLock.mockResolvedValue(undefined);
    mocks.downloadTwilioMedia
      .mockResolvedValueOnce({
        success: true,
        stream: Readable.from(Buffer.from('image-data')),
        filename: 'twilio_mms_0_123.jpeg',
        mimeType: 'image/jpeg',
        sizeBytes: 2048,
      })
      .mockResolvedValueOnce({
        success: true,
        stream: Readable.from(Buffer.from('pdf-data')),
        filename: 'twilio_mms_1_123.pdf',
        mimeType: 'application/pdf',
        sizeBytes: 4096,
      });
    mocks.uploadAttachment
      .mockResolvedValueOnce({
        success: true,
        attachmentId: 'att-twilio-1',
        status: 'pending',
      })
      .mockResolvedValueOnce({
        success: true,
        attachmentId: 'att-twilio-2',
        status: 'pending',
      });
    mocks.sendResponse.mockResolvedValue({
      success: true,
      deliveryId: 'SM-outbound-123',
    });
  });

  it('processes Twilio MMS attachments and passes attachmentIds into execution before sending the SMS reply', async () => {
    const { startInboundWorker, stopInboundWorker } =
      await import('../services/queues/inbound-worker.js');

    try {
      await startInboundWorker();
      const processor = mocks.workerProcessor as ((job: any) => Promise<void>) | null;
      expect(processor).toEqual(expect.any(Function));

      const twilioMediaReferences = [
        {
          url: 'https://api.twilio.com/2010-04-01/Accounts/AC123/Messages/SM123/Media/ME001',
          contentType: 'image/jpeg',
          index: 0,
        },
        {
          url: 'https://api.twilio.com/2010-04-01/Accounts/AC123/Messages/SM123/Media/ME002',
          contentType: 'application/pdf',
          index: 1,
        },
      ];

      const payload = {
        connectionId: 'conn-twilio-1',
        tenantId: 'tenant-1',
        projectId: 'project-1',
        agentId: 'agent-1',
        channelType: 'twilio_sms' as const,
        message: {
          externalMessageId: 'SM1234567890abcdef1234567890abcdef',
          externalSessionKey: 'twilio_sms:+15559876543:+15551234567',
          text: '',
          metadata: {
            twilioFrom: '+15551234567',
            twilioTo: '+15559876543',
            twilioMediaReferences,
          },
          timestamp: new Date('2026-03-06T00:00:00.000Z'),
        },
        subscriptionId: '',
        idempotencyKey: 'SM1234567890abcdef1234567890abcdef',
      };

      await expect(
        processor?.({
          id: 'job-twilio-1',
          attemptsMade: 0,
          data: payload,
        }),
      ).resolves.toBeUndefined();

      expect(mocks.downloadTwilioMedia).toHaveBeenCalledTimes(2);
      expect(mocks.downloadTwilioMedia).toHaveBeenNthCalledWith(1, twilioMediaReferences[0], {
        accountSid: 'AC1234567890abcdef1234567890abcdef',
        authToken: 'test_auth_token_secret_123',
        apiBaseUrl: 'https://api.twilio.com/2010-04-01',
      });
      expect(mocks.downloadTwilioMedia).toHaveBeenNthCalledWith(2, twilioMediaReferences[1], {
        accountSid: 'AC1234567890abcdef1234567890abcdef',
        authToken: 'test_auth_token_secret_123',
        apiBaseUrl: 'https://api.twilio.com/2010-04-01',
      });

      expect(mocks.uploadAttachment).toHaveBeenCalledTimes(2);
      expect(mocks.executeMessage).toHaveBeenCalledTimes(1);
      expect(mocks.executeMessage).toHaveBeenCalledWith(
        'runtime-1',
        '',
        expect.any(Function),
        expect.any(Function),
        expect.objectContaining({
          attachmentIds: ['att-twilio-1', 'att-twilio-2'],
          sessionLocator: {
            kind: 'production',
            projectId: 'project-1',
            sessionId: 'runtime-1',
            tenantId: 'tenant-1',
          },
          signal: expect.any(AbortSignal),
        }),
      );

      expect(mocks.transformOutput).toHaveBeenCalledWith('Agent reply', undefined, undefined);
      expect(mocks.sendResponse).toHaveBeenCalledTimes(1);
      expect(mocks.sendResponse).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionId: 'runtime-1',
          text: 'Agent reply',
          eventType: 'agent.response',
          metadata: expect.objectContaining({
            twilioFrom: '+15551234567',
            twilioTo: '+15559876543',
            channelOutput: { kind: 'text', text: 'Agent reply' },
          }),
        }),
        expect.objectContaining({
          channelType: 'twilio_sms',
          externalIdentifier: '+15559876543',
        }),
      );
    } finally {
      await stopInboundWorker();
    }
  });
});
