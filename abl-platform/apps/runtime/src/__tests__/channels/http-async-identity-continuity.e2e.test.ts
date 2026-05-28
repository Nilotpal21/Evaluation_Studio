import http from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import authRouter from '../../routes/auth.js';
import platformAdminTenantsRouter from '../../routes/platform-admin-tenants.js';
import projectIoRouter from '../../routes/project-io.js';
import channelConnectionsRouter from '../../routes/channel-connections.js';
import httpAsyncChannelRouter from '../../routes/http-async-channel.js';
import sessionsRouter from '../../routes/sessions.js';
import platformAdminTracesRouter from '../../routes/platform-admin-traces.js';
import { clearPermissionCache } from '../../services/permission-resolution.js';
import { disconnectRedis, initializeRedis } from '../../services/redis/redis-client.js';
import { ensureSessionService, resetSessionService } from '../../services/session/index.js';
import { startChannelQueues, stopChannelQueues } from '../../services/queues/index.js';
import { startRuntimeApiHarness, type RuntimeApiHarness } from '../helpers/runtime-api-harness.js';
import {
  authHeaders,
  bootstrapProject,
  importProjectFiles,
  requestJson,
  setSuperAdmins,
  uniqueEmail,
  uniqueSlug,
} from '../helpers/channel-e2e-bootstrap.js';
import {
  isRedisServerHarnessAvailable,
  startRedisServerHarness,
  type RedisServerHarness,
} from '../helpers/redis-server-harness.js';

const HTTP_ASYNC_E2E_TIMEOUT_MS = 90_000;

const HTTP_ASYNC_AGENT_DSL = `
AGENT: Http_Async_Identity_Agent
GOAL: "Handle async channel messages"
PERSONA: "Helpful"

FLOW:
  entry_point: reply
  steps:
    - reply

reply:
  REASONING: false
  RESPOND: "Async response received."
  THEN: COMPLETE
`;

interface ChannelAdmin {
  token: string;
  userId: string;
  tenantId: string;
  projectId: string;
}

interface HttpAsyncSetup {
  admin: ChannelAdmin;
  subscriptionId: string;
  connectionId: string;
}

interface HttpAsyncDeliveryPayload {
  message_id: string;
  session_key: string;
  response: string;
  outcome?: {
    status: string;
    code?: string;
  };
  trace_context?: {
    session_id: string;
    delivery: string;
  };
  session_id: string;
  is_new_session: boolean;
}

interface CallbackHarness {
  baseUrl: string;
  getDeliveries(): HttpAsyncDeliveryPayload[];
  reset(): void;
  close(): Promise<void>;
}

async function waitFor<T>(
  label: string,
  getValue: () => Promise<T | null | undefined> | T | null | undefined,
  timeoutMs = 15_000,
  intervalMs = 100,
): Promise<T> {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    const value = await getValue();
    if (value !== null && value !== undefined) {
      return value;
    }

    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }

  throw new Error(`Timed out waiting for ${label}`);
}

async function startCallbackHarness(): Promise<CallbackHarness> {
  const app = express();
  app.use(express.json());

  const deliveries: HttpAsyncDeliveryPayload[] = [];

  app.post('/callback', (req, res) => {
    deliveries.push(req.body as HttpAsyncDeliveryPayload);
    res.status(200).json({ ok: true });
  });

  const server = http.createServer(app);

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
  const baseUrl = `http://127.0.0.1:${address.port}`;

  return {
    baseUrl,
    getDeliveries: () => [...deliveries],
    reset: () => {
      deliveries.length = 0;
    },
    async close() {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
    },
  };
}

const describeHttpAsyncIdentityContinuity = isRedisServerHarnessAvailable()
  ? describe.sequential
  : describe.skip;

