import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import Redis from 'ioredis';
import { isRedisServerHarnessAvailable } from './helpers/redis-server-harness.js';
import { AgentTransferConfigSchema } from '@agent-platform/agent-transfer';
import type {
  AnyPlatformEvent,
  EventBus,
  PlatformEvent,
  SessionEndedPayload,
} from '../services/event-bus/types.js';
import { clearPermissionCache } from '../services/permission-resolution.js';
import {
  getRuntimeEventBus,
  setRuntimeEventBus,
} from '../services/event-bus/runtime-bus-accessor.js';
import {
  getTransferSessionStore,
  initializeAgentTransfer,
  shutdownAgentTransfer,
} from '../services/agent-transfer/index.js';
import {
  startRuntimeServerHarness,
  type RuntimeApiHarness,
} from './helpers/runtime-api-harness.js';
import {
  startRedisServerHarness,
  type RedisServerHarness,
} from './helpers/redis-server-harness.js';
import {
  authHeaders,
  bootstrapProject,
  importProjectFiles,
  provisionTenantModel,
  requestJson,
  setSuperAdmins,
  uniqueEmail,
  uniqueSlug,
  type BootstrapProjectResult,
} from './helpers/channel-e2e-bootstrap.js';
import { startMockLLM } from '../../../../tools/agents/e2e-functional/mock-llm-server.js';
import type { MockLLM } from '../../../../tools/agents/e2e-functional/types.js';

const TIMEOUT_MS = 120_000;

const SIMPLE_AGENT_DSL = `AGENT: Transfer_End_Agent

GOAL: "Answer user questions conversationally"

PERSONA: "Helpful assistant"
`;

type SessionEndedEvent = PlatformEvent<'session.ended', SessionEndedPayload>;

interface ChatAgentResponse {
  sessionId: string;
  response: string;
}

interface SessionListResponse {
  success: boolean;
  sessions: Array<{
    id: string;
    status: string;
    disposition: string | null;
  }>;
}

function makeCollectorBus(events: AnyPlatformEvent[]): EventBus {
  return {
    emit(event) {
      events.push(event);
    },
    subscribe() {
      /* no-op */
    },
    unsubscribe() {
      /* no-op */
    },
    async shutdown() {
      /* no-op */
    },
  };
}

