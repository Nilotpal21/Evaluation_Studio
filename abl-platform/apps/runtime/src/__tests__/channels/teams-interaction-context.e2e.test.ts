import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { exportJWK, generateKeyPair, SignJWT, type JWK, type KeyLike } from 'jose';
import { EventEmitter } from 'events';
import { createRequire, syncBuiltinESMExports } from 'module';
import { PassThrough } from 'stream';
import authRouter from '../../routes/auth.js';
import platformAdminTenantsRouter from '../../routes/platform-admin-tenants.js';
import platformAdminModelsRouter from '../../routes/platform-admin-models.js';
import projectIoRouter from '../../routes/project-io.js';
import channelConnectionsRouter from '../../routes/channel-connections.js';
import channelWebhooksRouter from '../../routes/channel-webhooks.js';
import { clearPermissionCache } from '../../services/permission-resolution.js';
import { clearBotFrameworkTokenCache } from '../../channels/adapters/msteams-auth.js';
import { disconnectRedis, initializeRedis } from '../../services/redis/redis-client.js';
import { startChannelQueues, stopChannelQueues } from '../../services/queues/index.js';
import { startRuntimeApiHarness, type RuntimeApiHarness } from '../helpers/runtime-api-harness.js';
import {
  bootstrapProject,
  createChannelConnection,
  importProjectFiles,
  provisionTenantModel,
  setSuperAdmins,
  uniqueEmail,
  uniqueSlug,
} from '../helpers/channel-e2e-bootstrap.js';
import {
  isRedisServerHarnessAvailable,
  startRedisServerHarness,
  type RedisServerHarness,
} from '../helpers/redis-server-harness.js';
import { startMockLLM } from '../../../../../tools/agents/e2e-functional/mock-llm-server.js';
import type { MockLLM } from '../../../../../tools/agents/e2e-functional/types.js';
import {
  extractRuntimeInteractionBlock,
  getSystemPromptForLastUserMessage,
} from '../helpers/mock-llm-request-utils.js';

const TEAMS_REASONING_AGENT_DSL = `
AGENT: Teams_Interaction_Context_Reasoner

GOAL: "Answer briefly while respecting the current Teams interaction context"

PERSONA: "A concise assistant"
`;

const TEAMS_TENANT_ID = 'teams-test-tenant';
const TEAMS_SERVICE_URL = 'https://smba.trafficmanager.net/amer/';
const TEAMS_JWKS_PATH = '/v1/.well-known/keys';
const require = createRequire(import.meta.url);
const httpsModule: typeof import('https') = require('node:https');

type TeamsActivity = {
  type: string;
  id: string;
  timestamp: string;
  serviceUrl: string;
  channelId: string;
  from: { id: string; name: string };
  conversation: { id: string; conversationType: string; tenantId: string };
  recipient: { id: string; name: string };
  text: string;
  locale: string;
};

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

async function createTeamsJwt(params: {
  privateKey: KeyLike;
  kid: string;
  appId: string;
  serviceUrl: string;
}): Promise<string> {
  return new SignJWT({
    serviceurl: params.serviceUrl,
  })
    .setProtectedHeader({ alg: 'RS256', kid: params.kid, typ: 'JWT' })
    .setIssuer('https://api.botframework.com')
    .setAudience(params.appId)
    .setIssuedAt()
    .setExpirationTime('5m')
    .sign(params.privateKey);
}

const describeTeamsInteractionContext = isRedisServerHarnessAvailable()
  ? describe.sequential
  : describe.skip;