describeHttpAsyncIdentityContinuity('HTTP async identity continuity E2E', () => {
  let harness: RuntimeApiHarness | undefined;
  let redis: RedisServerHarness | undefined;
  let callbackHarness: CallbackHarness | undefined;

  beforeAll(async () => {
    redis = await startRedisServerHarness();
    callbackHarness = await startCallbackHarness();

    harness = await startRuntimeApiHarness(
      (app) => {
        app.use('/api/auth', authRouter);
        app.use('/api/platform/admin/tenants', platformAdminTenantsRouter);
        app.use('/api/platform/admin/traces', platformAdminTracesRouter);
        app.use('/api/projects/:projectId/project-io', projectIoRouter);
        app.use('/api/projects/:projectId/channel-connections', channelConnectionsRouter);
        app.use('/api/projects/:projectId/sessions', sessionsRouter);
        app.use('/api/v1/channels/http-async', httpAsyncChannelRouter);
      },
      {
        REDIS_ENABLED: 'true',
        REDIS_URL: redis.url,
      },
    );

    await initializeRedis();
    resetSessionService();
    await ensureSessionService(
      { store: 'redis', coldStorageEnabled: false },
      { allowFallbackToMemory: false },
    );
    await startChannelQueues();
  });

  beforeEach(async () => {
    clearPermissionCache();
    await harness?.resetRuntimeState();
    await redis?.clear();
    callbackHarness?.reset();
    await setSuperAdmins([]);
  });

  afterAll(async () => {
    await stopChannelQueues();
    if (harness) await harness.close();
    resetSessionService();
    await disconnectRedis();
    if (callbackHarness) await callbackHarness.close();
    if (redis) await redis.close();
  });

  async function setupHttpAsyncChannel(options?: {
    providerVerificationStrength?: 'strong';
  }): Promise<HttpAsyncSetup> {
    const admin = await bootstrapProject(
      harness!,
      uniqueEmail('http-async-admin'),
      uniqueSlug('tenant-http-async'),
      uniqueSlug('project-http-async'),
    );

    await importProjectFiles(harness!, admin.token, admin.projectId, {
      'agents/http-async.agent.abl': HTTP_ASYNC_AGENT_DSL,
    });

    const subscribeResponse = await requestJson<{
      subscription_id: string;
      callback_url: string;
      status: string;
    }>(harness!, '/api/v1/channels/http-async/subscribe', {
      method: 'POST',
      headers: authHeaders(admin.token),
      body: {
        callback_url: `${callbackHarness!.baseUrl}/callback`,
        project_id: admin.projectId,
        agent_id: 'Http_Async_Identity_Agent',
      },
    });

    expect(subscribeResponse.status).toBe(201);

    const subscriptionsResponse = await requestJson<{
      subscriptions: Array<{
        id: string;
        channelConnectionId: string;
      }>;
    }>(
      harness!,
      `/api/v1/channels/http-async/subscriptions?project_id=${encodeURIComponent(admin.projectId)}`,
      {
        method: 'GET',
        headers: authHeaders(admin.token),
      },
    );

    expect(subscriptionsResponse.status).toBe(200);

    const subscription = subscriptionsResponse.body.subscriptions.find(
      (entry) => entry.id === subscribeResponse.body.subscription_id,
    );
    expect(subscription).toBeDefined();

    if (options?.providerVerificationStrength) {
      const patchResponse = await requestJson<{
        success: boolean;
        connection: {
          identityVerification: {
            providerVerificationStrength: 'weak' | 'strong';
          };
        };
      }>(
        harness!,
        `/api/projects/${admin.projectId}/channel-connections/${subscription!.channelConnectionId}`,
        {
          method: 'PATCH',
          headers: authHeaders(admin.token),
          body: {
            identityVerification: {
              providerVerificationStrength: options.providerVerificationStrength,
            },
          },
        },
      );

      expect(patchResponse.status).toBe(200);
      expect(patchResponse.body.connection.identityVerification).toEqual({
        providerVerificationStrength: options.providerVerificationStrength,
      });
    }

    return {
      admin,
      subscriptionId: subscribeResponse.body.subscription_id,
      connectionId: subscription!.channelConnectionId,
    };
  }

  async function sendHttpAsyncMessage(
    setup: HttpAsyncSetup,
    sessionKey: string,
    metadata: Record<string, unknown>,
  ): Promise<{ session_key: string }> {
    const response = await requestJson<{
      message_id: string;
      session_key: string;
      status: string;
    }>(harness!, '/api/v1/channels/http-async/message', {
      method: 'POST',
      headers: authHeaders(setup.admin.token),
      body: {
        subscription_id: setup.subscriptionId,
        message: 'hello from http async',
        session_key: sessionKey,
        metadata,
      },
    });

    expect(response.status).toBe(202);
    expect(response.body.status).toBe('accepted');
    return response.body;
  }

  async function waitForDelivery(sessionKey: string): Promise<HttpAsyncDeliveryPayload> {
    return waitFor(`HTTP async delivery for ${sessionKey}`, () => {
      const deliveries = callbackHarness!.getDeliveries();
      return deliveries.find((delivery) => delivery.session_key.endsWith(`:${sessionKey}`)) ?? null;
    });
  }

  async function listHttpAsyncSessions(projectId: string, token: string) {
    const response = await requestJson<{
      success: boolean;
      sessions: Array<{ id: string }>;
    }>(harness!, `/api/projects/${projectId}/sessions?channel=http_async`, {
      method: 'GET',
      headers: authHeaders(token),
    });

    expect(response.status).toBe(200);
    return response.body.sessions;
  }

  async function getSessionSummary(sessionId: string, token: string) {
    const response = await requestJson<{
      success: boolean;
      summary: {
        sessionId: string;
        identityTier?: number;
        channel: string;
        tenantId: string;
        projectId: string;
      };
    }>(harness!, `/api/platform/admin/traces/sessions/${encodeURIComponent(sessionId)}/summary`, {
      method: 'GET',
      headers: authHeaders(token),
    });

    expect(response.status).toBe(200);
    expect(response.body.success).toBe(true);
    return response.body.summary;
  }

  test(
    'reuses the same runtime session across new thread keys when a stable provider-verified artifact is supplied',
    async () => {
      const setup = await setupHttpAsyncChannel();
      const metadata = {
        providerVerified: true,
        anonymousId: '+15551234567',
        channelArtifact: '+15551234567',
        channelArtifactType: 'phone',
      };

      await sendHttpAsyncMessage(setup, 'thread-1', metadata);
      const firstDelivery = await waitForDelivery('thread-1');

      expect(firstDelivery.response).toBe('Async response received.');
      expect(firstDelivery.outcome).toEqual(
        expect.objectContaining({
          status: 'ok',
        }),
      );
      expect(firstDelivery.trace_context).toEqual({
        session_id: firstDelivery.session_id,
        delivery: 'correlation_only',
      });

      const firstSummary = await getSessionSummary(firstDelivery.session_id, setup.admin.token);
      expect(firstSummary.identityTier).toBe(1);
      expect(firstSummary.channel).toBe('http_async');

      await sendHttpAsyncMessage(setup, 'thread-2', metadata);
      const secondDelivery = await waitForDelivery('thread-2');

      expect(secondDelivery.session_id).toBe(firstDelivery.session_id);

      const sessions = await waitFor('single http_async session', async () => {
        const listed = await listHttpAsyncSessions(setup.admin.projectId, setup.admin.token);
        return listed.length === 1 ? listed : null;
      });

      expect(sessions).toHaveLength(1);
    },
    HTTP_ASYNC_E2E_TIMEOUT_MS,
  );

  test(
    'promotes provider-verified identities to tier 2 when the channel connection config is strong',
    async () => {
      const setup = await setupHttpAsyncChannel({
        providerVerificationStrength: 'strong',
      });

      await sendHttpAsyncMessage(setup, 'thread-1', {
        providerVerified: true,
        anonymousId: '+15550000001',
        channelArtifact: '+15550000001',
        channelArtifactType: 'phone',
      });

      const delivery = await waitForDelivery('thread-1');
      const summary = await getSessionSummary(delivery.session_id, setup.admin.token);

      expect(summary.identityTier).toBe(2);
    },
    HTTP_ASYNC_E2E_TIMEOUT_MS,
  );

  test(
    'creates distinct runtime sessions for different thread keys when no stable artifact is provided',
    async () => {
      const setup = await setupHttpAsyncChannel();
      const metadata = {
        providerVerified: true,
        anonymousId: 'customer-123',
      };

      await sendHttpAsyncMessage(setup, 'thread-1', metadata);
      const firstDelivery = await waitForDelivery('thread-1');

      await sendHttpAsyncMessage(setup, 'thread-2', metadata);
      const secondDelivery = await waitForDelivery('thread-2');

      expect(secondDelivery.session_id).not.toBe(firstDelivery.session_id);

      const sessions = await waitFor('two http_async sessions', async () => {
        const listed = await listHttpAsyncSessions(setup.admin.projectId, setup.admin.token);
        return listed.length === 2 ? listed : null;
      });

      expect(sessions).toHaveLength(2);
    },
    HTTP_ASYNC_E2E_TIMEOUT_MS,
  );
});
