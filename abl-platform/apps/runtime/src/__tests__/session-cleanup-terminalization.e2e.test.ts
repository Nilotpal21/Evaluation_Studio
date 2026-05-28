import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { MongoMemoryServer } from 'mongodb-memory-server';
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
  startRuntimeServerHarness,
  type RuntimeApiHarness,
} from './helpers/runtime-api-harness.js';
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

const TIMEOUT_MS = 150_000;
const MONGOMS_VERSION = process.env.MONGOMS_VERSION || '7.0.20';
const MONGOMS_LAUNCH_TIMEOUT_MS = 120_000;

const SIMPLE_AGENT_DSL = `AGENT: Simple_Chat_Agent

GOAL: "Answer user questions conversationally"

PERSONA: "Helpful assistant"

EXECUTION:
  session_idle_timeout: 1000
`;

type SessionEndedEvent = PlatformEvent<'session.ended', SessionEndedPayload>;

interface ChatAgentResponse {
  sessionId: string;
  response: string;
}

interface SessionDetailResponse {
  success: boolean;
  session: {
    id: string;
    status?: string;
  };
}

interface EffectiveLifecycleResponse {
  success: boolean;
  data: {
    runtime: {
      idleSeconds: { value?: number; source?: string };
      maxAgeSeconds: { value?: number; source?: string };
    };
  };
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

async function waitForEventTypeCount(
  events: AnyPlatformEvent[],
  type: string,
  expectedCount: number,
  timeoutMs = 15_000,
): Promise<void> {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    if (events.filter((event) => event.type === type).length >= expectedCount) {
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  throw new Error(`Timed out waiting for ${expectedCount} ${type} events`);
}

async function waitForTerminalSession(
  harness: RuntimeApiHarness,
  token: string,
  projectId: string,
  sessionId: string,
  timeoutMs = 80_000,
): Promise<SessionDetailResponse['session']> {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    const response = await requestJson<SessionDetailResponse>(
      harness,
      `/api/projects/${projectId}/sessions/${sessionId}?includeTraces=false`,
      {
        headers: authHeaders(token),
      },
    );

    expect(response.status).toBe(200);
    if (response.body.session.status === 'abandoned') {
      return response.body.session;
    }

    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }

  throw new Error(`Timed out waiting for cleanup to terminalize session ${sessionId}`);
}

describe('Session Cleanup Terminalization E2E', () => {
  let harness: RuntimeApiHarness;
  let mockLlm: MockLLM;
  let mongod: MongoMemoryServer | null = null;
  let previousBus: EventBus | null = null;
  let capturedEvents: AnyPlatformEvent[] = [];

  beforeAll(async () => {
    mockLlm = await startMockLLM();
    mongod = await MongoMemoryServer.create({
      binary: { version: MONGOMS_VERSION },
      instance: { launchTimeout: MONGOMS_LAUNCH_TIMEOUT_MS },
    });
    harness = await startRuntimeServerHarness(
      {
        SESSION_TERMINALIZATION_ENABLED: 'true',
        SESSION_CLEANUP_TTL_HOURS: '0',
        MESSAGE_CLEANUP_TTL_HOURS: '0',
        CLEANUP_INTERVAL_MINUTES: '60',
        SESSION_TIMEOUT_SWEEP_ENABLED: 'true',
        SESSION_TIMEOUT_SWEEP_INTERVAL_MINUTES: '1',
      },
      {
        bootstrapServer: true,
        mongoUri: mongod.getUri(),
      },
    );
  }, TIMEOUT_MS);

  beforeEach(async () => {
    clearPermissionCache();
    await harness.resetRuntimeState();
    capturedEvents = [];
    previousBus = getRuntimeEventBus();
    setRuntimeEventBus(makeCollectorBus(capturedEvents));
    mockLlm.reset();
    mockLlm.register('', { content: 'Default cleanup response.' });
  });

  afterEach(() => {
    setRuntimeEventBus(previousBus);
  });

  afterAll(async () => {
    if (harness) {
      await harness.close();
    }
    await mockLlm.close();
    if (mongod) {
      await mongod.stop();
      mongod = null;
    }
  }, TIMEOUT_MS);

  async function setupProject(prefix: string): Promise<BootstrapProjectResult> {
    const admin = await bootstrapProject(
      harness,
      uniqueEmail(`cleanup-e2e-${prefix}`),
      uniqueSlug(`cleanup-e2e-tenant-${prefix}`),
      uniqueSlug(`cleanup-e2e-project-${prefix}`),
    );

    await importProjectFiles(harness, admin.token, admin.projectId, {
      'agents/simple-chat.agent.abl': SIMPLE_AGENT_DSL,
    });

    await provisionTenantModel(harness, admin.token, {
      targetTenantId: admin.tenantId,
      displayName: `Mock Cleanup Model ${prefix}`,
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
        credentialName: `mock-cleanup-model-${prefix}`,
        apiKey: 'test-api-key',
      },
    });

    await setSuperAdmins([admin.userId]);
    return admin;
  }

  test(
    'agent runtime override drives cleanup terminalization and emits one canonical event',
    async () => {
      const admin = await setupProject('agent-override');
      mockLlm.register('Cleanup should end this session', {
        content: 'This session will be cleaned up shortly.',
      });

      const effectiveRes = await requestJson<EffectiveLifecycleResponse>(
        harness,
        `/api/projects/${admin.projectId}/session-lifecycle/effective?channel=api&agentName=Simple_Chat_Agent`,
        {
          headers: authHeaders(admin.token),
        },
      );

      expect(effectiveRes.status).toBe(200);
      expect(effectiveRes.body.data.runtime.idleSeconds).toEqual({
        value: 1,
        source: 'agent',
      });
      expect(effectiveRes.body.data.runtime.maxAgeSeconds).toEqual({
        value: 28800,
        source: 'tenant',
      });

      const chatRes = await requestJson<ChatAgentResponse>(harness, '/api/v1/chat/agent', {
        method: 'POST',
        headers: authHeaders(admin.token),
        body: {
          projectId: admin.projectId,
          message: 'Cleanup should end this session',
        },
      });

      expect(chatRes.status).toBe(200);
      expect(chatRes.body.sessionId).toBeTruthy();

      const terminalSession = await waitForTerminalSession(
        harness,
        admin.token,
        admin.projectId,
        chatRes.body.sessionId,
      );

      expect(terminalSession).toMatchObject({
        id: chatRes.body.sessionId,
        status: 'abandoned',
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
          disposition: 'timeout',
          status: 'abandoned',
          terminalSource: 'cleanup',
        },
      });
    },
    TIMEOUT_MS,
  );
});