describeTeamsInteractionContext('Teams interaction context E2E', () => {
  let harness!: RuntimeApiHarness;
  let redis!: RedisServerHarness;
  let mockLlm!: MockLLM;
  let teamsSigningKey!: KeyLike;
  let teamsJwk!: JWK;
  let originalFetch!: typeof globalThis.fetch;
  let originalHttpsGet!: typeof httpsModule.get;
  const teamsJwkKid = 'teams-test-key';
  const mockedHttpResponses = new Map<string, { status: number; body: unknown }>();

  beforeAll(async () => {
    const keyPair = await generateKeyPair('RS256');
    teamsSigningKey = keyPair.privateKey;
    teamsJwk = await exportJWK(keyPair.publicKey);
    teamsJwk.alg = 'RS256';
    teamsJwk.use = 'sig';
    teamsJwk.kid = teamsJwkKid;

    originalFetch = globalThis.fetch;
    originalHttpsGet = httpsModule.get;
    httpsModule.get = ((url, options, callback) => {
      const href =
        typeof url === 'string'
          ? url
          : url instanceof URL
            ? url.toString()
            : url?.href || `${url?.protocol || 'https:'}//${url?.host || ''}${url?.path || ''}`;

      if (href === `https://login.botframework.com${TEAMS_JWKS_PATH}`) {
        const request = new EventEmitter() as EventEmitter & {
          destroy: () => void;
          end: () => typeof request;
        };
        const response = new PassThrough() as PassThrough & { statusCode?: number };
        response.statusCode = 200;

        request.destroy = () => undefined;
        request.end = () => request;

        queueMicrotask(() => {
          response.end(JSON.stringify({ keys: [teamsJwk] }));
          const handler = typeof options === 'function' ? options : callback;
          handler?.(response as any);
          request.emit('response', response);
        });

        return request as any;
      }

      return originalHttpsGet(url as any, options as any, callback as any);
    }) as typeof httpsModule.get;
    syncBuiltinESMExports();

    globalThis.fetch = async (input, init) => {
      const url =
        typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;

      if (url === `https://login.botframework.com${TEAMS_JWKS_PATH}`) {
        return new Response(JSON.stringify({ keys: [teamsJwk] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      if (url === `https://login.microsoftonline.com/${TEAMS_TENANT_ID}/oauth2/v2.0/token`) {
        return new Response(
          JSON.stringify({
            access_token: 'teams-access-token',
            expires_in: 3600,
            token_type: 'Bearer',
          }),
          {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          },
        );
      }

      const mockedResponse = mockedHttpResponses.get(url);
      if (mockedResponse) {
        return new Response(JSON.stringify(mockedResponse.body), {
          status: mockedResponse.status,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      return originalFetch(input, init);
    };

    mockLlm = await startMockLLM();
    redis = await startRedisServerHarness();
    harness = await startRuntimeApiHarness(
      (app) => {
        app.use('/api/auth', authRouter);
        app.use('/api/platform/admin/tenants', platformAdminTenantsRouter);
        app.use('/api/platform/admin/tenant-models', platformAdminModelsRouter);
        app.use('/api/projects/:projectId/project-io', projectIoRouter);
        app.use('/api/projects/:projectId/channel-connections', channelConnectionsRouter);
        app.use('/api/v1/channels', channelWebhooksRouter);
      },
      {
        REDIS_ENABLED: 'true',
        REDIS_URL: redis.url,
      },
      {
        requireAsyncInfra: false,
      },
    );

    await initializeRedis();
    await startChannelQueues();
  }, 120_000);

  beforeEach(async () => {
    clearPermissionCache();
    clearBotFrameworkTokenCache();
    mockedHttpResponses.clear();
    await harness.resetRuntimeState();
    await redis.clear();
    await setSuperAdmins([]);
    mockLlm.reset();
  });

  afterAll(async () => {
    clearBotFrameworkTokenCache();
    await stopChannelQueues();
    await disconnectRedis();
    if (harness) {
      await harness.close();
    }
    if (mockLlm) {
      await mockLlm.close();
    }
    if (redis) {
      await redis.close();
    }
    httpsModule.get = originalHttpsGet;
    syncBuiltinESMExports();
    globalThis.fetch = originalFetch;
  }, 120_000);

  test('preserves Teams locale through public webhook ingress into the canonical prompt context', async () => {
    const admin = await bootstrapProject(
      harness,
      uniqueEmail('teams-interaction-admin'),
      uniqueSlug('tenant-teams-interaction'),
      uniqueSlug('project-teams-interaction'),
    );

    await importProjectFiles(harness, admin.token, admin.projectId, {
      'agents/teams-interaction-context-reasoner.agent.abl': TEAMS_REASONING_AGENT_DSL,
    });

    await provisionTenantModel(harness, admin.token, {
      targetTenantId: admin.tenantId,
      displayName: 'Mock Teams Interaction Model',
      integrationType: 'api',
      provider: 'openai_compatible',
      modelId: 'mock-teams-interaction-model',
      endpointUrl: mockLlm.url,
      supportsStreaming: false,
      supportsTools: true,
      capabilities: ['text', 'tools'],
      tier: 'balanced',
      isDefault: true,
      connection: {
        credentialName: 'mock-teams-interaction-model',
        apiKey: 'test-api-key',
      },
    });

    const appId = uniqueSlug('teams-bot-app');
    await createChannelConnection(harness, admin.token, admin.projectId, {
      channel_type: 'msteams',
      display_name: 'Teams Interaction Context',
      external_identifier: appId,
      credentials: {
        app_id: appId,
        client_secret: 'teams-client-secret',
        tenant_id: TEAMS_TENANT_ID,
      },
    });

    const conversationId = uniqueSlug('teams-conversation');
    const activityId = uniqueSlug('teams-activity');
    mockedHttpResponses.set(
      `https://smba.trafficmanager.net/amer/v3/conversations/${conversationId}/activities/${activityId}`,
      {
        status: 200,
        body: { id: 'teams-reply-1' },
      },
    );
    mockedHttpResponses.set(
      `https://smba.trafficmanager.net/amer/v3/conversations/${conversationId}/activities`,
      {
        status: 200,
        body: { id: 'teams-typing-1' },
      },
    );

    const activity: TeamsActivity = {
      type: 'message',
      id: activityId,
      timestamp: new Date().toISOString(),
      serviceUrl: TEAMS_SERVICE_URL,
      channelId: 'msteams',
      from: { id: 'teams-user-1', name: 'Marie' },
      conversation: {
        id: conversationId,
        conversationType: 'personal',
        tenantId: 'teams-workspace-tenant',
      },
      recipient: {
        id: `28:${appId}`,
        name: 'Teams Test Bot',
      },
      text: 'bonjour teams locale',
      locale: 'fr-FR',
    };

    const token = await createTeamsJwt({
      privateKey: teamsSigningKey,
      kid: teamsJwkKid,
      appId,
      serviceUrl: TEAMS_SERVICE_URL,
    });

    const response = await fetch(
      `${harness.baseUrl}/api/v1/channels/msteams/webhook/${encodeURIComponent(appId)}`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(activity),
      },
    );

    expect(response.status).toBe(200);

    const systemPrompt = await waitFor('Teams runtime interaction prompt', async () => {
      const prompt = getSystemPromptForLastUserMessage(mockLlm, 'bonjour teams locale');
      return prompt.length > 0 ? prompt : null;
    });

    const runtimeInteraction = extractRuntimeInteractionBlock(systemPrompt);

    expect(runtimeInteraction).toContain('"language": "fr"');
    expect(runtimeInteraction).toContain('"locale": "fr-FR"');
  }, 90_000);

  test('returns 404 for an unknown Teams webhook identifier without leaking configuration', async () => {
    const payload: TeamsActivity = {
      type: 'message',
      id: uniqueSlug('teams-unknown-activity'),
      timestamp: new Date().toISOString(),
      serviceUrl: TEAMS_SERVICE_URL,
      channelId: 'msteams',
      from: { id: 'teams-user-2', name: 'Unknown User' },
      conversation: {
        id: uniqueSlug('teams-unknown-conversation'),
        conversationType: 'personal',
        tenantId: 'teams-workspace-tenant',
      },
      recipient: {
        id: '28:unknown-bot',
        name: 'Unknown Bot',
      },
      text: 'hello unknown teams',
      locale: 'en-US',
    };

    const token = await createTeamsJwt({
      privateKey: teamsSigningKey,
      kid: teamsJwkKid,
      appId: 'unknown-bot',
      serviceUrl: TEAMS_SERVICE_URL,
    });

    const response = await fetch(
      `${harness.baseUrl}/api/v1/channels/msteams/webhook/${encodeURIComponent('unknown-bot')}`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
      },
    );

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({
      error: 'Channel not configured for this workspace',
    });
  }, 90_000);
});