describe.skipIf(!isRedisServerHarnessAvailable())(
  'Agent Transfer Session Terminalization E2E',
  () => {
    let harness: RuntimeApiHarness | undefined;
    let mockLlm: MockLLM | undefined;
    let redisHarness: RedisServerHarness | undefined;
    let redisClient: Redis | undefined;
    let previousBus: EventBus | null = null;
    let capturedEvents: AnyPlatformEvent[] = [];

    beforeAll(async () => {
      redisHarness = await startRedisServerHarness();
      mockLlm = await startMockLLM();
      harness = await startRuntimeServerHarness({
        SESSION_TERMINALIZATION_ENABLED: 'true',
      });

      redisClient = new Redis(redisHarness.url, {
        lazyConnect: true,
        maxRetriesPerRequest: 1,
        enableOfflineQueue: false,
        retryStrategy: null,
      });
      await redisClient.connect();
      await initializeAgentTransfer(redisClient, AgentTransferConfigSchema.parse({}));
    }, TIMEOUT_MS);

    beforeEach(async () => {
      clearPermissionCache();
      await harness.resetRuntimeState();
      await redisHarness.clear();
      capturedEvents = [];
      previousBus = getRuntimeEventBus();
      setRuntimeEventBus(makeCollectorBus(capturedEvents));
      mockLlm.reset();
      mockLlm.register('', { content: 'Default transfer-end reply.' });
    });

    afterEach(() => {
      setRuntimeEventBus(previousBus);
    });

    afterAll(async () => {
      await shutdownAgentTransfer();
      if (redisClient) {
        await redisClient.quit().catch(async () => {
          redisClient?.disconnect();
        });
      }
      await redisHarness?.close();
      await harness?.close();
      await mockLlm?.close();
    }, TIMEOUT_MS);

    async function setupProject(prefix: string): Promise<BootstrapProjectResult> {
      const admin = await bootstrapProject(
        harness,
        uniqueEmail(`at-terminalize-e2e-${prefix}`),
        uniqueSlug(`at-terminalize-e2e-tenant-${prefix}`),
        uniqueSlug(`at-terminalize-e2e-project-${prefix}`),
      );

      await importProjectFiles(harness, admin.token, admin.projectId, {
        'agents/transfer-end.agent.abl': SIMPLE_AGENT_DSL,
      });

      await provisionTenantModel(harness, admin.token, {
        targetTenantId: admin.tenantId,
        displayName: `Mock Transfer Terminalization Model ${prefix}`,
        integrationType: 'api',
        provider: 'openai_compatible',
        modelId: 'mock-model',
        endpointUrl: mockLlm.url,
        supportsStreaming: false,
        supportsTools: false,
        capabilities: ['text'],
        tier: 'balanced',
        isDefault: true,
        connection: {
          credentialName: `mock-transfer-terminalization-model-${prefix}`,
          apiKey: 'test-api-key',
        },
      });

      await setSuperAdmins([admin.userId]);
      return admin;
    }

    test('ending a transfer session can complete the live parent conversation through the shared terminalization service', async () => {
      const admin = await setupProject('happy');
      mockLlm.register('Hello transfer end', {
        content: 'Hello from the transfer-end agent.',
      });

      const chatRes = await requestJson<ChatAgentResponse>(harness, '/api/v1/chat/agent', {
        method: 'POST',
        headers: authHeaders(admin.token),
        body: {
          projectId: admin.projectId,
          message: 'Hello transfer end',
        },
      });

      expect(chatRes.status).toBe(200);
      expect(chatRes.body.sessionId).toBeTruthy();

      const store = getTransferSessionStore();
      expect(store).not.toBeNull();
      const created = await store!.create({
        tenantId: admin.tenantId,
        projectId: admin.projectId,
        contactId: 'contact-transfer-1',
        channel: 'chat',
        provider: 'kore',
        providerSessionId: 'provider-session-1',
        ownerPod: 'e2e-test',
        metadata: {
          postAgentAction: 'end',
          conversationSessionId: chatRes.body.sessionId,
        },
      });

      expect(created.success).toBe(true);
      expect(created.sessionKey).toBeTruthy();

      const endRes = await requestJson<{ success: boolean; data: null }>(
        harness,
        `/api/v1/agent-transfer/sessions/${encodeURIComponent(created.sessionKey!)}/end`,
        {
          method: 'POST',
          headers: {
            ...authHeaders(admin.token),
            'X-Project-Id': admin.projectId,
          },
          body: {
            reason: 'completed',
            dispositionCode: 'resolved',
            wrapUpNotes: 'Customer confirmed the fix.',
          },
        },
      );

      expect(endRes.status).toBe(200);
      expect(endRes.body.success).toBe(true);

      const listRes = await requestJson<SessionListResponse>(
        harness,
        `/api/projects/${admin.projectId}/sessions?limit=20`,
        {
          headers: authHeaders(admin.token),
        },
      );

      expect(listRes.status).toBe(200);
      const session = listRes.body.sessions.find((entry) => entry.id === chatRes.body.sessionId);
      expect(session).toMatchObject({
        id: chatRes.body.sessionId,
        status: 'completed',
        disposition: 'completed',
      });

      const sessionEndedEvents = capturedEvents.filter(
        (event): event is SessionEndedEvent => event.type === 'session.ended',
      );

      expect(sessionEndedEvents).toHaveLength(1);
      expect(sessionEndedEvents[0]).toMatchObject({
        type: 'session.ended',
        tenantId: admin.tenantId,
        projectId: admin.projectId,
        sessionId: chatRes.body.sessionId,
        payload: {
          reason: 'completed',
          disposition: 'completed',
          status: 'completed',
          terminalSource: 'transfer_end',
        },
      });
      expect(
        capturedEvents.find((event) => event.type === 'billing.usage.updated'),
      ).toBeUndefined();
    });
  },
);
