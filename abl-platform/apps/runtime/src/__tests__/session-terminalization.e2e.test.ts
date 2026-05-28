import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'vitest';
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

const TIMEOUT_MS = 120_000;

const SIMPLE_AGENT_DSL = `AGENT: Simple_Chat_Agent

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
    agentName?: string;
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

async function waitForEventTypeCount(
  events: AnyPlatformEvent[],
  type: string,
  expectedCount: number,
  timeoutMs = 10_000,
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

describe('Session Terminalization E2E', () => {
  let harness: RuntimeApiHarness;
  let mockLlm: MockLLM;
  let previousBus: EventBus | null = null;
  let capturedEvents: AnyPlatformEvent[] = [];

  beforeAll(async () => {
    mockLlm = await startMockLLM();
    harness = await startRuntimeServerHarness({
      SESSION_TERMINALIZATION_ENABLED: 'true',
    });
  }, TIMEOUT_MS);

  beforeEach(async () => {
    clearPermissionCache();
    await harness.resetRuntimeState();
    capturedEvents = [];
    previousBus = getRuntimeEventBus();
    setRuntimeEventBus(makeCollectorBus(capturedEvents));
    mockLlm.reset();
    mockLlm.register('', { content: 'Default terminalization reply.' });
  });

  afterEach(() => {
    setRuntimeEventBus(previousBus);
  });

  afterAll(async () => {
    await harness.close();
    await mockLlm.close();
  }, TIMEOUT_MS);

  async function setupProject(prefix: string): Promise<BootstrapProjectResult> {
    const admin = await bootstrapProject(
      harness,
      uniqueEmail(`terminalize-e2e-${prefix}`),
      uniqueSlug(`terminalize-e2e-tenant-${prefix}`),
      uniqueSlug(`terminalize-e2e-project-${prefix}`),
    );

    await importProjectFiles(harness, admin.token, admin.projectId, {
      'agents/simple-chat.agent.abl': SIMPLE_AGENT_DSL,
    });

    await provisionTenantModel(harness, admin.token, {
      targetTenantId: admin.tenantId,
      displayName: `Mock Terminalization Model ${prefix}`,
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
        credentialName: `mock-terminalization-model-${prefix}`,
        apiKey: 'test-api-key',
      },
    });

    await setSuperAdmins([admin.userId]);
    return admin;
  }

  test('explicit close ends a live conversation session and emits one canonical event', async () => {
    const admin = await setupProject('close');
    mockLlm.register('Hello terminalization', {
      content: 'Hello from the terminalization agent.',
    });

    const chatRes = await requestJson<ChatAgentResponse>(harness, '/api/v1/chat/agent', {
      method: 'POST',
      headers: authHeaders(admin.token),
      body: {
        projectId: admin.projectId,
        message: 'Hello terminalization',
      },
    });

    expect(chatRes.status).toBe(200);
    expect(chatRes.body.sessionId).toBeTruthy();

    const closeRes = await requestJson<{
      success: boolean;
      status: string;
      disposition: string;
    }>(harness, `/api/projects/${admin.projectId}/sessions/${chatRes.body.sessionId}/close`, {
      method: 'POST',
      headers: authHeaders(admin.token),
      body: { disposition: 'completed' },
    });

    expect(closeRes.status).toBe(200);
    expect(closeRes.body).toMatchObject({
      success: true,
      status: 'completed',
      disposition: 'completed',
    });

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
        terminalSource: 'close_api',
      },
    });
  });

  test('explicit close is idempotent for an already terminal conversation session', async () => {
    const admin = await setupProject('close-idempotent');
    mockLlm.register('Hello terminalization twice', {
      content: 'Hello from the idempotent terminalization agent.',
    });

    const chatRes = await requestJson<ChatAgentResponse>(harness, '/api/v1/chat/agent', {
      method: 'POST',
      headers: authHeaders(admin.token),
      body: {
        projectId: admin.projectId,
        message: 'Hello terminalization twice',
      },
    });

    expect(chatRes.status).toBe(200);
    expect(chatRes.body.sessionId).toBeTruthy();

    const firstClose = await requestJson<{
      success: boolean;
      status: string;
      disposition: string;
    }>(harness, `/api/projects/${admin.projectId}/sessions/${chatRes.body.sessionId}/close`, {
      method: 'POST',
      headers: authHeaders(admin.token),
      body: { disposition: 'completed' },
    });

    expect(firstClose.status).toBe(200);
    expect(firstClose.body).toMatchObject({
      success: true,
      status: 'completed',
      disposition: 'completed',
    });

    const secondClose = await requestJson<{
      success: boolean;
      status: string;
      disposition: string;
    }>(harness, `/api/projects/${admin.projectId}/sessions/${chatRes.body.sessionId}/close`, {
      method: 'POST',
      headers: authHeaders(admin.token),
      body: { disposition: 'timeout' },
    });

    expect(secondClose.status).toBe(200);
    expect(secondClose.body).toMatchObject({
      success: true,
      status: 'completed',
      disposition: 'completed',
    });

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
      sessionId: chatRes.body.sessionId,
      payload: {
        disposition: 'completed',
        status: 'completed',
        terminalSource: 'close_api',
      },
    });
  });

  test('bulk close ends matching live conversation sessions and emits one event per session', async () => {
    const admin = await setupProject('bulk');
    mockLlm.register('first close candidate', {
      content: 'First terminalization candidate.',
    });
    mockLlm.register('second close candidate', {
      content: 'Second terminalization candidate.',
    });

    const firstChat = await requestJson<ChatAgentResponse>(harness, '/api/v1/chat/agent', {
      method: 'POST',
      headers: authHeaders(admin.token),
      body: {
        projectId: admin.projectId,
        message: 'first close candidate',
      },
    });
    const secondChat = await requestJson<ChatAgentResponse>(harness, '/api/v1/chat/agent', {
      method: 'POST',
      headers: authHeaders(admin.token),
      body: {
        projectId: admin.projectId,
        message: 'second close candidate',
      },
    });

    expect(firstChat.status).toBe(200);
    expect(secondChat.status).toBe(200);

    const bulkRes = await requestJson<{
      success: boolean;
      closedRuntime: number;
      closedDb: number;
    }>(harness, `/api/projects/${admin.projectId}/sessions/bulk-close`, {
      method: 'POST',
      headers: authHeaders(admin.token),
      body: {
        agentName: 'Simple_Chat',
        disposition: 'timeout',
      },
    });

    expect(bulkRes.status).toBe(200);
    expect(bulkRes.body.success).toBe(true);
    expect(bulkRes.body.closedRuntime).toBeGreaterThanOrEqual(2);
    expect(bulkRes.body.closedDb).toBeGreaterThanOrEqual(2);

    const listRes = await requestJson<SessionListResponse>(
      harness,
      `/api/projects/${admin.projectId}/sessions?limit=20`,
      {
        headers: authHeaders(admin.token),
      },
    );

    expect(listRes.status).toBe(200);

    const sessionStates = new Map(
      listRes.body.sessions.map((session) => [session.id, session] as const),
    );

    expect(sessionStates.get(firstChat.body.sessionId)).toMatchObject({
      status: 'abandoned',
      disposition: 'timeout',
    });
    expect(sessionStates.get(secondChat.body.sessionId)).toMatchObject({
      status: 'abandoned',
      disposition: 'timeout',
    });

    const sessionEndedEvents = capturedEvents.filter(
      (event): event is SessionEndedEvent => event.type === 'session.ended',
    );

    expect(sessionEndedEvents).toHaveLength(2);
    expect(sessionEndedEvents.map((event) => event.sessionId).sort()).toEqual(
      [firstChat.body.sessionId, secondChat.body.sessionId].sort(),
    );
    expect(sessionEndedEvents.every((event) => event.payload.terminalSource === 'bulk_close')).toBe(
      true,
    );
  });
});
